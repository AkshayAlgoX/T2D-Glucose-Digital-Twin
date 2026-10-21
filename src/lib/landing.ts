import fs from 'fs/promises';
import path from 'path';

// uuid5(SUBJECT_NAMESPACE, "P0017") in backend/serve_pr_tft.py: the validation-split Type 2 demonstration subject.
export const DEMO_SUBJECT_ID = '6f50ef50-b6e5-5408-a70c-d8f0509d6012';

export interface LandingEvidence {
  rmse60: { twin: number; persistence: number; hybrid: number };
  patients: number;
  gate3: { auroc: number; threshold: string; status: string };
  /** RMSE at every forecast step (5–120 min), from horizon_progression; absent if the arrays are malformed. */
  progression?: { offsets: number[]; hybrid: number[]; twin: number[]; persistence: number[] };
  /** Per-subgroup RMSE for the hybrid, the twin alone and persistence at 60 and 120 min. */
  subgroups?: Array<{ name: string; n: number; h60: [number, number, number]; h120: [number, number, number] }>;
  /** Reliability bins of the calibrated onset classifier, fitted and evaluated on the same split. */
  reliability?: { predicted: number[]; observed: number[]; counts: number[]; status: string };
  /** Gate 3 discriminator AUROCs with their 90% intervals. */
  gate3ci?: { historical: [number, number]; corrected: number; correctedCi: [number, number]; mechanism: string | null };
}

/** Headline numbers, read from the committed evidence artifact at request time; null if it is absent or malformed. */
export async function readLandingEvidence(file = path.join(process.cwd(), 'docs/evidence/validation_ceiling_results.json')): Promise<LandingEvidence | null> {
  try {
    const d = JSON.parse(await fs.readFile(file, 'utf8'));
    const m = d.matched_baselines_and_uncertainty['60min'];
    const out: LandingEvidence = {
      rmse60: { hybrid: m.pr_tft.rmse, twin: m.twin_only.rmse, persistence: m.persistence.rmse },
      patients: d.cohort_scope.n_patients,
      gate3: { auroc: d.gate3_realism_status.historical_auroc, threshold: d.gate3_realism_status.acceptance_threshold, status: d.gate3_realism_status.status },
    };
    const h = d.horizon_progression;
    const arr = (a: unknown): a is number[] => Array.isArray(a) && a.length === h?.offsets_min?.length && a.every(v => typeof v === 'number' && Number.isFinite(v));
    if (h && arr(h.offsets_min) && arr(h.pr_tft_rmse) && arr(h.twin_rmse) && arr(h.persistence_rmse) && h.offsets_min.length >= 2) {
      out.progression = { offsets: h.offsets_min, hybrid: h.pr_tft_rmse, twin: h.twin_rmse, persistence: h.persistence_rmse };
    }
    const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
    const sg = d.subgroups;
    if (sg && typeof sg === 'object') {
      const rows = ['Healthy', 'Prediabetes', 'Type 2'].map(name => {
        const g = sg[name];
        const t = (h: number): [number, number, number] | null => (g && fin(g[`pr_rmse_${h}`]) && fin(g[`tw_rmse_${h}`]) && fin(g[`pe_rmse_${h}`]) ? [g[`pr_rmse_${h}`], g[`tw_rmse_${h}`], g[`pe_rmse_${h}`]] : null);
        const h60 = t(60), h120 = t(120);
        return g && fin(g.n_patients) && h60 && h120 ? { name, n: g.n_patients, h60, h120 } : null;
      });
      if (rows.every(Boolean)) out.subgroups = rows as NonNullable<LandingEvidence['subgroups']>;
    }
    const rb = d.calibration_resubstitution_diagnostics?.reliability_bins;
    const nums3 = (a: unknown): a is number[] => Array.isArray(a) && a.length > 1 && a.every(fin);
    if (rb && nums3(rb.bin_mean_predicted) && nums3(rb.bin_observed_fraction) && nums3(rb.bin_counts) && rb.bin_mean_predicted.length === rb.bin_observed_fraction.length) {
      out.reliability = { predicted: rb.bin_mean_predicted, observed: rb.bin_observed_fraction, counts: rb.bin_counts, status: String(d.calibration_resubstitution_diagnostics.status ?? '') };
    }
    const g3 = d.gate3_realism_status;
    if (g3 && nums3(g3.historical_ci90) && fin(g3.duration_corrected_auroc) && nums3(g3.duration_corrected_ci90)) {
      out.gate3ci = { historical: [g3.historical_ci90[0], g3.historical_ci90[1]], corrected: g3.duration_corrected_auroc, correctedCi: [g3.duration_corrected_ci90[0], g3.duration_corrected_ci90[1]], mechanism: typeof g3.mechanism === 'string' ? g3.mechanism : null };
    }
    const nums = [out.rmse60.hybrid, out.rmse60.twin, out.rmse60.persistence, out.patients, out.gate3.auroc];
    return nums.every(n => typeof n === 'number' && Number.isFinite(n)) && typeof out.gate3.status === 'string' ? out : null;
  } catch {
    return null;
  }
}

