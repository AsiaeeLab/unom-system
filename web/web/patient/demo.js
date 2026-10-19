// Pure helpers for the demo flow: made-up answers, start over, and the
// in-browser hand-off to the clinician view. No DOM access here, so node:test
// can import it directly.

import { DEMO_ANSWERS, HANDOFF_KEY } from "../shared/demo-answers.js";
import { buildQuestionnaireResponse } from "./scoring.js";
import { emptyState } from "./storage.js";

export { DEMO_ANSWERS, HANDOFF_KEY };

/** Shareable questionnaire fragments: #maria/qp-3 in the demo or #qp-3 alone. */
export function parsePatientRoute(hash) {
  const match = /^#(?:(\w+)\/)?qp-([1-9]\d*)$/u.exec(String(hash || ""));
  const persona = match && Object.hasOwn(DEMO_ANSWERS, match[1]) ? match[1] : null;
  return { persona, page: match && (!match[1] || persona) ? Number(match[2]) : null };
}

/** Saved app state for one demo person's made-up answers, ready to save. */
export function demoState(id) {
  const answers = DEMO_ANSWERS[id];
  if (!answers) return null;
  const base = emptyState();
  const copy = JSON.parse(JSON.stringify(answers));
  return {
    ...base,
    ...copy,
    timeline: { ...base.timeline, ...(copy.timeline || {}) },
    checks: { ...base.checks, ...(copy.checks || {}), fibro: { ...base.checks.fibro, ...((copy.checks || {}).fibro || {}) } },
    include: { ...base.include },
    step: 0,
    finished: true,
    demo: id,
    persona: null,
    removedFindings: [],
  };
}

/**
 * State to use when someone explicitly starts the symptom check from the
 * navigation. Demo answers are examples, not a draft questionnaire: discard
 * them and begin with a clean form. A person's own saved draft is returned
 * unchanged so navigating away and back never loses their work.
 */
export function stateForManualSymptomCheck(state = {}) {
  return state.demo ? emptyState() : state;
}

/** True when the URL asks to clear saved answers: ?reset or ?reset=1. */
export function wantsReset(href) {
  try {
    const u = new URL(href, "https://example.invalid/");
    return u.searchParams.has("reset");
  } catch {
    return false;
  }
}

/** The same URL (path, query, hash) with the reset request removed. */
export function withoutReset(href) {
  const u = new URL(href, "https://example.invalid/");
  u.searchParams.delete("reset");
  return `${u.pathname}${u.search}${u.hash}`;
}

/** The sections the person left checked; record findings are never exported. */
export function exportInclude(state = {}) {
  const include = { ...(state.include || {}) };
  delete include.findings;
  return include;
}

/** Demo person whose record or answers are loaded, or null. */
export function currentPersona(state = {}) {
  if (state.persona && state.persona.id) return state.persona.id;
  return state.demo || null;
}

/**
 * What "Send to my clinician (demo)" stores in this browser for the
 * clinician view to read. In a real deployment the same FHIR
 * QuestionnaireResponse would travel through the health record.
 */
export function handoffPayload(state = {}, { now = new Date() } = {}) {
  const sentAt = now.toISOString();
  return {
    // authored = the day the answers were given (for demo people, their made-up answer date), not the send time
    questionnaire: buildQuestionnaireResponse(state, {
      authored: /^\d{4}-\d{2}-\d{2}$/u.test(state.answeredOn || "") ? `${state.answeredOn}T12:00:00Z` : sentAt,
      include: exportInclude(state),
    }),
    persona: currentPersona(state),
    sentAt,
  };
}

/** Where the clinician view opens for this hand-off. */
export function clinicianUrl(payload) {
  const id = payload && payload.persona && DEMO_ANSWERS[payload.persona] ? payload.persona : "elena";
  return `/clinician/#${id}`;
}

/** Write the hand-off to storage. Returns false if the browser blocks it. */
export function writeHandoff(store, payload) {
  try {
    store.setItem(HANDOFF_KEY, JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}
