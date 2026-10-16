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
  stableEventsThreshold?: number;
  stableDurationMs?: number;
  stalenessThresholdMs?: number;
  stalenessIntervalMs?: number;
}

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_DELAY_MS = process.env.NODE_ENV === 'test' ? 25 : 1000;
const DEFAULT_STABLE_EVENTS_THRESHOLD = 2;
const DEFAULT_STABLE_DURATION_MS = 10000;
const DEFAULT_STALENESS_THRESHOLD_MS = 15000;
const DEFAULT_STALENESS_INTERVAL_MS = 5000;

export function useRealtimeTelemetry(patientId: string, options?: UseRealtimeTelemetryOptions) {
  const { asOf } = useTime() || {}; 
  const maxRetries = options?.maxRetries ?? DEFAULT_MAX_RETRIES;
  const baseDelayMs = options?.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const stableEventsThreshold = options?.stableEventsThreshold ?? DEFAULT_STABLE_EVENTS_THRESHOLD;
  const stableDurationMs = options?.stableDurationMs ?? DEFAULT_STABLE_DURATION_MS;
  const stalenessThresholdMs = options?.stalenessThresholdMs ?? DEFAULT_STALENESS_THRESHOLD_MS;
  const stalenessIntervalMs = options?.stalenessIntervalMs ?? DEFAULT_STALENESS_INTERVAL_MS;

  const [forecastResponse, setForecastResponse] = useState<ForecastResponse | null>(null);
  const [cache, setCache] = useState<SubjectStore>({ patientId, cgm: [], risk: [], alerts: [], dataQuality: [] });
  const [connectionStatus, setConnectionStatusState] = useState<ConnectionStatus>('connecting');
  const connectionStatusRef = useRef<ConnectionStatus>('connecting');

  const setConnectionStatus = useCallback((status: ConnectionStatus) => {
    connectionStatusRef.current = status;
    setConnectionStatusState(status);
  }, []);

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
  const stabilityTimerRef = useRef<NodeJS.Timeout | undefined>(undefined);
  const activeReaderRef = useRef<ReadableStreamDefaultReader<Uint8Array> | null>(null);
  const retryCountRef = useRef(0);
  const eventsOnCurrentConnectionRef = useRef(0);

  const retry = useCallback(() => {
    if (retryTimerRef.current) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = undefined;
    }
    if (stabilityTimerRef.current) {
      clearTimeout(stabilityTimerRef.current);
      stabilityTimerRef.current = undefined;
    }
    eventsOnCurrentConnectionRef.current = 0;
    retryCountRef.current = 0;
    setRetryAttempt(0);
    setError(null);
    setConnectionStatus('connecting');
    setManualRetryNonce(n => n + 1);
  }, [setConnectionStatus]);

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
        if (Date.now() - lastEventTimeRef.current > stalenessThresholdMs) {
          setIsStale(true);
        }
      }
    };

    if (!asOf) {
      clearInterval(checkStaleTimerRef.current);
      checkStaleTimerRef.current = setInterval(checkStaleness, stalenessIntervalMs);
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
          if (checkStaleTimerRef.current) {
            clearInterval(checkStaleTimerRef.current);
            checkStaleTimerRef.current = undefined;
          }
          return;
        }
        activeReaderRef.current = reader;
        setConnectionStatus('connected');
        setError(null);

        eventsOnCurrentConnectionRef.current = 0;
        if (stabilityTimerRef.current) {
          clearTimeout(stabilityTimerRef.current);
          stabilityTimerRef.current = undefined;
        }

        // Sustainable healthy connection timer: if connection stays open and receives data
        // for stableDurationMs, it also satisfies stability and resets the retry budget.
        if (stableDurationMs > 0 && !asOf) {
          stabilityTimerRef.current = setTimeout(() => {
            if (currentEpoch === epochRef.current && !ac.signal.aborted && activeReaderRef.current !== null && eventsOnCurrentConnectionRef.current > 0) {
              retryCountRef.current = 0;
              setRetryAttempt(0);
              setError(null);
            }
          }, stableDurationMs);
        }

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
            // Reset transient retry tracking and clean up timers without exposing an error banner.
            retryCountRef.current = 0;
            setRetryAttempt(0);
            if (stabilityTimerRef.current) {
              clearTimeout(stabilityTimerRef.current);
              stabilityTimerRef.current = undefined;
            }
            if (checkStaleTimerRef.current) {
              clearInterval(checkStaleTimerRef.current);
              checkStaleTimerRef.current = undefined;
            }
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

                // Stability condition: require at least stableEventsThreshold consecutive valid
                // events on this connection before resetting the failure budget.
                // A single event followed by immediate failure does NOT reset the budget,
                // strictly preventing infinite flapping/reconnection loops.
                eventsOnCurrentConnectionRef.current += 1;
                if (eventsOnCurrentConnectionRef.current >= stableEventsThreshold) {
                  retryCountRef.current = 0;
                  setRetryAttempt(0);
                  setError(null);
                  if (stabilityTimerRef.current) {
                    clearTimeout(stabilityTimerRef.current);
                    stabilityTimerRef.current = undefined;
                  }
                }

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
          if (stabilityTimerRef.current) {
            clearTimeout(stabilityTimerRef.current);
            stabilityTimerRef.current = undefined;
          }
          if (checkStaleTimerRef.current) {
            clearInterval(checkStaleTimerRef.current);
            checkStaleTimerRef.current = undefined;
          }
          return;
        }

        if (isContractInvalid) {
          setError(new Error('contract-invalid'));
          setConnectionStatus('disconnected');
          retryCountRef.current = 0;
          setRetryAttempt(0);
          if (stabilityTimerRef.current) {
            clearTimeout(stabilityTimerRef.current);
            stabilityTimerRef.current = undefined;
          }
          if (checkStaleTimerRef.current) {
            clearInterval(checkStaleTimerRef.current);
            checkStaleTimerRef.current = undefined;
          }
          return;
        }

        if (!asOf && retryCountRef.current < maxRetries) {
          const attempt = retryCountRef.current + 1;
          retryCountRef.current = attempt;
          setRetryAttempt(attempt);
          setConnectionStatus('reconnecting');
          if (stabilityTimerRef.current) {
            clearTimeout(stabilityTimerRef.current);
            stabilityTimerRef.current = undefined;
          }
          // Note: checkStaleTimerRef is INTENTIONALLY preserved during reconnecting
          // so that staleness is actively detected if reconnection exceeds stalenessThresholdMs.
          const delay = Math.min(baseDelayMs * Math.pow(2, attempt - 1), 8000);
          retryTimerRef.current = setTimeout(() => {
            if (currentEpoch === epochRef.current && !ac.signal.aborted) {
              connect();
            }
          }, delay);
        } else {
          setError(new Error('unavailable'));
          setConnectionStatus('disconnected');
          if (stabilityTimerRef.current) {
            clearTimeout(stabilityTimerRef.current);
            stabilityTimerRef.current = undefined;
          }
          if (checkStaleTimerRef.current) {
            clearInterval(checkStaleTimerRef.current);
            checkStaleTimerRef.current = undefined;
          }
        }
      } finally {
        if (currentEpoch === epochRef.current && !ac.signal.aborted) {
          // Check live status via connectionStatusRef to avoid stale closure references.
          // In 'reconnecting', staleness monitoring remains operational.
          if (connectionStatusRef.current === 'disconnected' && activeReaderRef.current === null) {
            if (checkStaleTimerRef.current) {
              clearInterval(checkStaleTimerRef.current);
              checkStaleTimerRef.current = undefined;
            }
          }
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
      if (stabilityTimerRef.current) {
        clearTimeout(stabilityTimerRef.current);
        stabilityTimerRef.current = undefined;
      }
      if (activeReaderRef.current) {
        try { activeReaderRef.current.cancel(); } catch { /* ignore */ }
        activeReaderRef.current = null;
      }
    };
  }, [
    patientId,
    asOf,
    manualRetryNonce,
    maxRetries,
    baseDelayMs,
    stableEventsThreshold,
    stableDurationMs,
    stalenessThresholdMs,
    stalenessIntervalMs,
    setConnectionStatus,
  ]);

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
