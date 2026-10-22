import fs from 'fs';
import path from 'path';
import { C2_CANDIDATE, CLAIM_TIERS, EXTERNAL_CHECKS } from '../src/lib/external-evidence';

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

describe('Exploratory candidate and claim tiers', () => {
  it('candidate numbers match fa_controller artifacts and are not presented as confirmed', () => {
    const r = JSON.parse(read('docs/evidence/fa_controller/results.json'));
    const pv = JSON.parse(read('docs/evidence/fa_controller/paired_validation.json'));
    const [c2, p0] = C2_CANDIDATE.rows;
    expect(c2.sens30).toBeCloseTo(r.validation.C2.event_sensitivity_30m, 3);
    expect(c2.sensAny).toBeCloseTo(r.validation.C2.event_sensitivity, 3);
    expect(c2.faPerDay).toBeCloseTo(r.validation.C2.false_alerts_per_day, 3);
    expect(p0.sens30).toBeCloseTo(pv.p0.event_sensitivity_30m, 3);
    expect(p0.faPerDay).toBeCloseTo(pv.p0.false_alerts_per_day, 3);
    expect(C2_CANDIDATE.pairedSens30.point).toBeCloseTo(pv.diff_sens30.point, 3);
    expect(C2_CANDIDATE.pairedSens30.lo).toBeCloseTo(pv.diff_sens30.ci95[0], 3);
    expect(C2_CANDIDATE.pairedSens30.hi).toBeCloseTo(pv.diff_sens30.ci95[1], 3);
    expect(C2_CANDIDATE.pairedSens30.lo).toBeLessThan(0);
    expect(CLAIM_TIERS.confirmed).toHaveLength(0);
    expect(fs.existsSync(path.join(root, 'docs/evidence/aireadi_confirmation/results.json'))).toBe(false);
  });
});
