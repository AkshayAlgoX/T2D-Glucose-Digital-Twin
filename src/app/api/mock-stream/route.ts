import { NextRequest } from 'next/server';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  let intervalId: NodeJS.Timeout;

  const stream = new ReadableStream({
    start(controller) {
      let tick = 0;
      
      const sendEvent = () => {
        tick++;
        
        // Simulate a scenario where spike_risk.tier transitions over time
        // Cycles every 15 seconds for quicker visual verification: 5s low, 5s elevated, 5s high
        let tier = 'low';
        const cycle = tick % 15;
        if (cycle < 5) tier = 'low';
        else if (cycle < 10) tier = 'elevated';
        else tier = 'high';

        const now = new Date();
        
        const data = [];
        
        // 5 data points of historical data
        for (let i = 0; i < 5; i++) {
          data.push({
            timestamp: new Date(now.getTime() - (5 - i) * 60000).toISOString(),
            historicalGlucose: 100 + Math.random() * 20,
            forecastGlucose: null,
            quantileLower: null,
            quantileUpper: null,
          });
        }
        
        // 24 data points of forecast data
        for (let i = 0; i < 24; i++) {
          data.push({
            timestamp: new Date(now.getTime() + (i + 1) * 60000).toISOString(),
            historicalGlucose: null,
            forecastGlucose: 120 + i * 2 + Math.random() * 10,
            quantileLower: 110 + i * 2,
            quantileUpper: 130 + i * 2,
            isSpikePredicted: tier !== 'low'
          });
        }

        const payload = {
          patientId: "patient-123",
          generatedAt: now.toISOString(),
          spike_risk: { tier },
          data,
          // Extra mock fields matching PredictiveInsightsPanel
          predictionConfidence: 0.85 + Math.random() * 0.1,
          predictedEvent: 'hyperglycemia_spike',
          drivers: [
            { feature_key: 'carbs_ingested_2h', direction: 'raises', importance: 0.8 + Math.random() * 0.1, raw_value: 45 },
            { feature_key: 'insulin_active_units', direction: 'lowers', importance: 0.5 + Math.random() * 0.1, raw_value: 2.5 }
          ]
        };

        try {
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(payload)}\n\n`));
        } catch (e) {
          clearInterval(intervalId);
        }
      };

      sendEvent(); // send first event immediately
      intervalId = setInterval(sendEvent, 1000); // emit every 1000ms
      
      request.signal.addEventListener('abort', () => {
        clearInterval(intervalId);
      });
    },
    cancel() {
      clearInterval(intervalId);
    }
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
    },
  });
}
