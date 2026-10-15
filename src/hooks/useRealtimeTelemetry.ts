import { useState, useEffect, useRef } from 'react';
import { useTime } from '@/components/digital-twin/TimeContext';
import { ForecastResponse } from '@/types/forecast-response';
import { StreamEvent } from '@/types/stream-event';
import { SubjectStore } from '@/lib/types';
import { checkInvariants } from '@/lib/invariants';
import { ForecastResponseSchema, StreamEventSchema } from '@/lib/zod-schemas';

export function useRealtimeTelemetry(patientId: string) {
  const { asOf } = useTime() || {}; 
  
  const [forecastResponse, setForecastResponse] = useState<ForecastResponse | null>(null);
  const [cache, setCache] = useState<SubjectStore>({ patientId, cgm: [], risk: [], alerts: [], dataQuality: [] });
  const [isConnected, setIsConnected] = useState(false);
  const [isStale, setIsStale] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const epochRef = useRef(0);
  const lastEventTimeRef = useRef<number>(0);
  const checkStaleTimerRef = useRef<NodeJS.Timeout | undefined>(undefined);

  useEffect(() => {
    if (cache.patientId !== patientId) {
      setCache({ patientId, cgm: [], risk: [], alerts: [], dataQuality: [] });
      setForecastResponse(null);
    }
  }, [patientId, cache.patientId]);

  useEffect(() => {
    if (!patientId) return;

    const currentEpoch = ++epochRef.current;
    const ac = new AbortController();
    
    setForecastResponse(null);
    setIsConnected(false);
    setError(null);
    setIsStale(false);
    lastEventTimeRef.current = Date.now();

    const checkStaleness = () => {
       if (ac.signal.aborted || currentEpoch !== epochRef.current) return;
       // Transport freshness only; clinical reading staleness comes from data_quality.
       if (asOf) {
          setIsStale(false); // Replay is not stale, it is historical.
       } else {
          if (Date.now() - lastEventTimeRef.current > 15000) {
             setIsStale(true);
          }
       }
    };

    if (!asOf) {
      clearInterval(checkStaleTimerRef.current);
      checkStaleTimerRef.current = setInterval(checkStaleness, 5000);
    }

    const endpoint = asOf 
      ? `/api/patients/${patientId}/stream?as_of=${encodeURIComponent(asOf)}`
      : `/api/patients/${patientId}/stream`;

    const fetchData = async () => {
      try {
        const res = await fetch(endpoint, { signal: ac.signal });
        if (ac.signal.aborted || currentEpoch !== epochRef.current) return;
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        setIsConnected(true);

        if (asOf) {
          // Pinned time is one-off
          const text = await res.text();
          // parse the SSE output roughly to get the last event
          const lines = text.split('\n');
          let lastData = '';
          for (const line of lines) {
             if (line.startsWith('data: ')) {
               lastData = line.slice(6);
             }
          }
          if (lastData && currentEpoch === epochRef.current && !ac.signal.aborted) {
             const parsed = StreamEventSchema.parse(JSON.parse(lastData));
             const raw = (parsed.event === 'forecast.updated'
                 ? ForecastResponseSchema.parse(parsed.payload)
                 : parsed.payload) as ForecastResponse; // Audited schema overlap

             if (raw?.subject?.subject_id === patientId) {
                checkInvariants(raw);
                setForecastResponse(raw);
             }
          }
          return;
        }

        // Fetch streaming
        const reader = res.body?.getReader();
        if (!reader) return;
        
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (ac.signal.aborted || currentEpoch !== epochRef.current) return;
          if (done) break;
          
          buffer += decoder.decode(value, { stream: true });
          
          let boundaryIndex;
          while ((boundaryIndex = buffer.indexOf('\n\n')) !== -1 || (boundaryIndex = buffer.indexOf('\r\n\r\n')) !== -1) {
            const sepLen = buffer.startsWith('\r\n\r\n', boundaryIndex) ? 4 : 2;
            const block = buffer.slice(0, boundaryIndex);
            buffer = buffer.slice(boundaryIndex + sepLen);

            const lines = block.split(/\r?\n/);
            let eventData = '';

            for (const line of lines) {
              if (line.startsWith('data: ')) eventData += line.slice(6) + '\n';
            }

            if (eventData && currentEpoch === epochRef.current) {
              try {
                const parsedEvent = StreamEventSchema.parse(JSON.parse(eventData.trim()));
                const raw = (parsedEvent.event === 'forecast.updated' 
                   ? ForecastResponseSchema.parse(parsedEvent.payload)
                   : parsedEvent.payload) as ForecastResponse /* Audited semantic match */; // other events

                if (raw?.subject?.subject_id !== patientId) {
                   continue; // discard mismatched
                }

                checkInvariants(raw);
                lastEventTimeRef.current = Date.now();
                setIsStale(false);

                setForecastResponse(raw);
                
                setCache(prev => {
                  if (prev.patientId !== patientId) return prev;
                  const newCache = { ...prev };
                  
                  if (raw.current?.measured_at && raw.current.value_mg_dl != null) {
                    const t = raw.current.measured_at;
                    if (!newCache.cgm.some(c => c.t === t)) {
                      newCache.cgm = [...prev.cgm, { t, value: raw.current.value_mg_dl, trend: raw.current.trend_arrow || '' }];
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
              } catch (err: unknown) {
                 console.error("Stream parse error or invariant failure", err);
                 // Stop consuming a rejected stream, including events in this chunk.
                 try { await reader.cancel(); } catch { /* Preserve the contract error. */ }
                 throw new Error('contract-invalid');
              }
            }
          }
        }
      } catch (err: unknown) {
        if ((err as Error).name === 'AbortError') return;
        if (currentEpoch === epochRef.current && !ac.signal.aborted) {
           if ((err as Error)?.message?.includes('404')) {
             setError(new Error('patient-not-found'));
           } else if ((err as Error)?.message?.includes('contract-invalid')) {
             setError(err as Error);
           } else if ((err as Error)?.name === 'ZodError') {
             setError(new Error('contract-invalid'));
           } else {
             setError(new Error('unavailable'));
           }
           setIsConnected(false);
        }
      } finally {
        // EOF is a closed connection even when the last valid forecast remains visible.
        // A superseded or unmounted request must not change the current stream's status.
        if (currentEpoch === epochRef.current && !ac.signal.aborted) {
          clearInterval(checkStaleTimerRef.current);
          setIsConnected(false);
        }
      }
    };

    fetchData();

    return () => {
      ac.abort();
      clearInterval(checkStaleTimerRef.current);
    };
  }, [patientId, asOf]);

  // Effects clear the previous subject after render. Never expose that subject's
  // values during the intervening render of a newly selected subject.
  const currentSubject = cache.patientId === patientId;
  return {
    forecast: currentSubject && forecastResponse?.subject.subject_id === patientId ? forecastResponse : null,
    cache: currentSubject ? cache : { patientId, cgm: [], risk: [], alerts: [], dataQuality: [] },
    isConnected: currentSubject && isConnected,
    isStale: currentSubject && isStale,
    isReplay: !!asOf,
    error: currentSubject ? error : null,
  };
}
