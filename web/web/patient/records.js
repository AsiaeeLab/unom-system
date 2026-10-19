// Turn a chart-model result into patient-facing text.
// Product rule: the patient never sees the probability, the score, the
// contribution, or "N times average". Only the band decides whether the
// pattern sentence is shown, and only the dated findings are listed.
// Text comes from the string tables (i18n.js); a saved summary keeps the language-independent parts
// (status, reasonKey, demographics, dates, record terms) so localizeSummary can show it in either language.

import { EN_T, recordTerm } from "./i18n.js";

export const MODELS = {
  longcovid: { file: "/models/longcovid.json", condition: "Long COVID" },
  chronicfatigue: {
    file: "/models/chronicfatigue.json",
    condition: "chronic fatigue",
  },
  fibromyalgia: { file: "/models/fibromyalgia.json", condition: "fibromyalgia" },
  endometriosis: { file: "/models/endometriosis.json", condition: "endometriosis" },
  lyme: { file: "/models/lyme.json", condition: "Lyme disease" },
  lupus: { file: "/models/lupus.json", condition: "lupus" },
  migraine: { file: "/models/migraine.json", condition: "migraine" },
  depression: { file: "/models/depression.json", condition: "depression" },
  anxiety: { file: "/models/anxiety.json", condition: "anxiety" },
};

export const DEMO_AS_OF = "2024-06-01";

// Same four demo people, in the same order, as the clinician view's patient picker.
// focus: the condition this person's story is about, shown first when more
// than one pattern check finds a pattern. blurb and story are the English text; personaText gives
// them in another language.
export const PERSONAS = [
  {
    id: "maria",
    name: "Maria",
    blurb: "Had COVID-19 in early 2024 and kept going back for new symptoms.",
    focus: "longcovid",
    story: "Long COVID pattern",
  },
  {
    id: "elena",
    name: "Elena",
    blurb: "Years of visits for tiredness, poor sleep, and dizziness.",
    focus: "chronicfatigue",
    story: "Chronic fatigue pattern",
  },
  {
    id: "sofia",
    name: "Sofia",
    blurb: "Years of visits for neck, back, and jaw pain, headaches, and poor sleep.",
    focus: "fibromyalgia",
    story: "Fibromyalgia pattern",
  },
  {
    id: "dana",
    name: "Dana",
    blurb: "Lives in Dutchess County, New York, with knee pain and facial weakness.",
    focus: "lyme",
    story: "Lyme disease context",
  },
];

/** A demo person's blurb and story in one language. */
export function personaText(p, t = EN_T) {
  if (t.lang === "en") return p;
  return { ...p, blurb: t(`persona.${p.id}.blurb`), story: t(`persona.${p.id}.story`) };
}

const STATUS_ORDER = { pattern: 0, "no-pattern": 1, "not-checked": 2 };

/** Cards with a pattern first, the person's focus condition first among equals. */
export function orderSummaries(summaries = [], focus = "") {
  return [...summaries].sort(
    (a, b) => (STATUS_ORDER[a.status] ?? 3) - (STATUS_ORDER[b.status] ?? 3) || Number(b.modelKey === focus) - Number(a.modelKey === focus),
  );
}

const KIND_TYPES = ["Condition", "Procedure", "Observation", "MedicationRequest", "Encounter", "Immunization"];

const ENCOUNTER_CLASS = { AMB: "Clinic visit", VR: "Video visit", HH: "Home visit", EMER: "Emergency visit", IMP: "Hospital stay" };

