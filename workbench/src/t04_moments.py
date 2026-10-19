"""Task 04: summary statistics for the exportable (transport) model.

Runs inside the All of Us Workbench (bash ~/unm/bin/unm.sh run 04).
Inputs : ~/unm/output/cohort_v2.parquet, ~/unm/output/features_v1.parquet
Exports: ~/unm/export/04/ (counts only; every released cell is 0 or more than 20)

The All of Us FAQ allows exporting a model trained only on dissemination-compliant
summary statistics. This task computes, on a TRAINING split (80% of people, seed
fixed and saved so Task 05 can evaluate on the other 20%):
  - t04_label_counts: n and n with s=1;
  - t04_feature_label_counts: for each binary feature j, the 2x2 table with the label;
  - t04_pair_counts: for each pair (j, k), the co-occurrence count n_jk; 1-20 is
    suppressed and zero may be released. No margins or totals are present in this table.
Features are eligible only if all four cells of their label 2x2 table exceed 20 (checked
on exact counts). Every released count is then rounded up to a multiple of 10, as
the project's disclosure rules require for working exports; the model fit outside Workbench tolerates
this (counts are in the hundreds to thousands).
"""

from __future__ import annotations

import itertools
import os
import sys

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from aou_safe import check_exportable, protect  # noqa: E402

OUT = os.path.expanduser("~/unm/output")
EXPORT = os.path.expanduser("~/unm/export/04")
FEATURES = "features_v2.parquet"   # participant-level feature file in ~/unm/output (a rerun wrapper may change it)
SEED = 20260929
MIN_CELL = 21


def r10(v: int) -> int:
    """Round a count up to a multiple of 10 (0 stays 0)."""
    return int(-(-int(v) // 10) * 10)


def summary_tables(X: pd.DataFrame, y: np.ndarray):
    """Rounded label tables, margins, and pair counts for binary features X and labels y (cells > 20 only)."""
    feats = list(X.columns)
    n, n1 = len(y), int(y.sum())
    rows, keep = [], []
    for f in feats:
        x = X[f].to_numpy()
        a, b = int((x & y).sum()), int((x & (1 - y)).sum())
        c, d = n1 - a, (n - n1) - b
        ok = min(a, b, c, d) >= MIN_CELL
        rows.append({"feature": f, "eligible": ok,
                     "n_x1_s1": r10(a) if ok else "suppressed", "n_x1_s0": r10(b) if ok else "suppressed",
                     "n_x0_s1": r10(c) if ok else "suppressed", "n_x0_s0": r10(d) if ok else "suppressed"})
        if ok:
            keep.append(f)
    fl = pd.DataFrame(rows)
    Xk = X[keep].to_numpy()
    colsum = Xk.sum(axis=0)
    co = Xk.T @ Xk
    pair_rows = []
    for i, j in itertools.combinations(range(len(keep)), 2):
        nij = int(co[i, j])
        pair_rows.append({"feature_a": keep[i], "feature_b": keep[j], "n_both": nij})
    pl = protect(pd.DataFrame(pair_rows, columns=["feature_a", "feature_b", "n_both"]), ["n_both"])
    marg = pd.DataFrame({"feature": keep, "n_x1": [r10(v) for v in colsum]})
    lab = pd.DataFrame({"measure": ["n_train", "n_train_s1"], "value": [r10(n), r10(n1)]})
    return {"t04_label_counts": lab, "t04_feature_label_counts": fl, "t04_feature_margins": marg,
            "t04_pair_counts": pl}, keep


def main():
    cohort = pd.read_parquet(os.path.join(OUT, "cohort_v2.parquet"))
    cohort = cohort[cohort.landmark_eligible == 1]
    F = pd.read_parquet(os.path.join(OUT, FEATURES if os.path.exists(os.path.join(OUT, FEATURES)) else "features_v1.parquet")).loc[cohort.index]
    feats = [c for c in F.columns if not c.startswith("yout_")]
    rng = np.random.default_rng(SEED)
    train = rng.random(len(cohort)) < 0.8
    pd.Series(train, index=cohort.index, name="train").to_frame().to_parquet(os.path.join(OUT, "t04_split.parquet"))
    X = F.loc[train, feats].astype(int)
    y = cohort.s.to_numpy()[train].astype(int)
    print("training split built", flush=True)
    tables, keep = summary_tables(X, y)
    lab, fl, marg, pl = (tables[k] for k in ("t04_label_counts", "t04_feature_label_counts", "t04_feature_margins", "t04_pair_counts"))
    os.makedirs(EXPORT, exist_ok=True)
    for name, df in {"t04_label_counts": lab, "t04_feature_label_counts": fl,
                     "t04_feature_margins": marg, "t04_pair_counts": pl}.items():
        check_exportable(df)
        df.to_csv(os.path.join(EXPORT, f"{name}.csv"), index=False)
        print(f"exported {name} ({len(df)} rows)", flush=True)
    print(f"Task 04 finished: {len(keep)} eligible features", flush=True)


if __name__ == "__main__":
    main()
