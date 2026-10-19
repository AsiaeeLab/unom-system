"""Task 47 (Paper 1): subgroup and threshold tables for the current model, and five corrective analyses after
the October 7 audit.

Runs inside the All of Us Workbench (bash ~/unm/bin/unm.sh run 47).

Inputs in ~/unm/output (the script stops with a clear message when one is missing):
  cohort_v2.parquet, covid_pasc_events.parquet (Task 01); features_v3.parquet
  (matrix A, Task 35); t03_oof_scores.parquet (Task 35's Task 03 out-of-fold scores); t04_split.parquet and
  t16_split.parquet (Task 35's training split and site roles). ~/unm/src/coding_fractions.json.
  CDR (part B and C only): measurement, concept, and the six feature tables with their *_ext source tables.

Parts and exports (~/unm/export/47/). Each part runs on its own; a failed part is listed in t47_status and the
script exits with an error after the other parts finish.
 A. Subgroup and threshold tables for the current model. One explicit flag set per score: the top 5% by
    np.argsort(-score), the rule of Task 03's t03_performance; recall, PPV, and shares from rounded counts.
    t47_t03_subgroups: Task 03 subgroup table (Task 35 rerun) from the saved out-of-fold M2 and M4 scores, with
        an overall row.
    t47_t14_subgroups, t47_t15_threshold_subgroups, t47_t15_adjustment: Tasks 14 and 15 (Task 35 rerun) from one
        out-of-fold elastic-net score on matrix A (Task 13's en_model and folds), with overall rows.
    t47_decision_curve: net benefit of the matrix-A M2 out-of-fold scores from rounded counts (replaces Task 13's
        decision curve, which used Task 13's own landmark-90 elastic net).
 B. Laboratory classification. t47_labs_feature_counts, t47_labs_performance: Task 21 rerun with
    negation-aware value-concept tokens ("abnormal" counts, "non-reactive" and "not detected" do not), reference
    bounds used per test and direction (a missing or zero bound no longer disables the unit fallback), and unit
    fallbacks matched on the UCUM unit code as well as the unit name. Features_v3 base, as in Task 21.
 C. Source grouping. t47_source_grouping: missing and tied index-event source identifiers, participants
    with feature-table records (days -365 to 90) from more than one source, record shares from a source other
    than the index-event source, and cross-source records between held-out and training sites.
 D. Era-safe coded share. t47_era_safe_coded_share: coding-gap cohort restricted to shifted index dates on
    or after 2021-09-30, so that days 1-455 all fall on or after October 1, 2021 (true dates are never earlier
    than shifted dates); coded share by group.
 E. Table 1 denominators. t47_table1_denominators: coding-gap and landmark-eligible counts by group, with
    both percentages from rounded counts.
 F. Development versus evaluation. t47_dev_eval_characteristics: training split, validation split,
    held-out sites, and training sites.
 t47_status: one row per part (ok, or the exception type).

Disclosure (the dissemination policy, read literally):
 1. a count of 1-20 is shown as "<=20"; other counts are rounded up to a multiple of 10;
 2. rates and shares are computed from counts rounded up to 10 (the record shares of t47_source_grouping from
    record counts rounded the same way) and are hidden with any count they use (a record share with the
    participant count of its row);
 3. complementary suppression within one table, where that table shows a total: if one of the counts that add up
    to the total is hidden, the nonzero counts of that total that are not shown (hidden, or groups the table
    leaves out) must be two or more and add up to more than 20, so a shown total never has exactly one count
    that is not shown; otherwise the smallest shown nonzero count of the same total is hidden too, shown as
    "hidden" (its value may be large), and the check repeats. The totals: the overall row of each subgroup table
    for every count behind a cell (also the flagged and flagged-coded counts behind recall, PPV, and share
    flagged); the landmark cohort for the index-event source types and the two site populations; in
    t47_dev_eval_characteristics, the "patients" row of each split column for each axis, and within each row
    the two splits of the cohort (training plus validation split equals held-out plus training sites). A cell of
    that table belongs to two totals, so the equations of all of a table's totals are then solved together, and
    while they still determine a "<=20" count exactly, one more count of a total that contains it is hidden.
 Nothing else: no checks against other tables or earlier releases, and no checks of complements that are not
 cells of the table (for example coded patients not flagged).
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import traceback

import numpy as np
import pandas as pd
from sklearn.metrics import average_precision_score, roc_auc_score

try:  # BigQuery date columns saved by Task 01 load as 'dbdate' and need this extension type
    import db_dtypes  # noqa: F401
except ImportError:
    pass

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import t13_landmarks as t13  # noqa: E402
import t14_subgroups as t14  # noqa: E402
import t16_site_counts as t16  # noqa: E402
import t21_labs_vitals as t21  # noqa: E402
from aou_safe import MAX_SUPPRESSED, SECONDARY, SUPPRESSED, check_exportable  # noqa: E402

CDR_ID = os.environ.get("UNM_CDR_ID", "R2025Q4R6")
OUT = os.path.expanduser("~/unm/output")
EXPORT = os.path.expanduser("~/unm/export/47")
HERE = os.path.dirname(os.path.abspath(__file__))
LEFT_OUT = "left out"                # internal: a group the table does not list (never exported)
SEED = 20261011                      # bootstrap draws and the solver's random state in this task
FEATURES_A = "features_v3.parquet"   # matrix A (Task 35)
OOF_A = "t03_oof_scores.parquet"     # Task 35's Task 03 out-of-fold scores (as in results/aggregate/35)
LABS_OUT = "features_v2_labs_t47.parquet"
T03_MODELS = ("M2_elastic_net_logistic", "M4_pu_bagging")
THRESHOLDS = (0.005, 0.01, 0.015, 0.02, 0.03, 0.05)
ERA_SAFE_START = pd.Timestamp("2021-09-30")   # shifted index on or after this: day 1 is on or after 2021-10-01
N_BOOT = 200
DESCRIBE = {"acute_inpatient": "hospitalized around the COVID-19 diagnosis", "acute_ed": "emergency visit in days 0-30",
            "out_w0_ge4": "4+ outpatient visits in days -365 to -91", "out_w3_ge2": "2+ outpatient visits in days 31-90",
            "sym_count_ge2": "two or more new symptom types", "covid_code_w3": "COVID-19 still coded in days 31-90",
            "hx_obesity": "history of obesity", "hx_hypertension": "history of hypertension",
            "hx_depression": "history of depression"}
MISSING_SRC = {"", "none", "nan", "<na>", "null"}


# ----------------------------------------------------------------------------
# Disclosure helpers
# ----------------------------------------------------------------------------

def r10(v) -> int:
    """Round a count up to a multiple of 10 (0 stays 0)."""
    v = int(v)
    return int(-(-v // 10) * 10) if v > 0 else 0


def bad(d) -> bool:
    """True when an exact count or difference is 1-20."""
    return 0 < int(d) <= MAX_SUPPRESSED


def rate(num, den, nd):
    """Rate from counts rounded up to 10."""
    return round(r10(num) / r10(den), nd) if r10(den) else 0.0


def sum_cells(parts, totals) -> list:
    """Every cell of one (parts, totals) pair of protect_totals."""
    return [*parts, *(c for way in totals for c in way)]


def solvable(st: dict, sums) -> list:
    """Cells shown as "<=20" whose exact count follows from the table's totals taken together.

    The equations are sum(parts) = sum(way) for every way of every total in sums; shown cells are known, every
    other cell (hidden or left out) is unknown. An unknown cell is solvable when it has no weight in the null
    space of the equations, so every solution gives it the same value."""
    unknown = list(dict.fromkeys(c for parts, totals in sums for c in sum_cells(parts, totals) if st[c] is not None))
    if not unknown:
        return []
    pos = {c: i for i, c in enumerate(unknown)}
    rows = []
    for parts, totals in sums:
        for way in totals:
            r = np.zeros(len(unknown))
            for c, sign in [(c, 1.0) for c in parts] + [(c, -1.0) for c in way]:
                if c in pos:
                    r[pos[c]] += sign
            rows.append(r)
    _, sv, vt = np.linalg.svd(np.array(rows))
    null = vt[int((sv > 1e-9).sum()):]
    return [c for c in unknown if st[c] == SUPPRESSED and np.abs(null[:, pos[c]]).max(initial=0.0) < 1e-9]


def protect_totals(values: dict, st: dict, sums) -> dict:
    """Complementary suppression within one table; updates and returns st.

    values: {cell: exact count}. st: {cell: None (shown), SUPPRESSED, SECONDARY, or LEFT_OUT}.
    sums: (parts, totals) pairs. The counts of the cells in parts add up to one total; totals lists the ways the
        table shows that total, each a list of cells (one cell, or cells that add up to the same total). The total
        counts as shown when every cell of one way is shown.
    Where the total is shown and a part is hidden (SUPPRESSED or SECONDARY), the nonzero parts that are not shown
    (hidden or left out of the table) must be two or more and add up to more than 20, so the total minus the
    shown parts never gives one count or a count of 1-20; otherwise the smallest shown nonzero part becomes
    SECONDARY. Repeats until every total holds. A part that is only left out of the table is not a hidden cell
    and does not start the check. Then, because a cell can belong to two totals (the development table), the
    equations of all the totals are solved together (solvable): while a SUPPRESSED cell is still determined, the
    smallest shown nonzero cell of a total that contains it becomes SECONDARY and both steps repeat."""
    while True:
        changed = True
        while changed:
            changed = False
            for parts, totals in sums:
                if not any(all(st[c] is None for c in way) for way in totals):
                    continue
                if not any(st[c] in (SUPPRESSED, SECONDARY) for c in parts):
                    continue
                unseen = [c for c in parts if st[c] is not None and values[c] > 0]
                if len(unseen) != 1 and not bad(sum(values[c] for c in unseen)):
                    continue
                shown = [c for c in parts if st[c] is None and values[c] > 0]
                if shown:
                    st[min(shown, key=lambda c: (values[c], str(c)))] = SECONDARY
                    changed = True
        solved = solvable(st, sums)
        if not solved:
            return st
        near = [c for parts, totals in sums if solved[0] in sum_cells(parts, totals)
                for c in sum_cells(parts, totals) if st[c] is None and values[c] > 0]
        near = near or [c for parts, totals in sums for c in sum_cells(parts, totals) if st[c] is None and values[c] > 0]
        if not near:
            raise RuntimeError("complementary suppression found no count left to hide")
        st[min(near, key=lambda c: (values[c], str(c)))] = SECONDARY


def group_status(groups: dict, overall: dict, counts, listed=None) -> dict:
    """Display status of each count of one subgroup table: None (shown), SUPPRESSED, or SECONDARY.

    groups: {name: {count: exact}} for every group of one axis (the groups partition the overall population).
    overall: {count: exact}, shown in the same table. listed: groups shown in the table (default all). Each count
    of 1-20 is SUPPRESSED; then, for each count, the groups and the overall row form one total (protect_totals),
    with the groups the table leaves out among its parts.
    """
    keep = set(groups) if listed is None else set(listed)
    values = {("overall", c): int(overall[c]) for c in counts}
    st = {("overall", c): (SUPPRESSED if bad(overall[c]) else None) for c in counts}
    for g, v in groups.items():
        for c in counts:
            values[(g, c)] = int(v[c])
            st[(g, c)] = (SUPPRESSED if bad(v[c]) else None) if g in keep else LEFT_OUT
    sums = [([(g, c) for g in groups], [[("overall", c)]]) for c in counts]
    return protect_totals(values, st, sums)


def cell(st: dict, row: str, deps, value):
    """A released value, or the suppression marker of its first hidden dependency."""
    marks = [st[(row, d)] for d in deps]
    if SUPPRESSED in marks:
        return SUPPRESSED
    if any(m is not None for m in marks):
        return SECONDARY
    return value() if callable(value) else value


def counts_by_group(frame: pd.DataFrame, axis: str, masks: dict):
    """({group: {count: exact}}, {count: exact overall}, {group: positional index array})."""
    idx = {str(g): v for g, v in frame.groupby(axis).indices.items()}
    groups = {g: {c: int(np.asarray(m)[i].sum()) for c, m in masks.items()} for g, i in idx.items()}
    overall = {c: int(np.asarray(m).sum()) for c, m in masks.items()}
    return groups, overall, idx


def top_mask(score, frac=0.05) -> np.ndarray:
    """The flagged set: exactly round(frac * n) highest scores, ordered by np.argsort(-score) (Task 03's rule)."""
    s = np.asarray(score, dtype=float)
    k = max(1, int(round(frac * len(s))))
    m = np.zeros(len(s), bool)
    m[np.argsort(-s)[:k]] = True
    return m


def need(name: str, task: str) -> str:
    path = os.path.join(OUT, name)
    if not os.path.exists(path):
        raise FileNotFoundError(f"Task 47 needs ~/unm/output/{name} (written by Task {task}); it is missing")
    return path


def export(name: str, df: pd.DataFrame) -> None:
    os.makedirs(EXPORT, exist_ok=True)
    check_exportable(df)
    df.to_csv(os.path.join(EXPORT, f"{name}.csv"), index=False)
    print(f"exported {name} ({len(df)} rows)", flush=True)


def seeded_oof(X: np.ndarray, y: np.ndarray) -> np.ndarray:
    """Task 13's out-of-fold elastic net (same folds); the saga solver draws from numpy's global state, seeded here."""
    np.random.seed(SEED)
    return t13.oof(X, y, make=t13.en_model)


# ----------------------------------------------------------------------------
# A. Subgroup and threshold tables for the current model
# ----------------------------------------------------------------------------

def t03_subgroups(cohort: pd.DataFrame, S: pd.DataFrame) -> pd.DataFrame:
    """Task 03's subgroup table: n, coded, AUROC, and top-5% recall and PPV for M2 and M4, plus the overall row."""
    y = cohort.s.to_numpy().astype(int) == 1
    masks = {"n": np.ones(len(y), bool), "npos": y}
    for m in T03_MODELS:
        top = top_mask(S[m].to_numpy())
        masks[f"flag_{m}"], masks[f"tp_{m}"] = top, top & y
    out = []
    for axis in ("sex", "age_band", "race_eth"):
        groups, overall, idx = counts_by_group(cohort, axis, masks)
        st = group_status(groups, overall, list(masks))
        for g in (["overall"] if axis == "sex" else []) + list(groups):
            v = overall if g == "overall" else groups[g]
            i = np.arange(len(y)) if g == "overall" else idx[g]
            rec = {"axis": "overall" if g == "overall" else axis, "category": "all" if g == "overall" else g,
                   "n_people": cell(st, g, ["n"], r10(v["n"])), "n_pos": cell(st, g, ["npos"], r10(v["npos"]))}
            for m in T03_MODELS:
                ok = 0 < v["npos"] < v["n"]
                rec[f"auroc_{m}"] = round(float(roc_auc_score(y[i], S[m].to_numpy()[i])), 4) if ok else SUPPRESSED
                rec[f"recall_top5_{m}"] = cell(st, g, [f"tp_{m}", "npos"], lambda: rate(v[f"tp_{m}"], v["npos"], 4))
                rec[f"ppv_top5_{m}"] = cell(st, g, [f"tp_{m}", f"flag_{m}"], lambda: rate(v[f"tp_{m}"], v[f"flag_{m}"], 4))
            out.append(rec)
    return pd.DataFrame(out)


def t14_table(cohort: pd.DataFrame, p: np.ndarray) -> pd.DataFrame:
    """Task 14's table, including all groups and the overall row; protect counts within this table."""
    y = cohort.s.to_numpy().astype(int)
    rng = np.random.default_rng(t14.SEED)
    masks = {"n": np.ones(len(y), bool), "npos": y == 1}
    out = []
    for axis in ("sex", "race_eth", "age_band"):
        groups, overall, idx = counts_by_group(cohort, axis, masks)
        listed = list(groups)
        st = group_status(groups, overall, ["n", "npos"], listed)
        for g in (["overall"] if axis == "sex" else []) + listed:
            v = overall if g == "overall" else groups[g]
            i = np.arange(len(y)) if g == "overall" else idx[g]
            yy, pp = y[i], p[i]
            both = 0 < v["npos"] < v["n"]
            lo, hi = t14.boot_auc(yy, pp, rng) if both else (np.nan, np.nan)
            obs = r10(v["npos"]) / r10(v["n"])
            out.append({"axis": "overall" if g == "overall" else axis, "group": "all" if g == "overall" else g,
                        "n": cell(st, g, ["n"], r10(v["n"])), "n_pos": cell(st, g, ["npos"], r10(v["npos"])),
                        "auroc": round(float(roc_auc_score(yy, pp)), 3) if both else SUPPRESSED,
                        "auroc_lo": round(float(lo), 3) if both else SUPPRESSED,
                        "auroc_hi": round(float(hi), 3) if both else SUPPRESSED,
                        "observed_rate_from_rounded": cell(st, g, ["n", "npos"], round(obs, 4)),
                        "mean_predicted": round(float(pp.mean()), 4) if len(pp) > 1 else SUPPRESSED,
                        "observed_to_predicted": cell(st, g, ["n", "npos"], round(obs / float(pp.mean()), 2))})
    return pd.DataFrame(out)


def t15_threshold(cohort: pd.DataFrame, p: np.ndarray) -> pd.DataFrame:
    """Task 15's threshold table at the top-5% flag set, including all groups and the overall row."""
    y = cohort.s.to_numpy().astype(int) == 1
    top = top_mask(p)
    masks = {"n": np.ones(len(y), bool), "flag": top, "coded": y, "tp": top & y}
    out = []
    for axis in ("sex", "race_eth", "age_band"):
        groups, overall, _ = counts_by_group(cohort, axis, masks)
        listed = list(groups)
        st = group_status(groups, overall, list(masks), listed)
        for g in (["overall"] if axis == "sex" else []) + listed:
            v = overall if g == "overall" else groups[g]
            out.append({"axis": "overall" if g == "overall" else axis, "group": "all" if g == "overall" else g,
                        "n": cell(st, g, ["n"], r10(v["n"])),
                        "share_flagged": cell(st, g, ["flag", "n"], rate(v["flag"], v["n"], 3)),
                        "coded_recall": cell(st, g, ["tp", "coded"], rate(v["tp"], v["coded"], 3)),
                        "ppv": cell(st, g, ["tp", "flag"], rate(v["tp"], v["flag"], 3))})
    return pd.DataFrame(out)


def t15_adjustment(cohort: pd.DataFrame, p: np.ndarray, cf: dict) -> pd.DataFrame:
    """Task 15's adjustment table: women's scores divided by the coding ratio r, one row per ranking, and the share
    of women in the cohort. No participant counts or count denominators are released in this table."""
    fem = (cohort.sex == "Female").to_numpy()
    y = cohort.s.to_numpy().astype(int) == 1
    specs = [("unadjusted", "", 1.0)]
    for defn in ("ever", "current"):
        d = cf["sex"][defn]
        specs += [("adjusted, point ratio", defn, d["ratio"]), ("adjusted, lower bound", defn, d["lo"]),
                  ("adjusted, upper bound", defn, d["hi"])]
    npos = int(y.sum())
    out = []
    for name, defn, r in specs:
        score = p / np.where(fem, r, 1.0)
        top = top_mask(score)
        k, fk, tp = int(top.sum()), int((fem & top).sum()), int((y & top).sum())
        out.append({"ranking": name, "definition": defn, "women_to_men_ratio": r,
                    "share_women_top5": rate(fk, k, 3),
                    "coded_recall_top5": rate(tp, npos, 3),
                    "auroc_coded": round(float(roc_auc_score(y, score)), 4)})
    nf, n = int(fem.sum()), len(fem)
    out.append({"ranking": "cohort", "definition": "", "women_to_men_ratio": "",
                "share_women_top5": rate(nf, n, 3),
                "coded_recall_top5": "", "auroc_coded": ""})
    return pd.DataFrame(out)


def decision_curve(y: np.ndarray, p: np.ndarray, thresholds=THRESHOLDS) -> pd.DataFrame:
    """Net benefit from rounded counts; this table releases no participant counts or denominators."""
    yb = np.asarray(y).astype(int) == 1
    n, npos = len(yb), int(yb.sum())
    nneg = n - npos
    tp = {t: int(((p >= t) & yb).sum()) for t in thresholds}
    fp = {t: int(((p >= t) & ~yb).sum()) for t in thresholds}
    rows = []
    for t in thresholds:
        w = t / (1 - t)
        rows.append({"threshold": t,
                     "share_flagged": rate(tp[t] + fp[t], n, 4),
                     "net_benefit_model": round(r10(tp[t]) / r10(n) - r10(fp[t]) / r10(n) * w, 6),
                     "net_benefit_flag_all": round(r10(npos) / r10(n) - r10(nneg) / r10(n) * w, 6)})
    return pd.DataFrame(rows)


def part_a(lm: pd.DataFrame) -> None:
    cf = json.load(open(os.path.join(HERE, "coding_fractions.json")))
    y = lm.s.to_numpy().astype(int)
    S_a = pd.read_parquet(need(OOF_A, "35")).loc[lm.index]
    FA = pd.read_parquet(need(FEATURES_A, "35")).loc[lm.index]
    XA = FA[[c for c in FA.columns if not c.startswith("yout_")]].to_numpy(float)
    export("t47_t03_subgroups", t03_subgroups(lm, S_a))
    export("t47_decision_curve", decision_curve(y, S_a["M2_elastic_net_logistic"].to_numpy()))
    print("part A: out-of-fold elastic net on matrix A", flush=True)
    p_a = seeded_oof(XA, y)
    export("t47_t14_subgroups", t14_table(lm, p_a))
    export("t47_t15_threshold_subgroups", t15_threshold(lm, p_a))
    export("t47_t15_adjustment", t15_adjustment(lm, p_a, cf))


# ----------------------------------------------------------------------------
# B. Laboratory classification (Task 21 rerun)
# ----------------------------------------------------------------------------

NEGATORS = {"not", "non", "no", "none", "without"}


def concept_abnormal(name) -> bool:
    """Negation-aware flag for a value concept name. A token flags when it starts with one of Task 21's words
    (high, low, abnormal, positive, detected, reactive, critical), unless the previous token negates it ("not
    detected", "non-reactive") or the next token is "normal" ("high normal"). "normal", "negative", "nonreactive",
    and "undetected" do not start with a flag word."""
    toks = re.findall(r"[a-z]+", str(name or "").lower())
    for i, tok in enumerate(toks):
        if any(tok.startswith(w) for w in t21.FLAG_WORDS):
            if i > 0 and toks[i - 1] in NEGATORS:
                continue
            if i + 1 < len(toks) and toks[i + 1] == "normal":
                continue
            return True
    return False


def unit_text(unit_code, unit_name) -> pd.Series:
    """UCUM code (brackets and braces removed, so m[IU]/L reads miu/l) and unit name, lower case."""
    code = pd.Series(unit_code).fillna("").astype(str).str.lower().str.replace(r"[\[\]{}]", "", regex=True)
    return (code + " " + pd.Series(unit_name).fillna("").astype(str).str.lower()).str.strip()


def lab_abnormal_fixed(df: pd.DataFrame) -> pd.Series:
    """Row-wise abnormal flag with the corrections.

    Direction by test: above the high bound for most labs; below the low bound for vitamin D and B12; either for
    TSH. Each direction uses its own recorded bound (a high bound must be above 0; a low bound of 0 cannot flag a
    low result) and falls back to Task 21's unit-specific threshold when that bound is missing. Value concepts are
    read with concept_abnormal."""
    v = pd.to_numeric(df.value, errors="coerce")
    rh = pd.to_numeric(df.range_high, errors="coerce")
    rl = pd.to_numeric(df.range_low, errors="coerce")
    rh, rl = rh.where(rh > 0), rl.where(rl > 0)
    low_only, tsh = df.fid.isin(t21.LOW_ONLY), df.fid == "lab_tsh"
    high_dir, low_dir = ~low_only, low_only | tsh
    names = df.value_concept.fillna("").astype(str)
    flag = names.map({u: concept_abnormal(u) for u in names.unique()}).astype(bool)
    by_range = (high_dir & rh.notna() & (v > rh)) | (low_dir & rl.notna() & (v < rl))
    unit = df.unit.fillna("").astype(str)
    by_unit = pd.Series(False, index=df.index)
    for fid, rules in t21.THRESHOLDS.items():
        k = (df.fid == fid) & v.notna()
        for u, lo_t, hi_t in rules:
            m = k & unit.str.contains(u, regex=False)
            if hi_t is not None:
                by_unit |= m & high_dir & rh.isna() & (v > hi_t)
            if lo_t is not None:
                by_unit |= m & low_dir & rl.isna() & (v < lo_t)
    return (flag | by_range.fillna(False) | by_unit).astype(bool)


def load_measurements(cohort: pd.DataFrame) -> pd.DataFrame:
    """Task 21's measurement query plus the UCUM unit code (unit_code) next to the unit name (unit_name)."""
    from google.cloud import bigquery
    cdr = subprocess.check_output(["wb", "resolve", f"--id={CDR_ID}"], text=True).strip()
    lo = (cohort.index_date.min() - pd.Timedelta(days=366)).date().isoformat()
    hi = (cohort.index_date.max() + pd.Timedelta(days=91)).date().isoformat()
    labs = t21.t02.REG["new_tests"]["labs"]
    lab_rows = ", ".join(f"STRUCT('{f['id']}' AS fid, '%{f['loinc_seed'].lower()}%' AS pat)" for f in labs)
    vit_rows = ", ".join(f"STRUCT('{k}' AS fid, '{c}' AS code)" for k, v in t21.VITALS.items() for c in v)
    cfg = bigquery.QueryJobConfig(query_parameters=[
        bigquery.ArrayQueryParameter("ids", "INT64", [int(x) for x in cohort.index]),
        bigquery.ScalarQueryParameter("lo", "DATE", lo), bigquery.ScalarQueryParameter("hi", "DATE", hi)])
    print("querying lab values and vital signs", flush=True)
    return bigquery.Client().query(f"""
        WITH seeds AS (SELECT * FROM UNNEST([{lab_rows}])),
        vit AS (SELECT * FROM UNNEST([{vit_rows}])),
        codes AS (
          SELECT s.fid, c.concept_id FROM seeds s JOIN `{cdr}.concept` c
            ON c.vocabulary_id = 'LOINC' AND c.standard_concept = 'S' AND c.domain_id = 'Measurement'
           AND LOWER(c.concept_name) LIKE s.pat
          UNION ALL
          SELECT v.fid, c.concept_id FROM vit v JOIN `{cdr}.concept` c
            ON c.vocabulary_id = 'LOINC' AND c.concept_code = v.code)
        SELECT m.person_id, m.measurement_date AS d, k.fid, m.value_as_number AS value,
               LOWER(IFNULL(u.concept_name, '')) AS unit_name, LOWER(IFNULL(u.concept_code, '')) AS unit_code,
               m.range_low, m.range_high, LOWER(IFNULL(vc.concept_name, '')) AS value_concept
        FROM `{cdr}.measurement` m
        JOIN codes k ON m.measurement_concept_id = k.concept_id
        LEFT JOIN `{cdr}.concept` u ON m.unit_concept_id = u.concept_id
        LEFT JOIN `{cdr}.concept` vc ON m.value_as_concept_id = vc.concept_id
        WHERE m.person_id IN UNNEST(@ids) AND m.measurement_date BETWEEN @lo AND @hi
    """, job_config=cfg).to_dataframe()


def build_lab_features(cohort, meas, fixed: bool) -> pd.DataFrame:
    """Task 21's features with its classifier (fixed=False; unit name only, as Task 21 read it) or the corrected one."""
    if not fixed:
        return t21.build_v3(cohort, meas.assign(unit=meas.unit_name.fillna("")))
    saved = t21.lab_abnormal
    t21.lab_abnormal = lab_abnormal_fixed
    try:
        return t21.build_v3(cohort, meas.assign(unit=unit_text(meas.unit_code, meas.unit_name).to_numpy()))
    finally:
        t21.lab_abnormal = saved


def lab_counts(X_old: pd.DataFrame, X_new: pd.DataFrame, y: np.ndarray) -> pd.DataFrame:
    """Corrected lab features by label, and the number of people whose feature value the correction changed
    (relative to Task 21's classification). Each count of 1-20 is hidden, with the prevalence that uses it."""
    y1 = y == 1
    n1, n0 = int(y1.sum()), int((~y1).sum())
    rows = []
    for f in [c for c in X_new.columns if c.startswith("lab_")]:
        new, old = X_new[f].to_numpy() == 1, X_old[f].to_numpy() == 1
        rec = {"feature": f}
        for lab, k, n in (("s1", y1, n1), ("s0", ~y1, n0)):
            a = int((new & k).sum())
            st = SUPPRESSED if bad(a) or bad(n) else None
            rec[f"n_{lab}_with"] = SUPPRESSED if bad(a) else r10(a)
            rec[f"prev_{lab}"] = st or rate(a, n, 4)
        changed = int((new != old).sum())
        rec["n_changed_vs_task21"] = SUPPRESSED if bad(changed) else r10(changed)
        rows.append(rec)
    return pd.DataFrame(rows)


def lab_performance(cohort: pd.DataFrame, configs: list, y: np.ndarray) -> pd.DataFrame:
    """Elastic net (Task 13's en_model) by feature set: 5-fold CV and Task 03's held-out sites. Bootstrap
    intervals (200 draws, the same draws for every feature set) and the paired AUROC difference from the first
    feature set. Recall and PPV in the top 5% use rounded counts; no count denominators are released."""
    test = t16.site_split(cohort)
    evals = {"5-fold CV": np.arange(len(y)), "held-out sites": np.where(test)[0]}
    scores = {}
    for name, X in configs:
        cv = seeded_oof(X, y)
        np.random.seed(SEED)
        ho = t13.en_model().fit(X[~test], y[~test]).predict_proba(X[test])[:, 1]
        scores[name] = {"5-fold CV": cv, "held-out sites": ho}
        print(f"part B: {name} done", flush=True)
    rows = []
    base = configs[0][0]
    for ev, idx in evals.items():
        yy = y[idx]
        rng = np.random.default_rng(SEED)
        draws = [d for d in (rng.integers(0, len(yy), len(yy)) for _ in range(N_BOOT)) if 0 < yy[d].sum() < len(d)]
        boot = {name: np.array([roc_auc_score(yy[d], scores[name][ev][d]) for d in draws]) for name, _ in configs}
        for name, _ in configs:
            s = scores[name][ev]
            top = top_mask(s)
            tp, k, npos = int((top & (yy == 1)).sum()), int(top.sum()), int(yy.sum())
            auc = roc_auc_score(yy, s)
            rec = {"features": name, "evaluation": ev, "auroc": round(float(auc), 4),
                   "auroc_lo": round(float(np.percentile(boot[name], 2.5)), 4),
                   "auroc_hi": round(float(np.percentile(boot[name], 97.5)), 4),
                   "auprc": round(float(average_precision_score(yy, s)), 4),
                   "recall_top5": rate(tp, npos, 4), "ppv_top5": rate(tp, k, 4)}
            if name == base:
                rec.update({"auroc_diff_vs_first": "", "diff_lo": "", "diff_hi": ""})
            else:
                diff = boot[name] - boot[base]
                rec.update({"auroc_diff_vs_first": round(float(auc - roc_auc_score(yy, scores[base][ev])), 4),
                            "diff_lo": round(float(np.percentile(diff, 2.5)), 4),
                            "diff_hi": round(float(np.percentile(diff, 97.5)), 4)})
            rows.append(rec)
    return pd.DataFrame(rows)


def part_b(lm: pd.DataFrame, loader=None) -> None:
    F2 = pd.read_parquet(need(FEATURES_A, "35")).loc[lm.index]
    F2 = F2[[c for c in F2.columns if not c.startswith("yout_")]]
    meas = (loader or load_measurements)(lm)
    print("part B: measurements loaded", flush=True)
    X_old = build_lab_features(lm, meas, fixed=False)
    X_new = build_lab_features(lm, meas, fixed=True)
    F_new = F2.join(X_new)
    F_new.to_parquet(os.path.join(OUT, LABS_OUT))
    y = lm.s.to_numpy().astype(int)
    export("t47_labs_feature_counts", lab_counts(X_old, X_new, y))
    configs = [("features_v3 (both condition domains)", F2.to_numpy(float)),
               ("features_v3 plus labs and vital signs, Task 21 classification", F2.join(X_old).to_numpy(float)),
               ("features_v3 plus labs and vital signs, corrected classification", F_new.to_numpy(float))]
    export("t47_labs_performance", lab_performance(lm, configs, y))


# ----------------------------------------------------------------------------
# C. Source grouping
# ----------------------------------------------------------------------------

SOURCE_TABLES = (("condition_occurrence", "condition_occurrence_id", "condition_start_date"),
                 ("observation", "observation_id", "observation_date"),
                 ("visit_occurrence", "visit_occurrence_id", "visit_start_date"),
                 ("procedure_occurrence", "procedure_occurrence_id", "procedure_date"),
                 ("measurement", "measurement_id", "measurement_date"),
                 ("drug_exposure", "drug_exposure_id", "drug_exposure_start_date"))


def load_source_records(cohort: pd.DataFrame) -> pd.DataFrame:
    """Per person and table, records in days -365 to 90: total, missing source, index-event source, and the
    distinct source identifiers. Aggregated in BigQuery; the identifiers stay in Workbench."""
    from google.cloud import bigquery
    cdr = subprocess.check_output(["wb", "resolve", f"--id={CDR_ID}"], text=True).strip()
    lo = (cohort.index_date.min() - pd.Timedelta(days=366)).date().isoformat()
    hi = (cohort.index_date.max() + pd.Timedelta(days=91)).date().isoformat()
    union = "\n          UNION ALL\n".join(f"""
          SELECT '{t}' AS tbl, t.person_id, t.{dcol} AS dt, CAST(x.src_id AS STRING) AS src
          FROM `{cdr}.{t}` t LEFT JOIN `{cdr}.{t}_ext` x ON t.{idcol} = x.{idcol}
          WHERE t.person_id IN UNNEST(@ids) AND t.{dcol} BETWEEN @lo AND @hi""" for t, idcol, dcol in SOURCE_TABLES)
    cfg = bigquery.QueryJobConfig(query_parameters=[
        bigquery.ArrayQueryParameter("ids", "INT64", [int(x) for x in cohort.index]),
        bigquery.ArrayQueryParameter("days", "DATE", [d.date() for d in pd.to_datetime(cohort.index_date)]),
        bigquery.ArrayQueryParameter("sites", "STRING", [norm_src(s) for s in cohort.site]),
        bigquery.ScalarQueryParameter("lo", "DATE", lo), bigquery.ScalarQueryParameter("hi", "DATE", hi)])
    print("querying source identifiers of feature-table records", flush=True)
    return bigquery.Client().query(f"""
        WITH c AS (
          SELECT pid, d, s FROM UNNEST(@ids) AS pid WITH OFFSET i
          JOIN UNNEST(@days) AS d WITH OFFSET j ON i = j
          JOIN UNNEST(@sites) AS s WITH OFFSET k ON i = k),
        r AS ({union})
        SELECT r.person_id, r.tbl, COUNT(*) AS n, COUNTIF(r.src IS NULL OR r.src = '') AS n_missing,
               COUNTIF(r.src = c.s) AS n_same, ARRAY_AGG(DISTINCT IFNULL(r.src, '')) AS srcs
        FROM r JOIN c ON r.person_id = c.pid
        WHERE r.dt BETWEEN DATE_SUB(c.d, INTERVAL 365 DAY) AND DATE_ADD(c.d, INTERVAL 90 DAY)
        GROUP BY r.person_id, r.tbl
    """, job_config=cfg).to_dataframe()


def missing_src(s) -> bool:
    return s is None or str(s).strip().lower() in MISSING_SRC


def norm_src(s) -> str:
    """Source identifier as text ("" when missing); "123.0" from a float column reads "123"."""
    if missing_src(s):
        return ""
    t = str(s).strip()
    return t[:-2] if re.fullmatch(r"\d+\.0", t) else t


def source_type(s) -> str:
    """Source identifier with digits removed (for example "EHR site"); the identifiers themselves are not released."""
    if missing_src(s):
        return "missing"
    t = re.sub(r"\s+", " ", re.sub(r"\d+", "", str(s))).strip(" :-_#")
    return t or "numeric identifier"


def index_ties(cohort: pd.DataFrame, events: pd.DataFrame) -> int:
    """Participants whose index day carries U07.1 records from more than one distinct source."""
    e = events[events.kind == "covid"][["person_id", "event_date", "src_id"]].copy()
    e["event_date"] = pd.to_datetime(e.event_date.astype(str))
    e = e.merge(cohort.index_date.rename("index_date"), left_on="person_id", right_index=True)
    e = e[e.event_date == e.index_date]
    e["src_id"] = e.src_id.map(norm_src)
    return int((e.groupby("person_id").src_id.nunique() > 1).sum())


def source_grouping(cohort: pd.DataFrame, recs: pd.DataFrame, events: pd.DataFrame) -> pd.DataFrame:
    site = cohort.site.map(norm_src)
    heldout = pd.Series(t16.site_split(cohort), index=cohort.index)
    held_sites, train_sites = set(site[heldout]), set(site[~heldout])
    recs = recs[recs.person_id.isin(cohort.index)].copy()
    recs["srcs"] = recs.srcs.map(lambda a: {norm_src(x) for x in (list(a) if a is not None else []) if not missing_src(x)})
    per = recs.groupby("person_id").agg(n=("n", "sum"), n_missing=("n_missing", "sum"), n_same=("n_same", "sum"),
                                        srcs=("srcs", lambda s: set().union(*s)))
    per = per.reindex(cohort.index)
    per[["n", "n_missing", "n_same"]] = per[["n", "n_missing", "n_same"]].fillna(0).astype(int)
    per["srcs"] = per.srcs.map(lambda s: s if isinstance(s, set) else set())
    idx_site = site.reindex(per.index)
    other = [bool(s - {i}) for s, i in zip(per.srcs, idx_site)]
    to_train = [bool(s & (train_sites - {i})) for s, i in zip(per.srcs, idx_site)]
    to_held = [bool(s & (held_sites - {i})) for s, i in zip(per.srcs, idx_site)]
    N, n_ho = len(cohort), int(heldout.sum())
    pops = {"landmark cohort": N, "held-out sites": n_ho, "training sites": N - n_ho}
    groups = [  # (measure, population, exact count)
        ("index-event source identifier missing", "landmark cohort", int(site.map(missing_src).sum())),
        ("index day carries U07.1 records from more than one source", "landmark cohort", index_ties(cohort, events)),
        ("records in days -365 to 90 from two or more non-missing sources", "landmark cohort",
         int((per.srcs.map(len) >= 2).sum())),
        ("any record in days -365 to 90 from a non-missing source other than the index-event source", "landmark cohort",
         int(np.sum(other))),
        ("any record in days -365 to 90 with a missing source identifier", "landmark cohort", int((per.n_missing > 0).sum())),
        ("no feature-table record in days -365 to 90", "landmark cohort", int((per.n == 0).sum())),
        ("any record in days -365 to 90 from a training-site source", "held-out sites", int(np.sum(np.array(to_train) & heldout.to_numpy()))),
        ("any record in days -365 to 90 from a held-out-site source", "training sites", int(np.sum(np.array(to_held) & ~heldout.to_numpy()))),
    ]
    types = site.map(source_type)
    common = list(types.value_counts().index[:8])   # at most 8 named types; the rest are pooled
    types = types.where(types.isin(common), "other types")
    type_rows = []
    for t in sorted(types.unique()):
        type_rows.append(len(groups))
        groups.append((f"index-event source type: {t}", "landmark cohort", int((types == t).sum())))
    # the source types partition the landmark cohort, as do the two site populations (protect_totals)
    values = {**{j: c for j, (_, _, c) in enumerate(groups)}, **{p: n for p, n in pops.items()}}
    status = {k: (SUPPRESSED if bad(v) else None) for k, v in values.items()}
    protect_totals(values, status, [(type_rows, [["landmark cohort"]]),
                                    (["held-out sites", "training sites"], [["landmark cohort"]])])
    missing_type = [j for j in type_rows if groups[j][0] == "index-event source type: missing"]
    if missing_type and status[0] is None:   # row 0 shows the same count as the "missing" type
        status[0] = status[missing_type[0]]
    rows = [{"measure": "participants", "population": p, "participants": status[p] or r10(n), "share": 1.0, "note": ""}
            for p, n in pops.items()]
    for j, (measure, pop, c) in enumerate(groups):
        rows.append({"measure": measure, "population": pop, "participants": status[j] or r10(c),
                     "share": status[j] or status[pop] or rate(c, pops[pop], 4), "note": ""})
    rows.append({"measure": "distinct index-event source identifiers", "population": "landmark cohort",
                 "participants": "", "share": "", "note": f"{site[~site.map(missing_src)].nunique()} sources"})
    rows.append({"measure": "distinct source identifiers on feature-table records", "population": "landmark cohort",
                 "participants": "", "share": "", "note": f"{len(set().union(*per.srcs))} sources"})
    # record shares by table (records, not people; from record counts rounded up to 10 like every other share;
    # shown when more than 20 people contribute such records)
    for t, _, _ in SOURCE_TABLES:
        r = recs[recs.tbl == t]
        tot = int(r.n.sum())
        oth = r.n - r.n_missing - r.n_same
        for measure, num, people in (("records from another non-missing source", int(oth.sum()), int((oth > 0).sum())),
                                     ("records with a missing source identifier", int(r.n_missing.sum()), int((r.n_missing > 0).sum()))):
            mark = SUPPRESSED if bad(people) else None
            rows.append({"measure": f"{t}: {measure}", "population": "landmark cohort",
                         "participants": mark or r10(people),
                         "share": mark or rate(num, tot, 4),
                         "note": "share of the table's records in days -365 to 90"})
    return pd.DataFrame(rows)


def part_c(lm: pd.DataFrame, loader=None) -> None:
    events = pd.read_parquet(need("covid_pasc_events.parquet", "01"))
    recs = (loader or load_source_records)(lm)
    print("part C: source records loaded", flush=True)
    export("t47_source_grouping", source_grouping(lm, recs, events))


# ----------------------------------------------------------------------------
# D, E. Coding-gap cohort: era-safe coded share and Table 1 denominators
# ----------------------------------------------------------------------------

AXES = ("sex", "age_band", "race_eth")


def era_safe(c: pd.DataFrame) -> pd.DataFrame:
    keep = (pd.to_datetime(c.index_date) >= ERA_SAFE_START).to_numpy()
    coded = c.coded_455.to_numpy().astype(int) == 1
    masks = {"n": keep, "coded": keep & coded}
    out = []
    for axis in AXES:
        groups, overall, _ = counts_by_group(c, axis, masks)
        st = group_status(groups, overall, ["n", "coded"])
        for g in (["overall"] if axis == "sex" else []) + list(groups):
            v = overall if g == "overall" else groups[g]
            out.append({"axis": "overall" if g == "overall" else axis, "category": "all" if g == "overall" else g,
                        "n_gap_cohort": cell(st, g, ["n"], r10(v["n"])),
                        "n_coded_455": cell(st, g, ["coded"], r10(v["coded"])),
                        "p_coded_455": cell(st, g, ["n", "coded"], rate(v["coded"], v["n"], 4))})
    n_x, c_x = int((~keep).sum()), int((~keep & coded).sum())
    out.append({"axis": "excluded (shifted index before the era-safe start)", "category": "all",
                "n_gap_cohort": SUPPRESSED if bad(n_x) else r10(n_x),
                "n_coded_455": SUPPRESSED if bad(c_x) else r10(c_x),
                "p_coded_455": SUPPRESSED if bad(n_x) or bad(c_x) else rate(c_x, n_x, 4)})
    return pd.DataFrame(out)


def table1(c: pd.DataFrame) -> pd.DataFrame:
    lm = c.landmark_eligible.to_numpy().astype(int) == 1
    coded = c.coded_455.to_numpy().astype(int) == 1
    s1 = lm & (c.s.to_numpy().astype(int) == 1)
    masks = {"n_gap": np.ones(len(c), bool), "coded": coded, "n_lm": lm, "s1": s1}
    out = []
    for axis in AXES:
        groups, overall, _ = counts_by_group(c, axis, masks)
        st = group_status(groups, overall, list(masks))
        for g in (["overall"] if axis == "sex" else []) + list(groups):
            v = overall if g == "overall" else groups[g]
            out.append({"axis": "overall" if g == "overall" else axis, "category": "all" if g == "overall" else g,
                        "n_gap_cohort": cell(st, g, ["n_gap"], r10(v["n_gap"])),
                        "n_coded_455": cell(st, g, ["coded"], r10(v["coded"])),
                        "p_coded_455": cell(st, g, ["n_gap", "coded"], rate(v["coded"], v["n_gap"], 4)),
                        "n_landmark": cell(st, g, ["n_lm"], r10(v["n_lm"])),
                        "n_s1": cell(st, g, ["s1"], r10(v["s1"])),
                        "p_s1_landmark": cell(st, g, ["n_lm", "s1"], rate(v["s1"], v["n_lm"], 4))})
    return pd.DataFrame(out)


def part_de(c_all: pd.DataFrame) -> None:
    export("t47_era_safe_coded_share", era_safe(c_all))
    export("t47_table1_denominators", table1(c_all))


# ----------------------------------------------------------------------------
# F. Development versus evaluation characteristics
# ----------------------------------------------------------------------------

SPLITS = ("training_split", "validation_split", "heldout_sites", "training_sites")


def split_sums(kinds) -> list:
    """The totals of the development table for protect_totals. kinds[j] is row j's characteristic (row 0 is the
    patients row). Within each row the two splits add up to the same total as the two site groups; within each
    split column the rows of one axis add up to the patients row."""
    sums = []
    for j in range(len(kinds)):
        split_pair = [(j, "training_split"), (j, "validation_split")]
        site_pair = [(j, "heldout_sites"), (j, "training_sites")]
        sums += [(split_pair, [site_pair]), (site_pair, [split_pair])]
    for s in SPLITS:
        for axis in AXES:
            sums.append(([(j, s) for j, k in enumerate(kinds) if k == axis], [[(0, s)]]))
    return sums


def dev_eval(lm: pd.DataFrame, F: pd.DataFrame, train: np.ndarray, role: np.ndarray) -> pd.DataFrame:
    """Characteristics by split. Within each row the training and validation splits add up to the same total as
    the held-out and training sites, and within each split column the groups of one axis add up to the
    "patients" row; complementary suppression (protect_totals) applies to both."""
    split = {"training_split": train, "validation_split": ~train, "heldout_sites": role == "test",
             "training_sites": role != "test"}
    y = lm.s.to_numpy().astype(int) == 1
    chars = [("all", "patients", np.ones(len(lm), bool)), ("outcome", "first U09.9 in days 91-455", y)]
    for axis in AXES:
        for g, i in lm.groupby(axis).indices.items():
            m = np.zeros(len(lm), bool)
            m[i] = True
            chars.append((axis, str(g), m))
    for f, label in DESCRIBE.items():
        if f in F.columns:
            chars.append(("feature", label, F[f].to_numpy() == 1))
    n = {s: int(split[s].sum()) for s in SPLITS}
    cnt = {(j, s): int((ch[2] & split[s]).sum()) for j, ch in enumerate(chars) for s in SPLITS}
    st = {k: (SUPPRESSED if bad(v) else None) for k, v in cnt.items()}
    protect_totals(cnt, st, split_sums([ch[0] for ch in chars]))
    rows = []
    for j, (kind, label, _) in enumerate(chars):
        rec = {"characteristic": kind, "category": label}
        for s in SPLITS:
            rec[f"{s}_n"] = st[(j, s)] or r10(cnt[(j, s)])
            rec[f"{s}_pct"] = st[(j, s)] or st[(0, s)] or round(100 * r10(cnt[(j, s)]) / r10(n[s]), 1)
        rows.append(rec)
    return pd.DataFrame(rows)


def part_f(lm: pd.DataFrame) -> None:
    F = pd.read_parquet(need(FEATURES_A, "35")).loc[lm.index]
    train = pd.read_parquet(need("t04_split.parquet", "35 (Task 04 rerun)")).loc[lm.index, "train"].to_numpy().astype(bool)
    role = pd.read_parquet(need("t16_split.parquet", "35 (Task 16 rerun)")).loc[lm.index, "role"].astype(str).to_numpy()
    export("t47_dev_eval_characteristics", dev_eval(lm, F, train, role))


# ----------------------------------------------------------------------------

def main(measurement_loader=None, source_loader=None):
    c_all = pd.read_parquet(need("cohort_v2.parquet", "01"))
    c_all["index_date"] = pd.to_datetime(c_all.index_date.astype(str))
    lm = c_all[c_all.landmark_eligible == 1].copy()
    print(f"cohort loaded: {len(lm)} landmark-eligible", flush=True)
    parts = [("A subgroup and threshold tables", lambda: part_a(lm)),
             ("B laboratory classification", lambda: part_b(lm, measurement_loader)),
             ("C source grouping", lambda: part_c(lm, source_loader)),
             ("D and E era-safe coded share and Table 1 denominators", lambda: part_de(c_all)),
             ("F development and evaluation characteristics", lambda: part_f(lm))]
    status, failed = [], []
    for name, fn in parts:
        try:
            fn()
            status.append({"part": name, "status": "ok"})
        except Exception as e:  # noqa: BLE001
            traceback.print_exc()
            msg = getattr(e, "message", None) or str(e)
            failed.append(f"{name}: {type(e).__name__}: {str(msg).splitlines()[0][:200] if msg else ''}")
            status.append({"part": name, "status": f"failed: {type(e).__name__}"})
        print(f"{name}: {status[-1]['status']}", flush=True)
    export("t47_status", pd.DataFrame(status))
    if failed:
        raise RuntimeError("Task 47 parts failed: " + " | ".join(failed))
    print("Task 47 finished", flush=True)


if __name__ == "__main__":
    main()
