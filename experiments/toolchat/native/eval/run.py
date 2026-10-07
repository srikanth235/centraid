"""Drive a model over an eval set through `nativetools session`, writing a run file for score.py.

    python3 run.py --set sets/val.jsonl --model sonnet --out runs/val-sonnet.jsonl [--jobs 8]
    python3 run.py --set sets/val.jsonl --model ref    --out runs/val-ref.jsonl     # gold check
    python3 run.py --set sets/val.jsonl --model replay --replay runs/x.jsonl --out runs/y.jsonl
    python3 run.py --set sets/val.jsonl --model hf --checkpoint PATH --out ...       # trainer fills in

Per turn: send the user text (a retraction ends the turn right there, `user["ended"]`: one synthetic step
with `model: ""` and `runtime: "never_mind"`, no model step), then loop model -> `call_text` -> runtime
response until the runtime ends the turn (the runtime enforces STEP_CAP; the driver stops at STEP_CAP + 2 as a
guard). A call identical to the previous one is not cut at once: the runtime answers it with a
hint, then a nudge, and ends the turn on the third; the driver resamples once in between
(`break_loop`). Each session runs on a private copy of its world's vault, deleted afterwards.

Retry on a runtime signal (opt-in; `NATIVE_RETRY` unset or empty = off, the loop above bit for bit).
`NATIVE_RETRY=empty,error,refused` lists the signals (`retry_signal` classifies a response):
  empty    a read that found nothing (`recovery: empty`, a `find`/`answer` miss, text `answered: 0 ...`)
  error    an `error:` reply (the runtime refused the call as invalid, or could not read it)
  refused  a `refused: ...` reply (the vault refused the write)
When a response carries a listed signal, the turn is still open, nothing was written (`retry_signal` is None for
a response with a `diff` or `created`) and this turn has used fewer than `NATIVE_RETRY_MAX` (default 1) retries,
the driver re-draws that SAME step once: `backend.resample` at temperature > 0 on the transcript as it stood
BEFORE the failed call (the model does not see the failed call or its reply), the failed call's text excluded.
The runtime cannot take a call back: the first call already ran (a read, an error or a refusal changed nothing, so
this is safe) and stays in the runtime's session, so the re-drawn call is simply the turn's NEXT step and the
runtime's STEP_CAP counts both. The model's history keeps both pairs (failed call, reply, re-drawn call, reply),
as the runtime holds them, so the compaction indices and the later steps' view stay in line. The re-drawn step is
recorded with `retry: <signal>` (the first step is untouched); `<out>.stats.json` counts them under `retry`
({signal: steps}). A backend that cannot sample (`resample` returns None) never retries.

Backends
  ref     the reference call sequence stored with the gold (`ref`), `$key` -> the row's `#n`;
          running it and scoring is how every gold item is verified.
  sonnet  `claude -p --model sonnet`, given the rendered system prompt, a policy digest and the
          transcript; asked for exactly one Qwen `<tool_call>` per step. Every output is cached
          on disk keyed by the hash of its full input, so reruns are free.
  hf      the trained Qwen model (train/hf_backend.py), decoded free: greedy, nothing masked. The call it executes is the
          one the session's `compile` op builds from the think's slots; each step records `compile` (compiled | retry |
          fallback | retry-fallback | none) and the run's counts go to <out>.stats.json.
Each backend fixes the session's `--tools` spelling of the tools block: sonnet `full` (untrained,
needs described schemas), hf `sig` (what the fine-tuned model saw); `--tools` overrides it.
  replay  re-sends the model messages recorded in an earlier run file.
"""

from __future__ import annotations

import argparse
import concurrent.futures as cf
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from lib import (STEP_CAP, NameIndex, Runtime, Transcript, effect_rows, first_call, format_call, load_keys,
                 load_world, read_jsonl)

HERE = Path(__file__).resolve().parent
CACHE = Path(os.environ.get("EVAL_CACHE", "/tmp/nativetools-eval/cache"))
TMP = os.environ.get("EVAL_TMP")  # where per-session vault copies live (default: system temp)


class StepOut(dict):
    """{"text": raw model message, "think_cut": bool}; the hf backend adds `compile` (what the runtime's compile op did:
    compiled | retry | fallback | retry-fallback | none). Older run files also carry `override` and `decoding` on a step; they
    are no longer written, and no reader may require them."""


