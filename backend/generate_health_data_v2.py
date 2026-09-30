#!/usr/bin/env python3
"""Synthetic T2D digital-twin data generator (Blueprint Section 3).

Replaces the heuristic generate_health_data.py with the blueprint's mechanistic
model, so the cohort can pass the Section 5 validation gates.

Pipeline per patient
  1. EHR -> glycemic target: mean glucose mu_G = 28.7 * HbA1c - 46.7 + glycation gap
     (ADAG), which fixes the ADAG slope by construction.
  2. EHR -> latent physiology: insulin sensitivity, beta-cell function, volumes,
     clearance, gut absorption time, circadian amplitudes, medication effects.
  3. Behavior generator: meals (carbs, fat, protein, fiber, glycemic index),
     walking bouts, sleep, acute stress and illness episodes.
  4. ODE model integrated at 1 min (Bergman insulin action, Dalla Man secretion
     and renal excretion, Hovorka two-compartment gut, Breton exercise terms,
     first-order plasma-to-interstitial lag).
  5. Calibration: basal glucose is solved per patient so the simulated mean
     plasma glucose equals mu_G within 1 mg/dL. Type 2 twins whose CV falls
     outside 16-38% are redrawn and re-simulated (Blueprint 3.6 step 4).
  6. Sensor model: calibration drift, AR(2) Johnson-SU noise, day-1 bias,
     compression lows, dropouts, warm-up gaps, integer rounding, 40-400 range.

Outputs (--out-dir)
  patients_ehr.csv            static EHR plus the derived physiology
  patient_cgm_telemetry.csv   5-min stream: glucose_level, heart_rate, hrv,
                              sleep_stage, step_count, meal_event, carbs_g,
                              future_spike_2h
  patient_cgm_truth.csv       (--write-truth) plasma and interstitial glucose

Meal timing: gut appearance Ra(t) = f * D * t / t_max^2 * exp(-t / t_max) peaks
at t_max, and plasma glucose peaks later, where appearance falls to meet
uptake. With t_max,0 ~ N(38, 5) min scaled by fat, protein, fiber and glycemic
index, CGM time-to-peak lands at a cohort median inside 60-90 min.

Usage
  python generate_health_data_v2.py --patients 50 --days 14 --out-dir synthetic_v2
"""

from __future__ import annotations

import argparse
import dataclasses
import logging
import math
import time
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pandas as pd

LOG = logging.getLogger("generate_v2")

ADAG_SLOPE, ADAG_INTERCEPT = 28.7, -46.7
DT_MIN = 1.0  # integration step, minutes
SAMPLE_MIN = 5  # CGM and wearable output interval
START = pd.Timestamp("2026-09-28")  # a Monday, so weekday effects are deterministic

# Model constants (Blueprint 3.2-3.3)
P2 = 0.025  # 1/min, insulin action rate
SI_REF = 5e-4  # 1/min per uU/mL, healthy insulin sensitivity
N_CLEAR = 0.15  # 1/min, plasma insulin clearance
ALPHA_SEC = 0.05  # 1/min, static secretion rate
BETA_REF = 5.0  # uU/min per mg/dL per kg, static secretion gain
K_REF = 25.0  # uU per mg/dL per kg, first-phase gain
K_H = 0.6  # hepatic suppression by insulin action
F_BIO = 0.85  # carbohydrate bioavailability
KE1 = 0.0005  # 1/min, renal excretion (Dalla Man 2007)
G_RENAL = 180.0  # mg/dL renal threshold
KE1_SGLT2, G_RENAL_SGLT2 = 0.004, 70.0  # ~60-80 g/day glucosuria
TAU_HR, TAU_Z = 5.0, 600.0  # exercise states
ALPHA_EX, BETA_EX = 6.7e-5, 0.3  # insulin-independent uptake, sensitivity boost
TAU_STRESS = 45.0  # stress hormone kinetics, min
CV_ACCEPT_PCT = (16.0, 38.0)  # Blueprint 3.6 step 4, on plasma CV (sensor noise adds ~1-2 points)
MAX_RESAMPLE_ROUNDS = 6


# --------------------------------------------------------------------------- #
# EHR
# --------------------------------------------------------------------------- #


