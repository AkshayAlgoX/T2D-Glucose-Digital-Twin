import { NextResponse } from 'next/server';

export async function GET() {
  const backendUrl = process.env.BACKEND_URL || 'http://127.0.0.1:8001';
  try {
    const res = await fetch(`${backendUrl}/v1/subjects`);
    if (!res.ok) return NextResponse.json({ error: 'Backend failed' }, { status: res.status });
    const data = await res.json();
    return NextResponse.json(data);
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
