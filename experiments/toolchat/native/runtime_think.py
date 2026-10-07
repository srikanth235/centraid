"""The stateless side of the runtime, as the Python side calls it: one `nativetools think` process per Python process.

The compiler that turns the slots of a think into the call the renderer writes (`compile_think`), and the rewrite of a v3.1
think as v4 (`v4_think`), live in the Rust runtime (`crates/assist/src/native/think.rs`), and so does the transcript renderer
(`render`, `render_many`, `call_text`, `user_content`: `crates/assist/src/native/transcript.rs`, the one text the trainer, the eval
driver and the phone's prompt are made of); this module is the client. It is what
`train/fmt.py` `call_of_think` (the decoder's forced call, the data builder's check of every record) and `fmt.records` (the
v4 rewrite of the thinks at training time) call, and what `authored/trace.py`'s `derive_trace3` round-trips against.

The process is started on first use and kept (`NATIVETOOLS` names the binary; the default is `target/debug/nativetools` of the
repository). A request is one JSON line, the answer one JSON line; a lock makes the client safe to call from the threads of a
batched decoder, and an LRU cache answers a request it has seen without asking again (a decoder renders the same think at
every sampled step of a turn, and a build checks the same think of every drill).

    compile_think(think, dates=None, mode=None) -> {"tool": ..., "args": {...}}   raises Refused
    v4_think(think, history=None, dates=None) -> str                                raises V4Skip
    context_of(think, history) -> dict       what the v4 rewrite reads of the conversation in front of the call: the turn's
                                             message, the block's `focus:` line, and the rows the think names
    render(messages) -> (text, spans)        the transcript of render records (`render.py` documents them): its text and the loss
                                             spans (code points) of every assistant message
    prompt(messages) -> str                  the transcript followed by the generation header
    render_many(list of messages) -> [(text, spans)]   `render` of many transcripts in one request
    call_text(tool, args) -> str             one tool call as the chat template writes it
    user_content(text, block) -> str         a user turn's content: the runtime's block, a blank line, the message

`mode` is `v3.1` or `v4`, how a think with no construct of either version is read (None: `default_mode()`).
"""
from __future__ import annotations

import collections
import json
import os
import re
import subprocess
import sys
import threading
from pathlib import Path

HERE = Path(__file__).resolve().parent
CACHE_SIZE = 50_000


class Refused(Exception):
    """A think that states no whole call: `cls` is the class (`CompileError`, `ValueError`), `message` says what is wrong."""

    def __init__(self, cls: str, message: str):
        super().__init__(message)
        self.cls, self.message = cls, message


class V4Skip(Exception):
    """A v3.1 think v4 cannot say, or says as another call (`reason`: `find`, `rows+row`, `unparsable`, `roundtrip`)."""

    def __init__(self, reason: str, detail: str = ""):
        super().__init__(reason, detail)
        self.reason, self.detail = reason, detail


def default_mode() -> str:
    """`v4` (the contract the trainer, the decoder and the data checks use), or `v3.1` when NATIVE_TRACE says so."""
    return "v3.1" if os.environ.get("NATIVE_TRACE", "").strip().lower() in ("v3.1", "v3", "3.1", "3") else "v4"


# ---------------------------------------------------------------------------------------------
# the process
# ---------------------------------------------------------------------------------------------

def binary() -> str:
    return os.environ.get("NATIVETOOLS", str(HERE.parents[2] / "target" / "debug" / "nativetools"))


