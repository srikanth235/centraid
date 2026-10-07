"""Tests for the think on the decoding side (CONTRACT_V3.md): the call a think states, the decoder's rendering of the call
(forced tokens, the stop after the one call) and its wiring, and the runtime's `compile` op.

    python3 -m unittest train/test_trace3.py

The decoder tests need torch and the cached Qwen tokenizer, the `compile` tests a `nativetools` binary; each is skipped when
one is missing. The compiler tests need none of them.
"""
from __future__ import annotations

import json
import os
import sys
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path[:0] = [str(HERE), str(HERE.parent)]
import fmt  # noqa: E402

T = fmt.trace3()
GOLDEN = HERE.parent / "authored" / "golden_v3.json"

SYSTEM = {"role": "system", "content": "today: Friday 2026-03-13\nme: Sam Park\n\nvault directory:\nlists: Home (#1)", "tools": []}
RESULT = 'answered:\n@1 · 2 events (showing 2)   [event: date]\n#5 [1] event "Gym" · Fri 2026-03-13\n#6 [2] event "Dentist" · Fri 2026-03-13'


def turns(*texts):
    msgs = [SYSTEM, {"role": "user", "content": texts[0]}]
    for t in texts[1:]:
        msgs += [{"role": "assistant", "think": "intent: read", "tool": "answer", "args": {"kind": "event"}},
                 {"role": "tool", "content": RESULT}, {"role": "user", "content": t}]
    return msgs


class PinnedV31(unittest.TestCase):
    """Base of the cases about the v3.1 trace (the default is v4): NATIVE_TRACE=v3.1 for each test."""

    def setUp(self):
        patch = mock.patch.dict(os.environ, {"NATIVE_TRACE": "v3.1"})
        patch.start()
        self.addCleanup(patch.stop)


class CallOfThink(PinnedV31):
    def test_the_decoder_renders_the_golden_calls_exactly_as_the_data_writes_them(self):
        rows = json.loads(GOLDEN.read_text())
        for r in rows:
            want = fmt.render.call_text(r["call"]["tool"], T.canon_call(r["call"])["args"])
            self.assertEqual(fmt.call_of_think(r["think"], r.get("dates")), want, r["shape"])

    def test_a_think_that_is_not_a_call_leaves_the_call_to_the_model(self):
        self.assertIsNone(fmt.call_of_think('intent: write "move"\nkind: event'))   # an act with no verb
        self.assertIsNone(fmt.call_of_think("intent: read\nwhen: now = fortnight+1"))
        self.assertIsNone(fmt.call_of_think("what is on friday"))                    # not a trace at all
        self.assertEqual(fmt.call_of_think("intent: read\nkind: event\n"),
                         "<tool_call>\n<function=answer>\n<parameter=kind>\nevent\n</parameter>\n</function>\n</tool_call>")

    def test_a_dates_pick_states_a_call_only_against_the_line(self):
        think = 'intent: read\nkind: event\nwhen: "next week" = dates[0]'
        line = "dates: next week = 2026-03-16..2026-03-22"
        self.assertIsNone(fmt.call_of_think(think))
        self.assertIn('{"from":{"date":"2026-03-16"},"to":{"date":"2026-03-22"}}', fmt.call_of_think(think, line))
        self.assertIsNone(fmt.call_of_think(think.replace("dates[0]", "dates[4]"), line))
        prompt = "<|im_start|>user\n%s\n\nwhat is on next week<|im_end|>\n<|im_start|>assistant\n" % line
        self.assertEqual(fmt.dates_line_in_prompt(prompt), line)


