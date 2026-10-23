# Presentation Deliverables & Reproducibility Guide

This directory contains the authoritative 14-slide presentation materials for the **T2D Glucose Digital Twin** submission, formatted for both slide-deck software (PPTX) and portable distribution (PDF).

## Deliverables Summary

| Artifact | Format | Slides / Pages | Purpose |
|---|---|---|---|
| [`presentation.pptx`](presentation.pptx) | Microsoft PowerPoint (16:9 Widescreen) | 14 slides | Editable presentation deck with presenter cues and section timings. |
| [`presentation.pdf`](presentation.pdf) | Portable Document Format (16:9 Landscape) | 14 pages | Submission snapshot exported directly from `presentation.html` matching `presentation.pptx` 1:1. |
| [`presentation.html`](presentation.html) | HTML5 / CSS Paged Media | 14 slides | Editable, version-controlled layout source rendered via headless Chromium. |
| [`screens/`](screens/) | PNG image fixtures | 5 screenshots | High-resolution 1440×900 screenshots used in Slides 6, 8, 9, 10, and 13. |

## Slide Structure & Speaker Schedule (Akshaya R & Nikhil VS)

| Slide | Timing | Speaker | Title & Content |
|---|---|---|---|
| **01** | 00:00–01:30 | Nikhil | **The next two hours** (Project title, team affiliation, research scope) |
| **02** | 01:30–03:00 | Akshaya | **A reading needs context** (Clinical monitoring problem and hypothesis) |
| **03** | 03:00–04:30 | Akshaya | **Our subject is synthetic** (293 active synthetic subjects: 205 train / 44 val / 44 test) |
| **04** | 04:30–06:00 | Nikhil | **The forecasting path** (EHR/CGM inputs → UKF prior → PR-TFT → FastAPI → Next.js) |
| **05** | 06:00–07:30 | Akshaya | **A prior and a learned correction** (Bergman physiological twin + neural residual) |
| **06** | 07:30–09:00 | Nikhil | **Reading a forecast** (120-min horizon, 5-min steps, median and uncertainty intervals) |
| **07** | 09:00–11:30 | Nikhil + Akshaya | **One subject, successive updates** (Subject P0003 timeline update stream) |
| **08** | 11:30–13:00 | Akshaya | **Holding a moment in time** (Pinned anchor inspection and time-travel navigation) |
| **09** | 13:00–14:30 | Nikhil | **Scenario projections** (Hypothetical meal & activity what-if; medication unsupported) |
| **10** | 14:30–16:00 | Akshaya | **When the answer is unavailable** (Insufficient data quality, stale, disconnected states) |
| **11** | 16:00–17:30 | Nikhil | **What the recorded metrics say** (RMSE 12.36 / 19.53 / 25.03 mg/dL, coverage 80.00%, AUROC 0.923) |
| **12** | 17:30–19:00 | Akshaya | **The realism check failed** (**FAIL**: Gate 3 mock-real AUROC 0.932; EW-01 unexecuted) |
| **13** | 19:00–20:30 | Nikhil | **What a reviewer can inspect** (Source code, schemas, run manifest, provenance ledger) |
| **14** | 20:30–21:30 | Akshaya + Nikhil | **The next two hours, with evidence** (Research conclusion and next steps) |

## PDF Export Reproducibility

To regenerate `presentation.pdf` from the editable `presentation.html` source with headless Chromium / Google Chrome:

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless \
  --disable-gpu \
  --print-to-pdf="docs/presentation/presentation.pdf" \
  "file://$(pwd)/docs/presentation/presentation.html"
```

Verify that the generated PDF contains exactly 14 pages matching the 14 slides in `presentation.pptx`.
