"""Task 01: Long COVID cohort v2 (U09.9 coding era) and coded-rate counts.

Runs inside the All of Us Workbench:  bash workbench/run.sh 01
- Participant-level cohort  -> ~/unm/output/cohort_v2.parquet   (never leaves Workbench)
- Suppressed aggregates     -> ~/unm/export/01/*.csv             (the only files to copy out)

"""

from __future__ import annotations

import os
import subprocess
import sys

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from aou_safe import SUPPRESSED, check_exportable, protect, rate  # noqa: E402

CDR_ID = os.environ.get("UNM_CDR_ID", "R2025Q4R6")
ERA_START = pd.Timestamp("2021-07-02")   # shifted date >= this keeps day 91 on/after 2021-10-01 in true time
LOOKBACK, LANDMARK, HORIZON = 365, 90, 455
OUT_DIR = os.path.expanduser("~/unm/output")
EXPORT_DIR = os.path.expanduser("~/unm/export/01")
SNOMED_PASC = ("1119303003", "1119304009", "1325161000000102")


# ----------------------------------------------------------------------------
# Data access (BigQuery). Only this section touches the CDR.
# ----------------------------------------------------------------------------

def load_from_cdr():
    from google.cloud import bigquery

    cdr = subprocess.check_output(["wb", "resolve", f"--id={CDR_ID}"], text=True).strip()
    client = bigquery.Client()
    print(f"CDR resolved ({CDR_ID}); querying events", flush=True)

    events_sql = f"""
    SELECT co.person_id, co.condition_start_date AS event_date,
      CASE
        WHEN c.vocabulary_id = 'ICD10CM' AND REPLACE(UPPER(c.concept_code), '.', '') = 'U071' THEN 'covid'
        WHEN c.vocabulary_id = 'ICD10CM' AND REPLACE(UPPER(c.concept_code), '.', '') = 'U099' THEN 'pasc_strict'
        ELSE 'pasc_snomed'
      END AS kind,
      x.src_id AS src_id
    FROM `{cdr}.condition_occurrence` co
    JOIN `{cdr}.concept` c ON co.condition_source_concept_id = c.concept_id
    LEFT JOIN `{cdr}.condition_occurrence_ext` x ON co.condition_occurrence_id = x.condition_occurrence_id
    WHERE (c.vocabulary_id = 'ICD10CM' AND REPLACE(UPPER(c.concept_code), '.', '') IN ('U071', 'U099'))
       OR (c.vocabulary_id = 'SNOMED' AND c.concept_code IN {SNOMED_PASC})
    """
    events = client.query(events_sql).to_dataframe()
    ids = sorted(events.loc[events.kind == "covid", "person_id"].unique().tolist())
    print(f"events loaded; querying person and observation_period for the COVID group", flush=True)

    param = bigquery.QueryJobConfig(
        query_parameters=[bigquery.ArrayQueryParameter("ids", "INT64", ids)]
    )
    persons = client.query(
        f"""
        SELECT p.*, sx.concept_name AS sex_at_birth_name, r.concept_name AS race_name,
               e.concept_name AS ethnicity_name
        FROM `{cdr}.person` p
        LEFT JOIN `{cdr}.concept` sx ON p.sex_at_birth_concept_id = sx.concept_id
        LEFT JOIN `{cdr}.concept` r ON p.race_concept_id = r.concept_id
        LEFT JOIN `{cdr}.concept` e ON p.ethnicity_concept_id = e.concept_id
        WHERE p.person_id IN UNNEST(@ids)
        """,
        job_config=param,
    ).to_dataframe()
    obs = client.query(
        f"""
        SELECT person_id, observation_period_start_date AS obs_start,
               observation_period_end_date AS obs_end
        FROM `{cdr}.observation_period`
        WHERE person_id IN UNNEST(@ids)
        """,
        job_config=param,
    ).to_dataframe()
    return events, persons, obs


# ----------------------------------------------------------------------------
# Cohort construction (pure pandas; unit-tested locally on synthetic frames).
# ----------------------------------------------------------------------------

