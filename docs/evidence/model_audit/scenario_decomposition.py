# Usage (repo root): python docs/evidence/model_audit/scenario_decomposition.py OUT.json
"""Audit the P0017 05:55 meal scenario: twin vs network residual per step, and the future-input block."""
import json, sys, uuid, datetime as dt
from pathlib import Path
import numpy as np
sys.path.insert(0, "backend")
import serve_pr_tft as S, train_pr_tft as T
ctx = S.ServiceContext(Path("runs/pr_tft_ablation_arm_d"))
sid = uuid.uuid5(S.SUBJECT_NAMESPACE, "P0017"); pc = ctx.patient(sid)
t = ctx.anchor_index(pc, dt.datetime(2026, 9, 29, 5, 55, tzinfo=dt.timezone.utc))
print("anchor", pc.ps.stamps[t], "t", t)
base0, _, _, fut0, _ = ctx.rollouts(pc, t)
extra = np.zeros((1, T.HORIZON)); extra[0, S.scenario_meal_row(30)] += 60
base1, _, _, fut1, _ = ctx.rollouts(pc, t, extra, np.zeros((1, T.HORIZON * T.STEP_MIN)), np.ones((1, T.HORIZON)))
q0 = ctx.run_model(pc, t, base0, fut0)["q"][:, T.MEDIAN_IDX]; q1 = ctx.run_model(pc, t, base1, fut1)["q"][:, T.MEDIAN_IDX]
train_prob_max = None
print("meal row", S.scenario_meal_row(30), "-> offset", (S.scenario_meal_row(30) + 1) * 5, "min")
print(" off | twin_base twin_scen | p50_base p50_scen | resid_base resid_scen | prob_base prob_scen carbs_scen")
rows = []
for k in range(T.HORIZON):
    r = dict(off=(k + 1) * 5, twin_b=float(base0[k]), twin_s=float(base1[k]), p50_b=float(q0[k]), p50_s=float(q1[k]),
             res_b=float(q0[k] - base0[k]), res_s=float(q1[k] - base1[k]), prob_b=float(fut0[k, 2]), prob_s=float(fut1[k, 2]),
             carbs_s=float(fut1[k, 3] * ctx.norm.carbs_std))
    rows.append(r)
    print(f"{r['off']:4d} | {r['twin_b']:8.1f} {r['twin_s']:8.1f} | {r['p50_b']:8.1f} {r['p50_s']:8.1f} | {r['res_b']:8.1f} {r['res_s']:8.1f} | {r['prob_b']:.3f} {r['prob_s']:.3f} {r['carbs_s']:6.1f}")
json.dump({"anchor": str(pc.ps.stamps[t]), "rows": rows}, open(sys.argv[1], "w"), indent=1)
