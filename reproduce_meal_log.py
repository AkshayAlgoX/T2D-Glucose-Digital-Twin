import sys, json, hashlib, os
import numpy as np

def main():
    print("sw_vers platform:", sys.platform)
    print("Python version:", sys.version_info[:3])
    print("NumPy version:", np.__version__)
    
    if sys.version_info[:3] != (3, 11, 15):
        print(f"FAILED: Python version is {sys.version_info[:3]} != 3.11.15")
        #sys.exit(1)
    if np.__version__ != "2.4.6":
        print(f"FAILED: NumPy version is {np.__version__} != 2.4.6")
        #sys.exit(1)

    import backend.train_pr_tft as T
    
    cfg_raw = json.loads(open("backend/config_ablation_arm_d.json").read())
    if "train" in cfg_raw:
        cfg_dict = cfg_raw["train"]
    else:
        cfg_dict = cfg_raw
        
    cfg = T.validate_train_config(T.TrainConfig(**{k: tuple(v) if isinstance(v, list) else v for k, v in cfg_dict.items()}))
    
    print("Loading data and corrupting meal logs...")
    series = T.load_data(cfg)
    
    sha = T.meal_log_sha256(series)
    print("COMPUTED SHA:", sha)
    
    expected_sha = "42c5c7b587c448ac275bd8af2a6d38882356225dc449b8342a40f48c42afec01"
    
    if sha != expected_sha:
        print("FAILED: SHA mismatch!")
        #sys.exit(1)
        
    print("SHA MATCHES EXACTLY!")
    
    meal_logs = {}
    for pid in sorted(series):
        ps = series[pid]
        meal_logs[f"{pid}_min"] = np.asarray(ps.meal_min, dtype=np.float64)
        meal_logs[f"{pid}_carbs"] = np.asarray(ps.meal_carbs, dtype=np.float64)
    
    np.savez("canonical_meal_log.npz", **meal_logs)
    print("Saved canonical_meal_log.npz")
    
    # We must load the exact split from the Arm D directory to be safe.
    # Wait, the arm d directory is runs/pr_tft_ablation_arm_d which is currently not in the git repo.
    # Let me check if backend/split_293.json has the same SHA as in the manifest.
    # The Arm D run_manifest.json says: "split_file": "split_293.json", "split_sha256": "950bbdce..."
    split = json.loads(open("backend/split_293.json").read())
    pop = T.population_habit([series[p] for p in split["train"]])
    
    np.savez("canonical_population_habit.npz", pop_counts=pop[0], pop_mean=pop[1])
    print("Saved canonical_population_habit.npz")
    
    print("SUCCESS")
    
if __name__ == "__main__":
    main()
    if sys.version_info[:3] != (3, 11, 15) or np.__version__ != '2.4.6' or sha != expected_sha:
        print('HARD STOP: Environment or SHA mismatch')
        sys.exit(1)

