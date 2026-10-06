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


if __name__ == "__main__":
    unittest.main()
