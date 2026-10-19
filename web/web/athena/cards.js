// Per-patient condition dashboard (Long COVID, ME/CFS, fibromyalgia, Lyme disease, lupus) for the clinician app.
// Shared by the SMART on FHIR app (athena/app.js) and the no-login demo (clinician/demo.js).
// Scores the launched or demo record with the shared scorer and the published model files; Lyme and lupus use
// transparent chart rules. Research decision support only: every view says so, and every finding links to its
// dated chart source. Pure functions come first (node:test imports them); DOM code is at the bottom.

import { calibrate, parseFhirDate, resourceDate, scoreBundle } from "../shared/scorer.js";
import { evaluateLupusSignal } from "./rule.js";
import { evaluateLymeFeatures } from "./lyme-rule.js";
import { INSTRUMENT_URLS, QUESTIONNAIRE_URL, RECOVER, SUPPORTED_QUESTIONNAIRE_VERSIONS } from "../patient/instruments.js";

const SHARED_LIMITS = [
  "Decision support for clinician review of a single chart.",
  "Evaluated retrospectively on records from one research program (All of Us); not evaluated prospectively or in clinical use. The bands are descriptive score categories, not validated action thresholds.",
  "The model is linear: the score is a sum of weights for named features (dated chart findings, counts of visits or symptom types, and age and sex). Findings outside the listed codes are invisible to it.",
];

// CDC wording, checked against cdc.gov/lyme/hcp on October 4, 2026. Keep as is.
export const LYME_NEXT_STEPS = Object.freeze([
  "Ask about tick exposure and an expanding rash (erythema migrans). A patient with likely erythema migrans and possible tick exposure in an endemic area should be treated promptly, whether or not serologic testing is ordered; tests may be falsely negative in the first few weeks of infection.",
  "Without erythema migrans, if exposure and symptoms are consistent with Lyme disease, use CDC's two-step serologic testing: an enzyme immunoassay followed by a western blot, or two enzyme immunoassays (modified two-tier).",
]);
export const LYME_SOURCE = "CDC, Clinical Testing and Diagnosis for Lyme Disease, and Clinical Treatment of Erythema Migrans Rash (cdc.gov/lyme/hcp).";
export const LYME_TESTING_URL = "https://www.cdc.gov/lyme/hcp/diagnosis-testing/index.html";
export const LYME_TREATMENT_URL = "https://www.cdc.gov/lyme/hcp/clinical-care/erythema-migrans-rash.html";
export const LYME_SURVEILLANCE_URL = "https://www.cdc.gov/lyme/data-research/facts-stats/index.html";
export const LUPUS_CRITERIA_URL = "https://doi.org/10.1002/art.40930";

export const MODEL_CARDS = Object.freeze([
  {
    key: "longcovid",
    slug: "longcovid",
    tab: "Long COVID",
    url: "/models/longcovid.json",
    title: "Long COVID",
    target: "Chance of a first Long COVID code (U09.9) 91 to 455 days after COVID-19, compared with the average post-COVID patient at day 90",
    estimate: "The model's estimate that this patient gets a first Long COVID code (U09.9) 91 to 455 days after COVID-19, from the chart findings up to day 90. About {n} in 100 patients with this estimate would get the code. Codes miss most cases, so it is not the chance of having Long COVID.",
    nextSteps: [
      "Review symptoms against the NASEM 2024 Long COVID definition (symptoms lasting 3 months or longer after infection).",
      "Ask the patient to complete the RECOVER symptom questions and the DePaul post-exertional malaise screen.",
      "Consider referral to a post-COVID clinic or a relevant specialist.",
    ],
    checklist: ["Symptoms lasting 3 months or longer after infection"],
    checklistSource: "National Academies of Sciences, Engineering, and Medicine. A Long COVID Definition. 2024.",
    checklistSourceUrl: "https://doi.org/10.17226/27768",
    guide: "/developers/models#long-covid",
    limits: [
      ...SHARED_LIMITS,
      "The label is a future Long COVID code, and codes miss most cases, so a Typical band does not mean the patient is well. The score tracked later documentation and use of care in general, not Long COVID symptoms specifically.",
    ],
  },
  {
    key: "chronicfatigue",
    slug: "mecfs",
    tab: "ME/CFS",
    url: "/models/chronicfatigue.json",
    title: "Chronic fatigue (ME/CFS)",
    target: "Chart pattern similar to patients who report a chronic fatigue or ME/CFS diagnosis that was never coded",
    estimate: "The model's estimate that a patient with this chart reports having been told they have chronic fatigue (All of Us survey) while the chart has no chronic fatigue or ME/CFS code. About {n} in 100 patients with this estimate would. It is not the chance of having ME/CFS.",
    nextSteps: [
      "Ask the patient to complete the DePaul post-exertional malaise screen before any advice on exercise.",
      "Review the IOM 2015 ME/CFS criteria with the patient.",
    ],
    checklist: [
      "Substantial reduction in pre-illness activity lasting more than 6 months, with fatigue",
      "Post-exertional malaise",
      "Unrefreshing sleep",
      "Cognitive impairment or orthostatic intolerance (at least one)",
    ],
    checklistSource: "Institute of Medicine. Beyond Myalgic Encephalomyelitis/Chronic Fatigue Syndrome. 2015.",
    checklistSourceUrl: "https://doi.org/10.17226/19012",
    guide: "/developers/models#chronic-fatigue",
    limits: [
      ...SHARED_LIMITS,
      "The label is a self-reported chronic fatigue diagnosis among adults with no chronic fatigue or ME/CFS code. It does not establish ME/CFS, and it inherits the limits of self-report.",
    ],
  },
  {
    key: "fibromyalgia",
    slug: "fibromyalgia",
    tab: "Fibromyalgia",
    url: "/models/fibromyalgia.json",
    title: "Fibromyalgia",
    target: "Chart pattern similar to patients who report a fibromyalgia diagnosis that was never coded",
    estimate: "The model's estimate that a patient with this chart reports having been told they have fibromyalgia (All of Us survey) while the chart has no fibromyalgia code. About {n} in 100 patients with this estimate would. It is not the chance of having fibromyalgia.",
    nextSteps: [
      "Assess the patient with the 2016 revised fibromyalgia diagnostic criteria (Widespread Pain Index and Symptom Severity Scale).",
    ],
    checklist: [
      "Widespread Pain Index of 7 or more and Symptom Severity Scale score of 5 or more, or WPI 4 to 6 and SSS 9 or more",
      "Pain in at least 4 of 5 body regions (jaw, chest, and abdominal pain do not count)",
      "Symptoms at a similar level for at least 3 months",
      "Other diagnoses do not exclude fibromyalgia, and fibromyalgia does not exclude other illnesses",
    ],
    checklistSource: "Wolfe F, et al. 2016 revisions to the 2010/2011 fibromyalgia diagnostic criteria. Semin Arthritis Rheum. 2016;46(3):319-329.",
    checklistSourceUrl: "https://doi.org/10.1016/j.semarthrit.2016.08.012",
    guide: "/developers/models#fibromyalgia",
    limits: [
      ...SHARED_LIMITS,
      "The label is a self-reported fibromyalgia diagnosis among adults with no fibromyalgia code, so it inherits the limits of self-report.",
    ],
  },
  {
    key: "endometriosis",
    slug: "endometriosis",
    tab: "Endometriosis",
    url: "/models/endometriosis.json",
    title: "Endometriosis",
    target: "Chart pattern similar to women who report an endometriosis diagnosis that was never coded",
    estimate: "The model's estimate that a woman with this chart reports having been told she has endometriosis (All of Us survey) while the chart has no endometriosis code. About {n} in 100 women with this estimate would. It is not the chance of having endometriosis now.",
    nextSteps: [
      "Ask about painful periods, deep pain during sex, and pain with urination or bowel movements, and whether symptoms follow the menstrual cycle (ESHRE 2022 endometriosis guideline).",
      "Consider pelvic imaging (transvaginal ultrasound or MRI) and gynecology referral; a normal examination or image does not rule endometriosis out.",
    ],
    checklist: [
      "Painful periods, deep pain during sex, or pain with urination or bowel movements",
      "Cyclical symptoms: painful rectal bleeding or blood in the urine, shoulder-tip or chest pain, or a swollen, painful scar",
      "Fatigue and infertility",
      "A normal clinical examination does not rule it out; imaging is the next step",
    ],
    checklistSource: "Becker CM, et al. ESHRE guideline: endometriosis. Hum Reprod Open. 2022;2022(2):hoac009.",
    checklistSourceUrl: "https://doi.org/10.1093/hropen/hoac009",
    guide: "/developers/models#endometriosis",
    limits: [
      ...SHARED_LIMITS,
      "The label is a self-reported endometriosis diagnosis among women with no endometriosis code. Many reports describe past disease, and discrimination is limited (AUROC 0.61), so this card is the weakest of the set.",
    ],
  },
  {
    key: "lyme",
    slug: "lyme",
    tab: "Lyme",
    url: "/models/lyme.json",
    title: "Lyme disease",
    target: "Chart pattern similar to patients who report a Lyme disease diagnosis that was never coded",
    estimate: "The model's estimate that a patient with this chart reports having been told they have Lyme disease (All of Us survey) while the chart has no Lyme disease code. About {n} in 100 patients with this estimate would. It is not the chance of a current infection.",
    nextSteps: LYME_NEXT_STEPS,
    // The panel's criteria column shows the chart findings consistent with Lyme disease and the county's
    // reported incidence instead of a checklist (renderCriteria).
    checklist: null,
    guide: "/developers/models#lyme",
    limits: [
      ...SHARED_LIMITS,
      "The label is a self-reported Lyme disease diagnosis among adults with no Lyme disease code. Most such reports describe a past, treated infection, so a high score means the chart resembles theirs, not that an infection is active.",
    ],
  },
  {
    key: "lupus",
    slug: "lupus",
    tab: "Lupus",
    url: "/models/lupus.json",
    title: "Lupus",
    target: "Chart pattern similar to patients who report a lupus diagnosis that was never coded",
    estimate: "The model's estimate that a patient with this chart reports having been told they have lupus (All of Us survey) while the chart has no systemic lupus erythematosus code. About {n} in 100 patients with this estimate would. It is not the chance of having lupus.",
    nextSteps: [
      "Check for a positive antinuclear antibody test (1:80 or higher), the entry criterion of the 2019 EULAR/ACR criteria.",
      "If it is present, review the clinical and immunologic domains of the 2019 EULAR/ACR criteria, with rheumatology when they fit.",
    ],
    // The panel's criteria column shows the 2019 EULAR/ACR criteria with chart evidence (renderCriteria).
    checklist: null,
    guide: "/developers/models#lupus",
    limits: [
      ...SHARED_LIMITS,
      "The label is a self-reported lupus diagnosis among adults with no systemic lupus erythematosus code; self-report includes cutaneous lupus and some reports that a rheumatologist would not confirm.",
    ],
  },
  {
    key: "migraine",
    slug: "migraine",
    tab: "Migraine",
    url: "/models/migraine.json",
    title: "Migraine",
    target: "Chart pattern similar to patients who report a migraine diagnosis that was never coded",
    estimate: "The model's estimate that a patient with this chart reports having been told they have migraine (All of Us survey) while the chart has no migraine code. About {n} in 100 patients with this estimate would. It is not the chance of having migraine.",
    nextSteps: [
      "Review the patient's headaches against the ICHD-3 criteria for migraine: how often, how long, the pain's features, and nausea or sensitivity to light and sound.",
      "If they fit, discuss acute and preventive treatment and how many headache days a month the patient has.",
    ],
    checklist: [
      "At least five attacks lasting 4 to 72 hours (untreated or unsuccessfully treated)",
      "At least two of: one-sided, pulsating, moderate or severe, worsened by or causing avoidance of routine activity",
      "During the headache, nausea or vomiting, or sensitivity to both light and sound",
      "Not better explained by another headache diagnosis",
    ],
    checklistSource: "Headache Classification Committee of the International Headache Society. The International Classification of Headache Disorders, 3rd edition. Cephalalgia. 2018;38(1):1-211.",
    checklistSourceUrl: "https://doi.org/10.1177/0333102417738202",
    guide: "/developers/models#migraine",
    limits: [
      ...SHARED_LIMITS,
      "The label is a self-reported migraine diagnosis among adults with no migraine code, so it inherits the limits of self-report.",
    ],
  },
  {
    key: "depression",
    slug: "depression",
    tab: "Depression",
    url: "/models/depression.json",
    title: "Depression",
    target: "Chart pattern similar to patients who report a depression diagnosis that was never coded",
    estimate: "The model's estimate that a patient with this chart reports having been told they have depression (All of Us survey) while the chart has no depression code. About {n} in 100 patients with this estimate would. It is not the chance of having depression now.",
    nextSteps: [
      "Screen with the PHQ-9 (the patient app has it), as the USPSTF 2023 recommendation advises for adults.",
      "If the PHQ-9 is 10 or more, assess for major depression against the DSM-5-TR criteria; ask about thoughts of self-harm and, if present, follow your clinic's safety protocol and share the 988 Suicide and Crisis Lifeline.",
    ],
    checklist: [
      "Five or more of the nine symptoms of a major depressive episode, nearly every day for at least 2 weeks",
      "One of them is depressed mood or loss of interest or pleasure",
      "Clinically significant distress or impairment",
      "Not explained by a substance or another medical condition",
    ],
    checklistSource: "American Psychiatric Association. Diagnostic and Statistical Manual of Mental Disorders, 5th edition, text revision (DSM-5-TR). 2022.",
    checklistSourceUrl: "https://doi.org/10.1176/appi.books.9780890425787",
    guide: "/developers/models#depression",
    limits: [
      ...SHARED_LIMITS,
      "The label is a self-reported depression diagnosis among adults with no depression code; many reports describe past episodes.",
    ],
  },
  {
    key: "anxiety",
    slug: "anxiety",
    tab: "Anxiety",
    url: "/models/anxiety.json",
    title: "Anxiety",
    target: "Chart pattern similar to patients who report an anxiety diagnosis that was never coded",
    estimate: "The model's estimate that a patient with this chart reports having been told they have anxiety (All of Us survey) while the chart has no anxiety code. About {n} in 100 patients with this estimate would. It is not the chance of having an anxiety disorder now.",
    nextSteps: [
      "Screen with the GAD-7 (the patient app has it); the USPSTF 2023 recommendation advises anxiety screening for adults under 65.",
      "If the GAD-7 is 10 or more, assess for an anxiety disorder against the DSM-5-TR criteria.",
    ],
    checklist: [
      "Excessive anxiety and worry on more days than not for at least 6 months, hard to control (generalized anxiety disorder)",
      "Three or more of: restlessness, tiring easily, trouble concentrating, irritability, muscle tension, poor sleep",
      "Clinically significant distress or impairment",
      "Not explained by a substance, another medical condition, or another mental disorder",
    ],
    checklistSource: "American Psychiatric Association. Diagnostic and Statistical Manual of Mental Disorders, 5th edition, text revision (DSM-5-TR). 2022.",
    checklistSourceUrl: "https://doi.org/10.1176/appi.books.9780890425787",
    guide: "/developers/models#anxiety",
    limits: [
      ...SHARED_LIMITS,
      "The label is a self-reported anxiety diagnosis among adults with no anxiety code; many reports describe past episodes.",
    ],
  },
]);

