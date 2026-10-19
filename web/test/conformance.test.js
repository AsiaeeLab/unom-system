// FHIR R4 structural checks on the synthetic bundles, the CDS Hooks example requests, and the patient app's
// QuestionnaireResponses. The HL7 FHIR validator is the full check; it needs the FHIR core package
// and is not run here (no offline copy). To run it where it is installed:
//   java -jar validator_cli.jar -version 4.0.1 model/test_vectors/bundles/*.json
//   java -jar validator_cli.jar -version 4.0.1 <a QuestionnaireResponse exported from the patient app>
// These tests cover the rules the audit found broken plus the R4 required elements of the resources we write.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

import { buildQuestionnaireResponse } from "../web/patient/scoring.js";
import { DEMO_ANSWERS } from "../web/shared/demo-answers.js";
import { demoState } from "../web/patient/demo.js";

const repo = new URL("../../", import.meta.url);
const readJson = (p) => JSON.parse(readFileSync(new URL(p, repo), "utf8"));
const bundles = readdirSync(new URL("model/test_vectors/bundles/", repo)).filter((f) => f.endsWith(".json")).sort();
const examples = readdirSync(new URL("web/web/developers/examples/", repo)).filter((f) => f.endsWith(".json")).sort();

const UUID = /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const FHIR_ID = /^[A-Za-z0-9\-.]{1,64}$/u;
const DATE = /^([0-9]([0-9]([0-9][1-9]|[1-9]0)|[1-9]00)|[1-9]000)(-(0[1-9]|1[0-2])(-(0[1-9]|[1-2][0-9]|3[0-1]))?)?$/u;
const DATETIME = /^([0-9]([0-9]([0-9][1-9]|[1-9]0)|[1-9]00)|[1-9]000)(-(0[1-9]|1[0-2])(-(0[1-9]|[1-2][0-9]|3[0-1])(T([01][0-9]|2[0-3]):[0-5][0-9]:([0-5][0-9]|60)(\.[0-9]+)?(Z|(\+|-)((0[0-9]|1[0-3]):[0-5][0-9]|14:00)))?)?)?$/u;
const REQUIRED = {
  Bundle: ["type"],
  Encounter: ["status", "class"],
  Condition: ["subject"],
  Observation: ["status", "code"],
  MedicationRequest: ["status", "intent", "subject"],
  Procedure: ["status", "subject"],
  QuestionnaireResponse: ["status"],
};
const DATE_FIELDS = new Set(["birthDate"]);
const DATETIME_FIELDS = new Set(["onsetDateTime", "recordedDate", "effectiveDateTime", "issued", "authoredOn", "performedDateTime",
  "occurrenceDateTime", "start", "end", "authored"]);

/** No null, empty string, empty array, or empty object anywhere (FHIR JSON representation rules). */
function noEmpty(v, path, problems) {
  if (v === null || v === undefined) problems.push(`${path} is null`);
  else if (v === "") problems.push(`${path} is an empty string`);
  else if (Array.isArray(v)) {
    if (!v.length) problems.push(`${path} is an empty array`);
    v.forEach((x, i) => noEmpty(x, `${path}[${i}]`, problems));
  } else if (typeof v === "object") {
    if (!Object.keys(v).length) problems.push(`${path} is an empty object`);
    for (const [k, x] of Object.entries(v)) {
      noEmpty(x, `${path}.${k}`, problems);
      if (DATE_FIELDS.has(k) && !DATE.test(x)) problems.push(`${path}.${k} is not a FHIR date: ${x}`);
      if (DATETIME_FIELDS.has(k) && typeof x === "string" && !DATETIME.test(x)) problems.push(`${path}.${k} is not a FHIR dateTime: ${x}`);
      if (k === "coding") for (const c of [].concat(x)) if (c?.system && !/^(https?:|urn:)/u.test(c.system)) problems.push(`${path}.coding system ${c.system}`);
    }
  }
  return problems;
}

function checkResource(r, path, problems) {
  if (!r?.resourceType) problems.push(`${path} has no resourceType`);
  if (r?.id !== undefined && !FHIR_ID.test(r.id)) problems.push(`${path}.id ${r.id} is not a FHIR id`);
  for (const k of REQUIRED[r?.resourceType] || []) if (r[k] === undefined) problems.push(`${path} (${r.resourceType}) lacks ${k}`);
  if (r?.resourceType === "MedicationRequest" && !r.medicationCodeableConcept && !r.medicationReference) problems.push(`${path} lacks medication[x]`);
  return problems;
}

