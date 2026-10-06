"""The scored sets in sets/ (frozen, see FROZEN.md): verify them, and make a new freeze.

    python3 build_sets.py [check] [--sets-dir DIR]                     # the integrity check; prints every sha256
    python3 build_sets.py ref [--out DIR] [--jobs 8] [--sets-dir DIR] [--sets val,test]
                                                                       # reference check: the sets must score 100%
    python3 build_sets.py refreeze --out DIR [--ref-out DIR] [--sets val,test] [--jobs 8] [--sets-dir DIR]
                                                                       # gold from the reference run (SPEC 13)
    python3 build_sets.py freeze-v8 --out DIR [--dry-run] [--sets-dir DIR] [--e2-dir DIR] [--ref-out DIR]
                                    [--jobs 8] [--train-gold 'GLOB' [--per-world N]]
                                                                       # the v8 freeze: fold val, build test from e2
    python3 build_sets.py trainfit --train-gold 'GLOB' [--per-world N] [--keep-ids]   # draw sets/trainfit.jsonl
    python3 build_sets.py pool [LABEL=]FILE ... --out DIR [--seed 0]   # pool sessions, split them into val and test

sets/val.jsonl and sets/test.jsonl are on DISJOINT worlds (v8, D-1044-14): val holds the households every fix is derived
on (A to D, T03, T12, T23), test holds the households nothing was derived on (the e2 worlds E, F, G, blind-authored).
sets/split.json says which source each session came from, and which half of v7 a val session was in. sets/trainfit.jsonl
is a fixed sample of the training sessions (the same count from every train world, about 300 in all), rows as
authored/build.py wrote them. Every fix is derived on val; test is scored only at milestones. The files are the
artefact: they are not rebuilt from sessions/ or authored/sessions/ (the sets carry gold corrections the sources do not),
so `check` compares only the sources' session ids.

check     ids unique within and across the three sets; trainfit ids disjoint from val and test; every `set` field
          right; val and test worlds DISJOINT, no val or test world a train world, trainfit worlds equal to the train
          worlds of authored/split.json with the same count each; split.json matches val and test and the sources
          behind each origin (every val session records the v7 half it was in, every test session has the origin e2);
          every key a gold names exists in its world's keys file; no session of ../data/train.jsonl.gz is in val or
          test, no record of it is on a val or test world, and every trainfit session is in it; each file's sha256
          equals the one recorded in FROZEN.md. Exit 1 on any problem. With --sets-dir DIR (a candidate, e.g. the
          sets/ of a freeze-v8 output) the hashes are printed to record, not compared, and a missing trainfit.jsonl
          is a note, not a problem.
ref       the `ref` backend (the gold's own reference calls) through the runtime over the sets named by --sets
          (default val,test), scored by score.py; exit 1 unless every one scores 100% of sessions and turns. Needs
          NATIVETOOLS and the seeded vaults (seed_worlds.py). --sets-dir reads the files from another directory (a
          refreeze or freeze-v8 output).
refreeze  the reference check, then new gold where the runtime no longer does what the gold says (SPEC 13): the
          reference run of the current runtime over the sets (--ref-out: a finished `ref` output is read, else the
          run goes there; default OUT/ref), and in OUT/val.jsonl and OUT/test.jsonl every stale turn has its gold
          replaced by one accept derived from the run (eval/regen.py: the vocabulary of gold.py, re-scored against the
          run). A stale turn is one that fails its gold, or passes it though a convention says the gold is a
          superseded reading (an ask that names fewer candidates than the runtime offers, an alternative that is the
          reading `status = open` had before D-1044-7). Every other session is copied byte for byte. OUT/changes.json
          lists every changed turn (both sets) with its old and new gold and the convention that explains it (status,
          what-else, ask-options, refusal, bulk-cap, container, status-words, next, last-one; else UNEXPLAINED, which keeps the old gold and exits 1).
          `name-match` is only reported, with the old gold and the derived one: its turn keeps the gold, and the
          exit is 1 (the first call of the reference resolves a name and ends the turn on that row, where the
          authored chain dead-ends on purpose, so the derived effect may be the wrong answer; repair the reference
          calls). OUT/changes.md is the readable list (the test half has session, turn and convention only);
          OUT/summary.json and the printed summary count turns by convention. OUT is never sets/.
freeze-v8 the v8 freeze (D-1044-14), from the v7 pair in --sets-dir (default sets/) and the e2 sources in --e2-dir
          (default sessions/e2) to OUT/sets/{val,test}.jsonl and split.json:
            val   = the v7 val sessions then the v7 test sessions, byte for byte but the `set` field; split.json records
                    for each the origin it had and the half it was in (`v7`). Refused on a pair that is not v7's (the
                    worlds of val and test differ, or split.json is v8's), so the fold is applied once.
            test  = the sessions of the e2 sources (their worlds are neither val's nor a train world): compiled, cut to
                    the keys of the sets, prepared with the conventions and never the fixes (regen.prepare_session
                    with fixes off), the reference run, the gold derived with the conventions as refreeze does
                    (UNEXPLAINED exits 1 and nothing is written to OUT/sets), the output rescored against its own run.
          --dry-run reads, compiles, prepares and validates, prints the plan and writes nothing (no runtime needed).
          --train-gold GLOB also draws OUT/sets/trainfit.jsonl from a train build (with --dry-run: checks the draw is
          possible). OUT must be new or empty; the reference run of an earlier attempt is reused only with --ref-out.
          The sequence to run, in FROZEN.md under v8: seed E F G, freeze-v8, `ref --sets test`, check --sets-dir
          OUT/sets, copy, trainfit, record the hashes, check.
trainfit  seed 0, the same number of sessions from every train world (--per-world; default round(300 / worlds): 12
          for 25 worlds, 9 for 35), spread over the world's session lengths (min(turns, 5)), from the per-world
          .gold.jsonl files GLOB matches (an authored/build.py output; a .report.json beside a file limits the draw to
          the sessions that verified). --keep-ids keeps the ids of the existing file and only refreshes their rows from
          the new build: that is how a rebuilt train set keeps the same sample.
pool      all sessions of the FILEs, cut to the gold.py keys, split half and half at random inside every
          world x min(turns, 5) stratum into DIR/val.jsonl, DIR/test.jsonl and DIR/split.json. LABEL names where the
          sessions of a FILE came from; without one a session keeps the origin a split.json beside its file records,
          else the file stem is its origin. The same files and seed give the same bytes. (v4 pooled and split this
          way; v8 does not: test is its own worlds.)
"""

from __future__ import annotations

import argparse
import collections
import contextlib
import glob
import gzip
import hashlib
import io
import json
import random
import re
import shutil
import subprocess
import sys
import tempfile
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path

HERE = Path(__file__).resolve().parent
SETS = HERE / "sets"
E2 = HERE / "sessions" / "e2"  # the sources of the test set: blind-authored sessions on the held-out worlds E, F, G
TRAIN = HERE.parent / "data" / "train.jsonl.gz"
sys.path.insert(0, str(HERE))
sys.path.append(str(HERE.parent / "authored"))  # last: authored/ has modules named like the standard library's