export const TABS = Object.freeze([
  { slug: "longcovid", label: "Long COVID" },
  { slug: "mecfs", label: "ME/CFS" },
  { slug: "fibromyalgia", label: "Fibromyalgia" },
  { slug: "endometriosis", label: "Endometriosis" },
  { slug: "lyme", label: "Lyme" },
  { slug: "lupus", label: "Lupus" },
  { slug: "migraine", label: "Migraine" },
  { slug: "depression", label: "Depression" },
  { slug: "anxiety", label: "Anxiety" },
  { slug: "timeline", label: "Timeline" },
]);



export const CLINICAL_REFERENCES = Object.freeze([
  ["NASEM 2024 Long COVID definition", "https://doi.org/10.17226/27768"],
  ["NASEM 2024 time criterion", "https://doi.org/10.17226/27768"],
  ["RECOVER symptom questions", INSTRUMENT_URLS.recoverQuestions],
  ["RECOVER 2024 index", INSTRUMENT_URLS.recoverIndex],
  ["DePaul post-exertional malaise screen", INSTRUMENT_URLS.pem],
  ["DePaul PEM screen", INSTRUMENT_URLS.pem],
  ["IOM 2015 ME/CFS criteria", "https://doi.org/10.17226/19012"],
  ["IOM 2015 core symptoms", "https://doi.org/10.17226/19012"],
  ["2016 revised fibromyalgia diagnostic criteria", "https://doi.org/10.1016/j.semarthrit.2016.08.012"],
  ["2016 criteria", "https://doi.org/10.1016/j.semarthrit.2016.08.012"],
  ["Post-COVID-19 Functional Status", INSTRUMENT_URLS.pcfs],
  ["CDC's two-step serologic testing", LYME_TESTING_URL],
  ["CDC testing guidance", LYME_TESTING_URL],
  ["CDC, 2015 to 2019", LYME_SURVEILLANCE_URL],
  ["2019 EULAR/ACR criteria", LUPUS_CRITERIA_URL],
  ["ESHRE 2022 endometriosis guideline", "https://doi.org/10.1093/hropen/hoac009"],
  ["ICHD-3 criteria", "https://doi.org/10.1177/0333102417738202"],
  ["USPSTF 2023 recommendation advises for adults", "https://doi.org/10.1001/jama.2023.9297"],
  ["USPSTF 2023 recommendation advises anxiety screening", "https://doi.org/10.1001/jama.2023.9301"],
  ["DSM-5-TR criteria", "https://doi.org/10.1176/appi.books.9780890425787"],
  ["988 Suicide and Crisis Lifeline", "https://988lifeline.org/"],
]);

/** Split visible prose into text and authoritative-reference links. */
export function referenceParts(text) {
  const parts = [];
  let rest = String(text || "");
  while (rest) {
    let match = null;
    for (const [label, href] of CLINICAL_REFERENCES) {
      const index = rest.indexOf(label);
      if (index >= 0 && (!match || index < match.index || (index === match.index && label.length > match.label.length))) {
        match = { index, label, href };
      }
    }
    if (!match) {
      parts.push(rest);
      break;
    }
    if (match.index) parts.push(rest.slice(0, match.index));
    parts.push({ label: match.label, href: match.href });
    rest = rest.slice(match.index + match.label.length);
  }
  return parts;
}

// ---------------------------------------------------------------- loading

export function recordToBundle(record) {
  const entry = [];
  for (const [type, list] of Object.entries(record?.resources || {})) {
    if (type === "Binary") continue;
    for (const resource of list || []) entry.push({ resource });
  }
  return { resourceType: "Bundle", type: "collection", entry };
}

/** The record shape the lupus rule reads, from a FHIR bundle (every core resource type marked available). */
export function bundleToRecord(bundle) {
  const resources = {};
  for (const { resource } of bundle?.entry || []) if (resource?.resourceType) (resources[resource.resourceType] ||= []).push(resource);
  const types = ["Patient", "Condition", "Observation", "DiagnosticReport", "DocumentReference", "QuestionnaireResponse", "Encounter", "Procedure", "MedicationRequest"];
  const access = types.map((resourceType) => ({ resourceType, status: "Available", count: (resources[resourceType] || []).length }));
  return { patient: (resources.Patient || [])[0] || null, resources, access, notes: [] };
}

export async function loadModels(fetcher = fetch) {
  const out = {};
  for (const card of MODEL_CARDS) {
    const response = await fetcher(card.url, { credentials: "same-origin" });
    if (!response.ok) throw new Error(`The ${card.title} model could not be loaded.`);
    out[card.key] = await response.json();
  }
  return out;
}

export async function loadLyme(fetcher = fetch) {
  const response = await fetcher("/data/lyme_county.json", { credentials: "same-origin" });
  return response.ok ? response.json() : null;
}

// ---------------------------------------------------------------- dates and text

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "2024-06-01" -> "June 1, 2024" (short: "Jun 1, 2024"). Anything else -> "". */
export function formatDay(iso, { short = false } = {}) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/u.exec(String(iso || ""));
  if (!m || !MONTHS[Number(m[2]) - 1]) return "";
  const month = MONTHS[Number(m[2]) - 1];
  return `${short ? month.slice(0, 3) : month} ${Number(m[3])}, ${m[1]}`;
}

