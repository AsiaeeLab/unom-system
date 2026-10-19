# The Undiagnosed No More site and services

`web/` is the static site (`web/web/`), the CDS Hooks service (`functions/`, Cloudflare Pages Functions), and the
test suite (`test/`, Node.js test runner, no dependencies). The live copy is at https://undiagnosednomore.org.

- `web/patient/`: the patient demonstration (questionnaire, self-checks, visit summary, QuestionnaireResponse export).
- `web/clinician/`: the no-login clinician demonstration on synthetic personas.
- `web/athena/`, `web/smart/`, `web/epic/`: the SMART on FHIR application and its launch routes.
- `web/atlas/`: the atlas; its data files are written by `analysis/build_atlas_data.py`.
- `web/developers/`: the developer pages; their generated parts are written by `analysis/build_models_guide.py`.
- `web/shared/scorer.js`: the JavaScript scorer, a port of `model/reference/score_fhir.py`.
- `web/models/`: the served model files, copied from `model/` by `tools/sync_models.sh`.

## Local preview and tests

```bash
python3 -m http.server 8000 --directory web
```

Open `http://localhost:8000/`.

```bash
npm test
```

## SMART sandbox test patients

The 18 synthetic test-vector charts live on the public SMART R4 sandbox, with
dates shifted so the upload date plays the role of the demo's scoring date
(June 1, 2024). From the repository root:

```bash
node web/tools/smart-parity.mjs                    # live sandbox, read only, as of today (UTC)
node web/tools/smart-parity.mjs --as-of 2027-01-11 # as the SMART app would show it on that date
python3 model/test_vectors/upload_sandbox.py       # re-upload, anchored to today (UTC)
```

The check builds each patient's condition review the way the clinician demo
does and the way the SMART app does (the same FHIR searches and paging as
`athena/fhir-data.js`), compares them card by card, and reports how many days
each chart keeps showing the demo result. It exits nonzero when a patient
differs or a chart is past its validity; then re-run the uploader. For an
offline run, write the shifted charts with
`upload_sandbox.py --dry-run --write-dir DIR` and pass `--offline DIR`.
`npm test` runs the offline version. The four demo personas' patient answers
are uploaded from `model/test_vectors/questionnaires/`; regenerate them with
`node web/tools/write-demo-questionnaires.mjs` after changing
`shared/demo-answers.js`.

## CDS Hooks service: trust model and configuration

`functions/cds-services/` is a stateless CDS Hooks 2.0 service for the
`patient-view` hook (discovery at `/cds-services`, the hook at
`/cds-services/invisible-illness`). It is a prototype for synthetic data.

What it checks on every call:

- The request: `hook` is `patient-view`; `hookInstance` and `context.patientId`
  are present, and the patient id is a FHIR id; `prefetch`, `fhirServer`, and
  `fhirAuthorization` have the right types, and a token comes with a
  `fhirServer`. Anything else is answered with HTTP 400.
- The patient: the prefetched Patient must be `Patient/<context.patientId>`,
  and every prefetched or fetched resource whose `subject` or `patient`
  reference names a patient must name the same one (400 for prefetch, 502 for
  data the FHIR server returned).
- The FHIR server: the prefetch fallback (keys the client did not send, and
  `next` links of prefetched searches) calls `fhirServer` with the bearer token
  only when `fhirServer` is on an allow-list. The list is the Pages environment
  variable `CDS_FHIR_SERVER_ALLOWLIST` (https URL prefixes, comma- or
  space-separated); when it is unset, only the synthetic SMART Health IT sandbox
  (`https://launch.smarthealthit.org/v/r4/`) is allowed, and an empty value
  turns the fallback off.
- Completeness: a failed or forbidden search, an `OperationOutcome` with an
  error, a search whose `next` link cannot be followed, a `total` larger than
  the entries returned, or a fallback that passes 10 pages makes that resource
  type unavailable. Models that read it return "could not score", and the
  service returns one `info` card saying which conditions could not be scored
  and why; a scorer error gives the same card. An error never becomes an empty
  card list. Without a Patient resource the service answers 412.

What it does not do: authenticate the caller. CDS Hooks 2.0 ("Trusting CDS
Clients") has the CDS client send a signed JWT in the `Authorization` header;
a deployment that handles real patient data must verify that JWT before
anything else (signature against the client's registered JWKS; `iss` on a list
of trusted clients; `aud` equal to the service URL; `exp`, `iat`, and a unique
`jti`), restrict the allow-list to that client's FHIR base URL, and keep the
service from logging request bodies (it logs nothing today). Until then, call
it only with synthetic data such as the examples under
`web/developers/examples/`.
