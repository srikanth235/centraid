"""Executor unit tests: reads return ids, writes mutate the world."""

from __future__ import annotations

import unittest

import executor
import resolvers as R
import world
from catalogue import OPERATIONS, by_name


class CatalogueContractTests(unittest.TestCase):
    """The catalogue and the executor are one roster seen twice."""

    def test_every_operation_has_a_handler(self) -> None:
        self.assertEqual(executor.catalogue_is_covered(), [])

    def test_every_handler_is_in_the_catalogue(self) -> None:
        self.assertEqual(sorted(set(executor.HANDLERS) - set(by_name())), [])

    def test_generated_json_matches_the_python(self) -> None:
        """``catalogue.json`` holds exactly what ``catalogue.py`` declares.

        Parsed, not byte for byte: oxfmt owns JSON whitespace in this
        repository, so the file on disk is reformatted after generation.
        """
        import catalogue
        import json

        on_disk = json.loads(catalogue.json_path().read_text(encoding="utf-8"))
        self.assertEqual(on_disk, catalogue.catalogue())

    def test_names_are_unique(self) -> None:
        names = [op["name"] for op in OPERATIONS]
        self.assertEqual(len(names), len(set(names)))

    def test_no_one_required_string_sink(self) -> None:
        """Brief fact 5: a lone required string slot needs sibling contrast."""
        for op in OPERATIONS:
            required = [n for n, p in op["params"].items() if p["required"]]
            if len(required) == 1 and op["params"][required[0]]["type"] == "string":
                self.assertTrue(
                    op["siblings"],
                    f"{op['name']} is a one-required-string operation with no declared sibling",
                )

    def test_siblings_resolve_and_are_not_self(self) -> None:
        names = set(by_name())
        for op in OPERATIONS:
            for sibling in op["siblings"]:
                self.assertIn(sibling, names, f"{op['name']} names a missing sibling {sibling}")
                self.assertNotEqual(sibling, op["name"])

    def test_none_and_clarify_are_not_operations(self) -> None:
        self.assertNotIn("none", by_name())
        self.assertNotIn("clarify", by_name())


