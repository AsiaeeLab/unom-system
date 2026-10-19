"""Tests for the reference scorer: index-event logic, FHIR dates, eligibility, record status, and data availability.

The same cases are ported to web/test/scorer.test.js, so the JavaScript scorer is held to the same rules.
Run: python3 model/reference/test_score_fhir.py
"""
import copy
import datetime as dt
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import score_fhir as s  # noqa: E402

LOINC = ("94500-6",)
D = dt.date.fromisoformat


def obs(text=None, interp=None, date="2024-01-02"):
    o = {"resourceType": "Observation", "code": {"coding": [{"system": s.LOINC, "code": "94500-6"}]},
         "effectiveDateTime": date}
    if text is not None:
        o["valueCodeableConcept"] = {"text": text}
    if interp:
        o["interpretation"] = [{"coding": [{"system": "http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation", "code": interp}]}]
    return o


cond = {"resourceType": "Condition", "code": {"coding": [{"system": s.ICD10, "code": "U07.1"}]}, "onsetDateTime": "2024-01-05"}

# ---- index event from Conditions and (when enabled) positive tests
for text in ("Not detected", "NOT DETECTED", "Negative", "None detected", "Undetected", "non-reactive"):
    assert not s.test_is_positive(obs(text)), text
    assert s.find_index([obs(text)], True, LOINC) is None, text
assert not s.test_is_positive(obs("Detected", interp="NEG"))
for text in ("Detected", "Positive", "SARS-CoV-2 RNA detected"):
    assert s.test_is_positive(obs(text)), text
assert s.test_is_positive(obs(interp="POS"))
assert s.find_index([obs("Detected")], False, LOINC) is None, "tests ignored unless enabled"
assert str(s.find_index([obs("Detected")], True, LOINC)) == "2024-01-02"
assert str(s.find_index([cond, obs("Detected")], False, LOINC)) == "2024-01-05"
assert str(s.find_index([cond, obs("Not detected", date="2024-01-01")], True, LOINC)) == "2024-01-05"
assert s.find_index([cond], False, LOINC, D("2024-01-06")) is None, "index on or after the earliest date only"
assert str(s.find_index([cond], False, LOINC, D("2024-01-05"))) == "2024-01-05"
assert not s.test_is_positive({**obs(), "valueString": None}), "a null valueString is empty text, not 'None'"

# ---- FHIR dates: full, partial (YYYY, YYYY-MM), and invalid values never raise
assert s.fhir_date("2024-03-10T23:30:00-07:00") == D("2024-03-10")
assert s.fhir_date("2024") == D("2024-01-01") and s.fhir_date("2024", birth=True) == D("2024-07-01")
assert s.fhir_date("2024-03") == D("2024-03-01") and s.fhir_date("2024-03", birth=True) == D("2024-03-15")
for bad in ("2024-02-30", "2024-13", "0000", "0000-01-01", "2024-03T10:00:00Z", "20240310", "2024-3-1", "garbage", "", None, True,
            2024, ["2024"], {"start": "2024"}):
    assert s.fhir_date(bad) is None, bad
assert s.fhir_date("2024-02-29") == D("2024-02-29")
assert s.resource_date({"onsetDateTime": "not a date", "recordedDate": "2024-01-01"}) == D("2024-01-01"), \
    "an unreadable date falls through to the next date field"
assert s.resource_date({"onsetDateTime": "2024-05"}) == D("2024-05-01")
assert s.resource_date({"onsetDateTime": "garbage"}) is None
try:
    s._date("2024-03")
    raise AssertionError("as_of must be a full date")
except ValueError:
    pass

# ---- eligibility (synthetic charts against the deployed model files)
REPO = os.path.dirname(os.path.dirname(HERE))
LC = json.load(open(os.path.join(REPO, "model", "longcovid.json")))
CF = json.load(open(os.path.join(REPO, "model", "chronicfatigue.json")))
assert LC["index_event"]["earliest_date"] == "2021-07-02"
assert set(LC["exclusion"]["condition_codes"]["snomed"]) == {"1119303003", "1119304009", "1325161000000102"}, \
    "the Long COVID exclusion lists every SNOMED concept the training cohort excluded (workbench/src/t01_cohort.py)"
AS_OF = D("2024-06-01")


def condition(date, code, system=s.ICD10, **extra):
    r = {"resourceType": "Condition", "code": {"coding": [{"system": system, "code": code}]}, **extra}
    if date:
        r["onsetDateTime"] = date
    return r


def encounter(date, **extra):
    return {"resourceType": "Encounter", "status": "finished", "class": {"code": "AMB"}, "period": {"start": date}, **extra}


def chart(*extra, birth="1980-03-02", covid="2024-01-08"):
    p = {"resourceType": "Patient", "id": "p", "gender": "female"}
    if birth is not None:
        p["birthDate"] = birth
    res = [p, encounter("2023-06-15"), encounter("2023-10-20")]
    if covid:
        res.append(condition(covid, "U07.1"))
    return {"resourceType": "Bundle", "type": "collection", "entry": [{"resource": r} for r in res + list(extra)]}


def run(bundle, model=LC, as_of=AS_OF, unavailable=()):
    return s.score_bundle(model, bundle, as_of, unavailable)


ALREADY = "a Long COVID diagnosis is already recorded"
assert run(chart())["status"] == "scored"
for when in ("2023-12-01", "2024-01-08", "2024-04-07", "2024-05-01"):   # before, same day, day 90, after day 90
    assert run(chart(condition(when, "U09.9")))["reason"] == ALREADY, when
