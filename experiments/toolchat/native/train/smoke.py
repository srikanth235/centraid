"""CPU smoke, end to end: data -> grammar -> mask -> 2 training steps -> save -> reload ->
dev-like sessions through the real runtime with the eval driver (hard, soft, free decoding) ->
score when gold exists. Checkpoints go to the scratch dir and are deleted at the end.

    python smoke.py --work <scratch dir> [--data <sessions.jsonl.gz> [--tools tools.json]] [--keep]

Without --data it renders 20 sessions with `smoke_data.py` (the fixture world, driven through
the runtime, thinks written by authored/trace.py). --ckpt reuses a trained output dir to rerun only the later
stages. The two training steps are a full fp32 fine-tune of the 0.8B model: about 16 GB of RAM on CPU, and a smaller
box is OOM-killed in the first optimizer step.
"""
from __future__ import annotations

import argparse
import gzip
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
NATIVE = HERE.parent
REPO = HERE.parents[3]
NT = os.environ.get("NATIVETOOLS", str(REPO / "target" / "debug" / "nativetools"))
PY = sys.executable
RESULTS: dict = {}


def stage(name, ok, detail=""):
    RESULTS[name] = {"ok": bool(ok), "detail": detail}
    print("[%s] %s %s" % ("PASS" if ok else "FAIL", name, detail), flush=True)


def run(cmd, env=None, log=None):
    print("$", " ".join(str(c) for c in cmd), flush=True)
    t = time.time()
    r = subprocess.run([str(c) for c in cmd], env=env, capture_output=True, text=True)
    if log:
        Path(log).write_text(r.stdout + r.stderr)
    print("  exit %d in %.0fs" % (r.returncode, time.time() - t), flush=True)
    return r


def take(src, dst, n):
    with gzip.open(src, "rt") if str(src).endswith(".gz") else open(src) as fi, gzip.open(dst, "wt") as fo:
        k = 0
        for line in fi:
            if line.strip():
                fo.write(line)
                k += 1
                if k >= n:
                    break
    return k


