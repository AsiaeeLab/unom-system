import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";

import { CHANGE, CHECKS, CHECK_ORDER, INSTRUMENT_URLS, PCFS, PEM, RECOVER } from "../web/patient/instruments.js";
import {
  buildQuestionnaireResponse,
  checkLongCovid,
  checkLyme,
  chosenChecks,
  crisisText,
  describeCheck,
  describePcfs,
  describePem,
  describeRecover,
  formatDate,
  gradePcfs,
  linkIds,
  pemTimeframeNote,
  phq9SelfHarm,
  scoreGad7,
  scorePhq9,
  scoreRecover,
  scoreScale,
  screenPem,
  triage,
} from "../web/patient/scoring.js";
import { PERSONAS, lymeNote, orderSummaries, plainLabel, summarizeRecord } from "../web/patient/records.js";
import {
  DEMO_ANSWERS,
  HANDOFF_KEY,
  clinicianUrl,
  currentPersona,
  demoState,
  exportInclude,
  handoffPayload,
  parsePatientRoute,
  stateForManualSymptomCheck,
  wantsReset,
  withoutReset,
  writeHandoff,
} from "../web/patient/demo.js";
import { KEY, PERSONAL_KEY, TRIALS_KEY, clearAll, emptyState, load, loadPersonal, save, savePersonal } from "../web/patient/storage.js";
import { buildTrialsUrl, parseStudies, phaseText, resolveLocation, zipToState } from "../web/patient/trials.js";
import { EN } from "../web/patient/strings-en.js";
import { ES } from "../web/patient/strings-es.js";
import { plainText, translator } from "../web/patient/i18n.js";
import { buildSummarySignals } from "../web/patient/summary.js";

const repo = new URL("../../", import.meta.url);
const read = (p) => readFileSync(new URL(p, repo), "utf8");
const patientDir = new URL("web/web/patient/", repo);

const yesTo = (...ids) => Object.fromEntries(RECOVER.items.map((i) => [i.id, ids.includes(i.id) ? "yes" : "no"]));

// ---------- RECOVER ----------

test("RECOVER item names and points match Part A of submission/app_questionnaire.md", () => {
  const spec = read("submission/app_questionnaire.md");
  const start = spec.indexOf("### Part A.");
  const partA = spec.slice(start, spec.indexOf("\n#", start + 1));
  const rows = [...partA.matchAll(/^\| ([A-Z][^|]*?) \| [^|]+? \| (\d+) \|/gmu)]
    .map((m) => ({ name: m[1].toLowerCase(), points: Number(m[2]) }));
  assert.equal(rows.length, 11);
  assert.deepEqual(
    RECOVER.items.map((i) => ({ name: i.name.toLowerCase(), points: i.points })),
    rows,
  );
  assert.match(spec, /11 or more = "likely Long COVID"/u);
  assert.equal(RECOVER.cutoff, 11);
});

test("RECOVER points and published ranges", () => {
  assert.equal(scoreRecover({}).category, "not-started");
  const none = scoreRecover(yesTo());
  assert.deepEqual([none.points, none.category, none.complete], [0, "none", true]);
  assert.equal(scoreRecover(yesTo("brain-fog")).points, 3);
  const ten = scoreRecover(yesTo("pem", "cough"));
  assert.deepEqual([ten.points, ten.category, ten.meetsCutoff], [10, "possible", false]);
  const eleven = scoreRecover(yesTo("pem", "cough", "fatigue"));
  assert.deepEqual([eleven.points, eleven.category, eleven.meetsCutoff], [11, "likely", true]);
  assert.equal(scoreRecover(yesTo("smell-taste", "pem")).points, 13);
  const all = scoreRecover(yesTo(...RECOVER.items.map((i) => i.id)));
  assert.equal(all.points, 30);
  assert.equal(all.maxPoints, 30);
  // booleans are accepted; partial answers are counted
  const partial = scoreRecover({ "smell-taste": true, thirst: false });
  assert.deepEqual([partial.points, partial.answeredCount, partial.complete], [7, 2, false]);
  assert.match(describeRecover(partial).body, /may go up/u);
});

test("RECOVER: no none/possible/likely range until every symptom is answered", () => {
  const all = (ids) => Object.fromEntries(RECOVER.items.map((i) => [i.id, ids.includes(i.id) ? "yes" : "no"]));
  for (const skip of RECOVER.items.map((i) => i.id)) {
    for (const yes of [[], ["cough"], ["smell-taste", "pem"]]) {
      const answers = all(yes);
      delete answers[skip];
      const r = scoreRecover(answers);
      assert.equal(r.category, "incomplete", `${skip} skipped, yes to ${yes}`);
      const d = describeRecover(r, "yes");
      for (const text of [d.headline, d.short]) assert.doesNotMatch(text, /likely|possible|\bnone\b/iu, text);
      assert.match(d.headline, /so far: 10 of 11 answered/u);
      assert.match(d.body, /shown only when every symptom is answered/u);
    }
  }
  // 13 points with one symptom skipped: still incomplete, but the exploratory triage rule counts it (points only add)
  const high = all(["smell-taste", "pem"]);
  delete high.thirst;
  const r = scoreRecover(high);
  assert.deepEqual([r.points, r.category, r.meetsCutoff], [13, "incomplete", true]);
  assert.deepEqual(triage({ recover: r, covid: "yes" }).reasons, ["recover"]);
  // the QuestionnaireResponse says "incomplete" instead of a range
  const qr = buildQuestionnaireResponse({ timeline: { covid: "yes" }, recover: high }, { authored: "2024-06-01T00:00:00Z" });
  const cat = qr.item.find((i) => i.linkId === "recover").item.find((i) => i.linkId === "recover.category").answer[0].valueCoding;
  assert.equal(cat.code, "incomplete");
  assert.match(cat.display, /^Incomplete: 10 of 11 symptoms answered/u);
  assert.match(qr.questionnaire, /\|1\.3\.0$/u);
  // all answered: the published ranges again
  assert.equal(scoreRecover(all(["smell-taste", "pem"])).category, "likely");
});

test("the combined chart-and-questionnaire triage is labeled exploratory in the app", async () => {
  const { TRIAGE_EXPLORATORY } = await import("../web/patient/scoring.js");
  assert.match(TRIAGE_EXPLORATORY, /exploratory/u);
  const app = readFileSync(new URL("app.js", patientDir), "utf8");
  // the tag and the note come from the string tables, in both languages
  assert.equal(EN["results.flag.tag"], "Exploratory rule");
  assert.equal(EN["triage.exploratory"], TRIAGE_EXPLORATORY);
  assert.match(ES["results.flag.tag"], /exploratoria/u);
  assert.match(ES["triage.exploratory"], /exploratoria/u);
  assert.match(app, /h\("span", \{ class: "tag" \}, t\("results\.flag\.tag"\)\)/u);
  assert.match(app, /h\("p", \{ class: "note" \}, t\("triage\.exploratory"\)\)/u);
});

test("RECOVER result text frames 11+ as the published research index", () => {
  const d = describeRecover(scoreRecover(yesTo("smell-taste", "pem")));
  assert.match(d.body, /RECOVER 2024 research index/u);
  assert.match(d.body, /11 points or more/u);
  assert.match(d.body, /clinician/u);
  assert.doesNotMatch(d.body, /you have long covid/iu);
});

