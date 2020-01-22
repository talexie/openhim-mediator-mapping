'use strict'

const fetch = require('node-fetch')
const axios = require('axios')
const fs = require('fs')
const path = require('path')
const logger = require('../logger')

const mediatorConfigFile = fs.readFileSync(
  path.resolve(__dirname, '..', '..', 'mediatorConfig.json')
)
const mediatorConfigJson = JSON.parse(mediatorConfigFile)

function checkStatus(res) {
  if (res.ok) {
    return res
  } else {
    throw new Error('Non-2xx Response status')
  }
}

exports.requestsMiddleware = () => async (ctx, next) => {
  const requests = ctx.state.metaData.requests
  if (requests && requests.lookup && requests.lookup.length) {
    ctx.externalRequest = {}
    const responseData = requests.lookup.map(requestDetails => {
      return fetch(requestDetails.url)
        .then(checkStatus)
        .then(async res => {
          // Assign any data received from the response to the assigned id in the context
          ctx.externalRequest[requestDetails.id] = await res.text()
        })
        .catch(err => {
          logger.error(err)
        })
    })

    await Promise.all(responseData)
      .then(() => {
        logger.debug(
          `All requests resolved: ${JSON.stringify(ctx.externalRequest)}`
        )
      })
      .catch(err => {
        logger.error(err)
      })
  }
  await next()
}

// For now only json data is processed
const orchestrateMappingResult = async (ctx, requests) => {
  // Send request downstream only when mapping has been successful
  if (ctx && ctx.status === 200) {
    if (
      requests &&
      Array.isArray(requests.response) &&
      requests.response.length
    ) {
      //Create orchestrations
      ctx.orchestrations = []

      const promises = requests.response.map(request => {
        if (request && request.url && request.method && request.id) {
          const body = ctx.body
          const axiosConfig = {
            url: request.url,
            method: request.method,
            body: body
          }

          if (
            request.credentials &&
            request.credentials.username &&
            request.credentials.password
          ) {
            axiosConfig.auth = {
              username: request.credentials.username,
              password: request.credentials.password
            }
          }

          if (request.headers) {
            axiosConfig.headers = request.headers
          }

          ctx.body = {}
          const reqTimestamp = new Date()
          let response, error, responseTimestamp

          return axios(axiosConfig)
            .then(resp => {
              response = resp
              responseTimestamp = new Date()

              if (request.primary) {
                ctx.hasPrimaryRequest = true
                ctx.body = {}
                ctx.body[request.id] = response.body
              } else {
                if (!ctx.hasPrimaryRequest) {
                  ctx.body[request.id] = response.body
                }
              }
            })
            .catch(err => {
              responseTimestamp = new Date()

              if (err.response) {
                response = err.response
                response.body = response.data

                if (response.status >= 500) {
                  if (request.primary) {
                    ctx.hasPrimaryRequest = true
                    ctx.body = {}
                    ctx.body[request.id] = response.data
                    ctx.primaryReqFailError = true
                  } else {
                    ctx.secondaryFailError = true
                    if (!ctx.hasPrimaryRequest) {
                      ctx.body[request.id] = response.data
                    }
                  }
                } else {
                  if (request.primary) {
                    ctx.hasPrimaryRequest = true
                    ctx.body = {}
                    ctx.body[request.id] = response.data
                    ctx.primaryCompleted = true
                  } else {
                    ctx.secondaryCompleted = true
                    if (!ctx.hasPrimaryRequest) {
                      ctx.body[request.id] = response.data
                    }
                  }
                }
              } else {
                if (request.primary) {
                  ctx.hasPrimaryRequest = true
                  ctx.body = {}
                  ctx.body[request.id] = err.message
                  ctx.primaryReqFailError = true
                } else {
                  ctx.secondaryFailError = true
                  if (!ctx.hasPrimaryRequest) {
                    ctx.body[request.id] = err.message
                  }
                }
                error = {message: err.message}
              }
            })
            .finally(() => {
              if (
                ctx.request.header &&
                ctx.request.header['X-OpenHIM-TransactionID']
              ) {
                const orch = createOrchestration(
                  request,
                  body,
                  response,
                  reqTimestamp,
                  responseTimestamp,
                  error
                )

                ctx.orchestrations.push(orch)
              }
            })
        }
      })

      await Promise.all(promises)
        .then(() => {
          logger.info('Mapped object successfully orchestrated')
          setTheStatusCodeAndText(ctx)
        })
        .catch(err => {
          logger.error(`Mapped object orchestration failure: ${err.message}`)
        })

      // Respond in openhim mediator format if request came from the openhim
      if (ctx.request.header && ctx.request.header['X-OpenHIM-TransactionID']) {
        ctx.set('Content-Type', 'application/json+openhim')

        constructOpenhimResponse(
          ctx,
          ctx.response,
          ctx.orchestrations,
          ctx.statusText,
          Date.now()
        )
      }
    }
  }
}

