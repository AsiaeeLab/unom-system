// ClinicalTrials.gov API v2 trial finder. Pure helpers plus one fetch wrapper.
// Only the condition and the place the person types are sent. The query terms stay in English (the
// registry is in English); labels shown to the person come from the string tables (i18n.js).

import { EN_T } from "./i18n.js";

export const API = "https://clinicaltrials.gov/api/v2/studies";
const FIELDS = "NCTId,BriefTitle,Phase,LocationFacility,LocationCity,LocationState,LocationCountry";

export const TRIAL_CONDITIONS = [
  { id: "longcovid", label: "Long COVID", query: "Long COVID" },
  { id: "mecfs", label: "ME/CFS (chronic fatigue syndrome)", query: "Chronic Fatigue Syndrome" },
  { id: "fibromyalgia", label: "Fibromyalgia", query: "Fibromyalgia" },
  { id: "endometriosis", label: "Endometriosis", query: "Endometriosis" },
  { id: "lyme", label: "Lyme disease", query: "Lyme Disease" },
];

export const STATES = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado",
  CT: "Connecticut", DE: "Delaware", DC: "District of Columbia", FL: "Florida", GA: "Georgia",
  HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky",
  LA: "Louisiana", ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan", MN: "Minnesota",
  MS: "Mississippi", MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire",
  NJ: "New Jersey", NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota",
  OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania", PR: "Puerto Rico", RI: "Rhode Island",
  SC: "South Carolina", SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont",
  VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
};

// First three ZIP digits -> state (USPS prefix ranges, 50 states, DC, PR).
// Used only to turn a ZIP into a state name for the location search.
const ZIP3 = [
  [6, 9, "PR"], [10, 27, "MA"], [28, 29, "RI"], [30, 38, "NH"], [39, 49, "ME"], [50, 54, "VT"],
  [55, 55, "MA"], [56, 59, "VT"], [60, 69, "CT"], [70, 89, "NJ"], [5, 5, "NY"], [100, 149, "NY"],
  [150, 196, "PA"], [197, 199, "DE"], [200, 200, "DC"], [201, 201, "VA"], [202, 205, "DC"],
  [206, 219, "MD"], [220, 246, "VA"], [247, 268, "WV"], [270, 289, "NC"], [290, 299, "SC"],
  [300, 319, "GA"], [320, 339, "FL"], [341, 349, "FL"], [350, 369, "AL"], [370, 385, "TN"],
  [386, 397, "MS"], [398, 399, "GA"], [400, 427, "KY"], [430, 458, "OH"], [460, 479, "IN"],
  [480, 499, "MI"], [500, 528, "IA"], [530, 549, "WI"], [550, 567, "MN"], [569, 569, "DC"],
  [570, 577, "SD"], [580, 588, "ND"], [590, 599, "MT"], [600, 629, "IL"], [630, 658, "MO"],
  [660, 679, "KS"], [680, 693, "NE"], [700, 714, "LA"], [716, 729, "AR"], [730, 749, "OK"],
  [750, 799, "TX"], [800, 816, "CO"], [820, 831, "WY"], [832, 838, "ID"], [840, 847, "UT"],
  [850, 865, "AZ"], [870, 884, "NM"], [885, 885, "TX"], [889, 898, "NV"], [900, 961, "CA"],
  [967, 968, "HI"], [970, 979, "OR"], [980, 994, "WA"], [995, 999, "AK"],
];

export function zipToState(zip) {
  const m = /^(\d{5})(?:-\d{4})?$/.exec(String(zip || "").trim());
  if (!m) return null;
  const p = Number(m[1].slice(0, 3));
  const row = ZIP3.find(([lo, hi]) => p >= lo && p <= hi);
  return row ? row[2] : null;
}

/**
 * Turn what the person typed into a state code and the text sent as
 * query.locn. Accepts a ZIP code, a two-letter state, or a state name.
 */
