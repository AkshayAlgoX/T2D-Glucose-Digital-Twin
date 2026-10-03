import { NextRequest, NextResponse } from 'next/server';
import { validateForecastResponse, validateForecastRequest } from '@/lib/schema-validator';

export async function POST(request: NextRequest) {
  const backendUrl = process.env.BACKEND_URL;
  if (!backendUrl) return NextResponse.json({ error: "BACKEND_URL missing" }, { status: 500 });
  
  try {
    const body = await request.json();
    
    const backendReq = {
      schema_version: "1.0.0",
      request_id: crypto.randomUUID(),
      subject_id: body.patientId,
      as_of: body.pinned_as_of,
      include: ["scenarios"],
      scenarios: body.scenarios || [] // Pass through scenarios from client
    };

    if (!validateForecastRequest(backendReq)) {
       return NextResponse.json({ error: "Invalid ForecastRequest schema" }, { status: 400 });
    }

    const token = process.env.PR_TFT_SERVICE_TOKEN;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    const backendRes = await fetch(`${backendUrl}/v1/forecasts`, {
      method: 'POST',
      headers,
      body: JSON.stringify(backendReq)
    });

    if (!backendRes.ok) {
      return NextResponse.json({ error: "Backend failed" }, { status: backendRes.status });
    }

    const resData: any = await backendRes.json();
    
    if (!validateForecastResponse(resData)) {
      console.error("Invalid ForecastResponse schema", validateForecastResponse.errors);
      return NextResponse.json({ error: "Invalid upstream contract" }, { status: 502 });
    }

    const scenario = (resData as any).scenarios?.[0];
    if (!scenario) {
      return NextResponse.json({ error: "No scenario returned" }, { status: 500 });
    }

    const asOfTime = new Date((resData as any).as_of).getTime();

    // Compute peaks from the actual arrays
    const baseline_peak_mg_dl = Math.max(...(resData as any).forecast.points.map((p: any) => p.p50));
    const new_peak_mg_dl = Math.max(...scenario.points.map((p: any) => p.p50));

    const scenario_forecast = scenario.points.map((p: any) => ({
      timestamp: new Date(asOfTime + p.offset_min * 60000).toISOString(),
      p10: p.p10,
      p50: p.p50,
      p90: p.p90
    }));

    return NextResponse.json({
      pinned_as_of: (resData as any).as_of,
      scenario_forecast,
      metrics: {
        delta_peak_mg_dl: scenario.delta_peak_mg_dl,
        new_peak_mg_dl,
        baseline_peak_mg_dl,
        delta_probability: scenario.delta_probability,
        new_probability: scenario.probability_120m,
        baseline_probability: (resData as any).spike_risk?.probability_120m || 0
      }
    });

  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
