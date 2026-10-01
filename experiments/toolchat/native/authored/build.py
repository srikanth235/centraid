"""Authored training data: seed each world, replay each session through the eval driver, keep the
sessions whose every turn scores as its gold, and emit training records (train == inference).

    python3 authored/build.py W01 W02 --out OUT [--split train] [--only SID,...] [--trace v1|v2]

A world is authored/worlds/<W>.json (a household, seeded only through `nativetools seed`); its
sessions are authored/sessions/<W>.py in the eval gold vocabulary (eval/gold.py); a ref call the
runtime rejects is wrapped `bad(call)` (a repair trajectory; no loss on it). The `<think>` line
before each call is derived from the call's own fields (`derive_think`), never authored.
`--trace v2` writes the forward slot trace of CONTRACT_V2 §2 instead (authored/trace.py: intent, verb,
scope, refer, target, when, pick), then replays the finished records through the runtime with that trace
in front of every call, so the runtime's trace guard is checked on exactly the text trained on; a session
whose call cannot be traced is reported with its reason and left out. The default stays the old line.

Replay is the eval driver's own `run_session` (same runtime, same Transcript, same compaction,
`$key` -> the `#n` the runtime showed), so the text trained on is exactly what the model sees at
inference. Per world it writes OUT/<W>.jsonl.gz (examples for train.py), OUT/<W>.report.json
(every session's verdict and problems: the author's feedback) and OUT/<W>.gold.jsonl.
"""
from __future__ import annotations

import argparse
import gzip
import importlib.util
import datetime
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
NATIVE = HERE.parent
os.environ.setdefault("EVAL_WORLDS", str(HERE / "worlds"))
os.environ.setdefault("EVAL_VAULTS", "/tmp/nativetools-authored/vaults")
sys.path[:0] = [str(NATIVE / "eval"), str(NATIVE / "train"), str(NATIVE)]

import conventions  # noqa: E402
import gold  # noqa: E402
import run  # noqa: E402
import score  # noqa: E402
from lib import NT, Runtime  # noqa: E402
import render  # noqa: E402
from hf_backend import assistant_record  # noqa: E402

TOOLS_MODE = "sig"  # the fine-tuned model's prompt (what train.py and the hf eval use)
TRACE = "v1"  # which `<think>` the records carry: v1 (derive_think) or v2 (authored/trace.py); set by --trace


def _load_trace():
    """authored/trace.py by path (the name `trace` is also a standard-library module), loaded once."""
    if "authored_trace" not in sys.modules:
        spec = importlib.util.spec_from_file_location("authored_trace", HERE / "trace.py")
        mod = importlib.util.module_from_spec(spec)
        sys.modules["authored_trace"] = mod
        spec.loader.exec_module(mod)
    return sys.modules["authored_trace"]


def seed(w: str) -> None:
    out = Path(os.environ["EVAL_VAULTS"]) / w
    subprocess.run(["rm", "-rf", str(out)], check=True)
    out.mkdir(parents=True)
    proc = subprocess.run([NT, "seed", str(HERE / "worlds" / f"{w}.json"), str(out / "vault")],
                          capture_output=True, text=True)
    if proc.returncode:
        raise SystemExit(f"seed {w} failed: {proc.stderr[-2000:]}")
    rep = json.loads(proc.stdout)
    (HERE / "worlds" / f"{w}.keys.json").write_text(json.dumps(rep["keys"], indent=0, sort_keys=True) + "\n")
    for drop in rep.get("dropped", []):
        print(f"{w}: dropped {json.dumps(drop, ensure_ascii=False)}", file=sys.stderr)


def load_sessions(w: str) -> list[dict]:
    """sessions/<W>.py (it calls `world(...)`), then sessions/<W>_*.py in name order."""
    gold._SESSIONS.clear()
    files = [HERE / "sessions" / f"{w}.py"] + sorted((HERE / "sessions").glob(f"{w}_*.py"))
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
    """The reference calls; keeps the transcript. The `<think>` line before each call is derived
    mechanically from the call's own fields (`derive_think`), never authored as prose by a model
    -- no model's reasoning stands in for Qwen's. `bad=True` on a reference call means the runtime
    is expected to reject it (a repair trajectory); the call right after it is a retry."""

    name = "authored"
    tools_mode = TOOLS_MODE

    def step(self, transcript, ctx):
        self.transcript = transcript
        out = super().step(transcript, ctx)
        calls = self.session["turns"][ctx["turn"]]["ref"]
        if ctx["step"] < len(calls):
            retry = ctx["step"] > 0 and calls[ctx["step"] - 1].get("bad", False)
            think = derive_think(calls[ctx["step"]], retry, transcript.messages, today_of(transcript.system_rendered))
            out["text"] = f"<think>\n{think}\n</think>\n\n" + out["text"]
        return out


