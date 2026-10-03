import React, { useState } from 'react';

export function ScenarioEditor({ patientId, currentForecast, pinnedAsOf }: any) {
  const [inputs, setInputs] = useState<any[]>([{ kind: 'meal', carbs_g: 30, offset_min: 0 }]);
  const [result, setResult] = useState<any>(null);
  const [loading, setLoading] = useState(false);

  const runSimulation = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/forecast', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          patientId,
          pinned_as_of: pinnedAsOf,
          scenarios: [{
             scenario_id: 'scen-1',
             inputs: inputs
          }]
        })
      });
      if (res.ok) {
        setResult(await res.json());
      }
    } catch (e) {
      console.error(e);
    }
    setLoading(false);
  };

  return (
    <div className="p-4 border-b border-line">
      <h3 className="text-[13px] font-semibold text-ink mb-4">What-If Projections</h3>
      <div className="text-xs text-ink-2 mb-4">
        Projection under model assumptions — direction checked, size not validated
      </div>
      
      {/* Very simple form for testing, real UI needs to be built out */}
      <div className="space-y-2 mb-4">
         <select aria-label="Scenario type" className="border border-line rounded px-2 py-1 bg-surface text-ink text-xs w-full"
                 value={inputs[0].kind}
                 onChange={(e) => setInputs([{...inputs[0], kind: e.target.value}])}>
           <option value="meal">Meal (g)</option>
           <option value="activity">Activity (min)</option>
           <option value="medication" disabled>Medication (not modelled)</option>
         </select>
         <button onClick={runSimulation} disabled={loading} className="px-3 py-1 bg-ink text-surface rounded font-medium text-xs w-full">
           {loading ? 'Simulating...' : 'Run Simulation'}
         </button>
      </div>

      {result && (
        <div className="mt-4 p-3 bg-surface-2 rounded">
           <div className="text-xs text-ink-2 mb-1">Peak A &rarr; B mg/dL (&Delta;)</div>
           <div className="text-sm font-medium">
             {result.metrics.baseline_peak_mg_dl.toFixed(0)} &rarr; {result.metrics.new_peak_mg_dl.toFixed(0)} ({result.metrics.delta_peak_mg_dl > 0 ? '+' : ''}{result.metrics.delta_peak_mg_dl.toFixed(0)})
           </div>
           
           <div className="text-xs text-ink-2 mt-2 mb-1">Risk A% &rarr; B%</div>
           <div className="text-sm font-medium">
             {(result.metrics.baseline_probability * 100).toFixed(0)}% &rarr; {(result.metrics.new_probability * 100).toFixed(0)}%
           </div>
        </div>
      )}
    </div>
  );
}
