import { NextResponse } from 'next/server';
import { readHeroForecast } from '@/lib/hero';

export const dynamic = 'force-dynamic';

/** The demonstration subject's replayed 08:00 forecast (the same data as the home figure); 503 when it cannot be read. */
export async function GET() {
  const hero = await readHeroForecast();
  return hero ? NextResponse.json(hero) : NextResponse.json({ error: 'Demonstration forecast unavailable' }, { status: 503 });
}
