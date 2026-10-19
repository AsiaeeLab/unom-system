"""Table 1 of Paper 4 (the deployed models) from the model files and the released validation metrics.

Each row takes the version and the feature count from the model file and the validation AUROC with its 95% CI
and the AUPRC from the released metrics file of the analysis that fitted the model:
  Long COVID       results/aggregate/36/t05_transport_performance.csv, the nb_eb row (random 20% validation split);
                   the companion released model's held-out-site row from results/aggregate/60/final_metrics.csv
  self-report      results/aggregate/<task>/<prefix>_metrics.csv, the exported summary-count model (nb_sr_exported)
                   among self-reporters with no qualifying code
Writes paper4/tables/models.tex (the tabular of Table 1, without the caption).
Usage, from the repository root: python3 paper4/tables_p4.py [--out FILE]
"""

from __future__ import annotations

import argparse
import json
import os

import pandas as pd

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
AGG = os.path.join(ROOT, "results/aggregate")
OUT = os.path.join(ROOT, "paper4/tables/models.tex")
SELF_REPORT_TARGET = "Self-reported diagnosis, evaluated among self-reporters with no qualifying code"
# (model file, row label, label and target, metrics file); the Long COVID row is assembled in long_covid().
SELF_REPORT = [
    ("chronicfatigue", "Chronic fatigue", SELF_REPORT_TARGET, "33/t33_metrics.csv"),
    ("fibromyalgia", "Fibromyalgia", SELF_REPORT_TARGET, "39/t39_fibromyalgia_metrics.csv"),
    ("endometriosis", "Endometriosis",
     "Self-reported diagnosis among women, evaluated among self-reporters with no qualifying code",
     "39/t39_endometriosis_metrics.csv"),
    ("lyme", "Lyme disease", SELF_REPORT_TARGET, "54/t54_lyme_metrics.csv"),
    ("lupus", "Lupus", SELF_REPORT_TARGET, "54/t54_lupus_metrics.csv"),
    ("migraine", "Migraine", SELF_REPORT_TARGET, "55/t55_migraine_metrics.csv"),
    ("depression", "Depression", SELF_REPORT_TARGET, "55/t55_depression_metrics.csv"),
    ("anxiety", "Anxiety", SELF_REPORT_TARGET, "55/t55_anxiety_metrics.csv"),
]
# The companion Long COVID analysis released a linear discriminant on 41 features, fitted without 18 held-out sites.
COMPANION = "Companion released model (linear discriminant, 41 features) at 18 held-out sites"


def model(name: str) -> dict:
    return json.load(open(os.path.join(ROOT, f"model/{name}.json")))


def ci(auroc: float, lo: float, hi: float, auprc: float) -> str:
    return f"{auroc:.3f} ({lo:.3f}--{hi:.3f}), {auprc:.3f}"


def long_covid() -> list[str]:
    m = model("longcovid")
    nonzero = sum(1 for f in m["features"] if f["weight"] != 0)
    perf = pd.read_csv(os.path.join(AGG, "36/t05_transport_performance.csv")).set_index("model").loc["nb_eb"]
    final = pd.read_csv(os.path.join(AGG, "60/final_metrics.csv"))
    site = final[final.split == "site"].set_index("metric")
    return [f"Long COVID ({m['version']})", "First U09.9 code in days 91--455 among adults uncoded at day 90",
            f"{len(m['features'])} ({nonzero} nonzero)",
            f"Random 20\\% split: {ci(perf.auroc, perf.auroc_lo, perf.auroc_hi, perf.auprc)}. {COMPANION}: "
            f"{ci(site.estimate['AUROC'], site.lower['AUROC'], site.upper['AUROC'], site.estimate['AUPRC'])}"]


def self_report(name: str, label: str, target: str, metrics: str) -> list[str]:
    m = model(name)
    d = pd.read_csv(os.path.join(AGG, metrics))
    r = d[(d.model == "nb_sr_exported") & (d.target == "self-report, never coded")].iloc[0]
    return [f"{label} ({m['version']})", target, str(len(m["features"])),
            f"Random 20\\% split: {ci(r.auroc, r.auroc_lo, r.auroc_hi, r.auprc)}"]


def rows() -> list[list[str]]:
    return [long_covid()] + [self_report(*s) for s in SELF_REPORT]


def table() -> str:
    head = ["Model (version)", "Label and target", "Features", "Validation: AUROC (95\\% CI), AUPRC"]
    lines = ["\\begin{tabular}{L{0.15\\textwidth}L{0.25\\textwidth}L{0.09\\textwidth}L{0.42\\textwidth}}", "\\toprule",
             " & ".join(head) + " \\\\", "\\midrule"]
    lines += [" & ".join(r) + " \\\\" for r in rows()]
    lines += ["\\bottomrule", "\\end{tabular}"]
    return "\n".join(lines) + "\n"


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--out", default=OUT)
    out = ap.parse_args().out
    os.makedirs(os.path.dirname(out), exist_ok=True)
    open(out, "w").write(table())
    print("wrote", out)
