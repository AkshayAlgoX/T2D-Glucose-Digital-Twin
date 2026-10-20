# Usage (repo root): python docs/evidence/model_audit/scenario_variants.py
"""Diagnostic only: which future input drives the isolated residual step? (No model or service change.)"""
import sys, uuid, datetime as dt
from pathlib import Path
import numpy as np
sys.path.insert(0, "backend")
import serve_pr_tft as S, train_pr_tft as T
ctx = S.ServiceContext(Path("runs/pr_tft_ablation_arm_d"))
pc = ctx.patient(uuid.uuid5(S.SUBJECT_NAMESPACE, "P0017"))
def resid(t, row=None, carbs=60.0, prob_override=None):
    extra = np.zeros((1, T.HORIZON))
    if row is not None: extra[0, row] = carbs
    base, _, _, fut, _ = ctx.rollouts(pc, t, extra if row is not None else None)
    if prob_override is not None and row is not None: fut[row, 2] = prob_override
    q = ctx.run_model(pc, t, base, fut)["q"][:, T.MEDIAN_IDX]
    r = q - base; k = int(np.argmax(np.abs(r))); return (k + 1) * 5, round(float(r[k]), 1)
for label, anchor in [("05:55 29 Sep", dt.datetime(2026, 9, 29, 5, 55)), ("07:30 05 Oct", dt.datetime(2026, 10, 5, 7, 30)), ("13:00 02 Oct", dt.datetime(2026, 10, 2, 13, 0))]:
    t = ctx.anchor_index(pc, anchor.replace(tzinfo=dt.timezone.utc))
    print(f"\n== anchor {label}: baseline max |residual| at +min, value: {resid(t)}")
    for row in (0, 5, 11, 17):
        print(f"  60 g @ +{(row+1)*5:3d}: prob=1 (as served) {resid(t, row)} | prob kept at habit {resid(t, row, prob_override=float(T.habit_features(pc.ps, np.array([t]), ctx.pop)[0][0, row]))} | 20 g prob=1 {resid(t, row, 20.0)}")
