import sys
from provenance_pipeline import seal_cohort_impl

def main():
    if len(sys.argv) != 3:
        print("Usage: python seal_cohort.py <prep_dir> <manifest_path>")
        sys.exit(1)
    
    seal_cohort_impl(sys.argv[1], sys.argv[2])

if __name__ == "__main__":
    main()
