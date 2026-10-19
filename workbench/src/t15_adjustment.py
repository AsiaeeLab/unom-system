"""Task 15: exploratory score adjustment by the relative coding fraction of women and men,
plus subgroup selection metrics at the operating threshold.

Runs inside the All of Us Workbench (bash ~/unm/bin/unm.sh run 15).
Inputs : ~/unm/output/{cohort_v2,features_v2}.parquet; ~/unm/src/coding_fractions.json
Exports: ~/unm/export/15/
  t15_adjustment: for the unadjusted day-90 elastic-net score and for scores divided by the
      women-to-men coding ratio r (point and interval bounds, "ever" and "current"; men and
      other sex r = 1): share of women in the top 5%, coded recall in the top 5%, coded AUROC.
  t15_threshold_subgroups: at the global top-5% threshold of the unadjusted score, per group
      including unknown/other groups: share flagged, coded recall, PPV.
All shares are computed from counts rounded up to a multiple of 10. The subgroup table protects
small counts and the rates that would recover them from its own denominators.
"""

from __future__ import annotations

import json
import os
import sys

import numpy as np
import pandas as pd
from sklearn.metrics import roc_auc_score

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from aou_safe import SUPPRESSED, check_exportable, protect  # noqa: E402
from t13_landmarks import en_model, oof, r10  # noqa: E402

OUT = os.path.expanduser("~/unm/output")
EXPORT = os.path.expanduser("~/unm/export/15")
FEATURES = "features_v2.parquet"   # participant-level feature file in ~/unm/output (a rerun wrapper may change it)
HERE = os.path.dirname(os.path.abspath(__file__))


def share(num, den, counts_released=True):
    if not den or (counts_released and (0 < num <= 20 or 0 < den <= 20)):
        return SUPPRESSED
    return round(r10(num) / r10(den), 3)


def summarize(name, defn, r, score, y, fem):
    top = score >= np.quantile(score, 0.95)
    tp = int(y[top].sum())
    return {"ranking": name, "definition": defn, "women_to_men_ratio": r,
            "share_women_top5": share(int((fem & top).sum()), int(top.sum()), counts_released=False),
            "coded_recall_top5": share(tp, int(y.sum()), counts_released=False),
            "auroc_coded": round(float(roc_auc_score(y, score)), 4)}


def adjustment_table(cohort, p, y, cf):
    fem = (cohort.sex == "Female").to_numpy()
    rows = [summarize("unadjusted", "", 1.0, p, y, fem)]
    for defn in ("ever", "current"):
        d = cf["sex"][defn]
        for name, r in (("adjusted, point ratio", d["ratio"]), ("adjusted, lower bound", d["lo"]),
                        ("adjusted, upper bound", d["hi"])):
            rows.append(summarize(name, defn, r, p / np.where(fem, r, 1.0), y, fem))
    rows.append({"ranking": "cohort", "definition": "", "women_to_men_ratio": "",
                 "share_women_top5": share(int(fem.sum()), len(fem), counts_released=False), "coded_recall_top5": "", "auroc_coded": ""})
    return pd.DataFrame(rows)


def threshold_table(cohort, p, y):
    top = p >= np.quantile(p, 0.95)
    rows = []
    for axis in ("sex", "race_eth", "age_band"):
        for g, idx in cohort.groupby(axis).indices.items():
            n, flagged, coded, tp = len(idx), int(top[idx].sum()), int(y[idx].sum()), int((top[idx] & (y[idx] == 1)).sum())
            rows.append({"axis": axis, "group": str(g), "n": n,
                         "share_flagged": share(flagged, n),
                         "coded_recall": share(tp, coded),
                         "ppv": share(tp, flagged)})
    raw = pd.DataFrame(rows)
    out = protect(raw, ["n"], partition=False)
    if any(not group.n.map(lambda v: isinstance(v, str)).any() for _, group in out.groupby("axis")):
        for _, group in raw.groupby("axis"):
            out.loc[group.index, "n"] = protect(group, ["n"], partition=True).n
    out.loc[out.n.map(lambda v: isinstance(v, str)), "share_flagged"] = SUPPRESSED
    return out


def main():
    cohort = pd.read_parquet(os.path.join(OUT, "cohort_v2.parquet"))
    cohort = cohort[cohort.landmark_eligible == 1]
    F = pd.read_parquet(os.path.join(OUT, FEATURES)).loc[cohort.index]
    X = F[[c for c in F.columns if not c.startswith("yout_")]].to_numpy(float)
    y = cohort.s.to_numpy().astype(int)
    p = oof(X, y, make=en_model)
    cf = json.load(open(os.path.join(HERE, "coding_fractions.json")))
    os.makedirs(EXPORT, exist_ok=True)
    for name, df in (("t15_adjustment", adjustment_table(cohort, p, y, cf)),
                     ("t15_threshold_subgroups", threshold_table(cohort, p, y))):
        check_exportable(df)
        df.to_csv(os.path.join(EXPORT, f"{name}.csv"), index=False)
        print(f"exported {name} ({len(df)} rows)", flush=True)
    print("Task 15 finished", flush=True)


if __name__ == "__main__":
    main()
