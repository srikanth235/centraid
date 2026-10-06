"""Tests for bundle.py: the trainer flags a staged job carries (job.json `train_args`).

    python -m unittest train/test_bundle.py

A build needs the runtime binary, so these read the flags off the parser and `train_args` instead of staging a bundle. The defaults of the
loss, the order and the marks live in train.py: a flag not given is not in the job, a flag given is pinned there.
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import bundle  # noqa: E402


def args(*flags):
    return bundle.train_args(bundle.parser().parse_args(["build", "job", "--train", "t.jsonl.gz", *flags]))


class TrainArgs(unittest.TestCase):
    def test_the_defaults_pin_nothing_of_the_loss_the_order_or_the_marks(self):
        a = args()
        self.assertEqual(a, ["--bs", "16", "--lr", "2e-05", "--max-len", "8192", "--embed", "freeze", "--val-n", "400"])
        for flag in ("--decision-weight", "--copy-weight", "--copy-labels", "--checkpoints", "--pair-batches", "--no-pair-batches"):
            self.assertNotIn(flag, a)  # train.py's defaults apply: decision weight 2, copy weight 0, pairs in one step, four marks

    def test_the_new_flags_are_carried_when_given(self):
        a = args("--copy-weight", "0.25", "--copy-labels", "intent,set", "--checkpoints", "0.5,1.0", "--decision-weight", "3")
        self.assertEqual(a[a.index("--copy-weight") + 1], "0.25")
        self.assertEqual(a[a.index("--copy-labels") + 1], "intent,set")
        self.assertEqual(a[a.index("--checkpoints") + 1], "0.5,1.0")
        self.assertEqual(a[a.index("--decision-weight") + 1], "3.0")
        self.assertNotIn("--no-pair-batches", a)

    def test_ema_is_carried_only_when_given(self):
        self.assertNotIn("--ema", args())
        a = args("--ema", "0.999")
        self.assertEqual(a[a.index("--ema") + 1], "0.999")

    def test_the_legacy_loss_and_order_are_three_flags(self):
        a = args("--decision-weight", "1", "--copy-weight", "1", "--no-pair-batches")
        self.assertEqual(a[a.index("--decision-weight") + 1], "1.0")
        self.assertEqual(a[a.index("--copy-weight") + 1], "1.0")
        self.assertIn("--no-pair-batches", a)
        self.assertNotIn("--pair-batches", a)

    def test_pair_batches_is_a_tri_state(self):
        self.assertIn("--pair-batches", args("--pair-batches"))
        self.assertNotIn("--no-pair-batches", args("--pair-batches"))
        self.assertIn("--no-pair-batches", args("--no-pair-batches"))
        self.assertNotIn("--pair-batches", args("--no-pair-batches"))

    def test_an_empty_copy_labels_is_carried_as_the_empty_value(self):
        a = args("--copy-labels", "")  # '' = no copy tokens at all, as --hard-labels ''
        self.assertEqual(a[a.index("--copy-labels") + 1], "")

    # ---- --continue-from: the continuation preset ----------------------------------------------------

    def parsed(self, *flags):
        a = bundle.parser().parse_args(["build", "job", "--train", "t.jsonl.gz", *flags])
        return a, bundle.train_args(a)

    def value(self, a, flag):
        return a[a.index(flag) + 1]

    def test_continue_from_sets_the_continuation_defaults_in_one_flag(self):
        a, t = self.parsed("--continue-from", "gs://b/soup/ckpt")
        self.assertEqual(a.init_ckpt, "gs://b/soup/ckpt")  # job.json `init`: build() reads a.init_ckpt
        self.assertEqual([self.value(t, f) for f in ("--epochs", "--lr", "--min-lr", "--warmup", "--ema")],
                         ["1", "4e-06", "0.05", "0.02", "0.999"])
        self.assertEqual(float(self.value(t, "--lr")), 4e-6)

    def test_an_explicit_flag_beats_the_preset(self):
        _, t = self.parsed("--continue-from", "gs://b/soup/ckpt", "--lr", "1e-5", "--epochs", "2", "--min-lr", "0.2",
                           "--warmup", "0", "--ema", "0")
        self.assertEqual([self.value(t, f) for f in ("--epochs", "--lr", "--min-lr", "--warmup")], ["2", "1e-05", "0.2", "0.0"])
        self.assertNotIn("--ema", t)  # an explicit 0 = no EMA, which train.py's default already is
        _, t = self.parsed("--continue-from", "gs://b/soup/ckpt", "--ema", "0.99")
        self.assertEqual(self.value(t, "--ema"), "0.99")
        self.assertEqual(self.value(t, "--lr"), "4e-06")  # the others keep the preset

    def test_without_it_nothing_changes(self):
        a, t = self.parsed()
        self.assertIsNone(a.init_ckpt)
        for flag in ("--epochs", "--warmup", "--min-lr", "--ema", "--dpo"):
            self.assertNotIn(flag, t)
        self.assertEqual(self.value(t, "--lr"), "2e-05")
        a, t = self.parsed("--init-ckpt", "gs://b/p7/ckpt-100")  # --init-ckpt alone: init only, no preset
        self.assertEqual(a.init_ckpt, "gs://b/p7/ckpt-100")
        self.assertEqual(self.value(t, "--lr"), "2e-05")
        for flag in ("--epochs", "--min-lr", "--ema"):
            self.assertNotIn(flag, t)

    def test_continue_from_and_a_different_init_ckpt_is_an_error(self):
        a = bundle.parser().parse_args(["build", "job", "--train", "t", "--continue-from", "gs://b/a", "--init-ckpt", "gs://b/c"])
        with self.assertRaises(SystemExit):
            bundle.resolve(a)
        a = bundle.parser().parse_args(["build", "job", "--train", "t", "--continue-from", "gs://b/a", "--init-ckpt", "gs://b/a"])
        bundle.resolve(a)  # the same checkpoint twice is not a conflict
        self.assertEqual(a.init_ckpt, "gs://b/a")

    def test_resolve_is_idempotent(self):
        a = bundle.parser().parse_args(["build", "job", "--train", "t", "--continue-from", "gs://b/a", "--lr", "1e-5"])
        bundle.resolve(a)
        first = bundle.train_args(a)
        self.assertEqual(bundle.train_args(a), first)

    def test_epochs_alone_is_carried(self):
        self.assertEqual(self.value(args("--epochs", "3"), "--epochs"), "3")

    # ---- --dpo ----------------------------------------------------------------------------------------

    def test_dpo_flags_are_carried_only_when_given(self):
        for flag in ("--dpo", "--dpo-beta", "--dpo-sft"):
            self.assertNotIn(flag, args())
        t = args("--dpo", "/x/pairs.jsonl.gz")
        self.assertEqual(self.value(t, "--dpo"), "data/dpo.jsonl.gz")  # the name inside the bundle, not the local path
        self.assertNotIn("--dpo-beta", t)
        self.assertNotIn("--dpo-sft", t)
        t = args("--dpo", "pairs.jsonl", "--dpo-beta", "0.2", "--dpo-sft", "0")
        self.assertEqual([self.value(t, f) for f in ("--dpo", "--dpo-beta", "--dpo-sft")], ["data/dpo.jsonl", "0.2", "0.0"])

    def test_dpo_on_top_of_the_continuation(self):
        t = args("--continue-from", "gs://b/rft/ckpt-100", "--dpo", "p.jsonl.gz", "--dpo-beta", "0.1")
        self.assertEqual(self.value(t, "--lr"), "4e-06")
        self.assertEqual(self.value(t, "--dpo"), "data/dpo.jsonl.gz")

    def test_main_refuses_the_misuses_before_staging_anything(self):
        from unittest import mock
        for argv, why in ((["build", "j", "--train", "t", "--continue-from", "/local/ckpt"], "gs://"),
                          (["build", "j", "--dpo", "p.jsonl"], "--train"),
                          (["build", "j", "--train", "t", "--dpo", "/no/such/pairs.jsonl"], "not a file"),
                          (["build", "j", "--base", "--continue-from", "gs://b/c"], "training flags")):
            with mock.patch.object(sys, "argv", ["bundle.py", *argv]), self.assertRaises(SystemExit) as cm:
                bundle.main()
            self.assertIn(why, str(cm.exception), argv)

    def test_the_flags_are_ones_train_py_accepts(self):
        import importlib.util
        try:
            spec = importlib.util.spec_from_file_location("train_script", HERE / "train.py")
            train = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(train)
        except Exception as e:  # noqa: BLE001
            raise unittest.SkipTest("no torch: %r" % (e,))
        a = args("--decision-weight", "1", "--copy-weight", "0", "--copy-labels", "intent", "--no-pair-batches", "--checkpoints",
                 "0.25,0.5,0.75,1.0", "--save-every", "30", "--resume", "--train-eval-n", "50", "--hard-labels", "")
        got = train.parser().parse_args(["--train", "t", "--out", "o", *a])  # the same list run_job.sh hands the trainer
        self.assertEqual((got.decision_weight, got.copy_weight, got.copy_labels, got.pair_batches, got.checkpoints),
                         (1.0, 0.0, "intent", False, "0.25,0.5,0.75,1.0"))
        a = args("--continue-from", "gs://b/soup/ckpt", "--dpo", "p.jsonl.gz", "--dpo-beta", "0.2", "--dpo-sft", "0.1")
        got = train.parser().parse_args(["--out", "o", *a])  # --train is optional with --dpo
        self.assertEqual((got.epochs, got.lr, got.min_lr, got.warmup, got.ema, got.dpo, got.dpo_beta, got.dpo_sft),
                         (1, 4e-6, 0.05, 0.02, 0.999, "data/dpo.jsonl.gz", 0.2, 0.1))


if __name__ == "__main__":
    unittest.main()
