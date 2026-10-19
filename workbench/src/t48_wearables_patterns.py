"""Task 48: wearable (Fitbit) activity and sleep patterns, descriptive and unsupervised. Aggregates only.

Runs inside the All of Us Workbench (bash ~/unm/bin/unm.sh run 48).
Tables (Registered Tier v9): activity_summary (steps, sedentary/lightly/fairly/very active minutes),
sleep_daily_summary (main sleep: minute_asleep), heart_rate_summary (daily min_heart_rate in the "Out of Range"
zone, a resting-rate proxy). Dates are shifted per participant, so only days relative to each person's day 0 are
used. Per-day aggregation runs in BigQuery; pandas receives per-person (Part A: per-person-week) summaries.

A. Long COVID trajectories. Paper 1 landmark cohort (~/unm/output/cohort_v2.parquet) members with 30+ days of
   activity_summary rows in days -365..-1 and 30+ in days 0..180 (exactly Task 38's "with both" definition, so the
   population equals the released Task 38 count). Weeks -26..+26 (week w = days 7w..7w+6): people contributing and
   the mean (95% CI) of per-person weekly means of daily steps and sedentary minutes (days with steps > 0), main
   sleep minutes asleep, and the resting-rate proxy. Groups: all; chart band at day 90 High or Elevated vs Typical
   (model/longcovid.json applied to ~/unm/output/features_v3.parquet, Task 35); sym_count_ge2 yes vs no. A
   count is protected separately, retaining every group and week and within-table complements.
B. Self-reported conditions (Paper 3 cohorts, rebuilt with the Task 30/39 functions; day 0 = earliest Personal and
   Family Health History or Personal Medical History survey). Participants with 30+ activity days (steps > 0) in
   days -365..-1. Groups: self-reporters coded later, never coded, all self-reporters, non-reporters (crude and
   standardized to the self-reporters' age band x sex distribution). Per person, the mean over the year of each
   measure; by group: n (rounded up to 10), mean with 95% CI, and p10/p25/p50/p75/p90 rounded (steps to 100,
   minutes to 10, heart rate to 1 bpm).
C. Unsupervised profiles. Union of the three Paper 3 cohorts with 90+ activity days, 14+ main-sleep days, and 14+
   resting-rate days in days -365..-1. Seven per-person features, winsorized at the 1st/99th percentiles and
   z-scored; k-means for k = 3..6 (fixed seed, 20 starts), k chosen by silhouette. Released: each cluster's share
   of the profile population (rounded to 0.001; no cluster counts), centroids in original units, and per condition the counts and
   shares of non-reporters, never-coded, and coded self-reporters in each cluster. No embeddings, coordinates, or
   assignments leave the Workbench.

Disclosure: aou_safe protects each table's participant counts independently: 1-20 suppressed, other counts
rounded up to 10, and within-table complementary suppression. Aggregate statistics are retained independently
of count suppression; a cell containing only one participant does not release that person's value. Cluster
shares within each condition and group use shown rounded counts. No cross-release or cross-table guards.

Inputs (fail with a clear message if missing): ~/unm/output/cohort_v2.parquet, features_v3.parquet;
~/unm/src/longcovid.json (upload model/longcovid.json). Participant-level intermediates written to ~/unm/output/
(stay in Workbench): t48_lc_person_weeks.parquet, t48_p3_wearables.parquet.
Exports (~/unm/export/48/): t48_lc_trajectory, t48_selfreport_profiles, t48_clusters, t48_cluster_by_group,
t48_summary (text: k selection, silhouettes, parameters; no participant counts).
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time

import numpy as np
import pandas as pd

try:
    import db_dtypes  # noqa: F401
except ImportError:
    pass

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from aou_safe import MAX_SUPPRESSED, SUPPRESSED, SECONDARY, check_exportable, protect  # noqa: E402
from t01_cohort import _age_band  # noqa: E402

CDR_ID = os.environ.get("UNM_CDR_ID", "R2025Q4R6")
OUT = os.path.expanduser("~/unm/output")
EXPORT = os.path.expanduser("~/unm/export/48")
MODEL = os.path.join(HERE, "longcovid.json")
FEATURES = "features_v3.parquet"

SEED = 20261011
WEEKS = list(range(-26, 27))
A_MIN_PRE, A_MIN_POST = 30, 30       # Task 38 definition (any activity_summary row counts as a day)
MIN_WEEK_DAYS = 1                     # a person contributes to a week with 1+ valid day of that measure
B_MIN_ACT, B_MIN_SLEEP, B_MIN_HR = 30, 7, 7
C_MIN_ACT, C_MIN_SLEEP, C_MIN_HR = 90, 14, 14
K_RANGE = range(3, 7)
N_INIT = 20
SIL_SAMPLE = 10000
STEPS_MAX = 100000
HR_RANGE = (25, 200)

A_MEASURES = [("steps", "steps"), ("sedentary", "sedentary"), ("asleep", "asleep"), ("rest_hr", "rest_hr")]
A_GROUPS = ["all", "band_high_or_elevated", "band_typical", "sym_count_ge2", "sym_count_lt2"]
A_SPLITS = [("band_high_or_elevated", "band_typical"), ("sym_count_ge2", "sym_count_lt2")]

# Part B measures: (name, per-person column, availability column, minimum days, percentile unit, mean decimals)
B_MEASURES = [
    ("mean daily steps", "steps_mean", "n_act_days", B_MIN_ACT, 100, 0),
    ("mean daily sedentary minutes", "sed_mean", "n_act_days", B_MIN_ACT, 10, 1),
    ("mean daily very active minutes", "very_mean", "n_act_days", B_MIN_ACT, 10, 1),
    ("mean minutes asleep (main sleep)", "sleep_mean", "n_sleep_days", B_MIN_SLEEP, 10, 1),
    ("mean resting heart rate proxy (bpm)", "hr_mean", "n_hr_days", B_MIN_HR, 1, 1),
]
B_GROUPS = [("coded", "self-reporters, coded later"), ("uncoded", "self-reporters, never coded"),
            ("all_sr", "all self-reporters"), ("nonrep", "non-reporters"),
            ("nonrep_std", "non-reporters, standardized to self-reporters by age band and sex")]
C_FEATURES = [("steps_mean", "mean daily steps", 0), ("steps_cv", "coefficient of variation of daily steps", 3),
              ("sed_share", "share of awake minutes sedentary", 3), ("very_mean", "mean daily very active minutes", 1),
              ("sleep_mean", "mean minutes asleep", 1), ("sleep_sd", "standard deviation of minutes asleep", 1),
              ("hr_mean", "mean resting heart rate proxy (bpm)", 1)]
C_GROUPS = [("nonrep", "non-reporters"), ("uncoded", "self-reporters, never coded"), ("coded", "self-reporters, coded later")]


def r10(v) -> int:
    v = int(v)
    return int(-(-v // 10) * 10) if v > 0 else 0


def stage(name, fn, *args, **kw):
    """Run a step; on failure raise a RuntimeError naming it (the runner summary drops BigQuery exception names)."""
    try:
        return fn(*args, **kw)
    except Exception as e:  # noqa: BLE001
        msg = getattr(e, "message", None) or str(e)
        raise RuntimeError(f"{name} failed: {type(e).__name__}: {str(msg).splitlines()[0][:300] if msg else ''}") from None


def need(path, what):
    if not os.path.exists(path):
        raise RuntimeError(f"missing input {os.path.basename(path)} ({what})")
    return path


# ----------------------------------------------------------------------------------------------------------
# BigQuery (only this section touches the CDR)
# ----------------------------------------------------------------------------------------------------------

def _client():
    from google.cloud import bigquery
    cdr = subprocess.check_output(["wb", "resolve", f"--id={CDR_ID}"], text=True).strip()
    return cdr, bigquery.Client(), bigquery


MAIN_SLEEP = "LOWER(CAST(z.is_main_sleep AS STRING)) IN ('true', '1', 't', 'yes', 'y')"
OUT_OF_RANGE = "LOWER(TRIM(h.zone_name)) = 'out of range'"


def _act_daily(cdr, base, lo, hi):
    """Daily activity rows (one per person-day) with offsets lo..hi from base.d0."""
    return f"""SELECT a.person_id, SAFE_CAST(a.`date` AS DATE) AS d, ANY_VALUE(b.d0) AS d0,
          MAX(SAFE_CAST(a.steps AS FLOAT64)) AS steps,
          MAX(SAFE_CAST(a.sedentary_minutes AS FLOAT64)) AS sed,
          MAX(SAFE_CAST(a.lightly_active_minutes AS FLOAT64)) AS light,
          MAX(SAFE_CAST(a.fairly_active_minutes AS FLOAT64)) AS fair,
          MAX(SAFE_CAST(a.very_active_minutes AS FLOAT64)) AS very
        FROM `{cdr}.activity_summary` a JOIN {base} b ON a.person_id = b.person_id
        WHERE DATE_DIFF(SAFE_CAST(a.`date` AS DATE), b.d0, DAY) BETWEEN {lo} AND {hi}
        GROUP BY 1, 2"""


def _sleep_daily(cdr, base, lo, hi):
    return f"""SELECT z.person_id, SAFE_CAST(z.sleep_date AS DATE) AS d, ANY_VALUE(b.d0) AS d0,
          MAX(SAFE_CAST(z.minute_asleep AS FLOAT64)) AS asleep
        FROM `{cdr}.sleep_daily_summary` z JOIN {base} b ON z.person_id = b.person_id
        WHERE {MAIN_SLEEP} AND DATE_DIFF(SAFE_CAST(z.sleep_date AS DATE), b.d0, DAY) BETWEEN {lo} AND {hi}
        GROUP BY 1, 2"""


def _hr_daily(cdr, base, lo, hi):
    return f"""SELECT h.person_id, SAFE_CAST(h.`date` AS DATE) AS d, ANY_VALUE(b.d0) AS d0,
          MIN(SAFE_CAST(h.min_heart_rate AS FLOAT64)) AS rhr
        FROM `{cdr}.heart_rate_summary` h JOIN {base} b ON h.person_id = b.person_id
        WHERE {OUT_OF_RANGE} AND SAFE_CAST(h.min_heart_rate AS FLOAT64) BETWEEN {HR_RANGE[0]} AND {HR_RANGE[1]}
          AND DATE_DIFF(SAFE_CAST(h.`date` AS DATE), b.d0, DAY) BETWEEN {lo} AND {hi}
        GROUP BY 1, 2"""


def lc_sql(cdr):
    wk = "CAST(FLOOR(DATE_DIFF(d, d0, DAY) / 7) AS INT64)"
    lo, hi = 7 * WEEKS[0], 7 * WEEKS[-1] + 6
    return f"""
    WITH c AS (
      SELECT pid AS person_id, d0 FROM UNNEST(@ids) AS pid WITH OFFSET AS i
      JOIN UNNEST(@d0s) AS d0 WITH OFFSET AS j ON i = j),
    anyday AS (
      SELECT DISTINCT a.person_id, SAFE_CAST(a.`date` AS DATE) AS d
      FROM `{cdr}.activity_summary` a WHERE a.person_id IN UNNEST(@ids)),
    elig AS (
      SELECT x.person_id, ANY_VALUE(c.d0) AS d0 FROM anyday x JOIN c ON x.person_id = c.person_id
      GROUP BY x.person_id
      HAVING COUNT(DISTINCT IF(DATE_DIFF(x.d, c.d0, DAY) BETWEEN -365 AND -1, x.d, NULL)) >= {A_MIN_PRE}
         AND COUNT(DISTINCT IF(DATE_DIFF(x.d, c.d0, DAY) BETWEEN 0 AND 180, x.d, NULL)) >= {A_MIN_POST}),
    act AS ({_act_daily(cdr, "elig", lo, hi)}),
    aw AS (SELECT person_id, {wk} AS week, steps, sed FROM act WHERE steps > 0 AND steps <= {STEPS_MAX}),
    sl AS ({_sleep_daily(cdr, "elig", lo, hi)}),
    hr AS ({_hr_daily(cdr, "elig", lo, hi)})
    SELECT person_id, week, 'steps' AS measure, COUNT(*) AS n_days, AVG(steps) AS value FROM aw GROUP BY 1, 2
    UNION ALL SELECT person_id, week, 'sedentary', COUNT(*), AVG(sed) FROM aw WHERE sed BETWEEN 0 AND 1440 GROUP BY 1, 2
    UNION ALL SELECT person_id, {wk}, 'asleep', COUNT(*), AVG(asleep) FROM sl WHERE asleep BETWEEN 1 AND 1440 GROUP BY 1, 2
    UNION ALL SELECT person_id, {wk}, 'rest_hr', COUNT(*), AVG(rhr) FROM hr GROUP BY 1, 2
    UNION ALL SELECT person_id, NULL, 'eligible', 0, NULL FROM elig
    """


def query_lc(cohort):
    cdr, client, bigquery = _client()
    cfg = bigquery.QueryJobConfig(query_parameters=[
        bigquery.ArrayQueryParameter("ids", "INT64", [int(x) for x in cohort.index]),
        bigquery.ArrayQueryParameter("d0s", "DATE", list(pd.to_datetime(cohort.index_date).dt.date))])
    print("Part A: querying person-week summaries", flush=True)
    return client.query(lc_sql(cdr), job_config=cfg).to_dataframe()


S_CTE = """s AS (SELECT sc.person_id, MIN(sc.survey_end_date) AS d0 FROM `{cdr}.survey_conduct` sc
          JOIN `{cdr}.concept` c ON sc.survey_concept_id = c.concept_id
          WHERE LOWER(c.concept_name) LIKE '%personal and family health history%'
             OR LOWER(c.concept_name) LIKE '%personal medical history%' GROUP BY 1)"""   # as in Task 30


def p3_sql(cdr):
    s = S_CTE.format(cdr=cdr)
    return f"""
    WITH {s},
    s0 AS (SELECT person_id, SAFE_CAST(d0 AS DATE) AS d0 FROM s),
    act AS ({_act_daily(cdr, "s0", -365, -1)}),
    ap AS (
      SELECT person_id, COUNT(*) AS n_act_days, AVG(steps) AS steps_mean, STDDEV_SAMP(steps) AS steps_sd,
             AVG(IF(sed BETWEEN 0 AND 1440, sed, NULL)) AS sed_mean,
             AVG(IF(very BETWEEN 0 AND 1440, very, NULL)) AS very_mean,
             SUM(IF(sed + light + fair + very BETWEEN 1 AND 1440, sed, NULL)) AS sed_sum,
             SUM(IF(sed + light + fair + very BETWEEN 1 AND 1440, sed + light + fair + very, NULL)) AS awake_sum
      FROM act WHERE steps > 0 AND steps <= {STEPS_MAX}
      GROUP BY 1 HAVING COUNT(*) >= {B_MIN_ACT}),
    sl AS ({_sleep_daily(cdr, "s0", -365, -1)}),
    sp AS (SELECT person_id, COUNT(*) AS n_sleep_days, AVG(asleep) AS sleep_mean, STDDEV_SAMP(asleep) AS sleep_sd
           FROM sl WHERE asleep BETWEEN 1 AND 1440 GROUP BY 1),
    hr AS ({_hr_daily(cdr, "s0", -365, -1)}),
    hp AS (SELECT person_id, COUNT(*) AS n_hr_days, AVG(rhr) AS hr_mean FROM hr GROUP BY 1)
    SELECT ap.*, sp.n_sleep_days, sp.sleep_mean, sp.sleep_sd, hp.n_hr_days, hp.hr_mean, s0.d0
    FROM ap JOIN s0 ON ap.person_id = s0.person_id
    LEFT JOIN sp ON ap.person_id = sp.person_id LEFT JOIN hp ON ap.person_id = hp.person_id
    """


def query_p3_wearables():
    cdr, client, _ = _client()
    print("Parts B and C: querying per-person summaries for the year before day 0", flush=True)
    return client.query(p3_sql(cdr)).to_dataframe()


def query_survey_visits(cdr):
    """Survey day 0 and visit counts in the year before it, as Task 30's query_events (only what build_cohort uses)."""
    from google.cloud import bigquery
    client = bigquery.Client()
    s = S_CTE.format(cdr=cdr)
    survey = client.query(f"WITH {s} SELECT person_id, d0 FROM s").to_dataframe()
    visits = client.query(f"""
        WITH {s}
        SELECT v.person_id, c.concept_name AS visit_type,
               COUNTIF(v.visit_start_date BETWEEN DATE_SUB(s.d0, INTERVAL 365 DAY) AND DATE_SUB(s.d0, INTERVAL 1 DAY)) AS n_R
        FROM `{cdr}.visit_occurrence` v JOIN s USING (person_id)
        LEFT JOIN `{cdr}.concept` c ON v.visit_concept_id = c.concept_id
        GROUP BY 1, 2""").to_dataframe()
    return survey, visits


