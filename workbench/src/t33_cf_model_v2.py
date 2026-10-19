"""Task 33: Task 30 rerun with condition codes from both condition_occurrence and observation.

Runs inside the All of Us Workbench (bash ~/unm/bin/unm.sh run 33).
Task 32 showed that OMOP stores some ICD-10-CM codes in the observation table (all R53.83 "other fatigue",
the Z68.3/Z68.4 BMI codes, and part of R41, R42/R55, R43, E66, U07.1). Task 30 read only
condition_occurrence, so its fatigue features were empty. This task reads both tables for condition
features; cohort, labels, split, and everything else are as in Task 30 (same functions), so the cohort
counts are unchanged.

Every condition feature and symptom-group count uses both source tables. The feature table records
this definition in source_tables; eligibility still requires every cell of its own released 2x2 table
to exceed 20.
Exports: ~/unm/export/33/ with the same files as Task 30 (t33_ prefix).
"""

from __future__ import annotations

import os
import subprocess
import sys

import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cf_model as cf  # noqa: E402
import t03_models  # noqa: E402
import t25_p2_coded_shares as t25  # noqa: E402
import t26_p2_selfreport as t26  # noqa: E402
import t30_cf_model as t30  # noqa: E402
from aou_safe import check_exportable  # noqa: E402

EXPORT = os.path.expanduser("~/unm/export/33")


def query_observation_conditions(cdr):
    """Condition-feature events from the observation table (ICD-10-CM source codes), same windows as Task 30."""
    from google.cloud import bigquery
    s_cte = f"""s AS (SELECT sc.person_id, MIN(sc.survey_end_date) AS d0 FROM `{cdr}.survey_conduct` sc
              JOIN `{cdr}.concept` c ON sc.survey_concept_id = c.concept_id
              WHERE LOWER(c.concept_name) LIKE '%personal and family health history%'
                 OR LOWER(c.concept_name) LIKE '%personal medical history%' GROUP BY 1)"""
    pref = ", ".join(f"STRUCT('{f}' AS fid, '{p}' AS p)" for f, p in cf.condition_prefixes())
    print("querying condition features in the observation table", flush=True)
    return bigquery.Client().query(f"""
        WITH {s_cte}, m AS (SELECT * FROM UNNEST([{pref}]))
        SELECT o.person_id, m.fid, MAX(DATE_DIFF(o.observation_date, s.d0, DAY)) AS max_off
        FROM `{cdr}.observation` o JOIN s USING (person_id)
        JOIN `{cdr}.concept` k ON o.observation_source_concept_id = k.concept_id AND k.vocabulary_id = 'ICD10CM'
        JOIN m ON STARTS_WITH(REPLACE(UPPER(k.concept_code), '.', ''), m.p)
        WHERE o.observation_date BETWEEN DATE_SUB(s.d0, INTERVAL 1825 DAY) AND DATE_SUB(s.d0, INTERVAL 1 DAY)
        GROUP BY 1, 2""").to_dataframe()


def guarded_features(pop, events_v1, events_obs, vis):
    """Build every feature from both source tables, irrespective of earlier released counts."""
    both = pd.concat([events_v1, events_obs], ignore_index=True).groupby(["person_id", "fid"], as_index=False).max_off.max()
    X = cf.build_features(pop, both, vis)
    condition_ids = {f["id"] for k in ("conditions", "cluster_counts") for f in cf.REG[k]}
    src = {f: "condition and observation" if f in condition_ids else "not a condition feature" for f in X.columns}
    return X, src


def main(loader=None):
    if loader:
        pop_raw, codes_raw, sr, survey, events, visits, lab_codes, drug_codes, events_obs = loader()
    else:
        cdr = subprocess.check_output(["wb", "resolve", f"--id={t25.CDR_ID}"], text=True).strip()
        pop_raw, codes_raw, _ = t25.query(cdr)
        sr, _, _ = t26.query_survey(cdr)
        survey, events, visits, lab_codes, drug_codes = t30.query_events(cdr)
        events_obs = query_observation_conditions(cdr)
    print("data loaded", flush=True)
    t03_models.N_BOOT = t30.N_BOOT
    pop, v = t30.build_cohort(pop_raw, codes_raw, sr, survey, visits)
    vis = v.groupby(["person_id", "visit_class"], as_index=False)[["n_R", "n_H"]].sum()
    X, src = guarded_features(pop, events, events_obs, vis)
    print(f"cohort {len(pop)} people; {sum(s == 'condition and observation' for s in src.values())} features use both tables", flush=True)
    tab, labels, bins, met, comp, by_sex = t30.run(pop, X)
    tab["source_tables"] = tab.feature.map(src).fillna("not a condition feature")
    tab.loc[~tab.feature.isin([f["id"] for f in cf.REG["conditions"]] + [f["id"] for f in cf.REG["cluster_counts"]]), "source_tables"] = "not a condition feature"
    labs = lab_codes[["fid", "loinc", "concept_name"]].drop_duplicates().sort_values(["fid", "loinc"])
    drugs = drug_codes[drug_codes.vocabulary_id == "RxNorm"][["fid", "rxcui"]].drop_duplicates().sort_values(["fid", "rxcui"])
    drugs["rxcui"] = "rxcui:" + drugs.rxcui.astype(str)
    os.makedirs(EXPORT, exist_ok=True)
    out = {"t33_cohort": t30.cohort_table(pop), "t33_label_counts": labels, "t33_feature_label_counts": tab,
           "t33_calibration_bins": bins, "t33_metrics": met, "t33_comparison": comp, "t33_by_sex": by_sex,
           "t33_codelist_labs": labs, "t33_codelist_drugs": drugs}
    for name, df in out.items():
        check_exportable(df)
        df.to_csv(os.path.join(EXPORT, f"{name}.csv"), index=False)
        print(f"exported {name} ({len(df)} rows)", flush=True)
    print("Task 33 finished", flush=True)


if __name__ == "__main__":
    main()
