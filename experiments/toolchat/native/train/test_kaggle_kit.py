"""Tests for the M6 Kaggle kit's pure parts (#1171): the arm report, the arm comparison and the chosen-arm rule.

    python -m unittest test_kaggle_kit        # from experiments/toolchat/native/train

The kernel itself needs a GPU and Kaggle: here it is only parsed, and make_kit.sh is only syntax-checked.
"""
from __future__ import annotations

import ast
import io
import json
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path

HERE = Path(__file__).resolve().parent
KIT = HERE / "kaggle"
sys.path.insert(0, str(KIT))
import arm_report  # noqa: E402
import compare_arms  # noqa: E402


def wilson(k, n):
    z = 1.96
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * (p * (1 - p) / n + z * z / (4 * n * n)) ** 0.5 / d
    return [max(0.0, c - h), min(1.0, c + h)]


def rate(k, n):
    return {"k": k, "n": n, "rate": k / n, "ci95": wilson(k, n)}


def bucket(turns, failed):
    return {"turns": turns, "failed": failed, "fail_rate": failed / turns, "clean_turns": turns, "clean_failed": failed,
            "clean_fail_rate": failed / turns}


def args(r=0.9):
    return {a: {"right": int(100 * r), "scored": 100, "unscorable": 1, "rate": r, "ci95": [0, 1]} for a in ("rows", "date", "filters", "amount")}


def assist_eval_report(sessions_ok, turns_ok, fail4, errors=0, with_slices=True):
    """A report.json in assist-eval's shape (crates/assist-eval/src/report.rs)."""
    rep = {
        "model": "gguf:abc[tools=sig]", "set": "val.jsonl", "excluded": [],
        "overall": {"sessions": 1000, "set_sessions": 1000, "session_pass": rate(sessions_ok, 1000), "engine_errors": errors},
        "turn_pass": rate(turns_ok, 2000), "clean_turn_pass": rate(turns_ok - 50, 2000),
        "arguments": args(),
        "by_constraints": {"0": bucket(100, 1), "1": bucket(400, 40), "2": bucket(300, 60), "3": bucket(200, 60), "4+": bucket(100, fail4)},
        "by_app": {},
    }
    if with_slices:
        for app in ("Money", "Health", "tasks"):
            rep["by_app"][app] = {"turns": 200, "turn_pass": rate(150, 200), "clean_turn_pass": rate(140, 190), "arguments": args(0.8),
                                  "by_constraints": {"1": bucket(80, 8), "2": bucket(60, 12), "3": bucket(40, 14), "4+": bucket(20, 10)},
                                  "single_app_session_pass": rate(70, 100)}
    return rep


def arm(name, sessions_ok, turns_ok, fail4, errors=0):
    return arm_report.summarise(assist_eval_report(sessions_ok, turns_ok, fail4, errors), name)


class ArmReportTest(unittest.TestCase):
    def test_keeps_the_figures_m6_compares(self):
        r = arm("A", 800, 1800, 40)
        self.assertEqual(r["session_pass"]["rate"], 0.8)
        self.assertEqual(r["turn_pass"]["rate"], 0.9)
        self.assertEqual(sorted(r["arguments"]), ["amount", "date", "filters", "rows"])
        self.assertEqual(sorted(r["fail_by_constraints"]), ["1", "2", "3", "4+"])  # 0 is not in the issue's comparison
        self.assertEqual(r["fail_by_constraints"]["4+"], {"turns": 100, "failed": 40, "fail_rate": 0.4})
        self.assertEqual(sorted(r["slices"]), ["health", "money"])  # found whatever the app ids' case
        self.assertEqual(r["slices"]["money"]["turn_pass"]["rate"], 0.75)
        self.assertEqual(r["slices"]["health"]["session_pass_single_app"]["n"], 100)
        json.dumps(r)

    def test_a_missing_slice_is_none_not_a_crash(self):
        r = arm_report.summarise(assist_eval_report(500, 1500, 10, with_slices=False), "B")
        self.assertEqual(r["slices"], {"money": None, "health": None})

    def test_cli_writes_the_file(self):
        with tempfile.TemporaryDirectory() as d:
            src = Path(d) / "report.json"
            src.write_text(json.dumps(assist_eval_report(800, 1800, 40)))
            with redirect_stdout(io.StringIO()):
                self.assertEqual(arm_report.main([str(src), "--arm", "C"]), 0)
            self.assertEqual(json.loads((Path(d) / "arm-C.val.json").read_text())["arm"], "C")


