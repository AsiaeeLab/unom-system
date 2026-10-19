# Model file contract (contract version 0.2, 2026-10-11; first draft 0.1, 2026-09-28)

Written for Kaveh and his agent. This is how the app runs the Long COVID model: the model is a static JSON file that the SMART app loads and evaluates in the browser, so in the app no patient data leaves the EHR session. The CDS Hooks service evaluates the same file on the chart data the EHR sends it and stores nothing.

The first real model file will arrive around October 5. Until then, build against `model/longcovid.example.json`, which has the final structure and placeholder weights.

## 1. Why a static linear model

All of Us forbids exporting models trained on participant-level data. The deployable model is refit outside Workbench from exported summary counts, and the result is a linear score with a calibration map. That form is also what the clinician view needs: every point of the score traces to a named, dated chart finding.

## 2. File structure

```jsonc
{
  "model_id": "unm-longcovid",
  "version": "0.1.0",                       // semver; the app shows it in the footer
  "status": "placeholder",                  // "placeholder" | "research"
  "target": {
    "label": "Future Long COVID diagnosis code",
    "definition": "First ICD-10-CM U09.9 code 91–455 days after the first documented COVID-19 diagnosis",
    "population": "Adults with documented COVID-19 and no Long COVID code by day 90",
    "landmark_days": 90,
    "horizon_days": [91, 455]
  },
  "index_event": {                          // defines day 0
    "condition_codes": { "icd10cm": ["U07.1"] },
    "earliest_date": "2021-07-02",            // optional: a U07.1 dated earlier cannot be the index (training era start)
    "use_positive_tests": false,              // training used U07.1 only; keep false
    "positive_test_loinc": ["94500-6", "94309-2", "94534-5", "94558-4", "95209-3"],
    "rule": "first U07.1 Condition dated on or after earliest_date and on or before the scoring date"
  },
  "exclusion": {                            // if any of these is recorded by the scoring date, do not score
    "condition_codes": { "icd10cm": ["U09.9"], "snomed": ["1119303003", "1119304009", "1325161000000102"] }
  },
  "windows": { "W0": [-365, -91], "W1": [-90, -1], "W2": [0, 30], "W3": [31, 90] },
  "features": [
    {
      "id": "sym_fatigue_new",
      "label": "New fatigue or malaise after COVID",
      "group": "Symptoms",
      "kind": "new_onset",                  // see section 3
      "resource": "Condition",
      "codes": { "icd10cm_prefix": ["R53", "G93.3"] },
      "present_in": ["W2", "W3"],
      "absent_in": ["W0", "W1"],
      "weight": 0.0
    }
  ],
  "intercept": 0.0,
  "calibration": {                          // maps linear score -> probability
    "method": "piecewise_linear",
    "points": [[-6.0, 0.002], [-4.0, 0.01], [-2.0, 0.05]]
  },
  "risk_bands": [
    { "name": "Typical", "max_probability": 0.015 },
    { "name": "Elevated", "max_probability": 0.04 },
    { "name": "High", "max_probability": 1.0 }
  ],
  "reference": {
    "cohort_base_rate": 0.011,              // shown as "X times the post-COVID average"
    "top5pct_min_probability": 0.03
  },
  "provenance": {
    "data": "All of Us Research Program, Registered Tier CDR v9",
    "method": "Linear discriminant refit from dissemination-compliant summary counts",
    "evaluation": "See the preprint and model card",
    "open_data": ["CDC/NCHS Household Pulse Survey (gsea-w83j)", "CMS fee schedules"]
  },
  "statement": "Research decision support. Surfaces chart patterns for clinician review. Not a diagnosis."
}
```

## 3. Feature kinds

A patient's day 0 is the index event: the earliest Condition coded U07.1 dated on or after `index_event.earliest_date` (when the file has it) and on or before the scoring date. In `model/longcovid.json` the earliest date is 2021-07-02, the training cohort's era start (`workbench/src/t01_cohort.py`, `ERA_START`): in All of Us shifted dates it keeps day 91 on or after October 1, 2021, when U09.9 came into use, so an earlier COVID-19 diagnosis (for example a 2020 infection followed by a 2023 reinfection) is not the index. Positive SARS-CoV-2 tests count only when `use_positive_tests` is true, and a test is positive only when its `interpretation` (or coded value) is POS/DET or SNOMED 10828004/260373001, or its value text says detected/positive with no negation ("not detected", "negative", "none" are negative). For a resource, its date is the first available of: `onsetDateTime`, `onsetPeriod.start`, `recordedDate` (Condition); `period.start` (Encounter); `effectiveDateTime`, `effectivePeriod.start`, `issued` (Observation); `authoredOn` (MedicationRequest); `performedDateTime`, `performedPeriod.start` (Procedure); `occurrenceDateTime` (Immunization). A resource falls in a window if its date offset in days is within the window's closed interval.

