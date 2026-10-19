import test from "node:test";
import assert from "node:assert/strict";
import { evaluateLupusSignal } from "../web/athena/rule.js";

function access(status = "Available") {
  return [
    "Condition",
    "Observation",
    "DiagnosticReport",
    "DocumentReference",
    "QuestionnaireResponse",
  ].map((resourceType) => ({ resourceType, status, count: 0 }));
}

function observation(code, display, fields = {}) {
  return {
    resourceType: "Observation",
    status: "final",
    code: { coding: [{ system: "http://loinc.org", code, display }] },
    effectiveDateTime: "2026-01-15",
    ...fields,
  };
}

function record({ conditions = [], observations = [], notes = [], status = "Available" } = {}) {
  return {
    resources: { Condition: conditions, Observation: observations },
    access: access(status),
    notes,
  };
}

test("missing core data remains incomplete rather than minimal", () => {
  const signal = evaluateLupusSignal(record({ status: "Not authorized" }));
  assert.equal(signal.rating, 2);
  assert.equal(signal.title, "Limited evidence in this chart");
});

test("documented negative ANA with adequate core coverage can produce level one", () => {
  const signal = evaluateLupusSignal(
    record({
      observations: [
        observation("5048-4", "Nuclear Ab titer by immunofluorescence", {
          valueString: "Negative",
        }),
      ],
    }),
  );
  assert.equal(signal.rating, 1);
  assert.equal(signal.ana.state, "not_met");
});

test("ANA, confirmed inflammatory arthritis, and anti-Sm reach level five", () => {
  const signal = evaluateLupusSignal(
    record({
      conditions: [
        {
          resourceType: "Condition",
          code: { text: "Inflammatory arthritis" },
          verificationStatus: { coding: [{ code: "confirmed" }] },
          onsetDateTime: "2025-09-01",
        },
      ],
      observations: [
        observation("5048-4", "Nuclear Ab titer by immunofluorescence", {
          valueString: "1:160",
        }),
        observation("11090-8", "Smith extractable nuclear Ab", {
          valueString: "Positive",
        }),
      ],
    }),
  );
  assert.equal(signal.rating, 5);
  assert.equal(signal.confirmedScore, 12);
  assert.equal(signal.ana.state, "met");
});

test("only the highest complement item contributes", () => {
  const signal = evaluateLupusSignal(
    record({
      observations: [
        observation("4485-9", "Complement C3", {
          valueQuantity: { value: 60, unit: "mg/dL" },
          interpretation: [{ coding: [{ code: "L" }] }],
        }),
        observation("4498-2", "Complement C4", {
          valueQuantity: { value: 5, unit: "mg/dL" },
          interpretation: [{ coding: [{ code: "L" }] }],
        }),
      ],
    }),
  );
  assert.equal(signal.confirmedScore, 4);
});

test("an existing lupus code is reported but does not manufacture points", () => {
  const signal = evaluateLupusSignal(
    record({
      conditions: [
        {
          resourceType: "Condition",
          code: { text: "Systemic lupus erythematosus" },
          verificationStatus: { coding: [{ code: "confirmed" }] },
        },
      ],
    }),
  );
  assert.equal(signal.existingDiagnosis, true);
  assert.equal(signal.confirmedScore, 0);
  assert.equal(signal.rating, 2);
});

test("a note-only concept stays possible", () => {
  const signal = evaluateLupusSignal(
    record({
      notes: [{ text: "Possible oral ulcers reported", sourceType: "DocumentReference" }],
    }),
  );
  const oralUlcers = signal.criteria.find((criterion) => criterion.id === "oral-ulcers");
  assert.equal(oralUlcers.state, "possible");
  assert.equal(signal.confirmedScore, 0);
  assert.equal(signal.potentialScore, 2);
});

test("temperature observations respect Fahrenheit units", () => {
  const normal = evaluateLupusSignal(
    record({
      observations: [
        observation("8310-5", "Body temperature", {
          valueQuantity: { value: 98.6, unit: "degF", code: "[degF]" },
        }),
      ],
    }),
  );
  const fever = evaluateLupusSignal(
    record({
      observations: [
        observation("8310-5", "Body temperature", {
          valueQuantity: { value: 102, unit: "degF", code: "[degF]" },
        }),
      ],
    }),
  );
  assert.equal(normal.criteria.find((criterion) => criterion.id === "fever").state, "unknown");
  assert.equal(fever.criteria.find((criterion) => criterion.id === "fever").state, "met");
});

// ---- adversarial-check counterexamples: overlapping names, negation, and units

const condition = (text, verification = "confirmed") => ({
  resourceType: "Condition",
  code: { text },
  verificationStatus: { coding: [{ code: verification }] },
  onsetDateTime: "2025-09-01",
});
const state = (signal, id) => signal.criteria.find((c) => c.id === id).state;
const mucocutaneous = (signal) => signal.domains.find((d) => d.domain === "Mucocutaneous");

