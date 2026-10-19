import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

import * as discovery from "../functions/cds-services/index.js";
import {
  CONDITIONS,
  DEFAULT_FHIR_SERVER_ALLOWLIST,
  PREFETCH,
  SCORING_DATE_EXTENSION,
  SMART_APP_URL,
  SOURCE,
  allowedUrl,
  bundleFromPrefetch,
  buildCards,
  cardFor,
  checkPrefetchSubject,
  completePrefetch,
  driverDates,
  handleHook,
  parseAllowList,
  patientIdOf,
  scoringDate,
} from "../functions/cds-services/_cds.js";
import { scoreBundle } from "../web/shared/scorer.js";

const repo = new URL("../../", import.meta.url);
const readJson = (path) => JSON.parse(readFileSync(new URL(path, repo), "utf8"));
const bundleOf = (name) => readJson(`model/test_vectors/bundles/${name}.json`);
const AS_OF = "2024-06-01";

/** A patient-view request whose prefetch is split out of a test-vector bundle. */
function hookRequest(name, { asOf = AS_OF } = {}) {
  const resources = bundleOf(name).entry.map((e) => e.resource);
  const search = (type) => ({
    resourceType: "Bundle",
    type: "searchset",
    entry: resources.filter((r) => r.resourceType === type).map((resource) => ({ resource, search: { mode: "match" } })),
  });
  return {
    hookInstance: "11111111-2222-4333-8444-555555555555",
    hook: "patient-view",
    context: { userId: "Practitioner/example", patientId: name },
    extension: asOf ? { [SCORING_DATE_EXTENSION]: asOf } : undefined,
    prefetch: {
      patient: resources.find((r) => r.resourceType === "Patient"),
      conditions: search("Condition"),
      encounters: search("Encounter"),
      observations: search("Observation"),
      medications: search("MedicationRequest"),
      procedures: search("Procedure"),
    },
  };
}

const stubResults = {
  "unm-longcovid": {
    status: "scored",
    band: "High",
    probability: 0.0418,
    times_average: 4.43,
    drivers: [
      { id: "sym_any_w3_count_ge3", label: "3+ symptom types coded in days 31-90", group: "Symptoms after COVID",
        evidence: [{ date: "2024-02-20" }, { date: "2024-03-05" }, { date: "2024-03-25" }, { date: "2024-03-25" }] },
      { id: "covid_history_code", label: "Personal history of COVID-19 coded (days 31-90)", group: "Coding after COVID",
        evidence: [{ resourceType: "Condition", id: "maria-cond-20", date: "2024-03-12" }] },
      { id: "out_w3_ge4", label: "4+ outpatient visits in days 31-90", group: "Health care use",
        evidence: ["2024-02-20", "2024-03-01", "2024-03-05", "2024-03-12", "2024-03-25"].map((date) => ({ date })) },
      { id: "sex_female", label: "Female", group: "Demographics", evidence: [] },
    ],
  },
  "unm-chronicfatigue": {
    status: "scored",
    band: "Elevated",
    probability: 0.09,
    times_average: 1.73,
    drivers: [{ id: "sex_female", label: "Female", group: "Demographics", evidence: [] }],
  },
  "unm-typical": { status: "scored", band: "Typical", probability: 0.01, times_average: 1, drivers: [] },
  "unm-skip": { status: "not_scored", reason: "no documented COVID-19 index event" },
};
const stubScore = (model) => stubResults[model.model_id];
const LC = readJson("web/web/models/longcovid.json");
const CF = readJson("web/web/models/chronicfatigue.json");
const FM = readJson("web/web/models/fibromyalgia.json");
const stubModel = (id) => ({ model_id: id, version: "9.9.9", statement: "Research decision support. Not a diagnosis." });

// Copy rules for every card a clinician sees: no em dashes, no exclamation marks, no marketing words.
const BANNED = /\b(?:seamless\w*|leverag\w*|robust\w*|comprehensive\w*|empower\w*|unlock\w*|delve\w*|cutting-edge|game-chang\w*|journey\w*|harness\w*|effortless\w*)\b/iu;
function assertPlainCopy(text, where) {
  assert.doesNotMatch(text, /—/u, `${where}: no em dashes`);
  assert.doesNotMatch(text, /!/u, `${where}: no exclamation marks`);
  assert.doesNotMatch(text, BANNED, `${where}: no banned words`);
}