/** Rewrite model feature labels into plain words. */
export function plainLabel(label) {
  let s = String(label || "");
  s = s.replace(/^History: (.+)$/u, "Earlier diagnosis: $1");
  s = s.replace(/^New: (.+)$/u, "New $1 after COVID-19");
  s = s.replace(/\(coded by day 90\)/u, "(recorded in the first 3 months after COVID-19)");
  s = s.replace(/coded \(days 31-90\)/u, "recorded 1 to 3 months after COVID-19");
  s = s.replace(/coded in days 31-90/u, "recorded 1 to 3 months after COVID-19");
  s = s.replace(/^COVID-19 still coded at a follow-up visit \(days 31-90\)$/u, "COVID-19 still recorded at a visit 1 to 3 months after COVID-19");
  s = s.replace(/in days 31-90/u, "1 to 3 months after COVID-19");
  s = s.replace(/in days 61-90/u, "2 to 3 months after COVID-19");
  s = s.replace(/in the baseline year/u, "in the year before COVID-19");
  s = s.replace(/\bcoded\b/gu, "recorded");
  s = s.replace(/(\d+)\+/gu, "$1 or more");
  s = s.replace(/^Two or more new symptom types$/u, "Two or more kinds of new symptoms");
  s = s.replace(/symptom types/gu, "kinds of symptoms");
  s = s.replace(/outpatient visits/gu, "clinic visits");
  return s;
}

function index(bundle) {
  const map = new Map();
  for (const e of (bundle && bundle.entry) || []) {
    const r = e.resource;
    if (r && r.resourceType && r.id) map.set(`${r.resourceType}/${r.id}`, r);
  }
  return map;
}

function resourceText(r) {
  if (!r) return "";
  if (r.resourceType === "Encounter") {
    const c = r.class && r.class.code;
    return ENCOUNTER_CLASS[c] || "Visit";
  }
  const concept = r.code || r.medicationCodeableConcept || r.vaccineCode;
  if (!concept) return "";
  return concept.text || ((concept.coding || [])[0] || {}).display || "";
}

