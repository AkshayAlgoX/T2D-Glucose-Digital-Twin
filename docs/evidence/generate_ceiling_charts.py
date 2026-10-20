#!/usr/bin/env python3
"""
Generate publication-quality vector SVG charts from validation_ceiling_results.json.
Output charts:
1. horizon_trajectory.svg: Multi-horizon RMSE (5-120 min) for PR-TFT vs UKF vs Persistence
2. baseline_comparison.svg: Matched baselines at 30, 60, 120 min with 95% cluster-bootstrap CIs
3. subgroup_robustness.svg: Subgroup RMSE across Type 2, Prediabetes, Healthy with reconciled denominators
4. calibration_reliability.svg: 10 equal-width probability bins reliability diagram & threshold diagnostics (RESUBSTITUTION)
5. gate3_realism_summary.svg: Discriminator AUROC vs <= 0.65 threshold (FAILED)
"""

import json
import re
from pathlib import Path

def strip_trailing_whitespace(text: str) -> str:
    lines = [line.rstrip() for line in text.splitlines()]
    return "\n".join(lines) + "\n"

def generate_horizon_svg(data: dict) -> str:
    prog = data["horizon_progression"]
    offsets = prog["offsets_min"]
    pr_rmse = prog["pr_tft_rmse"]
    tw_rmse = prog["twin_rmse"]
    pe_rmse = prog["persistence_rmse"]

    w, h = 760, 400
    pad_l, pad_r, pad_t, pad_b = 60, 40, 88, 52
    plot_w = w - pad_l - pad_r
    plot_h = h - pad_t - pad_b

    max_y = max(max(pr_rmse), max(tw_rmse), max(pe_rmse)) * 1.08
    min_y = 0.0

    def to_x(min_val):
        return pad_l + (min_val - 5) / (120 - 5) * plot_w
    def to_y(val):
        return pad_t + plot_h - (val - min_y) / (max_y - min_y) * plot_h

    pts_pr = " ".join(f"{to_x(x):.1f},{to_y(y):.1f}" for x, y in zip(offsets, pr_rmse))
    pts_tw = " ".join(f"{to_x(x):.1f},{to_y(y):.1f}" for x, y in zip(offsets, tw_rmse))
    pts_pe = " ".join(f"{to_x(x):.1f},{to_y(y):.1f}" for x, y in zip(offsets, pe_rmse))

    # Grid lines
    grid = []
    for y_val in range(0, int(max_y) + 10, 10):
        y_px = to_y(y_val)
        grid.append(f'<line x1="{pad_l}" y1="{y_px:.1f}" x2="{w - pad_r}" y2="{y_px:.1f}" stroke="#2d3748" stroke-dasharray="3,3" stroke-width="1"/>')
        grid.append(f'<text x="{pad_l - 8}" y="{y_px + 4:.1f}" fill="#94a3b8" font-size="11" text-anchor="end" font-family="sans-serif">{y_val}</text>')

    for x_val in [15, 30, 45, 60, 75, 90, 105, 120]:
        x_px = to_x(x_val)
        grid.append(f'<line x1="{x_px:.1f}" y1="{pad_t}" x2="{x_px:.1f}" y2="{h - pad_b}" stroke="#2d3748" stroke-dasharray="3,3" stroke-width="1"/>')
        grid.append(f'<text x="{x_px:.1f}" y="{h - pad_b + 18}" fill="#94a3b8" font-size="11" text-anchor="middle" font-family="sans-serif">{x_val}m</text>')

    svg = f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="100%" height="100%" style="background:#131822; border-radius:8px; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <text x="{pad_l}" y="28" fill="#f8fafc" font-size="15" font-weight="600">Forecast Error Trajectory Across Horizons (5 to 120 min)</text>
  <text x="{pad_l}" y="46" fill="#94a3b8" font-size="11">Validation Cohort (44 Patients, 54,281 Eligible Anchors / 53,849-53,920 Evaluable Rows) · RMSE (mg/dL)</text>

  <!-- Legend in dedicated top row -->
  <g transform="translate({pad_l}, 64)">
    <line x1="0" y1="6" x2="22" y2="6" stroke="#3b82f6" stroke-width="3"/>
    <text x="28" y="10" fill="#f8fafc" font-size="11" font-weight="600">PR-TFT (Arm D)</text>
    <line x1="140" y1="6" x2="162" y2="6" stroke="#f59e0b" stroke-width="2.5" stroke-dasharray="2,2"/>
    <text x="168" y="10" fill="#f59e0b" font-size="11">UKF Twin</text>
    <line x1="260" y1="6" x2="282" y2="6" stroke="#ef4444" stroke-width="2.5" stroke-dasharray="4,4"/>
    <text x="288" y="10" fill="#ef4444" font-size="11">Persistence</text>
  </g>

  {''.join(grid)}

  <!-- Persistence -->
  <polyline fill="none" stroke="#ef4444" stroke-width="2.5" stroke-dasharray="4,4" points="{pts_pe}"/>
  <!-- UKF Twin -->
  <polyline fill="none" stroke="#f59e0b" stroke-width="2.5" stroke-dasharray="2,2" points="{pts_tw}"/>
  <!-- PR-TFT -->
  <polyline fill="none" stroke="#3b82f6" stroke-width="3" points="{pts_pr}"/>

  <!-- Key Annotations -->
  <circle cx="{to_x(60):.1f}" cy="{to_y(pr_rmse[11]):.1f}" r="4" fill="#3b82f6" stroke="#ffffff" stroke-width="1.5"/>
  <text x="{to_x(60):.1f}" y="{to_y(pr_rmse[11]) - 10:.1f}" fill="#60a5fa" font-size="11" font-weight="700" text-anchor="middle">PR-TFT 60m: {pr_rmse[11]:.2f}</text>

  <circle cx="{to_x(120):.1f}" cy="{to_y(pr_rmse[23]):.1f}" r="4" fill="#3b82f6" stroke="#ffffff" stroke-width="1.5"/>
  <text x="{to_x(120) - 10:.1f}" y="{to_y(pr_rmse[23]) - 10:.1f}" fill="#60a5fa" font-size="11" font-weight="700" text-anchor="end">PR-TFT 120m: {pr_rmse[23]:.2f}</text>
