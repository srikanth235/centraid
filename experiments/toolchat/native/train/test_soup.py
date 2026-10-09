"""Tests for soup.py: the uniform weight average of checkpoints.

    python -m unittest train/test_soup.py
"""
from __future__ import annotations

import shutil
import sys
import tempfile
import unittest
from pathlib import Path

import torch
from safetensors.torch import load_file, save_file

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import soup  # noqa: E402


class SoupTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="soup-test-"))
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)

    def ckpt(self, name, w, config="{}"):
        d = self.tmp / name
        d.mkdir()
        save_file({"w": w, "b": torch.ones(2, dtype=torch.bfloat16)}, str(d / "model.safetensors"))
        (d / "config.json").write_text(config)
        return str(d)

    def test_uniform_and_repeated_inputs(self):
        a = self.ckpt("a", torch.tensor([0.0, 4.0]))
        b = self.ckpt("b", torch.tensor([2.0, 0.0]), config='{"last": 1}')
        soup.soup([a, b], str(self.tmp / "ab"))
        t = load_file(str(self.tmp / "ab" / "model.safetensors"))
        self.assertTrue(torch.equal(t["w"], torch.tensor([1.0, 2.0])))
        self.assertEqual(t["b"].dtype, torch.bfloat16)  # cast back to each tensor's dtype
        self.assertEqual((self.tmp / "ab" / "config.json").read_text(), '{"last": 1}')  # other files from the last input
        soup.soup([a, b, b, b], str(self.tmp / "abbb"))  # 25 % a, 75 % b
        t = load_file(str(self.tmp / "abbb" / "model.safetensors"))
        self.assertTrue(torch.equal(t["w"], torch.tensor([1.5, 1.0])))

    def test_different_models_are_refused(self):
        a = self.ckpt("a", torch.zeros(2))
        b = self.ckpt("b", torch.zeros(3))
        with self.assertRaises(SystemExit):
            soup.soup([a, b], str(self.tmp / "x"))


if __name__ == "__main__":
    unittest.main()
