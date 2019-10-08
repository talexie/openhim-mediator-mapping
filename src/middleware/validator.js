'use strict'

const fs = require('fs')
const path = require('path')
const Joi = require('@hapi/joi')

const logger = require('../logger')

const createValidationSchema = validationMap => {
  const validations = validationMap
  const schemaObject = {}

  if (validations) {
    Object.keys(validations).forEach(key => {
      let rule = validations[`${key}`]
      switch (rule.type) {
        case 'string':
          if (rule.required) {
            schemaObject[`${key}`] = Joi.string().required()
          } else if (rule.default) {
            schemaObject[`${key}`] = Joi.string().default(rule.default)
          } else {
            schemaObject[`${key}`] = Joi.string()
          }
          break

        case 'number':
          if (rule.required) {
            schemaObject[`${key}`] = Joi.number().required()
          } else if (rule.default) {
            schemaObject[`${key}`] = Joi.number().default(rule.default)
          } else {
            schemaObject[`${key}`] = Joi.number()
          }
          break

        case 'boolean':
          if (rule.required) {
            schemaObject[`${key}`] = Joi.boolean().required()
          } else if (rule.default) {
            schemaObject[`${key}`] = Joi.boolean().default(rule.default)
          } else {
            schemaObject[`${key}`] = Joi.boolean()
          }
          break

        case 'array':
          if (rule.required) {
            schemaObject[`${key}`] = Joi.array().required()
          } else if (rule.default) {
            schemaObject[`${key}`] = Joi.array().default(rule.default)
          } else {
            schemaObject[`${key}`] = Joi.array()
          }
          break

        case 'object':
          if (rule.required) {
            schemaObject[`${key}`] = Joi.object().required()
          } else if (rule.default) {
            schemaObject[`${key}`] = Joi.object().default(rule.default)
          } else {
            schemaObject[`${key}`] = Joi.object()
          }
          break

        default:
          logger.warn(`No matching validation for rule type: ${rule.type}`)
          break
      }
    })

    if (schemaObject) {
      return Joi.object(schemaObject)
    }

    ctx.error = 'Joi validation schema creation failed'
    return null
  }
  logger.warn('No validation schema in file')
  return null
}

const performValidation = (ctx, schema) => {
  const {error, value} = schema.validate(ctx.request.body)

  if (error) {
    ctx.status = 400
    ctx.body = error
  } else {
    logger.debug('Successfully validated user input')
    ctx.input = value
  }
}

exports.validateInput = validationMap => async (ctx, next) => {
  if (validationMap) {
    const schema = createValidationSchema(validationMap)

    performValidation(ctx, schema)
    if (!ctx.input) {
      logger.error(`Validation Failed: ${ctx.body.message}`)
      return new Error(`Validation Failed: ${ctx.body}`)
    }
  } else {
    logger.error('No input resource name provided')
    ctx.error = 'Input resource name not given'
  }
  await next()
}

if (process.env.NODE_ENV == 'test') {
  exports.createValidationSchema = createValidationSchema
  exports.performValidation = performValidation
}
