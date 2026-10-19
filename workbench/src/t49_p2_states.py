"""Task 49 (Paper 2): coding of current self-reported diagnoses by state of residence, for a US map.

Runs inside the All of Us Workbench (bash ~/unm/bin/unm.sh run 49).
Population: Paper 2's main analysis (Task 28): active adult EHR patients, women and men, who took the
Personal and Family Health History or Personal Medical History survey and whose first EHR condition record
is 5 or more years before the survey; endometriosis among women. Codes as Task 25, with obesity codes from
both condition_occurrence and observation (Task 34).
State of residence: detected at run time. The script reads the schemas of person and person_ext and uses
their state_of_residence_* columns if present and populated; otherwise the latest answer to the PPI state
question (observation_source_concept_id 1585249, values like "PIIState_TN"). Values are mapped to two-letter
postal codes. Skips, unparseable values, and persons with two different states are set to "not available".
Exports: ~/unm/export/49/
  t49_state_population: participants per state in the population, plus "not available" and "US" rows.
  t49_state_shares: per state and condition (10 conditions, anchors included), current self-reporters, those
      with a qualifying code, the coded share and its 95% Wilson interval, both from the counts rounded up to
      10 (so no released number inverts to an exact count), and the share relative to the mean of the
      state's two anchor shares with the Wilson limits divided by that mean (blank for endometriosis, which
      needs female anchors). A "US" row per condition.
  t49_state_longcovid: Paper 1 coding-gap cohort (cohort_v2.parquet: COVID-19 cohort, U09.9 in days 1 to
      455) by state, with the coded share and Wilson interval from rounded counts; skipped if the cohort file
      is missing.
  t49_state_meta: text only (state source used, sources checked, rules, which national rows were released).
Suppression (all computed on exact counts):
- primary: counts of 1-20 shown as "<=20"; other counts rounded up to 10;
- within a state: coded and uncoded (self-reporters minus coded) must each be 0 or above 20,
  else the coded count is hidden; zeros are never hidden;
- across states, national totals and the listed state counts receive complementary suppression in
  this same table. An unreleased unknown-state remainder is included when checking recoverability.
Shares and intervals are hidden with the counts they use.
"""

from __future__ import annotations

import math
import os
import re
import subprocess
import sys

import pandas as pd

try:
    import db_dtypes  # noqa: F401
except ImportError:
    pass

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import t25_p2_coded_shares as t25  # noqa: E402
import t26_p2_selfreport as t26  # noqa: E402
import t27_p2_selfreport_groups as t27  # noqa: E402
import t28_p2_selfreport_deep as t28  # noqa: E402
import t34_p2_obesity as t34  # noqa: E402
from aou_safe import MAX_SUPPRESSED, SUPPRESSED, check_exportable  # noqa: E402

EXPORT = os.path.expanduser("~/unm/export/49")
OUT = os.path.expanduser("~/unm/output")
COHORT = "cohort_v2.parquet"
JOINT = "<=20 jointly"           # hidden so that no count of 1-20 can be recovered; the value may be large
WITHHELD = "withheld"            # national total not released
NOT_AVAILABLE = "not available"
NATIONAL = "US"
ANCHORS = ["hypertension", "diabetes_type2"]
POPULATION = "5 or more years of EHR records before the survey"
MIN_VALID = 1000                 # a source with fewer usable state values is treated as absent
STATE_QUESTION = 1585249         # PPI: state of residence (The Basics, address block)
SOURCE_VALUE_COLS = ["state_of_residence_source_value"]
CONCEPT_COLS = ["state_of_residence_concept_id"]
Z = 1.959964
STATES = {
    "AL": "Alabama", "AK": "Alaska", "AZ": "Arizona", "AR": "Arkansas", "CA": "California", "CO": "Colorado",
    "CT": "Connecticut", "DE": "Delaware", "DC": "District of Columbia", "FL": "Florida", "GA": "Georgia",
    "HI": "Hawaii", "ID": "Idaho", "IL": "Illinois", "IN": "Indiana", "IA": "Iowa", "KS": "Kansas",
    "KY": "Kentucky", "LA": "Louisiana", "ME": "Maine", "MD": "Maryland", "MA": "Massachusetts", "MI": "Michigan",
    "MN": "Minnesota", "MS": "Mississippi", "MO": "Missouri", "MT": "Montana", "NE": "Nebraska", "NV": "Nevada",
    "NH": "New Hampshire", "NJ": "New Jersey", "NM": "New Mexico", "NY": "New York", "NC": "North Carolina",
    "ND": "North Dakota", "OH": "Ohio", "OK": "Oklahoma", "OR": "Oregon", "PA": "Pennsylvania",
    "RI": "Rhode Island", "SC": "South Carolina", "SD": "South Dakota", "TN": "Tennessee", "TX": "Texas",
    "UT": "Utah", "VT": "Vermont", "VA": "Virginia", "WA": "Washington", "WV": "West Virginia",
    "WI": "Wisconsin", "WY": "Wyoming", "PR": "Puerto Rico", "GU": "Guam", "VI": "U.S. Virgin Islands",
    "AS": "American Samoa", "MP": "Northern Mariana Islands",
}
NAME_TO_CODE = {v.lower(): k for k, v in STATES.items()} | {"virgin islands": "VI", "washington dc": "DC",
                                                            "washington, d.c.": "DC"}


