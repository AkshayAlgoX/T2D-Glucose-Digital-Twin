import { z } from 'zod';
import { ForecastResponseSchema, StreamEventSchema } from './zod-schemas';

interface ValidatorFn {
  (data: unknown): boolean;
  errors: z.ZodIssue[] | null;
}

function extractErrors(e: unknown): z.ZodIssue[] | null {
  if (e && typeof e === 'object' && 'errors' in e && Array.isArray((e as Record<string, unknown>).errors)) {
    return (e as Record<string, unknown>).errors as z.ZodIssue[];
  }
  return null;
}

export const validateForecastResponse: ValidatorFn = (data: unknown) => {
  try {
    ForecastResponseSchema.parse(data);
    return true;
  } catch (e: unknown) {
    validateForecastResponse.errors = extractErrors(e);
    return false;
  }
};
validateForecastResponse.errors = null;

export const validateStreamEvent: ValidatorFn = (data: unknown) => {
  try {
    StreamEventSchema.parse(data);
    return true;
  } catch (e: unknown) {
    validateStreamEvent.errors = extractErrors(e);
    return false;
  }
};
validateStreamEvent.errors = null;

export const validateForecastRequest: ValidatorFn = (data: unknown) => {
  try {
    const { ForecastRequestSchema } = require('./zod-schemas');
    ForecastRequestSchema.parse(data);
    return true;
  } catch (e: unknown) {
    validateForecastRequest.errors = extractErrors(e);
    return false;
  }
};
validateForecastRequest.errors = null;

export const validateTwinCard: ValidatorFn = (data: unknown) => {
  try {
    const { TwinCardSchema } = require('./zod-schemas');
    TwinCardSchema.parse(data);
    return true;
  } catch (e: unknown) {
    validateTwinCard.errors = extractErrors(e);
    return false;
  }
};
validateTwinCard.errors = null;
