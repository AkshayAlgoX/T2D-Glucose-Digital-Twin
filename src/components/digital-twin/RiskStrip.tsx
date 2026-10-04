import React, { useMemo, useRef, useState, useEffect } from 'react';
import * as d3Scale from 'd3-scale';
import * as d3Shape from 'd3-shape';
import { useTime } from './TimeContext';

import { ForecastResponse } from "@/types/forecast-response";
import { SubjectStore } from "@/lib/types";

export function RiskStrip({ forecast, cache }: { forecast: ForecastResponse | null; cache?: SubjectStore }) {
  const timeCtx = useTime();
  const contextAsOf = timeCtx?.asOf;
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 800 });

  useEffect(() => {
    if (!containerRef.current) return;
    const obs = new ResizeObserver(entries => {
      if (!entries[0]) return;
      const width = entries[0].contentRect.width;
      if (width > 0) setSize({ width });
    });
    obs.observe(containerRef.current);
    return () => obs.disconnect();
  }, []);

  const cumulative = forecast?.spike_risk?.cumulative || [];
  const riskHistory = cache?.risk_history || [];
  
  const baseAsOf = forecast?.as_of ? new Date(forecast.as_of).getTime() : 1704067200000;
  const anchorTime = contextAsOf ? new Date(contextAsOf).getTime() : baseAsOf;
  const start = anchorTime - 6 * 3600000;
  const end = anchorTime + 2 * 3600000;

  const margin = { left: 40, right: 96 };
  const width = size.width;

  const xScale = d3Scale.scaleUtc()
    .domain([start, end])
    .range([margin.left, Math.max(margin.left, width - margin.right)]);

  const yScale = d3Scale.scaleLinear().domain([0, 1]).range([40, 8]);

  const lineRisk = d3Shape.line<any>()
    .x(d => xScale(new Date(d.t).getTime()))
    .y(d => yScale(d.p))
    .curve(d3Shape.curveStepAfter);
    
  const areaRisk = d3Shape.area<any>()
    .x(d => xScale(new Date(d.t).getTime()))
    .y0(40)
    .y1(d => yScale(d.p))
    .curve(d3Shape.curveStepAfter);

  const forecastData = useMemo(() => {
    return cumulative.map((pt: { offset_min: number; p: number }) => ({
      t: anchorTime + pt.offset_min * 60000,
      p: pt.p
    }));
  }, [cumulative, anchorTime]);
  
  const historyData = useMemo(() => {
    return riskHistory.map((pt: { t: string; p: number; alert?: string; onset?: boolean }) => ({
      t: new Date(pt.t).getTime(),
      alert: pt.alert,
      onset: pt.alert === 'onset' || pt.onset,
      p: pt.p
    }));
  }, [riskHistory]);

  return (
    <div ref={containerRef} className="w-full h-full relative text-[12px]">
      <svg className="w-full h-full absolute inset-0">
        <defs>
          <pattern id="hatch-risk" width="4" height="4" patternTransform="rotate(45 0 0)" patternUnits="userSpaceOnUse">
            <line x1="0" y1="0" x2="0" y2="4" stroke="var(--color-line)" strokeWidth="1" />
          </pattern>
        </defs>

        {/* Labels Left */}
        <text x={8} y={24} className="fill-ink-2 font-medium" alignmentBaseline="middle">Risk</text>
        
        <g>
          {/* Missing History Hatch */}
          {!riskHistory.length && (
            <>
              <rect 
                x={xScale(start)} 
                y={8} 
                width={Math.max(0, xScale(anchorTime) - xScale(start))} 
                height={32} 
                fill="url(#hatch-risk)" 
              />
              <text 
                x={(xScale(start) + xScale(anchorTime)) / 2} 
                y={24} 
                className="fill-ink-3 italic" 
                textAnchor="middle" 
                alignmentBaseline="middle"
              >
                History not available
              </text>
            </>
          )}

          {/* 35% Threshold Line */}
          <line x1={xScale(start)} x2={xScale(end)} y1={yScale(0.35)} y2={yScale(0.35)} stroke="var(--color-ink-2)" strokeWidth="1" strokeDasharray="2 2" />

          {/* History Data */}
          {historyData.length > 0 && (
            <>
               <path d={areaRisk(historyData) || ''} fill="var(--color-amber)" fillOpacity={0.15} />
               <path d={lineRisk(historyData) || ''} fill="none" stroke="var(--color-amber)" strokeWidth={1.5} />
            </>
          )}

          {/* Forecast Data */}
          {forecastData.length > 0 && (
            <>
               <path d={areaRisk([{t: anchorTime, p: forecastData[0]?.p || 0}, ...forecastData]) || ''} fill="var(--color-amber)" fillOpacity={0.15} />
               <path d={lineRisk([{t: anchorTime, p: forecastData[0]?.p || 0}, ...forecastData]) || ''} fill="none" stroke="var(--color-amber)" strokeWidth={1.5} strokeDasharray="2 2" />
            </>
          )}

          {/* Alert Triangles from history */}
          {riskHistory.filter((r: any) => r.alert).map((r, i) => {
            const cx = xScale(new Date(r.t).getTime());
            return (
              <polygon 
                key={i}
                points={`${cx},8 ${cx - 4},0 ${cx + 4},0`}
                fill="var(--color-amber)"
              />
            );
          })}
          
          {/* Onset Ticks from history */}
          {riskHistory.filter((r: any) => r.onset).map((r, i) => {
            const cx = xScale(new Date(r.t).getTime());
            return (
              <line 
                key={i}
                x1={cx} x2={cx} y1={8} y2={0}
                stroke="var(--color-ink)" strokeWidth={1.5}
              />
            );
          })}
        </g>
        
        {/* Right Label */}
        {forecastData.length > 0 && (
          <text x={Math.max(margin.left, width - margin.right) + 16} y={24} className="fill-ink-3 font-medium" alignmentBaseline="middle">
             {(cumulative[cumulative.length - 1].p * 100).toFixed(0)}%
          </text>
        )}
      </svg>
    </div>
  );
}
