import fs from 'fs';
import path from 'path';
import { EXTERNAL_CHECKS } from '../src/lib/external-evidence';

// The Evidence page's real-patient and external numbers must match the committed artifacts.
const root = path.join(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');
const check = (id: string) => EXTERNAL_CHECKS.find(c => c.id === id)!;

describe('Evidence page external results match committed artifacts', () => {
  it('Hall rows, status and freeze commit match external_hall/results.json', () => {
    const r = JSON.parse(read('docs/evidence/external_hall/results.json'));
    const c = check('hall-2018');
    expect(r.primary_success).toBe(false);
    expect(c.status).toBe('not-confirmed');
    expect(c.rows[0].sens30).toBeCloseTo(r.policies.P2.event_sensitivity_30m, 6);
    expect(c.rows[0].sensAny).toBeCloseTo(r.policies.P2.event_sensitivity, 6);
    expect(c.rows[0].faPerDay).toBeCloseTo(r.policies.P2.false_alerts_per_day, 3);
    expect(c.rows[1].sens30).toBeCloseTo(r.policies.P0.event_sensitivity_30m, 6);
    expect(c.rows[2].sens30).toBeCloseTo(r['reference_linear_trend_at_1.0'].event_sensitivity_30m, 6);
    expect(c.rows[2].faPerDay).toBeCloseTo(r['reference_linear_trend_at_1.0'].false_alerts_per_day, 2);
    expect(read('docs/evidence/external_hall/PREREGISTRATION.md')).toMatch(/before the Hall data are read/);
  });

  it('AZT1D rows and status match external_v2/results.json', () => {
    const r = JSON.parse(read('docs/evidence/external_v2/results.json'));
    const c = check('azt1d');
    expect(r.primary_success).toBe(false);
    expect(c.status).toBe('not-met');
    const byName: Record<string, string> = { 'Learned baseline (selected)': 'P0', 'Trend alone': 'T', 'Trend or risk': 'C1', 'Risk-gated trend (over budget)': 'C2' };
    c.rows.forEach(row => {
      const p = r.primary_AZT1D.policies[byName[row.label]];
      expect(row.sens30).toBeCloseTo(p.event_sensitivity_30m, 3);
      expect(row.sensAny).toBeCloseTo(p.event_sensitivity, 3);
      expect(row.faPerDay).toBeCloseTo(p.false_alerts_per_day, 3);
    });
    expect(r.primary_AZT1D.onsets).toBe(2814);
  });

  it('locked real-data figures appear in the locked RESULTS.md', () => {
    const md = read('docs/evidence/real_data/RESULTS.md');
    expect(md).toContain('**6.0%**');
    expect(md).toContain('**0.11**');
    expect(md).toContain('**23.04**');
    expect(md).toContain('45.0%');
    expect(md).toContain('3.83');
    expect(check('real-data-v1').rows[0]).toMatchObject({ sens30: 0.06, faPerDay: 0.11, medianLeadMin: 10 });
  });
});
