// Atlas: one condition at a time. The selector lists the conditions in /atlas/data/conditions/index.json, and
// everything below it is drawn from that condition's file (analysis/build_atlas_data.py). Hand-built SVG, no
// libraries, no inline styles, no eval.
import { DEFAULTS, compute } from "./calc.js";
import { conditionHref, resolveCondition } from "./route.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const DATA = "/atlas/data/conditions/";

// ---------- small helpers ----------

function svgEl(tag, attrs = {}, text) {
  const e = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v !== undefined && v !== null && v !== false) e.setAttribute(k, String(v));
  }
  if (text !== undefined && text !== null) e.textContent = String(text);
  return e;
}

function htmlEl(tag, attrs = {}, children = []) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "text") e.textContent = String(v);
    else e.setAttribute(k, String(v));
  }
  for (const c of [].concat(children)) {
    if (c === null || c === undefined) continue;
    e.append(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return e;
}

const $ = (id) => document.getElementById(id);
function setText(id, text) {
  const e = $(id);
  if (e) e.textContent = text;
}

const isNum = (x) => typeof x === "number" && Number.isFinite(x);
const one = (x) => (isNum(x) ? x.toLocaleString("en-US", { maximumFractionDigits: 1 }) : "not shown");
const int = (x) => (isNum(x) ? Math.round(x).toLocaleString("en-US") : "not shown");
const dec = (x, d = 2) => (isNum(x) ? x.toFixed(d) : "not shown");
const pct = (x, d = 0) => (isNum(x) ? `${(x * 100).toFixed(d)}%` : "not shown");
const money = (x) => {
  if (!isNum(x)) return "not defined";
  const s = `$${Math.abs(Math.round(x)).toLocaleString("en-US")}`;
  return x < -0.5 ? `−${s}` : s;
};

/** A value in its block's unit: proportions as percents, percents as published, rates per 100,000. */
function val(v, unit, digits = 0) {
  if (!isNum(v)) return "not shown";
  if (unit === "proportion") return pct(v, digits);
  if (unit === "percent") return `${v.toFixed(digits)}%`;
  return one(v);
}
const range = (lo, hi, unit, digits) => `${val(lo, unit, digits)} to ${val(hi, unit, digits)}`;
const times = (x) => `${dec(x, 1)}×`;

const WHY = {
  suppressed: "not shown for privacy",
  complement: "not shown for privacy",
  none: "too few participants",
};

let uid = 0;
const nextId = (p) => `${p}-${++uid}`;

async function loadJSON(name) {
  const r = await fetch(`${DATA}${name}.json`, { cache: "no-cache" });
  if (!r.ok) throw new Error(`${name}.json: HTTP ${r.status}`);
  return r.json();
}

function showError(id, msg) {
  const box = $(id);
  if (box) box.replaceChildren(htmlEl("p", { class: "chart-error", text: msg }));
}

/** One source line: "Source. <text>", with a paper title in <cite> where the data block names one. */
function sourceLine(id, s) {
  const box = $(id);
  if (!box) return;
  const parts = [htmlEl("strong", { text: "Source." }), " "];
  if (s && s.authors && s.title && s.after) {
    parts.push(`${s.text} ${s.authors}, `, htmlEl("cite", { text: s.title }), ` ${s.after}`);
  } else if (s && s.authors && s.title) {
    parts.push(`${s.authors}, `, htmlEl("cite", { text: s.title }), `, ${s.text}`);
  } else if (s) {
    parts.push(s.text);
  }
  box.replaceChildren(...parts);
}

function table(caption, headers, rows) {
  const t = htmlEl("table");
  t.append(htmlEl("caption", { text: caption }));
  const thead = htmlEl("thead");
  thead.append(htmlEl("tr", {}, headers.map((h) => htmlEl("th", { scope: "col", class: h.num ? "num" : null, text: h.label }))));
  const tbody = htmlEl("tbody");
  for (const r of rows) {
    const tr = htmlEl("tr", { class: r.header ? "group-row" : null });
    if (r.header) {
      tr.append(htmlEl("th", { scope: "rowgroup", colspan: headers.length, text: r.header }));
    } else {
      r.forEach((c, i) => tr.append(htmlEl(i === 0 ? "th" : "td", {
        scope: i === 0 ? "row" : null, class: headers[i].num ? "num" : null, text: c,
      })));
    }
    tbody.append(tr);
  }
  t.append(thead, tbody);
  return t;
}

function legend(id, items) {
  $(id).replaceChildren(...items.map((it) => htmlEl("span", { class: "legend-item" }, [
    htmlEl("span", { class: `sw ${it.sw}`, "aria-hidden": "true" }), it.label,
  ])));
}

// A row of toggle buttons; picking one presses it and calls onPick(index). Hidden when there is one item.
function toggles(id, labels, onPick) {
  const box = $(id);
  box.hidden = labels.length < 2;
  const buttons = labels.map((label, i) => {
    const b = htmlEl("button", { type: "button", class: "toggle", "aria-pressed": String(i === 0), text: label });
    b.addEventListener("click", () => {
      buttons.forEach((x, j) => x.setAttribute("aria-pressed", String(j === i)));
      onPick(i);
    });
    return b;
  });
  box.replaceChildren(...(labels.length < 2 ? [] : buttons));
}

// ---------- tooltip ----------

const tip = $("tooltip");

function placeTip(x, y) {
  const pad = 14;
  const w = tip.offsetWidth;
  const h = tip.offsetHeight;
  let left = x + pad;
  let top = y + pad;
  if (left + w > window.innerWidth - 8) left = Math.max(8, x - w - pad);
  if (top + h > window.innerHeight - 8) top = Math.max(8, y - h - pad);
  // CSSOM property assignment (allowed under a strict style-src policy).
  tip.style.left = `${left}px`;
  tip.style.top = `${top}px`;
}

// The tooltip shows a mark's text, or a list of nodes (the weekly chart's readout). One opened by keyboard focus
// is anchored to the focused chart and moves with it when the page scrolls; a pointer tooltip closes on scroll.
let anchor = null;
function showTip(content, x, y) {
  anchor = null;
  if (typeof content === "string") {
    if (tip.textContent !== content || tip.children.length) tip.textContent = content;
  } else {
    tip.replaceChildren(...content);
  }
  tip.hidden = false;
  placeTip(x, y);
}
function hideTip() {
  tip.hidden = true;
  anchor = null;
}

const bound = new WeakSet();
function bindTooltips(root) {
  if (bound.has(root)) return;
  bound.add(root);
  root.addEventListener("pointermove", (ev) => {
    const t = ev.target instanceof Element ? ev.target.closest("[data-tip]") : null;
    if (!t) { hideTip(); return; }
    showTip(t.getAttribute("data-tip"), ev.clientX, ev.clientY);
  });
  root.addEventListener("pointerleave", hideTip);
}
document.addEventListener("scroll", () => {
  if (!tip || tip.hidden) return;
  if (anchor && document.activeElement === anchor.el) placeTip(...anchor.where());
  else hideTip();
}, { passive: true });

// ---------- responsive rendering ----------

const renderers = new Map();
const ro = typeof ResizeObserver === "function"
  ? new ResizeObserver((entries) => {
    for (const en of entries) {
      const r = renderers.get(en.target);
      if (!r) continue;
      const w = Math.round(en.contentRect.width);
      if (w > 0 && Math.abs(w - r.width) > 4) {
        r.width = w;
        requestAnimationFrame(r.fn);
      }
    }
  })
  : null;

function responsive(box, fn) {
  const known = renderers.has(box);
  renderers.set(box, { fn, width: box.clientWidth });
  if (ro && !known) ro.observe(box);
  fn();
}

function boxWidth(box) {
  return Math.max(240, Math.floor(box.clientWidth || box.getBoundingClientRect().width || 800));
}

function niceMax(v) {
  for (const m of [0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5, 0.6, 0.8, 1]) if (v <= m) return m;
  return Math.ceil(v);
}

function linearTicks(max) {
  const step = max <= 0.1 ? 0.02 : max <= 0.2 ? 0.05 : max <= 0.6 ? 0.1 : 0.2;
  const t = [];
  for (let v = 0; v <= max + 1e-9; v += step) t.push(Math.round(v * 1000) / 1000);
  return t;
}

// Split a label into lines of at most maxChars at word boundaries, up to maxLines; a longer last line is cut
// with an ellipsis (the full label stays in the tooltip and the data table).
function wrap(text, maxChars, maxLines = 3) {
  const words = text.split(" ");
  const lines = [];
  while (words.length && lines.length < maxLines) {
    let line = words.shift();
    while (words.length && `${line} ${words[0]}`.length <= maxChars) line = `${line} ${words.shift()}`;
    lines.push(line);
  }
  if (words.length) lines[lines.length - 1] = `${`${lines[lines.length - 1]} ${words.join(" ")}`.slice(0, maxChars - 1).trimEnd()}…`;
  return lines;
}

function svgRoot(W, H, title, desc, role = "img") {
  const tId = nextId("t");
  const dId = nextId("d");
  const svg = svgEl("svg", {
    viewBox: `0 0 ${W} ${H}`, width: W, height: H, role, "aria-labelledby": `${tId} ${dId}`,
  });
  svg.append(svgEl("title", { id: tId }, title), svgEl("desc", { id: dId }, desc));
  return svg;
}

// ---------- dot-and-interval chart ----------
// rows: [{label, header?, note?, d?: {v, lo, hi, ref, tip}}]; cfg.log: log10 scale; cfg.refLine: {value, label}.

function dotChart(box, cfg) {
  const W = boxWidth(box);
  const small = W < 560;
  const fs = small ? 13 : 15;
  const labelW = Math.round(Math.min(260, Math.max(128, W * (small ? 0.4 : 0.34))));
  const maxChars = Math.max(10, Math.floor((labelW - 10) / (fs * 0.54)));
  const padR = 18;
  const top = cfg.refLine ? fs * 2.2 : 8;
  const axisH = fs * 3.6;
  const [d0, d1] = cfg.domain;
  const x0 = labelW;
  const x1 = W - padR;
  const f = cfg.log ? Math.log10 : (v) => v;
  const x = (v) => x0 + ((f(Math.min(Math.max(v, d0), d1)) - f(d0)) / (f(d1) - f(d0))) * (x1 - x0);

  let y = top;
  const pos = cfg.rows.map((r) => {
    const lines = r.header ? [r.label] : wrap(r.label, maxChars);
    const h = r.header ? fs * 2.1 : Math.max(fs * 2.1, lines.length * fs * 1.2 + fs * 0.9);
    const p = { y, h, lines };
    y += h;
    return p;
  });
  const plotBottom = y;
  const H = Math.ceil(plotBottom + axisH);
  const svg = svgRoot(W, H, cfg.title, cfg.desc);

  for (const t of cfg.ticks) {
    svg.append(svgEl("line", { class: "ax-grid", x1: x(t), x2: x(t), y1: top, y2: plotBottom }));
    svg.append(svgEl("text", { class: "ax-text", x: x(t), y: plotBottom + fs * 1.3, "text-anchor": "middle", "font-size": fs - 1 }, cfg.tickText(t)));
  }
  svg.append(svgEl("line", { class: "ax-base", x1: x0, x2: x1, y1: plotBottom, y2: plotBottom }));
  const half = (cfg.xLabel.length * fs * 0.56) / 2;
  const tx = Math.min(Math.max((x0 + x1) / 2, half + 2), W - half - 2);
  svg.append(svgEl("text", { class: "ax-title", x: tx, y: plotBottom + fs * 2.9, "text-anchor": "middle", "font-size": fs }, cfg.xLabel));

  // Reference line under the rows: header strips cover it, dots and intervals sit on it.
  if (cfg.refLine) {
    const rx = x(cfg.refLine.value);
    svg.append(svgEl("line", { class: "ref-line", x1: rx, x2: rx, y1: top - 4, y2: plotBottom }));
    svg.append(svgEl("text", { class: "ref-text", x: rx, y: top - fs * 0.8, "text-anchor": rx > W * 0.7 ? "end" : "start", "font-size": fs - 2 }, cfg.refLine.label));
  }
  let band = 0;
  cfg.rows.forEach((r, i) => {
    const { y: ry, h, lines } = pos[i];
    const cy = ry + h / 2;
    if (r.header) {
      band = 0;
      // The header sits on a page-colored strip, so grid and reference lines do not run through its text.
      svg.append(svgEl("rect", { class: "header-strip", x: 0, y: ry + 1, width: W, height: h - 2 }));
      svg.append(svgEl("text", { class: "row-header", x: 4, y: ry + h * 0.7, "font-size": fs - 1 }, r.label));
      return;
    }
    if (band++ % 2 === 0) svg.append(svgEl("rect", { class: "row-band", x: 0, y: ry, width: W, height: h }));
    const ly = cy - ((lines.length - 1) * fs * 1.2) / 2 + fs * 0.35;
    const label = svgEl("text", { class: "row-label", x: 4, y: ly, "font-size": fs });
    lines.forEach((ln, k) => label.append(svgEl("tspan", { x: 4, dy: k ? fs * 1.2 : 0 }, ln)));
    svg.append(label);
    const d = r.d;
    if (!d || !isNum(d.v)) {
      svg.append(svgEl("text", { class: "row-note", x: x0 + 8, y: cy + fs * 0.35, "font-size": fs - 2 }, r.note || "not shown for privacy"));
      return;
    }
    const g = svgEl("g", { class: "s1", "data-tip": d.tip });
    if (isNum(d.ref)) g.append(svgEl("line", { class: "ref-mark", x1: x(d.ref), x2: x(d.ref), y1: cy - 8, y2: cy + 8 }));
    if (isNum(d.lo) && isNum(d.hi)) g.append(svgEl("line", { class: "ci", x1: x(d.lo), x2: x(d.hi), y1: cy, y2: cy }));
    g.append(svgEl("circle", { class: "dot", cx: x(d.v), cy, r: small ? 4.5 : 5.5 }));
    const lo = Math.min(x(isNum(d.lo) ? d.lo : d.v), isNum(d.ref) ? x(d.ref) : Infinity) - 8;
    const hi = Math.max(x(isNum(d.hi) ? d.hi : d.v), isNum(d.ref) ? x(d.ref) : -Infinity) + 8;
    g.append(svgEl("rect", { class: "hit", x: lo, y: ry, width: hi - lo, height: h }));
    svg.append(g);
  });

  box.replaceChildren(svg);
}

// ---------- weekly line chart (Long COVID activity and sleep around COVID-19) ----------
// cfg: {title, desc, weeks, series: [{label, name, cls, v[], lo[], hi[]}], digits, phrase, yLabel, domain, ticks,
// live}. Null weeks are gaps: lines and bands break there and are never interpolated, and weeks where every series
// is null are shaded. The chart takes focus, and the arrow keys move a crosshair week by week.

const MINUS = "−";
const signedWeek = (w) => (w > 0 ? `+${w}` : w < 0 ? `${MINUS}${Math.abs(w)}` : "0");
const signedInt = (x) => (x < 0 ? `${MINUS}${Math.abs(x).toLocaleString("en-US")}` : x.toLocaleString("en-US"));
const weekName = (w) => `Week ${signedWeek(w)} (days ${signedInt(7 * w)} to ${signedInt(7 * w + 6)})`;

function lineChart(box, cfg) {
  const W = boxWidth(box);
  const small = W < 560;
  const fs = small ? 14 : 15;
  const H = Math.round(Math.min(440, Math.max(small ? 340 : 300, W * 0.42)));
  const labels = !small && cfg.series.length > 1;
  const longest = Math.max(...cfg.series.map((s) => s.label.length));
  const m = { l: small ? 50 : 62, r: labels ? Math.min(160, longest * fs * 0.6 + 16) : 12, t: fs * 3.2, b: fs * 3.8 };
  const weeks = cfg.weeks;
  const [w0, w1] = [weeks[0], weeks[weeks.length - 1]];
  const [d0, d1] = cfg.domain;
  const x = (w) => m.l + ((w - w0) / (w1 - w0)) * (W - m.l - m.r);
  const y = (v) => m.t + (1 - (v - d0) / (d1 - d0)) * (H - m.t - m.b);
  const base = H - m.b;
  const svg = svgRoot(W, H, cfg.title, cfg.desc, "group");
  svg.setAttribute("tabindex", "0");
  svg.classList.add("line-chart");

  // grid and axes; the measure's axis label sits above the plot
  for (const t of cfg.ticks) {
    svg.append(svgEl("line", { class: "ax-grid", x1: m.l, x2: W - m.r, y1: y(t), y2: y(t) }));
    svg.append(svgEl("text", { class: "ax-text", x: m.l - 6, y: y(t) + 5, "text-anchor": "end", "font-size": 14 }, meanText(t, Number.isInteger(t) ? 0 : 1)));
  }
  svg.append(svgEl("text", { class: "ax-title", x: 0, y: fs * 0.95, "font-size": fs }, cfg.yLabel));
  svg.append(svgEl("line", { class: "ax-base", x1: m.l, x2: W - m.r, y1: base, y2: base }));
  for (const w of [-26, -13, 0, 13, 26].filter((v) => v >= w0 && v <= w1)) {
    svg.append(svgEl("line", { class: "ax-base", x1: x(w), x2: x(w), y1: base, y2: base + 4 }));
    svg.append(svgEl("text", { class: "ax-text", x: x(w), y: base + fs * 1.4, "text-anchor": "middle", "font-size": 14 }, signedWeek(w)));
  }
  svg.append(svgEl("text", { class: "ax-title", x: m.l + (W - m.l - m.r) / 2, y: base + fs * 3, "text-anchor": "middle", "font-size": fs }, "Weeks from the COVID-19 diagnosis"));

  // weeks with no shown value in any series
  const half = (x(w0 + 1) - x(w0)) / 2;
  const empty = weeks.map((_, i) => cfg.series.every((s) => !isNum(s.v[i])));
  for (let i = 0; i < weeks.length;) {
    if (!empty[i]) { i++; continue; }
    let j = i;
    while (j + 1 < weeks.length && empty[j + 1]) j++;
    const gx0 = Math.max(m.l, x(weeks[i]) - half);
    const gx1 = Math.min(W - m.r, x(weeks[j]) + half);
    svg.append(svgEl("rect", { class: "gap-band", x: gx0, y: m.t, width: gx1 - gx0, height: base - m.t }));
    // the label sits in the wider part of the gap on either side of the COVID-19 line, when it fits
    const zx = x(0) - half;
    const parts = zx > gx0 && zx < gx1 ? [[gx0, zx], [zx, gx1]] : [[gx0, gx1]];
    const [a, b] = parts.reduce((p, q) => (q[1] - q[0] > p[1] - p[0] ? q : p));
    if (b - a > 14 * 11.5) svg.append(svgEl("text", { class: "gap-text", x: (a + b) / 2, y: base - fs * 0.8, "text-anchor": "middle", "font-size": 14 }, "Not shown for privacy"));
    i = j + 1;
  }

  // COVID-19 diagnosis: the start of week 0
  if (w0 <= 0 && w1 >= 0) {
    const zx = x(0) - half;
    svg.append(svgEl("line", { class: "ref-line", x1: zx, x2: zx, y1: m.t - 6, y2: base }));
    svg.append(svgEl("text", { class: "ref-text", x: zx + 4, y: m.t - fs * 0.6, "font-size": 14 }, "COVID-19"));
  }

  // series: interval bands, then lines, broken at null weeks
  const runs = (s) => {
    const out = [];
    let cur = [];
    s.v.forEach((v, i) => {
      if (isNum(v)) cur.push(i);
      else if (cur.length) { out.push(cur); cur = []; }
    });
    if (cur.length) out.push(cur);
    return out;
  };
  const endLabels = [];
  for (const s of cfg.series) {
    const g = svgEl("g", { class: `series ${s.cls}`, "aria-hidden": "true" });
    for (const run of runs(s)) {
      if (run.length === 1) {
        const i = run[0];
        g.append(svgEl("line", { class: "ci", x1: x(weeks[i]), x2: x(weeks[i]), y1: y(s.lo[i]), y2: y(s.hi[i]) }));
        g.append(svgEl("circle", { class: "dot", cx: x(weeks[i]), cy: y(s.v[i]), r: 3 }));
        continue;
      }
      const up = run.map((i) => `${x(weeks[i]).toFixed(1)},${y(s.hi[i]).toFixed(1)}`);
      const down = run.slice().reverse().map((i) => `${x(weeks[i]).toFixed(1)},${y(s.lo[i]).toFixed(1)}`);
      g.append(svgEl("path", { class: "band", d: `M${up.join("L")}L${down.join("L")}Z` }));
      g.append(svgEl("path", { class: "line", d: `M${run.map((i) => `${x(weeks[i]).toFixed(1)},${y(s.v[i]).toFixed(1)}`).join("L")}` }));
    }
    svg.append(g);
    const last = s.v.map((v, i) => (isNum(v) ? i : -1)).filter((i) => i >= 0).pop();
    if (labels && last !== undefined) endLabels.push({ s, x: x(weeks[last]) + 6, y: y(s.v[last]) });
  }
  // direct labels at each line's last shown week, nudged apart vertically
  endLabels.sort((p, q) => p.y - q.y);
  for (let k = 1; k < endLabels.length; k++) {
    if (endLabels[k].y - endLabels[k - 1].y < fs * 1.2) endLabels[k].y = endLabels[k - 1].y + fs * 1.2;
  }
  for (const l of endLabels) svg.append(svgEl("text", { class: "end-label", x: l.x, y: l.y + fs * 0.35, "font-size": fs }, l.s.label));

  // crosshair: snaps to the nearest week; the arrow keys move it
  const cursor = svgEl("g", { class: "cursor", "aria-hidden": "true" });
  cursor.setAttribute("hidden", "");
  const cline = svgEl("line", { class: "cursor-line", y1: m.t, y2: base });
  cursor.append(cline);
  const cdots = cfg.series.map((s) => {
    const c = svgEl("circle", { class: `cursor-dot ${s.cls}`, r: 4.5 });
    cursor.append(c);
    return c;
  });
  svg.append(cursor);
  const overlay = svgEl("rect", { class: "overlay", x: m.l, y: m.t, width: W - m.l - m.r, height: base - m.t });
  svg.append(overlay);

  const d = cfg.digits;
  let active = null;
  const readout = (i) => {
    const head = htmlEl("div", { class: "tip-head", text: weekName(weeks[i]) });
    const rows = cfg.series.map((s) => htmlEl("div", { class: "tip-row" }, [
      htmlEl("span", { class: `tip-key ${s.cls}`, "aria-hidden": "true" }),
      ...(isNum(s.v[i])
        ? [`${s.label}: `, htmlEl("strong", { text: meanText(s.v[i], d) }), ` ${cfg.phrase} (95% CI ${meanText(s.lo[i], d)} to ${meanText(s.hi[i], d)})`]
        : [`${s.label}: not shown for privacy`]),
    ]));
    const text = `${weekName(weeks[i])}. ${cfg.series.map((s) => (isNum(s.v[i])
      ? `${s.name}: ${meanText(s.v[i], d)} ${cfg.phrase}, 95% CI ${meanText(s.lo[i], d)} to ${meanText(s.hi[i], d)}`
      : `${s.name}: not shown for privacy`)).join("; ")}.`;
    return { nodes: [head, ...rows], text };
  };
  const setCursor = (i, cx, cy) => {
    active = i;
    cursor.removeAttribute("hidden");
    const px = x(weeks[i]);
    cline.setAttribute("x1", px);
    cline.setAttribute("x2", px);
    cfg.series.forEach((s, k) => {
      if (isNum(s.v[i])) {
        cdots[k].removeAttribute("hidden");
        cdots[k].setAttribute("cx", px);
        cdots[k].setAttribute("cy", y(s.v[i]));
      } else cdots[k].setAttribute("hidden", "");
    });
    const r = readout(i);
    if (cx === undefined) {
      const where = () => {
        const b = svg.getBoundingClientRect();
        const sx = b.width / W;
        return [b.left + px * sx, b.top + m.t * sx];
      };
      showTip(r.nodes, ...where());
      anchor = { el: svg, where };
    } else {
      showTip(r.nodes, cx, cy);
    }
    return r.text;
  };
  const clear = () => { active = null; cursor.setAttribute("hidden", ""); hideTip(); };
  const weekAt = (clientX) => {
    const b = svg.getBoundingClientRect();
    const px = (clientX - b.left) * (W / b.width);
    const w = Math.round(w0 + ((px - m.l) / (W - m.l - m.r)) * (w1 - w0));
    return Math.min(Math.max(w, w0), w1) - w0;
  };
  // stopPropagation: the panel's mark tooltips (bindTooltips on the same box) would close this readout
  const point = (ev) => { ev.stopPropagation(); setCursor(weekAt(ev.clientX), ev.clientX, ev.clientY); };
  overlay.addEventListener("pointermove", point);
  overlay.addEventListener("pointerdown", point);
  overlay.addEventListener("pointerleave", () => { if (document.activeElement !== svg) clear(); });
  svg.addEventListener("focus", () => { const t = setCursor(active ?? 0); if (cfg.live) cfg.live.textContent = t; });
  svg.addEventListener("blur", clear);
  svg.addEventListener("keydown", (ev) => {
    const keys = { ArrowLeft: -1, ArrowRight: 1, ArrowDown: -1, ArrowUp: 1, PageDown: -4, PageUp: 4 };
    let i = active ?? 0;
    if (ev.key in keys) i = Math.min(Math.max(i + keys[ev.key], 0), weeks.length - 1);
    else if (ev.key === "Home") i = 0;
    else if (ev.key === "End") i = weeks.length - 1;
    else if (ev.key === "Escape") { clear(); return; }
    else return;
    ev.preventDefault();
    const t = setCursor(i);
    if (cfg.live) cfg.live.textContent = t;
  });
  box.replaceChildren(svg);
}

// ---------- tile map ----------

const TILE = {
  AK: [0, 0], ME: [10, 0],
  VT: [9, 1], NH: [10, 1],
  WA: [0, 2], ID: [1, 2], MT: [2, 2], ND: [3, 2], MN: [4, 2], IL: [5, 2], WI: [6, 2], MI: [7, 2], NY: [8, 2], RI: [9, 2], MA: [10, 2],
  OR: [0, 3], NV: [1, 3], WY: [2, 3], SD: [3, 3], IA: [4, 3], IN: [5, 3], OH: [6, 3], PA: [7, 3], NJ: [8, 3], CT: [9, 3],
  CA: [0, 4], UT: [1, 4], CO: [2, 4], NE: [3, 4], MO: [4, 4], KY: [5, 4], WV: [6, 4], VA: [7, 4], MD: [8, 4], DE: [9, 4],
  AZ: [1, 5], NM: [2, 5], KS: [3, 5], AR: [4, 5], TN: [5, 5], NC: [6, 5], SC: [7, 5], DC: [8, 5],
  OK: [3, 6], LA: [4, 6], MS: [5, 6], AL: [6, 6], GA: [7, 6],
  HI: [0, 7], TX: [3, 7], FL: [8, 7],
};
const STATE_NAMES = {
  AK: "Alaska", AL: "Alabama", AR: "Arkansas", AZ: "Arizona", CA: "California", CO: "Colorado", CT: "Connecticut",
  DC: "District of Columbia", DE: "Delaware", FL: "Florida", GA: "Georgia", HI: "Hawaii", IA: "Iowa", ID: "Idaho",
  IL: "Illinois", IN: "Indiana", KS: "Kansas", KY: "Kentucky", LA: "Louisiana", MA: "Massachusetts", MD: "Maryland",
  ME: "Maine", MI: "Michigan", MN: "Minnesota", MO: "Missouri", MS: "Mississippi", MT: "Montana", NC: "North Carolina",
  ND: "North Dakota", NE: "Nebraska", NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico", NV: "Nevada",
  NY: "New York", OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania", PR: "Puerto Rico", RI: "Rhode Island",
  SC: "South Carolina", SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah", VA: "Virginia", VT: "Vermont",
  WA: "Washington", WI: "Wisconsin", WV: "West Virginia", WY: "Wyoming",
};

const binIndex = (bins, v) => bins.findIndex((b) => b.max === null || v < b.max);

/** Class, short tile text, and description for one state in a layer. */
function describeState(layer, st) {
  const name = STATE_NAMES[st] || st;
  const c = layer.states[st];
  const d = layer.digits ?? 0;
  if (!c || !isNum(c.v)) {
    const why = c?.why || "none";
    const text = layer.missing?.[why] || (why === "none" ? "No data" : "Not shown for privacy");
    return { cls: why === "none" ? "na" : "wh", short: "", tip: `${name}: ${text.toLowerCase()}` };
  }
  let tipText = `${name}: ${val(c.v, layer.unit, d)}`;
  if (isNum(c.lo)) tipText += ` (95% CI ${range(c.lo, c.hi, layer.unit, d)})`;
  if (layer.unit === "per100k") tipText = `${name}: ${one(c.v)} reported cases per 100,000 a year (${c.band}); about ${int(c.cases)} cases a year`;
  if (isNum(c.rel)) tipText += `; ${dec(c.rel)} relative to hypertension and type 2 diabetes in the same state`;
  const short = layer.unit === "per100k" ? (c.v >= 10 ? String(Math.round(c.v)) : c.v.toFixed(1)) : val(c.v, layer.unit, layer.unit === "percent" ? 1 : d);
  return { cls: `b${binIndex(layer.bins, c.v)}`, short, tip: tipText };
}

function drawTiles(box, layer, opts = {}) {
  const W = Math.min(boxWidth(box), 760);
  const cols = 11;
  const gap = 3;
  const size = Math.floor((W - gap * (cols - 1)) / cols);
  const H = 8 * (size + gap);
  const tId = nextId("t");
  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: opts.selectable ? "group" : "img", "aria-labelledby": tId });
  svg.append(svgEl("title", { id: tId }, `Tile map of US states: ${layer.title}.${opts.selectable ? " Select a state to list its counties." : ""}`));
  const fsA = Math.max(10, Math.round(size * 0.3));
  const fsV = Math.max(9, Math.round(size * 0.22));
  for (const [st, [c, r]] of Object.entries(TILE)) {
    const d = describeState(layer, st);
    const tx = c * (size + gap);
    const ty = r * (size + gap);
    const g = svgEl("g", {
      class: `tile ${d.cls}${opts.selectable ? "" : " static"}`, tabindex: 0,
      role: opts.selectable ? "button" : null, "aria-pressed": opts.selectable ? String(opts.current === st) : null,
      "aria-label": d.tip, "data-tip": d.tip, "data-state": st,
    });
    g.append(svgEl("rect", { x: tx, y: ty, width: size, height: size, rx: 3 }));
    if (size >= 40) {
      g.append(svgEl("text", { class: "abbr", x: tx + size / 2, y: ty + size * 0.45, "font-size": fsA }, st));
      if (d.short) g.append(svgEl("text", { x: tx + size / 2, y: ty + size * 0.78, "font-size": fsV }, d.short));
    } else {
      g.append(svgEl("text", { class: "abbr", x: tx + size / 2, y: ty + size * 0.62, "font-size": Math.max(9, Math.round(size * 0.36)) }, st));
    }
    svg.append(g);
  }
  box.replaceChildren(svg);
}

