import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { defaultDemoResponses, demoQuestionnaire, formatSentAt, handoffAction, parseHandoff, parseRoute, PATIENTS } from "../web/clinician/demo.js";
import { seriousItems } from "../web/athena/cards.js";
import { HANDOFF_KEY } from "../web/shared/demo-answers.js";

const html = readFileSync(new URL("../web/clinician/index.html", import.meta.url), "utf8");
const demoSource = readFileSync(new URL("../web/clinician/demo.js", import.meta.url), "utf8");
const cardsSource = readFileSync(new URL("../web/athena/cards.js", import.meta.url), "utf8");
const clinicianStyles = readFileSync(new URL("../web/clinician/clinician.css", import.meta.url), "utf8");
const BANNED = /\b(?:seamless\w*|leverag\w*|robust\w*|comprehensive\w*|empower\w*|unlock\w*|delve\w*|cutting-edge|game-chang\w*|journey\w*|harness\w*|effortless\w*)\b/iu;

test("hand-off from the patient app is parsed and validated", () => {
  const qr = demoQuestionnaire("maria");
  const ok = parseHandoff(JSON.stringify({ questionnaire: qr, persona: "maria", sentAt: "2026-10-04T15:12:00Z" }));
  assert.equal(ok.persona, "maria");
  assert.equal(ok.sentAt, "2026-10-04T15:12:00Z");
  assert.equal(ok.questionnaire, ok.questionnaire);
  assert.equal(ok.questionnaire.resourceType, "QuestionnaireResponse");
  assert.equal(parseHandoff(JSON.stringify({ questionnaire: qr, persona: null, sentAt: "bad" })).sentAt, null);
  assert.equal(parseHandoff(JSON.stringify({ questionnaire: qr, persona: "james" })).persona, null);
  assert.equal(parseHandoff("not json"), null);
  assert.equal(parseHandoff(""), null);
  assert.equal(parseHandoff(null), null);
  assert.equal(parseHandoff(JSON.stringify({ questionnaire: { resourceType: "Patient" } })), null);
  // only our canonical questionnaire, in a supported version
  assert.equal(parseHandoff(JSON.stringify({ questionnaire: { ...qr, questionnaire: "https://example.org/Questionnaire/other|1.2.0" } })), null);
  assert.equal(parseHandoff(JSON.stringify({ questionnaire: { ...qr, questionnaire: qr.questionnaire.replace(/\|.*$/u, "|9.9.9") } })), null);
  assert.equal(HANDOFF_KEY, "unm-demo-handoff-v1");
});

test("a hand-off is added to its own patient; one that names no patient waits for the clinician to confirm", () => {
  const qr = demoQuestionnaire("dana");
  const named = parseHandoff(JSON.stringify({ questionnaire: qr, persona: "dana" }));
  assert.equal(handoffAction(named, "dana"), "attach");
  assert.equal(handoffAction(named, "maria"), null);
  const anon = parseHandoff(JSON.stringify({ questionnaire: qr, persona: null }));
  assert.equal(handoffAction(anon, "elena"), "confirm");
  assert.equal(handoffAction(null, "elena"), null);
  // a subject that names another patient is never attached
  const other = parseHandoff(JSON.stringify({ questionnaire: { ...qr, subject: { reference: "Patient/maria" } }, persona: "dana" }));
  assert.equal(handoffAction(other, "dana"), null);
  assert.equal(handoffAction(other, "maria"), null, "named for Dana, so not Maria's either");
});

test("deep links pick a demo patient and a tab", () => {
  assert.deepEqual(parseRoute("#dana/lyme"), { persona: "dana", tab: "lyme" });
  assert.deepEqual(parseRoute("#maria"), { persona: "maria", tab: null });
  assert.deepEqual(parseRoute("#james/timeline"), { persona: null, tab: null });
  assert.deepEqual(parseRoute("#dana/lyme/extra"), { persona: null, tab: null });
  assert.deepEqual(parseRoute(""), { persona: null, tab: null });
});

test("print reports include only red-dot High model conditions", () => {
  const high = { kind: "model", review: true, band: "High", slug: "longcovid" };
  const items = [
    high,
    { kind: "model", review: true, band: "Elevated", slug: "mecfs" },
    { kind: "rule", review: true, band: null, slug: "lyme" },
    { kind: "model", review: false, band: "High", slug: "fibromyalgia" },
  ];
  assert.deepEqual(seriousItems(items), [high]);
});

