"""The llama.cpp pin: the commit and its engine, the refusal of any other checkout, and the clone. A throwaway git repository stands in for llama.cpp."""
import contextlib
import io
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from adapter_train import llama_pin

HERE = Path(__file__).resolve().parent
GIT_ENV = {"GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t", "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@t",
           "GIT_AUTHOR_DATE": "2026-01-01T00:00:00Z", "GIT_COMMITTER_DATE": "2026-01-01T00:00:00Z"}


def git(tree: Path, *args: str) -> str:
    done = subprocess.run(["git", "-C", str(tree), *args], capture_output=True, text=True, check=True, env={**os.environ, **GIT_ENV})
    return done.stdout.strip()


class PinTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="llama-pin-"))
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.tree = self.tmp / "llama.cpp"
        self.tree.mkdir()
        git(self.tree, "init", "--quiet")
        (self.tree / "convert_hf_to_gguf.py").write_text("print('convert')\n")
        git(self.tree, "add", ".")
        git(self.tree, "commit", "--quiet", "-m", "pinned")
        self.commit = git(self.tree, "rev-parse", "HEAD")

    def test_the_pinned_commit_and_the_engine_it_belongs_to(self):
        self.assertRegex(llama_pin.LLAMA_CPP_COMMIT, r"^[0-9a-f]{40}$")
        self.assertEqual(llama_pin.ENGINE, "llama-cpp-sys-2 0.1.158")
        manifest = (HERE.parents[1] / "crates" / "assist-llama" / "Cargo.toml").read_text()
        self.assertIn('llama-cpp-2 = { version = "=0.1.158"', manifest,
                      "the crate the engine is pinned to moved: redo the blob match and change LLAMA_CPP_COMMIT")

    def test_the_pinned_tree_passes(self):
        llama_pin.check_tree(self.tree, self.commit)

    def test_a_tree_at_another_commit_is_refused_with_the_remedy(self):
        (self.tree / "other.txt").write_text("x")
        git(self.tree, "add", ".")
        git(self.tree, "commit", "--quiet", "-m", "later")
        with self.assertRaises(llama_pin.Refusal) as why:
            llama_pin.check_tree(self.tree, self.commit)
        self.assertIn(f"checkout --detach {self.commit}", str(why.exception))

    def test_local_changes_to_the_converter_are_refused(self):
        (self.tree / "convert_hf_to_gguf.py").write_text("print('patched')\n")
        with self.assertRaises(llama_pin.Refusal) as why:
            llama_pin.check_tree(self.tree, self.commit)
        self.assertIn("local changes", str(why.exception))

    def test_a_directory_that_is_not_a_checkout_is_refused(self):
        with self.assertRaises(llama_pin.Refusal):
            llama_pin.check_tree(self.tmp, self.commit)

    def test_a_missing_tree_is_cloned_at_the_commit(self):
        (self.tree / "later.txt").write_text("x")
        git(self.tree, "add", ".")
        git(self.tree, "commit", "--quiet", "-m", "two")
        clone = self.tmp / "cache" / "llama.cpp"
        with contextlib.redirect_stdout(io.StringIO()):
            llama_pin.ensure_tree(clone, self.commit, repo=str(self.tree))
        self.assertEqual(git(clone, "rev-parse", "HEAD"), self.commit)
        self.assertFalse((clone / "later.txt").exists())
        llama_pin.ensure_tree(clone, self.commit, repo=str(self.tree))  # a second call changes nothing


if __name__ == "__main__":
    unittest.main()
