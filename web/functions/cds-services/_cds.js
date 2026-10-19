// Shared pieces of the CDS Hooks service. Pure functions only: no I/O except the optional
// FHIR fallback fetch, which takes its fetch implementation as an argument.
// This module exports no onRequest handler, so Cloudflare Pages does not route it.
//
// Trust model (web/README.md, "CDS Hooks service"): this is a synthetic-data prototype. It validates the
// request and checks that every prefetched resource belongs to context.patientId, and it sends the bearer
// token in fhirAuthorization only to FHIR servers on a configured allow-list. It does not authenticate the
// caller; a deployment with real patient data must verify the CDS client's JWT (CDS Hooks 2.0, "Trusting CDS
// Clients") before handling the request.

export const SERVICE_ID = "invisible-illness";
export const SMART_APP_URL = "https://undiagnosednomore.org/smart/";
export const SOURCE = Object.freeze({
  label: "Undiagnosed No More (research decision support)",
  url: "https://undiagnosednomore.org/developers/",
});
export const SCORING_DATE_EXTENSION = "org.undiagnosednomore.scoring-date";
export const SUMMARY_MAX = 139; // CDS Hooks: summary SHOULD be under 140 characters

/** Resource type each prefetch key holds. */
export const PREFETCH_TYPES = Object.freeze({
  patient: "Patient",
  conditions: "Condition",
  encounters: "Encounter",
  observations: "Observation",
  medications: "MedicationRequest",
  procedures: "Procedure",
});

/** Pages followed per search before the search is reported as truncated. */
export const MAX_PAGES = 10;

/**
 * FHIR servers the prefetch fallback may call (with the bearer token) when the deployment sets no
 * CDS_FHIR_SERVER_ALLOWLIST: the public SMART Health IT sandbox, which holds synthetic data only.
 */
export const DEFAULT_FHIR_SERVER_ALLOWLIST = Object.freeze(["https://launch.smarthealthit.org/v/r4/"]);

export const PREFETCH = Object.freeze({
  patient: "Patient/{{context.patientId}}",
  conditions: "Condition?patient={{context.patientId}}",
  encounters: "Encounter?patient={{context.patientId}}",
  observations: "Observation?patient={{context.patientId}}",
  medications: "MedicationRequest?patient={{context.patientId}}",
  procedures: "Procedure?patient={{context.patientId}}",
});

export const DISCOVERY = Object.freeze({
  services: [
    {
      hook: "patient-view",
      id: SERVICE_ID,
      title: "Undiagnosed No More: invisible illness check",
      description:
        "Scores the chart with the Long COVID, chronic fatigue (ME/CFS), fibromyalgia, endometriosis, Lyme disease, lupus, migraine, depression, and anxiety models and returns a card when a " +
        "condition is in the High or Elevated band, plus one information card naming any condition it could not score. " +
        "Research decision support; not a diagnosis. Synthetic-data prototype: the service does not authenticate callers.",
      prefetch: PREFETCH,
      usageRequirements: "Read access to the patient's Condition, Encounter, Observation, MedicationRequest, and Procedure resources.",
    },
  ],
});

