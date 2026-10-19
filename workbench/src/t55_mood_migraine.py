"""Task 55 (app): case-finding models trained on self-report for migraine, depression, and anxiety.

Runs inside the All of Us Workbench (bash ~/unm/bin/unm.sh run 55).
Task 39's design (Tasks 30 and 33 for chronic fatigue) with the condition switched:
  migraine:   label = self-reported migraine (PFHH "first told you had migraine"); later code G43;
              features from features_migraine.json (G43 is not a feature).
  depression: label = self-reported depression; later code F32 or F33; features_depression.json.
  anxiety:    label = self-reported anxiety; later code F41; features_anxiety.json.
Patients with the label's code on or before the survey are not scored. The survey items are Task 26's
(FIRST_TOLD and CURRENT); the codes are Task 25's. The coding tables for these conditions are already
released (Tasks 25 to 27, 46, 49).
Disclosure: aou_safe within each table (the dissemination policy). Code lists are exported only for the
lab and drug features that Task 39 did not release.
Exports: ~/unm/export/55/
  t55_<condition>_{cohort, label_counts, feature_label_counts, calibration_bins, metrics, comparison, by_sex,
                   codelist_labs_new, codelist_drugs_new}   for migraine, depression, anxiety
  t55_status                 one row per condition
"""

from __future__ import annotations

import os
import subprocess
import sys

import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import t03_models  # noqa: E402
import t25_p2_coded_shares as t25  # noqa: E402
import t26_p2_selfreport as t26  # noqa: E402
import t30_cf_model as t30  # noqa: E402
import t33_cf_model_v2 as t33  # noqa: E402
import t39_sr_models as t39  # noqa: E402
import t54_lyme_lupus as t54  # noqa: E402
from aou_safe import check_exportable  # noqa: E402

EXPORT = os.path.expanduser("~/unm/export/55")
CONDITIONS = {
    "migraine": {"registry": "features_migraine.json", "code_keys": ["migraine"], "survey": "migraine", "sex": None},
    "depression": {"registry": "features_depression.json", "code_keys": ["depression"], "survey": "depression", "sex": None},
    "anxiety": {"registry": "features_anxiety.json", "code_keys": ["anxiety"], "survey": "anxiety", "sex": None},
}


def main(base_loader=None, cond_loader=None):
    t03_models.N_BOOT = t30.N_BOOT
    os.makedirs(EXPORT, exist_ok=True)
    t54.EXPORT = EXPORT
    if base_loader:
        pop_raw, codes_raw, sr = base_loader()
        cdr = None
    else:
        cdr = subprocess.check_output(["wb", "resolve", f"--id={t25.CDR_ID}"], text=True).strip()
        pop_raw, codes_raw, _ = t39.stage("Task 25 population and codes", t25.query, cdr)
        sr, _, _ = t39.stage("survey answers", t26.query_survey, cdr)
    status = []
    for name, spec in CONDITIONS.items():
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
        except Exception as e:  # noqa: BLE001  one condition failing must not lose the others
            status.append({"stage": f"{name} model", "status": "failed", "detail": str(e).splitlines()[0][:300]})
            print(f"{name} failed: {e}", flush=True)
    df = pd.DataFrame(status)
    check_exportable(df)
    df.to_csv(os.path.join(EXPORT, "t55_status.csv"), index=False)
    print("exported t55_status", flush=True)
    print("Task 55 finished", flush=True)


def run_condition(name, spec, pop_raw, codes_raw, sr, data):
    """Task 54's run_condition, writing t55_ files."""
    survey, events, visits, lab_codes, drug_codes, obs = data
    both = pd.concat([events, obs], ignore_index=True).groupby(["person_id", "fid"], as_index=False).max_off.max()
    pop, v = t39.build_cohort(pop_raw, codes_raw, sr, survey, visits, spec)
    vis = v.groupby(["person_id", "visit_class"], as_index=False)[["n_R", "n_H"]].sum()
    X = t54.cf.build_features(pop, both, vis)
    print(f"{name}: cohort {len(pop)} people, {X.shape[1]} features", flush=True)
    tab, labels, bins, met, comp, by_sex = t30.run(pop, X)
    labs, drugs = t54.new_codelists(name, lab_codes, drug_codes)
    out = {"cohort": t30.cohort_table(pop), "label_counts": labels, "feature_label_counts": tab, "calibration_bins": bins,
           "metrics": met, "comparison": comp, "by_sex": by_sex, "codelist_labs_new": labs, "codelist_drugs_new": drugs}
    for k, df in out.items():
        check_exportable(df)
        df.to_csv(os.path.join(EXPORT, f"t55_{name}_{k}.csv"), index=False)
        print(f"exported t55_{name}_{k} ({len(df)} rows)", flush=True)


if __name__ == "__main__":
    main()
