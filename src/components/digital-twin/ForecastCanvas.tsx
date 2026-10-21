import React, { useEffect, useId, useRef, useState } from 'react';
import * as d3Scale from 'd3-scale';
import * as d3Shape from 'd3-shape';
import { formatTime } from '@/lib/formatters/date';
import type { ForecastResponse, QuantilePoint } from '@/types/forecast-response';
import type { SubjectStore, WearableView } from '@/lib/types';
import { AboveBars, Bands, Decomposition, Glyph, HatchDefs, MedianLine, ObservedDots, Threshold, TwinLine, Wedge, type FigPoint } from '@/components/figure/marks';

/** Isolated one-step departures above this size are called out under the chart (mg/dL). */
const ISOLATED_STEP_NOTE_MG_DL = 20;

function hasPhysicsValue(points: ReadonlyArray<{ twin_p50?: number | null }>) { return points.some(p => p.twin_p50 != null); }

export function ForecastCanvas({ forecast, cache, isStale, unreachable = false }: { forecast: ForecastResponse | null; cache: SubjectStore; isStale?: boolean; unreachable?: boolean }) {
  const plotRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 800, height: 380 });
  const [selection, setSelection] = useState<{ key: string; source: 'pointer' | 'keyboard' } | null>(null);
  const pointerDismissed = useRef(false);
  const keyboardFocused = useRef(false);
  // Two hours of history by default so the two-hour forecast gets half the chart; six hours is one click away.
  const [historyHours, setHistoryHours] = useState(2);
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

  // Phones show one hour of history by default so the two-hour forecast gets most of the width.
  const compactWindow = size.width < 520;
  const shownHours = compactWindow && historyHours === 2 ? 1 : historyHours;
  const anchor = forecast?.as_of ? Date.parse(forecast.as_of) : NaN;
  const hasAnchor = Number.isFinite(anchor);
  const points = (forecast?.forecast?.points ?? []) as QuantilePoint[];
  const mapped = points.map(point => ({ ...point, time: anchor + point.offset_min * 60000 }));
  // Drawing only: start the band, median and twin line at the observed current value (no data added).
  const currentValue = forecast?.current?.value_mg_dl;
  const joined = mapped.length && typeof currentValue === 'number' && Number.isFinite(currentValue)
    ? [{ ...mapped[0], offset_min: 0, time: anchor, p05: currentValue, p10: currentValue, p25: currentValue, p50: currentValue, p75: currentValue, p90: currentValue, p95: currentValue, twin_p50: hasPhysicsValue(mapped) ? currentValue : mapped[0].twin_p50 }, ...mapped]
    : mapped;
  const hasPhysics = mapped.some(point => point.twin_p50 != null);
  const scenario = forecast?.scenarios?.[0]?.points ?? [];
  const mappedScenario = scenario.map(point => ({ ...point, time: anchor + point.offset_min * 60000 }));
  const history = (cache?.cgm ?? []).map(point => ({ ...point, time: Date.parse(point.t) }))
    .filter(point => Number.isFinite(point.time) && Number.isFinite(point.value) && point.time >= anchor - shownHours * 3600000 && point.time <= anchor);
  const historySegments = history.reduce<(typeof history)[]>((segments, point, index) => {
    if (index === 0 || point.time - history[index - 1].time > 5 * 60000) segments.push([]);
    segments[segments.length - 1].push(point);
    return segments;
  }, []);
  const current = forecast?.current?.value_mg_dl;
  // Largest departure of one median step from the mean of its neighbours: the learned adjustment can add
  // isolated steps the physiology twin never has (docs/evidence/model_audit/MODEL_AUDIT_20261020.md).
  const isolatedStep = points.length >= 3 ? points.slice(1, -1).reduce<{ size: number; offset: number } | null>((best, p, i) => {
    const size = Math.abs(p.p50 - (points[i].p50 + points[i + 2].p50) / 2);
    return !best || size > best.size ? { size, offset: p.offset_min } : best;
  }, null) : null;
  // Mark the forecast median's own highest point so the dot always sits on the curve it describes.
  const peakPoint = points.length ? points.reduce((best, p) => (p.p50 > best.p50 ? p : best), points[0]) : null;
  const peak = peakPoint?.p50;
  const peakOffset = peakPoint?.offset_min;
  // A few minutes of padding so the earliest reading's dot is not clipped at the plot edge.
  const start = Math.min(anchor - 30 * 60000, ...history.map(point => point.time)) - 4 * 60000;
  const end = anchor + 120 * 60000;
  const narrow = size.width < 520;
  const margin = { left: narrow ? 66 : 92, right: narrow ? 10 : 20, top: 30, bottom: 32 };
  const right = Math.max(margin.left + 1, size.width - margin.right);
  const bottom = Math.max(margin.top + 1, size.height - margin.bottom);
  const values = [
    ...history.map(point => point.value),
    ...mapped.flatMap(point => [point.p05, point.p10, point.p50, point.p90, point.p95, point.twin_p50]),
    ...mappedScenario.flatMap(point => [point.p10, point.p50, point.p90]), current, peak,
  ].filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  const yMin = Math.max(0, Math.floor(Math.min(40, ...values) / 20) * 20 - 20);
  const rawMax = Math.max(220, ...values) + 10;
  // Even ticks: every 40 mg/dL, or every 100 for very wide ranges; the axis top is the next tick above the data.
  const tickStep = rawMax - yMin > 320 ? 100 : 40;
  const yMax = Math.ceil(rawMax / tickStep) * tickStep;
  const x = d3Scale.scaleUtc().domain(hasAnchor ? [start, end] : [0, 1]).range([margin.left, right]);
  const y = d3Scale.scaleLinear().domain([yMin, yMax]).range([bottom, margin.top]);
  // Keep the spike reference legible when the plot is short on mobile.
  const evenTicks = Array.from({ length: Math.floor(yMax / tickStep) - Math.ceil(yMin / tickStep) + 1 }, (_, i) => (Math.ceil(yMin / tickStep) + i) * tickStep);
  const yTicks = evenTicks.filter(tick => tick >= yMin && tick <= yMax);
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
      diffDisplay = `−${Math.abs(diff).toFixed(1)} mg/dL`;
      // Same colour as a positive adjustment: green is reserved for the physiology twin; the sign carries direction.
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

  const xm = (m: number) => x(anchor + m * 60000);
  const fig: FigPoint[] = joined.map(point => ({ m: point.offset_min, p05: point.p05, p10: point.p10, p25: point.p25, p50: point.p50, p75: point.p75, p90: point.p90, p95: point.p95, twin: point.twin_p50 }));
  const obs = history.map(point => ({ m: (point.time - anchor) / 60000, v: point.value }));
  const tickStepMin = narrow || shownHours > 2 ? 60 : 30;
  const xTicks = Array.from({ length: Math.floor((120 - (start - anchor) / 60000) / tickStepMin) + 1 }, (_, i) => Math.ceil((start - anchor) / 60000 / tickStepMin) * tickStepMin + i * tickStepMin).filter(m => m <= 120);
  const tickLabel = (m: number) => m === 0 ? formatTime(anchor) : `${m > 0 ? '+' : '−'}${Math.abs(m) / 60} h`;
  const markerPoint = points.find(point => point.offset_min === activeOffset) ?? null;

  return (
    <div className="forecast-canvas" data-stale={isStale || undefined}>
      <div className="hybrid-inspector" data-testid="hybrid-inspector" role="region" aria-label="How this forecast is built" data-subject-id={forecast?.subject?.subject_id}>
        <div className="inspector-header">
          <div className="inspector-title-row">
            <span className="inspector-title">How this forecast is built</span>
            {forecast?.as_of && targetPoint && <span className="inspector-timestamp">at +{targetPoint.offset_min} min, <time dateTime={new Date(Date.parse(forecast.as_of) + targetPoint.offset_min * 60000).toISOString()}>{formatTime(Date.parse(forecast.as_of) + targetPoint.offset_min * 60000)} UTC</time> · point at the chart to move</span>}
            {isFallback && <span className="inspector-badge fallback" data-testid="twin-only-fallback-badge">Twin-only fallback</span>}
            {isStale && <span className="inspector-badge stale" data-testid="stale-stream-badge">Stale stream</span>}
          </div>
          <div className="inspector-horizon-controls" role="group" aria-label="Horizon selection">
            <span className="horizon-label">At</span>
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
                  +{h} min
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

        <div className="inspector-metrics hybrid-equation">
          <div className="inspector-metric-card twin" data-testid="physics-prior-card">
            <span className="metric-label">① Physiology twin</span>
            <span className="metric-value" data-testid="physics-prior-value">
              {!forecast ? '—' : physicsP50 != null ? `${Number(physicsP50.toFixed(1))} mg/dL` : 'Unavailable'}
            </span>
            <span className="metric-source">Twin median, from the model</span>
          </div>
          <span className="equation-op" aria-hidden="true">+</span>
          <div className="inspector-metric-card learned" data-testid="forecast-adjustment-card">
            <span className="metric-label">② Learned adjustment</span>
            <span className={`metric-value ${diffClass}`} data-testid="forecast-adjustment-value">
              {!forecast ? '—' : diffDisplay}
            </span>
            <span className="metric-source">Calculated here as ③ − ①</span>
          </div>
          <span className="equation-op" aria-hidden="true">=</span>
          <div className="inspector-metric-card final" data-testid="hybrid-forecast-card">
            <span className="metric-label">③ Final forecast (median)</span>
            <span className="metric-value" data-testid="hybrid-forecast-value">
              {!forecast ? '—' : hybridP50 != null ? `${Number(hybridP50.toFixed(1))} mg/dL` : 'Unavailable'}
            </span>
            <span className="metric-source" data-testid="hybrid-interval">
              {targetPoint && Number.isFinite(targetPoint.p10) && Number.isFinite(targetPoint.p90)
                ? `80% interval ${targetPoint.p10}–${targetPoint.p90} mg/dL · returned`
                : !forecast ? 'Waiting for the first forecast' : 'Interval unavailable'}
            </span>
          </div>
        </div>

        <div className="inspector-footnote" data-testid="inspector-note">
          <span>The adjustment is an empirical model adjustment, not a causal effect or accuracy improvement, and not a separately validated mechanism.</span>
        </div>
      </div>

      <div className="chart-toolbar">
        <span className="chart-toolbar-title">Glucose, mg/dL · {shownHours} h observed · {forecast?.forecast?.horizon_min ?? 120}-min forecast</span>
        <div className="chart-window" role="group" aria-label="Observed history window">{(compactWindow ? [1, 6] : [2, 6]).map(hours => <button key={hours} aria-pressed={shownHours === hours} disabled={!forecast} onClick={() => { setHistoryHours(hours === 1 ? 2 : hours); setSelection(null); }}>Past {hours}h</button>)}</div>
      </div>
      <div ref={plotRef} className="forecast-plot" onPointerLeave={() => {
        pointerDismissed.current = false;
        if (!keyboardFocused.current) setSelection(null);
      }}>
        {!forecast && unreachable ? (
          <div className="chart-empty chart-unreachable" data-testid="chart-unreachable"><strong>No data received</strong><span>The subject stream cannot be reached. Nothing is drawn until real readings arrive; no values are substituted.</span></div>
        ) : !forecast ? (
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
            <desc id={chartId + '-description'}>Observed CGM readings as dots and a 120-minute forecast: the median line with 50, 80 and 90% bands, the physiology twin as a dashed line, and the learned adjustment as the hatched wedge between them. Arrow keys inspect received observations and forecast points. Home selects the earliest point; End selects the latest. Escape dismisses details. All times UTC. The vertical scale expands to include displayed values.</desc>
            <HatchDefs id={chartId + '-hatch'} />
            <defs><clipPath id={chartId + '-clip'}><rect x={margin.left} y={margin.top} width={right - margin.left} height={bottom - margin.top} /></clipPath></defs>
            <rect x={x(anchor)} y={margin.top} width={right - x(anchor)} height={bottom - margin.top} className="fig-future" />
            {yTicks.map(tick => <g key={tick}>
              <line x1={margin.left} x2={right} y1={y(tick)} y2={y(tick)} className="fig-grid" />
              <text x={margin.left - 9} y={y(tick) + 4} textAnchor="end" className="chart-axis">{tick}</text>
            </g>)}
            {/* The 180 mg/dL level is a reference line, labelled on the line itself rather than as an axis tick. */}
            <Threshold x0={margin.left} x1={right} y={y} label={narrow ? '180 mg/dL' : '180 mg/dL level'} />
            {xTicks.map(m => <text key={m} x={xm(m)} y={bottom + 22} textAnchor={xm(m) < margin.left + 20 ? 'start' : xm(m) > right - 20 ? 'end' : 'middle'} className={m === 0 ? 'chart-axis fig-axis-now' : 'chart-axis'}>{tickLabel(m)}</text>)}
            <text x={margin.left - 9} y={margin.top - 12} textAnchor="end" className="chart-axis">mg/dL</text>
            <g clipPath={'url(#' + chartId + '-clip)'}>
              <g className="forecast-layer" opacity={mappedScenario.length ? 0.5 : 1}>
                <Bands pts={fig} x={xm} y={y} />
                {hasPhysics && <Wedge pts={fig} x={xm} y={y} hatch={chartId + '-hatch'} />}
                {hasPhysics && <TwinLine pts={fig} x={xm} y={y} />}
                <MedianLine pts={fig} x={xm} y={y} className="fig-median forecast-median-draw" />
              </g>
              {!!mappedScenario.length && <g className="scenario-layer"><path d={median(mappedScenario) ?? ''} fill="none" stroke="var(--color-projection)" strokeWidth={2} strokeDasharray="2 3" /></g>}
              <ObservedDots obs={obs} x={xm} y={y} r={shownHours > 2 || narrow ? 1.9 : 2.5} />
              {current != null && <circle data-testid="current-observation" cx={x(anchor)} cy={y(current)} r={4.5} className="fig-current" />}
              {selected && <g pointerEvents="none"><line x1={x(selected.time)} x2={x(selected.time)} y1={margin.top} y2={bottom} className="fig-scrub" />{selected.kind === 'observed' && <circle cx={x(selected.time)} cy={y(selected.value)} r={5} className="fig-select-ring" />}</g>}
            </g>
            <line x1={x(anchor)} x2={x(anchor)} y1={margin.top - 8} y2={bottom} className="fig-now" />
            <text x={x(anchor) - 6} y={margin.top - 12} textAnchor="end" className="fig-era">observed</text>
            <text x={x(anchor) + 6} y={margin.top - 12} className="fig-era">forecast</text>
            {peak != null && peakOffset != null && <circle cx={xm(peakOffset)} cy={y(peak)} r={6} data-testid="forecast-peak-marker" className={'fig-peak' + (isWarning ? ' warning' : '')}><title>{`Highest forecast median: ${peak} mg/dL at +${peakOffset} min`}</title></circle>}
            {markerPoint && <Decomposition m={markerPoint.offset_min} twin={markerPoint.twin_p50} p50={markerPoint.p50} x={xm} y={y} compact={narrow} />}
            {!mapped.length && <text x={(margin.left + right) / 2} y={(margin.top + bottom) / 2} textAnchor="middle" className="chart-axis">Prediction unavailable; observed values only</text>}
          </svg>)}
        {selected && <div id={chartId + '-tooltip'} role="tooltip" className="chart-tooltip"
          style={{ left: x(selected.time) > (margin.left + right) / 2 ? Math.max(margin.left, x(selected.time) - 232) : Math.min(right - 220, x(selected.time) + 14), top: Math.max(margin.top, Math.min(bottom - 150, y(selected.value) - 70)) }}>
          <strong>{selected.kind === 'observed' ? 'Observed CGM' : `Forecast · +${selected.point?.offset_min} min`}</strong>
          <time dateTime={selectedTimestamp} title={selectedTimestamp}>{formatTime(selectedTimestamp)} UTC</time>
          <dl>
            <div><dt>{selected.kind === 'observed' ? 'Measured glucose' : 'Median (P50)'}</dt><dd>{selected.value} mg/dL</dd></div>
            {selected.point && <>
              <div><dt>P10–P90</dt><dd>{interval(selected.point.p10, selected.point.p90)}</dd></div>
              <div><dt>P05–P95</dt><dd>{interval(selected.point.p05, selected.point.p95)}</dd></div>
              {typeof selected.point.twin_p50 === 'number' && <div><dt>Physiology twin</dt><dd>{quantile(selected.point.twin_p50)} mg/dL</dd></div>}
            </>}
          </dl>
          <span className="tooltip-hint">Arrow keys to inspect · Esc to dismiss</span>
        </div>}
      </div>
      {forecast && hasAnchor && mapped.length > 0 && <svg width={size.width} height={40} viewBox={`0 0 ${size.width} 40`} aria-hidden="true" className="above-strip">
        <AboveBars pts={fig.slice(1)} x={xm} x0={x(anchor)} x1={right} top={1} row={12} labels={false} />
        {(narrow ? ['High case >180', 'Median >180', 'Low case >180'] : ['High case (P90) above 180', 'Median above 180', 'Low case (P10) above 180']).map((l, i) => <text key={l} x={x(anchor) - 8} y={1 + i * 12 + 9.5} textAnchor="end" className="fig-above-label">{l}</text>)}
      </svg>}
      <div className="chart-legend fig-legend" role="group" aria-label="Chart legend">
        <span><Glyph kind="obs" /><span className="lg-long">Observed CGM, one dot per reading</span><span className="lg-short" aria-hidden="true">Observed</span></span>
        <span><Glyph kind="median" /><span className="lg-long">Forecast median</span><span className="lg-short" aria-hidden="true">Median</span></span>
        <span><Glyph kind="bands" /><span className="lg-long">50 · 80 · 90% bands (P25–75 · P10–90 · P05–95)</span><span className="lg-short" aria-hidden="true">50·80·90% bands</span></span>
        {hasPhysics && <span><Glyph kind="twin" /><span className="lg-long">Physiology twin</span><span className="lg-short" aria-hidden="true">Twin</span></span>}
        {hasPhysics && <span><Glyph kind="wedge" />Learned adjustment</span>}
        <span><i className="legend-peak fig-glyph" aria-hidden="true" /><span className="lg-long">Forecast peak (median)</span><span className="lg-short" aria-hidden="true">Median peak</span></span>
        <span><Glyph kind="threshold" /><span className="lg-long">180 mg/dL level</span><span className="lg-short" aria-hidden="true">180 mg/dL level</span></span>
      </div>

      <div className="chart-readout">
        <span aria-hidden="true">{isStale ? 'Stale stream · ' : ''}{history.length} received CGM observations · times in UTC · point at, tap or focus the chart to inspect points</span>
        <span className="sr-only" aria-live={selection?.source === 'keyboard' ? 'polite' : 'off'} aria-atomic="true">
          {selected && (selected.point
            ? `${formatTime(selectedTimestamp)} UTC · Median ${selected.value} mg/dL · P10–P90 ${quantile(selected.point.p10)}–${quantile(selected.point.p90)} mg/dL · P05–P95 ${quantile(selected.point.p05)}–${quantile(selected.point.p95)} mg/dL · +${selected.point.offset_min} min of ${forecast?.forecast?.horizon_min ?? 'unavailable'} min forecast horizon`
            : `${formatTime(selectedTimestamp)} UTC · Observed CGM ${selected.value} mg/dL`)}
        </span>
      </div>

      {isolatedStep && isolatedStep.size > ISOLATED_STEP_NOTE_MG_DL && <p className="isolated-step-note" data-testid="isolated-step-note">
        The forecast median jumps by {isolatedStep.size.toFixed(0)} mg/dL in a single 5-min step at +{isolatedStep.offset} min. Isolated steps like this come from the learned adjustment, not from the physiology twin, and are a known limitation of this model; read the band and the twin line, not that single point.
      </p>}

      <InputLanes wearables={cache?.wearables ?? []} x={x} start={start} anchor={anchor} width={size.width} left={margin.left} right={right} />

      {!!mappedScenario.length && <p className="fine-print">Existing scenario overlay · projection under model assumptions, not validated human causal effects.</p>}
    </div>
  );
}

