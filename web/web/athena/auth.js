const PREVIEW_FHIR_ORIGIN = "https://api.preview.platform.athenahealth.com";
const PRODUCTION_FHIR_ORIGIN = "https://api.platform.athenahealth.com";

export const ATHENA_AUTH_CONTEXT_PREFIX = "lupus-athena-auth:";
export const ATHENA_ACTIVE_STATE_KEY = "lupus-athena-active-state";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function base64UrlEncode(bytes) {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/u, "");
}

function base64UrlDecode(value) {
  assert(typeof value === "string" && /^[A-Za-z0-9_-]+$/u.test(value), "The ID token is malformed.");

  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/") + padding);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function decodeJsonPart(value) {
  try {
    return JSON.parse(new TextDecoder().decode(base64UrlDecode(value)));
  } catch {
    throw new Error("The ID token is malformed.");
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function validateAthenaFhirIssuer(value) {
  let url;

  try {
    url = new URL(value);
  } catch {
    throw new Error("athenaOne did not provide a valid FHIR issuer URL.");
  }

  const allowedOrigin =
    url.origin === PREVIEW_FHIR_ORIGIN || url.origin === PRODUCTION_FHIR_ORIGIN;
  const fhirR4Path = url.pathname === "/fhir/r4" || url.pathname.startsWith("/fhir/r4/");

  assert(
    url.protocol === "https:" && allowedOrigin && fhirR4Path && !url.username && !url.password && !url.hash,
    "This launch did not come from an athenaOne Preview or Production FHIR R4 endpoint.",
  );

  return url.href.replace(/\/$/u, "");
}

export function readAthenaLaunch(urlValue) {
  const url = new URL(urlValue);
  const issuer = url.searchParams.get("iss");
  const launch = url.searchParams.get("launch");

  assert(issuer, "No FHIR issuer was supplied. Launch this app from athenaOne.");
  assert(launch, "No launch context was supplied. Launch this app from an athenaOne patient chart.");

  return {
    issuer: validateAthenaFhirIssuer(issuer),
    launch,
  };
}

export function validateAthenaConfig(config) {
  const clientId = config?.clientId?.trim();
  const scope = config?.scope?.trim();

  assert(
    clientId && clientId !== "REPLACE_WITH_YOUR_ATHENA_CLIENT_ID",
    "Set the athenaOne client ID in athena/config.js before launching the app.",
  );
  assert(scope, "Set the approved OAuth scopes in athena/config.js.");

  const scopes = new Set(scope.split(/\s+/u));
  assert(scopes.has("launch"), "The athenaOne scope must include launch.");
  assert(scopes.has("openid"), "The athenaOne scope must include openid.");
  assert(
    [...scopes].some((candidate) => /^(?:patient|user)\/Patient\.(?:read|r|rs)$/u.test(candidate)),
    "The athenaOne scope must include approved read access to the launched Patient.",
  );

  return { clientId, scope: [...scopes].join(" ") };
}

export function randomValue(byteLength = 32, cryptoObject = globalThis.crypto) {
  assert(cryptoObject?.getRandomValues, "Secure browser randomness is unavailable.");
  const bytes = new Uint8Array(byteLength);
  cryptoObject.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

export async function fetchSmartConfiguration(issuer, fetchImpl = globalThis.fetch) {
  const response = await fetchImpl(`${issuer}/.well-known/smart-configuration`, {
    headers: { Accept: "application/json" },
    credentials: "omit",
  });

  assert(response.ok, `athenaOne SMART discovery failed with HTTP ${response.status}.`);
  const configuration = await response.json();
  assert(isPlainObject(configuration), "athenaOne returned invalid SMART configuration.");
  assert(typeof configuration.issuer === "string", "athenaOne SMART configuration has no OpenID issuer.");

  const openIdIssuer = new URL(configuration.issuer);
  assert(
    openIdIssuer.protocol === "https:" && openIdIssuer.hostname === "athena.okta.com",
    "athenaOne returned an unexpected OpenID issuer.",
  );

  return configuration;
}

export function saveAuthorizationContext(storage, state, context) {
  storage.setItem(`${ATHENA_AUTH_CONTEXT_PREFIX}${state}`, JSON.stringify(context));
  storage.setItem(ATHENA_ACTIVE_STATE_KEY, state);
}

export function loadAuthorizationContext(storage, callbackState) {
  const activeState = storage.getItem(ATHENA_ACTIVE_STATE_KEY);
  const state = callbackState || activeState;

  assert(state, "No athenaOne authorization state was found. Relaunch the app from athenaOne.");
  assert(
    !callbackState || !activeState || callbackState === activeState,
    "The athenaOne authorization state does not match this browser session.",
  );

  const serialized = storage.getItem(`${ATHENA_AUTH_CONTEXT_PREFIX}${state}`);
  assert(serialized, "The athenaOne authorization session has expired. Relaunch the app.");

  let context;
  try {
    context = JSON.parse(serialized);
  } catch {
    throw new Error("The saved athenaOne authorization session is invalid. Relaunch the app.");
  }

  assert(isPlainObject(context), "The saved athenaOne authorization session is invalid. Relaunch the app.");
  return { state, context };
}

async function fetchOpenIdMetadata(expectedIssuer, fetchImpl) {
  const issuerUrl = new URL(expectedIssuer);
  assert(
    issuerUrl.protocol === "https:" && issuerUrl.hostname === "athena.okta.com",
    "The saved athenaOne OpenID issuer is invalid.",
  );

  const response = await fetchImpl(
    `${expectedIssuer.replace(/\/$/u, "")}/.well-known/openid-configuration`,
    { headers: { Accept: "application/json" }, credentials: "omit" },
  );
  assert(response.ok, `OpenID discovery failed with HTTP ${response.status}.`);

  const metadata = await response.json();
  assert(isPlainObject(metadata), "athenaOne returned invalid OpenID configuration.");
  assert(
    metadata.issuer === expectedIssuer,
    "The OpenID issuer does not match the SMART configuration.",
  );

  const jwksUrl = new URL(metadata.jwks_uri);
  assert(
    jwksUrl.protocol === "https:" && jwksUrl.origin === issuerUrl.origin,
    "athenaOne returned an unexpected signing-key URL.",
  );

  return { metadata, jwksUrl };
}

function validateClaims(payload, { clientId, issuer, nonce, nowSeconds }) {
  assert(
    typeof payload.iss === "string" && payload.iss === issuer,
    "The ID token issuer is invalid.",
  );

  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  assert(audiences.includes(clientId), "The ID token was issued for a different client.");
  if (audiences.length > 1) {
    assert(payload.azp === clientId, "The ID token authorized party is invalid.");
  }
  if (payload.azp !== undefined) {
    assert(payload.azp === clientId, "The ID token authorized party is invalid.");
  }

  assert(payload.nonce === nonce, "The ID token nonce does not match this launch.");
  assert(typeof payload.sub === "string" && payload.sub, "The ID token has no subject.");
  assert(typeof payload.exp === "number" && payload.exp > nowSeconds - 60, "The ID token has expired.");
  assert(typeof payload.iat === "number", "The ID token has no issued-at time.");
  assert(payload.iat <= nowSeconds + 60, "The ID token was issued in the future.");

  if (typeof payload.nbf === "number") {
    assert(payload.nbf <= nowSeconds + 60, "The ID token is not valid yet.");
  }
}

export async function verifyAthenaIdToken({
  idToken,
  clientId,
  issuer,
  nonce,
  fetchImpl = globalThis.fetch,
  cryptoObject = globalThis.crypto,
  nowSeconds = Math.floor(Date.now() / 1000),
}) {
  assert(typeof idToken === "string", "athenaOne did not return the required ID token.");
  assert(cryptoObject?.subtle, "Browser cryptography is unavailable.");

  const parts = idToken.split(".");
  assert(parts.length === 3, "The ID token is malformed.");

  const header = decodeJsonPart(parts[0]);
  const payload = decodeJsonPart(parts[1]);
  assert(isPlainObject(header) && isPlainObject(payload), "The ID token is malformed.");
  assert(header.alg === "RS256" && typeof header.kid === "string", "The ID token uses an unsupported signature.");

  const { jwksUrl } = await fetchOpenIdMetadata(issuer, fetchImpl);
  const jwksResponse = await fetchImpl(jwksUrl.href, {
    headers: { Accept: "application/json" },
    credentials: "omit",
  });
  assert(jwksResponse.ok, `OpenID signing-key retrieval failed with HTTP ${jwksResponse.status}.`);

  const jwks = await jwksResponse.json();
  const keys = Array.isArray(jwks?.keys) ? jwks.keys : [];
  const signingKey = keys.find(
    (key) =>
      key?.kid === header.kid &&
      key?.kty === "RSA" &&
      (!key.alg || key.alg === "RS256") &&
      (!key.use || key.use === "sig"),
  );
  assert(signingKey, "No matching athenaOne ID-token signing key was found.");

  const key = await cryptoObject.subtle.importKey(
    "jwk",
    signingKey,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const validSignature = await cryptoObject.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    base64UrlDecode(parts[2]),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
  );
  assert(validSignature, "The athenaOne ID-token signature is invalid.");

  validateClaims(payload, { clientId, issuer, nonce, nowSeconds });
  return payload;
}
