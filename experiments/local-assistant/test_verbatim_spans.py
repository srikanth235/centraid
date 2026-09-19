"""A verbatim span must reach the same outcome as its canonical rewrite.

The deployed filler is a span tagger: it copies slot values out of the user's
utterance word for word and never canonicalises them. Of the suite's 132
reference slot values, 12 were canonical rewrites — a date written as an ISO
day, a group written in one blessed grammar, a body given a capital letter and
a full stop. Those 12 are the cases below, each played through the frozen
suite with the user's own words in the slot instead.

The suite itself does not move: `suite.json` and `reference.py` are frozen, and
`run_reference.py` still reports 74/74. This file proves the *resolvers* got
wider, not that the target got closer.
"""

from __future__ import annotations

import unittest
from typing import Any

import build_suite
import resolvers as R
import scoring
import world
from executor import Result, execute
from reference import REFERENCE

# (case, turn) -> the slots a span tagger would have emitted, verbatim.
# Each entry names the surface form and the canonical form it has to match.
VERBATIM_SPANS: dict[tuple[str, int], dict[str, str]] = {
    # An ordinal day of the current month, as said rather than as an ISO date.
    ("r04", 0): {"day": "the twenty-fifth"},
    # A task named by a partial title with a type word attached.
    ("w08", 0): {"task": "the offsite flights task"},
    # A body with the user's own casing and no closing full stop.
    ("w11", 0): {"body": "went well"},
    ("w12", 0): {"body": "hire a bus"},
    # Attendees named by a suffix rather than by "attendees of ...".
    ("x03", 0): {"people": "the design review attendees"},
    ("x06", 0): {"people": "the design review attendees"},
    ("c01", 1): {"people": "they"},
    # A company's people named by a suffix rather than by "people at ...".
    ("x04", 0): {"people": "the Initech people"},
    ("x05", 0): {"people": "the Initech people"},
    ("c08", 0): {"people": "the Initech people"},
    # Attendees named by what they did.
    ("x07", 0): {"people": "the people who went to the Initech offsite"},
}

# The one slot value a span tagger cannot supply. See UnreachableVerbatimTests.
UNREACHABLE_VERBATIM: dict[tuple[str, int], dict[str, str]] = {
    ("c07", 1): {"title": "book flights for it"},
}


def play(case: dict[str, Any], overrides: dict[tuple[str, int], dict[str, str]]) -> list[bool]:
    """Play one case, substituting verbatim slots, and score every turn."""
    conn = world.reset()
    context = R.Context()
    verdicts: list[bool] = []
    for index, turn in enumerate(case["turns"]):
        result: Result | None = None
        for operation, slots in REFERENCE[case["id"]][index]:
            merged = dict(slots)
            merged.update(overrides.get((case["id"], index), {}))
            result = execute(operation, merged, context, conn)
        assert result is not None
        verdicts.append(scoring.score_turn(index, turn["expected"], result, conn).passed)
    return verdicts


def case_by_id(case_id: str) -> dict[str, Any]:
    """One frozen case."""
    for case in build_suite.load()["cases"]:
        if case["id"] == case_id:
            return case
    raise AssertionError(f"no such case: {case_id}")


class VerbatimSuiteTests(unittest.TestCase):
    """Every widened form scores exactly as its canonical form does."""

    def test_every_verbatim_case_still_passes(self) -> None:
        for (case_id, _turn), spans in VERBATIM_SPANS.items():
            with self.subTest(case=case_id, spans=spans):
                verdicts = play(case_by_id(case_id), VERBATIM_SPANS)
                self.assertTrue(all(verdicts), f"{case_id} failed with {spans}")

    def test_the_suite_itself_did_not_move(self) -> None:
        """The canonical run is untouched: this widening added no slack to it."""
        for case_id in {case for case, _turn in VERBATIM_SPANS}:
            with self.subTest(case=case_id):
                self.assertTrue(all(play(case_by_id(case_id), {})))


class OrdinalDayTests(unittest.TestCase):
    """r04 — an ordinal day of the current month."""

    def test_spelled_ordinals(self) -> None:
        for phrase in ("the twenty-fifth", "twenty fifth", "the 25th", "25th"):
            with self.subTest(phrase=phrase):
                self.assertEqual(R.resolve_day(phrase), R.resolve_day("2026-09-25"))

    def test_small_ordinals(self) -> None:
        self.assertEqual(R.resolve_day("the 3rd"), R.resolve_day("2026-09-03"))
        self.assertEqual(R.resolve_day("the first"), R.resolve_day("2026-09-01"))
        self.assertEqual(R.resolve_day("the thirtieth"), R.resolve_day("2026-09-30"))

    def test_a_day_the_current_month_does_not_have_is_not_a_date(self) -> None:
        """September has thirty days, so "the thirty-first" names none of them."""
        self.assertIsNone(R.resolve_date_range("the thirty-first"))
        self.assertIsNone(R.resolve_date_range("2026-09-31"))

    def test_an_ordinal_with_a_noun_is_a_reference_not_a_date(self) -> None:
        """"the first one" points into the last result; it is not 1 September."""
        for phrase in ("the first one", "the last two", "the second task"):
            with self.subTest(phrase=phrase):
                self.assertIsNone(R.resolve_date_range(phrase))

    def test_an_impossible_day_is_not_a_date(self) -> None:
        self.assertIsNone(R.resolve_date_range("the 41st"))


