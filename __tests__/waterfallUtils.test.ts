import { calculateWaterfall } from '../src/lib/waterfallUtils';
import fixture from './fixtures/backend-fixture.json';

describe('waterfallUtils', () => {
  it('waterfall exact sum matches peak with small terms < 0.5 mg/dL', () => {
    // We construct a mock forecast based on the formula
    const currentVal = 125.0;
    const peakP50 = 158.0; // Suppose the peak is 158.0
    const drivers = [
      { feature_key: 'return_to_personal_baseline', impact_mg_dl: 20.0 },
      { feature_key: 'logged_meals_absorbing', impact_mg_dl: 15.0 },
      { feature_key: 'expected_habitual_meal', impact_mg_dl: -5.0 },
      { feature_key: 'learned_correction', impact_mg_dl: 2.8 }
    ];
    
    const result = calculateWaterfall(currentVal, peakP50, drivers);
    
    // sum: 125 + 20 + 15 - 5 + 2.8 = 157.8
    // smallTerms = 158.0 - 157.8 = 0.2
    
    expect(result.start + result.return_to_personal_baseline + result.logged_meals_absorbing + 
           result.expected_habitual_meal + result.learned_correction + result.smallTerms).toBeCloseTo(158.0);
           
    expect(Math.abs(result.smallTerms)).toBeLessThan(0.5);
  });
  
  it('works with actual fixture', () => {
    const payload = fixture.payload;
    const currentVal = payload.current.value_mg_dl;
    const peakP50 = 157.5; // Dummy peak since fixture doesn't explicitly have peak_mg_dl.p50
    const drivers = payload.drivers;
    
    const result = calculateWaterfall(currentVal, peakP50, drivers);
    // 125 + 32.5 = 157.5, small terms = 0
    expect(Math.abs(result.smallTerms)).toBeLessThan(0.5);
  });
});