# ----------------------------------------------------------------------------
# State of residence: detection and parsing
# ----------------------------------------------------------------------------

def to_postal(*values):
    """Two-letter postal code from a state source value, concept name, or concept code; None if unusable."""
    for v in values:
        if v is None or (isinstance(v, float) and math.isnan(v)):
            continue
        s = str(v).strip()
        if not s:
            continue
        m = re.fullmatch(r"(?:.*STATE[\s_:]*)?([A-Z]{2})", s.upper())
        if m and m.group(1) in STATES:
            return m.group(1)
        tail = re.split(r"[:_]", s)[-1].strip().lower()
        for cand in (s.lower(), tail):
            if cand in NAME_TO_CODE:
                return NAME_TO_CODE[cand]
    return None


def parse_states(raw: pd.DataFrame) -> pd.DataFrame:
    """raw: person_id plus any of sv (source value), cn (concept name), cc (concept code).
    Returns person_id, state for persons with exactly one usable state."""
    cols = [c for c in ("sv", "cn", "cc") if c in raw.columns]
    if raw.empty or not cols:
        return pd.DataFrame({"person_id": pd.Series(dtype="int64"), "state": pd.Series(dtype=object)})
    key = raw[cols].astype(object).where(raw[cols].notna(), None)
    uniq = key.drop_duplicates()
    lookup = {tuple(r): to_postal(*r) for r in uniq.itertuples(index=False)}
    d = pd.DataFrame({"person_id": raw.person_id.values,
                      "state": [lookup[tuple(r)] for r in key.itertuples(index=False)]})
    d = d.dropna(subset=["state"]).drop_duplicates()
    two = d.person_id[d.person_id.duplicated()]
    d = d[~d.person_id.isin(two)]
    return d.reset_index(drop=True)


def _columns(client, cdr, table):
    try:
        return {f.name for f in client.get_table(f"{cdr}.{table}").schema}
    except Exception:  # noqa: BLE001  (table absent or not readable)
        return set()


def state_candidates(client, cdr):
    """(label, sql) in order of preference: person, person_ext, then the PPI state question."""
    out, notes = [], []
    for table in ("person", "person_ext"):
        cols = _columns(client, cdr, table)
        sv = [c for c in SOURCE_VALUE_COLS if c in cols]
        cc = [c for c in CONCEPT_COLS if c in cols]
        if not sv and not cc:
            notes.append(f"{table}: no state_of_residence columns" if cols else f"{table}: table not readable")
            continue
        sel = [f"p.{sv[0]} AS sv"] if sv else []
        join = ""
        if cc:
            sel += ["c.concept_name AS cn", "c.concept_code AS cc"]
            join = f"LEFT JOIN `{cdr}.concept` c ON p.{cc[0]} = c.concept_id"
        label = f"{table}.{' and '.join(sv + cc)}"
        out.append((label, f"SELECT p.person_id, {', '.join(sel)} FROM `{cdr}.{table}` p {join}"))
    out.append((f"observation (question {STATE_QUESTION}, latest answer)", f"""
        SELECT o.person_id, o.value_source_value AS sv, c.concept_name AS cn, c.concept_code AS cc
        FROM `{cdr}.observation` o LEFT JOIN `{cdr}.concept` c ON o.value_source_concept_id = c.concept_id
        WHERE o.observation_source_concept_id = {STATE_QUESTION}
        QUALIFY ROW_NUMBER() OVER (PARTITION BY o.person_id ORDER BY o.observation_date DESC, o.observation_id DESC) = 1
    """))
    return out, notes


