// Pure scoring and export logic for the patient symptom check.
// No DOM access here, so node:test can import it directly.
// Scores never depend on the language. The describe* functions take a translator (i18n.js) and default
// to English; the QuestionnaireResponse is always built in English, for the clinician.

import {
  CHANGE,
  CHECKS,
  CHECK_ORDER,
  PCFS,
  PEM,
  QUESTIONNAIRE_URL,
  QUESTIONNAIRE_VERSION,
  RECOVER,
  changeWording,
  checkApplies,
  pcfsApplies,
  recoverIndexApplies,
} from "./instruments.js";
import { EN_T, formatDateIn } from "./i18n.js";

const CS = "https://undiagnosednomore.org/fhir/CodeSystem";

/** "2024-02-20" -> "February 20, 2024" (or "20 de febrero de 2024" with lang "es"). Returns "" for anything else. */
export function formatDate(iso, lang = "en") {
  return formatDateIn(iso, lang);
}

/** Local calendar date as YYYY-MM-DD. */
export function isoToday(now = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

function isYes(v) {
  return v === true || v === "yes";
}
function isAnswered(v) {
  return v === true || v === false || v === "yes" || v === "no";
}
function isScaleValue(v) {
  return Number.isInteger(v) && v >= 0 && v <= 4;
}

// ---------- Part A. RECOVER 2024 index ----------

/**
 * Sum RECOVER 2024 points over the symptoms answered "yes".
 * category: "not-started" (nothing answered), "incomplete" (some but not all
 * symptoms answered: no range is given, because every unanswered symptom could
 * add points), or, once every symptom is answered, the published index ranges
 * "none" (0 points), "possible" (1 to 10), "likely" (11 or more).
 * meetsCutoff is true once the points so far reach 11 (more answers can only add).
 */
export function scoreRecover(answers = {}) {
  let points = 0;
  let answeredCount = 0;
  const yesItems = [];
  for (const item of RECOVER.items) {
    const v = answers[item.id];
    if (isAnswered(v)) answeredCount += 1;
    if (isYes(v)) {
      points += item.points;
      yesItems.push({ id: item.id, name: item.name, points: item.points, severity: Boolean(item.severity) });
    }
  }
  let category;
  if (answeredCount === 0) category = "not-started";
  else if (answeredCount < RECOVER.items.length) category = "incomplete";
  else if (points >= RECOVER.cutoff) category = "likely";
  else if (points >= 1) category = "possible";
  else category = "none";
  return {
    points,
    maxPoints: RECOVER.items.reduce((s, i) => s + i.points, 0),
    answeredCount,
    itemCount: RECOVER.items.length,
    complete: answeredCount === RECOVER.items.length,
    meetsCutoff: points >= RECOVER.cutoff,
    category,
    yesItems,
  };
}

// ---------- Part B. DePaul PEM short form ----------

/**
 * Published rule (Cotler et al. 2018, Appendix B, step 1): positive if on at
 * least one of items 1-5 frequency >= 2 and severity >= 2.
 * status: "positive", "negative" (all 5 answered, none qualifies),
 * "incomplete" (some answered, none qualifies yet), "not-started".
 */
export function screenPem(pem = {}) {
  const qualifying = [];
  let answered = 0;
  for (const item of PEM.items) {
    const a = pem[item.n] || pem[String(item.n)] || {};
    const f = a.frequency;
    const s = a.severity;
    if (isScaleValue(f) && isScaleValue(s)) {
      answered += 1;
      if (f >= 2 && s >= 2) qualifying.push(item.n);
    }
  }
  let status;
  if (qualifying.length > 0) status = "positive";
  else if (answered === PEM.items.length) status = "negative";
  else if (answered === 0) status = "not-started";
  else status = "incomplete";
  return { status, qualifyingItems: qualifying, answered, itemCount: PEM.items.length };
}

/**
 * The PEM items ask about the past 6 months. If the person's COVID-19
 * infection was less than 6 months before the answer date, return the
 * infection date so the result can show it (the question is not changed).
 */
export function pemTimeframeNote(timeline = {}, answeredOn) {
  if (timeline.covid !== "yes" || !timeline.covidDate || !answeredOn) return null;
  const a = new Date(`${timeline.covidDate}T00:00:00Z`);
  const b = new Date(`${answeredOn}T00:00:00Z`);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime()) || a > b) return null;
  const sixMonthsAfter = new Date(a);
  sixMonthsAfter.setUTCMonth(sixMonthsAfter.getUTCMonth() + 6);
  if (b >= sixMonthsAfter) return null;
  return { covidDate: timeline.covidDate, covidDateText: formatDate(timeline.covidDate) };
}

