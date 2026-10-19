// POST /cds-services/invisible-illness: the patient-view hook.
// Stateless: builds a FHIR bundle from prefetch, scores it with the shared scorer, returns cards.
// Request bodies are never logged or stored.
import { scoreBundle } from "../../web/shared/scorer.js";
import longcovid from "../../web/models/longcovid.json" with { type: "json" };
import chronicfatigue from "../../web/models/chronicfatigue.json" with { type: "json" };
import fibromyalgia from "../../web/models/fibromyalgia.json" with { type: "json" };
import endometriosis from "../../web/models/endometriosis.json" with { type: "json" };
import lyme from "../../web/models/lyme.json" with { type: "json" };
import lupus from "../../web/models/lupus.json" with { type: "json" };
import migraine from "../../web/models/migraine.json" with { type: "json" };
import depression from "../../web/models/depression.json" with { type: "json" };
import anxiety from "../../web/models/anxiety.json" with { type: "json" };
// Configuration (Cloudflare Pages environment variables):
//   CDS_FHIR_SERVER_ALLOWLIST  https URL prefixes the prefetch fallback may call with the bearer token,
//                              comma- or space-separated; unset: the synthetic SMART Health IT sandbox only;
//                              set to an empty string: no fallback at all.
// The service does not authenticate callers (see web/README.md, "CDS Hooks service"); it is a prototype for
// synthetic data.
import { handleHook, jsonResponse, parseAllowList, preflightResponse } from "./_cds.js";

export const MODELS = Object.freeze([longcovid, chronicfatigue, fibromyalgia, endometriosis, lyme, lupus, migraine, depression, anxiety]);

export async function respond(body, options = {}) {
  const [status, payload] = await handleHook(body, {
    models: MODELS,
    score: scoreBundle,
    fetchImpl: globalThis.fetch?.bind(globalThis),
    allowList: parseAllowList(undefined),
    ...options,
  });
  return jsonResponse(payload, status);
}

export async function onRequestPost({ request, env }) {
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "request body must be JSON" }, 400);
  }
  try {
    return await respond(body, { allowList: parseAllowList(env?.CDS_FHIR_SERVER_ALLOWLIST) });
  } catch {
    return jsonResponse({ error: "the service could not process this request" }, 500);
  }
}

export function onRequestOptions() {
  return preflightResponse();
}

export function onRequestGet() {
  return jsonResponse({ error: "use POST with a CDS Hooks request; discovery is at /cds-services" }, 405, {
    Allow: "POST, OPTIONS",
  });
}
