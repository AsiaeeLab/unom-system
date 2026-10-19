import { loadPatientRecord } from "./fhir-data.js";
import {
  ATHENA_ACTIVE_STATE_KEY,
  loadAuthorizationContext,
  validateAthenaFhirIssuer,
  verifyAthenaIdToken,
} from "./auth.js";
import { validateEpicFhirIssuer } from "../epic/issuer.js";
import { loadLyme, loadModels, questionnaireFromRecord, recordToBundle, renderDashboard, TABS } from "./cards.js";

/** Today's date in the clinician's time zone (YYYY-MM-DD): the chart is scored as of the day the clinician sees. */
function localDate(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

let loadingView;
let resultView;
let errorView;
let dashboardView;

function tabFromHash() {
  const slug = window.location.hash.slice(1);
  return TABS.some((tab) => tab.slug === slug) ? slug : null;
}

function setTabHash(slug) {
  const url = new URL(window.location.href);
  url.hash = slug;
  window.history.replaceState(null, "", url);
}

async function ensureView() {
  if (!document.getElementById("loading-view")) {
    const response = await fetch(new URL("../athena/index.html", window.location.href), {
      credentials: "same-origin",
    });
    if (!response.ok) {
      throw new Error("The application view could not be loaded.");
    }
    const parsed = new DOMParser().parseFromString(await response.text(), "text/html");
    const shell = parsed.querySelector("main");
    if (!shell) {
      throw new Error("The application view could not be loaded.");
    }
    document.body.replaceChildren(document.importNode(shell, true));
  }

  loadingView = document.getElementById("loading-view");
  resultView = document.getElementById("result-view");
  errorView = document.getElementById("error-view");
}

function show(view) {
  for (const candidate of [loadingView, resultView, errorView]) {
    candidate.hidden = candidate !== view;
  }
}

function safeErrorMessage(error) {
  const message = error instanceof Error ? error.message : String(error);
  const allowed = [
    "SMART launch did not provide a patient context",
    "SMART client library could not be loaded",
    "authorized FHIR server does not match",
    "launch did not come from",
    "authorization session has expired",
    "authorization state does not match",
    "approved Epic FHIR endpoint",
    "ID token",
    "OpenID",
  ];
  return allowed.some((fragment) => message.includes(fragment))
    ? message
    : "The clinical record could not be loaded. Relaunch the app and confirm the approved FHIR permissions.";
}

function showError(error) {
  const message = document.getElementById("error-message");
  if (message && errorView) {
    message.textContent = safeErrorMessage(error);
    show(errorView);
    return;
  }
  document.body.textContent = safeErrorMessage(error);
}

function validateSmartSandboxIssuer(value) {
  const url = new URL(value);
  const valid =
    url.protocol === "https:" &&
    url.hostname === "launch.smarthealthit.org" &&
    /^\/v\/r4\/(?:sim\/[^/]+\/)?fhir\/?$/u.test(url.pathname);
  if (!valid) {
    throw new Error("This launch did not come from the approved SMART Health IT R4 launcher.");
  }
  return url.href.replace(/\/$/u, "");
}

function describeEnvironment(serverUrl) {
  const hostname = new URL(serverUrl).hostname;
  if (hostname === "launch.smarthealthit.org") {
    return "SMART Health IT";
  }
  if (hostname === "fhir.epic.com") {
    return "Epic Sandbox";
  }
  if (hostname === "api.preview.platform.athenahealth.com") {
    return "athenaOne Preview";
  }
  if (hostname === "api.platform.athenahealth.com") {
    return "athenaOne Production";
  }
  return "Connected FHIR server";
}

function validateExternalSmartIssuer(value) {
  try {
    return validateSmartSandboxIssuer(value);
  } catch {
    return validateEpicFhirIssuer(value);
  }
}

async function verifyLaunch(client) {
  const callbackState = new URL(window.location.href).searchParams.get("state");
  const activeAthenaState = window.sessionStorage.getItem(ATHENA_ACTIVE_STATE_KEY);

  if (callbackState && activeAthenaState === callbackState) {
    const { context } = loadAuthorizationContext(window.sessionStorage, callbackState);
    const serverUrl = validateAthenaFhirIssuer(client.state.serverUrl);
    if (serverUrl !== context.issuer) {
      throw new Error("The authorized FHIR server does not match the athenaOne launch.");
    }
    await verifyAthenaIdToken({
      idToken: client.state.tokenResponse?.id_token,
      clientId: context.clientId,
      issuer: context.openIdIssuer,
      nonce: context.nonce,
    });
    return serverUrl;
  }

  return validateExternalSmartIssuer(client.state.serverUrl);
}

function element(name, className, text) {
  const node = document.createElement(name);
  if (className) {
    node.className = className;
  }
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
}

function coverageStatus(item) {
  if (item.status === "Available") {
    return item.count > 0 ? "Loaded" : "No records";
  }
  if (item.status === "Available with restrictions") {
    return "Loaded with restrictions";
  }
  if (item.status === "Partly available") {
    return "Partially loaded";
  }
  if (item.status === "Not authorized") {
    return "Access not granted";
  }
  if (item.status === "Not supported") {
    return "Not supported";
  }
  return "Request failed";
}

function renderCoverage(access) {
  const body = document.getElementById("coverage-body");
  body.replaceChildren();
  for (const item of access) {
    const row = document.createElement("tr");
    const resource = element("th", "", item.resourceType);
    const count = element("td", "numeric", String(item.count));
    const statusText = coverageStatus(item);
    const status = element(
      "td",
      ["Loaded", "No records", "Loaded with restrictions", "Partially loaded"].includes(statusText)
        ? "available"
        : "unavailable",
      statusText,
    );
    resource.scope = "row";
    resource.dataset.label = "Resource type";
    count.dataset.label = "Records";
    status.dataset.label = "Retrieval status";
    row.append(resource, count, status);
    body.append(row);
  }
}

function renderResult(client, record) {
  const totalResources = record.access.reduce((sum, item) => sum + item.count, 0);
  document.getElementById("connection-status").textContent = describeEnvironment(client.state.serverUrl);
  document.getElementById("resource-count").textContent = totalResources.toLocaleString();
  const available = record.access.filter((item) =>
    ["Available", "Available with restrictions", "Partly available"].includes(item.status)
  ).length;
  document.getElementById("coverage-value").textContent = `${available} of ${record.access.length}`;
  renderCoverage(record.access);
  document.getElementById("debug-panel").hidden = !["localhost", "127.0.0.1"].includes(window.location.hostname);
  show(resultView);
}

function updateProgress({ completed, total, resourceType }) {
  const progress = total ? Math.round((completed / total) * 100) : 0;
  document.getElementById("loading-detail").textContent =
    completed === total
      ? "Preparing the evidence summary."
      : `Reading ${resourceType} · ${completed} of ${total} resource groups`;
  const bar = document.getElementById("loading-progress");
  bar.value = progress;
  bar.textContent = `${progress}%`;
}

async function start() {
  await ensureView();
  if (!window.FHIR?.oauth2) {
    throw new Error("The SMART client library could not be loaded.");
  }
  const client = await window.FHIR.oauth2.ready();
  await verifyLaunch(client);
  const record = await loadPatientRecord(client, updateProgress);
  renderResult(client, record);
  try {
    const [models, lyme] = await Promise.all([loadModels(), loadLyme()]);
    const questionnaire = questionnaireFromRecord(record);
    dashboardView = renderDashboard(document.getElementById("condition-cards"), {
      bundle: recordToBundle(record),
      record,
      models,
      lyme,
      asOf: localDate(new Date()),
      questionnaire,
      source: questionnaire ? { kind: "record", label: "From the chart" } : null,
      emptyPatientText: "No answers from the patient app in this chart.",
      tab: tabFromHash(),
      onTabChange: setTabHash,
    });
    setTabHash(dashboardView.tab);
  } catch (error) {
    document.getElementById("condition-cards").textContent = "The condition cards could not be loaded.";
  }
}

window.addEventListener("hashchange", () => {
  const tab = tabFromHash();
  if (tab && dashboardView) dashboardView.selectTab(tab, { focus: false });
  else if (dashboardView) setTabHash(dashboardView.tab);
});

start().catch(showError);
