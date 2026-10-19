#!/usr/bin/env python3
"""Write docs/CLINICIAN_INTERFACE.md, the one-page contract between the models and the clinician interface.

For each supported condition: what produces the card, the FHIR data it reads, the patient follow-up
questions, the clinician checklist, and how missing data are handled, with links to the files that hold
each piece. Everything that can change is read from those files, so the page goes stale only when this
script is not rerun; `npm test` in web/ runs it with --check and fails if the page differs.

  inputs   model/longcovid.json, model/chronicfatigue.json, model/fibromyalgia.json
           web/web/athena/cards.js (MODEL_CARDS, LYME_NEXT_STEPS), web/web/athena/lyme-rule.js
           web/web/patient/instruments.js (RECOVER, PEM, PCFS, CHANGE, CHECKS)
           model/test_vectors/expected/<id>-<version>/
  output   docs/CLINICIAN_INTERFACE.md

Usage: python3 analysis/build_clinician_interface.py [--check]
"""

from __future__ import annotations

import json
import subprocess
import sys
from collections import Counter
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
OUT = REPO / "docs" / "CLINICIAN_INTERFACE.md"
MODELS = {"longcovid": "model/longcovid.json", "chronicfatigue": "model/chronicfatigue.json",
          "fibromyalgia": "model/fibromyalgia.json", "endometriosis": "model/endometriosis.json",
          "lyme": "model/lyme.json", "lupus": "model/lupus.json", "migraine": "model/migraine.json",
          "depression": "model/depression.json", "anxiety": "model/anxiety.json"}
GUIDE_ANCHOR = {"longcovid": "long-covid", "chronicfatigue": "chronic-fatigue", "fibromyalgia": "fibromyalgia",
                "endometriosis": "endometriosis", "lyme": "lyme", "lupus": "lupus", "migraine": "migraine",
                "depression": "depression", "anxiety": "anxiety"}

CODE_SYSTEMS = {"icd10cm_prefix": "ICD-10-CM", "loinc": "LOINC", "cpt": "CPT", "rxcui": "RxNorm",
                "rxnorm_ingredient_names": "RxNorm ingredient name (fallback)", "snomed": "SNOMED CT"}
DERIVED_KINDS = {
    "age_band": "Patient.birthDate (age on day 0)",
    "sex": "Patient.gender",
    "encounter_any": "Encounter.class",
    "encounter_count_ge": "Encounter.class",
    "encounter_rate_ratio_ge": "Encounter.class",
    "cluster_count_ge": "Condition (ICD-10-CM clusters)",
    "derived_count_ge": "other features (count within a group)",
}

# Which parts of the one patient questionnaire each card uses. The app asks everyone the same
# questions; parts are skipped or left unscored by the rules in web/web/patient/instruments.js.
FOLLOW_UP = {
    "longcovid": ["RECOVER", "PEM", "PCFS", "CHANGE", "CHECK_longcovid"],
    "chronicfatigue": ["PEM", "PCFS", "CHECK_mecfs"],
    "fibromyalgia": ["CHECK_fibro"],
    "endometriosis": [],
    "lyme": ["CHECK_lyme"],
    "lupus": [],
    "migraine": [],
    "depression": ["CHECK_phq9"],
    "anxiety": ["CHECK_gad7"],
}
PARTS = ["RECOVER", "PEM", "PCFS", "CHANGE", "CHECK_longcovid", "CHECK_mecfs", "CHECK_fibro", "CHECK_lyme",
         "CHECK_phq9", "CHECK_gad7"]