// ---------- summary ----------

const LINK_TEXT = { who: "Who goes uncoded", where: "By state", related: "What else is in the record" };

function renderSummary(cond) {
  $("summary").replaceChildren(...cond.summary.map((s) => htmlEl("li", {}, [
    htmlEl("a", { class: "stat", href: `#${s.link}` }, [
      htmlEl("span", { class: "stat-num", text: s.display }),
      htmlEl("span", { class: "stat-text", text: s.text }),
      htmlEl("span", { class: "stat-link", text: LINK_TEXT[s.link] }),
    ]),
  ])));
}

// ---------- by state ----------

const mapState = { layer: 0, county: "", sortKey: "incidence", sortDir: -1 };

function renderMap(cond) {
  const section = $("where");
  const layers = cond.map.layers;
  section.hidden = !layers.length;
  if (!layers.length) return;
  mapState.layer = 0;
  mapState.county = "";
  toggles("where-controls", layers.map((l) => l.label), (i) => {
    mapState.layer = i;
    mapState.county = "";
    drawLayer(cond);
  });
  drawLayer(cond);
}

function drawLayer(cond) {
  const layer = cond.map.layers[mapState.layer];
  const d = layer.digits ?? 0;
  setText("where-takeaway", layer.takeaway);
  setText("where-chart-title", layer.title);
  const present = new Set(Object.values(layer.states).filter((s) => !isNum(s.v)).map((s) => (s.why === "none" ? "none" : "hidden")));
  const missing = [];
  if (present.has("hidden")) missing.push({ sw: "wh", label: layer.missing.suppressed || "Not shown for privacy" });
  if (present.has("none") || Object.keys(TILE).some((st) => !layer.states[st])) missing.push({ sw: "na", label: layer.missing.none || "No data" });
  legend("where-legend", [...layer.bins.map((b, i) => ({ sw: `b${i}`, label: b.label })), ...missing]);
  const n = layer.national;
  setText("where-national", n ? `${n.label}: ${val(n.v, layer.unit, d)} (95% CI ${range(n.lo, n.hi, layer.unit, d)}).` : "");
  const box = $("where-map");
  const counties = layer.counties;
  $("county-panel").hidden = !counties;
  responsive(box, () => drawTiles(box, layer, { selectable: Boolean(counties), current: mapState.county }));
  bindTooltips(box);
  if (counties) setupCounties(layer);
  stateTable(layer);
  sourceLine("where-source", layer.source);
}

