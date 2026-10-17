# Presentation outline — draft for PDF/PPT export

Audience: technical judges and healthcare experts. Proposed narrative: **patient context + wearable history + physiological state → forecast and risk that a reviewer can inspect, with explicit uncertainty and evidence limits**.

Use the actual release only. A mockup, design fixture and live response must carry different labels. No ranking prediction, clinical-validation claim or invented performance chart.

| Slide | Title and key message | Evidence required / available | Suggested visual |
|---|---|---|---|
| 1 | T2D Glucose Digital Twin — synthetic research prototype | `[TEAM]`, `[INSTITUTION]`, `[RELEASE]`; intended-use field in service | Title plus approved actual dashboard capture |
| 2 | From a reading to a trajectory | Clinical-use hypothesis: contextual inspection could support monitoring; no measured patient benefit | Present as intended workflow, C16 | One reading, forecast band and risk concept; illustrative values labelled schematic |
| 3 | Two information streams, one patient context | Static EHR and wearable/logged-meal features enter the implementation | Input contract and feature lists, C01–C02 | Two-column inputs; separate observable and prohibited-latent boundary |
| 4 | Why a hybrid model? | UKF supplies state/prior; PR-TFT learns residual quantiles and hazard | Source C03; superiority is not established | Architecture diagram from architecture.mmd |
| 5 | What the model returns | Five-minute grid, 120-minute horizon, quantiles and onset probability | C04–C05; actual authorized response capture pending | Real response and matched plot; no fake outputs |
| 6 | Clinician-facing workflow | Cohort → patient → trend/band → risk and data quality | C06–C07; end-to-end recording pending | Annotated live capture with synthetic/replay label |
| 7 | A warning is more than AUROC | Sensitivity, false alerts, lead time and decision timing must be evaluated together | Frozen EW-01 definitions; scientific result not yet available | Metric definitions, no fabricated benchmark bars |
| 8 | Explain the model without claiming causality | Contribution display decomposes model arithmetic | `drivers`, RiskPanel, C09 | Actual contribution view; “not causal attribution” caption |
| 9 | What-If: capability and boundary | Scenario API exists; editor disabled; medication unsupported; human effect sizes unknown | C08; optional later authorized API capture | Baseline/scenario flow schematic, no promised direction/magnitude |
| 10 | Evidence we have—and evidence we do not | Source verification, saved engineering tests, historical selected-VAL metrics, blocked fresh evaluation | Ledger C10–C14 | Four clearly separated evidence tiers; historical metrics only in appendix |
| 11 | Reproducibility and limitations | Artifact/source identity, input constraints, environment work and simulator circularity | Source inventory and final release verification `[PENDING]` | Small provenance table; missing evidence visibly marked |
| 12 | Demonstrated scope and next step | Working replay must be shown; future real-data and clinical studies remain future work | `[LIVE_DEMO_EVIDENCE]`; no outcome-benefit claim | Final links/QR codes only after access verification |

## Optional technical appendix

1. Historical Arm D manifest: 205/44/44 split and selected-VAL figures, with dirty-source and calibration reuse caveats on the same slide. Do not lead with near-zero calibrated ECE.
2. Alert policy versus evaluator: describe the difference without modifying either.
3. Artifact and software provenance: model checkpoint digest as recorded versus independently rehashed source artifacts.
4. Non-operational/future components: scenario UI connection, nightly fitting, real sensor ingestion, real-world/clinical validation.

## Final deck review

- Replace placeholders with verified values; links must work without team credentials.
- Export as PDF/PPT. Markdown alone does not meet the requested presentation format.
- Remove any slide that depends on an uncompleted scientific result rather than leaving an optimistic conclusion.
- Do not place H1/WIF-02 outcomes, data, protected paths, team credentials or quarantined screenshots in the deck.
- Rank 1 is an internal objective, never a predicted outcome or scientific claim.