PART_NOTES = {
    "RECOVER": "{n} yes/no symptoms, points add up; 11 or more is the published \"likely\" range, given only when "
               "every symptom is answered. Scored only if the patient has had, or may have had, COVID-19. The app counts fatigue, brain fog, and chest pain without "
               "the index's severity scores and says so.",
    "PEM": "{n} items, frequency and severity 0 to 4; positive if any item has both 2 or higher. Plus an unscored "
           "duration item.",
    "PCFS": "One grade, 0 to 4. Skipped when the patient answers No to having had COVID-19.",
    "CHANGE": "{n} unscored items for the clinician; the wording follows the COVID-19 answer.",
    "CHECK_longcovid": "Optional self-check (Part E): one question, whether symptoms have lasted 3 months or longer "
                       "after COVID-19 (NASEM 2024 time criterion). Offered only after a Yes or Not sure to COVID-19.",
    "CHECK_mecfs": "Optional self-check (Part E): {n} yes/no/not sure questions for the IOM 2015 core symptoms; "
                   "post-exertional malaise comes from the DePaul screen. Result: matches, does not match, or not "
                   "finished.",
    "CHECK_fibro": "Optional self-check (Part E): pain in 19 areas in the past 7 days (Widespread Pain Index), 3 "
                   "severity items and 3 past-6-month items (Symptom Severity Scale), and a 3-month duration item. "
                   "Result follows the 2016 rule (WPI 7+ and SSS 5+, or WPI 4 to 6 and SSS 9+; pain in 4 of 5 "
                   "regions; 3 months), with WPI and SSS exported.",
    "CHECK_lyme": "Optional (Part E): {n} exposure questions (tick attached, time outdoors where Lyme disease is "
                  "common, expanding rash), written for the app from CDC guidance. Not scored.",
    "CHECK_phq9": "Optional (Part E): the published PHQ-9, {n} items over the last 2 weeks, each 0 to 3, plus its "
                  "unscored difficulty question. Total 0 to 27 and the published severity (0 to 4 none-minimal, 5 "
                  "to 9 mild, 10 to 14 moderate, 15 to 19 moderately severe, 20 to 27 severe), given only when all "
                  "9 items are answered. Item 9 (thoughts of being better off dead or of self-harm) answered other "
                  "than Not at all shows the patient the 988 Suicide & Crisis Lifeline at once and puts a notice at "
                  "the top of From the patient. Shown, not combined with any chart estimate.",
    "CHECK_gad7": "Optional (Part E): the published GAD-7, {n} items over the last 2 weeks, each 0 to 3. Total 0 to "
                  "21 with the published cutpoints 5, 10, and 15 for mild, moderate, and severe anxiety, given only "
                  "when all 7 items are answered. Shown, not combined with any chart estimate.",
}

# Missing data, as implemented, with the place each rule lives. Edit here when the scorer or the app changes;
# a third column holds a planned change only while one is open.
MISSING_MODEL = [
    ("A code, test, procedure, or prescription that is not in the chart",
     "Counted as absent (feature value 0). The models were fit the same way: a feature is the presence of a "
     "matching record in the window, with no imputation."),
    ("Too little history",
     "Not scored, with the reason shown (rules under each condition)."),
    ("Birth date missing or unusable",
     "Not scored: \"birth date missing or unusable (age is required)\". The card says \"No usable birth date on "
     "record\"."),
    ("Patient under 18 on day 0 (the COVID-19 index, or the scoring date)",
     "Not scored: every model covers adults. Age is days / 365.25, as in the training cohorts."),
    ("Patient.gender other than female or missing",
     "The female feature is 0, so the patient is scored like the reference group."),
    ("A FHIR search that fails, is forbidden, or is cut short (pagination limit, next link not followed, total "
     "above the entries returned)",
     "The resource is unavailable, never empty: a model that reads it returns \"could not score: <resource> "
     "unavailable\" (status `could_not_score`), the card says \"Could not score\" and which records could not be "
     "read, and Needs review says that a result is missing. Patient, Condition, and Encounter are checked first; "
     "a resource read only by features is checked after eligibility, so an ineligible chart still says why. "
     "The CDS Hooks service returns one card for the conditions it could not score. Searches with records "
     "hidden by security labels count as readable."),
    ("Partial FHIR dates (YYYY or YYYY-MM)",
     "Accepted. On a record: the first day they allow (January 1, or the first of the month). On "
     "Patient.birthDate: July 1, or the 15th (the training cohort used July 1 when only the year was known). "
     "A date field that is not a valid FHIR date is skipped; the scorer never stops on a chart's dates."),
    ("Records with no usable date",
     "Count in no window and cannot be the COVID-19 index; an undated target diagnosis (for example an undated "
     "U09.9) counts as already recorded, so the card is not scored."),
    ("Records dated after the scoring date",
     "Ignored by every rule and feature (a later Long COVID code does not hide an earlier score)."),
    ("Refuted or entered-in-error records",
     "Ignored: Conditions whose verificationStatus is refuted or entered-in-error, and any record whose status "
     "is entered-in-error."),
    ("Features whose training counts were suppressed (1 to 20)",
     "Left out of the model; only features with every released cell above 20 were eligible."),
]
MISSING_QUESTIONNAIRE = [
    ("RECOVER item not answered",
     "Counts as 0 points, and no \"possible\" or \"likely\" range is given until every symptom is answered: "
     "the app shows the points so far as incomplete (recover.category `incomplete` from version 1.2.0), and the "
     "dashboard recomputes completeness from the answered items, so older files are read the same way. The "
     "exploratory triage rule still counts RECOVER once the points so far reach 11, because more answers can only "
     "add points."),
    ("DSQ-PEM item not answered",
     "Positive as soon as one answered item qualifies; negative only when all 5 are answered."),
    ("PCFS not answered",
     "No grade shown."),
    ("Self-check not chosen or not finished",
     "A check the patient did not choose is not exported. A started check exports its answers; its result is "
     "\"not finished\" until every question it needs is answered (for ME/CFS, also the DePaul screen)."),
    ("PHQ-9 or GAD-7 item not answered",
     "The answered items are exported, but no total or severity is given until every item is answered (the "
     "dashboard says how many were answered). A PHQ-9 item 9 answer other than Not at all is flagged as soon as it "
     "is answered, whether or not the rest are."),
    ("A QuestionnaireResponse that is not ours, or from an unsupported version",
     "Not imported: the canonical URL must be the one below and the version one the dashboard supports."),
    ("A QuestionnaireResponse for another patient",
     "Not imported when its subject names a different patient. Several matching responses: the most recently "
     "authored is shown. A response without a subject (the patient app's hand-off or a file) is attached only "
     "after the clinician confirms the patient."),
]

