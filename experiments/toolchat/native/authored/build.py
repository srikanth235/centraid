"""Authored training data: seed each world, replay each session through the eval driver, keep the
sessions whose every turn scores as its gold, and emit training records (train == inference).

    python3 authored/build.py W01 W02 --out OUT [--split train] [--only SID,...] [--no-seed] [--gold-from-ref]
                              [--sessions-dir DIR] [--worlds-dir DIR]
                              [--augment FRAC --augment-seed N --augment-level light|heavy]

A world is authored/worlds/<W>.json (a household, seeded only through `nativetools seed`; `--no-seed`
reuses the vault already seeded); its sessions are authored/sessions/<W>.py in the eval gold vocabulary
(eval/gold.py); a ref call the runtime rejects is wrapped `bad(call)` (a repair trajectory; no loss on it).
`--sessions-dir` and `--worlds-dir` read the sessions and the worlds from other directories (the recipe-authored
sessions of A to D: eval/sessions/e1 and eval/worlds).
The `<think>` before each call is the slot trace of CONTRACT_V3.md (section 7, v3.1), written mechanically from the
call and the prompt in front of it (authored/trace.py), never authored: a row is its `#n`, a date the dates line reads
as exactly is `dates[i]`, a `where` is typed segments. The call is a deterministic rendering of its think
(the runtime's stateless compiler, `think.rs`): every record's call is rebuilt from its own think by the very function the decoder uses
(`fmt.call_of_think`), and a record whose compiled call differs from the authored call is refused with reason
`roundtrip` (reported like any other trace failure, the session left out). The arguments of a record are written in the
call order `trace.CALL_ORDER`, in the one spelling of the runtime's `compile` op (a `where` bare enum word is quoted).
`compile_replay` then replays the finished record against the runtime and sends the slots of every think (not a repair
call's) to the runtime's `{"op":"compile"}`: the call it states must be the record's call, else `roundtrip`; the count of
calls the grounding or a convention changes is reported (`compile_changed`). Per world the report gives, over the calls
that are not repair calls, how many refer to something and have every mention a pick (a `#n`, a `@k`, a `dates[i]`:
`anchored`), how many still type a name or a date (`free`), and how many refer to nothing (`none`); OUT/<W>.anchoring.json
holds the counts and each report entry has its own.
The finished records are then replayed through the runtime with their thinks in front of every call, so the
runtime's trace guard is checked on exactly the text trained on.

Replay is the eval driver's own `run_session` (same runtime, same Transcript, same compaction,
`$key` -> the `#n` the runtime showed), so the text trained on is exactly what the model sees at
inference. Per world it writes OUT/<W>.jsonl.gz (examples for train.py), OUT/<W>.report.json
(every session's verdict and problems: the author's feedback) and OUT/<W>.gold.jsonl.

A call that the runtime answers by ending the turn in a decline or an ask it composes itself (a restore past the
window, a delete the vault refuses, a write over the cap: `effect.composed`, D-1044-10) is not an error: the call is
right, the turn ends there, the reference calls after it are not sent, and a `bad` mark on it does not apply. The call
is trained, with or without `--gold-from-ref`.
The same holds for the asks, declines and answers the runtime composes at an ambiguous or unmatched write, a read whose
name reaches nothing and a refusal (`Flags.compose`, M1): the reference calls after that call are unreached, which is a
problem only when the sequence was heading for a write (`regen.composed_problems`, dropped as "reference unreached after
a composed end"). Each report entry lists such ends under `composed`; per world the counts of the kept sessions are
printed by convention (`composed-ask`, `composed-decline`, `composed-refusal`, `composed-answer`, `composed-apply`).
A write the runtime applies to the rows it chose (every row when the message says all, the one near spelling of a name,
the one row of another kind a name names: `composed-apply`, M1b and M1c) ends
the turn at the call too, and is no problem of its own: the old gold accepts that diff (explained, the gold unchanged),
or the turn fails its gold like any write (UNEXPLAINED under `--gold-from-ref`); a `bad` mark on such a call does not
apply when the gold accepts it.

`--gold-from-ref` (SPEC 13: gold is derived by running the reference calls through the runtime; D-1044-11: the
harness applies the conventions): a turn whose reference run fails its authored gold gets the accept derived from the
run instead, when a convention explains the change (eval/regen.py: status, what-else, ask-options, refusal, bulk-cap, container, status-words, next, last-one),
and a gold that still passes is tightened where a convention says it is a superseded reading. A change no convention
explains keeps the failing gold, so the session is dropped as it is without the flag. A `name-match` change is only
reported (the first call of the reference resolves a name and ends the turn on that row, where the authored chain
dead-ends on purpose, so the derived effect may be the wrong answer): the turn keeps its gold and the session is
dropped, listed under "name-match, dropped"; the reference calls are repaired at the source.
OUT/<W>.gold.jsonl carries the regenerated gold (`build_sets.py trainfit --train-gold` and authored/dist.py read it);
each report entry gets a `changes` list (turn, convention, old and new gold, evidence); per world the counts of
sessions kept, dropped (and why) and turns changed by convention are printed. Without the flag the gold stays as
authored.
`--augment FRAC` (default 0: off) puts message noise (authored/noise.py: typos, dropped words, autocorrect artefacts, name
typos the runtime's near-spelling fallback reaches) on the user message of a FRAC share of the turns of the sessions that
verify, before the session is replayed, so the trace and the observations are rendered from the noisy message and the gold
is the gold of the clean session: the noisy session must verify like the clean one, and with `--gold-from-ref` every turn's
derived gold must equal the clean turn's. A turn whose replay then fails (the gold, the trace, the guard, the compile
round trip, a reference call that needs a row the noisy message no longer grounds) is put back as it was, the latest turn
that could have caused the first failure first, and the session replayed again; the clean turn stays in the data, and the
ops of the turns put back are counted by label (`<W>.augment.json`, the `augment` key of a report entry, the line printed
per world). A session with a noisy turn left carries the tag `augmented` (its record, its gold line) and each such turn
`noise: {level, ops, clean}` in the gold file (the message there is the one the record was built from). `--augment-seed`
and `--augment-level` pick the draws (noise.plan_turns: the same seed gives the same plan in eval/perturb.py).
Worlds are independent: one process per world may run at once into one OUT (each world seeds its own vault under
EVAL_VAULTS and writes its own files).
"""
from __future__ import annotations

