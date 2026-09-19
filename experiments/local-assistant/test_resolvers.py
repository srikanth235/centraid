"""Resolver unit tests. Everything here is dated against the injected today."""

from __future__ import annotations

import unittest
from datetime import date

import resolvers as R
import world


class DateTests(unittest.TestCase):
    """Relative date phrases against today = 2026-09-19 (a Saturday)."""

    def test_today_is_injected_not_read(self) -> None:
        self.assertEqual(world.TODAY, date(2026, 9, 19))

    def test_tomorrow(self) -> None:
        window = R.resolve_date_range("tomorrow")
        assert window is not None
        self.assertEqual(window.start, date(2026, 9, 20))
        self.assertEqual(window.end, date(2026, 9, 21))

    def test_next_week_is_the_following_monday_to_sunday(self) -> None:
        window = R.resolve_date_range("next week")
        assert window is not None
        self.assertEqual(window.start, date(2026, 9, 21))
        self.assertEqual(window.end, date(2026, 9, 28))

    def test_this_week_contains_today(self) -> None:
        window = R.resolve_date_range("this week")
        assert window is not None
        self.assertTrue(window.contains(world.TODAY))
        self.assertEqual(window.start, date(2026, 9, 14))

    def test_last_friday_is_before_today(self) -> None:
        day = R.resolve_day("last Friday")
        self.assertEqual(day, date(2026, 9, 18))

    def test_next_thursday_is_after_today(self) -> None:
        day = R.resolve_day("Thursday")
        self.assertEqual(day, date(2026, 9, 24))

    def test_this_month(self) -> None:
        window = R.resolve_date_range("this month")
        assert window is not None
        self.assertEqual(window.start, date(2026, 9, 1))
        self.assertEqual(window.end, date(2026, 10, 1))

    def test_overdue_ends_at_today(self) -> None:
        window = R.resolve_date_range("anything overdue")
        assert window is not None
        self.assertEqual(window.end, world.TODAY)

    def test_iso_day(self) -> None:
        window = R.resolve_date_range("2026-10-02")
        assert window is not None
        self.assertEqual(window.start, date(2026, 10, 2))

    def test_non_date_phrase_is_none(self) -> None:
        self.assertIsNone(R.resolve_date_range("the invoices export"))

    def test_datetime_reads_a_clock(self) -> None:
        self.assertEqual(R.resolve_datetime("tomorrow at 3 pm"), "2026-09-20T15:00")

    def test_datetime_defaults_to_nine(self) -> None:
        self.assertEqual(R.resolve_datetime("Thursday"), "2026-09-24T09:00")

    def test_datetime_reads_a_part_of_day(self) -> None:
        self.assertEqual(R.resolve_datetime("Friday morning"), "2026-09-25T09:00")


class PersonTests(unittest.TestCase):
    """Names, nicknames and the ambiguity that forces a clarify."""

    def setUp(self) -> None:
        self.conn = world.build_world()

    def test_full_name(self) -> None:
        self.assertEqual(R.resolve_person(self.conn, "Priya Raman").ids, ["p05"])

    def test_unique_first_name(self) -> None:
        self.assertEqual(R.resolve_person(self.conn, "Priya").ids, ["p05"])

    def test_nickname(self) -> None:
        self.assertEqual(R.resolve_person(self.conn, "Ibbi").ids, ["p12"])

    def test_shared_first_name_is_ambiguous(self) -> None:
        found = R.resolve_person(self.conn, "Neha")
        self.assertEqual(found.outcome, "ambiguous")
        self.assertEqual(sorted(found.candidates), ["p01", "p02"])

    def test_company_disambiguates(self) -> None:
        self.assertEqual(R.resolve_person(self.conn, "Neha", company="Hooli").ids, ["p02"])

    def test_unknown_name_is_not_found(self) -> None:
        self.assertEqual(R.resolve_person(self.conn, "Zebedee").outcome, "not_found")

    def test_candidate_labels_are_human(self) -> None:
        found = R.resolve_person(self.conn, "Marcus")
        labels = R.describe(self.conn, found)
        self.assertEqual(labels, ["Marcus Reed (Initech)", "Marcus Oyelaran (Acme)"])


class GroupPhraseTests(unittest.TestCase):
    """Group phrases are the cross-app-as-one-call mechanism."""

    def setUp(self) -> None:
        self.conn = world.build_world()

    def test_people_at_a_company(self) -> None:
        found = R.resolve_people(self.conn, "people at Initech")
        self.assertEqual(found.ids, ["p01", "p03", "p05", "p08", "p13"])

    def test_everyone_at_a_company(self) -> None:
        self.assertEqual(
            R.resolve_people(self.conn, "everyone at Hooli").ids, ["p02", "p06", "p11", "p14"]
        )

    def test_attendees_of_an_event(self) -> None:
        found = R.resolve_people(self.conn, "attendees of the design review")
        self.assertEqual(found.ids, ["p01", "p03", "p05", "p13"])

    def test_who_was_at_an_event(self) -> None:
        found = R.resolve_people(self.conn, "who was at the Initech offsite")
        self.assertEqual(found.ids, ["p01", "p03", "p05", "p08", "p13"])

    def test_everyone_i_owe(self) -> None:
        found = R.resolve_people(self.conn, "everyone I owe")
        self.assertEqual(found.ids, ["p03", "p06", "p07", "p09", "p11", "p14"])

    def test_explicit_list(self) -> None:
        found = R.resolve_people(self.conn, "Priya and Marcus Reed")
        self.assertEqual(found.ids, ["p03", "p05"])

    def test_explicit_list_propagates_ambiguity(self) -> None:
        found = R.resolve_people(self.conn, "Priya and Neha")
        self.assertEqual(found.outcome, "ambiguous")

    def test_unknown_company_is_not_found(self) -> None:
        self.assertEqual(R.resolve_people(self.conn, "people at Umbrella").outcome, "not_found")


