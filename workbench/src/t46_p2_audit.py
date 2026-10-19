"""Task 46 (Paper 2): the Workbench analyses requested by the October 7, 2026 review (items 1-9).

Runs inside the All of Us Workbench (bash ~/unm/bin/unm.sh run 46). One run does all nine items; each item is
computed separately, so a failure in one item is recorded in t46_item_status and the others are still released.

Inputs besides the CDR, in ~/unm/src/:
  - t46_us_adult20_weights.json (item 9): NHANES 2021-2023 adults 20+, built like us_adult_weights.json. Without it
    item 9 fails and the other items are still released.
  - optional: the released CSVs in PRIOR, uploaded unchanged from results/aggregate/25-28 and 34, for a
    reproducibility report only. The script recounts the cells of each uploaded file from the CDR and writes how
    many match to t46_prior_check and one line to t46_item_status. A missing file skips its report; a file that
    does not match is reported. Neither stops the run or changes any released cell.
Participant-level query results are cached in ~/unm/output/t46/ (never exported); a rerun reuses a cached result
when its query text is unchanged.

Populations (as Tasks 25-28): active adult EHR patients (EHR visits in both 12-month periods, July 2021 to June 2023,
born 2004 or earlier); respondents: female or male active patients who completed the Personal and Family Health
History or Personal Medical History survey (or answered one of its condition follow-up questions); primary
population: respondents whose first EHR condition record is 5 or more years before the earliest survey date.
Obesity codes come from condition_occurrence and observation (Task 34), other ICD-10-CM codes from
condition_occurrence (Task 25). Endometriosis is analyzed among women only, with female anchors.

Exports (~/unm/export/46/), by audit item:
 1  t46_population           primary population by sex x age band and sex x race and ethnicity (n)
    t46_population_age       25th, 50th, 75th percentiles of age (on January 1, 2023 and at the earliest survey)
    t46_flow                 eligibility flow, including why record length is unavailable, and current care by condition
 2  t46_female_anchors       hypertension and type 2 diabetes among women: current self-report and coded, by race and
                             ethnicity, age band, record length
    t46_endometriosis_sites  quantiles across sites of the endometriosis share coded and of that share relative to the
                             site's female anchors (and the female anchors' own quantiles)
 3  t46_occasions_overall    primary population and those with condition answers on 2 or more survey occasions
    t46_occasions            per condition: ever and current reports, on 2 or more occasions, discordant across occasions
    t46_earliest_survey      current self-report from the earliest survey occasion only, coded ever and coded no later
                             than 1 year after that occasion, by sex
 4  t46_code_coverage        current self-reporters without the primary code who have a qualifying code only in the
                             observation table, only as ICD-9-CM, or only in another vocabulary mapped to the same
                             standard concept
 5  t46_ethnicity_mapping    active patients by the Task 1 race and ethnicity category and recorded ethnicity value
    t46_race_revised         respondents by revised category (non-Hispanic only with an explicit non-Hispanic answer)
    t46_race_revised_standardized  coded shares standardized to US age x race and ethnicity, revised categories
 6  t46_sex_adjusted         women-to-men ratio of the coded share, standardized to the pooled age x record-length
                             distribution, and Mantel-Haenszel within site x age x record length
 7  t46_bootstrap            95% bootstrap interval endpoints for anchor-relative shares and women-to-men ratios
 8  t46_routing              by survey and condition: reached the self-selection question, selected Self, first-told
                             answers, item nonresponse, current care
    t46_survey_versions      respondents by survey and survey_version_number
 9  t46_benchmark20          obesity and diabetes coded shares among active patients aged 20+, standardized to NHANES
                             adults 20+, with and without women who have pregnancy codes
    t46_benchmark20_excluded women aged 20+ excluded for pregnancy codes
    t46_definitions, t46_item_status
    t46_prior_check          reproducibility report: cells of each uploaded earlier release that match the recount

Disclosure (the dissemination policy, read literally): (a) counts of 1-20 are shown as "<=20" and other
counts are rounded up to a multiple of 10; (b) within one table, a hidden cell must not be recoverable from that
table's own totals. For (b) the Ledger below registers the exact identities among the cells of one table (a total
and its parts in the same row or block, or two breakdowns of the same population in the same table). Each identity
must have no hidden cell, or at least two hidden cells whose raw counts sum to more than 20 (the aou_safe.protect
partition rule); otherwise its smallest shown cell is also hidden, shown as "hidden", until every identity holds.
No relation links two tables or an earlier release. Shares in count tables use the shown (rounded) counts.
Estimate-only tables do not suppress internal counts that are not released. Bootstrap results are interval
endpoints only. No participant-level value is printed.
"""

from __future__ import annotations

import hashlib
import inspect
import json
import math
import os
import re
import subprocess
import sys
import traceback
from types import SimpleNamespace

import numpy as np
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
import t34_p2_obesity as t34  # noqa: E402
from aou_safe import MAX_SUPPRESSED, SECONDARY, SUPPRESSED, check_exportable  # noqa: E402
from t01_cohort import _race_eth  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
EXPORT = os.path.expanduser("~/unm/export/46")
CACHE = os.path.expanduser("~/unm/output/t46")
PRIOR_DIR = HERE
WEIGHTS20 = os.path.join(HERE, "t46_us_adult20_weights.json")
B_REPS, SEED = 2000, 46

SEXES = ["Female", "Male"]
AGE_BANDS = ["18-39", "40-49", "50-59", "60-69", "70+"]
ANCHORS = ["hypertension", "diabetes_type2"]
ENDO, OB = "endometriosis", "obesity"
FT, CUR, CODE_KEY = t26.FIRST_TOLD, t26.CURRENT, t26.CODE_KEY
CONDS = list(FT)
DEEP, DEPTH = t28.DEEP, t27.DEPTH
COLS6 = t27.COLS
T26_IDS = sorted(set(FT.values()) | {q for v in CUR.values() for q, _ in v})
SKIP = 903096
# Survey routing (concept ids from the Task 25 survey-item release). SELF_Q: "Including yourself, who in your
# family has had ...?" (836840 is a family-only variant for obesity; 1384662 is the self-only Lyme list);
# CATEGORY_Q: condition-category questions whose answers name the condition for Self; GATE_Q: "Have you or anyone
# in your family ever been diagnosed with the following ... conditions?"; SELF_ANSWER: the Self answer concept.
SELF_ANSWER = {"hypertension": 43529063, "diabetes_type2": 43529932, "obesity": 43529594, "depression": 1384656,
               "anxiety": 1384475, "migraine": 1384427, "fibromyalgia": 43528713, "endometriosis": 1385329,
               "chronic_fatigue": 1384585, "lyme": 1384449}
SELF_Q = {"hypertension": [836787], "diabetes_type2": [836800], "obesity": [1740668, 836840], "depression": [836804],
          "anxiety": [836850], "migraine": [836808], "fibromyalgia": [836859], "endometriosis": [836854],
          "chronic_fatigue": [1740586], "lyme": [1384662]}
CATEGORY_Q = {"hypertension": [1384522], "diabetes_type2": [43528758], "obesity": [1384430], "depression": [1384495],
              "anxiety": [1384495], "migraine": [1384526], "fibromyalgia": [43528757], "endometriosis": [1384430],
              "chronic_fatigue": [1384526], "lyme": []}
GATE_Q = {"hypertension": [43528563], "diabetes_type2": [43528678], "obesity": [836841], "depression": [43529217],
          "anxiety": [43529217], "migraine": [43529272], "fibromyalgia": [702786], "endometriosis": [836841],
          "chronic_fatigue": [43529272], "lyme": []}
ROUTE_IDS = sorted({q for d in (SELF_Q, CATEGORY_Q, GATE_Q) for v in d.values() for q in v})
# EHR conditions behind the 10 self-report conditions; ICD-9-CM patterns (dots removed) for item 4
EHR10 = ["hypertension", "diabetes_type2", "obesity", "depression", "anxiety", "migraine", "fibromyalgia",
         "endometriosis", "lyme", "mecfs_postviral", "chronic_fatigue_unspecified"]
ICD9 = {"hypertension": "^(401|402|403|404|405)", "diabetes_type2": "^250[0-9][02]$", "obesity": "^(2780|V853|V854)",
        "depression": "^(2962|2963|311)", "anxiety": "^3000", "migraine": "^346", "fibromyalgia": "^7291",
        "endometriosis": "^617", "lyme": "^08881", "mecfs_postviral": "^78071"}
PREGNANCY_RE = "^(O[0-9]|Z33|Z34|Z3A)"
DIABETES_ANY_RE = "^(E08|E09|E10|E11|E13)"
BENCH_STD = ["hypertension", "diabetes_type2", "obesity", "depression", "anxiety", "mecfs_postviral", "long_covid",
             "chronic_pain", "migraine"]

ACTIVE = """v AS (
  SELECT person_id,
         COUNTIF(visit_start_date BETWEEN '2021-07-01' AND '2022-06-30') AS y1,
         COUNTIF(visit_start_date BETWEEN '2022-07-01' AND '2023-06-30') AS y2
  FROM `{cdr}.visit_occurrence` GROUP BY person_id),
act AS (SELECT v.person_id FROM v JOIN `{cdr}.person` p USING (person_id)
        WHERE v.y1 > 0 AND v.y2 > 0 AND p.year_of_birth <= 2004)"""
