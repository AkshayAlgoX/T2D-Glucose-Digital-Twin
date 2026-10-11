"""Prepare one reserved EW-01 construction slot from its authenticated generation output.

    python prepare_cohort.py --replica A [--assert-seed SEED]

The registry and trust anchor are pinned to the designated authority's production location; there is
no argument that supplies a key, a receipt, a catalog or a seed. --assert-seed only asserts: a value
different from the authorized generation seed blocks.
"""
import argparse
import json
import sys

from ew01_trust import PRODUCTION_REGISTRY_ROOT, Blocked
from provenance_pipeline import prepare_replica


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--replica", required=True)
    ap.add_argument("--assert-seed", type=int, default=None)
    args = ap.parse_args(argv)
    try:
        inv = prepare_replica(args.replica, registry_root=PRODUCTION_REGISTRY_ROOT, assert_seed=args.assert_seed)
    except Blocked as e:
        print(e, file=sys.stderr)
        return 1
    print(json.dumps(inv, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