function addDays(iso, n) {
  const t = new Date(`${iso}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}

/** Whole years on `asOf`; a partial birth date (YYYY or YYYY-MM) is read as the scorer reads it (July 1, the 15th). */
function ageOn(birthDate, asOf) {
  const b = /^(\d{4})-(\d{2})-(\d{2})/u.exec(String(parseFhirDate(birthDate, { birth: true }) || ""));
  const a = /^(\d{4})-(\d{2})-(\d{2})/u.exec(String(asOf || ""));
  if (!b || !a) return null;
  let years = Number(a[1]) - Number(b[1]);
  if (Number(a[2]) < Number(b[2]) || (a[2] === b[2] && Number(a[3]) < Number(b[3]))) years -= 1;
  return years;
}

const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const lowerFirst = (s) => (s ? s[0].toLowerCase() + s.slice(1) : s);
const times = (x) => `${x.toFixed(1)}×`;

// ---------------------------------------------------------------- patient questionnaire

/** "https://undiagnosednomore.org/fhir/Questionnaire/x|1.2.0" -> { url, version } (version null when absent). */
export function questionnaireIdentity(qr) {
  const [url, version = null] = String(qr?.questionnaire || "").split("|");
  return { url, version };
}

/** "Patient/123", ".../Patient/123", or ".../Patient/123/_history/2" -> "123"; anything else -> null. */
export function patientIdOf(reference) {
  const m = /(?:^|\/)Patient\/([A-Za-z0-9\-.]{1,64})(?:\/_history\/[^/]+)?$/u.exec(String(reference || ""));
  return m ? m[1] : null;
}

/**
 * Can this QuestionnaireResponse be attached to the chart of `patientId`? It must answer our canonical
 * Questionnaire in a supported version, must not be entered-in-error, and, when it has a subject, the subject
 * must name this patient. Returns { ok, reason, anonymous, version }; anonymous (no subject) responses need
 * the clinician to confirm the patient before they are attached (the patient app sends none).
 */
export function checkQuestionnaire(qr, { patientId = null } = {}) {
  if (!qr || typeof qr !== "object" || qr.resourceType !== "QuestionnaireResponse") {
    return { ok: false, reason: "That file is not a QuestionnaireResponse.", anonymous: false, version: null };
  }
  const { url, version } = questionnaireIdentity(qr);
  const no = (reason) => ({ ok: false, reason, anonymous: false, version });
  if (url !== QUESTIONNAIRE_URL) return no("It does not answer the Undiagnosed No More patient questionnaire.");
  if (!SUPPORTED_QUESTIONNAIRE_VERSIONS.includes(version)) {
    return no(`Questionnaire version ${version || "(none)"} is not supported (supported: ${SUPPORTED_QUESTIONNAIRE_VERSIONS.join(", ")}).`);
  }
  if (qr.status === "entered-in-error") return no("The response is marked entered-in-error.");
  const ref = qr.subject?.reference;
  if (ref !== undefined && ref !== null && ref !== "") {
    const id = patientIdOf(ref);
    if (id === null) return no("The response's subject is not a patient.");
    if (patientId !== null && id !== patientId) return no("The response is for a different patient.");
    return { ok: true, reason: null, anonymous: false, version };
  }
  return { ok: true, reason: null, anonymous: true, version };
}

const authoredTime = (qr) => {
  const t = Date.parse(qr?.authored || qr?.meta?.lastUpdated || "");
  return Number.isNaN(t) ? -Infinity : t;
};

function walkItems(items, out = new Map()) {
  for (const it of items || []) {
    if (it.answer?.length) out.set(it.linkId, { text: it.text, answer: it.answer[0] });
    walkItems(it.item, out);
  }
  return out;
}

function answerText(a) {
  if (!a) return "";
  if ("valueCoding" in a) return a.valueCoding.display || a.valueCoding.code;
  if ("valueBoolean" in a) return a.valueBoolean ? "Yes" : "No";
  if ("valueInteger" in a) return String(a.valueInteger);
  if ("valueDate" in a) return a.valueDate;
  return String(a.valueString ?? "");
}

/**
 * Pull the calculated results and the patient's own questions out of our QuestionnaireResponse.
 * The RECOVER range is shown only when every RECOVER symptom was answered: files from versions 1.0.0 and 1.1.0
 * gave a range after partial answers, so it is recomputed from the answered items here.
 */
export function summarizeQuestionnaire(qr) {
  if (!qr || qr.resourceType !== "QuestionnaireResponse") return null;
  const items = walkItems(qr.item);
  const get = (id) => (items.has(id) ? answerText(items.get(id).answer) : null);
  const code = (id) => (items.has(id) ? items.get(id).answer?.valueCoding?.code ?? null : null);
  const recoverAnswered = RECOVER.items.filter((i) => typeof items.get(`recover.${i.id}`)?.answer?.valueBoolean === "boolean").length;
  const recoverComplete = recoverAnswered === RECOVER.items.length;
  const recoverRange = !items.has("recover.category")
    ? null
    : recoverComplete && code("recover.category") !== "incomplete"
      ? get("recover.category")
      : `incomplete: ${recoverAnswered} of ${RECOVER.items.length} symptoms answered, so no range`;
  return {
    authored: String(qr.authored || "").slice(0, 10),
    status: qr.status,
    respondent: qr.source?.display || "Patient",
    onset: get("timeline.onset"),
    covid: get("timeline.covid"),
    covidCode: code("timeline.covid"),
    covidDate: get("timeline.covid-date"),
    symptoms: get("timeline.symptoms"),
    recoverPoints: get("recover.score"),
    recoverRange,
    recoverComplete,
    pemScreen: get("pem.screen"),
    pemDuration: get("pem.duration"),
    pcfs: get("pcfs.grade"),
    pcfsGrade: code("pcfs.grade"),
    questions: [...items.entries()].filter(([id]) => id.startsWith("questions.")).map(([, v]) => answerText(v.answer)),
    // Part E self-checks: the calculated result's display text, or null when the check was not chosen.
    checkLongCovid: get("checks.longcovid.result"),
    checkMecfs: get("checks.mecfs.result"),
    checkFibro: get("checks.fibro.result"),
    recoverCategory: code("recover.category"),
    checkMecfsCode: code("checks.mecfs.result"),
    checkFibroCode: code("checks.fibro.result"),
    fibroWpi: get("checks.fibro.wpi"),
    fibroSss: get("checks.fibro.sss"),
    lymeTick: get("checks.lyme.tick"),
    lymeOutdoors: get("checks.lyme.outdoors"),
    lymeRash: get("checks.lyme.rash"),
    // PHQ-9 and GAD-7 (version 1.3.0): the total and band are exported only when every item was answered. Item 9
    // (thoughts of being better off dead or of self-harm) counts whenever it was answered with anything but 0.
    phq9Answered: [...items.keys()].filter((id) => /^checks\.phq9\.[1-9]$/u.test(id)).length,
    phq9Total: get("checks.phq9.total"),
    phq9Band: get("checks.phq9.band"),
    phq9BandCode: code("checks.phq9.band"),
    phq9Item9: get("checks.phq9.9"),
    phq9SelfHarm: code("checks.phq9.9") !== null && code("checks.phq9.9") !== "0",
    phq9Difficulty: get("checks.phq9.difficulty"),
    gad7Answered: [...items.keys()].filter((id) => /^checks\.gad7\.[1-7]$/u.test(id)).length,
    gad7Total: get("checks.gad7.total"),
    gad7Band: get("checks.gad7.band"),
    gad7BandCode: code("checks.gad7.band"),
  };
}

/** PHQ-9 or GAD-7 as one line: "11 of 27 (10 to 14: moderate depression)", or how far the patient got. */
function scaleLine(total, band, answered, items, max) {
  if (total !== null) return `${total} of ${max} (${band})`;
  return `not finished: ${answered} of ${items} items answered, so no total`;
}

/** The PHQ-9 for a clinician: total and band, item 9, and the difficulty answer; null when not answered. */
function phq9Line(q) {
  if (!q || !(q.phq9Answered || q.phq9Difficulty)) return null;
  const parts = [scaleLine(q.phq9Total, q.phq9Band, q.phq9Answered, 9, 27)];
  if (q.phq9Item9) parts.push(`question 9 (thoughts of being better off dead or of self-harm): ${q.phq9Item9}`);
  if (q.phq9Difficulty) parts.push(`difficulty at work, at home, or with other people: ${q.phq9Difficulty}`);
  return cap(parts.join("; "));
}

function gad7Line(q) {
  return q && q.gad7Answered ? cap(scaleLine(q.gad7Total, q.gad7Band, q.gad7Answered, 7, 21)) : null;
}

/** Shown at the top of From the patient when PHQ-9 question 9 was answered with anything but "Not at all". */
export function selfHarmNotice(q) {
  if (!q || !q.phq9SelfHarm) return null;
  return `PHQ-9 question 9: the patient answered "${q.phq9Item9}" to thoughts that they would be better off dead or of hurting themselves in some way.`;
}

/** The patient's Lyme exposure answers as one line, or null. */
export function lymeExposureLine(q) {
  if (!q || !(q.lymeTick || q.lymeOutdoors || q.lymeRash)) return null;
  const parts = [];
  if (q.lymeTick) parts.push(`tick attached in the 3 months before symptoms: ${q.lymeTick}`);
  if (q.lymeOutdoors) parts.push(`time outdoors where Lyme disease is common: ${q.lymeOutdoors}`);
  if (q.lymeRash) parts.push(`expanding red rash of 2 inches (5 cm) or more: ${q.lymeRash}`);
  return parts.join("; ");
}

/**
 * Our most recently authored QuestionnaireResponse that the EHR returned with the record and that passes
 * checkQuestionnaire for this patient, or null. Responses of other questionnaires, unsupported versions, or
 * other patients are skipped.
 */
export function questionnaireFromRecord(record) {
  const patientId = record?.patient?.id || null;
  const list = (record?.resources?.QuestionnaireResponse || []).filter((qr) => checkQuestionnaire(qr, { patientId }).ok);
  return list.reduce((best, qr) => (best === null || authoredTime(qr) >= authoredTime(best) ? qr : best), null);
}

/** RECOVER is a Long COVID index: show it only when the person has had, or may have had, COVID-19. */
export function showsRecover(q) {
  if (!q || q.recoverPoints === null) return false;
  return q.covidCode ? q.covidCode !== "no" : q.covid !== "No";
}

/** Lines for the "From the patient" panel, in display order: [label, value]. */
export function patientPanelRows(q) {
  if (!q) return [];
  const rows = [];
  if (showsRecover(q)) {
    rows.push(["RECOVER 2024 index", `${q.recoverPoints} points${q.recoverComplete ? "" : " so far"} (${q.recoverRange}).`]);
  }
  if (q.pemScreen) {
    const met = q.pemScreen === "Yes" ? "Meets the screening rule" : "Does not meet the screening rule";
    rows.push(["DePaul PEM screen", q.pemDuration ? `${met}. Recovery after exertion: ${q.pemDuration}.` : `${met}.`]);
  }
  if (q.pcfs) rows.push(["Post-COVID-19 Functional Status", q.pcfsGrade !== null ? `Grade ${q.pcfsGrade} of 4: ${q.pcfs}` : q.pcfs]);
  if (q.checkLongCovid) rows.push(["Long COVID self-check (NASEM 2024 time criterion)", q.checkLongCovid]);
  if (q.checkMecfs) rows.push(["ME/CFS self-check (IOM 2015 core symptoms)", q.checkMecfs]);
  if (q.checkFibro) rows.push(["Fibromyalgia self-check (2016 criteria)", q.checkFibro]);
  const lyme = lymeExposureLine(q);
  if (lyme) rows.push(["Lyme exposure (patient report, not scored)", lyme]);
  const phq9 = phq9Line(q);
  if (phq9) rows.push(["PHQ-9 (depression severity)", phq9]);
  const gad7 = gad7Line(q);
  if (gad7) rows.push(["GAD-7 (anxiety severity)", gad7]);
  if (q.covid) rows.push(["Has had COVID-19", q.covidDate ? `${q.covid} (${formatDay(q.covidDate) || q.covidDate})` : q.covid]);
  if (q.onset) rows.push(["Symptoms started", formatDay(q.onset) || q.onset]);
  return rows;
}

export function reportedLines(key, q) {
  if (!q) return [];
  const lines = [];
  if (key === "longcovid") {
    if (q.covid) lines.push(`Has had COVID-19: ${q.covid}${q.covidDate ? ` (${formatDay(q.covidDate) || q.covidDate})` : ""}`);
    if (showsRecover(q)) lines.push(`RECOVER 2024 index: ${q.recoverPoints} points${q.recoverComplete ? "" : " so far"} (${q.recoverRange})`);
    if (q.pcfs) lines.push(`Post-COVID-19 Functional Status: ${q.pcfs}`);
  }
  if (key === "chronicfatigue" || key === "longcovid") {
    if (q.pemScreen) lines.push(`DePaul post-exertional malaise screen: ${q.pemScreen === "Yes" ? "meets the screening rule" : "does not meet the screening rule"}`);
  }
  if (key === "chronicfatigue" && q.pemDuration) lines.push(`Recovery after exertion: ${q.pemDuration}`);
  if (key === "longcovid" && q.checkLongCovid) lines.push(`Long COVID self-check: ${q.checkLongCovid}`);
  if (key === "chronicfatigue" && q.checkMecfs) lines.push(`ME/CFS self-check: ${q.checkMecfs}`);
  if (key === "fibromyalgia" && q.checkFibro) lines.push(`Fibromyalgia self-check: ${q.checkFibro}`);
  if (key === "fibromyalgia" && q.symptoms) lines.push(`In the patient's words: "${q.symptoms}"`);
  // Shown beside the depression and anxiety estimates, never combined with them (no published likelihood ratio
  // against those models' target, a self-reported diagnosis that was never coded).
  if (key === "depression" && phq9Line(q)) lines.push(`PHQ-9: ${phq9Line(q)}`);
  if (key === "anxiety" && gad7Line(q)) lines.push(`GAD-7: ${gad7Line(q)}`);
  return lines;
}

// ---------------------------------------------------------------- the patient's answers in the estimate

/**
 * Published likelihood ratios for one questionnaire result per condition, each measured against a reference
 * close to that chart model's own target (docs/CLINICIAN_INTERFACE.md, "Combining the chart and the answers").
 * The chart estimate's odds are multiplied by the ratio for the patient's result (Bayes' rule, treating the
 * answers and the chart findings as independent given the condition, as the chart model treats its findings).
 * One instrument per condition, because the instruments overlap (the ME/CFS self-check reuses the DePaul screen).
 * Instruments without a published ratio against a comparable reference (DePaul PEM screen alone, the
 * National Academies time question, PCFS, the Lyme exposure questions) are shown but not combined.
 */
export const ANSWER_EVIDENCE = Object.freeze({
  longcovid: {
    label: "RECOVER 2024 index",
    result: (q) => (showsRecover(q) && q.recoverComplete && ["likely", "possible", "none"].includes(q.recoverCategory)
      ? (q.recoverCategory === "likely" ? "positive" : "negative") : null),
    text: { positive: "11 or more points", negative: "under 11 points" },
    lr: { positive: 2.83, negative: 0.46 },
    source: "Castro et al., JAMIA 2026",
    measured: "the index at 11 or more points against a Long COVID code (U09.9) in the linked records of 1,501 RECOVER-Adult participants",
    url: "https://doi.org/10.1093/jamia/ocag115",
  },
  chronicfatigue: {
    label: "ME/CFS self-check (IOM 2015 core symptoms)",
    result: (q) => (q.checkMecfsCode === "match" ? "positive" : q.checkMecfsCode === "no-match" ? "negative" : null),
    text: { positive: "matches the criteria pattern", negative: "does not match" },
    lr: { positive: 1.62, negative: 0.47 },
    source: "Jason et al., Diagnostics 2015",
    measured: "questionnaire-based IOM 2015 criteria against a physician panel's chronic fatigue syndrome diagnosis, among community adults with chronic fatigue",
    url: "https://doi.org/10.3390/diagnostics5020272",
  },
  fibromyalgia: {
    label: "Fibromyalgia self-check (2016 criteria)",
    result: (q) => (q.checkFibroCode === "match" ? "positive" : q.checkFibroCode === "no-match" ? "negative" : null),
    text: { positive: "matches the criteria pattern", negative: "does not match" },
    lr: { positive: 8.46, negative: 0.7 },
    source: "Srinivasan et al., ACR Open Rheumatology 2019",
    measured: "the patient-completed 2016 criteria against a patient-reported physician diagnosis of fibromyalgia, among 3,276 primary care patients",
    url: "https://doi.org/10.1002/acr2.1006",
  },
});

const fromOdds = (o) => o / (1 + o);

/** The patient's result for a condition's instrument, with its likelihood ratio, or null when it does not apply. */
export function answerEvidence(key, q) {
  const ev = ANSWER_EVIDENCE[key];
  const result = ev && q ? ev.result(q) : null;
  if (!result) return null;
  return { label: ev.label, result, text: ev.text[result], lr: ev.lr[result], source: ev.source, measured: ev.measured, url: ev.url, authored: q.authored || null };
}

/**
 * The summary with the patient's answers folded in: probability, times the average, band, and next steps follow
 * the combined estimate; the chart-only values stay in `chart`. Each finding's odds ratio is unchanged (both odds
 * are multiplied by the same ratio); its "without" estimate is moved the same way. Unchanged when no instrument
 * result applies.
 */
export function withAnswers(sm, q, card, model) {
  if (sm.status !== "scored") return sm;
  const answer = answerEvidence(sm.key, q);
  if (!answer) return sm;
  const update = (p) => fromOdds(odds(p) * answer.lr);
  const probability = update(sm.probability);
  const band = (model?.risk_bands || []).find((b) => probability <= b.max_probability)?.name || sm.band;
  const moved = (d) => (d.effect ? { ...d, effect: { ...d.effect, without: update(d.effect.without) } } : d);
  const steps = Math.min(10, Math.max(1, Math.round((10 * Math.abs(Math.log(answer.lr))) / Math.log(EFFECT_FULL_SCALE))));
  return {
    ...sm,
    chart: { probability: sm.probability, times: sm.times, band: sm.band },
    answer: { ...answer, effect: { oddsRatio: answer.lr, without: sm.probability, steps } },
    probability,
    times: typeof sm.average === "number" ? probability / sm.average : sm.times * (probability / sm.probability),
    band,
    headline: ANSWER_BAND_TEXT[band] || band,
    nextSteps: band === "Typical" ? [] : card.nextSteps,
    drivers: sm.drivers.map(moved),
    lowering: (sm.lowering || []).map(moved),
  };
}

// ---------------------------------------------------------------- model cards

const BAND_TEXT = {
  High: "High: chart pattern well above the average",
  Elevated: "Elevated: chart pattern above the average",
  Typical: "Typical: no strong chart pattern",
};
const ANSWER_BAND_TEXT = {
  High: "High: chart and answers well above the average",
  Elevated: "Elevated: chart and answers above the average",
  Typical: "Typical: no strong pattern in the chart and answers",
};

/** The scorer's not-scored (or could-not-score) reason as a sentence a clinician can read at a glance. */
export function notScoredSentence(reason, { title = "this condition", indexDate = null } = {}) {
  const r = String(reason || "").trim();
  const unread = /^could not score: (.+) unavailable$/iu.exec(r);
  if (unread) {
    return `Could not score: the chart's ${unread[1]} records could not be read, so this card has no result. This is not a negative result.`;
  }
  if (/^could not score/iu.test(r)) return "Could not score: the scorer stopped on this chart, so this card has no result. This is not a negative result.";
  const era = /no documented COVID-19 index event on or after (\d{4}-\d{2}-\d{2})/iu.exec(r);
  if (era) return `COVID-19 is on record only before ${formatDay(era[1])}; the Long COVID card covers infections from that date on.`;
  if (/no documented COVID-19 index event/iu.test(r)) return "No COVID-19 on record, so the Long COVID card does not apply.";
  if (/fewer than 90 days since the COVID-19 index/iu.test(r)) {
    return indexDate
      ? `COVID-19 on ${formatDay(indexDate)}; the Long COVID card applies from day 90 (${formatDay(addDays(indexDate, 90))}).`
      : "Fewer than 90 days since COVID-19; the Long COVID card applies from day 90.";
  }
  const window = /more than (\d+) days since the COVID-19 index/iu.exec(r);
  if (window) {
    const last = Number(window[1]);
    return indexDate
      ? `COVID-19 on ${formatDay(indexDate)}; the Long COVID card applies from day 90 to day ${last} (${formatDay(addDays(indexDate, 90))} to ${formatDay(addDays(indexDate, last))}), so this chart is past the model's time window.`
      : `More than ${last} days since COVID-19, past the Long COVID model's time window.`;
  }
  if (/birth date missing or unusable/iu.test(r)) return "No usable birth date on record; the card needs the patient's age.";
  if (/the model covers women/iu.test(r)) return `The ${title} card covers women; this chart's gender is not female.`;
  if (/^under 18 at the COVID-19 index/iu.test(r)) return "The card covers adults; the patient was under 18 at the COVID-19 index.";
  if (/^under 18 on the scoring date/iu.test(r)) return "The card covers adults; the patient is under 18.";
  const dx = /^an? (.+) diagnosis is already recorded$/iu.exec(r);
  if (dx) return `Already diagnosed: ${dx[1]} is recorded in the chart.`;
  if (/insufficient history/iu.test(r)) return "Too little recent history to score.";
  return r ? `Not scored for ${title}: ${r}.` : `Not scored for ${title}.`;
}

function uniqueSorted(list) {
  return [...new Set(list.filter(Boolean))].sort();
}

const odds = (p) => p / (1 - p);

/**
 * How much one finding moves this patient's estimate: the calibrated probability without the finding's
 * weight, and the odds ratio between the estimate with and without it. On a fixed scale shared by every
 * patient and model, so a full bar means the same thing everywhere (EFFECT_FULL_SCALE).
 */
export const EFFECT_FULL_SCALE = 2; // a full bar: the finding doubles (or halves) the odds
export function findingEffect(result, contribution, model) {
  const points = model?.calibration?.points;
  if (!points || typeof result.score !== "number") return null;
  const without = calibrate(result.score - contribution, points);
  const oddsRatio = odds(result.probability) / odds(without);
  const steps = Math.min(10, Math.max(1, Math.round((10 * Math.abs(Math.log(oddsRatio))) / Math.log(EFFECT_FULL_SCALE))));
  return { without, oddsRatio, steps };
}

export function summarizeScore(card, result, model = null) {
  if (result.status !== "scored") {
    const unread = result.status === "could_not_score";
    return {
      key: card.key,
      slug: card.slug,
      title: card.title,
      status: unread ? "could_not_score" : "not_scored",
      headline: unread ? "Could not score" : "Not scored",
      unavailable: unread ? [...(result.unavailable || [])] : [],
      detail: notScoredSentence(result.reason, { title: card.title, indexDate: result.index_date || null }),
      reason: result.reason,
      indexDate: result.index_date || null,
      drivers: [],
      lowering: [],
      context: [],
      nextSteps: [],
      checklist: null,
      target: card.target,
    };
  }
  const positive = (result.drivers || []).filter((d) => d.contribution > 0);
  const finding = (d) => {
    const events = (d.evidence || [])
      .filter((e) => e.date && e.date !== "None")
      .map((e) => ({ id: e.id, date: e.date, resourceType: e.resourceType }))
      .sort((a, b) => a.date.localeCompare(b.date));
    return {
      id: d.id, label: d.label, group: d.group, contribution: d.contribution,
      effect: findingEffect(result, d.contribution, model),
      dates: uniqueSorted(events.map((e) => e.date)), events,
    };
  };
  const drivers = positive.filter((d) => d.group !== "Demographics").map(finding);
  // findings on the chart that lower the estimate, most lowering first
  const lowering = (result.drivers || [])
    .filter((d) => d.contribution < 0 && d.group !== "Demographics")
    .sort((a, b) => a.contribution - b.contribution)
    .map(finding);
  return {
    key: card.key,
    slug: card.slug,
    title: card.title,
    status: "scored",
    band: result.band,
    headline: BAND_TEXT[result.band] || result.band,
    times: result.times_average,
    probability: result.probability,
    indexDate: result.index_date || null,
    drivers,
    lowering,
    average: model?.reference?.cohort_base_rate ?? null,
    bands: model ? bandThresholds(model) : [],
    estimate: card.estimate || null,
    context: positive.filter((d) => d.group === "Demographics").map((d) => d.label),
    nextSteps: result.band === "Typical" ? [] : card.nextSteps,
    checklist: card.checklist || null,
    checklistSource: card.checklistSource || null,
    checklistSourceUrl: card.checklistSourceUrl || null,
    target: card.target,
  };
}

/** Resource types the record could not read (a failed, forbidden, or unsupported search), from record.access. */
export function unavailableTypes(record) {
  const readable = new Set(["Available", "Available with restrictions"]);
  return [...new Set((record?.access || []).filter((a) => a?.resourceType && !readable.has(a.status)).map((a) => a.resourceType))];
}

/** One model's result; a scorer error becomes a could-not-score result instead of breaking the dashboard. */
export function scoreCard(model, bundle, asOf, unavailable = []) {
  try {
    return scoreBundle(model, bundle, asOf, { unavailable });
  } catch {
    return { status: "could_not_score", reason: "could not score: the scorer stopped on this chart", unavailable: [] };
  }
}

export function scoreAll(bundle, models, asOf, unavailable = []) {
  return MODEL_CARDS.map((card) => summarizeScore(card, scoreCard(models[card.key], bundle, asOf, unavailable), models[card.key]));
}

/** Band thresholds of a model as multiples of the average and as probabilities. */
export function bandThresholds(model) {
  const base = model?.reference?.cohort_base_rate;
  return (model?.risk_bands || []).map((b, i, all) => ({
    name: b.name,
    lower: i === 0 ? 0 : all[i - 1].max_probability,
    upper: b.max_probability,
    lowerTimes: i === 0 || !base ? 0 : all[i - 1].max_probability / base,
    upperTimes: base ? b.max_probability / base : null,
  }));
}

/** Facts for "About this model", all read from the model file. */
export function modelFacts(card, model) {
  if (!model) return null;
  const pct = (p) => `${(100 * p).toFixed(2)}%`;
  const bands = bandThresholds(model).map((b) =>
    b.upper >= 1
      ? `${b.name}: above ${b.lowerTimes.toFixed(1)} times the average (probability above ${pct(b.lower)})`
      : b.lower === 0
        ? `${b.name}: up to ${b.upperTimes.toFixed(1)} times the average (probability up to ${pct(b.upper)})`
        : `${b.name}: ${b.lowerTimes.toFixed(1)} to ${b.upperTimes.toFixed(1)} times the average (probability ${pct(b.lower)} to ${pct(b.upper)})`,
  );
  const cal = model.calibration || {};
  const v = model.provenance?.validation_split_evaluation || null;
  let validation = null;
  if (v) {
    validation = [];
    if (typeof v.auroc === "number") validation.push(`AUROC ${v.auroc.toFixed(3)}${typeof v.auprc === "number" ? `, AUPRC ${v.auprc.toFixed(3)}` : ""} on a random 20% validation split`);
    if (v.held_out_people) validation.push(`${Number(v.held_out_people).toLocaleString("en-US")} held-out people, ${Number(v.held_out_positives).toLocaleString("en-US")} with the outcome`);
    const site = /held-out-site AUROC[^:]*:\s*([\d.]+)\s*\(95% CI ([\d.]+)-([\d.]+)\)/u.exec(String(v.note || ""));
    const nSite = /(\d+)-feature pipeline/u.exec(String(v.note || ""));
    if (site) validation.push(`A separately fitted ${nSite ? `${nSite[1]}-feature ` : ""}version reached AUROC ${site[1]} (95% CI ${site[2]} to ${site[3]}) at 18 held-out sites; this model's probability map was not externally validated`);
  }
  return {
    id: model.model_id,
    version: model.version,
    status: model.status,
    predicts: model.target?.label || "",
    definition: model.target?.definition || "",
    population: model.target?.population || "",
    average: typeof model.reference?.cohort_base_rate === "number" ? pct(model.reference.cohort_base_rate) : null,
    calibration: cal.method === "piecewise_linear"
      ? `Piecewise-linear calibration over ${(cal.points || []).length} points${cal.fit?.type ? `, fit as ${cal.fit.type}` : ""}.`
      : String(cal.method || ""),
    bands,
    validation,
    data: model.provenance?.data || null,
    limits: card.limits || [],
    guide: card.guide,
  };
}

// ---------------------------------------------------------------- Lyme and lupus

function patientOf(bundle) {
  return (bundle?.entry || []).map((e) => e.resource).find((r) => r?.resourceType === "Patient") || null;
}

export function lymeContext(bundle, lyme) {
  const address = patientOf(bundle)?.address?.[0];
  if (!lyme || !address?.state) return null;
  const state = lyme.states[String(address.state).toUpperCase()];
  if (!state) return null;
  const district = String(address.district || "").trim();
  const county = district && state.counties[district] ? district : null;
  const [incidence, band] = county ? state.counties[county] : [state.incidence, state.band];
  return { state: state.name, county, incidence, band };
}

function contextSentence(ctx) {
  const place = ctx.county ? `${ctx.county}, ${ctx.state}` : `${ctx.state} (state average; county not on file)`;
  return `${place}: ${ctx.incidence} reported cases per 100,000 people per year (CDC surveillance, 2015 to 2019), a ${ctx.band}-incidence area.`;
}

/**
 * The Lyme item: coded features (lyme-rule.js) next to the county exposure context.
 * Needs review when there is a feature and the county is a moderate- or high-incidence area, or two or more
 * feature types; already coded Lyme disease is listed under "Also checked".
 */
export function lymeSummary(bundle, lyme) {
  const rule = evaluateLymeFeatures(bundle);
  const context = lymeContext(bundle, lyme);
  const exposed = context && ["moderate", "high"].includes(context.band);
  let review = rule.featureCount >= 2 || (rule.featureCount >= 1 && Boolean(exposed));
  let sentence;
  if (rule.alreadyCoded.length) {
    review = false;
    sentence = "Already diagnosed: Lyme disease is recorded in the chart.";
  } else if (!rule.featureCount && !context) sentence = "No Lyme features or address on file.";
  else if (!rule.featureCount) sentence = `No Lyme features on file. Exposure context: ${contextSentence(context)}`;
  else if (!review) sentence = `${rule.features.map((f) => f.label).join(", ")} on file; ${context ? `${context.band}-incidence area.` : "no address on file."}`;
  else sentence = null;
  const headline = rule.featureCount
    ? `${rule.featureCount} ${rule.featureCount === 1 ? "feature" : "features"} consistent with Lyme disease`
    : "No coded features consistent with Lyme disease";
  return { slug: "lyme", title: "Lyme disease", ...rule, context, review, sentence, headline };
}

export function lupusSummary(signal) {
  const found = signal.criteria.filter((c) => c.state !== "unknown");
  const review = !signal.existingDiagnosis && signal.rating >= 3;
  let sentence = null;
  if (signal.existingDiagnosis) sentence = "Already diagnosed: systemic lupus erythematosus is recorded in the chart.";
  else if (!review) {
    sentence = `Review signal ${signal.rating} of 5, ${lowerFirst(signal.title)}${found.length ? "." : "; no lupus classification criteria found in structured data."}`;
  }
  return { slug: "lupus", title: "Lupus", signal, found, review, sentence, headline: `Review signal ${signal.rating} of 5: ${signal.title}` };
}

// ---------------------------------------------------------------- dashboard model

const RANK = { High: 0, Elevated: 1 };

/** Needs-review items: High, then Elevated (each by multiple of the average, largest first), then rule-based items. */
export function sortForReview(items) {
  const rank = (i) => (i.kind === "model" ? RANK[i.band] ?? 3 : 2);
  const strength = (i) => (i.kind === "model" ? i.times : i.strength || 0);
  return [...items].sort((a, b) => rank(a) - rank(b) || strength(b) - strength(a));
}

/** Items represented by a red dot in the condition tabs. */
export function seriousItems(items) {
  return items.filter((item) => item.kind === "model" && item.review && item.band === "High");
}

function modelItem(s) {
  const review = s.status === "scored" && (s.band === "High" || s.band === "Elevated");
  return {
    kind: "model",
    slug: s.slug,
    key: s.key,
    title: s.title,
    tab: TABS.find((t) => t.slug === s.slug).label,
    band: s.status === "scored" ? s.band : null,
    times: s.status === "scored" ? s.times : 0,
    review,
    unscored: s.status === "could_not_score",
    chip: s.status === "scored" ? s.band : s.status === "could_not_score" ? "Could not score" : "Does not apply",
    top: s.drivers.slice(0, 2).map((d) => d.label),
    sentence: review
      ? null
      : s.status === "scored"
        ? `Typical, ${times(s.times)} the average. No strong chart pattern.`
        : s.detail,
    summary: s,
  };
}

const PATIENT_KIND = { female: "Female", male: "Male", other: "Other", unknown: "Unknown" };

export function patientSummary(bundle, asOf) {
  const p = patientOf(bundle) || {};
  const n = p.name?.[0] || {};
  const given = (n.given || []).join(" ");
  const address = p.address?.[0] || null;
  return {
    id: p.id || null,
    given,
    family: n.family || "",
    name: [given, n.family].filter(Boolean).join(" ") || "Patient",
    shortName: given ? `${given}${n.family ? ` ${n.family[0]}.` : ""}` : n.family || "Patient",
    sex: PATIENT_KIND[p.gender] || "",
    age: ageOn(p.birthDate, asOf),
    place: address ? [address.district || address.city, address.state].filter(Boolean).join(", ") : null,
    asOf,
  };
}

const ENCOUNTER_KIND = { AMB: "Outpatient visit", EMER: "Emergency visit", IMP: "Hospital stay", VR: "Virtual visit", HH: "Home visit", OBSENC: "Observation stay" };
const LANES = [
  { id: "visit", label: "Visits", one: "Visit", types: ["Encounter"] },
  { id: "diagnosis", label: "Diagnoses", one: "Diagnosis", types: ["Condition"] },
  { id: "test", label: "Tests", one: "Test", types: ["Observation", "Procedure", "DiagnosticReport"] },
  { id: "rx", label: "Prescriptions", one: "Prescription", types: ["MedicationRequest"] },
];
export const TIMELINE_LANES = LANES;

function conceptText(c) {
  const coding = c?.coding?.[0];
  return c?.text || coding?.display || coding?.code || "";
}

function eventText(r) {
  if (r.resourceType === "Encounter") {
    const cls = Array.isArray(r.class) ? r.class[0] : r.class;
    const code = cls?.code || cls?.coding?.[0]?.code;
    return ENCOUNTER_KIND[code] || cls?.display || "Visit";
  }
  if (r.resourceType === "MedicationRequest") return conceptText(r.medicationCodeableConcept) || "Prescription";
  const label = conceptText(r.code) || r.resourceType;
  const code = r.resourceType === "Condition" ? r.code?.coding?.find((c) => /icd-10/u.test(c.system || ""))?.code : null;
  if (r.resourceType === "Observation" && r.valueQuantity?.value !== undefined) {
    return `${label}: ${r.valueQuantity.value}${r.valueQuantity.unit ? ` ${r.valueQuantity.unit}` : ""}`;
  }
  return code ? `${label} (${code})` : label;
}

function safeDate(r) {
  try {
    return resourceDate(r);
  } catch {
    return null;
  }
}

/**
 * Chronological chart events for the Timeline tab, with the cards that cite each one, plus markers
 * (scoring date; for Long COVID the COVID-19 index and day 90).
 */
export function buildTimeline(bundle, { asOf, covidIndex = null, citations = new Map() } = {}) {
  const events = [];
  for (const { resource: r } of bundle?.entry || []) {
    const lane = LANES.find((l) => l.types.includes(r?.resourceType));
    if (!lane) continue;
    const date = safeDate(r);
    if (!date) continue;
    events.push({ id: r.id ?? null, date, lane: lane.id, type: r.resourceType, text: eventText(r), citedBy: [...(citations.get(r.id) || [])] });
  }
  events.sort((a, b) => a.date.localeCompare(b.date) || LANES.findIndex((l) => l.id === a.lane) - LANES.findIndex((l) => l.id === b.lane));
  const markers = [];
  if (covidIndex) {
    markers.push({ id: "covid", date: covidIndex, label: "COVID-19 index" });
    markers.push({ id: "day90", date: addDays(covidIndex, 90), label: "Day 90" });
  }
  if (asOf) markers.push({ id: "asof", date: asOf, label: "Scoring date" });
  markers.sort((a, b) => a.date.localeCompare(b.date));
  const dates = [...events.map((e) => e.date), ...markers.map((m) => m.date)].sort();
  return { events, markers, start: dates[0] || asOf, end: dates[dates.length - 1] || asOf };
}

/** Everything the dashboard shows, computed without the DOM. */
export function buildDashboard({ bundle, record = null, models, lyme, asOf, questionnaire = null }) {
  const unavailable = unavailableTypes(record);
  const answers = summarizeQuestionnaire(questionnaire);
  const scores = MODEL_CARDS.map((card) => {
    const result = scoreCard(models[card.key], bundle, asOf, unavailable);
    return { card, result, summary: withAnswers(summarizeScore(card, result, models[card.key]), answers, card, models[card.key]) };
  });
  const lymeItem = { kind: "rule", ...lymeSummary(bundle, lyme) };
  const lymeUnread = unavailable.filter((t) => t === "Condition" || t === "Patient");
  if (lymeUnread.length) {
    // the Lyme rule reads coded diagnoses and the address; without them "none found" would be a false negative
    lymeItem.review = false;
    lymeItem.unscored = true;
    lymeItem.sentence = `Could not check: the chart's ${lymeUnread.join(" and ")} records could not be read.`;
  }
  lymeItem.strength = lymeItem.featureCount;
  lymeItem.tab = "Lyme";
  lymeItem.chip = lymeItem.unscored ? "Could not check" : lymeItem.review ? "Chart rule" : lymeItem.alreadyCoded.length ? "Already coded" : "None found";
  lymeItem.metric = `${lymeItem.featureCount} ${lymeItem.featureCount === 1 ? "feature" : "features"}${lymeItem.context ? `, ${lymeItem.context.band}-incidence ${lymeItem.context.county ? "county" : "state"}` : ", no address"}`;
  lymeItem.top = lymeItem.features.slice(0, 2).map((f) => f.label);
  const lupusItem = { kind: "rule", ...lupusSummary(evaluateLupusSignal(record || bundleToRecord(bundle))) };
  lupusItem.strength = lupusItem.signal.rating;
  lupusItem.tab = "Lupus";
  lupusItem.chip = lupusItem.review ? "Chart rule" : `Signal ${lupusItem.signal.rating} of 5`;
  lupusItem.metric = `Review signal ${lupusItem.signal.rating} of 5`;
  lupusItem.top = lupusItem.found.slice(0, 2).map((c) => c.label);

  // Lyme disease and lupus are model cards; their chart rules feed the criteria column of those panels.
  const items = scores.map((s) => modelItem(s.summary));

  const citations = new Map();
  const cite = (id, label) => {
    if (!id) return;
    if (!citations.has(id)) citations.set(id, new Set());
    citations.get(id).add(label);
  };
  // only cards that need review cite events, so typical cards add no noise to the timeline
  for (const s of scores) {
    if (s.summary.status !== "scored" || s.summary.band === "Typical") continue;
    for (const d of s.summary.drivers) for (const e of d.events) cite(e.id, s.card.tab);
  }
  for (const f of lymeItem.features) for (const e of f.findings) cite(e.id, "Lyme");

  const covid = scores.find((s) => s.card.key === "longcovid");
  const covidIndex = covid?.result.index_date || null;
  return {
    patient: patientSummary(bundle, asOf),
    asOf,
    items,
    needsReview: sortForReview(items.filter((i) => i.review)),
    alsoChecked: items.filter((i) => !i.review),
    couldNotScore: items.filter((i) => i.unscored).map((i) => i.title),
    unavailable,
    scores,
    lyme: lymeItem,
    lupus: lupusItem,
    timeline: buildTimeline(bundle, { asOf, covidIndex, citations }),
    questionnaire: answers,
  };
}

// ---------------------------------------------------------------- DOM

function h(tag, props, ...kids) {
  const node = document.createElement(tag);
  if (typeof props === "string") node.className = props;
  else if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === "class") node.className = v;
      else if (k === "text") node.textContent = v;
      else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
      else if (k === "hidden") node.hidden = true;
      else node.setAttribute(k, v === true ? "" : String(v));
    }
  }
  for (const kid of kids.flat(Infinity)) if (kid !== null && kid !== undefined && kid !== false) node.append(kid);
  return node;
}

