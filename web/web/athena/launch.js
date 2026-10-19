import { athenaConfig } from "./config.js";
import {
  ATHENA_AUTH_CONTEXT_PREFIX,
  fetchSmartConfiguration,
  randomValue,
  readAthenaLaunch,
  saveAuthorizationContext,
  validateAthenaConfig,
} from "./auth.js";

function fail(error, documentObject = document) {
  const message = error instanceof Error ? error.message : String(error);
  const statusElement = documentObject.getElementById("launch-status");
  statusElement.textContent = `Authorization could not start: ${message}`;
  statusElement.classList.add("launch-error");
  documentObject.querySelector("progress")?.setAttribute("hidden", "");
}

export async function startAuthorization({
  browserWindow = globalThis.window,
  config = athenaConfig,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!browserWindow?.FHIR?.oauth2) {
    throw new Error("the SMART client library could not be loaded");
  }

  const { clientId, scope } = validateAthenaConfig(config);
  const { issuer } = readAthenaLaunch(browserWindow.location.href);
  const smartConfiguration = await fetchSmartConfiguration(issuer, fetchImpl);
  const state = randomValue();
  const nonce = randomValue();
  const redirectUri = new URL("./", browserWindow.location.href).href;

  saveAuthorizationContext(browserWindow.sessionStorage, state, {
    clientId,
    issuer,
    nonce,
    openIdIssuer: smartConfiguration.issuer,
    redirectUri,
  });

  let authorizationUrl;
  try {
    authorizationUrl = await browserWindow.FHIR.oauth2.authorize({
      clientId,
      scope,
      redirectUri,
      pkceMode: "required",
      stateKey: state,
      completeInTarget: true,
      noRedirect: true,
    });
  } catch (error) {
    browserWindow.sessionStorage.removeItem(`${ATHENA_AUTH_CONTEXT_PREFIX}${state}`);
    throw error;
  }

  if (!authorizationUrl) {
    throw new Error("the SMART client did not create an authorization URL");
  }

  const url = new URL(authorizationUrl);
  url.searchParams.set("nonce", nonce);
  browserWindow.location.assign(url.href);
}

if (typeof window !== "undefined" && typeof document !== "undefined") {
  startAuthorization().catch((error) => fail(error));
}
