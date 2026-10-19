// Language support for the patient app: English (the default) and Spanish.
// Every user-visible string has an id in strings-en.js and strings-es.js; the translator from setLanguage()
// (app.js calls it t) returns it with {name} placeholders filled. Plurals use "<id>.one" and "<id>.other".
// Scores, codes, saved answers, and the FHIR QuestionnaireResponse do not depend on the language: the
// response is always built in English for the clinician, and text the app wrote into the saved state (demo
// answers, suggested questions) stays in English there and is translated only when shown.
// No DOM access at import time, so node:test can import this module.

import { EN } from "./strings-en.js";
import { ES } from "./strings-es.js";
import { RECORD_TERMS_ES } from "./record-terms-es.js";
import { CHANGE, CHECKS, PCFS, PEM, RECOVER } from "./instruments.js";
import { DEMO_ANSWERS } from "../shared/demo-answers.js";

export const LANG_KEY = "unom.lang";
export const LANGS = Object.freeze(["en", "es"]);
export const TABLES = Object.freeze({ en: EN, es: ES });
const HTML_LANG = { en: "en", es: "es" };

const isLang = (v) => LANGS.includes(v);

/** Language from the address (?lang=es or ?lang=en wins), then the saved choice, then English. */
export function resolveLang(href, stored) {
  let fromUrl = null;
  try {
    fromUrl = new URL(String(href || ""), "https://example.invalid/").searchParams.get("lang");
  } catch {
    fromUrl = null;
  }
  if (isLang(fromUrl)) return fromUrl;
  return isLang(stored) ? stored : "en";
}

/** The saved choice, or null when nothing is saved or storage is blocked. */
export function readStoredLang(store) {
  try {
    const v = store ? store.getItem(LANG_KEY) : null;
    return isLang(v) ? v : null;
  } catch {
    return null;
  }
}

/** Save the choice; returns false when the browser blocks storage (the page still works). */
export function rememberLang(store, lang) {
  try {
    if (!store || !isLang(lang)) return false;
    store.setItem(LANG_KEY, lang);
    return true;
  } catch {
    return false;
  }
}

function fill(s, params) {
  if (!params) return s;
  return s.replace(/\{(\w+)\}/gu, (m, k) => (k in params ? String(params[k]) : m));
}

const MONTHS = {
  en: ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"],
  es: ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"],
};

/** "2024-02-20" -> "February 20, 2024" or "20 de febrero de 2024". Returns "" for anything else. */
export function formatDateIn(iso, lang = "en") {
  const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?/u.exec(String(iso || ""));
  if (!m) return "";
  const month = (MONTHS[lang] || MONTHS.en)[Number(m[2]) - 1];
  if (!month) return "";
  if (lang === "es") return m[3] ? `${Number(m[3])} de ${month} de ${m[1]}` : `${month} de ${m[1]}`;
  return m[3] ? `${month} ${Number(m[3])}, ${m[1]}` : `${month} ${m[1]}`;
}

/** "1, 3, and 5" in English (serial comma), "1, 3 y 5" in Spanish. */
export function listAnd(items, lang = "en") {
  const xs = [...items].map(String);
  const and = lang === "es" ? "y" : "and";
  if (xs.length <= 1) return xs.join("");
  if (xs.length === 2) return `${xs[0]} ${and} ${xs[1]}`;
  return `${xs.slice(0, -1).join(", ")}${lang === "es" ? "" : ","} ${and} ${xs[xs.length - 1]}`;
}

/**
 * A translator for one language: t(id, params), t.n(id, count, params) for plurals, t.date(iso),
 * t.list(items), and t.lang. A missing id falls back to English, then to the id itself.
 */
export function translator(lang = "en") {
  const code = isLang(lang) ? lang : "en";
  const table = TABLES[code];
  const t = (id, params) => {
    const s = id in table ? table[id] : id in EN ? EN[id] : id;
    return fill(s, params);
  };
  t.lang = code;
  t.en = (id, params) => fill(id in EN ? EN[id] : id, params);
  t.n = (id, n, params) => t(`${id}.${n === 1 ? "one" : "other"}`, { n, ...params });
  t.date = (iso) => formatDateIn(iso, code);
  t.list = (items) => listAnd(items, code);
  t.has = (id) => id in table;
  return t;
}

export const EN_T = translator("en");

// The language the page is showing, set once by app.js before anything renders.
let current = EN_T;
export function setLanguage(lang) {
  current = translator(lang);
  if (typeof document !== "undefined" && document.documentElement) document.documentElement.lang = HTML_LANG[current.lang];
  return current;
}
export function currentLang() {
  return current.lang;
}

