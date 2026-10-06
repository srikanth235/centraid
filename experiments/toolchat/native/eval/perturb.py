"""Message noise over a set: the robustness eval. Rewrites the user message of a share of the turns of any set file in the
sets format (`id`, `set`, `world`, `today`, `me`, `tags`, `turns` of `user`, `gold`, `ref`, `tags`) with the noise of
authored/noise.py, and leaves everything else as it is.

    python3 perturb.py SET.jsonl --out OUT.jsonl --level light|heavy --seed N [--share 1.0] [--ops typo,drop,...] [--verify]

Per turn chosen (probability `--share`, a draw keyed on the seed, the session id and the turn) the message becomes the noisy
one and the turn gains `"noise": {"level", "ops", "clean"}`: `ops` is what changed (authored/noise.py: `typo`, `name`,
`drop`, `apostrophe`, `capital`, `period`, `space`, `fragment`, one dict each) and `clean` the message as it was. A turn no op
applies to is left as it is. The gold, the reference calls and the tags of a turn are never touched, and every session id
gets the suffix `-noise-<level>`, so the perturbed set scores beside the clean one (`score.py RUN --gold OUT.jsonl`).

Gold-preserving by construction: the noise leaves numbers, dates, the SPEC section 14 convention words, the cues of a
decline, every word the runtime reads in a message and every word the gold repeats as text (authored/noise.py says how),
and a name typo is one the runtime still reads as that name, that leaves the rows the reference takes by `$key` in the
block, and that no other name of the world is closer to. The reference run is the proof:
`python3 run.py --set OUT.jsonl --model ref --out RUN.jsonl`, then `python3 score.py RUN.jsonl --gold OUT.jsonl`, must score
100%. `--verify` runs it here (the runtime and the seeded vaults as run.py wants them: NATIVETOOLS, EVAL_VAULTS) and puts a
turn back as it was, the latest noisy turn that could have caused the first failure first, until every session passes; the
count of turns put back by op is printed and written, and OUT is then a set whose reference run is 100% by construction.
The worlds are read as `lib.load_world` reads them (EVAL_WORLDS, then authored/worlds); the names of a world are its rows'
names, nicknames and roles.

`--ops` restricts the draw to some ops (a diagnostic: one op at a time tells which one broke a turn). Prints, and writes
beside OUT as OUT.noise.json, the count of turns and of ops by label.
"""
from __future__ import annotations

import argparse
import collections
import copy
import importlib.util
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import lib  # noqa: E402

_spec = importlib.util.spec_from_file_location("authored_noise", HERE.parent / "authored" / "noise.py")
noise = importlib.util.module_from_spec(_spec)
sys.modules["authored_noise"] = noise
_spec.loader.exec_module(noise)


def perturb_sessions(sessions: list[dict], level: str, seed: int, share: float = 1.0, only=None,
                     names_of=None, keys_of=None) -> tuple[list[dict], dict]:
    """The sessions with noise on a share of their turns, and the counts. `names_of(world)` gives the names of a world and
    `keys_of(world)` its key -> name map (default: the world file `lib.load_world` finds)."""
    names_of = names_of or (lambda w: noise.names_of_world(lib.load_world(w)))
    keys_of = keys_of or (lambda w: noise.key_names(lib.load_world(w)))
    cache: dict[str, object] = {}
    key_cache: dict[str, dict] = {}
    out, ids = [], set()
    for s in sessions:
        if s["world"] not in cache:
            cache[s["world"]] = noise.names_index(names_of(s["world"]))
            key_cache[s["world"]] = keys_of(s["world"])
        plan = noise.plan_turns(s, cache[s["world"]], share, seed, level, only, key_cache[s["world"]])
        t = copy.deepcopy(s)
        t["id"] = f"{s['id']}-noise-{level}"
        if t["id"] in ids:
            raise SystemExit(f"duplicate session id {s['id']}")
        ids.add(t["id"])
        for ti, p in plan.items():
            t["turns"][ti]["user"] = p["text"]
            t["turns"][ti]["noise"] = {"level": level, "ops": p["ops"], "clean": p["clean"]}
        out.append(t)
    return out, counts(out, level, seed, share)


def counts(out: list[dict], level: str, seed: int, share: float) -> dict:
    labels, turns, hit = collections.Counter(), 0, 0
    for t in out:
        turns += len(t["turns"])
        for turn in t["turns"]:
            if "noise" in turn:
                hit += 1
                labels.update(noise.label(op) for op in turn["noise"]["ops"])
    groups = collections.Counter()
    for name, n in labels.items():
        groups[noise.GROUP[name.split(":")[0]]] += n
    return {"level": level, "seed": seed, "share": share, "sessions": len(out), "turns": turns, "turns_perturbed": hit,
            "ops": dict(sorted(labels.items())), "groups": dict(sorted(groups.items()))}


