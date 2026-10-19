"""Task 16: summary counts for the exportable pipeline, fit on training sites only.

Runs inside the All of Us Workbench (bash ~/unm/bin/unm.sh run 16).
Inputs : ~/unm/output/{cohort_v2,features_v2}.parquet
Output : ~/unm/output/t16_split.parquet (role per person: fit, calibration, test; stays in Workbench)
Exports: ~/unm/export/16/t16_{label_counts,feature_label_counts,feature_margins,pair_counts}.csv

Test sites are exactly Task 03's held-out sites (same code and seed). Within the training sites,
people are split 70/30 into "fit" and "calibration" (seed 20261003). Counts are computed on "fit"
only, with Task 04's rules (each released cell > 20 on exact counts, rounded up to 10).
"""

from __future__ import annotations

import os
import sys

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from aou_safe import check_exportable  # noqa: E402
from t04_moments import summary_tables  # noqa: E402

OUT = os.path.expanduser("~/unm/output")
EXPORT = os.path.expanduser("~/unm/export/16")
FEATURES = "features_v2.parquet"   # participant-level feature file in ~/unm/output (a rerun wrapper may change it)
SITE_SEED = 20260928      # Task 03
SPLIT_SEED = 20261003


def site_split(cohort: pd.DataFrame) -> np.ndarray:
    """Task 03's held-out-site rule: shuffle sites, hold out whole sites until >= 20% of people."""
    site = cohort.site.astype(str)
    sizes = site.value_counts(sort=False).sample(frac=1.0, random_state=SITE_SEED)
    held, cum = [], 0
    for s_id, n in sizes.items():
        if cum >= 0.2 * len(site):
            break
        held.append(s_id)
        cum += n
    return site.isin(held).to_numpy()


def roles(cohort: pd.DataFrame) -> pd.Series:
    test = site_split(cohort)
    rng = np.random.default_rng(SPLIT_SEED)
    calib = (~test) & (rng.random(len(cohort)) < 0.3)
    role = np.where(test, "test", np.where(calib, "calibration", "fit"))
    return pd.Series(role, index=cohort.index, name="role")


def main():
    cohort = pd.read_parquet(os.path.join(OUT, "cohort_v2.parquet"))
    cohort = cohort[cohort.landmark_eligible == 1]
    F = pd.read_parquet(os.path.join(OUT, FEATURES)).loc[cohort.index]
    feats = [c for c in F.columns if not c.startswith("yout_")]
    role = roles(cohort)
    role.to_frame().to_parquet(os.path.join(OUT, "t16_split.parquet"))
    fit = (role == "fit").to_numpy()
    tables, keep = summary_tables(F.loc[fit, feats].astype(int), cohort.s.to_numpy()[fit].astype(int))
    os.makedirs(EXPORT, exist_ok=True)
    for name, df in tables.items():
        name = name.replace("t04_", "t16_")
        check_exportable(df)
        df.to_csv(os.path.join(EXPORT, f"{name}.csv"), index=False)
        print(f"exported {name} ({len(df)} rows)", flush=True)
    print(f"Task 16 finished: {len(keep)} eligible features", flush=True)


if __name__ == "__main__":
    main()