import gold  # noqa: E402
import regen  # noqa: E402
import score  # noqa: E402
import split  # noqa: E402
from lib import load_keys, read_jsonl  # noqa: E402

SET_FIELD = {"val": "val", "test": "test", "trainfit": "train"}  # the `set` value of each file's sessions
FILES = ["val.jsonl", "test.jsonl", "trainfit.jsonl", "split.json"]
SESSION_KEYS = ["id", "set", "world", "today", "me", "tags", "turns"]
TURN_KEYS = ["user", "gold", "ref", "tags"]
STRATA = "world x min(len,5)"
SHOWN = 30  # problems printed before the rest is only counted
TRAINFIT_TARGET = 300  # sessions in trainfit, about: the same count from every train world
TEST_ORIGINS = ("e2",)  # the origins a session of the test set can have (v8): none of them is a val origin


# ---------------------------------------------------------------------------------------------
# check
# ---------------------------------------------------------------------------------------------


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def recorded_hashes() -> dict[str, str]:
    """The `<sha256>  sets/<file>` lines of FROZEN.md."""
    text = (HERE / "FROZEN.md").read_text(encoding="utf-8")
    return {m.group(2): m.group(1) for m in re.finditer(r"^([0-9a-f]{64})  sets/(\S+)$", text, re.M)}


def train_data() -> tuple[set[str], set[str]]:
    """The session ids (a record's id is `train-<session id>`) and the worlds of data/train.jsonl.gz."""
    ids: set[str] = set()
    worlds: set[str] = set()
    with gzip.open(TRAIN, "rt", encoding="utf-8") as handle:
        for line in handle:
            if line.strip():
                record = json.loads(line)
                ids.add(record["id"].split("-", 1)[1])
                if record.get("world"):
                    worlds.add(record["world"])
    return ids, worlds


def train_ids() -> set[str]:
    """Session ids of data/train.jsonl.gz."""
    return train_data()[0]


def compile_sessions(files: list[Path]) -> list[dict]:
    """The sessions the eval-vocabulary source files define (gold.py compiles them, in order), as plain copies. A source
    is executed from its text, never through the bytecode cache: a file edited twice in a second and of the same size
    would otherwise compile as it was, and no `__pycache__` is written beside the sources."""
    gold._SESSIONS.clear()
    try:
        for n, path in enumerate(files):
            namespace = {"__name__": f"source_{n}_{path.stem}", "__file__": str(path)}
            exec(compile(path.read_text(encoding="utf-8"), str(path), "exec"), namespace)  # noqa: S102
        return json.loads(json.dumps(gold.sessions()))
    finally:
        gold._SESSIONS.clear()


def compile_ids(files: list[Path]) -> list[str]:
    """The session ids the eval-vocabulary source files define."""
    return [s["id"] for s in compile_sessions(files)]


def val_world_ids() -> list[str]:
    return [s["id"] for w in split.val_worlds() for s in split.load_sessions(w)]


def hand_written_ids() -> list[str]:
    return compile_ids([HERE / "sessions" / f"{name}.py" for name in ("A", "B", "C", "D_dev", "D_test")])


def e1_ids() -> list[str]:
    return compile_ids(sorted((HERE / "sessions" / "e1").glob("*.py")))


def e2_files() -> list[Path]:
    return sorted(E2.glob("*.py"))


def e2_ids() -> list[str]:
    return compile_ids(e2_files())


# split.json origin -> (the sources behind it, the session ids they define). A new freeze adds its origins here.
ORIGINS = {
    "val-v3.1": ("authored/sessions of the val worlds", val_world_ids),
    "test-v3.1": ("eval/sessions/{A,B,C,D_dev,D_test}.py", hand_written_ids),
    "e1": ("eval/sessions/e1/*.py", e1_ids),
    "e2": ("eval/sessions/e2/*.py", e2_ids),
}


@lru_cache(maxsize=None)
def keys_of(world: str) -> dict[str, dict]:
    return load_keys(world)


def gold_names(accept: dict) -> list[str]:
    """The world keys one accepted effect names."""
    names = list(accept.get("rows", [])) + list(accept.get("candidates", [])) + list(accept.get("already", []))
    for row in accept.get("diff", {}).get("rows", []):
        if "key" in row:
            names.append(row["key"])
    for link in accept.get("diff", {}).get("links", []):
        names += [x for x in (link["from"], link["to"]) if x != "new"]
    names += [r["key"] for r in accept.get("reveal", [])]
    return names


def unknown_keys(session: dict) -> list[str]:
    """Names in the session's gold that its world's keys file does not know ("+n" = a row created earlier)."""
    keys = keys_of(session["world"])
    return [name for turn in session["turns"] for accept in turn["gold"] for name in gold_names(accept)
            if name not in keys and not name.startswith("+")]


def count_line(name: str, sessions: list[dict]) -> str:
    turns = sum(len(s["turns"]) for s in sessions)
    worlds = collections.Counter(s["world"] for s in sessions)
    if not worlds:
        return f"{name:<9} {0:>4} sessions {0:>5} turns  no world"
    lo, hi = min(worlds.values()), max(worlds.values())
    if len(worlds) <= 10:
        shown = f"worlds {dict(sorted(worlds.items()))}"
    else:
        shown = f"{len(worlds)} worlds x {lo}" if lo == hi else f"{len(worlds)} worlds, {lo} to {hi} each"
    return f"{name:<9} {len(sessions):>4} sessions {turns:>5} turns  {shown}"


def world_problems(sets: dict[str, list[dict]], train: set[str]) -> list[str]:
    """What is wrong with the worlds of the sets (D-1044-14): val and test share a world (test is held out of val's
    households whole), a set has no session, val or test has sessions of a train world, trainfit does not hold exactly
    the train worlds or holds an uneven count per world."""
    problems: list[str] = []
    worlds = {name: collections.Counter(s["world"] for s in sessions) for name, sessions in sets.items()}
    for w in sorted(set(worlds["val"]) & set(worlds["test"])):
        problems.append(f"val and test both have sessions of the world {w}: test is held out of val's worlds whole")
    for name in ("val", "test"):
        if not sets[name]:
            problems.append(f"{name} has no session")
        for w in sorted(train & set(worlds[name])):
            problems.append(f"{name} has sessions of the train world {w}")
    if "trainfit" in sets:
        if set(worlds["trainfit"]) != train:
            problems.append(f"trainfit worlds differ from the train worlds of authored/split.json "
                            f"(missing {sorted(train - set(worlds['trainfit']))}, "
                            f"extra {sorted(set(worlds['trainfit']) - train)})")
        if len(set(worlds["trainfit"].values())) > 1:
            problems.append(f"trainfit has an uneven count per world: {dict(sorted(worlds['trainfit'].items()))}")
    return problems


