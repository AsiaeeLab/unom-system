#!/usr/bin/env python3
"""Build the models guide and the generated parts of the developer pages.

Everything is read from files in the repository, so rerunning reproduces the outputs:

  inputs   model/*.json except *.example.json                       (the model files: every one is listed)
           model/test_vectors/bundles/*.json, expected/<id>-<ver>/  (synthetic patients)
           model/test_vectors/make_bundles.py                       (scenario of each patient)
           model/reference/score_fhir.py                            (rechecks every expected output)
           web/functions/cds-services/                              (models the service runs, discovery, cards)
           web/web/athena/cards.js, web/web/patient/records.js      (models and rule cards each app shows)
           submission/app_questionnaire.md                          (patient follow-up questions)
           opendata/processed/lyme_county_incidence.csv             (Lyme county prior)
           docs/interface/model_spec.md                             (interface spec)
  outputs  docs/MODELS_GUIDE.md
           web/web/developers/models     (same content as the guide)
           web/web/developers/spec       (model_spec.md rendered as HTML)
           web/web/developers/vectors/        (copies of the bundles and current expected outputs)
           web/web/developers/vectors/all-vectors.zip  (the same files in one download)
           web/web/developers/examples/       (CDS Hooks example requests built from the bundles)
           web/web/developers/examples/responses/  (the service's discovery document and its answer to each)
           web/web/models/index.json          (the model registry: id, version, file, SHA-256 of each model)
           web/web/developers/index.html      (only the blocks between "generated:" markers)

A new model file in model/ appears in the registry, the models guide, the vectors table, and the in-page scorer
once its copy is in web/web/models/ (web/tools/sync_models.sh) and its expected outputs exist
(model/test_vectors/make_bundles.py). The CDS Hooks service, the clinician app, and the patient app list their
models in code; the registry shows which of them runs each file. Runs node (for the service's and the apps' code).

Usage: python3 analysis/build_models_guide.py
"""

from __future__ import annotations

import csv
import datetime as dt
import hashlib
import html
import json
import re
import shutil
import subprocess
import sys
import zipfile
from collections import Counter
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
WEB = REPO / "web" / "web"
DEV = WEB / "developers"
sys.path.insert(0, str(REPO / "model" / "reference"))
from score_fhir import score_bundle  # noqa: E402
sys.path.insert(0, str(REPO / "model" / "test_vectors"))
from make_bundles import full_url  # noqa: E402
sys.path.insert(0, str(REPO / "analysis"))
from build_clinician_interface import fhir_inputs  # noqa: E402

# Test patients in the order the tables list them (the demo patients first); main() checks that this is every
# bundle in model/test_vectors/bundles/.
PATIENTS = ["maria", "james", "rosa", "lee", "nora", "dana", "elena", "omar", "grace", "sofia",
            "priya", "sam", "theo", "yara", "vera", "will", "uma", "kai"]
# CDS Hooks example requests: name -> (patient, prefetch keys left out). A left-out key with no fhirServer shows
# what the service does when a search could not be read.
EXAMPLES = {"maria": ("maria", []), "elena": ("elena", []),
            "maria-missing-observations": ("maria", ["observations"])}
SITE = "https://undiagnosednomore.org"
CDS_AS_OF_EXTENSION = "org.undiagnosednomore.scoring-date"
# Cards in the clinician app with no model file yet: tab slug -> the file that implements the card today.
RULE_FILES = {"lyme": "web/web/athena/lyme-rule.js", "lupus": "web/web/athena/rule.js"}

# The side navigation of every developer page: (group, [(label, section id on /developers/ or page path)]).
NAV = [
    ("Start", [("Overview", "#overview"), ("Try the scorer", "#try")]),
    ("Integrate", [("CDS Hooks service", "#cds-hooks"), ("SMART on FHIR app", "#ehr-launch"),
                   ("Scorer library", "#scoring")]),
    ("Reference", [("Model registry", "#registry"), ("Model contract", "#spec"), ("FHIR inputs", "#fhir-inputs"),
                   ("Test vectors", "#vectors"), ("Versioning", "#versioning"), ("Source code", "#source")]),
    ("Documents", [("Models guide", "/developers/models"), ("Interface spec", "/developers/spec")]),
]

# Card text and next steps that live outside the model files. The card wording is read from the CDS Hooks
# service (web/functions/cds-services/_cds.js, CONDITIONS), so the guide quotes what the card says. The public
# pages describe sources in plain words; the internal source of each piece is noted in a comment here.
# Papers on the Research page that the guide cites (validation numbers and labels come from them).
PAPERS = {
    "p1": ("Paper 1", "/about/papers/p1-long-covid-undercoding.pdf"),
    "p3": ("Paper 3", "/about/papers/p3-self-report-trained-models.pdf"),
}
CARDS = {
    "unm-longcovid": {
        "anchor": "long-covid",
        "title": "Long COVID",
        "label_limit": ("The label is a future Long COVID code. Codes miss most cases, so a Typical band does not mean "
                        "the patient is well."),
        "questionnaire": True,
        "wording_extra": [
            "The model predicts a future Long COVID code, and codes miss most cases, so the card keeps the "
            '"not a diagnosis" line.',
        ],
        "paper": "p1",
        # Source of the text: Paper 1 (Methods and Results) and results/aggregate/35/t35_guard_summary.csv.
        "features_note": ("Condition features use ICD-10-CM codes from both the condition and the observation "
                          "tables for every predictor"),
        "next_steps": [
            "Review the dated chart findings behind the score (each driver links to the resources that triggered it).",
            "Ask the patient to complete the follow-up questions below (RECOVER symptom list, DePaul PEM screen, "
            "PCFS grade, change items); the answers come back as a FHIR QuestionnaireResponse labeled \"patient report\".",
            "Flag for clinician review if the chart band is High, or the RECOVER score is 11 or more, or the PEM "
            "screen is positive. The chart probability and the questionnaire scores are never added into one number.",
            "If the review supports post-COVID illness, the card names the next step: a post-COVID clinic "
            "referral or clinical trial screening.",
        ],
        "next_steps_source": "the patient questionnaire design, which sets the triage rule in step 3",
    },
    "unm-chronicfatigue": {
        "anchor": "chronic-fatigue",
        "title": "Chronic fatigue and ME/CFS",
        "label_limit": ("The label is a survey self-report of a diagnosis, given by adults who had no code for it "
                        "at the time; most of these diagnoses were never coded afterward. A self-report does not "
                        "establish the condition, and the model inherits the limits of self-report."),
        "wording_extra": ["It is a prompt to ask the patient, not a diagnosis."],
        "paper": "p3",
        # Paper 3, Results: 7,770 self-reporters, 7,350 of them (95%) with no qualifying code observed after the survey.
        "label_note": ("Trained on self-reported diagnoses: adults who answered in the All of Us Personal and Family "
                       "Health History survey that a clinician had told them they have chronic fatigue. Everyone in "
                       "the training cohort had no chronic fatigue or ME/CFS code by the survey date, and most of "
                       "these self-reported diagnoses were never coded afterward: 95% of the self-reporters had no "
                       "code observed after the survey"),
        "validation_csv": "results/aggregate/33/t33_metrics.csv",
        "paper_table_row": "Chronic fatigue",
        "next_steps": [
            "Review the dated chart findings behind the score.",
            "Ask the patient to complete the DePaul post-exertional malaise screen above.",
            "Walk through the IOM 2015 criteria checklist above with the patient; the checklist records the "
            "clinician's judgment and is not scored by the app.",
        ],
        "next_steps_source": "the IOM 2015 report and the DePaul screen (citations above)",
        "pem": True,
        "checklist": "iom",
    },
    "unm-fibromyalgia": {
        "anchor": "fibromyalgia",
        "title": "Fibromyalgia",
        "label_limit": ("The label is a survey self-report of a diagnosis, given by adults who had no code for it "
                        "at the time; most of these diagnoses were never coded afterward. A self-report does not "
                        "establish the condition, and the model inherits the limits of self-report."),
        "wording_extra": ["It is a prompt to ask the patient, not a diagnosis."],
        "paper": "p3",
        # Paper 3, Results: 4,810 self-reporters, 4,270 of them (89%) with no code observed after the survey.
        "label_note": ("Trained on self-reported diagnoses: adults who answered in the All of Us Personal and Family "
                       "Health History survey that a clinician had told them they have fibromyalgia. Everyone in "
                       "the training cohort had no fibromyalgia code by the survey date, and most of these "
                       "self-reported diagnoses were never coded afterward: 89% of the self-reporters had no code "
                       "observed after the survey"),
        "validation_csv": "results/aggregate/39/t39_fibromyalgia_metrics.csv",
        "paper_table_row": "Fibromyalgia",
        "next_steps": [
            "Review the dated chart findings behind the score.",
            "Assess the patient with the 2016 revised fibromyalgia diagnostic criteria above, using the Widespread "
            "Pain Index and the Symptom Severity Scale.",
            "The checklist records the clinician's judgment and is not scored by the app.",
        ],
        "next_steps_source": "Wolfe et al. 2016 (citation above)",
        "pem": False,
        "checklist": "fibro2016",
    },
}
# The exported summary-count model in the validation metric files, and the two targets Paper 3 reports for it.
VALIDATION_MODEL = "nb_sr_exported"
VALIDATION_TARGETS = [("self-report", "Self-reported diagnosis"),
                      ("self-report, never coded", "Self-reported diagnosis with no code observed after the survey")]
# Participant-level comparator names in the Long COVID model file (Paper 1, Methods: M2 and M4).
COMPARATORS = {"M2_elastic_net_logistic": "elastic-net logistic regression fit to participant-level data",
               "M4_pu_bagging": "bagged positive-unlabeled learning fit to participant-level data"}
# Text that must not appear on the public developer pages: internal task labels and internal folders.
INTERNAL = re.compile(r"\bTask \d+|results/aggregate|handoffs/|notes/|literature/|submission/|\bM[0-4]_")

IOM_CITATION = "Institute of Medicine, Beyond Myalgic Encephalomyelitis/Chronic Fatigue Syndrome, 2015"
IOM_CHECKLIST = [
    "Substantial reduction in pre-illness activity, lasting more than 6 months, with fatigue",
    "Post-exertional malaise",
    "Unrefreshing sleep",
    "At least one of: cognitive impairment, or orthostatic intolerance",
]
FIBRO_CITATION = ("Wolfe F et al. 2016 revisions to the 2010/2011 fibromyalgia diagnostic criteria. "
                  "Semin Arthritis Rheum 2016;46(3):319-329, doi:10.1016/j.semarthrit.2016.08.012")
FIBRO_CHECKLIST = [
    "Widespread Pain Index (WPI) of 7 or more and Symptom Severity Scale (SSS) score of 5 or more, or WPI of 4 to 6 and SSS of 9 or more",
    "Generalized pain: pain in at least 4 of 5 body regions (jaw, chest, and abdominal pain do not count toward it)",
    "Symptoms present at a similar level for at least 3 months",
    "The diagnosis is valid irrespective of other diagnoses and does not exclude other clinically important illnesses",
]
CHECKLISTS = {
    "iom": ("IOM 2015 ME/CFS criteria", f"Diagnosis requires all of the following ({IOM_CITATION}):", IOM_CHECKLIST),
    "fibro2016": ("2016 revised fibromyalgia diagnostic criteria",
                  f"A patient meets the criteria when all of the following hold ({FIBRO_CITATION}):", FIBRO_CHECKLIST),
}
EULAR_ACR = ("Aringer M et al. 2019 European League Against Rheumatism/American College of Rheumatology "
             "Classification Criteria for Systemic Lupus Erythematosus. Arthritis Rheumatol 2019;71(9):1400-1412, "
             "doi:10.1002/art.40930")


