import React, { useEffect, useId, useRef, useState } from 'react';
import * as d3Scale from 'd3-scale';
import * as d3Shape from 'd3-shape';
import { formatTime } from '@/lib/formatters/date';
import type { ForecastResponse, QuantilePoint } from '@/types/forecast-response';
import type { SubjectStore } from '@/lib/types';

export function ForecastCanvas({ forecast, cache, isStale }: { forecast: ForecastResponse | null; cache: SubjectStore; isStale?: boolean }) {
  const plotRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 800, height: 380 });
  const [selection, setSelection] = useState<{ key: string; source: 'pointer' | 'keyboard' } | null>(null);
  const pointerDismissed = useRef(false);
  const keyboardFocused = useRef(false);
  const [historyHours, setHistoryHours] = useState(6);
  const [selectedHorizon, setSelectedHorizon] = useState<number>(60);
  const chartId = 'trajectory-' + useId().replace(/:/g, '');

  useEffect(() => {
    const dismiss = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setSelection(null); pointerDismissed.current = true; }
    };
    document.addEventListener('keydown', dismiss);
    return () => document.removeEventListener('keydown', dismiss);
  }, []);

  useEffect(() => {
    setSelection(null);
  }, [forecast?.subject?.subject_id, forecast?.as_of]);

  // The observed element is mounted even while waiting for the first forecast.
  useEffect(() => {
    if (!plotRef.current || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(entries => {
      const rect = entries[0]?.contentRect;
      if (rect?.width > 0 && rect?.height > 0) setSize({ width: rect.width, height: rect.height });
    });
    observer.observe(plotRef.current);
    return () => observer.disconnect();
  }, []);

  const anchor = forecast?.as_of ? Date.parse(forecast.as_of) : NaN;
  const hasAnchor = Number.isFinite(anchor);
  const points = (forecast?.forecast?.points ?? []) as QuantilePoint[];
  const mapped = points.map(point => ({ ...point, time: anchor + point.offset_min * 60000 }));
  const hasPhysics = mapped.some(point => point.twin_p50 != null);
  const scenario = forecast?.scenarios?.[0]?.points ?? [];
  const mappedScenario = scenario.map(point => ({ ...point, time: anchor + point.offset_min * 60000 }));
  const history = (cache?.cgm ?? []).map(point => ({ ...point, time: Date.parse(point.t) }))
    .filter(point => Number.isFinite(point.time) && Number.isFinite(point.value) && point.time >= anchor - historyHours * 3600000 && point.time <= anchor);
  const historySegments = history.reduce<(typeof history)[]>((segments, point, index) => {
    if (index === 0 || point.time - history[index - 1].time > 5 * 60000) segments.push([]);
    segments[segments.length - 1].push(point);
    return segments;
  }, []);
  const current = forecast?.current?.value_mg_dl;
  const peak = forecast?.spike_risk?.peak_mg_dl?.p50;
  const peakOffset = forecast?.spike_risk?.time_to_peak_min;
  const start = Math.min(anchor - 30 * 60000, ...history.map(point => point.time));
  const end = anchor + 120 * 60000;
  const narrow = size.width < 520;
  const margin = { left: narrow ? 38 : 48, right: 20, top: 30, bottom: 36 };
  const right = Math.max(margin.left + 1, size.width - margin.right);
  const bottom = Math.max(margin.top + 1, size.height - margin.bottom);
  const values = [
    ...history.map(point => point.value),
    ...mapped.flatMap(point => [point.p05, point.p10, point.p50, point.p90, point.p95, point.twin_p50]),
    ...mappedScenario.flatMap(point => [point.p10, point.p50, point.p90]), current, peak,
  ].filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  const yMin = Math.max(0, Math.floor(Math.min(40, ...values) / 20) * 20 - 20);
  const yMax = Math.ceil((Math.max(220, ...values) + 20) / 20) * 20;
  const x = d3Scale.scaleUtc().domain(hasAnchor ? [start, end] : [0, 1]).range([margin.left, right]);
  const y = d3Scale.scaleLinear().domain([yMin, yMax]).range([bottom, margin.top]);
  // Keep the spike reference legible when the plot is short on mobile.
  const yTicks = Array.from(new Set([...y.ticks(5), 180]))
    .filter(tick => tick === 180 || Math.abs(y(tick) - y(180)) >= 22)
    .sort((a, b) => a - b);
  const area = (lower: 'p05' | 'p10', upper: 'p95' | 'p90') => d3Shape.area<(typeof mapped)[number]>()
    .defined(point => Number.isFinite(point[lower]) && Number.isFinite(point[upper]))
    .x(point => x(point.time)).y0(point => y(point[lower])).y1(point => y(point[upper])).curve(d3Shape.curveLinear);
  const median = d3Shape.line<{ time: number; p50: number }>().defined(point => Number.isFinite(point.p50))
    .x(point => x(point.time)).y(point => y(point.p50)).curve(d3Shape.curveLinear);
  const observed = d3Shape.line<(typeof history)[number]>().x(point => x(point.time)).y(point => y(point.value)).curve(d3Shape.curveLinear);
  const physics = d3Shape.line<(typeof mapped)[number]>().defined(point => point.twin_p50 != null && Number.isFinite(point.twin_p50))
    .x(point => x(point.time)).y(point => y(point.twin_p50!)).curve(d3Shape.curveLinear);
  const inspectable = [
    ...history.map(point => ({ key: `observed-${point.time}`, kind: 'observed' as const, time: point.time, value: point.value, point: null })),
    ...mapped.filter(point => Number.isFinite(point.time) && Number.isFinite(point.p50))
      .map(point => ({ key: `forecast-${point.time}`, kind: 'forecast' as const, time: point.time, value: point.p50, point })),
  ].sort((a, b) => a.time - b.time);
  const selected = inspectable.find(point => point.key === selection?.key);
  const selectedTimestamp = selected ? selected.point?.t || new Date(selected.time).toISOString() : '';
  const quantile = (value: number | undefined) => value != null && Number.isFinite(value) ? String(value) : 'Unavailable';
  const interval = (low: number | undefined, high: number | undefined) =>
    low != null && high != null && Number.isFinite(low) && Number.isFinite(high) ? `${low}–${high} mg/dL` : 'Unavailable';
  const selectAt = (index: number, source: 'pointer' | 'keyboard') => {
    if (inspectable[index]) setSelection({ key: inspectable[index].key, source });
  };
  const isWarning = forecast?.alert?.state === 'warning';

  const availableOffsets = points.map(point => point.offset_min);
  const activeOffset = selected?.point?.offset_min ?? (
    availableOffsets.includes(selectedHorizon)
      ? selectedHorizon
      : (availableOffsets.includes(60) ? 60 : (availableOffsets[0] ?? 60))
  );

  const targetPoint = points.find(point => point.offset_min === activeOffset) ?? null;
  const isFallback = forecast?.model?.fallback_used === 'twin_only';

  const hybridP50 = targetPoint?.p50 ?? null;
  const physicsP50 = targetPoint?.twin_p50 ?? (isFallback && hybridP50 != null ? hybridP50 : null);

  let diffDisplay = 'Unavailable';
  let diffClass = '';

  if (hybridP50 != null && physicsP50 != null) {
    const diff = Number((hybridP50 - physicsP50).toFixed(1));
    if (diff > 0) {
      diffDisplay = `+${diff.toFixed(1)} mg/dL`;
      diffClass = 'adjustment-positive';
    } else if (diff < 0) {
      diffDisplay = `${diff.toFixed(1)} mg/dL`;
      diffClass = 'adjustment-negative';
    } else {
      diffDisplay = `0.0 mg/dL`;
      diffClass = 'adjustment-neutral';
    }
  } else if (isFallback && hybridP50 != null) {
    diffDisplay = '0.0 mg/dL';
    diffClass = 'adjustment-neutral';
  } else {
    diffDisplay = 'Unavailable';
  }

  const handleSelectHorizon = (offset: number) => {
    setSelectedHorizon(offset);
    const target = inspectable.find(p => p.kind === 'forecast' && p.point?.offset_min === offset);
    if (target) {
      setSelection({ key: target.key, source: 'pointer' });
    }
  };

  const inspectPointer = (event: React.PointerEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (!rect.width || !inspectable.length || pointerDismissed.current) return;
    const position = (event.clientX - rect.left) * size.width / rect.width;
    if (position < margin.left || position > right) return;
    const time = x.invert(position).getTime();
    const candidates = inspectable.filter(point => position < x(anchor) ? point.kind === 'observed' : point.kind === 'forecast');
    if (!candidates.length) { setSelection(null); return; }
    const nearest = candidates.reduce((best, point) => Math.abs(point.time - time) < Math.abs(best.time - time) ? point : best);
    setSelection({ key: nearest.key, source: 'pointer' });
  };

  return (
    <div className="forecast-canvas" data-stale={isStale || undefined}>
      <div className="chart-toolbar"><div className="chart-legend" role="group" aria-label="Chart legend">
        <span><i className="legend-observed" />Observed CGM</span>
        <span><i className="legend-median" />Forecast median</span>
        <span><i className="legend-band" />P10–P90</span>
        <span><i className="legend-outer" />P05–P95</span>
        <span><i className="legend-peak" />Peak estimate</span>
        {hasPhysics && <span><i className="legend-physics" />Physics prior</span>}
      </div>
      <div className="chart-window" role="group" aria-label="Observed history window">{[2, 6].map(hours => <button key={hours} aria-pressed={historyHours === hours} onClick={() => { setHistoryHours(hours); setSelection(null); }}>Past {hours}h</button>)}</div></div>
      <div ref={plotRef} className="forecast-plot" onPointerLeave={() => {
        pointerDismissed.current = false;
        if (!keyboardFocused.current) setSelection(null);
      }}>
        {!forecast ? (
          <div className="skeleton-chart" aria-busy="true" aria-label="Loading forecast trajectory">
            <div className="skeleton skeleton-chart-grid" aria-hidden="true" />
          </div>
        ) : !hasAnchor ? (
          <div className="chart-empty"><strong>Forecast unavailable</strong><span>Waiting for a valid subject stream. No trajectory has been substituted.</span></div>
        ) : (
          <svg width={size.width} height={size.height} viewBox={'0 0 ' + size.width + ' ' + size.height}
            role="img" tabIndex={0} aria-labelledby={chartId + '-title'} aria-describedby={chartId + '-description' + (selected ? ' ' + chartId + '-tooltip' : '')}
            onPointerMove={inspectPointer}
            onFocus={() => { keyboardFocused.current = true; if (!selection) selectAt(0, 'keyboard'); }}
            onBlur={() => { keyboardFocused.current = false; setSelection(null); }}
            onKeyDown={event => {
              if (event.key === 'Escape') { setSelection(null); pointerDismissed.current = true; return; }
              if (!inspectable.length || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
              event.preventDefault();
              pointerDismissed.current = false;
              const index = inspectable.findIndex(point => point.key === selection?.key);
              selectAt(event.key === 'Home' ? 0 : event.key === 'End' ? inspectable.length - 1
                : Math.max(0, Math.min(inspectable.length - 1, index + (event.key === 'ArrowRight' ? 1 : -1))), 'keyboard');
            }}>
            <title id={chartId + '-title'}>{`Glucose forecast chart${current != null ? ': current ' + current + ' mg/dL' : ''}`}</title>
            <desc id={chartId + '-description'}>Observed CGM and a 120-minute forecast with percentile bands. Arrow keys inspect received observations and forecast points. Home selects the earliest point; End selects the latest. Escape dismisses details. All times UTC. The vertical scale expands to include displayed values.</desc>
            <defs><clipPath id={chartId + '-clip'}><rect x={margin.left} y={margin.top} width={right - margin.left} height={bottom - margin.top} /></clipPath></defs>
            <rect x={x(anchor)} y={margin.top} width={right - x(anchor)} height={bottom - margin.top} fill="var(--color-surface-2)" opacity={0.5} />
            {yTicks.map(tick => <g key={tick}>
              <line x1={margin.left} x2={right} y1={y(tick)} y2={y(tick)} stroke={tick === 180 ? 'var(--color-line-control)' : 'var(--color-line)'} strokeDasharray={tick === 180 ? '5 4' : undefined} />
              <text x={margin.left - 9} y={y(tick) + 4} textAnchor="end" className="chart-axis">{tick}</text>
              {tick === 180 && <text x={margin.left + 7} y={y(tick) - 7} className="chart-axis">180 · spike level</text>}
            </g>)}
            {x.ticks(narrow ? 4 : 7).map(tick => <g key={tick.getTime()}>
              <line x1={x(tick)} x2={x(tick)} y1={margin.top} y2={bottom} stroke="var(--color-line)" strokeDasharray="2 5" />
              <text x={x(tick)} y={bottom + 23} textAnchor="middle" className="chart-axis">{formatTime(tick.getTime())}</text>
            </g>)}
            <text x={margin.left} y={14} className="chart-axis">mg/dL</text>
            <text x={right} y={size.height - 2} textAnchor="end" className="chart-axis">UTC</text>
            <g clipPath={'url(#' + chartId + '-clip)'}>
              <g className="forecast-layer" opacity={mappedScenario.length ? 0.5 : 1}>
                <path data-testid="outer-quantile-band" d={area('p05', 'p95')(mapped) ?? ''} fill="var(--color-forecast)" fillOpacity={0.07} stroke="var(--color-forecast)" strokeWidth={1} strokeDasharray="1 4" />
                <path data-testid="quantile-band" d={area('p10', 'p90')(mapped) ?? ''} fill="var(--color-forecast)" fillOpacity={0.15} stroke="var(--color-forecast)" strokeWidth={1} />
                <path d={median(mapped) ?? ''} fill="none" stroke="var(--color-forecast)" strokeWidth={2.5} strokeDasharray="5 3" />
                {hasPhysics && <path d={physics(mapped) ?? ''} fill="none" stroke="var(--color-physics)" strokeWidth={1.5} strokeDasharray="3 5" />}
              </g>
              {!!mappedScenario.length && <g className="scenario-layer"><path d={median(mappedScenario) ?? ''} fill="none" stroke="var(--color-projection)" strokeWidth={2} strokeDasharray="2 3" /></g>}
              {historySegments.map((segment, index) => <g key={index} data-testid="observed-segment">
                <path d={observed(segment) ?? ''} fill="none" stroke="var(--color-ink)" strokeWidth={2} />
                {segment.length === 1 && <circle cx={x(segment[0].time)} cy={y(segment[0].value)} r={3} fill="var(--color-ink)" />}
              </g>)}
              {current != null && <circle data-testid="current-observation" cx={x(anchor)} cy={y(current)} r={4} fill="var(--color-ink)" stroke="white" strokeWidth={2} />}
              {peak != null && peakOffset != null && <circle cx={x(anchor + peakOffset * 60000)} cy={y(peak)} r={4} fill={isWarning ? 'var(--color-danger)' : 'var(--color-forecast)'}><title>{`Reported peak estimate: ${peak} mg/dL`}</title></circle>}
              {selected && <g pointerEvents="none"><line x1={x(selected.time)} x2={x(selected.time)} y1={margin.top} y2={bottom} stroke="var(--color-forecast)" strokeDasharray="3 3" /><circle cx={x(selected.time)} cy={y(selected.value)} r={4} fill="var(--color-forecast)" /></g>}
            </g>
            <line x1={x(anchor)} x2={x(anchor)} y1={margin.top} y2={bottom} stroke="var(--color-ink-3)" strokeDasharray="3 3" />
            <text x={Math.min(right - 52, Math.max(margin.left + 105, x(anchor)))} y={margin.top - 10} textAnchor="middle" className="chart-anchor-label">Forecast anchor</text>
            {!mapped.length && <text x={(margin.left + right) / 2} y={(margin.top + bottom) / 2} textAnchor="middle" className="chart-axis">Prediction unavailable; observed values only</text>}
          </svg>)}
        {selected && <div id={chartId + '-tooltip'} role="tooltip" className="chart-tooltip"
          style={{ left: x(selected.time) > (margin.left + right) / 2 ? 8 : undefined, right: x(selected.time) <= (margin.left + right) / 2 ? 8 : undefined }}>
          <strong>{selected.kind === 'observed' ? 'Observed CGM' : `Forecast · +${selected.point?.offset_min} min`}</strong>
          <time dateTime={selectedTimestamp}>{selectedTimestamp}</time>
          <dl>
            <div><dt>{selected.kind === 'observed' ? 'Measured glucose' : 'Median (P50)'}</dt><dd>{selected.value} mg/dL</dd></div>
            {selected.point && <>
              <div><dt>P10–P90</dt><dd>{interval(selected.point.p10, selected.point.p90)}</dd></div>
              <div><dt>P05–P95</dt><dd>{interval(selected.point.p05, selected.point.p95)}</dd></div>
              <div><dt>Forecast horizon</dt><dd>{forecast?.forecast?.horizon_min != null ? `${forecast.forecast.horizon_min} min` : 'Unavailable'}</dd></div>
            </>}
          </dl>
          <span className="tooltip-hint">Arrow keys to inspect · Esc to dismiss</span>
        </div>}
      </div>
      <div className="chart-readout">
        <span aria-hidden="true">{isStale ? 'Stale stream · ' : ''}{history.length} received CGM observations · hover or focus the chart to inspect points</span>
        <span className="sr-only" aria-live={selection?.source === 'keyboard' ? 'polite' : 'off'} aria-atomic="true">
          {selected && (selected.point
            ? `${selectedTimestamp} · Median ${selected.value} mg/dL · P10–P90 ${quantile(selected.point.p10)}–${quantile(selected.point.p90)} mg/dL · P05–P95 ${quantile(selected.point.p05)}–${quantile(selected.point.p95)} mg/dL · +${selected.point.offset_min} min of ${forecast?.forecast?.horizon_min ?? 'unavailable'} min forecast horizon`
            : `${selectedTimestamp} · Observed CGM ${selected.value} mg/dL`)}
        </span>
      </div>

      <div className="hybrid-inspector" data-testid="hybrid-inspector" role="region" aria-label="Physics prior vs. hybrid forecast">
        <div className="inspector-header">
          <div className="inspector-title-row">
            <span className="inspector-title">Physics prior vs. hybrid forecast</span>
            {isFallback && <span className="inspector-badge fallback" data-testid="twin-only-fallback-badge">Twin-only fallback</span>}
            {isStale && <span className="inspector-badge stale" data-testid="stale-stream-badge">Stale stream</span>}
          </div>
          <div className="inspector-horizon-controls" role="group" aria-label="Horizon selection">
            <span className="horizon-label">Horizon:</span>
            <div className="horizon-pills">
              {[15, 30, 60, 120].map(h => (
                <button
                  key={h}
                  type="button"
                  data-testid={`horizon-pill-${h}`}
                  className={`horizon-pill${activeOffset === h ? ' active' : ''}`}
                  aria-pressed={activeOffset === h}
                  disabled={!availableOffsets.includes(h)}
                  onClick={() => handleSelectHorizon(h)}
                >
                  +{h}m
                </button>
              ))}
            </div>
            {availableOffsets.length > 0 && (
              <select
                className="horizon-select"
                data-testid="horizon-dropdown"
                aria-label="All forecast horizons"
                value={activeOffset}
                onChange={e => handleSelectHorizon(Number(e.target.value))}
              >
                {availableOffsets.map(offset => (
                  <option key={offset} value={offset}>
                    +{offset} min
                  </option>
                ))}
              </select>
            )}
          </div>
        </div>

        <div className="inspector-metrics">
          <div className="inspector-metric-card" data-testid="physics-prior-card">
            <span className="metric-label">Physics prior (twin_p50)</span>
            <span className="metric-value" data-testid="physics-prior-value">
              {physicsP50 != null ? `${Number(physicsP50.toFixed(1))} mg/dL` : 'Unavailable'}
            </span>
          </div>

          <div className="inspector-metric-card" data-testid="hybrid-forecast-card">
            <span className="metric-label">Hybrid forecast (p50)</span>
            <span className="metric-value" data-testid="hybrid-forecast-value">
              {hybridP50 != null ? `${Number(hybridP50.toFixed(1))} mg/dL` : 'Unavailable'}
            </span>
          </div>

          <div className="inspector-metric-card" data-testid="forecast-adjustment-card">
            <span className="metric-label">Forecast adjustment (p50 − twin_p50)</span>
            <span className={`metric-value ${diffClass}`} data-testid="forecast-adjustment-value">
              {diffDisplay}
            </span>
          </div>
        </div>

        <div className="inspector-footnote" data-testid="inspector-note">
          <span>Empirical model adjustment · Not a causal effect or accuracy improvement.</span>
          {forecast?.as_of && (
            <span className="inspector-timestamp">
              Anchor: <time dateTime={forecast.as_of}>{formatTime(Date.parse(forecast.as_of))} UTC</time>
              {forecast.subject?.subject_id ? ` · ${forecast.subject.subject_id}` : ''}
            </span>
          )}
        </div>
      </div>

      {!!mappedScenario.length && <p className="fine-print">Existing scenario overlay · projection under model assumptions, not validated human causal effects.</p>}
      <style>{`
        .hybrid-inspector {
          margin: 4px 12px 8px;
          padding: 8px 12px;
          border: 1px solid var(--color-line, #e2e8f0);
          border-radius: 6px;
          background: var(--color-surface, #ffffff);
          font-size: 11px;
          color: var(--color-ink, #0f172a);
          display: flex;
          flex-direction: column;
          gap: 6px;
        }
        .inspector-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          flex-wrap: wrap;
          gap: 6px;
        }
        .inspector-title-row {
          display: flex;
          align-items: center;
          gap: 6px;
        }
        .inspector-title {
          font-weight: 600;
          font-size: 11px;
          color: var(--color-ink, #1e293b);
        }
        .inspector-badge {
          font-size: 9px;
          font-weight: 600;
          padding: 1px 6px;
          border-radius: 4px;
          text-transform: uppercase;
          letter-spacing: 0.3px;
        }
        .inspector-badge.fallback {
          background: #fef3c7;
          color: #92400e;
          border: 1px solid #fcd34d;
        }
        .inspector-badge.stale {
          background: #fee2e2;
          color: #991b1b;
          border: 1px solid #fca5a5;
        }
        .inspector-horizon-controls {
          display: flex;
          align-items: center;
          gap: 4px;
        }
        .horizon-label {
          color: var(--color-ink-3, #64748b);
          font-size: 10px;
        }
        .horizon-pills {
          display: flex;
          gap: 2px;
          background: var(--color-surface-2, #f1f5f9);
          padding: 2px;
          border-radius: 4px;
          border: 1px solid var(--color-line, #e2e8f0);
        }
        .horizon-pill {
          padding: 2px 6px;
          font-size: 10px;
          font-weight: 500;
          border: none;
          background: transparent;
          color: var(--color-ink-2, #475569);
          border-radius: 3px;
          cursor: pointer;
        }
        .horizon-pill:disabled {
          opacity: 0.4;
          cursor: not-allowed;
        }
        .horizon-pill.active {
          background: #ffffff;
          color: var(--color-accent, #0f766e);
          box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08);
          font-weight: 600;
        }
        .horizon-select {
          font-size: 10px;
          padding: 2px 4px;
          border: 1px solid var(--color-line, #e2e8f0);
          border-radius: 4px;
          background: var(--color-surface, #ffffff);
          color: var(--color-ink, #1e293b);
          cursor: pointer;
        }
        .inspector-metrics {
          display: grid;
          grid-template-columns: repeat(3, minmax(0, 1fr));
          gap: 6px;
        }
        .inspector-metric-card {
          padding: 4px 8px;
          background: var(--color-surface-2, #f8fafc);
          border-radius: 4px;
          border: 1px solid var(--color-line, #f1f5f9);
          display: flex;
          flex-direction: column;
          gap: 1px;
        }
        .metric-label {
          font-size: 9px;
          color: var(--color-ink-3, #64748b);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .metric-value {
          font-size: 12px;
          font-weight: 600;
          color: var(--color-ink, #0f172a);
          font-variant-numeric: tabular-nums;
        }
        .metric-value.adjustment-positive {
          color: var(--color-forecast, #2563eb);
        }
        .metric-value.adjustment-negative {
          color: var(--color-physics, #7c3aed);
        }
        .metric-value.adjustment-neutral {
          color: var(--color-ink-2, #475569);
        }
        .inspector-footnote {
          display: flex;
          justify-content: space-between;
          align-items: center;
          font-size: 9.5px;
          color: var(--color-ink-3, #64748b);
          padding-top: 2px;
          border-top: 1px dashed var(--color-line, #e2e8f0);
          flex-wrap: wrap;
          gap: 4px;
        }
        .inspector-timestamp {
          font-variant-numeric: tabular-nums;
        }
        @media (max-width: 520px) {
          .inspector-metrics {
            grid-template-columns: 1fr;
            gap: 4px;
          }
          .inspector-metric-card {
            flex-direction: row;
            justify-content: space-between;
            align-items: center;
            padding: 4px 8px;
          }
          .metric-label {
            white-space: normal;
          }
          .inspector-footnote {
            flex-direction: column;
            align-items: flex-start;
            gap: 2px;
          }
        }
      `}</style>
    </div>
  );
}
