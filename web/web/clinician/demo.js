// Clinician demo: the SMART app's per-patient dashboard on synthetic FHIR bundles. No login, no network calls
// beyond this site. The patient app can hand its answers over in this browser (localStorage, HANDOFF_KEY).

import { bundleToRecord, checkQuestionnaire, loadLyme, loadModels, renderDashboard, TABS } from "../athena/cards.js";
import { buildQuestionnaireResponse } from "../patient/scoring.js";
import { DEMO_ANSWERS, HANDOFF_KEY } from "../shared/demo-answers.js";

export { bundleToRecord };

export const AS_OF = "2024-06-01";
export const PATIENTS = Object.freeze([
  { id: "maria", name: "Maria", blurb: "COVID-19, then new symptoms" },
  { id: "elena", name: "Elena", blurb: "Years of fatigue and dizziness" },
  { id: "sofia", name: "Sofia", blurb: "Years of widespread pain" },
  { id: "dana", name: "Dana", blurb: "Knee pain, facial weakness" },
]);

const isPersona = (id) => PATIENTS.some((p) => p.id === id);

/** Only a named demo patient and one of its visible dashboard tabs can be addressed. */
export function parseRoute(hash) {
  const match = /^#([a-z]+)(?:\/([a-z]+))?$/u.exec(String(hash || ""));
  const persona = match && isPersona(match[1]) ? match[1] : null;
  return {
    persona,
    tab: persona && TABS.some((t) => t.slug === match[2]) ? match[2] : null,
  };
}

/**
 * Read the patient app's hand-off: the raw localStorage string -> { questionnaire, persona, sentAt } or null.
 * The questionnaire must answer our questionnaire in a supported version (checkQuestionnaire); persona is kept
 * only when it names a demo patient.
 */
export function parseHandoff(raw) {
  if (typeof raw !== "string" || !raw) return null;
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  const qr = value?.questionnaire;
  if (!checkQuestionnaire(qr).ok) return null;
  const sentAt = typeof value.sentAt === "string" && !Number.isNaN(Date.parse(value.sentAt)) ? value.sentAt : null;
  return { questionnaire: qr, persona: isPersona(value.persona) ? value.persona : null, sentAt };
}

/**
 * What to do with a hand-off for the open demo patient: "attach" when it names this patient (the demo person
 * whose record the patient app loaded) and its subject, if any, matches; "confirm" when it names no one (the
 * clinician must confirm the patient first); null when it belongs to someone else.
 */
export function handoffAction(handoff, persona) {
  if (!handoff) return null;
  if (!checkQuestionnaire(handoff.questionnaire, { patientId: persona }).ok) return null;
  if (handoff.persona === persona) return "attach";
  return handoff.persona === null ? "confirm" : null;
}

/** "2026-10-04T15:12:00Z" -> "October 4, 2026, 3:12 PM" in the viewer's time zone. */
export function formatSentAt(iso, timeZone) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  return new Intl.DateTimeFormat("en-US", { dateStyle: "long", timeStyle: "short", ...(timeZone ? { timeZone } : {}) }).format(new Date(t));
}

/** The demo answers for one patient as the QuestionnaireResponse the patient app would send. */
export function demoQuestionnaire(persona) {
  const state = DEMO_ANSWERS[persona];
  if (!state) return null;
  return buildQuestionnaireResponse(state, { authored: `${state.answeredOn || AS_OF}T12:00:00Z` });
}

/** Completed synthetic patient responses shown when the clinician demo first opens. */
export function defaultDemoResponses() {
  return new Map(PATIENTS.map((p) => [
    p.id,
    { qr: demoQuestionnaire(p.id), source: { kind: "demo", label: "Completed synthetic responses" } },
  ]));
}

// ---------------------------------------------------------------- page

function storage() {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}

function readHandoff() {
  try {
    return parseHandoff(storage()?.getItem(HANDOFF_KEY) || "");
  } catch {
    return null;
  }
}

function removeHandoff() {
  try {
    storage()?.removeItem(HANDOFF_KEY);
  } catch {
    /* storage blocked: nothing to remove */
  }
}

const $ = (id) => document.getElementById(id);
const DEMO_LOAD_MS = 0;

function setFrameLoading() {
  const frame = document.querySelector(".demo-frame");
  frame.classList.add("is-loading");
  frame.setAttribute("aria-busy", "true");
  $("demo-frame-loader-text").textContent = "Opening the chart…";
  $("demo-frame-loader").hidden = false;
}

function clearFrameLoading() {
  const frame = document.querySelector(".demo-frame");
  frame.classList.remove("is-loading");
  frame.setAttribute("aria-busy", "false");
  $("demo-frame-loader").hidden = true;
}

