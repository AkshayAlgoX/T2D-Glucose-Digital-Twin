import React from 'react';
import { FlaskConical } from 'lucide-react';
import type { ForecastResponse } from '@/types/forecast-response';

export function ScenarioEditor(_props: { patientId: string; currentForecast?: ForecastResponse | null }) {
  return (
    <section className="simulation-unavailable" aria-labelledby="simulation-heading">
      <div className="section-heading">
        <h2 id="simulation-heading"><FlaskConical size={16} aria-hidden="true" /> Simulation</h2>
        <span className="status-badge">Unavailable</span>
      </div>
      <p className="unavailable-title">Scenario service not connected</p>
      <p className="fine-print">Meal and activity controls are unavailable. No validated simulation results are available in this build; human causal effects have not been validated.</p>
    </section>
  );
}
