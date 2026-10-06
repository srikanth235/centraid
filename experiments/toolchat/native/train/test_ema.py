"""Tests for train.py --ema: the weight EMA is saved beside every mark and changes nothing of the training itself.

    python -m unittest train/test_ema.py

The runs reuse test_resume.py's tiny model, data and in-process driver (6 steps of 2 sequences, one mark at the end).
"""
from __future__ import annotations

import os
import signal
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import test_resume as tr  # noqa: E402  (a module, not its class: the loader would run ResumeTest here too)

BS = tr.BS


class EmaTest(unittest.TestCase):
    setUpClass = classmethod(tr.ResumeTest.setUpClass.__func__)
    tearDownClass = classmethod(tr.ResumeTest.tearDownClass.__func__)
    run_once = classmethod(tr.ResumeTest.run_once.__func__)
    losses = staticmethod(tr.ResumeTest.losses)
    out = tr.ResumeTest.out
    same_params = tr.ResumeTest.same_params

    def weights(self, d):
        from safetensors.torch import load_file
        return load_file(str(Path(d) / "model.safetensors"))

    def test_off_by_default(self):
        self.assertEqual(sorted(p.name for p in self.ref["out"].glob("ckpt-*")), ["ckpt-100"])
        self.assertNotIn("ema_val", self.ref["meta"])

    def test_ema_changes_nothing_of_the_training(self):
        r = self.run_once(self.out(), "--ema", "0.5")
        self.same_params(self.ref["model"], r["model"])
        self.assertEqual(r["steps"], self.ref["steps"])
        self.assertEqual(r["meta"]["val"], self.ref["meta"]["val"])
        raw, ref = self.weights(r["out"] / "ckpt-100"), self.weights(self.ref["out"] / "ckpt-100")
        for k in ref:
            self.assertTrue(self.torch.equal(raw[k], ref[k]), k)

    def test_the_ema_mark_is_saved_beside_the_mark_and_differs(self):
        r = self.run_once(self.out(), "--ema", "0.5")
        self.assertEqual(sorted(p.name for p in r["out"].glob("ckpt-*")), ["ckpt-100", "ckpt-100-ema"])
        ema_dir = r["out"] / "ckpt-100-ema"
        for f in ("config.json", "model.safetensors", "train_meta.json"):
            self.assertTrue((ema_dir / f).exists(), f)
        raw, ema = self.weights(r["out"] / "ckpt-100"), self.weights(ema_dir)
        self.assertEqual(raw.keys(), ema.keys())
        self.assertTrue(any(not self.torch.equal(raw[k], ema[k]) for k in raw))
        self.assertEqual([e["step"] for e in r["meta"]["ema_val"]], [6])
        self.assertIn("VAL-EMA step 6", r["log"])
        self.assertEqual((r["out"] / "FINAL").read_text().strip(), "ckpt-100")  # FINAL never names the EMA

    def test_resume_carries_the_shadow_bit_for_bit(self):
        ref = self.run_once(self.out(), "--ema", "0.5")
        out = self.out()
        first = self.run_once(out, "--ema", "0.5", "--resume", "--save-every", "100",
                              hook=lambda n: os.kill(os.getpid(), signal.SIGTERM) if n == 3 * BS else None)
        self.assertIn("PREEMPTED at step 3/6", first["log"])
        self.run_once(out, "--ema", "0.5", "--resume", "--save-every", "100")
        a, b = self.weights(ref["out"] / "ckpt-100-ema"), self.weights(Path(out) / "ckpt-100-ema")
        for k in a:
            self.assertTrue(self.torch.equal(a[k], b[k]), k)

    def test_resume_refuses_to_switch_the_ema_on(self):
        out = self.out()
        self.run_once(out, "--save-every", "3")
        (Path(out) / "DONE").unlink()
        with self.assertRaises(SystemExit) as cm:
            self.run_once(out, "--resume", "--ema", "0.5")
        self.assertIn("ema", str(cm.exception))

    def test_the_update_and_the_swap(self):
        torch, train = self.torch, self.train
        self.assertEqual(train.ema_decay(0.999, 1), 2 / 11)  # early: capped
        self.assertEqual(train.ema_decay(0.999, 10 ** 6), 0.999)
        p = torch.nn.Parameter(torch.zeros(3))
        e = train.Ema({"w": p}, 0.5)
        with torch.no_grad():
            p.fill_(1.0)
        e.update({"w": p}, 10 ** 6)  # decay 0.5: halfway
        self.assertTrue(torch.equal(e.shadow["w"], torch.full((3,), 0.5)))
        with e.swapped({"w": p}):
            self.assertTrue(torch.equal(p.data, torch.full((3,), 0.5)))
        self.assertTrue(torch.equal(p.data, torch.ones(3)))
        self.assertTrue(torch.equal(e.shadow["w"], torch.full((3,), 0.5)))


if __name__ == "__main__":
    unittest.main()
