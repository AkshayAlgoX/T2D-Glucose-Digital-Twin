#!/usr/bin/env python3
"""ukf_twin.py -- Blueprint 7.2 step 1: Unscented Kalman Filter state estimator for the T2D twin.

Tracks the latent physiology of the Section 3 ODE model from streaming CGM and wearable data,
and rolls the filtered state forward to give the PR-TFT its physics prior.

State (n = 11): the nine physiological states of Blueprint 3.3 plus two slowly drifting
parameters estimated jointly (augmented-state UKF):

    idx  name        unit        meaning
    0    G           mg/dL       plasma glucose
    1    X           1/min       remote insulin action
    2    I           uU/mL       plasma insulin
    3    Ss          uU/min      static (second-phase) insulin secretion
    4    Q1          mg          gut compartment 1 (carbohydrate)
    5    Q2          mg          gut compartment 2
    6    Gisf        mg/dL       interstitial glucose (what the CGM sees)
    7    Y           bpm         exercise heart-rate state (Breton)
    8    Z           -           post-exercise insulin-sensitivity state (Breton)
    9    theta_si    log         multiplicative drift of insulin sensitivity
    10   theta_egp   log         multiplicative drift of endogenous glucose production
    11   v1          mg/dL       CGM sensor noise, current (AR(2), colored)
    12   v2          mg/dL       CGM sensor noise, previous step
    13   bias        mg/dL       CGM calibration offset (random walk within a sensor session)

The two theta states absorb what the EHR-derived parameters get wrong (illness, missed
medication, true beta-cell function) at the speed the process noise allows. Without them a
twin built from population priors drifts away from the patient within hours.

Measurement: CGM = Gisf + bias + v1 + white noise (rounding, residual), R = r_white^2.
CGM sensor error is strongly autocorrelated (AR(2) in the generator, and in real sensors).
A UKF that treats it as white noise over-reacts to it, produces correlated innovations and
mis-states its own uncertainty; augmenting the state with the noise process (Bryson and
Henrikson) makes the residual measurement noise white again.

Inputs (exogenous, known when the step is processed):
    * logged meals: carbs added to Q1 as an impulse at the start of the step (Hovorka gut);
    * heart rate: the wearable's HR above the patient's resting rate, while stepping, is the
      exercise drive dHR of the Y state. HR is an input, not a measurement: it is not a
      function of the glucose states, so treating it as an observation of Y would add
      nothing identifiable and would double-count it;
    * stress: HR elevated without stepping drives a first-order stress index (tau 45 min)
      that raises EGP and lowers insulin sensitivity, as in the generator;
    * clock hour: circadian insulin sensitivity and the dawn rise of EGP.

Filter (Julier & Uhlmann; Wan & van der Merwe scaled unscented transform):
    * defaults alpha=1, beta=2, kappa=0 -> all sigma-point mean weights non-negative
      (cubature-like), which keeps the predicted covariance positive semi-definite;
    * ODE propagated by RK4 at 1-min substeps (5 per CGM interval) for every sigma point;
    * state constraints (non-negative insulin, gut mass, bounded Z and theta) enforced by
      clipping sigma points after propagation and projecting the mean;
    * covariance kept symmetric positive definite by an eigenvalue floor applied in
      correlation coordinates, so states whose variances differ by 16 orders of magnitude
      (X ~ 1e-8 vs Q1 ~ 1e8) are floored on a common scale;
    * outlier gating: a CGM reading whose normalized innovation squared exceeds the
      chi-square(1) 99.99 % point (15.1) is rejected (compression lows, sensor spikes); after
      6 consecutive rejections (30 min) the reading is accepted with R inflated by NIS/gate,
      so a real level change cannot lock the filter out;
    * missing CGM: predict-only step.

Unannounced meals (Blueprint 6.1): a one-sided CUSUM on positive normalized innovations
raises an alarm when glucose keeps rising faster than the filter predicts; the estimate of
unlogged carbohydrate is the gut mass the filter holds beyond what logged meals alone
(a deterministic "shadow gut") would leave.

Outputs per step: filtered mean and standard deviation of all 11 states, predicted CGM,
innovation, NIS, gate flag, CUSUM, unlogged-carbs estimate. `rollout`/`forecast` roll the
filtered state 120 min ahead (mean, or sigma points for uncertainty) under optional future
meals, activity and extra glucose flux -- this replaces the linearized TwinPrior.

Usage
    python ukf_twin.py validate --data-dir synthetic_v2          # accuracy vs. ground truth
    python ukf_twin.py stream-demo --data-dir synthetic_v2       # streaming API walkthrough

Requires jax (float64 is enabled on import), numpy, pandas.
"""

from __future__ import annotations

import argparse
import json
import logging
import math
import time
from dataclasses import dataclass
from typing import Any, Mapping, NamedTuple

import jax
import jax.numpy as jnp
import numpy as np
import pandas as pd

jax.config.update("jax_enable_x64", True)

import generate_health_data_v2 as gen  # single source of truth for the ODE constants  # noqa: E402

LOG = logging.getLogger("ukf_twin")

STATE_NAMES = ("G", "X", "I", "Ss", "Q1", "Q2", "Gisf", "Y", "Z", "theta_si", "theta_egp", "v1", "v2", "bias")
N_STATE = len(STATE_NAMES)
G, X, I, SS, Q1, Q2, GISF, Y, Z, TH_SI, TH_EGP, V1, V2, BIAS = range(N_STATE)
N_PHYS = 9
STEP_MIN = 5
SUBSTEPS = 5  # 1-min RK4 substeps per CGM interval
HORIZON = 24  # 120 min

