import React, { useState } from 'react';

import { ForecastResponse } from "@/types/forecast-response";

export function ScenarioEditor({ patientId, currentForecast }: { patientId: string; currentForecast: ForecastResponse | null }) {
  const [kind, setKind] = useState<'meal' | 'activity'>('meal');
  const [amount, setAmount] = useState<number>(30);

  const scenario = currentForecast?.scenarios?.[0];
  const disabled = true; // Scenario service not connected

  return (
    <section className="p-4 bg-surface flex flex-col flex-1 border-t border-line">
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-[13px] font-semibold text-ink-2">Simulation</h2>
      </div>

      <div className="text-[11px] text-ink-3 mb-4 leading-snug">
        Projection under model assumptions &mdash; direction checked, size not validated
      </div>
      
      <div className="space-y-4 mb-6">
         <div className="flex flex-col gap-1.5">
           <label htmlFor="scenario-kind" className="text-[11px] text-ink-2 font-medium">Intervention</label>
           <select 
             id="scenario-kind"
             className="border border-line rounded-sm px-2 py-1.5 bg-surface-2 text-ink text-[12px] w-full focus:outline-none focus:border-ink-2 focus:ring-0 opacity-75"
             value={kind}
             onChange={(e) => setKind(e.target.value as 'meal' | 'activity')}
             disabled={disabled}
           >
             <option value="meal">Carbohydrate Ingestion (Meal)</option>
             <option value="activity" disabled>Moderate Activity (Not modelled)</option>
             <option value="medication" disabled>Medication (Not modelled)</option>
           </select>
         </div>

         <div className="flex flex-col gap-1.5">
           <label htmlFor="scenario-amount" className="text-[11px] text-ink-2 font-medium">
             {kind === 'meal' ? 'Magnitude (g)' : 'Duration (min)'}
           </label>
           <input 
             id="scenario-amount"
             type="number" 
             className="border border-line rounded-sm px-2 py-1.5 bg-surface-2 text-ink text-[12px] w-full tabular-nums focus:outline-none focus:border-ink-2 focus:ring-0 opacity-75"
             value={amount}
             min="0"
             onChange={(e) => setAmount(Number(e.target.value))}
             disabled={disabled}
           />
         </div>
      </div>

      <div className="mt-auto flex flex-col gap-3">
         {scenario && (
            <div className="border border-line p-3 bg-white rounded-sm shadow-sm">
              <div className="text-[12px] font-semibold text-ink-3 mb-2">Simulation Result</div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <div className="text-[11px] text-ink-2 mb-0.5">Peak shift</div>
                  <div className="text-[13px] font-medium tabular-nums text-ink">
                     {scenario.delta_peak_mg_dl > 0 ? '+' : ''}{scenario.delta_peak_mg_dl} mg/dL
                  </div>
                </div>
                <div>
                  <div className="text-[11px] text-ink-2 mb-0.5">Risk shift</div>
                  <div className="text-[13px] font-medium tabular-nums text-ink">
                     {scenario.delta_probability > 0 ? '+' : ''}{(scenario.delta_probability * 100).toFixed(0)}% pt
                  </div>
                </div>
              </div>
            </div>
         )}
      
         <button 
           className="w-full bg-surface-2 text-ink-3 border border-line py-2 text-[12px] font-semibold rounded-sm cursor-not-allowed"
           disabled={disabled}
           title="Scenario service not connected"
         >
           Scenario service not connected
         </button>
      </div>
    </section>
  );
}
