"""Shared numerical definitions for the frozen Paper 1 comparison (Tasks 56–58).
No I/O or participant exports. Exact and released fits share estimator code.
"""
from __future__ import annotations
import math
import numpy as np
import pandas as pd
from scipy.optimize import minimize, brentq
from scipy.special import expit, logit
from sklearn.metrics import roc_auc_score, average_precision_score
from sklearn.model_selection import StratifiedKFold, train_test_split
from aou_safe import protect
from t04_moments import summary_tables

SEED = 20261017
EN_SEED = 20260928
N_BOOT = 500
CANDIDATES = ('nb_eb', 'lda_eb_0.1', 'lda_eb_0.3', 'lda_eb_0.6')
CELLS = ['n_x1_s1', 'n_x1_s0', 'n_x0_s1', 'n_x0_s0']
KINDS = ('label_counts', 'feature_label_counts', 'feature_margins', 'pair_counts')


def binary_features(F):
    X = F.loc[:, [c for c in F if not c.startswith('yout_')]].astype(float)
    if X.columns.duplicated().any() or not np.isin(X.to_numpy(), [0, 1]).all():
        raise ValueError('Expected unique binary features without missing values')
    return X


def patient_roles(train, y):
    train = np.asarray(train)
    if train.dtype != bool:
        raise ValueError('Stored patient split must be boolean')
    ids = np.flatnonzero(train)
    fit, cal = train_test_split(ids, test_size=.30, stratify=np.asarray(y)[ids], random_state=SEED)
    r = np.full(len(y), 'test', dtype=object)
    r[fit], r[cal] = 'fit', 'calibration'
    return r


def release_tables(X, y):
    # t04 all-four-cells >20 eligibility; int64 avoids binary matmul overflow.
    tables, keep = summary_tables(X.astype('int64'), np.asarray(y, dtype='int64'))
    tables = {k.replace('t04_', ''): v for k, v in tables.items()}
    lab = protect(pd.DataFrame([{'n': len(y), 'n_pos': int(np.sum(y))}]),
                  ['n', 'n_pos'], complements=[('n', 'n_pos')])
    tables['label_counts'] = pd.DataFrame({'measure': ['n_train', 'n_train_s1'],
                                          'value': [lab.n.iloc[0], lab.n_pos.iloc[0]]})
    return tables, keep


def unround(v):
    a = pd.to_numeric(v, errors='coerce').astype(float)
    return np.where(a > 0, a - 4.5, a)


def exact_moments(X, y):
    x, y = X.to_numpy(float), np.asarray(y, dtype=int)
    n, n1 = len(y), float(y.sum())
    if not 0 < n1 < n:
        raise ValueError('Both fitting classes required')
    a, b = x[y == 1].sum(0), x[y == 0].sum(0)
    return dict(features=list(X), n=float(n), n1=n1,
                cells=np.column_stack([a, b, n1-a, n-n1-b]),
                mean=x.mean(0), second=x.T @ x / n, fallback_pairs=0)


def released_moments(t):
    lab = t['label_counts'].set_index('measure').value
    n, n1 = unround(lab.loc[['n_train', 'n_train_s1']])
    if not np.isfinite([n, n1]).all() or not 0 < n1 < n:
        raise ValueError('Fitting label counts unavailable')
    fl = t['feature_label_counts']
    fl = fl[fl.eligible.astype(str).str.lower() == 'true'].copy()
    feats = fl.feature.tolist()
    cells = np.column_stack([unround(fl[c]) for c in CELLS])
    m = unround(t['feature_margins'].set_index('feature').loc[feats, 'n_x1']) / n
    second = np.outer(m, m)
    np.fill_diagonal(second, m)
    positions = {f: i for i, f in enumerate(feats)}
    fallback = 0
    pairs = t['pair_counts']
    if len(pairs) != len(feats)*(len(feats)-1)//2:
        raise ValueError('Incomplete pair inventory')
    seen = set()
    for row, val in zip(pairs.itertuples(), unround(pairs.n_both)):
        i, j = positions[row.feature_a], positions[row.feature_b]
        key = tuple(sorted((i, j)))
        if i == j or key in seen:
            raise ValueError('Duplicate/diagonal pair')
        seen.add(key)
        if np.isfinite(val): second[i, j] = second[j, i] = val / n
        else: fallback += 1
    if not np.isfinite(cells).all() or not np.isfinite(m).all():
        raise ValueError('Eligible feature count unavailable')
    return dict(features=feats, n=n, n1=n1, cells=cells, mean=m,
                second=second, fallback_pairs=fallback)


def eb(est, se2):
    tau = max(0., float(np.mean(est**2) - np.mean(se2))) if len(est) else 0.
    return np.divide(est*tau, tau+se2, out=np.zeros_like(est), where=(tau+se2)>0), tau