RECOVER_SOURCE = "Geng et al., JAMA 2025;333:694–700"


def read(rel):
    return (REPO / rel).read_text(encoding="utf-8")


def load_json(rel):
    return json.loads(read(rel))


def need(match, what):
    if not match:
        raise SystemExit(f"build_models_guide: could not find {what}; the source file changed")
    return match


def paper_link(key):
    label, url = PAPERS[key]
    return f"[{label}]({url})"


def node_json(js):
    """Runs an ES module snippet with node from the repository root and parses the JSON it prints."""
    try:
        out = subprocess.run(["node", "--input-type=module", "-e", js], cwd=REPO, check=True,
                             capture_output=True, text=True)
    except FileNotFoundError:
        raise SystemExit("build_models_guide: node is required (it runs the CDS Hooks service and the apps' code)")
    except subprocess.CalledProcessError as e:
        raise SystemExit(f"build_models_guide: node failed:\n{e.stderr}")
    return json.loads(out.stdout)


def site_facts(example_files):
    """What the running code says, read with node: the model files the CDS Hooks service scores (in its order),
    its discovery document, card wording, and answer to each example request; the model cards and tabs of the
    clinician app; and the model files of the patient app."""
    files = json.dumps([p.relative_to(REPO).as_posix() for p in example_files])
    return node_json(
        "import { readFileSync } from 'node:fs';"
        "import { CONDITIONS, DISCOVERY } from './web/functions/cds-services/_cds.js';"
        "import { MODELS, respond } from './web/functions/cds-services/invisible-illness.js';"
        "import { MODEL_CARDS, TABS } from './web/web/athena/cards.js';"
        "import { MODELS as PATIENT_MODELS } from './web/web/patient/records.js';"
        f"const files = {files};"
        "const responses = {};"
        "for (const f of files) {"
        "  const r = await respond(JSON.parse(readFileSync(f, 'utf8')));"
        "  responses[f] = { status: r.status, body: await r.json() };"
        "}"
        "console.log(JSON.stringify({ discovery: DISCOVERY, conditions: CONDITIONS,"
        "  cds: MODELS.map((m) => `${m.model_id}-${m.version}`),"
        "  cards: MODEL_CARDS.map((c) => ({ slug: c.slug, title: c.title, url: c.url })), tabs: TABS,"
        "  patient: Object.values(PATIENT_MODELS).map((m) => m.file), responses }));")


def model_paths():
    """The model files: model/*.json except the placeholder example. Each must have an identical copy in
    web/web/models/, because the pages link and score the copy."""
    out = []
    for path in sorted((REPO / "model").glob("*.json")):
        if path.name.endswith(".example.json"):
            continue
        copy = WEB / "models" / path.name
        if not copy.exists() or copy.read_bytes() != path.read_bytes():
            raise SystemExit(f"build_models_guide: web/web/models/{path.name} is missing or differs from "
                             f"model/{path.name}; add it to web/tools/sync_models.sh and run it")
        out.append(path)
    need(out, "a model file in model/")
    return out


def card_meta(model, path, facts):
    """Page text for one model: CARDS when the model has an entry there, otherwise what the model file gives."""
    short = model["model_id"].removeprefix("unm-")
    base = CARDS.get(model["model_id"]) or {
        "anchor": short, "title": model.get("title") or short.replace("-", " ").capitalize(), "wording_extra": []}
    key = f"{model['model_id']}-{model['version']}"
    url = f"/models/{path.name}"
    runs = [name for name, yes in (("CDS Hooks service", key in facts["cds"]),
                                   ("clinician app (SMART on FHIR and demo)", url in [c["url"] for c in facts["cards"]]),
                                   ("patient app", url in facts["patient"])) if yes]
    return dict(base, download=path.name, url=url, cds=facts["conditions"].get(model["model_id"]), runs=runs)


def rule_cards(facts):
    """Tabs of the clinician app that no model file drives yet, with the file that implements each today."""
    model_slugs = {c["slug"] for c in facts["cards"]}
    out = []
    for tab in facts["tabs"]:
        if tab["slug"] in model_slugs or tab["slug"] not in RULE_FILES:
            continue
        need((REPO / RULE_FILES[tab["slug"]]).exists(), RULE_FILES[tab["slug"]])
        out.append({"slug": tab["slug"], "label": tab["label"], "file": RULE_FILES[tab["slug"]]})
    return out


def plain_method(text):
    """The model file's method line in plain words: no internal model labels, the rounding stated exactly, and no
    claim that the label is a diagnosis that was never coded (the label_note in CARDS says what the label is)."""
    text = re.sub(r"^nb_eb: ", "Naive Bayes with empirical-Bayes shrinkage, ", text)
    text = re.sub(r"rounded (?:up )?to 10\b", "rounded up to a multiple of 10", text)
    text = re.sub(r"; labels are survey self-reports, so the model learns from patients whose diagnosis was never coded",
                  "", text)
    return text


def public_scoring(text):
    """An instrument's scoring cell from the questionnaire design, with the team's task-list reference replaced by
    the published source of the point values."""
    return re.sub(r"point values in `handoffs/kaveh_tasks\.md`, K5", "point values from the Table of Geng et al. 2025",
                  text)


def validation_rows(card):
    """AUROC with its 95% CI for the exported summary-count model, from the released metrics file, rounded as in
    Paper 3 and checked against Paper 3's main table."""
    rows = {r["target"]: r for r in csv.DictReader(open(REPO / card["validation_csv"], encoding="utf-8"))
            if r["model"] == VALIDATION_MODEL}
    paper_row = None   # checked only where Paper 3's manuscript is in the repository
    if (REPO / "paper3/tables/main.tex").exists():
        table = read("paper3/tables/main.tex")
        start = need(re.search(rf"\\textit{{{card['paper_table_row']}}}", table), f"{card['paper_table_row']} in Paper 3's table")
        paper_row = need(re.search(r"Summary counts & Self-report & .+? & .+? &", table[start.end():]),
                         f"the {card['paper_table_row']} summary-count row in Paper 3's table").group(0)
    out, cells = [], []
    for target, label in VALIDATION_TARGETS:
        r = need(rows.get(target), f"the {target} row in {card['validation_csv']}")
        a, lo, hi = (float(r[k]) for k in ("auroc", "auroc_lo", "auroc_hi"))
        cells.append(f"{a:.2f} ({lo:.2f}--{hi:.2f})")
        out.append([f"AUROC: {label}", f"{a:.2f} (95% CI, {lo:.2f} to {hi:.2f})"])
    if paper_row is not None and " & ".join(cells) not in paper_row:
        raise SystemExit(f"build_models_guide: {card['validation_csv']} rounds to {cells}, which is not Paper 3's "
                         f"row \"{paper_row}\"")
    return out


# ---------------------------------------------------------------- document model
# A document is a list of blocks rendered to both Markdown and HTML. Inline text may use
# `code`, **bold**, and [label](url).

class Codes:
    """A code list in a table cell; long lists are shortened in Markdown and folded in HTML."""

    def __init__(self, system, codes, limit=12, note=None):
        self.system, self.codes, self.limit, self.note = system, list(codes), limit, note

    def md(self):
        shown = ", ".join(self.codes[:self.limit])
        more = len(self.codes) - self.limit
        text = f"{self.system}: {shown}" if self.codes else f"{self.system}"
        if more > 0:
            text += f" and {more} more (full list in the model file)"
        if self.note:
            text += f" ({self.note})"
        return text

    def html(self):
        head = ", ".join(html.escape(c) for c in self.codes[:self.limit])
        out = f"<span class=\"code-system\">{html.escape(self.system)}</span>"
        if self.codes:
            out += f": <span class=\"codes\">{head}</span>"
        rest = self.codes[self.limit:]
        if rest:
            out += (f"<details class=\"more-codes\"><summary>{len(rest)} more</summary>"
                    f"<span class=\"codes\">{', '.join(html.escape(c) for c in rest)}</span></details>")
        if self.note:
            out += f" <span class=\"muted\">({html.escape(self.note)})</span>"
        return out


class Doc:
    def __init__(self):
        self.blocks = []

    def h(self, level, text, anchor=None):
        self.blocks.append(("h", level, text, anchor))

    def p(self, text):
        self.blocks.append(("p", text))

    def ul(self, items):
        self.blocks.append(("ul", list(items)))

    def ol(self, items):
        self.blocks.append(("ol", list(items)))

    def table(self, headers, rows, cls=None):
        self.blocks.append(("table", headers, rows, cls))

    def note(self, text, kind="note"):
        self.blocks.append(("note", text, kind))

    def checklist(self, items):
        self.blocks.append(("check", list(items)))

    def toc(self, entries):
        self.blocks.append(("toc", entries))

    def html_only(self, raw):
        self.blocks.append(("raw", raw))


def inline_html(text):
    out, pos = [], 0
    for m in re.finditer(r"`([^`]+)`|\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^)\s]+)\)", text):
        out.append(html.escape(text[pos:m.start()], quote=False))
        if m.group(1) is not None:
            out.append(f"<code>{html.escape(m.group(1), quote=False)}</code>")
        elif m.group(2) is not None:
            out.append(f"<strong>{inline_html(m.group(2))}</strong>")
        else:
            out.append(f"<a href=\"{html.escape(m.group(4))}\">{inline_html(m.group(3))}</a>")
        pos = m.end()
    out.append(html.escape(text[pos:], quote=False))
    return "".join(out)


def cell_md(c):
    if isinstance(c, Codes):
        c = c.md()
    elif isinstance(c, list):
        c = "; ".join(x.md() if isinstance(x, Codes) else str(x) for x in c)
        c = c.replace("clusters coded; ", "clusters coded: ", 1)
    return str(c).replace("|", "\\|").replace("\n", " ")


def cell_html(c):
    if isinstance(c, Codes):
        return c.html()
    if isinstance(c, list):
        return "<br>".join(x.html() if isinstance(x, Codes) else inline_html(str(x)) for x in c)
    return inline_html(str(c))


def render_md(doc):
    out = []
    for b in doc.blocks:
        k = b[0]
        if k == "h":
            out.append("#" * b[1] + " " + b[2])
        elif k == "p":
            out.append(b[1])
        elif k in ("ul", "check"):
            out.append("\n".join(("- [ ] " if k == "check" else "- ") + i for i in b[1]))
        elif k == "ol":
            out.append("\n".join(f"{n}. {i}" for n, i in enumerate(b[1], 1)))
        elif k == "table":
            _, headers, rows, _ = b
            lines = ["| " + " | ".join(headers) + " |", "|" + "|".join("---" for _ in headers) + "|"]
            lines += ["| " + " | ".join(cell_md(c) for c in r) + " |" for r in rows]
            out.append("\n".join(lines))
        elif k == "note":
            label = "To verify" if b[2] == "verify" else "Note"
            out.append(f"> **{label}.** {b[1]}")
        elif k == "toc":
            out.append("\n".join(f"- [{t}](#{a})" for t, a in b[1]))
        # "raw" blocks are HTML only
    # Site-relative links (/about/..., /developers/...) point at the website from the Markdown copy.
    return re.sub(r"\]\((/[^)\s]*)\)", lambda m: f"]({SITE}{m.group(1)})", "\n\n".join(out)) + "\n"


