# Lupus review signal for athenaOne

This directory contains the patient-context SMART on FHIR application used by Undiagnosed No More. It retrieves the available longitudinal clinical record, builds a transparent lupus evidence summary, and displays a review signal from 1 to 5.

The signal is clinical decision support. It does not diagnose or rule out systemic lupus erythematosus and must not be used alone for treatment decisions. It uses the domains and weights from the [2019 EULAR/ACR SLE classification criteria](https://doi.org/10.1002/art.40930); those are research classification criteria rather than diagnostic criteria.

## Launch surfaces

| Environment | Launch URL | Redirect URL |
|---|---|---|
| athenaOne Preview | `https://undiagnosednomore.org/athena/launch.html` | `https://undiagnosednomore.org/athena/` |
| SMART reference launcher | `https://undiagnosednomore.org/smart/` | `https://undiagnosednomore.org/smart/callback.html` |
| Epic sandbox | `https://undiagnosednomore.org/epic/` | `https://undiagnosednomore.org/epic/callback.html` |

All launch surfaces load the same evaluator and interface. The Athena route validates the Athena issuer and signed OpenID token. The SMART route accepts only the SMART Health IT R4 launcher issuer. The Epic route accepts only explicitly configured Epic issuers and currently contains the Epic sandbox issuer. Epic registration details are in [`../epic/README.md`](../epic/README.md).

## Provider access request

Request a public SMART client using authorization code flow with S256 PKCE, an EHR launch context, and read-only access to the launched patient. Do not request wildcard, write, system-level, or offline access for the interactive application.

```text
launch
openid
patient/Patient.r
patient/Condition.rs
patient/Observation.rs
patient/DiagnosticReport.rs
patient/Specimen.rs
patient/Encounter.rs
patient/MedicationRequest.rs
patient/MedicationDispense.rs
patient/ServiceRequest.rs
patient/Procedure.rs
patient/QuestionnaireResponse.rs
patient/DocumentReference.rs
patient/Immunization.rs
patient/AllergyIntolerance.rs
patient/CarePlan.rs
patient/Goal.rs
patient/FamilyMemberHistory.rs
```

If note or report bodies are represented by referenced `Binary` resources, negotiate permission to read only the specifically referenced binaries. Do not request Binary search or unrestricted attachment access. Production population training is a separate use case and requires an approved retrospective extract or `Group/[id]/$export`, a data-use agreement, de-identification, adjudicated labels, and site-separated validation.

## FHIR data contract

Every resource must retain `id`, `meta.versionId`, `meta.lastUpdated`, `meta.profile`, `meta.security`, relevant extensions, and complete codings including `system`, `version`, `code`, `display`, and original text. `meta.lastUpdated` is not a clinical event date.

| Resource | Required elements |
|---|---|
| `Patient` | `birthDate`, `gender`, relevant sex extensions; demographics are context only and do not add lupus points |
| `Condition` | `clinicalStatus`, `verificationStatus`, `category`, `code`, `severity`, `bodySite`, `onset[x]`, `abatement[x]`, `recordedDate`, `encounter`, `evidence`, `note` |
| `Observation` | `status`, `category`, `code`, `effective[x]`, `issued`, `value[x]`, `interpretation`, `referenceRange`, `method`, `specimen`, `component`, `dataAbsentReason`, `encounter` |
| `DiagnosticReport` | `status`, `category`, `code`, `effective[x]`, `issued`, `encounter`, `specimen`, `result`, `presentedForm` |
| `Specimen` | `identifier`, `type`, `collection.collected[x]`, `collection.bodySite`, `receivedTime`, `condition` |
| `Encounter` | `status`, `class`, `type`, `serviceType`, `period`, `reasonCode`, `reasonReference`, `diagnosis`, `hospitalization` |
| `MedicationRequest` | `status`, `intent`, `medication[x]`, `authoredOn`, `reasonCode`, `reasonReference`, `dosageInstruction`, `dispenseRequest` |
| `MedicationDispense` | `status`, `medication[x]`, `whenHandedOver`, `quantity`, `daysSupply`, `dosageInstruction`, `authorizingPrescription` |
| `ServiceRequest` | `status`, `intent`, `category`, `code`, `authoredOn`, `occurrence[x]`, `reasonCode`, `reasonReference`, `specimen`, `supportingInfo`, `encounter` |
| `Procedure` | `status`, `code`, `performed[x]`, `reasonCode`, `reasonReference`, `bodySite`, `outcome`, `report`, `encounter` |
| `QuestionnaireResponse` | `questionnaire` (canonical URL and version, checked), `status`, `subject` (checked against the launched patient), `encounter`, `authored` (the most recent response is shown), `source`, `item.linkId`, `item.text`, `item.answer.value[x]` |
| `DocumentReference` | `status`, `docStatus`, `type`, `category`, `date`, `author`, `securityLabel`, `context`, `content.attachment` |

The app also attempts read-only retrieval of medication administration/statements and imaging metadata when the launching server supports them. Each resource type is paginated independently. A denial, unsupported endpoint, or empty result does not prevent the rest of the record from loading.

## Evidence rules

The evaluator never awards points for age, sex or gender, race or ethnicity, healthcare utilization, provider or practice, an existing lupus diagnosis, or lupus-directed medication. An existing SLE condition is shown separately.

ANA entry evidence is supported by a positive ANA at least once at a titre of at least 1:80 by HEp-2 immunofluorescence, or an equivalent documented method. A positive result without the qualifying titre or method remains possible evidence.

Only the highest weighted item in each domain contributes:

| Domain | Evidence and points |
|---|---|
| Constitutional | Unexplained fever over 38.3°C: 2 |
| Hematologic | Leukopenia: 3; thrombocytopenia: 4; autoimmune hemolysis: 4 |
| Neuropsychiatric | Delirium: 2; psychosis: 3; seizure: 5 |
| Mucocutaneous | Nonscarring alopecia: 2; oral ulcers: 2; subacute/discoid cutaneous lupus: 4; acute cutaneous lupus: 6 |
| Serosal | Pleural/pericardial effusion: 5; acute pericarditis: 6 |
| Musculoskeletal | Inflammatory joint involvement: 6 |
| Renal | Proteinuria over 0.5 g/day or equivalent: 4; class II/V lupus nephritis: 8; class III/IV: 10 |
| Antiphospholipid | Qualifying antiphospholipid antibodies: 2 |
| Complement | Low C3 or C4: 3; both low: 4 |
| SLE-specific antibodies | Anti-dsDNA or anti-Sm: 6 |

Structured, final laboratory results and confirmed coded findings can contribute to the confirmed score. Incomplete test methodology, provisional conditions, and note-derived concepts contribute only to the potential score. A note keyword never becomes confirmed evidence automatically.

## Review levels

| Level | Interpretation |
|---|---|
| 1 | Minimal chart-supported signal: no supported criteria, a documented negative ANA, and adequate core data |
| 2 | Limited or incomplete signal: isolated or weak evidence, conflicting evidence, or important missing data |
| 3 | Pattern worth clinician review: a relevant antibody or multi-domain pattern is present |
| 4 | Strong review signal: several weighted domains or important organ-specific evidence need confirmation |
| 5 | Criteria-level pattern: ANA entry evidence, at least one confirmed clinical criterion, and at least 10 confirmed points |

Missing fields, inaccessible resources, redacted records, and `dataAbsentReason` are unknown rather than negative. A level 1 is not assigned simply because data are absent. All evidence still requires attribution: infection, medication effects, malignancy, pregnancy, other autoimmune disease, and other explanations can produce similar findings.

## Local verification

From the site root:

```bash
python3 -m http.server 8000 --directory web
```

Open `https://launch.smarthealthit.org/` and use:

- Launch type: Provider EHR Launch
- FHIR version: R4
- App launch URL: `http://127.0.0.1:8000/smart/`
- Client type: Public
- PKCE: Always
- Client ID: `undiagnosednomore-lupus`
- Scope: `launch openid fhirUser patient/*.read`
- Redirect URL: `http://127.0.0.1:8000/smart/callback.html`

For strict validation, the scheme, host, port, path, client ID, scopes, and redirect URL must match exactly.

## Deployment

From `/home/me/wr/topx-amir/web/undiagnosednomore.org`:

```bash
./deploy.sh
```

The script applies the Cloudflare Pages infrastructure and publishes the `web/` directory to the production branch.
