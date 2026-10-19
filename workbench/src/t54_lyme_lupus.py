"""Task 54 (app and Atlas): case-finding models trained on self-report for Lyme disease and lupus, and lupus
coding tables for the Atlas.

Runs inside the All of Us Workbench (bash ~/unm/bin/unm.sh run 54).
Models: Task 39's design (Tasks 30 and 33 for chronic fatigue) with the condition switched:
  lyme:  label = self-reported Lyme disease (PFHH "first told you had Lyme disease"); later code A69.2;
         features from features_lyme.json (A69.2 is not a feature); patients with A69.2 on or before the
         survey are not scored.
  lupus: label = self-reported lupus (the PFHH lupus item, found by name in the concept table because no
         earlier task used it); later code M32 (systemic lupus erythematosus); features from
         features_lupus.json (M32 is not a feature, also not inside the autoimmune group).
Atlas: the lupus rows of Tasks 25, 26, and 27 (coded share among all active adults by sex, age, and race and
ethnicity; self-report versus code by sex; by group), computed with those tasks' own functions. Lyme already
has these rows in Tasks 25 to 27 and 49.
Disclosure: aou_safe within each table (the dissemination policy, read literally on 2026-10-11): no
cross-release guards. Code lists are exported only for the lab and drug features that Task 39 did not
release, which keeps the terminal release small (Task 39's full code lists overflowed the terminal).
Exports: ~/unm/export/54/
  t54_<condition>_{cohort, label_counts, feature_label_counts, calibration_bins, metrics, comparison, by_sex,
                   codelist_labs_new, codelist_drugs_new}   for lyme and lupus
  t54_lupus_items            the PFHH lupus questions and answers found, with persons per answer
  t54_lupus_coded_shares     Task 25 table, lupus rows
  t54_lupus_selfreport_vs_code   Task 26 table, lupus rows
  t54_lupus_selfreport_by_group  Task 27 table, lupus rows
  t54_status                 one row per stage
"""

from __future__ import annotations

import json
import os
import subprocess
import sys

import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cf_model as cf  # noqa: E402
import t03_models  # noqa: E402
import t25_p2_coded_shares as t25  # noqa: E402
import t26_p2_selfreport as t26  # noqa: E402
import t27_p2_selfreport_groups as t27  # noqa: E402
import t30_cf_model as t30  # noqa: E402
import t33_cf_model_v2 as t33  # noqa: E402
import t39_sr_models as t39  # noqa: E402
from aou_safe import check_exportable, protect  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
EXPORT = os.path.expanduser("~/unm/export/54")
LUPUS_CODES = ["M32"]
CONDITIONS = {
    "lyme": {"registry": "features_lyme.json", "code_keys": ["lyme"], "survey": "lyme", "sex": None},
    "lupus": {"registry": "features_lupus.json", "code_keys": ["lupus"], "survey": "lupus", "sex": None},
}
RELEASED_39 = "features_fibro.json"   # its lab and drug code lists are already in results/aggregate/39


def query_lupus_items(cdr, client=None):
    """Every PPI question whose name mentions lupus, with each answer and the persons giving it."""
    if client is None:
        from google.cloud import bigquery
        client = bigquery.Client()
    return client.query(f"""
        SELECT o.observation_source_concept_id AS question_concept_id, q.concept_name AS question,
               o.value_source_concept_id AS answer_concept_id, a.concept_name AS answer,
               COUNT(DISTINCT o.person_id) AS n_persons
        FROM `{cdr}.observation` o
        JOIN `{cdr}.concept` q ON o.observation_source_concept_id = q.concept_id AND q.vocabulary_id = 'PPI'
        LEFT JOIN `{cdr}.concept` a ON o.value_source_concept_id = a.concept_id
        WHERE LOWER(q.concept_name) LIKE '%lupus%'
        GROUP BY 1, 2, 3, 4
    """).to_dataframe()


