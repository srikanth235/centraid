"""The slot trace on a corpus: regenerate it from records, and measure the acceptance numbers (CONTRACT_V3.md section 6).

    python3 authored/trace3_check.py regen SRC.jsonl.gz --out DIR [--limit N] [--every K]
        re-derive the think of every assistant message of every session of SRC (a data file: the context and the calls
        are what is kept), write DIR/train.v3.jsonl.gz and DIR/regen.json (what could not be produced, and why), and
        print the report below.
    python3 authored/trace3_check.py golden DATA.jsonl.gz [--out authored/golden_v3.json]
        one (think, call) per distinct call shape of a data file: the golden file test_trace.py compiles.
    python3 authored/trace3_check.py report DATA.jsonl.gz
        the report of a data file (e.g. the records `build.py` writes): round trip, argument coverage, the refer rule,
        think length (Qwen tokens when the tokenizer is cached, else words).
    python3 authored/trace3_check.py v4 DATA.jsonl.gz [--turns N] [--no-runtime] [--write OUT.jsonl.gz]
        the v4 trace (CONTRACT_V3.md section 8) over the first N turns of a built data file: every v3.1 think rewritten as v4,
        its compiled call against the v3.1 think's (the runtime's stateless compiler, and its session `compile` op over the session's own world
        unless --no-runtime; the world must be seeded under EVAL_VAULTS, as `build.py` leaves it), the steps v4 does not say,
        and the mean think and decision tokens per turn of both versions (the tokenizer `fmt.encode` uses).
    python3 authored/trace3_check.py golden4 [--golden authored/golden_v3.json]
        add the v4 think of every row of the golden file (`think4`; the pick reason is the runtime's hint: no context).

The report:
  round trip      compile(parse(think)) == the call, through `fmt.call_of_think`, the decoder's own function
  arg-drop        share of steps in which some call argument has no slot (nor a slot that states it) in the think
  refer rule      turns (first steps) that have a previous result and carry a `refer:` line, and turns without one that
                  carry none (`trace.refer_required`: a function of the turn index and the earlier results only)
  think length    mean, max and p99 tokens of the think
"""
from __future__ import annotations

import argparse
import collections
import gzip
import json
import os
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
NATIVE = HERE.parent
sys.path[:0] = [str(NATIVE / "train"), str(NATIVE)]
import fmt  # noqa: E402
import runtime_think as R  # noqa: E402  (the runtime's think compiler and v4 rewrite, as a client)

T = fmt.trace3()

# which slot states a call argument (a slot of the same name, or the slots the rule below derives it from)
ARG_SLOTS = {"args": ("set",), "when": ("when",), "rows": ("rows", "pick", "refer"), "row": ("row", "pick", "refer")}


def read(path):
    with gzip.open(path, "rt") as fh:
        for line in fh:
            yield json.loads(line)


def today_of(system: str) -> str | None:
    m = re.search(r"today: \w+ (\d{4}-\d\d-\d\d)", system)
    return m.group(1) if m else None


def tokenizer():
    try:
        from transformers import AutoTokenizer
        return AutoTokenizer.from_pretrained("Qwen/Qwen3.5-0.8B", local_files_only=True)
    except Exception:  # noqa: BLE001
        return None


def covered(call_args: dict, think: str) -> list[str]:
    """The arguments of a call with no slot in its think."""
    slots = T.parse3(think)
    missing = []
    for a in call_args:
        names = ARG_SLOTS.get(a, (a,))
        if not any(n in slots for n in names):
            missing.append(a)
        elif a == "when" and not slots.get("when_expr"):
            missing.append(a)
        elif a in ("rows", "row") and a not in slots and not (slots.get("pick") or (slots.get("refer") and slots["refer"][2])):
            missing.append(a)
    return missing


