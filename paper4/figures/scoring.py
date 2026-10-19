"""Paper 4 Figure 2: one model file applied to one synthetic chart.

A. The synthetic patient's dated FHIR records on the Long COVID model's windows, relative to the COVID-19 index.
B. The model's findings present in that chart, each with its weight (its contribution to the score, in log odds).
C. The calibration map from score to probability, with the risk bands, and the three synthetic patients the model
   scores (the others are not eligible).
Everything is read from the released model file and the test vectors: model/longcovid.json,
model/test_vectors/bundles/maria.json, and model/test_vectors/expected/unm-longcovid-1.2.0/. Same visual language as
the workflow figures of the companion papers. Writes paper4/figures/scoring.{pdf,png}.

Usage: python3 paper4/figures/scoring.py
"""

import datetime as dt
import json
import re
import textwrap
from pathlib import Path

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt  # noqa: E402
from matplotlib.patches import Rectangle  # noqa: E402

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
DARK, GRAY, LIGHT = '#14213D', '#8A949E', '#D5DBE1'
FIT, CAL, TEST, PURPLE = '#2F6FAE', '#D9822B', '#3B8B5A', '#7A5195'
BEFORE, AFTER = '#E9EEF4', '#F7F1E8'
FS = 7.2
PATIENT = 'maria'
# Short names for the chart records (the bundle's display text, shortened for the timeline).
SHORT = {'J45.909': 'asthma', 'U07.1': 'COVID-19', 'R53.83': 'fatigue', 'R00.2': 'palpitations',
         'Z86.16': 'history of COVID-19', 'R41.840': 'attention deficit', 'R06.02': 'shortness of breath',
         'R07.89': 'chest pain', '48065-7': 'D-dimer', '1988-5': 'CRP', '3016-3': 'TSH', '71275': 'chest CT angiography',
         '93306': 'echocardiogram', '93224': 'Holter monitor', '8787': 'propranolol'}
GROUP_COLOR = {'Symptoms after COVID': FIT, 'New symptoms': FIT, 'Coding after COVID': PURPLE,
               'Tests after COVID': CAL, 'Health care use': TEST, 'Acute illness': TEST, 'Prior conditions': GRAY,
               'Demographics': LIGHT}
GROUP_LABEL = [('Symptoms', FIT), ('COVID-19 coded again', PURPLE), ('Tests', CAL), ('Visits', TEST),
               ('History', GRAY), ('Demographics', LIGHT)]
# Shorter display labels for the long feature labels of the model file.
SHORT_LABEL = {'sym_any_w3_count_ge3': '3+ symptom types, days 31–90', 'covid_history_code': 'History of COVID-19 coded',
               'covid_code_w3': 'COVID-19 coded at follow-up', 'out_w3_ge4': '4+ outpatient visits, days 31–90',
               'sym_any_autonomic': 'Palpitations or tachycardia', 'acute_ed': 'Emergency visit, first month',
               'late_visit_61_90': 'Visit in days 61–90', 'visit_rate_up': 'Visit rate doubled after COVID-19',
               'sym_count_ge2': '2+ new symptom types', 'lab_tsh': 'Thyroid (TSH) test',
               'lab_crp': 'C-reactive protein test', 'age_40_49': 'Age 40–49'}


def load():
    model = json.loads((ROOT / 'model/longcovid.json').read_text())
    bundle = json.loads((ROOT / f'model/test_vectors/bundles/{PATIENT}.json').read_text())
    out_dir = ROOT / f'model/test_vectors/expected/{model["model_id"]}-{model["version"]}'
    results = {p.stem: json.loads(p.read_text()) for p in sorted(out_dir.glob('*.json'))}
    return model, bundle, results


def record_date(r):
    d = (r.get('onsetDateTime') or r.get('recordedDate') or r.get('performedDateTime') or r.get('effectiveDateTime')
         or r.get('authoredOn') or (r.get('period') or {}).get('start'))
    return dt.date.fromisoformat(d[:10]) if d else None