def pick_lupus_items(items: pd.DataFrame):
    """(first_told question, [(still seeing question, Yes), (currently treated question, Yes)]) or None.

    Mirrors Task 26's choice for the other conditions: the "first told" age question marks a self-report, and
    the two follow-up questions answered Yes mark a current one."""
    q = items.assign(ql=items.question.str.lower(), al=items.answer.fillna("").str.lower())
    first = q[q.ql.str.contains("first told") & q.ql.str.contains("lupus")]
    if first.empty:
        return None
    first_id = int(first.groupby("question_concept_id").n_persons.sum().idxmax())
    current = []
    for pat in ("still seeing a doctor", "currently prescribed"):
        rows = q[q.ql.str.contains(pat) & q.al.str.endswith(" - yes")]
        if not rows.empty:
            r = rows.sort_values("n_persons", ascending=False).iloc[0]
            current.append((int(r.question_concept_id), int(r.answer_concept_id)))
    return first_id, current


def items_table(items: pd.DataFrame) -> pd.DataFrame:
    out = items.copy()
    for c in ("question_concept_id", "answer_concept_id"):
        out[c] = out[c].map(lambda v: f"concept:{int(v)}" if pd.notna(v) else "")
    out = protect(out, ["n_persons"])
    return out[["question_concept_id", "question", "answer_concept_id", "answer", "n_persons"]]


def new_codelists(name, lab_codes, drug_codes):
    """Code lists for the lab and drug features that Task 39 did not release."""
    old = json.load(open(os.path.join(HERE, RELEASED_39)))
    old_ids = {f["id"] for k in ("labs", "medications") for f in old[k]}
    mine = {f["id"] for k in ("labs", "medications") for f in cf.REG[k]}
    lab_codes = lab_codes[lab_codes.fid.isin(mine)]
    drug_codes = drug_codes[drug_codes.fid.isin(mine)]
    labs = lab_codes[~lab_codes.fid.isin(old_ids)][["fid", "loinc", "concept_name"]].drop_duplicates().sort_values(["fid", "loinc"])
    drugs = drug_codes[(drug_codes.vocabulary_id == "RxNorm") & ~drug_codes.fid.isin(old_ids)][["fid", "rxcui"]]
    drugs = drugs.drop_duplicates().sort_values(["fid", "rxcui"])
    drugs["rxcui"] = "rxcui:" + drugs.rxcui.astype(str)
    return labs, drugs


def run_condition(name, spec, pop_raw, codes_raw, sr, data):
    survey, events, visits, lab_codes, drug_codes, obs = data
    both = pd.concat([events, obs], ignore_index=True).groupby(["person_id", "fid"], as_index=False).max_off.max()
    pop, v = t39.build_cohort(pop_raw, codes_raw, sr, survey, visits, spec)
    vis = v.groupby(["person_id", "visit_class"], as_index=False)[["n_R", "n_H"]].sum()
    X = cf.build_features(pop, both, vis)
    print(f"{name}: cohort {len(pop)} people, {X.shape[1]} features", flush=True)
    tab, labels, bins, met, comp, by_sex = t30.run(pop, X)
    labs, drugs = new_codelists(name, lab_codes, drug_codes)
    out = {"cohort": t30.cohort_table(pop), "label_counts": labels, "feature_label_counts": tab, "calibration_bins": bins,
           "metrics": met, "comparison": comp, "by_sex": by_sex, "codelist_labs_new": labs, "codelist_drugs_new": drugs}
    for k, df in out.items():
        check_exportable(df)
        df.to_csv(os.path.join(EXPORT, f"t54_{name}_{k}.csv"), index=False)
        print(f"exported t54_{name}_{k} ({len(df)} rows)", flush=True)


