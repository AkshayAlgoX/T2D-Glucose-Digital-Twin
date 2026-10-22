"""Exploratory: does choosing the alert threshold to the false-alert budget recover early-warning sensitivity?

Root cause under test: the locked policy alerts at a fixed calibrated risk of 0.35, which on validation used
0.43 false alerts per patient-day and on test 0.11, far inside the preregistered budget of 1.0. A threshold set
to the budget, chosen on training data only, should trade unused false-alert budget for caught spikes.

Protocol (train and validation partitions only; the loaders refuse test records):
  1. Patient-grouped 5-fold out-of-fold (OOF) hazard predictions on the training patients (LightGBM, the
     hazard parameters in develop.py, 300 rounds, no early stopping).
  2. Isotonic calibration fitted on the training OOF predictions, not on validation.
  3. Threshold = the one maximizing training-OOF sensitivity >=30 min ahead subject to <= 1.0 false
     alerts per patient-day, under the locked 120-min cooldown and 1-to-1 matching (develop.evaluate_event_alerts).
  4. A final hazard model fitted on all training patients is scored on validation at 0.35 and at that threshold.
     The 30-min linear-trend baseline gets the same treatment (threshold chosen on training).
EXPLORATORY: the validation partition already informed model selection and calibration in the locked run,
so these validation numbers are not independent. The locked test results are not changed or re-evaluated.
Usage: python budget_operating_point.py --data-dir /path/to/data/real
"""
import argparse, json, sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "real_data"))
import develop as dv  # noqa: E402
import lightgbm as lgb  # noqa: E402
from sklearn.isotonic import IsotonicRegression  # noqa: E402

BUDGET = 1.0
FOLDS = 5
PARAMS = {"objective": "binary", "metric": "binary_logloss", "learning_rate": 0.05, "num_leaves": 31, "verbose": -1, "random_state": dv.SEED}


def fit_predict(X_tr, y_tr, X_te):
    return lgb.train(PARAMS, lgb.Dataset(X_tr, label=y_tr), num_boost_round=300).predict(X_te)


def grouped_oof(ds):
    pids = np.asarray(ds.patient_ids)
    uniq = np.array(sorted(set(pids)))
    rng = np.random.default_rng(dv.SEED)
    fold_of = dict(zip(rng.permutation(uniq), np.arange(len(uniq)) % FOLDS))
    folds = np.array([fold_of[p] for p in pids])
    oof = np.zeros(len(pids))
    for k in range(FOLDS):
        te = folds == k
        oof[te] = fit_predict(ds.features[~te], ds.onset_label[~te], ds.features[te])
    return oof


def choose_threshold(probs, ds):
    grid = np.unique(np.round(np.concatenate([np.quantile(probs[ds.at_risk], np.linspace(0.5, 0.999, 120)), np.linspace(0.05, 1.0, 96)]), 4))
    best = (None, None)  # (threshold, result); stays None when no threshold meets the budget
    for thr in grid:
        r = dv.evaluate_event_alerts(probs, ds, threshold=float(thr))
        if r["false_alerts_per_day"] <= BUDGET and (best[0] is None or r["event_sensitivity_30m"] > best[1]["event_sensitivity_30m"]):
            best = (float(thr), r)
    return best


def summary(r, ci=None):
    out = {k: r[k] for k in ("event_sensitivity", "event_sensitivity_30m", "alert_precision", "false_alerts_per_day", "median_lead_time_min", "total_onsets", "detected_onsets", "detected_30m", "total_alerts", "false_alerts")}
    if ci:
        out["ci95"] = {k: [ci[k][1], ci[k][2]] for k in ("event_sensitivity_30m", "false_alerts_per_day") if k in ci}
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
    assert not set(ds_tr.patient_ids) & set(ds_va.patient_ids)

    oof = grouped_oof(ds_tr)
    iso = IsotonicRegression(out_of_bounds="clip").fit(oof, ds_tr.onset_label)
    oof_cal = iso.predict(oof)
    thr, tr_res = choose_threshold(oof_cal, ds_tr)
    va_cal = iso.predict(fit_predict(ds_tr.features, ds_tr.onset_label, ds_va.features))

    trend = lambda ds: np.clip((ds.trend_f60 - 140.0) / 60.0, 0.0, 1.0)  # develop.py's trend risk score
    t_thr, t_tr_res = choose_threshold(trend(ds_tr), ds_tr)

    def scored(probs, threshold):
        r = dv.evaluate_event_alerts(probs, ds_va, threshold=threshold)
        ci = dv.bootstrap_patient_metrics(ds_va.target_60, ds_va.cgm_history, probs, ds_va, event_res=r, n_boot=a.n_boot)
        return summary(r, ci)

    out = {
        "status": "EXPLORATORY (validation previously used for selection/calibration; test not loaded)",
        "seed": dv.SEED, "budget_false_alerts_per_day": BUDGET, "folds": FOLDS,
        "patients": {"train": len(set(ds_tr.patient_ids)), "val": len(set(ds_va.patient_ids))},
        "decisions": {"train": int(len(ds_tr.features)), "val": int(len(ds_va.features))},
        "hazard_lgbm": {
            "threshold_budget": thr, "train_oof_at_budget": summary(tr_res),
            "val_at_0.35_locked": scored(va_cal, 0.35), "val_at_budget": scored(va_cal, thr),
        },
        "linear_trend": ({"threshold_budget": t_thr, "train_at_budget": summary(t_tr_res), "val_at_budget": scored(trend(ds_va), t_thr)}
                         if t_thr is not None else {"threshold_budget": None, "note": "no threshold on the trend score meets <= 1.0 false alerts/patient-day on training",
                                                    "val_at_1.0": scored(trend(ds_va), 1.0)}),
    }
    (HERE / "results.json").write_text(json.dumps(out, indent=1) + "\n")
    print(json.dumps({k: v for k, v in out.items()}, indent=1)[:4000])


if __name__ == "__main__":
    main()
