// Model scorer: evaluates a model file (docs/interface/model_spec.md) on a FHIR R4 bundle.
//
// Exact port of model/reference/score_fhir.py, the ground truth. Test vectors in
// model/test_vectors/ are produced by the Python file and checked by web/test/scorer.test.js.
// No dependencies; runs in the browser and in Node.
//
// Dates are calendar dates handled as "YYYY-MM-DD" strings (the first 10 characters of a FHIR
// date or dateTime, as in the Python `_date`) and converted to UTC day numbers for arithmetic,
// so the result never depends on the viewer's time zone.

export const ICD10 = "http://hl7.org/fhir/sid/icd-10-cm";
export const SNOMED = "http://snomed.info/sct";
export const LOINC = "http://loinc.org";
export const RXNORM = "http://www.nlm.nih.gov/research/umls/rxnorm";
export const CPT = "http://www.ama-assn.org/go/cpt";
export const ICD10PCS = "http://www.cms.gov/Medicare/Coding/ICD10";
// HL7 v3 ObservationInterpretation; SNOMED Positive, Detected
export const POSITIVE_INTERP = new Set(["POS", "DET", "H", "10828004", "260373001"]);
// Negative, Not detected
export const NEGATIVE_INTERP = new Set(["NEG", "ND", "N", "260385009", "260415000"]);
export const NEGATION = ["not ", "no ", "none", "negative", "undetected", "non-reactive", "nonreactive", "non reactive"];
/** Every model covers adults: age in years on day 0, as days / 365.25 (the training cohort's rule). */
export const MIN_AGE_YEARS = 18;
/** Condition.verificationStatus codes whose records are ignored everywhere. */
export const EXCLUDED_VERIFICATION = new Set(["refuted", "entered-in-error"]);
/** Resource types every model's eligibility rules read. */
export const ELIGIBILITY_RESOURCES = ["Patient", "Condition", "Encounter"];

// ---------------------------------------------------------------- Python semantics helpers

const isDict = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** Python truthiness for JSON values. */
function truthy(v) {
  if (v === null || v === undefined || v === false || v === 0 || v === "") return false;
  if (Array.isArray(v)) return v.length > 0;
  if (isDict(v)) return Object.keys(v).length > 0;
  return Boolean(v); // NaN is truthy in Python; Boolean(NaN) is false, but JSON has no NaN
}

/** Python str() for JSON scalars (None -> "None", True -> "True"). */
function pyStr(v) {
  if (v === null || v === undefined) return "None";
  if (v === true) return "True";
  if (v === false) return "False";
  return String(v);
}

/** dict.get(key, default) on a value that must be a dict. */
function get(obj, key, dflt = null) {
  return isDict(obj) && Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : dflt;
}

// ---------------------------------------------------------------- dates

const DAY_MS = 86400000;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const FHIR_DATE = /^([0-9]{4})(?:-([0-9]{2})(?:-([0-9]{2}))?)?/;

function daysInMonth(y, mo) {
  return [31, (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1];
}

/**
 * Python `_date` (used for the scoring date): falsy -> null; otherwise the first 10 characters of
 * String(value) must be a valid YYYY-MM-DD calendar date (Python 3.10 date.fromisoformat). Returns the
 * normalized "YYYY-MM-DD" string. Throws RangeError where Python raises ValueError.
 */
export function parseDate(value) {
  if (!truthy(value)) return null;
  if (value instanceof Date) return formatDay(Math.floor(value.getTime() / DAY_MS));
  const s = pyStr(value).slice(0, 10);
  const m = ISO_DATE.exec(s);
  if (!m) throw new RangeError(`Invalid isoformat string: '${s}'`);
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 1) throw new RangeError(`year ${y} is out of range`);
  if (mo < 1 || mo > 12) throw new RangeError("month must be in 1..12");
  if (d < 1 || d > daysInMonth(y, mo)) throw new RangeError("day is out of range for month");
  return s;
}

const pad = (n, w = 2) => String(n).padStart(w, "0");