function stateTable(layer) {
  const d = layer.digits ?? 0;
  const entries = Object.entries(layer.states).sort((a, b) => (STATE_NAMES[a[0]] || a[0]).localeCompare(STATE_NAMES[b[0]] || b[0]));
  const missingText = (c) => (layer.missing?.[c.why === "none" ? "none" : "suppressed"] || WHY[c.why] || "not shown").toLowerCase();
  let headers;
  let rows;
  if (layer.unit === "per100k") {
    headers = [{ label: "State" }, { label: "Cases per 100,000 a year", num: true }, { label: "Band" }, { label: "Reported cases a year", num: true }, { label: "Population", num: true }];
    rows = entries.sort((a, b) => b[1].v - a[1].v).map(([st, c]) => [STATE_NAMES[st] || st, one(c.v), c.band, one(c.cases), int(c.population)]);
  } else {
    const rel = entries.some(([, c]) => isNum(c.rel));
    headers = [{ label: "State" }, { label: layer.unit === "percent" ? "Percent" : "Share", num: true }, { label: "95% CI", num: true }];
    if (rel) headers.push({ label: layer.table_rel_label || "Relative", num: true });
    rows = entries.map(([st, c]) => {
      if (!isNum(c.v)) return [STATE_NAMES[st] || st, missingText(c), "", ...(rel ? [""] : [])];
      return [STATE_NAMES[st] || st, val(c.v, layer.unit, d), isNum(c.lo) ? range(c.lo, c.hi, layer.unit, d) : "",
        ...(rel ? [isNum(c.rel) ? `${dec(c.rel)} (${dec(c.rlo)} to ${dec(c.rhi)})` : ""] : [])];
    });
    if (layer.national) {
      const n = layer.national;
      rows.unshift([n.label, val(n.v, layer.unit, d), range(n.lo, n.hi, layer.unit, d), ...(rel ? [""] : [])]);
    }
  }
  $("where-table").replaceChildren(table(layer.title, headers, rows));
}

