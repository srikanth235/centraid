"""Tests for to_gguf.py: a checkpoint to a Q4_0 GGUF and its sidecar, with a stub converter and a stub quantizer (no llama.cpp, no torch).

    python -m unittest test_to_gguf          (from experiments/toolchat/native/train)

The llama.cpp tree is a throwaway git repository holding a `convert_hf_to_gguf.py` and a `build/bin/llama-quantize` that are a few lines of
Python each: the converter writes the bytes of the checkpoint under a header, the quantizer a digest of its input. What is tested is this tool's
side: the commit it insists on, the arguments it passes (`--no-mtp`, the Q8_0 output tensor), what the sidecar records, that two runs give the
same bytes and that nothing is left behind. That the real converter and quantizer produce the file the engine loads is
`crates/assist-llama/tests/real_model.rs`'s; the real tree's pinned commit is checked by the match recorded in the module docstring.
"""
from __future__ import annotations

import contextlib
import hashlib
import io
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import to_gguf  # noqa: E402

CONVERTER = """\
import sys
args = sys.argv[1:]
ckpt, rest = args[0], args[1:]
assert "--no-mtp" in rest, "the converter must be told --no-mtp"
out = rest[rest.index("--outfile") + 1]
name = rest[rest.index("--model-name") + 1]
weights = open(ckpt + "/model.safetensors", "rb").read()
open(out, "wb").write(b"F16|" + name.encode() + b"|" + weights)
"""

QUANTIZER = """\
#!{python}
import hashlib, sys
args = sys.argv[1:]
assert args[:2] == ["--output-tensor-type", "q8_0"], args
src, dst, quant = args[2:]
open(dst, "wb").write(quant.encode() + b"|" + hashlib.sha256(open(src, "rb").read()).digest())
"""

GIT_ENV = {"GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t", "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@t",
           "GIT_AUTHOR_DATE": "2026-01-01T00:00:00Z", "GIT_COMMITTER_DATE": "2026-01-01T00:00:00Z"}


def git(tree: Path, *args: str) -> str:
    done = subprocess.run(["git", "-C", str(tree), *args], capture_output=True, text=True, check=True, env={**os.environ, **GIT_ENV})
    return done.stdout.strip()


class Case(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="to-gguf-test-"))
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.tree = self.tmp / "llama.cpp"
        self.tree.mkdir()
        git(self.tree, "init", "--quiet")
        (self.tree / "convert_hf_to_gguf.py").write_text(CONVERTER)
        git(self.tree, "add", ".")
        git(self.tree, "commit", "--quiet", "-m", "pinned")
        self.commit = git(self.tree, "rev-parse", "HEAD")
        self.quantize = self.tmp / "llama-quantize"
        self.quantize.write_text(QUANTIZER.format(python=sys.executable))
        self.quantize.chmod(self.quantize.stat().st_mode | stat.S_IXUSR)
        self.ckpt = self.tmp / "ckpt" / "s2"
        self.ckpt.mkdir(parents=True)
        (self.ckpt / "config.json").write_text('{"architectures": ["Qwen3_5ForCausalLM"], "mtp_num_hidden_layers": 1}')
        (self.ckpt / "model.safetensors").write_bytes(b"weights" * 100)
        (self.ckpt / "train_meta.json").write_text(json.dumps({"args": {"model": "Qwen/Qwen3.5-0.8B", "data_version": "data-v7"}}))
        self.out = self.tmp / "out"

    def convert(self, out=None, **kw):
        return to_gguf.convert(self.ckpt, out or self.out, kw.pop("name", "s2"), tree=self.tree, quantize=self.quantize,
                               commit=self.commit, **kw)

    def sidecar(self, final: Path) -> dict:
        return json.loads(final.with_name(final.name + ".json").read_text())