class ChooseTest(unittest.TestCase):
    def test_clear_winner(self):
        arms = {"A": arm("A", 700, 1700, 60), "B": arm("B", 800, 1800, 50), "C": arm("C", 880, 1900, 30)}
        got = compare_arms.choose(arms)
        self.assertEqual(got["arm"], "C")
        self.assertIn("highest val session pass", got["reason"])

    def test_a_statistical_tie_goes_to_turn_pass(self):
        arms = {"A": arm("A", 800, 1700, 60), "B": arm("B", 805, 1650, 50), "C": arm("C", 790, 1900, 30)}
        got = compare_arms.choose(arms)
        self.assertEqual(got["arm"], "C")  # session pass is tied across all three; C's turn pass is clearly higher
        self.assertIn("statistically tied", got["reason"])

    def test_a_double_tie_goes_to_the_lower_4plus_fail_rate_then_the_letter(self):
        arms = {"A": arm("A", 800, 1800, 60), "B": arm("B", 800, 1800, 40), "C": arm("C", 800, 1800, 40)}
        self.assertEqual(compare_arms.choose(arms)["arm"], "B")

    def test_engine_errors_disqualify(self):
        arms = {"A": arm("A", 900, 1900, 10, errors=3), "B": arm("B", 700, 1700, 60)}
        got = compare_arms.choose(arms)
        self.assertEqual(got["arm"], "B")
        self.assertIn("engine errors", got["reason"])

    def test_s2_is_never_a_candidate(self):
        arms = {"A": arm("A", 500, 1500, 60), "S2": arm("S2", 990, 1990, 1)}
        self.assertEqual(compare_arms.choose(arms)["arm"], "A")

    def test_no_candidate(self):
        self.assertIsNone(compare_arms.choose({"S2": arm("S2", 100, 1800, 10)})["arm"])


class CompareCliTest(unittest.TestCase):
    def test_table_shows_s2_reference_slices_and_the_choice(self):
        with tempfile.TemporaryDirectory() as d:
            paths = []
            for r in (arm("A", 700, 1700, 60), arm("B", 800, 1800, 50), arm("C", 880, 1900, 30), arm("S2", 600, 1600, 70)):
                p = Path(d) / ("arm-%s.val.json" % r["arm"])
                p.write_text(json.dumps(r))
                paths.append(str(p))
            buf = io.StringIO()
            with redirect_stdout(buf):
                code = compare_arms.main(paths + ["--json", str(Path(d) / "out.json")])
            text = buf.getvalue()
            self.assertEqual(code, 0)
            for needle in ("S2 (issue)", " 13.0%", " 67.0%", "Money slice", "Health slice", "chosen arm: C", "reason:"):
                self.assertIn(needle, text)
            self.assertEqual(json.loads((Path(d) / "out.json").read_text())["choice"]["arm"], "C")

    def test_two_reports_for_one_arm_are_refused(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "a.json"
            p.write_text(json.dumps(arm("A", 100, 1800, 10)))
            with self.assertRaises(SystemExit):
                compare_arms.load([p, p])


class KernelTest(unittest.TestCase):
    def test_kernel_parses_and_never_pushes(self):
        src = (KIT / "kernel.py").read_text()
        ast.parse(src)
        self.assertNotIn("kaggle kernels push", src)
        self.assertNotIn("test.jsonl", src)  # test and noise are not fetched
        self.assertNotIn("noise.jsonl", src)
        json.loads((KIT / "kernel-metadata.json").read_text())

    def test_make_kit_is_valid_shell(self):
        done = subprocess.run(["bash", "-n", str(KIT / "make_kit.sh")], capture_output=True, text=True, check=False)
        self.assertEqual(done.returncode, 0, done.stderr)


if __name__ == "__main__":
    unittest.main()
