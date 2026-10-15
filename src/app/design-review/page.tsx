'use client';

import React, { useState, useMemo } from 'react';
import { TimeProvider } from '@/components/digital-twin/TimeContext';
import { NavigationRail } from "@/components/digital-twin/NavigationRail";
import { PatientWorkspace } from '@/components/digital-twin/PatientWorkspace';
import type { ForecastResponse } from '@/types/forecast-response';

type ReviewState = 'NORMAL' | 'HIGH RISK' | 'ALERT' | 'STALE' | 'INSUFFICIENT DATA' | 'TWIN ONLY' | 'WHAT-IF';

function generateFixture(state: ReviewState): { forecast: ForecastResponse, cache: any } {
  const now = new Date('2026-10-04T12:00:00Z');
  
  const baseForecast: ForecastResponse = {
    schema_version: "1.0.0",
    request_id: "req-123",
    generated_at: now.toISOString(),
    as_of: now.toISOString(),
    subject: { subject_id: "P-FIXTURE-001", synthetic: true },
    intended_use: "research_only_not_for_clinical_decisions",
    model: { name: "hybrid_v1", version: "1.0", fallback_used: null, run_id: "test", alert_policy_version: "v1" },
    data_quality: { status: 'ok', cgm_coverage_6h_pct: 97.2, staleness_min: 0, last_cgm_at: now.toISOString(), reasons: [] },
    current: { value_mg_dl: 110, flag: "in_range", measured_at: now.toISOString(), trend_arrow: "flat" },
    alert: { state: "none" },
    spike_risk: {
      probability_120m: 0.15,
      tier: "low",
      calibrated: true,
      spike_in_progress: false,
      definition: { threshold_mg_dl: 180, min_rise_mg_dl: 0, rise_window_min: 0, persistence_min: 0 },
      time_to_peak_min: 60,
      peak_mg_dl: { p50: 130, p90: 150 },
      cumulative: Array.from({length: 24}, (_, i) => ({ offset_min: (i+1)*5 as any, p: 0.15 * ((i+1)/24) })) as any
    },
    drivers: [
      { feature_key: 'meal', label_key: "Recent Meal", direction: 'raises', impact_mg_dl: 14, source: 'twin' },
      { feature_key: 'baseline', label_key: "Baseline Return", direction: 'lowers', impact_mg_dl: -10.7, source: 'both' },
      { feature_key: 'twin', label_key: "Twin Sens. (0.79)", direction: 'raises', impact_mg_dl: 5, source: 'twin' }
    ],
    forecast: {
      units: "mg/dL",
      step_min: 5,
      horizon_min: 120,
      conformal_adjusted: true,
      points: Array.from({length: 24}, (_, i) => {
        const offset = (i+1)*5;
        const v = 110 + (i*1.5);
        return {
          offset_min: offset as any,
          t: new Date(now.getTime() + offset*60000).toISOString(),
          p05: v - 15, p10: v - 10, p25: v - 5, p50: v, p75: v + 5, p90: v + 10, p95: v + 15,
          twin_p50: v - 2
        };
      }) as any
    },
    twin_state: {},
    ehr_context: {
      age_years: 58,
      sex: "male",
      bmi: 27,
      hba1c_pct: 7.2,
      hba1c_date: "2026-09-01T00:00:00Z"
    }
  };

  const cache: any = {
    cgm: Array.from({length: 72}, (_, i) => ({
      t: new Date(now.getTime() - (72-i)*300000).toISOString(),
      value: 100 + Math.sin(i / 10) * 10,
      trend: "flat"
    }))
  };

  baseForecast.forecast.points[0].p50 = baseForecast.current.value_mg_dl as number;

  if (state === 'HIGH RISK') {
    baseForecast.alert = { state: "watch" };
    baseForecast.spike_risk.probability_120m = 0.85;
    baseForecast.spike_risk.peak_mg_dl = { p50: 210, p90: 230 };
    baseForecast.spike_risk.cumulative = Array.from({length: 24}, (_, i) => ({ offset_min: (i+1)*5 as any, p: 0.85 * ((i+1)/24) })) as any;
    baseForecast.forecast.points.forEach((p, i) => {
       p.p50 = 110 + (i * 4.5);
       p.p90 = p.p50 + 20;
       p.p10 = p.p50 - 20;
       p.twin_p50 = p.p50 - 5;
    });
    baseForecast.drivers = [
      { feature_key: 'x', label_key: "Recent Meal", direction: 'raises', impact_mg_dl: 80, source: 'twin' },
      { feature_key: 'x', label_key: "Baseline", direction: 'raises', impact_mg_dl: 20, source: 'twin' }
    ];
    
    // Synthetic risk history for visual inspection
    cache.risk_history = Array.from({length: 24}, (_, i) => {
      const t = new Date(now.getTime() - (24-i)*15*60000).toISOString();
      const p = 0.1 + (i/24)*0.7; // climbs from 10% to 80%
      return { t, p, alert: i === 20, onset: i === 15 };
    });
  }

  if (state === 'ALERT') {
    baseForecast.alert = { state: "warning" };
    baseForecast.spike_risk.probability_120m = 0.95;
    baseForecast.spike_risk.peak_mg_dl = { p50: 230, p90: 250 };
  }

  if (state === 'INSUFFICIENT DATA') {
    baseForecast.data_quality.status = 'insufficient';
  }

  if (state === 'TWIN ONLY') {
    baseForecast.model.fallback_used = 'twin_only';
  }

  if (state === 'WHAT-IF') {
    baseForecast.alert = { state: "watch" };
    baseForecast.spike_risk.probability_120m = 0.85;
    baseForecast.spike_risk.peak_mg_dl = { p50: 210, p90: 230 };
    baseForecast.scenarios = [{
       scenario_id: "scen-1",
       inputs: [{kind: 'meal', offset_min: 0, carbs_g: 30}],
       delta_peak_mg_dl: -40,
       probability_120m: 0.30,
       delta_probability: -0.55,
       points: baseForecast.forecast.points.map(p => ({
         offset_min: p.offset_min,
         p10: p.p10 - 40,
         p50: p.p50 - 40,
         p90: p.p90 - 40
       })) as any
    }];
  }

  return { forecast: baseForecast, cache };
}

