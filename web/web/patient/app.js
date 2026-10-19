// Patient app controller. All answers stay in localStorage on this device.
// Every visible string comes from the string tables through t() (i18n.js); instrument wording comes from
// localInstruments(), whose ids, codes, and points are the canonical ones, so scores never change with the
// language. English is the default; ?lang=es (remembered in localStorage) shows the app in Spanish.
import { CHECK_ORDER, INSTRUMENT_URLS, checkApplies, pcfsApplies, recoverIndexApplies } from "./instruments.js";
import {
  applyStatic,
  localChangeWording,
  localInstruments,
  readStoredLang,
  rememberLang,
  resolveLang,
  richNodes,
  setLanguage,
  shownText,
} from "./i18n.js";

function browserStorage() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

// The language is chosen before anything renders: ?lang= in the address, then the saved choice.
const requestedLang = new URL(window.location.href).searchParams.get("lang");
const t = setLanguage(resolveLang(window.location.href, readStoredLang(browserStorage())));
if (requestedLang === t.lang) rememberLang(browserStorage(), t.lang);
const { RECOVER, PEM, PCFS, CHANGE, CHECKS } = localInstruments(t);

const covidAnswer = () => (state.timeline || {}).covid;
const changeText = () => localChangeWording(covidAnswer(), t);
import {
  buildQuestionnaireResponse,
  checkLongCovid,
  checkLyme,
  checkMecfs,
  chosenChecks,
  crisisText,
  describeCheck,
  describePcfs,
  describePem,
  describeRecover,
  gradePcfs,
  isoToday,
  pemTimeframeNote,
  phq9SelfHarm,
  scoreGad7,
  scorePhq9,
  scoreRecover,
  scoreFibro,
  screenPem,
  triage,
} from "./scoring.js";
import { DEMO_AS_OF, MODELS, PERSONAS, localizeLyme, localizeSummary, lymeNote, orderSummaries, personaText, summarizeRecord } from "./records.js";
import { TRIAL_CONDITIONS, conditionLabel, phaseText, searchTrials } from "./trials.js";
import { clearAll, emptyState, load, loadPersonal, loadTrials, save, savePersonal, saveTrials } from "./storage.js";
import { clinicianUrl, demoState, handoffPayload, parsePatientRoute, stateForManualSymptomCheck, wantsReset, withoutReset, writeHandoff } from "./demo.js";
import { buildSummarySignals } from "./summary.js";

const standalone = new URL(window.location.href).searchParams.get("standalone") === "1";
let state = standalone ? loadPersonal() : load();
document.body.classList.toggle("patient-standalone", standalone);

const formatDate = (iso) => t.date(iso);
const personas = PERSONAS.map((p) => personaText(p, t));

