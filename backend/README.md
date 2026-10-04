# Backend PR-TFT Serving & Inference Service

This directory contains the production-grade FastAPI inference and streaming service for the Personalized Recurrent Temporal Fusion Transformer (PR-TFT) with physiological digital twin integration (Blueprint Section 9).

---

## 1. Architecture & Endpoints

The service exposes the v1 JSON contract (`contracts/v1/*.json`):

| Endpoint | Method | Auth | Description |
|---|---|---|---|
| `/v1/health` | GET | Public | Service liveness, model version, contract version, active cohort count |
| `/v1/subjects` | GET | Bearer Token | Active cohort list with subject UUIDs, patient IDs, groups, splits, time bounds |
| `/v1/forecasts` | POST | Bearer Token | ForecastRequest -> ForecastResponse (120-min 5-min step quantile predictions) |
| `/v1/subjects/{subject_id}/twin` | GET | Bearer Token | TwinCard prior physiological parameters and calibration stage |
| `/v1/subjects/{subject_id}/stream` | GET | Bearer Token | Server-Sent Events (SSE) replaying real cohort CGM telemetry with alert policy |

---

## 2. Safety Hardening & Clinical Invariants

1. **Monotonic Quantile Ordering (B2)**: Calibrated output quantiles (`p05`, `p10`, `p25`, `p50`, `p75`, `p90`, `p95`) are strictly validated for monotonicity. If non-monotonic crossings occur, the service triggers the safe `twin_only` fallback (`model.fallback_used = "twin_only"`) and serves the mechanistic physics forecast without failing.
2. **Causal Firewall**: All future target data and simulator latents are firewalled. Predictions strictly use past observable telemetry ($t \le 0$) and announced future scenario schedules.
3. **Alert Suppression Cooldown (B3)**: Alerts adhere strictly to `model_selection_rule.json`:
   - Watch threshold: $\ge 0.35$
   - Warning threshold: $\ge 0.60$ with causal spike filter (`spike_in_progress == False`)
   - Cooldown suppression: 120 minutes suppression window between alert triggers.
4. **SSE Stream Filtering (B1/B5)**: Streaming endpoint supports selective payload inclusion (`include=["drivers", "twin_state"]`) to minimize bandwidth while maintaining strict schema compliance.
5. **Data Quality Gate**: Insufficient past CGM coverage ($\le 70\%$) or excessive staleness sets `data_quality.status = "insufficient"`, returning null predictions with exact diagnostic reason codes.

---

## 3. Required Runtime Artifacts & Config Inventory

To serve a trained model, `--run-dir` must point to a completed run directory containing:

```text
runs/<RUN_NAME>/
├── run_manifest.json          # Preflight hashes, git SHA, model provenance, and checkpoint pointer
├── config.json                # Hyperparameter configuration (d_model, n_heads, twin_mode, etc.)
├── split.json                 # Patient partition assignments (train, val, test)
├── normalization.json         # Feature mean/std and scaling parameters
├── calibration.json           # Conformal prediction interval widths and isotonic regression tables
└── checkpoints/
    └── *.ckpt                 # PyTorch Lightning model weights checkpoint
```

### Static Data Dependencies:
- `backend/data_manifest.json`: Verified SHA-256 hashes for all input datasets.
- `backend/synthetic_v2/patients_ehr.csv`: Observable static EHR features (18 static dimensions).
- `backend/synthetic_v2/patient_cgm_telemetry.csv`: CGM and meal logs.

---

## 4. Starting the Service

### Development / Local:
```bash
# Optional: Set shared-secret service authentication token
export PR_TFT_SERVICE_TOKEN="<YOUR_SECRET_TOKEN>"
export PYTHONPATH=backend

# Start the service (bound to localhost)
backend/.venv/bin/python backend/serve_pr_tft.py \
  --run-dir runs/pr_tft_ablation_arm_d \
  --host 127.0.0.1 \
  --port 8000
```

### Network / Production (LAN / Tailscale):
```bash
export PR_TFT_SERVICE_TOKEN="<YOUR_SECRET_TOKEN>"
export PYTHONPATH=backend

# Bind to wildcard interface for Tailnet / LAN reachability
backend/.venv/bin/python backend/serve_pr_tft.py \
  --run-dir runs/pr_tft_ablation_arm_d \
  --host 0.0.0.0 \
  --port 8000
```

---

## 5. Verification & Testing

Run contract validation and safety hardening test suites:
```bash
# Validate against v1 JSON schemas
RUN_DIR=runs/pr_tft_ablation_arm_d backend/.venv/bin/pytest -v backend/tests/test_serve_pr_tft.py

# Validate safety hardening invariants (monotonic quantiles, alert cooldown, causal firewall)
RUN_DIR=runs/pr_tft_ablation_arm_d backend/.venv/bin/pytest -v backend/tests/test_safety_hardening.py
```
