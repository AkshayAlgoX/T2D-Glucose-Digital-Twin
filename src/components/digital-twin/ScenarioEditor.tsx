'use client';

import React, { useState, useMemo, useEffect } from 'react';
import { Card, CardHeader, CardTitle, CardContent, CardDescription, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Loader2, ArrowRight, Activity, Utensils, Zap, ChevronDown, TrendingDown, TrendingUp } from "lucide-react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
  TooltipProps
} from 'recharts';
import { format, parseISO } from 'date-fns';
import type { ForecastResponse } from '@/types/digital-twin';

// -----------------------------------------------------------------------------
// Types & Contracts
// -----------------------------------------------------------------------------

type InterventionType = 'NUTRITION' | 'ACTIVITY' | 'MEDICATION';

interface ScenarioSimulationResponse {
  pinned_as_of: string;
  scenario_forecast: {
    timestamp: string;
    forecastGlucose: number;
  }[];
  metrics: {
    delta_peak_mg_dl: number;
    new_peak_mg_dl: number;
    baseline_peak_mg_dl: number;
  };
}

interface ScenarioEditorProps {
  patientId: string;
  currentForecast: ForecastResponse | null; 
  pinnedAsOf: string;
}

// -----------------------------------------------------------------------------
// Main Component
// -----------------------------------------------------------------------------

