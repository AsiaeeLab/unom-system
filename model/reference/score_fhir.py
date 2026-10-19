"""Reference scorer: evaluates a model file (docs/interface/model_spec.md) on a FHIR R4 bundle.

This is the ground truth for the app's JavaScript scorer; model/test_vectors/ are produced
from it. Usage:
    python3 model/reference/score_fhir.py model/longcovid.json path/to/bundle.json [--as-of 2025-01-15]
        [--unavailable Observation,Procedure]
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import re
from bisect import bisect_left

ICD10 = "http://hl7.org/fhir/sid/icd-10-cm"
SNOMED = "http://snomed.info/sct"
LOINC = "http://loinc.org"
RXNORM = "http://www.nlm.nih.gov/research/umls/rxnorm"
CPT = "http://www.ama-assn.org/go/cpt"
POSITIVE_INTERP = {"POS", "DET", "H", "10828004", "260373001"}   # HL7 v3 ObservationInterpretation; SNOMED Positive, Detected
NEGATIVE_INTERP = {"NEG", "ND", "N", "260385009", "260415000"}    # Negative, Not detected
NEGATION = ("not ", "no ", "none", "negative", "undetected", "non-reactive", "nonreactive", "non reactive")
MIN_AGE_YEARS = 18                                   # every model covers adults (age on day 0)
EXCLUDED_VERIFICATION = {"refuted", "entered-in-error"}   # Condition.verificationStatus codes that are ignored
ELIGIBILITY_RESOURCES = ("Patient", "Condition", "Encounter")   # read by every model's eligibility rules
FHIR_DATE = re.compile(r"([0-9]{4})(?:-([0-9]{2})(?:-([0-9]{2}))?)?")   # ASCII digits only, as in JavaScript


def _date(value):
    """A full YYYY-MM-DD calendar date from the first 10 characters (used for as_of); raises on anything else."""
    return dt.date.fromisoformat(str(value)[:10]) if value else None


def fhir_date(value, birth=False):
    """A FHIR date or dateTime as a calendar date, or None when it is missing or not a valid FHIR date.

    A full date uses its first 10 characters (any time and zone are ignored). Partial dates, which FHIR allows:
    YYYY is read as January 1 and YYYY-MM as the first of the month (the earliest compatible day); for a birth
    date, YYYY is read as July 1 (as in the training cohort when only the birth year is known) and YYYY-MM as
    the 15th. A partial date followed by anything else, an impossible calendar date, or year 0 is not valid.
    """
    if not value or not isinstance(value, str):   # FHIR JSON dates are strings
        return None
    s = value
    m = FHIR_DATE.match(s)
    if not m:
        return None
    y, mo, d = m.group(1), m.group(2), m.group(3)
    if d is None and m.end() != len(s):
        return None
    try:
        if d is not None:
            return dt.date(int(y), int(mo), int(d))
        if mo is not None:
            return dt.date(int(y), int(mo), 15 if birth else 1)
        return dt.date(int(y), 7, 1) if birth else dt.date(int(y), 1, 1)
    except ValueError:
        return None


def resource_date(r):
    """The first of the resource's date fields (spec section 3) that holds a valid FHIR date, or None."""
    for path in (("onsetDateTime",), ("onsetPeriod", "start"), ("recordedDate",), ("period", "start"),
                 ("effectiveDateTime",), ("effectivePeriod", "start"), ("issued",), ("authoredOn",),
                 ("performedDateTime",), ("performedPeriod", "start"), ("occurrenceDateTime",)):
        v = r
        for k in path:
            v = v.get(k) if isinstance(v, dict) else None
        if v:
            d = fhir_date(v)
            if d is not None:
                return d
    return None


def codings(concept):
    return (concept or {}).get("coding", []) or []


def _text(v):
    """A text part for matching: strings as they are; null or any other JSON value counts as empty."""
    return v if isinstance(v, str) else ""


def icd(code):
    return str(code or "").replace(".", "").upper()


def has_icd_prefix(r, prefixes, field="code"):
    return any(c.get("system") == ICD10 and icd(c.get("code")).startswith(tuple(icd(p) for p in prefixes))
               for c in codings(r.get(field)))


def has_code(r, system, codes, field="code"):
    codes = {str(c) for c in codes}
    return any(c.get("system") == system and str(c.get("code")) in codes for c in codings(r.get(field)))


def med_matches(r, codes):
    concept = r.get("medicationCodeableConcept") or {}
    rx = {c.replace("rxcui:", "") for c in codes.get("rxcui", [])}
    if rx and any(c.get("system") == RXNORM and str(c.get("code")) in rx for c in codings(concept)):
        return True
    names = [n.lower() for n in codes.get("rxnorm_ingredient_names", [])]
    text = " ".join([_text(concept.get("text"))] + [_text(c.get("display")) for c in codings(concept)]).lower()
    return bool(names) and any(n in text for n in names)


