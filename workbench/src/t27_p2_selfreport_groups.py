"""Task 27 (Paper 2): self-reported diagnosis vs EHR code by race and ethnicity, age band, and EHR depth.

Runs inside the All of Us Workbench (bash ~/unm/bin/unm.sh run 27).
Population: as Task 26 (active adult EHR patients, women and men, who took the Personal and Family Health
History or Personal Medical History survey). Women and men are pooled; endometriosis is among women.
Exports: ~/unm/export/27/
  t27_selfreport_by_group: one row per condition, axis (race_eth, age_band, ehr_depth), and group, with the
      Task 26 columns (respondents, self-report ever and current, coded, overlaps; conditional shares from
      rounded counts). Every group of an axis is listed (no overall row). Suppression: primary;
      complementary within the row; partition within each condition x axis block because the different
      axes in this table enumerate the same population. No check uses another table.
  ehr_depth: years from the first EHR condition record to the survey (earliest survey_end_date of the
      Personal and Family Health History or Personal Medical History), in bands: record starts after the
      survey, under 2, 2 to 4, 5 to 9, 10 or more years; and no condition records at all.
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
import t25_p2_coded_shares as t25  # noqa: E402
import t26_p2_selfreport as t26  # noqa: E402
from aou_safe import MAX_SUPPRESSED, SECONDARY, check_exportable, protect  # noqa: E402

EXPORT = os.path.expanduser("~/unm/export/27")
COLS = ["n_respondents", "n_self_report", "n_self_report_current", "n_coded", "n_both", "n_both_current"]
DEPTH = ["no condition records", "record starts after survey", "under 2 years", "2 to 4 years", "5 to 9 years",
         "10 years or more"]


def query_depth(cdr):
    from google.cloud import bigquery
    client = bigquery.Client()
    return client.query(f"""
        WITH s AS (
          SELECT sc.person_id, MIN(sc.survey_end_date) AS survey_d FROM `{cdr}.survey_conduct` sc
          JOIN `{cdr}.concept` c ON sc.survey_concept_id = c.concept_id
          WHERE LOWER(c.concept_name) LIKE '%personal and family health history%'
             OR LOWER(c.concept_name) LIKE '%personal medical history%'
          GROUP BY 1),
        e AS (SELECT person_id, MIN(condition_start_date) AS first_d FROM `{cdr}.condition_occurrence` GROUP BY 1)
        SELECT s.person_id, DATE_DIFF(s.survey_d, e.first_d, DAY) AS depth_days
        FROM s JOIN e USING (person_id)
    """).to_dataframe()


def depth_band(days):
    if pd.isna(days):
        return DEPTH[0]
    if days < 0:
        return DEPTH[1]
    y = days / 365.25
    return DEPTH[2] if y < 2 else DEPTH[3] if y < 5 else DEPTH[4] if y < 10 else DEPTH[5]


def group_table(pop_all, pop, codes, sr, resp_ids):
    """pop_all: every active patient (all sexes; Task 25's population); pop: women and men."""
    blocks = []
    for cond, qid in t26.FIRST_TOLD.items():
        keys = t26.CODE_KEY.get(cond, [cond])
        coded = set(codes.loc[codes.cond.isin(keys), "person_id"])
        ever = set(sr.loc[sr.q == qid, "person_id"])
        cur = set().union(*[set(sr.loc[(sr.q == q) & (sr.a == a), "person_id"]) for q, a in t26.CURRENT[cond]]) & ever
        sub = pop[pop.sex == "Female"] if cond == "endometriosis" else pop
        condition_blocks = []
        for axis in ("race_eth", "age_band", "ehr_depth"):
            rows = []
            groups = DEPTH if axis == "ehr_depth" else sorted(sub[axis].unique())
            for g in groups:
                ids = set(sub.loc[sub[axis] == g, "person_id"]) & resp_ids
                rows.append({"condition": cond, "population": "women" if cond == "endometriosis" else "women and men",
                             "axis": axis, "group": g, "n_respondents": len(ids), "n_self_report": len(ids & ever),
                             "n_self_report_current": len(ids & cur), "n_coded": len(ids & coded),
                             "n_both": len(ids & ever & coded), "n_both_current": len(ids & cur & coded),
                             "n_neither": len(ids - ever - coded)})
            raw = pd.DataFrame(rows)
            out = protect(raw, COLS, complements=[
                ("n_respondents", "n_self_report"), ("n_respondents", "n_coded"),
                ("n_self_report", "n_self_report_current"), ("n_self_report", "n_both"), ("n_coded", "n_both"),
                ("n_self_report_current", "n_both_current"), ("n_both", "n_both_current"), ("n_coded", "n_both_current")])
            for i, r in raw.iterrows():
                if 0 < r.n_neither <= MAX_SUPPRESSED and all(
                        not isinstance(out.at[i, c], str) for c in ("n_respondents", "n_self_report", "n_coded", "n_both")):
                    col = next(c for c in ("n_both", "n_coded", "n_self_report", "n_respondents") if raw.at[i, c] > 0)
                    out.at[i, col] = SECONDARY
            condition_blocks.append((raw, out))
        for raw, out in condition_blocks:
            available = [col for col in COLS if any(
                other is not out and other_raw[col].sum() == raw[col].sum()
                and not other[col].map(lambda v: isinstance(v, str)).any()
                for other_raw, other in condition_blocks)]
            out = protect_partition_again(out, raw, available)
            blocks.append(out[["condition", "population", "axis", "group"] + COLS])
    out = pd.concat(blocks, ignore_index=True)
    out["p_code_given_self_report"] = [t26._ratio(b, s) for b, s in zip(out.n_both, out.n_self_report)]
    out["p_code_given_current_self_report"] = [t26._ratio(b, s) for b, s in zip(out.n_both_current, out.n_self_report_current)]
    out["p_self_report_given_code"] = [t26._ratio(b, c) for b, c in zip(out.n_both, out.n_coded)]
    return out


def protect_partition_again(out, raw, cols):
    """Protect columns whose totals are available from another complete, shown axis in this table."""
    for col in cols:
        while True:
            h = out[col].map(lambda v: isinstance(v, str))
            need = h.sum() >= 1 and (h.sum() < 2 or raw.loc[h, col].sum() <= MAX_SUPPRESSED)
            shown = raw.loc[~h & (raw[col] > 0), col]
            if not need or shown.empty:
                break
            out.at[shown.idxmin(), col] = SECONDARY
    return out


def main(loader=None):
    if loader:
        pop_raw, codes_raw, sr, resp, depth = loader()
    else:
        cdr = subprocess.check_output(["wb", "resolve", f"--id={t25.CDR_ID}"], text=True).strip()
        pop_raw, codes_raw, _ = t25.query(cdr)
        print("querying survey answers and EHR depth", flush=True)
        sr, resp, _ = t26.query_survey(cdr)
        depth = query_depth(cdr)
    print("data loaded", flush=True)
    pop_all, codes = t26.prepare(pop_raw, codes_raw)
    pop_all = pop_all.merge(depth, on="person_id", how="left")
    pop_all["ehr_depth"] = pop_all.depth_days.map(depth_band)
    pop = pop_all[pop_all.sex.isin(t26.SEXES)]
    srp = sr[sr.person_id.isin(pop.person_id)]
    resp_ids = (set(resp.person_id) & set(pop.person_id)) | set(srp.person_id)
    os.makedirs(EXPORT, exist_ok=True)
    df = group_table(pop_all, pop, codes, srp, resp_ids)
    check_exportable(df)
    df.to_csv(os.path.join(EXPORT, "t27_selfreport_by_group.csv"), index=False)
    print(f"exported t27_selfreport_by_group ({len(df)} rows)", flush=True)
    print("Task 27 finished", flush=True)


if __name__ == "__main__":
    main()
