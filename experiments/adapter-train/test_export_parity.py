import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from adapter_train import export, parity


class ExportTest(unittest.TestCase):
    def test_the_converter_is_the_trees_and_the_pin_is_the_native_trainers(self):
        cmd = export.command("/tree", "/ad", "/base", "/out.gguf")
        self.assertEqual(cmd[1], "/tree/convert_lora_to_gguf.py")
        self.assertEqual(cmd[2:4], ["--base", "/base"])
        self.assertIn("f16", cmd)
        tg = export.pin()
        self.assertEqual(tg.LLAMA_CPP_COMMIT, "26394b4e6749a41c3633db040e0987500a5f7013")  # the commit llama-cpp-sys-2 0.1.158 vendors
        self.assertEqual(tg.ENGINE, "llama-cpp-sys-2 0.1.158")

    def test_a_directory_that_is_not_an_adapter_is_refused_and_a_failed_converter_says_why(self):
        tmp = Path(tempfile.mkdtemp(prefix="export-test-"))
        self.addCleanup(shutil.rmtree, tmp, ignore_errors=True)
        tg = export.pin()
        real_ensure, real_check = tg.ensure_tree, tg.check_tree
        tg.ensure_tree = tg.check_tree = lambda *a, **k: None  # the tree itself is checked by test_to_gguf
        self.addCleanup(lambda: (setattr(tg, "ensure_tree", real_ensure), setattr(tg, "check_tree", real_check)))
        with self.assertRaisesRegex(SystemExit, "not a PEFT adapter"):
            export.export(tmp, tmp, tmp / "o.gguf", tmp / "tree")
        (tmp / "adapter_config.json").write_text("{}")
        (tmp / "adapter_model.safetensors").write_bytes(b"")
        boom = lambda cmd, **k: SimpleNamespace(returncode=1, stdout="", stderr="Embeddings is present in the adapter")
        with self.assertRaisesRegex(SystemExit, "Embeddings is present"):
            export.export(tmp, tmp, tmp / "o.gguf", tmp / "tree", run=boom)


class ParityTest(unittest.TestCase):
    def rows(self, *gens):
        return [{"id": "p%d" % i, "generated_ids": g} for i, g in enumerate(gens)]

    def test_agree_counts_the_leading_tokens(self):
        self.assertEqual(parity.agree([1, 2, 3], [1, 2, 9]), 2)
        self.assertEqual(parity.agree([], [1]), 0)

    def test_a_run_that_agrees_for_the_prefix_passes_even_if_it_later_diverges(self):
        a = self.rows(list(range(40)), list(range(40)))
        b = self.rows(list(range(20)) + [999] * 20, list(range(40)))
        r = parity.compare(a, b, prefix=16, min_match=1.0)
        self.assertTrue(r["passed"])
        self.assertEqual(r["exact"], 1)

    def test_a_diverging_prompt_lowers_the_share_and_the_floor_fails_it(self):
        a = self.rows(list(range(40)), list(range(40)))
        b = self.rows(list(range(40)), [7] + list(range(1, 40)))
        r = parity.compare(a, b, prefix=16, min_match=0.9)
        self.assertEqual(r["prefix_match_share"], 0.5)
        self.assertFalse(r["passed"])

    def test_a_prompt_one_side_lacks_is_a_failure_not_a_skip(self):
        a = self.rows([1, 2], [3, 4])
        b = self.rows([1, 2])
        r = parity.compare(a, b, prefix=2, min_match=0.1)
        self.assertEqual(r["missing_in_engine"], ["p1"])
        self.assertFalse(r["passed"])
        r2 = parity.compare(b, a, prefix=2, min_match=0.1)
        self.assertEqual(r2["extra_in_engine"], ["p1"])
        self.assertFalse(parity.compare([], [], prefix=2)["passed"])

    def test_an_empty_generation_never_counts_as_agreement(self):
        r = parity.compare(self.rows([]), self.rows([]), prefix=4, min_match=0.1)
        self.assertFalse(r["passed"])


if __name__ == "__main__":
    unittest.main()
