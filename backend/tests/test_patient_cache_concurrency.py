"""test_patient_cache_concurrency.py -- Concurrency and LRU cache invariant tests.

Proves:
1. Simultaneous requests for the same unmaterialized patient do not duplicate expensive
   materialization or corrupt cached state.
2. True LRU eviction policy correctly keeps accessed patients and evicts least recently used.
3. Concurrent multithreaded requests across the validation cohort never exceed the bounded limit
   or cause race conditions.
"""
from __future__ import annotations

import concurrent.futures
from pathlib import Path
import threading
import uuid
import numpy as np
import pytest

import serve_pr_tft as S
import train_pr_tft as T


RUN_DIR = Path("runs/pr_tft_ablation_arm_d")


@pytest.fixture(scope="module")
def ctx():
    if not (RUN_DIR / "run_manifest.json").exists():
        pytest.skip("run directory not present")
    return S.ServiceContext(RUN_DIR)


def test_simultaneous_requests_same_patient_no_duplicate_materialization(ctx):
    """Proves simultaneous requests for the same patient across 16 threads execute

    materialization exactly once without state corruption.
    """
    # Pick a served patient and reset its cached state for the test
    pids = [p for p in ctx.by_pid if ctx.split_of[p] == "val"]
    sid = ctx.by_pid[pids[0]]
    pc = ctx.patient(sid)

    with pc._lock:
        pc._past = None
        pc._cob = None
        pc._meal_effect = None
        pc._ukf_mean = None
    with ctx._lru_lock:
        ctx._materialized_lru.pop(sid, None)

    materialize_call_count = 0
    orig_materialize = ctx._materialize_patient

    def spy_materialize(patient_cache):
        nonlocal materialize_call_count
        materialize_call_count += 1
        return orig_materialize(patient_cache)

    ctx._materialize_patient = spy_materialize

    num_threads = 16
    barrier = threading.Barrier(num_threads)
    results = [None] * num_threads

    def worker(idx: int):
        barrier.wait()  # Synchronize all threads to fire simultaneously
        past = pc.past
        cob = pc.cob
        meal_effect = pc.meal_effect
        ukf_mean = pc.ukf_mean
        results[idx] = (past, cob, meal_effect, ukf_mean)

    threads = [threading.Thread(target=worker, args=(i,)) for i in range(num_threads)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=10)

    # Restore original method
    ctx._materialize_patient = orig_materialize

    # Invariant 1: Exactly 1 materialization call occurred
    assert materialize_call_count == 1, f"Expected 1 materialization, got {materialize_call_count}"

    # Invariant 2: All 16 threads received identical, non-corrupted arrays
    ref_past, ref_cob, ref_meal, ref_ukf = results[0]
    assert ref_past is not None and ref_past.shape == (4032, 20)
    assert ref_cob is not None and ref_cob.shape == (4032,)
    assert ref_meal is not None and ref_meal.shape == (4032,)
    assert ref_ukf is not None and ref_ukf.shape == (4032, 14)

    for i in range(1, num_threads):
        past_i, cob_i, meal_i, ukf_i = results[i]
        assert past_i is ref_past or np.array_equal(past_i, ref_past)
        assert cob_i is ref_cob or np.array_equal(cob_i, ref_cob)
        assert meal_i is ref_meal or np.array_equal(meal_i, ref_meal)
        assert ukf_i is ref_ukf or np.array_equal(ukf_i, ref_ukf)


def test_true_lru_eviction_policy(ctx):
    """Proves cache policy is strictly LRU (least recently used) and NOT FIFO."""
    val_pids = [p for p in ctx.by_pid if ctx.split_of[p] == "val"]
    assert len(val_pids) >= 4

    p1, p2, p3, p4 = [ctx.patient(ctx.by_pid[p]) for p in val_pids[:4]]

    # Temporarily set max_materialized_patients to 3
    orig_max = ctx.max_materialized_patients
    ctx.max_materialized_patients = 3
    try:
        # Clear test patients
        for p in (p1, p2, p3, p4):
            p._past = None
            p._cob = None
            p._meal_effect = None
            p._ukf_mean = None
            with ctx._lru_lock:
                ctx._materialized_lru.pop(p.subject_id, None)

        # 1. Materialize P1, P2, P3 -> LRU order: [P1, P2, P3]
        _ = p1.past
        _ = p2.past
        _ = p3.past
        assert p1._past is not None
        assert p2._past is not None
        assert p3._past is not None

        # 2. Access P1 again -> LRU order must become: [P2, P3, P1]
        _ = p1.past

        # 3. Now access P4 -> Cache is full (limit 3).
        # Under FIFO: P1 was added first and would be evicted.
        # Under true LRU: P2 is the least recently used and MUST be evicted!
        _ = p4.past

        assert p2._past is None, "P2 should have been evicted (it was the LRU item)"
        assert p1._past is not None, "P1 should NOT have been evicted (it was recently used)"
        assert p3._past is not None, "P3 should remain cached"
        assert p4._past is not None, "P4 should be cached"

        # 4. Re-materializing evicted P2 works safely
        past_p2 = p2.past
        assert past_p2 is not None and past_p2.shape == (4032, 20)
    finally:
        ctx.max_materialized_patients = orig_max