def query_state(cdr, client=None):
    """Raw rows of the first usable state source, its label, and notes on the sources checked."""
    if client is None:
        from google.cloud import bigquery
        client = bigquery.Client()
    cands, notes = state_candidates(client, cdr)
    for label, sql in cands:
        print(f"querying state of residence: {label}", flush=True)
        try:
            raw = client.query(sql).to_dataframe()
        except Exception as e:  # noqa: BLE001
            notes.append(f"{label}: query failed ({type(e).__name__})")
            continue
        if len(parse_states(raw)) >= MIN_VALID:
            notes.append(f"{label}: used")
            return raw, label, notes
        notes.append(f"{label}: fewer than {MIN_VALID:,} usable values")
    raise RuntimeError("no usable state of residence source: " + "; ".join(notes))


# ----------------------------------------------------------------------------
# Counts (exact; never exported)
# ----------------------------------------------------------------------------

def build_population(pop_raw, codes_raw, sr, resp, depth, ob):
    """Task 28's population with Task 34's obesity codes. Returns (base, codes, survey answers)."""
    codes_new = pd.concat([codes_raw[codes_raw.cond != t34.OB], ob[ob.person_id.isin(pop_raw.person_id)]],
                          ignore_index=True)
    pop_all, codes = t26.prepare(pop_raw, codes_new)
    pop_all = pop_all.merge(depth, on="person_id", how="left")
    pop_all["ehr_depth"] = pop_all.depth_days.map(t27.depth_band)
    pop = pop_all[pop_all.sex.isin(t26.SEXES)]
    srp = sr[sr.person_id.isin(pop.person_id)]
    resp_ids = (set(resp.person_id) & set(pop.person_id)) | set(srp.person_id)
    base = pop[pop.person_id.isin(resp_ids) & pop.ehr_depth.isin(t28.DEEP)]
    return base, codes, srp


def with_state(df: pd.DataFrame, state: pd.DataFrame) -> pd.DataFrame:
    out = df.merge(state, on="person_id", how="left")
    out["state"] = out.state.fillna(NOT_AVAILABLE)
    return out


def condition_counts(base, codes, sr, state):
    """Exact counts: population per state (Series) and {condition: DataFrame(state -> n, k)}."""
    b = with_state(base[["person_id", "sex"]], state)
    places = sorted(b.state.unique())
    popn = b.groupby("state").size().reindex(places, fill_value=0)
    out = {}
    for cond, qid in t26.FIRST_TOLD.items():
        keys = t26.CODE_KEY.get(cond, [cond])
        coded = set(codes.loc[codes.cond.isin(keys), "person_id"])
        ever = set(sr.loc[sr.q == qid, "person_id"])
        cur = set().union(*[set(sr.loc[(sr.q == q) & (sr.a == a), "person_id"]) for q, a in t26.CURRENT[cond]]) & ever
        sub = b[b.sex == "Female"] if cond == "endometriosis" else b
        is_cur = sub.person_id.isin(cur)
        g = pd.DataFrame({"state": sub.state, "n": is_cur.astype(int),
                          "k": (is_cur & sub.person_id.isin(coded)).astype(int)})
        out[cond] = g.groupby("state")[["n", "k"]].sum().reindex(places, fill_value=0)
    return popn, out


# ----------------------------------------------------------------------------
# Suppression
# ----------------------------------------------------------------------------

def _small(v) -> bool:
    return 0 < v <= MAX_SUPPRESSED


def r10(v) -> int:
    return t25.r10(v) if v > 0 else 0


def _need(vals: dict, hidden: list, unknown: int) -> bool:
    """Whether the same table's national total exposes a small residual or one hidden state.
    A positive, unlisted unknown-state remainder prevents recovering a single hidden state's count."""
    pos = [s for s in hidden if vals[s] > 0]
    hs = sum(vals[s] for s in pos)
    return (unknown == 0 and len(pos) == 1) or _small(hs + unknown)


def cross_state(states, vals: dict, is_hidden, hide, unknown: int) -> tuple[bool, bool]:
    """Hide the smallest shown nonzero state until _need is false. Returns (anything hidden, rules hold);
    the rules fail only when every nonzero state is already hidden."""
    changed = False
    while _need(vals, [s for s in states if is_hidden(s)], unknown):
        cand = [s for s in states if not is_hidden(s) and vals[s] > 0]
        if not cand:
            return changed, False
        hide(min(cand, key=lambda s: (vals[s], s)))
        changed = True
    return changed, True


