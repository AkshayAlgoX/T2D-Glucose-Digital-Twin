import React from 'react';
import { AlertTriangle, Gauge } from 'lucide-react';
import { formatDateTime, formatPct } from '@/lib/formatters/date';
import type { ForecastResponse } from '@/types/forecast-response';

const driverLabels: Record<string, string> = {
  return_to_personal_baseline: 'Return to personal baseline',
  logged_meals_absorbing: 'Logged meal absorption',
  expected_habitual_meal: 'Expected habitual meal',
  learned_correction: 'Learned correction',
};

export function RiskPanel({ forecast }: { forecast: ForecastResponse | null }) {
  const risk = forecast?.spike_risk;
  const prob = risk?.probability_120m ?? null;
  const alert = forecast?.alert;
  const tone = alert?.state === 'warning' ? 'status-warning' : alert?.state === 'watch' ? 'status-watch' : '';
  const alertLabel = alert?.state === 'warning' ? 'Spike Warning' : alert?.state === 'watch' ? 'Risk Watch' : alert?.state === 'none' ? 'No active alert' : 'Alert state unavailable';
  const drivers = forecast?.drivers ?? [];
  const current = forecast?.current?.value_mg_dl ?? null;
  const trajectoryMax = forecast?.forecast?.points?.length
    ? Math.max(...forecast.forecast.points.map(p => p.p50))
    : null;
  const peak = risk?.peak_mg_dl?.p50 ?? trajectoryMax;
  const residual = current != null && peak != null && drivers.length ? peak - drivers.reduce((sum, driver) => sum + driver.impact_mg_dl, current) : null;

  return (
    <div className="risk-panel">
      <section className="risk-summary" aria-labelledby="risk-heading">
        <div className="section-heading"><h2 id="risk-heading"><Gauge size={16} aria-hidden="true" /> Spike risk</h2><span className="fine-print">Next 120 min</span></div>
        {!forecast ? (
          <>
            <div className="risk-estimate" aria-busy="true"><span className="skeleton skeleton-risk-value" aria-hidden="true" /><span>onset probability</span></div>
            <div className="risk-alert" aria-busy="true"><span className="skeleton skeleton-risk-alert" aria-hidden="true" /></div>
            <p className="muted-copy">Probability of a spike onset within 120 min.</p>
            <div className="skeleton-meter" aria-busy="true"><div className="skeleton skeleton-meter-bar" aria-hidden="true" /></div>
          </>
        ) : (
          <>
            <div className="risk-estimate">{prob != null ? formatPct(prob, 1) : '—'}<span>onset probability</span></div>
            {forecast.as_of && <p className="risk-as-of fine-print">Forecast as of <time dateTime={forecast.as_of}>{formatDateTime(forecast.as_of)}</time></p>}
            <div className={'risk-alert ' + tone}>{alert?.state === 'watch' || alert?.state === 'warning' ? <AlertTriangle size={15} aria-hidden="true" /> : null}<strong>{alertLabel}</strong></div>
            <p className="muted-copy">Probability of a spike onset within 120 min{risk ? risk.calibrated ? ', calibrated' : ', not calibrated' : ''}.</p>
            {prob != null && <meter className="sr-only" min={0} max={100} value={prob * 100} aria-label="Spike onset probability">{formatPct(prob, 1)}</meter>}
            {prob != null && <div className="risk-meter" aria-hidden="true">
              <div className={'risk-meter-fill ' + tone} style={{ width: formatPct(prob, 2) }} />
              <span className="risk-meter-marker" style={{ left: '35%' }} />
              <span className="risk-meter-marker" style={{ left: '60%' }} />
            </div>}
          </>
        )}
        <div className="policy-labels"><span>35% watch threshold</span><span>60% warning threshold</span></div>
        <p className="fine-print">Alert status is supplied by the served policy; thresholds alone do not define an alert.</p>
        <details className="spike-definition context-details">
          <summary>How is a spike defined?</summary>
          <p className="fine-print">
            Operational criteria: A glucose rise of &ge; 50 mg/dL within a 60-minute window, reaching or exceeding 180 mg/dL, and persisting for at least 15 minutes.
          </p>
        </details>
      </section>

      <section className="contributions" aria-labelledby="contributions-heading">
        <h2 id="contributions-heading">Model contributions</h2>
        <p className="fine-print">Arithmetic of the model's own forecast — not a causal attribution. Values in mg/dL.</p>
        {!forecast ? (
          <div className="skeleton-contributions" aria-busy="true" aria-label="Loading model contributions">
            <div className="skeleton-row"><span className="skeleton skeleton-table-label" /><span className="skeleton skeleton-table-val" /></div>
            <div className="skeleton-row"><span className="skeleton skeleton-table-label" /><span className="skeleton skeleton-table-val" /></div>
            <div className="skeleton-row"><span className="skeleton skeleton-table-label" /><span className="skeleton skeleton-table-val" /></div>
            <div className="skeleton-row skeleton-row-peak"><span className="skeleton skeleton-table-label" /><span className="skeleton skeleton-table-val" /></div>
          </div>
        ) : (
          <>
            <table className="contribution-table">
              <caption className="sr-only">Current glucose, forecast contributions and reported median at peak, in mg/dL</caption>
              <tbody>
                <tr><th scope="row">Current glucose</th><td>{current != null ? Math.round(current) : '—'}</td></tr>
                {drivers.map((driver, index) => <tr key={driver.feature_key + '-' + index}>
                  <th scope="row"><span className={'driver-dot ' + (driver.source === 'twin' || driver.source === 'both' ? 'driver-twin' : '')} />{driverLabels[driver.feature_key] ?? driver.label_key ?? driver.feature_key}</th>
                  <td>{driver.impact_mg_dl > 0 ? '+' : ''}{Math.round(driver.impact_mg_dl)}</td>
                </tr>)}
                {residual != null && Math.abs(residual) >= 0.5 && <tr className="residual-row"><th scope="row">Residual</th><td>{residual > 0 ? '+' : ''}{Math.round(residual)}</td></tr>}
                <tr className="peak-total"><th scope="row">Median at peak</th><td>{peak != null ? Math.round(peak) : '—'}</td></tr>
              </tbody>
            </table>
            {!drivers.length && <p className="fine-print">Contribution details have not been received.</p>}
            {risk?.time_to_peak_min != null && <p className="fine-print">Reported time to peak: {risk.time_to_peak_min} min from the forecast anchor.</p>}
          </>
        )}
      </section>
    </div>
  );
}
