"""Task 21: lab result values and vital signs as features.

Runs inside the All of Us Workbench (bash ~/unm/bin/unm.sh run 21).
Inputs : ~/unm/output/{cohort_v2,features_v3}.parquet; CDR measurement table
Output : ~/unm/output/features_v3_task21.parquet (Task 35 features plus the columns below; stays in Workbench).
         The October 1, 2026 run wrote this matrix as features_v3.parquet; Task 35 (October 3) reused that name
         for matrix A and overwrote it, and Tasks 36, 37, 41, and 48 read Task 35's file under that name.
Exports: ~/unm/export/21/
  t21_feature_counts: per new feature, counts among coded / uncoded (t02 format, protected)
  t21_coverage: share of the cohort with any measurement of each kind in days 0-90 (from rounded counts)
  t21_performance: elastic net with features_v3 vs features_v3 plus labs and vitals, 5-fold CV and the Task 03
      held-out sites; bootstrap intervals with N_BOOT replicates
The abnormal-result classification below has known defects; Task 47 reruns this analysis with the
corrected classification (t47_p1_audit_fixes.lab_abnormal_fixed).

New features (information by day 90 only):
- lab_<x>_abnormal for the 10 registry labs: any result in days 0-90 outside the reference range
  (above range_high; below range_low for vitamin D and B12; outside either for TSH), or flagged
  High/Low/Abnormal/Positive by value_as_concept, or, when no range is recorded, beyond a fixed
  unit-specific threshold (see THRESHOLDS).
- hr_gt100_w3: any heart rate > 100/min in days 31-90; hr_mean_w3_gt90: mean heart rate in days 31-90 > 90;
  hr_rise_ge10: mean heart rate in days 31-90 at least 10/min above the mean in days -365..-1;
  spo2_lt94: any oxygen saturation < 94% in days 0-90.
"""

from __future__ import annotations

import os
import subprocess
import sys

import numpy as np
import pandas as pd

try:
    import db_dtypes  # noqa: F401
except ImportError:
    pass

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import t02_features as t02  # noqa: E402
from aou_safe import SUPPRESSED, check_exportable  # noqa: E402
from t03_models import fmt, metrics  # noqa: E402
from t13_landmarks import en_model, oof, r10  # noqa: E402
from t16_site_counts import site_split  # noqa: E402

CDR_ID = os.environ.get("UNM_CDR_ID", "R2025Q4R6")
OUT = os.path.expanduser("~/unm/output")
EXPORT = os.path.expanduser("~/unm/export/21")
VITALS = {"heart_rate": ["8867-4"], "spo2": ["59408-5", "2708-6"]}
# fallback thresholds when no reference range is recorded: (unit substring, low, high); abnormal outside
THRESHOLDS = {
    "lab_d_dimer": [("ng/ml", None, 500), ("ug/ml", None, 0.5), ("mg/l", None, 0.5)],
    "lab_crp": [("mg/l", None, 10), ("mg/dl", None, 1.0)],
    "lab_esr": [("mm/h", None, 30)],
    "lab_ferritin": [("ng/ml", None, 300), ("ug/l", None, 300)],
    "lab_troponin": [("ng/ml", None, 0.04), ("ng/l", None, 14), ("pg/ml", None, 14)],
    "lab_natriuretic": [("pg/ml", None, 125), ("ng/l", None, 125)],
    "lab_tsh": [("iu/l", 0.4, 4.5), ("iu/ml", 0.4, 4.5)],
    "lab_vitamin_d": [("ng/ml", 20, None), ("nmol/l", 50, None)],
    "lab_b12": [("pg/ml", 200, None), ("pmol/l", 148, None)],
    "lab_ana": [("titer", None, 79)],
}
LOW_ONLY = {"lab_vitamin_d", "lab_b12"}
OUTPUT = "features_v3_task21.parquet"
FEATURES = "features_v3.parquet"
N_BOOT = 200   # replicates for t03_models.metrics, as in the released Task 21 run (set in main, not at import)
FLAG_WORDS = ("high", "low", "abnormal", "positive", "detected", "reactive", "critical")