test("discovery lists the invisible-illness patient-view service with the prefetch templates", async () => {
  const response = discovery.onRequestGet();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
  assert.match(response.headers.get("Content-Type"), /application\/json/u);
  const body = await response.json();
  assert.equal(body.services.length, 1);
  const [service] = body.services;
  assert.equal(service.id, "invisible-illness");
  assert.equal(service.hook, "patient-view");
  assert.deepEqual(service.prefetch, {
    patient: "Patient/{{context.patientId}}",
    conditions: "Condition?patient={{context.patientId}}",
    encounters: "Encounter?patient={{context.patientId}}",
    observations: "Observation?patient={{context.patientId}}",
    medications: "MedicationRequest?patient={{context.patientId}}",
    procedures: "Procedure?patient={{context.patientId}}",
  });
  assert.ok(service.title && service.description);
});

test("preflight requests get the CORS headers the browser sandbox needs", () => {
  const response = discovery.onRequestOptions();
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
  assert.match(response.headers.get("Access-Control-Allow-Headers"), /Content-Type/u);
  assert.match(response.headers.get("Access-Control-Allow-Headers"), /Authorization/u);
  assert.match(response.headers.get("Access-Control-Allow-Methods"), /POST/u);
});

test("prefetch becomes one collection bundle with every resource once", () => {
  const original = bundleOf("maria");
  const request = hookRequest("maria");
  request.prefetch.extra = { resourceType: "Bundle", type: "searchset", entry: [
    { resource: { resourceType: "OperationOutcome", issue: [] }, search: { mode: "outcome" } },
    { resource: request.prefetch.patient },
  ] };
  const bundle = bundleFromPrefetch(request.prefetch);
  assert.equal(bundle.resourceType, "Bundle");
  assert.equal(bundle.type, "collection");
  const key = (r) => `${r.resourceType}/${r.id}`;
  assert.deepEqual(bundle.entry.map((e) => key(e.resource)).sort(), original.entry.map((e) => key(e.resource)).sort());
});

test("the scoring date comes from the extension when valid, otherwise today", () => {
  const now = new Date("2026-10-04T15:00:00Z");
  assert.equal(scoringDate({ extension: { [SCORING_DATE_EXTENSION]: "2024-06-01" } }, now), "2024-06-01");
  assert.equal(scoringDate({ extension: { [SCORING_DATE_EXTENSION]: "2024-02-31" } }, now), "2026-10-04");
  assert.equal(scoringDate({}, now), "2026-10-04");
});

test("cards: one per High or Elevated condition, warning before info, with the required fields", async () => {
  const models = ["unm-chronicfatigue", "unm-typical", "unm-longcovid", "unm-skip"].map(stubModel);
  const cards = await buildCards({ models, bundle: bundleOf("maria"), asOf: AS_OF, score: stubScore });
  assert.equal(cards.length, 2);
  assert.deepEqual(cards.map((c) => c.indicator), ["warning", "info"]);
  for (const card of cards) {
    assert.ok(card.summary.length < 140, card.summary);
    assert.deepEqual(card.source, SOURCE);
    assert.equal(card.source.label, "Undiagnosed No More (research decision support)");
    assert.deepEqual(card.links, [{ label: "Open Undiagnosed No More (SMART app)", url: SMART_APP_URL, type: "smart" }]);
    assert.equal(card.links[0].url, "https://undiagnosednomore.org/smart/");
    assert.doesNotMatch(`${card.summary} ${card.detail}`, /—/u, "no em-dashes in card text");
    assertPlainCopy(`${card.summary}\n${card.detail}\n${card.source.label}\n${card.links.map((l) => l.label).join("\n")}`, card.summary);
  }
  const [lc, cf] = cards;
  assert.match(lc.summary, /^Long COVID: High chart pattern, 4\.4×/u);
  assert.match(cf.summary, /^Chronic fatigue or ME\/CFS: Elevated/u);
  // top 3 drivers only, each with its dates
  assert.match(lc.detail, /1\. 3\+ symptom types coded in days 31-90 \(2024-02-20, 2024-03-05, 2024-03-25\)/u);
  assert.match(lc.detail, /2\. Personal history of COVID-19 coded \(days 31-90\) \(2024-03-12\)/u);
  assert.match(lc.detail, /3\. 4\+ outpatient visits in days 31-90 \(5 dates, 2024-02-20 to 2024-03-25\)/u);
  assert.doesNotMatch(lc.detail, /4\. Female/u);
  assert.match(lc.detail, /4\.2%/u);
  assert.match(lc.detail, /Not a diagnosis/u);
  assert.match(cf.detail, /Female \(patient demographics\)/u);
});