def generate_ehr(n: int, rng: np.random.Generator) -> pd.DataFrame:
    age = np.clip(rng.normal(55, 15, n).astype(int), 18, 90)
    gender = rng.choice(["M", "F"], n)
    bmi = np.clip(rng.normal(28, 5, n), 18, 45)
    genetic = rng.beta(2, 5, n)
    hba1c = np.clip(5.0 + (bmi - 25) * 0.08 + genetic * 2.5 + rng.normal(0, 0.4, n), 4.0, 14.0).round(1)
    status = np.where(hba1c >= 6.5, np.where(rng.random(n) < 0.9, "Type 2", "Type 1"),
                      np.where(hba1c >= 5.7, "Prediabetes", "Healthy"))
    height = rng.normal(np.where(gender == "M", 176, 162), 7)
    weight = bmi * (height / 100) ** 2
    egfr = np.clip(rng.normal(105 - 0.8 * (age - 30), 12), 15, 130)
    duration = np.where(np.isin(status, ["Type 2", "Type 1"]),
                        np.clip(rng.normal(3 + 0.3 * np.maximum(age - 45, 1), 3), 0.5, np.maximum(age - 18, 1)),
                        0.0)
    meds = []
    for s in status:
        m = []
        if s == "Type 2":
            m += ["metformin"] if rng.random() < 0.85 else []
            m += ["sglt2i"] if rng.random() < 0.25 else []
            m += ["glp1_ra"] if rng.random() < 0.20 else []
            m += ["dpp4i"] if "glp1_ra" not in m and rng.random() < 0.15 else []
            m += ["sulfonylurea"] if rng.random() < 0.10 else []
        elif s == "Type 1":
            m += ["basal_insulin", "prandial_insulin"]
        elif s == "Prediabetes" and rng.random() < 0.15:
            m += ["metformin"]
        meds.append(";".join(m))
    return pd.DataFrame({
        "patient_id": [f"P{i + 1:04d}" for i in range(n)],
        "age": age, "gender": gender, "bmi": bmi.round(1),
        "genetic_risk_score": genetic.round(3), "hba1c": hba1c, "diabetes_status": status,
        "height_cm": height.round(1), "weight_kg": weight.round(1), "egfr": egfr.round(0),
        "diabetes_duration_years": np.round(duration, 1), "med_classes": meds,
    })


# --------------------------------------------------------------------------- #
# Physiology (Blueprint 3.1-3.2, 3.5)
# --------------------------------------------------------------------------- #


@dataclass
class Physiology:
    mu: np.ndarray  # target mean glucose, mg/dL
    gb0: np.ndarray  # Monnier-based starting basal glucose
    vg: np.ndarray  # dL
    vi: np.ndarray  # mL
    bw: np.ndarray
    si: np.ndarray  # 1/min per uU/mL
    sg: np.ndarray
    ib: np.ndarray  # basal insulin, uU/mL
    beta: np.ndarray  # uU/min per mg/dL
    k1: np.ndarray  # first-phase gain
    m_clr: np.ndarray
    tmax0: np.ndarray
    tau_isf: np.ndarray
    a_dawn: np.ndarray
    a_circ: np.ndarray
    egp_med: np.ndarray
    ke1: np.ndarray
    g_thr: np.ndarray
    tmax_med: np.ndarray
    carb_med: np.ndarray
    su_gain: np.ndarray  # glucose-independent secretion, uU/min
    insulin_user: np.ndarray
    hr_rest: np.ndarray
    ln_rmssd: np.ndarray


