// One navigation bar and one footer for every page of the demo.
// The bar repeats the homepage header (/index.html): the same UNOM logo files, the same 1120px column and
// 64px row, and the same door names: Clinicians, Patients, Policymakers (the Atlas), Developers, About.
// Usage: <link rel="stylesheet" href="/shared/site-nav.css" /> in <head>, <body data-door="patient">, and
// <script src="/shared/site-nav.js" defer></script>. Doors: hub, patient, clinician, atlas, developers, evidence.

const LINKS = [
  ["clinician", "/clinician/", "Clinicians"],
  ["patient", "/patient/", "Patients"],
  ["atlas", "/atlas/", "Policymakers"],
  ["developers", "/developers/", "Developers"],
  ["evidence", "/about/", "About"],
];

// Spanish is offered only in the patient app: an "Español" (or "English") link in the bar and a Language
// field in the settings panel. Every other page has no language control at all: no link in the bar and no
// Language field. The patient app's language is ?lang=es or ?lang=en in the address, then the choice saved
// under LANG_KEY, then English: the same rule as resolveLang in /patient/i18n.js, which saves the choice.
const SPANISH_TARGETS = { patient: true };
const LANG_KEY = "unom.lang";
const LANGUAGE_NAMES = { en: "English", es: "Español" };

// The footer: the legal pages and the copyright line. The doors are in the bar.
// The homepage carries the same footer as static markup (/index.html); site.test.js checks the two match.
const LEGAL = [
  ["/terms/", "Terms of use"],
  ["/privacy/", "Privacy"],
  ["/rights/", "Rights and attributions"],
];
const COPYRIGHT = "© 2026 Amir Asiaee and Kaveh Aryan";

// The patient app opens each legal document outside the questionnaire.
const PATIENT_LEGAL = {
  en: [["/terms/", "Terms of use"], ["/privacy/", "Privacy"], ["/sources/", "Questionnaire sources"], ["/rights/", "Rights and attributions"]],
  es: [["/terms/", "Condiciones de uso"], ["/privacy/", "Privacidad"], ["/sources/?lang=es", "Fuentes de los cuestionarios"], ["/rights/", "Derechos y atribuciones"]],
};

// The bar, settings panel, and footer text. Spanish is used only by the patient app in Spanish.
const UI = {
  en: {
    doors: Object.fromEntries(LINKS.map(([key, , label]) => [key, label])),
    home: "UNOM, Undiagnosed No More: home",
    site: "Site",
    footer: "Footer",
    settings: "Display settings",
    settingsLanguage: "Display and language",
    display: "Display",
    close: "Close settings",
    appearance: "Appearance",
    device: "Device",
    light: "Light",
    dark: "Dark",
    textSize: "Text size",
    textDefault: "Default",
    large: "Large",
    language: "Language",
    note: "Saved in this browser. Appearance and text size apply to every page of the site.",
    standalone: "Symptom check",
    help: "Help: our TOPx submission, the demo video, and the tour",
    helpLinks: [["/challenge/", "Our TOPx submission"], ["/walkthrough/", "Watch the demo video"], ["/?tour", "Take the tour"]],
    copyright: COPYRIGHT,
  },
  es: {
    doors: { patient: "Pacientes", clinician: "Médicos", atlas: "Responsables de políticas", developers: "Desarrolladores", evidence: "Acerca de" },
    home: "UNOM, Undiagnosed No More: inicio",
    site: "Sitio",
    footer: "Pie de página",
    settings: "Visualización",
    settingsLanguage: "Visualización e idioma",
    display: "Visualización",
    close: "Cerrar la configuración",
    appearance: "Apariencia",
    device: "Dispositivo",
    light: "Claro",
    dark: "Oscuro",
    textSize: "Tamaño del texto",
    textDefault: "Normal",
    large: "Grande",
    language: "Idioma",
    note: "Se guarda en este navegador. La apariencia y el tamaño del texto se aplican en todas las páginas del sitio.",
    standalone: "Revisión de síntomas",
    help: "Ayuda: nuestra propuesta a TOPx, el video y el recorrido",
    helpLinks: [["/challenge/", "Nuestra propuesta a TOPx (en inglés)"], ["/walkthrough/", "Ver el video (en inglés)"], ["/?tour", "Hacer el recorrido (en inglés)"]],
    copyright: "© 2026 Amir Asiaee y Kaveh Aryan",
  },
};