// Card wording per model. Next steps follow docs/MODELS_GUIDE.md.
export const CONDITIONS = Object.freeze({
  "unm-longcovid": {
    name: "Long COVID",
    pattern: "Chart pattern similar to adults later coded with Long COVID.",
    probability: "Estimated probability, as of day 90, of a Long COVID code 91 to 455 days after COVID-19",
    average: "the average for adults 90 days after COVID-19",
    averageShort: "the post-COVID average",
    nextStep:
      "Review the dated findings and ask the patient to complete the RECOVER symptom list, the DePaul " +
      "post-exertional malaise screen, and the PCFS functional status grade. If the review supports post-COVID " +
      "illness, consider a post-COVID clinic referral or clinical trial screening.",
  },
  "unm-chronicfatigue": {
    name: "Chronic fatigue or ME/CFS",
    pattern: "Chart pattern similar to patients who report a chronic fatigue or ME/CFS diagnosis that was never coded.",
    probability: "Probability that the patient reports a chronic fatigue diagnosis",
    average: "the average for adults with a visit in the past year",
    averageShort: "the average",
    nextStep:
      "Ask the patient about post-exertional malaise (DePaul screen) and review the IOM 2015 ME/CFS criteria: " +
      "reduced activity for more than 6 months with fatigue, post-exertional malaise, unrefreshing sleep, and " +
      "cognitive impairment or orthostatic intolerance.",
  },
  "unm-fibromyalgia": {
    name: "Fibromyalgia",
    pattern: "Chart pattern similar to patients who report a fibromyalgia diagnosis that was never coded.",
    probability: "Probability that the patient reports a fibromyalgia diagnosis",
    average: "the average for adults with a visit in the past year",
    averageShort: "the average",
    nextStep:
      "Assess the patient with the 2016 revised fibromyalgia diagnostic criteria (Wolfe et al.): Widespread Pain " +
      "Index of 7 or more with Symptom Severity Scale of 5 or more, or WPI 4 to 6 with SSS 9 or more; pain in at " +
      "least 4 of 5 regions; symptoms for at least 3 months.",
  },
  "unm-endometriosis": {
    name: "Endometriosis",
    pattern: "Chart pattern similar to women who report an endometriosis diagnosis that was never coded.",
    probability: "Probability that the patient reports an endometriosis diagnosis",
    average: "the average for women with a visit in the past year",
    averageShort: "the average",
    nextStep:
      "Ask about painful periods, deep pain during sex, and pain with urination or bowel movements, and whether " +
      "symptoms follow the menstrual cycle (ESHRE 2022 guideline); consider pelvic imaging and gynecology referral.",
  },
  "unm-lyme": {
    name: "Lyme disease",
    pattern: "Chart pattern similar to patients who report a Lyme disease diagnosis that was never coded.",
    probability: "Probability that the patient reports a Lyme disease diagnosis",
    average: "the average for adults with a visit in the past year",
    averageShort: "the average",
    nextStep:
      "Ask about tick exposure and an expanding rash (erythema migrans). Without erythema migrans, if exposure and " +
      "symptoms are consistent with Lyme disease, use CDC's two-step serologic testing.",
  },
  "unm-lupus": {
    name: "Lupus",
    pattern: "Chart pattern similar to patients who report a lupus diagnosis that was never coded.",
    probability: "Probability that the patient reports a lupus diagnosis",
    average: "the average for adults with a visit in the past year",
    averageShort: "the average",
    nextStep:
      "Check for a positive antinuclear antibody test (1:80 or higher), the entry criterion of the 2019 EULAR/ACR " +
      "classification criteria; if it is present, review the criteria's clinical and immunologic domains.",
  },
  "unm-migraine": {
    name: "Migraine",
    pattern: "Chart pattern similar to patients who report a migraine diagnosis that was never coded.",
    probability: "Probability that the patient reports a migraine diagnosis",
    average: "the average for adults with a visit in the past year",
    averageShort: "the average",
    nextStep:
      "Review the headaches against the ICHD-3 criteria for migraine (frequency, duration, pain features, and nausea " +
      "or sensitivity to light and sound); if they fit, discuss acute and preventive treatment.",
  },
  "unm-depression": {
    name: "Depression",
    pattern: "Chart pattern similar to patients who report a depression diagnosis that was never coded.",
    probability: "Probability that the patient reports a depression diagnosis",
    average: "the average for adults with a visit in the past year",
    averageShort: "the average",
    nextStep:
      "Screen with the PHQ-9 (USPSTF 2023); if it is 10 or more, assess for major depression and ask about thoughts " +
      "of self-harm, following your clinic's safety protocol and sharing the 988 Suicide and Crisis Lifeline.",
  },
  "unm-anxiety": {
    name: "Anxiety",
    pattern: "Chart pattern similar to patients who report an anxiety diagnosis that was never coded.",
    probability: "Probability that the patient reports an anxiety diagnosis",
    average: "the average for adults with a visit in the past year",
    averageShort: "the average",
    nextStep:
      "Screen with the GAD-7 (USPSTF 2023 recommends anxiety screening for adults under 65); if it is 10 or more, " +
      "assess for an anxiety disorder.",
  },
});

export const BAND_INDICATOR = Object.freeze({ High: "warning", Elevated: "info" });

const CORS_HEADERS = Object.freeze({
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
});

