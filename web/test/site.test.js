// Site-wide page rules: page titles, versioned stylesheets, the About page (paper titles from the papers'
// \title lines), the 404 page, and the copy rules (no em dash, no exclamation mark, no marketing words) on
// the pages that have no test file of their own.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";

const web = new URL("../web/", import.meta.url);
const repo = new URL("../../", import.meta.url);
const read = (rel) => readFileSync(new URL(rel, web), "utf8");
const BANNED = /\b(?:seamless\w*|leverag\w*|robust\w*|comprehensive|empower\w*|unlock\w*|delv(?:e|es|ing)|cutting-edge|game-chang\w*)\b/iu;
const visible = (html) => html
  .replace(/<!--[\s\S]*?-->/gu, " ")
  .replace(/<script[\s\S]*?<\/script>/gu, " ")
  .replace(/<svg[\s\S]*?<\/svg>/gu, " ")
  .replace(/<!doctype[^>]*>/iu, " ")
  .replace(/<[^>]+>/gu, " ");
const attrText = (html) => [...html.matchAll(/\s(?:alt|aria-label|title|content)="([^"]*)"/gu)].map((m) => m[1]).join(" ");

function pages(dir = web, out = []) {
  for (const name of readdirSync(dir)) {
    const url = new URL(name, dir);
    if (statSync(url).isDirectory()) {
      if (name !== "vectors" && name !== "examples") pages(new URL(`${name}/`, dir), out);
    } else if (name.endsWith(".html")) out.push(url.href.slice(web.href.length));
  }
  return out;
}
const ALL = pages();

test("every page has a <title> in the form 'Page | Undiagnosed No More' (or the bare name), with no em dash or odd separator", () => {
  assert.ok(ALL.length >= 15, `${ALL.length} pages`);
  for (const rel of ALL) {
    const title = read(rel).match(/<title>([^<]*)<\/title>/u)?.[1];
    assert.ok(title, `${rel} has a title`);
    assert.doesNotMatch(title, /[—–·•]/u, `${rel}: "${title}"`);
    if (title.includes("Undiagnosed No More") && title !== "Undiagnosed No More" && !rel.startsWith("athena/launch")) {
      assert.match(title, /^[^|]+ \| Undiagnosed No More$/u, `${rel}: "${title}"`);
    }
  }
  assert.equal(read("clinician/index.html").match(/<title>([^<]*)<\/title>/u)[1], "Clinician view | Undiagnosed No More");
});

test("shared and door stylesheets are versioned, and every page links the same version of each", () => {
  const seen = {};
  for (const rel of ALL) {
    for (const [, href] of read(rel).matchAll(/<link rel="stylesheet" href="([^"]+)"/gu)) {
      const [path, query] = href.split("?");
      const file = path.split("/").pop();
      if (/^(site-nav|atlas|developers|deck|clinician|styles|landing|evidence|app)\.css$/u.test(file)) {
        assert.match(query || "", /^v=\d{8}$/u, `${rel}: ${href} has a version`);
        const key = path.replace(/^\.\.\//u, "/").replace(/^(?!\/)/u, `/${rel.split("/")[0]}/`);
        (seen[key] ||= new Set()).add(query);
      }
    }
  }
  for (const [key, versions] of Object.entries(seen)) assert.equal(versions.size, 1, `${key}: ${[...versions].join(", ")}`);
  assert.ok(seen["/shared/site-nav.css"], "site-nav.css is linked");
});

test("no page loads the retired hub stylesheet", () => {
  assert.equal(existsSync(new URL("hub.css", web)), false);
  for (const rel of ALL) assert.doesNotMatch(read(rel), /hub\.css/u, rel);
});


test("404 page: no dead links, the light and dark theme-color pair, and the versioned UNOM favicon", () => {
  const html = read("404.html");
  const home = read("index.html");
  const ids = new Set([...home.matchAll(/\sid="([^"]+)"/gu)].map((m) => m[1]));
  for (const [, href] of html.matchAll(/<a [^>]*href="([^"]+)"/gu)) {
    const [path, hash] = href.split("#");
    const target = path.endsWith("/") ? `${path}index.html` : path;
    assert.ok(existsSync(new URL(target.slice(1), web)), `${href}: ${target} exists`);
    if (hash) assert.ok(path === "/" && ids.has(hash), `${href}: #${hash} exists on the home page`);
  }
  assert.match(html, /<meta name="theme-color" content="#f6f5f1" media="\(prefers-color-scheme: light\)">/u);
  assert.match(html, /<meta name="theme-color" content="#171918" media="\(prefers-color-scheme: dark\)">/u);
  const icon = home.match(/<link rel="icon" href="([^"]+)"/u)[1];
  assert.match(icon, /^\/favicon\.svg\?v=/u);
  assert.ok(html.includes(`<link rel="icon" href="${icon}" type="image/svg+xml">`), "same favicon URL as the home page");
});

