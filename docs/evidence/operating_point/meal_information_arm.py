"""Exploratory: how much of the >=30-min early-warning gap is the absence of meal information?

The preregistered real-data run masked meal carbohydrate to zero for every model, because retrospective logs
cannot prove they were written at meal time. This arm measures what logged meals would add, on CGMacros only
(the dataset whose CGM file carries the meal log on the same clock), train and validation patients only.

Arms, identical except for the meal columns: the develop.py decision features, with and without four causal
meal features at decision step t (carbohydrate logged in (t-30, t], (t-60, t], (t-120, t] minutes, and minutes
since the last logged meal, capped at 360). Only meals logged at or before t are used: this assumes a meal is
logged when it is eaten, which is what the app's meal logging would provide prospectively, and which these
retrospective logs cannot prove. Calibration and the 1.0 false-alert/patient-day operating point are chosen on
patient-grouped training OOF predictions (budget_operating_point.py). EXPLORATORY: validation patients informed
the locked run; the locked test results are not changed or re-evaluated, and test records are never loaded.
Usage: python meal_information_arm.py --data-dir /path/to/data/real
"""
import argparse, dataclasses, json
from pathlib import Path

import numpy as np
import pandas as pd

import budget_operating_point as bop
from budget_operating_point import dv
from sklearn.isotonic import IsotonicRegression

HERE = Path(__file__).resolve().parent


def subset(ds, keep):
    n = len(ds.features)
    out = {}
    for f in dataclasses.fields(ds):
        v = getattr(ds, f.name)
        if isinstance(v, np.ndarray) and len(v) == n:
            out[f.name] = v[keep]
        elif isinstance(v, list) and len(v) == n:
            out[f.name] = [x for x, k in zip(v, keep) if k]
        else:
            out[f.name] = v
    return dataclasses.replace(ds, **out)


def meal_features(records, ds):
    """Causal meal columns for every decision, from the CGMacros meal log on the loader's 5-min grid."""
    meals = {}
    for r in records:
        df = pd.read_csv(dv.RAW_DIR / "cgmacros" / r.pid / f"{r.pid}.csv", usecols=["Timestamp", "Carbs"])
        df = df.dropna(subset=["Carbs"])
        df = df[df["Carbs"] > 0]
        t = pd.to_datetime(df["Timestamp"]).dt.ceil("5min").to_numpy()
        idx = np.searchsorted(r.time, t)
        ok = (idx < len(r.time)) & (r.time[np.minimum(idx, len(r.time) - 1)] == t)
        meals[r.pid] = (idx[ok], df["Carbs"].to_numpy(dtype=float)[ok])
    cols = np.zeros((len(ds.features), 4))
    for i, (pid, t) in enumerate(zip(ds.patient_ids, ds.decision_steps)):
        steps, carbs = meals[pid]
        past = steps <= t
        for j, k in enumerate((6, 12, 24)):
            cols[i, j] = carbs[past & (steps > t - k)].sum()
        cols[i, 3] = min(360.0, (t - steps[past].max()) * 5.0) if past.any() else 360.0
    n_meals = int(sum(len(m[0]) for m in meals.values()))
    return cols, n_meals


def run_arm(ds_tr, ds_va, X_tr, X_va, n_boot):
    oof = bop.grouped_oof(dataclasses.replace(ds_tr, features=X_tr))
    iso = IsotonicRegression(out_of_bounds="clip").fit(oof, ds_tr.onset_label)
    thr, tr_res = bop.choose_threshold(iso.predict(oof), ds_tr)
    va = iso.predict(bop.fit_predict(X_tr, ds_tr.onset_label, X_va))
    out = {"threshold_budget": thr, "train_oof_at_budget": bop.summary(tr_res) if tr_res else None}
    for name, t in (("val_at_0.35", 0.35), ("val_at_budget", thr)):
        if t is None:
            continue
        r = dv.evaluate_event_alerts(va, ds_va, threshold=t)
        ci = dv.bootstrap_patient_metrics(ds_va.target_60, ds_va.cgm_history, va, ds_va, event_res=r, n_boot=n_boot)
        res = bop.summary(r, ci)
        leads = [x for s in r["per_patient_stats"].values() for x in s["lead_times"]]
        res["lead_time_quartiles_min"] = [float(q) for q in np.percentile(leads, [25, 50, 75])] if leads else None
        out[name] = res
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data-dir", required=True)
    ap.add_argument("--n-boot", type=int, default=2000)
    a = ap.parse_args()
    dv.DATA_DIR = Path(a.data_dir)
    dv.RAW_DIR = dv.DATA_DIR / "raw"
    rec_tr = dv.load_cgmacros({"train"}) + dv.load_bigideas({"train"})
    rec_va = dv.load_cgmacros({"val"}) + dv.load_bigideas({"val"})
    ds_tr, med = dv.extract_decisions(rec_tr)
    ds_va, _ = dv.extract_decisions(rec_va, training_medians=med)
    cg = lambda ds: np.array([p.startswith("CGMacros") for p in ds.patient_ids])
    ds_tr, ds_va = subset(ds_tr, cg(ds_tr)), subset(ds_va, cg(ds_va))
    m_tr, n_tr = meal_features([r for r in rec_tr if r.dataset == "cgmacros"], ds_tr)
    m_va, n_va = meal_features([r for r in rec_va if r.dataset == "cgmacros"], ds_va)
    out = {
        "status": "EXPLORATORY (CGMacros train/val only; validation previously used; test not loaded)",
        "seed": dv.SEED, "budget_false_alerts_per_day": bop.BUDGET,
        "patients": {"train": len(set(ds_tr.patient_ids)), "val": len(set(ds_va.patient_ids))},
        "decisions": {"train": int(len(ds_tr.features)), "val": int(len(ds_va.features))},
        "meals_logged": {"train": n_tr, "val": n_va},
        "decisions_with_meal_in_past_120min": {"train": float((m_tr[:, 2] > 0).mean()), "val": float((m_va[:, 2] > 0).mean())},
        "cgm_only": run_arm(ds_tr, ds_va, ds_tr.features, ds_va.features, a.n_boot),
        "cgm_plus_logged_meals": run_arm(ds_tr, ds_va, np.hstack([ds_tr.features, m_tr]), np.hstack([ds_va.features, m_va]), a.n_boot),
    }
    (HERE / "meal_arm_results.json").write_text(json.dumps(out, indent=1) + "\n")


if __name__ == "__main__":
    main()