function checkBundle(b, name) {
  const problems = noEmpty(b, name, []);
  checkResource(b, name, problems);
  const urls = new Set();
  (b.entry || []).forEach((e, i) => {
    if (e.fullUrl !== undefined) {
      if (!UUID.test(e.fullUrl)) problems.push(`${name}.entry[${i}].fullUrl ${e.fullUrl} is not a urn:uuid UUID`);
      if (urls.has(e.fullUrl)) problems.push(`${name}.entry[${i}].fullUrl repeats`);
      urls.add(e.fullUrl);
    }
    checkResource(e.resource, `${name}.entry[${i}].resource`, problems);
  });
  return problems;
}

test("synthetic bundles: urn:uuid fullUrls are UUIDs, no null or empty values, R4 required elements present", () => {
  assert.ok(bundles.length >= 18);
  for (const f of bundles) {
    const b = readJson(`model/test_vectors/bundles/${f}`);
    assert.deepEqual(checkBundle(b, f), [], f);
    assert.ok(b.entry.every((e) => e.fullUrl), `${f}: every entry has a fullUrl`);
  }
});

test("CDS Hooks example requests: prefetch searchsets pass the same checks", () => {
  for (const f of examples) {
    const req = readJson(`web/web/developers/examples/${f}`);
    assert.match(req.hookInstance, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u, f);
    for (const [key, value] of Object.entries(req.prefetch)) {
      const problems = value.resourceType === "Bundle" ? checkBundle(value, `${f}.${key}`) : checkResource(value, `${f}.${key}`, noEmpty(value, `${f}.${key}`, []));
      assert.deepEqual(problems, [], `${f} ${key}`);
    }
  }
});

// Every demo person, plus the PHQ-9 and GAD-7 (version 1.3.0) answered in full, in part, and with only question 9.
const scale = (n, v) => Object.fromEntries(Array.from({ length: n }, (_, i) => [String(i + 1), v]));
const QR_STATES = [
  ...Object.keys(DEMO_ANSWERS).map((id) => [id, demoState(id)]),
  ["phq9-gad7", { ...demoState("elena"), checks: { ...demoState("elena").checks, chosen: { mecfs: true, phq9: true, gad7: true }, phq9: { ...scale(9, 2), difficulty: "very" }, gad7: scale(7, 3) } }],
  ["phq9-partial", { ...demoState("dana"), checks: { ...demoState("dana").checks, chosen: { lyme: true, phq9: true, gad7: true }, phq9: { 9: 1 }, gad7: { 1: 0, 2: 1 } } }],
];

test("patient app QuestionnaireResponses (every demo person, and the PHQ-9 and GAD-7): no null or empty values, valid dates and answers", () => {
  for (const [id, state] of QR_STATES) {
    const qr = buildQuestionnaireResponse(state, { authored: "2024-06-01T12:00:00Z" });
    const problems = checkResource(qr, id, noEmpty(qr, id, []));
    assert.deepEqual(problems, [], id);
    assert.ok(["in-progress", "completed", "amended", "entered-in-error", "stopped"].includes(qr.status));
    assert.match(qr.questionnaire, /^https:\/\/undiagnosednomore\.org\/fhir\/Questionnaire\/unm-patient-symptom-check\|\d+\.\d+\.\d+$/u);
    const walk = (items) => {
      for (const it of items || []) {
        assert.ok(it.linkId && !(it.item && it.answer), `${id} ${it.linkId}`);
        for (const a of it.answer || []) {
          const [key] = Object.keys(a);
          if (key === "valueDate") assert.match(a.valueDate, DATE, `${id} ${it.linkId}`);
          if (key === "valueCoding") assert.ok(a.valueCoding.system && a.valueCoding.code, `${id} ${it.linkId}`);
        }
        walk(it.item);
      }
    };
    walk(qr.item);
    if (id.startsWith("phq9")) {
      const ids = JSON.stringify(qr).match(/"linkId":"checks\.(phq9|gad7)[^"]*"/gu) || [];
      assert.ok(ids.length > 0, id);
      for (const it of ids) assert.match(it, /"checks\.(phq9|gad7)(\.([1-9]|difficulty|total|band))?"$/u, `${id} ${it}`);
    }
  }
});
