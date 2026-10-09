#!/usr/bin/env python3
"""A trained checkpoint to the GGUF the phone loads: HF safetensors -> F16 GGUF -> Q4_0 GGUF, and a sidecar saying how (#1088).

    python3 train/to_gguf.py CKPT_DIR --out DIR [--name NAME] [--quant Q4_0] [--keep-f16]
        [--source-repo OWNER/NAME --source-tag TAG --source-revision SHA] [--data-version data-vN]
        [--llama-cpp DIR] [--quantize BIN] [--jobs N]

Writes `DIR/NAME-Q4_0.gguf` and `DIR/NAME-Q4_0.gguf.json` (NAME defaults to the checkpoint directory's name).

WHICH LLAMA.CPP. The phone's engine is `llama-cpp-2 =0.1.158` (crates/assist-llama), which vendors llama.cpp as `llama-cpp-sys-2
0.1.158`. A GGUF is read by the code that wrote its architecture's tensors, so the converter and the quantizer here are the ones of the SAME
llama.cpp tree: `LLAMA_CPP_COMMIT`. The crate's source ships no converter (its tree has no `conversion/` package), so the commit was
found by hashing every one of the crate's 1865 files and looking for the commit of upstream's master that holds exactly those blobs: one
commit matches all 1865 (the next best matches 1864), `26394b4e6` of 2026-09-21 ("json: Fixed json enum handling (#28518)"). Upgrading the
crate means redoing that match and changing the constant; `check_tree` refuses any other checkout. The tree is `--llama-cpp DIR` or
`$LLAMA_CPP_DIR` or `~/.cache/centraid/llama.cpp`: missing, it is cloned (blobless) from `LLAMA_CPP_REPO` and checked out at the commit; and
`llama-quantize` is built from it (cmake, CPU only, `GGML_NATIVE=OFF` so the build does not depend on the machine's instruction set) when
`DIR/build/bin/llama-quantize` is absent. The converter's Python needs this interpreter to have torch, transformers, safetensors, numpy,
sentencepiece, pyyaml and requests; `gguf-py` is the one in the tree (the converter puts it on its own path).

WHAT IS CONVERTED. The trainer saves a text-only `Qwen3_5ForCausalLM` (bf16, `model.layers.*`, the tied head dropped: train/train.py `save`); the
converter registers that class beside the full `Qwen3_5ForConditionalGeneration` of the base model, so a checkpoint converts without its
vision tower. The vision projector is a separate file the phone loads on its own (`attach_vision`): the base model's, unsloth's `mmproj-F16.gguf`
(`artefacts.py publish-gguf` names it in the card), because fine-tuning leaves the projector alone.

REPRODUCIBLE. Same checkpoint, same tree, same quant: same bytes. `general.name` is set from NAME (the converter would take it from the directory
name) and nothing else the converter or the quantizer writes depends on the clock or the machine's threads (`test_to_gguf.py` runs the tool twice;
the sidecar holds the sha256 of the F16 file as well as of the quantized one, so a difference is found at the step it began in).

THE SIDECAR (`NAME-QUANT.gguf.json`) is what `artefacts.py publish-gguf` reads and what a run record is judged against: the checkpoint (path,
config and weight hashes, the `train_meta.json` hash and the base model and data version it records), the source repository, tag and revision
it was promoted as (flags: the checkpoint directory does not know them), llama.cpp (commit, converter hash, quantizer hash), the tool versions,
and the sha256 and size of every file.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import subprocess
import sys
from pathlib import Path

LLAMA_CPP_REPO = "https://github.com/ggml-org/llama.cpp"
# The llama.cpp tree `llama-cpp-sys-2 0.1.158` vendors (found by blob match, see the docstring).
LLAMA_CPP_COMMIT = "26394b4e6749a41c3633db040e0987500a5f7013"
ENGINE = "llama-cpp-sys-2 0.1.158"
DEFAULT_QUANT = "Q4_0"
# How the converter and the quantizer are called. `--no-mtp`: the base model carries a multi-token-prediction block the trainer drops
# (a checkpoint has no `mtp.*` weights, but its config still says `mtp_num_hidden_layers: 1`); without the flag this commit's converter
# writes a 25th block with no tensors and the engine refuses the file, and the phone does no speculative decoding. `q8_0` for the output
# tensor: the model ties its head to the embedding, and this commit's quantizer would then give that one 248320 x 1024 matrix Q6_K, where the
# file the phone has been running (ggml-org's Qwen3.5-0.8B-Q4_0.gguf) has Q8_0: the recipe is theirs, not the commit's default.
CONVERT_ARGS = ("--outtype", "f16", "--no-mtp")
QUANTIZE_ARGS = ("--output-tensor-type", "q8_0")
# The quantizations the phone's engine and this tool have been checked with; anything else is a new decision.
QUANTS = ("Q4_0", "Q8_0", "F16")
DEFAULT_TREE = Path(os.environ.get("LLAMA_CPP_DIR") or Path.home() / ".cache" / "centraid" / "llama.cpp")
SCHEMA = 1
CMAKE_FLAGS = ("-DCMAKE_BUILD_TYPE=Release", "-DGGML_NATIVE=OFF", "-DGGML_OPENMP=OFF", "-DLLAMA_CURL=OFF", "-DLLAMA_OPENSSL=OFF",
               "-DLLAMA_BUILD_TESTS=OFF", "-DLLAMA_BUILD_EXAMPLES=OFF", "-DLLAMA_BUILD_SERVER=OFF", "-DLLAMA_BUILD_TOOLS=ON")


class Refusal(Exception):
    """Something the caller can fix; main prints it and exits 1."""


def sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def file_entry(path: Path) -> dict:
    return {"file": path.name, "bytes": path.stat().st_size, "sha256": sha256_of(path)}


def git(tree: Path, *args: str) -> str:
    done = subprocess.run(["git", "-C", str(tree), *args], capture_output=True, text=True, check=False)
    if done.returncode:
        raise Refusal(f"git {' '.join(args)} in {tree} failed: {done.stderr.strip() or done.stdout.strip()}")
    return done.stdout.strip()


def check_tree(tree: Path, commit: str = LLAMA_CPP_COMMIT) -> None:
    """Refuse a llama.cpp checkout that is not exactly `commit` with its converter and quantizer sources unmodified."""
    if not (tree / ".git").exists():
        raise Refusal(f"{tree} is not a git checkout of llama.cpp")
    head = git(tree, "rev-parse", "HEAD")
    if head != commit:
        raise Refusal(f"{tree} is at {head}, not {commit} (the llama.cpp {ENGINE} vendors): "
                      f"`git -C {tree} checkout --detach {commit}`")
    dirty = git(tree, "status", "--porcelain", "--untracked-files=no", "--", "convert_hf_to_gguf.py", "conversion", "gguf-py", "src", "tools/quantize")
    if dirty:
        raise Refusal(f"{tree} has local changes to the converter or the quantizer:\n{dirty}")
    if not (tree / "convert_hf_to_gguf.py").is_file():
        raise Refusal(f"{tree} has no convert_hf_to_gguf.py")


def ensure_tree(tree: Path, commit: str = LLAMA_CPP_COMMIT, repo: str = LLAMA_CPP_REPO) -> None:
    """The checkout at `commit`: cloned (blobless: the blobs of one commit are fetched on checkout) when `tree` does not exist."""
    if not tree.exists():
        tree.parent.mkdir(parents=True, exist_ok=True)
        print(f"cloning {repo} to {tree} (blobless) at {commit[:9]}", flush=True)
        done = subprocess.run(["git", "clone", "--quiet", "--filter=blob:none", "--no-checkout", repo, str(tree)], capture_output=True,
                              text=True, check=False)
        if done.returncode:
            raise Refusal(f"git clone {repo} failed: {done.stderr.strip()}")
        git(tree, "checkout", "--quiet", "--detach", commit)
    check_tree(tree, commit)


def ensure_quantize(tree: Path, jobs: int) -> Path:
    """`llama-quantize` built from `tree` (CPU only), unless it is already there."""
    binary = tree / "build" / "bin" / "llama-quantize"
    if binary.is_file():
        return binary
    print(f"building llama-quantize in {tree / 'build'} (-j {jobs})", flush=True)
    for cmd in (["cmake", "-S", str(tree), "-B", str(tree / "build"), *CMAKE_FLAGS],
                ["cmake", "--build", str(tree / "build"), "--target", "llama-quantize", "-j", str(jobs)]):
        done = subprocess.run(cmd, capture_output=True, text=True, check=False)
        if done.returncode:
            raise Refusal(f"{' '.join(cmd[:2])} failed:\n{(done.stdout + done.stderr)[-2000:]}")
    if not binary.is_file():
        raise Refusal(f"the build left no {binary}")
    return binary


def tool_versions() -> dict:
    from importlib import metadata

    versions = {"python": platform.python_version(), "platform": platform.platform()}
    for package in ("torch", "transformers", "safetensors", "numpy", "sentencepiece", "gguf"):
        try:
            versions[package] = metadata.version(package)
        except metadata.PackageNotFoundError:
            pass
    return versions


def describe_source(ckpt: Path) -> dict:
    """What the checkpoint directory says about itself: file hashes, and the base model and data version `train_meta.json` records."""
    config = ckpt / "config.json"
    weights = sorted(ckpt.glob("*.safetensors"))
    if not config.is_file() or not weights:
        raise Refusal(f"{ckpt} is not a checkpoint: it needs config.json and *.safetensors")
    source = {"checkpoint": str(ckpt.resolve()), "config_sha256": sha256_of(config),
              "weights": [file_entry(path) for path in weights], "train_meta_sha256": None, "base_model": None, "data_version": None}
    meta = ckpt / "train_meta.json"
    if meta.is_file():
        args = json.loads(meta.read_text(encoding="utf-8")).get("args", {})
        source.update(train_meta_sha256=sha256_of(meta), base_model=args.get("model"), data_version=args.get("data_version"))
    return source


def run_step(cmd: list[str], what: str, env: dict | None = None) -> None:
    done = subprocess.run(cmd, capture_output=True, text=True, check=False, env=env)
    if done.returncode:
        raise Refusal(f"{what} failed (exit {done.returncode}):\n{(done.stdout + done.stderr)[-3000:]}")


def convert(ckpt: Path, out: Path, name: str, quant: str = DEFAULT_QUANT, tree: Path = DEFAULT_TREE, quantize: Path | None = None,
            keep_f16: bool = False, jobs: int = 2, commit: str = LLAMA_CPP_COMMIT, source_ref: dict | None = None) -> Path:
    """The checkpoint to `out/NAME-QUANT.gguf` and its sidecar; the path of the GGUF."""
    if quant not in QUANTS:
        raise Refusal(f"quantization {quant!r}: one of {', '.join(QUANTS)} (a new one is a decision, not a flag)")
    source = describe_source(ckpt)
    source.update({k: v for k, v in (source_ref or {}).items() if v})
    check_tree(tree, commit)
    quantize = quantize or ensure_quantize(tree, jobs)
    out.mkdir(parents=True, exist_ok=True)
    f16 = out / f"{name}-F16.gguf"
    final = out / f"{name}-{quant}.gguf"
    converter = tree / "convert_hf_to_gguf.py"
    # NO_LOCAL_GGUF unset: the converter puts the tree's gguf-py on its own path, the version that wrote the commit's tensor names.
    env = {k: v for k, v in os.environ.items() if k != "NO_LOCAL_GGUF"}
    run_step([sys.executable, str(converter), str(ckpt), *CONVERT_ARGS, "--outfile", str(f16), "--model-name", name],
             "the llama.cpp converter", env)
    produced = {"f16": file_entry(f16)}
    if quant == "F16":
        f16.replace(final)
        produced = {}
    else:
        run_step([str(quantize), *QUANTIZE_ARGS, str(f16), str(final), quant], "llama-quantize")
    files = {"gguf": {**file_entry(final), "quant": quant}}
    if produced and keep_f16:
        files["f16"] = produced["f16"]
    elif produced:
        files["f16_intermediate"] = {k: v for k, v in produced["f16"].items() if k != "file"}
        f16.unlink()
    sidecar = {
        "schema": SCHEMA,
        "name": name,
        "files": files,
        "source": source,
        "llama_cpp": {"repo": LLAMA_CPP_REPO, "commit": commit, "engine": ENGINE,
                      "convert_args": list(CONVERT_ARGS), "quantize_args": list(QUANTIZE_ARGS),
                      "converter_sha256": sha256_of(converter), "quantize_sha256": sha256_of(quantize)},
        "tools": tool_versions(),
    }
    final.with_name(final.name + ".json").write_text(json.dumps(sidecar, indent=1, sort_keys=True) + "\n", encoding="utf-8")
    return final


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="A checkpoint to the Q4_0 GGUF the phone loads (llama.cpp at the commit the engine vendors).")
    ap.add_argument("checkpoint", type=Path, help="the checkpoint directory (config.json, *.safetensors, the tokenizer)")
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--name", help="the GGUF's name (default: the checkpoint directory's)")
    ap.add_argument("--quant", default=DEFAULT_QUANT, choices=QUANTS)
    ap.add_argument("--keep-f16", action="store_true", help="keep the F16 intermediate beside the result (1.5 GB)")
    ap.add_argument("--llama-cpp", type=Path, default=DEFAULT_TREE, metavar="DIR", help=f"the llama.cpp checkout at {LLAMA_CPP_COMMIT[:9]} (default $LLAMA_CPP_DIR, else {DEFAULT_TREE})")
    ap.add_argument("--quantize", type=Path, metavar="BIN", help="a llama-quantize built from that checkout (default: DIR/build/bin/llama-quantize, built when absent)")
    ap.add_argument("--jobs", type=int, default=2, help="cmake jobs when llama-quantize is built (default 2)")
    ap.add_argument("--source-repo", metavar="OWNER/NAME", help="the private Hub repository the checkpoint was promoted to")
    ap.add_argument("--source-tag", metavar="TAG", help="and its tag")
    ap.add_argument("--source-revision", metavar="SHA", help="and the commit the tag points at")
    ap.add_argument("--data-version", metavar="data-vN", help="the data version (default: the one train_meta.json records)")
    args = ap.parse_args(argv)
    name = args.name or args.checkpoint.resolve().name
    try:
        ensure_tree(args.llama_cpp)
        final = convert(args.checkpoint, args.out, name, args.quant, args.llama_cpp, args.quantize, args.keep_f16, args.jobs,
                        source_ref={"repo": args.source_repo, "tag": args.source_tag, "revision": args.source_revision,
                                    "data_version": args.data_version})
    except Refusal as why:
        print(f"FAIL {why}")
        return 1
    side = json.loads(final.with_name(final.name + ".json").read_text(encoding="utf-8"))["files"]["gguf"]
    print(f"{final}  {side['bytes']:,} bytes  sha256 {side['sha256']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
