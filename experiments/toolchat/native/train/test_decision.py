"""Tests for the decision-token mask (fmt.py) and the decision-weighted loss (train.py).

    HF_HUB_OFFLINE=1 python -m unittest train/test_decision.py

The span rules run on text only; encode() needs the Qwen tokenizer; the loss tests need torch and
build a tiny random Qwen3.5 (skipped when those are not around). The copy tier (think values that are verbatim copies of the user's
message, `--copy-weight`) has its span rules in CopySpans (text only), its token marks in CopyTokens, its loss in CopyLoss and, on a
stub model with no HF model at all, its reports in StubEvaluate.
"""
from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import fmt  # noqa: E402
import render  # noqa: E402


def assistant_body(message: dict) -> str:
    """What the renderer writes of one assistant record from just after `<think>\\n` through `<|im_end|>`: its trained region."""
    text, spans = render.render([dict(message, role="assistant")])
    (a, b), = spans
    return text[a:b]


TOOLS = [{"type": "function", "function": {"name": n, "description": "d", "parameters": {"type": "object", "properties": {}}}}
         for n in ("act", "answer", "ask")]
# the thinks of the tests: the base slots of the trace, and a think that also states the call's arguments
THINK = ('intent: write "move it"\nverb: reschedule\nscope: one "it"\nrefer: it "it" -> @3\nwhen: "friday" = week-2 wd5\n'
         'pick: #2 ok · #5 no (name)')
FULL = ('intent: write "move it"\nverb: reschedule\nscope: one "it"\nrefer: it "it" -> @3\ntarget: "dentist"\nkind: event\n'
        'name: Dentist visit\nwhere: duration < 60\nwhen: "friday" = week-2 wd5\nset: to = ~hour+1 row\npick: #2 ok · #5 no (name)')
ARGS = {"verb": "reschedule", "rows": "#2", "args": 'to: {"unit":"hour","rel":1,"anchor":"row"}',
        "when": '{"unit":"week","rel":-2,"weekday":5}'}


def session(think1=FULL, think2='intent: ask "which one"\nquestion: Which one?\noptions: #1, #2'):
    return {"messages": [
        {"role": "system", "content": "today: x", "tools": TOOLS},
        {"role": "user", "content": "move the dentist an hour"},
        {"role": "assistant", "think": think1, "tool": "act", "args": ARGS},
        {"role": "tool", "content": "ok"},
        {"role": "assistant", "think": think2, "tool": "ask", "args": {"question": "Which one?", "options": "#1, #2"}}]}


def texts(body, spans):
    return [body[a:b] for a, b, _ in spans]


class SpanRules(unittest.TestCase):
    def body(self, think, tool="act", args=ARGS):
        return assistant_body({"think": think, "tool": tool, "args": args})

    def think_texts(self, think, cfg=None):
        b = self.body(think)
        return texts(b, [s for s in fmt.decision_char_spans(b, cfg or fmt.DecisionConfig()) if s[2] == fmt.PART_THINK])

    def test_think_values(self):
        # every slot of the think counts by its whole value
        self.assertEqual(self.think_texts(THINK), ['write "move it"', "reschedule", 'one "it"', 'it "it" -> @3',
                                                   '"friday" = week-2 wd5', "#2 ok · #5 no (name)"])
        self.assertEqual(self.think_texts(FULL), ['write "move it"', "reschedule", 'one "it"', 'it "it" -> @3', '"dentist"', "event",
                                                  "Dentist visit", "duration < 60", '"friday" = week-2 wd5', "to = ~hour+1 row",
                                                  "#2 ok · #5 no (name)"])

    def test_ref_labels_take_only_the_row_refs(self):
        cfg = fmt.DecisionConfig(ref_labels=("refer", "pick"))
        self.assertEqual(self.think_texts(THINK, cfg), ['write "move it"', "reschedule", 'one "it"', "@3", '"friday" = week-2 wd5', "#2", "#5"])
        self.assertEqual(fmt.DecisionConfig().ref_labels, ())  # none by default: a slot is a closed word and a quote

    def test_labels_are_configurable(self):
        cfg = fmt.DecisionConfig.parse(labels="verb,refer")
        self.assertEqual(self.think_texts(THINK, cfg), ["reschedule", 'it "it" -> @3'])

    def test_unknown_label_and_retry_are_not_decisions(self):
        self.assertEqual(self.think_texts("retry: rejected\nintent: read\nplan: act"), ["read"])

    def test_call_values(self):
        b = self.body(THINK)
        cfg = fmt.DecisionConfig(param_names=False, json_keys=False)
        got = texts(b, [s for s in fmt.decision_char_spans(b, cfg) if s[2] == fmt.PART_CALL])
        self.assertEqual(got, ["reschedule", "#2", "to:", "hour", "1", "row", "week", "-2", "5"])

    def test_call_keys_and_names(self):
        b = self.body(THINK)
        got = texts(b, [s for s in fmt.decision_char_spans(b, fmt.DecisionConfig()) if s[2] == fmt.PART_CALL])
        self.assertEqual(got, ["verb", "reschedule", "rows", "#2", "args", "to:", "unit", "hour", "rel", "1", "anchor",
                               "row", "when", "unit", "week", "rel", "-2", "weekday", "5"])

    def test_tool_name_and_scaffolding_stay_out(self):
        b = self.body(THINK)
        got = texts(b, fmt.decision_char_spans(b, fmt.DecisionConfig()))
        for bad in ("<function", "tool_call", "im_end", "</think>", "<parameter"):
            self.assertFalse(any(bad in t for t in got), bad)
        # the tool name in `<function=act>` is not marked
        c0 = b.index("<function=act>") + len("<function=")
        self.assertFalse(any(a <= c0 < e for a, e, _ in fmt.decision_char_spans(b, fmt.DecisionConfig())))

    def test_skip_params(self):
        b = self.body('intent: ask "which"', "ask", {"question": "Which one?", "options": "#1, #2"})
        got = texts(b, [s for s in fmt.decision_char_spans(b, fmt.DecisionConfig(param_names=False)) if s[2] == fmt.PART_CALL])
        self.assertEqual(got, ["#1, #2"])

    def test_spans_are_disjoint_and_sorted(self):
        for think in (THINK, FULL):
            b = self.body(think)
            sp = fmt.decision_char_spans(b, fmt.DecisionConfig())
            for x, y in zip(sp, sp[1:]):
                self.assertLessEqual(x[1], y[0])


def hard_texts(body, cfg=None, part=None):
    cfg = cfg or fmt.DecisionConfig()
    sp = fmt.hard_char_spans(body, cfg)
    cut = body.index("</think>")
    return [body[a:b] for a, b in sp if part is None or (a < cut) == (part == fmt.PART_THINK)]


