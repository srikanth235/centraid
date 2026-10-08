"""Retry on a runtime signal (NATIVE_RETRY), through the eval driver with scripted backends (no model).

    python3 -m unittest test_retry          (needs the nativetools binary: test_loop seeds the public household it runs on)

The runtime cannot take a call back, so a retry is the turn's next step: the same step re-drawn with sampling, the
failed call excluded, on the history as it stood before that call (run.py docstring).
"""

from __future__ import annotations

import json
import os
import unittest
from unittest import mock

from lib import format_call
from run import Backend, StepOut, retry_config, retry_counts, retry_signal, run_session
from test_loop import ANSWER, session, steps_of

EMPTY = format_call("find", {"kind": "task", "name": "zzzqq"})  # answered: 0 ... (find_miss), turn open
EMPTY2 = format_call("search", {"text": "zzzqq"})  # recovery: empty, turn open
EMPTY3 = format_call("find", {"kind": "task", "name": "zzzww"})
BAD = format_call("find", {"kind": "nonsense"})  # error: no kind
WRITE = format_call("act", {"verb": "create", "kind": "task", "args": "name: buy milk", "more": True})


def think(call: str, mark: str = "x") -> str:
    return f"<think>\n{mark}\n</think>\n\n{call}"


class Scripted(Backend):
    """`step` emits `script` in order (the last repeats); `resample` returns `alternatives` in order (None = cannot
    sample), recording the excluded call and the history it was drawn on."""

    name = "scripted"

    def __init__(self, script: list[str], alternatives: list[str] | None = None):
        self.script, self.alternatives = script, list(alternatives or [])
        self.asked, self.excluded, self.seen = 0, [], []

    def step(self, transcript, ctx):
        text = self.script[min(self.asked, len(self.script) - 1)]
        self.asked += 1
        return StepOut(text=think(text), think_cut=False)

    def resample(self, transcript, ctx, exclude):
        if not self.alternatives:
            return None
        self.excluded.append(exclude)
        self.seen.append([m["role"] for m in transcript.history()])
        return StepOut(text=think(self.alternatives.pop(0), "y"), think_cut=False)


def run(backend: Backend, retry: str | None, cap: str | None = None) -> dict:
    env = {k: v for k, v in os.environ.items() if k not in ("NATIVE_RETRY", "NATIVE_RETRY_MAX")}
    if retry is not None:
        env["NATIVE_RETRY"] = retry
    if cap is not None:
        env["NATIVE_RETRY_MAX"] = cap
    with mock.patch.dict(os.environ, env, clear=True):
        return run_session(session(), backend)


class Classifier(unittest.TestCase):
    def test_signals(self):
        self.assertEqual(retry_signal({"text": "0 rows match", "effect": {"recovery": "empty"}}), "empty")
        self.assertEqual(retry_signal({"text": 'answered: 0 tasks called "x" match\nhint',
                                       "effect": {"compose": {"action": "find_miss"}}}), "empty")
        self.assertEqual(retry_signal({"text": 'answered: 0 tasks match', "effect": {}}), "empty")
        self.assertEqual(retry_signal({"text": "error: no kind", "effect": {"error": "error: no kind"}}), "error")
        self.assertEqual(retry_signal({"text": "error: could not read the call", "effect": {}}), "error")
        self.assertEqual(retry_signal({"text": "refused: edit x: no.", "effect": {}}), "refused")

    def test_no_signal(self):
        self.assertIsNone(retry_signal({"text": "#1 a task", "effect": {"rows": [{"n": 1}]}}))
        self.assertIsNone(retry_signal({"text": "", "effect": {}}))
        self.assertIsNone(retry_signal({}))

    def test_a_turn_that_ended_is_no_signal(self):
        self.assertIsNone(retry_signal({"text": "answered: 0 tasks match", "ends_turn": True,
                                        "effect": {"answer": {"rows": []}}}))
        self.assertIsNone(retry_signal({"text": "error: x", "ends_turn": True, "effect": {"error": "error: x"}}))

    def test_a_write_is_no_signal_even_beside_an_error(self):
        part = {"text": "error: part landed", "effect": {"error": "error: part landed", "diff": {"rows": [1]}}}
        self.assertIsNone(retry_signal(part))
        self.assertIsNone(retry_signal({"text": "refused: x", "effect": {"created": [{"n": 3}]}}))
        self.assertIsNone(retry_signal({"text": "created", "effect": {"diff": {"rows": [1]}}}))

    def test_the_runtimes_own_loop_breaker_is_no_signal(self):
        self.assertIsNone(retry_signal({"text": "error: repeated call. You already", "effect": {"error": "e", "repeat": 1}}))

    def test_config(self):
        with mock.patch.dict(os.environ, {"NATIVE_RETRY": "empty, error", "NATIVE_RETRY_MAX": "2"}):
            self.assertEqual(retry_config(), (frozenset({"empty", "error"}), 2))
        with mock.patch.dict(os.environ, {"NATIVE_RETRY": ""}):
            self.assertEqual(retry_config(), (frozenset(), 1))
        with mock.patch.dict(os.environ, {"NATIVE_RETRY": "empty,bogus"}):
            with self.assertRaises(SystemExit):
                retry_config()


