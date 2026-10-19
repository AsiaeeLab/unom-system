"""Task 30 (Paper 2 and app): chronic fatigue (ME/CFS) case-finding model trained on self-report.

Runs inside the All of Us Workbench (bash ~/unm/bin/unm.sh run 30).
Population: Task 26 survey respondents (active adult EHR patients who took the Personal and Family Health
History or Personal Medical History survey) aged 18 or older at the survey, with at least 1 EHR visit in
the year before the survey and no chronic fatigue code (G93.3x, R53.82) on or before the survey date.
Day 0 = earliest survey completion date. Features (features_cf.json): records in the 5 years (H) or 1
year (R) before day 0. Labels: y_sr, self-reported chronic fatigue (ever told, Task 26 definition);
y_code, a chronic fatigue code after day 0 (later documentation, the usual training label).
Split: random 80% training / 20% validation (seed 20261002).

Exports: ~/unm/export/30/
  t30_cohort: rounded counts of people, self-reporters, later-coded, and never-coded self-reporters, by split.
  t30_label_counts, t30_feature_label_counts: training-split totals and per-feature 2x2 tables with y_sr
      (feature eligible only if every cell exceeds 20; counts rounded up to 10). The deployable model is
      fit from these outside the Workbench (cf_model.fit_nb_eb).
  t30_calibration_bins: training-split score bins of that model (each with more than 20 positives and
      20 negatives): score range and mean, rounded n and positives.
  t30_metrics: validation-split performance of 4 models, each against 3 targets (self-report;
      self-reporters never coded; later code): AUROC, AUPRC, recall and PPV in the top 1/5/10%
      (suppressed when they imply 1-20 people), with bootstrap intervals for AUROC.
        nb_sr_exported  NB-EB fit from the rounded exported tables (identical to the app model)
        en_sr           elastic net, self-report label (participant-level reference; not exported)
        nb_code         NB-EB fit from exact training tables with the later-code label
        en_code         elastic net, later-code label
  t30_comparison: paired bootstrap difference (nb_sr_exported minus nb_code) in recall of never-coded
      self-reporters in the top 5% and 10%, and in AUROC for self-report.
  t30_by_sex: AUROC of nb_sr_exported for self-report among women and men.
  t30_codelist_labs, t30_codelist_drugs: resolved LOINC codes and RxNorm codes per feature (vocabulary).
"""

from __future__ import annotations

import os
import subprocess
import sys

import numpy as np
import pandas as pd
from sklearn.metrics import roc_auc_score

try:
    import db_dtypes  # noqa: F401
except ImportError:
    pass

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cf_model as cf  # noqa: E402
import t03_models  # noqa: E402
import t25_p2_coded_shares as t25  # noqa: E402
import t26_p2_selfreport as t26  # noqa: E402
from aou_safe import check_exportable, protect  # noqa: E402
from t01_cohort import _sex  # noqa: E402
from t03_models import fmt, metrics, model_zoo  # noqa: E402

EXPORT = os.path.expanduser("~/unm/export/30")
SEED = 20261002
CF_KEYS = ["mecfs_postviral", "chronic_fatigue_unspecified"]
N_BOOT = 200