test("discovery, condition wording, and the could-not-score card follow the copy rules", async () => {
  const [service] = (await discovery.onRequestGet().json()).services;
  assertPlainCopy(`${service.title}\n${service.description}\n${service.usageRequirements}`, "discovery");
  assert.match(service.description, /could not score/u, "discovery names the could-not-score card");
  assert.match(service.description, /does not authenticate callers/u, "discovery states the prototype trust model");
  for (const [id, c] of Object.entries(CONDITIONS)) assertPlainCopy(Object.values(c).join("\n"), id);
  const crashed = await buildCards({ models: [stubModel("unm-throws")], bundle: bundleOf("lee"), asOf: AS_OF, score: () => { throw new Error("x"); } });
  const unread = await buildCards({
    models: [LC, CF, FM], bundle: bundleOf("maria"), asOf: AS_OF, score: scoreBundle, unavailable: ["Observation"], truncated: ["Observation"],
  });
  for (const card of [...crashed, ...unread]) assertPlainCopy(`${card.summary}\n${card.detail}`, card.summary);
  assert.equal(unread.length, 1);
  assert.match(unread[0].detail, /Observation stopped before its last page/u);
});

test("a long model name still gives a summary under 140 characters", () => {
  const card = cardFor(
    { model_id: "unm-other", version: "1.0.0", target: { label: "x".repeat(200) } },
    { status: "scored", band: "High", probability: 0.5, times_average: 10, drivers: [] },
  );
  assert.ok(card.summary.length < 140);
});

test("no cards for Typical or not-scored results; a scorer error gives a could-not-score card, never an empty list", async () => {
  const models = ["unm-typical", "unm-skip"].map(stubModel);
  assert.deepEqual(await buildCards({ models, bundle: bundleOf("lee"), asOf: AS_OF, score: stubScore }), []);
  const score = (model) => {
    if (model.model_id === "unm-throws") throw new Error("boom: Patient/lee 2024-01-08");
    return stubScore(model);
  };
  const cards = await buildCards({ models: [...models, stubModel("unm-throws")], bundle: bundleOf("lee"), asOf: AS_OF, score });
  assert.equal(cards.length, 1);
  assert.equal(cards[0].indicator, "info");
  assert.match(cards[0].summary, /^Could not score unm-throws: the scorer stopped on this chart\.$/u);
  assert.match(cards[0].detail, /no result, which is not the same as a negative result/u);
  assert.doesNotMatch(JSON.stringify(cards[0]), /boom|Patient\/lee|2024-01-08/u, "no error text or chart data in the card");
  assert.equal(driverDates({ group: "Health care use", evidence: [] }), "pattern across visits");
});