def _sex(name) -> str:
    n = str(name or "").lower()
    if n.startswith("female"):
        return "Female"
    if n.startswith("male"):
        return "Male"
    return "Other/unknown"


def _race_eth(race, eth) -> str:
    r, e = str(race or "").lower(), str(eth or "").lower()
    if "hispanic or latino" in e and "not hispanic" not in e:
        return "Hispanic or Latino"
    if "more than one" in r:
        return "NH other or multiple"
    if r == "white":
        return "NH White"
    if r.startswith("black"):
        return "NH Black"
    if r == "asian":
        return "NH Asian"
    if r in ("", "none", "no matching concept") or "skip" in r or "prefer not" in r or "none of these" in r or "unknown" in r:
        return "Unknown"
    return "NH other or multiple"


def _age_band(age: float) -> str:
    if age < 40:
        return "18-39"
    if age < 50:
        return "40-49"
    if age < 60:
        return "50-59"
    if age < 70:
        return "60-69"
    return "70+"


def _first_after(ev: pd.DataFrame, kinds, index: pd.Series, lo_days: int, hi_days: int | None,
                 lo_inclusive: bool = False) -> pd.Series:
    """First event date per person with kind in kinds and offset in (lo, hi] days."""
    e = ev[ev.kind.isin(kinds)].merge(index.rename("index_date"), left_on="person_id", right_index=True)
    off = (e.event_date - e.index_date).dt.days
    keep = (off >= lo_days) if lo_inclusive else (off > lo_days)
    if hi_days is not None:
        keep &= off <= hi_days
    return e[keep].groupby("person_id").event_date.min()


def build_cohort(events: pd.DataFrame, persons: pd.DataFrame, obs: pd.DataFrame,
                 era_start=ERA_START, landmark=LANDMARK, horizon=HORIZON) -> tuple[pd.DataFrame, list]:
    events = events.copy()
    events["event_date"] = pd.to_datetime(events.event_date)
    obs = obs.copy()
    obs["obs_start"] = pd.to_datetime(obs.obs_start)
    obs["obs_end"] = pd.to_datetime(obs.obs_end)
    flow = []

    covid = events[events.kind == "covid"]
    flow.append(("01 any U07.1 code", covid.person_id.nunique()))

    in_era = covid if era_start is None else covid[covid.event_date >= era_start]
    first = in_era.sort_values("event_date").drop_duplicates("person_id")
    index = first.set_index("person_id").event_date
    site = first.set_index("person_id").src_id
    flow.append(("02 U07.1 in coding era", len(index)))

    pasc_kinds = ["pasc_strict", "pasc_snomed"]
    prior = _first_after(events, pasc_kinds, index, -100000, 0, lo_inclusive=True)
    index = index[~index.index.isin(prior.index)]
    flow.append(("03 no Long COVID code on or before index", len(index)))

    p = persons.set_index("person_id")
    if "birth_datetime" in p.columns and p.birth_datetime.notna().any():
        birth = pd.to_datetime(p.birth_datetime, utc=True).dt.tz_localize(None)
    else:
        birth = pd.to_datetime(p.year_of_birth.astype("Int64").astype(str) + "-07-01", errors="coerce")
    age = ((index - birth.reindex(index.index)).dt.days / 365.25)
    index = index[age >= 18]
    flow.append(("04 age 18+ at index", len(index)))

    o = obs.merge(index.rename("index_date"), left_on="person_id", right_index=True)
    covered = o[(o.obs_start <= o.index_date - pd.Timedelta(days=LOOKBACK))
                & (o.obs_end >= o.index_date + pd.Timedelta(days=horizon))].person_id.unique()
    index = index[index.index.isin(covered)]
    flow.append(("05 observed 365 days before to 455 days after", len(index)))

    coded_455 = _first_after(events, ["pasc_strict"], index, 0, horizon)
    early = _first_after(events, pasc_kinds, index, 0, landmark)
    landmark_ok = ~index.index.isin(early.index)
    flow.append(("06 no Long COVID code by day 90 (landmark cohort)", int(landmark_ok.sum())))

    s = _first_after(events, ["pasc_strict"], index, landmark, horizon)
    s_broad = _first_after(events, pasc_kinds, index, landmark, horizon)

    c = pd.DataFrame({"index_date": index})
    c["site"] = site.reindex(c.index).astype(str)
    c["age"] = age.reindex(c.index)
    c["age_band"] = c.age.map(_age_band)
    c["sex"] = p.reindex(c.index).get("sex_at_birth_name", pd.Series(index=c.index, dtype=object)).map(_sex)
    c["race_eth"] = [
        _race_eth(r, e)
        for r, e in zip(p.reindex(c.index).get("race_name", pd.Series(index=c.index, dtype=object)),
                        p.reindex(c.index).get("ethnicity_name", pd.Series(index=c.index, dtype=object)))
    ]
    c["shifted_year"] = c.index_date.dt.year
    c["coded_455"] = c.index.isin(coded_455.index).astype(int)
    c["days_to_code"] = (coded_455.reindex(c.index) - c.index_date).dt.days
    c["landmark_eligible"] = landmark_ok.astype(int)
    c["s"] = (c.index.isin(s.index) & (c.landmark_eligible == 1)).astype(int)
    c["s_broad"] = (c.index.isin(s_broad.index) & (c.landmark_eligible == 1)).astype(int)
    flow.append(("07 labeled positive: first U09.9 in days 91-455", int(c.s.sum())))
    flow.append(("08 broad label positive (U09.9 or SNOMED)", int(c.s_broad.sum())))
    flow.append(("09 any U09.9 in days 1-455 (coding-gap cohort)", int(c.coded_455.sum())))
    return c, flow