def compile_key(info: dict) -> dict:
    """{"compile": how} when the draw went through the compile op, else {}."""
    return {"compile": info["compile"]} if info.get("compile") else {}


def compile_counts(records) -> dict:
    """{how: steps} over the `compile` keys of run records (empty when no step went through the compile op)."""
    counts: dict[str, int] = {}
    for rec in records:
        for turn in rec.get("turns", []):
            for step in turn.get("steps", []):
                if "compile" in step:
                    counts[step["compile"]] = counts.get(step["compile"], 0) + 1
    return dict(sorted(counts.items()))


# ---------------------------------------------------------------------------------------------
# Backends
# ---------------------------------------------------------------------------------------------


class Backend:
    name = "base"
    tools_mode = "sig"  # the session's `--tools` spelling of the tools block (sig | compact | full)
    runtime_flags: list[str] = []  # extra `nativetools session` flags this backend's runtime starts with
    compile = None  # set by run_session: slots -> the session's `compile` op reply (backends that write a trace use it)

    def start_session(self, session: dict) -> None:  # noqa: D401
        """Called before the first turn."""

    def step(self, transcript: Transcript, ctx: dict) -> StepOut:
        raise NotImplementedError

    def resample(self, transcript: Transcript, ctx: dict, exclude: str) -> StepOut | None:
        """A fresh draw at temperature > 0 whose call differs from `exclude` (the call the model just
        repeated). None when the backend cannot sample; the driver then lets the runtime nudge."""
        return None


class RefBackend(Backend):
    """Emits the gold's reference calls. `$key` in any string argument becomes the `#n` the
    runtime gave that world row; `$new` the last created row, `$c1` the first row created in the
    session; `@prev` the last result handle."""

    name = "ref"
    # a reference states the call the author meant (some are "bad, then the right call", the runtime expected to
    # refuse the bad one): the best-effort repairs of malformed calls (normalize.rs) stay off, so the gold is the intent
    runtime_flags = ["--no-normalize"]

    def start_session(self, session: dict) -> None:
        self.keys = load_keys(session["world"])
        self.session = session

    def step(self, transcript: Transcript, ctx: dict) -> StepOut:
        calls = self.session["turns"][ctx["turn"]]["ref"]
        if ctx["step"] >= len(calls):
            return StepOut(text="(reference sequence exhausted)", think_cut=False)
        call = calls[ctx["step"]]
        args = json.loads(json.dumps(call.get("args", {})))

        def sub(value):
            if isinstance(value, str):
                def repl(m):
                    key = m.group(1)
                    if key == "new":
                        return f"#{ctx['last_created']}"
                    if re.fullmatch(r"c\d+", key):  # the k-th row created in this session
                        return f"#{ctx['created'][int(key[1:]) - 1]}"
                    vid = self.keys[key]["id"]
                    if vid not in ctx["n_of"]:
                        raise KeyError(f"ref names ${key} before the runtime showed it")
                    return f"#{ctx['n_of'][vid]}"
                value = re.sub(r"\$([A-Za-z0-9_]+)", repl, value)
                return value.replace("@prev", ctx.get("last_result") or "@0")
            if isinstance(value, dict):
                return {k: sub(v) for k, v in value.items()}
            return value

        args = {k: sub(v) for k, v in args.items()}
        return StepOut(text=format_call(call["tool"], args), think_cut=False)


