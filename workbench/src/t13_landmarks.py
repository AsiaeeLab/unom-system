"""Task 13: dynamic flag, related conditions, fairness, and survey-anchored reranking.

Runs inside the All of Us Workbench (bash ~/unm/bin/unm.sh run 13).
Inputs : ~/unm/output/cohort_v2.parquet, covid_pasc_events.parquet (Task 01)
Output : ~/unm/output/t13_*.parquet (participant level; stays in Workbench)
Exports: ~/unm/export/13/ (aggregates only; counts 1-20 suppressed, other counts rounded up to 10)

1. Landmarks. The same chart features are rebuilt at days L = 30, 60, 90, 120, 180 after the
   COVID index, using only information up to day L. People coded (U09.9 or SNOMED post-COVID)
   by day L are excluded; the label is a first U09.9 in days (L, 455]. Each landmark gets its
   own elastic-net model (5-fold CV), and one landmark supermodel is fit on all landmarks stacked
   (landmark as a covariate, folds grouped by person), which is what the app would re-run at
   every visit. Feature windows: baseline W0 [-365,-91], W1 [-90,-1]; acute W2 [0, min(30, L)];
   follow-up W3 [31, L]; "recent" symptom window [max(0, L-59), L]; late visit [L-29, L].
2. Related conditions (landmark 90): incident codes in days (90, 455] for ME/CFS or postviral
   fatigue (G93.3x), POTS or dysautonomia (G90.A, G90.9), fibromyalgia (M79.7), mast cell
   disorders (D89.4x), and chronic fatigue, unspecified (R53.82). Multi-task logistic
   regression (shared weights plus task-specific deviations, Evgeniou and Pontil 2004) is
   compared with the single-task model and with a pooled "any post-infectious code" label, all
   evaluated on Long COVID.
3. Fairness (landmark 90): discrimination and calibration-in-the-large by sex, race and
   ethnicity, and age band; decision curve.
4. Survey-anchored reranking: P(y=1|x) = P(s=1|x) / c_g(x), with coding fractions c_g from the
   Household Pulse comparison (results/derived/coding_gap.csv, "ever" definition; public
   aggregates). Reports how the top 5% changes (share female, coded-label recall) and the
   model-implied number of true Long COVID cases in the top 5%.
"""

from __future__ import annotations

import os
import subprocess
import sys

import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import roc_auc_score
from sklearn.model_selection import GroupKFold, StratifiedKFold
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

try:  # BigQuery date columns saved by Task 01 load as 'dbdate' and need this extension type
    import db_dtypes  # noqa: F401
except ImportError:
    pass

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import t02_features as t02  # noqa: E402
from aou_safe import SUPPRESSED, check_exportable, protect  # noqa: E402
import t03_models  # noqa: E402
from t03_models import fmt, metrics  # noqa: E402

CDR_ID = os.environ.get("UNM_CDR_ID", "R2025Q4R6")
OUT = os.path.expanduser("~/unm/output")
EXPORT = os.path.expanduser("~/unm/export/13")
SEED = 20261001
LANDMARKS = (30, 60, 90, 120, 180)
HORIZON = 455
N_BOOT = 200   # bootstrap replicates for this task's intervals; main() applies it to t03_models while it runs
RELATED = {"mecfs_postviral": ["G933"], "pots_dysautonomia": ["G90A", "G909"], "fibromyalgia": ["M797"],
           "mast_cell": ["D894"], "chronic_fatigue": ["R5382"]}
EXTRA_PREFIXES = ["U071"] + [p for v in RELATED.values() for p in v]
# Score adjustment moved to Task 15 (constants read from coding_fractions.json).