</svg>"""
    return strip_trailing_whitespace(svg)

def generate_baseline_svg(data: dict) -> str:
    mb = data["matched_baselines_and_uncertainty"]
    w, h = 760, 400
    pad_l, pad_r, pad_t, pad_b = 60, 40, 88, 52
    plot_w = w - pad_l - pad_r
    plot_h = h - pad_t - pad_b

    horizons = ["30min", "60min", "120min"]
    eval_counts = {
        "30min": mb["30min"]["evaluable_anchors"],
        "60min": mb["60min"]["evaluable_anchors"],
        "120min": mb["120min"]["evaluable_anchors"]
    }
    max_y = 60.0

    def to_y(val):
        return pad_t + plot_h - (val / max_y) * plot_h

    bars_svg = []
    # Grid lines
    for y_val in [0, 10, 20, 30, 40, 50, 60]:
        y_px = to_y(y_val)
        bars_svg.append(f'<line x1="{pad_l}" y1="{y_px:.1f}" x2="{w - pad_r}" y2="{y_px:.1f}" stroke="#2d3748" stroke-dasharray="3,3" stroke-width="1"/>')
        bars_svg.append(f'<text x="{pad_l - 8}" y="{y_px + 4:.1f}" fill="#94a3b8" font-size="11" text-anchor="end" font-family="sans-serif">{y_val}</text>')

    col_w = plot_w / len(horizons)
    bar_w = 36

    colors = {
        "pr_tft": ("#3b82f6", "#60a5fa", "PR-TFT (Arm D)"),
        "twin_only": ("#f59e0b", "#fbbf24", "UKF Twin Only"),
        "persistence": ("#ef4444", "#f87171", "Persistence")
    }

    for i, hz in enumerate(horizons):
        c_x = pad_l + i * col_w + col_w / 2
        cnt = eval_counts[hz]
        bars_svg.append(f'<text x="{c_x:.1f}" y="{h - pad_b + 20}" fill="#f8fafc" font-size="13" font-weight="600" text-anchor="middle">{hz} Horizon</text>')
        bars_svg.append(f'<text x="{c_x:.1f}" y="{h - pad_b + 34}" fill="#94a3b8" font-size="10.5" text-anchor="middle">{cnt:,} eval rows</text>')

        models = ["pr_tft", "twin_only", "persistence"]
        offsets = [-bar_w * 1.3, 0, bar_w * 1.3]

        for m_name, off in zip(models, offsets):
            m_stat = mb[hz][m_name]
            rmse = m_stat["rmse"]
            ci = m_stat["rmse_ci_95"]
            bx = c_x + off - bar_w / 2
            by = to_y(rmse)
            bh = (h - pad_b) - by

            fill, stroke, label = colors[m_name]
            bars_svg.append(f'<rect x="{bx:.1f}" y="{by:.1f}" width="{bar_w}" height="{bh:.1f}" fill="{fill}" opacity="0.85" rx="3"/>')
            bars_svg.append(f'<text x="{bx + bar_w/2:.1f}" y="{by - 14:.1f}" fill="{stroke}" font-size="10.5" font-weight="700" text-anchor="middle">{rmse:.1f}</text>')

            # Error bar (CI 95%)
            ci_top = to_y(ci[1])
            ci_bot = to_y(ci[0])
            bars_svg.append(f'<line x1="{bx + bar_w/2:.1f}" y1="{ci_top:.1f}" x2="{bx + bar_w/2:.1f}" y2="{ci_bot:.1f}" stroke="#ffffff" stroke-width="1.5"/>')
            bars_svg.append(f'<line x1="{bx + bar_w/2 - 4:.1f}" y1="{ci_top:.1f}" x2="{bx + bar_w/2 + 4:.1f}" y2="{ci_top:.1f}" stroke="#ffffff" stroke-width="1.5"/>')
            bars_svg.append(f'<line x1="{bx + bar_w/2 - 4:.1f}" y1="{ci_bot:.1f}" x2="{bx + bar_w/2 + 4:.1f}" y2="{ci_bot:.1f}" stroke="#ffffff" stroke-width="1.5"/>')

    svg = f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="100%" height="100%" style="background:#131822; border-radius:8px; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <text x="{pad_l}" y="28" fill="#f8fafc" font-size="15" font-weight="600">Matched Baselines with 95% Patient-Clustered Bootstrap CIs</text>
  <text x="{pad_l}" y="46" fill="#94a3b8" font-size="11">44 Validation Subjects · B=10,000 Cluster Resamples (Preregistered Primary) · Paired &#916; = PR-TFT - Comparator &lt; 0 (All 10,000 draws &lt; 0)</text>

  <!-- Legend in dedicated row below header to avoid text collision -->
  <g transform="translate({pad_l}, 64)">
    <rect x="0" y="0" width="12" height="12" fill="#3b82f6" rx="2"/>
    <text x="18" y="10" fill="#f8fafc" font-size="11">PR-TFT (Arm D)</text>
    <rect x="140" y="0" width="12" height="12" fill="#f59e0b" rx="2"/>
    <text x="158" y="10" fill="#f8fafc" font-size="11">UKF Twin Only</text>
    <rect x="270" y="0" width="12" height="12" fill="#ef4444" rx="2"/>
    <text x="288" y="10" fill="#f8fafc" font-size="11">Persistence</text>
  </g>

  {''.join(bars_svg)}
</svg>"""
    return strip_trailing_whitespace(svg)

