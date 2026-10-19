import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const web = new URL("../web/", import.meta.url);
const read = (rel) => readFileSync(new URL(rel, web), "utf8");

// The slide deck. The developer pages have their own tests in developers.test.js.
const PAGES = ["deck/index.html"];

for (const page of PAGES) {
  test(`${page}: shared site bar, no inline script or style, no external scripts or styles`, () => {
    const html = read(page);
    assert.match(html, /<link rel="stylesheet" href="\/shared\/site-nav\.css(\?v=\d{8})?" \/>/u);
    assert.match(html, /<body data-door="deck">/u);
    assert.match(html, /<script src="\/shared\/site-nav\.js(?:\?v=\d{8})?" defer><\/script>/u);
    assert.doesNotMatch(html, /<header class="site-header">/u, "old per-page header is gone");
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/iu, "inline script");
    assert.doesNotMatch(html, /<style/iu, "style element");
    assert.doesNotMatch(html, /\sstyle=/iu, "style attribute");
    assert.doesNotMatch(html, /\son[a-z]+=/iu, "inline handler");
    assert.doesNotMatch(html, /<script[^>]+src="https?:|<link rel="stylesheet"[^>]+href="https?:/iu, "external script or stylesheet");
    assert.doesNotMatch(html, /—/u, "em-dash in copy");
    assert.match(html, /class="deck"/u);
  });
}

test("deck: 10 to 12 slides, one per printed 13.333 x 7.5 in page, screenshots and PDF present", () => {
  const html = read("deck/index.html");
  const css = read("deck/deck.css");
  const slides = html.match(/<section class="slide[ "]/gu) || [];
  assert.ok(slides.length >= 10 && slides.length <= 12, `${slides.length} slides`);
  assert.match(css, /@page \{ size: 13\.333in 7\.5in; margin: 0; \}/u);
  assert.match(css, /break-after: page/u);
  for (const src of html.match(/src="\/deck\/img\/[^"]+"/gu) || []) {
    assert.ok(existsSync(new URL(src.slice(6, -1), web)), src);
  }
  assert.ok(existsSync(new URL("deck/undiagnosed-no-more-deck.pdf", web)));
  assert.match(html, /We gratefully acknowledge All of Us participants/u);
  assert.match(html, /The Invisible Patient Finder/u);
});

const BANNED = /\b(?:seamless\w*|leverag\w*|robust\w*|comprehensive|empower\w*|unlock\w*|delv(?:e|es|ing)|cutting-edge|game-chang\w*)\b/iu;
const visibleText = (html) => html.replace(/<!--[\s\S]*?-->/gu, " ").replace(/<script[\s\S]*?<\/script>/gu, " ").replace(/<[^>]+>/gu, " ");

for (const page of ["deck/index.html"]) {
  test(`${page}: no exclamation marks or marketing words in the copy`, () => {
    const text = visibleText(read(page));
    assert.doesNotMatch(text, /[A-Za-z.)]!(\s|$)/u, "exclamation mark");
    assert.doesNotMatch(text, BANNED, "marketing word");
  });
}

test("deck: numbers match the Atlas data and calculator, and door names match the site bar", async () => {
  const html = read("deck/index.html");
  const data = (name) => JSON.parse(read(`atlas/data/${name}.json`));
  // slide 4: each bar value is the condition's share coded relative to the anchors (5 or more years of records)
  const inv = Object.fromEntries(data("invisible").conditions.map((c) => [c.label.toLowerCase(), c.overall.relative]));
  const bars = [...html.matchAll(/<span class="bar-label">([^<]+)<\/span>\s*<span class="bar-track"><span class="bar w(\d+)"><\/span><span class="bar-value">([\d.]+)<\/span>/gu)];
  assert.equal(bars.length, 4);
  for (const [, label, width, value] of bars) {
    const want = inv[label.replace(/ \(women\)$/u, "").toLowerCase()];
    assert.equal(value, want.toFixed(2), label);
    assert.equal(Number(width), Math.round(want * 100), `${label} bar width`);
    assert.match(read("deck/deck.css"), new RegExp(`\\.w${width} \\{ width: ${width}%; \\}`, "u"), `.w${width} exists`);
  }
  assert.match(html, new RegExp(`Chronic fatigue at ${inv["chronic fatigue"].toFixed(2)} means`, "u"));
  // slide 3: the women-to-men Long COVID coding ratio, with the health-system caveat
  const women = data("long_covid").rows.find((r) => r.axis === "sex" && r.category === "Female" && r.definition === "ever");
  assert.match(html, new RegExp(`<strong>${women.ratio.toFixed(2)} times</strong> the share for men \\(95% interval ${women.ratio_low.toFixed(2)} to ${women.ratio_high.toFixed(2)}\\)\\. This comparison is not adjusted for health system\\.`, "u"));
  // slide 10: cost per later-coded patient found, from the Atlas calculator defaults
  const { compute, DEFAULTS } = await import("../web/atlas/calc.js");
  const r = compute(DEFAULTS);
  const costs = [...html.matchAll(/<span class="cost-num">\$(\d+)<\/span>/gu)].map((m) => Number(m[1]));
  assert.deepEqual(costs, [Math.round(r.twoStep.costPerFound), Math.round(r.chart.costPerFound)]);
  assert.match(html, new RegExp(`measured recall ${Math.round(DEFAULTS.recall * 100)}% and PPV ${(DEFAULTS.ppv * 100).toFixed(1)}%`, "u"));
  // slides 7 to 11: door cards and "Door n" kickers use the site bar's door names
  const nav = read("shared/site-nav.js");
  const names = [...nav.matchAll(/\["(?:patient|clinician|atlas|developers)", "[^"]+", "([^"]+)"\]/gu)].map((m) => m[1]);
  assert.deepEqual(names, ["Clinicians", "Patients", "Policymakers", "Developers"]);
  // the deck tells the story patient first, so it uses the bar's names in its own order
  const deckDoors = [...html.matchAll(/<p class="door-who">([^<]+)<\/p>/gu)].map((m) => m[1]);
  assert.deepEqual([...deckDoors].sort(), [...names].sort());
  assert.deepEqual([...html.matchAll(/<p class="kicker">Door (\d) · ([^<]+)<\/p>/gu)].map((m) => `${m[1]} ${m[2]}`), deckDoors.map((n, i) => `${i + 1} ${n}`));
});
