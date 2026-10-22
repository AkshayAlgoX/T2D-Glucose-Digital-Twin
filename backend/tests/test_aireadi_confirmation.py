"""The frozen AI-READI confirmation harness (docs/evidence/aireadi_confirmation) on a synthetic release in the AI-READI
layout: eligibility (type 2 groups, test split, wear rules), unit handling and the frozen policy path run end to end.
Synthetic fixtures only; no AI-READI data are used or claimed."""
import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "docs" / "evidence" / "aireadi_confirmation"))
import aireadi_evaluate as ae  # noqa: E402


def write_release(tmp, people):
    (tmp / "wearable_blood_glucose").mkdir(parents=True)
    rows, man = ["person_id\tstudy_group\trecommended_split"], ["person_id\tfilename"]
    t0 = datetime(2024, 3, 1, tzinfo=timezone.utc)
    for pid, group, split, days, unit in people:
        rows.append(f"{pid}\t{group}\t{split}")
        cgm = []
        for k in range(int(days * 288)):
            g = 130 + 70 * np.sin(k / 30)
            val = g / 18.016 if unit == "mmol/L" else (39 if k == 5 else g)  # 39 mg/dL is a sensor "Low": stays missing
            cgm.append({"effective_time_frame": {"time_interval": {"start_date_time": (t0 + timedelta(minutes=5 * k)).isoformat()}},
                        "blood_glucose": {"value": val, "unit": unit}})
        f = f"dexcom_g6/{pid}/{pid}_DEX.json"
        (tmp / "wearable_blood_glucose" / f).parent.mkdir(parents=True, exist_ok=True)
        (tmp / "wearable_blood_glucose" / f).write_text(json.dumps({"header": {}, "body": {"cgm": cgm}}))
        man.append(f"{pid}\t{f}")
    (tmp / "participants.tsv").write_text("\n".join(rows))
    (tmp / "wearable_blood_glucose" / "manifest.tsv").write_text("\n".join(man))


def test_eligibility_units_and_policy_path(tmp_path):
    write_release(tmp_path, [
        ("1001", "Oral", "test", 8, "mg/dL"),       # eligible
        ("1002", "Insulin", "test", 8, "mmol/L"),   # eligible, converted
        ("1003", "No DM", "test", 8, "mg/dL"),      # not type 2
        ("1004", "Oral", "train", 8, "mg/dL"),      # not in the test split
        ("1005", "Oral", "test", 3, "mg/dL"),       # under 7 days of wear
    ])
    recs, groups, counts = ae.load_aireadi(tmp_path)
    assert sorted(r.pid for r in recs) == ["AIREADI-1001", "AIREADI-1002"]
    assert counts == {"t2d_test_participants": 3, "with_cgm_file": 3, "eligible_after_wear_rules": 2}
    assert groups == {"AIREADI-1001": "Oral", "AIREADI-1002": "Insulin"}
    oral, insulin = recs
    assert np.isnan(oral.cgm[5]) and np.isfinite(oral.cgm[6])           # Low reading left missing, not imputed
    assert 55 < np.nanmin(insulin.cgm) and np.nanmax(insulin.cgm) < 205  # mmol/L converted to mg/dL

    dx, _ = ae.dv.extract_decisions(recs, training_medians={"age": 45.0, "bmi": 27.0, "weight_kg": 75.0, "hba1c": 5.8})
    n = len(dx.features)
    assert n > 0
    for prm in ae.FROZEN.values():
        alerts = ae.controlled_alerts(np.full(n, 0.5), dx.trend_f60, np.full(n, 0.5), dx, prm)
        assert set(np.unique(alerts)) <= {0.0, 1.0}


def test_frozen_parameters_match_the_preregistration():
    pre = (ROOT / "docs" / "evidence" / "aireadi_confirmation" / "PREREGISTRATION.md").read_text()
    assert ae.FROZEN["C2"] == {"family": "C2", "tf": 240, "tg": 0.2, "tr": 0.4762}
    assert ae.FROZEN["P0"] == {"family": "P0", "t": 0.2715}
    assert "≥ 240 mg/dL AND routine risk ≥ 0.20) OR routine risk ≥ 0.476" in pre and "≥ 0.2715" in pre
    sel = json.loads((ROOT / "docs" / "evidence" / "fa_controller" / "results.json").read_text())["selected"]["C2"]["param"]
    assert (sel["tf"], sel["tg"], round(sel["tr"], 4)) == (240, 0.2, 0.4762)
