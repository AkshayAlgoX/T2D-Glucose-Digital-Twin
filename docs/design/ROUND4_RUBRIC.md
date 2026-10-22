# Round 4 design rubric: what each score requires

Scores are integers 1–10. A score needs screenshot evidence. **10 means no material, actionable defect was found
by an independent reviewer at 390, 820, 1440 and 1920 px**, not "looks good". Each level includes the ones below it.

| Dimension | 6 | 8 | 10 (all observable) |
|---|---|---|---|
| Visual distinctiveness | Coherent theme | A recognisable look | The signature comes from this product's purpose (observations, mechanistic twin, learned adjustment, forecast, uncertainty). A reviewer can name the product's visual signature and it could not be swapped onto another dashboard. |
| Professional design quality | Consistent spacing | One token system; deliberate type scale | No collisions, clipping, orphan controls, inconsistent radii/borders, or stray small grey text at any of the four widths; every interactive state (hover, focus, pressed, disabled) is designed. |
| First impression | Purpose stated | Real forecast above the fold | Within 5 s at 1440 × 900: what it does, why a twin, where to start. The working forecast is the hero and the architecture diagram supports it. |
| Healthcare clarity | Units present | Plain-language risk | Patient context, observation window, horizon, uncertainty, spike risk and the scenario are each stated in plain language with units and time; nothing implies clinical authority. |
| Forecast visualization | Bands drawn | Legend + labelled threshold | Observed, twin, adjustment, final, uncertainty, threshold and warnings are visually distinct, labelled, on aligned axes and mathematically consistent with the numbers on the page; no unlabelled decoration. |
| Hybrid explanation | Equation present | Equation on the chart | A first-time viewer can state "twin + adjustment = forecast" with the right numbers within 30 s, from the chart itself. |
| What-If | Works | Clear comparison | Baseline → choose → genuine backend run → whole-curve comparison → twin response and adjustment → risk and uncertainty; one unambiguous peak statistic; disclaimer and out-of-range warning visible; medication refused. |
| Mobile | No overflow | Usable | Designed for 390 px: the hierarchy holds, the primary actions are reachable, the charts stay interpretable, and there are no compressed labels. |
| Accessibility | Labels | axe clean | axe 0 violations; full keyboard path with a visible focus ring; chart descriptions; reduced motion respected; AA contrast. |
| Scientific credibility | Disclaimers present | Evidence vs model separated | Evidence, derived values, model output, conditional estimates, warnings and uncertainty are typographically distinct everywhere. Limitations (Gate 3 FAILED, no real-human validation, in-sample calibration) are visible on the first view of Evidence. **Capped by the evidence: Gate 3 FAILED and no real-human validation, so the reviewer judges honesty and clarity, not a perfect outcome.** |