export interface JumpVariant { rmse: { '30min': number; '60min': number; '120min': number }; share_isolated_step_gt_20: number; share_isolated_step_gt_40: number; p10_p90_coverage: number }
export interface JumpExperiment {
  validation: { original: JumpVariant; R3: JumpVariant; n: number; worseThanNeighbours: number; upward: number };
  train: { original: JumpVariant; R3: JumpVariant; n: number };
}

/** The pre-registered isolated-step experiment (docs/evidence/jump_experiment); null if absent or malformed. */
export async function readJumpExperiment(file = path.join(process.cwd(), 'docs/evidence/jump_experiment/results.json')): Promise<JumpExperiment | null> {
  try {
    const d = JSON.parse(await fs.readFile(file, 'utf8'));
    const ok = (v: any): v is JumpVariant => v && ['30min', '60min', '120min'].every(k => Number.isFinite(v.rmse?.[k])) && Number.isFinite(v.share_isolated_step_gt_20) && Number.isFinite(v.share_isolated_step_gt_40) && Number.isFinite(v.p10_p90_coverage);
    const v = d.validation, t = d.train_sample;
    if (!ok(v?.original) || !ok(v?.R3) || !ok(t?.original) || !ok(t?.R3)) return null;
    const dg = v.jump_diagnostics ?? {};
    if (![dg.n_forecasts, dg.share_step_worse_than_neighbour_mean, dg.share_upward_steps, t.jump_diagnostics?.n_forecasts].every(Number.isFinite)) return null;
    return {
      validation: { original: v.original, R3: v.R3, n: dg.n_forecasts, worseThanNeighbours: dg.share_step_worse_than_neighbour_mean, upward: dg.share_upward_steps },
      train: { original: t.original, R3: t.R3, n: t.jump_diagnostics.n_forecasts },
    };
  } catch {
    return null;
  }
}

export interface Ci { estimate: number | null; ci_low: number | null; ci_high: number | null }
export interface EventRow {
  key: string; sensitivity: Ci; precision: Ci; falsePerDay: Ci; leadMedian: Ci;
  counts: { monitored: number; detected: number; missed: number; alerts: number; falseAlerts: number };
  leadShare30: number | null;
}
export interface EventEvaluation { patients: number; groups: Record<string, number>; patientDays: number; rows: EventRow[] }