# ----------------------------------------------------------------------------
# Aggregation with suppression, including secondary suppression in partitions.
# ----------------------------------------------------------------------------

def _rate(num, den):
    if isinstance(num, str) or isinstance(den, str) or not den:
        return SUPPRESSED
    return round(num / den, 5)


def summarize(c: pd.DataFrame, flow: list) -> dict:
    tables = {}
    f = pd.DataFrame(flow, columns=["step", "n_people"])
    tables["t01_flow"] = protect(f, ["n_people"], partition=False)

    lm = c[c.landmark_eligible == 1]
    rows = []
    for axis in ["sex", "age_band", "race_eth"]:
        # Only counts needed for the coding-gap estimate and the label rate are
        # exported. The landmark denominator per group is not exported, because
        # its difference from the gap-cohort count would itself be a count.
        g_gap = c.groupby(axis).agg(n_gap_cohort=("coded_455", "size"), n_coded_455=("coded_455", "sum"))
        g_lm = lm.groupby(axis).agg(n_landmark=("s", "size"), n_s1=("s", "sum"))
        g = g_gap.join(g_lm, how="outer").fillna(0).reset_index().rename(columns={axis: "category"})
        prot = protect(g, ["n_gap_cohort", "n_coded_455", "n_s1"],
                       complements=[("n_gap_cohort", "n_coded_455"), ("n_landmark", "n_s1")])
        prot["p_coded_455"] = [rate(a, b, sa, sb) for a, b, sa, sb in
                               zip(g.n_coded_455, g.n_gap_cohort, prot.n_coded_455, prot.n_gap_cohort)]
        prot["p_s1"] = [rate(a, b, sa, 0) for a, b, sa in zip(g.n_s1, g.n_landmark, prot.n_s1)]
        prot = prot.drop(columns=["n_landmark"])
        prot.insert(0, "axis", axis)
        rows.append(prot)
    tables["t01_by_group"] = pd.concat(rows, ignore_index=True)

    y = lm.groupby("shifted_year").agg(n_landmark=("s", "size"), n_s1=("s", "sum")).reset_index()
    tables["t01_by_year"] = protect(y, ["n_landmark", "n_s1"], complements=[("n_landmark", "n_s1")])

    # Counts of sites (not of participants), stored as text so the participant
    # small-cell check does not apply to them.
    site_n = lm.groupby("site").agg(n=("s", "size"), pos=("s", "sum"))
    tables["t01_sites"] = pd.DataFrame({
        "measure": ["distinct EHR sites in landmark cohort",
                    "sites with more than 20 people",
                    "sites with more than 20 people and more than 20 positives"],
        "n_sites": [f"{site_n.shape[0]} sites", f"{int((site_n.n > 20).sum())} sites",
                    f"{int(((site_n.n > 20) & (site_n.pos > 20)).sum())} sites"],
    })

    # Coding by site: crude coded rate and observed/expected (indirectly
    # standardized for age band x sex) across sites with more than 20 coded and
    # more than 20 uncoded people. Only quantiles across sites are exported.
    gap = c.assign(stratum=c.age_band + "|" + c.sex)
    gap["expected"] = gap.stratum.map(gap.groupby("stratum").coded_455.mean())
    site_tab = gap.groupby("site").agg(n=("coded_455", "size"), coded=("coded_455", "sum"),
                                       expected=("expected", "sum"))
    ok = site_tab[(site_tab.coded > 20) & (site_tab.n - site_tab.coded > 20)]
    if len(ok) >= 5:
        qs = [0.10, 0.25, 0.50, 0.75, 0.90]
        tables["t01_site_coding"] = pd.DataFrame({
            "statistic": ["sites_included"] + [f"p{int(q * 100)}" for q in qs],
            "crude_coded_rate": [str(len(ok))] + [round(v, 4) for v in (ok.coded / ok.n).quantile(qs)],
            "observed_to_expected": [str(len(ok))] + [round(v, 3) for v in (ok.coded / ok.expected).quantile(qs)],
        })

    d = c.loc[c.coded_455 == 1, "days_to_code"].dropna()
    if len(d) > 20:
        q = d.quantile([0.10, 0.25, 0.50, 0.75, 0.90]).round(0)
        # Percentiles only: cumulative counts would reveal small increments.
        tables["t01_time_to_code"] = pd.DataFrame(
            {"statistic": ["p10", "p25", "p50", "p75", "p90"], "days_from_index_to_first_U09.9": q.values})
    return tables


