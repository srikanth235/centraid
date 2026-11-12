"""The llama.cpp tree the phone's engine is built from, and the refusal of any other: the one pin the export step converts with.

The phone's engine is `llama-cpp-2 =0.1.158` (crates/assist-llama), which vendors llama.cpp as `llama-cpp-sys-2 0.1.158`. A GGUF is read by the
code that wrote its architecture's tensors, so the converter that writes the adapter file must be the one of the SAME llama.cpp tree:
`LLAMA_CPP_COMMIT`. The crate's source ships no converter (its tree has no `conversion/` package), so the commit was found by hashing every
one of the crate's 1865 files and looking for the commit of upstream's master that holds exactly those blobs: one commit matches all 1865
(the next best matches 1864), `26394b4e6` of 2026-09-21 ("json: Fixed json enum handling (#28518)"). Upgrading the crate means redoing that
match and changing the constant here; `check_tree` refuses any other checkout. The tree is `$LLAMA_CPP_DIR` or
`~/.cache/centraid/llama.cpp`: missing, `ensure_tree` clones it (blobless) from `LLAMA_CPP_REPO` and checks out the commit.
"""
from __future__ import annotations

import subprocess
from pathlib import Path

LLAMA_CPP_REPO = "https://github.com/ggml-org/llama.cpp"
# The llama.cpp tree `llama-cpp-sys-2 0.1.158` vendors (found by blob match, see the docstring).
LLAMA_CPP_COMMIT = "26394b4e6749a41c3633db040e0987500a5f7013"
ENGINE = "llama-cpp-sys-2 0.1.158"


class Refusal(Exception):
    """Something the caller can fix; the message says how."""


def git(tree: Path, *args: str) -> str:
    done = subprocess.run(["git", "-C", str(tree), *args], capture_output=True, text=True, check=False)
    if done.returncode:
        raise Refusal(f"git {' '.join(args)} in {tree} failed: {done.stderr.strip() or done.stdout.strip()}")
    return done.stdout.strip()


def check_tree(tree: Path, commit: str = LLAMA_CPP_COMMIT) -> None:
    """Refuse a llama.cpp checkout that is not exactly `commit` with its converter sources unmodified."""
    if not (tree / ".git").exists():
        raise Refusal(f"{tree} is not a git checkout of llama.cpp")
    head = git(tree, "rev-parse", "HEAD")
    if head != commit:
        raise Refusal(f"{tree} is at {head}, not {commit} (the llama.cpp {ENGINE} vendors): "
                      f"`git -C {tree} checkout --detach {commit}`")
    dirty = git(tree, "status", "--porcelain", "--untracked-files=no", "--", "convert_hf_to_gguf.py", "convert_lora_to_gguf.py", "conversion", "gguf-py")
    if dirty:
        raise Refusal(f"{tree} has local changes to the converter:\n{dirty}")
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
