"""Task 36 (Paper 1): evaluate the exportable models fit from Task 35's summary counts.

Runs inside the All of Us Workbench (bash ~/unm/bin/unm.sh run 36). Reruns Task 05 (random-split validation of
the candidates in transport_candidates_v3.json) and Task 17 (frozen pipeline at the held-out sites, candidate
transport_site_candidate_v3.json) on features_v3.parquet, using the Task 04 split and Task 16 roles that
Task 35 drew with Tasks 04 and 16's original seeds. Exports: ~/unm/export/36/ (the usual Task 05 and Task 17 files).
"""

from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import t05_transport_eval as t05  # noqa: E402
import t17_site_eval as t17  # noqa: E402

EXPORT = os.path.expanduser("~/unm/export/36")


def main():
    t05.FEATURES, t05.CANDIDATES, t05.EXPORT = "features_v3.parquet", "transport_candidates_v3.json", EXPORT
    t17.FEATURES, t17.CANDIDATES, t17.EXPORT = "features_v3.parquet", "transport_site_candidate_v3.json", EXPORT
    t05.main()
    t17.main()
    print("Task 36 finished", flush=True)


if __name__ == "__main__":
    main()