RESP_LIKE = ("LOWER(c.concept_name) LIKE '%personal and family health history%' "
             "OR LOWER(c.concept_name) LIKE '%personal medical history%'")


def r10(v):
    v = int(v)
    return int(math.ceil(v / 10) * 10) if v > 0 else 0


def _ids(xs):
    return ", ".join(str(int(x)) for x in xs)


def is_resp_survey(name):
    n = str(name).lower()
    return "personal and family health history" in n or "personal medical history" in n


def survey_label(name):
    n = str(name).lower()
    if "personal and family health history" in n:
        return "Personal and Family Health History"
    if "personal medical history" in n:
        return "Personal Medical History"
    if "family health history" in n:
        return "Family Health History"
    return "unlinked or other"


def clean(text):
    text = re.sub(r"\d{6,}", "######", str(text))
    text = re.sub(r"\b\d{4}-\d{2}-\d{2}\b", "YYYY-MM-DD", text)
    return text.replace("\n", " ")[:300]


# ----------------------------------------------------------------------------------------------------------------
# Disclosure ledger
# ----------------------------------------------------------------------------------------------------------------

class Ledger:
    """Raw counts of this task's count cells and the exact identities among cells of the same table.

    The first element of a key names its table (one prefix per exported table: "flow" is t46_flow, "i4" is
    t46_code_coverage, and so on). An identity may only use cells of one table, so suppression never depends on
    another table or on an earlier release."""

    def __init__(self):
        self.raw, self.hidden, self.label, self.rel = {}, {}, {}, []

    def add(self, k, raw):
        if k in self.raw:
            raise KeyError(f"duplicate cell {k}")
        raw = int(raw)
        self.raw[k] = raw
        small = 0 < raw <= MAX_SUPPRESSED
        self.hidden[k], self.label[k] = small, (SUPPRESSED if small else None)

    def equal(self, lhs, rhs):
        """sum(lhs) = sum(rhs) among cells of one table; checked to hold in the raw counts."""
        lhs, rhs = tuple(lhs), tuple(rhs)
        for k in lhs + rhs:
            if k not in self.raw:
                raise KeyError(f"identity uses an unknown cell {k}")
        tables = sorted({k[0] for k in lhs + rhs})
        if len(tables) != 1:
            raise ValueError(f"identity at {lhs[0]} links tables {tables}; only identities within one table are checked")
        if sum(self.raw[k] for k in lhs) != sum(self.raw[k] for k in rhs):
            raise ValueError(f"identity at {lhs[0]} does not hold")
        self.rel.append((lhs, rhs))

    def same_total(self, groups):
        """Breakdowns of one population shown in the same table: every pair whose raw sums agree is an identity.
        A breakdown that misses people (a missing category value) gives no identity."""
        groups = [tuple(g) for g in groups]
        for i in range(len(groups)):
            for j in range(i + 1, len(groups)):
                if sum(self.raw[k] for k in groups[i]) == sum(self.raw[k] for k in groups[j]):
                    self.equal(groups[i], groups[j])

    def snapshot(self):
        return ({k: dict(getattr(self, k)) for k in ("raw", "hidden", "label")}, len(self.rel))

    def restore(self, snap):
        d, n = snap
        for k, v in d.items():
            setattr(self, k, v)
        del self.rel[n:]

    def violated(self, lhs, rhs):
        """One hidden cell could be recovered from the shown cells; two or more whose raw sum is 1-20 give a small
        count by subtraction."""
        h = [k for k in lhs + rhs if self.hidden[k]]
        return len(h) == 1 or (len(h) >= 2 and sum(self.raw[k] for k in h) <= MAX_SUPPRESSED)

    def resolve(self):
        changed, passes = True, 0
        while changed:
            changed, passes = False, passes + 1
            for lhs, rhs in self.rel:
                if not self.violated(lhs, rhs):
                    continue
                cand = [k for k in lhs + rhs if not self.hidden[k] and self.raw[k] > 0]
                if not cand:
                    continue
                k = min(cand, key=lambda x: self.raw[x])
                self.hidden[k], self.label[k] = True, SECONDARY
                changed = True
        return passes

    def show(self, k):
        return self.label[k] if self.hidden[k] else r10(self.raw[k])


def share(a, b, d=4):
    if isinstance(a, str):
        return a
    if isinstance(b, str):
        return b
    return round(a / b, d) if b > 0 else "not estimable"


def materialize(L, rows, count_cols, shares=()):
    df = pd.DataFrame(rows)
    for c in count_cols:
        df[c] = pd.Series([L.show(k) for k in df[c]], dtype=object)
    for name, num, den in shares:
        df[name] = pd.Series([share(a, b) for a, b in zip(df[num], df[den])], dtype=object)
    return df


def cnt6(ids, S):
    e, c, k = S["ever"], S["cur"], S["coded"]
    ie, ic = ids & e, ids & c
    return {"n_respondents": len(ids), "n_self_report": len(ie), "n_self_report_current": len(ic),
            "n_coded": len(ids & k), "n_both": len(ie & k), "n_both_current": len(ic & k)}


# ----------------------------------------------------------------------------------------------------------------
# Data access. Only this section touches the CDR; every query result is cached inside the Workbench.
# ----------------------------------------------------------------------------------------------------------------

def _norm(df):
    df = df.copy()
    for c in df.columns:
        if str(df[c].dtype) in ("dbdate", "date32[day][pyarrow]"):
            df[c] = pd.to_datetime(df[c].astype(str), errors="coerce")
    return df


def _dt(x):
    """Dates from BigQuery (dbdate, datetime.date, or datetime64) as datetime64; missing values become NaT."""
    x = pd.Series(x)
    if str(x.dtype).startswith("datetime64"):
        return x
    return pd.to_datetime(x.astype(str), errors="coerce")


def _client():
    from google.cloud import bigquery
    return bigquery.Client()


def _sql(sql):
    return _client().query(sql).to_dataframe()


def case_sql(conds, patterns):
    return "\n".join(f"WHEN REGEXP_CONTAINS(code, r'{patterns[k]}') THEN '{k}'" for k in conds)


def icd10_patterns():
    return {k: "^(" + "|".join(t25.CONDITIONS[k]) + ")" for k in EHR10}


def sql_answers(cdr, linked):
    keep_a = _ids(T26_IDS)
    self_skip = _ids(sorted(set(SELF_ANSWER.values()) | {SKIP}))
    qr, sid, join = ("o.questionnaire_response_id", "sc.survey_concept_id",
                     f"LEFT JOIN `{cdr}.survey_conduct` sc ON sc.survey_conduct_id = o.questionnaire_response_id") \
        if linked else ("CAST(NULL AS INT64)", "CAST(NULL AS INT64)", "")
    return f"""
    WITH {ACTIVE.format(cdr=cdr)}
    SELECT o.person_id, o.observation_source_concept_id AS q,
           IF(o.observation_source_concept_id IN ({keep_a}) OR o.value_source_concept_id IN ({self_skip}),
              o.value_source_concept_id, NULL) AS a,
           o.observation_date AS d, {qr} AS qr, {sid} AS survey_id
    FROM `{cdr}.observation` o JOIN act ON o.person_id = act.person_id
    {join}
    WHERE o.observation_source_concept_id IN ({_ids(T26_IDS + ROUTE_IDS)})
    GROUP BY 1, 2, 3, 4, 5, 6"""


def sql_conduct(cdr):
    return f"""
    WITH {ACTIVE.format(cdr=cdr)}
    SELECT sc.person_id, sc.survey_conduct_id, sc.survey_concept_id AS survey_id, c.concept_name AS survey_name,
           sc.survey_end_date AS end_d, sc.survey_version_number AS version
    FROM `{cdr}.survey_conduct` sc JOIN act ON sc.person_id = act.person_id
    JOIN `{cdr}.concept` c ON sc.survey_concept_id = c.concept_id
    WHERE LOWER(c.concept_name) LIKE '%health history%' OR LOWER(c.concept_name) LIKE '%personal medical history%'"""


def sql_depth(cdr):
    return f"""
    WITH {ACTIVE.format(cdr=cdr)},
    s AS (SELECT sc.person_id, MIN(sc.survey_end_date) AS survey_d FROM `{cdr}.survey_conduct` sc
          JOIN `{cdr}.concept` c ON sc.survey_concept_id = c.concept_id WHERE {RESP_LIKE} GROUP BY 1),
    e AS (SELECT person_id, MIN(condition_start_date) AS first_d FROM `{cdr}.condition_occurrence` GROUP BY 1)
    SELECT act.person_id, s.survey_d, e.first_d FROM act LEFT JOIN s ON act.person_id = s.person_id
    LEFT JOIN e ON act.person_id = e.person_id"""


def sql_obs_icd10(cdr):
    p = icd10_patterns()
    allre = "^(" + "|".join(x for k in EHR10 for x in t25.CONDITIONS[k]) + ")"
    return f"""
    WITH {ACTIVE.format(cdr=cdr)},
    k AS (SELECT concept_id, REPLACE(UPPER(concept_code), '.', '') AS code FROM `{cdr}.concept`
          WHERE vocabulary_id = 'ICD10CM' AND REGEXP_CONTAINS(REPLACE(UPPER(concept_code), '.', ''), r'{allre}')),
    x AS (SELECT o.person_id, CASE {case_sql(EHR10, p)} END AS cond
          FROM `{cdr}.observation` o JOIN act ON o.person_id = act.person_id
          JOIN k ON o.observation_source_concept_id = k.concept_id)
    SELECT DISTINCT person_id, cond FROM x WHERE cond IS NOT NULL"""