def assign_problems(assign: dict[str, dict], member: dict[str, str]) -> list[str]:
    """What is wrong with the per-session records of split.json against the sets they describe, one line per kind with
    the count and the first ids: the ids differ, a session is in the other set, a test session has an origin that is
    not a test origin (or a v7 half: it was not in v7), a val session has a test origin or does not record the v7 half
    it was in."""
    problems: list[str] = []
    if set(assign) != set(member):
        problems.append(f"split.json names {len(set(assign) - set(member))} ids that are in neither val nor test "
                        f"and misses {len(set(member) - set(assign))} that are")
    wrong: dict[str, list[str]] = collections.defaultdict(list)
    for sid, a in sorted(assign.items()):
        if sid not in member:
            continue
        if a["set"] != member[sid]:
            wrong[f"sessions that split.json puts in the other set (it says {a['set']}, the file is "
                  f"{member[sid]})"].append(sid)
        elif a["set"] == "test":
            if a["origin"] not in TEST_ORIGINS:
                wrong[f"test sessions whose origin is not a test origin ({'/'.join(TEST_ORIGINS)})"].append(sid)
            if "v7" in a:
                wrong["test sessions that record a v7 half (test is new in v8)"].append(sid)
        else:
            if a["origin"] in TEST_ORIGINS:
                wrong[f"val sessions with a test origin ({'/'.join(TEST_ORIGINS)})"].append(sid)
            if a.get("v7") not in ("val", "test"):
                wrong["val sessions that do not record the v7 half they were in (`v7`: val or test)"].append(sid)
    problems += [f"{len(ids)} {what}, e.g. {', '.join(ids[:3])}" for what, ids in wrong.items()]
    return problems


def check(sets_dir: Path = SETS) -> int:
    """The integrity check of the files in `sets_dir`. For sets/ itself it also compares every file's sha256 with the
    one FROZEN.md records and wants all four files; for a candidate directory (a freeze-v8 output) it prints the hashes
    to record, and a missing trainfit.jsonl is a note."""
    final = sets_dir.resolve() == SETS.resolve()
    problems: list[str] = []
    for fname in FILES if final else [f for f in FILES if f != "trainfit.jsonl"]:
        if not (sets_dir / fname).exists():
            raise SystemExit(f"missing {sets_dir / fname}")
    sets = {name: read_jsonl(sets_dir / f"{name}.jsonl") for name in SET_FIELD
            if (sets_dir / f"{name}.jsonl").exists()}
    if "trainfit" not in sets:
        print("trainfit.jsonl is not in the directory: it is drawn after the train regeneration "
              "(build_sets.py trainfit)")

    where: dict[str, list[str]] = collections.defaultdict(list)
    for name, sessions in sets.items():
        for s in sessions:
            where[s["id"]].append(name)
            if s["set"] != SET_FIELD[name]:
                problems.append(f"{name}: {s['id']} has set {s['set']!r}, want {SET_FIELD[name]!r}")
    for sid, names in sorted(where.items()):
        if len(names) > 1:
            problems.append(f"id {sid} occurs {len(names)} times ({', '.join(names)})")

    problems += world_problems(sets, set(split.train_worlds()))

    if not TRAIN.exists():
        problems.append(f"{TRAIN} is missing")
    else:
        trained, trained_worlds = train_data()
        scored = {s["id"]: name for name in ("val", "test") for s in sets[name]}
        problems += [f"{sid} is in data/train.jsonl.gz and in {scored[sid]}" for sid in sorted(trained & set(scored))]
        for name in ("val", "test"):  # the worlds are held out of the training data, not only the sessions
            problems += [f"data/train.jsonl.gz has records of the world {w}, a {name} world"
                         for w in sorted(trained_worlds & {s["world"] for s in sets[name]})]
        problems += [f"trainfit: {s['id']} is not in data/train.jsonl.gz" for s in sets.get("trainfit", [])
                     if s["id"] not in trained]

    meta = json.loads((sets_dir / "split.json").read_text(encoding="utf-8"))
    assign = meta["assign"]
    member = {s["id"]: name for name in ("val", "test") for s in sets[name]}
    problems += assign_problems(assign, member)
    by_origin: dict[str, set[str]] = collections.defaultdict(set)
    for sid, a in assign.items():
        by_origin[a["origin"]].add(sid)
    for origin in sorted(set(by_origin) | set(ORIGINS)):
        if origin not in ORIGINS:
            problems.append(f"split.json has the origin {origin!r}: add its sources to ORIGINS in build_sets.py")
            continue
        have, want = by_origin.get(origin, set()), ORIGINS[origin][1]()
        if sorted(have) != sorted(want):  # an origin with no session and no source (e2 before v8) is nothing
            problems.append(f"origin {origin}: split.json has {len(have)} sessions, its sources "
                            f"{ORIGINS[origin][0]} define {len(want)} "
                            f"({len(set(want) - have)} missing, {len(have - set(want))} extra)")

    for name, sessions in sets.items():
        for s in sessions:
            try:
                problems += [f"{name}: {s['id']}: gold names the unknown key {k!r}" for k in unknown_keys(s)]
            except FileNotFoundError as error:
                problems.append(f"{name}: {s['id']}: no keys file {error.filename}; run seed_worlds.py")

    for name, sessions in sets.items():
        print(count_line(name, sessions))
    print(f"split.json: seed {meta['seed']}, strata {meta['strata']}" + (f", version {meta['version']}"
                                                                         if "version" in meta else ""))
    table = collections.Counter((a["origin"], a["set"]) for a in assign.values())
    print(f"{'origin':<10} {'val':>4} {'test':>5}   sources")
    for origin in sorted(by_origin):
        source = ORIGINS.get(origin, ("?",))[0]
        print(f"{origin:<10} {table[origin, 'val']:>4} {table[origin, 'test']:>5}   {source}")
    folded = collections.Counter(a["v7"] for a in assign.values() if a["set"] == "val" and "v7" in a)
    if folded:
        print(f"val by the half it was in at v7: {dict(sorted(folded.items()))}")

    recorded = recorded_hashes() if final else {}
    print("sha256")
    for fname in FILES:
        if not (sets_dir / fname).exists():
            continue
        digest = sha256(sets_dir / fname)
        print(f"{digest}  sets/{fname}")
        if final and recorded.get(fname) != digest:
            problems.append(f"sets/{fname} is not the file FROZEN.md records (recorded "
                            f"{recorded.get(fname, 'nothing')[:12]}, found {digest[:12]}): a changed set is a new "
                            f"version, see FROZEN.md")

    for line in problems[:SHOWN]:
        print(f"FAIL {line}", file=sys.stderr)
    if len(problems) > SHOWN:
        print(f"FAIL ... and {len(problems) - SHOWN} more", file=sys.stderr)
    print(f"{len(problems)} problems" if problems else f"ok: {sum(map(len, sets.values()))} sessions checked")
    return 1 if problems else 0


# ---------------------------------------------------------------------------------------------
# ref
# ---------------------------------------------------------------------------------------------


