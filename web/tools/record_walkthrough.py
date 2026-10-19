#!/usr/bin/env python3
"""Record the walkthrough video for the homepage tour and the submission.

    python3 web/tools/record_walkthrough.py                         # serve web/web locally, record, write files
    python3 web/tools/record_walkthrough.py --base http://127.0.0.1:8951
    python3 web/tools/record_walkthrough.py --out /tmp/walkthrough  # write the outputs somewhere else

Serves web/web on a free local port (8951 to 8990, 127.0.0.1) unless --base is given, drives Chrome with
Playwright for Python at 1280 x 720 (record_video_dir), follows a fixed click path through the site with a
caption bar for each scene, then converts the recording with ffmpeg and stops its own server.
Needs Playwright for Python, Chrome (CHROME=/path/to/chrome, default /usr/bin/google-chrome), and ffmpeg
(FFMPEG=/path/to/ffmpeg, default /usr/bin/ffmpeg).

Writes, from the same scene list, so the captions, the caption file, and the transcript always agree:
  web/web/media/walkthrough.mp4        H.264, 1280 x 720, no audio, under 20 MB, faststart
  web/web/media/walkthrough.en.vtt     English captions (the text of the on-screen caption bar)
  web/web/walkthrough/index.html       the Watch page: the video with its caption track, the transcript, and
                                       the slide deck's links (/deck/ and its PDF)
The walkthrough is in English only; Spanish is offered in the patient app alone, and the video shows its
Español switch once.

The click path, about 4 minutes: the homepage and its sections; the patient app (it opens on Maria's synthetic
answers; Next steps through the RECOVER symptom questions, the DePaul questions, daily life, and the
self-checks to her summary, with Print and Download; the Español switch and back); the clinician view for Maria
(Needs review, her answers from the patient app, the Long COVID tab with each
finding's arrow, odds ratio, and bar, two tooltips, the timeline), Dana (the Lyme disease model and its chart findings), and Sofia (the
fibromyalgia card with her self-check); the Atlas (Long COVID: key numbers, the state map, who goes uncoded;
fibromyalgia: its state map, who goes uncoded, what else is in the record; back to Long COVID for the cost
calculator, with one assumption changed); the developer documentation (the overview, Try the scorer, the CDS
Hooks service, the model registry); the About page; the homepage.
After a change to the site's wording or numbers, rerun this script and check that each caption still describes
what is on screen. Every number in a caption must appear in a CHECKS entry below (checked before recording),
and each CHECKS entry is checked against the page text while its scene is on screen. Then extract a frame
from each scene (ffmpeg -ss) and look at it, and update the length the homepage tour states
(data-video-title in web/web/index.html) if the rounded minutes change.
"""
from __future__ import annotations

import argparse
import html
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
SITE = ROOT / "web" / "web"
CHROME = os.environ.get("CHROME", "/usr/bin/google-chrome")
FFMPEG = os.environ.get("FFMPEG", "/usr/bin/ffmpeg")
SIZE = {"width": 1280, "height": 720}
MAX_BYTES = 20 * 1024 * 1024
TITLE_EN = "Watch"
# Where the pointer rests when it is hidden: the right margin of every page, away from any hover target.
REST = (1272, 300)

# On-screen caption bar and fake pointer, added to every document of the recording (the site's own pages are
# never changed). The caption text lives in sessionStorage, so it survives a navigation within a scene.
OVERLAY_JS = r"""
(() => {
  const KEY = "unom-walkthrough";
  const state = () => { try { return JSON.parse(sessionStorage.getItem(KEY) || "{}"); } catch (e) { return {}; } };
  const save = (s) => { try { sessionStorage.setItem(KEY, JSON.stringify(s)); } catch (e) {} };
  function build() {
    if (document.getElementById("wt-caption")) return;
    const root = document.documentElement;
    const bar = document.createElement("div");
    bar.id = "wt-caption";
    bar.setAttribute("aria-hidden", "true");
    Object.assign(bar.style, {
      position: "fixed", left: "0", right: "0", bottom: "0", zIndex: "2147483646", boxSizing: "border-box",
      padding: "13px 40px 15px", background: "rgba(25, 25, 24, 0.95)", color: "#f6f5f1",
      borderTop: "2px solid #ae0808", font: '400 19px/1.45 "IBM Plex Sans", system-ui, sans-serif',
      letterSpacing: "0", textAlign: "left", pointerEvents: "none", minHeight: "58px",
      display: "flex", alignItems: "center",
    });
    const text = document.createElement("span");
    text.id = "wt-caption-text";
    text.style.maxWidth = "1150px";
    bar.appendChild(text);
    const dot = document.createElement("div");
    dot.id = "wt-pointer";
    Object.assign(dot.style, {
      position: "fixed", left: "0", top: "0", width: "22px", height: "22px", marginLeft: "-11px", marginTop: "-11px",
      borderRadius: "50%", border: "2px solid #191918", background: "rgba(174, 8, 8, 0.28)", zIndex: "2147483647",
      pointerEvents: "none", boxSizing: "border-box", boxShadow: "0 0 0 2px rgba(246, 245, 241, 0.9)",
    });
    root.appendChild(bar);
    root.appendChild(dot);
    const s = state();
    text.textContent = s.caption || "";
    bar.style.display = s.caption ? "flex" : "none";
    dot.style.transform = `translate(${s.x ?? 1240}px, ${s.y ?? 680}px)`;
    dot.style.display = s.pointer ? "block" : "none";
  }
  window.__wt = {
    caption(t) {
      build();
      const s = state(); s.caption = t; save(s);
      const bar = document.getElementById("wt-caption");
      const text = document.getElementById("wt-caption-text");
      text.textContent = t;
      bar.style.display = t ? "flex" : "none";
      if (t) text.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 250, easing: "ease-out" });
    },
    move(x, y, ms) {
      build();
      const s = state(); const from = [s.x ?? 1240, s.y ?? 680]; s.x = x; s.y = y; s.pointer = true; save(s);
      const dot = document.getElementById("wt-pointer");
      dot.style.display = "block";
      const a = dot.animate([{ transform: `translate(${from[0]}px, ${from[1]}px)` }, { transform: `translate(${x}px, ${y}px)` }],
        { duration: ms, easing: "cubic-bezier(.4, 0, .2, 1)", fill: "forwards" });
      dot.style.transform = `translate(${x}px, ${y}px)`;
      return a.finished.then(() => true);
    },
    press() {
      const dot = document.getElementById("wt-pointer");
      if (!dot) return;
      dot.animate([{ boxShadow: "0 0 0 2px rgba(246,245,241,.9), 0 0 0 0 rgba(174,8,8,.55)" },
                   { boxShadow: "0 0 0 2px rgba(246,245,241,.9), 0 0 0 18px rgba(174,8,8,0)" }], { duration: 450 });
    },
    hidePointer() {
      const s = state(); s.pointer = false; save(s);
      const dot = document.getElementById("wt-pointer");
      if (dot) dot.style.display = "none";
    },
    scroll(y, ms) {
      const start = window.scrollY;
      const end = Math.max(0, Math.min(y, document.documentElement.scrollHeight - window.innerHeight));
      if (Math.abs(end - start) < 2) return Promise.resolve(end);
      const t0 = performance.now();
      return new Promise((done) => {
        function step(now) {
          const k = Math.min(1, (now - t0) / ms);
          const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
          window.scrollTo({ top: start + (end - start) * e, behavior: "instant" });
          if (k < 1) requestAnimationFrame(step); else done(end);
        }
        requestAnimationFrame(step);
      });
    },
  };
  if (document.documentElement) build();
  document.addEventListener("DOMContentLoaded", build);
})();
"""

