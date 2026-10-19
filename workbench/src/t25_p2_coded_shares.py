"""Task 25 (Paper 2): EHR coded shares by condition and group, and survey-item discovery.

Runs inside the All of Us Workbench (bash ~/unm/bin/unm.sh run 25).
Exports: ~/unm/export/25/
  t25_coded_shares: for each condition, among active adult EHR patients (at least one visit in each
      of two consecutive years, shifted 2021-07-01 to 2023-06-30; age 18+ on 2023-01-01; women only for
      endometriosis), the number with any ICD-10-CM code ever and with codes on two or more dates at
      least 30 days apart, by sex at birth, age band, and race and ethnicity (all groups listed, no
      overall row). Counts rounded up to 10 with primary, complementary, and partition suppression
      within each condition x axis block when another complete, shown axis supplies its total;
      shares computed from the shown (rounded) counts.
  t25_survey_items: Personal and Family Health History (and other PPI) question and answer concepts
      whose names mention the conditions, with the number of respondents (rounded; 1-20 suppressed).
      Vocabulary information for writing the self-report vs EHR comparison (Task 26).
"""

from __future__ import annotations

import os
import subprocess
import sys

import pandas as pd

try:
    import db_dtypes  # noqa: F401
except ImportError:
    pass

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from aou_safe import MAX_SUPPRESSED, SECONDARY, SUPPRESSED, check_exportable, protect  # noqa: E402
from t01_cohort import _age_band, _race_eth, _sex  # noqa: E402

CDR_ID = os.environ.get("UNM_CDR_ID", "R2025Q4R6")
EXPORT = os.path.expanduser("~/unm/export/25")
CONDITIONS = {
    "hypertension": ["I10", "I11", "I12", "I13", "I15", "I16"],
    "diabetes_type2": ["E11"],
    "obesity": ["E66", "Z683", "Z684"],
    "depression": ["F32", "F33"],
    "anxiety": ["F41"],
    "long_covid": ["U099"],
    "mecfs_postviral": ["G933"],
    "chronic_fatigue_unspecified": ["R5382"],
    "chronic_pain": ["G892", "G894"],
    "migraine": ["G43"],
    "fibromyalgia": ["M797"],
    "endometriosis": ["N80"],
    "lyme": ["A692"],
}
KEYWORDS = ["hypertension", "high blood pressure", "type 2 diabetes", "diabetes", "obesity", "depression",
            "anxiety", "migraine", "chronic fatigue", "fibromyalgia", "endometriosis", "lyme", "long covid",
            "post covid", "chronic pain", "myalgic"]