// ---------- rich text: [label](href) links and *emphasis* inside one string ----------

/** Split a string into text, link, and emphasis parts. Markup: [label](href) and *text*. */
export function richParts(s) {
  const out = [];
  const re = /\[([^\]]+)\]\(([^)\s]+)\)|\*([^*]+)\*/gu;
  let last = 0;
  for (const m of String(s || "").matchAll(re)) {
    if (m.index > last) out.push({ type: "text", text: s.slice(last, m.index) });
    if (m[1] !== undefined) out.push({ type: "link", text: m[1], href: m[2] });
    else out.push({ type: "em", text: m[3] });
    last = m.index + m[0].length;
  }
  if (last < String(s || "").length) out.push({ type: "text", text: String(s).slice(last) });
  return out;
}

/** The plain text of a rich string (markup removed). */
export function plainText(s) {
  return richParts(s).map((p) => p.text).join("");
}

/** DOM nodes for a rich string. External links open in a new tab. */
export function richNodes(s, doc = globalThis.document) {
  return richParts(s).map((p) => {
    if (p.type === "text") return doc.createTextNode(p.text);
    const el = doc.createElement(p.type === "link" ? "a" : "em");
    if (p.type === "link") {
      el.setAttribute("href", p.href);
      if (/^https?:/u.test(p.href)) {
        el.setAttribute("target", "_blank");
        el.setAttribute("rel", "noreferrer");
      }
    }
    el.textContent = p.text;
    return el;
  });
}

/**
 * Translate the static page: data-i18n (text), data-i18n-rich (text with links), and
 * data-i18n-attr="aria-label=id;title=id" (attributes). An element whose string is empty in this
 * language is hidden (used for notes that exist in one language only).
 */
export function applyStatic(root, tt = current) {
  const doc = root.ownerDocument || globalThis.document;
  for (const el of root.querySelectorAll("[data-i18n]")) el.textContent = tt(el.getAttribute("data-i18n"));
  for (const el of root.querySelectorAll("[data-i18n-rich]")) {
    const s = tt(el.getAttribute("data-i18n-rich"));
    el.replaceChildren(...richNodes(s, doc));
    el.hidden = s === "";
  }
  for (const el of root.querySelectorAll("[data-i18n-attr]")) {
    for (const pair of el.getAttribute("data-i18n-attr").split(";")) {
      const [attr, id] = pair.split("=").map((x) => x.trim());
      if (attr && id) el.setAttribute(attr, tt(id));
    }
  }
}

// ---------- instruments in the current language ----------

/**
 * The instrument definitions with their wording in one language. Ids, codes, values, points, and
 * regions are the canonical ones from instruments.js, so scores never depend on the language.
 */
export function localInstruments(tt = current) {
  if (tt.lang === "en") return { RECOVER, PEM, PCFS, CHANGE, CHECKS };
  const x = (id) => tt(id);
  return {
    RECOVER: {
      ...RECOVER,
      title: x("recover.title"),
      stem: x("recover.stem"),
      severityNote: x("recover.severityNote"),
      items: RECOVER.items.map((it) => ({ ...it, name: x(`recover.item.${it.id}.name`), text: x(`recover.item.${it.id}.text`), help: it.help ? x(`recover.item.${it.id}.help`) : "" })),
    },
    PEM: {
      ...PEM,
      title: x("pem.title"),
      instruction: x("pem.instruction"),
      frequencyQuestion: x("pem.frequencyQuestion"),
      severityQuestion: x("pem.severityQuestion"),
      frequency: PEM.frequency.map((o) => ({ ...o, label: x(`pem.frequency.${o.value}`) })),
      severity: PEM.severity.map((o) => ({ ...o, label: x(`pem.severity.${o.value}`) })),
      items: PEM.items.map((it) => ({ ...it, text: x(`pem.item.${it.n}`) })),
      duration: {
        ...PEM.duration,
        question: x("pem.duration.question"),
        options: PEM.duration.options.map((o) => ({ ...o, label: x(`pem.duration.${o.code}.label`), plain: x(`pem.duration.${o.code}.plain`) })),
      },
    },
    PCFS: {
      ...PCFS,
      title: x("pcfs.title"),
      question: x("pcfs.question"),
      rules: x("pcfs.rules"),
      options: PCFS.options.map((o) => ({ ...o, label: x(`pcfs.grade.${o.grade}.label`), text: x(`pcfs.grade.${o.grade}.text`) })),
    },
    CHANGE: {
      ...CHANGE,
      note: x("change.note"),
      options: CHANGE.options.map((o) => ({ ...o, label: x(`change.option.${o.code}`) })),
      items: CHANGE.items.map((it) => ({ ...it, text: x(`change.item.${it.n}`) })),
    },
    CHECKS: localChecks(x),
  };
}