const SVG_NS = "http://www.w3.org/2000/svg";
function s(tag, attrs = {}, ...kids) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined) node.setAttribute(k, String(v));
  for (const kid of kids) if (kid !== null && kid !== undefined) node.append(kid);
  return node;
}

const domId = (id) => `dash-ev-${String(id).replace(/[^A-Za-z0-9_-]/gu, "_")}`;
const bandClass = (band) => `band-${String(band || "none").toLowerCase().replace(/[^a-z]/gu, "")}`;

function section(title, ...kids) {
  return h("section", "dash-section", h("h4", "dash-section-title", title), ...kids);
}

function eventLink(ctx, event, text) {
  return h("a", {
    class: "dash-evlink",
    href: `#${domId(event.id)}`,
    title: "Show in the timeline",
    onclick: (e) => {
      e.preventDefault();
      ctx.showEvent(event.id);
    },
  }, text);
}

function dateLinks(ctx, events, max = 3) {
  const shown = [];
  const seen = new Set();
  for (const e of events) {
    if (seen.has(e.date)) continue;
    seen.add(e.date);
    shown.push(e);
  }
  const wrap = h("span", "dash-dates");
  shown.slice(0, max).forEach((e, i) => {
    if (i) wrap.append(", ");
    wrap.append(eventLink(ctx, e, formatDay(e.date, { short: true })));
  });
  if (shown.length > max) wrap.append(` and ${shown.length - max} more`);
  return wrap;
}

