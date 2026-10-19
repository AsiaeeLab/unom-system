"""Private Workbench I/O for Tasks 56–58. Never import in public scoring."""
from pathlib import Path
import hashlib
import json
import numpy as np
import pandas as pd
from aou_safe import check_exportable, protect
from unm_run import validate
import p1_summary_core as core

HERE = Path(__file__).resolve().parent
OUT = Path.home() / 'unm/output'
EXPORT = Path.home() / 'unm/export'
INPUTS = ('cohort_v2.parquet', 'features_v3.parquet', 't04_split.parquet', 't16_split.parquet')
SOURCES = ('p1_summary_core.py', 'p1_workbench.py', 't41_export_price.py', 't02_features.py',
           't12_features_extra.py', 't35_p1_rerun.py', 'features.json', 'features.yaml', 't04_moments.py', 'aou_safe.py')


def sha(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for block in iter(lambda: f.read(1024*1024), b''): h.update(block)
    return h.hexdigest()


def fingerprint():
    # Participant-file fingerprints stay private in output, never in releases.
    return {**{n: sha(OUT/n) for n in INPUTS}, **{n: sha(HERE/n) for n in SOURCES}}


def load():
    cohort = pd.read_parquet(OUT/'cohort_v2.parquet')
    cohort = cohort.loc[cohort.landmark_eligible == 1].copy()
    if not cohort.index.is_unique: raise ValueError('Cohort index is not unique')
    cohort['index_date'] = pd.to_datetime(cohort.index_date)
    X = core.binary_features(pd.read_parquet(OUT/'features_v3.parquet').loc[cohort.index])
    if X.shape[1] != 102: raise ValueError('Expected corrected 102 binary features')
    y = cohort.s.to_numpy(dtype=int)
    if not np.isin(y, [0, 1]).all(): raise ValueError('Nonbinary outcome')
    return cohort, X, y


def roles(cohort, y):
    old = pd.read_parquet(OUT/'t04_split.parquet').loc[cohort.index, 'train'].to_numpy()
    site = pd.read_parquet(OUT/'t16_split.parquet').loc[cohort.index, 'role'].to_numpy()
    if set(site) != {'fit', 'calibration', 'test'}: raise ValueError('Unexpected site roles')
    if set(cohort.loc[site == 'test', 'site']) & set(cohort.loc[site != 'test', 'site']):
        raise ValueError('Site split overlaps sites')
    return pd.DataFrame({'patient': core.patient_roles(old, y), 'site': site}, index=cohort.index)


def state():
    cohort, X, y = load()
    meta = json.loads((OUT/'p1_56_provenance.json').read_text())
    if meta != fingerprint(): raise ValueError('Source or input drift since Task 56')
    r = pd.read_parquet(OUT/'p1_roles.parquet').loc[cohort.index]
    if not r.equals(roles(cohort, y)): raise ValueError('Stored role mismatch')
    return cohort, X, y, r


def export(task, name, df):
    check_exportable(df)
    # Validate the CSV-inferred types exactly as the runner will.
    import io
    validate(pd.read_csv(io.StringIO(df.to_csv(index=False))))
    directory = EXPORT/str(task); directory.mkdir(parents=True, exist_ok=True)
    df.to_csv(directory/(name+'.csv'), index=False)


def role_counts(r, y):
    rows = []
    for split in r:
        for role in ('fit', 'calibration', 'test'):
            m = r[split].to_numpy() == role
            rows.append(dict(split=split, role=role, n=int(m.sum()), n_pos=int(y[m].sum())))
    return protect(pd.DataFrame(rows), ['n', 'n_pos'], complements=[('n', 'n_pos')])


def assert_test(y):
    if min(int(y.sum()), int((1-y).sum())) <= 0:
        raise ValueError('Both test classes required for AUROC')


def read_bundle(name):
    bundle = json.loads((HERE/name).read_text())
    if set(bundle['instances']) != {'patient', 'site'}: raise ValueError('Missing model instance')
    return bundle
