import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { evaluateLymeFeatures, ICD10CM } from "../web/athena/lyme-rule.js";
import { lymeSummary } from "../web/athena/cards.js";

const json = (p) => JSON.parse(readFileSync(new URL(`../web/${p}`, import.meta.url), "utf8"));
const lyme = json("data/lyme_county.json");
const condition = (id, code, display, date = "2024-05-01", extra = {}) => ({
  resourceType: "Condition",
  id,
  code: { coding: [{ system: ICD10CM, code, display }], text: display },
  onsetDateTime: date,
  ...extra,
});

test("Dana gets her knee and facial nerve features with dates", () => {
  const r = evaluateLymeFeatures(json("data/patients/dana.json"));
  assert.deepEqual(r.alreadyCoded, []);
  assert.deepEqual(r.features.map((f) => f.id), ["joint", "facial-palsy"]);
  assert.deepEqual(r.features[0].findings, [{ id: "dana-cond-9", date: "2024-05-20", code: "M25.561", display: "Pain in right knee", resourceType: "Condition" }]);
  assert.equal(r.features[1].findings[0].code, "G51.0");
  assert.equal(r.features[1].findings[0].date, "2024-05-28");
  const s = lymeSummary(json("data/patients/dana.json"), lyme);
  assert.equal(s.review, true);
  assert.equal(s.headline, "2 features consistent with Lyme disease");
});

test("Maria, Elena, and Sofia have no Lyme features", () => {
  for (const who of ["maria", "elena", "sofia"]) {
    const r = evaluateLymeFeatures(json(`data/patients/${who}.json`));
    assert.equal(r.featureCount, 0, who);
    assert.deepEqual(r.alreadyCoded, [], who);
  }
  const s = lymeSummary(json("data/patients/maria.json"), lyme);
  assert.equal(s.review, false);
  assert.equal(s.sentence, "No Lyme features or address on file.");
});

test("each feature type matches its codes, and only those", () => {
  const r = evaluateLymeFeatures([
    condition("a", "M25.462", "Effusion, left knee"),
    condition("b", "M13.0", "Polyarthritis, unspecified"),
    condition("c", "I44.2", "Atrioventricular block, complete"),
    condition("d", "I40.9", "Acute myocarditis, unspecified"),
    condition("e", "G03.9", "Meningitis, unspecified"),
    condition("f", "M54.16", "Radiculopathy, lumbar region"),
    condition("g", "I44.7", "Left bundle-branch block, unspecified"),
    condition("h", "M25.511", "Pain in right shoulder"),
    condition("i", "L53.9", "Erythematous condition, unspecified"),
  ]);
  const ids = Object.fromEntries(r.features.map((f) => [f.id, f.findings.map((x) => x.id)]));
  assert.deepEqual(ids, { joint: ["b", "a"].sort(), carditis: ["c", "d"], neuro: ["e", "f"] });
});

test("erythema migrans is found by its words; refuted diagnoses are ignored", () => {
  const r = evaluateLymeFeatures([
    condition("em", "A69.20", "Lyme disease, unspecified", "2024-05-02", { code: { coding: [{ system: ICD10CM, code: "A69.20", display: "Lyme disease, unspecified" }], text: "Erythema migrans, left thigh" } }),
    condition("x", "G51.0", "Bell's palsy", "2024-05-03", { verificationStatus: { coding: [{ code: "refuted" }] } }),
  ]);
  assert.deepEqual(r.features.map((f) => f.id), ["erythema-migrans"]);
  assert.equal(r.alreadyCoded.length, 1);
  assert.equal(r.alreadyCoded[0].code, "A69.20");
});

test("Lyme disease already coded goes to Also checked with a plain sentence", () => {
  const bundle = { entry: [{ resource: condition("l", "A69.23", "Arthritis due to Lyme disease") }] };
  const s = lymeSummary(bundle, lyme);
  assert.equal(s.review, false);
  assert.equal(s.sentence, "Already diagnosed: Lyme disease is recorded in the chart.");
});

test("a single feature with no address stays under Also checked", () => {
  const s = lymeSummary({ entry: [{ resource: condition("k", "M25.561", "Pain in right knee") }] }, lyme);
  assert.equal(s.review, false);
  assert.match(s.sentence, /no address on file/u);
});