let countyWired = false;
let countyLayer = null;
function setupCounties(layer) {
  countyLayer = layer;
  const sel = $("county-state");
  const box = $("where-map");
  sel.replaceChildren(htmlEl("option", { value: "", text: "All states (top 50 counties)" }),
    ...Object.entries(layer.states).sort((a, b) => STATE_NAMES[a[0]].localeCompare(STATE_NAMES[b[0]]))
      .map(([st, c]) => htmlEl("option", { value: st, text: `${STATE_NAMES[st]} (${one(c.v)})` })));
  sel.value = mapState.county;
  if (!countyWired) {
    countyWired = true;
    const choose = (st) => {
      if (!countyLayer) return;
      mapState.county = mapState.county === st ? "" : st;
      sel.value = mapState.county;
      for (const t of box.querySelectorAll(".tile")) t.setAttribute("aria-pressed", String(t.getAttribute("data-state") === mapState.county));
      drawCounties();
    };
    box.addEventListener("click", (ev) => {
      const t = ev.target instanceof Element ? ev.target.closest(".tile") : null;
      if (t && countyLayer && countyLayer.counties) choose(t.getAttribute("data-state"));
    });
    box.addEventListener("keydown", (ev) => {
      const t = ev.target instanceof Element ? ev.target.closest(".tile") : null;
      if (t && countyLayer && countyLayer.counties && (ev.key === "Enter" || ev.key === " ")) { ev.preventDefault(); choose(t.getAttribute("data-state")); }
    });
    sel.addEventListener("change", () => { mapState.county = ""; choose(sel.value); });
  }
  drawCounties();
}

const COUNTY_COLS = [
  { key: "county", label: "County" }, { key: "state", label: "State" },
  { key: "population", label: "Population", num: true }, { key: "cases", label: "Cases a year", num: true },
  { key: "incidence", label: "Per 100,000", num: true }, { key: "band", label: "Band" }, { key: "cdc", label: "Count source" },
];