def records(bundle, index):
    """(row, day, label) for each dated record; rows: visits, diagnoses, tests, medications."""
    rows = []
    for e in bundle['entry']:
        r = e['resource']
        d = record_date(r)
        if d is None:
            continue
        day = (d - index).days
        t = r['resourceType']
        if t == 'Encounter':
            rows.append(('Visits', day, 'emergency' if r['class']['code'] == 'EMER' else ''))
            continue
        coding = (r.get('code') or r.get('medicationCodeableConcept') or {}).get('coding', [{}])[0]
        label = SHORT.get(coding.get('code'), coding.get('display', ''))
        row = {'Condition': 'Diagnoses', 'Observation': 'Tests', 'Procedure': 'Tests',
               'MedicationRequest': 'Medications'}[t]
        rows.append((row, day, label))
    return rows


def window_of(day, W):
    return next((w for w, (a, b) in W.items() if a <= day <= b), None)


def cell_text(row, items):
    """Text of one row-by-window cell: visits are counted, other records listed by day."""
    if row == 'Visits':
        kinds = [lab or 'outpatient' for _, lab in items]
        if len(items) <= 2:
            return re.sub(r'day -(\d)', r'day −\1', '\n'.join(f'{k} (day {d})' for (d, _), k in zip(items, kinds)))
        return f'{len(items)} outpatient visits\n(days {items[0][0]} to {items[-1][0]})'
    by_day = {}
    for d, lab in items:
        if lab not in by_day.setdefault(d, []):
            by_day[d].append(lab)
    lines = []
    for d in sorted(by_day):
        lines += textwrap.wrap(f'day {d}: ' + ', '.join(by_day[d]), 30, subsequent_indent='   ')
    return re.sub(r'day -(\d)', r'day −\1', '\n'.join(lines))


def panel_chart(ax, model, bundle, result):
    """A proportional strip of the model's windows, then the chart's records in each window."""
    index = dt.date.fromisoformat(result['index_date'])
    as_of = (dt.date.fromisoformat(result['as_of']) - index).days
    W = model['windows']
    h0, h1 = model['target']['horizon_days']
    ax.set_xlim(0, 7.2)
    ax.set_ylim(0, 2.75)
    ax.axis('off')
    # the strip, days -365 to 455 to scale
    x_of = lambda day: 0.95 + (day + 365) / (h1 + 365) * 6.1   # noqa: E731
    y = 2.38
    for w, fc in (('W0', BEFORE), ('W1', BEFORE), ('W2', AFTER), ('W3', AFTER)):
        a, b = W[w]
        ax.add_patch(Rectangle((x_of(a), y - 0.07), x_of(b + 1) - x_of(a), 0.14, fc=fc, ec=DARK, lw=0.6))
    ax.add_patch(Rectangle((x_of(h0), y - 0.07), x_of(h1) - x_of(h0), 0.14, fc='white', ec=CAL, lw=0.7,
                           hatch='////'))
    ax.text((x_of(h0) + x_of(h1)) / 2, y + 0.11, f'outcome: first U09.9 code in days {h0}–{h1}', ha='center',
            va='bottom', fontsize=FS - 1.2, color=DARK)
    ax.text((x_of(W['W0'][0]) + x_of(W['W1'][1])) / 2, y + 0.11, 'the year before COVID-19', ha='center',
            va='bottom', fontsize=FS - 1.2, color=DARK)
    for day, lab, bold, ha in ((0, 'day 0: COVID-19 \ndiagnosis (U07.1) ', True, 'right'), (90, 'day 90', False, 'center'),
                               (as_of, f' scoring date\n (day {as_of})', False, 'left')):
        ax.plot([x_of(day)] * 2, [y - 0.13, y + 0.09], color=DARK, lw=0.9)
        ax.text(x_of(day), y - 0.16, lab, ha=ha, va='top', fontsize=FS - 1.4, color=DARK, linespacing=1.05,
                fontweight='bold' if bold else 'normal')
    # the grid: one column per window, one row per kind of record
    recs = records(bundle, index)
    rows = ['Visits', 'Diagnoses', 'Tests', 'Medications']
    cells = {}
    for row, day, lab in sorted(recs, key=lambda r: r[1]):
        w = window_of(day, W)
        if w:
            cells.setdefault((row, w), []).append((day, lab))
    x0, cw = 0.95, 1.52
    top = 1.88
    for j, w in enumerate(W):
        a, b = W[w]
        ax.add_patch(Rectangle((x0 + j * cw + 0.02, top), cw - 0.04, 0.17, fc=BEFORE if a < 0 else AFTER,
                               ec='none'))
        ax.text(x0 + j * cw + cw / 2, top + 0.085, f'{w}: days {a} to {b}'.replace('-', '−'), ha='center',
                va='center', fontsize=FS - 1.0, fontweight='bold', color=DARK)
    heights = {r: max(1, max((cell_text(r, cells.get((r, w), [])).count('\n') + 1 for w in W), default=1))
               for r in rows}
    line = 0.105
    yy = top - 0.04
    for r in rows:
        hgt = heights[r] * line + 0.06
        ax.text(x0 - 0.08, yy - hgt / 2, r, ha='right', va='center', fontsize=FS - 0.6, color=DARK)
        ax.plot([x0, x0 + 4 * cw], [yy - hgt, yy - hgt], color=LIGHT, lw=0.6)
        for j, w in enumerate(W):
            txt = cell_text(r, cells.get((r, w), []))
            ax.text(x0 + j * cw + 0.08, yy - 0.03, txt if txt else '–', ha='left', va='top', fontsize=FS - 1.5,
                    color=DARK if txt else GRAY, linespacing=1.12)
        yy -= hgt
    for j in range(5):
        ax.plot([x0 + j * cw] * 2, [yy, top], color=LIGHT, lw=0.6)


