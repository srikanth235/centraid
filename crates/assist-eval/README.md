# centraid-assist-eval

The eval runner of the on-device chat model: stage 10 of the training-data pipeline ([#1166](https://github.com/srikanth235/centraid/issues/1166)). It replays a held-out set turn by turn through the phone's own step (`centraid_assist::native::step::decode_step`, the call `assist-step` serves), lets the real runtime execute what the model wrote, and judges each turn by its **effect**, as `experiments/toolchat/native/eval/score.py` does.

It is its own crate and not a module of `centraid-assist-llama` because the runner needs the world seeder and the vault (`centraid-nativetools`: SQLite, the apps, the search index). `centraid-assist-llama` is linked into the phone's core, and a harness dependency does not belong there. The llama.cpp engine is behind this crate's `engine` feature, so the gate builds, lints and tests everything else without the five-minute cmake build.

## Use

```bash
# the set, its worlds and the model are held out / not in the tree; see "Baseline" below for where each comes from
RUSTFLAGS='-C target-cpu=native' cargo build --release -p centraid-assist-eval --features engine --bin assist-eval
target/release/assist-eval --model native-s2-Q4_0.gguf \
    --set experiments/toolchat/native/eval/sets/val.jsonl --out runs/val-s2-q4
```

It prints the summary and writes `runs/val-s2-q4.json` (the report) and `runs/val-s2-q4.sessions.jsonl` (every turn's result, one session per line, with the calls the model made and the problems the scorer found).

| flag | meaning |
| --- | --- |
| `--model GGUF` / `ASSIST_EVAL_MODEL` | the model; greedy, trace v4, think limit 200, 512 tokens, context 8192: the phone's `StepOptions` |
| `--tools s2\|sig\|compact\|full` | the tools block the system prompt shows. **Default `s2`**, the prompt the shipping model was trained on (`contracts/assist/export/prompt.s2.txt`); a model trained on the eight tools is scored with `--tools sig`. The report's `model` names it |
| `--stub` | no weights: a model that declines everything. The floor, and a way to check the rig |
| `--set FILE` | the JSONL set (default `experiments/toolchat/native/eval/sets/val.jsonl`) |
| `--worlds DIR` | where the sessions' world JSON lives; repeatable, searched in order (default `eval/worlds`, then `authored/worlds`, as `lib.py`) |
| `--out PREFIX` | write `PREFIX.json` and `PREFIX.sessions.jsonl` |
| `--threads N` / `ASSIST_EVAL_THREADS` | CPU threads (default: up to four cores, as the phone) |
| `--limit N`, `--only ID,ID`, `--shard K/N` | a subset; `--shard` lets several processes share a set (each loads ~0.6 GB at Q4_0) |
| `--rescore FILE…` | build the report from `.sessions.jsonl` files (merges shards, or re-reports a run) without running anything |

Each session runs on a private copy of its world's vault: the world is seeded once with the same seeder the Python rig uses (`nativetools seed`), copied per session, and deleted afterwards.

## Input: `EvalSource`

Sessions and worlds come through `source::EvalSource` (`sessions()`, `world(name)`, `label()`). Today there are two sources: `JsonlSource` (the frozen `sets/val.jsonl` and the world JSON its sessions name) and `MemorySource` (tests). The record the `datagen` crate will write is one more implementation of the trait; the runner and the scorer do not change. The trait asks for the session shape the frozen sets already have (`gold::Session`: `id`, `world`, `today`, `me`, `turns[{user, gold, ref, tags}]`), so a datagen reader maps its record to that.

## Output

`report.json` has, over all turns and again for each app (`by_app`, with `single_app_session_pass`):

- `overall`: `session_pass` (every turn passes), `wrong_write`, loop/cap/think-cut counts, engine errors.
- `turn_pass`, `clean_turn_pass`, `tool_accuracy`, `tool_name_accuracy`.
- `arguments`: `rows`, `date`, `filters`, `amount`, each `{right, scored, unscorable, rate}`.
- `by_constraints`: `0`, `1`, `2`, `3`, `4+` and `0-1` (the census's "k≤1"), each with `fail_rate` over all turns and `clean_fail_rate` over clean turns.
- `by_gold_type`, `by_tag`, and `failed` (every failed turn: the problems, the calls).

### What the new measures mean

- **Constraints** are counted on the turn's reference calls, exactly as `authored/hardness.py` counts them (the census behind the issue's 13% / 22% / 37% / 67%): the row selector, `when`, `linked_to`, `within`, `exclude`, `status`, `text`, each `where` clause, `order`+`limit`, `op`+`field`+`group`; the widest accepted, non-`bad` reference call. `ask`, `decline` and `open` carry 0.
- **S2 and the eight tools.** The runtime renames S2's `search`, `open` and `act` itself (`native::legacy::modernize`, at `Session::step`), so S2's calls run as `find`, `create`, `edit` and `do`. The scorer puts the reference calls and the model's calls through the same table before comparing, so both sides speak the eight tools. A read is `find`, `answer` or `compute` alike; a write is its tool and verb, and a write by `@k` takes its selector from the read before it.
- **Tool name accuracy** (`tool_name_accuracy`) sits beside the effect-based one: the model's last call names an act some reference call names (reads collapse to one act; a write is its tool and verb, so `do complete` is not `do cancel`).
- **Tool accuracy** is read off the effect: the turn ended in the act some accepted gold wants (rows, value, write, ask or decline; a write that also answers its row counts as a write; a turn that passes counts whatever it ended in). A wrong set of rows or a wrong amount is not a wrong tool.
- **Arguments** are the one measure the effect cannot isolate, so they are read off the calls. For each class, a turn counts when a reference call states it; a turn that passes by effect is right on every class it carries (it may have looked first); on a failed turn the model is right when one of its calls has the same tool (and verb) and states the same arguments of that class, which says which argument to blame. Classes: _rows_ = `rows`, `name`, `within`, `linked_to`; _date_ = `when`, and a date written in `args`; _filters_ = `where` clauses that are not amounts, `status`, `exclude`, `text`, `order`, `limit`, `op`, `field`, `group`; _amount_ = a `where` clause or `args` line on a money field of the call's kind. Values compare as the runtime reads them (case-folded, whitespace-collapsed; date expressions as JSON). A reference's `$key` is compared as the `#n` the runtime showed; when the runtime never showed that row the argument is `unscorable` and left out of the rate, not counted as a miss.
- **App** of a turn: the apps of the kinds its reference calls name and of the rows its gold names. A cross-app turn is in each of its apps.

## Differences from `score.py` / `metrics.py` / `slices.py`

Kept: the matching rules (`match_value`, `diff_match`, `value_match`; the same problems, worded alike but formatted by Rust, so `["me"]` where Python prints `['me']`), the effect (`turn_effect`, `merge_diffs`), session strict pass, turn pass over all turns, clean turn pass, the wrong-write rate, pass by gold type and by tag, loop/cap/think-cut counts, the 95% Wilson interval. Intended differences:

- **Not ported:** row precision/recall, the "without §14-convention turns" figures, under-ask/over-ask, `slices.py`'s error classes, `metrics.py`'s before/after table, `NATIVE_RETRY`, and `break_loop` (a no-op for a greedy backend). The failed turns carry the scorer's problem texts, so the classes can be rebuilt from `report.json`.
- **In-process runtime.** The Python rig drives a `nativetools session` process; this crate links `centraid_assist::native::Session` and the vault door. Same code, no pipe. The prompt is rendered by `native_turn::log::Log`, the renderer the phone and the training data share (the Python `--model gguf` path renders through `render.py`, a client of the same Rust renderer).
- **`casefold`** is Unicode lowercase (Rust has no casefold); only differs for characters like `ß`.
- **A failing engine** ends the session (`error` in its record, the remaining turns "not run") where the Python driver aborts the run. Gold that names a world key the world lacks aborts both.
- **Parity is checked on hand-made pairs only.** The first S2 run, scored beside `score.py` on the same set, is where "comparable numbers" is actually tested.
- **`unscorable` arguments:** a `$key` row shown only in the system directory or a user block cannot be resolved (Python's `NameIndex` scans those; this crate does not). If `unscorable` is a large share of `rows` after the baseline run, port `NameIndex`.
- **Tool accuracy, arguments, constraints and apps** have no Python counterpart.
- **Writes run** (`Writes::Run`), as in the Python eval, not the phone's `Park` (a write waiting for a tap); the effect is the vault's.

## Baseline: S2 on val

**Not run here.** Three things are missing from the machine this was built on:

1. **The val set and its worlds.** `eval/sets/val.jsonl` and `eval/worlds/` are held out in the private data version `srikanth235/centraid-native-data` (`data-v7`); `python3 experiments/toolchat/native/artefacts.py fetch` brings them back and needs `HF_TOKEN`.
2. **S2's GGUF.** No GGUF of S2 is published or recorded: `artefacts.json` pins the data version only, and the README's `publish-gguf` step has no repository named. S2 is the soup `soups/soup2` of the private checkpoint store (`HANDOFF.md`); `train/to_gguf.py` makes the Q4_0 file from it. The only GGUF on the machine is stock `~/.cache/centraid/models/Qwen3.5-0.8B-Q4_0.gguf`, which is not S2.
3. **Time.** The only speed measured is the stock (untuned) `Qwen3.5-0.8B-Q4_0.gguf` through this binary on this Mac (Metal): one two-turn session took 93 s, the untuned model running into the step cap (about 10 s a step). S2 ends most turns in one to three steps, so 655 sessions / 2,055 turns is plausibly several hours on one process; split it with `--shard K/N` (each shard loads the model).

To run it:

```bash
export HF_TOKEN=…
python3 experiments/toolchat/native/artefacts.py fetch
python3 experiments/toolchat/native/train/to_gguf.py CKPT --out OUT --name native-s2 \
    --source-repo OWNER/NAME --source-tag S2 --source-revision SHA        # CKPT = the S2 soup
RUSTFLAGS='-C target-cpu=native' cargo build --release -p centraid-assist-eval --features engine --bin assist-eval
target/release/assist-eval --model OUT/native-s2-Q4_0.gguf --tools s2 \
    --set experiments/toolchat/native/eval/sets/val.jsonl --out runs/val-s2-q4 --threads 4
```

The Python scorer's last known S2 number is **537 / 655 sessions (82.0%)** live on nt12 / val v7.3, 541 rescored on v7.4, 542 by replay on nt15 / v7.4 (`HANDOFF.md`); those are the Hugging Face checkpoint, not the Q4_0 GGUF, and nothing has been scored live on nt15 yet. The Rust runner on S2's GGUF is therefore expected to land near but not exactly on them (quantisation, and the runtime changes since). The constraint-count fail rates to compare with are the issue's 13% / 22% / 37% / 67% at 1 / 2 / 3 / 4.

## Tests

`cargo test -p centraid-assist-eval`: the scorer on hand-made gold and effects (`judge.rs`, `effect.rs`), the constraint count and argument classes (`args.rs`), the sources (`source.rs`), and `tests/smoke.rs`, which seeds a small world into a real vault and replays sessions through the real runtime with a stub in place of the model (no weights).