// ---------- Part C. PCFS ----------

/** Grade 0-4 with its published label, or null if not answered. */
export function gradePcfs(choice) {
  const g = typeof choice === "string" && choice !== "" ? Number(choice) : choice;
  const opt = PCFS.options.find((o) => o.grade === g);
  return opt ? { grade: opt.grade, label: opt.label, text: opt.text } : null;
}

// ---------- Demo triage rule (questionnaire file) ----------

/**
 * Exploratory rule, not evaluated (no data yet on how many people it flags or misses): flag for clinician
 * review if the chart band is High, or RECOVER >= 11, or the PEM screen is positive. Never combines the
 * numbers into one score. RECOVER counts once its points reach 11, even before every symptom is answered,
 * because more answers can only add points. covid: the "Has had COVID-19" answer; after "no" the RECOVER
 * index does not apply.
 */
export function triage({ chartBands = [], recover, pem, covid } = {}) {
  const reasons = [];
  if (chartBands.includes("High")) reasons.push("record");
  if (recover && recoverIndexApplies(covid) && recover.points >= RECOVER.cutoff) reasons.push("recover");
  if (pem && pem.status === "positive") reasons.push("pem");
  return { flag: reasons.length > 0, reasons };
}

// ---------- Plain-language result text ----------

export const TRIAGE_EXPLORATORY = EN_T("triage.exploratory");

export const RECOVER_NOT_SCORED = EN_T("recover.notScored");

/**
 * covid: the "Has had COVID-19" answer. After "no", only the symptoms are
 * described: no points, no range, no Long COVID wording.
 */
export function describeRecover(r, covid, t = EN_T) {
  if (r.category === "not-started") {
    return { headline: t("result.notAnsweredYet"), body: t("recover.notStarted.body"), short: t("result.notAnswered") };
  }
  const names = r.yesItems.map((i) => t(`recover.item.${i.id}.name`));
  if (!recoverIndexApplies(covid)) {
    const n = r.yesItems.length;
    return {
      headline: n ? t.n("recover.unscored.headline", n) : t("recover.unscored.headlineNone"),
      body: t("recover.notScored"),
      short: `${n ? t("recover.markedYes", { list: names.join(", ") }) : t("recover.noneMarked")} ${t("recover.unscored.short")}`,
      scored: false,
    };
  }
  const severity = r.yesItems.some((i) => i.severity) ? ` ${t("recover.severityNote")}` : "";
  const severityShort = severity ? ` ${t("recover.severityShort")}` : "";
  const pts = t.n("recover.points", r.points);
  if (r.category === "incomplete") {
    const params = { pts, answered: r.answeredCount, total: r.itemCount, max: r.maxPoints };
    return {
      headline: t("recover.incomplete.headline", params),
      body: `${t.n("recover.incomplete.body", r.itemCount - r.answeredCount, params)}${severity}`,
      short: `${t("recover.incomplete.short", params)}${severityShort}`,
    };
  }
  const body = t(`recover.${r.category}.body`, { pts });
  const short = r.category === "none" ? t("recover.noneMarked") : t("recover.scored.short", { pts, max: r.maxPoints });
  return { headline: t("recover.scored.headline", { pts, max: r.maxPoints }), body: body + severity, short: short + severityShort };
}

