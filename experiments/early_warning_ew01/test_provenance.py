"""EW-01 construction, freshness-2 and sealing tests.

All data is synthetic, written in the generator's CSV schema by the tests themselves; no generator run,
protected reference or production key is involved. A fixture authority (a throwaway Ed25519 key in a
temporary registry) stands in for the designated authority so the real entry points can be exercised;
the CLIs pin the production registry and are shown to fail closed against it.
"""
import base64
import datetime
import hashlib
import json
import shutil
import stat
import subprocess
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ed25519

import ew01_trust as tr
import freshness2 as f2
import provenance_pipeline as pp
from ew01_construct import run_generation, start_slot
from ew01_trust import Blocked

EW01_DIR = Path(__file__).resolve().parent

# --------------------------------------------------------------------------- synthetic generator-schema data

EHR_HEADER = ",".join(f2.EHR_COLUMNS)
EHR_ROWS = [
    "P0001,45,M,25.3,0.123,7.1,Type 2,180.2,82.1,95.0,5.2,metformin;sglt2i,150.2,120.1,0.512,45.3,12.1",
    "P0002,33,F,22.0,0.05,8.0,Type 1,165.0,60.0,110.0,3.0,basal_insulin;prandial_insulin,160.0,130.0,0.9,40.0,10.0",
    "P0003,60,F,30.1,0.3,6.0,Prediabetes,160.5,77.5,80.0,0.0,,110.0,100.0,0.7,50.0,11.0",
]
N = 300
STAMPS = [(datetime.datetime(2026, 9, 28) + datetime.timedelta(minutes=5 * i)).strftime("%Y-%m-%d %H:%M:%S")
          for i in range(N)]
STAGES = ["Awake", "Light", "Deep", "REM"]


def glucose_tokens(k):
    toks = [f"{100 + k * 3 + (i * 7) % 61}.0" for i in range(N)]
    toks[150], toks[151] = "", "NaN"
    return toks


def telemetry_rows(k, pid, glucose=None):
    glucose = glucose or glucose_tokens(k)
    return [f"{pid},{STAMPS[i]},{glucose[i]},{60 + (i + k) % 9}.{i % 10},{40 + i % 13}.5,{STAGES[(i // 30) % 4]},"
            f"{(i * 11) % 50},{1 if i in (40, 200) else 0},{'45.0' if i in (40, 200) else '0.0'},0" for i in range(N)]


def raw_files(glucose_p1=None):
    tele = [",".join(f2.TELEMETRY_COLUMNS)]
    for k, pid in enumerate(["P0001", "P0002", "P0003"]):
        tele += telemetry_rows(k, pid, glucose_p1 if pid == "P0001" else None)
    truth = [",".join(f2.TRUTH_COLUMNS)] + [f"{pid},{STAMPS[i]},{120 + k}.25,{119 + k}.75"
                                             for k, pid in enumerate(["P0001", "P0002", "P0003"]) for i in range(N)]
    return {"patients_ehr.csv": "\n".join([EHR_HEADER] + EHR_ROWS) + "\n",
            "patient_cgm_telemetry.csv": "\n".join(tele) + "\n",
            "patient_cgm_truth.csv": "\n".join(truth) + "\n"}


def read(text, columns):
    return f2.read_csv_bytes(text.encode(), columns, "test")


def tele_df(glucose=None):
    return read("\n".join([",".join(f2.TELEMETRY_COLUMNS)] + telemetry_rows(0, "P0001", glucose)) + "\n",
                f2.TELEMETRY_COLUMNS)


def ehr_df(rows=EHR_ROWS[:1]):
    return read("\n".join([EHR_HEADER] + list(rows)) + "\n", f2.EHR_COLUMNS)


def dir_state(d):
    d = Path(d)
    return {f.name: (hashlib.sha256(f.read_bytes()).hexdigest(), stat.S_IMODE(f.stat().st_mode))
            for f in sorted(d.iterdir())} | {".": stat.S_IMODE(d.stat().st_mode)}


# --------------------------------------------------------------------------- fixture authority (tests only)


