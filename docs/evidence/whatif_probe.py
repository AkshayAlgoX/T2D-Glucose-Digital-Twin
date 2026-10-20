"""Capture genuine backend + proxy What-If responses for P0017 and re-derive every displayed number."""
import json, sys, uuid, urllib.request, urllib.error
# Usage: python docs/evidence/whatif_probe.py OUT.json [BACKEND_URL] [DASHBOARD_URL]
# Needs the backend (serve_pr_tft.py) and the dashboard (next dev) running; nothing is simulated here.
OUT = sys.argv[1]
BACK = sys.argv[2] if len(sys.argv) > 2 else "http://127.0.0.1:8001"
PROXY = sys.argv[3] if len(sys.argv) > 3 else "http://localhost:3000"
SID = str(uuid.uuid5(uuid.UUID("6f0c3a52-9d1e-4c57-8a2b-3e41d7b9c0aa"), "P0017"))
def post(url, body):
    req = urllib.request.Request(url, json.dumps(body).encode(), {"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=120) as r: return r.status, json.load(r)
    except urllib.error.HTTPError as e: return e.code, json.load(e)
INPUTS = {
  "meal_60g_+30": {"kind": "meal", "offset_min": 30, "carbs_g": 60},
  "walk_30min_now": {"kind": "activity", "offset_min": 0, "duration_min": 30, "intensity": "moderate"},
  "skip_lunch": {"kind": "skip_habitual_meal", "meal_slot": "lunch"},
  "medication": {"kind": "medication", "offset_min": 0, "med_class": "metformin", "taken": True},
}
ANCHORS = ["2026-09-28T23:55:00Z", "2026-09-29T05:55:00Z", "2026-10-05T07:30:00Z"]
record = {"subject_id": SID, "patient_id": "P0017", "runs": []}
for as_of in ANCHORS:
    for name, inp in INPUTS.items():
        sc = [{"scenario_id": "what-if", "inputs": [inp]}]
        bs, braw = post(f"{BACK}/v1/forecasts", {"schema_version": "1.0.0", "request_id": str(uuid.uuid4()), "subject_id": SID,
                         "as_of": as_of, "include": ["scenarios", "twin_overlay"], "scenarios": sc})
        ps, praw = post(f"{PROXY}/api/forecast", {"patientId": SID, "pinned_as_of": as_of, "scenarios": sc})
        row = {"as_of": as_of, "scenario": name, "input": inp, "backend_status": bs, "proxy_status": ps}
        if bs == 200:
            base = [p["p50"] for p in braw["forecast"]["points"]]; s = braw["scenarios"][0]
            scen = [p["p50"] for p in s["points"]]
            bp = braw["spike_risk"]["probability_120m"] if braw["spike_risk"] else None
            row.update({
              "cohort": braw["subject"]["cohort"], "fallback_used": braw["model"].get("fallback_used"),
              "current_mg_dl": braw["current"]["value_mg_dl"],
              "baseline_peak_max_p50": max(base), "baseline_peak_offset_min": (base.index(max(base)) + 1) * 5,
              "scenario_peak_max_p50": max(scen), "scenario_peak_offset_min": (scen.index(max(scen)) + 1) * 5,
              "backend_delta_peak_mg_dl": s["delta_peak_mg_dl"], "rederived_delta_peak": round(max(scen) - max(base), 1),
              "baseline_p120": bp, "scenario_p120": s.get("probability_120m"), "backend_delta_probability": s.get("delta_probability"),
              "warnings": [w["code"] for w in braw.get("warnings", [])],
              "proxy_metrics": praw.get("metrics"),
              "proxy_matches_backend": (praw.get("metrics", {}).get("new_peak_mg_dl") == max(scen)
                                        and praw.get("metrics", {}).get("baseline_peak_mg_dl") == max(base)
                                        and praw.get("metrics", {}).get("delta_peak_mg_dl") == s["delta_peak_mg_dl"]),
              "max_abs_curve_diff_mg_dl": round(max(abs(a - b) for a, b in zip(scen, base)), 1),
            })
        else:
            row.update({"backend_problem": braw, "proxy_problem": praw})
        record["runs"].append(row)
json.dump(record, open(OUT, "w"), indent=1)
for r in record["runs"]:
    if r["backend_status"] == 200:
        print(f'{r["as_of"]} {r["scenario"]:15s} peak {r["baseline_peak_max_p50"]}→{r["scenario_peak_max_p50"]} (backend Δ {r["backend_delta_peak_mg_dl"]}, rederived {r["rederived_delta_peak"]}) '
              f'risk {r["baseline_p120"]}→{r["scenario_p120"]} Δ{r["backend_delta_probability"]} maxcurveΔ {r["max_abs_curve_diff_mg_dl"]} warn {r["warnings"]} proxy_ok {r["proxy_matches_backend"]} [{r["cohort"]}, fallback={r["fallback_used"]}]')
    else:
        print(f'{r["as_of"]} {r["scenario"]:15s} backend {r["backend_status"]} {r["backend_problem"].get("code")} proxy {r["proxy_status"]} {r["proxy_problem"].get("code")}')