// ---------- small DOM helpers ----------

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v === null || v === undefined) continue;
    if (k === "class") el.className = v;
    else if (k === "text") el.textContent = v;
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, "");
    else el.setAttribute(k, String(v));
  }
  for (const c of kids.flat(Infinity)) {
    if (c === null || c === undefined || c === false || c === "") continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

/** A string with [label](href) links or *emphasis*, as nodes. */
const rich = (s) => richNodes(s);

let uid = 0;
const nextId = (p) => `${p}-${++uid}`;

let saveTimer = null;
function persist({ answered = true } = {}) {
  if (answered) state.answeredOn = isoToday();
  const ok = standalone ? savePersonal(state) : save(state);
  const el = $("#save-status");
  if (el) {
    clearTimeout(saveTimer);
    el.textContent = ok ? t("save.saved") : t("save.blocked");
  }
}

/** A radio button styled as a large tap target. */
function choice({ name, value, label, sub, num, checked, onChange }) {
  const id = nextId(name.replace(/[^a-z0-9]/giu, "-"));
  const input = h("input", { type: "radio", name, id, value: String(value) });
  input.checked = !!checked;
  input.addEventListener("change", () => {
    if (input.checked) onChange(value);
  });
  return h(
    "div",
    { class: "choice" },
    input,
    h(
      "label",
      { for: id },
      h("span", { class: "choice-main" }, num !== undefined ? h("span", { class: "choice-num" }, String(num)) : null, label),
      sub ? h("span", { class: "choice-sub" }, sub) : null,
    ),
  );
}

function radioGroup({ legend, help, name, options, current, onChange, layout = "" }) {
  const helpId = help ? nextId("help") : null;
  return h(
    "fieldset",
    { "aria-describedby": helpId },
    h("legend", null, legend, help ? h("span", { class: "legend-help", id: helpId }, help) : null),
    h(
      "div",
      { class: `choices ${layout}` },
      options.map((o) => choice({ name, value: o.value, label: o.label, sub: o.sub, num: o.num, checked: current === o.value, onChange })),
    ),
  );
}

/** A checkbox styled like the radio choices. */
function checkChoice({ name, label, checked, onChange }) {
  const id = nextId(name.replace(/[^a-z0-9]/giu, "-"));
  const input = h("input", { type: "checkbox", name, id });
  input.checked = !!checked;
  input.addEventListener("change", () => onChange(input.checked));
  return h("div", { class: "choice" }, input, h("label", { for: id }, h("span", { class: "choice-main" }, label)));
}

function textField({ label, type = "text", value, onInput, help, multiline = false }) {
  const id = nextId("f");
  const helpId = help ? `${id}-help` : null;
  const input = multiline
    ? h("textarea", { id, "aria-describedby": helpId })
    : h("input", { id, type, "aria-describedby": helpId });
  input.value = value || "";
  input.addEventListener("input", () => onInput(input.value));
  return h("div", { class: "field" }, h("label", { for: id }, label), help ? h("p", { class: "note", id: helpId }, help) : null, input);
}

// ---------- symptom check steps ----------

const YES_NO = [
  { value: "yes", label: t("answer.yes") },
  { value: "no", label: t("answer.no") },
];

function pemQuestion(kind) {
  return h("span", null, rich(t(kind === "frequency" ? "pem.frequencyPrompt" : "pem.severityPrompt")));
}

function recoverStep(items, part) {
  return {
    title: t("step.recover.title", { part }),
    instrument: { label: t("instrument.recover"), fullName: RECOVER.title, href: INSTRUMENT_URLS.recoverIndex },
    render() {
      return [
        h("p", null, RECOVER.stem),
        items.map((it) =>
          h(
            "div",
            { class: "yn" },
            radioGroup({
              legend: it.text,
              help: it.help,
              name: `recover-${it.id}`,
              options: YES_NO,
              current: state.recover[it.id],
              layout: "choices-row",
              onChange: (v) => {
                state.recover[it.id] = v;
                persist();
              },
            }),
          ),
        ),
      ];
    },
  };
}

function pemStep(item) {
  return {
    title: t("step.pem.title", { n: item.n }),
    instrument: { label: t("instrument.pem"), fullName: PEM.title, href: INSTRUMENT_URLS.pem },
    render() {
      const a = state.pem[item.n] || {};
      const set = (k) => (v) => {
        state.pem[item.n] = { ...(state.pem[item.n] || {}), [k]: v };
        persist();
      };
      return [
        h("h1", { tabindex: "-1" }, t("step.pem.heading", { n: item.n })),
        h("p", { class: "symptom-prompt" }, t("pem.regarding", { text: item.text })),
        radioGroup({
          legend: pemQuestion("frequency"),
          name: `pem-${item.n}-frequency`,
          options: PEM.frequency.map((o) => ({ value: o.value, label: o.label, num: o.value })),
          current: a.frequency,
          onChange: set("frequency"),
        }),
        radioGroup({
          legend: pemQuestion("severity"),
          name: `pem-${item.n}-severity`,
          options: PEM.severity.map((o) => ({ value: o.value, label: o.label, num: o.value })),
          current: a.severity,
          onChange: set("severity"),
        }),
      ];
    },
  };
}

const BASE_STEPS = [
  {
    title: t("step.about.title"),
    render() {
      const tl = state.timeline;
      const covidDate = textField({
        label: t("about.covidDate"),
        type: "date",
        value: tl.covidDate,
        help: t("about.roughDate"),
        onInput: (v) => {
          tl.covidDate = v;
          persist();
        },
      });
      covidDate.hidden = tl.covid !== "yes";
      return [
        h("h1", { tabindex: "-1" }, t("step.about.title")),
        radioGroup({
          legend: t("about.respondent"),
          name: "respondent",
          options: [
            { value: "self", label: t("about.respondent.self") },
            { value: "caregiver", label: t("about.respondent.caregiver"), sub: t("about.respondent.caregiverSub") },
          ],
          current: state.respondent,
          onChange: (v) => {
            state.respondent = v;
            persist();
          },
        }),
        textField({
          label: t("about.onset"),
          type: "date",
          value: tl.onset,
          help: t("about.roughDate"),
          onInput: (v) => {
            tl.onset = v;
            persist();
          },
        }),
        radioGroup({
          legend: t("about.covid"),
          name: "covid",
          options: [
            { value: "yes", label: t("answer.yes") },
            { value: "no", label: t("answer.no") },
            { value: "unsure", label: t("answer.unsure") },
          ],
          current: tl.covid,
          onChange: (v) => {
            tl.covid = v;
            covidDate.hidden = v !== "yes";
            persist();
          },
        }),
        covidDate,
        textField({
          label: t("about.symptoms"),
          multiline: true,
          value: shownText(tl.symptoms, t),
          help: t("about.symptoms.help"),
          onInput: (v) => {
            tl.symptoms = v;
            persist();
          },
        }),
      ];
    },
  },
  recoverStep(RECOVER.items.slice(0, 6), 1),
  recoverStep(RECOVER.items.slice(6), 2),
  ...PEM.items.map(pemStep),
  {
    title: t("step.duration.title"),
    instrument: { label: t("instrument.pem"), fullName: PEM.title, href: INSTRUMENT_URLS.pem },
    render() {
      return [
        h("h1", { tabindex: "-1" }, t("step.duration.heading")),
        h("p", { class: "note" }, t("step.duration.note")),
        radioGroup({
          legend: PEM.duration.question,
          name: "pem-duration",
          options: PEM.duration.options.map((o) => ({ value: o.code, label: o.label, sub: o.plain })),
          current: state.pemDuration,
          onChange: (v) => {
            state.pemDuration = v;
            persist();
          },
        }),
      ];
    },
  },
  {
    title: t("step.pcfs.title"),
    instrument: { label: t("instrument.pcfs"), fullName: PCFS.title, href: INSTRUMENT_URLS.pcfs },
    render() {
      if (!pcfsApplies(covidAnswer())) {
        return [h("h1", { tabindex: "-1" }, t("step.pcfs.title")), h("p", { class: "note" }, t("step.pcfs.skip"))];
      }
      return [
        h("h1", { tabindex: "-1" }, t("step.pcfs.title")),
        h("p", { class: "instruction" }, PCFS.rules, ` ${t("step.pcfs.tapOne")}`),
        radioGroup({
          legend: PCFS.question,
          name: "pcfs",
          options: PCFS.options.map((o) => ({ value: o.grade, label: o.text })),
          current: state.pcfs,
          onChange: (v) => {
            state.pcfs = v;
            persist();
          },
        }),
      ];
    },
  },
  {
    title: t("step.change.title"),
    render() {
      return [
        h("h1", { tabindex: "-1" }, changeText().title),
        h("p", { class: "note" }, CHANGE.note),
        h("p", { class: "verbatim" }, changeText().stem),
        CHANGE.items.map((it) =>
          h(
            "div",
            { class: "yn" },
            radioGroup({
              legend: it.text,
              name: `change-${it.n}`,
              options: CHANGE.options.map((o) => ({ value: o.code, label: o.label })),
              current: state.change[it.n],
              layout: "choices-row choices-4",
              onChange: (v) => {
                state.change[it.n] = v;
                persist();
              },
            }),
          ),
        ),
      ];
    },
  },
];

// ---------- Part E. condition self-checks (optional) ----------

const YNU = CHECKS.options.map((o) => ({ value: o.code, label: o.label }));

function checkAnswers(id) {
  state.checks = state.checks || {};
  state.checks[id] = state.checks[id] || {};
  return state.checks[id];
}

function ynuGroup(id, item, extra = {}) {
  const a = checkAnswers(id);
  return h(
    "div",
    { class: "yn" },
    radioGroup({
      legend: item.text,
      name: `check-${id}-${item.id}`,
      options: YNU,
      current: a[item.id],
      layout: "choices-row choices-3",
      onChange: (v) => {
        a[item.id] = v;
        persist();
      },
      ...extra,
    }),
  );
}

/** One PHQ-9 or GAD-7 item: the four published answer choices with their scores, 0 to 3. */
function scaleGroup(id, item, after) {
  const C = CHECKS[id];
  const a = checkAnswers(id);
  return h(
    "div",
    { class: "yn" },
    radioGroup({
      legend: `${item.id}. ${item.text}`,
      name: `check-${id}-${item.id}`,
      options: C.options.map((o) => ({ value: o.value, label: o.label, num: o.value })),
      current: a[item.id],
      layout: "choices-row choices-4",
      onChange: (v) => {
        a[item.id] = v;
        persist();
        if (after) after();
      },
    }),
  );
}

/**
 * The 988 Suicide & Crisis Lifeline, shown when PHQ-9 question 9 is answered with anything but "Not at all".
 * Every word comes from the string tables already loaded, so it shows offline. live: announce it (role="alert")
 * when it appears while the person answers.
 */
function crisisBox({ live = false } = {}) {
  const c = crisisText(t);
  return h(
    "div",
    { class: "card card-crisis", "data-crisis": "", role: live ? "alert" : null },
    h("h2", null, c.heading),
    h("p", null, rich(c.body)),
    c.spanish ? h("p", null, c.spanish) : null,
    h("p", null, h("strong", null, c.emergency)),
  );
}

/** PHQ-9 question 9 was answered with anything but "Not at all" (whether or not the check is still chosen). */
const selfHarmAnswered = () => phq9SelfHarm((state.checks || {}).phq9 || {});

const chooserStep = {
  title: t("step.chooser.title"),
  render() {
    state.checks = state.checks || {};
    state.checks.chosen = state.checks.chosen || {};
    const ids = CHECK_ORDER.filter((id) => checkApplies(id, covidAnswer()));
    return [
      h("h1", { tabindex: "-1" }, t("step.chooser.heading")),
      h("p", null, CHECKS.intro),
      h(
        "fieldset",
        null,
        h("legend", null, t("step.chooser.legend")),
        h(
          "div",
          { class: "choices" },
          ids.map((id) =>
            checkChoice({
              name: `choose-${id}`,
              label: CHECKS[id].pick,
              checked: state.checks.chosen[id],
              onChange: (on) => {
                state.checks.chosen[id] = on;
                persist({ answered: false });
                refreshProgress();
              },
            }),
          ),
        ),
      ),
      h("p", { class: "note" }, t("step.chooser.note")),
    ];
  },
};

const MODULE_STEPS = {
  longcovid: [
    {
      title: t("step.longcovid.title"),
      render() {
        const C = CHECKS.longcovid;
        return [h("h1", { tabindex: "-1" }, C.title), ynuGroup("longcovid", C.items[0])];
      },
    },
  ],
  mecfs: [
    {
      title: t("step.mecfs.title"),
      render() {
        const C = CHECKS.mecfs;
        return [
          h("h1", { tabindex: "-1" }, C.title),
          h("p", { class: "instruction" }, C.stem),
          C.items.map((it) => ynuGroup("mecfs", it)),
          h("p", { class: "note" }, t("step.mecfs.note")),
        ];
      },
    },
  ],
  fibro: [
    {
      title: t("step.fibroAreas.title"),
      render() {
        const C = CHECKS.fibro;
        const a = checkAnswers("fibro");
        a.areas = a.areas || {};
        return [
          h("h1", { tabindex: "-1" }, t("step.fibroAreas.heading")),
          h(
            "fieldset",
            null,
            h("legend", null, C.areasQuestion),
            h(
              "div",
              { class: "choices choices-areas" },
              C.areas.map((ar) =>
                checkChoice({
                  name: `fibro-${ar.id}`,
                  label: ar.label,
                  checked: a.areas[ar.id] === true,
                  onChange: (on) => {
                    a.areas[ar.id] = on;
                    persist();
                  },
                }),
              ),
            ),
          ),
          h("p", { class: "note" }, t("step.fibroAreas.note")),
        ];
      },
    },
    {
      title: t("step.fibroSymptoms.title"),
      render() {
        const C = CHECKS.fibro;
        const a = checkAnswers("fibro");
        a.severity = a.severity || {};
        a.sixMonths = a.sixMonths || {};
        return [
          h("h1", { tabindex: "-1" }, t("step.fibroSymptoms.heading")),
          h("p", { class: "instruction" }, C.severityQuestion),
          C.severityItems.map((it) =>
            h(
              "div",
              { class: "yn" },
              radioGroup({
                legend: it.text,
                name: `fibro-sev-${it.id}`,
                options: C.severity.map((o) => ({ value: o.value, label: o.label, num: o.value })),
                current: a.severity[it.id],
                onChange: (v) => {
                  a.severity[it.id] = v;
                  persist();
                },
              }),
            ),
          ),
          h("p", { class: "instruction" }, C.sixMonthsQuestion),
          C.sixMonthsItems.map((it) =>
            h(
              "div",
              { class: "yn" },
              radioGroup({
                legend: it.text,
                name: `fibro-six-${it.id}`,
                options: YES_NO,
                current: a.sixMonths[it.id],
                layout: "choices-row",
                onChange: (v) => {
                  a.sixMonths[it.id] = v;
                  persist();
                },
              }),
            ),
          ),
          ynuGroup("fibro", { id: "duration", text: C.durationQuestion }),
        ];
      },
    },
  ],
  lyme: [
    {
      title: t("step.lyme.title"),
      render() {
        const C = CHECKS.lyme;
        return [h("h1", { tabindex: "-1" }, C.title), C.items.map((it) => ynuGroup("lyme", it))];
      },
    },
  ],
  phq9: [
    {
      title: t("step.phq9.title"),
      instrument: { label: t("instrument.phq9"), fullName: CHECKS.phq9.fullName, href: INSTRUMENT_URLS.phq9 },
      render() {
        const C = CHECKS.phq9;
        const a = checkAnswers("phq9");
        // The crisis box sits under question 9 and appears the moment a non-zero answer is chosen, scrolled into view.
        const slot = h("div", { class: "crisis-slot" }, selfHarmAnswered() ? crisisBox() : null);
        const update = () => {
          const shown = slot.querySelector("[data-crisis]");
          if (selfHarmAnswered() && !shown) {
            slot.replaceChildren(crisisBox({ live: true }));
            slot.scrollIntoView({ block: "nearest" });
          } else if (!selfHarmAnswered() && shown) slot.replaceChildren();
        };
        return [
          h("h1", { tabindex: "-1" }, C.title),
          h("p", { class: "instruction" }, C.stem),
          C.items.map((it) => (it.id === C.selfHarmItem ? [scaleGroup("phq9", it, update), slot] : scaleGroup("phq9", it))),
          h(
            "div",
            { class: "yn" },
            radioGroup({
              legend: C.difficultyQuestion,
              name: "check-phq9-difficulty",
              options: C.difficulty.map((o) => ({ value: o.code, label: o.label })),
              current: a.difficulty,
              layout: "choices-row choices-4",
              onChange: (v) => {
                a.difficulty = v;
                persist();
              },
            }),
          ),
        ];
      },
    },
  ],
  gad7: [
    {
      title: t("step.gad7.title"),
      instrument: { label: t("instrument.gad7"), fullName: CHECKS.gad7.fullName, href: INSTRUMENT_URLS.gad7 },
      render() {
        const C = CHECKS.gad7;
        return [h("h1", { tabindex: "-1" }, C.title), h("p", { class: "instruction" }, C.stem), C.items.map((it) => scaleGroup("gad7", it))];
      },
    },
  ],
};

const summaryStep = {
  title: t("step.summary.title"),
  render() {
    const { recover, pem, pcfs } = computeAll();
    const signals = buildSummarySignals({
      recover, recoverApplicable: recoverIndexApplies(covidAnswer()),
      pem, pcfs, pcfsApplicable: pcfsApplies(covidAnswer()), checks: checkResults(),
    }, t);
    return h(
      "div",
      { class: "questionnaire-summary" },
      h("h1", { tabindex: "-1" }, t("summary.heading")),
      selfHarmAnswered() ? crisisBox() : null,
      h("p", { class: "note" }, t("summary.note")),
      h("h2", { class: "summary-signals-heading" }, t("summary.signalsHeading")),
      h("ul", { class: "summary-signals" }, signals.map((signal) =>
        h("li", { class: `summary-signal summary-signal-${signal.tone}` },
          h("div", { class: "summary-signal-top" },
            h("strong", { class: "summary-signal-condition" }, signal.condition),
            h("span", { class: "summary-signal-status" }, t(`summary.status.${signal.status}`)),
          ),
          h("div", { class: "summary-signal-detail" },
            h("span", { class: "summary-signal-label" }, signal.label),
            h("span", { class: `summary-signal-value${signal.zero ? " summary-signal-zero" : ""}` }, signal.value),
          ),
          h("p", { class: "summary-signal-advice" }, signal.advice),
        ),
      )),
      h("div", { class: "actions summary-actions" },
        h("button", { type: "button", class: "btn btn-primary", onclick: () => { renderSheet(); window.print(); } }, t("summary.print")),
        h("button", { type: "button", class: "btn btn-secondary", onclick: downloadResponse }, t("summary.download")),
        h("button", { type: "button", class: "btn btn-secondary", onclick: sendToClinician }, t("common.sendDemo")),
      ),
      h("p", { class: "sr-only", "data-download-status": "", role: "status" }),
      h("p", { class: "note", "data-send-status": "", role: "status", "aria-live": "polite" }),
      h("div", { class: "actions summary-more" },
        h("button", { type: "button", class: "btn btn-secondary", onclick: openRecord }, t("record.title")),
        h("button", { type: "button", class: "btn btn-secondary", onclick: () => showScreen("trials") }, t("trials.title")),
      ),
    );
  },
};

/** The pages of the symptom check: the fixed parts, chosen checks, and one compact summary. */
function steps() {
  const chosen = chosenChecks(state.checks || {}, covidAnswer());
  return [...BASE_STEPS, chooserStep, ...chosen.flatMap((id) => MODULE_STEPS[id]), summaryStep];
}

function refreshProgress() {
  const all = steps();
  const i = Math.min(Math.max(0, state.step || 0), all.length - 1);
  $("#check-progress").max = all.length;
  $("#check-progress").value = i + 1;
  $("#check-progress-label").textContent = t("check.progress", { page: i + 1, total: all.length, title: all[i].title });
  const instrument = $("#check-instrument");
  if (all[i].instrument) {
    instrument.textContent = `[${all[i].instrument.label}]`;
    instrument.href = all[i].instrument.href;
    instrument.title = all[i].instrument.fullName;
    instrument.setAttribute("aria-label", t("check.instrumentLink", { name: all[i].instrument.fullName }));
    instrument.hidden = false;
  } else {
    instrument.textContent = "";
    instrument.removeAttribute("href");
    instrument.removeAttribute("title");
    instrument.removeAttribute("aria-label");
    instrument.hidden = true;
  }
  const next = $("#step-next");
  next.textContent = i === all.length - 1 ? t("check.done") : t("check.next");
  next.disabled = i === all.length - 1;
  $("#step-back").hidden = i === 0;
}

function renderStep({ focus = true } = {}) {
  const all = steps();
  const i = Math.min(Math.max(0, state.step || 0), all.length - 1);
  state.step = i;
  const body = $("#step-body");
  body.replaceChildren(...[all[i].render()].flat(Infinity).filter(Boolean));
  refreshProgress();
  $("#step-back").textContent = t("check.back");
  document.title = t("check.pageTitle", { title: all[i].title });
  if (focus) {
    const h1 = $("h1", body);
    if (h1) h1.focus();
    window.scrollTo(0, 0);
  }
}

// ---------- results ----------

function attributionLine(text) {
  return h("p", { class: "attribution" }, text);
}

function answeredLine() {
  return state.answeredOn ? h("p", { class: "meta" }, t("results.answered", { date: formatDate(state.answeredOn) })) : null;
}

function computeAll() {
  const recover = scoreRecover(state.recover);
  const pem = screenPem(state.pem);
  const pcfs = pcfsApplies(covidAnswer()) ? gradePcfs(state.pcfs) : null;
  const timeframe = pemTimeframeNote(state.timeline, state.answeredOn || isoToday());
  const chartBands = ((state.persona && state.persona.summaries) || []).map((s) => s.band).filter(Boolean);
  const tri = triage({ chartBands, recover, pem, covid: covidAnswer() });
  return { recover, pem, pcfs, timeframe, tri };
}

/** Results of the chosen self-checks, in display order. */
function checkResults() {
  const ck = state.checks || {};
  const pem = screenPem(state.pem);
  const fns = {
    longcovid: () => checkLongCovid(ck.longcovid),
    mecfs: () => checkMecfs(ck.mecfs, pem),
    fibro: () => scoreFibro(ck.fibro),
    lyme: () => checkLyme(ck.lyme),
    phq9: () => scorePhq9(ck.phq9),
    gad7: () => scoreGad7(ck.gad7),
  };
  return chosenChecks(ck, covidAnswer()).map((id) => {
    const r = fns[id]();
    return { id, r, d: describeCheck(id, r, t) };
  });
}

function changeRows() {
  return CHANGE.items.map((it) => {
    const o = CHANGE.options.find((x) => x.code === state.change[it.n]);
    return { text: it.text, answer: o ? o.label : t("result.notAnsweredLabel") };
  });
}

function pemDurationPlain() {
  const o = PEM.duration.options.find((x) => x.code === state.pemDuration);
  return o ? o.plain : "";
}

function renderResults() {
  const { recover, pem, pcfs, timeframe, tri } = computeAll();
  const r = describeRecover(recover, covidAnswer(), t);
  const scored = recoverIndexApplies(covidAnswer());
  const p = describePem(pem, timeframe, t);
  const c = describePcfs(pcfs, t);

  const nodes = [
    selfHarmAnswered() ? crisisBox() : null,
    tri.flag
      ? h(
          "div",
          { class: "card card-flag" },
          h("span", { class: "tag" }, t("results.flag.tag")),
          h("h2", null, t("results.flag.heading")),
          h("p", null, t("results.flag.intro")),
          h("ul", { class: "plain-list" }, tri.reasons.map((x) => h("li", null, t(`results.flag.reason.${x}`)))),
          h("p", { class: "note" }, t("triage.exploratory")),
        )
      : null,
    h(
      "div",
      { class: "card" },
      h("span", { class: "tag" }, RECOVER.title),
      h("p", { class: "result-headline" }, r.headline),
      h("p", null, r.body),
      recover.yesItems.length
        ? h("ul", { class: "plain-list" }, recover.yesItems.map((i) => {
            const name = t(`recover.item.${i.id}.name`);
            return h("li", null, scored ? `${name}: ${t.n("recover.points", i.points)}` : name);
          }))
        : null,
      answeredLine(),
    ),
    h(
      "div",
      { class: "card" },
      h("span", { class: "tag" }, t("results.pem.tag")),
      h("p", { class: "result-headline" }, p.headline),
      h("p", null, p.body),
      state.pemDuration ? h("p", null, t("results.pem.duration", { plain: pemDurationPlain() })) : null,
      answeredLine(),
    ),
    pcfsApplies(covidAnswer()) && h(
      "div",
      { class: "card" },
      h("span", { class: "tag" }, t("results.pcfs.tag")),
      h("p", { class: "result-headline" }, c.headline),
      h("p", null, c.body),
      answeredLine(),
    ),
    ...checkResults().map(({ id, d }) =>
      h(
        "div",
        { class: "card" },
        h("span", { class: "tag" }, id === "lyme" ? t("results.notScoredTag") : t("results.selfCheckTag")),
        h("h2", null, CHECKS[id].title),
        h("p", { class: "result-headline" }, d.headline),
        h("p", null, d.body),
        (d.extra || []).map((line) => h("p", null, line)),
        answeredLine(),
      ),
    ),
    h(
      "div",
      { class: "card" },
      h("span", { class: "tag" }, t("results.notScoredTag")),
      h("h2", null, changeText().title),
      h("p", { class: "note" }, changeText().stem),
      h("ul", { class: "change-list" }, changeRows().map((row) => h("li", null, row.text, h("span", { class: "change-answer" }, row.answer)))),
    ),
  ];
  $("#results-body").replaceChildren(...nodes.filter(Boolean));
  const banner = $("#results-demo");
  const demo = personas.find((x) => x.id === state.demo);
  banner.hidden = !demo;
  banner.textContent = demo ? t("results.demoBanner", { name: demo.name }) : "";
}

// ---------- record patterns (demo personas) ----------

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.json();
}