export default function DesignReview() {
  const [state, setState] = useState<ReviewState>('NORMAL');
  
  const { forecast, cache } = useMemo(() => generateFixture(state), [state]);

  const isStale = state === 'STALE';
  const isConnected = state !== 'STALE';

  return (
    <TimeProvider>
      <div className="app-shell">
        
        {/* DEV TOOLBAR (OUTSIDE WORKSPACE) */}
        <div className="min-h-12 bg-white border-b border-line flex flex-wrap items-center gap-y-2 px-4 py-2">
           <div className="text-[11px] font-bold text-amber-800 tracking-wider pr-4 border-r border-amber-200">
             DESIGN FIXTURES · NOT LIVE INFERENCE OR EVIDENCE
           </div>
           <div className="flex flex-wrap gap-1 pl-4">
             {['NORMAL', 'HIGH RISK', 'ALERT', 'STALE', 'INSUFFICIENT DATA', 'TWIN ONLY', 'WHAT-IF'].map(s => (
                <button 
                  key={s} 
                  onClick={() => setState(s as ReviewState)}
                  className={`px-3 py-1.5 text-[10px] uppercase font-bold rounded-sm border transition-colors ${state === s ? 'bg-amber-100 border-amber-300 text-amber-900 shadow-inner' : 'bg-surface border-line text-ink-3 hover:bg-surface-2 hover:text-ink-2'}`}
                >
                  {s}
                </button>
             ))}
           </div>
        </div>

        {/* WORKSPACE FRAME */}
        <div className="w-full">
          <div className="app-shell">
            <NavigationRail />
            
            <PatientWorkspace
              patientId="P-FIXTURE-001"
              forecast={forecast}
              cache={cache}
              isConnected={isConnected}
              isStale={isStale}
              error={null}
            />
          </div>
        </div>
      </div>
    </TimeProvider>
  );
}