class FixtureAuthority:
    """A throwaway signer and registry. Never a production trust anchor: the CLIs pin the production path."""

    def __init__(self, tmp: Path):
        self.tmp = tmp
        self.key = ed25519.Ed25519PrivateKey.generate()
        self.root = tmp / "registry"
        self.reg = tr.Registry(self.root)
        (self.root / tr.CONSTRUCTION / "slots" / "A").mkdir(parents=True)
        (self.root / tr.CONSTRUCTION / "slots" / "B").mkdir()
        (self.root / tr.TRUST_ANCHOR_NAME).write_bytes(self.key.public_key().public_bytes(
            serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo))
        self.raw = {r: tmp / "gen" / r for r in tr.REPLICAS}
        self.prep = {r: tmp / "prep" / r for r in tr.REPLICAS}
        self.catalog_payload = {"record_type": tr.REFERENCE_CATALOG, "schema_id": f2.SCHEMA_ID,
                                "schema_digest": f2.SCHEMA_DIGEST,
                                "coverage": {"complete": True, "reference_sets": [{"name": "synthetic", "patients": 1}]},
                                "fingerprints": [], "non_protected_payloads": {}}
        self.write_catalog(self.catalog_payload)
        self.seed = 20261016
        self.seed_digest = self.sign(self.reg.seed_reservation, {
            "record_type": tr.SEED_RESERVATION, "experiment": tr.EXPERIMENT, "construction": tr.CONSTRUCTION,
            "generation_seed": self.seed})
        self.authorize()

    def sign(self, path, payload, key=None):
        sig = (key or self.key).sign(tr.SIGNING_CONTEXT + tr.canonical_json(payload))
        data = json.dumps({"payload": payload, "signature": base64.b64encode(sig).decode()}).encode()
        if path.exists():
            path.chmod(0o644)
            path.unlink()
        path.write_bytes(data)
        return hashlib.sha256(data).hexdigest()

    def write_catalog(self, payload):
        self.catalog_digest = self.sign(self.reg.catalog, payload)

    def authorization_payload(self, **over):
        commit = subprocess.run(["git", "-C", str(tr.REPO_ROOT), "rev-parse", "HEAD"], capture_output=True,
                                text=True, check=True).stdout.strip()
        p = {
            "record_type": tr.AUTHORIZATION, "experiment": tr.EXPERIMENT, "construction": tr.CONSTRUCTION,
            "replicas": list(tr.REPLICAS), "selected_replica": "A", "contract_digest": "c" * 64,
            "seed_reservation_digest": self.seed_digest,
            "generation": {"generator_path": tr.GENERATOR_PATH, "generator_commit": tr.GENERATOR_COMMIT,
                           "generator_source_sha256": tr.GENERATOR_SOURCE_SHA256, "generation_seed": self.seed,
                           "patients": 300, "days": 14, "write_truth": True,
                           "output_dirs": {r: str(self.raw[r]) for r in tr.REPLICAS}},
            "preparation": {"preparation_commit": commit, "config": tr.expected_preparation_config(),
                            "output_dirs": {r: str(self.prep[r]) for r in tr.REPLICAS}},
            "source_inventory": tr.source_inventory(),
            "environment": tr.environment_identity(),
            "freshness": {"schema_id": f2.SCHEMA_ID, "schema_digest": f2.SCHEMA_DIGEST,
                          "reference_catalog_sha256": self.catalog_digest},
        }
        p.update(over)
        return p

    def authorize(self, **over):
        self.auth_digest = self.sign(self.reg.authorization, self.authorization_payload(**over))

    def ctx(self):
        return tr.load_context(tr.open_authority(self.root), f2.SCHEMA_DIGEST)

    def generate(self, replica, files=None, **receipt_over):
        """Start the slot through the real entry point, write synthetic generator output, witness it."""
        start_slot(replica, registry_root=self.root)
        self.raw[replica].mkdir(parents=True)
        for name, text in (files or raw_files()).items():
            (self.raw[replica] / name).write_text(text)
        self.witness(replica, **receipt_over)

    def receipt_payload(self, slot, **over):
        ctx = self.ctx()
        start = self.reg.start(slot).read_bytes()
        raw_inv = tr.inventory({n: (self.raw[slot] / n).read_bytes() for n in tr.RAW_SCIENTIFIC})
        p = {"record_type": tr.GENERATION_RECEIPT, "experiment": tr.EXPERIMENT, "construction": tr.CONSTRUCTION,
             "replica": slot, "authorization_digest": self.auth_digest,
             "slot_start_digest": hashlib.sha256(start).hexdigest(), "contract_digest": "c" * 64,
             "generation_seed": self.seed, "seed_reservation_digest": self.seed_digest,
             "generator_path": tr.GENERATOR_PATH, "generator_commit": tr.GENERATOR_COMMIT,
             "generator_source_sha256": tr.GENERATOR_SOURCE_SHA256, "environment": ctx.auth["environment"],
             "argv": tr.canonical_generation_argv(ctx, slot),
             "effective_config": tr.expected_effective_config(ctx, slot),
             "output_dir": str(self.raw[slot]), "raw_inventory": raw_inv,
             "raw_inventory_digest": tr.digest_of(raw_inv), "witness": {"method": "WITNESSED_EXECUTION"}}
        p.update(over)
        return p

    def witness(self, slot, drop=(), **over):
        p = self.receipt_payload(slot, **over)
        for k in drop:
            p.pop(k)
        return self.sign(self.reg.receipt(slot), p)

    def prepare(self, replica, **kw):
        return pp.prepare_replica(replica, registry_root=self.root, **kw)

    def attest(self, replica):
        return self.sign(self.reg.attestation(replica),
                         pp.verify_preparation_independently(replica, registry_root=self.root))

    def compare(self):
        return self.sign(self.reg.comparison, pp.compare_replicas(registry_root=self.root))

    def construct(self, replica, files=None):
        self.generate(replica, files)
        self.prepare(replica)
        self.attest(replica)

    def full(self):
        self.construct("A")
        self.construct("B")
        self.compare()

    def seal(self, sealed=None, manifest=None):
        return pp.seal_construction(registry_root=self.root, sealed_dir=sealed or self.tmp / "sealed",
                                    manifest_path=manifest or self.tmp / "out" / "ew01_seal_manifest.json")

    def inputs_state(self):
        return {str(d): dir_state(d) for d in list(self.raw.values()) + list(self.prep.values()) if d.exists()}


@pytest.fixture
def fa(tmp_path):
    return FixtureAuthority(tmp_path)


@pytest.fixture
def sealed_world(fa):
    fa.full()
    return fa


# --------------------------------------------------------------------------- end to end


def test_e2e_two_constructions_seal_selected_replica_without_touching_inputs(sealed_world):
    fa = sealed_world
    before = fa.inputs_state()
    record = fa.seal()
    sealed = fa.tmp / "sealed"
    assert fa.inputs_state() == before  # bytes and modes: inputs are never made read-only
    assert dir_state(sealed) == {n: (hashlib.sha256((fa.prep["A"] / n).read_bytes()).hexdigest(), 0o444)
                                 for n in tr.PREPARED_ALL} | {".": 0o555}
    manifest = json.loads((fa.tmp / "out" / "ew01_seal_manifest.json").read_text())
    assert manifest == record and manifest["selected_replica"] == "A"
    h = hashlib.sha256()  # run_scientific.py's recomputation over the sealed directory
    for p in sorted(sealed.glob("*")):
        h.update(p.name.encode() + b":" + hashlib.sha256(p.read_bytes()).hexdigest().encode() + b"\n")
    assert manifest["cohort"]["cohort_artifact_sha256"] == h.hexdigest()
    assert manifest["generation_seed"] == 20261016
    # Prepared CSVs preserve every original byte except the mapped patient id.
    raw = (fa.raw["A"] / "patient_cgm_telemetry.csv").read_bytes().split(b"\n")
    prep = (sealed / "patient_cgm_telemetry.csv").read_bytes().split(b"\n")
    assert [r.partition(b",")[2] for r in raw] == [r.partition(b",")[2] for r in prep]
    assert prep[1].startswith(b"EW01-R1-P0001,") and b",NaN," in (sealed / "patient_cgm_telemetry.csv").read_bytes()
    assert json.loads((sealed / "cohort_ids.json").read_text()) == ["EW01-R1-P0001", "EW01-R1-P0003"]
    assert json.loads((sealed / "cohort_exclusions.json").read_text())["type_1"] == ["EW01-R1-P0002"]
    meal = np.load(sealed / "scientific_meal_log.npz")
    import train_pr_tft as T
    tele = pd.read_csv(fa.raw["A"] / "patient_cgm_telemetry.csv").query("patient_id == 'P0001'")
    exp_min, exp_carbs = T.observed_meal_log("EW01-R1-P0001", tele["meal_event"].to_numpy(),
                                             tele["carbs_g"].to_numpy(), 20260930, True)
    assert np.array_equal(meal["EW01-R1-P0001_min"], exp_min) and np.array_equal(meal["EW01-R1-P0001_carbs"], exp_carbs)
    sealed.chmod(0o755)


