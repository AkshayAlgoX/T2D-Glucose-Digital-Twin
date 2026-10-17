# Submission gap matrix — first draft

Snapshot: 2026-10-12; inspected HEAD `4a743311c2492a919a84e8857f3c7ca8e985d8af`. Draft only; not submitted, adopted, or runtime-tested. Owners below are proposed roles, not assignments or consent.

Labels: **VERIFIED** = directly inspected artifact/source; **SUPPORTED** = substantiated with remaining limitations; **CLAIMED** = report without sufficient corroboration; **UNKNOWN** = evidence missing. Source verification does not establish successful execution.

Requirements source: [organizer listing on Unstop](https://unstop.com/hackathons/crp-digital-twin-challenge-2026-happiest-health-1757873/amp), inspected in the preceding audit on 2026-10-12. Submission deadline: **20 October 2026, 19:00 IST**. Confirm organizer messages before final upload. Numerical rubric and hidden-test specification: **UNKNOWN**. Shortlist counts on the listing conflict; do not infer a scoring formula.

## Mandatory delivery requirements

| Requirement | Current evidence/status | Missing work | Proposed owner | Completion criterion |
|---|---|---|---|---|
| Public GitHub submission | Repository exists locally; public access and final URL UNKNOWN. `package.json` contains inconsistent URLs with trailing punctuation. | Confirm correct public URL, branch/tag and accessible assets; owner publishes separately. | Team lead `[NAME]` | Anonymous reviewer can open the exact submission and download its dependencies/artifacts. |
| Team and institution details | Root README does not provide them. | Names, college/incubator, roles, registration confirmation. | Team lead `[NAME]` | Verified details in final README; no invented identities. |
| Title, problem and use case | Source supports a synthetic glucose-forecasting research prototype. | Adopt judge-facing wording from README draft. | Science lead `[NAME]` | Clear population, adverse-event target and research-only boundary. |
| Technical stack/model description | VERIFIED source: Next.js/React frontend; FastAPI; PR-TFT + UKF S3 configuration. | Reconcile docs with implementation; remove unsupported production/clinical wording. | Engineering lead `[NAME]` | Architecture and README describe the shipped path, including disabled features. |
| EHR and wearable fusion; adverse-event algorithm | VERIFIED feature/model and service code; live behavior UNKNOWN in this sprint. | Authorized demonstration of actual inference using an approved existing synthetic replay. | Engineering + science leads | Captured request, response and rendered UI agree; no metric or accuracy inferred from a single example. |
| Clinician-facing dashboard concept | VERIFIED cohort/patient pages, chart, risk panel, quality states. | Record the functioning workflow; distinguish fixtures from live inference. | Demo owner `[NAME]` | Judges see synthetic identity, time, forecast band, risk, quality and limitations. |
| Video of at least 20 minutes | Script provided; no final video verified. | Record and review a 22-minute walkthrough; host with appropriate access. | Demo owner `[NAME]` | Playable link, duration >=20:00, legible screen, no private data or tokens. |
| License details | `package.json` declares ISC; root license file and full rights review not verified. | Owner confirms project license, dependency notices and dataset/model redistribution permissions. | Team lead + license reviewer `[NAME]` | License text and notices are present; every redistributed asset has an established basis. |
| Architecture PDF/PPT | Markdown and Mermaid drafts provided; no exported artifact yet. | Render diagram and export accompanying explanation. | Engineering lead | Accessible PDF/PPT consistent with ARCHITECTURE_CONTENT.md. |
| Presentation PDF/PPT | Outline provided; no exported deck yet. | Build slides with source-backed claims and appropriately labelled screenshots. | Presentation owner `[NAME]` | Accessible deck with working evidence links and no unsupported metrics. |
| Required folder naming | UNKNOWN final submission layout. | Use `[TEAM_NAME]_[COLLEGE_NAME]` as required by listing; confirm exact organizer instructions. | Release owner `[NAME]` | Published layout matches current instructions. |
| Submission form and eligibility | UNKNOWN; not inferred from repository. | Team lead verifies registration, team confirmation and permitted participant status; submits contact details privately. | Team lead `[NAME]` | Platform confirms receipt before deadline. |

## Concrete technical and evidence gaps

| Priority | Verified finding | Safe completion criterion |
|---|---|---|
| P0 | `ScenarioEditor.tsx` sets `disabled = true`; it makes no live scenario request. | Describe as disabled. API-only scenario demonstration needs separate authorization/rehearsal. UI integration would be a separately approved code change, not work performed here. |
| P0 | Default stream includes drivers/twin state, but not EHR context. Frontend proxy does not forward an `include` option. | Do not promise EHR fields appear in the current live sidebar. Demonstrate fusion via source and, if authorized, a direct forecast response requesting EHR context. |
| P0 | `/v1/subjects/{id}/twin` calls `twin_card`, which computes cohort forecast RMSE. | Exclude this endpoint and its UI proxy from any non-scoring demonstration. Do not interpret “GET” as read-only science. |
| P0 | Arm D run directory lacks `evaluation_report.json`; `/evidence` requires it. Its parser also requires `run_id` and `checkpoint.name`, absent in the inspected Arm D manifest. | Do not promise a populated evidence page or fabricate a compatible report. Use this ledger and an honest absent/invalid state; any page integration is separate work. |
| P0 | Serving What-If re-runs the network with altered twin inputs. | Do not portray the research raw-physics-delta composer as already wired into this service. |
| P1 | Historical VAL metrics exist; manifest records a dirty source tree. | Keep numbers in historical appendix only; independently validate provenance before promoting any performance claim. |
| P1 | Dirty EW-01 dependency lock persists. | Do not reuse this checkout's environment as a proven release environment. Follow approved restoration/migration decisions separately. |
| P1 | Replay scrub hook waits for response completion while requesting an SSE stream. | Treat pinned-time interaction as unverified; rehearse separately before promising it on camera. No repair performed here. |
| P1 | Fallback/calibration and scenario approximation paths exist in source. | Demonstrate only after permitted runtime checks. Do not call fallback uncertainty clinically calibrated or universally safe. |

## Two parallel workstreams

**Independent of EW-01 governance:** finish team metadata, license review, architecture/deck/video preparation, claim review, asset accessibility planning and reproducibility instructions. Later ordinary demo inference requires its own permission and approved data scope; it is not authorized by these drafts.

**Dependent on EW-01 governance:** new construction/preparation/sealing, scientific alert scoring, any EW-01 performance conclusion, registry changes, M-15 and mandatory migrations. Member 2's OD-20 field remains blank in the inspected decision record. Exactly two approved constructions remain the limit. No protected or quarantined material enters this package.

## Proposed completion schedule

- **12–13 Oct:** confirm rules/team/URLs; agree exact current-feature story; assign draft owners.
- **14–16 Oct:** after separate authorization, verify an ordinary replay demonstration and installation; build deck/diagram exports. Continue governance decisions separately.
- **17–18 Oct:** record the 22-minute video; review every spoken/visual claim against the ledger. Omit unvalidated results if EW-01 is still blocked.
- **19 Oct:** anonymous-access and clean-machine release review, links, licensing and final claim checks.
- **20 Oct by 17:00 IST:** proposed internal submission target, leaving two hours before the listed deadline. Actual publication/submission requires the owner's action.

Do not delay the complete prototype submission indefinitely for an optional uncompleted experiment. Do not bypass a mandatory gate to obtain a result.