/** Score one demo person's made-up record and keep only the patient-safe summary. */
async function fetchPersona(p) {
  const [{ scoreBundle }, bundle] = await Promise.all([import("/shared/scorer.js"), fetchJson(`/data/patients/${p.id}.json`)]);
  const summaries = [];
  for (const [key, m] of Object.entries(MODELS)) {
    const model = await fetchJson(m.file);
    const result = scoreBundle(model, bundle, DEMO_AS_OF);
    // Only the patient-safe summary is kept; the raw result is discarded.
    summaries.push(summarizeRecord(key, result, bundle));
  }
  let lymeTable = null;
  try {
    lymeTable = await fetchJson("/data/lyme_county.json");
  } catch {
    /* the Lyme note is optional */
  }
  return { id: p.id, name: p.name, asOf: DEMO_AS_OF, summaries, lyme: lymeNote(bundle, lymeTable) };
}

async function loadPersona(p) {
  const out = $("#record-body");
  out.replaceChildren(h("p", { role: "status" }, t("record.loading")));
  try {
    state.persona = await fetchPersona(p);
    state.removedFindings = [];
    persist({ answered: false });
    renderRecord();
  } catch (err) {
    out.replaceChildren(
      h(
        "div",
        { class: "card" },
        h("p", null, t("record.loadFailed")),
        h("p", { class: "note" }, navigator.onLine ? t("record.tryAgain") : t("record.offline")),
      ),
    );
  }
}

