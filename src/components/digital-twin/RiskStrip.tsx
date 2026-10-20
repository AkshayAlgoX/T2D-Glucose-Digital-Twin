import React, { useEffect, useRef, useState } from 'react';
import * as d3Scale from 'd3-scale';
import * as d3Shape from 'd3-shape';
import { formatDateTime, formatPct, formatTime } from '@/lib/formatters/date';
import type { ForecastResponse } from '@/types/forecast-response';
import type { SubjectStore } from '@/lib/types';

const WATCH = 0.35;
const WARNING = 0.6;

export function RiskStrip({ forecast, cache, isLoading }: { forecast: ForecastResponse | null; cache?: SubjectStore; isLoading?: boolean }) {
  const containerRef = useRef<HTMLElement>(null);
  const [plotWidth, setPlotWidth] = useState(720);
  const plotHeight = 150;
  useEffect(() => {
    if (!containerRef.current || typeof ResizeObserver === 'undefined') return;
    // Observe the persistent card's content box, including while history is empty.
    const observer = new ResizeObserver(([entry]) => {
      if (entry && entry.contentRect.width > 0) setPlotWidth(entry.contentRect.width);
    });
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);
  // The telemetry hook writes cache.risk; risk_history is legacy presentation data.
  const history = (cache?.risk?.length ? cache.risk : cache?.risk_history ?? [])
    .filter(point => Number.isFinite(point.p) && Number.isFinite(Date.parse(point.t)));
  const cumulative: ReadonlyArray<{ offset_min: number; p: number }> = forecast?.spike_risk?.cumulative ?? [];
  const checkpoints = cumulative.filter(point => point.offset_min === 30 || point.offset_min === 60 || point.offset_min === 120);

  const margin = { left: 40, right: 10, top: 10, bottom: 22 };
  const plotRight = Math.max(margin.left + 1, plotWidth - margin.right);
  const plotBottom = plotHeight - margin.bottom;
  const x = d3Scale.scaleUtc().domain(history.length > 1 ? [new Date(history[0].t), new Date(history[history.length - 1].t)] : [0, 1]).range([margin.left, plotRight]);
  // Fixed 0-100% scale: low estimates stay visibly low rather than being stretched to look volatile.
  const y = d3Scale.scaleLinear().domain([0, 1]).range([plotBottom, margin.top]);
  const line = d3Shape.line<{ t: string; p: number }>().x(point => x(new Date(point.t))).y(point => y(point.p)).curve(d3Shape.curveStepAfter);
  const area = d3Shape.area<{ t: string; p: number }>().x(point => x(new Date(point.t))).y0(plotBottom).y1(point => y(point.p)).curve(d3Shape.curveStepAfter);
  const ticks = history.length > 1 ? x.ticks(plotWidth < 420 ? 3 : 5) : [];
  const markerRadius = history.length > 40 ? 1.75 : 3;

  const latest = history[history.length - 1];
  const highest = history.reduce<(typeof history)[number] | null>((best, p) => (!best || p.p > best.p ? p : best), null);
  const lowest = history.reduce<(typeof history)[number] | null>((best, p) => (!best || p.p < best.p ? p : best), null);

  const snapshots = <table className="snapshot-table">
    <caption>Received observations · no intermediate values inferred</caption>
    <thead><tr><th scope="col">Recorded forecast anchor (UTC)</th><th scope="col">120-min risk</th></tr></thead>
    <tbody>{history.map((point, index) => <tr key={`${point.t}-${index}`}>
      <th scope="row"><time dateTime={point.t}>{formatDateTime(point.t).replace(' UTC', '')}</time></th>
      <td title={`Source probability: ${point.p}`}>{formatPct(point.p, 1)}</td>
    </tr>)}</tbody>
  </table>;

  return (
    <section ref={containerRef} className="risk-history panel" aria-labelledby="risk-history-heading">
      <div className="section-heading"><h2 id="risk-history-heading">Risk history</h2><span className="fine-print">{history.length} received {history.length === 1 ? 'snapshot' : 'snapshots'}</span></div>
      <p className="fine-print">Each snapshot is the model&apos;s 120-minute onset probability at that time. Markers show received snapshots; connecting steps are visual guides.</p>
      {isLoading ? (
        <div className="skeleton-risk-strip" aria-busy="true" aria-label="Loading risk history">
          <span className="skeleton skeleton-history-bar" aria-hidden="true" />
        </div>
      ) : history.length > 1 ? <>
        <dl className="risk-history-stats" data-testid="risk-history-stats">
          <div><dt>Latest received</dt><dd>{formatPct(latest.p, 1)}</dd></div>
          {highest && <div><dt>Highest in window</dt><dd>{formatPct(highest.p, 1)}<small> at {formatTime(highest.t)} UTC</small></dd></div>}
          {lowest && <div><dt>Lowest in window</dt><dd>{formatPct(lowest.p, 1)}</dd></div>}
        </dl>
        <svg viewBox={`0 0 ${plotWidth} ${plotHeight}`} width={plotWidth} height={plotHeight} className="risk-history-chart" role="img" aria-label="Received risk snapshots; probability scale zero to one">
          {[0, 0.5, 1].map(v => <g key={v}>
            <line x1={margin.left} x2={plotRight} y1={y(v)} y2={y(v)} stroke="var(--color-line)" />
            <text x={margin.left - 6} y={y(v) + 4} textAnchor="end" className="chart-axis">{Math.round(v * 100)}%</text>
          </g>)}
          <line data-testid="risk-reference-line" x1={margin.left} x2={plotRight} y1={y(WATCH)} y2={y(WATCH)} stroke="var(--color-line-control)" strokeDasharray="3 4" />
          <text x={plotRight} y={y(WATCH) - 4} textAnchor="end" className="chart-axis risk-threshold-label">35% watch</text>
          <line data-testid="risk-warning-line" x1={margin.left} x2={plotRight} y1={y(WARNING)} y2={y(WARNING)} stroke="var(--color-amber)" strokeDasharray="3 4" strokeOpacity={0.8} />
          <text x={plotRight} y={y(WARNING) - 4} textAnchor="end" className="chart-axis risk-threshold-label warning">60% warning</text>
          {ticks.map(t => <text key={t.getTime()} x={x(t)} y={plotHeight - 6} textAnchor="middle" className="chart-axis">{formatTime(t.getTime())}</text>)}
          <path d={area(history) ?? ''} fill="var(--color-forecast)" fillOpacity={0.12} />
          <path data-testid="risk-history-path" d={line(history) ?? ''} fill="none" stroke="var(--color-forecast)" strokeWidth={2} />
          {history.map((point, index) => <circle key={`${point.t}-${index}`} data-testid="risk-snapshot-marker" cx={x(new Date(point.t))} cy={y(point.p)} r={markerRadius} fill="var(--color-surface)" stroke="var(--color-forecast)" strokeWidth={1.25}><title>{`${point.t} · onset probability ${point.p}`}</title></circle>)}
        </svg>
        <div className="history-time-labels"><time dateTime={history[0].t} title={formatDateTime(history[0].t)}>{formatTime(history[0].t)} UTC</time><span>35% reference</span><span>Latest recorded <time dateTime={history[history.length - 1].t} title={formatDateTime(history[history.length - 1].t)}>{formatTime(history[history.length - 1].t)} UTC</time></span></div>
        <p className="history-scale">Fixed probability scale: 0–100%. Flat steps indicate similar received estimates, not additional observations.</p>
        {history.length <= 5 ? snapshots : <details className="snapshot-details"><summary>View all {history.length} received snapshots</summary>{snapshots}</details>}
      </> : <div className="history-empty">{history.length === 1 ? <><strong>{formatPct(history[0].p, 1)}</strong> at <time dateTime={history[0].t}>{formatDateTime(history[0].t)}</time><p className="fine-print">One snapshot received. History accumulates as updates arrive.</p></> : 'No risk snapshots received. Historical risk is not backfilled.'}</div>}
      {!!checkpoints.length && <div className="cumulative-summary">
        <span>Current forecast · cumulative onset probability</span>
        {forecast?.as_of && <p className="cumulative-as-of">Forecast as of <time dateTime={forecast.as_of}>{formatDateTime(forecast.as_of)}</time> · the next two hours, not history</p>}
        <dl>{checkpoints.map(point => <div key={point.offset_min}>
          <dt>By {point.offset_min} min</dt>
          <dd title={`Source probability: ${point.p}`}>{formatPct(point.p, 1)}</dd>
          <span className="cumulative-bar" aria-hidden="true"><i style={{ width: `${Math.max(0, Math.min(1, point.p)) * 100}%` }} /></span>
        </div>)}</dl>
      </div>}
    </section>
  );
}