def suppress_pair(nk: pd.DataFrame):
    """Exact n and k by state, including the unlisted NOT_AVAILABLE remainder.
    Returns labels for n and k and whether national counts need complementary suppression."""
    states = [s for s in nk.index if s != NOT_AVAILABLE]
    n = {s: int(nk.at[s, "n"]) for s in states}
    k = {s: int(nk.at[s, "k"]) for s in states}
    u = {s: n[s] - k[s] for s in states}
    un = int(nk.at[NOT_AVAILABLE, "n"]) if NOT_AVAILABLE in nk.index else 0
    uk = int(nk.at[NOT_AVAILABLE, "k"]) if NOT_AVAILABLE in nk.index else 0
    ln, lk = {s: None for s in states}, {s: None for s in states}
    for s in states:            # a zero is never hidden: it is releasable and protects nothing
        if _small(n[s]):
            ln[s] = SUPPRESSED
        if _small(k[s]):
            lk[s] = SUPPRESSED
        elif k[s] > 0 and _small(u[s]):
            lk[s] = JOINT

    def hide_n(s):
        ln[s] = JOINT

    def hide_k(s):
        lk[s] = JOINT

    def hide_u(s):              # uncoded is hidden by hiding coded, or self-reporters when coded is 0
        if k[s] > 0:
            lk[s] = JOINT
        else:
            ln[s] = JOINT
    columns = [(n, lambda s: ln[s] is not None, hide_n, un),
               (k, lambda s: lk[s] is not None, hide_k, uk),
               (u, lambda s: ln[s] is not None or lk[s] is not None, hide_u, un - uk)]
    ok, changed = True, True
    while changed:
        changed = False
        for vals, is_hidden, hide, unknown in columns:
            c, good = cross_state(states, vals, is_hidden, hide, unknown)
            changed |= c
            ok &= good
    return ln, lk, ok


def check_pair(nk: pd.DataFrame, ln: dict, lk: dict) -> bool:
    """Independent re-check of the released pattern; True if every rule holds."""
    states = [s for s in nk.index if s != NOT_AVAILABLE]
    rest = nk.loc[NOT_AVAILABLE] if NOT_AVAILABLE in nk.index else pd.Series({"n": 0, "k": 0})
    for col, hid in (("n", lambda s: ln[s] is not None), ("k", lambda s: lk[s] is not None),
                     ("u", lambda s: ln[s] is not None or lk[s] is not None)):
        vals = {s: int(nk.at[s, "n"] - nk.at[s, "k"]) if col == "u" else int(nk.at[s, col]) for s in states}
        unknown = int(rest["n"] - rest["k"]) if col == "u" else int(rest[col])
        if _need(vals, [s for s in states if hid(s)], unknown):
            return False
    for s in states:
        n, k = int(nk.at[s, "n"]), int(nk.at[s, "k"])
        if (ln[s] is None and _small(n)) or (lk[s] is None and _small(k)):
            return False
        if ln[s] is None and lk[s] is None and _small(n - k):
            return False
    return True


def suppress_population(popn: pd.Series):
    """Population per state, with the NOT_AVAILABLE row released. Returns (labels incl. NOT_AVAILABLE, ok)."""
    states = [s for s in popn.index if s != NOT_AVAILABLE]
    vals = {s: int(popn[s]) for s in states}
    lab = {s: SUPPRESSED if _small(v) else None for s, v in vals.items()}
    rest = int(popn.get(NOT_AVAILABLE, 0))
    lab[NOT_AVAILABLE] = SUPPRESSED if _small(rest) else None

    def hide(s):
        lab[s] = JOINT
    _, ok = cross_state(states, vals, lambda s: lab[s] is not None, hide, rest if _small(rest) else 0)
    return lab, ok


# ----------------------------------------------------------------------------
# Release tables
# ----------------------------------------------------------------------------

def wilson(k: int, n: int, z: float = Z) -> tuple[float, float]:
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return max(0.0, c - h), min(1.0, c + h)


def cell(nv: int, kv: int, ln, lk) -> dict:
    """Released counts, and the share and its Wilson interval, both from the rounded counts."""
    sn = ln if ln is not None else r10(nv)
    sk = lk if lk is not None else r10(kv)
    if ln is not None or lk is not None:
        lab = lk if lk is not None else ln
        return {"n": sn, "k": sk, "share": lab, "lo": lab, "hi": lab}
    if nv == 0:
        return {"n": 0, "k": 0, "share": float("nan"), "lo": float("nan"), "hi": float("nan")}
    lo, hi = wilson(sk, sn)
    return {"n": sn, "k": sk, "share": round(sk / sn, 3), "lo": round(lo, 3), "hi": round(hi, 3)}