# --------------------------------------------------------------------------- mandatory negative controls


def test_nc1_prepared_bytes_and_local_provenance_changed_together_fail(sealed_world):
    fa = sealed_world
    prep = fa.prep["A"]
    tampered = (prep / "cohort_ids.json").read_bytes().replace(b'"EW01-R1-P0003"', b'"EW01-R1-P0002"')
    (prep / "cohort_ids.json").write_bytes(tampered)
    claim = json.loads((prep / "cohort_provenance.json").read_text())
    files = {n: (prep / n).read_bytes() for n in tr.PREPARED_SCIENTIFIC}
    claim["cohort_ids_sha256"] = hashlib.sha256(tampered).hexdigest()
    claim["prepared_scientific_inventory"] = tr.inventory(files, tr.PREPARED_SCIENTIFIC)
    (prep / "cohort_provenance.json").write_bytes(tr.canonical_json(claim))
    before = fa.inputs_state()
    with pytest.raises(Blocked, match="slot A prepared inventory vs signed attestation"):
        fa.seal()
    assert fa.inputs_state() == before and not (fa.tmp / "sealed").exists()


@pytest.mark.parametrize("over,drop,msg", [
    ({}, ("generation_seed",), "missing \\['generation_seed'\\]"),
    ({"generation_seed": 101}, (), "receipt generation seed"),
    ({"seed_reservation_digest": "0" * 64}, (), "receipt seed reservation"),
    ({"argv": ["backend/generate_health_data_v2.py", "--patients", "299"]}, (), "normalized argument vector"),
    ({"effective_config": {"patients": 300, "days": 14, "seed": 20261016, "out_dir": "/x", "write_truth": False}},
     (), "effective configuration"),
    ({"output_dir": "/tmp/elsewhere"}, (), "replica output location"),
    ({"environment": {"lock_sha256": "0" * 64, "runtime": {}}}, (), "receipt environment identity"),
    ({"replica": "B"}, (), "receipt replica"),
    ({"generator_source_sha256": "0" * 64}, (), "receipt generator source"),
    ({}, ("raw_inventory",), "missing \\['raw_inventory'\\]"),
    ({"witness": {"method": "SELF_REPORTED"}}, (), "witness method"),
])
def test_nc2_receipt_binding_mismatch_blocks_preparation(fa, over, drop, msg):
    fa.generate("A")
    fa.witness("A", drop=drop, **over)
    with pytest.raises(Blocked, match=msg):
        fa.prepare("A")
    assert not fa.prep["A"].exists()


def test_nc2_asserted_seed_and_raw_bytes_and_environment(fa):
    fa.generate("A")
    with pytest.raises(Blocked, match="asserted generation seed"):
        fa.prepare("A", assert_seed=20261014)
    with open(fa.raw["A"] / "patients_ehr.csv", "a") as f:
        f.write("P0004,1,M,1.0,0.0,1.0,Healthy,1.0,1.0,1.0,0.0,,1.0,1.0,1.0,1.0,1.0\n")
    with pytest.raises(Blocked, match="raw inventory vs signed receipt"):
        fa.prepare("A", assert_seed=20261016)
    assert not fa.prep["A"].exists()
    fa.authorize(environment={"lock_sha256": tr.environment_identity()["lock_sha256"],
                              "runtime": dict(tr.runtime_identity(), python_version="3.12.4")})
    with pytest.raises(Blocked, match="runtime environment mismatch"):
        fa.prepare("A")


def test_nc3_single_replica_blocks_comparison_and_seal(fa):
    fa.construct("A")
    with pytest.raises(Blocked, match="slot B lacks"):
        pp.compare_replicas(registry_root=fa.root)
    with pytest.raises(Blocked, match="slot B lacks"):
        fa.seal()


def test_nc3_duplicate_replica_blocks(fa):
    fa.construct("A")
    start_slot("B", registry_root=fa.root)
    shutil.copy(fa.reg.receipt("A"), fa.reg.receipt("B"))  # A's evidence presented as B
    with pytest.raises(Blocked, match="receipt replica"):
        fa.prepare("B")
    with pytest.raises(Blocked, match="distinct, non-nested"):
        tr.validate_authorization(fa.authorization_payload(
            generation=dict(fa.authorization_payload()["generation"],
                            output_dirs={"A": str(fa.raw["A"]), "B": str(fa.raw["A"])})), f2.SCHEMA_DIGEST)


def test_nc3_raw_mismatch_blocks_even_with_forged_match_attestation(fa):
    fa.construct("A")
    g = glucose_tokens(0)
    g[10] = "199.0"
    fa.construct("B", raw_files(glucose_p1=g))
    with pytest.raises(Blocked, match="raw scientific inventories of the two constructions differ"):
        pp.compare_replicas(registry_root=fa.root)
    ctx = fa.ctx()
    ev = {r: pp.replica_evidence(ctx, r, pp._catalog(ctx), False) for r in tr.REPLICAS}
    forged = pp._comparison_payload(ctx, ev)  # a "MATCH" record over A's inventories, signed anyway
    fa.sign(fa.reg.comparison, forged)
    before = fa.inputs_state()
    with pytest.raises(Blocked, match="raw scientific inventories of the two constructions differ"):
        fa.seal()
    assert fa.inputs_state() == before


