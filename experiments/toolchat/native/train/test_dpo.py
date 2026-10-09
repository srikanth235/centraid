"""Tests for train.py --dpo (the DPO loss on preference pairs, --dpo-beta, --dpo-sft) and its opt-in nature.

    HF_HUB_OFFLINE=1 python -m unittest train/test_dpo.py

The runs reuse test_resume.py's tiny model, data and setup (6 steps of 2 sequences, one mark at the end); the pair file holds 12
pairs, so a DPO run is 6 steps of 2 pairs too. CPU, float32, single process: exact, not a tolerance, where a run is compared with a run.
"""
from __future__ import annotations

import contextlib
import gzip
import io
import json
import math
import os
import re
import signal
import sys
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import test_resume as tr  # noqa: E402  (a module, not its class: the loader would run ResumeTest here too)
from test_decision import FULL, THINK, session  # noqa: E402

BS, STEPS, PAIRS = tr.BS, tr.STEPS, tr.STEPS * tr.BS


def pair_records(i):
    """(chosen, rejected) of pair i: one session (same system, same user message), two different assistant answers."""
    def rec(think1, think2, rows):
        ex = session(think1, think2)
        ex["messages"][1]["content"] = "move the dentist %d hours and the %d th gym class" % (i, i * 7)
        ex["messages"][2]["args"] = dict(ex["messages"][2]["args"], rows=rows)
        return ex
    return rec(FULL, THINK, "#%d" % (i % 5 + 1)), rec(THINK, FULL, "#%d" % (i % 5 + 2))


