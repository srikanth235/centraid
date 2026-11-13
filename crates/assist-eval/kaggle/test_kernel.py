"""The kernel's checks that need no GPU, no network and no weights: `python3 -I -m unittest test_kernel` here."""
import hashlib
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import kernel  # noqa: E402  (importing it runs nothing: main() is behind __main__)


class ManifestPin(unittest.TestCase):
    manifest = {"files": {"data/val.jsonl.zst": {"sessions": 3, "bytes": 10, "blake3": "ab12"}}}

    def test_the_pinned_hash_passes(self):
        self.assertIsNone(kernel.check_manifest_pin(self.manifest, "ab12"))

    def test_another_hash_is_named(self):
        self.assertIn("ab12", kernel.check_manifest_pin(self.manifest, "ff00"))

    def test_a_manifest_without_val_is_refused(self):
        self.assertIn("no data/val.jsonl.zst", kernel.check_manifest_pin({"files": {}}, "ab12"))


class PinnedFiles(unittest.TestCase):
    def test_a_file_that_is_not_the_pinned_one_stops_the_kernel(self):
        with tempfile.TemporaryDirectory() as tmp:
            inp = os.path.join(tmp, "in")
            os.mkdir(inp)
            open(os.path.join(inp, "adapter.gguf"), "wb").write(b"weights")
            dest = os.path.join(tmp, "adapter.gguf")
            good = hashlib.sha256(b"weights").hexdigest()
            kernel.fetch_checked({"input": "adapter.gguf", "sha256": good}, dest, inp)
            with self.assertRaises(SystemExit) as stop:
                kernel.fetch_checked({"input": "adapter.gguf", "sha256": "0" * 64}, dest, inp)
            self.assertIn("not the file the kit pins", str(stop.exception))


if __name__ == "__main__":
    unittest.main()
