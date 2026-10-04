import React, { useState } from 'react';
import { ForecastCanvas } from './ForecastCanvas';
import { ScenarioEditor } from './ScenarioEditor';
import { RiskPanel } from './RiskPanel';
import { RiskStrip } from './RiskStrip';
import { TimeScrubber } from './TimeScrubber';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { formatTime, formatDate } from '@/lib/formatters/date';
import { ForecastResponse } from '@/types/forecast-response';
import { SubjectStore } from '@/lib/types';

interface NowBarProps {
  forecast: ForecastResponse | null;
  isConnected: boolean;
  isStale: boolean;
}

function NowBar({ forecast, isConnected, isStale }: NowBarProps) {
  const current = forecast?.current;
  const asOf = forecast?.as_of;
  const isReplay = !!asOf;
  const status = forecast?.data_quality?.status;

  return (
    <header className="h-[56px] border-b border-line px-4 flex items-center justify-between shrink-0 bg-surface">
      <div className="flex items-center gap-6">
        <div className="flex items-baseline gap-1">
          <span className="text-[32px] leading-none font-medium tabular-nums">{current?.value_mg_dl ?? '—'}</span>
          <span className="text-[13px] text-ink-3">mg/dL</span>
          {current?.trend_arrow && <span className="text-ink-2 ml-2">{current.trend_arrow}</span>}
        </div>
        
        <div className="flex flex-col justify-center">
          <div className="flex items-center gap-2 text-[12px] font-medium">
            <span className={isReplay ? 'text-amber' : isStale ? 'text-amber' : 'text-forecast'}>
               {isReplay ? 'Replay' : isStale ? 'Stale' : 'Live'}
            </span>
            <span className="text-ink-3">&middot;</span>
            <span className="text-ink-2 uppercase tracking-wide">
               {asOf ? `${formatDate(asOf)} ${formatTime(asOf)} UTC` : '—'}
            </span>
          </div>
          {!isConnected && (
            <div className="text-[11px] text-danger">Disconnected</div>
          )}
        </div>
      </div>
      
      <div className="flex items-center gap-3">
        <div className="px-2 py-1 bg-surface-2 border border-line rounded-sm text-[11px] uppercase tracking-wide text-ink-2">
          {forecast?.model?.fallback_used === 'twin_only' ? 'Physics Baseline' : 
           forecast?.model?.fallback_used === 'xgboost' ? 'XGBoost Fallback' :
           forecast?.model?.fallback_used === 'persistence' ? 'Persistence Fallback' :
           !forecast ? 'Unavailable' : 'Full Pipeline'}
        </div>
        <div className="px-2 py-1 bg-surface-2 border border-line rounded-sm text-[11px] uppercase tracking-wide text-ink-2">
          State: {status || 'Unknown'}
        </div>
      </div>
    </header>
  );
}

function Storyboard({ patientId, forecast }: { patientId: string, forecast: ForecastResponse | null }) {
  const ehr = forecast?.ehr_context;
  const twin = forecast?.twin_state; // Typecast because twin_state is loose or has specific fields
  
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    navigator.clipboard.writeText(patientId);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <aside aria-label="Patient Identity" className="w-[280px] border-r border-line bg-surface shrink-0 p-4 flex flex-col gap-6 overflow-y-auto">
      <div>
        <div className="text-[12px] font-medium text-ink-2 mb-1">Identity</div>
        <div 
          className="font-mono text-[18px] leading-tight cursor-pointer hover:text-forecast transition-colors" 
          onClick={handleCopy}
          title="Click to copy"
        >
          {patientId}
        </div>
        {copied && <div className="text-[11px] text-forecast mt-1">Copied!</div>}
      </div>

      {ehr && (
        <div>
          <div className="text-[12px] font-medium text-ink-2 mb-2">Clinical Context</div>
          <div className="text-[13px] space-y-1.5">
            <div className="flex justify-between"><span className="text-ink-3">Age</span> <span>{ehr.age_years}</span></div>
            <div className="flex justify-between"><span className="text-ink-3">Sex</span> <span className="capitalize">{ehr.sex}</span></div>
            <div className="flex justify-between"><span className="text-ink-3">BMI</span> <span>{ehr.bmi}</span></div>
            <div className="flex justify-between"><span className="text-ink-3">HbA1c</span> <span>{ehr.hba1c_pct}%</span></div>
            <div className="flex justify-between"><span className="text-ink-3">eGFR</span> <span>{ehr.egfr ?? 'Not available'}</span></div>
          </div>
        </div>
      )}

      {twin && (
        <div>
           <div className="text-[12px] font-medium text-ink-2 mb-2">Twin State</div>
           <div className="text-[13px] space-y-1.5">
             <div className="flex justify-between"><span className="text-ink-3">Insulin Sens.</span> <span>{twin.insulin_sensitivity_rel != null ? twin.insulin_sensitivity_rel.toFixed(2) : '—'}</span></div>
             <div className="flex justify-between"><span className="text-ink-3">Beta Cell</span> <span>{twin.beta_cell_rel != null ? twin.beta_cell_rel.toFixed(2) : '—'}</span></div>
             <div className="flex justify-between"><span className="text-ink-3">Carbs on Board</span> <span>{twin.carbs_on_board_g != null ? twin.carbs_on_board_g + 'g' : '—'}</span></div>
             <div className="flex justify-between"><span className="text-ink-3">Insulin on Board</span> <span>{twin.insulin_on_board_u != null ? twin.insulin_on_board_u + 'u' : '—'}</span></div>
           </div>
        </div>
      )}
      
      {twin?.unannounced_meal && twin.unannounced_meal.probability > 0.5 && (
        <div className="p-3 bg-amber/10 border border-amber/20 rounded-sm">
           <div className="text-[11px] font-semibold text-amber uppercase tracking-wide mb-1">Unlogged Meal Detected</div>
           <div className="text-[12px] text-ink">
             Probability: {(twin.unannounced_meal.probability * 100).toFixed(0)}%
           </div>
        </div>
      )}

      <div className="mt-auto pt-4 border-t border-line">
         <div className="text-[12px] text-ink-3 leading-snug">
           {forecast?.intended_use === 'research_only_not_for_clinical_decisions' 
             ? 'Research Only (Not for clinical decisions)' 
             : forecast?.intended_use || '—'}
         </div>
      </div>
    </aside>
  );
}

