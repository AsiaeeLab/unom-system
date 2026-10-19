"""Task 60: evaluate the exact portable artifact, including external calibration."""
import json
import numpy as np
import pandas as pd
from scipy.special import expit
import p1_summary_core as core
import p1_workbench as wb
import p1_uncertainty as uncertainty


# Only these two source transitions are permitted; private fingerprints never leave Workbench.
MIGRATION = {'p1_summary_core.py': {'old': 'b0b54b7d03122bc18eb3175a9936bd60c2e9fa8f2777a0ef4d4a65a839bf425e', 'new': 'f21e5ad2efd256bb01c6b40dfea0669d5e2e6ce51e9cda0cef1af55c232a1512'}, 'p1_workbench.py': {'old': '05e8835f18f1dd1897bd099a53070dc200823471cdbb76d73deb64f311f25737', 'new': '4589bfa20c7f8a741006b4cde5ec407001fe886a31f1c6dbc4e94b223931643d'}}
NEW_FINAL_SHA256 = 'e3b4b6bac83c9a21400d62c3bb00767d7b928cba71ad895390e387ce92ed4ee8'


def migrated_state():
    path = wb.OUT/'p1_56_provenance.json'
    original = path.read_bytes()
    saved = json.loads(original)
    current = wb.fingerprint()
    if set(saved) != set(current):
        raise ValueError('Fingerprint inventory changed')
    expected = dict(saved)
    for name, hashes in MIGRATION.items():
        if saved[name] != hashes['old'] or current[name] != hashes['new']:
            raise ValueError('Unapproved core source transition')
        expected[name] = hashes['new']
    if expected != current:
        raise ValueError('Unapproved source or participant input drift')
    cohort, X, y = wb.load()
    roles = pd.read_parquet(wb.OUT/'p1_roles.parquet')
    if not roles.index.equals(cohort.index) or not roles.equals(wb.roles(cohort, y)):
        raise ValueError('Stored cohort/role mismatch')
    if path.read_bytes() != original:
        raise ValueError('Task 56 provenance changed')
    return cohort, X, y, roles


def main():
    if wb.sha(wb.HERE/'p1_final_20261017.json') != '7b85964f168fc4b4f983999f7aa07103135c732894864710bbd354a701583b1b':
        raise ValueError('Frozen final artifact changed')
    if wb.sha(wb.HERE/'p1_final_20261017_v3.json') != NEW_FINAL_SHA256:
        raise ValueError('New final artifact changed')
    _, X, y, roles = migrated_state()
    old_bundle = wb.read_bundle('p1_final_20261017.json')
    bundle = wb.read_bundle('p1_final_20261017_v3.json')
    if bundle['instances'] != old_bundle['instances']:
        raise ValueError('Old/new scoring fields differ')
    score_bundle = wb.read_bundle('p1_scores_20261017.json')
    if (wb.OUT/'p1_57_import.sha256').read_text() != wb.sha(wb.HERE/'p1_scores_20261017.json'):
        raise ValueError('Score import changed since Task 57')
    rows, checks = [], []
    for split in ('patient', 'site'):
        model = bundle['instances'][split]
        for k in ('features', 'weights', 'intercept', 'name'):
            if model[k] != score_bundle['instances'][split][k]: raise ValueError('Frozen score changed')
        test = roles[split].to_numpy() == 'test'; wb.assert_test(y[test])
        s = core.score_frame(model, X.loc[test]); c = model['calibration']
        if c['b'] < 0: raise ValueError('Nonmonotone calibration')
        p = expit(c['a']+c['b']*s)
        ref = [core.reference_score(model, row) for row in X.loc[test].to_dict('records')]
        rs, rp = np.array([a['score'] for a in ref]), np.array([a['probability'] for a in ref])
        if not np.allclose(s, rs, atol=1e-10, rtol=1e-10) or not np.allclose(p, rp, atol=1e-12, rtol=1e-10):
            raise ValueError('Portable scorer parity failed')
        old_model = old_bundle['instances'][split]
        old_s = core.score_frame(old_model, X.loc[test])
        old_p = expit(old_model['calibration']['a'] + old_model['calibration']['b']*old_s)
        if not np.array_equal(s, old_s) or not np.array_equal(p, old_p):
            raise ValueError('Old/new predictions differ')
        prev = pd.read_parquet(wb.OUT/f'p1_{split}_predictions.parquet')
        if not prev.index.equals(X.index):
            raise ValueError('Prediction cohort mismatch')
        if not np.array_equal(prev.y, y) or not np.array_equal(prev.role, roles[split]):
            raise ValueError('Prediction cohort/role mismatch')
        if not np.allclose(s, prev.loc[test, 'D'], rtol=1e-10, atol=1e-10):
            raise ValueError('Task 57 score mismatch')
        perf = uncertainty.final_metrics(y[test], p); perf.insert(0, 'split', split); rows.append(perf)
        checks.append(dict(split=split, artifact_sha256=NEW_FINAL_SHA256,
                           score_max_abs_error=float(np.max(np.abs(s-rs))),
                           probability_max_abs_error=float(np.max(np.abs(p-rp))),
                           frozen_score='verified', calibration=c['method']))
    result = pd.concat(rows, ignore_index=True)
    # Identical CSV serialization proves exact equality of every estimate and interval,
    # as well as metric inventory, scheme, and valid replicate counts (no tolerance).
    if result.to_csv(index=False) != (wb.EXPORT/'59/final_metrics.csv').read_text():
        raise ValueError('Task 59 exact metric/interval equality failed')
    parity = pd.DataFrame(checks)
    old_parity = pd.read_csv(wb.EXPORT/'59/parity.csv', float_precision='round_trip')
    old_parity['artifact_sha256'] = NEW_FINAL_SHA256
    if parity.to_csv(index=False) != old_parity.to_csv(index=False):
        raise ValueError('Task 59 exact parity equality failed')
    wb.export(60, 'final_metrics', result)
    wb.export(60, 'parity', pd.DataFrame(checks))


if __name__ == '__main__':
    from threadpoolctl import threadpool_limits
    with threadpool_limits(limits=1): main()
