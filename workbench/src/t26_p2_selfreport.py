"""Task 26 (Paper 2): self-reported diagnosis vs EHR code, and age-standardized coded shares by sex.

Runs inside the All of Us Workbench (bash ~/unm/bin/unm.sh run 26).
Population: Task 25's active adult EHR patients (same query); women and men only. The Other/unknown
sex group is omitted from every table and no table has an overall row.
Inputs : us_adult_weights.json (NHANES 2021-2023 adult population by sex x age band x race and
         ethnicity, computed outside Workbench from public data).
Exports: ~/unm/export/26/
  t26_selfreport_vs_code: one row per condition and sex, among active patients who answered the
      Personal and Family Health History survey (or the earlier Personal Medical History survey):
      respondents; self-reported diagnosis ever (any answer, including a skip, to "About how old were
      you when you were first told you had <condition>?", which is asked only of participants who
      selected Self); current self-report (Yes to "still seeing a doctor" or "currently prescribed
      medications and/or receiving treatment" for the condition); any ICD-10-CM code ever; and the
      overlaps. Counts rounded up to 10, with primary and complementary suppression within the row.
      Conditional shares are computed from the shown (rounded) counts.
  t26_composition: active-population counts by sex x age band and sex x race and ethnicity (as Task
      22), with primary suppression, rounding, and complements within the same sex's age/race partitions.
  t26_standardized_shares: per condition, sex, code definition (any code; codes on two or more dates
      at least 30 days apart) and standard (US adult age distribution; age x race and ethnicity), the
      directly standardized coded share with a 95% interval. No counts.
  t26_definitions: respondent definition used and the share of self-reporters it captured.
"""

from __future__ import annotations

import json
import math
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
import t25_p2_coded_shares as t25  # noqa: E402
from aou_safe import MAX_SUPPRESSED, SECONDARY, check_exportable, protect  # noqa: E402
from t01_cohort import _age_band, _race_eth, _sex  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
EXPORT = os.path.expanduser("~/unm/export/26")
SEXES = ["Female", "Male"]
FIRST_TOLD = {  # PFHH "About how old were you when you were first told you had ..." (Task 25 release)
    "hypertension": 43530468, "diabetes_type2": 43530492, "obesity": 43530542, "depression": 43530516,
    "anxiety": 43530514, "migraine": 43530529, "fibromyalgia": 43530551, "endometriosis": 1384636,
    "lyme": 1384432, "chronic_fatigue": 43530523,
}
CURRENT = {  # (question, Yes answer): "still seeing a doctor ..." and "currently prescribed ... or receiving treatment"
    "hypertension": [(43530310, 43530065), (1384437, 1385316)],
    "diabetes_type2": [(43530335, 43530262), (43528820, 43530223)],
    "obesity": [(43530384, 43530091), (43528869, 43530191)],
    "depression": [(43530358, 43530029), (43528843, 43530145)],
    "anxiety": [(43530356, 43529997), (43528841, 43530119)],
    "migraine": [(43530371, 43530083), (43528856, 43530183)],
    "fibromyalgia": [(43530393, 43530045), (43528878, 43530156)],
    "endometriosis": [(1384474, 1384911), (1384624, 1384944)],
    "lyme": [(1384431, 1385133), (1384628, 1385620)],
    "chronic_fatigue": [(43530365, 43530015), (43528850, 43530135)],
}
CODE_KEY = {"chronic_fatigue": ["mecfs_postviral", "chronic_fatigue_unspecified"]}   # self-report -> EHR conditions