# Load every image on a page now (the homepage and the Research page lazy-load theirs), so no scene shows an
# empty frame where a screen or a figure belongs.
EAGER_IMAGES_JS = """() => Promise.all([...document.images].map((img) => {
  img.loading = "eager";
  if (img.complete) return null;
  return new Promise((done) => {
    img.addEventListener("load", done, { once: true });
    img.addEventListener("error", done, { once: true });
    setTimeout(done, 5000);
  });
}))"""

# Numbers the captions state, and the page text that must contain them while the scene is on screen.
CHECKS = {
    "recover": (".summary-signals", "RECOVER symptom score 16 points"),
    "recover_range": (".summary-signals", "reaches the Long COVID research cutoff of 11"),
    "pem": (".summary-signals", "Symptoms after activity (DePaul screen) Screen positive"),
    "pcfs": (".summary-signals", "Grade 3: moderate functional limitations"),
    "maria_review": ("#dashboard .dash-review", "15.4× average"),
    "maria_chart": ("#dash-panel-longcovid", "15.4 times the average (estimated 15.9%) with the patient's answers; chart alone 6.1 times"),
    "maria_answer": ("#dash-panel-longcovid .dash-finding-answer", "×2.83"),
    "maria_bar_tip": ("#dash-panel-longcovid .dash-finding-answer", "15.9% with the patient's answers, 6.2% from the chart alone"),
    "maria_estimated": ("#dash-panel-longcovid", "gets a first Long COVID code (U09.9) 91 to 455 days after COVID-19"),
    "maria_day90": ("#dash-panel-timeline", "Day 90"),
    "dana_lyme": ("#dash-panel-lyme", "Facial nerve palsy"),
    "dana_band": ("#dashboard .dash-review", "1.5× average"),
    "dana_bite": ("#dash-panel-lyme", "Insect or tick bite"),
    "dana_incidence": ("#dash-panel-lyme", "72.44 reported cases per 100,000 people per year"),
    "sofia_review": ("#dashboard .dash-review", "24.6× average"),
    "sofia_chart": ("#dash-panel-fibromyalgia", "chart alone 9.6 times"),
    "sofia_check": ("#dash-panel-fibromyalgia", "matches the 2016 criteria pattern"),
    "atlas_lc_coded": ("#summary", "1 in 9"),
    "atlas_lc_map": ("#where-takeaway", "5.3% of US adults said they currently had Long COVID; state estimates ranged from 2.6% (Illinois) to 10.4% (Mississippi)"),
    "atlas_lc_who": ("#who-takeaway", "9.4% against 12.0% for men"),
    "atlas_fm_map": ("#where-takeaway", "64% (Alabama) to 79% (Pennsylvania)"),
    "atlas_fm_who": ("#who-takeaway", "below hypertension and type 2 diabetes"),
    "atlas_fm_related": ("#related-takeaway", "Ehlers-Danlos syndrome or hypermobility was coded 5.0 times as often"),
    "atlas_cost": ("#hc-two-cpf", "$116"),
    "atlas_minutes_default": ("#calc-reviewMinutes", "5"),
    "atlas_cost_10": ("#hc-two-cpf", "$233"),
    "scorer": ("#try-out", "High: probability 30.9%, 9.60 times the average"),
    "scorer_reference": ("#try-out", "Same as the reference output unm-fibromyalgia-1.0.0/sofia.json"),
    "cds": ("#cds-hooks", "Long COVID: High chart pattern, 6.1× the post-COVID average"),
    "registry": ("#registry", "expected outputs for 18 test patients"),
    "papers": ("#papers", "Four papers"),
}