def load_measurements(cohort):
    from google.cloud import bigquery
    cdr = subprocess.check_output(["wb", "resolve", f"--id={CDR_ID}"], text=True).strip()
    client = bigquery.Client()
    lo = (cohort.index_date.min() - pd.Timedelta(days=366)).date().isoformat()
    hi = (cohort.index_date.max() + pd.Timedelta(days=91)).date().isoformat()
    labs = t02.REG["new_tests"]["labs"]
    lab_rows = ", ".join(f"STRUCT('{f['id']}' AS fid, '%{f['loinc_seed'].lower()}%' AS pat)" for f in labs)
    vit_rows = ", ".join(f"STRUCT('{k}' AS fid, '{c}' AS code)" for k, v in VITALS.items() for c in v)
    cfg = bigquery.QueryJobConfig(query_parameters=[
        bigquery.ArrayQueryParameter("ids", "INT64", [int(x) for x in cohort.index]),
        bigquery.ScalarQueryParameter("lo", "DATE", lo), bigquery.ScalarQueryParameter("hi", "DATE", hi)])
    print("querying lab values and vital signs", flush=True)
    return client.query(f"""
        WITH seeds AS (SELECT * FROM UNNEST([{lab_rows}])),
        vit AS (SELECT * FROM UNNEST([{vit_rows}])),
        codes AS (
          SELECT s.fid, c.concept_id FROM seeds s JOIN `{cdr}.concept` c
            ON c.vocabulary_id = 'LOINC' AND c.standard_concept = 'S' AND c.domain_id = 'Measurement'
           AND LOWER(c.concept_name) LIKE s.pat
          UNION ALL
          SELECT v.fid, c.concept_id FROM vit v JOIN `{cdr}.concept` c
            ON c.vocabulary_id = 'LOINC' AND c.concept_code = v.code)
        SELECT m.person_id, m.measurement_date AS d, k.fid, m.value_as_number AS value,
               LOWER(IFNULL(u.concept_name, '')) AS unit, m.range_low, m.range_high,
               LOWER(IFNULL(vc.concept_name, '')) AS value_concept
        FROM `{cdr}.measurement` m
        JOIN codes k ON m.measurement_concept_id = k.concept_id
        LEFT JOIN `{cdr}.concept` u ON m.unit_concept_id = u.concept_id
        LEFT JOIN `{cdr}.concept` vc ON m.value_as_concept_id = vc.concept_id
        WHERE m.person_id IN UNNEST(@ids) AND m.measurement_date BETWEEN @lo AND @hi
    """, job_config=cfg).to_dataframe()


def lab_abnormal(df: pd.DataFrame) -> pd.Series:
    """Row-wise abnormal flag for lab rows (fid starts with lab_)."""
    v = pd.to_numeric(df.value, errors="coerce")
    rh, rl = pd.to_numeric(df.range_high, errors="coerce"), pd.to_numeric(df.range_low, errors="coerce")
    flag = df.value_concept.fillna("").str.contains("|".join(FLAG_WORDS)) & ~df.value_concept.fillna("").str.contains("not detected|negative|normal")
    has_range = rh.notna() & (rh > 0) | rl.notna()
    low_only = df.fid.isin(LOW_ONLY)
    tsh = df.fid == "lab_tsh"
    by_range = has_range & (((~low_only) & (v > rh)) | ((low_only | tsh) & (v < rl)))
    by_unit = pd.Series(False, index=df.index)
    for fid, rules in THRESHOLDS.items():
        k = (df.fid == fid) & ~has_range & v.notna()
        for unit, lo_t, hi_t in rules:
            u = k & df.unit.fillna("").str.contains(unit, regex=False)
            if hi_t is not None:
                by_unit |= u & (v > hi_t)
            if lo_t is not None:
                by_unit |= u & (v < lo_t)
    return (flag | by_range | by_unit).fillna(False)