# three dev-like sessions on eval world C (used when eval/sets/val.jsonl does not exist yet)
SESSIONS = [
    {"id": "smoke-1", "world": "C", "today": "2026-03-15", "me": "Hana Sato",
     "turns": [{"user": "what's on my calendar this week?"}]},
    {"id": "smoke-2", "world": "C", "today": "2026-03-15", "me": "Hana Sato",
     "turns": [{"user": "how many open tasks do I have?"}, {"user": "which of them are due this month?"}]},
    {"id": "smoke-3", "world": "C", "today": "2026-03-15", "me": "Hana Sato",
     "turns": [{"user": "tell me a joke"}]},
]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--work", required=True)
    ap.add_argument("--data", help="examples to use (default: render 20 sessions with smoke_data.py)")
    ap.add_argument("--tools", help="tools JSON for examples whose system record carries none")
    ap.add_argument("--keep", action="store_true", help="keep the smoke checkpoint")
    ap.add_argument("--ckpt", help="reuse this training output dir (with FINAL) instead of training")
    ap.add_argument("--max-new", type=int, default=260)
    ap.add_argument("--modes", default="hard,free,soft", help="decoding arms (soft runs on the first session)")
    a = ap.parse_args()
    w = Path(a.work)
    w.mkdir(parents=True, exist_ok=True)
    env = dict(os.environ, HF_HUB_OFFLINE="1", NATIVETOOLS=NT, TOKENIZERS_PARALLELISM="false")
    exp = w / "export"
    run([NT, "export", exp])

    # 1. data: the given examples (e.g. the train file), else 20 sessions from the fixture world
    src = a.data
    if src:
        origin = "given: %s" % src
    else:
        src = w / "fallback.jsonl.gz"
        run([PY, HERE / "smoke_data.py", src, "--n", "20"], env=env)
        origin = "smoke_data.py (fixture world through the runtime)"
    train = w / "train20.jsonl.gz"
    n = take(src, train, 20)
    stage("data", n == 20, "%d sessions from %s" % (n, origin))
    tools_arg = ["--tools", a.tools] if a.tools else []

    # 2. grammar acceptance of every target step (whole source file)
    r = run([PY, HERE / "decode.py", "check", src, "--lark", exp / "call.lark", *tools_arg], env=env, log=w / "grammar.log")
    last = [l for l in r.stdout.splitlines() if "grammar-accepted" in l]
    stage("grammar", r.returncode == 0 and last and "(100.00%)  with handle restriction" in last[0]
          and last[0].endswith("(100.00%)"), last[0] if last else r.stderr[-300:])

    # 3+4. two training steps (the trainer asserts the loss mask on a sample first), save
    ck = w / "ckpt"
    if a.ckpt:  # reuse a checkpoint (debugging the later stages)
        ck = Path(a.ckpt)
        log = (ck / "train.log").read_text() if (ck / "train.log").exists() else ""
    r = None if a.ckpt else run([PY, HERE / "train.py", "--train", train, "--val", train, "--val-n", "3", "--out", ck, "--bs", "10",
             "--max-steps", "2", "--checkpoints", "1.0", "--log-every", "1", "--hours", "2",
             *tools_arg], env=dict(env, OMP_NUM_THREADS=str(os.cpu_count())), log=w / "train.log")
    if not a.ckpt:
        log = (w / "train.log").read_text()
        shutil.copy(w / "train.log", ck / "train.log") if ck.exists() else None
    stage("mask", "MASK assertion passed" in log, next((l for l in log.splitlines() if "MASK assertion" in l), ""))
    final = (ck / "FINAL").read_text().strip() if (ck / "FINAL").exists() else None
    stage("train", (r is None or r.returncode == 0) and final is not None,
          " | ".join(l[9:] for l in log.splitlines() if l[9:].startswith(("step ", "VAL", "SAVED", "DONE"))))
    if not final:
        print(log[-3000:])
        return finish(w, a.keep)
    ckpt = ck / final

    # 5. the eval driver's prompt equals the chat template the trainer used (no train/infer skew)
    sys.path.insert(0, str(NATIVE / "eval"))
    sys.path.insert(0, str(HERE))
    parity_ok, parity_detail = parity(exp, env)
    stage("render-parity", parity_ok, parity_detail)

    # 6. reload the checkpoint; dev-like sessions through the runtime via eval/run.py, per decoding
    vaults = w / "vaults"
    dev = NATIVE / "eval" / "sets" / "val.jsonl"
    sess = w / "sessions.jsonl"
    if dev.exists():
        rows = [json.loads(l) for l in dev.read_text().splitlines() if l.strip()]
        rows = sorted(rows, key=lambda r: (len(r["turns"]), r["id"]))[:3]  # the shortest: CPU decoding is slow
        gold = dev
    else:
        rows, gold = SESSIONS, None
    sess.write_text("".join(json.dumps(s) + "\n" for s in rows))
    worlds = sorted({s["world"] for s in rows})
    run([PY, NATIVE / "eval" / "seed_worlds.py", "--vaults", vaults, *worlds], env=env)
    eenv = dict(env, EVAL_VAULTS=str(vaults), NATIVE_LARK=str(exp / "call.lark"), EVAL_TMP=str(w))
    for mode in a.modes.split(","):
        out = w / ("run-%s.jsonl" % mode)
        only = ["--only", rows[0]["id"]] if mode == "soft" else []  # soft differs from hard only on a low-p mask
        r = run([PY, NATIVE / "eval" / "run.py", "--set", sess, "--model", "hf", "--checkpoint", ckpt, "--out", out, *only],
                env=dict(eenv, NATIVE_DECODING=mode, NATIVE_MAX_NEW=str(a.max_new)), log=w / ("run-%s.log" % mode))
        recs = [json.loads(l) for l in out.read_text().splitlines()] if out.exists() else []
        steps = [s for rec in recs for t in rec.get("turns", []) for s in t["steps"]]
        errs = [rec.get("error") for rec in recs if rec.get("error")]
        thought = sum(1 for s in steps if "</think>" in s["model"])
        parsed = sum(1 for s in steps if "call" in s["response"])
        unreadable = sum(1 for s in steps if "could not read the call" in s["response"].get("text", ""))
        cut = sum(1 for s in steps if s.get("think_cut"))
        detail = ("%d sessions, %d steps: think block %d/%d, runtime parsed call %d/%d, unreadable %d, think_cut %d%s"
                  % (len(recs), len(steps), thought, len(steps), parsed, len(steps), unreadable, cut,
                     ("; errors: %s" % errs[:2]) if errs else ""))
        # constrained arms must yield a think block and a call the runtime parses at every step;
        # the free arm only has to run end to end (a 2-step model's free text is not a call)
        ok = bool(recs) and not errs and bool(steps)
        if mode in ("hard", "soft"):
            ok = ok and thought == len(steps) and parsed == len(steps)
        stage("sessions-" + mode, ok, detail)
        if steps:
            print("  first step (%s):\n%s\n  -> %s" % (mode, steps[0]["model"][-700:], steps[0]["response"].get("text", "")[:200]))
        if gold:
            r = run([PY, NATIVE / "eval" / "score.py", out, "--gold", gold,
                     "--only", only[1] if only else ",".join(s["id"] for s in rows),
                     "--json", w / ("score-%s.json" % mode)], env=eenv, log=w / ("score-%s.log" % mode))
            stage("score-" + mode, r.returncode == 0, r.stdout.strip().splitlines()[-1] if r.stdout.strip() else r.stderr[-300:])
    if not gold:
        stage("score", True, "skipped: eval/sets/val.jsonl not present yet")
    finish(w, a.keep)