ROW = re.compile(r"#(\d+)(?: \[\d+\])? ([a-z ]+?) \"([^\"]+)\"")
ISO = re.compile(r"\d{4}-\d\d-\d\d(?:T(\d\d:\d\d))?")
NAME_STOP = {"the", "and", "for", "with", "from", "my", "our", "new", "old", "day", "trip", "list"}
DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]
# what each §14 convention decides, in a few fixed words (SPEC §8.13 / §14)
RULE_TEXT = {"next_weekday": "next weekday = that day of next week", "weekend": "weekend = coming sat-sun",
             "week": "weeks start monday", "at_n": "at N = evening after a meal, else 1-7 pm",
             "last_month_name": "last month name = most recent finished one", "bare_weekday": "weekday = next one, today counts",
             "diary": "diary = calendar", "wifi": "wifi password = a read, not a reveal",
             "balance": "balance above 0 = they owe me"}
DATE_RULES = {"next_weekday", "weekend", "week", "at_n", "last_month_name", "bare_weekday"}


def name_tokens(text: str) -> set[str]:
    return {w for w in re.findall(r"[a-z0-9]+", text.lower()) if len(w) >= 3 and w not in NAME_STOP}


def view(history: list[dict]) -> tuple[str, dict[int, str], list[int]]:
    """What the model can read when it writes a call: the current message, every row line still in
    the context (vault blocks and uncompacted runtime replies), and the rows of the latest reply.
    Works on eval transcripts (user text/preground kept apart) and on training records alike."""
    text, rows, last = "", {}, []
    for m in history:
        c = m.get("content") or ""
        if m["role"] == "user":
            if "text" in m:
                block, text = m.get("preground") or "", m["text"]
            else:
                block, _, text = c.rpartition("\n\n")
            found = ROW.findall(block)
        elif m["role"] == "tool":
            found = ROW.findall(c)
            if found:
                last = [int(n) for n, _, _ in found]
        else:
            continue
        for n, _, name in found:
            rows[int(n)] = name
    return text, rows, last


def evidence(call: dict, history: list[dict], today: str | None) -> list[str]:
    """Facts for the trace, all read off the context: rows whose name shares a word with the message
    (`saw`), else the rows of the latest reply (`last`); the §14 rules the message triggers; and, for a
    date rule, today and the date the call ends up using."""
    text, rows, last = view(history)
    words = name_tokens(text)
    hits = sorted(((len(words & name_tokens(nm)), n) for n, nm in rows.items() if words & name_tokens(nm)), key=lambda x: (-x[0], -x[1]))
    fmt = lambda ns: ", ".join("#%d %s" % (n, " ".join(rows[n].split()[:4])) for n in ns[:3]) + (" +%d" % (len(ns) - 3) if len(ns) > 3 else "")  # noqa: E731
    parts = ["saw: " + (fmt([n for _, n in hits]) if hits else "none")]
    seen = [n for n in last if n in rows]
    if seen and seen != [n for _, n in hits][:len(seen)]:
        parts.append("last: " + fmt(seen))
    args = call.get("args") or {}
    fired = list(conventions.detect({"user": text, "ref": [], "gold": []}))
    if args.get("op") == "balance" and "balance" not in fired:
        fired.append("balance")
    for r in fired:
        parts.append("rule: " + RULE_TEXT[r])
    if today and DATE_RULES & set(fired):
        d = today.split()[-1]
        seg = "today: %s %s" % (DAYS[datetime.date.fromisoformat(d).weekday()], d)
        m = ISO.search(json.dumps(args))
        if m:
            dt = datetime.date.fromisoformat(m.group(0)[:10])
            seg += " -> %s %s%s" % (DAYS[dt.weekday()], m.group(0)[:10], " " + m.group(1) if m.group(1) else "")
        parts.append(seg)
    return parts


