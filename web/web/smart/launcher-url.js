export const SMART_SANDBOX_PATIENT_IDS = Object.freeze([
  "dana", "elena", "grace", "james", "kai", "lee", "maria", "nora", "omar",
  "priya", "rosa", "sam", "sofia", "theo", "uma", "vera", "will", "yara",
]);

// A Synthea practitioner on the public R4 sandbox. With it preset and skip_login set, the launcher goes straight
// to the patient picker instead of its simulated practitioner login page.
export const SMART_SANDBOX_PRACTITIONER = "52919099-6a7a-442c-b0d5-2b02c0dd4b74";

// The launcher's launch state: [launch type, patients, provider, encounter, skip login, skip auth, simulated
// EHR, scope, redirect URIs, client ID, client secret, auth error, JWKS URL, JWKS, client type, PKCE, FHIR base].
export function smartLauncherUrl(launchUrl) {
  const launcherState = [
    0,
    SMART_SANDBOX_PATIENT_IDS.join(","),
    SMART_SANDBOX_PRACTITIONER,
    "AUTO",
    1, 0, 0,
    "", "", "", "", "", "", "",
    0, 2, "",
  ];
  const launcher = new URL("https://launch.smarthealthit.org/");
  launcher.searchParams.set("launch_url", launchUrl);
  launcher.searchParams.set("fhir_version", "r4");
  launcher.searchParams.set("launch", btoa(JSON.stringify(launcherState)));
  return launcher.href;
}
