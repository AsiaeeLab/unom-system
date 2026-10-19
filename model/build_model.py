"""Assemble model/longcovid.json (the file the app loads) from exported results.

Inputs
  model/candidates/transport_candidates.json   weights fit from Task 04 summary counts
  results/aggregate/05/t05_transport_performance.csv, t05_calibration_<name>.csv
  workbench/src/features.yaml                   feature definitions (same registry as Workbench)
  results/aggregate/02/t02_codelist_labs.csv, results/aggregate/10/t10_codelist_drugs_part*.csv
Output
  model/longcovid.json (format: docs/interface/model_spec.md)

The current release (v1.2.0: the v1.1.0 weights, nb_eb from the Task 35 counts evaluated on the Task 36 validation
split, plus the training cohort's index era start and full Long COVID exclusion list) is rebuilt with its exact
settings by analysis/build_paper1.py; the defaults below reproduce the original v1.0.x build except for those two
eligibility fields (pass earliest_date=None to leave the era start out).
"""

from __future__ import annotations

import argparse
import glob
import json
import math
import os
import sys

import numpy as np
import pandas as pd
import yaml

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# Training cohort definitions (workbench/src/t01_cohort.py): the first U07.1 on or after ERA_START (a shifted
# date that keeps day 91 on or after October 1, 2021, when U09.9 became available) is the index, and a Long
# COVID code is U09.9 or one of these SNOMED CT post-COVID concepts.
ERA_START = "2021-07-02"
SNOMED_PASC = ("1119303003", "1119304009", "1325161000000102")


def expand_cpt(items):
    out = []
    for it in items:
        if "-" in it and it.replace("-", "").isdigit():
            a, b = it.split("-")
            out += [str(x) for x in range(int(a), int(b) + 1)]
        else:
            out.append(it)
    return out