def step(cmd: list[str], log: Path) -> None:
    """Run a command with its output in `log`; when it fails, show the end of the log and stop."""
    with open(log, "w", encoding="utf-8") as handle:
        done = subprocess.run(cmd, stdout=handle, stderr=subprocess.STDOUT, check=False)
    if done.returncode:
        tail = "\n".join(log.read_text(encoding="utf-8").splitlines()[-5:])
        raise SystemExit(f"{Path(cmd[1]).name} failed ({done.returncode}), log {log}:\n{tail}")


def ref(out: Path | None, jobs: int, sets_dir: Path = SETS, names: tuple[str, ...] = ("val", "test")) -> int:
    """run.py --model ref and score.py over the named sets (val, then test). Run files, reports and logs stay in `out`
    (default: a temporary directory, removed when every set passes). `sets_dir` holds val.jsonl and test.jsonl."""
    work = out or Path(tempfile.mkdtemp(prefix="build_sets-ref-"))
    work.mkdir(parents=True, exist_ok=True)
    ok = True
    for name in names:
        gold_file = sets_dir / f"{name}.jsonl"
        run_file, report_file = work / f"{name}.run.jsonl", work / f"{name}.report.json"
        step([sys.executable, str(HERE / "run.py"), "--set", str(gold_file), "--model", "ref", "--out", str(run_file),
              "--jobs", str(jobs)], work / f"{name}.run.log")
        step([sys.executable, str(HERE / "score.py"), str(run_file), "--gold", str(gold_file), "--json",
              str(report_file)], work / f"{name}.score.log")
        r = json.loads(report_file.read_text(encoding="utf-8"))
        passed = r["session_pass"] == r["sessions"] and r["turn_pass"] == r["turns"]
        verdict = "" if passed else f"  FAIL, see {report_file}"
        print(f"{name}: sessions {r['session_pass']}/{r['sessions']}, turns {r['turn_pass']}/{r['turns']}{verdict}",
              flush=True)
        ok &= passed
    if out is None and ok:
        shutil.rmtree(work)
    return 0 if ok else 1


# ---------------------------------------------------------------------------------------------
# refreeze
# ---------------------------------------------------------------------------------------------


def cell(text: object) -> str:
    return str(text).replace("|", "\\|").replace("\n", " ")


def changes_markdown(changes: dict[str, list[dict]], summary: dict[str, dict], ref_dir: Path) -> str:
    """The readable change list: every changed turn of val with its message and gold, of test its session, turn and
    convention only (nobody opens the test half)."""
    lines = ["# Refreeze change list", "",
             f"Reference run: `{ref_dir}`. Gold is derived by running the reference calls through the runtime "
             "(SPEC 13, D-1044-11). A turn whose reference run fails its gold, or passes it though a convention says "
             "the gold is a superseded reading, has its gold replaced by one accept derived from the run. An "
             "UNEXPLAINED turn keeps its gold. A `name-match` turn is only reported and keeps its gold: its "
             "derived effect may be the wrong answer, so its reference calls are repaired at the source.",
             ""]
    for name, s in summary.items():
        by = ", ".join(f"{k} {v}" for k, v in s["by_convention"].items()) or "none"
        lines.append(f"- {name}: {s['turns_changed']} of {s['turns']} turns changed in {s['sessions_touched']} of "
                     f"{s['sessions']} sessions ({s['failed_the_old_gold']} failed the old gold, "
                     f"{s['tightened_though_passing']} passed it and were tightened); by convention: {by}; "
                     f"UNEXPLAINED {s['unexplained']}; name-match (reported, gold kept) {s['name_match']}")
    for name, rows in changes.items():
        lines += ["", f"## {name}", ""]
        rows = sorted(rows, key=lambda r: (r["applied"], r["convention"] != regen.UNEXPLAINED, r["convention"], r["id"],
                                           r["turn"]))
        if not rows:
            lines.append("No turn changed.")
        elif name == "test":
            lines += ["| session | turn | convention |", "| --- | --- | --- |"]
            lines += [f"| {r['id']} | {r['turn']} | {r['convention']}{'' if r['applied'] else ' (not applied)'} |"
                      for r in rows]
        else:
            lines += ["| convention | session | turn | user | old gold | new gold | why |",
                      "| --- | --- | --- | --- | --- | --- | --- |"]
            for r in rows:
                why = r["evidence"] or r["note"]
                if r["applied"] and not r["was_failing"]:
                    why += " (the old gold still passed)"
                if r["held"]:
                    why += " (reported only, the gold stays)"
                for label in ("carried", "dropped"):
                    if r[label]:
                        why += f"; {label}: {', '.join(r[label])}"
                new = regen.show_gold(r["new_gold"]) + ("" if r["applied"] else " (derived, not applied)")
                lines.append("| " + " | ".join(cell(x) for x in (
                    r["convention"], r["id"], r["turn"], r["user"], regen.show_gold(r["old_gold"]), new, why)) + " |")
    return "\n".join(lines) + "\n"