class V4Decoding(unittest.TestCase):
    """CONTRACT_V3.md section 8 on the decoding side: NATIVE_TRACE=v4 reads and renders the v4 trace, the records of the data are
    converted as they are read."""

    def setUp(self):
        patch = mock.patch.dict(os.environ, {"NATIVE_TRACE": "v4"})
        patch.start()
        self.addCleanup(patch.stop)

    def test_v4_is_the_default_and_v3_1_is_asked_for(self):
        with mock.patch.dict(os.environ):
            os.environ.pop("NATIVE_TRACE", None)
            self.assertEqual(fmt.trace_mode(), "v4")
            os.environ["NATIVE_TRACE"] = "v3.1"
            self.assertEqual(fmt.trace_mode(), "v3.1")

    def test_the_decoder_renders_the_golden_v4_thinks_as_the_calls_of_the_data(self):
        rows = [r for r in json.loads(GOLDEN.read_text()) if r.get("think4")]
        self.assertGreater(len(rows), 500)
        for r in rows:
            want = fmt.render.call_text(r["call"]["tool"], T.canon_call(r["call"])["args"])
            self.assertEqual(fmt.call_of_think(r["think4"], r.get("dates")), want, r["shape"])

    def test_a_think_with_no_construct_of_either_version_is_read_as_v4_and_an_old_one_as_itself(self):
        # the kind of `complete` is inferred in v4; a v3.1 think (it has a `scope` line) is read as v3.1 whatever the mode
        self.assertIn("<parameter=kind>\ntask\n", fmt.call_of_think("intent: write\nverb: complete\nname: Pay rent"))
        old = fmt.call_of_think('intent: write\nverb: complete\nscope: one\nname: Pay rent')
        self.assertNotIn("<parameter=kind>", old)

    def test_the_records_are_converted_as_they_are_read_and_a_lookup_keeps_its_think(self):
        block = 'vault: #31 task "Pay rent" · #32 task "Book dentist"'
        msgs = [SYSTEM,
                {"role": "user", "content": block + "\n\ntick off the rent"},
                {"role": "assistant", "think": 'intent: read "find"\nvia: find\nkind: task\nname: Pay rent', "tool": "find",
                 "args": {"kind": "task", "name": "Pay rent"}},
                {"role": "tool", "content": "@1 · 1 task (showing 1) | #31 [1] task \"Pay rent\""},
                {"role": "assistant", "think": 'intent: write "tick off"\nverb: complete\nscope: one\nrefer: none\ntarget: "rent"\n'
                 "pick: #31 ok · #32 no (name)", "tool": "act", "args": {"verb": "complete", "rows": "#31"}}]
        ex = {"messages": [dict(m, tools=[{"type": "function"}]) if m["role"] == "system" else m for m in msgs]}
        got = fmt.records(ex)
        self.assertEqual(got[2]["think"], msgs[2]["think"])  # v4 does not say a lookup step
        self.assertEqual(got[4]["think"], 'intent: write "tick off"\nverb: complete\npick: #31 (name)')
        self.assertEqual(fmt.call_of_think(got[4]["think"]), fmt.render.call_text("act", {"verb": "complete", "rows": "#31"}))
        with mock.patch.dict(os.environ, {"NATIVE_TRACE": "v3.1"}):
            self.assertEqual(fmt.records(ex)[4]["think"], msgs[4]["think"])