type Lane = { key: string; label: string; unit: string; latest: string; render: () => React.ReactNode };

/** Wearable and log readings the network consumed, on the chart's own time axis (history only). */
function InputLanes({ wearables, x: chartX, start, anchor, width, left: chartLeft, right }: {
  wearables: WearableView[]; x: d3Scale.ScaleTime<number, number>; start: number; anchor: number; width: number; left: number; right: number;
}) {
  // On phones the lanes get the full width for the observed window (labels sit above each strip);
  // on wider screens they share the chart's own time axis.
  const phone = width < 520;
  const left = phone ? 2 : chartLeft;
  const x = phone ? d3Scale.scaleUtc().domain([start, anchor]).range([left, width - 70]) : chartX;
  const rows = wearables.map(w => ({ ...w, time: Date.parse(w.t) }))
    .filter(w => Number.isFinite(w.time) && w.time >= start && w.time <= anchor)
    .sort((a, b) => a.time - b.time);
  if (!Number.isFinite(anchor) || rows.length < 2) return null;
  const h = 24;
  const step = Math.max(1.5, (x(rows[1].time) - x(rows[0].time)) * 0.8);
  const last = rows[rows.length - 1];
  const series = (pick: (w: (typeof rows)[number]) => number | null) => {
    const values = rows.map(pick).filter((v): v is number => v != null && Number.isFinite(v));
    if (!values.length) return null;
    const lo = Math.min(...values), hi = Math.max(...values);
    const y = d3Scale.scaleLinear().domain(lo === hi ? [lo - 1, hi + 1] : [lo, hi]).range([h - 3, 3]);
    const path = d3Shape.line<(typeof rows)[number]>().defined(w => pick(w) != null).x(w => x(w.time)).y(w => y(pick(w)!))(rows);
    return { path, lo, hi };
  };
  const hr = series(w => w.heartRate);
  const hrv = series(w => w.hrv);
  const maxSteps = Math.max(50, ...rows.map(w => w.steps));
  const fmt = (v: number | null, d = 0) => (v == null ? '—' : v.toFixed(d));
  // Bars and bands stay inside the observed window [axis start, forecast anchor].
  const clampRect = (cx: number, w: number) => {
    const x0 = Math.max(left, cx - w / 2), x1 = Math.min(x(anchor) - 1, cx + w / 2);
    return { x: x0, width: Math.max(0, x1 - x0) };
  };
  const meals = rows.filter(w => w.carbs > 0);
  const anySteps = rows.some(w => w.steps > 0);
  const anyAsleep = rows.some(w => w.asleep);
  const narrow = width < 520;
  const empty = (text: string) => <text x={(left + x(anchor)) / 2} y={h / 2 + 4} textAnchor="middle" className="lane-empty">{text}</text>;
  const lanes: Lane[] = [
    { key: 'meals', label: 'Meal log', unit: 'g carbohydrate', latest: meals.length ? `${Math.round(meals[meals.length - 1].carbs)} g · ${formatTime(meals[meals.length - 1].time)}` : 'none logged',
      render: () => meals.length ? meals.map(w => <g key={w.t}>
        <rect x={x(w.time) - 2} y={3} width={4} height={h - 6} className="lane-meal" />
        <text x={x(w.time) - 7} y={h / 2 + 4} textAnchor="end" className="lane-text">{Math.round(w.carbs)} g</text>
      </g>) : empty('No meals logged in this window') },
    { key: 'steps', label: 'Steps', unit: 'per 5 min', latest: fmt(last.steps),
      render: () => anySteps ? rows.filter(w => w.steps > 0).map(w => {
        const r = clampRect(x(w.time), step);
        const bh = Math.max(6, (w.steps / maxSteps) * (h - 4));
        return <rect key={w.t} x={r.x} width={Math.max(2, r.width)} y={h - bh} height={bh} rx={1} className="lane-steps" />;
      }).concat(!narrow && rows.filter(w => w.steps > 0).length <= 3 ? (() => {
        // A near-sedentary window: say so beside the few bars rather than far from them.
        const xs = rows.filter(w => w.steps > 0).map(w => x(w.time));
        const first = Math.min(...xs), lastX = Math.max(...xs) + step;
        const total = Math.round(rows.reduce((t, w) => t + w.steps, 0));
        const before = first - left > 200;
        return [<text key="few" x={before ? first - 8 : lastX + 8} y={h / 2 + 4} textAnchor={before ? 'end' : 'start'} className="lane-empty">{`${total} steps in this window`}</text>];
      })() : []) : empty('0 steps recorded in this window') },
    { key: 'hr', label: 'Heart rate', unit: 'bpm', latest: fmt(last.heartRate),
      render: () => hr ? <path d={hr.path ?? ''} className="lane-line" /> : empty('No heart-rate readings received') },
    { key: 'hrv', label: narrow ? 'HRV' : 'HRV (RMSSD)', unit: 'ms', latest: fmt(last.hrv),
      render: () => hrv ? <path d={hrv.path ?? ''} className="lane-line" /> : empty('No HRV readings received') },
    { key: 'sleep', label: 'Sleep', unit: 'asleep / awake', latest: last.asleep ? 'Asleep' : 'Awake',
      render: () => anyAsleep ? rows.filter(w => w.asleep).map(w => {
        const r = clampRect(x(w.time), step * 1.25);
        return <rect key={w.t} x={r.x} width={r.width} y={5} height={h - 10} className="lane-sleep" />;
      }).concat([<text key="asleep" x={Math.max(left, x(rows.find(w => w.asleep)!.time)) + 6} y={h / 2 + 4} className="lane-in">asleep</text>]) : empty('Awake throughout this window') },
  ];
  return (
    <section className="input-lanes" aria-label="Wearable and log inputs the model used" data-testid="input-lanes">
      <div className="input-lanes-heading lanes-head">
        <span>Wearable and log inputs the model read</span>
        <span className="fine-print">{phone ? 'Observed only · the window shown in the chart · ends at now' : 'Observed only · same time axis as the chart · nothing is observed after now'}</span>
      </div>
      {lanes.map(lane => (
        <div key={lane.key} className="input-lane" data-testid={`lane-${lane.key}`}>
          <svg width={width} height={h} viewBox={`0 0 ${width} ${h}`} aria-hidden="true">
            <line x1={left} x2={x(anchor)} y1={h - 0.5} y2={h - 0.5} className="lane-base" />
            {lane.render()}
            <line x1={x(anchor)} x2={x(anchor)} y1={0} y2={h} className="fig-now" />
          </svg>
          <div className="input-lane-label" style={{ width: Math.max(40, left - 10) }}><strong>{lane.label}</strong></div>
          <span className="input-lane-latest" style={phone ? undefined : { left: x(anchor) + 8 }}>{lane.latest} {lane.key === 'meals' || lane.key === 'sleep' ? '' : lane.unit}</span>
        </div>
      ))}
      <p className="sr-only">{`Latest readings: heart rate ${fmt(last.heartRate)} bpm, HRV ${fmt(last.hrv)} ms, ${fmt(last.steps)} steps in the last 5 minutes, ${last.asleep ? 'asleep' : 'awake'}.`}</p>
    </section>
  );
}