test("RECOVER items carry the questionnaire wording; severity-scored items are flagged in the result", () => {
  for (const it of RECOVER.items) assert.ok(it.text && it.text.length >= it.name.length - 10, it.id);
  assert.deepEqual(
    RECOVER.items.filter((i) => i.severity).map((i) => i.id).sort(),
    ["brain-fog", "chest-pain", "fatigue"],
  );
  const without = describeRecover(scoreRecover(yesTo("smell-taste", "pem")));
  assert.doesNotMatch(without.body, /severity/u);
  const withFog = describeRecover(scoreRecover(yesTo("smell-taste", "brain-fog")));
  assert.ok(withFog.body.endsWith(RECOVER.severityNote));
  assert.match(withFog.short, /without the index's severity scores/u);
});

test("the sleep index item has no full-survey context note in the patient form", () => {
  const sleep = RECOVER.items.find((item) => item.id === "snoring");
  assert.equal(sleep.help, "");
  assert.doesNotMatch(sleep.text, /follows a question/iu);
});

// ---------- PEM ----------

const pemAll = (pairs) => Object.fromEntries(pairs.map(([f, s], i) => [i + 1, { frequency: f, severity: s }]));

test("final-page signals distinguish a partial zero from a completed low score and a confirmed high score", () => {
  const base = { recoverApplicable: true, pem: screenPem(), pcfs: null, pcfsApplicable: false };
  const signal = (recover) => buildSummarySignals({ ...base, recover })[0];
  const partialZero = signal(scoreRecover({ cough: "no" }));
  assert.deepEqual([partialZero.tone, partialZero.status, partialZero.zero, partialZero.value], ["watch", "incomplete", true, "0 points so far"]);
  assert.match(partialZero.advice, /may rise/u);
  const completeZero = signal(scoreRecover(yesTo()));
  assert.deepEqual([completeZero.tone, completeZero.status, completeZero.value], ["low", "low", "0 points"]);
  const high = signal(scoreRecover({ "smell-taste": "yes", pem: "yes" }));
  assert.deepEqual([high.tone, high.status, high.value], ["review", "review", "13 points so far"]);
  assert.deepEqual([high.condition, high.label], ["Long COVID", "RECOVER symptom score"]);
  assert.match(high.advice, /Long COVID research cutoff of 11/u);
  assert.match(signal(scoreRecover(yesTo("smell-taste", "pem"))).advice, /may run high without severity questions/u);
  const noCovid = buildSummarySignals({ ...base, recover: scoreRecover(yesTo("pem")), recoverApplicable: false })[0];
  assert.deepEqual([noCovid.tone, noCovid.value], ["unscored", "Not scored"]);
  const noCovidPem = buildSummarySignals({ ...base, recoverApplicable: false, recover: scoreRecover(yesTo()), pem: screenPem(pemAll([[2, 2]])) })[1];
  assert.equal(noCovidPem.condition, "ME/CFS");
  assert.doesNotMatch(noCovidPem.advice, /Long COVID/u);
});

test("final-page signals cover PEM, daily function, selected checks, and self-harm", () => {
  const base = { recover: scoreRecover(yesTo()), recoverApplicable: true, pcfsApplicable: true, checks: [] };
  const items = (pem, pcfs, checks = []) => buildSummarySignals({ ...base, pem, pcfs, checks });
  const positivePem = items(screenPem(pemAll([[2, 2]])), gradePcfs(0))[1];
  assert.equal(positivePem.tone, "review");
  assert.equal(positivePem.condition, "ME/CFS and Long COVID");
  assert.match(positivePem.advice, /key ME\/CFS symptom/u);
  assert.equal(items(screenPem(pemAll(Array(5).fill([0, 0]))), gradePcfs(0))[1].tone, "low");
  assert.equal(items(screenPem(pemAll([[0, 0]])), gradePcfs(2))[1].status, "incomplete");
  for (const [grade, tone] of [[0, "low"], [2, "watch"], [4, "review"]]) {
    assert.equal(items(screenPem(), gradePcfs(grade))[2].tone, tone);
  }
  const flagged = items(screenPem(), gradePcfs(0), [
    { id: "lyme", r: checkLyme({ rash: "yes" }) },
    { id: "phq9", r: scorePhq9({ 9: 1 }) },
    { id: "gad7", r: scoreGad7(scaleAnswers("gad7", 11)) },
  ]);
  assert.deepEqual(flagged.slice(3).map(({ id, status }) => [id, status]), [["lyme", "review"], ["phq9", "urgent"], ["gad7", "review"]]);
  assert.match(flagged[4].advice, /crisis support/u);
  assert.equal(buildSummarySignals({ ...base, pem: screenPem(), pcfs: null }, translator("es"))[0].value, "0 puntos");
});

test("final-page condition links include every selected check without turning uncertain answers green", () => {
  const signals = buildSummarySignals({
    recover: scoreRecover(yesTo()), recoverApplicable: true, pem: screenPem(), pcfs: null, pcfsApplicable: false,
    checks: [
      { id: "longcovid", r: checkLongCovid({ duration: "no" }) },
      { id: "mecfs", r: { status: "no-match" } },
      { id: "fibro", r: { status: "match" } },
      { id: "lyme", r: checkLyme({ tick: "unsure", outdoors: "no", rash: "no" }) },
      { id: "phq9", r: scorePhq9(scaleAnswers("phq9", 4)) },
      { id: "gad7", r: scoreGad7(scaleAnswers("gad7", 7)) },
    ],
  });
  assert.deepEqual(signals.map(({ id, condition }) => [id, condition]), [
    ["recover", "Long COVID"], ["pem", "ME/CFS and Long COVID"], ["longcovid", "Long COVID"],
    ["mecfs", "ME/CFS"], ["fibro", "Fibromyalgia"], ["lyme", "Lyme disease"],
    ["phq9", "Depression"], ["gad7", "Anxiety"],
  ]);
  assert.deepEqual(signals.slice(2).map(({ tone }) => tone), ["low", "low", "review", "watch", "low", "watch"]);
  assert.equal(signals.find(({ id }) => id === "lyme").value, "Exposure uncertain");
  const spanish = buildSummarySignals({ recover: scoreRecover(yesTo()), recoverApplicable: true, pem: screenPem(), pcfs: null, pcfsApplicable: false,
    checks: [{ id: "fibro", r: { status: "match" } }] }, translator("es"));
  assert.equal(spanish[2].condition, "Fibromialgia");
  assert.match(spanish[2].advice, /criterios/u);
});

test("DePaul PEM rule: positive when any item has frequency >= 2 and severity >= 2", () => {
  assert.equal(screenPem({}).status, "not-started");
  assert.equal(screenPem(pemAll([[0, 0], [0, 0], [0, 0], [0, 0], [2, 2]])).status, "positive");
  assert.deepEqual(screenPem(pemAll([[4, 4], [1, 1], [2, 3], [0, 0], [0, 0]])).qualifyingItems, [1, 3]);
  assert.equal(screenPem(pemAll([[2, 1], [1, 2], [4, 1], [1, 4], [1, 1]])).status, "negative");
  assert.equal(screenPem(pemAll([[1, 1], [1, 1]])).status, "incomplete");
  assert.equal(screenPem({ 3: { frequency: 3, severity: 2 } }).status, "positive");
  // values outside the 0-4 scale are ignored
  assert.equal(screenPem({ 1: { frequency: 5, severity: 5 } }).status, "not-started");
  assert.equal(screenPem({ 1: { frequency: 2 } }).answered, 0);
});

test("PEM result shows the infection date when COVID was less than 6 months ago", () => {
  const tf = pemTimeframeNote({ covid: "yes", covidDate: "2026-07-01" }, "2026-10-04");
  assert.equal(tf.covidDateText, "July 1, 2026");
  assert.equal(pemTimeframeNote({ covid: "yes", covidDate: "2026-03-01" }, "2026-10-04"), null);
  assert.equal(pemTimeframeNote({ covid: "no", covidDate: "2026-07-01" }, "2026-10-04"), null);
  const d = describePem(screenPem(pemAll([[2, 2], [0, 0], [0, 0], [0, 0], [0, 0]])), tf);
  assert.match(d.body, /July 1, 2026, less than 6 months ago/u);
});

// ---------- PCFS ----------

test("PCFS grade 0-4 with published labels", () => {
  const labels = [0, 1, 2, 3, 4].map((g) => gradePcfs(g).label);
  assert.deepEqual(labels, [
    "no functional limitations",
    "negligible functional limitations",
    "slight functional limitations",
    "moderate functional limitations",
    "severe functional limitations",
  ]);
  assert.equal(gradePcfs("3").grade, 3);
  assert.equal(gradePcfs(null), null);
  assert.equal(gradePcfs(5), null);
  assert.match(describePcfs(gradePcfs(2)).headline, /^Grade 2: slight/u);
});

test("PEM and PCFS item text is verbatim from submission/app_questionnaire.md", () => {
  const spec = read("submission/app_questionnaire.md");
  for (const s of [PEM.instruction, PEM.frequencyQuestion, PEM.severityQuestion, PEM.duration.question, PCFS.question]) {
    assert.ok(spec.includes(s), s);
  }
  for (const it of PEM.items) assert.ok(spec.includes(`${it.n}. ${it.text}`), it.text);
  for (const o of PCFS.options) assert.ok(spec.includes(`| ${o.text} | ${o.grade} |`), o.text);
  const freq = PEM.frequency.map((o) => `${o.value} = ${o.label}`).join(", ");
  const sev = PEM.severity.map((o) => `${o.value} = ${o.label}`).join(", ");
  assert.ok(spec.includes(freq), freq);
  assert.ok(spec.includes(sev), sev);
  for (const it of CHANGE.items) assert.ok(spec.includes(`${it.n}. ${it.text}`), it.text);
  assert.ok(spec.includes(PEM.attribution));
  assert.ok(spec.includes(PCFS.attribution));
});

// ---------- triage ----------

test("demo triage rule: High band or RECOVER >= 11 or PEM positive", () => {
  assert.equal(triage({ chartBands: [], recover: scoreRecover(yesTo()), pem: screenPem({}) }).flag, false);
  assert.deepEqual(triage({ chartBands: ["High"] }).reasons, ["record"]);
  assert.equal(triage({ chartBands: ["Elevated"] }).flag, false);
  assert.deepEqual(triage({ recover: scoreRecover(yesTo("smell-taste", "dizziness", "breath")) }).reasons, ["recover"]);
  assert.deepEqual(triage({ pem: screenPem({ 1: { frequency: 2, severity: 2 } }) }).reasons, ["pem"]);
});

// ---------- QuestionnaireResponse ----------

const fullState = {
  respondent: "caregiver",
  timeline: { onset: "2026-02-01", covid: "yes", covidDate: "2026-01-15", symptoms: "Tired\nDizzy when standing" },
  recover: yesTo("pem", "brain-fog", "fatigue"),
  pem: pemAll([[3, 3], [1, 1], [0, 0], [2, 1], [1, 2]]),
  pemDuration: "ge24h",
  pcfs: 3,
  change: { 1: "much-more", 2: "same", 3: "somewhat-more", 4: "much-more", 5: "less" },
  questions: ["Could this be related to COVID-19?", "  "],
};

test("QuestionnaireResponse is FHIR R4 shaped with a linkId on every item", () => {
  const qr = buildQuestionnaireResponse(fullState, { authored: "2026-10-04T12:00:00Z" });
  assert.equal(qr.resourceType, "QuestionnaireResponse");
  assert.equal(qr.status, "completed");
  assert.equal(qr.authored, "2026-10-04T12:00:00Z");
  assert.match(qr.questionnaire, /^https:\/\/undiagnosednomore\.org\/fhir\/Questionnaire\/.+\|\d+\.\d+\.\d+$/u);
  assert.equal(qr.source.display, "Caregiver answering for the patient");

  const ids = linkIds(qr);
  assert.equal(new Set(ids).size, ids.length, "linkIds are unique");
  for (const id of [
    "timeline", "timeline.respondent", "timeline.onset", "timeline.covid", "timeline.covid-date", "timeline.symptoms",
    "recover", ...RECOVER.items.map((i) => `recover.${i.id}`), "recover.score", "recover.category",
    "pem", ...[1, 2, 3, 4, 5].flatMap((n) => [`pem.${n}`, `pem.${n}.frequency`, `pem.${n}.severity`]), "pem.duration", "pem.screen",
    "pcfs", "pcfs.grade",
    "change", ...CHANGE.items.map((i) => `change.${i.n}`),
    "questions", "questions.1",
  ]) {
    assert.ok(ids.includes(id), `missing ${id}`);
  }
  assert.ok(!ids.includes("questions.2"), "blank questions are dropped");

  // every node has linkId and text; leaves have exactly one answer; groups have items
  const walk = (items) => {
    for (const it of items) {
      assert.equal(typeof it.linkId, "string");
      assert.equal(typeof it.text, "string");
      if (it.item) {
        assert.ok(it.item.length > 0);
        assert.equal(it.answer, undefined);
        walk(it.item);
      } else {
        assert.equal(it.answer.length, 1);
        const keys = Object.keys(it.answer[0]);
        assert.equal(keys.length, 1);
        assert.match(keys[0], /^value(Boolean|Integer|Date|String|Coding)$/u);
      }
    }
  };
  walk(qr.item);

  const find = (id) => {
    let hit = null;
    const go = (items) => items.forEach((x) => (x.linkId === id ? (hit = x) : x.item && go(x.item)));
    go(qr.item);
    return hit;
  };
  assert.deepEqual(find("recover.pem").answer[0], { valueBoolean: true });
  assert.deepEqual(find("recover.thirst").answer[0], { valueBoolean: false });
  assert.deepEqual(find("recover.score").answer[0], { valueInteger: 10 });
  assert.equal(find("pem.1.frequency").answer[0].valueCoding.code, "3");
  assert.equal(find("pem.1.frequency").answer[0].valueCoding.display, "most of the time");
  assert.equal(find("pem.1").text, PEM.items[0].text);
  assert.deepEqual(find("pem.screen").answer[0], { valueBoolean: true });
  assert.equal(find("pcfs.grade").answer[0].valueCoding.code, "3");
  assert.equal(find("change.5").answer[0].valueCoding.code, "less");
  assert.deepEqual(find("timeline.onset").answer[0], { valueDate: "2026-02-01" });
});

test("QuestionnaireResponse honors excluded sections and omits unanswered items", () => {
  const qr = buildQuestionnaireResponse(fullState, { include: { timeline: false, change: false } });
  const ids = linkIds(qr);
  assert.ok(!ids.some((id) => id.startsWith("timeline") || id.startsWith("change")));
  assert.ok(ids.includes("pcfs.grade"));

  const empty = buildQuestionnaireResponse({});
  assert.equal(empty.status, "in-progress");
  assert.equal(empty.item, undefined);

  const partial = buildQuestionnaireResponse({ recover: { cough: "yes" }, pem: { 2: { frequency: 1, severity: 1 } } });
  const pids = linkIds(partial);
  assert.deepEqual(pids, ["recover", "recover.cough", "recover.score", "recover.category", "pem", "pem.2", "pem.2.frequency", "pem.2.severity"]);
  assert.equal(partial.status, "in-progress");
});

// ---------- persona summary: never a probability ----------

const BANNED = /probab|percent|%|\btimes\b|×|average|\bscore\b|\brisk\b|contribution/iu;

function assertNoNumbers(summary, result) {
  const text = JSON.stringify(summary);
  assert.doesNotMatch(text, BANNED);
  for (const k of ["probability", "score", "times_average", "contribution"]) assert.ok(!(k in summary), k);
  if (result && typeof result.probability === "number") {
    const p = result.probability;
    for (const form of [String(p), p.toFixed(2), p.toFixed(3), (p * 100).toFixed(1), (p * 100).toFixed(0) + "%", result.times_average?.toFixed(1)]) {
      if (form && form.length > 2) assert.ok(!text.includes(form), `leaked ${form}`);
    }
  }
}

test("persona summary never produces probability text (synthetic result)", () => {
  const result = {
    status: "scored",
    score: -2.31,
    probability: 0.0423,
    band: "High",
    times_average: 4.4,
    drivers: [
      { id: "lab_crp", label: "C-reactive protein test", group: "Tests after COVID", contribution: 0.8, evidence: [{ resourceType: "Observation", id: "o1", date: "2024-03-01" }] },
      { id: "sex_female", label: "Female", group: "Demographics", contribution: 0.13, evidence: [] },
      { id: "neg", label: "Age 70+", group: "Demographics", contribution: -0.4, evidence: [] },
    ],
  };
  const bundle = { entry: [{ resource: { resourceType: "Observation", id: "o1", code: { text: "CRP" } } }] };
  const s = summarizeRecord("longcovid", result, bundle);
  assert.equal(s.status, "pattern");
  assert.equal(s.headline, "Your record shows patterns that are common in people who were diagnosed with Long COVID.");
  assert.equal(s.findings.length, 1);
  assert.deepEqual(s.findings[0].items[0], { resourceType: "Observation", id: "o1", date: "2024-03-01", dateText: "March 1, 2024", kind: "Lab test", text: "CRP" });
  assert.equal(s.also, "The pattern also takes your sex into account.");
  assertNoNumbers(s, result);
});

test("persona summary: pattern sentence only for High or Elevated; plain reasons otherwise", () => {
  const typical = summarizeRecord("chronicfatigue", { status: "scored", probability: 0.01, band: "Typical", drivers: [] }, {});
  assert.equal(typical.status, "no-pattern");
  assert.doesNotMatch(JSON.stringify(typical), /were diagnosed/u);
  const elevated = summarizeRecord("chronicfatigue", { status: "scored", probability: 0.1, band: "Elevated", drivers: [] }, {});
  assert.equal(elevated.status, "pattern");
  const ns = summarizeRecord("longcovid", { status: "not_scored", reason: "no documented COVID-19 index event" }, {});
  assert.equal(ns.status, "not-checked");
  assert.match(ns.message, /COVID-19 diagnosis/u);
  const reason = (r) => summarizeRecord("longcovid", { status: "not_scored", reason: r }, {}).message;
  assert.match(reason("under 18 at the COVID-19 index (the model covers adults)"), /adults 18 and older/u);
  assert.match(reason("birth date missing or unusable (age is required)"), /no usable birth date/u);
  assert.match(reason("more than 455 days since the COVID-19 index (outside the model's time window)"), /3 to 15 months/u);
  assert.match(reason("no documented COVID-19 index event on or after 2021-07-02 (earlier COVID-19 diagnoses are outside the model's population)"), /July 2, 2021/u);
  const unread = summarizeRecord("longcovid", { status: "could_not_score", reason: "could not score: Observation unavailable" }, {});
  assert.equal(unread.status, "not-checked");
  assert.match(unread.message, /could not be read/u);
  for (const s of [typical, elevated, ns]) assertNoNumbers(s);
});

test("persona summary on the reference scorer outputs for the demo bundles", () => {
  const cases = [
    ["elena", "chronicfatigue", "unm-chronicfatigue-1.0.0", "pattern"],
    ["maria", "longcovid", "unm-longcovid-1.2.0", "pattern"],
    ["dana", "longcovid", "unm-longcovid-1.2.0", "not-checked"],
    ["dana", "chronicfatigue", "unm-chronicfatigue-1.0.0", "no-pattern"],
    ["sofia", "fibromyalgia", "unm-fibromyalgia-1.0.0", "pattern"],
    ["sofia", "longcovid", "unm-longcovid-1.2.0", "not-checked"],
  ];
  for (const [who, key, dir, expected] of cases) {
    const resPath = new URL(`model/test_vectors/expected/${dir}/${who}.json`, repo);
    const bundlePath = new URL(`model/test_vectors/bundles/${who}.json`, repo);
    if (!existsSync(resPath) || !existsSync(bundlePath)) continue;
    const result = JSON.parse(readFileSync(resPath, "utf8"));
    const bundle = JSON.parse(readFileSync(bundlePath, "utf8"));
    const s = summarizeRecord(key, result, bundle);
    assert.equal(s.status, expected, `${who}/${key}`);
    assertNoNumbers(s, result);
    if (expected === "pattern") {
      assert.ok(s.findings.length > 0);
      for (const f of s.findings) for (const it of f.items) assert.match(it.dateText, /^[A-Z][a-z]+ \d{1,2}, \d{4}$/u);
    }
  }
  const table = {
    states: { NY: { name: "New York", counties: { "Dutchess County": [72.44, "high"], "Kings County": [2.1, "low"] } } },
  };
  const dana = JSON.parse(read("model/test_vectors/bundles/dana.json"));
  const note = lymeNote(dana, table);
  assert.match(note.body, /Dutchess County, New York/u);
  assert.match(note.body, /about 72 reported cases/u);
  assert.equal(lymeNote(dana, null), null);
  assert.equal(lymeNote(JSON.parse(read("model/test_vectors/bundles/maria.json")), table), null);
  const site = new URL("web/web/data/lyme_county.json", repo);
  if (existsSync(site)) assert.ok(lymeNote(dana, JSON.parse(readFileSync(site, "utf8"))));
});

test("driver labels are rewritten in plain words", () => {
  assert.equal(plainLabel("3+ symptom types coded in days 31-90"), "3 or more kinds of symptoms recorded 1 to 3 months after COVID-19");
  assert.equal(plainLabel("History: asthma"), "Earlier diagnosis: asthma");
  assert.equal(plainLabel("Shortness of breath (coded by day 90)"), "Shortness of breath (recorded in the first 3 months after COVID-19)");
  assert.equal(plainLabel("4+ outpatient visits in days 31-90"), "4 or more clinic visits 1 to 3 months after COVID-19");
});

// ---------- trials ----------

test("trial finder builds the ClinicalTrials.gov v2 query", () => {
  const u = new URL(buildTrialsUrl({ condition: "lyme", location: "12601" }));
  assert.equal(u.origin + u.pathname, "https://clinicaltrials.gov/api/v2/studies");
  assert.equal(u.searchParams.get("query.cond"), "Lyme Disease");
  assert.equal(u.searchParams.get("filter.overallStatus"), "RECRUITING");
  assert.equal(u.searchParams.get("pageSize"), "10");
  assert.equal(u.searchParams.get("query.locn"), '"New York"');
  assert.equal(new URL(buildTrialsUrl({ condition: "mecfs" })).searchParams.get("query.locn"), null);
  assert.equal(zipToState("37203"), "TN");
  assert.equal(zipToState("90210"), "CA");
  assert.equal(zipToState("02139"), "MA");
  assert.equal(zipToState("abc"), null);
  assert.deepEqual(resolveLocation("tn"), { state: "TN", locn: "Tennessee" });
  assert.deepEqual(resolveLocation("Ohio"), { state: "OH", locn: "Ohio" });
  assert.equal(phaseText(["PHASE2", "PHASE3"]), "Phase 2 and Phase 3");
  assert.equal(phaseText(undefined), "Not listed");

  const studies = parseStudies(
    {
      studies: [
        {
          protocolSection: {
            identificationModule: { nctId: "NCT00000001", briefTitle: "A study" },
            designModule: { phases: ["NA"] },
            contactsLocationsModule: {
              locations: [
                { facility: "A", city: "Boston", state: "Massachusetts", country: "United States" },
                { facility: "B", city: "Nashville", state: "Tennessee", country: "United States" },
              ],
            },
          },
        },
      ],
    },
    { state: "TN" },
  );
  assert.equal(studies[0].url, "https://clinicaltrials.gov/study/NCT00000001");
  assert.equal(studies[0].locations[0], "B, Nashville, Tennessee");
  assert.equal(studies[0].phase, "Not a drug trial (no phase)");
});

// ---------- page rules: CSP, copy ----------

test("patient app has no inline script, inline style, or style attributes", () => {
  const html = readFileSync(new URL("index.html", patientDir), "utf8");
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/iu);
  assert.doesNotMatch(html, /<style/iu);
  assert.doesNotMatch(html, /\sstyle=/iu);
  assert.doesNotMatch(html, /\son[a-z]+=/iu);
  assert.doesNotMatch(html, /https?:\/\/(?!undiagnosednomore\.org)[^"']*\.(js|css)/iu);
  for (const f of readdirSync(patientDir).filter((n) => n.endsWith(".js"))) {
    const src = readFileSync(new URL(f, patientDir), "utf8");
    assert.doesNotMatch(src, /\beval\(|new Function\(|\.innerHTML\s*=|\.style\./u, f);
  }
});

// Marketing words and claims the patient copy must not use (whole source; no code identifier uses them).
const BANNED_COPY = /\b(?:seamless\w*|leverag\w*|robust\w*|comprehensive\w*|empower\w*|unlock\w*|delv\w*|cutting-edge|game-chang\w*|journey\w*|harness\w*|revolutioni[sz]\w*|effortless\w*|in seconds)\b/iu;

test("patient copy: no em-dashes, no exclamation marks, no marketing words, no 'you have <condition>'", () => {
  const files = readdirSync(patientDir).filter((n) => /\.(js|html|webmanifest)$/u.test(n)).map((n) => new URL(n, patientDir));
  // the demo people's made-up answers (shown in the visit summary) live in the shared folder
  files.push(new URL("../shared/demo-answers.js", patientDir));
  for (const url of files) {
    const f = url.pathname.split("/").slice(-2).join("/");
    const src = readFileSync(url, "utf8");
    assert.ok(!src.includes("—"), `em-dash in ${f}`);
    assert.doesNotMatch(src, BANNED_COPY, `marketing word in ${f}`);
    assert.doesNotMatch(src, /you have (long covid|me\/cfs|chronic fatigue|lyme|fibromyalgia|endometriosis|post-exertional|pem\b)/iu, f);
    assert.doesNotMatch(src, /usted tiene (covid prolongado|em\/sfc|fatiga crónica|(la )?enfermedad de lyme|fibromialgia|endometriosis|malestar posterior)/iu, f);
    const strings = src.match(/"[^"\n]*"|`[^`]*`|>[^<]+</gu) || [];
    for (const s of strings) assert.ok(!/[A-Za-z.]!(\s|"|`|<|$)/u.test(s), `exclamation in ${f}: ${s}`);
  }
  assert.equal(formatDate("2024-06-01"), "June 1, 2024");
});

test("people who never had COVID-19 skip the PCFS and see symptom-onset wording for the change items", async () => {
  const { buildQuestionnaireResponse, linkIds } = await import("../web/patient/scoring.js");
  const noCovid = buildQuestionnaireResponse(
    { timeline: { covid: "no" }, pcfs: 2, change: { 1: "much-more" } },
    { authored: "2024-05-30T10:00:00Z" },
  );
  assert.ok(!linkIds(noCovid).includes("pcfs.grade"));
  const change = noCovid.item.find((i) => i.linkId === "change");
  assert.match(change.text, /since your symptoms started/u);
  assert.match(change.item[0].text, /^Compared with before your symptoms started:/u);
  const covid = buildQuestionnaireResponse(
    { timeline: { covid: "yes" }, pcfs: 2, change: { 1: "much-more" } },
    { authored: "2024-05-30T10:00:00Z" },
  );
  assert.ok(linkIds(covid).includes("pcfs.grade"));
  assert.match(covid.item.find((i) => i.linkId === "change").item[0].text, /^Compared with before your COVID infection:/u);
});

// ---------- demo flow: made-up answers, start over, hand-off ----------

/** A Map-backed stand-in for localStorage. */
function fakeStorage({ failWrites = false } = {}) {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => {
      if (failWrites) throw new Error("QuotaExceededError");
      m.set(k, String(v));
    },
    removeItem: (k) => m.delete(k),
    get size() {
      return m.size;
    },
  };
}

/** FHIR R4 shape: linkId and text everywhere, groups have items, leaves have one typed answer. */
function assertValidQr(qr) {
  assert.equal(qr.resourceType, "QuestionnaireResponse");
  assert.match(qr.questionnaire, /^https:\/\/undiagnosednomore\.org\/fhir\/Questionnaire\/.+\|\d+\.\d+\.\d+$/u);
  assert.ok(["completed", "in-progress"].includes(qr.status));
  assert.ok(!Number.isNaN(Date.parse(qr.authored)));
  const ids = linkIds(qr);
  assert.equal(new Set(ids).size, ids.length, "linkIds are unique");
  const walk = (items) => {
    for (const it of items) {
      assert.equal(typeof it.linkId, "string");
      assert.equal(typeof it.text, "string");
      if (it.item) {
        assert.ok(it.item.length > 0);
        assert.equal(it.answer, undefined);
        walk(it.item);
      } else {
        // The fibromyalgia pain-area item repeats (one answer per area); every other item has one answer.
        if (it.linkId === "checks.fibro.areas") assert.ok(it.answer.length >= 1);
        else assert.equal(it.answer.length, 1);
        for (const ans of it.answer) {
          const keys = Object.keys(ans);
          assert.equal(keys.length, 1);
          assert.match(keys[0], /^value(Boolean|Integer|Date|String|Coding)$/u);
          if (keys[0] === "valueCoding") assert.ok(ans.valueCoding.display, `${it.linkId} has a display`);
        }
      }
    }
  };
  walk(qr.item);
  return ids;
}

test("demo people: the same four, in the same order, in the app and in the shared demo answers", () => {
  assert.deepEqual(PERSONAS.map((p) => p.id), ["maria", "elena", "sofia", "dana"]);
  assert.deepEqual(Object.keys(DEMO_ANSWERS), ["maria", "elena", "sofia", "dana"]);
  const sofia = PERSONAS.find((p) => p.id === "sofia");
  assert.equal(sofia.focus, "fibromyalgia");
  assert.match(sofia.story, /fibromyalgia/iu);
  assert.equal(HANDOFF_KEY, "unm-demo-handoff-v1");
});

test("demo answers use only codes the instruments define", () => {
  for (const [id, a] of Object.entries(DEMO_ANSWERS)) {
    for (const k of Object.keys(a.recover)) assert.ok(RECOVER.items.some((i) => i.id === k), `${id} recover ${k}`);
    for (const [n, v] of Object.entries(a.pem)) {
      assert.ok(PEM.items.some((i) => i.n === Number(n)), `${id} pem ${n}`);
      assert.ok(PEM.frequency.some((o) => o.value === v.frequency) && PEM.severity.some((o) => o.value === v.severity), `${id} pem ${n}`);
    }
    if (a.pemDuration) assert.ok(PEM.duration.options.some((o) => o.code === a.pemDuration), `${id} duration`);
    for (const v of Object.values(a.change)) assert.ok(CHANGE.options.some((o) => o.code === v), `${id} change ${v}`);
    if (a.pcfs !== null) assert.ok(gradePcfs(a.pcfs), `${id} pcfs`);
  }
});

test("demo answers produce a valid, complete QuestionnaireResponse for each demo person", () => {
  for (const id of Object.keys(DEMO_ANSWERS)) {
    const state = demoState(id);
    assert.equal(state.demo, id);
    assert.equal(state.finished, true);
    assert.equal(state.step, 0, "a loaded demo never reopens at the last page");
    assert.deepEqual(Object.keys(state.include).sort(), Object.keys(emptyState().include).sort());
    const qr = buildQuestionnaireResponse(state, { authored: "2024-06-01T12:00:00Z", include: exportInclude(state) });
    const ids = assertValidQr(qr);
    assert.equal(qr.status, "completed", id);
    for (const want of ["timeline.onset", "timeline.symptoms", "recover.score", "recover.category", "pem.duration", "change.1", "questions.1"]) {
      if (want === "pem.duration" && !state.pemDuration) continue;
      if (want.startsWith("recover.") && state.timeline.covid === "no") continue;
      assert.ok(ids.includes(want), `${id} missing ${want}`);
    }
    assert.equal(ids.includes("pcfs.grade"), state.timeline.covid === "yes", `${id} PCFS only after COVID-19`);
  }
  // demoState copies: editing the loaded answers never changes the shared demo data
  const s = demoState("maria");
  s.recover.cough = "yes";
  s.questions.push("x");
  assert.equal(DEMO_ANSWERS.maria.recover.cough, "no");
  assert.equal(DEMO_ANSWERS.maria.questions.length, 2);
  assert.equal(demoState("nobody"), null);
});

test("hand-off payload: the QuestionnaireResponse, the demo person, and the time sent", () => {
  const now = new Date("2026-10-04T15:30:00Z");
  const state = { ...demoState("sofia"), persona: { id: "sofia", name: "Sofia", summaries: [] } };
  const p = handoffPayload(state, { now });
  assert.deepEqual(Object.keys(p).sort(), ["persona", "questionnaire", "sentAt"]);
  assert.equal(p.persona, "sofia");
  assert.equal(p.sentAt, "2026-10-04T15:30:00.000Z");
  // demo answers keep their own answer date (Sofia answered 2024-05-30), not the send time
  assert.equal(p.questionnaire.authored, "2024-05-30T12:00:00Z");
  assertValidQr(p.questionnaire);
  assert.deepEqual(p.questionnaire, buildQuestionnaireResponse(state, { authored: "2024-05-30T12:00:00Z", include: exportInclude(state) }));
  assert.equal(handoffPayload({ ...state, answeredOn: "" }, { now }).questionnaire.authored, p.sentAt);
  assert.equal(clinicianUrl(p), "/clinician/#sofia");
  // no record findings or chart-model output in the hand-off
  assert.doesNotMatch(JSON.stringify(p), /probab|times_average|contribution|findings/iu);

  // sections the person unchecked stay out
  const fewer = handoffPayload({ ...state, include: { ...state.include, timeline: false, questions: false } }, { now });
  assert.ok(!linkIds(fewer.questionnaire).some((id) => id.startsWith("timeline") || id.startsWith("questions")));

  // persona: the loaded record first, then the demo answers, then none (opens Elena)
  assert.equal(currentPersona({ demo: "dana" }), "dana");
  assert.equal(currentPersona({ persona: { id: "maria" }, demo: "dana" }), "maria");
  const own = handoffPayload({ recover: { cough: "yes" } }, { now });
  assert.equal(own.persona, null);
  assert.equal(clinicianUrl(own), "/clinician/#elena");
  assert.equal(clinicianUrl({ persona: "not-a-demo" }), "/clinician/#elena");
  assert.equal(clinicianUrl(null), "/clinician/#elena");
});

test("hand-off is written under the shared key and fails softly when storage is blocked", () => {
  const store = fakeStorage();
  const p = handoffPayload(demoState("elena"), { now: new Date("2026-10-04T00:00:00Z") });
  assert.equal(writeHandoff(store, p), true);
  assert.deepEqual(JSON.parse(store.getItem("unm-demo-handoff-v1")), p);
  assert.equal(writeHandoff(fakeStorage({ failWrites: true }), p), false);
  assert.equal(writeHandoff(null, p), false);
});

test("reset uses a query parameter, not a fragment", () => {
  for (const u of ["/patient/?reset", "/patient/?reset=1", "http://localhost:8813/patient/?reset"]) assert.equal(wantsReset(u), true, u);
  for (const u of ["/patient/", "/patient/#reset", "/patient/#qp-1", "/patient/?resets=1"]) assert.equal(wantsReset(u), false, u);
  assert.equal(withoutReset("http://localhost:8813/patient/?reset"), "/patient/");
  assert.equal(withoutReset("/patient/?reset#qp-1"), "/patient/#qp-1");
  assert.equal(withoutReset("/patient/?a=1&reset"), "/patient/?a=1");
});

test("only questionnaire page fragments identify a demo person or standalone page", () => {
  assert.deepEqual(parsePatientRoute("#elena/qp-3"), { persona: "elena", page: 3 });
  assert.deepEqual(parsePatientRoute("#qp-2"), { persona: null, page: 2 });
  for (const hash of ["", "#maria", "#check", "#maria/check/3", "#results", "#qp-0", "#james/qp-2", "#maria/qp-2/extra"])
    assert.deepEqual(parsePatientRoute(hash), { persona: null, page: null }, hash);
});

test("personal answers remain available after the main demo saves a different patient", () => {
  const store = fakeStorage();
  const had = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { value: store, configurable: true, writable: true });
  try {
    const draft = { ...emptyState(), respondent: "self", recover: { fatigue: "yes" }, step: 3 };
    assert.equal(save(draft), true);
    assert.equal(loadPersonal().recover.fatigue, "yes", "older personal drafts can still be read");
    assert.equal(savePersonal(draft), true);
    assert.equal(save(demoState("maria")), true);
    assert.equal(load().demo, "maria");
    assert.equal(loadPersonal().recover.fatigue, "yes");
    assert.equal(loadPersonal().step, 3);
  } finally {
    if (had) Object.defineProperty(globalThis, "localStorage", had);
    else delete globalThis.localStorage;
  }
});

test("start over clears answers, study searches, and the hand-off; a new visitor starts at page 1", () => {
  const store = fakeStorage();
  const had = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { value: store, configurable: true, writable: true });
  try {
    // the case from the review: a finished check left at the last page
    assert.equal(save({ ...emptyState(), recover: { pem: "yes" }, step: 10 }), true);
    assert.equal(savePersonal({ ...emptyState(), recover: { fatigue: "yes" } }), true);
    store.setItem(TRIALS_KEY, "{}");
    store.setItem(HANDOFF_KEY, "{}");
    assert.equal(load().step, 10);

    clearAll();
    for (const k of [KEY, PERSONAL_KEY, TRIALS_KEY, HANDOFF_KEY]) assert.equal(store.getItem(k), null, k);
    const fresh = load();
    assert.deepEqual(fresh, emptyState());
    assert.equal(fresh.step, 0);
  } finally {
    if (had) Object.defineProperty(globalThis, "localStorage", had);
    else delete globalThis.localStorage;
  }
  // blocked storage does not throw
  assert.doesNotThrow(() => clearAll(null));
});

test("manual symptom-check navigation clears demo answers but preserves a person's draft", () => {
  const demo = demoState("maria");
  assert.deepEqual(stateForManualSymptomCheck(demo), emptyState());

  const draft = {
    ...emptyState(),
    respondent: "self",
    timeline: { ...emptyState().timeline, symptoms: "Fatigue" },
    recover: { fatigue: "yes" },
    step: 3,
  };
  assert.equal(stateForManualSymptomCheck(draft), draft);
  assert.equal(stateForManualSymptomCheck(draft).recover.fatigue, "yes");
  assert.equal(stateForManualSymptomCheck(draft).step, 3);
});

test("record cards: patterns first, the demo person's focus condition first among them", () => {
  const s = (modelKey, status) => ({ modelKey, status });
  const sofia = orderSummaries([s("longcovid", "not-checked"), s("chronicfatigue", "pattern"), s("fibromyalgia", "pattern")], "fibromyalgia");
  assert.deepEqual(sofia.map((x) => x.modelKey), ["fibromyalgia", "chronicfatigue", "longcovid"]);
  const none = orderSummaries([s("fibromyalgia", "no-pattern"), s("longcovid", "not-checked"), s("chronicfatigue", "pattern")]);
  assert.deepEqual(none.map((x) => x.modelKey), ["chronicfatigue", "fibromyalgia", "longcovid"]);
});

test("patient app pages carry the shared site bar and list every demo person", () => {
  const html = readFileSync(new URL("index.html", patientDir), "utf8");
  const app = readFileSync(new URL("app.js", patientDir), "utf8");
  const css = readFileSync(new URL("app.css", patientDir), "utf8");
  const frameCss = read("web/web/shared/demo-frame.css");
  const nav = readFileSync(new URL("../shared/site-nav.js", patientDir), "utf8");
  assert.match(html, /<link rel="stylesheet" href="\/shared\/site-nav\.css(\?v=\d{8})?" \/>/u);
  assert.match(html, /href="\/shared\/demo-frame\.css\?v=\d{8}"/u);
  assert.match(html, /class="demo-frame" id="demo-app-frame"/u);
  assert.match(html, /class="demo-frame-content" id="demo-app-stage"[\s\S]*class="demo-frame-body"/u);
  assert.match(frameCss, /\.demo-frame-body \{ padding: 16px 20px 20px; \}/u);
  assert.match(frameCss, /@media \(max-width: 600px\) \{ \.demo-frame-body \{ padding: 12px 14px 16px; \} \}/u);
  assert.doesNotMatch(css, /\.demo-app-(?:frame|bar|stage|loader|spinner)/u);
  assert.match(html, /<script src="\/shared\/site-nav\.js(?:\?v=\d{8})?" defer><\/script>/u);
  assert.match(html, /<body data-door="patient">/u);
  assert.match(html, /<h1[^>]*>Explore the patient app<\/h1>/u);
  assert.match(html, /Try it with synthetic patient answers below, or/u);
  assert.match(html, /href="\/patient\/\?standalone=1&amp;reset=1#qp-1" target="_blank"[^>]*>Try it yourself ↗<\/a>/u);
  assert.match(app, /document\.body\.classList\.toggle\("patient-standalone", standalone\)/u);
  assert.match(nav, /bar\.classList\.add\("unm-sitebar-standalone"\)/u);
  assert.match(nav, /"Symptom check"/u);
  assert.match(html, /class="standalone-delete"[\s\S]*data-delete/u);
  assert.doesNotMatch(html, /class="appbar|data-nav=/u);
  assert.match(app, /\.\.\.chosen\.flatMap\(\(id\) => MODULE_STEPS\[id\]\), summaryStep/u);
  assert.match(app, /state\.step = Math\.max\(0, page - 1\);\s*go\(patientHash\(\)\);/u);
  assert.match(app, /"aria-pressed": String\(state\.demo === p\.id\)/u);
  assert.match(app, /button\.setAttribute\("aria-pressed", String\(button\.dataset\.demo === state\.demo\)\)/u);
  assert.match(app, /const requested = persona \|\| PERSONAS\[0\]\.id/u);
  assert.match(app, /next\.disabled = i === all\.length - 1/u);
  assert.match(app, /\$\("#step-back"\)\.hidden = i === 0/u);
  assert.match(css, /\.questionnaire-controls \{\s*position: sticky;/u);
  assert.match(css, /margin: 0 0 20px; padding: 12px 0;/u);
  assert.match(css, /#step-next\[disabled\][^{]*\{[^}]*background: var\(--ink\);[^}]*color: var\(--on-ink\);/u);
  assert.match(css, /\.demo-btn\[aria-pressed="true"\][^{]*\{[^}]*background: var\(--ink\);[^}]*color: var\(--on-ink\);/u);
  assert.match(html, /id="step-back"[\s\S]*id="step-next"/u);
  assert.match(html, /id="step-back" hidden>/u);
  assert.doesNotMatch(html, /href="#(?:home|check|results|record|summary|trials|privacy|sources|main)"/u);
  assert.match(nav, /legalNewTab: door === "patient"/u);
  const sw = readFileSync(new URL("sw.js", patientDir), "utf8");
  for (const f of ["/shared/site-nav.css", "/shared/demo-frame.css", "/shared/site-nav.js", "/shared/header-tools.css", "/homepage-settings.js", "/shared/demo-answers.js", "/patient/demo.js"]) assert.ok(sw.includes(`"${f}"`), f);
  // the UNOM logo files site-nav.js loads are cached too, and the fetch handler serves them
  const logoBase = nav.match(/const LOGO = "([^"]+)"/u)[1];
  for (const v of ["wide-light", "wide-dark", "compact-light", "compact-dark"]) assert.ok(sw.includes(`"${logoBase}${v}.svg"`), `${v} logo cached`);
  assert.ok(sw.includes(`url.pathname.startsWith("${logoBase}")`), "logo files are cacheable");
  for (const theme of ["light", "dark"]) {
    const wide = read(`web/web/images/homepage/unom-logo-wide-${theme}.svg`);
    assert.match(wide, /<path transform="translate\(0 -5\.8\)"[^>]+d="M108\.2/u, `${theme} desktop tagline is vertically aligned`);
    const compact = read(`web/web/images/homepage/unom-logo-compact-${theme}.svg`);
    assert.doesNotMatch(compact, /translate\(0 -5\.8\)/u, `${theme} mobile logo is unchanged`);
  }
});

test("personal storage copy is shown only in the standalone patient app", () => {
  const html = readFileSync(new URL("index.html", patientDir), "utf8");
  const app = readFileSync(new URL("app.js", patientDir), "utf8");
  const css = readFileSync(new URL("app.css", patientDir), "utf8");
  const footer = html.match(/<footer[\s\S]*?<\/footer>/u)?.[0] || "";

  assert.doesNotMatch(footer, /Your answers (?:are saved|stay) on this device/u);
  assert.match(html, /class="standalone-only"> Your answers are saved on this device as you go\.<\/span>/u);
  assert.match(html, /class="standalone-delete"[\s\S]*id="save-status"[\s\S]*Your answers are saved on this device\./u);
  assert.match(css, /\.standalone-only \{ display: none; \}/u);
  assert.match(css, /body\.patient-standalone \.standalone-only \{ display: inline; \}/u);
  assert.match(app, /standalone \? t\("offline\.standalone"\) : t\("offline\.demo"\)/u);
  assert.equal(EN["offline.standalone"], "You are offline. Your answers are still saved on this device.");
  assert.match(EN["offline.demo"], /^You are offline\. Synthetic patient answers/u);
  assert.doesNotMatch(EN["offline.demo"], /Your answers (?:are|are still) saved/u);
});

test("the shared navigation has no journey step strips on any tab", () => {
  const nav = read("web/web/shared/site-nav.js");
  const css = read("web/web/shared/site-nav.css");
  assert.doesNotMatch(nav, /Step \$\{step\.n\} of 4|const STEPS|unm-stepstrip/u);
  assert.doesNotMatch(css, /unm-stepstrip/u);
  assert.doesNotMatch(nav, /Synthetic patients only/u);
});

test("shared headers reuse the homepage display control and only offer real translations", () => {
  const home = read("web/web/index.html");
  const nav = read("web/web/shared/site-nav.js");
  const homeSettings = read("web/web/homepage-settings.js");
  const sharedTools = read("web/web/shared/header-tools.css");
  const gearPath = home.match(/<path d="([^"]+)" stroke="currentColor"/u)[1];
  assert.ok(nav.includes(`path.setAttribute("d", "${gearPath}")`), "shared header uses the homepage gear artwork");
  assert.match(nav, /class: "header-tools"/u);
  assert.match(nav, /if \(spanish\) controls\.append\(languageLink\(spanish, "lang-link"\)\)/u);
  assert.match(nav, /class: "settings-toggle"/u);
  assert.match(nav, /class: "setting-choices setting-choices-3"/u);
  assert.match(nav, /settingChoice\("text-size", "large", ui\.large/u);
  assert.match(nav, /\blarge: "Large",/u);
  assert.match(nav, /window\.unomDisplaySettings\?\.wire\(settings\)/u);
  assert.match(homeSettings, /window\.unomDisplaySettings = \{ wire: wire \}/u);
  assert.match(read("web/web/homepage.css"), /\.door-nav a \{/u);
  assert.doesNotMatch(read("web/web/homepage.css"), /\.settings-toggle \{/u);
  assert.match(sharedTools, /\.settings-toggle \{/u);
  assert.match(sharedTools, /\.display-settings \{/u);
  assert.doesNotMatch(nav, />⚙|"⚙"|unm-settings-toggle|unm-display-settings/u);
  // Spanish is offered in the patient app only (the rendered bar is checked door by door below)
  assert.match(nav, /const SPANISH_TARGETS = \{ patient: true \};/u);
  assert.doesNotMatch(nav, /walkthrough: \[/u, "Spanish is offered in the patient app only");
  // the language links keep the address and the screen (#hash), with ?lang= set
  assert.match(nav, /url\.searchParams\.set\("lang", lang\);\s*return `\$\{url\.pathname\}\$\{url\.search\}\$\{url\.hash\}`/u);
  for (const page of ["404.html", "atlas/index.html", "clinician/index.html", "deck/index.html", "developers/index.html", "developers/models.html", "developers/spec.html", "patient/index.html", "walkthrough/index.html"]) {
    const html = read(`web/web/${page}`);
    assert.match(html, /<script src="\/homepage-settings\.js\?v=\d{8}"><\/script>/u, `${page} loads the shared working behavior`);
  }
});

test("questionnaire pages put linked instrument names beside progress and keep citations on the sources page", () => {
  const app = readFileSync(new URL("app.js", patientDir), "utf8");
  const html = readFileSync(new URL("index.html", patientDir), "utf8");
  assert.doesNotMatch(app, /(RECOVER|PEM|PCFS)\.attribution/u);
  assert.doesNotMatch(app, /tap one answer for each/u);
  assert.equal(RECOVER.title, "RECOVER 2024 index");
  assert.match(app, /instrument: \{ label: t\("instrument\.recover"\), fullName: RECOVER\.title, href: INSTRUMENT_URLS\.recoverIndex \}/u);
  assert.match(app, /instrument: \{ label: t\("instrument\.pem"\), fullName: PEM\.title, href: INSTRUMENT_URLS\.pem \}/u);
  assert.match(app, /instrument: \{ label: t\("instrument\.pcfs"\), fullName: PCFS\.title, href: INSTRUMENT_URLS\.pcfs \}/u);
  assert.deepEqual([EN["instrument.recover"], EN["instrument.pem"], EN["instrument.pcfs"]], ["RECOVER index", "DePaul PEM", "PCFS scale"]);
  assert.match(app, /instrument\.textContent = `\[\$\{all\[i\]\.instrument\.label\}\]`/u);
  assert.match(app, /instrument\.title = all\[i\]\.instrument\.fullName/u);
  assert.match(html, /class="progress-head"[\s\S]*id="check-instrument"/u);
  assert.match(app, /t\("pem\.regarding", \{ text: item\.text \}\)/u);
  assert.equal(EN["pem.regarding"], "Regarding this symptom, “{text}”");
  // the PEM questions are shown with "how often" and "how much" emphasized, and read as the published wording
  assert.ok(EN["pem.frequencyPrompt"].includes("*how often*") && EN["pem.severityPrompt"].includes("*how much*"));
  assert.equal(plainText(EN["pem.frequencyPrompt"]), PEM.frequencyQuestion);
  assert.equal(plainText(EN["pem.severityPrompt"]), PEM.severityQuestion);
  assert.equal(plainText(ES["pem.frequencyPrompt"]), ES["pem.frequencyQuestion"]);
  assert.equal(plainText(ES["pem.severityPrompt"]), ES["pem.severityQuestion"]);
  assert.match(app, /rich\(t\(kind === "frequency" \? "pem\.frequencyPrompt" : "pem\.severityPrompt"\)\)/u);
  const sources = read("web/web/sources/index.html");
  assert.match(sources, /id="sources-title"/u);
  for (const url of Object.values(INSTRUMENT_URLS)) assert.ok(sources.includes(url), url);
  assert.match(sources, /Creative Commons Attribution 4\.0 license/u);
  assert.match(sources, /Creative Commons Attribution-NonCommercial 4\.0 license/u);
  assert.match(read("web/web/shared/site-nav.js"), /\["\/sources\/", "Questionnaire sources"\]/u, "the patient footer links the sources page");
});

test("patient app icons are the UNOM favicon artwork, and the manifest uses the site background", () => {
  const favicon = readFileSync(new URL("../favicon.svg", patientDir), "utf8");
  assert.equal(readFileSync(new URL("icon.svg", patientDir), "utf8"), favicon);
  const manifest = JSON.parse(readFileSync(new URL("manifest.webmanifest", patientDir), "utf8"));
  assert.equal(manifest.theme_color, "#f6f5f1");
  assert.equal(manifest.background_color, "#f6f5f1");
  for (const size of [192, 512]) {
    const png = readFileSync(new URL(`icon-${size}.png`, patientDir));
    assert.equal(png.toString("ascii", 1, 4), "PNG");
    assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [size, size], `icon-${size}.png is ${size} x ${size}`);
    assert.ok(manifest.icons.some((i) => i.src === `/patient/icon-${size}.png` && i.sizes === `${size}x${size}`));
  }
});

// ---------- RECOVER index only after COVID-19 (or "Not sure") ----------

test("people who answered No to COVID-19: RECOVER items kept, no index points, range, Long COVID wording, or triage reason", async () => {
  const { RECOVER_NOT_SCORED } = await import("../web/patient/scoring.js");
  const answers = yesTo("smell-taste", "pem", "brain-fog");
  const r = scoreRecover(answers);
  assert.ok(r.points >= RECOVER.cutoff);

  const no = describeRecover(r, "no");
  assert.equal(no.body, RECOVER_NOT_SCORED);
  assert.equal(no.body, "These symptoms are shared with your clinician. The RECOVER index is designed for people who have had COVID-19, so no score is shown.");
  for (const text of [no.headline, no.body, no.short]) {
    assert.doesNotMatch(text, /\bpoints?\b|likely|possible|long covid|\d+ (of|out of) \d+/iu, text);
  }
  assert.match(no.short, /Loss of smell or taste, Post-exertional malaise, Brain fog/u);
  for (const covid of ["yes", "unsure", undefined, ""]) assert.match(describeRecover(r, covid).body, /likely Long COVID/u, String(covid));

  assert.deepEqual(triage({ recover: r, covid: "no" }).reasons, []);
  assert.deepEqual(triage({ recover: r, covid: "unsure" }).reasons, ["recover"]);
  assert.deepEqual(triage({ recover: r, covid: "yes" }).reasons, ["recover"]);
  assert.deepEqual(triage({ recover: r, pem: screenPem(pemAll([[2, 2]])), covid: "no" }).reasons, ["pem"]);

  const qrNo = buildQuestionnaireResponse({ timeline: { covid: "no" }, recover: answers }, { authored: "2024-05-30T10:00:00Z" });
  const idsNo = linkIds(qrNo);
  for (const it of RECOVER.items) assert.ok(idsNo.includes(`recover.${it.id}`), it.id);
  assert.ok(!idsNo.includes("recover.score") && !idsNo.includes("recover.category"));
  for (const covid of ["yes", "unsure"]) {
    const ids = linkIds(buildQuestionnaireResponse({ timeline: { covid }, recover: answers }, { authored: "2024-05-30T10:00:00Z" }));
    assert.ok(ids.includes("recover.score") && ids.includes("recover.category"), covid);
  }
});

test("demo people without COVID-19 (Elena, Sofia, Dana) export no RECOVER index; Maria does", () => {
  for (const id of Object.keys(DEMO_ANSWERS)) {
    const state = demoState(id);
    const ids = linkIds(buildQuestionnaireResponse(state, { authored: "2024-06-01T12:00:00Z" }));
    const covid = state.timeline.covid === "yes";
    assert.equal(ids.includes("recover.score"), covid, id);
    assert.equal(ids.includes("recover.category"), covid, id);
    assert.ok(ids.includes("recover.fatigue"), id);
  }
  // the clinician view reads a missing recover.score as "not shown" (recoverPoints === null)
  const elena = buildQuestionnaireResponse(demoState("elena"), { authored: "2024-06-01T12:00:00Z" });
  assert.doesNotMatch(JSON.stringify(elena), /index points|11 or more|1 to 10 points/u);
});

// ---------- Part E. condition self-checks ----------

test("fibromyalgia self-check follows the 2016 rule: WPI/SSS thresholds, 4 of 5 regions, 3 months", async () => {
  const { scoreFibro } = await import("../web/patient/scoring.js");
  const areas = (...ids) => Object.fromEntries(ids.map((i) => [i, true]));
  const full = (a, sev, six, duration = "yes") => ({ areas: a, severity: sev, sixMonths: six, duration });
  const sixNone = { headache: "no", "lower-abdomen": "no", depression: "no" };
  // WPI 7, SSS 5, five regions, 3 months: matches.
  const r1 = scoreFibro(full(areas("neck", "upper-back", "shoulder-l", "shoulder-r", "hip-l", "hip-r", "lower-back"), { fatigue: 2, unrefreshed: 2, cognitive: 1 }, sixNone));
  assert.deepEqual([r1.wpi, r1.sss, r1.regions, r1.status], [7, 5, 5, "match"]);
  // Same scores but pain only in jaw, chest, abdomen plus one region: generalized-pain rule fails.
  const r2 = scoreFibro(full(areas("jaw-l", "jaw-r", "chest", "abdomen", "neck", "upper-back", "lower-back"), { fatigue: 2, unrefreshed: 2, cognitive: 1 }, sixNone));
  assert.deepEqual([r2.wpi, r2.regions, r2.status], [7, 1, "no-match"]);
  // WPI 5 needs SSS 9 or more.
  const five = areas("neck", "shoulder-l", "shoulder-r", "hip-l", "hip-r");
  assert.equal(scoreFibro(full(five, { fatigue: 3, unrefreshed: 2, cognitive: 2 }, { headache: "yes", "lower-abdomen": "yes", depression: "no" })).status, "match");
  assert.equal(scoreFibro(full(five, { fatigue: 3, unrefreshed: 2, cognitive: 2 }, { headache: "yes", "lower-abdomen": "no", depression: "no" })).status, "no-match");
  // Under 3 months: no match; missing answers: incomplete; nothing: not started.
  assert.equal(scoreFibro(full(areas("neck", "upper-back", "shoulder-l", "shoulder-r", "hip-l", "hip-r", "lower-back"), { fatigue: 2, unrefreshed: 2, cognitive: 1 }, sixNone, "no")).status, "no-match");
  assert.equal(scoreFibro({ areas: areas("neck") }).status, "incomplete");
  assert.equal(scoreFibro({}).status, "not-started");
});

test("ME/CFS self-check needs all IOM 2015 core symptoms, with PEM from the DePaul screen", async () => {
  const { checkMecfs } = await import("../web/patient/scoring.js");
  const pos = { status: "positive" };
  const yes = { reduction: "yes", sleep: "yes", cognitive: "yes", orthostatic: "no" };
  assert.equal(checkMecfs(yes, pos).status, "match");
  assert.equal(checkMecfs({ ...yes, cognitive: "no", orthostatic: "yes" }, pos).status, "match");
  assert.equal(checkMecfs({ ...yes, cognitive: "no" }, pos).status, "no-match");
  assert.equal(checkMecfs(yes, { status: "negative" }).status, "no-match");
  assert.equal(checkMecfs(yes, { status: "incomplete" }).status, "incomplete");
  assert.equal(checkMecfs({ ...yes, sleep: "unsure" }, pos).status, "incomplete");
  assert.equal(checkMecfs({}, pos).status, "not-started");
});

test("self-checks: chosen ones only, Long COVID check only after COVID-19 yes or not sure, exported to the QuestionnaireResponse", async () => {
  const { chosenChecks, buildQuestionnaireResponse, linkIds, describeCheck, checkLyme } = await import("../web/patient/scoring.js");
  const chosen = { chosen: { longcovid: true, lyme: true } };
  assert.deepEqual(chosenChecks(chosen, "yes"), ["longcovid", "lyme"]);
  assert.deepEqual(chosenChecks(chosen, "no"), ["lyme"]);
  const qr = buildQuestionnaireResponse({ timeline: { covid: "yes" }, checks: { ...chosen, longcovid: { duration: "yes" }, lyme: { rash: "yes" } } }, { authored: "2024-06-01" });
  const ids = linkIds(qr);
  for (const id of ["checks", "checks.longcovid", "checks.longcovid.duration", "checks.longcovid.result", "checks.lyme", "checks.lyme.rash"]) assert.ok(ids.includes(id), id);
  assert.ok(!ids.some((i) => i.startsWith("checks.fibro") || i.startsWith("checks.mecfs")));
  assert.ok(!ids.includes("checks.lyme.result"), "Lyme answers are not scored");
  const lyme = describeCheck("lyme", checkLyme({ rash: "yes" }));
  assert.match(lyme.body, /not scored/u);
  for (const id of ["longcovid", "mecfs", "fibro"]) assert.doesNotMatch(describeCheck(id, { status: "match", wpi: 9, sss: 6, regions: 5, duration: "yes" }).body, /you have /iu);
});

test("demo people: each one's self-check matches their story, and the clinician dashboard shows it", async () => {
  const { demoState } = await import("../web/patient/demo.js");
  const sc = await import("../web/patient/scoring.js");
  const { summarizeQuestionnaire, patientPanelRows, lymeExposureLine } = await import("../web/athena/cards.js");
  const want = { maria: ["longcovid", "match"], elena: ["mecfs", "match"], sofia: ["fibro", "match"], dana: ["lyme", "answered"] };
  for (const [id, [check, status]] of Object.entries(want)) {
    const st = demoState(id);
    assert.deepEqual(sc.chosenChecks(st.checks, st.timeline.covid), [check], id);
    const r = { longcovid: () => sc.checkLongCovid(st.checks.longcovid), mecfs: () => sc.checkMecfs(st.checks.mecfs, sc.screenPem(st.pem)), fibro: () => sc.scoreFibro(st.checks.fibro), lyme: () => sc.checkLyme(st.checks.lyme) }[check]();
    assert.equal(r.status, status, id);
    const q = summarizeQuestionnaire(sc.buildQuestionnaireResponse(st, { authored: "2024-06-01" }));
    const labels = patientPanelRows(q).map(([l]) => l).join(" | ");
    assert.match(labels, { longcovid: /Long COVID self-check/u, mecfs: /ME\/CFS self-check/u, fibro: /Fibromyalgia self-check/u, lyme: /Lyme exposure/u }[check], id);
    if (check === "lyme") assert.match(lymeExposureLine(q), /time outdoors where Lyme disease is common: Yes/u);
  }
});

// ---------- Spanish: the patient app only ----------

/** A small DOM: elements with attributes, children, textContent, and simple selectors (tag, .class, [attr]). */
class FakeEl {
  constructor(tag, doc) {
    Object.assign(this, { tagName: tag.toUpperCase(), attrs: {}, children: [], parent: null, ownerDocument: doc, dataset: {}, checked: false });
    this.hidden = false;
    this.classList = { add: (c) => this.setAttribute("class", `${this.attrs.class ? `${this.attrs.class} ` : ""}${c}`) };
  }
  setAttribute(k, v) { this.attrs[k] = String(v); if (k === "hidden") this.hidden = true; }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  removeAttribute(k) { delete this.attrs[k]; }
  append(...kids) {
    for (const k of kids) {
      if (k instanceof FakeEl && k.tagName === "#FRAGMENT") this.append(...k.children);
      else { if (k instanceof FakeEl) k.parent = this; this.children.push(k); }
    }
  }
  prepend(...kids) { const rest = this.children; this.children = []; this.append(...kids); this.children.push(...rest); }
  replaceChildren(...kids) { this.children = []; this.append(...kids); }
  get textContent() { return this.children.map((c) => (typeof c === "string" ? c : c.textContent)).join(""); }
  set textContent(v) { this.children = [String(v)]; }
  matches(sel) {
    const m = /^([a-z0-9]*)(?:\.([\w-]+))?(?:\[([\w-]+)\])?$/u.exec(sel);
    if (!m) throw new Error(`selector ${sel}`);
    return (!m[1] || this.tagName === m[1].toUpperCase()) && (!m[2] || (this.attrs.class || "").split(" ").includes(m[2])) && (!m[3] || m[3] in this.attrs);
  }
  querySelectorAll(sel) {
    const out = [];
    const walk = (n) => n.children.forEach((c) => { if (c instanceof FakeEl) { if (sel.split(",").some((s) => c.matches(s.trim()))) out.push(c); walk(c); } });
    walk(this);
    return out;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
}

function fakeDocument() {
  const doc = { readyState: "complete", documentElement: { lang: "en" } };
  Object.assign(doc, {
    createElement: (tag) => new FakeEl(tag, doc),
    createElementNS: (ns, tag) => new FakeEl(tag, doc),
    createDocumentFragment: () => new FakeEl("#fragment", doc),
    createTextNode: (s) => String(s),
  });
  doc.body = new FakeEl("body", doc);
  doc.querySelector = (sel) => doc.body.querySelector(sel);
  doc.querySelectorAll = (sel) => doc.body.querySelectorAll(sel);
  return doc;
}

/** Run shared/site-nav.js for one door and address, with a saved language or blocked storage. */
async function renderSiteNav({ door, href, stored = null, storageThrows = false }) {
  const vm = await import("node:vm");
  const document = fakeDocument();
  document.body.dataset.door = door;
  const listeners = {};
  const localStorage = {
    getItem: (k) => { if (storageThrows) throw new Error("SecurityError"); return k === "unom.lang" ? stored : null; },
    setItem: () => { if (storageThrows) throw new Error("SecurityError"); },
  };
  const window = { location: { href }, localStorage, addEventListener: (type, fn) => ((listeners[type] ||= []).push(fn)) };
  vm.runInNewContext(read("web/web/shared/site-nav.js"), { window, document, URL });
  const body = document.body;
  return {
    document,
    window,
    listeners,
    bar: body.querySelector("header"),
    switches: body.querySelectorAll("[data-lang-switch]"),
    language: body.querySelector(".language-setting"),
    panel: body.querySelector("aside"),
    footer: body.querySelector("footer"),
    gear: body.querySelector(".settings-toggle"),
  };
}

test("strings: every English id has a Spanish entry and every Spanish id an English one, with the same placeholders", () => {
  assert.deepEqual(Object.keys(ES).filter((k) => !(k in EN)), [], "Spanish ids without English");
  assert.deepEqual(Object.keys(EN).filter((k) => !(k in ES)), [], "English ids without Spanish");
  const placeholders = (s) => new Set([...s.matchAll(/\{(\w+)\}/gu)].map((m) => m[1]));
  for (const [id, en] of Object.entries(EN)) {
    for (const p of placeholders(ES[id])) assert.ok(placeholders(en).has(p), `${id}: {${p}} is not an English placeholder`);
    // each language names the count (or omits it only in a singular, where "1" reads as "el síntoma")
    if (!id.endsWith(".one")) assert.deepEqual([...placeholders(ES[id])].sort(), [...placeholders(en)].sort(), `${id} placeholders`);
    assert.equal(typeof ES[id], "string", id);
    // empty only for the Spanish-only notes on the sources screen, which English leaves out
    if (en === "") assert.ok(ES[id].length > 0, `${id} is the Spanish-only note`);
    else assert.ok(ES[id].length > 0, `${id} has Spanish text`);
  }
  // every literal id the code asks for exists (template ids are covered by the instrument and parity checks)
  for (const f of ["app.js", "scoring.js", "records.js", "demo.js", "trials.js"]) {
    const src = readFileSync(new URL(f, patientDir), "utf8");
    for (const [, fn, id] of src.matchAll(/\bt(\.n|\.en)?\("([a-zA-Z][\w.-]*)"/gu)) {
      const ids = fn === ".n" ? [`${id}.one`, `${id}.other`] : [id];
      for (const x of ids) assert.ok(x in EN, `${f} asks for ${x}`);
    }
  }
});

test("strings: the English table matches the instruments, the demo people, the trial finder, and the English page", async () => {
  const { MODELS } = await import("../web/patient/records.js");
  const { TRIAL_CONDITIONS } = await import("../web/patient/trials.js");
  for (const it of RECOVER.items) assert.equal(EN[`recover.item.${it.id}.text`], it.text);
  for (const it of PEM.items) assert.equal(EN[`pem.item.${it.n}`], it.text);
  for (const o of PCFS.options) assert.equal(EN[`pcfs.grade.${o.grade}.text`], o.text);
  for (const p of PERSONAS) assert.deepEqual([EN[`persona.${p.id}.blurb`], EN[`persona.${p.id}.story`]], [p.blurb, p.story]);
  for (const [key, m] of Object.entries(MODELS)) assert.equal(EN[`record.condition.${key}`], m.condition);
  for (const c of TRIAL_CONDITIONS) assert.equal(EN[`trials.condition.${c.id}`], c.label);
  for (const [id, a] of Object.entries(DEMO_ANSWERS)) {
    assert.equal(EN[`demo.${id}.symptoms`], a.timeline.symptoms);
    a.questions.forEach((q, i) => assert.equal(EN[`demo.${id}.question.${i + 1}`], q));
  }
  // index.html is English; each translatable string there is the English table's text
  const html = readFileSync(new URL("index.html", patientDir), "utf8") + read("web/web/sources/index.html");
  const norm = (s) => s.replace(/\s+/gu, " ").replace(/&amp;/gu, "&");
  const plain = [...html.matchAll(/<(\w+)[^>]*\sdata-i18n="([^"]+)"[^>]*>([^<]*)<\/\1>/gu)];
  assert.ok(plain.length >= 60, `${plain.length} data-i18n strings`);
  for (const [, , id, text] of plain) assert.equal(norm(text), EN[id], id);
  const richEls = [...html.matchAll(/<(\w+)[^>]*\sdata-i18n-rich="([^"]+)"[^>]*>([\s\S]*?)<\/\1>/gu)];
  for (const [, , id, inner] of richEls) {
    const markup = norm(inner).replace(/<a href="([^"]+)"[^>]*>([^<]+)<\/a>/gu, "[$2]($1)");
    assert.equal(markup, EN[id], id);
  }
  for (const [, attr, value, ids] of html.matchAll(/\s([\w-]+)="([^"]+)"[^>]*\sdata-i18n-attr="([^"]+)"/gu)) {
    const id = ids.split(";").map((p) => p.split("=")).find(([a]) => a === attr)?.[1];
    if (id) assert.equal(value, EN[id], id);
  }
  const ids = new Set([...html.matchAll(/data-i18n(?:-rich)?="([^"]+)"|=([\w.]+)"/gu)].map((m) => m[1] || m[2]).filter(Boolean));
  for (const id of ids) if (id.includes(".")) assert.ok(id in EN && id in ES, `${id} is in both tables`);
});

test("Spanish copy: usted form, no em dash, no exclamation marks, no marketing words, no 'usted tiene <condition>'", () => {
  for (const [id, s] of Object.entries(ES)) {
    assert.ok(!s.includes("—"), `em dash in ${id}`);
    assert.doesNotMatch(s, /[!¡]/u, `exclamation mark in ${id}`);
    assert.doesNotMatch(s, BANNED_COPY, `marketing word in ${id}`);
    assert.doesNotMatch(s, /\b(?:tú|tu|tus|ti|contigo|tienes|puedes|quieres|eres|estás|sientes|debes|haz|mira)\b/iu, `informal address in ${id}`);
    assert.doesNotMatch(s, /usted tiene (covid prolongado|em\/sfc|fatiga crónica|(la )?enfermedad de lyme|fibromialgia)/iu, id);
    // no untranslated English sentence: Spanish text is not the English text (names and units may match)
    if (/[a-z]{4,} [a-z]{4,} [a-z]{4,}/u.test(EN[id]) && !/^\[|^[<≥\d]/u.test(EN[id])) assert.notEqual(s, EN[id], `${id} is untranslated`);
  }
});

test("Spanish instrument wording: published versions where they exist, with the same ids, codes, and values", async () => {
  const { localInstruments, translator } = await import("../web/patient/i18n.js");
  const ins = await import("../web/patient/instruments.js");
  const L = localInstruments(translator("es"));
  const shape = (I) => JSON.stringify({
    recover: I.RECOVER.items.map((i) => [i.id, i.points, Boolean(i.severity)]),
    cutoff: I.RECOVER.cutoff,
    pem: [I.PEM.frequency.map((o) => o.value), I.PEM.severity.map((o) => o.value), I.PEM.items.map((i) => i.n), I.PEM.duration.options.map((o) => o.code)],
    pcfs: I.PCFS.options.map((o) => o.grade),
    change: [I.CHANGE.options.map((o) => o.code), I.CHANGE.items.map((i) => i.n)],
    checks: [I.CHECKS.options.map((o) => o.code), ...ins.CHECK_ORDER.map((id) => (I.CHECKS[id].items || []).map((i) => i.id)),
      I.CHECKS.fibro.areas.map((a) => [a.id, a.region]), I.CHECKS.fibro.severity.map((o) => o.value), I.CHECKS.fibro.severityItems.map((i) => i.id), I.CHECKS.fibro.sixMonthsItems.map((i) => i.id),
      ...["phq9", "gad7"].map((id) => [I.CHECKS[id].options.map((o) => o.value), I.CHECKS[id].bands.map((b) => [b.code, b.min, b.max]), I.CHECKS[id].max, I.CHECKS[id].selfHarmItem || null]),
      I.CHECKS.phq9.difficulty.map((o) => o.code)],
  });
  assert.equal(shape(L), shape(ins));
  // RECOVER: the official Spanish adult survey (second phase), item by item
  assert.equal(L.RECOVER.items.find((i) => i.id === "smell-taste").text, "Pérdida o cambio en el olfato o el gusto");
  assert.equal(L.RECOVER.items.find((i) => i.id === "brain-fog").text, "Problemas para pensar o concentrarse (\"niebla cerebral\")");
  // PCFS: the Latin American Spanish manual (osf.io/zarv6)
  assert.match(L.PCFS.question, /^¿Cuánto le afecta actualmente en su vida diaria el COVID-19\?/u);
  assert.equal(L.PCFS.options[0].text, "No tengo limitaciones en mi vida diaria, no tengo síntomas, dolor, depresión o ansiedad.");
  // DePaul: US-Spanish DSQ-PEM items, Mexican-Spanish DSQ-SF 6-month questions and labels
  assert.equal(L.PEM.items[2].text, "Cansancio mental después del mínimo esfuerzo");
  assert.match(L.PEM.frequencyQuestion, /^Durante los pasados 6 meses/u);
  assert.deepEqual(L.PEM.frequency.map((o) => o.label), ["nunca", "poco tiempo", "la mitad del tiempo", "la mayor parte del tiempo", "todo el tiempo"]);
  // the sources screen names each Spanish source, with links checked when they were added, and says once that the rest was translated for this app
  const links = (s) => [...s.matchAll(/\]\(([^)]+)\)/gu)].map((m) => m[1]);
  assert.deepEqual(links(ES["sources.recover.spanish"]), ["https://studies.recovercovid.org/media/files/RECOVER-Adult-Surveys-Cycle2-ES.pdf", "https://studies.recovercovid.org/study-protocols-materials"]);
  assert.deepEqual(links(ES["sources.pem.spanish"]), [
    "https://www.leonardjason.com/wp-content/uploads/2024/12/MK4482-023_DSQ-Short-Form-PEM-Questionnaire_Past-2-Weeks_United-States-Spanish_v1_08DEC2023.pdf",
    "https://www.leonardjason.com/wp-content/uploads/2021/02/DePaul-Symptom-Questionnaire-Spanish.pdf",
    "https://csh.depaul.edu/academics/centers-and-institutes/ccr/myalgic-encephalomyelitis-cfs/measures",
  ]);
  assert.deepEqual(links(ES["sources.pcfs.spanish"]), ["https://osf.io/zarv6/", "https://doi.org/10.2340/20030711-1000070"]);
  assert.match(ES["sources.translated"], /se tradujo para esta aplicación/u);
  assert.equal(Object.values(ES).filter((s) => /se tradujo para esta aplicación/u.test(s)).length, 1, "said once");
  for (const id of ["sources.recover.spanish", "sources.pem.spanish", "sources.pcfs.spanish", "sources.translated"]) assert.equal(EN[id], "", `${id} is Spanish only`);
});

test("switching the language changes no score, code, or QuestionnaireResponse answer for the demo people", async () => {
  const i18n = await import("../web/patient/i18n.js");
  const sc = await import("../web/patient/scoring.js");
  const es = i18n.translator("es");
  const L = i18n.localInstruments(es);
  const numbers = (s) => String(s).match(/\d+/gu) || [];
  for (const id of Object.keys(DEMO_ANSWERS)) {
    const state = demoState(id);
    const authored = "2024-06-01T12:00:00Z";
    i18n.setLanguage("en");
    const en = sc.buildQuestionnaireResponse(state, { authored, include: exportInclude(state) });
    const handoffEn = handoffPayload(state, { now: new Date("2026-10-04T00:00:00Z") });
    i18n.setLanguage("es");
    assert.deepEqual(sc.buildQuestionnaireResponse(state, { authored, include: exportInclude(state) }), en, `${id}: same QuestionnaireResponse in Spanish`);
    assert.deepEqual(handoffPayload(state, { now: new Date("2026-10-04T00:00:00Z") }), handoffEn, `${id}: same hand-off`);
    i18n.setLanguage("en");
    assert.match(en.questionnaire, /\|1\.3\.0$/u);
    // answering in the Spanish form stores the same values: every choice keeps its value or code
    const viaSpanish = JSON.parse(JSON.stringify(state));
    for (const [n, a] of Object.entries(viaSpanish.pem)) {
      viaSpanish.pem[n] = { frequency: L.PEM.frequency.find((o) => o.value === a.frequency).value, severity: L.PEM.severity.find((o) => o.value === a.severity).value };
    }
    if (state.pemDuration) viaSpanish.pemDuration = L.PEM.duration.options.find((o) => o.code === state.pemDuration).code;
    if (state.pcfs !== null) viaSpanish.pcfs = L.PCFS.options.find((o) => o.grade === state.pcfs).grade;
    for (const n of Object.keys(state.change)) viaSpanish.change[n] = L.CHANGE.options.find((o) => o.code === state.change[n]).code;
    assert.deepEqual(viaSpanish, state, id);
    // the results show the same numbers in both languages
    const covid = state.timeline.covid;
    const r = sc.scoreRecover(state.recover);
    for (const k of ["headline", "short"]) assert.deepEqual(numbers(sc.describeRecover(r, covid, es)[k]), numbers(sc.describeRecover(r, covid)[k]), `${id} RECOVER ${k}`);
    const p = sc.screenPem(state.pem);
    assert.deepEqual(numbers(sc.describePem(p, null, es).short), numbers(sc.describePem(p, null).short), `${id} PEM`);
    assert.deepEqual(numbers(sc.describePcfs(sc.gradePcfs(state.pcfs), es).short), numbers(sc.describePcfs(sc.gradePcfs(state.pcfs)).short), `${id} PCFS`);
    const fibro = sc.scoreFibro(state.checks.fibro);
    assert.deepEqual(numbers(sc.describeCheck("fibro", fibro, es).short), numbers(sc.describeCheck("fibro", fibro).short), `${id} fibro`);
  }
  // app-written text stays English in the saved state and is shown in the page's language
  const app = readFileSync(new URL("app.js", patientDir), "utf8");
  assert.match(app, /return q\.map\(\(id\) => t\.en\(id\)\);/u, "suggested questions are saved in English");
  assert.equal(i18n.shownText(DEMO_ANSWERS.maria.questions[0], es), ES["demo.maria.question.1"]);
  assert.equal(i18n.shownText(EN["questions.default.followUp"], es), ES["questions.default.followUp"]);
  assert.equal(i18n.shownText("Something I typed", es), "Something I typed");
  assert.equal(i18n.shownText(DEMO_ANSWERS.maria.questions[0], i18n.translator("en")), DEMO_ANSWERS.maria.questions[0]);
  assert.match(app, /buildQuestionnaireResponse\(state, \{ include \}\)/u, "the download is built from the saved state only");
});

test("?lang=es selects Spanish (with ?standalone=1 too), the choice is remembered, and blocked storage falls back safely", async () => {
  const { LANG_KEY, readStoredLang, rememberLang, resolveLang } = await import("../web/patient/i18n.js");
  assert.equal(LANG_KEY, "unom.lang");
  assert.equal(resolveLang("/patient/?lang=es", null), "es");
  assert.equal(resolveLang("/patient/?standalone=1&lang=es#check", null), "es");
  assert.equal(resolveLang("/patient/", "es"), "es", "the saved choice");
  assert.equal(resolveLang("/patient/?lang=en", "es"), "en", "the address wins");
  assert.equal(resolveLang("/patient/?lang=fr", null), "en");
  assert.equal(resolveLang("/patient/", "xx"), "en");
  assert.equal(resolveLang("/patient/", null), "en", "English is the default");
  const store = fakeStorage();
  assert.equal(rememberLang(store, "es"), true);
  assert.equal(store.getItem("unom.lang"), "es");
  assert.equal(readStoredLang(store), "es");
  const blocked = { getItem: () => { throw new Error("SecurityError"); }, setItem: () => { throw new Error("SecurityError"); } };
  assert.equal(readStoredLang(blocked), null);
  assert.equal(rememberLang(blocked, "es"), false);
  assert.equal(readStoredLang(null), null);
  // in Spanish the "Try it yourself" link carries ?lang=es and keeps its ?reset (it starts a clean form)
  const appSrc = readFileSync(new URL("app.js", patientDir), "utf8");
  const translatePage = appSrc.slice(appSrc.indexOf("function translatePage"), appSrc.indexOf("function init"));
  assert.match(translatePage, /a\.patient-try-link[\s\S]*u\.searchParams\.set\("lang", t\.lang\);/u);
  assert.doesNotMatch(translatePage, /delete\("reset"\)/u);
  // every storage call in the language code is inside try
  for (const name of ["i18n.js", "app.js", "../shared/site-nav.js"]) {
    const lines = readFileSync(new URL(name, patientDir), "utf8").split("\n");
    lines.forEach((line, i) => {
      if (/\.(getItem|setItem|removeItem)\(|window\.localStorage/u.test(line)) {
        assert.ok(lines.slice(Math.max(0, i - 3), i + 1).some((l) => /try \{/u.test(l)), `${name}:${i + 1} storage access is inside try`);
      }
    });
  }
  // the app picks the language before anything renders and saves an explicit choice
  const app = readFileSync(new URL("app.js", patientDir), "utf8");
  assert.match(app, /const t = setLanguage\(resolveLang\(window\.location\.href, readStoredLang\(browserStorage\(\)\)\)\);\s*if \(requestedLang === t\.lang\) rememberLang\(browserStorage\(\), t\.lang\);/u);
  assert.match(app, /translatePage\(\);[\s\S]*renderDemoPickers\(\);[\s\S]*route\(\);/u);
});

test("?lang=es renders the page in Spanish: every static string, the Spanish-only source notes, and the app's own text", async () => {
  const { applyStatic, translator, setLanguage, currentLang } = await import("../web/patient/i18n.js");
  // parse index.html into the small DOM and translate it the way app.js does
  const html = readFileSync(new URL("index.html", patientDir), "utf8");
  const doc = fakeDocument();
  const root = new FakeEl("#root", doc);
  const VOIDS = new Set(["meta", "link", "input", "br", "img", "source"]);
  let cur = root;
  const body = html.slice(html.indexOf("<body")).replace(/<!--[\s\S]*?-->/gu, "").replace(/<script[\s\S]*?<\/script>/gu, "");
  for (const m of body.matchAll(/<(\/?)([a-zA-Z0-9]+)((?:\s+[^\s=>]+(?:="[^"]*")?)*)\s*>|([^<]+)/gu)) {
    if (m[4] !== undefined) cur.children.push(m[4].replace(/&amp;/gu, "&"));
    else if (m[1]) cur = cur.parent || root;
    else {
      const el = new FakeEl(m[2], doc);
      for (const a of m[3].matchAll(/([^\s=]+)(?:="([^"]*)")?/gu)) el.setAttribute(a[1], (a[2] ?? "").replace(/&amp;/gu, "&"));
      el.parent = cur;
      cur.children.push(el);
      if (!VOIDS.has(m[2])) cur = el;
    }
  }
  applyStatic(root, translator("es"));
  for (const el of root.querySelectorAll("[data-i18n]")) assert.equal(el.textContent, ES[el.getAttribute("data-i18n")]);
  for (const el of root.querySelectorAll("[data-i18n-rich]")) {
    const id = el.getAttribute("data-i18n-rich");
    assert.equal(el.textContent, plainText(ES[id]), id);
    assert.equal(el.hidden, false, `${id} is shown in Spanish`);
    assert.equal(el.querySelectorAll("a").length, [...ES[id].matchAll(/\]\(/gu)].length, `${id} links`);
    for (const a of el.querySelectorAll("a")) if (/^https:/u.test(a.getAttribute("href"))) assert.equal(a.getAttribute("rel"), "noreferrer");
  }
  for (const el of root.querySelectorAll("[data-i18n-attr]")) assert.equal(el.getAttribute("aria-label"), ES[el.getAttribute("data-i18n-attr").split("=")[1]]);
  // no English sentence from the page survives (strings shorter than three words, like "Atlas", may match)
  const text = root.textContent.replace(/\s+/gu, " ");
  for (const m of html.matchAll(/data-i18n="([^"]+)"/gu)) {
    const en = EN[m[1]];
    if (en.split(" ").length >= 3) assert.ok(!text.includes(en.trim()), `English left on the Spanish page: ${en}`);
  }
  // the controller's own text: the Spanish translator, Spanish dates, Spanish lists
  const es = setLanguage("es");
  assert.equal(currentLang(), "es");
  assert.equal(es.date("2024-06-01"), "1 de junio de 2024");
  assert.equal(es.date("2024-06"), "junio de 2024");
  assert.equal(es.list([1, 3, 5]), "1, 3 y 5");
  assert.equal(es.n("recover.points", 1), "1 punto");
  assert.equal(es.n("recover.points", 16), "16 puntos");
  setLanguage("en");
  assert.equal(translator("en").list([1, 3, 5]), "1, 3, and 5");
});

test("Spanish record text: every term in the demo people's records is translated, with Spanish dates and places", async () => {
  const { translator } = await import("../web/patient/i18n.js");
  const { RECORD_TERMS_ES } = await import("../web/patient/record-terms-es.js");
  const { MODELS, DEMO_AS_OF, localizeSummary, localizeLyme, personaText } = await import("../web/patient/records.js");
  const { scoreBundle } = await import("../web/shared/scorer.js");
  const es = translator("es");
  const table = JSON.parse(read("web/web/data/lyme_county.json"));
  for (const p of PERSONAS) {
    const bundle = JSON.parse(read(`web/web/data/patients/${p.id}.json`));
    for (const [key, m] of Object.entries(MODELS)) {
      const s = summarizeRecord(key, scoreBundle(JSON.parse(read(`web/web${m.file}`)), bundle, DEMO_AS_OF), bundle);
      for (const f of s.findings) {
        assert.ok(f.label in RECORD_TERMS_ES, `${p.id}/${key}: label "${f.label}"`);
        for (const it of f.items) assert.ok(!it.text || it.text in RECORD_TERMS_ES, `${p.id}/${key}: term "${it.text}"`);
      }
      const shown = localizeSummary(s, es);
      assert.deepEqual([shown.status, shown.modelKey, shown.findings.map((f) => f.key)], [s.status, s.modelKey, s.findings.map((f) => f.key)]);
      for (const k of ["headline", "message", "discuss", "also", "condition", "title"]) {
        assert.ok(!shown[k] || !Object.values(EN).includes(shown[k]) || ES[Object.keys(EN).find((x) => EN[x] === shown[k])] === shown[k], `${p.id}/${key} ${k}: "${shown[k]}"`);
      }
      for (const f of shown.findings) for (const it of f.items) assert.match(it.dateText, /^\d{1,2} de [a-z]+ de \d{4}$/u);
      assertNoNumbers(shown);
    }
    const note = lymeNote(bundle, table);
    if (note) {
      const esNote = localizeLyme(note, es);
      assert.match(esNote.body, /el condado de Dutchess, Nueva York/u);
      assert.match(esNote.body, /unos 72 casos reportados/u);
      assert.equal(esNote.headline, ES["lyme.headline"]);
    }
    assert.equal(personaText(p, es).story, ES[`persona.${p.id}.story`]);
  }
});

test("site bar: the Español link and the Language field appear on the patient door only", async () => {
  // patient app, English: an "Español" link in the bar and English / Español in the settings panel
  const en = await renderSiteNav({ door: "patient", href: "https://undiagnosednomore.org/patient/#results" });
  assert.deepEqual(en.switches.map((a) => [a.textContent, a.getAttribute("href"), a.getAttribute("lang")]), [
    ["Español", "/patient/?lang=es#results", "es"],
    ["English", "/patient/?lang=en#results", "en"],
    ["Español", "/patient/?lang=es#results", "es"],
  ]);
  assert.equal(en.bar.querySelector(".lang-link").textContent, "Español");
  assert.equal(en.language.querySelector("p").textContent, "Language");
  assert.equal(en.language.querySelector("a").getAttribute("aria-current"), "page", "English is the current language");
  assert.equal(en.panel.querySelector("h2").textContent, "Display and language");
  assert.equal(en.document.documentElement.lang, "en");
  // the links keep the screen when the hash changes
  en.window.location.href = "https://undiagnosednomore.org/patient/#summary";
  en.listeners.hashchange.forEach((fn) => fn());
  assert.equal(en.bar.querySelector(".lang-link").getAttribute("href"), "/patient/?lang=es#summary");

  // patient app, Spanish: an "English" link, and the bar, panel, and footer in Spanish
  for (const opts of [{ href: "https://undiagnosednomore.org/patient/?lang=es" }, { href: "https://undiagnosednomore.org/patient/", stored: "es" }]) {
    const es = await renderSiteNav({ door: "patient", ...opts });
    assert.equal(es.document.documentElement.lang, "es");
    assert.equal(es.bar.querySelector(".lang-link").textContent, "English");
    assert.equal(es.bar.querySelector(".lang-link").getAttribute("href"), "/patient/?lang=en");
    assert.deepEqual(es.bar.querySelector("nav").querySelectorAll("a").map((a) => a.textContent), ["Médicos", "Pacientes", "Responsables de políticas", "Desarrolladores", "Acerca de"]);
    assert.equal(es.bar.querySelector("nav").querySelectorAll("a")[1].getAttribute("href"), "/patient/?lang=es");
    assert.equal(es.language.querySelector("p").textContent, "Idioma");
    assert.equal(es.language.querySelectorAll("a")[1].getAttribute("aria-current"), "page", "Español is the current language");
    assert.equal(es.panel.querySelector("h2").textContent, "Visualización e idioma");
    assert.deepEqual(es.panel.querySelectorAll("legend").map((l) => l.textContent), ["Apariencia", "Tamaño del texto"]);
    assert.equal(es.gear.getAttribute("aria-label"), "Visualización e idioma");
    assert.match(es.footer.textContent, /Condiciones de uso.*Privacidad.*Derechos y atribuciones.*© 2026 Amir Asiaee y Kaveh Aryan/u);
    assert.doesNotMatch(es.footer.textContent, /Terms of use|Rights and attributions|This is not a diagnosis/u);
  }
  // standalone patient app in Spanish: the compact bar title is Spanish
  const standalone = await renderSiteNav({ door: "patient", href: "https://undiagnosednomore.org/patient/?standalone=1&lang=es#check" });
  assert.equal(standalone.bar.querySelector(".unm-standalone-title").textContent, "Revisión de síntomas");
  assert.equal(standalone.footer.querySelector("nav"), null, "compact footer");
  // blocked storage: English, no error
  const blocked = await renderSiteNav({ door: "patient", href: "https://undiagnosednomore.org/patient/", storageThrows: true });
  assert.equal(blocked.bar.querySelector(".lang-link").textContent, "Español");

  // every other door: no language link, no Language field, English labels, even with ?lang=es or a saved choice
  for (const door of ["", "hub", "clinician", "atlas", "developers", "evidence"]) {
    for (const opts of [{}, { stored: "es" }, { query: "?lang=es" }]) {
      const page = await renderSiteNav({ door, href: `https://undiagnosednomore.org/${door}/${opts.query || ""}`, stored: opts.stored || null });
      assert.equal(page.switches.length, 0, `${door || "no door"}: no language link`);
      assert.equal(page.language, null, `${door || "no door"}: no Language field`);
      assert.equal(page.panel.querySelector("h2").textContent, "Display");
      assert.equal(page.gear.getAttribute("aria-label"), "Display settings");
      assert.doesNotMatch(page.panel.textContent, /English|Español|Language|Idioma/u);
      assert.equal(page.document.documentElement.lang, "en");
      assert.match(page.footer.textContent, /Terms of use/u);
    }
  }
  // and no page carries a static language control
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(new URL(`${d.name}/`, dir)) : d.name.endsWith(".html") ? [new URL(d.name, dir)] : []));
  for (const url of walk(new URL("web/web/", repo))) {
    const page = readFileSync(url, "utf8").replace(/<!--[\s\S]*?-->/gu, "");
    assert.doesNotMatch(page, /language-setting|lang-link|data-lang-switch|>Español<|href="[^"]*[?&]lang=|href="\/es\/?"/u, url.pathname);
  }
});

test("offline: the service worker caches every module the patient app imports, in both languages", () => {
  const sw = readFileSync(new URL("sw.js", patientDir), "utf8");
  const shell = [...sw.slice(sw.indexOf("const SHELL"), sw.indexOf("];", sw.indexOf("const SHELL"))).matchAll(/"([^"]+)"/gu)].map((m) => m[1]);
  // follow the static imports from app.js
  const seen = new Set();
  const visit = (url) => {
    if (seen.has(url.pathname)) return;
    seen.add(url.pathname);
    for (const [, spec] of readFileSync(url, "utf8").matchAll(/^\s*(?:import|export)[^;]*?from "(\.{1,2}\/[^"]+)"/gmu)) visit(new URL(spec, url));
  };
  visit(new URL("app.js", patientDir));
  const webRoot = new URL("web/web/", repo).pathname;
  const modules = [...seen].map((p) => `/${p.slice(webRoot.length)}`);
  for (const f of ["/patient/i18n.js", "/patient/strings-en.js", "/patient/strings-es.js", "/patient/record-terms-es.js"]) assert.ok(modules.includes(f), f);
  for (const m of modules) assert.ok(shell.includes(m), `${m} is in the offline shell`);
  // every navigation, with or without ?lang=es or ?standalone=1, is answered from the one cached page
  assert.match(sw, /const key = req\.mode === "navigate" \? "\/patient\/" : url\.pathname;/u);
  assert.match(sw, /const VERSION = "unm-patient-[^"]+";/u);
  // the manifest opens the app at /patient/, where the saved language applies
  const manifest = JSON.parse(readFileSync(new URL("manifest.webmanifest", patientDir), "utf8"));
  assert.equal(manifest.start_url, "/patient/");
});

// ---------- Part E. PHQ-9 and GAD-7 (questionnaire version 1.3.0) ----------

/** PHQ-9 or GAD-7 answers that add up to `total`: items filled with 3s from item 1, the remainder on the next item. */
function scaleAnswers(id, total, extra = {}) {
  let left = total;
  const a = {};
  for (const it of CHECKS[id].items) {
    const v = Math.min(3, left);
    a[it.id] = v;
    left -= v;
  }
  return { ...a, ...extra };
}

const PHQ9_BANDS = [[0, 4, "0-4", "none-minimal depression"], [5, 9, "5-9", "mild depression"], [10, 14, "10-14", "moderate depression"],
  [15, 19, "15-19", "moderately severe depression"], [20, 27, "20-27", "severe depression"]];
const GAD7_BANDS = [[0, 4, "0-4", "below the cutpoint for mild anxiety"], [5, 9, "5-9", "mild anxiety"], [10, 14, "10-14", "moderate anxiety"], [15, 21, "15-21", "severe anxiety"]];

test("PHQ-9 and GAD-7 wording is verbatim from submission/app_questionnaire.md (the phqscreeners.com forms)", () => {
  const spec = read("submission/app_questionnaire.md");
  for (const id of ["phq9", "gad7"]) {
    const C = CHECKS[id];
    assert.ok(spec.includes(`stem: "${C.stem}"`), `${id} stem`);
    for (const it of C.items) assert.ok(spec.includes(`\n${it.id}. ${it.text}\n`), `${id} ${it.id}: ${it.text}`);
    assert.ok(spec.includes(C.options.map((o) => `${o.value} = ${o.label}`).join(", ")), `${id} answer choices`);
  }
  assert.ok(spec.includes(`"${CHECKS.phq9.difficultyQuestion}" ${CHECKS.phq9.difficulty.map((o) => o.label).join(", ")}.`));
  assert.deepEqual([CHECKS.phq9.items.length, CHECKS.gad7.items.length, CHECKS.phq9.max, CHECKS.gad7.max], [9, 7, 27, 21]);
  assert.equal(CHECKS.phq9.items[8].text, "Thoughts that you would be better off dead or of hurting yourself in some way");
  assert.equal(CHECKS.phq9.selfHarmItem, "9");
  // the only change from the English PHQ-9: a spaced en dash where the form prints an em dash (items 6 and 8)
  assert.ok(CHECKS.phq9.items[5].text.includes("yourself – or that") && CHECKS.phq9.items[7].text.includes("opposite – being"));
  assert.equal(CHECK_ORDER.slice(-2).join(), "phq9,gad7");
  assert.equal(INSTRUMENT_URLS.phq9, "https://doi.org/10.1046/j.1525-1497.2001.016009606.x");
  assert.equal(INSTRUMENT_URLS.gad7, "https://doi.org/10.1001/archinte.166.10.1092");
});

test("PHQ-9 and GAD-7 totals and published severity bands at every total, including each boundary", () => {
  for (const [id, bands, max, n] of [["phq9", PHQ9_BANDS, 27, 9], ["gad7", GAD7_BANDS, 21, 7]]) {
    for (let total = 0; total <= max; total += 1) {
      const r = scoreScale(id, scaleAnswers(id, total));
      const [lo, hi, code, label] = bands.find(([a, b]) => total >= a && total <= b);
      assert.deepEqual([r.status, r.answered, r.total, r.max, r.band.code, r.band.min, r.band.max, r.band.label], ["complete", n, total, max, code, lo, hi, label], `${id} ${total}`);
      const d = describeCheck(id, r);
      assert.equal(d.headline, `${total} out of ${max}: ${label}`, `${id} ${total}`);
      assert.ok(d.body.endsWith(`a total of ${lo} to ${hi} is ${label}. Please discuss it with your clinician.`), `${id} ${total}: ${d.body}`);
    }
    // every boundary on both sides
    for (const [lo, hi] of bands) {
      assert.equal(scoreScale(id, scaleAnswers(id, lo)).band.min, lo);
      assert.equal(scoreScale(id, scaleAnswers(id, hi)).band.max, hi);
    }
    // a missing item: no total and no band; nothing answered: not started; out-of-range values are ignored
    const partial = scaleAnswers(id, max);
    delete partial[String(n)];
    const p = scoreScale(id, partial);
    assert.deepEqual([p.status, p.total, p.band, p.answered], ["incomplete", null, null, n - 1]);
    assert.match(describeCheck(id, p).body, new RegExp(`You answered ${n - 1} of ${n} questions`, "u"));
    assert.equal(describeCheck(id, p).headline, "Not finished");
    assert.equal(scoreScale(id, {}).status, "not-started");
    assert.equal(scoreScale(id, { 1: 4, 2: -1, 3: "x", 4: 1.5 }).answered, 0);
    assert.equal(scoreScale(id, scaleAnswers(id, 0, { 1: "2" })).total, 2, "a saved numeric string counts");
  }
  assert.deepEqual([scorePhq9(scaleAnswers("phq9", 12)).total, scoreGad7(scaleAnswers("gad7", 12)).total], [12, 12]);
  // the difficulty question is not scored
  assert.equal(scorePhq9(scaleAnswers("phq9", 9, { difficulty: "extremely" })).total, 9);
  assert.equal(scorePhq9({ difficulty: "very" }).status, "incomplete");
  assert.equal(scorePhq9(scaleAnswers("phq9", 9, { difficulty: "nonsense" })).difficulty, null);
});

test("PHQ-9 item 9: every non-zero answer brings up the 988 Lifeline and 911, from the string tables, with no network", async () => {
  const { translator, richParts } = await import("../web/patient/i18n.js");
  for (const v of [1, 2, 3]) {
    assert.equal(phq9SelfHarm({ 9: v }), true, `item 9 = ${v}, nothing else answered`);
    assert.equal(phq9SelfHarm(scaleAnswers("phq9", 0, { 9: v })), true, `item 9 = ${v}, total ${v}`);
    assert.equal(scorePhq9({ 9: v }).selfHarmPositive, true);
  }
  for (const a of [{}, { 9: 0 }, scaleAnswers("phq9", 24, { 9: 0 }), { 9: null }, { 9: 4 }]) assert.equal(phq9SelfHarm(a), false, JSON.stringify(a));
  const en = crisisText();
  assert.equal(en.heading, EN["crisis.heading"]);
  assert.match(en.body, /\[Call 988\]\(tel:988\) or \[text 988\]\(sms:988\), or chat at \[988lifeline\.org\]\(https:\/\/988lifeline\.org\/\)/u);
  assert.match(en.body, /988 Suicide & Crisis Lifeline/u);
  assert.equal(en.emergency, "If you are in immediate danger, call 911.");
  assert.equal(en.spanish, "");
  const es = crisisText(translator("es"));
  assert.match(es.body, /\[Llame al 988\]\(tel:988\) o \[envíe un mensaje de texto al 988\]\(sms:988\), o chatee en \[988lifeline\.org\]\(https:\/\/988lifeline\.org\/es\/inicio\/\)/u);
  assert.match(es.body, /Línea 988 de Prevención del Suicidio y Crisis/u);
  assert.equal(es.spanish, "Para hablar con un consejero en español, marque 988 y luego presione 2, o envíe la palabra AYUDA al 988.");
  assert.equal(es.emergency, "Si está en peligro inmediato, llame al 911.");
  // the box is drawn from those strings: under question 9 as soon as it is answered, on the summary page, and at the top of the results
  const app = readFileSync(new URL("app.js", patientDir), "utf8");
  const box = app.slice(app.indexOf("function crisisBox"), app.indexOf("const selfHarmAnswered"));
  assert.match(box, /const c = crisisText\(t\);/u);
  assert.match(box, /role: live \? "alert" : null/u);
  assert.match(app, /const selfHarmAnswered = \(\) => phq9SelfHarm\(\(state\.checks \|\| \{\}\)\.phq9 \|\| \{\}\);/u);
  const phqStep = app.slice(app.indexOf("  phq9: ["), app.indexOf("  gad7: ["));
  assert.match(phqStep, /it\.id === C\.selfHarmItem \? \[scaleGroup\("phq9", it, update\), slot\]/u);
  assert.match(phqStep, /if \(selfHarmAnswered\(\) && !shown\) \{\s*slot\.replaceChildren\(crisisBox\(\{ live: true \}\)\);\s*slot\.scrollIntoView\(\{ block: "nearest" \}\);/u);
  assert.match(app, /h\("h1", \{ tabindex: "-1" \}, t\("summary\.heading"\)\),\s*selfHarmAnswered\(\) \? crisisBox\(\) : null,/u);
  assert.match(app, /const nodes = \[\s*selfHarmAnswered\(\) \? crisisBox\(\) : null,/u);
  // offline: nothing on that path fetches or imports, and the strings live in modules the service worker caches
  for (const part of [box, phqStep]) assert.doesNotMatch(part, /fetch\(|import\(|XMLHttpRequest/u);
  const sw = readFileSync(new URL("sw.js", patientDir), "utf8");
  for (const f of ["/patient/app.js", "/patient/scoring.js", "/patient/strings-en.js", "/patient/strings-es.js", "/patient/i18n.js"]) assert.ok(sw.includes(`"${f}"`), f);
  assert.deepEqual(richParts(en.body).filter((x) => x.type === "link").map((x) => x.href), ["tel:988", "sms:988", "https://988lifeline.org/"]);
});

test("PHQ-9 and GAD-7 in the QuestionnaireResponse (1.3.0): stable linkIds, answers, totals, band codes", () => {
  const state = {
    timeline: { covid: "no" },
    checks: { chosen: { phq9: true, gad7: true }, phq9: scaleAnswers("phq9", 11, { difficulty: "somewhat" }), gad7: scaleAnswers("gad7", 15) },
  };
  const qr = buildQuestionnaireResponse(state, { authored: "2026-10-15T12:00:00Z" });
  assert.match(qr.questionnaire, /\|1\.3\.0$/u);
  const ids = assertValidQr(qr);
  const phq = [...CHECKS.phq9.items.map((i) => `checks.phq9.${i.id}`), "checks.phq9.difficulty", "checks.phq9.total", "checks.phq9.band"];
  const gad = [...CHECKS.gad7.items.map((i) => `checks.gad7.${i.id}`), "checks.gad7.total", "checks.gad7.band"];
  assert.deepEqual(ids, ["timeline", "timeline.covid", "checks", "checks.phq9", ...phq, "checks.gad7", ...gad]);
  const find = (id) => {
    let hit = null;
    const go = (items) => items.forEach((x) => (x.linkId === id ? (hit = x) : x.item && go(x.item)));
    go(qr.item);
    return hit;
  };
  assert.deepEqual(find("checks.phq9.1").answer[0].valueCoding, { system: "https://undiagnosednomore.org/fhir/CodeSystem/phq-frequency", code: "3", display: "Nearly every day" });
  assert.equal(find("checks.phq9.1").text, `${CHECKS.phq9.stem} ${CHECKS.phq9.items[0].text}`);
  assert.equal(find("checks.phq9.difficulty").answer[0].valueCoding.code, "somewhat");
  assert.deepEqual(find("checks.phq9.total").answer[0], { valueInteger: 11 });
  assert.deepEqual(find("checks.phq9.band").answer[0].valueCoding, { system: "https://undiagnosednomore.org/fhir/CodeSystem/phq9-severity", code: "10-14", display: "10 to 14: moderate depression" });
  assert.deepEqual(find("checks.gad7.total").answer[0], { valueInteger: 15 });
  assert.deepEqual(find("checks.gad7.band").answer[0].valueCoding, { system: "https://undiagnosednomore.org/fhir/CodeSystem/gad7-severity", code: "15-21", display: "15 to 21: severe anxiety" });
  // partial answers: the answered items only, no total or band; a check not chosen is not exported
  const partial = buildQuestionnaireResponse({ checks: { chosen: { phq9: true }, phq9: { 9: 2 }, gad7: scaleAnswers("gad7", 3) } }, { authored: "2026-10-15T12:00:00Z" });
  assert.deepEqual(assertValidQr(partial), ["checks", "checks.phq9", "checks.phq9.9"]);
  assert.doesNotMatch(JSON.stringify(qr), /Ningún|Varios días|depresión/u, "the exported file is English");
});

test("PHQ-9 and GAD-7: every new string has Spanish, the Spanish is the US Spanish form, and scores match across languages", async () => {
  const i18n = await import("../web/patient/i18n.js");
  const es = i18n.translator("es");
  const L = i18n.localInstruments(es);
  const ids = Object.keys(EN).filter((k) => /^(checks\.(phq9|gad7|scale)\.|check\.(scale|phq9)\.|crisis\.|sources\.phq\.|step\.(phq9|gad7)\.|instrument\.(phq9|gad7))/u.test(k));
  assert.ok(ids.length >= 60, `${ids.length} new ids`);
  for (const id of ids) assert.ok(typeof ES[id] === "string" && ES[id].length > 0, `${id} has Spanish`);
  for (const id of ["crisis.spanish", "sources.phq.spanish"]) assert.equal(EN[id], "", `${id} is Spanish only`);
  // the published US Spanish wording (phqscreeners.com, "Spanish for the USA")
  assert.equal(L.CHECKS.phq9.stem, "Durante las últimas 2 semanas, ¿qué tan seguido ha tenido molestias debido a los siguientes problemas?");
  assert.equal(L.CHECKS.gad7.stem, L.CHECKS.phq9.stem);
  assert.deepEqual(L.CHECKS.phq9.options.map((o) => o.label), ["Ningún día", "Varios días", "Más de la mitad de los días", "Casi todos los días"]);
  assert.equal(L.CHECKS.phq9.items[8].text, "Pensamientos de que estaría mejor muerto(a) o de lastimarse de alguna manera");
  assert.equal(L.CHECKS.gad7.items[0].text, "Se ha sentido nervioso(a), ansioso(a) o con los nervios de punta");
  assert.deepEqual(L.CHECKS.phq9.difficulty.map((o) => o.label), ["No ha sido difícil", "Un poco difícil", "Muy difícil", "Extremadamente difícil"]);
  const links = (s) => [...s.matchAll(/\]\(([^)]+)\)/gu)].map((m) => m[1]);
  assert.deepEqual(links(ES["sources.phq.spanish"]), [
    "https://www.phqscreeners.com/images/sites/g/files/g10060481/f/201412/PHQ9_Spanish%20for%20the%20USA.pdf",
    "https://www.phqscreeners.com/images/sites/g/files/g10060481/f/201412/GAD7_Spanish%20for%20the%20USA.pdf",
  ]);
  assert.deepEqual(links(EN["sources.phq.body"]), [INSTRUMENT_URLS.phq9, INSTRUMENT_URLS.gad7, "https://www.phqscreeners.com/select-screener"]);
  assert.match(EN["sources.phq.body"], /Kroenke, Spitzer, and Williams, J Gen Intern Med 2001.*Spitzer, Kroenke, Williams, and Löwe, Arch Intern Med 2006/u);
  // the same scores and QuestionnaireResponse in both languages, at every PHQ-9 total
  const numbers = (s) => String(s).match(/\d+/gu) || [];
  for (let total = 0; total <= 27; total += 1) {
    const state = { checks: { chosen: { phq9: true, gad7: true }, phq9: scaleAnswers("phq9", total, { difficulty: "very" }), gad7: scaleAnswers("gad7", Math.min(21, total)) } };
    i18n.setLanguage("en");
    const qrEn = buildQuestionnaireResponse(state, { authored: "2026-10-15T12:00:00Z" });
    i18n.setLanguage("es");
    assert.deepEqual(buildQuestionnaireResponse(state, { authored: "2026-10-15T12:00:00Z" }), qrEn, `total ${total}`);
    i18n.setLanguage("en");
    for (const id of ["phq9", "gad7"]) {
      const r = scoreScale(id, state.checks[id]);
      for (const k of ["headline", "short"]) assert.deepEqual(numbers(describeCheck(id, r, es)[k]), numbers(describeCheck(id, r)[k]), `${id} ${total} ${k}`);
    }
  }
});

test("the patient app offers the PHQ-9 and GAD-7 as optional checks with their instrument links, and cites them on the sources screen", () => {
  const app = readFileSync(new URL("app.js", patientDir), "utf8");
  const html = readFileSync(new URL("index.html", patientDir), "utf8");
  assert.match(app, /instrument: \{ label: t\("instrument\.phq9"\), fullName: CHECKS\.phq9\.fullName, href: INSTRUMENT_URLS\.phq9 \}/u);
  assert.match(app, /instrument: \{ label: t\("instrument\.gad7"\), fullName: CHECKS\.gad7\.fullName, href: INSTRUMENT_URLS\.gad7 \}/u);
  assert.match(app, /phq9: \(\) => scorePhq9\(ck\.phq9\),\s*gad7: \(\) => scoreGad7\(ck\.gad7\),/u);
  const sources = read("web/web/sources/index.html");
  assert.match(sources, /data-i18n-rich="sources\.phq\.body"/u);
  assert.match(sources, /data-i18n-rich="sources\.phq\.spanish" hidden/u);
  assert.match(CHECKS.intro, /six conditions/u);
  assert.deepEqual(chosenChecks({ chosen: { phq9: true, gad7: true } }, "no"), ["phq9", "gad7"]);
  assert.deepEqual([emptyState().checks.phq9, emptyState().checks.gad7], [{}, {}]);
  // the demo people's answers are unchanged: none of them chose the new checks
  for (const id of Object.keys(DEMO_ANSWERS)) assert.ok(!demoState(id).checks.chosen.phq9 && !demoState(id).checks.chosen.gad7, id);
});