def national_labels(nk: pd.DataFrame, ln: dict, lk: dict):
    nv, kv = int(nk.n.sum()), int(nk.k.sum())
    nlab = SUPPRESSED if _small(nv) else None
    klab = SUPPRESSED if _small(kv) else JOINT if kv > 0 and _small(nv - kv) else None
    states = list(ln)
    rest = nk.loc[NOT_AVAILABLE] if NOT_AVAILABLE in nk.index else pd.Series({"n": 0, "k": 0})
    for col in ("n", "k", "u"):
        vals = {s: int(nk.at[s, "n"] - nk.at[s, "k"]) if col == "u" else int(nk.at[s, col]) for s in states}
        hidden = [s for s in states if (ln[s] is not None if col == "n" else
                                        lk[s] is not None if col == "k" else ln[s] is not None or lk[s] is not None)]
        unknown = int(rest["n"] - rest["k"]) if col == "u" else int(rest[col])
        if _need(vals, hidden, unknown):
            if col == "n" or (col == "u" and kv == 0):
                nlab = nlab or (WITHHELD if nv > 0 else None)
            else:
                klab = klab or (WITHHELD if kv > 0 else None)
    return nv, kv, nlab, klab


def pair_rows(nk: pd.DataFrame):
    """Rows for every state plus the US row, and whether the US row was released."""
    ln, lk, ok = suppress_pair(nk)
    if ok and not check_pair(nk, ln, lk):
        raise RuntimeError("internal suppression re-check failed")
    states = [s for s in nk.index if s != NOT_AVAILABLE]
    rows = [{"state": s, **cell(int(nk.at[s, "n"]), int(nk.at[s, "k"]), ln[s], lk[s])} for s in states]
    nv, kv, nln, nlk = national_labels(nk, ln, lk)
    rows.append({"state": NATIONAL, **cell(nv, kv, nln, nlk)})
    return rows, ok


def add_relative(df: pd.DataFrame) -> pd.DataFrame:
    """Share relative to the mean of the same state's two anchor shares, from released values only; the
    interval divides the Wilson limits by that mean (Paper 2's approximation)."""
    df = df.copy()
    num = lambda v: v if isinstance(v, (int, float)) and not isinstance(v, bool) and not pd.isna(v) else None
    anchor = {}
    for s, g in df[df.condition.isin(ANCHORS)].groupby("state"):
        vals = [num(v) for v in g.share_coded]
        if len(vals) == len(ANCHORS) and all(v is not None for v in vals) and sum(vals) > 0:
            anchor[s] = sum(vals) / len(vals)
    rel, rlo, rhi = [], [], []
    for s, cond, sh, lo, hi in zip(df.state, df.condition, df.share_coded, df.share_ci_low, df.share_ci_high):
        if isinstance(sh, str):
            rel.append(sh); rlo.append(sh); rhi.append(sh)
        elif cond == "endometriosis" or s not in anchor or num(sh) is None:
            rel.append(float("nan")); rlo.append(float("nan")); rhi.append(float("nan"))
        else:
            m = anchor[s]
            rel.append(round(sh / m, 3)); rlo.append(round(lo / m, 3)); rhi.append(round(hi / m, 3))
    df["relative_to_anchors"], df["relative_ci_low"], df["relative_ci_high"] = rel, rlo, rhi
    return df


def shares_table(popn, counts):
    out, withheld = [], []
    for cond, nk in counts.items():
        rows, ok = pair_rows(nk)
        if not ok:
            withheld.append(cond)
        out += [{"state": r["state"], "condition": cond, "n_self_report_current": r["n"], "n_coded": r["k"],
                 "share_coded": r["share"], "share_ci_low": r["lo"], "share_ci_high": r["hi"]} for r in rows]
    return add_relative(pd.DataFrame(out)), withheld


def population_table(popn: pd.Series):
    lab, ok = suppress_population(popn)
    states = [s for s in popn.index if s != NOT_AVAILABLE]
    rows = [{"state": s, "state_name": STATES[s], "n_participants": lab[s] if lab[s] is not None else r10(int(popn[s]))}
            for s in states]
    rest = int(popn.get(NOT_AVAILABLE, 0))
    rows.append({"state": NOT_AVAILABLE, "state_name": "State not available",
                 "n_participants": lab[NOT_AVAILABLE] if lab[NOT_AVAILABLE] is not None else r10(rest)})
    total = int(popn.sum())
    total_label = SUPPRESSED if _small(total) else None if ok or total == 0 else WITHHELD
    rows.append({"state": NATIONAL, "state_name": "United States (all participants)",
                 "n_participants": total_label if total_label is not None else r10(total)})
    return pd.DataFrame(rows), ok