import argparse
import collections
import copy
import gzip
import importlib.util
import json
import os
import re
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
NATIVE = HERE.parent
os.environ.setdefault("EVAL_WORLDS", str(HERE / "worlds"))
os.environ.setdefault("EVAL_VAULTS", "/tmp/nativetools-authored/vaults")
sys.path[:0] = [str(NATIVE / "eval"), str(NATIVE / "train"), str(NATIVE)]

import fmt  # noqa: E402  (train/fmt.py: the function the decoder renders a call with, and the loader of authored/trace.py)
import noise  # noqa: E402  (authored/noise.py: message noise, for --augment)
import gold  # noqa: E402
import lib  # noqa: E402
import regen  # noqa: E402
import run  # noqa: E402
import score  # noqa: E402
from lib import NT, Runtime  # noqa: E402
import render  # noqa: E402
from hf_backend import assistant_record  # noqa: E402

TOOLS_MODE = "sig"  # the fine-tuned model's prompt (what train.py and the hf eval use)


def seed(w: str, worlds_dir: Path = HERE / "worlds") -> None:
    out = Path(os.environ["EVAL_VAULTS"]) / w
    subprocess.run(["rm", "-rf", str(out)], check=True)
    out.mkdir(parents=True)
    proc = subprocess.run([NT, "seed", str(worlds_dir / f"{w}.json"), str(out / "vault")],
                          capture_output=True, text=True)
    if proc.returncode:
        raise SystemExit(f"seed {w} failed: {proc.stderr[-2000:]}")
    rep = json.loads(proc.stdout)
    keys_path = worlds_dir / f"{w}.keys.json"  # the committed formatting; written only when the content differs
    text = json.dumps(rep["keys"], indent=2, sort_keys=True) + "\n"
    if not keys_path.exists() or json.loads(keys_path.read_text()) != rep["keys"]:
        keys_path.write_text(text)
    for drop in rep.get("dropped", []):
        print(f"{w}: dropped {json.dumps(drop, ensure_ascii=False)}", file=sys.stderr)


def load_sessions(w: str, sessions_dir: Path = HERE / "sessions") -> list[dict]:
    """sessions/<W>.py (it calls `world(...)`), then sessions/<W>_*.py in name order."""
    gold._SESSIONS.clear()
    files = [sessions_dir / f"{w}.py"] + sorted(sessions_dir.glob(f"{w}_*.py"))
    for f in files:
        spec = importlib.util.spec_from_file_location(f"authored_{f.stem}", f)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
    ids = [s["id"] for s in gold.sessions()]
    dup = {i for i in ids if ids.count(i) > 1}
    if dup:
        raise SystemExit(f"{w}: duplicate session ids {sorted(dup)}")
    return [dict(s) for s in gold.sessions()]


