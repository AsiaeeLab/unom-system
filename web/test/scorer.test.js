import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  scoreBundle,
  testIsPositive,
  findIndex,
  calibrate,
  resourceDate,
  encounterClass,
  nestKey,
  parseDate,
  parseFhirDate,
  LOINC,
  ICD10,
  SNOMED,
  RXNORM,
} from "../web/shared/scorer.js";

const WEB = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = join(WEB, "..");
const MODEL_DIR = join(REPO, "model");
const VECTORS = join(MODEL_DIR, "test_vectors");
const MODEL_FILES = ["longcovid.json", "longcovid.example.json", "chronicfatigue.json", "fibromyalgia.json", "endometriosis.json", "lyme.json", "lupus.json", "migraine.json", "depression.json", "anxiety.json"];
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

const models = new Map();
for (const f of MODEL_FILES) {
  const m = readJson(join(MODEL_DIR, f));
  models.set(`${m.model_id}-${m.version}`, m);
}

/** Deep equality with numbers compared to 1e-9; also checks object key order. */
function assertClose(actual, expected, path = "$") {
  if (typeof expected === "number") {
    assert.equal(typeof actual, "number", `${path}: expected a number, got ${JSON.stringify(actual)}`);
    assert.ok(Math.abs(actual - expected) <= 1e-9, `${path}: ${actual} != ${expected}`);
    return;
  }
  if (Array.isArray(expected)) {
    assert.ok(Array.isArray(actual), `${path}: expected an array`);
    assert.equal(actual.length, expected.length, `${path}: length`);
    expected.forEach((e, i) => assertClose(actual[i], e, `${path}[${i}]`));
    return;
  }
  if (expected !== null && typeof expected === "object") {
    assert.ok(actual !== null && typeof actual === "object" && !Array.isArray(actual), `${path}: expected an object`);
    assert.deepEqual(Object.keys(actual), Object.keys(expected), `${path}: keys`);
    for (const k of Object.keys(expected)) assertClose(actual[k], expected[k], `${path}.${k}`);
    return;
  }
  assert.equal(actual, expected, path);
}

let vectorsChecked = 0;
for (const dir of readdirSync(join(VECTORS, "expected")).sort()) {
  const model = models.get(dir);
  for (const file of readdirSync(join(VECTORS, "expected", dir)).filter((f) => f.endsWith(".json")).sort()) {
    const name = `test vector ${dir}/${file}`;
    if (!model) {
      test(name, { skip: `no model file with model_id-version ${dir} in model/ (that version was superseded)` }, () => {});
      continue;
    }
    test(name, () => {
      const expected = readJson(join(VECTORS, "expected", dir, file));
      const asOf = expected.as_of;
      delete expected.as_of;
      const bundle = readJson(join(VECTORS, "bundles", file));
      assertClose(scoreBundle(model, bundle, asOf), expected);
      vectorsChecked += 1;
    });
  }
}

test("at least one scored vector per available model was checked", () => {
  assert.ok(vectorsChecked >= 27, `only ${vectorsChecked} vectors checked`);
});

test("site copies of the models and bundles match model/ (run web/tools/sync_models.sh)", () => {
  for (const f of MODEL_FILES) {
    assert.equal(readFileSync(join(WEB, "web", "models", f), "utf8"), readFileSync(join(MODEL_DIR, f), "utf8"), f);
  }
  const bundles = readdirSync(join(VECTORS, "bundles")).filter((f) => f.endsWith(".json")).sort();
  const site = readdirSync(join(WEB, "web", "data", "patients")).filter((f) => f.endsWith(".json")).sort();
  assert.deepEqual(site, bundles);
  for (const f of bundles) {
    assert.equal(readFileSync(join(WEB, "web", "data", "patients", f), "utf8"), readFileSync(join(VECTORS, "bundles", f), "utf8"), f);
  }
});

// ---- port of model/reference/test_score_fhir.py

const TEST_LOINC = ["94500-6"];

function obs(text = null, interp = null, date = "2024-01-02") {
  const o = { resourceType: "Observation", code: { coding: [{ system: LOINC, code: "94500-6" }] }, effectiveDateTime: date };
  if (text !== null) o.valueCodeableConcept = { text };
  if (interp) {
    o.interpretation = [{ coding: [{ system: "http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation", code: interp }] }];
  }
  return o;
}

const cond = { resourceType: "Condition", code: { coding: [{ system: ICD10, code: "U07.1" }] }, onsetDateTime: "2024-01-05" };

