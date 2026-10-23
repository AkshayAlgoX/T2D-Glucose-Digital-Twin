# Deployment Guide: Hugging Face Spaces Single Container

The T2D Glucose Digital Twin runs as a unified single-container deployment on Hugging Face Spaces (Docker SDK), serving both the Next.js frontend and the FastAPI inference backend.

## Architecture

```
Internet (Judges / Clinicians)
       │
       ▼ [Port 7860]
┌────────────────────────────────────────────────────────┐
│ Hugging Face Spaces Docker Container                   │
│                                                        │
│  ┌──────────────────────────────────────────────────┐  │
│  │ Next.js Frontend (Port 7860)                     │  │
│  │ - Workstation UI (/cohort, /patients/[id])       │  │
│  │ - Evidence Hub (/evidence)                       │  │
│  │ - App Router API Proxies (/api/*, /v1/health)    │  │
│  └──────────────────────┬───────────────────────────┘  │
│                         │ Server-to-server             │
│                         ▼ [http://127.0.0.1:8000]      │
│  ┌──────────────────────────────────────────────────┐  │
│  │ FastAPI Backend (Port 8000)                      │  │
│  │ - PR-TFT Neural Network + UKF Physiology Prior   │  │
│  │ - Synthetic-v2 Replay & Conformal Calibration    │  │
│  │ - Sealed Partition Access Protection             │  │
│  └──────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────┘
```

The browser only ever communicates with port 7860 via standard relative URLs (`/api/...`). No client requests are directed to internal `localhost` addresses.

## Prerequisites

- Hugging Face account (https://huggingface.co)
- Space configuration:
  - **SDK**: Docker
  - **Hardware**: CPU basic (2 vCPU / 16 GB RAM) — sufficient for CPU inference (~1.5 GB memory footprint)
  - **Visibility**: Public

## Deployment Methods

### Option A: Direct Git Push to Hugging Face Space (Recommended)

1. Create a new Space on Hugging Face with SDK **Docker**.
2. Add the Hugging Face Space as a git remote:
   ```bash
   git remote add hf https://huggingface.co/spaces/<YOUR_USERNAME>/<YOUR_SPACE_NAME>
   ```
3. Push the verified deployment branch:
   ```bash
   git push hf deploy/hf-space-unified:main
   ```
4. Hugging Face Spaces will automatically build the root `Dockerfile` and launch the container on port 7860.

### Option B: Standalone Space Repository

If you prefer keeping the Space git repository minimal:
1. Clone the newly created Space repository:
   ```bash
   git clone https://huggingface.co/spaces/<YOUR_USERNAME>/<YOUR_SPACE_NAME> space-repo
   cd space-repo
   ```
2. Copy `deploy/hf-space/Dockerfile` and `deploy/hf-space/README.md` to the Space root:
   ```bash
   cp /path/to/T2D-Glucose-Digital-Twin/deploy/hf-space/Dockerfile ./Dockerfile
   cp /path/to/T2D-Glucose-Digital-Twin/deploy/hf-space/README.md ./README.md
   ```
3. Commit and push:
   ```bash
   git add Dockerfile README.md
   git commit -m "Deploy unified Next.js + FastAPI container"
   git push origin main
   ```
4. The standalone Dockerfile clones the pinned repository and pulls the Git LFS model checkpoint during build.

## Environment Variables & Secrets

Configure in Hugging Face Space Settings -> **Variables and secrets**:
- `PR_TFT_SERVICE_TOKEN` *(Optional Secret)*: If set, secures the internal FastAPI endpoints with a bearer token. Next.js automatically includes this token on all internal calls.
- `NODE_ENV`: Set to `production` (default in container).
- `PORT`: Set to `7860` (default in container).

## Post-Deployment Verification Checklist

1. **Liveness**:
   - `GET https://<user>-<space>.hf.space/v1/health`
   - Must return HTTP 200 with `status: "ok"` and `subjects: 249`.
2. **Landing Page**:
   - Open `https://<user>-<space>.hf.space/` in a fresh/incognito browser window.
   - Verify hero forecast and quick-entry links render.
3. **Cohort Triage**:
   - Navigate to `/cohort`.
   - Verify all 249 synthetic patients are browsable across Healthy, Prediabetes, and Type 2 groups.
4. **Clinical Workstation Replay**:
   - Navigate to `/patients/6f50ef50-b6e5-5408-a70c-d8f0509d6012` (Demo validation subject P0017).
   - Verify real-time CGM stream, trend classification, and PR-TFT forecast fan chart render.
5. **Scenario Counterfactuals**:
   - Add a 45 g meal event in the scenario editor.
   - Verify the counterfactual trajectory recalculates and displays physiological postprandial excursion.
6. **Scientific Evidence Hub**:
   - Navigate to `/evidence`.
   - Confirm all empirical validation charts, Gate 3 realism summaries, and Clarke grid scores display.
7. **Sealed Split Firewall**:
   - Verify that querying held-out test partition subjects (e.g., `P0004`, `P0013`) returns HTTP 404 indistinguishable from random UUIDs.