LINKS = {
    "cards": "web/web/athena/cards.js",
    "scorer": "web/web/shared/scorer.js",
    "reference": "model/reference/score_fhir.py",
    "spec": "docs/interface/model_spec.md",
    "guide": "docs/MODELS_GUIDE.md",
    "instruments": "web/web/patient/instruments.js",
    "questionnaire_spec": "submission/app_questionnaire.md",
    "fhir": "web/web/athena/fhir-data.js",
    "lyme_rule": "web/web/athena/lyme-rule.js",
    "lyme_data": "web/web/data/lyme_county.json",
    "lyme_csv": "opendata/processed/lyme_county_incidence.csv",
    "lupus_rule": "web/web/athena/rule.js",
    "sync": "web/tools/sync_models.sh",
    "builder": "analysis/build_clinician_interface.py",
}


def link(path: str, label: str | None = None) -> str:
    # Relative to docs/, so the links work on GitHub and in an editor.
    return f"[{label or path}](../{path})"


def node_json(js: str) -> dict:
    out = subprocess.run(["node", "--input-type=module", "-e", js], cwd=REPO, check=True,
                         capture_output=True, text=True).stdout
    return json.loads(out)


def load_js() -> dict:
    return node_json(
        "import {MODEL_CARDS, LYME_NEXT_STEPS, LYME_SOURCE, ANSWER_EVIDENCE} from './web/web/athena/cards.js';"
        "import {LYME_FEATURES, LYME_CODED} from './web/web/athena/lyme-rule.js';"
        "import {RECOVER, PEM, PCFS, CHANGE, CHECKS, QUESTIONNAIRE_URL, QUESTIONNAIRE_VERSION, SUPPORTED_QUESTIONNAIRE_VERSIONS} from './web/web/patient/instruments.js';"
        "console.log(JSON.stringify({cards: MODEL_CARDS, answers: ANSWER_EVIDENCE, lymeNext: LYME_NEXT_STEPS, lymeSource: LYME_SOURCE,"
        " lyme: LYME_FEATURES.map(f => ({id: f.id, label: f.label, codes: f.codesNote})), lymeCoded: LYME_CODED,"
        " RECOVER, PEM, PCFS, CHANGE, CHECKS, qUrl: QUESTIONNAIRE_URL, qVersion: QUESTIONNAIRE_VERSION,"
        " qSupported: SUPPORTED_QUESTIONNAIRE_VERSIONS}));"
    )