def test_nc3_prepared_mismatch_blocks(fa):
    fa.construct("A")
    fa.generate("B")
    fa.prepare("B")
    ids = fa.prep["B"] / "cohort_ids.json"
    ids.write_bytes(tr.canonical_json(["EW01-R1-P0001"]))
    with pytest.raises(Blocked, match="differs from independent reproduction: \\['cohort_ids.json'\\]"):
        pp.verify_preparation_independently("B", registry_root=fa.root)
    # Even an authority that signed B's divergent output cannot get a comparison or a seal.
    claim = json.loads((fa.prep["B"] / "cohort_provenance.json").read_text())
    worker = {n: (fa.prep["B"] / n).read_bytes() for n in tr.PREPARED_ALL}
    inv = tr.inventory(worker)
    att = {k: v for k, v in claim.items() if k != "record_type"} | {
        "record_type": tr.PREPARATION_ATTESTATION, "cohort_ids_sha256": hashlib.sha256(ids.read_bytes()).hexdigest(),
        "prepared_scientific_inventory": tr.sub_inventory(inv, tr.PREPARED_SCIENTIFIC), "prepared_inventory": inv,
        "provenance_sha256": hashlib.sha256(worker["cohort_provenance.json"]).hexdigest(),
        "verification": {"method": "INDEPENDENT_REPRODUCTION", "reproduced_prepared_inventory_digest": tr.digest_of(inv)}}
    fa.sign(fa.reg.attestation("B"), att)
    with pytest.raises(Blocked, match="prepared scientific inventories of the two constructions differ"):
        pp.compare_replicas(registry_root=fa.root)
    with pytest.raises(Blocked, match="signed comparison attestation is absent"):
        fa.seal()


def test_nc4_third_construction_and_slot_reuse_rejected(fa):
    with pytest.raises(Blocked, match="'C' is not a reserved construction slot"):
        start_slot("C", registry_root=fa.root)
    fa.generate("A")
    with pytest.raises(Blocked, match="already holds construction evidence"):
        start_slot("A", registry_root=fa.root)
    fa.reg.receipt("A").unlink()
    with pytest.raises(Blocked, match="output location already exists"):
        start_slot("A", registry_root=fa.root)
    shutil.rmtree(fa.raw["A"])
    with pytest.raises(Blocked, match="already started; slots are never replenished"):
        start_slot("A", registry_root=fa.root)
    # A failed generation spends the slot; nothing retries it.
    start_slot("B", registry_root=fa.root)
    calls = []
    with pytest.raises(Blocked, match="exited 1; the slot is spent"):
        run_generation("B", registry_root=fa.root, runner=lambda argv, cwd: calls.append(argv) or
                       subprocess.CompletedProcess(argv, 1))
    assert len(calls) == 1 and calls[0][1:] == tr.canonical_generation_argv(fa.ctx(), "B")
    assert calls[0][1:] == ["backend/generate_health_data_v2.py", "--patients", "300", "--days", "14", "--seed",
                            "20261016", "--out-dir", str(fa.raw["B"]), "--write-truth"]
    with pytest.raises(Blocked, match="already started"):
        start_slot("B", registry_root=fa.root)
    # A third slot directory in the registry blocks preparation and sealing.
    (fa.reg.slots / "C").mkdir()
    with pytest.raises(Blocked, match="slots must be exactly"):
        fa.prepare("A")
    with pytest.raises(Blocked, match="slots must be exactly"):
        fa.seal()


def test_nc5_empty_and_nan_cgm_tokens_canonicalize_identically():
    g_empty, g_nan = glucose_tokens(0), glucose_tokens(0)
    g_empty[150] = g_empty[151] = ""
    g_nan[150] = g_nan[151] = "NaN"
    t_empty, t_nan = f2.parse_telemetry(tele_df(g_empty))[0], f2.parse_telemetry(tele_df(g_nan))[0]
    assert t_empty == t_nan
    assert t_empty.glucose_value[150] == 0 and t_empty.glucose_missing[150] == 1 and t_empty.glucose_missing[0] == 0
    for kind, body in f2.trajectory_bodies(t_empty).items():
        fp, pre = f2.fingerprint(kind, body, f2.SCHEMA_DIGEST)
        assert fp == f2.fingerprint(kind, f2.trajectory_bodies(t_nan)[kind], f2.SCHEMA_DIGEST)[0]
        assert b"NaN" not in pre and b"null" not in pre
    assert [w[1] for w in f2.window_fingerprints(t_empty, f2.SCHEMA_DIGEST)] == \
           [w[1] for w in f2.window_fingerprints(t_nan, f2.SCHEMA_DIGEST)]
    g_spelled = glucose_tokens(0)
    g_spelled[0] = g_spelled[0].removesuffix(".0")
    assert f2.parse_telemetry(tele_df(g_spelled))[0] == f2.parse_telemetry(tele_df())[0]


@pytest.mark.parametrize("token", ["nan", "NA", "null", "None", " ", "  ", "inf", "Infinity", "-inf", "1e2", "120.5",
                                   "120.", ".5", "0120", "+120", "-1", "N/A", " 120", "39", "401", "NaN "])
def test_nc5_invalid_cgm_tokens_fail(token):
    g = glucose_tokens(0)
    g[7] = token
    with pytest.raises(Blocked):
        f2.parse_telemetry(tele_df(g))


@pytest.mark.parametrize("column,token", [("heart_rate", ""), ("heart_rate", "NaN"), ("hrv", ""), ("sleep_stage", ""),
                                          ("sleep_stage", "NaN"), ("step_count", ""), ("carbs_g", "NaN"),
                                          ("meal_event", "2"), ("carbs_g", "45.05")])
def test_nc5_missing_non_cgm_telemetry_is_invalid(column, token):
    df = tele_df()
    df.loc[3, column] = token
    with pytest.raises(Blocked):
        f2.parse_telemetry(df)


def test_nc6_empty_medication_list_is_distinct_from_invalid_missing_input():
    row = EHR_ROWS[0]
    empty = row.replace("metformin;sglt2i", "")
    [(_, fields)] = f2.canonical_ehr(ehr_df([empty]))
    assert fields["med_classes"] == []
    assert f2.canonical_ehr(ehr_df([row]))[0][1]["med_classes"] == ["metformin", "sglt2i"]
    swapped = f2.canonical_ehr(ehr_df([row.replace("metformin;sglt2i", "sglt2i;metformin")]))[0][1]
    assert swapped["med_classes"] == ["sglt2i", "metformin"]
    digests = {f2.fingerprint("EHR", {"fields": f2.canonical_ehr(ehr_df([r]))[0][1]}, f2.SCHEMA_DIGEST)[0]["digest"]
               for r in [row, empty, row.replace("metformin;sglt2i", "sglt2i;metformin")]}
    assert len(digests) == 3
    for bad in ["metformin;", ";", "metformin;;sglt2i", "Metformin", "metformin;metformin", "nan", "NaN", " "]:
        with pytest.raises(Blocked, match="malformed med_classes"):
            f2.canonical_ehr(ehr_df([row.replace("metformin;sglt2i", bad)]))
    df = ehr_df([empty])
    with pytest.raises(Blocked, match="EHR columns"):
        f2.canonical_ehr(df.drop(columns=["med_classes"]))
    for null in [None, np.nan]:
        d = df.astype(object)
        d.loc[0, "med_classes"] = null
        with pytest.raises(Blocked, match="non-string or null"):
            f2.canonical_ehr(d)
    with pytest.raises(Blocked, match="malformed numeric"):
        f2.canonical_ehr(ehr_df([row.replace(",25.3,", ",,")]))