def sql_icd9(cdr):
    allre = "|".join(ICD9.values())
    return f"""
    WITH {ACTIVE.format(cdr=cdr)},
    k AS (SELECT concept_id, REPLACE(UPPER(concept_code), '.', '') AS code FROM `{cdr}.concept`
          WHERE vocabulary_id = 'ICD9CM' AND REGEXP_CONTAINS(REPLACE(UPPER(concept_code), '.', ''), r'{allre}')),
    x AS (SELECT co.person_id, k.code FROM `{cdr}.condition_occurrence` co JOIN act ON co.person_id = act.person_id
          JOIN k ON co.condition_source_concept_id = k.concept_id
          UNION ALL
          SELECT o.person_id, k.code FROM `{cdr}.observation` o JOIN act ON o.person_id = act.person_id
          JOIN k ON o.observation_source_concept_id = k.concept_id),
    y AS (SELECT person_id, CASE {case_sql(list(ICD9), ICD9)} END AS cond FROM x)
    SELECT DISTINCT person_id, cond FROM y WHERE cond IS NOT NULL"""


def _std_cte(cdr):
    """Standard concepts reached by a one-to-one 'Maps to' from a qualifying ICD-10-CM code."""
    return f"""
    q AS (SELECT concept_id, CASE {case_sql(EHR10, icd10_patterns())} END AS cond FROM (
            SELECT concept_id, REPLACE(UPPER(concept_code), '.', '') AS code FROM `{cdr}.concept`
            WHERE vocabulary_id = 'ICD10CM')),
    m AS (SELECT q.cond, cr.concept_id_1 AS src, cr.concept_id_2 AS std FROM q
          JOIN `{cdr}.concept_relationship` cr ON cr.concept_id_1 = q.concept_id AND cr.relationship_id = 'Maps to'
          WHERE q.cond IS NOT NULL),
    one AS (SELECT src FROM m GROUP BY src HAVING COUNT(DISTINCT std) = 1),
    s AS (SELECT DISTINCT m.cond, m.std FROM m JOIN one ON m.src = one.src)"""


def sql_mapped(cdr):
    return f"""
    WITH {ACTIVE.format(cdr=cdr)}, {_std_cte(cdr)},
    x AS (SELECT co.person_id, s.cond FROM `{cdr}.condition_occurrence` co JOIN act ON co.person_id = act.person_id
          JOIN s ON co.condition_concept_id = s.std
          LEFT JOIN `{cdr}.concept` sv ON co.condition_source_concept_id = sv.concept_id
          WHERE COALESCE(sv.vocabulary_id, 'none') != 'ICD10CM'
          UNION ALL
          SELECT o.person_id, s.cond FROM `{cdr}.observation` o JOIN act ON o.person_id = act.person_id
          JOIN s ON o.observation_concept_id = s.std
          LEFT JOIN `{cdr}.concept` sv ON o.observation_source_concept_id = sv.concept_id
          WHERE COALESCE(sv.vocabulary_id, 'none') NOT IN ('ICD10CM', 'PPI'))
    SELECT DISTINCT person_id, cond FROM x"""


def sql_std_counts(cdr):
    return f"WITH {_std_cte(cdr)} SELECT cond, COUNT(DISTINCT std) AS n_std FROM s GROUP BY cond"


def sql_icd10_persons(cdr, pattern, dated):
    """Active patients with an ICD-10-CM source code matching pattern: condition_occurrence only (any date), or
    condition_occurrence and observation dated July 2021 to June 2023 (dated=True)."""
    obs = (f"UNION ALL SELECT o.person_id, o.observation_date AS d FROM `{cdr}.observation` o "
           f"JOIN k ON o.observation_source_concept_id = k.concept_id") if dated else ""
    when = "WHERE x.d BETWEEN '2021-07-01' AND '2023-06-30'" if dated else ""
    return f"""
    WITH {ACTIVE.format(cdr=cdr)},
    k AS (SELECT concept_id FROM `{cdr}.concept` WHERE vocabulary_id = 'ICD10CM'
          AND REGEXP_CONTAINS(REPLACE(UPPER(concept_code), '.', ''), r'{pattern}')),
    x AS (SELECT co.person_id, co.condition_start_date AS d FROM `{cdr}.condition_occurrence` co
          JOIN k ON co.condition_source_concept_id = k.concept_id {obs})
    SELECT DISTINCT x.person_id FROM x JOIN act ON x.person_id = act.person_id {when}"""


class Source:
    """CDR queries (cached in ~/unm/output/t46/) or, in tests, a synthetic loader returning the same frames."""

    def __init__(self, loader=None):
        self.data = loader() if loader else None
        self.cdr = None if loader else subprocess.check_output(["wb", "resolve", f"--id={t25.CDR_ID}"], text=True).strip()
        self.memo, self.notes = {}, {}

    @staticmethod
    def _path(name, key):
        return os.path.join(CACHE, f"{name}_{hashlib.sha256(key.encode()).hexdigest()[:12]}.parquet")

    @staticmethod
    def _save(df, path, name):
        try:
            os.makedirs(CACHE, exist_ok=True)
            df.to_parquet(path)
        except Exception as e:  # noqa: BLE001 (caching is optional)
            print(f"{name}: not cached ({type(e).__name__})", flush=True)

    def _cached(self, name, key, fn):
        path = self._path(name, key)
        if os.path.exists(path):
            print(f"{name}: cached", flush=True)
            return pd.read_parquet(path)
        print(f"{name}: querying", flush=True)
        df = _norm(t34.stage(name, fn))
        self._save(df, path, name)
        return df

    def _q(self, name, sql):
        return self._cached(name, sql, lambda: _sql(sql))

    def get(self, name):
        if name in self.memo:
            return self.memo[name]
        if self.data is not None:
            if name not in self.data:
                raise KeyError(f"synthetic loader has no frame {name!r}")
            v = self.data[name]
            if name == "answers":
                self.notes["linkage"] = "questionnaire_response_id joined to survey_conduct.survey_conduct_id"
        else:
            v = self._query(name)
        self.memo[name] = v
        return v

    def _query(self, name):
        cdr = self.cdr
        if name in ("pop", "codes"):
            key = inspect.getsource(t25.query)
            paths = {n: self._path(n, key) for n in ("pop", "codes")}
            if all(os.path.exists(x) for x in paths.values()):
                print("pop, codes: cached", flush=True)
                for n, x in paths.items():
                    self.memo[n] = pd.read_parquet(x)
            else:
                print("pop, codes: querying", flush=True)
                pop, codes, _ = t34.stage("Task 25 population and codes", t25.query, cdr)
                self.memo["pop"], self.memo["codes"] = _norm(pop), _norm(codes)
                for n, x in paths.items():
                    self._save(self.memo[n], x, n)
            return self.memo[name]
        if name == "obesity":
            return self._cached("obesity", inspect.getsource(t34.query_obesity), lambda: t34.query_obesity(cdr))
        if name == "site":
            return self._cached("site", inspect.getsource(t29.query_site), lambda: t29.query_site(cdr))
        if name == "answers":
            try:
                df = self._q("answers", sql_answers(cdr, True))
                self.notes["linkage"] = "questionnaire_response_id joined to survey_conduct.survey_conduct_id"
            except RuntimeError as e:
                print(f"linked answer query failed ({clean(e)}); using observation_date occasions", flush=True)
                df = self._q("answers_unlinked", sql_answers(cdr, False))
                self.notes["linkage"] = "observation_date (questionnaire_response_id join unavailable)"
            return df
        sqls = {"conduct": sql_conduct, "depth": sql_depth, "obs_icd10": sql_obs_icd10, "icd9": sql_icd9,
                "mapped": sql_mapped, "std_counts": sql_std_counts,
                "pregnancy": lambda c: sql_icd10_persons(c, PREGNANCY_RE, True),
                "diabetes_any": lambda c: sql_icd10_persons(c, DIABETES_ANY_RE, False)}
        return self._q(name, sqls[name](cdr))


# ----------------------------------------------------------------------------------------------------------------
# Shared participant-level data (inside the Workbench only)
# ----------------------------------------------------------------------------------------------------------------

PRIOR = {"t25": "t25_coded_shares.csv", "t26": "t26_selfreport_vs_code.csv", "t26c": "t26_composition.csv",
         "t27": "t27_selfreport_by_group.csv", "t28": "t28_selfreport_deep_by_sex.csv",
         "t34_26": "t34_t26_selfreport_vs_code_obesity.csv", "t34_27": "t34_t27_selfreport_by_group_obesity.csv",
         "t34_28": "t34_t28_selfreport_deep_by_sex_obesity.csv"}


def read_prior():
    """The earlier releases that were uploaded (optional inputs; a missing file is simply absent)."""
    out = {}
    for k, f in PRIOR.items():
        path = os.path.join(PRIOR_DIR, f)
        if os.path.exists(path):
            out[k] = pd.read_csv(path, dtype=str, keep_default_na=False)
    return out


