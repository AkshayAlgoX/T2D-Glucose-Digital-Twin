"""Single preregistered external evaluation (PREREGISTRATION.md) on AZT1D (primary) and Broll (secondary).

AZT1D: Khamesian et al. 2025, Mendeley Data doi:10.17632/gk9m674wcx.1, CC BY 4.0; 25 people with type 1 diabetes on
  automated insulin delivery, Dexcom G6 5-min CGM. Only the CGM column is used.
Broll: iglu R package example_data_5_subject (Broll et al.), GPL-2; 5 people with type 2 diabetes (no insulin,
  HbA1c >= 6.5%), Dexcom G4 5-min CGM. Read from a CSV converted from the .rda with pyreadr (hashes below).
Neither was used in any development step. Hall and the locked test partition are not used.
Reads frozen_policy.json unchanged; refits the models on all training patients exactly as select_combined.py does.
Static EHR fields are absent: they enter as missing (training medians plus missing flags), as for any patient.
Usage: python external_evaluate.py --data-dir <repo>/data/real --azt1d-zip <AZT1D 2025.zip> --broll-csv <broll_5_subject.csv>
"""
import argparse, hashlib, io, json, sys, zipfile
from pathlib import Path

import lightgbm as lgb
import numpy as np
import pandas as pd

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "operating_point"))
import budget_operating_point as bop  # noqa: E402
from budget_operating_point import dv  # noqa: E402
from routine_target_arms import routine_features  # noqa: E402
from select_combined import alerts, candidates, risk_models  # noqa: E402
from transfer_and_personalization import REG, rmse  # noqa: E402

SHA = {"azt1d": "2c6b4183fdc729c708c1b3230ab1988d2c9006dd35729537f2de07f649f0d113",
       "broll_csv": "4f632b6d70cece144c9f30bc363f4a7dcf5ca0e291972fe940db5bdb1ffa5d20"}
STATIC = {"age": np.nan, "bmi": np.nan, "weight_kg": np.nan, "hba1c": np.nan, "male": np.nan}


def check(path, key):
    d = hashlib.sha256(Path(path).read_bytes()).hexdigest()
    if d != SHA[key]:
        raise SystemExit(f"{key}: sha256 {d} != preregistered {SHA[key]}")
    return d


def to_record(pid, dataset, t, g):
    df = pd.DataFrame({"t": pd.to_datetime(t).dt.ceil("5min"), "g": pd.to_numeric(g, errors="coerce")}).dropna(subset=["t"])
    grid = pd.date_range(df["t"].min(), df["t"].max(), freq="5min")
    v = df.dropna(subset=["g"]).groupby("t")["g"].last().reindex(grid).to_numpy(dtype=float)
    return dv.PatientRecord(pid=pid, dataset=dataset, partition="external", time=grid.to_numpy(), cgm=v, static=dict(STATIC), diabetes_status="unknown")


def load_azt1d(path):
    recs = []
    with zipfile.ZipFile(path) as z:
        for name in sorted(n for n in z.namelist() if n.startswith("AZT1D 2025/CGM Records/") and n.endswith(".csv")):
            df = pd.read_csv(io.BytesIO(z.read(name)), usecols=["EventDateTime", "CGM"])
            recs.append(to_record("AZT1D-" + Path(name).stem.replace(" ", ""), "azt1d", df["EventDateTime"], df["CGM"]))
    return recs


def load_broll(path):
    df = pd.read_csv(path)
    return [to_record("BROLL-" + sid.replace(" ", ""), "broll", g["time"], g["gl"]) for sid, g in df.groupby("id")]


def paired(sa, sb, n_boot):
    pids = sorted(sa)
    on = np.array([sa[p]["onsets"] for p in pids], float)
    da, db = (np.array([s[p]["det_30m"] for p in pids], float) for s in (sa, sb))
    rng = np.random.default_rng(dv.SEED)
    d = []
    for _ in range(n_boot):
        w = np.bincount(rng.integers(0, len(pids), len(pids)), minlength=len(pids))
        if (w * on).sum() > 0:
            d.append(((w * da).sum() - (w * db).sum()) / (w * on).sum())
    return {"point": float((da.sum() - db.sum()) / max(on.sum(), 1)), "ci95": [float(np.percentile(d, 2.5)), float(np.percentile(d, 97.5))]}