class ThinkRef(run.RefBackend):
    """The reference calls, each behind an empty `<think>` block; keeps the transcript. The think of a record is
    written afterwards by authored/trace.py (`records`): it needs the calls still to come in the turn, so it
    cannot be written step by step. An empty think carries no trace, so the runtime's trace guard stays out of
    this first replay. `bad=True` on a reference call means the runtime is expected to reject it (a repair
    trajectory); the call right after it is a retry."""

    name = "authored"
    tools_mode = TOOLS_MODE

    def step(self, transcript, ctx):
        self.transcript = transcript
        try:
            out = super().step(transcript, ctx)
        except Exception as e:
            e.turn = ctx["turn"] + 1  # which turn it was, for --augment's put-back
            raise
        if ctx["step"] < len(self.session["turns"][ctx["turn"]]["ref"]):
            out["text"] = "<think>\n\n</think>\n\n" + out["text"]
        return out


def today_of(system: str) -> str | None:
    m = re.search(r"today: \w+ (\d{4}-\d\d-\d\d)", system)
    return m.group(1) if m else None


def replay_summary(rec: dict) -> list[dict]:
    """Per turn, what the runtime showed the model during replay (for coverage.py): an
    `ambiguous:` observation, an empty-result recovery, a rejected call."""
    out = []
    for t in rec["turns"]:
        texts = [st["response"].get("text", "") for st in t["steps"]]
        effects = [st["response"].get("effect") or {} for st in t["steps"]]
        out.append({"ambiguous": any("ambiguous" in e or x.startswith("ambiguous") for e, x in zip(effects, texts)),
                    "recovery": sorted({str(e["recovery"]) for e in effects if e.get("recovery")}),
                    "rejected": any(e.get("error") or x.startswith("error") for e, x in zip(effects, texts)),
                    # per call, the runtime's error line ("" when accepted): tells a vault refusal
                    # ("... was refused: ...", the restore window) from a malformed call
                    "errors": [(x if x.startswith("error") else str(e.get("error") or ""))[:240]
                               if (e.get("error") or x.startswith("error")) else "" for e, x in zip(effects, texts)],
                    # per call, the kinds a write changed (links: the member moved), for verb × kind
                    "act_kinds": [sorted({l["to"]["kind"] for l in (e.get("diff") or {}).get("links", [])}
                                         if e.get("verb") in ("add_to", "remove_from") and (e.get("diff") or {}).get("links")
                                         else {r["kind"] for r in (e.get("diff") or {}).get("rows", []) if r.get("kind")})
                                  for e in effects]})
    return out


def system_record(session: dict) -> dict:
    with Runtime(session["world"], session["today"], session["me"], flags=["--tools", TOOLS_MODE]) as rt:
        p = rt.req({"op": "prompt"})
    return {"role": "system", "content": p["system"], "tools": p["tools"]}


def records(session: dict, transcript, unmarked: frozenset | set = frozenset()) -> list[dict]:
    sysrec = system_record(session)
    head = render.render([sysrec])[0]
    if head != transcript.system_rendered:
        raise AssertionError("system record does not render as the eval transcript's system block")
    # a turn may end before its reference calls do (the runtime resolves a name at the first call, or composes the
    # outcome of a refusal), so the marks are looked up per turn: the k-th call of turn t is ref[k] of turn t
    bad = [[c.get("bad", False) for c in t["ref"]] for t in session["turns"]]
    msgs, turn, step = [sysrec], -1, 0
    for m in transcript.messages:
        if m["role"] == "user":
            turn, step = turn + 1, 0
            msgs.append({"role": "user", "content": render.user_content(m["text"], m.get("preground"))})
        elif m["role"] == "assistant":
            rec = assistant_record(m["content"])
            if rec is None:
                raise AssertionError(f"assistant message is not one think + one call: {m['content'][:200]!r}")
            if step < len(bad[turn]) and bad[turn][step] and (turn, step) not in unmarked:
                rec["loss"] = False
            step += 1
            msgs.append(rec)
        else:
            msgs.append({"role": "tool", "content": m["content"]})
    while msgs[-1]["role"] == "tool":
        msgs.pop()
    # The trace is written from the context as the record shows it (tool replies as finally compacted),
    # so a record's think is always rebuildable from the messages before it.
    T = fmt.trace3()
    try:
        traces = T.trace_messages3(msgs, today_of(sysrec["content"]))
    except T.TraceError as e:
        e.turn = trace_turn(T, msgs, today_of(sysrec["content"]))
        raise
    for i, tr in traces.items():
        m = msgs[i]
        m["think"] = T.render3(tr.slots)
        m["args"] = tr.call["args"]
        if fmt.call_of_think(m["think"], T.dates_line_of(msgs[:i]), "v3.1") != render.call_text(m["tool"], m["args"]):
            err = T.TraceError("roundtrip", "decoder rendering differs: " + m["think"][:80].replace("\n", " | "))
            err.turn = sum(1 for x in msgs[:i + 1] if x["role"] == "user")
            raise err
    return msgs


