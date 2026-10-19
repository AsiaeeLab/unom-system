#!/usr/bin/env python3
"""Write release_manifest.json: what each deployed model file was built from and how it was checked.

For the Paper 4 release. For each deployed model the manifest records the model file hash (and
whether the site copy matches), the model version, the feature registry and aggregate input files with their
hashes, the fitting code with the commit that last changed it, the calibration fit, the evaluation target and
the released evaluation rows. It also records the scorer hashes (Python reference and JavaScript port), the
test vectors, the model contract version, the questionnaire version, the application files and the commit of
the working tree, and the commands that reproduce the checks. Contract version, model version, and application
release are kept apart.

Only aggregate files already released to results/aggregate/ are read; no participant-level data.

Usage, from the repository root:
    python3 analysis/build_release_manifest.py                       # print the manifest
    python3 analysis/build_release_manifest.py --out release_manifest.json
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import glob
import hashlib
import json
import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCHEMA = "unm-release-manifest/1"

SCORERS = ["model/reference/score_fhir.py", "web/web/shared/scorer.js"]
APPLICATION = ["web/web/shared/scorer.js", "web/web/athena/cards.js", "web/web/athena/fhir-data.js", "web/web/athena/rule.js",
               "web/web/athena/lyme-rule.js", "web/web/patient/instruments.js", "web/web/patient/scoring.js",
               "web/functions/cds-services/_cds.js", "web/functions/cds-services/invisible-illness.js",
               "web/functions/cds-services/index.js"]
TESTS = ["model/reference/test_score_fhir.py", "model/test_vectors/make_bundles.py"]
SELF_REPORT = ["chronicfatigue", "fibromyalgia", "endometriosis", "lyme", "lupus", "migraine", "depression", "anxiety"]
COMMANDS = [
    "python3 model/reference/test_score_fhir.py",
    "for m in longcovid " + " ".join(SELF_REPORT) + " longcovid.example; do python3 model/test_vectors/make_bundles.py "
    "model/$m.json; done; git diff --exit-code model/test_vectors",
    "cd web && npm test",
    "python3 analysis/build_longcovid_model.py --check",
    *[f"python3 analysis/build_cf_model.py --condition {m} --out /tmp/{m}.json && cmp /tmp/{m}.json model/{m}.json"
      for m in SELF_REPORT],
]

# What each deployed model was built from. Paths are relative to the repository root; globs are expanded.
MODELS = [
    {
        "file": "model/longcovid.json",
        "site_copy": "web/web/models/longcovid.json",
        "registry": ["workbench/src/features.yaml"],
        "aggregate_inputs": [
            "results/aggregate/35/t04_label_counts.csv", "results/aggregate/35/t04_feature_label_counts.csv",
            "results/aggregate/35/t04_feature_margins.csv", "results/aggregate/35/t04_pair_counts.csv",
            "results/aggregate/35/t35_guard_summary.csv",
            "results/aggregate/36/t05_transport_performance.csv", "results/aggregate/36/t05_calibration_nb_eb.csv",
            "results/aggregate/36/t17_site_performance.csv",
            "results/aggregate/02/t02_codelist_labs.csv", "results/aggregate/10/t10_codelist_drugs_part*.csv"],
        "fitting_code": ["analysis/fit_transport_model.py", "model/build_model.py", "analysis/build_longcovid_model.py"],
        "build_command": "python3 analysis/build_longcovid_model.py   (model/build_model.main with RELEASE)",
        "calibration_source": "results/aggregate/36/t05_calibration_nb_eb.csv (training-split score bins)",
        "evaluation_target": "first ICD-10-CM U09.9 code in days 91-455 among adults with no Long COVID code by day 90",
        "evaluations": [
            {"file": "results/aggregate/36/t05_transport_performance.csv", "where": {"model": "nb_eb"},
             "what": "deployed model, random 20% validation split (Task 36)"},
            {"file": "results/aggregate/36/t17_site_performance.csv", "where_prefix": {"model": "exported naive Bayes (frozen"},
             "what": "separately fitted 50-feature model of the same procedure at 18 held-out health systems; not the "
                     "deployed file"},
        ],
    },
    *[{"self_report": m} for m in SELF_REPORT],
]


def path(rel: str) -> str:
    return os.path.join(ROOT, rel)


def sha256(rel: str) -> str | None:
    p = path(rel)
    if not os.path.isfile(p):
        return None
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 16), b""):
            h.update(chunk)
    return h.hexdigest()


def git(*args: str) -> str | None:
    """Read-only git queries; None when git is unavailable."""
    try:
        return subprocess.run(["git", *args], cwd=ROOT, check=True, capture_output=True, text=True).stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        return None


def file_entry(rel: str) -> dict:
    status = git("status", "--porcelain", "--", rel)
    return {"path": rel, "sha256": sha256(rel), "last_commit": git("log", "-1", "--format=%H", "--", rel) or None,
            "uncommitted_changes": bool(status) if status is not None else None}


def expand(patterns: list[str]) -> list[str]:
    out = []
    for p in patterns:
        hits = sorted(os.path.relpath(h, ROOT) for h in glob.glob(path(p)))
        out += hits if hits else [p]
    return out


def tree_hash(rels: list[str]) -> str:
    """sha256 over "<path>\\0<sha256 of file>\\n" for each file, in path order."""
    h = hashlib.sha256()
    for rel in sorted(rels):
        h.update(f"{rel}\0{sha256(rel)}\n".encode())
    return h.hexdigest()


def numeric(v: str):
    try:
        f = float(v)
    except ValueError:
        return v
    return int(f) if f.is_integer() and re.fullmatch(r"-?\d+(\.0+)?", v.strip()) else f


def evaluation_rows(spec: dict) -> dict:
    rel = spec["file"]
    rows = []
    if os.path.isfile(path(rel)):
        with open(path(rel), newline="", encoding="utf-8") as f:
            for row in csv.DictReader(f):
                if "where" in spec and any(row.get(k) != v for k, v in spec["where"].items()):
                    continue
                if "where_prefix" in spec and any(not str(row.get(k, "")).startswith(v) for k, v in spec["where_prefix"].items()):
                    continue
                rows.append({k: numeric(v) for k, v in row.items()})
    return {"what": spec["what"], "file": rel, "sha256": sha256(rel), "rows": rows}


def vectors(model: dict) -> dict:
    d = f"model/test_vectors/expected/{model['model_id']}-{model['version']}"
    files = sorted(os.path.relpath(p, ROOT) for p in glob.glob(path(f"{d}/*.json")))
    scored = sum(1 for p in files if json.load(open(path(p))).get("status") == "scored")
    return {"directory": d, "files": len(files), "scored": scored, "sha256": tree_hash(files) if files else None}


def self_report_spec(name: str) -> dict:
    """A self-report model's entry, read from analysis/build_cf_model.py (the script that fits it)."""
    sys.path[:0] = [path("analysis"), path("workbench/src"), path("model")]
    import build_cf_model
    c = build_cf_model.CONDITIONS[name]
    res, prefix = c["results"], c["prefix"]
    inputs = [f"{res}/{prefix}_{n}.csv" for n in ("label_counts", "feature_label_counts", "calibration_bins")]
    for d, p in [(res, prefix), *c.get("codelists_also", ())]:
        inputs += [rel for kind in ("labs", "drugs") for suffix in ("", "_new")
                   for rel in [f"{d}/{p}_codelist_{kind}{suffix}.csv"] if os.path.isfile(path(rel))]
    metrics = f"{res}/{prefix}_metrics.csv"
    task = re.match(r"Task \d+", c["task"]).group(0)
    return {
        "file": c["out"], "site_copy": f"web/web/models/{os.path.basename(c['out'])}",
        "registry": [f"workbench/src/{c['registry']}"],
        "aggregate_inputs": inputs + [metrics],
        "fitting_code": ["analysis/build_cf_model.py", "workbench/src/cf_model.py", "model/build_model.py"],
        "build_command": f"python3 analysis/build_cf_model.py --condition {name}",
        "calibration_source": f"{res}/{prefix}_calibration_bins.csv (training-split score bins)",
        "evaluation_target": f"{c['target']['label']}; population: {c['target']['population']}",
        "evaluations": [{"file": metrics, "where": {"model": "nb_sr_exported"},
                         "what": f"deployed model, random validation split ({task}), every evaluation target"}],
    }