class ReadTests(unittest.TestCase):
    """Reads are parameterised SQL and return ids."""

    def setUp(self) -> None:
        self.conn = world.reset()
        self.ctx = R.Context()

    def run_op(self, op: str, **slots: object) -> executor.Result:
        """One turn."""
        return executor.execute(op, dict(slots), self.ctx, self.conn)

    def test_agenda_upcoming_is_ordered_by_start(self) -> None:
        result = self.run_op("agenda_upcoming", window="next week")
        self.assertEqual(result.ids, ["e02", "e03", "e04", "e05"])

    def test_agenda_upcoming_filters_by_calendar(self) -> None:
        result = self.run_op("agenda_upcoming", window="next week", calendar="personal")
        self.assertEqual(result.ids, ["e05"])

    def test_agenda_search_is_not_bounded_by_a_window(self) -> None:
        result = self.run_op("agenda_search", topic="onboarding")
        self.assertEqual(result.ids, ["e01", "e08"])

    def test_agenda_day_context_mixes_events_and_tasks(self) -> None:
        result = self.run_op("agenda_day_context", day="2026-09-25")
        self.assertEqual(result.ids, ["e05", "t01"])

    def test_people_at_an_event(self) -> None:
        self.assertEqual(
            self.run_op("people_at", event="the design review").ids, ["p01", "p03", "p05", "p13"]
        )

    def test_people_at_filters_by_response(self) -> None:
        result = self.run_op("people_at", event="the design review", response="accepted")
        self.assertEqual(result.ids, ["p01", "p03", "p05"])

    def test_tasks_due_and_tasks_about_are_different_slices(self) -> None:
        due = self.run_op("tasks_due", window="this week").ids
        about = self.run_op("tasks_about", topic="migration").ids
        self.assertEqual(due, ["t08", "t13", "t04"])
        self.assertEqual(about, ["t03", "t17", "t25"])
        self.assertNotEqual(due, about)

    def test_tasks_by_project(self) -> None:
        self.assertEqual(
            self.run_op("tasks_by_project", project="Migration").ids, ["t03", "t09", "t17", "t23", "t25"]
        )

    def test_tasks_for_a_group_phrase(self) -> None:
        result = self.run_op("tasks_for_people", people="people at Initech")
        self.assertEqual(result.ids, ["t02", "t03", "t05", "t09", "t12", "t17", "t18", "t23", "t25"])

    def test_people_find_ambiguity_is_a_clarify(self) -> None:
        result = self.run_op("people_find", name="Neha")
        self.assertEqual((result.kind, result.reason), ("no_action", "clarify"))

    def test_people_find_unknown_is_a_refusal(self) -> None:
        result = self.run_op("people_find", name="Zebedee")
        self.assertEqual((result.kind, result.reason), ("no_action", "refuse"))

    def test_people_at_company(self) -> None:
        self.assertEqual(
            self.run_op("people_at_company", company="Acme").ids, ["p04", "p07", "p10"]
        )

    def test_notes_search_versus_notebook(self) -> None:
        self.assertEqual(self.run_op("notes_search", topic="onboarding").ids, ["n02", "n07"])
        self.assertEqual(
            self.run_op("notes_in_notebook", notebook="Journal").ids, ["n05", "n08", "n11", "n15"]
        )

    def test_notes_about_a_group_phrase(self) -> None:
        result = self.run_op("notes_about_people", people="attendees of the design review")
        self.assertEqual(result.ids, ["n02", "n04", "n11"])

    def test_photos_three_slices_differ(self) -> None:
        self.assertEqual(self.run_op("photos_in_album", album="Goa").ids, ["ph05", "ph06", "ph07", "ph13", "ph14", "ph19"])
        self.assertEqual(self.run_op("photos_by_date", window="last week").ids, ["ph04", "ph05", "ph06", "ph07", "ph19", "ph20"])
        self.assertEqual(self.run_op("photos_of_people", people="Lena").ids, ["ph03", "ph04", "ph09", "ph11", "ph17"])

    def test_photos_at_place_with_no_match_refuses(self) -> None:
        result = self.run_op("photos_at_place", place="Reykjavik")
        self.assertEqual((result.kind, result.reason), ("no_action", "refuse"))

    def test_docs_search_and_folder(self) -> None:
        self.assertEqual(self.run_op("docs_search", topic="Initech").ids, ["d1", "d4"])
        self.assertEqual(self.run_op("docs_in_folder", folder="Contracts").ids, ["d1", "d2"])

    def test_docs_search_filters_by_kind(self) -> None:
        self.assertEqual(self.run_op("docs_search", topic="Initech", kind="sheet").ids, ["d4"])

    def test_locker_find_and_watchtower(self) -> None:
        self.assertEqual(self.run_op("locker_find", service="Initech VPN").ids, ["l1"])
        self.assertEqual(self.run_op("locker_weak", reason="any").ids, ["l1", "l5"])
        self.assertEqual(self.run_op("locker_weak", reason="reused").ids, ["l1"])

    def test_tally_balance_with_a_cross_app_phrase(self) -> None:
        result = self.run_op("tally_balance_with", people="attendees of the design review")
        self.assertEqual(result.ids, ["p01", "p03", "p05", "p13"])

    def test_tally_balance_direction_narrows(self) -> None:
        result = self.run_op(
            "tally_balance_with", people="attendees of the design review", direction="i_owe"
        )
        self.assertEqual(result.ids, ["p03"])

    def test_tally_who_owes_me_both_directions(self) -> None:
        self.assertEqual(
            self.run_op("tally_who_owes_me", direction="owed_to_me").ids,
            ["p01", "p05", "p08", "p12", "p13", "p15"],
        )
        self.assertEqual(
            self.run_op("tally_who_owes_me", direction="i_owe").ids,
            ["p03", "p06", "p07", "p09", "p11", "p14"],
        )

    def test_tally_group_balance(self) -> None:
        self.assertEqual(
            self.run_op("tally_group_balance", group="Goa trip").ids,
            ["p01", "p03", "p05", "p08", "p13"],
        )

    def test_tally_expenses_are_not_the_balance(self) -> None:
        self.assertEqual(
            self.run_op("tally_expenses_with", people="Marcus Reed").ids, ["x03", "x10"]
        )