/**
 * Python `fhir_date`: a FHIR date or dateTime as "YYYY-MM-DD", or null when it is missing or not a valid
 * FHIR date (never throws). A full date uses its first 10 characters. Partial dates: YYYY is read as
 * January 1 and YYYY-MM as the first of the month; for a birth date (`birth: true`), YYYY is read as July 1
 * and YYYY-MM as the 15th. A partial date followed by anything else, an impossible date, or year 0 is invalid.
 */
export function parseFhirDate(value, { birth = false } = {}) {
  if (value instanceof Date) return formatDay(Math.floor(value.getTime() / DAY_MS));
  if (typeof value !== "string" || !value) return null; // FHIR JSON dates are strings
  const s = value;
  const m = FHIR_DATE.exec(s);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), m[2] === undefined ? null : Number(m[2]), m[3] === undefined ? null : Number(m[3])];
  if (d === null && m[0].length !== s.length) return null;
  if (y < 1) return null;
  if (mo === null) return birth ? `${pad(y, 4)}-07-01` : `${pad(y, 4)}-01-01`;
  if (mo < 1 || mo > 12) return null;
  if (d === null) return `${pad(y, 4)}-${pad(mo)}-${birth ? "15" : "01"}`;
  if (d < 1 || d > daysInMonth(y, mo)) return null;
  return `${pad(y, 4)}-${pad(mo)}-${pad(d)}`;
}

/** UTC day number (days since 1970-01-01) of a "YYYY-MM-DD" string. */
export function dayNumber(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  const t = new Date(0);
  t.setUTCFullYear(y, m - 1, d); // setUTCFullYear keeps years 1..99 literal (Date.UTC does not)
  return Math.round(t.getTime() / DAY_MS);
}