function findingNode(f, { removable = false, removed = false } = {}) {
  return h(
    "div",
    { class: `finding${removed ? " removed" : ""}` },
    h("div", { class: "finding-label" }, f.label),
    h(
      "ul",
      null,
      f.items.map((it) => h("li", null, `${it.dateText || t("record.noDate")}. ${it.kind}${it.text ? `: ${it.text}` : ""}`)),
    ),
    removable ? removable : null,
  );
}

function patternCard(s) {
  const top = s.findings.slice(0, 6);
  const rest = s.findings.slice(6);
  return h(
    "div",
    { class: `card${s.status === "pattern" ? " card-flag" : ""}` },
    h("h3", null, s.status === "pattern" ? s.headline : s.title),
    h("p", null, s.message),
    top.map((f) => findingNode(f)),
    rest.length
      ? h("details", null, h("summary", null, t.n("record.showMore", rest.length)), rest.map((f) => findingNode(f)))
      : null,
    s.also ? h("p", { class: "note" }, s.also) : null,
    s.discuss ? h("p", null, s.discuss) : null,
  );
}

/** The saved Lyme note in the page's language. */
function personaLyme() {
  return state.persona && state.persona.lyme ? localizeLyme(state.persona.lyme, t) : null;
}

function renderRecord() {
  const list = $("#persona-list");
  list.replaceChildren(
    ...personas.map((p) =>
      h(
        "button",
        {
          type: "button",
          class: "btn btn-secondary persona-btn",
          "aria-pressed": state.persona && state.persona.id === p.id ? "true" : "false",
          onclick: () => loadPersona(p),
        },
        h("strong", null, p.name),
        h("span", { class: "persona-story" }, p.story),
        h("span", null, p.blurb),
      ),
    ),
  );
  const out = $("#record-body");
  const ps = state.persona;
  if (!ps) {
    out.replaceChildren();
    return;
  }
  const lyme = personaLyme();
  const nodes = [
    h("p", { class: "demo-banner" }, t("record.demoBanner", { name: ps.name, date: formatDate(ps.asOf) })),
    ...personaSummaries().map(patternCard),
    lyme ? h("div", { class: "card card-flag" }, h("h3", null, lyme.headline), h("p", null, lyme.body), attributionLine(lyme.source)) : null,
    h(
      "div",
      { class: "actions" },
      h("button", { type: "button", class: "btn btn-primary", onclick: () => showScreen("summary") }, t("record.addToSummary")),
      h(
        "button",
        {
          type: "button",
          class: "btn btn-secondary",
          onclick: () => {
            state.persona = null;
            persist({ answered: false });
            renderRecord();
            $("#record-title").focus();
          },
        },
        t("record.stopDemo"),
      ),
    ),
  ];
  out.replaceChildren(...nodes.filter(Boolean));
}

