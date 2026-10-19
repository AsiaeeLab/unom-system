"""Workbench-side runner (installed at ~/unm/src/unm_run.py).

The terminal bridge only allows the commands in ~/unm/bin/unm.sh, and those
commands only print what this runner lets through:

- `run NN`: the task script's own output goes to ~/unm/logs/tNN.log and never
  to the terminal. The runner prints the exit status, a sanitized error summary
  (exception type, sanitized message, code locations), and each export CSV
  after re-checking it for small cells and participant-level content.
- `schema TABLE`: column names and types only.
- `concepts VOCAB TEXT`: rows from the OMOP concept table (vocabulary, not
  participant data), capped at 200.
"""

from __future__ import annotations

import glob
import os
import re
import subprocess
import sys
import time

import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from aou_safe import check_exportable  # noqa: E402

UNM = os.path.expanduser("~/unm")
CDR_ID = os.environ.get("UNM_CDR_ID", "R2025Q4R6")
MAX_ROWS = 40000


def sanitize(text: str) -> str:
    text = re.sub(r"\d{6,}", "######", text)                 # IDs and other long numbers
    text = re.sub(r"\b\d{4}-\d{2}-\d{2}\b", "YYYY-MM-DD", text)  # dates
    return text[:800]


def error_summary(log_path: str) -> str:
    """Exception type and message plus the last code locations, sanitized."""
    try:
        lines = open(log_path, errors="replace").read().splitlines()
    except OSError:
        return "  (no log)"
    frames = [ln.strip() for ln in lines if ln.strip().startswith('File "')]
    last = ""
    for ln in reversed(lines):
        if re.match(r"^[A-Za-z_][\w.]*(Error|Exception|Exit|Interrupt)\b", ln.strip()):
            last = ln.strip()
            break
    out = [f"  at {sanitize(f)}" for f in frames[-4:]]
    out.append(f"  {sanitize(last) if last else '(no exception line found)'}")
    return "\n".join(out)


def validate(df: pd.DataFrame) -> None:
    check_exportable(df)
    if len(df) > MAX_ROWS:
        raise ValueError(f"{len(df)} rows exceeds the {MAX_ROWS}-row limit for aggregate tables")
    for col in df.columns:
        s = df[col]
        if s.dtype.kind in "iuf" and (s.abs() >= 1_000_000).sum() > 3:
            raise ValueError(f"column {col!r} looks like identifiers (values of 1,000,000 or more)")
        if s.dtype == object and s.astype(str).str.fullmatch(r"\d{4}-\d{2}-\d{2}.*").any():
            raise ValueError(f"column {col!r} contains calendar dates")


def cmd_run(task: str) -> int:
    if not re.fullmatch(r"\d{2}", task):
        print("UNM task number must be two digits")
        return 2
    scripts = sorted(glob.glob(f"{UNM}/src/t{task}_*.py"))
    if not scripts:
        print(f"UNM no script for task {task}")
        return 2
    export_dir = f"{UNM}/export/{task}"
    os.makedirs(export_dir, exist_ok=True)
    for old in glob.glob(f"{export_dir}/*.csv"):
        os.remove(old)
    log = f"{UNM}/logs/t{task}.log"
    start = time.time()
    with open(log, "w") as fh:
        proc = subprocess.run([sys.executable, "-u", scripts[0]], stdout=fh, stderr=subprocess.STDOUT,
                              cwd=f"{UNM}/src")
    print(f"UNM task {task} script={os.path.basename(scripts[0])} exit={proc.returncode} "
          f"seconds={int(time.time() - start)}")
    if proc.returncode != 0:
        print("UNM error summary (sanitized):")
        print(error_summary(log))
    for path in sorted(glob.glob(f"{export_dir}/*.csv")):
        name = os.path.basename(path)
        try:
            df = pd.read_csv(path)
            validate(df)
        except Exception as exc:  # noqa: BLE001
            print(f"UNM BLOCKED {name}: {sanitize(str(exc))}")
            continue
        print(f"__BEGIN_CSV {name}__")
        print(df.to_csv(index=False).rstrip())
        print("__END_CSV__")
    print(f"UNM done {task}")
    return proc.returncode


def _cdr():
    from google.cloud import bigquery
    cdr = subprocess.check_output(["wb", "resolve", f"--id={CDR_ID}"], text=True).strip()
    return cdr, bigquery.Client()


def cmd_schema(table: str) -> int:
    if not re.fullmatch(r"[a-z_0-9]+", table):
        print("UNM bad table name")
        return 2
    cdr, client = _cdr()
    t = client.get_table(f"{cdr}.{table}")
    print(f"__BEGIN_CSV schema_{table}.csv__")
    print("column,type")
    for f in t.schema:
        print(f"{f.name},{f.field_type}")
    print("__END_CSV__")
    return 0


def cmd_concepts(vocab: str, text: str) -> int:
    if not re.fullmatch(r"[A-Za-z0-9_]+", vocab) or not re.fullmatch(r"[A-Za-z0-9 _%.,()/-]{1,80}", text):
        print("UNM bad vocabulary or search text")
        return 2
    from google.cloud import bigquery
    cdr, client = _cdr()
    sql = f"""
    SELECT concept_id, vocabulary_id, concept_code, concept_name, standard_concept, domain_id
    FROM `{cdr}.concept`
    WHERE vocabulary_id = @v AND LOWER(concept_name) LIKE LOWER(@t)
    ORDER BY concept_name LIMIT 200
    """
    job = client.query(sql, job_config=bigquery.QueryJobConfig(query_parameters=[
        bigquery.ScalarQueryParameter("v", "STRING", vocab),
        bigquery.ScalarQueryParameter("t", "STRING", f"%{text}%")]))
    df = job.to_dataframe()
    print(f"__BEGIN_CSV concepts_{vocab}.csv__")
    print(df.to_csv(index=False).rstrip())
    print("__END_CSV__")
    return 0


if __name__ == "__main__":
    args = sys.argv[1:]
    if args[:1] == ["run"] and len(args) == 2:
        sys.exit(cmd_run(args[1]))
    if args[:1] == ["schema"] and len(args) == 2:
        sys.exit(cmd_schema(args[1]))
    if args[:1] == ["concepts"] and len(args) == 3:
        sys.exit(cmd_concepts(args[1], args[2]))
    print("UNM usage: run NN | schema TABLE | concepts VOCAB TEXT")
    sys.exit(2)
