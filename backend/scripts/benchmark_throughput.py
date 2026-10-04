#!/usr/bin/env python3
"""benchmark_throughput.py -- Robust MPS throughput profiler saving to JSON."""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path
import numpy as np
import torch
import pytorch_lightning as pl
from torch.utils.data import DataLoader

import train_pr_tft as T


def run_benchmark(dataset: T.AnchorDataset, norm: T.NormalizationArtifact, cfg: T.TrainConfig,
                  num_workers: int = 0, pin_memory: bool = False,
                  n_batches: int = 30) -> dict[str, float]:
    pl.seed_everything(cfg.seed, workers=True)
    
    loader = DataLoader(
        dataset,
        batch_size=cfg.batch_size,
        shuffle=True,
        num_workers=num_workers,
        pin_memory=pin_memory,
        persistent_workers=(num_workers > 0),
        drop_last=True
    )
    
    n_static = len(T.get_static_features(cfg))
    n_past = len(T.past_feature_names(cfg))
    n_future = len(T.FUTURE_FEATURES)
    
    module = T.PRTFTModule(T.dataclasses.asdict(cfg), n_static, n_past, n_future, norm.glu_std)
    device = torch.device("mps" if torch.backends.mps.is_available() else "cpu")
    module = module.to(device)
    
    optimizer = module.configure_optimizers()["optimizer"]
    module.train()
    
    # Warmup 5 batches
    loader_iter = iter(loader)
    for _ in range(5):
        batch = next(loader_iter)
        batch_dev = {k: v.to(device, non_blocking=pin_memory) for k, v in batch.items()}
        optimizer.zero_grad()
        loss = module.training_step(batch_dev, 0)
        loss.backward()
        optimizer.step()
        
    if device.type == "mps":
        torch.mps.synchronize()
        
    # Benchmark n_batches
    t0 = time.perf_counter()
    losses = []
    
    for _ in range(n_batches):
        batch = next(loader_iter)
        batch_dev = {k: v.to(device, non_blocking=pin_memory) for k, v in batch.items()}
        optimizer.zero_grad()
        loss = module.training_step(batch_dev, 0)
        loss.backward()
        optimizer.step()
        losses.append(loss.item())
        
    if device.type == "mps":
        torch.mps.synchronize()
        
    elapsed = time.perf_counter() - t0
    throughput = n_batches / elapsed
    s_per_batch = elapsed / n_batches
    
    peak_mem = 0.0
    if device.type == "mps" and hasattr(torch.mps, "current_allocated_memory"):
        peak_mem = torch.mps.current_allocated_memory() / 1e6
        
    return {
        "num_workers": num_workers,
        "pin_memory": pin_memory,
        "n_batches": n_batches,
        "elapsed_seconds": round(elapsed, 3),
        "throughput_batches_per_sec": round(throughput, 3),
        "seconds_per_batch": round(s_per_batch, 3),
        "final_loss": round(float(losses[-1]), 5),
        "mean_loss": round(float(np.mean(losses)), 5),
        "peak_mem_mb": round(peak_mem, 1)
    }


if __name__ == "__main__":
    cfg = T.TrainConfig(data_dir="synthetic_v2", twin="ukf", twin_mode="s3", d_model=96, batch_size=256)
    
    out_path = Path("benchmark_results.json")
    out_path.write_text(json.dumps({"status": "Building datamodule..."}, indent=2))
    
    pl.seed_everything(cfg.seed, workers=True)
    rng = np.random.default_rng(cfg.seed)
    series = T.load_data(cfg)
    split_ids = T.split_patients(series, cfg.seed)
    dm, twin, norm, pop = T.build_datamodule(series, split_ids, cfg, rng)
    dataset = T.AnchorDataset(dm.splits["train"])
    
    candidates = [
        ("Baseline (num_workers=0, pin_memory=False)", 0, False),
        ("Candidate A (num_workers=0, pin_memory=True)", 0, True),
        ("Candidate B (num_workers=2, pin_memory=True)", 2, True),
        ("Candidate C (num_workers=4, pin_memory=True)", 4, True),
    ]
    
    results = {}
    for label, nw, pin in candidates:
        try:
            res = run_benchmark(dataset, norm, cfg, num_workers=nw, pin_memory=pin, n_batches=30)
            results[label] = res
            out_path.write_text(json.dumps(results, indent=2))
        except Exception as e:
            results[label] = {"error": str(e)}
            out_path.write_text(json.dumps(results, indent=2))