def regen_session(ex: dict) -> tuple[dict | None, list]:
    """The session with its thinks and call-ordered arguments, or (None, [(step, reason, detail)])."""
    msgs = [dict(m) for m in ex["messages"]]
    today = today_of(msgs[0]["content"])
    out, bad = {}, []
    prev_bad = False
    for i, m in enumerate(msgs):
        if m["role"] == "user":
            prev_bad = False
        if m["role"] != "assistant":
            continue
        isbad = m.get("loss") is False
        try:
            tr = T.derive_trace3({"tool": m["tool"], "args": m["args"]}, msgs[:i], today, prev_bad, msgs[i + 1:], bad=isbad)
            out[i] = tr
        except T.TraceError as e:
            bad.append((i, e.reason, e.detail))
        prev_bad = isbad
    if bad:
        return None, bad
    for i, tr in out.items():
        m = msgs[i]
        m["think"] = T.render3(tr.slots)
        m["args"] = tr.call["args"]  # the call in the one spelling (where, dates)
    return dict(ex, messages=msgs), []


def report(path, label=""):
    tok = tokenizer()
    count = (lambda s: len(tok(s)["input_ids"])) if tok else (lambda s: len(s.split()))
    unit = "Qwen tokens" if tok else "whitespace words (tokenizer not cached)"
    n = rt = drop = 0
    total = 0
    anchoring = collections.Counter()
    turns_prev = turns_prev_ok = turns_none = turns_none_ok = later_refer = 0
    lens = []
    for ex in read(path):
        msgs = ex["messages"]
        asst = [(i, m) for i, m in enumerate(msgs) if m["role"] == "assistant"]
        for i, m in asst:
            n += 1
            want = fmt.render.call_text(m["tool"], m["args"])
            rt += fmt.call_of_think(m["think"], T.dates_line_of(msgs[:i]), "v3.1") == want
            drop += bool(covered(m["args"], m["think"]))
            if m.get("loss") is not False:
                ms = T.mentions(m["tool"], m["args"], T.parse3(m["think"]))
                anchoring[ms["class"]] += 1
                anchoring["dates_anchored"] += ms["dates_anchored"]
                anchoring["dates_free"] += ms["dates_free"]
            c = count(m["think"])
            total += c
            lens.append(c)
            slots = T.parse3(m["think"])
            if T.first_step(msgs[:i]):
                if T.has_prev_result(msgs[:i]):
                    turns_prev += 1
                    turns_prev_ok += "refer" in slots
                else:
                    turns_none += 1
                    turns_none_ok += "refer" not in slots
            elif "refer" in slots and slots["refer"][2]:
                later_refer += 1  # a later step of a turn that names rows of an earlier turn
    print(f"== {label or path}")
    print(f"steps {n}   round trip (compile(think) == call)  {rt}/{n} = {100 * rt / max(n, 1):.3f}%")
    print(f"arg-drop surface (a call argument with no slot)  {drop}/{n} = {100 * drop / max(n, 1):.3f}%")
    print(f"refer rule: `refer:` on {turns_prev_ok}/{turns_prev} turns that have a previous result, absent on {turns_none_ok}/{turns_none} turns "
          f"that have none ({turns_prev_ok + turns_none_ok}/{turns_prev + turns_none} turns); a real referent on {later_refer} later steps")
    print(f"calls by what they refer to (not repair calls): {dict(sorted(anchoring.items()))}")
    if lens:
        print(f"think length ({unit}) over {n} steps: mean {total / n:.2f}  max {max(lens)}  p99 {sorted(lens)[int(0.99 * len(lens))]}")
    return dict(steps=n, roundtrip=rt, argdrop=drop, turns_prev=turns_prev, turns_prev_ok=turns_prev_ok, turns_none=turns_none,
                turns_none_ok=turns_none_ok, anchoring=dict(anchoring))