test("negated test results are not positive and never set the index", () => {
  for (const text of ["Not detected", "NOT DETECTED", "Negative", "None detected", "Undetected", "non-reactive"]) {
    assert.equal(testIsPositive(obs(text)), false, text);
    assert.equal(findIndex([obs(text)], true, TEST_LOINC), null, text);
  }
  assert.equal(testIsPositive(obs("Detected", "NEG")), false);
});

test("explicitly positive test results are positive", () => {
  for (const text of ["Detected", "Positive", "SARS-CoV-2 RNA detected"]) assert.equal(testIsPositive(obs(text)), true, text);
  assert.equal(testIsPositive(obs(null, "POS")), true);
});

test("findIndex uses tests only when enabled, and takes the earliest qualifying date", () => {
  assert.equal(findIndex([obs("Detected")], false, TEST_LOINC), null, "tests ignored unless enabled");
  assert.equal(findIndex([obs("Detected")], true, TEST_LOINC), "2024-01-02");
  assert.equal(findIndex([cond, obs("Detected")], false, TEST_LOINC), "2024-01-05");
  assert.equal(findIndex([cond, obs("Not detected", null, "2024-01-01")], true, TEST_LOINC), "2024-01-05");
  assert.equal(findIndex([cond], false, TEST_LOINC, "2024-01-06"), null, "index on or after the earliest date only");
  assert.equal(findIndex([cond], false, TEST_LOINC, "2024-01-05"), "2024-01-05");
  assert.equal(testIsPositive({ ...obs(), valueString: null }), false, "a null valueString is empty text, not 'None'");
});

test("FHIR dates: full, partial (YYYY, YYYY-MM), and invalid values never throw", () => {
  assert.equal(parseFhirDate("2024-03-10T23:30:00-07:00"), "2024-03-10");
  assert.equal(parseFhirDate("2024"), "2024-01-01");
  assert.equal(parseFhirDate("2024", { birth: true }), "2024-07-01");
  assert.equal(parseFhirDate("2024-03"), "2024-03-01");
  assert.equal(parseFhirDate("2024-03", { birth: true }), "2024-03-15");
  for (const bad of ["2024-02-30", "2024-13", "0000", "0000-01-01", "2024-03T10:00:00Z", "20240310", "2024-3-1", "garbage", "", null, true,
    2024, ["2024"], { start: "2024" }]) {
    assert.equal(parseFhirDate(bad), null, String(bad));
  }
  assert.equal(parseFhirDate("2024-02-29"), "2024-02-29");
  assert.equal(resourceDate({ onsetDateTime: "not a date", recordedDate: "2024-01-01" }), "2024-01-01");
  assert.equal(resourceDate({ onsetDateTime: "2024-05" }), "2024-05-01");
  assert.equal(resourceDate({ onsetDateTime: "garbage" }), null);
  assert.throws(() => parseDate("2024-03"), RangeError, "the scoring date must be a full date");
});

// ---- port of the eligibility, record-status, and availability checks in model/reference/test_score_fhir.py

const LC = models.get("unm-longcovid-1.2.0");
const CF = models.get("unm-chronicfatigue-1.0.0");
const ELIG_AS_OF = "2024-06-01";
const ALREADY = "a Long COVID diagnosis is already recorded";

function condition(date, code, system = ICD10, extra = {}) {
  const r = { resourceType: "Condition", code: { coding: [{ system, code }] }, ...extra };
  if (date) r.onsetDateTime = date;
  return r;
}
const encounter = (date, extra = {}) => ({ resourceType: "Encounter", status: "finished", class: { code: "AMB" }, period: { start: date }, ...extra });

function chart(extra = [], { birth = "1980-03-02", covid = "2024-01-08" } = {}) {
  const p = { resourceType: "Patient", id: "p", gender: "female" };
  if (birth !== null) p.birthDate = birth;
  const res = [p, encounter("2023-06-15"), encounter("2023-10-20")];
  if (covid) res.push(condition(covid, "U07.1"));
  return { resourceType: "Bundle", type: "collection", entry: [...res, ...extra].map((resource) => ({ resource })) };
}
const run = (bundle, { model = LC, asOf = ELIG_AS_OF, unavailable = [] } = {}) => scoreBundle(model, bundle, asOf, { unavailable });
const refuted = { verificationStatus: { coding: [{ code: "refuted" }] } };