export function corsHeaders(extra = {}) {
  return { ...CORS_HEADERS, ...extra };
}

export function jsonResponse(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: corsHeaders({
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...extra,
    }),
  });
}

export function preflightResponse() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

// ---------------------------------------------------------------- request handling

function resourcesOf(value) {
  if (!value || typeof value !== "object") return [];
  if (value.resourceType === "Bundle") {
    return (Array.isArray(value.entry) ? value.entry : [])
      .filter((entry) => entry?.search?.mode !== "outcome")
      .map((entry) => entry?.resource)
      .filter((resource) => resource && typeof resource === "object");
  }
  return value.resourceType ? [value] : [];
}

/** Builds one FHIR collection Bundle from CDS Hooks prefetch values (resources or search Bundles). */
export function bundleFromPrefetch(prefetch) {
  const seen = new Set();
  const entry = [];
  for (const value of Object.values(prefetch || {})) {
    for (const resource of resourcesOf(value)) {
      if (resource.resourceType === "OperationOutcome") continue;
      const key = resource.id ? `${resource.resourceType}/${resource.id}` : null;
      if (key && seen.has(key)) continue;
      if (key) seen.add(key);
      entry.push({ resource });
    }
  }
  return { resourceType: "Bundle", type: "collection", entry };
}

/** Scoring date: the request's scoring-date extension (used to replay test vectors), else today in UTC. */
export function scoringDate(body, now = new Date()) {
  const requested = body?.extension?.[SCORING_DATE_EXTENSION];
  if (typeof requested === "string" && /^\d{4}-\d{2}-\d{2}$/.test(requested)) {
    const parsed = new Date(`${requested}T00:00:00Z`);
    if (!Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === requested) return requested;
  }
  return now.toISOString().slice(0, 10);
}

const FHIR_ID = /^[A-Za-z0-9\-.]{1,64}$/u;
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** Checks the hook request (CDS Hooks 2.0 required fields for patient-view); returns an error message or null. */
export function validateRequest(body) {
  if (!isObject(body)) return "request body must be a JSON object";
  if (body.hook !== "patient-view") return "this service handles the patient-view hook only";
  if (typeof body.hookInstance !== "string" || !body.hookInstance) return "hookInstance is required";
  if (!isObject(body.context)) return "context is required";
  const patientId = body.context.patientId;
  if (typeof patientId !== "string" || !patientId) return "context.patientId is required";
  if (!FHIR_ID.test(patientId)) return "context.patientId must be a FHIR id";
  if (body.context.userId !== undefined && typeof body.context.userId !== "string") return "context.userId must be a string";
  if (body.prefetch !== undefined && body.prefetch !== null && !isObject(body.prefetch)) return "prefetch must be an object";
  if (body.fhirServer !== undefined && typeof body.fhirServer !== "string") return "fhirServer must be a string";
  if (body.fhirAuthorization !== undefined && body.fhirAuthorization !== null) {
    if (!isObject(body.fhirAuthorization) || typeof body.fhirAuthorization.access_token !== "string") {
      return "fhirAuthorization must carry an access_token";
    }
    if (typeof body.fhirServer !== "string") return "fhirAuthorization requires fhirServer";
  }
  return null;
}

/** The deployment's allow-list (comma- or space-separated https URL prefixes); unset means the default list. */
export function parseAllowList(value) {
  if (value === undefined || value === null) return [...DEFAULT_FHIR_SERVER_ALLOWLIST];
  return String(value).split(/[\s,]+/u).filter((s) => /^https:\/\//u.test(s));
}

/** True when `url` is on the allow-list: an https URL equal to an entry or under it (same origin, path prefix). */
export function allowedUrl(url, allowList = []) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" || u.username || u.password) return false;
  return allowList.some((entry) => {
    let a;
    try {
      a = new URL(entry);
    } catch {
      return false;
    }
    const base = a.pathname.endsWith("/") ? a.pathname : `${a.pathname}/`;
    return a.origin === u.origin && (`${u.pathname}/`.startsWith(base) || u.pathname === a.pathname);
  });
}