test("hook requests are validated, and missing prefetch without an allowed FHIR server answers 412", async () => {
  const options = { models: [stubModel("unm-longcovid")], score: stubScore };
  const base = { hookInstance: "11111111-2222-4333-8444-555555555555", hook: "patient-view" };
  assert.equal((await handleHook({ ...base, hook: "order-select", context: { patientId: "x" } }, options))[0], 400);
  assert.equal((await handleHook({ ...base, context: {} }, options))[0], 400);
  assert.equal((await handleHook({ hook: "patient-view", context: { patientId: "maria" } }, options))[0], 400, "hookInstance required");
  assert.equal((await handleHook({ ...base, context: { patientId: "maria/../x" } }, options))[0], 400, "patientId must be a FHIR id");
  assert.equal((await handleHook({ ...base, context: { patientId: "maria" }, prefetch: [] }, options))[0], 400);
  assert.equal((await handleHook({ ...base, context: { patientId: "maria" }, fhirAuthorization: { access_token: "t" } }, options))[0], 400,
    "a token needs a fhirServer");
  const noPrefetch = { ...base, context: { patientId: "maria" } };
  assert.equal((await handleHook(noPrefetch, options))[0], 412);
  const notAllowed = { ...noPrefetch, fhirServer: "https://evil.example.com/fhir", fhirAuthorization: { access_token: "t" } };
  let called = false;
  const [code] = await handleHook(notAllowed, { ...options, fetchImpl: async () => { called = true; return new Response("{}"); } });
  assert.equal(code, 412);
  assert.equal(called, false, "the token is never sent to a server off the allow-list");
  const [status, body] = await handleHook(hookRequest("maria"), options);
  assert.equal(status, 200);
  assert.equal(body.cards.length, 1);
});

test("prefetch must belong to context.patientId", async () => {
  const options = { models: [stubModel("unm-longcovid")], score: stubScore };
  const other = hookRequest("maria");
  other.context.patientId = "james";
  const [code, body] = await handleHook(other, options);
  assert.equal(code, 400);
  assert.match(body.error, /Patient\/maria, not Patient\/james/u);
  const mixed = hookRequest("maria");
  mixed.prefetch.conditions.entry.push({ resource: { resourceType: "Condition", id: "x", subject: { reference: "https://fhir.example.org/Patient/rosa" } } });
  assert.match((await handleHook(mixed, options))[1].error, /Condition for another patient/u);
  assert.equal(patientIdOf("Patient/maria"), "maria");
  assert.equal(patientIdOf("https://fhir.example.org/r4/Patient/maria/_history/3"), "maria");
  assert.equal(patientIdOf("Group/1"), null);
  assert.equal(checkPrefetchSubject(hookRequest("maria").prefetch, "maria"), null);
});

test("the fallback allow-list: https URL prefixes from configuration, synthetic sandbox by default", () => {
  assert.deepEqual(parseAllowList(undefined), [...DEFAULT_FHIR_SERVER_ALLOWLIST]);
  assert.deepEqual(parseAllowList(""), []);
  assert.deepEqual(parseAllowList("https://a.example.org/fhir, http://b.example.org https://c.example.org"), ["https://a.example.org/fhir", "https://c.example.org"]);
  const list = ["https://fhir.example.org/r4"];
  assert.equal(allowedUrl("https://fhir.example.org/r4", list), true);
  assert.equal(allowedUrl("https://fhir.example.org/r4/Condition?patient=x", list), true);
  assert.equal(allowedUrl("https://fhir.example.org/r4x/Condition", list), false);
  assert.equal(allowedUrl("https://fhir.example.org.evil.com/r4", list), false);
  assert.equal(allowedUrl("http://fhir.example.org/r4", list), false);
  assert.equal(allowedUrl("https://user:pw@fhir.example.org/r4", list), false);
  assert.equal(allowedUrl("https://launch.smarthealthit.org/v/r4/sim/abc/fhir", DEFAULT_FHIR_SERVER_ALLOWLIST), true);
});

const ALLOW = ["https://fhir.example.org/r4"];