// ---------- visit summary ----------

// Suggested questions are saved in English (like every app-written answer) and shown in the page's language.
function defaultQuestions() {
  const { recover, pem } = computeAll();
  const q = ["questions.default.cause", "questions.default.tests"];
  if (pem.status === "positive") q.push("questions.default.pacing");
  const lc = state.persona && state.persona.summaries.some((s) => s.modelKey === "longcovid" && s.status === "pattern");
  if ((recoverIndexApplies(covidAnswer()) && recover.points >= RECOVER.cutoff) || lc) q.push("questions.default.covid");
  if (state.persona && state.persona.lyme) q.push("questions.default.lyme");
  q.push("questions.default.studies");
  q.push("questions.default.followUp");
  return q.map((id) => t.en(id));
}

/** The demo person's pattern checks, the person's focus condition first, in the page's language. */
function personaSummaries() {
  if (!state.persona) return [];
  const focus = (PERSONAS.find((x) => x.id === state.persona.id) || {}).focus;
  return orderSummaries(state.persona.summaries || [], focus).map((s) => localizeSummary(s, t));
}

function visibleFindings() {
  if (!state.persona || !state.include.findings) return [];
  const removed = new Set(state.removedFindings || []);
  return personaSummaries()
    .filter((s) => s.status === "pattern")
    .map((s) => ({ ...s, findings: s.findings.filter((f) => !removed.has(f.key)) }));
}

const SECTIONS = ["timeline", "recover", "pem", "pcfs", "change", "checks", "findings", "questions"];

function includeToggle(key) {
  const id = nextId("inc");
  const box = h("input", { type: "checkbox", id });
  box.checked = state.include[key] !== false;
  box.addEventListener("change", () => {
    state.include[key] = box.checked;
    persist({ answered: false });
    renderSheet();
  });
  return h("div", { class: "toggle-row" }, box, h("label", { for: id }, t("summaryEdit.include", { label: t(`summaryEdit.section.${key}`) })));
}