def model_entry(spec: dict) -> dict:
    if "self_report" in spec:
        spec = self_report_spec(spec["self_report"])
    m = json.load(open(path(spec["file"])))
    inputs = expand(spec["aggregate_inputs"])
    return {
        "model_id": m["model_id"],
        "model_version": m["version"],
        "status": m.get("status"),
        "file": spec["file"],
        "sha256": sha256(spec["file"]),
        "site_copy": {"path": spec["site_copy"], "sha256": sha256(spec["site_copy"]),
                      "matches": sha256(spec["site_copy"]) == sha256(spec["file"])},
        "features": len(m["features"]),
        "features_nonzero": sum(1 for f in m["features"] if f.get("weight", 0) != 0),
        "index_event": m.get("index_event"),
        "exclusion": m.get("exclusion"),
        "target": m.get("target"),
        "evaluation_target": spec["evaluation_target"],
        "calibration": {"method": m["calibration"].get("method"), "fit": m["calibration"].get("fit"),
                        "points": len(m["calibration"].get("points", [])), "source": spec["calibration_source"]},
        "risk_bands": m.get("risk_bands"),
        "reference": m.get("reference"),
        "provenance": m.get("provenance"),
        "feature_registry": [file_entry(r) for r in spec["registry"]],
        "aggregate_inputs": [file_entry(r) for r in inputs],
        "fitting_code": [file_entry(r) for r in spec["fitting_code"]],
        "build_command": spec["build_command"],
        "evaluation": [evaluation_rows(e) for e in spec["evaluations"]],
        "test_vectors": vectors(m),
    }


