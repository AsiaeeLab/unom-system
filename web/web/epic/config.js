export const EPIC_SANDBOX_FHIR_ISSUER =
  "https://fhir.epic.com/interconnect-fhir-oauth/api/FHIR/R4";

export const epicConfig = Object.freeze({
  clientId: "e8dcbefa-45d6-42da-9159-3ac03e22c24f",

  scope: "launch openid fhirUser",
  allowedIssuers: Object.freeze([EPIC_SANDBOX_FHIR_ISSUER]),
});
