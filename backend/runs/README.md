# runs/

Run outputs are written here and are **not committed** (see `.gitignore`). Each run is
self-describing and traceable to the commit that produced it:

| Producer | Output | Provenance inside |
|---|---|---|
| `train_pr_tft.py --config final_config.json [--smoke-test]` | `runs/pr_tft_final[_smoke]/` | `run_manifest.json`: git SHA and dirty flag, config / data / split / rule / source hashes, checkpoint path + sha256, meal-log fingerprint |
| `evaluate_run.py --run-dir RUN` | `RUN/evaluation_report.json` | evaluator git SHA, training git SHA, identity checks, rule hashes |
| `twin_mode_selection.py --config final_config.json` | `runs/twin_mode_selection/s2_s3_validation_report.json` | git SHA, data / split / rule hashes, meal-log fingerprint |

## Archived artifacts (removed from the tree; still in git history)

They cannot be reproduced from the current code, so they are not evidence for any current
result.

| Artifact | Retrieve with | Why it is stale |
|---|---|---|
| `pr_tft_demo/` (checkpoint, config, metrics, split) | `git show 6274b13:backend/runs/archive_stale/pr_tft_demo/<file>` (first committed in 55d1d60) | Linear twin with oracle (simulator-latent) static inputs: `n_static` 21, `n_past` 12. It predates the latent firewall, and its metrics came from an evaluation that swapped the Clarke reference and prediction. |
| `s2_s3_validation_report.json` | `git show 6274b13:backend/runs/archive_stale/s2_s3_validation_report.json` (first committed in 347d92c) | Hard-coded `selected_mode`. Meal timing was rounded (a look-ahead), and its meal-log random stream differed from the training pipeline's. |
| `split_manifest.json` | `git show 6274b13:backend/runs/archive_stale/split_manifest.json` (347d92c) | Superseded by `backend/data_manifest.json`, which the trainer and evaluator now enforce. |
| `ukf_smoke_report.json` | `git show 6274b13:backend/runs/archive_stale/ukf_smoke_report.json` (347d92c) | Generated before its generating script was committed, from pre-firewall code. |
