"""Exploratory: (A) why the routine model's training threshold breaks the false-alert budget on new patients, and a
causal per-patient fix; (B) does online per-patient personalization of the 60-min forecast beat strong baselines?

A. Root cause tested: one pooled threshold cannot hold a per-patient budget when patients' risk scales differ
   (locked validation record: per-patient false alerts 0-1.31/day; half the patients raised no alert).
   Rules compared, every parameter chosen on TRAINING patient-grouped OOF predictions only:
     global   - one threshold (as before).
     own_rate - each patient's threshold at decision t is the q-quantile of that patient's OWN risk scores over the
                previous 3 days of at-risk decisions (causal), used once >= 1 day of history exists; before that,
                the global threshold.
     floor    - max(global_floor, own_rate threshold): rate control that never alerts on a near-zero score.
   q (and the floor) are chosen to maximize training-OOF sensitivity >=30 min at <= 1.0 false alert/patient-day.
   Validation is scored once per rule; transfer is judged by whether validation stays within the budget.
B. 60-min forecast (RMSE, mg/dL): persistence, the reduced UKF twin prior (develop.py twin_f60), LightGBM direct
   (patient-grouped OOF on training; fitted on all training for validation), and each of twin/LightGBM plus an
   online bias correction: add beta * the exponentially weighted mean of that patient's own realised 60-min errors
   (an error is used only once its outcome is observed, i.e. from forecasts issued >= 12 steps earlier).
   alpha and beta are chosen on training OOF. Patient-bootstrap 95% CIs on validation RMSE differences.
EXPLORATORY; test records are never loaded; the locked evaluation is unchanged.
Usage: python transfer_and_personalization.py --data-dir /path/to/data/real
"""
import argparse, dataclasses, json
from pathlib import Path

import lightgbm as lgb
import numpy as np

import budget_operating_point as bop
from budget_operating_point import dv
from routine_target_arms import routine_features
from sklearn.isotonic import IsotonicRegression

HERE = Path(__file__).resolve().parent
DAY = 288
REG = {"objective": "regression", "metric": "rmse", "learning_rate": 0.05, "num_leaves": 31, "feature_fraction": 0.8,
       "bagging_fraction": 0.8, "bagging_freq": 1, "verbose": -1, "random_state": dv.SEED}


def by_patient(ds):
    pids = np.asarray(ds.patient_ids)
    return {p: np.where(pids == p)[0] for p in sorted(set(pids))}


def own_rate_thresholds(p, ds, q, fallback, floor=0.0):
    """Per-decision threshold from each patient's own past 3 days of at-risk scores (causal)."""
    thr = np.full(len(p), fallback, float)
    for _, idx in by_patient(ds).items():
        steps, risk, scores = ds.decision_steps[idx], ds.at_risk[idx], p[idx]
        for j in range(len(idx)):
            past = (steps < steps[j]) & (steps >= steps[j] - 3 * DAY) & risk
            if steps[j] - steps[0] >= DAY and past.sum() >= 100:
                thr[idx[j]] = max(floor, float(np.quantile(scores[:j][past[:j]], q)))
    return thr


def score(p, thr, ds):
    return dv.evaluate_event_alerts(p - thr, ds, threshold=0.0)


def pick(results):
    ok = [(k, r) for k, r in results if r["false_alerts_per_day"] <= bop.BUDGET]
    return max(ok, key=lambda x: x[1]["event_sensitivity_30m"]) if ok else (None, None)


def part_a(ds_tr, ds_va, Xtr, Xva, n_boot):
    oof = bop.grouped_oof(dataclasses.replace(ds_tr, features=Xtr))
    iso = IsotonicRegression(out_of_bounds="clip").fit(oof, ds_tr.onset_label)
    p_tr, p_va = iso.predict(oof), iso.predict(bop.fit_predict(Xtr, ds_tr.onset_label, Xva))
    g_thr, _ = bop.choose_threshold(p_tr, ds_tr)
    qs = (0.95, 0.97, 0.98, 0.985, 0.99, 0.993, 0.995)
    floors = (0.05, 0.1, 0.15, 0.2)
    rules = {"global": (g_thr, {}),
             "own_rate": pick([((q,), score(p_tr, own_rate_thresholds(p_tr, ds_tr, q, g_thr), ds_tr)) for q in qs]),
             "floor": pick([((q, f), score(p_tr, own_rate_thresholds(p_tr, ds_tr, q, g_thr, f), ds_tr)) for q in qs for f in floors])}
    out = {}
    for name, (param, tr_res) in rules.items():
        if param is None:
            out[name] = {"note": "no parameter meets the budget on training OOF"}; continue
        t_tr = np.full(len(p_tr), g_thr) if name == "global" else own_rate_thresholds(p_tr, ds_tr, param[0], g_thr, param[1] if len(param) > 1 else 0.0)
        t_va = np.full(len(p_va), g_thr) if name == "global" else own_rate_thresholds(p_va, ds_va, param[0], g_thr, param[1] if len(param) > 1 else 0.0)
        r_tr, r_va = score(p_tr, t_tr, ds_tr), score(p_va, t_va, ds_va)
        ci = dv.bootstrap_patient_metrics(ds_va.target_60, ds_va.cgm_history, p_va - t_va, ds_va, event_res=r_va, n_boot=n_boot)
        per_fa = sorted(round(s["fa"] / s["days"], 2) for s in r_va["per_patient_stats"].values())
        out[name] = {"param": param if name != "global" else g_thr, "train_oof": bop.summary(r_tr), "validation": bop.summary(r_va, ci),
                     "validation_per_patient_fa_per_day": per_fa,
                     "validation_patients_without_alerts": int(sum(s["alerts"] == 0 for s in r_va["per_patient_stats"].values()))}
    return out


