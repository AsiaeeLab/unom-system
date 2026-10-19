# Patient questionnaire for the two-step screen (design, October 1, 2026)

## Why a questionnaire, and why these instruments

The chart model's strongest signals are things a chart records well: a repeat COVID-19 code, a chest CT, breathlessness and chest-pain codes, D-dimer and CRP orders, a new inhaler (Paper 1, Figure 5). The symptoms that define Long COVID for patients are recorded poorly: fatigue codes are not specific, and post-exertional malaise and brain fog have no reliable codes at all. A short patient questionnaire supplies exactly the information the chart misses, so the two steps are complementary rather than redundant.

Use validated instruments for everything that is scored. Do not write new scored items: an invented scale cannot be defended to judges, clinicians, or reviewers, and we have no data to validate one before October 15. Model-derived "compared with before COVID" questions are useful context for the clinician, but they are unscored until validated.

## The instrument (about 5 minutes)

| Part | Instrument | What it measures | Scoring | Source (verified in Crossref) |
|---|---|---|---|---|
| A | RECOVER-Adult Long COVID Research Index, 2024 update | Symptoms that best separate Long COVID from no Long COVID | Weighted points; 11 or more = "likely Long COVID" (point values from the Table of Geng et al. 2025; item wording from the RECOVER questionnaire, Thaweethai et al. JAMA 2023, Supplement 3) | Geng LN et al. JAMA 2025;333(8):694-700, doi:10.1001/jama.2024.24184 |
| B | DePaul Symptom Questionnaire, post-exertional malaise short form | Post-exertional malaise, the hallmark of ME/CFS and common in Long COVID, almost never coded | 5 items on frequency and severity; screen positive by the published rule | Cotler J et al. Diagnostics 2018;8(3):66, doi:10.3390/diagnostics8030066 |
| C | Post-COVID-19 Functional Status (PCFS) scale | How much symptoms limit daily life | One grade, 0 (no limitation) to 4 (severe) | Klok FA et al. Eur Respir J 2020, doi:10.1183/13993003.01494-2020 |
| D | Change since before COVID (unscored context) | The model's main signals in the patient's words | Shown to the clinician, not scored | Derived from the model; to be validated |

Part D items (each "much more / somewhat more / about the same / less" compared with before your COVID infection):
1. How tired you feel during a normal day.
2. How short of breath you get with activities you used to do easily.
3. How often your heart races or pounds, especially when you stand up.
4. How often you have trouble thinking, concentrating, or remembering.
5. How often you have seen a doctor or gone to urgent care or the emergency department.

Fit for people without COVID-19 (added October 4, 2026, for the chronic fatigue and fibromyalgia cards): if the person answers "No" to "Has had COVID-19", the app skips Part C (the PCFS asks how much COVID-19 affects daily life, and its validated wording is not changed), and Part D uses "Compared with before your symptoms started:" under the title "What changed since your symptoms started". Part A is still asked, because the symptoms are useful to the clinician, but the RECOVER index was built for people after COVID-19, so the app computes no index points, shows no "likely" or "possible" range or Long COVID wording, and does not let RECOVER trigger the triage rule; the results say "These symptoms are shared with your clinician. The RECOVER index is designed for people who have had COVID-19, so no score is shown." "Not sure" keeps Part C, keeps the RECOVER index, and uses the symptom-onset wording for Part D. The QuestionnaireResponse records whichever wording was shown, and after "No" it keeps the recover.<item> answers but omits recover.score and recover.category.

An optional longer alternative for Part A/B in research use: the Symptom Burden Questionnaire for Long Covid (Hughes SE et al. BMJ 2022, doi:10.1136/bmj-2022-070230), a Rasch-validated multi-scale instrument; too long for the competition demo.

## Item text for Parts B and C (verbatim from the primary sources, checked October 1, 2026)

Do not reword, reorder, or rescale these items: the published scoring rules apply only to the published wording. Show the attribution line under each card.

### Part B. DePaul Symptom Questionnaire, post-exertional malaise (DSQ-PEM)

Source: Cotler J, Holtzman C, Dudun C, Jason LA. A brief questionnaire to assess post-exertional malaise. Diagnostics 2018;8(3):66, Appendices A and B (open access, CC BY 4.0). Attribution line: "DePaul Symptom Questionnaire PEM items (Cotler et al., Diagnostics 2018), CC BY 4.0."

Instruction: "For each symptom below, please circle one number for frequency and one number for severity."