def panel_weights(ax, result, intercept):
    drivers = sorted(result['drivers'], key=lambda d: d['contribution'])
    y = range(len(drivers))
    ax.barh(y, [d['contribution'] for d in drivers], color=[GROUP_COLOR[d['group']] for d in drivers], height=0.72)
    ax.set_yticks(y, [SHORT_LABEL.get(d['id'], d['label']).replace(' (coded by day 90)', '') for d in drivers],
                  fontsize=FS - 1.4)
    ax.axvline(0, color=DARK, lw=0.6)
    ax.set_xlabel('Weight (log odds)', fontsize=FS - 0.4)
    ax.tick_params(axis='x', labelsize=FS - 1)
    total = sum(d['contribution'] for d in drivers)
    ax.text(0.98, 0.03, f'sum of {len(drivers)} weights: {total:.2f}\nintercept: {intercept:.2f}\n'
            f'score: {result["score"]:.2f}'.replace('-', '−'), transform=ax.transAxes, ha='right', va='bottom',
            fontsize=FS - 1.0, color=DARK, linespacing=1.3, bbox=dict(fc='white', ec=LIGHT, pad=2.5))
    handles = [Rectangle((0, 0), 1, 1, fc=c) for _, c in GROUP_LABEL]
    ax.legend(handles, [g for g, _ in GROUP_LABEL], fontsize=FS - 1.4, loc='lower right', frameon=False,
              bbox_to_anchor=(1.02, 0.17), handlelength=1.0, handleheight=0.8, labelspacing=0.3)
    for s in ('top', 'right'):
        ax.spines[s].set_visible(False)