def trace_turn(T, msgs: list[dict], today: str | None) -> int | None:
    """The 1-based turn of the first call the trace refuses: the shortest run of whole turns that already fails."""
    starts = [i for i, m in enumerate(msgs) if m["role"] == "user"]
    for k in range(1, len(starts) + 1):
        try:
            T.trace_messages3(msgs[:starts[k] if k < len(starts) else len(msgs)], today)
        except T.TraceError:
            return k
    return None


def anchoring(msgs: list[dict]) -> dict:
    """Over the calls of a record that are not repair calls: how many refer to something with every mention a pick
    (`anchored`), how many type a name or a date (`free`), how many refer to nothing (`none`), and the dates picked and typed."""
    T = fmt.trace3()
    out = collections.Counter()
    for m in msgs:
        if m["role"] == "assistant" and m.get("loss") is not False:
            ms = T.mentions(m["tool"], m["args"], T.parse3(m["think"]))
            out[ms["class"]] += 1
            out["calls"] += 1
            out["rows"] += ms["rows"]
            out["names_typed"] += ms["names"]
            out["dates_picked"] += ms["dates_anchored"]
            out["dates_typed"] += ms["dates_free"]
    return dict(out)


def compile_replay(session: dict, msgs: list[dict]) -> tuple[list[dict], int]:
    """Replay a finished record against the runtime and ask its `compile` op for the call of every think (a repair call's
    excepted): the call it states (`stated`) must be the record's call. Returns the problems (trace reason `roundtrip`) and
    the number of calls the grounding or a convention then changes (`call` differs from `stated`)."""
    T = fmt.trace3()
    turns: list[list[dict]] = []
    for m in msgs:
        if m["role"] == "user":
            turns.append([])
        elif m["role"] == "assistant":
            turns[-1].append(m)
    problems, changed = [], 0
    with Runtime(session["world"], session["today"], session["me"], tmp_root=run.TMP, flags=["--tools", TOOLS_MODE]) as rt:
        rt.req({"op": "prompt"})
        for ti, turn in enumerate(session["turns"]):
            rt.req({"op": "user", "text": turn["user"]})
            for si, m in enumerate(turns[ti] if ti < len(turns) else []):
                if m.get("loss") is not False:
                    try:
                        reply = rt.req({"op": "compile", "slots": T.slots_json(T.parse3(m["think"]))})
                    except (T.CompileError, ValueError) as e:
                        reply = {"refused": {"slot": "think", "why": str(e)}}
                    if "refused" in reply:
                        problems.append({"trace": "roundtrip", "detail": f"turn {ti + 1} call {si + 1}: compile refused {reply['refused']['slot']}: {reply['refused']['why']}"[:300]})
                    elif not T.same_call(T.runtime_call(reply, "stated"), {"tool": m["tool"], "args": m["args"]}):
                        problems.append({"trace": "roundtrip", "detail": f"turn {ti + 1} call {si + 1}: compile states {json.dumps(reply['stated'], ensure_ascii=False)[:150]} != the call"})
                    else:
                        changed += not T.same_call(T.runtime_call(reply, "call"), T.runtime_call(reply, "stated"))
                resp = rt.req({"op": "call_text", "text": lib.first_call(f"<think>\n{m['think']}\n</think>\n\n" + run.format_call(m["tool"], m["args"]))})
                if resp.get("ends_turn"):
                    break
    return problems, changed


class RecordedCalls(run.Backend):
    """Sends the assistant messages of a finished record, think and all, exactly as trained."""

    name = "recorded"
    tools_mode = TOOLS_MODE
    runtime_flags = ["--no-normalize"]  # the replay of the author's calls, bad steps included, as ThinkRef ran them

    def __init__(self, msgs: list[dict]):
        turns: list[list[dict]] = []
        for m in msgs:
            if m["role"] == "user":
                turns.append([])
            elif m["role"] == "assistant":
                turns[-1].append(m)
        self.turns = turns

    def step(self, transcript, ctx):
        calls = self.turns[ctx["turn"]]
        if ctx["step"] >= len(calls):
            return run.StepOut(text="(recorded sequence exhausted)", think_cut=False)
        m = calls[ctx["step"]]
        return run.StepOut(text=f"<think>\n{m['think']}\n</think>\n\n" + run.format_call(m["tool"], m["args"]), think_cut=False)