def test_concurrent_multithreaded_cohort_requests(ctx):
    """Proves heavy multithreaded concurrent requests across the cohort maintain

    exact invariants without deadlocks or exceeding max materialized patients.
    """
    val_pids = [p for p in ctx.by_pid if ctx.split_of[p] == "val"]
    all_sids = [ctx.by_pid[p] for p in val_pids]

    def access_patient(sid: uuid.UUID):
        pc = ctx.patient(sid)
        past = pc.past
        cob = pc.cob
        return past.shape, cob.shape

    # 44 patients accessed across 10 workers in parallel
    with concurrent.futures.ThreadPoolExecutor(max_workers=10) as executor:
        futures = [executor.submit(access_patient, sid) for sid in all_sids * 3]
        results = [f.result(timeout=15) for f in futures]

    assert len(results) == len(all_sids) * 3
    assert all(r == ((4032, 20), (4032,)) for r in results)

    with ctx._lru_lock:
        assert len(ctx._materialized_lru) <= ctx.max_materialized_patients


def test_concurrent_reads_during_active_eviction_churn(ctx):
    """Stress test: concurrent workers read target patient properties while other workers
    actively access >64 distinct patients, triggering continuous LRU evictions.

    Proves:
    1. Property getters never return unexpected None.
    2. Returned arrays are always valid NumPy arrays of expected shapes.
    3. Numerical results remain 100% stable.
    4. No exceptions or deadlocks occur under severe eviction pressure.
    """
    # Cohort has 44 val + 205 train = 249 served patients
    all_served_pids = [p for p in ctx.by_pid if ctx.split_of[p] != "test"]
    assert len(all_served_pids) >= 100

    target_pid = all_served_pids[0]
    target_sid = ctx.by_pid[target_pid]
    target_pc = ctx.patient(target_sid)

    # Reference values for target patient
    ref_past = target_pc.past.copy()
    ref_cob = target_pc.cob.copy()
    ref_meal = target_pc.meal_effect.copy()

    # Churn list of >75 distinct patients to force repeated evictions beyond limit (64)
    churn_sids = [ctx.by_pid[p] for p in all_served_pids[1:85]]
    assert len(churn_sids) > 64

    stop_event = threading.Event()
    read_errors = []
    total_target_reads = 0
    read_counter_lock = threading.Lock()

    def reader_worker():
        nonlocal total_target_reads
        reads = 0
        while not stop_event.is_set():
            try:
                p = target_pc.past
                c = target_pc.cob
                m = target_pc.meal_effect
                u = target_pc.ukf_mean

                if p is None or c is None or m is None:
                    read_errors.append(f"Unexpected None in reader: past={p is None}, cob={c is None}, meal={m is None}")
                    break
                if p.shape != (4032, 20) or c.shape != (4032,) or m.shape != (4032,):
                    read_errors.append(f"Invalid shape: past={p.shape}, cob={c.shape}, meal={m.shape}")
                    break
                if not np.array_equal(p, ref_past) or not np.array_equal(c, ref_cob) or not np.array_equal(m, ref_meal):
                    read_errors.append("Numerical corruption detected in target patient arrays!")
                    break
                reads += 1
            except Exception as e:
                read_errors.append(f"Exception in reader_worker: {type(e).__name__}: {e}")
                break
        with read_counter_lock:
            total_target_reads += reads

    def churn_worker(worker_id: int):
        for sid in churn_sids:
            if stop_event.is_set():
                break
            try:
                pc = ctx.patient(sid)
                p = pc.past
                c = pc.cob
                if p is None or c is None:
                    read_errors.append(f"Unexpected None in churn_worker {worker_id} for {sid}")
                    break
            except Exception as e:
                read_errors.append(f"Exception in churn_worker {worker_id}: {type(e).__name__}: {e}")
                break

    # Spawn 8 reader threads hammering target patient and 8 churn threads hammering >64 distinct patients
    with concurrent.futures.ThreadPoolExecutor(max_workers=16) as pool:
        reader_futures = [pool.submit(reader_worker) for _ in range(8)]
        churn_futures = [pool.submit(churn_worker, i) for i in range(8)]

        # Let the churn workers run and trigger repeated evictions
        concurrent.futures.wait(churn_futures, timeout=15)
        stop_event.set()
        concurrent.futures.wait(reader_futures, timeout=5)

    assert not read_errors, f"Errors encountered during eviction churn: {read_errors[:5]}"
    assert total_target_reads > 100, f"Expected >100 successful reads, got {total_target_reads}"