def query_events(cdr):
    from google.cloud import bigquery
    client = bigquery.Client()
    s_cte = f"""s AS (SELECT sc.person_id, MIN(sc.survey_end_date) AS d0 FROM `{cdr}.survey_conduct` sc
              JOIN `{cdr}.concept` c ON sc.survey_concept_id = c.concept_id
              WHERE LOWER(c.concept_name) LIKE '%personal and family health history%'
                 OR LOWER(c.concept_name) LIKE '%personal medical history%' GROUP BY 1)"""
    win = "BETWEEN DATE_SUB(s.d0, INTERVAL 1825 DAY) AND DATE_SUB(s.d0, INTERVAL 1 DAY)"
    print("querying survey dates", flush=True)
    survey = client.query(f"WITH {s_cte} SELECT person_id, d0 FROM s").to_dataframe()
    pref = ", ".join(f"STRUCT('{f}' AS fid, '{p}' AS p)" for f, p in cf.condition_prefixes())
    print("querying condition features", flush=True)
    conds = client.query(f"""
        WITH {s_cte}, m AS (SELECT * FROM UNNEST([{pref}]))
        SELECT co.person_id, m.fid, MAX(DATE_DIFF(co.condition_start_date, s.d0, DAY)) AS max_off
        FROM `{cdr}.condition_occurrence` co JOIN s USING (person_id)
        JOIN `{cdr}.concept` k ON co.condition_source_concept_id = k.concept_id AND k.vocabulary_id = 'ICD10CM'
        JOIN m ON STARTS_WITH(REPLACE(UPPER(k.concept_code), '.', ''), m.p)
        WHERE co.condition_start_date {win}
        GROUP BY 1, 2""").to_dataframe()
    cpt = ", ".join(f"STRUCT('{f}' AS fid, '{c}' AS code)" for f, c in cf.procedure_codes())
    print("querying procedure features", flush=True)
    procs = client.query(f"""
        WITH {s_cte}, m AS (SELECT * FROM UNNEST([{cpt}]))
        SELECT p.person_id, m.fid, MAX(DATE_DIFF(p.procedure_date, s.d0, DAY)) AS max_off
        FROM `{cdr}.procedure_occurrence` p JOIN s USING (person_id)
        JOIN `{cdr}.concept` k ON p.procedure_source_concept_id = k.concept_id AND k.vocabulary_id IN ('CPT4', 'HCPCS')
        JOIN m ON k.concept_code = m.code
        WHERE p.procedure_date {win}
        GROUP BY 1, 2""").to_dataframe()
    seeds = ", ".join(f"STRUCT('{f['id']}' AS fid, '%{f['loinc_seed'].lower()}%' AS pat)" for f in cf.REG["labs"])
    print("resolving labs", flush=True)
    lab_codes = client.query(f"""
        WITH seeds AS (SELECT * FROM UNNEST([{seeds}]))
        SELECT s.fid, c.concept_id, c.concept_code AS loinc, c.concept_name
        FROM seeds s JOIN `{cdr}.concept` c ON c.vocabulary_id = 'LOINC' AND c.standard_concept = 'S'
         AND c.domain_id = 'Measurement' AND LOWER(c.concept_name) LIKE s.pat""").to_dataframe()
    labs = client.query(f"""
        WITH {s_cte}
        SELECT m.person_id, m.measurement_concept_id AS concept_id, MAX(DATE_DIFF(m.measurement_date, s.d0, DAY)) AS max_off
        FROM `{cdr}.measurement` m JOIN s USING (person_id)
        WHERE m.measurement_date {win} AND m.measurement_concept_id IN UNNEST(@cids)
        GROUP BY 1, 2""", job_config=bigquery.QueryJobConfig(query_parameters=[
        bigquery.ArrayQueryParameter("cids", "INT64", [int(x) for x in lab_codes.concept_id.unique()])])).to_dataframe()
    labs = labs.merge(lab_codes[["fid", "concept_id"]], on="concept_id").groupby(["person_id", "fid"], as_index=False).max_off.max()
    ing = ", ".join(f"STRUCT('{f['id']}' AS fid, '{n}' AS name)" for f in cf.REG["medications"] for n in f["rxnorm_ingredients"])
    print("resolving drugs", flush=True)
    drug_codes = client.query(f"""
        WITH ing AS (SELECT * FROM UNNEST([{ing}])),
        ic AS (SELECT i.fid, c.concept_id AS ingredient_id FROM ing i JOIN `{cdr}.concept` c
               ON c.vocabulary_id = 'RxNorm' AND c.concept_class_id = 'Ingredient' AND LOWER(c.concept_name) = i.name)
        SELECT ic.fid, d.concept_id, d.concept_code AS rxcui, d.vocabulary_id
        FROM ic JOIN `{cdr}.concept_ancestor` a ON a.ancestor_concept_id = ic.ingredient_id
        JOIN `{cdr}.concept` d ON d.concept_id = a.descendant_concept_id AND d.vocabulary_id IN ('RxNorm', 'RxNorm Extension')
    """).to_dataframe()
    drugs = client.query(f"""
        WITH {s_cte}
        SELECT de.person_id, de.drug_concept_id AS concept_id, MAX(DATE_DIFF(de.drug_exposure_start_date, s.d0, DAY)) AS max_off
        FROM `{cdr}.drug_exposure` de JOIN s USING (person_id)
        WHERE de.drug_exposure_start_date {win} AND de.drug_concept_id IN UNNEST(@cids)
        GROUP BY 1, 2""", job_config=bigquery.QueryJobConfig(query_parameters=[
        bigquery.ArrayQueryParameter("cids", "INT64", [int(x) for x in drug_codes.concept_id.unique()])])).to_dataframe()
    drugs = drugs.merge(drug_codes[["fid", "concept_id"]].drop_duplicates(), on="concept_id").groupby(["person_id", "fid"], as_index=False).max_off.max()
    print("querying visits", flush=True)
    visits = client.query(f"""
        WITH {s_cte}
        SELECT v.person_id, c.concept_name AS visit_type,
               COUNTIF(v.visit_start_date BETWEEN DATE_SUB(s.d0, INTERVAL 365 DAY) AND DATE_SUB(s.d0, INTERVAL 1 DAY)) AS n_R,
               COUNTIF(v.visit_start_date {win}) AS n_H
        FROM `{cdr}.visit_occurrence` v JOIN s USING (person_id)
        LEFT JOIN `{cdr}.concept` c ON v.visit_concept_id = c.concept_id
        GROUP BY 1, 2""").to_dataframe()
    events = pd.concat([conds, procs, labs, drugs], ignore_index=True)
    return survey, events, visits, lab_codes, drug_codes


