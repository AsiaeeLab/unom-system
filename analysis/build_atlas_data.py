"""Build the data behind the Atlas (web/web/atlas/): one JSON file per supported condition.

The Atlas shows one condition at a time. For each condition this script writes
web/web/atlas/data/conditions/<slug>.json, all with the schema below, and conditions/index.json, the list the
condition selector shows, grouped by family (FAMILIES below). A condition is listed only when its source tables
exist, so lupus appears as soon as results/aggregate holds lupus rows in the Paper 2 formats (SELF_REPORT["lupus"]
below); no page code changes. Likewise a condition's "what else is in the record" panel appears once its
feature-by-label table exists (migraine, depression, and anxiety read Task 55's tables): rerun this script.

It also rewrites two older files that other pages read; their schema and values are unchanged:
invisible.json (the homepage's Atlas alt text and the deck) and long_covid.json (the deck).

Inputs are released All of Us aggregates (results/) and federal open data (opendata/processed/) only. Every
block of numbers in a condition file names its file in "src", with the rows ("where", "key") and columns it
read, so web/test/atlas.test.js can trace each value back and recompute it.

Disclosure (audit spec, 2026-10-15: each released source table separately):
  * No All of Us participant count, numerator or denominator, is written to a condition file: only shares,
    ratios, and their intervals.
  * Cells released as "<=20", "hidden", or "<=20 jointly" stay hidden ("why": "suppressed").
  * Worst case, a reader could recover the counts behind a share from its binomial (Wilson) interval. Treating
    every such share as if its counts were shown, audit() checks each population within its source table: in a complete partition
    (age groups, the two sexes, race and ethnicity groups) whose total is known on the page, a hidden group may
    never be hidden alone, and the hidden groups together may not total 1 to 20. A failing partition gets
    complementary suppression, its smallest shown group hidden too ("why": "complement"), until it passes.
    The test repeats this audit from the released files. Each condition adds its populations to the same audit.
    Endometriosis (women only) has no sex axis, so its all-lengths total is not on the page.
  * Wearable profiles show means and 95% intervals, never group sizes. A group released as "<=20" or "<=20
    jointly", or whose count is not a number over 20, stays hidden. A mean's interval does not give its count
    back (the spread behind it is not shown), so these rows add no partition to the audit. The Long COVID weekly
    series follows the same rule week by week: a measure-week whose count was released as "<=20", "hidden", or
    "<=20 jointly" is null, a gap on the page.

Measures
  Long COVID: coding fraction, the share of the COVID-19 cohort with a U09.9 code in days 1 to 455 divided by
    Household Pulse Survey prevalence among adults who had COVID-19 (Paper 1, results/derived/coding_gap.csv).
  Other conditions: share coded, the share of survey respondents reporting a clinician diagnosis with current
    visits or treatment whose EHR carries a qualifying ICD-10-CM code (Paper 2). The headline uses Paper 2's
    primary population (5 or more years of records; Task 46 item 4 counts); groups use all lengths of record
    (Tasks 26 and 27, as in Paper 2's eTables), each with the mean of the hypertension and type 2 diabetes
    shares in the same group as the comparison mark. Wilson intervals from the released counts, the
    construction in paper2/coding_estimates.py; build_selfreport() checks every value against
    paper2/results/ when the condition is in Paper 2.
    Endometriosis is analyzed among women, as in Paper 2, and its comparison mark is the mean of the two
    shares among women in the same group (Paper 2's female anchor mean, Task 46).
  Related conditions: share of people with the condition who have each coded condition or symptom, over the
    share of the comparison group (feature-by-label 2x2 counts released for the models in Papers 1 and 3 and the
    app's models in Tasks 54 and 55; for Lyme disease, Task 7's cases and matched controls), with Wilson
    intervals for each share and a log-scale (Katz) interval for the ratio, from the released (rounded) counts.
  Wearable profiles (ME/CFS, fibromyalgia, endometriosis): Task 48 Part B, Fitbit per-person daily means over
    the year before the survey, averaged by group with 95% CIs as released (steps, sedentary minutes, very
    active minutes, minutes asleep). The resting heart rate rows are left out: every released value is 30.0.
  Long COVID weekly activity and sleep: Task 48 Part A, the series the Research page drew. For each week from
    26 before to 26 after the COVID-19 diagnosis, the mean of per-person weekly means (95% CI) of daily steps,
    sedentary minutes, and minutes asleep, for everyone and by group (chart score band at day 90 High or
    Elevated against Typical; 2 or more new symptom types by day 90 against fewer). Same rules as the profiles.

Schema of conditions/<slug>.json ("unom-atlas-condition/1")
  schema, slug, label (selector text), name (heading), order, family (selector group), definition, source
  (every file)
  summary: [{id, display, text, link (panel id), value, src}]           up to 3 key numbers
  map: {layers: [{id, label (toggle), title, takeaway, unit ("proportion" | "percent" | "per100k"),
        bins: [{max, label}], national: {label, v, lo, hi} | null,
        states: {ST: {v, lo, hi, rel?, rlo?, rhi?, band?} | {v: null, why}}, missing: {why: legend text},
        population, complete: false, src, source, counties?}]}
  groups: {title, x_label, unit, domain, ref_label | null, ref_name?, variants: [{id, label, takeaway, axes: [{id, title,
        population, complete, src, ref_src?, note?, rows: [{id, label, v, lo, hi, ref?, ...} | {id, label,
        v: null, why}]}]}], source}
  related: {title, takeaway, with_label, without_label, note, groups: [{id, title}], rows: [{id, label, group,
        with, with_lo, with_hi, without, without_lo, without_hi, ratio, lo, hi} (hidden parts null, with why)],
        population, src, source}
  wearables: null | {groups: [{id, title}], note, measures: [{id, label (toggle), title, x_label, phrase, unit
        ("steps" | "minutes"), digits, takeaway, src, rows: [{id, label, group, v, lo, hi} | {id, label, group,
        v: null, why}]}], population, source}
  trajectory: null | {takeaway, takeaway_src, note, weeks: [-26 ... 26], comparisons: [{id, label (toggle),
        groups: [{id, label}]}], measures: [{id, label (toggle), title, y_label, phrase, unit, digits, src,
        series: {group: {v: [], lo: [], hi: []}}}], population, source}          (Long COVID only; one value per
        week, null where the week is hidden)
  calculator: null | {model, measured: {...}, src, source}                  (Long COVID only)
  "why": "suppressed" (released as <=20, hidden, or <=20 jointly), "complement" (hidden by audit()), or
  "none" (no participants or no published estimate). "source": {authors?, title?, text} renders as one line.

Run: python3 analysis/build_atlas_data.py [--out DIR]   (default web/web/atlas/data; the test writes to a
temporary directory and compares)
"""
import argparse
import glob
import json
import math
import os
import re
from decimal import ROUND_HALF_UP, Decimal

import pandas as pd

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "web/web/atlas/data")
Z = 1.96
SCHEMA = "unom-atlas-condition/1"

# ---------- released files ----------
P2_GROUPS = "results/aggregate/27/t27_selfreport_by_group.csv"      # age and race and ethnicity, all lengths
P2_SEX = "results/aggregate/26/t26_selfreport_vs_code.csv"          # sex, all lengths
P2_PRIMARY = "results/aggregate/46/t46_code_coverage.csv"           # 5 or more years of records (Table 2 "All")
P2_SEXADJ = "results/aggregate/46/t46_sex_adjusted.csv"             # women-to-men ratios within health systems
P2_FEMALE_ANCHORS = "results/aggregate/46/t46_female_anchors.csv"   # anchors among women, by group (endometriosis)
P2_STATES = "results/aggregate/49/t49_state_shares.csv"             # Paper 2 population by state of residence
LC_STATES = "results/aggregate/49/t49_state_longcovid.csv"          # Paper 1 cohort by state of residence
LC_GAP = "results/derived/coding_gap.csv"                           # Paper 1 coding fraction by group
LC_2X2 = "results/aggregate/35/t04_feature_label_counts.csv"        # Paper 1 summary-count model (Task 35 rerun)
LC_COST = "results/derived/odyssey_cost.csv"
LC_PERF = "results/aggregate/47/t47_t03_subgroups.csv"
LC_LEAD = "results/aggregate/35/t03_lead_time.csv"
HPS_STATES = "opendata/processed/hps_long_covid_states.csv"         # opendata/scripts/hps_states.py
HPS_GROUPS = "opendata/processed/hps_priors_by_group.csv"           # opendata/scripts/hps_priors.py
LYME_CDC = "opendata/processed/lyme_county_incidence.csv"
LYME_PRE = "results/aggregate/07/t07_lyme_prediagnosis.csv"
P2_CHECK_GROUPS = "paper2/results/coding_estimates_groups.csv"
P2_CHECK_SEX = "paper2/results/coding_estimates_selfreport.csv"

ANCHORS = ["hypertension", "diabetes_type2"]
AGE = [("18-39", "18 to 39"), ("40-49", "40 to 49"), ("50-59", "50 to 59"), ("60-69", "60 to 69"),
       ("70+", "70 and older")]
SEX = [("Female", "Women"), ("Male", "Men")]
RACE = [("Hispanic or Latino", "Hispanic or Latino"), ("NH Asian", "Non-Hispanic Asian"),
        ("NH Black", "Non-Hispanic Black"), ("NH White", "Non-Hispanic White"),
        ("NH other or multiple", "Non-Hispanic other or multiple races"), ("Unknown", "Unknown")]
HIDDEN_LABELS = ("<=20", "hidden", "<=20 jointly")

