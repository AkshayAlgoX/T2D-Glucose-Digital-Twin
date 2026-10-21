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
  gate3ci?: { historical: [number, number]; corrected: number; correctedCi: [number, number] };
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
      out.gate3ci = { historical: [g3.historical_ci90[0], g3.historical_ci90[1]], corrected: g3.duration_corrected_auroc, correctedCi: [g3.duration_corrected_ci90[0], g3.duration_corrected_ci90[1]] };
    }
    const nums = [out.rmse60.hybrid, out.rmse60.twin, out.rmse60.persistence, out.patients, out.gate3.auroc];
    return nums.every(n => typeof n === 'number' && Number.isFinite(n)) && typeof out.gate3.status === 'string' ? out : null;
  } catch {
    return null;
  }
}