// The scorer's reason, matched to a plain sentence (record.reason.<key> in the string tables).
const REASONS = [
  [/^could not score/iu, "unreadable"],
  [/no documented COVID-19 index event on or after/iu, "covidEra"],
  [/no documented COVID-19 index event/iu, "noCovid"],
  [/fewer than 90 days|landmark/iu, "tooSoon"],
  [/outside the model's time window/iu, "tooLate"],
  [/birth date/iu, "birthDate"],
  [/under 18/iu, "under18"],
  [/already recorded|exclusion|already coded/iu, "alreadyRecorded"],
  [/insufficient history|no encounters/iu, "history"],
];

function reasonKey(reason) {
  for (const [re, key] of REASONS) if (re.test(String(reason || ""))) return key;
  return "other";
}

const capitalize = (s) => (s ? `${s.charAt(0).toUpperCase()}${s.slice(1)}` : s);

/**
 * The patient-facing text of a saved summary in one language. Summaries saved before the app had
 * Spanish lack reasonKey and demographics; they keep their English text.
 */
export function localizeSummary(s, t = EN_T) {
  const condition = MODELS[s.modelKey] ? t(`record.condition.${s.modelKey}`) : t("record.condition.other");
  const findings = (s.findings || []).map((f) => ({
    ...f,
    label: t.lang === "en" ? f.label : recordTerm(f.label, t.lang),
    items: (f.items || []).map((it) => ({
      ...it,
      dateText: t.date(it.date),
      kind: t(KIND_TYPES.includes(it.resourceType) ? `record.kind.${it.resourceType}` : "record.kind.other"),
      text: recordTerm(it.text, t.lang),
    })),
  }));
  const out = { ...s, condition, findings, title: t("record.patternCheck", { condition: capitalize(condition) }) };
  if (s.status === "pattern") {
    const demo = s.demographics || String(s.also || "").match(/\b(?:sex|age)\b/gu) || [];
    return {
      ...out,
      headline: t("record.pattern.headline", { condition }),
      message: t("record.pattern.message"),
      discuss: t("record.pattern.discuss"),
      also: demo.length ? t("record.also", { list: t.list(demo.map((d) => t(`record.demographic.${d}`))) }) : "",
    };
  }
  const headline = t("record.headline", { condition });
  if (s.status === "no-pattern") return { ...out, headline, message: t("record.noPattern.message", { condition }), discuss: "", also: "" };
  if (s.reasonKey) return { ...out, headline, message: t(`record.reason.${s.reasonKey}`), discuss: "", also: "" };
  return t.lang === "en" ? { ...s, title: out.title } : { ...out, headline, message: s.message };
}

/**
 * Patient-facing summary of one chart-model result.
 * Returns only text, dates, and resource ids. Numeric model outputs
 * (probability, score, times_average, contribution) are never copied.
 */
export function summarizeRecord(modelKey, result, bundle, t = EN_T) {
  const base = { modelKey, findings: [] };
  let core;
  if (!result || result.status !== "scored") {
    core = { ...base, status: "not-checked", reasonKey: reasonKey(result && result.reason) };
  } else if (result.band !== "High" && result.band !== "Elevated") {
    core = { ...base, status: "no-pattern" };
  } else {
    const res = index(bundle);
    const findings = [];
    const usesDemographics = [];
    for (const d of result.drivers || []) {
      if (typeof d.contribution === "number" && d.contribution <= 0) continue;
      const evidence = d.evidence || [];
      if (!evidence.length) {
        if (d.group === "Demographics" || /^(Age |Female|Male)/u.test(d.label || "")) {
          usesDemographics.push(/^Age/u.test(d.label) ? "age" : "sex");
        }
        continue;
      }
      const items = evidence
        .map((e) => {
          const r = res.get(`${e.resourceType}/${e.id}`);
          return {
            resourceType: e.resourceType,
            id: e.id,
            date: e.date || "",
            dateText: "",
            kind: "",
            text: resourceText(r),
          };
        })
        .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
      findings.push({ key: `${modelKey}:${d.id || d.label}`, label: plainLabel(d.label), items });
    }
    core = {
      ...base,
      status: "pattern",
      band: result.band, // band name only, used by the triage rule; never shown
      demographics: [...new Set(usesDemographics)],
      findings,
    };
  }
  const { title, ...summary } = localizeSummary(core, EN_T);
  return t.lang === "en" ? summary : localizeSummary(summary, t);
}

// Lyme disease context from the record's address, using the site's county
// table (/data/lyme_county.json, built from CDC county surveillance,
// 2015-2019 average, per 100,000 people). Shown only for "high" counties.
const STATE_NAMES = { NY: "New York" };

export function lymeNote(bundle, table, t = EN_T) {
  const patient = ((bundle && bundle.entry) || []).map((e) => e.resource).find((r) => r && r.resourceType === "Patient");
  const addr = ((patient && patient.address) || [])[0];
  if (!addr || !addr.state || !table || !table.states) return null;
  const st = table.states[String(addr.state).toUpperCase()];
  if (!st || !st.counties) return null;
  const want = String(addr.district || "").toLowerCase();
  const hit = Object.entries(st.counties).find(([name]) => name.toLowerCase() === want);
  if (!hit) return null;
  const [county, [per100k, band]] = hit;
  if (band !== "high") return null;
  const stateName = st.name || STATE_NAMES[addr.state] || addr.state;
  return localizeLyme({ county, stateName, cases: Math.round(per100k) }, t);
}

// Spanish names for the county and state in the Lyme note ("Dutchess County" -> "el condado de Dutchess").
const STATES_ES = {
  "New York": "Nueva York", "New Jersey": "Nueva Jersey", "New Mexico": "Nuevo México", "New Hampshire": "Nuevo Hampshire",
  Pennsylvania: "Pensilvania", "North Carolina": "Carolina del Norte", "South Carolina": "Carolina del Sur",
  "North Dakota": "Dakota del Norte", "South Dakota": "Dakota del Sur", "West Virginia": "Virginia Occidental",
  "District of Columbia": "Distrito de Columbia", Louisiana: "Luisiana", Hawaii: "Hawái", Michigan: "Míchigan", Oregon: "Oregón",
};

/** The Lyme note's text in one language, from its saved county, state, and rounded case rate. */
export function localizeLyme(note, t = EN_T) {
  if (!note || !note.county) return note;
  const place =
    t.lang === "es"
      ? `${/ County$/u.test(note.county) ? `el condado de ${note.county.replace(/ County$/u, "")}` : note.county}, ${STATES_ES[note.stateName] || note.stateName}`
      : `${note.county}, ${note.stateName}`;
  return {
    county: note.county,
    stateName: note.stateName,
    cases: note.cases,
    headline: t("lyme.headline"),
    body: t("lyme.body", { place, cases: note.cases }),
    source: t("lyme.source"),
  };
}