def call_shape(m: dict, think: str) -> tuple:
    """What makes two calls the same shape: the tool, the arguments it carries, the lines of an `args` body (date, handle or text),
    the structure of every date (digits aside), and what states its rows (a slot, `pick`, `refer`)."""
    args = m["args"]
    body = []
    for ln in args.get("args", "").split("\n") if "args" in args else []:
        k, _, v = ln.partition(": ")
        body.append("date" if v.startswith("{") else "handle" if re.fullmatch(r"[#@]\d+(?:, [#@]\d+)*", v) else "text")
    dates = []
    for v in ([args["when"]] if "when" in args else []) + [ln.partition(": ")[2] for ln in args.get("args", "").split("\n") if ln.partition(": ")[2].startswith("{")]:
        dates.append(re.sub(r"\d+", "9", T.date_to_compact(v)[0]))
    slots = T.parse3(think)
    refs = [e for e in ([slots["when_expr"]] if slots.get("when_expr") else []) + [v for _k, v, d in slots.get("set", []) if d]]
    dates = ["dates[i]" if T.DATES_REF.match(e) else d for e, d in zip(refs, dates)]
    src = ("explicit" if any(k in slots for k in ("rows", "row")) else "pick" if slots.get("pick") else
           "refer" if slots.get("refer") and slots["refer"][2] else "none")  # where the rows argument comes from
    return (m["tool"], tuple(args), tuple(body), tuple(dates), src)


def golden(src, out):
    """One (think, call) per distinct call shape of the corpus: the golden file authored/golden_v3.json."""
    seen: dict = {}
    for ex in read(src):
        for i, m in enumerate(ex["messages"]):
            if m["role"] != "assistant":
                continue
            key = call_shape(m, m["think"])
            if key not in seen:
                seen[key] = {"shape": " ".join(map(str, key[:2])) + " | " + ",".join(key[2]) + " | " + ";".join(key[3]) + " | " + ",".join(key[4]),
                             "think": m["think"], "call": {"tool": m["tool"], "args": m["args"]}}
                if "dates[" in m["think"]:  # a dates[i] compiles against the dates line of its prompt
                    seen[key]["dates"] = T.dates_line_of(ex["messages"][:i])
                try:
                    seen[key]["think4"] = R.v4_think(m["think"], ex["messages"][:i])
                except R.V4Skip:
                    pass
    rows = sorted(seen.values(), key=lambda r: r["shape"])
    Path(out).write_text(json.dumps(rows, indent=0, ensure_ascii=False) + "\n")
    print(f"{len(rows)} distinct call shapes of {src} -> {out}")


def golden4(path):
    """Add `think4` to every row of the golden file that v4 can say (no context: the runtime's reason hint), `null` for the others."""
    rows = json.loads(Path(path).read_text())
    n = 0
    for r in rows:
        try:
            r["think4"] = R.v4_think(r["think"], dates=r.get("dates") or "")
            n += 1
        except R.V4Skip:
            r["think4"] = None
    Path(path).write_text(json.dumps(rows, indent=0, ensure_ascii=False) + "\n")
    print(f"{n}/{len(rows)} golden shapes have a v4 think -> {path}")


def turns_of(msgs):
    """The assistant messages of a record grouped by turn: [(index, message)] per user message."""
    out = []
    for i, m in enumerate(msgs):
        if m["role"] == "user":
            out.append([])
        elif m["role"] == "assistant":
            out[-1].append((i, m))
    return out


