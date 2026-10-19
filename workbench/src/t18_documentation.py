"""Task 18: documentation checks (any and incident), utilization adjustment, and a fixed-workload comparison.

Runs inside the All of Us Workbench (bash ~/unm/bin/unm.sh run 18).
Inputs : ~/unm/output/{cohort_v2,features_v2}.parquet; ~/unm/src/coding_fractions.json; condition codes (CDR)
Exports: ~/unm/export/18/
  t18_documentation: for five Long COVID-associated symptom clusters and four negative controls,
      the rate of a code in days 91-455 among the top 10% vs the bottom 50% of day-90 elastic-net
      scores; versions "any" (any code) and "incident" (no code of that cluster in days -365..90);
      among patients without a subsequent U09.9 only. Ratios only (no counts or denominators).
      Crude rate ratio with a bootstrap interval, and a Mantel-Haenszel rate ratio across 12 utilization strata
      (out_w0_ge4 x outpatient visits in days 31-90 [<2, 2-3, 4+] x emergency visit in days 31-90).
  t18_workload: coded recall and PPV at a fixed 5% review workload for the utilization model (M1),
      a symptom-count rule, the elastic net (M2), and M2 divided by the women-to-men coding ratio.
Event counts of 1-20 are suppressed with their ratios; shares are computed from rounded counts.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys

import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

try:
    import db_dtypes  # noqa: F401
except ImportError:
    pass

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import t02_features as t02  # noqa: E402
from aou_safe import SUPPRESSED, check_exportable  # noqa: E402
from t03_models import UTIL  # noqa: E402
from t13_landmarks import en_model, oof, r10  # noqa: E402

CDR_ID = os.environ.get("UNM_CDR_ID", "R2025Q4R6")
OUT = os.path.expanduser("~/unm/output")
EXPORT = os.path.expanduser("~/unm/export/18")
FEATURES = "features_v2.parquet"   # participant-level feature file in ~/unm/output (a rerun wrapper may change it)
HERE = os.path.dirname(os.path.abspath(__file__))
SEED = 20261002
N_BOOT = 200
LC = ["sym_fatigue", "sym_dyspnea", "sym_autonomic", "sym_cognitive", "sym_dizzy_syncope"]


def symptom_prefixes():
    return {f["id"]: [str(p) for p in f["icd10cm_prefix"]] for f in t02.REG["new_symptoms"] if "icd10cm_prefix" in f}


def cluster_count_w3(cohort, conds):
    c = t02._offset(conds, cohort.index_date)
    code = c.code.astype(str)
    n = pd.Series(0, index=cohort.index)
    for k, pre in symptom_prefixes().items():
        m = code.str.startswith(tuple(pre)) & (c.off >= 31) & (c.off <= 90)
        n += cohort.index.isin(t02._persons(c, m)).astype(int)
    return n.to_numpy()


def outcome_prefixes():
    pre = {f["id"]: [str(p) for p in f["icd10cm_prefix"]] for f in t02.REG["new_symptoms"] if f["id"] in LC}
    for f in t02.REG["face_validity"]["negative_control_outcomes"]:
        pre[f["id"]] = [str(p) for p in f["icd10cm_prefix"]]
    return pre


def load_conds(cohort, prefixes):
    from google.cloud import bigquery
    cdr = subprocess.check_output(["wb", "resolve", f"--id={CDR_ID}"], text=True).strip()
    lo = (cohort.index_date.min() - pd.Timedelta(days=366)).date().isoformat()
    hi = (cohort.index_date.max() + pd.Timedelta(days=456)).date().isoformat()
    regex = "^(" + "|".join(sorted({p for v in prefixes.values() for p in v})) + ")"
    cfg = bigquery.QueryJobConfig(query_parameters=[
        bigquery.ArrayQueryParameter("ids", "INT64", [int(x) for x in cohort.index]),
        bigquery.ScalarQueryParameter("lo", "DATE", lo), bigquery.ScalarQueryParameter("hi", "DATE", hi)])
    print("querying outcome condition codes", flush=True)
    return bigquery.Client().query(f"""
        SELECT co.person_id, co.condition_start_date AS d, REPLACE(UPPER(c.concept_code), '.', '') AS code
        FROM `{cdr}.condition_occurrence` co JOIN `{cdr}.concept` c ON co.condition_source_concept_id = c.concept_id
        WHERE c.vocabulary_id = 'ICD10CM' AND co.person_id IN UNNEST(@ids) AND co.condition_start_date BETWEEN @lo AND @hi
          AND REGEXP_CONTAINS(REPLACE(UPPER(c.concept_code), '.', ''), r'{regex}')
    """, job_config=cfg).to_dataframe()


def outcome_flags(cohort, conds, prefixes):
    """person x outcome: any code in days 91-455, and any code in days -365..90."""
    c = t02._offset(conds, cohort.index_date)
    code = c.code.astype(str)
    after, before = pd.DataFrame(index=cohort.index), pd.DataFrame(index=cohort.index)
    for k, pre in prefixes.items():
        m = code.str.startswith(tuple(pre))
        after[k] = cohort.index.isin(t02._persons(c, m & (c.off >= 91) & (c.off <= 455))).astype(int)
        before[k] = cohort.index.isin(t02._persons(c, m & (c.off >= -365) & (c.off <= 90))).astype(int)
    return after, before


def utilization_strata(F):
    w3 = np.where(F.out_w3_ge4 == 1, 2, np.where(F.out_w3_ge2 == 1, 1, 0))
    return (F.out_w0_ge4.to_numpy() * 6 + w3 * 2 + F.ed_w3_any.to_numpy()).astype(int)


def rr_crude(ev, grp):
    """grp: 1 top, 0 bottom. Rate ratio of events."""
    a, n1 = ev[grp == 1].sum(), (grp == 1).sum()
    b, n0 = ev[grp == 0].sum(), (grp == 0).sum()
    return (a / n1) / (b / n0) if a > 0 and b > 0 else np.nan


def rr_mh(ev, grp, strata):
    num = den = 0.0
    for s in np.unique(strata):
        k = strata == s
        a, n1 = ev[k & (grp == 1)].sum(), (k & (grp == 1)).sum()
        b, n0 = ev[k & (grp == 0)].sum(), (k & (grp == 0)).sum()
        N = n1 + n0
        if N == 0:
            continue
        num += a * n0 / N
        den += b * n1 / N
    return num / den if den > 0 and num > 0 else np.nan


def documentation_table(p, s, after, before, strata, kinds):
    """Ratios only, uncoded population only; no event counts or denominators are released."""
    rng = np.random.default_rng(SEED)
    hi, lo = p >= np.quantile(p, 0.90), p <= np.quantile(p, 0.50)
    keep = (s == 0) & (hi | lo)
    grp = hi[keep].astype(int)
    st = strata[keep]
    rows = []
    for k in after.columns:
        for version in ("any", "incident"):
            # incident: patients with any code of this cluster in days -365..90 are removed from both groups
            sel = np.ones(keep.sum(), bool) if version == "any" else (before[k].to_numpy()[keep] == 0)
            ev, g_, st_ = after[k].to_numpy()[keep][sel], grp[sel], st[sel]
            a, b = int(ev[g_ == 1].sum()), int(ev[g_ == 0].sum())
            rec = {"outcome": k, "kind": kinds[k], "version": version, "population": "uncoded"}
            if a > 0 and b > 0:
                boot_c, boot_m = [], []
                idx = np.arange(len(ev))
                for _ in range(N_BOOT):
                    i = rng.choice(idx, len(idx))
                    boot_c.append(rr_crude(ev[i], g_[i])); boot_m.append(rr_mh(ev[i], g_[i], st_[i]))
                rec.update({"rr": round(rr_crude(ev, g_), 1), "rr_lo": round(np.nanpercentile(boot_c, 2.5), 1),
                            "rr_hi": round(np.nanpercentile(boot_c, 97.5), 1), "rr_mh": round(rr_mh(ev, g_, st_), 1),
                            "rr_mh_lo": round(np.nanpercentile(boot_m, 2.5), 1),
                            "rr_mh_hi": round(np.nanpercentile(boot_m, 97.5), 1)})
            else:
                rec.update({c: SUPPRESSED for c in ("rr", "rr_lo", "rr_hi", "rr_mh", "rr_mh_lo", "rr_mh_hi")})
            rows.append(rec)
    return pd.DataFrame(rows)


def workload_table(y, rankings):
    rows = []
    for name, score in rankings.items():
        top = np.zeros(len(y), bool)
        top[np.argsort(-score, kind="stable")[: int(round(0.05 * len(y)))]] = True
        tp, k = int(y[top].sum()), int(top.sum())
        rows.append({"ranking": name, "workload": "top 5%",
                     "coded_recall": round(r10(tp) / r10(y.sum()), 3) if y.sum() else SUPPRESSED,
                     "ppv": round(r10(tp) / r10(k), 4) if k else SUPPRESSED})
    return pd.DataFrame(rows)


def main(loader=load_conds):
    cohort = pd.read_parquet(os.path.join(OUT, "cohort_v2.parquet"))
    cohort = cohort[cohort.landmark_eligible == 1].copy()
    cohort["index_date"] = pd.to_datetime(cohort.index_date)
    F = pd.read_parquet(os.path.join(OUT, FEATURES)).loc[cohort.index]
    feats = [c for c in F.columns if not c.startswith("yout_")]
    y = cohort.s.to_numpy().astype(int)
    p = oof(F[feats].to_numpy(float), y, make=en_model)
    prefixes = outcome_prefixes()
    kinds = {k: ("Long COVID-associated" if k in LC else "negative control") for k in prefixes}
    conds = loader(cohort, {**prefixes, **symptom_prefixes()})
    after, before = outcome_flags(cohort, conds, prefixes)
    doc = documentation_table(p, y, after, before, utilization_strata(F), kinds)

    util = [c for c in UTIL if c in F.columns]
    m1 = oof(F[util].to_numpy(float), y,
             make=lambda: make_pipeline(StandardScaler(), LogisticRegression(max_iter=2000, C=1.0)))   # M1 as in Task 03
    rule = cluster_count_w3(cohort, conds) + m1 / (m1.max() + 1e-9) * 0.5   # clusters coded in days 31-90; ties by M1
    cf = json.load(open(os.path.join(HERE, "coding_fractions.json")))
    fem = (cohort.sex == "Female").to_numpy()
    adj = p / np.where(fem, cf["sex"]["ever"]["ratio"], 1.0)
    work = workload_table(y, {"M1 utilization logistic": m1, "symptom-count rule": rule,
                              "M2 elastic net": p, "M2 adjusted (women-to-men ratio, ever)": adj})
    os.makedirs(EXPORT, exist_ok=True)
    for name, df in (("t18_documentation", doc), ("t18_workload", work)):
        check_exportable(df)
        df.to_csv(os.path.join(EXPORT, f"{name}.csv"), index=False)
        print(f"exported {name} ({len(df)} rows)", flush=True)
    print("Task 18 finished", flush=True)


if __name__ == "__main__":
    main()
