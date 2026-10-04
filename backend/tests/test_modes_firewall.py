"""Realistic / oracle separation: realistic arms cannot see simulator latents through any path;
the oracle arm reads them explicitly or fails; unknown modes never fall back."""

from __future__ import annotations

import dataclasses

import numpy as np
import pandas as pd
import pytest
import torch

import train_pr_tft as T
import ukf_twin as U
from input_contract import FORBIDDEN_EHR_COLUMNS, ORACLE_LATENT_COLUMNS, REALISTIC_EHR_COLUMNS

BAD_MODES = ("", "realistic", "S3", "s4", "oracle ", None)


@pytest.fixture(scope="module")
def small_dataset(tmp_path_factory, real_data_dir, frozen_split):
    """A 6-patient copy of the locked dataset (all EHR rows, telemetry of 6 patients)."""
    pids = frozen_split["train"][:4] + frozen_split["val"][:1] + frozen_split["test"][:1]
    root = tmp_path_factory.mktemp("small")
    tele = pd.read_csv(real_data_dir / "patient_cgm_telemetry.csv")
    tele[tele["patient_id"].isin(pids)].to_csv(root / "patient_cgm_telemetry.csv", index=False)
    ehr = pd.read_csv(real_data_dir / "patients_ehr.csv")
    split = {"train": pids[:4], "val": pids[4:5], "test": pids[5:]}
    return root, ehr, split


def variant(root, ehr: pd.DataFrame, name: str, how: str):
    d = root.parent / f"{root.name}_{name}"
    d.mkdir(exist_ok=True)
    (d / "patient_cgm_telemetry.csv").write_bytes((root / "patient_cgm_telemetry.csv").read_bytes())
    e = ehr.copy()
    latent = list(ORACLE_LATENT_COLUMNS + FORBIDDEN_EHR_COLUMNS)
    if how == "permute":
        e[latent] = e[latent].sample(frac=1.0, random_state=3).to_numpy()
    elif how == "garbage":
        e[latent] = np.random.default_rng(3).uniform(-1e6, 1e6, (len(e), len(latent)))
    elif how == "drop":
        e = e.drop(columns=latent)
    e.to_csv(d / "patients_ehr.csv", index=False)
    return d


def split_tensors(data_dir, split, mode: str) -> dict[str, torch.Tensor]:
    cfg = dataclasses.replace(T.TrainConfig(), data_dir=str(data_dir), out_dir="unused", twin="ukf", twin_mode=mode)
    series = T.load_data(cfg)
    dm, *_ = T.build_datamodule(series, split, cfg, np.random.default_rng(1))
    return {f"{name}.{f.name}": getattr(s, f.name) for name, s in dm.splits.items()
            for f in dataclasses.fields(s) if torch.is_tensor(getattr(s, f.name))}


@pytest.mark.parametrize("mode,how", [("s3", "permute"), ("s3", "garbage"), ("s3", "drop"), ("s2", "permute")])
def test_latent_columns_cannot_change_realistic_inputs(small_dataset, mode, how):
    root, ehr, split = small_dataset
    base = split_tensors(variant(root, ehr, "orig", "none"), split, mode)
    other = split_tensors(variant(root, ehr, how, how), split, mode)
    assert base.keys() == other.keys() and len(base) >= 30
    for k in base:
        assert torch.equal(base[k], other[k]), k


def test_realistic_static_inputs_are_exactly_the_18_observable(cohort):
    assert len(T.STATIC_FEATURES_REALISTIC) == 18 and len(T.STATIC_FEATURES_ORACLE) == 21
    assert T.get_static_features("s2") == T.get_static_features("s3") == T.STATIC_FEATURES_REALISTIC
    for ps in cohort.values():
        assert set(ps.static_raw) == set(T.STATIC_FEATURES_REALISTIC)


