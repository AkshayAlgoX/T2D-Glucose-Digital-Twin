import { CurrentGlucoseSchema } from '../src/lib/zod-schemas';

describe('Zod Strict Nullable vs Optional Enforcement', () => {
  it('PROVES RUNTIME SAFETY: rejects payloads where a required nullable field is completely missing', () => {
    // The TypeScript compiler (with strict: false) infers value_mg_dl as optional (?:),
    // but this test proves Zod physically rejects it at runtime if the key is missing.
    // This mismatch between Zod's runtime safety and TS's degraded compile-time inference 
    // is the exact reason the `as any as ForecastResponse` cast is necessary and safe.
    expect(() => CurrentGlucoseSchema.parse({
      flag: 'in_range',
      measured_at: '2026-10-04T12:00:00Z',
      trend_arrow: 'flat'
      // value_mg_dl is missing!
    })).toThrow("expected number, received undefined");
  });

  it('accepts explicit null for required nullable fields', () => {
    expect(() => CurrentGlucoseSchema.parse({
      value_mg_dl: null,
      flag: 'in_range',
      measured_at: '2026-10-04T12:00:00Z',
      trend_arrow: 'flat'
    })).not.toThrow();
  });
});
