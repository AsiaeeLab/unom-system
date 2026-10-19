"""Task 02: feature mart for the Long COVID landmark cohort.

Runs inside the All of Us Workbench through the runner (bash ~/unm/bin/unm.sh run 02).
Input : ~/unm/output/cohort_v2.parquet   (Task 01)
Output: ~/unm/output/features_v1.parquet  (participant level; stays in Workbench)
Export: ~/unm/export/02/                  (suppressed aggregates and vocabulary code lists)

Feature definitions come from features.yaml (the same registry the app uses).
Windows are days relative to the COVID index: W0 [-365,-91], W1 [-90,-1], W2 [0,30], W3 [31,90].
"""

from __future__ import annotations

import os
import re
import subprocess
import sys

import json

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from aou_safe import SUPPRESSED, check_exportable, protect, rate  # noqa: E402

CDR_ID = os.environ.get("UNM_CDR_ID", "R2025Q4R6")
OUT = os.path.expanduser("~/unm/output")
EXPORT = os.path.expanduser("~/unm/export/02")
HERE = os.path.dirname(os.path.abspath(__file__))
try:  # PyYAML may be missing in Workbench; features.json is the same registry
    import yaml
    REG = yaml.safe_load(open(os.path.join(HERE, "features.yaml")))
except (ImportError, FileNotFoundError):
    REG = json.load(open(os.path.join(HERE, "features.json")))
W = {k: tuple(v) for k, v in REG["windows"].items()}
OUTCOME = (91, 455)


def expand_cpt(items):
    out = []
    for it in items:
        if "-" in it and it.replace("-", "").isdigit():
            a, b = it.split("-")
            out += [str(x) for x in range(int(a), int(b) + 1)]
        else:
            out.append(it)
    return out


def condition_prefix_map() -> dict:
    """feature id -> list of ICD-10-CM prefixes (dots removed)."""
    m = {}
    for f in REG["new_symptoms"]:
        if "icd10cm_prefix" in f:
            m[f["id"]] = [str(p) for p in f["icd10cm_prefix"]]
    for f in REG["prior_conditions"]:
        m[f["id"]] = [str(p) for p in f["icd10cm_prefix"]]
    for f in REG["face_validity"]["negative_control_outcomes"]:
        m[f["id"]] = [str(p) for p in f["icd10cm_prefix"]]
    for f in REG["acute"]:
        if "icd10cm_prefix" in f:
            m[f["id"]] = [str(p) for p in f["icd10cm_prefix"]]
    return m


# ----------------------------------------------------------------------------
# Data access
# ----------------------------------------------------------------------------

