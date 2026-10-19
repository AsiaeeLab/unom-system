"""Task 43: re-release the Task 39 endometriosis drug code list (vocabulary only; large, so on its own).

Runs inside the All of Us Workbench (bash ~/unm/bin/unm.sh run 43). Same mechanism as Task 42.
"""

from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import t42_t39_rerelease as t42  # noqa: E402

if __name__ == "__main__":
    t42.main(files=["t39_endometriosis_codelist_drugs.csv"], export=os.path.expanduser("~/unm/export/43"))