def ref_breaks(session: dict) -> tuple[int | None, str]:
    """Run the reference calls of a session through the runtime and score them against its gold: (the 1-based turn that
    breaks it, why), or (None, "") when it passes. A raise (`ref names $key before the runtime showed it`) is placed by
    the turn the driver was in."""
    import run
    import score

    class TurnRef(run.RefBackend):
        def step(self, transcript, ctx):
            try:
                return super().step(transcript, ctx)
            except Exception as e:  # noqa: BLE001
                e.turn = ctx["turn"] + 1
                raise

    try:
        rec = run.run_session(session, TurnRef())
    except Exception as e:  # noqa: BLE001
        return getattr(e, "turn", None) or 1, repr(e)[:200]
    for ti, t in enumerate(score.score([rec], [session])["sessions"][0]["turns"]):
        if not t["pass"]:
            return ti + 1, "; ".join(t["problems"][:2])[:200]
    return None, ""


def verify_sessions(out: list[dict], breaks=ref_breaks) -> dict:
    """Put noisy turns back, in place, until every session of `out` passes `breaks` (its reference run). Returns what was
    put back: {"checked", "put_back": {op label: n}, "turns": [{session, turn, ops, why}], "clean_fails": [session ids]}."""
    res = {"checked": 0, "put_back": collections.Counter(), "turns": [], "clean_fails": []}
    for s in out:
        if not any("noise" in t for t in s["turns"]):
            continue
        res["checked"] += 1
        while True:
            broke, why = breaks(s)
            if broke is None:
                break
            noisy = [ti for ti, t in enumerate(s["turns"]) if "noise" in t]
            if not noisy:  # the clean session fails by itself: not the noise's doing
                res["clean_fails"].append(s["id"])
                break
            ti = noise.put_back_which(noisy, [broke - 1])
            turn = s["turns"][ti]
            labels = [noise.label(op) for op in turn["noise"]["ops"]]
            res["put_back"].update(labels)
            res["turns"].append({"session": s["id"], "turn": ti + 1, "ops": labels, "why": why})
            turn["user"] = turn.pop("noise")["clean"]
    res["put_back"] = dict(sorted(res["put_back"].items()))
    return res


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("set", help="a set file: one session per line")
    ap.add_argument("--out", required=True)
    ap.add_argument("--level", required=True, choices=noise.LEVELS, help="light: one op per turn, heavy: two or three")
    ap.add_argument("--seed", required=True, type=int)
    ap.add_argument("--share", type=float, default=1.0, help="the share of turns that get noise (default 1.0)")
    ap.add_argument("--ops", help="comma list: only these ops (%s)" % ",".join(noise.OPS))
    ap.add_argument("--verify", action="store_true",
                    help="run the reference calls of every noisy session through the runtime and put back the turns that break it")
    a = ap.parse_args()
    if not 0.0 <= a.share <= 1.0:
        raise SystemExit("--share must be between 0 and 1")
    only = a.ops.split(",") if a.ops else None
    sessions = lib.read_jsonl(a.set)
    out, stats = perturb_sessions(sessions, a.level, a.seed, a.share, only)
    if a.verify:
        planned = {"turns_perturbed": stats["turns_perturbed"], "ops": stats["ops"]}
        stats = {**counts(out, a.level, a.seed, a.share), "planned": planned, "verify": verify_sessions(out)}
    Path(a.out).parent.mkdir(parents=True, exist_ok=True)
    with open(a.out, "w", encoding="utf-8") as fh:
        for t in out:
            fh.write(json.dumps(t, ensure_ascii=False) + "\n")
    Path(str(a.out) + ".noise.json").write_text(json.dumps(stats, indent=1))
    print(f"{a.out}: {stats['sessions']} sessions, {stats['turns_perturbed']} of {stats['turns']} turns perturbed "
          f"({a.level}, seed {a.seed}, share {a.share})")
    print("  by group:", json.dumps(stats["groups"]))
    print("  by op:   ", json.dumps(stats["ops"]))
    if a.verify:
        v = stats["verify"]
        print(f"  verify: {v['checked']} noisy sessions through the reference run, {len(v['turns'])} turns put back "
              f"(planned {stats['planned']['turns_perturbed']}); put back by op: {json.dumps(v['put_back'])}"
              + (f"; clean sessions that fail by themselves: {v['clean_fails']}" if v["clean_fails"] else ""))


if __name__ == "__main__":
    main()
