"""Task 35 (Paper 1): features rebuilt with ICD-10-CM codes from both condition_occurrence and observation,
and the main analyses rerun on them.

Runs inside the All of Us Workbench (bash ~/unm/bin/unm.sh run 35).
Task 32 showed that OMOP files some ICD-10-CM codes in the observation table (all R53.83, part of R41,
R42/R55, R43, U07.1, E66). Tasks 02 and 12 read only condition_occurrence, so symptom features missed those
codes. The cohort (Task 01) is unchanged.

Steps
1. Rebuild Task 02 and Task 12 features with condition rows from both tables (same functions, same windows);
   outcome-window columns (yout_*) are kept from features_v2. Non-condition features must be identical.
2. Use every corrected feature, with suppression applied only to each released table. Tasks 04 and 16
   retain their original split seeds; earlier releases do not constrain feature definitions or splits.
3. Save features_v3.parquet and rerun Tasks 03, 04, 14, 15, 16, and 18 on it (Task 18 with outcome codes
   from both tables). t03_oof_scores.parquet is backed up first as t03_oof_scores_v2.parquet.
Exports: ~/unm/export/35/ t35_feature_counts, t35_guard_summary, and each task's usual files.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys

import pandas as pd

try:
    import db_dtypes  # noqa: F401
except ImportError:
    pass

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import t02_features as t02  # noqa: E402
import t03_models as t03  # noqa: E402
import t04_moments as t04  # noqa: E402
import t12_features_extra as t12  # noqa: E402
import t14_subgroups as t14  # noqa: E402
import t15_adjustment as t15  # noqa: E402
import t16_site_counts as t16  # noqa: E402
import t18_documentation as t18  # noqa: E402
from aou_safe import check_exportable  # noqa: E402

OUT = os.path.expanduser("~/unm/output")
EXPORT = os.path.expanduser("~/unm/export/35")
NEW = "features_v3.parquet"


def stage(name, fn, *args, **kw):
    """Run a step; on failure raise a RuntimeError naming it (the runner summary drops BigQuery exception names)."""
    try:
        return fn(*args, **kw)
    except Exception as e:  # noqa: BLE001
        msg = getattr(e, "message", None) or str(e)
        raise RuntimeError(f"{name} failed: {type(e).__name__}: {str(msg).splitlines()[0][:300]}") from None


def obs_conditions(ids, lo, hi, regex):
    """ICD-10-CM rows from the observation table, in the same shape as Task 02's condition query."""
    from google.cloud import bigquery
    cdr = subprocess.check_output(["wb", "resolve", f"--id={t02.CDR_ID}"], text=True).strip()
    cfg = bigquery.QueryJobConfig(query_parameters=[
        bigquery.ArrayQueryParameter("ids", "INT64", [int(x) for x in ids]),
        bigquery.ScalarQueryParameter("lo", "DATE", lo), bigquery.ScalarQueryParameter("hi", "DATE", hi)])
    return bigquery.Client().query(f"""
        SELECT o.person_id, o.observation_date AS d, REPLACE(UPPER(c.concept_code), '.', '') AS code
        FROM `{cdr}.observation` o JOIN `{cdr}.concept` c ON o.observation_source_concept_id = c.concept_id
        WHERE c.vocabulary_id = 'ICD10CM' AND o.person_id IN UNNEST(@ids) AND o.observation_date BETWEEN @lo AND @hi
          AND REGEXP_CONTAINS(REPLACE(UPPER(c.concept_code), '.', ''), r'{regex}')
    """, job_config=cfg).to_dataframe()


def regex_of(prefixes):
    return "^(" + "|".join(sorted(set(prefixes))) + ")"