def load_from_cdr(cohort: pd.DataFrame):
    from google.cloud import bigquery

    cdr = subprocess.check_output(["wb", "resolve", f"--id={CDR_ID}"], text=True).strip()
    client = bigquery.Client()
    ids = [int(x) for x in cohort.index]
    lo = (cohort.index_date.min() - pd.Timedelta(days=366)).date().isoformat()
    hi = (cohort.index_date.max() + pd.Timedelta(days=OUTCOME[1] + 1)).date().isoformat()
    cfg = bigquery.QueryJobConfig(query_parameters=[
        bigquery.ArrayQueryParameter("ids", "INT64", ids),
        bigquery.ScalarQueryParameter("lo", "DATE", lo),
        bigquery.ScalarQueryParameter("hi", "DATE", hi)])

    prefixes = sorted({p for v in condition_prefix_map().values() for p in v})
    regex = "^(" + "|".join(prefixes) + ")"
    print("querying conditions", flush=True)
    conds = client.query(f"""
        SELECT co.person_id, co.condition_start_date AS d, REPLACE(UPPER(c.concept_code), '.', '') AS code
        FROM `{cdr}.condition_occurrence` co
        JOIN `{cdr}.concept` c ON co.condition_source_concept_id = c.concept_id
        WHERE c.vocabulary_id = 'ICD10CM' AND co.person_id IN UNNEST(@ids)
          AND co.condition_start_date BETWEEN @lo AND @hi
          AND REGEXP_CONTAINS(REPLACE(UPPER(c.concept_code), '.', ''), r'{regex}')
    """, job_config=cfg).to_dataframe()

    print("querying visits", flush=True)
    visits = client.query(f"""
        SELECT v.person_id, v.visit_start_date AS d, c.concept_name AS visit_type
        FROM `{cdr}.visit_occurrence` v
        LEFT JOIN `{cdr}.concept` c ON v.visit_concept_id = c.concept_id
        WHERE v.person_id IN UNNEST(@ids) AND v.visit_start_date BETWEEN @lo AND @hi
    """, job_config=cfg).to_dataframe()

    cpt = sorted({c for f in REG["new_tests"]["procedures"] for c in expand_cpt(f["cpt"])}
                 | {c for f in REG["acute"] if "cpt" in f for c in f["cpt"]})
    pcs = sorted({c for f in REG["acute"] if "icd10pcs" in f for c in f["icd10pcs"]})
    print("querying procedures", flush=True)
    procs = client.query(f"""
        SELECT p.person_id, p.procedure_date AS d, c.concept_code AS code, c.vocabulary_id AS vocab
        FROM `{cdr}.procedure_occurrence` p
        JOIN `{cdr}.concept` c ON p.procedure_source_concept_id = c.concept_id
        WHERE p.person_id IN UNNEST(@ids) AND p.procedure_date BETWEEN @lo AND @hi
          AND ((c.vocabulary_id IN ('CPT4', 'HCPCS') AND c.concept_code IN UNNEST(@cpt))
               OR (c.vocabulary_id = 'ICD10PCS' AND c.concept_code IN UNNEST(@pcs)))
    """, job_config=bigquery.QueryJobConfig(query_parameters=cfg.query_parameters + [
        bigquery.ArrayQueryParameter("cpt", "STRING", cpt),
        bigquery.ArrayQueryParameter("pcs", "STRING", pcs)])).to_dataframe()

    labs = REG["new_tests"]["labs"]
    lab_rows = ", ".join(f"STRUCT('{f['id']}' AS fid, '%{f['loinc_seed'].lower()}%' AS pat)" for f in labs)
    print("resolving lab codes and querying measurements", flush=True)
    lab_codes = client.query(f"""
        WITH seeds AS (SELECT * FROM UNNEST([{lab_rows}]))
        SELECT s.fid, c.concept_id, c.concept_code, c.concept_name
        FROM seeds s JOIN `{cdr}.concept` c
          ON c.vocabulary_id = 'LOINC' AND c.standard_concept = 'S' AND c.domain_id = 'Measurement'
         AND LOWER(c.concept_name) LIKE s.pat
    """).to_dataframe()
    meas = client.query(f"""
        SELECT m.person_id, m.measurement_date AS d, m.measurement_concept_id AS concept_id
        FROM `{cdr}.measurement` m
        WHERE m.person_id IN UNNEST(@ids) AND m.measurement_date BETWEEN @lo AND @hi
          AND m.measurement_concept_id IN UNNEST(@cids)
    """, job_config=bigquery.QueryJobConfig(query_parameters=cfg.query_parameters + [
        bigquery.ArrayQueryParameter("cids", "INT64", [int(x) for x in lab_codes.concept_id.unique()])])).to_dataframe()
    meas = meas.merge(lab_codes[["fid", "concept_id"]], on="concept_id")[["person_id", "d", "fid"]]

    ing_rows = ", ".join(f"STRUCT('{f['id']}' AS fid, '{n.lower()}' AS name)"
                         for f in REG["new_medications"] for n in f["rxnorm_ingredients"])
    print("resolving drug codes and querying drug exposures", flush=True)
    drug_codes = client.query(f"""
        WITH ing AS (SELECT * FROM UNNEST([{ing_rows}])),
        ic AS (SELECT i.fid, c.concept_id AS ingredient_id FROM ing i JOIN `{cdr}.concept` c
               ON c.vocabulary_id = 'RxNorm' AND c.concept_class_id = 'Ingredient' AND LOWER(c.concept_name) = i.name)
        SELECT ic.fid, d.concept_id, d.concept_code
        FROM ic JOIN `{cdr}.concept_ancestor` a ON a.ancestor_concept_id = ic.ingredient_id
        JOIN `{cdr}.concept` d ON d.concept_id = a.descendant_concept_id AND d.vocabulary_id IN ('RxNorm', 'RxNorm Extension')
    """).to_dataframe()
    drugs = client.query(f"""
        SELECT de.person_id, de.drug_exposure_start_date AS d, de.drug_concept_id AS concept_id
        FROM `{cdr}.drug_exposure` de
        WHERE de.person_id IN UNNEST(@ids) AND de.drug_exposure_start_date BETWEEN @lo AND @hi
          AND de.drug_concept_id IN UNNEST(@cids)
    """, job_config=bigquery.QueryJobConfig(query_parameters=cfg.query_parameters + [
        bigquery.ArrayQueryParameter("cids", "INT64", [int(x) for x in drug_codes.concept_id.unique()])])).to_dataframe()
    drugs = drugs.merge(drug_codes[["fid", "concept_id"]].drop_duplicates(), on="concept_id")[["person_id", "d", "fid"]]
    return conds, visits, procs, meas, drugs, lab_codes, drug_codes


