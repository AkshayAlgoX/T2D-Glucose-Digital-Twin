import React from 'react';
import { AlertTriangle, Gauge } from 'lucide-react';
import { formatDateTime, formatPct } from '@/lib/formatters/date';
import type { ForecastResponse } from '@/types/forecast-response';

const driverLabels: Record<string, string> = {
  return_to_personal_baseline: 'Return to personal baseline',
  logged_meals_absorbing: 'Logged meal absorption',
  expected_habitual_meal: 'Expected habitual meal',
  learned_correction: 'Learned adjustment',
};

type Window = [number, number] | null;
const span = (offsets: number[]): Window => (offsets.length ? [Math.min(...offsets), Math.max(...offsets)] : null);

/** When the forecast trajectory sits above a glucose level: arithmetic on the returned quantiles only. */
export function aboveLevel(points: ReadonlyArray<{ offset_min: number; p10?: number | null; p50: number; p90?: number | null }>, level = 180) {
  const sorted = [...points].sort((a, b) => a.offset_min - b.offset_min);
  const median = sorted.filter(p => p.p50 > level).map(p => p.offset_min);
  const step = sorted.length > 1 ? sorted[1].offset_min - sorted[0].offset_min : 5;
  return {
    median: span(median),
    medianContiguous: median.length < 2 || (median[median.length - 1] - median[0]) / step + 1 === median.length,
    lower: span(sorted.filter(p => typeof p.p10 === 'number' && p.p10 > level).map(p => p.offset_min)),
    upper: span(sorted.filter(p => typeof p.p90 === 'number' && p.p90 > level).map(p => p.offset_min)),
  };
}

