"""Task 12: extra features for the Long COVID landmark cohort (appends to Task 02's mart).

Runs inside the All of Us Workbench (bash ~/unm/bin/unm.sh run 12).
Input : ~/unm/output/{cohort_v2,features_v1}.parquet
Output: ~/unm/output/features_v2.parquet (features_v1 plus the columns below; stays in Workbench)
Export: ~/unm/export/12/t12_feature_counts.csv (same format as t02_feature_counts)

New features (information available by day 90 only):
- sym_any_<cluster>: any code in the cluster in days 0-90 (not required to be new);
- sym_any_w3_count_ge2 / ge3: number of clusters with a code in days 31-90;
- covid_code_w3: a U07.1 code again in days 31-90 (clinicians still coding COVID at follow-up);
- sequelae_code: B94.8 (sequelae of other infectious disease) in days 0-90;
- covid_history_code: Z86.16 (personal history of COVID-19) in days 31-90;
- late_visit_61_90: any outpatient or emergency visit in days 61-90.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys

import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from t02_features import REG, feature_table  # noqa: E402
from aou_safe import check_exportable  # noqa: E402

CDR_ID = os.environ.get("UNM_CDR_ID", "R2025Q4R6")
OUT = os.path.expanduser("~/unm/output")
EXPORT = os.path.expanduser("~/unm/export/12")
CLUSTERS = {f["id"].replace("sym_", ""): [str(p) for p in f["icd10cm_prefix"]]
            for f in REG["new_symptoms"] if "icd10cm_prefix" in f}
EXTRA = {"covid": ["U071"], "sequelae": ["B948"], "covid_history": ["Z8616"]}


def build_extra(cohort: pd.DataFrame, conds: pd.DataFrame, visits: pd.DataFrame) -> pd.DataFrame:
    X = pd.DataFrame(index=cohort.index)
    c = conds.merge(cohort.index_date.rename("index_date"), left_on="person_id", right_index=True)
    c["off"] = (pd.to_datetime(c.d) - c.index_date).dt.days
    code = c.code.astype(str)
    w23 = (c.off >= 0) & (c.off <= 90)
    w3 = (c.off >= 31) & (c.off <= 90)
    n_w3 = pd.Series(0, index=X.index)
    for name, pre in CLUSTERS.items():
        m = code.str.startswith(tuple(pre))
        X[f"sym_any_{name}"] = X.index.isin(set(c.loc[m & w23, "person_id"])).astype(int)
        n_w3 = n_w3 + X.index.isin(set(c.loc[m & w3, "person_id"])).astype(int)
    X["sym_any_w3_count_ge2"] = (n_w3 >= 2).astype(int)
    X["sym_any_w3_count_ge3"] = (n_w3 >= 3).astype(int)
    X["covid_code_w3"] = X.index.isin(set(c.loc[code.str.startswith("U071") & w3, "person_id"])).astype(int)
    X["sequelae_code"] = X.index.isin(set(c.loc[code.str.startswith("B948") & w23, "person_id"])).astype(int)
    X["covid_history_code"] = X.index.isin(set(c.loc[code.str.startswith("Z8616") & w3, "person_id"])).astype(int)
    v = visits.merge(cohort.index_date.rename("index_date"), left_on="person_id", right_index=True)
    v["off"] = (pd.to_datetime(v.d) - v.index_date).dt.days
    name = v.visit_type.fillna("").str.lower()
    late = (v.off >= 61) & (v.off <= 90) & ~name.str.contains("inpatient|pharmacy|laboratory")
    X["late_visit_61_90"] = X.index.isin(set(v.loc[late, "person_id"])).astype(int)
    return X


def main():
    from google.cloud import bigquery
    cohort = pd.read_parquet(os.path.join(OUT, "cohort_v2.parquet"))
    cohort = cohort[cohort.landmark_eligible == 1].copy()
    cohort["index_date"] = pd.to_datetime(cohort.index_date)
    F1 = pd.read_parquet(os.path.join(OUT, "features_v1.parquet")).loc[cohort.index]
    cdr = subprocess.check_output(["wb", "resolve", f"--id={CDR_ID}"], text=True).strip()
    client = bigquery.Client()
    prefixes = sorted({p for v in list(CLUSTERS.values()) + list(EXTRA.values()) for p in v})
    regex = "^(" + "|".join(prefixes) + ")"
    lo = cohort.index_date.min().date().isoformat()
    hi = (cohort.index_date.max() + pd.Timedelta(days=91)).date().isoformat()
    cfg = bigquery.QueryJobConfig(query_parameters=[
        bigquery.ArrayQueryParameter("ids", "INT64", [int(x) for x in cohort.index]),
        bigquery.ScalarQueryParameter("lo", "DATE", lo), bigquery.ScalarQueryParameter("hi", "DATE", hi)])
    print("querying post-COVID condition codes and visits", flush=True)
    conds = client.query(f"""
        SELECT co.person_id, co.condition_start_date AS d, REPLACE(UPPER(c.concept_code), '.', '') AS code
        FROM `{cdr}.condition_occurrence` co JOIN `{cdr}.concept` c ON co.condition_source_concept_id = c.concept_id
        WHERE c.vocabulary_id = 'ICD10CM' AND co.person_id IN UNNEST(@ids) AND co.condition_start_date BETWEEN @lo AND @hi
          AND REGEXP_CONTAINS(REPLACE(UPPER(c.concept_code), '.', ''), r'{regex}')
    """, job_config=cfg).to_dataframe()
    visits = client.query(f"""
        SELECT v.person_id, v.visit_start_date AS d, c.concept_name AS visit_type
        FROM `{cdr}.visit_occurrence` v LEFT JOIN `{cdr}.concept` c ON v.visit_concept_id = c.concept_id
        WHERE v.person_id IN UNNEST(@ids) AND v.visit_start_date BETWEEN @lo AND @hi
    """, job_config=cfg).to_dataframe()
    X2 = build_extra(cohort, conds, visits)
    F2 = F1.join(X2)
    F2.to_parquet(os.path.join(OUT, "features_v2.parquet"))
    tab = feature_table(X2, cohort.s)
    os.makedirs(EXPORT, exist_ok=True)
    check_exportable(tab)
    tab.to_csv(os.path.join(EXPORT, "t12_feature_counts.csv"), index=False)
    print(f"Task 12 finished: {X2.shape[1]} extra features", flush=True)


if __name__ == "__main__":
    main()
