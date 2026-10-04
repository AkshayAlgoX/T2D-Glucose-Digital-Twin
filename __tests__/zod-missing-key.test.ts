import { CurrentGlucoseSchema } from '../src/lib/zod-schemas';

describe('Zod missing key', () => {
  it('rejects when value_mg_dl is missing entirely', () => {
    expect(() => CurrentGlucoseSchema.parse({
      flag: 'in_range',
      measured_at: '2026-10-04T12:00:00Z',
      trend_arrow: 'flat'
    })).toThrow();
  });
});
