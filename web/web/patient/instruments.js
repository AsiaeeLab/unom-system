// Instrument definitions for the patient symptom check.
// Item text for Parts B and C is verbatim from the primary sources (see
// submission/app_questionnaire.md). Do not reword, reorder, or rescale.

export const QUESTIONNAIRE_URL =
  "https://undiagnosednomore.org/fhir/Questionnaire/unm-patient-symptom-check";
// 1.0.0: Parts A to D; 1.1.0: adds the Part E self-checks (checks.*); 1.2.0: recover.category "incomplete"
// until every RECOVER symptom is answered; 1.3.0: adds the PHQ-9 and GAD-7 (checks.phq9.*, checks.gad7.*).
// The clinician dashboard accepts every version listed here.
export const QUESTIONNAIRE_VERSION = "1.3.0";
export const SUPPORTED_QUESTIONNAIRE_VERSIONS = Object.freeze(["1.0.0", "1.1.0", "1.2.0", "1.3.0"]);

// These are also the citation targets used by the clinician dashboard.
export const INSTRUMENT_URLS = Object.freeze({
  recoverIndex: "https://doi.org/10.1001/jama.2024.24184",
  recoverQuestions: "https://doi.org/10.1001/jama.2023.8823",
  pem: "https://doi.org/10.3390/diagnostics8030066",
  pcfs: "https://doi.org/10.1183/13993003.01494-2020",
  phq9: "https://doi.org/10.1046/j.1525-1497.2001.016009606.x",
  gad7: "https://doi.org/10.1001/archinte.166.10.1092",
});

// Part A. RECOVER-Adult Long COVID Research Index, 2024 update.
// Symptoms and points: Geng et al., JAMA 2025, Table (Part A of
// submission/app_questionnaire.md). "text" is the symptom as it appears in the RECOVER
// questionnaire (Thaweethai et al., JAMA 2023, Supplement 3, eTable 1); the
// index counts a symptom the participant has now. "name" is the short name
// used in results. "help" is a plain-language gloss shown under the question;
// it is not part of the index. Items with "severity" also need a severity
// score in the published index (Geng 2025, Table footnote e; Thaweethai 2023,
// eTable 2); this app does not give those questionnaires and counts a Yes.
export const RECOVER = {
  title: "RECOVER 2024 index",
  attribution:
    "Symptoms and points from the RECOVER-Adult Long COVID Research Index, 2024 update (Geng LN et al., JAMA 2025;333(8):694-700); item wording from the RECOVER questionnaire (Thaweethai T et al., JAMA 2023;329(22):1934-1946).",
  stem: "Do you have each of these symptoms now? Mark Yes or No.",
  severityNote:
    "In the published index, fatigue, brain fog, and chest pain count only when a separate severity questionnaire also passes a threshold. This app counts a Yes, so its total can be higher than the research index would give.",
  cutoff: 11,
  items: [
    { id: "smell-taste", name: "Loss of smell or taste", text: "Loss of or change in smell or taste", points: 7, help: "" },
    {
      id: "pem",
      name: "Post-exertional malaise",
      text: "Post-exertional malaise (Symptoms worse after even minor physical or mental effort)",
      points: 6,
      help: "Often a day or more later.",
    },
    { id: "cough", name: "Chronic cough", text: "Persistent (chronic) cough", points: 4, help: "A cough that keeps coming back or does not go away." },
    {
      id: "brain-fog",
      name: "Brain fog",
      text: "Problems thinking or concentrating (\"brain fog\")",
      points: 3,
      help: "Trouble thinking clearly, focusing, or remembering.",
      severity: "Neuro-QoL v2.0 Cognition Short Form, T-score 40 or lower",
    },
    { id: "palpitations", name: "Palpitations", text: "Palpitations, racing heart, arrhythmia, skipped beats", points: 2, help: "" },
    {
      id: "dizziness",
      name: "Dizziness",
      text: "Feeling faint, dizzy, \"goofy\"; difficulty thinking soon after standing up from a sitting or lying position",
      points: 2,
      help: "",
    },
    { id: "breath", name: "Shortness of breath", text: "Shortness of breath", points: 2, help: "" },
    { id: "thirst", name: "Thirst", text: "Excessive thirst", points: 1, help: "Feeling more thirsty than usual." },
    {
      id: "chest-pain",
      name: "Chest pain",
      text: "Chest pain (including chest tightness, pressure)",
      points: 1,
      help: "",
      severity: "Seattle Angina Questionnaire-7 score below 75",
    },
    {
      id: "fatigue",
      name: "Fatigue",
      text: "Fatigue (being very tired)",
      points: 1,
      help: "",
      severity: "PROMIS Global-10 fatigue item (past 7 days) moderate or worse",
    },
    {
      id: "snoring",
      name: "Snoring or sleep apnea",
      text: "Has anyone ever told you that you have sleep apnea (stopping breathing during sleep) or that you snore 3 or more times a week?",
      points: 1,
      help: "",
    },
  ],
};