def v4_replay(rec, steps):
    """Replay a record against the runtime of its own world and compile both thinks of every step (a repair call's excepted):
    `steps` is {message index: (think3, think4 or None)}. Returns (compared, equal, problems); the v3.1 and the v4 think must
    compile to the same `stated` and `call`, and `stated` must be the record's call."""
    sys.path[:0] = [str(NATIVE / "eval")]
    import lib  # noqa: E402
    compared = equal = 0
    problems = []
    msgs = rec["messages"]
    with lib.Runtime(rec["world"], rec["today"], rec["me"], tmp_root=os.environ.get("EVAL_TMP"), flags=["--tools", rec.get("tools_mode", "sig")]) as rt:
        rt.req({"op": "prompt"})
        done = False
        for ti, turn in enumerate(turns_of(msgs)):
            user = [m for m in msgs if m["role"] == "user"][ti]
            rt.req({"op": "user", "text": user["content"].rpartition("\n\n")[2]})
            for i, m in turn:
                think3, think4 = steps.get(i, (m["think"], None))
                if think4 is not None and m.get("loss") is not False:
                    compared += 1
                    try:
                        r3 = rt.req({"op": "compile", "slots": T.slots_json(T.parse3(think3))})
                        r4 = rt.req({"op": "compile", "slots": T.slots_json(T.parse4(think4))})
                    except (T.CompileError, ValueError) as e:
                        problems.append((rec["id"], i, f"slots: {e}"))
                        continue
                    if "refused" in r4 or "refused" in r3:
                        problems.append((rec["id"], i, f"refused {r4.get('refused') or r3.get('refused')}"))
                    elif not T.same_call(T.runtime_call(r4, "stated"), {"tool": m["tool"], "args": m["args"]}):
                        problems.append((rec["id"], i, f"v4 states {json.dumps(r4['stated'], ensure_ascii=False)[:140]} != the call"))
                    elif not T.same_call(T.runtime_call(r4, "call"), T.runtime_call(r3, "call")):
                        problems.append((rec["id"], i, f"v4 executes {json.dumps(r4['call'], ensure_ascii=False)[:140]}, v3.1 {json.dumps(r3['call'], ensure_ascii=False)[:140]}"))
                    else:
                        equal += 1
                resp = rt.req({"op": "call_text", "text": lib.first_call(f"<think>\n{think3}\n</think>\n\n" + lib.format_call(m["tool"], m["args"]))})
                if resp.get("ends_turn"):
                    break
    return compared, equal, problems


def v4_tokens(tok, ex, upto):
    """Per assistant message of the first `upto` ones of a record, `fmt.encode`d as it is (v3.1) and as v4 (NATIVE_TRACE): think
    tokens, think decision tokens, think hard tokens, call decision tokens. Returns (v3.1 rows, v4 rows), each a list of tuples."""
    out = []
    for mode in ("v3.1", "v4"):
        os.environ["NATIVE_TRACE"] = mode
        enc = fmt.encode(tok, ex)
        rows = []
        for (s, e) in enc["ranges"][:upto]:
            cut = enc["text"].index("</think>", s)
            toks = [i for i, (a, b) in enumerate(enc["offsets"]) if s <= a and b <= e and b > a]
            think = [i for i in toks if enc["offsets"][i][0] < cut]
            rows.append((len(think), sum(1 for i in think if enc["decision"][i] & fmt.PART_THINK),
                         sum(1 for i in think if enc["decision"][i] & fmt.PART_HARD),
                         sum(1 for i in toks if enc["decision"][i] & fmt.PART_CALL), len(toks)))
        out.append(rows)
    os.environ.pop("NATIVE_TRACE", None)
    return out