def definitions(reg, labs, drugs):
    """feature id -> definition dict (without weight), per the model spec."""
    d = {}
    for f in reg["demographics"]:
        label = ("Female" if f["kind"] == "sex" else
                 f"Age {f['min']}+" if f["max"] >= 120 else f"Age {f['min']}-{f['max']}")
        d[f["id"]] = {**f, "group": "Demographics", "label": label}
    for f in reg["acute"]:
        e = {"id": f["id"], "label": f["label"], "group": "Acute illness", "kind": f["kind"], "window": f["window"]}
        if f["kind"] == "encounter_any":
            e["encounter_class"] = f["encounter_class"]
        else:
            e["resource"] = f["resource"]
            e["codes"] = {k: (expand_cpt(v) if k == "cpt" else v) for k, v in f.items()
                          if k in ("icd10cm_prefix", "cpt", "icd10pcs")}
        d[f["id"]] = e
    for f in reg["utilization"]:
        d[f["id"]] = {**f, "group": "Health care use"}
    for f in reg["new_symptoms"]:
        if f.get("kind") == "derived_count_ge":
            d[f["id"]] = {"id": f["id"], "label": f["label"], "group": "New symptoms", "kind": "derived_count_ge",
                          "of_group": "New symptoms", "threshold": f["threshold"]}
        else:
            d[f["id"]] = {"id": f["id"], "label": "New: " + f["label"].lower(), "group": "New symptoms",
                          "kind": "new_onset", "resource": "Condition", "codes": {"icd10cm_prefix": f["icd10cm_prefix"]},
                          "present_in": ["W2", "W3"], "absent_in": ["W0", "W1"]}
    for f in reg["prior_conditions"]:
        name = {"copd": "COPD", "mecfs": "ME/CFS"}.get(f["id"].replace("hx_", ""), f["id"].replace("hx_", "").replace("_", " "))
        d[f["id"]] = {"id": f["id"], "label": "History: " + name,
                      "group": "Prior conditions", "kind": "any", "resource": "Condition",
                      "codes": {"icd10cm_prefix": f["icd10cm_prefix"]}, "present_in": ["W0", "W1"]}
    for f in reg["new_tests"]["procedures"]:
        d[f["id"]] = {"id": f["id"], "label": f["label"], "group": "Tests after COVID", "kind": "any",
                      "resource": "Procedure", "codes": {"cpt": expand_cpt(f["cpt"])}, "present_in": ["W2", "W3"]}
    for f in reg["new_tests"]["labs"]:
        codes = sorted(labs.get(f["id"], []))
        d[f["id"]] = {"id": f["id"], "label": f.get("label", f["loinc_seed"] + " test"), "group": "Tests after COVID", "kind": "any",
                      "resource": "Observation", "codes": {"loinc": codes}, "present_in": ["W2", "W3"]}
    for f in reg["new_medications"]:
        d[f["id"]] = {"id": f["id"], "label": f.get("label", "New " + ", ".join(f["rxnorm_ingredients"])),
                      "group": "New medications", "kind": "new_onset", "resource": "MedicationRequest",
                      "codes": {"rxcui": sorted(drugs.get(f["id"], [])), "rxnorm_ingredient_names": f["rxnorm_ingredients"]},
                      "present_in": ["W2", "W3"], "absent_in": ["W0", "W1"]}
    ex = reg.get("extra_features", {})
    if ex:
        clusters = {f["id"].replace("sym_", ""): f["icd10cm_prefix"] for f in reg["new_symptoms"] if "icd10cm_prefix" in f}
        names = {f["id"].replace("sym_", ""): f["label"] for f in reg["new_symptoms"] if "icd10cm_prefix" in f}
        for name, pre in clusters.items():
            d[f"sym_any_{name}"] = {"id": f"sym_any_{name}", "label": names[name] + " (coded by day 90)",
                                    "group": "Symptoms after COVID", "kind": "any", "resource": "Condition",
                                    "codes": {"icd10cm_prefix": pre}, "window": ex["any_symptom_window"]}
        for t in ex["w3_cluster_count"]["thresholds"]:
            d[f"sym_any_w3_count_ge{t}"] = {"id": f"sym_any_w3_count_ge{t}", "label": f"{t}+ symptom types coded in days 31-90",
                                            "group": "Symptoms after COVID", "kind": "cluster_count_ge",
                                            "clusters": clusters, "window": ex["w3_cluster_count"]["window"], "threshold": t}
        for f in ex["single"]:
            d[f["id"]] = {"id": f["id"], "label": f["label"], "group": "Coding after COVID", "kind": "any",
                          "resource": "Condition", "codes": {"icd10cm_prefix": f["icd10cm_prefix"]}, "window": f["window"]}
        lv = ex["late_visit_61_90"]
        d["late_visit_61_90"] = {"id": "late_visit_61_90", "label": lv["label"], "group": "Health care use",
                                 "kind": "encounter_any", "encounter_class": lv["encounter_class"], "window": lv["window"]}
    return d


def fit_calibration(bins: pd.DataFrame, rounding=4.5):
    """Grouped-binomial logistic fit of P(label) on the bin mean score; returns (a, b).

    Task 05 rounds n and n_pos up to a multiple of 10; `rounding` is the expected excess.
    """
    x = bins.score_mean.to_numpy(float)
    n = bins.n.to_numpy(float) - rounding
    k = bins.n_pos.to_numpy(float) - rounding
    a, b = math.log(k.sum() / (n.sum() - k.sum())), 0.0
    for _ in range(100):  # Newton-Raphson
        p = 1 / (1 + np.exp(-(a + b * x)))
        g = np.array([np.sum(k - n * p), np.sum((k - n * p) * x)])
        w = n * p * (1 - p)
        H = np.array([[w.sum(), (w * x).sum()], [(w * x).sum(), (w * x * x).sum()]])
        step = np.linalg.solve(H, g)
        a, b = a + step[0], b + step[1]
        if np.abs(step).max() < 1e-10:
            break
    return float(a), float(b)