# Supported conditions measured by self-report (Paper 2). "aou" is the condition id in the released tables.
# related: the feature-by-label table, its feature labels, and the feature prefix shown; None for Lyme disease,
# which uses Task 7's cases and matched controls instead.
SELF_REPORT = {
    "mecfs": {
        "aou": "chronic_fatigue", "label": "ME/CFS", "name": "Chronic fatigue (ME/CFS)", "noun": "chronic fatigue",
        "definition": "The survey asks whether a clinician diagnosed chronic fatigue; a code means ICD-10-CM G93.3 "
                      "(ME/CFS) or R53.82 (chronic fatigue, unspecified).",
        "related": {"file": "results/aggregate/33/t33_feature_label_counts.csv",
                    "labels": "workbench/src/features_cf.json", "prefix": "cx_"},
        "paper2": True,
    },
    "fibromyalgia": {
        "aou": "fibromyalgia", "label": "Fibromyalgia", "name": "Fibromyalgia", "noun": "fibromyalgia",
        "definition": "The survey asks whether a clinician diagnosed fibromyalgia; a code means ICD-10-CM M79.7.",
        "related": {"file": "results/aggregate/39/t39_fibromyalgia_feature_label_counts.csv",
                    "labels": "workbench/src/features_fibro.json", "prefix": "cx_"},
        "paper2": True,
    },
    "lyme": {
        "aou": "lyme", "label": "Lyme disease", "name": "Lyme disease", "noun": "Lyme disease",
        "definition": "The survey asks whether a clinician diagnosed Lyme disease; a code means ICD-10-CM A69.2.",
        "related": None,
        "paper2": True,
    },
    # Lupus: built only when a released table in the Paper 2 formats has rows for condition "lupus" (see
    # find_with()); the related-conditions table is any results/aggregate/*/*lupus*feature_label_counts.csv,
    # labeled from workbench/src/features_lupus.json when it exists.
    "lupus": {
        "aou": "lupus", "label": "Lupus", "name": "Lupus", "noun": "lupus",
        "definition": "The survey asks whether a clinician diagnosed lupus; a code means ICD-10-CM M32.",
        "related": {"file": "results/aggregate/*/*lupus*feature_label_counts.csv",
                    "labels": "workbench/src/features_lupus.json", "prefix": "cx_"},
        "paper2": False,
    },
    # Endometriosis: women only (Paper 2 analyzed participants recorded as female at birth), so there is no sex
    # axis, and the comparison mark is hypertension and type 2 diabetes among women (Paper 2's female anchor mean).
    "endometriosis": {
        "aou": "endometriosis", "label": "Endometriosis", "name": "Endometriosis", "noun": "endometriosis",
        "definition": "The survey asks whether a clinician diagnosed endometriosis; a code means ICD-10-CM N80. "
                      "Women only (participants recorded as female at birth).",
        "related": {"file": "results/aggregate/39/t39_endometriosis_feature_label_counts.csv",
                    "labels": "workbench/src/features_endo.json", "prefix": "cx_"},
        "paper2": True, "women_only": True,
    },
    # Migraine, depression, and anxiety: the related panel reads Task 55's tables, which appear once that run is
    # released; until then the glob finds nothing and the panel is absent (rerun this script, no code change).
    "migraine": {
        "aou": "migraine", "label": "Migraine", "name": "Migraine", "noun": "migraine",
        "definition": "The survey asks whether a clinician diagnosed migraine; a code means ICD-10-CM G43.",
        "related": {"file": "results/aggregate/55/t55_migraine_feature_label_counts.csv",
                    "labels": "workbench/src/features_migraine.json", "prefix": "cx_"},
        "paper2": True,
    },
    "depression": {
        "aou": "depression", "label": "Depression", "name": "Depression", "noun": "depression",
        "definition": "The survey asks whether a clinician diagnosed depression; a code means ICD-10-CM F32 or F33.",
        "related": {"file": "results/aggregate/55/t55_depression_feature_label_counts.csv",
                    "labels": "workbench/src/features_depression.json", "prefix": "cx_"},
        "paper2": True,
    },
    "anxiety": {
        "aou": "anxiety", "label": "Anxiety", "name": "Anxiety", "noun": "anxiety",
        "definition": "The survey asks whether a clinician diagnosed anxiety; a code means ICD-10-CM F41.",
        "related": {"file": "results/aggregate/55/t55_anxiety_feature_label_counts.csv",
                    "labels": "workbench/src/features_anxiety.json", "prefix": "cx_"},
        "paper2": True,
    },
}
# The selector groups conditions by family; ORDER is the page order (families in turn, then within each).
FAMILIES = [
    ("infection", "Infection-associated chronic illness", ["longcovid", "mecfs", "lyme"]),
    ("autoimmune", "Autoimmune", ["lupus"]),
    ("pain", "Chronic pain", ["fibromyalgia", "migraine"]),
    ("womens", "Women's health", ["endometriosis"]),
    ("mental", "Mental health", ["depression", "anxiety"]),
]
ORDER = [slug for _, _, slugs in FAMILIES for slug in slugs]
FAMILY_OF = {slug: fid for fid, _, slugs in FAMILIES for slug in slugs}

# Wearable profiles (Task 48, Part B): Fitbit means for the model cohorts of these conditions.
WEAR = "results/aggregate/48/t48_selfreport_profiles.csv"
WEAR_SOURCE = "NIH All of Us Research Program, Registered Tier v9, Fitbit data; analysis from this project (not in a paper)."
# (released group, page group, row label); the standardized row's label names the mix it is standardized to.
WEAR_GROUPS = [
    ("self-reporters, never coded", "report", "Never coded"),
    ("self-reporters, coded later", "report", "Coded later"),
    ("all self-reporters", "report", "All"),
    ("non-reporters", "other", "As observed"),
    ("non-reporters, standardized to self-reporters by age band and sex", "other", None),
]
# (released measure, id, toggle label, axis label, phrase after a value, unit, digits). The resting heart rate
# rows are not used: every released value is 30.0 bpm, a data artifact.
WEAR_MEASURES = [
    ("mean daily steps", "steps", "Daily steps", "Steps a day", "steps a day", "steps", 0),
    ("mean daily sedentary minutes", "sedentary", "Sedentary minutes", "Sedentary minutes a day",
     "sedentary minutes a day", "minutes", 0),
    ("mean daily very active minutes", "very_active", "Very active minutes", "Very active minutes a day",
     "very active minutes a day", "minutes", 1),
    ("mean minutes asleep (main sleep)", "asleep", "Minutes asleep", "Minutes asleep a night (main sleep)",
     "minutes asleep a night", "minutes", 0),
]

# The Long COVID weekly series (Task 48, Part A): weeks -26 to +26 from the COVID-19 diagnosis, by group.
TRAJ = "results/aggregate/48/t48_lc_trajectory.csv"
TRAJ_WEEKS = list(range(-26, 27))
# (released column, toggle label, axis label, phrase after a value, unit, digits); rest_hr is left out, as above.
TRAJ_MEASURES = [
    ("steps", "Daily steps", "Steps a day", "steps a day", "steps", 0),
    ("sedentary", "Sedentary minutes", "Sedentary minutes a day", "sedentary minutes a day", "minutes", 0),
    ("asleep", "Minutes asleep", "Minutes asleep a night", "minutes asleep a night", "minutes", 0),
]
TRAJ_COMPARISONS = [
    ("band", "Chart score at day 90", [("band_high_or_elevated", "High or Elevated"), ("band_typical", "Typical")]),
    ("symptoms", "New symptom types by day 90", [("sym_count_ge2", "2 or more"), ("sym_count_lt2", "0 or 1")]),
    ("all", "Everyone", [("all", "Everyone")]),
]

# Paper 1's prior-condition features carry no labels in workbench/src/features.json.
LC_LABELS = {
    "hx_asthma": "Asthma", "hx_copd": "COPD", "hx_diabetes": "Diabetes", "hx_obesity": "Obesity",
    "hx_hypertension": "Hypertension", "hx_depression": "Depression", "hx_anxiety": "Anxiety",
    "hx_migraine": "Migraine", "hx_fibromyalgia": "Fibromyalgia", "hx_mecfs": "ME/CFS",
    "hx_chronic_pain": "Chronic pain", "hx_sleep_apnea": "Sleep apnea", "hx_autoimmune": "Autoimmune disease",
    "hx_hypothyroid": "Hypothyroidism", "hx_heart_disease": "Coronary disease or heart failure",
    "sym_any_fatigue": "Fatigue or malaise", "sym_any_dyspnea": "Shortness of breath", "sym_any_cough": "Cough",
    "sym_any_chest_pain": "Chest pain",
    "sym_any_autonomic": "Palpitations, tachycardia, POTS, or orthostatic hypotension",
    "sym_any_mood": "Anxiety or depression", "sym_any_msk_pain": "Muscle or joint pain",
    "sym_any_gi": "Gastrointestinal symptoms", "sym_any_w3_count_ge2": "2 or more symptom types in days 31 to 90",
    "sym_any_w3_count_ge3": "3 or more symptom types in days 31 to 90",
}
LYME_LABELS = {
    "joint_pain_or_arthritis": "Joint pain or arthritis", "fatigue": "Fatigue", "rash": "Rash",
    "facial_palsy": "Facial palsy", "headache": "Headache", "fever": "Fever", "myalgia": "Muscle pain",
    "paresthesia_neuropathy": "Tingling, numbness, or neuropathy",
    "heart_block_palpitations": "Heart block or palpitations", "tick_bite_or_insect_bite": "Tick or insect bite",
}
CDC_BINS = [(1, "Under 1 per 100,000 (low)"), (10, "1 to under 10 (moderate)"), (30, "10 to under 30 (high)"),
            (60, "30 to under 60 (high)"), (None, "60 or more (high)")]


def path(rel):
    return os.path.join(ROOT, rel)


def read(rel):
    return pd.read_csv(path(rel), dtype=str, keep_default_na=False)


def num(v, nd=None):
    """Float or None; disclosure labels such as '<=20' or 'hidden' and blanks become None."""
    try:
        x = float(v)
    except (TypeError, ValueError):
        return None
    if math.isnan(x) or math.isinf(x):
        return None
    return round(x, nd) if nd is not None else x


def count(v):
    """A released count as an int, or None when it is hidden or blank."""
    x = num(v)
    return None if x is None else int(round(x))


def r4(x):
    return None if x is None else round(float(x), 4)


def half_up(x, nd=0):
    q = Decimal(1).scaleb(-nd)
    return Decimal(repr(float(x))).quantize(q, rounding=ROUND_HALF_UP)


def pct(x, nd=0):
    """Proportion as percent text, rounded half up: 0.6255 -> '63%'."""
    return f"{half_up(x * 100, nd)}%"


def fmt(x, nd=2):
    return f"{half_up(x, nd)}"


PROPER = ("Ehlers", "Lyme", "Long COVID", "COVID", "COPD", "ME/CFS", "POTS")


def article(word):
    return "an" if word[:1].lower() in "aeiou" else "a"


def lower_first(label):
    """A label inside a sentence: 'Mast cell disorder' -> 'mast cell disorder'; names and acronyms keep case."""
    return label if label.startswith(PROPER) else label[:1].lower() + label[1:]


def wilson(k, n):
    """Paper 2's Wilson interval (paper2/coding_estimates.py)."""
    p = k / n
    d = 1 + Z ** 2 / n
    c = (p + Z ** 2 / (2 * n)) / d
    h = Z * math.sqrt(p * (1 - p) / n + Z ** 2 / (4 * n ** 2)) / d
    return p, c - h, c + h


def katz(a, n1, b, n0):
    """Ratio of two proportions a/n1 over b/n0 with a log-scale (Katz) 95% interval."""
    r = (a / n1) / (b / n0)
    se = math.sqrt(1 / a - 1 / n1 + 1 / b - 1 / n0)
    return r, r * math.exp(-Z * se), r * math.exp(Z * se)


def paper_title(rel):
    t = open(path(rel)).read()
    s = re.search(r"^\\title\{(.*)\}\s*$", t, re.M).group(1)
    return re.sub(r"^\\rev\{(.*)\}$", r"\1", s)


