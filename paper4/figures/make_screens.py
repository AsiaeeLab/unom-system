#!/usr/bin/env python3
"""Figure 2 of Paper 4: the patient demonstration (A) and the clinician view (B) for the synthetic patient Maria.

Serves web/web on a free local port, captures both screens with Playwright and Chrome at device scale 2, crops each
to the application area (below the site's navigation bar, so no project name or logo appears), and writes
paper4/figures/screens.png with bold panel labels A. and B.
Usage: python3 paper4/figures/make_screens.py
"""
import io
import os
import socket
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
SITE = ROOT / "web" / "web"
OUT = Path(__file__).resolve().parent / "screens.png"
CHROME = os.environ.get("CHROME", "/usr/bin/google-chrome")
DPR = 2


def port():
    for p in range(8920, 8990):
        with socket.socket() as s:
            if s.connect_ex(("127.0.0.1", p)) != 0:
                return p
    raise SystemExit("no free port")


def element_top(pg, js):
    return pg.evaluate(js)


def shot(pg, x0, y0, x1, y1):
    pg.add_style_tag(content="header, nav.unm-sitebar, .unm-sitebar, .unm-stepstrip, .preview-banner { position: static !important; }")
    pg.wait_for_timeout(200)
    im = Image.open(io.BytesIO(pg.screenshot(full_page=True))).convert("RGB")
    return im.crop((int(x0 * DPR), int(y0 * DPR), int(x1 * DPR), int(y1 * DPR)))


def rect(pg, js):
    r = pg.evaluate(js)
    if not r:
        raise SystemExit(f"not found: {js[:80]}")
    return r


def main():
    p = port()
    server = subprocess.Popen([sys.executable, "-m", "http.server", str(p), "--bind", "127.0.0.1"], cwd=SITE,
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    base = f"http://127.0.0.1:{p}"
    for _ in range(50):
        try:
            urllib.request.urlopen(base + "/", timeout=1)
            break
        except OSError:
            time.sleep(0.2)
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch(executable_path=CHROME)
            # A. Patient demonstration, first page of the symptom check, with Maria's demonstration answers.
            ctx = browser.new_context(viewport={"width": 760, "height": 1300}, device_scale_factor=DPR, color_scheme="light")
            pg = ctx.new_page()
            pg.goto(f"{base}/patient/#maria", wait_until="networkidle")
            pg.wait_for_timeout(1200)
            r = rect(pg, """() => { const h = [...document.querySelectorAll('h1')].find(e => /Explore the patient app/.test(e.textContent));
                                   if (!h) return null; const m = h.closest('main') || h.parentElement; const a = h.getBoundingClientRect();
                                   const b = m.getBoundingClientRect(); return {x: b.left, w: b.width, y: a.top + scrollY}; }""")
            a = shot(pg, max(0, r["x"] - 12), r["y"] - 16, min(760, r["x"] + r["w"] + 12), r["y"] - 16 + 1060)
            ctx.close()
            # B. Clinician view for Maria: condition review, the patient's answers, and the Long COVID tab.
            ctx = browser.new_context(viewport={"width": 1360, "height": 1300}, device_scale_factor=DPR, color_scheme="light")
            pg = ctx.new_page()
            pg.goto(f"{base}/clinician/#maria", wait_until="networkidle")
            pg.wait_for_timeout(1200)
            r = rect(pg, """() => { const d = document.querySelector('#dashboard'); if (!d) return null; const b = d.getBoundingClientRect();
                                   return {x: b.left, w: b.width, y: b.top + scrollY}; }""")
            b = shot(pg, r["x"] - 1, r["y"], r["x"] + r["w"] + 1, r["y"] + 1060)
            ctx.close()
            browser.close()
    finally:
        server.terminate()
        server.wait(timeout=10)
    # compose at a common height with bold panel labels
    h = max(a.height, b.height)
    a = a.resize((int(a.width * h / a.height), h))
    b = b.resize((int(b.width * h / b.height), h))
    gap, label = 60, 90
    canvas = Image.new("RGB", (a.width + gap + b.width, h + label), "white")
    canvas.paste(a, (0, label))
    canvas.paste(b, (a.width + gap, label))
    font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 64)
    d = ImageDraw.Draw(canvas)
    d.text((0, 6), "A.", fill="black", font=font)
    d.text((a.width + gap, 6), "B.", fill="black", font=font)
    canvas.save(OUT)
    print("wrote", OUT, canvas.size)


if __name__ == "__main__":
    main()
