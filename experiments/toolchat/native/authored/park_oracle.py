"""The park oracle (#1088, R-1088-6): a write that PARKS shows the model what a write that RUNS shows it.

    python3 -I authored/park_oracle.py --vaults DIR --bin PATH [--a-flags ...] [--b-flags ...] W [W ...]

For every authored (train) session of each world, replay its reference calls through `nativetools session`
twice, over private copies of the same seeded vault:

    A  the runtime as it is: `--writes run`, every write goes to the vault (or the --base-bin binary, to prove a
       change of the runtime left the Run texts untouched)
    B  `--writes park`: no write reaches the vault; the steps are applied to a patched copy of the World

and compare the two step by step: the observation `text`, the `effect`, `ends_turn`, `obs` and `step`. A
difference is a case Park cannot reproduce (or a bug in it). The report counts sessions, steps, write steps (an
`act` the runtime answered with a diff, a created row, an already, a refusal or an error) and the identical ones,
and groups the differing write steps by verb and by the first field that differs.

Train worlds only (`authored/worlds`), never the eval sets. Nothing is written inside the repository: the vaults
live under --vaults. `--a-bin` runs A with another binary (the base commit's), for a Run-versus-Run proof that
a change left the harness texts byte-identical.
"""

from __future__ import annotations

import argparse
import collections
import concurrent.futures as cf
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
sys.path[:0] = [str(HERE), str(NATIVE / "eval"), str(NATIVE)]

import gold  # noqa: E402
import split  # noqa: E402
import lib  # noqa: E402
import run  # noqa: E402

TOOLS_MODE = "sig"


def seed(world: str, vaults: Path, binary: str) -> None:
    out = vaults / world
    subprocess.run(["rm", "-rf", str(out)], check=True)
    out.mkdir(parents=True)
    proc = subprocess.run([binary, "seed", str(HERE / "worlds" / f"{world}.json"), str(out / "vault")],
                          capture_output=True, text=True)
    if proc.returncode:
        raise SystemExit(f"seed {world} failed: {proc.stderr[-2000:]}")
    # fold the WAL in so a private copy per session is small
    import sqlite3

    con = sqlite3.connect(out / "vault")
    con.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    con.execute("VACUUM")
    con.close()


def load_sessions(world: str) -> list[dict]:
    gold._SESSIONS.clear()
    for f in split.session_files(world):
        spec = importlib.util.spec_from_file_location(f"authored_{f.stem}", f)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
    return [dict(s) for s in gold.sessions()]


class Ref(run.RefBackend):
    """The reference calls as run.py's `ref` backend sends them, with the --tools spelling the model saw."""

    tools_mode = TOOLS_MODE

    def __init__(self, extra: list[str]):
        self.runtime_flags = [*run.RefBackend.runtime_flags, *extra]


def replay(session: dict, binary: str, extra: list[str]) -> dict:
    try:
        return run.run_session(session, Ref(extra))
    except Exception as error:  # noqa: BLE001
        return {"id": session["id"], "error": repr(error), "turns": []}


def is_write(step: dict) -> bool:
    eff = step["response"].get("effect") or {}
    return eff.get("tool") == "act" and (eff.get("verb") not in (None, "") or eff.get("diff") or eff.get("created")
                                          or eff.get("already") or eff.get("error"))


def first_diff(a: tuple, b: tuple) -> str:
    for name, x, y in zip(("text", "ends_turn", "obs", "step", "effect"), a, b):
        if x != y:
            if name == "effect":
                ea, eb = json.loads(x), json.loads(y)
                for key in sorted(set(ea) | set(eb)):
                    if ea.get(key) != eb.get(key):
                        return f"effect.{key}"
            return name
    return ""


UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")


