#!/usr/bin/env python3
"""Tests for upload_sandbox.py; these tests never contact the sandbox."""

import contextlib
import copy
import datetime as dt
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import upload_sandbox as uploader
from score_fhir import score_bundle  # upload_sandbox puts model/reference on the path


class UploadSandboxTest(unittest.TestCase):
    target = dt.date(2026, 10, 13)

    def test_every_bundle_becomes_an_idempotent_transaction(self):
        paths = uploader.choose_paths([])
        self.assertEqual(len(paths), 18)
        for path in paths:
            source = uploader.load_bundle(path)
            original = copy.deepcopy(source)
            transaction = uploader.transaction_for(source, path, self.target)

            self.assertEqual(source, original, f"source changed for {path.name}")
            self.assertEqual(transaction["type"], "transaction")
            self.assertEqual(len(transaction["entry"]), len(source["entry"]))
            for source_entry, target_entry in zip(source["entry"], transaction["entry"]):
                resource = source_entry["resource"]
                self.assertEqual(target_entry["resource"]["id"], resource["id"])
                self.assertEqual(
                    target_entry["resource"]["resourceType"], resource["resourceType"]
                )
                self.assertEqual(target_entry.get("fullUrl"), source_entry.get("fullUrl"))
                self.assertEqual(
                    target_entry["request"],
                    {"method": "PUT", "url": f"{resource['resourceType']}/{resource['id']}"},
                )

    def test_patient_ids_remain_the_filename_stems(self):
        for path in uploader.choose_paths([]):
            transaction = uploader.transaction_for(
                uploader.load_bundle(path), path, self.target
            )
            self.assertEqual(uploader.patient_id(transaction), path.stem)

    def test_dates_shift_without_changing_ids_or_references(self):
        path = uploader.BUNDLES_DIR / "maria.json"
        source = uploader.load_bundle(path)
        shifted = uploader.shift_bundle_dates(source, self.target)
        resources = [entry["resource"] for entry in shifted["entry"]]
        patient = next(r for r in resources if r["resourceType"] == "Patient")
        covid = next(
            r for r in resources
            if r["resourceType"] == "Condition"
            and any(c.get("code") == "U07.1" for c in r["code"]["coding"])
        )
        self.assertEqual(patient["id"], "maria")
        self.assertEqual(patient["birthDate"], "1982-07-14")
        self.assertEqual(covid["subject"]["reference"], "Patient/maria")
        self.assertEqual(covid["onsetDateTime"], "2026-05-21")
        self.assertEqual(source["entry"][0]["resource"]["birthDate"], "1980-03-02")

    def test_partial_dates_are_resolved_using_scorer_rules(self):
        days = (self.target - uploader.SOURCE_AS_OF).days
        self.assertEqual(uploader.shift_date("2024-01", days), "2026-05-14")
        self.assertEqual(
            uploader.shift_date("1983", days, birth_date=True), "1985-11-11"
        )
        self.assertEqual(uploader.shift_date("not-a-date", days), "not-a-date")
        self.assertEqual(uploader.shift_date("1988-5", days), "1988-5")

    def test_pre_training_cutoff_covid_remains_excluded(self):
        path = uploader.BUNDLES_DIR / "will.json"
        shifted = uploader.shift_bundle_dates(uploader.load_bundle(path), self.target)
        old_covid = next(
            entry["resource"]
            for entry in shifted["entry"]
            if entry["resource"].get("id") == "will-cond-4"
        )
        recent_covid = next(
            entry["resource"]
            for entry in shifted["entry"]
            if entry["resource"].get("id") == "will-cond-5"
        )
        self.assertEqual(old_covid["onsetDateTime"], "2021-03-15")
        self.assertEqual(recent_covid["onsetDateTime"], "2026-04-17")

    def test_only_date_elements_shift(self):
        # maria's propranolol is RxNorm 8787, which also reads as the year 8787
        shifted = uploader.shift_bundle_dates(
            uploader.load_bundle(uploader.BUNDLES_DIR / "maria.json"), self.target
        )
        med = next(
            entry["resource"]
            for entry in shifted["entry"]
            if entry["resource"]["resourceType"] == "MedicationRequest"
        )
        self.assertEqual(med["medicationCodeableConcept"]["coding"][0]["code"], "8787")
        self.assertEqual(med["authoredOn"], "2026-07-24")

        resource = {
            "resourceType": "Observation",
            "id": "x",
            "code": {"coding": [{"code": "2024"}], "text": "2024-01-01"},
            "valueString": "2024-05-01",
            "effectiveDateTime": "2024-05-01T08:30:00-04:00",
            "effectivePeriod": {"start": "2024-05-01", "end": "2024-05-02"},
            "issued": "2024-05-02T12:00:00Z",
        }
        bundle = {"resourceType": "Bundle", "type": "collection", "entry": [{"resource": resource}]}
        out = uploader.shift_bundle_dates(bundle, self.target)["entry"][0]["resource"]
        self.assertEqual(out["code"], resource["code"])
        self.assertEqual(out["valueString"], "2024-05-01")
        self.assertEqual(out["effectiveDateTime"], "2026-09-12T08:30:00-04:00")
        self.assertEqual(out["effectivePeriod"], {"start": "2026-09-12", "end": "2026-09-13"})
        self.assertEqual(out["issued"], "2026-09-13T12:00:00Z")

    def test_records_after_the_scoring_date_stay_in_the_future(self):
        # will-cond-10 (2024-07-15) tests that a Long COVID code after the scoring date is ignored
        shifted = uploader.shift_bundle_dates(
            uploader.load_bundle(uploader.BUNDLES_DIR / "will.json"), self.target
        )
        later = next(
            entry["resource"]
            for entry in shifted["entry"]
            if entry["resource"]["id"] == "will-cond-10"
        )
        offset = (dt.date.fromisoformat(later["onsetDateTime"]) - self.target).days
        self.assertEqual(offset, 44 + uploader.FUTURE_GAP_DAYS)
        self.assertEqual(later["recordedDate"], later["onsetDateTime"])

    def test_demo_personas_carry_their_questionnaire_answers(self):
        for path in uploader.choose_paths([]):
            chart = uploader.load_chart(path)
            answers = [
                entry["resource"]
                for entry in chart["entry"]
                if entry["resource"]["resourceType"] == "QuestionnaireResponse"
            ]
            if path.stem not in {"maria", "elena", "sofia", "dana"}:
                self.assertEqual(answers, [], path.stem)
                continue
            self.assertEqual(len(answers), 1, path.stem)
            self.assertEqual(answers[0]["id"], f"{path.stem}-qr-1")
            self.assertEqual(answers[0]["subject"], {"reference": f"Patient/{path.stem}"})
            transaction = uploader.transaction_for(chart, path, self.target)
            sent = transaction["entry"][-1]
            self.assertEqual(
                sent["request"],
                {"method": "PUT", "url": f"QuestionnaireResponse/{path.stem}-qr-1"},
            )
        maria = uploader.transaction_for(
            uploader.load_chart(uploader.BUNDLES_DIR / "maria.json"),
            uploader.BUNDLES_DIR / "maria.json",
            self.target,
        )["entry"][-1]["resource"]
        timeline = next(item for item in maria["item"] if item["linkId"] == "timeline")
        answers = {item["linkId"]: item["answer"][0] for item in timeline["item"]}
        self.assertEqual(maria["authored"], "2026-10-09T12:00:00Z")
        self.assertEqual(answers["timeline.covid-date"], {"valueDate": "2026-05-21"})
        self.assertEqual(answers["timeline.onset"], {"valueDate": "2026-06-02"})

    def test_shifted_charts_score_as_the_fixtures_do(self):
        # the reference scorer gives every shifted chart, on the upload date and 90 days later, the status, band,
        # probability, and findings it gives the fixture on 2024-06-01
        models = [
            json.loads((uploader.HERE.parent / f"{name}.json").read_text(encoding="utf-8"))
            for name in ("longcovid", "chronicfatigue", "fibromyalgia")
        ]
        for path in uploader.choose_paths([]):
            source = uploader.load_bundle(path)
            shifted = uploader.shift_bundle_dates(source, self.target)
            for model in models:
                want = score_bundle(model, source, uploader.SOURCE_AS_OF)
                for later in (0, 90):
                    got = score_bundle(model, shifted, self.target + dt.timedelta(days=later))
                    label = f"{path.stem} {model['model_id']} day {later}"
                    self.assertEqual(got["status"], want["status"], label)
                    self.assertEqual(got.get("band"), want.get("band"), label)
                    self.assertAlmostEqual(got.get("probability", 0), want.get("probability", 0), places=12, msg=label)
                    self.assertEqual(
                        [d["label"] for d in got.get("drivers", [])],
                        [d["label"] for d in want.get("drivers", [])],
                        label,
                    )

    def test_write_dir_saves_every_transaction_without_sending(self):
        with tempfile.TemporaryDirectory() as tmp:
            with mock.patch.object(uploader, "upload") as send, contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(
                    uploader.main(["--dry-run", "--as-of", "2026-10-13", "--write-dir", tmp]), 0
                )
            send.assert_not_called()
            written = sorted(Path(tmp).glob("*.json"))
            self.assertEqual([p.stem for p in written], [p.stem for p in uploader.choose_paths([])])
            maria = json.loads((Path(tmp) / "maria.json").read_text(encoding="utf-8"))
            self.assertEqual(maria["type"], "transaction")
            bundle = uploader.load_bundle(uploader.BUNDLES_DIR / "maria.json")
            self.assertEqual(len(maria["entry"]), len(bundle["entry"]) + 1)  # plus the questionnaire

    def test_unknown_patient_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "unknown patient"):
            uploader.choose_paths(["not-a-patient"])

    def test_duplicate_target_is_rejected(self):
        path = Path("duplicate.json")
        resource = {"resourceType": "Patient", "id": "same"}
        bundle = {
            "resourceType": "Bundle",
            "type": "collection",
            "entry": [{"resource": resource}, {"resource": copy.deepcopy(resource)}],
        }
        with self.assertRaisesRegex(ValueError, "duplicate resource"):
            uploader.transaction_for(bundle, path, self.target)


if __name__ == "__main__":
    unittest.main()
