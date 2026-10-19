import { applyStatic, readStoredLang, resolveLang, setLanguage } from "../patient/i18n.js";
const store = (() => { try { return localStorage; } catch { return null; } })();
const t = setLanguage(resolveLang(location.href, readStoredLang(store)));
if (t.lang === "es") {
  applyStatic(document, t);
  document.title = `${t("sources.title")} | Undiagnosed No More`;
}
