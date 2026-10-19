"""Task 05: evaluate the exportable (summary-trained) models inside Workbench.

Runs inside the All of Us Workbench (bash ~/unm/bin/unm.sh run 05).
Inputs : ~/unm/output/{cohort_v2,features_v1,t04_split}.parquet; ~/unm/src/transport_candidates.json
         (weights fit OUTSIDE Workbench from Task 04 summary counts; importing them is allowed)
Exports: ~/unm/export/05/
  t05_transport_performance: held-out (20%) AUROC/AUPRC/recall for every candidate, and for
      the participant-level elastic-net and PU models refit on the same 80% (comparison only;
      those models never leave Workbench).
  t05_calibration_<candidate>: training-split score bins merged until each has at least 50
      positives and 50 unlabeled people (for fitting the calibration map outside). Counts are
      rounded up to a multiple of 10 like every working export; with 50+ positives per bin the
      rounding moves a bin's rate by at most 18%, and build_model.py subtracts the expected 4.5.
"""

from __future__ import annotations

import json
import os
import sys

import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import average_precision_score, roc_auc_score
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from aou_safe import check_exportable, protect  # noqa: E402
from t03_models import metrics, pu_bagging_scores, fmt  # noqa: E402

OUT = os.path.expanduser("~/unm/output")
EXPORT = os.path.expanduser("~/unm/export/05")
FEATURES = "features_v2.parquet"   # participant-level feature file in ~/unm/output (a rerun wrapper may change it)
CANDIDATES = "transport_candidates.json"   # candidate model file in ~/unm/src
HERE = os.path.dirname(os.path.abspath(__file__))


def calib_bins(score, y, min_frac=1 / 12, min_count=50):
    order = np.argsort(score)
    bins, cur = [], []
    for i in order:
        cur.append(i)
        npos = y[cur].sum()
        if npos >= min_count and len(cur) - npos >= min_count and len(cur) >= min_frac * len(y):
            bins.append(cur); cur = []
    if cur:
        if bins:
            bins[-1] += cur
        else:
            bins.append(cur)
    # bin means only: a bin's minimum or maximum would be one person's score
    return pd.DataFrame([{"bin": f"bin {k + 1}", "score_mean": round(float(score[b].mean()), 4),
                          "n": len(b), "n_pos": int(y[b].sum())} for k, b in enumerate(bins)])


def main():
    cohort = pd.read_parquet(os.path.join(OUT, "cohort_v2.parquet"))
    cohort = cohort[cohort.landmark_eligible == 1]
    F = pd.read_parquet(os.path.join(OUT, FEATURES if os.path.exists(os.path.join(OUT, FEATURES)) else "features_v1.parquet")).loc[cohort.index]
    split = pd.read_parquet(os.path.join(OUT, "t04_split.parquet")).loc[cohort.index, "train"].to_numpy()
    y = cohort.s.to_numpy().astype(int)
    cands = json.load(open(os.path.join(HERE, CANDIDATES)))["candidates"]
    rows = []
    os.makedirs(EXPORT, exist_ok=True)
    for c in cands:
        Xc = F[c["features"]].to_numpy(dtype=float)
        score = Xc @ np.array(c["weights"]) + c["intercept"]
        rows.append({"model": c["name"], "trained_on": "summary counts (exportable)",
                     **fmt(metrics(y[~split], score[~split], counts_released=True))})
        cal = protect(calib_bins(score[split], y[split]), ["n", "n_pos"])
        check_exportable(cal)
        cal.to_csv(os.path.join(EXPORT, f"t05_calibration_{c['name']}.csv"), index=False)
    print("transport candidates evaluated", flush=True)

    feats = [c for c in F.columns if not c.startswith("yout_")]
    X = F[feats].to_numpy(dtype=float)
    en = make_pipeline(StandardScaler(), LogisticRegression(penalty="elasticnet", solver="saga", l1_ratio=0.5,
                                                            C=0.05, max_iter=5000))
    en.fit(X[split], y[split])
    rows.append({"model": "M2_elastic_net_logistic", "trained_on": "participant rows (stays in Workbench)",
                 **fmt(metrics(y[~split], en.predict_proba(X[~split])[:, 1], counts_released=True))})
    pu = pu_bagging_scores(X[split], y[split], X[~split])
    rows.append({"model": "M4_pu_bagging", "trained_on": "participant rows (stays in Workbench)",
                 **fmt(metrics(y[~split], pu, counts_released=True))})
    perf = pd.DataFrame(rows)  # releases its own denominators, so recall/PPV implying 1-20 positives are flagged
    perf["held_out_people"] = int((~split).sum())
    perf["held_out_positives"] = int(y[~split].sum())
    perf = protect(perf, ["held_out_people", "held_out_positives"])
    check_exportable(perf)
    perf.to_csv(os.path.join(EXPORT, "t05_transport_performance.csv"), index=False)
    print("Task 05 finished", flush=True)


if __name__ == "__main__":
    main()