class WriteTests(unittest.TestCase):
    """Writes are typed commands; each asserts against the world afterwards."""

    def setUp(self) -> None:
        self.conn = world.reset()
        self.ctx = R.Context()

    def run_op(self, op: str, **slots: object) -> executor.Result:
        """One turn."""
        return executor.execute(op, dict(slots), self.ctx, self.conn)

    def test_create_event_with_a_group_phrase(self) -> None:
        result = self.run_op(
            "agenda_create_event", title="Retro", when="tomorrow at 3 pm", attendees="people at Initech"
        )
        self.assertEqual(result.kind, "write")
        row = self.conn.execute("SELECT * FROM event WHERE id = ?", (result.ids[0],)).fetchone()
        self.assertEqual(row["starts"], "2026-09-20T15:00")
        guests = [
            r["person_id"]
            for r in self.conn.execute(
                "SELECT person_id FROM attendee WHERE event_id = ? ORDER BY person_id", (result.ids[0],)
            )
        ]
        self.assertEqual(guests, ["p01", "p03", "p05", "p08", "p13"])

    def test_reschedule_moves_only_the_time(self) -> None:
        self.run_op("agenda_reschedule", event="the design review", when="Thursday")
        row = self.conn.execute("SELECT starts, title FROM event WHERE id = 'e01'").fetchone()
        self.assertEqual(row["starts"], "2026-09-24T09:00")
        self.assertEqual(row["title"], "Design review")

    def test_cancel_leaves_the_row_but_flips_status(self) -> None:
        self.run_op("agenda_cancel_event", event="the Initech offsite")
        row = self.conn.execute("SELECT status FROM event WHERE id = 'e04'").fetchone()
        self.assertEqual(row["status"], "cancelled")

    def test_attendee_add_does_not_move_the_event(self) -> None:
        before = self.conn.execute("SELECT starts FROM event WHERE id = 'e02'").fetchone()["starts"]
        self.run_op("agenda_attendee_add", event="sprint planning", people="Priya and Grace")
        after = self.conn.execute("SELECT starts FROM event WHERE id = 'e02'").fetchone()["starts"]
        self.assertEqual(before, after)
        guests = [
            r["person_id"]
            for r in self.conn.execute(
                "SELECT person_id FROM attendee WHERE event_id = 'e02' ORDER BY person_id"
            )
        ]
        self.assertEqual(guests, ["p03", "p05", "p08", "p13"])

    def test_tasks_add_with_a_due_phrase(self) -> None:
        result = self.run_op("tasks_add", title="Renew the domain again", due="next Friday")
        row = self.conn.execute("SELECT * FROM task WHERE id = ?", (result.ids[0],)).fetchone()
        self.assertEqual(row["due"], "2026-09-25")
        self.assertEqual(row["status"], "open")

    def test_tasks_complete_changes_status_not_due(self) -> None:
        before = self.conn.execute("SELECT due FROM task WHERE id = 't01'").fetchone()["due"]
        self.run_op("tasks_complete", task="the domain renewal")
        row = self.conn.execute("SELECT status, due FROM task WHERE id = 't01'").fetchone()
        self.assertEqual(row["status"], "done")
        self.assertEqual(row["due"], before)

    def test_tasks_set_due_changes_due_not_status(self) -> None:
        self.run_op("tasks_set_due", task="the domain renewal", due="next month")
        row = self.conn.execute("SELECT status, due FROM task WHERE id = 't01'").fetchone()
        self.assertEqual(row["due"], "2026-10-01")
        self.assertEqual(row["status"], "open")

    def test_tasks_assign(self) -> None:
        self.run_op("tasks_assign", task="book offsite flights", people="Priya")
        rows = [
            r["person_id"]
            for r in self.conn.execute("SELECT person_id FROM task_assignee WHERE task_id = 't04'")
        ]
        self.assertEqual(rows, ["p05"])

    def test_people_add(self) -> None:
        result = self.run_op("people_add", name="Rhea Kapoor", company="Initech")
        row = self.conn.execute("SELECT * FROM person WHERE id = ?", (result.ids[0],)).fetchone()
        self.assertEqual(row["full_name"], "Rhea Kapoor")
        self.assertEqual(row["first_name"], "Rhea")

    def test_log_interaction_defaults_to_today(self) -> None:
        self.run_op("people_log_interaction", person="Priya", channel="call")
        row = self.conn.execute(
            "SELECT happened FROM interaction WHERE person_id = 'p05' ORDER BY id DESC"
        ).fetchone()
        self.assertEqual(row["happened"], "2026-09-19")

    def test_people_add_note_is_not_an_interaction(self) -> None:
        before = self.conn.execute("SELECT COUNT(*) AS n FROM interaction").fetchone()["n"]
        self.run_op("people_add_note", person="Priya", body="Left for Berlin.")
        after = self.conn.execute("SELECT COUNT(*) AS n FROM interaction").fetchone()["n"]
        self.assertEqual(before, after)
        row = self.conn.execute(
            "SELECT body FROM person_note WHERE person_id = 'p05'"
        ).fetchone()
        self.assertEqual(row["body"], "Left for Berlin.")

    def test_notes_create_with_people(self) -> None:
        result = self.run_op(
            "notes_create", title="Offsite debrief", body="Went well.", notebook="Work", people="Priya"
        )
        row = self.conn.execute("SELECT * FROM note WHERE id = ?", (result.ids[0],)).fetchone()
        self.assertEqual(row["notebook_id"], "nb1")
        linked = self.conn.execute(
            "SELECT person_id FROM note_person WHERE note_id = ?", (result.ids[0],)
        ).fetchone()
        self.assertEqual(linked["person_id"], "p05")

    def test_notes_append_keeps_what_was_there(self) -> None:
        self.run_op("notes_append", note="offsite ideas", body="Also: hire a bus.")
        row = self.conn.execute("SELECT body FROM note WHERE id = 'n03'").fetchone()
        self.assertTrue(row["body"].startswith("Book the venue"))
        self.assertIn("hire a bus", row["body"])

    def test_photos_add_to_album_needs_a_previous_result(self) -> None:
        result = self.run_op("photos_add_to_album", photos="those", album="Goa")
        self.assertEqual((result.kind, result.reason), ("no_action", "refuse"))

    def test_photos_add_to_album_after_a_read(self) -> None:
        self.run_op("photos_of_people", people="Lena")
        result = self.run_op("photos_add_to_album", photos="the first two", album="Family")
        self.assertEqual(result.ids, ["ph03", "ph04"])
        rows = [
            r["photo_id"]
            for r in self.conn.execute(
                "SELECT photo_id FROM photo_album WHERE album_id = 'a3' ORDER BY photo_id"
            )
        ]
        self.assertEqual(rows, ["ph03", "ph04", "ph17"])

    def test_docs_star_versus_move(self) -> None:
        self.run_op("docs_star", docs="the Acme pilot contract")
        self.assertEqual(
            self.conn.execute("SELECT starred, folder_id FROM document WHERE id = 'd2'").fetchone()["starred"], 1
        )
        self.run_op("docs_move", docs="the migration runbook", folder="Personal")
        self.assertEqual(
            self.conn.execute("SELECT folder_id FROM document WHERE id = 'd8'").fetchone()["folder_id"], "f3"
        )

    def test_locker_add_requires_a_kind(self) -> None:
        result = self.run_op("locker_add", service="Hooli VPN")
        self.assertEqual((result.kind, result.reason), ("no_action", "clarify"))

    def test_locker_add(self) -> None:
        result = self.run_op("locker_add", service="Hooli VPN", kind="login", username="srikanth")
        row = self.conn.execute("SELECT * FROM locker_item WHERE id = ?", (result.ids[0],)).fetchone()
        self.assertEqual(row["service"], "Hooli VPN")
        self.assertIsNone(row["health"])

    def test_tally_add_expense_splits_evenly(self) -> None:
        result = self.run_op(
            "tally_add_expense", description="Dinner", amount=1200, people="Priya and Grace"
        )
        amounts = [
            r["amount"]
            for r in self.conn.execute(
                "SELECT amount FROM tally_entry WHERE id IN (?,?)", tuple(result.ids)
            )
        ]
        self.assertEqual(amounts, [400.0, 400.0])

    def test_tally_settle_up_zeroes_the_balance(self) -> None:
        self.run_op("tally_settle_up", people="Priya")
        remaining = self.conn.execute(
            "SELECT COUNT(*) AS n FROM tally_entry WHERE person_id = 'p05' AND settled = 0"
        ).fetchone()["n"]
        self.assertEqual(remaining, 0)

    def test_settle_up_across_a_group_phrase(self) -> None:
        self.run_op("tally_settle_up", people="everyone I owe")
        left = self.conn.execute(
            "SELECT COUNT(*) AS n FROM tally_entry WHERE settled = 0 AND amount < 0"
        ).fetchone()["n"]
        self.assertEqual(left, 0)