function renderSummaryEditor() {
  if (!Array.isArray(state.questions)) {
    state.questions = defaultQuestions();
    persist({ answered: false });
  }
  const tl = state.timeline;
  const onChange = () => {
    persist();
    renderSheet();
  };

  const questions = h("div", null);
  const drawQuestions = () => {
    questions.replaceChildren(
      ...state.questions.map((q, i) => {
        const id = nextId("q");
        const ta = h("textarea", { id, "aria-label": t("summaryEdit.question", { n: i + 1 }) });
        ta.value = shownText(q, t);
        ta.addEventListener("input", () => {
          state.questions[i] = ta.value;
          persist({ answered: false });
          renderSheet();
        });
        return h(
          "div",
          { class: "question-row" },
          ta,
          h(
            "button",
            {
              type: "button",
              class: "btn btn-secondary btn-small",
              "aria-label": t("summaryEdit.removeQuestion", { n: i + 1 }),
              onclick: () => {
                state.questions.splice(i, 1);
                persist({ answered: false });
                drawQuestions();
                renderSheet();
              },
            },
            t("summaryEdit.remove"),
          ),
        );
      }),
      h(
        "button",
        {
          type: "button",
          class: "btn btn-secondary btn-small",
          onclick: () => {
            state.questions.push("");
            persist({ answered: false });
            drawQuestions();
            renderSheet();
            const all = $$("textarea", questions);
            if (all.length) all[all.length - 1].focus();
          },
        },
        t("summaryEdit.addQuestion"),
      ),
    );
  };
  drawQuestions();

  const findingsEditor = h("div", null);
  const drawFindings = () => {
    const removed = new Set(state.removedFindings || []);
    const pats = personaSummaries().filter((s) => s.status === "pattern");
    if (!pats.length) {
      findingsEditor.replaceChildren(h("p", { class: "note" }, t("summaryEdit.noFindings")));
      return;
    }
    findingsEditor.replaceChildren(
      ...pats.map((s) =>
        h(
          "details",
          { class: "findings-edit", open: s.findings.length <= 4 },
          h("summary", null, t.n("summaryEdit.review", s.findings.length, { condition: `${s.condition.charAt(0).toUpperCase()}${s.condition.slice(1)}` })),
          s.findings.map((f) => {
            const isRemoved = removed.has(f.key);
            const btn = h(
              "button",
              {
                type: "button",
                class: "btn btn-secondary btn-small",
                "aria-label": t(isRemoved ? "summaryEdit.putBackFinding" : "summaryEdit.removeFinding", { label: f.label }),
                onclick: () => {
                  const set = new Set(state.removedFindings || []);
                  if (set.has(f.key)) set.delete(f.key);
                  else set.add(f.key);
                  state.removedFindings = [...set];
                  persist({ answered: false });
                  drawFindings();
                  renderSheet();
                },
              },
              isRemoved ? t("summaryEdit.putBack") : t("summaryEdit.remove"),
            );
            return findingNode(f, { removable: btn, removed: isRemoved });
          }),
        ),
      ),
    );
  };
  drawFindings();

  $("#summary-edit").replaceChildren(
    h(
      "div",
      { class: "card" },
      h("h2", null, t("summaryEdit.choose")),
      SECTIONS.filter((key) => (key !== "pcfs" || pcfsApplies(covidAnswer())) && (key !== "checks" || checkResults().length)).map((key) => includeToggle(key)),
      h("p", { class: "note" }, t("summaryEdit.changeAnswer")),
    ),
    h(
      "div",
      { class: "card" },
      h("h2", null, t("summaryEdit.timeline")),
      textField({ label: t("about.onset"), type: "date", value: tl.onset, onInput: (v) => { tl.onset = v; onChange(); } }),
      textField({ label: t("summaryEdit.mainSymptoms"), multiline: true, value: shownText(tl.symptoms, t), help: t("summaryEdit.onePerLine"), onInput: (v) => { tl.symptoms = v; onChange(); } }),
    ),
    h("div", { class: "card" }, h("h2", null, t("summaryEdit.findings")), findingsEditor),
    h("div", { class: "card" }, h("h2", null, t("summaryEdit.questions")), questions),
  );
}

function renderSheet() {
  const sheet = $("#print-sheet");
  if (!sheet) return;
  const inc = state.include;
  const { recover, pem, pcfs, timeframe } = computeAll();
  const tl = state.timeline;
  const who = state.respondent === "caregiver" ? t("sheet.byCaregiver") : t("sheet.byPatient");
  const covidText = { yes: tl.covidDate ? t("sheet.covidYesDate", { date: formatDate(tl.covidDate) }) : t("answer.yes"), no: t("answer.no"), unsure: t("answer.unsure") }[tl.covid] || t("result.notAnsweredLabel");
  const sec = (title, ...kids) => h("section", null, h("h2", null, title), kids);

  const parts = [
    h("h1", null, t("sheet.title")),
    h("p", { class: "meta" }, t(state.answeredOn ? "sheet.preparedChanged" : "sheet.prepared", { date: formatDate(isoToday()), who, changed: formatDate(state.answeredOn) })),
  ];
  if (inc.timeline) {
    parts.push(
      sec(
        t("summaryEdit.timeline"),
        h(
          "dl",
          null,
          h("dt", null, t("sheet.started")),
          h("dd", null, formatDate(tl.onset) || t("result.notAnsweredLabel")),
          h("dt", null, t("sheet.hadCovid")),
          h("dd", null, covidText),
        ),
        h("h3", null, t("summaryEdit.mainSymptoms")),
        h("p", { class: "pre" }, (shownText(tl.symptoms, t) || "").trim() || t("result.notAnsweredLabel")),
      ),
    );
  }
  if (inc.recover || inc.pem || inc.pcfs) {
    const kids = [];
    if (inc.recover) {
      const d = describeRecover(recover, covidAnswer(), t);
      const scored = recoverIndexApplies(covidAnswer());
      kids.push(
        h("h3", null, RECOVER.title),
        h("p", null, d.short),
        scored && recover.yesItems.length ? h("p", null, t("sheet.markedYes", { list: recover.yesItems.map((i) => `${t(`recover.item.${i.id}.name`)} (${i.points})`).join(", ") })) : null,
      );
    }
    if (inc.pem) {
      const d = describePem(pem, timeframe, t);
      const dur = pemDurationPlain();
      kids.push(
        h("h3", null, t("sheet.pem")),
        h("p", null, d.short, dur ? ` ${t("sheet.pemDuration", { plain: dur })}` : ""),
      );
    }
    if (inc.pcfs && pcfsApplies(covidAnswer())) {
      const d = describePcfs(pcfs, t);
      kids.push(h("h3", null, t("summaryEdit.section.pcfsShort")), h("p", null, d.short));
    }
    parts.push(sec(t("sheet.questionnaires"), kids));
  }
  if (inc.change) {
    parts.push(
      sec(
        t("sheet.notScored", { title: changeText().title }),
        h("p", null, changeText().stem),
        h("dl", { class: "pairs" }, changeRows().map((r) => [h("dt", null, r.text), h("dd", null, r.answer)])),
      ),
    );
  }
  const cr = checkResults();
  if (inc.checks && cr.length) {
    parts.push(
      sec(
        t("sheet.checks"),
        cr.map(({ id, d }) => [h("h3", null, CHECKS[id].title), h("p", null, d.short)]),
      ),
    );
  }
  const fs = visibleFindings();
  const lyme = personaLyme();
  if (inc.findings && (fs.length || lyme)) {
    parts.push(
      sec(
        t("summaryEdit.findings"),
        state.persona ? h("p", { class: "meta" }, t("sheet.demoRecord", { name: state.persona.name, date: formatDate(state.persona.asOf) })) : null,
        fs.map((s) => [
          h("h3", null, s.headline),
          s.findings.length
            ? h(
                "ul",
                null,
                s.findings.map((f) => {
                  const shown = f.items.slice(0, 3).map((i) => `${i.dateText}${i.text ? ` (${i.text})` : ""}`);
                  const more = f.items.length > 3 ? t("sheet.andMore", { n: f.items.length - 3 }) : "";
                  return h("li", null, `${f.label}: ${shown.join("; ")}${more}`);
                }),
              )
            : h("p", null, t("sheet.allRemoved")),
        ]),
        lyme ? [h("h3", null, lyme.headline), h("p", null, lyme.body)] : null,
      ),
    );
  }
  const qs = (state.questions || []).map((q) => String(shownText(q, t) || "").trim()).filter(Boolean);
  if (inc.questions && qs.length) {
    parts.push(sec(t("summaryEdit.questions"), h("ol", null, qs.map((q) => h("li", null, q)))));
  }
  parts.push(h("p", { class: "meta" }, t("sheet.footer")));
  sheet.replaceChildren(...parts);
}