# Titles of the companion manuscripts (their sources are not in this repository).
P1 = 'Long COVID undercoding and prediction from releasable electronic health record summaries in All of Us'
P2 = 'Electronic Health Record Coding of Self-Reported Diagnoses in the All of Us Research Program'
P3 = 'Self-reported diagnoses as training labels for finding uncoded chronic fatigue, fibromyalgia, and endometriosis in the All of Us Research Program'
AUTHORS = "Asiaee and Aryan"
AOU = "NIH All of Us Research Program, Registered Tier v9"


def cite(title, text):
    return {"authors": AUTHORS, "title": title, "text": f"manuscript submitted for publication; {text}"}


# ---------- disclosure audit ----------

class Audit:
    """Partitions of each population whose counts a reader could recover (worst case) from the page.

    axis(pop, id, complete, rows): rows are dicts with released counts "num" and "den" (int or None) and
    "shown" (bool); the same dicts are the JSON rows' audit twins, so complementary suppression edits both.
    total(pop, num, den): a total shown on the page (for example a national row or the headline)."""

    def __init__(self):
        self.pops = {}

    def axis(self, pop, axis_id, complete, rows, table=""):
        pop = (pop, table)
        self.pops.setdefault(pop, {"axes": [], "totals": []})["axes"].append(
            {"id": axis_id, "complete": complete, "rows": rows})

    def total(self, pop, n, d, table=""):
        pop = (pop, table)
        self.pops.setdefault(pop, {"axes": [], "totals": []})["totals"].append({"num": n, "den": d})

    @staticmethod
    def known_total(p, kind):
        for t in p["totals"]:
            if t[kind] is not None:
                return t[kind]
        for a in p["axes"]:
            if a["complete"] and all(r["shown"] and r[kind] is not None for r in a["rows"]):
                return sum(r[kind] for r in a["rows"])
        return None

    def violations(self):
        out = []
        for pop, p in self.pops.items():
            for kind in ("num", "den"):
                total = self.known_total(p, kind)
                if total is None:
                    continue
                for a in p["axes"]:
                    hidden = [r for r in a["rows"] if not r["shown"]]
                    if not a["complete"] or not hidden:
                        continue
                    residual = total - sum(r[kind] for r in a["rows"] if r["shown"])
                    if len(hidden) == 1 or 1 <= residual <= 20:
                        out.append((pop, a, kind))
        return out

    def enforce(self):
        """Complementary suppression until no violation remains; returns the rows it hid."""
        hid = []
        while True:
            v = self.violations()
            if not v:
                return hid
            pop, a, kind = v[0]
            shown = [r for r in a["rows"] if r["shown"] and r[kind] is not None]
            if not shown:
                raise SystemExit(f"audit: {pop} {a['id']} cannot be fixed by suppression")
            r = min(shown, key=lambda r: r[kind])
            r["shown"] = False
            r["json"].update({"v": None, "lo": None, "hi": None, "why": "complement"})
            r["json"].pop("ref", None)
            hid.append((pop[0], a["id"], r["json"]["id"]))


def strip_nulls(row):
    """Hidden rows keep only id, label, group, v (null), why, and any shown part (related rows)."""
    if row.get("v") is None and "why" in row:
        return {k: v for k, v in row.items() if v is not None or k == "v"}
    return row


# ---------- map helpers ----------

def nice_bins(values, unit):
    """Five bins with round edges spanning the shown values."""
    steps = [0.01, 0.02, 0.03, 0.04, 0.05, 0.1] if unit == "proportion" else [0.5, 1, 2, 2.5, 3, 4, 5, 10]
    lo_v, hi_v = min(values), max(values)
    for step in steps:
        lo = math.floor(lo_v / step + 1e-9) * step
        if math.ceil((hi_v - lo) / step - 1e-9) <= 5:
            break
    edges = [round(lo + step * i, 4) for i in range(1, 5)]
    label = (lambda e: pct(e, 0 if step >= 0.01 else 1)) if unit == "proportion" else (lambda e: f"{fmt(e, 1 if step < 1 else 0)}%")
    bins = [{"max": edges[0], "label": f"Under {label(edges[0])}"}]
    for a, b in zip(edges, edges[1:]):
        bins.append({"max": b, "label": f"{label(a)} to under {label(b)}"})
    bins.append({"max": None, "label": f"{label(edges[-1])} or more"})
    return bins


def state_names():
    d = read(LYME_CDC).drop_duplicates("state")
    names = dict(zip(d.state, d.state_name))
    names["PR"] = "Puerto Rico"
    return names


# ---------- self-reported conditions (Paper 2) ----------

def tables(suffix, canonical):
    """The Paper 2 file first, then any later release with the same layout (e.g. a lupus task)."""
    files = [canonical] + sorted(os.path.relpath(f, ROOT) for f in glob.glob(path(f"results/aggregate/*/*{suffix}")))
    return list(dict.fromkeys(f for f in files if os.path.exists(path(f))))


def find_with(suffix, canonical, aou, col="condition"):
    for f in tables(suffix, canonical):
        d = read(f)
        if col in d.columns and (d[col] == aou).any():
            return f, d
    return None, None


def share_cell(r, num_col, den_col):
    """JSON row and audit twin for one released row."""
    k, n = count(r[num_col]), count(r[den_col])
    if k is not None and n is not None and n > 0:
        p, lo, hi = wilson(k, n)
        return {"v": r4(p), "lo": r4(lo), "hi": r4(hi)}, {"num": k, "den": n, "shown": True}
    why = "suppressed" if any(str(r[c]).strip() in HIDDEN_LABELS for c in (num_col, den_col)) else "none"
    return {"v": None, "why": why}, {"num": k, "den": n, "shown": False}


def anchor_means(d, filt):
    """Mean of the hypertension and type 2 diabetes shares per group (None when either is hidden)."""
    out = {}
    a = d[d.condition.isin(ANCHORS)]
    for key, g in a[filt(a)].groupby("group" if "group" in a.columns else "sex"):
        ps = []
        for c in ANCHORS:
            x = g[g.condition == c]
            if len(x) == 0:
                break
            k, n = count(x.n_both_current.iloc[0]), count(x.n_self_report_current.iloc[0])
            if k is None or not n:
                break
            ps.append(k / n)
        out[key] = r4(sum(ps) / len(ps)) if len(ps) == len(ANCHORS) else None
    return out


def check_paper2(aou, axis, rows, by_key):
    """Every share and interval equals Paper 2's (paper2/results), and hidden cells match."""
    for row in rows:
        p = by_key.get(row["id"])
        if p is None:
            continue
        pv = num(p["p"])
        if row.get("v") is None:
            if row.get("why") != "complement" and pv is not None:
                raise SystemExit(f"{aou} {axis} {row['id']}: hidden here, shown in Paper 2")
            continue
        for mine, theirs in (("v", "p"), ("lo", "lo"), ("hi", "hi")):
            if abs(row[mine] - num(p[theirs])) > 6e-5:
                raise SystemExit(f"{aou} {axis} {row['id']} {mine}: {row[mine]} vs Paper 2 {p[theirs]}")


