import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { EPIC_SANDBOX_FHIR_ISSUER } from "../web/epic/config.js";
import {
  readEpicLaunch,
  validateEpicConfig,
  validateEpicFhirIssuer,
} from "../web/epic/issuer.js";
import { startEpicAuthorization } from "../web/epic/launch.js";

test("Epic issuer validation accepts only the configured R4 sandbox issuer", () => {
  assert.equal(validateEpicFhirIssuer(EPIC_SANDBOX_FHIR_ISSUER), EPIC_SANDBOX_FHIR_ISSUER);
  assert.equal(validateEpicFhirIssuer(`${EPIC_SANDBOX_FHIR_ISSUER}/`), EPIC_SANDBOX_FHIR_ISSUER);

  for (const value of [
    "http://fhir.epic.com/interconnect-fhir-oauth/api/FHIR/R4",
    "https://fhir.epic.com.evil.example/interconnect-fhir-oauth/api/FHIR/R4",
    "https://user@fhir.epic.com/interconnect-fhir-oauth/api/FHIR/R4",
    "https://fhir.epic.com/interconnect-fhir-oauth/api/FHIR/R4?next=1",
    "https://fhir.epic.com/interconnect-fhir-oauth/api/FHIR/R4#fragment",
    "https://fhir.epic.com/interconnect-fhir-oauth/api/FHIR/STU3",
  ]) {
    assert.throws(() => validateEpicFhirIssuer(value), /Epic FHIR issuer|approved Epic/u);
  }
});

test("Epic launch requires both issuer and opaque launch context", () => {
  const url = new URL("https://undiagnosednomore.org/epic/");
  url.searchParams.set("iss", EPIC_SANDBOX_FHIR_ISSUER);
  url.searchParams.set("launch", "opaque-launch-token");
  assert.deepEqual(readEpicLaunch(url.href), {
    issuer: EPIC_SANDBOX_FHIR_ISSUER,
    launch: "opaque-launch-token",
  });

  url.searchParams.delete("launch");
  assert.throws(() => readEpicLaunch(url.href), /No launch context/u);
  url.searchParams.delete("iss");
  assert.throws(() => readEpicLaunch(url.href), /No FHIR issuer/u);
});

test("Epic configuration requires an issued client ID and launch scopes", () => {
  assert.throws(
    () => validateEpicConfig({
      clientId: "REPLACE_WITH_YOUR_EPIC_NON_PRODUCTION_CLIENT_ID",
      scope: "launch openid fhirUser",
      allowedIssuers: [EPIC_SANDBOX_FHIR_ISSUER],
    }),
    /registration is not configured/u,
  );
  assert.throws(
    () => validateEpicConfig({
      clientId: "issued-client-id",
      scope: "openid fhirUser",
      allowedIssuers: [EPIC_SANDBOX_FHIR_ISSUER],
    }),
    /must include launch/u,
  );
  assert.equal(
    validateEpicConfig({
      clientId: "issued-client-id",
      scope: "launch openid fhirUser",
      allowedIssuers: [EPIC_SANDBOX_FHIR_ISSUER],
    }).clientId,
    "issued-client-id",
  );
});

test("Epic launcher uses the exact callback and required PKCE", async () => {
  const authorizeCalls = [];
  const storage = {
    length: 0,
    key: () => null,
    removeItem: () => {},
  };
  const launchUrl = new URL("https://undiagnosednomore.org/epic/");
  launchUrl.searchParams.set("iss", EPIC_SANDBOX_FHIR_ISSUER);
  launchUrl.searchParams.set("launch", "opaque-launch-token");
  const browserWindow = {
    location: { href: launchUrl.href },
    sessionStorage: storage,
    FHIR: {
      oauth2: {
        authorize: async (options) => authorizeCalls.push(options),
      },
    },
  };

  await startEpicAuthorization({
    browserWindow,
    config: {
      clientId: "issued-client-id",
      scope: "launch openid fhirUser",
      allowedIssuers: [EPIC_SANDBOX_FHIR_ISSUER],
    },
  });

  assert.deepEqual(authorizeCalls, [{
    clientId: "issued-client-id",
    scope: "launch openid fhirUser",
    redirectUri: "https://undiagnosednomore.org/epic/callback.html",
    pkceMode: "required",
    iss: EPIC_SANDBOX_FHIR_ISSUER,
  }]);
});

test("Epic routes reuse the clinical app and have isolated security policy", () => {
  const launch = readFileSync(new URL("../web/epic/index.html", import.meta.url), "utf8");
  const callback = readFileSync(new URL("../web/epic/callback.html", import.meta.url), "utf8");
  const app = readFileSync(new URL("../web/athena/app.js", import.meta.url), "utf8");
  const headers = readFileSync(new URL("../web/_headers", import.meta.url), "utf8");

  assert.match(launch, /src="launch\.js"/u);
  assert.match(callback, /src="\.\.\/athena\/app\.js"/u);
  assert.match(app, /validateEpicFhirIssuer/u);
  assert.match(app, /Epic Sandbox/u);
  assert.match(headers, /\/epic\/\*[\s\S]*connect-src 'self' https:\/\/fhir\.epic\.com/u);
  assert.match(headers, /\/epic\/\*[\s\S]*! X-Frame-Options/u);
  assert.match(headers, /\/epic\/\*[\s\S]*frame-ancestors https:\/\/fhir\.epic\.com https:\/\/open\.epic\.com/u);
  assert.match(headers, /\/epic\/\*[\s\S]*Cache-Control: no-store/u);
  assert.match(headers, /\/epic\/\*[\s\S]*X-Robots-Tag: noindex, nofollow/u);
});
