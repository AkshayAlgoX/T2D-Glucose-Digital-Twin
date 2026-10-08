import sys
from pathlib import Path
import numpy as np
from typing import Any
from dataclasses import dataclass

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "backend"))
import evaluate_run as E
import train_pr_tft as T
from experiments.baselines.point import linear_trend

@dataclass
class EvalTrace:
    inputs: Any
    decisions: Any
    split_test: Any
    agg: Any
    p_cal: Any
    q_conf: Any
    patient_forecast_stats: Any
    ev: Any
    populations: Any

def evaluate_locked_core(test_series: list[T.PatientSeries], twin: T.TwinPrior, module: T.PRTFTModule, 
                         cfg: T.TrainConfig, norm: T.Normalizer, pop: tuple[np.ndarray, float], 
                         calib: T.Calibrators, rule: dict[str, Any], trace: bool = False,
                         cooldown: int = 24, threshold_op=lambda x, y: x >= y,
                         patient_order: list[int] = None) -> tuple[dict[str, Any], Any]:
    
    # Optional patient ordering for negative control
    if patient_order is not None:
        test_series = [test_series[i] for i in patient_order]
        
    n_pat = len(test_series)
    decisions = {}
    for ps in test_series:
        t_ok, first, last = E.causal_decision_mask(ps, cfg)
        decisions[ps.pid] = (t_ok, first, last)
        
    split_test = T.build_split(test_series, {ps.pid: decisions[ps.pid][0] for ps in test_series}, twin, norm, pop, cfg)
    agg = E._predict(module, split_test, cfg)
    a_t = split_test.anchor_t.numpy()
    a_p = split_test.anchor_patient.numpy()
    p_cal = calib.apply_hazard(agg["p_cum"])
    
    grid = np.zeros(a_t.size, dtype=bool)
    for i, ps in enumerate(test_series):
        sel = a_p == i
        grid[sel] = np.isin(a_t[sel], T.eligible_anchors(ps, cfg))
    fc = {k: v[grid] for k, v in agg.items()}
    q_conf = calib.apply_interval(fc["q"])
    stats = E.patient_stats(fc, q_conf, n_pat)
    
    thresholds = [float(x) for x in rule["alerting"]["thresholds"]]
    prim = f"pr_tft@{rule['alerting']['primary_threshold']:g}"
    
    ev: dict[str, list[dict[str, Any]]] = {f"pr_tft@{th:g}": [] for th in thresholds} | {"twin_only": []}
    hist_len = T.RISE_STEPS + 1
    
    # Save detailed triggers for trace
    detailed_ev = {}
    
    for i, ps in enumerate(test_series):
        _, first, last = decisions[ps.pid]
        sel = np.flatnonzero(a_p == i)
        ts = a_t[sel]
        at_risk = np.zeros(ps.n, dtype=bool)
        at_risk[ts] = ps.armed[ts]
        
        detailed_ev[ps.pid] = {}
        for th in thresholds:
            trig = np.zeros(ps.n, dtype=bool)
            trig[ts] = threshold_op(p_cal[sel], th)
            raised = E.raise_alerts(trig, at_risk, cooldown=cooldown)
            counts = E.event_counts(raised, ps.onset, first, last)
            ev[f"pr_tft@{th:g}"].append(counts)
            
            detailed_ev[ps.pid][f"pr_tft@{th:g}"] = {
                "at_risk": at_risk.copy(),
                "trigger": trig.copy(),
                "raised": raised.copy(),
                "counts": counts
            }
            
        trig_twin = np.zeros(ps.n, dtype=bool)
        for j, t in zip(sel, ts):
            if at_risk[t] and agg["twin"][j].max() >= T.SPIKE_LEVEL:
                trig_twin[t] = E.forecast_meets_spike_rule(ps.cgm[t - hist_len + 1:t + 1], agg["twin"][j])
                
        raised_twin = E.raise_alerts(trig_twin, at_risk, cooldown=cooldown)
        counts_twin = E.event_counts(raised_twin, ps.onset, first, last)
        ev["twin_only"].append(counts_twin)
        
        detailed_ev[ps.pid]["twin_only"] = {
            "at_risk": at_risk.copy(),
            "trigger": trig_twin.copy(),
            "raised": raised_twin.copy(),
            "counts": counts_twin
        }
        
    for m, rows in ev.items():
        target = stats.setdefault(m, {})
        for key in ("monitored_onsets", "detected_onsets", "alerts_raised", "true_alerts", "false_alerts", "patient_days"):
            target[key] = np.array([r[key] for r in rows], dtype=float)
        target["lead_times_min"] = [r["lead_times_min"] for r in rows]
        
    unc = rule["uncertainty"]
    groups_all = np.array([ps.group for ps in test_series])
    alert_keys = ("event_sensitivity", "alert_precision", "alerts_per_patient_day", "false_alerts_per_patient_day")
    populations = {}
    max_cal = float(max(calib.iso_y)) if calib.iso_y else 0.0
    reachable = {f"{th:g}": bool(max_cal >= th) for th in rule["alerting"]["thresholds"]}
    
    trace_pops = {}
    
    for pop_name, members in E.POPULATIONS.items():
        idx = np.flatnonzero(np.isin(groups_all, members))
        if idx.size == 0:
            continue
        sub = {m: {k: (v[idx] if isinstance(v, np.ndarray) else [v[i] for i in idx]) for k, v in s.items()}
               for m, s in stats.items()}
        w = E.bootstrap_weights(groups_all[idx].tolist(), unc["resamples"], unc["seed"])
        ones = np.ones((1, idx.size))
        point = {m: E.metric_draws(s, ones) for m, s in sub.items()}
        draws = {m: E.metric_draws(s, w) for m, s in sub.items()}
        models: dict[str, Any] = {}
        for m in sub:
            if m.startswith("pr_tft@") and not reachable[m.split("@")[1]]:
                models[m] = {"unreachable": True}
            else:
                models[m] = {k: E.summarize(point[m][k][0], draws[m][k], unc["ci"]) for k in draws[m]}

        def diff(a: str, b: str, k: str) -> dict[str, Any]:
            return E.summarize(point[a][k][0] - point[b][k][0], draws[a][k] - draws[b][k], unc["ci"])

        none = {"estimate": None, "ci_low": None, "ci_high": None}
        vs_twin = {k: diff("pr_tft", "twin_only", k) for k in ("rmse_60", "rmse_120", "mae_60", "mae_120")}
        vs_twin.update({k: diff(prim, "twin_only", k) if reachable[prim.split("@")[1]] else none for k in alert_keys})
        vs_pers = {k: diff("pr_tft", "persistence", k) for k in ("rmse_60", "rmse_120", "mae_60", "mae_120")}
        
        populations[pop_name] = {
            "patients": int(idx.size), "groups": {g: int((groups_all[idx] == g).sum()) for g in members},
            "monitored_onsets": int(sub["twin_only"]["monitored_onsets"].sum()),
            "models": models,
            "paired_differences": {
                "pr_tft_minus_twin_only": vs_twin, 
                "pr_tft_minus_persistence": vs_pers
            }
        }
        
        trace_pops[pop_name] = {
            "weights": w,
            "sub": sub,
            "point": point,
            "draws": draws
        }

    out = {
        "populations": populations,
        "operating_points": {
            "max_calibrated_probability": max_cal, 
            "reachable": reachable, 
            "primary_threshold": rule["alerting"]["primary_threshold"]
        }
    }
    
    if trace:
        eval_trace = EvalTrace(
            inputs=test_series,
            decisions=decisions,
            split_test=split_test,
            agg=agg,
            p_cal=p_cal,
            q_conf=q_conf,
            patient_forecast_stats=stats,
            ev=detailed_ev,
            populations=trace_pops
        )
        return out, eval_trace
    
    return out, None