def build_cohort(pop_raw, codes_raw, sr, survey, visits):
    pop = pop_raw.copy()
    pop["sex"] = pop.sex_name.map(_sex)
    pop = pop.merge(survey, on="person_id")
    pop["d0"] = pd.to_datetime(pop.d0.astype(str))
    pop["age"] = pop.d0.dt.year - pop.year_of_birth
    v = visits.assign(visit_class=visits.visit_type.map(cf.visit_class))
    hist = v[v.visit_class.isin(["AMB", "EMER", "IMP"])].groupby("person_id").n_R.sum()
    c = codes_raw[codes_raw.cond.isin(CF_KEYS)].copy()
    c["first_d"] = pd.to_datetime(c.first_d.astype(str))
    c["last_d"] = pd.to_datetime(c.last_d.astype(str))
    c = c.merge(pop[["person_id", "d0"]], on="person_id")
    coded_before = set(c.loc[c.first_d <= c.d0, "person_id"])
    coded_after = set(c.loc[c.last_d > c.d0, "person_id"])
    ever = set(sr.loc[sr.q == t26.FIRST_TOLD["chronic_fatigue"], "person_id"])
    keep = (pop.age >= 18) & pop.person_id.map(hist).fillna(0).ge(1) & ~pop.person_id.isin(coded_before)
    pop = pop[keep].set_index("person_id")
    pop["y_sr"] = pop.index.isin(ever).astype(int)
    pop["y_code"] = pop.index.isin(coded_after).astype(int)
    pop["y_inv"] = ((pop.y_sr == 1) & (pop.y_code == 0)).astype(int)
    rng = np.random.default_rng(SEED)
    pop["split"] = np.where(rng.random(len(pop)) < 0.8, "train", "validation")
    return pop, v