test("subacute cutaneous lupus counts once, as the subacute criterion (4 points, not 6)", () => {
  const signal = evaluateLupusSignal(record({ conditions: [condition("Subacute cutaneous lupus erythematosus")] }));
  assert.equal(state(signal, "subacute-discoid"), "met");
  assert.equal(state(signal, "acute-cutaneous"), "unknown");
  assert.equal(mucocutaneous(signal).confirmed, 4);
  const acute = evaluateLupusSignal(record({ conditions: [condition("Acute cutaneous lupus")] }));
  assert.equal(state(acute, "acute-cutaneous"), "met");
  assert.equal(state(acute, "subacute-discoid"), "unknown");
  assert.equal(mucocutaneous(acute).confirmed, 6);
  const note = evaluateLupusSignal(record({ notes: [{ text: "Biopsy consistent with subacute cutaneous lupus.", sourceType: "DocumentReference" }] }));
  assert.equal(state(note, "acute-cutaneous"), "unknown");
  assert.equal(note.potentialScore, 4);
});

test("negated mentions do not count: 'No oral ulcers. No seizure. No pericarditis.' gives no points", () => {
  const signal = evaluateLupusSignal(record({ notes: [{ text: "No oral ulcers. No seizure. No pericarditis.", sourceType: "DocumentReference" }] }));
  for (const id of ["oral-ulcers", "seizure", "pericarditis"]) assert.equal(state(signal, id), "unknown", id);
  assert.equal(signal.potentialScore, 0);
  assert.deepEqual(signal.priorityFindings, []);
  for (const text of ["Patient denies seizure.", "Negative for oral ulcers or alopecia", "Without pericarditis",
    "Pericarditis was ruled out.", "No history of seizures, mouth ulcers, or pleural effusion", "Seizure: none"]) {
    const s = evaluateLupusSignal(record({ notes: [{ text, sourceType: "DocumentReference" }] }));
    assert.equal(s.potentialScore, 0, text);
  }
  // negation stops at the end of its clause
  const mixed = evaluateLupusSignal(record({ notes: [{ text: "No fever or rash, but reports a seizure last week.", sourceType: "DocumentReference" }] }));
  assert.equal(state(mixed, "seizure"), "possible");
  const affirmed = evaluateLupusSignal(record({ notes: [{ text: "Painful oral ulcers for two weeks.", sourceType: "DocumentReference" }] }));
  assert.equal(state(affirmed, "oral-ulcers"), "possible");
  // a negated or refuted lupus Condition is not an existing diagnosis
  assert.equal(evaluateLupusSignal(record({ conditions: [condition("Systemic lupus erythematosus", "refuted")] })).existingDiagnosis, false);
  assert.equal(evaluateLupusSignal(record({ conditions: [condition("SLE ruled out")] })).existingDiagnosis, false);
  assert.equal(evaluateLupusSignal(record({ conditions: [condition("Systemic lupus erythematosus")] })).existingDiagnosis, true);
});

test("white-cell and platelet counts are compared in 10^9/L whatever the unit", () => {
  const wbc = (value, unit, code) => observation("6690-2", "Leukocytes [#/volume] in Blood", { valueQuantity: { value, unit, code } });
  for (const [value, unit, code] of [[3, "10*9/L", "10*9/L"], [3000, "/uL", "/uL"], [3, "10*3/uL", "10*3/uL"], [3.0, "K/uL"], [3000, "cells/µL"], [3000, "/mm3"], [3000]]) {
    const s = evaluateLupusSignal(record({ observations: [wbc(value, unit, code)] }));
    assert.equal(state(s, "leukopenia"), "met", `${value} ${unit}`);
  }
  for (const [value, unit] of [[5, "10*9/L"], [5000, "/uL"], [4500]]) {
    assert.equal(state(evaluateLupusSignal(record({ observations: [wbc(value, unit)] })), "leukopenia"), "unknown", `${value} ${unit}`);
  }
  assert.match(evaluateLupusSignal(record({ observations: [wbc(1500, "/uL")] })).priorityFindings.join(" "), /white blood cell result below 2\.0/u);
  const plt = (value, unit) => observation("777-3", "Platelets [#/volume] in Blood", { valueQuantity: { value, unit } });
  assert.equal(state(evaluateLupusSignal(record({ observations: [plt(80000, "/uL")] })), "thrombocytopenia"), "met");
  assert.equal(state(evaluateLupusSignal(record({ observations: [plt(80, "10*3/uL")] })), "thrombocytopenia"), "met");
  assert.equal(state(evaluateLupusSignal(record({ observations: [plt(150000, "/uL")] })), "thrombocytopenia"), "unknown");
  assert.match(evaluateLupusSignal(record({ observations: [plt(45000, "/uL")] })).priorityFindings.join(" "), /platelet result below 50/u);
});
