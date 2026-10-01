"""Generate target-turn examples (SPEC §11.7) from synthetic worlds, driving the real runtime.

usage: python gen.py OUT_DIR --split train|val --worlds A:B [--max-examples N] [--jobs 4]
Writes OUT_DIR/<split>-<A>-<B>.jsonl.gz (examples) and sessions-<split>-<A>-<B>.jsonl.gz (replay records).
"""
from __future__ import annotations

import argparse
import copy
import gzip
import hashlib
import json
import random
import re
import sys
import time
import traceback
from pathlib import Path

import dates as D
import rt
import worlds
from phrasing import Phrasing, reading
from policy import Executor, GenError, State
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from render import render, tokenizer, tokens_with_loss  # noqa: E402  (the shared renderer)
from scenarios import BUILDERS, FIRST, FOLLOW, Ctx, Skip
from tasks import req_to_json

MAX_LEN = 8192
VAL_TAGS = {"delete.locker item", "star.document", "restore.photo", "add_to.task", "log.visit", "unstar.locker item",
            "rows.name.group"}
OUT = Path(".")
SESSIONS_PER_SIZE = {"tiny": 5, "small": 9, "medium": 10, "large": 8}
TURN_WEIGHTS = [22, 32, 24, 13, 9]            # 1-5 turns, mean ~2.5 (§11.7)


def tools_hash(tools) -> str:
    return hashlib.sha256(json.dumps(tools, sort_keys=True).encode()).hexdigest()[:12]


def pick_builder(rng: random.Random, names: list[str]) -> str:
    ws = [BUILDERS[n][1] for n in names]
    return rng.choices(names, ws)[0]


def build_req(ctx: Ctx, turn: int, split: str, phr: Phrasing, prev_req, prev_steps, log):
    rng = ctx.rng
    order: list[str] = []
    if turn > 0 and prev_steps and prev_steps[-1].tool == "ask":
        order = ["follow.settle"] * 4 + ["follow.never_mind"] if rng.random() < 0.85 else []
        rng.shuffle(order)
    elif turn > 0 and rng.random() < 0.7:
        order = [pick_builder(rng, sorted(FOLLOW - {"follow.settle", "follow.never_mind"})) for _ in range(6)]
    order += [pick_builder(rng, [b for b in FIRST if BUILDERS[b][1] > 0]) for _ in range(25)]
    for name in order:
        fn = BUILDERS[name][0]
        try:
            r = fn(ctx)
        except Skip:
            continue
        except (KeyError, IndexError, ValueError) as e:
            log({"event": "builder_error", "builder": name, "error": repr(e)})
            continue
        psplit = "val" if split == "val" else "train"      # the correction pool phrases like train
        if psplit == "train" and r.tags & VAL_TAGS:
            continue
        if not phr.available(r.family, psplit):
            continue
        try:
            msg, deciding, tmpl = phr.render(r.family, r.slots, rng, psplit)
        except KeyError:
            continue
        r.message, r.template = msg, tmpl  # type: ignore[attr-defined]
        r.reading = reading(r.family, deciding)
        r.builder = name  # type: ignore[attr-defined]
        return r
    return None


def user_content(pre: str | None, message: str) -> str:
    return f"{pre}\n\n{message}" if pre else message


def free_mb(path: Path) -> float:
    import shutil
    return shutil.disk_usage(path).free / 2 ** 20


