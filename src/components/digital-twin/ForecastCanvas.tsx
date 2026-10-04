import React, { useRef, useState, useEffect } from 'react';
import * as d3Scale from 'd3-scale';
import * as d3Shape from 'd3-shape';
import { formatTime } from '@/lib/formatters/date';

import { ForecastResponse } from "@/types/forecast-response";
import { SubjectStore } from "@/lib/types";

export function ForecastCanvas({ forecast, cache, isStale }: { forecast: ForecastResponse | null; cache: SubjectStore; isStale: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 800, height: 360 });
  const [hoverX, setHoverX] = useState<number | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const obs = new ResizeObserver(entries => {
      if (!entries[0]) return;
      const { width, height } = entries[0].contentRect;
      if (width > 0 && height > 0) {
        setSize({ width, height });
      }
    });
    obs.observe(containerRef.current);
    return () => obs.disconnect();
  }, []);

  const { width, height } = size;
  const margin = { top: 32, right: 96, bottom: 24, left: 40 }; 

  const asOfDate = forecast?.as_of ? new Date(forecast.as_of).getTime() : null;
  
  if (!asOfDate) {
    return (
      <div className="w-full h-full flex items-center justify-center text-ink-3 bg-surface italic text-[12px]">
        Forecast unavailable
      </div>
    );
  }

  const anchorTime = asOfDate;
  const start = anchorTime - 6 * 3600000; 
  const end = anchorTime + 2 * 3600000;   

  const historical = cache?.cgm || [];
  
  const scenarioPoints = forecast?.scenarios?.[0]?.points || [];
  const hasScenario = scenarioPoints.length > 0;
  const forecastPoints = forecast?.forecast?.points || [];
  
  const mappedForecast = forecastPoints.map((p: { offset_min: number; p10: number; p50: number; p90: number; twin_p50?: number }) => ({
    t: anchorTime + p.offset_min * 60000,
    p10: p.p10,
    p50: p.p50,
    p90: p.p90,
    twin_p50: p.twin_p50
  }));

  const mappedScenario = scenarioPoints.map((p: { offset_min: number; p10: number; p50: number; p90: number; twin_p50?: number }) => ({
    t: anchorTime + p.offset_min * 60000,
    p10: p.p10,
    p50: p.p50,
    p90: p.p90
  }));

  const currentVal = forecast?.current?.value_mg_dl;
  if (currentVal != null && mappedForecast.length > 0) {
     mappedForecast.unshift({
       t: anchorTime,
       p10: currentVal, p50: currentVal, p90: currentVal, twin_p50: currentVal
     });
  }

  const xScale = d3Scale.scaleUtc()
    .domain([start, end])
    .range([margin.left, width - margin.right]);

  const yScale = d3Scale.scaleLinear()
    .domain([40, 320])
    .range([height - margin.bottom, margin.top]);

  const areaGenerator = d3Shape.area<any>()
    .x(d => xScale(d.t))
    .y0(d => yScale(d.p10))
    .y1(d => yScale(d.p90))
    .curve(d3Shape.curveMonotoneX);

  const lineP50 = d3Shape.line<any>()
    .x(d => xScale(d.t))
    .y(d => yScale(d.p50))
    .curve(d3Shape.curveMonotoneX);

  const lineTwin = d3Shape.line<any>()
    .x(d => xScale(d.t))
    .y(d => yScale(d.twin_p50))
    .defined(d => d.twin_p50 != null)
    .curve(d3Shape.curveMonotoneX);

  const lineHistorical = d3Shape.line<any>()
    .x(d => xScale(new Date(d.t).getTime()))
    .y(d => yScale(d.value))
    .defined(d => d.value != null)
    .curve(d3Shape.curveLinear); 

  const yTicks = [70, 100, 150, 180, 250, 300];
  const startHour = Math.floor(start / 3600000) * 3600000;
  const xTicksMajor = Array.from({length: 10}, (_, i) => startHour + i * 3600000);
  const xTicksMinor = Array.from({length: 10}, (_, i) => startHour + i * 3600000 + 1800000);

  const peak = forecast?.spike_risk?.peak_mg_dl?.p50;
  const tPeak = forecast?.spike_risk?.time_to_peak_min != null ? anchorTime + forecast.spike_risk.time_to_peak_min * 60000 : null;

  const handleMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    if (x < margin.left || x > width - margin.right) {
      setHoverX(null);
      return;
    }
    const t = xScale.invert(x).getTime();
    const snapped = Math.round(t / 300000) * 300000; 
    setHoverX(snapped);
  };

  return (
    <div ref={containerRef} className={`w-full h-full relative ${isStale ? 'opacity-40' : 'opacity-100'} transition-opacity bg-white`}>
      <svg 
        className="block" 
        width={width} height={height} 
        onMouseMove={handleMouseMove}
        onMouseLeave={() => setHoverX(null)}
      >
        <title>{`Glucose forecast chart: ${currentVal} mg/dL current, peak ${peak || 'unknown'} mg/dL`}</title>
        
        {/* Y Axis Grid & Labels */}
        {yTicks.map(tick => (
          <g key={`y-${tick}`}>
            <line 
              x1={margin.left} x2={width - margin.right} 
              y1={yScale(tick)} y2={yScale(tick)} 
              stroke={tick === 70 || tick === 180 ? 'var(--color-ink-3)' : 'var(--color-line)'} 
              strokeDasharray={tick === 70 || tick === 180 ? 'none' : '2 2'}
              strokeWidth={1}
            />
            <text x={margin.left - 8} y={yScale(tick) + 4} textAnchor="end" className="text-[12px] fill-ink-2 tabular-nums">
              {tick}
            </text>
            {tick === 180 && (
              <text x={margin.left + 4} y={yScale(180) - 4} className="text-[11px] fill-ink-3 font-medium">
                180 &middot; spike level
              </text>
            )}
          </g>
        ))}

        {/* X Axis Minor Grid */}
        {xTicksMinor.map(tick => {
          if (tick < start || tick > end) return null;
          return <line key={`xmin-${tick}`} x1={xScale(tick)} x2={xScale(tick)} y1={margin.top} y2={height - margin.bottom} stroke="var(--color-surface-2)" />;
        })}

        {/* X Axis Major Grid & Labels */}
        {xTicksMajor.map(tick => {
          if (tick < start || tick > end) return null;
          return (
            <g key={`xmax-${tick}`}>
              <line x1={xScale(tick)} x2={xScale(tick)} y1={margin.top} y2={height - margin.bottom} stroke="var(--color-line)" strokeDasharray="2 2" />
              <text x={xScale(tick)} y={height - margin.bottom + 16} textAnchor="middle" className="text-[12px] fill-ink-2 tabular-nums">
                {formatTime(tick)}
              </text>
            </g>
          );
        })}

        {/* Forecast Band (Baseline) */}
        {mappedForecast.length > 0 && (
          <g className="forecast-layer" opacity={hasScenario ? 0.5 : 1}>
            <path d={areaGenerator(mappedForecast) || ''} fill="var(--color-forecast)" opacity={0.15} />
            <path d={lineP50(mappedForecast) || ''} fill="none" stroke="var(--color-forecast)" strokeWidth={2} />
            <path d={lineTwin(mappedForecast) || ''} fill="none" stroke="var(--color-physics)" strokeWidth={1.5} strokeDasharray="4 4" />
          </g>
        )}

        {/* Forecast Band (What-If Overlay) */}
        {hasScenario && mappedScenario.length > 0 && (
          <g className="scenario-layer">
            <path d={lineP50(mappedScenario) || ''} fill="none" stroke="var(--color-forecast)" strokeWidth={2} strokeDasharray="2 2" />
          </g>
        )}

        {/* Historical Line */}
        {historical.length > 0 && (
          <path d={lineHistorical(historical) || ''} fill="none" stroke="var(--color-ink)" strokeWidth={1.5} />
        )}

        {/* Now Boundary */}
        <line x1={xScale(anchorTime)} x2={xScale(anchorTime)} y1={margin.top} y2={height - margin.bottom} stroke="var(--color-ink)" strokeWidth={1} />
        <rect x={xScale(anchorTime) - 30} y={margin.top - 16} width={60} height={16} fill="var(--color-ink)" rx={2} />
        <text x={xScale(anchorTime)} y={margin.top - 5} textAnchor="middle" className="text-[10px] fill-white font-medium">
           Now &middot; {formatTime(anchorTime)}
        </text>

        {/* Current Observation Marker */}
        <circle cx={xScale(anchorTime)} cy={yScale(currentVal || 100)} r={3.5} fill="var(--color-ink)" />

        {/* Peak Marker (Diamond) ALWAYS SHOWN if tPeak/peak exist */}
        {tPeak && peak && (
          <g transform={`translate(${xScale(tPeak)}, ${yScale(peak)})`}>
            <path d={d3Shape.symbol().type(d3Shape.symbolDiamond).size(60)()!} fill="var(--color-danger)" stroke="#fff" strokeWidth={1} />
            <text x={0} y={-8} textAnchor="middle" className="text-[11px] fill-danger font-bold tabular-nums">
              {Math.round(peak)}
            </text>
            <text x={0} y={16} textAnchor="middle" className="text-[10px] fill-danger font-medium tabular-nums">
              {formatTime(tPeak)}
            </text>
          </g>
        )}

        {/* Direct Labels */}
        {!hasScenario && mappedForecast.length > 0 && (
           <g transform={`translate(${width - margin.right + 6}, 0)`}>
              <text y={yScale(mappedForecast[mappedForecast.length-1].p50) + 4} className="text-[11px] fill-forecast font-medium">Forecast</text>
              {mappedForecast[mappedForecast.length-1].twin_p50 && (
                <text y={yScale(mappedForecast[mappedForecast.length-1].twin_p50) + 4} className="text-[11px] fill-physics font-medium">Physics</text>
              )}
           </g>
        )}
        
        {/* Crosshair */}
        {hoverX && hoverX >= start && hoverX <= end && (
          <g className="pointer-events-none">
            <line x1={xScale(hoverX)} x2={xScale(hoverX)} y1={margin.top} y2={height - margin.bottom} stroke="var(--color-ink-3)" strokeDasharray="2 2" />
            <rect x={xScale(hoverX) - 20} y={height - margin.bottom} width={40} height={16} fill="var(--color-ink-2)" rx={2} />
            <text x={xScale(hoverX)} y={height - margin.bottom + 11} textAnchor="middle" className="text-[10px] fill-white tabular-nums">
              {formatTime(hoverX)}
            </text>
          </g>
        )}
      </svg>
      {/* Fixed readout row for a11y */}
      <div className="sr-only">
         Current value: {currentVal} mg/dL. Peak: {peak} mg/dL at {tPeak ? formatTime(tPeak) : 'unknown'}.
      </div>
    </div>
  );
}
