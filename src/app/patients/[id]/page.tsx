'use client';

import React, { useState } from 'react';
import { useParams } from 'next/navigation';
import { useRealtimeTelemetry } from '@/hooks/useRealtimeTelemetry';
import { TelemetryChartSuite } from '@/components/digital-twin/TelemetryChartSuite';
import { ScenarioEditor } from '@/components/digital-twin/ScenarioEditor';
import { PredictiveInsightsPanel } from '@/components/digital-twin/PredictiveInsightsPanel';
import { BodyVisualizer3D } from '@/components/digital-twin/BodyVisualizer3D';
import { TimeScrubber } from '@/components/digital-twin/TimeScrubber';
import { AlertTriangle, WifiOff, RefreshCcw } from 'lucide-react';

export default function PatientDashboard() {
  const params = useParams();
  const patientId = params.id as string;
  const { forecast, isConnected, isStale, error } = useRealtimeTelemetry(patientId);
  const [pinnedAsOf, setPinnedAsOf] = useState<string | null>(null);

  // Derive model fallback/insufficient data states
  const hasInsufficientData = forecast?._raw_data_quality?.status === 'insufficient';

  if (error) {
    return (
      <div className="flex h-screen items-center justify-center bg-slate-50">
        <div className="text-center text-red-600">
          <AlertTriangle className="w-10 h-10 mx-auto mb-4" />
          <h2 className="text-xl font-bold">Failed to load telemetry</h2>
          <p>{error.message}</p>
        </div>
      </div>
    );
  }

  if (!isConnected && !forecast) {
    return (
      <div className="flex h-screen items-center justify-center bg-slate-50">
        <div className="text-center text-slate-500 animate-pulse">
          <RefreshCcw className="w-10 h-10 mx-auto mb-4 animate-spin" />
          <h2 className="text-xl font-bold">Connecting to ML Service...</h2>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 p-6 space-y-6 pb-32">
      <header className="flex justify-between items-center mb-8">
        <div>
          <h1 className="text-3xl font-bold text-slate-900">Patient Dashboard</h1>
          <p className="text-slate-500">ID: {patientId}</p>
        </div>
        
        {/* Connection Status Badges */}
        <div className="flex items-center gap-3">
          {!isConnected && (
            <span className="flex items-center text-sm font-medium text-amber-600 bg-amber-50 px-3 py-1 rounded-full border border-amber-200">
              <WifiOff className="w-4 h-4 mr-2" /> Disconnected
            </span>
          )}
          {isStale && (
            <span className="flex items-center text-sm font-medium text-amber-600 bg-amber-50 px-3 py-1 rounded-full border border-amber-200">
              <AlertTriangle className="w-4 h-4 mr-2" /> Stale Data
            </span>
          )}
          {hasInsufficientData && (
            <span className="flex items-center text-sm font-medium text-slate-600 bg-slate-100 px-3 py-1 rounded-full border border-slate-200">
               Insufficient Data / Model Fallback
            </span>
          )}
        </div>
      </header>

      {forecast && !hasInsufficientData && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 space-y-6">
            <TelemetryChartSuite forecast={forecast} />
            <ScenarioEditor 
              patientId={patientId} 
              currentForecast={forecast} 
              pinnedAsOf={pinnedAsOf || forecast.generatedAt} 
            />
          </div>
          <div className="space-y-6">
            <div className="h-[400px]">
              <BodyVisualizer3D forecast={forecast} />
            </div>
            <PredictiveInsightsPanel 
              spikeProbability120m={forecast.spikeProbability120m || 0}
              predictedEvent={forecast.predictedEvent || 'hyperglycemia_spike'}
              drivers={forecast.drivers || []}
            />
          </div>
        </div>
      )}

      {forecast && (
        <TimeScrubber onTimeChange={setPinnedAsOf} />
      )}
    </div>
  );
}