def render_html(doc):
    out = []
    for b in doc.blocks:
        k = b[0]
        if k == "h":
            anchor = f" id=\"{b[3]}\"" if b[3] else ""
            out.append(f"<h{b[1]}{anchor}>{inline_html(b[2])}</h{b[1]}>")
        elif k == "p":
            out.append(f"<p>{inline_html(b[1])}</p>")
        elif k in ("ul", "ol"):
            items = "".join(f"<li>{inline_html(i)}</li>" for i in b[1])
            out.append(f"<{k}>{items}</{k}>")
        elif k == "check":
            items = "".join(f"<li><span class=\"box\" aria-hidden=\"true\"></span>{inline_html(i)}</li>" for i in b[1])
            out.append(f"<ul class=\"checklist\">{items}</ul>")
        elif k == "table":
            _, headers, rows, cls = b
            head = "".join(f"<th scope=\"col\">{inline_html(h)}</th>" for h in headers)
            body = "".join("<tr>" + "".join(f"<td>{cell_html(c)}</td>" for c in r) + "</tr>" for r in rows)
            c = f" class=\"{cls}\"" if cls else ""
            out.append(f"<div class=\"table-wrap\"><table{c}><thead><tr>{head}</tr></thead><tbody>{body}</tbody></table></div>")
        elif k == "note":
            label = "To verify" if b[2] == "verify" else "Note"
            out.append(f"<aside class=\"callout callout-{b[2]}\"><strong>{label}.</strong> {inline_html(b[1])}</aside>")
        elif k == "toc":
            items = "".join(f"<li><a href=\"#{a}\">{inline_html(t)}</a></li>" for t, a in b[1])
            out.append(f"<nav class=\"toc\" aria-label=\"On this page\"><p class=\"toc-title\">On this page</p>"
                       f"<ol>{items}</ol></nav>")
        elif k == "raw":
            out.append(b[1])
    return "\n".join(out)


# ---------------------------------------------------------------- formatting helpers

def icd_display(code):
    c = code.replace(".", "").upper()
    return c[:3] + "." + c[3:] if len(c) > 3 else c


def fmt_num(x, digits=6):
    s = f"{x:.{digits}f}".rstrip("0").rstrip(".")
    return "0" if s in ("-0", "") else s


def fmt_day(iso):
    """"2021-07-02" -> "July 2, 2021"."""
    return dt.date.fromisoformat(iso).strftime("%B %-d, %Y")


def pct(p):
    return f"{100 * p:.2f}%" if p < 0.1 else f"{100 * p:.1f}%"


def merge_ranges(ranges):
    ranges = sorted(ranges)
    out = []
    for lo, hi in ranges:
        if out and lo <= out[-1][1] + 1:
            out[-1][1] = max(out[-1][1], hi)
        else:
            out.append([lo, hi])
    return out


def days(ranges):
    return " and ".join(f"{lo} to {hi}" for lo, hi in merge_ranges(ranges))


def window_names(names, W):
    return f"days {days([W[n] for n in names])} ({', '.join(names)})"


def window_text(f, W):
    k = f["kind"]
    if k in ("age_band", "sex"):
        return "on day 0"
    if k == "derived_count_ge":
        return "as its group"
    if k == "encounter_rate_ratio_ge":
        return (f"visits per day in {window_names([f['numerator']], W)} against "
                f"{window_names([f['denominator']], W)}")
    if "window" in f:
        return f"days {days([f['window']])}"
    names = f.get("present_in") or f.get("windows") or []
    text = window_names(names, W)
    if f.get("absent_in"):
        text += f"; none in {window_names(f['absent_in'], W)}"
    return text


def codes_cell(f):
    k, c = f["kind"], f.get("codes", {})
    if k == "age_band":
        hi = "and older" if f["max"] >= 120 else f"to {f['max']}"
        return f"Patient.birthDate: age {f['min']} {hi} on day 0"
    if k == "sex":
        return f"Patient.gender = {f['value']}"
    if k in ("encounter_any", "encounter_count_ge", "encounter_rate_ratio_ge"):
        cls = ", ".join(f["encounter_class"])
        rule = {"encounter_any": "at least one Encounter",
                "encounter_count_ge": f"at least {f.get('threshold')} Encounter{'s' if f.get('threshold', 0) > 1 else ''}",
                "encounter_rate_ratio_ge": f"rate ratio at least {f.get('threshold')}"}[k]
        return f"Encounter.class {cls} ({rule})"
    if k == "derived_count_ge":
        return f"at least {f['threshold']} features of group \"{f['of_group']}\" present"
    if k == "cluster_count_ge":
        parts = [f"at least {f['threshold']} of these symptom clusters coded"]
        parts += [Codes(name.replace("_", " "), [icd_display(x) for x in pre], limit=20)
                  for name, pre in f["clusters"].items()]
        return parts
    cells = []
    if c.get("icd10cm_prefix"):
        cells.append(Codes("ICD-10-CM prefix", [icd_display(x) for x in c["icd10cm_prefix"]], limit=20))
    if c.get("cpt"):
        cells.append(Codes("CPT", c["cpt"], limit=20))
    if c.get("icd10pcs"):
        cells.append(Codes("ICD-10-PCS", c["icd10pcs"]))
    if c.get("loinc"):
        cells.append(Codes("LOINC", c["loinc"], limit=10))
    if c.get("rxnorm_ingredient_names") or c.get("rxcui"):
        names = c.get("rxnorm_ingredient_names", [])
        n = len(c.get("rxcui", []))
        cells.append(Codes("RxNorm ingredients", names, limit=20,
                           note=f"{n} RxCUIs listed in the model file" if n else None))
    return cells or "none"


def feature_rows(model):
    W = model.get("windows", {})
    rows = []
    for f in model["features"]:
        source = f.get("resource") or {"age_band": "Patient", "sex": "Patient", "derived_count_ge": "derived",
                                       "cluster_count_ge": "Condition"}.get(f["kind"], "Encounter")
        rows.append([f"`{f['id']}`", f.get("label", f["id"]), f.get("group", ""), f"{source} ({f['kind']})",
                     codes_cell(f), window_text(f, W), fmt_num(f["weight"])])
    return rows


# ---------------------------------------------------------------- source parsing

def section(text, heading_prefix):
    m = need(re.search(rf"^(#+) {re.escape(heading_prefix)}.*$", text, re.M), f"heading '{heading_prefix}'")
    level = len(m.group(1))
    rest = text[m.end():]
    end = re.search(rf"^#{{1,{level}}} ", rest, re.M)
    return rest[:end.start()] if end else rest


def parse_questionnaire():
    q = read("submission/app_questionnaire.md")
    instruments = {}
    for part, name, what, scoring, source in re.findall(
            r"^\| ([A-D]) \| (.+?) \| (.+?) \| (.+?) \| (.+?) \|$", q, re.M):
        instruments[part] = {"name": name, "what": what, "scoring": scoring, "source": source}
    need(len(instruments) == 4, "the four instrument rows (A-D)")

    d_block = need(re.search(r"Part D items[^\n]*\n((?:\d+\. .+\n)+)", q), "Part D items")
    d_intro = need(re.search(r"Part D items \((.+?)\):", q), "Part D answer scale").group(1)
    change_items = re.findall(r"^\d+\. (.+)$", d_block.group(1), re.M)

    pem = section(q, "Part B.")
    pem_items = re.findall(r"^\d+\. (.+)$", pem, re.M)
    need(len(pem_items) == 5, "five DSQ-PEM items")
    pcfs = section(q, "Part C.")
    grades = re.findall(r"^\| (I .+?) \| (\d) \|$", pcfs, re.M)
    need(len(grades) == 5, "five PCFS grades")

    # RECOVER symptoms and points: the Part A table (short name, questionnaire wording, points), from the Table of
    # Geng et al.
    recover = [(name.lower(), points) for name, points in
               re.findall(r"^\| ([A-Z][^|]*?) \| [^|]+? \| (\d+) \|", section(q, "Part A."), re.M)]
    need(len(recover) == 11, "eleven RECOVER items in Part A")

    combine = section(q, "How the two steps combine")
    triage = need(re.search(r"^- Triage rule for the demo: (.+)$", combine, re.M), "triage rule").group(1)

    return {
        "instruments": instruments,
        "recover": recover, "recover_source": RECOVER_SOURCE,
        "pem_items": pem_items,
        "pem_instruction": need(re.search(r'Instruction: "(.+?)"', pem), "PEM instruction").group(1),
        "pem_frequency": need(re.search(r"^- Frequency: (.+)$", pem, re.M), "PEM frequency scale").group(1),
        "pem_severity": need(re.search(r"^- Severity: (.+)$", pem, re.M), "PEM severity scale").group(1),
        "pem_rule": need(re.search(r"Implement as: (.+?)\(the paper", pem), "PEM scoring rule").group(1).strip(),
        "pem_attribution": need(re.search(r'Attribution line: "(.+?)"', pem), "PEM attribution").group(1),
        "pem_context": need(re.search(r'Optional context item for the clinician \(not part of the screen rule\): (.+)$',
                                      pem, re.M), "PEM context item").group(1),
        "pcfs_question": need(re.search(r'Question: "(.+?)"', pcfs), "PCFS question").group(1),
        "pcfs_grades": grades,
        "pcfs_rules": need(re.search(r"^Rules from the form: (.+)$", pcfs, re.M), "PCFS rules").group(1),
        "pcfs_attribution": need(re.search(r'Attribution line: "(.+?)"', pcfs), "PCFS attribution").group(1),
        "change_intro": d_intro, "change_items": change_items,
        "triage": triage,
    }


def parse_scenarios():
    """Each patient's comment in make_bundles.py and the card it was built for."""
    src = read("model/test_vectors/make_bundles.py")
    cf_start = need(re.search(r"# Chronic fatigue \(ME/CFS\) card patients", src), "chronic fatigue marker").start()
    fm_start = need(re.search(r"# Fibromyalgia card patients", src), "fibromyalgia marker").start()
    lc_start = need(re.search(r"# Eligibility boundary patients for the Long COVID card", src), "Long COVID boundary marker").start()
    all_start = need(re.search(r"# Eligibility boundary patients for every model", src), "every-model boundary marker").start()

    def target(pos, comment):
        return ("all" if pos > all_start else "unm-longcovid" if pos > lc_start else "unm-fibromyalgia" if pos > fm_start
                else "unm-chronicfatigue" if pos > cf_start else "lyme" if "Lyme" in comment else "unm-longcovid")

    out = {}
    for m in re.finditer(r'= (?:post_covid\()?Chart\("(\w+)"[^\n]*?#\s*(.+)$', src, re.M):
        out[m.group(1)] = (m.group(2).strip(), target(m.start(), m.group(2)))
    # a patient whose comment sits on the line above its Chart(...) line
    for m in re.finditer(r'^\s*#\s*(.+)\n\s*(\w+) = Chart\("(\w+)"', src, re.M):
        if m.group(3) not in out:
            out[m.group(3)] = (m.group(1).strip(), target(m.start(), m.group(1)))
    return out


def scenario_for(scenarios, pid, model_id):
    comment, target = scenarios.get(pid, ("", None))
    if target in (model_id, "all"):
        return comment
    return f"built for the {CARDS[target]['title'] if target in CARDS else 'Lyme'} card"


