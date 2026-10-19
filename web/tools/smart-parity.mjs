#!/usr/bin/env node
// SMART parity check: does every synthetic test patient show the same condition review when the clinician app
// is launched through SMART on FHIR as on the clinician demo page?
//
// For each of the 18 test-vector patients it builds the dashboard two ways and compares what a clinician sees:
//   demo  - exactly as web/clinician/demo.js does: the bundle in web/data/patients/, bundleToRecord, the demo
//           answers (for the four demo personas), as of the demo date (June 1, 2024);
//   SMART - exactly as web/athena/app.js does: loadPatientRecord (fhir-data.js, same searches and paging) against
//           the sandbox FHIR server, recordToBundle, questionnaireFromRecord, as of today in UTC.
// Dates differ by design (the uploader shifts them), so every date is compared as days from the scoring anchor:
// the demo date for the demo, and the date the uploader shifted the chart to for SMART.
//
// It also replays the SMART chart on every day after that anchor to find how long the chart keeps showing the
// demo result (eligibility windows, look-back windows, age, records dated after the scoring date), and it checks
// the server's copy of every resource against the bundle (fields changed on upload, resources missing or extra).
//
//   node web/tools/smart-parity.mjs                      # live sandbox (read only), as of today UTC
//   node web/tools/smart-parity.mjs --as-of 2026-12-01   # as the app would show it on that date
//   node web/tools/smart-parity.mjs --offline DIR        # charts the uploader wrote with --write-dir DIR
//   options: --server URL, --patients maria,dana, --days 730, --min-days 90, --json
// Exit status 0 when every patient matches (apart from KNOWN_DIFFERENCES) and its result stays valid for at
// least --min-days after the anchor and through the --as-of date.

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  buildDashboard, bundleToRecord, MODEL_CARDS, patientPanelRows, questionnaireFromRecord, recordToBundle,
} from "../web/athena/cards.js";
import { loadPatientRecord } from "../web/athena/fhir-data.js";
import { AS_OF as DEMO_AS_OF, demoQuestionnaire } from "../web/clinician/demo.js";
import { SMART_SANDBOX_PATIENT_IDS } from "../web/smart/launcher-url.js";
import { daysBetween, hasIcdPrefix, parseFhirDate, resourceDate, todayUTC } from "../web/shared/scorer.js";
import { chartQuestionnaire } from "./write-demo-questionnaires.mjs";

const SITE = join(dirname(fileURLToPath(import.meta.url)), "..", "web");
export const DEFAULT_SERVER = "https://launch.smarthealthit.org/v/r4/fhir";
export { DEMO_AS_OF };
// as in model/test_vectors/upload_sandbox.py
export const FUTURE_GAP_DAYS = 365;
export const LONG_COVID_EARLIEST_INDEX = "2021-07-02";

/**
 * Differences no uniform date shift can remove. Each must match exactly (path and both values).
 * Will's first COVID-19 (March 15, 2021) tests that a diagnosis before the Long COVID model's earliest index date
 * is not the index, so the uploader keeps its date. In the demo it is also one of the dates of the ME/CFS card's
 * "COVID-19" finding (5-year look-back). After the shift the look-back starts in October 2021, after the cutoff,
 * so no date can be both before the cutoff and inside the look-back. The finding, its weight, and the score are
 * unchanged; only its list of dates is one shorter.
 */
export const KNOWN_DIFFERENCES = Object.freeze({
  will: [
    { path: "cards.chronicfatigue.evidence", demo: ["COVID-19: -1174,-179"], smart: ["COVID-19: -179"] },
  ],
});

// ---------------------------------------------------------------- inputs

export function loadSiteModels() {
  const models = {};
  for (const card of MODEL_CARDS) models[card.key] = JSON.parse(readFileSync(join(SITE, card.url), "utf8"));
  const lyme = JSON.parse(readFileSync(join(SITE, "data", "lyme_county.json"), "utf8"));
  return { models, lyme };
}

export function demoBundle(id) {
  return JSON.parse(readFileSync(join(SITE, "data", "patients", `${id}.json`), "utf8"));
}

/** What the uploader puts on the server for this patient, before shifting: the bundle plus the demo answers. */
export function sourceResources(id) {
  const list = demoBundle(id).entry.map((e) => e.resource);
  return demoQuestionnaire(id) ? [...list, chartQuestionnaire(id)] : list;
}