def parity(exp, env):
    """Train/infer parity over one real runtime conversation (2 turns, 3 steps, compaction,
    vault blocks): (a) the runtime's system block == render.py's; (b) the prompt eval/run.py's
    hf backend builds from its Transcript == render.py's generation prompt over the records the
    data builder would write (thinking kept, user turns as authored/build.py writes them: block first)."""
    import fmt
    import lib
    from hf_backend import prompt_from_transcript
    render = fmt.render
    base = Path(env.get("TMPDIR", "/tmp")) / ("parity-%d" % os.getpid())
    world = REPO / "crates" / "nativetools" / "tests" / "fixtures" / "world.json"
    base.mkdir()
    subprocess.run([NT, "seed", world, base / "v.db"], check=True, capture_output=True)
    p = subprocess.Popen([NT, "session", base / "v.db", "--today", "2026-09-27", "--me", "Sam Park"],
                         stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, bufsize=1)

    def req(o):
        p.stdin.write(json.dumps(o) + "\n")
        p.stdin.flush()
        return json.loads(p.stdout.readline())
    problems, prompts, blocks = [], 0, 0
    try:
        pr = req({"op": "prompt"})
        sysrec = {"role": "system", "content": pr["system"], "tools": pr["tools"]}
        if render.render([sysrec])[0] != pr["rendered"]:
            problems.append("(a) runtime `rendered` system block != render.py's")
        tr = lib.Transcript(pr["rendered"])
        recs = [sysrec]
        script = [("what have I got with Benedikt?",
                   [('intent: read "what have I"\nvia: find\nkind: task,event\nname: Benedikt', "find", {"kind": "task,event", "name": "Benedikt"}),
                    ('intent: read "what have I"\nrows: @1', "answer", {"rows": "@1"})]),
                  ("and next week?",
                   [('intent: read "and next week"\nvia: find\nrefer: none\nkind: task\nwhen: "next week" = week+1', "find",
                     {"kind": "task", "when": '{"unit":"week","rel":1}'})])]
        for _, steps in script:  # the thinks are traces: each one states its call
            for think, tool, args in steps:
                if fmt.call_of_think(think, None, "v3.1") != render.call_text(tool, args):
                    problems.append("(c) the think %r does not state its call" % think)
        for text, steps in script:
            u = req({"op": "user", "text": text})
            tr.compact(u.get("compacted") or [])
            tr.user(text, u.get("block"))
            by_obs = {c["obs"]: c["text"] for c in u.get("compacted") or []}
            for r in recs:
                if r.get("obs") in by_obs:
                    r["content"] = by_obs[r["obs"]]
            pre = u.get("block")
            blocks += bool(pre)
            recs.append({"role": "user", "content": (pre + "\n\n" + text) if pre else text})  # render.user_content
            for think, tool, args in steps:
                ours = render.render_prompt_for_generation([{k: v for k, v in r.items() if k != "obs"} for r in recs])
                theirs = prompt_from_transcript(tr)
                prompts += 1
                if ours != theirs:
                    i = next((k for k in range(min(len(ours), len(theirs))) if ours[k] != theirs[k]), min(len(ours), len(theirs)))
                    problems.append("(b) prompts differ at char %d: render.py %r vs hf backend %r"
                                    % (i, ours[i - 60:i + 60], theirs[i - 60:i + 60]))
                    break
                raw = "<think>\n" + think + "\n</think>\n\n" + render.call_text(tool, args)
                r = req({"op": "call_text", "text": raw})
                tr.assistant(raw)
                tr.tool(r.get("obs"), r.get("text", ""))
                recs.append({"role": "assistant", "think": think, "tool": tool, "args": args})
                recs.append({"role": "tool", "content": r.get("text", ""), "obs": r.get("obs")})
    finally:
        p.stdin.close()
        p.wait()
        shutil.rmtree(base, ignore_errors=True)
    if problems:
        return False, " | ".join(dict.fromkeys(problems))
    return True, ("system block and %d generation prompts identical (thinking kept, compaction, %d vault blocks first)"
                  % (prompts, blocks))


def finish(w, keep):
    if not keep and not any("--ckpt" in x for x in sys.argv):
        shutil.rmtree(w / "ckpt", ignore_errors=True)
        shutil.rmtree(w / "vaults", ignore_errors=True)
    (w / "smoke.json").write_text(json.dumps(RESULTS, indent=1))
    bad = [k for k, v in RESULTS.items() if not v["ok"]]
    print("SMOKE", "GREEN" if not bad else "RED: " + ", ".join(bad))


if __name__ == "__main__":
    main()
