// The SMART path (fhir-data.js reading a FHIR server, then the shared dashboard) must show every synthetic test
// patient as the clinician demo does. Offline: an in-memory server that pages and orders results like the SMART
// sandbox (HAPI) stands in for the network; the uploader writes the shifted charts with --write-dir.

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chronological, loadPatientRecord, SEARCHES, validateNextUrl } from "../web/athena/fhir-data.js";
import { SMART_SANDBOX_PATIENT_IDS } from "../web/smart/launcher-url.js";
import {
  comparePatient, DEMO_AS_OF, demoDashboard, differences, digest, httpClient, KNOWN_DIFFERENCES, loadSiteModels,
  memoryClient, offlineResources, smartDashboard, sourceResources,
} from "../tools/smart-parity.mjs";
import { QUESTIONNAIRES_DIR, questionnaireFiles } from "../tools/write-demo-questionnaires.mjs";

const inputs = loadSiteModels();
const UPLOADER = new URL("../../model/test_vectors/upload_sandbox.py", import.meta.url).pathname;
const SIM = "https://launch.smarthealthit.org/v/r4/sim/eyJwYXRpZW50IjoibWFyaWEifQ==/fhir";

test("next-page links from the SMART sandbox (HAPI _getpages on the base path) are followed", () => {
  const next = `${SIM}?_getpages=04dff72e&_getpagesoffset=2&_count=2&_bundletype=searchset`;
  assert.equal(validateNextUrl(next, SIM), next);
  assert.equal(validateNextUrl(`${SIM}/Condition?patient=maria&page=2`, SIM), `${SIM}/Condition?patient=maria&page=2`);
  assert.equal(validateNextUrl("Condition?patient=maria&page=2", `${SIM}/`), `${SIM}/Condition?patient=maria&page=2`);
  for (const unsafe of [
    "https://launch.smarthealthit.org/v/r4/sim/eyJwYXRpZW50IjoibWFyaWEifQ==/fhirx?_getpages=1",
    "https://launch.smarthealthit.org/v/r4/sim/other/fhir?_getpages=1",
    "https://launch.smarthealthit.org/v/r4?_getpages=1",
    "https://example.org/v/r4/sim/eyJwYXRpZW50IjoibWFyaWEifQ==/fhir?_getpages=1",
    "http://launch.smarthealthit.org/v/r4/sim/eyJwYXRpZW50IjoibWFyaWEifQ==/fhir?_getpages=1",
  ]) {
    assert.throws(() => validateNextUrl(unsafe, SIM), /unsafe pagination URL/u, unsafe);
  }
});

test("a chart larger than one page is read in full", async () => {
  const resources = sourceResources("sofia");
  const record = await loadPatientRecord(memoryClient(resources, "sofia", { serverUrl: SIM, pageSize: 2 }));
  for (const type of ["Condition", "Observation", "Encounter", "MedicationRequest", "Procedure", "QuestionnaireResponse"]) {
    assert.equal(record.resources[type].length, resources.filter((r) => r.resourceType === type).length, type);
  }
  assert.ok(record.access.every((a) => a.status === "Available"), JSON.stringify(record.access));
});

test("records come back oldest first and in a fixed type order, whatever order the server uses", async () => {
  assert.deepEqual(
    chronological([
      { id: "c-10", onsetDateTime: "2024-01-02" },
      { id: "c-9" },
      { id: "c-2", onsetDateTime: "2024-01-02" },
      { id: "c-1", recordedDate: "2023-05-01T10:00:00Z" },
    ]).map((r) => r.id),
    ["c-1", "c-2", "c-10", "c-9"],
  );
  const record = await loadPatientRecord(memoryClient(sourceResources("elena"), "elena"));
  assert.deepEqual(Object.keys(record.resources), ["Patient", ...SEARCHES.map((s) => s.resourceType), "Binary"]);
  assert.deepEqual(record.access.map((a) => a.resourceType), ["Patient", ...SEARCHES.map((s) => s.resourceType), "Note content"]);
  const conditions = record.resources.Condition.map((r) => r.onsetDateTime);
  assert.deepEqual(conditions, [...conditions].sort());
});

