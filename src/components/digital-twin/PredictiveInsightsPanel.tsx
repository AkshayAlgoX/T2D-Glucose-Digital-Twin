import React, { useMemo } from 'react';
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { 
  TrendingUp, 
  TrendingDown, 
  Activity, 
  Utensils, 
  Pill, 
  Clock, 
  AlertTriangle,
  BrainCircuit,
  Stethoscope
} from "lucide-react";

// -----------------------------------------------------------------------------
// Contracts & Interfaces
// -----------------------------------------------------------------------------

import { MLDriver } from '@/types/digital-twin';

export interface PredictiveInsightsPanelProps {
  spikeProbability120m: number; // e.g., 0.88 for 88%
  predictedEvent?: string;
  drivers: MLDriver[];
  className?: string;
}

// -----------------------------------------------------------------------------
// Clinical Dictionary Mapping
// -----------------------------------------------------------------------------
// Translates raw ML feature keys into doctor-friendly clinical terminology.
// In a real app, this might be fetched from a CMS or localization file.

type FeatureMetadata = {
  label: string;
  icon: React.ElementType;
  category: 'Nutrition' | 'Medication' | 'Physiological' | 'Lifestyle' | 'Clinical';
};

const FEATURE_DICTIONARY: Record<string, FeatureMetadata> = {
  "steps_last_30m": { label: "Recent Physical Activity (30m)", icon: Activity, category: "Lifestyle" },
  "carbs_ingested_2h": { label: "Recent Carbohydrate Load", icon: Utensils, category: "Nutrition" },
  "insulin_active_units": { label: "Active Insulin on Board (IOB)", icon: Pill, category: "Medication" },
  "heart_rate_variability": { label: "Heart Rate Variability (Stress)", icon: Activity, category: "Physiological" },
  "time_since_last_meal": { label: "Fasting Duration", icon: Clock, category: "Nutrition" },
  "baseline_hba1c": { label: "Baseline HbA1c", icon: Stethoscope, category: "Clinical" },
  "cortisol_proxy_am": { label: "Morning Cortisol Proxy", icon: Activity, category: "Physiological" },
};

const formatUnknownKey = (key: string) => {
  return key.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
};

// -----------------------------------------------------------------------------
// Main Component
// -----------------------------------------------------------------------------

export function PredictiveInsightsPanel({
  spikeProbability120m,
  predictedEvent,
  drivers,
  className = ""
}: PredictiveInsightsPanelProps) {
  
  // Sort drivers by highest importance first
  const sortedDrivers = useMemo(() => {
    return [...drivers].sort((a, b) => Math.abs(b.impact_mg_dl) - Math.abs(a.impact_mg_dl));
  }, [drivers]);

  const isSpike = predictedEvent === 'hyperglycemia_spike';
  const confidencePercent = Math.round(spikeProbability120m * 100);

  return (
    <Card className={`border-slate-200 shadow-sm ${className}`}>
      <CardHeader className="pb-4 border-b border-slate-100 bg-slate-50/50 rounded-t-xl">
        <div className="flex items-center justify-between">
          <CardTitle className="text-lg font-semibold flex items-center text-slate-800">
            <BrainCircuit className="w-5 h-5 mr-2 text-indigo-500" />
            How the forecast is built
          </CardTitle>
          <Badge 
            variant={confidencePercent > 80 ? "destructive" : "secondary"}
            className="font-mono"
          >
            Probability of spike within 120 min: {confidencePercent}%
          </Badge>
        </div>
        <CardDescription className="text-slate-600 mt-2">
          Supported component decomposition of the hybrid model.
        </CardDescription>
      </CardHeader>

      <CardContent className="pt-6">
        <ul className="space-y-5">
          {sortedDrivers.map((driver) => {
            const meta = FEATURE_DICTIONARY[driver.feature_key] || {
              label: formatUnknownKey(driver.feature_key),
              icon: Activity,
              category: "Clinical"
            };
            
            const Icon: any = meta.icon;
            
            // Determine styling based on whether it raises or lowers the predicted value
            // In the context of a spike, "raises" is exacerbating the risk (Red)
            const isExacerbating = isSpike ? driver.direction === 'raises' : driver.direction === 'lowers';
            
            const DirectionIcon = driver.direction === 'raises' ? TrendingUp : TrendingDown;
            const directionColor = isExacerbating ? 'text-red-500' : 'text-green-500';
            const directionBg = isExacerbating ? 'bg-red-50' : 'bg-green-50';

            return (
              <li key={driver.feature_key} className="flex flex-col gap-2">
                <div className="flex items-start justify-between">
                  
                  {/* Left: Icon & Label */}
                  <div className="flex items-center gap-3">
                    <div className={`p-2 rounded-md ${directionBg}`}>
                      <Icon className={`w-4 h-4 ${directionColor}`} />
                    </div>
                    <div>
                      <p className="text-sm font-semibold text-slate-800">
                        {meta.label}
                      </p>
                      <div className="flex items-center gap-2 mt-0.5">
                        <Badge variant="outline" className="text-[10px] px-1.5 py-0 text-slate-500 font-normal">
                          {meta.category}
                        </Badge>
                        {driver.source && (
                          <span className="text-xs text-slate-500 font-mono capitalize">
                            source: {driver.source}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Right: Direction & Weight */}
                  <div className="flex flex-col items-end gap-1">
                    <div className={`flex items-center text-xs font-semibold ${directionColor}`}>
                      {driver.direction === 'raises' ? 'Positive' : 'Negative'} contribution
                      <DirectionIcon className="w-3 h-3 ml-1" />
                    </div>
                    <span className="text-[10px] text-slate-400 font-mono">
                      Impact: {Math.abs(driver.impact_mg_dl).toFixed(1)} mg/dL
                    </span>
                  </div>
                </div>

                {/* Importance Bar */}
                <Progress 
                  value={Math.min((Math.abs(driver.impact_mg_dl) / 50) * 100, 100)} 
                  className="h-1.5 mt-1"
                  indicatorClassName={isExacerbating ? 'bg-red-400' : 'bg-green-400'}
                />
              </li>
            );
          })}
        </ul>

        {sortedDrivers.length === 0 && (
          <div className="py-8 text-center text-sm text-slate-500 flex flex-col items-center">
            <AlertTriangle className="w-8 h-8 text-slate-300 mb-2" />
            No significant drivers isolated for this prediction.
          </div>
        )}
      </CardContent>
    </Card>
  );
}
