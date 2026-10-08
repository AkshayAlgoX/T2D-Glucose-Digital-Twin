# EW-01 Protocol Clarification: Boolean Predicate

## Context
The original EW01 amendment contained ambiguous wording regarding the exact conditions required for the "first comparison passes" rule. To prevent post-hoc interpretation and ensure rigorous pre-run registration, this clarification explicitly freezes the Boolean predicate required for success.

## Explicit Boolean Rule
The FIRST COMPARISON evaluates **B7@0.35 versus B9**.
A PASS requires BOTH co-primary superiority conditions to hold simultaneously:

1. **Sensitivity**: The lower bound of the paired difference (B7@0.35 minus B9) MUST be > +0.02.
2. **False alerts per monitored patient-day**: The upper bound of the paired difference (B7@0.35 minus B9) MUST be < -0.10.

If either condition fails, the result is INCONCLUSIVE / NO PASS.
- Superiority on only one metric is NOT a pass.
- Superiority on one and non-inferiority on the other is NOT a pass.

## Conditional Branching
- The B1 confirmatory comparison is strictly **conditional** on the first comparison passing. If the first comparison fails, the B1 evaluation MUST NOT be executed.
- B7@0.60 is evaluated for descriptive purposes only.

## Constraints
- This Boolean predicate is frozen BEFORE cohort generation.
- No post-hoc rule changes, threshold tuning, or alternate comparators are permitted.
- No re-runs after result visibility.
- The original Q0-03 parity definition remains unchanged.
- The H1 dataset remains completely untouched.
