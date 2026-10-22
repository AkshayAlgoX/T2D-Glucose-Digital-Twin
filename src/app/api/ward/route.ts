import { NextResponse } from 'next/server';
import { readWardCached } from '@/lib/ward';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET() {
  const backendUrl = process.env.BACKEND_URL;
  if (!backendUrl) return NextResponse.json({ error: 'BACKEND_URL missing' }, { status: 500 });
  try {
    return NextResponse.json(await readWardCached(backendUrl, process.env.PR_TFT_SERVICE_TOKEN));
  } catch (err: any) {
    return NextResponse.json({ error: `Ward could not be read: ${err?.message ?? 'unknown error'}` }, { status: 502 });
  }
}