def canon(record: dict) -> list:
    """Every step's response of a session with its fresh ids renamed by first appearance. The vault mints some
    ids inside a command (a revision, a profile) that a parked step has not run yet, so the sequence of ids a
    later `create` draws differs between Run and Park while the rows are the same; renaming by order compares
    the structure, and the texts (which carry no ids) are compared as they are."""
    seen: dict[str, str] = {}

    def rename(match: re.Match) -> str:
        return seen.setdefault(match.group(0), f"ID{len(seen)}")

    out = []
    for turn in record["turns"]:
        for step in turn["steps"]:
            r = step["response"]
            effect = {k: v for k, v in (r.get("effect") or {}).items() if k not in ("pending", "confirmed")}
            blob = json.dumps(effect, sort_keys=True, ensure_ascii=False)
            out.append((r.get("text"), r.get("ends_turn"), r.get("obs"), r.get("step"), UUID.sub(rename, blob)))
    return out


def raw_of(r: dict) -> tuple:
    effect = {k: v for k, v in (r.get("effect") or {}).items() if k not in ("pending", "confirmed")}
    return (r.get("text"), effect, r.get("ends_turn"), r.get("obs"), r.get("step"))


def check_confirms(a: dict, b: dict, report: dict) -> bool:
    """With `--auto-confirm` B taps every card: the vault's own after-write observation of a turn
    (`effect.confirmed.text`) must be the texts Run showed for the turn's write calls, joined."""
    ok = True
    for ta, tb in zip(a["turns"], b["turns"]):
        confirmed = [st["response"]["effect"]["confirmed"] for st in tb["steps"]
                     if (st["response"].get("effect") or {}).get("confirmed")]
        pending = [st for st in tb["steps"] if (st["response"].get("effect") or {}).get("pending")]
        if not confirmed and not pending:
            continue
        report["cards"] += 1
        expected = "\n".join(st["response"]["text"] for st in ta["steps"]
                             if "diff" in (st["response"].get("effect") or {}))
        got = confirmed[0] if confirmed else None
        if got and got.get("status") == "done" and got.get("text") == expected:
            report["cards_same"] += 1
        else:
            ok = False
            report["card_diffs"].append({"session": a["id"], "expected": expected, "confirmed": got})
    return ok


