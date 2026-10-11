"""Seal the prospectively selected EW-01 replica into a new read-only directory and a new manifest.

    python seal_cohort.py --sealed-dir DIR --manifest PATH

Both paths must not exist and may not be protected locations (backend/, runs/, t2d-sealed, or any
data/run/cohort manifest name); the sealed directory must be outside the repository. The registry and
trust anchor are pinned to the designated authority. The manifest is an unsigned EW01_SEALED_COHORT
payload: run_scientific.py scores the sealed directory only after the authority has verified the seal
and signed that payload into the registry.
"""
import argparse
import json
import sys

from ew01_trust import PRODUCTION_REGISTRY_ROOT, Blocked
from provenance_pipeline import seal_construction


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--sealed-dir", required=True)
    ap.add_argument("--manifest", required=True)
    args = ap.parse_args(argv)
    try:
        record = seal_construction(registry_root=PRODUCTION_REGISTRY_ROOT, sealed_dir=args.sealed_dir,
                                   manifest_path=args.manifest)
    except Blocked as e:
        print(e, file=sys.stderr)
        return 1
    print(json.dumps(record["cohort"], indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
