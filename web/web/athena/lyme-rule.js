// Lyme disease chart rule: lists coded findings consistent with Lyme disease, with their dates.
// Simple and transparent on purpose: a fixed list of ICD-10-CM code prefixes (plus the words "erythema migrans",
// which usually has no code of its own). No weights and no score. The county incidence (exposure context) is
// shown next to it by cards.js; this file only reads the chart.
// Research decision support: it surfaces chart findings for clinician review and never makes a diagnosis.

export const ICD10CM = "http://hl7.org/fhir/sid/icd-10-cm";

// Lyme disease already coded: A69.20 unspecified, A69.21 meningitis, A69.22 other neurologic disorders,
// A69.23 arthritis, A69.29 other conditions associated with Lyme disease.
export const LYME_CODED = Object.freeze({ prefixes: ["A69.2"], label: "Lyme disease (A69.2)" });

export const LYME_FEATURES = Object.freeze([
  {
    id: "erythema-migrans",
    label: "Erythema migrans",
    prefixes: [],
    text: /erythema\s+(?:chronicum\s+)?migrans/u,
    codesNote: "the words \"erythema migrans\" in a diagnosis (it is usually coded as A69.20, Lyme disease)",
  },
  {
    id: "joint",
    label: "Arthritis, knee swelling, or knee pain",
    prefixes: ["M13", "M25.46", "M25.56"],
    codesNote: "M13 other arthritis; M25.46 effusion of the knee; M25.56 pain in the knee",
  },
  {
    id: "facial-palsy",
    label: "Facial nerve palsy",
    prefixes: ["G51.0"],
    codesNote: "G51.0 Bell's palsy",
  },
  {
    id: "carditis",
    label: "Carditis or atrioventricular block",
    prefixes: ["I40", "I44.0", "I44.1", "I44.2", "I44.3"],
    codesNote: "I40 acute myocarditis; I44.0 to I44.3 atrioventricular block",
  },
  {
    id: "neuro",
    label: "Meningitis or radiculopathy",
    prefixes: ["G02", "G03.9", "M54.1"],
    codesNote: "G02 meningitis in other infectious diseases; G03.9 meningitis, unspecified; M54.1 radiculopathy",
  },
]);

const norm = (code) => String(code ?? "").replaceAll(".", "").toUpperCase();

function conditionDate(r) {
  const v = r?.onsetDateTime || r?.onsetPeriod?.start || r?.recordedDate || null;
  return v ? String(v).slice(0, 10) : null;
}

function excluded(r) {
  const text = (r?.verificationStatus?.coding || []).map((c) => c.code).join(" ");
  return /refuted|entered-in-error/u.test(text);
}

function icdCodings(r) {
  return (r?.code?.coding || []).filter((c) => c?.system === ICD10CM && c.code);
}

function conditionText(r) {
  return [r?.code?.text, ...(r?.code?.coding || []).map((c) => c?.display)].filter(Boolean).join(" ").toLowerCase();
}

function finding(r, coding) {
  const display = coding?.display || r?.code?.text || coding?.code || "Diagnosis";
  return { id: r.id ?? null, date: conditionDate(r), code: coding?.code || null, display, resourceType: "Condition" };
}

function matchPrefixes(r, prefixes) {
  const pre = prefixes.map(norm);
  return icdCodings(r).find((c) => pre.some((p) => norm(c.code).startsWith(p))) || null;
}

function byDate(a, b) {
  return String(a.date || "").localeCompare(String(b.date || ""));
}

/**
 * Evaluate a FHIR bundle (or a list of resources) for coded features consistent with Lyme disease.
 * Returns { alreadyCoded: [finding], features: [{ id, label, findings: [finding] }], featureCount }.
 * Only feature types with at least one finding are listed, in the order of LYME_FEATURES; findings are by date.
 */
export function evaluateLymeFeatures(bundleOrResources) {
  const resources = Array.isArray(bundleOrResources)
    ? bundleOrResources
    : (bundleOrResources?.entry || []).map((e) => e?.resource).filter(Boolean);
  const conditions = resources.filter((r) => r?.resourceType === "Condition" && !excluded(r));

  const alreadyCoded = [];
  for (const r of conditions) {
    const c = matchPrefixes(r, LYME_CODED.prefixes);
    if (c) alreadyCoded.push(finding(r, c));
  }

  const features = [];
  for (const f of LYME_FEATURES) {
    const findings = [];
    for (const r of conditions) {
      const c = f.prefixes.length ? matchPrefixes(r, f.prefixes) : null;
      if (c) findings.push(finding(r, c));
      else if (f.text && f.text.test(conditionText(r))) findings.push(finding(r, icdCodings(r)[0] || null));
    }
    if (findings.length) features.push({ id: f.id, label: f.label, findings: findings.sort(byDate) });
  }
  return { alreadyCoded: alreadyCoded.sort(byDate), features, featureCount: features.length };
}
