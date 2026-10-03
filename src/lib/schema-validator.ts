import Ajv from 'ajv/dist/2020';
import forecastResponseSchema from '@/contracts/v1/forecast-response.json';
import forecastRequestSchema from '@/contracts/v1/forecast-request.json';
import streamEventSchema from '@/contracts/v1/stream-event.json';
import twinCardSchema from '@/contracts/v1/twin-card.json';

const ajv = new Ajv({ allErrors: true, strict: false });

export const validateForecastResponse = ajv.compile(forecastResponseSchema);
export const validateForecastRequest = ajv.compile(forecastRequestSchema);
export const validateStreamEvent = ajv.compile(streamEventSchema);
export const validateTwinCard = ajv.compile(twinCardSchema);