// Part B. DePaul Symptom Questionnaire, post-exertional malaise short form.
export const PEM = {
  title: "DePaul Symptom Questionnaire: post-exertional malaise",
  attribution:
    "DePaul Symptom Questionnaire PEM items (Cotler et al., Diagnostics 2018), CC BY 4.0.",
  instruction:
    "For each symptom below, please circle one number for frequency and one number for severity.",
  frequencyQuestion: "Throughout the past 6 months, how often have you had this symptom?",
  severityQuestion: "Throughout the past 6 months, how much has this symptom bothered you?",
  frequency: [
    { value: 0, label: "none of the time" },
    { value: 1, label: "a little of the time" },
    { value: 2, label: "about half the time" },
    { value: 3, label: "most of the time" },
    { value: 4, label: "all of the time" },
  ],
  severity: [
    { value: 0, label: "symptom not present" },
    { value: 1, label: "mild" },
    { value: 2, label: "moderate" },
    { value: 3, label: "severe" },
    { value: 4, label: "very severe" },
  ],
  items: [
    { n: 1, text: "Dead, heavy feeling after starting to exercise" },
    { n: 2, text: "Next day soreness or fatigue after non-strenuous, everyday activities" },
    { n: 3, text: "Mentally tired after the slightest effort" },
    { n: 4, text: "Minimum exercise makes you physically tired" },
    { n: 5, text: "Physically drained or sick after mild activity" },
  ],
  // Optional context item for the clinician; not part of the screen rule.
  duration: {
    question: "If you feel worse after activities, how long does this last?",
    options: [
      { code: "lt1h", label: "< 1 h", plain: "less than 1 hour" },
      { code: "2-3h", label: "2–3 h", plain: "2 to 3 hours" },
      { code: "4-10h", label: "4–10 h", plain: "4 to 10 hours" },
      { code: "11-13h", label: "11–13 h", plain: "11 to 13 hours" },
      { code: "14-23h", label: "14–23 h", plain: "14 to 23 hours" },
      { code: "ge24h", label: "≥ 24 h", plain: "24 hours or more" },
    ],
  },
};

// Part C. Post-COVID-19 Functional Status scale, patient questionnaire (v2).
export const PCFS = {
  title: "Post-COVID-19 Functional Status scale",
  attribution: "Post-COVID-19 Functional Status scale (Klok et al., Eur Respir J 2020), version 2.",
  question:
    "How much are you currently affected in your everyday life by COVID-19? Please indicate which one of the following statements applies to you most. Please tick only one box at a time.",
  rules:
    "Answer for your average situation over the past week. If two statements seem to apply, choose the higher one.",
  options: [
    {
      grade: 0,
      label: "no functional limitations",
      text: "I have no limitations in my everyday life and no symptoms, pain, depression or anxiety.",
    },
    {
      grade: 1,
      label: "negligible functional limitations",
      text: "I have negligible limitations in my everyday life as I can perform all usual duties/activities, although I still have persistent symptoms, pain, depression or anxiety.",
    },
    {
      grade: 2,
      label: "slight functional limitations",
      text: "I suffer from limitations in my everyday life as I occasionally need to avoid or reduce usual duties/activities or need to spread these over time due to symptoms, pain, depression or anxiety. I am, however, able to perform all activities without any assistance.",
    },
    {
      grade: 3,
      label: "moderate functional limitations",
      text: "I suffer from limitations in my everyday life as I am not able to perform all usual duties/activities due to symptoms, pain, depression or anxiety. I am, however, able to take care of myself without any assistance.",
    },
    {
      grade: 4,
      label: "severe functional limitations",
      text: "I suffer from severe limitations in my everyday life: I am not able to take care of myself and therefore I am dependent on nursing care and/or assistance from another person due to symptoms, pain, depression or anxiety.",
    },
  ],
};

// PCFS asks about COVID-19, so it applies only when the person has had (or may have had) COVID-19.
export function pcfsApplies(covid) {
  return covid !== "no";
}

// The RECOVER index was built and validated in people after SARS-CoV-2 infection. For someone who
// answered "No" to COVID-19 the symptom items are still asked and shared, but no index points, range,
// or Long COVID wording are shown, exported, or used by the triage rule. "Not sure" keeps the index.
export function recoverIndexApplies(covid) {
  return covid !== "no";
}

