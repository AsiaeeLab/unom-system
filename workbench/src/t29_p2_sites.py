"""Task 29 (Paper 2): variation across health systems in coding among self-reported diagnoses.

Runs inside the All of Us Workbench (bash ~/unm/bin/unm.sh run 29).
Population: Task 26 respondents (active adult EHR patients, women and men, who took the Personal and Family
Health History or Personal Medical History survey). Each patient is assigned to the EHR site (src_id) that
contributed most of their visits from 2021-07-01 to 2023-06-30 (shifted dates); participant-mediated EHR
sources are not health systems and are excluded.
Export: ~/unm/export/29/t29_site_quantiles.csv. For each condition, among sites with at least MIN_SITE_N current
self-reporters of that condition (a precision rule, not a disclosure rule: each site's share then has a standard
error of at most 0.07; the relative measure also needs MIN_SITE_N for each anchor at the site): the number of such
sites (as text) and the 10th, 25th, 50th, 75th, and 90th percentiles across
sites of (a) the share coded among current self-reporters and (b) that share relative to the mean of the
site's two anchor shares. Only quantiles across sites are exported (as Paper 1's t01_site_coding); no site
identifier and no per-site count leaves the Workbench.
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
from aou_safe import check_exportable  # noqa: E402

EXPORT = os.path.expanduser("~/unm/export/29")
ANCHORS = ["hypertension", "diabetes_type2"]
QS = [0.10, 0.25, 0.50, 0.75, 0.90]
MIN_SITE_N = 50   # current self-reporters per site and condition (precision of a site share, not disclosure)
MIN_SITES = 5     # quantiles across fewer sites are not reported (a 10th percentile needs several sites)


def query_site(cdr):
    from google.cloud import bigquery
    client = bigquery.Client()
    return client.query(f"""
        WITH v AS (
          SELECT vo.person_id, x.src_id, COUNT(*) AS n
          FROM `{cdr}.visit_occurrence` vo
          JOIN `{cdr}.visit_occurrence_ext` x ON vo.visit_occurrence_id = x.visit_occurrence_id
          WHERE vo.visit_start_date BETWEEN '2021-07-01' AND '2023-06-30'
            AND NOT STARTS_WITH(LOWER(x.src_id), 'participant mediated')
          GROUP BY 1, 2)
        SELECT person_id, ARRAY_AGG(src_id ORDER BY n DESC, src_id LIMIT 1)[OFFSET(0)] AS site
        FROM v GROUP BY person_id
    """).to_dataframe()


def site_table(pop, codes, sr, resp_ids, site):
    p = pop[pop.person_id.isin(resp_ids)].merge(site, on="person_id")
    rows = []
    for cond, qid in t26.FIRST_TOLD.items():
        keys = t26.CODE_KEY.get(cond, [cond])
        coded = set(codes.loc[codes.cond.isin(keys), "person_id"])
        ever = set(sr.loc[sr.q == qid, "person_id"])
        cur = set().union(*[set(sr.loc[(sr.q == q) & (sr.a == a), "person_id"]) for q, a in t26.CURRENT[cond]]) & ever
        sub = p[p.sex == "Female"] if cond == "endometriosis" else p
        for s, g in sub.groupby("site"):
            ids = set(g.person_id) & cur
            rows.append({"condition": cond, "site": s, "n": len(ids), "coded": len(ids & coded)})
    d = pd.DataFrame(rows)
    d["ok"] = d.n >= MIN_SITE_N
    d["p"] = d.coded / d.n.where(d.n > 0)
    anc = d[d.condition.isin(ANCHORS)].pivot(index="site", columns="condition", values=["p", "ok"])
    anchor_p = anc["p"].where(anc["ok"].fillna(False).astype(bool)).mean(axis=1, skipna=False)
    out = []
    for cond, g in d.groupby("condition", sort=False):
        g = g[g.ok].copy()
        g["relative"] = g.p / g.site.map(anchor_p.where(anchor_p > 0))
        if len(g) < MIN_SITES:
            out.append({"condition": cond, "sites_included": f"fewer than {MIN_SITES} sites"})
            continue
        row = {"condition": cond, "sites_included": f"{len(g)} sites"}
        for q in QS:
            row[f"share_coded_p{int(q * 100)}"] = round(float(g.p.quantile(q)), 3)
        for q in QS:
            row[f"relative_to_anchors_p{int(q * 100)}"] = round(float(g.relative.quantile(q)), 3)
        out.append(row)
    return pd.DataFrame(out)


def main(loader=None):
    if loader:
        pop_raw, codes_raw, sr, resp, site = loader()
    else:
        cdr = subprocess.check_output(["wb", "resolve", f"--id={t25.CDR_ID}"], text=True).strip()
        pop_raw, codes_raw, _ = t25.query(cdr)
        print("querying survey answers and sites", flush=True)
        sr, resp, _ = t26.query_survey(cdr)
        site = query_site(cdr)
    print("data loaded", flush=True)
    pop_all, codes = t26.prepare(pop_raw, codes_raw)
    pop = pop_all[pop_all.sex.isin(t26.SEXES)]
    srp = sr[sr.person_id.isin(pop.person_id)]
    resp_ids = (set(resp.person_id) & set(pop.person_id)) | set(srp.person_id)
    os.makedirs(EXPORT, exist_ok=True)
    df = site_table(pop, codes, srp, resp_ids, site)
    check_exportable(df)
    df.to_csv(os.path.join(EXPORT, "t29_site_quantiles.csv"), index=False)
    print(f"exported t29_site_quantiles ({len(df)} rows)", flush=True)
    print("Task 29 finished", flush=True)


if __name__ == "__main__":
    main()