def load_vectors(model, bundles):
    """Expected outputs for this model version, rechecked against the reference scorer."""
    edir = REPO / "model" / "test_vectors" / "expected" / f"{model['model_id']}-{model['version']}"
    if not edir.is_dir():
        return edir, {}
    out = {}
    for pid in PATIENTS:
        path = edir / f"{pid}.json"
        if not path.exists():
            continue
        exp = json.loads(path.read_text())
        got = score_bundle(model, bundles[pid], dt.date.fromisoformat(exp["as_of"]))
        same = got["status"] == exp["status"] and got.get("band") == exp.get("band") and got.get("reason") == exp.get("reason")
        if same and "probability" in exp:
            same = abs(got["probability"] - exp["probability"]) < 1e-9
        if not same:
            raise SystemExit(f"build_models_guide: {path.relative_to(REPO)} no longer matches the reference scorer; "
                             f"rerun model/test_vectors/make_bundles.py {model['model_id']}")
        out[pid] = exp
    return edir, out


# ---------------------------------------------------------------- sections

def model_card(doc, model, card, vectors, edir, q, scenarios):
    t, W = model["target"], model.get("windows", {})
    anchor = card["anchor"]
    doc.h(2, f"{card['title']} (`{model['model_id']}` {model['version']})", anchor)
    doc.p(f"Model file `model/{card['download']}`, status \"{model['status']}\". {model['statement']}")
    doc.html_only(f"<p class=\"actions\"><a class=\"button\" href=\"/models/{card['download']}\" download>"
                  f"Download {html.escape(card['download'])}</a></p>")

    doc.h(3, "What it predicts and for whom", f"{anchor}-target")
    items = [f"**Predicts:** {t['label']}. {t['definition']}.", f"**Population:** {t['population']}."]
    if "landmark_days" in t:
        items.append(f"**Timing:** scored from day {t['landmark_days']} to day {t['horizon_days'][1]} after the index "
                     f"event; the outcome window is days {t['horizon_days'][0]} to {t['horizon_days'][1]}. Predictors are "
                     f"read through day {t['landmark_days']}, so a chart scored later gets the day-{t['landmark_days']} "
                     "estimate.")
    ie = model.get("index_event", {})
    if ie.get("type") == "scoring_date":
        items.append(f"**Day 0:** the scoring date ({ie['rule']}).")
    else:
        codes = ", ".join(ie.get("condition_codes", {}).get("icd10cm", []))
        tests = ("positive SARS-CoV-2 tests also count" if ie.get("use_positive_tests") else
                 f"positive SARS-CoV-2 tests (LOINC {', '.join(ie.get('positive_test_loinc', []))}) are listed but "
                 "not used, because `use_positive_tests` is false")
        era = (f" dated on or after {fmt_day(ie['earliest_date'])} (`index_event.earliest_date`, the training cohort's "
               "shifted-date era start) and on or before the scoring date" if ie.get("earliest_date") else "")
        items.append(f"**Day 0:** the earliest Condition coded ICD-10-CM {codes}{era}; {tests}.")
    doc.ul(items)
    w = card.get("cds")
    if w:
        doc.p(f"Card wording, from the CDS Hooks service (`web/functions/cds-services/_cds.js`): \"{w['pattern']}\" "
              f"The number is shown as \"N times {w['average']}\" and as the \"{w['probability']}\". "
              + " ".join(card["wording_extra"]))

    doc.h(3, "When it does not score", f"{anchor}-exclusions")
    ex = model["exclusion"]["condition_codes"]
    systems = {"icd10cm": "ICD-10-CM", "snomed": "SNOMED CT"}
    ex_codes = " or ".join(f"{systems.get(s, s)} " + " or ".join(icd_display(c) if s == "icd10cm" else c for c in v)
                           for s, v in ex.items())
    rules = []
    age_rules = ["No usable birth date: \"birth date missing or unusable (age is required)\".",
                 "Under 18 on day 0 (age is days / 365.25, as in training): \"" +
                 ("under 18 on the scoring date" if ie.get("type") == "scoring_date" else "under 18 at the COVID-19 index")
                 + " (the model covers adults)\"."]
    if ie.get("type") == "scoring_date":
        rules += age_rules
        rules.append(f"A Condition coded {ex_codes} is dated on or before day 0, or has no usable date: "
                     f"\"{model['exclusion']['reason']}\".")
    else:
        rules.append("No index event: \"no documented COVID-19 index event\"" + (
            f" (\"... on or after {ie['earliest_date']}\" when the chart has only earlier COVID-19 diagnoses)"
            if ie.get("earliest_date") else "") + ".")
        rules += age_rules
        rules.append(f"Fewer than {t['landmark_days']} days between day 0 and the scoring date.")
        rules.append(f"More than {t['horizon_days'][1]} days between day 0 and the scoring date: \"outside the model's "
                     "time window\".")
        rules.append(f"A Condition coded {ex_codes} is dated on or before the scoring date (before, on, or after the "
                     "index date), or has no usable date: \"a Long COVID diagnosis is already recorded\".")
    hist = model.get("history_requirement")
    if hist:
        classes = ", ".join(hist["encounter_class"][:-1]) + ", or " + hist["encounter_class"][-1]
        count = "No" if hist["min_count"] == 1 else f"Fewer than {hist['min_count']}"
        rules.append(f"{count} {classes} encounter in {window_names([hist['window']], W)}: \"{hist['reason']}\".")
    else:
        rules.append(f"No encounters in {window_names(['W0', 'W1'], W)}: "
                     "\"no encounters in the year before COVID-19 (insufficient history)\".")
    doc.ol(rules)
    doc.p("ICD-10-CM codes match by prefix with dots removed, so a listed code also matches its subcodes. "
          "In each case the app says why it did not score. Every rule reads only records dated on or before the "
          "scoring date; Conditions whose verificationStatus is refuted or entered-in-error, and records whose "
          "status is entered-in-error, are ignored. If a FHIR search the model needs failed or was forbidden, the "
          "result is \"could not score: <resource> unavailable\" instead of a score ([interface spec, section 4c]"
          "(/developers/spec#spec-4c-unavailable-data)).")

    doc.h(3, "Windows", f"{anchor}-windows")
    doc.table(["Window", "Days relative to day 0"], [[f"`{k}`", f"{v[0]} to {v[1]}"] for k, v in W.items()])

    n_w = sum(1 for f in model["features"] if f["weight"] != 0)
    doc.h(3, f"Features ({len(model['features'])}, of which {n_w} carry a weight)", f"{anchor}-features")
    text = "Each feature is 0 or 1. "
    if n_w < len(model["features"]):
        text += ("Features with weight 0 are still evaluated, because a derived count feature counts every feature "
                 "in its group, but they never appear as drivers. ")
    text += ("Features that differ only in threshold (for example 2+ and 3+ of the same thing) show as one driver "
             "carrying the summed weight. ICD-10-CM codes are shown with dots for reading; the model file stores "
             "feature codes without dots.")
    doc.p(text)
    doc.table(["Feature", "Label", "Group", "Source (kind)", "Codes", "Window", "Weight"], feature_rows(model),
              cls="features")

    doc.h(3, "Score, calibration, and risk bands", f"{anchor}-score")
    base = model["reference"]["cohort_base_rate"]
    doc.p(f"score = {fmt_num(model['intercept'])} + Σ weight × value. The probability is the "
          f"{model['calibration']['method'].replace('_', '-')} interpolation of the score over the calibration "
          "points below, clamped at the ends. The band is the first band whose upper limit is at or above the "
          "probability. \"Times the average\" is the probability divided by the cohort base rate in the model file, "
          f"`reference.cohort_base_rate` = {fmt_num(base)} (about {100 * base:.1f}%).")
    fit = model["calibration"].get("fit")
    if fit:
        doc.p(f"Calibration points come from a {fit['type']} (a = {fmt_num(fit['a'])}, b = {fmt_num(fit['b'])}).")
    doc.table(["Band", "Probability up to", "Times the average"],
              [[b["name"], pct(b["max_probability"]) if b["max_probability"] < 1 else "100%",
                f"{b['max_probability'] / base:.2f}" if b["max_probability"] < 1 else
                f"above {model['risk_bands'][-2]['max_probability'] / base:.2f}"]
               for b in model["risk_bands"]])
    pts = model["calibration"]["points"]
    doc.table(["Score", "Probability"], [[fmt_num(s, 4), pct(p)] for s, p in pts], cls="compact")

    doc.h(3, "Validation and provenance", f"{anchor}-validation")
    prov = model.get("provenance", {})
    lines = [f"**Data:** {prov.get('data', 'not stated')}.",
             f"**Method:** {plain_method(prov.get('method', 'not stated'))}."]
    if card.get("label_note"):
        lines.append(f"**Label:** {card['label_note']} ({paper_link(card['paper'])}).")
    paper = f" Details are in {paper_link(card['paper'])}." if card.get("paper") else ""
    # The model file's "task" and "features_note" name internal task numbers and result files; CARDS holds the
    # plain-words version of the features note.
    if card.get("features_note"):
        lines.append(f"**Features note:** {card['features_note']}.")
    if card.get("paper"):
        lines.append(f"**Paper:** {paper_link(card['paper'])} on the [Research page](/about/) describes how the "
                     "model was built and validated.")
    for key in ("tau2", "features_eligible"):
        if key in prov:
            lines.append(f"**{ {'tau2': 'Shrinkage variance (tau²)', 'features_eligible': 'Features eligible'}[key]}:** "
                         f"{fmt_num(prov[key]) if isinstance(prov[key], float) else prov[key]}.")
    if prov.get("open_data"):
        lines.append("**Open data:** " + "; ".join(prov["open_data"]) + ".")
    doc.ul(lines)
    ev = prov.get("validation_split_evaluation")
    if ev:
        names = {"auroc": "AUROC", "auprc": "AUPRC", "held_out_people": "Validation patients",
                 "held_out_positives": "Validation patients later coded"}
        rows = [[names[k], f"{int(ev[k]):,}" if str(ev[k]).isdigit() else str(ev[k])] for k in names if k in ev]
        for k, v in ev.get("participant_level_comparators", {}).items():
            rows.append([f"Comparator AUROC: {COMPARATORS.get(k, k.replace('_', ' '))}", str(v)])
        doc.table(["Validation split", "Value"], rows)
        site = re.search(r"held-out-site AUROC of the frozen pipeline: ([\d.]+) \(95% CI ([\d.]+)-([\d.]+)\)",
                         ev.get("note", ""))
        text = "Values from the model file, measured in a random 20% validation split of the training cohort."
        if site:
            a, lo, hi = (float(x) for x in site.groups())
            text += (" With the 18 held-out sites excluded from fitting, a separately fitted summary-count score had an "
                     f"AUROC of {a:.2f} (95% CI, {lo:.2f} to {hi:.2f}) at those sites.")
        doc.p(f"{text}{paper}")
    elif card.get("validation_csv"):
        doc.table(["Validation split", "Value"], validation_rows(card))
        doc.p("Measured inside the All of Us Researcher Workbench in a random 20% validation split of the training "
              "cohort, for the summary-count score built from the same released counts as this file. 95% confidence "
              "intervals are from 200 bootstrap resamples of the validation split. Validation was on one cohort; "
              f"the model has not been validated at other health systems.{paper}")
    else:
        doc.note("The model file records no validation metrics (its provenance has no evaluation block). "
                 "Add them to the model file before quoting any.")

    doc.h(3, "Intended use and limitations", f"{anchor}-use")
    lim = ["Decision support for clinician review of a single chart. It is not a diagnosis and does not rule a condition in or out.",
           "Validated retrospectively on one research program's records; it has not been evaluated prospectively or at a health system.",
           "The model is linear and every point of the score traces to a named, dated chart finding; findings outside the listed codes are invisible to it."]
    if card.get("label_limit"):
        lim.append(card["label_limit"])
    doc.ul(lim)

    if card.get("checklist") or card.get("questionnaire"):
        doc.h(3, "Follow-up questions for the patient", f"{anchor}-questions")
    if card.get("checklist"):
        if card.get("pem"):
            pem_block(doc, q, level=4, prefix="")
        title, intro, items = CHECKLISTS[card["checklist"]]
        doc.h(4, f"Clinician checklist: {title}")
        doc.p(intro)
        doc.checklist(items)
        doc.p("The checklist is shown to the clinician and is not scored by the app.")
    elif card.get("questionnaire"):
        inst = q["instruments"]
        doc.p("About 5 minutes. Everything scored uses a validated instrument; the app's item wording is in "
              "`web/web/patient/instruments.js`.")
        doc.table(["Part", "Instrument", "What it measures", "Scoring", "Source"],
                  [[p, i["name"], i["what"], public_scoring(i["scoring"]), i["source"]] for p, i in inst.items()])
        doc.h(4, "A. RECOVER 2024 symptom list")
        doc.p(f"Yes or no for each symptom; points add up. 11 or more = \"likely\", 1 to 10 = \"possible\" "
              f"({q['recover_source']}). Each question asks whether the symptom is present now, in the RECOVER "
              "questionnaire wording (Thaweethai et al., JAMA 2023, Supplement 3, eTable 1; the wording per item is in "
              "`web/web/patient/instruments.js`). In the published index, fatigue, brain fog, and chest pain also "
              "need a severity score (PROMIS Global-10 fatigue item, Neuro-QoL Cognition short form, Seattle Angina "
              "Questionnaire-7); the app counts a Yes and says so on the result, so its total can exceed the "
              "research index by up to 5 points.")
        doc.table(["Symptom", "Points"], [[s, n] for s, n in q["recover"]], cls="compact")
        pem_block(doc, q, level=4, prefix="B. ")
        doc.h(4, "C. Post-COVID-19 Functional Status (PCFS) scale")
        doc.p(f"\"{q['pcfs_question']}\"")
        doc.table(["Statement", "Grade"], [[s, g] for s, g in q["pcfs_grades"]])
        doc.p(f"Rules from the form: {q['pcfs_rules']}")
        doc.p(f"Attribution: \"{q['pcfs_attribution']}\"")
        doc.h(4, "D. Change since before COVID (unscored context)")
        doc.p(f"Each item is answered {re.sub(r'^each ', '', q['change_intro'])}.")
        doc.ol(q["change_items"])

    if card.get("next_steps"):
        doc.h(3, "Next steps shown to clinicians", f"{anchor}-next")
        doc.ol(card["next_steps"])
        doc.p(f"Sources: {card['next_steps_source']}.")

    doc.h(3, "Test patients and expected results", f"{anchor}-tests")
    if not vectors:
        doc.note(f"No expected outputs exist for {model['model_id']} {model['version']} "
                 f"(`{edir.relative_to(REPO)}`).")
        return
    any_exp = next(iter(vectors.values()))
    doc.p(f"Synthetic FHIR R4 bundles in `model/test_vectors/bundles/`, scored as of {any_exp['as_of']}. Expected "
          f"outputs are in `{edir.relative_to(REPO)}/`; this generator reran the reference scorer on every bundle "
          "and they match. The JavaScript scorer must reproduce them to 1e-9.")
    rows = []
    for pid, e in vectors.items():
        if e["status"] == "scored":
            result = f"{e['band']}, {pct(e['probability'])} ({e['times_average']:.2f} times the average)"
            drivers = "; ".join(d["label"] for d in e["drivers"][:3]) or "none"
        else:
            result, drivers = f"not scored: {e['reason']}", ""
        rows.append([pid.capitalize(), scenario_for(scenarios, pid, model["model_id"]), result, drivers])
    doc.table(["Patient", "Scenario", "Expected result", "Top drivers"], rows)


