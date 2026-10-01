"""HF backend for the eval driver: a trained checkpoint producing one assistant message per step.

    b = HFBackend(ckpt, lark="export/call.lark", decoding="hard")   # hard | soft | free
    raw = b.next_message(records)   # render.py records -> raw text for the runtime's `call_text`
    raw = b.complete(prompt)        # or from a prompt the caller rendered with render.py

Prompts come from the shared renderer (../render.py, thinking kept in history), exactly as in
training. The returned text is the whole assistant message, `<think>\n…</think>\n\n<tool_call>…
</tool_call>`. Per-step diagnostics (`think_cut`, `override`, token counts, seconds) are in
`last_info`, running totals in `stats`. `from_env` is what eval/run.py's `--model hf` uses.
"""
from __future__ import annotations

import os
import re
import subprocess
import sys
import tempfile
import threading
from pathlib import Path

import torch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import decode  # noqa: E402


class HFBackend:
    def __init__(self, ckpt: str, lark: str, decoding: str = "hard",
                 device: str | None = None, dtype: str = "float32", think_limit: int = 200,
                 soft_threshold: float = 0.05, max_new_tokens: int = 512, sample: bool = False,
                 restrict_handles: bool = True, seed: int = 0):
        from transformers import AutoModelForCausalLM, AutoTokenizer
        assert decoding in ("hard", "soft", "free"), decoding
        self.device = device or ("cuda" if torch.cuda.is_available() else "cpu")
        self.tok = AutoTokenizer.from_pretrained(ckpt)
        self.model = AutoModelForCausalLM.from_pretrained(ckpt, dtype=getattr(torch, dtype)).to(self.device).eval()
        self.decoding, self.sample, self.seed = decoding, sample, seed
        self.dec = decode.Decoder(self.model, self.tok, lark, think_limit=think_limit,
                                  soft_threshold=soft_threshold, max_new_tokens=max_new_tokens,
                                  restrict_handles=restrict_handles)
        self.lock = threading.Lock()
        self.last_info: dict = {}
        self.stats = {"steps": 0, "think_cut": 0, "override": 0, "grammar_error": 0, "unstopped": 0,
                      "new_tokens": 0, "seconds": 0.0}

    def next_message(self, messages: list[dict]) -> str:
        """render.py records (system record with its tools) -> the next assistant message."""
        with self.lock:
            self.stats["steps"] += 1
            text, info = self.dec.step(messages, mode=self.decoding, sample=self.sample,
                                       seed=self.seed + self.stats["steps"])
            return self._record(text, info)

    def complete(self, prompt: str, sample: bool | None = None, exclude: list[str] | None = None,
                 tries: int = 4) -> str:
        """Same, from a prompt the caller rendered (e.g. eval's `Transcript.render_qwen()`).

        Optional (defaults leave the call exactly as before): `sample` overrides the backend's
        sampling flag for this call; `exclude` lists tool calls the draw must not produce (compared
        on the `<tool_call>…</tool_call>` part, whitespace-insensitive): it redraws, up to `tries`
        times with new seeds, and returns the last draw if every one collides (the caller decides)."""
        with self.lock:
            do_sample = self.sample if sample is None else sample
            banned = {_call_key(c) for c in exclude or []}
            for attempt in range(max(1, tries) if banned else 1):
                self.stats["steps"] += 1
                text, info = self.dec.complete(prompt, mode=self.decoding, sample=do_sample,
                                               seed=self.seed + self.stats["steps"])
                self._record(text, info)
                if not banned or _call_key(text) not in banned:
                    break
            return text

    def _record(self, text, info) -> str:
        self.last_info = info
        for k in ("think_cut", "override"):
            self.stats[k] += int(bool(info[k]))
        self.stats["grammar_error"] += int(info["grammar_error"] is not None)
        self.stats["unstopped"] += int(not info["stopped"])
        self.stats["new_tokens"] += info["new_tokens"]
        self.stats["seconds"] += info["seconds"]
        if os.environ.get("NATIVE_VERBOSE") == "1":  # per-step progress on stderr
            print("[hf] step %d: %d new tokens in %.1fs, think_cut=%s, grammar_error=%s"
                  % (self.stats["steps"], info["new_tokens"], info["seconds"], info["think_cut"],
                     info["grammar_error"]), file=sys.stderr, flush=True)
        return text

    __call__ = next_message


def _call_key(text: str) -> str:
    """The tool call of a model message with whitespace dropped (equal keys = the same call)."""
    start = text.rfind("<tool_call>")
    end = text.find("</tool_call>", start)
    call = text[start:end + len("</tool_call>")] if start >= 0 and end >= 0 else text
    return re.sub(r"\s+", "", call)


# ---- eval driver history -> the shared renderer's prompt

CALL_RE = re.compile(r"<tool_call>\n<function=([a-z_]+)>\n((?:<parameter=[a-z_]+>\n(?:(?!</parameter>).)*\n</parameter>\n)*)"
                     r"</function>\n</tool_call>", re.S)
