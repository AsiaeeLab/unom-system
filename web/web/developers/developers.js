// Developer pages: copy buttons on code blocks, the current section in the side navigation, the in-page scorer
// ("Try the scorer"), and sending the example CDS Hooks requests to the service on this site.
// Same-origin requests only (the site CSP allows connect-src 'self'); the DOM is built with textContent, never
// from HTML strings.

const SERVICE_URL = "/cds-services/invisible-illness";
const TOLERANCE = 1e-9;

function el(tag, attrs = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  for (const kid of kids) node.append(kid);
  return node;
}

const cache = new Map();
function getJson(url) {
  if (!cache.has(url)) {
    cache.set(url, fetch(url, { credentials: "same-origin" }).then((response) => {
      if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
      return response.json();
    }));
  }
  return cache.get(url);
}

/** First difference between a result and an expected output (same keys in the same order, numbers to 1e-9). */
export function firstDifference(actual, expected, path = "$") {
  if (typeof expected === "number") {
    return typeof actual === "number" && Math.abs(actual - expected) <= TOLERANCE ? null : path;
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) return path;
    for (let i = 0; i < expected.length; i += 1) {
      const d = firstDifference(actual[i], expected[i], `${path}[${i}]`);
      if (d) return d;
    }
    return null;
  }
  if (expected !== null && typeof expected === "object") {
    if (actual === null || typeof actual !== "object" || Array.isArray(actual)) return path;
    const a = Object.keys(actual), e = Object.keys(expected);
    if (a.length !== e.length || a.some((k, i) => k !== e[i])) return `${path} (fields)`;
    for (const k of e) {
      const d = firstDifference(actual[k], expected[k], `${path}.${k}`);
      if (d) return d;
    }
    return null;
  }
  return actual === expected ? null : path;
}

export function percent(p) {
  return `${(100 * p).toFixed(p < 0.1 ? 2 : 1)}%`;
}

// ---------------------------------------------------------------- copy buttons

function addCopyButtons() {
  if (!navigator.clipboard?.writeText) return;
  for (const head of document.querySelectorAll(".code-head")) {
    const code = head.parentElement?.querySelector("pre");
    if (!code || head.querySelector(".copy")) continue;
    const label = head.textContent.trim();
    const button = el("button", { class: "copy", type: "button", "aria-label": `Copy: ${label}` }, "Copy");
    button.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(code.textContent);
        button.textContent = "Copied";
      } catch {
        button.textContent = "Select and copy";
      }
      setTimeout(() => {
        button.textContent = "Copy";
      }, 1600);
    });
    head.append(button);
  }
}

// ---------------------------------------------------------------- current section in the side navigation

// The current section is the last one whose top has passed a line just under the sticky site bar.
function trackSections() {
  const links = [...document.querySelectorAll('.dev-nav a[href^="#"]')];
  const targets = links.map((a) => document.getElementById(a.getAttribute("href").slice(1)));
  if (!links.length || targets.some((t) => !t)) return;
  let queued = false;
  const update = () => {
    queued = false;
    let current = 0;
    targets.forEach((t, i) => {
      if (t.getBoundingClientRect().top <= 140) current = i;
    });
    if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2) current = targets.length - 1;
    links.forEach((a, i) => a.classList.toggle("is-current", i === current));
  };
  const queue = () => {
    if (!queued) {
      queued = true;
      requestAnimationFrame(update);
    }
  };
  window.addEventListener("scroll", queue, { passive: true });
  window.addEventListener("resize", queue);
  update();
}

// ---------------------------------------------------------------- try the scorer

const SHOWN_DRIVERS = 5;

function evidenceCell(evidence) {
  const cell = el("td", { class: "try-evidence" });
  if (!evidence.length) {
    cell.append("no dated record");
    return cell;
  }
  for (const e of evidence.slice(0, 3)) cell.append(el("span", {}, `${e.resourceType} ${e.id}, ${e.date}`));
  if (evidence.length > 3) cell.append(el("span", {}, `and ${evidence.length - 3} more`));
  return cell;
}

function driversTable(drivers) {
  const body = el("tbody");
  for (const d of drivers.slice(0, SHOWN_DRIVERS)) {
    body.append(el("tr", {},
      el("td", {}, d.label),
      el("td", {}, d.group || ""),
      el("td", {}, d.contribution.toFixed(4)),
      evidenceCell(d.evidence)));
  }
  const head = el("tr", {}, ...["Finding", "Group", "Contribution", "Chart records"].map((h) => el("th", { scope: "col" }, h)));
  return el("div", { class: "table-wrap" }, el("table", {}, el("thead", {}, head), body));
}

function summaryLine(result) {
  if (result.status === "scored") {
    return `${result.band}: probability ${percent(result.probability)}, ${result.times_average.toFixed(2)} times the average. Day 0: ${result.index_date}.`;
  }
  // a could-not-score reason already starts "could not score: ..."
  if (result.status === "could_not_score") return `${result.reason.charAt(0).toUpperCase()}${result.reason.slice(1)}.`;
  return `Not scored: ${result.reason}.`;
}

