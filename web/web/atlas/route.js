// Which condition an Atlas URL selects, and the URL of each condition. Pure functions, no DOM, so the tests
// can run them. The list of conditions comes from /atlas/data/conditions/index.json: a condition is offered
// only when its data file exists.

export const PARAM = "condition";

// Spellings people type or paste, mapped to the slugs the data files use (the clinician card slugs).
const ALIASES = {
  "long-covid": "longcovid", long_covid: "longcovid", lc: "longcovid",
  "me-cfs": "mecfs", me_cfs: "mecfs", "me/cfs": "mecfs", cfs: "mecfs", "chronic-fatigue": "mecfs", chronic_fatigue: "mecfs",
  fibro: "fibromyalgia",
  "lyme-disease": "lyme", lyme_disease: "lyme",
  sle: "lupus",
  endo: "endometriosis",
  migraines: "migraine",
  mdd: "depression", "major-depression": "depression",
  gad: "anxiety", "anxiety-disorder": "anxiety",
};

export function normalizeSlug(value) {
  const key = String(value ?? "").trim().toLowerCase();
  return ALIASES[key] || key;
}

/**
 * The condition a query string selects. Returns { slug, canonical }: canonical is false when the address
 * should be rewritten (an alias, an unknown condition, or none given), so the page can replace it with
 * conditionHref(slug) and keep one address per condition.
 */
export function resolveCondition(search, manifest) {
  const slugs = (manifest?.conditions || []).map((c) => c.slug);
  if (!slugs.length) return { slug: null, canonical: false };
  const raw = new URLSearchParams(search || "").get(PARAM);
  const want = normalizeSlug(raw);
  if (slugs.includes(want)) return { slug: want, canonical: raw === want };
  const fallback = slugs.includes(manifest.default) ? manifest.default : slugs[0];
  return { slug: fallback, canonical: false };
}

export function conditionHref(slug) {
  return `/atlas/?${PARAM}=${encodeURIComponent(slug)}`;
}
