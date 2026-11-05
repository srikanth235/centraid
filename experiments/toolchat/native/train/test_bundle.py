"""Tests for bundle.py: the trainer flags a staged job carries (job.json `train_args`).

    python -m unittest train/test_bundle.py

These read the flags off the parser and `train_args`, and stage a small bundle into a scratch directory. The defaults of the order and the
marks live in train.py: a flag not given is not in the job, a flag given is pinned there.
"""
from __future__ import annotations

import contextlib
import io
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import bundle  # noqa: E402


def args(*flags):
    return bundle.train_args(bundle.parser().parse_args(["build", "job", "--train", "t.jsonl.zst", *flags]))


class TrainArgs(unittest.TestCase):
    def test_the_defaults_pin_nothing_of_the_order_or_the_marks(self):
        a = args()
        self.assertEqual(a, ["--bs", "16", "--lr", "2e-05", "--max-len", "8192", "--embed", "freeze", "--val-n", "400"])
        for flag in ("--checkpoints", "--pair-batches", "--no-pair-batches", "--arm"):
            self.assertNotIn(flag, a)  # train.py's defaults apply: pairs in one step, four marks

    def test_an_arm_carries_its_own_lr(self):
        a = args("--arm", "C")
        self.assertEqual(a[a.index("--arm") + 1], "C")
        self.assertNotIn("--lr", a)  # arms.py's default for the arm, unless --lr is given
        self.assertEqual(args("--arm", "C", "--lr", "1e-3")[args("--arm", "C", "--lr", "1e-3").index("--lr") + 1], "0.001")

    def test_the_marks_are_carried_when_given(self):
        a = args("--checkpoints", "0.5,1.0", "--train-eval-n", "50")
        self.assertEqual(a[a.index("--checkpoints") + 1], "0.5,1.0")
        self.assertEqual(a[a.index("--train-eval-n") + 1], "50")
        self.assertNotIn("--no-pair-batches", a)

    def test_the_data_version_is_carried_when_given_and_is_metadata_only(self):
        self.assertNotIn("--data-version", args())
        a = args("--data-version", "data-v7")
        self.assertEqual(a[a.index("--data-version") + 1], "data-v7")
        self.assertEqual([x for x in a if x != "--data-version" and x != "data-v7"], args())  # nothing else in the job moves

    def test_the_data_version_is_a_data_tag(self):
        for bad in ("v7", "data-7", "data-v", "data-v7x", ""):
            with self.assertRaises(SystemExit), contextlib.redirect_stderr(io.StringIO()):
                args("--data-version", bad)

    def test_ema_is_carried_only_when_given(self):
        self.assertNotIn("--ema", args())
        a = args("--ema", "0.999")
        self.assertEqual(a[a.index("--ema") + 1], "0.999")

    def test_pair_batches_is_a_tri_state(self):
        self.assertIn("--pair-batches", args("--pair-batches"))
        self.assertNotIn("--no-pair-batches", args("--pair-batches"))
        self.assertIn("--no-pair-batches", args("--no-pair-batches"))
        self.assertNotIn("--pair-batches", args("--no-pair-batches"))

    # ---- --continue-from: the continuation preset ----------------------------------------------------

    def parsed(self, *flags):
        a = bundle.parser().parse_args(["build", "job", "--train", "t.jsonl.zst", *flags])
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
        t = args("--dpo", "/x/pairs.jsonl.zst")
        self.assertEqual(self.value(t, "--dpo"), "data/dpo.jsonl.zst")  # the name inside the bundle, not the local path
        self.assertNotIn("--dpo-beta", t)
        self.assertNotIn("--dpo-sft", t)
        t = args("--dpo", "pairs.jsonl", "--dpo-beta", "0.2", "--dpo-sft", "0")
        self.assertEqual([self.value(t, f) for f in ("--dpo", "--dpo-beta", "--dpo-sft")], ["data/dpo.jsonl", "0.2", "0.0"])

    def test_dpo_on_top_of_the_continuation(self):
        t = args("--continue-from", "gs://b/rft/ckpt-100", "--dpo", "p.jsonl.zst", "--dpo-beta", "0.1")
        self.assertEqual(self.value(t, "--lr"), "4e-06")
        self.assertEqual(self.value(t, "--dpo"), "data/dpo.jsonl.zst")

    def test_main_refuses_the_misuses_before_staging_anything(self):
        from unittest import mock
        for argv, why in ((["build", "j", "--train", "t", "--continue-from", "/local/ckpt"], "gs://"),
                          (["build", "j", "--train", "t", "--dpo", "/no/such/pairs.jsonl"], "not a file")):
            with mock.patch.object(sys, "argv", ["bundle.py", *argv]), self.assertRaises(SystemExit) as cm:
                bundle.main()
            self.assertIn(why, str(cm.exception), argv)

    def test_a_build_stages_the_trainer_and_the_records(self):
        from unittest import mock
        import json
        import tarfile
        with tempfile.TemporaryDirectory() as d:
            for name in ("train", "val", "test", "pairs"):
                (Path(d) / (name + ".jsonl.zst")).write_bytes(name.encode())
            argv = ["build", "j", "--train", str(Path(d) / "train.jsonl.zst"), "--val", str(Path(d) / "val.jsonl.zst"), "--test",
                    str(Path(d) / "test.jsonl.zst"), "--dpo", str(Path(d) / "pairs.jsonl.zst"), "--arm", "B"]
            with mock.patch.object(bundle, "STAGE", Path(d) / "stage"), mock.patch.object(sys, "argv", ["bundle.py", *argv]), \
                    contextlib.redirect_stdout(io.StringIO()):
                bundle.main()
            data = Path(d) / "stage" / "j" / "data"
            job = json.loads((data / "job.json").read_text())
            self.assertEqual((job["train"], job["val"], job["test"]), ("data/train.jsonl.zst", "data/val.jsonl.zst", "data/test.jsonl.zst"))
            self.assertEqual(job["model"], bundle.arms.ARMS["B"].base)  # train.py refuses an --arm whose base is not --model
            with tarfile.open(data / "bundle.dat") as tf:
                names = sorted(tf.getnames())
            self.assertEqual([n for n in names if n.startswith("train/")], ["train/arms.py", "train/datagen.py", "train/train.py"])
            self.assertIn("data/dpo.jsonl.zst", names)
            self.assertFalse([n for n in names if "nativetools" in n or n.startswith(("eval", "authored"))])  # no runtime, no scorer

    def test_the_flags_are_ones_train_py_accepts(self):
        import importlib.util
        try:
            spec = importlib.util.spec_from_file_location("train_script", HERE / "train.py")
            train = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(train)
        except Exception as e:  # noqa: BLE001
            raise unittest.SkipTest("no torch: %r" % (e,))
        a = args("--checkpoints", "0.25,0.5,0.75,1.0", "--no-pair-batches", "--save-every", "30", "--resume", "--train-eval-n", "50")
        got = train.parser().parse_args(["--train", "t", "--out", "o", *a])  # the same list run_job.sh hands the trainer
        self.assertEqual((got.pair_batches, got.checkpoints), (False, "0.25,0.5,0.75,1.0"))
        a = args("--data-version", "data-v7")
        got = train.parser().parse_args(["--train", "t", "--out", "o", *a])
        self.assertEqual(got.data_version, "data-v7")  # reaches vars(a), so the `args` of train_meta.json
        self.assertIsNone(train.parser().parse_args(["--train", "t", "--out", "o"]).data_version)
        with self.assertRaises(SystemExit), contextlib.redirect_stderr(io.StringIO()):
            train.parser().parse_args(["--train", "t", "--out", "o", "--data-version", "v7"])
        self.assertNotIn("data_version", train.FP_ARGS)  # a resume may name it freely: it changes no number
        a = args("--continue-from", "gs://b/soup/ckpt", "--dpo", "p.jsonl.zst", "--dpo-beta", "0.2", "--dpo-sft", "0.1")
        got = train.parser().parse_args(["--out", "o", *a])  # --train is optional with --dpo
        self.assertEqual((got.epochs, got.lr, got.min_lr, got.warmup, got.ema, got.dpo, got.dpo_beta, got.dpo_sft),
                         (1, 4e-6, 0.05, 0.02, 0.999, "data/dpo.jsonl.zst", 0.2, 0.1))


if __name__ == "__main__":
    unittest.main()