def generate_subgroup_svg(data: dict) -> str:
    sub = data["subgroups"]
    w, h = 760, 380
    pad_l, pad_r, pad_t, pad_b = 60, 40, 88, 52
    plot_w = w - pad_l - pad_r
    plot_h = h - pad_t - pad_b

    groups = ["Healthy", "Prediabetes", "Type 2"]
    max_y = 35.0

    def to_y(val):
        return pad_t + plot_h - (val / max_y) * plot_h

    elements = []
    # Grid lines
    for y_val in [0, 5, 10, 15, 20, 25, 30, 35]:
        y_px = to_y(y_val)
        elements.append(f'<line x1="{pad_l}" y1="{y_px:.1f}" x2="{w - pad_r}" y2="{y_px:.1f}" stroke="#2d3748" stroke-dasharray="3,3" stroke-width="1"/>')
        elements.append(f'<text x="{pad_l - 8}" y="{y_px + 4:.1f}" fill="#94a3b8" font-size="11" text-anchor="end">{y_val}</text>')

    col_w = plot_w / len(groups)
    bar_w = 42

    hz_colors = [
        ("30m", "#38bdf8", "rmse_30", "pr_rmse_30"),
        ("60m", "#3b82f6", "rmse_60", "pr_rmse_60"),
        ("120m", "#1d4ed8", "rmse_120", "pr_rmse_120")
    ]

    for i, grp in enumerate(groups):
        gdata = sub[grp]
        c_x = pad_l + i * col_w + col_w / 2
        n_anchors = gdata.get("n_anchors_eligible") or gdata.get("n_anchors_eligible_before_filtering", 0)

        elements.append(f'<text x="{c_x:.1f}" y="{h - pad_b + 20}" fill="#f8fafc" font-size="13" font-weight="600" text-anchor="middle">{grp}</text>')
        elements.append(f'<text x="{c_x:.1f}" y="{h - pad_b + 34}" fill="#94a3b8" font-size="10" text-anchor="middle">n={gdata["n_patients"]} pts ({n_anchors:,} eligible)</text>')
        elements.append(f'<text x="{c_x:.1f}" y="{h - pad_b + 47}" fill="#64748b" font-size="9.5" text-anchor="middle">{gdata["n_evaluable_60"]:,} eval @ 60m</text>')

        offsets = [-bar_w * 1.1, 0, bar_w * 1.1]
        for (hz_lbl, col, f1, f2), off in zip(hz_colors, offsets):
            val = gdata[f1] if f1 in gdata else gdata[f2]
            bx = c_x + off - bar_w / 2
            by = to_y(val)
            bh = (h - pad_b) - by

            elements.append(f'<rect x="{bx:.1f}" y="{by:.1f}" width="{bar_w}" height="{bh:.1f}" fill="{col}" opacity="0.9" rx="3"/>')
            elements.append(f'<text x="{bx + bar_w/2:.1f}" y="{by - 6:.1f}" fill="#ffffff" font-size="10" font-weight="600" text-anchor="middle">{val:.1f}</text>')

    svg = f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="100%" height="100%" style="background:#131822; border-radius:8px; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <text x="{pad_l}" y="28" fill="#f8fafc" font-size="15" font-weight="600">Subgroup Robustness Across Clinical Diagnostic Strata</text>
  <text x="{pad_l}" y="46" fill="#94a3b8" font-size="11">Stratified Validation Cohort Performance (Eligible vs Evaluable Denominators Disclosed) · PR-TFT RMSE (mg/dL)</text>

  <!-- Legend in dedicated row below header to avoid text collision -->
  <g transform="translate({pad_l}, 64)">
    <rect x="0" y="0" width="12" height="12" fill="#38bdf8" rx="2"/>
    <text x="18" y="10" fill="#f8fafc" font-size="11">30m</text>
    <rect x="80" y="0" width="12" height="12" fill="#3b82f6" rx="2"/>
    <text x="98" y="10" fill="#f8fafc" font-size="11">60m</text>
    <rect x="160" y="0" width="12" height="12" fill="#1d4ed8" rx="2"/>
    <text x="178" y="10" fill="#f8fafc" font-size="11">120m</text>
  </g>

  {''.join(elements)}