def cohort_table(pop):
    rows = []
    for sp, g in pop.groupby("split"):
        rows.append({"split": sp, "n_people": len(g), "n_women": int((g.sex == "Female").sum()),
                     "n_self_report": int(g.y_sr.sum()), "n_coded_later": int(g.y_code.sum()),
                     "n_self_report_coded_later": int((g.y_sr & g.y_code).sum()), "n_self_report_never_coded": int(g.y_inv.sum())})
    raw = pd.DataFrame(rows)
    cols = ["n_people", "n_women", "n_self_report", "n_coded_later", "n_self_report_coded_later", "n_self_report_never_coded"]
    return protect(raw, cols, complements=[("n_people", "n_women"), ("n_people", "n_self_report"), ("n_people", "n_coded_later"),
                                           ("n_self_report", "n_self_report_never_coded"), ("n_self_report", "n_self_report_coded_later"),
                                           ("n_coded_later", "n_self_report_coded_later")])


def boot_compare(yv, s_a, s_b, ysr, seed=SEED):
    rng = np.random.default_rng(seed)
    n = len(yv)
    out = {"recall_top5": [], "recall_top10": [], "auroc_sr": []}
    for _ in range(N_BOOT):
        i = rng.integers(0, n, n)
        for k, f in (("recall_top5", 0.05), ("recall_top10", 0.10)):
            ra = (yv[i] & (s_a[i] >= np.quantile(s_a[i], 1 - f))).sum() / max(1, yv[i].sum())
            rb = (yv[i] & (s_b[i] >= np.quantile(s_b[i], 1 - f))).sum() / max(1, yv[i].sum())
            out[k].append(ra - rb)
        out["auroc_sr"].append(roc_auc_score(ysr[i], s_a[i]) - roc_auc_score(ysr[i], s_b[i]))
    rows = []
    for k, f in (("recall_top5", 0.05), ("recall_top10", 0.10)):
        ra = (yv & (s_a >= np.quantile(s_a, 1 - f))).sum() / yv.sum()
        rb = (yv & (s_b >= np.quantile(s_b, 1 - f))).sum() / yv.sum()
        rows.append({"measure": f"difference in recall of never-coded self-reporters, {k}", "estimate": round(float(ra - rb), 4),
                     "ci_low": round(float(np.percentile(out[k], 2.5)), 4), "ci_high": round(float(np.percentile(out[k], 97.5)), 4)})
    rows.append({"measure": "difference in AUROC for self-report", "estimate": round(float(roc_auc_score(ysr, s_a) - roc_auc_score(ysr, s_b)), 4),
                 "ci_low": round(float(np.percentile(out["auroc_sr"], 2.5)), 4), "ci_high": round(float(np.percentile(out["auroc_sr"], 97.5)), 4)})
    return pd.DataFrame(rows)


