import fc from 'fast-check';
import { checkInvariants } from '../src/lib/invariants';

describe('Safety Invariants', () => {
  it('P0-7: rejects inverted quantiles', () => {
    fc.assert(
      fc.property(
        fc.tuple(
          fc.integer(), fc.integer(), fc.integer(), fc.integer(), fc.integer(), fc.integer(), fc.integer()
        ),
        (pts) => {
          // If they are not sorted, it should throw.
          const isSorted = pts[0] <= pts[1] && pts[1] <= pts[2] && pts[2] <= pts[3] && pts[3] <= pts[4] && pts[4] <= pts[5] && pts[5] <= pts[6];
          
          const payload: any = {
             forecast: {
                points: [{
                   p05: pts[0], p10: pts[1], p25: pts[2], p50: pts[3], p75: pts[4], p90: pts[5], p95: pts[6]
                }]
             }
          };

          if (!isSorted) {
             expect(() => checkInvariants(payload)).toThrow(/Invariant failed/);
          } else {
             expect(() => checkInvariants(payload)).not.toThrow();
          }
        }
      ),
      { numRuns: 10000 }
    );
  });

  it('P0-12: Risk bounds', () => {
    fc.assert(
      fc.property(
        fc.double({ noNaN: true, noDefaultInfinity: true }),
        (p) => {
           const payload: any = {
              spike_risk: {
                 probability_120m: p,
                 calibrated: true
              }
           };
           if (p < 0 || p > 1) {
              expect(() => checkInvariants(payload)).toThrow(/out of bounds/);
           } else {
              expect(() => checkInvariants(payload)).not.toThrow();
           }
        }
      ),
      { numRuns: 10000 }
    );
  });

  it('P0-12: First forecast point equals current', () => {
     fc.assert(
       fc.property(
          fc.integer(), fc.integer(),
          (curr, p50) => {
             const payload: any = {
                current: { value_mg_dl: curr },
                forecast: { points: [{ offset_min: 0, p50 }] }
             };
             if (curr !== p50) {
                expect(() => checkInvariants(payload)).toThrow(/First forecast point/);
             } else {
                expect(() => checkInvariants(payload)).not.toThrow();
             }
          }
       ),
       { numRuns: 10000 }
     );
  });
});
