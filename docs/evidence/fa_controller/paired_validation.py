"""Paired patient bootstrap on validation (exploratory): C2 with worst-fold-selected thresholds vs the learned baseline
at its pooled training-OOF budget threshold (0.2715, the strongest P0 operating point found by training data).
Parameters are read from results.json (training-only selection); nothing is re-tuned. Test, Hall, AZT1D, Broll unused."""
import argparse, dataclasses, json, sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "operating_point"))
import budget_operating_point as bop  # noqa: E402
from budget_operating_point import dv  # noqa: E402
from routine_target_arms import routine_features  # noqa: E402
from develop_controller import controlled_alerts  # noqa: E402
from sklearn.isotonic import IsotonicRegression  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data-dir", required=True)
    a = ap.parse_args()
    dv.DATA_DIR = Path(a.data_dir); dv.RAW_DIR = dv.DATA_DIR / "raw"
    rec = dv.load_cgmacros({"train"}) + dv.load_bigideas({"train"})
    rec_va = dv.load_cgmacros({"val"}) + dv.load_bigideas({"val"})
    ds, med = dv.extract_decisions(rec)
    dva, _ = dv.extract_decisions(rec_va, training_medians=med)

    def risk(X, Xv):
        oof = bop.grouped_oof(dataclasses.replace(ds, features=X))
        iso = IsotonicRegression(out_of_bounds="clip").fit(oof, ds.onset_label)
        return iso.predict(bop.fit_predict(X, ds.onset_label, Xv))
    rb = risk(ds.features, dva.features)
    r = risk(np.hstack([ds.features, routine_features(rec, ds)]), np.hstack([dva.features, routine_features(rec_va, dva)]))
    c2 = json.loads((HERE / "results.json").read_text())["selected"]["C2"]["param"]
    a_c2 = controlled_alerts(r, dva.trend_f60, rb, dva, c2)
    a_p0 = controlled_alerts(r, dva.trend_f60, rb, dva, {"family": "P0", "t": 0.2715})
    s1 = dv.evaluate_event_alerts(a_c2, dva, threshold=0.5)
    s0 = dv.evaluate_event_alerts(a_p0, dva, threshold=0.5)
    pids = sorted(s1["per_patient_stats"])
    on = np.array([s1["per_patient_stats"][p]["onsets"] for p in pids], float)
    d1 = np.array([s1["per_patient_stats"][p]["det_30m"] for p in pids], float)
    d0 = np.array([s0["per_patient_stats"][p]["det_30m"] for p in pids], float)
    da1 = np.array([s1["per_patient_stats"][p]["det"] for p in pids], float)
    da0 = np.array([s0["per_patient_stats"][p]["det"] for p in pids], float)
    rng = np.random.default_rng(dv.SEED)
    b30, ball = [], []
    for _ in range(2000):
        w = np.bincount(rng.integers(0, len(pids), len(pids)), minlength=len(pids))
        n = (w * on).sum()
        if n:
            b30.append(((w * d1).sum() - (w * d0).sum()) / n); ball.append(((w * da1).sum() - (w * da0).sum()) / n)
    out = {"status": "EXPLORATORY validation (used before); parameters from training-only selection", "c2_param": c2, "p0_threshold": 0.2715,
           "c2": bop.summary(s1), "p0": bop.summary(s0),
           "diff_sens30": {"point": float((d1.sum() - d0.sum()) / on.sum()), "ci95": [float(np.percentile(b30, 2.5)), float(np.percentile(b30, 97.5))]},
           "diff_sens_any": {"point": float((da1.sum() - da0.sum()) / on.sum()), "ci95": [float(np.percentile(ball, 2.5)), float(np.percentile(ball, 97.5))]},
           "patients": len(pids)}
    (HERE / "paired_validation.json").write_text(json.dumps(out, indent=1) + "\n")
    print({k: out[k] for k in ("diff_sens30", "diff_sens_any", "patients")}, {k: round(out["p0"][k], 3) for k in ("event_sensitivity_30m", "false_alerts_per_day")})


if __name__ == "__main__":
    main()