def p3_specs():
    import t30_cf_model as t30
    import t39_sr_models as t39
    return {"chronic_fatigue": {"code_keys": list(t30.CF_KEYS), "survey": "chronic_fatigue", "sex": None},
            "fibromyalgia": t39.CONDITIONS["fibromyalgia"], "endometriosis": t39.CONDITIONS["endometriosis"]}


def load_p3_cohorts():
    """Paper 3 cohorts rebuilt with the Task 30/39 functions (same CDR, same definitions; not saved by those tasks)."""
    import t25_p2_coded_shares as t25
    import t26_p2_selfreport as t26
    import t39_sr_models as t39
    cdr = subprocess.check_output(["wb", "resolve", f"--id={t25.CDR_ID}"], text=True).strip()
    print("Parts B and C: rebuilding the Paper 3 cohorts", flush=True)
    pop_raw, codes_raw, _ = stage("Task 25 population and codes", t25.query, cdr)
    sr, _, _ = stage("survey answers", t26.query_survey, cdr)
    survey, visits = stage("survey dates and visits", query_survey_visits, cdr)
    cohorts = {}
    for name, spec in p3_specs().items():
        pop, _ = t39.build_cohort(pop_raw, codes_raw, sr, survey, visits, spec)
        cohorts[name] = int_indexed(pop[["d0", "age", "sex", "y_sr", "y_code", "y_inv"]])
    return cohorts