function formatDay(n) {
  const t = new Date(n * DAY_MS);
  const y = String(t.getUTCFullYear()).padStart(4, "0");
  const m = String(t.getUTCMonth() + 1).padStart(2, "0");
  const d = String(t.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** (b - a).days for two "YYYY-MM-DD" strings. */
export function daysBetween(a, b) {
  return dayNumber(b) - dayNumber(a);
}

/** Today's calendar date in UTC as "YYYY-MM-DD". */
export function todayUTC() {
  return formatDay(Math.floor(Date.now() / DAY_MS));
}

const DATE_PATHS = [
  ["onsetDateTime"], ["onsetPeriod", "start"], ["recordedDate"], ["period", "start"],
  ["effectiveDateTime"], ["effectivePeriod", "start"], ["issued"], ["authoredOn"],
  ["performedDateTime"], ["performedPeriod", "start"], ["occurrenceDateTime"],
];

/** Date of a resource ("YYYY-MM-DD") from the first date field that holds a valid FHIR date, or null. */
export function resourceDate(r) {
  for (const path of DATE_PATHS) {
    let v = r;
    for (const k of path) v = isDict(v) ? get(v, k) : null;
    if (truthy(v)) {
      const d = parseFhirDate(v);
      if (d !== null) return d;
    }
  }
  return null;
}

// ---------------------------------------------------------------- code matching

export function codings(concept) {
  const c = get(truthy(concept) ? concept : {}, "coding", []);
  return truthy(c) ? c : [];
}

export function icd(code) {
  return pyStr(truthy(code) ? code : "").replaceAll(".", "").toUpperCase();
}

export function hasIcdPrefix(r, prefixes, field = "code") {
  const pre = (prefixes || []).map(icd);
  return codings(get(r, field)).some(
    (c) => get(c, "system") === ICD10 && pre.some((p) => icd(get(c, "code")).startsWith(p)),
  );
}

export function hasCode(r, system, codes, field = "code") {
  const set = new Set((codes || []).map(pyStr));
  return codings(get(r, field)).some((c) => get(c, "system") === system && set.has(pyStr(get(c, "code"))));
}

export function medMatches(r, codes) {
  const concept = get(r, "medicationCodeableConcept") || {};
  const rx = new Set(get(codes, "rxcui", []).map((c) => c.replaceAll("rxcui:", "")));
  if (rx.size && codings(concept).some((c) => get(c, "system") === RXNORM && rx.has(pyStr(get(c, "code"))))) {
    return true;
  }
  const names = get(codes, "rxnorm_ingredient_names", []).map((n) => n.toLowerCase());
  const text = [get(concept, "text"), ...codings(concept).map((c) => get(c, "display"))]
    .map(textPart).join(" ").toLowerCase();
  return names.length > 0 && names.some((n) => text.includes(n));
}

/** Python `_text`: a text part for matching; null or any other non-string JSON value counts as empty. */
function textPart(s) {
  return typeof s === "string" ? s : "";
}

export function matches(r, feat) {
  const rt = get(r, "resourceType");
  const codes = get(feat, "codes", {});
  if (rt !== get(feat, "resource")) return false;
  if (rt === "Condition") return hasIcdPrefix(r, get(codes, "icd10cm_prefix", []));
  if (rt === "Procedure") {
    return hasCode(r, CPT, get(codes, "cpt", [])) || hasCode(r, ICD10PCS, get(codes, "icd10pcs", []));
  }
  if (rt === "Observation") return hasCode(r, LOINC, get(codes, "loinc", []));
  if (rt === "MedicationRequest") return medMatches(r, codes);
  return false;
}

/** HL7 v3 ActCode of the encounter; virtual (VR) and home (HH) visits count as ambulatory (AMB). */
export function encounterClass(r) {
  let c = get(r, "class");
  if (Array.isArray(c)) c = c.length ? c[0] : {};
  if (isDict(c) && Object.prototype.hasOwnProperty.call(c, "coding")) {
    const cod = get(c, "coding");
    c = (truthy(cod) ? cod : [{}])[0];
  }
  const code = get(truthy(c) ? c : {}, "code");
  return code === "VR" || code === "HH" ? "AMB" : code;
}

/** True only for an explicitly positive result: interpretation code first, then value text without negation. */
export function testIsPositive(obs) {
  const codes = new Set();
  for (const concept of get(obs, "interpretation") || []) for (const c of codings(concept)) codes.add(pyStr(get(c, "code")));
  const val = get(obs, "valueCodeableConcept") || {};
  for (const c of codings(val)) codes.add(pyStr(get(c, "code")));
  for (const c of codes) if (NEGATIVE_INTERP.has(c)) return false;
  for (const c of codes) if (POSITIVE_INTERP.has(c)) return true;
  const text = [get(val, "text"), ...codings(val).map((c) => get(c, "display")), get(obs, "valueString")]
    .map(textPart).join(" ").toLowerCase().trim();
  if (!text || NEGATION.some((n) => text.includes(n))) return false;
  return text.includes("detected") || text.includes("positive");
}

/**
 * Earliest U07.1 Condition date on or after `earliest` ("YYYY-MM-DD", when given); positive SARS-CoV-2 tests
 * count only when the model enables them. Undated records cannot be an index event.
 */
export function findIndex(resources, usePositiveTests = false, testLoinc = [], earliest = null) {
  const dates = [];
  for (const r of resources) {
    if (get(r, "resourceType") === "Condition" && hasIcdPrefix(r, ["U071"])) dates.push(resourceDate(r));
    if (usePositiveTests && get(r, "resourceType") === "Observation" && testIsPositive(r)
        && codings(get(r, "code")).some((c) => get(c, "system") === LOINC && testLoinc.includes(get(c, "code")))) {
      dates.push(resourceDate(r));
    }
  }
  const ds = dates.filter((d) => d && (earliest === null || d >= earliest));
  return ds.length ? ds.reduce((a, b) => (b < a ? b : a)) : null;
}

/**
 * False for records that say they are wrong: a Condition whose verificationStatus is refuted or
 * entered-in-error, or any resource whose status is entered-in-error. Such records are ignored everywhere.
 */
export function usable(r) {
  if (get(r, "resourceType") === "Condition" && codings(get(r, "verificationStatus")).some(
    (c) => EXCLUDED_VERIFICATION.has(pyStr(truthy(get(c, "code")) ? get(c, "code") : "").toLowerCase()))) {
    return false;
  }
  return get(r, "status") !== "entered-in-error";
}

/** Resource types the model reads: [eligibility, features]. A failed search for any of them means it cannot score. */
export function requiredResources(model) {
  const elig = [...ELIGIBILITY_RESOURCES];
  if (truthy(get(get(model, "index_event", {}), "use_positive_tests"))) elig.push("Observation");
  const feats = [...new Set(model.features.filter((f) => truthy(get(f, "resource"))).map((f) => f.resource))]
    .filter((t) => !elig.includes(t))
    .sort();
  return [elig, feats];
}

/** Python bisect.bisect_left. */
function bisectLeft(xs, x) {
  let lo = 0, hi = xs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] < x) lo = mid + 1; else hi = mid;
  }
  return lo;
}