def longcovid_table(cohort: pd.DataFrame, state: pd.DataFrame):
    c = cohort if "person_id" in cohort.columns else cohort.rename_axis("person_id").reset_index()
    c = with_state(c[["person_id", "coded_455"]], state)
    nk = c.groupby("state").agg(n=("coded_455", "size"), k=("coded_455", "sum")).astype(int)
    if NOT_AVAILABLE not in nk.index:
        nk.loc[NOT_AVAILABLE] = [0, 0]
    rows, ok = pair_rows(nk)
    df = pd.DataFrame([{"state": r["state"], "n_cohort": r["n"], "n_coded_u099": r["k"], "share_coded": r["share"],
                        "share_ci_low": r["lo"], "share_ci_high": r["hi"]} for r in rows])
    return df, ok


def load_cohort():
    path = os.path.join(OUT, COHORT)
    if not os.path.exists(path):
        return None
    return pd.read_parquet(path)


def main(loader=None):
    if loader:
        pop_raw, codes_raw, sr, resp, depth, ob, site, state_raw, label, notes, cohort = loader()
    else:
        cdr = subprocess.check_output(["wb", "resolve", f"--id={t25.CDR_ID}"], text=True).strip()
        pop_raw, codes_raw, _ = t34.stage("Task 25 population and codes", t25.query, cdr)
        sr, resp, _ = t34.stage("survey answers", t26.query_survey, cdr)
        depth = t34.stage("EHR depth", t27.query_depth, cdr)
        ob = t34.stage("obesity codes in both tables", t34.query_obesity, cdr)
        state_raw, label, notes = t34.stage("state of residence", query_state, cdr)
        cohort = load_cohort()
    print("data loaded", flush=True)
    state = parse_states(state_raw)
    base, codes, srp = build_population(pop_raw, codes_raw, sr, resp, depth, ob)
    popn, counts = condition_counts(base, codes, srp, state)
    pop_df, pop_ok = population_table(popn)
    shares, withheld = shares_table(popn, counts)
    tables = {"t49_state_population": pop_df, "t49_state_shares": shares}
    lc_note = f"skipped: {COHORT} not found in ~/unm/output"
    if cohort is not None:
        lc, lc_ok = longcovid_table(cohort, state)
        tables["t49_state_longcovid"] = lc
        lc_note = (f"{COHORT} (Paper 1 coding-gap cohort: any U09.9 in days 1 to 455 after the COVID-19 index); "
                   f"US row {'released' if lc_ok else 'withheld'}")
    n_states = len([s for s in popn.index if s != NOT_AVAILABLE])
    tables["t49_state_meta"] = pd.DataFrame([
        ("population", f"Paper 2 main analysis: active adult EHR patients (women and men) who took the Personal and "
                       f"Family Health History or Personal Medical History survey, {POPULATION}; endometriosis among women"),
        ("codes", "Task 25 ICD-10-CM codes from condition_occurrence; obesity also from observation (Task 34)"),
        ("state_source", label),
        ("state_sources_checked", "; ".join(notes)),
        ("state_rule", "two-letter postal code; skips, unparseable values, and persons with two states are not available"),
        ("states_listed", f"{n_states} states"),
        ("population_us_row", "released" if pop_ok else "withheld"),
        ("shares_us_rows", "released for all conditions" if not withheld else "withheld for " + ", ".join(withheld)),
        ("longcovid", lc_note),
        ("labels", f"{SUPPRESSED}: count of 1 to 20; {JOINT}: hidden so that no count of 1 to 20 can be recovered "
                   f"by subtraction (the hidden value may be large); "
                   + f"{WITHHELD}: national total not released"),
        ("intervals", "share_coded and its 95% Wilson interval from the counts rounded up to 10; relative_to_anchors "
                      "and its interval divide by the mean of the state's released anchor shares (blank for "
                      "endometriosis or when an anchor is hidden)"),
    ], columns=["item", "value"])
    os.makedirs(EXPORT, exist_ok=True)
    for name, df in tables.items():
        check_exportable(df)
        df.to_csv(os.path.join(EXPORT, f"{name}.csv"), index=False)
        print(f"exported {name} ({len(df)} rows)", flush=True)
    print("Task 49 finished", flush=True)


if __name__ == "__main__":
    main()