def fhir_inputs(model: dict) -> list[list[str]]:
    rows: Counter = Counter()
    weighted: Counter = Counter()
    for f in model["features"]:
        if f.get("resource"):
            systems = ", ".join(CODE_SYSTEMS.get(k, k) for k in sorted((f.get("codes") or {}).keys()))
            key = (f["resource"], systems)
        else:
            key = (DERIVED_KINDS.get(f["kind"], f["kind"]), "")
        rows[key] += 1
        weighted[key] += f.get("weight", 0) != 0
    return [[r, s or "n/a", str(rows[(r, s)]), str(weighted[(r, s)])] for (r, s) in sorted(rows)]


def not_scored(key: str, model: dict) -> list[str]:
    out = []
    age = ["the birth date is missing or unusable", "the patient is under 18 on day 0"]
    if model["index_event"].get("type") == "scoring_date":
        out += age
        out.append(f"a code in `exclusion.condition_codes` is dated on or before day 0 or is undated "
                   f"(\"{model['exclusion']['reason']}\")")
        h = model["history_requirement"]
        out.append(f"fewer than {h['min_count']} encounter(s) of class {', '.join(h['encounter_class'])} in window "
                   f"{h['window']} (\"{h['reason']}\")")
    else:
        codes = model["exclusion"]["condition_codes"]
        names = {"icd10cm": "ICD-10-CM", "snomed": "SNOMED CT"}
        listed = "; ".join(f"{names.get(k, k)} {', '.join(v)}" for k, v in codes.items())
        era = model["index_event"].get("earliest_date")
        t = model["target"]
        out += [f"no COVID-19 index event (first Condition coded U07.1{f' on or after {era}' if era else ''}, on or "
                "before the scoring date)"] + age + [
                f"fewer than {t['landmark_days']} days since the index",
                f"more than {t['horizon_days'][1]} days since the index (outside the model's time window)",
                f"a Long COVID code is recorded on or before the scoring date, at any time relative to the index, or "
                f"undated ({listed})",
                "no encounters in windows W0 and W1 (the year before COVID-19)"]
    return out


def expected_dir(model: dict) -> str:
    d = f"model/test_vectors/expected/{model['model_id']}-{model['version']}"
    return d if (REPO / d).is_dir() else ""


def table(header: list[str], rows: list[list[str]]) -> list[str]:
    esc = lambda s: str(s).replace("|", "\\|").replace("\n", " ")
    return ["| " + " | ".join(header) + " |", "|" + "---|" * len(header)] + \
           ["| " + " | ".join(esc(c) for c in r) + " |" for r in rows] + [""]


