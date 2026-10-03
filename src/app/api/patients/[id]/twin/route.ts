import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: patientId } = await params;
  const backendUrl = process.env.BACKEND_URL;
  const token = process.env.PR_TFT_SERVICE_TOKEN;

  if (!backendUrl) {
    return NextResponse.json(
      { error: 'BACKEND_URL environment variable is missing.' },
      { status: 500 }
    );
  }

  try {
    const headers: Record<string, string> = {};
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    const res = await fetch(`${backendUrl}/v1/subjects/${patientId}/twin`, { headers });
    
    if (!res.ok) {
      return NextResponse.json(
        { error: `Backend failed with status ${res.status}: ${res.statusText}` },
        { status: res.status }
      );
    }
    
    const data = await res.json();
    return NextResponse.json(data);
  } catch (err: any) {
    return NextResponse.json({ error: `Connection to backend failed: ${err.message}` }, { status: 500 });
  }
}