# A number in a caption: digits not attached to a word (so COVID-19 and U09.9 are names, not numbers).
NUMBER = re.compile(r"(?<![\w.-])\$?\d[\d,]*(?:\.\d+)?%?")


class Recorder:
    def __init__(self, page, base):
        self.page, self.base = page, base
        self.t0 = time.monotonic()
        self.cues = []  # (start seconds from page creation, caption)
        self.clears = []  # times the caption bar was emptied for a page load (a cue ends there)
        self.scene_end = None
        self.offset = 80

    def now(self):
        return time.monotonic() - self.t0

    def wait(self, ms):
        self.page.wait_for_timeout(ms)

    def goto(self, path, offset=80):
        self.hold()
        self.clears.append(self.now())
        self.page.evaluate("window.__wt.caption('')")
        self.hide_pointer()
        self.page.goto(self.base + path, wait_until="networkidle")
        self.page.evaluate("document.fonts.ready")
        self.page.evaluate(EAGER_IMAGES_JS)
        self.offset = offset
        self.wait(400)

    def scene(self, caption, seconds):
        """Start a scene: finish the previous one (hold it for its length), then show this caption."""
        self.hold()
        self.page.evaluate("t => window.__wt.caption(t)", caption)
        self.cues.append((self.now(), caption))
        self.scene_end = self.now() + seconds

    def hold(self):
        if self.scene_end is not None:
            left = self.scene_end - self.now()
            if left > 0:
                self.wait(int(left * 1000))

    def check(self, *keys):
        for key in keys:
            sel, want = CHECKS[key]
            loc = self.page.locator(sel).first
            if loc.evaluate("e => e.tagName") == "INPUT":
                texts = [loc.input_value()]
            else:  # the text as shown, and with hidden tooltip text, which opens on hover
                texts = [loc.inner_text(), loc.text_content()]
            if not any(want in re.sub(r"\s+", " ", t or "") for t in texts):
                raise SystemExit(f"record_walkthrough: {key}: {want!r} is not on {self.page.url} ({sel}); "
                                 "update the caption or the click path")

    def top_of(self, selector, text=None):
        loc = self.page.locator(selector)
        if text:
            loc = loc.filter(has_text=text)
        return self.page.evaluate("e => e.getBoundingClientRect().top + window.scrollY", loc.first.element_handle())

    def scroll_to(self, selector=None, text=None, y=None, ms=None, extra=0):
        if y is None:
            y = self.top_of(selector, text) - self.offset + extra
        dist = abs(y - self.page.evaluate("window.scrollY"))
        ms = ms or int(min(2400, 650 + dist * 0.5))
        self.page.evaluate("([y, ms]) => window.__wt.scroll(y, ms)", [y, ms])
        self.wait(250)

    def scroll_by(self, dy, ms=None):
        self.scroll_to(y=self.page.evaluate("window.scrollY") + dy, ms=ms)

    def point(self, locator, ms=650, dx=None):
        """Move the pointer to an element (scrolling it into view first if needed). The drawn pointer travels
        first; the real mouse follows when it arrives, so a hover tooltip opens as the pointer gets there."""
        box = locator.bounding_box()
        if box is None or box["y"] < 70 or box["y"] + box["height"] > SIZE["height"] - 90:
            y = self.page.evaluate("e => e.getBoundingClientRect().top + window.scrollY", locator.element_handle())
            self.scroll_to(y=y - 200)
            box = locator.bounding_box()
        x = box["x"] + (dx if dx is not None else min(box["width"] / 2, 120))
        y = box["y"] + box["height"] / 2
        self.page.evaluate("([x, y, ms]) => window.__wt.move(x, y, ms)", [x, y, ms])
        self.page.mouse.move(x, y, steps=4)
        self.wait(200)

    def point_text(self, selector, text, ms=800):
        """Move the pointer to a phrase inside an element (one text node), without moving the real mouse."""
        box = self.page.evaluate("""([sel, text]) => {
          const walk = document.createTreeWalker(document.querySelector(sel), NodeFilter.SHOW_TEXT);
          for (let n = walk.nextNode(); n; n = walk.nextNode()) {
            const i = n.data.indexOf(text);
            if (i < 0) continue;
            const r = document.createRange();
            r.setStart(n, i);
            r.setEnd(n, i + text.length);
            const b = r.getBoundingClientRect();
            return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
          }
          return null;
        }""", [selector, text])
        if box is None:
            raise SystemExit(f"record_walkthrough: {text!r} is not in {selector} on {self.page.url}")
        self.page.evaluate("([x, y, ms]) => window.__wt.move(x, y, ms)", [box["x"], box["y"], ms])
        self.wait(200)

    def click(self, locator, pause=350):
        self.point(locator)
        self.wait(pause)
        self.page.evaluate("window.__wt.press()")
        self.wait(180)
        locator.click()

    def choose(self, select, pause=450, **option):
        """Pick an option in a <select>, the way click() presses a button (the native list is not drawn)."""
        self.point(select)
        self.wait(pause)
        self.page.evaluate("window.__wt.press()")
        self.wait(180)
        select.select_option(**option)

    def hide_pointer(self):
        self.page.evaluate("window.__wt.hidePointer()")
        self.page.mouse.move(*REST)


