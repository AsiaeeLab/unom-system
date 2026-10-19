"""Rebuild the deployed models, Table 1, the atlas data, and every generated file from the released aggregate files,
and rerun the technical evaluation's automated checks (Table 2).

Usage, from the repository root:
    python3 reproduce.py        # build into outputs/, compare with the repository, run the test suites

Steps
 1. Refit the nine model files from the released counts: the eight self-report models with
    analysis/build_cf_model.py and the Long COVID model with analysis/build_longcovid_model.py. Each refit must equal
    model/<name>.json and the site's copy in web/web/models/ byte for byte.
 2. Write Table 1 with paper4/tables_p4.py and compare it with paper4/tables/models.tex, and draw Figure 2 with
    paper4/figures/scoring.py and compare it with paper4/figures/scoring.pdf (apart from the creation date).
 3. Rebuild the atlas data with analysis/build_atlas_data.py and compare it with web/web/atlas/data/.
 4. In a copy of the repository (outputs/tree), rerun every generator that writes in place: the synthetic test
    patients and each model version's reference outputs (model/test_vectors/make_bundles.py), the site's model and
    patient copies (web/tools/sync_models.sh), and the models guide and developer pages
    (analysis/build_models_guide.py). No file of the copy may change.
 5. Run the Python reference tests, the sandbox uploader's tests, the interface page check
    (analysis/build_clinician_interface.py --check), and the JavaScript suite (node --test in web/), and compare the
    counts with Table 2 of the manuscript.
"""

from __future__ import annotations

import filecmp
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
OUTPUTS = ROOT / 'outputs'
SELF_REPORT = ['chronicfatigue', 'fibromyalgia', 'endometriosis', 'lyme', 'lupus', 'migraine', 'depression',
               'anxiety']
CURRENT = ['longcovid'] + SELF_REPORT + ['longcovid.example']
# Table 2 of the manuscript: the JavaScript suite and the cross-implementation parity check.
TABLE2 = {'tests': 453, 'pass': 437, 'skipped': 16, 'fail': 0, 'reference outputs': 180}
ROWS: list[tuple[str, bool]] = []


def run(cmd, cwd=ROOT, log=None, check=True):
    proc = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True)
    if log:
        log.parent.mkdir(parents=True, exist_ok=True)
        log.write_text(proc.stdout + proc.stderr)
    if check and proc.returncode:
        raise SystemExit(f'{" ".join(map(str, cmd))} failed:\n{proc.stdout[-3000:]}{proc.stderr[-3000:]}')
    return proc


def record(what: str, ok: bool):
    ROWS.append((what, ok))
    print(f"{'reproduced' if ok else 'DIFFERS   '}  {what}")


def same(a: Path, b: Path) -> bool:
    return a.is_file() and b.is_file() and a.read_bytes() == b.read_bytes()


def models(out: Path):
    for name in SELF_REPORT:
        dst = out / f'models/{name}.json'
        dst.parent.mkdir(parents=True, exist_ok=True)
        run([sys.executable, 'analysis/build_cf_model.py', '--condition', name, '--out', str(dst)])
        record(f'model/{name}.json', same(dst, ROOT / f'model/{name}.json')
               and same(dst, ROOT / f'web/web/models/{name}.json'))
    sys.path[:0] = [str(ROOT / 'analysis'), str(ROOT / 'model')]
    import build_longcovid_model
    lc = out / 'longcovid'
    build_longcovid_model.build(str(lc))
    for rel in build_longcovid_model.OUTPUTS:
        ok = same(lc / rel, ROOT / rel)
        if rel == 'model/longcovid.json':
            ok = ok and same(lc / rel, ROOT / 'web/web/models/longcovid.json')
        record(rel, ok)


def table1(out: Path):
    dst = out / 'paper4/tables/models.tex'
    run([sys.executable, 'paper4/tables_p4.py', '--out', str(dst)])
    record('paper4/tables/models.tex (Table 1)', same(dst, ROOT / 'paper4/tables/models.tex'))
    figs = out / 'paper4/figures'
    figs.mkdir(parents=True, exist_ok=True)
    run([sys.executable, '-c', 'import sys; sys.path.insert(0, "paper4/figures"); import scoring; '
         f'scoring.main({str(figs)!r})'])
    a, b = (figs / 'scoring.pdf').read_bytes(), (ROOT / 'paper4/figures/scoring.pdf').read_bytes()
    strip = lambda t: re.sub(rb'/CreationDate \(D:[^)]*\)', b'', t)   # noqa: E731
    record('paper4/figures/scoring.pdf (Figure 2)', strip(a) == strip(b))


