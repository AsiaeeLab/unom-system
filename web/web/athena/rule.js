const STATE_RANK = Object.freeze({ unknown: 0, possible: 1, met: 2 });
const CLINICAL_DOMAINS = new Set([
  "Constitutional",
  "Hematologic",
  "Neuropsychiatric",
  "Mucocutaneous",
  "Serosal",
  "Musculoskeletal",
  "Renal",
]);

function array(value) {
  return Array.isArray(value) ? value : [];
}

function codingText(value) {
  const codings = array(value?.coding);
  return [
    value?.text,
    ...codings.flatMap((coding) => [coding.code, coding.display]),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function resourceText(resource) {
  return [
    codingText(resource?.code),
    codingText(resource?.category),
    codingText(resource?.type),
    resource?.description,
  ]
    .flat()
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function codeSet(value) {
  return new Set(array(value?.coding).map((coding) => String(coding.code || "").toLowerCase()));
}

function clinicalDate(resource) {
  const value =
    resource?.effectiveDateTime ||
    resource?.effectivePeriod?.start ||
    resource?.onsetDateTime ||
    resource?.onsetPeriod?.start ||
    resource?.recordedDate ||
    resource?.performedDateTime ||
    resource?.performedPeriod?.start ||
    resource?.date ||
    resource?.issued ||
    null;
  return value ? String(value).slice(0, 10) : null;
}

function evidence(label, resource, state) {
  return {
    label,
    sourceType: resource?.resourceType || "Clinical note",
    date: clinicalDate(resource),
    state,
  };
}

function observationRows(observations) {
  const rows = [];

  for (const observation of observations) {
    rows.push({
      observation,
      code: observation.code,
      valueQuantity: observation.valueQuantity,
      valueCodeableConcept: observation.valueCodeableConcept,
      valueString: observation.valueString,
      interpretation: observation.interpretation,
      referenceRange: observation.referenceRange,
      method: observation.method,
    });

    for (const component of array(observation.component)) {
      rows.push({
        observation,
        code: component.code,
        valueQuantity: component.valueQuantity,
        valueCodeableConcept: component.valueCodeableConcept,
        valueString: component.valueString,
        interpretation: component.interpretation || observation.interpretation,
        referenceRange: component.referenceRange || observation.referenceRange,
        method: observation.method,
      });
    }
  }

  return rows;
}

function observationState(row) {
  const status = String(row.observation?.status || "").toLowerCase();
  if (["entered-in-error", "cancelled", "unknown"].includes(status)) {
    return null;
  }
  return ["final", "amended", "corrected"].includes(status) ? "met" : "possible";
}

function conditionState(condition) {
  const verification = codingText(condition?.verificationStatus);
  if (/refuted|entered.?in.?error/u.test(verification)) {
    return null;
  }
  if (/confirmed/u.test(verification)) {
    return "met";
  }
  return "possible";
}

function matchesCodeOrText(value, codes, pattern) {
  const presentCodes = codeSet(value);
  return codes.some((code) => presentCodes.has(code.toLowerCase())) || pattern.test(codingText(value));
}

function interpretationText(row) {
  return array(row.interpretation).map(codingText).join(" ");
}

function positiveResult(row) {
  const valueText = [codingText(row.valueCodeableConcept), row.valueString]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  const interpretation = interpretationText(row);
  if (/negative|not detected|nonreactive|absent/u.test(valueText)) {
    return false;
  }
  if (/positive|detected|reactive|present/u.test(valueText)) {
    return true;
  }
  if (/(^|\s)(pos|positive|h|hh|a)(\s|$)/u.test(interpretation)) {
    return true;
  }
  if (/(^|\s)(neg|negative|n)(\s|$)/u.test(interpretation)) {
    return false;
  }
  return null;
}

function numericValue(row) {
  const value = Number(row.valueQuantity?.value);
  return Number.isFinite(value) ? value : null;
}

function lowerReference(row) {
  const values = array(row.referenceRange)
    .map((range) => Number(range?.low?.value))
    .filter(Number.isFinite);
  return values.length ? Math.min(...values) : null;
}

function isLow(row) {
  if (/(^|\s)(l|ll|low)(\s|$)/u.test(interpretationText(row))) {
    return true;
  }
  const value = numericValue(row);
  const low = lowerReference(row);
  return value !== null && low !== null && value < low;
}

function unitText(row) {
  return `${row.valueQuantity?.unit || ""} ${row.valueQuantity?.code || ""}`.toLowerCase();
}

function temperatureCelsius(row) {
  const value = numericValue(row);
  if (value === null) {
    return null;
  }
  return /degf|fahrenheit|\[degf\]/u.test(unitText(row)) ? ((value - 32) * 5) / 9 : value;
}

// ---------------------------------------------------------------- text mentions: word boundaries, longest match, negation

// Criteria found by name in Condition text and note text. Patterns are matched on word boundaries; where two
// criteria match overlapping text, only the longest match counts ("subacute cutaneous lupus" is the subacute
// criterion, never also "acute cutaneous lupus"); a negated mention ("no oral ulcers", "denies seizure",
// "pericarditis ruled out") does not count.
const TEXT_CRITERIA = Object.freeze([
  { id: "fever", condition: /\bfevers?\b/gu },
  { id: "leukopenia", condition: /\bleukopenia\b/gu },
  { id: "thrombocytopenia", condition: /\bthrombocytopenia\b/gu },
  { id: "hemolysis", both: /\bautoimmune (?:hemoly(?:sis|tic)|haemoly(?:sis|tic))\b|\b(?:haemolytic anaemia|haemolytic anemia)\b/gu },
  { id: "delirium", both: /\bdelirium\b/gu },
  { id: "psychosis", condition: /\bpsychosis\b|\bpsychotic disorders?\b/gu, note: /\bpsychosis\b/gu },
  { id: "seizure", both: /\bseizures?\b|\bconvulsions?\b/gu },
  { id: "alopecia", both: /\bnon-?scarring alopecia\b/gu },
  { id: "oral-ulcers", both: /\b(?:oral|mouth) ulcers?\b/gu },
  { id: "subacute-discoid", both: /\bsubacute cutaneous lupus\b|\bdiscoid lupus\b/gu },
  { id: "acute-cutaneous", both: /\bacute cutaneous lupus\b|\bmalar rash\b/gu },
  { id: "effusion", both: /\b(?:pleural|pericardial) effusions?\b/gu },
  { id: "pericarditis", both: /\b(?:acute )?pericarditis\b/gu },
  { id: "joint", condition: /\bsynovitis\b|\binflammatory (?:poly)?arthritis\b/gu, note: /\bsynovitis\b|\bmorning stiffness.{0,30}(?:30|thirty) minutes/gu },
  { id: "nephritis-ii-v", both: /\blupus nephritis\b[^.;]*?\bclass (?:ii|2|v|5)\b/gu },
  { id: "nephritis-iii-iv", both: /\blupus nephritis\b[^.;]*?\bclass (?:iii|3|iv|4)\b/gu },
]);
const SLE_PATTERN = /\bsystemic lupus erythematosus\b|\bsle\b/gu;

// Negation triggers before a mention, and after it, within the same clause.
const NEG_BEFORE = /\b(?:no|not|denies|denied|deny|without|negative for|free of|absence of|no evidence of|no history of|no sign of|no signs of|rules? out|ruled out|r\/o)\b/gu;
const NEG_AFTER = /^[\s,:-]*(?:(?:was|were|is|are|has been|have been)\s+)?(?:ruled out|excluded|absent|denied|not present|not seen|negative|none)\b/u;
// A clause ends at sentence punctuation or at a word that starts a new assertion.
const CLAUSE_END = /[.;!?\n]|\b(?:but|however|although|though|except|apart from|aside from|yet|reports?|reported|endorses|endorsed|complains|presents|presented|positive for|now has)\b/gu;

function clauseStart(text, at) {
  let start = 0;
  CLAUSE_END.lastIndex = 0;
  for (let m = CLAUSE_END.exec(text); m && m.index < at; m = CLAUSE_END.exec(text)) start = m.index + m[0].length;
  return start;
}

function clauseEnd(text, from) {
  CLAUSE_END.lastIndex = from;
  const m = CLAUSE_END.exec(text);
  return m ? m.index : text.length;
}

/** Is the mention at [start, end) negated within its clause? */
export function isNegated(text, start, end) {
  const before = text.slice(clauseStart(text, start), start);
  NEG_BEFORE.lastIndex = 0;
  if (NEG_BEFORE.test(before)) return true;
  return NEG_AFTER.test(text.slice(end, clauseEnd(text, end)));
}

/**
 * Criterion ids mentioned in `text` (lowercase): every pattern of `field` ("condition" or "note") is matched,
 * overlapping matches keep only the longest, and negated mentions are dropped.
 */
export function mentionedCriteria(text, field) {
  const s = String(text || "").toLowerCase();
  const hits = [];
  for (const c of TEXT_CRITERIA) {
    const re = c[field] || c.both;
    if (!re) continue;
    re.lastIndex = 0;
    for (let m = re.exec(s); m; m = re.exec(s)) {
      if (!m[0].length) {
        re.lastIndex += 1;
        continue;
      }
      hits.push({ id: c.id, start: m.index, end: m.index + m[0].length });
    }
  }
  hits.sort((a, b) => (b.end - b.start) - (a.end - a.start) || a.start - b.start);
  const kept = [];
  for (const hit of hits) if (!kept.some((k) => hit.start < k.end && k.start < hit.end)) kept.push(hit);
  return new Set(kept.filter((k) => !isNegated(s, k.start, k.end)).map((k) => k.id));
}

/** True when the text has a non-negated mention matching `re` (a global regex). */
function affirmed(text, re) {
  const s = String(text || "").toLowerCase();
  re.lastIndex = 0;
  for (let m = re.exec(s); m; m = re.exec(s)) if (!isNegated(s, m.index, m.index + m[0].length)) return true;
  return false;
}

// ---------------------------------------------------------------- cell counts in 10^9/L

const PER_1E9_L = /10\s*[*^]\s*9\s*\/\s*l\b|10e9\s*\/\s*l|x\s*10e9|\bg\/l\b|giga\s*\/\s*l|10\s*[*^]\s*3\s*\/\s*(?:u|µ|μ|mc)l|10e3\s*\/\s*(?:u|µ|μ|mc)l|x\s*10e3|\b(?:k|thou|thous)\s*\/\s*(?:u|µ|μ|mc)l|10\s*[*^]\s*3\s*\/\s*(?:mm3|mm\^3|cumm|cu\s?mm)|\b(?:k|thou)\s*\/\s*(?:mm3|cumm|cu\s?mm)/u;
const PER_MICROLITER = /\/\s*(?:u|µ|μ|mc)l\b|\/\s*(?:mm3|mm\^3|cumm|cu\s?mm)|10\s*[*^]\s*6\s*\/\s*l\b/u;

/**
 * A white-cell or platelet count in 10^9/L. Units in 10^9/L or 10^3/µL (K/µL, 10*3/uL) are read as is; counts
 * per µL or mm³ (cells/µL, /mm3) and in 10^6/L are divided by 1000. Without a recognized unit, a value too large
 * for 10^9/L (`perMicroliterAbove`) is read as a count per µL.
 */
export function countPer1e9L(row, { perMicroliterAbove }) {
  const value = numericValue(row);
  if (value === null) return null;
  const unit = unitText(row);
  if (PER_1E9_L.test(unit)) return value;
  if (PER_MICROLITER.test(unit)) return value / 1000;
  return value > perMicroliterAbove ? value / 1000 : value;
}
const WBC = { perMicroliterAbove: 200 };
const PLATELETS = { perMicroliterAbove: 5000 };

function candidate(state, label, resource) {
  return state ? { state, evidence: evidence(label, resource, state) } : null;
}

function bestCandidate(candidates) {
  return candidates
    .filter(Boolean)
    .sort((left, right) => STATE_RANK[right.state] - STATE_RANK[left.state])[0] || null;
}

function conditionCandidate(conditions, id, label) {
  const candidates = conditions
    .filter((condition) => mentionedCriteria(resourceText(condition), "condition").has(id))
    .map((condition) => candidate(conditionState(condition), label, condition));
  return bestCandidate(candidates);
}

function noteCandidate(notes, id, label) {
  const note = notes.find((entry) => mentionedCriteria(entry.text, "note").has(id));
  return note
    ? {
        state: "possible",
        evidence: {
          label,
          sourceType: note.sourceType || "Clinical note",
          date: note.date || null,
          state: "possible",
        },
      }
    : null;
}

function measurementCandidates(rows, codes, pattern, predicate, label) {
  return rows
    .filter((row) => matchesCodeOrText(row.code, codes, pattern))
    .filter(predicate)
    .map((row) => candidate(observationState(row), label, row.observation));
}

function makeCriterion(id, domain, label, weight, candidates) {
  const selected = bestCandidate(candidates);
  return {
    id,
    domain,
    label,
    weight,
    state: selected?.state || "unknown",
    evidence: candidates.filter(Boolean).map((item) => item.evidence),
  };
}

function anaAssessment(rows) {
  const anaRows = rows.filter((row) =>
    matchesCodeOrText(
      row.code,
      ["5048-4", "8061-4", "42254-3", "59069-5"],
      /\bana\b|antinuclear|nuclear antibod/u,
    ),
  );
  const positives = [];
  let negativeEvidence = null;

  for (const row of anaRows) {
    const state = observationState(row);
    if (!state) {
      continue;
    }
    const textValue = String(row.valueString || "");
    const titer = /1\s*:\s*(\d+)/u.exec(textValue);
    const quantity = numericValue(row);
    const positive = positiveResult(row);
    const method = codingText(row.method);
    const codes = codeSet(row.code);
    const qualifiesByTiter = titer ? Number(titer[1]) >= 80 : quantity !== null && quantity >= 80;
    const qualifiedMethod = /hep.?2|immunofluorescen|\bifa\b/u.test(method) || codes.has("5048-4");

    if (qualifiesByTiter || positive === true) {
      const confirmed = state === "met" && (qualifiesByTiter || qualifiedMethod);
      positives.push(
        candidate(
          confirmed ? "met" : "possible",
          confirmed ? "ANA entry criterion supported" : "Positive ANA with incomplete titer or method",
          row.observation,
        ),
      );
    } else if (positive === false && state === "met") {
      negativeEvidence = evidence("ANA reported negative", row.observation, "not_met");
    }
  }

  const selected = bestCandidate(positives);
  if (selected) {
    return {
      state: selected.state,
      label: selected.state === "met" ? "Supported" : "Possible; method or titer incomplete",
      evidence: positives.map((item) => item.evidence),
    };
  }
  if (negativeEvidence) {
    return { state: "not_met", label: "Negative result found", evidence: [negativeEvidence] };
  }
  return { state: "unknown", label: "Not found in available data", evidence: [] };
}

function proteinuriaCandidate(rows) {
  const matches = rows.filter((row) =>
    matchesCodeOrText(
      row.code,
      ["2889-4", "2890-2", "34366-5", "32294-1"],
      /protein.*(?:creatinine|24.?h|urine)|proteinuria/u,
    ),
  );
  const candidates = [];

  for (const row of matches) {
    const state = observationState(row);
    const value = numericValue(row);
    const unit = unitText(row);
    const text = codingText(row.code);
    let thresholdMet = false;

    if (value !== null && /ratio|creatinine/u.test(text)) {
      thresholdMet = /mg\/g/u.test(unit) ? value > 500 : value > 0.5;
    } else if (value !== null && /24|day/u.test(`${text} ${unit}`)) {
      thresholdMet = /mg/u.test(unit) ? value > 500 : value > 0.5;
    }

    if (thresholdMet) {
      candidates.push(candidate(state, "Proteinuria above 0.5 g/day or equivalent", row.observation));
    } else if (isLow(row) === false && /(^|\s)(h|hh|high|a)(\s|$)/u.test(interpretationText(row))) {
      candidates.push(candidate("possible", "Elevated urine protein; threshold requires review", row.observation));
    }
  }

  return candidates;
}

function evaluateCriteria(record) {
  const conditions = array(record.resources?.Condition);
  const observations = array(record.resources?.Observation);
  const rows = observationRows(observations);
  const notes = array(record.notes);
  const criteria = [];

  criteria.push(
    makeCriterion("fever", "Constitutional", "Unexplained fever over 38.3°C", 2, [
      ...measurementCandidates(
        rows,
        ["8310-5"],
        /body temperature|temperature/u,
        (row) => temperatureCelsius(row) !== null && temperatureCelsius(row) > 38.3,
        "Temperature above 38.3°C",
      ),
      conditionCandidate(conditions, "fever", "Fever documented"),
    ]),
    makeCriterion("leukopenia", "Hematologic", "Leukopenia", 3, [
      ...measurementCandidates(
        rows,
        ["6690-2", "26464-8"],
        /white blood cell|leukocyte/u,
        (row) => countPer1e9L(row, WBC) !== null && countPer1e9L(row, WBC) < 4,
        "White blood cell count below 4.0 × 10⁹/L",
      ),
      conditionCandidate(conditions, "leukopenia", "Leukopenia documented"),
    ]),
    makeCriterion("thrombocytopenia", "Hematologic", "Thrombocytopenia", 4, [
      ...measurementCandidates(
        rows,
        ["777-3", "26515-7"],
        /platelet/u,
        (row) => countPer1e9L(row, PLATELETS) !== null && countPer1e9L(row, PLATELETS) < 100,
        "Platelet count below 100 × 10⁹/L",
      ),
      conditionCandidate(conditions, "thrombocytopenia", "Thrombocytopenia documented"),
    ]),
    makeCriterion("hemolysis", "Hematologic", "Autoimmune hemolysis", 4, [
      conditionCandidate(conditions, "hemolysis", "Autoimmune hemolysis documented"),
      noteCandidate(notes, "hemolysis", "Possible autoimmune hemolysis in note"),
    ]),
    makeCriterion("delirium", "Neuropsychiatric", "Delirium", 2, [
      conditionCandidate(conditions, "delirium", "Delirium documented"),
      noteCandidate(notes, "delirium", "Possible delirium in note"),
    ]),
    makeCriterion("psychosis", "Neuropsychiatric", "Psychosis", 3, [
      conditionCandidate(conditions, "psychosis", "Psychosis documented"),
      noteCandidate(notes, "psychosis", "Possible psychosis in note"),
    ]),
    makeCriterion("seizure", "Neuropsychiatric", "Seizure", 5, [
      conditionCandidate(conditions, "seizure", "Seizure documented"),
      noteCandidate(notes, "seizure", "Possible seizure in note"),
    ]),
    makeCriterion("alopecia", "Mucocutaneous", "Nonscarring alopecia", 2, [
      conditionCandidate(conditions, "alopecia", "Nonscarring alopecia documented"),
      noteCandidate(notes, "alopecia", "Possible nonscarring alopecia in note"),
    ]),
    makeCriterion("oral-ulcers", "Mucocutaneous", "Oral ulcers", 2, [
      conditionCandidate(conditions, "oral-ulcers", "Oral ulcers documented"),
      noteCandidate(notes, "oral-ulcers", "Possible oral ulcers in note"),
    ]),
    makeCriterion("subacute-discoid", "Mucocutaneous", "Subacute cutaneous or discoid lupus", 4, [
      conditionCandidate(conditions, "subacute-discoid", "Cutaneous lupus documented"),
      noteCandidate(notes, "subacute-discoid", "Possible cutaneous lupus in note"),
    ]),
    makeCriterion("acute-cutaneous", "Mucocutaneous", "Acute cutaneous lupus", 6, [
      conditionCandidate(conditions, "acute-cutaneous", "Acute cutaneous lupus documented"),
      noteCandidate(notes, "acute-cutaneous", "Possible acute cutaneous lupus in note"),
    ]),
    makeCriterion("effusion", "Serosal", "Pleural or pericardial effusion", 5, [
      conditionCandidate(conditions, "effusion", "Serosal effusion documented"),
      noteCandidate(notes, "effusion", "Possible serosal effusion in report or note"),
    ]),
    makeCriterion("pericarditis", "Serosal", "Acute pericarditis", 6, [
      conditionCandidate(conditions, "pericarditis", "Pericarditis documented"),
      noteCandidate(notes, "pericarditis", "Possible pericarditis in report or note"),
    ]),
    makeCriterion("joint", "Musculoskeletal", "Inflammatory joint involvement", 6, [
      conditionCandidate(conditions, "joint", "Inflammatory joint involvement documented"),
      noteCandidate(notes, "joint", "Possible inflammatory joint involvement in note"),
    ]),
    makeCriterion("proteinuria", "Renal", "Proteinuria above threshold", 4, proteinuriaCandidate(rows)),
    makeCriterion("nephritis-ii-v", "Renal", "Class II or V lupus nephritis", 8, [
      conditionCandidate(conditions, "nephritis-ii-v", "Class II or V lupus nephritis documented"),
      noteCandidate(notes, "nephritis-ii-v", "Possible class II or V lupus nephritis in note"),
    ]),
    makeCriterion("nephritis-iii-iv", "Renal", "Class III or IV lupus nephritis", 10, [
      conditionCandidate(conditions, "nephritis-iii-iv", "Class III or IV lupus nephritis documented"),
      noteCandidate(notes, "nephritis-iii-iv", "Possible class III or IV lupus nephritis in note"),
    ]),
  );

  const antiphospholipid = measurementCandidates(
    rows,
    [],
    /anticardiolipin|cardiolipin antibod|beta.?2 glycoprotein|lupus anticoagulant/u,
    (row) => positiveResult(row) === true,
    "Antiphospholipid antibody reported positive",
  ).map((item) => ({ ...item, state: "possible", evidence: { ...item.evidence, state: "possible" } }));

  const c3Rows = rows.filter((row) =>
    matchesCodeOrText(row.code, ["4485-9"], /complement c3|\bc3\b/u),
  );
  const c4Rows = rows.filter((row) =>
    matchesCodeOrText(row.code, ["4498-2"], /complement c4|\bc4\b/u),
  );
  const lowC3 = bestCandidate(
    c3Rows.filter(isLow).map((row) => candidate(observationState(row), "Low complement C3", row.observation)),
  );
  const lowC4 = bestCandidate(
    c4Rows.filter(isLow).map((row) => candidate(observationState(row), "Low complement C4", row.observation)),
  );

  const dsDna = measurementCandidates(
    rows,
    ["11013-0", "34187-5", "5130-0"],
    /double.?stranded dna|anti.?ds.?dna|dsdna/u,
    (row) => positiveResult(row) === true,
    "Anti-dsDNA reported positive",
  ).map((item) => ({ ...item, state: "possible", evidence: { ...item.evidence, state: "possible" } }));
  const antiSm = measurementCandidates(
    rows,
    ["11090-8", "43182-5"],
    /anti.?sm\b|smith antibod/u,
    (row) => positiveResult(row) === true,
    "Anti-Sm reported positive",
  );

  criteria.push(
    makeCriterion("antiphospholipid", "Antiphospholipid", "Antiphospholipid antibodies", 2, antiphospholipid),
    makeCriterion(
      "complement-one",
      "Complement",
      "Low C3 or low C4",
      3,
      [lowC3, lowC4].filter(Boolean),
    ),
    makeCriterion(
      "complement-both",
      "Complement",
      "Low C3 and low C4",
      4,
      lowC3 && lowC4
        ? [
            {
              state: STATE_RANK[lowC3.state] < STATE_RANK[lowC4.state] ? lowC3.state : lowC4.state,
              evidence: {
                label: "Both complement C3 and C4 are low",
                sourceType: "Observation",
                date: lowC3.evidence.date || lowC4.evidence.date,
                state: STATE_RANK[lowC3.state] < STATE_RANK[lowC4.state] ? lowC3.state : lowC4.state,
              },
            },
          ]
        : [],
    ),
    makeCriterion("sle-antibody", "SLE-specific antibodies", "Anti-dsDNA or anti-Sm antibodies", 6, [
      ...dsDna,
      ...antiSm,
    ]),
  );

  return { criteria, rows, ana: anaAssessment(rows) };
}

function domainScores(criteria) {
  const names = [...new Set(criteria.map((criterion) => criterion.domain))];
  return names.map((domain) => {
    const members = criteria.filter((criterion) => criterion.domain === domain);
    const confirmed = Math.max(
      0,
      ...members.filter((criterion) => criterion.state === "met").map((criterion) => criterion.weight),
    );
    const potential = Math.max(
      0,
      ...members
        .filter((criterion) => criterion.state === "met" || criterion.state === "possible")
        .map((criterion) => criterion.weight),
    );
    const selected = members
      .filter((criterion) => criterion.state !== "unknown")
      .sort((left, right) => right.weight - left.weight || STATE_RANK[right.state] - STATE_RANK[left.state])[0];
    return { domain, confirmed, potential, selected: selected || null };
  });
}

function available(access, resourceType) {
  const item = array(access).find((entry) => entry.resourceType === resourceType);
  return Boolean(item?.status?.startsWith("Available"));
}

function hasObservation(rows, codes, pattern) {
  return rows.some((row) => matchesCodeOrText(row.code, codes, pattern));
}

function dataGaps(record, rows, ana) {
  const gaps = [];
  const relevantResources = [
    "Condition",
    "Observation",
    "DiagnosticReport",
    "DocumentReference",
    "QuestionnaireResponse",
  ];

  for (const resourceType of relevantResources) {
    if (!available(record.access, resourceType)) {
      gaps.push(`${resourceType} data unavailable`);
    }
  }
  if (ana.state === "unknown") {
    gaps.push("ANA result, titer, and method not found");
  } else if (ana.state === "possible") {
    gaps.push("ANA method or qualifying titer incomplete");
  }
  if (!hasObservation(rows, ["4485-9", "4498-2"], /complement c3|complement c4|\bc3\b|\bc4\b/u)) {
    gaps.push("Complement C3/C4 results not found");
  }
  if (!hasObservation(rows, ["11013-0", "34187-5", "5130-0", "11090-8"], /dsdna|double.?stranded dna|anti.?sm|smith antibod/u)) {
    gaps.push("Anti-dsDNA and anti-Sm results not found");
  }
  if (!hasObservation(rows, ["2889-4", "2890-2", "34366-5", "32294-1"], /protein.*urine|protein.*creatinine|proteinuria/u)) {
    gaps.push("Quantified urine protein not found");
  }
  return gaps;
}

function ratingFor({ ana, confirmedScore, potentialScore, hasClinicalConfirmed, hasClinicalPotential, adequateCore, criteria }) {
  const strongRenal = criteria.some(
    (criterion) => criterion.domain === "Renal" && criterion.state === "met" && criterion.weight >= 8,
  );
  const specificAntibody = criteria.find((criterion) => criterion.id === "sle-antibody");

  if (ana.state === "met" && hasClinicalConfirmed && confirmedScore >= 10) {
    return 5;
  }
  if (
    (ana.state === "met" && hasClinicalPotential && (confirmedScore >= 6 || potentialScore >= 10)) ||
    strongRenal
  ) {
    return 4;
  }
  if (
    (ana.state === "met" && (confirmedScore >= 2 || potentialScore >= 4)) ||
    specificAntibody?.state === "met" ||
    specificAntibody?.state === "possible" ||
    (["unknown", "not_met"].includes(ana.state) && hasClinicalPotential && (confirmedScore >= 4 || potentialScore >= 6))
  ) {
    return 3;
  }
  if (
    ana.state === "met" ||
    ana.state === "possible" ||
    confirmedScore > 0 ||
    potentialScore > 0 ||
    !adequateCore
  ) {
    return 2;
  }
  return ana.state === "not_met" && adequateCore ? 1 : 2;
}

function ratingCopy(rating) {
  return {
    1: {
      title: "No chart-supported pattern",
      summary: "A negative ANA and no weighted criteria were identified in the retrieved core record.",
    },
    2: {
      title: "Limited evidence in this chart",
      summary: "Evidence is limited or key inputs are missing in the retrieved chart. This review cannot rule out lupus.",
    },
    3: {
      title: "Lupus-relevant evidence found",
      summary: "Weighted criteria, or an anti-dsDNA or anti-Sm result, are in the chart. Each counts only if no other condition explains it better.",
    },
    4: {
      title: "High-priority clinical review",
      summary: "A qualifying ANA and a clinical criterion with 6 or more documented points (or 10 or more possible points), or documented class II to V lupus nephritis. Each finding needs confirmation.",
    },
    5: {
      title: "Classification threshold met in chart data",
      summary: "Structured chart data meet this rule's version of the 2019 EULAR/ACR threshold: a qualifying ANA, a documented clinical criterion, and 10 or more points. Confirm the attribution of each finding.",
    },
  }[rating];
}

function priorityFindings(criteria, rows) {
  const findings = [];
  const platelets = rows.filter((row) => /platelet/u.test(codingText(row.code)) && countPer1e9L(row, PLATELETS) !== null);
  if (platelets.some((row) => countPer1e9L(row, PLATELETS) < 50)) {
    findings.push("A platelet result below 50 × 10⁹/L appears in the available history.");
  }
  const whiteCells = rows.filter((row) => /white blood cell|leukocyte/u.test(codingText(row.code)) && countPer1e9L(row, WBC) !== null);
  if (whiteCells.some((row) => countPer1e9L(row, WBC) < 2)) {
    findings.push("A white blood cell result below 2.0 × 10⁹/L appears in the available history.");
  }
  if (criteria.some((criterion) => criterion.id === "seizure" && criterion.state !== "unknown")) {
    findings.push("Seizure evidence appears in the available history.");
  }
  if (criteria.some((criterion) => criterion.id === "pericarditis" && criterion.state !== "unknown")) {
    findings.push("Pericarditis evidence appears in the available history.");
  }
  if (criteria.some((criterion) => criterion.domain === "Renal" && criterion.state !== "unknown")) {
    findings.push("Renal evidence relevant to lupus appears in the available history.");
  }
  return findings;
}

export function evaluateLupusSignal(record) {
  const normalized = {
    resources: record?.resources || {},
    access: array(record?.access),
    notes: array(record?.notes),
  };
  const { criteria, rows, ana } = evaluateCriteria(normalized);
  const domains = domainScores(criteria);
  const confirmedScore = domains.reduce((sum, domain) => sum + domain.confirmed, 0);
  const potentialScore = domains.reduce((sum, domain) => sum + domain.potential, 0);
  const hasClinicalConfirmed = criteria.some(
    (criterion) => CLINICAL_DOMAINS.has(criterion.domain) && criterion.state === "met",
  );
  const hasClinicalPotential = criteria.some(
    (criterion) => CLINICAL_DOMAINS.has(criterion.domain) && criterion.state !== "unknown",
  );
  const adequateCore = available(normalized.access, "Condition") && available(normalized.access, "Observation");
  const rating = ratingFor({
    ana,
    confirmedScore,
    potentialScore,
    hasClinicalConfirmed,
    hasClinicalPotential,
    adequateCore,
    criteria,
  });
  const relevant = ["Condition", "Observation", "DiagnosticReport", "DocumentReference", "QuestionnaireResponse"];
  const availableCount = relevant.filter((resourceType) => available(normalized.access, resourceType)).length;
  // an existing diagnosis: a lupus Condition that is not refuted or entered in error and not negated in its text
  const existingDiagnosis = array(normalized.resources.Condition).some((condition) =>
    conditionState(condition) !== null && affirmed(resourceText(condition), SLE_PATTERN),
  );

  return {
    rating,
    ...ratingCopy(rating),
    confirmedScore,
    potentialScore,
    ana,
    criteria,
    domains,
    gaps: dataGaps(normalized, rows, ana),
    priorityFindings: priorityFindings(criteria, rows),
    existingDiagnosis,
    coverage: {
      available: availableCount,
      total: relevant.length,
      percentage: Math.round((availableCount / relevant.length) * 100),
    },
  };
}