export function addDays(iso, n) {
  const t = new Date(`${iso}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}

/** A SMART client (the parts of fhirclient's Client that fhir-data.js uses) for an open FHIR server. */
export function httpClient(serverUrl, patientId, { fetchImpl = globalThis.fetch } = {}) {
  const base = String(serverUrl).replace(/\/+$/u, "");
  // fhirclient resolves a relative URL as serverUrl + "/" + path and throws an HttpError carrying .status
  const request = async (url) => {
    const absolute = /^https?:/iu.test(url) ? url : `${base}/${String(url).replace(/^\/+/u, "")}`;
    const response = await fetchImpl(absolute, { headers: { Accept: "application/fhir+json" } });
    if (!response.ok) {
      const error = new Error(`${response.status} ${absolute}`);
      error.status = response.status;
      throw error;
    }
    return response.json();
  };
  return { state: { serverUrl: base }, patient: { id: patientId, read: () => request(`Patient/${patientId}`) }, request };
}

function referencesPatient(resource, id) {
  const ref = `Patient/${id}`;
  return [resource?.subject?.reference, resource?.patient?.reference].some((r) => r === ref || String(r || "").endsWith(`/${ref}`));
}

/**
 * An in-memory FHIR server for offline runs and tests: reads, searches by patient or subject, and pages the way
 * the SMART sandbox (HAPI) does, with next links "<base>?_getpages=<id>&_getpagesoffset=<n>&_count=<n>".
 * Results come back newest id first, unlike the bundle, as a real server's order differs from the file's.
 * resources: every resource on the server. pageSize caps _count. Types in `unsupported` answer 404.
 */
export function memoryClient(resources, patientId, { serverUrl = DEFAULT_SERVER, pageSize = null, unsupported = [] } = {}) {
  const base = String(serverUrl).replace(/\/+$/u, "");
  const searches = new Map();
  const fail = (status) => Object.assign(new Error(String(status)), { status });
  const page = (key, offset, count) => {
    const all = searches.get(key);
    const entry = all.slice(offset, offset + count).map((resource) => ({ fullUrl: `${base}/${resource.resourceType}/${resource.id}`, resource }));
    const link = [{ relation: "self", url: `${base}?_getpages=${key}&_getpagesoffset=${offset}&_count=${count}` }];
    if (offset + count < all.length) {
      link.push({ relation: "next", url: `${base}?_getpages=${key}&_getpagesoffset=${offset + count}&_count=${count}&_bundletype=searchset` });
    }
    return { resourceType: "Bundle", type: "searchset", total: all.length, link, entry };
  };
  const request = async (url) => {
    const u = new URL(/^https?:/iu.test(url) ? url : `${base}/${String(url).replace(/^\/+/u, "")}`);
    const where = `${u.origin}${u.pathname}`;
    if (where !== base && !where.startsWith(`${base}/`)) throw fail(404);
    if (u.searchParams.has("_getpages")) {
      const key = u.searchParams.get("_getpages");
      if (!searches.has(key)) throw fail(410);
      return page(key, Number(u.searchParams.get("_getpagesoffset")), Number(u.searchParams.get("_count")));
    }
    const [type, id] = where.slice(base.length + 1).split("/");
    if (unsupported.includes(type)) throw fail(404);
    if (id) {
      const found = resources.find((r) => r.resourceType === type && r.id === id);
      if (!found) throw fail(404);
      return found;
    }
    const who = u.searchParams.get("patient") || String(u.searchParams.get("subject") || "").replace(/^Patient\//u, "");
    const key = `s${searches.size + 1}`;
    searches.set(key, resources.filter((r) => r.resourceType === type && referencesPatient(r, who)).reverse());
    const count = Number(u.searchParams.get("_count")) || 20;
    return page(key, 0, pageSize ? Math.min(pageSize, count) : count);
  };
  return { state: { serverUrl: base }, patient: { id: patientId, read: () => request(`Patient/${patientId}`) }, request };
}

/** Resources of the uploader's transaction files (upload_sandbox.py --write-dir DIR). */
export function offlineResources(dir) {
  const out = [];
  for (const name of readdirSync(dir).filter((n) => n.endsWith(".json")).sort()) {
    const tx = JSON.parse(readFileSync(join(dir, name), "utf8"));
    for (const entry of tx.entry || []) if (entry.resource) out.push(entry.resource);
  }
  return out;
}

// ---------------------------------------------------------------- what the clinician sees

const fixed = (x, digits) => (typeof x === "number" ? x.toFixed(digits) : null);

/**
 * The comparable content of a dashboard. Dates become days from `ref` (the scoring anchor), so a correctly
 * shifted chart gives the same digest as the demo.
 * drift: leave out what moves with the calendar by design (the patient's age, the scoring-date marker).
 * evidence: include the dates listed under each model finding (they change as records leave a look-back
 * window even while the finding, the score, and the band stay the same).
 */
export function digest(model, ref, { drift = false, evidence = true } = {}) {
  const day = (iso) => {
    const d = parseFhirDate(String(iso || "").slice(0, 10));
    return d ? daysBetween(ref, d) : null;
  };
  const cards = {};
  for (const { card, summary: s } of model.scores) {
    const item = model.items.find((i) => i.slug === card.slug);
    cards[card.key] = {
      shown: item.review,
      status: s.status === "not_scored" ? "does not apply" : s.status === "could_not_score" ? "could not score" : "scored",
      band: s.band ?? null,
      times: fixed(s.times, 1),
      percent: s.status === "scored" ? fixed(100 * s.probability, 1) : null,
      reason: s.reason ?? null,
      unavailable: s.unavailable ?? [],
      // for the scoring-date models day 0 is the scoring date itself
      index: s.indexDate && s.indexDate === model.asOf ? "scoring date" : day(s.indexDate),
      top: item.top,
      findings: s.drivers.map((d) => `${d.label} (${d.contribution.toFixed(3)})`),
      ...(evidence ? { evidence: s.drivers.map((d) => `${d.label}: ${d.events.map((e) => day(e.date)).join(",") || "none"}`) } : {}),
      context: s.context,
    };
  }
  const L = model.lyme;
  const lyme = {
    shown: L.review,
    chip: L.chip,
    headline: L.headline,
    sentence: L.sentence,
    metric: L.metric,
    alreadyCoded: L.alreadyCoded.map((f) => `${f.code} day ${day(f.date)}`),
    features: L.features.map((f) => `${f.label}: ${f.findings.map((x) => `${x.code || x.display} day ${day(x.date)}`).join("; ")}`),
    context: L.context,
  };
  const P = model.lupus;
  const lupus = {
    shown: P.review,
    chip: P.chip,
    headline: P.headline,
    sentence: P.sentence,
    existingDiagnosis: P.signal.existingDiagnosis,
    ana: P.signal.ana.label,
    found: P.found.map((c) => `${c.label} (${c.domain}, ${c.weight}) ${c.state} day ${day(c.evidence[0]?.date)}`),
    gaps: P.signal.gaps,
    priority: P.signal.priorityFindings,
    coverage: `${P.signal.coverage.available} of ${P.signal.coverage.total}`,
  };
  const q = model.questionnaire;
  const reported = q
    ? {
      ...q,
      authored: day(q.authored),
      onset: q.onset && day(q.onset) !== null ? `day ${day(q.onset)}` : q.onset,
      covidDate: q.covidDate && day(q.covidDate) !== null ? `day ${day(q.covidDate)}` : q.covidDate,
      rows: patientPanelRows(q).map(([label]) => label),
    }
    : null;
  const lanes = {};
  for (const e of model.timeline.events) lanes[e.lane] = (lanes[e.lane] || 0) + 1;
  const patient = { sex: model.patient.sex, place: model.patient.place, ...(drift ? {} : { age: model.patient.age }) };
  return {
    patient,
    overview: { needsReview: model.needsReview.map((i) => i.slug), couldNotScore: model.couldNotScore, unavailable: model.unavailable },
    cards,
    lyme,
    lupus,
    reported,
    timeline: {
      lanes,
      markers: model.timeline.markers.filter((m) => !(drift && m.id === "asof")).map((m) => `${m.id} day ${day(m.date)}`),
    },
  };
}

/** Every leaf where two digests differ: [{ path, demo, smart }]. */
export function differences(a, b, path = "") {
  if (JSON.stringify(a) === JSON.stringify(b)) return [];
  const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
  if (isObj(a) && isObj(b)) {
    return [...new Set([...Object.keys(a), ...Object.keys(b)])].flatMap((k) => differences(a[k], b[k], path ? `${path}.${k}` : k));
  }
  return [{ path, demo: a, smart: b }];
}

/** Split differences into known ones (KNOWN_DIFFERENCES, exact match) and the rest. */
export function splitKnown(id, diffs) {
  const known = KNOWN_DIFFERENCES[id] || [];
  const isKnown = (d) => known.some((k) => k.path === d.path && JSON.stringify(k.demo) === JSON.stringify(d.demo) && JSON.stringify(k.smart) === JSON.stringify(d.smart));
  return { unexpected: diffs.filter((d) => !isKnown(d)), known: diffs.filter(isKnown) };
}

// ---------------------------------------------------------------- the two paths

export function demoDashboard(id, { models, lyme }) {
  const bundle = demoBundle(id);
  return buildDashboard({ bundle, record: bundleToRecord(bundle), models, lyme, asOf: DEMO_AS_OF, questionnaire: demoQuestionnaire(id) });
}

export function smartDashboard(record, asOf, { models, lyme }) {
  return buildDashboard({ bundle: recordToBundle(record), record, models, lyme, asOf, questionnaire: questionnaireFromRecord(record) });
}

function serverResources(record) {
  return Object.entries(record.resources || {}).filter(([type]) => type !== "Binary").flatMap(([, list]) => list || []);
}

const keyOf = (r) => `${r.resourceType}/${r.id}`;

/**
 * Days the uploader moved this chart (the most common difference between a server resource's date and the same
 * resource's source date; the birth date when nothing else is dated), and the resources moved by another amount,
 * each marked expected when it is one of the uploader's two deliberate exceptions.
 */
export function inferShift(record, sources) {
  const source = new Map(sources.map((r) => [keyOf(r), r]));
  const pairs = [];
  for (const r of serverResources(record)) {
    const s = source.get(keyOf(r));
    const [a, b] = s ? [resourceDate(s), resourceDate(r)] : [null, null];
    if (a && b) pairs.push({ key: keyOf(r), from: a, days: daysBetween(a, b), resource: s });
  }
  const tally = new Map();
  for (const p of pairs) tally.set(p.days, (tally.get(p.days) || 0) + 1);
  let shift = [...tally.entries()].sort((x, y) => y[1] - x[1])[0]?.[0];
  if (shift === undefined) {
    const sb = parseFhirDate(source.get(`Patient/${record.patient?.id}`)?.birthDate, { birth: true });
    const rb = parseFhirDate(record.patient?.birthDate, { birth: true });
    shift = sb && rb ? daysBetween(sb, rb) : 0;
  }
  const unshifted = pairs.filter((p) => p.days !== shift).map(({ key, from, days, resource }) => {
    const preCutoffCovid = days === 0 && resource.resourceType === "Condition" && hasIcdPrefix(resource, ["U071"]) && from < LONG_COVID_EARLIEST_INDEX;
    const future = from > DEMO_AS_OF && days === shift + FUTURE_GAP_DAYS;
    return { key, days, expected: preCutoffCovid ? "COVID-19 before the Long COVID cutoff keeps its date" : future ? `dated after the scoring date, moved ${FUTURE_GAP_DAYS} days further out` : null };
  });
  return { shift, unshifted };
}

const DATE_ELEMENT = /(?:Date|DateTime|Instant)$|^(?:start|end|issued|authored|authoredOn|date|recorded|created)$/u;

/**
 * Fields the server copy changed, other than dates (the uploader shifts only date elements) and server metadata:
 * [{ key, path, source, server }]. Missing or added fields show as undefined.
 */
export function fieldChanges(record, sources) {
  const source = new Map(sources.map((r) => [keyOf(r), r]));
  const out = [];
  const walk = (a, b, path, key, field) => {
    if (JSON.stringify(a) === JSON.stringify(b)) return;
    if (path === "meta") {
      const strip = (m) => (m ? Object.fromEntries(Object.entries(m).filter(([k]) => !["versionId", "lastUpdated", "source"].includes(k))) : {});
      walk(strip(a), strip(b), "meta.*", key, "");
      return;
    }
    const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
    if (isObj(a) && isObj(b)) {
      for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) walk(a[k], b[k], path ? `${path}.${k}` : k, key, k);
      return;
    }
    if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) {
      a.forEach((x, i) => walk(x, b[i], `${path}[${i}]`, key, field));
      return;
    }
    if (typeof a === "string" && typeof b === "string" && DATE_ELEMENT.test(field) && parseFhirDate(a) && parseFhirDate(b)) return;
    out.push({ key, path, source: a, server: b });
  };
  for (const r of serverResources(record)) {
    const s = source.get(keyOf(r));
    if (s) walk(s, r, "", keyOf(r), "");
  }
  return out;
}

/** Resources on the server that the uploader did not send, and ones it sent that the server did not return. */
export function inventory(record, sources) {
  const server = new Set(serverResources(record).map(keyOf));
  const source = new Set(sources.map(keyOf));
  return { extra: [...server].filter((k) => !source.has(k)).sort(), missing: [...source].filter((k) => !server.has(k)).sort() };
}

/**
 * Days after the anchor the SMART chart keeps showing the demo: the first day d in 0..maxDays whose digest differs
 * from the demo (apart from known differences), minus one; maxDays when none differs. Returns { days, breaksOn, why }.
 */
export function validity(id, record, anchor, demo, inputs, { maxDays = 730, evidence = false } = {}) {
  const want = digest(demo, DEMO_AS_OF, { drift: true, evidence });
  for (let d = 0; d <= maxDays; d += 1) {
    const asOf = addDays(anchor, d);
    const diff = splitKnown(id, differences(want, digest(smartDashboard(record, asOf, inputs), anchor, { drift: true, evidence }))).unexpected;
    if (diff.length) return { days: d - 1, breaksOn: asOf, why: diff };
  }
  return { days: maxDays, breaksOn: null, why: [] };
}

/**
 * The full comparison for one patient. client: a SMART client (httpClient or memoryClient).
 * evidenceScan: false skips the scan for how long the finding dates stay identical.
 */
export async function comparePatient(id, client, { asOf = todayUTC(), maxDays = 730, inputs = loadSiteModels(), evidenceScan = true } = {}) {
  const sources = sourceResources(id);
  const demo = demoDashboard(id, inputs);
  const record = await loadPatientRecord(client);
  const { shift, unshifted } = inferShift(record, sources);
  const anchor = addDays(DEMO_AS_OF, shift);
  // on the anchor date everything must match, finding dates included
  const atAnchor = splitKnown(id, differences(digest(demo, DEMO_AS_OF), digest(smartDashboard(record, anchor, inputs), anchor)));
  // on another date, what moves with the calendar by design is left out (validity below covers the rest)
  const later = asOf !== anchor;
  const options = { drift: later, evidence: !later };
  const smart = smartDashboard(record, asOf, inputs);
  const onDate = later ? splitKnown(id, differences(digest(demo, DEMO_AS_OF, options), digest(smart, anchor, options))) : atAnchor;
  const valid = validity(id, record, anchor, demo, inputs, { maxDays });
  const evidenceValid = evidenceScan ? validity(id, record, anchor, demo, inputs, { maxDays, evidence: true }) : null;
  const report = {
    id,
    asOf,
    anchor,
    shift,
    unshifted,
    changes: fieldChanges(record, sources),
    inventory: inventory(record, sources),
    access: record.access.filter((a) => a.status !== "Available"),
    atAnchor: atAnchor.unexpected,
    today: onDate.unexpected,
    known: atAnchor.known,
    valid,
    evidenceValid,
    remaining: valid.days - daysBetween(anchor, asOf),
    demo: digest(demo, DEMO_AS_OF, options),
    smart: digest(smart, anchor, options),
  };
  report.ok = !report.atAnchor.length && !report.today.length && !report.changes.length
    && !report.inventory.extra.length && !report.inventory.missing.length && !report.access.length
    && report.unshifted.every((u) => u.expected) && report.remaining >= 0;
  return report;
}

// ---------------------------------------------------------------- report

function cell(c) {
  if (c.status === "scored") return `${c.band} ${c.times}x${c.shown ? " *" : ""}`;
  return c.status === "could not score" ? "could not score" : "n/a";
}

export function summaryRow(dg) {
  const reported = dg.reported ? `answers (${dg.reported.rows.length} rows)` : "none";
  return [
    cell(dg.cards.longcovid), cell(dg.cards.chronicfatigue), cell(dg.cards.fibromyalgia),
    `${dg.lyme.chip}${dg.lyme.shown ? " *" : ""}`, `${dg.lupus.chip}${dg.lupus.shown ? " *" : ""}`, reported,
  ];
}

const short = (v) => {
  const s = JSON.stringify(v);
  return s && s.length > 200 ? `${s.slice(0, 197)}...` : s;
};

export function formatReport(results, { minDays = 90 } = {}) {
  const lines = [];
  lines.push("Columns: Long COVID / ME/CFS / Fibromyalgia / Lyme / Lupus / patient-reported (* = under Needs review)");
  lines.push("");
  lines.push("| Patient | Demo (June 1, 2024) | SMART | Match | Anchor | Result valid (days after anchor) | Finding dates identical (days) | Days left |");
  lines.push("|---|---|---|---|---|---|---|---|");
  for (const r of results) {
    const demo = summaryRow(r.demo).join(" / ");
    const smart = summaryRow(r.smart).join(" / ");
    const n = r.atAnchor.length + (r.asOf === r.anchor ? 0 : r.today.length);
    const match = n ? `${n} differences` : r.known.length ? "yes (1 known)" : "yes";
    lines.push(`| ${r.id} | ${demo} | ${smart === demo ? "same" : smart} | ${match} | ${r.anchor} | ${r.valid.days} | ${r.evidenceValid ? r.evidenceValid.days : "not checked"} | ${r.remaining} |`);
  }
  for (const r of results) {
    const notes = [];
    const list = (diffs) => diffs.map((d) => `  ${d.path}: demo ${short(d.demo)} | SMART ${short(d.smart)}`);
    if (r.atAnchor.length) notes.push(`differences at the anchor (${r.anchor}):`, ...list(r.atAnchor));
    if (r.today.length && r.asOf !== r.anchor) notes.push(`differences as of ${r.asOf}:`, ...list(r.today));
    if (r.known.length) notes.push("known difference (see KNOWN_DIFFERENCES):", ...list(r.known));
    for (const u of r.unshifted) notes.push(`${u.key} moved ${u.days} days, not ${r.shift}: ${u.expected || "UNEXPECTED"}`);
    for (const c of r.changes) notes.push(`changed on the server: ${c.key} ${c.path}: ${short(c.source)} -> ${short(c.server)}`);
    if (r.inventory.extra.length) notes.push(`on the server but not uploaded: ${r.inventory.extra.join(", ")}`);
    if (r.inventory.missing.length) notes.push(`uploaded but not returned by the server: ${r.inventory.missing.join(", ")}`);
    if (r.access.length) notes.push(`searches not fully available: ${r.access.map((a) => `${a.resourceType} ${a.status}`).join(", ")}`);
    if (r.valid.breaksOn) notes.push(`result first differs on ${r.valid.breaksOn} (day ${r.valid.days + 1}): ${r.valid.why.map((d) => `${d.path}: ${short(d.demo)} -> ${short(d.smart)}`).join("; ")}`);
    if (r.valid.days < minDays) notes.push(`result valid for fewer than ${minDays} days after the anchor`);
    if (r.remaining < 0) notes.push(`past its validity on ${r.asOf}: rerun model/test_vectors/upload_sandbox.py`);
    if (notes.length) lines.push("", `${r.id}:`, ...notes.map((n) => `  ${n}`));
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------- CLI

function parseArgs(argv) {
  const opts = { server: DEFAULT_SERVER, asOf: todayUTC(), offline: null, patients: [...SMART_SANDBOX_PATIENT_IDS], days: 730, minDays: 90, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--server") opts.server = next();
    else if (a === "--as-of") opts.asOf = next();
    else if (a === "--offline") opts.offline = next();
    else if (a === "--patients") opts.patients = next().split(",").filter(Boolean);
    else if (a === "--days") opts.days = Number(next());
    else if (a === "--min-days") opts.minDays = Number(next());
    else if (a === "--json") opts.json = true;
    else throw new Error(`unknown option ${a}`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(opts.asOf)) throw new Error("--as-of must be YYYY-MM-DD");
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const inputs = loadSiteModels();
  const offline = opts.offline ? offlineResources(opts.offline) : null;
  const results = [];
  for (const id of opts.patients) {
    const client = offline ? memoryClient(offline, id) : httpClient(opts.server, id);
    results.push(await comparePatient(id, client, { asOf: opts.asOf, maxDays: opts.days, inputs }));
  }
  if (opts.json) console.log(JSON.stringify(results, null, 2));
  else {
    console.log(`SMART parity check: ${offline ? `offline charts in ${opts.offline}` : opts.server}, as of ${opts.asOf} (demo as of ${DEMO_AS_OF})\n`);
    console.log(formatReport(results, opts));
  }
  const ok = results.every((r) => r.ok && r.valid.days >= opts.minDays);
  const shortest = Math.min(...results.map((r) => r.valid.days));
  (opts.json ? console.error : console.log)(`\n${ok ? "PASS" : "FAIL"}: ${results.filter((r) => r.ok).length} of ${results.length} patients match; shortest result validity ${shortest} days after the anchor; fewest days left ${Math.min(...results.map((r) => r.remaining))}.`);
  process.exitCode = ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`error: ${error.message}`);
    process.exitCode = 2;
  });
}