def atlas(out: Path):
    dst = out / 'atlas'
    run([sys.executable, 'analysis/build_atlas_data.py', '--out', str(dst), '--quiet'])
    shipped = ROOT / 'web/web/atlas/data'
    names = sorted({p.name for p in dst.glob('*.json')} | {p.name for p in shipped.glob('*.json')})
    for n in names:
        record(f'web/web/atlas/data/{n}', same(dst / n, shipped / n))


def generators(out: Path):
    tree = out / 'tree'
    shutil.copytree(ROOT, tree, ignore=shutil.ignore_patterns('.git', 'outputs', 'node_modules', '__pycache__'))
    for m in CURRENT:
        run([sys.executable, 'model/test_vectors/make_bundles.py', f'model/{m}.json'], cwd=tree)
    run(['bash', 'web/tools/sync_models.sh'], cwd=tree)
    run([sys.executable, 'analysis/build_models_guide.py'], cwd=tree)
    changed, cmp_dirs = [], [filecmp.dircmp(ROOT, tree, ignore=['.git', 'outputs', 'node_modules', '__pycache__'])]
    while cmp_dirs:
        c = cmp_dirs.pop()
        base = Path(c.left).relative_to(ROOT)
        changed += [str(base / f) for f in c.left_only + c.right_only]
        _, mismatch, errors = filecmp.cmpfiles(c.left, c.right, c.common_files, shallow=False)
        changed += [str(base / f) for f in mismatch + errors]
        cmp_dirs += list(c.subdirs.values())
    for rel in sorted(changed):
        record(f'{rel} (changed by a generator)', False)
    n = sum(1 for p in tree.rglob('*') if p.is_file())
    record(f'all {n} files unchanged after rerunning make_bundles.py, sync_models.sh, and build_models_guide.py',
           not changed)
    return tree


def reference_outputs() -> int:
    """Reference outputs of the model versions shipped in model/ (one per synthetic patient and version)."""
    import json
    ids = {f"{d['model_id']}-{d['version']}" for d in (json.loads(p.read_text()) for p in ROOT.glob('model/*.json'))}
    return sum(len(list((ROOT / 'model/test_vectors/expected' / i).glob('*.json'))) for i in ids)


def tests(out: Path) -> dict:
    logs = out / 'logs'
    py = run([sys.executable, 'model/reference/test_score_fhir.py'], log=logs / 'test_score_fhir.txt', check=False)
    record('Python reference tests (model/reference/test_score_fhir.py)', py.returncode == 0)
    up = run([sys.executable, 'test_upload_sandbox.py'], cwd=ROOT / 'model/test_vectors',
             log=logs / 'test_upload_sandbox.txt', check=False)
    record('sandbox uploader tests (model/test_vectors/test_upload_sandbox.py)', up.returncode == 0)
    doc = run([sys.executable, 'analysis/build_clinician_interface.py', '--check'], log=logs / 'interface.txt',
              check=False)
    record('docs/CLINICIAN_INTERFACE.md matches its sources', doc.returncode == 0)
    js = run(['node', '--test', '--test-reporter=tap', *sorted(str(p.relative_to(ROOT / 'web'))
                                                               for p in (ROOT / 'web/test').glob('*.test.js'))],
             cwd=ROOT / 'web', log=logs / 'node_test.txt', check=False)
    counts = {k: int(v) for k, v in re.findall(r'^# (tests|pass|fail|skipped) (\d+)$', js.stdout, re.M)}
    counts['reference outputs'] = reference_outputs()
    for k, v in TABLE2.items():
        record(f'Table 2: {k} = {counts.get(k)} (manuscript: {v})', counts.get(k) == v)
    return counts


def main() -> int:
    if OUTPUTS.exists():
        shutil.rmtree(OUTPUTS)
    OUTPUTS.mkdir()
    print('1. models from the released counts')
    models(OUTPUTS)
    print('2. Table 1 and Figure 2')
    table1(OUTPUTS)
    print('3. atlas data')
    atlas(OUTPUTS)
    print('4. generators that write in place, run in a copy')
    generators(OUTPUTS)
    print('5. test suites')
    tests(OUTPUTS)
    bad = [w for w, ok in ROWS if not ok]
    print(f'{len(ROWS) - len(bad)} of {len(ROWS)} checks passed' + (''.join(f'\n  failed: {w}' for w in bad)))
    return 0 if not bad else 1


if __name__ == '__main__':
    os.chdir(ROOT)
    sys.exit(main())