def rebuild(cohort):
    conds, visits, procs, meas, drugs, _, _ = stage("Task 02 queries", t02.load_from_cdr, cohort)
    lo = (cohort.index_date.min() - pd.Timedelta(days=366)).date().isoformat()
    hi = (cohort.index_date.max() + pd.Timedelta(days=t02.OUTCOME[1] + 1)).date().isoformat()
    pre02 = [p for v in t02.condition_prefix_map().values() for p in v]
    pre12 = [p for v in list(t12.CLUSTERS.values()) + list(t12.EXTRA.values()) for p in v]
    # Task 02's condition query does not include U07.1, B94.8, or Z86.16 from Task 12.
    extra = stage("Task 12 condition codes", t18.load_conds, cohort, t12.EXTRA)
    print("querying observation-table condition codes", flush=True)
    obs = stage("observation-table condition codes", obs_conditions, cohort.index, lo, hi, regex_of(pre02 + pre12))
    both = pd.concat([conds, extra, obs], ignore_index=True).drop_duplicates()
    X1 = t02.build_features(cohort, both[both.code.str.match(regex_of(pre02))], visits, procs, meas, drugs)
    X2 = t12.build_extra(cohort, both[both.code.str.match(regex_of(pre12))], visits)
    return X1.join(X2)


def main():
    cohort = pd.read_parquet(os.path.join(OUT, "cohort_v2.parquet"))
    cohort = cohort[cohort.landmark_eligible == 1].copy()
    cohort["index_date"] = pd.to_datetime(cohort.index_date)
    F_old = pd.read_parquet(os.path.join(OUT, "features_v2.parquet")).loc[cohort.index]
    X = rebuild(cohort)
    F_new = F_old.copy()
    for col in X.columns:
        if col in F_new.columns and not col.startswith("yout_"):
            F_new[col] = X.loc[F_new.index, col].astype(F_old[col].dtype)
    cond_ids = set(t02.condition_prefix_map()) | {c for c in X.columns if c.startswith("sym_") or c in
                                                    ("covid_code_w3", "sequelae_code", "covid_history_code")}
    bad = [c for c in F_old.columns if not c.startswith("yout_") and (F_old[c] != F_new[c]).any()
           and not any(c == k or c.startswith(k) for k in cond_ids) and not c.startswith("sym_")]
    if bad:
        raise RuntimeError(f"non-condition features changed: {', '.join(bad[:10])}")
    F3 = F_new
    changed = [c for c in F3.columns if (F_old[c] != F3[c]).any()]
    F3.to_parquet(os.path.join(OUT, NEW))
    print(f"features_v3 saved: {len(changed)} features changed; all corrected definitions retained", flush=True)
    os.makedirs(EXPORT, exist_ok=True)
    feats = [c for c in F3.columns if not c.startswith("yout_")]
    tab = t02.feature_table(F3[feats], cohort.s)
    check_exportable(tab)
    tab.to_csv(os.path.join(EXPORT, "t35_feature_counts.csv"), index=False)

    src = os.path.join(OUT, "t03_oof_scores.parquet")
    if os.path.exists(src) and not os.path.exists(os.path.join(OUT, "t03_oof_scores_v2.parquet")):
        shutil.copy(src, os.path.join(OUT, "t03_oof_scores_v2.parquet"))
    for m in (t03, t04, t14, t15, t16, t18):
        m.FEATURES, m.EXPORT = NEW, EXPORT

    def conds_both(c, prefixes):
        a = t18.load_conds(c, prefixes)
        lo = (c.index_date.min() - pd.Timedelta(days=366)).date().isoformat()
        hi = (c.index_date.max() + pd.Timedelta(days=456)).date().isoformat()
        b = obs_conditions(c.index, lo, hi, regex_of([p for v in prefixes.values() for p in v]))
        return pd.concat([a, b], ignore_index=True).drop_duplicates()

    stage("Task 04 rerun", t04.main)
    stage("Task 16 rerun", t16.main)
    stage("Task 03 rerun", t03.main)
    stage("Task 14 rerun", t14.main)
    stage("Task 15 rerun", t15.main)
    stage("Task 18 rerun", t18.main, loader=lambda c, p: stage("Task 18 outcome codes", conds_both, c, p))
    summary = pd.DataFrame([
        {"item": "features whose values changed with observation-table codes", "value": f"{len(changed)} features: " + " ".join(changed)},
        {"item": "features reverted to the condition-table definition by the guard", "value": "0 features: cross-release guard removed"},
        {"item": "seed for the Task 04 training split and Task 16 fit/calibration roles", "value": f"Task 04 seed {t04.SEED}, Task 16 seed {t16.SPLIT_SEED}"},
    ])
    check_exportable(summary)
    summary.to_csv(os.path.join(EXPORT, "t35_guard_summary.csv"), index=False)
    print("Task 35 finished", flush=True)


if __name__ == "__main__":
    main()