class _Process:
    """`nativetools think`, started on first use; a request goes in under the lock, its answer comes out under it."""

    def __init__(self):
        self.lock = threading.Lock()
        self.proc: subprocess.Popen | None = None
        self.pid = 0
        self.cache: collections.OrderedDict[str, dict] = collections.OrderedDict()

    def _start(self) -> subprocess.Popen:
        exe = binary()
        if not os.path.isfile(exe):
            raise RuntimeError(f"the think compiler is the runtime's: NATIVETOOLS={exe} is not a file "
                               "(cargo build -p centraid-nativetools, or point NATIVETOOLS at the binary)")
        self.proc = subprocess.Popen([exe, "think"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                     text=True, encoding="utf-8", bufsize=1)
        self.pid = os.getpid()
        return self.proc

    def _alive(self) -> subprocess.Popen:
        # a forked child shares the pipes with its parent: it starts its own process instead
        if self.proc is None or self.proc.poll() is not None or self.pid != os.getpid():
            return self._start()
        return self.proc

    def ask(self, request: dict, cache: bool = True, error: type = RuntimeError) -> dict:
        """One request line in, one answer line out. `cache=False` for a request that is large or seen once (a transcript:
        the cache holds the lines themselves); `error` is what an `{"error": ...}` answer raises."""
        line = json.dumps(request, ensure_ascii=False, separators=(",", ":"))
        with self.lock:
            hit = self.cache.get(line) if cache else None
            if hit is not None:
                self.cache.move_to_end(line)
                return hit
            for attempt in (0, 1):
                proc = self._alive()
                try:
                    proc.stdin.write(line + "\n")
                    proc.stdin.flush()
                    answer = proc.stdout.readline()
                except (BrokenPipeError, OSError):
                    answer = ""
                if answer:
                    break
                err = proc.stderr.read() if proc.poll() is not None else ""
                self.proc = None
                if attempt:
                    raise RuntimeError(f"`{binary()} think` did not answer: {err.strip()[:300]}")
            reply = json.loads(answer)
            if "error" in reply:
                raise error(f"`nativetools think`: {reply['error']}")
            if cache:
                self.cache[line] = reply
                if len(self.cache) > CACHE_SIZE:
                    self.cache.popitem(last=False)
            return reply

    def close(self) -> None:
        with self.lock:
            if self.proc is not None and self.pid == os.getpid():
                try:
                    self.proc.stdin.close()
                    self.proc.wait(timeout=5)
                except (OSError, subprocess.TimeoutExpired):
                    self.proc.kill()
            self.proc = None


_PROCESS = _Process()
_TRACE_LOCK = threading.Lock()


def close() -> None:
    """Stop the process (the next request starts a new one)."""
    _PROCESS.close()


# ---------------------------------------------------------------------------------------------
# the calls
# ---------------------------------------------------------------------------------------------

def compile_think(think: str, dates: str | None = None, mode: str | None = None) -> dict:
    """The call a think states: `{"tool", "args"}` with the arguments in the order a call writes them. A pure function of the
    think, of the `dates:` line of the prompt (what a `dates[i]` is read against; None when the prompt has none) and of `mode`.
    Refused when the think is no trace or states no whole call."""
    reply = _PROCESS.ask({"op": "compile", "think": think, "dates": dates, "mode": mode or default_mode()})
    if "refused" in reply:
        raise Refused(reply["refused"]["class"], reply["refused"]["message"])
    call = reply["call"]
    return {"tool": call["tool"], "args": dict(call["args"])}  # the cached answer is shared: a caller gets its own


def render(messages: list[dict]) -> tuple[str, list[tuple[int, int]]]:
    """The transcript of `messages` (render records: system with its tools, user, assistant with its think and call, tool):
    `(text, loss spans in code points)`. The renderer is the runtime's (`transcript.rs`); a transcript it refuses (a system
    message that is not first, an unknown role) raises ValueError."""
    return _transcript(_PROCESS.ask({"op": "render", "messages": messages}, cache=False, error=ValueError))


def prompt(messages: list[dict]) -> str:
    """The transcript of `messages` followed by the assistant header that opens a generation (`<|im_start|>assistant\\n<think>\\n`)."""
    return _PROCESS.ask({"op": "prompt", "messages": messages}, cache=False, error=ValueError)["prompt"]


def render_many(conversations: list[list[dict]]) -> list[tuple[str, list[tuple[int, int]]]]:
    """`render` of each transcript, in one request."""
    reply = _PROCESS.ask({"op": "render_many", "conversations": conversations}, cache=False, error=ValueError)
    out = []
    for one in reply["renders"]:
        if "error" in one:
            raise ValueError(f"`nativetools think`: {one['error']}")
        out.append(_transcript(one))
    return out


def _transcript(reply: dict) -> tuple[str, list[tuple[int, int]]]:
    return reply["text"], [(a, b) for a, b in reply["spans"]]


def call_text(tool: str, args: dict) -> str:
    """One native tool call, as the chat template writes it (the runtime's `parse_call` reads it back)."""
    return _PROCESS.ask({"op": "call_text", "tool": tool, "args": args}, error=ValueError)["text"]


def user_content(text: str, block: str | None) -> str:
    """A user turn's content (SPEC §6.1): the runtime's block (`vault:`, `focus:` and `dates:` lines), a blank line, the message."""
    return _PROCESS.ask({"op": "user_content", "text": text, "block": block}, error=ValueError)["text"]


def v4_think(think: str, history: list[dict] | None = None, dates: str | None = None) -> str:
    """The v4 text of a v3.1 think. `history`: the messages before the call (the context the pick's reason is read from; none
    for the golden file, which keeps thinks and no conversations); `dates`: the prompt's `dates:` line, which a `dates[i]`
    compiles against (default: the line of `history`). V4Skip when v4 cannot say it, or when its compiled call is not the
    v3.1 think's."""
    request: dict = {"op": "v4", "think": think, "dates": dates}
    if history:
        T = authored_trace()
        request["dates"] = dates if dates is not None else T.dates_line_of(history)
        request["context"] = context_of(think, history)
    reply = _PROCESS.ask(request)
    if "skip" in reply:
        raise V4Skip(reply["skip"]["reason"], reply["skip"]["detail"])
    return reply["think"]


def context_of(think: str, history: list[dict]) -> dict:
    """What `v4_think` reads of the conversation in front of the call, and nothing else: the turn's message, the block's
    `focus:` line (without its lead), and for every `#n` the think names the row's name and the line that last showed it."""
    ctx = authored_trace().build_ctx(history)
    focus = next((ln[len("focus: "):] for ln in ctx.block.split("\n") if ln.startswith("focus: ")), None)
    rows = {}
    for n in dict.fromkeys(int(d) for d in re.findall(r"#(\d+)", think)):
        row = ctx.rows.get(n)
        if row is not None:
            rows[str(n)] = {"name": row.name, "line": row.line}
    return {"message": ctx.message, "focus": focus, "rows": rows}


def authored_trace():
    """authored/trace.py by path (the name `trace` is also a standard-library module), loaded once: the data's side of the
    trace (its context, its slots, its generator). The compiler is not in it."""
    with _TRACE_LOCK:  # batched scoring calls this from many threads: a half-executed module must never be visible
        if "authored_trace" not in sys.modules:
            import importlib.util
            spec = importlib.util.spec_from_file_location("authored_trace", HERE / "authored" / "trace.py")
            mod = importlib.util.module_from_spec(spec)
            sys.modules["authored_trace"] = mod  # trace.py's own dataclasses look itself up here while it executes
            try:
                spec.loader.exec_module(mod)
            except BaseException:
                sys.modules.pop("authored_trace", None)
                raise
        return sys.modules["authored_trace"]