LOWER = jnp.array([20.0, 1e-7, 0.0, 0.0, 0.0, 0.0, 20.0, 0.0, 0.0, -2.0, -2.0, -80.0, -80.0, -60.0])
UPPER = jnp.array([600.0, 0.5, 1000.0, 1e7, 5e5, 5e5, 600.0, 150.0, 1.0, 2.0, 2.0, 80.0, 80.0, 60.0])
# CGM sensor noise model (generator: AR(2) phi = (1.2, -0.4), stationary SD 5 mg/dL).
PHI1, PHI2, SENSOR_SD = 1.2, -0.4, 5.0
SENSOR_SHOCK_SD = SENSOR_SD / math.sqrt((1 - PHI2) / ((1 + PHI2) * ((1 - PHI2) ** 2 - PHI1**2)))
DAWN_CENTER_H, DAWN_WIDTH_H = 5.5, 1.2
STRESS_EGP, STRESS_SI = 0.5, 0.3  # generator: EGP x (1 + 0.5 Sh), S_I x (1 - 0.3 Sh)


# --------------------------------------------------------------------------- #
# Parameters
# --------------------------------------------------------------------------- #


class ModelParams(NamedTuple):
    """Per-patient ODE parameters (a JAX pytree; stack them to vmap over patients)."""

    gb: float  # basal glucose, mg/dL
    vg: float  # glucose distribution volume, dL
    vi: float  # insulin distribution volume, mL
    si: float  # insulin sensitivity, 1/min per uU/mL
    sg: float  # glucose effectiveness, 1/min
    ib: float  # basal insulin, uU/mL
    xb: float  # basal insulin action, 1/min
    beta: float  # static secretion gain, uU/min per mg/dL
    k1: float  # first-phase secretion gain, uU per mg/dL
    m_clr: float  # insulin clearance multiplier
    egp_b: float  # basal endogenous glucose production, mg/min
    egp_med: float  # medication multiplier on EGP
    ke1: float  # renal excretion rate, 1/min (eGFR-scaled)
    g_thr: float  # renal threshold, mg/dL
    tmax: float  # gut absorption time, min
    tau_isf: float  # plasma-to-interstitial lag, min
    a_dawn: float  # dawn EGP amplitude
    a_circ: float  # circadian S_I amplitude
    hr_rest: float  # resting heart rate, bpm


def derive_params(ehr: Mapping[str, Any], hr_rest: float) -> ModelParams:
    """EHR-derived priors, following generate_health_data_v2.derive_physiology.

    The generator draws beta-cell function, dawn and circadian amplitudes at random and
    does not export them, so population means are used here; theta_si and theta_egp are
    the filter's way of correcting the resulting mismatch online.
    """
    status = str(ehr["diabetes_status"])
    t2d, t1d, pre = status == "Type 2", status == "Type 1", status == "Prediabetes"
    meds = set(str(ehr.get("med_classes", "")).split(";")) - {"", "nan"}
    bw = float(ehr["weight_kg"])
    egfr = float(ehr["egfr"])
    dur = float(ehr.get("diabetes_duration_years", 0.0) or 0.0)
    si_rel = float(ehr["insulin_sensitivity_rel"])
    gb = float(ehr["basal_glucose"])
    vg, vi = 1.88 * bw, 50.0 * bw
    beta_rel = 0.02 if t1d else math.exp(-0.20 * t2d - 0.10 * pre - 0.05 * dur)
    m_beta = 1.6 if "glp1_ra" in meds else 1.2 if "dpp4i" in meds else 1.0
    k_rel = (0.3 if (t2d or t1d) else 1.0) * beta_rel
    ib = 10.0 if t1d else float(np.clip(8.0 / math.sqrt(si_rel), 5, 30))
    si = gen.SI_REF * si_rel
    sg = 0.012
    xb = si * ib
    sglt2 = "sglt2i" in meds
    ke1 = (gen.KE1_SGLT2 if sglt2 else gen.KE1) * egfr / 100.0
    g_thr = gen.G_RENAL_SGLT2 if sglt2 else gen.G_RENAL
    egp_b = vg * gb * (sg + xb) + ke1 * vg * max(gb - g_thr, 0.0)
    egp_med = (0.75 if "metformin" in meds else 1.0) * (0.9 if "glp1_ra" in meds else 1.0) \
        * (0.95 if "dpp4i" in meds else 1.0)
    tmax = float(ehr.get("tmax0_min", 38.0)) * 1.3 * (1.3 if "glp1_ra" in meds else 1.0)
    return ModelParams(
        gb=gb, vg=vg, vi=vi, si=si, sg=sg, ib=ib, xb=xb,
        beta=gen.BETA_REF * bw * beta_rel * m_beta, k1=gen.K_REF * bw * k_rel,
        m_clr=0.7 + 0.3 * min(egfr / 90.0, 1.0), egp_b=egp_b, egp_med=egp_med,
        ke1=ke1, g_thr=g_thr, tmax=tmax, tau_isf=float(ehr.get("tau_isf_min", 8.0)),
        a_dawn=0.15 if (t2d or t1d) else 0.06, a_circ=0.125, hr_rest=hr_rest,
    )


def stack_params(params: list[ModelParams]) -> ModelParams:
    return ModelParams(*[jnp.array([getattr(p, f) for p in params]) for f in ModelParams._fields])


# --------------------------------------------------------------------------- #
# Mechanistic model (Blueprint 3.3), JAX
# --------------------------------------------------------------------------- #


