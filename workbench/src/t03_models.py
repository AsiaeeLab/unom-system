"""Task 03: models and evaluation for the Long COVID landmark cohort.

Runs inside the All of Us Workbench (bash ~/unm/bin/unm.sh run 03).
Inputs : ~/unm/output/cohort_v2.parquet (Task 01), ~/unm/output/features_v1.parquet (Task 02)
Outputs: ~/unm/output/t03_oof_scores.parquet (participant level; stays in Workbench)
Exports: ~/unm/export/03/ metrics only (no coefficients, trees, or importances)

Label s = first U09.9 in days 91-455 (positive) versus everyone else (unlabeled).
Models: M0 prevalence; M1 utilization-only logistic; M2 elastic-net logistic (all features);
M3 gradient boosting; M4 bagged PU (Mordelet & Vert 2014) with gradient boosting.
Evaluation: 5-fold stratified cross-validation (out-of-fold scores) and a site-held-out test.
"""

from __future__ import annotations

import os
import sys

import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import average_precision_score, roc_auc_score
from sklearn.model_selection import StratifiedKFold
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from aou_safe import SUPPRESSED, check_exportable, protect  # noqa: E402

OUT = os.path.expanduser("~/unm/output")
EXPORT = os.path.expanduser("~/unm/export/03")
FEATURES = "features_v2.parquet"   # participant-level feature file in ~/unm/output (a rerun wrapper may change it)
SEED = 20260928
N_BOOT = 500
UTIL = ["out_w0_ge4", "out_w3_ge2", "out_w3_ge4", "ed_w3_any", "ip_w3_any", "visit_rate_up",
        "acute_inpatient", "acute_ed"]
LC_OUT = ["yout_sym_fatigue", "yout_sym_dyspnea", "yout_sym_autonomic", "yout_sym_cognitive",
          "yout_sym_dizzy_syncope", "yout_sym_smell_taste"]
NC_OUT = ["yout_nc_fracture", "yout_nc_laceration", "yout_nc_appendicitis", "yout_nc_cataract"]


def model_zoo(seed=SEED):
    return {
        "M1_utilization_logistic": ("util", make_pipeline(StandardScaler(), LogisticRegression(max_iter=2000, C=1.0))),
        "M2_elastic_net_logistic": ("all", make_pipeline(StandardScaler(), LogisticRegression(
            penalty="elasticnet", solver="saga", l1_ratio=0.5, C=0.05, max_iter=5000))),
        "M3_gradient_boosting": ("all", HistGradientBoostingClassifier(
            max_iter=300, learning_rate=0.05, max_leaf_nodes=15, min_samples_leaf=40, l2_regularization=1.0,
            random_state=seed)),
    }


def pu_bagging_scores(Xtr, ytr, Xte, n_bags=25, seed=SEED):
    """Mordelet & Vert bagged PU: each bag trains labeled vs a bootstrap of unlabeled (up to 5x the positives)."""
    rng = np.random.default_rng(seed)
    pos, unl = np.where(ytr == 1)[0], np.where(ytr == 0)[0]
    k = min(len(unl), 5 * len(pos))
    te = np.zeros(len(Xte))
    for b in range(n_bags):
        u = rng.choice(unl, k, replace=True)
        idx = np.concatenate([pos, u])
        clf = HistGradientBoostingClassifier(max_iter=200, learning_rate=0.05, max_leaf_nodes=15,
                                             min_samples_leaf=40, random_state=seed + b)
        clf.fit(Xtr[idx], np.r_[np.ones(len(pos)), np.zeros(k)])
        te += clf.predict_proba(Xte)[:, 1]
    return te / n_bags


def oof_scores(X: np.ndarray, Xu: np.ndarray, y: np.ndarray, seed=SEED) -> pd.DataFrame:
    skf = StratifiedKFold(n_splits=5, shuffle=True, random_state=seed)
    zoo = model_zoo(seed)
    scores = {name: np.zeros(len(y)) for name in list(zoo) + ["M4_pu_bagging"]}
    for tr, te in skf.split(X, y):
        for name, (fs, mdl) in zoo.items():
            A = Xu if fs == "util" else X
            mdl.fit(A[tr], y[tr])
            scores[name][te] = mdl.predict_proba(A[te])[:, 1]
        scores["M4_pu_bagging"][te] = pu_bagging_scores(X[tr], y[tr], X[te], seed=seed)
    scores["M0_prevalence"] = np.full(len(y), y.mean())
    return pd.DataFrame(scores)


def recall_ppv_at(y, s, frac):
    k = max(1, int(round(frac * len(y))))
    top = np.argsort(-s)[:k]
    tp = y[top].sum()
    return tp / max(1, y.sum()), tp / k, int(tp), k