def derive_physiology(ehr: pd.DataFrame, rng: np.random.Generator) -> Physiology:
    n = len(ehr)
    a1c = ehr["hba1c"].to_numpy(float)
    age = ehr["age"].to_numpy(float)
    bmi = ehr["bmi"].to_numpy(float)
    bw = ehr["weight_kg"].to_numpy(float)
    dur = ehr["diabetes_duration_years"].to_numpy(float)
    egfr = ehr["egfr"].to_numpy(float)
    status = ehr["diabetes_status"].to_numpy()
    meds = [set(m.split(";")) - {""} for m in ehr["med_classes"]]
    has = lambda name: np.array([name in m for m in meds])
    t2d, t1d, pre = status == "Type 2", status == "Type 1", status == "Prediabetes"

    mu = np.maximum(ADAG_SLOPE * a1c + ADAG_INTERCEPT + rng.normal(0, 12, n), 75.0)
    w_pp = np.clip(0.70 - 0.135 * (a1c - 7.3), 0.30, 0.70)
    gb0 = np.where(mu > 110, 110 + (1 - w_pp) * (mu - 110), mu - 8)

    ln_si = -0.035 * (bmi - 25) - 0.005 * (age - 45) - 0.40 * t2d - 0.20 * pre + rng.normal(0, 0.25, n)
    si_rel = np.clip(np.exp(ln_si), 0.15, 1.2) * np.where(has("metformin"), 1.10, 1.0)
    ln_beta = -0.20 * t2d - 0.10 * pre - 0.05 * dur + rng.normal(0, 0.30, n)
    beta_rel = np.where(t1d, 0.02, np.clip(np.exp(ln_beta), 0.1, 1.2))
    m_beta = np.where(has("glp1_ra"), 1.6, np.where(has("dpp4i"), 1.2, 1.0))
    k_rel = np.where(t2d | t1d, 0.3, 1.0) * beta_rel
    ib = np.where(t1d, 10.0, np.clip(8.0 / np.sqrt(si_rel), 5, 30))  # compensatory hyperinsulinemia
    sglt2 = has("sglt2i")

    return Physiology(
        mu=mu, gb0=gb0, vg=1.88 * bw, vi=50.0 * bw, bw=bw,
        si=SI_REF * si_rel, sg=np.clip(rng.normal(0.012, 0.003, n), 0.005, 0.02), ib=ib,
        beta=BETA_REF * bw * beta_rel * m_beta, k1=K_REF * bw * k_rel,
        m_clr=0.7 + 0.3 * np.minimum(egfr / 90, 1),
        tmax0=np.clip(rng.normal(38, 5, n), 26, 55),
        tau_isf=np.clip(rng.normal(8, 2, n), 4, 15),
        a_dawn=rng.uniform(0.05, 0.25, n) * np.where(t2d | t1d, 1.0, 0.4),
        a_circ=rng.uniform(0.05, 0.20, n),
        egp_med=np.where(has("metformin"), 0.75, 1.0) * np.where(has("glp1_ra"), 0.9, 1.0)
        * np.where(has("dpp4i"), 0.95, 1.0),
        ke1=np.where(sglt2, KE1_SGLT2, KE1) * egfr / 100, g_thr=np.where(sglt2, G_RENAL_SGLT2, G_RENAL),
        tmax_med=np.where(has("glp1_ra"), 1.3, 1.0), carb_med=np.where(has("glp1_ra"), 0.8, 1.0),
        su_gain=np.where(has("sulfonylurea"), 0.4 * N_CLEAR * 50.0 * bw * ib, 0.0),
        insulin_user=has("prandial_insulin"),
        hr_rest=rng.normal(64 + 0.3 * (bmi - 25), 6),
        ln_rmssd=rng.normal(3.3 - 0.02 * (age - 50) - 0.02 * dur, 0.3),
    )


# --------------------------------------------------------------------------- #
# Behavior (Blueprint 3.4) -> per-minute input arrays
# --------------------------------------------------------------------------- #


@dataclass
class Inputs:
    ra: np.ndarray  # (T, P) gut appearance, mg/min
    r_exo: np.ndarray  # (T, P) exogenous + sulfonylurea insulin, uU/min
    dhr_ex: np.ndarray  # (T, P) exercise heart-rate rise, bpm
    stress: np.ndarray  # (T, P) acute stress on/off
    si_mod: np.ndarray  # (T, P) circadian x sleep x illness multiplier on S_I
    egp_mod: np.ndarray  # (T, P) dawn x illness multiplier on EGP
    hr: np.ndarray  # (T, P) heart rate, bpm
    rmssd: np.ndarray  # (T, P) HRV, ms
    steps: np.ndarray  # (T, P) steps per minute
    stage: np.ndarray  # (T, P) sleep stage code 0 awake, 1 light, 2 deep, 3 REM
    meals: pd.DataFrame  # patient_id, minute, carbs_g, fat_g, protein_g, fiber_g, t_max


def gamma2_kernel(t: np.ndarray, tau: float) -> np.ndarray:
    """Impulse response of two equal first-order compartments (Hovorka gut / SC insulin)."""
    return np.where(t >= 0, t / tau**2 * np.exp(-np.clip(t, 0, None) / tau), 0.0)


def mifflin_kcal(weight, height, age, male):
    return 10 * weight + 6.25 * height - 5 * age + np.where(male, 5, -161)