function drawCounties() {
  const layer = countyLayer;
  if (!layer || !layer.counties) return;
  const box = $("county-table");
  const all = layer.counties.rows.map((c) => ({
    fips: c[0], state: c[1], county: c[2], population: c[3], cases: c[4], incidence: c[5], band: c[6], cdc: c[7] === 1,
  }));
  const st = mapState.county;
  let list = st ? all.filter((c) => c.state === st) : all;
  const { sortKey, sortDir } = mapState;
  list = [...list].sort((a, b) => {
    const va = a[sortKey];
    const vb = b[sortKey];
    const cmp = typeof va === "string" ? va.localeCompare(vb) : (va - vb);
    return cmp * sortDir || b.incidence - a.incidence || a.county.localeCompare(b.county);
  });
  if (!st) list = list.slice(0, 50);
  const t = htmlEl("table");
  t.append(htmlEl("caption", { text: st ? `${STATE_NAMES[st]}: ${list.length} counties, state average ${one(layer.states[st].v)} per 100,000 a year` : "Top 50 counties nationwide by the selected sort" }));
  const tr = htmlEl("tr");
  for (const c of COUNTY_COLS) {
    const th = htmlEl("th", { scope: "col", class: c.num ? "num" : null, "aria-sort": c.key === sortKey ? (sortDir > 0 ? "ascending" : "descending") : "none" });
    const btn = htmlEl("button", { type: "button", class: "sort-btn", text: c.label });
    btn.addEventListener("click", () => {
      if (mapState.sortKey === c.key) mapState.sortDir = -mapState.sortDir;
      else { mapState.sortKey = c.key; mapState.sortDir = c.num ? -1 : 1; }
      drawCounties();
      box.querySelector(`th[aria-sort="${mapState.sortDir > 0 ? "ascending" : "descending"}"] button`)?.focus();
    });
    th.append(btn);
    tr.append(th);
  }
  const tbody = htmlEl("tbody");
  for (const c of list) {
    tbody.append(htmlEl("tr", {}, [
      htmlEl("th", { scope: "row", text: c.county }), htmlEl("td", { text: c.state }),
      htmlEl("td", { class: "num", text: int(c.population) }), htmlEl("td", { class: "num", text: one(c.cases) }),
      htmlEl("td", { class: "num", text: one(c.incidence) }), htmlEl("td", { text: c.band }),
      htmlEl("td", { text: c.cdc ? "CDC" : "state spread" }),
    ]));
  }
  t.append(htmlEl("thead", {}, [tr]), tbody);
  box.replaceChildren(t, htmlEl("p", { class: "small", text: layer.counties.note }));
}

// ---------- who goes uncoded ----------

const whoState = { variant: 0 };

function renderWho(cond) {
  const gr = cond.groups;
  const section = $("who");
  section.hidden = !gr || !gr.variants.length;
  if (section.hidden) return;
  whoState.variant = 0;
  toggles("who-controls", gr.variants.map((v) => v.label), (i) => {
    whoState.variant = i;
    drawWho(cond);
  });
  drawWho(cond);
}

function whoTip(cond, axis, r) {
  const gr = cond.groups;
  const d = gr.digits ?? 0;
  if (gr.ref_label === null) {
    let t = `${r.label}: coding fraction ${val(r.v, gr.unit, d)} (95% interval ${range(r.lo, r.hi, gr.unit, d)}); coded ${pct(r.coded, 1)}, survey prevalence ${pct(r.pi, 1)}; about ${one(r.per)} uncoded for each coded`;
    if (isNum(r.ratio)) t += `; ${dec(r.ratio)} times the fraction for ${r.ratio_ref.toLowerCase()}`;
    return t;
  }
  let t = `${r.label}: ${val(r.v, gr.unit, d)} have a code (95% CI ${range(r.lo, r.hi, gr.unit, d)})`;
  if (isNum(r.ref)) t += `; ${refName(gr)} in the same group: ${val(r.ref, gr.unit, d)}`;
  return t;
}

/** The comparison conditions as a phrase: "hypertension and type 2 diabetes" (among women, for endometriosis). */
const refName = (gr) => gr.ref_name || "hypertension and type 2 diabetes";

function drawWho(cond) {
  const gr = cond.groups;
  const v = gr.variants[whoState.variant];
  const d = gr.digits ?? 0;
  setText("who-takeaway", v.takeaway);
  setText("who-chart-title", gr.title);
  setText("who-note", v.note);
  const items = [{ sw: "s1", label: gr.ref_label === null ? "Coding fraction, 95% interval" : "Share with a code, 95% CI" }];
  if (gr.ref_label) items.push({ sw: "tick-ref", label: gr.ref_label });
  legend("who-legend", items);
  const rows = [];
  for (const a of v.axes) {
    rows.push({ header: true, label: a.title });
    if (a.rows.every((r) => !isNum(r.v))) {
      rows.push({ label: "Every group", note: "not shown for privacy" });
      continue;
    }
    for (const r of a.rows) {
      rows.push({ label: r.label, note: isNum(r.v) ? null : WHY[r.why], d: isNum(r.v) ? { v: r.v, lo: r.lo, hi: r.hi, ref: r.ref, tip: whoTip(cond, a, r) } : null });
    }
  }
  const his = v.axes.flatMap((a) => a.rows.flatMap((r) => [r.hi, r.ref])).filter(isNum);
  const max = gr.domain ? gr.domain[1] : niceMax(Math.max(...his) * 1.05);
  const box = $("who-chart");
  responsive(box, () => dotChart(box, {
    title: `${gr.title}${gr.variants.length > 1 ? `, ${v.label.toLowerCase()}` : ""}`,
    desc: `Dot and 95% interval for each group. ${v.note}`,
    rows, domain: [0, max], ticks: linearTicks(max), tickText: (t) => `${Math.round(t * 100)}%`, xLabel: gr.x_label,
  }));
  bindTooltips(box);
  $("who-notes").replaceChildren(...v.axes.filter((a) => a.note).map((a) => htmlEl("p", { class: "chart-note", text: a.note.text })));

  const lc = gr.ref_label === null;
  const headers = lc
    ? [{ label: "Group" }, { label: "Coding fraction", num: true }, { label: "95% interval", num: true }, { label: "Coded", num: true }, { label: "Survey prevalence", num: true }, { label: "Ratio to reference group" }]
    : [{ label: "Group" }, { label: "Share with a code", num: true }, { label: "95% CI", num: true }, { label: `${upperFirst(refName(gr))}, same group`, num: true }];
  const trows = [];
  for (const a of v.axes) {
    trows.push({ header: a.title });
    for (const r of a.rows) {
      if (!isNum(r.v)) { trows.push([r.label, WHY[r.why], "", ...(lc ? ["", "", ""] : [""])]); continue; }
      trows.push(lc
        ? [r.label, val(r.v, gr.unit, d), range(r.lo, r.hi, gr.unit, d), pct(r.coded, 1), pct(r.pi, 1),
          isNum(r.ratio) ? `${dec(r.ratio)} (${dec(r.ratio_lo)} to ${dec(r.ratio_hi)}) against ${r.ratio_ref.toLowerCase()}` : "reference"]
        : [r.label, val(r.v, gr.unit, d), range(r.lo, r.hi, gr.unit, d), isNum(r.ref) ? val(r.ref, gr.unit, d) : "not shown"]);
    }
  }
  $("who-table").replaceChildren(table(`${gr.title}${gr.variants.length > 1 ? `, ${v.label.toLowerCase()}` : ""}`, headers, trows));
  sourceLine("who-source", gr.source);
}

// ---------- what else is in the record ----------

const RELATED_IN_CHART = 15;

function renderRelated(cond) {
  const rel = cond.related;
  const section = $("related");
  section.hidden = !rel;
  if (!rel) return;
  const d = rel.digits ?? 1;
  setText("related-takeaway", rel.takeaway);
  setText("related-chart-title", rel.title);
  setText("related-note", rel.note);
  legend("related-legend", [{ sw: "s1", label: `${rel.x_label}, 95% CI` }, { sw: "line", label: "1: as common" }]);
  const tipFor = (r) => (isNum(r.ratio)
    ? `${r.label}: ${pct(r.with, d)} of ${rel.with_label.toLowerCase()} against ${pct(r.without, d)} of ${lowerFirst(rel.without_label)}; ${dec(r.ratio, 1)} times as common (95% CI ${dec(r.lo, 1)} to ${dec(r.hi, 1)})`
    : `${r.label}: ${pct(r.with, d)} of ${rel.with_label.toLowerCase()}; the comparison group is not shown for privacy`);
  const rows = [];
  const all = [];
  for (const g of rel.groups) {
    const members = rel.rows.filter((r) => r.group === g.id);
    if (g.title) rows.push({ header: true, label: g.title });
    for (const r of members.slice(0, RELATED_IN_CHART)) {
      rows.push({ label: r.label, note: isNum(r.ratio) ? null : "comparison not shown for privacy", d: isNum(r.ratio) ? { v: r.ratio, lo: r.lo, hi: r.hi, tip: tipFor(r) } : null });
    }
    if (g.title) all.push({ header: g.title });
    for (const r of members) {
      all.push([r.label, pct(r.with, d), isNum(r.without) ? pct(r.without, d) : "not shown for privacy",
        isNum(r.ratio) ? `${dec(r.ratio, 1)} (${dec(r.lo, 1)} to ${dec(r.hi, 1)})` : ""]);
    }
  }
  const shownRows = rows.filter((r) => r.d);
  const lo = Math.min(...shownRows.map((r) => r.d.lo));
  const hi = Math.max(...shownRows.map((r) => r.d.hi));
  const d0 = lo >= 1 ? 1 : lo >= 0.5 ? 0.5 : 0.25;
  const d1 = [2, 3, 5, 10, 20, 30, 50, 100].find((m) => hi <= m) || Math.ceil(hi);
  const ticks = [0.25, 0.5, 1, 2, 5, 10, 20, 50, 100].filter((t) => t >= d0 && t <= d1);
  const box = $("related-chart");
  responsive(box, () => dotChart(box, {
    title: rel.title,
    desc: `Ratio of the share of ${rel.with_label.toLowerCase()} with each code to the share of ${lowerFirst(rel.without_label)}, with 95% intervals, log scale. ${rel.note}`,
    rows, domain: [d0, d1], log: true, ticks, tickText: (t) => `${t}×`, xLabel: rel.x_label, refLine: { value: 1, label: "As common" },
  }));
  bindTooltips(box);
  $("related-table").replaceChildren(table(rel.title,
    [{ label: "Code" }, { label: rel.with_label, num: true }, { label: rel.without_label, num: true }, { label: "Times as common (95% CI)", num: true }],
    all));
  sourceLine("related-source", rel.source);
}

