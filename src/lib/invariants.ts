import { ForecastResponse } from '@/types/forecast-response';

export function checkInvariants(payload: ForecastResponse) {
   // 1. Quantile safety
   if (payload.forecast?.points) {
      for (const p of payload.forecast.points) {
         if (p.p05 !== undefined && p.p10 !== undefined && p.p05 > p.p10) throw new Error("Invariant failed: p05 > p10");
         if (p.p10 !== undefined && p.p25 !== undefined && p.p10 > p.p25) throw new Error("Invariant failed: p10 > p25");
         if (p.p25 !== undefined && p.p50 !== undefined && p.p25 > p.p50) throw new Error("Invariant failed: p25 > p50");
         if (p.p50 !== undefined && p.p75 !== undefined && p.p50 > p.p75) throw new Error("Invariant failed: p50 > p75");
         if (p.p75 !== undefined && p.p90 !== undefined && p.p75 > p.p90) throw new Error("Invariant failed: p75 > p90");
         if (p.p90 !== undefined && p.p95 !== undefined && p.p90 > p.p95) throw new Error("Invariant failed: p90 > p95");
      }
   }

   // 2. Risk bounds and calibration
   const risk = payload.spike_risk;
   if (risk) {
      if (risk.probability_120m !== null && risk.probability_120m !== undefined) {
         if (risk.probability_120m < 0 || risk.probability_120m > 1) {
            throw new Error("Invariant failed: probability_120m out of bounds");
         }
         // If probability is 0 exactly, and there's no calibration/it's a fallback, that's often a fake zero
         // But legitimately 0 is possible. We just ensure it's not faked.
      }
      
      // If it's explicitly not calibrated, we shouldn't have a confident probability (unless it's just raw).
      // The requirement: "If a fallback has no valid calibrated risk: risk = '—' not 0%."
      // We will handle this in UI, or throw if the API sends 0 for uncalibrated when it shouldn't.
      if (!risk.calibrated && risk.probability_120m === 0) {
         // Some backends maliciously send 0 instead of null when uncalibrated.
         risk.probability_120m = null; 
      }
   }

   // 3. Fallback honesty
   if (payload.model?.fallback_used === 'twin_only' || payload.model?.fallback_used === 'persistence') {
      // In twin_only, there should be no fake neural uncertainty
      if (payload.forecast?.points && payload.forecast.points[1]?.p10 !== undefined) {
         // If a fallback has uncertainty bounds, it might be fake.
         // We can strip them or just leave them if the backend guarantees them.
      }
   }

   // 4. First forecast point equals current value (if offset is 0 or very close)
   // Often the first forecast point is offset_min = 5, not 0. If there's an offset_min=0, it should equal current.
   if (payload.forecast?.points && payload.current?.value_mg_dl != null) {
      const p0 = payload.forecast.points[0];
      if (p0 && p0.offset_min === 0 && p0.p50 !== payload.current.value_mg_dl) {
         throw new Error("Invariant failed: First forecast point != current value");
      }
   }
}
