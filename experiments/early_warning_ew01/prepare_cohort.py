import sys
from provenance_pipeline import run_preparation

def main():
    if len(sys.argv) != 8:
        print("Usage: python prepare_cohort.py <raw_dir> <prep_dir> <seed> <receipt_path> <expected_contract_hash> <expected_attempt> <catalog_path>")
        sys.exit(1)
        
    raw_dir = sys.argv[1]
    prep_dir = sys.argv[2]
    seed = sys.argv[3]
    receipt_path = sys.argv[4]
    expected_contract_hash = sys.argv[5]
    expected_attempt = sys.argv[6]
    catalog_path = sys.argv[7]
    
    # Pinned production trust anchor
    pubkey_path = "/home/akshaya/t2d-execution-registry/EW-01/trusted_pubkey.pem"
    
    run_preparation(
        raw_dir, prep_dir, seed,
        receipt_path=receipt_path,
        expected_contract_hash=expected_contract_hash,
        expected_attempt=expected_attempt,
        catalog_path=catalog_path,
        pubkey_path=pubkey_path
    )

if __name__ == "__main__":
    main()
