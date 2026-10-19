"""Task 39 (Paper 3 and app): case-finding models trained on self-report for endometriosis and fibromyalgia.

Runs inside the All of Us Workbench (bash ~/unm/bin/unm.sh run 39).
Same design as Tasks 30 and 33 (chronic fatigue), with the condition switched:
  endometriosis: women only; label = self-reported endometriosis (ever told); later code N80;
                 features from features_endo.json; patients with N80 on or before the survey are not scored.
  fibromyalgia:  women and men; label = self-reported fibromyalgia; later code M79.7;
                 features from features_fibro.json (M79.7 is not a feature).
Condition codes come from both condition_occurrence and the observation table (as Task 33).
Exports: ~/unm/export/39/ t39_<condition>_{cohort, label_counts, feature_label_counts, calibration_bins,
metrics, comparison, by_sex, codelist_labs, codelist_drugs} (same content and rules as Task 30).
"""

from __future__ import annotations

import json
import os
import subprocess
import sys

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cf_model as cf  # noqa: E402
import t03_models  # noqa: E402
import t25_p2_coded_shares as t25  # noqa: E402
import t26_p2_selfreport as t26  # noqa: E402
import t30_cf_model as t30  # noqa: E402
import t33_cf_model_v2 as t33  # noqa: E402
from aou_safe import check_exportable  # noqa: E402
from t01_cohort import _sex  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
EXPORT = os.path.expanduser("~/unm/export/39")
CONDITIONS = {
    "endometriosis": {"registry": "features_endo.json", "code_keys": ["endometriosis"], "survey": "endometriosis", "sex": "Female"},
    "fibromyalgia": {"registry": "features_fibro.json", "code_keys": ["fibromyalgia"], "survey": "fibromyalgia", "sex": None},
}


def use_registry(name):
    cf.REG = json.load(open(os.path.join(HERE, name)))
    cf.WIN = {k: tuple(v) for k, v in cf.REG["windows"].items()}


def build_cohort(pop_raw, codes_raw, sr, survey, visits, spec):
    pop = pop_raw.copy()
    pop["sex"] = pop.sex_name.map(_sex)
    if spec["sex"]:
        pop = pop[pop.sex == spec["sex"]]
    pop = pop.merge(survey, on="person_id")
    pop["d0"] = pd.to_datetime(pop.d0.astype(str))
    pop["age"] = pop.d0.dt.year - pop.year_of_birth
    v = visits.assign(visit_class=visits.visit_type.map(cf.visit_class))
    hist = v[v.visit_class.isin(["AMB", "EMER", "IMP"])].groupby("person_id").n_R.sum()
    c = codes_raw[codes_raw.cond.isin(spec["code_keys"])].copy()
    c["first_d"] = pd.to_datetime(c.first_d.astype(str))
    c["last_d"] = pd.to_datetime(c.last_d.astype(str))
    c = c.merge(pop[["person_id", "d0"]], on="person_id")
    coded_before = set(c.loc[c.first_d <= c.d0, "person_id"])
    coded_after = set(c.loc[c.last_d > c.d0, "person_id"])
    ever = set(sr.loc[sr.q == t26.FIRST_TOLD[spec["survey"]], "person_id"])
    keep = (pop.age >= 18) & pop.person_id.map(hist).fillna(0).ge(1) & ~pop.person_id.isin(coded_before)
    pop = pop[keep].set_index("person_id")
    pop["y_sr"] = pop.index.isin(ever).astype(int)
    pop["y_code"] = pop.index.isin(coded_after).astype(int)
    pop["y_inv"] = ((pop.y_sr == 1) & (pop.y_code == 0)).astype(int)
    rng = np.random.default_rng(t30.SEED)
    pop["split"] = np.where(rng.random(len(pop)) < 0.8, "train", "validation")
    return pop, v


def run_condition(name, spec, pop_raw, codes_raw, sr, data):
    survey, events, visits, lab_codes, drug_codes, obs = data
    both = pd.concat([events, obs], ignore_index=True).groupby(["person_id", "fid"], as_index=False).max_off.max()
    pop, v = build_cohort(pop_raw, codes_raw, sr, survey, visits, spec)
    vis = v.groupby(["person_id", "visit_class"], as_index=False)[["n_R", "n_H"]].sum()
    X = cf.build_features(pop, both, vis)
    print(f"{name}: cohort {len(pop)} people, {X.shape[1]} features", flush=True)
    tab, labels, bins, met, comp, by_sex = t30.run(pop, X)
    labs = lab_codes[["fid", "loinc", "concept_name"]].drop_duplicates().sort_values(["fid", "loinc"])
    drugs = drug_codes[drug_codes.vocabulary_id == "RxNorm"][["fid", "rxcui"]].drop_duplicates().sort_values(["fid", "rxcui"])
    drugs["rxcui"] = "rxcui:" + drugs.rxcui.astype(str)
    out = {"cohort": t30.cohort_table(pop), "label_counts": labels, "feature_label_counts": tab, "calibration_bins": bins,
           "metrics": met, "comparison": comp, "by_sex": by_sex, "codelist_labs": labs, "codelist_drugs": drugs}
    for k, df in out.items():
        check_exportable(df)
        df.to_csv(os.path.join(EXPORT, f"t39_{name}_{k}.csv"), index=False)
        print(f"exported t39_{name}_{k} ({len(df)} rows)", flush=True)


def stage(name, fn, *args):
    try:
        return fn(*args)
    except Exception as e:  # noqa: BLE001
        msg = getattr(e, "message", None) or str(e)
        raise RuntimeError(f"{name} failed: {type(e).__name__}: {str(msg).splitlines()[0][:300]}") from None


def main(base_loader=None, cond_loader=None):
    t03_models.N_BOOT = t30.N_BOOT
    if base_loader:
        pop_raw, codes_raw, sr = base_loader()
        cdr = None
    else:
        cdr = subprocess.check_output(["wb", "resolve", f"--id={t25.CDR_ID}"], text=True).strip()
        pop_raw, codes_raw, _ = stage("Task 25 population and codes", t25.query, cdr)
        sr, _, _ = stage("survey answers", t26.query_survey, cdr)
    os.makedirs(EXPORT, exist_ok=True)
    for name, spec in CONDITIONS.items():
        use_registry(spec["registry"])
        if cond_loader:
            data = cond_loader(name)
        else:
            survey, events, visits, lab_codes, drug_codes = stage(f"{name} feature queries", t30.query_events, cdr)
            obs = stage(f"{name} observation-table codes", t33.query_observation_conditions, cdr)
            data = (survey, events, visits, lab_codes, drug_codes, obs)
        run_condition(name, spec, pop_raw, codes_raw, sr, data)
    print("Task 39 finished", flush=True)


if __name__ == "__main__":
    main()