# ----------------------------------------------------------------------------------------------------------
# Part A: Long COVID trajectories
# ----------------------------------------------------------------------------------------------------------

def load_model(path=None):
    path = path or MODEL
    need(path, "upload model/longcovid.json; it installs as ~/unm/src/longcovid.json")
    return json.load(open(path))


def lc_groups(cohort: pd.DataFrame, F: pd.DataFrame, model: dict) -> pd.DataFrame:
    """Chart band at day 90 from the deployed model and the sym_count_ge2 feature, per landmark-cohort member."""
    feats = [f for f in model["features"] if float(f.get("weight", 0)) != 0.0]
    ids = [f["id"] for f in feats]
    missing = [i for i in ids + ["sym_count_ge2"] if i not in F.columns]
    if missing:
        raise RuntimeError(f"{FEATURES} lacks model features: {', '.join(missing[:10])}")
    X = F.reindex(cohort.index)[ids]
    if X.isna().any().any():
        raise RuntimeError(f"{FEATURES} does not cover every landmark cohort member")
    score = model["intercept"] + X.to_numpy(float) @ np.array([float(f["weight"]) for f in feats])
    pts = model["calibration"]["points"]
    prob = np.interp(score, [p[0] for p in pts], [p[1] for p in pts])   # clamps at the ends, as score_fhir.calibrate
    typical_max = next(b["max_probability"] for b in model["risk_bands"] if b["name"] == "Typical")
    return pd.DataFrame({"hi": prob > typical_max,
                         "sym": F.reindex(cohort.index)["sym_count_ge2"].to_numpy().astype(float) >= 1}, index=cohort.index)