def render(js: dict) -> str:
    cards = {c["key"]: c for c in js["cards"]}
    models = {k: json.loads((REPO / p).read_text()) for k, p in MODELS.items()}
    inst = {"RECOVER": js["RECOVER"], "PEM": js["PEM"], "PCFS": js["PCFS"], "CHANGE": js["CHANGE"],
            **{f"CHECK_{k}": js["CHECKS"][k] for k in ("longcovid", "mecfs", "fibro", "lyme", "phq9", "gad7")}}
    note = {p: PART_NOTES[p].replace("{n}", str(len(inst[p].get("items") or inst[p].get("options") or []))) for p in inst}
    L = []
    w = L.append

    w("# Clinician interface: supported conditions")
    w("")
    w(f"Generated by {link(LINKS['builder'])} from the files linked below; do not edit by hand. "
      "Rerun it after changing a model file, a card, a rule, or the patient questions; `npm test` in `web/` "
      "fails when this page is out of date. This page is the agreed interface between the models and rules "
      "(Amir) and the clinician and patient front end (Kaveh). Full feature lists, calibration, and validation "
      f"are in {link(LINKS['guide'])}; the model file format is in {link(LINKS['spec'])}.")
    w("")
    w("## At a glance")
    w("")
    rows = []
    for k, m in models.items():
        c = cards[k]
        parts = ", ".join(inst[p]["title"] for p in FOLLOW_UP[k]) or "none specific (the general questions are shown)"
        checklist = ("yes" if c.get("checklist") else
                     {"lyme": f"chart findings from {link(LINKS['lyme_rule'])} and county incidence",
                      "lupus": f"2019 EULAR/ACR criteria with chart evidence from {link(LINKS['lupus_rule'])}"}.get(k, "no"))
        rows.append([c["title"], f"Fitted model {link(MODELS[k], m['model_id'] + ' ' + m['version'])}",
                     m["target"]["label"], parts, checklist])
    L += table(["Condition", "Produced by", "What the card shows", "Patient follow-up (parts of the one questionnaire)",
                "Clinician checklist"], rows)

    w(f"Shared pieces: card text and checklists in {link(LINKS['cards'])} (`MODEL_CARDS`); scorer "
      f"{link(LINKS['scorer'])}, a port of {link(LINKS['reference'])} with test vectors in "
      f"{link('model/test_vectors')}; FHIR reads in {link(LINKS['fhir'])}; model files are copied to "
      f"`web/web/models/` by {link(LINKS['sync'])}.")
    w("")

    for k, m in models.items():
        c = cards[k]
        w(f"## {c['title']}")
        w("")
        w(f"- Model: {link(MODELS[k])}, `{m['model_id']}` version {m['version']}, status `{m['status']}`. "
          f"Card slug `{c['slug']}`, loaded from `{c['url']}`.")
        w(f"- Predicts: {m['target']['label']}. Population: {m['target']['population']}.")
        w(f"- Day 0: {m['index_event']['rule']}.")
        win = ", ".join(f"{n} days {a} to {b}" for n, (a, b) in m["windows"].items())
        w(f"- Windows relative to day 0: {win}.")
        w("- Not scored when: " + "; ".join(not_scored(k, m)) + ". The card says why.")
        w(f"- Features: {len(m['features'])}, of which {sum(f.get('weight', 0) != 0 for f in m['features'])} carry "
          f"a weight; full list in {link(LINKS['guide'], 'the models guide')} (section "
          f"`#{GUIDE_ANCHOR[k]}`).")
        ev = expected_dir(m)
        if ev:
            w(f"- Test patients and expected outputs: {link(ev)}.")
        w("")
        w("FHIR data read by the model:")
        w("")
        L += table(["Resource or field", "Code system", "Features", "With a weight"], fhir_inputs(m))
        w("Patient follow-up questions (" + link(LINKS["instruments"]) + "):")
        w("")
        if FOLLOW_UP[k]:
            for p in FOLLOW_UP[k]:
                w(f"- {inst[p]['title']}. {note[p]}")
        else:
            w("- No condition-specific questions yet; the card relies on the clinician checklist.")
        w("")
        if c.get("checklist"):
            w(f"Clinician checklist (shown, not scored; {c['checklistSource']}):")
            w("")
            for item in c["checklist"]:
                w(f"- {item}")
            w("")
        w("Next steps on the card:")
        w("")
        for s in c["nextSteps"]:
            w(f"- {s}")
        w("")

    w("## Lyme disease: the chart rule in the criteria column")
    w("")
    w(f"- Rule: {link(LINKS['lyme_rule'])}. Lists coded findings with their dates in the Lyme card's criteria "
      f"column, beside the model's estimate; no weights and no score. Already coded: {js['lymeCoded']['label']}.")
    w(f"- Exposure context: `Patient.address[0].state` and `.district` (county name) looked up in "
      f"{link(LINKS['lyme_data'])}, built from {link(LINKS['lyme_csv'])} (CDC surveillance 2015 to 2019). "
      "No county on file: the state average is shown and labeled. No state: no exposure context.")
    w("- Test patient: Dana (Dutchess County, NY), `model/test_vectors/bundles/dana.json`.")
    w(f"- Patient follow-up: {inst['CHECK_lyme']['title']}. {note['CHECK_lyme']} The answers appear on the Lyme "
      "panel under the exposure context.")
    w("")
    L += table(["Finding", "Codes"], [[f["label"], f["codes"]] for f in js["lyme"]])
    w(f"Next steps on the card ({js['lymeSource']}):")
    w("")
    for s in js["lymeNext"]:
        w(f"- {s}")
    w("")

    w("## Lupus: the chart rule in the criteria column")
    w("")
    w(f"- Rule: {link(LINKS['lupus_rule'])} (`evaluateLupusSignal`), shown in the lupus card's criteria column beside the model's estimate. Reads Condition and Observation (labs by LOINC "
      "and text), plus note text where available; a positive ANA at 1:80 or more is the entry criterion; within "
      "each domain only the highest-weighted criterion counts. Confirmed and possible (note-derived) evidence "
      "are kept apart. Criterion names match on word boundaries with the longest overlapping match kept, negated "
      "mentions (\"no oral ulcers\", \"denies seizure\") do not count, and white-cell and platelet counts are "
      "compared in 10^9/L whatever the unit (10*9/L, 10*3/uL, /uL).")
    w("- Missing data: the rule records which resources were readable. The lowest signal (1, \"no chart-supported "
      "pattern\") needs a negative ANA and readable Condition and Observation resources; otherwise the floor is 2, "
      "\"limited evidence in this chart ... cannot rule out lupus\". Missing tests (for example complement, "
      "anti-dsDNA, or urine protein) are listed on the card as data gaps.")
    w("")

    w("## Missing data")
    w("")
    w("Chart models (Long COVID, chronic fatigue, fibromyalgia, endometriosis, Lyme disease, lupus, migraine, depression, anxiety):")
    w("")
    L += table(["Situation", "What happens"], [list(r) for r in MISSING_MODEL])
    w("Patient questionnaire:")
    w("")
    L += table(["Situation", "What happens"], [list(r) for r in MISSING_QUESTIONNAIRE])

    w("## Patient questionnaire")
    w("")
    w(f"One questionnaire for everyone, saved as a FHIR QuestionnaireResponse for `{js['qUrl']}` version "
      f"{js['qVersion']}; item wording and sources in {link(LINKS['questionnaire_spec'])}. The patient reviews "
      "and corrects the answers before sharing. The demo flags a chart for review if the band is High, or "
      "RECOVER is 11 or more, or the post-exertional malaise screen is positive; this combined rule is "
      "exploratory (not evaluated for how many patients it flags or misses) and is labeled so in the app. In "
      "the clinician view, one answer per condition updates the chart estimate (next section). Supported "
      f"versions for import: {', '.join(js['qSupported'])}.")
    w("")
    rows = [[inst[p]["title"], note[p]] for p in PARTS]
    L += table(["Part", "Scoring and when it is shown"], rows)
    w("## Combining the chart and the answers")
    w("")
    w("When an imported QuestionnaireResponse has a result for a condition's instrument, the clinician view "
      "multiplies the chart estimate's odds by that result's published likelihood ratio (Bayes' rule) and shows "
      "the combined probability, times the average, band, and next steps, with the chart-only values beside them "
      "and the answer as a finding in the card's Why list. This treats the answers and the chart findings as "
      "independent given the condition, the same assumption the chart models make for their findings; where the "
      "chart already codes the same symptoms the answers count, the update overstates. Each ratio was measured "
      "against a reference close to the chart model's target, and none in the app's own population. One "
      "instrument per condition, because the instruments overlap. Not combined, because no published ratio "
      "against a comparable reference exists: the DePaul post-exertional malaise screen alone, the National "
      "Academies time question, the Post-COVID-19 Functional Status scale, the Lyme exposure questions, and the "
      "PHQ-9 and GAD-7 (their published accuracy is against interview diagnoses, not against the depression and "
      "anxiety models' target, a self-reported diagnosis that was never coded).")
    w("")
    names = {c["key"]: c["title"] for c in js["cards"]}
    rows = [[names.get(k, k), e["label"], f"{e['lr']['positive']:g} if {e['text']['positive']}; {e['lr']['negative']:g} if {e['text']['negative']}",
             e["measured"], f"[{e['source']}]({e['url']})"] for k, e in js["answers"].items()]
    L += table(["Condition", "Answer used", "Likelihood ratio", "Measured as", "Source"], rows)
    return "\n".join(L).rstrip() + "\n"


def main() -> int:
    text = render(load_js())
    if "--check" in sys.argv:
        current = OUT.read_text(encoding="utf-8") if OUT.exists() else ""
        if current != text:
            print(f"{OUT.relative_to(REPO)} is out of date: run python3 {LINKS['builder']}", file=sys.stderr)
            return 1
        print(f"{OUT.relative_to(REPO)} is up to date")
        return 0
    OUT.write_text(text, encoding="utf-8")
    print(f"wrote {OUT.relative_to(REPO)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
