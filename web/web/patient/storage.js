// Answers live only in this browser's localStorage. Nothing is sent anywhere.

import { HANDOFF_KEY } from "../shared/demo-answers.js";

export const KEY = "unm-patient-v1";
export const PERSONAL_KEY = "unm-patient-personal-v1";
export const TRIALS_KEY = "unm-patient-trials-v1";

export function emptyState() {
  return {
    version: 1,
    respondent: "",
    timeline: { onset: "", covid: "", covidDate: "", symptoms: "" },
    recover: {},
    pem: {},
    pemDuration: "",
    pcfs: null,
    change: {},
    checks: emptyChecks(),
    step: 0,
    finished: false,
    demo: null,
    answeredOn: "",
    persona: null,
    questions: null,
    removedFindings: [],
    include: { timeline: true, recover: true, pem: true, pcfs: true, change: true, checks: true, findings: true, questions: true },
  };
}

/** Part E self-checks: which ones the person chose, and the answers to each. */
export function emptyChecks() {
  return { chosen: {}, longcovid: {}, mecfs: {}, fibro: { areas: {}, severity: {}, sixMonths: {} }, lyme: {}, phq9: {}, gad7: {} };
}

function mergeChecks(saved = {}) {
  const base = emptyChecks();
  const fibro = saved.fibro || {};
  return {
    ...base,
    ...saved,
    chosen: { ...(saved.chosen || {}) },
    fibro: { ...base.fibro, ...fibro, areas: { ...(fibro.areas || {}) }, severity: { ...(fibro.severity || {}) }, sixMonths: { ...(fibro.sixMonths || {}) } },
  };
}

function storage() {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}

function loadKey(key) {
  const base = emptyState();
  try {
    const raw = storage()?.getItem(key);
    if (!raw) return null;
    const saved = JSON.parse(raw);
    return {
      ...base,
      ...saved,
      timeline: { ...base.timeline, ...(saved.timeline || {}) },
      checks: mergeChecks(saved.checks),
      include: { ...base.include, ...(saved.include || {}) },
    };
  } catch {
    return null;
  }
}

export function load() {
  return loadKey(KEY) || emptyState();
}

/** Personal answers stay separate from the synthetic demo; older personal drafts migrate on read. */
export function loadPersonal() {
  const personal = loadKey(PERSONAL_KEY);
  if (personal && !personal.demo) return personal;
  const legacy = loadKey(KEY);
  return legacy && !legacy.demo ? legacy : emptyState();
}

export function save(state) {
  try {
    storage().setItem(KEY, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}

export function savePersonal(state) {
  try {
    storage().setItem(PERSONAL_KEY, JSON.stringify({ ...state, demo: null, persona: null }));
    return true;
  } catch {
    return false;
  }
}

export function loadTrials() {
  try {
    return JSON.parse(storage().getItem(TRIALS_KEY) || "null");
  } catch {
    return null;
  }
}

export function saveTrials(value) {
  try {
    storage().setItem(TRIALS_KEY, JSON.stringify(value));
  } catch {
    /* storage full or blocked: the search still works */
  }
}

/** Remove every answer, saved study search, and demo hand-off from this browser. */
export function clearAll(store = storage()) {
  for (const k of [KEY, PERSONAL_KEY, TRIALS_KEY, HANDOFF_KEY]) {
    try {
      store.removeItem(k);
    } catch {
      /* nothing stored, or storage blocked */
    }
  }
}