class Convert(Case):
    def test_it_writes_the_gguf_and_a_sidecar_that_says_what_it_is(self):
        final = self.convert()
        self.assertEqual(final.name, "s2-Q4_0.gguf")
        side = self.sidecar(final)
        data = final.read_bytes()
        self.assertEqual(side["files"]["gguf"], {"file": "s2-Q4_0.gguf", "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest(), "quant": "Q4_0"})
        self.assertEqual(side["llama_cpp"]["commit"], self.commit)
        self.assertEqual(side["llama_cpp"]["engine"], "llama-cpp-sys-2 0.1.158")
        self.assertEqual(side["llama_cpp"]["convert_args"], ["--outtype", "f16", "--no-mtp"])
        self.assertEqual(side["llama_cpp"]["quantize_args"], ["--output-tensor-type", "q8_0"])
        self.assertEqual(side["llama_cpp"]["converter_sha256"], hashlib.sha256(CONVERTER.encode()).hexdigest())
        self.assertEqual(side["source"]["base_model"], "Qwen/Qwen3.5-0.8B")
        self.assertEqual(side["source"]["data_version"], "data-v7")
        self.assertEqual(side["source"]["checkpoint"], str(self.ckpt.resolve()))
        self.assertEqual(side["source"]["weights"][0]["sha256"], hashlib.sha256(b"weights" * 100).hexdigest())
        self.assertEqual(side["source"]["config_sha256"], hashlib.sha256((self.ckpt / "config.json").read_bytes()).hexdigest())
        self.assertEqual(side["name"], "s2")
        self.assertEqual(side["schema"], 1)

    def test_the_name_goes_into_the_file_not_the_directory_name(self):
        final = self.convert(name="native-s2")
        self.assertEqual(final.name, "native-s2-Q4_0.gguf")
        other = self.tmp / "elsewhere" / "different-dir-name"
        shutil.copytree(self.ckpt, other)
        self.ckpt = other
        again = self.convert(out=self.tmp / "out2", name="native-s2")
        self.assertEqual(final.read_bytes(), again.read_bytes())

    def test_two_runs_give_the_same_bytes_and_the_same_sidecar(self):
        first = self.convert()
        second = self.convert(out=self.tmp / "again")
        self.assertEqual(first.read_bytes(), second.read_bytes())
        self.assertEqual(self.sidecar(first), self.sidecar(second))

    def test_the_f16_is_removed_but_its_hash_is_kept_unless_asked_for(self):
        final = self.convert()
        self.assertEqual(sorted(p.name for p in self.out.iterdir()), ["s2-Q4_0.gguf", "s2-Q4_0.gguf.json"])
        f16 = self.sidecar(final)["files"]["f16_intermediate"]
        self.assertEqual(set(f16), {"bytes", "sha256"})
        kept = self.convert(out=self.tmp / "kept", keep_f16=True)
        self.assertTrue((kept.parent / "s2-F16.gguf").is_file())
        self.assertEqual(self.sidecar(kept)["files"]["f16"]["sha256"], f16["sha256"])

    def test_the_source_the_checkpoint_does_not_know_is_recorded_when_given(self):
        final = self.convert(source_ref={"repo": "owner/native", "tag": "S2", "revision": "a" * 40, "data_version": None})
        source = self.sidecar(final)["source"]
        self.assertEqual((source["repo"], source["tag"], source["revision"]), ("owner/native", "S2", "a" * 40))
        self.assertEqual(source["data_version"], "data-v7", "a flag that is not given does not erase what train_meta.json says")
        (self.ckpt / "train_meta.json").unlink()
        source = self.sidecar(self.convert(out=self.tmp / "b", source_ref={"data_version": "data-v8"}))["source"]
        self.assertEqual((source["data_version"], source["train_meta_sha256"]), ("data-v8", None))

    def test_f16_as_the_quant_is_the_converters_file(self):
        final = self.convert(quant="F16")
        self.assertEqual(final.name, "s2-F16.gguf")
        self.assertTrue(final.read_bytes().startswith(b"F16|s2|"))
        self.assertNotIn("f16_intermediate", self.sidecar(final)["files"])


class Refusals(Case):
    def test_a_tree_at_another_commit_is_refused_with_the_remedy(self):
        (self.tree / "other.txt").write_text("x")
        git(self.tree, "add", ".")
        git(self.tree, "commit", "--quiet", "-m", "later")
        with self.assertRaises(to_gguf.Refusal) as why:
            self.convert()
        self.assertIn(f"checkout --detach {self.commit}", str(why.exception))

    def test_local_changes_to_the_converter_are_refused(self):
        (self.tree / "convert_hf_to_gguf.py").write_text(CONVERTER + "# patched\n")
        with self.assertRaises(to_gguf.Refusal) as why:
            self.convert()
        self.assertIn("local changes", str(why.exception))

    def test_a_directory_that_is_not_a_checkout_is_refused(self):
        with self.assertRaises(to_gguf.Refusal):
            to_gguf.check_tree(self.tmp, self.commit)

    def test_a_directory_that_is_not_a_checkpoint_is_refused(self):
        (self.ckpt / "model.safetensors").unlink()
        with self.assertRaises(to_gguf.Refusal) as why:
            self.convert()
        self.assertIn("is not a checkpoint", str(why.exception))

    def test_a_quantization_nobody_checked_is_refused(self):
        with self.assertRaises(to_gguf.Refusal):
            self.convert(quant="Q2_K")

    def test_a_failing_converter_shows_its_tail_and_leaves_no_gguf(self):
        (self.ckpt / "model.safetensors").unlink()
        (self.ckpt / "model.safetensors").write_bytes(b"w")
        (self.tree / "convert_hf_to_gguf.py").write_text("import sys\nsys.exit('no such architecture')\n")
        git(self.tree, "commit", "--quiet", "-am", "broken")
        self.commit = git(self.tree, "rev-parse", "HEAD")
        with self.assertRaises(to_gguf.Refusal) as why:
            self.convert()
        self.assertIn("no such architecture", str(why.exception))
        self.assertEqual(list(self.out.glob("*.gguf")), [])

    def test_main_prints_fail_and_exits_1(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = to_gguf.main([str(self.tmp / "nope"), "--out", str(self.out), "--llama-cpp", str(self.tree), "--quantize", str(self.quantize)])
        self.assertEqual(code, 1)
        self.assertTrue(out.getvalue().startswith("FAIL "), out.getvalue())


class TheTree(unittest.TestCase):
    def test_the_pinned_commit_and_the_engine_it_belongs_to(self):
        self.assertRegex(to_gguf.LLAMA_CPP_COMMIT, r"^[0-9a-f]{40}$")
        self.assertEqual(to_gguf.ENGINE, "llama-cpp-sys-2 0.1.158")
        manifest = (HERE.parents[3] / "crates" / "assist-llama" / "Cargo.toml").read_text()
        self.assertIn('llama-cpp-2 = { version = "=0.1.158"', manifest, "the crate the engine is pinned to moved: redo the blob match and change LLAMA_CPP_COMMIT")

    def test_a_missing_tree_is_cloned_at_the_commit(self):
        tmp = Path(tempfile.mkdtemp(prefix="to-gguf-clone-"))
        self.addCleanup(shutil.rmtree, tmp, ignore_errors=True)
        upstream = tmp / "upstream"
        upstream.mkdir()
        git(upstream, "init", "--quiet")
        (upstream / "convert_hf_to_gguf.py").write_text("print('hi')\n")
        git(upstream, "add", ".")
        git(upstream, "commit", "--quiet", "-m", "one")
        commit = git(upstream, "rev-parse", "HEAD")
        (upstream / "later.txt").write_text("x")
        git(upstream, "add", ".")
        git(upstream, "commit", "--quiet", "-m", "two")
        clone = tmp / "cache" / "llama.cpp"
        with contextlib.redirect_stdout(io.StringIO()):
            to_gguf.ensure_tree(clone, commit, repo=str(upstream))
        self.assertEqual(git(clone, "rev-parse", "HEAD"), commit)
        self.assertFalse((clone / "later.txt").exists())
        to_gguf.ensure_tree(clone, commit, repo=str(upstream))  # a second call changes nothing

    def test_the_cmake_flags_do_not_depend_on_the_machine(self):
        self.assertIn("-DGGML_NATIVE=OFF", to_gguf.CMAKE_FLAGS)
        self.assertTrue(all(re.fullmatch(r"-D[A-Z_]+=\w+", flag) for flag in to_gguf.CMAKE_FLAGS))


if __name__ == "__main__":
    unittest.main()
