"""Drive an eval set with many sessions at once against one batched HF model (one GPU).

    python eval/run_batched.py --checkpoint CKPT --out runs/val-free.jsonl [--set eval/sets/val.jsonl]
        [--threads 32] [--batch 32] [--wait 0.1] [--only ID,ID] [--sample N] [--claim DIR]

`run.py` runs one session at a time with one unbatched `generate` per step. Here `--threads`
sessions run concurrently, each thread being `run.run_session` (the per-session entry, untouched)
over a backend whose `step` calls `train/batching.py`'s proxy: all threads' steps are queued and
run as one padded batched `generate`. Decoding, prompt and options are `--model hf`'s
(NATIVE_DECODING hard|soft|free, NATIVE_LARK, NATIVE_THINK_LIMIT, NATIVE_DTYPE, NATIVE_MAX_NEW,
NATIVE_HANDLES, NATIVE_TOOLS); the run file has the same records, so score.py reads it as is.

Records are appended to --out as sessions finish (a killed run keeps what it finished). Two
processes on two GPUs share the work through `--claim DIR`: a session is taken by whoever creates
its claim file first, so neither idles while the other has a long session left. Sessions are
taken longest first (most turns). `--sample N` runs a fixed stratified subset (batching.py);
`--only` narrows first. A summary of batch sizes and throughput goes to <out>.stats.json.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import threading
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / "train"))

import run  # noqa: E402  (eval/run.py: run_session, Backend, StepOut)
from lib import read_jsonl  # noqa: E402

DEFAULT_SET = HERE / "sets" / "val.jsonl"


class BatchedHF(run.Backend):
    """`run.HFBackend`'s step over the shared batching proxy (whose `last_info` is per thread,
    but the info comes back with the text anyway)."""

    name = "hf"
    tools_mode = "sig"

    def __init__(self, proxy, tools_mode: str | None = None):
        self.impl = proxy
        if tools_mode:
            self.tools_mode = tools_mode

    def step(self, transcript, ctx):
        from hf_backend import prompt_from_transcript

        text, info = self.impl.complete_info(prompt_from_transcript(transcript))
        return run.StepOut(text=text, think_cut=bool(info.get("think_cut")), override=bool(info.get("override")),
                           decoding=info.get("mode"))

    def resample(self, transcript, ctx, exclude):
        from hf_backend import prompt_from_transcript

        text, info = self.impl.complete_info(prompt_from_transcript(transcript), sample=True, exclude=[exclude])
        return run.StepOut(text=text, think_cut=bool(info.get("think_cut")), override=bool(info.get("override")),
                           decoding=f"{info.get('mode')}+resample")


def select(sessions: list[dict], only: str | None, sample: int) -> list[dict]:
    """--only, then --sample, then longest sessions first (a stable order for the same input)."""
    from batching import stratified_sample

    if only:
        keep = set(only.split(","))
        sessions = [s for s in sessions if s["id"] in keep]
    sessions = stratified_sample(sessions, sample)
    return sorted(sessions, key=lambda s: -len(s["turns"]))


def drive(sessions: list[dict], make_backend, proxy, out_path: str, threads: int = 32, claim: str | None = None,
          log=lambda m: print(m, file=sys.stderr, flush=True)) -> dict:
    """Run `sessions` on `threads` worker threads; append each record to `out_path` as it finishes.
    `proxy` needs enter()/leave() (the batcher's active-client count). Returns {id: record}."""
    pending = iter(sessions)
    lock, wlock = threading.Lock(), threading.Lock()
    results: dict[str, dict] = {}
    t0 = time.time()
    if claim:
        os.makedirs(claim, exist_ok=True)

    def take():
        while True:
            with lock:
                s = next(pending, None)
            if s is None:
                return None
            if not claim:
                return s
            try:
                os.close(os.open(os.path.join(claim, s["id"]), os.O_CREAT | os.O_EXCL | os.O_WRONLY))
                return s
            except FileExistsError:
                continue  # the other process has it

    def one(session):
        try:
            return run.run_session(session, make_backend())
        except Exception as error:  # noqa: BLE001 - the same error record run.py writes
            return {"id": session["id"], "model": "hf", "error": repr(error), "turns": []}

    def worker():
        proxy.enter()
        try:
            while (s := take()) is not None:
                ts = time.time()
                rec = one(s)
                with wlock:
                    results[rec["id"]] = rec
                    with open(out_path, "a", encoding="utf-8") as fh:
                        fh.write(json.dumps(rec, ensure_ascii=False) + "\n")
                    if rec.get("error"):
                        log("[%d] %s: ERROR %s" % (len(results), rec["id"], rec["error"]))
                    else:
                        n = sum(len(t["steps"]) for t in rec["turns"])
                        log("[%d] %s: %d turns, %d steps, %.0fs (t+%.0fs)"
                            % (len(results), rec["id"], len(rec["turns"]), n, time.time() - ts, time.time() - t0))
        finally:
            proxy.leave()

    ts = [threading.Thread(target=worker, name="session-%d" % i) for i in range(threads)]
    for t in ts:
        t.start()
    for t in ts:
        t.join()
    return results


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--set", default=str(DEFAULT_SET), help="gold set (default eval/sets/val.jsonl)")
    ap.add_argument("--checkpoint", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--only", help="comma list of session ids")
    ap.add_argument("--sample", type=int, default=0, help="a fixed stratified subset of N sessions (0 = all)")
    ap.add_argument("--threads", type=int, default=32, help="concurrent sessions")
    ap.add_argument("--batch", type=int, default=0, help="max sequences per generate (default: --threads)")
    ap.add_argument("--wait", type=float, default=0.1, help="max seconds a batch waits to fill")
    ap.add_argument("--max-tokens", type=int, default=None, help="padded (prompt + max new) tokens per batch")
    ap.add_argument("--claim", help="directory shared by processes on other GPUs: each session runs once")
    ap.add_argument("--tools", choices=["sig", "compact", "full", "engineered"],
                    help="tools-block spelling (default: NATIVE_TOOLS, else sig)")
    args = ap.parse_args()

    sessions = select(read_jsonl(args.set), args.only, args.sample)
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    open(args.out, "w").close()
    print("%d sessions, %d threads, batch %d" % (len(sessions), args.threads, args.batch or args.threads),
          file=sys.stderr, flush=True)

    from batching import BatchedBackend
    from hf_backend import from_env

    tload = time.time()
    hf = from_env(args.checkpoint)
    proxy = BatchedBackend(hf, max_batch=args.batch or args.threads, max_wait=args.wait, max_tokens=args.max_tokens)
    print("model loaded in %.0fs" % (time.time() - tload), file=sys.stderr, flush=True)
    tools = args.tools or os.environ.get("NATIVE_TOOLS")

    stop = threading.Event()

    def monitor():  # one line per half minute: what the GPU is doing
        while not stop.wait(30):
            sizes = proxy.batcher.sizes
            print("[batching] %d batches, mean size %.1f, %d steps, %d new tokens, oom %d"
                  % (len(sizes), sum(sizes) / max(1, len(sizes)), hf.stats["steps"], hf.stats["new_tokens"], proxy.oom),
                  file=sys.stderr, flush=True)
    threading.Thread(target=monitor, daemon=True).start()

    t0 = time.time()
    results = drive(sessions, lambda: BatchedHF(proxy, tools), proxy, args.out, args.threads, args.claim)
    secs = time.time() - t0
    stop.set()
    sizes = proxy.batcher.sizes
    stats = {"sessions": len(results), "errors": sum(1 for r in results.values() if r.get("error")),
             "seconds": round(secs, 1), "batches": len(sizes), "mean_batch": round(sum(sizes) / max(1, len(sizes)), 2),
             "max_batch": max(sizes, default=0), "oom_splits": proxy.oom, **hf.stats}
    Path(args.out + ".stats.json").write_text(json.dumps(stats, indent=1))
    print("wrote %d sessions to %s in %.0fs; %s" % (len(results), args.out, secs, json.dumps(stats)))
    proxy.close()


if __name__ == "__main__":
    main()