def build_v3(cohort: pd.DataFrame, meas: pd.DataFrame) -> pd.DataFrame:
    X = pd.DataFrame(index=cohort.index)
    m = t02._offset(meas, cohort.index_date)
    labs = m[m.fid.str.startswith("lab_")].copy()
    labs["abn"] = lab_abnormal(labs).to_numpy()
    in90 = (labs.off >= 0) & (labs.off <= 90)
    for f in t02.REG["new_tests"]["labs"]:
        X[f"{f['id']}_abnormal"] = X.index.isin(set(labs.loc[in90 & labs.abn & (labs.fid == f["id"]), "person_id"])).astype(int)
    hr = m[(m.fid == "heart_rate")].copy()
    hr["v"] = pd.to_numeric(hr.value, errors="coerce")
    hr = hr[(hr.v >= 25) & (hr.v <= 250)]
    w3 = hr[(hr.off >= 31) & (hr.off <= 90)]
    base = hr[(hr.off >= -365) & (hr.off <= -1)]
    X["hr_gt100_w3"] = X.index.isin(set(w3.loc[w3.v > 100, "person_id"])).astype(int)
    mean_w3, mean_base = w3.groupby("person_id").v.mean(), base.groupby("person_id").v.mean()
    X["hr_mean_w3_gt90"] = (mean_w3.reindex(X.index) > 90).astype(int)
    X["hr_rise_ge10"] = ((mean_w3 - mean_base).reindex(X.index) >= 10).astype(int)
    sp = m[(m.fid == "spo2")].copy()
    sp["v"] = pd.to_numeric(sp.value, errors="coerce")
    X["spo2_lt94"] = X.index.isin(set(sp.loc[(sp.off >= 0) & (sp.off <= 90) & (sp.v >= 50) & (sp.v < 94), "person_id"])).astype(int)
    return X


def coverage(cohort, meas):
    m = t02._offset(meas, cohort.index_date)
    in90 = m[(m.off >= 0) & (m.off <= 90)]
    n = len(cohort)
    rows = []
    for fid, g in in90.groupby("fid"):
        k = g.person_id.nunique()
        with_range = g[pd.to_numeric(g.range_high, errors="coerce").notna()].person_id.nunique()
        rows.append({"measure": fid, "share_with_any_result_days_0_90": round(r10(k) / r10(n), 3) if k > 20 else SUPPRESSED,
                     "share_with_reference_range": round(r10(with_range) / r10(k), 3) if with_range > 20 and k > 20 else SUPPRESSED})
    return pd.DataFrame(rows)


def performance(cohort, F2, F3, y):
    rows = []
    test = site_split(cohort)
    for name, F in (("features_v3 (both condition domains)", F2), ("features_v3 plus lab values and vital signs", F3)):
        X = F.to_numpy(float)
        rows.append({"features": name, "evaluation": "5-fold CV", **{k: v for k, v in fmt(metrics(y, oof(X, y, make=en_model))).items()
                                                                     if k in ("auroc", "auroc_lo", "auroc_hi", "auprc", "recall_top5", "ppv_top5")}})
        m = en_model().fit(X[~test], y[~test])
        rows.append({"features": name, "evaluation": "held-out sites", **{k: v for k, v in fmt(metrics(y[test], m.predict_proba(X[test])[:, 1])).items()
                                                                          if k in ("auroc", "auroc_lo", "auroc_hi", "auprc", "recall_top5", "ppv_top5")}})
    return pd.DataFrame(rows)


def main(loader=load_measurements):
    import t03_models
    saved = t03_models.N_BOOT
    t03_models.N_BOOT = N_BOOT
    try:
        run(loader)
    finally:
        t03_models.N_BOOT = saved


def run(loader=load_measurements):
    cohort = pd.read_parquet(os.path.join(OUT, "cohort_v2.parquet"))
    cohort = cohort[cohort.landmark_eligible == 1].copy()
    cohort["index_date"] = pd.to_datetime(cohort.index_date)
    F2 = pd.read_parquet(os.path.join(OUT, FEATURES)).loc[cohort.index]
    F2 = F2[[c for c in F2.columns if not c.startswith("yout_")]]
    meas = loader(cohort)
    print("measurements loaded", flush=True)
    X3 = build_v3(cohort, meas)
    F3 = F2.join(X3)
    F3.to_parquet(os.path.join(OUT, OUTPUT))
    y = cohort.s.to_numpy().astype(int)
    os.makedirs(EXPORT, exist_ok=True)
    for name, df in (("t21_feature_counts", t02.feature_table(X3, cohort.s)), ("t21_coverage", coverage(cohort, meas)),
                     ("t21_performance", performance(cohort, F2, F3, y))):
        check_exportable(df)
        df.to_csv(os.path.join(EXPORT, f"{name}.csv"), index=False)
        print(f"exported {name} ({len(df)} rows)", flush=True)
    print("Task 21 finished", flush=True)


if __name__ == "__main__":
    main()