def build_selfreport(slug, cfg, audit):
    aou, noun = cfg["aou"], cfg["noun"]
    women = cfg.get("women_only", False)
    who = "women" if women else "people"
    g_file, g = find_with("_selfreport_by_group.csv", P2_GROUPS, aou)
    s_file, s = find_with("_selfreport_vs_code.csv", P2_SEX, aou)
    h_file, h = find_with("_code_coverage.csv", P2_PRIMARY, aou)
    st_file, st = find_with("_state_shares.csv", P2_STATES, aou)
    if g is None or s is None:
        return None
    g = g.drop_duplicates(["condition", "axis", "group"])
    sources = [f for f in (g_file, s_file, h_file, st_file) if f]
    pop_all = f"{slug}: current self-reporters, all lengths of record"
    pop_deep = f"{slug}: current self-reporters, 5 or more years of records"

    # Anchors come from the same file when it has them, else from Paper 2's; for a women-only condition, the
    # anchors among women (Paper 2's female anchor mean).
    if women:
        ga = read(P2_FEMALE_ANCHORS).drop_duplicates(["condition", "axis", "group"])
        ga_file = P2_FEMALE_ANCHORS
    else:
        ga = g if g.condition.isin(ANCHORS).any() else read(P2_GROUPS).drop_duplicates(["condition", "axis", "group"])
        ga_file = g_file if ga is g else P2_GROUPS
    sa = s if s.condition.isin(ANCHORS).any() else read(P2_SEX)
    sa_file = s_file if sa is s else P2_SEX
    sources += [ga_file] + ([] if women else [sa_file])
    ref_name = "hypertension and type 2 diabetes" + (" among women" if women else "")

    p2g = {}
    p2s = {}
    if cfg["paper2"]:
        cg = read(P2_CHECK_GROUPS)
        for r in cg[cg.condition == aou].to_dict("records"):
            p2g[(r["axis"], r["group"])] = {"p": r["p_code_current"], "lo": r["ci_low"], "hi": r["ci_high"]}
        cs = read(P2_CHECK_SEX)
        for r in cs[(cs.condition == aou) & (cs.self_report == "current")].to_dict("records"):
            p2s[r["sex"]] = {"p": r["p_code"], "lo": r["ci_low"], "hi": r["ci_high"]}
        sources += [P2_CHECK_GROUPS, P2_CHECK_SEX]

    axes = []
    for axis_id, title, csv_axis, groups in (("age", "Age group", "age_band", AGE), ("sex", "Sex", None, SEX),
                                             ("race", "Race and ethnicity", "race_eth", RACE)):
        if axis_id == "sex" and women:
            continue    # one sex: the axis would repeat the whole population
        if csv_axis:
            src_df, where, key, ref_df, ref_file = g[(g.condition == aou) & (g.axis == csv_axis)], \
                {"condition": aou, "axis": csv_axis}, "group", ga, ga_file
            refs = anchor_means(ref_df, lambda a, ax=csv_axis: a.axis == ax)
            file = g_file
        else:
            src_df, where, key, ref_df, ref_file = s[s.condition == aou], {"condition": aou}, "sex", sa, sa_file
            refs = anchor_means(ref_df, lambda a: a.sex.isin(["Female", "Male"]))
            file = s_file
        rows, twins = [], []
        for gid, glabel in groups:
            x = src_df[src_df[key] == gid]
            if x.empty:
                continue
            cell, twin = share_cell(x.iloc[0], "n_both_current", "n_self_report_current")
            row = {"id": gid, "label": glabel, **cell}
            if row["v"] is not None and refs.get(gid) is not None:
                row["ref"] = refs[gid]
            twin["json"] = row
            rows.append(row)
            twins.append(twin)
        audit.axis(pop_all, axis_id, True, twins, table=file)
        ax = {"id": axis_id, "title": title, "population": pop_all, "complete": True,
              "src": {"file": file, "where": where, "key": key, "num": "n_both_current",
                      "den": "n_self_report_current", "ci": "wilson"},
              "ref_src": {"file": ref_file, "where": {k: v for k, v in where.items() if k != "condition"},
                          "conditions": ANCHORS, "key": key, "num": "n_both_current", "den": "n_self_report_current",
                          "op": "mean"},
              "rows": rows}
        if cfg["paper2"]:
            check_paper2(aou, axis_id, rows, p2s if axis_id == "sex" else {k[1]: v for k, v in p2g.items() if k[0] == csv_axis})
        axes.append(ax)

    # Women to men within health systems (Paper 2, eTable): a note under the sex axis.
    sa_file2, sadj = find_with("_sex_adjusted.csv", P2_SEXADJ, aou)
    sexnote = None
    if sadj is not None:
        r = sadj[sadj.condition == aou].iloc[0]
        ratio, lo, hi = num(r.mh_ratio_within_site), num(r.mh_ci_low), num(r.mh_ci_high)
        if ratio is not None:
            same = lo <= 1 <= hi
            sexnote = {"v": r4(ratio), "lo": r4(lo), "hi": r4(hi), "unit": "ratio",
                       "text": (f"Within the same health systems, women and men who report {noun} are coded about "
                                f"equally often (women to men {fmt(ratio)}, 95% CI {fmt(lo)} to {fmt(hi)})." if same else
                                f"Within the same health systems, women who report {noun} are coded {fmt(ratio)} "
                                f"times as often as men (95% CI {fmt(lo)} to {fmt(hi)})."),
                       "src": {"file": sa_file2, "where": {"condition": aou}, "fields": {"v": "mh_ratio_within_site",
                               "lo": "mh_ci_low", "hi": "mh_ci_high"}}}
            for a in axes:
                if a["id"] == "sex":
                    a["note"] = sexnote
            sources.append(sa_file2)

    # Headline: Paper 2's primary population (Table 2, "All"); for a condition released without that table
    # (lupus, Task 54), the women and men of the by-sex table together, all lengths of record.
    head_pop, head_text = pop_deep, "get care for it"
    if h is not None:
        r = h[h.condition == aou].iloc[0]
        k, n = count(r.n_coded_primary), count(r.n_current)
        head_src = {"file": h_file, "where": {"condition": aou}, "num": "n_coded_primary", "den": "n_current",
                    "ci": "wilson"}
    elif st is not None:
        r = st[(st.condition == aou) & (st.state == "US")].iloc[0]
        k, n = count(r.n_coded), count(r.n_self_report_current)
        head_src = {"file": st_file, "where": {"condition": aou, "state": "US"}, "num": "n_coded",
                    "den": "n_self_report_current", "ci": "wilson"}
    else:
        # current-care cells can be hidden for one sex; the ever-reported cells are then the shown ones
        rows = s[(s.condition == aou) & s.sex.isin(["Female", "Male"])]
        for num_col, den_col, text in (("n_both_current", "n_self_report_current", "get care for it"),
                                       ("n_both", "n_self_report", "")):
            ks, ns = [count(v) for v in rows[num_col]], [count(v) for v in rows[den_col]]
            if None not in ks and None not in ns:
                break
        else:
            return None
        k, n = sum(ks), sum(ns)
        head_text = text
        head_pop = f"{slug}: {'current ' if text else ''}self-reporters, women and men, all lengths of record"
        head_src = {"file": s_file, "where": {"condition": aou, "sex": ["Female", "Male"]}, "num": num_col,
                    "den": den_col, "op": "sum", "ci": "wilson"}
    hp, hlo, hhi = wilson(k, n)
    audit.total(head_pop, k, n, table=head_src["file"])
    if cfg["paper2"]:
        p = p2g.get(("ehr_depth", "5 years or more"))
        if p and abs(r4(hp) - num(p["p"])) > 6e-5:
            raise SystemExit(f"{aou}: headline {hp} vs Paper 2 {p['p']}")

    shown = [(a["title"], row) for a in axes for row in a["rows"] if row.get("v") is not None]
    if not shown:
        raise SystemExit(f"{slug}: every group is hidden; nothing to show by group")
    lo_row = min(shown, key=lambda t: t[1]["v"])
    hi_row = max(shown, key=lambda t: t[1]["v"])
    lab = lambda t: {"Age group": f"ages {t[1]['label']}", "Sex": t[1]["label"].lower()}.get(t[0], t[1]["label"])
    who_takeaway = (f"By group, the share of {who} who report {noun} and have a code runs from {pct(lo_row[1]['v'])} "
                    f"({lab(lo_row)}) to {pct(hi_row[1]['v'])} ({lab(hi_row)}).")
    with_ref = [row for _, row in shown if row.get("ref") is not None]
    if with_ref and all(row["hi"] < row["ref"] for row in with_ref):
        who_takeaway += (f" In every group shown, that is below {ref_name} in the same group (the "
                         "vertical marks).")
    about = ""
    if hp < 0.3 and abs(1 / hp - round(1 / hp)) < 0.25:
        about = f", about 1 in {round(1 / hp)}"
    summary = [{"id": "share", "display": pct(hp), "value": r4(hp), "link": "who", "population": head_pop,
                "text": f"of {who} who report {noun}{' and ' + head_text if head_text else ''} have a code for it in their record "
                        f"(95% CI {pct(hlo)} to {pct(hhi)}){about}.",
                "src": head_src}]
    if sexnote:
        summary.append({"id": "sex", "display": fmt(sexnote["v"]), "value": sexnote["v"], "link": "who",
                        "text": sexnote["text"], "src": sexnote["src"]})

    layers = [x for x in [state_layer(slug, aou, noun, st_file, st, audit, pop_deep, who) if st is not None else None] if x]
    if slug == "lyme":
        layers.insert(0, cdc_layer())
        sources.append(LYME_CDC)
    related = related_2x2(slug, cfg) if cfg["related"] else lyme_related()
    if related:
        sources.append(related["src"]["file"])
        top = next(r for r in related["rows"] if r["id"] == related["key_row"])
        summary.append({"id": "related", "display": f"{fmt(top['ratio'], 1)}×", "value": top["ratio"],
                        "link": "related", "text": related["key_text"], "src": related["src"]})
        del related["key_text"], related["key_row"]
    wearables = wearable_profiles(slug, cfg)
    if wearables:
        sources.append(WEAR)

    return {
        "schema": SCHEMA, "slug": slug, "label": cfg["label"], "name": cfg["name"], "order": ORDER.index(slug),
        "family": FAMILY_OF[slug],
        "definition": cfg["definition"] + " Self-reporters told the All of Us survey a clinician diagnosed them "
                      "and they get visits or treatment for it.",
        "source": sorted(set(sources + [s for l in layers for s in ([l["src"]["file"]] if l.get("src") else [])])),
        "summary": summary,
        "map": {"layers": layers},
        "groups": {
            "title": f"Share of {who} who report {noun} who have a code, by group",
            "x_label": "Share with a code", "unit": "proportion", "digits": 0, "domain": [0, 1],
            "ref_label": f"{ref_name[0].upper()}{ref_name[1:]}, same group, for comparison",
            "ref_name": ref_name,
            "variants": [{"id": "current", "label": "Current self-report", "takeaway": who_takeaway,
                          "note": f"{who.capitalize()} who report the diagnosis and current care, all lengths of record.",
                          "axes": axes}],
            "source": cite(P2, f"{AOU}.") if cfg["paper2"] else
                      {"text": f"{AOU}; the same survey items and coding definitions as the companion "
                               "preprints."},
        },
        "related": related,
        "wearables": wearables,
        "trajectory": None,
        "calculator": None,
    }


def wearable_profiles(slug, cfg):
    """Fitbit means with 95% CIs by group, one block per measure (Task 48, Part B), or None when the condition has
    no rows. Only means and intervals are written, never the group sizes. A row released as <=20 or <=20 jointly,
    or whose count is not a number over 20, stays hidden; a mean's interval does not reveal its count because the
    spread behind it is not shown."""
    if not os.path.exists(path(WEAR)):
        return None
    d = read(WEAR)
    d = d[d.condition == cfg["aou"]]
    if d.empty:
        return None
    noun, women = cfg["noun"], cfg.get("women_only", False)
    who = "women" if women else "people"
    mix = "age mix" if women else "age and sex mix"
    groups = [{"id": "report", "title": f"{who.capitalize()} who report {noun}"},
              {"id": "other", "title": f"{who.capitalize()} who do not report it"}]
    measures = []
    for measure, mid, label, x_label, phrase, unit, digits in WEAR_MEASURES:
        m = d[d.measure == measure]
        if m.empty:
            continue
        rows = []
        for gid, page_group, glabel in WEAR_GROUPS:
            x = m[m.group == gid]
            if x.empty:
                continue
            r = x.iloc[0]
            glabel = glabel or f"Same {mix} as those who report it"
            n, v = count(r["n_people"]), num(r["mean"])
            if n is not None and n > 20 and v is not None:
                rows.append({"id": gid, "label": glabel, "group": page_group, "v": v, "lo": num(r["ci_low"]),
                             "hi": num(r["ci_high"])})
            else:
                hidden = str(r["n_people"]).strip() in HIDDEN_LABELS
                rows.append({"id": gid, "label": glabel, "group": page_group, "v": None,
                             "why": "suppressed" if hidden else "none"})
        by = {r["id"]: r for r in rows}
        nc, std, later = (by.get(k, {}) for k in ("self-reporters, never coded", WEAR_GROUPS[4][0],
                                                  "self-reporters, coded later"))
        val = lambda r: f"{half_up(r['v'], digits):,}"
        takeaway = None
        if nc.get("v") is not None and std.get("v") is not None:
            same = nc["lo"] <= std["hi"] and std["lo"] <= nc["hi"]
            takeaway = (f"In the year before the survey, {who} who report {noun} but were never coded for it averaged "
                        f"{val(nc)} {phrase}, "
                        + (f"about the same as {who} who do not report it with the same {mix} ({val(std)})." if same else
                           f"against {val(std)} for {who} who do not report it with the same {mix}."))
            if later.get("v") is not None:
                takeaway += f" Those coded later averaged {val(later)}."
        elif by.get("all self-reporters", {}).get("v") is not None and std.get("v") is not None:
            # the never-coded count is hidden as a complement of a small coded-later group: describe all self-reporters
            allr = by["all self-reporters"]
            same = allr["lo"] <= std["hi"] and std["lo"] <= allr["hi"]
            takeaway = (f"In the year before the survey, {who} who report {noun} averaged {val(allr)} {phrase}, "
                        + (f"about the same as {who} who do not report it with the same {mix} ({val(std)})." if same else
                           f"against {val(std)} for {who} who do not report it with the same {mix}."))
        measures.append({
            "id": mid, "label": label, "title": f"{label} in the year before the survey, by group",
            "x_label": x_label, "phrase": phrase, "unit": unit, "digits": digits, "takeaway": takeaway,
            "src": {"file": WEAR, "where": {"condition": cfg["aou"], "measure": measure}, "key": "group",
                    "fields": {"v": "mean", "lo": "ci_low", "hi": "ci_high"}},
            "rows": rows,
        })
    if not measures:
        return None
    return {
        "groups": groups,
        "note": f"{'Women survey' if women else 'Survey'} respondents with no {noun} code by the survey date and Fitbit "
                "activity on 30 or more days in the year before it (minutes asleep: 7 or more nights); each person's "
                f"daily mean over that year. Coded later: {article(noun)} {noun} code after the survey.",
        "measures": measures,
        "population": f"{slug}: model cohort with Fitbit data",
        "source": {"text": WEAR_SOURCE},
    }