PARAM_RE = re.compile(r"<parameter=([a-z_]+)>\n((?:(?!</parameter>).)*)\n</parameter>\n", re.S)


def assistant_record(text: str) -> dict | None:
    """A raw assistant message (`<think>\\n…</think>\\n\\n<tool_call>…</tool_call>`) as a render.py
    record, parameter values kept as their exact strings (render.py writes a string value as is,
    so the call re-renders byte for byte). None when it is not one think block + one call."""
    body = text[len("<think>\n"):] if text.startswith("<think>\n") else text
    if body.count("</think>") != 1:
        return None
    think, _, rest = body.partition("</think>")
    m = CALL_RE.fullmatch(rest.strip("\n"))
    if not m:
        return None
    return {"role": "assistant", "think": think.strip(), "tool": m.group(1),
            "args": {k: v for k, v in PARAM_RE.findall(m.group(2))}}


def prompt_from_history(system_rendered: str, history: list[dict]) -> str:
    """The generation prompt for eval/lib.py's Transcript: its system block (the runtime's own
    `rendered`, which render.py's system block equals — smoke checks it) + the history rendered
    by render.py, ending `<|im_start|>assistant\\n<think>\\n`. A malformed earlier assistant message
    (possible under free decoding) cannot be a render.py record; it is spliced in verbatim with
    render.py's assistant framing, and the history around it is rendered in segments."""
    out, seg = [system_rendered], []
    for m in history:
        if m["role"] != "assistant":
            seg.append({"role": m["role"], "content": m["content"]})
            continue
        rec = assistant_record(m["content"])
        if rec is not None:
            seg.append(rec)
            continue
        out.append(decode.fmt.render.render(seg)[0] if seg else "")
        seg = []
        raw = m["content"][len("<think>\n"):] if m["content"].startswith("<think>\n") else m["content"]
        out.append("<|im_start|>assistant\n<think>\n" + raw + "<|im_end|>\n")
    out.append(decode.fmt.render.render_prompt_for_generation(seg))
    return "".join(out)


def prompt_from_transcript(transcript) -> str:
    """eval/lib.py Transcript -> generation prompt; user turns rebuilt with render.user_content
    (vault block first, as in training) from the raw text and block the Transcript keeps."""
    user_content = decode.fmt.render.user_content
    hist = []
    for m in transcript.messages:
        if m["role"] == "user" and "text" in m:
            hist.append({"role": "user", "content": user_content(m["text"], m.get("preground"))})
        else:
            hist.append({"role": m["role"], "content": m["content"]})
    return prompt_from_history(transcript.system_rendered, hist)


_LOADED: dict = {}
_LOAD_LOCK = threading.Lock()


def from_env(checkpoint: str) -> HFBackend:
    """The backend the eval driver (`eval/run.py --model hf --checkpoint P`) uses, loaded once per
    process. Options come from the environment so the driver's CLI stays as it is:
    NATIVE_DECODING hard|soft|free (default hard), NATIVE_LARK (default: a fresh
    `nativetools export`), NATIVE_THINK_LIMIT (200), NATIVE_SOFT_THRESHOLD (0.05),
    NATIVE_DTYPE (float32), NATIVE_SAMPLE (0 = greedy; 1 = temperature 0.6, top-p 0.95),
    NATIVE_HANDLES (1 = restrict #n/@n to the addressable ones; 0 = any), NATIVE_MAX_NEW (512)."""
    e = os.environ.get
    key = (checkpoint, e("NATIVE_DECODING", "hard"))
    with _LOAD_LOCK:
        return _LOADED[key] if key in _LOADED else _load(key, checkpoint, e)


def export_lark() -> str:
    """A fresh `nativetools export` of the call grammar (NATIVETOOLS: the binary to run)."""
    nt = os.environ.get("NATIVETOOLS", str(Path(__file__).resolve().parents[4] / "target" / "debug" / "nativetools"))
    d = tempfile.mkdtemp(prefix="native-export-")
    subprocess.run([nt, "export", d], check=True, capture_output=True)
    return str(Path(d) / "call.lark")


def _load(key, checkpoint, e) -> HFBackend:
    lark = e("NATIVE_LARK") or export_lark()
    _LOADED[key] = HFBackend(checkpoint, lark, decoding=key[1], dtype=e("NATIVE_DTYPE", "float32"),
                             think_limit=int(e("NATIVE_THINK_LIMIT", "200")),
                             soft_threshold=float(e("NATIVE_SOFT_THRESHOLD", "0.05")),
                             sample=e("NATIVE_SAMPLE", "0") == "1",
                             max_new_tokens=int(e("NATIVE_MAX_NEW", "512")),
                             restrict_handles=e("NATIVE_HANDLES", "1") == "1")
    return _LOADED[key]