/** Piecewise-linear calibration, clamped at the ends. */
export function calibrate(score, points) {
  const xs = points.map((p) => p[0]);
  if (score <= xs[0]) return points[0][1];
  if (score >= xs[xs.length - 1]) return points[points.length - 1][1];
  const i = bisectLeft(xs, score);
  const [x0, y0] = points[i - 1], [x1, y1] = points[i];
  return y0 + (y1 - y0) * (score - x0) / (x1 - x0);
}

/** JSON with keys sorted at every level (json.dumps(sort_keys=True) up to whitespace). */
function sortedJson(v) {
  if (Array.isArray(v)) return `[${v.map(sortedJson).join(",")}]`;
  if (isDict(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${sortedJson(v[k])}`).join(",")}}`;
  return JSON.stringify(v);
}

/** Features equal in everything but id, label, weight, and threshold are nested thresholds. */
export function nestKey(f) {
  const rest = {};
  for (const [k, v] of Object.entries(f)) if (!["id", "label", "weight", "threshold"].includes(k)) rest[k] = v;
  return sortedJson(rest);
}

// ---------------------------------------------------------------- scoring

function couldNotScore(missing, day0 = null) {
  const out = { status: "could_not_score", reason: `could not score: ${missing.join(", ")} unavailable` };
  if (day0 !== null) out.index_date = day0;
  out.unavailable = [...missing];
  return out;
}

/**
 * Score a FHIR bundle with a model file.
 * @param {object} model   parsed model JSON (model/longcovid.json, model/chronicfatigue.json, ...)
 * @param {object} bundle  FHIR R4 Bundle with entry[].resource
 * @param {string} [asOf]  scoring date "YYYY-MM-DD" (default: today in UTC)
 * @param {object} [options]
 * @param {string[]} [options.unavailable]  resource types whose FHIR search failed or was forbidden; a model
 *   that reads one returns status "could_not_score" instead of treating the missing records as absent
 * @returns {object} same shape as score_fhir.score_bundle
 */
export function scoreBundle(model, bundle, asOf, { unavailable = [] } = {}) {
  asOf = truthy(asOf) ? parseDate(asOf) : todayUTC();
  const unread = new Set(unavailable || []);
  const missingFrom = (types) => types.filter((t) => unread.has(t));
  const [eligTypes, featTypes] = requiredResources(model);
  const missingElig = missingFrom(eligTypes);
  if (missingElig.length) return couldNotScore(missingElig);
  // records that say they are wrong are ignored, and so is everything dated after the scoring date
  const res = (get(bundle, "entry", []) || []).filter((e) => isDict(e) && "resource" in e).map((e) => e.resource)
    .filter((r) => {
      if (!usable(r)) return false;
      const d = resourceDate(r);
      return !(d !== null && d > asOf);
    });
  const patient = res.find((r) => get(r, "resourceType") === "Patient") || {};
  const ie = get(model, "index_event", {});
  const excl = model.exclusion.condition_codes;
  // a target diagnosis on or before the scoring date, or with no usable date, counts as already recorded
  const isExcl = (r) => get(r, "resourceType") === "Condition"
    && (hasIcdPrefix(r, get(excl, "icd10cm", [])) || hasCode(r, SNOMED, get(excl, "snomed", [])));
  const birth = parseFhirDate(get(patient, "birthDate"), { birth: true });
  const BIRTH = "birth date missing or unusable (age is required)";
  let day0;
  if (get(ie, "type") === "scoring_date") {
    // day 0 is the scoring date; a recorded target diagnosis means the patient is already visible
    day0 = asOf;
    if (birth === null) return { status: "not_scored", reason: BIRTH, index_date: day0 };
    if (daysBetween(birth, day0) / 365.25 < MIN_AGE_YEARS) {
      return { status: "not_scored", reason: "under 18 on the scoring date (the model covers adults)", index_date: day0 };
    }
    // a model fit in one sex (endometriosis: women) scores only that FHIR administrative gender
    const sex = get(get(model, "eligibility", {}), "sex");
    if (sex !== null && sex !== undefined && get(patient, "gender") !== sex) {
      return { status: "not_scored", reason: model.eligibility.reason, index_date: day0 };
    }
    if (res.some(isExcl)) return { status: "not_scored", reason: model.exclusion.reason, index_date: day0 };
  } else {
    const earliest = truthy(get(ie, "earliest_date")) ? parseDate(ie.earliest_date) : null;
    const useTests = get(ie, "use_positive_tests", false), loinc = get(ie, "positive_test_loinc", []);
    day0 = findIndex(res, useTests, loinc, earliest);
    if (day0 === null) {
      if (earliest !== null && findIndex(res, useTests, loinc) !== null) {
        return {
          status: "not_scored",
          reason: `no documented COVID-19 index event on or after ${earliest} (earlier COVID-19 diagnoses are outside the model's population)`,
        };
      }
      return { status: "not_scored", reason: "no documented COVID-19 index event" };
    }
    if (birth === null) return { status: "not_scored", reason: BIRTH, index_date: day0 };
    if (daysBetween(birth, day0) / 365.25 < MIN_AGE_YEARS) {
      return { status: "not_scored", reason: "under 18 at the COVID-19 index (the model covers adults)", index_date: day0 };
    }
    if (daysBetween(day0, asOf) < model.target.landmark_days) {
      return { status: "not_scored", reason: "fewer than 90 days since the COVID-19 index", index_date: day0 };
    }
    const hd = get(model.target, "horizon_days");
    const horizon = truthy(hd) ? hd[1] : null;
    if (horizon !== null && horizon !== undefined && daysBetween(day0, asOf) > horizon) {
      return {
        status: "not_scored",
        reason: `more than ${horizon} days since the COVID-19 index (outside the model's time window)`,
        index_date: day0,
      };
    }
    // any Long COVID code up to the scoring date, including before or on the index date, or undated
    if (res.some(isExcl)) return { status: "not_scored", reason: "a Long COVID diagnosis is already recorded", index_date: day0 };
  }
  const W = model.windows;
  const d0 = dayNumber(day0);
  const off = (r) => {
    const d = resourceDate(r);
    return d ? dayNumber(d) - d0 : null;
  };
  const inWindows = (o, wins) => o !== null && wins.some((w) => W[w][0] <= o && o <= W[w][1]);
  const inRange = (o, win) => o !== null && win[0] <= o && o <= win[1];

  const encounters = res.filter((r) => get(r, "resourceType") === "Encounter");
  const hist = get(model, "history_requirement");
  if (truthy(hist)) {
    const nHist = encounters.filter((e) => hist.encounter_class.includes(encounterClass(e)) && inWindows(off(e), [hist.window])).length;
    if (nHist < hist.min_count) return { status: "not_scored", reason: hist.reason, index_date: day0 };
  } else if (!encounters.some((e) => inWindows(off(e), ["W0", "W1"]))) {
    return { status: "not_scored", reason: "no encounters in the year before COVID-19 (insufficient history)", index_date: day0 };
  }
  const missingFeat = missingFrom(featTypes);
  if (missingFeat.length) return couldNotScore(missingFeat, day0);
  const age = daysBetween(birth, day0) / 365.25;

  const values = {}, evidence = {};
  const derived = [];
  for (const f of model.features) {
    const k = f.kind, fid = f.id;
    let v = 0, ev = [];
    if (k === "age_band") {
      v = Number(f.min <= age && age < f.max + 1);
    } else if (k === "sex") {
      v = Number(get(patient, "gender") === (f.value === undefined ? null : f.value));
    } else if (k === "any" || k === "new_onset") {
      const hits = res.filter((r) => matches(r, f));
      const pres = "window" in f
        ? hits.filter((r) => inRange(off(r), f.window))
        : hits.filter((r) => inWindows(off(r), f.present_in));
      const prior = k === "new_onset" ? hits.filter((r) => inWindows(off(r), get(f, "absent_in", []))) : [];
      v = Number(pres.length > 0 && prior.length === 0);
      ev = v ? pres : [];
    } else if (k === "encounter_any") {
      const pres = encounters.filter((e) => f.encounter_class.includes(encounterClass(e)) && inRange(off(e), f.window));
      v = Number(pres.length > 0);
      ev = pres;
    } else if (k === "encounter_count_ge") {
      const pres = encounters.filter((e) => f.encounter_class.includes(encounterClass(e)) && inWindows(off(e), f.windows));
      v = Number(pres.length >= f.threshold);
      ev = pres;
    } else if (k === "encounter_rate_ratio_ge") {
      const cnt = (w) => encounters.filter((e) => f.encounter_class.includes(encounterClass(e)) && inWindows(off(e), [w])).length;
      const nw = W[f.numerator], dw = W[f.denominator];
      const num = cnt(f.numerator), den = cnt(f.denominator);
      const rateNum = num / (nw[1] - nw[0] + 1), rateDen = den / (dw[1] - dw[0] + 1);
      v = Number((den === 0 && num > 0) || (den > 0 && rateNum / rateDen >= f.threshold));
    } else if (k === "cluster_count_ge") {
      const hits = [];
      for (const pre of Object.values(f.clusters)) {
        const first = res.find((r) => get(r, "resourceType") === "Condition" && hasIcdPrefix(r, pre) && inRange(off(r), f.window));
        if (first !== undefined) hits.push(first);
      }
      v = Number(hits.length >= f.threshold);
      ev = v ? hits : [];
    } else if (k === "derived_count_ge") {
      derived.push(f);
      continue;
    }
    values[fid] = v;
    evidence[fid] = ev;
  }
  for (const f of derived) {
    const parts = model.features
      .filter((g) => get(g, "group") === f.of_group && g.kind !== "derived_count_ge" && truthy(get(values, g.id, 0)))
      .map((g) => g.id);
    values[f.id] = Number(parts.length >= f.threshold);
    evidence[f.id] = values[f.id] ? parts.flatMap((g) => evidence[g].slice(0, 1)) : [];
  }

  // Python: intercept + sum(...), where sum is a plain left-to-right float sum starting at 0 (Python 3.10)
  let total = 0;
  for (const f of model.features) total += f.weight * values[f.id];
  const score = model.intercept + total;
  const prob = calibrate(score, model.calibration.points);
  const bandRow = model.risk_bands.find((b) => prob <= b.max_probability);
  if (!bandRow) throw new Error(`no risk band covers probability ${prob}`); // Python raises StopIteration
  const band = bandRow.name;

  // nested thresholds (same definition, different threshold) show as one driver: the highest
  // threshold present, carrying the summed contribution
  const shown = new Map();
  for (const f of model.features) {
    if (!values[f.id] || f.weight === 0) continue;
    const key = "threshold" in f ? nestKey(f) : f.id;
    const c = shown.get(key);
    if (c === undefined) {
      shown.set(key, { f, contribution: f.weight });
    } else {
      c.contribution += f.weight;
      if (f.threshold > c.f.threshold) c.f = f;
    }
  }
  const drivers = [...shown.values()].map((c) => ({
    id: c.f.id,
    label: "label" in c.f ? c.f.label : c.f.id,
    group: get(c.f, "group"),
    contribution: c.contribution,
    evidence: evidence[c.f.id].map((r) => {
      const d = resourceDate(r);
      return { resourceType: r.resourceType, id: get(r, "id"), date: d === null ? "None" : d };
    }),
  }));
  // sorted(key=-contribution): stable, ties keep insertion order
  drivers.sort((a, b) => (-a.contribution < -b.contribution ? -1 : -a.contribution > -b.contribution ? 1 : 0));
  return {
    status: "scored",
    index_date: day0,
    score,
    probability: prob,
    band,
    times_average: prob / model.reference.cohort_base_rate,
    features: values,
    drivers,
  };
}
