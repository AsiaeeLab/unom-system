const CLIENT_ID = "undiagnosednomore-lupus";
const SCOPE = "launch openid fhirUser patient/*.read";
const ALLOWED_ISSUER = "launch.smarthealthit.org";

function fail(error) {
  document.getElementById("launch-status").textContent =
    "Authorization could not start. Return to the SMART launcher and try again.";
  document.querySelector("progress")?.setAttribute("hidden", "");
  if (error instanceof Error && error.name === "SecurityError") {
    document.getElementById("launch-status").textContent = "The browser blocked session storage, which the secure launch needs. Allow site data for this page and try again.";
  }
}

function openLauncher(url) {
  window.location.replace(smartLauncherUrl(`${url.origin}${url.pathname}`));
}

function clearAthenaSession() {
  for (let index = window.sessionStorage.length - 1; index >= 0; index -= 1) {
    const key = window.sessionStorage.key(index);
    if (key === "lupus-athena-active-state" || key?.startsWith("lupus-athena-auth:")) {
      window.sessionStorage.removeItem(key);
    }
  }
}

async function start() {
  const url = new URL(window.location.href);
  const issuer = url.searchParams.get("iss");
  const launch = url.searchParams.get("launch");

  if (!issuer && !launch) {
    openLauncher(url);
    return;
  }
  if (!issuer || !launch) {
    throw new Error("Incomplete SMART launch context.");
  }
  const issuerUrl = new URL(issuer);
  if (issuerUrl.protocol !== "https:" || issuerUrl.hostname !== ALLOWED_ISSUER) {
    throw new Error("Unexpected SMART issuer.");
  }
  if (!window.FHIR?.oauth2) {
    throw new Error("The SMART client library could not be loaded.");
  }

  clearAthenaSession();
  await window.FHIR.oauth2.authorize({
    clientId: CLIENT_ID,
    scope: SCOPE,
    redirectUri: new URL("callback.html", url).href,
    pkceMode: "required",
  });
}

start().catch(fail);
import { smartLauncherUrl } from "./launcher-url.js";
