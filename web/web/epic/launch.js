import { epicConfig } from "./config.js";
import { readEpicLaunch, validateEpicConfig } from "./issuer.js";

function fail(error, documentObject = document) {
  const message = error instanceof Error ? error.message : String(error);
  const statusElement = documentObject.getElementById("launch-status");
  statusElement.textContent = `Authorization could not start: ${message}`;
  statusElement.classList.add("launch-error");
  documentObject.querySelector("progress")?.setAttribute("hidden", "");
}

function clearOtherLaunchSessions(storage) {
  for (let index = storage.length - 1; index >= 0; index -= 1) {
    const key = storage.key(index);
    if (key === "lupus-athena-active-state" || key?.startsWith("lupus-athena-auth:")) {
      storage.removeItem(key);
    }
  }
}

export async function startEpicAuthorization({
  browserWindow = globalThis.window,
  config = epicConfig,
} = {}) {
  const { issuer } = readEpicLaunch(browserWindow.location.href, config.allowedIssuers);
  const { clientId, scope } = validateEpicConfig(config);

  if (!browserWindow?.FHIR?.oauth2) {
    throw new Error("the SMART client library could not be loaded");
  }

  clearOtherLaunchSessions(browserWindow.sessionStorage);
  await browserWindow.FHIR.oauth2.authorize({
    clientId,
    scope,
    redirectUri: new URL("callback.html", browserWindow.location.href).href,
    pkceMode: "required",
    iss: issuer,
  });
}

if (typeof window !== "undefined" && typeof document !== "undefined") {
  startEpicAuthorization().catch((error) => fail(error));
}
