# Model Selection Rule

*(Locked AFTER S2/S3 validation but BEFORE test/final-model evaluation)*

## Primary Evaluation Population
- **Primary**: Prediabetes + Type 2 Diabetes
- **Secondary**: Healthy
- **Excluded**: Type 1 Diabetes (T1D)

## Comparison Models
1. Persistence baseline
2. Realistic twin-only
3. Realistic PR-TFT+UKF

*(Oracle model is evaluated purely as a privileged-information diagnostic reference and is NOT a candidate.)*

## Selection Criteria
1. **Primary Metrics**:
   - Spike-event Sensitivity (higher is better; must exceed baseline)
   - Alert Precision (higher is better; must exceed baseline)
   - RMSE and MAE at 60 and 120 min (lower is better)
2. **Safety & Calibration**:
   - Alerts per patient-day (lower false alerts is better)
   - Prediction interval coverage (raw & conformalized; must be within 5% of target)
   - Expected Calibration Error (ECE; lower is better)
3. **Robustness**:
   - Patient-level uncertainty (paired bootstrap results)
   - Realism (zero latent leakage confirmed by firewall)

## Tie-Break Logic
If PR-TFT+UKF improves on RMSE/MAE but has similar or slightly lower sensitivity than twin-only (within statistical tolerance), select the model with the strictly lower false alert rate per patient-day. If both are equal, prefer PR-TFT+UKF if its conformal prediction interval width is significantly narrower. If the 0.60 alert tier is unreachable, use the 0.35 tier as the primary operating point. If uncertainty coverage misses the target by more than 5%, the model is downgraded.