class StepRendersTheCall(unittest.TestCase):
    """`decode._Step` with a stub decoder: once the think closes, the call the think states is the only thing allowed, and after
    `</tool_call>` only `<|im_end|>`."""

    @classmethod
    def setUpClass(cls):
        os.environ.setdefault("HF_HUB_OFFLINE", "1")
        try:
            import torch
            import decode
            from transformers import AutoTokenizer
            cls.tok = AutoTokenizer.from_pretrained("Qwen/Qwen3.5-0.8B")
        except Exception as e:  # noqa: BLE001
            raise unittest.SkipTest("no torch / tokenizer: %r" % (e,))
        cls.torch, cls.decode = torch, decode

    def stub(self):
        tok = self.tok

        class D:
            pass

        d = D()
        d.tok, d.think_limit = tok, 200
        d.think_end, d.call_end, d.im_end = (tok.convert_tokens_to_ids(t) for t in ("</think>", "</tool_call>", "<|im_end|>"))
        return d

    def test_the_forced_tokens_spell_the_compiled_call(self):
        think = 'intent: read "what\'s on"\nkind: event\nwhere: status = "open"\norder: date asc\nlimit: 1'
        d = self.stub()
        torch = self.torch
        text = think + "\n</think>"
        think_ids = self.tok(text, add_special_tokens=False)["input_ids"]
        step = self.decode._Step(d, 3)
        ids = [1, 2, 3] + think_ids
        vocab = len(self.tok)
        out_ids = []
        while True:
            scores = torch.zeros(1, vocab)
            row = step(torch.tensor([ids]), scores)[0]
            allowed = torch.isfinite(row).nonzero().flatten().tolist()
            if len(allowed) != 1:
                break
            ids.append(allowed[0])
            out_ids.append(allowed[0])
            if allowed[0] == d.im_end:
                break
        self.assertTrue(step.info["rendered_call"])
        body = self.tok.decode(out_ids[:-1], skip_special_tokens=False)
        self.assertEqual(body, "\n\n" + fmt.call_of_think(think))
        self.assertEqual(out_ids[-1], d.im_end)

    def test_with_a_think_that_is_no_call_nothing_is_forced(self):
        vocab = len(self.tok)
        for think in ("intent: write\nkind: event", "what is on friday"):  # an act with no verb; not a trace at all
            step = self.decode._Step(self.stub(), 3)
            ids = [1, 2, 3] + self.tok(think + "\n</think>", add_special_tokens=False)["input_ids"]
            row = step(self.torch.tensor([ids]), self.torch.zeros(1, vocab))[0]
            self.assertGreater(int(self.torch.isfinite(row).sum()), 1)
            self.assertFalse(step.info["rendered_call"])


    def allowed(self, step, ids):
        row = step(self.torch.tensor([ids]), self.torch.zeros(1, len(self.tok)))[0]
        return self.torch.isfinite(row).nonzero().flatten().tolist()

    def test_the_think_guard_forces_the_end_of_the_think_at_the_limit(self):
        d = self.stub()
        d.think_limit = 3
        thought = self.tok("one two three four", add_special_tokens=False)["input_ids"]
        step = self.decode._Step(d, 3)
        for n in range(1, 3):  # under the limit nothing is forced
            self.assertGreater(len(self.allowed(step, [1, 2, 3] + thought[:n])), 1)
            self.assertFalse(step.info["think_cut"])
        self.assertEqual(self.allowed(step, [1, 2, 3] + thought[:3]), [d.think_end])
        self.assertTrue(step.info["think_cut"])
        self.assertEqual(step.n_think, 3)

    def test_after_the_one_call_only_the_end_of_the_message_is_allowed(self):
        d = self.stub()
        step = self.decode._Step(d, 3)
        text = "what is on friday\n</think>\n\n<tool_call>\n<function=answer>\n</function>\n</tool_call>"  # a think that is no call
        ids = [1, 2, 3] + self.tok(text, add_special_tokens=False)["input_ids"]
        self.assertEqual(ids[-1], d.call_end)
        self.assertEqual(self.allowed(step, ids[:-1]).count(d.im_end), 1)  # inside the call the model is free (the whole vocabulary)
        self.assertGreater(len(self.allowed(self.decode._Step(d, 3), ids[:-1])), 1)
        self.assertEqual(self.allowed(step, ids), [d.im_end])
        self.assertFalse(step.info["rendered_call"])