test("missing prefetch is fetched from an allowed fhirServer with the bearer token, following next links", async () => {
  const request = hookRequest("maria");
  delete request.prefetch.conditions;
  request.fhirServer = "https://fhir.example.org/r4/";
  request.fhirAuthorization = { access_token: "token-123", token_type: "Bearer" };
  const conditions = hookRequest("maria").prefetch.conditions.entry;
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, auth: init.headers.Authorization });
    const first = !url.includes("page=2");
    const body = {
      resourceType: "Bundle",
      type: "searchset",
      entry: first ? conditions.slice(0, 3) : conditions.slice(3),
      link: first ? [{ relation: "next", url: "https://fhir.example.org/r4/Condition?patient=maria&page=2" }] : [],
    };
    return new Response(JSON.stringify(body), { status: 200 });
  };
  const { prefetch, unavailable } = await completePrefetch(request, fetchImpl, { allowList: ALLOW });
  assert.deepEqual(calls.map((c) => c.url), [
    "https://fhir.example.org/r4/Condition?patient=maria",
    "https://fhir.example.org/r4/Condition?patient=maria&page=2",
  ]);
  assert.ok(calls.every((c) => c.auth === "Bearer token-123"));
  assert.equal(prefetch.conditions.entry.length, conditions.length);
  assert.deepEqual(Object.keys(prefetch).sort(), Object.keys(PREFETCH).sort());
  assert.deepEqual(unavailable, []);
  // the same request with the server off the allow-list: nothing is fetched and Condition is unavailable
  calls.length = 0;
  const off = await completePrefetch(request, fetchImpl, { allowList: [] });
  assert.equal(calls.length, 0);
  assert.deepEqual(off.unavailable, ["Condition"]);
});

/** A fallback FHIR server: maria's resources by search, with per-type HTTP status and page size. */
function fakeServer({ status = {}, pageSize = 1000, total = false } = {}) {
  const resources = bundleOf("maria").entry.map((e) => e.resource);
  return async (url) => {
    const u = new URL(url);
    const type = u.pathname.split("/").pop();
    if (status[type]) return new Response(JSON.stringify({ resourceType: "OperationOutcome", issue: [{ severity: "error", code: "forbidden" }] }), { status: status[type] });
    const hits = resources.filter((r) => r.resourceType === type);
    const page = Number(u.searchParams.get("page") || 0);
    const slice = hits.slice(page * pageSize, (page + 1) * pageSize);
    const next = (page + 1) * pageSize < hits.length ? [{ relation: "next", url: `https://fhir.example.org/r4/${type}?patient=maria&page=${page + 1}` }] : [];
    return new Response(JSON.stringify({ resourceType: "Bundle", type: "searchset", ...(total ? { total: hits.length } : {}),
      entry: slice.map((resource) => ({ resource, search: { mode: "match" } })), link: next }), { status: 200 });
  };
}

test("a forbidden search becomes 'could not score', not an empty record or an empty card list", async () => {
  const request = hookRequest("maria");
  delete request.prefetch.observations;
  request.fhirServer = "https://fhir.example.org/r4";
  request.fhirAuthorization = { access_token: "token-123" };
  const [status, body] = await handleHook(request, { models: [LC, CF, FM], score: scoreBundle, fetchImpl: fakeServer({ status: { Observation: 403 } }), allowList: ALLOW });
  assert.equal(status, 200);
  assert.equal(body.cards.length, 1);
  const [card] = body.cards;
  assert.match(card.summary, /^Could not score Long COVID, Chronic fatigue or ME\/CFS, Fibromyalgia: Observation records could not be read\.$/u);
  assert.equal(card.indicator, "info");
  assert.match(card.detail, /missing records as unknown, not as absent/u);
});

test("pagination: a prefetch next link with no allowed server, or a fallback past the page cap, is reported as truncated", async () => {
  const request = hookRequest("maria");
  const entries = request.prefetch.conditions.entry;
  request.prefetch.conditions = { ...request.prefetch.conditions, entry: entries.slice(0, 2),
    link: [{ relation: "next", url: "https://fhir.example.org/r4/Condition?patient=maria&page=1" }] };
  const [, body] = await handleHook(request, { models: [LC], score: scoreBundle });
  assert.equal(body.cards.length, 1);
  assert.match(body.cards[0].summary, /^Could not score Long COVID: Condition records could not be read/u);
  assert.match(body.cards[0].detail, /Condition stopped before its last page/u);
  // with the server allowed, the prefetch next link is followed and Maria scores High again
  request.fhirServer = "https://fhir.example.org/r4";
  const followed = await handleHook(request, { models: [LC], score: scoreBundle, allowList: ALLOW, fetchImpl: fakeServer({ pageSize: 2 }) });
  assert.match(followed[1].cards[0].summary, /^Long COVID: High chart pattern/u);
  // a total larger than the entries returned is truncation too
  const short = hookRequest("maria");
  short.prefetch.encounters = { ...short.prefetch.encounters, total: 99 };
  assert.match((await handleHook(short, { models: [LC], score: scoreBundle }))[1].cards[0].summary, /Encounter records could not be read/u);
  // fallback with one condition per page and a 3-page cap: truncated (the deployed cap is MAX_PAGES)
  const capped = hookRequest("maria");
  delete capped.prefetch.conditions;
  capped.fhirServer = "https://fhir.example.org/r4";
  assert.deepEqual((await completePrefetch(capped, fakeServer({ pageSize: 1 }), { allowList: ALLOW })).truncated, [], "9 pages fit in 10");
  const done = await completePrefetch(capped, fakeServer({ pageSize: 1 }), { allowList: ALLOW, maxPages: 3 });
  assert.deepEqual(done.truncated, ["Condition"]);
  assert.deepEqual(done.unavailable, ["Condition"]);
});

