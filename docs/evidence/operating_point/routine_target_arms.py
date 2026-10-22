"""Exploratory: an explicit >=30-min target and the patient's own daily routine, for >=30-min early warning.

H1 (target): develop.py trains the hazard on "onset in (t, t+24]" (5-120 min), which rewards easy 5-25 min
    warnings; the metric that matters counts warnings >=30 min ahead. Arm "lead30" trains on onset in (t+5, t+24].
H2 (routine): meals are habitual. For each decision at step t and d = 1, 2, 3 days back, the patient's own CGM
    in the same upcoming clock window one, two and three days earlier: max over [t-288d+6, t-288d+24], its rise
    over CGM at t-288d, whether that window held a new excursion above 180 mg/dL, and how many days had data.
    All of it is before t (causal). Gaps stay NaN (LightGBM's missing-value path); nothing is imputed as observed.
Decision rule, fixed before running: the arm with the highest TRAINING patient-grouped 5-fold OOF sensitivity
>=30 min at <= 1.0 false alerts/patient-day (budget threshold chosen on that OOF) is the candidate; only that arm and
the baseline are then scored on validation, as exploratory evidence. Test records are never loaded.
Usage: python routine_target_arms.py --data-dir /path/to/data/real
"""
import argparse, dataclasses, json
from pathlib import Path

import numpy as np

import budget_operating_point as bop
from budget_operating_point import dv
from sklearn.isotonic import IsotonicRegression

HERE = Path(__file__).resolve().parent
DAY = 288


def routine_features(records, ds):
    cgm = {r.pid: r.cgm for r in records}
    out = np.full((len(ds.features), 4), np.nan)
    for i, (pid, t) in enumerate(zip(ds.patient_ids, ds.decision_steps)):
        g = cgm[pid]
        mx, rise, exc = [], [], []
        for d in (1, 2, 3):
            a, b = t - DAY * d + 6, t - DAY * d + 25
            if a - 6 < 0:
                continue
            w = g[a:b]
            if np.isfinite(w).sum() < 10 or not np.isfinite(g[t - DAY * d]):
                continue
            m = float(np.nanmax(w))
            mx.append(m); rise.append(m - g[t - DAY * d]); exc.append(float(m > 180 and g[t - DAY * d] < 180))
        if mx:
            out[i] = [np.mean(mx), np.mean(rise), np.mean(exc), len(mx)]
        else:
            out[i, 3] = 0
    return out


def lead30_label(ds):
    lab = np.zeros(len(ds.features), dtype=np.int32)
    for i, (pid, t) in enumerate(zip(ds.patient_ids, ds.decision_steps)):
        lab[i] = int(any(t + 5 < o <= t + 24 for o in ds.spike_onsets_per_patient.get(pid, [])))
    return lab


def oof_arm(ds_tr, X, y):
    oof = bop.grouped_oof(dataclasses.replace(ds_tr, features=X, onset_label=y))
    iso = IsotonicRegression(out_of_bounds="clip").fit(oof, y)
    thr, res = bop.choose_threshold(iso.predict(oof), ds_tr)
    return iso, thr, res


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data-dir", required=True)
    ap.add_argument("--n-boot", type=int, default=2000)
    a = ap.parse_args()
    dv.DATA_DIR = Path(a.data_dir); dv.RAW_DIR = dv.DATA_DIR / "raw"
    rec_tr = dv.load_cgmacros({"train"}) + dv.load_bigideas({"train"})
    rec_va = dv.load_cgmacros({"val"}) + dv.load_bigideas({"val"})
    ds_tr, med = dv.extract_decisions(rec_tr)
    ds_va, _ = dv.extract_decisions(rec_va, training_medians=med)
    R_tr, R_va = routine_features(rec_tr, ds_tr), routine_features(rec_va, ds_va)
    y_tr, y_va = ds_tr.onset_label, ds_va.onset_label
    L_tr, L_va = lead30_label(ds_tr), lead30_label(ds_va)
    arms = {
        "baseline": (ds_tr.features, y_tr, ds_va.features, y_va),
        "lead30_target": (ds_tr.features, L_tr, ds_va.features, L_va),
        "routine": (np.hstack([ds_tr.features, R_tr]), y_tr, np.hstack([ds_va.features, R_va]), y_va),
        "routine_lead30": (np.hstack([ds_tr.features, R_tr]), L_tr, np.hstack([ds_va.features, R_va]), L_va),
    }
    train = {}
    fitted = {}
    for name, (Xtr, ytr, Xva, yva) in arms.items():
        iso, thr, res = oof_arm(ds_tr, Xtr, ytr)
        fitted[name] = (iso, thr)
        train[name] = {"threshold_budget": thr, "train_oof_at_budget": bop.summary(res) if res else None}
        print(name, thr, res and round(res["event_sensitivity_30m"], 4), res and round(res["false_alerts_per_day"], 3), flush=True)
    ok = {k: v for k, v in train.items() if v["train_oof_at_budget"]}
    candidate = max(ok, key=lambda k: ok[k]["train_oof_at_budget"]["event_sensitivity_30m"])
    val = {}
    for name in dict.fromkeys(["baseline", candidate]):
        Xtr, ytr, Xva, _ = arms[name]
        iso, thr = fitted[name]
        p = iso.predict(bop.fit_predict(Xtr, ytr, Xva))
        r = dv.evaluate_event_alerts(p, ds_va, threshold=thr)
        ci = dv.bootstrap_patient_metrics(ds_va.target_60, ds_va.cgm_history, p, ds_va, event_res=r, n_boot=a.n_boot)
        res = bop.summary(r, ci)
        leads = [x for s in r["per_patient_stats"].values() for x in s["lead_times"]]
        res["lead_time_quartiles_min"] = [float(q) for q in np.percentile(leads, [25, 50, 75])] if leads else None
        val[name] = res
    out = {
        "status": "EXPLORATORY (decision on training OOF only; validation previously used; test not loaded)",
        "seed": dv.SEED, "budget_false_alerts_per_day": bop.BUDGET,
        "patients": {"train": len(set(ds_tr.patient_ids)), "val": len(set(ds_va.patient_ids))},
        "routine_coverage": {"train": float((R_tr[:, 3] > 0).mean()), "val": float((R_va[:, 3] > 0).mean())},
        "lead30_positive_rate": {"train": float(L_tr.mean()), "val": float(L_va.mean())},
        "train_oof": train, "candidate_by_train_oof": candidate, "validation": val,
    }
    (HERE / "routine_target_results.json").write_text(json.dumps(out, indent=1) + "\n")


if __name__ == "__main__":
    main()
