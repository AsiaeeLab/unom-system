// docs/CLINICIAN_INTERFACE.md is generated from the model files, cards, rules, and patient questions.
// It is the interface between the models and the front end, so it must never go stale.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("docs/CLINICIAN_INTERFACE.md matches the files it is generated from", () => {
  const r = spawnSync("python3", ["analysis/build_clinician_interface.py", "--check"], { cwd: REPO, stdio: "pipe" });
  assert.equal(r.status, 0, String(r.stderr || r.error || r.stdout));
  assert.ok(!r.error || r.error.code === "EPERM", String(r.error));
  assert.match(String(r.stdout), /docs\/CLINICIAN_INTERFACE\.md is up to date/u);

});
