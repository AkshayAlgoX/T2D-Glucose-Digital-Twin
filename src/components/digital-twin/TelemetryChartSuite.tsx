'use client';

import React, { useMemo } from 'react';
import {
  ComposedChart,
  Line,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceArea,
  ReferenceLine,
  TooltipProps
} from 'recharts';
import { format, parseISO } from 'date-fns';

// -----------------------------------------------------------------------------
// Contracts & Interfaces
// -----------------------------------------------------------------------------

export interface TelemetryDataPoint {
  timestamp: string; // ISO-8601 string
  historicalGlucose: number | null; 
  forecastGlucose: number | null;
  quantileLower: number | null;
  quantileUpper: number | null;
  isSpikePredicted?: boolean;
}

export interface ForecastResponse {
  patientId: string;
  generatedAt: string;
  data: TelemetryDataPoint[];
}

export interface TelemetryChartSuiteProps {
  forecast: ForecastResponse;
  targetRangeMin?: number;
  targetRangeMax?: number;
  className?: string;
}

// -----------------------------------------------------------------------------
// Internal Sub-components
// -----------------------------------------------------------------------------

/**
 * Custom tooltip to cleanly render historical vs. forecast data 
 * along with the confidence interval bounds.
 */
const CustomTooltip = ({ active, payload, label }: TooltipProps<number, string>) => {
  if (!active || !payload || payload.length === 0) return null;

  return (
    <div className="bg-white/95 backdrop-blur-sm border border-slate-200 p-4 rounded-xl shadow-lg shadow-slate-200/50 min-w-[220px]">
      <p className="text-sm font-semibold text-slate-800 mb-3 border-b border-slate-100 pb-2">
        {format(parseISO(label), 'MMM d, yyyy HH:mm')}
      </p>
      
      {payload.map((entry, index) => {
        // Historical Real-time Data
        if (entry.dataKey === 'historicalGlucose' && entry.value != null) {
          return (
            <div key={index} className="flex justify-between items-center text-sm py-1">
              <span className="flex items-center text-slate-600">
                <div className="w-2 h-2 rounded-full bg-slate-900 mr-2" />
                Actual
              </span>
              <span className="font-bold text-slate-900">{entry.value} mg/dL</span>
            </div>
          );
        }
        
        // AI Baseline Forecast
        if (entry.dataKey === 'forecastGlucose' && entry.value != null) {
          return (
            <div key={index} className="flex justify-between items-center text-sm py-1">
              <span className="flex items-center text-indigo-600">
                <div className="w-2 h-2 rounded-full bg-indigo-500 mr-2" />
                Baseline Forecast
              </span>
              <span className="font-bold text-indigo-700">{entry.value} mg/dL</span>
            </div>
          );
        }

        // AI 95% Confidence Band
        if (entry.dataKey === 'confidenceBand' && entry.value != null && Array.isArray(entry.value)) {
          return (
            <div key={index} className="flex justify-between items-center text-sm py-1">
              <span className="flex items-center text-indigo-400">
                <div className="w-2 h-2 rounded-full bg-indigo-200 mr-2" />
                95% CI
              </span>
              <span className="font-medium text-indigo-500">
                {entry.value[0]} - {entry.value[1]} mg/dL
              </span>
            </div>
          );
        }

        return null;
      })}
    </div>
  );
};

// -----------------------------------------------------------------------------
// Main Component
// -----------------------------------------------------------------------------

