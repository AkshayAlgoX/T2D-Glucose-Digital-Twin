import { NextRequest, NextResponse } from 'next/server';
import { validateForecastResponse } from '@/lib/schema-validator';

export async function POST(request: NextRequest) {
  const backendUrl = process.env.BACKEND_URL || 'http://127.0.0.1:8001';
  
  try {
    const body = await request.json();
    
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

    const resData: any = await backendRes.json();
    
    // Validate boundary
    if (!validateForecastResponse(resData)) {
      console.error("Invalid ForecastResponse schema", validateForecastResponse.errors);
      return NextResponse.json({ error: "Invalid upstream contract" }, { status: 502 });
    }

    const scenario = (resData as any).scenarios?.[0];
    if (!scenario) {
      return NextResponse.json({ error: "No scenario returned" }, { status: 500 });
    }

    const scenario_forecast = scenario.points.map((p: any) => ({
      timestamp: new Date(new Date((resData as any).as_of).getTime() + p.offset_min * 60000).toISOString(),
      p10: p.p10,
      p50: p.p50,
      p90: p.p90
    }));

    return NextResponse.json({
      pinned_as_of: (resData as any).as_of,
      scenario_forecast,
      metrics: {
        delta_peak_mg_dl: scenario.delta_peak_mg_dl,
        new_peak_mg_dl: 0,
        baseline_peak_mg_dl: 0
      }
    });

  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