const lowerFirst = (s) => (/^[A-Z][a-z]/.test(s) ? s[0].toLowerCase() + s.slice(1) : s);
const upperFirst = (s) => s[0].toUpperCase() + s.slice(1);

// ---------- activity and sleep (conditions with a wearables or trajectory block) ----------
// Fitbit means with 95% CIs by group, one measure at a time: in the year before the survey (wearables), or week by
// week around COVID-19 (trajectory, Long COVID). Group sizes are never in the file or on the page.

const wearState = { measure: 0 };

/** "5,124" or "12.8": a mean in its measure's digits, with thousands separators. */
const meanText = (x, digits) => (isNum(x) ? x.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits }) : "not shown");

/** A nice linear domain around the shown intervals, at least 15% of the largest value wide, with 4 to 6 ticks. */
function meanAxis(lo, hi) {
  const span = Math.max(hi - lo, hi * 0.15, 1e-9);
  const pad = span * 0.08;
  let a = Math.max(0, lo - pad);
  let b = hi + pad;
  const raw = (b - a) / 5;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
  a = Math.floor(a / step) * step;
  b = Math.ceil(b / step) * step;
  const ticks = [];
  for (let t = a; t <= b + step / 1000; t += step) ticks.push(Math.round(t * 1e6) / 1e6);
  return { domain: [a, b], ticks };
}

function renderWearables(cond) {
  const w = cond.wearables;
  const t = cond.trajectory;
  const section = $("wearables");
  section.hidden = !w && !t;
  setText("wearables-live", "");
  if (t) {
    renderTrajectory(t);
    return;
  }
  if (!w) return;
  toggles("wearables-compare", [], () => {});
  wearState.measure = 0;
  setText("wearables-note", w.note);
  toggles("wearables-controls", w.measures.map((m) => m.label), (i) => {
    wearState.measure = i;
    drawWearables(cond);
  });
  legend("wearables-legend", [{ sw: "s1", label: "Mean, 95% CI" }]);
  sourceLine("wearables-source", w.source);
  drawWearables(cond);
}

function drawWearables(cond) {
  const w = cond.wearables;
  const m = w.measures[wearState.measure];
  const d = m.digits ?? 0;
  setText("wearables-takeaway", m.takeaway || "");
  setText("wearables-chart-title", m.title);
  const rows = [];
  const trows = [];
  for (const g of w.groups) {
    rows.push({ header: true, label: g.title });
    trows.push({ header: g.title });
    for (const r of m.rows.filter((x) => x.group === g.id)) {
      const shown = isNum(r.v);
      const tip = shown ? `${g.title}, ${lowerFirst(r.label)}: ${meanText(r.v, d)} ${m.phrase} (95% CI ${meanText(r.lo, d)} to ${meanText(r.hi, d)})` : null;
      rows.push({ label: r.label, note: shown ? null : WHY[r.why], d: shown ? { v: r.v, lo: r.lo, hi: r.hi, tip } : null });
      trows.push([r.label, shown ? meanText(r.v, d) : WHY[r.why], shown ? `${meanText(r.lo, d)} to ${meanText(r.hi, d)}` : ""]);
    }
  }
  const shownRows = m.rows.filter((r) => isNum(r.v));
  const box = $("wearables-chart");
  if (!shownRows.length) {
    box.replaceChildren(htmlEl("p", { class: "chart-note", text: "Not shown for privacy." }));
  } else {
    const { domain, ticks } = meanAxis(Math.min(...shownRows.map((r) => r.lo)), Math.max(...shownRows.map((r) => r.hi)));
    responsive(box, () => dotChart(box, {
      title: m.title, desc: `Mean and 95% interval for each group. ${w.note}`,
      rows, domain, ticks, tickText: (t) => meanText(t, Number.isInteger(t) ? 0 : 1), xLabel: m.x_label,
    }));
    bindTooltips(box);
  }
  $("wearables-table").replaceChildren(table(m.title, [{ label: "Group" }, { label: "Mean", num: true }, { label: "95% CI", num: true }], trows));
}

// Long COVID: weekly means with 95% CIs from 26 weeks before to 26 weeks after the COVID-19 diagnosis, by chart
// score at day 90, by new symptom types by day 90, or for everyone. Hidden weeks are null and stay gaps.
const trajState = { measure: 0, comparison: 0 };
const TRAJ_CLASS = { band_high_or_elevated: "s2", band_typical: "s1", sym_count_ge2: "s2", sym_count_lt2: "s1", all: "s1" };

function renderTrajectory(t) {
  trajState.measure = 0;
  trajState.comparison = 0;
  setText("wearables-takeaway", t.takeaway);
  setText("wearables-note", t.note);
  toggles("wearables-controls", t.measures.map((m) => m.label), (i) => {
    trajState.measure = i;
    drawTrajectory(t);
  });
  toggles("wearables-compare", t.comparisons.map((c) => c.label), (i) => {
    trajState.comparison = i;
    drawTrajectory(t);
  });
  sourceLine("wearables-source", t.source);
  drawTrajectory(t);
}

function drawTrajectory(t) {
  const m = t.measures[trajState.measure];
  const comp = t.comparisons[trajState.comparison];
  const d = m.digits ?? 0;
  const everyone = comp.id === "all";
  const series = comp.groups.map((g) => ({
    label: g.label, name: everyone ? g.label : `${comp.label}: ${g.label}`, cls: TRAJ_CLASS[g.id] || "s1", ...m.series[g.id],
  }));
  const title = everyone ? m.title : `${m.title}, by ${lowerFirst(comp.label)}`;
  setText("wearables-chart-title", title);
  const gaps = t.weeks.some((_, i) => series.every((s) => !isNum(s.v[i])));
  legend("wearables-legend", [
    ...series.map((s) => ({ sw: `line ${s.cls}`, label: s.name })),
    { sw: "ci-band", label: "95% CI" },
    ...(gaps ? [{ sw: "gap", label: "Not shown for privacy" }] : []),
  ]);
  const shown = series.flatMap((s) => [...s.lo, ...s.hi]).filter(isNum);
  const box = $("wearables-chart");
  if (!shown.length) {
    box.replaceChildren(htmlEl("p", { class: "chart-note", text: "Not shown for privacy." }));
  } else {
    const { domain, ticks } = meanAxis(Math.min(...shown), Math.max(...shown));
    responsive(box, () => lineChart(box, {
      title, desc: `Weekly mean and 95% interval for each group. ${t.note} Use the left and right arrow keys to read each week.`,
      weeks: t.weeks, series, digits: d, phrase: m.phrase, yLabel: m.y_label, domain, ticks, live: $("wearables-live"),
    }));
  }
  const cells = (s, i) => (isNum(s.v[i]) ? [meanText(s.v[i], d), `${meanText(s.lo[i], d)} to ${meanText(s.hi[i], d)}`] : [WHY.suppressed, ""]);
  $("wearables-table").replaceChildren(table(`${title}, weekly mean with 95% CI`, [
    { label: "Week" }, ...series.flatMap((s) => [{ label: `${s.name}, mean`, num: true }, { label: `${s.name}, 95% CI`, num: true }]),
  ], t.weeks.map((w, i) => [weekName(w), ...series.flatMap((s) => cells(s, i))])));
}

// ---------- cost calculator (conditions with a calculator block; Long COVID) ----------

const FIELDS = [
  { key: "screened", label: "Patients who had COVID-19, screened", unit: "patients", kind: "count", step: 100, min: 0 },
  { key: "flagShare", label: "Share flagged by the model", unit: "%", kind: "pct", step: 0.5, min: 0, max: 100 },
  { key: "recall", label: "Share of later-coded patients the flags catch (recall)", unit: "%", kind: "pct", step: 1, min: 0, max: 100,
    help: "Used only to show how many later-coded patients the flags miss." },
  { key: "ppv", label: "Share of flags who are later coded (positive predictive value)", unit: "%", kind: "pct", step: 0.1, min: 0, max: 100 },
  { key: "excessCost", label: "Extra spending before the code", unit: "$ per later-coded patient", kind: "money", step: 50, min: 0 },
  { key: "odysseyDays", label: "Window of that extra spending", unit: "days", kind: "count", step: 5, min: 1 },
  { key: "leadDays", label: "How much earlier a flagged patient is recognized", unit: "days", kind: "count", step: 5, min: 0, assumption: true },
  { key: "avoidable", label: "Share of extra spending avoidable", unit: "%", kind: "pct", step: 5, min: 0, max: 100, assumption: true,
    help: "Of the extra spending inside the lead time." },
  { key: "reviewMinutes", label: "Clinician review per patient", unit: "minutes", kind: "count", step: 1, min: 0, assumption: true },
  { key: "clinicianHourly", label: "Clinician cost", unit: "$ per hour", kind: "money", step: 10, min: 0, assumption: true },
  { key: "questionnairePass", label: "Share of flagged patients passing the questionnaire", unit: "%", kind: "pct", step: 5, min: 0, max: 100, assumption: true,
    help: "Two-step screen: only these reach a clinician." },
  { key: "questionnaireSensitivity", label: "Share of later-coded patients passing the questionnaire", unit: "%", kind: "pct", step: 5, min: 0, max: 100, assumption: true,
    help: "The default of 80% assumes the questionnaire misses 1 in 5 patients who are later coded. 100% is the best case." },
];

