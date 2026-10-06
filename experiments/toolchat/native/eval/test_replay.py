"""Unit tests for replay.py / slices.py / metrics.py (no runtime needed).

    python3 -m unittest test_replay -v      # from experiments/toolchat/native/eval
"""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import metrics
import replay
import run as driver
import slices


def failed(g, o, *p, i="S-1", t=1):
    return {"id": i, "turn": t, "gold_type": g, "got": o, "problems": list(p)}


class SlicesTest(unittest.TestCase):
    def test_classes(self):
        cases = [(failed("diff", "loop"), "no answer: loop/cap"),
                 (failed("diff", "ask"), "wrong type: asked, gold writes"),
                 (failed("ask", "act"), "wrong type: acted, gold asks"),
                 (failed("rows", "rows", "rows differ: extra ['a'] missing []"), "rows: over-inclusive (extra only)"),
                 (failed("diff", "act", "missing change on x {'a': 1}", "unwanted updated of person y ['a']"),
                  "write: missing + unwanted"),
                 (failed("value", "value", "value"), "value: wrong number/unit")]
        for x, cls in cases:
            self.assertEqual(slices.classify(x), cls)

    def test_partition_and_flags(self):
        fs = [failed("diff", "act", "missing change on x {'date': '2026-01-01'}", t=2),
              failed("rows", "rows", "rows differ: extra [] missing ['q']", t=3),
              failed("diff", "ask", "ended in ask, want a write", i="S-2", t=1)]
        gold = [{"id": "S-1", "turns": [{"user": "a"}, {"user": "move that to 7"}, {"user": "c"}]},
                {"id": "S-2", "turns": [{"user": "d"}]}]
        recs = slices.slice_failed(fs, gold)
        self.assertTrue(recs[0]["has_anaphor"] and recs[0]["dropped_arg"] and recs[0]["date_field_mismatch"])
        self.assertTrue(recs[0]["first_failure_in_session"] and recs[1]["downstream"])
        with tempfile.TemporaryDirectory() as d:
            counts = slices.write_slices(recs, d)
            self.assertEqual(sum(counts.values()), len(fs))
            self.assertEqual(sum(1 for _ in Path(d).glob("slice-*.jsonl")), len(counts))


class MetricsTest(unittest.TestCase):
    def test_schema(self):
        m = metrics.build("n", "r", "g", 4, 3, 10, 8, {"c": 2}, ["S:t1"], [], [])
        self.assertEqual(metrics.validate(m), [])
        self.assertAlmostEqual(m["turn_pass_rate"], 0.8)
        bad = dict(m)
        del bad["notes"]
        self.assertTrue(metrics.validate(bad))
        self.assertIn("flipped_up 1", metrics.diff_table(m, m))


class DivergenceTest(unittest.TestCase):
    def step(self, ends, text="t"):
        return {"response": {"ends_turn": ends, "text": text}}

    def test_divergence(self):
        rec = {"turns": [{"steps": [self.step(False), self.step(True)]}, {"steps": [self.step(True)]}]}
        new = {"turns": [{"steps": [self.step(True)]}, {"steps": [self.step(True, "other")]}]}
        d = replay.divergence(rec, new, [])
        self.assertTrue(d[0]["diverged"])  # ended earlier
        self.assertFalse(d[1]["diverged"])
        self.assertEqual(d[1]["response_changed"], 1)

    def test_a_retraction_the_runtime_now_ends_is_not_a_divergence(self):
        ended = {"model": "", "runtime": "never_mind",
                 "response": {"ends_turn": True, "text": "declined: never_mind"}}
        rec = {"turns": [{"steps": [self.step(False), self.step(False), self.step(True)]}]}
        new = {"turns": [{"steps": [ended]}]}
        d = replay.divergence(rec, new, [])
        self.assertEqual(d[0], {"diverged": False, "response_changed": 0})
        # a recording that was itself the runtime's ending, or one with no such turn, is the same
        self.assertEqual(replay.divergence({"turns": new["turns"]}, new, [])[0]["diverged"], False)
        self.assertEqual(replay.divergence(None, new, [])[0]["diverged"], False)
        # an ordinary one-step turn that ends differently still diverges
        plain = {"turns": [{"steps": [self.step(True)]}]}
        self.assertTrue(replay.divergence(rec, plain, [])[0]["diverged"])


