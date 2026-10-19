"""Task 53: re-release the Task 46 exports whose terminal capture was lost when the bridge disconnected.

Runs inside the All of Us Workbench (bash ~/unm/bin/unm.sh run 53). No queries, no new computation: copies the
already-checked files from ~/unm/export/46/ into ~/unm/export/53/ so the runner prints them again, re-checking each.
Prints "missing <file>" for any file Task 46 did not write (then Task 46 did not finish).
"""

from __future__ import annotations

import os
import shutil
import sys

import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from aou_safe import check_exportable  # noqa: E402

SRC = os.path.expanduser("~/unm/export/46")
FILES = ["t46_benchmark20.csv", "t46_benchmark20_excluded.csv", "t46_bootstrap.csv", "t46_code_coverage.csv", "t46_definitions.csv", "t46_earliest_survey.csv", "t46_endometriosis_sites.csv", "t46_ethnicity_mapping.csv", "t46_female_anchors.csv", "t46_flow.csv", "t46_item_status.csv", "t46_occasions.csv", "t46_occasions_overall.csv", "t46_population_age.csv", "t46_population.csv", "t46_prior_check.csv", "t46_race_revised.csv", "t46_race_revised_standardized.csv", "t46_routing.csv", "t46_sex_adjusted.csv", "t46_survey_versions.csv"]
EXPORT = os.path.expanduser(os.environ.get("UNM_T53_EXPORT", "~/unm/export/53"))


def main(src=SRC, files=FILES, export=EXPORT):
    os.makedirs(export, exist_ok=True)
    for name in files:
        path = os.path.join(src, name)
        if not os.path.exists(path):
            print(f"missing {name}", flush=True)
            continue
        check_exportable(pd.read_csv(path, dtype=str))
        shutil.copyfile(path, os.path.join(export, name))
        print(f"re-released {name}", flush=True)
    print("Task finished", flush=True)


if __name__ == "__main__":
    main()