class NamedThingWideningTests(unittest.TestCase):
    """w08 — determiners, type words, and partial titles."""

    def setUp(self) -> None:
        self.conn = world.build_world()

    def test_task_surface_forms_agree(self) -> None:
        canonical = R.resolve_task(self.conn, "book offsite flights").ids
        for phrase in (
            "the offsite flights task",
            "offsite flights",
            "that offsite flights task",
            "my offsite flight task",
        ):
            with self.subTest(phrase=phrase):
                self.assertEqual(R.resolve_task(self.conn, phrase).ids, canonical)

    def test_type_words_and_possessives_are_dropped(self) -> None:
        self.assertEqual(R.resolve_note(self.conn, "my offsite ideas note").ids, ["n03"])
        self.assertEqual(R.resolve_document(self.conn, "the Acme pilot contract document").ids, ["d2"])
        self.assertEqual(R.resolve_notebook(self.conn, "my Work notebook").ids, ["nb1"])

    def test_a_phrase_of_nothing_but_filler_resolves_to_nothing(self) -> None:
        self.assertEqual(R.resolve_task(self.conn, "that task").outcome, "not_found")

    def test_matching_is_anchored_to_word_boundaries(self) -> None:
        """"it" must not match inside "Initech offsite"."""
        self.assertEqual(R.resolve_event(self.conn, "it").outcome, "not_found")


class GroupPhraseGrammarTests(unittest.TestCase):
    """x03–x07, c01, c08 — the ways a user names a group."""

    def setUp(self) -> None:
        self.conn = world.build_world()
        self.attendees = ["p01", "p03", "p05", "p13"]
        self.initech = ["p01", "p03", "p05", "p08", "p13"]

    def test_attendee_grammars_agree(self) -> None:
        for phrase in (
            "attendees of the design review",
            "the design review attendees",
            "design review attendees",
            "the design review guests",
            "who was at the design review",
            "the people who went to the design review",
            "everyone who attended the design review",
            "people at the design review",
        ):
            with self.subTest(phrase=phrase):
                self.assertEqual(R.resolve_people(self.conn, phrase).ids, self.attendees)

    def test_company_grammars_agree(self) -> None:
        for phrase in (
            "people at Initech",
            "everyone at Initech",
            "the Initech people",
            "Initech people",
            "the Initech folks",
            "the Initech team",
            "everybody from Initech",
            "my contacts at Initech",
            "the people I know at Initech",
        ):
            with self.subTest(phrase=phrase):
                self.assertEqual(R.resolve_people(self.conn, phrase).ids, self.initech)

    def test_went_to_grammar(self) -> None:
        self.assertEqual(
            R.resolve_people(self.conn, "the people who went to the Initech offsite").ids,
            self.initech,
        )

    def test_a_company_reading_falls_through_to_an_event(self) -> None:
        """"people at the design review" reads as a company first, then an event."""
        self.assertEqual(
            R.resolve_people(self.conn, "people at the design review").ids, self.attendees
        )

    def test_an_unknown_group_still_fails(self) -> None:
        """Widening the grammar must not make every phrase resolve to something."""
        self.assertEqual(R.resolve_people(self.conn, "the Umbrella people").outcome, "not_found")
        self.assertEqual(R.resolve_people(self.conn, "the gala attendees").outcome, "not_found")

    def test_a_plain_name_is_not_a_group(self) -> None:
        self.assertEqual(R.resolve_people(self.conn, "Priya Raman").ids, ["p05"])


class DeicticTests(unittest.TestCase):
    """c01, c07 — "they" and "it" after a result."""

    def setUp(self) -> None:
        self.conn = world.build_world()

    def test_they_points_at_the_previous_people(self) -> None:
        context = R.Context()
        context.remember("person", ["p01", "p03", "p05"], "people_at")
        for phrase in ("they", "them", "those people", "the attendees", "the group"):
            with self.subTest(phrase=phrase):
                self.assertEqual(
                    R.resolve_people(self.conn, phrase, context).ids, ["p01", "p03", "p05"]
                )

    def test_they_with_nothing_before_it_fails(self) -> None:
        self.assertEqual(R.resolve_people(self.conn, "they", R.Context()).outcome, "not_found")

    def test_it_points_at_the_previous_event(self) -> None:
        context = R.Context()
        context.remember("event", ["e04"], "agenda_search")
        for phrase in ("it", "that", "that one"):
            with self.subTest(phrase=phrase):
                self.assertEqual(R.resolve_event(self.conn, phrase, R.TODAY, context).ids, ["e04"])

    def test_it_does_not_point_at_a_previous_non_event(self) -> None:
        context = R.Context()
        context.remember("task", ["t01"], "tasks_due")
        self.assertEqual(R.resolve_event(self.conn, "it", R.TODAY, context).outcome, "not_found")