- Frequency: "Throughout the past 6 months, how often have you had this symptom?" 0 = none of the time, 1 = a little of the time, 2 = about half the time, 3 = most of the time, 4 = all of the time.
- Severity: "Throughout the past 6 months, how much has this symptom bothered you?" 0 = symptom not present, 1 = mild, 2 = moderate, 3 = severe, 4 = very severe.

Items (each rated for frequency and severity):
1. Dead, heavy feeling after starting to exercise
2. Next day soreness or fatigue after non-strenuous, everyday activities
3. Mentally tired after the slightest effort
4. Minimum exercise makes you physically tired
5. Physically drained or sick after mild activity

Optional context item for the clinician (not part of the screen rule): "If you feel worse after activities, how long does this last?" < 1 h, 2–3 h, 4–10 h, 11–13 h, 14–23 h, ≥ 24 h.

Scoring (Appendix B, step 1): "A frequency and severity score of 2, 2 on any items 1–5 is indicative of PEM." Implement as: screen positive if, on at least one of items 1–5, frequency is 2 or higher and severity is 2 or higher (the paper's text describes the same rule as "at least half the time and of a moderate or greater severity"). The 6-month time frame is part of the published wording; for a patient infected less than 6 months ago, the card should show the infection date next to the result rather than change the question.

### Part C. Post-COVID-19 Functional Status (PCFS) scale, patient questionnaire

Source: Klok FA et al. Eur Respir J 2020;56:2001494 (CC BY-NC 4.0), and the official self-report form "Self-report methods – Post-COVID-19 Functional Status Scale, version 2, July 2020" (Table 2), free of charge at https://osf.io/qgpdv/. Attribution line: "Post-COVID-19 Functional Status scale (Klok et al., Eur Respir J 2020), version 2."

Question: "How much are you currently affected in your everyday life by COVID-19? Please indicate which one of the following statements applies to you most. Please tick only one box at a time."

| Statement | Grade |
|---|---|
| I have no limitations in my everyday life and no symptoms, pain, depression or anxiety. | 0 |
| I have negligible limitations in my everyday life as I can perform all usual duties/activities, although I still have persistent symptoms, pain, depression or anxiety. | 1 |
| I suffer from limitations in my everyday life as I occasionally need to avoid or reduce usual duties/activities or need to spread these over time due to symptoms, pain, depression or anxiety. I am, however, able to perform all activities without any assistance. | 2 |
| I suffer from limitations in my everyday life as I am not able to perform all usual duties/activities due to symptoms, pain, depression or anxiety. I am, however, able to take care of myself without any assistance. | 3 |
| I suffer from severe limitations in my everyday life: I am not able to take care of myself and therefore I am dependent on nursing care and/or assistance from another person due to symptoms, pain, depression or anxiety. | 4 |

Rules from the form: the answer concerns the average situation of the past week; if two grades seem to apply, choose the higher one. Show the grade with its label: 0 no functional limitations, 1 negligible, 2 slight, 3 moderate, 4 severe.

### Part A. RECOVER 2024 index

Symptoms and points are in the Table of Geng et al., JAMA 2025. The Geng supplement gives wording only for the symptoms added in June 2023, none of which is in the index; the wording of the 11 index symptoms is in eTable 1 of Supplement 3 of Thaweethai et al., JAMA 2023;329(22):1934-1946 (the 2023 PASC definition).

The app asks "Do you have each of these symptoms now? Mark Yes or No." (our framing: the index counts symptoms present at the visit), then shows each symptom as it appears in the RECOVER questionnaire:

| Symptom (short name) | RECOVER questionnaire wording | Points | Severity score also required in the published index |
|---|---|---|---|
| Loss of smell or taste | Loss of or change in smell or taste | 7 | |
| Post-exertional malaise | Post-exertional malaise (Symptoms worse after even minor physical or mental effort) | 6 | |
| Chronic cough | Persistent (chronic) cough | 4 | |
| Brain fog | Problems thinking or concentrating ("brain fog") | 3 | Neuro-QoL v2.0 Cognition Short Form, T-score 40 or lower |
| Palpitations | Palpitations, racing heart, arrhythmia, skipped beats | 2 | |
| Dizziness | Feeling faint, dizzy, "goofy"; difficulty thinking soon after standing up from a sitting or lying position | 2 | |
| Shortness of breath | Shortness of breath | 2 | (2023 definition used the mMRC dyspnea scale above 1; the 2024 Table does not mark it) |
| Thirst | Excessive thirst | 1 | |
| Chest pain | Chest pain (including chest tightness, pressure) | 1 | Seattle Angina Questionnaire-7 below 75 |
| Fatigue | Fatigue (being very tired) | 1 | PROMIS Global-10 fatigue item, moderate or worse |
| Snoring or sleep apnea | Has anyone ever told you that you have sleep apnea (stopping breathing during sleep) or that you snore 3 or more times a week? | 1 | (asked in RECOVER after a sleep-problems item) |

The app does not give the three severity questionnaires (the Seattle Angina Questionnaire is licensed; the PROMIS and Neuro-QoL items need a HealthMeasures software license check and T-score tables). It counts a Yes and, when fatigue, brain fog, or chest pain is marked, adds to the result: "In the published index, fatigue, brain fog, and chest pain count only when a separate severity questionnaire also passes a threshold. This app counts a Yes, so its total can be higher than the research index would give." The most this can add is 5 points.

### Part E. Condition self-checks (optional, added October 11, 2026)

After Part D the app offers six short checks (four until October 15, 2026); the person ticks any that fit, or none. For the first four the wording is ours, written from each set of published criteria (those published questionnaires are not reproduced); the PHQ-9 and GAD-7 are reproduced verbatim (next section). Every result says it is not a diagnosis. Definitions: `CHECKS` in `web/web/patient/instruments.js`; scoring: `chosenChecks`, `checkLongCovid`, `checkMecfs`, `scoreFibro`, `checkLyme`, `scoreScale` in `web/web/patient/scoring.js`. Each chosen check is exported under `checks.<id>` in the same QuestionnaireResponse (version 1.1.0 and later) and shown on the clinician dashboard ("From the patient" panel and the matching card).

| Check | Based on | Questions | Result |
|---|---|---|---|
| Long COVID (only after COVID-19 Yes or Not sure) | NASEM 2024 Long COVID definition | Symptoms lasted 3 months or longer since COVID-19 (stayed, came and went, or got worse) | Lasted 3 months or longer; less than 3 months; not sure |
| ME/CFS | IOM 2015 criteria | Activity much reduced for more than 6 months with new fatigue not relieved by rest; unrefreshing sleep; cognitive problems; worse upright (each at least half the time, moderate or worse). Post-exertional malaise comes from the Part B screen. | Matches when all core symptoms are Yes and the DePaul screen is positive (cognitive or orthostatic is enough for the last one); does not match as soon as a required part is No; otherwise not finished |
| Fibromyalgia | 2016 revised criteria (Wolfe et al.) | Pain or tenderness in 19 areas in the past 7 days (Widespread Pain Index); fatigue, waking unrefreshed, and cognitive problems rated 0 to 3 and headaches, lower-belly pain or cramps, and depression in the past 6 months (Symptom Severity Scale); same level for at least 3 months | Matches when WPI 7+ and SSS 5+ (or WPI 4 to 6 and SSS 9+), pain in at least 4 of 5 regions (jaw, chest, and abdomen not counted for regions), and 3 months; WPI, SSS, and regions are exported |
| Lyme disease | CDC exposure and erythema migrans guidance | Tick attached in the 3 months before symptoms; time outdoors where Lyme disease is common; red rash that grew to at least 2 inches (5 cm) | Not scored; the answers are listed, and an expanding rash prompts a timely visit |
| Depression (added October 15, 2026) | PHQ-9, reproduced verbatim (below) | The 9 PHQ-9 items and its difficulty question | Total 0 to 27 and the published severity, once all 9 items are answered |
| Anxiety (added October 15, 2026) | GAD-7, reproduced verbatim (below) | The 7 GAD-7 items | Total 0 to 21 and the published severity, once all 7 items are answered |

### Part E. PHQ-9 and GAD-7 (verbatim, added October 15, 2026)

Unlike the four checks above, these are the published questionnaires. Sources, read October 15, 2026, from phqscreeners.com, which states: "All PHQ, GAD-7 screeners and translations are downloadable from this website and no permission is required to reproduce, translate, display or distribute them." English: `PHQ-9_English.pdf` and `GAD-7_English.pdf`; Spanish: `PHQ9_Spanish for the USA.pdf` and `GAD7_Spanish for the USA.pdf` (all under `https://www.phqscreeners.com/images/sites/g/files/g10060481/f/201412/`). Papers (DOIs and author lists checked in Crossref): Kroenke K, Spitzer RL, Williams JBW. The PHQ-9: validity of a brief depression severity measure. J Gen Intern Med 2001;16(9):606-613, doi:10.1046/j.1525-1497.2001.016009606.x. Spitzer RL, Kroenke K, Williams JBW, Löwe B. A brief measure for assessing generalized anxiety disorder: the GAD-7. Arch Intern Med 2006;166(10):1092-1097, doi:10.1001/archinte.166.10.1092. Definitions: `CHECKS.phq9` and `CHECKS.gad7` in `web/web/patient/instruments.js`; Spanish in `web/web/patient/strings-es.js`.

PHQ-9 stem: "Over the last 2 weeks, how often have you been bothered by any of the following problems?" Answer choices (both scales): 0 = Not at all, 1 = Several days, 2 = More than half the days, 3 = Nearly every day.

1. Little interest or pleasure in doing things
2. Feeling down, depressed, or hopeless
3. Trouble falling or staying asleep, or sleeping too much
4. Feeling tired or having little energy
5. Poor appetite or overeating
6. Feeling bad about yourself – or that you are a failure or have let yourself or your family down
7. Trouble concentrating on things, such as reading the newspaper or watching television
8. Moving or speaking so slowly that other people could have noticed? Or the opposite – being so fidgety or restless that you have been moving around a lot more than usual
9. Thoughts that you would be better off dead or of hurting yourself in some way

Difficulty question (not scored): "If you checked off any problems, how difficult have these problems made it for you to do your work, take care of things at home, or get along with other people?" Not difficult at all, Somewhat difficult, Very difficult, Extremely difficult.

The English form prints an em dash in items 6 and 8; the app shows a spaced en dash (the punctuation the official US Spanish form uses at the same places) because its copy rules exclude the em dash. No word is changed. The paper instruction to mark answers with a check is not shown.

GAD-7 stem: "Over the last 2 weeks, how often have you been bothered by the following problems?"

1. Feeling nervous, anxious or on edge
2. Not being able to stop or control worrying
3. Worrying too much about different things
4. Trouble relaxing
5. Being so restless that it is hard to sit still
6. Becoming easily annoyed or irritable
7. Feeling afraid as if something awful might happen

Scoring (the PHQ and GAD-7 instruction manual on phqscreeners.com, and the two papers): PHQ-9 total 0 to 27, "Scores of 5, 10, 15, and 20 represent cutpoints for mild, moderate, moderately severe and severe depression"; 0 to 4 is "None-minimal" (manual, Table 4). GAD-7 total 0 to 21, "Scores of 5, 10, and 15 represent cutpoints for mild, moderate, and severe anxiety"; the manual names no level below 5, so the app says "below the cutpoint for mild anxiety". The total and severity are given only when every item is answered. The difficulty question "is not used in calculating any PHQ score".

Safety: PHQ-9 item 9 answered with anything but "Not at all" shows, at once and without a network connection, the 988 Suicide & Crisis Lifeline (call or text 988, or chat at 988lifeline.org; in Spanish, call 988 and press 2, or text AYUDA to 988, as 988lifeline.org/get-help gives it) and "If you are in immediate danger, call 911." It shows under question 9, on the summary page, and at the top of the results; the clinician dashboard puts a notice at the top of From the patient. The QuestionnaireResponse (version 1.3.0) exports `checks.phq9.1` to `.9`, `.difficulty`, `.total`, `.band`, and `checks.gad7.1` to `.7`, `.total`, `.band`; band codes are the ranges (`0-4`, `5-9`, `10-14`, `15-19`, `20-27`; GAD-7 `15-21`). Neither scale is combined with a chart estimate.

## How the two steps combine

- Step 1 (chart): the model's risk band and dated findings.
- Step 2 (patient): RECOVER score and band, PEM screen result, PCFS grade, and the change items, each labeled "patient report" with the date answered.
- Triage rule for the demo: flag for clinician review if the chart band is High **or** the RECOVER score is 11 or more **or** the PEM screen is positive. Do not add the chart probability and the questionnaire score into one number: no data yet tell us how to weight them. The rule is exploratory: it has not been evaluated for sensitivity, workload, or failure cases, and the app labels it so.
- Missing RECOVER answers (added October 11, 2026): an unanswered symptom counts as 0 points, and the app gives no "possible" or "likely" range until every symptom is answered; it shows the points so far as incomplete (QuestionnaireResponse version 1.2.0: `recover.category` code `incomplete`).
- The patient reviews and corrects answers before they are shared (the TOPx Lyme survey request).

## What would make it a scientific result later

A prospective sample (for example, the VUMC post-COVID clinic and primary care) with the questionnaire, the chart score, and a reference standard (clinician diagnosis using the NASEM 2024 definition) would allow likelihood ratios for each part and a calibrated combined score. That is a follow-up study, not something to claim now.

## For the app

Parts B to D are additions to the RECOVER index: show B and C as small cards under the RECOVER result and D as a "What changed since COVID" list. Store answers as a FHIR QuestionnaireResponse.