function el(tag, attrs = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  for (const kid of kids) node.append(kid);
  return node;
}

// The homepage's logo markup: wide wordmark from 600px up, compact below, light and dark files (the stylesheet
// shows one of the two pictures). Same URLs and version as the homepage, so the browser reuses its cached files.
const LOGO = "/images/homepage/unom-logo-";
const LOGO_VERSION = "?v=20261013";

function logo(theme) {
  const picture = el("picture", { class: `brand-${theme}` });
  picture.append(
    el("source", { media: "(min-width: 600px)", srcset: `${LOGO}wide-${theme}.svg${LOGO_VERSION}`, width: "256", height: "32" }),
    el("img", { src: `${LOGO}compact-${theme}.svg${LOGO_VERSION}`, width: "171", height: "32", alt: "", loading: "lazy" }),
  );
  return picture;
}

function gearIcon() {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  for (const [key, value] of Object.entries({ width: "24", height: "24", viewBox: "0 0 23 23", fill: "none", "aria-hidden": "true", focusable: "false" })) svg.setAttribute(key, value);
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", "M8.625 4.648 9.583 2.827h3.834l.958 1.821 1.917.91 1.916-.182 1.917 3.096-1.15 1.638v1.821l1.15 1.639-1.917 3.095-1.916-.182-1.917.91-.958 1.821H9.583l-.958-1.82-1.917-.911-1.916.182-1.917-3.095 1.15-1.639V10.11l-1.15-1.638 1.917-3.096 1.916.182z");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "1.4");
  const circle = document.createElementNS(ns, "circle");
  for (const [key, value] of Object.entries({ cx: "11.5", cy: "11.5", r: "3.354", stroke: "currentColor", "stroke-width": "1.44" })) circle.setAttribute(key, value);
  svg.append(path, circle);
  return svg;
}

function settingChoice(name, value, label, checked = false, className = "") {
  const input = el("input", { type: "radio", name, value });
  input.checked = checked;
  return el("label", {}, input, el("span", className ? { class: className } : {}, label));
}

/** The patient app's language: ?lang= in the address, then the saved choice, then English. */
function patientLanguage() {
  let fromUrl = null;
  try {
    fromUrl = new URL(window.location.href).searchParams.get("lang");
  } catch {
    fromUrl = null;
  }
  if (fromUrl === "es" || fromUrl === "en") return fromUrl;
  try {
    const saved = window.localStorage.getItem(LANG_KEY);
    if (saved === "es" || saved === "en") return saved;
  } catch {
    // Storage blocked: English, unless the address asks for Spanish.
  }
  return "en";
}

/** This page in another language: the same address with ?lang= set and the hash kept (?reset is dropped). */
function languageHref(lang) {
  const url = new URL(window.location.href);
  url.searchParams.delete("reset");
  url.searchParams.set("lang", lang);
  return `${url.pathname}${url.search}${url.hash}`;
}

function languageAnchor(code, attrs = {}) {
  return el("a", { href: languageHref(code), lang: code, hreflang: code, "data-lang-switch": code, ...attrs }, LANGUAGE_NAMES[code]);
}

// The bar's link to the other language: "Español" on the English app, "English" on the Spanish one.
function languageLink(spanish, className = "") {
  return languageAnchor(spanish.lang === "es" ? "en" : "es", className ? { class: className } : {});
}

function languageSettings(spanish, ui) {
  if (!spanish) return null;
  const choices = el("div", { class: "setting-choices" },
    ...["en", "es"].map((code) => languageAnchor(code, code === spanish.lang ? { "aria-current": "page" } : {})));
  return el("div", { class: "setting-group language-setting" }, el("p", {}, ui.language), choices);
}

function displaySettings(spanish, ui = UI.en) {
  const panel = el("aside", { id: "display-settings", class: "display-settings", popover: "", "aria-labelledby": "settings-heading" });
  const language = languageSettings(spanish, ui);
  panel.append(
    el("div", { class: "settings-heading" },
      el("h2", { id: "settings-heading" }, language ? ui.settingsLanguage : ui.display),
      el("button", { type: "button", popovertarget: "display-settings", popovertargetaction: "hide", "aria-label": ui.close }, "×")),
    el("fieldset", { class: "setting-group needs-js" },
      el("legend", {}, ui.appearance),
      el("div", { class: "setting-choices setting-choices-3" },
        settingChoice("appearance", "device", ui.device, true),
        settingChoice("appearance", "light", ui.light),
        settingChoice("appearance", "dark", ui.dark))),
    el("fieldset", { class: "setting-group needs-js" },
      el("legend", {}, ui.textSize),
      el("div", { class: "setting-choices" },
        settingChoice("text-size", "default", ui.textDefault, true),
        settingChoice("text-size", "large", ui.large, false, "size-sample-large"))),
    ...(language ? [language] : []),
    el("p", { class: "settings-note" }, ui.note),
  );
  return panel;
}

