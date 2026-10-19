"""Task 51: re-release the Task 44 exports whose terminal capture was lost when the bridge disconnected.

Runs inside the All of Us Workbench (bash ~/unm/bin/unm.sh run 51). No queries, no new computation: copies the
already-checked files from ~/unm/export/44/ into ~/unm/export/51/ so the runner prints them again, re-checking each.
Prints "missing <file>" for any file Task 44 did not write (then Task 44 did not finish and must be rerun).
"""

from __future__ import annotations

import os
import shutil
import sys

import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from aou_safe import check_exportable  # noqa: E402

SRC = os.path.expanduser("~/unm/export/44")
FILES = ["t44_split_check.csv", "t30_metrics.csv", "t33_metrics.csv", "t39_endometriosis_metrics.csv",
         "t39_fibromyalgia_metrics.csv"]
EXPORT = os.path.expanduser(os.environ.get("UNM_T51_EXPORT", "~/unm/export/51"))


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
