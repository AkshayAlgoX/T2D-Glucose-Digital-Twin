import sys
from pathlib import Path

# Add project root to path so backend can be imported
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from backend import train_pr_tft as T

def load_cohort(cfg: T.TrainConfig, patient_ids: list[str]) -> list[T.PatientSeries]:
    """
    A minimal wrapper around the frozen load_data to satisfy EW-01 data loading contract.
    Loads the cohort data for EW-01, applying the locked logic.
    """
    series_dict = T.load_data(cfg, patient_ids=patient_ids)
    # Maintain the requested order and drop any missing patients silently (handled by caller if needed)
    return [series_dict[p] for p in patient_ids if p in series_dict]
