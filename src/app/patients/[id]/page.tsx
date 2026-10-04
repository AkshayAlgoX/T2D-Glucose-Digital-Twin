'use client';

import React from 'react';
import { useParams } from 'next/navigation';
import { useRealtimeTelemetry } from '@/hooks/useRealtimeTelemetry';
import { ForecastCanvas } from '@/components/digital-twin/ForecastCanvas';
import { ScenarioEditor } from '@/components/digital-twin/ScenarioEditor';
import { RiskPanel } from '@/components/digital-twin/RiskPanel';
import { RiskStrip } from '@/components/digital-twin/RiskStrip';
import { TimeScrubber } from '@/components/digital-twin/TimeScrubber';
import { TimeProvider } from '@/components/digital-twin/TimeContext';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { AlertTriangle } from 'lucide-react';

export default function PatientDashboard() {
  const params = useParams();
  const patientId = Array.isArray(params?.id) ? params.id[0] : (params?.id as string) || '';
  const { forecast, cache, isConnected, isStale, error } = useRealtimeTelemetry(patientId);

  const isDegraded = forecast?.data_quality?.status === 'degraded';
  const isInsufficient = forecast?.data_quality?.status === 'insufficient' || !forecast;
  const isFallback = forecast?.model?.fallback_used === 'twin_only';

  const statusChip = isInsufficient 
    ? 'No forecast'
    : isFallback 
      ? 'Twin-only · neural model unavailable' 
      : 'Hybrid Neural';

  return (
    <TimeProvider>
    <div className="flex h-screen w-screen overflow-hidden bg-bg text-[13px] leading-[20px] text-ink">
      
      {/* Rail */}
      <nav className="w-[48px] border-r border-line bg-surface flex flex-col shrink-0 items-center py-4 gap-4">
        <div className="w-6 h-6 rounded-[6px] bg-line-control" title="Logo placeholder" />
      </nav>

      {/* Storyboard */}
      <aside aria-label="Patient Identity" className="w-[272px] border-r border-line bg-surface shrink-0 p-4 flex flex-col gap-6 overflow-y-auto">
        <div>
          <div className="text-ink-2 mb-1">Identity</div>
          <div className="font-mono text-sm select-all">{patientId}</div>
        </div>
        <div>
          <div className="text-ink-2 mb-1">Status</div>
          <div className="flex items-center gap-2">
            <span className={`w-2 h-2 rounded-full ${isInsufficient ? 'bg-line-control' : isFallback ? 'bg-physics' : 'bg-forecast'}`} />
            <span>{statusChip}</span>
          </div>
        </div>
        <div>
           <div className="text-ink-2 mb-1">Model Info</div>
           <div className="text-xs space-y-1">
             <div><span className="text-ink-3">Intended Use:</span> <span className="font-mono">{forecast?.intended_use || '--'}</span></div>
             <div><span className="text-ink-3">Conformal:</span> {forecast?.forecast?.conformal_adjusted ? 'Yes' : 'No'}</div>
             <div><span className="text-ink-3">Risk Calibrated:</span> {forecast?.spike_risk?.calibrated ? 'Yes' : 'No'}</div>
           </div>
        </div>
      </aside>

      {/* Center + Right Split */}
      <div className="flex-1 flex flex-col min-w-0">
        
        {/* Main Content Area */}
        <div className="flex-1 flex min-h-0">
          
          {/* Main Column */}
          <main className="flex-1 flex flex-col min-w-0">
            {/* Now Bar */}
            <header className="h-[48px] border-b border-line px-4 flex items-center justify-between shrink-0 bg-surface">
              <div className="flex items-center gap-4">
                <span className="text-[28px] leading-[32px] font-medium tabular-nums flex items-baseline">
                  {forecast?.current?.value_mg_dl ?? '--'}
                  <span className="text-[13px] text-ink-3 ml-1">mg/dL</span>
                </span>
                
                {forecast?.current?.trend_arrow && (
                  <span className="text-ink-2">{forecast.current.trend_arrow}</span>
                )}
                
                <span className="text-ink-2 ml-4">
                  Live
                </span>
                {isStale && (
                  <span className="text-ink-2 ml-4 opacity-40">
                    Stale · from {new Date(forecast?.as_of || Date.now()).toLocaleTimeString()}
                  </span>
                )}
              </div>
              
              {!isConnected && (
                <div className="px-3 py-1 bg-danger text-white rounded font-medium text-xs">
                  Disconnected
                </div>
              )}
            </header>
            
            {/* Forecast Canvas */}
            <div className="h-[360px] border-b border-line p-0 shrink-0 relative bg-surface">
              <ErrorBoundary fallbackText="Forecast Canvas Error">
                <ForecastCanvas forecast={forecast} cache={cache} isStale={isStale} />
              </ErrorBoundary>
            </div>

            {/* Lanes */}
            <div className="flex-1 min-h-[112px] flex flex-col border-b border-line bg-surface">
              <div className="h-[28px] border-b border-line px-4 flex items-center justify-between">
                <span className="text-ink-2">Meals</span>
                <span className="text-ink-3">not available in contract v1</span>
              </div>
              <div className="h-[28px] border-b border-line px-4 flex items-center justify-between">
                <span className="text-ink-2">Activity</span>
                <span className="text-ink-3">not available in contract v1</span>
              </div>
              <div className="h-[28px] border-b border-line px-4 flex items-center justify-between">
                <span className="text-ink-2">Heart Rate</span>
                <span className="text-ink-3">not available in contract v1</span>
              </div>
              <div className="h-[28px] px-4 flex items-center justify-between">
                <span className="text-ink-2">Sleep</span>
                <span className="text-ink-3">not available in contract v1</span>
              </div>
            </div>

            {/* Risk Strip */}
            <div className="h-[72px] shrink-0 border-b border-line bg-surface">
              <RiskStrip forecast={forecast} />
            </div>
          </main>

          {/* Inspector */}
          <aside aria-label="Insights & Scenarios" className="w-[344px] border-l border-line bg-surface shrink-0 flex flex-col overflow-y-auto">
             <ErrorBoundary fallbackText="Risk Panel Error">
               <RiskPanel forecast={forecast} />
             </ErrorBoundary>
             <ErrorBoundary fallbackText="Scenario Editor Error">
               <ScenarioEditor patientId={patientId} currentForecast={forecast} pinnedAsOf={forecast?.as_of} />
             </ErrorBoundary>
          </aside>
        </div>

        {/* Timeline */}
        <div className="h-[96px] border-t border-line bg-surface shrink-0 relative">
           <ErrorBoundary fallbackText="Timeline Error">
             <TimeScrubber cache={cache} asOf={forecast?.as_of} />
           </ErrorBoundary>
        </div>

      </div>
    </div>
    </TimeProvider>
  );
}
