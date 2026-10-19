// Cost calculator for the Atlas (Long COVID). Pure functions, no DOM.
// Every quantity is a direct product of the inputs; nothing is added that the inputs do not imply.

export const DEFAULTS = Object.freeze({
  screened: 10000,          // post-COVID patients screened
  flagShare: 0.05,          // share of screened patients flagged by the model
  recall: 0.19,             // share of later-coded patients who are among the flags (Paper 1: 19% at the top 5%)
  ppv: 0.043,               // share of flags who are later coded (Paper 1: 4.3% at the top 5%)
  excessCost: 900,          // excess spending per later-coded patient before the code, dollars
  odysseyDays: 100,         // days over which that excess spending accrues
  leadDays: 55,             // how much earlier a flagged patient is recognized (Paper 1: median 55 days at the top 5%)
  avoidable: 0.30,          // fraction of the excess spending in the lead window that earlier recognition avoids
  reviewMinutes: 5,         // clinician chart-review minutes per reviewed flag
  clinicianHourly: 120,     // clinician cost per hour, dollars
  questionnairePass: 0.40,  // share of flagged patients who pass the questionnaire and reach a clinician
  questionnaireSensitivity: 0.8, // share of later-coded flagged patients who pass the questionnaire (assumption; 1 = best case)
});

const finite = (x, fallback) => (Number.isFinite(x) ? x : fallback);
const clamp01 = (x) => Math.min(1, Math.max(0, x));

export function normalize(inputs = {}) {
  const v = { ...DEFAULTS };
  for (const k of Object.keys(DEFAULTS)) v[k] = finite(Number(inputs[k] ?? DEFAULTS[k]), DEFAULTS[k]);
  for (const k of ["flagShare", "recall", "ppv", "avoidable", "questionnairePass", "questionnaireSensitivity"]) {
    v[k] = clamp01(v[k]);
  }
  for (const k of ["screened", "excessCost", "odysseyDays", "leadDays", "reviewMinutes", "clinicianHourly"]) {
    v[k] = Math.max(0, v[k]);
  }
  return v;
}

/** Number of flags: screened x share flagged. */
export function flags(v) {
  return v.screened * v.flagShare;
}

/** Later-coded patients among the flags: flags x PPV. */
export function foundAmongFlags(v) {
  return flags(v) * v.ppv;
}

/**
 * Later-coded patients in the screened group implied by recall: found / recall. Not defined (NaN) when recall
 * is 0, which feasible() allows only when no flag is later coded.
 */
export function impliedLaterCoded(v) {
  return v.recall > 0 ? foundAmongFlags(v) / v.recall : NaN;
}

const pctText = (x) => `${(Math.round(x * 1000) / 10).toLocaleString("en-US")}%`;
const TOL = 1e-12;

/**
 * Joint constraints on the inputs, so every scenario is possible: found <= reviewed <= flagged <= screened, and
 * the later-coded patients implied by recall are no more than the patients screened. Share flagged and the
 * questionnaire pass share are at most 1 (normalize), so flagged <= screened and reviewed <= flagged. The
 * remaining two constraints raise the dependent input to its smallest possible value:
 *   questionnaire pass share >= PPV x questionnaire sensitivity (else more later-coded patients would pass
 *   the questionnaire than patients in total), and
 *   recall >= share flagged x PPV (else found / recall would exceed the patients screened).
 * Returns { v, adjustments: [{ key, from, to, message }] }.
 */
export function feasible(v) {
  const out = { ...v };
  const adjustments = [];
  const minPass = out.ppv * out.questionnaireSensitivity;
  if (out.questionnairePass < minPass - TOL) {
    adjustments.push({
      key: "questionnairePass", from: out.questionnairePass, to: minPass,
      message: `Share of flagged patients passing the questionnaire raised from ${pctText(out.questionnairePass)} to ${pctText(minPass)}: ` +
        `it cannot be below PPV times the questionnaire's sensitivity (${pctText(out.ppv)} × ${pctText(out.questionnaireSensitivity)}), ` +
        "or more later-coded patients would pass than patients in total.",
    });
    out.questionnairePass = minPass;
  }
  const minRecall = out.flagShare * out.ppv;
  if (minRecall > 0 && out.recall < minRecall - TOL) {
    adjustments.push({
      key: "recall", from: out.recall, to: minRecall,
      message: `Recall raised from ${pctText(out.recall)} to ${pctText(minRecall)}: below the share flagged times PPV ` +
        `(${pctText(out.flagShare)} × ${pctText(out.ppv)}), the later-coded patients it implies would outnumber the patients screened.`,
    });
    out.recall = minRecall;
  }
  return { v: out, adjustments };
}

/** Share of the excess spending that falls inside the lead window, assuming it accrues evenly: min(lead / window, 1). */
export function leadFraction(v) {
  return v.odysseyDays > 0 ? Math.min(1, v.leadDays / v.odysseyDays) : 0;
}

/** Avoided spending per later-coded patient found: excess x lead fraction x avoidable fraction. */
export function avoidedPerFound(v) {
  return v.excessCost * leadFraction(v) * v.avoidable;
}

/** Clinician cost of reviewing n patients: n x minutes / 60 x hourly cost. */
export function reviewCost(n, v) {
  return (n * v.reviewMinutes / 60) * v.clinicianHourly;
}

/** Clinician review cost per later-coded patient found: review cost / found (undefined when none are found). */
export function costPerFound(cost, found) {
  return found > 0 && Number.isFinite(cost) ? cost / found : NaN;
}

function strategy(reviewed, found, v) {
  const cost = reviewCost(reviewed, v);
  const avoided = found * avoidedPerFound(v);
  const denom = found * v.excessCost * leadFraction(v);
  return {
    reviewed,
    clinicianHours: reviewed * v.reviewMinutes / 60,
    reviewCost: cost,
    found,
    ppvAmongReviewed: reviewed > 0 ? found / reviewed : NaN,
    avoided,
    net: avoided - cost,
    costPerFound: costPerFound(cost, found),
    // Avoidable fraction at which avoided spending equals review cost.
    breakEvenAvoidable: denom > 0 ? cost / denom : NaN,
  };
}

/** Chart review of every flag. */
export function chartReview(v) {
  return strategy(flags(v), foundAmongFlags(v), v);
}

/** Two-step screen: flagged patients answer the questionnaire first; only those who pass reach a clinician. */
export function twoStep(v) {
  return strategy(flags(v) * v.questionnairePass, foundAmongFlags(v) * v.questionnaireSensitivity, v);
}

/**
 * Every quantity for the inputs, after normalize() and feasible(). inputs: the values used (adjusted when a
 * joint constraint required it); requested: the normalized values before adjustment; adjustments: what was
 * changed and why. Ratios with a zero denominator (cost per patient found with none found, share of reviewed
 * who are later coded with none reviewed, implied later-coded patients with recall 0) are NaN, shown as "not
 * shown" or "not defined".
 */
export function compute(inputs) {
  const requested = normalize(inputs);
  const { v, adjustments } = feasible(requested);
  const pool = impliedLaterCoded(v);
  return {
    inputs: v,
    requested,
    adjustments,
    feasible: adjustments.length === 0,
    flags: flags(v),
    found: foundAmongFlags(v),
    impliedLaterCoded: pool,
    missedLaterCoded: Number.isFinite(pool) ? pool - foundAmongFlags(v) : NaN,
    leadFraction: leadFraction(v),
    avoidedPerFound: avoidedPerFound(v),
    chart: chartReview(v),
    twoStep: twoStep(v),
  };
}
