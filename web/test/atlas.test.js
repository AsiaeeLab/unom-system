// Atlas (/atlas/): one condition at a time. Covers the data build (the files equal a fresh run of
// analysis/build_atlas_data.py), traceability (every value has a source and is recomputed here from the released
// file it names), the All of Us small-cell rule on this page (no count of 1 to 20, or one recoverable from shown values), the condition
// selector's deep links, CSP-safe markup, copy rules, agreement with the papers, and the cost calculator.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULTS, compute, flags, foundAmongFlags, impliedLaterCoded, leadFraction, avoidedPerFound, reviewCost,
  chartReview, twoStep, normalize, costPerFound,
} from "../web/atlas/calc.js";
import { PARAM, conditionHref, normalizeSlug, resolveCondition } from "../web/atlas/route.js";

// Some restricted runtimes report EPERM after a successful child exit. Verify the
// exit status and the expected output, while still failing genuine child failures.
function runPython(args, options) {
  const r = spawnSync("python3", args, options);
  if (r.status !== 0 || (r.error && r.error.code !== "EPERM")) {
    throw r.error || new Error(String(r.stderr));
  }
  return r.stdout;
}

const repo = new URL("../../", import.meta.url);
const dataDir = new URL("../web/atlas/data/", import.meta.url);
const readRepo = (rel) => readFileSync(new URL(rel, repo), "utf8");
const html = readFileSync(new URL("../web/atlas/index.html", import.meta.url), "utf8");
const js = readFileSync(new URL("../web/atlas/atlas.js", import.meta.url), "utf8");
const css = readFileSync(new URL("../web/atlas/atlas.css", import.meta.url), "utf8");
const manifest = JSON.parse(readFileSync(new URL("conditions/index.json", dataDir), "utf8"));
const conds = Object.fromEntries(manifest.conditions.map((c) => [c.slug, JSON.parse(readFileSync(new URL(`conditions/${c.file}`, dataDir), "utf8"))]));
const isNum = (x) => typeof x === "number" && Number.isFinite(x);
const near = (a, b, tol = 1e-6, what = "") => assert.ok(Math.abs(a - b) <= tol, `${what} ${a} is not within ${tol} of ${b}`);
const BANNED = /\b(?:seamless\w*|leverag\w*|robust\w*|comprehensive|empower\w*|unlock\w*|delv(?:e|es|ing)|cutting-edge|game-chang\w*)\b/iu;
const BRITISH = /\b(?:colour|behaviour|analys(?:e|ed|ing)|organis|summaris|centre|programme|labelled|modelled|catalogue|grey|ageing|haemo|anaesth|oedema|leukaemia|foetus|defence)\w*/iu;
const HIDDEN = new Set(["<=20", "hidden", "<=20 jointly"]);

// ---------- released files ----------

function parseCSV(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') quoted = false; else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(cell); cell = ""; } else if (ch === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; } else if (ch !== "\r") cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const [head, ...body] = rows;
  return body.filter((r) => r.length === head.length).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}
const csvCache = new Map();
const csv = (rel) => {
  if (!csvCache.has(rel)) csvCache.set(rel, parseCSV(readRepo(rel)));
  return csvCache.get(rel);
};
const lookup = (rel, where) => csv(rel).find((r) => Object.entries(where).every(([k, v]) => r[k] === v));
// A summary source with op "sum" names several rows (a list in `where`); its counts are their sums.
const summed = (src) => {
  const rows = csv(src.file).filter((r) => Object.entries(src.where).every(([k, v]) => (Array.isArray(v) ? v.includes(r[k]) : r[k] === v)));
  return { [src.num]: String(rows.reduce((t, r) => t + released(r[src.num]), 0)), [src.den]: String(rows.reduce((t, r) => t + released(r[src.den]), 0)) };
};
const summaryRow = (src) => (src.op === "sum" ? summed(src) : lookup(src.file, src.where));
const released = (v) => {
  const x = Number(v);
  return v !== "" && Number.isFinite(x) ? Math.round(x) : null;
};