def panel_calibration(ax, model, results):
    pts = model['calibration']['points']
    xs, ps = [p[0] for p in pts], [100 * p[1] for p in pts]
    base = 100 * model['reference']['cohort_base_rate']
    bands = {b['name']: 100 * b['max_probability'] for b in model['risk_bands']}
    x0, x1 = xs[0] - 0.5, max(xs[-1], max(r['score'] for r in results.values() if 'score' in r)) + 0.8
    top = ps[-1] * 1.18
    for lo_p, hi_p, name, fc in ((0, bands['Typical'], 'Typical', '#F3F5F7'),
                                 (bands['Typical'], bands['Elevated'], 'Elevated', '#FBEBD9'),
                                 (bands['Elevated'], top, 'High', '#F5D2B0')):
        ax.add_patch(Rectangle((x0, lo_p), x1 - x0, hi_p - lo_p, fc=fc, ec='none', zorder=0))
        ax.text(x0 + 0.3, (lo_p + hi_p) / 2 if name != 'High' else hi_p - 0.35, name, fontsize=FS - 1.0,
                color=DARK, va='center', ha='left', fontweight='bold')
    ax.plot(xs + [x1], ps + [ps[-1]], color=DARK, lw=1.1, zorder=2)
    ax.axhline(base, color=DARK, lw=0.7, ls=(0, (3, 2)))
    ax.text(x1 - 0.2, base + 0.12, f'average {base:.2f}%', fontsize=FS - 1.4, ha='right', va='bottom', color=DARK)
    for name, r in results.items():
        if r.get('status') != 'scored':
            continue
        main = name == PATIENT
        ax.scatter([r['score']], [100 * r['probability']], s=34 if main else 18, color=CAL if main else GRAY,
                   ec=DARK, lw=0.6, zorder=4)
        if main:
            ax.annotate(f'{100 * r["probability"]:.1f}%, {r["times_average"]:.1f} times\nthe average: '
                        f'{r["band"]}', (r['score'], 100 * r['probability']), xytext=(r['score'] - 9.3,
                                                                                   100 * r['probability'] - 0.4),
                        fontsize=FS - 1.0, color=DARK, va='top', linespacing=1.15,
                        arrowprops=dict(arrowstyle='-', color=DARK, lw=0.6))
    n_other = sum(1 for k, r in results.items() if r.get('status') == 'scored' and k != PATIENT)
    n_not = sum(1 for r in results.values() if r.get('status') != 'scored')
    ax.text(-7.2, 0.06, f'{n_other} other patients scored, {n_not} not eligible', fontsize=FS - 1.6,
            color=DARK, va='bottom', ha='left')
    ax.set_xlim(x0, x1)
    ax.set_ylim(0, top)
    ax.set_xlabel('Score', fontsize=FS - 0.4)
    ax.set_ylabel('Probability of a later U09.9 code (%)', fontsize=FS - 0.4)
    ax.tick_params(labelsize=FS - 1)
    for s in ('top', 'right'):
        ax.spines[s].set_visible(False)


def main(out=HERE):
    plt.rcParams.update({'font.family': 'DejaVu Sans', 'mathtext.fontset': 'dejavusans',
                         'pdf.fonttype': 42, 'ps.fonttype': 42})
    model, bundle, results = load()
    result = results[PATIENT]
    fig = plt.figure(figsize=(7.2, 6.6))
    a = fig.add_axes([0, 0.555, 1, 0.405])
    b = fig.add_axes([0.255, 0.07, 0.31, 0.415])
    c = fig.add_axes([0.685, 0.07, 0.295, 0.415])
    panel_chart(a, model, bundle, result)
    panel_weights(b, result, model['intercept'])
    panel_calibration(c, model, results)
    for x, y, letter, title in ((0.015, 0.975, 'A.', 'Synthetic Chart in the Model Windows'),
                                (0.015, 0.515, 'B.', 'Findings and Their Weights'),
                                (0.6, 0.515, 'C.', 'Calibration Map and Risk Bands')):
        fig.text(x, y, letter, fontsize=FS + 2, fontweight='bold', color=DARK, va='center')
        fig.text(x + 0.035, y, title, fontsize=FS + 0.6, fontweight='bold', color=DARK, va='center')
    for ext, kw in (('pdf', {}), ('png', {'dpi': 300})):
        fig.savefig(Path(out) / f'scoring.{ext}', **kw)
    plt.close(fig)


if __name__ == '__main__':
    main()
