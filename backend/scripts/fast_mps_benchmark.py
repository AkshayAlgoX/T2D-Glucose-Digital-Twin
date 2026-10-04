#!/usr/bin/env python3
"""fast_mps_benchmark.py -- Incremental JSON writing MPS throughput profiler."""

from __future__ import annotations

import json
import time
import numpy as np
import torch
import lightning.pytorch as pl
from torch.utils.data import Dataset, DataLoader

import train_pr_tft as T


class SyntheticDataset(Dataset):
    def __init__(self, size: int = 256 * 40):
        self.size = size
        # Pre-allocate random synthetic samples on CPU matching exact AnchorDataset keys
        self.past = torch.randn(size, 144, 10)
        self.future = torch.randn(size, 24, 8)
        self.static = torch.randn(size, 18)
        self.y = torch.randn(size, 24)
        self.y_mask = torch.ones(size, 24, dtype=torch.bool)
        self.twin = torch.randn(size, 24)
        self.g0 = torch.randn(size)
        self.g_min60 = torch.randn(size)
        self.hazard_y = torch.zeros(size, 24)
        self.hazard_mask = torch.ones(size, 24, dtype=torch.bool)
        self.onset_any = torch.zeros(size)
        self.at_risk = torch.ones(size)
        self.peak = torch.randn(size)
        self.patient = torch.zeros(size, dtype=torch.long)

    def __len__(self):
        return self.size

    def __getitem__(self, idx: int) -> dict[str, torch.Tensor]:
        return {
            "past": self.past[idx],
            "future": self.future[idx],
            "static": self.static[idx],
            "y": self.y[idx],
            "y_mask": self.y_mask[idx],
            "twin": self.twin[idx],
            "g0": self.g0[idx],
            "g_min60": self.g_min60[idx],
            "hazard_y": self.hazard_y[idx],
            "hazard_mask": self.hazard_mask[idx],
            "onset_any": self.onset_any[idx],
            "at_risk": self.at_risk[idx],
            "peak": self.peak[idx],
            "patient": self.patient[idx],
        }


def run_benchmark(dataset: Dataset, cfg: T.TrainConfig,
                  num_workers: int = 0, pin_memory: bool = False,
                  n_batches: int = 20) -> dict[str, float]:
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
    
    module = T.PRTFTModule(T.dataclasses.asdict(cfg), n_static=18, n_past=10, n_future=8, glu_std=30.0)
    device = torch.device("mps" if torch.backends.mps.is_available() else "cpu")
    module = module.to(device)
    optimizer = torch.optim.AdamW(module.parameters(), lr=cfg.lr, weight_decay=cfg.weight_decay)
    module.train()
    
    loader_iter = iter(loader)
    
    # Warmup 5 batches
    for _ in range(5):
        batch = next(loader_iter)
        batch_dev = {k: v.to(device, non_blocking=pin_memory) for k, v in batch.items()}
        optimizer.zero_grad()
        out = module.model(batch_dev)
        losses = module.criterion(out, batch_dev)
        loss = losses["loss"]
        loss.backward()
        optimizer.step()
        
    if device.type == "mps":
        torch.mps.synchronize()
        
    # Benchmark n_batches
    t0 = time.perf_counter()
    losses_list = []
    
    for _ in range(n_batches):
        batch = next(loader_iter)
        batch_dev = {k: v.to(device, non_blocking=pin_memory) for k, v in batch.items()}
        optimizer.zero_grad()
        out = module.model(batch_dev)
        losses = module.criterion(out, batch_dev)
        loss = losses["loss"]
        loss.backward()
        optimizer.step()
        losses_list.append(loss.item())
        
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
        "mean_loss": round(float(np.mean(losses_list)), 5),
        "peak_mem_mb": round(peak_mem, 1)
    }


if __name__ == "__main__":
    cfg = T.TrainConfig(data_dir="synthetic_v2", twin="ukf", twin_mode="s3", d_model=96, batch_size=256)
    dataset = SyntheticDataset()
    
    candidates = [
        ("Baseline (num_workers=0, pin_memory=False)", 0, False),
        ("Candidate A (num_workers=0, pin_memory=True)", 0, True),
        ("Candidate B (num_workers=2, pin_memory=True)", 2, True),
        ("Candidate C (num_workers=4, pin_memory=True)", 4, True),
    ]
    
    results = {}
    with open("benchmark_results.json", "w") as f:
        f.write(json.dumps({"status": "starting"}, indent=2))
        
    for label, nw, pin in candidates:
        print(f"Running {label}...", flush=True)
        try:
            res = run_benchmark(dataset, cfg, num_workers=nw, pin_memory=pin, n_batches=20)
            results[label] = res
            print(f"  Throughput: {res['throughput_batches_per_sec']} it/s ({res['seconds_per_batch']} s/batch), Mean Loss: {res['mean_loss']}", flush=True)
        except Exception as e:
            print(f"  FAILED {label}: {e}", flush=True)
            results[label] = {"error": str(e)}
            
        with open("benchmark_results.json", "w") as f:
            f.write(json.dumps(results, indent=2))