# ----------------------------------------------------------------------------
# Feature construction (pure pandas; tested locally)
# ----------------------------------------------------------------------------

def _offset(ev: pd.DataFrame, index: pd.Series) -> pd.DataFrame:
    e = ev.merge(index.rename("index_date"), left_on="person_id", right_index=True)
    e["off"] = (pd.to_datetime(e.d) - e.index_date).dt.days
    return e


def _in(off: pd.Series, *wins) -> pd.Series:
    mask = pd.Series(False, index=off.index)
    for w in wins:
        lo, hi = W[w] if isinstance(w, str) else w
        mask |= (off >= lo) & (off <= hi)
    return mask


def _persons(e: pd.DataFrame, mask: pd.Series) -> set:
    return set(e.loc[mask, "person_id"])


def visit_class(name) -> str:
    n = str(name or "").lower()
    if "inpatient" in n:
        return "IMP"
    if "emergency" in n:
        return "EMER"
    if "pharmacy" in n or "laboratory" in n:
        return "OTHER"
    return "AMB"


def build_features(cohort: pd.DataFrame, conds, visits, procs, meas, drugs) -> pd.DataFrame:
    idx = cohort.index_date
    X = pd.DataFrame(index=cohort.index)
    # demographics
    for f in REG["demographics"]:
        if f["kind"] == "age_band":
            X[f["id"]] = ((cohort.age >= f["min"]) & (cohort.age <= f["max"] + 0.999)).astype(int)
        elif f["kind"] == "sex":
            X[f["id"]] = (cohort.sex.str.lower() == f["value"]).astype(int)

    # conditions
    c = _offset(conds, idx)
    pmap = condition_prefix_map()
    code = c.code.astype(str)

    def cond_mask(fid):
        return code.str.startswith(tuple(pmap[fid]))

    for f in REG["new_symptoms"]:
        if f.get("kind") == "derived_count_ge":
            continue
        m = cond_mask(f["id"])
        present = _persons(c, m & _in(c.off, "W2", "W3"))
        before = _persons(c, m & _in(c.off, "W0", "W1"))
        X[f["id"]] = X.index.isin(present - before).astype(int)
    sym_ids = [f["id"] for f in REG["new_symptoms"] if f.get("kind") != "derived_count_ge"]
    n_sym = X[sym_ids].sum(axis=1)
    for f in REG["new_symptoms"]:
        if f.get("kind") == "derived_count_ge":
            X[f["id"]] = (n_sym >= f["threshold"]).astype(int)
    for f in REG["prior_conditions"]:
        X[f["id"]] = X.index.isin(_persons(c, cond_mask(f["id"]) & _in(c.off, "W0", "W1"))).astype(int)

    # visits
    v = _offset(visits, idx)
    v["cls"] = v.visit_type.map(visit_class)
    for f in REG["acute"]:
        lo, hi = f["window"]
        if f["kind"] == "encounter_any":
            X[f["id"]] = X.index.isin(_persons(v, v.cls.isin(f["encounter_class"]) & _in(v.off, (lo, hi)))).astype(int)
        elif f.get("resource") == "Condition":
            X[f["id"]] = X.index.isin(_persons(c, cond_mask(f["id"]) & _in(c.off, (lo, hi)))).astype(int)
    counts = {}
    for cls in ["AMB", "EMER", "IMP"]:
        for w in W:
            m = (v.cls == cls) & _in(v.off, w)
            counts[(cls, w)] = v[m].groupby("person_id").size().reindex(X.index, fill_value=0)
    for f in REG["utilization"]:
        if f["kind"] == "encounter_count_ge":
            n = sum(counts[(cls, w)] for cls in f["encounter_class"] for w in f["windows"])
            X[f["id"]] = (n >= f["threshold"]).astype(int)
        elif f["kind"] == "encounter_rate_ratio_ge":
            num = sum(counts[(cls, f["numerator"])] for cls in f["encounter_class"])
            den = sum(counts[(cls, f["denominator"])] for cls in f["encounter_class"])
            len_num = W[f["numerator"]][1] - W[f["numerator"]][0] + 1
            len_den = W[f["denominator"]][1] - W[f["denominator"]][0] + 1
            ratio = (num / len_num) / (den / len_den).replace(0, np.nan)
            X[f["id"]] = ((ratio >= f["threshold"]) | ((den == 0) & (num > 0))).astype(int)

    # procedures (tests and ventilation)
    p = _offset(procs, idx)
    for f in REG["new_tests"]["procedures"]:
        codes = set(expand_cpt(f["cpt"]))
        X[f["id"]] = X.index.isin(_persons(p, p.code.astype(str).isin(codes) & _in(p.off, "W2", "W3"))).astype(int)
    for f in REG["acute"]:
        if f.get("resource") == "Procedure":
            codes = set(f.get("cpt", [])) | set(f.get("icd10pcs", []))
            lo, hi = f["window"]
            X[f["id"]] = X.index.isin(_persons(p, p.code.astype(str).isin(codes) & _in(p.off, (lo, hi)))).astype(int)

    # labs and medications (already mapped to feature ids)
    m = _offset(meas, idx)
    for f in REG["new_tests"]["labs"]:
        X[f["id"]] = X.index.isin(_persons(m, (m.fid == f["id"]) & _in(m.off, "W2", "W3"))).astype(int)
    d = _offset(drugs, idx)
    for f in REG["new_medications"]:
        now = _persons(d, (d.fid == f["id"]) & _in(d.off, "W2", "W3"))
        before = _persons(d, (d.fid == f["id"]) & _in(d.off, "W0", "W1"))
        X[f["id"]] = X.index.isin(now - before).astype(int)

    # outcome-window checks (never model inputs)
    for fid in REG["face_validity"]["long_covid_typical_outcomes"]:
        mk = cond_mask(fid)
        X["yout_" + fid] = X.index.isin(_persons(c, mk & _in(c.off, OUTCOME))).astype(int)
    for f in REG["face_validity"]["negative_control_outcomes"]:
        X["yout_" + f["id"]] = X.index.isin(_persons(c, cond_mask(f["id"]) & _in(c.off, OUTCOME))).astype(int)
    return X


