"""Synthetic FHIR R4 patients for the demo and the scorer test vectors (no real data).

Writes model/test_vectors/bundles/<name>.json and, for a given model file, the reference
scorer's output to model/test_vectors/expected/<model_id>/<name>.json.
Usage: python3 model/test_vectors/make_bundles.py [model/longcovid.json]
"""

from __future__ import annotations

import json
import os
import sys
import uuid
import datetime as dt

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "reference"))
from score_fhir import score_bundle  # noqa: E402

ICD10 = "http://hl7.org/fhir/sid/icd-10-cm"
SNOMED = "http://snomed.info/sct"
LOINC = "http://loinc.org"
RXNORM = "http://www.nlm.nih.gov/research/umls/rxnorm"
CPT = "http://www.ama-assn.org/go/cpt"
AS_OF = "2024-06-01"
# fullUrls are RFC 4122 name-based UUIDs of "<resourceType>/<id>", so they are valid urn:uuid values and stable
UUID_NAMESPACE = uuid.UUID("6f1c2b1e-8d0a-5c9e-9a57-4b1d2f3e6a10")


def full_url(r):
    return f"urn:uuid:{uuid.uuid5(UUID_NAMESPACE, r['resourceType'] + '/' + r['id'])}"


def clean(v):
    """FHIR JSON has no null values and no empty strings, arrays, or objects: drop them."""
    if isinstance(v, dict):
        out = {k: clean(x) for k, x in v.items()}
        return {k: x for k, x in out.items() if x not in (None, "", [], {})}
    if isinstance(v, list):
        return [x for x in (clean(y) for y in v) if x not in (None, "", [], {})]
    return v


class Chart:
    def __init__(self, pid, gender, birth, address=None):
        self.pid, self.entries, self.n = pid, [], 0
        p = {"resourceType": "Patient", "id": pid, "gender": gender, "birthDate": birth,
             "name": [{"family": "Synthetic", "given": [pid.capitalize()]}]}
        if birth is None:
            del p["birthDate"]
        if address:
            p["address"] = [address]
        self.add(p)

    def add(self, r):
        r = clean(r)
        self.entries.append({"fullUrl": full_url(r), "resource": r})
        return r

    def _id(self, kind):
        self.n += 1
        return f"{self.pid}-{kind}-{self.n}"

    def encounter(self, date, cls="AMB"):
        return self.add({"resourceType": "Encounter", "id": self._id("enc"), "status": "finished",
                         "class": {"system": "http://terminology.hl7.org/CodeSystem/v3-ActCode", "code": cls},
                         "subject": {"reference": f"Patient/{self.pid}"}, "period": {"start": date}})

    def condition(self, date, code, display, system=ICD10, verification=None):
        r = {"resourceType": "Condition", "id": self._id("cond"),
             "clinicalStatus": {"coding": [{"code": "active"}]},
             "code": {"coding": [{"system": system, "code": code, "display": display}], "text": display},
             "subject": {"reference": f"Patient/{self.pid}"}, "onsetDateTime": date, "recordedDate": date}
        if verification:
            r["verificationStatus"] = {"coding": [{"code": verification}]}
        if date is None:   # undated: no onset or recorded date
            del r["onsetDateTime"], r["recordedDate"]
        return self.add(r)

    def procedure(self, date, code, display):
        return self.add({"resourceType": "Procedure", "id": self._id("proc"), "status": "completed",
                         "code": {"coding": [{"system": CPT, "code": code, "display": display}], "text": display},
                         "subject": {"reference": f"Patient/{self.pid}"}, "performedDateTime": date})

    def lab(self, date, loinc, display, value, unit):
        return self.add({"resourceType": "Observation", "id": self._id("obs"), "status": "final",
                         "category": [{"coding": [{"code": "laboratory"}]}],
                         "code": {"coding": [{"system": LOINC, "code": loinc, "display": display}], "text": display},
                         "subject": {"reference": f"Patient/{self.pid}"}, "effectiveDateTime": date,
                         "valueQuantity": {"value": value, "unit": unit}})

    def med(self, date, rxcui, display):
        return self.add({"resourceType": "MedicationRequest", "id": self._id("med"), "status": "active",
                         "intent": "order",
                         "medicationCodeableConcept": {"coding": [{"system": RXNORM, "code": rxcui, "display": display}],
                                                       "text": display},
                         "subject": {"reference": f"Patient/{self.pid}"}, "authoredOn": date})

    def bundle(self):
        return {"resourceType": "Bundle", "type": "collection", "entry": self.entries}


