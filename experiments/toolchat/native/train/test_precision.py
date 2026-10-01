"""Tests for train.py's precision flags (--tf32, --autocast, --fused-adam, --grad-ckpt) on the tiny CPU model.

    HF_HUB_OFFLINE=1 python -m unittest train/test_precision.py

On CPU the defaults resolve to: TF32 a no-op, --autocast auto = none (exact fp32), fused AdamW off, grad ckpt off.
So on CPU the DEFAULT run must equal the LEGACY run (--no-tf32 --autocast none --no-fused-adam) bit for bit, and
the legacy run must equal the pre-flag trainer (_train_old.py). --autocast bf16 (allowed on CPU) is checked
against the legacy losses within TOL, and for resume-exactness, the resume guard and the fallback.
The GPU-only parts (fla / Triton kernels under autocast, real speed) are what train/vm/bench_train.sh checks.
"""
from __future__ import annotations

import importlib.util
import json
import os
import signal
import sys
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import test_resume as tr  # noqa: E402

SMOKE = 2  # forward_loss calls of the autocast smoke check (one under autocast, one fp32 reference) before step 1
LEGACY = ["--no-tf32", "--autocast", "none", "--no-fused-adam", "--no-grad-ckpt"]
TOL = 0.05  # bf16 autocast: every logged step loss within 5% (relative) of the fp32 one on the tiny model


def _as(f):
    return f.__func__ if isinstance(f, (classmethod, staticmethod)) else f