assert run(chart(condition("2024-03-01", "1325161000000102", s.SNOMED)))["reason"] == ALREADY
assert run(chart(condition(None, "U09.9")))["reason"] == ALREADY, "an undated Long COVID code counts as recorded"
assert run(chart(condition("2024-07-01", "U09.9")))["status"] == "scored", "codes after the scoring date are ignored"
refuted = {"verificationStatus": {"coding": [{"code": "refuted"}]}}
assert run(chart(condition("2024-03-01", "U09.9", **refuted)))["status"] == "scored", "refuted codes are ignored"
error = {"verificationStatus": {"coding": [{"code": "entered-in-error"}]}}
assert run(chart(condition("2024-03-01", "U09.9", **error)))["status"] == "scored"

# index: first U07.1 on or after the model's earliest date, and on or before the scoring date
r = run(chart(covid="2021-03-10"))
assert r["status"] == "not_scored" and r["reason"].startswith("no documented COVID-19 index event on or after 2021-07-02"), r
assert run(chart(condition("2021-03-10", "U07.1")))["index_date"] == "2024-01-08", "pre-era infection skipped"
assert run(chart(covid="2024-07-01"))["reason"] == "no documented COVID-19 index event", "future index ignored"
assert run(chart(condition("2021-03-10", "U07.1")), model={**LC, "index_event": {
    k: v for k, v in LC["index_event"].items() if k != "earliest_date"}})["status"] == "not_scored", \
    "without earliest_date the 2021 code is the index, which is past day 455"

# landmark and time window
assert run(chart(), as_of=D("2024-04-06"))["reason"] == "fewer than 90 days since the COVID-19 index"   # day 89
assert run(chart(), as_of=D("2024-04-07"))["status"] == "scored"                                      # day 90
assert run(chart(), as_of=D("2025-04-06"))["status"] == "scored"                                      # day 454
assert run(chart(), as_of=D("2025-04-07"))["status"] == "scored"                                      # day 455
r = run(chart(), as_of=D("2025-04-08"))                                                               # day 456
assert r["reason"] == "more than 455 days since the COVID-19 index (outside the model's time window)", r

# age and birth date
assert run(chart(birth=None))["reason"] == "birth date missing or unusable (age is required)"
assert run(chart(birth="03/02/1980"))["reason"] == "birth date missing or unusable (age is required)"
assert run(chart(birth="2006-01-09"))["reason"] == "under 18 at the COVID-19 index (the model covers adults)"
# age is days / 365.25, as in the training cohort, so an 18th birthday with 4 leap days in between is 17.999
assert run(chart(birth="2006-01-08"))["reason"].startswith("under 18"), "18th birthday on the index date"
assert run(chart(birth="2006-01-07"))["status"] == "scored", "one day later, 18.001"
r = run(chart(birth="1980"))
assert r["status"] == "scored" and r["features"]["age_40_49"] == 1, "a birth year is read as July 1"
assert run(chart(birth="2006"))["reason"].startswith("under 18"), "2006-07-01 is under 18 on 2024-01-08"

# scoring-date model: age on the scoring date, undated and refuted target codes
assert run(chart(birth="2006-06-02"), CF)["reason"] == "under 18 on the scoring date (the model covers adults)"
assert run(chart(birth="2006-06-01"), CF)["status"] == "scored", "18th birthday with 5 leap days in between: 18.001"
assert run(chart(birth=None), CF)["reason"] == "birth date missing or unusable (age is required)"
assert run(chart(condition(None, "G93.32")), CF)["reason"] == CF["exclusion"]["reason"]
assert run(chart(condition("2023-01-01", "G93.32", **refuted)), CF)["status"] == "scored"
assert run(chart(condition("2024-06-02", "G93.32")), CF)["status"] == "scored", "a code after the scoring date is ignored"

# record status: entered-in-error encounters are not history
b = chart()
for e in b["entry"]:
    if e["resource"]["resourceType"] == "Encounter":
        e["resource"]["status"] = "entered-in-error"
assert run(b)["reason"] == "no encounters in the year before COVID-19 (insufficient history)"

# partial dates on records: earliest compatible day, and they still count
b = chart(condition("2024-03", "R53.83"), encounter("2024-03"))
r = run(b)
assert r["status"] == "scored" and r["features"]["sym_any_fatigue"] == 1, r["features"]["sym_any_fatigue"]

# null text in a medication or result never raises
med = {"resourceType": "MedicationRequest", "status": "active", "authoredOn": "2024-02-01",
       "medicationCodeableConcept": {"text": None, "coding": [{"system": s.RXNORM, "display": None}]}}
assert run(chart(med))["status"] == "scored"

# unavailable data: a failed search is never read as an empty record
r = run(chart(), unavailable=["Condition"])
assert r == {"status": "could_not_score", "reason": "could not score: Condition unavailable", "unavailable": ["Condition"]}, r
r = run(chart(), unavailable=["Procedure", "Observation", "DiagnosticReport"])
assert r == {"status": "could_not_score", "reason": "could not score: Observation, Procedure unavailable",
             "index_date": "2024-01-08", "unavailable": ["Observation", "Procedure"]}, r
assert run(chart(covid=None), unavailable=["Observation"])["reason"] == "no documented COVID-19 index event", \
    "eligibility read from available resources is still reported"
assert run(chart(), unavailable=["Patient"])["status"] == "could_not_score"
assert run(chart(), unavailable=["DocumentReference"])["status"] == "scored", "resources a model does not read do not matter"
tests_on = copy.deepcopy(LC)
tests_on["index_event"]["use_positive_tests"] = True
assert run(chart(), tests_on, unavailable=["Observation"]) == {
    "status": "could_not_score", "reason": "could not score: Observation unavailable", "unavailable": ["Observation"]}
print("ALL CHECKS PASSED")