def main(results=os.path.join(ROOT, "results/aggregate"),
         candidates=os.path.join(ROOT, "model/candidates/transport_candidates.json"),
         out=os.path.join(ROOT, "model/longcovid.json"), model_name=None, version="1.0.1", eval_dir="05",
         evaluation="held_out", evaluation_note=None, features_note=None, earliest_date=ERA_START):
    """evaluation: "held_out" (provenance.held_out_evaluation, the v1.0.x layout) or "validation_split"
    (provenance.validation_split_evaluation after open_data, with evaluation_note; the v1.1.0 layout).
    features_note: optional provenance.features_note.
    earliest_date: index_event.earliest_date, the first date a U07.1 can be the index (the training cohort's
    coding-era start, workbench/src/t01_cohort.py ERA_START); None leaves it out, as in files before v1.2.0."""
    if evaluation not in ("held_out", "validation_split"):
        raise ValueError(f"evaluation must be held_out or validation_split, not {evaluation!r}")
    index_rule = ("first U07.1 Condition dated on or after index_event.earliest_date (as in training) and on or "
                  "before the scoring date; positive tests only if use_positive_tests" if earliest_date else
                  "earliest U07.1 Condition; positive tests only if use_positive_tests")
    reg = yaml.safe_load(open(os.path.join(ROOT, "workbench/src/features.yaml")))
    labs_df = pd.read_csv(os.path.join(results, "02/t02_codelist_labs.csv"), dtype=str)
    labs = labs_df.groupby("fid").loinc.apply(list).to_dict()
    drug_df = pd.concat([pd.read_csv(f, dtype=str) for f in sorted(glob.glob(os.path.join(results, "10/t10_codelist_drugs_part*.csv")))])
    drugs = drug_df.assign(code=drug_df.rxcui.str.replace("rxcui:", "", regex=False)).groupby("fid").code.apply(list).to_dict()
    defs = definitions(reg, labs, drugs)

    cands = json.load(open(candidates))
    perf = pd.read_csv(os.path.join(results, f"{eval_dir}/t05_transport_performance.csv"))
    exportable = perf[perf.trained_on.str.startswith("summary")].sort_values("auroc", ascending=False)
    best = exportable.iloc[0] if model_name is None else exportable.set_index("model").loc[model_name].rename(model_name)
    best = best if model_name is None else best.to_frame().T.assign(model=model_name).iloc[0]
    cand = next(c for c in cands["candidates"] if c["name"] == best.model)
    bins = pd.read_csv(os.path.join(results, f"{eval_dir}/t05_calibration_{best.model}.csv"))
    a, b = fit_calibration(bins)
    base = float((bins.n_pos - 4.5).sum() / (bins.n - 4.5).sum())

    feats = []
    for fid, w in zip(cand["features"], cand["weights"]):
        if fid not in defs:
            sys.exit(f"no definition for feature {fid}")
        feats.append({**defs[fid], "weight": round(float(w), 6)})
    # a derived count (e.g. sym_count_ge2) was computed over every new-symptom cluster in
    # Workbench, so clusters left out of the fit are still evaluated, with weight 0
    derived_groups = {f["of_group"] for f in feats if f["kind"] == "derived_count_ge"}
    have = {f["id"] for f in feats}
    for fid, e in defs.items():
        if e.get("group") in derived_groups and e["kind"] != "derived_count_ge" and fid not in have:
            feats.append({**e, "weight": 0.0})
    lo, hi = float(bins.score_mean.min()) - 3, float(bins.score_mean.max()) + 3
    grid = np.linspace(lo, hi, 25)
    points = [[round(float(s), 4), round(float(1 / (1 + math.exp(-(a + b * s)))), 6)] for s in grid]
    part = perf.set_index("model")
    ref_models = [m for m in ["M2_elastic_net_logistic", "M4_pu_bagging"] if m in part.index]
    ev = {"auroc": float(best.auroc), "auprc": float(best.auprc),
          "held_out_people": str(best.held_out_people), "held_out_positives": str(best.held_out_positives),
          "participant_level_comparators": {m: float(part.loc[m, "auroc"]) for m in ref_models}}
    provenance = {
        "data": "NIH All of Us Research Program, Registered Tier Dataset v9 (CDR R2025Q4R6)",
        "method": f"{best.model}: fit outside the Researcher Workbench from dissemination-compliant summary counts "
                  "(every released cell above 20, rounded to 10); no participant-level data or participant-trained model left Workbench"}
    if evaluation == "held_out":
        provenance["held_out_evaluation"] = ev
    provenance["open_data"] = ["CDC/NCHS Household Pulse Survey, Post-COVID Conditions (gsea-w83j)",
                               "CMS Medicare Physician & Other Practitioners by Geography and Service, CY2024",
                               "NLM RxNorm, LOINC, ICD-10-CM vocabularies"]
    if evaluation == "validation_split":
        provenance["validation_split_evaluation"] = {**ev, **({"note": evaluation_note} if evaluation_note else {})}
    if features_note:
        provenance["features_note"] = features_note
    model = {
        "model_id": "unm-longcovid", "version": version, "status": "research",
        "target": {"label": "Future Long COVID diagnosis code",
                   "definition": "First ICD-10-CM U09.9 code 91-455 days after the first documented COVID-19 diagnosis",
                   "population": "Adults with documented COVID-19 and no Long COVID code by day 90",
                   "landmark_days": 90, "horizon_days": [91, 455]},
        "index_event": {"condition_codes": {"icd10cm": ["U07.1"]},
                        **({"earliest_date": earliest_date} if earliest_date else {}),
                        "use_positive_tests": False,
                        "positive_test_loinc": ["94500-6", "94309-2", "94534-5", "94558-4", "95209-3"],
                        "rule": index_rule},
        "exclusion": {"condition_codes": {"icd10cm": ["U09.9"], "snomed": list(SNOMED_PASC)}},
        "windows": reg["windows"],
        "features": feats,
        "intercept": round(float(cand["intercept"]), 6),
        "calibration": {"method": "piecewise_linear", "points": points,
                        "fit": {"type": "logistic on binned training-split counts", "a": a, "b": b}},
        "risk_bands": [{"name": "Typical", "max_probability": round(1.5 * base, 6)},
                       {"name": "Elevated", "max_probability": round(3 * base, 6)},
                       {"name": "High", "max_probability": 1.0}],
        "reference": {"cohort_base_rate": round(base, 6)},
        "provenance": provenance,
        "statement": "Research decision support. Surfaces chart patterns for clinician review. Not a diagnosis.",
    }
    json.dump(model, open(out, "w"), indent=1)
    print(f"wrote {out}: {best.model}, {len(feats)} features, held-out AUROC {best.auroc}, base rate {base:.4f}")
    return model


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--results", default=os.path.join(ROOT, "results/aggregate"))
    ap.add_argument("--candidates", default=os.path.join(ROOT, "model/candidates/transport_candidates.json"))
    ap.add_argument("--out", default=os.path.join(ROOT, "model/longcovid.json"))
    ap.add_argument("--model-name", default=None, help="candidate to deploy (default: highest AUROC in the evaluation file)")
    ap.add_argument("--version", default="1.0.1")
    ap.add_argument("--eval-dir", default="05", help="results/aggregate/<dir> with t05_transport_performance and calibration bins")
    ap.add_argument("--evaluation", default="held_out", choices=["held_out", "validation_split"])
    ap.add_argument("--evaluation-note", default=None)
    ap.add_argument("--features-note", default=None)
    a = ap.parse_args()
    main(a.results, a.candidates, a.out, a.model_name, a.version, a.eval_dir, a.evaluation, a.evaluation_note,
         a.features_note)
