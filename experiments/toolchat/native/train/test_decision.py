"""Tests for the decision-token mask (fmt.py) and the decision-weighted loss (train.py).

    HF_HUB_OFFLINE=1 python -m unittest train/test_decision.py

The span rules run on text only; encode() needs the Qwen tokenizer; the loss tests need torch and
build a tiny random Qwen3.5 (skipped when those are not around).
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

TOOLS = [{"type": "function", "function": {"name": n, "description": "d", "parameters": {"type": "object", "properties": {}}}}
         for n in ("act", "answer", "ask")]
V1 = ("saw: #1 Dentist visit, #2 Gym class · last: #2 Gym class · intent: write reschedule · kind: event · "
      "cond: when · plan: act")
V2 = ('intent: write "move it"\nverb: reschedule\nscope: one "it"\nrefer: it "it" -> @3\nwhen: "friday"\n'
      'pick: #2 ok | #5 no (other day)')
ARGS = {"verb": "reschedule", "rows": "#2", "args": 'to: {"unit":"hour","rel":1,"anchor":"row"}',
        "when": '{"unit":"week","rel":-2,"weekday":5}'}


def session(think1=V1, think2="plan: answer"):
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
        import render
        return render._assistant_body({"think": think, "tool": tool, "args": args})

    def test_v1_think_values(self):
        b = self.body(V1)
        got = texts(b, [s for s in fmt.decision_char_spans(b, fmt.DecisionConfig()) if s[2] == fmt.PART_THINK])
        # saw / last count by their row refs only; the other slots by their whole value
        self.assertEqual(got, ["#1", "#2", "#2", "write reschedule", "event", "when", "act"])

    def test_ref_labels_none_takes_the_whole_value(self):
        b = self.body(V1)
        cfg = fmt.DecisionConfig(ref_labels=())
        got = texts(b, [s for s in fmt.decision_char_spans(b, cfg) if s[2] == fmt.PART_THINK])
        self.assertEqual(got[:2], ["#1 Dentist visit, #2 Gym class", "#2 Gym class"])

    def test_v2_labels(self):
        b = self.body(V2)
        got = texts(b, [s for s in fmt.decision_char_spans(b, fmt.DecisionConfig()) if s[2] == fmt.PART_THINK])
        self.assertEqual(got, ['write "move it"', "reschedule", 'one "it"', 'it "it" -> @3', '"friday"',
                               "#2 ok | #5 no (other day)"])

    def test_labels_are_configurable(self):
        b = self.body(V2)
        cfg = fmt.DecisionConfig.parse(labels="verb,refer")
        got = texts(b, [s for s in fmt.decision_char_spans(b, cfg) if s[2] == fmt.PART_THINK])
        self.assertEqual(got, ["reschedule", 'it "it" -> @3'])

    def test_unknown_label_and_retry_are_not_decisions(self):
        b = self.body("retry: previous call rejected · plan: act")
        got = texts(b, [s for s in fmt.decision_char_spans(b, fmt.DecisionConfig()) if s[2] == fmt.PART_THINK])
        self.assertEqual(got, ["act"])

    def test_call_values(self):
        b = self.body(V1)
        cfg = fmt.DecisionConfig(param_names=False, json_keys=False)
        got = texts(b, [s for s in fmt.decision_char_spans(b, cfg) if s[2] == fmt.PART_CALL])
        self.assertEqual(got, ["reschedule", "#2", "to:", "hour", "1", "row", "week", "-2", "5"])

    def test_call_keys_and_names(self):
        b = self.body(V1)
        got = texts(b, [s for s in fmt.decision_char_spans(b, fmt.DecisionConfig()) if s[2] == fmt.PART_CALL])
        self.assertEqual(got, ["verb", "reschedule", "rows", "#2", "args", "to:", "unit", "hour", "rel", "1", "anchor",
                               "row", "when", "unit", "week", "rel", "-2", "weekday", "5"])

    def test_tool_name_and_scaffolding_stay_out(self):
        b = self.body(V1)
        got = texts(b, fmt.decision_char_spans(b, fmt.DecisionConfig()))
        for bad in ("<function", "tool_call", "im_end", "</think>", "<parameter"):
            self.assertFalse(any(bad in t for t in got), bad)
        # the only `act` is the think's `plan: act`; the tool name in `<function=act>` is not marked
        c0 = b.index("<function=act>") + len("<function=")
        self.assertFalse(any(a <= c0 < e for a, e, _ in fmt.decision_char_spans(b, fmt.DecisionConfig())))

    def test_skip_params(self):
        b = self.body("plan: ask", "ask", {"question": "Which one?", "options": "#1, #2"})
        got = texts(b, [s for s in fmt.decision_char_spans(b, fmt.DecisionConfig(param_names=False)) if s[2] == fmt.PART_CALL])
        self.assertEqual(got, ["#1, #2"])

    def test_spans_are_disjoint_and_sorted(self):
        for think in (V1, V2):
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
        import render
        return render._assistant_body({"think": think, "tool": tool, "args": args})

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
        self.assertEqual(set(c.ref_labels), {"last", "refer"})
        self.assertEqual(c.pick_labels, ("pick",))
        self.assertNotIn("target", c.word_labels + c.ref_labels + c.pick_labels + c.labels)
        self.assertIs(fmt.DecisionConfig().hard.labels, fmt.HARD_LABELS)

    def test_v1_think(self):
        # intent by its closed word only; `last` by its row numbers; kind, cond, plan and `saw` are not hard
        self.assertEqual(hard_texts(self.body(V1), part=fmt.PART_THINK), ["2", "write"])

    def test_v1_saw_is_opt_in(self):
        cfg = fmt.DecisionConfig(hard=fmt.HardConfig(ref_labels=("saw", "last")))
        self.assertEqual(hard_texts(self.body(V1), cfg, fmt.PART_THINK), ["1", "2", "2", "write"])
        cfg = fmt.DecisionConfig(hard=fmt.HardConfig(ref_labels=("saw", "last"), ref_sigil=True))
        self.assertEqual(hard_texts(self.body(V1), cfg, fmt.PART_THINK), ["#1", "#2", "#2", "write"])

    def test_v2_think(self):
        got = hard_texts(self.body(V2), part=fmt.PART_THINK)
        # closed words and row numbers only: no quoted phrase, no `verb` word (the call's verb has it), the `-> @` of
        # refer stays out but its number counts, a quoted-only `when` is nothing, pick keeps numbers and ok/no
        self.assertEqual(got, ["write", "one", "it", "3", "2", "ok", "5", "no"])

    def test_v2_closed_words_and_quotes(self):
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

    def test_v2_hard_labels_only(self):
        think = V2 + "\nkind: event\nplan: act\nretry: x"
        self.assertEqual(hard_texts(self.body(think), part=fmt.PART_THINK), hard_texts(self.body(V2), part=fmt.PART_THINK))

    def test_call_values_and_date_leaves(self):
        # verb, rows, the ref inside args and the date leaves (keys and values) of args.to and of `when`
        got = hard_texts(self.body(V1), part=fmt.PART_CALL)
        self.assertEqual(got, ["reschedule", "#2", "hour", "1", "row", "week", "-2", "5"])
        self.assertNotIn("to:", got)
        keys = fmt.DecisionConfig(hard=fmt.HardConfig(json_keys=True))
        self.assertEqual(hard_texts(self.body(V1), keys, fmt.PART_CALL),
                         ["reschedule", "#2", "unit", "hour", "rel", "1", "anchor", "row",
                          "unit", "week", "rel", "-2", "weekday", "5"])

    def test_rows_handle_and_selector_fields(self):
        args = {"verb": "edit", "rows": "@3", "within": "@1", "exclude": "#7, #8", "linked_to": "#4",
                "where": 'status = "open" and effort is set', "limit": "1", "order": "date desc",
                "kind": "task", "name": "Pay rent", "text": "rent", "field": "amount", "group": "status"}
        got = hard_texts(self.body(V1, args=args), part=fmt.PART_CALL)
        self.assertEqual(got, ["edit", "@3", "@1", "#7, #8", "#4", 'status = "open" and effort is set', "1", "date desc"])

    def test_row_direction_op(self):
        args = {"row": "#99", "direction": "owes_me", "op": "balance", "kind": "debt", "reason": "never_mind"}
        self.assertEqual(hard_texts(self.body("plan: open", "open", args), part=fmt.PART_CALL), ["#99", "owes_me", "balance"])

    def test_kind_and_free_text_are_not_hard(self):
        args = {"kind": "event", "name": "Squamish climbing day", "text": "tyre", "question": "Which one?",
                "options": "#1, #2", "reason": "not_found", "field": "amount", "value": "@4"}
        b = self.body("plan: ask", "ask", args)
        self.assertEqual(hard_texts(b, part=fmt.PART_CALL), [])
        self.assertEqual(hard_texts(b, part=fmt.PART_THINK), [])

    def test_args_free_text_is_not_hard_but_its_refs_are(self):
        b = self.body("plan: act", args={"verb": "edit", "rows": "#3", "args": "name: Kitchen #7\nto: #36\nfield: password"})
        self.assertEqual(hard_texts(b, part=fmt.PART_CALL), ["edit", "#3", "#7", "#36"])

    def test_param_names_are_opt_in(self):
        cfg = fmt.DecisionConfig(hard=fmt.HardConfig(param_names=True))
        got = hard_texts(self.body(V1), cfg, fmt.PART_CALL)
        self.assertEqual([g for g in got if g in ("verb", "rows", "when", "args")], ["verb", "rows", "when"])

    def test_hard_is_a_subset_of_the_decision_spans(self):
        for think in (V1, V2):
            b = self.body(think)
            dec = fmt.decision_char_spans(b, fmt.DecisionConfig())
            for a, e in fmt.hard_char_spans(b, fmt.DecisionConfig()):
                self.assertTrue(any(x <= a and e <= y for x, y, _ in dec), b[a:e])

    def test_disabled_and_empty_tier(self):
        b = self.body(V1)
        self.assertEqual(fmt.hard_char_spans(b, fmt.DecisionConfig(hard=None)), [])
        empty = fmt.HardConfig.parse("", "", "", "", word_labels="", pick_labels="")
        self.assertTrue(empty.empty)
        self.assertEqual(fmt.hard_char_spans(b, fmt.DecisionConfig(hard=empty)), [])

    def test_parse(self):
        d = fmt.HardConfig.parse()
        self.assertEqual(d, fmt.HardConfig())
        c = fmt.HardConfig.parse("verb, scope", "saw,last", "rows,when", "", word_labels="", pick_labels="",
                                 param_names=1, ref_sigil=None)
        self.assertEqual((c.labels, c.ref_labels, c.params, c.ref_params, c.param_names, c.ref_sigil),
                         (("verb", "scope"), ("saw", "last"), ("rows", "when"), (), True, False))
        cfg = fmt.DecisionConfig.parse(hard=c)
        self.assertEqual(cfg.hard, c)
        self.assertEqual(hard_texts(self.body(V2), fmt.DecisionConfig(hard=fmt.HardConfig(
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
        for ex in (session(), session(V2, V2)):
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
        for think in (V1, V2):
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
            for bad in ("weekday", "kind", "event", "Which", "move", "friday and", "other day", "dentist", "<function=", "</think>", "<|im_end|>"):
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
        ex = session(V2, V2)
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
                    for ex in (session(), session(V2, V2))]

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


if __name__ == "__main__":
    unittest.main()
