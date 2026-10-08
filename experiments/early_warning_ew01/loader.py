import sys
import dataclasses
import numpy as np
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "backend"))
import train_pr_tft as T

def load_cohort_explicit_canonical(cfg: T.TrainConfig, patient_ids: list[str], meal_log_path: Path) -> list[T.PatientSeries]:
    """
    Loads the cohort data for EW-01 with zero regeneration.
    Requires canonical meal arrays for EVERY VAL ID.
    """
    cfg_read = dataclasses.replace(cfg, log_corruption=False)
    series_dict = T.load_data(cfg_read, patient_ids=patient_ids)
    
    meal_log = np.load(meal_log_path)
    
    out = []
    for p in sorted(patient_ids):
        if p not in series_dict:
            raise KeyError(f"Patient {p} missing from base load.")
        if f"{p}_min" not in meal_log.files or f"{p}_carbs" not in meal_log.files:
            raise KeyError(f"Patient {p} missing canonical meal logs.")
            
        ps = series_dict[p]
        ps = dataclasses.replace(ps, 
            meal_min=meal_log[f"{p}_min"], 
            meal_carbs=meal_log[f"{p}_carbs"]
        )
        out.append(ps)
    return out