test("note texts keep the order of their documents, not the order the downloads finish", async () => {
  const subject = { reference: "Patient/p1" };
  const resources = [
    { resourceType: "Patient", id: "p1" },
    ...[1, 2, 3, 4].map((n) => ({
      resourceType: "DocumentReference",
      id: `doc-${n}`,
      subject,
      date: `2024-0${n}-01`,
      content: [{ attachment: { contentType: "text/plain", url: `Binary/b${n}` } }],
    })),
    ...[1, 2, 3, 4].map((n) => ({ resourceType: "Binary", id: `b${n}`, contentType: "text/plain", data: btoa(`note ${n}`) })),
  ];
  const server = memoryClient(resources, "p1");
  // the first document's text arrives last
  const slow = { ...server, request: async (url) => {
    const n = /Binary\/b(\d)/u.exec(url)?.[1];
    if (n) await new Promise((done) => setTimeout(done, 40 - 10 * Number(n)));
    return server.request(url);
  } };
  const record = await loadPatientRecord(slow);
  assert.deepEqual(record.notes.map((note) => note.text), ["note 1", "note 2", "note 3", "note 4"]);
});

test("read through fhir-data.js, every unshifted test chart shows exactly what the demo shows", async () => {
  // no date shift, so this isolates the reading path: searches, paging, server order, the chart's own answers
  for (const id of SMART_SANDBOX_PATIENT_IDS) {
    const record = await loadPatientRecord(memoryClient(sourceResources(id), id, { pageSize: 3 }));
    const diff = differences(digest(demoDashboard(id, inputs), DEMO_AS_OF), digest(smartDashboard(record, DEMO_AS_OF, inputs), DEMO_AS_OF));
    assert.deepEqual(diff, [], id);
  }
});

test("the questionnaire answers the uploader adds are the demo's answers", () => {
  for (const file of questionnaireFiles()) {
    assert.equal(readFileSync(join(QUESTIONNAIRES_DIR, file.name), "utf8"), file.text, `${file.name} is stale: run node web/tools/write-demo-questionnaires.mjs`);
  }
});

test("the http client resolves relative URLs and reports HTTP status as fhirclient does", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return url.endsWith("/Patient/maria")
      ? { ok: true, json: async () => ({ resourceType: "Patient", id: "maria" }) }
      : { ok: false, status: 404, json: async () => ({}) };
  };
  const client = httpClient(`${SIM}/`, "maria", { fetchImpl });
  assert.deepEqual(await client.patient.read(), { resourceType: "Patient", id: "maria" });
  await assert.rejects(client.request("Goal?patient=maria"), (error) => error.status === 404);
  assert.deepEqual(calls, [`${SIM}/Patient/maria`, `${SIM}/Goal?patient=maria`]);
});

test("every chart the uploader shifts matches the demo on the upload date and stays valid for 90 days", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "unom-smart-"));
  try {
    const run = spawnSync("python3", [UPLOADER, "--dry-run", "--as-of", "2026-10-13", "--write-dir", dir], { encoding: "utf8" });
    if (run.error) {
      t.skip("python3 is not available");
      return;
    }
    assert.equal(run.status, 0, run.stderr);
    const resources = offlineResources(dir);
    for (const id of SMART_SANDBOX_PATIENT_IDS) {
      const r = await comparePatient(id, memoryClient(resources, id, { pageSize: 4 }), { asOf: "2026-10-13", maxDays: 90, inputs, evidenceScan: false });
      assert.equal(r.anchor, "2026-10-13", id);
      assert.deepEqual(r.atAnchor, [], id);
      assert.deepEqual(r.changes, [], id);
      assert.deepEqual(r.inventory, { extra: [], missing: [] }, id);
      assert.ok(r.unshifted.every((u) => u.expected), `${id}: ${JSON.stringify(r.unshifted)}`);
      assert.equal(r.known.length, (KNOWN_DIFFERENCES[id] || []).length, id);
      assert.equal(r.valid.days, 90, `${id} changes on ${r.valid.breaksOn}: ${JSON.stringify(r.valid.why)}`);
      assert.ok(r.ok, id);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a search that returns fewer records than its total is unavailable, never a short list", async () => {
  const server = memoryClient(sourceResources("sofia"), "sofia", { pageSize: 2 });
  // the server stops paging early: the first Condition page drops its next link
  const short = { ...server, request: async (url) => {
    const page = await server.request(url);
    if (/Condition\?/u.test(url) && page.resourceType === "Bundle") return { ...page, link: page.link.filter((l) => l.relation !== "next") };
    return page;
  } };
  const record = await loadPatientRecord(short);
  const condition = record.access.find((a) => a.resourceType === "Condition");
  assert.notEqual(condition.status, "Available", JSON.stringify(condition));
  assert.ok(record.access.filter((a) => a.resourceType !== "Condition").every((a) => a.status === "Available"));
});