def contract_version() -> str | None:
    head = open(path("docs/interface/model_spec.md"), encoding="utf-8").readline()
    m = re.search(r"contract version ([\d.]+)", head)
    return m.group(1) if m else None


def questionnaire() -> dict:
    src = open(path("web/web/patient/instruments.js"), encoding="utf-8").read()
    url = re.search(r'QUESTIONNAIRE_URL =\s*"([^"]+)"', src)
    ver = re.search(r'QUESTIONNAIRE_VERSION = "([^"]+)"', src)
    sup = re.search(r"SUPPORTED_QUESTIONNAIRE_VERSIONS = Object\.freeze\(\[([^\]]*)\]", src)
    return {"url": url.group(1) if url else None, "version": ver.group(1) if ver else None,
            "supported_versions": re.findall(r'"([^"]+)"', sup.group(1)) if sup else None}


def build() -> dict:
    head = git("rev-parse", "HEAD")
    dirty = git("status", "--porcelain", "--", "model", "web/web", "web/functions", "analysis", "docs/interface")
    bundles = sorted(os.path.relpath(p, ROOT) for p in glob.glob(path("model/test_vectors/bundles/*.json")))
    return {
        "schema": SCHEMA,
        "generated": dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat(),
        "generator": "analysis/build_release_manifest.py",
        "data": "NIH All of Us Research Program, Registered Tier Dataset v9 (CDR R2025Q4R6); aggregate, "
                "dissemination-compliant counts only",
        "contract": {"spec": "docs/interface/model_spec.md", "contract_version": contract_version(),
                     "sha256": sha256("docs/interface/model_spec.md")},
        "application_release": {
            "commit": head,
            "uncommitted_changes_in_release_paths": bool(dirty) if dirty is not None else None,
            "files": [file_entry(r) for r in APPLICATION],
            "files_sha256": tree_hash(APPLICATION),
            "questionnaire": questionnaire(),
        },
        "scorers": [file_entry(r) for r in SCORERS],
        "test_code": [file_entry(r) for r in TESTS],
        "test_bundles": {"directory": "model/test_vectors/bundles", "files": len(bundles), "sha256": tree_hash(bundles)},
        "models": [model_entry(s) for s in MODELS],
        "reproduce": COMMANDS,
    }


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--out", help="write the manifest here (default: print it)")
    a = ap.parse_args()
    manifest = build()
    missing = [f["path"] for m in manifest["models"] for f in m["aggregate_inputs"] + m["feature_registry"] + m["fitting_code"]
               if f["sha256"] is None]
    text = json.dumps(manifest, indent=1) + "\n"
    if a.out:
        with open(a.out, "w", encoding="utf-8") as f:
            f.write(text)
        print(f"wrote {a.out}: {len(manifest['models'])} models, commit {manifest['application_release']['commit']}",
              file=sys.stderr)
    else:
        sys.stdout.write(text)
    if missing:
        print("missing inputs: " + ", ".join(missing), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
