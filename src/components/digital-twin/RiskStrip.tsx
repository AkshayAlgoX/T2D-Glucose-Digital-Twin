import React, { useMemo } from 'react';
import { scaleLinear } from 'd3-scale';

export function RiskStrip({ forecast }: any) {
  const cumulative = forecast?.spike_risk?.cumulative || [];
  
  const blocks = useMemo(() => {
    if (!cumulative.length) return [];
    
    // Create a color scale for probability: 0 to 1
    const colorScale = scaleLinear<string>()
      .domain([0, 0.35, 0.6, 1.0])
      .range(['transparent', 'rgba(217, 119, 6, 0.2)', 'rgba(217, 119, 6, 0.6)', 'rgba(217, 119, 6, 0.9)']);
      
    return cumulative.map((pt: any) => ({
      offset: pt.offset_min,
      p: pt.p,
      color: colorScale(pt.p)
    }));
  }, [cumulative]);

  if (!blocks.length) {
    return (
      <div className="h-full px-4 flex items-center justify-between">
         <span className="text-ink-2">Cumulative Risk</span>
         <span className="text-ink-3">Not available</span>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col justify-center px-4">
      <div className="flex justify-between items-center mb-1">
         <span className="text-ink-2 text-xs font-medium">Cumulative Risk (120m)</span>
         <span className="text-ink-3 text-xs">{(blocks[blocks.length - 1].p * 100).toFixed(0)}%</span>
      </div>
      <div className="flex w-full h-4 bg-surface-2 rounded-sm overflow-hidden">
        {blocks.map((b: any) => (
           <div 
             key={b.offset} 
             style={{ backgroundColor: b.color, flex: 1 }} 
             title={`+${b.offset}m: ${(b.p * 100).toFixed(1)}%`}
           />
        ))}
      </div>
    </div>
  );
}
