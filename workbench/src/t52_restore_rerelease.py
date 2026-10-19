"""Task 52: re-release earlier Workbench exports so locally suppressed cells can be restored.

Runs inside the All of Us Workbench (bash ~/unm/bin/unm.sh run 52). No queries, no new computation. Copies the
export files listed below from ~/unm/export/<task>/ into ~/unm/export/52/ under the name <task>__<file>, so the
runner prints them again and re-checks each one. Background: on October 1 and October 8, 2026 some cells of
these files were replaced locally with "<=20 flagged" or "<=20 jointly" and the earlier values were removed from
git history; under the literal reading of the dissemination policy (the dissemination policy) the released files
were compliant, so the original values are restored from these copies. Prints "missing <task>/<file>" for any
file that is no longer in the export folder.
"""

from __future__ import annotations

import os
import shutil
import sys

import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from aou_safe import check_exportable  # noqa: E402

ROOT = os.path.expanduser("~/unm/export")
FILES = [
    ("03", "t03_performance.csv"), ("03", "t03_subgroups.csv"),
    ("03_v2", "t03_performance.csv"), ("03_v2", "t03_subgroups.csv"),
    ("05", "t05_transport_performance.csv"),
    ("30", "t30_metrics.csv"), ("33", "t33_metrics.csv"),
    ("35", "t03_subgroups.csv"), ("35", "t15_threshold_subgroups.csv"),
    ("39", "t39_endometriosis_metrics.csv"), ("39", "t39_fibromyalgia_metrics.csv"),
]
EXPORT = os.path.expanduser(os.environ.get("UNM_T52_EXPORT", "~/unm/export/52"))


def main(root=ROOT, files=FILES, export=EXPORT):
    os.makedirs(export, exist_ok=True)
    for task, name in files:
        path = os.path.join(root, task, name)
        if not os.path.exists(path):
            print(f"missing {task}/{name}", flush=True)
            continue
        check_exportable(pd.read_csv(path, dtype=str))
        shutil.copyfile(path, os.path.join(export, f"{task}__{name}"))
        print(f"re-released {task}/{name}", flush=True)
    print("Task finished", flush=True)


if __name__ == "__main__":
    main()
