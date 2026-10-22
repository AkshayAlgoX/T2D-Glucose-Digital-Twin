"""Phase 2 of the Hall external check (PREREGISTRATION.md): one evaluation of the frozen policies on Hall et al. 2018.

Hall KM et al., "Glucotypes reveal new patterns of glucose dysregulation", PLoS Biol 2018;16(7):e2005143,
S1 Data (pbio.2005143.s010, CC BY 4.0). 57 participants, Dexcom 5-min CGM. Never used in development.
Reads frozen_policy.json (phase 1) and changes nothing in it. Models are refitted on all training patients exactly
as in phase 1 (same seed and data, so deterministic). Static EHR fields are absent in this file: they enter as
missing (training medians with missing flags, as develop.py does for any patient), and this is disclosed.
Non-numeric CGM entries ("Low"/"High") are left missing, not imputed.
Usage: python hall_evaluate.py --data-dir /path/to/data/real --hall-file /path/to/pbio.2005143.s010
"""
import argparse, gzip, hashlib, io, json, sys
from pathlib import Path

import lightgbm as lgb
import numpy as np
import pandas as pd

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "operating_point"))
import budget_operating_point as bop  # noqa: E402
from budget_operating_point import dv  # noqa: E402
from routine_target_arms import routine_features  # noqa: E402
from select_policy import evaluate, fit_models, policy_scores  # noqa: E402
from transfer_and_personalization import REG, rmse  # noqa: E402

EXPECTED_SHA256 = "47e837a8622dd5763106de943a7849e265ce9f9ab3d0ac1970b5d4166a85f484"
STATIC = {"age": np.nan, "bmi": np.nan, "weight_kg": np.nan, "hba1c": np.nan, "male": np.nan}


def load_hall(path):
    raw = Path(path).read_bytes()
    digest = hashlib.sha256(raw).hexdigest()
    if digest != EXPECTED_SHA256:
        raise SystemExit(f"Hall file sha256 {digest} != preregistered {EXPECTED_SHA256}")
    text = gzip.decompress(raw) if raw[:2] == b"\x1f\x8b" else raw
    df = pd.read_csv(io.BytesIO(text), sep="\t")
    df["t"] = pd.to_datetime(df["DisplayTime"]).dt.ceil("5min")
    df["g"] = pd.to_numeric(df["GlucoseValue"], errors="coerce")
    records = []
    for sid, g in df.groupby("subjectId"):
        g = g.sort_values("t")
        grid = pd.date_range(g["t"].min(), g["t"].max(), freq="5min")
        v = g.dropna(subset=["g"]).groupby("t")["g"].last().reindex(grid).to_numpy(dtype=float)
        records.append(dv.PatientRecord(pid=f"HALL-{sid}", dataset="hall", partition="external", time=grid.to_numpy(),
                                        cgm=v, static=dict(STATIC), diabetes_status="unknown"))
    return records, digest, int(df["g"].isna().sum())


