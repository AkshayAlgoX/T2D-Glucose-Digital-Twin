"""Causality of every model input and of the at-risk flag, tested through production code.

The strongest check is test_inputs_ignore_everything_after_decision_time: it rebuilds the
exact tensors the model sees at anchor t after replacing every observation after t with
garbage (CGM, HR, steps, sleep, HRV) and moving the meal log to meals logged 1 and 4.9 min
after t. Any look-ahead -- meal rounding, a whole-series resting HR, a future-dependent
at-risk flag, future-aware habit features -- changes some input and fails the test."""

from __future__ import annotations

import dataclasses

import numpy as np
import pandas as pd
import pytest
import torch

import train_pr_tft as T
import ukf_twin as U
from input_contract import HR_REST_STEPS, STEP_MIN, meal_step_index


def toy_series(meal_min: list[float], n: int = 12) -> T.PatientSeries:
    return T.PatientSeries(
        pid="toy", group="Type 2", stamps=pd.date_range("2026-01-01", periods=n, freq="5min"),
        cgm=np.full(n, 100.0), cgm_ff=np.full(n, 100.0), hr=np.full(n, 70.0), hrv=np.full(n, 40.0),
        steps=np.zeros(n), asleep=np.zeros(n), meal_min=np.asarray(meal_min, dtype=float),
        meal_carbs=np.full(len(meal_min), 20.0), static_raw={}, gb=100.0, k_base=0.015, tmax=49.4, vg=150.0)


# --------------------------------------------------------------------------- #
# Meal timing
# --------------------------------------------------------------------------- #


def test_meal_step_index_is_ceil():
    assert meal_step_index([0.0, 0.1, 4.9, 5.0, 12.3, 12.6]).tolist() == [0, 1, 1, 1, 3, 3]


def test_logged_carbs_and_carbs_on_board_wait_for_the_log():
    ps = toy_series([12.3])
    logged, cob = T._logged_carbs_series(ps), T._carbs_on_board(ps)
    assert logged[:3].sum() == 0 and logged[3] == 20.0
    assert cob[:3].sum() == 0 and cob[3] > 0


def test_ukf_meal_input_waits_for_the_log(cohort):
    ps = next(iter(cohort.values()))
    t0 = 400
    for frac in (0.4, 2.3, 4.6):  # round() would move 0.4 and 2.3 earlier, floor() all three
        probe = dataclasses.replace(ps, meal_min=np.array([t0 * STEP_MIN + frac]), meal_carbs=np.array([50.0]))
        _, obs = U.UKFTwinPrior(mode="s3")._prepare(probe)
        assert np.flatnonzero(obs[:, 4]).tolist() == [t0 + 1], frac
    assert np.flatnonzero(U.meal_input_series(np.array([12.3, 15.0]), np.array([10.0, 5.0]), 10)).tolist() == [3]


def test_standalone_ukf_loader_matches_training_pipeline(real_data_dir, cohort, frozen_split):
    """ukf_twin.load_cohort (used by `ukf_twin.py validate`) must feed the filter exactly what
    the training pipeline feeds it: same meal-log corruption, same timing, same resting HR."""
    pids = frozen_split["val"][:3]
    loaded = {c.pid: c for c in U.load_cohort(str(real_data_dir), mode="s3", log_corruption=True,
                                              seed=T.TrainConfig().seed, patient_ids=pids)}
    for pid in pids:
        _, obs = U.UKFTwinPrior(mode="s3")._prepare(cohort[pid])
        np.testing.assert_array_equal(obs, loaded[pid].obs)


# --------------------------------------------------------------------------- #
# Resting heart rate
# --------------------------------------------------------------------------- #


def test_no_anchor_before_resting_hr_is_known(cohort, run_config):
    assert T.FIRST_ANCHOR == HR_REST_STEPS - 1 == 287
    assert min(int(T.eligible_anchors(ps, run_config.cfg).min()) for ps in cohort.values()) >= HR_REST_STEPS - 1


def test_ukf_inputs_up_to_t_use_no_later_heart_rate(cohort):
    """UKF inputs on steps 0..t must be identical whether or not HR after t exists."""
    tw = U.UKFTwinPrior(mode="s3")
    for ps in list(cohort.values())[:3]:
        _, full = tw._prepare(ps)
        for t in (HR_REST_STEPS - 1, HR_REST_STEPS + 40):
            cut = t + 1
            keep = ps.meal_min <= t * STEP_MIN
            short = dataclasses.replace(ps, stamps=ps.stamps[:cut], cgm=ps.cgm[:cut], cgm_ff=ps.cgm_ff[:cut],
                                        hr=ps.hr[:cut], hrv=ps.hrv[:cut], steps=ps.steps[:cut], asleep=ps.asleep[:cut],
                                        meal_min=ps.meal_min[keep], meal_carbs=ps.meal_carbs[keep])
            _, trunc = tw._prepare(short)
            np.testing.assert_array_equal(full[:cut], trunc)


