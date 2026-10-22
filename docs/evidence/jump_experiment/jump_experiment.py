# Usage (repo root): RUN_DIR not needed. python docs/evidence/jump_experiment/jump_experiment.py OUT.json
"""Pre-registered isolated-step diagnosis and fixed R3 repair (see PREREGISTRATION.md). Train sample + validation; never the test split."""
import json, sys, time
from pathlib import Path
import numpy as np
sys.path.insert(0, "backend")
import serve_pr_tft as S, train_pr_tft as T

ctx = S.ServiceContext(Path("runs/pr_tft_ablation_arm_d"))
split = json.loads(Path("runs/pr_tft_ablation_arm_d/split.json").read_text())
Q10, Q90 = T.QUANTILES.index(0.10), T.QUANTILES.index(0.90)

def isolation(x):
    """Largest departure of an interior step from the mean of its two neighbours, and where it is."""
    d = np.abs(x[1:-1] - (x[:-2] + x[2:]) / 2)
    return float(d.max()), int(d.argmax()) + 1

def r3(q, twin):
    """R3: 3-point running median of the learned residual (end points unchanged); every quantile shifted equally."""
    r = q[:, T.MEDIAN_IDX] - twin
    rr = r.copy()
    rr[1:-1] = np.median(np.stack([r[:-2], r[1:-1], r[2:]]), axis=0)
    return q + (rr - r)[:, None]

def run(pids, per_patient, seed):
    rng = np.random.default_rng(seed)
    rows = []
    for pid in pids:
        pc = ctx.patients[ctx.by_pid[pid]]
        anchors = T.eligible_anchors(pc.ps, ctx.cfg)
        for t in rng.choice(anchors, size=min(per_patient, anchors.size), replace=False):
            t = int(t)
            base, _, _, fut, _ = ctx.rollouts(pc, t)
            q = ctx.run_model(pc, t, base, fut)["q"]
            y = pc.ps.cgm[t + 1: t + 1 + T.HORIZON]
            rows.append({"pid": pid, "t": t, "q": q, "twin": np.asarray(base, float), "y": y, "persist": float(pc.ps.cgm_ff[t])})
    return rows

def summarise(rows):
    out = {}
    variants = {"original": lambda r: r["q"], "R3": lambda r: r3(r["q"], r["twin"])}
    for name, fn in variants.items():
        iso, idx, cov_hit, cov_n = [], [], 0, 0
        err = {h: [] for h in (30, 60, 120)}
        for r in rows:
            q = fn(r); m = q[:, T.MEDIAN_IDX]
            s, k = isolation(m); iso.append(s); idx.append(k)
            ok = np.isfinite(r["y"])
            cov_hit += int(((r["y"] >= q[:, Q10]) & (r["y"] <= q[:, Q90]) & ok).sum()); cov_n += int(ok.sum())
            for h in err:
                k2 = h // T.STEP_MIN - 1
                if ok[k2]: err[h].append(m[k2] - r["y"][k2])
        iso = np.array(iso)
        out[name] = {"rmse": {f"{h}min": round(float(np.sqrt(np.mean(np.square(e)))), 3) for h, e in err.items()},
                     "share_isolated_step_gt_20": round(float((iso > 20).mean()), 3),
                     "share_isolated_step_gt_40": round(float((iso > 40).mean()), 3),
                     "p10_p90_coverage": round(cov_hit / cov_n, 4)}
    # baselines
    for name, fn in {"twin_alone": lambda r: r["twin"], "persistence": lambda r: np.full(T.HORIZON, r["persist"])}.items():
        err = {h: [] for h in (30, 60, 120)}
        for r in rows:
            for h in err:
                k2 = h // T.STEP_MIN - 1
                if np.isfinite(r["y"][k2]): err[h].append(fn(r)[k2] - r["y"][k2])
        out[name] = {"rmse": {f"{h}min": round(float(np.sqrt(np.mean(np.square(e)))), 3) for h, e in err.items()}}
    # diagnostics on the original forecasts that contain a > 20 mg/dL isolated step
    loc, at_step, at_nbr, sign = [], [], [], []
    for r in rows:
        m = r["q"][:, T.MEDIAN_IDX]
        s, k = isolation(m)
        if s <= 20 or not np.isfinite(r["y"][k]): continue
        loc.append(k)
        at_step.append(abs(m[k] - r["y"][k])); at_nbr.append(abs((m[k - 1] + m[k + 1]) / 2 - r["y"][k]))
        sign.append(float(np.sign(m[k] - (m[k - 1] + m[k + 1]) / 2)))
    loc = np.array(loc)
    out["jump_diagnostics"] = {
        "n_forecasts": len(rows), "n_with_step_gt_20": int(loc.size),
        "step_offset_min_histogram": {str((k + 1) * T.STEP_MIN): int((loc == k).sum()) for k in sorted(set(loc.tolist()))},
        "mean_abs_error_at_step_mg_dl": round(float(np.mean(at_step)), 2) if at_step else None,
        "mean_abs_error_if_neighbour_mean_mg_dl": round(float(np.mean(at_nbr)), 2) if at_nbr else None,
        "share_step_worse_than_neighbour_mean": round(float(np.mean(np.array(at_step) > np.array(at_nbr))), 3) if at_step else None,
        "share_upward_steps": round(float(np.mean(np.array(sign) > 0)), 3) if sign else None,
    }
    return out

t0 = time.time()
rng = np.random.default_rng(1)
train_pids = sorted(rng.choice(sorted(split["train"]), size=40, replace=False).tolist())
res = {"preregistration": "docs/evidence/jump_experiment/PREREGISTRATION.md", "checkpoint": "runs/pr_tft_ablation_arm_d",
       "train_sample": summarise(run(train_pids, 20, 1)), "validation": summarise(run(sorted(split["val"]), 20, 0))}
res["seconds"] = round(time.time() - t0, 1)
assert not (set(train_pids) | set(split["val"])) & set(split.get("test", [])), "test split must never be read"
print(json.dumps(res, indent=1)); json.dump(res, open(sys.argv[1], "w"), indent=1)
