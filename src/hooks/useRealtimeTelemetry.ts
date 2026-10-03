import { useState, useEffect } from 'react';
import type { ForecastResponse, TelemetryDataPoint } from '@/types/digital-twin';

interface UseRealtimeTelemetryOptions {
  /** Maximum number of historical points to keep in memory to prevent DOM/memory bloat */
  maxHistoricalPoints?: number;
}

interface UseRealtimeTelemetryReturn {
  forecast: ForecastResponse | null;
  isConnected: boolean;
  isStale: boolean;
  error: Error | null;
}

/**
 * Custom hook to manage the real-time EventSource connection for the Digital Twin.
 * Appends streaming historical telemetry while seamlessly hot-swapping the AI's 
 * forward-looking 24-step forecast.
 */
export function useRealtimeTelemetry(
  patientId: string, 
  options: UseRealtimeTelemetryOptions = {}
): UseRealtimeTelemetryReturn {
  
  // Default to 120 points (e.g., 2 hours of 1-minute interval data)
  const { maxHistoricalPoints = 120 } = options;
  
  const [forecastResponse, setForecastResponse] = useState<ForecastResponse | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [isStale, setIsStale] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!patientId) return;

    let eventSource: EventSource;
    let staleTimer: NodeJS.Timeout;

    const resetStaleTimer = () => {
      setIsStale(false);
      clearTimeout(staleTimer);
      staleTimer = setTimeout(() => {
        setIsStale(true);
      }, 15000); // Flag as stale after 15 seconds without data
    };

    const connect = () => {
      // Initialize the native browser Server-Sent Events (SSE) connection
      // Temporarily point to mock-stream for stress-testing if env flag is set, otherwise use real backend contract
      const endpoint = process.env.NEXT_PUBLIC_USE_MOCK === 'true' 
        ? `/api/mock-stream`
        : `/api/patients/${patientId}/stream`;
        
      eventSource = new EventSource(endpoint);

      eventSource.onopen = () => {
        setIsConnected(true);
        setError(null);
        console.info(`[Telemetry] Connected to digital twin stream for ${patientId}`);
      };

      eventSource.onmessage = (event) => {
        resetStaleTimer();
        try {
          const raw = JSON.parse(event.data);
          
          // Determine if we are processing the mock stream or the real stream
          // Mock stream is already mapped to the frontend shape.
          // Real stream emits StreamEvent where the payload is nested.
          let chunk: ForecastResponse;
          if (raw.event === "forecast.updated" && raw.payload) {
             import('@/lib/api-mapper').then(({ mapBackendForecast }) => {
                const mapped = mapBackendForecast(raw.payload);
                processChunk(mapped);
             });
             return;
          } else {
             chunk = raw as ForecastResponse;
             processChunk(chunk);
          }

          function processChunk(chunk: ForecastResponse) {
            setForecastResponse((prev) => {
              const existingData = prev?.data || [];
              
              const incomingHistorical = chunk.data.filter(d => d.historicalGlucose != null);
              const incomingForecast = chunk.data.filter(d => d.forecastGlucose != null);

              const existingHistorical = existingData.filter(d => d.historicalGlucose != null);

              const historicalMap = new Map<string, TelemetryDataPoint>();
              existingHistorical.forEach(d => historicalMap.set(d.timestamp, d));
              incomingHistorical.forEach(d => historicalMap.set(d.timestamp, d));

              const mergedHistorical = Array.from(historicalMap.values())
                .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
                .slice(-maxHistoricalPoints);

              const combinedData = [...mergedHistorical, ...incomingForecast]
                .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

              return {
                patientId: chunk.patientId,
                generatedAt: chunk.generatedAt,
                spike_risk: chunk.spike_risk,
                spikeProbability120m: chunk.spikeProbability120m,
                predictedEvent: chunk.predictedEvent,
                drivers: chunk.drivers,
                _raw_data_quality: chunk._raw_data_quality,
                data: combinedData
              } as ForecastResponse;
            });
          }
        } catch (err) {
          console.error('[Telemetry] JSON Parse Error:', err);
          setError(err instanceof Error ? err : new Error('Failed to parse telemetry chunk'));
        }
      };

      eventSource.onerror = (err) => {
        // SSE natively auto-reconnects on drop. We update the UI state.
        console.error('[Telemetry] Connection lost. Attempting reconnect...', err);
        setIsConnected(false);
      };
    };

    connect();

    // Cleanup phase: Teardown connection on unmount or when patientId changes
    return () => {
      clearTimeout(staleTimer);
      if (eventSource) {
        eventSource.close();
        setIsConnected(false);
      }
    };
  }, [patientId, maxHistoricalPoints]);

  return {
    forecast: forecastResponse,
    isConnected,
    isStale,
    error
  };
}