class FakeRuntime:
    """A runtime that ends the turn at once for the message "never mind" (what `Session::user` does for a
    retraction) and answers nothing else: the driver must not ask the model for a step."""

    started: list[list[str]] = []  # the `flags` of every runtime started

    def __init__(self, *args, **kwargs):
        FakeRuntime.started.append(list(kwargs.get("flags") or []))

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def req(self, obj):
        if obj["op"] == "prompt":
            return {"rendered": "<|im_start|>system\nx<|im_end|>\n", "system": ""}
        assert obj["op"] == "user", obj
        ended = {"text": "declined: never_mind", "ends_turn": True, "obs": 0, "step": 1,
                 "effect": {"tool": "decline", "decline": {"reason": "never_mind"}}}
        return {"block": None, "compacted": [], **({"ended": ended} if obj["text"] == "never mind" else {})}


class DriverRetraction(unittest.TestCase):
    def test_a_retraction_records_a_synthetic_step_and_sends_no_model_step(self):
        class NoModel(driver.Backend):
            name = "none"

            def step(self, transcript, ctx):
                raise AssertionError("the runtime ended the turn: no model step")

        world = json.loads((Path(__file__).parent / "worlds" / "A.json").read_text())
        session = {"id": "r-1", "world": "A", "today": "2026-10-14", "me": world["me"],
                   "turns": [{"user": "never mind"}]}
        with mock.patch.object(driver, "Runtime", FakeRuntime):
            record = driver.run_session(session, NoModel())
        steps = record["turns"][0]["steps"]
        self.assertEqual(len(steps), 1)
        self.assertEqual((steps[0]["model"], steps[0]["runtime"]), ("", "never_mind"))
        self.assertEqual(steps[0]["response"]["effect"]["decline"], {"reason": "never_mind"})
        self.assertTrue(steps[0]["response"]["ends_turn"])
        # score.py reads the turn's ending from that step alone
        import lib

        effect = lib.turn_effect(steps)
        self.assertEqual((effect["kind"], effect["reason"]), ("decline", "never_mind"))


class RuntimeFlags(unittest.TestCase):
    """A reference run starts the runtime with `--no-normalize` (the gold is the author's intent, not a repaired
    call); a model run keeps the repairs on."""

    @staticmethod
    def flags_of(backend) -> list[str]:
        world = json.loads((Path(__file__).parent / "worlds" / "A.json").read_text())
        session = {"id": "f-1", "world": "A", "today": "2026-10-14", "me": world["me"],
                   "turns": [{"user": "never mind", "ref": []}]}
        FakeRuntime.started.clear()
        with mock.patch.object(driver, "Runtime", FakeRuntime):
            driver.run_session(session, backend)
        return FakeRuntime.started[0]

    def test_the_ref_backend_starts_the_runtime_without_normalising(self):
        flags = self.flags_of(driver.RefBackend())
        self.assertIn("--no-normalize", flags)
        self.assertEqual(flags[:2], ["--tools", driver.RefBackend.tools_mode])

    def test_a_backend_that_subclasses_the_ref_backend_inherits_it(self):
        class Authored(driver.RefBackend):
            name = "authored"

        self.assertIn("--no-normalize", self.flags_of(Authored()))

    def test_a_model_backend_keeps_the_repairs(self):
        class Model(driver.Backend):
            name = "model"

        self.assertNotIn("--no-normalize", self.flags_of(Model()))


if __name__ == "__main__":
    unittest.main()
