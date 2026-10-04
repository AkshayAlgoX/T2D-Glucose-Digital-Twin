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