function downloadResponse() {
  const include = { ...state.include };
  delete include.findings;
  const qr = buildQuestionnaireResponse(state, { include });
  const blob = new Blob([JSON.stringify(qr, null, 2)], { type: "application/fhir+json" });
  const url = URL.createObjectURL(blob);
  const a = h("a", { href: url, download: `symptom-check-${isoToday()}.json` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  for (const el of $$("[data-download-status], #download-status")) el.textContent = t("summary.downloaded");
}

// ---------- demo: made-up answers, hand-off, start over ----------

function sendToClinician() {
  if (!Array.isArray(state.questions)) {
    state.questions = defaultQuestions();
    persist({ answered: false });
  }
  const payload = handoffPayload(state);
  const store = browserStorage();
  if (!store || !writeHandoff(store, payload)) {
    for (const el of $$("[data-send-status]")) el.textContent = t("summary.sendBlocked");
    return;
  }
  location.href = clinicianUrl(payload);
}

function renderDemoPickers() {
  for (const box of $$("[data-demo-picker]")) {
    box.className = "demo-picker";
    box.replaceChildren(
      ...personas.map((p) =>
        h(
          "button",
          { type: "button", class: "demo-btn", "data-demo": p.id, "aria-pressed": String(state.demo === p.id), onclick: () => loadDemo(p.id) },
          h("strong", null, p.name),
          h("span", null, p.story),
        ),
      ),
    );
  }
}

function updateDemoSelection() {
  for (const button of $$("[data-demo]")) {
    button.setAttribute("aria-pressed", String(button.dataset.demo === state.demo));
  }
}

let demoLoading = false;
const DEMO_LOAD_MS = 0;
let demoFrameLoadToken = 0;

function setDemoAppLoading() {
  const token = ++demoFrameLoadToken;
  const frame = $("#demo-app-frame");
  frame.classList.add("is-loading");
  frame.setAttribute("aria-busy", "true");
  $("#demo-app-loader-text").textContent = t("demo.opening");
  $("#demo-app-loader").hidden = false;
  return token;
}

function clearDemoAppLoading(token) {
  if (token !== demoFrameLoadToken) return;
  const frame = $("#demo-app-frame");
  frame.classList.remove("is-loading");
  frame.setAttribute("aria-busy", "false");
  $("#demo-app-loader").hidden = true;
}

function waitForDemoLoad(startedAt) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, DEMO_LOAD_MS - (performance.now() - startedAt))));
}

function hasPersonalAnswers(value) {
  if (value === null || value === undefined || value === "" || value === false) return false;
  if (Array.isArray(value)) return value.some(hasPersonalAnswers);
  if (typeof value === "object") return Object.values(value).some(hasPersonalAnswers);
  return true;
}

async function loadDemo(id, { page = 1 } = {}) {
  const p = PERSONAS.find((x) => x.id === id);
  const next = demoState(id);
  if (!p || !next || demoLoading) return;
  demoLoading = true;
  const buttons = $$("[data-demo]");
  const statuses = $$("[data-demo-status]");
  const startedAt = performance.now();
  const frameToken = setDemoAppLoading();
  for (const b of buttons) {
    b.disabled = true;
    b.setAttribute("aria-pressed", String(b.dataset.demo === id));
  }
  for (const el of statuses) el.textContent = t("demo.opening");
  let persona = null;
  try {
    persona = await fetchPersona(p);
  } catch {
    /* the answers still load; the record needs a connection the first time */
  }
  await waitForDemoLoad(startedAt);
  if (!state.demo && [state.respondent, state.timeline, state.recover, state.pem, state.pemDuration, state.pcfs, state.change, state.checks, state.questions, state.answeredOn].some(hasPersonalAnswers)) savePersonal(state);
  state = next;
  state.persona = persona;
  persist({ answered: false });
  updateDemoSelection();
  for (const b of buttons) b.disabled = false;
  for (const el of statuses) el.textContent = "";
  demoLoading = false;
  state.step = Math.max(0, page - 1);
  go(patientHash());
  clearDemoAppLoading(frameToken);
}

// ---------- trial finder ----------

function renderTrialsList(data) {
  const list = $("#trials-list");
  list.replaceChildren(
    ...data.studies.map((s) =>
      h(
        "li",
        null,
        h("h2", { class: "trial-title" }, s.title),
        h("p", null, h("strong", null, t("trials.phaseLabel")), Array.isArray(s.phases) ? phaseText(s.phases, t) : s.phase),
        s.locations.length
          ? h(
              "div",
              null,
              h("strong", null, t("trials.whereLabel")),
              h("ul", { class: "plain-list" }, s.locations.map((l) => h("li", null, l)), s.moreLocations ? h("li", null, t.n("trials.moreSites", s.moreLocations)) : null),
            )
          : h("p", null, h("strong", null, t("trials.whereLabel")), t("trials.notListed")),
        h("p", null, h("a", { href: s.url, target: "_blank", rel: "noopener noreferrer" }, t("trials.readMore", { id: s.id }))),
      ),
    ),
  );
}

async function onTrialsSubmit(e) {
  e.preventDefault();
  const condition = $("#trial-condition").value;
  const location = $("#trial-location").value.trim();
  const status = $("#trials-status");
  const label = conditionLabel(condition, t);
  const showSaved = (prefix) => {
    const last = loadTrials();
    if (last && last.studies && last.studies.length) {
      const savedLabel = last.condition ? conditionLabel(last.condition, t) : last.label;
      status.textContent = `${prefix} ${t(last.location ? "trials.savedWithPlace" : "trials.saved", { label: savedLabel, place: last.location, date: formatDate(last.date) })}`;
      renderTrialsList(last);
    } else {
      status.textContent = `${prefix} ${t("trials.tryLater")}`;
      $("#trials-list").replaceChildren();
    }
  };
  if (navigator.onLine === false) {
    showSaved(t("trials.offline"));
    return;
  }
  status.textContent = t("trials.searching", { label });
  try {
    const data = await searchTrials({ condition, location }, { t });
    if (!data.studies.length) {
      status.textContent = t(location ? "trials.noneIn" : "trials.none", { label, place: location });
      $("#trials-list").replaceChildren();
      return;
    }
    status.textContent = t.n(location ? "trials.showingNear" : "trials.showing", data.studies.length, { label, place: location });
    renderTrialsList(data);
    saveTrials({ ...data, condition, label, location, date: isoToday() });
  } catch (err) {
    showSaved(err.offline ? t("trials.unreachable") : t("trials.unexpected"));
  }
}