test("the deployed Long COVID file carries the training index era and every excluded SNOMED concept", () => {
  assert.equal(LC.index_event.earliest_date, "2021-07-02");
  assert.deepEqual([...LC.exclusion.condition_codes.snomed].sort(), ["1119303003", "1119304009", "1325161000000102"]);
});

test("Long COVID codes up to the scoring date (before, on, or after the index; undated) mean already recorded", () => {
  assert.equal(run(chart()).status, "scored");
  for (const when of ["2023-12-01", "2024-01-08", "2024-04-07", "2024-05-01"]) assert.equal(run(chart([condition(when, "U09.9")])).reason, ALREADY, when);
  assert.equal(run(chart([condition("2024-03-01", "1325161000000102", SNOMED)])).reason, ALREADY);
  assert.equal(run(chart([condition(null, "U09.9")])).reason, ALREADY, "undated");
  assert.equal(run(chart([condition("2024-07-01", "U09.9")])).status, "scored", "after the scoring date: ignored");
  assert.equal(run(chart([condition("2024-03-01", "U09.9", ICD10, refuted)])).status, "scored", "refuted: ignored");
  assert.equal(run(chart([condition("2024-03-01", "U09.9", ICD10, { verificationStatus: { coding: [{ code: "entered-in-error" }] } })])).status, "scored");
});

test("index: first U07.1 on or after earliest_date and on or before the scoring date", () => {
  const r = run(chart([], { covid: "2021-03-10" }));
  assert.equal(r.status, "not_scored");
  assert.match(r.reason, /^no documented COVID-19 index event on or after 2021-07-02/u);
  assert.equal(run(chart([condition("2021-03-10", "U07.1")])).index_date, "2024-01-08");
  assert.equal(run(chart([], { covid: "2024-07-01" })).reason, "no documented COVID-19 index event");
  const noEra = { ...LC, index_event: Object.fromEntries(Object.entries(LC.index_event).filter(([k]) => k !== "earliest_date")) };
  assert.equal(run(chart([condition("2021-03-10", "U07.1")]), { model: noEra }).status, "not_scored");
});

test("landmark day 90 and the day-455 time window", () => {
  assert.equal(run(chart(), { asOf: "2024-04-06" }).reason, "fewer than 90 days since the COVID-19 index");
  for (const asOf of ["2024-04-07", "2025-04-06", "2025-04-07"]) assert.equal(run(chart(), { asOf }).status, "scored", asOf);
  assert.equal(run(chart(), { asOf: "2025-04-08" }).reason, "more than 455 days since the COVID-19 index (outside the model's time window)");
});

test("age 18 or older on day 0 and a usable birth date are required", () => {
  const BIRTH = "birth date missing or unusable (age is required)";
  assert.equal(run(chart([], { birth: null })).reason, BIRTH);
  assert.equal(run(chart([], { birth: "03/02/1980" })).reason, BIRTH);
  assert.equal(run(chart([], { birth: "2006-01-09" })).reason, "under 18 at the COVID-19 index (the model covers adults)");
  assert.match(run(chart([], { birth: "2006-01-08" })).reason, /^under 18/u, "days / 365.25 as in training");
  assert.equal(run(chart([], { birth: "2006-01-07" })).status, "scored");
  const year = run(chart([], { birth: "1980" }));
  assert.equal(year.status, "scored");
  assert.equal(year.features.age_40_49, 1);
  assert.match(run(chart([], { birth: "2006" })).reason, /^under 18/u);
  assert.equal(run(chart([], { birth: "2006-06-02" }), { model: CF }).reason, "under 18 on the scoring date (the model covers adults)");
  assert.equal(run(chart([], { birth: "2006-06-01" }), { model: CF }).status, "scored");
  assert.equal(run(chart([], { birth: null }), { model: CF }).reason, BIRTH);
});

test("scoring-date model: undated target codes count, refuted and later ones do not", () => {
  assert.equal(run(chart([condition(null, "G93.32")]), { model: CF }).reason, CF.exclusion.reason);
  assert.equal(run(chart([condition("2023-01-01", "G93.32", ICD10, refuted)]), { model: CF }).status, "scored");
  assert.equal(run(chart([condition("2024-06-02", "G93.32")]), { model: CF }).status, "scored");
});