def generate_inputs(ehr: pd.DataFrame, phys: Physiology, days: int,
                    rng: np.random.Generator) -> Inputs:
    T, P = days * 1440, len(ehr)
    minute = np.arange(T)
    clock = (minute % 1440) / 60.0
    day_idx = minute // 1440
    weekday = (START.dayofweek + day_idx) % 7
    ra = np.zeros((T, P)); r_exo = np.zeros((T, P)); dhr = np.zeros((T, P)); stress = np.zeros((T, P))
    si_mod = np.ones((T, P)); egp_mod = np.ones((T, P)); post_hr = np.zeros((T, P))
    steps = np.zeros((T, P)); stage = np.zeros((T, P), dtype=np.int8)
    meal_rows = []
    kernel_t = np.arange(0, 480, dtype=float)

    male = (ehr["gender"] == "M").to_numpy()
    kcal = mifflin_kcal(ehr["weight_kg"].to_numpy(), ehr["height_cm"].to_numpy(),
                        ehr["age"].to_numpy(), male) * rng.uniform(1.35, 1.65, P)
    daily_carbs = kcal * rng.uniform(0.35, 0.50, P) / 4.0 * phys.carb_med
    anchors = np.column_stack([rng.normal(7.5, 0.75, P), rng.normal(12.75, 0.5, P), rng.normal(19.25, 0.6, P)])
    p_skip_bf = rng.uniform(0.05, 0.25, P)
    p_walk = rng.uniform(0.0, 0.4, P)
    target_steps = np.clip(rng.normal(7000 - 150 * (ehr["bmi"].to_numpy() - 25) - 40 * (ehr["age"].to_numpy() - 50), 1500), 1500, 15000)
    icr = rng.uniform(8, 15, P)  # g carbs per unit, insulin users

    for p in range(P):
        pid = ehr["patient_id"].iat[p]
        # ---- sleep: onset ~ N(23:00, 45 min), duration ~ N(7.0, 0.9) h, 10% short nights
        asleep = np.zeros(T, dtype=bool)
        short_night_days = []
        onset_anchor = rng.normal(23.0, 0.75)
        for d in range(-1, days):
            onset = d * 1440 + 60 * (onset_anchor + rng.normal(0, 0.33))
            hours = rng.uniform(4.5, 5.9) if rng.random() < 0.10 else rng.normal(7.0, 0.9)
            s0, s1 = int(max(onset, 0)), int(min(onset + 60 * max(hours, 3.5), T))
            if s1 > s0:
                asleep[s0:s1] = True
                if hours < 6.0 and d + 1 < days:
                    short_night_days.append(d + 1)
                # ~90-min cycles: deep early, REM late
                phase = (np.arange(s1 - s0) % 90) / 90.0
                cycle = np.arange(s1 - s0) // 90
                st = np.where(phase < 0.45, 1, np.where(phase < 0.75, np.where(cycle < 2, 2, 1), 3))
                flip = rng.random(s1 - s0) < 0.08
                st = np.where(flip, rng.integers(1, 4, s1 - s0), st)
                stage[s0:s1, p] = st
        for d in short_night_days:
            day = (day_idx == d) & ~asleep
            si_mod[day, p] *= 0.85

        # ---- meals (Blueprint 3.4)
        for d in range(days):
            shift = 1.0 if weekday[d * 1440] >= 5 else 0.0
            split = rng.dirichlet(20 * np.array([0.25, 0.30, 0.35, 0.10]))
            times, shares = [], []
            for k in range(3):
                if k == 0 and rng.random() < p_skip_bf[p]:
                    continue
                times.append(anchors[p, k] + shift * (k == 0) + rng.normal(0, 25 / 60))
                shares.append(split[k])
            n_snacks = rng.poisson(1.2)
            for _ in range(n_snacks):
                times.append(rng.uniform(10.0, 21.5))
                shares.append(split[3] / max(n_snacks, 1))
            for h, share in zip(times, shares):
                t0 = int(round(d * 1440 + 60 * h))
                if not 0 <= t0 < T:
                    continue
                carbs = float(np.clip(daily_carbs[p] * share * rng.lognormal(0, 0.35), 5, 200))
                fat = carbs * rng.uniform(0.2, 0.6)
                protein = carbs * rng.uniform(0.2, 0.5)
                fiber = rng.uniform(2, 10) * min(carbs / 50, 1.5)
                g_gi = rng.choice([0.8, 1.0, 1.3], p=[0.3, 0.5, 0.2])
                t_max = phys.tmax0[p] * (1 + 0.006 * fat + 0.003 * protein + 0.01 * fiber) * g_gi * phys.tmax_med[p]
                span = slice(t0, min(T, t0 + kernel_t.size))
                ra[span, p] += F_BIO * carbs * 1000 * gamma2_kernel(kernel_t[: span.stop - t0], t_max)
                post_hr[span, p] += np.clip(carbs / 20, 0.5, 3) * 2 * np.exp(-kernel_t[: span.stop - t0] / 60)
                meal_rows.append((pid, t0, carbs, fat, protein, fiber, t_max))
                if phys.insulin_user[p]:  # prandial bolus: dose and timing errors
                    dose = carbs / icr[p] * rng.lognormal(0, 0.2)
                    tb = int(np.clip(t0 + rng.normal(0, 10), 0, T - 1))
                    bspan = slice(tb, min(T, tb + kernel_t.size))
                    r_exo[bspan, p] += dose * 1e6 * gamma2_kernel(kernel_t[: bspan.stop - tb], 55.0)
                if rng.random() < p_walk[p] and h > 11:  # post-meal walk
                    w0 = t0 + int(rng.uniform(15, 45))
                    w1 = min(T, w0 + int(rng.uniform(15, 30)))
                    steps[w0:w1, p] = rng.uniform(95, 120)

        # ---- walking bouts toward the daily step target
        awake = ~asleep
        for d in range(days):
            day_awake = np.flatnonzero(awake & (day_idx == d))
            if day_awake.size == 0:
                continue
            remaining = target_steps[p] * rng.lognormal(0, 0.25) - steps[day_idx == d, p].sum()
            while remaining > 0:
                w0 = int(rng.choice(day_awake))
                length = int(rng.uniform(5, 25))
                cadence = rng.uniform(90, 120)
                steps[w0:min(T, w0 + length), p] = np.where(asleep[w0:w0 + length], 0, cadence)
                remaining -= cadence * length
            idle = awake & (day_idx == d) & (steps[:, p] == 0)
            steps[idle, p] = rng.poisson(4, idle.sum()) * (rng.random(idle.sum()) < 0.3)
        dhr[:, p] = np.where(steps[:, p] > 60, 0.3 * steps[:, p], 0.0)

        # ---- acute stress (~1.5 episodes per waking day, 20-40 min)
        for _ in range(rng.poisson(1.5 * days)):
            s0 = int(rng.choice(np.flatnonzero(awake)))
            stress[s0:min(T, s0 + int(rng.uniform(20, 40))), p] = 1.0
        # ---- illness episode (10% of patients, 2-4 days): stress hyperglycemia
        if rng.random() < 0.10:
            i0 = int(rng.integers(0, max(1, days - 4))) * 1440
            span = slice(i0, min(T, i0 + int(rng.uniform(2, 4) * 1440)))
            egp_mod[span, p] *= 1.3
            si_mod[span, p] *= 0.7
        # ---- sulfonylurea: morning dose, glucose-independent secretion peaking 2-4 h
        if phys.su_gain[p] > 0:
            for d in range(days):
                t0 = d * 1440 + int(60 * rng.normal(8.0, 0.3))
                span = slice(t0, min(T, t0 + kernel_t.size))
                r_exo[span, p] += phys.su_gain[p] * 180 * gamma2_kernel(kernel_t[: span.stop - t0], 180.0) * math.e

    # circadian S_I (peak 08:00, worse glucose tolerance in the evening) and dawn EGP rise
    si_mod *= 1 + phys.a_circ[None, :] * np.cos(2 * np.pi * (clock[:, None] - 8) / 24)
    egp_mod *= 1 + phys.a_dawn[None, :] * np.exp(-((clock[:, None] - 5.5) ** 2) / (2 * 1.2**2))

    circ_hr = -4 * np.cos(2 * np.pi * (clock[:, None] - 16) / 24)  # trough ~04:00
    hr = (phys.hr_rest[None, :] + circ_hr - 8 * (stage > 0) + dhr + 20 * stress + post_hr
          + rng.normal(0, 3, (T, P)))
    ln_rmssd = (phys.ln_rmssd[None, :] - 0.01 * dhr + 0.3 * (stage == 2) + 0.15 * (stage > 0)
                - 0.5 * stress + rng.normal(0, 0.1, (T, P)))
    meals = pd.DataFrame(meal_rows, columns=["patient_id", "minute", "carbs_g", "fat_g", "protein_g",
                                             "fiber_g", "t_max"])
    return Inputs(ra, r_exo, dhr, stress, si_mod, egp_mod, np.maximum(hr, 40), np.exp(ln_rmssd),
                  steps, stage, meals)


