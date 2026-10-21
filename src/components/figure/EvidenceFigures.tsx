import React from 'react';
import * as d3Scale from 'd3-scale';
import { GainBar } from './marks';
import type { LandingEvidence } from '@/lib/landing';

/** Subgroup errors in the product grammar: one gain bar per subgroup and horizon (hybrid, twin, persistence). */
export function SubgroupGains({ rows }: { rows: NonNullable<LandingEvidence['subgroups']> }) {
  return (
    <figure className="subgroup-gains" aria-label="Error the learned adjustment removes, by subgroup and horizon">
      <table className="subgroup-gain-table">
        <caption className="sr-only">RMSE in mg/dL by subgroup and horizon for the hybrid, the physiology twin alone and persistence</caption>
        <thead><tr><th scope="col">Subgroup</th><th scope="col">60 min</th><th scope="col">120 min</th></tr></thead>
        <tbody>{rows.map(r => <tr key={r.name} className={r.name === 'Type 2' ? 'is-focus' : undefined}>
          <th scope="row">{r.name}<small>{r.n} patients{r.name === 'Type 2' ? ' · exploratory' : ''}</small></th>
          <td><GainBar id={`sg-${r.name.replace(/\s/g, '')}-60`} hybrid={r.h60[0]} twin={r.h60[1]} persistence={r.h60[2]} /></td>
          <td><GainBar id={`sg-${r.name.replace(/\s/g, '')}-120`} hybrid={r.h120[0]} twin={r.h120[1]} persistence={r.h120[2]} /></td>
        </tr>)}</tbody>
      </table>
      <figcaption className="fig-caption">RMSE in mg/dL. In each bar the hatched gap is the error the learned adjustment removes from the physiology twin; the grey tick is persistence. No interval on subgroup differences; 10–19 patients per group.</figcaption>
    </figure>
  );
}

/** Reliability of the calibrated onset classifier. Fitted and evaluated on the same split: agreement is expected by construction. */
export function ReliabilityFigure({ data }: { data: NonNullable<LandingEvidence['reliability']> }) {
  const W = 360, H = 300, M = { l: 44, r: 12, t: 12, b: 40 };
  const x = d3Scale.scaleLinear().domain([0, 1]).range([M.l, W - M.r]);
  const y = d3Scale.scaleLinear().domain([0, 1]).range([H - M.b, M.t]);
  const r = d3Scale.scaleSqrt().domain([0, Math.max(...data.counts)]).range([2.5, 9]);
  const ticks = [0, 0.25, 0.5, 0.75, 1];
  return (
    <figure className="reliability-figure">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Reliability of the onset classifier in ${data.predicted.length} probability bins: observed onset fraction against mean predicted probability. The points lie on the diagonal because the calibrator was fitted and evaluated on the same validation split (resubstitution); this is not evidence of calibration on new data.`}>
        {ticks.map(t => <g key={t}><line x1={M.l} x2={W - M.r} y1={y(t)} y2={y(t)} className="fig-grid" /><text x={M.l - 8} y={y(t) + 4} textAnchor="end" className="fig-axis">{t}</text><text x={x(t)} y={H - M.b + 16} textAnchor="middle" className="fig-axis">{t}</text></g>)}
        <line x1={x(0)} y1={y(0)} x2={x(1)} y2={y(1)} className="rel-diagonal" />
        {data.predicted.map((p, i) => <circle key={i} cx={x(p)} cy={y(data.observed[i])} r={r(data.counts[i])} className="rel-dot"><title>{`Predicted ${p.toFixed(3)}, observed ${data.observed[i].toFixed(3)}, ${data.counts[i].toLocaleString()} anchors`}</title></circle>)}
        <text x={(M.l + W - M.r) / 2} y={H - 6} textAnchor="middle" className="fig-axis">mean predicted probability</text>
        <text x={12} y={(M.t + H - M.b) / 2} transform={`rotate(-90 12 ${(M.t + H - M.b) / 2})`} textAnchor="middle" className="fig-axis">observed onset fraction</text>
      </svg>
      <figcaption className="fig-caption"><b>Resubstitution, not validation.</b> The isotonic calibrator was fitted on these same anchors, so the dots sit on the diagonal by construction. Dot area shows how many anchors fall in each bin.</figcaption>
    </figure>
  );
}

/** Gate 3: can a classifier tell our synthetic traces from a mock-real generator's? AUROC with 90% intervals against the ≤ 0.65 target. */
export function Gate3Figure({ historical, ci }: { historical: number; ci: NonNullable<LandingEvidence['gate3ci']> }) {
  const W = 520, H = 120, M = { l: 150, r: 20, t: 18, b: 30 };
  const x = d3Scale.scaleLinear().domain([0.5, 1]).range([M.l, W - M.r]);
  const rows: Array<[string, number, [number, number]]> = [['Historical', historical, ci.historical], ['Duration-corrected', ci.corrected, ci.correctedCi]];
  return (
    <figure className="gate3-figure">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Gate 3 discriminator AUROC: historical ${historical.toFixed(3)} (90% interval ${ci.historical[0]}–${ci.historical[1]}), duration-corrected ${ci.corrected.toFixed(3)} (${ci.correctedCi[0]}–${ci.correctedCi[1]}). The pass target is at most 0.65; 0.5 would mean indistinguishable. Both are far above the target, so the gate failed.`}>
        <rect x={x(0.5)} y={M.t - 6} width={x(0.65) - x(0.5)} height={H - M.b - M.t + 12} className="g3-pass" />
        <text x={x(0.5) + 6} y={M.t + 6} className="fig-axis g3-pass-label">pass zone ≤ 0.65</text>
        {[0.5, 0.6, 0.7, 0.8, 0.9, 1].map(t => <text key={t} x={x(t)} y={H - 8} textAnchor="middle" className="fig-axis">{t.toFixed(1)}</text>)}
        {rows.map(([label, v, [lo, hi]], i) => {
          const yy = M.t + 26 + i * 30;
          return <g key={label}>
            <text x={M.l - 10} y={yy + 4} textAnchor="end" className="fig-axis g3-label">{label}</text>
            <line x1={x(lo)} x2={x(hi)} y1={yy} y2={yy} className="g3-ci" />
            <circle cx={x(v)} cy={yy} r={5} className="g3-dot" />
            <text x={x(v) - 10} y={yy + 4} textAnchor="end" className="fig-axis">{v.toFixed(3)}</text>
          </g>;
        })}
      </svg>
      <figcaption className="fig-caption">Discriminator AUROC (dot) with its 90% interval. 0.5 would mean the synthetic traces are indistinguishable from the comparison generator&apos;s; the gate passes at 0.65 or below. The comparison data are themselves synthetic.</figcaption>
    </figure>
  );
}