GUARD_MARK = "contradicts the call"  # the runtime's trace guard error (crates/assist/src/native/trace.rs)


def guard_replay(session: dict, msgs: list[dict], unmarked: frozenset | set = frozenset()) -> list[dict]:
    """Replay a finished record through the runtime: every call that is not a marked repair call must be
    accepted with its trace in front of it (a guard rejection of a gold call is a false rejection)."""
    rec = run.run_session(session, RecordedCalls(msgs))
    problems = []
    for ti, t in enumerate(rec["turns"]):
        for si, st in enumerate(t["steps"]):
            ref = session["turns"][ti]["ref"]
            text = st["response"].get("text", "")
            marked = si < len(ref) and ref[si].get("bad", False) and (ti, si) not in unmarked
            if GUARD_MARK in text:
                problems.append({"turn": ti + 1, "user": t["user"], "problems": [f"guard false rejection, call {si + 1}: {text[:200]}"]})
            elif (bool((st["response"].get("effect") or {}).get("error")) or text.startswith("error")) != marked:
                problems.append({"turn": ti + 1, "user": t["user"], "problems": [f"call {si + 1} with its trace: runtime outcome differs from the plain replay: {text[:200]}"]})
    return problems


def why_dropped(entry: dict) -> str:
    """Why a session did not verify, from its problems: the first of error, trace, an unmarked or wrongly marked
    call, an UNEXPLAINED gold change, a name-match, the trace guard, a turn that fails its gold."""
    texts = [t for p in entry["problems"] for t in p.get("problems", [])]
    if any("error" in p for p in entry["problems"]):
        return "error"
    traces = [p["trace"] for p in entry["problems"] if "trace" in p]
    if traces:
        return f"trace {traces[0]}"
    for needle, label in (("it but it is not marked bad", "reference call rejected, not marked bad"),
                          ("it but it is marked bad", "marked bad call accepted"),
                          ("are unreached after the runtime's", "reference unreached after a composed end"),
                          ("gold-from-ref: UNEXPLAINED", "gold change no convention explains"),
                          ("gold-from-ref: name-match", "name-match, dropped"),
                          ("guard false rejection", "trace guard rejected a call"),
                          ("differs from the plain replay", "trace guard replay differs")):
        if any(needle in t for t in texts):
            return label
    return "gold fails"


def regen_line(w: str, report: list[dict]) -> str:
    """The counts of a --gold-from-ref build of one world: sessions kept and dropped (and why), turns changed, the
    name-match turns that were only reported."""
    kept = [r for r in report if r["pass"]]
    drops = collections.Counter(why_dropped(r) for r in report if not r["pass"])
    by_kept = collections.Counter(c["convention"] for r in kept for c in r.get("changes", []) if c["applied"])
    by_all = collections.Counter(c["convention"] for r in report for c in r.get("changes", []) if c["applied"])
    held = [f"{r['id']} t{c['turn']}" for r in report for c in r.get("changes", []) if c["held"]]
    return (f"{w}: gold-from-ref: kept {len(kept)}, dropped {len(report) - len(kept)} {dict(sorted(drops.items()))}; "
            f"turns changed by convention in the kept sessions {dict(sorted(by_kept.items()))} "
            f"({sum(by_kept.values())}), in all sessions {sum(by_all.values())}"
            + (f"; name-match, reported only: {', '.join(held)}" if held else ""))


