"""Follow-up to routine_target_arms.py: is the routine arm's gain more than extra alerts?

(1) Iso-false-alert comparison: sensitivity >=30 min for baseline vs routine at matched false-alert rates
    (0.5, 1.0, 1.5 per patient-day), each arm's threshold swept on the same predictions. On training OOF this is
    in-sample for the threshold only; on validation the thresholds are set on validation, so those rows describe
    the trade-off curve and are not an operating-point claim.
(2) Paired patient bootstrap (2,000 resamples, seed 20260930) of the routine - baseline difference in training-OOF
    sensitivity >=30 min, each arm at its own training budget threshold (<= 1.0 false alerts/patient-day).
EXPLORATORY; test records are never loaded.
"""
import argparse, dataclasses, json
from pathlib import Path

import numpy as np

import budget_operating_point as bop
from budget_operating_point import dv
from routine_target_arms import routine_features
from sklearn.isotonic import IsotonicRegression

HERE = Path(__file__).resolve().parent


def curve(p, ds):
    grid = np.unique(np.round(np.concatenate([np.quantile(p[ds.at_risk], np.linspace(0.3, 0.999, 160)), np.linspace(0.02, 1.0, 99)]), 4))
    return [(float(t), dv.evaluate_event_alerts(p, ds, threshold=float(t))) for t in grid]


def at_fa(c, fa):
    ok = [(t, r) for t, r in c if r["false_alerts_per_day"] <= fa]
    t, r = max(ok, key=lambda x: x[1]["event_sensitivity_30m"]) if ok else (None, None)
    return None if r is None else {"threshold": t, "sens30": r["event_sensitivity_30m"], "sens_any": r["event_sensitivity"], "fa_per_day": r["false_alerts_per_day"], "median_lead_min": r["median_lead_time_min"]}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data-dir", required=True)
    a = ap.parse_args()
    dv.DATA_DIR = Path(a.data_dir); dv.RAW_DIR = dv.DATA_DIR / "raw"
    rec_tr = dv.load_cgmacros({"train"}) + dv.load_bigideas({"train"})
    rec_va = dv.load_cgmacros({"val"}) + dv.load_bigideas({"val"})
    ds_tr, med = dv.extract_decisions(rec_tr)
    ds_va, _ = dv.extract_decisions(rec_va, training_medians=med)
    X = {"baseline": (ds_tr.features, ds_va.features),
         "routine": (np.hstack([ds_tr.features, routine_features(rec_tr, ds_tr)]), np.hstack([ds_va.features, routine_features(rec_va, ds_va)]))}
    out = {"status": "EXPLORATORY; test not loaded", "seed": dv.SEED, "iso_fa": {}, "budget_runs": {}}
    stats = {}
    for name, (Xtr, Xva) in X.items():
        oof = bop.grouped_oof(dataclasses.replace(ds_tr, features=Xtr))
        iso = IsotonicRegression(out_of_bounds="clip").fit(oof, ds_tr.onset_label)
        p_tr = iso.predict(oof)
        p_va = iso.predict(bop.fit_predict(Xtr, ds_tr.onset_label, Xva))
        c_tr, c_va = curve(p_tr, ds_tr), curve(p_va, ds_va)
        out["iso_fa"][name] = {"train_oof": {str(f): at_fa(c_tr, f) for f in (0.5, 1.0, 1.5)}, "validation": {str(f): at_fa(c_va, f) for f in (0.5, 1.0, 1.5)}}
        thr = at_fa(c_tr, bop.BUDGET)["threshold"]
        stats[name] = dv.evaluate_event_alerts(p_tr, ds_tr, threshold=thr)["per_patient_stats"]
        out["budget_runs"][name] = thr
    pids = sorted(stats["baseline"])
    rng = np.random.default_rng(dv.SEED)
    on = np.array([stats["baseline"][p]["onsets"] for p in pids], float)
    d_b = np.array([stats["baseline"][p]["det_30m"] for p in pids], float)
    d_r = np.array([stats["routine"][p]["det_30m"] for p in pids], float)
    diffs = []
    for _ in range(2000):
        w = np.bincount(rng.integers(0, len(pids), len(pids)), minlength=len(pids))
        n = (w * on).sum()
        if n > 0:
            diffs.append(((w * d_r).sum() - (w * d_b).sum()) / n)
    out["paired_bootstrap_train_oof_sens30_diff"] = {"point": float((d_r.sum() - d_b.sum()) / on.sum()), "ci95": [float(np.percentile(diffs, 2.5)), float(np.percentile(diffs, 97.5))],
                                                    "fraction_le_0": float(np.mean(np.array(diffs) <= 0)), "patients": len(pids)}
    (HERE / "routine_iso_fa_results.json").write_text(json.dumps(out, indent=1) + "\n")
    print(json.dumps(out, indent=1))


if __name__ == "__main__":
    main()
