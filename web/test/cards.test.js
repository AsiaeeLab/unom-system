import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ANSWER_EVIDENCE,
  buildDashboard,
  checkQuestionnaire,
  EFFECT_FULL_SCALE,
  CLINICAL_REFERENCES,
  lymeContext,
  LYME_NEXT_STEPS,
  LYME_SOURCE,
  modelFacts,
  MODEL_CARDS,
  notScoredSentence,
  patientPanelRows,
  questionnaireFromRecord,
  referenceParts,
  recordToBundle,
  reportedLines,
  scoreAll,
  selfHarmNotice,
  sortForReview,
  summarizeQuestionnaire,
  TABS,
  withAnswers,
} from "../web/athena/cards.js";
import { bundleToRecord, demoQuestionnaire } from "../web/clinician/demo.js";
import { buildQuestionnaireResponse } from "../web/patient/scoring.js";
import { demoState as demoQuestionnaireState } from "../web/patient/demo.js";

const site = join(dirname(fileURLToPath(import.meta.url)), "..", "web");
const json = (p) => JSON.parse(readFileSync(join(site, p), "utf8"));
const models = {
  longcovid: json("models/longcovid.json"),
  chronicfatigue: json("models/chronicfatigue.json"),
  fibromyalgia: json("models/fibromyalgia.json"),
  endometriosis: json("models/endometriosis.json"),
  lyme: json("models/lyme.json"),
  lupus: json("models/lupus.json"),
  migraine: json("models/migraine.json"),
  depression: json("models/depression.json"),
  anxiety: json("models/anxiety.json"),
};
const lyme = json("data/lyme_county.json");
const AS_OF = "2024-06-01";
const dashboard = (who, questionnaire = null) =>
  buildDashboard({ bundle: json(`data/patients/${who}.json`), models, lyme, asOf: AS_OF, questionnaire });

test("demo patients get the cards the demo script promises", () => {
  const maria = scoreAll(json("data/patients/maria.json"), models, AS_OF);
  assert.equal(maria[0].band, "High");
  assert.ok(maria[0].nextSteps.length > 0);
  assert.ok(maria[0].drivers.every((d) => d.dates.join() === [...d.dates].sort().join()));
  const elena = scoreAll(json("data/patients/elena.json"), models, AS_OF);
  assert.equal(elena[1].band, "High");
  assert.equal(elena[1].checklist.length, 4);
  const grace = scoreAll(json("data/patients/grace.json"), models, AS_OF);
  assert.equal(grace[1].status, "not_scored");
});

test("Sofia gets a High fibromyalgia card with the 2016 criteria", () => {
  const sofia = scoreAll(json("data/patients/sofia.json"), models, AS_OF);
  assert.equal(sofia[2].key, "fibromyalgia");
  assert.equal(sofia[2].band, "High");
  assert.equal(sofia[2].checklist.length, 4);
  assert.ok(sofia[2].drivers.some((d) => /Gabapentin/u.test(d.label)));
});

test("Typical cards carry no next steps", () => {
  const james = scoreAll(json("data/patients/james.json"), models, AS_OF);
  assert.equal(james[0].band, "Typical");
  assert.deepEqual(james[0].nextSteps, []);
});

test("demographics are context, never findings", () => {
  for (const who of ["maria", "elena", "sofia", "dana", "james"]) {
    for (const card of scoreAll(json(`data/patients/${who}.json`), models, AS_OF)) {
      assert.ok(card.drivers.every((d) => d.group !== "Demographics" && !/^(Female|Male|Age )/u.test(d.label)), `${who} ${card.key}`);
    }
  }
  const dana = scoreAll(json("data/patients/dana.json"), models, AS_OF);
  assert.deepEqual(dana[1].drivers.map((d) => d.label), ["Muscle or joint pain"]);
  assert.deepEqual(dana[1].context, ["Female", "Age 50-59"]);
});