let costReady = false;

function renderCost(cond) {
  const calc = cond.calculator;
  $("cost").hidden = !calc;
  if (!calc) return;
  const m = calc.measured;
  setText("cost-model", `Recall and positive predictive value come from the ${calc.model}: ${pct(m.recall, 0)} and ${pct(m.ppv, 1)} for the top 5% of scores.`);
  sourceLine("cost-source", calc.source);
  if (!costReady) {
    costReady = true;
    panelCost(m);
  }
}

function panelCost(measured) {
  const inputsBox = $("calc-inputs");
  const inputs = new Map();
  const toDisplay = (f, v) => (f.kind === "pct" ? Math.round(v * 1000) / 10 : v);
  const fromDisplay = (f, v) => (f.kind === "pct" ? v / 100 : v);
  const help = {
    excessCost: `Measured: $${measured.excess_cost.toFixed(2)} more per later-coded patient, over a median window of ${int(measured.window_days)} days.`,
    leadDays: `Measured: among later-coded patients in the top 5%, the score came a median of ${int(measured.lead_days)} days before the code (middle half ${int(measured.lead_p25_days)} to ${int(measured.lead_p75_days)}).`,
    recall: `Measured: ${pct(measured.recall, 0)} for the top 5% of day-90 scores.`,
    ppv: `Measured: ${pct(measured.ppv, 1)} for the top 5% of day-90 scores.`,
  };

  for (const f of FIELDS) {
    const id = `calc-${f.key}`;
    const notes = [f.help, help[f.key]].filter(Boolean);
    const input = htmlEl("input", {
      id, type: "number", inputmode: "decimal", step: f.step, min: f.min, max: f.max ?? null,
      value: toDisplay(f, DEFAULTS[f.key]), "aria-describedby": notes.length ? `${id}-help` : null,
    });
    inputs.set(f.key, input);
    inputsBox.append(htmlEl("div", { class: `calc-field${f.assumption ? " assumption" : ""}` }, [
      htmlEl("label", { for: id, text: f.label }),
      htmlEl("div", { class: "input-row" }, [input, htmlEl("span", { class: "unit", text: f.unit })]),
      notes.length ? htmlEl("p", { class: "help", id: `${id}-help`, text: notes.join(" ") }) : null,
    ]));
  }

  const read = () => {
    const v = {};
    for (const f of FIELDS) {
      const raw = inputs.get(f.key).value.trim();
      const x = raw === "" ? NaN : Number(raw);
      v[f.key] = Number.isFinite(x) ? fromDisplay(f, x) : DEFAULTS[f.key];
    }
    return v;
  };

  const chartBox = $("calc-chart");
  let last = compute(DEFAULTS);

  function card(title, s) {
    const dd = (value, cls) => htmlEl("dd", { class: cls || null, text: value });
    return htmlEl("div", { class: "result-card" }, [
      htmlEl("h4", { text: title }),
      htmlEl("dl", {}, [
        htmlEl("dt", { text: "Review cost per later-coded patient found" }), dd(money(s.costPerFound)),
        htmlEl("dt", { text: "Patients reviewed by a clinician" }), dd(int(s.reviewed)),
        htmlEl("dt", { text: "Clinician hours" }), dd(one(s.clinicianHours)),
        htmlEl("dt", { text: "Clinician review cost" }), dd(money(s.reviewCost)),
        htmlEl("dt", { text: "Later-coded patients found" }), dd(one(s.found)),
        htmlEl("dt", { text: "Share of reviewed who are later coded" }), dd(pct(s.ppvAmongReviewed, 1)),
        htmlEl("dt", { text: "Avoided extra spending" }), dd(money(s.avoided)),
        htmlEl("dt", { text: "Avoided spending minus review cost" }), dd(money(s.net), s.net < -0.5 ? "neg" : null),
        htmlEl("dt", { text: "Avoidable share needed to break even" }), dd(isNum(s.breakEvenAvoidable) ? pct(s.breakEvenAvoidable, 0) : "not defined"),
      ]),
    ]);
  }

  function drawChart() {
    const r = last;
    const W = boxWidth(chartBox);
    const small = W < 560;
    const fs = small ? 13 : 15;
    const labelW = Math.round(Math.min(230, Math.max(116, W * 0.32)));
    const x0 = labelW;
    const x1 = W - (small ? 62 : 90);
    const groups = [["Two-step screen", r.twoStep], ["Chart review of every flag", r.chart]];
    const barH = small ? 14 : 18;
    const groupH = barH * 2 + 6 + fs * 1.6;
    const top = 6;
    const plotBottom = top + groups.length * groupH - fs;
    const H = Math.ceil(plotBottom + fs * 3.4);
    const max = Math.max(1, ...groups.flatMap(([, s]) => [s.reviewCost, s.avoided]));
    const x = (v) => x0 + (Math.max(0, v) / max) * (x1 - x0);
    const svg = svgRoot(W, H, `Clinician review cost and avoided extra spending per ${int(r.inputs.screened)} patients screened`,
      `Two-step screen: review cost ${money(r.twoStep.reviewCost)}, avoided ${money(r.twoStep.avoided)}. Chart review: review cost ${money(r.chart.reviewCost)}, avoided ${money(r.chart.avoided)}.`);
    groups.forEach(([name, s], i) => {
      const gy = top + i * groupH;
      const words = name.split(" ");
      const lines = small && words.length > 2 ? [words.slice(0, 2).join(" "), words.slice(2).join(" ")] : [name];
      lines.forEach((ln, k) => svg.append(svgEl("text", { class: "row-label strong", x: 4, y: gy + barH * 0.8 + k * fs * 1.15, "font-size": fs }, ln)));
      [["reviewCost", "Review cost", "s2"], ["avoided", "Avoided spending", "s1"]].forEach(([k, lab, cls], j) => {
        const by = gy + j * (barH + 4);
        const g = svgEl("g", { class: cls, "data-tip": `${name}, ${lab.toLowerCase()}: ${money(s[k])}` });
        g.append(svgEl("rect", { class: "bar", x: x0, y: by, width: Math.max(1, x(s[k]) - x0), height: barH, rx: 3 }));
        g.append(svgEl("text", { class: "val-label", x: x(s[k]) + 6, y: by + barH * 0.75, "font-size": fs - 1 }, money(s[k])));
        svg.append(g);
      });
    });
    svg.append(svgEl("line", { class: "ax-base", x1: x0, x2: x0, y1: top - 2, y2: plotBottom }));
    svg.append(svgEl("line", { class: "ax-base", x1: x0, x2: x1, y1: plotBottom, y2: plotBottom }));
    svg.append(svgEl("text", { class: "ax-text", x: x0, y: plotBottom + fs * 1.3, "text-anchor": "middle", "font-size": fs - 1 }, "$0"));
    svg.append(svgEl("text", { class: "ax-text", x: x1, y: plotBottom + fs * 1.3, "text-anchor": "middle", "font-size": fs - 1 }, money(max)));
    svg.append(svgEl("text", { class: "ax-title", x: (x0 + x1) / 2, y: plotBottom + fs * 2.9, "text-anchor": "middle", "font-size": fs }, "Dollars"));
    chartBox.replaceChildren(svg);
  }

  function formulas(r) {
    const v = r.inputs;
    const p = (x) => pct(x, Math.round(x * 1000) % 10 ? 1 : 0);
    const items = [
      ["Flags", `screened × share flagged = ${int(v.screened)} × ${p(v.flagShare)} = ${one(r.flags)}`],
      ["Later-coded patients among the flags", `flags × PPV = ${one(r.flags)} × ${p(v.ppv)} = ${one(r.found)}`],
      ["Later-coded patients in the screened group (implied by recall)", `found ÷ recall = ${one(r.found)} ÷ ${p(v.recall)} = ${one(r.impliedLaterCoded)}, so the flags miss ${one(r.missedLaterCoded)}`],
      ["Two-step screen", `reviewed = ${one(r.flags)} × ${p(v.questionnairePass)} = ${one(r.twoStep.reviewed)}; found = ${one(r.found)} × ${p(v.questionnaireSensitivity)} = ${one(r.twoStep.found)}; review cost = ${one(r.twoStep.reviewed)} × ${one(v.reviewMinutes)} min ÷ 60 × ${money(v.clinicianHourly)} = ${money(r.twoStep.reviewCost)}; cost per patient found = ${money(r.twoStep.reviewCost)} ÷ ${one(r.twoStep.found)} = ${money(r.twoStep.costPerFound)}`],
      ["Chart review of every flag", `review cost = ${one(r.chart.reviewed)} flags × ${one(v.reviewMinutes)} min ÷ 60 × ${money(v.clinicianHourly)} = ${money(r.chart.reviewCost)}; cost per patient found = ${money(r.chart.reviewCost)} ÷ ${one(r.chart.found)} = ${money(r.chart.costPerFound)}`],
      ["Lead fraction", `min(lead time ÷ window, 1) = min(${int(v.leadDays)} ÷ ${int(v.odysseyDays)}, 1) = ${r.leadFraction.toFixed(2)}`],
      ["Avoided spending per later-coded patient found", `extra spending × lead fraction × avoidable = ${money(v.excessCost)} × ${r.leadFraction.toFixed(2)} × ${p(v.avoidable)} = ${money(r.avoidedPerFound)}`],
      ["Avoided spending", `two-step ${one(r.twoStep.found)} × ${money(r.avoidedPerFound)} = ${money(r.twoStep.avoided)} (difference from review cost ${money(r.twoStep.net)}); chart review ${one(r.chart.found)} × ${money(r.avoidedPerFound)} = ${money(r.chart.avoided)} (difference ${money(r.chart.net)})`],
      ["Break-even avoidable share", `review cost ÷ (found × extra spending × lead fraction): two-step ${isNum(r.twoStep.breakEvenAvoidable) ? pct(r.twoStep.breakEvenAvoidable, 0) : "not defined"}, chart review ${isNum(r.chart.breakEvenAvoidable) ? pct(r.chart.breakEvenAvoidable, 0) : "not defined"}`],
    ];
    $("calc-formulas").replaceChildren(...items.map(([k, eq]) => htmlEl("li", {}, [
      htmlEl("strong", { text: `${k}: ` }), htmlEl("span", { class: "eq", text: eq }),
    ])));
  }

  function update() {
    last = compute(read());
    const r = last;
    const v = r.inputs;
    const lead = int(v.leadDays);
    const per = `per ${int(v.screened)} patients screened`;
    const upTo = v.questionnaireSensitivity >= 1 ? "up to " : "";
    const isDefault = Object.keys(DEFAULTS).every((k) => Math.abs(v[k] - DEFAULTS[k]) < 1e-9);
    setText("cost-takeaway", `With ${isDefault ? "the default" : "these"} assumptions, a two-step screen costs ${money(r.twoStep.costPerFound)} in clinician review time for each later-coded patient it finds, and chart review of every flag costs ${money(r.chart.costPerFound)}, each finding patients about ${lead} days before their Long COVID code.`);
    setText("cost-setting", `Setting: ${int(v.screened)} patients who had COVID-19 are scored by the model at day 90, and the top ${pct(v.flagShare, Math.round(v.flagShare * 1000) % 10 ? 1 : 0)} (${one(r.flags)} patients) are flagged. A later-coded patient is one who receives the Long COVID code later on.`);
    setText("hc-two-cpf", money(r.twoStep.costPerFound));
    setText("hc-two-reviewed", one(r.twoStep.reviewed));
    setText("hc-two-found", one(r.twoStep.found));
    setText("hc-two-cost", money(r.twoStep.reviewCost));
    setText("hc-two-lead", lead);
    setText("hc-two-sens", pct(v.questionnaireSensitivity, 0));
    setText("hc-chart-cpf", money(r.chart.costPerFound));
    setText("hc-chart-reviewed", one(r.chart.reviewed));
    setText("hc-chart-found", one(r.chart.found));
    setText("hc-chart-cost", money(r.chart.reviewCost));
    setText("hc-chart-lead", lead);
    setText("cost-avoided", `Before their first code, later-coded patients have about ${money(v.excessCost)} more in visits and tests than similar patients without the code. If earlier recognition avoids part of that, chart review of every flag avoids an estimated ${money(r.chart.avoided)} against ${money(r.chart.reviewCost)} of review cost, and the two-step screen avoids ${upTo || "an estimated "}${money(r.twoStep.avoided)} against ${money(r.twoStep.reviewCost)}, ${per}.`);
    setText("calc-chart-title", `Clinician review cost and avoided spending ${per}`);
    const adjusted = r.adjustments.length
      ? [htmlEl("div", { class: "result-card calc-adjusted", role: "status" }, [
        htmlEl("h4", { text: "Inputs adjusted to a possible scenario" }),
        htmlEl("ul", {}, r.adjustments.map((a) => htmlEl("li", { text: a.message }))),
      ])]
      : [];
    $("calc-results").replaceChildren(
      ...adjusted,
      card("Two-step screen", r.twoStep),
      card("Chart review of every flag", r.chart),
      htmlEl("div", { class: "result-card" }, [
        htmlEl("h4", { text: "Both strategies" }),
        htmlEl("dl", {}, [
          htmlEl("dt", { text: "Flags" }), htmlEl("dd", { text: one(r.flags) }),
          htmlEl("dt", { text: "Later-coded patients among the flags" }), htmlEl("dd", { text: one(r.found) }),
          htmlEl("dt", { text: "Later-coded patients implied in the screened group" }), htmlEl("dd", { text: one(r.impliedLaterCoded) }),
          htmlEl("dt", { text: "Later-coded patients the flags miss" }), htmlEl("dd", { text: one(r.missedLaterCoded) }),
          htmlEl("dt", { text: "Avoided spending per patient found" }), htmlEl("dd", { text: money(r.avoidedPerFound) }),
        ]),
      ]),
    );
    formulas(r);
    drawChart();
  }

  legend("calc-legend", [{ sw: "s2 square", label: "Clinician review cost" }, { sw: "s1 square", label: "Avoided extra spending" }]);
  $("calc-form").addEventListener("input", update);
  $("calc-form").addEventListener("submit", (ev) => ev.preventDefault());
  $("calc-reset").addEventListener("click", () => {
    for (const f of FIELDS) inputs.get(f.key).value = toDisplay(f, DEFAULTS[f.key]);
    update();
  });
  update();
  responsive(chartBox, drawChart);
  bindTooltips(chartBox);
}