def verify_session(s: dict, gold_from_ref: bool, holder: dict) -> dict:
    """The verification of one session: replay its reference calls, derive the gold (`--gold-from-ref`), check the marks, the
    composed ends, the trace, the guard and the compile round trip. `holder["s"]` always holds the latest form of the
    session (the one with the regenerated gold). Exceptions propagate. Returns what the build loop writes:
    {s, ok, problems, changes, ends, msgs, changed, trace_turn}."""
    b = ThinkRef()
    changes: list[dict] = []
    trace_at = None
    rec = run.run_session(s, b)
    s["replay"] = replay_summary(rec)
    if gold_from_ref:
        s, changes = regen.regen_session(s, rec)
        holder["s"] = s
    unmarked = regen.composed_marks(s, rec)  # calls marked bad that the runtime answered, or wrote, itself
    sc = score.score([rec], [s])["sessions"][0]
    problems = [{"turn": i + 1, "user": s["turns"][i]["user"], "problems": t["problems"]}
                for i, t in enumerate(sc["turns"]) if not t["pass"]]
    for c in changes:  # the gold of an UNEXPLAINED or name-match turn stayed as authored: it fails it
        if not c["applied"]:
            tag, why = ("name-match", c["evidence"]) if c["held"] else (regen.UNEXPLAINED, c["note"])
            for p in problems:
                if p["turn"] == c["turn"]:
                    p["problems"] = p["problems"] + [f"gold-from-ref: {tag}, {why}"]
    # a rejected call must be followed by its repair: every bad call is marked,
    # and every unmarked call must be accepted by the runtime
    for ti, t in enumerate(rec["turns"]):
        for si, st in enumerate(t["steps"]):
            ref = s["turns"][ti]["ref"]
            is_err = bool((st["response"].get("effect") or {}).get("error")) or \
                st["response"].get("text", "").startswith("error")
            marked = si < len(ref) and ref[si].get("bad", False) and (ti, si) not in unmarked
            if is_err != marked:
                problems.append({"turn": ti + 1, "user": t["user"], "problems": [
                    f"call {si + 1}: runtime {'rejected' if is_err else 'accepted'} it but it is "
                    f"{'not ' if not marked else ''}marked bad: {st['response'].get('text', '')[:200]}"]})
    # the reference calls after a call the runtime ended the turn at by composing the outcome are not
    # sent: no problem when it is of the kind the sequence was heading for, and none for a write it applied to
    # the rows it chose (the gold judges that: eval/regen.py `composed_problems`)
    problems += regen.composed_problems(s, rec)
    ends = regen.composed_ends(s, rec)
    ok = not problems
    msgs = None
    if ok:
        try:
            msgs = records(s, b.transcript, unmarked)
        except fmt.trace3().TraceError as e:
            problems.append({"trace": e.reason, "detail": e.detail})
            trace_at = getattr(e, "turn", None)
            ok = False
    if ok:
        problems += guard_replay(s, msgs, unmarked)
        ok = not problems
    changed = 0
    if ok:
        cproblems, changed = compile_replay(s, msgs)
        problems += cproblems
        ok = not problems
    return {"s": s, "ok": ok, "problems": problems, "changes": changes, "ends": ends, "msgs": msgs, "changed": changed,
            "trace_turn": trace_at}


# ---- --augment: message noise on a share of the turns, put back where the replay refuses it

def canon_gold(turn: dict) -> str:
    return json.dumps(turn["gold"], sort_keys=True, ensure_ascii=False)


def implicated_turns(problems: list[dict], trace_at: int | None = None) -> list[int]:
    """The 0-based turns a failed verification names: a score, guard or composed problem has its `turn`, a compile problem
    says `turn N call M`, a trace error is placed by `trace_turn`."""
    out = set()
    for p in problems:
        if isinstance(p.get("turn"), int):
            out.add(p["turn"] - 1)
        elif m := re.search(r"\bturn (\d+)\b", p.get("detail", "")):
            out.add(int(m.group(1)) - 1)
    if trace_at:
        out.add(trace_at - 1)
    return sorted(out)


def put_back_which(chosen: dict[int, dict], bad: list[int]) -> int:
    """The noisy turn to put back after a failure that first shows at turn `bad[0]` (`noise.put_back_which`)."""
    return noise.put_back_which(chosen, bad)


def noisy_copy(base: dict, chosen: dict[int, dict]) -> dict:
    s = copy.deepcopy(base)
    for ti, p in chosen.items():
        s["turns"][ti]["user"] = p["text"]
        s["turns"][ti]["noise"] = {"level": p["level"], "ops": p["ops"], "clean": p["clean"]}
    s["tags"] = list(s.get("tags", [])) + ["augmented"]
    return s


def augment_session(base: dict, clean: dict, plan: dict[int, dict], gold_from_ref: bool,
                    verify=verify_session) -> tuple[dict, dict]:
    """The session `base` (as authored, `clean` its verification) with the noise of `plan` on its turns, each turn that the
    replay refuses put back clean. Returns (the verification to write, {"kept": {turn: plan entry}, "dropped": [(turn, plan
    entry, why)]}). Nothing is left noisy -> `clean` itself. `verify(s, gold_from_ref, holder)` is `verify_session`."""
    chosen = dict(plan)
    dropped: list[tuple[int, dict, str]] = []
    clean_gold = [canon_gold(t) for t in clean["s"]["turns"]]
    while chosen:
        s_try = noisy_copy(base, chosen)
        holder = {"s": s_try}
        try:
            res = verify(s_try, gold_from_ref, holder)
        except Exception as e:  # noqa: BLE001
            bad = [e.turn - 1] if isinstance(getattr(e, "turn", None), int) else []
            why = f"error: {type(e).__name__}"
        else:
            if res["ok"]:
                moved = [ti for ti, t in enumerate(res["s"]["turns"]) if canon_gold(t) != clean_gold[ti]]
                if not moved:
                    return res, {"kept": chosen, "dropped": dropped}
                bad, why = moved, "gold changed"
            else:
                bad, why = implicated_turns(res["problems"], res.get("trace_turn")), why_dropped({"problems": res["problems"]})
        ti = put_back_which(chosen, bad)
        dropped.append((ti, chosen.pop(ti), why))
    return clean, {"kept": {}, "dropped": dropped}


