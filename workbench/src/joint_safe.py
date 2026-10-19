"""Primary and complementary suppression within a single released table.

Only released counts, their direct total/part relationships, and explicitly listed
partitions are checked. Counts from other tables and arbitrary linear combinations
of overlapping groups do not constrain a release. Rates use counts rounded up to 10.
"""

from __future__ import annotations

import math

import numpy as np
import pandas as pd

MAX_SUPPRESSED = 20
SUPPRESSED = "<=20"
FLAGGED = "<=20 flagged"     # primary small count
JOINT = "<=20 jointly"       # within-table complementary suppression


def r10(v) -> int:
    """Round a count up to a multiple of 10 (0 stays 0)."""
    return int(math.ceil(float(v) / 10.0) * 10) if v > 0 else 0


def _violations(sets, known, partitions=(), limit=MAX_SUPPRESSED, cells=()):
    """Direct counts and total-minus-listed-parts identities in this table."""
    masks = {c: np.asarray(sets[c], dtype=bool) for c in known}
    counts = {c: int(m.sum()) for c, m in masks.items()}
    bad = [(counts[c], (c,)) for c in known if 0 < counts[c] <= limit]
    for total in known:
        for part in known:
            diff = counts[total] - counts[part]
            if 0 < diff <= limit and not (masks[part] & ~masks[total]).any():
                bad.append((diff, (total, part)))
    for total, parts in partitions:
        if total not in masks:
            continue
        shown = [p for p in parts if p in masks]
        hidden = [p for p in parts if p not in masks]
        remainder = counts[total] - sum(counts[p] for p in shown)
        if hidden and ((len(hidden) == 1 and hidden[0] in cells) or 0 < remainder <= limit):
            bad.append((remainder, (total, *shown)))
    return bad


def small_derivable(sets: dict, known, exclude=(), limit: int = MAX_SUPPRESSED) -> list[int]:
    """Small direct total-minus-part counts; excluded counts are not in this table."""
    return [n for n, _ in _violations(sets, [c for c in known if c not in exclude], limit=limit)]


def joint_status(sets: dict, cells, structural=(), priority=None, limit: int = MAX_SUPPRESSED,
                 partitions=()) -> dict:
    """Primary suppression and within-table complements only.

    ``structural`` is retained for callers of the former API, but counts not in
    ``cells`` are never used. Partitions name a total and its disjoint listed parts.
    """
    if priority is None:
        priority = lambda c: (int(np.asarray(sets[c]).sum()), c)  # noqa: E731
    status = {c: FLAGGED for c in cells if 0 < int(np.asarray(sets[c]).sum()) <= limit}
    released = [c for c in cells if c not in status]
    while released:
        bad = _violations(sets, released, partitions, limit, cells)
        if not bad:
            break
        _, terms = bad[0]
        drop = min(terms, key=priority)
        status[drop] = JOINT
        released.remove(drop)
    status.update({c: "ok" for c in released})
    return status


def protect_counts(sets: dict, cells, structural=(), priority=None, partitions=()) -> dict:
    """Rounded counts with primary and within-table complementary suppression."""
    st = joint_status(sets, cells, structural, priority, partitions=partitions)
    return {c: r10(np.asarray(sets[c]).sum()) if st[c] == "ok"
            else SUPPRESSED if st[c] == FLAGGED else JOINT for c in cells}


# ---------------------------------------------------------------- performance metrics

def pct(f: float) -> int:
    return int(round(f * 100))


def top_k(s: np.ndarray, k: int, tiebreak=None) -> np.ndarray:
    """Indices of exactly the k highest scores. tiebreak None: np.argsort(-s) order (the Task 30, 33, and 39
    rule, kept so Task 44 reproduces their flagged sets); otherwise ties are broken by the tiebreak values."""
    order = np.argsort(-s) if tiebreak is None else np.lexsort((np.asarray(tiebreak), -np.asarray(s)))
    return order[:k]


