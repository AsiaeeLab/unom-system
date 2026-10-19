"""Task 44 (Paper 3): compliant re-release of the Task 30, 33, and 39 performance metrics.

Runs inside the All of Us Workbench (bash ~/unm/bin/unm.sh run 44).
Problem: within one released metrics file, the rows for "self-report" and "self-report, never coded" describe
the same top-k flagged set of the same model. The four-decimal PPVs gave the exact number of flagged positives
for each target, and their difference (flagged self-reporters who were later coded) was 1-20 in 23 cells. The
same holds across thresholds: the top-5% set is inside the top-10% set, so the four PPVs of the two targets
also give the number of later-coded self-reporters ranked between the top 5% and top 10%.

This task reruns the Task 30, 33, and 39 pipelines with the same functions (cohort, split, features, models,
bootstrap) and replaces only the recall and PPV columns, using joint_safe.metrics_table:
  - PPV = TP_r / k_r and recall = TP_r / P_r from counts rounded up to 10;
  - each target is evaluated on one flagged set per threshold; metrics are not hidden
    using cohort counts published in separate tables;
  - the top-1% columns are dropped (the paper does not use them).
AUROC, AUPRC, and their intervals come from t03_models.metrics unchanged.

Split reproduction: Tasks 30, 33, and 39 drew the split with a seeded generator in query row order, and
BigQuery returns rows in no fixed order. The released training-split feature tables (uploaded next to this
script) are compared with the recomputed ones; if every rounded cell matches, the split was reproduced and the
new AUROC columns equal the old ones. t44_split_check reports this.

Participant-level outputs for Task 45 (stay in Workbench, ~/unm/output/):
  t44_<condition>_cohort.parquet    age, sex, birth year, day 0, labels, legacy split, first later code date,
                                    visit counts (chronic fatigue: the Task 33 cohort, which equals Task 30's)
  t44_<condition>_features.parquet  binary features (chronic fatigue: Task 33 definitions)
  t44_<condition>_flow.parquet      eligibility flags over the base population (cohort flow)
  t44_split_check.json              whether each legacy split was reproduced
Exports: ~/unm/export/44/
  t30_metrics, t33_metrics, t39_endometriosis_metrics, t39_fibromyalgia_metrics (columns as before minus top 1%)
  t44_split_check: run, features compared, share of rounded training-table cells that differ, reproduced (yes/no),
      saved_for_task45 (yes/no: the participant-level outputs above were written)
Local use (no Workbench): python3 workbench/src/t44_metrics_rerelease.py --compare [results/aggregate]
  lists the cells that changed between the new and the earlier releases, for the task report.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import traceback

import numpy as np
import pandas as pd

try:
    import db_dtypes  # noqa: F401
except ImportError:
    pass

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import cf_model as cf  # noqa: E402
import joint_safe  # noqa: E402
import t03_models  # noqa: E402
import t25_p2_coded_shares as t25  # noqa: E402
import t26_p2_selfreport as t26  # noqa: E402
import t30_cf_model as t30  # noqa: E402
import t33_cf_model_v2 as t33  # noqa: E402
import t39_sr_models as t39  # noqa: E402
from aou_safe import check_exportable  # noqa: E402
from t01_cohort import _sex  # noqa: E402

EXPORT = os.path.expanduser("~/unm/export/44")
OUT = os.path.expanduser("~/unm/output")
REF_DIR = HERE      # released Task 30/33/39 feature tables are uploaded next to this script
TARGETS = ("self-report", "self-report, never coded", "later code")
DROP_FIRST = ("self-report",)   # suppressed first when a joint check fails (see the report)
FRACS = (0.05, 0.10)
CF_SPEC = {"registry": "features_cf.json", "code_keys": t30.CF_KEYS, "survey": "chronic_fatigue", "sex": None}
RUNS = {  # run -> (condition, export name, reference feature table)
    "30": ("chronic_fatigue", "t30_metrics", "t30_feature_label_counts.csv"),
    "33": ("chronic_fatigue", "t33_metrics", "t33_feature_label_counts.csv"),
    "endometriosis": ("endometriosis", "t39_endometriosis_metrics", "t39_endometriosis_feature_label_counts.csv"),
    "fibromyalgia": ("fibromyalgia", "t39_fibromyalgia_metrics", "t39_fibromyalgia_feature_label_counts.csv"),
}


def legacy_ci(y, s):
    """AUROC, AUPRC, and intervals exactly as Tasks 30, 33, and 39 computed them."""
    return t03_models.metrics(y, s)


def fit_scores(pop: pd.DataFrame, X: pd.DataFrame):
    """The four models of t30.run, fit the same way; returns validation scores, the rounded training table, and
    the full-population self-report score inputs."""
    tr, va = (pop.split == "train").to_numpy(), (pop.split == "validation").to_numpy()
    Xtr, Xva = X[tr], X[va]
    ysr_tr, ycd_tr = pop.y_sr.to_numpy()[tr], pop.y_code.to_numpy()[tr]
    tab_exp = cf.label_tables(Xtr, ysr_tr, rounded=True)
    n1r, n0r = cf.r10(ysr_tr.sum()), cf.r10(len(ysr_tr) - ysr_tr.sum())
    nb_sr = cf.fit_nb_eb(tab_exp, n1=n1r - cf.ROUND_EXCESS, n0=n0r - cf.ROUND_EXCESS, unround=True)
    nb_code = cf.fit_nb_eb(cf.label_tables(Xtr, ycd_tr, rounded=False), n1=float(ycd_tr.sum()),
                           n0=float(len(ycd_tr) - ycd_tr.sum()), unround=False)
    en = lambda y: t03_models.model_zoo(t30.SEED)["M2_elastic_net_logistic"][1].fit(Xtr.to_numpy(float), y)  # noqa: E731
    scores = {"nb_sr_exported": cf.score(nb_sr, Xva), "en_sr": en(ysr_tr).predict_proba(Xva.to_numpy(float))[:, 1],
              "nb_code": cf.score(nb_code, Xva), "en_code": en(ycd_tr).predict_proba(Xva.to_numpy(float))[:, 1]}
    return scores, tab_exp


def metrics(pop: pd.DataFrame, scores: dict) -> pd.DataFrame:
    va = (pop.split == "validation").to_numpy()
    targets = {"self-report": pop.y_sr.to_numpy()[va], "self-report, never coded": pop.y_inv.to_numpy()[va],
               "later code": pop.y_code.to_numpy()[va]}
    table, _, _ = joint_safe.metrics_table(scores, targets, legacy_ci, fracs=FRACS, drop_first=DROP_FIRST)
    return table


def split_check(tab: pd.DataFrame, ref_path: str) -> dict:
    """Compare the recomputed rounded training table with the released one (no participant data involved)."""
    ref = pd.read_csv(ref_path, dtype=str).set_index("feature")
    new = tab.astype(str).set_index("feature")
    cols = ["eligible", "n_x1_s1", "n_x1_s0", "n_x0_s1", "n_x0_s0"]
    same_features = list(ref.index) == list(new.index)
    common = ref.index.intersection(new.index)
    diff = (ref.loc[common, cols].apply(lambda c: c.str.lower()) != new.loc[common, cols].apply(lambda c: c.str.lower())).to_numpy()
    n_cells = diff.size + len(cols) * len(ref.index.symmetric_difference(new.index))
    share = (diff.sum() + len(cols) * len(ref.index.symmetric_difference(new.index))) / max(1, n_cells)
    return {"features_compared": int(len(common)), "share_cells_differing": round(float(share), 3),
            "reproduced": "yes" if same_features and share == 0 else "no"}


def flow_flags(pop_raw, codes_raw, survey, visits, spec) -> pd.DataFrame:
    """Eligibility flags over the base population, mirroring t30/t39 build_cohort step by step."""
    p = pop_raw[["person_id", "year_of_birth", "sex_name"]].drop_duplicates("person_id").copy()
    p["sex"] = p.sex_name.map(_sex)
    p = p.merge(survey, on="person_id", how="left")
    p["d0"] = pd.to_datetime(p.d0.astype(str), errors="coerce")
    f = pd.DataFrame(index=pd.Index(p.person_id, name="person_id"))
    f["base"] = True
    sex_ok = (p.sex == spec["sex"]).to_numpy() if spec["sex"] else np.ones(len(p), bool)
    if spec["sex"]:
        f["female"] = sex_ok
    f["survey"] = sex_ok & p.d0.notna().to_numpy()
    age = p.d0.dt.year.astype(float) - pd.to_numeric(p.year_of_birth, errors="coerce").astype(float)
    f["adult"] = f.survey.to_numpy() & (age >= 18).to_numpy(dtype=bool)
    v = visits.assign(visit_class=visits.visit_type.map(cf.visit_class))
    hist = v[v.visit_class.isin(["AMB", "EMER", "IMP"])].groupby("person_id").n_R.sum()
    f["recent_visit"] = f.adult.to_numpy() & p.person_id.map(hist).fillna(0).astype(float).ge(1).to_numpy(dtype=bool)
    c = codes_raw[codes_raw.cond.isin(spec["code_keys"])].copy()
    c["first_d"] = pd.to_datetime(c.first_d.astype(str))
    c = c.merge(p[["person_id", "d0"]], on="person_id")
    before = set(c.loc[c.first_d <= c.d0, "person_id"])
    f["uncoded_by_day0"] = f.recent_visit.to_numpy() & ~p.person_id.isin(before).to_numpy(dtype=bool)
    f["day0_before_2021_07_01"] = f.uncoded_by_day0.to_numpy() & (p.d0 < pd.Timestamp("2021-07-01")).to_numpy(dtype=bool)
    return f


def participant_frame(pop, codes_raw, visits, spec) -> pd.DataFrame:
    """Cohort columns Task 45 needs (participant level; stays in Workbench)."""
    c = codes_raw[codes_raw.cond.isin(spec["code_keys"])].copy()
    c["first_d"] = pd.to_datetime(c.first_d.astype(str))
    first = c.groupby("person_id").first_d.min()
    v = visits.assign(visit_class=visits.visit_type.map(cf.visit_class))
    v = v[v.visit_class.isin(["AMB", "EMER", "IMP"])].groupby("person_id")[["n_R", "n_H"]].sum()
    out = pop[["age", "sex", "year_of_birth", "d0", "y_sr", "y_code", "y_inv", "split"]].copy()
    out["age"] = pd.to_numeric(out.age, errors="coerce").astype(float)
    out["year_of_birth"] = pd.to_numeric(out.year_of_birth, errors="coerce").astype(float)
    out["first_code_d"] = out.index.map(first)
    out["first_code_d"] = out.first_code_d.where(out.y_code == 1)
    out["n_visits_R"] = out.index.map(v.n_R).fillna(0).astype(int)
    out["n_visits_H"] = out.index.map(v.n_H).fillna(0).astype(int)
    return out


def save_outputs(name, pop, X, flow, codes_raw, visits, spec, out_dir):
    os.makedirs(out_dir, exist_ok=True)
    fr = participant_frame(pop, codes_raw, visits, spec)
    if int(flow.uncoded_by_day0.sum()) != len(pop):   # Task 45 checks this again before releasing the flow table
        print(f"{name}: flow flags do not reproduce the cohort size", flush=True)
    fr.to_parquet(os.path.join(out_dir, f"t44_{name}_cohort.parquet"))
    X.to_parquet(os.path.join(out_dir, f"t44_{name}_features.parquet"))
    flow.to_parquet(os.path.join(out_dir, f"t44_{name}_flow.parquet"))


def require_refs(ref_dir):
    missing = [r[2] for r in RUNS.values() if not os.path.exists(os.path.join(ref_dir, r[2]))]
    if missing:
        raise FileNotFoundError("Task 44 needs the released training tables next to the script (upload them): "
                                + ", ".join(missing))


def main(base_loader=None, cond_loader=None, ref_dir=None, export=None, out_dir=None):
    ref_dir, export, out_dir = ref_dir or REF_DIR, export or EXPORT, out_dir or OUT
    require_refs(ref_dir)
    t03_models.N_BOOT = t30.N_BOOT
    if base_loader:
        pop_raw, codes_raw, sr = base_loader()
        cdr = None
    else:
        cdr = subprocess.check_output(["wb", "resolve", f"--id={t25.CDR_ID}"], text=True).strip()
        pop_raw, codes_raw, _ = t39.stage("Task 25 population and codes", t25.query, cdr)
        sr, _, _ = t39.stage("survey answers", t26.query_survey, cdr)
    print("base data loaded", flush=True)
    os.makedirs(export, exist_ok=True)
    os.makedirs(out_dir, exist_ok=True)
    tables, checks, reproduced = {}, [], {}
    specs = {"chronic_fatigue": CF_SPEC, **t39.CONDITIONS}
    for cond, spec in specs.items():
        t39.use_registry(spec["registry"])
        if cond_loader:
            survey, events, visits, lab_codes, drug_codes, obs = cond_loader(cond)
        else:
            survey, events, visits, lab_codes, drug_codes = t39.stage(f"{cond} feature queries", t30.query_events, cdr)
            obs = t39.stage(f"{cond} observation-table codes", t33.query_observation_conditions, cdr)
        if cond == "chronic_fatigue":
            pop, v = t30.build_cohort(pop_raw, codes_raw, sr, survey, visits)
        else:
            pop, v = t39.build_cohort(pop_raw, codes_raw, sr, survey, visits, spec)
        vis = v.groupby(["person_id", "visit_class"], as_index=False)[["n_R", "n_H"]].sum()
        if cond == "chronic_fatigue":
            variants = {"30": cf.build_features(pop, events, vis), "33": t33.guarded_features(pop, events, obs, vis)[0]}
        else:
            both = pd.concat([events, obs], ignore_index=True).groupby(["person_id", "fid"], as_index=False).max_off.max()
            variants = {cond: cf.build_features(pop, both, vis)}
        for run, X in variants.items():
            _, export_name, ref = RUNS[run]
            scores, tab = fit_scores(pop, X)
            tables[export_name] = metrics(pop, scores)
            chk = split_check(tab, os.path.join(ref_dir, ref))
            checks.append({"run": f"Task {run}" if run in ("30", "33") else f"Task 39 {run}", **chk})
            reproduced[run] = chk["reproduced"] == "yes"
            print(f"{run}: metrics done; split reproduced {chk['reproduced']}", flush=True)
        try:   # a failure here must not block the metrics release; Task 45 then stops with a clear message
            save_outputs(cond, pop, variants.get("33", next(iter(variants.values()))),
                         flow_flags(pop_raw, codes_raw, survey, visits, spec), codes_raw, visits, spec, out_dir)
            saved = "yes"
        except Exception:  # noqa: BLE001
            traceback.print_exc()
            saved = "no"
        for row in checks:
            row.setdefault("saved_for_task45", saved)
        print(f"{cond}: participant-level outputs saved: {saved}", flush=True)
    json.dump(reproduced, open(os.path.join(out_dir, "t44_split_check.json"), "w"))
    tables["t44_split_check"] = pd.DataFrame(checks)
    for name, df in tables.items():
        check_exportable(df)
        df.to_csv(os.path.join(export, f"{name}.csv"), index=False)
        print(f"exported {name} ({len(df)} rows)", flush=True)
    print("Task 44 finished", flush=True)


# ---------------------------------------------------------------- local comparison for the task report

PAIRS = [("44/t30_metrics.csv", "30/t30_metrics.csv"), ("44/t33_metrics.csv", "33/t33_metrics.csv"),
         ("44/t39_endometriosis_metrics.csv", "39/t39_endometriosis_metrics.csv"),
         ("44/t39_fibromyalgia_metrics.csv", "39/t39_fibromyalgia_metrics.csv")]


def _isnum(v) -> bool:
    try:
        float(v)
        return True
    except (TypeError, ValueError):
        return False


def compare(root: str) -> str:
    """Markdown summary of what changed between the Task 44 metrics and the earlier local releases."""
    lines = []
    for new_f, old_f in PAIRS:
        new = pd.read_csv(os.path.join(root, new_f), dtype=str).set_index(["model", "target"])
        old = pd.read_csv(os.path.join(root, old_f), dtype=str).set_index(["model", "target"])
        lines.append(f"### {new_f} versus {old_f}\n")
        dropped = [c for c in old.columns if c not in new.columns]
        if dropped:
            lines.append(f"Columns dropped: {', '.join(dropped)}.\n")
        lines.append("| column | cells changed | largest numeric change |\n|---|---:|---:|")
        status = []
        for col in [c for c in new.columns if c in old.columns]:
            n_changed, largest = 0, 0.0
            for idx in new.index:
                a, b = old.loc[idx, col], new.loc[idx, col]
                if a == b:
                    continue
                if _isnum(a) and _isnum(b):
                    if float(a) == float(b):
                        continue
                    largest = max(largest, abs(float(a) - float(b)))
                else:
                    status.append(f"| {idx[0]} | {idx[1]} | {col} | {a} | {b} |")
                n_changed += 1
            lines.append(f"| {col} | {n_changed} | {largest:.4f} |")
        if status:
            lines.append("\nCells whose suppression status changed:\n\n| model | target | column | before | after |\n|---|---|---|---|---|")
            lines += status
        lines.append("")
    return "\n".join(lines)


if __name__ == "__main__":
    if sys.argv[1:2] == ["--compare"]:
        root = sys.argv[2] if len(sys.argv) > 2 else os.path.join(HERE, "..", "..", "results", "aggregate")
        print(compare(root))
    else:
        main()