def query_survey(cdr):
    from google.cloud import bigquery
    client = bigquery.Client()
    ids = sorted(set(FIRST_TOLD.values()) | {q for v in CURRENT.values() for q, _ in v})
    sr = client.query(f"""
        SELECT DISTINCT person_id, observation_source_concept_id AS q, value_source_concept_id AS a
        FROM `{cdr}.observation` WHERE observation_source_concept_id IN ({", ".join(map(str, ids))})
    """).to_dataframe()
    try:
        resp = client.query(f"""
            SELECT DISTINCT sc.person_id FROM `{cdr}.survey_conduct` sc
            JOIN `{cdr}.concept` c ON sc.survey_concept_id = c.concept_id
            WHERE LOWER(c.concept_name) LIKE '%personal and family health history%'
               OR LOWER(c.concept_name) LIKE '%personal medical history%'
        """).to_dataframe()
        note = "survey_conduct: Personal and Family Health History or Personal Medical History"
    except Exception:
        resp = pd.DataFrame({"person_id": []})
    if len(resp) < 1000:
        resp = client.query(f"""
            SELECT DISTINCT o.person_id FROM `{cdr}.observation` o
            JOIN `{cdr}.concept` q ON o.observation_source_concept_id = q.concept_id AND q.vocabulary_id = 'PPI'
            WHERE LOWER(q.concept_name) LIKE 'have you or anyone in your family ever been diagnosed with the following%'
               OR LOWER(q.concept_name) LIKE 'has a doctor or health care provider ever told you%'
               OR LOWER(q.concept_name) LIKE 'including yourself, who in your family%'
               OR REGEXP_CONTAINS(q.concept_name, r'^[A-Za-z ,]+: [A-Za-z ,]+ Conditions?$')
        """).to_dataframe()
        note = "fallback: any answer to a Personal and Family Health History condition-category question"
    return sr, resp, note


def prepare(pop, codes):
    pop = pop.copy()
    pop["sex"] = pop.sex_name.map(_sex)
    pop["race_eth"] = [_race_eth(r, e) for r, e in zip(pop.race_name, pop.eth_name)]
    pop["age_band"] = (2023 - pop.year_of_birth).map(_age_band)
    codes = codes[codes.person_id.isin(pop.person_id)].copy()
    span = (pd.to_datetime(codes.last_d.astype(str)) - pd.to_datetime(codes.first_d.astype(str))).dt.days
    codes["two_plus"] = (codes.n_dates >= 2) & (span >= 30)
    return pop, codes


def _ratio(num, den):
    if isinstance(num, str):
        return num
    if isinstance(den, str):
        return den
    return round(int(num) / int(den), 3) if int(den) > 0 else 0.0


def selfreport_table(pop, codes, sr, resp_ids):
    cols = ["n_respondents", "n_self_report", "n_self_report_current", "n_coded", "n_both", "n_both_current"]
    rows = []
    for cond, qid in FIRST_TOLD.items():
        keys = CODE_KEY.get(cond, [cond])
        coded = set(codes.loc[codes.cond.isin(keys), "person_id"])
        ever = set(sr.loc[sr.q == qid, "person_id"])
        cur = set().union(*[set(sr.loc[(sr.q == q) & (sr.a == a), "person_id"]) for q, a in CURRENT[cond]]) & ever
        for sex in (["Female"] if cond == "endometriosis" else SEXES):
            p = pop[pop.sex == sex]
            ids = set(p.person_id) & resp_ids
            rows.append({"condition": cond, "sex": sex, "n_respondents": len(ids), "n_self_report": len(ids & ever),
                         "n_self_report_current": len(ids & cur), "n_coded": len(ids & coded),
                         "n_both": len(ids & ever & coded), "n_both_current": len(ids & cur & coded),
                         "n_neither": len(ids - ever - coded)})
    raw = pd.DataFrame(rows)
    out = protect(raw, cols, complements=[
        ("n_respondents", "n_self_report"), ("n_respondents", "n_coded"),
        ("n_self_report", "n_self_report_current"), ("n_self_report", "n_both"), ("n_coded", "n_both"),
        ("n_self_report_current", "n_both_current"), ("n_both", "n_both_current"), ("n_coded", "n_both_current")])
    for i, r in raw.iterrows():
        if 0 < r.n_neither <= MAX_SUPPRESSED and all(
                not isinstance(out.at[i, c], str) for c in ("n_respondents", "n_self_report", "n_coded", "n_both")):
            col = next(c for c in ("n_both", "n_coded", "n_self_report", "n_respondents") if raw.at[i, c] > 0)
            out.at[i, col] = SECONDARY      # respondents - self-report - coded + both would be 1-20
    out = out[["condition", "sex"] + cols].copy()
    out["p_code_given_self_report"] = [_ratio(b, s) for b, s in zip(out.n_both, out.n_self_report)]
    out["p_code_given_current_self_report"] = [_ratio(b, s) for b, s in zip(out.n_both_current, out.n_self_report_current)]
    out["p_self_report_given_code"] = [_ratio(b, c) for b, c in zip(out.n_both, out.n_coded)]
    return out