def refreeze(out: Path, ref_out: Path | None, names: list[str], jobs: int, sets_dir: Path) -> int:
    """The gold of val and test from the reference run of the current runtime (eval/regen.py), written to `out`.
    Exit 1 when a change is UNEXPLAINED or the output does not score as it should against the run."""
    if out.resolve() == SETS.resolve():
        raise SystemExit("write the refreeze to another directory, check it, then copy it into sets/ (FROZEN.md)")
    out.mkdir(parents=True, exist_ok=True)
    work = ref_out or out / "ref"
    work.mkdir(parents=True, exist_ok=True)
    changes: dict[str, list[dict]] = {}
    summary: dict[str, dict] = {}
    ok = True
    for name in names:
        gold_file = sets_dir / f"{name}.jsonl"
        run_file = work / f"{name}.run.jsonl"
        if run_file.exists():
            print(f"{name}: reference run read from {run_file}", flush=True)
        else:
            step([sys.executable, str(HERE / "run.py"), "--set", str(gold_file), "--model", "ref", "--out",
                  str(run_file), "--jobs", str(jobs)], work / f"{name}.run.log")
        runs = {r["id"]: r for r in read_jsonl(run_file)}
        lines = [line for line in gold_file.read_text(encoding="utf-8").split("\n") if line.strip()]
        sessions = [json.loads(line) for line in lines]
        broken = [s["id"] for s in sessions if s["id"] not in runs or runs[s["id"]].get("error")
                  or len(runs[s["id"]]["turns"]) != len(s["turns"])]
        if broken:
            raise SystemExit(f"{run_file} has no complete run of {len(broken)} sessions of {gold_file}, "
                             f"e.g. {broken[:3]}")
        new_sessions, rows = [], []
        with open(out / f"{name}.jsonl", "w", encoding="utf-8") as handle:
            for line, s in zip(lines, sessions):
                new, found = regen.regen_session(s, runs[s["id"]])
                handle.write((line if new is s else json.dumps(new, ensure_ascii=False)) + "\n")
                new_sessions.append(new)
                rows += found
        turns = sum(len(s["turns"]) for s in sessions)
        changes[name] = rows
        summary[name] = regen.summarize(rows, len(sessions), turns)
        s = summary[name]
        by = ", ".join(f"{k} {v}" for k, v in s["by_convention"].items()) or "none"
        print(f"{name}: {s['sessions']} sessions, {turns} turns; {s['turns_changed']} turns changed in "
              f"{s['sessions_touched']} sessions ({s['failed_the_old_gold']} failed the old gold, "
              f"{s['tightened_though_passing']} passed it and were tightened); by convention: {by}; "
              f"UNEXPLAINED {s['unexplained']} {s['unexplained_ids'][:10] or ''}; "
              f"name-match (reported, gold kept) {s['name_match']} {s['name_match_ids'][:10] or ''}", flush=True)
        scored = score.score([runs[s["id"]] for s in sessions], new_sessions)["sessions"]
        passed_s = sum(x["pass"] for x in scored)
        passed_t = sum(t["pass"] for x in scored for t in x["turns"])
        s["rescore"] = {"sessions": [passed_s, len(scored)], "turns": [passed_t, turns]}
        # the output passes its own run, except for the turns that kept their gold: nothing explains the change, or
        # it is a name-match, which is only reported
        kept = s["unexplained"] + s["name_match"]
        good = turns - passed_t == kept
        print(f"{name}: rescored against the run: sessions {passed_s}/{len(scored)}, turns {passed_t}/{turns}"
              f"{'' if good else '  FAIL: the output does not pass its own run'}", flush=True)
        ok &= good and not kept
    (out / "changes.json").write_text(json.dumps(changes, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    (out / "changes.md").write_text(changes_markdown(changes, summary, work), encoding="utf-8")
    (out / "summary.json").write_text(json.dumps(summary, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"wrote {out}/{{{','.join(names)}}}.jsonl, changes.md, changes.json, summary.json")
    return 0 if ok else 1


# ---------------------------------------------------------------------------------------------
# trainfit
# ---------------------------------------------------------------------------------------------


def verified(gold_path: Path) -> set[str] | None:
    """Ids that verified in the build, from the .report.json beside the gold file (None: no report)."""
    report = gold_path.with_name(gold_path.name.replace(".gold.jsonl", ".report.json"))
    if not report.exists():
        return None
    return {r["id"] for r in json.loads(report.read_text(encoding="utf-8")) if r["pass"]}


def draw(pool: list[dict], n: int, rng: random.Random) -> list[str]:
    """n ids spread evenly over the pool's strata (min(turns, 5)): the strata in order, each shuffled, then every
    (len/n)-th session of that list."""
    if len(pool) < n:
        raise SystemExit(f"{pool[0]['world'] if pool else '?'}: {len(pool)} sessions, fewer than {n}")
    strata: dict[int, list[str]] = collections.defaultdict(list)
    for s in sorted(pool, key=lambda s: s["id"]):
        strata[min(len(s["turns"]), 5)].append(s["id"])
    ordered: list[str] = []
    for k in sorted(strata):
        rng.shuffle(strata[k])
        ordered += strata[k]
    return [ordered[int((j + 0.5) * len(ordered) / n)] for j in range(n)]


def default_per_world(worlds: int) -> int:
    """The sessions drawn from each train world: the count that keeps the sample nearest TRAINFIT_TARGET (12 for the 25
    train worlds of v6, 9 for the 35 of v8: 315 sessions, where 8 would be 280)."""
    return max(1, round(TRAINFIT_TARGET / worlds))


def train_pools(train_gold: str) -> tuple[dict[str, list[dict]], dict[str, str]]:
    """The sessions of every train world that verified in the build (the per-world <W>.gold.jsonl files GLOB matches, a
    .report.json beside a file limiting them to the ones that passed), and the gold row of each, by id."""
    files = {Path(f).name.split(".")[0]: Path(f) for f in sorted(glob.glob(train_gold)) if f.endswith(".gold.jsonl")}
    worlds = split.train_worlds()
    missing = [w for w in worlds if w not in files]
    if missing:
        raise SystemExit(f"{train_gold}: no <W>.gold.jsonl for {', '.join(missing)}")
    pools: dict[str, list[dict]] = {}
    line_of: dict[str, str] = {}
    for w in worlds:
        ok = verified(files[w])
        pools[w] = []
        for line in files[w].read_text(encoding="utf-8").splitlines():
            if line.strip():
                s = json.loads(line)
                if ok is None or s["id"] in ok:
                    line_of[s["id"]] = line
                    pools[w].append(s)
    return pools, line_of


def trainfit(train_gold: str, out: Path, per_world: int | None, seed: int, keep_ids: bool) -> int:
    worlds = split.train_worlds()
    per_world = per_world or default_per_world(len(worlds))
    pools, line_of = train_pools(train_gold)
    if keep_ids and not out.exists():
        raise SystemExit(f"--keep-ids needs the existing sample {out}")
    wanted = [s["id"] for s in read_jsonl(out)] if keep_ids else None
    rng = random.Random(seed)
    chosen: list[str] = []
    if wanted is None:
        for w in worlds:
            position = {s["id"]: i for i, s in enumerate(pools[w])}
            chosen += sorted(draw(pools[w], per_world, rng), key=position.__getitem__)  # gold file order
    else:
        gone = [i for i in wanted if i not in line_of]
        if gone:
            raise SystemExit(f"{len(gone)} sampled sessions are not among the verified sessions of the new build, "
                             f"e.g. {gone[:3]}; draw a new sample")
        chosen = wanted
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text("".join(line_of[i] + "\n" for i in chosen), encoding="utf-8")
    print(count_line("trainfit", [json.loads(line_of[i]) for i in chosen]), f"-> {out}")
    if wanted is None:
        print(f"{len(worlds)} train worlds x {per_world} = {len(chosen)} sessions (target about {TRAINFIT_TARGET})")
    shown = f"sets/{out.name}" if out.parent.resolve() == SETS.resolve() else str(out)
    print(f"{sha256(out)}  {shown}   (record it in FROZEN.md)")
    return 0


def trainfit_plan(train_gold: str, per_world: int | None) -> tuple[str, list[str]]:
    """What a trainfit draw from the build would be, without drawing: (one line, problems): the train worlds, the count
    drawn from each, the total, and every world whose build has fewer verified sessions than that."""
    worlds = split.train_worlds()
    per_world = per_world or default_per_world(len(worlds))
    try:
        pools, _ = train_pools(train_gold)
    except SystemExit as error:
        return f"trainfit: {len(worlds)} train worlds x {per_world}", [str(error)]
    short = [f"{w}: {len(pools[w])} verified sessions, fewer than {per_world}" for w in worlds
             if len(pools[w]) < per_world]
    return (f"trainfit: {len(worlds)} train worlds x {per_world} = {len(worlds) * per_world} sessions "
            f"(target about {TRAINFIT_TARGET}), {min(map(len, pools.values()))} to {max(map(len, pools.values()))} "
            f"verified sessions per world", short)


# ---------------------------------------------------------------------------------------------
# pool
# ---------------------------------------------------------------------------------------------


def project(s: dict) -> dict:
    """The session cut to the keys of the scored sets."""
    out = {k: s[k] for k in SESSION_KEYS}
    out["turns"] = [{k: t[k] for k in TURN_KEYS} for t in s["turns"]]
    return out


def origins_beside(path: str) -> dict[str, str]:
    """session id -> origin, from the split.json next to the file (empty when there is none)."""
    meta = Path(path).with_name("split.json")
    if not meta.exists():
        return {}
    return {sid: a["origin"] for sid, a in json.loads(meta.read_text(encoding="utf-8"))["assign"].items()}


def pool(inputs: list[str], out: Path, seed: int) -> int:
    """All sessions of the inputs, split half and half inside every (world, min(turns, 5)) stratum."""
    if out.resolve() == SETS.resolve():
        raise SystemExit("write the pool to another directory, check it, then copy it into sets/ (FROZEN.md)")
    sessions: list[dict] = []
    origin: dict[str, str] = {}
    for item in inputs:
        label, eq, path = item.partition("=")
        if not eq:
            label, path = Path(item).stem, item
        known = {} if eq else origins_beside(path)
        for s in read_jsonl(path):
            if s["id"] in origin:
                raise SystemExit(f"id {s['id']} is in both {origin[s['id']]} and {label}")
            origin[s["id"]] = known.get(s["id"], label)
            sessions.append(project(s))
    strata: dict[tuple[str, int], list[dict]] = collections.defaultdict(list)
    for s in sorted(sessions, key=lambda s: s["id"]):
        strata[s["world"], min(len(s["turns"]), 5)].append(s)
    rng = random.Random(seed)
    halves: dict[str, list[dict]] = {"val": [], "test": []}
    flip = 0
    for key in sorted(strata):
        members = strata[key]
        rng.shuffle(members)
        half = len(members) // 2
        if len(members) % 2:  # the odd session goes to val and test in turn
            half += flip
            flip ^= 1
        halves["val"] += members[:half]
        halves["test"] += members[half:]
    out.mkdir(parents=True, exist_ok=True)
    assign: dict[str, dict] = {}
    for name, members in halves.items():
        with open(out / f"{name}.jsonl", "w", encoding="utf-8") as handle:
            for s in members:
                s["set"] = name
                assign[s["id"]] = {"set": name, "origin": origin[s["id"]]}
                handle.write(json.dumps(s, ensure_ascii=False) + "\n")
    (out / "split.json").write_text(json.dumps({"seed": seed, "strata": STRATA, "assign": assign}, indent=0),
                                    encoding="utf-8")
    for name, members in halves.items():
        origins = collections.Counter(assign[s["id"]]["origin"] for s in members)
        print(count_line(name, members), dict(sorted(origins.items())))
    for fname in ("val.jsonl", "test.jsonl", "split.json"):
        print(f"{sha256(out / fname)}  sets/{fname}")
    return 0


# ---------------------------------------------------------------------------------------------
# freeze-v8: val is the v7 pair folded, test is the e2 worlds (D-1044-14)
# ---------------------------------------------------------------------------------------------


def read_lines(path: Path) -> list[str]:
    """The session lines of a jsonl file, as they are written."""
    return [line for line in path.read_text(encoding="utf-8").split("\n") if line.strip()]


TEST_HEAD = re.compile(r'^\{"id": "[^"]*", "set": "test", ')


def fold_line(line: str) -> str:
    """A session line of the test set of v7 as a line of the val set of v8: the `set` field changes and nothing else,
    not a byte of the gold."""
    if TEST_HEAD.match(line):
        return line.replace('"set": "test"', '"set": "val"', 1)
    session = json.loads(line)
    session["set"] = "val"
    return json.dumps(session, ensure_ascii=False)


@dataclass
class V8Plan:
    """What freeze-v8 would write: the val set (session lines, as written), the split.json `assign` of its sessions, the
    test sessions (the e2 sources cut to the keys of the sets), and everything that is wrong."""

    val_lines: list[str] = field(default_factory=list)
    assign: dict[str, dict] = field(default_factory=dict)
    seed: int = 0
    strata: str = STRATA
    test: list[dict] = field(default_factory=list)
    prepared: list[dict] = field(default_factory=list)  # what the conventions rewrite in the test sessions
    problems: list[str] = field(default_factory=list)


def fold_v7(sets_dir: Path, plan: V8Plan) -> None:
    """The val set of v8 from the v7 pair in `sets_dir`: the v7 val sessions, then the v7 test sessions, each as written
    but for the `set` field, and for each the origin it had and the half it was in (`v7`). Refused for a pair that is
    not v7's (the worlds of val and test differ, or split.json is already v8's): the fold is applied once."""
    for fname in ("val.jsonl", "test.jsonl"):
        if not (sets_dir / fname).exists():
            plan.problems.append(f"{sets_dir} has no {fname}")
    # a refreeze output holds no split.json: the halves keep their members, so sets/split.json says where they came from
    split_json = sets_dir / "split.json" if (sets_dir / "split.json").exists() else SETS / "split.json"
    if not split_json.exists():
        plan.problems.append(f"no split.json in {sets_dir} or sets/")
    if plan.problems:
        return
    lines = {name: read_lines(sets_dir / f"{name}.jsonl") for name in ("val", "test")}
    sessions = {name: [json.loads(line) for line in lines[name]] for name in lines}
    meta = json.loads(split_json.read_text(encoding="utf-8"))
    assign = meta["assign"]
    if meta.get("version", 7) >= 8 or any(a["origin"] in TEST_ORIGINS for a in assign.values()):
        plan.problems.append(f"{sets_dir} holds the sets of v8: the fold is applied once, to the pair of v7")
    worlds = {name: {s["world"] for s in sessions[name]} for name in sessions}
    if worlds["val"] != worlds["test"]:
        plan.problems.append(f"{sets_dir} is not a pair of v7: val has the worlds {sorted(worlds['val'])}, test has "
                             f"{sorted(worlds['test'])} (the two halves of v7 are on the same worlds)")
    count = collections.Counter(s["id"] for name in sessions for s in sessions[name])
    plan.problems += [f"id {sid} occurs {n} times in the pair of v7" for sid, n in sorted(count.items()) if n > 1]
    for name in sessions:
        plan.problems += [f"{sets_dir / (name + '.jsonl')}: {s['id']} has set {s['set']!r}" for s in sessions[name]
                          if s["set"] != name]
    if set(assign) != set(count):
        plan.problems.append(f"{split_json} names {len(set(assign) - set(count))} ids that are in neither set and "
                             f"misses {len(set(count) - set(assign))} that are")
    if plan.problems:
        return
    for name in ("val", "test"):
        for line, s in zip(lines[name], sessions[name]):
            plan.val_lines.append(line if name == "val" else fold_line(line))
            plan.assign[s["id"]] = {"set": "val", "origin": assign[s["id"]]["origin"], "v7": name}
    plan.seed, plan.strata = meta["seed"], meta["strata"]


def e2_problems(sessions: list[dict], val_worlds: set[str], val_ids: set[str], train: set[str]) -> list[str]:
    """What is wrong with the sessions of the e2 sources as the test set: none, an id that is not the world's `<W>-E001`
    upward or is a val id, a world that is a val world or a train world, a turn with no reference calls, a gold key
    its world's keys file does not have (or no keys file: seed the world)."""
    problems: list[str] = []
    if not sessions:
        return ["the e2 sources define no session"]
    count = collections.Counter(s["id"] for s in sessions)
    problems += [f"e2 id {sid} is defined {n} times" for sid, n in sorted(count.items()) if n > 1]
    for s in sessions:
        sid, world = s["id"], s["world"]
        if world in val_worlds:
            problems.append(f"{sid}: {world} is a val world, test is held out of val's worlds whole")
        if world in train:
            problems.append(f"{sid}: {world} is a train world")
        if sid in val_ids:
            problems.append(f"{sid}: the id is a val id")
        if not re.fullmatch(rf"{re.escape(world)}-E\d+", sid):
            problems.append(f"{sid}: an e2 id is the world's <W>-E001 upward ({world}-E001)")
        problems += [f"{sid} turn {i + 1}: no reference calls" for i, t in enumerate(s["turns"]) if not t.get("ref")]
    for world in sorted({s["world"] for s in sessions}):
        try:
            keys_of(world)
        except FileNotFoundError:
            problems.append(f"world {world}: no keys file; seed it (python3 seed_worlds.py {world})")
            continue
        for s in sessions:
            if s["world"] == world:
                problems += [f"{s['id']}: gold names the unknown key {k!r}" for k in unknown_keys(s)]
    return problems


def plan_v8(sets_dir: Path, e2_dir: Path) -> V8Plan:
    """The v8 freeze as far as it needs no runtime: fold the pair of v7 in `sets_dir`, compile the e2 sources, cut
    their sessions to the keys of the sets, prepare them with the conventions (never the fixes), and validate the result
    with the functions `check` uses. Nothing is written; every problem is in `problems`."""
    plan = V8Plan()
    fold_v7(sets_dir, plan)
    files = sorted(e2_dir.glob("*.py")) if e2_dir.is_dir() else []
    if not files:
        plan.problems.append(f"no e2 source in {e2_dir} (<W>*.py of the held-out worlds)")
        return plan
    try:
        plan.test = [dict(project(s), set="test") for s in compile_sessions(files)]
    except Exception as error:  # noqa: BLE001  (a source that does not compile is a finding, not a crash)
        plan.problems.append(f"the e2 sources do not compile: {error!r}")
        return plan
    train = set(split.train_worlds())
    val = [json.loads(line) for line in plan.val_lines]
    val_ids = {s["id"] for s in val}
    plan.problems += e2_problems(plan.test, {s["world"] for s in val}, val_ids, train)
    fixed = sorted({sid for sid, _ in regen.FIXES} & {s["id"] for s in plan.test})
    plan.problems += [f"{sid} is in regen.FIXES: test ids are never fixed by hand" for sid in fixed]
    for s in plan.test:  # the conventions only: a test session never gets a fix
        plan.prepared += regen.prepare_session(s, fixes=False)[1]
    if not plan.problems:  # the sets as they would be, through the rules `check` applies
        assign = {**plan.assign, **{s["id"]: {"set": "test", "origin": "e2"} for s in plan.test}}
        member = {**{s["id"]: "val" for s in val}, **{s["id"]: "test" for s in plan.test}}
        plan.problems += world_problems({"val": val, "test": plan.test}, train) + assign_problems(assign, member)
    return plan


def plan_text(plan: V8Plan) -> list[str]:
    """The plan in lines: the two sets by world, what the conventions rewrite in the test sessions."""
    lines = []
    if plan.val_lines:
        val = [json.loads(line) for line in plan.val_lines]
        half = collections.Counter(a["v7"] for a in plan.assign.values())
        lines.append(count_line("val", val) + f"  (v7 val {half['val']} + v7 test {half['test']}, ids, origins "
                     "and gold kept)")
    if plan.test:
        lines.append(count_line("test", plan.test) + "  (e2)")
        by = collections.Counter(r["convention"] for r in plan.prepared)
        lines.append(f"prepared with the conventions, no fixes: {len(plan.prepared)} turns in "
                     f"{len({r['id'] for r in plan.prepared})} sessions"
                     + (f" ({', '.join(f'{k} {v}' for k, v in sorted(by.items()))})" if by else ""))
    return lines


def v8_meta(plan: V8Plan) -> dict:
    """split.json of v8: the v7 seed and strata (how v4 cut the halves that v8 folds), the record of the fold, and the
    origin and half of every session."""
    folded = sum(1 for a in plan.assign.values() if a["v7"] == "test")
    assign = {**plan.assign, **{s["id"]: {"set": "test", "origin": "e2"} for s in plan.test}}
    return {"seed": plan.seed, "strata": plan.strata, "version": 8,
            "folded": {"from": "test", "into": "val", "sessions": folded},
            "assign": assign}


def freeze_v8(out: Path | None, sets_dir: Path, e2_dir: Path, ref_out: Path | None, jobs: int, dry_run: bool,
              train_gold: str | None = None, per_world: int | None = None) -> int:
    """The v8 freeze (D-1044-14): OUT/sets/val.jsonl (the pair of v7 folded), test.jsonl (the e2 sources through the
    reference run, the gold derived with the conventions) and split.json, and with `train_gold` trainfit.jsonl. A dry
    run needs no runtime and writes nothing. Exit 1 on any problem, any UNEXPLAINED turn, or a candidate `check`
    rejects."""
    global E2
    previous, E2 = E2, e2_dir  # `check` reads the sources of the origin e2 from the place the sessions came from
    try:
        return _freeze_v8(out, sets_dir, e2_dir, ref_out, jobs, dry_run, train_gold, per_world)
    finally:
        E2 = previous


def _freeze_v8(out: Path | None, sets_dir: Path, e2_dir: Path, ref_out: Path | None, jobs: int, dry_run: bool,
               train_gold: str | None, per_world: int | None) -> int:
    if not dry_run:  # fail before any work
        if out is None:
            raise SystemExit("freeze-v8 needs --out DIR (or --dry-run)")
        if out.resolve() == SETS.resolve():
            raise SystemExit("write the freeze to another directory, check it, then copy it into sets/ (FROZEN.md)")
        if out.exists() and any(out.iterdir()):
            raise SystemExit(f"{out} is not empty: a freeze goes to a new directory (a reference run of an earlier "
                             f"attempt is reused only with --ref-out)")
    plan = plan_v8(sets_dir, e2_dir)
    print(f"freeze-v8{' (dry run)' if dry_run else ''}: the pair of v7 in {sets_dir}, the e2 sources in {e2_dir}")
    for line in plan_text(plan):
        print(line)
    if train_gold:
        line, problems = trainfit_plan(train_gold, per_world)
        print(line)
        plan.problems += problems
    for problem in plan.problems[:SHOWN]:
        print(f"FAIL {problem}", file=sys.stderr)
    if len(plan.problems) > SHOWN:
        print(f"FAIL ... and {len(plan.problems) - SHOWN} more", file=sys.stderr)
    if plan.problems:
        print(f"{len(plan.problems)} problems", file=sys.stderr)
        return 1
    if dry_run:
        print("dry run: nothing written, no runtime used; the plan holds")
        return 0
    assert out is not None
    stage = out / "e2"
    stage.mkdir(parents=True)
    (stage / "test.jsonl").write_text("".join(json.dumps(s, ensure_ascii=False) + "\n" for s in plan.test),
                                      encoding="utf-8")
    found = regen.prepare_sets(stage, stage / "pre", ["test"])
    (out / "prepared.md").write_text(regen.prepared_markdown(found), encoding="utf-8")
    if refreeze(out / "refreeze", ref_out, ["test"], jobs, stage / "pre"):
        print(f"the test build is not clean: an UNEXPLAINED turn keeps the gold of its source and exits 1 (the turns "
              f"are in {out / 'refreeze' / 'changes.md'}, each with its message, old gold, derived gold and why in "
              f"changes.json beside it); nothing is written to {out / 'sets'}", file=sys.stderr)
        return 1
    final = out / "sets"
    final.mkdir()
    (final / "val.jsonl").write_text("".join(line + "\n" for line in plan.val_lines), encoding="utf-8")
    (final / "test.jsonl").write_text("".join(line + "\n" for line in read_lines(out / "refreeze" / "test.jsonl")),
                                      encoding="utf-8")
    (final / "split.json").write_text(json.dumps(v8_meta(plan), indent=0), encoding="utf-8")
    if train_gold:
        trainfit(train_gold, final / "trainfit.jsonl", per_world, 0, False)
    print(f"wrote {final}/{{val,test}}.jsonl, split.json" + (", trainfit.jsonl" if train_gold else "")
          + f"; prepared.md and refreeze/changes.md in {out}")
    report = io.StringIO()  # the counts and the hashes to record in FROZEN.md, kept beside the files
    with contextlib.redirect_stdout(report):
        rc = check(final)
    print(report.getvalue(), end="")
    (out / "check.txt").write_text(report.getvalue(), encoding="utf-8")
    files = ["val.jsonl", "test.jsonl", "split.json"] + (["trainfit.jsonl"] if train_gold else [])
    print("next (FROZEN.md, v8):")
    print(f"  python3 build_sets.py ref --sets-dir {final} --sets test --jobs {jobs}   # the test gate: 100%")
    print(f"  cp {' '.join(str(final / f) for f in files)} {SETS}/")
    if not train_gold:
        print("  python3 build_sets.py trainfit --train-gold 'GLOB'    # after the train regeneration, into sets/")
    print("  record the counts and sha256 in FROZEN.md, then python3 build_sets.py check")
    return rc


# ---------------------------------------------------------------------------------------------


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = ap.add_subparsers(dest="cmd")
    p = sub.add_parser("check", help="the integrity check (default)")
    p.add_argument("--sets-dir", type=Path, default=SETS,
                   help="a candidate directory (a freeze-v8 output): hashes printed, not compared (default sets/)")
    p = sub.add_parser("ref", help="the reference check over val, then test")
    p.add_argument("--out", type=Path, help="keep the run files and reports here (default: a temporary directory)")
    p.add_argument("--jobs", type=int, default=8)
    p.add_argument("--sets-dir", type=Path, default=SETS,
                   help="the directory of val.jsonl and test.jsonl (default sets/)")
    p.add_argument("--sets", default="val,test", help="comma list of the sets to check (default val,test)")
    p = sub.add_parser("refreeze", help="gold from the reference run of the current runtime, with a change list")
    p.add_argument("--out", type=Path, required=True,
                   help="where val.jsonl, test.jsonl and the change list go (not sets/)")
    p.add_argument("--ref-out", type=Path, help="a `ref` output to read (val.run.jsonl, test.run.jsonl), else the run "
                                                "goes there (default OUT/ref)")
    p.add_argument("--sets", default="val,test", help="comma list of the sets to refreeze (default val,test)")
    p.add_argument("--jobs", type=int, default=8)
    p.add_argument("--sets-dir", type=Path, default=SETS,
                   help="the directory of the sets to start from (default sets/)")
    p = sub.add_parser("freeze-v8", help="the v8 freeze: val is the v7 pair folded, test is the e2 sources (D-1044-14)")
    p.add_argument("--out", type=Path, help="where sets/, prepared.md and the refreeze go (new or empty; not sets/)")
    p.add_argument("--dry-run", action="store_true", help="validate and print the plan; write nothing, no runtime")
    p.add_argument("--sets-dir", type=Path, default=SETS, help="the pair of v7 to fold (default sets/)")
    p.add_argument("--e2-dir", type=Path, default=E2, help="the sources of the test sessions (default sessions/e2)")
    p.add_argument("--ref-out", type=Path, help="a reference run of exactly these prepared sessions (test.run.jsonl)")
    p.add_argument("--jobs", type=int, default=8)
    p.add_argument("--train-gold", metavar="GLOB", help="also draw trainfit from a train build (dry run: check it)")
    p.add_argument("--per-world", type=int, help="sessions per train world (default round(300 / worlds))")
    p = sub.add_parser("trainfit", help="draw sets/trainfit.jsonl from the gold files of a train build")
    p.add_argument("--train-gold", required=True, metavar="GLOB", help="the per-world <W>.gold.jsonl files of a build")
    p.add_argument("--out", type=Path, default=SETS / "trainfit.jsonl")
    p.add_argument("--per-world", type=int, help="sessions per train world (default round(300 / worlds): 9 for 35)")
    p.add_argument("--seed", type=int, default=0)
    p.add_argument("--keep-ids", action="store_true", help="keep the ids of --out, refresh their rows")
    p = sub.add_parser("pool", help="pool sessions and split them into val and test")
    p.add_argument("inputs", nargs="+", metavar="[LABEL=]FILE")
    p.add_argument("--out", type=Path, required=True)
    p.add_argument("--seed", type=int, default=0)
    args = ap.parse_args()
    if args.cmd in (None, "check"):
        sys.exit(check(getattr(args, "sets_dir", SETS)))
    if args.cmd == "ref":
        names = tuple(args.sets.split(","))
        if not set(names) <= {"val", "test"}:
            raise SystemExit(f"--sets names val and test only, got {args.sets!r}")
        sys.exit(ref(args.out, args.jobs, args.sets_dir, names))
    if args.cmd == "freeze-v8":
        sys.exit(freeze_v8(args.out, args.sets_dir, args.e2_dir, args.ref_out, args.jobs, args.dry_run,
                           args.train_gold, args.per_world))
    if args.cmd == "refreeze":
        names = args.sets.split(",")
        if not set(names) <= {"val", "test"}:
            raise SystemExit(f"--sets names val and test only, got {args.sets!r}")
        sys.exit(refreeze(args.out, args.ref_out, names, args.jobs, args.sets_dir))
    if args.cmd == "trainfit":
        sys.exit(trainfit(args.train_gold, args.out, args.per_world, args.seed, args.keep_ids))
    sys.exit(pool(args.inputs, args.out, args.seed))


if __name__ == "__main__":
    main()
