'use client';

import React from 'react';
import { useRealtimeTelemetry } from '@/hooks/useRealtimeTelemetry';
import { TelemetryChartSuite } from '@/components/digital-twin/TelemetryChartSuite';
import { ScenarioEditor } from '@/components/digital-twin/ScenarioEditor';
import { PredictiveInsightsPanel } from '@/components/digital-twin/PredictiveInsightsPanel';
import { TimeScrubber } from '@/components/digital-twin/TimeScrubber';
import { AlertTriangle } from 'lucide-react';

export default function PatientDashboard() {
  const { forecast, isConnected, isStale, error } = useRealtimeTelemetry('123');

  if (error) {
    return (
      <div className="flex h-screen items-center justify-center text-danger bg-bg">
        <div className="flex items-center gap-2">
          <AlertTriangle className="w-5 h-5" />
          <span className="font-medium">System Error: {error.message}</span>
        </div>
      </div>
    );
  }

  const isDegraded = forecast?._raw_data_quality?.status === 'degraded';
  const hasInsufficientData = forecast?._raw_data_quality?.status === 'insufficient';

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-bg text-[13px] leading-[20px] text-ink">
      
      {/* Rail */}
      <nav className="w-[48px] border-r border-line bg-surface flex flex-col shrink-0 items-center py-4 gap-4">
        <div className="w-6 h-6 rounded-sm bg-line-control" title="Logo placeholder" />
      </nav>

      {/* Storyboard */}
      <aside className="w-[272px] border-r border-line bg-surface shrink-0 p-4 flex flex-col gap-6 overflow-y-auto">
        <div>
          <div className="text-ink-2 mb-1">Identity</div>
          <div className="font-mono text-sm">PT-123</div>
        </div>
        <div>
          <div className="text-ink-2 mb-1">Status</div>
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-forecast" />
            <span>{hasInsufficientData ? 'Twin-only' : 'Hybrid Neural'}</span>
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
            <header className="h-[48px] border-b border-line px-4 flex items-center justify-between shrink-0">
              <div className="flex items-center gap-4">
                <span className="text-[28px] leading-[32px] font-medium tabular-nums">
                  {forecast?.data?.[forecast.data.length - 1]?.historicalGlucose || '--'}
                  <span className="text-[13px] text-ink-3 ml-1">mg/dL</span>
                </span>
                <span className="text-ink-2">Live</span>
              </div>
            </header>
            
            {/* Forecast Canvas */}
            <div className="h-[360px] border-b border-line p-0 shrink-0 relative">
              <TelemetryChartSuite forecast={forecast} />
            </div>

            {/* Lanes */}
            <div className="flex-1 min-h-[112px] flex flex-col border-b border-line">
              <div className="h-[28px] border-b border-line px-4 flex items-center text-ink-2">Meals</div>
              <div className="h-[28px] border-b border-line px-4 flex items-center text-ink-2">Activity</div>
              <div className="h-[28px] border-b border-line px-4 flex items-center text-ink-2">Heart Rate</div>
              <div className="h-[28px] px-4 flex items-center text-ink-2">Sleep</div>
            </div>

            {/* Risk Strip */}
            <div className="h-[72px] shrink-0 p-4 flex items-center">
              Risk Strip Stub
            </div>
          </main>

          {/* Inspector */}
          <aside className="w-[344px] border-l border-line bg-surface shrink-0 flex flex-col overflow-y-auto">
             <PredictiveInsightsPanel
                spikeProbability120m={forecast?.spikeProbability120m || 0}
                drivers={forecast?.drivers || []}
                predictedEvent={forecast?.predictedEvent}
              />
             <ScenarioEditor 
                patientId="123" 
                currentForecast={forecast} 
                pinnedAsOf={forecast?.generatedAt}
              />
          </aside>
        </div>

        {/* Timeline */}
        <div className="h-[96px] border-t border-line bg-surface shrink-0 relative">
           <TimeScrubber 
             currentAsOf={forecast?.generatedAt || new Date().toISOString()} 
             onSeek={() => {}}
           />
        </div>

      </div>
    </div>
  );
}
