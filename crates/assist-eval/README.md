# centraid-assist-eval

The eval runner of the on-device chat model: stage 10 of the training-data pipeline ([#1166](https://github.com/srikanth235/centraid/issues/1166)). It replays a held-out set turn by turn through the phone's own step (`centraid_assist::native::step::decode_step`, the call `assist-step` serves), lets the real runtime execute what the model wrote, and judges each turn by its **effect**, as the retired `experiments/toolchat/native/eval/score.py` does.

It is its own crate and not a module of `centraid-assist-llama` because the runner needs the world seeder and the vault (`centraid-nativetools`: SQLite, the apps, the search index). `centraid-assist-llama` is linked into the phone's core, and a harness dependency does not belong there. The llama.cpp engine is behind this crate's `engine` feature, so the gate builds, lints and tests everything else without the five-minute cmake build.

## Use

```bash
# the set, its worlds and the model are held out / not in the tree; see "Baseline" below for where each comes from
RUSTFLAGS='-C target-cpu=native' cargo build --release -p centraid-assist-eval --features engine --bin assist-eval
target/release/assist-eval replay --set val.jsonl --worlds worlds      # the precondition, no model
target/release/assist-eval --model Qwen3.5-0.8B-Q4_0.gguf --set val.jsonl --worlds worlds --out runs/val-base
target/release/assist-eval compare runs/val-base.json runs/val-adapter.json
```

**The number reported is the number the phone would get.** A plain run decodes under `centraid_assist::native_turn::phone_options()`, the one definition the phone uses (greedy, trace v4, think limit 200, 512 tokens, the think held to the `full` grammar); it is not copied here. `--grammar` and `--tools` change it, and the report's label and `config` say what ran.

**A scoring run starts only if the set replays.** Before any model is loaded, the reference calls of the very sessions to be scored (after `--only`, `--shard` and `--limit`) are said turn by turn through the same runner and the same judge, and every turn must pass (`replay.rs`; the path `datagen`'s tests take for what it generates). If one does not, the run stops and lists the failing sessions: a set the runtime cannot solve scores nothing. `assist-eval replay` makes the check alone. There is no flag to skip it.

It prints the summary and writes `runs/val-base.json` (the report), `runs/val-base.sessions.jsonl` (every turn's result, one session per line, with the calls the model made and the problems the scorer found) and `runs/val-base.config.json` (how it decoded, which `--rescore` reads back).

| flag | meaning |
| --- | --- |
| `--model GGUF` / `ASSIST_EVAL_MODEL` | the base model; greedy, trace v4, think limit 200, 512 tokens, context 8192, the phone's grammar: `phone_options()` |
| `--adapter GGUF` | a LoRA adapter loaded beside the base; its sha256 goes in the label and in `config.adapter_sha256`. **The engine cannot load one yet** (`centraid-assist-llama` has no adapter support on this branch), so the flag stops with a plain message instead of scoring the base under the adapter's name |
| `--tools s2\|sig\|compact\|full` | the tools block the system prompt shows, and the shape of call the step reads. **Default `sig`**, the eight tools; `s2` is the prompt the shipping model was trained on (`contracts/assist/export/prompt.s2.txt`). Written into the report's label and `config` |
| `--grammar off\|handles\|full` | how much of the think the decoder holds to. **Default: the phone's** (`full`; `handles` under `--tools s2`, which the step decides). Written into the report's label and `config` |
| `--stub` | no weights: a model that declines everything. The floor, and a way to check the rig |
| `--set FILE` | the JSONL set (default `experiments/toolchat/native/data/v7/val.jsonl`) |
| `--worlds DIR` | where the sessions' world JSON lives; repeatable, searched in order (default `experiments/toolchat/native/data/v7/worlds`) |
| `--out PREFIX` | write `PREFIX.json` and `PREFIX.sessions.jsonl` |
| `--threads N` / `ASSIST_EVAL_THREADS` | CPU threads (default: up to four cores, as the phone) |
| `--limit N`, `--only ID,ID`, `--shard K/N` | a subset; `--shard` lets several processes share a set (each loads ~0.6 GB at Q4_0) |
| `--resume` | continue a run from its `.sessions.jsonl`; one session the data cannot seed is left out and counted, it does not end the run |
| `--gpu-layers N` / `ASSIST_EVAL_GPU_LAYERS` | layers offloaded (the default is the engine's: all on a Mac, none elsewhere; the Kaggle kernel passes 999) |
| `--label TEXT` | the report's model label when rescoring (default: the label the run wrote in its `.config.json`) |
| `--rescore FILE…` | build the report from `.sessions.jsonl` files (merges shards, or re-reports a run) without running anything. The tools, grammar and hashes come from the `.config.json` beside each file (all must agree) or from `--tools` / `--grammar`; a report that does not say stays unknown and `compare` refuses it |
| `replay` | the precondition alone: `assist-eval replay --set … --worlds … [--tools …]`; exit 0 only at 100% |
| `compare A.json B.json [--out FILE]` | see "Paired comparison" |

Each session runs on a private copy of its world's vault: the world is seeded once with the same seeder the Python rig uses (`nativetools seed`), copied per session, and deleted afterwards.

## Input: `EvalSource`

Sessions and worlds come through `source::EvalSource` (`sessions()`, `world(name)`, `label()`). Today there are two sources: `JsonlSource` (the frozen `sets/val.jsonl` and the world JSON its sessions name) and `MemorySource` (tests). The record the `datagen` crate will write is one more implementation of the trait; the runner and the scorer do not change. The trait asks for the session shape the frozen sets already have (`gold::Session`: `id`, `world`, `today`, `me`, `turns[{user, gold, ref, tags}]`), so a datagen reader maps its record to that.

## Output

`report.json` has, over all turns and again for each app (`by_app`, with `single_app_session_pass`):

- `config` (tools, grammar, base and adapter sha256) and `verdicts` (every scored session's id and whether it passed: what `compare` pairs on).
- `overall`: `session_pass` (every turn passes), `wrong_write`, loop/cap/think-cut counts, engine errors, and
  - `endings`: failed turns by how they ended, counted apart so a loop or a crash is not read as a wrong answer: `ordinary_fail` (the turn ended and was wrong), `loop_`, `step_cap`, `error`, `engine_error`;
  - `over_refusal`: turns that ended in a decline or an ask where no accepted gold is either, over the turns whose gold is neither;
  - `malformed_calls`: model steps that held no call the runtime could read, or whose call it refused with an error observation, over all steps; `unparsed_calls` is the first kind alone;
  - `tokens_total`, `tokens_per_turn`: tokens the model generated (a count from the engine; never seconds).
- `turn_pass`, `clean_turn_pass`, `tool_accuracy`, `tool_name_accuracy`.
- `arguments`: `rows`, `date`, `filters`, `amount`, each `{right, scored, unscorable, rate}`.
- `by_constraints`: `0`, `1`, `2`, `3`, `4+` and `0-1` (the census's "k≤1"), each with `fail_rate` over all turns and `clean_fail_rate` over clean turns.
- `by_gold_type`, `by_tag`, and `failed` (every failed turn: the problems, the calls).

### Paired comparison

`assist-eval compare A.json B.json` takes the baseline A and the candidate B, pairs them by session id and prints the sessions **won** (B passes, A fails), **lost** (A passes, B fails), both pass, both fail, and `z = (won − lost) / sqrt(won + lost)`. `|z| < 2` is noise (the owner's rule, HANDOFF.md). Counts only, no timing. It **refuses** reports that scored different sessions, a different tools block or a different grammar, and a report that does not say its tools or grammar (two unknowns are not known to be equal); the base model and the adapter may differ, that is what a comparison is for. `--out` writes the numbers and the won and lost ids.

### What the new measures mean

- **Constraints** are counted on the turn's reference calls, exactly as the retired `authored/hardness.py` counts them (the census behind the issue's 13% / 22% / 37% / 67%): the row selector, `when`, `linked_to`, `within`, `exclude`, `status`, `text`, each `where` clause, `order`+`limit`, `op`+`field`+`group`; the widest accepted, non-`bad` reference call. `ask`, `decline` and `open` carry 0.
- **S2 and the eight tools.** The runtime renames S2's `search`, `open` and `act` itself (`native::legacy::modernize`, at `Session::step`), so S2's calls run as `find`, `create`, `edit` and `do`. The scorer puts the reference calls and the model's calls through the same table before comparing, so both sides speak the eight tools. A read is `find`, `answer` or `compute` alike; a write is its tool and verb, and a write by `@k` takes its selector from the read before it.
- **Tool name accuracy** (`tool_name_accuracy`) sits beside the effect-based one: the model's last call names an act some reference call names (reads collapse to one act; a write is its tool and verb, so `do complete` is not `do cancel`).
- **Tool accuracy** is read off the effect: the turn ended in the act some accepted gold wants (rows, value, write, ask or decline; a write that also answers its row counts as a write; a turn that passes counts whatever it ended in). A wrong set of rows or a wrong amount is not a wrong tool.
- **Arguments** are the one measure the effect cannot isolate, so they are read off the calls. For each class, a turn counts when a reference call states it; a turn that passes by effect is right on every class it carries (it may have looked first); on a failed turn the model is right when one of its calls has the same tool (and verb) and states the same arguments of that class, which says which argument to blame. Classes: _rows_ = `rows`, `name`, `within`, `linked_to`; _date_ = `when`, and a date written in `args`; _filters_ = `where` clauses that are not amounts, `status`, `exclude`, `text`, `order`, `limit`, `op`, `field`, `group`; _amount_ = a `where` clause or `args` line on a money field of the call's kind. Values compare as the runtime reads them (case-folded, whitespace-collapsed; date expressions as JSON). A reference's `$key` is compared as the `#n` the runtime showed; when the runtime never showed that row the argument is `unscorable` and left out of the rate, not counted as a miss.
- **A turn that does not end does not pass.** A write that landed and then looped, hit the step cap or ended on an error fails (`judge.rs`, owner's ruling): the member's turn did not finish, so it is neither a score nor a training record, and a rollout never keeps it as an RFT record or as the preferred side of a pair. Before this ruling the judge passed such a turn on the vault diff alone.
- **App** of a turn: the apps of the kinds its reference calls name and of the rows its gold names. A cross-app turn is in each of its apps.

## Differences from the retired `score.py` / `metrics.py` / `slices.py`

The Python scorer was deleted in #1171 (it is in git history, at the commit before that one). This crate is the only scorer.

Kept: the matching rules (`match_value`, `diff_match`, `value_match`; the same problems, worded alike but formatted by Rust, so `["me"]` where Python prints `['me']`), the effect (`turn_effect`, `merge_diffs`), session strict pass, turn pass over all turns, clean turn pass, the wrong-write rate, pass by gold type and by tag, loop/cap/think-cut counts, the 95% Wilson interval. Intended differences:

- **Not ported:** row precision/recall, the "without §14-convention turns" figures, under-ask/over-ask, `slices.py`'s error classes, `metrics.py`'s before/after table, `NATIVE_RETRY`, and `break_loop` (a no-op for a greedy backend). The failed turns carry the scorer's problem texts, so the classes can be rebuilt from `report.json`.
- **In-process runtime.** The Python rig drives a `nativetools session` process; this crate links `centraid_assist::native::Session` and the vault door. Same code, no pipe. The prompt is rendered by `native_turn::log::Log`, the renderer the phone and the training data share.
- **`casefold`** is Unicode lowercase (Rust has no casefold); only differs for characters like `ß`.
- **A failing engine** ends the session (`error` in its record, the remaining turns "not run") where the Python driver aborts the run. Gold that names a world key the world lacks aborts both.
- **Parity is checked on hand-made pairs only.** `score.py` is gone from the tree, so "comparable numbers" are tested against the figures it reported for S2 (13/22/37/67% fail by constraint count, #1166), not by running both.
- **`unscorable` arguments:** a `$key` row shown only in the system directory or a user block cannot be resolved (Python's `NameIndex` scans those; this crate does not). If `unscorable` is a large share of `rows` after the baseline run, port `NameIndex`.
- **Tool accuracy, arguments, constraints and apps** have no Python counterpart.
- **Decoding is the phone's.** The Python rig decoded free; a plain run here uses `phone_options()` (the `full` grammar), as the phone does.
- **Writes run** (`Writes::Run`), as in the Python eval, not the phone's `Park` (a write waiting for a tap); the effect is the vault's.

## Baseline

**No model has been scored, here or on Kaggle: the owner launches the first run.** The first intended run is the baseline: the **stock** Qwen3.5-0.8B GGUF pinned in `crates/assist/model.json` (url, sha256, tools mode), no adapter, on the val split of a data version, decoded as the phone decodes. An adapter is scored the same way later (`--adapter`, once the engine loads one), and `assist-eval compare` says whether it won.

_What can be scored._ A data version's val (`datagen build`, tag `vX.Y` of the private dataset `srikanth235/centraid-native-data`): its records are read as they are (`JsonlSource` reads a plain JSONL set, so decompress `data/val.jsonl.zst` first; `source::seed_document_of` puts a presence-only world's sealed placeholders back as `datagen` does). A set must pass the reference replay first. **The frozen data-v7 val does not** and a run over it is refused: its gold predates the vault rebuild (#1135) and Tally's removal (#1099), its worlds carry Tally sections the seeder refuses (`tally::WithoutTally` and `WithoutInProgress` still read those out and leave the sessions that need them out, counted in the report's `excluded`), and its reference calls name `$key`s the runtime cannot run. The floors and S2 figures that used to stand here were measured on that set and are gone with it.

The issue's fail rates by constraint count to compare with are 13% / 22% / 37% / 67% at 1 / 2 / 3 / 4 (the retired Python scorer on S2).

### The Kaggle scoring kit (`crates/assist-eval/kaggle/`)

A Kaggle **script kernel** (GPU, internet on, private) that **only scores**; nothing trains on Kaggle through this kit. Its steps, in order:

1. the base GGUF by **pinned URL and sha256** (from `model.json`, written into `kit.json` by `make_bundle.sh`), and an optional adapter (a URL and sha256, or a file in the input dataset, sha256 checked); a file that is not the pinned one stops the kernel;
2. the data version's **val by tag and by hash**: `manifest.json` at the tag must record the hash the kit pins for `data/val.jsonl.zst`, and the downloaded file must have it. **The manifest records BLAKE3, not SHA-256** (`datagen`'s `version.rs`), so the pin is BLAKE3; the kernel also logs the file's sha256. The data is private: the kernel reads it from the Hugging Face dataset with a Kaggle secret `HF_TOKEN` that the owner attaches to the kernel in the Kaggle UI (read in memory, never written); the val is decompressed and the worlds it names are fetched;
3. builds `assist-eval` with `--features cuda` (CUDA llama.cpp, Rust from rustup, from the repository at the commit the bundle was cut from);
4. **`assist-eval replay`**: the set must replay to 100% or the kernel stops with the failing sessions listed and no model is loaded (each shard repeats the check over its own sessions);
5. scores in shards (one process per GPU, `--gpu-layers 999`, `--resume`; the grammar is the phone's unless `kit.json` says one), then rescores the shard files into one `report.json` (the shards' `.config.json` files carry tools, grammar and hashes) and `summary.txt`.

```bash
# on a machine with Kaggle credentials (~/.kaggle/kaggle.json), after committing; the OWNER runs these
HASH=$(jq -r '.files["data/val.jsonl.zst"].blake3' manifest.json)      # the manifest of the tag, from the dataset repository
crates/assist-eval/kaggle/make_bundle.sh /tmp/kit KAGGLE_OWNER --tag v0.2 --val-blake3 "$HASH"   # baseline: no adapter
kaggle datasets create -p /tmp/kit                                     # private; holds only the source, kit.json (and an adapter)
mkdir -p /tmp/kit-kernel
sed 's/KAGGLE_OWNER/your-kaggle-name/' crates/assist-eval/kaggle/kernel-metadata.json > /tmp/kit-kernel/kernel-metadata.json
cp crates/assist-eval/kaggle/kernel.py /tmp/kit-kernel/
kaggle kernels push -p /tmp/kit-kernel                                 # starts the run; then attach the HF_TOKEN secret
kaggle kernels status KAGGLE_OWNER/centraid-assist-eval
kaggle kernels output KAGGLE_OWNER/centraid-assist-eval -p out         # report.json, summary.txt, shard-*.sessions.jsonl
```

`make_bundle.sh` adds `--adapter FILE` or `--adapter-url URL --adapter-sha256 HASH` for an adapter run, `--grammar` and `--tools` to change what the phone's options say (left out, they are the phone's and the model record's). Two T4s run two shards; the `shard-*` files of a stopped run, added to the input dataset, are copied into the output directory first, so the same command resumes. `kaggle/test_kernel.py` (`python3 -m unittest test_kernel` there) checks the pin logic without a GPU or a network. **Untested on Kaggle**: nothing here could build CUDA, so the first run is also the test of the build. Put the numbers in this section when the run is done.

The M6 trainer's own kernel, `experiments/toolchat/native/train/kaggle/`, is not part of this kit and is not touched by it.

## Rollouts and a second round (M7, [#1171](https://github.com/srikanth235/centraid/issues/1171))

Stage 11 of the pipeline: sample `k` decodes of a model over datagen sessions, let the runtime check each turn against gold (the same judge as above), and cut the records a second round of training reads. **Built and tested with a scripted model only. Nothing here has run on a GPU, against weights, or on Kaggle** (no Kaggle credentials exist, and nothing was trained).

```bash
# 1. sample: 4 decodes of every session, the phone's grammar (spelled out here), the eight tools
assist-eval rollout --model m6.gguf --set train/sessions.jsonl --worlds worlds --out runs/r1 \
    --k 4 --temperature 0.6 --top-p 0.95 --seed 1 --grammar full --tools sig
#    -> runs/r1.rollouts.jsonl (one rollout a line), runs/r1.rollout.json (the report)
# 2. what the model still fails, cut into records and rendered (v1 is the data version sampled over)
datagen rollout-records --in v1 --split train --rollouts runs/r1.rollouts.jsonl --tokenizer tokenizer.json \
    --needs runs/r1.rollout.json --out runs/r1-records      # rft.jsonl, dpo.jsonl, stats.json
#    (assist-eval rollout-records takes --set/--worlds and writes the same files UNRENDERED)
# 3. after the second round, sample the same sessions again and compare
assist-eval rollout --model m7.gguf … --out runs/r2
assist-eval rollout-compare runs/r1.rollout.json runs/r2.rollout.json --out runs/compare.json
```

`rollout-report --rollouts FILE… --out PREFIX` rebuilds a report from rollout files (shards merge). `rollout` takes the flags of a plain run (`--worlds`, `--only`, `--limit`, `--shard K/N`, `--resume`, `--threads`, `--gpu-layers`, `--label`, `--stub`) plus `--k`, `--temperature` (default 0.6), `--top-p` (0.95), `--seed`, and `--grammar off|handles|full` (default: the phone's, `native_turn::phone_options()`; `StepOptions::grammar`, which the step turns into `handles` under `--tools s2`). `--resume` counts a session as done only with all its `k` samples.

**Sampling is in the engine, behind the `engine` feature.** `centraid-assist-llama` decoded greedily only; `Config` now has `top_p` and `seed`, and a generation with `temperature > 0` draws from the tokens the grammar allows (`assist-llama/src/sampling.rs`: temperature, top-p over the best 256 tokens, a seeded generator; unit-tested without llama.cpp). The phone's `temperature == 0.0` takes the greedy path unchanged. One seed repeats a whole run in order; each generation takes its own stream, so the `k` decodes of one prompt differ. The engine wiring (`engine.rs`) is **unverified**: it needs the llama.cpp build, and no weights were available to run it.

**A rollout is a whole session run free** (`rollout::Rollout`: a `SessionResult` and its sample number): the model's own calls are the history its later turns see. A turn after a failed one is downstream of the failure, so every rate below counts a rollout's turns up to and including its first failure (the eval's clean turns). Each turn result also keeps `said` (the messages the model wrote) and `cell`.

### Reports

`rollout.json` (`rollout::report::RolloutReport`): session pass over rollouts and pass@k over sessions; turn pass; and for each **grid cell** (`tool/kind/verb`, read off the reference calls: `answer/task`, `do/task/complete`, `compute/transaction/sum`; datagen's primary cells), each **tag** (datagen's `outcome:…`, `reference:…`, `pair:…`), each **constraint count**, each **app** and each **argument class** (rows, date, filters, amount): passing samples over samples with a 95% interval, how many distinct turns the slice holds, how many some sample solved (`solved`) and how many one sample solved and another failed (`mixed`, what a DPO pair can be cut from). `rollout-compare BEFORE AFTER` puts two reports side by side per measure: both rates, the change in points, and `*` where the intervals do not overlap; the biggest losses sort first so a regression is not buried. A cell only one report has is shown with the other side empty.

### Records

**Records come from the train split only.** `records::cut` (so both `assist-eval rollout-records` and `datagen rollout-records`) refuses before writing anything when any session of the set is from `val`, `test` or `noise`. A session carries its split (`gold::Session::split`): `DatagenSource` marks every record with the split file it came from, and a JSONL set named for its split (`val.jsonl`, `<dir>/test/sessions.jsonl`) marks its sessions; a record that says its own split keeps it. A set that names no split cannot be told apart and passes, so name train sets `train.jsonl`.

Both are in the data version's record shape (`id, world, today, me, tags, turns[{user, gold, ref, tags}]`, then `render`). On the assistant side of each turn **`ref` holds the calls the model made and `said` the messages it wrote**; a renderer renders `said` where a turn has it, `ref` otherwise. `gold` and `user` come from the source set (`--set`, the datagen `sessions.jsonl` or the frozen set; a `.zst` set must be decompressed first, `JsonlSource` reads plain JSONL).

- **RFT** (`rft.jsonl`): each rollout's passing prefix (every turn before its first failure; a rollout that fails its first turn gives nothing), deduplicated among a session's samples by the messages. **Weighting is by duplication:** a record's `weight` is `1 + 2·(worst fail rate among the cell and tags of its turns, from `--needs`) + 2·(mean fail rate of the argument classes its turns state)`, the largest over its turns; the line is written `round(weight)` times (at least 1, at most `--max-copies`, default 4; ids `S~s0`, `S~s0~d1`, …) and also carries `weight` for a trainer that would rather sample. `--needs` is a rollout report or an `assist-eval` report; an entry with fewer than `--min-samples` (5) samples is ignored; with no `--needs` every weight is 1.
- **DPO** (`dpo.jsonl`): `{"id", "chosen": R, "rejected": R, "decides": [...], "cell", "turn"}`, `R` a record cut after the turn the pair is about. The pair is **placed on the first failing turn** of the rejected rollout and its chosen side is another sample that passed that turn **on the same prompt**: both passed every earlier turn with identical messages (a different history is a different prompt, so no pair). The failing turn must have chosen the right act (`tool_name_ok`: a decline where a read was wanted is not an argument failure), and the two calls must **differ in a deciding argument**, one of the eval's four classes (rows, date, filters, amount), compared as the scorer compares them. Among passing samples the one that differs in the classes the rejected turn got wrong is taken, then the fewest steps. At most `--pairs-per-turn` (2) pairs per turn, each from a different failing message. `stats.json` counts what was left out and why (no passing sample on the same prompt, wrong act, no deciding argument, duplicates).

**Rendering is `datagen`'s.** `rollout::records::RenderRecord` is the trait that fills `render {input_ids, weights, text}` (`records::render_all`, or `records::cut`, which cuts, renders and writes `rft.jsonl`, `dpo.jsonl` and `stats.json`). This crate cannot link the M4 renderer (`datagen` depends on it), so `assist-eval rollout-records` writes **unrendered** files and says so; **`datagen rollout-records --in <data version> --rollouts … --tokenizer tokenizer.json --out DIR`** takes the same flags (`--needs`, `--min-samples`, `--max-copies`, `--pairs-per-turn`) over a data version's sessions (`--split`, default `train`) and writes the same files with `render` on every record, the one the trainer reads. Its renderer replays what the model said through the runtime on the record's world and renders the conversation the model saw, with the data version's loss mask (see `crates/datagen/README.md`).

### The Kaggle steps (not run)

Both steps need Kaggle credentials and the owner's go-ahead to upload data; neither exists yet, and `kaggle kernels push` was never run.

1. **Sampling on GPU.** A script kernel like the eval kit's (`kaggle/`): build `assist-eval --features cuda`, then run `assist-eval rollout --model <the chosen M6 arm's Q4_0 GGUF> --set <train sessions> --worlds <worlds> --gpu-layers 999 --shard K/N --k 4 --temperature 0.6 --seed <N+K> --out /kaggle/working/shard-K`, one process per GPU (use a different `--seed` per shard), `--resume`. The sessions and worlds come from the M4 data version in the same private dataset as the model; decompress `train.jsonl.zst` first. Then `rollout-report --rollouts shard-*.rollouts.jsonl` for one report and `datagen rollout-records … --needs <report>` for `rft.jsonl` and `dpo.jsonl`. Records are cut with `datagen rollout-records` (not `assist-eval rollout-records`, which cannot render) against the same data version, so they carry `render` when they go to the trainer. Sampling a training split with a model that saw it is the point (the cells it still fails); the **test split is not touched**.
2. **Second-round training.** The M6 trainer (`experiments/toolchat/native/train/train.py`) continues from the chosen arm's checkpoint: RFT is SFT on `rft.jsonl` (mixed with, or after, the original data; the weights are already in the duplicated lines), DPO is its `--dpo` mode on `dpo.jsonl` (`chosen`/`rejected` records, the shared prefix being the pair's earlier turns). Both read `render.input_ids` and `render.weights`. Export to GGUF as in M6 (`--no-mtp`, Q4_0, output tensor Q8_0), then step 3 above: sample the same sessions again, compare with `rollout-compare`, and score val with the plain `assist-eval` run against the M6 winner. Test is checked only at the milestone.

## Tests

`cargo test -p centraid-assist-eval`: the scorer on hand-made gold and effects (`judge.rs`, `effect.rs`), the constraint count and argument classes (`args.rs`), the sources (`source.rs`), `tests/rollout.rs` (a scripted model plays several samples through the real runtime; the rollout report and its comparison, the RFT weights and the DPO pairs are checked on what it said), and `tests/replay.rs` (the reference replay passes a solvable set and lists the sessions of one that is not), `compare.rs`'s unit tests (won, lost, z, refusals), the degenerate-pass test in `judge.rs`, the report figures in `tests/smoke.rs` (over-refusal, unreadable calls, endings, tokens), the held-out guard in `tests/rollout.rs`, and `tests/smoke.rs`, which seeds a small world into a real vault and replays sessions through the real runtime with a stub in place of the model (no weights).
