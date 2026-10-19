import { resourceDate } from "../shared/scorer.js";

export const SEARCHES = [
  { resourceType: "Condition", parameters: ["patient"] },
  { resourceType: "Observation", parameters: ["patient"] },
  { resourceType: "DiagnosticReport", parameters: ["patient"] },
  { resourceType: "Specimen", parameters: ["subject"] },
  { resourceType: "Encounter", parameters: ["patient"] },
  { resourceType: "MedicationRequest", parameters: ["patient"] },
  { resourceType: "MedicationDispense", parameters: ["patient"] },
  { resourceType: "MedicationAdministration", parameters: ["patient", "subject"] },
  { resourceType: "MedicationStatement", parameters: ["patient", "subject"] },
  { resourceType: "ServiceRequest", parameters: ["patient", "subject"] },
  { resourceType: "Procedure", parameters: ["patient", "subject"] },
  { resourceType: "QuestionnaireResponse", parameters: ["patient", "subject"] },
  { resourceType: "DocumentReference", parameters: ["patient", "subject"] },
  { resourceType: "ImagingStudy", parameters: ["patient", "subject"] },
  { resourceType: "Immunization", parameters: ["patient"] },
  { resourceType: "AllergyIntolerance", parameters: ["patient"] },
  { resourceType: "CarePlan", parameters: ["patient", "subject"] },
  { resourceType: "Goal", parameters: ["patient", "subject"] },
  { resourceType: "FamilyMemberHistory", parameters: ["patient"] },
];

const TEXT_CONTENT_TYPES = new Set([
  "text/plain",
  "text/markdown",
  "text/html",
  "application/xhtml+xml",
]);

function errorStatus(error) {
  return error?.status || error?.response?.status || error?.response?.statusCode || null;
}

function accessFailure(error) {
  const status = errorStatus(error);
  if (status === 401 || status === 403) {
    return "Not authorized";
  }
  if (status === 404 || status === 405 || status === 501) {
    return "Not supported";
  }
  return status ? `Unavailable (HTTP ${status})` : "Unavailable";
}

function resourcesFromPage(page) {
  if (page?.resourceType === "Bundle") {
    return (page.entry || []).map((entry) => entry.resource).filter(Boolean);
  }
  return page?.resourceType ? [page] : [];
}

function nextLink(page) {
  return page?.resourceType === "Bundle"
    ? page.link?.find((link) => link.relation === "next")?.url || null
    : null;
}

/**
 * A next-page link must stay on the FHIR server: same origin, and a path at or under the server's base path.
 * HAPI servers, the SMART sandbox among them, page with "<base>?_getpages=...", whose path is the base path
 * itself without a trailing slash.
 */
export function validateNextUrl(value, serverUrl) {
  const base = new URL(serverUrl.endsWith("/") ? serverUrl : `${serverUrl}/`);
  const next = new URL(value, base);
  const onServer = next.pathname.startsWith(base.pathname) || `${next.pathname}/` === base.pathname;
  if (next.origin !== base.origin || !onServer) {
    throw new Error("The FHIR server returned an unsafe pagination URL.");
  }
  return next.href;
}

async function readAllPages(client, firstUrl) {
  const resources = [];
  const seen = new Set();
  let url = firstUrl;
  let pages = 0;
  let total = null;
  let matched = 0;

  while (url) {
    const absolute = validateNextUrl(url, client.state.serverUrl);
    if (seen.has(absolute)) {
      throw new Error("The FHIR server returned a pagination loop.");
    }
    if (pages >= 250) {
      throw new Error("The FHIR response exceeded the pagination safety limit.");
    }

    seen.add(absolute);
    const page = await client.request(absolute);
    if (pages === 0 && page?.resourceType === "Bundle" && Number.isInteger(page.total)) total = page.total;
    resources.push(...resourcesFromPage(page));
    matched += page?.resourceType === "Bundle"
      ? (page.entry || []).filter((entry) => entry.resource && (entry.search?.mode ?? "match") === "match").length
      : 0;
    url = nextLink(page);
    pages += 1;
  }

  // A search cut short (the server reports more matches than it returned) is unavailable, never a short list.
  if (total !== null && matched < total) {
    throw new Error(`The FHIR server returned ${matched} of ${total} matching records.`);
  }
  return resources;
}

async function searchResource(client, definition, patientId) {
  let lastError;

  for (const parameter of definition.parameters) {
    const value = parameter === "subject" ? `Patient/${patientId}` : patientId;
    const query = `${definition.resourceType}?${parameter}=${encodeURIComponent(value)}&_count=100`;
    try {
      return await readAllPages(client, query);
    } catch (error) {
      lastError = error;
      const status = errorStatus(error);
      if (![400, 404, 405, 422].includes(status)) {
        break;
      }
    }
  }

  throw lastError || new Error(`${definition.resourceType} could not be read.`);
}

async function mapWithConcurrency(items, limit, work) {
  const output = new Array(items.length);
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const current = index;
      index += 1;
      output[current] = await work(items[current], current);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return output;
}

/**
 * Records of one type, oldest first by the scorer's clinical date (undated last), then by id. Servers return
 * search results in their own order, and where the scorer cites the first matching record (the derived count of
 * symptom types, condition clusters), that order decides which record and date a card shows.
 */