def _ci(x: np.ndarray, dec: int):
    m, n = float(np.mean(x)), len(x)
    se = float(np.std(x, ddof=1)) / np.sqrt(n) if n > 1 else 0.0
    return round(m, dec), round(m - 1.96 * se, dec), round(m + 1.96 * se, dec)


A_DEC = {"steps": 0, "sedentary": 1, "asleep": 1, "rest_hr": 1}


def lc_trajectory(pw: pd.DataFrame, groups: pd.DataFrame):
    """pw: person_id, week, measure, n_days, value (person-week means) plus 'eligible' rows; groups: hi, sym."""
    pw = pw.copy()
    pw["person_id"] = int_ids(pw.person_id).to_numpy()
    groups = int_indexed(groups)
    elig = pd.Index(pw.loc[pw.measure == "eligible", "person_id"].unique(), name="person_id")
    elig = elig[elig.isin(groups.index)]
    g = groups.loc[elig]
    member = {"all": pd.Series(True, index=elig), "band_high_or_elevated": g.hi, "band_typical": ~g.hi,
              "sym_count_ge2": g.sym, "sym_count_lt2": ~g.sym}
    N = {k: int(v.sum()) for k, v in member.items()}
    kept = list(A_GROUPS)
    d = pw[(pw.measure != "eligible") & pw.person_id.isin(elig)].copy()
    d["week"] = pd.to_numeric(d.week).astype("int64")
    d["value"] = pd.to_numeric(d.value).astype(float)
    d = d[d.week.isin(WEEKS) & (pd.to_numeric(d.n_days) >= MIN_WEEK_DAYS) & d.value.notna()]
    rows = []
    by = {k: v for k, v in d.groupby(["week", "measure"])}
    count_cols = ["n_group"] + [f"n_{m}" for m, _ in A_MEASURES]
    for w in WEEKS:
        block = {gname: {"week": f"week {w:+d}", "days_from_index": f"{7 * w} to {7 * w + 6}", "group": gname,
                         "n_group": N[gname]} for gname in kept}
        for m, _ in A_MEASURES:
            sub = by.get((w, m))
            for gname in kept:
                x = (sub[sub.person_id.isin(member[gname][member[gname]].index)].value.to_numpy()
                     if sub is not None else np.array([]))
                mean, lo, hi = _ci(x, A_DEC[m]) if len(x) > 1 else (np.nan, np.nan, np.nan)
                block[gname].update({f"n_{m}": len(x), f"{m}_mean": mean, f"{m}_ci_low": lo, f"{m}_ci_high": hi})
        raw = pd.DataFrame(block.values()).set_index("group", drop=False)
        safe = protect(raw, count_cols, complements=[("n_group", f"n_{m}") for m, _ in A_MEASURES])
        # Each split partitions the displayed all-group count in this same week and table.
        for a, b in A_SPLITS:
            for col in count_cols:
                pair = pd.DataFrame({"total": [raw.loc["all", col]], "a": [raw.loc[a, col]], "b": [raw.loc[b, col]]})
                pair = protect(pair, ["total", "a", "b"], complements=[("total", "a"), ("total", "b")])
                for group, key in (("all", "total"), (a, "a"), (b, "b")):
                    if isinstance(pair.loc[0, key], str):
                        safe.loc[group, col] = pair.loc[0, key]
                # A completion complement may have hidden a part already; its sibling must not reveal it.
                if not isinstance(safe.loc["all", col], str):
                    hidden = [g for g in (a, b) if isinstance(safe.loc[g, col], str)]
                    if len(hidden) == 1:
                        other = b if hidden[0] == a else a
                        safe.loc[other, col] = SECONDARY
        rows += safe.to_dict("records")
    cols = ["week", "days_from_index", "group", "n_group"] + [c for m, _ in A_MEASURES
                                                              for c in (f"n_{m}", f"{m}_mean", f"{m}_ci_low", f"{m}_ci_high")]
    tab = pd.DataFrame(rows, columns=cols)
    present = [m for m, _ in A_MEASURES if (d.measure == m).any()]
    n_sup = sum(tab[f"n_{m}"].map(lambda x: isinstance(x, str)).sum() for m, _ in A_MEASURES)
    return tab, {"suppressed_count_cells": int(n_sup), "kept_groups": kept, "present": present}


