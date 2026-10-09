"""HF backend for the eval driver: a trained checkpoint producing one assistant message per step.

    b = HFBackend(ckpt)
    raw = b.next_message(records)   # render.py records -> raw text for the runtime's `call_text`
    raw = b.complete(prompt)        # or from a prompt the caller rendered with render.py
    raw = b.complete(prompt, compile=lambda slots: rt.req({"op": "compile", "slots": slots}))   # the call from the runtime

`compile` (CONTRACT_V3.md section 7): a callable that sends the slots of the think to the session's `compile` op and returns the
reply. With it the call after `</think>` is the call the runtime compiles from the think's slots (`call`: after the grounding and
the conventions), not the one `fmt.call_of_think` renders. When the runtime refuses (`{"refused": {"slot", "why"}}`) the step is
generated once more with the think starting `retry: <slot>`; when that is refused too the message of the first draw stands, its
call rendered by `fmt.call_of_think` (the fallback). Without `compile` nothing changes. `last_info["compile"]` says what happened:
`compiled`, `retry` (compiled after one retry), `fallback`, or `none` (no trace to compile).

Prompts come from the shared renderer (../render.py, thinking kept in history), exactly as in
training. The returned text is the whole assistant message, `<think>\n…</think>\n\n<tool_call>…
</tool_call>`: the think is the slot lines of the trace (CONTRACT_V3.md) and the call is the one the think
states (decode.py), decoded free: nothing is masked. Per-step diagnostics (`think_cut`, `rendered_call`, token counts, seconds) are in
`last_info`, running totals in `stats`. `from_env` is what eval/run.py's `--model hf` uses.
"""
from __future__ import annotations

import os
import re
import sys
import threading
from pathlib import Path

import torch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import decode  # noqa: E402

_R = decode.fmt.render  # the shared renderer: the model's special strings come from it


class HFBackend:
    def __init__(self, ckpt: str, device: str | None = None, dtype: str = "float32", think_limit: int = 200,
                 max_new_tokens: int = 512, sample: bool = False, seed: int = 0):
        from transformers import AutoModelForCausalLM, AutoTokenizer
        self.device = device or ("cuda" if torch.cuda.is_available() else "cpu")
        self.tok = AutoTokenizer.from_pretrained(ckpt)
        self.model = AutoModelForCausalLM.from_pretrained(ckpt, dtype=getattr(torch, dtype)).to(self.device).eval()
        self.sample, self.seed = sample, seed
        self.dec = decode.Decoder(self.model, self.tok, think_limit=think_limit, max_new_tokens=max_new_tokens)
        self.lock = threading.Lock()
        self.last_info: dict = {}
        self.stats = {"steps": 0, "think_cut": 0, "unstopped": 0,
                      "new_tokens": 0, "seconds": 0.0, "compiled": 0, "retried": 0, "retry_ok": 0, "fallback": 0}

    def next_message(self, messages: list[dict], compile=None) -> str:
        """render.py records (system record with its tools) -> the next assistant message."""
        with self.lock:
            self.stats["steps"] += 1
            seed = self.seed + self.stats["steps"]
            text, info = self.dec.step(messages, sample=self.sample, seed=seed)
            text = self._record(text, info)
            if compile is not None:
                text = self._compiled(text, compile, lambda prefix: self.dec.step(messages, sample=self.sample,
                                                                                  seed=seed, prefix=prefix)[0])
            return text

    def _compiled(self, text: str, compile, again) -> str:
        """`text` with its call replaced by the runtime's compiled call (see the module docstring); `again(prefix)` draws the step
        once more with the think starting `prefix`."""
        text, how = compiled_message(text, compile, again)
        self.last_info["compile"] = how
        self.stats["compiled"] += how in ("compiled", "retry")
        self.stats["retried"] += how in ("retry", "retry-fallback")
        self.stats["retry_ok"] += how == "retry"
        self.stats["fallback"] += how in ("fallback", "retry-fallback")
        return text

    def complete(self, prompt: str, sample: bool | None = None, exclude: list[str] | None = None,
                 tries: int = 4, compile=None) -> str:
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
                text, info = self.dec.complete(prompt, sample=do_sample, seed=self.seed + self.stats["steps"])
                self._record(text, info)
                if not banned or _call_key(text) not in banned:
                    break
            if compile is not None:
                text = self._compiled(text, compile, lambda prefix: self.dec.complete(prompt, sample=do_sample,
                                                                                      seed=self.seed + self.stats["steps"], prefix=prefix)[0])
            return text

    def _record(self, text, info) -> str:
        self.last_info = info
        self.stats["think_cut"] += int(bool(info["think_cut"]))
        self.stats["unstopped"] += int(not info["stopped"])
        self.stats["new_tokens"] += info["new_tokens"]
        self.stats["seconds"] += info["seconds"]
        if os.environ.get("NATIVE_VERBOSE") == "1":  # per-step progress on stderr
            print("[hf] step %d: %d new tokens in %.1fs, think_cut=%s"
                  % (self.stats["steps"], info["new_tokens"], info["seconds"], info["think_cut"]), file=sys.stderr, flush=True)
        return text

    __call__ = next_message


RETRY_SLOT = re.compile(r"^[a-z_]+(?:\[\d{1,2}\])?$")


