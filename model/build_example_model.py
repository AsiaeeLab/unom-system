"""Build model/longcovid.example.json from workbench/src/features.yaml.

The weights are PLACEHOLDERS chosen by hand so the app has a realistic file to
build against. The real file (model/longcovid.json) is fit from exported
All of Us summary statistics.
"""
import json
import yaml

reg = yaml.safe_load(open("workbench/src/features.yaml"))
W = {  # placeholder log-odds weights
    "age_40_49": 0.2, "age_50_59": 0.2, "age_60_69": 0.0, "age_70p": -0.3, "sex_female": 0.2,
    "acute_inpatient": 0.3, "acute_ed": 0.1, "covid_pneumonia": 0.3, "acute_ventilation": 0.2,
    "out_w0_ge4": -0.1, "out_w3_ge2": 0.4, "out_w3_ge4": 0.4, "ed_w3_any": 0.2, "ip_w3_any": 0.2, "visit_rate_up": 0.3,
    "sym_fatigue": 0.8, "sym_dyspnea": 0.6, "sym_cough": 0.3, "sym_chest_pain": 0.4, "sym_autonomic": 0.9,
    "sym_cognitive": 0.9, "sym_headache": 0.3, "sym_dizzy_syncope": 0.5, "sym_smell_taste": 0.7, "sym_sleep": 0.3,
    "sym_mood": 0.2, "sym_msk_pain": 0.3, "sym_gi": 0.2, "sym_paresthesia": 0.3, "sym_hair_loss": 0.4, "sym_fever": 0.1,
    "sym_count_ge2": 0.4, "sym_count_ge4": 0.6,
    "test_echo": 0.5, "test_cardiac_monitor": 0.6, "test_pft": 0.5, "test_chest_ct": 0.2, "test_chest_xray": 0.1,
    "test_brain_mri": 0.4, "test_tilt": 0.9, "test_sleep_study": 0.3, "test_walk": 0.4,
    "rx_beta_blocker": 0.5, "rx_pots_other": 0.8, "rx_ssri_snri": 0.2, "rx_gabapentinoid": 0.2, "rx_inhaler": 0.3,
    "rx_systemic_steroid": 0.2, "rx_antihistamine": 0.3, "rx_montelukast": 0.2, "rx_naltrexone": 0.9,
    "rx_wake_stimulant": 0.6, "rx_sleep_aid": 0.2, "rx_opioid": 0.1,
}


def expand_cpt(items):
    out = []
    for it in items:
        if "-" in it and it.replace("-", "").isdigit():
            a, b = it.split("-")
            out += [str(x) for x in range(int(a), int(b) + 1)]
        else:
            out.append(it)
    return out


feats = []
for f in reg["demographics"]:
    feats.append({k: v for k, v in f.items()} | {"group": "Demographics", "label": f["id"].replace("_", " ")})
for f in reg["acute"]:
    e = {"id": f["id"], "label": f["label"], "group": "Acute illness", "kind": f["kind"], "window": f["window"]}
    if f["kind"] == "encounter_any":
        e["encounter_class"] = f["encounter_class"]
    else:
        e["resource"] = f["resource"]
        e["codes"] = {k: (expand_cpt(v) if k == "cpt" else v) for k, v in f.items() if k in ("icd10cm_prefix", "cpt", "icd10pcs")}
    feats.append(e)
for f in reg["utilization"]:
    feats.append({**f, "group": "Health care use"})
for f in reg["new_symptoms"]:
    if f.get("kind") == "derived_count_ge":
        feats.append({"id": f["id"], "label": f["label"], "group": "Symptoms", "kind": "derived_count_ge",
                      "of_group": "Symptoms", "threshold": f["threshold"]})
    else:
        feats.append({"id": f["id"], "label": f["label"], "group": "Symptoms", "kind": "new_onset", "resource": "Condition",
                      "codes": {"icd10cm_prefix": f["icd10cm_prefix"]}, "present_in": ["W2", "W3"], "absent_in": ["W0", "W1"]})
for f in reg["new_tests"]["procedures"]:
    feats.append({"id": f["id"], "label": f["label"], "group": "Tests ordered", "kind": "any", "resource": "Procedure",
                  "codes": {"cpt": expand_cpt(f["cpt"])}, "present_in": ["W2", "W3"]})
for f in reg["new_medications"]:
    feats.append({"id": f["id"], "label": "New " + ", ".join(f["rxnorm_ingredients"][:3]) + ("…" if len(f["rxnorm_ingredients"]) > 3 else ""),
                  "group": "New medications", "kind": "new_onset", "resource": "MedicationRequest",
                  "codes": {"rxnorm_ingredient_names": f["rxnorm_ingredients"], "rxcui": []},
                  "present_in": ["W2", "W3"], "absent_in": ["W0", "W1"],
                  "note": "RxCUI list pending (resolved in Workbench task 02); match ingredient names meanwhile"})
for f in feats:
    f["weight"] = W.get(f["id"], 0.0)

model = {
    "model_id": "unm-longcovid", "version": "0.1.0", "status": "placeholder",
    "target": {"label": "Future Long COVID diagnosis code",
               "definition": "First ICD-10-CM U09.9 code 91-455 days after the first documented COVID-19 diagnosis",
               "population": "Adults with documented COVID-19 and no Long COVID code by day 90",
               "landmark_days": 90, "horizon_days": [91, 455]},
    "index_event": {"condition_codes": {"icd10cm": ["U07.1"]},
                    "positive_test_loinc": ["94500-6", "94309-2", "94534-5", "94558-4", "95209-3"],
                    "rule": "earliest qualifying Condition or positive Observation"},
    "exclusion": {"condition_codes": {"icd10cm": ["U09.9"], "snomed": ["1119303003", "1119304009"]}},
    "windows": reg["windows"],
    "features": feats,
    "intercept": -5.2,
    "calibration": {"method": "piecewise_linear",
                    "points": [[-7.0, 0.0009], [-6.0, 0.0025], [-5.0, 0.0067], [-4.0, 0.018], [-3.0, 0.047],
                               [-2.0, 0.12], [-1.0, 0.27], [0.0, 0.5]]},
    "risk_bands": [{"name": "Typical", "max_probability": 0.015},
                   {"name": "Elevated", "max_probability": 0.04},
                   {"name": "High", "max_probability": 1.0}],
    "reference": {"cohort_base_rate": 0.011, "top5pct_min_probability": 0.03},
    "provenance": {"data": "PLACEHOLDER weights for interface development; not trained on any data",
                   "method": "The real model is a linear discriminant refit from dissemination-compliant summary counts",
                   "open_data": ["CDC/NCHS Household Pulse Survey (gsea-w83j)", "CMS fee schedules"]},
    "statement": "Research decision support. Surfaces chart patterns for clinician review. Not a diagnosis.",
}
json.dump(model, open("model/longcovid.example.json", "w"), indent=2)
print(f"wrote model/longcovid.example.json with {len(feats)} features")
