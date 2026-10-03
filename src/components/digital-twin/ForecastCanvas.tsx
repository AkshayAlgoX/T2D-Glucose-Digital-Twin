import React, { useRef } from 'react';
import * as d3Scale from 'd3-scale';
import * as d3Shape from 'd3-shape';

export function ForecastCanvas({ forecast, cache, isStale }: any) {
  const svgRef = useRef<SVGSVGElement>(null);
  
  const isInsufficient = forecast?.data_quality?.status === 'insufficient' || !forecast;
  
  if (isInsufficient) {
    return (
      <div className="w-full h-full flex items-center justify-center relative bg-[url('data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI4IiBoZWlnaHQ9IjgiPgoJPHBhdGggZD0iTTAgOEw4IDBaIiBzdHJva2U9IiNlNWU3ZWIiIHN0cm9rZS13aWR0aD0iMSIvPgo8L3N2Zz4=')]">
        <div className="bg-surface px-4 py-2 text-ink-2 font-medium z-10 border border-line rounded-[6px]">
          No forecast &middot; {forecast?.data_quality?.status || 'Waiting for data'}
        </div>
      </div>
    );
  }

  // Dimensions
  const width = 800; // SVG viewBox width
  const height = 360;
  const margin = { top: 20, right: 20, bottom: 20, left: 40 };

  // Data processing
  const now = new Date(forecast?.as_of || Date.now()).getTime();
  const start = now - 6 * 60 * 60 * 1000; // -6 hours
  const end = now + 2 * 60 * 60 * 1000;   // +2 hours

  const historical = cache?.cgm || [];
  const forecastPoints = forecast?.scenarios?.[0]?.points || forecast?.points || [];
  
  const mappedForecast = forecastPoints.map((p: any) => ({
    t: now + p.offset_min * 60 * 1000,
    p10: p.p10,
    p50: p.p50,
    p90: p.p90,
    twin_p50: p.twin_p50
  }));

  // Scales
  const xScale = d3Scale.scaleTime()
    .domain([start, end])
    .range([margin.left, width - margin.right]);

  const yScale = d3Scale.scaleLinear()
    .domain([40, 320])
    .range([height - margin.bottom, margin.top]);

  // Generators
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
    .curve(d3Shape.curveStepAfter);

  return (
    <div className={`w-full h-full relative ${isStale ? 'opacity-40' : 'opacity-100'} transition-opacity motion-safe:duration-320 motion-reduce:duration-75`}>
      {/* Readout row above the plot per spec F7 */}
      <div className="absolute top-2 left-10 flex gap-4 text-xs tabular-nums text-ink-2 pointer-events-none">
         <span>80% interval &middot; conformal, calibrated on validation patients</span>
      </div>

      <svg ref={svgRef} className="w-full h-full block" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
        
        {/* Background tints */}
        <rect x={xScale(now)} y={margin.top} width={width - margin.right - xScale(now)} height={height - margin.top - margin.bottom} fill="var(--color-forecast)" opacity={0.05} />
        
        {/* Y Axis hairlines */}
        <line x1={margin.left} x2={width - margin.right} y1={yScale(70)} y2={yScale(70)} stroke="var(--color-line)" strokeDasharray="4 4" />
        <line x1={margin.left} x2={width - margin.right} y1={yScale(180)} y2={yScale(180)} stroke="var(--color-line)" strokeDasharray="4 4" />
        <text x={width - margin.right} y={yScale(180) - 4} textAnchor="end" className="text-[10px] fill-ink-3">180 &middot; spike level</text>

        {/* Forecast Band */}
        {mappedForecast.length > 0 && (
          <>
            <path d={areaGenerator(mappedForecast) || ''} fill="var(--color-forecast)" opacity={0.15} />
            <path d={lineTwin(mappedForecast) || ''} fill="none" stroke="var(--color-physics)" strokeWidth={1.5} strokeDasharray="4 2" />
            <path d={lineP50(mappedForecast) || ''} fill="none" stroke="var(--color-forecast)" strokeWidth={2} />
          </>
        )}

        {/* Historical Line */}
        {historical.length > 0 && (
          <path d={lineHistorical(historical) || ''} fill="none" stroke="var(--color-ink)" strokeWidth={1.5} />
        )}

        {/* Now Rule */}
        <line x1={xScale(now)} x2={xScale(now)} y1={margin.top} y2={height - margin.bottom} stroke="var(--color-ink-2)" strokeWidth={1} />
        <circle cx={xScale(now)} cy={yScale(historical[historical.length - 1]?.value || 100)} r={4} fill="var(--color-ink)" />

        {/* Peak Marker */}
        {forecast?.spike_risk?.time_to_peak_min != null && (
          <circle 
            cx={xScale(now + forecast.spike_risk.time_to_peak_min * 60000)} 
            cy={yScale(forecast.spike_risk.peak_mg_dl?.p50 || 0)} 
            r={3} 
            fill="var(--color-danger)" 
          />
        )}
      </svg>
      <div className="sr-only">Forecast canvas showing glucose ranging from 40 to 320 mg/dL over a 8 hour window.</div>
    </div>
  );
}
