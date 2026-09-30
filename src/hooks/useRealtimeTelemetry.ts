import { useState, useEffect } from 'react';
import type { ForecastResponse, TelemetryDataPoint } from './TelemetryChartSuite';

interface UseRealtimeTelemetryOptions {
  /** Maximum number of historical points to keep in memory to prevent DOM/memory bloat */
  maxHistoricalPoints?: number;
}

interface UseRealtimeTelemetryReturn {
  forecast: ForecastResponse | null;
  isConnected: boolean;
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
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!patientId) return;

    let eventSource: EventSource;

    const connect = () => {
      // Initialize the native browser Server-Sent Events (SSE) connection
      eventSource = new EventSource(`/api/patients/${patientId}/stream`);

      eventSource.onopen = () => {
        setIsConnected(true);
        setError(null);
        console.info(`[Telemetry] Connected to digital twin stream for ${patientId}`);
      };

      eventSource.onmessage = (event) => {
        try {
          const chunk: ForecastResponse = JSON.parse(event.data);
          
          setForecastResponse((prev) => {
            const existingData = prev?.data || [];
            
            // 1. Partition the incoming chunk into Historical vs. Forecast
            const incomingHistorical = chunk.data.filter(d => d.historicalGlucose != null);
            const incomingForecast = chunk.data.filter(d => d.forecastGlucose != null);

            // 2. Isolate our existing historical state
            const existingHistorical = existingData.filter(d => d.historicalGlucose != null);

            // 3. Merge historical data using a Map to deduplicate by timestamp 
            // (Incoming late-arriving or corrected data overwrites existing)
            const historicalMap = new Map<string, TelemetryDataPoint>();
            existingHistorical.forEach(d => historicalMap.set(d.timestamp, d));
            incomingHistorical.forEach(d => historicalMap.set(d.timestamp, d));

            // 4. Reconstruct the array, sort chronologically, and apply the memory constraint
            const mergedHistorical = Array.from(historicalMap.values())
              .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
              .slice(-maxHistoricalPoints);

            // 5. Combine the stable historical baseline with the *fresh* 24-step forecast array
            const combinedData = [...mergedHistorical, ...incomingForecast]
              .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

            return {
              patientId: chunk.patientId,
              generatedAt: chunk.generatedAt,
              data: combinedData
            };
          });
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
      if (eventSource) {
        eventSource.close();
        setIsConnected(false);
      }
    };
  }, [patientId, maxHistoricalPoints]);

  return {
    forecast: forecastResponse,
    isConnected,
    error
  };
}