def lc_trajectory():
    """Long COVID: weekly Fitbit means with 95% CIs from 26 weeks before to 26 weeks after the COVID-19 diagnosis,
    for everyone and by group (Task 48, Part A), or None without the released file. A measure-week whose count was
    released as <=20, hidden, or <=20 jointly, or is not a number over 20, is null: the page leaves a gap there and
    never interpolates. Only means and intervals are written, never the counts."""
    if not os.path.exists(path(TRAJ)):
        return None
    d = read(TRAJ)
    groups = [gid for _, _, gs in TRAJ_COMPARISONS for gid, _ in gs]
    missing = set(groups) - set(d.group)
    if missing:
        raise SystemExit(f"{TRAJ}: no rows for {sorted(missing)}")
    measures = []
    for col, label, y_label, phrase, unit, digits in TRAJ_MEASURES:
        series = {}
        for gid in groups:
            v, lo, hi = [], [], []
            for w in TRAJ_WEEKS:
                x = d[(d.week == f"week {'+' if w >= 0 else '-'}{abs(w)}") & (d.group == gid)]
                if len(x) > 1:
                    raise SystemExit(f"{TRAJ}: {len(x)} rows for {gid} week {w}")
                r = None if x.empty else x.iloc[0]
                n = None if r is None else count(r[f"n_{col}"])
                mean = None if r is None else num(r[f"{col}_mean"])
                if n is None or n <= 20 or mean is None:
                    v.append(None), lo.append(None), hi.append(None)
                    continue
                a, b = num(r[f"{col}_ci_low"]), num(r[f"{col}_ci_high"])
                if a is None or b is None:
                    raise SystemExit(f"{TRAJ} {gid} week {w} {col}: mean without its interval")
                v.append(mean), lo.append(a), hi.append(b)
            series[gid] = {"v": v, "lo": lo, "hi": hi}
        measures.append({
            "id": col, "label": label, "title": f"{label} by week around COVID-19", "y_label": y_label,
            "phrase": phrase, "unit": unit, "digits": digits,
            "src": {"file": TRAJ, "key": {"week": "week", "group": "group"},
                    "fields": {"v": f"{col}_mean", "lo": f"{col}_ci_low", "hi": f"{col}_ci_high"}},
            "series": series,
        })
    # The takeaway (the Research page's): the weeks before COVID-19 where both chart-score groups are shown.
    steps = next(m for m in measures if m["id"] == "steps")["series"]
    hi_v, typ_v = steps["band_high_or_elevated"]["v"], steps["band_typical"]["v"]
    both = [i for i, w in enumerate(TRAJ_WEEKS) if w < 0 and hi_v[i] is not None and typ_v[i] is not None]
    if not both:
        raise SystemExit(f"{TRAJ}: the takeaway needs weeks before COVID-19 with both chart-score groups shown")
    diff = sum(typ_v[i] for i in both) / len(both) - sum(hi_v[i] for i in both) / len(both)
    if diff <= 0:
        raise SystemExit(f"{TRAJ}: the takeaway says fewer steps, but the difference is {diff}")
    return {
        "takeaway": f"In the months before COVID-19, people whose chart score at day 90 was High or Elevated took "
                    f"about {int(round(diff / 100.0) * 100):,} fewer steps a day than people scored Typical.",
        "takeaway_src": {"derivation": "mean over the weeks where both are shown of band_typical steps_mean minus the "
                                       "same mean of band_high_or_elevated steps_mean, rounded to 100",
                         "weeks": [TRAJ_WEEKS[i] for i in both]},
        "note": "Adults with COVID-19 in the Long COVID study cohort who wore a Fitbit on 30 or more days in the year "
                "before and 30 or more days in the 6 months after. Week 0 starts on the day of the COVID-19 "
                "diagnosis. The chart score is the Long COVID model's band at day 90.",
        "weeks": TRAJ_WEEKS,
        "comparisons": [{"id": c, "label": lab, "groups": [{"id": g, "label": gl} for g, gl in gs]}
                        for c, lab, gs in TRAJ_COMPARISONS],
        "measures": measures,
        "population": "longcovid: COVID-19 cohort with Fitbit data",
        "source": {"text": WEAR_SOURCE},
    }


def state_layer(slug, aou, noun, file, d, audit, pop, who="people"):
    names = state_names()
    rows = d[d.condition == aou]
    states, twins, shown = {}, [], []
    national = None
    for r in rows.to_dict("records"):
        st = r["state"]
        v = num(r["share_coded"])
        if st == "US":
            if v is not None:
                national = {"label": "All participants", "v": r4(v), "lo": r4(num(r["share_ci_low"])),
                            "hi": r4(num(r["share_ci_high"]))}
            continue
        if len(st) != 2:
            continue
        if v is not None:
            cell = {"v": r4(v), "lo": r4(num(r["share_ci_low"])), "hi": r4(num(r["share_ci_high"]))}
            rel = num(r["relative_to_anchors"])
            if rel is not None:
                cell.update({"rel": r4(rel), "rlo": r4(num(r["relative_ci_low"])), "rhi": r4(num(r["relative_ci_high"]))})
            shown.append((st, v))
        else:
            hidden = any(str(r[c]).strip() in HIDDEN_LABELS for c in ("n_self_report_current", "n_coded", "share_coded"))
            cell = {"v": None, "why": "suppressed" if hidden else "none"}
        states[st] = cell
        twins.append({"num": count(r["n_coded"]), "den": count(r["n_self_report_current"]), "shown": v is not None,
                      "json": cell})
    audit.axis(pop, "states", False, twins, table=file)   # incomplete: participants without a recorded state are not listed
    if national:
        us = rows[rows.state == "US"].iloc[0]
        audit.total(pop, count(us.n_coded), count(us.n_self_report_current), table=file)
    if not shown:
        return None    # no state has enough participants: the map shows other layers only

    def no_codes(st):
        """A state where nobody who reports hypertension or type 2 diabetes has a code for it either."""
        a = d[(d.state == st) & d.condition.isin(ANCHORS)]
        return (len(a) == len(ANCHORS) and all(count(x) == 0 for x in a.n_coded)
                and all((count(x) or 0) > 0 for x in a.n_self_report_current))

    # A state at 0% whose anchors are also never coded says more about its records than about this condition:
    # it stays on the map (in the lowest bin), and the takeaway and the bins follow the other states.
    blank = [st for st, v in shown if v == 0 and no_codes(st)]
    ranged = [t for t in shown if t[0] not in blank] or shown
    lo_st = min(ranged, key=lambda t: t[1])
    hi_st = max(ranged, key=lambda t: t[1])
    takeaway = (f"In the {len(ranged)} states with enough participants, {pct(lo_st[1])} ({names[lo_st[0]]}) to "
                f"{pct(hi_st[1])} ({names[hi_st[0]]}) of {who} who report {noun} have a code for it"
                + (f", against {pct(national['v'])} for all participants who report it." if national else "."))
    if blank and len(ranged) < len(shown):
        listed = " and ".join(names[st] for st in blank)
        takeaway += (f" {listed} also {'has' if len(blank) == 1 else 'have'} enough participants but no {noun}, "
                     "hypertension, or type 2 diabetes codes.")
    if len(shown) == 1:
        takeaway = f"{names[shown[0][0]]} is the one state with enough participants: {pct(shown[0][1])} have a code."
    return {
        "id": "aou_share", "label": "Share coded (All of Us)",
        "title": f"Share of {who} who report {noun} who have a code, by state",
        "takeaway": takeaway, "unit": "proportion", "digits": 0, "bins": nice_bins([v for _, v in ranged], "proportion"),
        "national": national, "states": states,
        "missing": {"suppressed": "Not shown for privacy", "none": "Too few participants"},
        "table_rel_label": "Relative to hypertension and type 2 diabetes in the same state",
        "population": pop, "complete": False,
        "src": {"file": file, "where": {"condition": aou}, "key": "state", "num": "n_coded",
                "den": "n_self_report_current", "ci": "wilson",
                "fields": {"v": "share_coded", "lo": "share_ci_low", "hi": "share_ci_high",
                           "rel": "relative_to_anchors", "rlo": "relative_ci_low", "rhi": "relative_ci_high"}},
        "source": {"text": f"{AOU}, by state of residence as recorded by the program; same population as",
                   "authors": AUTHORS, "title": P2, "after": "(5 or more years of records)."},
    }


def cdc_layer():
    d = read(LYME_CDC)
    states, counties = {}, []
    for stc, x in d.groupby("state"):
        inc = num(x.state_incidence_per_100k.iloc[0])
        states[stc] = {"v": inc, "band": x.state_band.iloc[0],
                       "cases": round(sum(num(c) for c in x.avg_annual_cases_2015_2019), 1),
                       "population": int(sum(count(c) for c in x.population_2015_2019))}
    for r in d.to_dict("records"):
        counties.append([r["fips"], r["state"], r["county_name"], count(r["population_2015_2019"]),
                         num(r["avg_annual_cases_2015_2019"]), num(r["incidence_per_100k"]), r["band"],
                         1 if r["county_estimate_source"] == "CDC county row" else 0])
    names = state_names()
    high = [s for s, v in states.items() if v["band"] == "high"]
    top = sorted(states.items(), key=lambda t: -t[1]["v"])[:2]
    n_states = len([s for s in high if s != "DC"])
    takeaway = (f"{n_states} states{' and the District of Columbia' if 'DC' in high else ''} average 10 or more "
                f"reported cases per 100,000 residents a year, CDC's threshold for high incidence, led by "
                f"{names[top[0][0]]} ({half_up(top[0][1]['v'])}) and {names[top[1][0]]} ({half_up(top[1][1]['v'])}).")
    return {
        "id": "cdc_incidence", "label": "Reported cases (CDC)",
        "title": "Average yearly Lyme disease cases per 100,000 residents, 2015 to 2019",
        "takeaway": takeaway, "unit": "per100k", "digits": 1,
        "bins": [{"max": m, "label": l} for m, l in CDC_BINS],
        "national": None, "states": states, "missing": {"none": "No data"},
        "population": "CDC surveillance", "complete": False,
        "src": {"file": LYME_CDC, "key": "state", "fields": {"v": "state_incidence_per_100k", "band": "state_band"}},
        "source": {"text": "CDC National Notifiable Diseases Surveillance System (confirmed and probable cases) and "
                           "US Census Bureau population estimates, average of 2015 to 2019."},
        "counties": {
            "fields": ["fips", "state", "county", "population", "avg_annual_cases", "incidence_per_100k", "band",
                       "cdc_county_row"],
            "note": "State spread: CDC withheld the county count, and the state's withheld cases were spread per "
                    "capita over its counties without a published row.",
            "rows": counties,
        },
    }


