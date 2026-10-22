"""Regenerate the README charts from committed aggregate result files (standard library only).

One chart per protocol; protocols are never combined, because their cohorts, denominators and selection rules differ.
Usage (from the repository root): python docs/assets/readme/make_charts.py
"""
import json
from pathlib import Path
from xml.sax.saxutils import escape

ROOT = Path(__file__).resolve().parents[3]
OUT = Path(__file__).resolve().parent / "charts"
INK, INK3, LINE, BG = "#16191c", "#5f656b", "#e2ddd1", "#ffffff"
COL = {"ours": "#0f6e74", "base": "#5f656b", "trend": "#b8379a", "over": "#8f5e0b"}


def load(p):
    return json.loads((ROOT / p).read_text())


def dot_chart(path, title, subtitle, rows, xmax, xlabel, source, fmt=lambda v: f"{v:.1f}%"):
    """rows: (label, value, lo|None, hi|None, colour key, right-hand note)."""
    W, left, right, top, rh = 900, 300, 210, 78, 38
    H = top + rh * len(rows) + 64
    x = lambda v: left + (W - left - right) * v / xmax
    s = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}" role="img" aria-label="{escape(title)}">',
         f'<rect width="{W}" height="{H}" fill="{BG}"/>',
         '<style>text{font-family:-apple-system,"Segoe UI",Helvetica,Arial,sans-serif}</style>',
         f'<text x="24" y="32" font-size="18" font-weight="600" fill="{INK}">{escape(title)}</text>',
         f'<text x="24" y="54" font-size="13" fill="{INK3}">{escape(subtitle)}</text>']
    for t in range(0, int(xmax) + 1, max(1, int(xmax) // 5)):
        s.append(f'<line x1="{x(t):.1f}" y1="{top - 8}" x2="{x(t):.1f}" y2="{top + rh * len(rows)}" stroke="{LINE}"/>')
        s.append(f'<text x="{x(t):.1f}" y="{top + rh * len(rows) + 18}" font-size="12" fill="{INK3}" text-anchor="middle">{t}</text>')
    s.append(f'<text x="{x(xmax / 2):.1f}" y="{top + rh * len(rows) + 38}" font-size="12" fill="{INK3}" text-anchor="middle">{escape(xlabel)}</text>')
    for i, (label, v, lo, hi, ck, note) in enumerate(rows):
        y = top + rh * i + rh / 2
        c = COL[ck]
        s.append(f'<text x="{left - 14}" y="{y + 4:.1f}" font-size="13" fill="{INK}" text-anchor="end">{escape(label)}</text>')
        if lo is not None:
            s.append(f'<line x1="{x(lo):.1f}" y1="{y:.1f}" x2="{x(hi):.1f}" y2="{y:.1f}" stroke="{c}" stroke-width="2.5"/>')
            for e in (lo, hi):
                s.append(f'<line x1="{x(e):.1f}" y1="{y - 6:.1f}" x2="{x(e):.1f}" y2="{y + 6:.1f}" stroke="{c}" stroke-width="2"/>')
        s.append(f'<circle cx="{x(v):.1f}" cy="{y:.1f}" r="6" fill="{c}"/>')
        s.append(f'<text x="{x(v) + 10:.1f}" y="{y - 8:.1f}" font-size="12" fill="{c}" font-weight="600">{escape(fmt(v))}</text>')
        s.append(f'<text x="{W - right + 14}" y="{y + 4:.1f}" font-size="12" fill="{COL["over"] if ck == "over" else INK3}">{escape(note)}</text>')
    s.append(f'<text x="24" y="{H - 10}" font-size="11" fill="{INK3}">Source: {escape(source)} · whiskers: 95% patient-bootstrap CI where computed</text>')
    s.append("</svg>")
    path.write_text("\n".join(s) + "\n")


def main():
    OUT.mkdir(exist_ok=True)
    r = load("docs/evidence/real_data/results.json")
    t, b = r["test_results"], r["baselines_test"]
    dot_chart(OUT / "locked_rmse60.svg", "Locked real-patient evaluation: 60-min forecast error",
              f"Held-out test patients with 5-min CGM: n = {r['cohort']['test_patients_pooled']} (161 nominal participants); lower is better",
              [("Masked physiological hybrid (ours)", t["rmse60"], *t["rmse60_ci95"], "ours", "locked, single run"),
               ("Reduced twin prior", b["reduced_twin"]["rmse60"], None, None, "base", "baseline"),
               ("Persistence", b["persistence"]["rmse60"], None, None, "base", "baseline"),
               ("Linear trend (30 min)", b["linear_trend"]["rmse60"], None, None, "trend", "baseline")],
              60, "RMSE at 60 min (mg/dL)", "docs/evidence/real_data/results.json", fmt=lambda v: f"{v:.2f}")

    h = load("docs/evidence/external_hall/results.json")
    pol = h["policies"]
    ci = lambda p: [100 * v for v in p["ci95"]["event_sensitivity_30m"]]
    fa = lambda p: f'{p["false_alerts_per_day"]:.2f} false alerts/day'
    tr = h["reference_linear_trend_at_1.0"]
    dot_chart(OUT / "external_hall_sens30.svg", "External check 1 (Hall 2018): not confirmed",
              f"{h['patients_with_decisions']} unused participants, {h['onsets']} spike onsets; preregistered at commit d1a2d887",
              [("Routine + per-patient rule (selected)", 100 * pol["P2"]["event_sensitivity_30m"], *ci(pol["P2"]), "ours", fa(pol["P2"])),
               ("Learned baseline (comparator)", 100 * pol["P0"]["event_sensitivity_30m"], *ci(pol["P0"]), "base", fa(pol["P0"])),
               ("Linear-trend reference", 100 * tr["event_sensitivity_30m"], None, None, "trend", f'{tr["false_alerts_per_day"]:.2f} false alerts/day')],
              50, "Spike onsets warned at least 30 min ahead (%)", "docs/evidence/external_hall/results.json")

    a = load("docs/evidence/external_v2/results.json")["primary_AZT1D"]
    p = a["policies"]
    row = lambda k, lab, ck: (lab, 100 * p[k]["event_sensitivity_30m"], *ci(p[k]), "over" if p[k]["false_alerts_per_day"] > 1 else ck,
                              fa(p[k]) + (" (over budget)" if p[k]["false_alerts_per_day"] > 1 else ""))
    dot_chart(OUT / "external_azt1d_sens30.svg", "External check 2 (AZT1D, type 1 diabetes): not met",
              f"{a['patients']} unused adults, {a['onsets']:,} spike onsets, {a['patient_days']:.0f} patient-days; preregistered at commit 3f1d7350",
              [row("P0", "Learned baseline (selected)", "ours"), row("T", "Trend alone", "trend"), row("C1", "Trend OR risk", "trend"),
               row("P1", "Routine risk", "base"), row("C2", "Risk-gated trend", "base")],
              50, "Spike onsets warned at least 30 min ahead (%)", "docs/evidence/external_v2/results.json")

    f = load("docs/evidence/fa_controller/results.json")["validation"]
    pv = load("docs/evidence/fa_controller/paired_validation.json")
    d = pv["diff_sens30"]
    dot_chart(OUT / "candidate_c2_validation.svg", "Exploratory candidate C2 on development validation (not confirmed)",
              f"{pv['patients']} validation patients (used in earlier work); paired difference {100 * d['point']:+.1f} points [{100 * d['ci95'][0]:.1f}, {100 * d['ci95'][1]:+.1f}]",
              [("Risk-gated trend C2 (candidate)", 100 * f["C2"]["event_sensitivity_30m"], *ci(f["C2"]), "ours", fa(f["C2"])),
               ("Learned baseline, threshold 0.2715", 100 * pv["p0"]["event_sensitivity_30m"], None, None, "base", f'{pv["p0"]["false_alerts_per_day"]:.2f} false alerts/day')],
              50, "Spike onsets warned at least 30 min ahead (%)", "docs/evidence/fa_controller/results.json, paired_validation.json")
    print("wrote", sorted(x.name for x in OUT.glob("*.svg")))


if __name__ == "__main__":
    main()