def paired_diff(stats_a, stats_b, n_boot):
    pids = sorted(stats_a)
    on = np.array([stats_a[p]["onsets"] for p in pids], float)
    da = np.array([stats_a[p]["det_30m"] for p in pids], float)
    db = np.array([stats_b[p]["det_30m"] for p in pids], float)
    rng = np.random.default_rng(dv.SEED)
    d = []
    for _ in range(n_boot):
        w = np.bincount(rng.integers(0, len(pids), len(pids)), minlength=len(pids))
        n = (w * on).sum()
        if n > 0:
            d.append(((w * da).sum() - (w * db).sum()) / n)
    return {"point": float((da.sum() - db.sum()) / on.sum()), "ci95": [float(np.percentile(d, 2.5)), float(np.percentile(d, 97.5))]}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data-dir", required=True)
    ap.add_argument("--hall-file", required=True)
    ap.add_argument("--n-boot", type=int, default=2000)
    a = ap.parse_args()
    frozen = json.loads((HERE / "frozen_policy.json").read_text())
    sel, comp = frozen["selected"], frozen["comparator"]
    dv.DATA_DIR = Path(a.data_dir); dv.RAW_DIR = dv.DATA_DIR / "raw"
    rec = dv.load_cgmacros({"train"}) + dv.load_bigideas({"train"})
    ds, med = dv.extract_decisions(rec)
    X_rout = np.hstack([ds.features, routine_features(rec, ds)])
    _, iso_b = fit_models(ds, ds.features)
    _, iso_r = fit_models(ds, X_rout)

    hall, digest, n_nonnum = load_hall(a.hall_file)
    dh, _ = dv.extract_decisions(hall, training_medians=med)
    Xh_rout = np.hstack([dh.features, routine_features(hall, dh)])
    ph = {"base": iso_b.predict(bop.fit_predict(ds.features, ds.onset_label, dh.features)),
          "rout": iso_r.predict(bop.fit_predict(X_rout, ds.onset_label, Xh_rout))}

    res, stats = {}, {}
    for name, v in frozen["policies"].items():
        if v["param"] is None:
            continue
        p = ph["base"] if name == "P0" else ph["rout"]
        r = evaluate(name, v["param"], p, dh)
        ci = dv.bootstrap_patient_metrics(dh.target_60, dh.cgm_history, policy_scores(name, v["param"], p, dh), dh, event_res=r, n_boot=a.n_boot)
        s = bop.summary(r, ci)
        leads = [x for q in r["per_patient_stats"].values() for x in q["lead_times"]]
        s["lead_time_quartiles_min"] = [float(x) for x in np.percentile(leads, [25, 50, 75])] if leads else None
        s["per_patient_fa_per_day_range"] = [min(q["fa"] / q["days"] for q in r["per_patient_stats"].values()), max(q["fa"] / q["days"] for q in r["per_patient_stats"].values())]
        s["role"] = "selected" if name == sel else "comparator" if name == comp else "secondary"
        res[name] = s
        stats[name] = r["per_patient_stats"]
    primary = paired_diff(stats[sel], stats[comp], a.n_boot)
    success = primary["ci95"][0] > 0 and res[sel]["false_alerts_per_day"] <= bop.BUDGET

    trend = np.clip((dh.trend_f60 - 140.0) / 60.0, 0.0, 1.0)
    fin = np.isfinite(ds.target_60)
    lgb60 = lgb.train(REG, lgb.Dataset(ds.features[fin], label=ds.target_60[fin]), num_boost_round=300).predict(dh.features)
    out = {
        "phase": "2 (single evaluation of frozen policies on an unused external cohort)", "seed": dv.SEED,
        "hall_file_sha256": digest, "hall_nonnumeric_cgm_entries_left_missing": n_nonnum,
        "patients_with_decisions": len(set(dh.patient_ids)), "decisions": int(len(dh.features)),
        "onsets": int(res[sel]["total_onsets"]), "patient_days": float(sum(q["days"] for q in stats[sel].values())),
        "selected": sel, "comparator": comp, "policies": res,
        "primary_sens30_difference_selected_minus_comparator": primary, "primary_success": bool(success),
        "reference_linear_trend_at_1.0": bop.summary(dv.evaluate_event_alerts(trend, dh, threshold=1.0)),
        "rmse60_mg_dl": {"persistence": rmse(dh.target_60, dh.cgm_history), "linear_trend": rmse(dh.target_60, dh.trend_f60),
                         "reduced_twin": rmse(dh.target_60, dh.twin_f60), "lightgbm": rmse(dh.target_60, lgb60)},
    }
    (HERE / "results.json").write_text(json.dumps(out, indent=1) + "\n")
    print(json.dumps({k: out[k] for k in ("patients_with_decisions", "decisions", "onsets", "patient_days", "primary_sens30_difference_selected_minus_comparator", "primary_success", "rmse60_mg_dl")}, indent=1))
    for n, s in res.items():
        print(n, s["role"], {x: round(s[x], 3) for x in ("event_sensitivity_30m", "event_sensitivity", "false_alerts_per_day", "alert_precision", "median_lead_time_min")}, s["ci95"], s["per_patient_fa_per_day_range"])


if __name__ == "__main__":
    main()