function waitForDemoLoad(startedAt) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, DEMO_LOAD_MS - (performance.now() - startedAt))));
}

async function main() {
  const start = parseRoute(location.hash);
  let handoff = readHandoff();
  const first = start.persona || handoff?.persona || "maria";
  const initialLoadStarted = performance.now();
  setFrameLoading();
  const [models, lyme] = await Promise.all([loadModels(), loadLyme()]);
  const bundles = new Map();
  const attached = defaultDemoResponses(); // persona -> { qr, source }
  let current = null;
  let view = null;
  let showToken = 0;

  const handoffSource = () => ({ kind: "handoff", label: `Sent from the patient app${handoff?.sentAt ? `, ${formatSentAt(handoff.sentAt)}` : ""}` });
  if (handoffAction(handoff, first) === "attach") attached.set(first, { qr: handoff.questionnaire, source: handoffSource() });

  const picker = $("demo-patients");
  for (const p of PATIENTS) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "demo-patient-button";
    button.dataset.id = p.id;
    button.setAttribute("aria-pressed", "false");
    const name = document.createElement("strong");
    name.textContent = p.name;
    const blurb = document.createElement("span");
    blurb.textContent = p.blurb;
    button.append(name, blurb);
    button.addEventListener("click", () => show(p.id, null));
    picker.append(button);
  }

  async function show(id, tab, { startedAt = performance.now(), minDelay = true } = {}) {
    const token = ++showToken;
    setFrameLoading();
    for (const b of picker.querySelectorAll(".demo-patient-button")) b.setAttribute("aria-pressed", String(b.dataset.id === id));
    let bundle;
    try {
      if (!bundles.has(id)) {
        const response = await fetch(`/data/patients/${id}.json`);
        if (!response.ok) throw new Error("Demo patient unavailable");
        bundles.set(id, await response.json());
      }
      if (minDelay) await waitForDemoLoad(startedAt);
      if (token !== showToken) return;
      bundle = bundles.get(id);
    } catch {
      if (token === showToken) {
        $("dashboard").textContent = "The demo could not load. Reload the page to try again.";
        clearFrameLoading();
      }
      return;
    }
    current = id;
    const a = attached.get(id) || null;
    // an anonymous hand-off waits on whichever patient is open until the clinician adds it or turns it down
    const pending = handoffAction(handoff, id) === "confirm"
      ? { qr: handoff.questionnaire, source: handoffSource(), onDismiss: () => { removeHandoff(); handoff = null; } }
      : null;
    try {
      view = renderDashboard($("dashboard"), {
        bundle,
        record: bundleToRecord(bundle),
        models,
        lyme,
        asOf: AS_OF,
        questionnaire: a?.qr || null,
        source: a?.source || null,
        pending,
        synthetic: false,
        shortName: false,
        collapsePatientResponses: true,
        tab,
        emptyPatientText: "No answers from the patient app yet. In the demo, send them from the patient app or load the demo answers.",
        onTabChange: (slug) => history.replaceState(null, "", `#${id}/${slug}`),
        onLoadDemo: DEMO_ANSWERS[id]
          ? () => {
            attached.set(id, { qr: demoQuestionnaire(id), source: { kind: "demo", label: "Completed synthetic responses" } });
            show(id, view?.tab, { minDelay: false });
          }
          : null,
        onRemove: a
          ? () => {
            if (a.source.kind === "handoff") removeHandoff();
            attached.delete(id);
            show(id, view?.tab, { minDelay: false });
          }
          : null,
        onAttach: (qr, source) => {
          attached.set(id, { qr, source });
          if (source.kind === "handoff") handoff = null; // added to this patient; no longer offered to others
          show(id, view?.tab, { minDelay: false });
        },
      });
      history.replaceState(null, "", `#${id}/${view.tab}`);
    } catch {
      $("dashboard").textContent = "The demo could not load. Reload the page to try again.";
    } finally {
      if (token === showToken) clearFrameLoading();
    }
  }

  window.addEventListener("hashchange", () => {
    const r = parseRoute(location.hash);
    if (r.persona && r.persona !== current) show(r.persona, r.tab);
    else if (r.tab && view) view.selectTab(r.tab, { focus: false });
    else if (current && view && location.hash !== `#${current}/${view.tab}`) history.replaceState(null, "", `#${current}/${view.tab}`);
  });
  await show(first, start.tab, { startedAt: initialLoadStarted });
}

if (typeof document !== "undefined") {
  main().catch(() => {
    clearFrameLoading();
    const target = document.getElementById("dashboard");
    if (target) target.textContent = "The demo could not load. Reload the page to try again.";
  });
}