# ----------------------------------------------------------------------------------------------------------
# Parts B and C: Paper 3 cohorts
# ----------------------------------------------------------------------------------------------------------

def int_ids(values) -> pd.Index:
    """Person ids as a plain int64 Index. BigQuery returns nullable Int64 (and sometimes object) ids, and pandas
    refuses to compare or align Series whose indexes differ in dtype, so every person index is normalized here."""
    v = pd.to_numeric(pd.Series(np.asarray(values, dtype=object)), errors="coerce")
    if v.isna().any():
        raise RuntimeError("person ids contain missing or non-numeric values")
    return pd.Index(v.astype("int64").to_numpy(), name="person_id")


def int_indexed(df: pd.DataFrame) -> pd.DataFrame:
    """Copy of df with an int64 person index and no duplicated people (first row kept)."""
    out = df.copy()
    out.index = int_ids(out.index)
    return out[~out.index.duplicated()]


def prepare_summaries(summ: pd.DataFrame, cohorts: dict) -> pd.DataFrame:
    """summ: per-person rows from the Parts B/C query (any order, extra people); cohorts already int64-indexed."""
    s = summ.copy()
    s["person_id"] = int_ids(s.person_id).to_numpy()
    s = s.drop_duplicates("person_id").set_index("person_id")
    for c in s.columns:
        if c != "d0":
            s[c] = pd.to_numeric(s[c], errors="coerce").astype(float)
    s["d0"] = pd.to_datetime(s.d0.astype(str), errors="coerce").dt.normalize()
    s["steps_cv"] = s.steps_sd / s.steps_mean
    s["sed_share"] = s.sed_sum / s.awake_sum
    for c in ("n_sleep_days", "n_hr_days"):
        s[c] = s[c].fillna(0)
    # day 0 must be the cohort's day 0 (same survey CTE); drop the rare mismatch, fail if it is not rare
    d0 = pd.concat([c.d0 for c in cohorts.values()])
    d0 = pd.Series(pd.to_datetime(d0.astype(str), errors="coerce").dt.normalize().to_numpy(), index=int_ids(d0.index))
    d0 = d0[~d0.index.duplicated()]
    common = s.index.intersection(d0.index)
    # compare positionally after explicit reindexing, never through label alignment
    a = s["d0"].reindex(common).to_numpy(dtype="datetime64[ns]")
    b = d0.reindex(common).to_numpy(dtype="datetime64[ns]")
    bad = common[~(a == b)]
    if len(common) and len(bad) > 0.01 * len(common):
        raise RuntimeError("day 0 in the wearables query differs from the Paper 3 cohort day 0 for more than 1% of people")
    return s.drop(index=bad)


