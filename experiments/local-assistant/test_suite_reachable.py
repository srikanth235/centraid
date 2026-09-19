"""The suite is frozen, well-formed, and reachable with zero failures.

This is the gate the brief puts in front of every model run: if a case here
fails, the evaluation is wrong, and no model result measured against it means
anything.
"""

from __future__ import annotations

import unittest

import build_suite
import scoring
import world
from reference import CASES, CATEGORIES, REFERENCE, category_counts
from run_reference import run_case


class SuiteShapeTests(unittest.TestCase):
    """The frozen file's shape."""

    def setUp(self) -> None:
        self.suite = build_suite.load()

    def test_case_count_is_in_the_briefs_band(self) -> None:
        self.assertGreaterEqual(len(self.suite["cases"]), 60)
        self.assertLessEqual(len(self.suite["cases"]), 80)

    def test_every_category_is_populated(self) -> None:
        counts = category_counts()
        for category in CATEGORIES:
            self.assertGreater(counts[category], 0, f"{category} has no cases")

    def test_case_ids_are_unique(self) -> None:
        ids = [case["id"] for case in self.suite["cases"]]
        self.assertEqual(len(ids), len(set(ids)))

    def test_today_is_frozen_into_the_suite(self) -> None:
        self.assertEqual(self.suite["today"], world.TODAY.isoformat())

    def test_multi_turn_categories_really_are_multi_turn(self) -> None:
        for case in self.suite["cases"]:
            if case["category"] in ("chain", "follow_up", "reference_into_result"):
                self.assertGreater(
                    len(case["turns"]), 1, f"{case['id']} is a {case['category']} with one turn"
                )

    def test_no_read_expectation_is_empty(self) -> None:
        """An empty answer is not a read case; it is a refusal case."""
        for case in self.suite["cases"]:
            for index, turn in enumerate(case["turns"]):
                expected = turn["expected"]
                if expected["type"] == "ids":
                    self.assertTrue(
                        expected["ids"], f"{case['id']} turn {index} expects an empty read"
                    )

    def test_every_write_predicate_exists(self) -> None:
        for case in self.suite["cases"]:
            for turn in case["turns"]:
                expected = turn["expected"]
                if expected["type"] == "write_predicate":
                    self.assertIn(expected["predicate"], scoring.PREDICATES)

    def test_no_action_reasons_are_the_two_the_protocol_names(self) -> None:
        for case in self.suite["cases"]:
            for turn in case["turns"]:
                expected = turn["expected"]
                if expected["type"] == "no_action":
                    self.assertIn(expected["reason"], ("refuse", "clarify"))

    def test_every_case_has_a_reference_sequence(self) -> None:
        self.assertEqual(
            sorted({case["id"] for case in self.suite["cases"]} - set(REFERENCE)), []
        )

    def test_reference_turn_counts_match(self) -> None:
        for case in self.suite["cases"]:
            self.assertEqual(len(REFERENCE[case["id"]]), len(case["turns"]), case["id"])

    def test_the_frozen_file_matches_its_authoring_source(self) -> None:
        """A rebuild from ``reference.py`` reproduces the frozen document.

        This is what makes the file a freeze rather than a snapshot: a change
        to the world, the resolvers or the executor that moves a read's answer
        fails here, instead of silently moving the target with it.

        The comparison is of the parsed document, not of bytes, because oxfmt
        owns the whitespace of every JSON file in the repository and collapses
        short arrays that ``json.dumps`` does not.
        """
        self.assertEqual(build_suite.load(), build_suite.build())


class ReachabilityTests(unittest.TestCase):
    """Every case is reachable: the reference run has zero failures."""

    def test_reference_run_has_no_failures(self) -> None:
        suite = build_suite.load()
        scores = [run_case(case, world.reset()) for case in suite["cases"]]
        failures = [f"{s.case_id}: {s.first_failure}" for s in scores if not s.passed]
        self.assertEqual(failures, [], "\n".join(failures))

    def test_every_case_is_scored(self) -> None:
        suite = build_suite.load()
        scores = [run_case(case, world.reset()) for case in suite["cases"]]
        self.assertEqual(len(scores), len(CASES))
        self.assertEqual(scoring.summarise(scores)["accuracy"], 1.0)


class ScorerTests(unittest.TestCase):
    """The scorer fails what it should fail."""

    def setUp(self) -> None:
        self.conn = world.reset()

    def test_wrong_ids_fail(self) -> None:
        from executor import Result

        expected = {"type": "ids", "entity": "task", "ids": ["t01"], "ordered": False}
        verdict = scoring.score_turn(0, expected, Result("ids", "tasks_due", ["t02"], "task"), self.conn)
        self.assertFalse(verdict.passed)

    def test_order_matters_only_when_asked(self) -> None:
        from executor import Result

        result = Result("ids", "tasks_due", ["t02", "t01"], "task")
        loose = {"type": "ids", "entity": "task", "ids": ["t01", "t02"], "ordered": False}
        strict = {"type": "ids", "entity": "task", "ids": ["t01", "t02"], "ordered": True}
        self.assertTrue(scoring.score_turn(0, loose, result, self.conn).passed)
        self.assertFalse(scoring.score_turn(0, strict, result, self.conn).passed)

    def test_an_unexpected_refusal_fails_a_read(self) -> None:
        from executor import Result

        expected = {"type": "ids", "entity": "task", "ids": ["t01"], "ordered": False}
        refusal = Result("no_action", "tasks_due", reason="refuse", detail="nope")
        self.assertFalse(scoring.score_turn(0, expected, refusal, self.conn).passed)

    def test_the_wrong_no_action_reason_fails(self) -> None:
        from executor import Result

        expected = {"type": "no_action", "reason": "clarify"}
        refusal = Result("no_action", "none", reason="refuse")
        self.assertFalse(scoring.score_turn(0, expected, refusal, self.conn).passed)

    def test_a_write_that_did_not_happen_fails(self) -> None:
        from executor import Result

        expected = {
            "type": "write_predicate",
            "predicate": "task_status",
            "args": {"task_id": "t01", "status": "done"},
        }
        claimed = Result("write", "tasks_complete", ["t01"], "task")
        self.assertFalse(scoring.score_turn(0, expected, claimed, self.conn).passed)

    def test_an_existing_label_is_refused(self) -> None:
        with self.assertRaises(FileExistsError):
            scoring.write_report("reference", "reference", [])

    def test_a_bad_label_is_refused(self) -> None:
        with self.assertRaises(ValueError):
            scoring.write_report("../escape", "reference", [])


if __name__ == "__main__":
    unittest.main()
