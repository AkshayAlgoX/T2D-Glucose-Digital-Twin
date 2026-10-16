import { useState, useEffect, useRef, useCallback } from 'react';
import { useTime } from '@/components/digital-twin/TimeContext';
import { ForecastResponse } from '@/types/forecast-response';
import { StreamEvent } from '@/types/stream-event';
import { SubjectStore } from '@/lib/types';
import { checkInvariants } from '@/lib/invariants';
import { ForecastResponseSchema, StreamEventSchema, AlertSchema, DataQualitySchema } from '@/lib/zod-schemas';

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
  // Counts only forecast.updated events on the current connection.
  // Companion events (alert, data_quality, twin.recalibrated) are intentionally excluded
  // so that a forecast+companion pair on every brief connection cannot defeat bounded retries.
  const forecastEventsOnCurrentConnectionRef = useRef(0);

  const retry = useCallback(() => {
    if (retryTimerRef.current) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = undefined;
    }
    if (stabilityTimerRef.current) {
      clearTimeout(stabilityTimerRef.current);
      stabilityTimerRef.current = undefined;
    }
    forecastEventsOnCurrentConnectionRef.current = 0;
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
          // Validate the entire finite response before applying its final event.
          // Earlier forecasts must neither conceal invalid events nor change the
          // existing last-event selection semantics when the final event is ancillary.
          let applyLastEvent: (() => void) | undefined;
          try {
            for (const block of text.split(/\r?\n\r?\n/)) {
              const data = block.split(/\r?\n/).flatMap(line => {
                if (line === 'data') return [''];
                if (!line.startsWith('data:')) return [];
                const value = line.slice(5);
                return [value.startsWith(' ') ? value.slice(1) : value];
              });
              if (data.length === 0) continue; // Comments and metadata are not data events.

              const parsed = StreamEventSchema.parse(JSON.parse(data.join('\n')));
              applyLastEvent = undefined;
              switch (parsed.event) {
                case 'forecast.updated': {
                  const raw = ForecastResponseSchema.parse(parsed.payload) as unknown as ForecastResponse;
                  checkInvariants(raw);
                  if (parsed.subject_id === patientId && raw.subject.subject_id === patientId) {
                    applyLastEvent = () => setForecastResponse(raw);
                  }
                  break;
                }
                case 'alert.raised':
                case 'alert.cleared': {
                  const alertPayload = AlertSchema.parse(parsed.payload);
                  if (parsed.subject_id === patientId) {
                    applyLastEvent = () => setForecastResponse(prev => (prev ? { ...prev, alert: alertPayload } : null));
                  }
                  break;
                }
                case 'data_quality.changed': {
                  const dqPayload = DataQualitySchema.parse(parsed.payload);
                  if (parsed.subject_id === patientId) {
                    applyLastEvent = () => setForecastResponse(prev => (prev ? { ...prev, data_quality: dqPayload } : null));
                  }
                  break;
                }
                case 'twin.recalibrated': {
                  if (typeof parsed.payload !== 'object' || parsed.payload === null || Array.isArray(parsed.payload)) {
                    throw new Error('contract-invalid');
                  }
                  break;
                }
              }
            }
            applyLastEvent?.();
          } catch (err: unknown) {
            console.error("Replay parse error or invariant failure", err);
            throw new Error('contract-invalid');
          }
          setConnectionStatus('disconnected');
          return;
        }

        const reader = res.body?.getReader();
        if (!reader) {
          throw new Error('missing-body');
        }
        activeReaderRef.current = reader;
        setConnectionStatus('connected');
        setError(null);

        forecastEventsOnCurrentConnectionRef.current = 0;
        if (stabilityTimerRef.current) {
          clearTimeout(stabilityTimerRef.current);
          stabilityTimerRef.current = undefined;
        }

        // Sustainable healthy connection timer: if connection stays open and receives data
        // for stableDurationMs, it also satisfies stability and resets the retry budget.
        // Requires at least one valid forecast event to prevent a stream of companion-only
        // events from satisfying the duration-based stability condition.
        if (stableDurationMs > 0 && !asOf) {
          stabilityTimerRef.current = setTimeout(() => {
            if (currentEpoch === epochRef.current && !ac.signal.aborted && activeReaderRef.current !== null && forecastEventsOnCurrentConnectionRef.current > 0) {
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

                // Envelope subject validation: ignore events for other subjects
                if (parsedEvent.subject_id !== patientId) {
                  continue;
                }

                switch (parsedEvent.event) {
                  case 'forecast.updated': {
                    const forecastPayload = ForecastResponseSchema.parse(parsedEvent.payload) as unknown as ForecastResponse;
                    if (forecastPayload.subject?.subject_id !== patientId) {
                      continue;
                    }
                    checkInvariants(forecastPayload);
                    setForecastResponse(forecastPayload);

                    setCache(prev => {
                      if (prev.patientId !== patientId) return prev;
                      const newCache = { ...prev };

                      if (forecastPayload.current?.measured_at && forecastPayload.current.value_mg_dl != null) {
                        const t = forecastPayload.current.measured_at;
                        if (!newCache.cgm.some(c => c.t === t)) {
                          newCache.cgm = [...prev.cgm, { t, value: forecastPayload.current.value_mg_dl, trend: forecastPayload.current.trend_arrow || '' }];
                        }
                      }

                      if (forecastPayload.spike_risk?.probability_120m !== undefined && forecastPayload.as_of) {
                        if (!newCache.risk.some(r => r.t === forecastPayload.as_of)) {
                          newCache.risk = [...prev.risk, { t: forecastPayload.as_of, p: forecastPayload.spike_risk.probability_120m }];
                        }
                      }

                      if (forecastPayload.alert?.state && forecastPayload.as_of) {
                        if (!newCache.alerts.some(a => a.t === forecastPayload.as_of)) {
                          newCache.alerts = [...prev.alerts, { t: forecastPayload.as_of, state: forecastPayload.alert.state }];
                        }
                      }

                      if (forecastPayload.data_quality?.status && forecastPayload.as_of) {
                        if (!newCache.dataQuality.some(q => q.t === forecastPayload.as_of)) {
                          newCache.dataQuality = [...prev.dataQuality, { t: forecastPayload.as_of, status: forecastPayload.data_quality.status }];
                        }
                      }

                      return newCache;
                    });
                    break;
                  }

                  case 'alert.raised':
                  case 'alert.cleared': {
                    const alertPayload = AlertSchema.parse(parsedEvent.payload);
                    setForecastResponse(prev => (prev ? { ...prev, alert: alertPayload } : null));

                    setCache(prev => {
                      if (prev.patientId !== patientId) return prev;
                      const t = alertPayload.since || parsedEvent.emitted_at;
                      if (!prev.alerts.some(a => a.t === t && a.state === alertPayload.state)) {
                        return {
                          ...prev,
                          alerts: [...prev.alerts, { t, state: alertPayload.state }],
                        };
                      }
                      return prev;
                    });
                    break;
                  }

                  case 'data_quality.changed': {
                    const dqPayload = DataQualitySchema.parse(parsedEvent.payload);
                    setForecastResponse(prev => (prev ? { ...prev, data_quality: dqPayload } : null));

                    setCache(prev => {
                      if (prev.patientId !== patientId) return prev;
                      const t = dqPayload.last_cgm_at || parsedEvent.emitted_at;
                      if (!prev.dataQuality.some(q => q.t === t && q.status === dqPayload.status)) {
                        return {
                          ...prev,
                          dataQuality: [...prev.dataQuality, { t, status: dqPayload.status }],
                        };
                      }
                      return prev;
                    });
                    break;
                  }

                  case 'twin.recalibrated': {
                    if (typeof parsedEvent.payload !== 'object' || parsedEvent.payload === null || Array.isArray(parsedEvent.payload)) {
                      throw new Error('contract-invalid');
                    }
                    // Supported per contract: ignore payload safely in UI without mutating state
                    break;
                  }
                }

                lastEventIdRef.current = parsedEvent.event_id || currentBlockId;
                lastEventTimeRef.current = Date.now();
                setIsStale(false);

                // Event-count stability: only forecast.updated events count toward the
                // stableEventsThreshold budget. Companion events (alert, data_quality,
                // twin.recalibrated) are excluded so that a forecast+companion pair on
                // every brief, flapping connection cannot reset the retry budget indefinitely.
                if (parsedEvent.event === 'forecast.updated') {
                  forecastEventsOnCurrentConnectionRef.current += 1;
                  if (forecastEventsOnCurrentConnectionRef.current >= stableEventsThreshold) {
                    retryCountRef.current = 0;
                    setRetryAttempt(0);
                    setError(null);
                    if (stabilityTimerRef.current) {
                      clearTimeout(stabilityTimerRef.current);
                      stabilityTimerRef.current = undefined;
                    }
                  }
                }
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
