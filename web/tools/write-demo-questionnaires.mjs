#!/usr/bin/env node
// Writes the patient app answers that the clinician demo attaches to its four personas (shared/demo-answers.js)
// as FHIR QuestionnaireResponses in model/test_vectors/questionnaires/<persona>.json. The sandbox uploader
// (model/test_vectors/upload_sandbox.py) adds them to those patients' charts, so a SMART launch shows the same
// patient-reported answers as the demo. web/test/smart-parity.test.js fails when the files are stale.
//
//   node web/tools/write-demo-questionnaires.mjs

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { demoQuestionnaire, PATIENTS } from "../web/clinician/demo.js";

export const QUESTIONNAIRES_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "model", "test_vectors", "questionnaires");

/** The demo answers for one persona as a chart resource: the demo's QuestionnaireResponse with an id and subject. */
export function chartQuestionnaire(persona) {
  const { resourceType, ...rest } = demoQuestionnaire(persona);
  return { resourceType, id: `${persona}-qr-1`, ...rest, subject: { reference: `Patient/${persona}` } };
}

export function questionnaireFiles() {
  return PATIENTS.map((p) => ({ name: `${p.id}.json`, text: `${JSON.stringify(chartQuestionnaire(p.id), null, 1)}\n` }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  mkdirSync(QUESTIONNAIRES_DIR, { recursive: true });
  for (const file of questionnaireFiles()) writeFileSync(join(QUESTIONNAIRES_DIR, file.name), file.text);
  console.log(`wrote ${PATIENTS.length} questionnaire responses to ${QUESTIONNAIRES_DIR}`);
}