/** Event-level early warning on the validation patients (backend/evaluate_events_validation.py); null unless complete. */
export const EVENT_ROWS = ['pr_tft_crossfit@0.35', 'pr_tft_crossfit@0.6', 'pr_tft_median_rule', 'twin_only', 'linear_trend_rule'] as const;
export async function readEventEvaluation(file = path.join(process.cwd(), 'docs/evidence/event_eval/validation_event_report.json')): Promise<EventEvaluation | null> {
  try {
    const d = JSON.parse(await fs.readFile(file, 'utf8'));
    if (d.schema !== 'pr_tft_validation_event_evaluation/v1' || d.provenance?.limited_to_patients != null) return null;
    const p = d.populations?.primary;
    const ci = (v: any): v is Ci => v && 'estimate' in v && 'ci_low' in v && 'ci_high' in v;
    const rows = EVENT_ROWS.map(key => {
      const m = p?.models?.[key];
      const c = m?.counts;
      if (!m || !ci(m.event_sensitivity) || !ci(m.alert_precision) || !ci(m.false_alerts_per_patient_day) || !ci(m.lead_time_median_min)
        || ![c?.monitored_onsets, c?.detected_onsets, c?.missed_onsets, c?.alerts_raised, c?.false_alerts].every(Number.isFinite)) return null;
      return { key, sensitivity: m.event_sensitivity, precision: m.alert_precision, falsePerDay: m.false_alerts_per_patient_day, leadMedian: m.lead_time_median_min,
        counts: { monitored: c.monitored_onsets, detected: c.detected_onsets, missed: c.missed_onsets, alerts: c.alerts_raised, falseAlerts: c.false_alerts },
        leadShare30: Number.isFinite(m.lead_time_distribution_min?.share_ge_30_min) ? m.lead_time_distribution_min.share_ge_30_min : null };
    });
    const days = p?.models?.[EVENT_ROWS[0]]?.patient_days;
    if (rows.some(r => !r) || !Number.isFinite(p.patients) || !Number.isFinite(days)) return null;
    return { patients: p.patients, groups: p.groups ?? {}, patientDays: days, rows: rows as EventRow[] };
  } catch {
    return null;
  }
}

export interface Gate3Checks {
  windows: { synthetic: number; mockReal: number }; patients: { synthetic: number; mockReal: number };
  windowHours: number; features: number; folds: number; gridMin: number; acceptance: string;
  tells: Array<{ name: string; shap: number }>;
  nullControl: { estimate: number; ci: [number, number] }; powerControl: { estimate: number };
}

/** Gate 3 checks G3.1–G3.3 as recorded by validation_gates.py; null unless every value shown is present. */
export async function readGate3Checks(file = path.join(process.cwd(), 'backend/synthetic_v2/validation/validation_report.json')): Promise<Gate3Checks | null> {
  try {
    const d = JSON.parse(await fs.readFile(file, 'utf8'));
    const g = (d.gates ?? []).find((x: any) => x?.gate_id === 'GATE 3');
    const c = (id: string) => (g?.checks ?? []).find((x: any) => x?.check_id === id);
    const g1 = c('G3.1'), g2 = c('G3.2'), g3 = c('G3.3');
    const m = /on (\d+) synthetic vs\. (\d+) mock_real windows from (\d+) and (\d+) patients/.exec(g1?.message ?? '');
    const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
    const det = g1?.details ?? {};
    const tells = Object.entries(det.top_tells_mean_abs_shap ?? {}).slice(0, 2).map(([name, shap]) => ({ name, shap: Number(shap) }));
    if (!m || !fin(det.window_hours) || !fin(det.n_features) || !Array.isArray(det.fold_aurocs) || !fin(det.grid_min) || typeof g1.acceptance !== 'string'
      || tells.length < 2 || !tells.every(t => fin(t.shap)) || !fin(g2?.estimate) || !Array.isArray(g2?.ci) || !fin(g3?.estimate)) return null;
    return {
      windows: { synthetic: +m[1], mockReal: +m[2] }, patients: { synthetic: +m[3], mockReal: +m[4] },
      windowHours: det.window_hours, features: det.n_features, folds: det.fold_aurocs.length, gridMin: det.grid_min, acceptance: g1.acceptance,
      tells, nullControl: { estimate: g2.estimate, ci: [g2.ci[0], g2.ci[1]] }, powerControl: { estimate: g3.estimate },
    };
  } catch {
    return null;
  }
}