class HardTier(unittest.TestCase):
    """The narrow hard tier inside the decision tokens (fmt.HardConfig)."""

    def body(self, think, tool="act", args=ARGS):
        return assistant_body({"think": think, "tool": tool, "args": args})

    def test_defaults_are_one_constant_each(self):
        c = fmt.HardConfig()
        self.assertEqual((c.labels, c.ref_labels, c.word_labels, c.pick_labels, c.when_words, c.params, c.ref_params),
                         (fmt.HARD_LABELS, fmt.HARD_REF_LABELS, fmt.HARD_WORD_LABELS, fmt.HARD_PICK_LABELS,
                          fmt.HARD_WHEN_WORDS, fmt.HARD_PARAMS, fmt.HARD_REF_PARAMS))
        self.assertFalse(c.json_keys or c.pick_reasons or c.quotes or c.param_names or c.ref_sigil)
        for must in ("rows", "row", "where", "within", "exclude", "linked_to", "limit", "order", "when", "verb",
                     "direction", "op"):
            self.assertIn(must, c.params)
        for never in ("kind", "name", "text", "field", "question", "options", "reason", "group"):
            self.assertNotIn(never, c.params)
        self.assertEqual(c.labels, ())  # no slot counts by its whole value
        self.assertEqual(set(c.word_labels), {"intent", "scope", "refer", "when"})
        self.assertEqual(set(c.ref_labels), {"refer"})
        self.assertEqual(c.pick_labels, ("pick",))
        self.assertNotIn("target", c.word_labels + c.ref_labels + c.pick_labels + c.labels)
        self.assertIs(fmt.DecisionConfig().hard.labels, fmt.HARD_LABELS)

    def test_think(self):
        got = hard_texts(self.body(THINK), part=fmt.PART_THINK)
        # closed words and row numbers only: no quoted phrase, no `verb` word (the call's verb has it), the `-> @` of
        # refer stays out but its number counts, a quoted `when` is nothing (the call's date states it), pick keeps
        # numbers and ok/no
        self.assertEqual(got, ["write", "one", "it", "3", "2", "ok", "5", "no"])

    def test_ref_sigil_is_opt_in(self):
        cfg = fmt.DecisionConfig(hard=fmt.HardConfig(ref_sigil=True))
        self.assertEqual(hard_texts(self.body(THINK), cfg, fmt.PART_THINK), ["write", "one", "it", "@3", "#2", "ok", "#5", "no"])

    def test_closed_words_and_quotes(self):
        think = ('intent: count "how many"\nscope: all "every"\nrefer: both "those" -> #4, #9\nwhen: now\n'
                 'target: "kitchen" · "sink"')
        got = hard_texts(self.body(think), part=fmt.PART_THINK)
        self.assertEqual(got, ["count", "all", "both", "4", "9", "now"])
        self.assertEqual(hard_texts(self.body('when: earlier "last week"'), part=fmt.PART_THINK), ["earlier"])
        self.assertEqual(hard_texts(self.body('when: "next friday"\ntarget: "a"'), part=fmt.PART_THINK), [])
        # a number or an ok/no inside a quoted phrase is copied text, never hard
        self.assertEqual(hard_texts(self.body('intent: read "ok #5 no"\nrefer: it "no @7" -> @2'), part=fmt.PART_THINK),
                         ["read", "it", "2"])

    def test_pick_reasons_are_not_hard(self):
        think = "pick: #37 ok · #44 no (name) · #45 no (no #9 other) · #38 no (other)"
        self.assertEqual(hard_texts(self.body(think), part=fmt.PART_THINK),
                         ["37", "ok", "44", "no", "45", "no", "38", "no"])
        cfg = fmt.DecisionConfig(hard=fmt.HardConfig(pick_reasons=True))
        got = hard_texts(self.body(think), cfg, fmt.PART_THINK)
        self.assertIn("9", got)
        self.assertGreater(len(got), 8)

    def test_quotes_flag(self):
        cfg = fmt.DecisionConfig(hard=fmt.HardConfig(quotes=True))
        self.assertEqual(hard_texts(self.body('intent: read "what"'), cfg, fmt.PART_THINK), ["read"])
        self.assertEqual(hard_texts(self.body('refer: it "x @9" -> @2'), cfg, fmt.PART_THINK), ["it", "9", "2"])

    def test_hard_labels_only(self):
        # the argument slots, retry and an unknown label add nothing to the hard think tokens
        self.assertEqual(hard_texts(self.body(FULL), part=fmt.PART_THINK), hard_texts(self.body(THINK), part=fmt.PART_THINK))
        think = "retry: rejected\n" + THINK + "\nkind: event\nplan: act"
        self.assertEqual(hard_texts(self.body(think), part=fmt.PART_THINK), hard_texts(self.body(THINK), part=fmt.PART_THINK))

    def test_call_values_and_date_leaves(self):
        # verb, rows, the ref inside args and the date leaves (keys and values) of args.to and of `when`
        got = hard_texts(self.body(THINK), part=fmt.PART_CALL)
        self.assertEqual(got, ["reschedule", "#2", "hour", "1", "row", "week", "-2", "5"])
        self.assertNotIn("to:", got)
        keys = fmt.DecisionConfig(hard=fmt.HardConfig(json_keys=True))
        self.assertEqual(hard_texts(self.body(THINK), keys, fmt.PART_CALL),
                         ["reschedule", "#2", "unit", "hour", "rel", "1", "anchor", "row",
                          "unit", "week", "rel", "-2", "weekday", "5"])

    def test_rows_handle_and_selector_fields(self):
        args = {"verb": "edit", "rows": "@3", "within": "@1", "exclude": "#7, #8", "linked_to": "#4",
                "where": 'status = "open" and effort is set', "limit": "1", "order": "date desc",
                "kind": "task", "name": "Pay rent", "text": "rent", "field": "amount", "group": "status"}
        got = hard_texts(self.body(THINK, args=args), part=fmt.PART_CALL)
        self.assertEqual(got, ["edit", "@3", "@1", "#7, #8", "#4", 'status = "open" and effort is set', "1", "date desc"])

    def test_row_direction_op(self):
        args = {"row": "#99", "direction": "owes_me", "op": "balance", "kind": "debt", "reason": "never_mind"}
        self.assertEqual(hard_texts(self.body("kind: debt", "open", args), part=fmt.PART_CALL), ["#99", "owes_me", "balance"])

    def test_kind_and_free_text_are_not_hard(self):
        args = {"kind": "event", "name": "Squamish climbing day", "text": "tyre", "question": "Which one?",
                "options": "#1, #2", "reason": "not_found", "field": "amount", "value": "@4"}
        b = self.body("kind: event\nname: Squamish climbing day", "ask", args)
        self.assertEqual(hard_texts(b, part=fmt.PART_CALL), [])
        self.assertEqual(hard_texts(b, part=fmt.PART_THINK), [])

    def test_args_free_text_is_not_hard_but_its_refs_are(self):
        b = self.body("kind: task", args={"verb": "edit", "rows": "#3", "args": "name: Kitchen #7\nto: #36\nfield: password"})
        self.assertEqual(hard_texts(b, part=fmt.PART_CALL), ["edit", "#3", "#7", "#36"])

    def test_param_names_are_opt_in(self):
        cfg = fmt.DecisionConfig(hard=fmt.HardConfig(param_names=True))
        got = hard_texts(self.body(THINK), cfg, fmt.PART_CALL)
        self.assertEqual([g for g in got if g in ("verb", "rows", "when", "args")], ["verb", "rows", "when"])

    def test_hard_is_a_subset_of_the_decision_spans(self):
        for think in (THINK, FULL):
            b = self.body(think)
            dec = fmt.decision_char_spans(b, fmt.DecisionConfig())
            for a, e in fmt.hard_char_spans(b, fmt.DecisionConfig()):
                self.assertTrue(any(x <= a and e <= y for x, y, _ in dec), b[a:e])

    def test_disabled_and_empty_tier(self):
        b = self.body(THINK)
        self.assertEqual(fmt.hard_char_spans(b, fmt.DecisionConfig(hard=None)), [])
        empty = fmt.HardConfig.parse("", "", "", "", word_labels="", pick_labels="")
        self.assertTrue(empty.empty)
        self.assertEqual(fmt.hard_char_spans(b, fmt.DecisionConfig(hard=empty)), [])

    def test_parse(self):
        d = fmt.HardConfig.parse()
        self.assertEqual(d, fmt.HardConfig())
        c = fmt.HardConfig.parse("verb, scope", "refer,pick", "rows,when", "", word_labels="", pick_labels="",
                                 param_names=1, ref_sigil=None)
        self.assertEqual((c.labels, c.ref_labels, c.params, c.ref_params, c.param_names, c.ref_sigil),
                         (("verb", "scope"), ("refer", "pick"), ("rows", "when"), (), True, False))
        cfg = fmt.DecisionConfig.parse(hard=c)
        self.assertEqual(cfg.hard, c)
        self.assertEqual(hard_texts(self.body(THINK), fmt.DecisionConfig(hard=fmt.HardConfig(
            labels=("verb", "scope"), word_labels=(), ref_labels=(), pick_labels=())), fmt.PART_THINK),
            ["reschedule", 'one "it"'])