def matches(r, feat):
    rt, codes = r.get("resourceType"), feat.get("codes", {})
    if rt != feat.get("resource"):
        return False
    if rt == "Condition":
        return has_icd_prefix(r, codes.get("icd10cm_prefix", []))
    if rt == "Procedure":
        return has_code(r, CPT, codes.get("cpt", [])) or has_code(r, "http://www.cms.gov/Medicare/Coding/ICD10", codes.get("icd10pcs", []))
    if rt == "Observation":
        return has_code(r, LOINC, codes.get("loinc", []))
    if rt == "MedicationRequest":
        return med_matches(r, codes)
    return False


def encounter_class(r):
    """HL7 v3 ActCode of the encounter; virtual visits count as ambulatory (AMB)."""
    c = r.get("class")
    if isinstance(c, list):
        c = c[0] if c else {}
    if isinstance(c, dict) and "coding" in c:
        c = (c.get("coding") or [{}])[0]
    code = (c or {}).get("code")
    return "AMB" if code in ("VR", "HH") else code


def test_is_positive(obs):
    """True only for an explicitly positive result: interpretation code first, then value text without negation."""
    codes = {str(c.get("code")) for concept in (obs.get("interpretation") or []) for c in codings(concept)}
    val = obs.get("valueCodeableConcept") or {}
    codes |= {str(c.get("code")) for c in codings(val)}
    if codes & NEGATIVE_INTERP:
        return False
    if codes & POSITIVE_INTERP:
        return True
    text = " ".join([_text(val.get("text"))] + [_text(c.get("display")) for c in codings(val)]
                    + [_text(obs.get("valueString"))]).lower().strip()
    if not text or any(n in text for n in NEGATION):
        return False
    return "detected" in text or "positive" in text


def find_index(resources, use_positive_tests=False, test_loinc=(), earliest=None):
    """Earliest U07.1 Condition on or after `earliest` (when given); positive SARS-CoV-2 tests count only when the
    model enables them. Undated records cannot be an index event."""
    dates = []
    for r in resources:
        if r.get("resourceType") == "Condition" and has_icd_prefix(r, ["U071"]):
            dates.append(resource_date(r))
        if use_positive_tests and r.get("resourceType") == "Observation" and test_is_positive(r) and any(
                c.get("system") == LOINC and c.get("code") in test_loinc for c in codings(r.get("code"))):
            dates.append(resource_date(r))
    dates = [d for d in dates if d and (earliest is None or d >= earliest)]
    return min(dates) if dates else None


def usable(r):
    """False for records that say they are wrong: a Condition whose verificationStatus is refuted or
    entered-in-error, or any resource whose status is entered-in-error. Such records are ignored everywhere."""
    if r.get("resourceType") == "Condition" and any(
            str(c.get("code") or "").lower() in EXCLUDED_VERIFICATION for c in codings(r.get("verificationStatus"))):
        return False
    return r.get("status") != "entered-in-error"


def required_resources(model):
    """Resource types the model reads: (eligibility, features). A failed search for any of them means the
    model cannot score the chart."""
    elig = list(ELIGIBILITY_RESOURCES)
    if model.get("index_event", {}).get("use_positive_tests"):
        elig.append("Observation")
    feats = sorted({f["resource"] for f in model["features"] if f.get("resource")} - set(elig))
    return elig, feats


def calibrate(score, points):
    xs = [p[0] for p in points]
    if score <= xs[0]:
        return points[0][1]
    if score >= xs[-1]:
        return points[-1][1]
    i = bisect_left(xs, score)
    (x0, y0), (x1, y1) = points[i - 1], points[i]
    return y0 + (y1 - y0) * (score - x0) / (x1 - x0)


def nest_key(f):
    """Features equal in everything but id, label, weight, and threshold are nested thresholds."""
    return json.dumps({k: v for k, v in f.items() if k not in ("id", "label", "weight", "threshold")}, sort_keys=True)


def could_not_score(missing, day0=None):
    out = {"status": "could_not_score", "reason": f"could not score: {', '.join(missing)} unavailable"}
    if day0 is not None:
        out["index_date"] = str(day0)
    out["unavailable"] = list(missing)
    return out


