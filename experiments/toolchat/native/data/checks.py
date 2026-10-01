"""Checks over generated data: trace checkers, runtime replay, dedup, length, loss masking.

usage: python checks.py OUT_DIR [--replay-worlds K] [--loss-sample N]
Writes OUT_DIR/checks.json and prints a summary.
"""
from __future__ import annotations

import argparse
import collections
import glob
import gzip
import hashlib
import json
import random
import re
import sys
from pathlib import Path

import dates as D
import rt
import worlds
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from render import call_text, render, tokenizer, tokens_with_loss  # noqa: E402

HANDLE = re.compile(r"#(\d+)")


def plan_of(think: str) -> str:
    m = re.findall(r"plan: ([^\n]*)", think)
    return m[-1] if m else ""


def trace_check(e: dict) -> list[str]:
    """Every turn's traces against its own calls and the observations shown before each step."""
    errs = []
    msgs = e["messages"]
    seen_txt = [msgs[0]["content"]]
    for turn in e["turns"]:
        user = msgs[turn["msg_index"]]
        if user["role"] != "user" or not user["content"].endswith(turn["message"]):
            errs.append("turn index does not point at its user message")
        seen_txt.append(user["content"])
        errs += turn_check(turn, msgs[:turn["msg_index"]], seen_txt)
        for s in turn["steps"]:
            seen_txt.append(s["text"])
    return errs


def turn_check(turn: dict, earlier: list[dict], seen_txt: list[str]) -> list[str]:
    errs = []
    message = turn["message"]
    seen_txt = list(seen_txt)
    steps = [(k, s) for k, s in enumerate(turn["steps"])]
    msgs = earlier
    last_user = len(earlier)
    tok = tokenizer()
    for k, m in steps:
        think, tool, args = m.get("think") or "", m["tool"], m["args"]
        seen = set(HANDLE.findall("\n".join(seen_txt)))
        prev_obs = turn["steps"][k - 1]["text"] if k else ""
        seen_txt.append(m["text"])
        if not think.strip():
            errs.append("empty think")
            continue
        if len(tok(think)["input_ids"]) > 200:
            errs.append("think over 200 tokens")
        if k == 0 and not think.startswith("intent:"):
            errs.append("first step lacks intent line")
        # rows named in the trace or the call must have been shown before
        for n in HANDLE.findall(think):
            if n not in seen:
                errs.append(f"trace mentions unseen #{n}")
        argtxt = json.dumps(args, ensure_ascii=False)
        for n in HANDLE.findall(argtxt):
            if n not in seen:
                errs.append(f"call uses unseen #{n}")
        # the plan names the tool
        plan = plan_of(think)
        want = plan.split()[0] if plan else ""
        if tool in ("answer", "act", "search", "find", "ask", "decline", "open", "compute") and want != tool:
            errs.append(f"plan '{plan[:40]}' vs call {tool}")
        if tool == "act" and plan and args.get("verb") not in plan and "rows=" not in plan and "on @" not in plan \
                and "on #" not in plan:
            errs.append(f"plan verb mismatch: {plan[:50]} vs {args.get('verb')}")
        if tool == "decline" and args["reason"] not in plan and not (args["reason"] in think):
            errs.append("decline reason not in trace")
        # quoted phrases come from the message
        head = think.split("\n")[0]
        if k == 0 and head.startswith("intent:"):
            for q in re.findall(r'\("([^"]+)" = ', head):
                for part in q.split(" … "):
                    if part.lower() not in message.lower():
                        errs.append(f"deciding phrase not in message: {part!r}")
            mm = re.search(r"· named: (.*)$", head)
            if mm:
                for q in re.findall(r'"([^"]+)"', mm.group(1)):
                    if q.lower() not in message.lower():
                        errs.append(f"named phrase not in message: {q!r}")
        # date line agrees with the call
        for kept, phrase, desc in re.findall(r'date( \(kept\))?: "([^"]+)" → ([^\n(]+)', think):
            exprs = []
            if isinstance(args.get("when"), dict):
                exprs.append(args["when"])
            for line in str(args.get("args", "")).split("\n"):
                if ": {" in line:
                    exprs.append(json.loads(line.split(": ", 1)[1]))
            if exprs and not any(D.describe(x) == desc.strip() for x in exprs):
                errs.append(f"date line {desc.strip()!r} disagrees with call {exprs}")
            earlier = " ".join(x["content"] for x in msgs if x["role"] == "user").lower()
            if phrase.lower() not in message.lower() and not (kept and phrase.lower() in earlier):
                errs.append(f"date phrase not in message: {phrase!r}")
        # name condition agrees with the call
        for nm in re.findall(r"cond: name ~ ([^,·\n]+)", think):
            if args.get("name", "").strip() != nm.strip():
                errs.append(f"cond name {nm.strip()!r} vs call {args.get('name')!r}")
        # where condition agrees
        if args.get("where") and tool in ("answer", "find", "act", "compute") and args["where"] not in think:
            errs.append("where not stated in the trace")
        # pick check: the ✓ rows are exactly the call's rows
        chk = re.findall(r"check: ([^\n]*)", think)
        if chk and tool in ("answer", "act") and "rows" in args:
            ticks = set(re.findall(r"#(\d+)[^·]*?✓", chk[-1]))
            rows = set(HANDLE.findall(args["rows"]))
            if ticks and ticks != rows:
                errs.append(f"check ✓ {sorted(ticks)} vs rows {sorted(rows)}")
        # reactions cite the observation they react to
        if think.startswith("already so") and not prev_obs.startswith("already:"):
            errs.append("already line without already: observation")
        if think.startswith("ambiguous:") and not prev_obs.startswith("ambiguous:") and "@" not in prev_obs[:3]:
            errs.append("ambiguous line without ambiguous observation")
        if "dead end: search" in think and not prev_obs.startswith("0 rows match"):
            errs.append("dead-end line without an empty search")
    # the turn ends on its last step only
    return errs


