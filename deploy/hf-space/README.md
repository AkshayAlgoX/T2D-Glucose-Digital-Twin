---
title: T2D Glucose Digital Twin
emoji: 🩺
colorFrom: blue
colorTo: indigo
sdk: docker
app_port: 7860
pinned: false
---

# T2D Glucose Digital Twin

Unified clinical workstation and predictive glucose digital twin deployment.
Serves both the Next.js frontend and FastAPI inference backend in a single container.

## Architecture
- **Single container**: Supervises FastAPI (port 8000 internally) and Next.js (port 7860 publicly).
- **In-container proxying**: Browser requests hit Next.js on port 7860; Next.js server route handlers proxy to the internal FastAPI instance (`http://127.0.0.1:8000`).
- **Endpoints**:
  - `GET /v1/health`: Inference service liveness, model version, and cohort count
  - `GET /`: Clinical workstation landing page
  - `GET /cohort`: Patient triage and cohort browser
  - `GET /patients/[id]`: Replay telemetry, predictive forecasts, and scenario simulator
  - `GET /evidence`: Preregistered empirical validation evidence and audit curves

## Data Safety & Ethics
- Synthetic-v2 data only; no licensed or identifiable participant data included.
- Sealed test-split subjects remain strictly inaccessible (indistinguishable from unknown IDs).
- Research use only; not for clinical diagnosis or treatment decisions.
