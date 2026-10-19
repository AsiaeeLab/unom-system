"""Task 34 (Paper 2): obesity results with ICD-10-CM codes from both condition_occurrence and observation.

Runs inside the All of Us Workbench (bash ~/unm/bin/unm.sh run 34).
Task 32 showed that the obesity codes are split between tables (Z68.3/Z68.4 entirely, E66 partly in the
observation table); Tasks 25-29 read only condition_occurrence. This task recomputes every released obesity
row with codes from both tables, using the unchanged Task 25-29 functions, and exports obesity rows only.

Each table uses only its own primary and complementary suppression. Earlier releases do not
change which cells are shown.
Exports: ~/unm/export/34/ t34_<original table>_obesity.csv (same columns as the original) and
 t34_guard_summary (zero cells hidden by cross-release guards, retained for filename compatibility).
"""

from __future__ import annotations

import json
import os
import subprocess
import sys

import pandas as pd

try:
    import db_dtypes  # noqa: F401
except ImportError:
    pass

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import t25_p2_coded_shares as t25  # noqa: E402
import t26_p2_selfreport as t26  # noqa: E402
import t27_p2_selfreport_groups as t27  # noqa: E402
import t28_p2_selfreport_deep as t28  # noqa: E402
import t29_p2_sites as t29  # noqa: E402
from aou_safe import check_exportable  # noqa: E402

EXPORT = os.path.expanduser("~/unm/export/34")
OB = "obesity"
def query_obesity(cdr):
    from google.cloud import bigquery
    pref = " OR ".join(f"STARTS_WITH(REPLACE(UPPER(k.concept_code), '.', ''), '{p}')" for p in t25.CONDITIONS[OB])
    print("querying obesity codes in both tables", flush=True)
    return bigquery.Client().query(f"""
        WITH u AS (
          SELECT co.person_id, co.condition_start_date AS d FROM `{cdr}.condition_occurrence` co
          JOIN `{cdr}.concept` k ON co.condition_source_concept_id = k.concept_id AND k.vocabulary_id = 'ICD10CM' WHERE {pref}
          UNION DISTINCT
          SELECT o.person_id, o.observation_date AS d FROM `{cdr}.observation` o
          JOIN `{cdr}.concept` k ON o.observation_source_concept_id = k.concept_id AND k.vocabulary_id = 'ICD10CM' WHERE {pref})
        SELECT person_id, '{OB}' AS cond, COUNT(DISTINCT d) AS n_dates, MIN(d) AS first_d, MAX(d) AS last_d
        FROM u GROUP BY person_id""").to_dataframe()


def stage(name, fn, *args):
    """Run a query step; on failure raise a RuntimeError naming the step and BigQuery's message (the runner's
    error summary shows only exception names ending in Error or Exception, which BigQuery's do not)."""
    try:
        return fn(*args)
    except Exception as e:  # noqa: BLE001
        msg = getattr(e, "message", None) or str(e)
        raise RuntimeError(f"{name} failed: {type(e).__name__}: {str(msg).splitlines()[0][:300]}") from None


def main(loader=None):
    weights = json.load(open(os.path.join(t26.HERE, "us_adult_weights.json")))
    if loader:
        pop_raw, codes_old, sr, resp, depth, site, ob = loader()
    else:
        cdr = subprocess.check_output(["wb", "resolve", f"--id={t25.CDR_ID}"], text=True).strip()
        pop_raw, codes_old, _ = stage("Task 25 population and codes", t25.query, cdr)
        sr, resp, _ = stage("survey answers", t26.query_survey, cdr)
        depth = stage("EHR depth", t27.query_depth, cdr)
        site = stage("sites", t29.query_site, cdr)
        ob = stage("obesity codes in both tables", query_obesity, cdr)
    print("data loaded", flush=True)
    codes_new = pd.concat([codes_old[codes_old.cond != OB], ob[ob.person_id.isin(pop_raw.person_id)]], ignore_index=True)

    pop_all, cp = t26.prepare(pop_raw, codes_new)
    pop_all = pop_all.merge(depth, on="person_id", how="left")
    pop_all["ehr_depth"] = pop_all.depth_days.map(t27.depth_band)
    pop = pop_all[pop_all.sex.isin(t26.SEXES)]
    srp = sr[sr.person_id.isin(pop.person_id)]
    rid = (set(resp.person_id) & set(pop.person_id)) | set(srp.person_id)
    ob_rows = lambda d: d[d.condition == OB].copy()
    out = {
        "t34_t25_coded_shares_obesity": ob_rows(t25.coded_table(pop_raw, codes_new)),
        "t34_t26_selfreport_vs_code_obesity": ob_rows(t26.selfreport_table(pop, cp, srp, rid)),
        "t34_t26_standardized_shares_obesity": ob_rows(t26.standardized_table(pop, cp, weights)),
        "t34_t27_selfreport_by_group_obesity": ob_rows(t27.group_table(pop_all, pop, cp, srp, rid)),
        "t34_t28_selfreport_deep_by_sex_obesity": ob_rows(t28.deep_table(pop, cp, srp, rid)),
        "t34_t29_site_quantiles_obesity": ob_rows(t29.site_table(pop, cp, srp, rid, site)),
        "t34_guard_summary": pd.DataFrame([
            {"table": table, "cells_hidden_by_guard": "0 cells"}
            for table in ("t25_coded_shares", "t26_selfreport_vs_code", "t27_selfreport_by_group",
                          "t28_selfreport_deep_by_sex")]),
    }
    os.makedirs(EXPORT, exist_ok=True)
    for name, df in out.items():
        check_exportable(df)
        df.to_csv(os.path.join(EXPORT, f"{name}.csv"), index=False)
        print(f"exported {name} ({len(df)} rows)", flush=True)
    print("Task 34 finished", flush=True)


if __name__ == "__main__":
    main()
