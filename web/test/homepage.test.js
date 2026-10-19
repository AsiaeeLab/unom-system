// Homepage (/): CSP-safe markup, copy rules, the first-visit tour (markup, and the script run
// against the real dialog markup), links that resolve, image alt text and sizes, the numbers the alt text
// repeats, the UNOM logo files, and the font subset coverage.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import vm from "node:vm";
import { demoDashboard, loadSiteModels } from "../tools/smart-parity.mjs";

const web = new URL("../web/", import.meta.url);
const file = (rel) => new URL(rel.replace(/^\//u, ""), web);
const read = (rel) => readFileSync(file(rel), "utf8");
// English only: Spanish is offered in the patient app alone (/patient/?lang=es; /es/ redirects there).
const PAGES = { en: "index.html" };

const attrs = (tag) => {
  const out = {};
  for (const m of tag.matchAll(/\s([a-zA-Z:-]+)(?:="([^"]*)")?/gu)) out[m[1].toLowerCase()] = m[2] ?? "";
  return out;
};
const tags = (html, name) => [...html.matchAll(new RegExp(`<${name}\\b[^>]*>`, "giu"))].map((m) => attrs(m[0].slice(name.length + 1)));
const ids = (html) => new Set([...html.matchAll(/\sid="([^"]+)"/gu)].map((m) => m[1]));
const local = (url) => url.split(/[?#]/u)[0];
const text = (html) =>
  html
    .replace(/<!doctype[^>]*>/iu, "")
    .replace(/<!--[\s\S]*?-->/gu, "")
    .replace(/<svg[\s\S]*?<\/svg>/gu, "")
    .replace(/<[^>]+>/gu, " ")
    .replace(/&[a-z]+;|&#\d+;/giu, " ");
const attrText = (html) => [...html.matchAll(/\s(?:alt|aria-label|content|title|data-counter)="([^"]*)"/gu)].map((m) => m[1]).join(" ");

// Image sizes from file headers: PNG (IHDR), WebP (VP8, VP8L, VP8X), SVG (viewBox).
function imageSize(rel) {
  const path = file(local(rel));
  if (rel.includes(".svg")) {
    const [, , w, h] = readFileSync(path, "utf8").match(/viewBox="([\d.\s-]+)"/u)[1].trim().split(/\s+/u).map(Number);
    return { w, h };
  }
  const b = readFileSync(path);
  if (b.toString("ascii", 1, 4) === "PNG") return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
  assert.equal(b.toString("ascii", 0, 4), "RIFF", `${rel} is PNG, WebP, or SVG`);
  const kind = b.toString("ascii", 12, 16);
  if (kind === "VP8 ") return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff };
  if (kind === "VP8L") {
    const bits = b.readUInt32LE(21);
    return { w: (bits & 0x3fff) + 1, h: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (kind === "VP8X") return { w: 1 + b.readUIntLE(24, 3), h: 1 + b.readUIntLE(27, 3) };
  throw new Error(`unknown WebP chunk in ${rel}`);
}

for (const [lang, page] of Object.entries(PAGES)) {
  const html = read(page);

  test(`${lang}: no inline script or style, no third-party resources (CSP: same origin only)`, () => {
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/iu, "inline script");
    assert.doesNotMatch(html, /<style/iu, "style element");
    assert.doesNotMatch(html, /\sstyle=/iu, "style attribute");
    assert.doesNotMatch(html, /\son[a-z]+=/iu, "inline event handler");
    assert.doesNotMatch(html, /<iframe/iu, "iframe (frame-src is not allowed)");
    for (const name of ["script", "img", "source", "video", "link"]) {
      for (const a of tags(html, name)) {
        for (const key of ["src", "srcset", "poster", "data-poster"]) {
          if (a[key] !== undefined) assert.match(a[key], /^\/[^/]/u, `${name} ${key}="${a[key]}" is same-origin`);
        }
        if (name === "link" && a.rel !== "alternate") assert.match(a.href, /^\/[^/]/u, `link href="${a.href}" is same-origin`);
      }
    }
  });

  test(`${lang}: copy has no em dash and no exclamation mark`, () => {
    const copy = `${text(html)} ${attrText(html)}`;
    assert.doesNotMatch(copy, /—/u, "em dash");
    assert.doesNotMatch(copy, /!/u, "exclamation mark");
    assert.doesNotMatch(copy, /\b(?:seamless\w*|leverag\w*|robust\w*|comprehensive|empower\w*|unlock\w*|delv(?:e|es|ing)|cutting-edge|game-chang\w*)\b/iu, "banned word");
    assert.doesNotMatch(copy, /\bUNM\b/u, "old UNM abbreviation");
  });

  test(`${lang}: skip link and every in-page link have a target`, () => {
    const known = ids(html);
    assert.match(html, /<a class="skip-link" href="#main">/u);
    assert.match(html, /<main id="main" tabindex="-1">/u);
    for (const a of tags(html, "a")) {
      if (a.href?.startsWith("#")) assert.ok(known.has(a.href.slice(1)), `#${a.href.slice(1)} exists`);
    }
  });

  test(`${lang}: every local link, image, script, and stylesheet resolves to a file`, () => {
    const urls = [
      ...tags(html, "a").map((a) => a.href),
      ...tags(html, "img").map((a) => a.src),
      ...tags(html, "source").map((a) => a.srcset || a.src),
      ...tags(html, "script").map((a) => a.src),
      ...tags(html, "link").filter((a) => a.rel !== "alternate").map((a) => a.href),
      ...tags(html, "video").map((a) => a["data-poster"]),
    ].filter((u) => u && u.startsWith("/"));
    assert.ok(urls.length > 20);
    for (const u of urls) {
      const path = local(u);
      if (path === "/media/walkthrough.mp4") continue; // optional: tour.js hides the video until it exists
      if (/^\/(about|challenge)\//u.test(path)) continue; // live-site pages that are not in this repository
      const target = path.endsWith("/") ? `${path}index.html` : path;
      assert.ok(existsSync(file(target)), `${u} exists as ${target}`);
    }
  });

  test(`${lang}: every image has alt text; screens have a precise alt, size attributes that match the file, and stay small`, () => {
    const imgs = tags(html, "img");
    assert.ok(imgs.length >= 5, "two logo images and three door screens");
    for (const img of imgs) {
      assert.ok(img.alt !== undefined, `${img.src} has an alt attribute`);
      assert.ok(img.width && img.height, `${img.src} has width and height`);
      if (img.src.includes("/door-")) assert.ok(img.alt.length > 80, `${img.src} alt describes the screen`);
      if (img.src.includes("unom-logo")) assert.equal(img.alt, "", "logo images are decorative; the link carries the name");
    }
    for (const el of [...imgs, ...tags(html, "source").filter((s) => s.srcset)]) {
      const src = el.src || el.srcset;
      const { w, h } = imageSize(src);
      const ratio = Number(el.width) / Number(el.height);
      assert.ok(Math.abs(ratio / (w / h) - 1) < 0.01, `${src}: width/height ${el.width}x${el.height} match the file (${w}x${h})`);
      if (src.includes("/door-")) assert.ok(statSync(file(local(src))).size < 125 * 1024, `${src} is under 125 KB`);
    }
    // Phone crops stay short, so the next section comes soon: at most 420 px tall in a 358 px column (390 px phone).
    for (const img of imgs.filter((i) => i.src.includes("/door-"))) {
      assert.ok((358 * Number(img.height)) / Number(img.width) <= 420, `${img.src} is ${Math.round((358 * img.height) / img.width)} px tall at 358 px`);
    }
    assert.doesNotMatch(html, /Region [A-E]|Maria R\.|review_required|distinct_symptoms/u, "invented preview data is gone");
  });

  test(`${lang}: og:url and og:image use the same domain, and no language alternates are declared`, () => {
    const meta = (prop) => html.match(new RegExp(`<meta property="${prop}" content="([^"]+)">`, "u"))?.[1];
    assert.equal(new URL(meta("og:url")).origin, new URL(meta("og:image")).origin);
    assert.equal(tags(html, "link").filter((l) => l.rel === "alternate").length, 0, "no hreflang alternates");
    assert.doesNotMatch(html, /Español|hreflang="es"|href="\/es\/"|language-setting/u, "no Spanish link or Language field");
  });

  test(`${lang}: social card is a 1200 x 630 PNG and the favicon is the UNOM one`, () => {
    const og = html.match(/<meta property="og:image" content="([^"]+)">/u)[1];
    assert.match(og, /^https:\/\/[^/]+\/images\/og-card\.png(\?|$)/u);
    assert.deepEqual(imageSize("images/og-card.png"), { w: 1200, h: 630 });
    assert.match(html, /<meta property="og:image:type" content="image\/png">/u);
    assert.match(html, /<meta name="twitter:card" content="summary_large_image">/u);
    assert.match(html, /<link rel="icon" href="\/favicon\.svg[^"]*" type="image\/svg\+xml">/u);
  });

  test(`${lang}: first-visit tour markup and script`, () => {
    assert.match(html, /<script src="\/tour\.js[^"]*" defer><\/script>/u);
    assert.match(html, /<link rel="stylesheet" href="\/tour\.css[^"]*">/u);
    const dialog = tags(html, "dialog").find((d) => d.id === "tour");
    assert.ok(dialog, "dialog#tour");
    assert.equal(dialog.role, "dialog");
    assert.equal(dialog["aria-modal"], "true");
    assert.ok(ids(html).has(dialog["aria-labelledby"]));
    assert.ok(dialog["data-youtube-url"] !== undefined, "data-youtube-url on the tour root");
    assert.match(dialog["data-counter"], /\{n\}.*\{total\}/u);
    const steps = [...html.matchAll(/<section class="tour-step" data-tour-step data-target="([^"]*)"/gu)].map((m) => m[1]);
    assert.equal(steps.length, 8, "what the site does, the data, the AI models, the four users, try it with Maria");
    assert.deepEqual(steps, ["top", "#hub-data", "#hub-ai", "#hub-clinicians, #tile-clinicians", "#hub-patients, #tile-patients",
      "#hub-policy, #tile-policy", "#hub-developers, #tile-developers", ""]);
    // each step names the infographic part, and for the four users also its phone tile
    for (const target of steps.filter((t) => t.startsWith("#")).flatMap((t) => t.split(", "))) assert.ok(ids(html).has(target.slice(1)), `${target} exists`);
    for (const hook of ["data-tour-skip", "data-tour-next", "data-tour-back", "data-tour-done", "data-tour-count", "data-tour-fallback", "data-tour-youtube", "data-tour-live"]) {
      assert.match(html, new RegExp(`\\s${hook}[\\s>=]`, "u"), hook);
    }
    assert.ok((html.match(/data-tour-open hidden/gu) || []).length >= 1, "a Take the tour button, hidden until tour.js runs");
    const video = tags(html, "video")[0];
    assert.equal(video.preload, "none");
    assert.ok(video.hidden !== undefined, "video hidden until the file is found");
    assert.match(html, /<source src="\/media\/walkthrough\.mp4" type="video\/mp4">/u);
    assert.ok(existsSync(file(local(video["data-poster"]))), "poster image exists");
    // The walkthrough gate: tour.js requests the mp4 only when data-video-posted="true", and a posted
    // video needs captions and a transcript (WCAG 1.2.2).
    assert.match(dialog["data-video-posted"], /^(true|false)$/u, "data-video-posted on the tour root");
    if (dialog["data-video-posted"] === "true") {
      assert.ok(existsSync(file("media/walkthrough.mp4")), "the posted walkthrough exists");
      const tracks = tags(html, "track").filter((t) => t.kind === "captions");
      assert.ok(tracks.some((t) => t.srclang === lang), `a ${lang} captions track`);
      for (const t of tracks) assert.ok(existsSync(file(local(t.src))), `${t.src} exists`);
      assert.match(html, /\sdata-tour-transcript[\s>]/u, "a transcript link");
    } else {
      assert.equal(existsSync(file("media/walkthrough.mp4")), false, "mp4 shipped: set data-video-posted=\"true\" and add captions");
    }
    assert.match(html, /<h2 id="tour-8-title" tabindex="-1" data-video-title="[^"]+">[^<]+<\/h2>/u, "last step heading without a video, and the video heading");
    assert.doesNotMatch(text(html.slice(html.indexOf('<dialog class="tour"'))), /\b(?:doors?|puertas?|Welcome|Bienvenida|Start exploring|Empezar a explorar)\b/iu, "tour copy says tools, not doors, and no generic onboarding phrases");
  });

  test(`${lang}: the homepage is the infographic: a link over each part, four phone tiles, and nothing else`, () => {
    const hrefs = Object.fromEntries([...html.matchAll(/<a class="hub-zone hub-zone-(\w+)" id="hub-\w+" href="([^"]+)"/gu)].map((m) => [m[1], m[2]]));
    assert.deepEqual(hrefs, { clinicians: "/clinician/", policy: "/atlas/", patients: "/patient/", developers: "/developers/",
      data: "/about/#data", ai: "/about/#ai", papers: "/about/#papers" });
    const tiles = [...html.matchAll(/<li><a id="tile-(\w+)" href="([^"]+)">[\s\S]*?<strong>([^<]+)<\/strong><\/a><\/li>/gu)].map((m) => [m[1], m[2], m[3]]);
    // the tiles follow the infographic's corners: clinicians and policymakers on top, patients and developers below
    assert.deepEqual(tiles, [["clinicians", "/clinician/", "For clinicians"], ["policy", "/atlas/", "For policymakers"],
      ["patients", "/patient/", "For patients"], ["developers", "/developers/", "For developers"]]);
    const img = tags(html, "img").find((i) => i.src.includes("/unom-infographic"));
    for (const words of ["All of Us Research Program", "CDC", "CMS", "U.S. Census Bureau", "nine conditions and one shared scorer", "four research papers"]) {
      assert.ok(img.alt.includes(words), `the infographic alt text names ${words}`);
    }
    assert.doesNotMatch(html, /<section class="(?:door|cover|evidence|team)\b|<nav class="contents"/u, "no sections below the infographic");
  });

  test(`${lang}: every character is inside the font subset's unicode-range`, () => {
    const css = read("homepage-fonts.css");
    const ranges = css
      .match(/unicode-range:\s*([^;]+);/u)[1]
      .split(",")
      .map((r) => r.trim().replace(/^U\+/u, "").split("-").map((x) => parseInt(x, 16)))
      .map(([a, b]) => [a, b ?? a]);
    const html2 = html.replace(/&nbsp;/gu, " ");
    const copy = `${text(html2)} ${attrText(html2)}`;
    const outside = [...new Set(copy)].filter((ch) => !ranges.some(([a, b]) => ch.codePointAt(0) >= a && ch.codePointAt(0) <= b));
    assert.deepEqual(outside, [], `characters outside the subset: ${outside.join(" ")}`);
  });
}

test("homepage sections and the redirect from the retired Spanish homepage", () => {
  const en = read(PAGES.en);
  const sections = [...en.matchAll(/<section class="[^"]*" id="([^"]+)"/gu)].map((m) => m[1]);
  assert.deepEqual(sections, ["top"], "the homepage is the infographic alone");
  assert.equal(existsSync(file("es/index.html")), false);
  assert.match(read("_redirects"), /^\/es\/ \/patient\/\?lang=es 302$/mu);
});

test("homepage scripts: storage in try/catch, tour skipped under automation and ?notour, no third-party fetch", () => {
  for (const name of ["homepage-settings.js", "tour.js"]) {
    const js = read(name);
    const lines = js.split("\n");
    lines.forEach((line, i) => {
      if (/localStorage\.(get|set|remove)Item/u.test(line)) {
        assert.ok(lines.slice(Math.max(0, i - 3), i).some((l) => /try \{/u.test(l)), `${name}:${i + 1} storage access is inside try`);
      }
    });
    assert.doesNotMatch(js, /fetch\(\s*["'`]https?:/u, `${name}: no third-party fetch`);
    assert.doesNotMatch(js, /innerHTML|document\.write|eval\(/u, `${name}: no HTML injection`);
  }
  const tour = read("tour.js");
  assert.match(tour, /params\.has\("notour"\)/u);
  assert.match(tour, /navigator\.webdriver/u);
  assert.match(tour, /showModal\(\)/u);
  assert.match(tour, /"cancel"/u, "Escape closes");
  assert.match(tour, /event\.key !== "Tab"/u, "focus trap");
  assert.match(tour, /prefers-reduced-motion/u);
  assert.match(tour, /method: "HEAD"/u, "checks the walkthrough file before showing the video");
});

// A small DOM for tour.js: the real <dialog id="tour"> markup parsed into elements that support what the
// script uses (attributes, hidden, textContent, listeners, querySelector with tag and [attr] selectors).
const VOID = new Set(["source", "img", "br", "input", "track", "meta", "link"]);
class Node {
  constructor(tag, a = {}, parent = null) {
    Object.assign(this, { tag, attrs: a, parent, children: [], listeners: {}, open: false, paused: true });
    this.hidden = a.hidden !== undefined;
    this.id = a.id || "";
    this.classList = { add() {}, remove() {} };
  }
  get textContent() { return this.children.map((c) => (typeof c === "string" ? c : c.textContent)).join(""); }
  set textContent(v) { this.children = [String(v)]; }
  getAttribute(n) { return n in this.attrs ? this.attrs[n] : null; }
  setAttribute(n, v) { this.attrs[n] = String(v); }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  dispatch(type, event = {}) { for (const fn of this.listeners[type] || []) fn({ preventDefault() {}, target: this, ...event }); }
  matches(sel) {
    const m = sel.match(/^([a-z0-9]*)(?:\[([a-z-]+)\])?$/u);
    return !!m && (!m[1] || this.tag === m[1]) && (!m[2] || m[2] in this.attrs);
  }
  querySelectorAll(sel) {
    const out = [];
    const walk = (n) => n.children.forEach((c) => { if (typeof c !== "string") { if (c.matches(sel)) out.push(c); walk(c); } });
    walk(this);
    return out;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  closest(sel) { for (let n = this; n; n = n.parent) if (n.matches(sel)) return n; return null; }
  contains(other) { for (let n = other; n; n = n.parent) if (n === this) return true; return false; }
  focus() { this.ownerDocument.activeElement = this; }
  scrollIntoView() {}
  getClientRects() { return this.hidden ? [] : [{}]; }
  showModal() { this.open = true; }
  close() { this.open = false; this.dispatch("close"); }
  pause() {}
}
function tourDialog(html) {
  const src = html.slice(html.indexOf('<dialog class="tour"'), html.indexOf("</dialog>") + "</dialog>".length);
  const root = new Node("#root");
  let cur = root;
  for (const m of src.matchAll(/<(\/?)([a-z0-9]+)([^>]*)>|([^<]+)/gu)) {
    if (m[4]) cur.children.push(m[4].replace(/&#39;|&apos;/gu, "'"));
    else if (m[1]) cur = cur.parent;
    else {
      const el = new Node(m[2], attrs(m[3]), cur);
      cur.children.push(el);
      if (!VOID.has(m[2])) cur = el;
    }
  }
  return root.children[0];
}
function runTour(html, { posted } = {}) {
  const dialog = tourDialog(html);
  if (posted !== undefined) dialog.setAttribute("data-video-posted", posted);
  const storage = {};
  const fetches = [];
  const body = new Node("body");
  const main = new Node("main");
  const document = {
    body, activeElement: body,
    getElementById: (id) => (id === "tour" ? dialog : id === "main" ? main : null),
    querySelectorAll: () => [], // no "Take the tour" buttons outside the dialog in this harness
    querySelector: () => new Node("section"), // the section a step highlights
    contains: () => true,
  };
  const own = (n) => { n.ownerDocument = document; n.children.forEach((c) => typeof c !== "string" && own(c)); };
  [dialog, body, main].forEach(own);
  const window = {
    localStorage: { getItem: (k) => storage[k] ?? null, setItem: (k, v) => { storage[k] = String(v); } },
    matchMedia: () => ({ matches: false }),
    scrollTo() {},
    location: { search: "", hash: "" },
    fetch: (url, opts) => {
      fetches.push({ url, method: opts?.method });
      return Promise.resolve({ ok: true, headers: { get: () => "video/mp4" } });
    },
  };
  const context = { window, document, navigator: { webdriver: false, userAgent: "node" }, URLSearchParams };
  vm.runInNewContext(read("tour.js"), context);
  const step = (attr) => dialog.querySelector(`[${attr}]`);
  return { dialog, storage, fetches, next: () => step("data-tour-next").dispatch("click"), step };
}

for (const [lang, page] of Object.entries(PAGES)) {
  test(`${lang}: tour.js opens on a first visit and makes no request for an unposted walkthrough`, async () => {
    const tour = runTour(read(page), { posted: "false" });
    assert.equal(tour.dialog.open, true, "opens by itself on a first visit");
    const sides = [tour.dialog.getAttribute("data-side")];
    for (let i = 0; i < 7; i++) {
      tour.next();
      sides.push(tour.dialog.getAttribute("data-side"));
    }
    // On desktop the panel sits on the side away from the infographic part it points at: right for the data, the AI
    // models, and the two left quadrants, left for the two right quadrants.
    assert.deepEqual(sides, ["end", "end", "end", "end", "end", "start", "start", "end"]);
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(tour.fetches, [], "no HEAD request while data-video-posted is false");
    const last = tour.dialog.querySelectorAll("[data-tour-step]").at(-1);
    assert.equal(last.hidden, false, "on the last step");
    assert.equal(last.querySelector("h2").textContent, lang === "es" ? "Pruébelo con Maria" : "Try it with Maria");
    assert.equal(last.querySelector("video").hidden, true);
    assert.equal(last.querySelector("[data-tour-fallback]").hidden, false);
    assert.equal(last.querySelector("[data-tour-transcript]").hidden, true, "no transcript link without the video");
    assert.equal(tour.storage["unom.tour"], undefined, "not marked as seen yet");
  });

  test(`${lang}: following a link inside the tour marks it as seen`, () => {
    const tour = runTour(read(page));
    for (let i = 0; i < 7; i++) tour.next();
    const link = tour.dialog.querySelector("[data-tour-fallback]").querySelector("a");
    assert.ok(link.getAttribute("href"), "the fallback has a link");
    tour.dialog.dispatch("click", { target: link });
    assert.equal(tour.storage["unom.tour"], "done");
  });

  test(`${lang}: a posted walkthrough is checked with one same-origin HEAD and shown with its heading`, async () => {
    const tour = runTour(read(page), { posted: "true" });
    for (let i = 0; i < 7; i++) tour.next();
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(tour.fetches, [{ url: "/media/walkthrough.mp4", method: "HEAD" }]);
    const last = tour.dialog.querySelectorAll("[data-tour-step]").at(-1);
    assert.equal(last.querySelector("video").hidden, false);
    assert.equal(last.querySelector("[data-tour-fallback]").hidden, true);
    assert.equal(last.querySelector("[data-tour-transcript]").hidden, false, "the transcript link is shown with the video");
    assert.equal(last.querySelector("h2").textContent, last.querySelector("h2").getAttribute("data-video-title"));
  });
}

// The walkthrough (web/tools/record_walkthrough.py writes the MP4, the caption file, and /walkthrough/ from one
// scene list): the files agree with each other and with what the tour says about the video. English only:
// Spanish is offered in the patient app alone.
const vttCues = (rel) => {
  const sec = (t) => t.split(":").reduce((acc, x) => acc * 60 + Number(x), 0);
  return read(rel).split(/\n\n+/u).slice(1).filter((b) => b.trim()).map((block) => {
    const lines = block.trim().split("\n");
    const [, start, end] = lines[1].match(/^([\d:.]+) --> ([\d:.]+)/u);
    return { start: sec(start), end: sec(end), text: lines.slice(2).join(" ") };
  });
};
const mp4Seconds = () => {
  const b = readFileSync(file("media/walkthrough.mp4"));
  const i = b.indexOf("mvhd");
  assert.ok(i > 0 && i < 4096, "the moov box comes first (faststart)");
  return b[i + 4] === 1 ? Number(b.readBigUInt64BE(i + 28)) / b.readUInt32BE(i + 24) : b.readUInt32BE(i + 20) / b.readUInt32BE(i + 16);
};

test("Watch page (/walkthrough/): the demo video, its transcript, then the slide deck, written by the recorder's template", () => {
  const page = read("walkthrough/index.html");
  assert.match(page, /<title>Watch \| Undiagnosed No More<\/title>/u);
  assert.deepEqual([...page.matchAll(/<h1>([^<]*)<\/h1>/gu)].map((m) => m[1]), ["Watch"]);
  assert.deepEqual([...page.matchAll(/<h2 id="([^"]+)">([^<]*)<\/h2>/gu)].map((m) => [m[1], m[2]]),
    [["video-title", "Demo video"], ["transcript-title", "Transcript"], ["deck-title", "Slide deck"]], "video, transcript, deck, in that order");
  const deck = page.match(/<section class="section" id="deck" aria-labelledby="deck-title">[\s\S]*?<\/section>/u)?.[0] || "";
  assert.match(deck, /<a class="button button-dark" href="\/deck\/">View the slides<\/a>/u);
  assert.match(deck, /<a class="button button-outline" href="\/deck\/undiagnosed-no-more-deck\.pdf">Download the PDF<\/a>/u);
  for (const rel of ["deck/index.html", "deck/undiagnosed-no-more-deck.pdf"]) assert.ok(existsSync(file(rel)), `${rel} exists`);
  assert.match(read("walkthrough/walkthrough.css"), /\.deck-links \{/u);
  assert.doesNotMatch(page, /tutorial/iu, "no placeholder for a tutorial that is not recorded yet");
  // The next recording writes the same page: the recorder's template carries the title, the headings, and the deck.
  const tool = readFileSync(new URL("../tools/record_walkthrough.py", import.meta.url), "utf8");
  assert.match(tool, /^TITLE_EN = "Watch"$/mu);
  assert.ok(tool.includes("<h1>{TITLE_EN}</h1>"));
  for (const line of deck.split("\n").map((l) => l.trim()).filter(Boolean)) assert.ok(tool.includes(line), `the template writes: ${line}`);
  assert.ok(tool.includes('<h2 id="video-title">Demo video</h2>'));
});

test("walkthrough: an H.264 MP4 under 20 MB, English captions, and a transcript with the same text and the same length", () => {
  if (!existsSync(file("media/walkthrough.mp4"))) return;
  const mp4 = readFileSync(file("media/walkthrough.mp4"));
  assert.ok(mp4.length < 20 * 1024 * 1024, `${(mp4.length / 1048576).toFixed(1)} MB`);
  assert.equal(mp4.toString("latin1", 4, 8), "ftyp");
  assert.ok(mp4.includes("avc1"), "H.264 video");
  const seconds = mp4Seconds();
  assert.ok(seconds >= 180 && seconds <= 300, `${seconds.toFixed(1)} s is 3 to 5 minutes (the demo video is at most 5 minutes)`);
  const en = vttCues("media/walkthrough.en.vtt");
  assert.match(read("media/walkthrough.en.vtt"), /^WEBVTT\n/u);
  assert.ok(en.length >= 10, `${en.length} cues`);
  assert.equal(existsSync(file("media/walkthrough.es.vtt")), false, "no Spanish caption file");
  en.forEach((c, i) => {
    assert.ok(c.end > c.start, `cue ${i + 1} has a length`);
    if (i) assert.ok(c.start >= en[i - 1].end, `cue ${i + 1} starts after cue ${i} ends`);
  });
  assert.ok(en.at(-1).end <= seconds + 0.05, "the last cue ends with the video");
  const page = read("walkthrough/index.html");
  const decode = (s) => s.replace(/&#x27;|&#39;/gu, "'").replace(/&quot;/gu, '"').replace(/&amp;/gu, "&");
  const listed = [...page.matchAll(/<span class="wt-text">([^<]*)<\/span>/gu)].map((m) => decode(m[1]));
  assert.deepEqual(listed, en.map((c) => c.text), "the transcript page lists the captions");
  for (const t of en.map((c) => c.text)) {
    assert.doesNotMatch(t, /—|!/u, `caption: ${t}`);
  }
  assert.match(page, /<track kind="captions" src="\/media\/walkthrough\.en\.vtt[^"]*" srclang="en"/u);
  assert.deepEqual(tags(page, "track").map((t) => t.srclang), ["en"], "the transcript page has one caption track, in English");
  assert.doesNotMatch(page, /walkthrough\.es\.vtt|srclang="es"|lang="es"|hreflang="es"|id="es"|Transcripción/u, "no Spanish track, transcript, or link");
  // The length the transcript page states, in its text and its description, is the video's length.
  const meta = page.match(/<p class="wt-meta">((\d+) minutes(?: (\d+) seconds)?), 1280 x 720, no audio\./u);
  assert.ok(meta, "the transcript page states the length");
  const stated = Number(meta[2]) * 60 + Number(meta[3] || 0);
  assert.ok(Math.abs(stated - seconds) <= 1, `the transcript page states ${meta[1]} for a ${seconds.toFixed(1)} s video`);
  assert.ok(page.includes(`synthetic patients (${meta[1]})`), `the page description states ${meta[1]}`);
  const minutes = Math.round(seconds / 60);
  for (const [lang, rel] of Object.entries(PAGES)) {
    const home = read(rel);
    const title = home.match(/data-video-title="([^"]+)"/u)[1];
    assert.ok(title.includes(`${minutes}-minute`), `${lang}: "${title}" names the ${minutes}-minute length`);
    const tour = home.slice(home.indexOf('<dialog class="tour"'), home.indexOf("</dialog>"));
    assert.deepEqual(tags(tour, "track").map((t) => t.srclang), ["en"], `${lang}: the tour's video has one caption track, in English`);
    assert.doesNotMatch(tour, /walkthrough\.es\.vtt|in English and Spanish/u, `${lang}: no Spanish caption track or wording in the tour's video`);
  }
});

test("UNOM logo files: one per variant, outlines only (no text, fonts, or raster)", () => {
  const variants = ["wide", "compact", "stacked"].flatMap((k) => ["light", "dark"].map((t) => `images/homepage/unom-logo-${k}-${t}.svg`));
  for (const rel of [...variants, "images/homepage/unom-favicon.svg"]) {
    assert.ok(existsSync(file(rel)), `${rel} exists`);
    const svg = read(rel);
    assert.match(svg, /<path /u);
    assert.doesNotMatch(svg, /<text|<image|@font-face|font-family|base64|<foreignObject/iu, `${rel} has outlines only`);
  }
  for (const k of ["wide", "compact", "stacked"]) {
    const light = read(`images/homepage/unom-logo-${k}-light.svg`);
    const dark = read(`images/homepage/unom-logo-${k}-dark.svg`);
    assert.equal((light.match(/#ae0808/gu) || []).length, 1, `${k} light: red used once`);
    assert.equal((dark.match(/#d87067/gu) || []).length, 1, `${k} dark: red used once`);
    assert.match(light, /aria-label="UNOM, Undiagnosed No More"/u);
  }
  assert.equal(read("favicon.svg"), read("images/homepage/unom-favicon.svg"), "favicon.svg is the UNOM favicon");
  assert.ok(existsSync(file("images/homepage/legacy-unm-favicon.svg")), "old favicon kept for a one-line revert");
  assert.ok(existsSync(file("images/homepage/legacy-unm-og-card.png")), "old social card kept");
  for (const old of ["6e0ee", "7376d", "6e262", "8f4d5", "457de", "04404", "1891f", "4604a"]) {
    assert.ok(existsSync(file(`images/homepage/${old}.svg`)), `old logo ${old}.svg kept`);
  }
});

test("homepage fonts: WOFF2 subsets first, TTF fallback, no 500 weight", () => {
  const css = read("homepage-fonts.css");
  const faces = css.match(/@font-face\s*\{[^}]+\}/gu);
  assert.equal(faces.length, 3);
  for (const face of faces) {
    const [, woff2, ttf] = face.match(/src:\s*url\(([^)]+\.woff2)\) format\("woff2"\),\s*url\(([^)]+\.ttf)\) format\("truetype"\)/u);
    assert.ok(existsSync(file(woff2)) && existsSync(file(ttf)), `${woff2} and ${ttf} exist`);
    assert.ok(statSync(file(woff2)).size < 30 * 1024, `${woff2} is a subset`);
  }
  assert.doesNotMatch(css, /font-weight:\s*500/u);
  const page = read("homepage.css");
  assert.doesNotMatch(page, /dvh|font-weight:\s*500/u, "no viewport-height type, no 500 weight");
  assert.doesNotMatch(page, /"IBM Plex Mono", sans-serif/u, "Mono falls back to monospace");
});

test("homepage type: sizes in rem or px, never viewport height, and no text under 14 px", () => {
  for (const name of ["homepage.css", "tour.css"]) {
    const css = read(name);
    const sizes = [
      ...[...css.matchAll(/font-size:\s*([^;}]+)/gu)].map((m) => m[1]),
      ...[...css.matchAll(/font:\s*\d{3}\s+([^\s/]+)/gu)].map((m) => m[1]),
    ];
    assert.ok(sizes.length >= 4, `${name}: font sizes found`);
    for (const size of sizes) {
      assert.doesNotMatch(size, /[sdl]?vh\b/u, `${name}: ${size} does not depend on viewport height`);
      for (const [, n, unit] of size.matchAll(/([\d.]+)(rem|px)\b/gu)) {
        const px = unit === "rem" ? Number(n) * 16 : Number(n);
        assert.ok(px >= 14 || size.includes("%"), `${name}: ${size} is at least 14 px`);
      }
    }
  }
});