def test_label_and_latent_columns_are_never_read():
    assert "future_spike_2h" not in T.TELEMETRY_COLUMNS
    for name in ("future_spike_2h", *ORACLE_LATENT_COLUMNS, *FORBIDDEN_EHR_COLUMNS):
        assert name not in T.PAST_FEATURES + T.FUTURE_FEATURES + T.STATIC_FEATURES_REALISTIC + U.UKF_PAST_FEATURES
        assert name not in REALISTIC_EHR_COLUMNS


def test_oracle_mode_reads_latents_explicitly(real_data_dir, frozen_split):
    pids = frozen_split["val"][:2]
    cfg = dataclasses.replace(T.TrainConfig(), data_dir=str(real_data_dir), out_dir="unused", twin="ukf", twin_mode="oracle")
    series = T.load_data(cfg, patient_ids=pids)
    ehr = pd.read_csv(real_data_dir / "patients_ehr.csv").set_index("patient_id")
    for pid, ps in series.items():
        for c in ORACLE_LATENT_COLUMNS:
            assert ps.static_raw[c] == pytest.approx(float(ehr.loc[pid, c]))
        p_or = U.UKFTwinPrior(mode="oracle")._prepare(ps)[0]
        assert p_or.gb == pytest.approx(float(ehr.loc[pid, "basal_glucose"]))
        assert p_or.tau_isf == pytest.approx(float(ehr.loc[pid, "tau_isf_min"]))
    assert len(T.get_static_features("oracle")) == 21


def test_oracle_without_latents_raises(tmp_path, small_dataset):
    root, ehr, split = small_dataset
    d = variant(root, ehr, "no_tau", "none")
    pd.read_csv(d / "patients_ehr.csv").drop(columns=["tau_isf_min"]).to_csv(d / "patients_ehr.csv", index=False)
    cfg = dataclasses.replace(T.TrainConfig(), data_dir=str(d), out_dir="unused", twin="ukf", twin_mode="oracle")
    with pytest.raises(KeyError):
        T.load_data(cfg)
    row = ehr.iloc[0].drop(labels=list(ORACLE_LATENT_COLUMNS))
    with pytest.raises(KeyError):
        T.static_vector(row, "oracle")
    with pytest.raises(KeyError):
        U.derive_params(row.to_dict(), 65.0, mode="oracle")
    nan_row = ehr.iloc[0].copy()
    nan_row["basal_glucose"] = np.nan
    with pytest.raises(KeyError):
        U.derive_params(nan_row.to_dict(), 65.0, mode="oracle")


@pytest.mark.parametrize("mode", BAD_MODES)
def test_unknown_modes_never_fall_back(mode, real_data_dir):
    row = pd.read_csv(real_data_dir / "patients_ehr.csv").iloc[0].to_dict()
    with pytest.raises(ValueError):
        T.get_static_features(mode)
    with pytest.raises(ValueError):
        U.derive_params(row, 65.0, mode=mode, first_cgm=120.0)
    with pytest.raises(ValueError):
        U.UKFTwinPrior(mode=mode)
    with pytest.raises(ValueError):
        T.load_data(dataclasses.replace(T.TrainConfig(), data_dir=str(real_data_dir), twin_mode=mode))
    with pytest.raises(ValueError):
        T.validate_train_config(dataclasses.replace(T.TrainConfig(), data_dir="x", out_dir="y", twin="ukf", twin_mode=mode))


def test_s3_requires_a_first_cgm_reading(real_data_dir):
    row = pd.read_csv(real_data_dir / "patients_ehr.csv").iloc[0].to_dict()
    for bad in (None, float("nan")):
        with pytest.raises(ValueError):
            U.derive_params(row, 65.0, mode="s3", first_cgm=bad)
    assert U.derive_params(row, 65.0, mode="s3", first_cgm=150.0).gb == 150.0


def test_twin_parameters_shown_to_users_are_not_latents(cohort):
    ps = next(iter(cohort.values()))
    s = U.UKFTwinPrior(mode="s3").parameter_summary(ps)
    assert set(s) == {"insulin_sensitivity_rel", "t_max_min"} and all(np.isfinite(list(s.values())))