export interface PatientWorkspaceProps {
  patientId: string;
  forecast: ForecastResponse | null;
  cache: SubjectStore;
  isConnected: boolean;
  isStale: boolean;
  error?: Error | null;
}

export function PatientWorkspace({ patientId, forecast, cache, isConnected, isStale, error }: PatientWorkspaceProps) {
  return (
    <div className="flex flex-1 min-w-0 min-h-0 bg-bg text-[13px] leading-[20px] text-ink">
      <Storyboard patientId={patientId} forecast={forecast} />

      <div className="flex-1 flex flex-col min-w-0">
        <div className="flex-1 flex min-h-0">
          
          
          <main className="flex-1 flex flex-col min-w-0 h-full relative">
            {error && (
              <div className="absolute inset-0 z-50 bg-bg flex items-center justify-center p-8">
                <div className="text-center">
                  <div className="text-danger font-bold text-lg mb-2">
                    {error.message === 'patient-not-found' ? 'Patient Not Found' : 
                     error.message === 'contract-invalid' ? 'Contract Invalid (Malformed Data)' : 
                     'Service Unavailable'}
                  </div>
                  <div className="text-ink-2 text-sm">
                    {error.message === 'patient-not-found' ? 'The specified subject ID does not exist in the database.' : 
                     error.message === 'contract-invalid' ? 'The stream yielded data that violates the strict Zod schema validation.' : 
                     'The backend service could not be reached or connection was lost.'}
                  </div>
                </div>
              </div>
            )}
            

            <NowBar forecast={forecast} isConnected={isConnected} isStale={isStale} />
            
            <div className="flex-1 min-h-[200px] border-b border-line p-0 shrink relative bg-surface">
              <ErrorBoundary fallbackText="Forecast Canvas Error">
                <ForecastCanvas forecast={forecast} cache={cache} isStale={isStale} />
              </ErrorBoundary>
            </div>

            <div className="h-[112px] flex flex-col border-b border-line bg-surface shrink-0 text-[12px]">
              <div className="flex-1 border-b border-line ml-[40px] mr-[96px] flex items-center justify-between">
                <span className="text-ink-2 font-medium">Meals</span>
                <span className="text-ink-3 italic">Not available</span>
              </div>
              <div className="flex-1 border-b border-line ml-[40px] mr-[96px] flex items-center justify-between">
                <span className="text-ink-2 font-medium">Activity</span>
                <span className="text-ink-3 italic">Not available</span>
              </div>
              <div className="flex-1 border-b border-line ml-[40px] mr-[96px] flex items-center justify-between">
                <span className="text-ink-2 font-medium">Heart Rate</span>
                <span className="text-ink-3 italic">Not available</span>
              </div>
              <div className="flex-1 ml-[40px] mr-[96px] flex items-center justify-between bg-[url('data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNCIgaGVpZ2h0PSI0IiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciPjxwYXRoIGQ9Ik0wLDRMMCw0TDQsMEw0LDBaIiBzdHJva2U9IiNlNWU3ZWIiIHN0cm9rZS13aWR0aD0iMSIvPjwvc3ZnPg==')]">
                <span className="text-ink-2 font-medium bg-surface pr-2">Sleep</span>
                <span className="text-ink-3 italic bg-surface pl-2">Not available</span>
              </div>
            </div>

            <div className="h-[64px] shrink-0 border-b border-line bg-surface">
              <RiskStrip forecast={forecast} />
            </div>
          </main>

          <aside aria-label="Insights & Scenarios" className="w-[344px] border-l border-line bg-surface shrink-0 flex flex-col overflow-y-auto relative">
             <ErrorBoundary fallbackText="Risk Panel Error">
               <RiskPanel forecast={forecast} />
             </ErrorBoundary>
             <ErrorBoundary fallbackText="Scenario Editor Error">
               <ScenarioEditor patientId={patientId} currentForecast={forecast} />
             </ErrorBoundary>
          </aside>
        </div>

        <div className="h-[96px] border-t border-line bg-surface shrink-0 relative">
           <ErrorBoundary fallbackText="Timeline Error">
             <TimeScrubber cache={cache} asOf={forecast?.as_of} />
           </ErrorBoundary>
        </div>
      </div>
    </div>
  );
}