# The SPEC §14 reading conventions (dates, at-N, diary, wifi, balance sign) are deliberately left out
# of the digest: Sonnet is scored zero-shot, and score.py reports the pass rate without those turns.
POLICY_DIGEST = """You are the assistant inside a personal vault app. You act ONLY by calling the tools
described in the system prompt, in exactly the XML format it shows. Every reply is ONE tool call:
optionally a short reasoning paragraph, then exactly one <tool_call>...</tool_call> block, nothing after it.
The runtime executes the call and replies with a <tool_response>. `answer`, `ask`, `decline` and `act`
(without more=true) end the turn; `search`, `find`, `open`, `compute` let you look first.

Policy (follow it exactly):
1. Intent: a question about rows -> answer with rows (answer kind/name/where/when..., or answer rows=#n/@n);
   "how much / how many / total / balance" -> answer op=count|sum|min|max|balance; a change -> act;
   the vault cannot decide between candidates -> ask (options = the #n candidates);
   outside the vault or unsafe -> decline with a reason.
2. One step when a selector says it all; look first (find/search) when you need to see rows (a pick,
   an unfamiliar name, a write whose target must be seen).
3. A name that is not in the vault directory, the pre-grounding line of this turn, or rows shown earlier
   is unfamiliar -> search it first.
4. Prefer stating a constraint (name/where/when/linked_to/order/limit) over picking #n.
5. Dead end (empty result, no link, error): recover once using the rows the runtime offered or a search;
   decline not_found only when that also finds nothing.
6. Ambiguity (a name fits several rows and nothing in the conversation decides) -> ask naming the candidates.
   After an `ambiguous:` response the same rule applies. If the message says "all"/"both", name every row.
7. Answer exactly what was asked, with the kind asked about ("who" -> people).
8. Follow-ups: a narrowing fragment ("just the weekend ones") = within=@n plus the condition; a substitution
   fragment ("and Ray?") = the previous call with that slot replaced.
9. Corrections add a new write; `undo` only when the person says "undo that" / "I didn't mean that".
10. Writes on targets that exist only in the trash -> decline not_found, unless the person asked to restore.
11. Never a destructive write from a read phrasing ("is X in the bin?" is a read).
12. Already-so writes (complete a completed task, star a starred row...): still call act; the runtime answers `already:`.
13. Group members = kind=person linked_to=<group #n>. `undo` reverts the whole previous turn. Bare amounts
    are in the vault's default currency.
14. Several writes in one message: each act but the last has more=true. A write to several rows names them all
    in one act. "Do X and tell me Y": act with more=true, then answer.
15. Surface notes: act/answer/compute name their rows EITHER with rows=#n/@n OR with a selector (kind plus
    name/where/when/linked_to/within/order/limit), never both. New values go in `args` as "field: value"
    lines, one per line: create takes the kind as the `kind` parameter and only fields in args
    (kind=task, args "name: ...\ndate: {date expr}"); edit "field: value" (rename = "name: ...");
    reschedule "to: {date expr}"; add_to "to: #n"; remove_from "from: #n"; log "kind: call";
    settle_up "group: #n"; reveal "field: password". Date values are JSON date expressions, never plain text.
    `when` is only ever a filter on the kind's own date, never a new value. Rows shown before the previous
    turn are compacted: reach them again with find/search or within=@n before picking by #n. An answer
    that matches nothing is a valid answer ("nothing due friday"). `options` of ask and
    `rows` take only "#n, #m" (no labels). `answer value=@n` takes nothing else.
16. Decline reasons: out_of_scope (not about the vault / not possible here), unbounded_destruction (wipe
    everything / delete all of a kind without bounds), sealed_egress (send vault data or secrets outside),
    fabricated_secret (asked to invent or guess a secret/password), never_mind (the person withdraws the
    request), not_found (the thing does not exist, after searching).
"""


class SonnetBackend(Backend):
    name = "sonnet"
    tools_mode = "full"  # untrained: it needs the described schemas

    def __init__(self, model: str = "sonnet"):
        self.model = model
        CACHE.mkdir(parents=True, exist_ok=True)

    def step(self, transcript: Transcript, ctx: dict) -> StepOut:
        system = transcript.system_rendered
        system = system.replace("<|im_start|>system\n", "").replace("<|im_end|>", "").strip()
        system = POLICY_DIGEST + "\n\n" + system
        # `claude -p` tells the model the real date; the vault's own `today:` line must win, so it is
        # restated next to the conversation (without this Sonnet dated "overdue"/"next" from the host clock)
        today = re.search(r"^today: (.+)$", system, re.M)
        when = f"The vault's today is {today.group(1)}; every date is relative to it, not to any other date you know.\n\n" if today else ""
        prompt = (when + "Conversation so far (you are ASSISTANT; the last USER message is the one to serve):\n\n"
                  + transcript.render_plain()
                  + "\n\nWrite your next step now: optional brief reasoning, then exactly one <tool_call> block.")
        key = hashlib.sha256(f"{self.model}\n{system}\n{prompt}".encode()).hexdigest()
        path = CACHE / f"{key}.json"
        if path.exists():
            return StepOut(text=json.loads(path.read_text())["text"], think_cut=False)
        with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False) as handle:
            handle.write(system)
            sys_path = handle.name
        text = ""
        try:
            for attempt in range(4):
                proc = subprocess.run(
                    ["claude", "-p", "--model", self.model, "--system-prompt-file", sys_path, "--tools", "",
                     "--no-session-persistence", "--strict-mcp-config", "--output-format", "json"],
                    input=prompt, capture_output=True, text=True, cwd=tempfile.gettempdir(), timeout=300,
                )
                try:
                    out = json.loads(proc.stdout)
                    if not out.get("is_error"):
                        text = out.get("result") or ""
                        break
                except json.JSONDecodeError:
                    pass
                time.sleep(5 * (attempt + 1))
        finally:
            os.unlink(sys_path)
        if text:
            path.write_text(json.dumps({"text": text}))
        return StepOut(text=text, think_cut=False)


