#!/bin/bash
# EW-01 final implementation: attributable locked-environment test evidence.
WT="${T2D_WORKTREE:-$(cd "$(dirname "$0")/../.." && pwd)}"
S="${EW01_SCRATCH:-/tmp/ew01_env}"
V="${EW01_PYTHON:-$S/venv/bin/python}"
RUN="env -i HOME=$HOME PATH=/usr/bin:/bin PYTHONNOUSERSITE=1 PYTHONDONTWRITEBYTECODE=1"
cd $WT
echo "### date: $(date -Is)"
echo "### worktree: $WT  branch: $(git branch --show-current)"
echo "### HEAD: $(git rev-parse HEAD)"
echo "### git status --porcelain (expect empty):"; git status --porcelain; echo "### end status"
echo "### committed lock blob: $(git ls-tree HEAD experiments/early_warning_ew01/requirements.txt)"
echo "### lock sha256 BEFORE: committed=$(git show HEAD:experiments/early_warning_ew01/requirements.txt | sha256sum | cut -c1-64) worktree=$(sha256sum experiments/early_warning_ew01/requirements.txt | cut -c1-64) venv-build-input=$(sha256sum $S/lock_committed.txt | cut -c1-64)"
echo "### main checkout lock (dirty copy, preserved, not used): $(sha256sum /home/akshaya/T2D-Glucose-Digital-Twin/experiments/early_warning_ew01/requirements.txt | cut -c1-64)"
echo "### venv build (bootstrap + install) log: $S/build.log"
grep -E '^\+\+|install rc|pip check rc|No broken|^pip 24|^ce4293' $S/build.log
echo "### interpreter"
$RUN $V -VV
$RUN $V -c 'import sys,site,platform; print("executable", sys.executable); print("prefix", sys.prefix); print("base_prefix", sys.base_prefix); print("ENABLE_USER_SITE", site.ENABLE_USER_SITE); print("platform", platform.platform(), platform.libc_ver()); print("sys.path", sys.path)'
echo "### pip"; $RUN $V -m pip --version
echo "### pip check"; $RUN $V -m pip check; echo "pip check rc=$?"
echo "### pip freeze --all"; $RUN $V -m pip freeze --all
echo "### environment verification against committed lock (ew01_trust.verify_environment)"
$RUN $V - <<'PY'
import sys, importlib
sys.path.insert(0, "experiments/early_warning_ew01"); sys.path.insert(0, "backend")
import ew01_trust as tr
env = tr.environment_identity()
print("environment_identity", env)
print("verify_environment ->", tr.verify_environment(env) == env)
pins = tr.parse_lock(); inst = tr.installed_distributions()
print("lock pins", len(pins), "installed dists", len(inst), "sets equal", set(pins) == set(inst),
      "versions equal", all(inst[k] == pins[k] for k in pins))
for m in ["numpy", "pandas", "cryptography", "torch", "lightning", "sklearn", "scipy", "pytest", "packaging",
          "train_pr_tft", "ew01_trust", "freshness2", "provenance_pipeline", "ew01_construct"]:
    mod = importlib.import_module(m)
    print(f"import {m:22s} {getattr(mod, '__version__', '-'):12s} {mod.__file__}")
lock = tr.LOCK_PATH.read_text().replace("\\\n", " ")
for d in ["numpy", "pandas", "cryptography", "torch", "pytest"]:
    line = next(l for l in lock.splitlines() if l.lower().startswith(d + "=="))
    hashes = line.split("--hash=sha256:")[1:]
    print(f"lock {d}: {line.split()[0]} ({len(hashes)} allowed sha256, first {hashes[0].split()[0][:16]}...)")
print("construction sources:"); [print(" ", k, v) for k, v in tr.source_inventory().items()]
PY
echo "### selected wheels (pip --require-hashes verified each against the lock):"
grep -oE '(Using cached|Downloading) (numpy|pandas|cryptography|torch|pytest|lightning)-[^ ]+\.whl' $S/build.log | sort -u
CMD="$RUN $V -m pytest experiments/early_warning_ew01/test_provenance.py experiments/early_warning_ew01/test_b1_baseline.py -v -p no:cacheprovider"
echo "### test command (cwd $WT): $CMD"
$CMD
echo "### pytest exit code: $?"
echo "### lock sha256 AFTER: worktree=$(sha256sum experiments/early_warning_ew01/requirements.txt | cut -c1-64) main-checkout=$(sha256sum /home/akshaya/T2D-Glucose-Digital-Twin/experiments/early_warning_ew01/requirements.txt | cut -c1-64)"
echo "### git status after (expect empty):"; git status --porcelain; echo "### end"
echo "### production registry present: $(test -e /home/akshaya/t2d-execution-registry && echo YES || echo NO)"