class ProtocolTests(unittest.TestCase):
    """The no-action outcomes and the context the executor maintains."""

    def setUp(self) -> None:
        self.conn = world.reset()
        self.ctx = R.Context()

    def test_none_is_a_refusal(self) -> None:
        result = executor.execute("none", {}, self.ctx, self.conn)
        self.assertEqual((result.kind, result.reason), ("no_action", "refuse"))

    def test_clarify_is_a_clarify(self) -> None:
        result = executor.execute("clarify", {}, self.ctx, self.conn)
        self.assertEqual((result.kind, result.reason), ("no_action", "clarify"))

    def test_unknown_operation_is_refused_not_raised(self) -> None:
        result = executor.execute("agenda_teleport", {}, self.ctx, self.conn)
        self.assertEqual((result.kind, result.reason), ("no_action", "refuse"))

    def test_context_remembers_the_last_result(self) -> None:
        executor.execute("photos_in_album", {"album": "Goa"}, self.ctx, self.conn)
        self.assertEqual(self.ctx.last_kind, "photo")
        self.assertEqual(self.ctx.last_operation, "photos_in_album")
        self.assertEqual(len(self.ctx.last_ids), 6)

    def test_a_no_action_turn_does_not_clobber_the_last_result(self) -> None:
        executor.execute("photos_in_album", {"album": "Goa"}, self.ctx, self.conn)
        executor.execute("people_find", {"name": "Neha"}, self.ctx, self.conn)
        self.assertEqual(self.ctx.last_kind, "photo")

    def test_a_write_never_lands_when_a_slot_fails_to_resolve(self) -> None:
        before = self.conn.execute("SELECT COUNT(*) AS n FROM task").fetchone()["n"]
        result = executor.execute(
            "tasks_add", {"title": "Ship it", "assignee": "Zebedee"}, self.ctx, self.conn
        )
        self.assertEqual(result.kind, "no_action")
        after = self.conn.execute("SELECT COUNT(*) AS n FROM task").fetchone()["n"]
        self.assertEqual(before, after)

    def test_each_world_is_independent(self) -> None:
        other = world.reset()
        executor.execute("tasks_complete", {"task": "the domain renewal"}, self.ctx, self.conn)
        self.assertEqual(
            other.execute("SELECT status FROM task WHERE id = 't01'").fetchone()["status"], "open"
        )


if __name__ == "__main__":
    unittest.main()