def test_nc7_version1_catalog_rejected_by_version2_verification(fa):
    authority = tr.open_authority(fa.root)
    v1 = {"coverage_complete": True, "ehr_fps": [], "tele_fps": [], "windows": []}
    v1_flat = dict(v1, signature=base64.b64encode(fa.key.sign(tr.canonical_json(v1))).decode())
    fa.reg.catalog.write_text(json.dumps(v1_flat))
    with pytest.raises(Blocked, match="not a signed authority record"):
        f2.verify_reference_catalog(authority, fa.reg.catalog, tr.sha256_bytes(fa.reg.catalog.read_bytes()),
                                    f2.SCHEMA_DIGEST)
    v1_wrapped = dict(v1, record_type=tr.REFERENCE_CATALOG)
    digest = fa.sign(fa.reg.catalog, v1_wrapped)
    with pytest.raises(Blocked, match="is None, not EW01-FRESHNESS-2"):
        f2.verify_reference_catalog(authority, fa.reg.catalog, digest, f2.SCHEMA_DIGEST)
    relabelled = dict(fa.catalog_payload, fingerprints=["a" * 64])  # v1 bare-hex fingerprints under a v2 label
    digest = fa.sign(fa.reg.catalog, relabelled)
    with pytest.raises(Blocked, match="reference fingerprint is not an object"):
        f2.verify_reference_catalog(authority, fa.reg.catalog, digest, f2.SCHEMA_DIGEST)
    v1_digest = hashlib.sha256(json.dumps(json.load(open(EW01_DIR / "EW01_FRESHNESS_1_SCHEMA.json")),
                                          sort_keys=True).encode()).hexdigest()
    mixed = dict(fa.catalog_payload, fingerprints=[{"kind": "CGM", "schema_id": "EW01-FRESHNESS-1",
                                                    "schema_digest": v1_digest, "digest": "a" * 64}])
    digest = fa.sign(fa.reg.catalog, mixed)
    with pytest.raises(Blocked, match="reference fingerprint schema id"):
        f2.verify_reference_catalog(authority, fa.reg.catalog, digest, f2.SCHEMA_DIGEST)
    with pytest.raises(Blocked, match="reference catalog schema digest"):
        f2.verify_reference_catalog(authority, fa.reg.catalog, fa.sign(fa.reg.catalog, dict(
            fa.catalog_payload, schema_digest=v1_digest)), f2.SCHEMA_DIGEST)


def test_nc8_lock_drift_or_runtime_mismatch_invalidates_verification(fa, tmp_path):
    expected = tr.environment_identity()
    assert tr.verify_environment(expected) == expected
    drifted = tmp_path / "requirements.txt"
    drifted.write_bytes(tr.LOCK_PATH.read_bytes() + b"\n")
    with pytest.raises(Blocked, match="environment lock drift"):
        tr.verify_environment(expected, drifted)
    with pytest.raises(Blocked, match="runtime environment mismatch"):
        tr.verify_environment(dict(expected, runtime=dict(expected["runtime"], machine="aarch64")))
    repinned = tmp_path / "repinned.txt"
    repinned.write_text(tr.LOCK_PATH.read_text().replace("numpy==2.5.3", "numpy==2.5.2"))
    with pytest.raises(Blocked, match="installed distributions do not match the lock: .*numpy 2.5.3 != 2.5.2"):
        tr.verify_environment({"lock_sha256": tr.sha256_bytes(repinned.read_bytes()), "runtime": expected["runtime"]},
                              repinned)
    fa.authorize(environment={"lock_sha256": "0" * 64, "runtime": expected["runtime"]})
    for call in [lambda: start_slot("A", registry_root=fa.root), lambda: fa.prepare("A"), lambda: fa.seal()]:
        with pytest.raises(Blocked, match="environment lock drift"):
            call()


def test_nc9_failed_or_refused_seal_does_not_mutate_inputs(sealed_world):
    fa = sealed_world
    before = fa.inputs_state()
    assert all(m[1] & stat.S_IWUSR for d in before.values() for k, m in d.items() if k != ".")
    existing = fa.tmp / "existing.json"
    existing.write_text("{}")
    fa.sign(fa.reg.comparison, dict(json.loads(fa.reg.comparison.read_text())["payload"], selected_replica="B"))
    with pytest.raises(Blocked, match="signed comparison attestation mismatch"):
        fa.seal()
    fa.reg.comparison.unlink()
    cases = [
        (dict(manifest=existing), "already exists"),
        (dict(sealed=fa.prep["A"] / "inner"), "overlaps a construction input"),
        (dict(), "signed comparison attestation is absent"),
    ]
    for kw, msg in cases:
        with pytest.raises(Blocked, match=msg):
            fa.seal(**kw)
        assert fa.inputs_state() == before
        assert not (fa.tmp / "sealed").exists() and not (fa.tmp / "out").exists()
    assert existing.read_text() == "{}"


def test_nc10_seal_cannot_overwrite_protected_manifests(sealed_world, tmp_path):
    fa = sealed_world
    data_manifest = tr.REPO_ROOT / "backend" / "data_manifest.json"
    original = data_manifest.read_bytes()
    link = tmp_path / "innocent.json"
    link.symlink_to(data_manifest)
    for manifest, msg in [(data_manifest, "already exists"),
                          (tr.REPO_ROOT / "runs" / "new_dir" / "seal.json", "protected location"),
                          (tmp_path / "elsewhere" / "data_manifest.json", "protected manifest"),
                          (tmp_path / "elsewhere" / "run_manifest.json", "protected manifest"),
                          (link, "already exists"),
                          (fa.root / "seal.json", "overlaps")]:
        with pytest.raises(Blocked, match=msg):
            fa.seal(manifest=manifest)
    linked_dir = tmp_path / "linkdir"
    linked_dir.symlink_to(tr.REPO_ROOT / "backend")
    with pytest.raises(Blocked, match="symlinked ancestor"):
        fa.seal(manifest=linked_dir / "fresh.json")
    assert data_manifest.read_bytes() == original
    assert not (tr.REPO_ROOT / "runs" / "new_dir").exists() and not (fa.tmp / "sealed").exists()


