# Undiagnosed No More: case-finding models from All of Us, delivered to patients and clinicians

Source code, model files, and released aggregate statistics for the manuscript "Design and Technical Evaluation of a
Standards-Based System That Delivers Enclave-Derived Case-Finding Models to Patients and Clinicians" by Amir Asiaee
and Kaveh Aryan.

Case-finding models for often-uncoded conditions (Long COVID, chronic fatigue, fibromyalgia, endometriosis, Lyme
disease, lupus, migraine, depression, and anxiety) were fitted outside the All of Us Researcher Workbench from
released, disclosure-protected summary counts. Each model is a versioned JSON file with a written contract, a Python
reference implementation, and synthetic FHIR R4 test patients with their expected outputs. One JavaScript scorer
runs every model file in a patient demonstration, a SMART on FHIR clinician application, and a CDS Hooks service. An
atlas shows coding gaps from the same studies' aggregate releases, and developer pages document each integration
path. A live demonstration with synthetic patients is at https://undiagnosednomore.org.

## What this repository contains

Participant-level data stay in the Workbench and are not here.

- `web/`: the system as deployed. `web/web/` is the static site (patient demonstration in `patient/`, clinician
  demonstration in `clinician/`, SMART on FHIR application and launch routes in `athena/`, `smart/`, and `epic/`,
  atlas in `atlas/`, developer pages in `developers/`, the served model files in `models/`, the shared scorer
  `shared/scorer.js`), `web/functions/` is the CDS Hooks service, `web/test/` is the test suite, and `web/tools/`
  holds the SMART sandbox comparison and the walkthrough recorder. `web/README.md` describes local use, the sandbox
  patients, and the CDS Hooks service's trust model.
- `model/`: the nine model files and the placeholder used during development (`*.json`), the Python reference
  scorer and its tests (`model/reference/`), and the 18 synthetic patients with the reference output of every model
  version (`model/test_vectors/`).
- `docs/`: the model contract (`docs/interface/model_spec.md`), the models guide, and the clinician interface page.
  `submission/app_questionnaire.md` specifies the patient questionnaire.
- `analysis/`: the scripts that fit the models from the released counts (`build_cf_model.py`,
  `fit_transport_model.py`, `build_longcovid_model.py`), build the atlas data (`build_atlas_data.py`), and write the
  generated documentation and developer pages (`build_models_guide.py`, `build_clinician_interface.py`,
  `build_release_manifest.py`).
- `results/aggregate/`: the released aggregate files the models, Table 1, and the atlas are built from;
  `paper2/results/`, `results/derived/`, and `opendata/processed/` hold the companion analyses' estimates and the
  public survey and surveillance files the atlas also shows.
- `workbench/src/`: the scripts that ran inside the Workbench and produced the aggregate files, with the feature
  registries the models use.
- `paper4/`: the script that writes Table 1 (`tables_p4.py`) and its output, the source of Figure 1
  (`figures/figure1_architecture.tex`), and the script that captures Figure 2 (`figures/make_screens.py`).

## Reproduce the models, Table 1, and the technical evaluation

With Python 3.10, the packages in `requirements.txt`, and Node.js 20 or later:

```
python3 reproduce.py
```

This refits all nine model files from the released counts and requires each to equal `model/<name>.json` and the
site's copy byte for byte, writes Table 1 and compares it with `paper4/tables/models.tex`, rebuilds the atlas data
and compares it with `web/web/atlas/data/`, and reruns, in a copy of the repository, every script that writes in
place (the synthetic patients and their reference outputs, the site's model copies, and the developer pages), none
of which may change a file. It then runs the Python reference tests and the JavaScript suite and compares the counts
with Table 2 of the manuscript: 453 JavaScript tests, of which 437 pass and 16 are skipped (they hold the reference
outputs of two superseded Long COVID model versions), and 180 reference outputs (18 patients, 10 model versions)
reproduced by both scorers. The last line reports how many checks passed.

To run only the JavaScript suite: `cd web && npm test`.

The live checks of Table 2 need network access and are not part of `reproduce.py`: `node web/tools/smart-parity.mjs`
compares the SMART sandbox launch with the demonstration for all 18 patients (see `web/README.md`). Figure 1 compiles
with `latexmk -pdf paper4/figures/figure1_architecture.tex`. Figure 2 needs Playwright for Python, Pillow, and Chrome:
`python3 paper4/figures/make_screens.py`.

## Run the site and use a model file

```
python3 -m http.server 8000 --directory web/web     # then open http://localhost:8000/
python3 model/reference/score_fhir.py model/longcovid.json model/test_vectors/bundles/maria.json --as-of 2024-06-01
```

The CDS Hooks service in `web/functions/` runs as Cloudflare Pages Functions next to the static site; the test suite
calls it directly. The About page and the competition entry page of the live site describe the project and are not
part of this repository; the homepage and the developer pages link to them, and those links work on the live
site.
Neither are the tests that check those two pages or check agreement with the companion manuscripts' text (35 tests
of the project's suite of 488).

The system is a research prototype evaluated on synthetic records only. The Long COVID model predicts a later Long
COVID diagnosis code and the other models a self-reported diagnosis, not disease; none has been validated outside All
of Us, and none is for diagnosing anyone.

## Disclosure protection

All of Us policy bars publishing a participant count of 1 to 20 or any value from which such a count can be derived.
Every count released from the Workbench passed through `workbench/src/aou_safe.py`: counts of 1 to 20 appear as
`<=20` or `suppressed`, other counts are rounded up to the next multiple of 10, and a further cell appears as `hidden`
wherever a suppressed cell could be recovered from the same table's totals. A feature enters a model only if all four
cells of its table with the label exceed 20.

Because this repository is itself a publication, each aggregate file here keeps only the columns that the code reads,
and the model performance files keep only discrimination (AUROC with its interval, and AUPRC), not recall or
precision at fixed workloads. `reproduce.py` rebuilds every output from these trimmed files.

## Companion repositories

The analyses that produced the models and the atlas's estimates are published with their own manuscripts:
https://github.com/AsiaeeLab/unom-long-covid (Long COVID undercoding and prediction),
https://github.com/AsiaeeLab/unom-self-report-coding (coding of self-reported diagnoses), and
https://github.com/AsiaeeLab/unom-self-report-labels (self-reported diagnoses as training labels).

## License

MIT License (see `LICENSE`).