function printIcon() {
  return s("svg", { viewBox: "0 0 24 24", width: "20", height: "20", "aria-hidden": "true" },
    s("path", { d: "M7 8V3h10v5M7 17H5a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-2M7 14h10v7H7z", fill: "none", stroke: "currentColor", "stroke-width": "1.7", "stroke-linejoin": "round" }),
  );
}

function renderPatientLine(model, { synthetic, shortName, canPrint }) {
  const p = model.patient;
  const bits = [p.sex, p.age !== null ? `${p.age}` : null, `as of ${formatDay(model.asOf)}`, p.place].filter(Boolean);
  return h("div", "dash-patient",
    h("h2", { class: "dash-patient-name", text: shortName ? p.shortName : p.name }),
    h("p", "dash-patient-meta", bits.join(" · ")),
    synthetic ? h("span", { class: "dash-synthetic", title: "Made-up patient; no real data", text: "Synthetic patient record" }) : null,
    h("button", {
      type: "button",
      class: "dash-print-button",
      disabled: canPrint ? null : true,
      title: canPrint ? "Print report" : "No conditions are marked High",
      "aria-label": canPrint ? "Print report" : "Print report unavailable; no conditions are marked High",
      onclick: () => globalThis.print(),
    }, printIcon()),
  );
}