def group_masks(pop: pd.DataFrame, index: pd.Index) -> dict:
    p = pop.reindex(index)
    inc = index.isin(pop.index)
    ysr, ycd = p.y_sr.fillna(0).to_numpy() == 1, p.y_code.fillna(0).to_numpy() == 1
    return {"coded": inc & ysr & ycd, "uncoded": inc & ysr & ~ycd, "all_sr": inc & ysr, "nonrep": inc & ~ysr}


def wquantile(x, w, qs):
    o = np.argsort(x)
    x, w = x[o], w[o]
    cw = (np.cumsum(w) - 0.5 * w) / w.sum()
    return np.interp(qs, cw, x)


QS = [0.10, 0.25, 0.50, 0.75, 0.90]


def profile_stats(x, unit, dec, w=None):
    if w is None:
        mean, lo, hi = _ci(x, dec)
        q = np.quantile(x, QS)
    else:
        w = w / w.sum()
        m = float(np.sum(w * x))
        var = float(np.sum(w * (x - m) ** 2))
        n_eff = 1.0 / float(np.sum(w ** 2))
        se = float(np.sqrt(var / max(n_eff - 1.0, 1.0)))   # Kish effective sample size
        mean, lo, hi = round(m, dec), round(m - 1.96 * se, dec), round(m + 1.96 * se, dec)
        q = wquantile(x, w, QS)
    q = [float(np.round(v / unit) * unit) for v in q]
    return {"mean": mean, "ci_low": lo, "ci_high": hi, "p10": q[0], "p25": q[1], "p50": q[2], "p75": q[3], "p90": q[4]}


def strata(pop, ids):
    p = pop.loc[ids]
    return p.age.map(_age_band).astype(str) + "|" + p.sex.astype(str)


def std_weights(pop, ref_ids, tgt_ids):
    ref = strata(pop, ref_ids).value_counts(normalize=True)
    st = strata(pop, tgt_ids)
    tgt = st.value_counts(normalize=True)
    return st.map(ref / tgt).fillna(0.0).to_numpy(float)


def winsor_z(X: np.ndarray):
    lo, hi = np.nanpercentile(X, 1, axis=0), np.nanpercentile(X, 99, axis=0)
    Xc = np.clip(X, lo, hi)
    sd = Xc.std(axis=0)
    sd[sd == 0] = 1.0
    return (Xc - Xc.mean(axis=0)) / sd