def pem_block(doc, q, level, prefix):
    doc.h(level, f"{prefix}DePaul Symptom Questionnaire, post-exertional malaise (DSQ-PEM)")
    doc.p(f"\"{q['pem_instruction']}\"")
    doc.ul([f"Frequency: {q['pem_frequency']}", f"Severity: {q['pem_severity']}"])
    doc.ol(q["pem_items"])
    doc.p(f"Screen rule: {q['pem_rule'].rstrip('.')}.")
    doc.p(f"Optional context item for the clinician, not part of the rule: {q['pem_context']}")
    doc.p(f"Attribution: \"{q['pem_attribution']}\" Do not reword, reorder, or rescale the items.")


def lyme_section(doc, bundles):
    rows = list(csv.DictReader(open(REPO / "opendata/processed/lyme_county_incidence.csv", encoding="utf-8")))
    header = list(rows[0].keys())
    bands = Counter(r["band"] for r in rows)
    sources = Counter(r["county_estimate_source"] for r in rows)
    script = read("opendata/scripts/lyme_county_incidence.py")
    hi, mid = need(re.search(r'"high" if x >= ([\d.]+) else \("moderate" if x >= ([\d.]+)', script),
                   "Lyme band thresholds in opendata/scripts/lyme_county_incidence.py").groups()

    doc.h(2, "Lyme disease (county prior)", "lyme")
    doc.p("The Lyme card has no model file yet. Today it lists the coded findings consistent with Lyme disease "
          "(`web/web/athena/lyme-rule.js`, with their dates and no score) next to the reported incidence for the "
          "patient's county, and the CDC testing guidance. The county comes from `Patient.address[0].state` and "
          "`.district` (the county name); with no county on file the state average is shown and labeled.")
    doc.h(3, "County prior table", "lyme-table")
    doc.p(f"`opendata/processed/lyme_county_incidence.csv`, built by `opendata/scripts/lyme_county_incidence.py` "
          f"from CDC Lyme disease surveillance counts by county and Census population estimates. It has "
          f"{len(rows):,} counties (5-digit FIPS) and the columns " + ", ".join(f"`{h}`" for h in header) + ".")
    doc.ul([
        "Incidence is average annual reported cases per 100,000 residents over 2015 to 2019.",
        f"Bands: high at {hi} or more per 100,000, moderate from {mid} to under {hi}, low under {mid}. "
        + ", ".join(f"{bands[b]:,} {b}" for b in ("high", "moderate", "low")) + " counties.",
        f"Where CDC suppresses a county's count, the state's suppressed cases are spread per capita "
        f"({sources.get('state suppressed cases spread per capita', 0):,} counties); "
        f"{sources.get('CDC county row', 0):,} counties have their own CDC row. A state band is the fallback.",
        "Reported surveillance counts undercount diagnoses, so the bands describe relative risk, not an absolute probability.",
    ])
    doc.h(3, "Testing guidance", "lyme-guidance")
    doc.ul(["CDC: \"Patients with likely EM and possible tick exposure in a Lyme disease endemic area should be "
            "treated promptly, regardless of whether acute serologic testing is ordered.\" Serologic tests may be "
            "falsely negative during the first few weeks of infection, when erythema migrans is common.",
            "CDC recommends a two-step serologic testing process: standard two-tier testing (an enzyme immunoassay, "
            "then a western blot) or modified two-tier testing (two enzyme immunoassays).",
            "Sources: CDC, Clinical Testing and Diagnosis for Lyme Disease "
            "(https://www.cdc.gov/lyme/hcp/diagnosis-testing/index.html, reviewed May 15, 2024), and Clinical "
            "Treatment of Erythema Migrans Rash (https://www.cdc.gov/lyme/hcp/clinical-care/erythema-migrans-rash.html), "
            "checked October 4, 2026. The card shows no test price."])
    doc.h(3, "Test patient", "lyme-tests")
    dana = next(r["resource"] for r in bundles["dana"]["entry"] if r["resource"]["resourceType"] == "Patient")
    addr = dana["address"][0]
    row = next((r for r in rows if r["state"] == addr["state"] and r["county_name"] == addr.get("district")), None)
    if row:
        doc.p(f"Dana (`model/test_vectors/bundles/dana.json`) lives in {row['county_name']}, {row['state']} "
              f"(FIPS {row['fips']}): {row['incidence_per_100k']} reported cases per 100,000 a year, band "
              f"\"{row['band']}\" ({row['county_estimate_source']}). Her chart has knee pain and Bell's palsy "
              "codes and no COVID-19 code, so the Long COVID card does not score.")


def lupus_section(doc):
    doc.h(2, "Lupus (classification-criteria review)", "lupus")
    doc.p("The lupus card has no model file yet. Today it runs a rule: `web/web/athena/rule.js` "
          "(`evaluateLupusSignal`) maps chart evidence to the domains and weights of the 2019 EULAR/ACR classification criteria for systemic "
          "lupus erythematosus: a positive antinuclear antibody at a titer of 1:80 or more is the entry criterion, "
          "and within each clinical and immunologic domain only the highest-weighted criterion counts. It separates confirmed "
          "evidence from possible, note-derived evidence and returns a review signal from 1 (no chart-supported "
          "pattern) to 5 (classification-pattern threshold met, 10 or more confirmed points with a clinical "
          "criterion). Criterion names in Condition and note text match on word boundaries, and where two "
          "criteria match overlapping text only the longest counts (\"subacute cutaneous lupus\" is never also "
          "\"acute cutaneous lupus\"); a negated mention (\"no oral ulcers\", \"denies seizure\", \"pericarditis ruled "
          "out\") does not count; white-cell and platelet counts are compared in 10^9/L, so 3,000/µL and 3 × 10^9/L "
          "give the same result. This is a rule-based approximation of the classification criteria, and the 1 to 5 "
          "signal is this app's own rating. These are research classification criteria, not diagnostic criteria, "
          f"and every flag needs clinical attribution. Reference: {EULAR_ACR}.")


# ---------------------------------------------------------------- spec renderer (model_spec.md -> HTML)

def markdown_to_html(md):
    lines, out, i = md.splitlines(), [], 0

    def para_end(j):
        return j >= len(lines) or not lines[j].strip() or re.match(r"(#{1,6} |```|\| |\d+\. |- )", lines[j])

    while i < len(lines):
        line = lines[i]
        if not line.strip():
            i += 1
        elif line.startswith("```"):
            j = i + 1
            while j < len(lines) and not lines[j].startswith("```"):
                j += 1
            out.append("<pre><code>" + html.escape("\n".join(lines[i + 1:j]), quote=False) + "</code></pre>")
            i = j + 1
        elif m := re.match(r"(#{1,6}) (.+)", line):
            level = len(m.group(1))
            slug = re.sub(r"[^a-z0-9]+", "-", m.group(2).lower()).strip("-")
            out.append(f"<h{level} id=\"spec-{slug}\">{inline_html(m.group(2))}</h{level}>")
            i += 1
        elif line.startswith("| "):
            rows = []
            while i < len(lines) and lines[i].startswith("|"):
                rows.append([c.strip() for c in re.split(r"(?<!\\)\|", lines[i].strip())[1:-1]])
                i += 1
            head, body = rows[0], [r for r in rows[1:] if not all(re.fullmatch(r":?-+:?", c) for c in r)]
            out.append("<div class=\"table-wrap\"><table><thead><tr>"
                       + "".join(f"<th scope=\"col\">{inline_html(c)}</th>" for c in head) + "</tr></thead><tbody>"
                       + "".join("<tr>" + "".join(f"<td>{inline_html(c)}</td>" for c in r) + "</tr>" for r in body)
                       + "</tbody></table></div>")
        elif re.match(r"(\d+\.|-) ", line):
            tag = "ol" if line[0].isdigit() else "ul"
            items = []
            while i < len(lines) and re.match(r"(\d+\.|-) ", lines[i]):
                items.append(re.sub(r"^(\d+\.|-) ", "", lines[i]))
                i += 1
                while i < len(lines) and lines[i].startswith("   ") and lines[i].strip():
                    items[-1] += " " + lines[i].strip()
                    i += 1
            out.append(f"<{tag}>" + "".join(f"<li>{inline_html(x)}</li>" for x in items) + f"</{tag}>")
        else:
            j = i + 1
            while not para_end(j):
                j += 1
            out.append("<p>" + inline_html(" ".join(lines[i:j])) + "</p>")
            i = j
    return "\n".join(out)