class Encoded(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        os.environ.setdefault("HF_HUB_OFFLINE", "1")
        try:
            from transformers import AutoTokenizer
            cls.tok = AutoTokenizer.from_pretrained("Qwen/Qwen3.5-0.8B")
        except Exception as e:  # noqa: BLE001
            raise unittest.SkipTest("no tokenizer: %r" % (e,))

    def test_decisions_are_trained_tokens_only(self):
        for ex in (session(), session(THINK, THINK)):
            enc = fmt.encode(self.tok, ex)
            fmt.check_decisions(enc)
            self.assertTrue(any(enc["decision"]))
            self.assertFalse(any(d and y == fmt.IGNORE for d, y in zip(enc["decision"], enc["labels"])))
            dec = self.tok.decode([t for t, d in zip(enc["input_ids"], enc["decision"]) if d])
            for want in ("reschedule", "hour", "weekday", "#2"):
                self.assertIn(want, dec)
            for bad in ("<function=", "<tool_call>", "</think>", "<|im_end|>", "<|im_start|>"):
                self.assertNotIn(bad, dec)

    def test_tool_name_is_weight_one(self):
        enc = fmt.encode(self.tok, session())
        name = self.tok.encode("act", add_special_tokens=False)
        ids, dec = enc["input_ids"], enc["decision"]
        text = enc["text"]
        pos = text.index("<function=act>") + len("<function=")
        for i, (a, b) in enumerate(enc["offsets"]):
            if a >= pos and b <= pos + 3 and text[a:b].strip() == "act":
                self.assertEqual(dec[i], 0)
        self.assertTrue(name)

    def test_untrained_repair_call_gets_no_decision(self):
        ex = session()
        ex["messages"][2]["loss"] = False
        enc = fmt.encode(self.tok, ex)
        fmt.check_decisions(enc)
        a0 = enc["ranges"][0]
        for i, (a, b) in enumerate(enc["offsets"]):
            if a0[0] <= a < a0[1]:
                self.assertEqual(enc["decision"][i], 0)

    def test_hard_bit_marks_a_decision_subset(self):
        for think in (THINK, FULL):
            enc = fmt.encode(self.tok, session(think, think))
            fmt.check_decisions(enc)
            dec = enc["decision"]
            hard = [i for i, d in enumerate(dec) if d & fmt.PART_HARD]
            self.assertTrue(hard)
            self.assertTrue(all(dec[i] & fmt.PART_MASK for i in hard))  # a hard token is a decision token
            self.assertLess(len(hard), sum(1 for d in dec if d))        # and a strict subset
            self.assertTrue(all(enc["labels"][i] != fmt.IGNORE for i in hard))
            txt = self.tok.decode([enc["input_ids"][i] for i in hard])
            for want in ("reschedule", "hour", "#2"):
                self.assertIn(want, txt)
            for bad in ("weekday", "kind", "event", "Which", "move", "friday and", "dentist", "<function=", "</think>", "<|im_end|>"):
                self.assertNotIn(bad, txt)

    def test_hard_handle_rows_and_date_leaf_records(self):
        for args, need in (({"verb": "delete", "rows": "@3"}, "@3"),
                           ({"kind": "event", "when": '{"unit":"week","rel":0,"weekday":"friday"}'}, "friday"),
                           ({"kind": "task", "name": "Pay rent", "where": "status = open"}, "status")):
            ex = session()
            ex["messages"][2]["args"] = args
            enc = fmt.encode(self.tok, ex)
            fmt.check_decisions(enc)
            txt = self.tok.decode([t for t, d in zip(enc["input_ids"], enc["decision"]) if d & fmt.PART_HARD])
            self.assertIn(need, txt)
            self.assertNotIn("rent", txt.replace("current", ""))
            self.assertNotIn("event", txt)

    def test_hard_tier_off_leaves_decisions_unchanged(self):
        ex = session(THINK, THINK)
        with_hard = fmt.encode(self.tok, ex)
        without = fmt.encode(self.tok, ex, cfg=fmt.DecisionConfig(hard=None))
        self.assertEqual([d & fmt.PART_MASK for d in with_hard["decision"]], without["decision"])
        self.assertFalse(any(d & fmt.PART_HARD for d in without["decision"]))

    def test_hard_mark_without_a_hard_token_is_caught(self):
        enc = fmt.encode(self.tok, session())
        enc["decision"] = [d & fmt.PART_MASK for d in enc["decision"]]  # the marks lost the hard bit
        with self.assertRaises(AssertionError):
            fmt.check_decisions(enc)

    def test_bad_marks_are_caught(self):
        enc = fmt.encode(self.tok, session())
        enc["decision"][enc["labels"].index(fmt.IGNORE)] = 1
        with self.assertRaises(AssertionError):
            fmt.check_decisions(enc)


class WeightedLoss(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        os.environ.setdefault("HF_HUB_OFFLINE", "1")
        try:
            import torch
            from test_batching import _build_tiny
            from transformers import AutoModelForCausalLM, AutoTokenizer
            import importlib.util
            spec = importlib.util.spec_from_file_location("train_script", HERE / "train.py")
            train = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(train)
            cls.tmp = tempfile.TemporaryDirectory()
            _build_tiny(cls.tmp.name)
            cls.model = AutoModelForCausalLM.from_pretrained(cls.tmp.name, dtype=torch.float32).eval()
            cls.tok = AutoTokenizer.from_pretrained("Qwen/Qwen3.5-0.8B")
        except Exception as e:  # noqa: BLE001
            raise unittest.SkipTest("no torch / tiny model / tokenizer: %r" % (e,))
        cls.torch, cls.train = torch, train
        cls.data = [(lambda e: (e["input_ids"], e["labels"], e["decision"]))(fmt.encode(cls.tok, ex))
                    for ex in (session(), session(THINK, THINK))]

    @staticmethod
    def old_forward_loss(torch, model, ids, labels, dev):  # train.py as it was before decision weights
        x = torch.tensor([ids], device=dev)
        y = torch.tensor(labels[1:], device=dev)
        pos = torch.nonzero(y != fmt.IGNORE).squeeze(1)
        out = model(input_ids=x, logits_to_keep=pos, use_cache=False)
        logits = out.logits[0].float()
        tgt = y[pos]
        loss = torch.nn.functional.cross_entropy(logits, tgt, reduction="sum")
        correct = (logits.argmax(-1) == tgt).sum()
        return loss, pos.numel(), correct

    def test_weight_one_is_bit_identical(self):
        torch, dev = self.torch, self.torch.device("cpu")
        for ids, labels, dec in self.data:
            old = self.old_forward_loss(torch, self.model, ids, labels, dev)
            new = self.train.forward_loss(self.model, ids, labels, dev, dec, 1.0)
            self.assertTrue(torch.equal(old[0], new[0]))
            self.assertEqual((old[1], int(old[2])), (new[1], int(new[2])))
            self.assertTrue(torch.equal(old[0], new[3]))
            # and without a mask at all
            self.assertTrue(torch.equal(old[0], self.train.forward_loss(self.model, ids, labels, dev)[0]))

    def test_weight_scales_decision_tokens_only(self):
        torch, dev = self.torch, self.torch.device("cpu")
        for ids, labels, dec in self.data:
            logits, tgt, pos = self.train.label_logits(self.model, ids, labels, dev)
            ce = torch.nn.functional.cross_entropy(logits, tgt, reduction="none")
            d = torch.tensor(dec[1:])[pos] > 0
            for w in (3.0, 5.0, 8.0):
                loss, n, _, plain = self.train.forward_loss(self.model, ids, labels, dev, dec, w)
                want = ce.sum() + (w - 1) * ce[d].sum()
                self.assertAlmostEqual(loss.item(), want.item(), delta=1e-5 * abs(want.item()))
                self.assertAlmostEqual(plain.item(), ce.sum().item(), delta=1e-5 * abs(ce.sum().item()))
                n_lab, n_dec, mass = self.train.weight_mass(labels, dec, w)
                self.assertEqual((n_lab, n_dec), (n, int(d.sum())))
                self.assertAlmostEqual(mass, n + (w - 1) * int(d.sum()))

    def test_evaluate_splits_decision_tokens(self):
        torch, dev = self.torch, self.torch.device("cpu")
        r = self.train.evaluate(self.model, self.data, dev)
        n = sum(self.train.weight_mass(l, d, 1.0)[0] for _, l, d in self.data)
        nd = sum(self.train.weight_mass(l, d, 1.0)[1] for _, l, d in self.data)
        self.assertEqual((r["n"], r["dn"]), (n, nd))
        self.assertGreater(nd, 0)
        self.assertLess(nd, n)
        self.assertAlmostEqual(r["loss"] * n, r["dloss"] * nd + r["oloss"] * (n - nd), delta=1e-5 * r["loss"] * n)

    def test_evaluate_reports_the_hard_tier(self):
        torch, dev = self.torch, self.torch.device("cpu")
        r = self.train.evaluate(self.model, self.data, dev)
        nh = sum(sum(1 for d in dec[1:] if d & fmt.PART_HARD) for _, _, dec in self.data)
        nd = sum(self.train.weight_mass(l, d, 1.0)[1] for _, l, d in self.data)
        self.assertEqual(r["hn"], nh)
        self.assertTrue(0 < r["hn"] < nd)
        # recompute the hard loss and accuracy by hand
        ce_sum = hit_sum = 0.0
        for ids, labels, dec in self.data:
            logits, tgt, pos = self.train.label_logits(self.model, ids, labels, dev)
            h = self.train.hard_mask(dec, pos, dev)
            ce = torch.nn.functional.cross_entropy(logits, tgt, reduction="none")
            ce_sum += ce[h].sum().item()
            hit_sum += (logits.argmax(-1) == tgt)[h].sum().item()
        self.assertAlmostEqual(r["hloss"], ce_sum / nh, delta=1e-5 * abs(ce_sum / nh))
        self.assertAlmostEqual(r["hacc"], hit_sum / nh, places=9)

    def test_hard_tokens_take_the_same_weight(self):
        # no second weight: the loss at W depends on the decision mask alone, not on the hard bit
        torch, dev = self.torch, self.torch.device("cpu")
        for ids, labels, dec in self.data:
            plain = [d & fmt.PART_MASK for d in dec]
            a = self.train.forward_loss(self.model, ids, labels, dev, dec, 3.0)[0]
            b = self.train.forward_loss(self.model, ids, labels, dev, plain, 3.0)[0]
            self.assertTrue(torch.equal(a, b))


# ---- the copy tier: think values that are verbatim copies of the user's message (L2, #1044)

COPY_THINK = ('intent: write "move it"\nverb: edit\npick: #2 ok\n'
              'set: notes = Dr Patel, 2 pm · to = ~dates[0] · name = Dentist visit')
COPY_MESSAGE = "please move it to friday and add notes Dr Patel, 2 pm"
COPY_BLOCK = 'vault: #2 event "Dentist visit"\ndates: friday = 2026-03-13'


def copy_session(think=COPY_THINK, message=COPY_MESSAGE, block=COPY_BLOCK):
    """One act whose think quotes the message and sets a note taken from it; the name is in the vault block only."""
    return {"messages": [
        {"role": "system", "content": "today: x", "tools": TOOLS},
        {"role": "user", "content": block + "\n\n" + message if block else message},
        {"role": "assistant", "think": think, "tool": "act",
         "args": {"verb": "edit", "rows": "#2", "args": "notes: Dr Patel, 2 pm\nname: Dentist visit"}}]}


class CopySpans(unittest.TestCase):
    """fmt.copy_char_spans: the think values that are verbatim copies of the user's message (text only, no tokenizer)."""

    def body(self, think, tool="act", args=ARGS):
        return assistant_body({"think": think, "tool": tool, "args": args})

    def copies(self, think, message, cfg=None, **kw):
        b = self.body(think, **kw)
        return [b[a:e] for a, e in fmt.copy_char_spans(b, message, cfg or fmt.DecisionConfig())]

    def test_the_quoted_phrase_of_intent_is_a_copy_when_the_message_says_it(self):
        think = 'intent: write "move it"\nverb: reschedule'
        self.assertEqual(self.copies(think, "please move it to friday"), ["move it"])  # the closed word `write` never is
        self.assertEqual(self.copies(think, "MOVE   IT  to friday"), ["move it"])     # case-insensitive, whitespace folded
        self.assertEqual(self.copies(think, "shift the dentist to friday"), [])       # not in the message: keeps its loss
        self.assertEqual(self.copies(think, "remove it from the list"), [])           # whole words: not inside `remove it`
        self.assertEqual(self.copies("intent: read\nkind: event", "what is on friday"), [])  # no phrase, nothing to copy

    def test_set_values_in_the_message_are_copies_and_dates_never(self):
        think = COPY_THINK
        both = "add notes Dr Patel, 2 pm and call it dentist visit, ~dates[0] dates[0]"
        self.assertEqual(self.copies(think, both), ["Dr Patel, 2 pm", "Dentist visit"])  # the `~dates[0]` entry is not text
        self.assertEqual(self.copies(think, "add notes Dr Patel, 2 pm"), ["Dr Patel, 2 pm"])  # the name is not in the message
        self.assertEqual(self.copies(think, "add notes Dr Smith, 2 pm"), [])

    def test_text_of_a_search_and_question_of_an_ask(self):
        search = 'intent: read "who is"\nvia: search\nkind: person\ntext: Chi'
        self.assertEqual(self.copies(search, "who is Chi", tool="answer", args={"kind": "person", "text": "Chi"}), ["who is", "Chi"])
        self.assertEqual(self.copies(search, "who is Chiara", tool="answer", args={"kind": "person", "text": "Chi"}), ["who is"])
        ask = 'intent: ask "which"\nquestion: Which one?\noptions: #1, #2'
        args = {"question": "Which one?", "options": "#1, #2"}
        self.assertEqual(self.copies(ask, "which one?", tool="ask", args=args), ["which", "Which one?"])
        self.assertEqual(self.copies(ask, "do it", tool="ask", args=args), [])

    def test_a_closed_word_is_a_copy_only_as_a_whole_word_of_the_message(self):
        think = "intent: write\nverb: edit\nset: status = open"
        self.assertEqual(self.copies(think, "reopen it"), [])  # a decision (`reopen` means open), not a copy
        self.assertEqual(self.copies(think, "open it"), ["open"])
        loose = fmt.DecisionConfig(copy=fmt.CopyConfig(whole_words=False))
        self.assertEqual(self.copies(think, "reopen it", loose), ["open"])

    def test_v4_thinks_read_the_same_way(self):
        think = 'intent: write "move it"\nverb: edit\npick: #5 (focus)\nset: name = Sam'
        self.assertEqual(self.copies(think, "move it to Sam"), ["move it", "Sam"])
        self.assertEqual(self.copies(think, "move it to Sandra"), ["move it"])

    def test_labels_are_configurable_and_none_marks_nothing(self):
        msg = "please move it to friday and add notes Dr Patel, 2 pm"
        only_set = fmt.DecisionConfig(copy=fmt.CopyConfig.parse("set"))
        self.assertEqual(self.copies(COPY_THINK, msg, only_set), ["Dr Patel, 2 pm"])
        for none in (fmt.CopyConfig.parse(""), fmt.CopyConfig(labels=())):
            self.assertTrue(none.empty)
            self.assertEqual(self.copies(COPY_THINK, msg, fmt.DecisionConfig(copy=none)), [])
        self.assertEqual(fmt.CopyConfig.parse(), fmt.CopyConfig())
        self.assertEqual(fmt.DecisionConfig().copy, fmt.CopyConfig())
        self.assertEqual(fmt.CopyConfig().labels, ("intent", "set", "text", "question"))
        self.assertNotIn("copy", repr(fmt.DecisionConfig()))  # a resume fingerprint made before the tier existed stays valid

    def test_the_person_s_words_are_what_follows_the_block(self):
        self.assertEqual(fmt.user_message('vault: #31 task "Pay rent"\ndates: x = y\n\ntick off the rent'), "tick off the rent")
        self.assertEqual(fmt.user_message("tick off the rent"), "tick off the rent")
        self.assertEqual(fmt.user_message([{"type": "text", "text": "a\n\nb"}]), "b")

    def test_copy_spans_lie_inside_the_decision_spans_of_their_labels_and_are_disjoint(self):
        think = 'intent: read "who is"\nvia: search\nkind: person\ntext: Chi\nset: name = Sam'
        b = self.body(think, tool="answer", args={"kind": "person", "text": "Chi"})
        spans = fmt.copy_char_spans(b, "who is Chi and Sam", fmt.DecisionConfig())
        self.assertEqual([b[a:e] for a, e in spans], ["who is", "Chi", "Sam"])
        dec = fmt.decision_char_spans(b, fmt.DecisionConfig())
        for a, e in spans:
            self.assertTrue(any(x <= a and e <= y for x, y, _ in dec), b[a:e])  # intent, text and set are decision labels
        for (a, e), (c, f) in zip(spans, spans[1:]):
            self.assertLessEqual(e, c)
        # `question` is no decision label: its copy span has no decision span to be carved out of
        q = self.body('intent: ask "x"\nquestion: Which one?', tool="ask", args={"question": "Which one?"})
        (a, e), = fmt.copy_char_spans(q, "which one?", fmt.DecisionConfig())
        self.assertFalse(any(x <= a and e <= y for x, y, _ in fmt.decision_char_spans(q, fmt.DecisionConfig())))


class CopyTokens(unittest.TestCase):
    """The copy bit on the tokens of an encoded session (real tokenizer)."""

    @classmethod
    def setUpClass(cls):
        os.environ.setdefault("HF_HUB_OFFLINE", "1")
        try:
            from transformers import AutoTokenizer
            cls.tok = AutoTokenizer.from_pretrained("Qwen/Qwen3.5-0.8B")
        except Exception as e:  # noqa: BLE001
            raise unittest.SkipTest("no tokenizer: %r" % (e,))

    def words(self, enc, bit, think=True):
        """The tokens carrying `bit`, decoded: by default only those of the thinks (the copy tier marks nothing else; a call repeats
        the same values as decisions)."""
        cuts = [(s, enc["text"].index("</think>", s)) for s, _ in enc["ranges"]]
        keep = [i for i, (a, b) in enumerate(enc["offsets"]) if not think or any(s <= a and b <= c for s, c in cuts)]
        return self.tok.decode([enc["input_ids"][i] for i in keep if enc["decision"][i] & bit])

    def test_copy_tokens_are_the_copied_words_and_carry_no_other_bit(self):
        enc = fmt.encode(self.tok, copy_session())
        fmt.check_decisions(enc)
        dec = enc["decision"]
        copy = [i for i, d in enumerate(dec) if d & fmt.PART_COPY]
        self.assertTrue(copy)
        self.assertTrue(all(dec[i] == fmt.PART_COPY for i in copy))  # alone: never beside a decision or hard bit
        self.assertTrue(all(enc["labels"][i] != fmt.IGNORE for i in copy))  # still label tokens
        self.assertEqual(self.words(enc, fmt.PART_COPY).split(), ["move", "it", "Dr", "Patel,", "2", "pm"])
        # what surrounds the copies stays decision: the closed word (hard), the quotes, the keys and a value the message does not say
        decided = self.words(enc, fmt.PART_MASK)
        for want in ("write", "notes", "name", "Dentist visit", "edit"):
            self.assertIn(want, decided)
        for gone in ("move it", "Patel"):
            self.assertNotIn(gone, decided)
        write = [i for i, (a, b) in enumerate(enc["offsets"]) if enc["text"][a:b].strip() == "write" and enc["labels"][i] != fmt.IGNORE]
        self.assertTrue(write and all(dec[i] & fmt.PART_HARD for i in write))
        self.assertNotIn("<|im_end|>", self.words(enc, fmt.PART_COPY))

    def test_a_value_that_is_not_in_the_message_keeps_its_loss(self):
        enc = fmt.encode(self.tok, copy_session(message="please move it to friday"))
        self.assertEqual(self.words(enc, fmt.PART_COPY).split(), ["move", "it"])
        self.assertIn("Patel", self.words(enc, fmt.PART_MASK))  # the note is a decision again
        enc = fmt.encode(self.tok, copy_session(message="shift the dentist"))
        self.assertFalse(any(d & fmt.PART_COPY for d in enc["decision"]))

    def test_the_vault_block_is_not_the_users_words(self):
        # `Dentist visit` is in the block of the message, not in what the person said: it is a decision, not a copy
        think = 'intent: write "rename it"\nverb: edit\nset: name = Dentist visit'
        enc = fmt.encode(self.tok, copy_session(think, message="rename it please"))
        self.assertEqual(self.words(enc, fmt.PART_COPY).split(), ["rename", "it"])
        self.assertIn("Dentist visit", self.words(enc, fmt.PART_MASK))
        enc = fmt.encode(self.tok, copy_session(think, message="rename it please", block=None))
        self.assertEqual(self.words(enc, fmt.PART_COPY).split(), ["rename", "it"])

    def test_the_copy_tier_only_relabels_decision_tokens(self):
        on = fmt.encode(self.tok, copy_session())
        off = fmt.encode(self.tok, copy_session(), cfg=fmt.DecisionConfig(copy=fmt.CopyConfig(labels=())))
        self.assertFalse(any(d & fmt.PART_COPY for d in off["decision"]))
        copy = [i for i, d in enumerate(on["decision"]) if d & fmt.PART_COPY]
        self.assertTrue(copy)
        for i, (a, b) in enumerate(zip(on["decision"], off["decision"])):
            if i in copy:
                self.assertTrue(b & fmt.PART_MASK)  # it was a decision token before it was carved out
            else:
                self.assertEqual(a, b)
        fmt.check_decisions(off, fmt.DecisionConfig(copy=fmt.CopyConfig(labels=())))

    def test_a_hard_token_is_never_a_copy_token(self):
        cfg = fmt.DecisionConfig(hard=fmt.HardConfig(labels=("set",)))  # the whole value of `set` becomes hard
        enc = fmt.encode(self.tok, copy_session(), cfg=cfg)
        fmt.check_decisions(enc, cfg)
        self.assertIn("Patel", self.words(enc, fmt.PART_HARD))
        self.assertEqual(self.words(enc, fmt.PART_COPY).split(), ["move", "it"])  # the note is hard now: it keeps its weight
        self.assertTrue(all(not (d & fmt.PART_COPY and d & ~fmt.PART_COPY) for d in enc["decision"]))

    def test_the_marks_are_checked_against_the_message(self):
        enc = fmt.encode(self.tok, copy_session())
        i = next(i for i, d in enumerate(enc["decision"]) if d & fmt.PART_COPY)
        enc["decision"][i] |= fmt.PART_THINK  # a copy token that is also a decision token
        with self.assertRaises(AssertionError):
            fmt.check_decisions(enc)
        enc = fmt.encode(self.tok, copy_session())
        j = next(i for i, (a, b) in enumerate(enc["offsets"]) if enc["text"][a:b].strip() == "Dent" and enc["labels"][i] != fmt.IGNORE)
        enc["decision"][j] = fmt.PART_COPY  # marked a copy, but the message does not say it
        with self.assertRaises(AssertionError):
            fmt.check_decisions(enc)

    def test_v3_1_and_v4_thinks_have_their_copies(self):
        from unittest import mock
        block = 'vault: #31 task "Pay rent" · #32 task "Book dentist"'
        msgs = [{"role": "system", "content": "today: Friday 2026-03-13\nme: Sam Park\n\nvault directory:\nlists: Home (#1)", "tools": TOOLS},
                {"role": "user", "content": block + "\n\ntick off the rent"},
                {"role": "assistant", "think": 'intent: read "find"\nvia: find\nkind: task\nname: Pay rent', "tool": "find",
                 "args": {"kind": "task", "name": "Pay rent"}},
                {"role": "tool", "content": '@1 · 1 task (showing 1) | #31 [1] task "Pay rent"'},
                {"role": "assistant", "think": 'intent: write "tick off"\nverb: complete\nscope: one\nrefer: none\ntarget: "rent"\n'
                 "pick: #31 ok · #32 no (name)", "tool": "act", "args": {"verb": "complete", "rows": "#31"}}]
        for mode, shape in (("v3.1", "scope: one"), ("v4", "pick: #31 (name)")):
            with mock.patch.dict(os.environ, {"NATIVE_TRACE": mode}):
                enc = fmt.encode(self.tok, {"messages": msgs})
                fmt.check_decisions(enc)
            self.assertIn(shape, enc["text"], mode)
            self.assertEqual(self.words(enc, fmt.PART_COPY).split(), ["tick", "off"], mode)  # the phrase of the second step
        # the first step quotes "find", which the message never says: its phrase keeps its loss


class CopyLoss(unittest.TestCase):
    """The loss on the tiny model with copy tokens in the data."""

    @classmethod
    def setUpClass(cls):
        WeightedLoss.setUpClass.__func__(cls)  # tiny model, tokenizer, the trainer module
        cls.data = [(lambda e: (e["input_ids"], e["labels"], e["decision"]))(fmt.encode(cls.tok, ex))
                    for ex in (copy_session(), copy_session(message="please move it to friday"),
                               copy_session('intent: write "move it"\nverb: edit\nset: name = Sam', message="move it to Sam"))]
        cls.nc = [sum(1 for d in dec if d & fmt.PART_COPY) for _, _, dec in cls.data]

    def weights(self, dec, pos, w, cw):
        return self.train.token_weights(dec, pos, w, "cpu", cw)[0]

    def test_the_data_has_copy_decision_and_other_tokens(self):
        self.assertTrue(all(self.nc))
        for ids, labels, dec in self.data:
            n, nd, mass = self.train.weight_mass(labels, dec, 1.0)
            self.assertTrue(0 < nd < n and mass == n)

    def test_both_weights_one_is_the_old_plain_loss_bit_for_bit(self):
        torch, dev = self.torch, self.torch.device("cpu")
        for ids, labels, dec in self.data:
            old = WeightedLoss.old_forward_loss(torch, self.model, ids, labels, dev)
            new = self.train.forward_loss(self.model, ids, labels, dev, dec, 1.0, 1.0)  # copy marks in `dec` change nothing
            self.assertTrue(torch.equal(old[0], new[0]))
            self.assertTrue(torch.equal(old[0], new[3]))
            self.assertEqual((old[1], int(old[2])), (new[1], int(new[2])))

    def test_copy_tokens_carry_the_copy_weight_decisions_the_decision_weight_the_rest_one(self):
        torch, dev = self.torch, self.torch.device("cpu")
        for ids, labels, dec in self.data:
            logits, tgt, pos = self.train.label_logits(self.model, ids, labels, dev)
            ce = torch.nn.functional.cross_entropy(logits, tgt, reduction="none")
            v = torch.tensor(dec[1:])[pos]
            d, c = (v & fmt.PART_MASK) > 0, (v & fmt.PART_COPY) > 0
            for w, cw in ((3.0, 0.0), (2.0, 0.0), (2.0, 0.5), (1.0, 0.0), (1.0, 2.0)):
                loss, n, _, plain = self.train.forward_loss(self.model, ids, labels, dev, dec, w, cw)
                want = (ce * (1.0 + (w - 1.0) * d.float() + (cw - 1.0) * c.float())).sum()
                self.assertAlmostEqual(loss.item(), want.item(), delta=1e-5 * abs(want.item()))
                self.assertAlmostEqual(plain.item(), ce.sum().item(), delta=1e-5 * ce.sum().item())  # the log stays the plain CE
                self.assertEqual(n, pos.numel())
            skipped = self.train.forward_loss(self.model, ids, labels, dev, dec, 2.0, 0.0)[0]
            self.assertAlmostEqual(skipped.item(), (ce * (1.0 + d.float()))[~c].sum().item(), delta=1e-5 * skipped.item())

    def test_the_weight_mass_is_what_the_weights_sum_to(self):
        torch, dev = self.torch, self.torch.device("cpu")
        for ids, labels, dec in self.data:
            y = torch.tensor(labels[1:])
            pos = torch.nonzero(y != fmt.IGNORE).squeeze(1)
            for w, cw in ((2.0, 0.0), (3.0, 0.0), (2.0, 0.5), (1.0, 1.0)):
                n, nd, mass = self.train.weight_mass(labels, dec, w, cw)
                nc = sum(1 for d in dec[1:] if d & fmt.PART_COPY)
                self.assertEqual(n, pos.numel())
                self.assertAlmostEqual(mass, (n - nd - nc) + w * nd + cw * nc)
                self.assertAlmostEqual(mass, float(self.weights(dec, pos, w, cw).sum()), places=4)
            self.assertLess(self.train.weight_mass(labels, dec, 2.0, 0.0)[2], self.train.weight_mass(labels, dec, 2.0, 1.0)[2])

    def test_decision_and_hard_tokens_are_never_masked(self):
        torch, dev = self.torch, self.torch.device("cpu")
        for ids, labels, dec in self.data:
            y = torch.tensor(labels[1:])
            pos = torch.nonzero(y != fmt.IGNORE).squeeze(1)
            v = torch.tensor(dec[1:])[pos]
            for w in (1.0, 2.0, 3.0):
                wt = self.weights(dec, pos, w, 0.0)
                self.assertTrue(bool((wt[(v & (fmt.PART_MASK | fmt.PART_HARD)) > 0] == w).all()))   # decision and hard: W
                self.assertTrue(bool((wt[(v & (fmt.PART_MASK | fmt.PART_COPY)) == 0] == 1.0).all()))                  # the rest: 1
                self.assertTrue(bool((wt[(v & fmt.PART_COPY) > 0] == 0.0).all()))                    # copy: nothing
            # a corrupt mark that is a copy AND a decision token still weighs as a decision token
            i = next(i for i in range(1, len(dec)) if dec[i] & fmt.PART_HARD)
            bad = list(dec)
            bad[i] |= fmt.PART_COPY
            pos_i = torch.tensor([i - 1])
            self.assertEqual(float(self.train.token_weights(bad, pos_i, 3.0, "cpu", 0.0)[0]), 3.0)

    def test_the_gradient_at_copy_weight_zero_ignores_the_copy_tokens(self):
        torch, dev = self.torch, self.torch.device("cpu")
        ids, labels, dec = self.data[0]
        params = [p for p in self.model.parameters() if p.numel() < 10 ** 6]

        def grads(labels, dec, w, cw):
            self.model.zero_grad(set_to_none=True)
            self.train.forward_loss(self.model, ids, labels, dev, dec, w, cw)[0].backward()
            return torch.cat([(p.grad if p.grad is not None else torch.zeros_like(p)).flatten().clone() for p in params])

        g = grads(labels, dec, 2.0, 0.0)
        dropped = [fmt.IGNORE if d & fmt.PART_COPY else y for y, d in zip(labels, dec)]  # the copy labels are not even there
        g2 = grads(dropped, [0 if d & fmt.PART_COPY else d for d in dec], 2.0, 1.0)
        full = grads(labels, dec, 2.0, 1.0)
        self.model.zero_grad(set_to_none=True)
        self.assertTrue(torch.allclose(g, g2, rtol=1e-3, atol=1e-6), float((g - g2).abs().max()))
        self.assertFalse(torch.allclose(g, full, rtol=1e-3, atol=1e-6))  # and with the copies counted, it is another gradient

    def test_evaluate_reports_the_copy_tokens_apart_from_the_decision_tokens(self):
        torch, dev = self.torch, self.torch.device("cpu")
        r = self.train.evaluate(self.model, self.data, dev)
        n = sum(self.train.weight_mass(l, d, 1.0)[0] for _, l, d in self.data)
        nd = sum(self.train.weight_mass(l, d, 1.0)[1] for _, l, d in self.data)
        nc = sum(sum(1 for x in d[1:] if x & fmt.PART_COPY) for _, _, d in self.data)
        self.assertEqual((r["n"], r["dn"], r["cn"]), (n, nd, nc))
        self.assertTrue(0 < nc < n and 0 < nd < n)
        ce_sum = hit_sum = 0.0
        for ids, labels, dec in self.data:
            logits, tgt, pos = self.train.label_logits(self.model, ids, labels, dev)
            c = self.train.copy_mask(dec, pos, dev)
            ce = torch.nn.functional.cross_entropy(logits, tgt, reduction="none")
            ce_sum += ce[c].sum().item()
            hit_sum += (logits.argmax(-1) == tgt)[c].sum().item()
        self.assertAlmostEqual(r["closs"], ce_sum / nc, delta=1e-5 * abs(ce_sum / nc))
        self.assertAlmostEqual(r["cacc"], hit_sum / nc, places=9)
        # the three kinds partition the label tokens
        self.assertAlmostEqual(r["loss"] * n, r["dloss"] * nd + r["closs"] * nc + r["oloss"] * (n - nd - nc), delta=1e-5 * r["loss"] * n)


class StubEvaluate(unittest.TestCase):
    """train.evaluate and the loss on a stub model: no tokenizer, no HF model, the numbers worked out by hand."""

    V, MARGIN = 11, 4.0

    @classmethod
    def setUpClass(cls):
        try:
            import importlib.util
            import torch
            spec = importlib.util.spec_from_file_location("train_script", HERE / "train.py")
            cls.train = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(cls.train)
        except Exception as e:  # noqa: BLE001
            raise unittest.SkipTest("no torch: %r" % (e,))
        cls.torch = torch
        V, M = cls.V, cls.MARGIN

        class Stub(torch.nn.Module):
            """The logits at each kept position: the target token is predicted when its id is even, the next id when it is odd."""

            def forward(self, input_ids, logits_to_keep, use_cache=False):
                tgt = input_ids[0, logits_to_keep + 1]
                pred = torch.where(tgt % 2 == 0, tgt, (tgt + 1) % V)
                lg = torch.zeros(len(tgt), V)
                lg[torch.arange(len(tgt)), pred] = M
                return type("Out", (), {"logits": lg[None]})()

        cls.model = Stub()
        I = fmt.IGNORE
        T, C, H = fmt.PART_THINK, fmt.PART_COPY, fmt.PART_CALL | fmt.PART_HARD
        # (ids, labels, decision): a plain token, a decision, a hard decision and a copy token in each, ids below V
        cls.data = [
            ([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], [I, 2, 3, 4, 5, 6, 7, 8, 9, 10], [0, 0, T, T, H, C, C, 0, C, T]),
            ([3, 2, 2, 4, 6, 8, 3, 5, 10, 1, 2], [I, I, 2, 4, 6, 8, 3, 5, 10, 1, I], [0, 0, T, 0, H, C, C, C, T, 0, 0])]

    def worked_out(self):
        import math
        V, M = self.V, self.MARGIN
        hit_ce = math.log(V - 1 + math.exp(M)) - M
        miss_ce = math.log(V - 1 + math.exp(M))
        cats = {k: [] for k in ("all", "dec", "hard", "copy", "other")}
        for ids, labels, dec in self.data:
            for p in range(len(ids) - 1):
                if labels[p + 1] == fmt.IGNORE:
                    continue
                t, d = ids[p + 1], dec[p + 1]
                one = (hit_ce if t % 2 == 0 else miss_ce, t % 2 == 0)
                cats["all"].append(one)
                if d & fmt.PART_MASK:
                    cats["dec"].append(one)
                    if d & fmt.PART_HARD:
                        cats["hard"].append(one)
                elif d & fmt.PART_COPY:
                    cats["copy"].append(one)
                else:
                    cats["other"].append(one)
        return {k: (len(v), sum(x for x, _ in v) / max(len(v), 1), sum(h for _, h in v) / max(len(v), 1)) for k, v in cats.items()}

    def test_every_category_is_counted_and_averaged(self):
        w = self.worked_out()
        r = self.train.evaluate(self.model, self.data, self.torch.device("cpu"))
        for key, (n, loss, acc) in (("", w["all"]), ("d", w["dec"]), ("h", w["hard"]), ("c", w["copy"])):
            self.assertEqual(r["n" if not key else key + "n"], n, key)
            self.assertAlmostEqual(r["loss" if not key else key + "loss"], loss, places=5, msg=key)
            self.assertAlmostEqual(r["acc" if not key else key + "acc"], acc, places=9, msg=key)
        self.assertAlmostEqual(r["oloss"], w["other"][1], places=5)
        self.assertTrue(w["copy"][0] and w["hard"][0] and w["dec"][0] and w["other"][0])
        self.assertEqual(w["all"][0], w["dec"][0] + w["copy"][0] + w["other"][0])  # decision, copy and other partition the labels

    def test_the_report_line_has_a_copy_segment(self):
        import contextlib
        import io
        r = self.train.evaluate(self.model, self.data, self.torch.device("cpu"))
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            self.train.report("VAL", 5, r)
        line = buf.getvalue()
        self.assertIn("copy loss", line)
        self.assertIn("over %d tokens" % r["cn"], line)

    def test_the_loss_weighs_each_category_and_a_copy_weight_of_zero_drops_it(self):
        torch = self.torch
        ids, labels, dec = self.data[0]
        logits, tgt, pos = self.train.label_logits(self.model, ids, labels, torch.device("cpu"))
        ce = torch.nn.functional.cross_entropy(logits, tgt, reduction="none")
        v = torch.tensor(dec[1:])[pos]
        for w, cw in ((2.0, 0.0), (3.0, 0.5), (1.0, 0.0)):
            loss, n, _, plain = self.train.loss_from_logits(logits, tgt, pos, dec, w, "cpu", cw)
            want = sum(float(c) * (w if d & fmt.PART_MASK else cw if d & fmt.PART_COPY else 1.0) for c, d in zip(ce, v.tolist()))
            self.assertAlmostEqual(loss.item(), want, places=4)
            self.assertAlmostEqual(plain.item(), ce.sum().item(), places=4)
        plain_path = self.train.loss_from_logits(logits, tgt, pos, dec, 1.0, "cpu", 1.0)[0]
        self.assertTrue(torch.equal(plain_path, torch.nn.functional.cross_entropy(logits, tgt, reduction="sum")))


if __name__ == "__main__":
    unittest.main()
