import React, { useRef, useState, useEffect } from 'react';
import * as d3Scale from 'd3-scale';
import * as d3Shape from 'd3-shape';
import { useTime } from './TimeContext';
import { formatDateTime, formatDate } from '@/lib/formatters/date';

import { SubjectStore } from "@/lib/types";

export function TimeScrubber({ cache, asOf }: { cache: SubjectStore; asOf?: string }) {
  const { asOf: contextAsOf, setAsOf } = useTime();
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 800, height: 96 });

  useEffect(() => {
    if (!containerRef.current) return;
    const obs = new ResizeObserver(entries => {
      if (!entries[0]) return;
      const { width, height } = entries[0].contentRect;
      if (width > 0 && height > 0) setSize({ width, height });
    });
    obs.observe(containerRef.current);
    return () => obs.disconnect();
  }, []);

  const { width, height } = size;
  const margin = { top: 12, right: 96, bottom: 20, left: 40 };

  // P0-5: Remove 2024 Fallback Anchor
  // If asOf is unavailable, we don't fabricate a timestamp.
  const anchorTime = asOf ? new Date(asOf).getTime() : null;
  const start = anchorTime ? anchorTime - 14 * 24 * 3600000 : 0;
  const end   = anchorTime ? anchorTime : 0;

  const xScale = d3Scale.scaleUtc()
    .domain([start, end])
    .range([margin.left, Math.max(margin.left, width - margin.right)]);

  const yScale = d3Scale.scaleLinear()
    .domain([40, 320])
    .range([height - margin.bottom, margin.top]);

  const historical = cache?.cgm || [];
  const alerts = cache?.alerts || [];
  const onsets = cache?.onsets || [];

  const lineHistorical = d3Shape.line<any>()
    .x(d => xScale(new Date(d.t).getTime()))
    .y(d => yScale(d.value))
    .defined(d => d.value != null)
    .curve(d3Shape.curveLinear);

  const activeTime = contextAsOf ? new Date(contextAsOf).getTime() : anchorTime;

  const handleScrub = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!anchorTime || !containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    if (x < margin.left || x > width - margin.right) return;
    const t = xScale.invert(x).getTime();
    setAsOf(new Date(t).toISOString());
  };

  const handleKeyDown = (e: React.KeyboardEvent<SVGSVGElement>) => {
    // P0-9: Shortcut Safety - Gate single-key shortcuts if focus is in input/textarea
    const activeEl = document.activeElement;
    if (activeEl) {
      const tag = activeEl.tagName.toUpperCase();
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (activeEl as HTMLElement).isContentEditable) {
         return;
      }
    }

    if (!anchorTime || !activeTime) return;

    const stepMin = 5 * 60000;
    const stepHour = 3600000;
    
    let handled = true;
    if (e.key === 'ArrowLeft') {
      const step = e.shiftKey ? stepHour : stepMin;
      setAsOf(new Date(Math.max(start, activeTime - step)).toISOString());
    } else if (e.key === 'ArrowRight') {
      const step = e.shiftKey ? stepHour : stepMin;
      setAsOf(new Date(Math.min(end, activeTime + step)).toISOString());
    } else if (e.key === 'l' || e.key === 'L') {
      setAsOf(new Date(anchorTime).toISOString());
    } else if (e.key === '[') {
      const prev = alerts.slice().reverse().find((a: {t: string, state: string}) => new Date(a.t).getTime() < activeTime);
      if (prev) setAsOf(prev.t);
    } else if (e.key === ']') {
      const next = alerts.find((a: {t: string, state: string}) => new Date(a.t).getTime() > activeTime);
      if (next) setAsOf(next.t);
    } else if (e.key === ',') {
      const prev = onsets.slice().reverse().find((o: {t: string}) => new Date(o.t).getTime() < activeTime);
      if (prev) setAsOf(prev.t);
    } else if (e.key === '.') {
      const next = onsets.find((o: {t: string}) => new Date(o.t).getTime() > activeTime);
      if (next) setAsOf(next.t);
    } else if (e.key === ' ') {
       // Space play/pause placeholder
    } else {
      handled = false;
    }
    
    if (handled) {
      e.preventDefault();
    }
  };

  if (!anchorTime) {
    return (
      <div className="w-full h-full flex items-center justify-center text-ink-3 bg-surface italic text-[12px]">
        Timeline unavailable
      </div>
    );
  }

  const accessibleTimeLabel = formatDateTime(activeTime!);
  const xTicks = xScale.ticks(14); 

  return (
    <div ref={containerRef} className="w-full h-full flex flex-col items-center justify-center text-ink bg-surface overflow-hidden relative">
      <svg
        className="w-full h-full cursor-pointer focus:outline-none focus:ring-1 focus:ring-inset focus:ring-line-control"
        onClick={handleScrub}
        onKeyDown={handleKeyDown}
        tabIndex={0}
        role="slider"
        aria-valuemin={start}
        aria-valuemax={end}
        aria-valuenow={activeTime}
        aria-valuetext={accessibleTimeLabel}
        aria-label="14-Day Timeline Scrubber"
      >
        <rect
          x={margin.left}
          y={margin.top}
          width={Math.max(0, width - margin.right - margin.left)}
          height={Math.max(0, height - margin.top - margin.bottom)}
          fill="var(--color-surface-2)"
        />
        
        {/* Day separators */}
        {xTicks.map(tick => (
           <g key={tick.getTime()}>
             <line x1={xScale(tick)} x2={xScale(tick)} y1={margin.top} y2={height - margin.bottom} stroke="var(--color-line)" strokeDasharray="2 2" />
             <text x={xScale(tick)} y={height - margin.bottom + 12} textAnchor="middle" className="text-[10px] fill-ink-3 tabular-nums">
               {formatDate(tick.getTime()).split(' ')[0]}
             </text>
           </g>
        ))}

        {/* CGM Path */}
        {historical.length > 0 && (
          <path d={lineHistorical(historical) || ''} fill="none" stroke="var(--color-ink-3)" strokeWidth={1} />
        )}

        {/* Detail Window Brush */}
        {activeTime && (
           <rect 
             x={xScale(activeTime - 6 * 3600000)}
             y={margin.top}
             width={Math.max(0, xScale(activeTime + 2 * 3600000) - xScale(activeTime - 6 * 3600000))}
             height={Math.max(0, height - margin.top - margin.bottom)}
             fill="var(--color-ink)"
             opacity={0.05}
             className="pointer-events-none"
           />
        )}

        {/* Playhead */}
        {activeTime && (
          <line
            x1={xScale(activeTime)} x2={xScale(activeTime)}
            y1={margin.top - 4} y2={height - margin.bottom + 4}
            stroke="var(--color-ink)" strokeWidth={1.5}
          />
        )}
        
        {/* Alert markers */}
        {alerts.map((a: {t: string, state: string}, i: number) => {
          const cx = xScale(new Date(a.t).getTime());
          if (cx < margin.left || cx > width - margin.right) return null;
          return (
            <polygon
              key={i}
              points={`${cx-4},${height-margin.bottom} ${cx+4},${height-margin.bottom} ${cx},${height-margin.bottom-6}`}
              fill="var(--color-amber)"
            />
          );
        })}
      </svg>
    </div>
  );
}