def build(src):
    D = SimpleNamespace()
    pop_raw, codes_old, ob = src.get("pop"), src.get("codes"), src.get("obesity")
    codes_new = pd.concat([codes_old[codes_old.cond != OB], ob[ob.person_id.isin(pop_raw.person_id)]], ignore_index=True)
    pop_all, cn = t26.prepare(pop_raw, codes_new)
    _, co = t26.prepare(pop_raw, codes_old)
    dep = src.get("depth")[["person_id", "survey_d", "first_d"]]
    pop_all = pop_all.merge(dep, on="person_id", how="left")
    pop_all["survey_d"], pop_all["first_d"] = _dt(pop_all.survey_d), _dt(pop_all.first_d)
    pop_all["depth_days"] = (pop_all.survey_d - pop_all.first_d).dt.days
    pop_all["ehr_depth"] = pop_all.depth_days.map(t27.depth_band)
    pop_all["eth_status"] = pop_all.eth_name.map(eth_status)
    pop_all["race_rev"] = [race_revised(r, e) for r, e in zip(pop_all.race_name, pop_all.eth_name)]
    D.pop_all, D.cn = pop_all, cn
    D.pop = pop_all[pop_all.sex.isin(SEXES)]
    ans = src.get("answers")
    ans = ans[ans.person_id.isin(D.pop.person_id)]
    D.ans = ans.assign(q=pd.to_numeric(ans.q).astype("int64"), a=pd.to_numeric(ans.a, errors="coerce").astype("float64"),
                       d=_dt(ans.d).to_numpy())
    D.sr26 = D.ans.loc[D.ans.q.isin(T26_IDS), ["person_id", "q", "a"]].drop_duplicates()
    D.conduct = src.get("conduct")
    resp = set(D.conduct.loc[D.conduct.survey_name.map(is_resp_survey), "person_id"])
    D.resp_ids = (resp & set(D.pop.person_id)) | set(D.sr26.person_id)
    D.R = D.pop[D.pop.person_id.isin(D.resp_ids)]
    D.R_f = D.R[D.R.sex == "Female"]
    D.P5 = D.R[D.R.ehr_depth.isin(DEEP)]
    D.P5_f = D.P5[D.P5.sex == "Female"]
    D.resp_by_sex = {s: set(D.R.person_id[D.R.sex == s]) for s in SEXES}
    D.race_cats = sorted(pop_all.race_eth.unique())
    D.S = {"old": {}, "new": {}}
    for c, qid in FT.items():
        ever = set(D.sr26.person_id[D.sr26.q == qid])
        cy = set()
        for q, a in CUR[c]:
            cy |= set(D.sr26.person_id[(D.sr26.q == q) & (D.sr26.a == a)])
        keys = CODE_KEY.get(c, [c])
        for name, cc in (("old", co), ("new", cn)):
            D.S[name][c] = {"ever": ever, "cur": cy & ever, "coded": set(cc.person_id[cc.cond.isin(keys)])}
    fd = cn.assign(first_d=_dt(cn.first_d).to_numpy())
    D.first_code = {c: fd[fd.cond.isin(CODE_KEY.get(c, [c]))].groupby("person_id").first_d.min() for c in CONDS}
    D.survey_names = D.conduct.drop_duplicates("survey_id").set_index("survey_id").survey_name.to_dict()
    D.linkage = src.notes.get("linkage", "")
    return D


def eth_status(e):
    s = "" if e is None or (isinstance(e, float) and math.isnan(e)) else str(e).lower()
    if "not hispanic" in s:
        return "not Hispanic or Latino"
    if "hispanic or latino" in s:
        return "Hispanic or Latino"
    return "missing or not answered"


def race_revised(r, e):
    base = _race_eth(r, e)
    if base.startswith("NH ") and eth_status(e) != "not Hispanic or Latino":
        return "Unknown"
    return base


def prior_cells(D, name, f):
    """(recount, released value) for each count cell of an earlier release (Task 34 replaced the obesity codes)."""
    if name == "t25":
        for r in f[f.condition == "hypertension"].itertuples():
            yield int((D.pop_all[r.axis].astype(str) == r.group).sum()), r.n
        return
    if name == "t26c":
        for r in f.itertuples():
            yield int(((D.pop_all.sex == r.sex) & (D.pop_all[r.axis].astype(str) == r.category)).sum()), r.n
        return
    ck = "old" if name in ("t26", "t27", "t28") else "new"
    for r in f.itertuples():
        if name in ("t26", "t34_26"):
            ids = D.resp_by_sex[r.sex]
        elif name in ("t27", "t34_27"):
            sub = D.R_f if r.condition == ENDO else D.R
            ids = set(sub.person_id[sub[r.axis].astype(str) == r.group])
        else:
            ids = set(D.P5.person_id[D.P5.sex == r.sex])
        for col, v in cnt6(ids, D.S[ck][r.condition]).items():
            yield v, getattr(r, col)


def recount_prior(D, prior):
    """Reproducibility report on the uploaded earlier releases: each numeric released cell is compared with the
    recount rounded up to 10 (a hidden released cell counts as matching). Report only: a missing file skips its
    row, a difference or a failed recount is written down, and nothing else in the run depends on the result.
    Returns the t46_prior_check rows and one t46_item_status line."""
    rows, differ, failed, missing = [], [], [], []
    for name, fname in PRIOR.items():
        table = fname[:-4]
        if name not in prior:
            missing.append(table)
            rows.append({"released_table": table, "cells_compared": "not uploaded",
                         "cells_matching_recount": "recount skipped"})
            continue
        try:
            n = m = 0
            for raw, shown in prior_cells(D, name, prior[name]):
                v = pd.to_numeric(pd.Series([shown]), errors="coerce").iloc[0]
                n, m = n + 1, m + bool(pd.isna(v) or int(v) == r10(raw))
        except Exception as e:  # noqa: BLE001 (the report must never stop the run)
            failed.append(f"{table} ({type(e).__name__})")
            rows.append({"released_table": table, "cells_compared": "recount failed",
                         "cells_matching_recount": type(e).__name__})
            continue
        rows.append({"released_table": table, "cells_compared": f"{n} cells", "cells_matching_recount": f"{m} cells"})
        if m < n:
            differ.append(f"{table} {n - m} of {n} cells")
    if len(missing) == len(PRIOR):
        status = "skipped: no earlier release uploaded"
    else:
        parts = []
        if differ:
            parts.append("differs from the recount: " + ", ".join(differ))
        if failed:
            parts.append("recount failed: " + ", ".join(failed))
        if missing:
            parts.append("not uploaded: " + ", ".join(missing))
        head = "ok: every uploaded release reproduced" if not (differ or failed) else "report only"
        status = "; ".join([head] + parts)
    return rows, {"item": "prior release recount (report only)", "status": status}


def site_map(src):
    s = src.get("site")
    return s.drop_duplicates("person_id").set_index("person_id").site


# ----------------------------------------------------------------------------------------------------------------
# Item 1: primary population and eligibility flow
# ----------------------------------------------------------------------------------------------------------------

def item1(L, D, src):
    rows = []
    for sex in SEXES:
        p = D.P5[D.P5.sex == sex]
        blocks = []
        for axis, cats in (("age_band", AGE_BANDS), ("race_eth", D.race_cats)):
            ks = []
            for g in cats:
                k = ("i1", sex, axis, g)
                L.add(k, (p[axis] == g).sum())
                ks.append(k)
                rows.append({"sex": sex, "axis": axis, "group": g, "n": k})
            blocks.append(ks)
        L.same_total(blocks)        # the age and race breakdowns of one sex both sum to its primary population
    ages = []
    for sex in ["Female", "Male", "All"]:
        p = D.P5 if sex == "All" else D.P5[D.P5.sex == sex]
        a23 = 2023 - p.year_of_birth.astype(float)
        asv = p.survey_d.dt.year - p.year_of_birth.astype(float)
        for stat, q in (("p25", .25), ("median", .5), ("p75", .75)):
            ok = len(p) > 0
            ages.append({"population": "5 or more years of EHR records before the survey", "sex": sex, "statistic": stat,
                         "age_on_2023_01_01": float(round(a23.quantile(q))) if ok else "not estimable",
                         "age_at_earliest_survey": float(round(asv.quantile(q))) if ok else "not estimable"})
    R, pa = D.R, D.pop_all
    dated, hascond, dd = R.survey_d.notna(), R.first_d.notna(), R.depth_days
    steps = [
        ("01", "active adult EHR patients, any sex at birth", len(pa)),
        ("02", "excluded: sex at birth other or unknown", (pa.sex == "Other/unknown").sum()),
        ("03", "female or male active patients", len(D.pop)),
        ("04", "survey respondents (PFHH or PMH)", len(R)),
        ("05", "excluded from record length: no survey date (respondent identified only by condition answers)", (~dated).sum()),
        ("06", "respondents with a survey date", dated.sum()),
        ("07", "excluded from record length: survey date but no EHR condition record", (dated & ~hascond).sum()),
        ("08", "survey date and at least 1 EHR condition record", (dated & hascond).sum()),
        ("09", "excluded: first condition record after the survey", (dd < 0).sum()),
        ("10", "first condition record on or before the survey", (dd >= 0).sum()),
        ("11", "excluded: under 5 years of condition records before the survey", ((dd >= 0) & ~R.ehr_depth.isin(DEEP)).sum()),
        ("12", "primary population: 5 or more years of condition records before the survey", len(D.P5))]
    flow = []
    for s, label, v in steps:
        L.add(("flow", s), v)
        flow.append({"step": f"step {s}", "description": label, "condition": "", "n": ("flow", s)})
    F = lambda s: ("flow", s)  # noqa: E731
    L.equal([F("01")], [F("02"), F("03")])
    chain, excl = ["04", "06", "08", "10", "12"], ["05", "07", "09", "11"]
    for i in range(len(chain)):           # every cumulative identity along the flow, not only consecutive steps
        for j in range(i + 1, len(chain)):
            L.equal([F(chain[i])], [F(x) for x in excl[i:j]] + [F(chain[j])])
    for c in CONDS:
        P = D.P5_f if c == ENDO else D.P5
        k = ("flow", "13 " + c)
        L.add(k, len(set(P.person_id) & D.S["new"][c]["cur"]))
        flow.append({"step": "step 13", "description": "primary population reporting current care for the condition",
                     "condition": c, "n": k})
    return {"t46_population": ("counts", rows, ["n"], []),
            "t46_population_age": ("frame", pd.DataFrame(ages)),
            "t46_flow": ("counts", flow, ["n"], [])}


