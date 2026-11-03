"""HF checkpoint directory -> Q4_0 GGUF, the way the phone's engine reads it.

    python3 gguf.py --model DIR --out FILE.gguf [--quant Q4_0] [--llama-cpp DIR] [--keep-f16] [--jobs 2]

Steps: `convert_hf_to_gguf.py --outtype f16 --no-mtp`, then `llama-quantize --output-tensor-type q8_0 F16 OUT Q4_0`, both from one
llama.cpp tree pinned at the commit the phone's engine vendors (llama-cpp-sys-2 0.1.158). The tree is --llama-cpp, or $LLAMA_CPP_DIR, or
~/.cache/centraid/llama.cpp (cloned blobless and checked out at the pin when absent; `llama-quantize` is built with cmake, CPU only).
Facts copied from experiments/toolchat/native/train/to_gguf.py:
  * `--no-mtp`: the base model's config says mtp_num_hidden_layers: 1 but a checkpoint carries no `mtp.*` weights; without the flag the
    converter writes a 25th block with no tensors and the engine refuses the file.
  * `--output-tensor-type q8_0`: the head is tied to the embedding; the quantizer's default would give it Q6_K, the phone's reference file
    (ggml-org Qwen3.5-0.8B-Q4_0.gguf) has Q8_0.
The converter's Python needs torch, transformers, safetensors, numpy, sentencepiece, pyyaml, requests. Same checkpoint, same tree: same bytes.
Writes FILE.gguf and FILE.gguf.json (sha256 of input weights, F16 intermediate and result, commit, flags).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path

LLAMA_CPP_REPO = "https://github.com/ggml-org/llama.cpp"
LLAMA_CPP_COMMIT = "26394b4e6749a41c3633db040e0987500a5f7013"
CONVERT_ARGS = ("--outtype", "f16", "--no-mtp")
QUANTIZE_ARGS = ("--output-tensor-type", "q8_0")
QUANTS = ("Q4_0", "Q8_0", "F16")
DEFAULT_TREE = Path(os.environ.get("LLAMA_CPP_DIR") or Path.home() / ".cache" / "centraid" / "llama.cpp")
CMAKE_FLAGS = ("-DCMAKE_BUILD_TYPE=Release", "-DGGML_NATIVE=OFF", "-DGGML_OPENMP=OFF", "-DLLAMA_CURL=OFF", "-DLLAMA_OPENSSL=OFF",
               "-DLLAMA_BUILD_TESTS=OFF", "-DLLAMA_BUILD_EXAMPLES=OFF", "-DLLAMA_BUILD_SERVER=OFF", "-DLLAMA_BUILD_TOOLS=ON")


class Refusal(Exception):
    pass


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def _run(cmd: list[str], what: str) -> str:
    done = subprocess.run(cmd, capture_output=True, text=True, check=False)
    if done.returncode:
        raise Refusal(f"{what} failed (exit {done.returncode}):\n{(done.stdout + done.stderr)[-3000:]}")
    return done.stdout.strip()


def ensure_tree(tree: Path) -> None:
    if not tree.exists():
        tree.parent.mkdir(parents=True, exist_ok=True)
        _run(["git", "clone", "--quiet", "--filter=blob:none", "--no-checkout", LLAMA_CPP_REPO, str(tree)], "git clone llama.cpp")
        _run(["git", "-C", str(tree), "checkout", "--quiet", "--detach", LLAMA_CPP_COMMIT], "git checkout")
    head = _run(["git", "-C", str(tree), "rev-parse", "HEAD"], "git rev-parse")
    if head != LLAMA_CPP_COMMIT:
        raise Refusal(f"{tree} is at {head}, not {LLAMA_CPP_COMMIT}: git -C {tree} checkout --detach {LLAMA_CPP_COMMIT}")


def ensure_quantize(tree: Path, jobs: int) -> Path:
    binary = tree / "build" / "bin" / "llama-quantize"
    if not binary.is_file():
        _run(["cmake", "-S", str(tree), "-B", str(tree / "build"), *CMAKE_FLAGS], "cmake configure")
        _run(["cmake", "--build", str(tree / "build"), "--target", "llama-quantize", "-j", str(jobs)], "cmake build")
    if not binary.is_file():
        raise Refusal(f"the build left no {binary}")
    return binary


def convert_cmd(tree: Path, model: Path, f16: Path, name: str) -> list[str]:
    return [sys.executable, str(tree / "convert_hf_to_gguf.py"), str(model), *CONVERT_ARGS, "--outfile", str(f16), "--model-name", name]


def quantize_cmd(binary: Path, f16: Path, out: Path, quant: str) -> list[str]:
    return [str(binary), *QUANTIZE_ARGS, str(f16), str(out), quant]


def convert(model: Path, out: Path, quant: str = "Q4_0", tree: Path = DEFAULT_TREE, keep_f16: bool = False, jobs: int = 2) -> Path:
    if quant not in QUANTS:
        raise Refusal(f"quant {quant!r}: one of {', '.join(QUANTS)}")
    weights = sorted(model.glob("*.safetensors"))
    if not (model / "config.json").is_file() or not weights:
        raise Refusal(f"{model} needs config.json and *.safetensors")
    ensure_tree(tree)
    out.parent.mkdir(parents=True, exist_ok=True)
    name = out.name[:-len(".gguf")] if out.name.endswith(".gguf") else out.name
    f16 = out if quant == "F16" else out.with_name(out.stem + ".f16.gguf")
    _run(convert_cmd(tree, model, f16, name), "llama.cpp converter")
    sidecar = {"input_weights": {p.name: sha256_file(p) for p in weights}, "commit": LLAMA_CPP_COMMIT, "quant": quant,
               "convert_args": list(CONVERT_ARGS), "quantize_args": list(QUANTIZE_ARGS), "f16_sha256": sha256_file(f16)}
    if quant != "F16":
        _run(quantize_cmd(ensure_quantize(tree, jobs), f16, out, quant), "llama-quantize")
        if not keep_f16:
            f16.unlink()
    sidecar["sha256"] = sha256_file(out)
    sidecar["bytes"] = out.stat().st_size
    out.with_name(out.name + ".json").write_text(json.dumps(sidecar, indent=1, sort_keys=True) + "\n", encoding="utf-8")
    return out


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--model", required=True, type=Path)
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--quant", default="Q4_0", choices=QUANTS)
    ap.add_argument("--llama-cpp", type=Path, default=DEFAULT_TREE)
    ap.add_argument("--keep-f16", action="store_true")
    ap.add_argument("--jobs", type=int, default=2)
    args = ap.parse_args(argv)
    try:
        final = convert(args.model, args.out, args.quant, args.llama_cpp, args.keep_f16, args.jobs)
    except Refusal as why:
        print(f"FAIL {why}")
        return 1
    print(f"{final}  {final.stat().st_size:,} bytes")
    return 0


if __name__ == "__main__":
    sys.exit(main())