def sensitivity(events, persons, obs) -> pd.DataFrame:
    rows = []
    for name, kw in [
        ("main: era, landmark 90, horizon 455", {}),
        ("no era restriction", {"era_start": None}),
        ("horizon 270", {"horizon": 270}),
        ("landmark 60", {"landmark": 60}),
    ]:
        c, _ = build_cohort(events, persons, obs, **kw)
        lm = c[c.landmark_eligible == 1]
        rows.append({"variant": name, "n_landmark": len(lm), "n_s1": int(lm.s.sum()),
                     "n_s1_broad": int(lm.s_broad.sum())})
    return protect(pd.DataFrame(rows), ["n_landmark", "n_s1", "n_s1_broad"], partition=False)


def export(tables: dict) -> None:
    os.makedirs(EXPORT_DIR, exist_ok=True)
    for name, df in tables.items():
        check_exportable(df)
        df.to_csv(os.path.join(EXPORT_DIR, f"{name}.csv"), index=False)
        print(f"exported {name}.csv ({len(df)} rows)", flush=True)


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    events, persons, obs = load_from_cdr()
    c, flow = build_cohort(events, persons, obs)
    c.to_parquet(os.path.join(OUT_DIR, "cohort_v2.parquet"))
    events.to_parquet(os.path.join(OUT_DIR, "covid_pasc_events.parquet"))
    print("cohort saved inside Workbench; building aggregate tables", flush=True)
    tables = summarize(c, flow)
    tables["t01_sensitivity"] = sensitivity(events, persons, obs)
    export(tables)
    print("Task 01 finished. Copy only the files in ~/unm/export/01/ out of Workbench.", flush=True)


if __name__ == "__main__":
    main()
