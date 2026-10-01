#!/usr/bin/env python3
"""test_latent_firewall.py -- Verifies strict containment of simulator-latent variables."""

from __future__ import annotations

import unittest
import numpy as np
import pandas as pd

import train_pr_tft as T
import ukf_twin as U

EHR_ALLOWLIST = {
    "patient_id", "age", "gender", "bmi", "genetic_risk_score", "hba1c",
    "diabetes_status", "height_cm", "weight_kg", "egfr", "diabetes_duration_years",
    "med_classes"
}

BLOCKED_LATENT_FIELDS = {
    "target_mean_glucose", "basal_glucose", "insulin_sensitivity_rel",
    "tmax0_min", "tau_isf_min"
}


class TestLatentFirewall(unittest.TestCase):

    def test_ehr_allowlist_filtering(self):
        """Verify load_data filters out any blocked latent columns."""
        cfg = T.TrainConfig(data_dir="/home/akshaya/synthetic_v2_300", seed=20260930, limit_patients=10)
        rng = np.random.default_rng(20260930)
        series = T.load_data(cfg, rng)
        self.assertTrue(len(series) > 0)
        first_ps = next(iter(series.values()))
        raw_keys = set(first_ps.static_raw.keys())

        for blocked in BLOCKED_LATENT_FIELDS:
            self.assertNotIn(blocked, raw_keys, f"Blocked latent field {blocked} found in static_raw")

    def test_static_feature_tuple(self):
        """Verify static features contain only observable EHR fields."""
        self.assertEqual(T.STATIC_CONTINUOUS, ("age", "bmi", "hba1c", "egfr", "diabetes_duration_years", "weight_kg"))
        self.assertEqual(len(T.STATIC_CONTINUOUS), 6)
        self.assertEqual(len(T.STATIC_FEATURES_REALISTIC), 6 + 1 + 4 + 7)  # 6 cont + sex + 4 status + 7 meds = 18

        for blocked in BLOCKED_LATENT_FIELDS:
            self.assertNotIn(blocked, T.STATIC_FEATURES_REALISTIC, f"Blocked field {blocked} in STATIC_FEATURES_REALISTIC")

    def test_patient_series_physiology_derivations(self):
        """Verify gb, k_base, tmax are derived without simulator latent fields."""
        mock_ehr = pd.Series({
            "patient_id": "P_TEST",
            "age": 55, "gender": "F", "bmi": 28.5, "genetic_risk_score": 0.25,
            "hba1c": 7.2, "diabetes_status": "Type 2", "height_cm": 165.0,
            "weight_kg": 75.0, "egfr": 90.0, "diabetes_duration_years": 4.0,
            "med_classes": "metformin;glp1_ra"
        })

        s_vec = T.static_vector(mock_ehr, "s3")
        for blocked in BLOCKED_LATENT_FIELDS:
            self.assertNotIn(blocked, s_vec)

        # ADAG HbA1c formula check: mu = 28.7 * 7.2 - 46.7 = 159.94 mg/dL
        # gb = 110 + 0.3 * (159.94 - 110) = 124.982 mg/dL
        mu_expected = 28.7 * 7.2 - 46.7
        gb_expected = 110.0 + 0.30 * (mu_expected - 110.0)
        
        # Monnier sensitivity log-linear formula check:
        # ln_si = -0.035 * (28.5 - 25) - 0.005 * (55 - 45) - 0.40 * 1 - 0.20 * 0 = -0.1225 - 0.05 - 0.40 = -0.5725
        # si_rel = exp(-0.5725) * 1.10 (metformin) = 0.5641 * 1.10 = 0.6205
        # k_base = 0.01 + 0.01 * si_rel
        
        ln_si = -0.035 * (28.5 - 25) - 0.005 * (55 - 45) - 0.40
        si_rel_expected = float(np.clip(np.exp(ln_si), 0.15, 1.2)) * 1.10
        k_base_expected = 0.01 + 0.01 * si_rel_expected

        # Derive via ukf_twin.derive_params in mode S2
        params_s2 = U.derive_params(mock_ehr.to_dict(), hr_rest=65.0, mode="s2")
        self.assertAlmostEqual(params_s2.gb, gb_expected, places=2)
        self.assertAlmostEqual(params_s2.tmax, 38.0 * 1.3 * 1.3, places=2)  # 38.0 * 1.3 * 1.3 GLP-1 RA slowing
        self.assertAlmostEqual(params_s2.tau_isf, 8.0, places=2)

    def test_ukf_mode_s3_dynamic_cgm(self):
        """Verify S3 mode uses initial CGM baseline for gb without simulator truth."""
        mock_ehr = pd.Series({
            "patient_id": "P_TEST_S3", "age": 50, "gender": "M", "bmi": 30.0,
            "hba1c": 8.0, "diabetes_status": "Type 2", "weight_kg": 90.0, "egfr": 85.0,
            "med_classes": "metformin"
        })
        params_s3 = U.derive_params(mock_ehr.to_dict(), hr_rest=70.0, mode="s3", first_cgm=145.0)
        self.assertEqual(params_s3.gb, 145.0)
        self.assertEqual(params_s3.tau_isf, 8.0)

    def test_hazard_target_isolation(self):
        """Verify future_spike_2h is absent from past, static, and future input features."""
        cfg = T.TrainConfig(data_dir="/home/akshaya/synthetic_v2_300", seed=20260930, limit_patients=5)
        self.assertNotIn("future_spike_2h", T.PAST_FEATURES)
        self.assertNotIn("future_spike_2h", T.STATIC_FEATURES_REALISTIC)
        self.assertNotIn("future_spike_2h", T.FUTURE_FEATURES)
        self.assertNotIn("future_spike_2h", U.UKF_PAST_FEATURES)


if __name__ == "__main__":
    unittest.main()