def walkthrough(r: Recorder):
    pg = r.page

    # ---------------------------------------------------------------- homepage
    r.goto("/?notour", offset=24)
    r.scene("Undiagnosed No More looks for patients whose invisible illness, from Long COVID and ME/CFS to lupus "
            "and depression, is missing from the health record. Every patient shown is synthetic.", 7)
    r.wait(1500)
    r.scroll_to(".hub", extra=-16)

    r.scene("U.S. government data trains the UNOM AI models, which serve four users: clinicians, patients, "
            "policymakers, and developers. Each part of the picture opens its page.", 9)
    for zone in ("data", "ai", "clinicians", "policy", "patients", "developers"):
        r.point(pg.locator(f".hub-zone-{zone}"), ms=700)
        r.wait(350)
    r.hide_pointer()

    # ---------------------------------------------------------------- patient app
    # The app opens on the first demo person, Maria, at page 1 of the questionnaire with her answers filled in.
    r.goto("/patient/")
    pg.wait_for_url("**/patient/#maria/qp-1")
    pg.wait_for_selector("#demo-app-loader", state="hidden")
    nxt = pg.locator("#step-next")

    def next_pages(n):
        for _ in range(n):
            pg.evaluate("window.__wt.press()")
            r.wait(150)
            nxt.click()
            r.wait(380)

    r.scene("The patient app opens on Maria's synthetic answers. Each page is one part of a validated "
            "questionnaire.", 7)
    r.wait(700)
    r.point(pg.locator(".demo-btn", has_text="Maria"), ms=800)
    r.wait(900)
    r.click(nxt)
    r.wait(700)
    r.hide_pointer()
    r.scroll_by(260)

    r.scene("Her answers to the NIH RECOVER symptom questions and the DePaul questions on crashes after activity "
            "are already filled in.", 7.5)
    r.scroll_to(y=0, ms=700)
    r.click(nxt)
    r.wait(1000)
    r.click(nxt)
    r.wait(800)
    r.hide_pointer()
    r.scroll_by(200)

    r.scene("Next steps on through daily life and the condition self-checks, where she chose the Long COVID "
            "check.", 7)
    r.scroll_to(y=0, ms=600)
    r.point(nxt, ms=500)
    next_pages(8)
    r.hide_pointer()
    r.scroll_by(240)

    r.scene("Her summary: 16 points on the RECOVER symptom score, which reaches the research cutoff of 11, a "
            "positive DePaul screen, and daily-life grade 3. Each card says what to discuss.", 9)
    r.scroll_to(y=0, ms=600)
    r.point(nxt, ms=400)
    next_pages(2)
    pg.wait_for_url("**/patient/#maria/qp-14")
    pg.wait_for_selector(".summary-signals .summary-signal")
    r.check("recover", "recover_range", "pem", "pcfs")
    r.hide_pointer()
    r.scroll_to(".summary-signals-heading", extra=-20)
    r.wait(2600)
    r.scroll_by(260)

    r.scene("Patterns in my record runs the same nine models on her synthetic record, on the phone, and says in "
            "plain words what it finds. Patients never see a probability.", 8)
    r.click(pg.get_by_role("button", name="Patterns in my record"))
    pg.wait_for_selector("#record-body .card")
    r.wait(900)
    r.hide_pointer()
    r.scroll_to("#record-body", extra=-30)
    r.wait(1800)
    r.scroll_by(260)
    r.wait(600)
    r.scroll_to(y=0, ms=600)
    r.click(pg.get_by_role("button", name="Back to questionnaire").first)
    pg.wait_for_selector(".summary-signals .summary-signal")
    r.wait(300)
    r.hide_pointer()
    r.scroll_to(".summary-actions", extra=-260)

    r.scene("Print makes her visit summary. Download saves her answers as a FHIR file that clinic software can "
            "read.", 6.5)
    r.point(pg.locator(".summary-actions button", has_text="Print"), ms=800)
    r.wait(1300)
    r.point(pg.locator(".summary-actions button", has_text="Download"), ms=800)

    r.scene("The patient app is the only part of the site in Spanish. Español in the bar switches it, and English "
            "switches it back.", 7)
    r.click(pg.locator("a.lang-link", has_text="Español"))
    pg.wait_for_url(lambda u: "lang=es" in u)
    pg.wait_for_load_state("networkidle")
    r.wait(2000)
    r.click(pg.locator("a.lang-link", has_text="English"))
    pg.wait_for_url(lambda u: "lang=en" in u)
    pg.wait_for_load_state("networkidle")
    r.wait(600)

    r.scene("Send to my clinician (demo) opens the clinician view with her answers attached.", 5)
    r.scroll_to(".summary-actions", extra=-300)
    r.wait(300)
    r.click(pg.get_by_role("button", name="Send to my clinician (demo)"))
    pg.wait_for_url("**/clinician/**")
    pg.wait_for_load_state("networkidle")
    r.offset = 80
    r.wait(700)

    # ---------------------------------------------------------------- clinician view
    r.hide_pointer()
    r.scroll_to(y=0, ms=600)
    r.scene("The clinician view opens on Maria's chart. Needs review marks Long COVID High: 15.4 times the average "
            "with her answers, 6.1 times from the chart alone.", 8)
    r.check("maria_review", "maria_chart")
    r.wait(1100)
    r.point(pg.locator("button.dash-review-row").first, ms=900)
    r.wait(900)
    r.scroll_by(150, ms=900)
    r.point_text("#dash-panel-longcovid .dash-panel-head", "chart alone 6.1 times", ms=900)

    r.scene("From the patient: Review responses opens her answers from the patient app, with her RECOVER score, "
            "her screen result, her daily-life grade, and her own words.", 7.5)
    r.click(pg.locator("summary.dash-review-responses"))
    r.wait(700)
    r.hide_pointer()
    r.scroll_to("#dash-patient-title", extra=-20)
    r.wait(1500)
    r.scroll_by(240)

    r.scene("The Long COVID tab shows each finding with an arrow, an odds ratio, and a bar on one fixed scale. The "
            "first row is her RECOVER answer, which multiplies the odds by 2.83.", 8.5)
    r.check("maria_answer")
    r.scroll_to("#dash-panel-longcovid .dash-findings", extra=-90)
    r.wait(1300)
    r.point(pg.locator("#dash-panel-longcovid .dash-finding-answer .dash-finding-label"), ms=900)

    r.scene("Hovering a bar shows its effect: an estimate of 15.9% with her answers against 6.2% from the chart "
            "alone.", 6.5)
    r.check("maria_bar_tip")
    r.point(pg.locator("#dash-panel-longcovid .dash-finding-answer .dash-weight"), ms=800)

    r.scene("Hovering estimated 15.9% shows what is estimated: the chance of a first Long COVID code 91 to 455 days "
            "after COVID-19.", 7)
    r.check("maria_estimated")
    r.hide_pointer()
    r.scroll_to("#dash-panel-longcovid .dash-tip-word", text="estimated 15.9%", extra=-100)
    r.wait(200)
    r.point(pg.locator("#dash-panel-longcovid .dash-tip-word", has_text="estimated 15.9%"), ms=800, dx=40)

    r.scene("The timeline shows every dated visit, diagnosis, test, and prescription, with the COVID-19 index, day "
            "90, and the scoring date.", 7)
    r.hide_pointer()
    r.click(pg.locator("#dash-tab-timeline"))
    r.wait(700)
    r.check("maria_day90")
    r.hide_pointer()
    r.scroll_to("#dash-tab-timeline", extra=-10)
    r.wait(1800)
    r.scroll_by(420, ms=1400)

    r.scene("Dana: the Lyme disease model marks her chart Elevated, 1.5 times the average, from an April visit "
            "for an insect or tick bite and a rash, treated with doxycycline.", 7)
    r.scroll_to(y=0, ms=1000)
    r.click(pg.locator("button.demo-patient-button", has_text="Dana"))
    r.wait(1000)
    r.check("dana_band", "dana_bite")
    r.hide_pointer()
    r.scroll_to("#dash-tab-lyme", extra=-10)

    r.scene("Beside it: knee pain and facial nerve palsy from her chart, and her county's reported incidence, "
            "72.44 cases per 100,000 people a year.", 7)
    r.check("dana_lyme", "dana_incidence")
    r.scroll_by(220)

    r.scene("Sofia: six models flag her chart. Fibromyalgia is High, 24.6 times the average with her answers and "
            "9.6 times from the chart alone.", 7.5)
    r.scroll_to(y=0, ms=1000)
    r.click(pg.locator("button.demo-patient-button", has_text="Sofia"))
    r.wait(800)
    r.check("sofia_review", "sofia_chart")
    r.point(pg.locator("button.dash-review-row").first, ms=800)
    r.wait(900)
    r.hide_pointer()
    r.scroll_to("#dash-tab-fibromyalgia", extra=-10)

    r.scene("Her answers enter through her fibromyalgia self-check, which matches the pattern of the 2016 "
            "criteria.", 6.5)
    r.check("sofia_check")
    r.point(pg.locator("#dash-panel-fibromyalgia .dash-finding-answer .dash-finding-label"), ms=900)
    r.wait(1300)
    r.hide_pointer()
    r.scroll_to("#dash-panel-fibromyalgia .dash-subtitle", text="From the patient", extra=-120)

    # ---------------------------------------------------------------- Atlas
    # The map and chart scenes have one-line captions, so a whole map or chart fits above the caption bar.
    r.goto("/atlas/?condition=longcovid", offset=90)
    r.scene("The Atlas shows one condition at a time. For Long COVID, 1 in 9 adults who have ever had it carry "
            "its code in their health record.", 7)
    r.check("atlas_lc_coded")
    r.wait(600)
    r.point(pg.locator("#picker a[data-slug=longcovid]"), ms=900)
    r.wait(1000)
    r.point(pg.locator("#summary li").first, ms=900)

    r.scene("State map (CDC Household Pulse Survey): 5.3% of US adults currently have Long COVID, 2.6% in Illinois "
            "to 10.4% in Mississippi.", 7.5)
    r.check("atlas_lc_map")
    r.hide_pointer()
    r.scroll_to("#where-title", extra=-10)
    r.wait(1500)
    r.scroll_to("#where-legend", extra=20)

    r.scene("Who goes uncoded, by sex, age group, and race and ethnicity: 9.4% of women's Long COVID is coded, "
            "against 12.0% of men's.", 6.5)
    r.check("atlas_lc_who")
    r.scroll_to("#who-title", extra=-10)
    r.wait(1500)
    r.scroll_to("#who-chart", extra=20)

    r.scene("Fibromyalgia by state: the share of people who report it who have a code, from 64% in Alabama to 79% "
            "in Pennsylvania.", 7.5)
    r.scroll_to(y=0, ms=1200)
    r.click(pg.locator("#picker a[data-slug=fibromyalgia]"))
    r.wait(900)
    r.check("atlas_fm_map")
    r.hide_pointer()
    r.scroll_to("#where-legend", extra=20)

    r.scene("Who goes uncoded: in every age, sex, and race and ethnicity group, a smaller share is coded than for "
            "hypertension and type 2 diabetes.", 8)
    r.check("atlas_fm_who")
    r.scroll_to("#who-title", extra=-10)
    r.wait(1700)
    r.scroll_to("#who-chart", extra=20)

    r.scene("What else is in the record: in people who report fibromyalgia, Ehlers-Danlos syndrome or "
            "hypermobility was coded 5.0 times as often as in other survey respondents.", 6)
    r.check("atlas_fm_related")
    r.scroll_to("#related-title", extra=-10)
    r.wait(1400)
    r.scroll_to("#related-chart-title", extra=-20)

    r.scene("Back to Long COVID for the cost calculator: with the default assumptions, a two-step screen costs $116 "
            "in clinician time for each later-coded patient it finds.", 8)
    r.scroll_to(y=0, ms=1100)
    r.click(pg.locator("#picker a[data-slug=longcovid]"))
    r.wait(600)
    r.check("atlas_cost", "atlas_minutes_default")
    r.hide_pointer()
    r.scroll_to("#cost-title", extra=-10, ms=1800)
    r.wait(700)
    r.point(pg.locator("#hc-two-cpf"), ms=900)

    r.scene("Every assumption can be changed. With 10 minutes of clinician review per patient instead of 5, the "
            "two-step screen costs $233 for each patient found.", 9)
    r.click(pg.locator("#calc-details summary"))
    r.wait(500)
    r.scroll_to("#calc-details", extra=-10)
    field = pg.locator("#calc-reviewMinutes")
    r.click(field)
    pg.keyboard.press("Control+A")
    r.wait(300)
    pg.keyboard.type("10", delay=220)
    pg.keyboard.press("Tab")
    r.wait(1000)
    r.check("atlas_cost_10")
    r.hide_pointer()
    r.scroll_to("#cost-title", extra=200)
    r.wait(400)
    r.point(pg.locator("#hc-two-cpf"), ms=800)

    # ---------------------------------------------------------------- developers
    r.goto("/developers/", offset=90)
    r.scene("The developer documentation starts with how the pieces fit: the model files, one scorer, and the "
            "places it runs.", 6.5)
    r.scroll_to("figure.flow", extra=50)
    r.wait(400)
    for i in range(3):
        r.point(pg.locator("figure.flow .flow-col").nth(i), ms=750)
        r.wait(500)

    r.scene("Try the scorer runs it in the browser on a synthetic test patient. Sofia with the fibromyalgia model "
            "scores High, 9.60 times the average, the same as the reference output.", 8)
    r.click(pg.locator("nav.dev-nav a[href='#try']"))
    r.wait(900)
    r.choose(pg.locator("#try-form select[name=model]"), label="Fibromyalgia 1.0.0")
    r.wait(700)
    r.choose(pg.locator("#try-form select[name=patient]"), value="sofia")
    r.wait(800)
    r.check("scorer", "scorer_reference")
    r.point(pg.locator("#try-out .try-check"), ms=800)

    r.scene("The CDS Hooks service scores a chart sent from an EHR and answers with a card for each flagged "
            "condition. For Maria, one card: Long COVID, High, 6.1 times the average.", 7)
    r.click(pg.locator("nav.dev-nav a[href='#cds-hooks']"))
    r.wait(1200)
    r.check("cds")
    r.hide_pointer()
    r.wait(500)
    r.scroll_to("#cds-hooks p", text="Maria's expected results", extra=-20)

    # The page scrolls itself (smoothly) to a section picked in its contents; wait for it to stop.
    r.scene("The model registry lists each versioned model file with its model card and expected outputs for 18 "
            "test patients.", 6.5)
    r.click(pg.locator("nav.dev-nav a[href='#registry']"))
    r.wait(1600)
    r.check("registry")
    r.point(pg.locator("#registry .model-entry h3").first, ms=700)
    r.scroll_by(200)
    r.point(pg.locator("#registry .model-entry a[href='#vectors']").first, ms=700)

    # ---------------------------------------------------------------- research
    r.goto("/about/", offset=136)
    r.scene("The About page shows the data sources, the conditions, the models, the four papers, and the team.", 7)
    r.check("papers")
    r.wait(600)
    r.scroll_to("#sources-title")
    r.wait(1200)
    r.click(pg.locator("a[href='#ai']").first)
    r.wait(1300)
    r.hide_pointer()
    r.scroll_to("#papers-title")
    r.wait(900)
    r.scroll_to("#figures-title")

    r.goto("/?notour", offset=24)
    r.scene("Undiagnosed No More: the patient app, the clinician view, the Atlas, and the developer documentation, "
            "at undiagnosednomore.org.", 5)
    r.hold()