# --------------------------------------------------------------------------- #
# ODE model (Blueprint 3.3), vectorized across patients
# --------------------------------------------------------------------------- #


def simulate(phys: Physiology, inp: Inputs, gb: np.ndarray, record: bool = False):
    """Euler integration at 1 min. Returns mean plasma glucose, and if record is
    set the per-minute plasma and interstitial glucose (T, P)."""
    T, P = inp.ra.shape
    xb = phys.si * phys.ib
    e_b = phys.ke1 * phys.vg * np.maximum(gb - phys.g_thr, 0)
    egp_b = phys.vg * gb * (phys.sg + xb) + e_b  # closed-form basal steady state
    G, X, I, Ss = gb.copy(), xb.copy(), phys.ib.copy(), np.zeros(P)
    Gi, Y, Z, Sh = gb.copy(), np.zeros(P), np.zeros(P), np.zeros(P)
    dG_prev = np.zeros(P)
    total = np.zeros(P)
    g_out = np.empty((T, P)) if record else None
    gi_out = np.empty((T, P)) if record else None
    half_hr = 0.5 * phys.hr_rest
    for t in range(T):
        f_y = (Y / half_hr) ** 4
        f_y = f_y / (1 + f_y)
        si_t = phys.si * inp.si_mod[t] * (1 - 0.3 * Sh) * (1 + BETA_EX * Z)
        egp = (egp_b * phys.egp_med * inp.egp_mod[t] * (1 + 0.5 * Sh)
               * np.exp(-K_H * (X - xb) / xb))
        e_ren = phys.ke1 * phys.vg * np.maximum(G - phys.g_thr, 0)
        u_ex = ALPHA_EX * Y * G * phys.vg
        dG = -(phys.sg + X) * G + (egp + inp.ra[t] - e_ren - u_ex) / phys.vg
        dX = P2 * (si_t * I - X)
        dSs = -ALPHA_SEC * (Ss - phys.beta * np.maximum(G - gb, 0))
        s_d = phys.k1 * np.maximum(dG_prev, 0)
        dI = -N_CLEAR * phys.m_clr * (I - phys.ib) + (Ss + s_d + inp.r_exo[t]) / phys.vi
        G = np.maximum(G + DT_MIN * dG, 20.0)
        X = np.maximum(X + DT_MIN * dX, 1e-6)
        Ss = Ss + DT_MIN * dSs
        I = np.maximum(I + DT_MIN * dI, 0.0)
        Y = Y + DT_MIN * (inp.dhr_ex[t] - Y) / TAU_HR
        Z = Z + DT_MIN * (-(f_y + 1 / TAU_Z) * Z + f_y)
        Sh = Sh + DT_MIN * (inp.stress[t] - Sh) / TAU_STRESS
        Gi = Gi + DT_MIN * (G - Gi) / phys.tau_isf
        dG_prev = dG
        total += G
        if record:
            g_out[t] = G
            gi_out[t] = Gi
    return total / T, g_out, gi_out


