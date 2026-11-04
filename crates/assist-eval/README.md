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
| `--tools s2\|sig\|compact\|full` | the tools block the system prompt shows, and the shape of call the step reads. **Default `sig`**, the eight tools; `s2` is the prompt the shipping model was trained on (`contracts/assist/export/prompt.s2.txt`). The report's `model` names it |
| `--stub` | no weights: a model that declines everything. The floor, and a way to check the rig |
| `--set FILE` | the JSONL set (default `experiments/toolchat/native/eval/sets/val.jsonl`) |
| `--worlds DIR` | where the sessions' world JSON lives; repeatable, searched in order (default `eval/worlds`, then `authored/worlds`, as `lib.py`) |
| `--out PREFIX` | write `PREFIX.json` and `PREFIX.sessions.jsonl` |
| `--threads N` / `ASSIST_EVAL_THREADS` | CPU threads (default: up to four cores, as the phone) |
| `--limit N`, `--only ID,ID`, `--shard K/N` | a subset; `--shard` lets several processes share a set (each loads ~0.6 GB at Q4_0) |
| `--resume` | continue a run from its `.sessions.jsonl`; one session the data cannot seed is left out and counted, it does not end the run |
| `--gpu-layers N` / `ASSIST_EVAL_GPU_LAYERS` | layers offloaded (the default is the engine's: all on a Mac, none elsewhere; the Kaggle kernel passes 999) |
| `--label TEXT` | the report's model label when rescoring (the Kaggle kernel names the model and tools block this way) |
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

## Baseline

**The baseline run is deferred (owner, 2026-11-04): no model is scored, here or on Kaggle, until the owner says so.** The kit below is ready and untested.

**Not scored yet.** Two things are settled, one is not.

_What the val set can be asked._ The held-out val (data-v7, 655 sessions) predates the vault rebuild (#1135) and Tally's removal (#1099): its worlds carry Tally sections and a task status the vault no longer has, and the seeder refuses both, so neither this runner nor the Python rig can seed them as they are. The frozen files are not edited. `tally::WithoutTally` and `WithoutInProgress` read both out as a world is loaded and leave out the sessions that need them: **510 of 655 are scored, 145 left out** (118 that name or create a Tally row, 27 that ask about `in_progress`), each listed with its reason in the report's `excluded`. The gold of the 510 was last regenerated before the vault rebuild and before the tool regroup and has not been checked against today's runtime, so its turn pass is a measure for a floor near 0%, not for a model near S2's 82%. A refreeze of val on today's runtime is the real fix (data-version work). The check "the reference calls still reach 100%" cannot be made by `build_sets.py ref` as it stands (see "Precondition" above). `nativetools::vaultio::open_session` also failed on any world over 500 entities (its probe ordered by a nullable column); fixed.

_The floor._ A model that declines everything (`--stub`, eight-tools block) scores **10/510 sessions (2.0%)** and 111/1,552 turns (7.2%): the turns whose gold is a decline. A model has to beat that.

_Which model is the baseline._ The owner named **`RikiyaT/Qwen3.5-0.8B-weight-space-programming`** in chat (the base with two tensors edited, never trained on these tools: `--tools sig`, expected near the floor). A later instruction, relayed from another session, asks for **S2** (`--tools s2`) instead. The two disagree and nothing has been scored; the kit runs either, and `make_bundle.sh` makes you choose. Local runs are off by the owner's instruction (a probe of the RikiyaT model on this Mac took about 30 s a session alone and twice that with four shards, so roughly 4 hours for the 510). The RikiyaT GGUF was built here with `train/to_gguf.py` (llama.cpp `26394b4e6`), is kept at `~/.cache/centraid/models/wsp-base-Q4_0.gguf` (sha256 `058068a4f952b59acccf9610e2f07e2b51d1c9e144d01678d1d5bab270f7be4d`) and stays outside git; S2's is public: `srikanth235/centraid-native-gguf` tag `s2-q4_0`, `centraid-native-s2-Q4_0.gguf`, sha256 `b1be1e45024c8e98f670d456edfdf261c786878dd8260117806e285af8e9f668`.

For comparison only: the Python scorer's last S2 figure is 537/655 sessions (82.0%) live on nt12 / v7.3, 541 rescored on v7.4 (`HANDOFF.md`): the Hugging Face checkpoint, all 655 sessions, an older runtime. It is not reproducible on today's runtime without the same filtering, and it is a different set of sessions. The issue's fail rates by constraints to compare with are 13% / 22% / 37% / 67% at 1 / 2 / 3 / 4.

### The Kaggle kit (`crates/assist-eval/kaggle/`)

A Kaggle **script kernel** (GPU, internet on, private) builds `assist-eval` with `--features cuda` (CUDA llama.cpp, Rust from rustup, from the repository at the commit the bundle was cut from), fetches the model, runs the shards (one process per GPU, `--gpu-layers 999`, `--resume`), then rescores their session files into one `report.json`. **Untested on Kaggle**: nothing here could build CUDA, so the first run is also the test of the build.

**Private data: a private Kaggle dataset, no token.** `make_bundle.sh` packs `src.tar.gz`, `val.jsonl`, the worlds and `kit.json` from a checkout where `artefacts.py fetch` has run; the kernel reads them from `/kaggle/input`. No `HF_TOKEN` is baked in or read. (The alternative, a Kaggle secret `HF_TOKEN` and a fetch in the kernel, needs the secret attached by hand in the Kaggle UI after every push, and the held-out data would then pass through the kernel's internet; the dataset keeps it to one upload the owner makes.) Uploading held-out data to Kaggle, even private, is the owner's call.

The model is in `kit.json`, with its sha256 (checked by the kernel). S2 is a public URL. The RikiyaT model has no GGUF on the Hub, so `make_bundle.sh WSP` copies the local one into the same dataset: one dataset, one upload, one attach. The kernel labels the final report with the model's sha256 prefix and the tools block.

```bash
# on a machine with Kaggle credentials (~/.kaggle/kaggle.json), after committing and fetching the data
python3 experiments/toolchat/native/artefacts.py fetch                 # needs HF_TOKEN, once
crates/assist-eval/kaggle/make_bundle.sh /tmp/kit KAGGLE_OWNER WSP     # the baseline the owner named; S2 is the other choice
kaggle datasets create -p /tmp/kit                                     # private
mkdir -p /tmp/kit-kernel
sed 's/KAGGLE_OWNER/your-kaggle-name/' crates/assist-eval/kaggle/kernel-metadata.json > /tmp/kit-kernel/kernel-metadata.json
cp crates/assist-eval/kaggle/kernel.py /tmp/kit-kernel/
kaggle kernels push -p /tmp/kit-kernel                                 # starts the run; private
kaggle kernels status KAGGLE_OWNER/centraid-assist-eval
kaggle kernels output KAGGLE_OWNER/centraid-assist-eval -p out         # report.json, summary.txt, shard-*.sessions.jsonl
```

Two T4s run two shards; the `shard-*.sessions.jsonl` files of a stopped run, added to the input dataset, are copied into the output directory first, so the same command resumes. Put the numbers in this section when the run is done.

## Tests

`cargo test -p centraid-assist-eval`: the scorer on hand-made gold and effects (`judge.rs`, `effect.rs`), the constraint count and argument classes (`args.rs`), the sources (`source.rs`), and `tests/smoke.rs`, which seeds a small world into a real vault and replays sessions through the real runtime with a stub in place of the model (no weights).
