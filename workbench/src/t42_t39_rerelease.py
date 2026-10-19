"""Task 42: re-release three Task 39 endometriosis exports whose terminal capture was truncated.

Runs inside the All of Us Workbench (bash ~/unm/bin/unm.sh run 42). No queries, no new computation: copies the
already-checked files from ~/unm/export/39/ into ~/unm/export/42/ so the runner prints them again, re-checking each.
The endometriosis drug code list (large) is re-released separately by Task 43.
"""

from __future__ import annotations

import os
import shutil
import sys

import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from aou_safe import check_exportable  # noqa: E402

SRC = os.path.expanduser("~/unm/export/39")
FILES = ["t39_endometriosis_calibration_bins.csv", "t39_endometriosis_by_sex.csv", "t39_endometriosis_codelist_labs.csv"]
EXPORT = os.path.expanduser(os.environ.get("UNM_T42_EXPORT", "~/unm/export/42"))


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
