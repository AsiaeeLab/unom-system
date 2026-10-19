"""Frozen-score uncertainty; no model or calibration-map fitting."""
import numpy as np
import pandas as pd
import p1_summary_core as core


def ordinary_indices(y, n_boot=500):
    rng = np.random.default_rng(20261017)
    for _ in range(n_boot):
        yield rng.integers(0, len(y), size=len(y))


def diagnostics(y, p):
    # A one-class resample has no finite calibration fit. Brier remains defined.
    if len(np.unique(y)) < 2:
        return np.array([np.nan, np.nan, np.mean((p-y)**2)])
    return core.calibration_diagnostics(y, p)[:3]


def final_metrics(y, p, n_boot=500):
    y, p = np.asarray(y), np.asarray(p)
    point = core.calibration_diagnostics(y, p)
    ordinary = np.array([diagnostics(y[ix], p[ix]) for ix in ordinary_indices(y, n_boot)])
    stratified = np.array([core.discrimination(y[ix], p[ix]) for ix in core.bootstrap_indices(y, n_boot)])
    boot = np.column_stack([ordinary, stratified])
    rows = []
    for j, metric in enumerate(('calibration_intercept_in_large', 'calibration_slope', 'Brier', 'AUROC', 'AUPRC')):
        valid = np.isfinite(boot[:, j])
        lo, hi = np.quantile(boot[:, j], [.025, .975]) if valid.all() else (np.nan, np.nan)
        rows.append(dict(metric=metric, estimate=float(point[j]), lower=float(lo), upper=float(hi),
                         uncertainty='available' if valid.all() else 'unavailable: unidentifiable bootstrap fit',
                         valid_resamples=f'{valid.sum()} resamples',
                         bootstrap_scheme='ordinary patient' if j < 3 else 'outcome-stratified patient'))
    return pd.DataFrame(rows)
