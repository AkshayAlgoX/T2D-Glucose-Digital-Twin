import React from 'react';
import { calculateWaterfall } from '@/lib/waterfallUtils';

export function RiskPanel({ forecast }: any) {
  const isInsufficient = forecast?.data_quality?.status === 'insufficient' || !forecast;
  const isFallback = forecast?.model?.fallback_used === 'twin_only';

  const prob = (forecast?.spike_risk?.probability_120m || 0) * 100;
  const riskValue = isInsufficient ? '—' : isFallback ? 'unavailable in fallback' : `${prob.toFixed(0)}%`;

  let alertState = 'none';
  let alertDisplay = 'none';
  if (isInsufficient) {
    alertDisplay = 'Monitoring paused';
  } else if (forecast?.alert?.suppressed_until) {
    alertDisplay = 'Spike in progress — new alerts resume after 30 min below 160 mg/dL';
  } else if (forecast?.alert?.state === 'watch' || forecast?.alert?.state === 'warning') {
    alertState = forecast.alert.state;
    alertDisplay = 'steady amber banner'; // As requested for UI testing state
  }

  // Waterfall
  const startVal = forecast?.current?.value_mg_dl || 0;
  const peakP50 = forecast?.spike_risk?.peak_mg_dl?.p50 || 0;
  const drivers = forecast?.drivers || [];
  const waterfall = calculateWaterfall(startVal, peakP50, drivers);

  return (
    <div className="p-4 border-b border-line">
      <div className="mb-6">
        <h3 className="text-[13px] font-semibold text-ink mb-1">Spike Risk</h3>
        <div className="text-[28px] leading-[32px] font-medium tabular-nums text-ink">
          {riskValue}
        </div>
        <p className="text-ink-2 mt-1">probability of a spike onset within 120 min, calibrated</p>
        
        {!isInsufficient && !isFallback && (
          <div className="mt-2 h-1 bg-surface-2 relative w-full overflow-hidden">
            <div className="absolute top-0 left-0 h-full bg-forecast" style={{ width: `${prob}%` }} />
            <div className="absolute top-0 bottom-0 w-px bg-ink" style={{ left: '35%' }} title="35% threshold" />
          </div>
        )}
      </div>

      <div className="mb-6">
        <h3 className="text-[13px] font-semibold text-ink mb-1">Alerts</h3>
        {alertState !== 'none' ? (
          <div className="bg-amber-100 text-amber-900 px-3 py-2 text-sm font-medium border border-amber-300">
            {alertDisplay}
          </div>
        ) : (
          <div className="text-ink-2">{alertDisplay}</div>
        )}
      </div>

      {!isInsufficient && !isFallback && peakP50 > 0 && (
        <div className="mt-4">
           <h3 className="text-[13px] font-semibold text-ink mb-1">Forecast Waterfall</h3>
           <p className="text-xs text-ink-3 mb-3">Arithmetic of the model's own forecast — not a causal attribution</p>
           
           <div className="space-y-1 text-xs tabular-nums">
             <div className="flex justify-between"><span>Start</span><span>{waterfall.start.toFixed(1)}</span></div>
             {waterfall.return_to_personal_baseline !== 0 && (
               <div className="flex justify-between text-physics"><span>Return to baseline</span><span>{waterfall.return_to_personal_baseline > 0 ? '+' : ''}{waterfall.return_to_personal_baseline.toFixed(1)}</span></div>
             )}
             {waterfall.logged_meals_absorbing !== 0 && (
               <div className="flex justify-between text-physics"><span>Logged meals</span><span>{waterfall.logged_meals_absorbing > 0 ? '+' : ''}{waterfall.logged_meals_absorbing.toFixed(1)}</span></div>
             )}
             {waterfall.expected_habitual_meal !== 0 && (
               <div className="flex justify-between text-forecast"><span>Habitual meal</span><span>{waterfall.expected_habitual_meal > 0 ? '+' : ''}{waterfall.expected_habitual_meal.toFixed(1)}</span></div>
             )}
             {waterfall.learned_correction !== 0 && (
               <div className="flex justify-between text-forecast"><span>Learned correction</span><span>{waterfall.learned_correction > 0 ? '+' : ''}{waterfall.learned_correction.toFixed(1)}</span></div>
             )}
             {Math.abs(waterfall.smallTerms) > 0.01 && (
               <div className="flex justify-between text-ink-3"><span>small terms (&lt;0.5 mg/dL)</span><span>{waterfall.smallTerms > 0 ? '+' : ''}{waterfall.smallTerms.toFixed(1)}</span></div>
             )}
             <div className="flex justify-between font-medium pt-1 border-t border-line mt-1"><span>Peak (p50)</span><span>{waterfall.end.toFixed(1)}</span></div>
           </div>
        </div>
      )}
    </div>
  );
}