def dynamics(x: jnp.ndarray, u: jnp.ndarray, p: ModelParams) -> jnp.ndarray:
    """dx/dt for one state vector. u = (dHR_exercise, stress, clock_hour, extra_flux_mg_min)."""
    dhr, stress, hour, flux = u[0], u[1], u[2], u[3]
    g = jnp.maximum(x[G], 20.0)
    xa = jnp.maximum(x[X], 1e-7)
    ins = jnp.maximum(x[I], 0.0)
    q1, q2 = jnp.maximum(x[Q1], 0.0), jnp.maximum(x[Q2], 0.0)
    yex = jnp.maximum(x[Y], 0.0)
    zex = jnp.clip(x[Z], 0.0, 1.0)

    si_t = (p.si * jnp.exp(x[TH_SI]) * (1 + p.a_circ * jnp.cos(2 * jnp.pi * (hour - 8.0) / 24.0))
            * (1 - STRESS_SI * stress) * (1 + gen.BETA_EX * zex))
    dawn = 1 + p.a_dawn * jnp.exp(-((hour - DAWN_CENTER_H) ** 2) / (2 * DAWN_WIDTH_H**2))
    egp = (p.egp_b * jnp.exp(x[TH_EGP]) * p.egp_med * dawn * (1 + STRESS_EGP * stress)
           * jnp.exp(-gen.K_H * (xa - p.xb) / p.xb))
    ra = gen.F_BIO * q2 / p.tmax
    e_ren = p.ke1 * p.vg * jnp.maximum(g - p.g_thr, 0.0)
    u_ex = gen.ALPHA_EX * yex * g * p.vg
    dg = -(p.sg + xa) * g + (egp + ra - e_ren - u_ex + flux) / p.vg
    dx = gen.P2 * (si_t * ins - xa)
    dss = -gen.ALPHA_SEC * (x[SS] - p.beta * jnp.maximum(g - p.gb, 0.0))
    di = -gen.N_CLEAR * p.m_clr * (ins - p.ib) + (x[SS] + p.k1 * jnp.maximum(dg, 0.0)) / p.vi
    dq1 = -q1 / p.tmax
    dq2 = (q1 - q2) / p.tmax
    dgi = (g - x[GISF]) / p.tau_isf
    dy = (dhr - x[Y]) / gen.TAU_HR
    ratio = (yex / (0.5 * p.hr_rest)) ** 4
    f_y = ratio / (1 + ratio)
    dz = -(f_y + 1.0 / gen.TAU_Z) * zex + f_y
    return jnp.array([dg, dx, di, dss, dq1, dq2, dgi, dy, dz, 0.0, 0.0, 0.0, 0.0, 0.0])


def clip_state(x: jnp.ndarray) -> jnp.ndarray:
    return jnp.clip(x, LOWER, UPPER)


def propagate(x: jnp.ndarray, u: jnp.ndarray, p: ModelParams, meal_mg: jnp.ndarray) -> jnp.ndarray:
    """Advance one CGM interval: meal impulse into Q1, then 5 RK4 substeps of 1 min."""
    x = x.at[Q1].add(meal_mg)

    def rk4(_, s):
        k1 = dynamics(s, u, p)
        k2 = dynamics(s + 0.5 * k1, u, p)
        k3 = dynamics(s + 0.5 * k2, u, p)
        k4 = dynamics(s + k3, u, p)
        return clip_state(s + (k1 + 2 * k2 + 2 * k3 + k4) / 6.0)

    x = jax.lax.fori_loop(0, SUBSTEPS, rk4, x)
    v1_next = PHI1 * x[V1] + PHI2 * x[V2]  # discrete-time sensor noise, one step per reading
    return clip_state(x.at[V2].set(x[V1]).at[V1].set(v1_next))


# --------------------------------------------------------------------------- #
# Unscented Kalman filter
# --------------------------------------------------------------------------- #


class UKFConfig(NamedTuple):
    alpha: float = 1.0
    beta: float = 2.0
    kappa: float = 0.0
    r_white: float = 1.5  # mg/dL, residual white CGM noise once v1/v2/bias are modelled
    nis_gate: float = 15.13  # chi2(1) 99.99 %
    max_rejects: int = 6  # 30 min of consecutive rejections before forced acceptance
    cusum_k: float = 0.5
    cusum_h: float = 5.0
    corr_floor: float = 1e-9  # eigenvalue floor in correlation coordinates
    gut_adapt_gain: float = 0.25  # adaptive gut noise: sd x (1 + gain * CUSUM); tuned in validation sweep
    gut_adapt_cap: float = 8.0


class FilterState(NamedTuple):
    m: jnp.ndarray  # (n,)
    P: jnp.ndarray  # (n, n)
    shadow: jnp.ndarray  # (2,) logged-meals-only gut (Q1, Q2)
    cusum: jnp.ndarray  # ()
    rejects: jnp.ndarray  # () int


def ut_weights(n: int, cfg: UKFConfig) -> tuple[jnp.ndarray, jnp.ndarray, float]:
    lam = cfg.alpha**2 * (n + cfg.kappa) - n
    c = n + lam
    wm = jnp.full(2 * n + 1, 1.0 / (2 * c)).at[0].set(lam / c)
    wc = wm.at[0].add(1 - cfg.alpha**2 + cfg.beta)
    return wm, wc, c


def nearest_spd(P: jnp.ndarray, floor: float) -> jnp.ndarray:
    """Symmetrize and floor eigenvalues in correlation coordinates (scale-invariant)."""
    P = 0.5 * (P + P.T)
    d = jnp.sqrt(jnp.maximum(jnp.diag(P), 1e-300))
    corr = P / jnp.outer(d, d)
    w, v = jnp.linalg.eigh(corr)
    corr = (v * jnp.maximum(w, floor)) @ v.T
    return corr * jnp.outer(d, d)


def sigma_points(m: jnp.ndarray, P: jnp.ndarray, c: float) -> jnp.ndarray:
    L = jnp.linalg.cholesky(c * P)
    return jnp.concatenate([m[None, :], m[None, :] + L.T, m[None, :] - L.T], axis=0)


def process_noise(p: ModelParams) -> jnp.ndarray:
    """Per-5-min process noise (standard deviations, squared on the diagonal).

    Gut noise is large on purpose: it is how the filter explains an unlogged meal.
    Theta noise sets how fast the joint parameter estimates may drift (~0.1 log/day).
    """
    sd = jnp.array([
        1.5,                 # G, mg/dL
        0.05 * p.xb,         # X
        1.0,                 # I, uU/mL
        0.05 * p.beta * 10,  # Ss
        4000.0,              # Q1, mg (~4 g unlogged carbs per 5 min)
        800.0,               # Q2, mg
        0.5,                 # Gisf, mg/dL
        2.0,                 # Y, bpm
        0.005,               # Z
        0.006,               # theta_si
        0.006,               # theta_egp
        SENSOR_SHOCK_SD,     # v1: AR(2) innovation
        1e-3,                # v2: deterministic copy of v1
        0.3,                 # bias: slow calibration drift
    ])
    return jnp.diag(sd**2)