# --------------------------------------------------------------------------- authority records


def test_authority_signatures_types_and_strict_json(fa, tmp_path):
    authority = tr.open_authority(fa.root)
    assert authority.verify(fa.reg.authorization, tr.AUTHORIZATION).digest == fa.auth_digest
    with pytest.raises(Blocked, match="holds 'EW01_CONSTRUCTION_AUTHORIZATION', expected"):
        authority.verify(fa.reg.authorization, tr.GENERATION_RECEIPT)
    rec = json.loads(fa.reg.authorization.read_text())
    rec["payload"]["contract_digest"] = "d" * 64
    fa.reg.authorization.write_text(json.dumps(rec))
    with pytest.raises(Blocked, match="invalid authority signature"):
        authority.verify(fa.reg.authorization, tr.AUTHORIZATION)
    other = ed25519.Ed25519PrivateKey.generate()
    fa.sign(fa.reg.authorization, fa.authorization_payload(), key=other)
    with pytest.raises(Blocked, match="invalid authority signature"):
        fa.ctx()
    payload = fa.authorization_payload()
    no_context = base64.b64encode(fa.key.sign(tr.canonical_json(payload))).decode()  # v1-style signing
    fa.reg.authorization.write_text(json.dumps({"payload": payload, "signature": no_context}))
    with pytest.raises(Blocked, match="invalid authority signature"):
        fa.ctx()
    for raw, msg in [(b'{"payload": {"a": 1.5}, "signature": ""}', "non-integer"),
                     (b'{"payload": {"a": NaN}, "signature": ""}', "non-integer"),
                     (b'{"payload": {}, "payload": {}, "signature": ""}', "duplicate JSON key")]:
        fa.reg.authorization.write_bytes(raw)
        with pytest.raises(Blocked, match=msg):
            fa.ctx()


def test_authority_absent_or_misplaced_trust_root_fails_closed(fa, tmp_path):
    for root in [tmp_path / "absent", Path("relative/registry")]:
        with pytest.raises(Blocked):
            tr.open_authority(root)
    (fa.root / tr.TRUST_ANCHOR_NAME).unlink()
    with pytest.raises(Blocked, match="trust anchor is absent"):
        tr.open_authority(fa.root)
    inside = tr.REPO_ROOT / "experiments"
    with pytest.raises(Blocked, match="inside the repository"):
        tr.open_authority(inside)


def test_authorization_contract_checks(fa):
    base = fa.authorization_payload()
    bad = [
        (dict(replicas=["A", "B", "C"]), "exactly two constructions"),
        (dict(selected_replica="B"), "prospectively selected replica"),
        (dict(generation=dict(base["generation"], patients=299)), "authorized patients"),
        (dict(generation=dict(base["generation"], days=7)), "authorized days"),
        (dict(generation=dict(base["generation"], write_truth=False)), "authorized write_truth"),
        (dict(generation=dict(base["generation"], generation_seed=20260930)), "separate from the meal-log"),
        (dict(generation=dict(base["generation"], generation_seed="20261016")), "must be an integer"),
        (dict(preparation=dict(base["preparation"], config=dict(base["preparation"]["config"], meal_log_seed=1))),
         "preparation config"),
        (dict(freshness=dict(base["freshness"], reference_catalog_sha256=None)), "UNKNOWN: the custodian"),
        (dict(freshness=dict(base["freshness"], schema_id="EW01-FRESHNESS-1")), "authorized freshness schema"),
    ]
    for over, msg in bad:
        with pytest.raises(Blocked, match=msg):
            tr.validate_authorization(dict(base, **over), f2.SCHEMA_DIGEST)
    fa.sign(fa.reg.seed_reservation, {"record_type": tr.SEED_RESERVATION, "experiment": tr.EXPERIMENT,
                                      "construction": tr.CONSTRUCTION, "generation_seed": 20261017})
    with pytest.raises(Blocked, match="seed reservation digest"):
        fa.ctx()


def test_missing_catalog_is_unknown_not_zero_matches(fa):
    fa.generate("A")
    fa.reg.catalog.unlink()
    with pytest.raises(Blocked, match="UNKNOWN: protected-reference catalog absent"):
        fa.prepare("A")
    assert not fa.prep["A"].exists()
    authority = tr.open_authority(fa.root)
    for coverage, msg in [({"complete": False, "reference_sets": [{"name": "x"}]}, "incomplete reference coverage"),
                          ({"complete": True, "reference_sets": []}, "names no reference set")]:
        fa.write_catalog(dict(fa.catalog_payload, coverage=coverage))
        with pytest.raises(Blocked, match=msg):
            f2.verify_reference_catalog(authority, fa.reg.catalog, fa.catalog_digest, f2.SCHEMA_DIGEST)
    with pytest.raises(Blocked, match="reference catalog sha256 vs authorization"):
        f2.verify_reference_catalog(authority, fa.reg.catalog, "0" * 64, f2.SCHEMA_DIGEST)


def test_preparation_blocked_by_freshness_finding_before_any_output(fa):
    t = f2.parse_telemetry(read(raw_files()["patient_cgm_telemetry.csv"], f2.TELEMETRY_COLUMNS))[0]
    _, digest, low, _ = next(w for w in f2.window_fingerprints(t, f2.SCHEMA_DIGEST) if w[0] == 5)
    assert not low
    fa.write_catalog(dict(fa.catalog_payload, fingerprints=[{"kind": "WINDOW288", "schema_id": f2.SCHEMA_ID,
                                                             "schema_digest": f2.SCHEMA_DIGEST, "digest": digest}]))
    fa.authorize()
    fa.generate("A")
    with pytest.raises(Blocked, match="SUBSTANTIVE_WINDOW_MATCH P0001 UNKNOWN"):
        fa.prepare("A")
    assert not fa.prep["A"].exists()


# --------------------------------------------------------------------------- freshness-2 behaviour


def catalog_with(entries, disclosed=None):
    return f2.Catalog("0" * 64, {"complete": True}, frozenset(entries), disclosed or {})


