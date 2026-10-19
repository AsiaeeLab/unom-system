import { epicConfig } from "./config.js";

const CLIENT_ID_PLACEHOLDER = "REPLACE_WITH_YOUR_EPIC_NON_PRODUCTION_CLIENT_ID";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

export function validateEpicFhirIssuer(value, allowedIssuers = epicConfig.allowedIssuers) {
  let url;

  try {
    url = new URL(value);
  } catch {
    throw new Error("Epic did not provide a valid FHIR issuer URL.");
  }

  assert(
    url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash,
    "The Epic FHIR issuer URL is not permitted.",
  );

  const normalized = url.href.replace(/\/$/u, "");
  assert(
    allowedIssuers.includes(normalized),
    "This launch did not come from an approved Epic FHIR endpoint.",
  );
  return normalized;
}

export function readEpicLaunch(urlValue, allowedIssuers = epicConfig.allowedIssuers) {
  const url = new URL(urlValue);
  const issuer = url.searchParams.get("iss");
  const launch = url.searchParams.get("launch");

  assert(issuer, "No FHIR issuer was supplied. Launch this app from Epic LaunchPad or an Epic patient chart.");
  assert(launch, "No launch context was supplied. Launch this app from an Epic patient chart.");

  return {
    issuer: validateEpicFhirIssuer(issuer, allowedIssuers),
    launch,
  };
}

export function validateEpicConfig(config = epicConfig) {
  const clientId = config?.clientId?.trim();
  const scope = config?.scope?.trim();
  const allowedIssuers = Array.isArray(config?.allowedIssuers)
    ? [...config.allowedIssuers]
    : [];

  assert(
    clientId && clientId !== CLIENT_ID_PLACEHOLDER,
    "Epic registration is not configured yet. Add the non-production client ID issued for this callback.",
  );
  assert(scope, "Set the approved Epic OAuth scopes.");
  assert(allowedIssuers.length, "Configure at least one approved Epic FHIR issuer.");

  const scopes = new Set(scope.split(/\s+/u));
  for (const required of ["launch", "openid", "fhirUser"]) {
    assert(scopes.has(required), `The Epic scope must include ${required}.`);
  }
  const normalizedIssuers = allowedIssuers.map((issuer) =>
    validateEpicFhirIssuer(issuer, allowedIssuers),
  );

  return {
    clientId,
    scope: [...scopes].join(" "),
    allowedIssuers: normalizedIssuers,
  };
}
