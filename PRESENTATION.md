# Presentation / Demo Materials

## Overview
The T2D Glucose Digital Twin represents a paradigm shift from reactive to **predictive metabolic monitoring**. It integrates real-time continuous glucose monitor (CGM) telemetry with Temporal Fusion Transformers (TFT) to forecast hypoglycemic and hyperglycemic events up to 2 hours in advance.

## Key Screens for Demo

### 1. The Clinical Workstation (Patient View)
- **Target Audience:** Clinicians and clinical researchers.
- **Visuals:** The 1440x900 split-pane layout showing the `ForecastCanvas`, `RiskStrip`, and `RiskPanel`.
- **Talking Points:**
  - Strict UI semantics (amber for warnings, no generic SaaS widgets).
  - Merged physics (mechanistic) bounds + deep learning (TFT) confidence intervals (p10-p90).
  - 120-minute forward visibility.

### 2. Risk Waterfall & Probability Curve
- **Target Audience:** Endocrinologists.
- **Visuals:** The `RiskPanel` on the right-hand side, displaying the cumulative probability curve crossing the 35% clinical threshold.
- **Talking Points:**
  - Instantly exposes the *drivers* of the predicted spike (e.g., carbs, delayed insulin).
  - Gives clinicians time to intervene *before* the spike occurs.

### 3. Fail-Safe Operations & Validation
- **Target Audience:** Engineering and compliance teams.
- **Visuals:** The `Evidence & Validation` module (stubbed) and the error overlays (Contract Invalid, Stale, Disconnected).
- **Talking Points:**
  - Strict backend-frontend separation using Zod validation.
  - Deterministic rendering layout ensuring no overlapping text or hidden critical data.
