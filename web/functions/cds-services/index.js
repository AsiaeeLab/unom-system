// GET /cds-services: CDS Hooks discovery.
import { DISCOVERY, jsonResponse, preflightResponse } from "./_cds.js";

export function onRequestGet() {
  return jsonResponse(DISCOVERY);
}

export function onRequestOptions() {
  return preflightResponse();
}