export function TelemetryChartSuite({ 
  forecast, 
  targetRangeMin = 70, 
  targetRangeMax = 180,
  className = ''
}: TelemetryChartSuiteProps) {
  
  // Transform data for Recharts: combine lower/upper into an array for the Area band
  // This is wrapped in useMemo to prevent unnecessary recalculations on re-renders
  const chartData = useMemo(() => {
    return forecast.data.map(point => ({
      ...point,
      // Recharts Area can render a range if given an array of [bottom, top]
      confidenceBand: point.quantileLower != null && point.quantileUpper != null 
        ? [point.quantileLower, point.quantileUpper] 
        : null
    }));
  }, [forecast]);

  // Find the exact timestamp where the forecast begins (the 'NOW' line)
  const forecastStartPoint = useMemo(() => {
    return chartData.find(d => d.forecastGlucose != null)?.timestamp;
  }, [chartData]);

  return (
    <div className={`w-full h-[450px] flex flex-col bg-white rounded-2xl border border-slate-200 p-4 shadow-sm ${className}`}>
      
      {/* Chart Header & Legend */}
      <div className="flex items-center justify-between mb-6 px-2">
        <h3 className="text-lg font-semibold text-slate-800 tracking-tight">
          Predictive Glucose Telemetry
        </h3>
        <div className="flex gap-5 text-sm font-medium">
          <div className="flex items-center text-slate-600">
            <div className="w-4 h-[2px] bg-slate-900 mr-2" /> Historical
          </div>
          <div className="flex items-center text-indigo-600">
            <div className="w-4 h-[2px] border-t-2 border-dashed border-indigo-500 mr-2" /> AI Forecast
          </div>
          <div className="flex items-center text-indigo-500">
            <div className="w-3 h-3 bg-indigo-100 border border-indigo-200 rounded mr-2" /> 95% CI
          </div>
        </div>
      </div>

      {/* Chart Canvas */}
      <div className="flex-1 min-h-0 w-full relative">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart
            data={chartData}
            margin={{ top: 20, right: 20, bottom: 20, left: -20 }}
          >
            {/* Background Grid */}
            <CartesianGrid 
              strokeDasharray="4 4" 
              vertical={false} 
              stroke="#e2e8f0" 
            />
            
            <XAxis 
              dataKey="timestamp" 
              tickFormatter={(val) => format(parseISO(val), 'HH:mm')}
              tick={{ fontSize: 12, fill: '#64748b' }}
              tickMargin={12}
              axisLine={false}
              tickLine={false}
              minTickGap={40}
            />
            
            <YAxis 
              domain={['dataMin - 30', 'dataMax + 30']}
              tick={{ fontSize: 12, fill: '#64748b' }}
              axisLine={false}
              tickLine={false}
              tickCount={7}
              width={60}
            />
            
            <Tooltip 
              content={<CustomTooltip />}
              cursor={{ stroke: '#cbd5e1', strokeWidth: 1, strokeDasharray: '5 5' }}
            />

            {/* Target Safe Range Background (Green Zone) */}
            <ReferenceArea 
              y1={targetRangeMin} 
              y2={targetRangeMax} 
              fill="#f0fdf4" 
              fillOpacity={0.6} 
            />

            {/* Target Range Threshold Markers */}
            <ReferenceLine y={targetRangeMax} stroke="#86efac" strokeDasharray="3 3" opacity={0.8} />
            <ReferenceLine y={targetRangeMin} stroke="#86efac" strokeDasharray="3 3" opacity={0.8} />

            {/* Forecast Start Indicator Line ("NOW") */}
            {forecastStartPoint && (
              <ReferenceLine 
                x={forecastStartPoint} 
                stroke="#6366f1" 
                strokeOpacity={0.4}
                label={{ 
                  position: 'insideTopLeft', 
                  value: 'NOW', 
                  fill: '#6366f1', 
                  fontSize: 11,
                  fontWeight: 700,
                  offset: 10
                }} 
              />
            )}

            {/* 1. Confidence Band (AI Quantile Forecast) */}
            {/* Uses array data [min, max] to draw a range band */}
            <Area
              type="monotone"
              dataKey="confidenceBand"
              stroke="none"
              fill="#c7d2fe"
              fillOpacity={0.4}
              isAnimationActive={true}
              animationDuration={800}
            />

            {/* 2. AI Baseline Forecast (Dashed Line) */}
            <Line
              type="monotone"
              dataKey="forecastGlucose"
              stroke="#6366f1"
              strokeWidth={2.5}
              strokeDasharray="6 6"
              dot={false}
              activeDot={{ r: 6, fill: '#6366f1', stroke: '#fff', strokeWidth: 2 }}
              isAnimationActive={true}
              animationDuration={800}
            />

            {/* 3. Historical Telemetry (Solid Line) */}
            <Line
              type="monotone"
              dataKey="historicalGlucose"
              stroke="#0f172a"
              strokeWidth={2.5}
              dot={false}
              activeDot={{ r: 6, fill: '#0f172a', stroke: '#fff', strokeWidth: 2 }}
              isAnimationActive={true}
              animationDuration={800}
            />
            
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
