"""EW01-FRESHNESS-2: strict parsing of generator-schema CSVs and versioned, kind-bound fingerprints.

Cells are read as strings with NA inference disabled. Values become integers on the field's approved
scale; only glucose_level may be missing (the empty token or the case-sensitive "NaN"), and a missing
reading is canonicalized as value 0 with missingness mask 1. Every fingerprint's preimage binds its
kind, the schema id and the schema digest, so a fingerprint from any other schema version can never
match. The 288-position window checks and the match dispositions are those adopted for version 1.
"""
from __future__ import annotations

import hashlib
import io
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pandas as pd

from ew01_trust import (HEX64, REFERENCE_CATALOG, Authority, Blocked, canonical_json, read_regular_file,
                        require_equal, require_hex, require_keys, sha256_bytes, strict_json)

SCHEMA_PATH = Path(__file__).resolve().parent / "EW01_FRESHNESS_2_SCHEMA.json"
SCHEMA_ID = "EW01-FRESHNESS-2"
# Published digest of EW01_FRESHNESS_2_SCHEMA.json; any edit to the schema must change this pin.
SCHEMA_DIGEST = "b0f5652e3c3df86cd54830b556039cc0f66911d6d11a8223ca03aeae73086846"
STEP_S = 300
WINDOW = 288
KINDS = ("EHR", "CGM", "HR", "MULTI", "WINDOW288")
GLUCOSE_MISSING_TOKENS = ("", "NaN")
NUMERIC = r"(?:0|[1-9][0-9]*)(?:\.[0-9]+)?"


def load_schema() -> tuple[dict, str]:
    schema = strict_json(read_regular_file(SCHEMA_PATH, "freshness schema"), "freshness schema")
    digest = sha256_bytes(canonical_json(schema))
    if digest != SCHEMA_DIGEST:
        raise Blocked(f"BLOCKED: {SCHEMA_PATH.name} digest {digest} is not the published {SCHEMA_DIGEST}")
    require_equal(schema.get("schema_id"), SCHEMA_ID, "freshness schema id")
    return schema, digest


SCHEMA, _ = load_schema()
TELEMETRY_COLUMNS = SCHEMA["telemetry"]["columns"]
TELEMETRY_FIELDS = {f["name"]: f for f in SCHEMA["telemetry"]["fields"]}
EHR_COLUMNS = SCHEMA["ehr"]["columns"]
EHR_FIELDS = {f["name"]: f for f in SCHEMA["ehr"]["fields"]}
TRUTH_COLUMNS = SCHEMA["truth"]["columns"]
SLEEP_CODES = TELEMETRY_FIELDS["sleep_stage"]["codes"]
MED_VOCABULARY = frozenset(EHR_FIELDS["med_classes"]["vocabulary"])


# --------------------------------------------------------------------------- CSV reading


def read_csv_bytes(data: bytes, columns: list[str], what: str) -> pd.DataFrame:
    """Every cell as a Python string, NA inference off; the header must be exactly `columns`."""
    if b"\r" in data or b'"' in data:
        raise Blocked(f"BLOCKED: {what} contains a carriage return or quote; generator output has neither")
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        raise Blocked(f"BLOCKED: {what} is not UTF-8") from None
    lines = text.split("\n")
    if lines[-1] != "" or lines[0] != ",".join(columns):
        raise Blocked(f"BLOCKED: {what} header must be exactly {','.join(columns)} and the file must end in a newline")
    commas = len(columns) - 1
    if len(lines) < 3 or any(line.count(",") != commas for line in lines[1:-1]):
        raise Blocked(f"BLOCKED: {what} has an empty body, a blank line or a row with the wrong number of fields")
    try:
        df = pd.read_csv(io.StringIO(text), dtype=str, keep_default_na=False, na_filter=False)
    except (ValueError, pd.errors.ParserError) as e:
        raise Blocked(f"BLOCKED: {what} is not parseable: {e}") from None
    if len(df) != len(lines) - 2:
        raise Blocked(f"BLOCKED: {what} row count changed while parsing")
    require_strings(df, what)
    return df


def require_strings(df: pd.DataFrame, what: str) -> None:
    """In-memory frames must hold only str cells: a None/NaN/number means the input was not read as text."""
    for c in df.columns:
        if not df[c].map(type).eq(str).all():
            raise Blocked(f"BLOCKED: {what} column {c} holds a non-string or null cell")