export function describePem(p, timeframe, t = EN_T) {
  const tf = timeframe ? ` ${t("pem.timeframe", { date: t.date(timeframe.covidDate) })}` : "";
  if (p.status === "positive") {
    const nums = p.qualifyingItems;
    const which = nums.length === 1 ? t("pem.whichOne", { n: nums[0] }) : t("pem.whichMany", { list: t.list(nums) });
    return {
      headline: t("pem.positive.headline"),
      body: `${t("pem.positive.body", { which })}${tf}`,
      short: `${t("pem.positive.short", { which })}${tf}`,
    };
  }
  if (p.status === "negative") {
    return {
      headline: t("pem.negative.headline"),
      body: `${t("pem.negative.body")}${tf}`,
      short: `${t("pem.negative.short")}${tf}`,
    };
  }
  if (p.status === "incomplete") {
    const params = { answered: p.answered, total: p.itemCount };
    return {
      headline: t("result.notFinished"),
      body: `${t("pem.incomplete.body", params)}${tf}`,
      short: t("pem.incomplete.short", params),
    };
  }
  return { headline: t("result.notAnsweredYet"), body: t("result.notAnsweredBody"), short: t("result.notAnswered") };
}

export function describePcfs(g, t = EN_T) {
  if (!g) return { headline: t("result.notAnsweredYet"), body: t("pcfs.notStarted.body"), short: t("result.notAnswered") };
  const params = { grade: g.grade, label: t(`pcfs.grade.${g.grade}.label`) };
  return {
    headline: t("pcfs.result.headline", params),
    body: t("pcfs.result.body", params),
    short: t("pcfs.result.short", params),
  };
}

// ---------- Part E. Condition self-checks ----------

const ynu = (v) => (v === "yes" || v === "no" || v === "unsure" ? v : null);

/** Which self-checks the person chose and that apply (the Long COVID check needs COVID-19 "Yes" or "Not sure"). */
export function chosenChecks(checks = {}, covid) {
  const chosen = checks.chosen || {};
  return CHECK_ORDER.filter((id) => chosen[id] && checkApplies(id, covid));
}

/** NASEM 2024: symptoms present for at least 3 months after infection. */
export function checkLongCovid(a = {}) {
  const v = ynu(a.duration);
  if (!v) return { status: "not-started" };
  return { status: v === "yes" ? "match" : v === "no" ? "no-match" : "unsure", duration: v };
}

/**
 * IOM 2015: reduced activity for more than 6 months with fatigue, post-exertional malaise, and unrefreshing
 * sleep, plus cognitive impairment or orthostatic intolerance. PEM comes from the DePaul screen (Part B).
 * "match" when every required answer is yes; "no-match" as soon as a required part is answered no;
 * otherwise "incomplete".
 */
export function checkMecfs(a = {}, pemScreen = { status: "not-started" }) {
  const v = Object.fromEntries(CHECKS.mecfs.items.map((it) => [it.id, ynu(a[it.id])]));
  const answered = Object.values(v).filter(Boolean).length;
  const pem = pemScreen.status === "positive" ? "yes" : pemScreen.status === "negative" ? "no" : null;
  const parts = {
    reduction: v.reduction,
    pem,
    sleep: v.sleep,
    cognitiveOrOrthostatic: v.cognitive === "yes" || v.orthostatic === "yes" ? "yes" : v.cognitive === "no" && v.orthostatic === "no" ? "no" : null,
  };
  let status;
  if (!answered) status = "not-started";
  else if (Object.values(parts).every((x) => x === "yes")) status = "match";
  else if (Object.values(parts).some((x) => x === "no")) status = "no-match";
  else status = "incomplete";
  return { status, parts, answered };
}

/**
 * 2016 revised fibromyalgia criteria: Widespread Pain Index (WPI, 0-19), Symptom Severity Scale (SSS, 0-12),
 * generalized pain in at least 4 of 5 regions, symptoms at a similar level for at least 3 months.
 * Criteria pattern: (WPI >= 7 and SSS >= 5, or WPI 4-6 and SSS >= 9), regions >= 4, and duration "yes".
 */
