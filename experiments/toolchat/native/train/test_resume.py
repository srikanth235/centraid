"""Tests for train.py's preemption-safe resume (--save-every / --resume / SIGTERM).

    HF_HUB_OFFLINE=1 python -m unittest train/test_resume.py

Tiny random Qwen3.5 on the CPU (the approach of test_decision.py), driven through train.main() itself.
An interrupted-and-resumed run must leave bit-identical parameters, logged losses and eval history to an
uninterrupted one (CPU, float32, single process: exact, not a tolerance).
"""
from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import os
import re
import shutil
import signal
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import fmt  # noqa: E402
from test_decision import V1, V2, session  # noqa: E402

STEPS, BS = 6, 2  # 12 examples
BASE = ["--bs", str(BS), "--lr", "1e-3", "--warmup", "0.2", "--log-every", "2", "--val-n", "4",
        "--train-eval-n", "4", "--checkpoints", "1.0", "--no-grad-ckpt", "--max-len", "1024", "--seed", "3"]


class Killed(Exception):
    """A hard kill (no SIGTERM, no notice): the process just stops."""


class ResumeTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        os.environ.setdefault("HF_HUB_OFFLINE", "1")
        try:
            import torch
            from test_batching import _build_tiny
            from transformers import AutoModelForCausalLM
            spec = importlib.util.spec_from_file_location("train_script", HERE / "train.py")
            cls.train = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(cls.train)
            cls.tmp = tempfile.mkdtemp(prefix="resume-test-")
            cls.model_dir = os.path.join(cls.tmp, "model")
            _build_tiny(cls.model_dir)
        except Exception as e:  # noqa: BLE001
            raise unittest.SkipTest("no torch / tiny model / tokenizer: %r" % (e,))
        cls.torch, cls.AutoModel = torch, AutoModelForCausalLM
        cls.data = os.path.join(cls.tmp, "train.jsonl")
        with open(cls.data, "w") as f:
            for i in range(STEPS * BS):
                ex = session(V1 if i % 2 else V2, V2 if i % 3 else V1)
                ex["messages"][1]["content"] = "move the dentist %d hours and the %d th gym class" % (i, i * 7)
                ex["messages"][2]["args"] = dict(ex["messages"][2]["args"], rows="#%d" % (i % 5 + 1))
                f.write(json.dumps(ex) + "\n")
        cls.ref = cls.run_once(os.path.join(cls.tmp, "ref"))  # no new flag: the behaviour of before

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    @classmethod
    def run_once(cls, out, *flags, hook=None, cuts=None):
        """train.main() once, in process. Returns dict(model, steps {step: loss text}, log, meta, out).
        `hook(n)` is called before the n-th micro-batch forward (1-based), to kill or SIGTERM the run."""
        torch, train = cls.torch, cls.train
        real_fwd, n_call, models = train.forward_loss, [0], []
        real_from = cls.AutoModel.from_pretrained

        def fwd(*a, **k):
            n_call[0] += 1
            if hook:
                hook(n_call[0])
            return real_fwd(*a, **k)

        def from_pretrained(*a, **k):
            models.append(real_from(*a, **k))
            return models[-1]

        argv = ["train.py", "--model", cls.model_dir, "--train", cls.data, "--val", cls.data, "--out", str(out)] \
            + BASE + list(flags)
        buf = io.StringIO()
        try:
            with mock.patch.object(sys, "argv", argv), mock.patch.object(train, "forward_loss", fwd), \
                    mock.patch.object(cls.AutoModel, "from_pretrained", from_pretrained), \
                    contextlib.redirect_stdout(buf):
                train.main()
        finally:
            signal.signal(signal.SIGTERM, signal.SIG_DFL)
            text = buf.getvalue()
        mp = Path(out) / "train_meta.json"
        return {"model": models[0] if models else None, "log": text, "out": Path(out), "steps": cls.losses(text),
                "meta": json.loads(mp.read_text()) if mp.exists() else None}

    @staticmethod
    def losses(text):
        return {int(m.group(1)): m.group(2) for m in re.finditer(r"^\S+ step (\d+)/\d+ loss ([\d.]+)", text, re.M)}

    def out(self, name="out"):
        d = tempfile.mkdtemp(prefix=name + "-", dir=self.tmp)
        self.addCleanup(shutil.rmtree, d, ignore_errors=True)
        return d

    def same_params(self, a, b):
        sa, sb = a.state_dict(), b.state_dict()
        self.assertEqual(sa.keys(), sb.keys())
        for k in sa:
            self.assertTrue(self.torch.equal(sa[k], sb[k]), k)

    def same_run(self, first, second):
        """`first` then `second` (the resumed one) == the uninterrupted reference, bit for bit."""
        self.same_params(self.ref["model"], second["model"])
        got = {**first["steps"], **second["steps"]}
        self.assertEqual(got, self.ref["steps"])
        self.assertEqual(sorted(got), [2, 4, 6])
        for key in ("train", "val"):  # the eval history: step 0 from the first run, the rest from both
            self.assertEqual(second["meta"][key], self.ref["meta"][key])
        self.assertEqual([e["step"] for e in second["meta"]["val"]], [0, STEPS])

    def resume_dirs(self, out):
        return sorted(p.name for p in Path(out).glob("*resume-step-*"))

    def kill_in_step(self, n):
        def hook(call):
            if call == n * BS - 1:  # in the middle of step n
                raise Killed
        return hook

    # ---- (a) 3 + resume + 3 == 6 ------------------------------------------------------------------

    def test_defaults_write_no_resume_state(self):
        self.assertEqual(self.resume_dirs(self.ref["out"]), [])
        self.assertTrue((self.ref["out"] / "DONE").exists())
        self.assertFalse((self.ref["out"] / "PREEMPTED").exists())
        self.assertEqual(sorted(self.ref["steps"]), [2, 4, 6])

    def test_sigterm_at_step_3_then_resume_is_bit_identical(self):
        out = self.out()
        first = self.run_once(out, "--resume", "--save-every", "100",
                              hook=lambda n: os.kill(os.getpid(), signal.SIGTERM) if n == 3 * BS else None)
        self.assertIn("starting fresh", first["log"])
        self.assertIn("PREEMPTED at step 3/6", first["log"])
        self.assertTrue((Path(out) / "PREEMPTED").exists())
        self.assertFalse((Path(out) / "DONE").exists())
        self.assertEqual(json.loads((Path(out) / "PREEMPTED").read_text())["resume_step"], 3)
        self.assertEqual(self.resume_dirs(out), ["resume-step-000003"])
        self.assertEqual(sorted(first["steps"]), [2])
        second = self.run_once(out, "--resume", "--save-every", "100")
        self.assertIn("RESUMED from %s/resume-step-000003: step 3/6" % out, second["log"])
        self.assertIn("the next step is 4", second["log"])
        self.assertEqual(sorted(second["steps"]), [4, 6])
        self.assertTrue((Path(out) / "DONE").exists())
        self.assertFalse((Path(out) / "PREEMPTED").exists())
        self.same_run(first, second)

    def test_hard_kill_replays_from_the_last_periodic_checkpoint(self):
        out = self.out()
        with self.assertRaises(Killed):
            self.run_once(out, "--resume", "--save-every", "3", hook=self.kill_in_step(5))
        self.assertEqual(self.resume_dirs(out), ["resume-step-000003"])
        second = self.run_once(out, "--resume", "--save-every", "3")
        self.assertIn("step 3/6", second["log"])
        self.same_params(self.ref["model"], second["model"])
        self.assertEqual(second["steps"], {k: v for k, v in self.ref["steps"].items() if k > 3})
        self.assertEqual(second["meta"]["val"], self.ref["meta"]["val"])

    def test_save_every_alone_does_not_change_the_run(self):
        r = self.run_once(self.out(), "--save-every", "2")
        self.same_params(self.ref["model"], r["model"])
        self.assertEqual(r["steps"], self.ref["steps"])
        self.assertEqual(r["meta"]["train"], self.ref["meta"]["train"])

    # ---- (b) a partial checkpoint is ignored ------------------------------------------------------

    def test_partial_and_temporary_checkpoints_are_ignored(self):
        out = self.out()
        with self.assertRaises(Killed):
            self.run_once(out, "--resume", "--save-every", "3", hook=self.kill_in_step(5))
        root = Path(out)
        (root / ".tmp-resume-step-000005-1").mkdir()  # a save cut short
        (root / ".tmp-resume-step-000005-1" / "state.pt").write_bytes(b"x" * 100)
        (root / "resume-step-000006").mkdir()  # renamed but never marked complete
        (root / "resume-step-000006" / "state.pt").write_bytes(b"not a checkpoint")
        (root / "resume-step-000004").mkdir()  # marked complete, then the state file was truncated
        (root / "resume-step-000004" / "state.pt").write_bytes(b"short")
        (root / "resume-step-000004" / "COMPLETE").write_text(json.dumps({"step": 4, "state_bytes": 10 ** 6}))
        self.assertEqual(self.train.find_resume(root).name, "resume-step-000003")
        second = self.run_once(out, "--resume", "--save-every", "3")
        self.assertIn("RESUMED from %s/resume-step-000003: step 3/6" % out, second["log"])
        self.same_params(self.ref["model"], second["model"])

    def test_only_a_partial_checkpoint_means_a_fresh_start(self):
        out = self.out()
        (Path(out) / ".tmp-resume-step-000004-9").mkdir(parents=True)
        (Path(out) / "resume-step-000004").mkdir()
        r = self.run_once(out, "--resume")
        self.assertIn("starting fresh", r["log"])
        self.same_params(self.ref["model"], r["model"])
        self.assertEqual(r["steps"], self.ref["steps"])

    # ---- (c) only the latest two are kept ---------------------------------------------------------

    def test_only_the_latest_two_are_kept(self):
        out = self.out()
        r = self.run_once(out, "--save-every", "1")
        self.assertEqual(self.resume_dirs(out), ["resume-step-000004", "resume-step-000005"])  # 1-3 pruned; none at 6
        self.assertEqual(r["log"].count("RESUME-CKPT periodic"), 5)
        for d in Path(out).glob("resume-step-*"):
            self.assertIsNotNone(self.train.resume_complete(d))

    def test_save_resume_unit(self):
        torch, out = self.torch, Path(self.out())
        for step in (1, 2, 3, 4):
            d, nbytes, _ = self.train.save_resume(out, step, {"epoch": 0, "x": torch.arange(10) + step})
            self.assertEqual(self.train.resume_complete(d), step)
        self.assertEqual(self.resume_dirs(out), ["resume-step-000003", "resume-step-000004"])
        self.assertEqual(self.train.find_resume(out).name, "resume-step-000004")
        self.assertEqual(self.train.find_resume(out / "resume-step-000003").name, "resume-step-000003")
        self.assertEqual(int(self.train.load_resume(out / "resume-step-000004")["x"][0]), 4)
        self.assertIsNone(self.train.find_resume(out / "nothing-here"))

    # ---- (d) no checkpoint: a fresh start ---------------------------------------------------------

    def test_resume_without_a_checkpoint_starts_fresh(self):
        out = self.out()
        r = self.run_once(out, "--resume")
        self.assertIn("RESUME: no complete resume checkpoint in %s; starting fresh" % out, r["log"])
        self.assertNotIn("RESUMED from", r["log"])
        self.same_params(self.ref["model"], r["model"])
        self.assertEqual(r["steps"], self.ref["steps"])
        self.assertEqual(r["meta"]["val"], self.ref["meta"]["val"])
        self.assertEqual(self.resume_dirs(out), [])  # --resume alone does not start writing them

    # ---- guards -----------------------------------------------------------------------------------

    def test_a_fresh_run_does_not_overwrite_old_resume_checkpoints(self):
        out = self.out()
        self.run_once(out, "--save-every", "3")
        self.assertEqual(self.resume_dirs(out), ["resume-step-000003"])
        with self.assertRaises(SystemExit) as cm:
            self.run_once(out, "--save-every", "3")  # forgot --resume
        self.assertIn("pass --resume", str(cm.exception))

    def test_resume_refuses_a_checkpoint_of_a_different_setup(self):
        out = self.out()
        self.run_once(out, "--save-every", "3")
        (Path(out) / "DONE").unlink()
        with self.assertRaises(SystemExit) as cm:
            self.run_once(out, "--resume", "--lr", "2e-3")
        self.assertIn("lr", str(cm.exception))

    def test_resume_after_done_is_a_no_op(self):
        out = self.out()
        self.run_once(out, "--save-every", "3")
        r = self.run_once(out, "--resume", "--save-every", "3")
        self.assertIn("already finished", r["log"])

    def test_epoch_order(self):
        order = self.train.epoch_order
        self.assertEqual(order(20, 3, 0), order(20, 3, 0))
        self.assertNotEqual(order(20, 3, 0), order(20, 3, 1))
        import random
        x = list(range(20))
        random.Random(3).shuffle(x)
        self.assertEqual(order(20, 3, 0), x)  # epoch 0 is the old single-epoch order

    def test_resume_inside_the_second_epoch(self):
        ref = self.run_once(self.out(), "--epochs", "2")
        self.assertEqual(sorted(ref["steps"]), [2, 4, 6, 8, 10, 12])
        out = self.out()
        first = self.run_once(out, "--epochs", "2", "--resume", "--save-every", "100",
                              hook=lambda n: os.kill(os.getpid(), signal.SIGTERM) if n == 8 * BS else None)
        self.assertIn("PREEMPTED at step 8/12", first["log"])
        second = self.run_once(out, "--epochs", "2", "--resume", "--save-every", "100")
        self.assertIn("step 8/12 (epoch 1, example 4 of 12)", second["log"])
        self.same_params(ref["model"], second["model"])
        self.assertEqual({**first["steps"], **second["steps"]}, ref["steps"])
        self.assertEqual(second["meta"]["val"], ref["meta"]["val"])

if __name__ == "__main__":
    unittest.main()
