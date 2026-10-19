// Shared display settings: appearance (device, light, dark) and text size, saved in localStorage.
// Loaded in <head> without defer so a saved theme applies before the first paint. Every storage call is
// wrapped in try/catch: private windows and blocked storage fall back to the device setting.
// Keys: unom.theme ("light" | "dark"; absent = follow the device) and unom.text ("large"; absent = default).
// The homepage and shared site navigation use this same behavior and the same stored keys.
(function () {
  "use strict";
  var root = document.documentElement;
  var THEME_KEY = "unom.theme";
  var TEXT_KEY = "unom.text";
  var BACKGROUND = { light: "#f6f5f1", dark: "#171918" };

  root.classList.add("js");

  function read(key) {
    try {
      return window.localStorage.getItem(key);
    } catch (e) {
      return null;
    }
  }

  function write(key, value) {
    try {
      if (value) window.localStorage.setItem(key, value);
      else window.localStorage.removeItem(key);
    } catch (e) {
      // Storage unavailable: the choice lasts until the page is closed.
    }
  }

  function apply(theme, text) {
    if (theme === "light" || theme === "dark") root.setAttribute("data-theme", theme);
    else root.removeAttribute("data-theme");
    if (text === "large") root.setAttribute("data-text", "large");
    else root.removeAttribute("data-text");
    var metas = document.querySelectorAll('meta[name="theme-color"]');
    for (var i = 0; i < metas.length; i++) {
      var own = (metas[i].getAttribute("media") || "").indexOf("dark") >= 0 ? "dark" : "light";
      metas[i].setAttribute("content", BACKGROUND[theme === "light" || theme === "dark" ? theme : own]);
    }
  }

  apply(read(THEME_KEY), read(TEXT_KEY));

  function wire(scope) {
    if (!scope || typeof scope.querySelectorAll !== "function") scope = document;
    var theme = root.getAttribute("data-theme") || "device";
    var text = root.getAttribute("data-text") || "default";
    var inputs = scope.querySelectorAll('input[name="appearance"], input[name="text-size"]');
    for (var i = 0; i < inputs.length; i++) {
      var input = inputs[i];
      input.checked = input.value === (input.name === "appearance" ? theme : text);
      input.addEventListener("change", function (event) {
        var target = event.target;
        if (!target.checked) return;
        if (target.name === "appearance") write(THEME_KEY, target.value === "device" ? null : target.value);
        else write(TEXT_KEY, target.value === "large" ? "large" : null);
        var chosenTheme = document.querySelector('input[name="appearance"]:checked');
        var chosenText = document.querySelector('input[name="text-size"]:checked');
        apply(chosenTheme ? chosenTheme.value : null, chosenText ? chosenText.value : null);
      });
    }
  }

  window.unomDisplaySettings = { wire: wire };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", wire);
  else wire();
})();