function printDate() {
  return new Intl.DateTimeFormat("en-US", { dateStyle: "long", timeStyle: "short" }).format(new Date());
}

function renderPrintReport(model, panels) {
  const serious = seriousItems(model.items);
  const report = h("article", { class: "dash-print-report", "aria-hidden": "true" });
  const header = h("header", "dash-print-head",
    h("img", { class: "dash-print-logo", src: "/images/homepage/unom-logo-wide-light.svg", alt: "Undiagnosed No More" }),
    h("h1", null, "Report"),
  );
  const patientBits = [model.patient.sex, model.patient.age !== null ? `Age ${model.patient.age}` : null, model.patient.place].filter(Boolean);
  report.append(header,
    h("section", { class: "dash-print-meta", "aria-label": "Report information" },
      h("div", null, h("span", null, "Patient"), h("strong", null, model.patient.name)),
      h("div", null, h("span", null, "Patient details"), h("strong", null, patientBits.join(" · ") || "Not available")),
      h("div", null, h("span", null, "Chart assessed through"), h("strong", null, formatDay(model.asOf) || model.asOf)),
      h("div", null, h("span", null, "Report prepared"), h("strong", null, printDate())),
    ),
  );
  const body = h("div", "dash-print-body");
  for (const item of serious) {
    const source = panels.get(item.slug);
    if (!source) continue;
    const detail = source.cloneNode(true);
    detail.removeAttribute("id");
    detail.removeAttribute("role");
    detail.removeAttribute("aria-labelledby");
    detail.removeAttribute("tabindex");
    detail.removeAttribute("hidden");
    detail.className = "dash-print-condition-detail";
    for (const node of detail.querySelectorAll("[id]")) node.removeAttribute("id");
    for (const disclosure of detail.querySelectorAll("details")) disclosure.open = true;
    body.append(h("section", "dash-print-condition",
      h("div", "dash-print-condition-title",
        h("span", { class: "dash-print-red-dot", "aria-hidden": "true" }),
        h("h2", null, item.tab),
      ),
      detail,
    ));
  }
  if (!serious.length) body.append(h("p", "dash-print-empty", "No condition is currently marked High."));
  report.append(body,
    h("footer", "dash-print-footer",
      h("span", null, "Undiagnosed No More"),
      h("span", null, "undiagnosednomore.org"),
      h("span", null, "For clinician review"),
    ),
  );
  return report;
}

function reviewRow(ctx, item) {
  const metric = h("span", "dash-metric", item.kind === "model" ? `${times(item.times)} average` : item.metric);
  return h("li", null,
    h("button", {
      type: "button",
      class: `dash-review-row ${item.kind === "model" ? bandClass(item.band) : "band-rule"}`,
      onclick: () => ctx.selectTab(item.slug, { focus: true, scroll: true }),
    },
    h("span", "dash-review-top",
      h("span", "dash-review-title", item.title),
      h("span", `dash-chip ${item.kind === "model" ? bandClass(item.band) : "band-rule"}`, item.chip),
      metric,
    ),
    item.top.length ? h("span", "dash-review-why", `Top findings: ${item.top.join("; ")}`) : null,
    ),
  );
}

function renderOverview(ctx, model) {
  const left = h("section", { class: "dash-card dash-review", "aria-labelledby": "dash-review-title" });
  left.append(h("h3", { id: "dash-review-title", class: "dash-card-title", text: "Needs review" }));
  if (model.couldNotScore.length) {
    left.append(h("p", "dash-notice",
      `Could not score ${model.couldNotScore.join(", ")}: part of the chart could not be read${model.unavailable.length ? ` (${model.unavailable.join(", ")})` : ""}. Those cards have no result, which is not the same as a typical result.`));
  }
  if (model.needsReview.length) {
    left.append(h("ul", "dash-review-list", model.needsReview.map((i) => reviewRow(ctx, i))));
  } else if (model.couldNotScore.length) {
    left.append(h("p", "dash-empty", "Nothing needs review among the cards that could be scored."));
  } else {
    left.append(h("p", "dash-empty", "Nothing needs review: no card is High or Elevated, and the Lyme and lupus rules found nothing to flag."));
  }
  const checked = h("details", "dash-checked");
  checked.append(
    h("summary", null,
      h("span", "dash-checked-label", "Also checked"),
      h("span", "dash-checked-inline", model.alsoChecked.map((i) => `${i.tab} ${i.kind === "model" && i.band ? lowerFirst(i.band) : lowerFirst(i.chip)}`).join(" · ")),
    ),
    h("ul", "dash-checked-list", model.alsoChecked.map((i) =>
      h("li", null,
        h("button", { type: "button", class: "dash-linkbtn", onclick: () => ctx.selectTab(i.slug, { focus: true, scroll: true }) }, i.tab),
        h("span", null, i.sentence || ""),
      ),
    )),
  );
  left.append(checked);
  return left;
}

function pendingBlock(ctx, model, pending) {
  const p = summarizeQuestionnaire(pending.qr);
  const who = model.patient.shortName || model.patient.name;
  return h("div", { class: "dash-notice", role: "group", "aria-label": "Answers waiting for confirmation" },
    h("p", null, `${pending.source?.label || "Answers from the patient app"}${p?.authored ? `, answered ${formatDay(p.authored) || p.authored}` : ""}. `
      + "They carry no patient identity, so confirm that they belong to this patient before they are added."),
    h("div", "dash-actions",
      h("button", { type: "button", class: "dash-button", onclick: ctx.confirmPending }, `Add to ${who}'s chart`),
      h("button", { type: "button", class: "dash-linkbtn", onclick: ctx.dismissPending }, "Do not add")),
  );
}

function renderPatientPanel(ctx, model, opts) {
  const q = model.questionnaire;
  const panel = h("section", { class: "dash-card dash-from-patient", "aria-labelledby": "dash-patient-title" });
  panel.append(h("h3", { id: "dash-patient-title", class: "dash-card-title", text: "From the patient" }));
  if (opts.pending) panel.append(pendingBlock(ctx, model, opts.pending));
  if (!q) {
    panel.append(h("p", "dash-empty", opts.emptyPatientText || "No answers from the patient app yet."));
    const actions = h("div", "dash-actions");
    if (opts.onLoadDemo) actions.append(h("button", { type: "button", class: "dash-button", onclick: opts.onLoadDemo }, "Load demo answers"));
    actions.append(importControl(ctx));
    panel.append(actions);
    return panel;
  }
  const selfHarm = selfHarmNotice(q);
  if (selfHarm) panel.append(h("p", { class: "dash-notice", role: "note" }, selfHarm));
  const src = opts.source || {};
  const sourceLine = h("p", "dash-source");
  sourceLine.append(src.label || `Answered ${formatDay(q.authored) || q.authored}`);
  if (src.label && q.authored) sourceLine.append(`. Answered ${formatDay(q.authored) || q.authored}`);
  if (q.status !== "completed") sourceLine.append(" (partly completed)");
  if (q.respondent && q.respondent !== "Patient") sourceLine.append(`. ${q.respondent}`);
  sourceLine.append(".");
  if (opts.onRemove) sourceLine.append(" ", h("button", { type: "button", class: "dash-linkbtn dash-remove", onclick: opts.onRemove }, "Remove"));
  panel.append(sourceLine);
  const responseBody = opts.collapsePatientResponses
    ? h("details", "dash-response-details", h("summary", "dash-review-responses", "Review responses"))
    : panel;
  if (responseBody !== panel) panel.append(responseBody);
  const rows = patientPanelRows(q);
  if (rows.length) {
    const dl = h("dl", "dash-facts");
    for (const [k, v] of rows) dl.append(h("div", null, h("dt", null, linkedText(k)), h("dd", null, v)));
    responseBody.append(dl);
  }
  if (q.symptoms) responseBody.append(h("p", "dash-subtitle", "In the patient's words"), h("blockquote", "dash-quote", q.symptoms));
  if (q.questions.length) {
    responseBody.append(h("p", "dash-subtitle", "Questions they want to ask"), h("ol", "dash-questions", q.questions.map((t) => h("li", null, t))));
  }
  return panel;
}

function importControl(ctx) {
  const error = h("span", { class: "dash-import-error", role: "status" });
  const input = h("input", { type: "file", accept: "application/json,.json", class: "dash-file" });
  input.addEventListener("change", async () => {
    const file = input.files?.[0];
    if (!file) return;
    let next;
    try {
      next = JSON.parse(await file.text());
    } catch {
      error.textContent = "That file is not a QuestionnaireResponse from the patient app.";
      return;
    }
    const check = checkQuestionnaire(next, { patientId: ctx.patientId });
    if (!check.ok) {
      error.textContent = `Not added. ${check.reason}`;
      return;
    }
    if (check.anonymous) ctx.offer(next, { kind: "file", label: "Added from a file" });
    else ctx.attachFile(next);
  });
  return h("label", "dash-import", h("span", null, "Or add the file from the patient app"), input, error);
}

let tipCount = 0;

/**
 * A tooltip that opens on hover and on keyboard focus and closes with Escape (WCAG 1.4.13). The trigger is
 * focusable and described by the tooltip text, which sits next to it so screen readers also reach it in
 * reading order.
 */
function tip(trigger, text, { align = "start", text: isText = true } = {}) {
  const id = `dash-tip-${++tipCount}`;
  const wrap = h("span", {
    class: `dash-tip dash-tip-${align}${isText ? " dash-tip-word" : ""}`,
    tabindex: "0",
    "aria-describedby": id,
    onkeydown: (e) => {
      if (e.key === "Escape") wrap.classList.add("dash-tip-closed");
    },
    onblur: () => wrap.classList.remove("dash-tip-closed"),
    onmouseleave: () => wrap.classList.remove("dash-tip-closed"),
  }, trigger, h("span", { class: "dash-tip-text", role: "tooltip", id }, text));
  return wrap;
}