// Part D wording follows the person's answer about COVID-19: these items are ours (unscored), so the
// reference point can change; the validated instruments above are never reworded.
export function changeWording(covid) {
  return covid === "yes"
    ? { title: "What changed since COVID", stem: "Compared with before your COVID infection:" }
    : { title: "What changed since your symptoms started", stem: "Compared with before your symptoms started:" };
}

// Part D. Change since before COVID (unscored context for the clinician).
export const CHANGE = {
  title: "What changed since COVID",
  stem: "Compared with before your COVID infection:",
  note: "These questions are not scored. They help your clinician see what changed.",
  options: [
    { code: "much-more", label: "Much more" },
    { code: "somewhat-more", label: "Somewhat more" },
    { code: "same", label: "About the same" },
    { code: "less", label: "Less" },
  ],
  items: [
    { n: 1, text: "How tired you feel during a normal day." },
    { n: 2, text: "How short of breath you get with activities you used to do easily." },
    { n: 3, text: "How often your heart races or pounds, especially when you stand up." },
    { n: 4, text: "How often you have trouble thinking, concentrating, or remembering." },
    {
      n: 5,
      text: "How often you have seen a doctor or gone to urgent care or the emergency department.",
    },
  ],
};

// Part E. Condition self-checks (optional). The person picks which ones to answer. For Long COVID, ME/CFS,
// fibromyalgia, and Lyme disease the wording is ours, written from the published criteria named in each
// "source"; those published questionnaires are not reproduced. A result says whether the answers match the
// pattern the criteria describe. It is a prompt for the clinician, who applies the criteria; it is never a
// diagnosis. The PHQ-9 and GAD-7 are the published questionnaires, reproduced verbatim (see below).
const YES_NO_UNSURE = [
  { code: "yes", label: "Yes" },
  { code: "no", label: "No" },
  { code: "unsure", label: "Not sure" },
];

// PHQ-9 and GAD-7: item text, answer choices, and the PHQ-9 difficulty question are verbatim from the English
// forms at phqscreeners.com (PHQ-9_English.pdf and GAD-7_English.pdf, read October 15, 2026; "No permission
// required to reproduce, translate, display or distribute"). One typographic change: the English PHQ-9 prints an
// em dash (U+2014) in items 6 and 8; the app shows a spaced en dash there, as the official US Spanish form does,
// because the app's copy rules exclude the em dash. The words are unchanged. The paper-form instruction (mark
// with a check) is not shown; the app asks for a tap. Severity cutpoints and their names: Kroenke et al., J Gen
// Intern Med 2001 (PHQ-9 scores of 5, 10, 15, and 20), Spitzer et al., Arch Intern Med 2006, and the PHQ and
// GAD-7 instruction manual on phqscreeners.com (PHQ-9 Table 4, "None-minimal" for 0 to 4; GAD-7 "Scores of 5,
// 10, and 15 represent cutpoints for mild, moderate, and severe anxiety"; the manual names no level below 5).
// Totals and severity are given only when every item is answered. PHQ-9 item 9 asks about thoughts of
// self-harm: any answer other than "Not at all" shows the 988 Suicide & Crisis Lifeline at once (app.js).
const PHQ_FREQUENCY = [
  { value: 0, label: "Not at all" },
  { value: 1, label: "Several days" },
  { value: 2, label: "More than half the days" },
  { value: 3, label: "Nearly every day" },
];