class DecoderWiring(unittest.TestCase):
    """`Decoder.step` and `Decoder.complete` hand `generate` the prompt, the sampling options, the think's given prefix and the
    `dates:` line of the turn (what the call the think states is read against), the same either way (a decoder with no model:
    `generate` records what it is given)."""

    DATES = "dates: next week = 2026-03-16..2026-03-22"

    @classmethod
    def setUpClass(cls):
        try:
            import decode
        except Exception as e:  # noqa: BLE001
            raise unittest.SkipTest("no torch: %r" % (e,))
        cls.decode = decode

    def recorder(self):
        seen = []

        class D(self.decode.Decoder):
            def __init__(self):  # no model, no tokenizer
                pass

            def generate(self, prompt, sample=False, seed=0, dates=None, prefix=""):
                seen.append((prompt, sample, seed, dates, prefix))
                return "<think>\n", {}

        return D(), seen

    def test_the_serial_paths_pass_the_same_prompt_and_dates_line(self):
        for texts, dates in ((("what's on friday", "star it"), None), (("star it",), None),
                             (("what's on friday", self.DATES + "\n\nwhat is on next week"), self.DATES)):
            msgs = turns(*texts)
            prompt = fmt.render.render_prompt_for_generation(msgs)
            d, seen = self.recorder()
            d.step(msgs)
            d.complete(prompt)
            self.assertEqual(seen[0], seen[1], texts)
            self.assertEqual(seen[0], (prompt, False, 0, dates, ""), texts)

    def test_the_sampling_options_and_the_prefix_reach_generate(self):
        msgs = turns("what's on friday")
        d, seen = self.recorder()
        d.step(msgs, sample=True, seed=7, prefix="retry: where\n")
        d.complete(fmt.render.render_prompt_for_generation(msgs), sample=True, seed=7, prefix="retry: where\n")
        self.assertEqual([x[1:] for x in seen], [(True, 7, None, "retry: where\n")] * 2)


