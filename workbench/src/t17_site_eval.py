"""Task 17: frozen exportable pipeline evaluated at held-out sites.

Runs inside the All of Us Workbench (bash ~/unm/bin/unm.sh run 17).
Inputs : ~/unm/output/{cohort_v2,features_v2,t16_split}.parquet;
         ~/unm/src/transport_site_candidate.json (naive Bayes with empirical-Bayes shrinkage, fit outside
         Workbench from Task 16 counts; prespecified, no selection)
Exports: ~/unm/export/17/
  t17_calibration_bins: calibration-split score bins (>= 21 coded and 21 uncoded per bin; counts
      rounded up to 10; bin means only) for fitting the exported calibration map outside.
  t17_site_performance: on the held-out sites, AUROC/AUPRC with bootstrap intervals for the frozen
      exported model and for the elastic net refit on all training-site participants; the paired
      bootstrap difference (exported minus elastic net); calibration intercept and slope and the
      observed/expected ratio (from rounded observed counts) after a logistic recalibration fit on
      the calibration split (used for evaluation only; never exported).
"""

from __future__ import annotations

import json
import os
import sys

import numpy as np
import pandas as pd
from sklearn.metrics import average_precision_score, roc_auc_score

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from aou_safe import check_exportable, protect  # noqa: E402
from t03_models import fmt, metrics  # noqa: E402
from t05_transport_eval import calib_bins  # noqa: E402
from t13_landmarks import en_model, r10  # noqa: E402

OUT = os.path.expanduser("~/unm/output")
EXPORT = os.path.expanduser("~/unm/export/17")
FEATURES = "features_v2.parquet"   # participant-level feature file in ~/unm/output (a rerun wrapper may change it)
CANDIDATES = "transport_site_candidate.json"   # candidate model file in ~/unm/src
HERE = os.path.dirname(os.path.abspath(__file__))
SEED = 20261004
N_BOOT = 500


def logit(p):
    p = np.clip(p, 1e-6, 1 - 1e-6)
    return np.log(p / (1 - p))


def fit_logistic(x, y, offset=None, slope=True, iters=50):
    """Newton fit of y ~ a + b*x (+ offset); slope=False fits a with b fixed at 1 (calibration-in-the-large)."""
    off = np.zeros_like(x) if offset is None else offset
    ybar = float(np.clip(np.mean(y), 1e-6, 1 - 1e-6))
    a, b = (np.log(ybar / (1 - ybar)) - float(np.mean(off)), 0.0) if slope else (0.0, 1.0)
    for _ in range(iters):
        eta = np.clip(a + (b * x if slope else x) + off, -35, 35)
        p = 1 / (1 + np.exp(-eta))
        w = p * (1 - p)
        if slope:
            g = np.array([np.sum(y - p), np.sum((y - p) * x)])
            H = np.array([[w.sum(), (w * x).sum()], [(w * x).sum(), (w * x * x).sum()]]) + 1e-9 * np.eye(2)
            step = np.linalg.solve(H, g)
            step = step * min(1.0, 5.0 / max(1e-12, float(np.max(np.abs(step)))))   # damp large steps
            a, b = a + step[0], b + step[1]
        else:
            step = np.sum(y - p) / w.sum()
            a += step
        if np.max(np.abs(step)) < 1e-10:
            break
    return a, b


def main():
    cohort = pd.read_parquet(os.path.join(OUT, "cohort_v2.parquet"))
    cohort = cohort[cohort.landmark_eligible == 1]
    F = pd.read_parquet(os.path.join(OUT, FEATURES)).loc[cohort.index]
    role = pd.read_parquet(os.path.join(OUT, "t16_split.parquet")).loc[cohort.index, "role"].to_numpy()
    y = cohort.s.to_numpy().astype(int)
    cand = json.load(open(os.path.join(HERE, CANDIDATES)))
    score = F[cand["features"]].to_numpy(float) @ np.array(cand["weights"]) + cand["intercept"]
    cal, te, tr = role == "calibration", role == "test", role != "test"

    bins = protect(calib_bins(score[cal], y[cal], min_frac=0, min_count=21), ["n", "n_pos"])
    a, b = fit_logistic(score[cal], y[cal].astype(float))                 # internal recalibration
    p_te = 1 / (1 + np.exp(-(a + b * score[te])))

    feats = [c for c in F.columns if not c.startswith("yout_")]
    X = F[feats].to_numpy(float)
    en = en_model().fit(X[tr], y[tr])
    p_en = en.predict_proba(X[te])[:, 1]
    yt = y[te]
    m_nb, m_en = fmt(metrics(yt, score[te])), fmt(metrics(yt, p_en))
    rng = np.random.default_rng(SEED)
    d_auc, d_ap = [], []
    for _ in range(N_BOOT):
        i = rng.integers(0, len(yt), len(yt))
        if 0 < yt[i].sum() < len(i):
            d_auc.append(roc_auc_score(yt[i], score[te][i]) - roc_auc_score(yt[i], p_en[i]))
            d_ap.append(average_precision_score(yt[i], score[te][i]) - average_precision_score(yt[i], p_en[i]))
    lp = logit(p_te)
    _, slope = fit_logistic(lp, yt.astype(float))
    citl, _ = fit_logistic(np.zeros_like(lp), yt.astype(float), offset=lp, slope=False)
    rows = []
    for name, m in (("exported naive Bayes (frozen; trained on fit split counts)", m_nb),
                    ("elastic net (participant rows of training sites; not exportable)", m_en)):
        rows.append({"model": name, **{k: m[k] for k in ("auroc", "auroc_lo", "auroc_hi", "auprc", "auprc_lo", "auprc_hi")}})
    perf = pd.DataFrame(rows)
    perf["held_out_people"] = r10(te.sum())
    perf["held_out_positives"] = r10(yt.sum())
    obs_auc = roc_auc_score(yt, score[te]) - roc_auc_score(yt, p_en)
    obs_ap = average_precision_score(yt, score[te]) - average_precision_score(yt, p_en)
    extra = pd.DataFrame([{"model": "difference (exported minus elastic net; observed, bootstrap interval)",
                           "auroc": round(float(obs_auc), 4), "auroc_lo": round(float(np.percentile(d_auc, 2.5)), 4),
                           "auroc_hi": round(float(np.percentile(d_auc, 97.5)), 4),
                           "auprc": round(float(obs_ap), 4), "auprc_lo": round(float(np.percentile(d_ap, 2.5)), 4),
                           "auprc_hi": round(float(np.percentile(d_ap, 97.5)), 4)},
                          {"model": "exported naive Bayes after recalibration on the calibration split",
                           "calibration_intercept": round(float(citl), 3), "calibration_slope": round(float(slope), 3),
                           "observed_to_expected": round(r10(yt.sum()) / float(p_te.sum()), 2)}])
    perf = pd.concat([perf, extra], ignore_index=True)
    os.makedirs(EXPORT, exist_ok=True)
    for name, df in (("t17_calibration_bins", bins), ("t17_site_performance", perf)):
        check_exportable(df)
        df.to_csv(os.path.join(EXPORT, f"{name}.csv"), index=False)
        print(f"exported {name} ({len(df)} rows)", flush=True)
    print("Task 17 finished", flush=True)


if __name__ == "__main__":
    main()