/** "Patient/123", ".../Patient/123", or ".../Patient/123/_history/2" -> "123"; anything else -> null. */
export function patientIdOf(reference) {
  const m = /(?:^|\/)Patient\/([A-Za-z0-9\-.]{1,64})(?:\/_history\/[^/]+)?$/u.exec(String(reference || ""));
  return m ? m[1] : null;
}

/** Every prefetched resource must belong to the requested patient; returns an error message or null. */
export function checkPrefetchSubject(prefetch, patientId) {
  for (const [key, value] of Object.entries(prefetch || {})) {
    for (const resource of resourcesOf(value)) {
      if (resource.resourceType === "OperationOutcome") continue;
      if (resource.resourceType === "Patient") {
        if (resource.id !== patientId) return `prefetch ${key} holds Patient/${resource.id ?? "(no id)"}, not Patient/${patientId}`;
        continue;
      }
      for (const field of ["subject", "patient"]) {
        const ref = resource[field]?.reference;
        if (ref === undefined) continue;
        const id = patientIdOf(ref);
        if (id !== null && id !== patientId) return `prefetch ${key} holds a ${resource.resourceType} for another patient`;
      }
    }
  }
  return null;
}

function fillTemplate(template, patientId) {
  return template.replaceAll("{{context.patientId}}", encodeURIComponent(patientId));
}

const nextOf = (bundle) => (Array.isArray(bundle?.link) ? bundle.link : []).find((link) => link?.relation === "next")?.url || null;
const matchCount = (bundle) => (Array.isArray(bundle?.entry) ? bundle.entry : []).filter((e) => e?.search?.mode !== "outcome" && e?.resource).length;

/** A searchset that reports a failure: an OperationOutcome entry with an error or fatal issue. */
function failedSearch(value) {
  if (value?.resourceType === "OperationOutcome") return true;
  return (Array.isArray(value?.entry) ? value.entry : []).some((e) => e?.resource?.resourceType === "OperationOutcome"
    && (e.resource.issue || []).some((i) => i?.severity === "error" || i?.severity === "fatal"));
}

/**
 * Reads `url` and its next links. Returns { status: "ok" | "failed" | "truncated", data } where data is the
 * resource (a read) or a searchset Bundle holding every page's entries. Pages must stay on the allow-list.
 */
async function readSearch(url, { fetchImpl, headers, allowList, maxPages, first = null }) {
  const entries = [];
  let data = first;
  let next = first ? nextOf(first) : url;
  if (first) entries.push(...(Array.isArray(first.entry) ? first.entry : []));
  let pages = first ? 1 : 0;
  while (next) {
    if (pages >= maxPages || !allowedUrl(next, allowList)) return { status: "truncated" };
    let response;
    try {
      response = await fetchImpl(next, { headers });
    } catch {
      return { status: "failed" };
    }
    if (!response.ok) return { status: "failed", httpStatus: response.status };
    try {
      data = await response.json();
    } catch {
      return { status: "failed" };
    }
    pages += 1;
    if (data?.resourceType !== "Bundle") return failedSearch(data) ? { status: "failed" } : { status: "ok", data };
    entries.push(...(Array.isArray(data.entry) ? data.entry : []));
    next = nextOf(data);
  }
  const bundle = { resourceType: "Bundle", type: "searchset", entry: entries };
  if (failedSearch(bundle)) return { status: "failed" };
  const total = Number.isInteger(data?.total) ? data.total : Number.isInteger(first?.total) ? first.total : null;
  if (total !== null && matchCount(bundle) < total) return { status: "truncated" };
  return { status: "ok", data: bundle };
}

/**
 * Completes the prefetch (CDS Hooks prefetch fallback): keys the client did not send are read from fhirServer,
 * and a prefetched searchset with a next link is read to the end, both only when fhirServer is on the
 * allow-list. Returns { prefetch, unavailable, truncated } where unavailable lists the resource types that
 * could not be read in full (failed, forbidden, truncated, or missing with no allowed server), or null when
 * the Patient resource itself cannot be had.
 */