class RuntimeCompile(unittest.TestCase):
    """The runtime's `compile` op on the fixture world (crates/nativetools/tests/fixtures/world.json, today 2026-09-27): the call
    it states for the slots of a think is the call `trace.compile_call` renders, a refusal names the slot, and the backend retries
    once with `retry: <slot>` and then falls back. Needs a `nativetools` binary."""

    WORLD = HERE.parents[3] / "crates" / "nativetools" / "tests" / "fixtures" / "world.json"

    @classmethod
    def setUpClass(cls):
        import shutil
        import subprocess
        import tempfile
        nt = os.environ.get("NATIVETOOLS") or str(HERE.parents[3] / "target" / "debug" / "nativetools")
        if not Path(nt).exists() or not cls.WORLD.exists():
            raise unittest.SkipTest("no nativetools binary or fixture world")
        cls.tmp = tempfile.mkdtemp(prefix="compile-op-")
        subprocess.run([nt, "seed", str(cls.WORLD), cls.tmp + "/vault"], check=True, capture_output=True)
        cls.nt, cls.sp = nt, subprocess
        cls.addClassCleanup(shutil.rmtree, cls.tmp, True)

    def session(self, message):
        p = self.sp.Popen([self.nt, "session", self.tmp + "/vault", "--today", "2026-09-27", "--me", "Sam Park", "--tools", "sig"],
                          stdin=self.sp.PIPE, stdout=self.sp.PIPE, text=True)
        self.addCleanup(p.wait)
        self.addCleanup(p.stdout.close)
        self.addCleanup(p.stdin.close)
        self.addCleanup(p.kill)

        def req(obj):
            p.stdin.write(json.dumps(obj) + "\n")
            p.stdin.flush()
            return json.loads(p.stdout.readline())
        user = req({"op": "user", "text": message})
        return req, user["dates"]

    def test_the_runtime_states_the_call_the_think_compiles_to(self):
        with mock.patch.dict(os.environ, {"NATIVE_TRACE": "v3.1"}):  # the v3.1 thinks of the slots below
            self.v31_compiles()

    def v31_compiles(self):
        req, dates = self.session("move the dentist to next friday and what is on next week")
        self.assertIn("next week = 2026-09-28..2026-10-04", dates)
        for think in ('intent: read\nkind: event\nwhere: status = confirmed · duration >= 30\nwhen: "next week" = dates[1]',
                      'intent: read\nkind: event\nwhen: "next friday" = dates[0]',
                      'intent: write\nverb: reschedule\nset: to = ~dates[0]\nrows: #9',
                      'intent: write\nverb: cancel\nrows: #9',
                      'intent: read\nkind: event\nwhen: "next week" = week+1\norder: date asc\nlimit: 2'):
            reply = req({"op": "compile", "slots": T.slots_json(T.parse3(think))})
            self.assertNotIn("refused", reply, think)
            want = T.compile_call(think, dates)
            self.assertTrue(T.same_call(T.runtime_call(reply, "stated"), want), (think, reply["stated"], want))

    def test_the_runtime_states_the_call_a_v4_think_compiles_to_and_says_what_it_inferred(self):
        req, dates = self.session("move the dentist to next friday and what is on next week")
        for think, inferred in (('intent: write\nverb: complete\nname: Pay rent', ["kind: task", "scope: all"]),
                                ('intent: write\nverb: reschedule\npick: #9 (name)\nset: to = ~dates[0]', ["scope: one"]),
                                ('intent: write\nverb: cancel\npick: #9 (focus)', ["scope: one", "refer: it -> #9"]),
                                ('intent: read\nkind: event\nwhen: "next week" = dates[1]', [])):
            reply = req({"op": "compile", "slots": T.slots_json(T.parse4(think))})
            self.assertNotIn("refused", reply, think)
            self.assertTrue(T.same_call(T.runtime_call(reply, "stated"), T.compile_call(think, dates, "v4")), (think, reply["stated"]))
            self.assertEqual(reply["inferred"], inferred, think)

    def test_a_refusal_names_the_slot(self):
        req, _ = self.session("what is on next week")
        for think, slot in (('intent: read\nkind: event\nrows: #99', "rows[0]"), ('intent: read\nkind: event\nwhere: status is bogus', "where"),
                            ('intent: read\nkind: event\nwhen: "x" = dates[5]', "when"), ('intent: write\nrows: #9', "verb")):
            reply = req({"op": "compile", "slots": T.slots_json(T.parse3(think))})
            self.assertEqual(reply.get("refused", {}).get("slot"), slot, (think, reply))

    def test_the_backend_retries_once_with_the_slot_and_then_falls_back(self):
        try:
            import hf_backend
        except Exception as e:  # noqa: BLE001
            raise unittest.SkipTest("no torch: %r" % (e,))
        req, _ = self.session("cancel the dentist")
        compile = lambda slots: req({"op": "compile", "slots": slots})  # noqa: E731
        call = lambda think, rows: "<think>\n%s\n</think>\n\n%s" % (think, fmt.render.call_text("act", T.canon_call({"tool": "act", "args": {"verb": "cancel", "rows": rows}})["args"]))  # noqa: E731
        bad = call("intent: write\nverb: cancel\nrows: #99", "#99")
        good = call("retry: rows[0]\nintent: write\nverb: cancel\nrows: #9", "#9")
        seen = []

        def again(prefix):
            seen.append(prefix)
            return good

        text, how = hf_backend.compiled_message(bad, compile, again)
        self.assertEqual((how, seen), ("retry", ["retry: rows[0]\n"]))
        self.assertEqual(text, good)
        text, how = hf_backend.compiled_message(good, compile, again)       # accepted at once: no retry
        self.assertEqual((how, len(seen)), ("compiled", 1))
        text, how = hf_backend.compiled_message(bad, compile, lambda prefix: bad)   # refused twice: the first draw stands
        self.assertEqual((how, text), ("retry-fallback", bad))
        text, how = hf_backend.compiled_message(bad, compile, None)
        self.assertEqual((how, text), ("fallback", bad))
        self.assertEqual(hf_backend.compiled_message("no trace here", compile, again), ("no trace here", "none"))
        # the compiled call is the runtime's, not the draw's: a draw whose written call differs is overwritten
        drawn = call("intent: write\nverb: cancel\nrows: #9", "#7")
        text, how = hf_backend.compiled_message(drawn, compile, again)
        self.assertEqual(how, "compiled")
        self.assertIn("<parameter=rows>\n#9\n", text)
        self.assertNotIn("#7", text)


if __name__ == "__main__":
    unittest.main()
