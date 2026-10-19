"""Fit the exportable (transport) models outside Workbench from Task 04 summary counts.

Input : results/aggregate/04/t04_*.csv (every released cell > 20)
Output: model/candidates/transport_candidates.json  (uploaded to Workbench by Task 05)

Candidates
- naive_bayes: weight_j = log odds ratio of feature j with the label (from its 2x2 table);
  intercept = logit(prevalence) + sum_j log((1 - p1_j) / (1 - p0_j)).
- lda_shrink_{lam}: linear discriminant. Class means come from the feature-label tables;
  the total second-moment matrix comes from pairwise co-occurrence counts (independence
  value n_j n_k / n where a pair was suppressed). The pooled within-class covariance is
  Sigma_W = Sigma_T - pi(1 - pi) d d', with d = mu1 - mu0, shrunk toward its diagonal:
  (1 - lam) Sigma_W + lam diag(Sigma_W). Weights w = Sigma^-1 d. Scores are rank-only
  until Task 05 exports calibration counts.
- nb_eb, lda_eb_{lam}: the same with empirical-Bayes shrinkage of the per-feature signal, for
  a training split with only ~200 positives. Each estimate (the log odds ratio for naive Bayes;
  the standardized mean difference d_j / sd_j for LDA) gets a N(0, tau^2) prior, tau^2 set by
  the method of moments (mean of estimate^2 minus mean of its squared standard error), and is
  replaced by its posterior mean estimate * tau^2 / (tau^2 + se^2). Standard errors come from
  the same 2x2 tables.
"""

from __future__ import annotations

import json
import os

import numpy as np
import pandas as pd

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
AGG = os.path.join(ROOT, "results/aggregate/04")
LAMBDAS = (0.1, 0.3, 0.6)


def eb_shrink(est, se):
    """Posterior means under est_j ~ N(theta_j, se_j^2), theta_j ~ N(0, tau^2); returns (shrunk, tau2)."""
    tau2 = max(0.0, float(np.mean(est ** 2) - np.mean(se ** 2)))
    return est * tau2 / (tau2 + se ** 2), tau2


ROUND_EXCESS = 4.5   # Task 04 rounds counts up to a multiple of 10; mean excess of a count above 20


def unround(v):
    v = pd.to_numeric(v, errors="coerce").astype(float)
    return v.where(v <= 0, v - ROUND_EXCESS)


def load(agg=AGG, prefix="t04"):
    lab = unround(pd.read_csv(os.path.join(agg, f"{prefix}_label_counts.csv")).set_index("measure").value)
    fl = pd.read_csv(os.path.join(agg, f"{prefix}_feature_label_counts.csv"))
    fl = fl[fl.eligible.astype(str).str.lower() == "true"].copy()
    for c in ["n_x1_s1", "n_x1_s0", "n_x0_s1", "n_x0_s0"]:
        fl[c] = unround(fl[c])
    marg = unround(pd.read_csv(os.path.join(agg, f"{prefix}_feature_margins.csv")).set_index("feature").n_x1)
    pairs = pd.read_csv(os.path.join(agg, f"{prefix}_pair_counts.csv"))
    pairs["n_both"] = unround(pairs.n_both)
    return float(lab["n_train"]), float(lab["n_train_s1"]), fl.set_index("feature"), marg, pairs


def fit(agg=AGG, prefix="t04"):
    n, n1, fl, marg, pairs = load(agg, prefix)
    n0 = n - n1
    feats = list(fl.index)
    p1 = (fl.n_x1_s1 / (fl.n_x1_s1 + fl.n_x0_s1)).to_numpy()
    p0 = (fl.n_x1_s0 / (fl.n_x1_s0 + fl.n_x0_s0)).to_numpy()
    cands = []

    w_nb = np.log(p1 * (1 - p0) / (p0 * (1 - p1)))
    b_nb = np.log(n1 / n0) + np.sum(np.log((1 - p1) / (1 - p0)))
    cands.append({"name": "naive_bayes", "features": feats, "weights": w_nb.tolist(), "intercept": float(b_nb)})
    se_nb = np.sqrt((1 / fl[["n_x1_s1", "n_x1_s0", "n_x0_s1", "n_x0_s0"]]).sum(axis=1).to_numpy())
    w_nbeb, tau2_nb = eb_shrink(w_nb, se_nb)
    m_all = (marg.loc[feats] / n).to_numpy()
    cands.append({"name": "nb_eb", "features": feats, "weights": w_nbeb.tolist(),
                  "intercept": float(np.log(n1 / n0) - w_nbeb @ m_all)})

    m = (marg.loc[feats] / n).to_numpy()
    M2 = np.outer(m, m)                       # independence default for suppressed pairs
    np.fill_diagonal(M2, m)                   # binary features: E[x^2] = E[x]
    pos = {f: i for i, f in enumerate(feats)}
    used = 0
    for r in pairs.itertuples():
        if pd.notna(r.n_both) and r.feature_a in pos and r.feature_b in pos:
            i, j = pos[r.feature_a], pos[r.feature_b]
            M2[i, j] = M2[j, i] = float(r.n_both) / n
            used += 1
    sigma_t = M2 - np.outer(m, m)
    d = p1 - p0
    pi = n1 / n
    sigma_w = sigma_t - pi * (1 - pi) * np.outer(d, d)
    sd = np.sqrt(np.clip(np.diag(sigma_w), 1e-9, None))
    se_d = np.sqrt(p1 * (1 - p1) / n1 + p0 * (1 - p0) / n0)
    delta_eb, tau2_lda = eb_shrink(d / sd, se_d / sd)
    d_eb = delta_eb * sd
    for lam in LAMBDAS:
        S = (1 - lam) * sigma_w + lam * np.diag(np.diag(sigma_w))
        for name, dd in ((f"lda_shrink_{lam}", d), (f"lda_eb_{lam}", d_eb)):
            w = np.linalg.solve(S, dd)
            b = -0.5 * float(w @ (p1 + p0)) + np.log(pi / (1 - pi))
            cands.append({"name": name, "features": feats, "weights": w.tolist(), "intercept": b})
    meta = {"n_train": n, "n_train_s1": n1, "n_features": len(feats), "pairs_released": used,
            "pairs_total": len(pairs), "tau2_nb": tau2_nb, "tau2_lda": tau2_lda,
            "source": "results/aggregate/04 (All of Us summary counts, each cell > 20, rounded up to 10)"}
    return {"meta": meta, "candidates": cands}


def site_candidate(agg, out_path):
    """Prespecified nb_eb from Task 16 (training-site) counts, written for Task 17."""
    c = next(c for c in fit(agg, "t16")["candidates"] if c["name"] == "nb_eb")
    json.dump(c, open(out_path, "w"), indent=1)
    return c


if __name__ == "__main__":
    import sys
    if len(sys.argv) > 1 and sys.argv[1] == "--site":
        c = site_candidate(os.path.join(ROOT, "results/aggregate/16"), os.path.join(ROOT, "workbench/src/transport_site_candidate.json"))
        print("wrote workbench/src/transport_site_candidate.json:", len(c["features"]), "features")
        raise SystemExit
    out = fit()
    os.makedirs(os.path.join(ROOT, "model/candidates"), exist_ok=True)
    path = os.path.join(ROOT, "model/candidates/transport_candidates.json")
    json.dump(out, open(path, "w"), indent=1)
    print(json.dumps(out["meta"], indent=1))
    for c in out["candidates"]:
        top = sorted(zip(c["features"], c["weights"]), key=lambda t: -abs(t[1]))[:5]
        print(c["name"], [(f, round(w, 2)) for f, w in top])