// ---------- routing ----------

function patientHash() {
  const prefix = state.demo ? `${state.demo}/` : "";
  return `#${prefix}qp-${state.step + 1}`;
}

let routed = false;

function route() {
  const { persona, page } = parsePatientRoute(location.hash);
  if (!standalone) {
    const requested = persona || PERSONAS[0].id;
    if (requested !== state.demo) {
      void loadDemo(requested, { page: page || 1 });
      return;
    }
  }
  state.step = (page || 1) - 1;
  for (const s of $$(".screen")) s.hidden = s.dataset.screen !== "check";
  renderStep({ focus: routed });
  if (location.hash !== patientHash()) history.replaceState(null, "", patientHash());
  routed = true;
}

function go(hash) {
  if (location.hash === hash) route();
  else location.hash = hash;
}

/** Patterns in my record, opened from the summary: the demo person's own synthetic record, loaded at once. */
function openRecord() {
  showScreen("record");
  const p = personas.find((x) => x.id === state.demo);
  if (p && (!state.persona || state.persona.id !== p.id)) void loadPersona(p);
}

// Other tools remain in the page without creating fragment routes.
function showScreen(screen) {
  if (!["results", "record", "summary", "trials"].includes(screen)) {
    go(patientHash());
    return;
  }
  for (const s of $$(".screen")) s.hidden = s.dataset.screen !== screen;
  if (screen === "results") renderResults();
  if (screen === "record") renderRecord();
  if (screen === "summary") {
    renderSummaryEditor();
    renderSheet();
  }
  document.title = t("title.page", { page: t(`title.screen.${screen}`) });
  const heading = $(`.screen[data-screen="${screen}"] h1`);
  if (heading && routed) heading.focus();
  routed = true;
  window.scrollTo(0, 0);
}

// ---------- wire up ----------

/** The static page in the chosen language (the HTML is English). */
function translatePage() {
  if (t.lang === "en") return;
  applyStatic(document, t);
  const meta = $('meta[name="description"]');
  if (meta) meta.setAttribute("content", t("meta.description"));
  // The standalone link keeps the language even when the browser does not save the choice (and keeps its
  // ?reset, so it still starts with a clean form).
  for (const a of $$("a.patient-try-link")) {
    const u = new URL(a.getAttribute("href"), window.location.href);
    u.searchParams.set("lang", t.lang);
    a.setAttribute("href", `${u.pathname}${u.search}${u.hash}`);
  }
}

function init() {
  // A reset must be applied before building the picker, so its selected state
  // always represents the state that will actually be shown.
  if (wantsReset(location.href)) {
    clearAll();
    state = emptyState();
    try {
      history.replaceState(null, "", withoutReset(location.href));
    } catch {
      /* the address keeps ?reset; the state is still cleared */
    }
  }

  translatePage();
  $("#skip-main").addEventListener("click", () => {
    const main = $("#main");
    main.setAttribute("tabindex", "-1");
    main.focus();
  });

  if (standalone && state.demo) {
    state = stateForManualSymptomCheck(state);
    persist({ answered: false });
  }
  for (const button of $$("[data-show-screen]")) button.addEventListener("click", () => showScreen(button.dataset.showScreen));

  $("#check-form").addEventListener("submit", (e) => {
    e.preventDefault();
    if (state.step >= steps().length - 1) {
      return;
    }
    state.step += 1;
    persist({ answered: false });
    go(patientHash());
  });
  $("#step-back").addEventListener("click", () => {
    if (state.step <= 0) return;
    state.step -= 1;
    persist({ answered: false });
    go(patientHash());
  });

  $("#trial-condition").replaceChildren(...TRIAL_CONDITIONS.map((c) => h("option", { value: c.id }, conditionLabel(c.id, t))));
  $("#trials-form").addEventListener("submit", onTrialsSubmit);

  $("#print-btn").addEventListener("click", () => {
    renderSheet();
    window.print();
  });
  window.addEventListener("beforeprint", renderSheet);
  $("#download-btn").addEventListener("click", downloadResponse);
  for (const b of $$("[data-send]")) b.addEventListener("click", sendToClinician);
  for (const b of $$("[data-scroll-to]")) {
    b.addEventListener("click", () => {
      const target = document.getElementById(b.dataset.scrollTo);
      if (!target) return;
      target.scrollIntoView({ block: "start" });
      if (target.matches("h1, h2")) target.setAttribute("tabindex", "-1");
      target.focus({ preventScroll: true });
    });
  }
  renderDemoPickers();

  const resetDialog = $("#reset-dialog");
  for (const b of $$("[data-start-over]")) {
    b.addEventListener("click", () => {
      if (typeof resetDialog.showModal === "function") resetDialog.showModal();
      else if (window.confirm(t("dialog.resetConfirm"))) doDelete(t("dialog.resetDone"));
    });
  }
  resetDialog.addEventListener("close", () => {
    if (resetDialog.returnValue === "reset") doDelete(t("dialog.resetDone"));
  });

  const dialog = $("#delete-dialog");
  for (const b of $$("[data-delete]")) {
    b.addEventListener("click", () => {
      if (typeof dialog.showModal === "function") dialog.showModal();
      else if (window.confirm(t("dialog.deleteConfirm"))) doDelete();
    });
  }
  dialog.addEventListener("close", () => {
    if (dialog.returnValue === "delete") doDelete();
  });

  const banner = $("#offline-banner");
  const net = () => {
    banner.textContent = standalone ? t("offline.standalone") : t("offline.demo");
    banner.hidden = navigator.onLine !== false;
  };
  window.addEventListener("online", net);
  window.addEventListener("offline", net);
  net();

  window.addEventListener("hashchange", route);
  const firstPersona = parsePatientRoute(location.hash).persona || PERSONAS[0].id;
  const initialFrameToken = !standalone && firstPersona === state.demo ? setDemoAppLoading() : null;
  route();
  if (initialFrameToken !== null) setTimeout(() => clearDemoAppLoading(initialFrameToken), DEMO_LOAD_MS);

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/patient/sw.js", { scope: "/patient/" }).catch(() => {
      /* offline mode unavailable; the app still works online */
    });
  }
}

function doDelete(message = t("dialog.deleteDone")) {
  clearAll();
  state = emptyState();
  $("#trials-list").replaceChildren();
  $("#trials-status").textContent = "";
  for (const el of $$("[data-send-status], [data-demo-status]")) el.textContent = "";
  $("#save-status").textContent = message;
  go(standalone ? "#qp-1" : `#${PERSONAS[0].id}/qp-1`);
}

init();