def calibrate(phys: Physiology, inp: Inputs, max_iter: int = 8, tol: float = 1.0) -> np.ndarray:
    """Solve basal glucose per patient so simulated mean plasma glucose = mu_G (Blueprint 3.6)."""
    gb = phys.gb0.copy()
    for it in range(max_iter):
        mean, _, _ = simulate(phys, inp, gb)
        err = phys.mu - mean
        LOG.info("calibration %d: max |mean - mu_G| = %.2f mg/dL", it + 1, np.abs(err).max())
        if np.abs(err).max() < tol:
            break
        gb = np.clip(gb + 0.95 * err, 55.0, 400.0)
    stuck = np.abs(err) >= tol
    if stuck.any():
        LOG.warning("%d patients missed mu_G by >= %.1f mg/dL (basal floor reached)", stuck.sum(), tol)
    return gb


# --------------------------------------------------------------------------- #
# Sensor model (Blueprint 4.1) and labels
# --------------------------------------------------------------------------- #


def johnson_su(rng: np.random.Generator, size, delta: float = 1.6) -> np.ndarray:
    """Unit-variance symmetric Johnson SU draws (heavy-tailed)."""
    var = (math.exp(2 / delta**2) - 1) / 2
    return np.sinh(rng.normal(0, 1, size) / delta) / math.sqrt(var)


