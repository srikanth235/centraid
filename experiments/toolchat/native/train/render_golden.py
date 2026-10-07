"""Write the golden file the Rust transcript renderer is tested against (`crates/assist/tests/transcript_golden.rs`).

The renderer used to be Python (`experiments/toolchat/native/render.py`, which took its system block from the HF chat
template); #1088 moved it to `crates/assist/src/native/transcript.rs` and `render.py` became a client of it. The goldens are the
output of the LAST PYTHON RENDERER, which stays in git history: the script reads it from commit `REFERENCE` (override with
`--reference-commit`) and runs it with the HF tokenizer (offline: `HF_HUB_OFFLINE=1`), so the Rust text is compared with the text
the trainer and the eval driver were using before the move, not with itself.

Each line of the file is one case: `{"name", "messages", "text", "spans", "prompts"}`, where `messages` are the render
records exactly as `render` reads them (`fmt.records`: the system record carries its tools, the thinks are v4), `spans` the loss
spans in code points, and `prompts` maps the index of every assistant message to `render_prompt_for_generation(messages[:i])`.
The cases are the first `--records` examples of `data/train.jsonl.gz` (train data only) and a few synthetic ones for what the data
never holds (no tools, an empty system text, Unicode whitespace to strip, non-string argument values, a run of tool turns).

    HF_HOME=... HF_HUB_OFFLINE=1 python train/render_golden.py crates/assist/tests/fixtures/transcript_golden.jsonl.gz
"""
from __future__ import annotations

import argparse
import gzip
import importlib.util
import json
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
NATIVE = HERE.parent
REPO = HERE.parents[3]
REFERENCE = "460e57233"  # the commit whose render.py is the last Python renderer
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(NATIVE))
import fmt  # noqa: E402


def load_reference(commit: str):
    """The Python renderer of `commit`, loaded from a scratch tree that has the `contracts/` it reads its identity from."""
    tmp = Path(tempfile.mkdtemp(prefix="render-reference-"))
    path = tmp / "experiments" / "toolchat" / "native" / "render.py"
    path.parent.mkdir(parents=True)
    path.write_bytes(subprocess.run(["git", "-C", str(REPO), "show", f"{commit}:experiments/toolchat/native/render.py"],
                                    check=True, capture_output=True).stdout)
    (tmp / "contracts").symlink_to(REPO / "contracts")
    spec = importlib.util.spec_from_file_location("reference_render", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def synthetic(tools: list) -> list[tuple[str, list[dict]]]:
    call = {"kind": "task", "when": {"unit": "day", "rel": 1, "name": "ünï"}, "limit": 3, "trashed": True, "skip": None, "list": [1, "é", {"b": 2, "a": 1}]}
    return [
        ("no tools", [{"role": "system", "content": "today: x"}, {"role": "user", "content": "hi"},
                      {"role": "assistant", "think": "intent: read", "tool": "answer", "args": {"rows": "#1"}}]),
        ("empty system text", [{"role": "system", "content": "  \n", "tools": tools}, {"role": "user", "content": "hi"}]),
        ("unicode whitespace is stripped", [
            {"role": "system", "content": "  today: ☀ x\u001f\n", "tools": tools},
            {"role": "user", "content": "\u001c　  dentist — 9am ☕\x1f"},
            {"role": "assistant", "think": "  intent: read  ", "tool": "answer", "args": {"rows": "#1"}},
            {"role": "tool", "content": "\u0085@1 · 0 tasks "}]),
        ("non-string arguments and a run of tool turns", [
            {"role": "system", "content": "today: x", "tools": tools},
            {"role": "user", "content": "dates: tomorrow = 2026-03-13\n\nwhat's on tomorrow"},
            {"role": "assistant", "think": "intent: read", "tool": "find", "args": call},
            {"role": "tool", "content": "@1 · 1 task"}, {"role": "tool", "content": "  second  "}, {"role": "tool", "content": "third"},
            {"role": "user", "content": "thanks"},
            {"role": "assistant", "think": "", "tool": "answer", "args": {}},
            {"role": "tool", "content": "last"}]),
        ("a transcript that ends on the user", [{"role": "system", "content": "s", "tools": tools}, {"role": "user", "content": "q"}]),
    ]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("out")
    ap.add_argument("--records", type=int, default=20)
    ap.add_argument("--reference-commit", default=REFERENCE)
    args = ap.parse_args()
    ref = load_reference(args.reference_commit)
    cases: list[tuple[str, list[dict]]] = []
    tools = None
    for i, ex in enumerate(fmt.read_examples(NATIVE / "data" / "train.jsonl.gz")):
        if i >= args.records:
            break
        msgs = fmt.records(ex)
        tools = tools or msgs[0]["tools"]
        cases.append((f"train[{i}] {ex['id']}", msgs))
    cases += synthetic(tools[:2])
    with gzip.open(args.out, "wt", encoding="utf-8", compresslevel=9) as fh:
        for name, msgs in cases:
            text, spans = ref.render(msgs)
            prompts = {str(j): ref.render_prompt_for_generation(msgs[:j]) for j, m in enumerate(msgs) if m["role"] == "assistant"}
            prompts[str(len(msgs))] = ref.render_prompt_for_generation(msgs)
            fh.write(json.dumps({"name": name, "messages": msgs, "text": text, "spans": spans, "prompts": prompts},
                                ensure_ascii=False) + "\n")
    print(f"{len(cases)} cases -> {args.out}")


if __name__ == "__main__":
    main()
