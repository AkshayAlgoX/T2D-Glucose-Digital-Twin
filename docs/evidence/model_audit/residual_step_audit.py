# Usage (repo root): python docs/evidence/model_audit/residual_step_audit.py OUT.json
"""How often does the factual (no-scenario) forecast median contain an isolated one-step jump? Validation split only."""
import json, sys
from pathlib import Path
import numpy as np
sys.path.insert(0, "backend")
import serve_pr_tft as S, train_pr_tft as T
ctx = S.ServiceContext(Path("runs/pr_tft_ablation_arm_d"))
split = json.loads(Path("runs/pr_tft_ablation_arm_d/split.json").read_text())
rng = np.random.default_rng(0)
iso_p50, iso_twin, n = [], [], 0
for pid in split["val"]:
    pc = ctx.patients[ctx.by_pid[pid]]
    anchors = T.eligible_anchors(pc.ps, ctx.cfg)
    for t in rng.choice(anchors, size=min(20, anchors.size), replace=False):
        base, _, _, fut, _ = ctx.rollouts(pc, int(t))
        q = ctx.run_model(pc, int(t), base, fut)["q"][:, T.MEDIAN_IDX]
        # isolation = departure of a step from the mean of its two neighbours
        iso_p50.append(float(np.max(np.abs(q[1:-1] - (q[:-2] + q[2:]) / 2))))
        iso_twin.append(float(np.max(np.abs(base[1:-1] - (base[:-2] + base[2:]) / 2))))
        n += 1
a, b = np.array(iso_p50), np.array(iso_twin)
out = {"split": "val", "patients": len(split["val"]), "anchors": n, "seed": 0,
       "final_median": {f"share_isolated_step_gt_{k}mg_dl": round(float((a > k).mean()), 3) for k in (10, 20, 40)} | {"median": round(float(np.median(a)), 2), "p95": round(float(np.percentile(a, 95)), 1), "max": round(float(a.max()), 1)},
       "twin_median": {f"share_isolated_step_gt_{k}mg_dl": round(float((b > k).mean()), 3) for k in (10, 20, 40)} | {"median": round(float(np.median(b)), 2), "max": round(float(b.max()), 1)}}
print(json.dumps(out, indent=1)); json.dump(out, open(sys.argv[1], "w"), indent=1)