def sensor_stream(gi: np.ndarray, asleep: np.ndarray, rng: np.random.Generator) -> np.ndarray:
    """Observed 5-min CGM from interstitial glucose sampled at 5 min (NaN = no reading)."""
    n = gi.size
    per_day = 1440 // SAMPLE_MIN
    session = 10 * per_day
    offset = int(rng.integers(0, session))
    idx = np.arange(n)
    sess_id = (idx + offset) // session
    d = ((idx + offset) % session) / per_day
    cgm = np.empty(n)
    for s in np.unique(sess_id):
        m = sess_id == s
        a = rng.normal(1, 0.04) + rng.normal(0, 0.005) * d[m] + rng.normal(0, 0.0004) * d[m] ** 2
        b = rng.normal(0, 4) + rng.normal(0, 0.5) * d[m]
        day1 = d[m] < 1
        cgm[m] = a * gi[m] + b + day1 * rng.uniform(-10, 10)
    phi1, phi2, sd = 1.2, -0.4, 5.0
    unit = (1 - phi2) / ((1 + phi2) * ((1 - phi2) ** 2 - phi1**2))
    shocks = johnson_su(rng, n + 200) * sd / math.sqrt(unit)
    noise = np.zeros(n + 200)
    for k in range(2, n + 200):
        noise[k] = phi1 * noise[k - 1] + phi2 * noise[k - 2] + shocks[k]
    noise = noise[200:] * np.where(d < 1, 1.8, 1.0)
    cgm = cgm + noise
    # compression lows: 15% of nights, 30-70 mg/dL drop held 20-60 min
    for night_start in np.flatnonzero(np.diff(asleep.astype(int)) == 1):
        if rng.random() < 0.15:
            c0 = night_start + int(rng.integers(12, 60))
            if c0 >= n:
                continue
            hold = int(rng.integers(4, 13))
            depth = rng.uniform(30, 70)
            shape = np.concatenate([np.linspace(0, 1, 3), np.ones(hold), np.linspace(1, 0, 4)])
            span = slice(c0, min(n, c0 + shape.size))
            cgm[span] -= depth * shape[: span.stop - c0]
    missing = np.zeros(n, dtype=bool)
    for _ in range(rng.poisson(0.3 * n / per_day)):
        g0 = int(rng.integers(0, n))
        length = int(rng.integers(24, 73)) if rng.random() < 0.01 else int(rng.geometric(1 / 5))
        missing[g0:g0 + length] = True
    for s0 in np.flatnonzero(np.diff(sess_id) != 0) + 1:
        missing[s0:s0 + int(rng.uniform(30, 60) // SAMPLE_MIN)] = True
    cgm = np.clip(np.round(cgm), 40, 400)
    cgm[missing] = np.nan
    return cgm


def spike_labels(cgm: np.ndarray) -> np.ndarray:
    """future_spike_2h per Blueprint Section 1: onset = CGM >= 180, rise >= 50 mg/dL
    within 60 min, >= 180 for 15 min; refractory until < 160 for 30 min.
    Label is 1 when an onset falls in (t, t + 120 min]."""
    n = cgm.size
    onsets = np.zeros(n, dtype=bool)
    armed, below = True, 0
    for k in range(n):
        v = cgm[k]
        if np.isnan(v):
            continue
        below = below + 1 if v < 160 else 0
        if below >= 6:
            armed = True
        if armed and v >= 180 and k >= 12:
            prior = cgm[k - 12:k]
            persist = cgm[k:k + 3]
            if (np.isfinite(prior).any() and v - np.nanmin(prior) >= 50
                    and persist.size == 3 and np.all(persist >= 180)):
                onsets[k] = True
                armed = False
    ahead = 120 // SAMPLE_MIN
    csum = np.concatenate(([0], np.cumsum(onsets)))
    k = np.arange(n)
    return (csum[np.minimum(k + ahead + 1, n)] - csum[k + 1] > 0).astype(int)


# --------------------------------------------------------------------------- #
# Assembly
# --------------------------------------------------------------------------- #


STAGES = np.array(["Awake", "Light", "Deep", "REM"], dtype=object)


def build_telemetry(ehr, phys, inp, gi, g, rng, days):
    step = SAMPLE_MIN
    T, P = inp.ra.shape
    n5 = T // step
    stamps = START + pd.to_timedelta(np.arange(n5) * step, unit="min")
    frames, truth = [], []
    meals = inp.meals.assign(bin=inp.meals["minute"] // step)
    for p in range(P):
        pid = ehr["patient_id"].iat[p]
        gi5 = gi[::step, p]
        asleep5 = inp.stage[::step, p] > 0
        cgm = sensor_stream(gi5, asleep5, rng)
        pm = meals[meals["patient_id"] == pid].groupby("bin")["carbs_g"].sum()
        meal_event = np.zeros(n5, dtype=int)
        carbs = np.zeros(n5)
        meal_event[pm.index.to_numpy()] = 1
        carbs[pm.index.to_numpy()] = pm.to_numpy()
        frames.append(pd.DataFrame({
            "patient_id": pid,
            "timestamp": stamps,
            "glucose_level": cgm,
            "heart_rate": inp.hr[:, p].reshape(n5, step).mean(1).round(1),
            "hrv": inp.rmssd[:, p].reshape(n5, step).mean(1).round(1),
            "sleep_stage": STAGES[inp.stage[::step, p]],
            "step_count": inp.steps[:, p].reshape(n5, step).sum(1).round().astype(int),
            "meal_event": meal_event,
            "carbs_g": carbs.round(1),
            "future_spike_2h": spike_labels(cgm),
        }))
        truth.append(pd.DataFrame({"patient_id": pid, "timestamp": stamps,
                                   "plasma_glucose": g[::step, p].round(2),
                                   "interstitial_glucose": gi5.round(2)}))
    return pd.concat(frames, ignore_index=True), pd.concat(truth, ignore_index=True)


def simulate_patients(ehr: pd.DataFrame, days: int, rng: np.random.Generator):
    """Physiology, behavior, calibration and full simulation for a set of patients."""
    phys = derive_physiology(ehr, rng)
    inp = generate_inputs(ehr, phys, days, rng)
    gb = calibrate(phys, inp)
    _, g, gi = simulate(phys, inp, gb, record=True)
    return phys, inp, gb, g, gi


def replace_patients(target, source, idx: np.ndarray) -> None:
    """Overwrite patients idx of a Physiology/Inputs bundle with a resampled subset."""
    for f in dataclasses.fields(target):
        arr, sub = getattr(target, f.name), getattr(source, f.name)
        if isinstance(arr, pd.DataFrame):
            continue
        if not arr.flags.writeable:  # pandas 3 hands out read-only views
            arr = arr.copy()
            setattr(target, f.name, arr)
        if arr.ndim == 1:
            arr[idx] = sub
        else:
            arr[:, idx] = sub


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--patients", type=int, default=50)
    ap.add_argument("--days", type=int, default=14)
    ap.add_argument("--seed", type=int, default=101)
    ap.add_argument("--out-dir", type=Path, default=Path("synthetic_v2"))
    ap.add_argument("--write-truth", action="store_true", help="also write plasma/interstitial truth")
    args = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s", datefmt="%H:%M:%S")
    rng = np.random.default_rng(args.seed)
    started = time.perf_counter()

    ehr = generate_ehr(args.patients, rng)
    LOG.info("simulating %d patients x %d days", args.patients, args.days)
    phys, inp, gb, g, gi = simulate_patients(ehr, args.days, rng)

    # Blueprint 3.6 step 4: accept a Type 2 twin only if its CV is plausible; otherwise
    # redraw its physiology and behavior (its EHR stays fixed) and simulate again.
    t2d = (ehr["diabetes_status"] == "Type 2").to_numpy()
    for round_ in range(MAX_RESAMPLE_ROUNDS):
        cv = 100 * g.std(axis=0, ddof=1) / g.mean(axis=0)
        reject = np.flatnonzero(t2d & ((cv < CV_ACCEPT_PCT[0]) | (cv > CV_ACCEPT_PCT[1])))
        if reject.size == 0:
            break
        LOG.info("acceptance round %d: resampling %d patients with CV outside %g-%g%%",
                 round_ + 1, reject.size, *CV_ACCEPT_PCT)
        sub_ehr = ehr.iloc[reject].reset_index(drop=True)
        s_phys, s_inp, s_gb, s_g, s_gi = simulate_patients(sub_ehr, args.days, rng)
        replace_patients(phys, s_phys, reject)
        replace_patients(inp, s_inp, reject)
        inp.meals = pd.concat([inp.meals[~inp.meals["patient_id"].isin(sub_ehr["patient_id"])], s_inp.meals],
                              ignore_index=True)
        gb[reject], g[:, reject], gi[:, reject] = s_gb, s_g, s_gi
    else:
        LOG.warning("%d Type 2 patients still outside the CV band after %d rounds",
                    reject.size, MAX_RESAMPLE_ROUNDS)
    telemetry, truth = build_telemetry(ehr, phys, inp, gi, g, rng, args.days)

    ehr_out = ehr.assign(
        target_mean_glucose=phys.mu.round(1), basal_glucose=gb.round(1),
        insulin_sensitivity_rel=(phys.si / SI_REF).round(3),
        tmax0_min=phys.tmax0.round(1), tau_isf_min=phys.tau_isf.round(1),
    )
    args.out_dir.mkdir(parents=True, exist_ok=True)
    ehr_out.to_csv(args.out_dir / "patients_ehr.csv", index=False)
    telemetry.to_csv(args.out_dir / "patient_cgm_telemetry.csv", index=False)
    if args.write_truth:
        truth.to_csv(args.out_dir / "patient_cgm_truth.csv", index=False)
    valid = telemetry["glucose_level"].notna()
    mard = (np.abs(telemetry.loc[valid, "glucose_level"].to_numpy() - truth.loc[valid, "plasma_glucose"].to_numpy())
            / truth.loc[valid, "plasma_glucose"].to_numpy()).mean()
    LOG.info("wrote %s rows to %s in %.0f s | CGM coverage %.1f%% | MARD vs plasma %.1f%% | spike rate %.1f%%",
             f"{len(telemetry):,}", args.out_dir, time.perf_counter() - started, 100 * valid.mean(),
             100 * mard, 100 * telemetry["future_spike_2h"].mean())


if __name__ == "__main__":
    main()