Dates. A full date or dateTime uses its calendar date (the first 10 characters; time and zone are ignored, so results do not depend on the viewer's time zone). FHIR also allows partial dates, and the scorer reads them as follows: on a record, `YYYY` is January 1 and `YYYY-MM` is the first of the month (the earliest compatible day); for `Patient.birthDate`, `YYYY` is July 1 (as in the training cohort, which used July 1 when only the birth year was known) and `YYYY-MM` is the 15th. A field that does not hold a valid FHIR date (for example `"03/02/1980"` or `"2024-02-30"`) is skipped, and the next date field in the list above is used; a record with no valid date is undated and falls in no window. The scorer never raises on a record's date.

Records the scorer ignores. Every rule and feature reads only records dated on or before the scoring date (undated records are kept and handled as below). A Condition whose `verificationStatus` is `refuted` or `entered-in-error`, and any resource whose `status` is `entered-in-error`, is ignored everywhere. An undated Condition can never be the index event and counts in no window, but an undated target diagnosis (an `exclusion` code) counts as already recorded.

| kind | fields | value |
|---|---|---|
| `any` | `resource`, `codes`, `present_in` (or `window` in days) | 1 if a matching resource falls in the listed windows, else 0 |
| `new_onset` | `resource`, `codes`, `present_in`, `absent_in` | 1 if a match falls in `present_in` and none falls in `absent_in`, else 0 |
| `encounter_any` | `encounter_class`, `window` in days | 1 if an Encounter with `class.code` in the list starts within the window |
| `encounter_count_ge` | `encounter_class`, `windows`, `threshold` | 1 if the number of such Encounters in the windows is at least `threshold` |
| `encounter_rate_ratio_ge` | `encounter_class`, `numerator`, `denominator`, `threshold` | 1 if (encounters per day in `numerator` window) / (per day in `denominator` window) is at least `threshold`; a zero denominator with a nonzero numerator counts as 1 |
| `derived_count_ge` | `of_group`, `threshold` | 1 if at least `threshold` features in that group (excluding derived ones) equal 1 |
| `cluster_count_ge` | `clusters` (name → ICD-10-CM prefixes), `window` in days, `threshold` | 1 if at least `threshold` clusters have a matching Condition within the window |
| `age_band` | `min`, `max` | 1 if age in years at day 0 is within [min, max] |
| `sex` | `value` | 1 if `Patient.gender` equals `value` |

A feature can have `weight: 0`. It is still evaluated, because a `derived_count_ge` feature counts every feature in its group, but it never appears in `drivers`. Drivers are the present features with a nonzero weight, sorted by contribution (largest first). Features that are identical except for `id`, `label`, `weight`, and `threshold` (for example "2+ outpatient visits" and "4+ outpatient visits") are nested thresholds: when several are present, `drivers` shows one entry, the highest threshold present, with the sum of their contributions. Evidence for `cluster_count_ge` is the first matching Condition in each counted cluster; for `derived_count_ge`, the first evidence item of each counted feature.

Encounter classes use the HL7 v3 ActCode values `AMB`, `EMER`, `IMP`; virtual (`VR`) and home (`HH`) encounters count as `AMB`. Windows `W0`–`W3` are closed day ranges relative to day 0 (`windows` in the file).

Code matching: ICD-10-CM codes are compared with dots removed, by prefix (`icd10cm_prefix`). CPT, ICD-10-PCS, LOINC, and SNOMED are compared exactly. Medications use a precomputed RxCUI list per feature (ingredients plus their clinical and branded drugs); until those lists are filled in (`rxcui` empty), match `rxnorm_ingredient_names` against the medication's coding display or text, case-insensitive.

## 4. Scoring

```
score = intercept + Σ weight_j × value_j
probability = calibration(score)      // piecewise-linear interpolation, clamped at the ends
band = first risk band whose max_probability ≥ probability
```

The app shows: probability, band, "N times the post-COVID average" (= probability / cohort_base_rate), and the features with nonzero value sorted by weight × value, each linked to the dated chart resources that triggered it.

The app does not score when (a) there is no index event (or only index events before `earliest_date`), (b) `Patient.birthDate` is missing or unusable, (c) the patient is under 18 on day 0 (age in years is days / 365.25, as in the training cohort), (d) fewer than `target.landmark_days` (90) days have passed since day 0, (e) more than `target.horizon_days[1]` (455) days have passed since day 0, which is outside the model's time window, (f) an exclusion code is recorded on or before the scoring date, whether before, on, or after day 0, or is undated, matching the training cohort, which excluded anyone with a Long COVID code on or before day 90 including before the index, or (g) the chart has no encounters in W0 ∪ W1 (insufficient history). The checks run in this order, and the result's `reason` says which one applied. Predictors are read through day 90, so a chart scored on day 91 to 455 gets the day-90 estimate of a code in days 91 to 455.

## 4b. Models anchored on the scoring date (chronic fatigue card, `model/chronicfatigue.json`)

A model whose `index_event.type` is `"scoring_date"` has no index event: day 0 is the date the chart is scored, and every window is a look-back from it (for the chronic fatigue model, `H` = the past 5 years, `[-1825, -1]`, and `R` = the past year, `[-365, -1]`). Age bands use age on day 0. The app does not score such a model when (a) `Patient.birthDate` is missing or unusable, or the patient is under 18 on day 0, (a2) the model has an `eligibility.sex` (the endometriosis model: `"female"`) and `Patient.gender` differs (show `eligibility.reason`), (b) a Condition matching `exclusion.condition_codes` is dated on or before day 0 or is undated (the target diagnosis is already recorded; show `exclusion.reason`), or (c) fewer than `history_requirement.min_count` encounters of the listed classes fall in `history_requirement.window` (show `history_requirement.reason`). There is no landmark-day rule. Everything else (feature kinds, calibration, bands, drivers) is as in sections 3 and 4. MedicationRequest features list `codes.rxcui` and, as a fallback for records without an RxNorm code, `codes.rxnorm_ingredient_names` (case-insensitive match against the medication text or display). The card's wording: "Chart pattern similar to patients who report a chronic fatigue or ME/CFS diagnosis that was never coded"; it is a prompt to ask the patient (the DePaul post-exertional malaise screen and the functional status grade in `submission/app_questionnaire.md`), not a diagnosis.

## 4c. Unavailable data

A failed, forbidden, or truncated FHIR search is not an empty record. The caller passes the resource types it could not read (`score_bundle(model, bundle, as_of, unavailable=[...])` in Python, `scoreBundle(model, bundle, asOf, { unavailable })` in JavaScript). Patient, Condition, and Encounter are read by every model's eligibility rules (and Observation too when `use_positive_tests` is true): if one of them is unavailable, the result is `{"status": "could_not_score", "reason": "could not score: Condition unavailable", "unavailable": ["Condition"]}` at once. A resource type read only by features (the `resource` of any feature) is checked after eligibility, so a chart that is ineligible on the data that could be read still says why (for example "no documented COVID-19 index event"); an eligible chart returns `could_not_score` with `index_date`. The app shows such a card as "Could not score", says which records could not be read, and never shows it as a Typical result. Resource types the model does not read do not matter.

## 5. Test vectors

`model/test_vectors/bundles/*.json` holds synthetic FHIR bundles and `model/test_vectors/expected/<model_id>-<version>/` the expected feature values, score, and probability, produced by the Python reference scorer `model/reference/score_fhir.py` (`python3 model/test_vectors/make_bundles.py <model file>`). The JavaScript scorer reproduces them to 1e-9 (`npm test` in `web/`). Eight bundles test the eligibility rules: a Long COVID code before the index (Priya), on the index date (Sam, SNOMED CT 1325161000000102), and on day 90 (Theo); an undated Long COVID code (Yara); a COVID-19 index 508 days before the scoring date (Vera); partial dates, a pre-2021-07-02 infection, and refuted and future-dated Long COVID codes, which should still score (Will); no birth date (Uma); and a patient under 18 (Kai). The unavailable-data rules are unit tests in `model/reference/test_score_fhir.py` and `web/test/scorer.test.js`.

The bundles are FHIR R4 collections whose `fullUrl` values are `urn:uuid:` RFC 4122 name-based UUIDs of `<resourceType>/<id>`, with no null or empty values. `web/test/conformance.test.js` checks that, the R4 required elements of each resource, date formats, and the patient app's QuestionnaireResponses. The HL7 FHIR validator is the full check and needs the FHIR core package, which is not available offline here; where it is installed, run `java -jar validator_cli.jar -version 4.0.1 model/test_vectors/bundles/*.json`.

Release manifest: `python3 analysis/build_release_manifest.py --out <file>` records, for each deployed model file, its hash, model version, feature registry, aggregate inputs, fitting code and commit, calibration source, evaluation target, and released evaluation rows, together with the scorer hashes, this contract version, and the application files.

## 6. Open questions for Kaveh

1. Where does the app run the Long COVID module relative to the lupus module: one app with condition cards, or a module switch?
2. Can the app read `Patient.address` (county FIPS or ZIP) for the Lyme module's county prior?
3. Which FHIR server will hold the synthetic demo patients (SMART Health IT sandbox, HAPI, or athenaOne Preview)?
