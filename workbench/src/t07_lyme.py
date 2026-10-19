"""Task 07: Lyme disease pre-diagnosis trajectory versus matched people without Lyme codes.

Runs inside the All of Us Workbench (bash ~/unm/bin/unm.sh run 07).
Exports: ~/unm/export/07/ (suppressed aggregates)

Cases: first ICD-10-CM A69.2x (source) code, age 18+, observed for the 365 days before it.
Controls: up to 4 per case, same age band and sex, no Lyme code ever, observed over the
365 days before the case's (shifted) diagnosis date, which becomes their pseudo-index.
Window: days -365 to -1 before the (pseudo-)index.
Outcomes: Lyme-compatible symptom clusters, outpatient/ED visits, Lyme serology orders,
and "missed opportunities" (a visit with a compatible symptom 30-365 days before diagnosis).
"""

from __future__ import annotations

import os
import subprocess
import sys

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from aou_safe import check_exportable, protect, rate  # noqa: E402

CDR_ID = os.environ.get("UNM_CDR_ID", "R2025Q4R6")
EXPORT = os.path.expanduser("~/unm/export/07")
OUT = os.path.expanduser("~/unm/output")
SYMPTOMS = {  # ICD-10-CM prefixes, dots removed
    "joint_pain_or_arthritis": ["M255", "M1300", "M130", "M129"],
    "fatigue": ["R53"],
    "rash": ["R21", "L539", "L538"],
    "facial_palsy": ["G510"],
    "headache": ["R51", "G44"],
    "fever": ["R50"],
    "myalgia": ["M791"],
    "paresthesia_neuropathy": ["R20", "G629", "G5"],
    "heart_block_palpitations": ["I44", "R002"],
    "tick_bite_or_insect_bite": ["W57", "S"],   # W57 external cause; S-codes filtered to bites below
}
SEROLOGY_CPT = ["86617", "86618"]


def age_band(a):
    return "18-39" if a < 40 else "40-49" if a < 50 else "50-59" if a < 60 else "60-69" if a < 70 else "70+"