def feature_labels(rel):
    if not os.path.exists(path(rel)):
        return {}
    d = json.load(open(path(rel)))
    out = {}
    for sec in d.values():
        if isinstance(sec, list):
            for f in sec:
                if isinstance(f, dict) and "id" in f and "label" in f:
                    out[f["id"]] = f["label"]
    return out


def ratio_row(fid, label, a, n1, b, n0, group="all"):
    w, wlo, whi = wilson(a, n1)
    o, olo, ohi = wilson(b, n0)
    r, lo, hi = katz(a, n1, b, n0)
    return {"id": fid, "label": label, "group": group, "with": r4(w), "with_lo": r4(wlo), "with_hi": r4(whi),
            "without": r4(o), "without_lo": r4(olo), "without_hi": r4(ohi), "ratio": r4(r), "lo": r4(lo),
            "hi": r4(hi)}


def two_by_two(file, prefixes, labels, groups_of=None):
    d = read(file)
    d = d[d.eligible == "True"]
    rows = []
    for r in d.to_dict("records"):
        if not r["feature"].startswith(prefixes) or r["feature"] not in labels:
            continue
        a, b, c, e = (count(r[k]) for k in ("n_x1_s1", "n_x1_s0", "n_x0_s1", "n_x0_s0"))
        if None in (a, b, c, e) or min(a, b, c, e) <= 20:
            continue    # an ineligible or suppressed row is never shown
        rows.append(ratio_row(r["feature"], labels[r["feature"]], a, a + c, b, b + e,
                              groups_of(r["feature"]) if groups_of else "all"))
    return rows


def strongest(rows):
    """The row whose ratio is surely largest: the highest lower confidence limit (rare codes with wide intervals
    do not lead the key number)."""
    return max((r for r in rows if r.get("ratio") is not None), key=lambda r: r["lo"])


def sort_related(rows, groups):
    order = {g["id"]: i for i, g in enumerate(groups)}
    return sorted(rows, key=lambda r: (order[r["group"]], r["ratio"] is None, -(r["ratio"] or 0), r["label"]))


def related_2x2(slug, cfg):
    rc = cfg["related"]
    files = sorted(glob.glob(path(rc["file"])))
    if not files:
        return None
    file = os.path.relpath(files[0], ROOT)
    labels = feature_labels(rc["labels"])
    if not labels:
        d = read(file)
        labels = {f: f[len(rc["prefix"]):].replace("_", " ").capitalize() for f in d.feature if f.startswith(rc["prefix"])}
    noun = cfg["noun"]
    women = cfg.get("women_only", False)
    who = "women" if women else "people"
    others = "other women in the survey" if women else "other survey respondents"
    groups = [{"id": "all", "title": None}]
    rows = sort_related(two_by_two(file, (rc["prefix"],), labels), groups)
    if not rows:
        return None
    top = strongest(rows)
    in_p3 = not re.search(r"(^|/)t5[45]_", file)   # Tasks 54 and 55 trained the app's models, not Paper 3's
    return {
        "title": f"What else is coded in {who} who report {noun}",
        "takeaway": f"In the 5 years before the survey, {lower_first(top['label'])} "
                    f"was coded {fmt(top['ratio'], 1)} times as often in {who} who report {noun} as in {others} "
                    f"({pct(top['with'], 1)} against {pct(top['without'], 1)}).",
        "key_text": f"{top['label']} codes are {fmt(top['ratio'], 1)} times as common in {who} who report {noun} as "
                    f"in {others}.", "key_row": top["id"],
        "with_label": f"{who.capitalize()} who report {noun}", "without_label": f"{others[0].upper()}{others[1:]}",
        "x_label": "Times as common", "digits": 1,
        "note": f"{'Women survey' if women else 'Survey'} respondents with no {noun} code by the survey date; codes "
                "recorded in the 5 years before the survey.",
        "groups": groups, "rows": rows, "population": f"{slug}: model training split",
        "src": {"file": file, "key": "feature", "cells": {"a": "n_x1_s1", "b": "n_x1_s0", "c": "n_x0_s1",
                                                          "d": "n_x0_s0"}, "ci": "wilson"},
        "source": ({"text": f"{AOU}: feature-by-label counts released for the case-finding models in",
                    "authors": AUTHORS, "title": P3, "after": "(training split, counts rounded up to 10)."}
                   if in_p3 else
                   {"text": f"{AOU}: feature-by-label counts released for the app's {noun} case-finding model "
                            "(training split, counts rounded up to 10)."}),
    }


def lyme_related():
    d = read(LYME_PRE)
    rows = []
    for r in d.to_dict("records"):
        m = re.match(r"any (\w+) code, days -365 to -1", r["measure"])
        if m:
            label = LYME_LABELS[m.group(1)]
        elif r["measure"].startswith("Lyme serology ordered"):
            label = "Lyme blood test ordered"
        else:
            continue    # the composite "missed opportunity" proxy is not a condition
        a, n1, b, n0 = (count(r[k]) for k in ("cases_with", "n_cases", "controls_with", "n_controls"))
        if b is None:
            w, wlo, whi = wilson(a, n1)
            rows.append({"id": r["measure"], "label": label, "group": "all", "with": r4(w), "with_lo": r4(wlo),
                         "with_hi": r4(whi), "without": None, "ratio": None, "why": "suppressed"})
            continue
        rows.append({**ratio_row(r["measure"], label, a, n1, b, n0), "id": r["measure"]})
    groups = [{"id": "all", "title": None}]
    rows = sort_related(rows, groups)
    sym = [r for r in rows if r["ratio"] is not None and r["label"] != "Lyme blood test ordered"]
    top = strongest(sym)
    return {
        "title": "What is coded in the year before a first Lyme disease code",
        "takeaway": f"In the year before a first Lyme disease code, {lower_first(top['label'])} codes were "
                    f"{fmt(top['ratio'], 1)} times as common as in matched people without Lyme disease "
                    f"({pct(top['with'], 1)} against {pct(top['without'], 1)}).",
        "key_text": f"{top['label']} codes are {fmt(top['ratio'], 1)} times as common in the year before a first Lyme "
                    "disease code as in matched people without Lyme disease.", "key_row": top["id"],
        "with_label": "People with a first Lyme disease code", "without_label": "Matched people without one",
        "x_label": "Times as common", "digits": 1, "note": "Days 365 to 1 before the first code; up to 4 people of the same age "
                                               "band and sex per person with Lyme disease.",
        "groups": groups, "rows": [strip_nulls(r) for r in rows], "population": "lyme: cases and matched controls",
        "src": {"file": LYME_PRE, "key": "measure", "with": ["cases_with", "n_cases"],
                "without": ["controls_with", "n_controls"], "ci": "wilson"},
        "source": {"text": f"{AOU}: adults with a first Lyme disease code (A69.2) and up to 4 people of the same age "
                           "band and sex with no Lyme code."},
    }


# ---------- Long COVID (Paper 1) ----------

def hps_layer(indicator, label, title):
    d = read(HPS_STATES)
    d = d[d.indicator == indicator]
    states, vals = {}, []
    names = state_names()
    nat = d[d.state == "US"].iloc[0]
    for r in d[d.state != "US"].to_dict("records"):
        v = num(r["pct"])
        if v is None:
            states[r["state"]] = {"v": None, "why": "none"}
        else:
            states[r["state"]] = {"v": v, "lo": num(r["low_ci"]), "hi": num(r["high_ci"])}
            vals.append((r["state"], v))
    period = nat.period
    m = re.match(r"(\w+) (\d+) - (\w+) (\d+), (\d{4})", period)
    months = {"Jan": "January", "Feb": "February", "Mar": "March", "Apr": "April", "May": "May", "Jun": "June",
              "Jul": "July", "Aug": "August", "Sep": "September", "Oct": "October", "Nov": "November", "Dec": "December"}
    period_text = f"{months[m.group(1)]} {m.group(2)} to {months[m.group(3)]} {m.group(4)}, {m.group(5)}"
    lo_st = min(vals, key=lambda t: t[1])
    hi_st = max(vals, key=lambda t: t[1])
    what = "currently had" if indicator.startswith("current") else "had ever had"
    return {
        "id": f"hps_{indicator.split('_')[0]}", "label": label, "title": title,
        "takeaway": f"In the last CDC survey period ({period_text}), {fmt(num(nat.pct), 1)}% of US adults said they "
                    f"{what} Long COVID; state estimates ranged from {fmt(lo_st[1], 1)}% ({names[lo_st[0]]}) to "
                    f"{fmt(hi_st[1], 1)}% ({names[hi_st[0]]}), with wide intervals in smaller states.",
        "unit": "percent", "digits": 1, "bins": nice_bins([v for _, v in vals], "percent"),
        "national": {"label": "United States", "v": num(nat.pct), "lo": num(nat.low_ci), "hi": num(nat.high_ci)},
        "states": states, "missing": {"none": "No published estimate"},
        "population": "Household Pulse Survey", "complete": False,
        "src": {"file": HPS_STATES, "where": {"indicator": indicator}, "key": "state",
                "fields": {"v": "pct", "lo": "low_ci", "hi": "high_ci"}},
        "source": {"text": f"CDC/NCHS Household Pulse Survey, Post-COVID Conditions, {period_text}: percentage of "
                           "all adults, with 95% confidence intervals."},
        "period": period_text,
    }


def lc_state_layer(audit):
    d = read(LC_STATES)
    names = state_names()
    states, twins, shown = {}, [], []
    pop = "longcovid: COVID-19 cohort"
    for r in d.to_dict("records"):
        st, v = r["state"], num(r["share_coded"])
        if st == "US":
            us = r
            continue
        if v is not None:
            cell = {"v": r4(v), "lo": r4(num(r["share_ci_low"])), "hi": r4(num(r["share_ci_high"]))}
            shown.append((st, v))
        else:
            cell = {"v": None, "why": "suppressed"}
        states[st] = cell
        twins.append({"num": count(r["n_coded_u099"]), "den": count(r["n_cohort"]), "shown": v is not None, "json": cell})
    audit.axis(pop, "states", False, twins, table=LC_STATES)
    audit.total(pop, count(us["n_coded_u099"]), count(us["n_cohort"]), table=LC_STATES)
    nat = {"label": "All of the cohort", "v": r4(num(us["share_coded"])), "lo": r4(num(us["share_ci_low"])),
           "hi": r4(num(us["share_ci_high"]))}
    pos = [t for t in shown if t[1] > 0]
    lo_st = min(pos, key=lambda t: t[1])
    hi_st = max(pos, key=lambda t: t[1])
    return {
        "id": "aou_coded", "label": "Coded share (All of Us)",
        "title": "Share of adults with COVID-19 who have a Long COVID code within 455 days, by state",
        "takeaway": f"In the All of Us COVID-19 cohort, {pct(nat['v'], 1)} have a Long COVID code within 455 days. "
                    f"In the {len(shown)} states with enough participants, the share runs from {pct(lo_st[1], 1)} "
                    f"({names[lo_st[0]]}) to {pct(hi_st[1], 1)} ({names[hi_st[0]]}).",
        "unit": "proportion", "digits": 1, "bins": nice_bins([v for _, v in shown], "proportion"),
        "national": nat, "states": states,
        "missing": {"suppressed": "Not shown for privacy", "none": "Too few participants"},
        "population": pop, "complete": False,
        "src": {"file": LC_STATES, "key": "state", "num": "n_coded_u099", "den": "n_cohort", "ci": "wilson",
                "fields": {"v": "share_coded", "lo": "share_ci_low", "hi": "share_ci_high"}},
        "source": {"text": f"{AOU}, by state of residence as recorded by the program; COVID-19 cohort of",
                   "authors": AUTHORS, "title": P1, "after": "(U09.9 in days 1 to 455 after COVID-19)."},
    }