# ---------------------------------------------------------------- pages

NUMBER_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
                "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen",
                "nineteen", "twenty"]


def number_word(n, capital=False):
    word = NUMBER_WORDS[n] if n < len(NUMBER_WORDS) else str(n)
    return word.capitalize() if capital else word


def join_and(items):
    items = list(items)
    if len(items) <= 2:
        return " and ".join(items)
    return ", ".join(items[:-1]) + ", and " + items[-1]


def asset_versions():
    """The cache-busting versions the hand-written developer page uses: the favicon URL from the home page, and the
    stylesheet and script versions from /developers/, so the generated pages request the same files
    (web/test/site.test.js checks that every page links one version of each stylesheet)."""
    home = (WEB / "index.html").read_text(encoding="utf-8")
    dev = (DEV / "index.html").read_text(encoding="utf-8")
    icon = need(re.search(r'<link rel="icon" href="(/favicon\.svg\?v=[^"]+)"', home), "the versioned favicon on /").group(1)
    versions = {}
    for key, pattern in (("nav_css", r'href="/shared/site-nav\.css\?v=(\d{8})"'),
                         ("settings", r'src="/homepage-settings\.js\?v=(\d{8})"'),
                         ("css", r'href="/developers/developers\.css\?v=(\d{8})"'),
                         ("nav_js", r'src="/shared/site-nav\.js\?v=(\d{8})"'),
                         ("js", r'src="/developers/developers\.js\?v=(\d{8})"')):
        versions[key] = need(re.search(pattern, dev), f"the {key} version on /developers/").group(1)
    return icon, versions


def nav_html(current=None):
    """The side navigation of the developer pages. current: the path of a generated page ("/developers/models"),
    whose section links then point at /developers/; None on /developers/ itself, where they stay in the page."""
    groups = []
    for title, links in NAV:
        items = []
        for label, target in links:
            href = f"/developers/{target}" if target.startswith("#") and current else target
            here = " aria-current=\"page\"" if target == current else ""
            items.append(f"<li><a href=\"{href}\"{here}>{html.escape(label)}</a></li>")
        groups.append(f"<div class=\"dev-nav-group\"><p class=\"dev-nav-title\">{html.escape(title)}</p>"
                      f"<ul>{''.join(items)}</ul></div>")
    return f"<nav class=\"dev-nav\" aria-label=\"Developer documentation\">{''.join(groups)}</nav>"


THEME_COLORS = ('<meta name="theme-color" content="#f6f5f1" media="(prefers-color-scheme: light)">\n'
                '    <meta name="theme-color" content="#171918" media="(prefers-color-scheme: dark)">')


def page(title, description, body, current):
    """A generated developer page: the shared site bar and footer (site-nav.js), the body with a link back to
    /developers/, and the side navigation (after the body, so phones show the page first)."""
    icon, v = asset_versions()
    return f"""<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    {THEME_COLORS}
    <meta name="description" content="{html.escape(description)}">
    <link rel="icon" href="{html.escape(icon)}" type="image/svg+xml">
    <link rel="stylesheet" href="/shared/site-nav.css?v={v['nav_css']}" />
    <script src="/homepage-settings.js?v={v['settings']}"></script>
    <link rel="stylesheet" href="/developers/developers.css?v={v['css']}">
    <title>{html.escape(title)} | Undiagnosed No More</title>
  </head>
  <body data-door="developers">
    <!-- Generated by analysis/build_models_guide.py. Do not edit by hand. -->
    <main class="dev-layout">
      <div class="doc">
<p class="crumbs"><a href="/developers/">Developers</a> <span aria-hidden="true">/</span> {html.escape(title)}</p>
{body}
      </div>
{nav_html(current)}
    </main>
    <script src="/shared/site-nav.js?v={v['nav_js']}" defer></script>
    <script type="module" src="/developers/developers.js?v={v['js']}"></script>
  </body>
</html>
"""


def spec_toc(spec_html):
    """An "On this page" list from the h2 headings of the rendered spec."""
    items = "".join(f"<li><a href=\"#{a}\">{t}</a></li>"
                    for a, t in re.findall(r'<h2 id="([^"]+)">(.*?)</h2>', spec_html))
    return f"<nav class=\"toc\" aria-label=\"On this page\"><p class=\"toc-title\">On this page</p><ol>{items}</ol></nav>"


