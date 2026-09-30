import { NextRequest, NextResponse } from 'next/server';

export async function POST(request: NextRequest) {
  const backendUrl = process.env.BACKEND_URL || 'http://127.0.0.1:8001';
  
  try {
    const body = await request.json();
    // frontend sends: { patientId, pinned_as_of, scenario: { type, value, intensity } }
    
    // We must map it to backend ForecastRequest
    const backendReq = {
      schema_version: "1.0.0",
      request_id: crypto.randomUUID(),
      subject_id: body.patientId,
      as_of: body.pinned_as_of,
      include: ["scenarios"],
      scenarios: [
        {
          scenario_id: "scen-1",
          label: "Hypothetical Scenario",
          inputs: [] as any[]
        }
      ]
    };

    if (body.scenario.type === 'ACTIVITY') {
      backendReq.scenarios[0].inputs.push({
        kind: "activity",
        offset_min: 5,
        duration_min: body.scenario.value,
        intensity: body.scenario.intensity || "moderate"
      });
    } else if (body.scenario.type === 'NUTRITION') {
      backendReq.scenarios[0].inputs.push({
        kind: "meal",
        offset_min: 5,
        carbs_g: body.scenario.value
      });
    }

    const backendRes = await fetch(`${backendUrl}/v1/forecasts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(backendReq)
    });

    if (!backendRes.ok) {
      return NextResponse.json({ error: "Backend failed" }, { status: backendRes.status });
    }

    const resData = await backendRes.json();
    
    // Map backend ForecastResponse scenarios back to ScenarioSimulationResponse
    const scenario = resData.scenarios?.[0];
    if (!scenario) {
      return NextResponse.json({ error: "No scenario returned" }, { status: 500 });
    }

    const scenario_forecast = scenario.points.map((p: any) => ({
      timestamp: new Date(new Date(resData.as_of).getTime() + p.offset_min * 60000).toISOString(),
      forecastGlucose: p.p50
    }));

    return NextResponse.json({
      pinned_as_of: resData.as_of,
      scenario_forecast,
      metrics: {
        delta_peak_mg_dl: scenario.delta_peak_mg_dl,
        new_peak_mg_dl: 0, // Not explicitly in output?
        baseline_peak_mg_dl: 0
      }
    });

  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