def initial_state(cgm0: float, p: ModelParams) -> FilterState:
    m = jnp.array([cgm0, p.xb, p.ib, 0.0, 0.0, 0.0, cgm0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0])
    sd0 = jnp.array([15.0, 0.5 * p.xb, 0.5 * p.ib, p.beta * 20, 20000.0, 20000.0, 15.0, 5.0, 0.1, 0.3, 0.3,
                     SENSOR_SD, SENSOR_SD, 8.0])
    return FilterState(m, jnp.diag(sd0**2), jnp.zeros(2), jnp.array(0.0), jnp.array(0))


def ukf_step(state: FilterState, obs: jnp.ndarray, p: ModelParams, cfg: UKFConfig):
    """One predict-update cycle. obs = (cgm or NaN, dHR, stress, hour, logged_meal_mg)."""
    cgm, dhr, stress, hour, meal_mg = obs[0], obs[1], obs[2], obs[3], obs[4]
    n = N_STATE
    wm, wc, c = ut_weights(n, cfg)
    u = jnp.array([dhr, stress, hour, 0.0])

    # ---- predict ---------------------------------------------------------
    chi = sigma_points(state.m, state.P, c)
    chi_pred = jax.vmap(lambda s: propagate(s, u, p, meal_mg))(chi)
    m_pred = clip_state(wm @ chi_pred)
    dev = chi_pred - m_pred
    # Innovation-adaptive gut noise: while the CUSUM sees glucose persistently outrunning the
    # prediction (an unlogged meal), widen the gut process noise so the filter can place the
    # missing carbohydrate quickly instead of lagging it for an hour.
    scale = jnp.minimum(1.0 + cfg.gut_adapt_gain * state.cusum, cfg.gut_adapt_cap)
    q_scale = jnp.ones(N_STATE).at[Q1].set(scale**2).at[Q2].set(scale**2)
    Qd = process_noise(p) * q_scale[:, None] * q_scale[None, :]
    P_pred = nearest_spd((wc[:, None] * dev).T @ dev + Qd, cfg.corr_floor)

    # ---- update ----------------------------------------------------------
    chi_u = sigma_points(m_pred, P_pred, c)
    zs = chi_u[:, GISF] + chi_u[:, BIAS] + chi_u[:, V1]  # h(x): what the sensor reports
    y_hat = wm @ zs
    dz = zs - y_hat
    R = cfg.r_white**2
    S = wc @ dz**2 + R
    cross = (wc[:, None] * (chi_u - m_pred)).T @ dz
    valid = jnp.isfinite(cgm)
    nu = jnp.where(valid, cgm - y_hat, 0.0)
    nis = nu**2 / S
    gated = nis > cfg.nis_gate
    forced = state.rejects >= cfg.max_rejects
    accept = valid & (~gated | forced)
    inflate = jnp.where(gated & forced, nis / cfg.nis_gate, 1.0)
    S_eff = S + R * (inflate - 1.0)
    K = cross / S_eff
    m_upd = clip_state(m_pred + K * nu)
    P_upd = nearest_spd(P_pred - jnp.outer(K, K) * S_eff, cfg.corr_floor)
    m_new = jnp.where(accept, m_upd, m_pred)
    P_new = jnp.where(accept, P_upd, P_pred)
    rejects = jnp.where(valid & gated & ~forced, state.rejects + 1, 0)

    # ---- unannounced-meal evidence ---------------------------------------
    z_norm = nu / jnp.sqrt(S)
    cusum = jnp.where(accept, jnp.maximum(0.0, state.cusum + z_norm - cfg.cusum_k), state.cusum)
    cusum = jnp.where(meal_mg > 0, 0.0, cusum)  # a logged meal explains the rise
    decay = jnp.exp(-STEP_MIN / p.tmax)
    s1 = state.shadow[0] + meal_mg
    shadow = jnp.array([s1 * decay, (state.shadow[1] + STEP_MIN / p.tmax * s1) * decay])
    unlogged_g = jnp.maximum(0.0, (m_new[Q1] + m_new[Q2]) - (shadow[0] + shadow[1])) / 1000.0

    out = {
        "mean": m_new, "sd": jnp.sqrt(jnp.diag(P_new)), "cgm_pred": y_hat, "innovation": nu,
        "S": S, "nis": nis, "accepted": accept, "gated": valid & gated & ~forced,
        "cusum": cusum, "unlogged_meal_alarm": cusum > cfg.cusum_h, "unlogged_carbs_g": unlogged_g,
    }
    return FilterState(m_new, P_new, shadow, cusum, rejects), out


def filter_series(obs: jnp.ndarray, p: ModelParams, cfg: UKFConfig) -> tuple[FilterState, dict]:
    """Run the UKF over a whole series. obs: (T, 5). Returns final state and stacked outputs."""
    first = obs[:, 0][jnp.argmax(jnp.isfinite(obs[:, 0]))]
    init = initial_state(first, p)
    return jax.lax.scan(lambda s, o: ukf_step(s, o, p, cfg), init, obs)


filter_batch = jax.jit(jax.vmap(filter_series, in_axes=(0, 0, None)), static_argnums=2)


# --------------------------------------------------------------------------- #
# Rollouts: the twin prior for PR-TFT
# --------------------------------------------------------------------------- #


def rollout(x0: jnp.ndarray, p: ModelParams, future: jnp.ndarray) -> jnp.ndarray:
    """Deterministic 120-min rollout. future: (24, 5) = (meal_mg, dHR, stress, hour, flux).
    Returns (24, n) states at +5 ... +120 min."""
    def step(x, f):
        u = jnp.array([f[1], f[2], f[3], f[4]])
        x_next = propagate(x, u, p, f[0])
        return x_next, x_next
    return jax.lax.scan(step, x0, future)[1]