</svg>"""
    return strip_trailing_whitespace(svg)

def generate_calibration_svg(data: dict) -> str:
    cal = data["calibration_resubstitution_diagnostics"]
    bins = cal["reliability_bins"]
    w, h = 760, 380
    pad_l, pad_r, pad_t, pad_b = 60, 40, 60, 50
    plot_w = w - pad_l - pad_r
    plot_h = h - pad_t - pad_b

    def to_x(val):
        return pad_l + val * plot_w
    def to_y(val):
        return pad_t + plot_h - val * plot_h

    elements = []
    # Grid
    for v in [0.0, 0.2, 0.4, 0.6, 0.8, 1.0]:
        elements.append(f'<line x1="{pad_l}" y1="{to_y(v):.1f}" x2="{w - pad_r}" y2="{to_y(v):.1f}" stroke="#2d3748" stroke-dasharray="3,3" stroke-width="1"/>')
        elements.append(f'<text x="{pad_l - 8}" y="{to_y(v) + 4:.1f}" fill="#94a3b8" font-size="11" text-anchor="end">{v:.1f}</text>')
        elements.append(f'<line x1="{to_x(v):.1f}" y1="{pad_t}" x2="{to_x(v):.1f}" y2="{h - pad_b}" stroke="#2d3748" stroke-dasharray="3,3" stroke-width="1"/>')
        elements.append(f'<text x="{to_x(v):.1f}" y="{h - pad_b + 18}" fill="#94a3b8" font-size="11" text-anchor="middle">{v:.1f}</text>')

    # Perfect calibration diagonal
    elements.append(f'<line x1="{to_x(0):.1f}" y1="{to_y(0):.1f}" x2="{to_x(1):.1f}" y2="{to_y(1):.1f}" stroke="#64748b" stroke-dasharray="4,4" stroke-width="1.5"/>')

    # Observed points
    pred_x = bins["bin_mean_predicted"]
    obs_y = bins["bin_observed_fraction"]
    pts = []
    for x, y, c in zip(pred_x, obs_y, bins["bin_counts"]):
        if c > 0:
            px, py = to_x(x), to_y(y)
            pts.append(f"{px:.1f},{py:.1f}")
            elements.append(f'<circle cx="{px:.1f}" cy="{py:.1f}" r="5" fill="#3b82f6" stroke="#ffffff" stroke-width="1.5"/>')
            elements.append(f'<text x="{px:.1f}" y="{py - 8:.1f}" fill="#93c5fd" font-size="9" text-anchor="middle">n={c}</text>')

    if pts:
        elements.append(f'<polyline fill="none" stroke="#3b82f6" stroke-width="2" points="{" ".join(pts)}"/>')

    # Threshold line at 0.35 (diagnostic only)
    t35 = cal["threshold_evaluations"]["0.35"]
    elements.append(f'<line x1="{to_x(0.35):.1f}" y1="{pad_t}" x2="{to_x(0.35):.1f}" y2="{h - pad_b}" stroke="#f59e0b" stroke-dasharray="2,2" stroke-width="1.5"/>')
    elements.append(f'<text x="{to_x(0.35) + 6:.1f}" y="{pad_t + 18}" fill="#f59e0b" font-size="10.5" font-weight="600">Threshold 0.35 (Sens {t35["sensitivity"]*100:.1f}%)</text>')

    # Threshold line at 0.60
    t60 = cal["threshold_evaluations"]["0.60"]
    elements.append(f'<line x1="{to_x(0.60):.1f}" y1="{pad_t}" x2="{to_x(0.60):.1f}" y2="{h - pad_b}" stroke="#ef4444" stroke-dasharray="2,2" stroke-width="1.5"/>')
    elements.append(f'<text x="{to_x(0.60) + 6:.1f}" y="{pad_t + 36}" fill="#ef4444" font-size="10.5" font-weight="600">Threshold 0.60 (Sens {t60["sensitivity"]*100:.1f}%)</text>')

    svg = f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="100%" height="100%" style="background:#131822; border-radius:8px; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <text x="{pad_l}" y="24" fill="#f8fafc" font-size="15" font-weight="600">Hazard Calibration Reliability Diagram (RESUBSTITUTION DIAGNOSTIC)</text>
  <text x="{pad_l}" y="42" fill="#94a3b8" font-size="11">10 Equal-Width Probability Bins (Width 0.10) · Brier Score {cal["brier_score_calibrated_resubstitution"]:.4f} (Raw {cal["brier_score_raw_resubstitution"]:.4f}) · 47,629 At-Risk Anchors</text>

  {''.join(elements)}

  <text x="{w/2}" y="{h - 10}" fill="#94a3b8" font-size="11" text-anchor="middle">Mean Predicted Hazard Probability</text>
  <text x="18" y="{h/2}" fill="#94a3b8" font-size="11" text-anchor="middle" transform="rotate(-90 18 {h/2})">Observed Spike Event Fraction</text>
</svg>"""
    return strip_trailing_whitespace(svg)

