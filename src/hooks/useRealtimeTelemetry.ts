import { useState, useEffect, useRef, useCallback } from 'react';
import { useTime } from '@/components/digital-twin/TimeContext';
import { ForecastResponse } from '@/types/forecast-response';
import { StreamEvent } from '@/types/stream-event';
import { SubjectStore } from '@/lib/types';
import { checkInvariants } from '@/lib/invariants';
import { ForecastResponseSchema, StreamEventSchema } from '@/lib/zod-schemas';

export type ConnectionStatus = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';

export interface UseRealtimeTelemetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
}

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_DELAY_MS = process.env.NODE_ENV === 'test' ? 25 : 1000;

export function useRealtimeTelemetry(patientId: string, options?: UseRealtimeTelemetryOptions) {
  const { asOf } = useTime() || {}; 
  const maxRetries = options?.maxRetries ?? DEFAULT_MAX_RETRIES;
  const baseDelayMs = options?.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;

  const [forecastResponse, setForecastResponse] = useState<ForecastResponse | null>(null);
  const [cache, setCache] = useState<SubjectStore>({ patientId, cgm: [], risk: [], alerts: [], dataQuality: [] });
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('connecting');
  const [isStale, setIsStale] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [retryAttempt, setRetryAttempt] = useState(0);
  const [manualRetryNonce, setManualRetryNonce] = useState(0);

  const epochRef = useRef(0);
  const lastPatientIdRef = useRef<string>(patientId);
  const lastEventTimeRef = useRef<number>(0);
  const lastEventIdRef = useRef<string | null>(null);
  const checkStaleTimerRef = useRef<NodeJS.Timeout | undefined>(undefined);
  const retryTimerRef = useRef<NodeJS.Timeout | undefined>(undefined);
  const activeReaderRef = useRef<ReadableStreamDefaultReader<Uint8Array> | null>(null);
  const retryCountRef = useRef(0);

  const retry = useCallback(() => {
    if (retryTimerRef.current) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = undefined;
    }
    retryCountRef.current = 0;
    setRetryAttempt(0);
    setError(null);
    setConnectionStatus('connecting');
    setManualRetryNonce(n => n + 1);
  }, []);

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

    if (retryTimerRef.current) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = undefined;
    }
    if (activeReaderRef.current) {
      try { activeReaderRef.current.cancel(); } catch { /* ignore */ }
      activeReaderRef.current = null;
    }

    if (lastPatientIdRef.current !== patientId) {
      lastPatientIdRef.current = patientId;
      setForecastResponse(null);
      setCache({ patientId, cgm: [], risk: [], alerts: [], dataQuality: [] });
      lastEventIdRef.current = null;
      retryCountRef.current = 0;
      setRetryAttempt(0);
    }

    setConnectionStatus(retryCountRef.current > 0 ? 'reconnecting' : 'connecting');
    setError(null);
    setIsStale(false);
    lastEventTimeRef.current = Date.now();

    const checkStaleness = () => {
      if (ac.signal.aborted || currentEpoch !== epochRef.current) return;
      if (asOf) {
        setIsStale(false);
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

    const connect = async () => {
      try {
        const headers: Record<string, string> = {};
        if (lastEventIdRef.current && !asOf) {
          headers['Last-Event-ID'] = lastEventIdRef.current;
        }

        const res = await fetch(endpoint, { signal: ac.signal, headers });
        if (ac.signal.aborted || currentEpoch !== epochRef.current) return;

        if (!res.ok) {
          if (res.status === 404) {
            throw new Error('patient-not-found');
          }
          throw new Error(`HTTP ${res.status}`);
        }

        if (asOf) {
          setConnectionStatus('connected');
          const text = await res.text();
          if (ac.signal.aborted || currentEpoch !== epochRef.current) return;
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
              : parsed.payload) as ForecastResponse;

            if (raw?.subject?.subject_id === patientId) {
              checkInvariants(raw);
              setForecastResponse(raw);
            }
          }
          setConnectionStatus('disconnected');
          return;
        }

        const reader = res.body?.getReader();
        if (!reader) {
          setConnectionStatus('disconnected');
          return;
        }
        activeReaderRef.current = reader;
        setConnectionStatus('connected');
        setError(null);
        // Do NOT reset retryCountRef here! Receiving an HTTP 200 header does not prove
        // the stream has delivered a valid event or remained healthy. Resetting here allows
        // repeated 200 + immediate stream errors to retry unboundedly.
        // The retry counter is reset only after a validated event is processed below.

        const decoder = new TextDecoder();
        let buffer = '';

        // Clean EOF vs premature completion note:
        // The backend replay stream terminates naturally when all cohort readings up to pc.ps.n
        // are delivered, resolving reader.read() with { done: true, value: undefined }.
        // The existing protocol does not transmit an application-level 'stream.completed' event.
        // A clean EOF with 0 events is indistinguishable at the transport level from an upstream
        // proxy closing an idle stream. Per specification, clean EOF is treated as expected
        // normal completion (error: null, disconnected) rather than a transport error, avoiding
        // tight reconnect loops. Genuine transport errors (read() throwing) are bounded to maxRetries.
        while (true) {
          const { done, value } = await reader.read();
          if (ac.signal.aborted || currentEpoch !== epochRef.current) return;
          if (done) {
            activeReaderRef.current = null;
            setConnectionStatus('disconnected');
            // Clean EOF is a legitimate stream completion, not a transport error.
            // Reset any transient retry tracking and ensure no error banner is displayed.
            retryCountRef.current = 0;
            setRetryAttempt(0);
            break;
          }

          buffer += decoder.decode(value, { stream: true });

          let boundaryIndex;
          while ((boundaryIndex = buffer.indexOf('\n\n')) !== -1 || (boundaryIndex = buffer.indexOf('\r\n\r\n')) !== -1) {
            const sepLen = buffer.startsWith('\r\n\r\n', boundaryIndex) ? 4 : 2;
            const block = buffer.slice(0, boundaryIndex);
            buffer = buffer.slice(boundaryIndex + sepLen);

            const lines = block.split(/\r?\n/);
            let eventData = '';
            let currentBlockId: string | null = null;

            for (const line of lines) {
              if (line.startsWith('id: ')) {
                currentBlockId = line.slice(4).trim();
              } else if (line.startsWith('data: ')) {
                eventData += line.slice(6) + '\n';
              }
            }

            if (eventData && currentEpoch === epochRef.current && !ac.signal.aborted) {
              try {
                const parsedEvent = StreamEventSchema.parse(JSON.parse(eventData.trim()));
                const raw = (parsedEvent.event === 'forecast.updated' 
                  ? ForecastResponseSchema.parse(parsedEvent.payload)
                  : parsedEvent.payload) as ForecastResponse;

                if (raw?.subject?.subject_id !== patientId) {
                  continue;
                }

                checkInvariants(raw);
                lastEventIdRef.current = parsedEvent.event_id || currentBlockId;
                lastEventTimeRef.current = Date.now();
                setIsStale(false);

                // Stream delivery health verified: reset consecutive failure counter only after
                // a valid event has been received, parsed, and checked for invariants.
                retryCountRef.current = 0;
                setRetryAttempt(0);
                setError(null);

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
                try { await reader.cancel(); } catch { /* ignore */ }
                activeReaderRef.current = null;
                throw new Error('contract-invalid');
              }
            }
          }
        }
      } catch (err: unknown) {
        if ((err as Error).name === 'AbortError' || ac.signal.aborted || currentEpoch !== epochRef.current) return;
        activeReaderRef.current = null;

        const errMessage = (err as Error)?.message || '';
        const isNotFound = errMessage.includes('404') || errMessage.includes('patient-not-found');
        const isContractInvalid = errMessage.includes('contract-invalid') || (err as Error)?.name === 'ZodError';

        if (isNotFound) {
          setError(new Error('patient-not-found'));
          setConnectionStatus('disconnected');
          retryCountRef.current = 0;
          setRetryAttempt(0);
          return;
        }

        if (isContractInvalid) {
          setError(new Error('contract-invalid'));
          setConnectionStatus('disconnected');
          retryCountRef.current = 0;
          setRetryAttempt(0);
          return;
        }

        if (!asOf && retryCountRef.current < maxRetries) {
          const attempt = retryCountRef.current + 1;
          retryCountRef.current = attempt;
          setRetryAttempt(attempt);
          setConnectionStatus('reconnecting');
          const delay = Math.min(baseDelayMs * Math.pow(2, attempt - 1), 8000);
          retryTimerRef.current = setTimeout(() => {
            if (currentEpoch === epochRef.current && !ac.signal.aborted) {
              connect();
            }
          }, delay);
        } else {
          setError(new Error('unavailable'));
          setConnectionStatus('disconnected');
        }
      } finally {
        if (currentEpoch === epochRef.current && !ac.signal.aborted && activeReaderRef.current === null && connectionStatus !== 'reconnecting') {
          clearInterval(checkStaleTimerRef.current);
        }
      }
    };

    connect();

    return () => {
      ac.abort();
      if (retryTimerRef.current) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = undefined;
      }
      if (checkStaleTimerRef.current) {
        clearInterval(checkStaleTimerRef.current);
        checkStaleTimerRef.current = undefined;
      }
      if (activeReaderRef.current) {
        try { activeReaderRef.current.cancel(); } catch { /* ignore */ }
        activeReaderRef.current = null;
      }
    };
  }, [patientId, asOf, manualRetryNonce, maxRetries, baseDelayMs]);

  const currentSubject = cache.patientId === patientId;
  const isConnected = currentSubject && connectionStatus === 'connected';

  return {
    forecast: currentSubject && forecastResponse?.subject.subject_id === patientId ? forecastResponse : null,
    cache: currentSubject ? cache : { patientId, cgm: [], risk: [], alerts: [], dataQuality: [] },
    isConnected,
    isStale: currentSubject && isStale,
    isReplay: !!asOf,
    error: currentSubject ? error : null,
    connectionStatus: currentSubject ? connectionStatus : 'connecting',
    retryCount: currentSubject ? retryAttempt : 0,
    retry,
  };
}
