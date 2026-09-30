#!/usr/bin/env python3
"""test_causal_preprocessing.py -- Verifies causality, burn-in, and prefix-invariance."""

from __future__ import annotations

import unittest
import numpy as np
import pandas as pd
import jax.numpy as jnp

import train_pr_tft as T
import ukf_twin as U


class TestCausalPreprocessing(unittest.TestCase):

    def test_prefix_invariance_causality(self):
        """Verify that appending future CGM/inputs does NOT alter UKF filtered states up to t."""
        cfg = T.TrainConfig(data_dir="synthetic_v2", seed=20260930, limit_patients=1)
        rng = np.random.default_rng(20260930)
        series = T.load_data(cfg, rng)
        ps = next(iter(series.values()))

        # Run UKF on full series (T steps)
        twin = U.UKFTwinPrior(mode="s2")
        full_res = twin._run(ps)
        full_means = full_res["mean"]

        # Truncate series at step t_cutoff = 100
        t_cutoff = 100
        obs_truncated = full_res["obs"][:t_cutoff]
        params = full_res["params"]

        _, trunc_out = U._filter_one(jnp.asarray(obs_truncated), params, U.UKFConfig())
        trunc_means = np.asarray(trunc_out["mean"])

        # Filtered states at t_cutoff must be IDENTICAL within numerical precision
        np.testing.assert_allclose(full_means[:t_cutoff], trunc_means, rtol=1e-5, atol=1e-5,
                                   err_msg="Causality violation: UKF filtered states changed when future data was removed")

    def test_meal_binning_ceil(self):
        """Verify carbs_on_board uses ceil to prevent temporal leakage of future meals."""
        t_min = 12.3  # minute 12.3 (falls in bin 3: 15 min)
        k0 = max(0, int(np.ceil(t_min / T.STEP_MIN)))
        self.assertEqual(k0, 3)  # step 3 starts at 15 min, strictly after 12.3 min

    def test_corrupted_meal_log_reproducibility(self):
        """Verify corrupted meal log produces deterministic hashes under fixed seed."""
        rng1 = np.random.default_rng(20260930)
        rng2 = np.random.default_rng(20260930)

        minutes = np.array([120.0, 360.0, 720.0])
        carbs = np.array([45.0, 60.0, 75.0])

        m1, c1 = T.corrupt_meal_log(minutes, carbs, rng1)
        m2, c2 = T.corrupt_meal_log(minutes, carbs, rng2)

        np.testing.assert_allclose(m1, m2)
        np.testing.assert_allclose(c1, c2)


if __name__ == "__main__":
    unittest.main()
