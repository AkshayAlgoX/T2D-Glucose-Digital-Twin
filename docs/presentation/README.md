# Presentation Deliverables & Reproducibility Guide

This directory contains the 14-slide presentation materials for the **T2D Glucose Digital Twin** submission, formatted for both slide-deck software (PPTX) and portable distribution (PDF). The recorded demonstration video is [youtu.be/arTnv1yWy1E](https://youtu.be/arTnv1yWy1E) (19:41).

## Deliverables Summary

| Artifact | Format | Slides / Pages | Purpose |
|---|---|---|---|
| [`presentation.pptx`](presentation.pptx) | Microsoft PowerPoint (16:9 Widescreen) | 14 slides | Editable presentation deck with presenter names on each slide and speaker notes (presenter guidance, spoken text and source paths). |
| [`presentation.pdf`](presentation.pdf) | Portable Document Format (16:9 Landscape) | 14 pages | Submission snapshot exported from `presentation.html`. Same slide text as `presentation.pptx`; layout differs slightly between the two renderers. |
| [`presentation.html`](presentation.html) | HTML5 / CSS Paged Media | 14 slides | Version-controlled layout source for the PDF, rendered with headless Chromium. |
| [`screens/`](screens/) | PNG image fixtures | 5 screenshots | 1440×900 recorded screenshots used in Slides 6, 8, 9, 10 and 13. |

## Slide Structure (Akshaya R & Nikhil VS)

The slides carry presenter names only, not per-slide times. The published recording runs 19:41; no slide-to-timestamp mapping is claimed here.

| Slide | Speaker | Title & Content |
|---|---|---|
| **01** | Nikhil | **The next two hours** (Project title, team affiliation, research scope) |
| **02** | Akshaya | **A reading needs context** (Clinical monitoring problem and hypothesis) |
| **03** | Akshaya | **Our subject is synthetic** (293 active synthetic subjects: 205 train / 44 val / 44 test; training-split subjects only in the demonstration) |
| **04** | Nikhil | **The forecasting path** (EHR/CGM inputs → UKF prior → PR-TFT → FastAPI → Next.js) |
| **05** | Akshaya | **A prior and a learned correction** (UKF physiological twin prior + learned PR-TFT correction) |
| **06** | Nikhil | **Reading a forecast** (120-min horizon, 5-min steps, median and uncertainty intervals) |
| **07** | Nikhil + Akshaya | **One subject, successive updates** (connected application; training-split subjects only) |
| **08** | Akshaya | **Holding a moment in time** (Pinned anchor inspection and time-travel navigation) |
| **09** | Nikhil | **Scenario projections** (Hypothetical meal & activity what-if; medication unsupported) |
| **10** | Akshaya | **When the answer is unavailable** (Insufficient data quality, stale, disconnected states) |
| **11** | Nikhil | **What the recorded metrics say** (synthetic validation split, development evidence: 60-min RMSE hybrid 19.53 / twin 23.23 / persistence 36.05 mg/dL; raw spike-risk AUROC 0.922; coverage 80.00% and Brier 0.0703 labelled as in-sample diagnostics) |
| **12** | Akshaya | **The realism check failed** (**FAIL**: Gate 3 mock-real AUROC 0.932 against ≤ 0.65; EW-01 unexecuted) |
| **13** | Nikhil | **What a reviewer can inspect** (Source code, schemas, run manifest, provenance) |
| **14** | Akshaya + Nikhil | **The next two hours, with evidence** (locked real-patient test 6.9% warned ≥30 min ahead; external checks not confirmed; C2 exploratory; AI-READI confirmation pending data access) |

## Screenshot provenance

Subject identity is taken from the identifier shown in each screenshot (`uuid5` of the patient ID, `backend/serve_pr_tft.py`) and the split from `runs/pr_tft_ablation_arm_d/split.json`. All are synthetic.

| Screenshot | Slide | Subject | Split |
|---|---|---|---|
| `slide6-reading-forecast.png` | 6 | P0001 | train |
| `slide8-holding-moment.png` | 8 | P0001 (pinned) | train |
| `slide9-scenario-projections.png` | 9 | P0001 (60 g meal scenario) | train |
| `slide10-answer-unavailable.png` | 10 | P0095 (insufficient history) | train |
| `slide13-reviewer-inspection.png` | 13 | Evidence page, recorded from an earlier build before the run's validation report was committed | — |

## Regenerating the deliverables

**PDF.** Print `presentation.html` with any Chromium-based browser in headless mode. The page size comes from the CSS `@page` rule (13.333 × 7.5 in), so no paper-size flags are needed:

```bash
# CHROME is your Chromium binary, for example:
#   Linux:   google-chrome, chromium, or Playwright's ~/.cache/ms-playwright/chromium-*/chrome-linux64/chrome
#   macOS:   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
#   Windows: "C:\Program Files\Google\Chrome\Application\chrome.exe"
"$CHROME" --headless --disable-gpu --no-pdf-header-footer \
  --print-to-pdf="docs/presentation/presentation.pdf" \
  "file://$(pwd)/docs/presentation/presentation.html"
```

**PPTX.** The repository has no generator for `presentation.pptx`. It is edited directly (in PowerPoint, or programmatically with `python-pptx`) and kept to the same slide text as `presentation.html`. After any change, convert it and compare the text with the PDF:

```bash
soffice --headless --convert-to pdf --outdir /tmp/pptx-check docs/presentation/presentation.pptx
pdftotext /tmp/pptx-check/presentation.pdf - | less
```

Check that both files have exactly 14 pages / slides.
