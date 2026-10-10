import sys
from provenance_pipeline import run_preparation

def main():
    if len(sys.argv) < 3:
        print("Usage: python prepare_cohort.py <raw_dir> <prep_dir> [seed] [receipt_path] [expected_contract_hash] [expected_attempt] [catalog_path] [pubkey_path] [test_mode]")
        sys.exit(1)
        
    raw_dir = sys.argv[1]
    prep_dir = sys.argv[2]
    seed = sys.argv[3] if len(sys.argv) > 3 else "20261016"
    receipt_path = sys.argv[4] if len(sys.argv) > 4 else None
    expected_contract_hash = sys.argv[5] if len(sys.argv) > 5 else None
    expected_attempt = sys.argv[6] if len(sys.argv) > 6 else None
    catalog_path = sys.argv[7] if len(sys.argv) > 7 else None
    pubkey_path = sys.argv[8] if len(sys.argv) > 8 else None
    test_mode = sys.argv[9].lower() == 'true' if len(sys.argv) > 9 else False
    
    run_preparation(
        raw_dir, prep_dir, seed,
        receipt_path=receipt_path,
        expected_contract_hash=expected_contract_hash,
        expected_attempt=expected_attempt,
        catalog_path=catalog_path,
        pubkey_path=pubkey_path,
        test_mode=test_mode
    )

if __name__ == "__main__":
    main()
