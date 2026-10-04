import React, { useState } from 'react';

export function ScenarioEditor({ patientId, currentForecast, pinnedAsOf }: any) {
  const [kind, setKind] = useState<'meal' | 'activity'>('meal');
  const [amount, setAmount] = useState<number>(30); // carbs or duration
  const [offset, setOffset] = useState<number>(0);
  const [result, setResult] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const runSimulation = async () => {
    setLoading(true);
    setError(null);
    try {
      const input = kind === 'meal' 
        ? { kind: 'meal', carbs_g: amount, offset_min: offset }
        : { kind: 'activity', duration_min: amount, intensity: 'moderate', offset_min: offset };

      const res = await fetch('/api/forecast', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          patientId,
          pinned_as_of: pinnedAsOf,
          scenarios: [{
             scenario_id: 'scen-1',
             inputs: [input]
          }]
        })
      });
      if (res.ok) {
        setResult(await res.json());
      } else {
        setError(`Failed: ${res.statusText}`);
      }
    } catch (e: any) {
      setError(e.message);
    }
    setLoading(false);
  };

  const reset = () => {
    setResult(null);
    setError(null);
  };

  return (
    <div className="p-4 border-b border-line">
      <h3 className="text-[13px] font-semibold text-ink mb-2">What-If Projections</h3>
      <div className="text-xs text-ink-2 mb-4 bg-surface-2 p-2 rounded">
        <strong>Simulation Only:</strong> This is an isolated mathematical projection under model assumptions, not observed clinical data.
      </div>
      
      <div className="space-y-3 mb-4">
         <div className="flex flex-col gap-1">
           <label htmlFor="scenario-kind" className="text-xs text-ink-2 font-medium">Intervention Type</label>
           <select 
             id="scenario-kind"
             className="border border-line rounded px-2 py-1.5 bg-surface text-ink text-xs w-full"
             value={kind}
             onChange={(e) => setKind(e.target.value as 'meal' | 'activity')}
           >
             <option value="meal">Meal (Carbohydrates)</option>
             <option value="activity">Activity (Moderate)</option>
           </select>
         </div>

         <div className="flex flex-col gap-1">
           <label htmlFor="scenario-amount" className="text-xs text-ink-2 font-medium">
             {kind === 'meal' ? 'Carbs (g)' : 'Duration (min)'}
           </label>
           <input 
             id="scenario-amount"
             type="number" 
             className="border border-line rounded px-2 py-1.5 bg-surface text-ink text-xs w-full tabular-nums"
             value={amount}
             min="0"
             onChange={(e) => setAmount(Number(e.target.value))}
           />
         </div>

         <div className="flex gap-2 pt-2">
           <button 
             onClick={runSimulation} 
             disabled={loading || !pinnedAsOf} 
             className="flex-1 px-3 py-1.5 bg-ink text-surface rounded font-medium text-xs disabled:opacity-50 transition-opacity"
           >
             {loading ? 'Simulating...' : 'Run Scenario'}
           </button>
           {result && (
             <button 
               onClick={reset} 
               className="px-3 py-1.5 bg-surface-2 text-ink rounded font-medium text-xs hover:bg-line-control transition-colors"
             >
               Clear
             </button>
           )}
         </div>
      </div>

      {error && (
        <div className="text-xs text-danger mb-4 p-2 bg-red-50 border border-red-100 rounded">
          {error}
        </div>
      )}

      {result && (
        <div className="mt-4 p-3 bg-forecast/10 border border-forecast/20 rounded">
           <div className="text-xs font-semibold text-forecast mb-2">Simulated Outcome</div>
           
           <div className="text-xs text-ink-2 mb-1">Peak Shift (p50)</div>
           <div className="text-sm font-medium tabular-nums mb-3">
             {result.metrics.baseline_peak_mg_dl.toFixed(0)} &rarr; {result.metrics.new_peak_mg_dl.toFixed(0)} 
             <span className="text-ink-3 ml-1 text-xs">mg/dL</span>
             <span className={`ml-2 text-xs px-1.5 py-0.5 rounded ${result.metrics.delta_peak_mg_dl > 0 ? 'bg-danger/10 text-danger' : 'bg-physics/10 text-physics'}`}>
               {result.metrics.delta_peak_mg_dl > 0 ? '+' : ''}{result.metrics.delta_peak_mg_dl.toFixed(0)} mg/dL
             </span>
           </div>
           
           <div className="text-xs text-ink-2 mb-1">Risk Shift (120m)</div>
           <div className="text-sm font-medium tabular-nums">
             {(result.metrics.baseline_probability * 100).toFixed(0)}% &rarr; {(result.metrics.new_probability * 100).toFixed(0)}%
             <span className={`ml-2 text-xs px-1.5 py-0.5 rounded ${result.metrics.delta_probability > 0 ? 'bg-danger/10 text-danger' : 'bg-physics/10 text-physics'}`}>
               {result.metrics.delta_probability > 0 ? '+' : ''}{(result.metrics.delta_probability * 100).toFixed(0)}%
             </span>
           </div>
        </div>
      )}
    </div>
  );
}