class PrecisionTest(unittest.TestCase):
    # borrow the tiny-model harness of test_resume without re-collecting its tests
    setUpClass = classmethod(_as(tr.ResumeTest.__dict__["setUpClass"]))
    tearDownClass = classmethod(_as(tr.ResumeTest.__dict__["tearDownClass"]))
    run_once = classmethod(_as(tr.ResumeTest.__dict__["run_once"]))
    losses = staticmethod(_as(tr.ResumeTest.__dict__["losses"]))
    out = tr.ResumeTest.out
    same_params = tr.ResumeTest.same_params
    resume_dirs = tr.ResumeTest.resume_dirs

    @classmethod
    def legacy(cls):
        if not hasattr(cls, "_legacy"):
            cls._legacy = cls.run_once(os.path.join(cls.tmp, "legacy"), *LEGACY)
        return cls._legacy

    def close(self, got, want, tol=TOL):
        self.assertEqual(sorted(got), sorted(want))
        for k in got:
            g, w = float(got[k]), float(want[k])
            self.assertLessEqual(abs(g - w), tol * abs(w), (k, g, w))

    # ---- defaults == legacy on CPU, bit for bit -------------------------------------------------

    def test_default_equals_legacy_bit_identical_on_cpu(self):
        leg = self.legacy()
        self.same_params(self.ref["model"], leg["model"])
        self.assertEqual(self.ref["steps"], leg["steps"])
        self.assertEqual(self.ref["meta"]["val"], leg["meta"]["val"])
        self.assertIn("autocast none", self.ref["log"])  # auto resolved to none on CPU

    def test_legacy_equals_the_pre_flag_trainer(self):
        old = os.path.join(HERE, "_train_old.py")
        spec = importlib.util.spec_from_file_location("train_old", old)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        out, models = os.path.join(self.tmp, "old"), []
        real = self.AutoModel.from_pretrained
        argv = ["train_old.py", "--model", self.model_dir, "--train", self.data, "--val", self.data, "--out", out] \
            + [x for x in tr.BASE]
        import contextlib
        import io
        buf = io.StringIO()
        with mock.patch.object(sys, "argv", argv), contextlib.redirect_stdout(buf), \
                mock.patch.object(self.AutoModel, "from_pretrained",
                                  lambda *a, **k: models.append(real(*a, **k)) or models[-1]):
            mod.main()
        self.same_params(models[0], self.legacy()["model"])
        self.assertEqual(self.losses(buf.getvalue()), self.legacy()["steps"])

    def test_grad_ckpt_is_the_same_math(self):
        r = self.run_once(self.out(), *[f for f in LEGACY if f != "--no-grad-ckpt"], "--grad-ckpt")
        self.same_params(self.legacy()["model"], r["model"])
        self.assertEqual(r["steps"], self.legacy()["steps"])

    # ---- each flag runs and stays close ------------------------------------------------------------

    def test_autocast_bf16_close_to_fp32(self):
        r = self.run_once(self.out(), "--autocast", "bf16")
        self.assertIn("autocast bf16", r["log"])
        self.assertIn("AUTOCAST check", r["log"])
        self.close(r["steps"], self.legacy()["steps"])
        for p in r["model"].parameters():
            self.assertEqual(p.dtype, self.torch.float32)  # fp32 master weights
            self.assertTrue(bool(self.torch.isfinite(p).all()))
        self.assertEqual(r["meta"]["args"]["autocast"], "bf16")

    def test_all_speed_flags_together(self):
        r = self.run_once(self.out(), "--tf32", "--autocast", "bf16", "--fused-adam", "--no-grad-ckpt")
        self.close(r["steps"], self.legacy()["steps"])

    def test_tf32_flag_toggles_matmul_precision(self):
        self.run_once(self.out(), "--no-tf32")
        self.assertEqual(self.torch.get_float32_matmul_precision(), "highest")
        self.run_once(self.out(), "--tf32")
        self.assertEqual(self.torch.get_float32_matmul_precision(), "high")
        self.torch.set_float32_matmul_precision("highest")

    def test_saved_checkpoint_is_bf16_and_ties_like_before(self):
        r = self.run_once(self.out(), "--autocast", "bf16")
        from safetensors import safe_open
        f = safe_open(str(r["out"] / "ckpt-100" / "model.safetensors"), "pt")
        self.assertTrue(all(f.get_tensor(k).dtype == self.torch.bfloat16 for k in f.keys()))
        leg = safe_open(str(self.legacy()["out"] / "ckpt-100" / "model.safetensors"), "pt")
        self.assertEqual(sorted(f.keys()), sorted(leg.keys()))

    def test_label_logits_stay_fp32_under_autocast(self):
        train = self.train
        ids, labels, dec = train.load(train.AutoTokenizer.from_pretrained(self.model_dir) if hasattr(train, "AutoTokenizer")
                                      else __import__("transformers").AutoTokenizer.from_pretrained(self.model_dir),
                                      self.data, 1024, 1, None, 1, "t", train.fmt.DecisionConfig.parse(None, None, None, None))[0]
        model = self.AutoModel.from_pretrained(self.model_dir, dtype=self.torch.float32).eval()
        dev = self.torch.device("cpu")
        with self.torch.no_grad():
            want = train.label_logits(model, ids, labels, dev)[0]
            train.AMP["dtype"] = self.torch.bfloat16
            try:
                got = train.label_logits(model, ids, labels, dev)[0]
            finally:
                train.AMP["dtype"] = None
        self.assertEqual(got.dtype, self.torch.float32)
        self.assertEqual(got.shape, want.shape)
        self.assertLess(float((got - want).abs().mean()), 0.5 * float(want.abs().mean()))  # random wide-init net: bf16 is chaotic, the check is dtype + sanity

    # ---- resume ------------------------------------------------------------------------------------

    def test_resume_is_bit_exact_under_autocast_bf16(self):
        flags = ["--autocast", "bf16"]
        ref = self.run_once(self.out(), *flags)
        out = self.out()
        first = self.run_once(out, *flags, "--resume", "--save-every", "100",
                              hook=lambda n: os.kill(os.getpid(), signal.SIGTERM) if n == 3 * tr.BS + SMOKE else None)
        self.assertIn("PREEMPTED at step 3/6", first["log"])
        second = self.run_once(out, *flags, "--resume", "--save-every", "100")
        self.assertIn("RESUMED", second["log"])
        self.same_params(ref["model"], second["model"])
        self.assertEqual({**first["steps"], **second["steps"]}, ref["steps"])

    def test_resume_refuses_a_precision_change(self):
        out = self.out()
        self.run_once(out, "--autocast", "bf16", "--resume", "--save-every", "3",
                      hook=lambda n: os.kill(os.getpid(), signal.SIGTERM) if n == 3 * tr.BS + SMOKE else None)
        for flags in (["--autocast", "none"], ["--autocast", "bf16", "--no-tf32"]):
            with self.assertRaises(SystemExit) as cm:
                self.run_once(out, *flags, "--resume", "--save-every", "3")
            self.assertIn("different run", str(cm.exception))

    def test_a_checkpoint_from_before_the_flags_resumes_only_as_legacy(self):
        out = self.out()
        self.run_once(out, *LEGACY, "--resume", "--save-every", "3",
                      hook=lambda n: os.kill(os.getpid(), signal.SIGTERM) if n == 3 * tr.BS else None)
        (ck,) = [p for p in Path(out).glob("resume-step-*")]
        st = self.torch.load(ck / "state.pt", map_location="cpu", weights_only=True)
        for k in ("tf32", "autocast"):
            st["fingerprint"]["args"].pop(k, None)
        self.torch.save(st, ck / "state.pt")
        meta = json.loads((ck / "COMPLETE").read_text())
        meta["state_bytes"] = (ck / "state.pt").stat().st_size
        (ck / "COMPLETE").write_text(json.dumps(meta))
        with self.assertRaises(SystemExit) as cm:
            self.run_once(out, "--autocast", "bf16", "--resume", "--save-every", "3")  # new defaults: refused
        self.assertIn("--no-tf32 --autocast none", str(cm.exception))
        r = self.run_once(out, *LEGACY, "--resume", "--save-every", "3")
        self.assertIn("RESUMED", r["log"])
        self.same_params(self.legacy()["model"], r["model"])

    # ---- the safety nets ---------------------------------------------------------------------------

    def test_autocast_smoke_falls_back_by_default_and_raises_when_explicit(self):
        train, torch = self.train, self.torch
        data = [([1, 2, 3], [-100, 5, 6], [0, 0, 0])]
        def boom(*a, **k):
            raise RuntimeError("expected Half but found Float")
        train.AMP["dtype"] = torch.bfloat16
        try:
            with mock.patch.object(train, "forward_loss", boom):
                m = torch.nn.Linear(1, 1)
                self.assertFalse(train.amp_smoke(m, data, torch.device("cpu"), 1.0, explicit=False))
                self.assertIsNone(train.AMP["dtype"])
                train.AMP["dtype"] = torch.bfloat16
                with self.assertRaises(RuntimeError):
                    train.amp_smoke(m, data, torch.device("cpu"), 1.0, explicit=True)
        finally:
            train.AMP["dtype"] = None

    def test_resolve_autocast(self):
        train = self.train
        self.assertEqual(train.resolve_autocast("bf16"), "bf16")
        self.assertEqual(train.resolve_autocast("none"), "none")
        with mock.patch.object(self.torch.cuda, "is_available", lambda: False):
            self.assertEqual(train.resolve_autocast("auto"), "none")
        with mock.patch.object(self.torch.cuda, "is_available", lambda: True), \
                mock.patch.object(self.torch.cuda, "is_bf16_supported", lambda *a, **k: True):
            self.assertEqual(train.resolve_autocast("auto"), "bf16")


if __name__ == "__main__":
    unittest.main()