test("an OperationOutcome in place of a search result means the resource is unavailable", async () => {
  const request = hookRequest("maria");
  request.prefetch.procedures = { resourceType: "OperationOutcome", issue: [{ severity: "error", code: "forbidden" }] };
  const [, body] = await handleHook(request, { models: [LC], score: scoreBundle });
  assert.match(body.cards[0].summary, /Procedure records could not be read/u);
  const warn = hookRequest("maria");
  warn.prefetch.procedures.entry.push({ resource: { resourceType: "OperationOutcome", issue: [{ severity: "warning" }] }, search: { mode: "outcome" } });
  assert.match((await handleHook(warn, { models: [LC], score: scoreBundle }))[1].cards[0].summary, /^Long COVID: High/u);
});

test("a valid partial birth date scores instead of returning HTTP 200 with no cards", async () => {
  const request = hookRequest("maria");
  request.prefetch.patient = { ...request.prefetch.patient, birthDate: "1980" };
  const [status, body] = await handleHook(request, { models: [LC], score: scoreBundle });
  assert.equal(status, 200);
  assert.match(body.cards[0].summary, /^Long COVID: High chart pattern/u);
});

// ---------------------------------------------------------------- integration with the shared scorer

const web = new URL("../web/", import.meta.url);
const integrationFiles = ["shared/scorer.js", "models/longcovid.json", "models/chronicfatigue.json", "models/fibromyalgia.json"];
const missing = integrationFiles.filter((path) => !existsSync(new URL(path, web)));

test("integration: the deployed function returns the cards the test vectors predict", {
  skip: missing.length
    ? `skipped: web/web/${missing.join(", web/web/")} not present yet (the shared scorer and model copies are built by another task)`
    : false,
}, async () => {
  const fn = await import("../functions/cds-services/invisible-illness.js");
  for (const name of ["maria", "elena", "james", "grace", "sofia"]) {
    const response = await fn.onRequestPost({
      request: new Request("https://undiagnosednomore.org/cds-services/invisible-illness", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(hookRequest(name)),
      }),
    });
    assert.equal(response.status, 200, name);
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
    const { cards } = await response.json();
    const flagged = [];
    for (const model of fn.MODELS) {
      const expectedPath = new URL(`model/test_vectors/expected/${model.model_id}-${model.version}/${name}.json`, repo);
      if (!existsSync(expectedPath)) continue;
      const expected = JSON.parse(readFileSync(expectedPath, "utf8"));
      if (expected.status === "scored" && ["High", "Elevated"].includes(expected.band)) flagged.push({ model, expected });
    }
    assert.equal(cards.length, flagged.length, `${name}: card count`);
    for (const { model, expected } of flagged) {
      const card = cards.find((c) => c.summary.includes(expected.band) && c.summary.includes(CONDITIONS[model.model_id].name));
      assert.ok(card, `${name}: a ${expected.band} card`);
      assert.equal(card.indicator, expected.band === "High" ? "warning" : "info");
      for (const driver of expected.drivers.slice(0, 3)) assert.ok(card.detail.includes(driver.label), driver.label);
    }
  }
});