def metrics(y, s, boot=True, seed=SEED, counts_released=False):
    """AUROC, AUPRC, and recall/PPV in the top 1/5/10%.

    When the same table releases count denominators, mask rates that disclose 1-20 flagged
    positives. Metrics-only tables do not inherit restrictions from other releases.
    """
    out = {"auroc": roc_auc_score(y, s), "auprc": average_precision_score(y, s)}
    small = set()
    for f in (0.01, 0.05, 0.10):
        r, ppv, _, _ = recall_ppv_at(y, s, f)
        tp = round(r * y.sum())
        key = int(f * 100)
        if counts_released and 0 < tp <= 20:
            small.add(key)
            r = ppv = "<=20 flagged"
        out[f"recall_top{key}"] = r
        out[f"ppv_top{key}"] = ppv
    if boot:
        rng = np.random.default_rng(seed)
        bs = {k: [] for k in ("auroc", "auprc", "recall_top5")}
        n = len(y)
        for _ in range(N_BOOT):
            i = rng.integers(0, n, n)
            if not 0 < y[i].sum() < len(i):
                continue
            bs["auroc"].append(roc_auc_score(y[i], s[i]))
            bs["auprc"].append(average_precision_score(y[i], s[i]))
            bs["recall_top5"].append(recall_ppv_at(y[i], s[i], 0.05)[0])
        for k, v in bs.items():
            out[f"{k}_lo"], out[f"{k}_hi"] = np.percentile(v, [2.5, 97.5])
        if 5 in small:
            out["recall_top5_lo"] = out["recall_top5_hi"] = "<=20 flagged"
    return out


def fmt(d):
    return {k: (round(float(v), 4) if isinstance(v, (float, np.floating)) else v) for k, v in d.items()}


