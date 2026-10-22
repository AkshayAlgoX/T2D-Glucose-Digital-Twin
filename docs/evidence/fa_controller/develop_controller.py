"""Training-only development of an online per-patient false-alert controller on the risk-gated trend policy (C2).

Why: C2 ((trend >= tf AND risk >= tg) OR risk >= tr) ranked best on development validation (29.3% vs 22.7% >=30 min)
and on AZT1D (26.4% vs 12.5%), but its fixed thresholds ran at ~1.2-1.3 false alerts/patient-day, over budget.
Score-quantile rules (operating_point §4, Hall P2) ignore outcomes; this controller uses each patient's own
resolved false alerts, which are known causally once an alert's 120-min window and the 15-min persistence rule close.

Controller (per patient, causal): offset d_t = clip(eta * (F_t - B * D_t), lo, hi), where F_t is the number of that
patient's alerts resolved as false by step t (no spike onset in (a, a+24]; resolved at a+27) and D_t is that patient's
elapsed monitoring days. Thresholds at t: tr + d_t, tg + d_t, tf + 100 * d_t (mg/dL). d_t < 0 loosens a quiet patient.
The 120-min cooldown, at-risk rule and 1-to-1 scoring are unchanged (develop.evaluate_event_alerts).

Selection (training data only): patient-grouped 5-fold OOF calibrated risk; for each policy family the parameters
maximizing pooled OOF sensitivity >= 30 min subject to the WORST fold's false alerts <= 1.0/patient-day (a training
proxy for transfer to new patients). Families: P0 baseline risk (static), C2 static, C2 + controller.
Validation is then scored once for each family's selected parameters, as exploratory transfer evidence only.
Test records are never loaded; Hall, AZT1D and Broll are not used.
"""
import argparse, dataclasses, itertools, json, sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "operating_point"))
import budget_operating_point as bop  # noqa: E402
from budget_operating_point import dv  # noqa: E402
from routine_target_arms import routine_features  # noqa: E402
from sklearn.isotonic import IsotonicRegression  # noqa: E402

DAY, WIN, RESOLVE = 288, 24, 27


def controlled_alerts(r, f, rb, ds, prm):
    """Alert vector (1.0 where an alert is raised) for a policy family; sequential per patient."""
    out = np.zeros(len(r))
    pids = np.asarray(ds.patient_ids)
    for pid in dict.fromkeys(pids):
        idx = np.where(pids == pid)[0]
        onsets = np.asarray(sorted(ds.spike_onsets_per_patient.get(pid, [])))
        steps = ds.decision_steps[idx]
        start, last, raised, pending, false_n = int(steps[0]), -10**9, [], [], 0
        for i, t in zip(idx, steps):
            t = int(t)
            while pending and pending[0] + RESOLVE <= t:  # resolve alerts whose window and persistence have closed
                a = pending.pop(0)
                false_n += int(not np.any((onsets > a) & (onsets <= a + WIN)))
            d = 0.0
            if prm["family"] == "C2ctl":
                d = float(np.clip(prm["eta"] * (false_n - prm["target"] * (t - start) / DAY), prm["lo"], prm["hi"]))
            if prm["family"] == "P0":
                cand = rb[i] >= prm["t"]
            else:
                cand = (f[i] >= prm["tf"] + 100 * d and r[i] >= prm["tg"] + d) or r[i] >= prm["tr"] + d
            if cand and ds.at_risk[i] and t - last >= dv.COOLDOWN_STEPS:
                out[i], last = 1.0, t
                pending.append(t)
    return out


def folds_of(ds):
    uniq = np.array(sorted(set(ds.patient_ids)))
    m = dict(zip(np.random.default_rng(dv.SEED).permutation(uniq), np.arange(len(uniq)) % bop.FOLDS))  # same as bop.grouped_oof
    return np.array([m[p] for p in ds.patient_ids])