class HFBackend(Backend):
    """The trained Qwen3.5 model. The trainer step fills this in: load the checkpoint, render
    `transcript.system_rendered` + `transcript.history()` with experiments/toolchat/native/render.py
    (earlier turns keep their thinking), generate greedily and unconstrained
    until `</tool_call>` or the think budget, and return the FULL message (think + call) as
    `text` with `think_cut` set when the budget cut a <think>. The driver records that full
    text in the run file and appends it to the history the next step sees."""

    name = "hf"
    tools_mode = "sig"  # what the fine-tuned model was trained on

    def __init__(self, checkpoint: str | None = None, **kwargs):
        # implemented in ../train/hf_backend.py; the model loads once per process (options from
        # NATIVE_* environment variables, see `from_env`)
        sys.path.insert(0, str(HERE.parent / "train"))
        from hf_backend import from_env

        if not checkpoint:
            raise SystemExit("--model hf needs --checkpoint")
        self.checkpoint = checkpoint
        self.impl = from_env(checkpoint)

    def step(self, transcript: Transcript, ctx: dict) -> StepOut:
        from hf_backend import prompt_from_transcript

        text = self.impl.complete(prompt_from_transcript(transcript), compile=self.compile)
        info = self.impl.last_info
        return StepOut(text=text, think_cut=bool(info.get("think_cut")), **compile_key(info))

    def resample(self, transcript: Transcript, ctx: dict, exclude: str) -> StepOut | None:
        from hf_backend import prompt_from_transcript

        text = self.impl.complete(prompt_from_transcript(transcript), sample=True, exclude=[exclude], compile=self.compile)
        info = self.impl.last_info
        return StepOut(text=text, think_cut=bool(info.get("think_cut")), **compile_key(info))


class ReplayBackend(Backend):
    """Re-sends the model messages of a recorded run (same session ids, same turn/step order)."""

    name = "replay"

    def __init__(self, path: str):
        self.recorded = {r["id"]: r for r in read_jsonl(path)}
        modes = {r.get("tools_mode") for r in self.recorded.values() if r.get("tools_mode")}
        if len(modes) == 1:
            self.tools_mode = modes.pop()  # replay under the prompt the recording saw

    def start_session(self, session: dict) -> None:
        self.rec = self.recorded.get(session["id"])

    def step(self, transcript: Transcript, ctx: dict) -> StepOut:
        try:
            s = self.rec["turns"][ctx["turn"]]["steps"][ctx["step"]]
        except (TypeError, IndexError, KeyError):
            return StepOut(text="(no recorded step)", think_cut=False)
        return StepOut(text=s["model"], think_cut=bool(s.get("think_cut")))


# ---------------------------------------------------------------------------------------------
# Driver
# ---------------------------------------------------------------------------------------------


def slim(response: dict) -> dict:
    """Drop the long id lists of looking steps; answers and writes are kept whole."""
    eff = response.get("effect") or {}
    if eff.get("tool") in ("find", "search", "open", "compute") and len(eff.get("rows") or []) > 40:
        eff = dict(eff)
        eff["rows"] = eff["rows"][:40]
        eff["rows_truncated"] = True
        response = dict(response)
        response["effect"] = eff
    return response


def break_loop(rt: Runtime, backend: Backend, transcript: Transcript, ctx: dict, out: StepOut) -> StepOut:
    """The loop breaker's second rung (the runtime owns the first and third; session.rs `repeat_outcome`).

    The runtime answers a call identical to the previous one with a hint (1st repeat), a nudge
    (2nd) and ends the turn (3rd). Before the 2nd repeat is sent, the model has already seen the
    hint and still resent the call: draw once more at temperature > 0 with that call excluded
    and send the new draw instead. The discarded message is recorded on the step as
    `resampled_from` and never enters the transcript. A backend that cannot resample, or a draw
    that repeats again, falls through: the runtime nudges."""
    sent = first_call(out["text"])
    peek = rt.req({"op": "peek_repeat", "text": sent})
    if not peek.get("repeat") or peek.get("strikes") != 1:
        return out
    alt = backend.resample(transcript, ctx, sent)
    if alt is None:
        return out
    alt["resampled_from"] = out["text"]
    return alt