test("not-scored reasons become plain sentences", () => {
  assert.equal(notScoredSentence("no documented COVID-19 index event"), "No COVID-19 on record, so the Long COVID card does not apply.");
  assert.equal(notScoredSentence("a Long COVID diagnosis is already recorded"), "Already diagnosed: Long COVID is recorded in the chart.");
  assert.equal(
    notScoredSentence("a chronic fatigue or ME/CFS diagnosis is already recorded"),
    "Already diagnosed: chronic fatigue or ME/CFS is recorded in the chart.",
  );
  assert.equal(notScoredSentence("a fibromyalgia diagnosis is already recorded"), "Already diagnosed: fibromyalgia is recorded in the chart.");
  assert.equal(notScoredSentence("no encounters in the past year (insufficient history)"), "Too little recent history to score.");
  assert.equal(notScoredSentence("no encounters in the year before COVID-19 (insufficient history)"), "Too little recent history to score.");
  assert.equal(
    notScoredSentence("fewer than 90 days since the COVID-19 index", { indexDate: "2024-04-01" }),
    "COVID-19 on April 1, 2024; the Long COVID card applies from day 90 (June 30, 2024).",
  );
  // every reason the scorer can return for the demo bundles maps to a sentence, never raw engine text
  for (const who of ["grace", "rosa", "nora", "lee", "omar", "elena", "dana"]) {
    for (const card of scoreAll(json(`data/patients/${who}.json`), models, AS_OF)) {
      if (card.status !== "not_scored") continue;
      assert.match(card.detail, /^(No COVID-19 on record|Already diagnosed|Too little recent history|COVID-19 on |The Endometriosis card covers women)/u, `${who} ${card.key}: ${card.detail}`);
    }
  }
});

test("eligibility and data-access reasons become plain sentences", () => {
  assert.equal(
    notScoredSentence("more than 455 days since the COVID-19 index (outside the model's time window)", { indexDate: "2023-01-10" }),
    "COVID-19 on January 10, 2023; the Long COVID card applies from day 90 to day 455 (April 10, 2023 to April 9, 2024), so this chart is past the model's time window.",
  );
  assert.equal(notScoredSentence("birth date missing or unusable (age is required)"), "No usable birth date on record; the card needs the patient's age.");
  assert.equal(notScoredSentence("under 18 at the COVID-19 index (the model covers adults)"), "The card covers adults; the patient was under 18 at the COVID-19 index.");
  assert.equal(notScoredSentence("under 18 on the scoring date (the model covers adults)"), "The card covers adults; the patient is under 18.");
  assert.equal(
    notScoredSentence("no documented COVID-19 index event on or after 2021-07-02 (earlier COVID-19 diagnoses are outside the model's population)"),
    "COVID-19 is on record only before July 2, 2021; the Long COVID card covers infections from that date on.",
  );
  assert.equal(
    notScoredSentence("could not score: Observation, Procedure unavailable"),
    "Could not score: the chart's Observation, Procedure records could not be read, so this card has no result. This is not a negative result.",
  );
  for (const who of ["priya", "sam", "theo", "yara", "vera", "will", "uma", "kai"]) {
    for (const card of scoreAll(json(`data/patients/${who}.json`), models, AS_OF)) {
      if (card.status !== "not_scored") continue;
      assert.match(card.detail, /^(Already diagnosed|COVID-19 on |No usable birth date|The card covers adults|The Endometriosis card covers women)/u, `${who} ${card.key}: ${card.detail}`);
    }
  }
});

test("a failed FHIR search makes the dependent cards 'could not score', never a typical result", () => {
  const bundle = json("data/patients/maria.json");
  const record = bundleToRecord(bundle);
  record.access = record.access.map((a) => (a.resourceType === "Observation" ? { ...a, status: "Not authorized", count: 0 } : a));
  record.resources.Observation = [];
  const d = buildDashboard({ bundle: recordToBundle(record), record, models, lyme, asOf: AS_OF });
  assert.deepEqual(d.unavailable, ["Observation"]);
  for (const s of d.scores) {
    assert.equal(s.result.status, "could_not_score", s.card.key);
    assert.equal(s.summary.headline, "Could not score");
    assert.match(s.summary.detail, /Observation records could not be read/u);
  }
  assert.deepEqual(d.needsReview.map((i) => i.slug), []);
  assert.deepEqual(d.couldNotScore, ["Long COVID", "Chronic fatigue (ME/CFS)", "Fibromyalgia", "Endometriosis", "Lyme disease", "Lupus", "Migraine", "Depression", "Anxiety"]);
  assert.ok(d.alsoChecked.filter((i) => i.kind === "model").every((i) => i.chip === "Could not score"));
  // Conditions unreadable: the Lyme rule cannot say "none found" either
  const noCond = bundleToRecord(bundle);
  noCond.access = noCond.access.map((a) => (a.resourceType === "Condition" ? { ...a, status: "Unavailable (HTTP 500)" } : a));
  const d2 = buildDashboard({ bundle, record: noCond, models, lyme, asOf: AS_OF });
  assert.equal(d2.lyme.chip, "Could not check");
  assert.match(d2.lyme.sentence, /Condition records could not be read/u);
  // restricted records (security labels) are read as available
  const restricted = bundleToRecord(bundle);
  restricted.access = restricted.access.map((a) => ({ ...a, status: "Available with restrictions" }));
  assert.deepEqual(buildDashboard({ bundle, record: restricted, models, lyme, asOf: AS_OF }).unavailable, []);
});