def score(alerts, ds, folds=None):
    res = dv.evaluate_event_alerts(alerts, ds, threshold=0.5)
    out = bop.summary(res)
    if folds is not None:
        st = res["per_patient_stats"]
        pf = {}
        for p, k in zip(ds.patient_ids, folds):
            pf.setdefault(int(k), set()).add(p)
        out["fold_fa_per_day"] = [sum(st[p]["fa"] for p in ps) / sum(st[p]["days"] for p in ps) for k, ps in sorted(pf.items())]
        out["per_patient_fa_per_day"] = sorted(round(st[p]["fa"] / st[p]["days"], 2) for p in st)
    return out, res


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data-dir", required=True)
    ap.add_argument("--n-boot", type=int, default=2000)
    a = ap.parse_args()
    dv.DATA_DIR = Path(a.data_dir); dv.RAW_DIR = dv.DATA_DIR / "raw"
    rec = dv.load_cgmacros({"train"}) + dv.load_bigideas({"train"})
    rec_va = dv.load_cgmacros({"val"}) + dv.load_bigideas({"val"})
    ds, med = dv.extract_decisions(rec)
    dva, _ = dv.extract_decisions(rec_va, training_medians=med)

    def risk(X, Xv):
        oof = bop.grouped_oof(dataclasses.replace(ds, features=X))
        iso = IsotonicRegression(out_of_bounds="clip").fit(oof, ds.onset_label)
        return iso.predict(oof), iso.predict(bop.fit_predict(X, ds.onset_label, Xv))
    rb, rb_va = risk(ds.features, dva.features)
    r, r_va = risk(np.hstack([ds.features, routine_features(rec, ds)]), np.hstack([dva.features, routine_features(rec_va, dva)]))
    f, f_va = ds.trend_f60, dva.trend_f60
    folds = folds_of(ds)

    rq = [float(x) for x in np.unique(np.round(np.quantile(r[ds.at_risk], [0.95, 0.97, 0.98, 0.99, 0.995]), 4))]
    bq = [float(x) for x in np.unique(np.round(np.quantile(rb[ds.at_risk], [0.9, 0.95, 0.97, 0.98, 0.99, 0.995, 0.998]), 4))]
    grids = {
        "P0": [{"family": "P0", "t": t} for t in bq],
        "C2": [{"family": "C2", "tf": tf, "tg": tg, "tr": tr} for tf, tg, tr in itertools.product((200, 210, 220, 240), (0.1, 0.15, 0.2), rq)],
        "C2ctl": [{"family": "C2ctl", "tf": tf, "tg": 0.15, "tr": tr, "eta": eta, "target": tg_, "lo": -0.1, "hi": 0.5}
                  for tf, tr, eta, tg_ in itertools.product((200, 220), rq[:3], (0.01, 0.03, 0.06), (0.5, 0.75, 1.0))],
    }
    sel, log = {}, {}
    for fam, grid in grids.items():
        best = None
        for prm in grid:
            s, _ = score(controlled_alerts(r, f, rb, ds, prm), ds, folds)
            if max(s["fold_fa_per_day"]) <= bop.BUDGET and (best is None or s["event_sensitivity_30m"] > best[1]["event_sensitivity_30m"]):
                best = (prm, s)
        sel[fam] = best
        log[fam] = len(grid)
        print(fam, best and best[0], best and (round(best[1]["event_sensitivity_30m"], 3), [round(x, 2) for x in best[1]["fold_fa_per_day"]]), flush=True)
    val = {}
    for fam, b in sel.items():
        if b is None:
            continue
        s, res = score(controlled_alerts(r_va, f_va, rb_va, dva, b[0]), dva, None)
        alerts = controlled_alerts(r_va, f_va, rb_va, dva, b[0])
        ci = dv.bootstrap_patient_metrics(dva.target_60, dva.cgm_history, alerts, dva, event_res=res, n_boot=a.n_boot)
        s = bop.summary(res, ci)
        st = res["per_patient_stats"]
        s["per_patient_fa_per_day"] = sorted(round(st[p]["fa"] / st[p]["days"], 2) for p in st)
        val[fam] = s
        print("VAL", fam, {x: round(s[x], 3) for x in ("event_sensitivity_30m", "event_sensitivity", "false_alerts_per_day", "alert_precision", "median_lead_time_min")}, s["ci95"], s["per_patient_fa_per_day"], flush=True)
    out = {"status": "training-only selection (worst-fold false alerts <= 1.0); validation scored once, exploratory; no external cohort",
           "seed": dv.SEED, "grid_sizes": log,
           "selected": {k: ({"param": v[0], "train_oof": v[1]} if v else None) for k, v in sel.items()}, "validation": val}
    (HERE / "results.json").write_text(json.dumps(out, indent=1) + "\n")


if __name__ == "__main__":
    main()