test("copy rules on the 404 page, the EHR launch pages, the walkthrough page, and the shared site bar", () => {
  const rels = ["404.html", "smart/index.html", "epic/index.html", "athena/launch.html", "athena/index.html", "walkthrough/index.html"];
  for (const rel of rels) {
    const html = read(rel);
    const copy = `${visible(html)} ${attrText(html)}`;
    assert.doesNotMatch(copy, /—/u, `${rel}: em dash`);
    assert.doesNotMatch(copy, /!/u, `${rel}: exclamation mark`);
    assert.doesNotMatch(copy, BANNED, `${rel}: marketing word`);
  }
  const nav = read("shared/site-nav.js");
  for (const [, s] of nav.matchAll(/"([^"\n]{20,})"/gu)) {
    assert.doesNotMatch(s, /—|!|\bany EHR\b|\bpower(s|ing)? every\b/u, `site-nav.js: "${s}"`);
    assert.doesNotMatch(s, BANNED, `site-nav.js: "${s}"`);
    assert.doesNotMatch(s, /their own record/u, "the demo shows synthetic records, not the visitor's own");
  }
});


test("every page, including the generated developer pages, links the UNOM favicon with the home page's version (no /favicon.ico request)", () => {
  const icon = read("index.html").match(/<link rel="icon" href="([^"]+)"/u)[1];
  for (const rel of ALL) {
    const html = read(rel);
    const href = html.match(/<link rel="icon" href="([^"]+)"/u)?.[1];
    if (rel.startsWith("patient/")) assert.match(href || "", /^\/patient\/icon\.svg\?v=/u, rel);
    else assert.equal(href, icon, rel);
  }
});

// One footer everywhere: pages that load site-nav.js get it from siteFooter(); the homepage and the
// SMART-launched views carry the same markup statically. No page keeps its own bottom caveat.
test("every page has the shared footer, and the static copies match site-nav.js", () => {
  const nav = read("shared/site-nav.js");
  const doors = [...nav.matchAll(/^\s+\["(\w+)", "(\/\w+\/)", "([^"]+)"\],$/gmu)].map((m) => [m[2], m[3]]);
  const legal = [...nav.slice(nav.indexOf("const LEGAL"), nav.indexOf("];", nav.indexOf("const LEGAL"))).matchAll(/\["([^"]+)", "([^"]+)"\]/gu)].map((m) => [m[1], m[2]]);
  const copyright = nav.match(/const COPYRIGHT = "([^"]+)"/u)[1];
  assert.equal(doors.length, 5);
  assert.equal(legal.length, 3);
  // The footer holds the legal links and the copyright only: the doors are in the bar, and "not a diagnosis" is said
  // once, on the Terms of use page.
  assert.doesNotMatch(nav, /NOT_DIAGNOSIS|unm-sitefooter-doors|unm-sitefooter-note/u);
  const links = (html) => [...html.matchAll(/<a href="([^"]+)"[^>]*>([^<]+)<\/a>/gu)].map((m) => [m[1], m[2]]);
  for (const page of ALL) {
    if (page.startsWith("deck/") || page === "smart/callback.html" || page === "epic/callback.html" || page === "athena/launch.html") continue;
    const html = read(page);
    assert.doesNotMatch(html, /<footer class="(?:site-footer|footer)/u, `${page}: no page-specific footer`);
    assert.doesNotMatch(html, /class="demo-note"|Every patient on this site is synthetic\. <a href="\/">Back to the start/u, `${page}: no bottom caveat`);
    if (html.includes("/shared/site-nav.js")) continue;
    const footer = html.match(/<footer class="unm-sitefooter[^"]*">[\s\S]*?<\/footer>/u)?.[0];
    assert.ok(footer, `${page}: static shared footer`);
    const found = links(footer);
    for (const [href, label] of legal) assert.ok(found.some(([h, l]) => h === href && l === label), `${page}: ${label}`);
    assert.ok(footer.includes(copyright), `${page}: copyright`);
    assert.doesNotMatch(footer, /unm-sitefooter-doors|unm-sitefooter-note|not a diagnosis/iu, `${page}: no doors or disclaimer in the footer`);
  }
  for (const slug of ["terms", "privacy", "rights"]) assert.ok(existsSync(new URL(`${slug}/index.html`, web)), `/${slug}/`);
});

// The "not a diagnosis" statement lives in one place, the Terms of use (every patient on the site is synthetic).
test("the Terms of use say the site is research decision support on synthetic patients and not a diagnosis", () => {
  assert.match(read("terms/index.html"), /<p>UNOM is research decision support shown on synthetic patients, and it is not a diagnosis\./u);
});

// Each app page opens with one or two lines on what it is for (moved from the old homepage sections), above its title.
test("the patient, clinician, and Atlas pages open with a short introduction above the title", () => {
  for (const [rel, lead, title] of [
    ["patient/index.html", '<p class="patient-lede" data-i18n="intro.about">Answer validated symptom questions', '<h1 id="home-title"'],
    ["clinician/index.html", '<p class="demo-lede">Inside the health record, see which condition', "<h1>Explore the clinician app</h1>"],
    ["atlas/index.html", '<p class="lede">In the Atlas, pick a condition', '<h1 id="atlas-title"'],
  ]) {
    const html = read(rel);
    assert.ok(html.includes(lead) && html.indexOf(lead) < html.indexOf(title), rel);
  }
  assert.match(read("patient/strings-es.js"), /"intro\.about": "Responda preguntas validadas sobre sus síntomas en inglés o en español/u);
});