def kmeans_profiles(Z: np.ndarray):
    from sklearn.cluster import KMeans
    from sklearn.metrics import silhouette_score
    sil, fits = {}, {}
    for k in K_RANGE:
        if len(Z) <= k:
            continue
        km = KMeans(n_clusters=k, n_init=N_INIT, random_state=SEED).fit(Z)
        fits[k] = km.labels_
        ss = SIL_SAMPLE if len(Z) > SIL_SAMPLE else None
        sil[k] = float(silhouette_score(Z, km.labels_, sample_size=ss, random_state=SEED))
    if not sil:
        raise RuntimeError("Part C population too small for k-means")
    best = max(sil, key=lambda k: (sil[k], -k))
    ids, counts = np.unique(fits[best], return_counts=True)
    remap = {old: new + 1 for new, old in enumerate(ids[np.argsort(-counts, kind="stable")])}
    labels = np.array([remap[v] for v in fits[best]])
    return labels, best, sil, 0


def p3_analysis(cohorts: dict, summ: pd.DataFrame):
    """Parts B and C with independent within-table count protection."""
    cohorts = {c: int_indexed(pop) for c, pop in cohorts.items()}
    s = prepare_summaries(summ, cohorts)
    universe = pd.Index(sorted(set().union(*[set(c.index) for c in cohorts.values()])), dtype="int64", name="person_id")
    S = s.reindex(universe)
    has = {"n_act_days": S.n_act_days.fillna(0).to_numpy(), "n_sleep_days": S.n_sleep_days.fillna(0).to_numpy(),
           "n_hr_days": S.n_hr_days.fillna(0).to_numpy()}
    gm = {c: group_masks(pop, universe) for c, pop in cohorts.items()}
    avail = {}
    for name, col, acol, mind, _, _ in B_MEASURES:
        avail[name] = (has[acol] >= mind) & (has["n_act_days"] >= B_MIN_ACT) & S[col].notna().to_numpy()
    # Part C population and clustering
    feat_cols = [f for f, _, _ in C_FEATURES]
    inC = ((has["n_act_days"] >= C_MIN_ACT) & (has["n_sleep_days"] >= C_MIN_SLEEP) & (has["n_hr_days"] >= C_MIN_HR)
           & S[feat_cols].notna().all(axis=1).to_numpy() & np.isfinite(S[feat_cols].to_numpy(float)).all(axis=1))
    cluster = np.zeros(len(universe), dtype=int)
    best, sil, merges = None, {}, 0
    if inC.sum() > min(K_RANGE):
        labels, best, sil, merges = kmeans_profiles(winsor_z(S.loc[inC, feat_cols].to_numpy(float)))
        cluster[inC] = labels
    ks = sorted(set(cluster[inC])) if best else []
    # Part B table: coded and never-coded self-reporters partition all self-reporters.
    rows = []
    for c, pop in cohorts.items():
        for name, col, _, _, unit, dec in B_MEASURES:
            masks = {g: gm[c][g] & avail[name] for g in ("coded", "uncoded", "all_sr", "nonrep")}
            counts = pd.DataFrame([{g: int(m.sum()) for g, m in masks.items()}])
            shown = protect(counts, list(masks), complements=[("all_sr", "coded"), ("all_sr", "uncoded")]).iloc[0]
            for g, glabel in B_GROUPS:
                key = "nonrep" if g == "nonrep_std" else g
                rec = {"condition": c, "group": glabel, "measure": name, "n_people": shown[key]}
                stats = {k: np.nan for k in ("mean", "ci_low", "ci_high", "p10", "p25", "p50", "p75", "p90")}
                m = masks[key]
                if m.sum() > 1:
                    x = S.loc[m, col].to_numpy(float)
                    if g == "nonrep_std":
                        ref = masks["all_sr"]
                        if ref.any():
                            w = std_weights(pop, universe[ref], universe[m])
                            if np.count_nonzero(w) > 1:
                                stats = profile_stats(x, unit, dec, w)
                    else:
                        stats = profile_stats(x, unit, dec)
                rows.append({**rec, **stats})
    profiles = pd.DataFrame(rows)

    # Part C cluster summaries have no participant-count column or external totals.
    n_c = int(inC.sum())
    crow = []
    for k, cname in [(None, "all")] + [(k, f"cluster {k}") for k in ks]:
        m = inC if k is None else inC & (cluster == k)
        share = round(float(m.sum()) / n_c, 3) if n_c else np.nan
        rec = {"cluster": cname, "share_of_population": share}
        for f, _, dec in C_FEATURES:
            rec[f] = round(float(S.loc[m, f].mean()), dec) if m.sum() > 1 else np.nan
        crow.append(rec)
    clusters = pd.DataFrame(crow)
    brow = []
    for c in cohorts:
        for g, glabel in C_GROUPS:
            total = int((inC & gm[c][g]).sum())
            parts = pd.DataFrame({"n_people": [int((inC & gm[c][g] & (cluster == k)).sum()) for k in ks]})
            parts = protect(parts, ["n_people"], partition=True)
            total_shown = protect(pd.DataFrame({"n_people": [total]}), ["n_people"]).n_people.iloc[0]
            brow.append({"condition": c, "group": glabel, "cluster": "all", "n_people": total_shown, "share_of_group": np.nan})
            for i, k in enumerate(ks):
                count = parts.n_people.iloc[i]
                share = (round(count / total_shown, 3)
                         if not isinstance(count, str) and not isinstance(total_shown, str) and total_shown else np.nan)
                brow.append({"condition": c, "group": glabel, "cluster": f"cluster {k}", "n_people": count, "share_of_group": share})
    by_group = pd.DataFrame(brow)
    person = S.assign(in_part_c=inC, cluster=cluster)
    present = [name for name, col, *_ in B_MEASURES if avail[name].any()]
    info = {"best_k": best, "silhouette": sil, "merges": merges, "n_clusters": len(ks), "present": present}
    return profiles, clusters, by_group, person, info


