"""Development (training + validation only) of combined trend + routine-risk alert policies; writes frozen_policy.json.

Signals per decision: calibrated routine-model risk r (operating_point/routine_target_arms.py features, LightGBM hazard,
isotonic on training patient-grouped OOF) and the 30-min linear-trend projection to +60 min, f (develop.py trend_f60).
Every policy uses the locked at-risk rule, 120-min cooldown and 1-to-1 matching, plus a per-patient cap of K alerts in
any trailing 24 h (K = inf means no cap).
  P0  baseline-model risk >= t (learned comparator)
  P1  routine risk >= t
  T   f >= tf                                    (trend alone; comparator)
  C1  f >= tf  OR  r >= tr                       (either signal)
  C2  (f >= tf AND r >= tg)  OR  r >= tr         (trend confirmed by a low risk gate, or high risk alone)
Parameters: maximize TRAINING-OOF sensitivity >= 30 min with false alerts <= 1.0/patient-day.
Selection: the highest VALIDATION sensitivity >= 30 min with validation false alerts <= 1.0 among ALL policies.
(Amendment made after the development results and before any external data were read: the first rule left P0 out
and would have selected C1, which already scored below P0 on validation. Comparators are then the trend rule T and
the best-validating combined policy, so the external check asks whether the selected model beats both.)
External data are not read here. Test records are never loaded; Hall is not used.
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

DAY = 288
INF = 10**6


def candidates(name, prm, r, f, rb):
    if name == "P0":
        return rb >= prm["t"]
    if name == "P1":
        return r >= prm["t"]
    if name == "T":
        return f >= prm["tf"]
    if name == "C1":
        return (f >= prm["tf"]) | (r >= prm["tr"])
    return ((f >= prm["tf"]) & (r >= prm["tg"])) | (r >= prm["tr"])


def alerts(cand, ds, k):
    """Alert vector after the at-risk rule, the locked cooldown and the K-per-24-h cap, applied in time order."""
    out = np.zeros(len(cand))
    pids = np.asarray(ds.patient_ids)
    for pid in dict.fromkeys(pids):
        raised = []
        for i in np.where(pids == pid)[0]:
            if not (cand[i] and ds.at_risk[i]):
                continue
            t = int(ds.decision_steps[i])
            if raised and t - raised[-1] < dv.COOLDOWN_STEPS:
                continue
            if k < INF and sum(1 for a in raised if t - a < DAY) >= k:
                continue
            raised.append(t)
            out[i] = 1.0
    return out


def run(name, prm, r, f, rb, ds):
    return dv.evaluate_event_alerts(alerts(candidates(name, prm, r, f, rb), ds, prm["k"]), ds, threshold=0.5)


def best(results):
    ok = [(p, x) for p, x in results if x["false_alerts_per_day"] <= bop.BUDGET]
    return max(ok, key=lambda z: z[1]["event_sensitivity_30m"]) if ok else (None, None)


def risk_models(ds, X, Xo):
    oof = bop.grouped_oof(dataclasses.replace(ds, features=X))
    iso = IsotonicRegression(out_of_bounds="clip").fit(oof, ds.onset_label)
    return iso.predict(oof), iso.predict(bop.fit_predict(X, ds.onset_label, Xo))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data-dir", required=True)
    a = ap.parse_args()
    dv.DATA_DIR = Path(a.data_dir); dv.RAW_DIR = dv.DATA_DIR / "raw"
    rec = dv.load_cgmacros({"train"}) + dv.load_bigideas({"train"})
    rec_va = dv.load_cgmacros({"val"}) + dv.load_bigideas({"val"})
    ds, med = dv.extract_decisions(rec)
    dva, _ = dv.extract_decisions(rec_va, training_medians=med)
    rb, rb_va = risk_models(ds, ds.features, dva.features)
    r, r_va = risk_models(ds, np.hstack([ds.features, routine_features(rec, ds)]), np.hstack([dva.features, routine_features(rec_va, dva)]))
    f, f_va = ds.trend_f60, dva.trend_f60
    rq = [float(x) for x in np.unique(np.round(np.quantile(r[ds.at_risk], [0.9, 0.95, 0.97, 0.98, 0.99, 0.995, 0.998]), 4))]
    bq = [float(x) for x in np.unique(np.round(np.quantile(rb[ds.at_risk], [0.9, 0.95, 0.97, 0.98, 0.99, 0.995, 0.998]), 4))]
    tfs, ks, tgs = (180, 190, 200, 210, 220, 240), (1, 2, 3, 4, INF), (0.05, 0.1, 0.15)
    grids = {
        "P0": [{"t": t, "k": k} for t in bq for k in ks],
        "P1": [{"t": t, "k": k} for t in rq for k in ks],
        "T": [{"tf": tf, "k": k} for tf in tfs for k in ks],
        "C1": [{"tf": tf, "tr": tr, "k": k} for tf, tr, k in itertools.product(tfs, rq, ks)],
        "C2": [{"tf": tf, "tg": tg, "tr": tr, "k": k} for tf, tg, tr, k in itertools.product(tfs, tgs, rq, ks)],
    }
    chosen = {}
    for name, grid in grids.items():
        chosen[name] = best([(p, run(name, p, r, f, rb, ds)) for p in grid])
        print(name, chosen[name][0], chosen[name][1] and round(chosen[name][1]["event_sensitivity_30m"], 3), flush=True)
    val = {n: run(n, p, r_va, f_va, rb_va, dva) for n, (p, _) in chosen.items() if p is not None}
    elig = {n: x for n, x in val.items() if x["false_alerts_per_day"] <= bop.BUDGET}
    selected = max(elig, key=lambda n: elig[n]["event_sensitivity_30m"]) if elig else None
    combined = {n: x for n, x in elig.items() if n in ("C1", "C2") and n != selected}
    best_combined = max(combined, key=lambda n: combined[n]["event_sensitivity_30m"]) if combined else None
    out = {"phase": "development (training OOF parameters; validation selection; no external data read)", "seed": dv.SEED,
           "budget": bop.BUDGET, "inf_cap": INF,
           "policies": {n: {"param": p, "train_oof": bop.summary(x) if x else None, "validation": bop.summary(val[n]) if n in val else None}
                        for n, (p, x) in chosen.items()},
           "selected": selected, "comparators": [c for c in ("T", best_combined) if c and c != selected]}
    (HERE / "frozen_policy.json").write_text(json.dumps(out, indent=1) + "\n")
    for n, v in out["policies"].items():
        w = v["validation"]
        print(n, "val", w and (round(w["event_sensitivity_30m"], 3), round(w["event_sensitivity"], 3), round(w["false_alerts_per_day"], 2), w["median_lead_time_min"]))
    print("selected:", selected, "comparators:", out["comparators"])


if __name__ == "__main__":
    main()
