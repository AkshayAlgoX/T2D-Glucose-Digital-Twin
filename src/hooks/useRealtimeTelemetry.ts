import { useState, useEffect, useRef } from 'react';
import { useTime } from '@/components/digital-twin/TimeContext';

export interface SubjectCache {
  cgm: { t: string; value: number | null; trend: string }[];
  risk: { t: string; p: number }[];
  alerts: { t: string; state: string }[];
  dataQuality: { t: string; status: string }[];
}

export function useRealtimeTelemetry(patientId: string) {
  const { asOf } = useTime() || {}; // Fallback if outside provider
  const [forecastResponse, setForecastResponse] = useState<any>(null);
  const [cache, setCache] = useState<SubjectCache>({ cgm: [], risk: [], alerts: [], dataQuality: [] });
  const [isConnected, setIsConnected] = useState(false);
  const [isStale, setIsStale] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!patientId) return;

    let eventSource: EventSource | null = null;
    let staleTimer: NodeJS.Timeout;
    
    // Clear stale forecast immediately on scrub
    setForecastResponse(null);

    const debounceTimer = setTimeout(() => {
      const resetStaleTimer = () => {
        setIsStale(false);
        clearTimeout(staleTimer);
        staleTimer = setTimeout(() => setIsStale(true), 15000);
      };

      const endpoint = asOf 
        ? `/api/patients/${patientId}/stream?as_of=${encodeURIComponent(asOf)}`
        : `/api/patients/${patientId}/stream`;

      eventSource = new EventSource(endpoint);

      eventSource.onopen = () => {
        setIsConnected(true);
        setError(null);
      };

      eventSource.onmessage = (event) => {
        resetStaleTimer();
        try {
          const raw = JSON.parse(event.data);
          setForecastResponse(raw);

          setCache(prev => {
            const newCache = { ...prev };
            
            if (raw.current?.measured_at) {
              const t = raw.current.measured_at;
              if (raw.current.value_mg_dl !== null) {
                // Avoid duplicates in a real app, but for now just push
                if (!newCache.cgm.some(c => c.t === t)) {
                  newCache.cgm = [...prev.cgm, { t, value: raw.current.value_mg_dl, trend: raw.current.trend_arrow }];
                }
              }
            }

            if (raw.spike_risk?.probability_120m !== undefined && raw.as_of) {
               if (!newCache.risk.some(r => r.t === raw.as_of)) {
                 newCache.risk = [...prev.risk, { t: raw.as_of, p: raw.spike_risk.probability_120m }];
               }
            }

            if (raw.alert?.state && raw.as_of) {
               if (!newCache.alerts.some(a => a.t === raw.as_of)) {
                 newCache.alerts = [...prev.alerts, { t: raw.as_of, state: raw.alert.state }];
               }
            }

            if (raw.data_quality?.status && raw.as_of) {
               if (!newCache.dataQuality.some(q => q.t === raw.as_of)) {
                 newCache.dataQuality = [...prev.dataQuality, { t: raw.as_of, status: raw.data_quality.status }];
               }
            }
            
            return newCache;
          });
        } catch (err) {
          setError(err instanceof Error ? err : new Error('Failed to parse telemetry'));
        }
      };

      eventSource.onerror = () => setIsConnected(false);
    }, 120);

    return () => {
      clearTimeout(debounceTimer);
      clearTimeout(staleTimer);
      if (eventSource) eventSource.close();
      setIsConnected(false);
    };
  }, [patientId, asOf]);

  return { forecast: forecastResponse, cache, isConnected, isStale, error };
}
