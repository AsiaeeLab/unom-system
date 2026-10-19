#!/usr/bin/env python3
"""Upload the synthetic test-vector charts to the public SMART R4 sandbox.

Each source chart is converted from a collection Bundle to a transaction
Bundle. Dates are shifted from the fixtures' scoring date to the upload date so
the live app sees the same relative history. Every transaction entry uses PUT
ResourceType/id, so rerunning this script replaces a resource with the same ID
instead of creating a duplicate. IDs and references are not changed.

Only FHIR date, dateTime, and instant elements are shifted (a code such as
RxNorm 8787 looks like a year but is not a date). Three exceptions keep the
live chart showing what the clinician demo shows:
  - a COVID-19 diagnosis dated before the Long COVID model's earliest index
    date keeps its date, so it stays outside the model's population;
  - a record dated after the fixtures' scoring date (it tests that the scorer
    ignores later records) moves FUTURE_GAP_DAYS further out, so the live app,
    which scores as of today, keeps ignoring it for months;
  - the four demo personas also get the patient app answers the demo attaches
    (questionnaires/<name>.json, written by web/tools/write-demo-questionnaires.mjs).

The live app scores as of today, so a chart stays valid only while its records
stay in the same windows; web/tools/smart-parity.mjs reports how many days each
chart has left. Rerun this script to re-anchor the charts to a new date.
"""

from __future__ import annotations

import argparse
import copy
import datetime as dt
import json
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any


HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "reference"))
from score_fhir import resource_date  # noqa: E402  (the scorer's own choice of a record's date)

FHIR_SERVER = "https://r4.smarthealthit.org"
BUNDLES_DIR = HERE / "bundles"
QUESTIONNAIRES_DIR = HERE / "questionnaires"
SOURCE_AS_OF = dt.date(2024, 6, 1)
LONG_COVID_EARLIEST_INDEX = dt.date(2021, 7, 2)
FUTURE_GAP_DAYS = 365
FHIR_DATE = re.compile(r"^(\d{4})(?:-(\d{2})(?:-(\d{2})(T.*)?)?)?$")
# FHIR date, dateTime, and instant elements that are not named *Date, *DateTime, or *Instant
DATE_ELEMENTS = frozenset({"start", "end", "issued", "authored", "authoredOn", "date", "recorded", "created"})


def is_date_element(key: str) -> bool:
    return key in DATE_ELEMENTS or key.endswith(("Date", "DateTime", "Instant"))


def load_bundle(path: Path) -> dict[str, Any]:
    with path.open(encoding="utf-8") as source:
        bundle = json.load(source)
    if bundle.get("resourceType") != "Bundle" or bundle.get("type") != "collection":
        raise ValueError(f"{path}: expected a FHIR collection Bundle")
    if not isinstance(bundle.get("entry"), list) or not bundle["entry"]:
        raise ValueError(f"{path}: bundle has no entries")
    return bundle


def shift_date(value: str, days: int, *, birth_date: bool = False) -> str:
    """Shift a FHIR date/dateTime, resolving partial dates like the scorer."""
    match = FHIR_DATE.fullmatch(value)
    if not match:
        return value
    year, month, day, suffix = match.groups()
    try:
        if day:
            base = dt.date(int(year), int(month), int(day))
        elif month:
            base = dt.date(int(year), int(month), 15 if birth_date else 1)
        else:
            base = dt.date(int(year), 7 if birth_date else 1, 1)
    except ValueError:
        return value
    shifted = base + dt.timedelta(days=days)
    return shifted.isoformat() + (suffix or "")