function wilson(k, n) {
  const z = 1.96;
  const p = k / n;
  const d = 1 + z * z / n;
  const c = (p + z * z / (2 * n)) / d;
  const h = (z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / d;
  return [p, c - h, c + h];
}
function katz(a, n1, b, n0) {
  const r = (a / n1) / (b / n0);
  const se = Math.sqrt(1 / a - 1 / n1 + 1 / b - 1 / n0);
  return [r, r * Math.exp(-1.96 * se), r * Math.exp(1.96 * se)];
}

// Every block that carries numbers, with its source and rows (cells keyed by row id).
function blocks(c) {
  const out = [];
  for (const v of c.groups?.variants || []) {
    for (const a of v.axes) out.push({ kind: "axis", where: `${c.slug} groups ${v.id} ${a.id}`, block: a, src: a.src, rows: a.rows.map((r) => [r.id, r]) });
  }
  for (const l of c.map.layers) out.push({ kind: "layer", where: `${c.slug} map ${l.id}`, block: l, src: l.src, rows: Object.entries(l.states) });
  for (const m of c.wearables?.measures || []) out.push({ kind: "wear", where: `${c.slug} wearables ${m.id}`, block: m, src: m.src, rows: m.rows.map((r) => [r.id, r]) });
  return out;
}

// The self-reported conditions (Paper 2's measures), their names in Paper 2's tables, and the files their
// "what else is in the record" panels read (present or not yet released).
const SELF_REPORT = ["mecfs", "lyme", "lupus", "fibromyalgia", "migraine", "endometriosis", "depression", "anxiety"];
const p2Name = { mecfs: "Chronic fatigue", fibromyalgia: "Fibromyalgia", lyme: "Lyme disease", endometriosis: "Endometriosis", migraine: "Migraine", depression: "Depression", anxiety: "Anxiety" };
const RELATED_FILE = {
  mecfs: "results/aggregate/33/t33_feature_label_counts.csv",
  fibromyalgia: "results/aggregate/39/t39_fibromyalgia_feature_label_counts.csv",
  endometriosis: "results/aggregate/39/t39_endometriosis_feature_label_counts.csv",
  migraine: "results/aggregate/55/t55_migraine_feature_label_counts.csv",
  depression: "results/aggregate/55/t55_depression_feature_label_counts.csv",
  anxiety: "results/aggregate/55/t55_anxiety_feature_label_counts.csv",
};
const WEAR_FILE = "results/aggregate/48/t48_selfreport_profiles.csv";

// ---------- 1. the data files are the build script's output ----------

test("data files equal a fresh run of analysis/build_atlas_data.py, and no stale file is left", (t) => {
  let out;
  try {
    out = mkdtempSync(join(tmpdir(), "atlas-"));
    runPython(["analysis/build_atlas_data.py", "--out", out, "--quiet"], { cwd: new URL(repo).pathname, stdio: "pipe" });
  } catch (e) {
    if (out) rmSync(out, { recursive: true, force: true });
    return t.skip(`python3 with pandas is needed to rebuild the data (${String(e.message).split("\n")[0]})`);
  }
  try {
    const built = ["invisible.json", "long_covid.json", ...readdirSync(join(out, "conditions")).map((f) => `conditions/${f}`)];
    for (const f of built) {
      assert.equal(readFileSync(new URL(f, dataDir), "utf8"), readFileSync(join(out, f), "utf8"), `${f} differs from the build output; rerun the script`);
    }
    const shipped = [...readdirSync(dataDir).filter((f) => f !== "conditions"), ...readdirSync(new URL("conditions/", dataDir)).map((f) => `conditions/${f}`)];
    assert.deepEqual(shipped.sort(), built.sort(), "every shipped data file comes from the build");
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("the homepage and deck files keep their schema: invisible.json has the 8 Paper 2 conditions, long_covid.json the coding fractions", () => {
  const inv = JSON.parse(readFileSync(new URL("invisible.json", dataDir), "utf8"));
  assert.equal(inv.conditions.length, 8);
  for (const k of ["source", "measure", "conditions", "anchors", "by_sex", "by_race", "survey_comparison", "sex_adjusted"]) assert.ok(k in inv, k);
  assert.equal(inv.conditions.find((c) => c.id === "chronic_fatigue").overall.relative.toFixed(2), "0.28");
  const lc = JSON.parse(readFileSync(new URL("long_covid.json", dataDir), "utf8"));
  assert.equal(lc.rows.find((r) => r.axis === "sex" && r.category === "Female" && r.definition === "ever").ratio.toFixed(2), "0.79");
  assert.doesNotMatch(js, /invisible|long_covid\.json/u, "the Atlas page itself no longer loads the older files");
});

// ---------- 2. one schema, a source for every value ----------

test("the selector lists exactly the condition files that exist, grouped by family and in order; lupus waits for its data", () => {
  assert.equal(manifest.schema, "unom-atlas-index/1");
  const files = readdirSync(new URL("conditions/", dataDir)).filter((f) => f !== "index.json").sort();
  assert.deepEqual(manifest.conditions.map((c) => c.file).sort(), files);
  // Lupus appears only once a released table in the Paper 2 formats has lupus rows.
  const lupusRows = readdirSync(new URL("results/aggregate/", repo)).some((d) => {
    const dir = new URL(`results/aggregate/${d}/`, repo);
    return readdirSync(dir).some((f) => f.endsWith(".csv") && /(^|\n)lupus,|,lupus,/u.test(readFileSync(new URL(f, dir), "utf8")));
  });
  assert.equal(manifest.conditions.some((c) => c.slug === "lupus"), lupusRows);
  const family = {
    longcovid: "infection", mecfs: "infection", lyme: "infection", lupus: "autoimmune", fibromyalgia: "pain", migraine: "pain",
    endometriosis: "womens", depression: "mental", anxiety: "mental",
  };
  assert.deepEqual(manifest.conditions.map((c) => c.slug), Object.keys(family).filter((s) => s !== "lupus" || lupusRows), "nine conditions, family by family");
  assert.deepEqual(manifest.families.map((f) => [f.id, f.label]), [
    ["infection", "Infection-associated chronic illness"], ["autoimmune", "Autoimmune"], ["pain", "Chronic pain"],
    ["womens", "Women's health"], ["mental", "Mental health"],
  ].filter(([id]) => id !== "autoimmune" || lupusRows), "a family is listed only when it has a condition");
  for (const c of manifest.conditions) {
    assert.equal(c.family, family[c.slug], c.slug);
    assert.equal(conds[c.slug].family, c.family, `${c.slug}: the condition file names the same family`);
    assert.equal(conds[c.slug].order, manifest.conditions.indexOf(c), `${c.slug}: order`);
  }
  // Within the list, each family's conditions are consecutive (the selector draws one group per family).
  const runs = manifest.conditions.map((c) => c.family).filter((f, i, a) => f !== a[i - 1]);
  assert.deepEqual(runs, [...new Set(runs)]);
  assert.ok(manifest.conditions.some((c) => c.slug === manifest.default));
  for (const [slug, c] of Object.entries(conds)) {
    assert.equal(c.schema, "unom-atlas-condition/1", slug);
    assert.equal(c.slug, slug);
    for (const k of ["label", "name", "definition", "source", "summary", "map", "groups", "related", "wearables", "trajectory"]) assert.ok(k in c, `${slug}: ${k}`);
    assert.ok("calculator" in c, `${slug}: calculator (null when the condition has no cost model)`);
    assert.ok(c.summary.length >= 2 && c.summary.length <= 3, `${slug}: 2 or 3 key numbers`);
    if (slug !== "lupus") assert.ok(c.map.layers.length >= 1, `${slug}: a state map`);
    const axes = c.groups.variants[0].axes.map((a) => a.id).sort();
    // Endometriosis is analyzed among women only, so a sex axis would repeat the whole population.
    assert.deepEqual(axes, slug === "endometriosis" ? ["age", "race"] : ["age", "race", "sex"], `${slug}: age group, sex, and race and ethnicity`);
  }
});

test("every number in a condition file sits under a source naming a released file in results/ or opendata/processed/", () => {
  const okFile = (f) => /^(results\/|opendata\/processed\/)/u.test(f) && existsSync(new URL(f, repo));
  for (const [slug, c] of Object.entries(conds)) {
    for (const f of c.source) assert.ok(okFile(f) || /^paper2\/results\//u.test(f), `${slug}: source ${f}`);
    const walk = (node, path, hasSrc) => {
      if (Array.isArray(node)) { node.forEach((x, i) => walk(x, `${path}[${i}]`, hasSrc)); return; }
      if (node && typeof node === "object") {
        const src = node.src || node.ref_src;
        let here = hasSrc;
        if (src) {
          const files = [].concat(src.file);
          for (const f of files) assert.ok(okFile(f), `${slug} ${path}: ${f} is a released file`);
          here = true;
        }
        for (const [k, v] of Object.entries(node)) {
          if (k === "src" || k === "ref_src" || k === "bins" || k === "domain" || k === "order" || k === "digits") continue;
          if (isNum(v)) assert.ok(here, `${slug} ${path}.${k} = ${v} has no source`);
          else walk(v, `${path}.${k}`, here);
        }
      }
    };
    walk(c, slug, false);
  }
});

test("shares, intervals, and comparison marks recompute from the released counts they name", () => {
  for (const c of Object.values(conds)) {
    for (const { where, block, src, rows } of blocks(c)) {
      for (const [id, r] of rows) {
        const row = lookup(src.file, { ...(src.where || {}), [src.key]: id, ...(r.where || {}) });
        assert.ok(row, `${where} ${id}: row in ${src.file}`);
        if (!isNum(r.v)) continue;
        if (src.fields) {
          for (const [k, col] of Object.entries(src.fields)) {
            if (!(k in r)) continue;
            const want = Number(row[col]);
            if (k === "band") assert.equal(r[k], row[col]);
            else near(r[k], want, 6e-5, `${where} ${id} ${k}:`);
          }
        } else {
          const [p, lo, hi] = wilson(released(row[src.num]), released(row[src.den]));
          near(r.v, p, 6e-5, `${where} ${id} v:`);
          near(r.lo, lo, 6e-5, `${where} ${id} lo:`);
          near(r.hi, hi, 6e-5, `${where} ${id} hi:`);
        }
        if (isNum(r.lo)) assert.ok(r.lo <= r.v + 1e-9 && r.v <= r.hi + 1e-9, `${where} ${id}: interval contains the estimate`);
        if (isNum(r.ref)) {
          const rs = block.ref_src;
          const ps = rs.conditions.map((cond) => {
            const a = lookup(rs.file, { ...rs.where, condition: cond, [rs.key]: id });
            return released(a[rs.num]) / released(a[rs.den]);
          });
          near(r.ref, ps.reduce((s, x) => s + x, 0) / ps.length, 6e-5, `${where} ${id} ref:`);
        }
      }
    }
    // Related conditions: two shares and their ratio from the 2x2 counts (or cases and matched controls).
    const rel = c.related;
    for (const r of rel?.rows || []) {
      const row = lookup(rel.src.file, { [rel.src.key]: r.id });
      assert.ok(row, `${c.slug} related ${r.id}`);
      let a; let n1; let b; let n0;
      if (rel.src.cells) {
        const k = Object.fromEntries(Object.entries(rel.src.cells).map(([x, col]) => [x, released(row[col])]));
        [a, n1, b, n0] = [k.a, k.a + k.c, k.b, k.b + k.d];
        for (const x of Object.values(k)) assert.ok(x > 20, `${c.slug} ${r.id}: every 2x2 cell shown is over 20`);
      } else {
        [a, n1, b, n0] = [rel.src.with[0], rel.src.with[1], rel.src.without[0], rel.src.without[1]].map((col) => released(row[col]));
      }
      near(r.with, wilson(a, n1)[0], 6e-5, `${c.slug} ${r.id} with:`);
      if (b === null) {
        assert.ok(!isNum(r.ratio), `${c.slug} ${r.id}: suppressed comparison stays hidden`);
        assert.ok(!("without" in r) || r.without === null);
        continue;
      }
      const [ratio, lo, hi] = katz(a, n1, b, n0);
      near(r.without, wilson(b, n0)[0], 6e-5, `${c.slug} ${r.id} without:`);
      near(r.ratio, ratio, 6e-4, `${c.slug} ${r.id} ratio:`);
      near(r.lo, lo, 6e-4, `${c.slug} ${r.id} lo:`);
      near(r.hi, hi, 6e-4, `${c.slug} ${r.id} hi:`);
    }
  }
});

// ---------- 3. the small-cell rule on this page ----------

// Numeric keys a condition file may hold for All of Us data: shares, ratios, intervals. No participant counts.
const SHARE_KEYS = new Set(["v", "lo", "hi", "ref", "rel", "rlo", "rhi", "coded", "pi", "per", "ratio", "ratio_lo", "ratio_hi",
  "with", "with_lo", "with_hi", "without", "without_lo", "without_hi", "value", "max", "order", "digits"]);

// Units of means (wearable profiles): their values are averages, not proportions, and not counts either.
const MEAN_UNITS = new Set(["steps", "minutes"]);

test("no All of Us participant count, numerator or denominator, appears in a condition file", () => {
  for (const [slug, c] of Object.entries(conds)) {
    const walk = (node, path, aou, unit) => {
      if (Array.isArray(node)) { node.forEach((x, i) => walk(x, `${path}[${i}]`, aou, unit)); return; }
      if (!node || typeof node !== "object") return;
      const src = node.src;
      const isAou = src ? [].concat(src.file).some((f) => f.startsWith("results/")) : aou;
      const u = node.unit ?? unit;
      for (const [k, v] of Object.entries(node)) {
        if (k === "src" || k === "ref_src" || k === "domain" || k === "calculator") continue;
        if (isNum(v) && isAou) assert.ok(SHARE_KEYS.has(k), `${slug} ${path}.${k}: "${k}" is not a share or ratio`);
        if (isNum(v) && isAou && u !== "ratio" && !MEAN_UNITS.has(u) && !["value", "max", "order", "digits", "per", "ratio", "lo", "hi", "ratio_lo", "ratio_hi", "rel", "rlo", "rhi"].includes(k)) {
          assert.ok(v >= 0 && v <= 1, `${slug} ${path}.${k} = ${v} is a proportion`);
        }
        walk(v, `${path}.${k}`, isAou, u);
      }
    };
    walk({ ...c, calculator: null }, slug, false, undefined);
    if (c.calculator) {
      assert.deepEqual(Object.keys(c.calculator.measured).sort(), ["excess_cost", "lead_days", "lead_p25_days", "lead_p75_days", "ppv", "recall", "window_days"],
        "calculator inputs are dollars, days, and rates, not counts");
    }
  }
  // The page script draws only values from the files: no count fields are read.
  assert.doesNotMatch(js, /\.n_self_report|\.n_coded|\.n_both|\bn_cases\b|\.cases_with|n_people/u);
});

test("cells released as <=20, hidden, or <=20 jointly stay hidden, and every shown share rests on counts over 20 (or 0)", () => {
  for (const c of Object.values(conds)) {
    for (const { where, src, rows } of blocks(c)) {
      if (!src.num) continue;
      for (const [id, r] of rows) {
        const row = lookup(src.file, { ...(src.where || {}), [src.key]: id });
        const labels = [row[src.num], row[src.den], ...Object.values(src.fields || {}).map((col) => row[col])];
        if (labels.some((x) => HIDDEN.has(String(x).trim()))) assert.ok(!isNum(r.v), `${where} ${id}: released hidden, shown here`);
        if (isNum(r.v)) {
          for (const x of [released(row[src.num]), released(row[src.den])]) assert.ok(x === 0 || x > 20, `${where} ${id}: count ${x}`);
          assert.ok(released(row[src.den]) > 20, `${where} ${id}: denominator over 20`);
        } else {
          assert.ok(["suppressed", "complement", "none"].includes(r.why), `${where} ${id}: hidden with a reason`);
        }
      }
    }
  }
});

// Worst case: a reader recovers the counts behind every share shown with a binomial interval. Within each
// population, a complete partition whose total is known may not have exactly one hidden group, and its hidden
// groups together may not total 1 to 20. Totals are known from a shown total or from a fully shown complete
// partition of the same population.
function auditPopulations(pops) {
  const problems = [];
  for (const [pop, p] of Object.entries(pops)) {
    for (const kind of ["num", "den"]) {
      let total = p.totals.map((t) => t[kind]).find((x) => x !== null && x !== undefined) ?? null;
      if (total === null) {
        const full = p.axes.find((a) => a.complete && a.rows.every((r) => r.shown && r[kind] !== null));
        if (full) total = full.rows.reduce((s, r) => s + r[kind], 0);
      }
      if (total === null) continue;
      for (const a of p.axes) {
        const hidden = a.rows.filter((r) => !r.shown);
        if (!a.complete || !hidden.length) continue;
        const residual = total - a.rows.filter((r) => r.shown).reduce((s, r) => s + r[kind], 0);
        if (hidden.length === 1) problems.push(`${pop} ${a.id} ${kind}: one hidden group (${hidden[0].id}) is recoverable`);
        else if (residual >= 1 && residual <= 20) problems.push(`${pop} ${a.id} ${kind}: hidden groups total ${residual}`);
      }
    }
  }
  return problems;
}

function pagePopulations() {
  const pops = {};
  const pop = (id) => (pops[id] ||= { axes: [], totals: [] });
  for (const c of Object.values(conds)) {
    for (const { block, src, rows } of blocks(c)) {
      if (src.ci !== "wilson") continue;
      pop(`${block.population} | ${src.file}`).axes.push({
        id: block.id, complete: block.complete,
        rows: rows.map(([id, r]) => {
          const row = lookup(src.file, { ...(src.where || {}), [src.key]: id });
          return { id, num: released(row[src.num]), den: released(row[src.den]), shown: isNum(r.v) };
        }),
      });
      if (block.national) {
        const us = lookup(src.file, { ...(src.where || {}), [src.key]: "US" });
        pop(`${block.population} | ${src.file}`).totals.push({ num: released(us[src.num]), den: released(us[src.den]) });
      }
    }
    for (const s of c.summary) {
      if (s.src?.ci !== "wilson" || !s.population) continue;
      const row = summaryRow(s.src);
      pop(`${s.population} | ${s.src.file}`).totals.push({ num: released(row[s.src.num]), den: released(row[s.src.den]) });
    }
  }
  return pops;
}

test("small-cell audit: complements are checked within each released source table", () => {
  const pops = pagePopulations();
  // Every self-reported condition adds its all-lengths and 5-year populations; Long COVID adds its cohort.
  // Populations are keyed per released source table ("<population> | <file>") where one population spans tables.
  const has = (prefix) => Object.keys(pops).some((k) => k === prefix || k.startsWith(`${prefix} | `));
  const pop = (prefix) => pops[prefix] || pops[Object.keys(pops).find((k) => k.startsWith(`${prefix} | `))];
  for (const slug of SELF_REPORT.filter((s) => conds[s])) {
    assert.ok(has(`${slug}: current self-reporters, all lengths of record`), `${slug}: groups audited`);
    if (slug !== "lupus") assert.ok(has(`${slug}: current self-reporters, 5 or more years of records`), `${slug}: headline and states audited`);
  }
  assert.deepEqual(auditPopulations(pops), []);
  // The partitions really are checked: for fibromyalgia the age groups give the total, and race has 2 hidden groups.
  const fm = pops["fibromyalgia: current self-reporters, all lengths of record | results/aggregate/27/t27_selfreport_by_group.csv"];
  assert.ok(fm.axes.find((a) => a.id === "age").rows.every((r) => r.shown));
  assert.equal(fm.axes.find((a) => a.id === "race").rows.filter((r) => !r.shown).length, 2);
  // Migraine, depression, and anxiety show every group, so each axis is a complete, fully shown partition.
  for (const slug of ["migraine", "depression", "anxiety"]) {
    for (const a of pop(`${slug}: current self-reporters, all lengths of record`).axes) assert.ok(a.rows.every((r) => r.shown), `${slug} ${a.id}`);
  }
  // Endometriosis: one age group and two race groups hidden, no sex axis, so no total for the hidden groups to be
  // subtracted from; its headline and state map are the 5-year population, a different partition.
  const en = pop("endometriosis: current self-reporters, all lengths of record");
  assert.deepEqual(en.axes.map((a) => a.id), ["age", "race"]);
  assert.deepEqual(en.totals, []);
  assert.deepEqual(en.axes.map((a) => a.rows.filter((r) => !r.shown).length), [1, 2], "endometriosis hidden age and race groups");
  // Nothing on the page was hidden as a complement: every new condition matches Paper 2's eTables cell for cell.
  const complements = Object.values(conds).flatMap((c) => blocks(c).flatMap(({ rows }) => rows.filter(([, r]) => r.why === "complement")));
  assert.deepEqual(complements, []);
});

test("wearable profiles: means and 95% CIs equal the released file, only for groups of more than 20, with no counts and no heart rate", () => {
  const rows = csv(WEAR_FILE);
  const aou = { mecfs: "chronic_fatigue", fibromyalgia: "fibromyalgia", endometriosis: "endometriosis" };
  for (const [slug, c] of Object.entries(conds)) {
    assert.equal(Boolean(c.wearables), Boolean(aou[slug]) && rows.some((r) => r.condition === aou[slug]), `${slug}: panel exactly when the file has rows`);
  }
  for (const slug of Object.keys(aou)) {
    const w = conds[slug].wearables;
    assert.deepEqual(w.measures.map((m) => m.id), ["steps", "sedentary", "very_active", "asleep"], `${slug}: four measures, no heart rate`);
    assert.deepEqual(w.groups.map((g) => g.id), ["report", "other"]);
    assert.equal(w.source.text, "NIH All of Us Research Program, Registered Tier v9, Fitbit data; analysis from this project (not in a paper).");
    assert.doesNotMatch(JSON.stringify(w), /heart|bpm|n_people|"n"|p10|p25|p50|p75|p90/u, `${slug}: no heart rate, counts, or percentiles`);
    for (const m of w.measures) {
      assert.equal(m.src.file, WEAR_FILE);
      assert.deepEqual(m.rows.map((r) => r.id), ["self-reporters, never coded", "self-reporters, coded later", "all self-reporters", "non-reporters",
        "non-reporters, standardized to self-reporters by age band and sex"]);
      for (const r of m.rows) {
        assert.deepEqual(Object.keys(r).filter((k) => !["id", "label", "group", "v", "lo", "hi", "why"].includes(k)), [], `${slug} ${m.id} ${r.id}: keys`);
        const row = lookup(WEAR_FILE, { ...m.src.where, group: r.id });
        assert.ok(row, `${slug} ${m.id} ${r.id}: released row`);
        if (isNum(r.v)) {
          assert.ok(released(row.n_people) > 20, `${slug} ${m.id} ${r.id}: shown only for more than 20 people`);
          assert.deepEqual([r.v, r.lo, r.hi], [Number(row.mean), Number(row.ci_low), Number(row.ci_high)], `${slug} ${m.id} ${r.id}`);
        } else {
          assert.ok(HIDDEN.has(row.n_people.trim()), `${slug} ${m.id} ${r.id}: hidden because the release hid it`);
          assert.equal(r.why, "suppressed");   // since the October 15 rerun the release may keep its statistics
        }
      }
    }
  }
  // Groups whose count the release hid (20 or fewer, or a complement) stay hidden, and only those: for endometriosis,
  // self-reporters coded later (20 or fewer) and never coded (its complement), in every measure.
  const hidden = (slug, m) => conds[slug].wearables.measures.find((x) => x.id === m).rows.filter((r) => !isNum(r.v)).map((r) => r.id);
  for (const slug of Object.keys(aou)) {
    for (const m of conds[slug].wearables.measures) {
      const expected = m.rows.filter((r) => HIDDEN.has(lookup(WEAR_FILE, { ...m.src.where, group: r.id }).n_people.trim())).map((r) => r.id);
      assert.deepEqual(hidden(slug, m.id), expected, `${slug} ${m.id}`);
    }
  }
  for (const m of ["steps", "sedentary", "very_active", "asleep"]) assert.deepEqual(hidden("endometriosis", m), ["self-reporters, never coded", "self-reporters, coded later"]);
  // The released heart-rate proxy is 30.0 in every row that has a value: a data artifact, so the Atlas leaves it out.
  const hr = rows.filter((r) => /heart rate/u.test(r.measure) && r.mean !== "");
  assert.ok(hr.length > 0 && hr.every((r) => [r.mean, r.ci_low, r.ci_high].every((x) => Number(x) === 30)));
  // Takeaways compare never-coded self-reporters with non-reporters of the same age and sex mix.
  assert.equal(conds.mecfs.wearables.measures[0].takeaway, "In the year before the survey, people who report chronic fatigue but were never coded for it averaged 5,124 steps a day, against 7,279 for people who do not report it with the same age and sex mix. Those coded later averaged 6,041.");
  // Endometriosis: the never-coded count is hidden (complement of the small coded-later group), so the takeaway
  // describes all women who report it.
  assert.match(conds.endometriosis.wearables.measures[3].takeaway, /women who report endometriosis averaged 370 minutes asleep a night, about the same as women who do not report it with the same age mix \(373\)\.$/u);
  // The page: a panel with a measure toggle and a data table of means and intervals only.
  const sec = html.match(/<section class="panel" id="wearables"[\s\S]*?<\/section>/u)?.[0] || "";
  assert.match(sec, /aria-labelledby="wearables-title" hidden>/u, "hidden until a condition with wearable data is shown");
  assert.match(sec, /id="wearables-controls" role="group" aria-label="Wearable measure"/u);
  assert.match(js, /table\(m\.title, \[\{ label: "Group" \}, \{ label: "Mean", num: true \}, \{ label: "95% CI", num: true \}\], trows\)/u);
});

test("Long COVID activity and sleep: the weekly series around COVID-19 equals the released file, with hidden weeks left as gaps", () => {
  const TRAJ_FILE = "results/aggregate/48/t48_lc_trajectory.csv";
  for (const [slug, c] of Object.entries(conds)) {
    assert.equal(Boolean(c.trajectory), slug === "longcovid", `${slug}: the weekly series is Long COVID's alone`);
    if (slug === "longcovid") assert.equal(c.wearables, null, "Long COVID has no profile block; its panel draws the weekly series");
  }
  const t = conds.longcovid.trajectory;
  assert.ok(conds.longcovid.source.includes(TRAJ_FILE), "the condition's source list names the released file");
  assert.deepEqual(t.weeks, Array.from({ length: 53 }, (_, i) => i - 26), "weeks -26 to +26");
  assert.deepEqual(t.measures.map((m) => m.id), ["steps", "sedentary", "asleep"], "three measures, no heart rate");
  assert.deepEqual(t.comparisons.map((c) => [c.id, c.groups.map((g) => g.id)]), [
    ["band", ["band_high_or_elevated", "band_typical"]], ["symptoms", ["sym_count_ge2", "sym_count_lt2"]], ["all", ["all"]]]);
  assert.equal(t.source.text, "NIH All of Us Research Program, Registered Tier v9, Fitbit data; analysis from this project (not in a paper).");
  assert.doesNotMatch(JSON.stringify(t), /heart|bpm|rest_hr|n_group|n_steps|n_sedentary|n_asleep|"n"/u, "no heart rate and no counts");
  let hidden = 0;
  for (const m of t.measures) {
    assert.equal(m.src.file, TRAJ_FILE);
    assert.deepEqual(m.src.fields, { v: `${m.id}_mean`, lo: `${m.id}_ci_low`, hi: `${m.id}_ci_high` });
    assert.ok(MEAN_UNITS.has(m.unit), `${m.id}: a mean's unit`);
    assert.deepEqual(Object.keys(m.series).sort(), ["all", "band_high_or_elevated", "band_typical", "sym_count_ge2", "sym_count_lt2"]);
    for (const [g, s] of Object.entries(m.series)) {
      for (const k of ["v", "lo", "hi"]) assert.equal(s[k].length, t.weeks.length, `${m.id} ${g} ${k}: one value per week`);
      t.weeks.forEach((w, i) => {
        const row = lookup(TRAJ_FILE, { week: `week ${w >= 0 ? "+" : "-"}${Math.abs(w)}`, group: g });
        assert.ok(row, `${m.id} ${g} week ${w}: released row`);
        const n = row[`n_${m.id}`].trim();
        if (isNum(s.v[i])) {
          assert.ok(released(n) > 20, `${m.id} ${g} week ${w}: shown only for more than 20 people`);
          assert.deepEqual([s.v[i], s.lo[i], s.hi[i]], [Number(row[`${m.id}_mean`]), Number(row[`${m.id}_ci_low`]), Number(row[`${m.id}_ci_high`])], `${m.id} ${g} week ${w}`);
          assert.ok(s.lo[i] <= s.v[i] && s.v[i] <= s.hi[i], `${m.id} ${g} week ${w}: interval contains the mean`);
        } else {
          hidden++;
          assert.ok(HIDDEN.has(n) || !(released(n) > 20), `${m.id} ${g} week ${w}: hidden only where the release hid it`);
          assert.deepEqual([s.lo[i], s.hi[i]], [null, null], `${m.id} ${g} week ${w}: no interval for a hidden week`);
        }
        // and every week the release hid stays hidden, though the file keeps its mean
        if (HIDDEN.has(n)) assert.equal(s.v[i], null, `${m.id} ${g} week ${w}: released as ${n}, shown here`);
      });
    }
  }
  assert.ok(hidden > 0, "the release hides some weeks, so the page has gaps to draw");
  // The takeaway (the Research page's sentence) recomputes from the series it names.
  const steps = t.measures.find((m) => m.id === "steps").series;
  const both = t.weeks.map((w, i) => i).filter((i) => t.weeks[i] < 0 && isNum(steps.band_high_or_elevated.v[i]) && isNum(steps.band_typical.v[i]));
  assert.deepEqual(t.takeaway_src.weeks, both.map((i) => t.weeks[i]));
  const mean = (a) => both.reduce((x, i) => x + a[i], 0) / both.length;
  const diff = Math.round((mean(steps.band_typical.v) - mean(steps.band_high_or_elevated.v)) / 100) * 100;
  assert.equal(t.takeaway, `In the months before COVID-19, people whose chart score at day 90 was High or Elevated took about ${diff.toLocaleString("en-US")} fewer steps a day than people scored Typical.`);
  // The page: the same panel, a second toggle row for the comparison, a live region for the keyboard readout, a
  // line chart that breaks at hidden weeks, and a data table of every week.
  const sec = html.match(/<section class="panel" id="wearables"[\s\S]*?<\/section>/u)?.[0] || "";
  assert.match(sec, /id="wearables-compare" role="group" aria-label="Compare" hidden>/u);
  assert.match(sec, /<p class="visually-hidden" id="wearables-live" aria-live="polite"><\/p>/u);
  assert.match(js, /section\.hidden = !w && !t;/u, "the panel shows for a profile block or a weekly series");
  assert.match(js, /if \(t\) \{\s*renderTrajectory\(t\);/u);
  assert.match(js, /if \(isNum\(v\)\) cur\.push\(i\);\s*else if \(cur\.length\) \{ out\.push\(cur\); cur = \[\]; \}/u, "lines break at hidden weeks, never interpolated");
  assert.match(js, /"Not shown for privacy"/u);
  assert.match(js, /"Weeks from the COVID-19 diagnosis"/u);
  assert.match(js, /table\(`\$\{title\}, weekly mean with 95% CI`/u);
  assert.match(js, /\[WHY\.suppressed, ""\]/u, "a hidden week says so in the table");
});

test("small-cell audit catches a recoverable cell, and the build suppresses its complement", (t) => {
  const row = (id, num, den, shown = true) => ({ id, num, den, shown });
  const base = () => ({ p: { totals: [], axes: [
    { id: "sex", complete: true, rows: [row("F", 400, 900), row("M", 100, 300)] },
    { id: "age", complete: true, rows: [row("a", 300, 500), row("b", 190, 680), row("c", 10, 20, false)] },
  ] } });
  assert.deepEqual(auditPopulations(base()).map((p) => p.match(/ (num|den):/u)[1]), ["num", "den"], "one hidden group with a known total, numerator and denominator");
  const two = base();
  two.p.axes[1].rows[1].shown = false;
  assert.equal(auditPopulations(two).length, 0, "two hidden groups totaling more than 20 pass");
  const small = base();
  small.p.axes[1].rows = [row("a", 300, 500), row("b", 185, 660), row("c", 10, 20, false), row("d", 5, 20, false)];
  assert.ok(auditPopulations(small).some((p) => /total 15/u.test(p)), "hidden groups totaling 1 to 20 fail");
  const open = base();
  open.p.axes[0].rows[1].shown = false;
  assert.equal(auditPopulations(open).length, 0, "no known total, nothing to recover");
  // The Python build applies the same rule and hides the smallest shown group (complementary suppression).
  const py = `
import sys; sys.path.insert(0, "analysis")
import build_atlas_data as b
a = b.Audit()
rows = []
for gid, k, n, shown in (("a", 300, 500, True), ("b", 190, 680, True), ("c", 10, 20, False)):
    rows.append({"num": k, "den": n, "shown": shown, "json": {"id": gid, "v": 0.5 if shown else None}})
a.axis("p", "age", True, rows)
a.axis("p", "sex", True, [{"num": 400, "den": 900, "shown": True, "json": {"id": "F", "v": 0.4}}, {"num": 100, "den": 300, "shown": True, "json": {"id": "M", "v": 0.3}}])
print(a.enforce(), rows[1]["json"])
bb = b.Audit()
rr = [{"num": 300, "den": 500, "shown": True, "json": {"id": "a", "v": 0.6}},
      {"num": None, "den": None, "shown": False, "json": {"id": "b", "v": None}}]
bb.axis("p", "age", True, rr, table="new.csv")
bb.total("p", 310, 520, table="old.csv")
assert bb.enforce() == [] and rr[0]["shown"]
print("separate tables stay independent")
`;
  let out;
  try {
    out = runPython(["-c", py], { cwd: new URL(repo).pathname, stdio: "pipe" }).toString();
  } catch (e) {
    return t.skip("python3 with pandas is needed for the build's half of this test");
  }
  assert.match(out, /\[\('p', 'age', 'b'\)\]/u, "the smallest shown group is hidden as the complement");
  assert.match(out, /'why': 'complement'/u);
  assert.match(out, /separate tables stay independent/u);
});

// ---------- 4. deep links ----------

test("deep links: ?condition=<slug> selects a condition; aliases, unknown, and missing values fall back and are rewritten", () => {
  assert.equal(PARAM, "condition");
  assert.deepEqual(resolveCondition("?condition=fibromyalgia", manifest), { slug: "fibromyalgia", canonical: true });
  assert.deepEqual(resolveCondition("?condition=lyme", manifest), { slug: "lyme", canonical: true });
  assert.deepEqual(resolveCondition("?condition=long-covid", manifest), { slug: "longcovid", canonical: false });
  assert.deepEqual(resolveCondition("?condition=ME-CFS", manifest), { slug: "mecfs", canonical: false });
  assert.deepEqual(resolveCondition("?condition=lupus", manifest), { slug: "lupus", canonical: true }, "lupus from Task 54");
  for (const slug of ["endometriosis", "migraine", "depression", "anxiety"]) {
    assert.deepEqual(resolveCondition(`?condition=${slug}`, manifest), { slug, canonical: true });
  }
  assert.deepEqual(resolveCondition("?condition=Endo", manifest), { slug: "endometriosis", canonical: false });
  assert.deepEqual(resolveCondition("?condition=migraines", manifest), { slug: "migraine", canonical: false });
  assert.deepEqual(resolveCondition("?condition=MDD", manifest), { slug: "depression", canonical: false });
  assert.deepEqual(resolveCondition("?condition=gad", manifest), { slug: "anxiety", canonical: false });
  assert.deepEqual(resolveCondition("?condition=asthma", manifest), { slug: manifest.default, canonical: false });
  assert.deepEqual(resolveCondition("", manifest), { slug: manifest.default, canonical: false });
  assert.deepEqual(resolveCondition("?x=1", { conditions: [] }), { slug: null, canonical: false });
  assert.equal(normalizeSlug("  Lyme-Disease "), "lyme");
  for (const c of manifest.conditions) {
    assert.equal(conditionHref(c.slug), `/atlas/?condition=${c.slug}`);
    assert.deepEqual(resolveCondition(new URL(conditionHref(c.slug), "https://x.test").search, manifest), { slug: c.slug, canonical: true });
  }
  // The slugs are the clinician app's for the conditions it has a card for.
  const cards = readFileSync(new URL("../web/athena/cards.js", import.meta.url), "utf8");
  for (const slug of ["longcovid", "mecfs", "fibromyalgia", "lyme", "lupus"]) assert.match(cards, new RegExp(`slug: "${slug}"`, "u"));
  // The selector is a list of real links (keyboard and no-script friendly) grouped by family, with the same groups
  // in a native select on phones; both update the page in place with history.
  assert.match(html, /<nav class="picker" aria-label="Condition">\s*<ul id="picker"><\/ul>\s*<label class="picker-select" for="picker-select">Condition\s*<select id="picker-select"><\/select>\s*<\/label>\s*<\/nav>/u);
  assert.match(js, /htmlEl\("a", \{ href: conditionHref\(c\.slug\), "data-slug": c\.slug/u);
  assert.match(js, /htmlEl\("span", \{ class: "family-label", id, text: f\.label \}\)/u);
  assert.match(js, /htmlEl\("ul", \{ "aria-labelledby": f\.label \? id : null \}/u, "each family's links are labeled by its name");
  assert.match(js, /htmlEl\("optgroup", \{ label: f\.label \}/u);
  assert.match(js, /\$\("picker-select"\)\.addEventListener\("change", \(ev\) => go\(ev\.target\.value\)\)/u);
  assert.match(js, /\$\("picker-select"\)\.value = slug;/u, "the select follows the page, including back and forward");
  assert.match(js, /history\.pushState\(\{ slug \}, "", conditionHref\(slug\)\)/u);
  assert.match(js, /addEventListener\("popstate"/u);
  assert.match(js, /setAttribute\("aria-current", "true"\)/u);
  assert.match(css, /\.picker a\[aria-current="true"\]/u);
  assert.match(css, /\.picker a \{[^}]*min-height: 44px/u, "44px touch targets");
  assert.match(css, /@media \(max-width: 640px\) \{\s*#picker \{ display: none; \}\s*\.picker-select \{ display: grid;/u, "phones get the select, not nine links");
  assert.match(css, /\.picker-select select \{[^}]*min-height: 44px; font-size: 1rem;/u, "a 44px select at 16px, so phones do not zoom");
});

// ---------- 5. markup and copy ----------

test("CSP-safe markup: no inline script or style, same-origin resources only, no unsafe DOM calls", () => {
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/u, "inline script");
  assert.doesNotMatch(html, /<style/u, "style element");
  assert.doesNotMatch(html, /\sstyle=/u, "style attribute");
  assert.doesNotMatch(html, /\son[a-z]+=/u, "inline event handler");
  for (const [, url] of html.matchAll(/\s(?:src|href)="([^"]+)"/gu)) assert.match(url, /^(\/|#)/u, `same-origin: ${url}`);
  assert.doesNotMatch(html + js + css, /https?:\/\/(?!www\.w3\.org\/2000\/svg|x\.test)/u, "external URL");
  assert.doesNotMatch(js, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function|setAttribute\(\s*["']style/u);
  assert.match(js, /const DATA = "\/atlas\/data\/conditions\/"/u, "data fetched from the same origin");
  assert.match(html, /<script type="module" src="\/atlas\/atlas\.js\?v=\d{8}"><\/script>/u);
  assert.match(html, /<link rel="stylesheet" href="\/atlas\/atlas\.css\?v=\d{8}">/u);
  assert.match(html, /<link rel="stylesheet" href="\/shared\/site-nav\.css(\?v=\d{8})?" \/>/u);
  assert.match(html, /<script src="\/shared\/site-nav\.js(?:\?v=\d{8})?" defer><\/script>/u);
  assert.match(html, /<body data-door="atlas">/u);
});

test("one page, one footer: no page footer, limitation paragraphs, chips, or tag lines; one source line per panel", () => {
  assert.doesNotMatch(html, /<footer/u, "the shared footer comes from site-nav.js");
  assert.doesNotMatch(html + js, /class="limits"|Limitations\.|class="[^"]*\b(?:chip|tag|badge|pill)\b/u);
  assert.doesNotMatch(css, /\.(?:chip|badge|pill|limits|site-footer)\b/u);
  assert.doesNotMatch(html + css, /preview-banner|notice period/u, "the notice-period banner is gone (the All of Us notice period has passed)");
  for (const id of ["where", "who", "related", "wearables", "cost"]) {
    const sec = html.match(new RegExp(`<section class="panel" id="${id}"[\\s\\S]*?</section>`, "u"))?.[0] || "";
    assert.equal((sec.match(/class="source"/gu) || []).length, 1, `${id}: one source line`);
    assert.match(sec, /class="takeaway"/u, `${id}: takeaway`);
  }
  for (const [slug, c] of Object.entries(conds)) {
    for (const l of c.map.layers) assert.ok(l.source?.text, `${slug} ${l.id}: source`);
    assert.ok(c.groups.source?.text && (!c.related || c.related.source?.text) && (!c.wearables || c.wearables.source?.text)
      && (!c.trajectory || c.trajectory.source?.text), `${slug}: sources`);
    if (c.calculator) assert.ok(c.calculator.source.text);
  }
});

// Strings a reader sees: everything except sources' file details, ids, and keys.
function copyStrings(node, out = [], key = "") {
  if (typeof node === "string") {
    if (!["file", "schema", "slug", "id", "population", "key", "num", "den", "ci", "op", "derivation", "band", "group"].includes(key)) out.push(node);
  } else if (Array.isArray(node)) {
    if (key !== "rows" || !Array.isArray(node[0])) node.forEach((x) => copyStrings(x, out, key));
  } else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      if (k === "source" && Array.isArray(v)) continue;   // the list of source files
      if (!["src", "ref_src", "where", "fields", "cells", "with", "without"].includes(k) || typeof v !== "object") copyStrings(v, out, k);
    }
  }
  return out;
}

test("copy rules: American English, no em dash or exclamation mark, no marketing words, no internal labels or file paths", () => {
  const visible = html.replace(/<!--[\s\S]*?-->/gu, " ").replace(/<!doctype[^>]*>/iu, " ").replace(/<[^>]+>/gu, " ");
  // String literals, scanned left to right so a closing quote never starts a string; template expressions removed.
  const jsStrings = [...js.matchAll(/\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/gu)]
    .map((m) => m[0]).filter((t) => !t.startsWith("/"))
    .map((t) => t.slice(1, -1).replace(/\$\{[^}]*\}/gu, " ")).filter((t) => t.length >= 12 && / /u.test(t));
  assert.ok(jsStrings.some((t) => t.includes("not shown for privacy")));
  const dataStrings = Object.values(conds).flatMap((c) => copyStrings(c));
  assert.ok(dataStrings.length > 100);
  for (const [what, list] of [["page", [visible]], ["script", jsStrings], ["data", dataStrings]]) {
    for (const s of list) {
      assert.doesNotMatch(s, /—/u, `${what}: em dash in "${s}"`);
      assert.doesNotMatch(s, /!(?!=)/u, `${what}: exclamation mark in "${s}"`);
      assert.doesNotMatch(s, BANNED, `${what}: marketing word in "${s}"`);
      assert.doesNotMatch(s, BRITISH, `${what}: British spelling in "${s}"`);
      assert.doesNotMatch(s, /\b(?:Paper|Panel|Task) \d/u, `${what}: internal label in "${s}"`);
      assert.doesNotMatch(s, /\b(?:results|opendata|paper\d?)\/|\.csv\b|\.py\b|\bt\d\d_/u, `${what}: file path in "${s}"`);
    }
  }
});


// ---------- 6. agreement with the papers ----------

const texRows = (rel) => readRepo(rel).split("\n").map((l) => l.replace(/\\textbf\{([^}]*)\}/gu, "$1").replace(/^\\midrule\s*/u, "").split("&").map((x) => x.trim().replace(/\s*\\\\$/u, "")));
const two = (x) => (Math.round(x * 100 + 1e-9) / 100).toFixed(2);




// ---------- 7. per-condition content ----------

test("each condition shows its own measures: Long COVID survey prevalence and coding fraction, the others self-report coding", () => {
  const lc = conds.longcovid;
  assert.deepEqual(lc.map.layers.map((l) => l.id), ["hps_current", "hps_ever", "aou_coded"]);
  assert.equal(lc.groups.variants.length, 2);
  assert.equal(lc.groups.ref_label, null, "no comparison anchor where the measure does not need one");
  assert.deepEqual(lc.related.groups.map((g) => g.id), ["after", "before"]);
  assert.ok(lc.calculator, "Long COVID has the model metrics the calculator needs");
  for (const slug of ["mecfs", "fibromyalgia", "lyme", "migraine", "depression", "anxiety", "endometriosis"]) {
    const c = conds[slug];
    assert.equal(c.calculator, null, `${slug}: no calculator without a cost model`);
    assert.match(c.groups.ref_label, /^Hypertension and type 2 diabetes( among women)?, same group, for comparison$/u, "the anchor is named once, in one phrase");
    assert.ok(c.map.layers.some((l) => l.id === "aou_share"));
  }
  // A state with participants but no codes even for the anchors is named apart from the range (depression: South
  // Carolina, 0 of those who report hypertension or type 2 diabetes coded).
  const dep = conds.depression.map.layers[0];
  assert.equal(dep.states.SC.v, 0);
  assert.match(dep.takeaway, /^In the 14 states with enough participants, 34% \(Minnesota\) to 88% \(Arizona\) .* South Carolina also has enough participants but no depression, hypertension, or type 2 diabetes codes\.$/u);
  assert.equal(dep.bins[0].label, "Under 40%", "the bins follow the 14 states, so their spread stays visible; South Carolina sits in the lowest bin");
  // Endometriosis copy speaks of women throughout.
  const en = conds.endometriosis;
  for (const s of [en.summary[0].text, en.groups.title, en.groups.variants[0].takeaway, en.groups.variants[0].note, en.map.layers[0].title, en.related.title, en.related.note, en.wearables.note]) {
    assert.match(s, /\bwomen\b/iu, s);
    assert.doesNotMatch(s, /\bpeople\b/u, s);
  }
  assert.match(js, /\["wearables-chart", renderWearables\]/u, "the activity and sleep panel is drawn for every condition (hidden without data)");
  assert.equal(conds.lyme.map.layers[0].id, "cdc_incidence", "Lyme opens on CDC incidence, with counties");
  assert.ok(conds.lyme.map.layers[0].counties.rows.length > 3000);
  assert.match(conds.lyme.related.title, /year before a first Lyme disease code/u);
  // Hidden groups say so; nothing about other conditions appears for its own sake.
  const ids = Object.values(conds).flatMap((c) => c.groups.variants.flatMap((v) => v.axes.flatMap((a) => a.rows.map((r) => r.id))));
  assert.ok(!ids.some((id) => /hypertension|obesity|depression|migraine|endometriosis/u.test(id)));
  assert.match(js, /"not shown for privacy"/u);
  // Long COVID's measured calculator inputs are the calculator's defaults, rounded as in Paper 1.
  const m = lc.calculator.measured;
  assert.equal(DEFAULTS.recall, Math.round(m.recall * 100) / 100);
  assert.equal(DEFAULTS.ppv, Math.round(m.ppv * 1000) / 1000);
  assert.equal(DEFAULTS.leadDays, m.lead_days);
  near(m.excess_cost, 901.5, 0.01);
  assert.equal(m.window_days, 101);
  assert.deepEqual([m.lead_p25_days, m.lead_p75_days], [14.5, 109.25]);
});

test("the related panel appears exactly when its feature-by-label file exists; a Task 55 table turns it on with no code change", (t) => {
  for (const [slug, file] of Object.entries(RELATED_FILE)) {
    const has = existsSync(new URL(file, repo));
    assert.equal(Boolean(conds[slug].related), has, `${slug}: panel present ${has}, like ${file}`);
    assert.equal(conds[slug].summary.some((s) => s.id === "related"), has, `${slug}: key number with the panel`);
    if (has) assert.equal(conds[slug].related.src.file, file);
  }
  const en = conds.endometriosis.related;
  assert.equal(en.without_label, "Other women in the survey");
  assert.equal(en.source.title, "Self-reported diagnoses as training labels for finding uncoded chronic fatigue, fibromyalgia, and endometriosis in the All of Us Research Program", "Paper 3 trained the endometriosis model");
  // The build half: write a synthetic Task 55 table in the released format (feature, eligible, four 2x2 cells, as
  // t54_lupus_feature_label_counts.csv) to a temporary directory and point the migraine entry at it. Only the
  // file path changes; the panel, its labels, its key number, and its one-line source follow.
  const py = `
import json, os, shutil, sys, tempfile
sys.path.insert(0, "analysis")
import build_atlas_data as b
tmp = tempfile.mkdtemp()
try:
    reg = json.load(open("workbench/src/features_migraine.json"))
    lines = ["feature,eligible,n_x1_s1,n_x1_s0,n_x0_s1,n_x0_s0", "age_18_39,True,110,22180,400,100470"]
    for i, f in enumerate(reg["conditions"]):
        lines.append(f"{f['id']},True,{30 + 10 * (i % 9)},{2000 + 100 * i},{900 - 10 * (i % 9)},100000")
    lines.append("cx_unlisted,False,suppressed,suppressed,suppressed,suppressed")
    name = os.path.join(tmp, "t55_migraine_feature_label_counts.csv")
    open(name, "w").write("\\n".join(lines) + "\\n")
    before = b.related_2x2("migraine", {**b.SELF_REPORT["migraine"], "related": {**b.SELF_REPORT["migraine"]["related"], "file": os.path.join(tmp, "absent.csv")}})
    b.SELF_REPORT["migraine"]["related"]["file"] = name
    m = next(c for c in b.build(os.path.join(tmp, "out"), quiet=True) if c["slug"] == "migraine")
    labels = {f["id"]: f["label"] for f in reg["conditions"]}
    print(json.dumps({"before": before, "rows": len(m["related"]["rows"]), "conditions": len(reg["conditions"]),
                      "labeled": all(r["label"] == labels[r["id"]] for r in m["related"]["rows"]),
                      "summary": [s["id"] for s in m["summary"]], "source": m["related"]["source"]["text"]}))
finally:
    shutil.rmtree(tmp)
`;
  let out;
  try {
    out = JSON.parse(execFileSync("python3", ["-c", py], { cwd: new URL(repo).pathname, stdio: "pipe" }).toString());
  } catch (e) {
    return t.skip(`python3 with pandas is needed for the build's half of this test (${String(e.message).split("\n")[0]})`);
  }
  assert.equal(out.before, null, "no file, no panel");
  assert.equal(out.rows, out.conditions, "every eligible condition feature over 20 in every cell is a row");
  assert.ok(out.labeled, "labels come from workbench/src/features_migraine.json");
  assert.deepEqual(out.summary, ["share", "sex", "related"]);
  assert.equal(out.source, "NIH All of Us Research Program, Registered Tier v9: feature-by-label counts released for the app's migraine case-finding model (training split, counts rounded up to 10).");
});

test("map layers: bins cover the shown values, every state tile has data or a reason, and the HPS file matches CDC's period", () => {
  for (const [slug, c] of Object.entries(conds)) {
    for (const l of c.map.layers) {
      assert.equal(l.bins.length, 5, `${slug} ${l.id}: five bins`);
      assert.equal(l.bins.at(-1).max, null);
      for (let i = 1; i < l.bins.length - 1; i++) assert.ok(l.bins[i].max > l.bins[i - 1].max);
      const shown = Object.values(l.states).filter((s) => isNum(s.v)).map((s) => s.v);
      assert.ok(shown.length >= 2, `${slug} ${l.id}: at least two states shown`);
      assert.ok(Math.min(...shown) >= 0);
      for (const s of Object.values(l.states)) if (!isNum(s.v)) assert.ok(l.missing[s.why === "complement" ? "suppressed" : s.why], `${slug} ${l.id}: legend text for ${s.why}`);
    }
  }
  const hps = csv("opendata/processed/hps_long_covid_states.csv");
  const us = hps.find((r) => r.indicator === "current_all_adults" && r.state === "US");
  assert.equal(us.pct, "5.3");
  assert.equal(us.period, "Aug 20 - Sep 16, 2024");
  assert.equal(hps.filter((r) => r.indicator === "current_all_adults").length, 52, "50 states, DC, and the nation");
});

// ---------- 8. cost calculator (pure functions in calc.js) ----------

test("calculator defaults match the specification and the static page text matches them", () => {
  assert.deepEqual({ ...DEFAULTS }, {
    screened: 10000, flagShare: 0.05, recall: 0.19, ppv: 0.043, excessCost: 900, odysseyDays: 100, leadDays: 55,
    avoidable: 0.30, reviewMinutes: 5, clinicianHourly: 120, questionnairePass: 0.40, questionnaireSensitivity: 0.8,
  });
  assert.match(js, /key: "ppv",[^\n]*step: 0\.1,/u, "the PPV input accepts one decimal, so 4.3% is a valid value");
  const r = compute(DEFAULTS);
  assert.equal(Math.round(r.twoStep.costPerFound), 116);
  assert.equal(Math.round(r.chart.costPerFound), 233);
  assert.match(html, /two-step screen costs \$116 in clinician review time for each later-coded patient it finds, and chart review of every flag costs \$233, each finding patients about 55 days before/u);
  assert.match(html, /<span id="hc-two-cpf">\$116<\/span>/u);
  assert.match(html, /<span id="hc-chart-cpf">\$233<\/span>/u);
  assert.match(html, /reviews the <span id="hc-two-reviewed">200<\/span> who pass\. That finds <span id="hc-two-found">17\.2<\/span> later-coded patients for <span id="hc-two-cost">\$2,000<\/span>/u);
  assert.match(html, /reviews all <span id="hc-chart-reviewed">500<\/span> flagged patients\. That finds <span id="hc-chart-found">21\.5<\/span> later-coded patients for <span id="hc-chart-cost">\$5,000<\/span>/u);
  assert.match(html, /if <span id="hc-two-sens">80%<\/span> of later-coded patients pass the questionnaire/u);
  assert.match(html, /chart review of every flag avoids an estimated \$3,193 against \$5,000 of review cost, and the two-step screen avoids an estimated \$2,554 against \$2,000, per 10,000 patients screened/u);
  assert.match(html, /<section class="panel" id="cost" aria-labelledby="cost-title" hidden>/u, "hidden until a condition with a calculator is shown");
});

test("calculator pure functions give the expected numbers for the defaults", () => {
  const v = normalize(DEFAULTS);
  near(flags(v), 500);
  near(foundAmongFlags(v), 21.5);
  near(impliedLaterCoded(v), 21.5 / 0.19);
  near(leadFraction(v), 0.55);
  near(avoidedPerFound(v), 148.5);
  near(reviewCost(500, v), 5000);
  const c = chartReview(v);
  near(c.reviewed, 500);
  near(c.clinicianHours, 2500 / 60);
  near(c.reviewCost, 5000);
  near(c.found, 21.5);
  near(c.avoided, 3192.75);
  near(c.net, -1807.25);
  near(c.costPerFound, 5000 / 21.5);
  near(c.breakEvenAvoidable, 5000 / 10642.5);
  const t = twoStep(v);
  near(t.reviewed, 200);
  near(t.reviewCost, 2000);
  near(t.found, 17.2);
  near(t.avoided, 2554.2);
  near(t.net, 554.2);
  near(t.ppvAmongReviewed, 0.086);
  near(t.breakEvenAvoidable, 2000 / 8514);
  near(compute(DEFAULTS).missedLaterCoded, 21.5 / 0.19 - 21.5);
});

test("cost per later-coded patient found", () => {
  near(costPerFound(2000, 16), 125);
  near(costPerFound(5000, 20), 250);
  assert.ok(Number.isNaN(costPerFound(5000, 0)), "undefined when nobody is found");
  assert.ok(Number.isNaN(costPerFound(NaN, 4)));
  near(compute({ ...DEFAULTS, leadDays: 10 }).twoStep.costPerFound, 2000 / 17.2, 1e-6, "lead time does not change review cost");
  near(compute({ ...DEFAULTS, questionnaireSensitivity: 1 }).twoStep.costPerFound, 2000 / 21.5, 1e-6, "best case");
});

test("calculator never inflates savings: avoided spending is capped by the inputs", () => {
  const r = compute({ ...DEFAULTS, leadDays: 500, avoidable: 1 });
  near(r.leadFraction, 1);
  near(r.chart.avoided, 21.5 * 900);
  const lossy = compute({ ...DEFAULTS, questionnaireSensitivity: 0.5 });
  near(lossy.twoStep.found, 10.75);
  near(lossy.twoStep.avoided, 1596.375);
  const bad = compute({ ...DEFAULTS, flagShare: 3, ppv: -1, screened: "abc" });
  near(bad.flags, 10000);
  near(bad.found, 0);
});

test("calculator: impossible scenarios are adjusted to the nearest possible one", () => {
  const r = compute({ ...DEFAULTS, questionnairePass: 0.01 });
  assert.equal(r.feasible, false);
  near(r.requested.questionnairePass, 0.01);
  near(r.inputs.questionnairePass, 0.043 * 0.8);
  near(r.twoStep.reviewed, 17.2);
  near(r.twoStep.found, 17.2);
  assert.ok(r.twoStep.ppvAmongReviewed <= 1 + 1e-12);
  assert.equal(r.adjustments[0].key, "questionnairePass");
  assert.match(r.adjustments[0].message, /raised from 1% to 3\.4%/u);
  const low = compute({ ...DEFAULTS, recall: 0.001 });
  near(low.inputs.recall, 0.05 * 0.043);
  near(low.impliedLaterCoded, 10000);
  assert.match(low.adjustments[0].message, /^Recall raised from 0\.1% to 0\.2%/u);
  assert.deepEqual(compute(DEFAULTS).adjustments, []);
});

test("calculator: found <= reviewed <= flagged <= screened and implied later-coded <= screened for any inputs", () => {
  let seed = 7;
  const rnd = () => ((seed = (seed * 48271) % 2147483647) / 2147483647);
  for (let i = 0; i < 2000; i += 1) {
    const r = compute({
      ...DEFAULTS, screened: Math.round(rnd() * 20000), flagShare: rnd(), recall: rnd() * rnd(), ppv: rnd(),
      questionnairePass: rnd() * rnd(), questionnaireSensitivity: rnd(),
    });
    const s = r.inputs.screened;
    for (const st of [r.twoStep, r.chart]) {
      assert.ok(st.found <= st.reviewed + 1e-9 && st.reviewed <= r.flags + 1e-9 && r.flags <= s + 1e-9, JSON.stringify(r.inputs));
    }
    if (isNum(r.impliedLaterCoded)) assert.ok(r.impliedLaterCoded <= s + 1e-6 && r.impliedLaterCoded + 1e-9 >= r.found);
  }
});

test("calculator: zero denominators are not defined rather than 0 or infinite", () => {
  const none = compute({ ...DEFAULTS, ppv: 0 });
  near(none.found, 0);
  assert.ok(Number.isNaN(none.chart.costPerFound) && Number.isNaN(none.twoStep.costPerFound));
  assert.ok(Number.isNaN(none.twoStep.breakEvenAvoidable));
  const noRecall = compute({ ...DEFAULTS, ppv: 0, recall: 0 });
  assert.ok(Number.isNaN(noRecall.impliedLaterCoded) && Number.isNaN(noRecall.missedLaterCoded));
  assert.deepEqual(noRecall.adjustments, []);
  const noFlags = compute({ ...DEFAULTS, flagShare: 0 });
  assert.ok(Number.isNaN(noFlags.twoStep.ppvAmongReviewed) && Number.isNaN(noFlags.chart.costPerFound));
  const nobody = compute({ ...DEFAULTS, screened: 0 });
  assert.equal(nobody.impliedLaterCoded, 0);
  const recall0 = compute({ ...DEFAULTS, recall: 0 });
  assert.ok(isNum(recall0.impliedLaterCoded) && recall0.inputs.recall > 0);
});
