"""Frozen confirmation of the C2 early-warning candidate on AI-READI (PREREGISTRATION.md). Not run: data not yet approved.

Reads an approved, locally downloaded AI-READI release (FAIRhub; Dexcom G6 5-min CGM in Open mHealth JSON):
  participants.tsv                          person_id, study_group, recommended_split
  wearable_blood_glucose/manifest.tsv       person_id, filename (relative path to the CGM JSON)
CGM JSON: body.cgm[*].effective_time_frame.time_interval.start_date_time, body.cgm[*].blood_glucose.{value,unit}.
Readings outside 40-400 mg/dL (sensor Low/High) and non-numeric values stay missing; mmol/L is converted (x 18.016).
Eligible: study_group in {Oral, Insulin} (type 2 diabetes), recommended_split == "test", >= 7 days of wear (2,016 unique
5-min epochs) and >= 70% active wear over the wear span. Models and policies are fixed: nothing here is fitted on AI-READI.
Usage: python aireadi_evaluate.py --data-dir <repo>/data/real --aireadi-dir <approved AI-READI release root>
"""
import argparse, dataclasses, json, sys
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "operating_point"))
sys.path.insert(0, str(HERE.parent / "fa_controller"))
import budget_operating_point as bop  # noqa: E402
from budget_operating_point import dv  # noqa: E402
from routine_target_arms import routine_features  # noqa: E402
from develop_controller import controlled_alerts  # noqa: E402

FROZEN = {"C2": {"family": "C2", "tf": 240, "tg": 0.2, "tr": 0.4762}, "P0": {"family": "P0", "t": 0.2715}}
T2D_GROUPS = ("Oral", "Insulin")
MIN_EPOCHS, MIN_ACTIVE = 2016, 0.70
STATIC = {"age": np.nan, "bmi": np.nan, "weight_kg": np.nan, "hba1c": np.nan, "male": np.nan}


def read_cgm_json(path):
    body = json.loads(Path(path).read_text()).get("body", {})
    rows = []
    for r in body.get("cgm", []) if isinstance(body, dict) else []:
        try:
            t = r["effective_time_frame"]["time_interval"]["start_date_time"]
            bg = r["blood_glucose"]
            v = float(bg["value"]) * (18.016 if str(bg.get("unit", "mg/dL")).lower().startswith("mmol") else 1.0)
        except (KeyError, TypeError, ValueError):
            continue
        rows.append((t, v if 40.0 <= v <= 400.0 else np.nan))
    return rows


def to_record(pid, rows):
    if not rows:
        return None
    df = pd.DataFrame(rows, columns=["t", "g"])
    df["t"] = pd.to_datetime(df["t"], utc=True, errors="coerce").dt.tz_convert(None).dt.ceil("5min")
    df = df.dropna(subset=["t"])
    if df.empty:
        return None
    grid = pd.date_range(df["t"].min(), df["t"].max(), freq="5min")
    v = df.dropna(subset=["g"]).groupby("t")["g"].last().reindex(grid).to_numpy(dtype=float)
    epochs = int(np.isfinite(v).sum())
    if epochs < MIN_EPOCHS or epochs / len(v) < MIN_ACTIVE:
        return None
    return dv.PatientRecord(pid=f"AIREADI-{pid}", dataset="aireadi", partition="external", time=grid.to_numpy(), cgm=v,
                            static=dict(STATIC), diabetes_status="unknown")


def load_aireadi(root):
    root = Path(root)
    part = pd.read_csv(root / "participants.tsv", sep="\t", dtype=str)
    man = pd.read_csv(root / "wearable_blood_glucose" / "manifest.tsv", sep="\t", dtype=str)
    elig = part[part["study_group"].isin(T2D_GROUPS) & (part["recommended_split"].str.lower() == "test")]
    m = man.merge(elig[["person_id", "study_group"]], on="person_id")
    recs, groups, counts = [], {}, {"t2d_test_participants": int(len(elig)), "with_cgm_file": int(m["person_id"].nunique())}
    for pid, g in m.groupby("person_id"):
        rows = [row for f in g["filename"] for row in read_cgm_json(root / "wearable_blood_glucose" / f)]
        rec = to_record(pid, rows)
        if rec is not None:
            recs.append(rec)
            groups[rec.pid] = g["study_group"].iloc[0]
    counts["eligible_after_wear_rules"] = len(recs)
    return recs, groups, counts


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data-dir", required=True)
    ap.add_argument("--aireadi-dir", required=True)
    ap.add_argument("--n-boot", type=int, default=2000)
    a = ap.parse_args()
    dv.DATA_DIR = Path(a.data_dir); dv.RAW_DIR = dv.DATA_DIR / "raw"
    rec = dv.load_cgmacros({"train"}) + dv.load_bigideas({"train"})
    ds, med = dv.extract_decisions(rec)
    from sklearn.isotonic import IsotonicRegression
    Xr = np.hstack([ds.features, routine_features(rec, ds)])
    iso = lambda X: IsotonicRegression(out_of_bounds="clip").fit(bop.grouped_oof(dataclasses.replace(ds, features=X)), ds.onset_label)
    iso_b, iso_r = iso(ds.features), iso(Xr)

    recs, groups, counts = load_aireadi(a.aireadi_dir)
    dx, _ = dv.extract_decisions(recs, training_medians=med)
    rb = iso_b.predict(bop.fit_predict(ds.features, ds.onset_label, dx.features))
    r = iso_r.predict(bop.fit_predict(Xr, ds.onset_label, np.hstack([dx.features, routine_features(recs, dx)])))
    res, stats = {}, {}
    for name, prm in FROZEN.items():
        al = controlled_alerts(r, dx.trend_f60, rb, dx, prm)
        ev = dv.evaluate_event_alerts(al, dx, threshold=0.5)
        ci = dv.bootstrap_patient_metrics(dx.target_60, dx.cgm_history, al, dx, event_res=ev, n_boot=a.n_boot)
        res[name], stats[name] = bop.summary(ev, ci), ev["per_patient_stats"]
    pids = sorted(stats["C2"])
    on = np.array([stats["C2"][p]["onsets"] for p in pids], float)
    d1 = np.array([stats["C2"][p]["det_30m"] for p in pids], float)
    d0 = np.array([stats["P0"][p]["det_30m"] for p in pids], float)
    rng = np.random.default_rng(dv.SEED)
    diffs = [((w * d1).sum() - (w * d0).sum()) / (w * on).sum() for w in
             (np.bincount(rng.integers(0, len(pids), len(pids)), minlength=len(pids)) for _ in range(a.n_boot)) if (w * on).sum() > 0]
    diff = {"point": float((d1.sum() - d0.sum()) / on.sum()), "ci95": [float(np.percentile(diffs, 2.5)), float(np.percentile(diffs, 97.5))]}
    out = {"phase": "single frozen confirmation run", "counts": counts, "groups": {g: sum(v == g for v in groups.values()) for g in T2D_GROUPS},
           "policies": res, "primary_sens30_difference_C2_minus_P0": diff,
           "primary_success": bool(diff["ci95"][0] > 0 and res["C2"]["false_alerts_per_day"] <= bop.BUDGET)}
    (HERE / "results.json").write_text(json.dumps(out, indent=1) + "\n")
    print(json.dumps({k: out[k] for k in ("counts", "groups", "primary_sens30_difference_C2_minus_P0", "primary_success")}, indent=1))


if __name__ == "__main__":
    main()