def main():
    cohort = pd.read_parquet(os.path.join(OUT, "cohort_v2.parquet"))
    cohort = cohort[cohort.landmark_eligible == 1]
    F = pd.read_parquet(os.path.join(OUT, FEATURES if os.path.exists(os.path.join(OUT, FEATURES)) else "features_v1.parquet")).loc[cohort.index]
    feats = [c for c in F.columns if not c.startswith("yout_")]
    X = F[feats].to_numpy(dtype=float)
    Xu = F[UTIL].to_numpy(dtype=float)
    y = cohort.s.to_numpy().astype(int)
    print(f"cohort and {len(feats)} features loaded", flush=True)

    # 1. cross-validated out-of-fold scores
    S = oof_scores(X, Xu, y)
    S.index = cohort.index
    S.to_parquet(os.path.join(OUT, "t03_oof_scores.parquet"))
    rows = []
    for name in S.columns:
        m = metrics(y, S[name].to_numpy(), boot=(name != "M0_prevalence"))
        rows.append({"model": name, "evaluation": "5-fold CV (out-of-fold)", **fmt(m)})
    print("cross-validation done", flush=True)

    # 2. site-held-out test: hold out about 20% of people by whole sites
    site = cohort.site.astype(str)
    sizes = site.value_counts(sort=False).sample(frac=1.0, random_state=SEED)
    held, cum = [], 0
    for s_id, n in sizes.items():
        if cum >= 0.2 * len(site):
            break
        held.append(s_id)
        cum += n
    te = site.isin(held).to_numpy()
    tr = ~te
    split_note = {"held_out_sites": f"{len(held)} sites", "held_out_people": int(te.sum()),
                  "held_out_positives": int(y[te].sum())}
    if 0 < y[te].sum() < te.sum() and 0 < y[tr].sum() < tr.sum():
        zoo = model_zoo()
        for name, (fs, mdl) in zoo.items():
            A = Xu if fs == "util" else X
            mdl.fit(A[tr], y[tr])
            m = metrics(y[te], mdl.predict_proba(A[te])[:, 1])
            rows.append({"model": name, "evaluation": "site-held-out test", **fmt(m)})
        pu = pu_bagging_scores(X[tr], y[tr], X[te])
        rows.append({"model": "M4_pu_bagging", "evaluation": "site-held-out test", **fmt(metrics(y[te], pu))})
    else:
        split_note["held_out_sites"] += "; not evaluated: a split has only one label class"
    perf = pd.DataFrame(rows)

    # 3. subgroup AUROC (out-of-fold) for the main models
    sub_rows = []
    for axis in ["sex", "age_band", "race_eth"]:
        for cat, idx in cohort.groupby(axis).groups.items():
            mask = cohort.index.isin(idx)
            npos, nneg = int(y[mask].sum()), int((1 - y[mask]).sum())
            rec = {"axis": axis, "category": cat, "n_people": int(mask.sum()), "n_pos": npos}
            for name in ["M2_elastic_net_logistic", "M4_pu_bagging"]:
                if npos > 0 and nneg > 0:
                    rec[f"auroc_{name}"] = round(roc_auc_score(y[mask], S.loc[mask, name]), 4)
                    tp = int((y[mask] & (S.loc[mask, name].to_numpy() >= np.quantile(S[name], 0.95))).sum())
                    rec[f"recall_top5_{name}"] = round(tp / npos, 4) if tp == 0 or tp > 20 else "<=20 flagged"
                else:
                    rec[f"auroc_{name}"] = SUPPRESSED
                    rec[f"recall_top5_{name}"] = SUPPRESSED
            sub_rows.append(rec)
    raw_sub = pd.DataFrame(sub_rows)
    sub = protect(raw_sub, ["n_people", "n_pos"])
    for col in ("n_people", "n_pos"):
        if any(not group[col].map(lambda v: isinstance(v, str)).any() for _, group in sub.groupby("axis")):
            for _, group in raw_sub.groupby("axis"):
                sub.loc[group.index, col] = protect(group, [col], partition=True)[col]

    # 4. calibration bins for M2 (merged until each bin has more than 20 positives and 20 negatives)
    p = S["M2_elastic_net_logistic"].to_numpy()
    order = np.argsort(p)
    bins, cur = [], []
    for i in order:
        cur.append(i)
        if y[cur].sum() > 20 and (len(cur) - y[cur].sum()) > 20 and len(cur) >= len(y) / 12:
            bins.append(cur); cur = []
    if cur:
        if bins:
            bins[-1] += cur
        else:
            bins.append(cur)
    cal = pd.DataFrame([{"bin": f"bin {k + 1}", "n": len(b), "n_pos": int(y[b].sum()),
                         "mean_predicted": round(float(p[b].mean()), 5),
                         "observed_rate": round(float(y[b].mean()), 5)} for k, b in enumerate(bins)])
    cal = protect(cal, ["n", "n_pos"])

    # 5. lead time: days from landmark (day 90) to first U09.9 for positives in the top 5%
    lead = []
    for name in ["M2_elastic_net_logistic", "M4_pu_bagging"]:
        thr = np.quantile(S[name], 0.95)
        flagged = (S[name].to_numpy() >= thr) & (y == 1)
        d = (cohort.loc[flagged, "days_to_code"] - 90).dropna()
        if len(d) > 1:
            lead.append({"model": name, "flagged_positives": int(len(d)),
                         "median_days_ahead": float(d.median()), "p25": float(d.quantile(.25)),
                         "p75": float(d.quantile(.75))})
        else:
            lead.append({"model": name, "flagged_positives": int(len(d)), "median_days_ahead": SUPPRESSED})
    lead = protect(pd.DataFrame(lead), ["flagged_positives"])

    # 6. specificity check with negative controls among the unlabeled
    unl = y == 0
    score = S.loc[unl, "M2_elastic_net_logistic"]
    top = score >= score.quantile(0.90)
    bottom = score <= score.quantile(0.50)
    Fu = F.loc[unl]
    nc_rows = []
    for col in LC_OUT + NC_OUT:
        if col not in Fu:
            continue
        a, b = int(Fu.loc[top, col].sum()), int(Fu.loc[bottom, col].sum())
        rec = {"outcome": col, "kind": "Long COVID-typical" if col in LC_OUT else "negative control",
               "n_top10": int(top.sum()), "events_top10": a, "n_bottom50": int(bottom.sum()), "events_bottom50": b}
        rec["rate_ratio"] = round((a / top.sum()) / (b / bottom.sum()), 3) if a > 20 and b > 20 else SUPPRESSED
        nc_rows.append(rec)
    nc = protect(pd.DataFrame(nc_rows), ["n_top10", "events_top10", "n_bottom50", "events_bottom50"])

    os.makedirs(EXPORT, exist_ok=True)
    for name, df in {"t03_performance": perf, "t03_subgroups": sub, "t03_calibration_M2": cal,
                     "t03_lead_time": lead, "t03_negative_controls": nc,
                     "t03_split": protect(pd.DataFrame([split_note]), ["held_out_people", "held_out_positives"])}.items():
        check_exportable(df)
        df.to_csv(os.path.join(EXPORT, f"{name}.csv"), index=False)
        print(f"exported {name}", flush=True)
    print("Task 03 finished", flush=True)


if __name__ == "__main__":
    main()