def flagged_sets(s: np.ndarray, targets: dict, fracs, tiebreak=None):
    """Sets for one model: everyone, each top-k flagged set, each target, and each target within each flagged set."""
    s = np.asarray(s, dtype=float)
    n = len(s)
    sets = {"all": np.ones(n, bool)}
    for f in fracs:
        m = np.zeros(n, bool)
        m[top_k(s, max(1, int(round(f * n))), tiebreak)] = True
        sets[f"top{pct(f)}"] = m
    for t, y in targets.items():
        sets[f"T:{t}"] = np.asarray(y).astype(bool)
    cells = {}
    for t in targets:
        for f in fracs:
            c = f"C:{t}@{pct(f)}"
            sets[c] = sets[f"T:{t}"] & sets[f"top{pct(f)}"]
            cells[c] = (t, f)
    structural = ["all"] + [f"top{pct(f)}" for f in fracs] + [f"T:{t}" for t in targets]
    return sets, cells, structural


def metric_columns(fracs) -> list[str]:
    cols = ["model", "target", "auroc", "auprc"]
    for f in fracs:
        cols += [f"recall_top{pct(f)}", f"ppv_top{pct(f)}"]
    return cols + ["auroc_lo", "auroc_hi", "auprc_lo", "auprc_hi", "recall_top5_lo", "recall_top5_hi"]


def _r(v, nd):
    return round(float(v), nd) if isinstance(v, (int, float, np.floating, np.integer)) else v


def metrics_table(scores: dict, targets: dict, ci_fn, fracs=(0.05, 0.10), drop_first=(), tiebreak=None):
    """Validation metrics without guards based on counts in separate tables.

    scores: model -> score array; targets: target name -> 0/1 array (same people). ci_fn(y, s) returns a dict
    with auroc, auprc, auroc_lo, auroc_hi, auprc_lo, auprc_hi, recall_top5_lo, recall_top5_hi (AUROC and
    AUPRC and their intervals pass through unchanged). For each model the flagged sets are computed once, so
    every target is evaluated on the same people. PPV = TP_r / k_r and recall = TP_r / P_r, with counts rounded
    up to 10. No count denominators are released in this table; estimate cells are
    not hidden using separate cohort tables. drop_first is retained for API compatibility.
    Returns (table, status, tp) where status and tp are keyed by (model, target, frac).
    """
    rows, status_all, tp_all = [], {}, {}
    for m, s in scores.items():
        sets, cells, structural = flagged_sets(s, targets, fracs, tiebreak)
        tp = {c: int(sets[c].sum()) for c in cells}
        # This metrics-only table publishes no participant-count denominators.
        # A count in a separate cohort/label table does not constrain this release.
        st = {c: "ok" for c in cells}
        for t, y in targets.items():
            y = np.asarray(y).astype(int)
            base = ci_fn(y, np.asarray(s, dtype=float))
            row = {"model": m, "target": t, "auroc": _r(base["auroc"], 4), "auprc": _r(base["auprc"], 4)}
            P = int(y.sum())
            for f in fracs:
                c = f"C:{t}@{pct(f)}"
                k = int(sets[f"top{pct(f)}"].sum())
                status_all[(m, t, f)], tp_all[(m, t, f)] = st[c], tp[c]
                if st[c] == "ok":
                    row[f"recall_top{pct(f)}"] = round(r10(tp[c]) / r10(P), 4) if P else 0.0
                    row[f"ppv_top{pct(f)}"] = round(r10(tp[c]) / r10(k), 4)
                else:
                    row[f"recall_top{pct(f)}"] = row[f"ppv_top{pct(f)}"] = st[c]
            for key in ("auroc_lo", "auroc_hi", "auprc_lo", "auprc_hi"):
                row[key] = _r(base[key], 4)
            c5 = f"C:{t}@5"
            for key in ("recall_top5_lo", "recall_top5_hi"):
                row[key] = _r(base[key], 3) if st.get(c5, "ok") == "ok" else st[c5]
            rows.append(row)
    return pd.DataFrame(rows)[metric_columns(fracs)], status_all, tp_all
