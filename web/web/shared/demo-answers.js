// Made-up questionnaire answers for the four demo patients, in the patient app's saved-state format
// (patient/storage.js emptyState). The patient app's "Load demo answers" and the clinician demo's
// "Load answers from the patient app" both use these, so the two doors tell the same story.
// Synthetic only: no real person answered these.

const no = "no";
const yes = "yes";
const recoverAll = (yesIds) =>
  Object.fromEntries(
    ["smell-taste", "pem", "cough", "brain-fog", "palpitations", "dizziness", "breath", "thirst", "chest-pain", "fatigue", "snoring"].map(
      (id) => [id, yesIds.includes(id) ? yes : no],
    ),
  );
const pemAll = (f, s) => Object.fromEntries([1, 2, 3, 4, 5].map((n) => [n, { frequency: f[n - 1], severity: s[n - 1] }]));

export const DEMO_ANSWERS = Object.freeze({
  maria: {
    respondent: "self",
    timeline: { onset: "2024-01-20", covid: "yes", covidDate: "2024-01-08", symptoms: "Since I had COVID, I get out of breath on the stairs, my heart races when I stand, and I crash for a day after errands." },
    recover: recoverAll(["pem", "brain-fog", "palpitations", "dizziness", "breath", "fatigue"]),
    pem: pemAll([3, 3, 2, 3, 3], [3, 2, 2, 3, 3]),
    pemDuration: "ge24h",
    pcfs: 3,
    change: { 1: "much-more", 2: "much-more", 3: "much-more", 4: "somewhat-more", 5: "much-more" },
    checks: { chosen: { longcovid: true }, longcovid: { duration: yes } },
    questions: ["Could this be Long COVID?", "Is there a post-COVID clinic I can be referred to?"],
    answeredOn: "2024-05-28",
  },
  elena: {
    respondent: "self",
    timeline: { onset: "2019-11-01", covid: "no", covidDate: "", symptoms: "After mono in 2019 I never got my energy back. Any effort wipes me out for days, sleep does not refresh me, and I get dizzy standing." },
    recover: recoverAll(["pem", "brain-fog", "dizziness", "palpitations", "fatigue"]),
    pem: pemAll([4, 3, 3, 4, 4], [3, 3, 2, 3, 3]),
    pemDuration: "ge24h",
    pcfs: null,
    change: { 1: "much-more", 2: "same", 3: "much-more", 4: "much-more", 5: "much-more" },
    checks: { chosen: { mecfs: true }, mecfs: { reduction: yes, sleep: yes, cognitive: yes, orthostatic: yes } },
    questions: ["Could this be ME/CFS?", "Should I avoid pushing through exercise?"],
    answeredOn: "2024-05-29",
  },
  sofia: {
    respondent: "self",
    timeline: { onset: "2019-09-01", covid: "no", covidDate: "", symptoms: "Pain moves around: neck, back, jaw, hips. I sleep badly, wake up stiff, and my tests keep coming back normal." },
    recover: recoverAll(["fatigue", "brain-fog", "snoring"]),
    pem: pemAll([1, 2, 1, 1, 1], [1, 1, 1, 1, 1]),
    pemDuration: "4-10h",
    pcfs: null,
    change: { 1: "much-more", 2: "same", 3: "same", 4: "somewhat-more", 5: "much-more" },
    checks: {
      chosen: { fibro: true },
      fibro: {
        areas: Object.fromEntries(["jaw-l", "neck", "upper-back", "lower-back", "shoulder-l", "shoulder-r", "hip-l", "hip-r", "upper-leg-r"].map((a) => [a, true])),
        severity: { fatigue: 2, unrefreshed: 2, cognitive: 1 },
        sixMonths: { headache: yes, "lower-abdomen": no, depression: no },
        duration: yes,
      },
    },
    questions: ["Could this be fibromyalgia?", "What can I do about the pain and the sleep?"],
    answeredOn: "2024-05-30",
  },
  dana: {
    respondent: "self",
    timeline: { onset: "2024-04-15", covid: "no", covidDate: "", symptoms: "My knee swelled up a few weeks after a hike, and a few days ago one side of my face started drooping." },
    recover: recoverAll(["fatigue"]),
    pem: pemAll([0, 1, 0, 0, 1], [0, 1, 0, 0, 1]),
    pemDuration: "",
    pcfs: null,
    change: { 1: "somewhat-more", 2: "same", 3: "same", 4: "same", 5: "much-more" },
    checks: { chosen: { lyme: true }, lyme: { tick: "unsure", outdoors: yes, rash: no } },
    questions: ["Could this be Lyme disease?", "Do I need a blood test or treatment now?"],
    answeredOn: "2024-05-31",
  },
});

// Hand-off between the patient app and the clinician demo, in this browser only.
export const HANDOFF_KEY = "unm-demo-handoff-v1";