export async function completePrefetch(body, fetchImpl, { maxPages = MAX_PAGES, allowList = [] } = {}) {
  const prefetch = { ...(body.prefetch || {}) };
  const server = typeof body.fhirServer === "string" ? body.fhirServer.replace(/\/+$/u, "") : "";
  const canFetch = Boolean(server) && typeof fetchImpl === "function" && allowedUrl(server, allowList);
  const headers = { Accept: "application/fhir+json" };
  const token = body.fhirAuthorization?.access_token;
  if (token) headers.Authorization = `Bearer ${token}`;
  const unavailable = new Set();
  const truncated = new Set();
  for (const [key, type] of Object.entries(PREFETCH_TYPES)) {
    const value = prefetch[key];
    let outcome = null;
    if (value != null) {
      if (failedSearch(value)) outcome = { status: "failed" };
      else if (value.resourceType === "Bundle" && (nextOf(value) || (Number.isInteger(value.total) && matchCount(value) < value.total))) {
        outcome = canFetch || !nextOf(value)
          ? await readSearch(null, { fetchImpl, headers, allowList, maxPages: maxPages + 1, first: value })
          : { status: "truncated" };
      } else continue;
    } else if (canFetch) {
      outcome = await readSearch(`${server}/${fillTemplate(PREFETCH[key], body.context.patientId)}`, { fetchImpl, headers, allowList, maxPages });
    } else {
      outcome = { status: "failed" };
    }
    if (outcome.status === "ok") {
      prefetch[key] = outcome.data;
      continue;
    }
    if (type === "Patient") return null;
    unavailable.add(type);
    if (outcome.status === "truncated") truncated.add(type);
    prefetch[key] = null;
  }
  for (const k of Object.keys(prefetch)) if (prefetch[k] == null) delete prefetch[k];
  return { prefetch, unavailable: [...unavailable].sort(), truncated: [...truncated].sort() };
}

// ---------------------------------------------------------------- cards

function percent(p) {
  const value = 100 * p;
  return `${value < 10 ? value.toFixed(1) : value.toFixed(0)}%`;
}

function times(x) {
  return `${x.toFixed(1)}×`;
}

/** Dates of the chart resources behind one driver, as short text. */
export function driverDates(driver) {
  const dates = [...new Set((driver?.evidence || []).map((e) => e?.date).filter((d) => d && d !== "None"))].sort();
  if (!dates.length) {
    return driver?.group === "Demographics" ? "patient demographics" : "pattern across visits";
  }
  if (dates.length <= 3) return dates.join(", ");
  return `${dates.length} dates, ${dates[0]} to ${dates[dates.length - 1]}`;
}

