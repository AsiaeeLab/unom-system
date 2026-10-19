// First-visit tour of the homepage for judges and other new visitors.
//
// The markup is the <dialog id="tour"> at the end of / and /es/: one [data-tour-step] per step, each with
// data-target (a selector for the section to highlight, "top" for the first screen, or empty).
// Opens by itself on the first visit; "Take the tour" ([data-tour-open]) replays it. Skip, Escape,
// "Close the tour", and following a link inside the tour all save that in localStorage (key unom.tour),
// so it does not open again. It never opens by itself when the URL has ?notour or a #section, or in an
// automated browser (navigator.webdriver or headless Chrome), so screenshots stay clean; ?tour opens it
// on any visit. On wide screens the panel sits on the side away from the screen it describes (data-side).
// The last step is a text path through the demo ("Try it with Maria"). When the walkthrough is posted,
// set data-video-posted="true" on the dialog: the step then checks /media/walkthrough.mp4 with a
// same-origin HEAD request and shows the video (with its caption tracks) and the transcript link
// ([data-tour-transcript]), with the heading in data-video-title. Until then no request is made, so a
// missing file never logs a 404. A YouTube URL in data-youtube-url is shown as a link (no third-party
// requests). The video, captions, and transcript page come from web/tools/record_walkthrough.py.
(function () {
  "use strict";
  var KEY = "unom.tour";
  var dialog = document.getElementById("tour");
  if (!dialog || typeof dialog.showModal !== "function") return;

  var steps = Array.prototype.slice.call(dialog.querySelectorAll("[data-tour-step]"));
  var count = dialog.querySelector("[data-tour-count]");
  var live = dialog.querySelector("[data-tour-live]");
  var back = dialog.querySelector("[data-tour-back]");
  var next = dialog.querySelector("[data-tour-next]");
  var done = dialog.querySelector("[data-tour-done]");
  var skip = dialog.querySelector("[data-tour-skip]");
  var openers = Array.prototype.slice.call(document.querySelectorAll("[data-tour-open]"));
  var counter = dialog.getAttribute("data-counter") || "Step {n} of {total}";
  var current = 0;
  var returnTo = null;
  var highlighted = null;
  var videoChecked = false;

  function reducedMotion() {
    return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  }

  function saved() {
    try {
      return window.localStorage.getItem(KEY);
    } catch (e) {
      return null;
    }
  }

  function save(value) {
    try {
      window.localStorage.setItem(KEY, value);
    } catch (e) {
      // Storage blocked: the tour may open again on the next visit.
    }
  }

  function scrollTo(el) {
    var behavior = reducedMotion() ? "auto" : "smooth";
    if (el) el.scrollIntoView({ block: "start", behavior: behavior });
    else window.scrollTo({ top: 0, behavior: behavior });
  }

  function highlight(selector) {
    if (highlighted) highlighted.classList.remove("tour-target");
    highlighted = null;
    if (selector === "top") {
      scrollTo(null);
      return;
    }
    if (!selector) return;
    // A step can name a wide-screen target and its phone twin ("#hub-patients, #tile-patients"): use the one shown.
    var list = document.querySelectorAll(selector);
    var el = null;
    for (var i = 0; i < list.length && !el; i++) if (list[i].getClientRects().length > 0) el = list[i];
    if (!el) return;
    el.classList.add("tour-target");
    highlighted = el;
    scrollTo(el);
  }

  // The video heading replaces "Try it with Maria" once there is a video or a YouTube link to show.
  function useVideoTitle(step) {
    var heading = step.querySelector("h2");
    var title = heading && heading.getAttribute("data-video-title");
    if (!title || heading.textContent === title) return;
    heading.textContent = title;
    if (live && !step.hidden) live.textContent = count.textContent + ". " + title;
  }

  function prepareVideo(step) {
    var video = step.querySelector("video");
    var fallback = step.querySelector("[data-tour-fallback]");
    var youtube = step.querySelector("[data-tour-youtube]");
    var transcript = step.querySelector("[data-tour-transcript]");
    var url =(dialog.getAttribute("data-youtube-url") || "").trim();
    var hasYoutube = /^https:\/\/(www\.youtube\.com|youtube\.com|youtu\.be)\//.test(url);
    if (youtube && hasYoutube) {
      youtube.querySelector("a").setAttribute("href", url);
      youtube.hidden = false;
      if (fallback) fallback.hidden = true;
      useVideoTitle(step);
    }
    // No request until the walkthrough is posted: a HEAD for a missing file logs a 404 in the console.
    if (dialog.getAttribute("data-video-posted") !== "true") return;
    if (videoChecked || !video || !window.fetch) return;
    videoChecked = true;
    var source = video.querySelector("source");
    var src = (source && source.getAttribute("src")) || dialog.getAttribute("data-video");
    window
      .fetch(src, { method: "HEAD", cache: "no-store", credentials: "same-origin" })
      .then(function (response) {
        var type = response.headers.get("content-type") || "";
        if (!response.ok || type.indexOf("video/") !== 0) return;
        var poster = video.getAttribute("data-poster");
        if (poster) video.setAttribute("poster", poster);
        video.hidden = false;
        if (fallback) fallback.hidden = true;
        if (transcript) transcript.hidden = false;
        useVideoTitle(step);
      })
      .catch(function () {
        // No video: the text fallback (or the YouTube link) stays.
      });
  }

  function render(index) {
    current = Math.max(0, Math.min(steps.length - 1, index));
    for (var i = 0; i < steps.length; i++) steps[i].hidden = i !== current;
    var step = steps[current];
    var heading = step.querySelector("h2");
    var last = current === steps.length - 1;
    dialog.setAttribute("aria-labelledby", heading.id);
    // Wide screens: a step about one section puts the panel on the left, under that section's text, so it
    // does not cover the screen on the right. A step can set its own data-side (the developer door's code
    // spans both columns, and its link is on the left).
    var side = step.getAttribute("data-side") || (/^#/.test(step.getAttribute("data-target") || "") ? "start" : "end");
    dialog.setAttribute("data-side", side);
    count.textContent = counter.replace("{n}", String(current + 1)).replace("{total}", String(steps.length));
    back.hidden = current === 0;
    next.hidden = last;
    done.hidden = !last;
    highlight(step.getAttribute("data-target"));
    if (last) prepareVideo(step);
    if (live) live.textContent = count.textContent + ". " + heading.textContent;
  }

  function focusables() {
    var nodes = dialog.querySelectorAll('a[href], button, video[controls], input, select, textarea, [tabindex]:not([tabindex="-1"])');
    return Array.prototype.filter.call(nodes, function (el) {
      return !el.disabled && el.getClientRects().length > 0;
    });
  }

  function open(opener) {
    returnTo = opener || (document.activeElement !== document.body ? document.activeElement : null);
    render(0);
    if (!dialog.open) dialog.showModal();
    steps[0].querySelector("h2").focus();
  }

  var closing = null;

  function close(reason) {
    if (!dialog.open) return;
    closing = reason;
    save(reason); // right away, in case the visitor leaves before the close event runs
    dialog.close();
  }

  // Runs for every close, including one the browser forces, so the highlight and focus are always restored.
  dialog.addEventListener("close", function () {
    var reason = closing;
    closing = null;
    if (!reason) {
      reason = "skipped";
      save(reason);
    }
    if (highlighted) highlighted.classList.remove("tour-target");
    highlighted = null;
    var video = dialog.querySelector("video");
    if (video && !video.paused) video.pause();
    if (reason === "done") scrollTo(null);
    var target = returnTo && document.contains(returnTo) ? returnTo : document.getElementById("main");
    if (target) target.focus({ preventScroll: true });
    returnTo = null;
  });

  next.addEventListener("click", function () {
    render(current + 1);
    if (next.hidden) done.focus();
  });
  back.addEventListener("click", function () {
    render(current - 1);
    if (back.hidden) next.focus();
  });
  done.addEventListener("click", function () {
    close("done");
  });
  skip.addEventListener("click", function () {
    close("skipped");
  });
  // A link inside the tour (the patient app, the clinician view, the video page) leaves the page:
  // count that as seen, so the tour does not start over on the next visit.
  dialog.addEventListener("click", function (event) {
    var link = event.target && event.target.closest ? event.target.closest("a[href]") : null;
    if (link && dialog.contains(link)) save("done");
  });
  // Escape fires "cancel" on a modal dialog.
  dialog.addEventListener("cancel", function (event) {
    event.preventDefault();
    close("skipped");
  });
  // Keep Tab and Shift+Tab inside the dialog.
  dialog.addEventListener("keydown", function (event) {
    if (event.key === "Escape") {
      event.preventDefault();
      close("skipped");
      return;
    }
    if (event.key !== "Tab") return;
    var items = focusables();
    if (!items.length) return;
    var first = items[0];
    var lastItem = items[items.length - 1];
    var active = document.activeElement;
    if (event.shiftKey && (active === first || !dialog.contains(active))) {
      event.preventDefault();
      lastItem.focus();
    } else if (!event.shiftKey && (active === lastItem || !dialog.contains(active))) {
      event.preventDefault();
      first.focus();
    }
  });

  openers.forEach(function (button) {
    button.hidden = false;
    button.addEventListener("click", function () {
      open(button);
    });
  });

  var params;
  try {
    params = new URLSearchParams(window.location.search);
  } catch (e) {
    params = { has: function () { return false; } };
  }
  var automated = navigator.webdriver === true || /HeadlessChrome|Lighthouse/.test(navigator.userAgent);
  var deepLink = window.location.hash.length > 1;
  if (params.has("tour")) open();
  else if (!params.has("notour") && !automated && !deepLink && !saved()) open();
})();