def build_longcovid(audit):
    gap = read(LC_GAP)
    variants = []
    labels = {"sex": dict(SEX), "age_band": dict(AGE), "race_eth": dict(RACE)}
    for definition, vlabel in (("ever", "Ever had Long COVID"), ("current", "Currently has Long COVID")):
        axes = []
        for axis, title, groups in (("sex", "Sex", SEX), ("age_band", "Age group", AGE), ("race_eth", "Race and ethnicity", RACE)):
            rows = []
            x = gap[gap.axis == axis]
            for gid, glabel in groups:
                y = x[(x.category == gid) & (x.definition.isin([definition, "both"]))]
                if y.empty:
                    continue
                r = y.iloc[0]
                if num(r.c) is None:   # released for both definitions in one row
                    rows.append({"id": gid, "label": glabel, "v": None, "why": "suppressed",
                                 "where": {"definition": r.definition}})
                    continue
                ref = r.reference
                row = {"id": gid, "label": glabel, "v": r4(num(r.c)), "lo": r4(num(r.c_lo)), "hi": r4(num(r.c_hi)),
                       "coded": r4(num(r.p_coded_455)), "pi": r4(num(r.pi)), "per": num(r.uncoded_per_coded)}
                if gid != ref:
                    row.update({"ratio": r4(num(r.ratio_vs_ref)), "ratio_lo": r4(num(r.ratio_lo)),
                                "ratio_hi": r4(num(r.ratio_hi)), "ratio_ref": labels[axis][ref]})
                rows.append(row)
            axes.append({"id": {"age_band": "age", "race_eth": "race"}.get(axis, axis), "title": title,
                         "population": "longcovid: COVID-19 cohort", "complete": axis == "age_band",
                         "src": {"file": LC_GAP, "where": {"axis": axis, "definition": definition}, "key": "category",
                                 "fields": {"v": "c", "lo": "c_lo", "hi": "c_hi", "coded": "p_coded_455", "pi": "pi",
                                            "per": "uncoded_per_coded", "ratio": "ratio_vs_ref",
                                            "ratio_lo": "ratio_lo", "ratio_hi": "ratio_hi"},
                                 "ci": "survey"},
                         "rows": rows})
        f = next(r for r in axes[0]["rows"] if r["id"] == "Female")
        m = next(r for r in axes[0]["rows"] if r["id"] == "Male")
        variants.append({
            "id": definition, "label": vlabel,
            "takeaway": f"Women report Long COVID more often than men but carry its code at a similar rate, so a smaller "
                        f"share of women's Long COVID is coded: {pct(f['v'], 1)} against {pct(m['v'], 1)} for men "
                        f"(ratio {fmt(f['ratio'])}, 95% interval {fmt(f['ratio_lo'])} to {fmt(f['ratio_hi'])}).",
            "note": f"Coding fraction: the share with a U09.9 code divided by the share who say in the CDC survey that "
                    f"they {'have ever had' if definition == 'ever' else 'currently have'} Long COVID, among adults "
                    "who had COVID-19.",
            "axes": axes})

    # Key numbers. "1 in 9" (Paper 1): the cohort's coded share over national survey prevalence among adults who
    # had COVID-19, ever and current.
    lc = read(LC_STATES)
    us = lc[lc.state == "US"].iloc[0]
    coded = count(us.n_coded_u099) / count(us.n_cohort)
    hp = read(HPS_GROUPS)
    nat = hp[hp.group == "National Estimate"].set_index("indicator").mean_pct
    ever, current = coded / (num(nat["ever_among_infected"]) / 100), coded / (num(nat["current_among_infected"]) / 100)
    f_ever = next(r for r in variants[0]["axes"][0]["rows"] if r["id"] == "Female")
    hps_cur = hps_layer("current_all_adults", "Currently has (CDC survey)", "Adults who currently have Long COVID, percent, by state")
    hps_ever = hps_layer("ever_all_adults", "Ever had (CDC survey)", "Adults who have ever had Long COVID, percent, by state")
    summary = [
        {"id": "fraction", "display": f"1 in {round(1 / ever)}", "value": r4(ever), "link": "who",
         "text": f"adults who have ever had Long COVID carry its code, U09.9, in their health record (1 in "
                 f"{round(1 / current)} of those who have it now).",
         "src": {"file": [LC_STATES, HPS_GROUPS], "derivation": "coded share of the COVID-19 cohort (US row, "
                 "n_coded_u099 / n_cohort) divided by Household Pulse Survey prevalence among adults who had COVID-19 "
                 "(National Estimate, ever_among_infected and current_among_infected)"}},
        {"id": "women", "display": fmt(f_ever["ratio"]), "value": f_ever["ratio"], "link": "who",
         "text": f"Women's Long COVID is coded {fmt(f_ever['ratio'])} times as often as men's, relative to how many "
                 f"report it (95% interval {fmt(f_ever['ratio_lo'])} to {fmt(f_ever['ratio_hi'])}).",
         "src": {"file": LC_GAP, "where": {"axis": "sex", "category": "Female", "definition": "ever"},
                 "fields": {"value": "ratio_vs_ref"}}},
        {"id": "prevalence", "display": f"{fmt(hps_cur['national']['v'], 1)}%", "value": hps_cur["national"]["v"],
         "link": "where",
         "text": f"of US adults said they currently had Long COVID in the last CDC survey period ({hps_cur['period']}).",
         "src": {"file": HPS_STATES, "where": {"indicator": "current_all_adults", "state": "US"}, "fields": {"value": "pct"}}},
    ]
    for layer in (hps_cur, hps_ever):
        del layer["period"]

    # Related: the summary-count model's 2x2 tables (later coded vs not), training split.
    groups = [{"id": "after", "title": "Coded in the 90 days after COVID-19"},
              {"id": "before", "title": "Recorded in the year before COVID-19"}]
    rows = sort_related(two_by_two(LC_2X2, ("hx_", "sym_any_"), LC_LABELS,
                                   lambda f: "before" if f.startswith("hx_") else "after"), groups)
    top_after = strongest([r for r in rows if r["group"] == "after" and "symptom types" not in r["label"]])
    top_before = strongest([r for r in rows if r["group"] == "before"])
    related = {
        "title": "What else is coded in people later coded with Long COVID",
        "takeaway": f"People later coded with Long COVID more often had symptom codes soon after COVID-19, such as "
                    f"{lower_first(top_after['label'])} ({fmt(top_after['ratio'], 1)} times as common), and prior "
                    f"conditions such as {lower_first(top_before['label'])} "
                    f"({fmt(top_before['ratio'], 1)} times).",
        "with_label": "Later coded with Long COVID", "without_label": "Not coded",
        "x_label": "Times as common", "digits": 1, "note": "Adults with COVID-19 and no Long COVID code by day 90; a later code "
                                               "means U09.9 in days 91 to 455.",
        "groups": groups, "rows": rows, "population": "longcovid: model training split",
        "src": {"file": LC_2X2, "key": "feature", "cells": {"a": "n_x1_s1", "b": "n_x1_s0", "c": "n_x0_s1",
                                                            "d": "n_x0_s0"}, "ci": "wilson"},
        "source": cite(P1, f"{AOU}: feature-by-label counts released for the exported model (training split, counts "
                           "rounded up to 10)."),
    }

    # Calculator inputs (measured values; the defaults themselves are in web/web/atlas/calc.js).
    cost = read(LC_COST)
    cats = cost[~cost.category.str.startswith("TOTAL")]
    total = num(cost[cost.category.str.startswith("TOTAL")].mean_cost.iloc[0])
    perf = read(LC_PERF)
    p = perf[(perf.axis == "overall") & (perf.category == "all")].iloc[0]
    lt = read(LC_LEAD).set_index("model").loc["M2_elastic_net_logistic"]
    calculator = {
        "model": "Long COVID model (elastic net, day-90 landmark)",
        "measured": {"excess_cost": total, "window_days": num(cats.median_window_days_cases.iloc[0]),
                     "recall": num(p.recall_top5_M2_elastic_net_logistic), "ppv": num(p.ppv_top5_M2_elastic_net_logistic),
                     "lead_days": num(lt.median_days_ahead), "lead_p25_days": num(lt.p25), "lead_p75_days": num(lt.p75)},
        "src": {"file": [LC_COST, LC_PERF, LC_LEAD],
                "fields": {"excess_cost": "odyssey_cost.csv TOTAL mean_cost", "window_days": "median_window_days_cases",
                           "recall": "recall_top5_M2_elastic_net_logistic (overall)",
                           "ppv": "ppv_top5_M2_elastic_net_logistic (overall)", "lead_days": "median_days_ahead",
                           "lead_p25_days": "p25", "lead_p75_days": "p75"}},
        "source": cite(P1, f"{AOU}. Spending (the paper's supplement) priced at CMS 2024 national Medicare allowed "
                           "amounts. Recall, precision, and lead time at the top 5% are from the same cohort and model, "
                           "analysis from this project (not in the paper)."),
    }

    layers = [hps_cur, hps_ever, lc_state_layer(audit)]
    trajectory = lc_trajectory()
    return {
        "schema": SCHEMA, "slug": "longcovid", "label": "Long COVID", "name": "Long COVID", "order": 0,
        "family": FAMILY_OF["longcovid"],
        "definition": "A code means ICD-10-CM U09.9 within 455 days of a COVID-19 diagnosis. How many people have "
                      "Long COVID comes from the CDC Household Pulse Survey (symptoms lasting 3 months or longer).",
        "source": sorted({LC_GAP, LC_STATES, HPS_STATES, HPS_GROUPS, LC_2X2, LC_COST, LC_PERF, LC_LEAD}
                         | ({TRAJ} if trajectory else set())),
        "summary": summary,
        "map": {"layers": layers},
        "groups": {
            "title": "Share of people with Long COVID who carry its code (coding fraction), by group",
            "x_label": "Coding fraction", "unit": "proportion", "digits": 1, "domain": None, "ref_label": None,
            "variants": variants,
            "source": cite(P1, f"{AOU}, COVID-19 cohort followed 455 days; CDC/NCHS Household Pulse Survey, June "
                               "2022 to September 2024."),
        },
        "related": related,
        "wearables": None,
        "trajectory": trajectory,
        "calculator": calculator,
    }


