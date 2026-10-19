// Short, non-diagnostic links from questionnaire answers to the conditions they can inform.
// The scorer supplies the results; this module only chooses presentation and next steps.

import { EN_T } from "./i18n.js";

export function buildSummarySignals({ recover, recoverApplicable, pem, pcfs, pcfsApplicable, checks = [] }, t = EN_T) {
  const items = [];
  const add = (id, tone, value, advice, { zero = false, status = tone, condition = id } = {}) => {
    items.push({
      id, tone, status, condition: t(`summary.condition.${condition}`), label: t(`summary.label.${id}`),
      value, advice: t(`summary.advice.${advice}`), zero,
    });
  };

  if (!recoverApplicable) {
    add("recover", "unscored", t("summary.value.notScored"), "recoverNotScored");
  } else if (recover.category === "not-started") {
    add("recover", "unscored", t("summary.value.notAnswered"), "recoverNotAnswered");
  } else {
    const tone = recover.meetsCutoff ? "review" : recover.complete && recover.points === 0 ? "low" : "watch";
    const value = t(recover.complete ? "summary.value.points" : "summary.value.pointsSoFar", { pts: t.n("recover.points", recover.points) });
    let advice;
    if (recover.meetsCutoff) advice = recover.complete ? "recoverReview" : "recoverReviewSoFar";
    else if (!recover.complete) advice = "recoverIncomplete";
    else advice = recover.points === 0 ? "recoverLow" : "recoverWatch";
    add("recover", tone, value, advice, { zero: recover.points === 0, status: !recover.complete && !recover.meetsCutoff ? "incomplete" : tone });
  }

  const pemTone = { positive: "review", negative: "low", incomplete: "watch", "not-started": "unscored" }[pem.status] || "unscored";
  const pemAdvice = recoverApplicable
    ? { positive: "pemReview", negative: "pemLow", incomplete: "pemIncomplete", "not-started": "pemNotAnswered" }
    : { positive: "pemReviewMecfs", negative: "pemLowMecfs", incomplete: "pemIncompleteMecfs", "not-started": "pemNotAnsweredMecfs" };
  add("pem", pemTone, t(`summary.value.pem.${pem.status === "positive" || pem.status === "negative" || pem.status === "incomplete" ? pem.status : "notStarted"}`),
    pemAdvice[pem.status] || pemAdvice["not-started"],
    { status: pem.status === "incomplete" ? "incomplete" : pemTone, condition: recoverApplicable ? "pem" : "mecfs" });

  if (pcfsApplicable) {
    if (!pcfs) add("pcfs", "unscored", t("summary.value.notAnswered"), "pcfsNotAnswered");
    else {
      const tone = pcfs.grade === 0 ? "low" : pcfs.grade >= 3 ? "review" : "watch";
      add("pcfs", tone, t("summary.value.pcfs", { grade: pcfs.grade, label: t(`pcfs.grade.${pcfs.grade}.label`) }),
        tone === "low" ? "pcfsLow" : tone === "review" ? "pcfsReview" : "pcfsWatch");
    }
  }

  for (const { id, r } of checks) {
    if (id === "phq9" || id === "gad7") {
      if (id === "phq9" && r.selfHarmPositive) {
        add(id, "review", t("summary.value.safety"), "safety", { status: "urgent" });
      } else if (r.status === "complete") {
        const tone = r.total >= 10 ? "review" : r.total >= 5 ? "watch" : "low";
        add(id, tone, t("summary.value.score", { n: r.total }), tone === "review" ? "scaleReview" : tone === "watch" ? "scaleWatch" : "scaleLow");
      } else {
        add(id, r.status === "incomplete" ? "watch" : "unscored", t(r.status === "incomplete" ? "summary.value.notFinished" : "summary.value.notAnswered"),
          r.status === "incomplete" ? "scaleIncomplete" : "scaleNotAnswered", { status: r.status === "incomplete" ? "incomplete" : "unscored" });
      }
    } else if (id === "lyme") {
      const answers = Object.values(r.answers);
      if (r.rash) add(id, "review", t("summary.value.rash"), "rash");
      else if (r.exposure) add(id, "watch", t("summary.value.exposure"), "lymeExposure");
      else if (answers.every((answer) => answer === "no")) add(id, "low", t("summary.value.noExposure"), "lymeLow");
      else if (answers.every((answer) => answer)) add(id, "watch", t("summary.value.uncertainExposure"), "lymeUnsure");
      else add(id, r.status === "not-started" ? "unscored" : "watch", t(r.status === "not-started" ? "summary.value.notAnswered" : "summary.value.notFinished"),
        r.status === "not-started" ? "lymeNotAnswered" : "lymeIncomplete", { status: r.status === "not-started" ? "unscored" : "incomplete" });
    } else if (r.status === "match") {
      add(id, "review", t("summary.value.check"), `${id}Match`);
    } else if (r.status === "no-match") {
      add(id, "low", t("summary.value.noMatch"), `${id}Low`);
    } else if (id === "longcovid" && r.status === "unsure") {
      add(id, "watch", t("summary.value.notSure"), "longcovidUnsure");
    } else {
      add(id, r.status === "not-started" ? "unscored" : "watch", t(r.status === "not-started" ? "summary.value.notAnswered" : "summary.value.notFinished"),
        r.status === "not-started" ? "checkNotAnswered" : "checkIncomplete", { status: r.status === "not-started" ? "unscored" : "incomplete" });
    }
  }
  return items;
}
