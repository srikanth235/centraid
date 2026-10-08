# Eval authoring kit: world <W>

This is how the recipe-authored eval sessions of origin `e1` (worlds A to D, ids `<W>-E001` upward; their sources are not kept in the tree, R-1088-16) were made and checked. An author writes held-out evaluation sessions for one eval world by exactly the recipe the training data is made by (`authored/BRIEF.md`), on a world the model never trains on, so that train, val and test come from one distribution and differ only in which household they are about. `check.sh` is the one gate (replay through the runtime, trace, shape, mix, hygiene); `hyg.py` and `mix.py` are its hygiene and mix checks against the train corpus and the held-out pool.

## Setup: the blindness rule

An author stays blind to the held-out text. The author works in a private copy `P` of `experiments/toolchat/native` that lacks everything held out: no `eval/sets/`, no eval world JSON under `eval/worlds/`, no `data/`, no `runs/` or `out/`, and no other world's sessions. `P` holds the author's world (`authored/worlds/<W>.json` and `<W>.keys.json`, copied from `eval/worlds/`), the session header below as `authored/sessions/<W>.py`, and one train session file (`authored/sessions/T01.py`) as a format example. The gate runs from the full repo, where the held-out sets live: `check.sh` takes `P` from the environment, reads the held-out sets itself, and prints verdicts and the author's own messages, never a held-out message.

Session header (`today` and `me` are the world's own, in `<W>.json`):

    from gold import *
    import json

    world("<W>", "<today>", "<me>", "eval")


    def W(expr):
        """a `when` filter as the JSON text the model writes"""
        return json.dumps(expr, separators=(",", ":"))

Environment of `check.sh`:

| variable | meaning |
| --- | --- |
| `EVALKIT_ROOT` | the full `experiments/toolchat/native` tree, which holds the held-out sets (default: the tree that holds `check.sh`) |
| `P` | the author's private copy (default: `EVALKIT_ROOT`) |
| `PY` | a Python with torch (CPU), transformers and numpy (default `python3`) |
| `NATIVETOOLS` | the runtime binary (required) |
| `TRAIN_GOLD` | a glob of the train worlds' built `*.gold.jsonl`: `build.py <train worlds> --out DIR` writes them (`split.train_worlds()` lists the worlds) and the glob is `DIR/*.gold.jsonl`; the mix and hygiene checks compare with it (required for the full run) |
| `OUT` | where the build writes (default `${TMPDIR:-/tmp}/evalkit-<W>`) |
| `EVAL_VAULTS` | where the world is seeded (default `$OUT/vaults`) |

## Read (nothing else)

1. This file.
2. `$P/authored/BRIEF.md`: sections "Why this exists", "Hard rules" and "The sessions" (skip "The world": your world exists; skip "Verify": use `check.sh` below). Where BRIEF and this kit differ, this kit wins.
3. `$P/eval/gold.py` (the helpers), and the first ~80 lines of `$P/authored/sessions/T01.py` as a format example (a train world: do not copy its messages).
4. Your world: `cd $P/eval && $PY view_world.py <W> [--kind tasks] [--grep word]` (it reads `$P/authored/worlds/<W>.json`). Read it by kind as you need it, not all at once.
5. As needed: `$P/SPEC.md` §8 (policy) and §14.1 (rulings), and a runtime export `$NATIVETOOLS export <dir>` (prompt.sig.txt, kind_card.txt, the grammars).

## Never open

The full repo (its `eval/sets`, `eval/worlds`, `data`, `runs`; you run its `authored/evalkit/check.sh`, you do not open its files), any other author's copy, or anything else outside `P` and your own `OUT`. They hold the held-out sessions you must stay blind to. Do not run `pkill`/`kill`. Write only `$P/authored/sessions/<W>*.py` and scratch files under `OUT`.

## What to write

- **N sessions** (N is in your task), ids `<W>-E001` upward, in `$P/authored/sessions/<W>.py` (the header above) and, if you like, `<W>_02.py`, `<W>_03.py`... (each a copy of the header, then `S(...)` calls). Write each session by hand. Never generate or edit sessions with a script across files.
- Everything in BRIEF "The sessions" applies: real terse phone typing, leaning on earlier turns, loose names, repairs with `bad(...)`, asks, declines, never-minds, undo, trashed rows, empty results and their recovery. Use every kind the world has (people, groups, expenses, debts, lists, events, tasks, links, notebooks, notes, folders, documents, albums, photos, locker) and every verb, roughly in the proportions a real household would.
- Shape targets: the training corpus's own figures. Land within the tolerance:

| figure | train | tolerance |
| --- | --- | --- |
| session length 1 / 2 / 3 / 4 / 5 / 6 / 7+ | 9 / 21 / 32 / 25 / 7 / 3 / 2 % | ±4 each |
| outcomes rows / value / write / write+read / ask / decline / find-only | 33 / 12 / 39 / 1 / 8 / 6 / 2 % | ±4 each |
| runtime said ambiguous (turns) | 5.3% | 3–7 |
| empty-result recovery (turns) | 2.8% | ≥2.5 |
| touch a trashed row (turns) | 5.2% | ≥4.5 |
| sessions with a repair | 10% | 8–14 |
| turns ending in ask | 7.6% | 5–10 |
| messages naming a row verbatim | 33% | ≥30 |
| messages referring by description/pronoun/ordinal | 44% | ≥38 |
| multi-call turns | 19% | 15–23 |

## Check (the only gate)

Run it from the full repo, with `P`, `NATIVETOOLS` and `TRAIN_GOLD` set:

    authored/evalkit/check.sh <W> --only <W>-E001,<W>-E002     # fast: replay just these
    authored/evalkit/check.sh <W>                              # full: build, trace, shape, mix, hygiene

A session that does not verify: read its FAIL line, inspect it with `cd $P && NATIVETOOLS=... EVAL_VAULTS=$OUT/vaults HF_HUB_OFFLINE=1 $PY authored/show.py <W> <W>-E014`, and fix the gold or the reference (the gold follows SPEC §8 and the rulings, never the runtime's mistakes). A session the runtime cannot serve correctly is deleted and listed in your report, never forced. HELD-DUP / TRAIN-DUP / SELF-DUP lines: reword that message. Hygiene compares with every message in `eval/sets`, so sessions already frozen there show up as HELD-DUP. Done = the full run prints ALL PASS and every shape figure is inside its tolerance.

To re-run the checks on the sources of an eval world (the author keeps them), copy `<W>*.py` to `$P/authored/sessions/` and `eval/worlds/<W>.json` (from the data version) with `<W>.keys.json` (seeded by `eval/seed_worlds.py`) to `$P/authored/worlds/`; every message of six words or more then reports HELD-DUP, because those sessions are in `eval/sets`. `hyg.py` and `mix.py` also run alone (see their docstrings).

## Report (at most 12 lines)

Sessions verified; the shape lines; sessions deleted and why; any runtime behaviour you believe is wrong (session id + message); anything in this kit that got in your way.