def r10(v) -> int:
    return int(-(-int(v) // 10) * 10)


def en_model():
    return make_pipeline(StandardScaler(), LogisticRegression(penalty="elasticnet", solver="saga", l1_ratio=0.5,
                                                              C=0.05, max_iter=3000, tol=1e-3))


# ----------------------------------------------------------------------------
# Data access (Workbench only)
# ----------------------------------------------------------------------------

def load_extra(cohort: pd.DataFrame) -> pd.DataFrame:
    from google.cloud import bigquery
    cdr = subprocess.check_output(["wb", "resolve", f"--id={CDR_ID}"], text=True).strip()
    lo = (cohort.index_date.min() - pd.Timedelta(days=366)).date().isoformat()
    hi = (cohort.index_date.max() + pd.Timedelta(days=HORIZON + 1)).date().isoformat()
    cfg = bigquery.QueryJobConfig(query_parameters=[
        bigquery.ArrayQueryParameter("ids", "INT64", [int(x) for x in cohort.index]),
        bigquery.ScalarQueryParameter("lo", "DATE", lo), bigquery.ScalarQueryParameter("hi", "DATE", hi)])
    regex = "^(" + "|".join(EXTRA_PREFIXES) + ")"
    print("querying COVID follow-up and related-condition codes", flush=True)
    return bigquery.Client().query(f"""
        SELECT co.person_id, co.condition_start_date AS d, REPLACE(UPPER(c.concept_code), '.', '') AS code
        FROM `{cdr}.condition_occurrence` co JOIN `{cdr}.concept` c ON co.condition_source_concept_id = c.concept_id
        WHERE c.vocabulary_id = 'ICD10CM' AND co.person_id IN UNNEST(@ids) AND co.condition_start_date BETWEEN @lo AND @hi
          AND REGEXP_CONTAINS(REPLACE(UPPER(c.concept_code), '.', ''), r'{regex}')
    """, job_config=cfg).to_dataframe()


def load_all(cohort):
    conds, visits, procs, meas, drugs, _, _ = t02.load_from_cdr(cohort)
    return conds, visits, procs, meas, drugs, load_extra(cohort)


# ----------------------------------------------------------------------------
# Features and labels at a landmark (pure pandas; tested locally)
# ----------------------------------------------------------------------------

def first_day(events: pd.DataFrame, kinds, index: pd.Series) -> pd.Series:
    """Days from index to the first event of the given kinds after day 0 (NaN if none)."""
    e = events[events.kind.isin(kinds)].merge(index.rename("index_date"), left_on="person_id", right_index=True)
    off = (pd.to_datetime(e.event_date) - e.index_date).dt.days
    return off[off > 0].groupby(e.person_id[off > 0]).min().reindex(index.index)


def landmark_frame(base: pd.DataFrame, events: pd.DataFrame, L: int) -> pd.DataFrame:
    """Eligible people at landmark L with label s_L and days from L to the code."""
    any_day = first_day(events, ["pasc_strict", "pasc_snomed"], base.index_date)
    strict_day = first_day(events, ["pasc_strict"], base.index_date)
    elig = ~(any_day <= L)
    lf = base.loc[elig].copy()
    sd = strict_day.loc[elig]
    lf["s"] = ((sd > L) & (sd <= HORIZON)).astype(int)
    lf["lead_days"] = np.where(lf.s == 1, sd - L, np.nan)
    return lf


def extra_features(lf: pd.DataFrame, conds, visits, extra, L: int) -> pd.DataFrame:
    X = pd.DataFrame(index=lf.index)
    c = t02._offset(conds, lf.index_date)
    code = c.code.astype(str)
    recent = (max(0, L - 59), L)
    n_recent = pd.Series(0, index=X.index)
    for f in t02.REG["new_symptoms"]:
        if "icd10cm_prefix" not in f:
            continue
        name = f["id"].replace("sym_", "")
        m = code.str.startswith(tuple(str(p) for p in f["icd10cm_prefix"]))
        X[f"sym_any_{name}"] = X.index.isin(t02._persons(c, m & (c.off >= 0) & (c.off <= L))).astype(int)
        n_recent += X.index.isin(t02._persons(c, m & (c.off >= recent[0]) & (c.off <= recent[1]))).astype(int)
    X["sym_recent_count_ge2"] = (n_recent >= 2).astype(int)
    X["sym_recent_count_ge3"] = (n_recent >= 3).astype(int)
    e = t02._offset(extra, lf.index_date)
    X["covid_code_followup"] = X.index.isin(
        t02._persons(e, e.code.astype(str).str.startswith("U071") & (e.off >= 31) & (e.off <= L))).astype(int)
    v = t02._offset(visits, lf.index_date)
    late = (v.off >= L - 29) & (v.off <= L) & v.visit_type.map(t02.visit_class).isin(["AMB", "EMER"])
    X["late_visit"] = X.index.isin(t02._persons(v, late)).astype(int)
    return X


def features_at(lf, conds, visits, procs, meas, drugs, extra, L: int) -> pd.DataFrame:
    saved = dict(t02.W)
    t02.W.update({"W2": (0, min(30, L)), "W3": (31, L)})
    try:
        X = t02.build_features(lf, conds, visits, procs, meas, drugs)
    finally:
        t02.W.clear(); t02.W.update(saved)
    X = X[[c for c in X.columns if not c.startswith("yout_")]]
    return X.join(extra_features(lf, conds, visits, extra, L))


def related_labels(lf: pd.DataFrame, extra: pd.DataFrame, L: int = 90) -> pd.DataFrame:
    """Incident related-condition code in (L, HORIZON]; NaN if coded on or before day L (prevalent)."""
    e = t02._offset(extra, lf.index_date)
    code = e.code.astype(str)
    Y = pd.DataFrame(index=lf.index)
    for k, pre in RELATED.items():
        m = code.str.startswith(tuple(pre))
        before = t02._persons(e, m & (e.off >= -365) & (e.off <= L))
        after = t02._persons(e, m & (e.off > L) & (e.off <= HORIZON))
        y = pd.Series(Y.index.isin(after).astype(float), index=Y.index)
        y[Y.index.isin(before)] = np.nan
        Y[k] = y
    return Y


# ----------------------------------------------------------------------------
# Models
# ----------------------------------------------------------------------------

def oof(X: np.ndarray, y: np.ndarray, make=en_model, groups=None, seed=SEED) -> np.ndarray:
    out = np.zeros(len(y))
    if groups is None:
        splits = StratifiedKFold(5, shuffle=True, random_state=seed).split(X, y)
    else:
        splits = GroupKFold(5).split(X, y, groups)
    for tr, te in splits:
        m = make().fit(X[tr], y[tr])
        out[te] = m.predict_proba(X[te])[:, 1]
    return out


def multitask_oof(X: np.ndarray, Y: pd.DataFrame, main: str, share=0.5, C=0.05, seed=SEED) -> np.ndarray:
    """Shared plus task-specific logistic weights by feature augmentation; OOF scores for `main`."""
    tasks = list(Y.columns)
    folds = np.zeros(len(X), int)
    for k, (_, te) in enumerate(StratifiedKFold(5, shuffle=True, random_state=seed).split(X, Y[main].fillna(0))):
        folds[te] = k
    out = np.zeros(len(X))

    def aug(rows, t):
        blocks = [Xs[rows]] + [share * Xs[rows] if j == t else np.zeros_like(Xs[rows]) for j in range(len(tasks))]
        return np.hstack(blocks)

    for k in range(5):
        Xs = StandardScaler().fit(X[folds != k]).transform(X)
        tr_x, tr_y = [], []
        for t, name in enumerate(tasks):
            rows = np.where((folds != k) & Y[name].notna().to_numpy())[0]
            tr_x.append(aug(rows, t)); tr_y.append(Y[name].to_numpy()[rows])
        m = LogisticRegression(C=C, max_iter=2000).fit(np.vstack(tr_x), np.concatenate(tr_y))
        te = np.where(folds == k)[0]
        out[te] = m.predict_proba(aug(te, tasks.index(main)))[:, 1]
    return out


def lead_summary(y, score, lead, frac=0.10):
    top = score >= np.quantile(score, 1 - frac)
    d = lead[(y == 1) & top]
    count = SUPPRESSED if 0 < len(d) <= 20 else r10(len(d))
    if len(d) <= 1:
        return {"flagged_positives": count, "median_lead_days": SUPPRESSED, "lead_p25": SUPPRESSED, "lead_p75": SUPPRESSED}
    return {"flagged_positives": count, "median_lead_days": float(np.median(d)),
            "lead_p25": float(np.percentile(d, 25)), "lead_p75": float(np.percentile(d, 75))}


def group_rows(df, score, y, axis):
    rows = []
    for g, idx in df.groupby(axis).indices.items():
        yy, ss = y[idx], score[idx]
        n, npos = len(idx), int(yy.sum())
        ok = 0 < npos < n
        rows.append({"axis": axis, "group": str(g), "n": n, "n_pos": npos,
                     "auroc": round(float(roc_auc_score(yy, ss)), 4) if ok else SUPPRESSED,
                     "mean_predicted": round(float(ss.mean()), 5) if n > 1 else SUPPRESSED,
                     "observed_rate": round(r10(npos) / r10(n), 5) if (npos == 0 or npos > 20) and n > 20 else SUPPRESSED})
    out = pd.DataFrame(rows)
    shown = protect(out, ["n", "n_pos"], complements=[("n", "n_pos")])
    shown.loc[shown.n.map(lambda v: isinstance(v, str)) | shown.n_pos.map(lambda v: isinstance(v, str)), "observed_rate"] = SUPPRESSED
    return shown


def decision_curve(y, p, thresholds=(0.005, 0.01, 0.015, 0.02, 0.03, 0.05)):
    n, prev = len(y), y.mean()
    rows = []
    for t in thresholds:
        flag = p >= t
        tp, fp = int((flag & (y == 1)).sum()), int((flag & (y == 0)).sum())
        rows.append({"threshold": t, "share_flagged": round(float(flag.mean()), 4),
                     "net_benefit_model": round(tp / n - fp / n * t / (1 - t), 6),
                     "net_benefit_flag_all": round(prev - (1 - prev) * t / (1 - t), 6)})
    return pd.DataFrame(rows)


def export(name, df):
    os.makedirs(EXPORT, exist_ok=True)
    check_exportable(df)
    df.to_csv(os.path.join(EXPORT, f"{name}.csv"), index=False)
    print(f"exported {name} ({len(df)} rows)", flush=True)


def main(loader=load_all):
    """Run Task 13 with N_BOOT bootstrap replicates in t03_models.metrics, restoring its setting afterward.
    (Importing this module used to set t03_models.N_BOOT = 200 for every importer.)"""
    saved = t03_models.N_BOOT
    t03_models.N_BOOT = N_BOOT
    try:
        run(loader)
    finally:
        t03_models.N_BOOT = saved


def run(loader=load_all):
    base = pd.read_parquet(os.path.join(OUT, "cohort_v2.parquet"))
    base["index_date"] = pd.to_datetime(base.index_date)
    events = pd.read_parquet(os.path.join(OUT, "covid_pasc_events.parquet"))
    events["event_date"] = pd.to_datetime(events.event_date.astype(str))
    conds, visits, procs, meas, drugs, extra = loader(base)
    print("events loaded", flush=True)

    # 1. landmarks
    perf, stack = [], []
    frames = {}
    for L in LANDMARKS:
        lf = landmark_frame(base, events, L)
        X = features_at(lf, conds, visits, procs, meas, drugs, extra, L)
        frames[L] = (lf, X)
        y = lf.s.to_numpy()
        sc = oof(X.to_numpy(float), y)
        m = fmt(metrics(y, sc, boot=True, counts_released=True))
        perf.append({"landmark_day": L, "model": "landmark-specific elastic net", "n_eligible": r10(len(y)),
                     "n_pos": r10(y.sum()) if y.sum() > 20 else SUPPRESSED,
                     **{k: m[k] for k in ("auroc", "auroc_lo", "auroc_hi", "auprc", "recall_top5", "ppv_top5")},
                     **lead_summary(y, sc, lf.lead_days.to_numpy())})
        stack.append(X.assign(**{f"lm_{l}": int(l == L) for l in LANDMARKS}, _y=y, _pid=X.index, _L=L,
                              _lead=lf.lead_days.to_numpy()))
        print(f"landmark {L} done", flush=True)
    S = pd.concat(stack, ignore_index=True)
    cols = [c for c in S.columns if not c.startswith("_")]
    sc = oof(S[cols].to_numpy(float), S._y.to_numpy(), groups=S._pid.to_numpy())
    for L in LANDMARKS:
        k = (S._L == L).to_numpy()
        y = S._y.to_numpy()[k]
        m = fmt(metrics(y, sc[k], boot=True, counts_released=True))
        perf.append({"landmark_day": L, "model": "landmark supermodel", "n_eligible": r10(k.sum()),
                     "n_pos": r10(y.sum()) if y.sum() > 20 else SUPPRESSED,
                     **{kk: m[kk] for kk in ("auroc", "auroc_lo", "auroc_hi", "auprc", "recall_top5", "ppv_top5")},
                     **lead_summary(y, sc[k], S._lead.to_numpy()[k])})
    export("t13_landmark_performance", pd.DataFrame(perf))

    # 2. related conditions at landmark 90
    lf, X = frames[90]
    Y = related_labels(lf, extra, 90)
    rel = []
    for k in RELATED:
        yk = Y[k]
        rel.append({"condition": k, "n_prevalent_by_day90": int(yk.isna().sum()), "n_incident_91_455": int(yk.sum()),
                    "n_incident_and_long_covid": int(((yk == 1) & (lf.s == 1)).sum())})
    rel = protect(pd.DataFrame(rel), ["n_prevalent_by_day90", "n_incident_91_455", "n_incident_and_long_covid"])
    export("t13_related_counts", rel)
    use = [k for k in RELATED if Y[k].sum() >= 30]
    Xn = X.to_numpy(float)
    y = lf.s.to_numpy()
    rows = []
    single = oof(Xn, y, make=lambda: make_pipeline(StandardScaler(), LogisticRegression(C=0.05, max_iter=2000)))
    rows.append({"approach": "single-task logistic (Long COVID only)", "tasks": "long_covid", **fmt(metrics(y, single))})
    if use:
        Yt = pd.concat([lf.s.rename("long_covid").astype(float), Y[use]], axis=1)
        mt = multitask_oof(Xn, Yt, "long_covid")
        rows.append({"approach": "multi-task logistic (shared + task-specific)", "tasks": ";".join(["long_covid"] + use),
                     **fmt(metrics(y, mt))})
        pooled_y = ((lf.s == 1) | (Y[use].fillna(0).sum(axis=1) > 0)).astype(int).to_numpy()
        pooled = np.zeros(len(y))
        for tr, te in StratifiedKFold(5, shuffle=True, random_state=SEED).split(Xn, y):
            mdl = make_pipeline(StandardScaler(), LogisticRegression(C=0.05, max_iter=2000)).fit(Xn[tr], pooled_y[tr])
            pooled[te] = mdl.predict_proba(Xn[te])[:, 1]
        rows.append({"approach": "pooled label (Long COVID or any related code)", "tasks": ";".join(["long_covid"] + use),
                     **fmt(metrics(y, pooled))})
    export("t13_multitask", pd.DataFrame(rows))

    # 3. fairness and decision curve at landmark 90 (landmark-specific elastic net)
    p90 = oof(Xn, y)
    grp = pd.concat([group_rows(lf, p90, y, a) for a in ("sex", "race_eth", "age_band")], ignore_index=True)
    export("t13_subgroups", grp)
    export("t13_decision_curve", decision_curve(y, p90))

    print("Task 13 finished", flush=True)


if __name__ == "__main__":
    main()