export function chronological(list) {
  return list
    .map((resource, index) => ({ resource, index, date: resourceDate(resource) || "9999-12-31", id: String(resource?.id ?? "") }))
    .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id, "en", { numeric: true }) || a.index - b.index)
    .map((item) => item.resource);
}

function isRestricted(resource) {
  return (resource?.meta?.security || []).some(
    (coding) => String(coding.code || "").toUpperCase() === "NOAUTH",
  );
}

function decodeBase64(value) {
  const binary = atob(value);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function normalizeText(value, contentType) {
  if (!value) {
    return "";
  }
  if (contentType === "text/html" || contentType === "application/xhtml+xml") {
    return new DOMParser().parseFromString(value, "text/html").body.textContent || "";
  }
  return value;
}

function attachmentCandidates(resources) {
  const candidates = [];

  for (const resource of resources.DocumentReference || []) {
    if (isRestricted(resource)) {
      continue;
    }
    for (const content of resource.content || []) {
      candidates.push({ attachment: content.attachment, source: resource });
    }
  }

  for (const resource of resources.DiagnosticReport || []) {
    if (isRestricted(resource)) {
      continue;
    }
    for (const attachment of resource.presentedForm || []) {
      candidates.push({ attachment, source: resource });
    }
  }

  return candidates.filter(({ attachment }) => attachment && TEXT_CONTENT_TYPES.has(attachment.contentType));
}

function clinicalDate(resource) {
  return (
    resource?.date ||
    resource?.effectiveDateTime ||
    resource?.issued ||
    resource?.meta?.lastUpdated ||
    null
  );
}

function safeBinaryUrl(value, serverUrl) {
  if (!value) {
    return null;
  }
  const base = new URL(serverUrl.endsWith("/") ? serverUrl : `${serverUrl}/`);
  const url = new URL(value, base);
  if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) {
    return null;
  }
  const relative = url.pathname.slice(base.pathname.length);
  return /^Binary\/[^/?#]+$/u.test(relative) ? url.href : null;
}

async function loadNoteTexts(client, resources) {
  const notes = [];
  const binaries = [];
  const failures = [];
  const seenUrls = new Set();
  const candidates = attachmentCandidates(resources);

  // notes[i] belongs to candidates[i], so the order does not depend on which download finishes first
  await mapWithConcurrency(candidates, 3, async ({ attachment, source }, index) => {
    try {
      let text = "";
      if (attachment.data) {
        text = decodeBase64(attachment.data);
      } else {
        const url = safeBinaryUrl(attachment.url, client.state.serverUrl);
        if (!url || seenUrls.has(url)) {
          return;
        }
        seenUrls.add(url);
        const binary = await client.request(url);
        if (binary?.resourceType !== "Binary" || isRestricted(binary)) {
          return;
        }
        binaries.push(binary);
        if (TEXT_CONTENT_TYPES.has(binary.contentType) && binary.data) {
          text = decodeBase64(binary.data);
        }
      }

      text = normalizeText(text, attachment.contentType).replace(/\s+/gu, " ").trim();
      if (text) {
        notes[index] = {
          text,
          sourceType: source.resourceType,
          date: clinicalDate(source),
        };
      }
    } catch (error) {
      failures.push(accessFailure(error));
    }
  });

  resources.Binary = binaries;
  return { notes: notes.filter(Boolean), failures };
}

export async function loadPatientRecord(client, onProgress = () => {}) {
  const patientId = client?.patient?.id;
  if (!patientId) {
    throw new Error("The SMART launch did not provide a patient context.");
  }

  const resources = {};
  const access = [];
  let patient = null;

  try {
    patient = await client.patient.read();
    resources.Patient = patient ? [patient] : [];
    access.push({ resourceType: "Patient", status: "Available", count: patient ? 1 : 0 });
  } catch (error) {
    resources.Patient = [];
    access.push({ resourceType: "Patient", status: accessFailure(error), count: 0 });
  }

  let completed = 0;
  onProgress({ completed, total: SEARCHES.length, resourceType: "Patient" });
  // resource types in SEARCHES order, however the searches finish
  for (const definition of SEARCHES) {
    resources[definition.resourceType] = [];
  }

  await mapWithConcurrency(SEARCHES, 4, async (definition) => {
    try {
      const result = await searchResource(client, definition, patientId);
      const allowed = chronological(result.filter((resource) => !isRestricted(resource)));
      resources[definition.resourceType] = allowed;
      access.push({
        resourceType: definition.resourceType,
        status: allowed.length === result.length ? "Available" : "Available with restrictions",
        count: allowed.length,
      });
    } catch (error) {
      resources[definition.resourceType] = [];
      access.push({
        resourceType: definition.resourceType,
        status: accessFailure(error),
        count: 0,
      });
    } finally {
      completed += 1;
      onProgress({ completed, total: SEARCHES.length, resourceType: definition.resourceType });
    }
  });

  const order = ["Patient", ...SEARCHES.map((definition) => definition.resourceType)];
  access.sort((a, b) => order.indexOf(a.resourceType) - order.indexOf(b.resourceType));

  const { notes, failures } = await loadNoteTexts(client, resources);
  access.push({
    resourceType: "Note content",
    status: failures.length ? "Partly available" : "Available",
    count: notes.length,
  });

  return { patient, resources, access, notes };
}

export { isRestricted };
