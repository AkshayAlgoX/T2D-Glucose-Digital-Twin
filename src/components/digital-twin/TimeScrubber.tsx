import React, { useRef, useEffect } from 'react';
import * as d3Scale from 'd3-scale';
import * as d3Shape from 'd3-shape';
import { useTime } from './TimeContext';

export function TimeScrubber({ cache, asOf }: any) {
  const { asOf: contextAsOf, setAsOf } = useTime();
  const svgRef = useRef<SVGSVGElement>(null);
  
  // Base timeline on last 24h of cache
  const width = 800;
  const height = 64;
  const margin = { top: 10, right: 20, bottom: 20, left: 40 };

  const now = Date.now();
  const start = now - 24 * 60 * 60 * 1000;
  const end = now;

  const xScale = d3Scale.scaleTime()
    .domain([start, end])
    .range([margin.left, width - margin.right]);
    
  const yScale = d3Scale.scaleLinear()
    .domain([40, 320])
    .range([height - margin.bottom, margin.top]);

  const historical = cache?.cgm || [];
  
  const lineHistorical = d3Shape.line<any>()
    .x(d => xScale(new Date(d.t).getTime()))
    .y(d => yScale(d.value))
    .defined(d => d.value != null)
    .curve(d3Shape.curveStepAfter);

  const activeTime = contextAsOf ? new Date(contextAsOf).getTime() : now;

  const handleScrub = (e: React.MouseEvent<SVGSVGElement>) => {
     if (!svgRef.current) return;
     const rect = svgRef.current.getBoundingClientRect();
     const x = e.clientX - rect.left;
     if (x < margin.left || x > width - margin.right) return;
     const t = xScale.invert(x).getTime();
     setAsOf(new Date(t).toISOString());
  };

  return (
    <div className="w-full h-full p-4 flex flex-col items-center justify-center text-ink bg-surface">
      <svg ref={svgRef} className="w-full h-full cursor-pointer" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" onClick={handleScrub} role="slider" aria-valuemin={start} aria-valuemax={end} aria-valuenow={activeTime} aria-label="Timeline Scrubber">
        {/* Background track */}
        <rect x={margin.left} y={margin.top} width={width - margin.right - margin.left} height={height - margin.top - margin.bottom} fill="var(--color-surface-2)" />
        
        {/* CGM Path */}
        {historical.length > 0 && (
          <path d={lineHistorical(historical) || ''} fill="none" stroke="var(--color-ink-3)" strokeWidth={1} />
        )}
        
        {/* Playhead */}
        <line x1={xScale(activeTime)} x2={xScale(activeTime)} y1={margin.top} y2={height - margin.bottom} stroke="var(--color-ink)" strokeWidth={2} />
        <polygon points={`${xScale(activeTime)-4},${margin.top} ${xScale(activeTime)+4},${margin.top} ${xScale(activeTime)},${margin.top+4}`} fill="var(--color-ink)" />

        {/* Alerts */}
        {cache?.alerts?.map((a: any, i: number) => {
           const cx = xScale(new Date(a.t).getTime());
           if (cx < margin.left || cx > width - margin.right) return null;
           return <polygon key={i} points={`${cx-3},${height-margin.bottom} ${cx+3},${height-margin.bottom} ${cx},${height-margin.bottom-5}`} fill="var(--color-amber)" />;
        })}
      </svg>
      <div className="sr-only">Timeline slider. Press left/right to scrub. Current time: {new Date(activeTime).toLocaleString()}</div>
    </div>
  );
}
