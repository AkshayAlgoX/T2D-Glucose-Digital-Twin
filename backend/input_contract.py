"""input_contract.py -- what the model may see, and when it may see it.

Single source of truth shared by train_pr_tft.py, ukf_twin.py, serve_pr_tft.py and the
evaluation scripts, so the causal rules and the latent firewall cannot drift apart:

    * time grid       5-min CGM steps; step k is the reading stamped k * 5 min;
    * meal timing     a meal logged at minute m becomes known at step ceil(m / 5), the first
                      step stamped at or after the log time. round() or floor() would place
                      some meals on a step stamped *before* they were logged (look-ahead);
    * resting HR      estimated from the first HR_REST_STEPS steps (one day), so no decision
                      may be made before step HR_REST_STEPS - 1;
    * twin modes      "s2" / "s3" use observable EHR only (18 static features); "oracle" adds
                      simulator latents and is a privileged-information reference, never a
                      candidate. There is no default mode and no fallback between modes.
"""

from __future__ import annotations

import numpy as np

STEP_MIN = 5
HR_REST_STEPS = 288  # one day of 5-min steps

TWIN_MODES = ("oracle", "s2", "s3")
REALISTIC_MODES = ("s2", "s3")

# Columns of patients_ehr.csv a realistic (deployable) model may read.
REALISTIC_EHR_COLUMNS = (
    "patient_id", "age", "gender", "bmi", "genetic_risk_score", "hba1c", "diabetes_status",
    "height_cm", "weight_kg", "egfr", "diabetes_duration_years", "med_classes",
)
# Simulator ground truth; readable in oracle mode only.
ORACLE_LATENT_COLUMNS = ("basal_glucose", "insulin_sensitivity_rel", "tmax0_min", "tau_isf_min")
# Never read in any mode (the generator's own target, not a physiological parameter).
FORBIDDEN_EHR_COLUMNS = ("target_mean_glucose",)


def check_twin_mode(mode: str) -> str:
    """Return `mode` if it is one of TWIN_MODES, else raise ValueError (no aliases, no default)."""
    if mode not in TWIN_MODES:
        raise ValueError(f"twin_mode must be one of {TWIN_MODES}, got {mode!r}")
    return mode


def meal_step_index(meal_min: np.ndarray | list[float] | float) -> np.ndarray:
    """5-min step at which each logged meal is known: ceil(minutes / 5)."""
    return np.ceil(np.asarray(meal_min, dtype=float) / STEP_MIN).astype(int)
