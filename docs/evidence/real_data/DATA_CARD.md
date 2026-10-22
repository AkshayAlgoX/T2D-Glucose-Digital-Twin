# Open real-data sources: preparation data card

Status: documentation/inventory inspection only; no participant records parsed,
no model fitted and no performance evidence available. Mapping decisions below
must be verified against training-partition schemas before fitting. Test records
remain inaccessible. This card is not a claim that all channels exist for all people.

## Sources and use restrictions

| Dataset | Pinned release | License | Source |
|---|---|---|---|
| ShanghaiT2DM | Figshare 21600933 v5, file 42966622 | CC BY 4.0 | https://api.figshare.com/v2/articles/21600933/versions/5 |
| CGMacros | 1.0.0 | CC BY-NC-SA 4.0 | https://physionet.org/content/cgmacros/1.0.0/ |
| BIG IDEAs glycemic wearable | 1.1.3 | ODC-By 1.0 | https://physionet.org/content/big-ideas-glycemic-wearable/1.1.3/ |

CGMacros creators: Ricardo Gutierrez-Osuna, David Kerr, Bobak Mortazavi, Anurag
Das and collaborators. Shanghai creators: Qinpei Zhao, Jinhao Zhu, Congrong Wang
and Weixiong Rao. BIG IDEAs creators: Peter Cho, Juseong Kim, Brinnae Bent and
Jessilyn Dunn. Retain original citations/license notices locally with acquired data.
No raw or per-person derived data is published. Trained-weight redistribution and
commercial use are not assumed permitted by this protocol; do not upload weights
as public assets without a license review. All acquisition is from original sources.

## CGMacros documented mappings

Sources: DataDictionary_Bio.csv and DataDictionary_CGMacros-00X.csv from the
official 1.0.0 release; original descriptor https://doi.org/10.1038/s41597-025-05851-7.

| Source field | Target / units | Treatment |
|---|---|---|
| Timestamp | local study timestamp | Date-shifted; no invented timezone; causal right-closed binning |
| Dexcom GL | CGM, mg/dL | G6 Pro native 5-min; missing readings remain missing |
| HR | HR, bpm | Last-minute mean; use observations at/before bin endpoint only |
| Meal Type, Timestamp | meal start | Retrospective annotation does not prove contemporaneous availability |
| Carbs | logged carbohydrate, g | Verify Amount Consumed semantics before any adjustment |
| Age | age, years | Baseline measurement; observation mask |
| Gender | recorded F/M | Preserve source category; do not infer |
| BMI | BMI, kg/m2 | Baseline measurement; observation mask |
| Body weight | weight, kg | Pounds times exactly 0.45359237 |
| A1c PDL (Lab) | HbA1c | Dictionary says mmol/mol with range 4.6–8.5; paper explicitly reports percent. Treat as unresolved metadata discrepancy until corroborated against source schema; never apply an unrecorded unit conversion |
| Study HbA1c grouping | study metabolic group | Authors describe <5.7% healthy, 5.7–6.4% prediabetes, >6.4% T2D; no separate diagnosis field is listed in Bio dictionary. Label any use as author-defined HbA1c group |
| Calories (Activity), Mets | optional observed activity channels | METs dictionary is scaled by 10; not steps or sleep; not used to fabricate either |

Unavailable in these dictionaries: HRV, sleep, step counts, eGFR, disease duration
and individual medication classes. The study's medication eligibility restrictions
do not establish each individual's medication use, including metformin.

The new reduced twin's population priors are specified in PREREGISTRATION.md and
must stay separate from source observations and masks. They do not repair the
original model's missing inputs. CGMacros cannot validate the unchanged full hybrid.

## ShanghaiT2DM preparation constraints

Source descriptor: https://doi.org/10.1038/s41597-023-01940-7. Native CGM is 15-min;
the record includes clinical/laboratory/medication and diet tables in Excel files.
Exact workbook headers, laboratory units, medication semantics and meal availability
times remain unverified. No adapter may guess those mappings. Group repeated visit
files by original patient ID before splitting. Exclude ShanghaiT1DM entirely.

On a 5-min grid, absent measurements are missing, not interpolated ground truth.
The preregistered locked 70% coverage and spike persistence rules may make this
dataset non-estimable for the primary endpoints. Report that honestly rather than
altering labels. Any secondary native-cadence endpoint requires an amendment first.

## BIG IDEAs preparation constraints

Official release documents separate Dexcom, HR, food logs and Demographics tables.
Dexcom timestamps/value supply mg/dL CGM; HR supplies wearable HR. Demographics
documents gender and HbA1c. Other static fields and exact food-log units must be
checked against the training schema, not inferred. Do not turn accelerometry into
steps or HR into HRV. IBI-derived HRV would be a separate explicitly specified
feature requiring its own quality and causal-window rules; it is not yet specified.

## Storage, provenance and leakage boundaries

At initial inspection about 31 GiB was free locally. CGMacros official S3 inventory
contains a 657,187,340-byte ZIP including images, not separate participant CSVs;
extract only table files if acquired. Shanghai archive is 3,738,354 bytes. Inventory
BIG IDEAs before acquisition and omit unused raw BVP/ACC/EDA/TEMP signals.
Do not promise a total storage bound before its inventory is checked.

Store source archives, metadata snapshots, local split manifests and all individual
artifacts in ignored data/real/. Public checksums identify source files and bytes,
not patient outcomes. Before committing, inspect the staged paths and reject any
participant artifact. A completed download is not a successful integrity check:
verify upstream digest where available and record local SHA-256.

No backward filling, later-value interpolation, full-person normalization or future
meal schedule. Split before inspecting trajectories. Test access requires separate
owner authorization. Existing synthetic test data and evaluate_run.py's evaluation
entry point remain prohibited. The original run and its evidence stay unchanged.