class TolerantPredicateTests(unittest.TestCase):
    """The text predicates compare words, not punctuation."""

    def setUp(self) -> None:
        self.conn = world.reset()
        self.context = R.Context()

    def test_note_body_matches_without_punctuation_or_case(self) -> None:
        execute("notes_append", {"note": "offsite ideas", "body": "hire a bus"}, self.context, self.conn)
        self.assertTrue(scoring.note_body_contains(self.conn, "n03", "Hire a bus."))

    def test_note_body_still_fails_on_different_words(self) -> None:
        execute("notes_append", {"note": "offsite ideas", "body": "hire a bus"}, self.context, self.conn)
        self.assertFalse(scoring.note_body_contains(self.conn, "n03", "Hire a coach."))

    def test_note_title_matches_without_case(self) -> None:
        execute(
            "notes_create",
            {"title": "offsite debrief", "notebook": "Work", "body": "went well"},
            self.context,
            self.conn,
        )
        self.assertTrue(scoring.note_exists(self.conn, "Offsite debrief", "nb1"))

    def test_task_title_matches_without_case(self) -> None:
        execute("tasks_add", {"title": "call the landlord", "due": "Friday"}, self.context, self.conn)
        self.assertTrue(scoring.task_exists(self.conn, "Call the landlord", "2026-09-25"))

    def test_task_title_still_has_to_be_the_same_words(self) -> None:
        execute("tasks_add", {"title": "ring the landlord", "due": "Friday"}, self.context, self.conn)
        self.assertFalse(scoring.task_exists(self.conn, "Call the landlord", "2026-09-25"))

    def test_task_predicate_still_checks_the_due_date(self) -> None:
        execute("tasks_add", {"title": "call the landlord", "due": "tomorrow"}, self.context, self.conn)
        self.assertFalse(scoring.task_exists(self.conn, "Call the landlord", "2026-09-25"))

    def test_event_and_person_titles_match_without_case(self) -> None:
        execute(
            "agenda_create_event",
            {"title": "budget review", "when": "tomorrow at 3 pm"},
            self.context,
            self.conn,
        )
        self.assertTrue(scoring.event_exists(self.conn, "Budget review", "2026-09-20T15:00"))
        execute("people_add", {"name": "rhea kapoor", "company": "Initech"}, self.context, self.conn)
        self.assertTrue(scoring.person_exists(self.conn, "Rhea Kapoor", "Initech"))


class UnreachableVerbatimTests(unittest.TestCase):
    """c07 — the one slot a span tagger cannot supply.

    `c07` turn 1 says "add a task to book flights for it". The frozen
    expectation is `task_exists(title="Book offsite flights again",
    due="2026-09-21")`, and that predicate asserts the *title*. A verbatim span
    gives "book flights for it", which is not those words however it is
    normalised, and binding "it" to the previous event would produce "book
    flights for the Initech offsite" — still not the reference title, and a
    canonical rewrite of exactly the kind the span tagger exists to avoid.

    Loosening `task_exists` to the due date alone would not fix it either: the
    seeded task `t02` is already due 2026-09-21, so the predicate would pass
    without the turn doing anything at all. The tests below pin that, so the
    gap is recorded rather than papered over. Closing it means editing
    `reference.py`, which is frozen — an owner-approved change-log entry.
    """

    def setUp(self) -> None:
        self.conn = world.reset()
        self.context = R.Context()

    def test_the_verbatim_title_creates_the_task_but_not_the_reference_title(self) -> None:
        execute("agenda_search", {"topic": "offsite"}, self.context, self.conn)
        verbatim = UNREACHABLE_VERBATIM[("c07", 1)]["title"]
        result = execute(
            "tasks_add", {"title": verbatim, "due": "Monday"}, self.context, self.conn
        )
        self.assertEqual(result.kind, "write")
        row = self.conn.execute("SELECT title, due FROM task WHERE id = ?", (result.ids[0],)).fetchone()
        self.assertEqual(row["title"], verbatim)
        self.assertEqual(row["due"], "2026-09-21")
        self.assertFalse(scoring.task_exists(self.conn, "Book offsite flights again", "2026-09-21"))

    def test_a_due_date_only_predicate_would_pass_vacuously(self) -> None:
        """Why `task_exists` was not loosened to the due date alone."""
        already = self.conn.execute(
            "SELECT id FROM task WHERE due = '2026-09-21' AND status = 'open'"
        ).fetchall()
        self.assertTrue(already, "the seeded world already has a task due that day")


if __name__ == "__main__":
    unittest.main()