def shift_bundle_dates(bundle: dict[str, Any], target_as_of: dt.date) -> dict[str, Any]:
    """Return a deep copy with FHIR dates moved to target_as_of."""
    days = (target_as_of - SOURCE_AS_OF).days
    shifted = copy.deepcopy(bundle)

    def resource_shift(resource: dict[str, Any]) -> int | None:
        """Days to move this resource's dates, or None to keep them."""
        if is_pre_cutoff_covid(resource):
            return None
        when = resource_date(resource)
        if when is not None and when > SOURCE_AS_OF:
            return days + FUTURE_GAP_DAYS
        return days

    def is_pre_cutoff_covid(resource: dict[str, Any]) -> bool:
        if resource.get("resourceType") != "Condition":
            return False
        codings = resource.get("code", {}).get("coding", [])
        is_covid = any(
            coding.get("system") == "http://hl7.org/fhir/sid/icd-10-cm"
            and str(coding.get("code", "")).replace(".", "").upper().startswith("U071")
            for coding in codings
        )
        onset = resource.get("onsetDateTime")
        match = FHIR_DATE.fullmatch(onset) if isinstance(onset, str) else None
        if not is_covid or not match or not match.group(2) or not match.group(3):
            return False
        try:
            onset_date = dt.date(*(int(part) for part in match.groups()[:3]))
        except ValueError:
            return False
        return onset_date < LONG_COVID_EARLIEST_INDEX

    def visit(value: Any, key: str = "", shift: int | None = days) -> Any:
        if isinstance(value, dict):
            if value.get("resourceType") not in (None, "Bundle"):
                shift = resource_shift(value)
            return {child_key: visit(child, child_key, shift) for child_key, child in value.items()}
        if isinstance(value, list):
            return [visit(child, key, shift) for child in value]
        if isinstance(value, str) and shift is not None and is_date_element(key):
            return shift_date(value, shift, birth_date=key == "birthDate")
        return value

    return visit(shifted)


def questionnaire_entries(name: str) -> list[dict[str, Any]]:
    """The demo's patient app answers for this persona as collection entries, or none."""
    path = QUESTIONNAIRES_DIR / f"{name}.json"
    if not path.exists():
        return []
    with path.open(encoding="utf-8") as source:
        resource = json.load(source)
    if resource.get("resourceType") != "QuestionnaireResponse":
        raise ValueError(f"{path}: expected a QuestionnaireResponse")
    if resource.get("subject", {}).get("reference") != f"Patient/{name}":
        raise ValueError(f"{path}: subject must be Patient/{name}")
    return [{"resource": resource}]


def load_chart(path: Path) -> dict[str, Any]:
    """A test-vector bundle plus the persona's questionnaire answers, if it has any."""
    bundle = load_bundle(path)
    bundle["entry"] = bundle["entry"] + questionnaire_entries(path.stem)
    return bundle


def transaction_for(
    bundle: dict[str, Any], path: Path, target_as_of: dt.date
) -> dict[str, Any]:
    """Shift a chart and wrap its resources in idempotent PUT entries."""
    shifted_bundle = shift_bundle_dates(bundle, target_as_of)
    transaction: dict[str, Any] = {
        "resourceType": "Bundle",
        "type": "transaction",
        "entry": [],
    }
    seen: set[str] = set()
    patient_ids: list[str] = []

    for source_entry in shifted_bundle["entry"]:
        resource = source_entry.get("resource")
        if not isinstance(resource, dict):
            raise ValueError(f"{path}: entry has no resource")
        resource_type = resource.get("resourceType")
        resource_id = resource.get("id")
        if not isinstance(resource_type, str) or not isinstance(resource_id, str):
            raise ValueError(f"{path}: every resource needs resourceType and id")
        target = f"{resource_type}/{resource_id}"
        if target in seen:
            raise ValueError(f"{path}: duplicate resource {target}")
        seen.add(target)
        if resource_type == "Patient":
            patient_ids.append(resource_id)

        entry: dict[str, Any] = {
            "resource": resource,
            "request": {"method": "PUT", "url": target},
        }
        if "fullUrl" in source_entry:
            entry["fullUrl"] = source_entry["fullUrl"]
        transaction["entry"].append(entry)

    if len(patient_ids) != 1:
        raise ValueError(f"{path}: expected exactly one Patient, found {len(patient_ids)}")
    return transaction


def patient_id(transaction: dict[str, Any]) -> str:
    return next(
        entry["resource"]["id"]
        for entry in transaction["entry"]
        if entry["resource"]["resourceType"] == "Patient"
    )