def main():
    from google.cloud import bigquery
    cdr = subprocess.check_output(["wb", "resolve", f"--id={CDR_ID}"], text=True).strip()
    client = bigquery.Client()
    print("querying Lyme cases", flush=True)
    cases = client.query(f"""
        WITH lyme AS (
          SELECT co.person_id, MIN(co.condition_start_date) AS dx
          FROM `{cdr}.condition_occurrence` co JOIN `{cdr}.concept` c ON co.condition_source_concept_id = c.concept_id
          WHERE c.vocabulary_id = 'ICD10CM' AND STARTS_WITH(REPLACE(UPPER(c.concept_code), '.', ''), 'A692')
          GROUP BY 1)
        SELECT l.person_id, l.dx, p.year_of_birth, s.concept_name AS sex
        FROM lyme l JOIN `{cdr}.person` p USING (person_id)
        LEFT JOIN `{cdr}.concept` s ON p.sex_at_birth_concept_id = s.concept_id
        WHERE EXISTS (SELECT 1 FROM `{cdr}.observation_period` op WHERE op.person_id = l.person_id
                      AND op.observation_period_start_date <= DATE_SUB(l.dx, INTERVAL 365 DAY)
                      AND op.observation_period_end_date >= l.dx)
    """).to_dataframe()
    cases["dx"] = pd.to_datetime(cases.dx)
    cases["age"] = cases.dx.dt.year - cases.year_of_birth
    cases = cases[cases.age >= 18]
    cases["band"] = cases.age.map(age_band)
    cases["sex"] = cases.sex.fillna("unknown").str.split().str[0]

    print("sampling matched controls", flush=True)
    pool = client.query(f"""
        SELECT p.person_id, p.year_of_birth, s.concept_name AS sex,
               MIN(op.observation_period_start_date) AS obs_start, MAX(op.observation_period_end_date) AS obs_end
        FROM `{cdr}.person` p JOIN `{cdr}.observation_period` op USING (person_id)
        LEFT JOIN `{cdr}.concept` s ON p.sex_at_birth_concept_id = s.concept_id
        WHERE p.person_id NOT IN (
          SELECT co.person_id FROM `{cdr}.condition_occurrence` co JOIN `{cdr}.concept` c
          ON co.condition_source_concept_id = c.concept_id
          WHERE c.vocabulary_id = 'ICD10CM' AND STARTS_WITH(REPLACE(UPPER(c.concept_code), '.', ''), 'A692'))
        GROUP BY 1, 2, 3
    """).to_dataframe()
    pool["obs_start"] = pd.to_datetime(pool.obs_start)
    pool["obs_end"] = pd.to_datetime(pool.obs_end)
    pool["sex"] = pool.sex.fillna("unknown").str.split().str[0]
    rng = np.random.default_rng(7)
    ctrl_rows = []
    pool_by = {k: g for k, g in pool.groupby("sex")}
    for r in cases.itertuples():
        g = pool_by.get(r.sex)
        if g is None:
            continue
        cand = g[(g.obs_start <= r.dx - pd.Timedelta(days=365)) & (g.obs_end >= r.dx)]
        cand = cand[(r.dx.year - cand.year_of_birth).map(age_band) == r.band]
        if len(cand):
            pick = cand.sample(min(4, len(cand)), random_state=int(rng.integers(1e9)))
            for pid in pick.person_id:
                ctrl_rows.append({"person_id": pid, "dx": r.dx, "band": r.band, "sex": r.sex})
    controls = pd.DataFrame(ctrl_rows).drop_duplicates("person_id")
    grp = pd.concat([cases[["person_id", "dx", "band", "sex"]].assign(group="case"),
                     controls.assign(group="control")], ignore_index=True)
    grp.to_parquet(os.path.join(OUT, "t07_lyme_groups.parquet"))

    ids = [int(x) for x in grp.person_id.unique()]
    lo = (grp.dx.min() - pd.Timedelta(days=366)).date().isoformat()
    hi = grp.dx.max().date().isoformat()
    cfg = bigquery.QueryJobConfig(query_parameters=[
        bigquery.ArrayQueryParameter("ids", "INT64", ids), bigquery.ScalarQueryParameter("lo", "DATE", lo),
        bigquery.ScalarQueryParameter("hi", "DATE", hi), bigquery.ArrayQueryParameter("cpt", "STRING", SEROLOGY_CPT)])
    prefixes = sorted({p for v in SYMPTOMS.values() for p in v if p != "S"})
    regex = "^(" + "|".join(prefixes) + "|S[0-9]{2}.{0,3}(A|D|S)?)"
    print("querying pre-diagnosis events", flush=True)
    conds = client.query(f"""
        SELECT co.person_id, co.condition_start_date AS d, REPLACE(UPPER(c.concept_code), '.', '') AS code,
               LOWER(c.concept_name) AS name
        FROM `{cdr}.condition_occurrence` co JOIN `{cdr}.concept` c ON co.condition_source_concept_id = c.concept_id
        WHERE c.vocabulary_id = 'ICD10CM' AND co.person_id IN UNNEST(@ids) AND co.condition_start_date BETWEEN @lo AND @hi
          AND REGEXP_CONTAINS(REPLACE(UPPER(c.concept_code), '.', ''), r'{regex}')
    """, job_config=cfg).to_dataframe()
    visits = client.query(f"""
        SELECT v.person_id, v.visit_start_date AS d, c.concept_name AS visit_type
        FROM `{cdr}.visit_occurrence` v LEFT JOIN `{cdr}.concept` c ON v.visit_concept_id = c.concept_id
        WHERE v.person_id IN UNNEST(@ids) AND v.visit_start_date BETWEEN @lo AND @hi
    """, job_config=cfg).to_dataframe()
    sero = client.query(f"""
        SELECT m.person_id, m.measurement_date AS d FROM `{cdr}.measurement` m
        JOIN `{cdr}.concept` c ON m.measurement_concept_id = c.concept_id
        WHERE m.person_id IN UNNEST(@ids) AND m.measurement_date BETWEEN @lo AND @hi
          AND c.vocabulary_id = 'LOINC' AND LOWER(c.concept_name) LIKE '%borrelia%'
        UNION ALL
        SELECT p.person_id, p.procedure_date AS d FROM `{cdr}.procedure_occurrence` p
        JOIN `{cdr}.concept` c ON p.procedure_source_concept_id = c.concept_id
        WHERE p.person_id IN UNNEST(@ids) AND p.procedure_date BETWEEN @lo AND @hi
          AND c.vocabulary_id IN ('CPT4', 'HCPCS') AND c.concept_code IN UNNEST(@cpt)
    """, job_config=cfg).to_dataframe()

    def window(ev, lo_d=-365, hi_d=-1):
        e = ev.merge(grp[["person_id", "dx", "group"]], on="person_id")
        off = (pd.to_datetime(e.d) - e.dx).dt.days
        return e[(off >= lo_d) & (off <= hi_d)].assign(off=off)

    c = window(conds)
    bite = c.code.str.startswith("W57") | (c.code.str.startswith("S") & c.name.str.contains("bite"))
    rows = []
    n_case, n_ctrl = int((grp.group == "case").sum()), int((grp.group == "control").sum())
    for sym, pre in SYMPTOMS.items():
        if sym == "tick_bite_or_insect_bite":
            m = bite
        else:
            m = c.code.str.startswith(tuple(pre))
        who = c[m].groupby("group").person_id.nunique()
        rows.append({"measure": f"any {sym} code, days -365 to -1", "cases_with": int(who.get("case", 0)),
                     "controls_with": int(who.get("control", 0))})
    s = window(sero)
    who = s.groupby("group").person_id.nunique()
    rows.append({"measure": "Lyme serology ordered, days -365 to -1", "cases_with": int(who.get("case", 0)),
                 "controls_with": int(who.get("control", 0))})
    compatible = c[~bite & c.code.str.startswith(tuple(p for k, v in SYMPTOMS.items() if k != "tick_bite_or_insect_bite" for p in v))]
    missed = compatible[(compatible.off >= -365) & (compatible.off <= -30)].groupby("group").person_id.nunique()
    rows.append({"measure": "missed opportunity: compatible symptom code 30-365 days before", "cases_with": int(missed.get("case", 0)),
                 "controls_with": int(missed.get("control", 0))})
    t = pd.DataFrame(rows)
    t["n_cases"], t["n_controls"] = n_case, n_ctrl
    prot = protect(t, ["cases_with", "controls_with", "n_cases", "n_controls"])
    prot["pct_cases"] = [rate(a, n_case, sa, 0) for a, sa in zip(t.cases_with, prot.cases_with)]
    prot["pct_controls"] = [rate(b, n_ctrl, sb, 0) for b, sb in zip(t.controls_with, prot.controls_with)]

    v = window(visits)
    v["cls"] = np.where(v.visit_type.fillna("").str.lower().str.contains("emergency"), "ed", "other")
    per = v.groupby(["group", "person_id", "cls"]).size().unstack(fill_value=0)
    per = per.reindex(pd.MultiIndex.from_frame(grp[["group", "person_id"]]), fill_value=0)
    vis = per.groupby(level="group").mean().round(3).reset_index().rename(columns={"ed": "mean_ed_visits", "other": "mean_other_visits"})

    os.makedirs(EXPORT, exist_ok=True)
    for name, df in {"t07_lyme_prediagnosis": prot, "t07_lyme_visits": vis}.items():
        check_exportable(df)
        df.to_csv(os.path.join(EXPORT, f"{name}.csv"), index=False)
    print("Task 07 finished", flush=True)


if __name__ == "__main__":
    main()