# ----------------------------------------------------------------------------------------------------------

def summary_table(a_info, c_info, seconds):
    items = [
        ("Part A population", "landmark cohort members with 30+ activity_summary days in days -365 to -1 and 30+ in days 0 to 180 (Task 38 definition)"),
        ("Part A week", "week w = days 7w to 7w+6 from the COVID-19 index; a person contributes with 1+ valid day"),
        ("Part A groups released", ", ".join(a_info["kept_groups"]) or "none"),
        ("Part A protected measure-count cells", f"{a_info['suppressed_count_cells']} cells"),
        ("Part A measures with any data (a missing one points to a zone_name or is_main_sleep value mismatch)",
         ", ".join(a_info["present"]) or "none"),
        ("Part B measures with any data", "; ".join(c_info["present"]) or "none"),
        ("Part B population", f"Paper 3 cohort members with {B_MIN_ACT}+ activity days (steps > 0) in days -365 to -1; "
                              f"sleep and heart-rate rows need {B_MIN_SLEEP}+ days"),
        ("Part C population", f"union of the three Paper 3 cohorts with {C_MIN_ACT}+ activity, {C_MIN_SLEEP}+ main-sleep, "
                              f"and {C_MIN_HR}+ heart-rate days in days -365 to -1"),
        ("Part C chosen k", f"k={c_info['best_k']}" if c_info["best_k"] else "not run (population too small)"),
    ]
    for k, v in sorted(c_info["silhouette"].items()):
        items.append((f"Part C silhouette k={k}", f"{v:.3f}"))
    items += [("Part C clusters released", f"{c_info['n_clusters']} clusters"),
              ("Part C cluster shares rounded to", "0.001 of the population"),
              ("k-means settings", f"k {K_RANGE.start}-{K_RANGE.stop - 1}, {N_INIT} starts, seed {SEED}, "
                                   f"features winsorized at 1st/99th percentiles and z-scored"),
              ("wall-clock seconds", f"{int(seconds)} s")]
    return pd.DataFrame(items, columns=["item", "value"])


def export(tables: dict):
    os.makedirs(EXPORT, exist_ok=True)
    for name, df in tables.items():
        check_exportable(df)
        df.to_csv(os.path.join(EXPORT, f"{name}.csv"), index=False)
        print(f"exported {name} ({len(df)} rows)", flush=True)


def main(lc_loader=None, p3_loader=None):
    t0 = time.time()
    model = load_model()
    cohort = pd.read_parquet(need(os.path.join(OUT, "cohort_v2.parquet"), "Task 01 cohort"))
    F = pd.read_parquet(need(os.path.join(OUT, FEATURES), "Task 35 features"))
    cohort = int_indexed(cohort[cohort.landmark_eligible == 1])
    F = int_indexed(F)
    groups = lc_groups(cohort, F, model)
    del F
    pw = lc_loader() if lc_loader else stage("Part A wearables query", query_lc, cohort)
    os.makedirs(OUT, exist_ok=True)
    pw.to_parquet(os.path.join(OUT, "t48_lc_person_weeks.parquet"))
    traj, a_info = lc_trajectory(pw, groups)
    print("Part A done", flush=True)
    if p3_loader:
        cohorts, summ = p3_loader()
    else:
        cohorts = load_p3_cohorts()
        summ = stage("Parts B and C wearables query", query_p3_wearables)
    profiles, clusters, by_group, person, c_info = stage("Parts B and C analysis", p3_analysis, cohorts, summ)
    person.to_parquet(os.path.join(OUT, "t48_p3_wearables.parquet"))
    print("Parts B and C done", flush=True)
    tables = {"t48_lc_trajectory": traj, "t48_selfreport_profiles": profiles, "t48_clusters": clusters,
              "t48_cluster_by_group": by_group}
    tables["t48_summary"] = summary_table(a_info, c_info, time.time() - t0)
    export(tables)
    print("Task 48 finished", flush=True)
    return {"tables": tables, "a_info": a_info, "c_info": c_info}


if __name__ == "__main__":
    main()