def lupus_atlas_tables(pop_raw, codes_raw, sr, resp, depth):
    """The lupus rows of the Task 25, 26, and 27 tables, from those tasks' own functions."""
    coded = t25.coded_table(pop_raw, codes_raw)
    coded = coded[coded.condition == "lupus"].reset_index(drop=True)
    pop_all, codes = t26.prepare(pop_raw, codes_raw)
    pop_all = pop_all.merge(depth, on="person_id", how="left")
    pop_all["ehr_depth"] = pop_all.depth_days.map(t27.depth_band)
    pop = pop_all[pop_all.sex.isin(t26.SEXES)]
    srp = sr[sr.person_id.isin(pop.person_id)]
    resp_ids = (set(resp.person_id) & set(pop.person_id)) | set(srp.person_id)
    # Both functions loop over every Task 26 condition; each condition's rows are protected on their own
    # (column-pair complements per row in Task 26, per condition-by-axis block in Task 27), so keeping only
    # the lupus rows keeps their protection.
    by_sex = t26.selfreport_table(pop, codes, srp, resp_ids)
    by_sex = by_sex[by_sex.condition == "lupus"].reset_index(drop=True)
    by_group = t27.group_table(pop_all, pop, codes, srp, resp_ids)
    by_group = by_group[by_group.condition == "lupus"].reset_index(drop=True)
    return {"t54_lupus_coded_shares": coded, "t54_lupus_selfreport_vs_code": by_sex, "t54_lupus_selfreport_by_group": by_group}


def export(name, df):
    check_exportable(df)
    df.to_csv(os.path.join(EXPORT, f"{name}.csv"), index=False)
    print(f"exported {name} ({len(df)} rows)", flush=True)


def main(base_loader=None, cond_loader=None, lupus_loader=None):
    t03_models.N_BOOT = t30.N_BOOT
    os.makedirs(EXPORT, exist_ok=True)
    t25.CONDITIONS["lupus"] = LUPUS_CODES          # Task 25's code query then returns lupus codes too
    status = []
    if lupus_loader:
        items, depth, resp = lupus_loader()
        cdr = None
    else:
        cdr = subprocess.check_output(["wb", "resolve", f"--id={t25.CDR_ID}"], text=True).strip()
        items = t39.stage("lupus survey items", query_lupus_items, cdr)
    export("t54_lupus_items", items_table(items))
    picked = pick_lupus_items(items)
    if picked:
        t26.FIRST_TOLD["lupus"], t26.CURRENT["lupus"] = picked
        status.append({"stage": "lupus survey item", "status": "found", "detail": f"first told: concept:{picked[0]}; "
                       f"current: {', '.join(f'concept:{q}=concept:{a}' for q, a in picked[1]) or 'none'}"})
    else:
        status.append({"stage": "lupus survey item", "status": "not found", "detail": "no PPI question with 'first told' and 'lupus'; lupus skipped"})
    conditions = {k: v for k, v in CONDITIONS.items() if k != "lupus" or picked}
    if base_loader:
        pop_raw, codes_raw, sr = base_loader()
    else:
        pop_raw, codes_raw, _ = t39.stage("Task 25 population and codes", t25.query, cdr)
        sr, resp, _ = t39.stage("survey answers", t26.query_survey, cdr)
    for name, spec in conditions.items():
        t39.use_registry(spec["registry"])
        try:
            if cond_loader:
                data = cond_loader(name)
            else:
                survey, events, visits, lab_codes, drug_codes = t39.stage(f"{name} feature queries", t30.query_events, cdr)
                obs = t39.stage(f"{name} observation-table codes", t33.query_observation_conditions, cdr)
                data = (survey, events, visits, lab_codes, drug_codes, obs)
            run_condition(name, spec, pop_raw, codes_raw, sr, data)
            status.append({"stage": f"{name} model", "status": "exported", "detail": ""})
        except Exception as e:  # noqa: BLE001  one condition failing must not lose the other
            status.append({"stage": f"{name} model", "status": "failed", "detail": str(e).splitlines()[0][:300]})
            print(f"{name} failed: {e}", flush=True)
    if picked:
        try:
            if not lupus_loader:
                depth = t39.stage("EHR depth", t27.query_depth, cdr)
            for name, df in lupus_atlas_tables(pop_raw, codes_raw, sr, resp, depth).items():
                export(name, df)
            status.append({"stage": "lupus atlas tables", "status": "exported", "detail": ""})
        except Exception as e:  # noqa: BLE001
            status.append({"stage": "lupus atlas tables", "status": "failed", "detail": str(e).splitlines()[0][:300]})
            print(f"lupus atlas tables failed: {e}", flush=True)
    export("t54_status", pd.DataFrame(status))
    print("Task 54 finished", flush=True)


if __name__ == "__main__":
    main()