test("partial FHIR dates (YYYY, YYYY-MM) render and score instead of breaking the cards", () => {
  const bundle = json("data/patients/maria.json");
  const partial = JSON.parse(JSON.stringify(bundle));
  partial.entry[0].resource.birthDate = "1980";
  for (const e of partial.entry) if (e.resource.id === "maria-cond-18") e.resource.onsetDateTime = e.resource.recordedDate = "2024-03";
  const d = buildDashboard({ bundle: partial, models, lyme, asOf: AS_OF });
  assert.equal(d.patient.age, 43, "1980 is read as July 1, 1980");
  assert.equal(d.scores[0].result.status, "scored");
  assert.ok(d.timeline.events.some((e) => e.id === "maria-cond-18" && e.date === "2024-03-01"));
});

test("a scorer error becomes a could-not-score card instead of breaking the dashboard", () => {
  const broken = { ...models.longcovid, risk_bands: [{ name: "Typical", max_probability: 0 }] };
  const d = buildDashboard({ bundle: json("data/patients/maria.json"), models: { ...models, longcovid: broken }, lyme, asOf: AS_OF });
  assert.equal(d.scores[0].result.status, "could_not_score");
  assert.match(d.scores[0].summary.detail, /scorer stopped/u);
  assert.equal(d.scores[1].result.status, "scored");
});

test("needs review sorts High before Elevated before chart rules, by multiple of the average", () => {
  const items = [
    { kind: "rule", slug: "lyme", strength: 2 },
    { kind: "model", slug: "a", band: "Elevated", times: 2.9 },
    { kind: "model", slug: "b", band: "High", times: 3.2 },
    { kind: "model", slug: "c", band: "High", times: 9.8 },
    { kind: "rule", slug: "lupus", strength: 4 },
  ];
  assert.deepEqual(sortForReview(items).map((i) => i.slug), ["c", "b", "a", "lupus", "lyme"]);
  const sofia = dashboard("sofia");
  assert.deepEqual(sofia.needsReview.map((i) => i.slug), ["fibromyalgia", "lupus", "migraine", "depression", "mecfs", "lyme"]);
  assert.deepEqual(sofia.needsReview.map((i) => i.band), ["High", "High", "High", "High", "High", "Elevated"]);
  assert.ok(sofia.needsReview[0].times > sofia.needsReview[1].times);
});

test("dashboard sorts each demo patient into Needs review and Also checked", () => {
  const maria = dashboard("maria");
  assert.deepEqual(maria.needsReview.map((i) => i.slug), ["longcovid"]);
  assert.equal(maria.needsReview[0].top.length, 2);
  const checked = Object.fromEntries(maria.alsoChecked.map((i) => [i.slug, i.sentence]));
  assert.match(checked.lyme, /^Typical, \d\.\d× the average/u);
  assert.match(checked.lupus, /^Typical, \d\.\d× the average/u);
  assert.match(checked.mecfs, /^Typical, \d\.\d× the average/u);

  const elena = dashboard("elena");
  assert.deepEqual(elena.needsReview.map((i) => i.slug), ["mecfs", "anxiety", "migraine", "depression"]);
  assert.equal(elena.alsoChecked.find((i) => i.slug === "longcovid").sentence, "No COVID-19 on record, so the Long COVID card does not apply.");

  const dana = dashboard("dana");
  assert.deepEqual(dana.needsReview.map((i) => i.slug), ["lyme"]);
  assert.equal(dana.needsReview[0].kind, "model", "Lyme disease is a model card; the chart rule feeds its criteria column");
  const danaLyme = dana.scores.find((x) => x.card.key === "lyme").summary;
  assert.deepEqual(danaLyme.drivers.slice(0, 2).map((x) => x.id), ["cx_insect_bite", "rx_doxycycline"]);
  assert.equal(dana.lyme.context.county, "Dutchess County");
  assert.deepEqual(dana.lyme.features.map((f) => f.id), ["joint", "facial-palsy"]);
  assert.equal(dana.patient.place, "Dutchess County, NY");
  assert.equal(dana.patient.age, 52);

  for (const who of ["maria", "elena", "sofia", "dana"]) {
    const d = dashboard(who);
    assert.equal(d.needsReview.length + d.alsoChecked.length, MODEL_CARDS.length, who);
    assert.ok(d.alsoChecked.every((i) => typeof i.sentence === "string" && i.sentence.length > 0), who);
  }
});