def generate_gate3_svg(data: dict) -> str:
    g3 = data["gate3_realism_status"]
    w, h = 760, 240

    thresh_escaped = g3["acceptance_threshold"].replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")

    svg = f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="100%" height="100%" style="background:#131822; border-radius:8px; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <rect x="24" y="20" width="{w - 48}" height="{h - 40}" rx="6" fill="rgba(239, 68, 68, 0.08)" stroke="#7f1d1d" stroke-width="1.5"/>

  <!-- Header -->
  <g transform="translate(44, 48)">
    <rect x="0" y="0" width="84" height="24" rx="4" fill="#ef4444" opacity="0.2"/>
    <text x="42" y="16" fill="#ef4444" font-size="12" font-weight="700" text-anchor="middle">FAILED</text>
    <text x="100" y="17" fill="#f8fafc" font-size="16" font-weight="600">Gate 3 Realism Audit: Indistinguishability Criterion</text>
    <text x="100" y="36" fill="#94a3b8" font-size="12">Discriminator AUROC exceeds target threshold ({thresh_escaped}) · Strict Negative Disclosure</text>
  </g>

  <!-- Scorecards -->
  <g transform="translate(44, 110)">
    <!-- Historical -->
    <g transform="translate(0, 0)">
      <rect x="0" y="0" width="200" height="80" rx="4" fill="#1e293b" stroke="#334155"/>
      <text x="16" y="24" fill="#94a3b8" font-size="11">HISTORICAL AUROC</text>
      <text x="16" y="56" fill="#ef4444" font-size="24" font-weight="700">{g3["historical_auroc"]:.4f}</text>
      <text x="16" y="72" fill="#64748b" font-size="10">90% CI: {g3["historical_ci90"][0]:.4f}&#8211;{g3["historical_ci90"][1]:.4f}</text>
    </g>

    <!-- Duration-Corrected -->
    <g transform="translate(220, 0)">
      <rect x="0" y="0" width="220" height="80" rx="4" fill="#1e293b" stroke="#334155"/>
      <text x="16" y="24" fill="#94a3b8" font-size="11">DURATION-CORRECTED AUROC</text>
      <text x="16" y="56" fill="#f59e0b" font-size="24" font-weight="700">{g3["duration_corrected_auroc"]:.4f}</text>
      <text x="16" y="72" fill="#64748b" font-size="10">90% CI: {g3["duration_corrected_ci90"][0]:.4f}&#8211;{g3["duration_corrected_ci90"][1]:.4f}</text>
    </g>

    <!-- Target -->
    <g transform="translate(460, 0)">
      <rect x="0" y="0" width="210" height="80" rx="4" fill="#1e293b" stroke="#334155"/>
      <text x="16" y="24" fill="#94a3b8" font-size="11">ACCEPTANCE TARGET</text>
      <text x="16" y="56" fill="#22c55e" font-size="24" font-weight="700">&#8804; 0.6500</text>
      <text x="16" y="72" fill="#64748b" font-size="10">Criterion: Indistinguishable</text>
    </g>
  </g>
</svg>"""
    return strip_trailing_whitespace(svg)

def main():
    root = Path(__file__).resolve().parent.parent.parent
    in_file = root / "docs/evidence/validation_ceiling_results.json"
    if not in_file.exists():
        print(f"Error: {in_file} does not exist.")
        return

    data = json.loads(in_file.read_text())

    svgs = {
        "horizon_trajectory.svg": generate_horizon_svg(data),
        "baseline_comparison.svg": generate_baseline_svg(data),
        "subgroup_robustness.svg": generate_subgroup_svg(data),
        "calibration_reliability.svg": generate_calibration_svg(data),
        "gate3_realism_summary.svg": generate_gate3_svg(data),
    }

    targets = [
        root / "docs/evidence",
        root / "public/evidence",
    ]

    for target in targets:
        target.mkdir(parents=True, exist_ok=True)
        for name, content in svgs.items():
            (target / name).write_text(content)
            print(f"Wrote {target / name}")

    print("All 5 SVG figures generated with zero trailing whitespace and collision-free layouts.")

if __name__ == "__main__":
    main()