def upload(transaction: dict[str, Any], timeout: float) -> dict[str, Any]:
    body = json.dumps(transaction, separators=(",", ":")).encode("utf-8")
    request = urllib.request.Request(
        FHIR_SERVER,
        data=body,
        method="POST",
        headers={
            "Accept": "application/fhir+json",
            "Content-Type": "application/fhir+json",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            result = json.load(response)
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"sandbox returned HTTP {error.code}: {detail}") from error
    except urllib.error.URLError as error:
        raise RuntimeError(f"could not reach sandbox: {error.reason}") from error

    if result.get("resourceType") != "Bundle" or result.get("type") not in {
        "transaction-response",
        "batch-response",
    }:
        raise RuntimeError(f"sandbox returned an unexpected response: {json.dumps(result)}")
    entries = result.get("entry", [])
    expected = len(transaction["entry"])
    if len(entries) != expected:
        raise RuntimeError(f"sandbox returned {len(entries)} results for {expected} resources")
    failures = []
    for index, entry in enumerate(entries):
        status = str(entry.get("response", {}).get("status", ""))
        if not status.startswith(("200", "201", "204")):
            target = transaction["entry"][index]["request"]["url"]
            failures.append(f"{target}: {status or 'missing status'}")
    if failures:
        raise RuntimeError("sandbox rejected transaction entries: " + "; ".join(failures))
    return result


def choose_paths(names: list[str]) -> list[Path]:
    available = {path.stem: path for path in BUNDLES_DIR.glob("*.json")}
    if not names:
        return [available[name] for name in sorted(available)]
    unknown = sorted(set(names) - available.keys())
    if unknown:
        raise ValueError(
            f"unknown patient(s): {', '.join(unknown)}; "
            f"available: {', '.join(sorted(available))}"
        )
    return [available[name] for name in names]


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "PUT synthetic FHIR charts into the public SMART R4 sandbox. "
            "Existing resources with the same type and ID are overwritten."
        )
    )
    parser.add_argument(
        "patients",
        nargs="*",
        metavar="PATIENT",
        help="bundle filename without .json; omit to upload every patient",
    )
    parser.add_argument(
        "--as-of",
        type=dt.date.fromisoformat,
        default=dt.datetime.now(dt.timezone.utc).date(),
        help="date the live charts are scored; dates shift from 2024-06-01 (default: today UTC)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="validate and describe transactions without sending them",
    )
    parser.add_argument(
        "--timeout",
        type=float,
        default=60.0,
        help="HTTP timeout in seconds for each patient transaction (default: 60)",
    )
    parser.add_argument(
        "--write-dir",
        type=Path,
        help=(
            "also write each transaction to DIR/<patient>.json (for "
            "node web/tools/smart-parity.mjs --offline DIR)"
        ),
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    if args.timeout <= 0:
        raise ValueError("--timeout must be greater than zero")

    paths = choose_paths(args.patients)
    transactions = [
        (path, transaction_for(load_chart(path), path, args.as_of)) for path in paths
    ]
    action = "would upload" if args.dry_run else "uploaded"
    if args.write_dir:
        args.write_dir.mkdir(parents=True, exist_ok=True)
        for path, transaction in transactions:
            with (args.write_dir / f"{path.stem}.json").open("w", encoding="utf-8") as out:
                json.dump(transaction, out, indent=1)
                out.write("\n")

    for path, transaction in transactions:
        if not args.dry_run:
            upload(transaction, args.timeout)
        print(
            f"{action} {patient_id(transaction)}: {len(transaction['entry'])} resources "
            f"(as of {args.as_of.isoformat()})"
        )

    if args.dry_run:
        print(f"dry run complete: {len(transactions)} patient(s); no requests sent")
    else:
        print(f"complete: {len(transactions)} patient(s) uploaded to {FHIR_SERVER}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, RuntimeError, ValueError, json.JSONDecodeError) as error:
        print(f"error: {error}", file=sys.stderr)
        raise SystemExit(1) from error