export function scoreFibro(f = {}) {
  const F = CHECKS.fibro;
  const areas = f.areas || {};
  const painful = F.areas.filter((a) => areas[a.id] === true);
  const wpi = painful.length;
  const regions = new Set(painful.map((a) => a.region).filter(Boolean)).size;
  const sev = f.severity || {};
  const six = f.sixMonths || {};
  const sevVals = F.severityItems.map((it) => sev[it.id]).filter((x) => Number.isInteger(x) && x >= 0 && x <= 3);
  const sixVals = F.sixMonthsItems.map((it) => six[it.id]).filter((x) => x === "yes" || x === "no");
  const sss = sevVals.reduce((t, x) => t + x, 0) + sixVals.filter((x) => x === "yes").length;
  const duration = ynu(f.duration);
  const started = wpi > 0 || sevVals.length > 0 || sixVals.length > 0 || duration !== null;
  const complete = sevVals.length === F.severityItems.length && sixVals.length === F.sixMonthsItems.length && duration !== null;
  const scoreRule = (wpi >= 7 && sss >= 5) || (wpi >= 4 && wpi <= 6 && sss >= 9);
  const criteriaMet = complete && scoreRule && regions >= 4 && duration === "yes";
  let status;
  if (!started) status = "not-started";
  else if (!complete) status = "incomplete";
  else status = criteriaMet ? "match" : "no-match";
  return { status, wpi, sss, regions, severity: wpi + sss, duration, painful: painful.map((a) => a.label), complete, criteriaMet };
}

const scaleValue = (v) => {
  const n = typeof v === "string" && /^[0-3]$/u.test(v) ? Number(v) : v;
  return Number.isInteger(n) && n >= 0 && n <= 3 ? n : null;
};

/**
 * PHQ-9 or GAD-7 (id "phq9" or "gad7"): each item 0 to 3, summed. The total and the published severity band are
 * given only when every item is answered. status: "not-started", "incomplete", or "complete". For the PHQ-9 also
 * the difficulty answer (not scored) and item 9 (thoughts of self-harm), which counts as soon as it is answered.
 */
export function scoreScale(id, a = {}) {
  const C = CHECKS[id];
  const values = C.items.map((it) => scaleValue(a[it.id]));
  const answered = values.filter((v) => v !== null).length;
  const complete = answered === C.items.length;
  const total = complete ? values.reduce((s, v) => s + v, 0) : null;
  const band = complete ? C.bands.find((b) => total >= b.min && total <= b.max) : null;
  const difficulty = C.difficulty && C.difficulty.some((o) => o.code === a.difficulty) ? a.difficulty : null;
  const status = complete ? "complete" : answered || difficulty ? "incomplete" : "not-started";
  const out = { id, status, answered, itemCount: C.items.length, total, max: C.max, band: band ? { ...band } : null };
  if (C.selfHarmItem) {
    out.selfHarm = values[C.items.findIndex((it) => it.id === C.selfHarmItem)];
    out.selfHarmPositive = out.selfHarm !== null && out.selfHarm > 0;
    out.difficulty = difficulty;
  }
  return out;
}

export const scorePhq9 = (a) => scoreScale("phq9", a);
export const scoreGad7 = (a) => scoreScale("gad7", a);

/** PHQ-9 item 9 answered with anything other than "Not at all" (0). */
export function phq9SelfHarm(a = {}) {
  return scorePhq9(a).selfHarmPositive;
}

/**
 * The crisis-line message shown when PHQ-9 item 9 is positive. Plain strings from the string tables, so it shows
 * offline; links are [label](href) rich text (tel:, sms:, and 988lifeline.org). "spanish" is empty in English.
 */
export function crisisText(t = EN_T) {
  return { heading: t("crisis.heading"), body: t("crisis.body"), spanish: t("crisis.spanish"), emergency: t("crisis.emergency") };
}