def test_window_preimage_fast_path_matches_canonical_definition():
    t = f2.parse_telemetry(tele_df())[0]
    for offset, digest, low, pre in list(f2.window_fingerprints(t, f2.SCHEMA_DIGEST))[::5]:
        body = {"glucose_level": {"missing": t.glucose_missing[offset:offset + 288],
                                  "value": t.glucose_value[offset:offset + 288]}, "n": 288, "step_s": 300}
        assert pre == f2.preimage("WINDOW288", body, f2.SCHEMA_DIGEST)
        assert digest == hashlib.sha256(pre).hexdigest()
    assert len(list(f2.window_fingerprints(t, f2.SCHEMA_DIGEST))) == N - 288 + 1


def test_fingerprints_bind_kind_version_and_schema_digest():
    body = {"glucose_level": {"missing": [0], "value": [100]}, "n": 1, "step_s": 300}
    fp, pre = f2.fingerprint("CGM", body, f2.SCHEMA_DIGEST)
    assert fp["kind"] == "CGM" and fp["schema_id"] == "EW01-FRESHNESS-2" and fp["schema_digest"] == f2.SCHEMA_DIGEST
    assert f2.fingerprint("WINDOW288", body, f2.SCHEMA_DIGEST)[0]["digest"] != fp["digest"]
    assert f2.fingerprint("CGM", body, "1" * 64)[0]["digest"] != fp["digest"]
    assert json.loads(pre) == {"body": body, "fingerprint_kind": "CGM", "schema_digest": f2.SCHEMA_DIGEST,
                               "schema_id": "EW01-FRESHNESS-2"}


def test_schema_digest_is_pinned_and_csv_cells_are_strings():
    schema, digest = f2.load_schema()
    assert digest == f2.SCHEMA_DIGEST and schema["csv"]["na_inference"] is False
    assert digest != hashlib.sha256(json.dumps(json.load(open(EW01_DIR / "EW01_FRESHNESS_1_SCHEMA.json")),
                                               sort_keys=True).encode()).hexdigest()
    df = tele_df()
    assert df["glucose_level"].map(type).eq(str).all() and df.loc[150, "glucose_level"] == ""
    assert {f["name"]: f.get("scale") for f in schema["ehr"]["fields"] if f["type"] == "scaled_integer"} == {
        "age": 0, "bmi": 1, "genetic_risk_score": 3, "hba1c": 1, "height_cm": 1, "weight_kg": 1, "egfr": 0,
        "diabetes_duration_years": 1, "target_mean_glucose": 1, "basal_glucose": 1, "insulin_sensitivity_rel": 3,
        "tmax0_min": 1, "tau_isf_min": 1}


def test_ehr_scaled_integer_representation():
    [(pid, fields)] = f2.canonical_ehr(ehr_df())
    assert pid == "P0001" and fields == {
        "age": 45, "gender": "M", "bmi": 253, "genetic_risk_score": 123, "hba1c": 71, "diabetes_status": "Type 2",
        "height_cm": 1802, "weight_kg": 821, "egfr": 95, "diabetes_duration_years": 52,
        "med_classes": ["metformin", "sglt2i"], "target_mean_glucose": 1502, "basal_glucose": 1201,
        "insulin_sensitivity_rel": 512, "tmax0_min": 453, "tau_isf_min": 121}
    assert all(type(v) is not float for v in fields.values())
    same = f2.canonical_ehr(ehr_df([EHR_ROWS[0].replace(",0.123,", ",0.1230,").replace(",95.0,", ",95,")]))
    assert same[0][1] == fields
    for old, new in [(",45,", ",45.5,"), (",95.0,", ",95.5,"), (",0.123,", ",0.1234,"), (",25.3,", ",2.53e1,"),
                     (",M,", ",X,"), (",25.3,", ",-25.3,")]:
        with pytest.raises(Blocked):
            f2.canonical_ehr(ehr_df([EHR_ROWS[0].replace(old, new, 1)]))


def test_timestamp_grid_and_structure_validation():
    for i, bad in [(0, "2026-09-28T00:00:00"), (0, "2026-9-28 00:00:00"), (1, "2026-09-28 00:06:00"),
                   (1, "2026-02-30 00:05:00")]:
        df = tele_df()
        df.loc[i, "timestamp"] = bad
        with pytest.raises(Blocked):
            f2.parse_telemetry(df)
    df = tele_df()
    with pytest.raises(Blocked, match="duplicate timestamps"):
        f2.parse_telemetry(pd.concat([df, df.iloc[[-1]]], ignore_index=True))
    with pytest.raises(Blocked, match="telemetry columns"):
        f2.parse_telemetry(df.rename(columns={"glucose_level": "cgm_value"}))
    with pytest.raises(Blocked, match="header must be exactly"):
        f2.read_csv_bytes(b"patient_id,timestamp\nP0001,x\n", f2.TELEMETRY_COLUMNS, "t")
    body = "\n".join([",".join(f2.TELEMETRY_COLUMNS)] + telemetry_rows(0, "P0001")) + "\n"
    for bad in [body.replace("\n", "\n\n", 3), body + "P0001,x\n", body.replace(",Light,", ",Light,,", 1),
                ",".join(f2.TELEMETRY_COLUMNS) + "\n"]:
        with pytest.raises(Blocked, match="blank line or a row with the wrong number"):
            f2.read_csv_bytes(bad.encode(), f2.TELEMETRY_COLUMNS, "t")
    with pytest.raises(Blocked, match="quote"):
        f2.read_csv_bytes(('"' + ",".join(f2.TELEMETRY_COLUMNS) + '"\n').encode(), f2.TELEMETRY_COLUMNS, "t")


