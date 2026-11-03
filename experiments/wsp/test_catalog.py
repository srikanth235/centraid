import json
import tempfile
import unittest
from pathlib import Path

import catalog

CAT = catalog.load()


class DerivationRules(unittest.TestCase):
    def test_counts(self):
        kinds = [(e["type"], e["card"]) for e in CAT.values()]
        self.assertEqual(sum(t == "action" for t, _ in kinds), 154)
        self.assertEqual(sum(t == "view" for t, _ in kinds), 55)
        self.assertEqual(sum(c for _, c in kinds), 29)

    def test_create_id_dropped(self):
        e = CAT["agenda.propose"]
        self.assertNotIn("id", e["params"])
        self.assertIn("id", e["dropped"])
        self.assertNotIn("target", e["params"])

    def test_non_create_id_is_target(self):
        t = CAT["agenda.edit-event"]["params"]["target"]
        self.assertEqual(t, {"type": "mention", "of": "event", "required": True})

    def test_id_suffix_to_mention(self):
        p = CAT["agenda.propose"]["params"]
        self.assertEqual(p["calendar"], {"type": "mention", "of": "calendar", "required": False})
        self.assertEqual(p["attendees"]["items"], "mention")
        self.assertEqual(p["attendees"]["type"], "list")
        self.assertEqual(CAT["money.categorize"]["params"]["targets"]["type"], "list")

    def test_dates_and_repeat(self):
        p = CAT["agenda.propose"]["params"]
        self.assertEqual(p["starts"]["type"], "when")
        self.assertEqual(p["repeat"]["type"], "when")
        self.assertNotIn("rule", p)
        self.assertEqual(CAT["agenda.upcoming"]["params"]["from"]["type"], "when")
        self.assertEqual(CAT["money.spending"]["params"]["month"]["type"], "when")

    def test_edge_from_to_are_mentions(self):
        self.assertEqual(CAT["photos.add-to-album"]["params"]["to"]["of"], "album")
        self.assertNotIn("rel", CAT["photos.add-to-album"]["params"])

    def test_amounts(self):
        self.assertEqual(CAT["money.set-target"]["params"]["amount"]["type"], "amount")
        self.assertEqual(CAT["money.record-checkpoint"]["params"]["balance"]["type"], "amount")

    def test_enum_bool_number(self):
        p = CAT["agenda.propose"]["params"]
        self.assertEqual(p["status"]["values"], ["confirmed", "tentative", "cancelled"])
        self.assertEqual(p["busy"]["type"], "bool")
        self.assertEqual(CAT["agenda.add-task"]["params"]["priority"]["type"], "number")
        self.assertEqual(CAT["agenda.board"]["params"]["limit"]["type"], "number")

    def test_plumbing_dropped(self):
        d = CAT["agenda.propose"]["dropped"]
        self.assertIn("zone", d)
        self.assertIn("timing", d)
        self.assertIn("origin", CAT["health.follow-workouts"]["dropped"])
        self.assertIn("after", CAT["photos.shelf"]["dropped"])

    def test_sealed_fields_dropped_and_card(self):
        e = CAT["locker.add-item"]
        self.assertTrue(e["card"])
        for f in ("password", "otp_seed", "card_number", "cvv", "content"):
            self.assertNotIn(f, e["params"])
            self.assertIn(f, e["dropped"])
        self.assertIn("username", e["params"])

    def test_confirmation_and_bulk_are_card(self):
        self.assertTrue(CAT["agenda.purge-task"]["card"])      # confirmation required
        self.assertTrue(CAT["money.categorize"]["card"])       # bulk
        self.assertFalse(CAT["agenda.propose"]["card"])
        self.assertTrue(CAT["locker.reveal"]["card"])

    def test_views_never_card(self):
        self.assertFalse(any(e["card"] for e in CAT.values() if e["type"] == "view"))

    def test_record_days_flattened(self):
        p = CAT["health.record-days"]["params"]
        self.assertEqual(set(p) & {"day", "metric", "value"}, {"day", "metric", "value"})

    def test_summaries(self):
        for e in CAT.values():
            s = e["summary"]
            self.assertLessEqual(len(s), 162, e["id"])
            self.assertNotRegex(s, r"#\d+", e["id"])
            self.assertNotRegex(s, r"through [a-z]+\.[a-z_]+", e["id"])
            self.assertTrue(s.endswith("."), e["id"])
        self.assertTrue(CAT["agenda.propose"]["summary"].startswith("Propose an event"))

    def test_param_names_unique_and_typed(self):
        ok = {"text", "mention", "when", "amount", "number", "bool", "enum", "list"}
        for e in CAT.values():
            for n, spec in e["params"].items():
                self.assertIn(spec["type"], ok, (e["id"], n))
                if spec["type"] == "enum":
                    self.assertTrue(spec["values"])
                if spec["type"] == "list":
                    self.assertIn("items", spec)


class Determinism(unittest.TestCase):
    def test_sorted_entries_and_hashes(self):
        data = catalog.build()
        ids = [e["id"] for e in data["entries"]]
        self.assertEqual(ids, sorted(ids))
        self.assertEqual(len(data["manifests"]), 8)
        self.assertNotIn("crates/apps/kit/manifest.json", data["manifests"])

    def test_build_is_stable(self):
        self.assertEqual(catalog.dumps(catalog.build()), catalog.dumps(catalog.build()))

    def test_committed_file_is_fresh(self):
        committed = catalog.DEFAULT_PATH.read_text(encoding="utf-8")
        self.assertEqual(committed, catalog.dumps(catalog.build()))
        self.assertTrue(committed.endswith("}\n"))

    def test_write_matches_dumps(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "x" / "schemas.json"
            catalog.write(p)
            self.assertEqual(p.read_text(encoding="utf-8"), catalog.DEFAULT_PATH.read_text(encoding="utf-8"))
            self.assertEqual(set(json.loads(p.read_text())), {"manifests", "entries"})


if __name__ == "__main__":
    unittest.main()