def run_world(seed: int, split: str, out_dir: Path, phr: Phrasing, log, budget: int | None,
              fresh: bool = False) -> tuple[list, list, dict]:
    """fresh: every session starts from the pristine seeded vault (self-contained tasks for val / correction)."""
    w, model = worlds.build_world(seed)
    if model.size == "large" and free_mb(out_dir) < 700:   # a large vault's WAL is ~60 MB; the disk is shared
        log({"event": "size_downgraded", "world": seed})
        w, model = worlds.build_world(seed, "medium")
    rng = random.Random(seed * 7919 + 1)
    tmp = out_dir / "vaults"
    tmp.mkdir(exist_ok=True)
    vault = tmp / f"w{seed}"
    rt.remove_vault(vault)
    seeded = rt.seed(w, vault, tmp)
    worlds.attach_ids(model, seeded)
    today = model.today.strftime("%Y-%m-%dT%H:%M")
    oracle = D.Oracle(vault, today, model.me)
    examples, sessions = [], []
    world_rec = {"world": seed, "size": model.size, "keys": {k: v["id"] for k, v in seeded.get("keys", {}).items()}}
    n_sessions = SESSIONS_PER_SIZE[model.size]  # type: ignore[attr-defined]
    pristine = copy.deepcopy(model) if fresh else None
    try:
        for si in range(n_sessions):
            if budget is not None and len(examples) >= budget:
                break
            flags = rng.choices([(True, True), (False, True), (True, False), (False, False)], [70, 10, 15, 5])[0]
            sv = vault
            if fresh:
                sv = tmp / f"w{seed}s{si}"
                rt.remove_vault(sv)
                rt.copy(vault, sv)
                model = copy.deepcopy(pristine)
            sess = rt.Session(sv, today, model.me, directory=flags[0], preground=flags[1])
            try:
                ex, rec = run_session(sess, model, rng, oracle, split, phr, log, seed, si, flags)
            finally:
                sess.close()
                if fresh:
                    rt.remove_vault(sv)
            rec["fresh"] = fresh
            examples += ex
            if rec["turns"]:
                sessions.append(rec)
    finally:
        oracle.close()
        rt.remove_vault(vault)
    return examples, sessions, world_rec