export function ScenarioEditor({ patientId, currentForecast, pinnedAsOf }: ScenarioEditorProps) {
  // Form State
  const [interventionType, setInterventionType] = useState<InterventionType>('NUTRITION');
  const [amount, setAmount] = useState<string>('60');
  const [intensity, setIntensity] = useState<string>('moderate');

  // Simulation State
  const [isSimulating, setIsSimulating] = useState(false);
  const [simulationResult, setSimulationResult] = useState<ScenarioSimulationResponse | null>(null);

  useEffect(() => {
    setSimulationResult(null);
  }, [pinnedAsOf, currentForecast?.generatedAt]);

  // ---------------------------------------------------------------------------
  // Data Fetching
  // ---------------------------------------------------------------------------
  
  const handleSimulate = async () => {
    if (!currentForecast || !currentForecast.data.length) return;
    
    setIsSimulating(true);

    // Identify the exact timestamp where the forecast branches from historical data
    const pinnedAsOf = currentForecast.data.find(d => d.forecastGlucose !== null)?.timestamp 
      || new Date().toISOString();

    try {
      // Stateless BFF Route Call
      const res = await fetch(`/api/forecast`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          patientId,
          pinned_as_of: pinnedAsOf,
          scenario: {
            type: interventionType,
            value: Number(amount),
            ...(interventionType === 'ACTIVITY' && { intensity })
          }
        })
      });
      
      const data: ScenarioSimulationResponse = await res.json();
      setSimulationResult(data);
    } catch (err) {
      console.error("Failed to simulate scenario", err);
      // In production: trigger toast notification
    } finally {
      setIsSimulating(false);
    }
  };

  // ---------------------------------------------------------------------------
  // Chart Data Merging
  // ---------------------------------------------------------------------------
  
  // We zip the baseline forecast and the scenario forecast together by timestamp
  const chartData = useMemo(() => {
    if (!currentForecast) return [];
    
    // Only care about future forecast points for the comparison
    const baselineData = currentForecast.data.filter(d => d.forecastGlucose !== null);
    
    if (!simulationResult) {
      return baselineData.map(d => ({ timestamp: d.timestamp, baseline: d.forecastGlucose }));
    }

    // Map scenario points by timestamp for O(1) lookup
    const scenarioMap = new Map(simulationResult.scenario_forecast.map(s => [s.timestamp, s.forecastGlucose]));

    return baselineData.map(d => ({
      timestamp: d.timestamp,
      baseline: d.forecastGlucose,
      scenario: scenarioMap.get(d.timestamp) || null
    }));
  }, [currentForecast, simulationResult]);

  // ---------------------------------------------------------------------------
  // Renderers
  // ---------------------------------------------------------------------------

  const renderDeltaBadge = () => {
    if (!simulationResult) return null;
    const { delta_peak_mg_dl, new_peak_mg_dl } = simulationResult.metrics;
    
    const isImproved = delta_peak_mg_dl < 0; // Negative delta means peak is lower (good!)
    const DeltaIcon = isImproved ? TrendingDown : TrendingUp;
    const colorClass = isImproved ? "text-green-600 bg-green-50 border-green-200" : "text-red-600 bg-red-50 border-red-200";

    return (
      <div className={`flex items-center gap-3 px-4 py-2 rounded-lg border ${colorClass}`}>
        <div className="flex flex-col">
          <span className="text-[10px] uppercase font-bold tracking-wider opacity-70">New Peak</span>
          <span className="text-lg font-black leading-tight">{new_peak_mg_dl} <span className="text-sm font-medium">mg/dL</span></span>
        </div>
        <div className="h-8 w-px bg-current opacity-20 mx-1" />
        <div className="flex flex-col">
          <span className="text-[10px] uppercase font-bold tracking-wider opacity-70">Delta</span>
          <span className="text-sm font-bold flex items-center">
            {delta_peak_mg_dl > 0 ? '+' : ''}{delta_peak_mg_dl} mg/dL
            <DeltaIcon className="w-4 h-4 ml-1" />
          </span>
        </div>
      </div>
    );
  };

  return (
    <Card className="border-slate-200 shadow-md overflow-hidden bg-white">
      <div className="flex flex-col md:flex-row">
        
        {/* Left Panel: Inputs */}
        <div className="w-full md:w-1/3 bg-slate-50 border-r border-slate-100 p-6 flex flex-col justify-between">
          <div>
            <div className="mb-6">
              <h3 className="text-lg font-semibold flex items-center text-slate-800">
                <Zap className="w-5 h-5 mr-2 text-amber-500 fill-amber-500" />
                "What-If" Simulator
              </h3>
              <p className="text-sm text-slate-500 mt-1">
                Test hypothetical scenarios against the baseline forecast.
              </p>
            </div>

            <div className="space-y-5">
              <div className="space-y-2">
                <Label className="text-slate-700 font-semibold">Intervention Type</Label>
                <Select value={interventionType} onValueChange={(v: InterventionType) => setInterventionType(v)}>
                  <SelectTrigger className="bg-white">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="NUTRITION">
                      <div className="flex items-center"><Utensils className="w-4 h-4 mr-2" /> Meal / Snack</div>
                    </SelectItem>
                    <SelectItem value="ACTIVITY">
                      <div className="flex items-center"><Activity className="w-4 h-4 mr-2" /> Physical Activity</div>
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label className="text-slate-700 font-semibold">
                  {interventionType === 'NUTRITION' ? 'Carbohydrates (g)' : 'Duration (minutes)'}
                </Label>
                <Input 
                  type="number" 
                  value={amount} 
                  onChange={(e) => setAmount(e.target.value)} 
                  className="bg-white"
                />
              </div>

              {interventionType === 'ACTIVITY' && (
                <div className="space-y-2 animate-in fade-in slide-in-from-top-2">
                  <Label className="text-slate-700 font-semibold">Intensity</Label>
                  <Select value={intensity} onValueChange={setIntensity}>
                    <SelectTrigger className="bg-white">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="light">Light (e.g. Walking)</SelectItem>
                      <SelectItem value="moderate">Moderate (e.g. Jogging)</SelectItem>
                      <SelectItem value="vigorous">Vigorous (e.g. HIIT)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              )}
            </div>
          </div>

          <Button 
            className="w-full mt-8 bg-indigo-600 hover:bg-indigo-700 text-white shadow-md transition-all"
            onClick={handleSimulate}
            disabled={isSimulating || !currentForecast}
          >
            {isSimulating ? (
              <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Simulating...</>
            ) : (
              <>Run Simulation <ArrowRight className="ml-2 h-4 w-4" /></>
            )}
          </Button>
        </div>

        {/* Right Panel: Charting & Deltas */}
        <div className="w-full md:w-2/3 p-6 flex flex-col">
          <div className="flex items-center justify-between mb-6">
            <h4 className="font-semibold text-slate-800">Forecast Comparison</h4>
            {renderDeltaBadge()}
          </div>

          <div className="flex-1 min-h-[250px] relative">
            {!simulationResult && !isSimulating && (
              <div className="absolute inset-0 z-10 bg-white/60 backdrop-blur-[1px] flex items-center justify-center rounded-xl border border-dashed border-slate-300">
                <span className="text-sm font-medium text-slate-500">
                  Configure a scenario and click simulate
                </span>
              </div>
            )}
            
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />
                <XAxis 
                  dataKey="timestamp" 
                  tickFormatter={(val) => format(parseISO(val), 'HH:mm')}
                  tick={{ fontSize: 11, fill: '#94a3b8' }}
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis 
                  domain={['dataMin - 10', 'dataMax + 10']}
                  tick={{ fontSize: 11, fill: '#94a3b8' }}
                  axisLine={false}
                  tickLine={false}
                />
                <Tooltip 
                  cursor={{ stroke: '#cbd5e1', strokeWidth: 1, strokeDasharray: '4 4' }}
                  content={({ active, payload, label }) => {
                    if (!active || !payload) return null;
                    return (
                      <div className="bg-white/95 border border-slate-200 p-3 rounded-lg shadow-xl text-sm">
                        <p className="font-semibold text-slate-800 mb-2">{format(parseISO(String(label)), 'HH:mm')}</p>
                        {payload.map((entry, i) => (
                          <div key={i} className="flex justify-between gap-4 py-1">
                            <span className="flex items-center text-slate-600">
                              <div className={`w-2 h-2 rounded-full mr-2 ${entry.dataKey === 'scenario' ? 'bg-indigo-500' : 'bg-slate-400'}`} />
                              {entry.dataKey === 'scenario' ? 'Simulation' : 'Baseline'}
                            </span>
                            <span className="font-bold">{entry.value} mg/dL</span>
                          </div>
                        ))}
                      </div>
                    );
                  }}
                />
                
                {/* 1. Control / Baseline Curve (Gray) */}
                <Line
                  type="monotone"
                  dataKey="baseline"
                  stroke="#94a3b8"
                  strokeWidth={2}
                  strokeDasharray="4 4"
                  dot={false}
                  isAnimationActive={false}
                />

                {/* 2. Experimental / Scenario Curve (Indigo) */}
                {simulationResult && (
                  <Line
                    type="monotone"
                    dataKey="scenario"
                    stroke="#4f46e5"
                    strokeWidth={3}
                    dot={false}
                    activeDot={{ r: 5, fill: '#4f46e5', stroke: '#fff', strokeWidth: 2 }}
                    isAnimationActive={true}
                    animationDuration={1000}
                  />
                )}
              </LineChart>
            </ResponsiveContainer>
          </div>
          
          <div className="mt-4 flex gap-4 text-xs font-medium justify-end">
            <div className="flex items-center text-slate-500">
              <div className="w-3 h-[2px] bg-slate-400 border-t border-dashed border-slate-400 mr-2" /> Baseline Forecast
            </div>
            <div className="flex items-center text-indigo-600">
              <div className="w-3 h-[2px] bg-indigo-600 mr-2" /> Scenario Forecast
            </div>
          </div>
        </div>

      </div>
    </Card>
  );
}
