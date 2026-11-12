"""A trained adapter (PEFT directory) to the adapter GGUF the phone's engine loads, with the llama.cpp converter of the pinned commit.

    python -m adapter_train.export ADAPTER_DIR --base-config BASE_DIR --out FILE.gguf [--llama-cpp TREE]

The converter is `convert_lora_to_gguf.py` of the llama.cpp tree at `LLAMA_CPP_COMMIT` (the commit `llama-cpp-sys-2 0.1.158` vendors; the
constant and the tree check live in `experiments/toolchat/native/train/to_gguf.py` and are reused, not copied: one pin). **Never master**:
`to_gguf.check_tree` refuses any other checkout. `--base-config` is a directory holding the base model's `config.json` and tokenizer files
(no weights are read). The output is F16; the engine applies it over the Q4_0 base at run time.

Not run on a GPU box or against a trained adapter by any test: the tests build the command and check the refusal of a wrong tree.
"""
from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

_NATIVE = Path(__file__).resolve().parents[2] / "toolchat" / "native" / "train"


def pin():
    if str(_NATIVE) not in sys.path:
        sys.path.insert(0, str(_NATIVE))
    import to_gguf  # noqa: PLC0415 - the one pin of the llama.cpp commit

    return to_gguf


def command(tree, adapter_dir, base_config, out) -> list[str]:
    return [sys.executable, str(Path(tree) / "convert_lora_to_gguf.py"), "--base", str(base_config), "--outfile", str(out),
            "--outtype", "f16", str(adapter_dir)]


def export(adapter_dir, base_config, out, tree, *, run=subprocess.run) -> Path:
    """Convert. `tree` must be a llama.cpp checkout at the pinned commit (cloned by `to_gguf.ensure_tree` when absent)."""
    tg = pin()
    tg.ensure_tree(Path(tree))
    tg.check_tree(Path(tree))
    adapter_dir = Path(adapter_dir)
    for needed in ("adapter_config.json", "adapter_model.safetensors"):
        if not (adapter_dir / needed).is_file():
            raise SystemExit("%s has no %s: not a PEFT adapter directory" % (adapter_dir, needed))
    Path(out).parent.mkdir(parents=True, exist_ok=True)
    done = run(command(tree, adapter_dir, base_config, out), capture_output=True, text=True, check=False)
    if done.returncode != 0:
        raise SystemExit("the converter failed:\n%s" % (done.stderr or done.stdout)[-2000:])
    return Path(out)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("adapter_dir")
    ap.add_argument("--base-config", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--llama-cpp", default=None)
    a = ap.parse_args(argv)
    import os

    tree = a.llama_cpp or os.environ.get("LLAMA_CPP_DIR") or str(Path.home() / ".cache" / "centraid" / "llama.cpp")
    print(export(a.adapter_dir, a.base_config, a.out, tree))
    return 0


if __name__ == "__main__":
    sys.exit(main())
