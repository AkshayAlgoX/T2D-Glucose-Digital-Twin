import { insertByTime, SERIES_CAP } from '../src/hooks/useRealtimeTelemetry';

const at = (min: number) => new Date(Date.UTC(2026, 0, 1, 8, min)).toISOString();

describe('insertByTime', () => {
  it('appends a newer entry without copying earlier ones out of order', () => {
    const s = [{ t: at(0), v: 1 }, { t: at(5), v: 2 }];
    expect(insertByTime(s, { t: at(10), v: 3 }).map(p => p.v)).toEqual([1, 2, 3]);
  });

  it('returns the same array for a repeated timestamp', () => {
    const s = [{ t: at(0), v: 1 }, { t: at(5), v: 2 }];
    expect(insertByTime(s, { t: at(5), v: 9 })).toBe(s);
    expect(insertByTime(s, { t: at(0), v: 9 })).toBe(s);
  });

  it('places a late entry in time order', () => {
    const s = [{ t: at(0), v: 1 }, { t: at(10), v: 3 }];
    expect(insertByTime(s, { t: at(5), v: 2 }).map(p => p.v)).toEqual([1, 2, 3]);
  });

  it('keeps distinct states at one time, in arrival order, and dedupes by the comparator', () => {
    const same = (a: { state: string }, b: { state: string }) => a.state === b.state;
    let s = [{ t: at(5), state: 'none' }];
    s = insertByTime(s, { t: at(5), state: 'warning' }, same);
    expect(s.map(a => a.state)).toEqual(['none', 'warning']);
    expect(insertByTime(s, { t: at(5), state: 'none' }, same)).toBe(s);
  });

  it('drops the oldest entries beyond the cap', () => {
    let s: Array<{ t: string; v: number }> = [];
    for (let i = 0; i < 12; i++) s = insertByTime(s, { t: at(i * 5), v: i }, undefined, 10);
    expect(s).toHaveLength(10);
    expect(s[0].v).toBe(2);
    expect(s[9].v).toBe(11);
    expect(SERIES_CAP).toBe(4032);
  });
});
