"""llama.cpp backend for the eval driver: the same step as hf_backend.py, served by a local
`llama-server` (built with LLAMA_LLGUIDANCE=ON) so the prompt loop runs on CPU in minutes.

    llama-server -m qwen.gguf -np 4 -c 65536 -cms 64 --port 8089     # 4 slots, checkpoints kept
    NATIVE_LLAMA_URL=http://127.0.0.1:8089 python3 eval/run.py --model llama --jobs 4 ...

Faithful to decode.py: the prompt is rendered by the same code (`prompt_from_transcript`) and
sent as HF token ids, so the model sees the tokens the HF path feeds it; hard decoding uses the
same specialised grammar (`decode.Grammar`, handles narrowed per step). One step is two requests
on the same slot: (1) the think, under `THINK </think>` and capped at NATIVE_THINK_LIMIT tokens
(`</think>` appended when the cap cuts it, as decode.py forces it); (2) the call, under the rest
of the grammar. The server's prompt cache (recurrent-state checkpoints, `-cms 64`) means each step
only prefills what the previous step did not see. `free` runs step (2) unconstrained. Greedy.
"""
from __future__ import annotations

import json
import os
import sys
import threading
import time
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import decode  # noqa: E402
import fmt  # noqa: E402


class LlamaBackend:
    def __init__(self, url: str, lark: str, decoding: str = "hard", think_limit: int = 200,
                 max_new_tokens: int = 512, restrict_handles: bool = True, tokenizer: str = "Qwen/Qwen3.5-0.8B"):
        from transformers import AutoTokenizer
        assert decoding in ("hard", "free"), decoding
        self.url, self.decoding = url.rstrip("/"), decoding
        self.tok = AutoTokenizer.from_pretrained(tokenizer)
        self.grammar = decode.Grammar(lark, self.tok)
        self.think_limit, self.max_new, self.restrict = think_limit, max_new_tokens, restrict_handles
        ids = {t: self.tok.convert_tokens_to_ids(t) for t in ("</think>", "<tool_call>", "</tool_call>", "<|im_end|>")}
        self.think_end, self.call_open, self.call_end, self.im_end = (
            ids["</think>"], ids["<tool_call>"], ids["</tool_call>"], ids["<|im_end|>"])
        self.think_grammar = "%%llguidance {}\nstart: THINK <[%d]>\nTHINK: /(.|\\n)*/\n" % self.think_end
        self.lock = threading.Lock()
        self.stats = {"steps": 0, "think_cut": 0, "grammar_error": 0, "new_tokens": 0, "seconds": 0.0}

    def _post(self, body: dict) -> dict:
        req = urllib.request.Request(self.url + "/completion", data=json.dumps(body).encode(),
                                     headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=900) as r:
            return json.loads(r.read())

    def _gen(self, ids: list[int], n: int, grammar: str | None) -> list[int]:
        body = {"prompt": ids, "n_predict": n, "temperature": 0.0, "top_k": 1, "cache_prompt": True,
                "return_tokens": True, "special": True}
        if grammar:
            body["grammar"] = grammar
        out = self._post(body)
        return [t for t in out.get("tokens") or [] if t != self.im_end]

    def call_grammar(self, rows, results) -> str:
        g = self.grammar.specialise(rows, results, self.restrict)
        # decode.Grammar's start is `think </think> "\n\n" <tool_call> "\n" call </tool_call>`; the
        # think runs as its own request, so the call request starts after `</think>`
        head = 'start: think <[%d]> "\\n\\n"' % self.think_end
        assert g.count(head) == 1, "decode.Grammar start changed shape"
        return "%llguidance {}\n" + g.replace(head, 'start: "\\n\\n"')

    def complete(self, prompt: str) -> tuple[str, dict]:
        if prompt.endswith("<|im_start|>assistant\n"):
            prompt += "<think>\n"
        assert prompt.endswith("<|im_start|>assistant\n<think>\n"), prompt[-60:]
        t0 = time.time()
        ids = self.tok(prompt, add_special_tokens=False)["input_ids"]
        think = self._gen(ids, self.think_limit, self.think_grammar)
        cut = not (think and think[-1] == self.think_end)
        if cut:
            think = [t for t in think if t != self.think_end] + [self.think_end]
        rest_n = max(16, self.max_new - len(think))
        if self.decoding == "hard":
            call = self._gen(ids + think, rest_n, self.call_grammar(*fmt.addressable_in_prompt(prompt)))
        else:
            call = self._gen(ids + think, rest_n, None)
            if self.call_end in call:
                call = call[:call.index(self.call_end) + 1]
        closed = bool(call) and call[-1] == self.call_end
        text = "<think>\n" + self.tok.decode(think + call, skip_special_tokens=False)
        info = {"mode": self.decoding, "think_cut": cut, "override": False, "stopped": closed,
                "grammar_error": None if closed or self.decoding == "free" else "unclosed call",
                "prompt_tokens": len(ids), "new_tokens": len(think) + len(call), "think_tokens": len(think) - 1,
                "seconds": time.time() - t0}
        with self.lock:
            self.stats["steps"] += 1
            self.stats["think_cut"] += int(cut)
            self.stats["grammar_error"] += int(info["grammar_error"] is not None)
            self.stats["new_tokens"] += info["new_tokens"]
            self.stats["seconds"] += info["seconds"]
            if os.environ.get("NATIVE_STEP_LOG"):  # every step's prompt tail and message, as it happens
                with open(os.environ["NATIVE_STEP_LOG"], "a", encoding="utf-8") as f:
                    f.write(json.dumps({"prompt_tail": prompt[-300:], "text": text, **info}, ensure_ascii=False) + "\n")
            if os.environ.get("NATIVE_VERBOSE", "1") == "1":
                print("[llama] step %d: prompt %d, new %d, %.1fs, think_cut=%s"
                      % (self.stats["steps"], len(ids), info["new_tokens"], info["seconds"], cut),
                      file=sys.stderr, flush=True)
        return text, info


_LOADED: dict = {}
_LOAD_LOCK = threading.Lock()


def from_env() -> LlamaBackend:
    """NATIVE_LLAMA_URL (http://127.0.0.1:8089), NATIVE_DECODING hard|free, NATIVE_LARK (default: a
    fresh `nativetools export`), NATIVE_THINK_LIMIT (200), NATIVE_MAX_NEW (512), NATIVE_HANDLES (1)."""
    e = os.environ.get
    with _LOAD_LOCK:
        if "b" not in _LOADED:
            from hf_backend import export_lark
            _LOADED["b"] = LlamaBackend(e("NATIVE_LLAMA_URL", "http://127.0.0.1:8089"), e("NATIVE_LARK") or export_lark(),
                                        decoding=e("NATIVE_DECODING", "hard"),
                                        think_limit=int(e("NATIVE_THINK_LIMIT", "200")),
                                        max_new_tokens=int(e("NATIVE_MAX_NEW", "512")),
                                        restrict_handles=e("NATIVE_HANDLES", "1") == "1")
        return _LOADED["b"]