def fit_moments(m, candidate):
    if candidate not in CANDIDATES: raise ValueError('Unapproved candidate')
    cells, mean = np.asarray(m['cells']), np.asarray(m['mean'])
    pi = m['n1']/m['n']; prior = float(logit(pi))
    # Constant columns retained in the feature contract with zero coefficients.
    ix = np.flatnonzero((mean > 0) & (mean < 1))
    w = np.zeros(len(mean)); ridge, tau = 0., 0.; intercept = prior
    if len(ix):
        c = cells[ix].copy()
        # Zero cells only -> 0.5 for NB. LDA moments remain exact.
        stable = np.where(c == 0, .5, c)
        p1 = c[:, 0]/(c[:, 0]+c[:, 2]); p0 = c[:, 1]/(c[:, 1]+c[:, 3])
        if candidate == 'nb_eb':
            est = np.log(stable[:, 0])+np.log(stable[:, 3])-np.log(stable[:, 1])-np.log(stable[:, 2])
            w[ix], tau = eb(est, np.sum(1/stable, axis=1))
            intercept = prior - w @ mean
        else:
            d = p1-p0
            sigma = m['second'][np.ix_(ix, ix)] - np.outer(mean[ix], mean[ix]) - pi*(1-pi)*np.outer(d, d)
            sd2 = np.maximum(np.diag(sigma), 1e-9)
            se2 = p1*(1-p1)/m['n1'] + p0*(1-p0)/(m['n']-m['n1'])
            delta, tau = eb(d/np.sqrt(sd2), se2/sd2)
            lam = float(candidate.rsplit('_', 1)[1])
            S = (1-lam)*sigma + lam*np.diag(np.diag(sigma))
            # Identical spectral floor in C/D; rounded moments can be indefinite.
            floor = max(1e-9, 1e-8*float(np.max(sd2)))
            ridge = max(0., floor-float(np.linalg.eigvalsh(S).min()))
            w[ix] = np.linalg.solve(S + ridge*np.eye(len(ix)), delta*np.sqrt(sd2))
            intercept = prior - .5*float(w[ix] @ (p1+p0))
    return dict(name=candidate, features=m['features'], weights=w.tolist(), intercept=float(intercept),
                numerical_ridge=float(ridge), tau2=float(tau), fallback_pairs=int(m['fallback_pairs']))


def score_frame(model, X):
    return X.loc[:, model['features']].to_numpy(float) @ np.array(model['weights']) + model['intercept']


def reference_score(model, features):
    """Feature-dictionary scorer. Missing/nonbinary features are errors."""
    xs = [features[f] for f in model['features']]
    if not all(x in (0, 1) for x in xs):
        raise ValueError('Explicit binary values required for every fitted feature')
    score = model['intercept'] + math.fsum(w*x for w, x in zip(model['weights'], xs))
    cal = model.get('calibration')
    if cal is None: return {'score': score}
    z = cal['a'] + cal['b']*score
    p = 1/(1+math.exp(-z)) if z >= 0 else math.exp(z)/(1+math.exp(z))
    return {'score': score, 'probability': p}


def discrimination(y, score):
    return np.array([roc_auc_score(y, score), average_precision_score(y, score)])


def inner_cv(X, y):
    rows = []
    for fold, (tr, va) in zip(('fold_a', 'fold_b', 'fold_c'),
                              StratifiedKFold(3, shuffle=True, random_state=SEED).split(X, y)):
        tables, _ = release_tables(X.iloc[tr], y[tr]); moments = released_moments(tables)
        if min(np.sum(y[va]), np.sum(1-y[va])) <= 0:
            raise ValueError('Both inner validation classes required for AUROC')
        for candidate in CANDIDATES:
            model = fit_moments(moments, candidate)
            auc, ap = discrimination(y[va], score_frame(model, X.iloc[va]))
            rows.append(dict(fold=fold, candidate=candidate, AUROC=float(auc), AUPRC=float(ap)))
    return pd.DataFrame(rows)


def select_candidate(cv):
    expected = {(f, c) for f in ('fold_a', 'fold_b', 'fold_c') for c in CANDIDATES}
    if len(cv) != 12 or set(zip(cv.fold, cv.candidate)) != expected:
        raise ValueError('Incomplete candidate/fold metrics')
    if not np.isfinite(cv[['AUROC', 'AUPRC']].to_numpy(float)).all():
        raise ValueError('Unavailable CV metrics')
    means = cv.groupby('candidate').AUROC.mean()
    return max(CANDIDATES, key=lambda c: means[c])


def bootstrap_indices(y, count=N_BOOT, seed=SEED):
    rng = np.random.default_rng(seed)
    pos, neg = np.flatnonzero(y == 1), np.flatnonzero(y == 0)
    for _ in range(count):
        yield np.concatenate([rng.choice(pos, len(pos)), rng.choice(neg, len(neg))])