function clip(text, max = SUMMARY_MAX) {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

/** One CDS Hooks card for a scored result in a flagged band, or null. */
export function cardFor(model, result) {
  if (!result || result.status !== "scored") return null;
  const indicator = BAND_INDICATOR[result.band];
  if (!indicator) return null;
  const condition = CONDITIONS[model.model_id] || {
    name: model.target?.label || model.model_id,
    pattern: "Chart pattern similar to patients with this condition.",
    probability: "Probability",
    average: "the average",
    averageShort: "the average",
    nextStep: "Review the dated findings.",
  };
  const multiple = Number.isFinite(result.times_average) ? result.times_average : null;
  const summary = clip(
    `${condition.name}: ${result.band} chart pattern` +
      (multiple !== null ? `, ${times(multiple)} ${condition.averageShort}` : "") +
      ". Review the dated findings.",
  );
  const drivers = (result.drivers || []).slice(0, 3);
  const lines = [
    `**${condition.pattern}**`,
    "",
    `${condition.probability}: ${percent(result.probability)}` +
      (multiple !== null ? ` (${times(multiple)} ${condition.average})` : "") +
      `. Band: ${result.band} (a descriptive score category, not a validated action threshold).`,
    "",
  ];
  if (drivers.length) {
    lines.push("Top findings in the chart:", "");
    drivers.forEach((driver, i) => lines.push(`${i + 1}. ${driver.label || driver.id} (${driverDates(driver)})`));
    lines.push("");
  }
  lines.push(`Next step: ${condition.nextStep}`, "");
  lines.push(`${model.statement || "Research decision support. Not a diagnosis."} Model ${model.model_id} ${model.version}.`);
  return {
    summary,
    indicator,
    detail: lines.join("\n"),
    source: { ...SOURCE },
    links: [{ label: "Open Undiagnosed No More (SMART app)", url: SMART_APP_URL, type: "smart" }],
  };
}

function conditionName(model) {
  return CONDITIONS[model?.model_id]?.name || model?.target?.label || model?.model_id || "a condition";
}

/**
 * The card for models that could not score the chart: the EHR did not return records they need, or the scorer
 * stopped. Never omitted, so an error is not read as "nothing to flag". Holds no chart data.
 */
export function unscoredCard(entries, { truncated = [] } = {}) {
  if (!entries.length) return null;
  const names = [...new Set(entries.map((e) => conditionName(e.model)))];
  const types = [...new Set(entries.flatMap((e) => e.result?.unavailable || []))].sort();
  const crashed = entries.some((e) => e.error);
  const why = types.length
    ? `${types.join(", ")} records could not be read`
    : "the scorer stopped on this chart";
  const lines = [
    `**Could not score this chart for ${names.join(", ")}.** These conditions have no result, which is not the same as a negative result.`,
    "",
  ];
  if (types.length) {
    const cut = types.filter((t) => truncated.includes(t));
    lines.push(`The EHR did not return the patient's complete ${types.join(", ")} records (a failed, forbidden, or ` +
      `incomplete search${cut.length ? `; ${cut.join(", ")} stopped before its last page` : ""}). The models treat ` +
      "missing records as unknown, not as absent.", "");
  }
  if (crashed) lines.push("The scorer stopped on this chart. The service does not log the error, and this card holds no chart data.", "");
  lines.push("Review the chart directly or open the SMART app.", "");
  lines.push(`Research decision support. Not a diagnosis. Models: ${entries.map((e) => `${e.model.model_id} ${e.model.version}`).join(", ")}.`);
  return {
    summary: clip(`Could not score ${names.join(", ")}: ${why}.`),
    indicator: "info",
    detail: lines.join("\n"),
    source: { ...SOURCE },
    links: [{ label: "Open Undiagnosed No More (SMART app)", url: SMART_APP_URL, type: "smart" }],
  };
}

/**
 * Scores the bundle with every model and returns the cards: High before Elevated, then one card for every
 * model that could not score (unavailable data or a scorer error). `score` has the shared scorer's signature:
 * score(model, bundle, "YYYY-MM-DD", { unavailable }). A scorer error is reported on that card; its message is
 * not logged or returned, so no chart data reaches logs.
 */
export async function buildCards({ models, bundle, asOf, score, unavailable = [], truncated = [] }) {
  const cards = [];
  const unscored = [];
  for (const model of models) {
    let result;
    try {
      result = await score(model, bundle, asOf, { unavailable });
    } catch {
      unscored.push({ model, error: true });
      continue;
    }
    if (result?.status === "could_not_score") {
      unscored.push({ model, result });
      continue;
    }
    const card = cardFor(model, result);
    if (card) cards.push(card);
  }
  const rank = { warning: 0, info: 1 };
  cards.sort((a, b) => rank[a.indicator] - rank[b.indicator]);
  const extra = unscoredCard(unscored, { truncated });
  if (extra) cards.push(extra);
  return cards;
}

/** Full hook handling given parsed JSON; returns [status, body]. options.allowList: FHIR servers for the fallback. */
export async function handleHook(body, { models, score, fetchImpl, now, allowList = [] } = {}) {
  const problem = validateRequest(body);
  if (problem) return [400, { error: problem }];
  const mismatch = checkPrefetchSubject(body.prefetch, body.context.patientId);
  if (mismatch) return [400, { error: mismatch }];
  const completed = await completePrefetch(body, fetchImpl, { allowList });
  if (!completed) {
    return [412, { error: "the Patient resource is missing from prefetch and no allowed fhirServer with access was provided" }];
  }
  const fetchedMismatch = checkPrefetchSubject(completed.prefetch, body.context.patientId);
  if (fetchedMismatch) return [502, { error: `the FHIR server returned data for another patient (${fetchedMismatch})` }];
  const bundle = bundleFromPrefetch(completed.prefetch);
  if (!bundle.entry.some((e) => e.resource.resourceType === "Patient")) {
    return [412, { error: "the Patient resource is missing from prefetch" }];
  }
  const cards = await buildCards({
    models, bundle, asOf: scoringDate(body, now), score, unavailable: completed.unavailable, truncated: completed.truncated,
  });
  return [200, { cards }];
}