# --------------------------------------------------------------------------- #
# At-risk flag
# --------------------------------------------------------------------------- #


def multi_spike() -> np.ndarray:
    cgm = np.full(260, 100.0)
    cgm[40:55] = 210.0  # spike 1, onset 40
    cgm[55:60] = 170.0  # not low enough to re-arm
    cgm[60:70] = 230.0  # same event: no onset
    cgm[70:80] = 120.0  # refractory: re-arms
    cgm[80:95] = 220.0  # spike 2, onset 80
    cgm[95:110] = np.nan
    cgm[110:140] = 110.0
    cgm[140:150] = 205.0  # spike 3, onset 140
    return cgm


def test_at_risk_uses_only_the_past_synthetic():
    cgm = multi_spike()
    onset, at_risk = T.detect_spike_onsets(cgm)
    assert np.flatnonzero(onset).tolist() == [40, 80, 140]
    for k in (40, 80, 140):  # unknown at k and k+1, known (not at risk) from k+2
        assert at_risk[k] and at_risk[k + 1] and not at_risk[k + 2]
    for t in range(cgm.size):
        assert T.detect_spike_onsets(cgm[:t + 1])[1][-1] == at_risk[t], t


def test_at_risk_uses_only_the_past_on_cohort(cohort):
    checked = 0
    for ps in list(cohort.values())[:12]:
        for k in np.flatnonzero(ps.onset)[:6]:
            for t in range(max(0, k - 1), min(ps.n, k + 4)):
                assert T.detect_spike_onsets(ps.cgm[:t + 1])[1][-1] == ps.armed[t], (ps.pid, t)
                checked += 1
    assert checked > 100


# --------------------------------------------------------------------------- #
# Every model input at decision time t
# --------------------------------------------------------------------------- #


INPUT_KEYS = ("past", "future", "static", "twin", "g0", "g_min60", "at_risk")


def scramble_after(ps: T.PatientSeries, t: int, rng: np.random.Generator) -> T.PatientSeries:
    n = ps.n - t - 1
    g = rng.uniform(40, 400, n)
    cgm = ps.cgm.copy()
    cgm[t + 1:] = np.where(np.isfinite(cgm[t + 1:]), g, np.nan)
    ff = ps.cgm_ff.copy()
    ff[t + 1:] = g
    hr, hrv, st, sl = ps.hr.copy(), ps.hrv.copy(), ps.steps.copy(), ps.asleep.copy()
    hr[t + 1:], hrv[t + 1:] = rng.uniform(50, 180, n), rng.uniform(5, 120, n)
    st[t + 1:], sl[t + 1:] = rng.integers(0, 150, n), rng.integers(0, 2, n)
    keep = ps.meal_min <= t * STEP_MIN
    meals = np.concatenate([ps.meal_min[keep], [t * STEP_MIN + 1.0, t * STEP_MIN + 4.9, t * STEP_MIN + 60.0]])
    carbs = np.concatenate([ps.meal_carbs[keep], [120.0, 90.0, 150.0]])
    out = dataclasses.replace(ps, cgm=cgm, cgm_ff=ff, hr=hr, hrv=hrv, steps=st, asleep=sl,
                              meal_min=meals, meal_carbs=carbs)
    out.onset, out.armed = T.detect_spike_onsets(cgm)
    return out


@pytest.fixture(scope="module")
def norm_pop(cohort, frozen_split, run_config):
    train = [cohort[p] for p in frozen_split["train"][:3]]
    tw = U.UKFTwinPrior(mode="s3")
    norm = T.Normalizer.fit(train, {ps.pid: tw.meal_effect_series(ps) for ps in train},
                            {ps.pid: tw.state_features(ps) for ps in train}, "s3")
    return norm, T.population_habit(train)


def test_inputs_ignore_everything_after_decision_time(cohort, frozen_split, run_config, norm_pop):
    cfg = run_config.cfg
    norm, pop = norm_pop
    rng = np.random.default_rng(7)
    checked = 0
    for pid in frozen_split["test"][:2]:
        ps = cohort[pid]
        anchors = T.eligible_anchors(ps, cfg)
        meal_t = [int(np.floor(m / STEP_MIN)) for m in ps.meal_min if int(np.floor(m / STEP_MIN)) in set(anchors.tolist())]
        for t in sorted(set(meal_t[:2] + [int(anchors[0]), int(anchors[len(anchors) // 2])])):
            anc = {pid: np.array([t])}
            a = T.AnchorDataset(T.build_split([ps], anc, U.UKFTwinPrior(mode="s3"), norm, pop, cfg))[0]
            b = T.AnchorDataset(T.build_split([scramble_after(ps, t, rng)], anc, U.UKFTwinPrior(mode="s3"),
                                              norm, pop, cfg))[0]
            for k in INPUT_KEYS:
                assert torch.equal(a[k], b[k]), (pid, t, k)
            assert not torch.equal(a["y"], b["y"])  # the scramble did reach the future
            checked += 1
    assert checked >= 6