def feature_table(X: pd.DataFrame, s: pd.Series) -> pd.DataFrame:
    """Per-feature counts among labeled (s=1) and unlabeled (s=0), suppressed."""
    rows = []
    n1, n0 = int(s.sum()), int((1 - s).sum())
    for col in X.columns:
        a = int(X.loc[s == 1, col].sum())
        b = int(X.loc[s == 0, col].sum())
        rows.append({"feature": col, "n_s1_with": a, "n_s1_without": n1 - a, "n_s0_with": b, "n_s0_without": n0 - b})
    raw = pd.DataFrame(rows)
    prot = protect(raw, ["n_s1_with", "n_s1_without", "n_s0_with", "n_s0_without"], partition=False)
    prot["prev_s1"] = [rate(a, n1, sa, 0) for a, sa in zip(raw.n_s1_with, prot.n_s1_with)]
    prot["prev_s0"] = [rate(b, n0, sb, 0) for b, sb in zip(raw.n_s0_with, prot.n_s0_with)]
    # crude odds ratio only where all four cells are shown
    ors = []
    for r, pr in zip(raw.itertuples(), prot.itertuples()):
        cells = [pr.n_s1_with, pr.n_s1_without, pr.n_s0_with, pr.n_s0_without]
        if any(isinstance(x, str) for x in cells):
            ors.append(SUPPRESSED)
        elif min(r.n_s1_with, r.n_s1_without, r.n_s0_with, r.n_s0_without) == 0:
            ors.append("")
        else:
            ors.append(float(f"{(r.n_s1_with * r.n_s0_without) / (r.n_s1_without * r.n_s0_with):.3g}"))
    prot["crude_or"] = ors
    return prot


def main():
    cohort = pd.read_parquet(os.path.join(OUT, "cohort_v2.parquet"))
    cohort = cohort[cohort.landmark_eligible == 1].copy()
    cohort["index_date"] = pd.to_datetime(cohort.index_date)
    print(f"landmark cohort loaded", flush=True)
    conds, visits, procs, meas, drugs, lab_codes, drug_codes = load_from_cdr(cohort)
    X = build_features(cohort, conds, visits, procs, meas, drugs)
    X.to_parquet(os.path.join(OUT, "features_v1.parquet"))
    print("features saved inside Workbench", flush=True)

    os.makedirs(EXPORT, exist_ok=True)
    tab = feature_table(X, cohort.s)
    check_exportable(tab)
    tab.to_csv(os.path.join(EXPORT, "t02_feature_counts.csv"), index=False)
    # vocabulary code lists for the app (concept codes as text, no participant data)
    lc = lab_codes.assign(loinc=lab_codes.concept_code.astype(str))[["fid", "loinc", "concept_name"]].drop_duplicates()
    lc.to_csv(os.path.join(EXPORT, "t02_codelist_labs.csv"), index=False)
    dc = (drug_codes.assign(rxcui="rxcui:" + drug_codes.concept_code.astype(str))[["fid", "rxcui"]]
          .drop_duplicates().sort_values(["fid", "rxcui"]))
    dc.to_csv(os.path.join(EXPORT, "t02_codelist_drugs.csv"), index=False)
    print("Task 02 finished", flush=True)


if __name__ == "__main__":
    main()
