"""Assemble model/chronicfatigue.json (the app's chronic fatigue / ME/CFS card) from Task 33 exports (Task 30 design).

The weights come from cf_model.fit_nb_eb on the exported, rounded feature-label tables, the same
function and inputs Task 30 used to evaluate the model inside the Workbench; calibration is a
grouped-binomial logistic fit on the exported training-split score bins.
Usage: python3 analysis/build_cf_model.py [--condition chronicfatigue|fibromyalgia|endometriosis|lyme|lupus|migraine|depression|anxiety] [--results DIR] [--prefix P] [--out FILE]
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys

import numpy as np
import pandas as pd

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "workbench/src"))
sys.path.insert(0, os.path.join(ROOT, "model"))
import cf_model as cf  # noqa: E402
from build_model import fit_calibration  # noqa: E402

GROUPS = {"demographics": "Demographics", "conditions": "Conditions and symptoms (past 5 years)",
          "cluster_counts": "Symptom pattern", "procedures": "Tests and evaluations", "labs": "Lab tests ordered",
          "medications": "Medications", "utilization": "Health care use"}


CONDITIONS = {
    "chronicfatigue": {
        "registry": "features_cf.json", "model_id": "unm-chronicfatigue", "results": "results/aggregate/33", "prefix": "t33",
        "out": "model/chronicfatigue.json", "name": "chronic fatigue",
        "target": {"label": "Self-reported chronic fatigue diagnosis",
                   "definition": "Participant reports having been told by a clinician that they have chronic fatigue (All of Us Personal and Family Health History survey)",
                   "population": "Adults with an EHR visit in the past year and no chronic fatigue or ME/CFS code (ICD-10-CM G93.3, R53.82)"},
        "reason": "a chronic fatigue or ME/CFS diagnosis is already recorded",
        "task": "Task 33 (Task 30 with condition codes from both the condition and observation tables)"},
    "fibromyalgia": {
        "registry": "features_fibro.json", "model_id": "unm-fibromyalgia", "results": "results/aggregate/39", "prefix": "t39_fibromyalgia",
        "out": "model/fibromyalgia.json", "name": "fibromyalgia",
        "target": {"label": "Self-reported fibromyalgia diagnosis",
                   "definition": "Participant reports having been told by a clinician that they have fibromyalgia (All of Us Personal and Family Health History survey)",
                   "population": "Adults with an EHR visit in the past year and no fibromyalgia code (ICD-10-CM M79.7)"},
        "reason": "a fibromyalgia diagnosis is already recorded",
        "task": "Task 39 (Task 33's design for fibromyalgia)"},
    "endometriosis": {
        "registry": "features_endo.json", "model_id": "unm-endometriosis", "results": "results/aggregate/39", "prefix": "t39_endometriosis",
        "out": "model/endometriosis.json", "name": "endometriosis",
        "eligibility": {"sex": "female", "reason": "the model covers women (FHIR gender female)"},
        "target": {"label": "Self-reported endometriosis diagnosis",
                   "definition": "Participant reports having been told by a clinician that they have endometriosis (All of Us Personal and Family Health History survey)",
                   "population": "Women with an EHR visit in the past year and no endometriosis code (ICD-10-CM N80)"},
        "reason": "an endometriosis diagnosis is already recorded",
        "task": "Task 39 (Task 33's design for endometriosis, women only); deployed as research: discrimination is limited and many reports describe past disease"},
    "lyme": {
        "registry": "features_lyme.json", "model_id": "unm-lyme", "results": "results/aggregate/54", "prefix": "t54_lyme",
        "out": "model/lyme.json", "name": "Lyme disease",
        "codelists_also": [("results/aggregate/39", "t39_fibromyalgia")],
        "target": {"label": "Self-reported Lyme disease diagnosis",
                   "definition": "Participant reports having been told by a clinician that they have Lyme disease (All of Us Personal and Family Health History survey)",
                   "population": "Adults with an EHR visit in the past year and no Lyme disease code (ICD-10-CM A69.2)"},
        "reason": "a Lyme disease diagnosis is already recorded",
        "task": "Task 54 (Task 39's design for Lyme disease)"},
    "migraine": {
        "registry": "features_migraine.json", "model_id": "unm-migraine", "results": "results/aggregate/55", "prefix": "t55_migraine",
        "out": "model/migraine.json", "name": "migraine",
        "codelists_also": [("results/aggregate/39", "t39_fibromyalgia")],
        "target": {"label": "Self-reported migraine diagnosis",
                   "definition": "Participant reports having been told by a clinician that they have migraine (All of Us Personal and Family Health History survey)",
                   "population": "Adults with an EHR visit in the past year and no migraine code (ICD-10-CM G43)"},
        "reason": "a migraine diagnosis is already recorded",
        "task": "Task 55 (Task 39's design for migraine)"},
    "depression": {
        "registry": "features_depression.json", "model_id": "unm-depression", "results": "results/aggregate/55", "prefix": "t55_depression",
        "out": "model/depression.json", "name": "depression",
        "codelists_also": [("results/aggregate/39", "t39_fibromyalgia")],
        "target": {"label": "Self-reported depression diagnosis",
                   "definition": "Participant reports having been told by a clinician that they have depression (All of Us Personal and Family Health History survey)",
                   "population": "Adults with an EHR visit in the past year and no depression code (ICD-10-CM F32, F33)"},
        "reason": "a depression diagnosis is already recorded",
        "task": "Task 55 (Task 39's design for depression)"},
    "anxiety": {
        "registry": "features_anxiety.json", "model_id": "unm-anxiety", "results": "results/aggregate/55", "prefix": "t55_anxiety",
        "out": "model/anxiety.json", "name": "anxiety",
        "codelists_also": [("results/aggregate/39", "t39_fibromyalgia")],
        "target": {"label": "Self-reported anxiety diagnosis",
                   "definition": "Participant reports having been told by a clinician that they have anxiety (All of Us Personal and Family Health History survey)",
                   "population": "Adults with an EHR visit in the past year and no anxiety code (ICD-10-CM F41)"},
        "reason": "an anxiety diagnosis is already recorded",
        "task": "Task 55 (Task 39's design for anxiety)"},
    "lupus": {
        "registry": "features_lupus.json", "model_id": "unm-lupus", "results": "results/aggregate/54", "prefix": "t54_lupus",
        "out": "model/lupus.json", "name": "lupus",
        "codelists_also": [("results/aggregate/39", "t39_fibromyalgia")],
        "target": {"label": "Self-reported lupus diagnosis",
                   "definition": "Participant reports having been told by a clinician that they have lupus (All of Us Personal and Family Health History survey)",
                   "population": "Adults with an EHR visit in the past year and no systemic lupus erythematosus code (ICD-10-CM M32)"},
        "reason": "a lupus diagnosis is already recorded",
        "task": "Task 54 (Task 39's design for lupus)"},
}


def read_codelists(results: str, prefix: str, also=()) -> tuple[dict, dict]:
    """LOINC and RxCUI lists per feature: the task's own lists (full, or only the features new in that task,
    "_new"), plus the lists an earlier task released for the shared features."""
    labs, drugs = {}, {}
    for d, p in [(results, prefix), *[(os.path.join(ROOT, d2), p2) for d2, p2 in also]]:
        for kind, store, col in (("labs", labs, "loinc"), ("drugs", drugs, "rxcui")):
            for suffix in ("", "_new"):
                path = os.path.join(d, f"{p}_codelist_{kind}{suffix}.csv")
                if not os.path.exists(path):
                    continue
                t = pd.read_csv(path, dtype=str)
                if col == "rxcui":
                    t = t.assign(rxcui=t.rxcui.str.replace("rxcui:", "", regex=False))
                for fid, codes in t.groupby("fid")[col]:
                    store.setdefault(fid, set()).update(codes)
    return ({k: sorted(v) for k, v in labs.items()}, {k: sorted(v) for k, v in drugs.items()})


def use_registry(name: str) -> None:
    cf.REG = json.load(open(os.path.join(ROOT, "workbench/src", name)))
    cf.WIN = {k: tuple(v) for k, v in cf.REG["windows"].items()}


def definitions(labs: dict, drugs: dict) -> dict:
    reg, W = cf.REG, cf.REG["windows"]
    d = {}
    for f in reg["demographics"]:
        e = {"id": f["id"], "kind": f["kind"], "label": f["label"], "group": GROUPS["demographics"]}
        e.update({"min": f["min"], "max": f["max"]} if f["kind"] == "age_band" else {"value": f["value"]})
        d[f["id"]] = e
    for f in reg["conditions"]:
        d[f["id"]] = {"id": f["id"], "label": f["label"], "group": GROUPS["conditions"], "kind": "any", "resource": "Condition",
                      "codes": {"icd10cm_prefix": f["icd10cm_prefix"]}, "present_in": [f["window"]]}
    clusters = {}
    for f in reg["conditions"]:
        if "cluster" in f:
            clusters.setdefault(f["cluster"], []).extend(f["icd10cm_prefix"])
    for f in reg["cluster_counts"]:
        d[f["id"]] = {"id": f["id"], "label": f["label"], "group": GROUPS["cluster_counts"], "kind": "cluster_count_ge",
                      "clusters": clusters, "window": W[f["window"]], "threshold": f["threshold"]}
    for f in reg["procedures"]:
        d[f["id"]] = {"id": f["id"], "label": f["label"], "group": GROUPS["procedures"], "kind": "any", "resource": "Procedure",
                      "codes": {"cpt": cf.expand_cpt(f["cpt"])}, "present_in": [f["window"]]}
    for f in reg["labs"]:
        d[f["id"]] = {"id": f["id"], "label": f["label"], "group": GROUPS["labs"], "kind": "any", "resource": "Observation",
                      "codes": {"loinc": sorted(labs.get(f["id"], []))}, "present_in": [f["window"]]}
    for f in reg["medications"]:
        d[f["id"]] = {"id": f["id"], "label": f["label"], "group": GROUPS["medications"], "kind": "any", "resource": "MedicationRequest",
                      "codes": {"rxcui": sorted(drugs.get(f["id"], [])), "rxnorm_ingredient_names": f["rxnorm_ingredients"]},
                      "present_in": [f["window"]]}
    for f in reg["utilization"]:
        d[f["id"]] = {"id": f["id"], "label": f["label"], "group": GROUPS["utilization"], "kind": "encounter_count_ge",
                      "encounter_class": f["encounter_class"], "windows": [f["window"]], "threshold": f["threshold"]}
    return d


def main(results=None, out=None, prefix=None, condition="chronicfatigue"):
    spec = CONDITIONS[condition]
    use_registry(spec["registry"])
    results = results or os.path.join(ROOT, spec["results"])
    out = out or os.path.join(ROOT, spec["out"])
    prefix = prefix or spec["prefix"]
    rd = lambda n: pd.read_csv(os.path.join(results, f"{prefix}_{n}.csv"))
    labels = rd("label_counts").set_index("measure").value.astype(float)
    tab = rd("feature_label_counts")
    nb = cf.fit_nb_eb(tab, n1=labels["n_train_pos"] - cf.ROUND_EXCESS, n0=labels["n_train_neg"] - cf.ROUND_EXCESS, unround=True)
    bins = rd("calibration_bins")
    a, b = fit_calibration(bins)
    base = float((bins.n_pos - cf.ROUND_EXCESS).sum() / (bins.n - cf.ROUND_EXCESS).sum())
    labs, drugs = read_codelists(results, prefix, spec.get("codelists_also", ()))
    defs = definitions(labs, drugs)
    feats = [{**defs[f], "weight": round(float(w), 6)} for f, w in zip(nb["features"], nb["weights"])]
    lo, hi = float(bins.score_lo.min()) - 2, float(bins.score_hi.max()) + 2
    points = [[round(float(s), 4), round(float(1 / (1 + math.exp(-(a + b * s)))), 6)] for s in np.linspace(lo, hi, 25)]
    model = {
        "model_id": spec["model_id"], "version": "1.0.0", "status": "research",
        "target": spec["target"],
        "index_event": {"type": "scoring_date", "rule": "day 0 is the date the chart is scored; all windows look back from it"},
        "exclusion": {"condition_codes": {"icd10cm": cf.REG["exclusion_icd10cm_prefix"]},
                      "reason": spec["reason"]},
        **({"eligibility": spec["eligibility"]} if spec.get("eligibility") else {}),
        "history_requirement": {**cf.REG["history_requirement"], "reason": "no encounters in the past year (insufficient history)"},
        "windows": cf.REG["windows"],
        "features": feats,
        "intercept": round(float(nb["intercept"]), 6),
        "calibration": {"method": "piecewise_linear", "points": points,
                        "fit": {"type": "logistic on binned training-split counts", "a": a, "b": b}},
        "risk_bands": [{"name": "Typical", "max_probability": round(1.5 * base, 6)},
                       {"name": "Elevated", "max_probability": round(3 * base, 6)}, {"name": "High", "max_probability": 1.0}],
        "reference": {"cohort_base_rate": round(base, 6)},
        "provenance": {"data": "NIH All of Us Research Program, Registered Tier Dataset v9 (CDR R2025Q4R6)",
                       "method": "Naive Bayes with empirical-Bayes shrinkage, fit outside the Researcher Workbench from dissemination-compliant summary counts (every released cell above 20, rounded up to 10); labels are survey self-reports, so the model learns from patients whose diagnosis was never coded",
                       "task": spec["task"], "tau2": nb["tau2"], "features_eligible": len(feats)},
        "statement": "Research decision support. Surfaces chart patterns for clinician review. Not a diagnosis.",
    }
    json.dump(model, open(out, "w"), indent=1)
    print(f"wrote {out}: {len(feats)} features, intercept {model['intercept']}, base rate {base:.4f}, calibration a={a:.3f} b={b:.3f}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--condition", default="chronicfatigue", choices=sorted(CONDITIONS))
    ap.add_argument("--results")
    ap.add_argument("--prefix")
    ap.add_argument("--out")
    a = ap.parse_args()
    main(a.results, a.out, a.prefix, a.condition)