def unchecked_numbers(captions):
    """Numbers in the captions that no CHECKS entry contains."""
    wanted = " ".join(want for _, want in CHECKS.values())
    return [(c, n) for c in captions for n in NUMBER.findall(c) if n.rstrip(".,") not in wanted]


def scene_captions():
    """The captions in scene order, read from walkthrough() without recording (for the number check)."""
    src = Path(__file__).read_text(encoding="utf-8")
    body = src[src.index("def walkthrough("):src.index("def unchecked_numbers(")]
    out = []
    for m in re.finditer(r"r\.scene\(((?:\s*\"(?:[^\"\\]|\\.)*\"\s*)+),", body):
        out.append("".join(json.loads(s) for s in re.findall(r"\"(?:[^\"\\]|\\.)*\"", m.group(1))))
    return out


# ---------------------------------------------------------------- outputs

def stamp(t, vtt=True):
    ms = int(round(t * 1000))
    h, ms = divmod(ms, 3600_000)
    m, ms = divmod(ms, 60_000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d}.{ms:03d}" if vtt else f"{m}:{s:02d}"


def cue_times(cues, clears, lead, total):
    """Start and end of each cue in the trimmed video: a cue ends when the next one starts, or earlier, when the
    caption bar was emptied for a page load."""
    starts = [c[0] for c in cues]
    out = []
    for i, start in enumerate(starts):
        end = starts[i + 1] - 0.05 if i + 1 < len(starts) else lead + total
        end = min([end] + [c for c in clears if start < c < end])
        out.append((start - lead, min(end - lead, total)))
    return out


