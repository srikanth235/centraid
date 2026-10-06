# Built training artefacts

The built artefacts of the current version, read by `train/bundle.py` (`--train data/train.jsonl.gz --val data/train-val.jsonl.gz`). Both are rebuilt from `authored/` with the runtime binary and assembled by `authored/assemble.py`. Nothing else lives in this directory.

| file | records | turns | worlds |
| --- | --- | --- | --- |
| `train.jsonl.gz` | 30,597 sessions (4,491 natural, 26,106 drills) | 42,705 (14,235 natural, 28,470 drills) | 35 train worlds |
| `train-val.jsonl.gz` | 402 sessions | 1,303 | 7 (A B C D T03 T12 T23) |

```
51dfbe27e7fcb82af5fe054598ef073b17ed414f742ad084ee50d121e4b4f7bf  data/train.jsonl.gz
8e03a8b4a8b90fe81b1221de57baed8321616ca026b4fd53fc021dbba5574eb1  data/train-val.jsonl.gz
```

Each file is one gzip member. The compressed bytes depend on the gzip build, so the identity of a rebuild is the sha256 of the uncompressed content (`zcat FILE | sha256sum`):

```
18f656bac7e14246cf323d74aed5de9404656092b2230f04a0d9d0cfe907578f  content of train.jsonl.gz
2a95bcc9116e64991b2769b2a54b964a4c3c9babc35383e84e1b945c66a2c3f7  content of train-val.jsonl.gz
```

A record is one session, one JSON object per line: `id`, `split`, `world`, `today`, `me`, `tools_mode` (`sig`), `messages` (the conversation as the model sees it, train equals inference; an assistant message holds the v3.1 slot trace of `CONTRACT_V3.md` as `think` and the call as `tool` and `args`; the trainer rewrites each think as v4, the default trace, as it reads it), `n_turns`, `tags` (a drill also carries `drill`, its cell and `pair:<id>`), `source`.

## train.jsonl.gz

What the model trains on, built 2026-10-03 with the phase-7 runtime (#1044), in two parts.

**Natural sessions** (4,491): every session of the 35 train worlds of `authored/split.json` (the 25 of phase 6 and T29 to T38, authored blind to val and test under the phase-7 hardness brief, `authored/hardness.py`) that verified against the runtime, 59 to 269 per world. No session of a val world is in it, and none of the sessions of `eval/sets/val.jsonl` or `eval/sets/test.jsonl`. The train-fit sample `eval/sets/trainfit.jsonl` (9 per world) is drawn from it. The sources pass through `authored/gen/collide.py` (rows added to the train worlds so that names collide) and `authored/gen/rewrite.py` (typed references replaced by anchors where the prompt shows the thing; a session whose message does not decide the pick is dropped). Build, one run per world: `python3 authored/build.py <W> --out OUT/<W> --split train --gold-from-ref --sessions-dir REWRITE --worlds-dir WORLDS --augment 0.15 --augment-level light --augment-seed N` (seeds 101 upward in split order for T01 to T28, 126 to 135 for T29, T34, T35, T30, T31, T32, T33, T36, T37, T38). With `--gold-from-ref` the gold of a turn is what the runtime does with its reference calls whenever a convention explains the change (`eval/regen.py`, D-1044-11 and D-1044-13); a session whose gold change no convention explains is dropped, with the reason in the report: 332 of 4,823 (6.9%). `--augment` adds light message noise (`authored/noise.py`: capitals, punctuation, a dropped filler word, a rare typo) to 15% of turns, gold unchanged.

**Decision drills** (26,106 sessions, 13,053 minimal pairs): `authored/gen/drills.py gen --worlds <the 35> --per-world 1000 --seed 7 --split train --weights COVERAGE.json --shares C4=0.06,REF=0.07` generated 34,960 items and kept 33,432 (16,716 pairs with both siblings verified); the cap below keeps 28,470 turns of them. Cells in the file: C3 5,252, C2 4,658, DATES 2,484, CM 2,154, CONT 2,138, FOLLOW 2,090, TWO 1,920, JUDGE 1,898, REF 1,890, C4 1,622 (AMB is generated but never kept: it needs the composed ask).

Assemble: `python3 authored/assemble.py train --natural OUT --drills DRILLS --out data/train.jsonl.gz --ratio 2.0 --seed 0`: the natural sessions in split order, then whole drill pairs drawn at random until the drill turns reach twice the natural turns.

After a rebuild, refresh the train-fit rows with `python3 eval/build_sets.py trainfit --train-gold 'OUT/*/*.gold.jsonl'` and record the new hash in `eval/FROZEN.md` (`--keep-ids` keeps the same sessions when they are all still verified).

## train-val.jsonl.gz

The trainer's loss slice: 402 records of sessions that are in `eval/sets/val.jsonl`, used only to draw the held-out loss curve and to choose `best.json` (`train/train.py --val`). It is never trained on: 180 from the authored val worlds (`split` `val`: T03 55, T12 62, T23 63) and 222 recipe-authored ones (`split` `eval`: A 52, B 55, C 54, D 61). They are built from the unrewritten sources: the collision rows and the rewrite apply to train worlds only. The 224 hand-written sessions of val have no record here, and neither have the 13 sessions with a val-only fix (`eval/regen.py` FIXES), whose build gold is not the set's.

Build, one process per world, no noise: `python3 authored/build.py <W> --split val --gold-from-ref --out OUT` for T12, T03 and T23, and `python3 authored/build.py <W> --split eval --sessions-dir eval/sessions/e1 --worlds-dir eval/worlds --gold-from-ref --out OUT` for D, B, A and C. Then `python3 authored/assemble.py val --build OUT --out data/train-val.jsonl.gz` keeps the records whose session and messages are those of `eval/sets/val.jsonl`.