export function resolveLocation(input) {
  const raw = String(input || "").trim();
  if (!raw) return { state: null, locn: "" };
  const fromZip = zipToState(raw);
  if (fromZip) return { state: fromZip, locn: STATES[fromZip], zip: raw.slice(0, 5) };
  const up = raw.toUpperCase();
  if (STATES[up]) return { state: up, locn: STATES[up] };
  const byName = Object.entries(STATES).find(([, n]) => n.toLowerCase() === raw.toLowerCase());
  if (byName) return { state: byName[0], locn: byName[1] };
  return { state: null, locn: raw };
}

export function buildTrialsUrl({ condition, location } = {}) {
  const cond = TRIAL_CONDITIONS.find((c) => c.id === condition) || TRIAL_CONDITIONS[0];
  const params = new URLSearchParams();
  params.set("query.cond", cond.query);
  params.set("filter.overallStatus", "RECRUITING");
  params.set("pageSize", "10");
  const loc = resolveLocation(location);
  // Multi-word place names must be quoted, or the API returns no matches.
  if (loc.locn) params.set("query.locn", loc.state ? `"${loc.locn}"` : loc.locn);
  params.set("fields", FIELDS);
  return `${API}?${params.toString()}`;
}

const PHASES = ["EARLY_PHASE1", "PHASE1", "PHASE2", "PHASE3", "PHASE4", "NA"];

/** A condition's label for the search form, in one language. */
export function conditionLabel(id, t = EN_T) {
  return t(`trials.condition.${id}`);
}

export function phaseText(phases, t = EN_T) {
  const list = (phases || []).map((p) => (PHASES.includes(p) ? t(`trials.phase.${p}`) : p));
  return list.length ? list.join(t("trials.phaseJoin")) : t("trials.notListed");
}

function place(l) {
  return [l.facility, [l.city, l.state].filter(Boolean).join(", "), l.country && l.country !== "United States" ? l.country : ""]
    .filter(Boolean)
    .join(", ");
}

/** Reduce the API response to what the screen shows. */
export function parseStudies(json, { state, t = EN_T } = {}) {
  const stateName = state ? STATES[state] : null;
  return ((json && json.studies) || []).map((s) => {
    const ps = s.protocolSection || {};
    const id = (ps.identificationModule || {}).nctId || "";
    const title = (ps.identificationModule || {}).briefTitle || (ps.identificationModule || {}).officialTitle || t("trials.untitled");
    const locs = ((ps.contactsLocationsModule || {}).locations || []).slice();
    if (stateName) locs.sort((a, b) => (b.state === stateName) - (a.state === stateName));
    const nearby = stateName ? locs.filter((l) => l.state === stateName).length : 0;
    return {
      id,
      title,
      phase: phaseText((ps.designModule || {}).phases, t),
      phases: (ps.designModule || {}).phases || [],
      locations: locs.slice(0, 3).map(place),
      moreLocations: Math.max(0, locs.length - 3),
      nearbyCount: nearby,
      url: id ? `https://clinicaltrials.gov/study/${encodeURIComponent(id)}` : "https://clinicaltrials.gov/",
    };
  });
}

/** Fetch and parse. Throws { offline: true } when the network is unavailable. */
export async function searchTrials({ condition, location }, { fetchFn = fetch, timeoutMs = 12000, t = EN_T } = {}) {
  const url = buildTrialsUrl({ condition, location });
  const ctrl = typeof AbortController === "function" ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  let res;
  try {
    res = await fetchFn(url, { signal: ctrl ? ctrl.signal : undefined, headers: { Accept: "application/json" } });
  } catch (e) {
    const err = new Error("network");
    err.offline = true;
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (!res.ok) throw new Error(`ClinicalTrials.gov returned ${res.status}`);
  const json = await res.json();
  const { state } = resolveLocation(location);
  return { url, studies: parseStudies(json, { state, t }), total: json.totalCount };
}