def r10(v):
    return int(-(-int(v) // 10) * 10)


def share(num, den):
    return round(r10(num) / r10(den), 4) if num > 20 and den > 20 else SUPPRESSED


def query(cdr):
    from google.cloud import bigquery
    client = bigquery.Client()
    case = "\n".join(f"WHEN REGEXP_CONTAINS(code, r'^({'|'.join(v)})') THEN '{k}'" for k, v in CONDITIONS.items())
    allre = "^(" + "|".join(p for v in CONDITIONS.values() for p in v) + ")"
    print("querying active EHR population", flush=True)
    pop = client.query(f"""
        WITH v AS (
          SELECT person_id,
                 COUNTIF(visit_start_date BETWEEN '2021-07-01' AND '2022-06-30') AS y1,
                 COUNTIF(visit_start_date BETWEEN '2022-07-01' AND '2023-06-30') AS y2
          FROM `{cdr}.visit_occurrence` GROUP BY person_id)
        SELECT p.person_id, p.year_of_birth, sx.concept_name AS sex_name, r.concept_name AS race_name,
               e.concept_name AS eth_name
        FROM v JOIN `{cdr}.person` p USING (person_id)
        LEFT JOIN `{cdr}.concept` sx ON p.sex_at_birth_concept_id = sx.concept_id
        LEFT JOIN `{cdr}.concept` r ON p.race_concept_id = r.concept_id
        LEFT JOIN `{cdr}.concept` e ON p.ethnicity_concept_id = e.concept_id
        WHERE v.y1 > 0 AND v.y2 > 0 AND p.year_of_birth <= 2004
    """).to_dataframe()
    print("querying condition codes", flush=True)
    codes = client.query(f"""
        WITH c AS (
          SELECT co.person_id, co.condition_start_date AS d, REPLACE(UPPER(k.concept_code), '.', '') AS code
          FROM `{cdr}.condition_occurrence` co JOIN `{cdr}.concept` k ON co.condition_source_concept_id = k.concept_id
          WHERE k.vocabulary_id = 'ICD10CM' AND REGEXP_CONTAINS(REPLACE(UPPER(k.concept_code), '.', ''), r'{allre}'))
        SELECT person_id, cond, COUNT(DISTINCT d) AS n_dates, MIN(d) AS first_d, MAX(d) AS last_d
        FROM (SELECT person_id, d, CASE {case} END AS cond FROM c)
        WHERE cond IS NOT NULL GROUP BY person_id, cond
    """).to_dataframe()
    like = " OR ".join(f"LOWER(q.concept_name) LIKE '%{w}%' OR LOWER(a.concept_name) LIKE '%{w}%'" for w in KEYWORDS)
    print("querying survey items", flush=True)
    items = client.query(f"""
        SELECT o.observation_source_concept_id AS question_concept_id, q.concept_name AS question,
               o.value_source_concept_id AS answer_concept_id, a.concept_name AS answer,
               COUNT(DISTINCT o.person_id) AS n_persons
        FROM `{cdr}.observation` o
        JOIN `{cdr}.concept` q ON o.observation_source_concept_id = q.concept_id AND q.vocabulary_id = 'PPI'
        LEFT JOIN `{cdr}.concept` a ON o.value_source_concept_id = a.concept_id
        WHERE {like}
        GROUP BY 1, 2, 3, 4
    """).to_dataframe()
    return pop, codes, items


SEX_SPECIFIC = {"endometriosis": "Female"}


def coded_table(pop: pd.DataFrame, codes: pd.DataFrame) -> pd.DataFrame:
    """Coded shares by axis, with no overall row (it would sit above omitted groups); every group of an
    axis is listed, and each condition x axis block gets primary, complementary, and partition
    suppression so no hidden cell can be recovered from the others. Sex-specific conditions use only
    that sex as the population."""
    pop = pop.copy()
    pop["sex"] = pop.sex_name.map(_sex)
    pop["race_eth"] = [_race_eth(r, e) for r, e in zip(pop.race_name, pop.eth_name)]
    pop["age_band"] = (2023 - pop.year_of_birth).map(_age_band)
    codes = codes[codes.person_id.isin(pop.person_id)].copy()
    span = (pd.to_datetime(codes.last_d.astype(str)) - pd.to_datetime(codes.first_d.astype(str))).dt.days
    codes["two_plus"] = (codes.n_dates >= 2) & (span >= 30)
    blocks = []
    for cond in CONDITIONS:
        sub = pop[pop.sex == SEX_SPECIFIC[cond]] if cond in SEX_SPECIFIC else pop
        c = codes[codes.cond == cond]
        any_ids, two_ids = set(c.person_id), set(c.loc[c.two_plus, "person_id"])
        condition_blocks = []
        for axis in ("sex", "age_band", "race_eth"):
            if axis == "sex" and cond in SEX_SPECIFIC:
                continue
            rows = []
            for g, idx in sub.groupby(axis).groups.items():
                ids = sub.loc[idx, "person_id"]
                rows.append({"condition": cond, "population": SEX_SPECIFIC.get(cond, "all adults"), "axis": axis,
                             "group": str(g), "n": len(ids), "n_any_code": int(ids.isin(any_ids).sum()),
                             "n_two_dates": int(ids.isin(two_ids).sum())})
            raw = pd.DataFrame(rows)
            out = protect(raw, ["n", "n_any_code", "n_two_dates"],
                          complements=[("n", "n_any_code"), ("n_any_code", "n_two_dates")])
            condition_blocks.append((raw, out))
        for raw, out in condition_blocks:
            for col in ("n", "n_any_code", "n_two_dates"):
                available = any(other is not out and other_raw[col].sum() == raw[col].sum()
                                and not other[col].map(lambda v: isinstance(v, str)).any()
                                for other_raw, other in condition_blocks)
                if not available:
                    continue
                while True:
                    hidden = out[col].map(lambda v: isinstance(v, str))
                    shown = raw.loc[~hidden & (raw[col] > 0), col]
                    if not hidden.any() or shown.empty or (hidden.sum() >= 2 and raw.loc[hidden, col].sum() > MAX_SUPPRESSED):
                        break
                    out.at[shown.idxmin(), col] = SECONDARY
            def shr(num, den):
                if isinstance(num, str):
                    return num                      # same label as the hidden count
                if isinstance(den, str):
                    return den
                return round(int(num) / int(den), 4) if int(den) > 0 else 0.0
            out["share_any_code"] = [shr(a, n) for a, n in zip(out.n_any_code, out.n)]
            out["share_two_dates"] = [shr(t, n) for t, n in zip(out.n_two_dates, out.n)]
            blocks.append(out)
    return pd.concat(blocks, ignore_index=True)


def item_table(items: pd.DataFrame) -> pd.DataFrame:
    it = items.copy()
    it["n_persons"] = it.n_persons.astype(int)
    it = it[it.n_persons > 0]
    out = protect(it, ["n_persons"])
    # text with a prefix: concept ids are vocabulary codes, not participant identifiers or counts
    out["question_concept_id"] = "concept:" + out.question_concept_id.astype("Int64").astype(str)
    out["answer_concept_id"] = "concept:" + out.answer_concept_id.astype("Int64").astype(str)
    return out.sort_values(["question", "answer"])


def main(loader=None):
    cdr = None if loader else subprocess.check_output(["wb", "resolve", f"--id={CDR_ID}"], text=True).strip()
    pop, codes, items = loader() if loader else query(cdr)
    print(f"population loaded", flush=True)
    os.makedirs(EXPORT, exist_ok=True)
    for name, df in (("t25_coded_shares", coded_table(pop, codes)), ("t25_survey_items", item_table(items))):
        check_exportable(df)
        df.to_csv(os.path.join(EXPORT, f"{name}.csv"), index=False)
        print(f"exported {name} ({len(df)} rows)", flush=True)
    print("Task 25 finished", flush=True)


if __name__ == "__main__":
    main()