function arrow(up) {
  return s("svg", { class: `dash-arrow ${up ? "up" : "down"}`, viewBox: "0 0 10 10", width: "10", height: "10", "aria-hidden": "true", focusable: "false" },
    s("path", { d: up ? "M5 1 9.5 9h-9z" : "M5 9 .5 1h9z" }));
}

const pctText = (p, digits = 1) => `${(100 * p).toFixed(digits)}%`;

/** "4.2%" and "3.1%", with one more digit when one decimal would show the same number twice. */
function pctPair(a, b) {
  return pctText(a) === pctText(b) ? [pctText(a, 2), pctText(b, 2)] : [pctText(a), pctText(b)];
}

export function effectText(probability, effect) {
  const up = effect.oddsRatio >= 1;
  const [withIt, without] = pctPair(probability, effect.without);
  return `${up ? "Raises" : "Lowers"} the estimate: ${withIt} with this finding, ${without} without it (odds ×${effect.oddsRatio.toFixed(2)}).`;
}

export const WHY_TIP = `Each row is a chart finding the model counts. The arrow shows whether it raises or lowers this estimate, the number is how much it multiplies the odds, and a full bar means the odds double (or halve). Every patient and condition uses the same scale.`;

function effectCell(probability, d) {
  if (!d.effect) return h("span");
  const up = d.effect.oddsRatio >= 1;
  return tip(
    h("span", `dash-effect ${up ? "up" : "down"}`,
      arrow(up),
      h("span", "dash-effect-num", `×${d.effect.oddsRatio.toFixed(2)}`),
      h("span", { class: "dash-weight", "aria-hidden": "true" }, h("span", `dash-weight-bar w${d.effect.steps}`))),
    effectText(probability, d.effect),
    { align: "end", text: false },
  );
}

export function answerEffectText(sm) {
  const a = sm.answer;
  const up = a.lr >= 1;
  const [withIt, without] = pctPair(sm.probability, sm.chart.probability);
  return `${up ? "Raises" : "Lowers"} the estimate: ${withIt} with the patient's answers, ${without} from the chart alone (odds ×${a.lr.toFixed(2)}, the published likelihood ratio for this result: ${a.measured}; ${a.source}).`;
}

function findingsList(ctx, sm, limit = 8) {
  const all = [...sm.drivers, ...(sm.lowering || [])];
  const row = (d) =>
    h("li", null,
      h("span", "dash-finding-label", d.label),
      d.events.length ? dateLinks(ctx, d.events) : h("span", "dash-dates muted", "pattern across the chart"),
      effectCell(sm.probability, d),
    );
  const answerRow = sm.answer
    ? h("li", "dash-finding-answer",
      h("span", "dash-finding-label", `Patient's answers: ${sm.answer.label}, ${sm.answer.text}`),
      h("span", "dash-dates", sm.answer.authored ? formatDay(sm.answer.authored, { short: true }) : "questionnaire"),
      tip(
        h("span", `dash-effect ${sm.answer.lr >= 1 ? "up" : "down"}`,
          arrow(sm.answer.lr >= 1),
          h("span", "dash-effect-num", `×${sm.answer.lr.toFixed(2)}`),
          h("span", { class: "dash-weight", "aria-hidden": "true" }, h("span", `dash-weight-bar w${sm.answer.effect.steps}`))),
        answerEffectText(sm),
        { align: "end", text: false },
      ))
    : null;
  const list = h("ul", "dash-findings", answerRow, all.slice(0, limit).map(row));
  if (all.length <= limit) return list;
  return h("div", null, list, h("details", "dash-more", h("summary", null, `${all.length - limit} more findings`), h("ul", "dash-findings", all.slice(limit).map(row))));
}

/** "Fewer than 1", "About 4": how many in 100 patients with this estimate. */
function inHundred(p) {
  const n = Math.round(100 * p);
  return n < 1 ? "fewer than 1" : `about ${n}`;
}

export function estimateTip(sm) {
  if (!sm.estimate) return null;
  const base = cap(sm.estimate.replace("About {n}", cap(inHundred(sm.probability))).replace("{n}", inHundred(sm.probability)));
  if (!sm.answer) return base;
  return `${base} It includes the patient's answers: the chart estimate (${pctText(sm.chart.probability)}) with its odds multiplied by ${sm.answer.lr.toFixed(2)}, the published likelihood ratio for this ${sm.answer.label} result (${sm.answer.text}; ${sm.answer.source}).`;
}

export function timesTip(sm) {
  const bands = (sm.bands || []).map((b) =>
    b.upper >= 1 ? `${b.name} above ${b.lowerTimes.toFixed(1)}` : b.lower === 0 ? `${b.name} up to ${b.upperTimes.toFixed(1)}` : `${b.name} ${b.lowerTimes.toFixed(1)} to ${b.upperTimes.toFixed(1)}`);
  const avg = typeof sm.average === "number" ? ` (${pctText(sm.average)})` : "";
  return `This patient's estimate (${pctText(sm.probability)}) divided by the average estimate in the model's population${avg}.${bands.length ? ` Bands, in times the average: ${bands.join("; ")}.` : ""}`;
}

function aboutLink(label, fragment) {
  return h("a", {
    class: "dash-about-link",
    href: `https://undiagnosednomore.org${fragment}`,
    target: "_blank",
    rel: "noreferrer",
  }, label, " ", h("span", { "aria-hidden": "true" }, "↗"));
}

function aboutModel(facts) {
  return facts ? aboutLink("About this model", facts.guide) : null;
}

function citationLink(label, href) {
  return h("a", { href, target: "_blank", rel: "noreferrer" }, label);
}

function linkedText(text) {
  return referenceParts(text).map((part) =>
    typeof part === "string" ? part : citationLink(part.label, part.href));
}

function renderModelPanel(ctx, model, entry) {
  const sm = entry.summary;
  const panel = [];
  const head = h("div", `dash-panel-head ${bandClass(sm.band)}`);
  head.append(h("p", "dash-panel-band", sm.status === "scored" ? sm.headline : sm.status === "could_not_score" ? "Could not score" : "Does not apply"));
  if (sm.status === "scored") {
    const estimate = `estimated ${pctText(sm.probability)}`;
    const tipText = estimateTip(sm);
    head.append(h("p", "dash-panel-explain",
      `${sm.target}: `,
      tip(`${sm.times.toFixed(1)} times the average`, timesTip(sm)),
      " (", tipText ? tip(estimate, tipText) : estimate, ")",
      sm.answer ? ` with the patient's answers; chart alone ${sm.chart.times.toFixed(1)} times (${pctText(sm.chart.probability)})` : "",
      "."));
  } else {
    head.append(h("p", "dash-panel-explain", sm.detail));
  }
  panel.push(head);
  if (sm.status === "scored") {
    const why = h("section", "dash-section", h("h4", "dash-section-title", tip("Why", WHY_TIP)),
      sm.drivers.length || sm.lowering?.length ? findingsList(ctx, sm) : h("p", "dash-empty", "No chart findings change this score."),
      sm.context.length ? h("p", "dash-context", `Context, not findings: ${sm.context.join(", ")}. Age and sex are part of the model but are not chart findings.`) : null,
    );
    const reported = reportedLines(sm.key, model.questionnaire);
    if (reported.length) why.append(h("p", "dash-subtitle", "From the patient"), h("ul", "dash-plain", reported.map((l) => h("li", null, linkedText(l)))));
    if (sm.answer) why.append(h("p", "dash-cite", `The ${sm.answer.label} result is combined with the chart using its published likelihood ratio: `, citationLink(sm.answer.source, sm.answer.url), "."));
    panel.push(h("div", "dash-columns", why, renderCriteria(ctx, model, entry)));
    panel.push(section("Next steps", sm.nextSteps.length
      ? h("ol", "dash-steps", sm.nextSteps.map((t) => h("li", null, linkedText(t))))
      : h("p", "dash-empty", "None from this card: the chart pattern is typical."),
      entry.card.key === "lyme" ? lymeGuidanceCite() : null));
  } else if (entry.card.key === "lyme" || entry.card.key === "lupus") {
    // without a score, the chart findings and context still help the review
    panel.push(renderCriteria(ctx, model, entry));
  }
  if (entry.card.key === "lupus") panel.push(lupusRuleCite());
  panel.push(aboutModel(modelFacts(entry.card, ctx.models[entry.card.key])));
  return panel;
}

/** The criteria column: a checklist from the card, or, for Lyme disease and lupus, what their chart rules found. */
function renderCriteria(ctx, model, entry) {
  if (entry.card.key === "lyme") return lymeCriteria(ctx, model);
  if (entry.card.key === "lupus") return lupusCriteria(ctx, model);
  const sm = entry.summary;
  return section("Criteria to check",
    h("ul", "dash-checklist", (sm.checklist || []).map((c) => h("li", null, c))),
    h("p", "dash-cite", sm.checklistSourceUrl
      ? citationLink(sm.checklistSource || "Source", sm.checklistSourceUrl)
      : sm.checklistSource || ""),
  );
}

function lymeCriteria(ctx, model) {
  const L = model.lyme;
  const features = h("div", null,
    h("p", "dash-subtitle", "Features consistent with Lyme disease"),
    L.features.length
      ? h("ul", "dash-findings stacked", L.features.map((f) =>
        h("li", null, h("span", "dash-finding-label", f.label),
          h("span", "dash-dates", f.findings.map((x, i) => [i ? "; " : "", `${x.display}${x.code ? ` (${x.code})` : ""}, `, eventLink(ctx, x, formatDay(x.date, { short: true }))])))))
      : h("p", "dash-empty", "None in the coded diagnoses."));
  const exposure = h("div", null,
    h("p", "dash-subtitle", "Exposure context"),
    L.context
      ? h("div", null,
        h("p", `dash-exposure band-${L.context.band}`, h("strong", null, `${L.context.incidence}`), " reported cases per 100,000 people per year"),
        h("p", null, `${L.context.county ? `${L.context.county}, ${L.context.state}` : `${L.context.state} (state average; county not on file)`}. `,
          citationLink("CDC surveillance, 2015 to 2019", LYME_SURVEILLANCE_URL), `; a ${L.context.band}-incidence area.`),
        h("p", "dash-cite", "This describes the place, not the patient."))
      : h("p", "dash-empty", "No address on file, so there is no exposure context."),
    lymeExposureLine(model.questionnaire)
      ? h("p", null, h("strong", null, "From the patient: "), `${lymeExposureLine(model.questionnaire)}.`)
      : null);
  return section("Criteria to check", features, exposure);
}

function lymeGuidanceCite() {
  return h("p", "dash-cite", "CDC: ",
    citationLink("Clinical Testing and Diagnosis for Lyme Disease", LYME_TESTING_URL), ", and ",
    citationLink("Clinical Treatment of Erythema Migrans Rash", LYME_TREATMENT_URL), ".");
}

function lupusCriteria(ctx, model) {
  const sig = model.lupus.signal;
  return section("Criteria to check",
    sig.priorityFindings.length ? h("div", null, h("p", "dash-subtitle", "Priority findings"), h("ul", "dash-plain", sig.priorityFindings.map((f) => h("li", null, f)))) : null,
    h("p", "dash-subtitle", "2019 EULAR/ACR criteria with chart evidence"),
    model.lupus.found.length
      ? h("ul", "dash-findings stacked", model.lupus.found.map((c) =>
        h("li", null, h("span", "dash-finding-label", `${c.label} (${c.domain}, ${c.weight} points)`),
          h("span", "dash-dates", `${c.state === "met" ? "Documented" : "Needs confirmation"}${c.evidence[0]?.date ? `, ${formatDay(c.evidence[0].date, { short: true })}` : ""}`))))
      : h("p", "dash-empty", linkedText("No 2019 EULAR/ACR criteria found in the structured chart data.")),
    h("p", "dash-context", `ANA entry criterion: ${sig.ana.label}.`),
    sig.gaps.length ? h("div", null, h("p", "dash-subtitle", "Not in the chart yet"), h("ul", "dash-plain", sig.gaps.map((g) => h("li", null, g)))) : null,
  );
}

function lupusRuleCite() {
  return h("p", "dash-cite", "Criteria with chart evidence: a rule-based approximation of the ",
    citationLink("2019 EULAR/ACR classification criteria", LUPUS_CRITERIA_URL),
    ", applied to structured chart data. Its outputs have not been reviewed by a rheumatologist.");
}