class EventTests(unittest.TestCase):
    """Event phrases: title fuzz, optionally narrowed by a date word."""

    def setUp(self) -> None:
        self.conn = world.build_world()

    def test_title_phrase(self) -> None:
        self.assertEqual(R.resolve_event(self.conn, "the design review").ids, ["e01"])

    def test_title_with_a_date_word(self) -> None:
        self.assertEqual(R.resolve_event(self.conn, "the retro").ids, ["e06"])

    def test_date_word_narrows(self) -> None:
        self.assertEqual(R.resolve_event(self.conn, "standup tomorrow").ids, ["e12"])

    def test_unknown_event(self) -> None:
        self.assertEqual(R.resolve_event(self.conn, "the gala").outcome, "not_found")


class ReferenceTests(unittest.TestCase):
    """Ordinal and deictic references into the previous result."""

    def setUp(self) -> None:
        self.conn = world.build_world()
        self.ctx = R.Context()
        self.ctx.remember("photo", ["ph05", "ph06", "ph07"], "photos_in_album")

    def test_no_previous_result(self) -> None:
        self.assertEqual(R.resolve_reference(self.conn, "the first one", R.Context()).outcome, "not_found")

    def test_first(self) -> None:
        self.assertEqual(R.resolve_reference(self.conn, "the first one", self.ctx).ids, ["ph05"])

    def test_second(self) -> None:
        self.assertEqual(R.resolve_reference(self.conn, "the second one", self.ctx).ids, ["ph06"])

    def test_last(self) -> None:
        self.assertEqual(R.resolve_reference(self.conn, "the last one", self.ctx).ids, ["ph07"])

    def test_first_two(self) -> None:
        self.assertEqual(R.resolve_reference(self.conn, "the first two", self.ctx).ids, ["ph05", "ph06"])

    def test_whole_result(self) -> None:
        self.assertEqual(R.resolve_reference(self.conn, "those", self.ctx).ids, ["ph05", "ph06", "ph07"])

    def test_ordinal_past_the_end(self) -> None:
        self.assertEqual(R.resolve_reference(self.conn, "the fifth one", self.ctx).outcome, "not_found")

    def test_kind_mismatch_is_refused(self) -> None:
        found = R.resolve_reference(self.conn, "the first one", self.ctx, kind="task")
        self.assertEqual(found.outcome, "not_found")

    def test_filter_previous_photos_by_person(self) -> None:
        found = R.resolve_reference(self.conn, "only the ones with Marcus Reed", self.ctx)
        self.assertEqual(found.ids, ["ph06"])

    def test_filter_previous_people_by_person(self) -> None:
        ctx = R.Context()
        ctx.remember("person", ["p01", "p03", "p05"], "people_at")
        found = R.resolve_people(self.conn, "only the ones with Priya", ctx)
        self.assertEqual(found.ids, ["p05"])

    def test_filter_with_nothing_left(self) -> None:
        found = R.resolve_reference(self.conn, "only the ones with Lena", self.ctx)
        self.assertEqual(found.outcome, "not_found")

    def test_deictic_people_go_through_the_reference_path(self) -> None:
        ctx = R.Context()
        ctx.remember("person", ["p01", "p03"], "people_at")
        self.assertEqual(R.resolve_people(self.conn, "those people", ctx).ids, ["p01", "p03"])


class NamedThingTests(unittest.TestCase):
    """Tasks, notes, documents, locker items and containers by name."""

    def setUp(self) -> None:
        self.conn = world.build_world()

    def test_task_by_phrase(self) -> None:
        self.assertEqual(R.resolve_task(self.conn, "the domain renewal").ids, ["t01"])

    def test_task_phrase_can_be_ambiguous(self) -> None:
        found = R.resolve_task(self.conn, "renew")
        self.assertEqual(found.outcome, "ambiguous")
        self.assertEqual(sorted(found.candidates), ["t01", "t06"])

    def test_note_by_phrase(self) -> None:
        self.assertEqual(R.resolve_note(self.conn, "the offsite ideas note").ids, ["n03"])

    def test_document_by_phrase(self) -> None:
        self.assertEqual(R.resolve_document(self.conn, "the Acme pilot contract").ids, ["d2"])

    def test_locker_item_by_phrase(self) -> None:
        self.assertEqual(R.resolve_locker_item(self.conn, "Initech VPN").ids, ["l1"])

    def test_album_folder_notebook_project_group(self) -> None:
        self.assertEqual(R.resolve_album(self.conn, "Goa").ids, ["a1"])
        self.assertEqual(R.resolve_folder(self.conn, "Contracts").ids, ["f1"])
        self.assertEqual(R.resolve_notebook(self.conn, "Work").ids, ["nb1"])
        self.assertEqual(R.resolve_project(self.conn, "Website refresh").ids, ["pr1"])
        self.assertEqual(R.resolve_tally_group(self.conn, "Goa trip").ids, ["g1"])

    def test_named_thing_prefers_a_reference_when_one_fits(self) -> None:
        ctx = R.Context()
        ctx.remember("task", ["t01", "t02"], "tasks_due")
        self.assertEqual(R.resolve_task(self.conn, "the first one", ctx).ids, ["t01"])

    def test_unknown_named_thing(self) -> None:
        self.assertEqual(R.resolve_note(self.conn, "the quarterly haiku").outcome, "not_found")


if __name__ == "__main__":
    unittest.main()
