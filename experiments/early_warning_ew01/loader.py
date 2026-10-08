import sys
import dataclasses
import numpy as np
from pathlib import Path

# Fix 1: Import path
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "backend"))

import train_pr_tft as T

def load_cohort(cfg: T.TrainConfig, patient_ids: list[str], meal_log_path: Path) -> list[T.PatientSeries]:
    """
    Loads the cohort data for EW-01, applying the frozen canonical meal log.
    """
    series_dict = T.load_data(cfg, patient_ids=patient_ids)
    
    # Fix 2: Canonical Meal Log
    meal_log = np.load(meal_log_path)
    
    out = []
    # Fix 3: Patient Order must be exactly sorted patient IDs
    for p in sorted(patient_ids):
        if p in series_dict:
            ps = series_dict[p]
            if f"{p}_min" in meal_log.files and f"{p}_carbs" in meal_log.files:
                ps = dataclasses.replace(ps, 
                    meal_min=meal_log[f"{p}_min"], 
                    meal_carbs=meal_log[f"{p}_carbs"]
                )
            out.append(ps)
    return out