def score_bundle(model, bundle, as_of=None, unavailable=()):
    """Score one bundle. as_of: the scoring date (default today). unavailable: resource types whose FHIR search
    failed or was forbidden; a model that reads one of them returns status "could_not_score" instead of
    treating the missing records as absent."""
    as_of = as_of or dt.date.today()
    unavailable = set(unavailable or ())
    elig_types, feat_types = required_resources(model)
    missing = [t for t in elig_types if t in unavailable]
    if missing:
        return could_not_score(missing)
    # records that say they are wrong are ignored, and so is everything dated after the scoring date
    res = [r for r in (e["resource"] for e in bundle.get("entry", []) if "resource" in e)
           if usable(r) and not (resource_date(r) is not None and resource_date(r) > as_of)]
    patient = next((r for r in res if r.get("resourceType") == "Patient"), {})
    ie = model.get("index_event", {})
    excl = model["exclusion"]["condition_codes"]

    def is_excl(r):
        # a target diagnosis on or before the scoring date, or with no usable date, counts as already recorded
        return r.get("resourceType") == "Condition" and (
            has_icd_prefix(r, excl.get("icd10cm", [])) or has_code(r, SNOMED, excl.get("snomed", [])))

    birth = fhir_date(patient.get("birthDate"), birth=True)
    if ie.get("type") == "scoring_date":
        # day 0 is the scoring date; a recorded target diagnosis means the patient is already visible
        day0 = as_of
        if birth is None:
            return {"status": "not_scored", "reason": "birth date missing or unusable (age is required)",
                    "index_date": str(day0)}
        if (day0 - birth).days / 365.25 < MIN_AGE_YEARS:
            return {"status": "not_scored", "reason": "under 18 on the scoring date (the model covers adults)",
                    "index_date": str(day0)}
        sex = model.get("eligibility", {}).get("sex")
        if sex is not None and patient.get("gender") != sex:
            return {"status": "not_scored", "reason": model["eligibility"]["reason"], "index_date": str(day0)}
        if any(is_excl(r) for r in res):
            return {"status": "not_scored", "reason": model["exclusion"]["reason"], "index_date": str(day0)}
    else:
        earliest = _date(ie["earliest_date"]) if ie.get("earliest_date") else None
        use_tests, loinc = ie.get("use_positive_tests", False), tuple(ie.get("positive_test_loinc", []))
        day0 = find_index(res, use_tests, loinc, earliest)
        if day0 is None:
            if earliest is not None and find_index(res, use_tests, loinc) is not None:
                return {"status": "not_scored", "reason": f"no documented COVID-19 index event on or after {earliest} "
                        "(earlier COVID-19 diagnoses are outside the model's population)"}
            return {"status": "not_scored", "reason": "no documented COVID-19 index event"}
        if birth is None:
            return {"status": "not_scored", "reason": "birth date missing or unusable (age is required)",
                    "index_date": str(day0)}
        if (day0 - birth).days / 365.25 < MIN_AGE_YEARS:
            return {"status": "not_scored", "reason": "under 18 at the COVID-19 index (the model covers adults)",
                    "index_date": str(day0)}
        if (as_of - day0).days < model["target"]["landmark_days"]:
            return {"status": "not_scored", "reason": "fewer than 90 days since the COVID-19 index", "index_date": str(day0)}
        horizon = (model["target"].get("horizon_days") or [None, None])[1]
        if horizon is not None and (as_of - day0).days > horizon:
            return {"status": "not_scored", "reason": f"more than {horizon} days since the COVID-19 index "
                    "(outside the model's time window)", "index_date": str(day0)}
        # any Long COVID code up to the scoring date, including before or on the index date, or undated
        if any(is_excl(r) for r in res):
            return {"status": "not_scored", "reason": "a Long COVID diagnosis is already recorded", "index_date": str(day0)}
    W = model["windows"]

    def off(r):
        d = resource_date(r)
        return (d - day0).days if d else None

    def in_windows(o, wins):
        return o is not None and any(W[w][0] <= o <= W[w][1] for w in wins)

    encounters = [r for r in res if r.get("resourceType") == "Encounter"]
    hist = model.get("history_requirement")
    if hist:
        n_hist = sum(1 for e in encounters if encounter_class(e) in hist["encounter_class"] and in_windows(off(e), [hist["window"]]))
        if n_hist < hist["min_count"]:
            return {"status": "not_scored", "reason": hist["reason"], "index_date": str(day0)}
    elif not any(in_windows(off(e), ["W0", "W1"]) for e in encounters):
        return {"status": "not_scored", "reason": "no encounters in the year before COVID-19 (insufficient history)",
                "index_date": str(day0)}
    missing = [t for t in feat_types if t in unavailable]
    if missing:
        return could_not_score(missing, day0)
    age = (day0 - birth).days / 365.25

    values, evidence = {}, {}
    derived = []
    for f in model["features"]:
        k, fid = f["kind"], f["id"]
        v, ev = 0, []
        if k == "age_band":
            v = int(f["min"] <= age < f["max"] + 1)
        elif k == "sex":
            v = int(patient.get("gender") == f["value"])
        elif k in ("any", "new_onset"):
            hits = [r for r in res if matches(r, f)]
            if "window" in f:
                pres = [r for r in hits if off(r) is not None and f["window"][0] <= off(r) <= f["window"][1]]
            else:
                pres = [r for r in hits if in_windows(off(r), f["present_in"])]
            prior = [r for r in hits if in_windows(off(r), f.get("absent_in", []))] if k == "new_onset" else []
            v = int(bool(pres) and not prior)
            ev = pres if v else []
        elif k == "encounter_any":
            pres = [e for e in encounters if encounter_class(e) in f["encounter_class"] and off(e) is not None
                    and f["window"][0] <= off(e) <= f["window"][1]]
            v, ev = int(bool(pres)), pres
        elif k == "encounter_count_ge":
            pres = [e for e in encounters if encounter_class(e) in f["encounter_class"] and in_windows(off(e), f["windows"])]
            v, ev = int(len(pres) >= f["threshold"]), pres
        elif k == "encounter_rate_ratio_ge":
            def cnt(w):
                return sum(1 for e in encounters if encounter_class(e) in f["encounter_class"] and in_windows(off(e), [w]))
            nw, dw = W[f["numerator"]], W[f["denominator"]]
            num, den = cnt(f["numerator"]), cnt(f["denominator"])
            rate_num, rate_den = num / (nw[1] - nw[0] + 1), den / (dw[1] - dw[0] + 1)
            v = int((den == 0 and num > 0) or (den > 0 and rate_num / rate_den >= f["threshold"]))
        elif k == "cluster_count_ge":
            lo_d, hi_d = f["window"]
            hits = []
            for pre in f["clusters"].values():
                first = next((r for r in res if r.get("resourceType") == "Condition" and has_icd_prefix(r, pre)
                              and off(r) is not None and lo_d <= off(r) <= hi_d), None)
                if first is not None:
                    hits.append(first)
            v = int(len(hits) >= f["threshold"])
            ev = hits if v else []
        elif k == "derived_count_ge":
            derived.append(f)
            continue
        values[fid], evidence[fid] = v, ev
    for f in derived:
        parts = [g["id"] for g in model["features"]
                 if g.get("group") == f["of_group"] and g["kind"] != "derived_count_ge" and values.get(g["id"], 0)]
        values[f["id"]] = int(len(parts) >= f["threshold"])
        evidence[f["id"]] = [r for g in parts for r in evidence[g][:1]] if values[f["id"]] else []

    score = model["intercept"] + sum(f["weight"] * values[f["id"]] for f in model["features"])
    prob = calibrate(score, model["calibration"]["points"])
    band = next(b["name"] for b in model["risk_bands"] if prob <= b["max_probability"])
    # nested thresholds (same definition, different threshold) show as one driver: the highest
    # threshold present, carrying the summed contribution
    shown = {}
    for f in model["features"]:
        if not values[f["id"]] or f["weight"] == 0:
            continue
        key = nest_key(f) if "threshold" in f else f["id"]
        c = shown.get(key)
        if c is None:
            shown[key] = {"f": f, "contribution": f["weight"]}
        else:
            c["contribution"] += f["weight"]
            if f["threshold"] > c["f"]["threshold"]:
                c["f"] = f
    contrib = sorted(({"id": c["f"]["id"], "label": c["f"].get("label", c["f"]["id"]), "group": c["f"].get("group"),
                       "contribution": c["contribution"],
                       "evidence": [{"resourceType": r["resourceType"], "id": r.get("id"), "date": str(resource_date(r))}
                                    for r in evidence[c["f"]["id"]]]}
                      for c in shown.values()), key=lambda c: -c["contribution"])
    return {"status": "scored", "index_date": str(day0), "score": score, "probability": prob, "band": band,
            "times_average": prob / model["reference"]["cohort_base_rate"], "features": values, "drivers": contrib}


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("model"); ap.add_argument("bundle"); ap.add_argument("--as-of")
    ap.add_argument("--unavailable", default="", help="comma-separated resource types whose search failed")
    a = ap.parse_args()
    out = score_bundle(json.load(open(a.model)), json.load(open(a.bundle)), _date(a.as_of) if a.as_of else None,
                       [t for t in a.unavailable.split(",") if t])
    print(json.dumps(out, indent=1, default=str))