def v4_check(path, turns, runtime, write):
    """The v4 trace over the first `turns` turns of a built data file (see the module docstring)."""
    from transformers import AutoTokenizer
    tok = AutoTokenizer.from_pretrained(fmt.render.TOKENIZER)
    total_turns = steps_n = py_equal = rt_compared = rt_equal = 0
    skipped = collections.Counter()
    problems = []
    per_turn = {"v3.1": [], "v4": []}
    sess_out = []
    for ex in read(path):
        if total_turns >= turns:
            break
        msgs = ex["messages"]
        grouped = turns_of(msgs)
        keep = min(len(grouped), turns - total_turns)
        total_turns += keep
        new = [dict(m) for m in msgs]
        steps = {}
        upto = 0
        for ti in range(keep):
            for i, m in grouped[ti]:
                upto += 1
                steps_n += 1
                try:
                    t4 = R.v4_think(m["think"], msgs[:i])
                except R.V4Skip as e:
                    skipped[e.reason] += 1
                    if e.reason == "roundtrip":
                        problems.append((ex["id"], i, e.detail))
                    steps[i] = (m["think"], None)
                    continue
                py_equal += 1
                steps[i] = (m["think"], t4)
                new[i]["think"] = t4
        if runtime:
            c, q, p = v4_replay(dict(ex, messages=[dict(m) for m in msgs]), steps)
            rt_compared, rt_equal = rt_compared + c, rt_equal + q
            problems += p
        v3_rows, v4_rows = v4_tokens(tok, ex, upto)
        k = 0
        for ti in range(keep):
            n = len(grouped[ti])
            for ver, rows in (("v3.1", v3_rows), ("v4", v4_rows)):
                per_turn[ver].append([sum(r[j] for r in rows[k:k + n]) for j in range(5)])
            k += n
        sess_out.append(dict(ex, messages=new))
    if write:
        with gzip.open(write, "wt") as fh:
            for ex in sess_out:
                fh.write(json.dumps(ex, ensure_ascii=False) + "\n")
    print(f"== v4 over {total_turns} turns, {steps_n} steps of {path}")
    print(f"v3.1 -> v4 -> compiled call equal to the v3.1 think's (Python): {py_equal}/{steps_n} steps; not said in v4: {dict(skipped)}")
    if runtime:
        print(f"the runtime's compile op, v4 think vs v3.1 think (stated == the record's call, call == the v3.1 call): {rt_equal}/{rt_compared} steps")
    for p in problems[:10]:
        print("  problem", p)
    names = ("think tokens", "think decision", "think hard", "call decision", "all trained")
    for j, name in enumerate(names):
        a = sum(r[j] for r in per_turn["v3.1"]) / max(len(per_turn["v3.1"]), 1)
        b = sum(r[j] for r in per_turn["v4"]) / max(len(per_turn["v4"]), 1)
        print(f"per turn, {name:15s}: v3.1 {a:7.2f}   v4 {b:7.2f}   ({100 * (b - a) / max(a, 1e-9):+.1f}%)")
    return problems


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    v = sub.add_parser("v4")
    v.add_argument("data")
    v.add_argument("--turns", type=int, default=500)
    v.add_argument("--no-runtime", action="store_true")
    v.add_argument("--write")
    g4 = sub.add_parser("golden4")
    g4.add_argument("--golden", default=str(HERE / "golden_v3.json"))
    r = sub.add_parser("regen")
    r.add_argument("src")
    r.add_argument("--out", required=True)
    r.add_argument("--limit", type=int, default=0)
    r.add_argument("--every", type=int, default=1, help="keep every K-th session (a sample)")
    g = sub.add_parser("golden")
    g.add_argument("data")
    g.add_argument("--out", default=str(HERE / "golden_v3.json"))
    p = sub.add_parser("report")
    p.add_argument("data")
    a = ap.parse_args()
    if a.cmd == "v4":
        v4_check(a.data, a.turns, not a.no_runtime, a.write)
        return
    if a.cmd == "golden4":
        golden4(a.golden)
        return
    if a.cmd == "golden":
        golden(a.data, a.out)
        return
    if a.cmd == "report":
        report(a.data)
        return
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    kept, refused, steps_total = 0, [], 0
    why = collections.Counter()
    sel = []
    for k, ex in enumerate(read(a.src)):
        if a.limit and k >= a.limit:
            break
        if k % a.every:
            continue
        sel.append(ex)
    with gzip.open(out / "train.v3.jsonl.gz", "wt") as fh:
        for ex in sel:
            steps = sum(1 for m in ex["messages"] if m["role"] == "assistant")
            steps_total += steps
            rec, bad = regen_session(ex)
            if rec is None:
                refused.append({"id": ex["id"], "steps": steps, "bad": bad})
                why.update(r for _i, r, _d in bad)
                continue
            kept += 1
            fh.write(json.dumps(rec, ensure_ascii=False) + "\n")
    (out / "regen.json").write_text(json.dumps({"sessions": len(sel), "kept": kept, "refused": refused}, indent=1, ensure_ascii=False))
    lost = sum(r["steps"] for r in refused)
    print(f"regenerated {kept}/{len(sel)} sessions ({steps_total - lost}/{steps_total} steps); refused {len(refused)} sessions {dict(why)}")
    report(out / "train.v3.jsonl.gz", "regenerated from " + str(a.src))


if __name__ == "__main__":
    main()