# ----------------------------------------------------------------------------------------------------------------
# Item 2: female anchors and endometriosis across sites
# ----------------------------------------------------------------------------------------------------------------

def site_quantiles(p, conds, S_of, anchors):
    rows = []
    for c in conds + [a for a in anchors if a not in conds]:
        S = S_of(c)
        for s, g in p.groupby("site"):
            ids = set(g.person_id) & S["cur"]
            rows.append({"condition": c, "site": s, "n": len(ids), "coded": len(ids & S["coded"])})
    d = pd.DataFrame(rows)
    d["ok"] = d.n >= t29.MIN_SITE_N   # precision of a site share (Task 29), not a disclosure rule
    d["p"] = d.coded / d.n.where(d.n > 0)
    anc = d[d.condition.isin(anchors)].pivot(index="site", columns="condition", values=["p", "ok"])
    anchor_p = anc["p"].where(anc["ok"].fillna(False).astype(bool)).mean(axis=1, skipna=False)
    out = []
    for c in conds:
        g = d[(d.condition == c) & d.ok].copy()
        g["relative"] = g.p / g.site.map(anchor_p.where(anchor_p > 0))
        if len(g) < t29.MIN_SITES:
            out.append({"condition": c, "sites_included": f"fewer than {t29.MIN_SITES} sites"})
            continue
        row = {"condition": c, "sites_included": f"{len(g)} sites"}
        for q in t29.QS:
            row[f"share_coded_p{int(q * 100)}"] = round(float(g.p.quantile(q)), 3)
        for q in t29.QS:
            row[f"relative_to_female_anchors_p{int(q * 100)}"] = round(float(g.relative.quantile(q)), 3)
        out.append(row)
    return pd.DataFrame(out)


def item2(L, D, src):
    rows = []
    W = D.R_f
    cols = ["n_self_report_current", "n_both_current"]
    for c in ANCHORS:
        S = D.S["new"][c]
        blocks = {col: [] for col in cols}
        for axis in ("race_eth", "age_band", "ehr_depth"):
            groups = DEPTH if axis == "ehr_depth" else sorted(D.pop[axis].unique())
            kc, kb = [], []
            for g in groups:
                ids = set(W.person_id[W[axis] == g]) & S["cur"]
                a, b = ("i2", c, axis, g, "n_self_report_current"), ("i2", c, axis, g, "n_both_current")
                L.add(a, len(ids)); L.add(b, len(ids & S["coded"]))
                kc.append(a); kb.append(b)
                rows.append({"condition": c, "population": "women", "axis": axis, "group": g,
                             "n_self_report_current": a, "n_both_current": b})
            blocks["n_self_report_current"].append(kc)
            blocks["n_both_current"].append(kb)
        for col in cols:            # the three breakdowns of one column sum to the same women
            L.same_total(blocks[col])
    p = W.assign(site=W.person_id.map(site_map(src))).dropna(subset=["site"])
    sites = site_quantiles(p, [ENDO] + ANCHORS, lambda c: D.S["new"][c], ANCHORS)
    sites.insert(1, "population", "women, all lengths of record")
    return {"t46_female_anchors": ("counts", rows, ["n_self_report_current", "n_both_current"],
                                   [("p_code_given_current_self_report", "n_both_current", "n_self_report_current")]),
            "t46_endometriosis_sites": ("frame", sites)}


# ----------------------------------------------------------------------------------------------------------------
# Item 3: survey occasions
# ----------------------------------------------------------------------------------------------------------------

EPOCH = pd.Timestamp("1970-01-01")


def occasion_frame(D):
    """One row per respondent and survey occasion (questionnaire response, or answer date when unlinked)."""
    a = D.ans[D.ans.person_id.isin(D.resp_ids)].copy()
    qr = pd.to_numeric(a.qr, errors="coerce").astype("float64")
    days = (a.d - EPOCH).dt.days.astype("int64")
    a["occ"] = np.where(qr.notna(), qr.fillna(0).astype("int64"), -(days + 1))     # ids are far below 2**53
    a["oc"] = a.groupby(["person_id", "occ"], sort=False).ngroup()
    O = a.groupby("oc").agg(person_id=("person_id", "first"), occ_date=("d", "min"), survey_id=("survey_id", "max"))
    O["survey"] = [survey_label(D.survey_names.get(int(s))) if pd.notna(s) else "unlinked or other" for s in O.survey_id]
    oc, n = a.oc.to_numpy(), len(O)
    q, ans = a.q.to_numpy(dtype="int64"), a.a.to_numpy(dtype="float64")

    def flag(mask):
        return np.bincount(oc, weights=np.asarray(mask, dtype=float), minlength=n) > 0

    for c in CONDS:
        cq = [x for x, _ in CUR[c]]
        cy = np.zeros(len(a), bool)
        for x, y in CUR[c]:
            cy |= (q == x) & (ans == y)
        O["rep_" + c] = flag(q == FT[c])
        O["cy_" + c] = flag(cy)
        O["care_" + c] = flag(np.isin(q, cq))
        O["skip_" + c] = flag((q == FT[c]) & (ans == SKIP))
        O["who_" + c] = flag(np.isin(q, SELF_Q[c]))
        O["cat_" + c] = flag(np.isin(q, CATEGORY_Q[c]))
        O["self_" + c] = flag(np.isin(q, SELF_Q[c] + CATEGORY_Q[c]) & (ans == SELF_ANSWER[c]))
        O["asked_" + c] = flag(np.isin(q, GATE_Q[c] + SELF_Q[c] + CATEGORY_Q[c] + [FT[c]] + cq))
    return O


def get_occasions(D):
    if getattr(D, "occ", None) is None:
        D.occ = occasion_frame(D)
    return D.occ


def item3(L, D, src):
    O = get_occasions(D)
    O = O[O.survey != "Family Health History"]      # family-only survey: no answers about the respondent's diagnoses
    nocc = O.groupby("person_id").size()
    multi = set(nocc.index[nocc >= 2])
    E = O.reset_index().sort_values(["person_id", "occ_date", "oc"]).drop_duplicates("person_id").set_index("person_id")
    ka, kb = ("i3x", "n_primary"), ("i3x", "n_two_or_more_occasions")
    L.add(ka, len(D.P5)); L.add(kb, len(set(D.P5.person_id) & multi))
    overall = [{"population": "5 or more years of EHR records before the survey", "n_primary": ka,
                "n_two_or_more_occasions": kb}]
    occ_rows, early_rows = [], []
    oc_cols = ["n_ever", "n_ever_multi_occasion", "n_ever_discordant", "n_current", "n_current_multi_occasion",
               "n_current_discordant"]
    for c in CONDS:
        P = D.P5_f if c == ENDO else D.P5
        ids = set(P.person_id)
        S = D.S["new"][c]
        ever, cur = ids & S["ever"], ids & S["cur"]
        Oc = O[O.person_id.isin(ids)]
        rep, asked, cur_o = Oc["rep_" + c], Oc["asked_" + c], Oc["rep_" + c] & Oc["cy_" + c]
        vals = {"n_ever": len(ever), "n_ever_multi_occasion": len(ever & multi),
                "n_ever_discordant": len(set(Oc.person_id[asked & ~rep]) & ever & multi),
                "n_current": len(cur), "n_current_multi_occasion": len(cur & multi),
                "n_current_discordant": len(set(Oc.person_id[asked & ~cur_o]) & cur & multi)}
        K = {col: ("i3o", c, col) for col in oc_cols}
        for col in oc_cols:
            L.add(K[col], vals[col])
        occ_rows.append({"condition": c, "population": "women" if c == ENDO else "women and men", **K})
        # earliest occasion only; codes on or before 365 days after it
        Ec = E[E.index.isin(ids)]
        cur_e = set(Ec.index[Ec["rep_" + c] & Ec["cy_" + c]])
        coded_e = cur_e & S["coded"]
        s = pd.Series(sorted(coded_e), dtype="int64")
        first = D.first_code[c].reindex(s).to_numpy()
        limit = (Ec.occ_date.reindex(s) + pd.Timedelta(days=365)).to_numpy()
        win = set(s[first <= limit])
        sexes = ["Female"] if c == ENDO else SEXES + ["All"]
        for sex in sexes:
            m = ids if sex == "All" else ids & D.resp_by_sex[sex]
            kk = {col: ("i3e", c, sex, col) for col in ("n_current_earliest", "n_coded_any", "n_coded_within_1y")}
            L.add(kk["n_current_earliest"], len(cur_e & m)); L.add(kk["n_coded_any"], len(coded_e & m))
            L.add(kk["n_coded_within_1y"], len(win & m))
            early_rows.append({"condition": c, "sex": sex, **kk})
        if c != ENDO:               # the All row is the sum of the Female and Male rows
            for col in ("n_current_earliest", "n_coded_any", "n_coded_within_1y"):
                parts = [("i3e", c, s, col) for s in SEXES]
                L.equal([("i3e", c, "All", col)], parts)
    return {"t46_occasions_overall": ("counts", overall, ["n_primary", "n_two_or_more_occasions"], []),
            "t46_occasions": ("counts", occ_rows, oc_cols, []),
            "t46_earliest_survey": ("counts", early_rows, ["n_current_earliest", "n_coded_any", "n_coded_within_1y"],
                                    [("p_coded_any", "n_coded_any", "n_current_earliest"),
                                     ("p_coded_within_1y", "n_coded_within_1y", "n_current_earliest")])}