def scaled_integers(s: pd.Series, scale: int, field: str) -> np.ndarray:
    ok = s.str.fullmatch(NUMERIC)
    if not ok.all():
        raise Blocked(f"BLOCKED: {field}: malformed numeric token {s[~ok].iloc[0]!r}")
    parts = s.str.partition(".")
    whole, frac = parts[0], parts[2]
    if (frac.str.slice(scale).str.strip("0") != "").any():
        bad = s[frac.str.slice(scale).str.strip("0") != ""].iloc[0]
        raise Blocked(f"BLOCKED: {field}: excess precision for scale {scale}: {bad!r}")
    if (whole.str.len() + scale > 15).any():
        raise Blocked(f"BLOCKED: {field}: value out of range")
    digits = whole + frac.str.slice(0, scale).str.pad(scale, side="right", fillchar="0") if scale else whole
    return digits.astype("int64").to_numpy()


def _bounded(values: np.ndarray, spec: dict, field: str) -> np.ndarray:
    if ("min" in spec and (values < spec["min"]).any()) or ("max" in spec and (values > spec["max"]).any()):
        raise Blocked(f"BLOCKED: {field} out of bounds [{spec.get('min')}, {spec.get('max')}]")
    return values


# --------------------------------------------------------------------------- telemetry


@dataclass(frozen=True)
class Trajectory:
    pid: str
    glucose_value: list[int]
    glucose_missing: list[int]
    channels: dict[str, list[int]]  # heart_rate, hrv, sleep_stage, step_count, meal_event, carbs_g


def parse_glucose(s: pd.Series) -> tuple[np.ndarray, np.ndarray]:
    """Empty or case-sensitive "NaN" is missing; anything else must be a valid in-range reading."""
    missing = s.isin(GLUCOSE_MISSING_TOKENS).to_numpy()
    values = np.zeros(len(s), dtype=np.int64)
    observed = s[~missing]
    if len(observed):
        values[~missing] = _bounded(scaled_integers(observed, 0, "glucose_level"), TELEMETRY_FIELDS["glucose_level"],
                                    "glucose_level")
    return values, missing.astype(np.int64)


def parse_telemetry(df: pd.DataFrame) -> list[Trajectory]:
    require_strings(df, "telemetry")
    if list(df.columns) != TELEMETRY_COLUMNS:
        raise Blocked(f"BLOCKED: telemetry columns must be exactly {TELEMETRY_COLUMNS}")
    if not df["patient_id"].str.fullmatch(r"P[0-9]{4}").all():
        raise Blocked("BLOCKED: telemetry patient_id is not a generator patient id")
    if not df["timestamp"].str.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}").all():
        raise Blocked("BLOCKED: invalid timestamp format")
    stamps = pd.to_datetime(df["timestamp"], format="%Y-%m-%d %H:%M:%S", errors="coerce")
    if stamps.isna().any():
        raise Blocked("BLOCKED: invalid timestamp value")
    if not df["future_spike_2h"].isin(SCHEMA["telemetry"]["validated_not_fingerprinted"]["future_spike_2h"]).all():
        raise Blocked("BLOCKED: future_spike_2h must be 0 or 1")
    gl_value, gl_missing = parse_glucose(df["glucose_level"])
    channels = {}
    for name in ("heart_rate", "hrv", "step_count", "meal_event", "carbs_g"):
        spec = TELEMETRY_FIELDS[name]
        channels[name] = _bounded(scaled_integers(df[name], spec["scale"], name), spec, name)
    if not df["sleep_stage"].isin(list(SLEEP_CODES)).all():
        bad = df.loc[~df["sleep_stage"].isin(list(SLEEP_CODES)), "sleep_stage"].iloc[0]
        raise Blocked(f"BLOCKED: invalid or missing sleep stage {bad!r}")
    channels["sleep_stage"] = df["sleep_stage"].map(SLEEP_CODES).to_numpy(dtype=np.int64)

    out, seen = [], set()
    pid_col = df["patient_id"].to_numpy()
    starts = np.flatnonzero(np.r_[True, pid_col[1:] != pid_col[:-1]])
    ends = np.r_[starts[1:], len(df)]
    ns = stamps.to_numpy().astype("datetime64[s]").astype(np.int64)
    for a, b in zip(starts, ends):
        pid = pid_col[a]
        if pid in seen:
            raise Blocked(f"BLOCKED: telemetry rows of {pid} are not contiguous")
        seen.add(pid)
        if b - a > 1 and not (np.diff(ns[a:b]) == STEP_S).all():
            if len(set(ns[a:b])) != b - a:
                raise Blocked(f"BLOCKED: duplicate timestamps for {pid}")
            raise Blocked(f"BLOCKED: incomplete or broken 5-minute grid for {pid}")
        out.append(Trajectory(pid, gl_value[a:b].tolist(), gl_missing[a:b].tolist(),
                              {k: v[a:b].tolist() for k, v in channels.items()}))
    return out


# --------------------------------------------------------------------------- EHR


def parse_med_classes(token: str) -> list[str]:
    if not isinstance(token, str):
        raise Blocked(f"BLOCKED: med_classes holds a non-string or null value {token!r}")
    if token == "":
        return []
    meds = token.split(";")
    if any(m not in MED_VOCABULARY for m in meds) or len(set(meds)) != len(meds):
        raise Blocked(f"BLOCKED: malformed med_classes {token!r}")
    return meds


