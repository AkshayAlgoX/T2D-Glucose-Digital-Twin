import { z } from 'zod';
import { ForecastResponseSchema, StreamEventSchema } from './zod-schemas';

interface ValidatorFn {
  (data: unknown): boolean;
  errors: any[] | null;
}

export const validateForecastResponse: ValidatorFn = (data: unknown) => {
  try {
    ForecastResponseSchema.parse(data);
    return true;
  } catch (e: any) {
    validateForecastResponse.errors = e.errors;
    return false;
  }
};
validateForecastResponse.errors = null;

export const validateStreamEvent: ValidatorFn = (data: unknown) => {
  try {
    StreamEventSchema.parse(data);
    return true;
  } catch (e: any) {
    validateStreamEvent.errors = e.errors;
    return false;
  }
};
validateStreamEvent.errors = null;

export const validateForecastRequest: ValidatorFn = (data: unknown) => {
  try {
    const { ForecastRequestSchema } = require('./zod-schemas');
    ForecastRequestSchema.parse(data);
    return true;
  } catch (e: any) {
    validateForecastRequest.errors = e.errors;
    return false;
  }
};
validateForecastRequest.errors = null;

export const validateTwinCard: ValidatorFn = (data: unknown) => {
  try {
    const { TwinCardSchema } = require('./zod-schemas');
    TwinCardSchema.parse(data);
    return true;
  } catch (e: any) {
    validateTwinCard.errors = e.errors;
    return false;
  }
};
validateTwinCard.errors = null;
