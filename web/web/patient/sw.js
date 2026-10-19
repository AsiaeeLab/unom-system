// Service worker for the patient app: caches the app shell, the shared
// scorer, the nine models, the shared nav and its UNOM logo files, and the demo records so the app works offline.
// Answers are never cached here; they live in localStorage. Both languages are in the shell (the string
// tables), and every navigation, with or without ?lang=es, is served the same cached /patient/ page.

const VERSION = "unm-patient-2026-10-15-intro-terms";

const SHELL = [
  "/patient/",
  "/patient/app.css",
  "/patient/app.js",
  "/patient/i18n.js",
  "/patient/strings-en.js",
  "/patient/strings-es.js",
  "/patient/record-terms-es.js",
  "/patient/instruments.js",
  "/patient/scoring.js",
  "/patient/summary.js",
  "/patient/records.js",
  "/patient/trials.js",
  "/patient/storage.js",
  "/patient/demo.js",
  "/shared/demo-answers.js",
  "/patient/manifest.webmanifest",
  "/patient/icon.svg",
  "/patient/icon-192.png",
  "/patient/icon-512.png",
];

// Fetched separately: a missing file must not block installing the shell.
const OPTIONAL = [
  "/shared/scorer.js",
  "/shared/site-nav.css",
  "/shared/demo-frame.css",
  "/shared/site-nav.js",
  "/shared/header-tools.css",
  "/homepage-settings.js",
  // the logo files site-nav.js loads (wide from 600px up, compact below; light and dark)
  "/images/homepage/unom-logo-wide-light.svg",
  "/images/homepage/unom-logo-wide-dark.svg",
  "/images/homepage/unom-logo-compact-light.svg",
  "/images/homepage/unom-logo-compact-dark.svg",
  "/models/longcovid.json",
  "/models/chronicfatigue.json",
  "/models/fibromyalgia.json",
  "/models/endometriosis.json",
  "/models/lyme.json",
  "/models/lupus.json",
  "/models/migraine.json",
  "/models/depression.json",
  "/models/anxiety.json",
  "/data/patients/elena.json",
  "/data/patients/maria.json",
  "/data/patients/dana.json",
  "/data/patients/sofia.json",
  "/data/lyme_county.json",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(VERSION);
      await cache.addAll(SHELL);
      await Promise.all(
        OPTIONAL.map(async (url) => {
          try {
            const res = await fetch(url, { cache: "no-cache" });
            if (res.ok && !res.redirected) await cache.put(url, res);
          } catch {
            /* fetched on first use instead */
          }
        }),
      );
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k.startsWith("unm-patient-") && k !== VERSION).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

function cacheable(url) {
  return (
    url.origin === self.location.origin &&
    (url.pathname.startsWith("/patient/") ||
      url.pathname === "/patient" ||
      url.pathname.startsWith("/shared/") ||
      url.pathname.startsWith("/images/homepage/unom-logo-") ||
      url.pathname.startsWith("/models/") ||
      url.pathname.startsWith("/data/patients/") ||
      url.pathname === "/data/lyme_county.json")
  );
}

// Stale-while-revalidate for same-origin app files; everything else
// (including ClinicalTrials.gov) goes straight to the network.
self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (!cacheable(url)) return;

  const key = req.mode === "navigate" ? "/patient/" : url.pathname;
  event.respondWith(
    (async () => {
      const cache = await caches.open(VERSION);
      const cached = await cache.match(key);
      const network = fetch(req)
        .then((res) => {
          if (res.ok && !res.redirected && res.type === "basic") cache.put(key, res.clone());
          return res;
        })
        .catch(() => null);
      if (cached) {
        event.waitUntil(network);
        return cached;
      }
      const res = await network;
      return res || new Response("Offline", { status: 503, statusText: "Offline" });
    })(),
  );
});