/** Lyme exposure questions: not scored; reports what was said. */
export function checkLyme(a = {}) {
  const v = Object.fromEntries(CHECKS.lyme.items.map((it) => [it.id, ynu(a[it.id])]));
  const answered = Object.values(v).filter(Boolean).length;
  return {
    status: answered ? "answered" : "not-started",
    exposure: v.tick === "yes" || v.outdoors === "yes",
    rash: v.rash === "yes",
    answers: v,
  };
}

export function describeCheck(id, r, t = EN_T) {
  if (!r || r.status === "not-started") return { headline: t("result.notAnsweredYet"), body: t("result.notAnsweredBody"), short: t("result.notAnswered") };
  if (id === "longcovid") {
    const key = { match: "match", "no-match": "noMatch", unsure: "unsure" }[r.status];
    const headline = t(`check.longcovid.${key}.headline`);
    return { headline, body: t(`check.longcovid.${key}.body`), short: t("check.longcovid.short", { headline }) };
  }
  if (id === "mecfs") {
    if (r.status === "match") return { headline: t("check.match.headline"), body: t("check.mecfs.match.body"), short: t("check.mecfs.match.short") };
    if (r.status === "no-match") return { headline: t("check.mecfs.noMatch.headline"), body: t("check.mecfs.noMatch.body"), short: t("check.mecfs.noMatch.short") };
    return { headline: t("result.notFinished"), body: t("check.mecfs.incomplete.body"), short: t("check.notFinishedShort") };
  }
  if (id === "fibro") {
    if (r.status === "incomplete") return { headline: t("result.notFinished"), body: t("check.fibro.incomplete.body"), short: t("check.fibro.incomplete.short", { wpi: r.wpi }) };
    const scores = t("check.fibro.scores", { wpi: r.wpi, sss: r.sss, regions: r.regions });
    if (r.status === "match") return { headline: t("check.match.headline"), body: t("check.fibro.match.body", { scores }), short: t("check.fibro.match.short", { scores }) };
    const lasted = r.duration === "yes" ? t("check.fibro.lasted") : "";
    return { headline: t("check.fibro.noMatch.headline"), body: t("check.fibro.noMatch.body", { scores, lasted }), short: t("check.fibro.noMatch.short", { scores }) };
  }
  if (id === "lyme") {
    const lines = [];
    if (r.answers.tick === "yes") lines.push(t("check.lyme.tick"));
    if (r.answers.outdoors === "yes") lines.push(t("check.lyme.outdoors"));
    if (r.answers.rash === "yes") lines.push(t("check.lyme.rash"));
    const said = lines.length ? t("check.lyme.said", { list: lines.join("; ") }) : t("check.lyme.saidNone");
    const extra = r.rash ? ` ${t("check.lyme.rashVisit")}` : "";
    return {
      headline: r.exposure || r.rash ? t("check.lyme.exposure.headline") : t("check.lyme.none.headline"),
      body: `${said}${extra} ${t("check.lyme.notScored")}`,
      short: lines.length ? t("check.lyme.reported", { list: lines.join("; ") }) : t("check.lyme.reportedNone"),
    };
  }
  if (id === "phq9" || id === "gad7") return describeScale(id, r, t);
  return { headline: "", body: "", short: "" };
}