def check_loss(ids: list[int], tsp: list, n_assistant: int) -> None:
    """No loss on system / user / tool tokens: each span is exactly one think + one call + <|im_end|>."""
    tok = tokenizer()
    assert len(tsp) == n_assistant, "one loss span per assistant message"
    masked = [True] * len(ids)
    for a, b in tsp:
        piece = tok.decode(ids[a:b])
        assert piece.endswith("<|im_end|>") and piece.count("<tool_call>") == 1 and "</think>" in piece, piece[:80]
        for bad in ("<|im_start|>", "<tool_response>", "</tool_response>"):
            assert bad not in piece, (bad, piece[:120])
        assert tok.decode(ids[max(0, a - 8):a]).endswith("assistant\n<think>\n")
        for x in range(a, b):
            masked[x] = False
    # outside the spans, after the system block, no call may appear (the system block's format example excepted)
    sys_end = next(i for i in range(len(ids)) if tok.decode(ids[i:i + 1]) == "<|im_end|>")
    rest = tok.decode([t for i, (t, m) in enumerate(zip(ids, masked)) if m and i > sys_end])
    assert "<function=" not in rest, "a call outside the loss spans"


def replay_world(seed: int, sessions: list[dict], out_dir: Path) -> dict:
    """Re-seed the world and replay every session's raw call text through the runtime."""
    w, model = worlds.build_world(seed, sessions[0].get("size"))
    tmp = out_dir / "vaults"
    tmp.mkdir(exist_ok=True)
    vault = tmp / f"replay{seed}"
    rt.remove_vault(vault)
    rt.seed(w, vault, tmp)
    res = collections.Counter()
    bad = []
    tok = tokenizer()
    try:
        for rec in sorted(sessions, key=lambda r: r["session"]):
            sv = vault
            if rec.get("fresh"):
                sv = tmp / f"replay{seed}s{rec['session']}"
                rt.remove_vault(sv)
                rt.copy(vault, sv)
            s = rt.Session(sv, rec["today"], rec["me"], directory=rec["flags"]["directory"],
                           preground=rec["flags"]["preground"], tools=rec.get("tools_mode", rt.TOOLS_MODE))
            s.prompt()
            try:
                for turn in rec["turns"]:
                    u = s.user(turn["user"])
                    if (u.get("preground") or None) != (turn.get("preground") or None):
                        bad.append({"world": seed, "session": rec["session"], "what": "preground differs"})
                    for call, eff, text in zip(turn["calls"], turn["effects"], turn["texts"]):
                        # the call as the model emits it: rendered by the chat template, parsed by the runtime
                        r = s.call_text(call_text(call["tool"], call["args"]))
                        if turn.get("aborted"):
                            continue
                        res["steps"] += 1
                        if r.get("effect") == eff and r.get("text") == text:
                            res["same"] += 1
                        else:
                            bad.append({"world": seed, "session": rec["session"], "call": call,
                                        "want": text[:200], "got": r.get("text", "")[:200]})
            finally:
                s.close()
                if sv != vault:
                    rt.remove_vault(sv)
    finally:
        rt.remove_vault(vault)
    return {"counts": dict(res), "bad": bad}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("out")
    ap.add_argument("--replay-worlds", type=int, default=10 ** 9)
    ap.add_argument("--loss-sample", type=int, default=300)
    ap.add_argument("--files", default="")
    ap.add_argument("--shard", default="", help="i/k: replay only every k-th world starting at i (parallel runs)")
    ap.add_argument("--replay-only", action="store_true")
    ap.add_argument("--report", default="checks.json")
    a = ap.parse_args()
    out = Path(a.out)
    files = []
    for g in (a.files or "*-*.jsonl.gz").split(","):
        files += sorted(glob.glob(str(out / g)))
    files = [f for f in files if not Path(f).name.startswith(("sessions-", "worlds-"))]
    report: dict = {"files": [Path(f).name for f in files]}
    # ---- trace checks, dedup, length
    errs = collections.Counter()
    err_ex = collections.defaultdict(list)
    n = 0
    over = 0
    keys = collections.Counter()
    msgs_seen = collections.Counter()
    exs_for_loss = []
    rng = random.Random(0)
    for f in ([] if a.replay_only else files):
        for line in gzip.open(f, "rt"):
            e = json.loads(line)
            n += 1
            for x in trace_check(e):
                k = re.sub(r"#\d+|'[^']*'|\"[^\"]*\"|\[[^\]]*\]|\{.*\}", "…", x)
                errs[k] += 1
                if len(err_ex[k]) < 3:
                    err_ex[k].append((e["id"], x))
            if e["n_tokens"] > 8192:
                over += 1
            key = hashlib.sha256(json.dumps(e["messages"][1:], sort_keys=True, ensure_ascii=False).encode()).hexdigest()
            keys[key] += 1
            for t in e["turns"]:
                msgs_seen[t["message"].lower()] += 1
            if len(exs_for_loss) < a.loss_sample:
                exs_for_loss.append(e)
            elif rng.random() < a.loss_sample / n:
                exs_for_loss[rng.randrange(a.loss_sample)] = e
    report["examples"] = n
    report["trace_errors"] = dict(errs)
    report["trace_error_examples"] = {k: v for k, v in err_ex.items()}
    report["over_8192"] = over
    report["exact_duplicates"] = sum(v - 1 for v in keys.values() if v > 1)
    report["distinct_user_messages"] = len(msgs_seen)
    report["most_repeated_messages"] = msgs_seen.most_common(8)
    # ---- loss masking on a sample
    loss_ok = 0
    loss_bad = []
    for e in ([] if a.replay_only else exs_for_loss[: a.loss_sample]):
        text, spans = render(e["messages"])
        ids, tsp = tokens_with_loss(text, spans)
        try:
            assert [list(x) for x in tsp] == [list(x) for x in e["loss_tokens"]], "stored spans differ"
            check_loss(ids, tsp, sum(1 for m in e["messages"] if m["role"] == "assistant"))
            loss_ok += 1
        except AssertionError as ex:
            loss_bad.append((e["id"], str(ex)[:200]))
    report["loss_checked"] = loss_ok
    report["loss_bad"] = loss_bad
    # ---- replay
    sessions = collections.defaultdict(list)
    for f in sorted(glob.glob(str(out / "sessions-*.jsonl.gz"))):
        for line in gzip.open(f, "rt"):
            r = json.loads(line)
            sessions[r["world"]].append(r)
    tot = collections.Counter()
    bad = []
    si, sk = (map(int, a.shard.split("/")) if a.shard else (0, 1))
    for i, (seed, recs) in enumerate(sorted(sessions.items())):
        if i >= a.replay_worlds:
            break
        if i % sk != si:
            continue
        r = replay_world(seed, recs, out)
        tot.update(r["counts"])
        bad += r["bad"]
        print(f"replay world {seed}: {r['counts']} bad {len(r['bad'])}", file=sys.stderr, flush=True)
    report["replay"] = {"worlds": len([1 for i in range(min(len(sessions), a.replay_worlds)) if i % sk == si]), **dict(tot),
                        "mismatches": len(bad), "examples": bad[:10]}
    (out / a.report).write_text(json.dumps(report, indent=1, ensure_ascii=False, default=str))
    print(json.dumps({k: v for k, v in report.items() if k not in ("trace_error_examples",)}, indent=1,
                     ensure_ascii=False, default=str)[:4000])


if __name__ == "__main__" and "--dates" not in sys.argv:
    main()


def date_table_check() -> dict:
    """The generator's phrase -> expression readings agree with the runtime's phrases.json table."""
    import datetime as dt
    from meta import PHRASES
    from policy import canon_expr
    agree, differ, unseen = 0, [], 0
    for p in PHRASES:
        if p.get("row"):
            continue
        today = dt.datetime.fromisoformat(p["today"] if "T" in p["today"] else p["today"] + "T09:00")
        rng = random.Random(1)
        found = None
        for _ in range(6000):
            for fn in (D.read_phrase, D.instant_phrase):
                dp = fn(rng, today)
                t = dp.text.removeprefix("on ")
                if t == p["phrase"].removeprefix("on ") or dp.text == p["phrase"]:
                    found = dp
                    break
            if found:
                break
        if not found:
            unseen += 1
            continue
        if canon_expr(found.expr) == canon_expr(p["expr"]):
            agree += 1
        else:
            differ.append((p["phrase"], p["today"], found.expr, p["expr"]))
    return {"agree": agree, "differ": differ, "not_generated": unseen}


if __name__ == "__main__" and "--dates" in sys.argv:
    print(json.dumps(date_table_check(), indent=1))
