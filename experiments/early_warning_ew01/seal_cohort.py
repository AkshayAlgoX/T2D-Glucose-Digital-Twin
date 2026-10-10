import sys
from provenance_pipeline import seal_cohort_impl

def main():
    if len(sys.argv) != 6:
        print("Usage: python seal_cohort.py <prep_dir> <manifest_path> <receipt_path> <catalog_path> <expected_contract_hash>")
        sys.exit(1)
        
    prep_dir = sys.argv[1]
    manifest_path = sys.argv[2]
    receipt_path = sys.argv[3]
    catalog_path = sys.argv[4]
    expected_contract_hash = sys.argv[5]
    
    # Pinned production trust anchor
    pubkey_path = "/home/akshaya/t2d-execution-registry/EW-01/trusted_pubkey.pem"
    
    seal_cohort_impl(
        prep_dir, manifest_path,
        receipt_path=receipt_path,
        catalog_path=catalog_path,
        pubkey_path=pubkey_path,
        expected_contract_hash=expected_contract_hash
    )

if __name__ == "__main__":
    main()
