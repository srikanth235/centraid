"""The loop breaker through the eval driver, with scripted backends (no model, no network).

    python3 -m unittest test_loop          (needs target/debug/nativetools and the seeded vaults)

Runtime side (hint, nudge, cut) is covered by crates/nativetools/tests/tools.rs and reanchor.rs; this checks the
driver's rung: resample once, between the hint and the nudge, and only on a backend that can.
"""

from __future__ import annotations

import json
import unittest
from pathlib import Path

from lib import format_call
from run import Backend, StepOut, run_session

WORLD = "A"
FIND = format_call("find", {"kind": "task"})
ANSWER = format_call("answer", {"kind": "task"})
HINT_HEAD = "error: repeated call. You already made this exact call and it returned: "


def session() -> dict:
    me = json.loads((Path(__file__).parent / "worlds" / f"{WORLD}.json").read_text())["me"]
    return {"id": "loop-1", "world": WORLD, "today": "2026-10-14", "me": me, "turns": [{"user": "what tasks do i have"}]}


class Scripted(Backend):
    """Emits `script` in order (the last text repeats); `alternative` is what a resample returns."""

    name = "scripted"

    def __init__(self, script: list[str], alternative: str | None = None):
        self.script, self.alternative, self.asked, self.resampled = script, alternative, 0, []

    def step(self, transcript, ctx):
        text = self.script[min(self.asked, len(self.script) - 1)]
        self.asked += 1
        return StepOut(text="<think>\nx\n</think>\n\n" + text, think_cut=False)

    def resample(self, transcript, ctx, exclude):
        if self.alternative is None:
            return None
        self.resampled.append(exclude)
        return StepOut(text="<think>\ny\n</think>\n\n" + self.alternative, think_cut=False)


def steps_of(record: dict) -> list[dict]:
    return record["turns"][0]["steps"]


class LoopBreaker(unittest.TestCase):
    def test_hint_then_nudge_then_cut_without_resample(self):
        backend = Scripted([FIND])
        steps = steps_of(run_session(session(), backend))
        self.assertEqual(len(steps), 4)
        texts = [s["response"]["text"] for s in steps]
        self.assertTrue(texts[1].startswith(HINT_HEAD), texts[1])
        self.assertTrue(texts[2].startswith("error: repeated call again."), texts[2])
        self.assertTrue(texts[3].startswith("error: repeated call\nasked: "), texts[3])
        self.assertEqual([s["response"]["ends_turn"] for s in steps], [False, False, False, True])
        # the cut is a typed ask (fail-soft), not a `loop` effect
        self.assertEqual(steps[3]["response"]["effect"]["failsoft"], "loop")
        self.assertEqual(steps[3]["response"]["effect"]["tool"], "ask")
        self.assertEqual(backend.resampled, [])
        self.assertFalse(any("resampled_from" in s for s in steps))

    def test_resample_replaces_the_second_repeat(self):
        backend = Scripted([FIND], alternative=ANSWER)
        steps = steps_of(run_session(session(), backend))
        self.assertEqual(len(steps), 3)
        self.assertTrue(steps[1]["response"]["text"].startswith(HINT_HEAD))
        last = steps[2]
        self.assertTrue(last["response"]["ends_turn"])
        self.assertNotIn("loop", last["response"]["effect"])
        self.assertIn("<function=answer>", last["model"])
        self.assertIn("<function=find>", last["resampled_from"])
        self.assertEqual(len(backend.resampled), 1)
        self.assertIn("<function=find>", backend.resampled[0])

    def test_a_resample_that_repeats_again_gets_the_nudge_then_the_cut(self):
        backend = Scripted([FIND], alternative=FIND)
        steps = steps_of(run_session(session(), backend))
        texts = [s["response"]["text"] for s in steps]
        self.assertEqual(len(steps), 4)
        self.assertTrue(texts[2].startswith("error: repeated call again."))
        self.assertTrue(texts[3].startswith("error: repeated call"), texts[3])
        self.assertEqual(len(backend.resampled), 1, "resampled once per turn")

    def test_changing_the_call_after_the_hint_carries_on(self):
        backend = Scripted([FIND, FIND, ANSWER], alternative=ANSWER)
        steps = steps_of(run_session(session(), backend))
        self.assertEqual(len(steps), 3)
        self.assertTrue(steps[2]["response"]["ends_turn"])
        self.assertEqual(backend.resampled, [])


if __name__ == "__main__":
    unittest.main()
