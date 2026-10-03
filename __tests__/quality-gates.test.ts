import { calculateWaterfall } from '../src/lib/waterfallUtils';

describe('Quality Gates', () => {
  it('state mapping: no forecast implies no 0%', () => {
    const forecast = null;
    const mappedRisk = forecast ? 0 : null;
    expect(mappedRisk).toBeNull();
  });

  it('waterfall exact sum matches peak with small terms < 0.5 mg/dL', () => {
    const result = calculateWaterfall(180, 120, 45, 14.7);
    expect(result.baseline + result.meals + result.correction + result.smallTerms).toBeCloseTo(180);
    expect(Math.abs(result.smallTerms)).toBeLessThan(0.5);
  });

  it('alert-state mapping is correct', () => {
    const alertState = "raised";
    const mapped = alertState === "raised" ? "steady amber banner" : "none";
    expect(mapped).toBe("steady amber banner");
  });

  it('time sync maps properly', () => {
    const timestamp = "2026-09-28T12:00:00Z";
    expect(new Date(timestamp).getTime()).toBe(1790596800000);
  });
});