RETRY_SIGNALS = ("empty", "error", "refused")


def retry_config() -> tuple[frozenset, int]:
    """(signals, per-turn cap) from NATIVE_RETRY / NATIVE_RETRY_MAX; no signals = retry off."""
    names = [n.strip() for n in os.environ.get("NATIVE_RETRY", "").split(",") if n.strip()]
    unknown = [n for n in names if n not in RETRY_SIGNALS]
    if unknown:
        raise SystemExit(f"NATIVE_RETRY: unknown signal {unknown} (known: {', '.join(RETRY_SIGNALS)})")
    return frozenset(names), int(os.environ.get("NATIVE_RETRY_MAX", "1"))


def retry_signal(resp: dict) -> str | None:
    """Which retry signal a runtime response carries (`refused` | `error` | `empty`), else None.

    Only a response that left the turn open and changed nothing counts: a response that ends the turn, that
    wrote (`diff` or `created` in the effect, even beside an `error`), or that is the runtime's own loop
    breaker (`repeat`, `loop`, `cap`) is None."""
    eff = resp.get("effect") or {}
    text = resp.get("text") or ""
    if resp.get("ends_turn") or any(eff.get(k) for k in ("diff", "created", "repeat", "loop", "cap")):
        return None
    if text.startswith("refused:"):
        return "refused"
    if eff.get("error") or text.startswith("error:"):
        return "error"
    if (eff.get("recovery") == "empty" or (eff.get("compose") or {}).get("action") in ("find_miss", "answer_miss")
            or text.startswith("answered: 0")):
        return "empty"
    return None


def retry_counts(records) -> dict:
    """{signal: steps} over the `retry` keys of run records (empty when no step was a retry)."""
    counts: dict[str, int] = {}
    for rec in records:
        for turn in rec.get("turns", []):
            for step in turn.get("steps", []):
                if "retry" in step:
                    counts[step["retry"]] = counts.get(step["retry"], 0) + 1
    return dict(sorted(counts.items()))


def run_session(session: dict, backend: Backend) -> dict:
    backend.start_session(session)
    retry_on, retry_max = retry_config()
    record = {"id": session["id"], "model": backend.name, "tools_mode": backend.tools_mode, "turns": []}
    with Runtime(session["world"], session["today"], session["me"], tmp_root=TMP,
                 flags=["--tools", backend.tools_mode, *backend.runtime_flags]) as rt:
        backend.compile = lambda slots: rt.req({"op": "compile", "slots": slots})
        prompt = rt.req({"op": "prompt"})
        transcript = Transcript(prompt["rendered"])
        ctx: dict = {"n_of": {}, "last_created": None, "last_result": None, "created": []}
        names = NameIndex(load_world(session["world"]), load_keys(session["world"]))
        names.scan(prompt.get("system", ""), ctx["n_of"], directory=True)
        for ti, turn in enumerate(session["turns"]):
            user = rt.req({"op": "user", "text": turn["user"]})
            transcript.compact(user.get("compacted") or [])
            transcript.user(turn["user"], user.get("block"))
            names.scan(user.get("block") or "", ctx["n_of"])
            steps = []
            # A RETRACTION ENDS THE TURN IN THE RUNTIME (`decline never_mind`, before any call): the step has
            # no model message and no model step is sent; the turn's ending is the runtime's own
            ended = user.get("ended")
            if ended:
                steps.append({"model": "", "response": slim(ended), "runtime": "never_mind"})
            retries = 0

            def execute(out: StepOut) -> dict:
                """Send the model's call to the runtime; record the step and extend the history."""
                sent = first_call(out["text"])
                resp = rt.req({"op": "call_text", "text": sent})
                eff = resp.get("effect") or {}
                for row in effect_rows(eff):
                    ctx["n_of"][row["id"]] = row["n"]
                names.scan(resp.get("text", ""), ctx["n_of"])
                if eff.get("created"):
                    ctx["last_created"] = eff["created"][-1]["n"]
                    ctx["created"] += [row["n"] for row in eff["created"]]
                result = eff.get("result") or (eff.get("answer") or {}).get("result")
                if result:
                    ctx["last_result"] = result
                transcript.assistant(sent)
                transcript.tool(resp.get("obs"), resp.get("text", ""))
                steps.append({"model": out["text"], "response": slim(resp), "think_cut": out.get("think_cut", False),
                              **{k: out[k] for k in ("resampled_from", "compile", "retry") if k in out}})
                return resp

            for si in range(0 if ended else STEP_CAP + 2):
                ctx.update(turn=ti, step=si)
                out = backend.step(transcript, ctx)
                out = break_loop(rt, backend, transcript, ctx, out)
                before = len(transcript.messages)
                resp = execute(out)
                if resp.get("ends_turn"):
                    break
                signal = retry_signal(resp) if retry_on else None
                if signal in retry_on and retries < retry_max:
                    kept = transcript.messages[before:]  # the failed call and its reply
                    del transcript.messages[before:]
                    try:
                        alt = backend.resample(transcript, ctx, first_call(out["text"]))
                    finally:
                        transcript.messages.extend(kept)
                    if alt is not None:
                        retries += 1
                        alt["retry"] = signal
                        if execute(alt).get("ends_turn"):
                            break
            record["turns"].append({"user": turn["user"], "preground": user.get("block"), "steps": steps})
    return record