def test_matching_dispositions_preserved():
    ehr, tele = ehr_df(), tele_df()
    [(_, fields)] = f2.canonical_ehr(ehr)
    efp, epre = f2.fingerprint("EHR", {"fields": fields}, f2.SCHEMA_DIGEST)
    t = f2.parse_telemetry(tele)[0]
    cfp, cpre = f2.fingerprint("CGM", f2.trajectory_bodies(t)["CGM"], f2.SCHEMA_DIGEST)
    assert f2.check_freshness(ehr, tele, catalog_with([]), f2.SCHEMA_DIGEST)["disposition"] == "PASS"
    with pytest.raises(Blocked, match="EHR_MATCH P0001 REVIEW_REQUIRED"):
        f2.check_freshness(ehr, tele, catalog_with([("EHR", efp["digest"])], {efp["digest"]: epre.decode()}),
                           f2.SCHEMA_DIGEST)
    with pytest.raises(Blocked, match="EHR_MATCH P0001 UNKNOWN"):
        f2.check_freshness(ehr, tele, catalog_with([("EHR", efp["digest"])]), f2.SCHEMA_DIGEST)
    # A disclosed reference whose preimage differs is a collision, not a finding.
    assert f2.check_freshness(ehr, tele, catalog_with([("EHR", efp["digest"])], {efp["digest"]: "forged"}),
                              f2.SCHEMA_DIGEST)["findings"] == []
    with pytest.raises(Blocked, match="FULL_TRAJECTORY_MATCH P0001 BLOCK"):
        f2.check_freshness(ehr, tele, catalog_with([("CGM", cfp["digest"])], {cfp["digest"]: cpre.decode()}),
                           f2.SCHEMA_DIGEST)
    # Kind is bound: the same digest listed under another kind does not match.
    assert f2.check_freshness(ehr, tele, catalog_with([("HR", cfp["digest"])]), f2.SCHEMA_DIGEST)["findings"] == []


def test_splice_at_any_offset_and_low_information_windows():
    ref = [f"{100 + (i * 13) % 90}" for i in range(288)]
    ref_t = f2.parse_telemetry(tele_df(ref + ["120"] * 12))[0]
    ref_fp = next(f2.window_fingerprints(ref_t, f2.SCHEMA_DIGEST))[1]
    spliced = ["120"] * 7 + ref + ["120"] * 5
    with pytest.raises(Blocked, match="SUBSTANTIVE_WINDOW_MATCH P0001 UNKNOWN"):
        f2.check_freshness(ehr_df(), tele_df(spliced), catalog_with([("WINDOW288", ref_fp)]), f2.SCHEMA_DIGEST)
    nudged = ["120"] * 7 + ref[:-1] + ["121"] + ["120"] * 5
    assert f2.check_freshness(ehr_df(), tele_df(nudged), catalog_with([("WINDOW288", ref_fp)]),
                              f2.SCHEMA_DIGEST)["findings"] == []
    floor = ["40"] * 150 + ["NaN"] * 50 + ["120"] * 100  # windows with < 2 distinct values inside (40, 400)
    t = f2.parse_telemetry(tele_df(floor))[0]
    windows = list(f2.window_fingerprints(t, f2.SCHEMA_DIGEST))
    assert windows[0][2] and not windows[0][3].count(b"NaN")
    with pytest.raises(Blocked, match="LOW_INFORMATION_WINDOW_MATCH P0001 UNKNOWN"):
        f2.check_freshness(ehr_df(), tele_df(floor), catalog_with([("WINDOW288", windows[0][1])]), f2.SCHEMA_DIGEST)
    assert len(f2.parse_telemetry(tele_df(["100"] * N))) == 1
    assert [w[2] for w in f2.window_fingerprints(f2.parse_telemetry(tele_df(["100", "120"] * 150))[0],
                                                 f2.SCHEMA_DIGEST)] == [False] * 13


def test_truth_and_labels_never_enter_fingerprints():
    df = tele_df()
    t0 = f2.parse_telemetry(df)[0]
    df["future_spike_2h"] = "1"
    assert f2.parse_telemetry(df)[0] == t0
    schema, _ = f2.load_schema()
    assert schema["truth"]["fingerprinted"] is False
    assert "future_spike_2h" not in {f["name"] for f in schema["telemetry"]["fields"]}


# --------------------------------------------------------------------------- CLIs against the pinned registry


@pytest.mark.parametrize("argv", [
    ["prepare_cohort.py", "--replica", "A"],
    ["prepare_cohort.py", "--replica", "A", "--assert-seed", "20261016"],
    ["seal_cohort.py", "--sealed-dir", "{tmp}/sealed", "--manifest", "{tmp}/m.json"],
    ["ew01_construct.py", "start", "--replica", "A"],
    ["ew01_construct.py", "generate", "--replica", "A"],
    ["ew01_construct.py", "verify-preparation", "--replica", "A"],
    ["ew01_construct.py", "compare"],
])
def test_cli_fails_closed_without_the_designated_authority(tmp_path, argv):
    assert not tr.PRODUCTION_REGISTRY_ROOT.exists(), "test assumes no production registry on this host"
    args = [a.format(tmp=tmp_path) for a in argv]
    res = subprocess.run([sys.executable, str(EW01_DIR / args[0]), *args[1:]], capture_output=True, text=True,
                         cwd=tmp_path)
    assert res.returncode == 1, res.stderr
    assert "BLOCKED: designated authority registry is not provisioned" in res.stderr
    assert list(tmp_path.iterdir()) == [] and not tr.PRODUCTION_REGISTRY_ROOT.exists()


# --------------------------------------------------------------------------- environment lock


def test_i1_lock_pins_every_requirement_with_hashes():
    pins = tr.parse_lock()
    assert {"cryptography", "cffi", "pycparser", "setuptools", "pip"} <= pins.keys()


def test_i2_lock_covers_ew01_imports_and_dependency_closure():
    """Every distribution imported by the EW-01 path is pinned at its installed version, and every
    dependency (markers evaluated for this interpreter) of every pinned distribution is pinned."""
    import importlib.metadata as md
    from packaging.requirements import Requirement
    import ew01_construct, prepare_cohort, seal_cohort, train_pr_tft  # noqa: F401  (the EW-01 execution path)
    pins = tr.parse_lock()
    p2d = md.packages_distributions()
    imported = {tr.normalize_dist(d) for m in list(sys.modules) for d in p2d.get(m.split(".")[0], [])}
    assert {"cryptography", "numpy", "pandas", "torch", "lightning"} <= imported
    assert sorted(imported - pins.keys()) == []
    for name in pins:
        assert md.version(name) == pins[name], f"installed {name} {md.version(name)} != locked {pins[name]}"
        for r in md.requires(name) or []:
            req = Requirement(r)
            if req.marker is None or req.marker.evaluate({"extra": ""}):
                assert tr.normalize_dist(req.name) in pins, f"{name} requires {req.name}, which is not locked"
                assert req.specifier.contains(pins[tr.normalize_dist(req.name)], prereleases=True)
