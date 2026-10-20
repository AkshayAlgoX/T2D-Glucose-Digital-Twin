import { NextRequest, NextResponse } from 'next/server';
import { validateForecastResponse, validateForecastRequest } from '@/lib/schema-validator';

export async function POST(request: NextRequest) {
  const backendUrl = process.env.BACKEND_URL;
  if (!backendUrl) return NextResponse.json({ error: "BACKEND_URL missing" }, { status: 500 });
  
  try {
    let body: any;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    if (!body || typeof body !== 'object' || !body.patientId) {
      return NextResponse.json({ error: "Missing required patientId" }, { status: 400 });
    }
    
    const backendReq = {
      schema_version: "1.0.0",
      request_id: crypto.randomUUID(),
      subject_id: body.patientId,
      as_of: body.pinned_as_of,
      include: ["scenarios", "twin_overlay"],
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
      let errBody: any;
      try {
        errBody = await backendRes.json();
      } catch {
        errBody = { error: "Backend failed" };
      }
      return NextResponse.json(errBody, { status: backendRes.status });
    }

    const resData: any = await backendRes.json();
    
    if (!validateForecastResponse(resData)) {
      console.error("Invalid ForecastResponse schema", validateForecastResponse.errors);
      return NextResponse.json({ error: "Invalid upstream contract" }, { status: 502 });
    }

    // Baseline forecast check MUST precede scenario check.
    // If backend returns insufficient data or null forecast, return 422 before checking scenarios.
    if (!resData.forecast || !Array.isArray(resData.forecast.points)) {
      return NextResponse.json({ error: "No baseline forecast available for scenario comparison" }, { status: 422 });
    }

    const scenario = (resData as any).scenarios?.[0];
    if (!scenario || !Array.isArray(scenario.points)) {
      return NextResponse.json({ error: "No scenario returned" }, { status: 500 });
    }

    // Validate scenario probability bounds
    if (scenario.probability_120m !== null && scenario.probability_120m !== undefined) {
      if (typeof scenario.probability_120m !== 'number' || !Number.isFinite(scenario.probability_120m) || scenario.probability_120m < 0 || scenario.probability_120m > 1) {
        return NextResponse.json({ error: "Invalid upstream contract" }, { status: 502 });
      }
    }

    // Validate scenario delta_probability bounds if present
    if (scenario.delta_probability !== null && scenario.delta_probability !== undefined) {
      if (typeof scenario.delta_probability !== 'number' || !Number.isFinite(scenario.delta_probability) || scenario.delta_probability < -1 || scenario.delta_probability > 1) {
        return NextResponse.json({ error: "Invalid upstream contract" }, { status: 502 });
      }
    }

    // Validate baseline risk probability bounds if present
    if ((resData as any).spike_risk?.probability_120m !== null && (resData as any).spike_risk?.probability_120m !== undefined) {
      const baseProb = (resData as any).spike_risk.probability_120m;
      if (typeof baseProb !== 'number' || !Number.isFinite(baseProb) || baseProb < 0 || baseProb > 1) {
        return NextResponse.json({ error: "Invalid upstream contract" }, { status: 502 });
      }
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

    const rawBaselineProb = (resData as any).spike_risk?.probability_120m;
    const baseline_probability = typeof rawBaselineProb === 'number' && Number.isFinite(rawBaselineProb)
      ? rawBaselineProb
      : null;

    const rawNewProb = scenario.probability_120m;
    const new_probability = typeof rawNewProb === 'number' && Number.isFinite(rawNewProb)
      ? rawNewProb
      : null;

    let delta_probability: number | null = null;
    if (baseline_probability !== null && new_probability !== null) {
      const diff = Math.round((new_probability - baseline_probability) * 1000) / 1000;
      delta_probability = Object.is(diff, -0) ? 0 : diff;
    }

    return NextResponse.json({
      pinned_as_of: (resData as any).as_of,
      scenario_forecast,
      metrics: {
        delta_peak_mg_dl: scenario.delta_peak_mg_dl,
        new_peak_mg_dl,
        baseline_peak_mg_dl,
        delta_probability,
        new_probability,
        baseline_probability
      }
    });

  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