/** PHQ-9 or GAD-7 result: the total and the published severity band in the instrument's words. */
function describeScale(id, r, t) {
  const C = CHECKS[id];
  const extra = [];
  const shortExtra = [];
  if (id === "phq9") {
    const opt = (v) => t(`checks.scale.option.${v}`);
    if (r.selfHarm !== null && r.selfHarm !== undefined) shortExtra.push(t("check.phq9.item9", { answer: opt(r.selfHarm) }));
    if (r.difficulty) {
      const line = t("check.phq9.difficulty", { answer: t(`checks.phq9.difficulty.${r.difficulty}`) });
      extra.push(line);
      shortExtra.push(line);
    }
  }
  const tail = shortExtra.length ? ` ${shortExtra.join(" ")}` : "";
  if (r.status !== "complete") {
    const params = { answered: r.answered, total: r.itemCount };
    return {
      headline: t("result.notFinished"),
      body: t("check.scale.incomplete.body", params),
      short: `${t("check.scale.incomplete.short", params)}${tail}`,
      extra,
    };
  }
  const band = t(`checks.${id}.band.${r.band.code}`);
  const params = { name: C.name, total: r.total, max: r.max, band, range: t("check.scale.range", { lo: r.band.min, hi: r.band.max }) };
  return {
    headline: t("check.scale.headline", params),
    body: `${t("check.scale.body", params)} ${t("check.scale.discuss")}`,
    short: `${t("check.scale.short", params)}${tail}`,
    extra,
  };
}

// ---------- FHIR R4 QuestionnaireResponse ----------

function coding(system, code, display) {
  return { valueCoding: { system: `${CS}/${system}`, code: String(code), display } };
}

function group(linkId, text, items) {
  const kept = items.filter(Boolean);
  return kept.length ? { linkId, text, item: kept } : null;
}

function answerItem(linkId, text, answer) {
  return answer ? { linkId, text, answer: [answer] } : null;
}

const DEFAULT_INCLUDE = { timeline: true, recover: true, pem: true, pcfs: true, change: true, checks: true, questions: true };

/**
 * Build a FHIR R4 QuestionnaireResponse from the saved answers.
 * include: which sections to keep (the person can leave sections out).
 * Unanswered items and empty groups are omitted.
 */