def canonical_ehr(df: pd.DataFrame) -> list[tuple[str, dict]]:
    """[(raw patient id, {field: canonical value})] with the exact scaled-integer representation."""
    require_strings(df, "EHR")
    if list(df.columns) != EHR_COLUMNS:
        raise Blocked(f"BLOCKED: EHR columns must be exactly {EHR_COLUMNS}")
    if not df["patient_id"].str.fullmatch(r"P[0-9]{4}").all() or df["patient_id"].duplicated().any():
        raise Blocked("BLOCKED: EHR patient ids must be unique generator patient ids")
    cols: dict[str, list] = {}
    for name, spec in EHR_FIELDS.items():
        s = df[name]
        if spec["type"] == "scaled_integer":
            cols[name] = scaled_integers(s, spec["scale"], name).tolist()
        elif spec["type"] == "categorical":
            if not s.isin(spec["values"]).all():
                raise Blocked(f"BLOCKED: {name} has a value outside {spec['values']}")
            cols[name] = s.tolist()
        else:
            cols[name] = [parse_med_classes(v) for v in s]
    return [(pid, {name: cols[name][i] for name in EHR_FIELDS}) for i, pid in enumerate(df["patient_id"])]


# --------------------------------------------------------------------------- fingerprints


def preimage(kind: str, body: dict, schema_digest: str) -> bytes:
    if kind not in KINDS:
        raise Blocked(f"BLOCKED: unknown fingerprint kind {kind}")
    return canonical_json({"body": body, "fingerprint_kind": kind, "schema_digest": schema_digest,
                           "schema_id": SCHEMA_ID})


def fingerprint(kind: str, body: dict, schema_digest: str) -> tuple[dict, bytes]:
    pre = preimage(kind, body, schema_digest)
    return {"kind": kind, "schema_id": SCHEMA_ID, "schema_digest": schema_digest,
            "digest": hashlib.sha256(pre).hexdigest()}, pre


def trajectory_bodies(t: Trajectory) -> dict[str, dict]:
    n = len(t.glucose_value)
    gl = {"missing": t.glucose_missing, "value": t.glucose_value}
    multi = {name: {"value": v} for name, v in t.channels.items()}
    return {
        "CGM": {"glucose_level": gl, "n": n, "step_s": STEP_S},
        "HR": {"heart_rate": {"value": t.channels["heart_rate"]}, "n": n, "step_s": STEP_S},
        "MULTI": {**multi, "glucose_level": gl, "n": n, "step_s": STEP_S},
    }


def window_fingerprints(t: Trajectory, schema_digest: str):
    """Yield (offset, digest, low_information) for every 288 consecutive positions.

    The preimage is assembled from tokens for speed; it is byte-identical to
    preimage("WINDOW288", {"glucose_level": {...}, "n": 288, "step_s": 300}, schema_digest)."""
    head = b'{"body":{"glucose_level":{"missing":['
    mid = b'],"value":['
    tail = (b']},"n":%d,"step_s":%d},"fingerprint_kind":"WINDOW288","schema_digest":"%s","schema_id":"%s"}'
            % (WINDOW, STEP_S, schema_digest.encode(), SCHEMA_ID.encode()))
    vals = [str(v).encode() for v in t.glucose_value]
    miss = [str(m).encode() for m in t.glucose_missing]
    # Sliding count of observed values strictly inside (40, 400), for the low-information rule.
    inside = [None if m or not 40 < v < 400 else v for v, m in zip(t.glucose_value, t.glucose_missing)]
    counts: dict[int, int] = {}
    for j, v in enumerate(inside):
        if v is not None:
            counts[v] = counts.get(v, 0) + 1
        if j >= WINDOW:
            old = inside[j - WINDOW]
            if old is not None:
                counts[old] -= 1
                if not counts[old]:
                    del counts[old]
        if j >= WINDOW - 1:
            i = j - WINDOW + 1
            pre = head + b",".join(miss[i:i + WINDOW]) + mid + b",".join(vals[i:i + WINDOW]) + tail
            yield i, hashlib.sha256(pre).hexdigest(), len(counts) < 2, pre


# --------------------------------------------------------------------------- reference catalog


@dataclass(frozen=True)
class Catalog:
    digest: str
    coverage: dict
    references: frozenset  # {(kind, digest)}
    disclosed: dict  # {digest: preimage text} for non-protected references


