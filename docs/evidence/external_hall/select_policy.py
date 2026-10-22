"""Phase 1 of the Hall external check (PREREGISTRATION.md): choose the alert policy on TRAINING data only.

Models (develop.py features, LightGBM hazard, seed 20260930; isotonic calibration on patient-grouped 5-fold OOF):
  baseline - develop.py decision features.
  routine  - plus the patient's own previous-day CGM in the upcoming clock window (operating_point/routine_target_arms.py).
Policies, parameters chosen on training OOF at <= 1.0 false alert/patient-day:
  P0 baseline + global threshold (comparator).
  P1 routine + global threshold.
  P2 routine + own-rate threshold with floor (operating_point/transfer_and_personalization.py).
  P3 routine + global threshold + per-patient cap of K alerts in any trailing 24 h (new).
Selection rule (fixed before Hall is read): parameters come from training OOF; among P1-P3 the policy with the
highest VALIDATION sensitivity >= 30 min whose validation false alerts are <= 1.0/day is selected. Validation is
development data here (it was used before); Hall is the only independent data. Final models are fitted on all
training patients, calibrated with the training-OOF isotonic map. Writes frozen_policy.json. Hall data is not read
here. Test records are never loaded.
"""
import argparse, dataclasses, json, sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "operating_point"))
import budget_operating_point as bop  # noqa: E402
from budget_operating_point import dv  # noqa: E402
from routine_target_arms import routine_features  # noqa: E402
from transfer_and_personalization import own_rate_thresholds  # noqa: E402
from sklearn.isotonic import IsotonicRegression  # noqa: E402

DAY = 288


def capped_alert_scores(p, ds, thr, k):
    """1.0 at the steps a global-threshold policy with the locked cooldown and a K-per-24h cap would alert."""
    s = np.zeros(len(p))
    pids = np.asarray(ds.patient_ids)
    for pid in sorted(set(pids)):
        idx = np.where(pids == pid)[0]
        raised = []
        for i in idx:
            t = int(ds.decision_steps[i])
            if not (p[i] >= thr and ds.at_risk[i]):
                continue
            if raised and t - raised[-1] < dv.COOLDOWN_STEPS:
                continue
            if sum(1 for a in raised if t - a < DAY) >= k:
                continue
            raised.append(t)
            s[i] = 1.0
    return s


def policy_scores(name, param, p, ds):
    """Score vector whose alerts at threshold 0.5 (or 0.0 for P2) reproduce the policy."""
    if name in ("P0", "P1"):
        return p - param["threshold"]
    if name == "P2":
        return p - own_rate_thresholds(p, ds, param["q"], param["fallback"], param["floor"])
    return capped_alert_scores(p, ds, param["threshold"], param["k"]) - 0.5


def evaluate(name, param, p, ds):
    return dv.evaluate_event_alerts(policy_scores(name, param, p, ds), ds, threshold=0.0)


def fit_models(ds, X):
    """Calibrated training OOF probabilities and the isotonic map (fitted on that OOF)."""
    oof = bop.grouped_oof(dataclasses.replace(ds, features=X))
    iso = IsotonicRegression(out_of_bounds="clip").fit(oof, ds.onset_label)
    return iso.predict(oof), iso


def best(cands):
    ok = [(param, r) for param, r in cands if r["false_alerts_per_day"] <= bop.BUDGET]
    return max(ok, key=lambda x: x[1]["event_sensitivity_30m"]) if ok else (None, None)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data-dir", required=True)
    a = ap.parse_args()
    dv.DATA_DIR = Path(a.data_dir); dv.RAW_DIR = dv.DATA_DIR / "raw"
    rec = dv.load_cgmacros({"train"}) + dv.load_bigideas({"train"})
    rec_va = dv.load_cgmacros({"val"}) + dv.load_bigideas({"val"})
    ds, med = dv.extract_decisions(rec)
    ds_va, _ = dv.extract_decisions(rec_va, training_medians=med)
    X_rout, Xva_rout = np.hstack([ds.features, routine_features(rec, ds)]), np.hstack([ds_va.features, routine_features(rec_va, ds_va)])
    p_base, iso_b = fit_models(ds, ds.features)
    p_rout, iso_r = fit_models(ds, X_rout)
    pva_base = iso_b.predict(bop.fit_predict(ds.features, ds.onset_label, ds_va.features))
    pva_rout = iso_r.predict(bop.fit_predict(X_rout, ds.onset_label, Xva_rout))
    t0, _ = bop.choose_threshold(p_base, ds)
    t1, _ = bop.choose_threshold(p_rout, ds)
    grid = np.unique(np.round(np.concatenate([np.quantile(p_rout[ds.at_risk], np.linspace(0.5, 0.999, 60)), np.linspace(0.05, 0.6, 23)]), 4))
    cands = {
        "P0": [({"threshold": t0}, evaluate("P0", {"threshold": t0}, p_base, ds))],
        "P1": [({"threshold": t1}, evaluate("P1", {"threshold": t1}, p_rout, ds))],
        "P2": [({"q": q, "floor": f, "fallback": t1}, evaluate("P2", {"q": q, "floor": f, "fallback": t1}, p_rout, ds))
               for q in (0.95, 0.97, 0.98, 0.99) for f in (0.1, 0.15, 0.2, 0.25)],
        "P3": [({"threshold": float(t), "k": k}, evaluate("P3", {"threshold": float(t), "k": k}, p_rout, ds))
               for k in (1, 2, 3, 4) for t in grid],
    }
    chosen = {name: best(c) for name, c in cands.items()}
    val = {n: evaluate(n, v[0], pva_base if n == "P0" else pva_rout, ds_va) for n, v in chosen.items() if v[0] is not None}
    eligible = {n: r for n, r in val.items() if n != "P0" and r["false_alerts_per_day"] <= bop.BUDGET}
    selected = max(eligible, key=lambda n: eligible[n]["event_sensitivity_30m"]) if eligible else None
    out = {
        "phase": "1 (training OOF only; Hall not read; test never loaded)", "seed": dv.SEED, "budget": bop.BUDGET,
        "training_patients": len(set(ds.patient_ids)),
        "policies": {n: {"param": v[0], "train_oof": bop.summary(v[1]) if v[1] else None,
                         "validation": bop.summary(val[n]) if n in val else None} for n, v in chosen.items()},
        "comparator": "P0", "selected": selected,
    }
    (HERE / "frozen_policy.json").write_text(json.dumps(out, indent=1) + "\n")
    for n, v in out["policies"].items():
        t, w = v["train_oof"], v["validation"]
        print(n, v["param"], "train", t and (round(t["event_sensitivity_30m"], 3), round(t["false_alerts_per_day"], 2)),
              "val", w and (round(w["event_sensitivity_30m"], 3), round(w["false_alerts_per_day"], 2), w["median_lead_time_min"]))
    print("selected:", selected)


if __name__ == "__main__":
    main()
