# Epic SMART on FHIR endpoint

This route provides the Epic sandbox EHR-launch surface for the same lupus evidence review used by the athenaOne and SMART Health IT routes.

## Registered URLs

- Launch URL: `https://undiagnosednomore.org/epic/`
- Redirect URI: `https://undiagnosednomore.org/epic/callback.html`
- Sandbox FHIR issuer: `https://fhir.epic.com/interconnect-fhir-oauth/api/FHIR/R4`

The redirect URI must match the Epic app registration exactly, including scheme, case, path, and filename.

## Epic app registration

Create an Epic on FHIR app for clinician, staff, or administrative users with:

- FHIR version R4
- OAuth 2.0 enabled
- SMART EHR launch
- Public, non-confidential client for this browser prototype
- SMART v1 scope version for compatibility with older customer releases
- The exact redirect URI above
- The required R4 Incoming APIs marked for sandbox access

The authorize request uses `launch openid fhirUser`. Epic derives resource scopes from the Incoming APIs configured on the client record. Select only the API operations used by the application:

- `Patient.Read`
- Search access for `Condition`, `Observation`, `DiagnosticReport`, `Specimen`, `Encounter`, `MedicationRequest`, `MedicationDispense`, `MedicationAdministration`, `MedicationStatement`, `ServiceRequest`, `Procedure`, `QuestionnaireResponse`, `DocumentReference`, `ImagingStudy`, `Immunization`, `AllergyIntolerance`, `CarePlan`, `Goal`, and `FamilyMemberHistory`
- `Binary.Read` only when referenced clinical-document text must be retrieved

After Epic issues the non-production client ID, replace the sentinel in `config.js`. Mark the app ready for sandbox and allow Epic’s configuration sync to complete before testing in LaunchPad.

## Security boundary

The endpoint accepts only the exact Epic sandbox issuer configured in `config.js`, requires an opaque EHR launch token, and uses authorization code flow with S256 PKCE. The deployed content policy permits framing only from Epic’s sandbox sites. Add each customer FHIR issuer, connection origin, and frame ancestor explicitly before customer testing; never accept arbitrary HTTPS issuers.

This static public-client route is for sandbox integration testing. Epic’s current production guidance prefers a server-side confidential client with server-side code redemption and protected token storage. Customer deployment also requires the healthcare organization to install the client record and configure the launch point.