def forecast(state_m: jnp.ndarray, state_P: jnp.ndarray, p: ModelParams, future: jnp.ndarray,
             cfg: UKFConfig = UKFConfig()) -> dict[str, jnp.ndarray]:
    """Unscented forecast: propagate all sigma points 120 min and summarize.

    The spread covers state uncertainty; process noise accumulated over the horizon is added
    to the glucose variance as k * q_G, and CGM measurement noise to the CGM prediction.
    """
    wm, wc, c = ut_weights(N_STATE, cfg)
    chi = sigma_points(state_m, nearest_spd(state_P, cfg.corr_floor), c)
    paths = jax.vmap(lambda s: rollout(s, p, future))(chi)  # (2n+1, 24, n)
    mean = jnp.einsum("s,skn->kn", wm, paths)
    var = jnp.einsum("s,skn->kn", wc, (paths - mean) ** 2)
    k = jnp.arange(1, HORIZON + 1)
    q_g = process_noise(p)[G, G]
    var_g = var[:, G] + k * q_g
    cgm_paths = paths[:, :, GISF] + paths[:, :, BIAS] + paths[:, :, V1]
    cgm_mean = wm @ cgm_paths
    # future sensor shocks add up to the stationary AR(2) variance
    var_cgm = wc @ (cgm_paths - cgm_mean) ** 2 + k * q_g + SENSOR_SD**2 + cfg.r_white**2
    return {"plasma_mean": mean[:, G], "plasma_sd": jnp.sqrt(var_g),
            "cgm_mean": cgm_mean, "cgm_sd": jnp.sqrt(var_cgm), "state_mean": mean}


rollout_many = jax.jit(jax.vmap(rollout, in_axes=(0, None, 0)))


# --------------------------------------------------------------------------- #
# Input preprocessing
# --------------------------------------------------------------------------- #


def estimate_hr_rest(hr: np.ndarray, steps: np.ndarray, asleep: np.ndarray, n: int = 288) -> float:
    """Median awake, non-stepping HR over the first day (causal once that day has passed)."""
    sel = (~asleep[:n]) & (steps[:n] == 0) & np.isfinite(hr[:n])
    return float(np.median(hr[:n][sel])) if sel.sum() >= 12 else float(np.nanmedian(hr[:n]))


def build_inputs(stamps: pd.DatetimeIndex, cgm: np.ndarray, hr: np.ndarray, steps: np.ndarray,
                 asleep: np.ndarray, meal_carbs_g: np.ndarray, hr_rest: float) -> np.ndarray:
    """(T, 5) observation/input matrix for filter_series.

    dHR drives exercise only while stepping (cadence > 60 /min); HR raised >= 12 bpm while
    awake and not stepping feeds the stress index, filtered with tau = 45 min.
    """
    cadence = steps / STEP_MIN
    excess = np.nan_to_num(hr - hr_rest, nan=0.0)
    dhr = np.where(cadence > 60, np.maximum(excess, 0.0), 0.0)
    trigger = ((excess >= 12) & (cadence < 20) & (~asleep)).astype(float)
    a = 1 - math.exp(-STEP_MIN / gen.TAU_STRESS)
    stress = np.zeros_like(trigger)
    for k in range(1, trigger.size):
        stress[k] = stress[k - 1] + a * (trigger[k] - stress[k - 1])
    hour = (stamps.hour + stamps.minute / 60.0).to_numpy()
    return np.column_stack([cgm, dhr, stress, hour, meal_carbs_g * 1000.0]).astype(np.float64)


def future_inputs(hour0: float, meal_carbs_g: np.ndarray | None = None, dhr: np.ndarray | None = None,
                  stress0: float = 0.0, flux_mg_min: np.ndarray | None = None) -> np.ndarray:
    """(24, 5) future input block for rollout/forecast. Stress decays from its current level."""
    k = np.arange(1, HORIZON + 1)
    hours = (hour0 + k * STEP_MIN / 60.0) % 24
    decay = np.exp(-k * STEP_MIN / gen.TAU_STRESS) * stress0
    return np.column_stack([
        (np.zeros(HORIZON) if meal_carbs_g is None else meal_carbs_g) * 1000.0,
        np.zeros(HORIZON) if dhr is None else dhr,
        decay, hours,
        np.zeros(HORIZON) if flux_mg_min is None else flux_mg_min,
    ])


# --------------------------------------------------------------------------- #
# Streaming API (one patient; state serializable for Redis)
# --------------------------------------------------------------------------- #


class UKFTwinStream:
    """Online twin for one patient: feed each 5-min reading, read twin_state, forecast.

        twin = UKFTwinStream(params, first_cgm=142)
        state = twin.update(cgm=145, hr=72, steps=0, asleep=False, meal_carbs_g=0, hour=12.5)
        fc = twin.forecast(hour0=12.5)
    """

    _step = staticmethod(jax.jit(ukf_step, static_argnums=3))
    _forecast = staticmethod(jax.jit(forecast, static_argnums=4))

    def __init__(self, params: ModelParams, first_cgm: float, cfg: UKFConfig = UKFConfig()):
        self.p, self.cfg = params, cfg
        self.state = initial_state(first_cgm, params)
        self.stress = 0.0
        self._stress_a = 1 - math.exp(-STEP_MIN / gen.TAU_STRESS)

    def update(self, cgm: float | None, hr: float, steps: float, asleep: bool, meal_carbs_g: float,
               hour: float) -> dict[str, Any]:
        cadence = steps / STEP_MIN
        excess = (hr - self.p.hr_rest) if hr is not None and math.isfinite(hr) else 0.0
        dhr = max(excess, 0.0) if cadence > 60 else 0.0
        trigger = float(excess >= 12 and cadence < 20 and not asleep)
        self.stress += self._stress_a * (trigger - self.stress)
        obs = jnp.array([np.nan if cgm is None else cgm, dhr, self.stress, hour, meal_carbs_g * 1000.0])
        self.state, out = self._step(self.state, obs, self.p, self.cfg)
        return twin_state_dict({k: np.asarray(v) for k, v in out.items()}, self.p)

    def forecast(self, hour0: float, meal_carbs_g: np.ndarray | None = None, dhr: np.ndarray | None = None,
                 flux_mg_min: np.ndarray | None = None) -> dict[str, np.ndarray]:
        fut = jnp.asarray(future_inputs(hour0, meal_carbs_g, dhr, self.stress, flux_mg_min))
        return {k: np.asarray(v) for k, v in self._forecast(self.state.m, self.state.P, self.p, fut, self.cfg).items()}

    def to_dict(self) -> dict[str, Any]:
        s = self.state
        return {"m": np.asarray(s.m).tolist(), "P": np.asarray(s.P).tolist(), "shadow": np.asarray(s.shadow).tolist(),
                "cusum": float(s.cusum), "rejects": int(s.rejects), "stress": self.stress}

    @classmethod
    def from_dict(cls, d: dict[str, Any], params: ModelParams, cfg: UKFConfig = UKFConfig()) -> "UKFTwinStream":
        obj = cls(params, d["m"][G], cfg)
        obj.state = FilterState(jnp.array(d["m"]), jnp.array(d["P"]), jnp.array(d["shadow"]),
                                jnp.array(d["cusum"]), jnp.array(d["rejects"]))
        obj.stress = d["stress"]
        return obj