def write_vectors_zip(vdir):
    """vectors/all-vectors.zip: every bundle and expected output, with fixed timestamps so reruns are byte-identical."""
    files = sorted(f for f in vdir.rglob("*.json"))
    target = vdir / "all-vectors.zip"
    with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        readme = ("Undiagnosed No More test vectors. Synthetic patients only; no real data.\n"
                  "bundles/: one FHIR R4 Bundle per patient.\n"
                  "expected/<model_id>-<version>/: the reference scorer's output for each patient.\n"
                  "A scorer passes a vector when, run with the vector's as_of date, its result has the same fields "
                  "as the expected output (without as_of), numbers agree to 1e-9, and everything else is identical.\n"
                  "Generated by analysis/build_models_guide.py from model/test_vectors/.\n")
        info = zipfile.ZipInfo("unm-test-vectors/README.txt", date_time=(2024, 6, 1, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        z.writestr(info, readme)
        for f in files:
            info = zipfile.ZipInfo(f"unm-test-vectors/{f.relative_to(vdir).as_posix()}", date_time=(2024, 6, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            z.writestr(info, f.read_bytes())
    return target


def build_guide(models, bundles, q, scenarios, rules):
    doc = Doc()
    doc.h(1, "Models guide")
    doc.p("What each condition card predicts, when it does not score, every feature with its codes, windows, and "
          "weights, the calibration and risk bands, the validation recorded in the model file, the follow-up "
          "questions for the patient, the next steps shown to clinicians, and the test patients with their "
          "expected results.")
    doc.p("Generated by `analysis/build_models_guide.py` from the model files, the test vectors, the card text of "
          "the CDS Hooks service, the patient questionnaire design, the validation results reported in the papers, "
          "and the Lyme county table (`opendata/processed/lyme_county_incidence.csv`). "
          "Do not edit by hand; rerun the script.")
    titles = {"lyme": "Lyme disease (county prior)", "lupus": "Lupus (classification-criteria review)"}
    toc = [(f"{meta['title']} ({m['model_id']} {m['version']})", meta["anchor"]) for m, _, _, meta in models]
    toc += [(titles[r["slug"]], r["slug"]) for r in rules]
    doc.toc(toc)
    for model, edir, vectors, meta in models:
        model_card(doc, model, meta, vectors, edir, q, scenarios)
    slugs = {r["slug"] for r in rules}
    if "lyme" in slugs:
        lyme_section(doc, bundles)
    if "lupus" in slugs:
        lupus_section(doc)
    return doc


def prefetch_request(bundle, pid, as_of):
    res = [e["resource"] for e in bundle["entry"]]

    def searchset(rt):
        hits = [r for r in res if r["resourceType"] == rt]
        return {"resourceType": "Bundle", "type": "searchset", "total": len(hits),
                "entry": [{"fullUrl": full_url(r), "resource": r, "search": {"mode": "match"}} for r in hits]}

    return {
        "hookInstance": f"00000000-0000-4000-8000-{sum(map(ord, pid)):012d}",
        "hook": "patient-view",
        "context": {"userId": "Practitioner/example", "patientId": pid},
        "extension": {CDS_AS_OF_EXTENSION: as_of},
        "prefetch": {
            "patient": next(r for r in res if r["resourceType"] == "Patient"),
            "conditions": searchset("Condition"),
            "encounters": searchset("Encounter"),
            "observations": searchset("Observation"),
            "medications": searchset("MedicationRequest"),
            "procedures": searchset("Procedure"),
        },
    }


def example_request(bundles, name, as_of):
    """One CDS Hooks example: the patient's prefetch, with the keys EXAMPLES leaves out removed."""
    pid, omit = EXAMPLES[name]
    req = prefetch_request(bundles[pid], pid, as_of)
    if omit:
        req["hookInstance"] = f"00000000-0000-4000-8000-{sum(map(ord, name)):012d}"
        for key in omit:
            del req["prefetch"][key]
    return req


def replace_block(text, name, content):
    start, end = f"<!-- generated:{name}:start -->", f"<!-- generated:{name}:end -->"
    pattern = re.compile(re.escape(start) + r".*?" + re.escape(end), re.S)
    need(pattern.search(text), f"the {name} markers in web/web/developers/index.html")
    return pattern.sub(lambda _: f"{start}\n{content}\n{end}", text)


# ---------------------------------------------------------------- generated blocks of /developers/

def code_block(label, text, cls=""):
    """A code block with a head naming it; the page script adds a copy button to the head."""
    classes = " ".join(["code", *cls.split()])
    return (f"<div class=\"{classes}\"><div class=\"code-head\"><span>{html.escape(label)}</span></div>"
            f"<pre><code>{html.escape(text, quote=False)}</code></pre></div>")


def pretty(value):
    return json.dumps(value, indent=2, ensure_ascii=False)


def day0_text(model):
    ie, t, W = model.get("index_event", {}), model["target"], model.get("windows", {})
    if ie.get("type") == "scoring_date":
        looks = join_and(f"`{k}` (days {v[0]} to {v[1]})" for k, v in W.items())
        return f"The scoring date. Windows look back from it: {looks}."
    codes = ", ".join(ie.get("condition_codes", {}).get("icd10cm", []))
    era = f" on or after {fmt_day(ie['earliest_date'])}" if ie.get("earliest_date") else ""
    return (f"The first Condition coded ICD-10-CM {codes}{era}. Scored from day {t['landmark_days']} to day "
            f"{t['horizon_days'][1]}.")


def excluded_codes(model):
    systems = {"icd10cm": "ICD-10-CM", "snomed": "SNOMED CT"}
    ex = model["exclusion"]["condition_codes"]
    return "; ".join(f"{systems.get(s, s)} " + ", ".join(icd_display(c) if s == "icd10cm" else c for c in v)
                     for s, v in ex.items())


def overview_block(models, n_patients):
    files = "".join(f"<li><code>{html.escape(meta['download'])}</code> {html.escape(m['version'])}</li>"
                    for m, _, _, meta in models)
    return f"""<figure class="flow">
<figcaption class="flow-caption">How the pieces fit</figcaption>
<div class="flow-grid">
<div class="flow-col"><p class="flow-head"><a href="#registry">Model files</a></p><ul>{files}</ul><p class="flow-note">JSON: features with their codes, windows, and weights, a calibration map, and risk bands.</p></div>
<div class="flow-col"><p class="flow-head"><a href="#scoring">Scorer</a></p><ul><li><code>score_fhir.py</code>, the Python reference</li><li><code>scorer.js</code>, its JavaScript port</li></ul><p class="flow-note">In: a model file, a FHIR R4 Bundle, and a scoring date. Out: status, probability, band, and the dated findings behind the score.</p></div>
<div class="flow-col"><p class="flow-head">Where it runs</p><ul><li><a href="#cds-hooks">CDS Hooks service</a></li><li><a href="#ehr-launch">SMART on FHIR app</a></li><li><a href="#scoring">Your code</a></li></ul><p class="flow-note">The service and the apps import the same <code>scorer.js</code>.</p></div>
</div>
<p class="flow-base"><a href="#vectors">Test vectors</a>: {n_patients} synthetic FHIR R4 patients with the reference scorer's output for each model. The JavaScript scorer reproduces every one to 1e-9.</p>
</figure>"""


def try_block(models, scenarios, as_of):
    patients = "".join(f"<option value=\"{p}\"{' selected' if p == 'maria' else ''} "
                       f"data-scenario=\"{html.escape(scenarios[p][0])}\">{p.capitalize()}</option>" for p in PATIENTS)
    options = []
    for m, edir, vectors, meta in models:
        expected = f" data-expected=\"/developers/vectors/expected/{edir.name}/\"" if vectors else ""
        options.append(f"<option value=\"{meta['url']}\"{expected}>{html.escape(meta['title'])} "
                       f"{html.escape(m['version'])}</option>")
    types = []
    for m, _, _, _ in models:
        elig = ["Patient", "Condition", "Encounter"] + (["Observation"] if m.get("index_event", {}).get("use_positive_tests") else [])
        for t in elig + sorted({f["resource"] for f in m["features"] if f.get("resource")}):
            if t not in types:
                types.append(t)
    boxes = "".join(f"<label class=\"check\"><input type=\"checkbox\" name=\"unavailable\" value=\"{t}\"> {t}</label>"
                    for t in types)
    return f"""<div class="try-fields">
<label class="field"><span>Patient</span><select name="patient">{patients}</select></label>
<label class="field"><span>Model</span><select name="model">{''.join(options)}</select></label>
<label class="field"><span>Scoring date</span><input name="as_of" type="date" value="{as_of}" data-vectors="{as_of}" required></label>
</div>
<fieldset class="try-unavailable"><legend>Searches that failed (the <code>unavailable</code> option)</legend>{boxes}</fieldset>"""


def cds_models_block(models, facts):
    names = [f"<a href=\"/developers/models#{meta['anchor']}\">{html.escape(meta['title'])} {html.escape(m['version'])}</a>"
             for m, _, _, meta in models if f"{m['model_id']}-{m['version']}" in facts["cds"]]
    return (f"<p>A stateless CDS Hooks 2.0 service for the <code>patient-view</code> hook. It scores the prefetched "
            f"chart with the {join_and(names)} model files and answers with one card for each condition in the High "
            "band (indicator <code>warning</code>) or the Elevated band (<code>info</code>), plus one "
            "<code>info</code> card naming every condition it could not score. Typical and not-scored results give "
            "no card, so a chart with nothing to flag gets <code>{\"cards\": []}</code>.</p>")


def cds_request_block(request_text):
    lines = request_text.count("\n")
    return ("<details class=\"code-details\"><summary>The whole request, <code>maria.json</code> "
            f"({lines:,} lines)</summary>\n" + code_block("maria.json", request_text, "code-tall") + "\n</details>")


def cds_responses_block(models, facts):
    out = []
    for name, (pid, omit) in EXAMPLES.items():
        body = facts["responses"][f"web/web/developers/examples/{name}.json"]
        need(body["status"] == 200, f"HTTP 200 for examples/{name}.json")
        if omit:
            readers = [meta["title"] for m, _, _, meta in models if f"{m['model_id']}-{m['version']}" in facts["cds"]
                       and any(f.get("resource") == "Observation" for f in m["features"])]
            caption = (f"<code>{name}.json</code>. {pid.capitalize()}'s request without the "
                       f"<code>{', '.join(omit)}</code> prefetch key and with no <code>fhirServer</code>, so the service "
                       f"cannot read the Observation search. The {html.escape(join_and(readers))} models read "
                       "Observation, so they get the could-not-score card instead of a result.")
        else:
            parts = []
            for m, _, vectors, meta in models:
                e = vectors.get(pid)
                if e and f"{m['model_id']}-{m['version']}" in facts["cds"]:
                    parts.append(f"{html.escape(meta['title'])}: {e['band'] if e['status'] == 'scored' else 'not scored'}")
            n = len(body["body"]["cards"])
            caption = (f"<code>{name}.json</code>. {pid.capitalize()}'s expected results are {'; '.join(parts)}. "
                       f"The service returns {number_word(n)} card{'s' if n != 1 else ''}.")
        block = code_block(f"Response to {name}.json", pretty(body["body"]), "code-wrap")
        if not out:
            out.append(f"<p class=\"code-caption\">{caption}</p>\n{block}")
        else:
            out.append(f"<details class=\"code-details\"><summary>{caption}</summary>\n{block}\n</details>")
    return "\n".join(out)


def cds_live_block():
    """The form that posts an example request to the live service (the page script shows it)."""
    options = "".join(f"<option value=\"{name}\">{name}.json</option>" for name in EXAMPLES)
    return (f"<div class=\"live\" id=\"cds-live\" hidden><label class=\"field\"><span>Example request</span>"
            f"<select id=\"cds-example\">{options}</select></label>"
            "<button class=\"button\" type=\"button\" id=\"cds-send\">Send to the service</button></div>"
            "<p class=\"live-status\" id=\"cds-status\" aria-live=\"polite\"></p><div id=\"cds-output\"></div>")


def result_block(models):
    """The fields of a scored result, with Maria's values for the first model that scores her."""
    m, _, vectors, meta = next(t for t in models if t[2].get("maria", {}).get("status") == "scored")
    e = vectors["maria"]
    on = sum(1 for v in e["features"].values() if v)
    rows = [
        ("status", "<code>\"scored\"</code>, <code>\"not_scored\"</code>, or <code>\"could_not_score\"</code>",
         f"<code>\"{e['status']}\"</code>"),
        ("reason", "Why it did not score, as a sentence the app shows; absent when scored", "absent"),
        ("index_date", "Day 0 (YYYY-MM-DD): the index event, or the scoring date for a scoring-date model; absent "
                       "when there is no index event", e["index_date"]),
        ("score", "<code>intercept</code> + Σ weight × value", fmt_num(e["score"])),
        ("probability", "The calibration map applied to the score", f"{fmt_num(e['probability'])} ({pct(e['probability'])})"),
        ("band", "The first risk band whose <code>max_probability</code> is at or above the probability", e["band"]),
        ("times_average", "probability / <code>reference.cohort_base_rate</code>", fmt_num(e["times_average"], 4)),
        ("features", "Every feature id with its value, 0 or 1", f"{len(e['features'])} features, {on} equal to 1"),
        ("drivers", "Present features with a nonzero weight, largest contribution first, each with the dated "
                    "resources that set it; features that differ only in threshold are one entry",
         f"{len(e['drivers'])} drivers"),
        ("unavailable", "The resource types that could not be read; only when the status is "
                        "<code>could_not_score</code>", "absent"),
    ]
    label = f"Maria, {html.escape(meta['title'])} {m['version']}"
    body = "".join(f"<tr><td><code>{k}</code></td><td>{d}</td>"
                   f"<td data-label=\"Maria\">{html.escape(v) if '<' not in v else v}</td></tr>" for k, d, v in rows)
    head = f"<th scope=\"col\">Field</th><th scope=\"col\">Meaning</th><th scope=\"col\">{label}</th>"
    table = f"<div class=\"table-wrap\"><table class=\"fields\"><thead><tr>{head}</tr></thead><tbody>{body}</tbody></table></div>"
    driver = code_block(f"drivers[0] for Maria, {meta['download']}", pretty(e["drivers"][0]))
    return table + "\n" + driver


def registry_block(models, rules, facts):
    out = []
    for m, edir, vectors, meta in models:
        n_w = sum(1 for f in m["features"] if f["weight"] != 0)
        size = (WEB / "models" / meta["download"]).stat().st_size
        digest = hashlib.sha256((WEB / "models" / meta["download"]).read_bytes()).hexdigest()
        vec = (f"<a href=\"#vectors\">expected outputs</a> for {len(vectors)} test patients" if vectors
               else "no expected outputs yet")
        t = m["target"]
        facts_rows = [
            ("Predicts", f"{html.escape(t['label'])}. {html.escape(t['definition'])}."),
            ("Population", html.escape(t["population"]) + "."),
            ("Day 0", inline_html(day0_text(m))),
            ("Already coded", f"Not scored when the chart has {html.escape(excluded_codes(m))}."),
            ("Features", f"{len(m['features'])}, " + ("all with a weight" if n_w == len(m["features"])
                                                       else f"of which {n_w} carry a weight")),
            ("Runs in", html.escape(join_and(meta["runs"])) if meta["runs"] else "no app or service yet"),
            ("Files", f"<a href=\"{meta['url']}\" download>{html.escape(meta['download'])}</a> "
                      f"({max(1, round(size / 1024))} KB, SHA-256 <code class=\"hash\">{digest}</code>); "
                      f"<a href=\"/developers/models#{meta['anchor']}\">model card</a>; {vec}"),
        ]
        rows = "".join(f"<dt>{k}</dt><dd>{v}</dd>" for k, v in facts_rows)
        out.append(f"<div class=\"model-entry\" id=\"registry-{meta['anchor']}\"><h3>{html.escape(meta['title'])} "
                   f"<span class=\"model-id\"><code>{m['model_id']}</code> {html.escape(m['version'])}, "
                   f"{html.escape(m['status'])}</span></h3><dl class=\"facts\">{rows}</dl></div>")
    if rules:
        labels = join_and(f"<a href=\"/developers/models#{r['slug']}\">{html.escape(r['label'])}</a>" for r in rules)
        files = join_and(f"<code>{r['file']}</code>" for r in rules)
        out.append(f"<p>The {labels} cards of the clinician app have no model file yet. Until they do, they run "
                   f"chart rules ({files}) inside the app, and the CDS Hooks service does not score them.</p>")
    return "\n".join(out)


def fhir_block(models):
    counts = []
    keys = []
    for m, _, _, _ in models:
        rows = {(r[0], r[1]): (r[2], r[3]) for r in fhir_inputs(m)}
        counts.append(rows)
        for k in rows:
            if k not in keys:
                keys.append(k)
    keys.sort()
    head = ("<th scope=\"col\">Resource or field</th><th scope=\"col\">Code system</th>"
            + "".join(f"<th scope=\"col\">{html.escape(meta['title'])}</th>" for _, _, _, meta in models))
    body = []
    for k in keys:
        cells = "".join(f"<td data-label=\"{html.escape(meta['title'])}\">" + (f"{c[k][0]} ({c[k][1]})" if k in c else "none")
                        + "</td>" for c, (_, _, _, meta) in zip(counts, models))
        body.append(f"<tr><td>{html.escape(k[0])}</td><td data-label=\"Code system\">{html.escape(k[1])}</td>{cells}</tr>")
    return (f"<div class=\"table-wrap\"><table class=\"fields\"><thead><tr>{head}</tr></thead><tbody>{''.join(body)}</tbody></table>"
            "</div>")


def vectors_block(models, scenarios, zip_path):
    vec = ["<div class=\"table-wrap\"><table><thead><tr><th scope=\"col\">Patient</th><th scope=\"col\">Scenario</th>"
           + "".join(f"<th scope=\"col\">{html.escape(meta['title'])} {m['version']}</th>" for m, _, _, meta in models)
           + "<th scope=\"col\">Bundle</th></tr></thead><tbody>"]
    for pid in PATIENTS:
        cells = []
        for m, edir, vectors, meta in models:
            e = vectors.get(pid)
            if not e:
                cells.append("<td>n/a</td>")
            elif e["status"] == "scored":
                cells.append(f"<td><a href=\"/developers/vectors/expected/{edir.name}/{pid}.json\">{e['band']}, "
                             f"{pct(e['probability'])}</a></td>")
            else:
                cells.append(f"<td><a href=\"/developers/vectors/expected/{edir.name}/{pid}.json\">not scored</a>: "
                             f"{html.escape(e['reason'])}</td>")
        vec.append(f"<tr><td>{pid.capitalize()}</td><td>{html.escape(scenarios[pid][0])}</td>{''.join(cells)}"
                   f"<td><a href=\"/developers/vectors/bundles/{pid}.json\">{pid}.json</a></td></tr>")
    vec.append("</tbody></table></div>")
    as_of = next((e["as_of"] for _, _, v, _ in models for e in v.values()), None)
    when = fmt_day(as_of) if as_of else "today"
    n, k = len(PATIENTS), len(models)
    outputs = sum(len(v) for _, _, v, _ in models)
    size = f", {max(1, round(zip_path.stat().st_size / 1024))} KB" if zip_path and zip_path.exists() else ""
    intro = (f"<p>{number_word(n, True)} synthetic patients (no real data), each a FHIR R4 Bundle, and the reference "
             f"scorer's output for each of the {number_word(k)} models above, scored as of {when}: {outputs} expected "
             "outputs.</p>\n"
             f"<p class=\"actions\"><a class=\"button\" href=\"/developers/vectors/all-vectors.zip\" download>"
             f"Download all vectors (zip{size})</a></p>")
    table = ("<details class=\"vectors-detail\"><summary>Expected output for each patient and model "
             f"({n} patients, {k} models, with links to each file)</summary>\n" + "\n".join(vec) + "\n</details>")
    return intro + "\n" + table


def versions_block(models):
    """Every expected-output directory and whether a model file in model/ has that version."""
    files = {}
    for path in sorted((REPO / "model").glob("*.json")):
        mf = json.loads(path.read_text(encoding="utf-8"))
        files[f"{mf['model_id']}-{mf['version']}"] = path.name
    current = {f"{m['model_id']}-{m['version']}" for m, _, _, _ in models}
    rows, checked = [], 0
    for d in sorted((REPO / "model" / "test_vectors" / "expected").iterdir()):
        if not d.is_dir():
            continue
        n = len(list(d.glob("*.json")))
        if d.name in current:
            state = f"current: <code>model/{files[d.name]}</code>"
        elif d.name in files:
            state = f"placeholder example: <code>model/{files[d.name]}</code>"
        else:
            state = "superseded: no model file has this version"
        if d.name in files:
            checked += n
        rows.append(f"<tr><td><code>{d.name}/</code></td><td data-label=\"Outputs\">{n}</td>"
                    f"<td data-label=\"Model file\">{state}</td></tr>")
    table = ("<div class=\"table-wrap\"><table class=\"fields\"><thead><tr><th scope=\"col\">Directory in "
             "<code>model/test_vectors/expected/</code></th><th scope=\"col\">Outputs</th><th scope=\"col\">Model file"
             "</th></tr></thead><tbody>" + "".join(rows) + "</tbody></table></div>")
    return (table + f"\n<p><code>web/test/scorer.test.js</code> checks the JavaScript scorer against the {checked} "
            "expected outputs whose model file is in <code>model/</code> and skips the superseded ones.</p>")


def registry_json(models, contract):
    entries = []
    for m, edir, vectors, meta in models:
        data = (WEB / "models" / meta["download"]).read_bytes()
        entries.append({
            "model_id": m["model_id"], "version": m["version"], "status": m["status"], "title": meta["title"],
            "file": meta["url"], "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest(),
            "predicts": m["target"]["label"], "day_0": m.get("index_event", {}).get("type", "index_event"),
            "features": len(m["features"]), "weighted_features": sum(1 for f in m["features"] if f["weight"] != 0),
            "runs_in": meta["runs"], "model_card": f"/developers/models#{meta['anchor']}",
            "expected_outputs": f"/developers/vectors/expected/{edir.name}/" if vectors else None,
        })
    return {"description": "Model files served by this site. Generated by analysis/build_models_guide.py from "
                           "model/*.json; see /developers/#registry.",
            "contract_version": contract, "models": entries}


def main():
    bundle_names = sorted(p.stem for p in (REPO / "model" / "test_vectors" / "bundles").glob("*.json"))
    need(sorted(PATIENTS) == bundle_names, "every bundle in model/test_vectors/bundles/ in PATIENTS")
    bundles = {p: load_json(f"model/test_vectors/bundles/{p}.json") for p in PATIENTS}
    loaded = [(load_json(path.relative_to(REPO)), path) for path in model_paths()]
    vectors_of = {path: load_vectors(m, bundles) for m, path in loaded}
    as_of = next((e["as_of"] for _, v in vectors_of.values() for e in v.values()), dt.date.today().isoformat())
    q = parse_questionnaire()
    scenarios = parse_scenarios()
    contract = need(re.search(r"contract version ([\d.]+)", read("docs/interface/model_spec.md")),
                    "the contract version in docs/interface/model_spec.md").group(1)

    # CDS Hooks example requests first: the service's answers to them are read with the rest of the code facts
    xdir = DEV / "examples"
    if xdir.exists():
        shutil.rmtree(xdir)
    (xdir / "responses").mkdir(parents=True)
    requests = {}
    for name in EXAMPLES:
        requests[name] = json.dumps(example_request(bundles, name, as_of), indent=1) + "\n"
        (xdir / f"{name}.json").write_text(requests[name], encoding="utf-8")
    facts = site_facts([xdir / f"{name}.json" for name in EXAMPLES])
    for name in EXAMPLES:
        body = facts["responses"][f"web/web/developers/examples/{name}.json"]["body"]
        (xdir / "responses" / f"{name}.json").write_text(json.dumps(body, indent=1, ensure_ascii=False) + "\n",
                                                         encoding="utf-8")
    (xdir / "responses" / "discovery.json").write_text(
        json.dumps(facts["discovery"], indent=1, ensure_ascii=False) + "\n", encoding="utf-8")

    # models in the CDS Hooks service's order, then the rest by id
    rank = {key: i for i, key in enumerate(facts["cds"])}
    models = sorted(((m, *vectors_of[path], card_meta(m, path, facts)) for m, path in loaded),
                    key=lambda t: (rank.get(f"{t[0]['model_id']}-{t[0]['version']}", len(rank)), t[0]["model_id"]))
    rules = rule_cards(facts)

    doc = build_guide(models, bundles, q, scenarios, rules)
    (REPO / "docs" / "MODELS_GUIDE.md").write_text(render_md(doc), encoding="utf-8")
    DEV.mkdir(parents=True, exist_ok=True)
    (DEV / "models.html").write_text(page(
        "Models guide", "Features, codes, windows, weights, calibration, follow-up questions, and test patients "
        "for each Undiagnosed No More condition card.", render_html(doc), "/developers/models"), encoding="utf-8")

    # internal team notes ("Open questions for ...") stay out of the public page
    spec_md = re.sub(r"^## \d+\. Open questions.*?(?=^## |\Z)", "", read("docs/interface/model_spec.md"), flags=re.M | re.S)
    # ...and so do the team-facing lines of the preamble (who it was written for, when the first file arrives)
    spec_md = re.sub(r"^Written for [^\n]*?\. ", "", spec_md, flags=re.M)
    spec_md = re.sub(r"^The first real model file will arrive[^\n]*\n\n?", "", spec_md, flags=re.M)
    # ...and the questionnaire design document is named by the file that holds the app's items
    spec_md = spec_md.replace("grade in `submission/app_questionnaire.md`)",
                              "grade; item wording in `web/web/patient/instruments.js`)")
    spec = markdown_to_html(spec_md)
    spec = ("<p class=\"generated-note\">Rendered from <code>docs/interface/model_spec.md</code>. The Python "
            "reference scorer <code>model/reference/score_fhir.py</code> is the ground truth where the text and the "
            "code differ.</p>\n" + spec)
    first_h2 = spec.find("<h2 ")
    spec = spec[:first_h2] + spec_toc(spec) + "\n" + spec[first_h2:] if first_h2 >= 0 else spec
    (DEV / "spec.html").write_text(page("Interface spec", "The model file contract: structure, feature kinds, "
                                        "scoring, and test vectors.", spec, "/developers/spec"), encoding="utf-8")

    vdir = DEV / "vectors"
    if vdir.exists():
        shutil.rmtree(vdir)
    (vdir / "bundles").mkdir(parents=True)
    for p in PATIENTS:
        shutil.copy(REPO / f"model/test_vectors/bundles/{p}.json", vdir / "bundles" / f"{p}.json")
    for m, edir, vectors, _ in models:
        if vectors:
            (vdir / "expected" / edir.name).mkdir(parents=True)
            for p in vectors:
                shutil.copy(edir / f"{p}.json", vdir / "expected" / edir.name / f"{p}.json")
    zip_path = write_vectors_zip(vdir)

    (WEB / "models" / "index.json").write_text(json.dumps(registry_json(models, contract), indent=1) + "\n",
                                                encoding="utf-8")

    index = DEV / "index.html"
    text = index.read_text(encoding="utf-8")
    blocks = {
        "nav": nav_html(),
        "overview": overview_block(models, len(PATIENTS)),
        "try": try_block(models, scenarios, as_of),
        "cds-models": cds_models_block(models, facts),
        "cds-discovery": code_block("Response", pretty(facts["discovery"]), "code-wrap"),
        "cds-request": cds_request_block(requests["maria"]),
        "cds-responses": cds_responses_block(models, facts),
        "cds-live": cds_live_block(),
        "result": result_block(models),
        "registry": registry_block(models, rules, facts),
        "contract-version": f"<p>The contract is at version {contract}. Its full text is the "
                            "<a href=\"/developers/spec\">interface spec</a>.</p>",
        "fhir-inputs": fhir_block(models),
        "vectors": vectors_block(models, scenarios, zip_path),
        "versions": versions_block(models),
    }
    for name, content in blocks.items():
        text = replace_block(text, name, content)
    index.write_text(text, encoding="utf-8")

    # The public pages name no internal task numbers or internal folders (the comments in CARDS keep the sources).
    for name in ("index.html", "models.html", "spec.html"):
        text = re.sub(r"<!--.*?-->|<[^>]+>", " ", (DEV / name).read_text(encoding="utf-8"), flags=re.S)
        hit = INTERNAL.search(text)
        if hit:
            raise SystemExit(f"build_models_guide: web/web/developers/{name} shows internal text: "
                             f"\"...{text[max(0, hit.start() - 80):hit.end() + 40].strip()}...\"")

    print("wrote docs/MODELS_GUIDE.md, web/web/developers/{models,spec}.html, vectors/ (and all-vectors.zip), "
          "examples/ (and responses/), web/web/models/index.json, index.html blocks")


if __name__ == "__main__":
    main()