test("entered-in-error records are ignored; partial record dates count; null text never throws", () => {
  const b = chart();
  for (const e of b.entry) if (e.resource.resourceType === "Encounter") e.resource.status = "entered-in-error";
  assert.equal(run(b).reason, "no encounters in the year before COVID-19 (insufficient history)");
  const partial = run(chart([condition("2024-03", "R53.83"), encounter("2024-03")]));
  assert.equal(partial.status, "scored");
  assert.equal(partial.features.sym_any_fatigue, 1);
  const med = { resourceType: "MedicationRequest", status: "active", authoredOn: "2024-02-01",
    medicationCodeableConcept: { text: null, coding: [{ system: RXNORM, display: null }] } };
  assert.equal(run(chart([med])).status, "scored");
});

test("a failed or forbidden search is never read as an empty record", () => {
  assert.deepEqual(run(chart(), { unavailable: ["Condition"] }),
    { status: "could_not_score", reason: "could not score: Condition unavailable", unavailable: ["Condition"] });
  const late = run(chart(), { unavailable: ["Procedure", "Observation", "DiagnosticReport"] });
  assert.deepEqual(Object.keys(late), ["status", "reason", "index_date", "unavailable"]);
  assert.deepEqual(late, { status: "could_not_score", reason: "could not score: Observation, Procedure unavailable",
    index_date: "2024-01-08", unavailable: ["Observation", "Procedure"] });
  assert.equal(run(chart([], { covid: null }), { unavailable: ["Observation"] }).reason, "no documented COVID-19 index event");
  assert.equal(run(chart(), { unavailable: ["Patient"] }).status, "could_not_score");
  assert.equal(run(chart(), { unavailable: ["DocumentReference"] }).status, "scored");
  assert.equal(run(chart(), { unavailable: new Set(["Condition"]) }).status, "could_not_score", "a Set works too");
  const testsOn = { ...LC, index_event: { ...LC.index_event, use_positive_tests: true } };
  assert.deepEqual(run(chart(), { model: testsOn, unavailable: ["Observation"] }),
    { status: "could_not_score", reason: "could not score: Observation unavailable", unavailable: ["Observation"] });
});

// ---- helper behavior that the vectors do not exercise

test("dates are calendar dates from the first 10 characters, as Python date.fromisoformat", () => {
  assert.equal(resourceDate({ effectiveDateTime: "2024-03-10T23:30:00-07:00" }), "2024-03-10");
  assert.equal(resourceDate({ onsetPeriod: { start: "2023-12-31" }, recordedDate: "2024-01-01" }), "2023-12-31");
  assert.equal(resourceDate({ onsetDateTime: "", recordedDate: "2024-01-01" }), "2024-01-01");
  assert.equal(resourceDate({}), null);
  assert.throws(() => parseDate("2024-01"), RangeError, "parseDate is the strict scoring-date parser");
  assert.throws(() => parseDate("2024-02-30"), RangeError);
  assert.equal(parseDate("2024-02-29"), "2024-02-29");
});

test("calibration interpolates and clamps", () => {
  const pts = [[-6, 0.002], [-4, 0.01], [-2, 0.05]];
  assert.equal(calibrate(-7, pts), 0.002);
  assert.equal(calibrate(0, pts), 0.05);
  assert.equal(calibrate(-4, pts), 0.01);
  assert.ok(Math.abs(calibrate(-5, pts) - 0.006) < 1e-15);
});

test("virtual and home encounters count as ambulatory", () => {
  assert.equal(encounterClass({ class: { code: "VR" } }), "AMB");
  assert.equal(encounterClass({ class: [{ coding: [{ code: "HH" }] }] }), "AMB");
  assert.equal(encounterClass({ class: { code: "EMER" } }), "EMER");
  assert.equal(encounterClass({}), null);
});

test("nested-threshold key ignores id, label, weight, and threshold", () => {
  const a = { id: "a", label: "2+", kind: "encounter_count_ge", encounter_class: ["AMB"], windows: ["W3"], threshold: 2, weight: 0.1 };
  const b = { ...a, id: "b", label: "4+", threshold: 4, weight: 0.3 };
  assert.equal(nestKey(a), nestKey(b));
  assert.notEqual(nestKey(a), nestKey({ ...a, windows: ["W2"] }));
});

test("asOf defaults to today's date in UTC", () => {
  const model = models.get("unm-chronicfatigue-1.0.0");
  const bundle = readJson(join(VECTORS, "bundles", "elena.json"));
  assert.equal(scoreBundle(model, bundle).index_date, new Date().toISOString().slice(0, 10));
});