function HighGlucoseWindow({ points }: { points: NonNullable<ForecastResponse['forecast']>['points'] }) {
  const w = aboveLevel(points);
  const range = (r: [number, number]) => (r[0] === r[1] ? `at +${r[0]} min` : `from +${r[0]} to +${r[1]} min`);
  return (
    <div className={'risk-high' + (w.median ? ' is-high' : '')} data-testid="risk-high-window">
      <span className="risk-kicker">Forecast glucose vs 180 mg/dL</span>
      {w.median ? <p className="risk-high-main">Median above 180 mg/dL {w.medianContiguous ? range(w.median) : `at times between +${w.median[0]} and +${w.median[1]} min`}</p>
        : w.upper ? <p className="risk-high-main">Median stays below 180 mg/dL; the upper 10% bound is above it {range(w.upper)}</p>
        : <p className="risk-high-main">Below 180 mg/dL across the 80% band for the next 2 h</p>}
      {w.median && <p className="risk-high-sub">{w.lower ? `Even the lower 10% bound is above 180 ${range(w.lower)}.` : 'The lower 10% bound stays below 180.'} Read from the forecast bands.</p>}
    </div>
  );
}

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
  // The drivers decompose the forecast median at its highest point, so that is the total they sum to.
  // The separate peak-model output (spike_risk.peak_mg_dl) is a different quantity and is shown apart.
  // Never fall back to the conditional peak head: it is a different quantity from the trajectory.
  const peak = trajectoryMax;
  const peakModel = risk?.peak_mg_dl ?? null;
  const cumulative: ReadonlyArray<{ offset_min: number; p: number }> = risk?.cumulative ?? [];
  const checkpoints = cumulative.filter(point => point.offset_min === 30 || point.offset_min === 60 || point.offset_min === 120);
  const peakPoint = forecast?.forecast?.points?.length ? forecast.forecast.points.reduce((best, p) => (p.p50 > best.p50 ? p : best), forecast.forecast.points[0]) : null;
  const peakOffset = peakPoint?.offset_min ?? null;
  const residual = current != null && peak != null && drivers.length ? peak - drivers.reduce((sum, driver) => sum + driver.impact_mg_dl, current) : null;

  return (
    <div className="risk-panel">
      <section className="risk-summary" aria-labelledby="risk-heading">
        <div className="section-heading"><h2 id="risk-heading"><Gauge size={16} aria-hidden="true" /> Risk · next 2 hours</h2></div>
        {!forecast ? (
          <>
            <div className="risk-estimate" aria-busy="true"><span className="skeleton skeleton-risk-value" aria-hidden="true" /><span>onset probability</span></div>
            <div className="risk-alert" aria-busy="true"><span className="skeleton skeleton-risk-alert" aria-hidden="true" /></div>
            <p className="muted-copy">Probability of a spike onset within 120 min.</p>
            <div className="skeleton-meter" aria-busy="true"><div className="skeleton skeleton-meter-bar" aria-hidden="true" /></div>
          </>
        ) : (
          <>
            {!!forecast.forecast?.points?.length && <HighGlucoseWindow points={forecast.forecast.points} />}
            <span className="risk-kicker">New-spike onset risk</span>
            <div className="risk-estimate">{prob != null ? formatPct(prob, 1) : '—'}<span>onset probability</span></div>
            {forecast.as_of && <p className="risk-as-of fine-print">Forecast as of <time dateTime={forecast.as_of}>{formatDateTime(forecast.as_of)}</time></p>}
            <div className={'risk-alert ' + tone}>{alert?.state === 'watch' || alert?.state === 'warning' ? <AlertTriangle size={15} aria-hidden="true" /> : null}<strong>{alertLabel}</strong></div>
            <p className="muted-copy">Probability that a new spike <em>starts</em> within 120 min{risk ? risk.calibrated ? ' (calibrated on the validation split; not independently tested)' : ' (not calibrated)' : ''}. A separate model output from the curve: it can fall while glucose is already high.</p>
            {risk?.spike_in_progress && <p className="risk-in-progress" data-testid="spike-in-progress">The service reports a spike already in progress.</p>}
            <p className="fine-print risk-definition" data-testid="risk-definition">Spike: glucose reaches 180 mg/dL after rising at least 50 mg/dL within 60 min, and stays there 15 min.</p>
            {!!checkpoints.length && <div className="cumulative-summary">
              <span>Cumulative onset probability · next&nbsp;2&nbsp;h</span>
              {forecast.as_of && <p className="cumulative-as-of">Forecast as of <time dateTime={forecast.as_of}>{formatDateTime(forecast.as_of)}</time></p>}
              <dl>{checkpoints.map(point => <div key={point.offset_min}>
                <dt>By {point.offset_min} min</dt>
                <dd title={`Source probability: ${point.p}`}>{formatPct(point.p, 1)}</dd>
                <span className="cumulative-bar" aria-hidden="true"><i style={{ width: `${Math.max(0, Math.min(1, point.p)) * 100}%` }} /></span>
              </div>)}</dl>
            </div>}
            {prob != null && <meter className="sr-only" min={0} max={100} value={prob * 100} aria-label="Spike onset probability">{formatPct(prob, 1)}</meter>}
            {prob != null && <div className="risk-meter" aria-hidden="true">
              <div className={'risk-meter-fill ' + tone} style={{ width: formatPct(prob, 2) }} />
              <span className="risk-meter-marker" style={{ left: '35%' }} />
              <span className="risk-meter-marker" style={{ left: '60%' }} />
            </div>}
          </>
        )}
        <div className="policy-labels"><span>35% watch</span><span>60% warning</span></div>
        <details className="spike-definition context-details">
          <summary>How to read this probability</summary>
          <p className="fine-print" data-testid="risk-vs-curve">The curve shows the middle outcome at each time. A median above 180 mg/dL means the model puts at least half of its predicted range above 180 at that time. It does not mean a spike is certain: a spike also needs a rise of at least 50 mg/dL within 60 min that lasts 15 min. The probability is a separate estimate, calibrated on the validation data, that a new spike starts within 120 min.</p>
          <p className="fine-print">
            Operational criteria: a glucose rise of &ge; 50 mg/dL within a 60-minute window, reaching or exceeding 180 mg/dL, and persisting for at least 15 minutes.
          </p>
          <p className="fine-print">Alert status is supplied by the served policy; thresholds alone do not define an alert.</p>
        </details>
      </section>

      <details className="contributions" open={false}>
        <summary><h2 id="contributions-heading">Model contributions</h2><span className="fine-print">show</span></summary>
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
            <p className="fine-print" data-testid="contributions-horizon">&ldquo;Median at peak&rdquo; is the highest point of the forecast median curve in the next 2 h{peakOffset != null ? ` (+${peakOffset} min)` : ''}, so &ldquo;Learned adjustment&rdquo; here is measured there. The &ldquo;How this forecast is built&rdquo; strip shows the same split at the horizon you choose.</p>
            {peakModel && <details className="context-details" data-testid="peak-model-output">
              <summary>If a spike occurs: peak estimate</summary>
              <p className="fine-print">A separate model head estimates how high glucose would go <em>if a spike occurs</em>: median {Math.round(peakModel.p50)} mg/dL{peakModel.p90 != null ? `, 90th percentile ${Math.round(peakModel.p90)} mg/dL` : ''}. It was trained only on windows that contain a spike, so it is conditional on one happening and is not the expected peak; it has not been evaluated in the evidence artifacts. It is a different target from the forecast bands and from the contributions above.</p>
            </details>}
          </>
        )}
      </details>
    </div>
  );
}
