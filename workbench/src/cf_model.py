"""Chronic fatigue (ME/CFS) case-finding model: feature construction and the summary-count fit.

Shared by Task 30 (inside the Workbench) and analysis/build_cf_model.py (outside), so the model
evaluated inside is exactly the one built outside from the exported, rounded counts.
"""

from __future__ import annotations

import json
import os

import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
REG = json.load(open(os.path.join(HERE, "features_cf.json")))
WIN = {k: tuple(v) for k, v in REG["windows"].items()}
ROUND_EXCESS = 4.5      # counts are rounded up to a multiple of 10; mean excess of a count above 20
MIN_CELL = 21


def expand_cpt(items):
    out = []
    for it in items:
        if "-" in it and it.replace("-", "").isdigit():
            a, b = it.split("-")
            out += [str(x) for x in range(int(a), int(b) + 1)]
        else:
            out.append(it)
    return out


def condition_prefixes():
    return [(f["id"], p) for f in REG["conditions"] for p in f["icd10cm_prefix"]]


def procedure_codes():
    return [(f["id"], c) for f in REG["procedures"] for c in expand_cpt(f["cpt"])]


def visit_class(name) -> str:
    n = str(name or "").lower()
    if "inpatient" in n:
        return "IMP"
    if "emergency" in n:
        return "EMER"
    if "pharmacy" in n or "laboratory" in n:
        return "OTHER"
    return "AMB"


def feature_ids():
    ids = [f["id"] for f in REG["demographics"]] + [f["id"] for f in REG["conditions"]]
    ids += [f["id"] for f in REG["cluster_counts"]] + [f["id"] for f in REG["procedures"]]
    ids += [f["id"] for f in REG["labs"]] + [f["id"] for f in REG["medications"]] + [f["id"] for f in REG["utilization"]]
    return ids


def build_features(cohort: pd.DataFrame, events: pd.DataFrame, visits: pd.DataFrame) -> pd.DataFrame:
    """cohort: index person_id, columns age, sex ('Female'/'Male'/other).
    events: person_id, fid, max_off (latest offset in days before day 0, negative) for condition,
            procedure, lab, and medication features (any record in H).
    visits: person_id, visit_class, n_R, n_H (encounter counts in windows R and H)."""
    X = pd.DataFrame(0, index=cohort.index, columns=feature_ids(), dtype=int)
    for f in REG["demographics"]:
        if f["kind"] == "age_band":
            X[f["id"]] = ((cohort.age >= f["min"]) & (cohort.age <= f["max"] + 0.999)).astype(int)
        else:
            X[f["id"]] = (cohort.sex == "Female").astype(int)
    ev = events[events.person_id.isin(cohort.index)]
    for kind in ("conditions", "procedures", "labs", "medications"):
        for f in REG[kind]:
            lo, hi = WIN[f["window"]]
            fid_src = f.get("source_id", f["id"] if f["id"] != "cx_fatigue_recent" else "cx_fatigue_other")
            e = ev[(ev.fid == fid_src) & (ev.max_off >= lo) & (ev.max_off <= hi)]
            X.loc[X.index.isin(e.person_id), f["id"]] = 1
    clusters = {}
    for f in REG["conditions"]:
        if "cluster" in f:
            clusters.setdefault(f["cluster"], []).append(f["id"])
    ncl = sum((X[ids].max(axis=1) > 0).astype(int) for ids in clusters.values())
    for f in REG["cluster_counts"]:
        X[f["id"]] = (ncl >= f["threshold"]).astype(int)
    v = visits[visits.person_id.isin(cohort.index)]
    for f in REG["utilization"]:
        col = "n_R" if f["window"] == "R" else "n_H"
        cnt = v[v.visit_class.isin(f["encounter_class"])].groupby("person_id")[col].sum()
        X[f["id"]] = (cnt.reindex(X.index).fillna(0) >= f["threshold"]).astype(int)
    return X


def r10(v: int) -> int:
    return int(-(-int(v) // 10) * 10)


def label_tables(X: pd.DataFrame, y: np.ndarray, rounded: bool = True) -> pd.DataFrame:
    """2x2 table of each binary feature with the label; eligible only if every cell exceeds 20."""
    n, n1 = len(y), int(y.sum())
    rows = []
    for f in X.columns:
        x = X[f].to_numpy().astype(int)
        a, b = int((x & y).sum()), int((x & (1 - y)).sum())
        c, d = n1 - a, (n - n1) - b
        ok = min(a, b, c, d) >= MIN_CELL
        cells = [a, b, c, d]
        if rounded:
            cells = [r10(v) for v in cells] if ok else ["suppressed"] * 4
        rows.append({"feature": f, "eligible": ok, "n_x1_s1": cells[0], "n_x1_s0": cells[1],
                     "n_x0_s1": cells[2], "n_x0_s0": cells[3]})
    return pd.DataFrame(rows)


def eb_shrink(est, se):
    """Posterior means under est_j ~ N(theta_j, se_j^2), theta_j ~ N(0, tau^2)."""
    tau2 = max(0.0, float(np.mean(est ** 2) - np.mean(se ** 2)))
    return est * tau2 / (tau2 + se ** 2), tau2


def fit_nb_eb(table: pd.DataFrame, n1: float, n0: float, unround: bool = True) -> dict:
    """Naive Bayes with empirical-Bayes shrinkage of each feature's log odds ratio (Paper 1's
    prespecified model), from the feature-label tables and the label totals n1 (positives) and n0.
    With unround=True the rounding excess is subtracted from every count first, as for exported
    tables (the totals are passed already unrounded)."""
    t = table[table.eligible.astype(str).str.lower() == "true"].copy()
    cols = ["n_x1_s1", "n_x1_s0", "n_x0_s1", "n_x0_s0"]
    for c in cols:
        t[c] = pd.to_numeric(t[c]).astype(float) - (ROUND_EXCESS if unround else 0.0)
    p1 = (t.n_x1_s1 / (t.n_x1_s1 + t.n_x0_s1)).to_numpy()
    p0 = (t.n_x1_s0 / (t.n_x1_s0 + t.n_x0_s0)).to_numpy()
    w = np.log(p1 * (1 - p0) / (p0 * (1 - p1)))
    se = np.sqrt((1 / t[cols]).sum(axis=1).to_numpy())
    w_eb, tau2 = eb_shrink(w, se)
    m = ((t.n_x1_s1 + t.n_x1_s0) / (n1 + n0)).to_numpy()
    return {"features": list(t.feature), "weights": w_eb.tolist(), "intercept": float(np.log(n1 / n0) - w_eb @ m),
            "tau2": tau2, "n1": n1, "n0": n0}


def score(model: dict, X: pd.DataFrame) -> np.ndarray:
    return model["intercept"] + X[model["features"]].to_numpy(float) @ np.asarray(model["weights"])


def calibration_bins(s: np.ndarray, y: np.ndarray, n_bins: int = 10):
    """Score bins from the lowest score up, each with more than 20 positives and 20 negatives and at
    least 1/n_bins of people; returns a list of (lo, hi, mean_score, n, n_pos)."""
    order = np.argsort(s)
    bins, cur = [], []
    for i in order:
        cur.append(i)
        npos = int(y[cur].sum())
        if npos > 20 and len(cur) - npos > 20 and len(cur) >= len(y) / n_bins:
            bins.append(cur)
            cur = []
    if cur:
        if bins:
            bins[-1] += cur
        else:
            bins.append(cur)
    return [(float(s[b].min()), float(s[b].max()), float(s[b].mean()), len(b), int(y[b].sum())) for b in bins]
