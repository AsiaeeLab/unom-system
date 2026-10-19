"""Helpers that keep every exported number compliant with the All of Us
Data and Statistics Dissemination Policy.

The policy statement bars participant counts of "1 to 20"; other program pages
say "<20". Suppressing 1-20 inclusive satisfies both, so a count is released
only if it is 0 or at least 21.

Use these for every table written to the export folder.
"""

from __future__ import annotations

import io
import math
from typing import Iterable, Sequence

import pandas as pd

MAX_SUPPRESSED = 20   # counts 1..20 inclusive are suppressed
SUPPRESSED = "<=20"


def _is_small(value) -> bool:
    try:
        v = float(value)
    except (TypeError, ValueError):
        return False
    return (not math.isnan(v)) and 0 < v <= MAX_SUPPRESSED


def safe_counts(
    df: pd.DataFrame,
    count_cols: Sequence[str],
    rate_cols: Iterable[tuple[str, str, str]] = (),
    total_col: str | None = None,
) -> pd.DataFrame:
    """Return a copy of ``df`` with counts of 1-20 replaced by ``"<=20"``.

    count_cols: columns holding person counts.
    rate_cols: (rate_col, numerator_col, denominator_col) triples. A rate is
        suppressed when its numerator or denominator is small, or when the
        complement (denominator - numerator) is small.
    total_col: optional column holding each row's total. Any count whose
        complement ``total - count`` is between 1 and 20 is also suppressed,
        which blocks recovery of small cells by subtraction.
    """
    out = df.copy()
    raw = df.copy()
    for col in count_cols:
        small = raw[col].map(_is_small)
        if total_col is not None:
            comp = raw[total_col] - raw[col]
            small = small | comp.map(_is_small)
        out[col] = out[col].astype(object)
        out.loc[small, col] = SUPPRESSED
    for rate_col, num_col, den_col in rate_cols:
        bad = (
            raw[num_col].map(_is_small)
            | raw[den_col].map(_is_small)
            | (raw[den_col] - raw[num_col]).map(_is_small)
        )
        out[rate_col] = out[rate_col].astype(object)
        out.loc[bad, rate_col] = SUPPRESSED
    return out


def _num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


SECONDARY = "hidden"   # complementary suppression: the true value may be large


def protect(raw: pd.DataFrame, count_cols, complements=(), partition: bool = False,
            round_to: int = 10) -> pd.DataFrame:
    """Primary and complementary suppression computed from the raw counts.

    raw: numeric table. count_cols: participant-count columns.
    complements: (total_col, part_col) pairs whose difference is itself a
        participant count; ``part_col`` is hidden where the difference is 1-20.
    partition: rows form a partition whose column totals are available in this
        same table. Then each column must have either no hidden cell or at least
        two hidden cells whose values sum to more than 20, so no hidden value
        (or sum of hidden values) can be recovered as a count of 1-20.
    round_to: shown counts are rounded UP to a multiple of this base, so a
        difference between any two published counts is never exact. Use
        round_to=1 only for final paper tables checked by hand.
    Returns a copy with hidden cells replaced by ``SUPPRESSED``.
    """
    vals = raw[list(count_cols)].astype(float)
    hidden = (vals > 0) & (vals <= MAX_SUPPRESSED)
    primary = hidden.copy()
    for tot, part in complements:
        diff = raw[tot].astype(float) - raw[part].astype(float)
        hidden[part] |= (diff > 0) & (diff <= MAX_SUPPRESSED)
    if partition:
        for col in count_cols:
            while True:
                h = hidden[col]
                n_hidden, hidden_sum = int(h.sum()), float(vals.loc[h, col].sum())
                shown = vals.loc[~h & (vals[col] > 0), col]
                if n_hidden == 0 or shown.empty:
                    break
                if n_hidden >= 2 and hidden_sum > MAX_SUPPRESSED:
                    break
                hidden.loc[shown.idxmin(), col] = True
    out = raw.copy()
    for col in count_cols:
        shown = vals[col].map(lambda v: int(math.ceil(v / round_to) * round_to) if v > 0 else 0)
        out[col] = shown.astype(object)
        out.loc[hidden[col], col] = SECONDARY
        out.loc[primary[col], col] = SUPPRESSED
    return out


def rate(num: float, den: float, num_shown, den_shown) -> object:
    """Rate from exact counts, 3 significant figures; hidden if either count is hidden."""
    if isinstance(num_shown, str) or isinstance(den_shown, str) or not den:
        return SUPPRESSED
    return float(f"{num / den:.3g}")


def assert_no_person_level(df: pd.DataFrame) -> None:
    """Refuse to print tables that look participant-level."""
    lowered = {c.lower() for c in df.columns}
    forbidden = {"person_id", "research_id", "participant_id", "src_id"}
    if lowered & forbidden:
        raise ValueError(f"Refusing to print participant-level columns: {lowered & forbidden}")


def check_exportable(df: pd.DataFrame) -> None:
    """Raise if a table looks participant-level or still has counts of 1-20."""
    assert_no_person_level(df)
    for col in df.columns:
        if df[col].dtype.kind in "iu" and df[col].map(_is_small).any():
            raise ValueError(f"Column {col!r} has unsuppressed counts of 1-20")


def export_csv(name: str, df: pd.DataFrame, export_dir: str) -> str:
    """Write an already-suppressed aggregate table to the export folder.

    Only files in the export folder are ever copied out of Workbench, and only
    after a person has looked at them.
    """
    import os

    check_exportable(df)
    os.makedirs(export_dir, exist_ok=True)
    path = os.path.join(export_dir, f"{name}.csv")
    df.to_csv(path, index=False)
    return path


if __name__ == "__main__":
    demo = pd.DataFrame(
        {"group": ["A", "B", "C"], "n": [1000, 25, 12], "n_pos": [40, 19, 5]}
    )
    demo["rate"] = demo["n_pos"] / demo["n"]
    safe = safe_counts(demo, ["n", "n_pos"], rate_cols=[("rate", "n_pos", "n")], total_col="n")
    print(safe)
    check_exportable(safe)
    print("check_exportable passed")