class Driver(unittest.TestCase):
    def test_default_off_is_unchanged(self):
        base = steps_of(run(Scripted([EMPTY, ANSWER], alternatives=[ANSWER]), None))
        for off in ("", " "):
            backend = Scripted([EMPTY, ANSWER], alternatives=[ANSWER])
            steps = steps_of(run(backend, off))
            self.assertEqual(steps, base)
        self.assertEqual(len(base), 2)
        self.assertEqual(backend.excluded, [])
        self.assertFalse(any("retry" in s for s in base))
        self.assertEqual(retry_counts([{"turns": [{"steps": base}]}]), {})

    def test_an_empty_read_is_redrawn_once_with_the_call_excluded(self):
        backend = Scripted([EMPTY, ANSWER], alternatives=[ANSWER])
        steps = steps_of(run(backend, "empty"))
        self.assertEqual(len(steps), 2)
        self.assertEqual(backend.asked, 1, "the retry is a re-draw, not another model step")
        self.assertEqual(len(backend.excluded), 1)
        self.assertIn('zzzqq', backend.excluded[0])
        self.assertIn("<function=find>", backend.excluded[0])
        self.assertNotIn("retry", steps[0])
        self.assertEqual(steps[1]["retry"], "empty")
        self.assertEqual(set(steps[1]), {"model", "response", "think_cut", "retry"})  # no `override` / `decoding` any more
        self.assertIn("<function=answer>", steps[1]["model"])
        self.assertTrue(steps[1]["response"]["ends_turn"])
        # the first call really ran: it is the runtime's step 1, the retried call its step 2
        self.assertEqual([s["response"]["step"] for s in steps], [1, 2])
        # the draw was made on the history before the failed call (system + user only), not after it
        self.assertEqual(backend.seen, [["user"]])

    def test_the_history_after_a_retry_holds_both_calls(self):
        backend = Scripted([EMPTY, ANSWER], alternatives=[EMPTY3])
        seen_after = []
        step = backend.step

        def spy(transcript, ctx):
            seen_after.append([m["role"] for m in transcript.history()])
            return step(transcript, ctx)

        backend.step = spy
        steps = steps_of(run(backend, "empty"))
        # step 1: find (empty) -> retry find zzzww (empty) -> the model's next step sees user, a, t, a, t
        self.assertEqual(seen_after[1], ["user", "assistant", "tool", "assistant", "tool"])
        self.assertEqual(steps[1]["retry"], "empty")
        self.assertEqual(len(steps), 3)

    def test_the_cap_is_one_retry_per_turn(self):
        backend = Scripted([EMPTY, EMPTY2, EMPTY3, ANSWER], alternatives=[EMPTY3, EMPTY2, EMPTY])
        steps = steps_of(run(backend, "empty"))
        self.assertEqual(len(backend.excluded), 1)
        self.assertEqual([s.get("retry") for s in steps], [None, "empty", None, None, None])

    def test_a_configurable_cap(self):
        backend = Scripted([EMPTY, EMPTY2, EMPTY3, ANSWER], alternatives=[EMPTY3, EMPTY2, EMPTY])
        steps = steps_of(run(backend, "empty", cap="2"))
        self.assertEqual(len(backend.excluded), 2)
        self.assertEqual(sum("retry" in s for s in steps), 2)

    def test_the_cap_is_per_turn(self):
        two = session()
        two["turns"] = [{"user": "what tasks do i have"}, {"user": "and the notes"}]
        backend = Scripted([EMPTY, EMPTY2], alternatives=[ANSWER, ANSWER])
        with mock.patch.dict(os.environ, {"NATIVE_RETRY": "empty"}):
            record = run_session(two, backend)
        self.assertEqual([[s.get("retry") for s in t["steps"]] for t in record["turns"]],
                         [[None, "empty"], [None, "empty"]])

    def test_an_error_retries_only_when_listed(self):
        backend = Scripted([BAD, ANSWER], alternatives=[ANSWER])
        steps = steps_of(run(backend, "empty"))
        self.assertEqual(backend.excluded, [])
        self.assertEqual(len(steps), 2)
        self.assertNotIn("retry", steps[1])
        backend = Scripted([BAD, ANSWER], alternatives=[ANSWER])
        steps = steps_of(run(backend, "empty,error"))
        self.assertEqual(len(backend.excluded), 1)
        self.assertEqual(steps[1]["retry"], "error")
        self.assertIn("<function=answer>", steps[1]["model"])

    def test_a_write_that_landed_never_retries(self):
        backend = Scripted([WRITE, ANSWER], alternatives=[ANSWER])
        steps = steps_of(run(backend, "empty,error,refused"))
        self.assertTrue(steps[0]["response"]["effect"]["diff"])
        self.assertEqual(backend.excluded, [])
        self.assertEqual(len(steps), 2)
        self.assertFalse(any("retry" in s for s in steps))

    def test_a_backend_that_cannot_sample_does_not_retry(self):
        backend = Scripted([EMPTY, ANSWER])  # no alternatives: resample -> None
        steps = steps_of(run(backend, "empty"))
        self.assertEqual(len(steps), 2)
        self.assertEqual(backend.asked, 2)
        self.assertFalse(any("retry" in s for s in steps))

    def test_stats_count_the_retries_by_signal(self):
        a = run(Scripted([EMPTY, ANSWER], alternatives=[ANSWER]), "empty,error")
        b = run(Scripted([BAD, ANSWER], alternatives=[ANSWER]), "empty,error")
        c = run(Scripted([EMPTY, ANSWER], alternatives=[ANSWER]), "empty,error")
        self.assertEqual(retry_counts([a, b, c]), {"empty": 2, "error": 1})
        self.assertEqual(json.loads(json.dumps(retry_counts([a]))), {"empty": 1})


if __name__ == "__main__":
    unittest.main()
