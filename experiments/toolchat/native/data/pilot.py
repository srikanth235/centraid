"""Pilot sizing (SPEC §11.8) and final assembly.

  python pilot.py PILOT_DIR              -> writes PILOT_DIR/pilot.json, prints N sessions
  python pilot.py --assemble DIR N       -> DIR/train.jsonl.gz (first N sessions), DIR/val.jsonl.gz (1,000)
"""
from __future__ import annotations

import glob
import gzip
import json
import statistics
import sys

BUDGET = 19_000_000
CAP = 10_000


def pilot(d: str) -> int:
    ex = [json.loads(l) for f in sorted(glob.glob(f"{d}/train-*.jsonl.gz")) for l in gzip.open(f, "rt")][:300]
    tok = [e["n_tokens"] for e in ex]
    turns = sum(e["n_turns"] for e in ex)
    m = statistics.mean(tok)
    rep = {"pilot_sessions": len(ex), "mean_tokens_per_session": m,
           "mean_system_tokens": statistics.mean(e["n_system_tokens"] for e in ex),
           "mean_rest_tokens": statistics.mean(e["n_tokens"] - e["n_system_tokens"] for e in ex),
           "mean_turns_per_session": turns / len(ex), "tokens_per_trained_turn": sum(tok) / turns,
           "rest_tokens_per_trained_turn": sum(e["n_tokens"] - e["n_system_tokens"] for e in ex) / turns,
           "mean_loss_tokens_per_session": statistics.mean(e["n_loss_tokens"] for e in ex),
           "max_tokens": max(tok), "N_uncapped": int(BUDGET // m)}
    rep["N"] = min(CAP, rep["N_uncapped"])
    json.dump(rep, open(f"{d}/pilot.json", "w"), indent=1)
    return rep["N"]


def assemble(d: str, n: int) -> None:
    for split, k in (("train", n), ("val", 1000)):
        lines = [l for f in sorted(glob.glob(f"{d}/{split}-*-*.jsonl.gz")) for l in gzip.open(f, "rt")][:k]
        with gzip.open(f"{d}/{split}.jsonl.gz", "wt") as out:
            out.writelines(lines)
        ex = [json.loads(l) for l in lines]
        print(split, len(ex), "sessions", sum(e["n_turns"] for e in ex), "turns", sum(e["n_tokens"] for e in ex),
              "tokens", sum(e["n_loss_tokens"] for e in ex), "loss tokens", file=sys.stderr)


if __name__ == "__main__" and sys.argv[1] not in ("--finalize", "--swap"):
    if sys.argv[1] == "--assemble":
        assemble(sys.argv[2], int(sys.argv[3]))
    else:
        print(pilot(sys.argv[1]))


def finalize(d: str, n: int, extra: list[str]) -> None:
    """Assemble train/val: drop sessions a trace check fails or that duplicate another, fill from the
    remaining generated sessions (parts in `d`, then `extra` dirs), write the matching val task file."""
    import hashlib
    import shutil
    from pathlib import Path

    from checks import trace_check
    for x in extra:                      # bring top-up parts next to the rest (replay and tasks see them)
        for f in glob.glob(f"{x}/*-*.jsonl.gz") + glob.glob(f"{x}/tools-*.json"):
            shutil.copy(f, d)
    report = {}
    for split, k in (("train", n), ("val", 1000)):
        keep, seen, dropped = [], set(), {"trace": [], "duplicate": []}
        for f in sorted(glob.glob(f"{d}/{split}-*-*.jsonl.gz")):
            for line in gzip.open(f, "rt"):
                if len(keep) >= k:
                    break
                e = json.loads(line)
                h = hashlib.sha256(json.dumps(e["messages"][1:], sort_keys=True).encode()).hexdigest()
                if h in seen:
                    dropped["duplicate"].append(e["id"])
                    continue
                errs = trace_check(e)
                if errs:
                    dropped["trace"].append((e["id"], errs[:2]))
                    continue
                seen.add(h)
                keep.append(line)
        with gzip.open(f"{d}/{split}.jsonl.gz", "wt") as out:
            out.writelines(keep)
        ex = [json.loads(l) for l in keep]
        report[split] = {"sessions": len(ex), "turns": sum(e["n_turns"] for e in ex),
                         "tokens": sum(e["n_tokens"] for e in ex), "loss_tokens": sum(e["n_loss_tokens"] for e in ex),
                         "system_tokens": sum(e["n_system_tokens"] for e in ex),
                         "dropped_trace": len(dropped["trace"]), "dropped_duplicate": len(dropped["duplicate"]),
                         "dropped_examples": dropped["trace"][:5]}
        if split == "val":                 # the task records behind every val session (eval / teacher)
            ids = {e["id"] for e in ex}
            with gzip.open(f"{d}/val_tasks.jsonl.gz", "wt") as out:
                for f in sorted(glob.glob(f"{d}/sessions-val-*.jsonl.gz")):
                    for line in gzip.open(f, "rt"):
                        r = json.loads(line)
                        if f"val-w{r['world']}-s{r['session']}" in ids:
                            out.write(line)
    json.dump(report, open(f"{d}/assembly.json", "w"), indent=1)
    print(json.dumps(report, indent=1))


if __name__ == "__main__" and sys.argv[1] == "--finalize":
    sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parent))
    finalize(sys.argv[2], int(sys.argv[3]), sys.argv[4:])