def paired_metrics(y, scores, n_boot=N_BOOT):
    names = list(scores)
    point = np.array([discrimination(y, scores[k]) for k in names])
    boot = np.array([[discrimination(y[ix], scores[k][ix]) for k in names]
                     for ix in bootstrap_indices(y, n_boot)])
    rows = []
    comparisons = [(k, None) for k in names]
    comparisons += [('C_full', 'D'), ('C_keep', 'D'), ('B', 'D'), ('A', 'B'),
                    ('B', 'C_full'), ('C_full', 'C_keep')]
    for a, b in comparisons:
        j = names.index(a); value, samples = point[j], boot[:, j]
        if b is not None:
            k = names.index(b); value, samples = value-point[k], samples-boot[:, k]
        for metric, v, bs in zip(('AUROC', 'AUPRC'), value, samples.T):
            lo, hi = np.quantile(bs, [.025, .975])
            rows.append(dict(comparison=a if b is None else a+' minus '+b,
                             metric=metric, estimate=float(v), lower=float(lo), upper=float(hi)))
    return pd.DataFrame(rows)


def calibration_bins(score, y):
    # Same sorted merging strategy as t05.calib_bins, minimum 21/class.
    order = np.argsort(score, kind='stable'); bins, cur, pos = [], [], 0
    for i in order:
        cur.append(i); pos += int(y[i])
        if pos >= 21 and len(cur)-pos >= 21 and len(cur) >= len(y)/12:
            bins.append(cur); cur, pos = [], 0
    if cur:
        if bins: bins[-1] += cur
        else: bins.append(cur)
    raw = pd.DataFrame([dict(bin=f'bin_{i+1}', score_mean=round(float(np.mean(score[b])), 4),
                             n=len(b), n_pos=int(np.sum(y[b]))) for i, b in enumerate(bins)])
    out = protect(raw, ['n', 'n_pos'], complements=[('n', 'n_pos')])
    bad = (raw.n_pos < 21) | ((raw.n-raw.n_pos) < 21)
    out.loc[bad, 'score_mean'] = np.nan
    return out


def fit_calibration(bins, fallback_prior):
    n, k = unround(bins.n), unround(bins.n_pos)
    x = pd.to_numeric(bins.score_mean, errors='coerce').to_numpy(float)
    ok = np.isfinite(n+k+x) & (k > 0) & (n > k)
    n, k, x = n[ok], k[ok], x[ok]
    prior = float(k.sum()/n.sum()) if len(n) else fallback_prior
    fallback = dict(a=float(logit(prior)), b=0., method='intercept_only',
                    informative_bins=int(len(n)), reason='fewer than two distinct informative bins')
    if len(n) < 2 or np.ptp(x) < 1e-10: return fallback
    center, scale = float(np.mean(x)), float(np.std(x)); z = (x-center)/scale
    design = np.column_stack([np.ones(len(z)), z])
    def objective(beta):
        eta = design @ beta
        return np.sum(n*np.logaddexp(0, eta)-k*eta), design.T @ (n*expit(eta)-k)
    fit = minimize(objective, [logit(prior), 0.], jac=True, method='L-BFGS-B',
                   bounds=[(None, None), (0., None)], options={'ftol': 1e-14, 'gtol': 1e-8, 'maxiter': 1000})
    b = float(fit.x[1]/scale)
    if not fit.success or not np.isfinite(fit.x).all() or b <= 1e-8 or b > 1e6:
        fallback['reason'] = 'degenerate/nonpositive slope or optimizer failure'; return fallback
    return dict(a=float(fit.x[0]-b*center), b=b, method='monotone_grouped_logistic',
                informative_bins=int(len(n)), reason='bin means and counts minus 4.5 approximation')


def calibration_diagnostics(y, p):
    lp = logit(np.clip(p, 1e-15, 1-1e-15))
    citl = brentq(lambda a: np.mean(expit(lp+a))-np.mean(y), -100, 100)
    slope = np.nan
    if np.std(lp) > 1e-10:
        z = (lp-lp.mean())/lp.std(); design = np.column_stack([np.ones(len(y)), z])
        def obj(beta):
            eta = design @ beta
            return np.mean(np.logaddexp(0, eta)-y*eta), design.T @ (expit(eta)-y)/len(y)
        fit = minimize(obj, [logit(np.mean(y)), 0.], jac=True, method='BFGS', options={'gtol': 1e-8})
        q = expit(design @ fit.x)
        info = design.T @ ((q*(1-q))[:, None]*design)/len(y)
        if fit.success and np.isfinite(fit.x).all() and np.linalg.eigvalsh(info).min() > 1e-10:
            slope = float(fit.x[1]/lp.std())
    return np.array([citl, slope, np.mean((p-y)**2), *discrimination(y, p)])


def final_metrics(y, p, n_boot=N_BOOT):
    point = calibration_diagnostics(y, p)
    boot = np.array([calibration_diagnostics(y[ix], p[ix]) for ix in bootstrap_indices(y, n_boot)])
    rows = []
    for j, metric in enumerate(('calibration_intercept_in_large', 'calibration_slope', 'Brier', 'AUROC', 'AUPRC')):
        valid = np.isfinite(boot[:, j])
        lo, hi = np.quantile(boot[:, j], [.025, .975]) if valid.all() else (np.nan, np.nan)
        rows.append(dict(metric=metric, estimate=float(point[j]), lower=float(lo), upper=float(hi),
                         uncertainty='available' if valid.all() else 'unavailable: unidentifiable bootstrap fit',
                         valid_resamples=f'{valid.sum()} resamples'))
    return pd.DataFrame(rows)