def evaluate_cohort(recs, ctx, frozen, n_boot):
    dx, _ = dv.extract_decisions(recs, training_medians=ctx["med"])
    assert dx.cgm_history.ndim == 1, "cgm_history must be the current reading per decision"
    rb = ctx["iso_b"].predict(bop.fit_predict(ctx["Xb"], ctx["y"], dx.features))
    r = ctx["iso_r"].predict(bop.fit_predict(ctx["Xr"], ctx["y"], np.hstack([dx.features, routine_features(recs, dx)])))
    pol, stats = {}, {}
    for name, v in frozen["policies"].items():
        if v["param"] is None:
            continue
        a = alerts(candidates(name, v["param"], r, dx.trend_f60, rb), dx, v["param"]["k"])
        res = dv.evaluate_event_alerts(a, dx, threshold=0.5)
        ci = dv.bootstrap_patient_metrics(dx.target_60, dx.cgm_history, a, dx, event_res=res, n_boot=n_boot)
        s = bop.summary(res, ci)
        leads = [x for q in res["per_patient_stats"].values() for x in q["lead_times"]]
        s["lead_time_quartiles_min"] = [float(x) for x in np.percentile(leads, [25, 50, 75])] if leads else None
        fa = [q["fa"] / q["days"] for q in res["per_patient_stats"].values() if q["days"] > 0]
        s["per_patient_fa_per_day"] = {"min": float(min(fa)), "median": float(np.median(fa)), "max": float(max(fa))}
        s["per_patient_sens30"] = sorted(round(q["det_30m"] / q["onsets"], 3) for q in res["per_patient_stats"].values() if q["onsets"] > 0)
        pol[name], stats[name] = s, res["per_patient_stats"]
    sel = frozen["selected"]
    diffs = {c: paired(stats[sel], stats[c], n_boot) for c in frozen["comparators"]}
    rm = {}
    for h in (30, 60, 120):
        y = getattr(dx, f"target_{h}")
        fin = np.isfinite(getattr(ctx["ds"], f"target_{h}"))
        model = lgb.train(REG, lgb.Dataset(ctx["Xb"][fin], label=getattr(ctx["ds"], f"target_{h}")[fin]), num_boost_round=300)
        rm[str(h)] = {"persistence": rmse(y, dx.cgm_history), "linear_trend": rmse(y, getattr(dx, f"trend_f{h}")),
                      "reduced_twin": rmse(y, getattr(dx, f"twin_f{h}")), "lightgbm": rmse(y, model.predict(dx.features))}
    return {"patients": len(set(dx.patient_ids)), "decisions": int(len(dx.features)),
            "patient_days": float(sum(q["days"] for q in stats[sel].values())), "onsets": int(pol[sel]["total_onsets"]),
            "policies": pol, "sens30_difference_selected_minus": diffs,
            "success": bool(all(d["ci95"][0] > 0 for d in diffs.values()) and pol[sel]["false_alerts_per_day"] <= bop.BUDGET),
            "rmse_mg_dl": rm}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data-dir", required=True)
    ap.add_argument("--azt1d-zip", required=True)
    ap.add_argument("--broll-csv", required=True)
    ap.add_argument("--n-boot", type=int, default=2000)
    a = ap.parse_args()
    frozen = json.loads((HERE / "frozen_policy.json").read_text())
    hashes = {"azt1d": check(a.azt1d_zip, "azt1d"), "broll_csv": check(a.broll_csv, "broll_csv")}
    dv.DATA_DIR = Path(a.data_dir); dv.RAW_DIR = dv.DATA_DIR / "raw"
    rec = dv.load_cgmacros({"train"}) + dv.load_bigideas({"train"})
    ds, med = dv.extract_decisions(rec)
    Xr = np.hstack([ds.features, routine_features(rec, ds)])
    from sklearn.isotonic import IsotonicRegression
    import dataclasses
    iso = lambda X: IsotonicRegression(out_of_bounds="clip").fit(bop.grouped_oof(dataclasses.replace(ds, features=X)), ds.onset_label)
    ctx = {"ds": ds, "med": med, "y": ds.onset_label, "Xb": ds.features, "Xr": Xr, "iso_b": iso(ds.features), "iso_r": iso(Xr)}
    out = {"phase": "single preregistered external evaluation", "seed": dv.SEED, "input_sha256": hashes,
           "selected": frozen["selected"], "comparators": frozen["comparators"],
           "primary_AZT1D": evaluate_cohort(load_azt1d(a.azt1d_zip), ctx, frozen, a.n_boot),
           "secondary_Broll_T2D": evaluate_cohort(load_broll(a.broll_csv), ctx, frozen, a.n_boot)}
    out["primary_success"] = out["primary_AZT1D"]["success"]
    (HERE / "results.json").write_text(json.dumps(out, indent=1) + "\n")
    for c in ("primary_AZT1D", "secondary_Broll_T2D"):
        o = out[c]
        print(c, {k: o[k] for k in ("patients", "decisions", "patient_days", "onsets", "success")}, o["sens30_difference_selected_minus"])
        for n, s in o["policies"].items():
            print("  ", n, {x: round(s[x], 3) for x in ("event_sensitivity_30m", "event_sensitivity", "false_alerts_per_day", "alert_precision", "median_lead_time_min")}, s["ci95"], s["per_patient_fa_per_day"])
        print("   RMSE", {h: {k: round(v, 2) for k, v in d.items()} for h, d in o["rmse_mg_dl"].items()})


if __name__ == "__main__":
    main()
