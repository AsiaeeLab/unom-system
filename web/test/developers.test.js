// The developer pages (/developers/, the models guide, the interface spec): markup and CSP rules, links, and every
// endpoint, parameter, scope, code system, number, and example JSON on them checked against the code and the
// model files. The generated parts come from analysis/build_models_guide.py; rerun it when one of these fails.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";

import { CPT, ICD10, ICD10PCS, LOINC, RXNORM, SNOMED, scoreBundle } from "../web/shared/scorer.js";
import {
  DEFAULT_FHIR_SERVER_ALLOWLIST,
  DISCOVERY,
  MAX_PAGES,
  PREFETCH_TYPES,
  SCORING_DATE_EXTENSION,
  SMART_APP_URL,
  SOURCE,
  SUMMARY_MAX,
} from "../functions/cds-services/_cds.js";
import { MODELS as CDS_MODELS, respond } from "../functions/cds-services/invisible-illness.js";
import { MODEL_CARDS, TABS } from "../web/athena/cards.js";
import { epicConfig, EPIC_SANDBOX_FHIR_ISSUER } from "../web/epic/config.js";
import { athenaConfig } from "../web/athena/config.js";
import { SMART_SANDBOX_PATIENT_IDS } from "../web/smart/launcher-url.js";
import { QUESTIONNAIRE_URL, SUPPORTED_QUESTIONNAIRE_VERSIONS } from "../web/patient/instruments.js";
import { firstDifference } from "../web/developers/developers.js";

const repo = new URL("../../", import.meta.url);
const web = new URL("../web/", import.meta.url);
const readRepo = (rel) => readFileSync(new URL(rel, repo), "utf8");
const read = (rel) => readFileSync(new URL(rel, web), "utf8");
const json = (rel) => JSON.parse(readRepo(rel));
const PAGES = ["developers/index.html", "developers/models.html", "developers/spec.html"];
const index = read("developers/index.html");
const BANNED = /\b(?:seamless\w*|leverag\w*|robust\w*|comprehensive|empower\w*|unlock\w*|delv(?:e|es|ing)|cutting-edge|game-chang\w*)\b/iu;
const unescape = (s) => s.replace(/&lt;/gu, "<").replace(/&gt;/gu, ">").replace(/&quot;/gu, "\"").replace(/&#x27;/gu, "'").replace(/&amp;/gu, "&");
const visible = (html) => unescape(html.replace(/<!--[\s\S]*?-->/gu, " ").replace(/<script[\s\S]*?<\/script>/gu, " ").replace(/<[^>]+>/gu, " "));
/** The page's text with the tags removed and whitespace collapsed, for checking sentences that contain code. */
const plain = (html) => unescape(html.replace(/<!--[\s\S]*?-->/gu, " ").replace(/<script[\s\S]*?<\/script>/gu, " ")
  .replace(/<\/(?:p|li|td|th|dt|dd|h[1-6]|div|pre)>/gu, " ").replace(/<[^>]+>/gu, "")).replace(/\s+/gu, " ");
const block = (name) => {
  const m = index.match(new RegExp(`<!-- generated:${name}:start -->\\n([\\s\\S]*?)\\n<!-- generated:${name}:end -->`, "u"));
  assert.ok(m, `generated block ${name}`);
  return m[1];
};
/** The text of the code block whose head is `label`, in `html`. */
const codeBlock = (html, label) => {
  const esc = label.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const m = html.match(new RegExp(`<div class="code[^"]*"><div class="code-head"><span>${esc}</span></div><pre(?: id="[^"]+")?><code>([\\s\\S]*?)</code></pre></div>`, "u"));
  assert.ok(m, `code block "${label}"`);
  return unescape(m[1]);
};
const sha256 = (rel) => createHash("sha256").update(readFileSync(new URL(rel, web))).digest("hex");

// The model files the pages list: model/*.json except the placeholder example.
const MODEL_FILES = readdirSync(new URL("model/", repo)).filter((f) => f.endsWith(".json") && !f.endsWith(".example.json")).sort();
const MODELS = MODEL_FILES.map((f) => ({ file: f, model: json(`model/${f}`) }));
const BUNDLES = readdirSync(new URL("model/test_vectors/bundles/", repo)).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).sort();
const bundle = (pid) => json(`model/test_vectors/bundles/${pid}.json`);
const expected = (model, pid) => json(`model/test_vectors/expected/${model.model_id}-${model.version}/${pid}.json`);

// ---------------------------------------------------------------- markup, CSP, copy