// The "?" menu: our TOPx submission, the demo video, and the tour (which opens on the homepage).
function helpMenu(ui = UI.en) {
  const list = el("ul", {});
  for (const [href, label] of ui.helpLinks) list.append(el("li", {}, el("a", { href }, label)));
  return el("nav", { id: "site-help", class: "site-help", popover: "", "aria-label": ui.help }, list);
}

// compact: no door links, for views that open on their own (the standalone patient app, the SMART-launched
// clinician view and its launch pages), where the site's tabs would lead away from the task.
function siteFooter({ compact = false, legal = LEGAL, ui = UI.en, legalNewTab = false } = {}) {
  const footer = el("footer", { class: `unm-sitefooter${compact ? " unm-sitefooter-compact" : ""}` });
  const inner = el("div", { class: "unm-sitefooter-inner" });
  const links = el("ul", { class: "unm-sitefooter-legal" });
  for (const [href, label] of legal) links.append(el("li", {}, el("a", legalNewTab ? { href, target: "_blank", rel: "noopener noreferrer" } : { href }, label)));
  inner.append(links, el("p", { class: "unm-sitefooter-copy" }, ui.copyright));
  footer.append(inner);
  return footer;
}

function build() {
  const door = document.body.dataset.door || "";
  const spanish = SPANISH_TARGETS[door] ? { lang: patientLanguage() } : null;
  const lang = spanish ? spanish.lang : "en";
  const ui = UI[lang];
  if (lang !== "en") document.documentElement.lang = lang;
  // On the Spanish patient app the Patients link keeps Spanish even where the browser does not save the choice.
  const doorHref = (key, href) => (key === "patient" && lang !== "en" ? `${href}?lang=${lang}` : href);
  const bar = el("header", { class: "unm-sitebar", role: "banner" });
  const inner = el("div", { class: "unm-sitebar-inner" });
  inner.append(el("a", { class: "unm-sitebar-brand", href: "/", "aria-label": ui.home }, logo("light"), logo("dark")));
  const nav = el("nav", { class: "unm-sitebar-links", "aria-label": ui.site });
  for (const [key, href] of LINKS) {
    const a = el("a", { href: doorHref(key, href) }, ui.doors[key]);
    if (key === door) a.setAttribute("aria-current", "page");
    nav.append(a);
  }
  const controls = el("div", { class: "header-tools" });
  if (spanish) controls.append(languageLink(spanish, "lang-link"));
  controls.append(
    el("button", { class: "help-toggle", type: "button", popovertarget: "site-help", "aria-label": ui.help }, "?"),
    el("button", { class: "settings-toggle", type: "button", popovertarget: "display-settings", "aria-label": spanish ? ui.settingsLanguage : ui.settings }, gearIcon()),
  );
  const settings = displaySettings(spanish, ui);
  const help = helpMenu(ui);
  const standalone = new URL(window.location.href).searchParams.get("standalone") === "1" && door === "patient";
  if (standalone) {
    bar.classList.add("unm-sitebar-standalone");
    nav.replaceChildren(el("span", { class: "unm-standalone-title" }, ui.standalone));
  }
  inner.append(nav, controls);
  bar.append(inner);

  const frag = document.createDocumentFragment();
  frag.append(bar, settings, help);
  document.body.prepend(frag);
  window.unomDisplaySettings?.wire(settings);
  const legal = door === "patient" ? PATIENT_LEGAL[lang] : LEGAL;
  if (!document.querySelector(".unm-sitefooter")) document.body.append(siteFooter({ compact: standalone, legal, ui, legalNewTab: door === "patient" }));
  // The language links keep the screen the person is on (the patient app routes by #hash).
  if (spanish) {
    window.addEventListener("hashchange", () => {
      for (const a of document.querySelectorAll("[data-lang-switch]")) a.setAttribute("href", languageHref(a.getAttribute("data-lang-switch")));
    });
  }
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", build);
  else build();
}