def augment_summary(w: str, args, stats: dict) -> str:
    kept, dropped = stats["kept"], stats["dropped"]
    return (f"{w}: augment {args.augment} {args.augment_level} (seed {args.augment_seed}): {stats['turns']} turns of "
            f"{stats['sessions']} verified sessions, {stats['planned']} with noise planned, {sum(stats['turns_kept'].values())} kept, "
            f"{sum(stats['turns_dropped'].values())} put back clean; ops kept {dict(sorted(kept.items()))}, put back "
            f"{dict(sorted(dropped.items()))}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("worlds", nargs="+")
    ap.add_argument("--out", required=True)
    ap.add_argument("--split", default="train")
    ap.add_argument("--only")
    ap.add_argument("--no-seed", action="store_true")
    ap.add_argument("--gold-from-ref", action="store_true",
                    help="the gold of a turn is what the runtime does with its reference calls, when a convention "
                         "explains the change (eval/regen.py); an unexplained change drops the session")
    ap.add_argument("--sessions-dir", type=Path, default=HERE / "sessions",
                    help="where <W>.py and <W>_*.py are (default authored/sessions)")
    ap.add_argument("--worlds-dir", type=Path, default=HERE / "worlds",
                    help="where <W>.json is (default authored/worlds)")
    ap.add_argument("--augment", type=float, default=0.0, metavar="FRAC",
                    help="message noise on this share of the turns of the sessions that verify (default 0: off); a turn "
                         "whose replay then fails is put back clean and counted by op")
    ap.add_argument("--augment-seed", type=int, default=0, help="the seed of the draws (the same plan as eval/perturb.py --seed)")
    ap.add_argument("--augment-level", choices=noise.LEVELS, default="light", help="light: one op per turn, heavy: two or three")
    a = ap.parse_args()
    if not 0.0 <= a.augment <= 1.0:
        raise SystemExit("--augment must be between 0 and 1")
    if a.worlds_dir != HERE / "worlds":
        lib.WORLDS = a.worlds_dir  # lib.world_dir reads it when a world is loaded
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    for w in a.worlds:
        if not a.no_seed:
            seed(w, a.worlds_dir)
        sessions = load_sessions(w, a.sessions_dir)
        if a.only:
            keep = set(a.only.split(","))
            sessions = [s for s in sessions if s["id"] in keep]
        world = lib.load_world(w) if a.augment > 0 else None
        names = noise.names_index(noise.names_of_world(world)) if a.augment > 0 else None
        keys = noise.key_names(world) if a.augment > 0 else None
        report, n_ok = [], 0
        anch, changed_total, past = collections.Counter(), 0, collections.Counter()
        aug = {"sessions": 0, "turns": 0, "planned": 0, "kept": collections.Counter(), "dropped": collections.Counter(),
               "turns_kept": collections.Counter(), "turns_dropped": collections.Counter(), "why": collections.Counter(),
               "errors": [], "examples": {"kept": {}, "dropped": {}}}
        with gzip.open(out / f"{w}.jsonl.gz", "wt") as fh, open(out / f"{w}.gold.jsonl", "w") as gf:
            for s in sessions:
                s["set"] = a.split
                base = copy.deepcopy(s) if a.augment > 0 else None
                holder = {"s": s}
                try:
                    res = verify_session(s, a.gold_from_ref, holder)
                    note = None
                    if a.augment > 0 and res["ok"]:
                        plan = noise.plan_turns(base, names, a.augment, a.augment_seed, a.augment_level, keys=keys)
                        aug["sessions"] += 1
                        aug["turns"] += len(base["turns"])
                        aug["planned"] += len(plan)
                        if plan:
                            try:
                                res, note = augment_session(base, res, plan, a.gold_from_ref)
                            except Exception as e:  # noqa: BLE001  (a failure of the augmentation never costs the clean session)
                                aug["errors"].append(f"{base['id']}: {e!r}"[:300])
                                note = None
                            holder["s"] = res["s"]
                            for ti, p in note["kept"].items():
                                aug["turns_kept"][a.augment_level] += 1
                                for op in p["ops"]:
                                    aug["kept"][noise.label(op)] += 1
                                    aug["examples"]["kept"].setdefault(noise.label(op), []).append(
                                        {"id": base["id"], "turn": ti + 1, "clean": p["clean"], "noisy": p["text"]})
                            for ti, p, why in note["dropped"]:
                                aug["turns_dropped"][a.augment_level] += 1
                                aug["why"][why] += 1
                                for op in p["ops"]:
                                    aug["dropped"][noise.label(op)] += 1
                                    aug["examples"]["dropped"].setdefault(noise.label(op), []).append(
                                        {"id": base["id"], "turn": ti + 1, "why": why, "clean": p["clean"], "noisy": p["text"]})
                    s, ok, problems, changes, ends, msgs, changed = (res[k] for k in ("s", "ok", "problems", "changes", "ends", "msgs", "changed"))
                    if ok:
                        fh.write(json.dumps({"id": f"{a.split}-{s['id']}", "split": a.split, "world": w,
                                             "today": s["today"], "me": s["me"], "tools_mode": TOOLS_MODE,
                                             "messages": msgs, "n_turns": len(s["turns"]), "tags": s.get("tags", []),
                                             "source": "authored"}, ensure_ascii=False) + "\n")
                        n_ok += 1
                    entry = {"id": s["id"], "pass": ok, "problems": problems}
                    if ends:
                        entry["composed"] = [{k: e[k] for k in ("turn", "step", "convention", "unreached", "heading",
                                                                "explained")} for e in ends]
                    if ok:
                        entry["anchoring"] = anchoring(msgs)
                        entry["compile_changed"] = changed
                        anch.update(entry["anchoring"])
                        changed_total += changed
                        for e in ends:
                            past[e["convention"]] += 1
                            past["unreached calls"] += e["unreached"]
                    if changes:
                        entry["changes"] = [{"turn": c["turn"], "convention": c["convention"], "applied": c["applied"],
                                             "held": c["held"], "was_failing": c["was_failing"],
                                             "evidence": c["evidence"] or c["note"],
                                             "old_gold": regen.show_gold(c["old_gold"]),
                                             "new_gold": regen.show_gold(c["new_gold"]),
                                             "carried": c["carried"], "dropped": c["dropped"]} for c in changes]
                    if note:
                        entry["augment"] = {
                            "kept": [{"turn": ti + 1, "ops": [noise.label(o) for o in p["ops"]]} for ti, p in sorted(note["kept"].items())],
                            "put_back": [{"turn": ti + 1, "ops": [noise.label(o) for o in p["ops"]], "why": why}
                                         for ti, p, why in note["dropped"]]}
                    report.append(entry)
                except Exception as e:  # noqa: BLE001
                    report.append({"id": s["id"], "pass": False, "problems": [{"error": repr(e)[:400]}]})
                gf.write(json.dumps(holder["s"], ensure_ascii=False) + "\n")
        (out / f"{w}.report.json").write_text(json.dumps(report, indent=1, ensure_ascii=False))
        print(f"{w}: {n_ok}/{len(sessions)} sessions verified -> {out / (w + '.jsonl.gz')}", file=sys.stderr)
        stat = dict(sorted(anch.items()), compile_changed=changed_total)
        (out / f"{w}.anchoring.json").write_text(json.dumps(stat, indent=1))
        print(f"{w}: calls {anch['calls']}: anchored {anch['anchored']}, free {anch['free']}, none {anch['none']}; "
              f"rows picked {anch['rows']}, names typed {anch['names_typed']}, dates picked {anch['dates_picked']}, "
              f"dates typed {anch['dates_typed']}; compile changed by grounding or a convention {changed_total}", file=sys.stderr)
        print(f"{w}: composed past, in the kept sessions: "
              f"{ {name: past[name] for name in regen.COMPOSED_NAMES} } ({past['unreached calls']} reference calls "
              f"unreached)", file=sys.stderr)
        if a.gold_from_ref:
            print(regen_line(w, report), file=sys.stderr)
        if a.augment > 0:
            for key in ("kept", "dropped", "turns_kept", "turns_dropped", "why"):
                aug[key] = dict(sorted(aug[key].items()))
            for kind in ("kept", "dropped"):  # a few examples of each op, enough to read
                aug["examples"][kind] = {label: ex[:4] for label, ex in sorted(aug["examples"][kind].items())}
            aug.update(frac=a.augment, seed=a.augment_seed, level=a.augment_level)
            (out / f"{w}.augment.json").write_text(json.dumps(aug, indent=1, ensure_ascii=False))
            print(augment_summary(w, a, aug), file=sys.stderr)


if __name__ == "__main__":
    main()