def today_of(system: str) -> str | None:
    m = re.search(r"today: \w+ (\d{4}-\d\d-\d\d)", system)
    return m.group(1) if m else None


def derive_think(call: dict, retry: bool, history: list[dict] | None = None, today: str | None = None) -> str:
    """A short line built only from which fields the call sets -- fixed labels, no composed
    natural-language reasoning; two calls with the same shape get the same line."""
    tool, args = call["tool"], call.get("args") or {}
    parts = evidence(call, history, today) if history is not None else []
    if retry:
        parts.append("retry: previous call rejected")
    if tool == "act":
        parts.append("intent: write %s" % args.get("verb", "?"))
        if args.get("kind"):
            parts.append("kind: %s" % args["kind"])
        if args.get("where"):
            parts.append("cond: where")
        if args.get("when"):
            parts.append("cond: when")
        parts.append("plan: act")
    elif tool in ("answer", "compute"):
        parts.append("intent: %s" % ("compute " + args["op"] if tool == "compute" and args.get("op") else "read"))
        if args.get("kind"):
            parts.append("kind: %s" % args["kind"])
        if args.get("where"):
            parts.append("cond: where")
        if args.get("when"):
            parts.append("cond: when")
        if args.get("linked_to"):
            parts.append("cond: linked_to")
        parts.append("plan: %s" % tool)
    elif tool in ("find", "search"):
        if args.get("where"):
            parts.append("cond: where")
        if args.get("when"):
            parts.append("cond: when")
        parts.append("plan: %s" % tool)
    elif tool == "open":
        parts.append("plan: open")
    elif tool == "ask":
        parts.append("intent: needs a choice")
        parts.append("plan: ask")
    elif tool == "decline":
        parts.append("intent: decline (%s)" % args.get("reason", "?"))
        parts.append("plan: decline")
    else:
        parts.append("plan: %s" % tool)
    return " · ".join(parts)


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


def records(session: dict, transcript) -> list[dict]:
    sysrec = system_record(session)
    head = render.render([sysrec])[0]
    if head != transcript.system_rendered:
        raise AssertionError("system record does not render as the eval transcript's system block")
    bad = [c.get("bad", False) for t in session["turns"] for c in t["ref"]]
    msgs, ai = [sysrec], 0
    for m in transcript.messages:
        if m["role"] == "user":
            msgs.append({"role": "user", "content": render.user_content(m["text"], m.get("preground"))})
        elif m["role"] == "assistant":
            rec = assistant_record(m["content"])
            if rec is None:
                raise AssertionError(f"assistant message is not one think + one call: {m['content'][:200]!r}")
            if ai < len(bad) and bad[ai]:
                rec["loss"] = False
            ai += 1
            msgs.append(rec)
        else:
            msgs.append({"role": "tool", "content": m["content"]})
    while msgs[-1]["role"] == "tool":
        msgs.pop()
    # The trace is written from the context as the record shows it (tool replies as finally compacted),
    # so a record's think is always rebuildable from the messages before it.
    today = today_of(sysrec["content"])
    if TRACE == "v2":
        for i, tr in _load_trace().trace_messages(msgs, today).items():
            msgs[i]["think"] = tr.text()
        return msgs
    retry = [s > 0 and bool(t["ref"][s - 1].get("bad", False)) for t in session["turns"] for s in range(len(t["ref"]))]
    ai = 0
    for i, m in enumerate(msgs):
        if m["role"] == "assistant":
            m["think"] = derive_think({"tool": m["tool"], "args": m["args"]}, retry[ai] if ai < len(retry) else False, msgs[:i], today)
            ai += 1
    return msgs


class RecordedCalls(run.Backend):
    """Sends the assistant messages of a finished record, think and all, exactly as trained."""

    name = "recorded"
    tools_mode = TOOLS_MODE

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


GUARD_MARK = "contradicts the call"  # the runtime's trace guard error (crates/nativetools/src/trace.rs)