// ---------- condition selector and routing ----------

const cache = new Map();
let manifest = null;
let current = null;

// The conditions in their families (index.json "families"; one unnamed family when the index has none).
function families() {
  const fams = manifest.families?.length ? manifest.families : [{ id: "", label: "" }];
  return fams.map((f) => ({ ...f, conditions: manifest.conditions.filter((c) => (c.family || "") === f.id) }))
    .filter((f) => f.conditions.length);
}

// Two views of one choice: on wide screens, links grouped under family names (one address per condition); on
// phones, the same groups in a native select (CSS shows one or the other). Both push the condition's address.
function buildPicker() {
  const fams = families();
  $("picker").replaceChildren(...fams.map((f) => {
    const id = `family-${f.id || "all"}`;
    return htmlEl("li", { class: "family" }, [
      f.label ? htmlEl("span", { class: "family-label", id, text: f.label }) : null,
      htmlEl("ul", { "aria-labelledby": f.label ? id : null }, f.conditions.map((c) => htmlEl("li", {}, [
        htmlEl("a", { href: conditionHref(c.slug), "data-slug": c.slug, text: c.label }),
      ]))),
    ]);
  }));
  const options = (list) => list.map((c) => htmlEl("option", { value: c.slug, text: c.label }));
  $("picker-select").replaceChildren(...fams.flatMap((f) => (f.label ? [htmlEl("optgroup", { label: f.label }, options(f.conditions))] : options(f.conditions))));
  const go = (slug) => {
    if (!slug || slug === current) return;
    history.pushState({ slug }, "", conditionHref(slug));
    show(slug);
  };
  $("picker").addEventListener("click", (ev) => {
    const a = ev.target instanceof Element ? ev.target.closest("a[data-slug]") : null;
    if (!a || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey || ev.button !== 0) return;
    ev.preventDefault();
    go(a.getAttribute("data-slug"));
  });
  $("picker-select").addEventListener("change", (ev) => go(ev.target.value));
}

async function show(slug, opts = {}) {
  current = slug;
  for (const a of $("picker").querySelectorAll("a[data-slug]")) {
    if (a.getAttribute("data-slug") === slug) a.setAttribute("aria-current", "true");
    else a.removeAttribute("aria-current");
  }
  $("picker-select").value = slug;
  let cond = cache.get(slug);
  if (!cond) {
    const entry = manifest.conditions.find((c) => c.slug === slug);
    try {
      cond = await loadJSON(entry.file.replace(/\.json$/u, ""));
      cache.set(slug, cond);
    } catch (e) {
      showError("summary", "Data for this condition could not be loaded.");
      console.error(e);
      return;
    }
  }
  if (current !== slug) return;
  setText("atlas-title", cond.name);
  setText("definition", cond.definition);
  document.title = `${cond.label} Atlas | Undiagnosed No More`;
  const panels = [["summary", renderSummary], ["where-map", renderMap], ["who-chart", renderWho], ["related-chart", renderRelated],
    ["wearables-chart", renderWearables], ["calc-results", renderCost]];
  for (const [box, fn] of panels) {
    try { fn(cond); } catch (e) {
      showError(box, "This part of the page could not be drawn.");
      console.error(e);
    }
  }
  if (!opts.initial) setText("announce", `Showing ${cond.label}`);
  if (opts.initial && location.hash) {
    let target = null;
    try { target = document.querySelector(location.hash); } catch (e) { target = null; }
    if (target && !target.hidden) requestAnimationFrame(() => target.scrollIntoView());
  }
}

async function main() {
  try {
    const r = await fetch(`${DATA}index.json`, { cache: "no-cache" });
    if (!r.ok) throw new Error(`index.json: HTTP ${r.status}`);
    manifest = await r.json();
  } catch (e) {
    showError("summary", "The Atlas data could not be loaded.");
    console.error(e);
    return;
  }
  buildPicker();
  const route = resolveCondition(location.search, manifest);
  if (!route.slug) return;
  if (!route.canonical) history.replaceState({ slug: route.slug }, "", `${conditionHref(route.slug)}${location.hash}`);
  window.addEventListener("popstate", () => {
    const next = resolveCondition(location.search, manifest).slug;
    if (next && next !== current) show(next);
  });
  await show(route.slug, { initial: true });
}

main();