def make_backend(args) -> Backend:
    if args.model == "ref":
        backend: Backend = RefBackend()
    elif args.model == "sonnet":
        backend = SonnetBackend(args.claude_model)
    elif args.model == "hf":
        backend = HFBackend(args.checkpoint)
    elif args.model == "replay":
        backend = ReplayBackend(args.replay)
    else:
        raise SystemExit(f"unknown model {args.model}")
    tools = args.tools or (os.environ.get("NATIVE_TOOLS") if args.model == "hf" else None)
    if tools:  # NATIVE_TOOLS: kernel.py's per-arm tools-block spelling (arm "free@sig")
        backend.tools_mode = tools
    return backend


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--set", required=True)
    parser.add_argument("--model", required=True, choices=["ref", "sonnet", "hf", "replay"])
    parser.add_argument("--out", required=True)
    parser.add_argument("--jobs", type=int, default=1)
    parser.add_argument("--only", help="comma list of session ids")
    parser.add_argument("--claude-model", default="sonnet")
    parser.add_argument("--checkpoint")
    parser.add_argument("--replay")
    parser.add_argument("--tools", choices=["sig", "compact", "full"],
                        help="override the backend's tools-block spelling (sonnet: full, hf: sig)")
    args = parser.parse_args()
    sessions = read_jsonl(args.set)
    if args.only:
        keep = set(args.only.split(","))
        sessions = [s for s in sessions if s["id"] in keep]
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    results: dict[str, dict] = {}

    def one(session):
        try:
            return run_session(session, make_backend(args))
        except Exception as error:  # noqa: BLE001
            return {"id": session["id"], "model": args.model, "error": repr(error), "turns": []}

    with cf.ThreadPoolExecutor(max_workers=args.jobs) as pool:
        for i, rec in enumerate(pool.map(one, sessions)):
            results[rec["id"]] = rec
            if rec.get("error"):
                print(f"[{i + 1}/{len(sessions)}] {rec['id']}: ERROR {rec['error']}", file=sys.stderr)
            else:
                n = sum(len(t["steps"]) for t in rec["turns"])
                print(f"[{i + 1}/{len(sessions)}] {rec['id']}: {len(rec['turns'])} turns, {n} steps",
                      file=sys.stderr, flush=True)
    with open(args.out, "w", encoding="utf-8") as handle:
        for session in sessions:
            handle.write(json.dumps(results[session["id"]], ensure_ascii=False) + "\n")
    counts = compile_counts(results.values())
    retried = retry_counts(results.values())
    if counts or retried:
        stats = {"sessions": len(results), **({"compile": counts} if counts else {}),
                 **({"retry": retried} if retried else {})}
        Path(args.out + ".stats.json").write_text(json.dumps(stats, indent=1))
    print(f"wrote {len(results)} sessions to {args.out}" + (f"; compile {json.dumps(counts)}" if counts else "")
          + (f"; retry {json.dumps(retried)}" if retried else ""))


if __name__ == "__main__":
    main()