def run_session(sess, model, rng, oracle, split, phr, log, seed, si, flags):
    """One session -> one training sequence (SPEC §11.7): every turn, earlier thinking kept."""
    prompt = sess.prompt()
    st = State(prompt)
    th = tools_hash(prompt["tools"])
    tp = OUT / f"tools-{th}.json"
    if not tp.exists():
        tp.write_text(json.dumps(prompt["tools"], ensure_ascii=False))
    n_turns = rng.choices([1, 2, 3, 4, 5], TURN_WEIGHTS)[0]
    hist = []
    turns_meta: list[dict] = []
    rec = {"world": seed, "size": model.size, "session": si, "flags": {"directory": flags[0], "preground": flags[1]},
           "today": model.today.strftime("%Y-%m-%dT%H:%M"), "me": model.me, "tools_mode": rt.TOOLS_MODE, "turns": []}
    for t in range(n_turns):
        ctx = Ctx(model, st, rng, oracle, hist)
        prev_req, prev_steps = (hist[-1] if hist else (None, None))
        r = build_req(ctx, t, split, phr, prev_req, prev_steps, log)
        if r is None:
            break
        resp = sess.user(r.message)
        st.on_user(resp)
        pre = resp.get("preground")
        ex = Executor(sess, model, st, rng)
        try:
            steps = ex.run(r)
            ok = bool(steps) and steps[-1].ends_turn
            if not ok:
                log({"event": "turn_not_ended", "world": seed, "family": r.family})
        except GenError as e:
            log({"event": "gen_error", "world": seed, "session": si, "turn": t, "family": r.family,
                 "builder": getattr(r, "builder", ""), "error": str(e)[:400], "message": r.message})
            steps, ok = ex.steps, False
        if not ok:
            # keep what ran, so a replay reproduces the vault state; the session ends before this turn
            rec["turns"].append({"user": r.message, "preground": pre, "aborted": True, "req": req_to_json(r),
                                 "calls": [{"tool": s.tool, "args": s.args} for s in steps],
                                 "effects": [s.effect for s in steps], "texts": [s.text for s in steps]})
            break
        ucontent = user_content(pre, r.message)
        turns_meta.append({"msg_index": len(st.messages) + 1})
        st.messages.append({"role": "user", "content": ucontent})
        for s in steps:
            # thinking is kept for every turn (§6.4); tool texts are compacted by later user ops
            st.messages.append({"role": "assistant", "tool": s.tool, "args": s.args, "think": s.think})
            st.messages.append({"role": "tool", "content": s.text, "obs": s.obs})
        pre_ns = set(re.findall(r"#(\d+)", pre or ""))
        pre_used = bool(pre) and any(("vault block" in s.think) or any(re.search(rf"#{n}\b", json.dumps(s.args)) for n in pre_ns)
                                     for s in steps)
        tags = set(r.tags)
        if pre and not pre_used:
            tags.add("preground_ignored")
        if any("(directory)" in s.think for s in steps):
            tags.add("directory_hit")
        turns_meta[-1].update({"family": r.family, "builder": getattr(r, "builder", ""), "pattern": r.pattern,
                               "intent": r.intent, "tags": sorted(tags), "message": r.message,
                               "template": getattr(r, "template", ""), "outcome": ex.outcome, "turn": t,
                               "steps": [{"tool": s.tool, "args": s.args, "effect": s.effect, "text": s.text,
                                          "think": s.think} for s in steps]})
        rec["turns"].append({"user": r.message, "preground": pre, "req": req_to_json(r),
                             "gold_steps": [{"think": s.think, "tool": s.tool, "args": s.args} for s in steps],
                             "calls": [{"tool": s.tool, "args": s.args} for s in steps],
                             "effects": [s.effect for s in steps], "texts": [s.text for s in steps]})
        hist.append((r, steps))
    if not turns_meta:
        return [], rec
    system = {"role": "system", "content": prompt["system"], "tools": prompt["tools"]}
    msgs = [system] + [{k: v for k, v in m.items() if k != "obs"} for m in st.messages]
    # the sequence as the harness renders it after the last turn: earlier results compacted
    while msgs[-1]["role"] == "tool":
        msgs.pop()                                   # the final reply is never trained on
    text, spans = render(msgs)
    ids, tsp = tokens_with_loss(text, spans)
    kept = len(turns_meta)
    while len(ids) > MAX_LEN and kept > 1:
        # §11.6: split at a turn boundary (the tail turns are dropped and logged)
        kept -= 1
        cut = turns_meta[kept]["msg_index"]
        msgs = msgs[:cut]
        while msgs[-1]["role"] == "tool":
            msgs.pop()
        text, spans = render(msgs)
        ids, tsp = tokens_with_loss(text, spans)
    if len(ids) > MAX_LEN:
        log({"event": "too_long", "world": seed, "session": si, "tokens": len(ids)})
        return [], rec
    if kept < len(turns_meta):
        log({"event": "split_session", "world": seed, "session": si, "turns_dropped": len(turns_meta) - kept})
    sys_tokens = len(tokenizer()(render(msgs[:1])[0], add_special_tokens=False)["input_ids"])
    ex = {"id": f"{split}-w{seed}-s{si}", "split": split, "world": seed, "size": model.size, "flags": rec["flags"],
          "today": rec["today"], "me": model.me, "tools_mode": rt.TOOLS_MODE, "tools_hash": th, "messages": msgs,
          "loss_tokens": tsp, "n_tokens": len(ids), "n_system_tokens": sys_tokens,
          "n_loss_tokens": sum(b - a for a, b in tsp), "n_turns": kept, "turns": turns_meta[:kept]}
    return [ex], rec


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("out")
    ap.add_argument("--split", required=True)
    ap.add_argument("--worlds", required=True, help="A:B world seeds")
    ap.add_argument("--max-examples", type=int, default=None)
    ap.add_argument("--pool", default=None)
    ap.add_argument("--fresh-sessions", action="store_true", help="every session starts from the pristine world")
    a = ap.parse_args()
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    global OUT
    OUT = out
    lo, hi = map(int, a.worlds.split(":"))
    phr = Phrasing(Path(a.pool) if a.pool else out / "phrasing_pool.json")
    tag = f"{a.split}-{lo}-{hi}"
    logf = open(out / f"genlog-{tag}.jsonl", "w")

    def log(obj):
        logf.write(json.dumps(obj, ensure_ascii=False, default=str) + "\n")
        logf.flush()

    exf = gzip.open(out / f"{tag}.jsonl.gz", "wt")
    sef = gzip.open(out / f"sessions-{tag}.jsonl.gz", "wt")
    wof = gzip.open(out / f"worlds-{tag}.jsonl.gz", "wt")
    n = 0
    tools = {}
    t0 = time.time()
    for seed in range(lo, hi):
        if a.max_examples is not None and n >= a.max_examples:
            break
        try:
            exs, recs, wrec = run_world(seed, a.split, out, phr, log, None if a.max_examples is None else a.max_examples - n,
                                        fresh=a.fresh_sessions)
        except Exception as e:  # a world the seeder refuses, etc.
            log({"event": "world_error", "world": seed, "error": repr(e), "tb": traceback.format_exc()[-1500:]})
            continue
        for e in exs:
            exf.write(json.dumps(e, ensure_ascii=False, default=str) + "\n")
        for r in recs:
            sef.write(json.dumps(r, ensure_ascii=False, default=str) + "\n")
        wof.write(json.dumps(wrec) + "\n")
        n += len(exs)
        print(f"[{tag}] world {seed}: +{len(exs)} (total {n}, {time.time() - t0:.0f}s)", file=sys.stderr, flush=True)
    exf.close()
    sef.close()
    wof.close()


if __name__ == "__main__":
    main()
