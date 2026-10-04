import { ForecastResponseSchema, StreamEventSchema } from './zod-schemas';

export const validateForecastResponse = (data: any) => {
  try {
    ForecastResponseSchema.parse(data);
    return true;
  } catch (e: any) {
    validateForecastResponse.errors = e.errors;
    return false;
  }
};
validateForecastResponse.errors = null as any;

export const validateStreamEvent = (data: any) => {
  try {
    StreamEventSchema.parse(data);
    return true;
  } catch (e: any) {
    validateStreamEvent.errors = e.errors;
    return false;
  }
};
validateStreamEvent.errors = null as any;

export const validateForecastRequest = (data: any) => {
  try {
    const { ForecastRequestSchema } = require('./zod-schemas');
    ForecastRequestSchema.parse(data);
    return true;
  } catch (e: any) {
    validateForecastRequest.errors = e.errors;
    return false;
  }
};
validateForecastRequest.errors = null as any;

export const validateTwinCard = (data: any) => {
  try {
    const { TwinCardSchema } = require('./zod-schemas');
    TwinCardSchema.parse(data);
    return true;
  } catch (e: any) {
    validateTwinCard.errors = e.errors;
    return false;
  }
};
validateTwinCard.errors = null as any;