// Timeline strip: an SVG built with DOM APIs (no chart library, no inline styles).
function renderTimelinePanel(ctx, model) {
  const T = model.timeline;
  const out = [];
  out.push(h("p", "dash-panel-explain", "Every dated visit, diagnosis, test, and prescription in the chart. The finding dates in the condition tabs link here."));
  const day = (iso) => Date.parse(`${iso}T00:00:00Z`) / 86400000;
  const pad = Math.max(20, (day(T.end) - day(T.start)) * 0.03);
  const t0 = day(T.start) - pad, t1 = day(T.end) + pad;
  const W = 1000, left = 110, right = 16, laneH = 34;
  const x = (iso) => left + ((day(iso) - t0) / (t1 - t0)) * (W - left - right);
  // marker labels: greedy rows so they never overlap
  const rowsEnd = [];
  const placed = T.markers.map((m) => {
    const text = `${m.label}, ${formatDay(m.date, { short: true })}`;
    const width = text.length * 6.4 + 8;
    const xx = x(m.date);
    const anchor = xx + width > W - right ? "end" : "start";
    const [a, b] = anchor === "end" ? [xx - width, xx] : [xx, xx + width];
    let row = rowsEnd.findIndex((end) => end < a);
    if (row === -1) row = rowsEnd.length;
    rowsEnd[row] = b;
    return { m, text, xx, anchor, row };
  });
  const top = 22 + rowsEnd.length * 13;
  const H = top + LANES.length * laneH + 34;
  const svg = s("svg", { class: "dash-tl-svg", viewBox: `0 0 ${W} ${H}`, role: "group", "aria-label": `Chart timeline from ${formatDay(T.start)} to ${formatDay(T.end)}` });
  LANES.forEach((lane, i) => {
    const y = top + i * laneH + laneH / 2;
    svg.append(s("line", { class: "dash-tl-lane", x1: left, x2: W - right, y1: y, y2: y }));
    svg.append(s("text", { class: "dash-tl-lanelabel", x: 8, y: y + 4 }, lane.label));
  });
  // year ticks (or quarters when the span is short)
  const y0 = Number(T.start.slice(0, 4)), y1 = Number(T.end.slice(0, 4)) + 1;
  const short = day(T.end) - day(T.start) < 700;
  for (let yr = y0; yr <= y1; yr += 1) {
    for (const mo of short ? ["01", "04", "07", "10"] : ["01"]) {
      const iso = `${yr}-${mo}-01`;
      if (day(iso) < t0 || day(iso) > t1) continue;
      const xx = x(iso);
      svg.append(s("line", { class: mo === "01" ? "dash-tl-tick" : "dash-tl-tick minor", x1: xx, x2: xx, y1: top - 6, y2: H - 26 }));
      svg.append(s("text", { class: "dash-tl-ticklabel", x: xx + 3, y: H - 10 }, mo === "01" ? String(yr) : MONTHS[Number(mo) - 1].slice(0, 3)));
    }
  }
  for (const { m, text, xx, anchor, row } of placed) {
    const ly = 16 + row * 13;
    svg.append(s("line", { class: `dash-tl-marker m-${m.id}`, x1: xx, x2: xx, y1: ly + 3, y2: H - 26 }));
    svg.append(s("text", { class: `dash-tl-markerlabel m-${m.id}`, x: anchor === "end" ? xx - 4 : xx + 4, y: ly, "text-anchor": anchor }, text));
  }
  const groups = new Map();
  for (const e of T.events) {
    const k = `${e.date}|${e.lane}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(e);
  }
  ctx.marks = new Map();
  for (const [k, list] of groups) {
    const [date, laneId] = k.split("|");
    const i = LANES.findIndex((l) => l.id === laneId);
    const cy = top + i * laneH + laneH / 2;
    const cited = list.some((e) => e.citedBy.length);
    const a = s("a", { href: `#${domId(list[0].id)}`, class: `dash-tl-mark lane-${laneId}${cited ? " cited" : ""}` },
      s("title", {}, `${formatDay(date)}: ${list.map((e) => e.text).join("; ")}`),
      s("circle", { cx: x(date), cy, r: list.length > 1 ? 8 : 6 }),
      list.length > 1 ? s("text", { class: "dash-tl-count", x: x(date), y: cy + 3.5, "text-anchor": "middle" }, String(list.length)) : null,
    );
    a.addEventListener("click", (ev) => {
      ev.preventDefault();
      ctx.showEvent(list[0].id);
    });
    for (const e of list) ctx.marks.set(e.id, a);
    svg.append(a);
  }
  out.push(h("div", { class: "dash-tl-scroll", tabindex: "0", role: "region", "aria-label": "Timeline strip; scroll sideways on small screens" }, svg));
  out.push(h("p", "dash-legend",
    h("span", "dash-key cited", "Cited by a card"), h("span", "dash-key", "Other chart event"),
    h("span", "dash-key m-asof", "Scoring date"),
    T.markers.some((m) => m.id === "covid") ? h("span", "dash-key m-covid", "COVID-19 index and day 90") : null,
  ));
  // list below the strip, grouped by date, markers in place
  const rows = [...T.events.map((e) => ({ kind: "event", ...e })), ...T.markers.map((m) => ({ kind: "marker", ...m }))]
    .sort((a, b) => a.date.localeCompare(b.date) || (a.kind === "marker" ? -1 : 1) - (b.kind === "marker" ? -1 : 1));
  const list = h("ol", "dash-tl-list");
  let current = null;
  let bucket = null;
  for (const r of rows) {
    if (r.kind === "marker") {
      list.append(h("li", `dash-tl-row marker m-${r.id}`, h("span", "dash-tl-date", formatDay(r.date, { short: true })), h("span", "dash-tl-what", h("strong", null, r.label))));
      current = null;
      continue;
    }
    if (r.date !== current) {
      current = r.date;
      bucket = h("ul", "dash-tl-items");
      list.append(h("li", "dash-tl-row", h("span", "dash-tl-date", formatDay(r.date, { short: true })), bucket));
    }
    const lane = LANES.find((l) => l.id === r.lane);
    bucket.append(h("li", { id: r.id ? domId(r.id) : null, tabindex: "-1", class: r.citedBy.length ? "cited" : null },
      h("span", `dash-tl-kind lane-${r.lane}`, lane.one),
      ` ${r.text}`,
      r.citedBy.length ? h("span", "dash-tl-cited", `Cited by ${r.citedBy.join(", ")}`) : null,
    ));
  }
  out.push(list);
  return out;
}

/**
 * Render the per-patient dashboard into `container`.
 * opts: { bundle, record?, models, lyme, asOf, questionnaire?, source?: {label}, synthetic?, shortName?, collapsePatientResponses?,
 *         tab?, onTabChange?(slug), onLoadDemo?(), onRemove?(), onAttach?(qr, source), emptyPatientText?,
 *         pending?: { qr, source, onDismiss?() } (answers without a patient identity, shown with a confirm button),
 *         headerSlot?: Element (patient line goes there instead of the top of the container) }
 */
export function renderDashboard(container, opts) {
  let questionnaire = opts.questionnaire || null;
  let source = opts.source || null;
  let currentTab = opts.tab || null;
  let pending = opts.pending || null;

  const draw = () => {
    const model = buildDashboard({ ...opts, questionnaire });
    const ctx = { models: opts.models, marks: new Map(), patientId: model.patient.id };
    const tabs = new Map();
    const panels = new Map();

    ctx.selectTab = (slug, { focus = false, scroll = false, silent = false } = {}) => {
      if (!tabs.has(slug)) return;
      currentTab = slug;
      for (const [k, t] of tabs) {
        const on = k === slug;
        t.setAttribute("aria-selected", String(on));
        t.tabIndex = on ? 0 : -1;
        panels.get(k).hidden = !on;
      }
      if (focus) tabs.get(slug).focus({ preventScroll: true });
      if (scroll) tabs.get(slug).closest(".dash-tabs-block").scrollIntoView({ block: "start", behavior: "smooth" });
      tabs.get(slug).scrollIntoView({ block: "nearest", inline: "nearest" });
      if (slug === "timeline") {
        // on narrow screens the strip scrolls sideways; start at the most recent events
        const strip = panels.get(slug).querySelector(".dash-tl-scroll");
        if (strip) strip.scrollLeft = strip.scrollWidth;
      }
      if (!silent && opts.onTabChange) opts.onTabChange(slug);
    };
    ctx.showEvent = (id) => {
      ctx.selectTab("timeline");
      for (const n of container.querySelectorAll(".is-target")) n.classList.remove("is-target");
      const row = id ? container.querySelector(`#${domId(id)}`) : null;
      const mark = ctx.marks.get(id);
      if (mark) mark.classList.add("is-target");
      if (row) {
        row.classList.add("is-target");
        row.focus({ preventScroll: true });
        row.scrollIntoView({ block: "center", behavior: "smooth" });
      }
    };
    const attach = (qr, src) => {
      if (opts.onAttach) opts.onAttach(qr, src);
      else {
        questionnaire = qr;
        source = src;
        draw();
      }
    };
    ctx.attachFile = (qr) => attach(qr, { kind: "file", label: "Added from a file" });
    ctx.offer = (qr, src) => {
      pending = { qr, source: src };
      draw();
    };
    ctx.confirmPending = () => {
      const p = pending;
      pending = null;
      if (p) attach(p.qr, p.source);
    };
    ctx.dismissPending = () => {
      const p = pending;
      pending = null;
      if (p?.onDismiss) p.onDismiss();
      draw();
    };

    container.replaceChildren();
    container.classList.add("dash");
    const serious = seriousItems(model.items);
    const line = renderPatientLine(model, { synthetic: Boolean(opts.synthetic), shortName: Boolean(opts.shortName), canPrint: Boolean(serious.length) });
    if (opts.headerSlot) opts.headerSlot.replaceChildren(line);
    else container.append(line);
    const panelOpts = {
      ...opts,
      pending,
      source,
      onRemove: opts.onRemove || (source?.kind === "file" ? () => { questionnaire = null; source = null; draw(); } : null),
    };
    container.append(h("div", "dash-overview", renderOverview(ctx, model), renderPatientPanel(ctx, model, panelOpts)));

    const flag = new Map(model.items.map((i) => [i.slug, i.review ? (i.kind === "model" ? bandClass(i.band) : "band-rule") : null]));
    const tablist = h("div", { role: "tablist", class: "dash-tabs", "aria-label": "Condition details" });
    const block = h("section", { class: "dash-tabs-block", "aria-label": "Condition details" }, h("div", "dash-tabs-scroll", tablist));
    for (const t of TABS) {
      const tab = h("button", {
        type: "button",
        role: "tab",
        id: `dash-tab-${t.slug}`,
        "aria-controls": `dash-panel-${t.slug}`,
        "aria-selected": "false",
        tabindex: "-1",
        class: "dash-tab",
        onclick: () => ctx.selectTab(t.slug),
      }, t.label, flag.get(t.slug) ? h("span", { class: `dash-dot ${flag.get(t.slug)}`, "aria-hidden": "true" }) : null);
      if (flag.get(t.slug)) tab.setAttribute("aria-description", "Needs review");
      tablist.append(tab);
      tabs.set(t.slug, tab);
      const panel = h("div", { role: "tabpanel", id: `dash-panel-${t.slug}`, "aria-labelledby": `dash-tab-${t.slug}`, tabindex: "0", class: "dash-panel", hidden: true });
      panels.set(t.slug, panel);
      block.append(panel);
    }
    tablist.addEventListener("keydown", (e) => {
      const order = TABS.map((t) => t.slug);
      const i = order.indexOf(currentTab);
      const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: order.length - 1 }[e.key];
      if (next === undefined) return;
      e.preventDefault();
      ctx.selectTab(order[(next + order.length) % order.length], { focus: true });
    });
    container.append(block);

    for (const entry of model.scores) panels.get(entry.card.slug).append(...renderModelPanel(ctx, model, entry));
    panels.get("timeline").append(...renderTimelinePanel(ctx, model));
    container.append(renderPrintReport(model, panels));

    const initial = tabs.has(currentTab) ? currentTab : model.needsReview[0]?.slug || "longcovid";
    ctx.selectTab(initial, { silent: true });
    api.selectTab = (slug, o) => ctx.selectTab(slug, { silent: true, ...o });
    api.model = model;
  };

  const api = {
    selectTab: () => {},
    model: null,
    get tab() {
      return currentTab;
    },
  };
  draw();
  return api;
}

/** Former name, kept for callers of the earlier card grid. */
export const renderConditionCards = renderDashboard;
