import React from 'react';
import { formatPct } from '@/lib/formatters/date';
import { ForecastResponse } from '@/types/forecast-response';
import { AlertView } from '@/lib/types';

export function RiskPanel({ forecast }: { forecast: ForecastResponse | null }) {
  if (!forecast) return null;

  const risk = forecast.spike_risk;
  // P0-6: If no valid calibrated risk, it should be null/empty, not 0% (unless explicitly a confident 0%).
  // Our invariants strip out uncalibrated fake 0s.
  const prob = risk && risk.probability_120m != null ? risk.probability_120m : null;
  const hasRisk = prob != null;
  
  const alert = forecast.alert;
  const isAlert = alert?.state === 'warning' || alert?.state === 'watch';

  let alertLabel = 'Clinical Alert';
  if (alert?.state === 'warning') alertLabel = 'Spike Warning';
  if (alert?.state === 'watch') alertLabel = 'Risk Watch';
  if ((alert?.state as string) === 'suppressed') alertLabel = 'Suppressed';

  const drivers = forecast.drivers || [];
  const currentVal = forecast.current?.value_mg_dl || 0;
  const peak = risk?.peak_mg_dl?.p50;
  
  let sum = currentVal;
  const processedDrivers = drivers.map((d) => {
     sum += d.impact_mg_dl;
     return { ...d };
  });
  
  const unaccounted = peak != null ? peak - sum : 0;
  const showResidual = Math.abs(unaccounted) >= 0.5;

  return (
    <div className="flex flex-col text-[13px] leading-[20px]">
      <section className="p-5 border-b border-line bg-surface">
        <h2 className="text-[12px] font-semibold text-ink-2 mb-4 uppercase tracking-wide">Spike risk &middot; next 2 h</h2>
        
        {isAlert && (
          <div className={`mb-5 border px-3 py-2 rounded-sm flex items-start gap-2 ${alert?.state === 'warning' ? 'border-danger/40 bg-danger/5 text-danger' : 'border-amber/40 bg-amber/5 text-amber'}`}>
            <svg className="w-4 h-4 mt-0.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
            <div className="font-medium text-[13px]">{alertLabel}</div>
          </div>
        )}

        <div className="mb-2">
          <div className="text-[28px] leading-none font-medium tabular-nums text-ink">
            {hasRisk ? formatPct(prob, 0) : '—'}
          </div>
          <div className="text-ink-2 mt-1.5 text-[12px] leading-snug">
             Probability of a spike onset within 120 min{risk?.calibrated ? ', calibrated' : ''}
          </div>
        </div>
        
        <div className="mt-5 relative w-full pt-1 pb-1">
           <div className="h-1.5 bg-surface-2 rounded-sm w-full overflow-hidden absolute top-1.5 left-0">
             {hasRisk && (
               <div className="absolute top-0 left-0 h-full bg-amber" style={{ width: formatPct(prob, 0) }} />
             )}
           </div>
           <div className="absolute top-0 bottom-0 w-px bg-ink-2" style={{ left: '35%' }} title="35% policy threshold" />
           <div className="absolute top-4 left-[35%] -translate-x-1/2 text-[10px] text-ink-3">35%</div>
        </div>
      </section>

      <section className="p-5 border-b border-line bg-surface">
        <h2 className="text-[12px] font-semibold text-ink-2 mb-1 uppercase tracking-wide">How this forecast is built</h2>
        <div className="text-[11px] text-ink-3 mb-4 leading-snug">Arithmetic of the model's own forecast &mdash; not a causal attribution</div>
        
        <table className="w-full text-left border-collapse tabular-nums text-[13px]">
          <tbody>
            <tr className="border-b border-line/50">
               <td className="py-2.5 text-ink-2">Current glucose</td>
               <td className="py-2.5 text-right font-medium text-ink">{Math.round(currentVal)}</td>
            </tr>
            {processedDrivers.map((d, idx) => (
              <tr key={idx} className="border-b border-line/50 last:border-0 group cursor-default">
                <td className="py-2.5 text-ink flex items-center gap-2">
                  <span className={`w-1.5 h-1.5 rounded-full ${d.source === 'physics' || d.source === 'both' ? 'bg-physics' : 'bg-forecast'}`} />
                  {d.label_key || d.feature_key}
                </td>
                <td className="py-2.5 text-right font-medium text-ink">
                  {d.impact_mg_dl > 0 ? '+' : ''}{Math.round(d.impact_mg_dl)}
                </td>
              </tr>
            ))}
            {showResidual && (
              <tr className="border-b border-line/50 last:border-0">
                 <td className="py-2.5 text-ink-3 italic pl-3.5">Residual</td>
                 <td className="py-2.5 text-right font-medium text-ink-3">
                   {unaccounted > 0 ? '+' : ''}{Math.round(unaccounted)}
                 </td>
              </tr>
            )}
            <tr className="border-t-2 border-line font-bold">
               <td className="py-2.5 text-ink">Median at peak</td>
               <td className="py-2.5 text-right text-ink">{peak != null ? Math.round(peak) : '—'}</td>
            </tr>
          </tbody>
        </table>
      </section>
    </div>
  );
}