def write_vtt(path, cues, times):
    lines = ["WEBVTT", ""]
    for n, ((start, end), (_, text)) in enumerate(zip(times, cues), 1):
        # Placed near the top of the frame, so the cue does not cover the caption bar burned into the video.
        lines += [str(n), f"{stamp(max(0, start))} --> {stamp(end)} line:6% position:50% align:center size:92%", text, ""]
    path.write_text("\n".join(lines), encoding="utf-8")


def duration(path):
    out = subprocess.run([FFMPEG, "-hide_banner", "-i", str(path)], capture_output=True, text=True).stderr
    h, m, s = re.search(r"Duration: (\d+):(\d+):([\d.]+)", out).groups()
    return int(h) * 3600 + int(m) * 60 + float(s)


def caption_onset(raw, near):
    """When the first caption bar appears in the raw recording. The recording starts a fraction of a second away
    from the script's clock, so the video is trimmed at this frame and the cues stay on their scenes."""
    out = subprocess.run([FFMPEG, "-hide_banner", "-loglevel", "error", "-i", str(raw), "-t", f"{near + 3:.2f}",
                          "-vf", "fps=100,crop=8:8:4:708,scale=1:1,format=gray", "-f", "rawvideo", "-"],
                         capture_output=True, check=True).stdout
    dark = [i for i, b in enumerate(out) if b < 100]
    return dark[0] / 100 if dark else near