def ew_correct(pred, ds, alpha, beta):
    """pred + beta * EW mean of the patient's realised 60-min errors, each used only after its outcome time."""
    out = pred.copy()
    for _, idx in by_patient(ds).items():
        steps = ds.decision_steps[idx]
        pos = {int(s): k for k, s in enumerate(steps)}
        err = ds.target_60[idx] - pred[idx]
        ew, have = 0.0, False
        for k, s in enumerate(steps):
            src = pos.get(int(s) - 12)  # forecast issued 60 min ago: its outcome is the reading at s
            if src is not None and np.isfinite(err[src]):
                ew = err[src] if not have else alpha * err[src] + (1 - alpha) * ew
                have = True
            if have:
                out[idx[k]] = pred[idx[k]] + beta * ew
    return out


def rmse(y, f):
    m = np.isfinite(y) & np.isfinite(f)
    return float(np.sqrt(np.mean((y[m] - f[m]) ** 2)))


def boot_diff(ds, y, a, b, n_boot):
    groups = list(by_patient(ds).values())
    rng = np.random.default_rng(dv.SEED)
    d = []
    for _ in range(n_boot):
        idx = np.concatenate([groups[i] for i in rng.integers(0, len(groups), len(groups))])
        d.append(rmse(y[idx], a[idx]) - rmse(y[idx], b[idx]))
    return [float(np.percentile(d, 2.5)), float(np.percentile(d, 97.5))]


def part_b(ds_tr, ds_va, Xtr, Xva, n_boot):
    y_tr, y_va = ds_tr.target_60, ds_va.target_60
    fin = np.isfinite(y_tr)
    pids = np.asarray(ds_tr.patient_ids)
    uniq = np.array(sorted(set(pids)))
    fold_of = dict(zip(np.random.default_rng(dv.SEED).permutation(uniq), np.arange(len(uniq)) % bop.FOLDS))
    folds = np.array([fold_of[p] for p in pids])
    lgb_tr = np.zeros(len(y_tr))
    for k in range(bop.FOLDS):
        te = folds == k
        tr = ~te & fin
        lgb_tr[te] = lgb.train(REG, lgb.Dataset(Xtr[tr], label=y_tr[tr]), num_boost_round=300).predict(Xtr[te])
    lgb_va = lgb.train(REG, lgb.Dataset(Xtr[fin], label=y_tr[fin]), num_boost_round=300).predict(Xva)
    base = {"persistence": (ds_tr.cgm_history, ds_va.cgm_history), "twin": (ds_tr.twin_f60, ds_va.twin_f60), "lightgbm": (lgb_tr, lgb_va)}
    out = {"train_oof_rmse60": {k: rmse(y_tr, v[0]) for k, v in base.items()}, "val_rmse60": {k: rmse(y_va, v[1]) for k, v in base.items()}, "online": {}}
    for name in ("twin", "lightgbm"):
        a_tr, a_va = base[name]
        grid = [(al, be) for al in (0.02, 0.05, 0.1, 0.2) for be in (0.25, 0.5, 0.75, 1.0)]
        al, be = min(grid, key=lambda g: rmse(y_tr, ew_correct(a_tr, ds_tr, *g)))
        c_tr, c_va = ew_correct(a_tr, ds_tr, al, be), ew_correct(a_va, ds_va, al, be)
        out["online"][name + "+online"] = {"alpha": al, "beta": be, "train_oof_rmse60": rmse(y_tr, c_tr), "val_rmse60": rmse(y_va, c_va),
                                           "val_diff_vs_uncorrected_ci95": boot_diff(ds_va, y_va, c_va, a_va, n_boot),
                                           "val_diff_vs_lightgbm_ci95": boot_diff(ds_va, y_va, c_va, lgb_va, n_boot)}
    return out


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
    Xtr = np.hstack([ds_tr.features, routine_features(rec_tr, ds_tr)])
    Xva = np.hstack([ds_va.features, routine_features(rec_va, ds_va)])
    out = {"status": "EXPLORATORY (choices on training OOF; validation previously used; test not loaded)", "seed": dv.SEED,
           "A_threshold_transfer_routine_model": part_a(ds_tr, ds_va, Xtr, Xva, a.n_boot)}
    (HERE / "transfer_personalization_results.json").write_text(json.dumps(out, indent=1) + "\n")
    out["B_online_personalization_rmse60"] = part_b(ds_tr, ds_va, Xtr, Xva, a.n_boot)
    (HERE / "transfer_personalization_results.json").write_text(json.dumps(out, indent=1) + "\n")


if __name__ == "__main__":
    main()
