import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../web/athena/index.html", import.meta.url), "utf8");

test("technical retrieval detail is collapsed under Debug info", () => {
  const disclosure = html.match(/<details class="debug-panel"[^>]*>[\s\S]*?<\/details>/u)?.[0] || "";
  assert.match(disclosure, /<summary>[\s\S]*?Debug info[\s\S]*?<\/summary>/u);
  assert.doesNotMatch(disclosure, /<details[^>]*\sopen(?:\s|>)/u);
  assert.match(disclosure, /id="coverage-body"/u);
  assert.match(disclosure, /id="resource-count"/u);
  assert.match(disclosure, /id="coverage-value"/u);
  assert.match(disclosure, /id="debug-panel" hidden/u);
});

test("test diagnostics have an accessible explanation", () => {
  const explanations = html.match(/class="info-control"/gu) || [];
  assert.equal(explanations.length, 1);
  assert.match(html, /Testing only\. This section shows FHIR retrieval diagnostics/u);
});

test("legacy lupus pane is absent and debug visibility is local-only", () => {
  const app = readFileSync(new URL("../web/athena/app.js", import.meta.url), "utf8");
  assert.doesNotMatch(html, /Lupus evidence review/u);
  assert.doesNotMatch(app, /full lupus evidence review is below/u);
  assert.match(app, /\["localhost", "127\.0\.0\.1"\]\.includes\(window\.location\.hostname\)/u);
});

test("clinical header links to the public website without replacing the EHR app", () => {
  assert.match(html, /href="https:\/\/undiagnosednomore\.org\/"/u);
  assert.match(html, /target="_blank"/u);
  assert.match(html, /rel="noreferrer"/u);
});

test("clinician view omits the former method and coverage sections", () => {
  assert.doesNotMatch(html, />How the signal works</u);
  assert.doesNotMatch(html, />Record coverage</u);
  assert.doesNotMatch(html, /Unavailable types do not stop/u);
});