def encode(raw, mp4, lead):
    for crf in (23, 25, 27, 29, 31):
        subprocess.run([FFMPEG, "-hide_banner", "-loglevel", "error", "-y", "-i", str(raw), "-ss", f"{lead:.3f}",
                        "-vf", "fps=25,scale=1280:720:flags=lanczos,format=yuv420p", "-c:v", "libx264", "-preset", "slow",
                        "-tune", "stillimage", "-crf", str(crf), "-profile:v", "high", "-level", "4.0", "-g", "75",
                        "-an", "-movflags", "+faststart", str(mp4)], check=True)
        if mp4.stat().st_size < MAX_BYTES * 0.95:
            return crf
    raise SystemExit(f"record_walkthrough: {mp4} is still over 20 MB at CRF 31")


def asset_versions():
    """The favicon, stylesheet, and script URLs the other site pages use, and the poster the homepage tour uses."""
    home = (SITE / "index.html").read_text(encoding="utf-8")
    evidence = (SITE / "about" / "index.html").read_text(encoding="utf-8")
    icon = re.search(r'<link rel="icon" href="(/favicon\.svg\?v=[^"]+)"', home).group(1)
    v = {name: re.search(rf'"{re.escape(path)}\?v=([^"]+)"', evidence).group(1)
         for name, path in (("nav_css", "/shared/site-nav.css"), ("landing", "/landing.css"),
                            ("settings", "/homepage-settings.js"), ("nav_js", "/shared/site-nav.js"))}
    poster = re.search(r'data-poster="(/images/homepage/walkthrough-poster\.webp[^"]*)"', home).group(1)
    return icon, v, poster


def minutes_phrase(total):
    whole, sec = divmod(int(round(total)), 60)
    return f"{whole} minutes {sec} seconds" if sec else f"{whole} minutes"


