"""Tests for train.py's precision flags (--tf32, --autocast, --fused-adam, --grad-ckpt) on the tiny CPU model.

    HF_HUB_OFFLINE=1 python -m unittest train/test_precision.py

On CPU the defaults resolve to: --autocast auto = none (exact fp32), fused AdamW off, grad ckpt off, and TF32 a no-op where oneDNN has no
TF32 path (not on an AMX CPU with a recent torch: there `--tf32` moves the fp32 matmul off IEEE, see `tf32_is_a_cpu_noop`). So on CPU the
DEFAULT-precision run must equal the LEGACY-precision run (--no-tf32 --autocast none --no-fused-adam) bit for bit, TF32 aside, which is
bit-identical on a CPU where it is a no-op and a close run elsewhere.
That holds under the LEGACY loss flags (--decision-weight 1 --copy-weight 1 --no-pair-batches: the loss and the order before decision
weight 2, copy weight 0 and pair batching became the defaults), which is what ties the trainer to the one before; a run with the new loss
defaults differs from the legacy-loss run.
--autocast bf16 (allowed on CPU) is checked against the legacy losses within TOL, and for resume-exactness, the
resume guard and the fallback.
The GPU-only parts (fla / Triton kernels under autocast, real speed) are what train/vm/bench_train.sh checks.
"""
from __future__ import annotations

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
LEGACY_LOSS = ["--decision-weight", "1", "--copy-weight", "1", "--no-pair-batches"]  # train.LEGACY_LOSS: the loss and the order of before
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

    @classmethod
    def legacy_loss(cls):
        """The legacy precision AND the legacy loss and order: the trainer before the loss defaults."""
        if not hasattr(cls, "_legacy_loss"):
            cls._legacy_loss = cls.run_once(os.path.join(cls.tmp, "legacy-loss"), *LEGACY, *LEGACY_LOSS)
        return cls._legacy_loss

    def close(self, got, want, tol=TOL):
        self.assertEqual(sorted(got), sorted(want))
        for k in got:
            g, w = float(got[k]), float(want[k])
            self.assertLessEqual(abs(g - w), tol * abs(w), (k, g, w))

    # ---- defaults == legacy on CPU, bit for bit -------------------------------------------------

    def tf32_is_a_cpu_noop(self):
        """Is `--tf32` (float32 matmul precision `high`) a no-op for the math on this CPU? It is where oneDNN has no TF32 path; on a CPU
        with AMX and a recent torch, `high` moves oneDNN's fp32 matmul off IEEE (`torch.backends.mkldnn.matmul.fp32_precision`), so the
        run is no longer the `highest` one bit for bit."""
        torch = self.torch
        mm = getattr(getattr(torch.backends, "mkldnn", None), "matmul", None)
        if mm is None or not hasattr(mm, "fp32_precision"):
            return True  # an older torch: `high` is for CUDA matmuls only
        torch.set_float32_matmul_precision("high")
        try:
            return mm.fp32_precision in ("none", "ieee")
        finally:
            torch.set_float32_matmul_precision("highest")

    def test_default_equals_legacy_bit_identical_on_cpu(self):
        # under the legacy loss flags the precision defaults are the legacy run, bit for bit: the loss path at weights 1 is the plain
        # mean CE of before, autocast auto resolves to none on CPU and fused AdamW is off there
        leg = self.legacy_loss()
        dflt = self.run_once(self.out(), "--no-tf32", *LEGACY_LOSS)  # every precision default but TF32, which the next lines treat apart
        self.same_params(dflt["model"], leg["model"])
        self.assertEqual(dflt["steps"], leg["steps"])
        self.assertEqual(dflt["meta"]["val"], leg["meta"]["val"])
        self.assertEqual(dflt["meta"]["train"], leg["meta"]["train"])
        self.assertIn("autocast none", dflt["log"])  # auto resolved to none on CPU
        for run in (dflt, leg):
            a = run["meta"]["args"]
            self.assertEqual((a["decision_weight"], a["copy_weight"], a["pair_batches"]), (1.0, 1.0, False))
        # TF32 on: a no-op on a CPU whose oneDNN has no TF32 path (bit-identical too); else a close run, as the bf16 autocast is
        full = self.run_once(self.out(), *LEGACY_LOSS)
        self.assertIn("tf32 True", full["log"])
        if self.tf32_is_a_cpu_noop():
            self.same_params(full["model"], leg["model"])
            self.assertEqual(full["steps"], leg["steps"])
        else:
            self.close(full["steps"], leg["steps"])

    def test_the_new_loss_defaults_differ_from_the_legacy_loss(self):
        leg = self.legacy_loss()
        a, la = self.ref["meta"]["args"], leg["meta"]["args"]
        self.assertEqual((a["decision_weight"], a["copy_weight"], a["pair_batches"]), (2.0, 0.0, True))  # what a run without flags is
        self.assertEqual((la["decision_weight"], la["copy_weight"], la["pair_batches"]), (1.0, 1.0, False))
        sa, sb = self.ref["model"].state_dict(), leg["model"].state_dict()
        self.assertEqual(sa.keys(), sb.keys())
        self.assertTrue(any(not self.torch.equal(sa[k], sb[k]) for k in sa))  # decision weight 2: another gradient, another model
        self.assertNotEqual(self.ref["meta"]["val"], leg["meta"]["val"])

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

    def test_a_checkpoint_from_before_the_loss_flags_resumes_only_under_them(self):
        out = self.out()
        flags = [*LEGACY, *LEGACY_LOSS]
        self.run_once(out, *flags, "--resume", "--save-every", "3",
                      hook=lambda n: os.kill(os.getpid(), signal.SIGTERM) if n == 3 * tr.BS else None)
        (ck,) = [p for p in Path(out).glob("resume-step-*")]
        st = self.torch.load(ck / "state.pt", map_location="cpu", weights_only=True)
        for k in ("tf32", "autocast", "copy_weight", "pair_batches"):  # made before the precision and the loss flags existed
            st["fingerprint"]["args"].pop(k, None)
        st["fingerprint"].pop("copy", None)
        st["meta_hist"].pop("marks", None)  # ... and before the marks (marks.json, best.json)
        self.torch.save(st, ck / "state.pt")
        meta = json.loads((ck / "COMPLETE").read_text())
        meta["state_bytes"] = (ck / "state.pt").stat().st_size
        (ck / "COMPLETE").write_text(json.dumps(meta))
        with self.assertRaises(SystemExit) as cm:
            self.run_once(out, "--resume", "--save-every", "3")  # the new loss defaults: refused, and the message names the flags
        self.assertIn("--decision-weight 1 --copy-weight 1 --no-pair-batches", str(cm.exception))
        r = self.run_once(out, *flags, "--resume", "--save-every", "3")
        self.assertIn("RESUMED", r["log"])
        self.same_params(self.legacy_loss()["model"], r["model"])
        self.assertTrue((Path(out) / "DONE").exists())

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