def composition_table(pop_all):
    rows = []
    for axis in ("age_band", "race_eth"):
        for cat, g in pop_all.groupby(axis):
            n = g.sex.value_counts()
            for sex in SEXES:
                rows.append({"sex": sex, "axis": axis, "category": str(cat), "n": int(n.get(sex, 0))})
    raw = pd.DataFrame(rows)
    out = protect(raw, ["n"])
    for (sex, axis), g in raw.groupby(["sex", "axis"]):
        other = raw[(raw.sex == sex) & (raw.axis != axis)]
        total = int((pop_all.sex == sex).sum())
        available = (g.n.sum() == total and other.n.sum() == total
                     and not out.loc[other.index, "n"].map(lambda v: isinstance(v, str)).any())
        if available:
            out.loc[g.index, "n"] = protect(g, ["n"], partition=True)["n"]
    return out[["sex", "axis", "category", "n"]]


def standardized(p: pd.DataFrame, ids: set, weights: dict, key) -> tuple[float, float, float, int]:
    g = p.assign(k=key(p), y=p.person_id.isin(ids)).groupby("k").y.agg(["sum", "count"])
    g = g[g.index.isin(weights.keys())]
    w = pd.Series({k: weights[k] for k in g.index}, dtype=float)
    if g.empty or w.sum() <= 0:
        return float("nan"), float("nan"), float("nan"), 0
    w = w / w.sum()
    rate = g["sum"] / g["count"]
    est = float((w * rate).sum())
    se = float(math.sqrt((w ** 2 * rate * (1 - rate) / g["count"]).sum()))
    return est, max(0.0, est - 1.96 * se), min(1.0, est + 1.96 * se), int(g["sum"].sum())


def standardized_table(pop, codes, weights):
    rows = []
    keys = {"age": lambda d: d.age_band, "age_race": lambda d: d.age_band + "|" + d.race_eth}
    for cond in t25.CONDITIONS:
        c = codes[codes.cond == cond]
        for definition, ids in (("any code", set(c.person_id)),
                                ("two dates", set(c.loc[c.two_plus, "person_id"]))):
            for sex in (["Female"] if cond in t25.SEX_SPECIFIC else SEXES):
                p = pop[pop.sex == sex]
                for std in ("age", "age_race"):
                    est, lo, hi, n_coded = standardized(p, ids, weights[std][sex], keys[std])
                    row = {"condition": cond, "sex": sex, "code_definition": definition,
                           "standard": "US adults: age" if std == "age" else "US adults: age x race and ethnicity",
                           "share": round(est, 4), "ci_low": round(lo, 4), "ci_high": round(hi, 4)}
                    rows.append(row)
    return pd.DataFrame(rows)


def main(loader=None):
    weights = json.load(open(os.path.join(HERE, "us_adult_weights.json")))
    if loader:
        pop_raw, codes_raw, sr, resp, note = loader()
    else:
        cdr = subprocess.check_output(["wb", "resolve", f"--id={t25.CDR_ID}"], text=True).strip()
        pop_raw, codes_raw, _ = t25.query(cdr)
        print("querying survey answers", flush=True)
        sr, resp, note = query_survey(cdr)
    print("data loaded", flush=True)
    pop_all, codes = prepare(pop_raw, codes_raw)
    pop = pop_all[pop_all.sex.isin(SEXES)]
    srp = sr[sr.person_id.isin(pop.person_id)]
    resp_ids = set(resp.person_id) & set(pop.person_id)
    captured = len(set(srp.person_id) & resp_ids) / max(1, srp.person_id.nunique())
    resp_ids |= set(srp.person_id)      # anyone who answered a follow-up question took the survey
    os.makedirs(EXPORT, exist_ok=True)
    tables = {
        "t26_selfreport_vs_code": selfreport_table(pop, codes, srp, resp_ids),
        "t26_composition": composition_table(pop_all),
        "t26_standardized_shares": standardized_table(pop, codes, weights),
        "t26_definitions": pd.DataFrame([{"respondent_definition": note,
                                          "share_of_self_reporters_captured_before_union": round(captured, 2),
                                          "age_race_standard_excludes": "race and ethnicity Unknown",
                                          "weights_source": weights["source"]}]),
    }
    for name, df in tables.items():
        check_exportable(df)
        df.to_csv(os.path.join(EXPORT, f"{name}.csv"), index=False)
        print(f"exported {name} ({len(df)} rows)", flush=True)
    print("Task 26 finished", flush=True)


if __name__ == "__main__":
    main()