# ----------------------------------------------------------------------------------------------------------------
# Item 4: code coverage
# ----------------------------------------------------------------------------------------------------------------

def item4(L, D, src):
    by = lambda df: {c: set(df.person_id[df.cond.isin(CODE_KEY.get(c, [c]))]) for c in CONDS}  # noqa: E731
    obs, icd9, mapped = by(src.get("obs_icd10")), by(src.get("icd9")), by(src.get("mapped"))
    std = src.get("std_counts").set_index("cond").n_std
    cols = ["n_current", "n_coded_primary", "n_only_observation", "n_only_icd9", "n_only_other_vocabulary", "n_none"]
    rows = []
    for c in CONDS:
        P = D.P5_f if c == ENDO else D.P5
        S = D.S["new"][c]
        cur = set(P.person_id) & S["cur"]
        coded = cur & S["coded"]
        rest = cur - coded
        o = rest & obs[c]
        rest -= o
        i9 = rest & icd9[c]
        rest -= i9
        m = rest & mapped[c]
        rest -= m
        K = {col: ("i4", c, col) for col in cols}
        for col, v in zip(cols, (cur, coded, o, i9, m, rest)):
            L.add(K[col], len(v))
        L.equal([K["n_current"]], [K[x] for x in cols[1:]])     # the five categories partition n_current
        keys = CODE_KEY.get(c, [c])
        rows.append({"condition": c, "population": "women" if c == ENDO else "women and men", **K,
                     "standard_concepts_mapped": " + ".join(f"{int(std.get(k, 0))} concepts" for k in keys),
                     "icd9_patterns": " ".join(ICD9.get(k, "none") for k in keys)})
    return {"t46_code_coverage": ("counts", rows, cols, [])}


# ----------------------------------------------------------------------------------------------------------------
# Item 5: ethnicity mapping
# ----------------------------------------------------------------------------------------------------------------

def item5(L, D, src):
    pa = D.pop_all
    ev = pa.eth_name.where(pa.eth_name.notna(), "(no value)").astype(str)
    top = set(ev.value_counts().index[:6])
    ev = ev.where(ev.isin(top), "other value")
    mrows = []
    for g in D.race_cats:
        m = pa.race_eth == g
        for v in sorted(ev[m].unique()):
            k = ("i5m", g, v)
            L.add(k, (m & (ev == v)).sum())
            st = pa.eth_status[m & (ev == v)].iloc[0] if v != "other value" else "mixed"
            mrows.append({"population": "active adult EHR patients, any sex", "assigned_category": g,
                          "ethnicity_value": v, "ethnicity_status": st, "n": k})
    rev_cats = sorted(set(pa.race_rev.unique()) | {"Unknown"})
    rows = []
    specs = [(c, "women" if c == ENDO else "women and men") for c in CONDS] + [(c, "women") for c in ANCHORS]
    cols = ["n_respondents", "n_self_report_current", "n_both_current"]
    for c, popl in specs:
        S = D.S["new"][c]
        sub = D.R_f if popl == "women" else D.R
        for g in rev_cats:
            ids = set(sub.person_id[sub.race_rev == g])
            K = {col: ("i5r", c, popl, g, col) for col in cols}
            L.add(K["n_respondents"], len(ids)); L.add(K["n_self_report_current"], len(ids & S["cur"]))
            L.add(K["n_both_current"], len(ids & S["cur"] & S["coded"]))
            rows.append({"condition": c, "population": popl, "group_revised": g, **K})
    weights = json.load(open(os.path.join(HERE, "us_adult_weights.json")))
    std_rows = []
    pop = D.pop.assign(race_eth=D.pop.race_rev)
    for cond in BENCH_STD:
        ids = set(D.cn.person_id[D.cn.cond == cond])
        for sex in SEXES:
            p = pop[pop.sex == sex]
            est, lo, hi, n_coded = t26.standardized(p, ids, weights["age_race"][sex], lambda d: d.age_band + "|" + d.race_eth)
            row = {"condition": cond, "sex": sex, "code_definition": "any code",
                   "standard": "US adults: age x race and ethnicity (revised categories; Unknown excluded)",
                   "share": round(est, 4), "ci_low": round(lo, 4), "ci_high": round(hi, 4)}
            std_rows.append(row)
    return {"t46_ethnicity_mapping": ("counts", mrows, ["n"], []),
            "t46_race_revised": ("counts", rows, cols, [("p_code_given_current_self_report", "n_both_current",
                                                          "n_self_report_current")]),
            "t46_race_revised_standardized": ("frame", pd.DataFrame(std_rows))}


# ----------------------------------------------------------------------------------------------------------------
# Items 6 and 7: adjusted sex contrasts and participant-level bootstrap
# ----------------------------------------------------------------------------------------------------------------

def _sparse(cols, n):
    from scipy import sparse
    r = np.concatenate([np.flatnonzero(v) for v in cols]) if cols else np.array([], int)
    c = np.concatenate([np.full(int(v.sum()), j) for j, v in enumerate(cols)]) if cols else np.array([], int)
    return sparse.csr_matrix((np.ones(len(r), np.float32), (r, c)), shape=(n, len(cols)))


def poisson_sums(X, B, rng, chunk=100):
    """Column sums of X under B Poisson(1) participant weightings (rows with no nonzero entry dropped)."""
    keep = np.flatnonzero(X.getnnz(axis=1) > 0)
    X = X[keep]
    Xt = X.T.tocsr()
    out = np.empty((B, X.shape[1]), np.float32)
    for s in range(0, B, chunk):
        b = min(chunk, B - s)
        W = rng.poisson(1.0, size=(X.shape[0], b)).astype(np.float32)
        out[s:s + b] = np.asarray(Xt @ W).T
    return out


def cluster_sums(X, cluster, B, rng):
    from scipy import sparse
    codes, uniq = pd.factorize(pd.Series(cluster))
    Z = sparse.csr_matrix((np.ones(len(codes)), (codes, np.arange(len(codes)))), shape=(len(uniq), len(codes)))
    Sc = np.asarray((Z @ X).todense())
    m = rng.multinomial(len(uniq), np.full(len(uniq), 1 / len(uniq)), size=B)
    return m @ Sc


def ci(x):
    x = np.asarray(x, float)
    x = x[np.isfinite(x)]
    if len(x) < 0.9 * B_REPS:
        return None
    return round(float(np.percentile(x, 2.5)), 3), round(float(np.percentile(x, 97.5)), 3)


def arrays(D, src):
    R = D.R.reset_index(drop=True)
    pid = R.person_id
    A = {"sex": R.sex.to_numpy(), "race": R.race_eth.to_numpy(), "age": R.age_band.to_numpy(),
         "p5": R.ehr_depth.isin(DEEP).to_numpy(), "depth": R.ehr_depth.to_numpy(), "n": len(R)}
    A["site"] = pid.map(site_map(src)).to_numpy(dtype=object)
    for c in CONDS:
        S = D.S["new"][c]
        cur = pid.isin(S["cur"]).to_numpy()
        A["cur_" + c], A["both_" + c] = cur, cur & pid.isin(S["coded"]).to_numpy()
    return A