function localChecks(x) {
  const C = CHECKS;
  const items = (id, list) => list.map((it) => ({ ...it, text: x(`checks.${id}.${it.id}`) }));
  return {
    ...C,
    title: x("checks.title"),
    intro: x("checks.intro"),
    options: C.options.map((o) => ({ ...o, label: x(`answer.${o.code}`) })),
    longcovid: { ...C.longcovid, title: x("checks.longcovid.title"), pick: x("checks.longcovid.pick"), items: items("longcovid", C.longcovid.items) },
    mecfs: { ...C.mecfs, title: x("checks.mecfs.title"), pick: x("checks.mecfs.pick"), stem: x("checks.mecfs.stem"), items: items("mecfs", C.mecfs.items) },
    fibro: {
      ...C.fibro,
      title: x("checks.fibro.title"),
      pick: x("checks.fibro.pick"),
      areasQuestion: x("checks.fibro.areasQuestion"),
      areas: C.fibro.areas.map((a) => ({ ...a, label: x(`checks.fibro.area.${a.id}`) })),
      severityQuestion: x("checks.fibro.severityQuestion"),
      severity: C.fibro.severity.map((o) => ({ ...o, label: x(`checks.fibro.severity.${o.value}`) })),
      severityItems: items("fibro", C.fibro.severityItems),
      sixMonthsQuestion: x("checks.fibro.sixMonthsQuestion"),
      sixMonthsItems: items("fibro", C.fibro.sixMonthsItems),
      durationQuestion: x("checks.fibro.durationQuestion"),
    },
    lyme: { ...C.lyme, title: x("checks.lyme.title"), pick: x("checks.lyme.pick"), items: items("lyme", C.lyme.items) },
    phq9: {
      ...C.phq9,
      ...scale(x, "phq9"),
      difficultyQuestion: x("checks.phq9.difficultyQuestion"),
      difficulty: C.phq9.difficulty.map((o) => ({ ...o, label: x(`checks.phq9.difficulty.${o.code}`) })),
    },
    gad7: { ...C.gad7, ...scale(x, "gad7") },
  };
}

/** The shared parts of the PHQ-9 and GAD-7 in one language (published Spanish forms; see strings-es.js). */
function scale(x, id) {
  const C = CHECKS[id];
  return {
    title: x(`checks.${id}.title`),
    pick: x(`checks.${id}.pick`),
    fullName: x(`checks.${id}.fullName`),
    stem: x(`checks.${id}.stem`),
    options: C.options.map((o) => ({ ...o, label: x(`checks.scale.option.${o.value}`) })),
    items: C.items.map((it) => ({ ...it, text: x(`checks.${id}.${it.id}`) })),
    bands: C.bands.map((b) => ({ ...b, label: x(`checks.${id}.band.${b.code}`) })),
  };
}

/** The "What changed" title and stem for the COVID-19 answer, in one language (see changeWording). */
export function localChangeWording(covid, tt = current) {
  return covid === "yes"
    ? { title: tt("change.covid.title"), stem: tt("change.covid.stem") }
    : { title: tt("change.onset.title"), stem: tt("change.onset.stem") };
}

// ---------- app-written text saved in the state, shown in the current language ----------

// English text the app itself writes into the saved state (the demo people's made-up answers and the
// suggested questions), mapped to its id, so it can be shown in another language while the saved
// answers and the QuestionnaireResponse stay the same.
const SAVED_TEXT_IDS = (() => {
  const map = new Map();
  for (const [id, a] of Object.entries(DEMO_ANSWERS)) {
    if (a.timeline && a.timeline.symptoms) map.set(a.timeline.symptoms, `demo.${id}.symptoms`);
    (a.questions || []).forEach((q, i) => map.set(q, `demo.${id}.question.${i + 1}`));
  }
  for (const id of Object.keys(EN)) if (id.startsWith("questions.default.")) map.set(EN[id], id);
  return map;
})();

/** Show saved text in the current language when the app wrote it; text the person typed is unchanged. */
export function shownText(text, tt = current) {
  if (tt.lang === "en" || typeof text !== "string") return text;
  const id = SAVED_TEXT_IDS.get(text);
  return id && tt.has(id) ? tt(id) : text;
}

/** A term from a health record (a diagnosis, test, or medication name, or a pattern label) in one language. */
export function recordTerm(text, lang = current.lang) {
  if (lang !== "es") return text;
  return RECORD_TERMS_ES[text] ?? text;
}