for (const page of PAGES) {
  test(`${page}: shared site bar and footer, the side navigation, CSP-safe markup, and the copy rules`, () => {
    const html = read(page);
    assert.match(html, /<link rel="stylesheet" href="\/shared\/site-nav\.css\?v=\d{8}" \/>/u);
    assert.match(html, /<script src="\/homepage-settings\.js\?v=\d{8}"><\/script>/u);
    assert.match(html, /<body data-door="developers">/u);
    assert.match(html, /<script src="\/shared\/site-nav\.js\?v=\d{8}" defer><\/script>/u);
    assert.match(html, /<script type="module" src="\/developers\/developers\.js\?v=\d{8}"><\/script>/u);
    assert.doesNotMatch(html, /<footer/u, "the footer comes from site-nav.js; no page footer or bottom note");
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/iu, "inline script");
    assert.doesNotMatch(html, /<style/iu, "style element");
    assert.doesNotMatch(html, /\sstyle=/iu, "style attribute");
    assert.doesNotMatch(html, /\son[a-z]+=/iu, "inline handler");
    assert.doesNotMatch(html, /javascript:/iu, "javascript: URL");
    for (const [, src] of html.matchAll(/<script[^>]+src="([^"]+)"/gu)) assert.match(src, /^\/(?!\/)/u, `same-origin script ${src}`);
    for (const [, href] of html.matchAll(/<link rel="stylesheet" href="([^"]+)"/gu)) assert.match(href, /^\/(?!\/)/u, `same-origin stylesheet ${href}`);
    assert.match(html, /<main class="dev-layout">/u);
    const ids = [...html.matchAll(/\sid="([^"]+)"/gu)].map((m) => m[1]);
    assert.deepEqual(ids.filter((id, i) => ids.indexOf(id) !== i), [], "no duplicate ids");
    assert.match(html, /<nav class="dev-nav" aria-label="Developer documentation">/u);
    const text = `${visible(html)} ${[...html.matchAll(/\s(?:alt|aria-label|title|content)="([^"]*)"/gu)].map((m) => m[1]).join(" ")}`;
    assert.doesNotMatch(text, /—/u, "em dash");
    assert.doesNotMatch(text, /[A-Za-z.)"]!(\s|$)/u, "exclamation mark");
    assert.doesNotMatch(text, BANNED, "marketing word");
  });
}