class DpoTest(unittest.TestCase):
    tearDownClass = classmethod(tr.ResumeTest.tearDownClass.__func__)
    run_once = classmethod(tr.ResumeTest.run_once.__func__)
    losses = staticmethod(tr.ResumeTest.losses)
    out = tr.ResumeTest.out
    same_params = tr.ResumeTest.same_params

    # ---- harness ------------------------------------------------------------------------------------

    @classmethod
    def pair_file(cls, name="pairs.jsonl", n=PAIRS, gz=False):
        path = os.path.join(cls.tmp, name)
        with (gzip.open(path, "wt") if gz else open(path, "w")) as f:
            for i in range(n):
                c, r = pair_records(i)
                f.write(json.dumps({"id": "p%d" % i, "chosen": c, "rejected": r}) + "\n")
        return path

    @classmethod
    def drive(cls, out, *flags, train=True, hook=None, pairs=None):
        """train.main() once, in process, with --dpo (and, unless `train` is False, the SFT file as --train). `hook(n)` runs before the n-th
        policy forward (1-based, the reference pass included). Returns dict(model, log, out, meta, steps, dpo, ref)."""
        torch, train_mod = cls.torch, cls.train
        real_fwd, n_call, models, refs = train_mod.forward_logp, [0], [], []
        real_from, real_ref = cls.AutoModel.from_pretrained, train_mod.dpo_reference

        def fwd(*a, **k):
            n_call[0] += 1
            if hook:
                hook(n_call[0])
            return real_fwd(*a, **k)

        def from_pretrained(*a, **k):
            models.append(real_from(*a, **k))
            return models[-1]

        def dpo_reference(*a, **k):
            table = real_ref(*a, **k)
            refs.append((table, table.clone()))  # the table the loop reads, and its value when it was made
            return table

        argv = ["train.py", "--model", cls.model_dir, "--val", cls.data, "--out", str(out)] + tr.BASE \
            + (["--train", cls.data] if train else []) + ["--dpo", pairs or cls.pairs] + list(flags)
        buf = io.StringIO()
        try:
            with mock.patch.object(sys, "argv", argv), mock.patch.object(train_mod, "forward_logp", fwd), \
                    mock.patch.object(train_mod, "dpo_reference", dpo_reference), \
                    mock.patch.object(cls.AutoModel, "from_pretrained", from_pretrained), contextlib.redirect_stdout(buf):
                train_mod.main()
        finally:
            signal.signal(signal.SIGTERM, signal.SIG_DFL)
            text = buf.getvalue()
        mp = Path(out) / "train_meta.json"
        meta = json.loads(mp.read_text()) if mp.exists() else None
        return {"model": models[0] if models else None, "log": text, "out": Path(out), "steps": cls.losses(text), "meta": meta,
                "dpo": cls.dpo_lines(text), "ref": refs}

    @staticmethod
    def dpo_lines(text):
        return [(int(m.group(1)), float(m.group(2)), float(m.group(3)), float(m.group(4)))
                for m in re.finditer(r"DPO step (\d+)/\d+ dpo-loss ([-\d.]+) margin ([-\d.]+) acc ([\d.]+)", text)]

    @classmethod
    def setUpClass(cls):
        tr.ResumeTest.setUpClass.__func__(cls)
        cls.pairs = cls.pair_file()

    def init_model(self):
        return self.AutoModel.from_pretrained(self.model_dir, dtype=self.torch.float32)

    def tensor(self, *x):
        return self.torch.tensor(x, dtype=self.torch.float64)

    # ---- the loss ----------------------------------------------------------------------------------

    def test_identical_chosen_and_rejected_cost_log_2_and_margin_0(self):
        loss, margin = self.train.dpo_loss(self.tensor(-30.0), self.tensor(-30.0), self.tensor(-41.0), self.tensor(-41.0), 0.1)
        self.assertAlmostEqual(loss.item(), math.log(2), places=12)
        self.assertEqual(margin.item(), 0.0)
        # the policy equal to the reference (shifted alike) is the same: the margin is relative to the reference
        loss, margin = self.train.dpo_loss(self.tensor(-30.0), self.tensor(-50.0), self.tensor(-30.0), self.tensor(-50.0), 0.1)
        self.assertAlmostEqual(loss.item(), math.log(2), places=12)
        self.assertEqual(margin.item(), 0.0)

    def test_the_loss_on_a_hand_made_case(self):
        t = self.tensor
        # policy up 2 on the chosen, down 2 on the rejected, against the reference: beta * (2 - (-2)) = 0.4
        loss, margin = self.train.dpo_loss(t(-10.0), t(-20.0), t(-12.0), t(-18.0), 0.1)
        self.assertAlmostEqual(margin.item(), 0.4, places=12)
        self.assertAlmostEqual(loss.item(), -math.log(1 / (1 + math.exp(-0.4))), places=12)
        loss, margin = self.train.dpo_loss(t(-12.0), t(-18.0), t(-10.0), t(-20.0), 0.1)  # the other way round
        self.assertAlmostEqual(margin.item(), -0.4, places=12)
        self.assertAlmostEqual(loss.item(), -math.log(1 / (1 + math.exp(0.4))), places=12)
        loss, _ = self.train.dpo_loss(t(-10.0), t(-20.0), t(-12.0), t(-18.0), 0.5)  # beta scales the margin
        self.assertAlmostEqual(loss.item(), -math.log(1 / (1 + math.exp(-2.0))), places=12)

    def test_the_gradient_raises_the_chosen_and_lowers_the_rejected(self):
        t = self.torch
        pc, pr = t.tensor(-10.0, dtype=t.float64, requires_grad=True), t.tensor(-20.0, dtype=t.float64, requires_grad=True)
        self.train.dpo_loss(pc, pr, t.tensor(-12.0), t.tensor(-18.0), 0.1)[0].backward()
        self.assertLess(pc.grad.item(), 0)  # descending on the loss raises logp(chosen)
        self.assertGreater(pr.grad.item(), 0)
        self.assertAlmostEqual(pc.grad.item(), -pr.grad.item(), places=12)

    def test_logp_is_the_sum_over_the_label_tokens_of_the_sft_mask(self):
        torch, train = self.torch, self.train
        model = self.init_model()
        pairs = self.load_pairs(self.pairs)
        for p in pairs[:3]:
            for ex in (p.chosen, p.rejected):
                ids, labels, dec = ex
                logp, sft, plain, n = train.forward_logp(model, ex, torch.device("cpu"))
                logits, tgt, pos = train.label_logits(model, ids, labels, torch.device("cpu"))
                lp = torch.log_softmax(logits, -1).gather(1, tgt[:, None]).sum()
                self.assertEqual(n, sum(1 for y in labels[1:] if y != train.fmt.IGNORE))  # the SFT mask, first token excluded
                self.assertAlmostEqual(logp.item(), lp.item(), places=3)
                self.assertAlmostEqual(logp.item(), -plain.item(), places=3)
                self.assertAlmostEqual(sft.item(), plain.item() / n, places=4)  # weights 1: the mean CE of the record

    def load_pairs(self, path):
        from transformers import AutoTokenizer
        tok = AutoTokenizer.from_pretrained(self.model_dir)
        cfg = self.train.fmt.DecisionConfig.parse(None, None, None, None)
        return self.train.load_pairs(tok, path, 1024, 0, None, 4, cfg)

    def test_an_identical_pair_at_the_reference_is_log_2_with_margin_0_end_to_end(self):
        torch, train = self.torch, self.train
        model = self.init_model()
        dev = torch.device("cpu")
        p = self.load_pairs(self.pairs)[0]
        twin = train.DpoPair("same", p.chosen, p.chosen)
        ref = train.dpo_reference(model, [twin, p], dev)
        loss, dloss, margin, _ = train.dpo_pair_loss(model, twin, ref[0], 0.1, 0.0, dev)
        self.assertAlmostEqual(dloss.item(), math.log(2), places=6)
        self.assertAlmostEqual(margin.item(), 0.0, places=6)
        self.assertAlmostEqual(loss.item(), math.log(2), places=6)
        # a real pair at the reference: the margin is 0 too (policy == reference), and the SFT term adds sft * the chosen's mean CE
        loss, dloss, margin, plain = train.dpo_pair_loss(model, p, ref[1], 0.1, 0.5, dev)
        self.assertAlmostEqual(margin.item(), 0.0, places=6)
        self.assertAlmostEqual(dloss.item(), math.log(2), places=6)
        self.assertAlmostEqual(loss.item() - dloss.item(), 0.5 * plain.item() / sum(1 for y in p.chosen[1][1:] if y != train.fmt.IGNORE),
                               places=5)

    # ---- training ----------------------------------------------------------------------------------

    def trained_margins(self, r):
        """The implicit reward margin of every training pair under the model a run ended with, against the run's own reference table."""
        torch = self.torch
        now = self.train.dpo_reference(r["model"], self.load_pairs(self.pairs), torch.device("cpu"))
        ref = r["ref"][0][0]
        return 0.1 * ((now[:, 0] - ref[:, 0]) - (now[:, 1] - ref[:, 1]))

    def test_a_few_steps_lower_the_dpo_loss_and_raise_the_margin(self):
        r = self.drive(self.out(), "--log-every", "1", "--lr", "3e-4", "--epochs", "2")
        d = r["dpo"]
        self.assertEqual([x[0] for x in d], list(range(1, 2 * STEPS + 1)))
        self.assertAlmostEqual(d[0][1], math.log(2), places=3)  # step 1 (logged to 4 places): the policy still is the reference
        self.assertAlmostEqual(d[0][2], 0.0, places=3)
        mean = lambda xs: sum(xs) / len(xs)  # noqa: E731
        first, second = d[:STEPS], d[STEPS:]  # the second epoch sees the pairs the first one trained on
        self.assertLess(mean([x[1] for x in second]), mean([x[1] for x in first]))
        self.assertGreater(mean([x[2] for x in second]), mean([x[2] for x in first]))
        self.assertGreater(mean([x[3] for x in second]), 0.5)  # most pairs are ranked right
        margins = self.trained_margins(r)
        self.assertGreater(margins.mean().item(), 0.1)
        self.assertGreater((margins > 0).double().mean().item(), 0.5)
        self.assertEqual([e["step"] for e in r["meta"]["dpo"]], list(range(1, 2 * STEPS + 1)))
        self.assertAlmostEqual(r["meta"]["dpo"][-1]["margin"], d[-1][2], places=3)  # the log rounds to 4 places
        self.assertTrue((r["out"] / "DONE").exists())
        self.assertEqual(sorted(p.name for p in r["out"].glob("ckpt-*")), ["ckpt-100"])
        self.assertIn("DPO reference: 12 pairs scored", r["log"])

    def test_the_sft_term_and_beta_change_the_run(self):
        a = self.drive(self.out(), "--log-every", "1", "--dpo-sft", "0")
        b = self.drive(self.out(), "--log-every", "1", "--dpo-sft", "1.0")
        c = self.drive(self.out(), "--log-every", "1", "--dpo-sft", "0", "--dpo-beta", "0.5")
        self.assertEqual(a["dpo"][0][1:3], b["dpo"][0][1:3])  # step 1: the policy is the reference whatever the extras
        with self.assertRaises(AssertionError):
            self.same_params(a["model"], b["model"])
        self.assertNotEqual(a["dpo"][-1], c["dpo"][-1])
        self.assertNotEqual(a["steps"], b["steps"])  # the step line's loss is the chosen NLL: the SFT term lowers it faster

    def test_the_reference_is_the_frozen_initial_model(self):
        torch = self.torch
        r = self.drive(self.out(), "--epochs", "2", "--lr", "3e-4", "--log-every", "1")
        self.assertEqual(len(r["ref"]), 1)  # scored once, before training, whatever the epochs
        table, at_birth = r["ref"][0]
        self.assertTrue(torch.equal(table, at_birth))  # and never touched by the steps
        init = self.init_model()
        fresh = self.train.dpo_reference(init, self.load_pairs(self.pairs), torch.device("cpu"))
        self.assertTrue(torch.equal(table, fresh))  # = the initial weights' log-probs, bit for bit
        with self.assertRaises(AssertionError):
            self.same_params(init, r["model"])  # the policy moved, the reference did not
        self.assertEqual(len(r["dpo"]), 2 * STEPS)
        self.assertGreater(self.trained_margins(r).mean().item(), 0.1)  # measured against the table, which is the init's

    def test_a_pair_is_two_forwards(self):
        n = [0]
        self.drive(self.out(), hook=lambda k: n.__setitem__(0, k))
        # the reference pass (2 per pair, once) + 2 per pair and epoch (the memory probe and the autocast check are CUDA only)
        self.assertEqual(n[0], 2 * PAIRS + 2 * PAIRS)

    def test_train_may_be_omitted(self):
        r = self.drive(self.out(), "--log-every", "1", "--lr", "3e-4", train=False)
        self.assertTrue((r["out"] / "DONE").exists())
        self.assertEqual(len(r["dpo"]), STEPS)
        self.assertGreater(self.trained_margins(r).mean().item(), 0.1)
        self.assertEqual([e["step"] for e in r["meta"]["train"]], [0, STEPS])  # the TRAIN metrics score the chosen records
        self.assertGreater(r["meta"]["train"][0]["n"], 0)
        r2 = self.drive(self.out(), "--log-every", "1", "--lr", "3e-4", pairs=self.pair_file("pairs.jsonl.gz", gz=True), train=False)
        self.assertEqual(r2["dpo"], r["dpo"])  # a gzipped pair file is the same file

    def test_marks_ema_and_val_keep_working(self):
        r = self.drive(self.out(), "--ema", "0.5", "--checkpoints", "0.5,1.0")
        self.assertEqual(sorted(p.name for p in r["out"].glob("ckpt-*")), ["ckpt-050", "ckpt-050-ema", "ckpt-100", "ckpt-100-ema"])
        marks = json.loads((r["out"] / "marks.json").read_text())["marks"]
        self.assertEqual(sorted(marks), ["ckpt-050", "ckpt-100"])
        self.assertIn("dloss", marks["ckpt-100"]["val"])  # the usual SFT metrics on --val
        self.assertEqual([e["step"] for e in r["meta"]["ema_val"]], [3, 6])
        self.assertTrue((r["out"] / "best.json").exists())
        self.assertEqual((r["out"] / "FINAL").read_text().strip(), "ckpt-100")

    # ---- resume ------------------------------------------------------------------------------------

    def test_resume_after_a_sigterm_is_bit_identical(self):
        flags = ("--lr", "3e-4", "--log-every", "1")
        ref = self.drive(self.out(), *flags)
        out = self.out()
        first = self.drive(out, *flags, "--resume", "--save-every", "100",
                           hook=lambda n: os.kill(os.getpid(), signal.SIGTERM) if n == 2 * PAIRS + 4 * 3 - 1 else None)  # in step 3
        self.assertIn("PREEMPTED at step 3/6", first["log"])
        second = self.drive(out, *flags, "--resume", "--save-every", "100")
        self.assertIn("step 3/6", second["log"])
        self.assertIn("DPO reference: 12 pairs scored", second["log"])  # the reference is rebuilt from the same initial weights
        self.same_params(ref["model"], second["model"])
        self.assertEqual(first["dpo"] + second["dpo"], ref["dpo"])
        self.assertEqual({**first["steps"], **second["steps"]}, ref["steps"])
        self.assertEqual(second["meta"]["dpo"], ref["meta"]["dpo"])
        self.assertEqual(second["meta"]["val"], ref["meta"]["val"])

    def test_resume_refuses_to_switch_dpo_on(self):
        out = self.out()
        self.run_once(out, "--save-every", "3")  # an SFT run
        (Path(out) / "DONE").unlink()
        with self.assertRaises(SystemExit) as cm:
            self.drive(out, "--resume")
        msg = str(cm.exception)
        self.assertIn("different run", msg)
        self.assertIn("pairs.jsonl", msg)  # the checkpoint says dpo None, this run names the file
        self.assertIn("'dpo': None", msg)

    def test_resume_refuses_to_change_the_dpo_flags(self):
        for flags, shown in ((("--dpo-beta", "0.3"), "'dpo_beta': 0.3"), (("--dpo-sft", "0"), "'dpo_sft': 0.0")):
            out = self.out()
            self.drive(out, "--save-every", "3")
            (Path(out) / "DONE").unlink()
            with self.assertRaises(SystemExit) as cm:
                self.drive(out, "--resume", *flags)
            self.assertIn(shown, str(cm.exception))

    def test_resume_refuses_to_switch_dpo_off(self):
        out = self.out()
        self.drive(out, "--save-every", "3")
        (Path(out) / "DONE").unlink()
        with self.assertRaises(SystemExit) as cm:
            self.run_once(out, "--resume")
        self.assertIn("different run", str(cm.exception))

    def test_an_old_checkpoint_fingerprint_reads_as_no_dpo(self):
        fp = {"bs": 2, "ema": 0.0}  # a fingerprint written before the flags existed
        self.assertEqual({**self.train.FP_LEGACY, **fp}["dpo"], None)
        self.assertEqual({**self.train.FP_LEGACY, **fp}["dpo_beta"], self.train.DPO_BETA)
        for k in ("dpo", "dpo_beta", "dpo_sft"):
            self.assertIn(k, self.train.FP_ARGS)
            self.assertIn(k, self.train.FP_LEGACY)

    # ---- the pair file ------------------------------------------------------------------------------

    def test_bad_pairs_are_skipped_and_none_left_is_a_stop(self):
        path = os.path.join(self.tmp, "mixed.jsonl")
        c, r = pair_records(0)
        with open(path, "w") as f:
            f.write(json.dumps({"id": "ok", "chosen": c, "rejected": r}) + "\n")
            f.write(json.dumps({"id": "no-rejected", "chosen": c}) + "\n")
            f.write(json.dumps({"id": "no-messages", "chosen": {"x": 1}, "rejected": r}) + "\n")
            f.write(json.dumps([1, 2]) + "\n")
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            pairs = self.load_pairs(path)
        self.assertEqual([p.id for p in pairs], ["ok"])
        self.assertIn("3 unrenderable or malformed skipped", buf.getvalue())
        empty = os.path.join(self.tmp, "empty.jsonl")
        Path(empty).write_text(json.dumps({"id": "x", "chosen": {"x": 1}, "rejected": {"x": 1}}) + "\n")
        with self.assertRaises(SystemExit), contextlib.redirect_stdout(io.StringIO()):
            self.load_pairs(empty)

    def test_a_pair_over_max_len_is_dropped_whole(self):
        from transformers import AutoTokenizer
        tok = AutoTokenizer.from_pretrained(self.model_dir)
        cfg = self.train.fmt.DecisionConfig.parse(None, None, None, None)
        c, r = pair_records(0)
        long_r = json.loads(json.dumps(r))
        long_r["messages"][1]["content"] = "move the dentist " + "and the gym class " * 60  # only the rejected record is long
        path = os.path.join(self.tmp, "long.jsonl")
        with open(path, "w") as f:
            for pid, rej in (("ok", r), ("long-rejected", long_r)):
                f.write(json.dumps({"id": pid, "chosen": c, "rejected": rej}) + "\n")
        with contextlib.redirect_stdout(io.StringIO()) as buf:
            both = self.train.load_pairs(tok, path, 4096, 0, None, 4, cfg)
            ok = both[0]
            got = self.train.load_pairs(tok, path, max(len(ok.chosen[0]), len(ok.rejected[0])) + 10, 0, None, 4, cfg)
        self.assertEqual([p.id for p in both], ["ok", "long-rejected"])
        self.assertEqual([p.id for p in got], ["ok"])  # a long rejected record costs the whole pair, not one side of it
        self.assertIn("1 over max-len", buf.getvalue())

    # ---- SFT is untouched ---------------------------------------------------------------------------

    def test_without_dpo_the_dpo_flags_change_nothing(self):
        r = self.run_once(self.out(), "--dpo-beta", "0.4", "--dpo-sft", "3")
        self.same_params(self.ref["model"], r["model"])
        self.assertEqual(r["steps"], self.ref["steps"])
        self.assertEqual(r["meta"]["train"], self.ref["meta"]["train"])
        self.assertEqual(r["meta"]["val"], self.ref["meta"]["val"])
        self.assertNotIn("dpo", r["meta"])
        self.assertNotIn("DPO", r["log"])
        self.assertEqual(self.dpo_lines(r["log"]), [])

    def test_the_reference_run_has_no_dpo_state(self):
        self.assertNotIn("dpo", self.ref["meta"])
        self.assertIsNone(self.ref["meta"]["args"]["dpo"])
        self.assertEqual(sorted(self.ref["steps"]), [2, 4, 6])

    def test_dpo_alone_does_not_need_train_and_sft_alone_does(self):
        with mock.patch.object(sys, "argv", ["train.py", "--out", "o"]), self.assertRaises(SystemExit), \
                contextlib.redirect_stderr(io.StringIO()):
            self.train.main()
        a = self.train.parser().parse_args(["--dpo", "p.jsonl"])
        self.assertEqual((a.train, a.dpo, a.dpo_beta, a.dpo_sft), (None, "p.jsonl", 0.1, 0.2))


if __name__ == "__main__":
    unittest.main()
