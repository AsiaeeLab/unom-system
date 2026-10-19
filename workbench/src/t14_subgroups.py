"""Task 14: discrimination and calibration by group for the day-90 elastic net (M2).

Runs inside the All of Us Workbench (bash ~/unm/bin/unm.sh run 14).
Inputs : ~/unm/output/cohort_v2.parquet, features_v2.parquet
Export : ~/unm/export/14/t14_subgroups.csv

Disclosure: counts are suppressed and rounded within this table; every group is retained.
Observed rates use released rounded counts. Discrimination estimates require both label classes.
"""

from __future__ import annotations

import os
import sys

import numpy as np
import pandas as pd
from sklearn.metrics import roc_auc_score

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from aou_safe import SUPPRESSED, check_exportable, protect  # noqa: E402
from t13_landmarks import en_model, oof, r10  # noqa: E402

OUT = os.path.expanduser("~/unm/output")
EXPORT = os.path.expanduser("~/unm/export/14")
FEATURES = "features_v2.parquet"   # participant-level feature file in ~/unm/output (a rerun wrapper may change it)
N_BOOT = 200
SEED = 20261001


def boot_auc(y, s, rng):
    vals = []
    for _ in range(N_BOOT):
        i = rng.integers(0, len(y), len(y))
        if 0 < y[i].sum() < len(i):
            vals.append(roc_auc_score(y[i], s[i]))
    return np.percentile(vals, [2.5, 97.5])


def subgroup_table(cohort: pd.DataFrame, p: np.ndarray, y: np.ndarray) -> pd.DataFrame:
    rng = np.random.default_rng(SEED)
    rows = []
    for axis in ("sex", "race_eth", "age_band"):
        for g, idx in cohort.groupby(axis).indices.items():
            yy, pp = y[idx], p[idx]
            n, npos = len(idx), int(yy.sum())
            both = 0 < npos < n
            lo, hi = boot_auc(yy, pp, rng) if both else (np.nan, np.nan)
            rows.append({"axis": axis, "group": str(g), "n": n, "n_pos": npos,
                         "auroc": round(float(roc_auc_score(yy, pp)), 3) if both else SUPPRESSED,
                         "auroc_lo": round(float(lo), 3) if both else SUPPRESSED,
                         "auroc_hi": round(float(hi), 3) if both else SUPPRESSED,
                         "mean_predicted": round(float(pp.mean()), 4) if n > 1 else SUPPRESSED})
    raw = pd.DataFrame(rows)
    out = protect(raw, ["n", "n_pos"], complements=[("n", "n_pos")], partition=False)
    for col in ("n", "n_pos"):
        # A fully shown demographic axis supplies this column's total in the same table.
        if any(not group[col].map(lambda v: isinstance(v, str)).any() for _, group in out.groupby("axis")):
            for _, group in raw.groupby("axis"):
                comp = [("n", "n_pos")] if col == "n_pos" else []
                out.loc[group.index, col] = protect(group, [col], complements=comp, partition=True)[col]
    out["observed_rate_from_rounded"] = [round(pos / n, 4) if not isinstance(n, str) and not isinstance(pos, str) and n else SUPPRESSED
                                         for n, pos in zip(out.n, out.n_pos)]
    out["observed_to_predicted"] = [round(obs / pred, 2) if not isinstance(obs, str) and not isinstance(pred, str) and pred else SUPPRESSED
                                    for obs, pred in zip(out.observed_rate_from_rounded, out.mean_predicted)]
    return out


def main():
    cohort = pd.read_parquet(os.path.join(OUT, "cohort_v2.parquet"))
    cohort = cohort[cohort.landmark_eligible == 1]
    F = pd.read_parquet(os.path.join(OUT, FEATURES)).loc[cohort.index]
    X = F[[c for c in F.columns if not c.startswith("yout_")]].to_numpy(float)
    y = cohort.s.to_numpy().astype(int)
    p = oof(X, y, make=en_model)
    tab = subgroup_table(cohort, p, y)
    os.makedirs(EXPORT, exist_ok=True)
    check_exportable(tab)
    tab.to_csv(os.path.join(EXPORT, "t14_subgroups.csv"), index=False)
    print(f"Task 14 finished: {len(tab)} groups", flush=True)


if __name__ == "__main__":
    main()
