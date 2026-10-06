"""Tests for the think on the decoding side (CONTRACT_V3.md): the call a think states, the refer rule that makes the
`refer:` line mandatory, the grammar of the think lines, and the decoder's rendering of the call.

    python3 -m unittest train/test_trace3.py

The grammar tests need llguidance, the cached Qwen tokenizer and a `nativetools` binary (for the exported call grammar);
they are skipped when one is missing. The compiler and rule tests need none of them.
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

    def test_a_think_that_is_not_a_call_leaves_the_call_to_the_grammar(self):
        self.assertIsNone(fmt.call_of_think('intent: write "move"\nkind: event'))   # an act with no verb
        self.assertIsNone(fmt.call_of_think("intent: read\nwhen: now = fortnight+1"))
        self.assertIsNone(fmt.call_of_think("what is on friday"))                    # not a trace at all
        self.assertEqual(fmt.call_of_think("intent: read\nkind: event\n"),
                         "<tool_call>\n<function=answer>\n<parameter=kind>\nevent\n</parameter>\n</function>\n</tool_call>")


class ReferRule(PinnedV31):
    """`refer:` is a function of the turn index and of whether an earlier turn showed a result, never of the words."""

    def test_it_holds_on_the_first_step_of_every_turn_that_has_a_previous_result(self):
        first = turns("what's on friday", "which of those need a reminder")
        self.assertTrue(fmt.requires_refer(first))
        self.assertTrue(fmt.requires_refer(turns("what's on friday", "add milk to the shopping list")))   # no cue: still required
        self.assertTrue(fmt.requires_refer(turns("a", "what's left on the kitchen list", "how many tasks are open")))

    def test_it_does_not_hold_on_the_first_turn_nor_on_a_later_step(self):
        self.assertFalse(fmt.requires_refer(turns("which of those need a reminder")))               # nothing earlier to point at
        self.assertFalse(fmt.requires_refer(turns("star it")))
        first = turns("what's on friday", "which of those need a reminder")
        self.assertFalse(fmt.requires_refer(first + [{"role": "assistant", "think": "intent: read\nrefer: none", "tool": "find", "args": {}}]))

    def test_the_rendered_prompt_gives_the_same_answer_as_the_records(self):
        for texts in (("what's on friday", "star it"), ("what's on friday", "add milk"), ("star it",), ("a", "which of them are open")):
            msgs = turns(*texts)
            prompt = fmt.render.render_prompt_for_generation(msgs)
            self.assertEqual(fmt.requires_refer_in_prompt(prompt), fmt.requires_refer(msgs), texts)


class Grammar(PinnedV31):
    @classmethod
    def setUpClass(cls):
        os.environ.setdefault("HF_HUB_OFFLINE", "1")
        try:
            import llguidance
            import llguidance.hf
            import hf_backend
            import decode
            from transformers import AutoTokenizer
            cls.tok = AutoTokenizer.from_pretrained("Qwen/Qwen3.5-0.8B")
            cls.lark = hf_backend.export_lark()
            cls.llg, cls.decode = llguidance, decode
            cls.lltok = llguidance.hf.from_tokenizer(cls.tok, eos_token=cls.tok.convert_tokens_to_ids("<|im_end|>"))
            cls.gram = decode.Grammar(cls.lark, cls.tok)
        except Exception as e:  # noqa: BLE001
            raise unittest.SkipTest("no llguidance / tokenizer / nativetools: %r" % (e,))

    def accepts(self, think: str, require_refer: bool, n_dates=None) -> bool:
        text = think + "\n</think>"
        g = self.gram.specialise([5, 6], [1], require_refer=require_refer, n_dates=n_dates)
        return self.decode.accepts_think(self.lltok, self.llg, g, self.tok, text)

    def test_the_slot_lines_in_order(self):
        for think in ('intent: read "what\'s on"\nkind: event\nwhen: now = from day+0',
                      FULL, 'intent: decline "never mind"\nreason: never_mind'):
            self.assertTrue(self.accepts(think, False), think)

    def test_a_line_out_of_order_or_unknown_is_refused(self):
        for think in ('kind: event\nintent: read', 'intent: read\nplan: act', 'intent: read "x"\nvia: grep', 'intent: read\nwhen: friday'):
            self.assertFalse(self.accepts(think, False), think)

    def test_refer_is_demanded_on_a_turn_with_a_previous_result(self):
        self.assertTrue(self.accepts('intent: read "which of"\nkind: event', False))
        self.assertFalse(self.accepts('intent: read "which of"\nkind: event', True))
        self.assertFalse(self.accepts('intent: read "which of"\nverb: star\nkind: event', True))
        for refer in ('refer: none', 'refer: both "those" -> @1', 'refer: it "it" -> #5, #6'):
            self.assertTrue(self.accepts('intent: read "which of"\n%s\nkind: event' % refer, True), refer)
        self.assertTrue(self.accepts('retry: rejected\nintent: read\nrefer: none', True))
        self.assertFalse(self.accepts('intent: read\nrefer: both "x"', True))   # a referent needs its handles

    def test_the_rule_reads_the_step_the_decoder_is_at(self):
        msgs = turns("what's on friday", "which of those need a reminder")
        rows, results = fmt.addressable(msgs)
        free = self.gram.specialise(rows, results, require_refer=fmt.requires_refer(msgs))
        self.assertIn("T3_SCOPE? T3_REFER T3_TARGET?", free)
        self.assertIn("T3_REFER?", self.gram.specialise(rows, results, require_refer=False))


    def test_the_call_grammar_reads_what_the_runtime_reads(self):
        """Quoted enum values after `=`, a number field's unit word and a month's `rel` before its `name` (decode.relax_where)."""
        g = self.gram.specialise([5, 6], [1])

        def call(**args):
            return "<tool_call>\n<function=answer>\n" + "".join("<parameter=%s>\n%s\n</parameter>\n" % kv for kv in args.items()) + "</function>\n</tool_call>"

        for args in ({"kind": "task", "where": 'status = "open"'}, {"kind": "task", "where": "status = open"},
                     {"kind": "task", "where": 'status in ("open", "completed")'}, {"kind": "task", "where": "effort > 60 minutes"},
                     {"kind": "debt", "where": 'direction = "owes_me" and status != "settled"'},
                     {"kind": "event", "when": '{"unit":"month","rel":0,"name":3}'}):
            ok, why = self.decode.accepts(self.lltok, self.llg, g, self.tok, "intent: read\n</think>\n\n" + call(**args))
            self.assertTrue(ok, (args, why))
        for args in ({"kind": "task", "where": 'status = "bogus"'}, {"kind": "task", "where": "effort > 1 hour"}):
            ok, _ = self.decode.accepts(self.lltok, self.llg, g, self.tok, "intent: read\n</think>\n\n" + call(**args))
            self.assertFalse(ok, args)


FULL = "\n".join([
    'intent: write "move"', "verb: reschedule", 'scope: one "it"', 'refer: it "it" -> @1', 'target: "gym" · "friday"', "kind: event",
    "name: Gym", 'where: status = "open"', 'when: "monday at 3" = week+1 wd1 t', "order: date asc", "limit: 1", "more: true",
    "set: notes = Dr Patel, 2 pm", "time: 15:00", "pick: #5 ok · #6 no (name)"])


class GrammarV31(Grammar):
    """The think grammar takes the v3.1 lines (CONTRACT_V3.md section 7): typed `where` segments, `when` with a `dates[i]` of the
    prompt's dates line (its readings, only the entries the line has), the compact date as before, `retry: <slot>`."""

    def test_where_is_typed_segments(self):
        for where in ("status = open", 'status = "open" · effort > 60', 'role contains "hiking" · notes is empty', "document count = 0",
                      'role in ("mother", "cousin")', "amount > 35 BRL", "effort > 1 hour", "starred = yes"):
            self.assertTrue(self.accepts("intent: read\nkind: task\nwhere: " + where, False), where)
        for where in ("whichever tasks are due", "status == open", "status = open and effort > 60", "status ="):
            self.assertFalse(self.accepts("intent: read\nkind: task\nwhere: " + where, False), where)

    def test_when_picks_an_entry_of_the_dates_line(self):
        pick = 'intent: read\nkind: event\nwhen: "friday" = dates[%d]%s'
        self.assertTrue(self.accepts(pick % (2, " past"), False, n_dates=3))
        self.assertTrue(self.accepts(pick % (0, ""), False, n_dates=3))
        self.assertTrue(self.accepts(pick % (7, " upcoming"), False))          # the line is not known: any index
        self.assertFalse(self.accepts(pick % (3, ""), False, n_dates=3))        # the line has entries 0 to 2
        self.assertFalse(self.accepts(pick % (0, ""), False, n_dates=0))        # no dates line, nothing to pick
        self.assertFalse(self.accepts(pick % (0, " later"), False, n_dates=3))
        typed = 'intent: read\nkind: event\nwhen: "next week" = week+1'
        self.assertTrue(self.accepts(typed, False, n_dates=0) and self.accepts(typed, False, n_dates=3))
        self.assertTrue(self.accepts('intent: read\nkind: event\nwhen: "sat to mon" = from day+0 wd6 to day+0 wd1', False, n_dates=3))
        self.assertFalse(self.accepts('intent: read\nkind: event\nwhen: "x" = 2026-03-13T10:00', False, n_dates=3))

    def test_a_set_line_may_pick_a_date(self):
        self.assertTrue(self.accepts('intent: write\nverb: reschedule\nset: to = ~dates[1] upcoming · name = Dentist', False, n_dates=2))

    def test_retry_names_a_slot(self):
        for line in ("retry: rejected", "retry: where[1]", "retry: pick", "retry: linked_to[0]"):
            self.assertTrue(self.accepts(line + '\nintent: read\nkind: event', False), line)
        self.assertFalse(self.accepts('retry: Where\nintent: read', False))
        self.assertFalse(self.accepts('intent: read\nretry: where', False))   # the retry line leads

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
    converted as they are read, and the refer rule is gone."""

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

    def test_the_refer_rule_is_gone(self):
        msgs = turns("what's on friday", "which of those need a reminder")
        self.assertFalse(fmt.requires_refer(msgs))
        self.assertFalse(fmt.requires_refer_in_prompt(fmt.render.render_prompt_for_generation(msgs)))
        with mock.patch.dict(os.environ, {"NATIVE_TRACE": "v3.1"}):
            self.assertTrue(fmt.requires_refer(msgs))

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


class GrammarV4(unittest.TestCase):
    """The v4 think grammar (`decode.THINK4_LINES`): the same terminals in the v4 order, no `scope`, `refer`, `target` or
    `via: find`, a one-row `pick` with its reason, and no `refer:` line to demand."""

    setUpClass = classmethod(Grammar.setUpClass.__func__)  # the same tokenizer, llguidance and exported call grammar

    FULL4 = "\n".join([
        'intent: write "move"', "verb: reschedule", "pick: #5 (focus)", "kind: event", 'where: status = "open"',
        'when: "monday at 3" = week+1 wd1 t', "order: date asc", "limit: 1", "more: true", "set: notes = Dr Patel, 2 pm", "time: 15:00"])

    def accepts(self, think: str, require_refer: bool = False, n_dates=None) -> bool:
        g = self.gram.specialise([5, 6], [1], require_refer=require_refer, n_dates=n_dates, trace="v4")
        return self.decode.accepts_think(self.lltok, self.llg, g, self.tok, think + "\n</think>")

    def test_the_slot_lines_in_order(self):
        for think in ('intent: read "what\'s on"\nkind: event\nwhen: now = from day+0', self.FULL4, 'intent: decline "never mind"\nreason: never_mind',
                      'retry: pick\nintent: write\nverb: star\npick: #5 (nick)', "intent: write\nverb: delete\nrows: #5, #6",
                      'intent: read\nvia: search\nkind: person\ntext: Chi'):
            self.assertTrue(self.accepts(think), think)

    def test_a_line_out_of_order_or_unknown_is_refused(self):
        for think in ("kind: event\nintent: read", "intent: read\nplan: act", 'intent: read "x"\nvia: grep', "intent: read\nwhen: friday",
                      "intent: write\nkind: event\nverb: star", "intent: write\nverb: star\nkind: event\npick: #5 (name)"):
            self.assertFalse(self.accepts(think), think)

    def test_what_v4_dropped_is_refused(self):
        for think in ('intent: write\nverb: star\nscope: one', 'intent: read\nrefer: none', 'intent: read\ntarget: "x"', "intent: read\nvia: find\nkind: task",
                      "intent: write\nverb: star\npick: #5 ok · #6 no (kind)", "intent: write\nverb: star\npick: #5 (position)",
                      "intent: write\nverb: star\npick: #5 (name) · #6 (name)", "intent: write\nverb: star\npick: #5 ok"):
            self.assertFalse(self.accepts(think), think)

    def test_refer_is_never_demanded(self):
        self.assertTrue(self.accepts('intent: read "which of"\nkind: event', True))
        self.assertNotIn("T3_REFER", self.gram.specialise([5], [1], require_refer=True, trace="v4"))

    def test_the_rule_reads_the_step_the_decoder_is_at(self):
        with mock.patch.dict(os.environ, {"NATIVE_TRACE": "v4"}):
            msgs = turns("what's on friday", "which of those need a reminder")
            rows, results = fmt.addressable(msgs)
            free = self.gram.specialise(rows, results, require_refer=fmt.requires_refer(msgs))
            self.assertNotIn("T3_REFER", free)
            self.assertIn("T3_PICK? T3_ROWS?", free)

    def test_the_golden_v4_thinks_are_accepted(self):
        rows = [r for r in json.loads(GOLDEN.read_text()) if r.get("think4")]
        for r in rows[::7]:
            n = len(T.dates_entries(r.get("dates")))
            self.assertTrue(self.accepts(r["think4"], n_dates=n), r["shape"] + "\n" + r["think4"])

    def test_where_is_typed_segments(self):
        for where in ('status = "open"', "effort > 60 · status = open", 'role in ("mother", "cousin")', "document count = 0"):
            self.assertTrue(self.accepts("intent: read\nkind: task\nwhere: %s" % where), where)


class StepRendersTheCall(unittest.TestCase):
    """`decode._Step` with a stub decoder: once the think closes, the call the think states is the only thing allowed."""

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
        step = self.decode._Step(d, None, "free", 3)
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
            step = self.decode._Step(self.stub(), None, "free", 3)
            ids = [1, 2, 3] + self.tok(think + "\n</think>", add_special_tokens=False)["input_ids"]
            row = step(self.torch.tensor([ids]), self.torch.zeros(1, vocab))[0]
            self.assertGreater(int(self.torch.isfinite(row).sum()), 1)
            self.assertFalse(step.info["rendered_call"])


class DecoderWiring(PinnedV31):
    """`Decoder.step` and `Decoder.complete` demand the `refer:` line exactly where `fmt.requires_refer` says (a decoder with no
    model: `generate` records what it is given)."""

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

            def generate(self, prompt, rows, results, mode="hard", sample=False, seed=0, require_refer=False, dates=None, prefix=""):
                seen.append((rows, results, require_refer))
                return "<think>\n", {}

        return D(), seen

    def test_the_serial_paths_pass_the_refer_rule_of_the_step(self):
        for texts, want in ((("what's on friday", "star it"), True), (("star it",), False), (("what's on friday", "add milk"), True)):
            msgs = turns(*texts)
            d, seen = self.recorder()
            d.step(msgs)
            d.complete(fmt.render.render_prompt_for_generation(msgs))
            self.assertEqual([r for _, _, r in seen], [want, want], texts)
            self.assertEqual(seen[0][:2], seen[1][:2])  # the same addressable handles either way


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


class LlamaBackendStub(PinnedV31):
    """`llama_backend.LlamaBackend.complete` against a scripted server: the think request carries the think grammar (with the
    step's refer rule), the call is written from the think with no second request, and a think that states no call leaves the
    call to a request under the call grammar. Needs llguidance, the cached tokenizer and a `nativetools` binary."""

    @classmethod
    def setUpClass(cls):
        os.environ.setdefault("HF_HUB_OFFLINE", "1")
        try:
            import llguidance
            import llguidance.hf
            import hf_backend
            import llama_backend
            cls.lark = hf_backend.export_lark()
            cls.llg = llguidance
            cls.backend = llama_backend.LlamaBackend("http://127.0.0.1:1", cls.lark, decoding="hard")
            cls.lltok = llguidance.hf.from_tokenizer(cls.backend.tok, eos_token=cls.backend.im_end)
        except Exception as e:  # noqa: BLE001
            raise unittest.SkipTest("no llguidance / tokenizer / nativetools: %r" % (e,))
        cls.golden = json.loads(GOLDEN.read_text())

    def matcher(self, grammar):
        prefix = "%llguidance {}\n"
        self.assertTrue(grammar.startswith(prefix))
        m = self.llg.LLMatcher(self.lltok, self.llg.LLMatcher.grammar_from_lark(grammar[len(prefix):]), log_level=0)
        self.assertFalse(m.is_error(), m.get_error() if m.is_error() else "")
        return m

    def test_the_grammars_compile_and_the_think_grammar_takes_the_golden_thinks(self):
        b = self.backend
        for g in (b.think_grammar(True), b.think_grammar(False), b.loose_think, b.call_grammar([1, 2], [1])):
            self.matcher(g)
        for r in self.golden[::9]:
            m = self.matcher(b.think_grammar(False))
            ids = b.tok(r["think"] + "\n</think>", add_special_tokens=False)["input_ids"]
            self.assertTrue(all(m.consume_token(t) for t in ids) and m.is_accepting(), r["shape"])

    def test_the_call_the_think_states_is_written_with_one_request(self):
        b, msgs = self.backend, turns("what's on friday", "star it")
        prompt = fmt.render.render_prompt_for_generation(msgs)
        for r in self.golden[::97]:
            seen = []

            def gen(ids, n, grammar, think=r["think"]):
                seen.append(grammar)
                return b.tok(think + "\n</think>", add_special_tokens=False)["input_ids"]

            b._gen = gen
            text, info = b.complete(prompt)
            want = "<think>\n" + r["think"] + "\n</think>\n\n" + fmt.render.call_text(r["call"]["tool"], T.canon_call(r["call"])["args"])
            self.assertEqual(text, want, r["shape"])
            self.assertEqual(seen, [b.think_grammar(True)])  # a follow-up turn: the refer line is demanded
            self.assertTrue(info["rendered_call"] and info["stopped"] and not info["think_cut"])

    def test_a_think_that_states_no_call_leaves_the_call_to_the_call_grammar(self):
        b = self.backend
        prompt = fmt.render.render_prompt_for_generation(turns("what's on friday"))
        seen = []

        def gen(ids, n, grammar):
            seen.append(grammar)
            if len(seen) == 1:
                return b.tok("intent: write\n</think>", add_special_tokens=False)["input_ids"]  # an act with no verb
            return b.tok("\n\n<tool_call>\n<function=answer>\n</function>\n</tool_call>", add_special_tokens=False)["input_ids"]

        b._gen = gen
        text, info = b.complete(prompt)
        self.assertEqual(len(seen), 2)
        self.assertEqual(seen[0], b.think_grammar(False))  # the first turn: no refer line demanded
        self.assertTrue(seen[1].startswith("%llguidance {}\n") and 'start: "\\n\\n" <[' in seen[1])  # the call request starts after `</think>`
        self.assertNotIn("start: think", seen[1])
        self.assertFalse(info["rendered_call"])
        self.assertTrue(info["stopped"])


if __name__ == "__main__":
    unittest.main()
