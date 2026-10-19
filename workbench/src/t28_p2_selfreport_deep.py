"""Task 28 (Paper 2): self-reported diagnosis vs EHR code by sex, among respondents with 5 or more years of
EHR condition records before the survey.

Runs inside the All of Us Workbench (bash ~/unm/bin/unm.sh run 28).
Population: Task 26 respondents (active adult EHR patients, women and men, who took the Personal and Family
Health History or Personal Medical History survey) whose first EHR condition record is 5 or more years
before the survey (Task 27's "5 to 9 years" and "10 years or more" bands together).
Export: ~/unm/export/28/t28_selfreport_deep_by_sex.csv, one row per condition and sex, Task 26 columns.
Suppression: primary, and complementary within the row (all nested pairs, as Task 26).
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
import t27_p2_selfreport_groups as t27  # noqa: E402
from aou_safe import MAX_SUPPRESSED, SECONDARY, check_exportable, protect  # noqa: E402

EXPORT = os.path.expanduser("~/unm/export/28")
COLS = t27.COLS
DEEP = ["5 to 9 years", "10 years or more"]


def counts(ids, ever, cur, coded):
    return {"n_respondents": len(ids), "n_self_report": len(ids & ever), "n_self_report_current": len(ids & cur),
            "n_coded": len(ids & coded), "n_both": len(ids & ever & coded), "n_both_current": len(ids & cur & coded),
            "n_neither": len(ids - ever - coded)}


def deep_table(pop, codes, sr, resp_ids):
    rows = []
    for cond, qid in t26.FIRST_TOLD.items():
        keys = t26.CODE_KEY.get(cond, [cond])
        coded = set(codes.loc[codes.cond.isin(keys), "person_id"])
        ever = set(sr.loc[sr.q == qid, "person_id"])
        cur = set().union(*[set(sr.loc[(sr.q == q) & (sr.a == a), "person_id"]) for q, a in t26.CURRENT[cond]]) & ever
        for sex in (["Female"] if cond == "endometriosis" else t26.SEXES):
            p = pop[pop.sex == sex]
            deep_ids = set(p.loc[p.ehr_depth.isin(DEEP), "person_id"]) & resp_ids
            row = {"condition": cond, "sex": sex, **counts(deep_ids, ever, cur, coded)}
            rows.append(row)
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
    out = out[["condition", "sex"] + COLS].copy()
    out.insert(2, "population", "5 or more years of EHR records before the survey")
    out["p_code_given_self_report"] = [t26._ratio(b, s) for b, s in zip(out.n_both, out.n_self_report)]
    out["p_code_given_current_self_report"] = [t26._ratio(b, s) for b, s in zip(out.n_both_current, out.n_self_report_current)]
    out["p_self_report_given_code"] = [t26._ratio(b, c) for b, c in zip(out.n_both, out.n_coded)]
    return out


def main(loader=None):
    if loader:
        pop_raw, codes_raw, sr, resp, depth = loader()
    else:
        cdr = subprocess.check_output(["wb", "resolve", f"--id={t25.CDR_ID}"], text=True).strip()
        pop_raw, codes_raw, _ = t25.query(cdr)
        print("querying survey answers and EHR depth", flush=True)
        sr, resp, _ = t26.query_survey(cdr)
        depth = t27.query_depth(cdr)
    print("data loaded", flush=True)
    pop_all, codes = t26.prepare(pop_raw, codes_raw)
    pop_all = pop_all.merge(depth, on="person_id", how="left")
    pop_all["ehr_depth"] = pop_all.depth_days.map(t27.depth_band)
    pop = pop_all[pop_all.sex.isin(t26.SEXES)]
    srp = sr[sr.person_id.isin(pop.person_id)]
    resp_ids = (set(resp.person_id) & set(pop.person_id)) | set(srp.person_id)
    os.makedirs(EXPORT, exist_ok=True)
    df = deep_table(pop, codes, srp, resp_ids)
    check_exportable(df)
    df.to_csv(os.path.join(EXPORT, "t28_selfreport_deep_by_sex.csv"), index=False)
    print(f"exported t28_selfreport_deep_by_sex ({len(df)} rows)", flush=True)
    print("Task 28 finished", flush=True)


if __name__ == "__main__":
    main()
