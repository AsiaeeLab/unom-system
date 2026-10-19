import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { SMART_SANDBOX_PATIENT_IDS, SMART_SANDBOX_PRACTITIONER, smartLauncherUrl } from "../web/smart/launcher-url.js";

test("SMART launcher preselects every synthetic test-vector patient", () => {
  const bundleIds = readdirSync(new URL("../../model/test_vectors/bundles/", import.meta.url))
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.replace(/\.json$/u, ""))
    .sort();
  assert.deepEqual(SMART_SANDBOX_PATIENT_IDS, bundleIds);

  const url = new URL(smartLauncherUrl("https://preview.undiagnosednomore.pages.dev/smart/"));
  assert.equal(url.origin, "https://launch.smarthealthit.org");
  assert.equal(url.searchParams.get("launch_url"), "https://preview.undiagnosednomore.pages.dev/smart/");
  assert.equal(url.searchParams.get("fhir_version"), "r4");
  const state = JSON.parse(atob(url.searchParams.get("launch")));
  assert.equal(state.length, 17);
  assert.equal(state[1], bundleIds.join(","), "every test patient in the picker");
  assert.equal(state[2], SMART_SANDBOX_PRACTITIONER, "a preset sandbox practitioner");
  assert.equal(state[4], 1, "skip the simulated practitioner login");
  assert.equal(state[15], 2, "PKCE required");
});