def item6(L, D, src):
    A = arrays(D, src)
    conds = [c for c in CONDS if c != ENDO]
    p5 = A["p5"]
    st = np.array([AGE_BANDS.index(a) * 2 + DEEP.index(d) if m else -1 for a, d, m in zip(A["age"], A["depth"], p5)])
    sites = sorted({s for s, m in zip(A["site"], p5) if m and s is not None and s == s})
    sidx = {s: i for i, s in enumerate(sites)}
    ss = np.array([sidx[s] * 10 + t if (t >= 0 and s in sidx) else -1 for s, t in zip(A["site"], st)])
    female = A["sex"] == "Female"
    sex_i = np.where(female, 0, 1)

    def strat_matrix(strat, nstrat):
        """Columns (condition, sex, stratum, current | coded), built from coordinates."""
        from scipy import sparse
        rr, cc = [], []
        for i, c in enumerate(conds):
            for kind, v in ((0, A["cur_" + c]), (1, A["both_" + c])):
                r = np.flatnonzero(v & (strat >= 0))
                rr.append(r)
                cc.append(((i * 2 + sex_i[r]) * nstrat + strat[r]) * 2 + kind)
        r, c = np.concatenate(rr), np.concatenate(cc)
        return sparse.csr_matrix((np.ones(len(r), np.float32), (r, c)), shape=(A["n"], len(conds) * 2 * nstrat * 2))
    rng = np.random.default_rng(SEED + 6)
    Xs, Xm = strat_matrix(st, 10), strat_matrix(ss, max(1, len(sites)) * 10)
    shape_s, shape_m = (len(conds), 2, 10, 2), (len(conds), 2, max(1, len(sites)) * 10, 2)
    T0s, T0m = np.asarray(Xs.sum(0)).reshape(shape_s), np.asarray(Xm.sum(0)).reshape(shape_m)
    Ts = poisson_sums(Xs, B_REPS, rng).reshape((B_REPS,) + shape_s)
    Tm = poisson_sums(Xm, B_REPS, rng).reshape((B_REPS,) + shape_m)

    def std_ratio(T):    # T[..., cond, sex, stratum, kind]
        n, a = T[..., 0], T[..., 1]
        ok = (n[..., 0, :] > 0) & (n[..., 1, :] > 0)
        w = np.where(ok, n[..., 0, :] + n[..., 1, :], 0.0)
        w = w / np.where(w.sum(-1, keepdims=True) > 0, w.sum(-1, keepdims=True), np.nan)
        with np.errstate(invalid="ignore", divide="ignore"):
            p = np.where(n > 0, a / np.where(n > 0, n, 1), 0.0)
            sf, sm = (w * p[..., 0, :]).sum(-1), (w * p[..., 1, :]).sum(-1)
            return sf, sm, sf / sm

    def mh(T):
        n, a = T[..., 0], T[..., 1]
        N = n[..., 0, :] + n[..., 1, :]
        ok = (n[..., 0, :] > 0) & (n[..., 1, :] > 0)
        with np.errstate(invalid="ignore", divide="ignore"):
            num = np.where(ok, a[..., 0, :] * n[..., 1, :] / np.where(N > 0, N, 1), 0).sum(-1)
            den = np.where(ok, a[..., 1, :] * n[..., 0, :] / np.where(N > 0, N, 1), 0).sum(-1)
            return num / den, ok.sum(-1)

    sf0, sm0, r0 = std_ratio(T0s)
    rb = std_ratio(Ts)[2]
    mh0, nstrata = mh(T0m)
    mhb = mh(Tm)[0]
    used_sites = [len({k // 10 for k in np.flatnonzero((T0m[i, 0, :, 0] > 0) & (T0m[i, 1, :, 0] > 0))}) for i in range(len(conds))]
    raw = []
    for i, c in enumerate(conds):
        cnt = [int(T0s[i, s, :, kind].sum()) for s in (0, 1) for kind in (0, 1)]
        raw.append({"condition": c, "not_estimable": min(cnt[0], cnt[2]) == 0,
                    "std_share_female": round(float(sf0[i]), 4), "std_share_male": round(float(sm0[i]), 4),
                    "std_ratio": round(float(r0[i]), 3), "std_ci": ci(rb[:, i]),
                    "mh_ratio_within_site": round(float(mh0[i]), 3), "mh_ci": ci(mhb[:, i]),
                    "sites_included": f"{used_sites[i]} sites"})

    out = []
    for r in raw:
        hide = "not estimable" if r["not_estimable"] else None
        row = {"condition": r["condition"]}
        for name in ("std_share_female", "std_share_male", "std_ratio"):
            row[name] = hide or r[name]
        row["std_ratio_ci_low"], row["std_ratio_ci_high"] = (hide, hide) if hide or not r["std_ci"] else r["std_ci"]
        row["mh_ratio_within_site"] = hide or r["mh_ratio_within_site"]
        row["mh_ci_low"], row["mh_ci_high"] = (hide, hide) if hide or not r["mh_ci"] else r["mh_ci"]
        row["sites_included"] = r["sites_included"]
        out.append(row)
    return {"t46_sex_adjusted": ("frame", pd.DataFrame(out))}


def item7(L, D, src):
    A = arrays(D, src)
    female = A["sex"] == "Female"
    groups = [("5 or more years", "all", A["p5"])] + [("race_eth", g, A["race"] == g) for g in D.race_cats] + \
             [("age_band", g, A["age"] == g) for g in AGE_BANDS]
    cols, idx = [], {}

    def add(key, v):
        idx[key] = len(cols)
        cols.append(v)
    for ax, g, m in groups:
        for c in CONDS:
            mm = m & female if c == ENDO else m
            add((ax, g, c, "cur"), A["cur_" + c] & mm); add((ax, g, c, "both"), A["both_" + c] & mm)
        for c in ANCHORS:
            add((ax, g, c + "|F", "cur"), A["cur_" + c] & m & female); add((ax, g, c + "|F", "both"), A["both_" + c] & m & female)
    for c in CONDS:
        if c != ENDO:
            for s, sx in (("Female", female), ("Male", ~female)):
                add(("sex", s, c, "cur"), A["cur_" + c] & A["p5"] & sx); add(("sex", s, c, "both"), A["both_" + c] & A["p5"] & sx)
    X = _sparse(cols, A["n"])
    rng = np.random.default_rng(SEED + 7)
    T0 = np.asarray(X.sum(0)).ravel()
    T = poisson_sums(X, B_REPS, rng)
    site = np.array([s if (s is not None and s == s) else "unassigned" for s in A["site"]], dtype=object)
    Tc = cluster_sums(X, site, B_REPS, rng)
    raw = []

    def get(Tm, key, kind):
        return Tm[..., idx[key + (kind,)]] if key + (kind,) in idx else None

    def prop(Tm, key):
        cu, bo = get(Tm, key, "cur"), get(Tm, key, "both")
        with np.errstate(invalid="ignore", divide="ignore"):
            return np.where(cu > 0, bo / np.where(cu > 0, cu, 1), np.nan)

    def counts(key):
        cu, bo = int(T0[idx[key + ("cur",)]]), int(T0[idx[key + ("both",)]])
        return [cu, bo, cu - bo]
    for ax, g, _ in groups:
        for c in CONDS:
            if c in ANCHORS:
                continue
            anc = [a + "|F" for a in ANCHORS] if c == ENDO else ANCHORS
            keys = [(ax, g, c)] + [(ax, g, a) for a in anc]

            def rel(Tm, keys=keys):
                with np.errstate(invalid="ignore", divide="ignore"):
                    return prop(Tm, keys[0]) / ((prop(Tm, keys[1]) + prop(Tm, keys[2])) / 2)
            cnt = sum((counts(k) for k in keys), [])
            dens = cnt[0::3]
            base = {"axis": ax, "group": g, "condition": c, "anchors": "women" if c == ENDO else "women and men"}
            raw.append({**base, "estimand": "share relative to anchors", "ci": ci(rel(T)), "cnt": cnt, "dens": dens})
            if ax == "5 or more years":
                raw.append({**base, "estimand": "share relative to anchors, site-cluster bootstrap", "ci": ci(rel(Tc)),
                            "cnt": cnt, "dens": dens})
    for c in CONDS:
        if c == ENDO:
            continue
        kf, km = ("sex", "Female", c), ("sex", "Male", c)
        with np.errstate(invalid="ignore", divide="ignore"):
            r = prop(T, kf) / prop(T, km)
        raw.append({"axis": "5 or more years", "group": "all", "condition": c, "anchors": "not applicable",
                    "estimand": "women-to-men ratio of share coded", "ci": ci(r), "cnt": counts(kf) + counts(km),
                    "dens": [counts(kf)[0], counts(km)[0]]})
    out = []
    for r in raw:
        if min(r["dens"]) == 0 or r["ci"] is None:
            lo = hi = "not estimable"
        else:
            lo, hi = r["ci"]
        out.append({"estimand": r["estimand"], "axis": r["axis"], "group": r["group"], "condition": r["condition"],
                    "anchors": r["anchors"], "ci_low": lo, "ci_high": hi})
    return {"t46_bootstrap": ("frame", pd.DataFrame(out))}


# ----------------------------------------------------------------------------------------------------------------
# Item 8: routing and item nonresponse
# ----------------------------------------------------------------------------------------------------------------

def item8(L, D, src):
    O = get_occasions(D)
    labels = ["any survey"] + [s for s in ("Personal and Family Health History", "Personal Medical History",
                                           "Family Health History", "unlinked or other") if (O.survey == s).any()]
    cols = ["n_reached_who_question", "n_reached_category_question", "n_selected_self", "n_first_told",
            "n_self_and_first_told", "n_self_without_first_told", "n_first_told_without_self", "n_first_told_skip",
            "n_no_care_answer", "n_current"]
    rows = []
    for c in CONDS:
        ids = set((D.R_f if c == ENDO else D.R).person_id)
        Oc = O[O.person_id.isin(ids)]
        for lab in labels:
            o = Oc if lab == "any survey" else Oc[Oc.survey == lab]
            P = lambda col: set(o.person_id[o[col + "_" + c]])  # noqa: E731
            S, F = P("self"), P("rep")
            v = {"n_reached_who_question": len(P("who")), "n_reached_category_question": len(P("cat")),
                 "n_selected_self": len(S), "n_first_told": len(F), "n_self_and_first_told": len(S & F),
                 "n_self_without_first_told": len(S - F), "n_first_told_without_self": len(F - S),
                 "n_first_told_skip": len(P("skip") & F), "n_no_care_answer": len(F - P("care")),
                 "n_current": len(set(o.person_id[o["cy_" + c]]) & F) if lab != "any survey" else len(ids & D.S["new"][c]["cur"])}
            K = {col: ("i8", c, lab, col) for col in cols}
            for col in cols:
                L.add(K[col], v[col])
            # two exact splits within the row
            L.equal([K["n_selected_self"]], [K["n_self_and_first_told"], K["n_self_without_first_told"]])
            L.equal([K["n_first_told"]], [K["n_self_and_first_told"], K["n_first_told_without_self"]])
            rows.append({"condition": c, "population": "women" if c == ENDO else "women and men", "survey": lab, **K})
    vrows = []
    cd = D.conduct[D.conduct.person_id.isin(D.resp_ids)].copy()
    cd["survey"] = cd.survey_name.map(survey_label)
    cd["version"] = cd.version.map(lambda v: "(none)" if v is None or (isinstance(v, float) and math.isnan(v)) or str(v) in ("", "nan", "None", "<NA>")
                                   else re.sub(r"(\d{4})-(\d{2})-\d{2}", r"\1-\2", str(v))[:40])
    cnts = cd.groupby(["survey", "version"]).person_id.nunique().sort_values(ascending=False)
    keep = list(cnts.index[:14])
    cd["vkey"] = [(s, v) if (s, v) in keep else (s, "other versions") for s, v in zip(cd.survey, cd.version)]
    for (s, v), g in cd.groupby("vkey"):
        k = ("i8v", s, v)
        L.add(k, g.person_id.nunique())
        vrows.append({"survey": s, "survey_version_number": v, "n_respondents": k})
    return {"t46_routing": ("counts", rows, cols, []),
            "t46_survey_versions": ("counts", vrows, ["n_respondents"], [])}


# ----------------------------------------------------------------------------------------------------------------
# Item 9: NHANES benchmarks for ages 20+
# ----------------------------------------------------------------------------------------------------------------

def item9(L, D, src):
    if not os.path.exists(WEIGHTS20):
        raise FileNotFoundError("missing ~/unm/src/t46_us_adult20_weights.json (upload workbench/src/t46_us_adult20_weights.json)")
    w = json.load(open(WEIGHTS20))
    preg = set(src.get("pregnancy").person_id)
    dia = set(src.get("diabetes_any").person_id)
    p20 = D.pop[(2023 - D.pop.year_of_birth.astype(float)) >= 20]
    codes = {"obesity": set(D.cn.person_id[D.cn.cond == OB]), "diabetes_type2": set(D.cn.person_id[D.cn.cond == "diabetes_type2"]),
             "diabetes_any_type": dia}
    keys = {"age": lambda d: d.age_band, "age_race": lambda d: d.age_band + "|" + d.race_eth}
    rows = []
    for cond, ids in codes.items():
        for sex in SEXES:
            variants = [("active patients aged 20+", p20[p20.sex == sex])]
            if cond == OB and sex == "Female":
                variants.append(("active patients aged 20+, excluding women with a pregnancy code (July 2021 to June 2023)",
                                 p20[(p20.sex == sex) & ~p20.person_id.isin(preg)]))
            for popl, p in variants:
                for std in ("age", "age_race"):
                    est, lo, hi, n = t26.standardized(p, ids, w[std][sex], keys[std])
                    row = {"condition": cond, "sex": sex, "population": popl,
                           "standard": "US adults 20+: age" if std == "age" else "US adults 20+: age x race and ethnicity",
                           "share": round(est, 4), "ci_low": round(lo, 4), "ci_high": round(hi, 4)}
                    rows.append(row)
    k = ("i9", "pregnancy")
    L.add(k, len(set(p20.person_id[p20.sex == "Female"]) & preg))
    ex = [{"sex": "Female", "population": "active patients aged 20+",
           "excluded_for": "ICD-10-CM O00-O9A, Z33, Z34, or Z3A code dated July 2021 to June 2023", "n_excluded": k}]
    return {"t46_benchmark20": ("frame", pd.DataFrame(rows)),
            "t46_benchmark20_excluded": ("counts", ex, ["n_excluded"], [])}


# ----------------------------------------------------------------------------------------------------------------
# Main
# ----------------------------------------------------------------------------------------------------------------

def definitions(D):
    d = [
        ("respondents", "female or male active patients with a Personal and Family Health History or Personal Medical History survey_conduct record, or an answer to a Task 26 follow-up question"),
        ("primary population", "respondents whose first EHR condition record (any vocabulary) is 5 or more years before the earliest survey_end_date (Task 28)"),
        ("survey occasion", f"one questionnaire response; linkage: {D.linkage}; answers without a questionnaire response id form one occasion per answer date"),
        ("earliest survey occasion", "item 3: the respondent's Personal and Family Health History, Personal Medical History, or unlinked occasion with the earliest answer date among the condition, care, self-selection, category, and gate questions (Family Health History occasions are not used in item 3)"),
        ("discordant", "ever: reported the condition on one occasion and on another was asked about its condition group without reporting it; current: in the any-occasion current-care group and on some occasion asked without reporting current care"),
        ("code window", "item 3: a qualifying code dated no later than 365 days after the earliest survey occasion (any earlier date counts)"),
        ("coverage order", "item 4 categories are exclusive, checked in this order: ICD-10-CM in observation; ICD-9-CM (patterns in icd9_patterns; R53.82 has no ICD-9 equivalent counted); another source vocabulary (not ICD-10-CM, not PPI) recorded with a standard concept that a qualifying ICD-10-CM code maps to one-to-one"),
        ("ethnicity revision", "item 5: non-Hispanic race categories require an explicit Not Hispanic or Latino ethnicity; otherwise Unknown"),
        ("population tables", "t46_population, t46_population_age, t46_sex_adjusted, and the 5 or more years rows of t46_bootstrap describe the primary population"),
        ("sex adjustment", "item 6: direct standardization of each sex's share to the pooled distribution of current self-reporters over age band x record length (strata with both sexes); Mantel-Haenszel risk ratio over assigned site x age band x record length"),
        ("bootstrap", f"items 6-7: {B_REPS} replicates, Poisson(1) participant weights (each participant keeps all condition memberships), seed {SEED}; percentile 95% intervals; site-cluster version resamples assigned sites (participants without a site form 1 cluster)"),
        ("routing", "item 8: person-level within each survey label; any survey row uses all occasions; n_current in survey rows needs the care answer and the first-told answer in that survey"),
        ("benchmark ages", "item 9: age 20+ on January 1, 2023, NHANES 2021-2023 interview-weight standards for adults 20+; diabetes_any_type codes E08, E09, E10, E11, E13 in condition_occurrence"),
        ("disclosure", "counts of 1-20 shown as <=20; others rounded up to a multiple of 10; within one table, each exact identity among its cells (a total and its parts, or two breakdowns of the same population) has no hidden cell or at least two hidden cells totaling more than 20, and a cell hidden to achieve that is shown as hidden; no check uses another table or an earlier release; shares use shown counts; bootstrap results are interval endpoints only"),
        ("prior release recount", "report only: each uploaded Task 25-28 or 34 release is recounted from the CDR and compared with its released values (t46_prior_check); a missing or differing file changes no cell of this task"),
    ]
    return pd.DataFrame(d, columns=["item", "definition"])


ITEMS = [("1 primary population and flow", item1), ("2 female anchors", item2), ("3 survey occasion", item3),
         ("4 code coverage", item4), ("5 ethnicity mapping", item5), ("6 adjusted sex contrasts", item6),
         ("7 joint uncertainty", item7), ("8 routing and missingness", item8), ("9 benchmark alignment", item9)]


def main(loader=None):
    src = Source(loader)
    D = build(src)
    print("data loaded", flush=True)
    try:
        prior_rows, prior_status = recount_prior(D, read_prior())
    except Exception as e:  # noqa: BLE001 (the recount is a report; it never stops the run)
        traceback.print_exc()
        prior_rows = [{"released_table": "all", "cells_compared": "recount failed", "cells_matching_recount": type(e).__name__}]
        prior_status = {"item": "prior release recount (report only)", "status": f"report only; recount failed: {type(e).__name__}"}
    print(f"earlier releases: {prior_status['status']}", flush=True)
    L = Ledger()
    specs, status = {}, []
    for name, fn in ITEMS:
        snap = L.snapshot()
        try:
            res = fn(L, D, src)
            specs.update(res)
            status.append({"item": name, "status": "ok"})
            print(f"item {name}: ok", flush=True)
        except Exception as e:  # noqa: BLE001 (one item's failure must not block the others)
            L.restore(snap)
            traceback.print_exc()
            status.append({"item": name, "status": f"failed: {type(e).__name__}: {clean(getattr(e, 'message', None) or e)}"})
            print(f"item {name}: failed", flush=True)
    passes = L.resolve()
    print(f"within-table suppression resolved in {passes} passes", flush=True)
    tables = {}
    for name, spec in specs.items():
        tables[name] = materialize(L, spec[1], spec[2], spec[3]) if spec[0] == "counts" else spec[1]
    tables["t46_definitions"] = definitions(D)
    tables["t46_item_status"] = pd.DataFrame(status + [prior_status])
    tables["t46_prior_check"] = pd.DataFrame(prior_rows)
    os.makedirs(EXPORT, exist_ok=True)
    for name, df in tables.items():
        check_exportable(df)
        df.to_csv(os.path.join(EXPORT, f"{name}.csv"), index=False)
        print(f"exported {name} ({len(df)} rows)", flush=True)
    print("Task 46 finished", flush=True)
    return L


if __name__ == "__main__":
    main()