export function buildQuestionnaireResponse(state = {}, { authored, include = {} } = {}) {
  const inc = { ...DEFAULT_INCLUDE, ...include };
  const t = state.timeline || {};
  const items = [];

  if (inc.timeline) {
    const covidLabels = { yes: "Yes", no: "No", unsure: "Not sure" };
    items.push(
      group("timeline", "Symptom timeline", [
        answerItem(
          "timeline.respondent",
          "Who answered these questions",
          state.respondent === "caregiver"
            ? coding("respondent", "caregiver", "A caregiver, answering for the patient")
            : state.respondent === "self"
              ? coding("respondent", "self", "The patient")
              : null,
        ),
        answerItem("timeline.onset", "When symptoms started", t.onset ? { valueDate: t.onset } : null),
        answerItem(
          "timeline.covid",
          "Has had COVID-19",
          covidLabels[t.covid] ? coding("yes-no-unsure", t.covid, covidLabels[t.covid]) : null,
        ),
        answerItem(
          "timeline.covid-date",
          "Date of COVID-19 infection",
          t.covid === "yes" && t.covidDate ? { valueDate: t.covidDate } : null,
        ),
        answerItem(
          "timeline.symptoms",
          "Main symptoms, in the patient's words",
          t.symptoms && t.symptoms.trim() ? { valueString: t.symptoms.trim() } : null,
        ),
      ]),
    );
  }

  if (inc.recover) {
    const r = scoreRecover(state.recover || {});
    const children = RECOVER.items.map((it) => {
      const v = (state.recover || {})[it.id];
      return answerItem(`recover.${it.id}`, it.name, isAnswered(v) ? { valueBoolean: isYes(v) } : null);
    });
    if (r.answeredCount > 0 && recoverIndexApplies(t.covid)) {
      children.push(
        answerItem("recover.score", "RECOVER 2024 index points (calculated)", { valueInteger: r.points }),
        answerItem(
          "recover.category",
          "RECOVER 2024 index range (calculated; research index, not a diagnosis)",
          coding("recover-2024-range", r.category, {
            likely: "11 or more points",
            possible: "1 to 10 points",
            none: "0 points",
            incomplete: `Incomplete: ${r.answeredCount} of ${r.itemCount} symptoms answered; no range until all are answered`,
          }[r.category]),
        ),
      );
    }
    items.push(group("recover", RECOVER.title, children));
  }

  if (inc.pem) {
    const pem = state.pem || {};
    const children = PEM.items.map((it) => {
      const a = pem[it.n] || pem[String(it.n)] || {};
      const f = PEM.frequency.find((o) => o.value === a.frequency);
      const s = PEM.severity.find((o) => o.value === a.severity);
      return group(`pem.${it.n}`, it.text, [
        answerItem(`pem.${it.n}.frequency`, PEM.frequencyQuestion, f ? coding("dsq-frequency", f.value, f.label) : null),
        answerItem(`pem.${it.n}.severity`, PEM.severityQuestion, s ? coding("dsq-severity", s.value, s.label) : null),
      ]);
    });
    const d = PEM.duration.options.find((o) => o.code === state.pemDuration);
    children.push(answerItem("pem.duration", PEM.duration.question, d ? coding("dsq-pem-duration", d.code, d.plain) : null));
    const screen = screenPem(pem);
    if (screen.status === "positive" || screen.status === "negative") {
      children.push(
        answerItem("pem.screen", "Meets the published DePaul PEM screening rule (calculated)", {
          valueBoolean: screen.status === "positive",
        }),
      );
    }
    items.push(group("pem", PEM.title, children));
  }

  if (inc.pcfs && pcfsApplies(t.covid)) {
    const g = gradePcfs(state.pcfs);
    items.push(
      group("pcfs", PCFS.title, [
        answerItem("pcfs.grade", PCFS.question, g ? coding("pcfs-grade", g.grade, g.label) : null),
      ]),
    );
  }

  if (inc.change) {
    const ch = state.change || {};
    items.push(
      group(
        "change",
        `${changeWording(t.covid).title} (not scored)`,
        CHANGE.items.map((it) => {
          const o = CHANGE.options.find((x) => x.code === (ch[it.n] || ch[String(it.n)]));
          return answerItem(`change.${it.n}`, `${changeWording(t.covid).stem} ${it.text}`, o ? coding("change-since-covid", o.code, o.label) : null);
        }),
      ),
    );
  }

  if (inc.checks) {
    const ck = state.checks || {};
    const yn = (v) => (ynu(v) ? coding("yes-no-unsure", v, { yes: "Yes", no: "No", unsure: "Not sure" }[v]) : null);
    const resultCoding = (id, r) =>
      r.status === "not-started" ? null : coding("self-check-result", r.status, describeCheck(id, r).short);
    const groups = chosenChecks(ck, t.covid).map((id) => {
      const C = CHECKS[id];
      const a = ck[id] || {};
      if (id === "longcovid") {
        return group("checks.longcovid", C.title, [
          answerItem("checks.longcovid.duration", C.items[0].text, yn(a.duration)),
          answerItem("checks.longcovid.result", "Self-check result (calculated)", resultCoding(id, checkLongCovid(a))),
        ]);
      }
      if (id === "mecfs") {
        const r = checkMecfs(a, screenPem(state.pem || {}));
        return group("checks.mecfs", C.title, [
          ...C.items.map((it) => answerItem(`checks.mecfs.${it.id}`, it.text, yn(a[it.id]))),
          answerItem("checks.mecfs.result", "Self-check result with the DePaul PEM screen (calculated)", resultCoding(id, r)),
        ]);
      }
      if (id === "fibro") {
        const r = scoreFibro(a);
        const areas = C.areas.filter((x) => (a.areas || {})[x.id] === true);
        const sev = a.severity || {};
        const six = a.sixMonths || {};
        const areaItem = areas.length
          ? { linkId: "checks.fibro.areas", text: C.areasQuestion, answer: areas.map((x) => coding("fibro-area", x.id, x.label)) }
          : null;
        return group("checks.fibro", C.title, [
          areaItem,
          ...C.severityItems.map((it) => {
            const o = C.severity.find((x) => x.value === sev[it.id]);
            return answerItem(`checks.fibro.${it.id}`, `${C.severityQuestion} ${it.text}`, o ? coding("fibro-severity", o.value, o.label) : null);
          }),
          ...C.sixMonthsItems.map((it) => answerItem(`checks.fibro.${it.id}`, `${C.sixMonthsQuestion} ${it.text}`, six[it.id] === "yes" || six[it.id] === "no" ? yn(six[it.id]) : null)),
          answerItem("checks.fibro.duration", C.durationQuestion, yn(a.duration)),
          r.status === "not-started" ? null : answerItem("checks.fibro.wpi", "Widespread Pain Index, 0 to 19 (calculated)", { valueInteger: r.wpi }),
          r.complete ? answerItem("checks.fibro.sss", "Symptom Severity Scale, 0 to 12 (calculated)", { valueInteger: r.sss }) : null,
          r.status === "not-started" ? null : answerItem("checks.fibro.regions", "Body regions with pain, of 5 (calculated)", { valueInteger: r.regions }),
          answerItem("checks.fibro.result", "Self-check result (calculated)", resultCoding(id, r)),
        ]);
      }
      if (id === "lyme") {
        return group("checks.lyme", `${C.title} (not scored)`, C.items.map((it) => answerItem(`checks.lyme.${it.id}`, it.text, yn(a[it.id]))));
      }
      if (id === "phq9" || id === "gad7") {
        const r = scoreScale(id, a);
        const opt = (v) => {
          const o = C.options.find((x) => x.value === scaleValue(v));
          return o ? coding("phq-frequency", o.value, o.label) : null;
        };
        const d = C.difficulty && C.difficulty.find((x) => x.code === a.difficulty);
        const band = r.band ? `${r.band.min} to ${r.band.max}: ${r.band.label}` : null;
        return group(`checks.${id}`, C.fullName, [
          ...C.items.map((it) => answerItem(`checks.${id}.${it.id}`, `${C.stem} ${it.text}`, opt(a[it.id]))),
          d ? answerItem(`checks.${id}.difficulty`, C.difficultyQuestion, coding("phq-difficulty", d.code, d.label)) : null,
          r.status === "complete" ? answerItem(`checks.${id}.total`, `${C.name} total score, 0 to ${C.max} (calculated)`, { valueInteger: r.total }) : null,
          r.status === "complete"
            ? answerItem(`checks.${id}.band`, `${C.name} severity, published cutpoints (calculated; not a diagnosis)`, coding(`${id}-severity`, r.band.code, band))
            : null,
        ]);
      }
      return null;
    });
    items.push(group("checks", `${CHECKS.title} (patient self-checks against published criteria and questionnaires; not a diagnosis)`, groups));
  }

  if (inc.questions) {
    const qs = (state.questions || []).map((q) => String(q || "").trim()).filter(Boolean);
    items.push(
      group(
        "questions",
        "Questions to ask my clinician",
        qs.map((q, i) => answerItem(`questions.${i + 1}`, "Question", { valueString: q })),
      ),
    );
  }

  const kept = items.filter(Boolean);
  const r = scoreRecover(state.recover || {});
  const complete =
    r.complete && ["positive", "negative"].includes(screenPem(state.pem || {}).status) && (gradePcfs(state.pcfs) !== null || !pcfsApplies(t.covid));

  const qr = {
    resourceType: "QuestionnaireResponse",
    meta: {
      tag: [{ system: `${CS}/source`, code: "patient-reported", display: "Patient reported" }],
    },
    questionnaire: `${QUESTIONNAIRE_URL}|${QUESTIONNAIRE_VERSION}`,
    status: complete ? "completed" : "in-progress",
    authored: authored || new Date().toISOString(),
    source: {
      display: state.respondent === "caregiver" ? "Caregiver answering for the patient" : "Patient",
    },
  };
  if (kept.length) qr.item = kept;
  return qr;
}

/** Every linkId in a QuestionnaireResponse, depth first. */
export function linkIds(qr) {
  const out = [];
  const walk = (items) => {
    for (const it of items || []) {
      out.push(it.linkId);
      walk(it.item);
    }
  };
  walk(qr.item);
  return out;
}