def verify_reference_catalog(authority: Authority, path: Path, expected_sha256: str, schema_digest: str) -> Catalog:
    """An authority-signed EW01-FRESHNESS-2 catalog with complete coverage, or UNKNOWN/BLOCKED."""
    if not Path(path).exists():
        raise Blocked(f"UNKNOWN: protected-reference catalog absent at {path}; freshness is unresolved")
    rec = authority.verify(path, REFERENCE_CATALOG)
    require_equal(rec.digest, expected_sha256, "reference catalog sha256 vs authorization")
    p = rec.payload
    if p.get("schema_id") != SCHEMA_ID:
        raise Blocked(f"BLOCKED: reference catalog is {p.get('schema_id')!r}, not {SCHEMA_ID}; "
                      "catalogs of another schema version are never relabelled")
    require_keys(p, {"record_type", "schema_id", "schema_digest", "coverage", "fingerprints",
                     "non_protected_payloads"}, "reference catalog")
    require_equal(p["schema_digest"], schema_digest, "reference catalog schema digest")
    cov = require_keys(p["coverage"], {"complete", "reference_sets"}, "reference catalog coverage")
    if cov["complete"] is not True:
        raise Blocked("BLOCKED: incomplete reference coverage")
    if not isinstance(cov["reference_sets"], list) or not cov["reference_sets"]:
        raise Blocked("BLOCKED: reference coverage names no reference set")
    refs = set()
    if not isinstance(p["fingerprints"], list):
        raise Blocked("BLOCKED: reference fingerprints must be a list")
    for fp in p["fingerprints"]:
        require_keys(fp, {"kind", "schema_id", "schema_digest", "digest"}, "reference fingerprint")
        if fp["kind"] not in KINDS:
            raise Blocked(f"BLOCKED: unknown reference fingerprint kind {fp['kind']!r}")
        require_equal(fp["schema_id"], SCHEMA_ID, "reference fingerprint schema id")
        require_equal(fp["schema_digest"], schema_digest, "reference fingerprint schema digest")
        refs.add((fp["kind"], require_hex(fp["digest"], HEX64, "reference fingerprint digest")))
    disclosed = p["non_protected_payloads"]
    if not isinstance(disclosed, dict) or not all(isinstance(v, str) for v in disclosed.values()):
        raise Blocked("BLOCKED: non_protected_payloads must map digests to preimage text")
    return Catalog(rec.digest, cov, frozenset(refs), dict(disclosed))


# --------------------------------------------------------------------------- freshness check


def _match(catalog: Catalog, kind: str, digest: str, pre: bytes) -> str | None:
    if (kind, digest) not in catalog.references:
        return None
    if digest in catalog.disclosed:
        return "EXACT_MATCH" if catalog.disclosed[digest].encode("ascii") == pre else "COLLISION"
    return "UNKNOWN"


def check_freshness(ehr_df: pd.DataFrame, tele_df: pd.DataFrame, catalog: Catalog, schema_digest: str) -> dict:
    """Validation report for a fresh cohort; any finding blocks preparation."""
    findings, counts = [], {k: 0 for k in KINDS}

    def record(kind, typ, pid, digest, pre, exact_disposition, detail=None):
        status = _match(catalog, kind, digest, pre)
        if status in (None, "COLLISION"):
            return
        findings.append({"type": typ, "kind": kind, "candidate": pid, "reference": "OPAQUE",
                         "schema_id": SCHEMA_ID, "schema_digest": schema_digest, "digest": digest,
                         "detail": detail, "match": status,
                         "disposition": exact_disposition if status == "EXACT_MATCH" else "UNKNOWN"})

    for pid, fields in canonical_ehr(ehr_df):
        fp, pre = fingerprint("EHR", {"fields": fields}, schema_digest)
        counts["EHR"] += 1
        record("EHR", "EHR_MATCH", pid, fp["digest"], pre, "REVIEW_REQUIRED")
    for t in parse_telemetry(tele_df):
        for kind, body in trajectory_bodies(t).items():
            fp, pre = fingerprint(kind, body, schema_digest)
            counts[kind] += 1
            record(kind, "FULL_TRAJECTORY_MATCH", t.pid, fp["digest"], pre, "BLOCK")
        for offset, digest, low, pre in window_fingerprints(t, schema_digest):
            counts["WINDOW288"] += 1
            if low:
                record("WINDOW288", "LOW_INFORMATION_WINDOW_MATCH", t.pid, digest, pre, "REVIEW_REQUIRED", offset)
            else:
                record("WINDOW288", "SUBSTANTIVE_WINDOW_MATCH", t.pid, digest, pre, "BLOCK", offset)
    if findings:
        raise Blocked("BLOCKED: freshness check has blocking or unresolved findings: "
                      + "; ".join(f"{f['type']} {f['candidate']} {f['disposition']}" for f in findings[:20]))
    return {"schema_id": SCHEMA_ID, "schema_digest": schema_digest, "reference_catalog_sha256": catalog.digest,
            "reference_coverage": catalog.coverage, "candidate_fingerprint_counts": counts, "findings": [],
            "disposition": "PASS"}