def run(pop, X):
    tr, va = (pop.split == "train").to_numpy(), (pop.split == "validation").to_numpy()
    Xtr, Xva = X[tr], X[va]
    ysr_tr, ysr_va = pop.y_sr.to_numpy()[tr], pop.y_sr.to_numpy()[va]
    ycd_tr, ycd_va = pop.y_code.to_numpy()[tr], pop.y_code.to_numpy()[va]
    yinv_va = pop.y_inv.to_numpy()[va]
    # deployable model: from the rounded tables that are exported
    tab_exp = cf.label_tables(Xtr, ysr_tr, rounded=True)
    n1r, n0r = cf.r10(ysr_tr.sum()), cf.r10(len(ysr_tr) - ysr_tr.sum())
    nb_sr = cf.fit_nb_eb(tab_exp, n1=n1r - cf.ROUND_EXCESS, n0=n0r - cf.ROUND_EXCESS, unround=True)
    nb_code = cf.fit_nb_eb(cf.label_tables(Xtr, ycd_tr, rounded=False), n1=float(ycd_tr.sum()),
                           n0=float(len(ycd_tr) - ycd_tr.sum()), unround=False)
    en = lambda y: model_zoo(SEED)["M2_elastic_net_logistic"][1].fit(Xtr.to_numpy(float), y)
    scores = {"nb_sr_exported": cf.score(nb_sr, Xva), "en_sr": en(ysr_tr).predict_proba(Xva.to_numpy(float))[:, 1],
              "nb_code": cf.score(nb_code, Xva), "en_code": en(ycd_tr).predict_proba(Xva.to_numpy(float))[:, 1]}
    rows = []
    for m, s in scores.items():
        for tname, y in (("self-report", ysr_va), ("self-report, never coded", yinv_va), ("later code", ycd_va)):
            rows.append({"model": m, "target": tname, **fmt(metrics(y, s))})
    met = pd.DataFrame(rows)
    comp = boot_compare(yinv_va, scores["nb_sr_exported"], scores["nb_code"], ysr_va)
    sex_va = pop.sex.to_numpy()[va]
    by_sex = []
    for sx in ("Female", "Male"):
        mk = sex_va == sx
        n1 = int(ysr_va[mk].sum())
        by_sex.append({"sex": sx, "auroc_self_report": round(float(roc_auc_score(ysr_va[mk], scores["nb_sr_exported"][mk])), 4)
                       if 0 < n1 < mk.sum() else "not estimable"})
    s_tr = cf.score(nb_sr, Xtr)
    bins = pd.DataFrame([{"bin": f"bin {i + 1}", "score_lo": round(lo, 4), "score_hi": round(hi, 4), "score_mean": round(mu, 4),
                          "n": cf.r10(n), "n_pos": cf.r10(npos)} for i, (lo, hi, mu, n, npos) in enumerate(cf.calibration_bins(s_tr, ysr_tr))])
    labels = pd.DataFrame([{"measure": "n_train", "value": cf.r10(len(ysr_tr))}, {"measure": "n_train_pos", "value": n1r},
                           {"measure": "n_train_neg", "value": n0r}])
    return tab_exp, labels, bins, met, comp, pd.DataFrame(by_sex)


def main(loader=None):
    if loader:
        pop_raw, codes_raw, sr, survey, events, visits, lab_codes, drug_codes = loader()
    else:
        cdr = subprocess.check_output(["wb", "resolve", f"--id={t25.CDR_ID}"], text=True).strip()
        pop_raw, codes_raw, _ = t25.query(cdr)
        sr, _, _ = t26.query_survey(cdr)
        survey, events, visits, lab_codes, drug_codes = query_events(cdr)
    print("data loaded", flush=True)
    t03_models.N_BOOT = N_BOOT
    pop, v = build_cohort(pop_raw, codes_raw, sr, survey, visits)
    vis = v.groupby(["person_id", "visit_class"], as_index=False)[["n_R", "n_H"]].sum()
    X = cf.build_features(pop, events, vis)
    print(f"cohort {len(pop)} people, {X.shape[1]} features", flush=True)
    tab, labels, bins, met, comp, by_sex = run(pop, X)
    labs = lab_codes[["fid", "loinc", "concept_name"]].drop_duplicates().sort_values(["fid", "loinc"])
    drugs = drug_codes[drug_codes.vocabulary_id == "RxNorm"][["fid", "rxcui"]].drop_duplicates().sort_values(["fid", "rxcui"])
    drugs["rxcui"] = "rxcui:" + drugs.rxcui.astype(str)
    os.makedirs(EXPORT, exist_ok=True)
    out = {"t30_cohort": cohort_table(pop), "t30_label_counts": labels, "t30_feature_label_counts": tab,
           "t30_calibration_bins": bins, "t30_metrics": met, "t30_comparison": comp, "t30_by_sex": by_sex,
           "t30_codelist_labs": labs, "t30_codelist_drugs": drugs}
    for name, df in out.items():
        check_exportable(df)
        df.to_csv(os.path.join(EXPORT, f"{name}.csv"), index=False)
        print(f"exported {name} ({len(df)} rows)", flush=True)
    print("Task 30 finished", flush=True)


if __name__ == "__main__":
    main()