def twin_state_dict(out: dict[str, np.ndarray], p: ModelParams) -> dict[str, Any]:
    """Map one filter output to the fields the PR-TFT and the v1 contract use."""
    m, sd = out["mean"], out["sd"]
    return {
        "plasma_glucose_mg_dl": float(m[G]), "plasma_glucose_sd": float(sd[G]),
        "interstitial_glucose_mg_dl": float(m[GISF]),
        "insulin_action_per_min": float(m[X]), "plasma_insulin_uU_ml": float(m[I]),
        "insulin_sensitivity_rel": float(p.si / gen.SI_REF * math.exp(float(m[TH_SI]))),
        "egp_multiplier": float(math.exp(float(m[TH_EGP]))),
        "gut_carbs_g": float((m[Q1] + m[Q2]) / 1000.0),
        "carbs_on_board_g": float((m[Q1] + m[Q2]) / 1000.0),
        "exercise_state_y": float(m[Y]), "sensitivity_boost_z": float(m[Z]),
        "sensor_bias_mg_dl": float(m[BIAS]), "sensor_noise_mg_dl": float(m[V1]),
        "cgm_innovation_mg_dl": float(out["innovation"]), "nis": float(out["nis"]),
        "reading_rejected": bool(out["gated"]),
        "unannounced_meal": {"alarm": bool(out["unlogged_meal_alarm"]), "cusum": float(out["cusum"]),
                             "estimated_carbs_g": float(out["unlogged_carbs_g"])},
    }


# --------------------------------------------------------------------------- #
# Cohort helpers and validation
# --------------------------------------------------------------------------- #


@dataclass
class PatientData:
    pid: str
    group: str
    stamps: pd.DatetimeIndex
    obs: np.ndarray  # (T, 5)
    params: ModelParams
    cgm: np.ndarray
    truth_plasma: np.ndarray | None
    truth_isf: np.ndarray | None
    hr: np.ndarray | None = None
    steps: np.ndarray | None = None
    asleep: np.ndarray | None = None


def load_cohort(data_dir: str, include_type1: bool = False, limit: int = 0,
                log_corruption: bool = False, seed: int = 20260930) -> list[PatientData]:
    """Load a generator cohort. log_corruption turns the true carbs into a realistic meal log
    (missed meals, under-estimation, delays) exactly as train_pr_tft.py does."""
    rng = np.random.default_rng(seed)
    tele = pd.read_csv(f"{data_dir}/patient_cgm_telemetry.csv", parse_dates=["timestamp"])
    ehr = pd.read_csv(f"{data_dir}/patients_ehr.csv").set_index("patient_id")
    try:
        truth = pd.read_csv(f"{data_dir}/patient_cgm_truth.csv", parse_dates=["timestamp"])
        truth = {pid: g for pid, g in truth.groupby("patient_id")}
    except FileNotFoundError:
        truth = {}
    cohort = []
    for pid, g in tele.groupby("patient_id", sort=True):
        row = ehr.loc[pid]
        if row["diabetes_status"] == "Type 1" and not include_type1:
            continue  # no bolus-insulin log to drive the exogenous insulin input
        g = g.sort_values("timestamp")
        stamps = pd.DatetimeIndex(g["timestamp"])
        hr, steps = g["heart_rate"].to_numpy(float), g["step_count"].to_numpy(float)
        asleep = (g["sleep_stage"] != "Awake").to_numpy()
        hr_rest = estimate_hr_rest(hr, steps, asleep)
        cgm = g["glucose_level"].to_numpy(float)
        carbs = g["carbs_g"].fillna(0).to_numpy(float)
        if log_corruption:
            import train_pr_tft as T  # same corruption model as training
            idx = np.flatnonzero(carbs > 0)
            minutes, logged = T.corrupt_meal_log(idx * float(STEP_MIN), carbs[idx], rng)
            carbs = np.zeros_like(carbs)
            bins = np.clip(np.round(minutes / STEP_MIN).astype(int), 0, carbs.size - 1)
            np.add.at(carbs, bins, logged)
        obs = build_inputs(stamps, cgm, hr, steps, asleep, carbs, hr_rest)
        t = truth.get(pid)
        cohort.append(PatientData(pid, row["diabetes_status"], stamps, obs, derive_params(row.to_dict(), hr_rest),
                                  cgm, None if t is None else t["plasma_glucose"].to_numpy(float),
                                  None if t is None else t["interstitial_glucose"].to_numpy(float),
                                  hr, steps, asleep))
        if limit and len(cohort) >= limit:
            break
    return cohort