def swap(d: str, extra: str) -> None:
    """Swap in coverage top-up sessions: drop as many sessions from the most over-represented families."""
    import collections
    import hashlib
    import shutil

    from checks import trace_check
    train = [json.loads(l) for l in gzip.open(f"{d}/train.jsonl.gz", "rt")]
    key = lambda e: hashlib.sha256(json.dumps(e["messages"][1:], sort_keys=True).encode()).hexdigest()  # noqa: E731
    seen = {key(e) for e in train}
    new, bad = [], 0
    for f in sorted(glob.glob(f"{extra}/train-*-*.jsonl.gz")):
        for line in gzip.open(f, "rt"):
            e = json.loads(line)
            if trace_check(e) or key(e) in seen:
                bad += 1
                continue
            seen.add(key(e))
            new.append(e)
    fam = collections.Counter(t["family"] for e in train for t in e["turns"])
    top = {f for f, _ in fam.most_common(10)}
    cand = [e for e in train if all(t["family"] in top for t in e["turns"])]
    cand.sort(key=lambda e: (-min(fam[t["family"]] for t in e["turns"]), -e["n_tokens"]))
    drop = {e["id"] for e in cand[:len(new)]}
    if len(drop) < len(new):
        raise SystemExit("not enough over-represented sessions to swap out")
    out = [e for e in train if e["id"] not in drop] + new
    shutil.copy(f"{d}/train.jsonl.gz", f"{d}/train.before-cover.jsonl.gz")
    with gzip.open(f"{d}/train.jsonl.gz", "wt") as fh:
        for e in out:
            fh.write(json.dumps(e, ensure_ascii=False) + "\n")
    for f in glob.glob(f"{extra}/*-*.jsonl.gz"):
        shutil.copy(f, d)
    rep = {"added": len(new), "rejected_topup": bad, "dropped": len(drop),
           "dropped_families": dict(collections.Counter(t["family"] for e in train if e["id"] in drop for t in e["turns"])),
           "sessions": len(out), "turns": sum(e["n_turns"] for e in out), "tokens": sum(e["n_tokens"] for e in out),
           "loss_tokens": sum(e["n_loss_tokens"] for e in out)}
    json.dump(rep, open(f"{d}/assembly-cover.json", "w"), indent=1)
    print(json.dumps(rep, indent=1))


if __name__ == "__main__" and sys.argv[1] == "--swap":
    swap(sys.argv[2], sys.argv[3])