const createOrchestration = (
  request,
  reqBody,
  responseObject,
  reqTimestamp,
  responseTimestamp,
  error
) => {
  if (!request || !request.url || !request.method)
    throw new Error('Orchestration creation failed: url/method not supplied')

  /*
    Request timestamp is a required property for an orchestration
  */
  if (!reqTimestamp)
    throw new Error('Orchestration request timestamp not supplied')

  /*
    The request id is used as the orchestration's name. Name is a required property
  */
  if (!request.id) throw new Error('Orchestration name not supplied')

  const urlObject = new URL(request.url)

  const requestObject = {
    host: urlObject.hostname,
    port: urlObject.port,
    path: urlObject.pathname,
    method: request.method,
    timestamp: reqTimestamp
  }

  const response = {
    timestamp: responseTimestamp
  }

  if (urlObject.searchParams) {
    requestObject.queryString = urlObject.searchParams.toString()
  }
  if (request.headers) {
    requestObject.headers = request.headers
  }
  if (reqBody) {
    requestObject.body = reqBody
  }
  if (responseObject && responseObject.status) {
    response.status = responseObject.status
  }
  if (responseObject && responseObject.body) {
    response.body = responseObject.body
  }
  if (responseObject && responseObject.headers) {
    response.headers = responseObject.headers
  }

  const orchestration = {
    request: requestObject,
    response,
    name: request.id
  }

  if (error) {
    orchestration.error = error
  }

  return orchestration
}

const constructOpenhimResponse = (
  ctx,
  response,
  orchestrations,
  statusText,
  responseTimestamp
) => {
  const respObject = {}

  if (response) {
    if (response.headers) {
      respObject.headers = response.headers
    }
    if (response.status) {
      respObject.status = response.status
    }
    if (response.body) {
      respObject.body = response.body
    }
    if (response.timestamp) {
      respObject.timestamp = response.timestamp
    } else if (responseTimestamp) {
      respObject.timestamp = responseTimestamp
    }
  }

  ctx.body = `{
    "x-mediator-urn": "${mediatorConfigJson.urn}",
    "status": "${statusText}",
    "response": ${JSON.stringify(respObject)},
    "orchestrations": ${JSON.stringify(orchestrations)}
  }`
}

const setTheStatusCodeAndText = ctx => {
  if (ctx.primaryReqFailError) {
    ctx.statusText = 'Failed'
    ctx.status = 500
  } else if (!ctx.primaryReqFailError && ctx.secondaryFailError) {
    ctx.statusText = 'Completed with error(s)'
    ctx.status = 200
  } else if (
    !ctx.primaryReqFailError &&
    !ctx.secondaryFailError &&
    (ctx.primaryCompleted || ctx.secondaryCompleted)
  ) {
    ctx.statusText = 'Completed'
    ctx.status = 200
  } else {
    ctx.statusText = 'Successful'
    ctx.status = 200
  }
}

if (process.env.NODE_ENV === 'test') {
  exports.createOrchestration = createOrchestration
  exports.orchestrateMappingResult = orchestrateMappingResult
  exports.setTheStatusCodeAndText = setTheStatusCodeAndText
  exports.constructOpenhimResponse = constructOpenhimResponse
}