def validate(data_dir: str, limit: int = 0, log_corruption: bool = False,
             cfg: UKFConfig = UKFConfig()) -> dict[str, Any]:
    """Filter the cohort and score it against the generator's ground truth."""
    cohort = load_cohort(data_dir, limit=limit, log_corruption=log_corruption)
    obs = jnp.asarray(np.stack([c.obs for c in cohort]))
    params = stack_params([c.params for c in cohort])
    t0 = time.perf_counter()
    _, out = filter_batch(obs, params, cfg)
    jax.block_until_ready(out["mean"])
    runtime = time.perf_counter() - t0
    mean = np.asarray(out["mean"])  # (P, T, n)
    T = mean.shape[1]
    steps = len(cohort) * T
    report: dict[str, Any] = {"patients": len(cohort), "steps": steps, "filter_seconds": round(runtime, 2),
                              "us_per_step": round(1e6 * runtime / steps, 1)}

    burn = 288  # first day: parameters still converging
    cgm = np.stack([c.cgm for c in cohort])[:, burn:]
    ok = np.isfinite(cgm)
    if cohort[0].truth_plasma is not None:
        plasma = np.stack([c.truth_plasma for c in cohort])[:, burn:]
        g_hat = mean[:, burn:, G]
        rmse = lambda a, b, m: float(np.sqrt(np.mean((a[m] - b[m]) ** 2)))
        mard = lambda a, b, m: float(np.mean(np.abs(a[m] - b[m]) / b[m]) * 100)
        report["plasma_tracking"] = {
            "raw_cgm_rmse": rmse(cgm, plasma, ok), "raw_cgm_mard_pct": mard(cgm, plasma, ok),
            "ukf_rmse": rmse(g_hat, plasma, ok), "ukf_mard_pct": mard(g_hat, plasma, ok),
            "ukf_rmse_during_cgm_gaps": rmse(g_hat, plasma, ~ok) if (~ok).any() else None,
        }
    nis = np.asarray(out["nis"])[:, burn:][ok]
    innov = np.asarray(out["innovation"])[:, burn:]
    S = np.asarray(out["S"])[:, burn:]
    zn = np.where(ok, innov / np.sqrt(S), np.nan)
    lag1 = np.nanmean([pd.Series(z).autocorr(1) for z in zn])
    report["consistency"] = {"mean_nis": float(nis.mean()), "gated_pct": float(np.asarray(out["gated"])[:, burn:].mean() * 100),
                             "innovation_lag1_autocorr": float(lag1)}
    theta = mean[:, -1, [TH_SI, TH_EGP]]
    report["theta_final"] = {"theta_si_median": float(np.median(theta[:, 0])),
                             "theta_egp_median": float(np.median(theta[:, 1]))}

    # 30/60/120-min forecasts from filtered means (no future meals or activity) vs persistence.
    anchors = np.arange(burn, T - HORIZON, 3)
    errs = {"ukf": [], "persistence": []}
    for i, c in enumerate(cohort):
        x0 = jnp.asarray(mean[i, anchors])
        fut = jnp.asarray(np.stack([future_inputs(c.obs[a, 3], stress0=c.obs[a, 2]) for a in anchors]))
        paths = np.asarray(rollout_many(x0, c.params, fut))
        pred = paths[:, :, GISF] + paths[:, :, BIAS] + paths[:, :, V1]
        target = c.cgm[anchors[:, None] + np.arange(1, HORIZON + 1)[None, :]]
        last = pd.Series(c.cgm).ffill().to_numpy()[anchors]
        errs["ukf"].append(pred - target)
        errs["persistence"].append(last[:, None] - target)
    report["forecast_rmse_mg_dl"] = {}
    for name, e in errs.items():
        e = np.concatenate(e)
        report["forecast_rmse_mg_dl"][name] = {f"{m}min": float(np.sqrt(np.nanmean(e[:, m // 5 - 1] ** 2))) for m in (30, 60, 120)}
    return report


# --------------------------------------------------------------------------- #
# PR-TFT integration: drop-in replacement for train_pr_tft.TwinPrior
# --------------------------------------------------------------------------- #

UKF_PAST_FEATURES = ("ukf_insulin_action", "ukf_plasma_insulin", "ukf_gut_glucose", "ukf_sensitivity_boost",
                     "ukf_theta_si", "ukf_theta_egp", "ukf_innovation_z", "ukf_unlogged_carbs")

_filter_one = jax.jit(filter_series, static_argnums=2)


class UKFTwinPrior:
    """The UKF twin behind the TwinPrior interface used by train_pr_tft.py and serve_pr_tft.py.

    forecast(ps, t_idx, habit_carbs, extra_flux) rolls the *filtered* state at each anchor
    forward 120 min; the filtered state at t uses observations up to t only, so it is causal.
    Filter runs are cached per (patient, meal log), because the service re-runs the twin
    with the meal log removed to compute drivers.
    """

    kind = "ukf"

    def __init__(self, cfg: UKFConfig = UKFConfig()):
        self.cfg = cfg
        self._cache: dict[tuple, dict[str, Any]] = {}

    # -- PatientSeries (train_pr_tft) -> filter inputs -------------------------
    def _run(self, ps) -> dict[str, Any]:
        key = (ps.pid, ps.meal_min.tobytes(), ps.meal_carbs.tobytes(), ps.n)
        hit = self._cache.get(key)
        if hit is not None:
            return hit
        sr = ps.static_raw
        status = next((s for s in ("Type 1", "Type 2", "Prediabetes", "Healthy") if sr.get(f"status_{s}", 0) > 0), "Healthy")
        meds = ";".join(m for m in ("metformin", "sglt2i", "glp1_ra", "dpp4i", "sulfonylurea", "basal_insulin",
                                     "prandial_insulin") if sr.get(f"med_{m}", 0) > 0)
        ehr = {**sr, "diabetes_status": status, "med_classes": meds}
        asleep = ps.asleep.astype(bool)
        hr_rest = estimate_hr_rest(ps.hr, ps.steps, asleep)
        params = derive_params(ehr, hr_rest)
        carbs = np.zeros(ps.n)
        bins = np.clip(np.round(ps.meal_min / STEP_MIN).astype(int), 0, ps.n - 1)
        np.add.at(carbs, bins, ps.meal_carbs)
        obs = build_inputs(ps.stamps, ps.cgm, ps.hr, ps.steps, asleep, carbs, hr_rest)
        _, out = _filter_one(jnp.asarray(obs), params, self.cfg)
        res = {"params": params, "obs": obs, "mean": np.asarray(out["mean"]),
               "innov_z": np.asarray(out["innovation"] / jnp.sqrt(out["S"])),
               "unlogged": np.asarray(out["unlogged_carbs_g"])}
        if len(self._cache) > 512:
            self._cache.clear()
        self._cache[key] = res
        return res

    # -- TwinPrior interface --------------------------------------------------
    def fit(self, series, anchors, rng, max_anchors: int = 4000) -> None:
        LOG.info("UKF twin: no global fit needed; filtering %d training patients", len(series))
        for ps in series:
            self._run(ps)

    def describe(self) -> dict[str, Any]:
        return {"kind": "ukf", **self.cfg._asdict()}

    def meal_effect_series(self, ps) -> np.ndarray:
        """Glucose (mg/dL) still to appear from the filtered gut: F * (Q1 + Q2) / V_G."""
        r = self._run(ps)
        return gen.F_BIO * (r["mean"][:, Q1] + r["mean"][:, Q2]) / r["params"].vg

    def forecast(self, ps, t_idx: np.ndarray, habit_carbs: np.ndarray | None = None,
                 extra_flux: np.ndarray | None = None) -> np.ndarray:
        r = self._run(ps)
        obs, p = r["obs"], r["params"]
        futs = []
        for a, t in enumerate(t_idx):
            meals = np.zeros(HORIZON)
            if habit_carbs is not None:  # TwinPrior convention: bin j starts at +5(j+1) min
                meals[1:] = habit_carbs[a, :-1]
            flux = None if extra_flux is None else extra_flux[a].reshape(HORIZON, STEP_MIN).mean(1)
            futs.append(future_inputs(obs[t, 3], meals, None, obs[t, 2], flux))
        paths = np.asarray(rollout_many(jnp.asarray(r["mean"][t_idx]), p, jnp.asarray(np.stack(futs))))
        cgm = paths[:, :, GISF] + paths[:, :, BIAS] + paths[:, :, V1]
        return np.clip(cgm, 40.0, 400.0)

    def forecast_without_gut(self, ps, t_idx: np.ndarray) -> np.ndarray:
        """Counterfactual for the 'meals still absorbing' driver: the same filtered state at
        each anchor with the gut emptied (Q1 = Q2 = 0), rolled out with no new meals.
        Re-filtering without the meal log would rewrite the whole state history instead."""
        r = self._run(ps)
        obs, p = r["obs"], r["params"]
        x0 = r["mean"][t_idx].copy()
        x0[:, [Q1, Q2]] = 0.0
        futs = np.stack([future_inputs(obs[t, 3], None, None, obs[t, 2]) for t in t_idx])
        paths = np.asarray(rollout_many(jnp.asarray(x0), p, jnp.asarray(futs)))
        return np.clip(paths[:, :, GISF] + paths[:, :, BIAS] + paths[:, :, V1], 40.0, 400.0)

    def state_features(self, ps) -> dict[str, np.ndarray]:
        """Filtered latent states as extra PR-TFT past inputs (Blueprint 6.1 'twin-derived past')."""
        r = self._run(ps)
        m, p = r["mean"], r["params"]
        return {
            "ukf_insulin_action": m[:, X] / p.xb,
            "ukf_plasma_insulin": m[:, I],
            "ukf_gut_glucose": gen.F_BIO * (m[:, Q1] + m[:, Q2]) / p.vg,
            "ukf_sensitivity_boost": m[:, Z],
            "ukf_theta_si": m[:, TH_SI],
            "ukf_theta_egp": m[:, TH_EGP],
            "ukf_innovation_z": np.clip(np.nan_to_num(r["innov_z"]), -6, 6),
            "ukf_unlogged_carbs": r["unlogged"],
        }


def main() -> None:
    ap = argparse.ArgumentParser(description="UKF twin state estimator (Blueprint 7.2).")
    sub = ap.add_subparsers(dest="cmd", required=True)
    v = sub.add_parser("validate")
    v.add_argument("--data-dir", default="synthetic_v2")
    v.add_argument("--limit", type=int, default=0)
    v.add_argument("--log-corruption", action="store_true", help="validate against an imperfect meal log")
    s = sub.add_parser("stream-demo")
    s.add_argument("--data-dir", default="synthetic_v2")
    args = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    if args.cmd == "validate":
        print(json.dumps(validate(args.data_dir, args.limit, args.log_corruption), indent=2))
    else:
        c = load_cohort(args.data_dir, limit=1)[0]
        twin = UKFTwinStream(c.params, first_cgm=float(c.cgm[np.isfinite(c.cgm)][0]))
        for k in range(12 * 24):  # one day of 5-min readings
            o = c.obs[k]
            state = twin.update(None if not np.isfinite(o[0]) else float(o[0]), hr=float(c.hr[k]),
                                steps=float(c.steps[k]), asleep=bool(c.asleep[k]),
                                meal_carbs_g=float(o[4] / 1000), hour=float(o[3]))
        fc = twin.forecast(hour0=float(c.obs[287, 3]))
        print(json.dumps({"patient": c.pid, "twin_state": state,
                          "forecast_cgm_mean_60_120": [round(float(fc["cgm_mean"][11]), 1), round(float(fc["cgm_mean"][23]), 1)],
                          "forecast_cgm_sd_60_120": [round(float(fc["cgm_sd"][11]), 1), round(float(fc["cgm_sd"][23]), 1)],
                          "serialized_bytes": len(json.dumps(twin.to_dict()))}, indent=2))


if __name__ == "__main__":
    main()