test("demo answers exist for every picker patient and use the answer date", () => {
  assert.deepEqual(PATIENTS.map((p) => p.id), ["maria", "elena", "sofia", "dana"]);
  for (const p of PATIENTS) {
    const qr = demoQuestionnaire(p.id);
    assert.equal(qr.resourceType, "QuestionnaireResponse", p.id);
    assert.match(qr.authored, /^2024-05-\d\dT12:00:00Z$/u, p.id);
  }
  assert.equal(demoQuestionnaire("nobody"), null);
  assert.equal(formatSentAt("2026-10-04T15:12:00Z", "UTC"), "October 4, 2026 at 3:12 PM");
  assert.equal(formatSentAt("garbage"), "");
});

test("the clinician demo starts every example with completed synthetic responses", () => {
  const responses = defaultDemoResponses();
  assert.deepEqual([...responses.keys()], PATIENTS.map((p) => p.id));
  for (const { qr, source } of responses.values()) {
    assert.equal(qr.status, "completed");
    assert.deepEqual(source, { kind: "demo", label: "Completed synthetic responses" });
  }
  assert.match(demoSource, /collapsePatientResponses: true/u);
  assert.match(demoSource, /shortName: false/u);
  assert.match(demoSource, /synthetic: false/u);
  assert.match(cardsSource, /"dash-review-responses", "Review responses"/u);
});

test("clinician page uses the shared nav and no inline scripts or styles", () => {
  assert.match(html, /<link rel="stylesheet" href="\/shared\/site-nav\.css(\?v=\d{8})?" \/>/u);
  assert.match(html, /<body data-door="clinician">/u);
  assert.match(html, /<script src="\/shared\/site-nav\.js(?:\?v=\d{8})?" defer><\/script>/u);
  assert.match(html, /<h1>Explore the clinician app<\/h1>/u);
  assert.match(html, /Use UNOM with synthetic patient records below, or <a class="demo-smartlink" href="\/smart\/"[^>]*>Launch via SMART on FHIR ↗<\/a>/u);
  assert.doesNotMatch(html, />Example patients<\/span>/u);
  assert.match(html, /role="group" aria-label="Example patients"/u);
  assert.match(clinicianStyles, /\.demo-intro \.demo-smartlink \{[^}]*color: var\(--accent\);[^}]*font-weight: 700;/u);
  assert.doesNotMatch(html, /href="\/developers\/#vectors"/u);
  assert.doesNotMatch(html, /style=/u);
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/u);
  assert.doesNotMatch(html, /—/u);
});

test("demo patients sit outside the patient frame and patient identity uses the shared dashboard position", () => {
  assert.match(html, /<nav class="demo-picker"[\s\S]*?<div class="demo-frame">/u);
  assert.doesNotMatch(html, /Condition review/u);
  assert.match(html, /<div class="demo-frame-body demo-body" id="dashboard"><\/div>/u);
  assert.match(html, /href="\/shared\/demo-frame\.css\?v=\d{8}"/u);
  assert.doesNotMatch(clinicianStyles, /demo-app-title/u);
  assert.doesNotMatch(html, /id="demo-patient-line"/u);
  assert.doesNotMatch(demoSource, /headerSlot/u);
});

test("clinician page and demo strings follow the copy rules: no exclamation marks or marketing words", () => {
  // the page without its doctype and comments: every "!" left would be visible text or an attribute value
  const page = html.replace(/^<!doctype html>/iu, "").replace(/<!--[\s\S]*?-->/gu, "");
  assert.doesNotMatch(page, /!/u);
  assert.doesNotMatch(html, BANNED);
  // the strings demo.js shows: patient blurbs and the quoted UI text
  const shown = [...PATIENTS.map((p) => p.blurb), ...[...demoSource.matchAll(/"([^"\n]{12,})"/gu)].map((m) => m[1])];
  for (const text of shown) {
    assert.doesNotMatch(text, /[—!]/u, text);
    assert.doesNotMatch(text, BANNED, text);
  }
  assert.doesNotMatch(demoSource, /—/u);
});