export const CHECKS = {
  title: "Condition self-checks",
  intro:
    "These short checks follow the criteria and questionnaires clinicians use for six conditions. Pick any that fit your symptoms, or skip this page. Your answers are added to your visit summary with the rest.",
  options: YES_NO_UNSURE,
  longcovid: {
    id: "longcovid",
    title: "Long COVID: how long symptoms have lasted",
    pick: "Long COVID (asked only if you have had, or may have had, COVID-19)",
    source: "National Academies of Sciences, Engineering, and Medicine. A Long COVID Definition. 2024.",
    items: [
      {
        id: "duration",
        text: "Have your symptoms lasted 3 months or longer since COVID-19, whether they stayed the same, came and went, or got worse?",
      },
    ],
  },
  mecfs: {
    id: "mecfs",
    title: "ME/CFS: the core symptoms",
    pick: "ME/CFS (myalgic encephalomyelitis/chronic fatigue syndrome)",
    source: "Institute of Medicine. Beyond Myalgic Encephalomyelitis/Chronic Fatigue Syndrome: Redefining an Illness. 2015.",
    stem: "Answer Yes only if the symptom is there at least half of the time and is moderate or worse.",
    items: [
      {
        id: "reduction",
        text: "For more than 6 months, have you been much less able to do your usual work, school, home, or social activities than before you got sick, with tiredness that is new (not lifelong), not caused by overdoing it, and not much better with rest?",
      },
      { id: "sleep", text: "Do you usually wake up unrefreshed, even after a full night's sleep?" },
      { id: "cognitive", text: "Do you have trouble thinking, remembering, or concentrating?" },
      {
        id: "orthostatic",
        text: "Do your symptoms get worse when you stand or sit upright, and better when you lie down?",
      },
    ],
    // Post-exertional malaise comes from the DePaul screen (Part B), which everyone answers.
  },
  fibro: {
    id: "fibro",
    title: "Fibromyalgia: where it hurts and how you feel",
    pick: "Fibromyalgia (widespread pain)",
    source:
      "Wolfe F, et al. 2016 revisions to the 2010/2011 fibromyalgia diagnostic criteria. Semin Arthritis Rheum. 2016;46(3):319-329.",
    areasQuestion: "In the past 7 days, where have you had pain or tenderness? Mark every area that applies.",
    // region: the five body regions of the 2016 generalized-pain rule; jaw, chest, and abdomen count toward
    // the pain index but not toward the regions.
    areas: [
      { id: "jaw-l", label: "Jaw, left", region: null },
      { id: "jaw-r", label: "Jaw, right", region: null },
      { id: "shoulder-l", label: "Shoulder, left", region: "left-upper" },
      { id: "shoulder-r", label: "Shoulder, right", region: "right-upper" },
      { id: "upper-arm-l", label: "Upper arm, left", region: "left-upper" },
      { id: "upper-arm-r", label: "Upper arm, right", region: "right-upper" },
      { id: "lower-arm-l", label: "Lower arm, left", region: "left-upper" },
      { id: "lower-arm-r", label: "Lower arm, right", region: "right-upper" },
      { id: "hip-l", label: "Hip or buttock, left", region: "left-lower" },
      { id: "hip-r", label: "Hip or buttock, right", region: "right-lower" },
      { id: "upper-leg-l", label: "Upper leg, left", region: "left-lower" },
      { id: "upper-leg-r", label: "Upper leg, right", region: "right-lower" },
      { id: "lower-leg-l", label: "Lower leg, left", region: "left-lower" },
      { id: "lower-leg-r", label: "Lower leg, right", region: "right-lower" },
      { id: "neck", label: "Neck", region: "axial" },
      { id: "upper-back", label: "Upper back", region: "axial" },
      { id: "lower-back", label: "Lower back", region: "axial" },
      { id: "chest", label: "Chest", region: null },
      { id: "abdomen", label: "Abdomen (belly)", region: null },
    ],
    severityQuestion: "In the past 7 days, how much of a problem has each of these been?",
    severity: [
      { value: 0, label: "No problem" },
      { value: 1, label: "Slight or mild, or only now and then" },
      { value: 2, label: "Moderate, often there" },
      { value: 3, label: "Severe, constant, and disrupting my life" },
    ],
    severityItems: [
      { id: "fatigue", text: "Tiredness (fatigue)" },
      { id: "unrefreshed", text: "Waking up tired or unrefreshed" },
      { id: "cognitive", text: "Trouble thinking or remembering" },
    ],
    sixMonthsQuestion: "In the past 6 months, have you had any of these?",
    sixMonthsItems: [
      { id: "headache", text: "Headaches" },
      { id: "lower-abdomen", text: "Pain or cramps in the lower belly" },
      { id: "depression", text: "Depression" },
    ],
    durationQuestion: "Have your pain and these symptoms been at about the same level for at least 3 months?",
  },
  lyme: {
    id: "lyme",
    title: "Lyme disease: possible exposure",
    pick: "Lyme disease (tick exposure)",
    source:
      "Questions written for this app from CDC guidance on Lyme disease exposure and erythema migrans (cdc.gov/lyme). Not scored.",
    items: [
      { id: "tick", text: "In the 3 months before your symptoms started, did you find a tick attached to your skin?" },
      {
        id: "outdoors",
        text: "In those 3 months, did you spend time in wooded, brushy, or grassy places, including your own yard, where Lyme disease is common (for example the Northeast, the Mid-Atlantic, or the upper Midwest)?",
      },
      {
        id: "rash",
        text: "Did you have a red rash that grew larger over several days, to at least 2 inches (5 cm) across?",
      },
    ],
  },
  phq9: {
    id: "phq9",
    title: "Depression: the PHQ-9",
    pick: "Depression (the PHQ-9 questionnaire)",
    name: "PHQ-9",
    fullName: "Patient Health Questionnaire-9 (PHQ-9)",
    source:
      "Kroenke K, Spitzer RL, Williams JBW. The PHQ-9: validity of a brief depression severity measure. J Gen Intern Med. 2001;16(9):606-613.",
    stem: "Over the last 2 weeks, how often have you been bothered by any of the following problems?",
    options: PHQ_FREQUENCY,
    items: [
      { id: "1", text: "Little interest or pleasure in doing things" },
      { id: "2", text: "Feeling down, depressed, or hopeless" },
      { id: "3", text: "Trouble falling or staying asleep, or sleeping too much" },
      { id: "4", text: "Feeling tired or having little energy" },
      { id: "5", text: "Poor appetite or overeating" },
      { id: "6", text: "Feeling bad about yourself – or that you are a failure or have let yourself or your family down" },
      { id: "7", text: "Trouble concentrating on things, such as reading the newspaper or watching television" },
      {
        id: "8",
        text: "Moving or speaking so slowly that other people could have noticed? Or the opposite – being so fidgety or restless that you have been moving around a lot more than usual",
      },
      { id: "9", text: "Thoughts that you would be better off dead or of hurting yourself in some way" },
    ],
    // Asked after the nine items; not part of the score (PHQ instruction manual).
    difficultyQuestion:
      "If you checked off any problems, how difficult have these problems made it for you to do your work, take care of things at home, or get along with other people?",
    difficulty: [
      { code: "not-difficult", label: "Not difficult at all" },
      { code: "somewhat", label: "Somewhat difficult" },
      { code: "very", label: "Very difficult" },
      { code: "extremely", label: "Extremely difficult" },
    ],
    max: 27,
    bands: [
      { code: "0-4", min: 0, max: 4, label: "none-minimal depression" },
      { code: "5-9", min: 5, max: 9, label: "mild depression" },
      { code: "10-14", min: 10, max: 14, label: "moderate depression" },
      { code: "15-19", min: 15, max: 19, label: "moderately severe depression" },
      { code: "20-27", min: 20, max: 27, label: "severe depression" },
    ],
    // Item 9 asks about thoughts of self-harm.
    selfHarmItem: "9",
  },
  gad7: {
    id: "gad7",
    title: "Anxiety: the GAD-7",
    pick: "Anxiety (the GAD-7 questionnaire)",
    name: "GAD-7",
    fullName: "Generalized Anxiety Disorder 7-item scale (GAD-7)",
    source:
      "Spitzer RL, Kroenke K, Williams JBW, Löwe B. A brief measure for assessing generalized anxiety disorder: the GAD-7. Arch Intern Med. 2006;166(10):1092-1097.",
    stem: "Over the last 2 weeks, how often have you been bothered by the following problems?",
    options: PHQ_FREQUENCY,
    items: [
      { id: "1", text: "Feeling nervous, anxious or on edge" },
      { id: "2", text: "Not being able to stop or control worrying" },
      { id: "3", text: "Worrying too much about different things" },
      { id: "4", text: "Trouble relaxing" },
      { id: "5", text: "Being so restless that it is hard to sit still" },
      { id: "6", text: "Becoming easily annoyed or irritable" },
      { id: "7", text: "Feeling afraid as if something awful might happen" },
    ],
    max: 21,
    bands: [
      { code: "0-4", min: 0, max: 4, label: "below the cutpoint for mild anxiety" },
      { code: "5-9", min: 5, max: 9, label: "mild anxiety" },
      { code: "10-14", min: 10, max: 14, label: "moderate anxiety" },
      { code: "15-21", min: 15, max: 21, label: "severe anxiety" },
    ],
  },
};

export const CHECK_ORDER = ["longcovid", "mecfs", "fibro", "lyme", "phq9", "gad7"];

/** The 988 Suicide & Crisis Lifeline, as 988lifeline.org gives it (checked October 15, 2026). */
export const CRISIS_LINE = Object.freeze({
  name: "988 Suicide & Crisis Lifeline",
  number: "988",
  call: "tel:988",
  text: "sms:988",
  site: "https://988lifeline.org/",
  siteEs: "https://988lifeline.org/es/inicio/",
  emergency: "911",
});

/** The Long COVID duration check applies only after a "Yes" or "Not sure" to having had COVID-19. */
export function checkApplies(id, covid) {
  return id !== "longcovid" || covid !== "no";
}