def compare(a: dict, b: dict, report: dict) -> None:
    if a.get("error") or b.get("error"):
        # the reference names a row the runtime has not shown (the rewrite of the build removes such a
        # session): it cannot be driven by its reference calls in either mode
        report["errors"].append((a["id"], a.get("error"), b.get("error")))
        return
    report["sessions"] += 1
    mismatch = False
    ca, cb = canon(a), canon(b)
    steps_a = [(ti, si, st) for ti, t in enumerate(a["turns"]) for si, st in enumerate(t["steps"])]
    steps_b = [(ti, si, st) for ti, t in enumerate(b["turns"]) for si, st in enumerate(t["steps"])]
    if [(t, s) for t, s, _ in steps_a] != [(t, s) for t, s, _ in steps_b]:
        report["shape"].append(f"{a['id']}: {len(steps_a)} vs {len(steps_b)} steps")
        return
    for index, ((ti, si, sa), (_, _, sb)) in enumerate(zip(steps_a, steps_b)):
        ra, rb = sa["response"], sb["response"]
        report["steps"] += 1
        write = is_write(sa) or is_write(sb)
        raw = raw_of(ra) == raw_of(rb)
        same = ca[index] == cb[index]
        group = "writes" if write else "reads"
        report[group] += 1
        report[group + "_same"] += same
        report[group + "_raw"] += raw
        if not same:
            mismatch = True
            eff = ra.get("effect") or {}
            key = (eff.get("verb") or (rb.get("effect") or {}).get("verb") or "?", first_diff(ca[index], cb[index]))
            report["diff_kinds"][key] += 1
            report["diffs"].append({"session": a["id"], "turn": ti + 1, "step": si + 1, "kind": key,
                                    "model": sa.get("model"), "run": ra, "park": rb})
    if not check_confirms(a, b, report):
        mismatch = True
    report["sessions_same"] += not mismatch


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("worlds", nargs="+")
    parser.add_argument("--vaults", required=True, help="where the seeded vaults live (outside the repo)")
    parser.add_argument("--bin", required=True, help="the nativetools binary under test (B, and A unless --a-bin)")
    parser.add_argument("--a-bin", help="the binary of A (default --bin)")
    parser.add_argument("--a-flags", default="", help="extra `session` flags of A (default: none, writes run)")
    parser.add_argument("--b-flags", default="--writes park", help="extra `session` flags of B")
    parser.add_argument("--jobs", type=int, default=3)
    parser.add_argument("--only", help="comma list of session ids")
    parser.add_argument("--dump", help="write every differing step as JSON lines here")
    parser.add_argument("--show", type=int, default=6, help="differing steps to print in full")
    args = parser.parse_args()
    val = set(json.loads((HERE / "split.json").read_text())["val"])
    if val & set(args.worlds):
        raise SystemExit(f"{sorted(val & set(args.worlds))}: val worlds; the oracle runs the train worlds only")
    vaults = Path(args.vaults)
    lib.VAULTS = vaults
    run.VAULTS = vaults
    total = collections.Counter()
    all_diffs: list[dict] = []
    for world in args.worlds:
        seed(world, vaults, args.bin)
        sessions = load_sessions(world)
        if args.only:
            keep = set(args.only.split(","))
            sessions = [s for s in sessions if s["id"] in keep]
        report = {"sessions": 0, "sessions_same": 0, "steps": 0, "writes": 0, "writes_same": 0, "reads": 0,
                  "reads_same": 0, "writes_raw": 0, "reads_raw": 0,
                  "cards": 0, "cards_same": 0, "card_diffs": [], "errors": [], "shape": [], "diffs": [], "diff_kinds": collections.Counter()}
        a_bin, a_flags = args.a_bin or args.bin, args.a_flags.split()
        b_flags = args.b_flags.split()

        def phase(binary, flags):
            lib.NT = binary  # one binary per phase: the Runtime reads the module global when it starts a process
            with cf.ThreadPoolExecutor(max_workers=args.jobs) as pool:
                return list(pool.map(lambda session: replay(session, binary, flags), sessions))

        runs_a = phase(a_bin, a_flags)
        runs_b = phase(args.bin, b_flags)
        for a, b in zip(runs_a, runs_b):
            compare(a, b, report)
        print(f"{world}: sessions {report['sessions']} (identical {report['sessions_same']}) | steps {report['steps']} | "
              f"write steps {report['writes']} identical {report['writes_same']} (byte for byte {report['writes_raw']}) | "
              f"read steps {report['reads']} identical {report['reads_same']} (byte for byte {report['reads_raw']}) | errors {len(report['errors'])} shape {len(report['shape'])}")
        if report["cards"]:
            print(f"    cards (a turn that ended in a pending write): {report['cards']}, "
                  f"the vault's own after-write text equals Run's: {report['cards_same']}")
            for item in report["card_diffs"][:3]:
                print("    card:", json.dumps(item, ensure_ascii=False)[:600])
        for key, count in report["diff_kinds"].most_common():
            print(f"    {count:5d}  verb={key[0]}  first difference: {key[1]}")
        for item in report["errors"][:5]:
            print("    error:", item)
        for item in report["shape"][:5]:
            print("    shape:", item)
        for key in ("sessions", "sessions_same", "steps", "writes", "writes_same", "writes_raw", "reads", "reads_same",
                    "reads_raw", "cards", "cards_same"):
            total[key] += report[key]
        total["errors"] += len(report["errors"])
        total["shape"] += len(report["shape"])
        all_diffs += report["diffs"]
        for diff in report["diffs"][: args.show]:
            print(json.dumps({k: diff[k] for k in ("session", "turn", "step", "model")}, ensure_ascii=False))
            print("   run :", json.dumps(diff["run"].get("text"), ensure_ascii=False))
            print("   park:", json.dumps(diff["park"].get("text"), ensure_ascii=False))
    print("TOTAL", json.dumps(dict(total)))
    if args.dump:
        with open(args.dump, "w") as handle:
            for diff in all_diffs:
                handle.write(json.dumps(diff, ensure_ascii=False) + "\n")


if __name__ == "__main__":
    main()
