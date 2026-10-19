"""Rebuild the deployed Long COVID model file (model/longcovid.json, version 1.2.0) from the released aggregates.

Steps (inputs: results/aggregate/35, 36, 02, and 10; workbench/src/features.yaml and transport_site_candidate_v3.json):
 1. model/candidates/transport_candidates_v3.json and its Workbench copy workbench/src/transport_candidates_v3.json:
    analysis/fit_transport_model.fit on the Task 35 summary counts (results/aggregate/35)
 2. model/longcovid.json: model/build_model.main with RELEASE below, that is, the nb_eb candidate calibrated on the
    training-split score bins of the Task 36 validation run (results/aggregate/36)

Usage, from the repository root:
    python3 analysis/build_longcovid_model.py           # rebuild; write only files whose content changed
    python3 analysis/build_longcovid_model.py --check   # rebuild into a temporary folder, compare, change nothing;
                                                        # exit status 1 if any output would change
analysis/build_paper1.py runs the same two steps as part of the Paper 1 rebuild.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
for p in ("analysis", "model"):
    sys.path.insert(0, os.path.join(ROOT, p))

AGG = os.path.join(ROOT, "results/aggregate")
CANDIDATES = "model/candidates/transport_candidates_v3.json"
CANDIDATES_SOURCE = "results/aggregate/35 (2026-10-15 audit rerun; both condition domains; table-local suppression)"
# v1.1.0 (2026-10-03): nb_eb from the Task 35 counts, evaluated on the Task 36 validation split. v1.2.0 (2026-10-11)
# keeps those weights and adds index_event.earliest_date and the full Long COVID exclusion list; refit on
# 2026-10-15 on the corrected Task 35 and 36 reruns.
RELEASE = {"model_name": "nb_eb", "version": "1.2.0", "eval_dir": "36", "evaluation": "validation_split"}
OUTPUTS = [CANDIDATES, "workbench/src/transport_candidates_v3.json", "model/longcovid.json"]


def evaluation_note(agg: str = AGG) -> str:
    import pandas as pd
    d = pd.read_csv(os.path.join(agg, "36/t17_site_performance.csv"))
    r = d[d.model.str.startswith("exported naive Bayes (frozen")].iloc[0]
    summary = pd.read_csv(os.path.join(agg, "35/t35_guard_summary.csv"))
    seed = re.search(r"seed (\d+)", summary[summary.item.str.startswith("seed for")].value.iloc[0]).group(1)
    n_site = len(json.load(open(os.path.join(ROOT, "workbench/src/transport_site_candidate_v3.json")))["features"])
    return (f"random 20% validation split (Task 36, seed {seed}); held-out-site AUROC of the frozen {n_site}-feature pipeline: "
            f"{r.auroc:.3f} (95% CI {r.auroc_lo:.3f}-{r.auroc_hi:.3f}), results/aggregate/36/t17_site_performance.csv")


def features_note(agg: str = AGG) -> str:
    import pandas as pd
    d = pd.read_csv(os.path.join(agg, "35/t35_guard_summary.csv"))
    n = int(re.match(r"\s*(\d+)", d[d.item.str.startswith("features reverted")].value.iloc[0]).group(1))
    if n == 0:
        return ("Condition features use ICD-10-CM codes from both condition_occurrence and observation "
                "for every predictor (Task 35; results/aggregate/35/t35_guard_summary.csv)")
    return ("Condition features use ICD-10-CM codes from the condition and observation tables (Task 35); "
            f"{n} symptom features kept condition-table-only training definitions under the disclosure guard "
            "(results/aggregate/35/t35_guard_summary.csv)")


def build(R: str, agg: str = AGG) -> None:
    """Write the candidates and the model file under root R."""
    import fit_transport_model
    import build_model
    cand = fit_transport_model.fit(os.path.join(agg, "35"))
    cand["meta"]["source"] = CANDIDATES_SOURCE
    for path in (CANDIDATES, "workbench/src/transport_candidates_v3.json"):
        os.makedirs(os.path.dirname(os.path.join(R, path)), exist_ok=True)
        json.dump(cand, open(os.path.join(R, path), "w"), indent=1)
    build_model.main(results=agg, candidates=os.path.join(R, CANDIDATES), out=os.path.join(R, "model/longcovid.json"),
                     evaluation_note=evaluation_note(agg), features_note=features_note(agg), **RELEASE)


def main(check: bool) -> int:
    tmp = tempfile.mkdtemp(prefix="build_longcovid_model_")
    try:
        build(tmp)
        changed = [p for p in OUTPUTS if not os.path.exists(os.path.join(ROOT, p)) or
                   open(os.path.join(tmp, p), "rb").read() != open(os.path.join(ROOT, p), "rb").read()]
        for p in OUTPUTS:
            print(f"{'CHANGED' if p in changed else 'same   '} {p}")
        if check:
            print(f"{len(changed)} of {len(OUTPUTS)} outputs would change" if changed else "all outputs reproduce")
            return 1 if changed else 0
        for p in changed:
            shutil.copyfile(os.path.join(tmp, p), os.path.join(ROOT, p))
        print(f"wrote {len(changed)} changed outputs" if changed else "nothing changed")
        return 0
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--check", action="store_true", help="compare only; exit 1 if an output would change")
    sys.exit(main(ap.parse_args().check))
