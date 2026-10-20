# Usage (repo root): python docs/evidence/model_audit/training_input_range.py > OUT.json
"""Training range of the future meal channels the network was fitted on (habit prior per 5-min bin)."""
import json, sys
from pathlib import Path
import numpy as np
sys.path.insert(0, "backend")
import serve_pr_tft as S, train_pr_tft as T
ctx = S.ServiceContext(Path("runs/pr_tft_ablation_arm_d"))
split = json.loads(Path("runs/pr_tft_ablation_arm_d/split.json").read_text())
pmax, cmax, n = 0.0, 0.0, 0
for pid in split["train"]:
    pc = ctx.patients[ctx.by_pid[pid]]
    t = T.eligible_anchors(pc.ps, ctx.cfg)
    prob, carbs = T.habit_features(pc.ps, t, ctx.pop)
    pmax, cmax, n = max(pmax, float(prob.max())), max(cmax, float(carbs.max())), n + t.size
print(json.dumps({"train_patients": len(split["train"]), "train_anchors": n, "future_meal_prob_max": round(pmax, 4),
                  "future_carbs_per_bin_max_g": round(cmax, 2), "twin_base": ctx.cfg.twin_base}))