def write_page(path, cues, times, total, version):
    icon, v, poster = asset_versions()
    rows = "\n".join(f'<li><span class="wt-time">{stamp(max(0, s), vtt=False)}</span> '
                     f'<span class="wt-text">{html.escape(text)}</span></li>'
                     for (s, _), (_, text) in zip(times, cues))
    page = f"""<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
    <meta name="theme-color" content="#09252f">
    <meta name="description" content="Watch Undiagnosed No More: the demo video on synthetic patients ({minutes_phrase(total)}), with captions and a transcript, and the slide deck.">
    <link rel="icon" href="{icon}" type="image/svg+xml">
    <link rel="stylesheet" href="/shared/site-nav.css?v={v['nav_css']}">
    <script src="/homepage-settings.js?v={v['settings']}"></script>
    <link rel="stylesheet" href="/landing.css?v={v['landing']}">
    <link rel="stylesheet" href="/walkthrough/walkthrough.css?v={version}">
    <title>{TITLE_EN} | Undiagnosed No More</title>
  </head>
  <body data-door="walkthrough">
    <!-- Generated by web/tools/record_walkthrough.py from its scene list. Do not edit by hand; rerun the script. -->
    <main id="main">
      <header class="page-head">
        <div class="shell">
          <h1>{TITLE_EN}</h1>
        </div>
      </header>
      <section class="section wt-video-section" id="video" aria-labelledby="video-title">
        <div class="shell">
          <h2 id="video-title">Demo video</h2>
          <p class="lede">The video follows Maria through the patient app and the clinician view, then shows Dana's Lyme card, Sofia's fibromyalgia card, the Atlas, the developer documentation, and the Data &amp; AI page. It has no sound. Each scene has a caption on screen; the caption file and the transcript below give the same text.</p>
          <video class="wt-video" controls preload="metadata" playsinline width="1280" height="720" poster="{poster}">
            <source src="/media/walkthrough.mp4?v={version}" type="video/mp4">
            <track kind="captions" src="/media/walkthrough.en.vtt?v={version}" srclang="en" label="English">
          </video>
          <p class="wt-meta">{minutes_phrase(total)}, 1280 x 720, no audio. <a href="/media/walkthrough.mp4?v={version}" download>Download the MP4</a>.</p>
        </div>
      </section>
      <section class="section" id="transcript" aria-labelledby="transcript-title">
        <div class="shell narrow">
          <h2 id="transcript-title">Transcript</h2>
          <ol class="wt-transcript">
{rows}
          </ol>
        </div>
      </section>
      <section class="section" id="deck" aria-labelledby="deck-title">
        <div class="shell">
          <h2 id="deck-title">Slide deck</h2>
          <p class="lede">The project in slides, for viewing in the browser or as a PDF.</p>
          <p class="deck-links">
            <a class="button button-dark" href="/deck/">View the slides</a>
            <a class="button button-outline" href="/deck/undiagnosed-no-more-deck.pdf">Download the PDF</a>
          </p>
        </div>
      </section>
    </main>
    <script src="/shared/site-nav.js?v={v['nav_js']}" defer></script>
  </body>
</html>
"""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(page, encoding="utf-8")


def free_port():
    for port in range(8951, 8991):
        with socket.socket() as s:
            if s.connect_ex(("127.0.0.1", port)) != 0:
                return port
    raise SystemExit("no free port from 8951 to 8990")


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--base", help="site to record (default: serve web/web on a free local port)")
    ap.add_argument("--out", type=Path, default=SITE, help="site folder to write media/ and walkthrough/ into")
    ap.add_argument("--version", default=time.strftime("%Y%m%d"), help="cache-busting version for the media URLs")
    ap.add_argument("--keep-raw", type=Path, help="also keep the raw Playwright recording here")
    ap.add_argument("--cues", type=Path, help="also write the cue list (start, end, caption) here as JSON")
    args = ap.parse_args()

    missing = unchecked_numbers(scene_captions())
    if missing:
        raise SystemExit("record_walkthrough: caption numbers with no CHECKS entry: "
                         + "; ".join(f"{n} in {c!r}" for c, n in missing))

    server = None
    base = (args.base or "").rstrip("/")
    if not base:
        port = free_port()
        server = subprocess.Popen([sys.executable, "-m", "http.server", str(port), "--bind", "127.0.0.1"],
                                  cwd=SITE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        base = f"http://127.0.0.1:{port}"
        for _ in range(50):
            try:
                urllib.request.urlopen(base + "/", timeout=1)
                break
            except OSError:
                time.sleep(0.2)
    tmp = Path(tempfile.mkdtemp(prefix="unom-walkthrough-"))
    try:
        print(f"recording from {base}")
        with sync_playwright() as p:
            browser = p.chromium.launch(executable_path=CHROME)
            ctx = browser.new_context(viewport=SIZE, device_scale_factor=1, color_scheme="light", locale="en-US",
                                      reduced_motion="no-preference", record_video_dir=str(tmp), record_video_size=SIZE)
            ctx.add_init_script(OVERLAY_JS)
            page = ctx.new_page()
            page.on("pageerror", lambda e: print(f"page error on {page.url}: {e}", file=sys.stderr))
            rec = Recorder(page, base)
            walkthrough(rec)
            end = rec.now()
            video = page.video
            ctx.close()
            raw = Path(video.path())
            browser.close()
        lead = rec.cues[0][0]
        onset = caption_onset(raw, lead)
        print(f"raw recording {raw.name}: {duration(raw):.1f} s; wall clock {end:.1f} s; first caption at {lead:.2f} s "
              f"on the clock, {onset:.2f} s in the recording")
        if args.keep_raw:
            shutil.copy(raw, args.keep_raw)
        media = args.out / "media"
        media.mkdir(parents=True, exist_ok=True)
        mp4 = media / "walkthrough.mp4"
        crf = encode(raw, mp4, onset)
        total = duration(mp4)
        times = cue_times(rec.cues, rec.clears, lead, total)
        write_vtt(media / "walkthrough.en.vtt", rec.cues, times)
        write_page(args.out / "walkthrough" / "index.html", rec.cues, times, total, args.version)
        if args.cues:
            args.cues.write_text(json.dumps([{"start": s, "end": e, "caption": c[1]}
                                             for (s, e), c in zip(times, rec.cues)], indent=1))
        print(f"wrote {mp4.relative_to(args.out.parent) if args.out == SITE else mp4}: {total:.1f} s "
              f"({minutes_phrase(total)}), {mp4.stat().st_size / 1024 / 1024:.2f} MB (CRF {crf}), {len(rec.cues)} scenes")
        print("wrote media/walkthrough.en.vtt, walkthrough/index.html")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
        if server:
            server.terminate()
            server.wait(timeout=10)


if __name__ == "__main__":
    main()