# ---------- legacy files (homepage alt text and the deck) ----------

LEGACY_TARGETS = ["obesity", "depression", "anxiety", "migraine", "fibromyalgia", "endometriosis", "lyme",
                  "chronic_fatigue"]
LEGACY_LABELS = {"hypertension": "Hypertension", "diabetes_type2": "Type 2 diabetes", "obesity": "Obesity",
                 "depression": "Depression", "anxiety": "Anxiety", "migraine": "Migraine",
                 "fibromyalgia": "Fibromyalgia", "endometriosis": "Endometriosis", "lyme": "Lyme disease",
                 "chronic_fatigue": "Chronic fatigue"}
LEGACY_SURVEY_LABELS = {**LEGACY_LABELS, "long_covid": "Long COVID", "mecfs_postviral": "ME/CFS",
                        "diabetes_any_type": "Diabetes (any type)", "chronic_pain": "High-impact chronic pain"}
LEGACY_RACE = [g for g, _ in RACE]


def legacy_invisible():
    """invisible.json: unchanged schema and values (read by the homepage alt text and the deck)."""
    g_src = "paper2/results/coding_estimates_groups.csv"
    d_src = "paper2/results/coding_estimates_selfreport_deep.csv"
    f_src = "paper2/results/female_predominance.csv"
    g = pd.read_csv(path(g_src), dtype={"n_self_report_current": str})
    deep = pd.read_csv(path(d_src))
    fp = pd.read_csv(path(f_src)).set_index("condition")

    def legacy_count(v):
        x = num(v)
        if x is None:
            s = "" if v is None or (isinstance(v, float) and math.isnan(v)) else str(v).strip()
            return s or None
        return int(x)

    def est(r):
        return {"n": legacy_count(r.n_self_report_current), "p_code": num(r.p_code_current),
                "ci_low": num(r.ci_low), "ci_high": num(r.ci_high), "anchor": num(r.anchor),
                "relative": num(r.relative), "rel_ci_low": num(r.rel_ci_low), "rel_ci_high": num(r.rel_ci_high)}

    overall = g[(g.axis == "ehr_depth") & (g.group == "5 years or more")].set_index("condition")
    conditions = []
    for c in LEGACY_TARGETS:
        ratio = fp.loc[c, "ratio_women_to_men"] if c in fp.index else None
        conditions.append({
            "id": c, "label": LEGACY_LABELS[c],
            "female_predominant": bool(fp.loc[c, "female_predominant"]) if c in fp.index else False,
            "women_to_men_prevalence": "defined only in women" if ratio is not None and math.isinf(float(ratio))
            else num(ratio),
            "prevalence_ratio_source": str(fp.loc[c, "source"]) if c in fp.index else None,
            "overall": est(overall.loc[c]),
        })
    conditions.sort(key=lambda x: -(x["overall"]["relative"] or 0))
    anchors = {c: est(overall.loc[c]) for c in ANCHORS}
    cur = deep[deep.self_report == "current"]
    sex_anchor = cur[cur.condition.isin(ANCHORS)].groupby("sex").p_code.mean()
    ratio_rows = cur[cur.sex == "Female/Male"].set_index("condition")
    by_sex = {}
    for c in LEGACY_TARGETS:
        rows = {}
        for sex in ["Female", "Male"]:
            r = cur[(cur.condition == c) & (cur.sex == sex)]
            if r.empty:
                continue
            r = r.iloc[0]
            p, lo, hi, a = num(r.p_code), num(r.ci_low), num(r.ci_high), float(sex_anchor[sex])
            rows[sex] = {"n": legacy_count(r.n_self_report), "p_code": p, "ci_low": lo, "ci_high": hi,
                         "anchor": round(a, 4),
                         "relative": round(p / a, 4) if p is not None else None,
                         "rel_ci_low": round(lo / a, 4) if lo is not None else None,
                         "rel_ci_high": round(hi / a, 4) if hi is not None else None}
        if c in ratio_rows.index:
            r = ratio_rows.loc[c]
            rows["women_to_men_ratio"] = {"ratio": num(r.p_code), "ci_low": num(r.ci_low), "ci_high": num(r.ci_high)}
        by_sex[c] = rows
    sex_anchors = {sex: {"anchor": round(float(sex_anchor[sex]), 4),
                         **{c: num(cur[(cur.condition == c) & (cur.sex == sex)].p_code.iloc[0]) for c in ANCHORS}}
                   for sex in ["Female", "Male"]}
    race = g[g.axis == "race_eth"]
    by_race = {c: {grp: est(race[(race.condition == c) & (race.group == grp)].iloc[0])
                   for grp in LEGACY_RACE if not race[(race.condition == c) & (race.group == grp)].empty}
               for c in LEGACY_TARGETS + ANCHORS}
    r_src, k_src = "paper2/results/coding_estimates_ratios.csv", "paper2/results/coding_estimates_kappa.csv"
    ra = pd.read_csv(path(r_src))
    ra = ra[(ra.code_definition == "any code") & (ra.standard == "US adults: age")]
    survey = [{"condition": r.condition, "label": LEGACY_SURVEY_LABELS.get(r.condition, r.condition), "sex": r.sex,
               "benchmark": r.benchmark, "benchmark_type": r.benchmark_type, "coded_share": num(r.aou_std_share),
               "national_prevalence": num(r.national_prevalence), "ratio": num(r.ratio), "ci_low": num(r.ci_low),
               "ci_high": num(r.ci_high)} for r in ra.itertuples(index=False)]
    ka = pd.read_csv(path(k_src))
    ka = ka[ka.standard == "US adults: age"]
    kappa = [{"condition": r.condition, "sex": r.sex, "benchmark": r.benchmark, "kappa": num(r.kappa)}
             for r in ka.itertuples(index=False)]
    x_src = "paper2/results/coding_estimates_sex_adjusted.csv"
    xa = pd.read_csv(path(x_src))
    sex_adjusted = [{"condition": r.condition, "crude": num(r.crude_ratio), "standardized": num(r.std_ratio),
                     "within_systems": num(r.mh_ratio_within_site), "within_low": num(r.mh_ci_low),
                     "within_high": num(r.mh_ci_high), "sites_included": r.sites_included}
                    for r in xa.itertuples(index=False)]
    return {
        "source": [g_src, d_src, f_src, r_src, k_src, x_src],
        "measure": "Share of participants reporting a current diagnosis who have any ICD-10-CM code for it, "
                   "divided by the mean share for hypertension and type 2 diabetes (the anchors) in the same group.",
        "derived": "by_sex.relative = p_code / mean(anchor p_code, same sex); interval = Wilson interval / anchor "
                   "(computed in analysis/build_atlas_data.py, same construction as paper2/coding_estimates.py).",
        "sample": {"overall": "5 or more years of EHR records before the survey",
                   "by_sex": "5 or more years of EHR records before the survey",
                   "by_race": "all lengths of record"},
        "race_groups": LEGACY_RACE,
        "conditions": conditions,
        "anchors": anchors,
        "sex_anchors": sex_anchors,
        "by_sex": by_sex,
        "by_race": by_race,
        "survey_comparison": {"standard": "age-standardized within sex to US adults (NHANES 2021-2023 weights); any code",
                              "rows": survey, "anchor_kappa": kappa},
        "sex_adjusted": {"measure": "Women-to-men ratio of the share coded among current self-reporters with 5 or more "
                                    "years of records: crude, standardized for age and record length, and within "
                                    "health systems (Mantel-Haenszel).", "rows": sex_adjusted},
    }


def legacy_long_covid():
    """long_covid.json: unchanged schema and values (read by the deck)."""
    d = read(LC_GAP)
    rows, unavailable = [], []
    for r in d.to_dict("records"):
        if r["definition"] not in ("ever", "current"):
            unavailable.append({"axis": r["axis"], "category": r["category"], "note": r["note"]})
            continue
        n = num(r["n_gap_cohort_rounded"])
        rows.append({"axis": r["axis"], "category": r["category"], "definition": r["definition"],
                     "n": int(n) if n is not None else None, "coded_share": num(r["p_coded_455"], 4),
                     "survey_prevalence": num(r["pi"]), "c": num(r["c"]), "c_low": num(r["c_lo"]),
                     "c_high": num(r["c_hi"]), "uncoded_per_coded": num(r["uncoded_per_coded"]),
                     "reference": r["reference"], "ratio": num(r["ratio_vs_ref"]), "ratio_low": num(r["ratio_lo"]),
                     "ratio_high": num(r["ratio_hi"])})
    return {
        "source": [LC_GAP, "paper/main.tex"],
        "measure": "Coding fraction: share of the COVID-19 cohort with a U09.9 code in days 1 to 455 divided by "
                   "Household Pulse Survey prevalence of Long COVID among adults who had COVID-19 (27 periods, "
                   "June 2022 to September 2024).",
        "rows": rows,
        "unavailable": unavailable,
    }


# ---------- output ----------

def dump(obj):
    return json.dumps(obj, separators=(",", ":"), ensure_ascii=False) + "\n"


def write(out, name, obj):
    full = os.path.join(out, name)
    os.makedirs(os.path.dirname(full), exist_ok=True)
    with open(full, "w") as f:
        f.write(dump(obj))
    return full


def build(out=OUT, quiet=False):
    audit = Audit()
    conditions = [build_longcovid(audit)]
    for slug in ORDER[1:]:
        c = build_selfreport(slug, SELF_REPORT[slug], audit)
        if c is not None:
            conditions.append(c)
    hid = audit.enforce()
    if hid and not quiet:
        print("complementary suppression:", hid)
    for c in conditions:
        for v in c["groups"]["variants"]:
            for a in v["axes"]:
                a["rows"] = [strip_nulls(r) for r in a["rows"]]
        for layer in c["map"]["layers"]:
            layer["states"] = {k: strip_nulls(v) for k, v in sorted(layer["states"].items())}
    written = [write(out, "invisible.json", legacy_invisible()), write(out, "long_covid.json", legacy_long_covid())]
    for c in conditions:
        written.append(write(out, f"conditions/{c['slug']}.json", c))
    listed = {c["family"] for c in conditions}
    written.append(write(out, "conditions/index.json", {
        "schema": "unom-atlas-index/1",
        "source": ["analysis/build_atlas_data.py"],
        "default": conditions[0]["slug"],
        "families": [{"id": fid, "label": label} for fid, label, _ in FAMILIES if fid in listed],
        "conditions": [{"slug": c["slug"], "label": c["label"], "family": c["family"], "file": f"{c['slug']}.json"}
                       for c in conditions],
    }))
    if not quiet:
        for f in written:
            print(f"wrote {os.path.relpath(f, ROOT) if f.startswith(ROOT) else f} ({os.path.getsize(f)} bytes)")
    return conditions


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--out", default=OUT, help="output directory (default web/web/atlas/data)")
    ap.add_argument("--quiet", action="store_true")
    a = ap.parse_args()
    build(os.path.abspath(a.out), a.quiet)