async function setUpTry() {
  const form = document.getElementById("try-form");
  const out = document.getElementById("try-out");
  if (!form || !out) return;
  const { scoreBundle } = await import("/shared/scorer.js");
  form.hidden = false;
  const dateInput = form.elements.as_of;

  async function run() {
    const patientOption = form.elements.patient.selectedOptions[0];
    const modelOption = form.elements.model.selectedOptions[0];
    const patient = patientOption.value;
    const asOf = dateInput.value || dateInput.defaultValue;
    const unavailable = [...form.querySelectorAll('input[name="unavailable"]:checked')].map((box) => box.value);
    try {
      const [model, bundle] = await Promise.all([getJson(modelOption.value), getJson(`/developers/vectors/bundles/${patient}.json`)]);
      const result = scoreBundle(model, bundle, asOf, { unavailable });
      const kids = [
        el("p", { class: "try-scenario" }, `${patientOption.textContent}: ${patientOption.dataset.scenario}`),
        el("p", { class: "try-result" }, summaryLine(result)),
      ];
      const expectedDir = modelOption.dataset.expected;
      if (expectedDir && asOf === dateInput.dataset.vectors && !unavailable.length) {
        const file = `${expectedDir}${patient}.json`;
        const expected = { ...(await getJson(file)) };
        delete expected.as_of;
        const diff = firstDifference(result, expected);
        const link = el("a", { href: file }, file.split("/").slice(-2).join("/"));
        kids.push(diff
          ? el("p", { class: "try-check is-different" }, "Differs from the reference output ", link, ` at ${diff}.`)
          : el("p", { class: "try-check" }, "Same as the reference output ", link, ": every field, numbers to 1e-9."));
      } else {
        kids.push(el("p", { class: "try-check" }, "The expected outputs are for the date and searches the form opens with, so this result is not compared."));
      }
      if (result.status === "scored" && result.drivers.length) {
        kids.push(driversTable(result.drivers));
        const n = result.drivers.length;
        kids.push(el("p", { class: "try-note" }, n > SHOWN_DRIVERS
          ? `The top ${SHOWN_DRIVERS} of ${n} drivers. The whole result is below.`
          : `${n} driver${n === 1 ? "" : "s"}.`));
      }
      kids.push(el("details", { class: "try-json" }, el("summary", {}, "The whole result (JSON)"),
        el("pre", {}, el("code", {}, JSON.stringify(result, null, 2)))));
      out.replaceChildren(...kids);
    } catch (error) {
      out.replaceChildren(el("p", { class: "try-check is-different" }, `Could not run the scorer: ${error.message}`));
    }
  }

  form.addEventListener("change", run);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    run();
  });
  run();
}

// ---------------------------------------------------------------- send an example to the CDS Hooks service

function setUpLive() {
  const live = document.getElementById("cds-live");
  const select = document.getElementById("cds-example");
  const button = document.getElementById("cds-send");
  const status = document.getElementById("cds-status");
  const output = document.getElementById("cds-output");
  if (!live || !select || !button || !status || !output) return;
  live.hidden = false;
  button.addEventListener("click", async () => {
    const name = select.value;
    status.textContent = `Sending ${name}.json...`;
    output.replaceChildren();
    try {
      const body = JSON.stringify(await getJson(`/developers/examples/${encodeURIComponent(name)}.json`));
      const response = await fetch(SERVICE_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body });
      const text = await response.text();
      let answer = null;
      try {
        answer = JSON.parse(text);
      } catch {
        // not JSON: no CDS Hooks service answered
      }
      if (!response.ok || !answer || !Array.isArray(answer.cards)) {
        status.textContent = `HTTP ${response.status}: no CDS Hooks answer. The service runs where the site's Pages Functions are deployed, not on a static file server.`;
        return;
      }
      const documented = await getJson(`/developers/examples/responses/${encodeURIComponent(name)}.json`);
      const diff = firstDifference(answer, documented);
      const n = answer.cards.length;
      status.textContent = `HTTP ${response.status}: ${n} card${n === 1 ? "" : "s"}. ${diff ? `Differs from the documented response at ${diff}.` : "Same as the documented response."}`;
      output.replaceChildren(el("div", { class: "code code-wrap" },
        el("div", { class: "code-head" }, el("span", {}, `Live response to ${name}.json`)),
        el("pre", {}, el("code", {}, JSON.stringify(answer, null, 2)))));
    } catch (error) {
      status.textContent = `The request failed: ${error.message}.`;
    }
  });
}

if (typeof document !== "undefined") {
  addCopyButtons();
  trackSections();
  setUpLive();
  setUpTry().catch(() => {});
}