def compiled_message(text: str, compile, again=None) -> tuple[str, str]:
    """(the message with the runtime's compiled call, how). `compile(slots) -> reply` is the session's `compile` op. A think that
    cannot be read as a trace leaves the message as it is (`none`). A refusal draws the step once more through `again(prefix)` with
    `retry: <slot>` leading the think; a second refusal keeps the first draw (`fallback`: its call is the one `fmt.call_of_think`
    rendered, or the model wrote), `retry-fallback` when a retry was made."""
    T = decode.fmt.trace3()
    rec = assistant_record(text)
    if rec is None:
        return text, "none"

    def ask(think: str) -> dict | None:
        try:
            slots = T.slots_json(T.parse_any(think))
        except (ValueError, T.CompileError) as e:
            return {"refused": {"slot": "think", "why": str(e)}}
        return compile(slots)

    reply = ask(rec["think"])
    how, drawn = "compiled", text
    if "refused" in reply and again is not None:
        slot = reply["refused"]["slot"]
        retry = again("retry: %s\n" % (slot if RETRY_SLOT.match(slot) else "rejected"))
        second = assistant_record(retry)
        again_reply = ask(second["think"]) if second else None
        if again_reply and "call" in again_reply:
            drawn, reply, how = retry, again_reply, "retry"
        else:
            how = "retry-fallback"
    if "call" not in reply:
        return text, how if how == "retry-fallback" else "fallback"
    call = T.runtime_call(reply)
    head = drawn[:drawn.index(_R.THINK_CLOSE)]
    return head + _R.THINK_CLOSE + "\n\n" + _R.call_text(call["tool"], call["args"]), how


def _call_key(text: str) -> str:
    """The tool call of a model message with whitespace dropped (equal keys = the same call)."""
    start = text.rfind(_R.TOOL_CALL_OPEN)
    end = text.find(_R.TOOL_CALL_CLOSE, start)
    call = text[start:end + len(_R.TOOL_CALL_CLOSE)] if start >= 0 and end >= 0 else text
    return re.sub(r"\s+", "", call)


# ---- eval driver history -> the shared renderer's prompt

_TC, _TCC, _FO, _FC, _PO, _PC = (re.escape(x) for x in (
    _R.TOOL_CALL_OPEN, _R.TOOL_CALL_CLOSE, _R.FUNCTION_OPEN, _R.FUNCTION_CLOSE, _R.PARAMETER_OPEN, _R.PARAMETER_CLOSE))
CALL_RE = re.compile(rf"{_TC}\n{_FO}([a-z_]+)>\n((?:{_PO}[a-z_]+>\n(?:(?!{_PC}).)*\n{_PC}\n)*)"
                     rf"{_FC}\n{_TCC}", re.S)
PARAM_RE = re.compile(rf"{_PO}([a-z_]+)>\n((?:(?!{_PC}).)*)\n{_PC}\n", re.S)


def assistant_record(text: str) -> dict | None:
    """A raw assistant message (`<think>\\n…</think>\\n\\n<tool_call>…</tool_call>`) as a render.py
    record, parameter values kept as their exact strings (render.py writes a string value as is,
    so the call re-renders byte for byte). None when it is not one think block + one call."""
    body = text[len(_R.THINK_OPEN):] if text.startswith(_R.THINK_OPEN) else text
    if body.count(_R.THINK_CLOSE) != 1:
        return None
    think, _, rest = body.partition(_R.THINK_CLOSE)
    m = CALL_RE.fullmatch(rest.strip("\n"))
    if not m:
        return None
    return {"role": "assistant", "think": think.strip(), "tool": m.group(1),
            "args": {k: v for k, v in PARAM_RE.findall(m.group(2))}}


def prompt_from_history(system_rendered: str, history: list[dict]) -> str:
    """The generation prompt for eval/lib.py's Transcript: its system block (the runtime's own
    `rendered`, which render.py's system block equals — smoke checks it) + the history rendered
    by render.py, ending `<|im_start|>assistant\\n<think>\\n`. A malformed earlier assistant message
    (the model decodes free, so one is possible) cannot be a render.py record; it is spliced in verbatim with
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
        raw = m["content"][len(_R.THINK_OPEN):] if m["content"].startswith(_R.THINK_OPEN) else m["content"]
        out.append(_R.ASSISTANT_OPEN + raw + _R.IM_END + "\n")
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


REMOVED_ENV = ("NATIVE_DECODING", "NATIVE_LARK", "NATIVE_SOFT_THRESHOLD", "NATIVE_HANDLES")


def from_env(checkpoint: str) -> HFBackend:
    """The backend the eval driver (`eval/run.py --model hf --checkpoint P`) uses, loaded once per
    process. Options come from the environment so the driver's CLI stays as it is:
    NATIVE_THINK_LIMIT (200), NATIVE_DTYPE (float32), NATIVE_SAMPLE (0 = greedy; 1 = temperature 0.6, top-p 0.95),
    NATIVE_MAX_NEW (512). The grammar path's variables are refused, not ignored: decoding is free (D-1044-18)."""
    e = os.environ.get
    removed = [name for name in REMOVED_ENV if name in os.environ]
    if removed:
        raise SystemExit("%s: removed with the grammar path; decoding is free (D-1044-18)" % ", ".join(removed))
    with _LOAD_LOCK:
        if checkpoint not in _LOADED:
            _LOADED[checkpoint] = HFBackend(checkpoint, dtype=e("NATIVE_DTYPE", "float32"),
                                            think_limit=int(e("NATIVE_THINK_LIMIT", "200")),
                                            sample=e("NATIVE_SAMPLE", "0") == "1",
                                            max_new_tokens=int(e("NATIVE_MAX_NEW", "512")))
        return _LOADED[checkpoint]