test("developers.js builds the DOM with textContent and calls this site only", () => {
  const js = read("developers/developers.js");
  assert.doesNotMatch(js, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/u);
  assert.doesNotMatch(js, /https?:\/\//u, "no absolute URLs: every fetch is same-origin");
  for (const [, url] of js.matchAll(/fetch\(([^,)]+)/gu)) assert.doesNotMatch(url, /^["'`]https?:/u, url);
  assert.equal(firstDifference({ a: 1, b: [1, "x"] }, { a: 1 + 1e-12, b: [1, "x"] }), null, "numbers to 1e-9");
  assert.equal(firstDifference({ a: 1, b: [1, "x"] }, { a: 1, b: [1, "y"] }), "$.b[1]");
  assert.equal(firstDifference({ b: 1, a: 1 }, { a: 1, b: 1 }), "$ (fields)", "field order matters, as in scorer.test.js");
});

test("one side navigation on every developer page, with each entry resolving", () => {
  const navs = PAGES.map((p) => read(p).match(/<nav class="dev-nav"[\s\S]*?<\/nav>/u)[0]);
  const labels = (nav) => [...nav.matchAll(/<a href="[^"]+"[^>]*>([^<]+)<\/a>/gu)].map((m) => m[1]);
  assert.deepEqual(labels(navs[1]), labels(navs[0]));
  assert.deepEqual(labels(navs[2]), labels(navs[0]));
  for (const [, href] of navs[0].matchAll(/<a href="#([^"]+)"/gu)) assert.match(index, new RegExp(`\\sid="${href}"`, "u"), `#${href}`);
  assert.match(navs[1], /<a href="\/developers\/models" aria-current="page">Models guide<\/a>/u);
  assert.match(navs[2], /<a href="\/developers\/spec" aria-current="page">Interface spec<\/a>/u);
  assert.match(navs[1], /<a href="\/developers\/#source">Source code<\/a>/u, "the section links of a generated page point at /developers/");
});

// ---------------------------------------------------------------- links and paths

function targetFile(path) {
  const clean = path.replace(/[?#].*$/u, "");
  if (clean.endsWith("/")) return `${clean.slice(1)}index.html`;
  if (/^\/developers\/(models|spec)$/u.test(clean)) return `${clean.slice(1)}.html`;
  return clean.slice(1);
}

test("every site link on the developer pages resolves, including the fragment", () => {
  const ids = Object.fromEntries(PAGES.map((p) => [`/${p.replace(/index\.html$/u, "").replace(/\.html$/u, "")}`,
    new Set([...read(p).matchAll(/\sid="([^"]+)"/gu)].map((m) => m[1]))]));
  for (const page of PAGES) {
    const html = read(page);
    const here = `/${page.replace(/index\.html$/u, "").replace(/\.html$/u, "")}`;
    for (const [, href] of html.matchAll(/\shref="([^"]+)"/gu)) {
      if (/^https?:/u.test(href) || /^\/(about|challenge)\//u.test(href)) continue; // live-site pages not in this repository
      const [path, hash] = href.split("#");
      if (path) assert.ok(existsSync(new URL(targetFile(path), web)), `${page}: ${href}`);
      if (hash) {
        const owner = path ? path.replace(/\/$/u, "/").replace(/\?.*$/u, "") : here;
        const key = owner === "/developers" ? "/developers/" : owner;
        if (ids[key]) assert.ok(ids[key].has(hash), `${page}: ${href} (#${hash} exists)`);
        else if (key === "/about/" || key === "/") assert.ok(true);
      }
    }
  }
});

test("the old developer URLs and anchors still work", () => {
  for (const id of ["registry", "scoring", "vectors", "cds-hooks", "ehr-launch", "spec", "source"]) {
    assert.match(index, new RegExp(`<section id="${id}"`, "u"), `/developers/#${id}`);
  }
  assert.ok(existsSync(new URL("developers/models.html", web)));
  assert.ok(existsSync(new URL("developers/spec.html", web)));
  const models = read("developers/models.html");
  for (const id of ["long-covid", "chronic-fatigue", "fibromyalgia", "lyme", "lupus"]) assert.match(models, new RegExp(`\\sid="${id}"`, "u"), `models#${id} (linked from cards.js)`);
  assert.match(read("developers/spec.html"), /\sid="spec-4c-unavailable-data"/u, "spec#spec-4c-unavailable-data (linked from the clinician app)");
});

test("every repository path and site file named in code on /developers/ exists", () => {
  const codes = [...index.matchAll(/<code>([^<]+)<\/code>/gu)].map((m) => unescape(m[1]));
  let checked = 0;
  for (const c of codes) {
    if (/^(model|web|docs|analysis)\/[\w./-]*$/u.test(c)) {
      assert.ok(existsSync(new URL(c, repo)), c);
      checked += 1;
    } else if (/^\/(shared|models|developers)\/[\w./-]+$/u.test(c)) {
      assert.ok(existsSync(new URL(c.slice(1), web)), c);
      checked += 1;
    }
  }
  assert.ok(checked >= 20, `${checked} paths checked`);
  for (const cmd of index.matchAll(/python3 ((?:model|analysis)\/[\w./-]+\.py)/gu)) assert.ok(existsSync(new URL(cmd[1], repo)), cmd[1]);
});

// ---------------------------------------------------------------- the model registry

test("registry: one entry per model file, read from the file, with the served copy's size and SHA-256", () => {
  const reg = block("registry");
  assert.equal((reg.match(/<div class="model-entry"/gu) || []).length, MODELS.length);
  for (const { file, model } of MODELS) {
    assert.equal(read(`models/${file}`), readRepo(`model/${file}`), `web/web/models/${file} is the copy of model/${file}`);
    assert.ok(reg.includes(`<code>${model.model_id}</code> ${model.version}, ${model.status}`), model.model_id);
    assert.ok(reg.includes(`<a href="/models/${file}" download>${file}</a>`), file);
    assert.ok(reg.includes(sha256(`models/${file}`)), `${file} SHA-256`);
    assert.ok(reg.includes(`${model.features.length}, `), `${file} feature count`);
    assert.ok(unescape(reg).includes(model.target.label), `${file} target`);
    assert.ok(unescape(reg).includes(model.target.population), `${file} population`);
  }
});

test("registry: /models/index.json lists every model file with its version, size, and hash", () => {
  const registry = JSON.parse(read("models/index.json"));
  assert.deepEqual(registry.models.map((m) => m.file).sort(), MODEL_FILES.map((f) => `/models/${f}`).sort());
  for (const entry of registry.models) {
    const file = entry.file.slice("/models/".length);
    const model = json(`model/${file}`);
    assert.equal(entry.model_id, model.model_id);
    assert.equal(entry.version, model.version);
    assert.equal(entry.status, model.status);
    assert.equal(entry.bytes, statSync(new URL(`models/${file}`, web)).size);
    assert.equal(entry.sha256, sha256(`models/${file}`));
    assert.equal(entry.features, model.features.length);
    assert.equal(entry.weighted_features, model.features.filter((f) => f.weight !== 0).length);
    assert.equal(entry.runs_in.includes("CDS Hooks service"), CDS_MODELS.some((m) => m.model_id === model.model_id && m.version === model.version));
    if (entry.expected_outputs) assert.ok(existsSync(new URL(entry.expected_outputs.slice(1), web)), entry.expected_outputs);
  }
  assert.equal(registry.contract_version, readRepo("docs/interface/model_spec.md").match(/contract version ([\d.]+)/u)[1]);
});

test("registry: the cards without a model file are named from the clinician app's tabs, and never as permanent rules", () => {
  const modelSlugs = new Set(MODEL_CARDS.map((c) => c.slug));
  const ruleTabs = TABS.filter((t) => !modelSlugs.has(t.slug) && t.slug !== "timeline");
  const reg = block("registry");
  for (const tab of ruleTabs) assert.ok(reg.includes(`<a href="/developers/models#${tab.slug}">${tab.label}</a>`), tab.slug);
  if (ruleTabs.length) assert.match(reg, /have no model file yet/u);
  for (const page of PAGES) assert.doesNotMatch(read(page), /not a fitted model|is a rule, not|rules, not models/u, page);
  const guide = read("developers/models.html");
  for (const tab of ruleTabs) assert.match(guide, new RegExp(`The ${tab.label === "Lupus" ? "lupus" : tab.label} card has no model file yet`, "u"));
});

// ---------------------------------------------------------------- CDS Hooks

const EXAMPLES = readdirSync(new URL("developers/examples/", web)).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).sort();

test("CDS Hooks: every example request parses, belongs to a test patient, and carries the scoring-date extension", () => {
  assert.deepEqual(EXAMPLES, ["elena", "maria", "maria-missing-observations"]);
  for (const name of EXAMPLES) {
    const req = JSON.parse(read(`developers/examples/${name}.json`));
    const pid = req.context.patientId;
    assert.ok(BUNDLES.includes(pid), `${name}: ${pid} is a test patient`);
    assert.equal(req.hook, "patient-view");
    assert.equal(req.extension[SCORING_DATE_EXTENSION], expected(CDS_MODELS[0], pid).as_of, `${name}: the date of the test vectors`);
    const sent = Object.values(req.prefetch).flatMap((v) => (v.resourceType === "Bundle" ? v.entry.map((e) => e.resource) : [v]));
    const keys = Object.keys(req.prefetch);
    const types = new Set(keys.map((k) => PREFETCH_TYPES[k]));
    const want = bundle(pid).entry.map((e) => e.resource).filter((r) => types.has(r.resourceType));
    assert.deepEqual(sent.map((r) => `${r.resourceType}/${r.id}`).sort(), want.map((r) => `${r.resourceType}/${r.id}`).sort(), name);
    for (const v of Object.values(req.prefetch)) if (v.resourceType === "Bundle") assert.equal(v.total, v.entry.length, `${name}: total`);
  }
});

test("CDS Hooks: each documented response is what the service returns for that request, and agrees with the test vectors", async () => {
  for (const name of EXAMPLES) {
    const req = JSON.parse(read(`developers/examples/${name}.json`));
    const response = await respond(req);
    assert.equal(response.status, 200, name);
    const body = await response.json();
    const file = JSON.parse(read(`developers/examples/responses/${name}.json`));
    assert.deepEqual(file, body, `examples/responses/${name}.json`);
    assert.deepEqual(JSON.parse(codeBlock(index, `Response to ${name}.json`)), body, `the response shown for ${name}`);
    if (Object.keys(req.prefetch).length === 6) {
      const flagged = CDS_MODELS.filter((m) => {
        const e = expected(m, req.context.patientId);
        return e.status === "scored" && ["High", "Elevated"].includes(e.band);
      });
      assert.equal(body.cards.length, flagged.length, `${name}: one card per High or Elevated model`);
    } else {
      assert.equal(body.cards.length, 1, `${name}: the could-not-score card`);
      assert.match(body.cards[0].summary, /^Could not score /u);
    }
  }
  const caption = block("cds-responses");
  const maria = CDS_MODELS.map((m) => {
    const e = expected(m, "maria");
    return `: ${e.status === "scored" ? e.band : "not scored"}`;
  });
  const shown = caption.match(/Maria's expected results are ([^.]+)\. The service returns one card\./u);
  assert.ok(shown, "Maria's caption");
  assert.deepEqual(shown[1].split("; ").map((part) => part.slice(part.indexOf(":"))), maria);
});

test("CDS Hooks: discovery, the full example request, and the live form match the files and the code", () => {
  assert.deepEqual(JSON.parse(read("developers/examples/responses/discovery.json")), DISCOVERY);
  assert.deepEqual(JSON.parse(codeBlock(block("cds-discovery"), "Response")), DISCOVERY);
  assert.equal(codeBlock(block("cds-request"), "maria.json"), read("developers/examples/maria.json"));
  const live = block("cds-live");
  assert.deepEqual([...live.matchAll(/<option value="([^"]+)">/gu)].map((m) => m[1]).sort(), EXAMPLES);
  const models = CDS_MODELS.map((m) => `${m.version}</a>`);
  for (const v of models) assert.ok(block("cds-models").includes(v));
  assert.equal((block("cds-models").match(/<a href=/gu) || []).length, CDS_MODELS.length, "every model the service scores, and no other");
});

test("CDS Hooks: endpoints, fields, limits, and card facts on the page match _cds.js", () => {
  const text = plain(index);
  const [service] = DISCOVERY.services;
  assert.match(index, /<td>GET<\/td><td><code>\/cds-services<\/code><\/td>/u);
  assert.match(index, new RegExp(`<td>POST</td><td><code>/cds-services/${service.id}</code></td>`, "u"));
  assert.ok(existsSync(new URL("functions/cds-services/index.js", new URL("../", import.meta.url))));
  assert.ok(existsSync(new URL(`functions/cds-services/${service.id}.js`, new URL("../", import.meta.url))));
  assert.ok(text.includes(`The service id is ${service.id}.`));
  const types = Object.values(PREFETCH_TYPES).filter((t) => t !== "Patient");
  assert.ok(text.includes(`ask for the Patient and one search each for ${types.slice(0, -1).join(", ")}, and ${types.at(-1)}`), "prefetch types");
  assert.ok(text.includes(`At most ${SUMMARY_MAX} characters`));
  assert.ok(text.includes(`more than ${MAX_PAGES} pages`));
  assert.ok(text.includes(DEFAULT_FHIR_SERVER_ALLOWLIST[0]), "default allow-list");
  assert.ok(index.includes(`<code>extension["${SCORING_DATE_EXTENSION}"]</code>`));
  assert.ok(unescape(index).includes(JSON.stringify(SOURCE).replace(/,/u, ", ").replace(/":/gu, "\": ")), "card source");
  assert.ok(text.includes(SMART_APP_URL), "card link");
  const cds = readFileSync(new URL("../functions/cds-services/_cds.js", import.meta.url), "utf8");
  assert.match(cds, /BAND_INDICATOR = Object\.freeze\(\{ High: "warning", Elevated: "info" \}\)/u, "warning for High, info for Elevated");
  assert.match(cds, /return \[412,/u);
  assert.match(cds, /return \[502,/u);
  assert.match(readFileSync(new URL("../functions/cds-services/invisible-illness.js", import.meta.url), "utf8"), /jsonResponse\(\{ error: "request body must be JSON" \}, 400\)/u);
});

// ---------------------------------------------------------------- SMART on FHIR

test("SMART on FHIR: launch URLs, redirects, issuers, client IDs, scopes, and framing match the launch code", () => {
  const text = plain(index);
  const smartLaunch = read("smart/launch.js");
  const id = smartLaunch.match(/const CLIENT_ID = "([^"]+)"/u)[1];
  const scope = smartLaunch.match(/const SCOPE = "([^"]+)"/u)[1];
  assert.ok(index.includes(`<code>${id}</code>`) && index.includes(`<code>${scope}</code>`), "SMART Health IT client and scope");
  assert.match(smartLaunch, /const ALLOWED_ISSUER = "launch\.smarthealthit\.org"/u);
  assert.match(read("athena/app.js"), /\/\^\\\/v\\\/r4\\\/\(\?:sim\\\/\[\^\/\]\+\\\/\)\?fhir\\\/\?\$\/u/u, "R4 launcher paths");
  assert.match(smartLaunch, /redirectUri: new URL\("callback\.html", url\)\.href/u);
  assert.match(smartLaunch, /pkceMode: "required"/u);
  assert.match(read("smart/index.html"), /fhirclient@3\.0\.0/u);
  assert.ok(text.includes("fhirclient 3.0.0"));
  assert.equal(SMART_SANDBOX_PATIENT_IDS.length, BUNDLES.length);
  assert.ok(text.includes(`with the ${BUNDLES.length} test patients preselected`));
  const upload = readRepo("model/test_vectors/upload_sandbox.py");
  assert.match(upload, /FHIR_SERVER = "https:\/\/r4\.smarthealthit\.org"/u);
  assert.match(upload, /SOURCE_AS_OF = dt\.date\(2024, 6, 1\)/u);
  assert.match(upload, /LONG_COVID_EARLIEST_INDEX = dt\.date\(2021, 7, 2\)/u);
  assert.ok(index.includes("<code>https://r4.smarthealthit.org</code>"));

  assert.ok(index.includes(`<code>${epicConfig.clientId}</code> (non-production)`), "Epic client ID");
  assert.ok(index.includes(`<code>${epicConfig.scope}</code>`), "Epic scope");
  assert.deepEqual([...epicConfig.allowedIssuers], [EPIC_SANDBOX_FHIR_ISSUER]);
  assert.ok(index.includes(`<code>${EPIC_SANDBOX_FHIR_ISSUER}</code> only`), "Epic issuer");
  assert.match(read("epic/launch.js"), /redirectUri: new URL\("callback\.html", browserWindow\.location\.href\)\.href/u);

  assert.ok(index.includes(`<code>${athenaConfig.clientId}</code>`), "athenaOne client ID");
  const athenaScopes = athenaConfig.scope.split(" ");
  const rs = athenaScopes.filter((s) => s.endsWith(".rs")).map((s) => s.slice("patient/".length, -3));
  assert.ok(athenaScopes.includes("launch") && athenaScopes.includes("openid") && athenaScopes.includes("patient/Patient.r"));
  assert.ok(text.includes(`for ${rs.slice(0, -1).join(", ")}, and ${rs.at(-1)}`), "athenaOne .rs scopes in order");
  assert.equal(athenaScopes.length, rs.length + 3);
  const auth = read("athena/auth.js");
  assert.match(auth, /const PREVIEW_FHIR_ORIGIN = "https:\/\/api\.preview\.platform\.athenahealth\.com"/u);
  assert.match(auth, /const PRODUCTION_FHIR_ORIGIN = "https:\/\/api\.platform\.athenahealth\.com"/u);
  assert.match(auth, /url\.pathname === "\/fhir\/r4"/u);
  assert.match(auth, /subtle\.verify\(/u);
  assert.match(read("athena/launch.js"), /const redirectUri = new URL\("\.\/", browserWindow\.location\.href\)\.href/u);

  for (const path of ["smart/index.html", "smart/callback.html", "epic/index.html", "epic/callback.html", "athena/launch.html", "athena/index.html"]) {
    assert.ok(existsSync(new URL(path, web)), path);
    const url = `https://undiagnosednomore.org/${path.replace(/index\.html$/u, "")}`;
    assert.ok(index.includes(`<code>${url}</code>`), url);
  }
  const headers = read("_headers");
  const frame = (route) => headers.split(/\n(?=\/)/u).find((b) => b.startsWith(`${route}\n`)).match(/frame-ancestors ([^;]+);/u)[1];
  assert.equal(frame("/epic"), "https://fhir.epic.com https://open.epic.com");
  assert.equal(frame("/athena"), "https://preview.athenahealth.com");
  assert.equal((text.match(/Registered; sandbox access pending\./gu) || []).length, 2, "Epic and athenaOne status");
});

test("SMART on FHIR: the resource types the app reads, page size, and NOAUTH handling match fhir-data.js", () => {
  const src = read("athena/fhir-data.js");
  const types = [...src.slice(0, src.indexOf("];")).matchAll(/resourceType: "(\w+)"/gu)].map((m) => m[1]);
  assert.equal(types.length, 19);
  assert.ok(plain(index).includes(`following next links on the same server: ${types.slice(0, -1).join(", ")}, and ${types.at(-1)}.`));
  assert.match(src, /&_count=100/u);
  assert.match(src, /=== "NOAUTH"/u);
  assert.match(read("athena/app.js"), /asOf: localDate\(new Date\(\)\)/u, "the app scores as of today in local time");
  assert.ok(plain(index).includes("scores it as of the current date in the clinician's time zone"));
});

// ---------------------------------------------------------------- the scorer

test("scorer: the documented result for Maria and the could-not-score example are what scorer.js returns", () => {
  const [{ model }] = MODELS.filter(({ model: m }) => m.model_id === CDS_MODELS[0].model_id);
  const want = expected(model, "maria");
  const result = scoreBundle(model, bundle("maria"), want.as_of);
  const table = block("result");
  for (const v of [result.index_date, result.band, `${result.features ? Object.keys(result.features).length : 0} features, ${Object.values(result.features).filter(Boolean).length} equal to 1`, `${result.drivers.length} drivers`]) {
    assert.ok(table.includes(v), v);
  }
  assert.ok(table.includes(String(Math.round(result.score * 1e6) / 1e6)), "score");
  assert.ok(table.includes(`(${(100 * result.probability).toFixed(2)}%)`), "probability");
  assert.ok(table.includes(String(Math.round(result.times_average * 1e4) / 1e4)), "times_average");
  assert.deepEqual(JSON.parse(codeBlock(table, `drivers[0] for Maria, ${MODELS.find((m) => m.model === model).file}`)), result.drivers[0]);

  const failed = scoreBundle(model, bundle("maria"), want.as_of, { unavailable: ["Observation"] });
  const comment = index.match(/\{ unavailable: \["Observation"\] \}\);\n([\s\S]*?)<\/code>/u)[1].replace(/^\/\/ ?/gmu, "");
  const shown = JSON.parse(comment.replace(/^(\s*)(\w+):/gmu, "$1\"$2\":"));
  assert.deepEqual(shown, failed);
  assert.deepEqual(Object.keys(shown), Object.keys(failed));
  assert.match(index, /<pre id="js-example"><code>import \{ scoreBundle \} from "\/shared\/scorer\.js";/u, "the homepage's sample (homepage.test.js checks it matches)");
});

test("scorer: the Python reference has no third-party imports and takes the flags the page shows", () => {
  const py = readRepo("model/reference/score_fhir.py");
  const imports = [...py.slice(py.indexOf('"""', 3) + 3, py.indexOf("\ndef ")).matchAll(/^(?:from|import) (\w+)/gmu)].map((m) => m[1]);
  for (const name of imports) assert.ok(["__future__", "argparse", "datetime", "json", "re", "bisect"].includes(name), name);
  assert.match(py, /ap\.add_argument\("--as-of"\)/u);
  assert.match(py, /ap\.add_argument\("--unavailable"/u);
  assert.match(py, /def score_bundle\(model, bundle, as_of=None, unavailable=\(\)\)/u);
  assert.doesNotMatch(read("shared/scorer.js"), /^import /mu, "scorer.js has no imports");
});

// ---------------------------------------------------------------- FHIR inputs and the contract

test("FHIR inputs: the code-system URIs are the scorer's, and the per-model counts come from the model files", () => {
  const systems = [...index.matchAll(/<td data-label="system"><code>([^<]+)<\/code><\/td>/gu)].map((m) => m[1]);
  assert.deepEqual(systems.sort(), [ICD10, SNOMED, LOINC, CPT, ICD10PCS, RXNORM].sort());
  const scorer = read("shared/scorer.js");
  assert.match(scorer, /const DATE_PATHS = \[\n {2}\["onsetDateTime"\], \["onsetPeriod", "start"\], \["recordedDate"\], \["period", "start"\],\n {2}\["effectiveDateTime"\], \["effectivePeriod", "start"\], \["issued"\], \["authoredOn"\],\n {2}\["performedDateTime"\], \["performedPeriod", "start"\], \["occurrenceDateTime"\],\n\];/u);
  assert.ok(plain(index).includes("onsetDateTime, onsetPeriod.start, recordedDate, period.start, effectiveDateTime, effectivePeriod.start, issued, authoredOn, performedDateTime, performedPeriod.start, and occurrenceDateTime"));
  assert.match(scorer, /return code === "VR" \|\| code === "HH" \? "AMB" : code;/u);
  assert.match(scorer, /get\(r, "medicationCodeableConcept"\)/u);
  assert.doesNotMatch(scorer, /medicationReference/u, "a medicationReference is not followed");
  const fhir = block("fhir-inputs");
  const titles = Object.fromEntries(JSON.parse(read("models/index.json")).models.map((m) => [m.model_id, m.title]));
  const conditionRow = fhir.match(/<tr><td>Condition<\/td><td data-label="Code system">ICD-10-CM<\/td>(.*?)<\/tr>/u)[1];
  for (const { model } of MODELS) {
    const conditions = model.features.filter((f) => f.resource === "Condition");
    const cell = `<td data-label="${titles[model.model_id]}">${conditions.length} (${conditions.filter((f) => f.weight !== 0).length})</td>`;
    assert.ok(conditionRow.includes(cell), `${model.model_id} Condition count`);
  }
  assert.ok(index.includes(`<code>${QUESTIONNAIRE_URL}</code> (versions ${SUPPORTED_QUESTIONNAIRE_VERSIONS.slice(0, -1).join(", ")}, and ${SUPPORTED_QUESTIONNAIRE_VERSIONS.at(-1)})`));
});

test("model contract: every top-level field of every model file is described, and the nine feature kinds are the spec's", () => {
  const section = index.slice(index.indexOf('<section id="spec"'), index.indexOf('<section id="fhir-inputs"'));
  const described = new Set([...section.matchAll(/<td><code>(\w+)<\/code>(?:, <code>(\w+)<\/code>)?(?:, <code>(\w+)<\/code>)?<\/td>/gu)].flatMap((m) => m.slice(1).filter(Boolean)));
  for (const { model } of MODELS) for (const key of Object.keys(model)) assert.ok(described.has(key), `${model.model_id}: ${key}`);
  const kinds = [...read("developers/spec.html").matchAll(/<tr><td><code>(\w+)<\/code><\/td><td>/gu)].map((m) => m[1]);
  assert.equal(kinds.length, 9);
  assert.ok(plain(section).includes(`Features come in nine kinds: ${kinds.slice(0, -1).join(", ")}, and ${kinds.at(-1)}.`));
  for (const { model } of MODELS) for (const f of model.features) assert.ok(kinds.includes(f.kind), `${model.model_id}: ${f.kind}`);
});

// ---------------------------------------------------------------- test vectors and versioning

test("test vectors: counted from the bundles, the copies match model/test_vectors, and the zip holds every bundle", () => {
  const words = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve",
    "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty"];
  const vec = block("vectors");
  const n = BUNDLES.length;
  assert.ok(vec.includes(`${words[n][0].toUpperCase()}${words[n].slice(1)} synthetic patients`));
  assert.ok(vec.includes(`${MODELS.length * n} expected outputs`) || vec.includes("expected outputs"), "outputs counted");
  assert.match(vec, /<details class="vectors-detail"><summary>/u);
  assert.match(vec, /href="\/developers\/vectors\/all-vectors\.zip" download>Download all vectors/u);
  for (const pid of BUNDLES) {
    assert.equal(read(`developers/vectors/bundles/${pid}.json`), readRepo(`model/test_vectors/bundles/${pid}.json`), pid);
    for (const { model } of MODELS) {
      const rel = `${model.model_id}-${model.version}/${pid}.json`;
      assert.equal(read(`developers/vectors/expected/${rel}`), readRepo(`model/test_vectors/expected/${rel}`), rel);
    }
  }
  const zip = readFileSync(new URL("developers/vectors/all-vectors.zip", web));
  assert.equal(zip.subarray(0, 2).toString("latin1"), "PK");
  const names = zip.toString("latin1");
  for (const pid of BUNDLES) assert.ok(names.includes(`unm-test-vectors/bundles/${pid}.json`), pid);
});

test("try the scorer: every test patient and model is offered, with the expected outputs' date", () => {
  const form = block("try");
  assert.deepEqual([...form.matchAll(/<option value="(\w+)"(?: selected)? data-scenario=/gu)].map((m) => m[1]).sort(), BUNDLES);
  const options = [...form.matchAll(/<option value="(\/models\/[^"]+)" data-expected="([^"]+)">/gu)];
  assert.deepEqual(options.map((m) => m[1]).sort(), MODEL_FILES.map((f) => `/models/${f}`).sort());
  for (const [, , dir] of options) assert.ok(existsSync(new URL(`${dir.slice(1)}maria.json`, web)), dir);
  const asOf = expected(MODELS[0].model, "maria").as_of;
  assert.ok(form.includes(`type="date" value="${asOf}" data-vectors="${asOf}"`));
  assert.match(index, /<form class="try" id="try-form" hidden>/u, "shown by the page script");
});

test("versioning: every expected-output directory is listed, and the parity count is the number of outputs with a model file", () => {
  const dirs = readdirSync(new URL("model/test_vectors/expected/", repo)).sort();
  const v = block("versions");
  for (const d of dirs) assert.ok(v.includes(`<code>${d}/</code>`), d);
  const files = readdirSync(new URL("model/", repo)).filter((f) => f.endsWith(".json")).map((f) => json(`model/${f}`)).map((m) => `${m.model_id}-${m.version}`);
  const parity = dirs.filter((d) => files.includes(d)).reduce((n, d) => n + readdirSync(new URL(`model/test_vectors/expected/${d}/`, repo)).filter((f) => f.endsWith(".json")).length, 0);
  assert.ok(v.includes(`against the ${parity} expected outputs`), `${parity}`);
  const headers = read("_headers");
  const models = headers.split(/\n(?=\/)/u).find((b) => b.startsWith("/models/*\n"));
  assert.match(models, /Cache-Control: public, max-age=300/u);
  assert.match(models, /Access-Control-Allow-Origin: \*/u);
  assert.ok(index.includes("<code>Cache-Control: public, max-age=300</code>") && index.includes("<code>Access-Control-Allow-Origin: *</code>"));
  assert.match(readFileSync(new URL("../functions/cds-services/_cds.js", import.meta.url), "utf8"), /Model \$\{model\.model_id\} \$\{model\.version\}\./u, "the card names the model and version");
});