def guard_replay(session: dict, msgs: list[dict]) -> list[dict]:
    """Replay a v2 record through the runtime: every call that is not a marked repair call must be
    accepted with its trace in front of it (a guard rejection of a gold call is a false rejection)."""
    rec = run.run_session(session, RecordedCalls(msgs))
    problems = []
    for ti, t in enumerate(rec["turns"]):
        for si, st in enumerate(t["steps"]):
            ref = session["turns"][ti]["ref"]
            text = st["response"].get("text", "")
            marked = si < len(ref) and ref[si].get("bad", False)
            if GUARD_MARK in text:
                problems.append({"turn": ti + 1, "user": t["user"], "problems": [f"guard false rejection, call {si + 1}: {text[:200]}"]})
            elif (bool((st["response"].get("effect") or {}).get("error")) or text.startswith("error")) != marked:
                problems.append({"turn": ti + 1, "user": t["user"], "problems": [f"call {si + 1} with its trace: runtime outcome differs from the plain replay: {text[:200]}"]})
    return problems


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("worlds", nargs="+")
    ap.add_argument("--out", required=True)
    ap.add_argument("--split", default="train")
    ap.add_argument("--only")
    ap.add_argument("--no-seed", action="store_true")
    ap.add_argument("--trace", choices=["v1", "v2"], default="v1", help="the <think> format of the records (default: the old line)")
    a = ap.parse_args()
    global TRACE
    TRACE = a.trace
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    for w in a.worlds:
        if not a.no_seed:
            seed(w)
        sessions = load_sessions(w)
        if a.only:
            keep = set(a.only.split(","))
            sessions = [s for s in sessions if s["id"] in keep]
        report, n_ok = [], 0
        with gzip.open(out / f"{w}.jsonl.gz", "wt") as fh, open(out / f"{w}.gold.jsonl", "w") as gf:
            for s in sessions:
                s["set"] = a.split
                b = ThinkRef()
                try:
                    rec = run.run_session(s, b)
                    s["replay"] = replay_summary(rec)
                    sc = score.score([rec], [s])["sessions"][0]
                    problems = [{"turn": i + 1, "user": s["turns"][i]["user"], "problems": t["problems"]}
                                for i, t in enumerate(sc["turns"]) if not t["pass"]]
                    # a rejected call must be followed by its repair: every bad call is marked,
                    # and every unmarked call must be accepted by the runtime
                    for ti, t in enumerate(rec["turns"]):
                        for si, st in enumerate(t["steps"]):
                            ref = s["turns"][ti]["ref"]
                            is_err = bool((st["response"].get("effect") or {}).get("error")) or \
                                st["response"].get("text", "").startswith("error")
                            marked = si < len(ref) and ref[si].get("bad", False)
                            if is_err != marked:
                                problems.append({"turn": ti + 1, "user": t["user"], "problems": [
                                    f"call {si + 1}: runtime {'rejected' if is_err else 'accepted'} it but it is "
                                    f"{'not ' if not marked else ''}marked bad: {st['response'].get('text', '')[:200]}"]})
                    ok = not problems
                    if ok:
                        try:
                            msgs = records(s, b.transcript)
                        except _load_trace().TraceError as e:
                            problems.append({"trace": e.reason, "detail": e.detail})
                            ok = False
                    if ok and TRACE == "v2":
                        problems += guard_replay(s, msgs)
                        ok = not problems
                    if ok:
                        fh.write(json.dumps({"id": f"{a.split}-{s['id']}", "split": a.split, "world": w,
                                             "today": s["today"], "me": s["me"], "tools_mode": TOOLS_MODE,
                                             "messages": msgs, "n_turns": len(s["turns"]), "tags": s.get("tags", []),
                                             "source": "authored"}, ensure_ascii=False) + "\n")
                        n_ok += 1
                    report.append({"id": s["id"], "pass": ok, "problems": problems})
                except Exception as e:  # noqa: BLE001
                    report.append({"id": s["id"], "pass": False, "problems": [{"error": repr(e)[:400]}]})
                gf.write(json.dumps(s, ensure_ascii=False) + "\n")
        (out / f"{w}.report.json").write_text(json.dumps(report, indent=1, ensure_ascii=False))
        print(f"{w}: {n_ok}/{len(sessions)} sessions verified -> {out / (w + '.jsonl.gz')}", file=sys.stderr)


if __name__ == "__main__":
    main()