test("timeline lists dated events in order, marks the scoring date, and COVID-19 index and day 90 for Long COVID", () => {
  const maria = dashboard("maria").timeline;
  assert.deepEqual(maria.markers.map((m) => [m.id, m.date]), [["covid", "2024-01-08"], ["day90", "2024-04-07"], ["asof", "2024-06-01"]]);
  const dates = maria.events.map((e) => e.date);
  assert.deepEqual(dates, [...dates].sort());
  assert.equal(maria.events.length, 25);
  assert.deepEqual(maria.events.find((e) => e.id === "maria-cond-18").citedBy, ["Long COVID"]);
  // typical cards do not cite events
  assert.ok(maria.events.every((e) => !e.citedBy.includes("ME/CFS")));
  const elena = dashboard("elena").timeline;
  assert.deepEqual(elena.markers.map((m) => m.id), ["asof"]);
});

test("model facts come from the model file; validation only where the file has it", () => {
  const lc = modelFacts(MODEL_CARDS[0], models.longcovid);
  assert.equal(lc.id, "unm-longcovid");
  assert.equal(lc.version, models.longcovid.version);
  assert.equal(lc.bands.length, 3);
  assert.match(lc.bands[0], /^Typical: up to 1\.5 times the average/u);
  assert.ok(lc.validation.some((v) => v.includes(models.longcovid.provenance.validation_split_evaluation.auroc.toFixed(3))));
  assert.ok(lc.validation.some((v) => /separately fitted \d+-feature version/u.test(v)), "the site evaluation names its feature count");
  assert.equal(modelFacts(MODEL_CARDS[1], models.chronicfatigue).validation, null);
  assert.equal(modelFacts(MODEL_CARDS[2], models.fibromyalgia).validation, null);
  assert.deepEqual(TABS.map((t) => t.slug), ["longcovid", "mecfs", "fibromyalgia", "endometriosis", "lyme", "lupus", "migraine", "depression", "anxiety", "timeline"]);
  for (const card of MODEL_CARDS) {
    // Lyme disease and lupus show their chart rules' evidence in place of a checklist
    if (card.checklist) assert.match(card.checklistSourceUrl, /^https:\/\/(?:doi\.org|www\.)/u);
    else assert.ok(["lyme", "lupus"].includes(card.key), card.key);
    assert.match(card.guide, /^\/developers\/models#[a-z-]+$/u);
  }
});

test("every named clinical source in visible dashboard prose becomes a link", () => {
  const namedSteps = [...MODEL_CARDS.flatMap((card) => card.nextSteps), ...LYME_NEXT_STEPS]
    .filter((text) => /NASEM|RECOVER|DePaul|IOM|fibromyalgia diagnostic criteria|CDC's/u.test(text));
  const prose = [
    ...namedSteps,
    "RECOVER 2024 index",
    "DePaul PEM screen",
    "Long COVID self-check (NASEM 2024 time criterion)",
    "ME/CFS self-check (IOM 2015 core symptoms)",
    "Fibromyalgia self-check (2016 criteria)",
    "Post-COVID-19 Functional Status",
    "CDC, 2015 to 2019 and CDC testing guidance",
    "2019 EULAR/ACR criteria",
  ];
  for (const text of prose) {
    const links = referenceParts(text).filter((part) => typeof part !== "string");
    assert.ok(links.length, `no clinical reference link in: ${text}`);
    for (const link of links) assert.match(link.href, /^https:\/\//u);
  }
  assert.equal(new Set(CLINICAL_REFERENCES.map(([label]) => label)).size, CLINICAL_REFERENCES.length);
});

// Copy rules for the text the cards show: no em dashes, no exclamation marks, no marketing words.
const BANNED = /\b(?:seamless\w*|leverag\w*|robust\w*|comprehensive\w*|empower\w*|unlock\w*|delve\w*|cutting-edge|game-chang\w*|journey\w*|harness\w*|effortless\w*)\b/iu;

test("model card, Lyme, lupus, and dashboard text follow the copy rules", () => {
  const shown = [...LYME_NEXT_STEPS, LYME_SOURCE];
  for (const card of MODEL_CARDS) {
    shown.push(card.title, card.tab, card.target, card.estimate, card.checklistSource, ...card.nextSteps, ...(card.checklist || []), ...card.limits);
    const facts = modelFacts(card, models[card.key]);
    shown.push(facts.calibration, ...facts.bands, ...(facts.validation || []));
  }
  for (const who of ["maria", "elena", "sofia", "dana", "james", "grace", "rosa", "nora", "lee", "omar"]) {
    const d = dashboard(who);
    for (const i of d.items) shown.push(i.title, i.chip, i.sentence, i.metric, i.headline);
    for (const s of d.scores) shown.push(s.summary.headline, s.summary.detail);
    shown.push(d.lupus.signal.title, d.lupus.signal.summary, ...d.lupus.signal.gaps, ...d.lupus.signal.priorityFindings);
    shown.push(...d.lyme.features.map((f) => f.label));
  }
  for (const text of shown.filter((t) => typeof t === "string")) {
    assert.doesNotMatch(text, /[—!]/u, text);
    assert.doesNotMatch(text, BANNED, text);
  }
  // the whole source of the card, Lyme, and lupus code, comments included
  for (const file of ["athena/cards.js", "athena/rule.js", "athena/lyme-rule.js", "athena/app.js", "athena/index.html"]) {
    const src = readFileSync(join(site, file), "utf8");
    assert.doesNotMatch(src, /—/u, file);
    assert.doesNotMatch(src, BANNED, file);
  }
});

test("model limits state what the scores do not establish", () => {
  const [lc, cf, fm] = MODEL_CARDS;
  for (const card of MODEL_CARDS) {
    assert.ok(card.limits.some((l) => /Decision support for clinician review of a single chart/u.test(l)), card.key);
    assert.ok(card.limits.some((l) => /descriptive score categories, not validated action thresholds/u.test(l)), card.key);
  }
  assert.ok(lc.limits.some((l) => /not Long COVID symptoms specifically/u.test(l)));
  assert.ok(cf.limits.some((l) => /does not establish ME\/CFS/u.test(l)));
  assert.ok(fm.limits.some((l) => /self-reported fibromyalgia diagnosis/u.test(l)));
  const site18 = modelFacts(lc, models.longcovid).validation.find((v) => /held-out sites/u.test(v));
  assert.match(site18, /separately fitted \d+-feature version/u);
  assert.match(site18, /not externally validated/u);
});

test("Lyme context uses the county when the address has one", () => {
  const dana = lymeContext(json("data/patients/dana.json"), lyme);
  assert.equal(dana.county, "Dutchess County");
  assert.equal(dana.band, "high");
  assert.equal(lymeContext(json("data/patients/maria.json"), lyme), null);
});

test("record and bundle round trip keeps every resource", () => {
  const bundle = json("data/patients/elena.json");
  const back = recordToBundle(bundleToRecord(bundle));
  assert.equal(back.entry.length, bundle.entry.length);
  assert.deepEqual(scoreAll(back, models, AS_OF), scoreAll(bundle, models, AS_OF));
});

test("patient app QuestionnaireResponse is read back by the clinician dashboard", () => {
  const state = {
    respondent: "self",
    timeline: { onset: "2024-02-01", covid: "yes", covidDate: "2024-01-08", symptoms: "Crashes after errands" },
    pcfs: 3,
    questions: ["Could this be Long COVID?"],
  };
  const qr = buildQuestionnaireResponse(state, { authored: "2024-05-30T10:00:00Z" });
  const q = summarizeQuestionnaire(qr);
  assert.equal(q.authored, "2024-05-30");
  assert.equal(q.covidDate, "2024-01-08");
  assert.equal(q.onset, "2024-02-01");
  assert.equal(q.pcfsGrade, "3");
  assert.deepEqual(q.questions, ["Could this be Long COVID?"]);
  assert.equal(questionnaireFromRecord({ resources: { QuestionnaireResponse: [qr] } }), qr);
  assert.equal(summarizeQuestionnaire({ resourceType: "Patient" }), null);
});

test("questionnaire import: our canonical Questionnaire, a supported version, and the right patient only", () => {
  const qr = buildQuestionnaireResponse(demoQuestionnaireState("maria"), { authored: "2024-05-30T10:00:00Z" });
  assert.deepEqual(checkQuestionnaire(qr), { ok: true, reason: null, anonymous: true, version: "1.3.0" });
  for (const v of ["1.0.0", "1.1.0", "1.2.0"]) assert.equal(checkQuestionnaire({ ...qr, questionnaire: qr.questionnaire.replace(/\|.*$/u, `|${v}`) }).ok, true, v);
  const bad = (patch, opts) => checkQuestionnaire({ ...qr, ...patch }, opts);
  assert.match(bad({ questionnaire: "https://undiagnosednomore.org/fhir/Questionnaire/other|1.2.0" }).reason, /does not answer/u);
  assert.match(bad({ questionnaire: "https://undiagnosednomore.org/fhir/Questionnaire/unm-patient-symptom-check|9.0.0" }).reason, /not supported/u);
  assert.match(bad({ questionnaire: "https://undiagnosednomore.org/fhir/Questionnaire/unm-patient-symptom-check" }).reason, /not supported/u);
  assert.match(bad({ status: "entered-in-error" }).reason, /entered-in-error/u);
  assert.match(bad({ subject: { reference: "Patient/rosa" } }, { patientId: "maria" }).reason, /different patient/u);
  assert.match(bad({ subject: { reference: "Group/7" } }).reason, /not a patient/u);
  assert.deepEqual(bad({ subject: { reference: "Patient/maria" } }, { patientId: "maria" }), { ok: true, reason: null, anonymous: false, version: "1.3.0" });
  assert.equal(checkQuestionnaire({ resourceType: "Patient" }).ok, false);
});

test("from the record: the most recent matching response, skipping other questionnaires, versions, and patients", () => {
  const make = (authored, patch = {}) => ({ ...buildQuestionnaireResponse(demoQuestionnaireState("maria"), { authored }), ...patch });
  const older = make("2024-03-01T10:00:00Z", { id: "older" });
  const newer = make("2024-05-01T10:00:00Z", { id: "newer", subject: { reference: "Patient/maria" } });
  const otherForm = make("2024-05-20T10:00:00Z", { id: "other-form", questionnaire: "https://example.org/Questionnaire/phq9|1.0.0" });
  const otherPatient = make("2024-05-25T10:00:00Z", { id: "other-patient", subject: { reference: "Patient/rosa" } });
  const future = make("2024-05-28T10:00:00Z", { id: "unsupported", questionnaire: "https://undiagnosednomore.org/fhir/Questionnaire/unm-patient-symptom-check|2.0.0" });
  const record = { patient: { id: "maria" }, resources: { QuestionnaireResponse: [newer, otherForm, older, otherPatient, future] } };
  assert.equal(questionnaireFromRecord(record).id, "newer");
  assert.equal(questionnaireFromRecord({ patient: { id: "maria" }, resources: { QuestionnaireResponse: [otherPatient, otherForm] } }), null);
});

test("RECOVER range on the dashboard only when every symptom was answered, also for older files", () => {
  const state = { ...demoQuestionnaireState("maria") };
  const full = summarizeQuestionnaire(buildQuestionnaireResponse(state, { authored: "2024-05-30T10:00:00Z" }));
  assert.equal(full.recoverComplete, true);
  assert.equal(full.recoverRange, "11 or more points");
  const partial = { ...state, recover: { ...state.recover } };
  delete partial.recover.cough;
  const qr = buildQuestionnaireResponse(partial, { authored: "2024-05-30T10:00:00Z" });
  const q = summarizeQuestionnaire(qr);
  assert.equal(q.recoverComplete, false);
  assert.match(Object.fromEntries(patientPanelRows(q))["RECOVER 2024 index"], /^16 points so far \(incomplete: 10 of 11 symptoms answered, so no range\)/u);
  // a version 1.1.0 file that still carried a range after partial answers is read as incomplete
  const old = JSON.parse(JSON.stringify(qr));
  old.questionnaire = old.questionnaire.replace(/\|1\.3\.0$/u, "|1.1.0");
  const cat = old.item.find((i) => i.linkId === "recover").item.find((i) => i.linkId === "recover.category");
  cat.answer = [{ valueCoding: { system: "https://undiagnosednomore.org/fhir/CodeSystem/recover-2024-range", code: "likely", display: "11 or more points" } }];
  assert.match(summarizeQuestionnaire(old).recoverRange, /^incomplete/u);
});

test("From the patient shows RECOVER only after COVID-19, plus the PEM screen and PCFS", () => {
  const maria = Object.fromEntries(patientPanelRows(summarizeQuestionnaire(demoQuestionnaire("maria"))));
  assert.match(maria["RECOVER 2024 index"], /^16 points/u);
  assert.match(maria["DePaul PEM screen"], /^Meets the screening rule/u);
  assert.match(maria["Post-COVID-19 Functional Status"], /^Grade 3 of 4/u);
  const elena = Object.fromEntries(patientPanelRows(summarizeQuestionnaire(demoQuestionnaire("elena"))));
  assert.equal(elena["RECOVER 2024 index"], undefined);
  assert.equal(elena["Post-COVID-19 Functional Status"], undefined);
  assert.match(elena["DePaul PEM screen"], /^Meets the screening rule/u);
  const d = dashboard("dana", demoQuestionnaire("dana"));
  assert.deepEqual(d.questionnaire.questions, ["Could this be Lyme disease?", "Do I need a blood test or treatment now?"]);
});


// The patient's answers update the chart estimate by Bayes' rule with one published likelihood ratio per
// condition; the chart-only values stay visible, and each chart finding's odds ratio does not change.
test("answers fold into the estimate: odds times the published likelihood ratio, band and times recomputed", () => {
  const odds = (p) => p / (1 - p);
  const chartOnly = dashboard("maria").scores.find((s) => s.card.key === "longcovid").summary;
  const combined = dashboard("maria", demoQuestionnaire("maria")).scores.find((s) => s.card.key === "longcovid").summary;
  assert.equal(chartOnly.answer, undefined);
  assert.equal(combined.answer.label, "RECOVER 2024 index");
  assert.equal(combined.answer.lr, ANSWER_EVIDENCE.longcovid.lr.positive);
  assert.ok(Math.abs(odds(combined.probability) / odds(chartOnly.probability) - combined.answer.lr) < 1e-9);
  assert.equal(combined.chart.probability, chartOnly.probability);
  assert.ok(Math.abs(combined.times - combined.probability / models.longcovid.reference.cohort_base_rate) < 1e-9);
  const band = models.longcovid.risk_bands.find((b) => combined.probability <= b.max_probability).name;
  assert.equal(combined.band, band);
  assert.match(combined.headline, /chart and answers/u);
  combined.drivers.forEach((d, i) => {
    assert.ok(Math.abs(d.effect.oddsRatio - chartOnly.drivers[i].effect.oddsRatio) < 1e-12, d.label);
    assert.ok(Math.abs(odds(d.effect.without) / odds(chartOnly.drivers[i].effect.without) - combined.answer.lr) < 1e-9, d.label);
  });
});

test("a negative answer lowers the estimate, an unanswered check leaves it alone, and only three conditions combine", () => {
  const odds = (p) => p / (1 - p);
  assert.deepEqual(Object.keys(ANSWER_EVIDENCE).sort(), ["chronicfatigue", "fibromyalgia", "longcovid"]);
  for (const e of Object.values(ANSWER_EVIDENCE)) {
    assert.ok(e.lr.positive > 1 && e.lr.negative < 1, e.label);
    assert.match(e.url, /^https:\/\/doi\.org\/10\./u);
  }
  const qr = demoQuestionnaire("sofia");
  const base = summarizeQuestionnaire(qr);
  assert.equal(ANSWER_EVIDENCE.fibromyalgia.result(base), "positive");
  assert.equal(ANSWER_EVIDENCE.fibromyalgia.result({ ...base, checkFibroCode: "no-match" }), "negative");
  assert.equal(ANSWER_EVIDENCE.fibromyalgia.result({ ...base, checkFibroCode: "unsure" }), null);
  assert.equal(ANSWER_EVIDENCE.longcovid.result({ ...base, recoverComplete: false }), null);
  const sofia = dashboard("sofia", qr).scores.find((s) => s.card.key === "fibromyalgia").summary;
  assert.ok(Math.abs(odds(sofia.probability) / odds(sofia.chart.probability) - 8.46) < 1e-9);
  assert.equal(EFFECT_FULL_SCALE, 2);
});

// PHQ-9 and GAD-7 (questionnaire version 1.3.0): shown to the clinician, never combined with a chart estimate.
const phqState = (phq9, gad7, chosen = { phq9: true, gad7: true }) => ({
  ...demoQuestionnaireState("elena"),
  checks: { ...demoQuestionnaireState("elena").checks, chosen: { ...demoQuestionnaireState("elena").checks.chosen, ...chosen }, phq9, gad7 },
});
const phqAnswers = (values, extra = {}) => ({ ...Object.fromEntries(values.map((v, i) => [String(i + 1), v])), ...extra });

test("From the patient: PHQ-9 and GAD-7 totals and bands, the item-9 notice, and the depression and anxiety lines", () => {
  const phq9 = phqAnswers([2, 2, 1, 3, 0, 1, 1, 0, 1], { difficulty: "somewhat" });
  const gad7 = phqAnswers([1, 1, 1, 0, 0, 1, 0]);
  const q = summarizeQuestionnaire(buildQuestionnaireResponse(phqState(phq9, gad7), { authored: "2026-10-15T12:00:00Z" }));
  assert.deepEqual(
    [q.phq9Total, q.phq9BandCode, q.phq9Band, q.phq9Item9, q.phq9SelfHarm, q.phq9Difficulty, q.phq9Answered],
    ["11", "10-14", "10 to 14: moderate depression", "Several days", true, "Somewhat difficult", 9],
  );
  assert.deepEqual([q.gad7Total, q.gad7BandCode, q.gad7Band, q.gad7Answered], ["4", "0-4", "0 to 4: below the cutpoint for mild anxiety", 7]);
  const rows = Object.fromEntries(patientPanelRows(q));
  assert.equal(rows["PHQ-9 (depression severity)"], "11 of 27 (10 to 14: moderate depression); question 9 (thoughts of being better off dead or of self-harm): Several days; difficulty at work, at home, or with other people: Somewhat difficult");
  assert.equal(rows["GAD-7 (anxiety severity)"], "4 of 21 (0 to 4: below the cutpoint for mild anxiety)");
  // item 9 positive: a plain notice at the top of From the patient (above the answers, which the demo collapses)
  assert.equal(selfHarmNotice(q), "PHQ-9 question 9: the patient answered \"Several days\" to thoughts that they would be better off dead or of hurting themselves in some way.");
  const src = readFileSync(join(site, "athena/cards.js"), "utf8");
  const panel = src.slice(src.indexOf("function renderPatientPanel"), src.indexOf("function importControl"));
  assert.ok(panel.indexOf("selfHarmNotice(q)") > 0 && panel.indexOf("selfHarmNotice(q)") < panel.indexOf("const sourceLine") && panel.indexOf("const sourceLine") < panel.indexOf("Review responses"));
  assert.match(panel, /h\("p", \{ class: "dash-notice", role: "note" \}, selfHarm\)/u);
  for (const v of [1, 2, 3]) {
    const one = summarizeQuestionnaire(buildQuestionnaireResponse(phqState(phqAnswers([0, 0, 0, 0, 0, 0, 0, 0, v]), {}, { phq9: true }), { authored: "2026-10-15T12:00:00Z" }));
    assert.equal(one.phq9SelfHarm, true, `item 9 = ${v}`);
    assert.match(selfHarmNotice(one), /^PHQ-9 question 9: the patient answered "(Several days|More than half the days|Nearly every day)"/u);
  }
  const zero = summarizeQuestionnaire(buildQuestionnaireResponse(phqState(phqAnswers([3, 3, 3, 3, 3, 3, 3, 3, 0]), {}, { phq9: true }), { authored: "2026-10-15T12:00:00Z" }));
  assert.deepEqual([zero.phq9SelfHarm, selfHarmNotice(zero), zero.phq9Total], [false, null, "24"]);
  // only question 9 answered: flagged, and the PHQ-9 says how far the patient got
  const only9 = summarizeQuestionnaire(buildQuestionnaireResponse(phqState({ 9: 3 }, {}, { phq9: true }), { authored: "2026-10-15T12:00:00Z" }));
  assert.equal(only9.phq9SelfHarm, true);
  assert.match(Object.fromEntries(patientPanelRows(only9))["PHQ-9 (depression severity)"], /^Not finished: 1 of 9 items answered, so no total; question 9 [^:]+: Nearly every day$/u);
  // the depression and anxiety cards (keys "depression" and "anxiety") list the answers
  assert.deepEqual(reportedLines("depression", q), [`PHQ-9: ${rows["PHQ-9 (depression severity)"]}`]);
  assert.deepEqual(reportedLines("anxiety", q), ["GAD-7: 4 of 21 (0 to 4: below the cutpoint for mild anxiety)"]);
  assert.deepEqual(reportedLines("fibromyalgia", { ...q, symptoms: null }), []);
  // never combined: no likelihood ratio for depression or anxiety, so a summary passes through unchanged
  assert.equal(ANSWER_EVIDENCE.depression, undefined);
  assert.equal(ANSWER_EVIDENCE.anxiety, undefined);
  const sm = { status: "scored", key: "depression", probability: 0.1, drivers: [] };
  assert.equal(withAnswers(sm, q, { nextSteps: [] }, null), sm);
  // a file without the new checks (the demo people, or an older version) has none of this
  const elena = summarizeQuestionnaire(demoQuestionnaire("elena"));
  assert.deepEqual([elena.phq9Answered, elena.phq9SelfHarm, selfHarmNotice(elena), reportedLines("depression", elena), reportedLines("anxiety", elena)], [0, false, null, [], []]);
  assert.ok(!patientPanelRows(elena).some(([label]) => /PHQ-9|GAD-7/u.test(label)));
});