def baseline(c, dates=("2023-02-10", "2023-06-15", "2023-10-20")):
    for d in dates:
        c.encounter(d)


def patients():
    out = {}
    m = Chart("maria", "female", "1980-03-02")          # should score high
    baseline(m)
    m.condition("2023-06-15", "J45.909", "Asthma, unspecified, uncomplicated")
    m.condition("2024-01-08", "U07.1", "COVID-19"); m.encounter("2024-01-08")
    m.encounter("2024-01-10", "EMER"); m.lab("2024-01-10", "48065-7", "Fibrin D-dimer FEU", 0.4, "ug/mL")
    for d, code, disp in [("2024-02-20", "R53.83", "Other fatigue"), ("2024-02-20", "R00.2", "Palpitations"),
                          ("2024-02-20", "U07.1", "COVID-19"), ("2024-03-12", "Z86.16", "Personal history of COVID-19"),
                          ("2024-03-05", "R41.840", "Attention and concentration deficit"),
                          ("2024-03-25", "R06.02", "Shortness of breath"), ("2024-03-25", "R07.89", "Other chest pain")]:
        if d not in {e["resource"].get("period", {}).get("start") for e in m.entries}:
            m.encounter(d)
        m.condition(d, code, disp)
    m.lab("2024-02-20", "1988-5", "C reactive protein", 4.1, "mg/L")
    m.procedure("2024-03-27", "71275", "CT angiography, chest")
    m.procedure("2024-03-01", "93306", "Echocardiography, transthoracic, complete")
    m.procedure("2024-03-10", "93224", "External electrocardiographic recording up to 48 hours")
    m.med("2024-03-12", "8787", "propranolol")
    m.lab("2024-02-20", "3016-3", "Thyrotropin", 1.8, "mIU/L")
    out["maria"] = m

    j = Chart("james", "male", "1975-07-19")            # should score low
    baseline(j)
    j.condition("2024-01-05", "U07.1", "COVID-19"); j.encounter("2024-01-05")
    j.encounter("2024-02-01"); j.condition("2024-02-01", "R05.9", "Cough, unspecified")
    out["james"] = j

    r = Chart("rosa", "female", "1968-11-30")           # already coded: not scored
    baseline(r)
    r.condition("2024-01-08", "U07.1", "COVID-19"); r.encounter("2024-01-08")
    r.encounter("2024-04-15"); r.condition("2024-04-15", "U09.9", "Post COVID-19 condition, unspecified")
    out["rosa"] = r

    lee = Chart("lee", "male", "1990-05-05")            # no COVID: not scored
    baseline(lee)
    out["lee"] = lee

    nora = Chart("nora", "female", "1985-09-09")        # no baseline encounters: not scored
    nora.condition("2024-01-08", "U07.1", "COVID-19"); nora.encounter("2024-01-08")
    out["nora"] = nora

    dana = Chart("dana", "female", "1972-04-14",        # Lyme demo (Dutchess County, NY)
                 {"city": "Poughkeepsie", "state": "NY", "postalCode": "12601",
                  "district": "Dutchess County", "country": "US"})
    baseline(dana)
    # April: an urgent care visit for a bite and a rash after a hike, treated with a short course of doxycycline
    # but not coded or tested as Lyme disease
    dana.encounter("2024-04-15"); dana.condition("2024-04-15", "W57.XXXA", "Bitten or stung by nonvenomous insect and other nonvenomous arthropods, initial encounter")
    dana.condition("2024-04-15", "R21", "Rash and other nonspecific skin eruption")
    dana.med("2024-04-15", "1649988", "doxycycline hyclate 100 MG Oral Capsule")
    dana.encounter("2024-05-20"); dana.condition("2024-05-20", "M25.561", "Pain in right knee")
    dana.encounter("2024-05-28"); dana.condition("2024-05-28", "G51.0", "Bell's palsy")
    out["dana"] = dana

    # Chronic fatigue (ME/CFS) card patients; day 0 is the scoring date (AS_OF)
    elena = Chart("elena", "female", "1986-09-14")       # long fatigue work-up, never coded: should score high
    for d in ["2019-11-04", "2020-05-12", "2020-10-02", "2021-03-15", "2021-09-20", "2022-02-08", "2022-08-30",
              "2023-01-17", "2023-05-09", "2023-09-26", "2024-01-22", "2024-04-30"]:
        elena.encounter(d)
    elena.condition("2019-11-04", "B27.90", "Infectious mononucleosis, unspecified without complication")
    for d, code, disp in [("2020-05-12", "R53.83", "Other fatigue"), ("2020-10-02", "G47.9", "Sleep disorder, unspecified"),
                          ("2021-03-15", "R41.840", "Attention and concentration deficit"), ("2021-09-20", "M79.10", "Myalgia, unspecified site"),
                          ("2022-02-08", "R42", "Dizziness and giddiness"), ("2022-08-30", "R00.2", "Palpitations"),
                          ("2023-01-17", "K58.9", "Irritable bowel syndrome without diarrhea"), ("2023-05-09", "R53.83", "Other fatigue"),
                          ("2024-01-22", "R53.81", "Other malaise"), ("2024-04-30", "R53.83", "Other fatigue")]:
        elena.condition(d, code, disp)
    elena.lab("2020-05-12", "3016-3", "Thyrotropin [Units/volume] in Serum or Plasma", 1.8, "m[IU]/L")
    elena.lab("2020-05-12", "2276-4", "Ferritin [Mass/volume] in Serum or Plasma", 42, "ng/mL")
    elena.lab("2021-03-15", "2132-9", "Cobalamin (Vitamin B12) [Mass/volume] in Serum or Plasma", 510, "pg/mL")
    elena.procedure("2022-09-14", "93660", "Tilt table evaluation")
    elena.encounter("2022-09-28"); elena.condition("2022-09-28", "G90.A", "Postural orthostatic tachycardia syndrome [POTS]")
    elena.med("2022-09-28", None, "midodrine hydrochloride 5 MG Oral Tablet")
    elena.procedure("2023-02-21", "95810", "Polysomnography")
    elena.med("2023-05-09", None, "modafinil 100 MG Oral Tablet")
    out["elena"] = elena

    omar = Chart("omar", "male", "1975-01-30")           # routine care: should score typical
    for d in ["2022-03-01", "2023-03-07", "2024-03-12"]:
        omar.encounter(d)
    omar.condition("2023-03-07", "I10", "Essential (primary) hypertension")
    out["omar"] = omar

    grace = Chart("grace", "female", "1979-07-21")       # already coded: not scored
    baseline(grace)
    grace.condition("2022-11-03", "G93.32", "Myalgic encephalomyelitis/chronic fatigue syndrome"); grace.encounter("2022-11-03")
    out["grace"] = grace

    # Fibromyalgia card patients; day 0 is the scoring date (AS_OF)
    sofia = Chart("sofia", "female", "1979-04-22")       # years of widespread pain, negative rheumatology work-up, never coded
    for d in ["2020-03-09", "2020-11-16", "2021-06-21", "2022-01-24", "2022-08-15", "2023-03-13", "2023-07-10",
              "2023-10-02", "2023-12-11", "2024-02-05", "2024-04-15"]:
        sofia.encounter(d)
    for d, code, disp in [("2020-03-09", "M54.2", "Cervicalgia"),
                          ("2020-11-16", "M54.50", "Low back pain, unspecified"),
                          ("2021-06-21", "M26.629", "Arthralgia of temporomandibular joint, unspecified side"),
                          ("2022-01-24", "R51.9", "Headache, unspecified"),
                          ("2022-08-15", "K58.9", "Irritable bowel syndrome without diarrhea"),
                          ("2023-03-13", "G47.00", "Insomnia, unspecified"),
                          ("2023-07-10", "F41.1", "Generalized anxiety disorder"),
                          ("2024-02-05", "R53.83", "Other fatigue")]:
        sofia.condition(d, code, disp)
    sofia.lab("2022-01-24", "11572-5", "Rheumatoid factor [Units/volume] in Serum or Plasma", 8, "[IU]/mL")
    sofia.lab("2022-01-24", "32218-0", "Cyclic citrullinated peptide Ab [Units/volume] in Serum by Immunoassay", 3, "U/mL")
    sofia.lab("2022-01-24", "5048-4", "Nuclear Ab [Titer] in Serum", 40, "{titer}")
    sofia.lab("2022-01-24", "4537-7", "Erythrocyte sedimentation rate by Westergren method", 12, "mm/h")
    sofia.lab("2022-01-24", "1988-5", "C reactive protein [Mass/volume] in Serum or Plasma", 2.1, "mg/L")
    sofia.lab("2022-01-24", "2157-6", "Creatine kinase [Enzymatic activity/volume] in Serum or Plasma", 96, "U/L")
    sofia.lab("2022-01-24", "3016-3", "Thyrotropin [Units/volume] in Serum or Plasma", 2.2, "m[IU]/L")
    sofia.procedure("2020-11-23", "97162", "Physical therapy evaluation, moderate complexity")
    sofia.med("2020-03-09", None, "naproxen 500 MG Oral Tablet")
    sofia.med("2020-11-16", None, "cyclobenzaprine hydrochloride 10 MG Oral Tablet")
    sofia.med("2021-06-21", None, "tizanidine 4 MG Oral Tablet")
    sofia.med("2022-08-15", None, "gabapentin 300 MG Oral Capsule")
    sofia.med("2023-03-13", None, "trazodone hydrochloride 50 MG Oral Tablet")
    sofia.med("2023-07-10", None, "duloxetine 30 MG Delayed Release Oral Capsule")
    out["sofia"] = sofia

    # Eligibility boundary patients for the Long COVID card (index 2024-01-08 unless noted; scored as of AS_OF)
    def post_covid(c, index="2024-01-08", baseline_dates=("2023-02-10", "2023-06-15", "2023-10-20")):
        baseline(c, baseline_dates)
        c.condition(index, "U07.1", "COVID-19"); c.encounter(index)
        c.encounter("2024-02-20"); c.condition("2024-02-20", "R53.83", "Other fatigue")
        return c

    priya = post_covid(Chart("priya", "female", "1977-08-21"))   # Long COVID code before the COVID-19 index: not scored
    priya.encounter("2023-11-20"); priya.condition("2023-11-20", "U09.9", "Post COVID-19 condition, unspecified")
    out["priya"] = priya

    sam = post_covid(Chart("sam", "male", "1969-12-03"))   # Long COVID code (SNOMED) on the index date: not scored
    sam.condition("2024-01-08", "1325161000000102", "Post-COVID-19 syndrome", system=SNOMED)
    out["sam"] = sam

    theo = post_covid(Chart("theo", "male", "1988-02-11"))   # Long COVID code on day 90, the landmark day: not scored
    theo.encounter("2024-04-07"); theo.condition("2024-04-07", "U09.9", "Post COVID-19 condition, unspecified")
    out["theo"] = theo

    yara = post_covid(Chart("yara", "female", "1991-06-30"))   # undated Long COVID code: not scored
    yara.condition(None, "U09.9", "Post COVID-19 condition, unspecified")
    out["yara"] = yara

    vera = post_covid(Chart("vera", "female", "1959-05-17"), index="2023-01-10",   # COVID-19 508 days before, past day 455: not scored
                      baseline_dates=("2022-02-14", "2022-06-20", "2022-11-01"))
    vera.encounter("2023-11-14")
    out["vera"] = vera

    # partial dates, a pre-era infection, and refuted or future Long COVID codes: should score (index 2023-12-05)
    will = Chart("will", "male", "1983")
    baseline(will, ("2023-01-17", "2023-05-02", "2023-09-26"))
    will.condition("2021-03-15", "U07.1", "COVID-19")   # before index_event.earliest_date: not the index
    will.condition("2023-12-05", "U07.1", "COVID-19"); will.encounter("2023-12-05")
    will.encounter("2024-01"); will.condition("2024-01", "R06.02", "Shortness of breath")   # read as 2024-01-01
    will.condition("2024-03-20", "U09.9", "Post COVID-19 condition, unspecified", verification="refuted")
    will.condition("2024-07-15", "U09.9", "Post COVID-19 condition, unspecified")   # after the scoring date
    out["will"] = will

    # Eligibility boundary patients for every model (age on day 0)
    uma = post_covid(Chart("uma", "female", None))   # no birth date: not scored by any model
    out["uma"] = uma

    kai = post_covid(Chart("kai", "male", "2007-02-14"))   # 16 at the COVID-19 index, 17 on the scoring date: not scored by any model
    out["kai"] = kai
    return out


if __name__ == "__main__":
    os.makedirs(os.path.join(HERE, "bundles"), exist_ok=True)
    charts = patients()
    for name, c in charts.items():
        json.dump(c.bundle(), open(os.path.join(HERE, "bundles", f"{name}.json"), "w"), indent=1)
    if len(sys.argv) > 1:
        model = json.load(open(sys.argv[1]))
        odir = os.path.join(HERE, "expected", model["model_id"] + "-" + model["version"])
        os.makedirs(odir, exist_ok=True)
        for name in charts:
            b = json.load(open(os.path.join(HERE, "bundles", f"{name}.json")))
            out = score_bundle(model, b, dt.date.fromisoformat(AS_OF))
            out["as_of"] = AS_OF
            json.dump(out, open(os.path.join(odir, f"{name}.json"), "w"), indent=1, default=str)
            print(f"{name:6s} {out['status']:10s} {out.get('band', out.get('reason', ''))} "
                  f"{round(out['probability'], 4) if 'probability' in out else ''}")
