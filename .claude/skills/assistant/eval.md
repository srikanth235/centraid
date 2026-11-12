# Evaluation: `crates/assist-eval`

Held-out gold, GPU scoring runs and tokens are in [safety.md](./safety.md). Read [`crates/assist-eval/README.md`](../../../crates/assist-eval/README.md) for the flags and report fields. Where it disagrees with the code, the code wins; for example the default tools block is the model record's mode, not `sig` ([`bin/assist-eval.rs`](../../../crates/assist-eval/src/bin/assist-eval.rs)).

## What it does

- It replays a set turn by turn through the phone's own step (`decode_step`), lets the real runtime run what the model wrote, and judges each turn by its effect, never by call text.
- It is its own crate because it needs the vault and the world seeder. llama.cpp sits behind its `engine` feature, so the gate builds the rest without it.
- Each session runs on a private copy of its world's vault. Writes run (`Writes::Run`) instead of parking, so the effect is the vault's.

## The set

- A set is one split of one data version ([data.md](./data.md)), read through `EvalSource`. `DatagenSource::open_version` reads a version. `JsonlSource` reads plain JSONL, so decompress a `.zst` first.
- Score on `val`. A set name that carries its split (`val.jsonl`, `train.jsonl`) marks its sessions; a set that names none cannot be told apart.
- Precondition: before any model loads, the reference calls of the very sessions to be scored replay through the same runner and judge, and every turn must pass ([`replay.rs`](../../../crates/assist-eval/src/replay.rs)). No flag skips it. A set the runtime cannot solve scores nothing. A set written before a contract change fails here ([contract.md](./contract.md)). `assist-eval replay` runs the check alone.

## One script, greedy

- One path scores: the `assist-eval` binary. The Kaggle kernel ([`kaggle/kernel.py`](../../../crates/assist-eval/kaggle/kernel.py)) only builds it, calls `replay`, scores in shards and rescores them into one report.
- A plain run decodes under `native_turn::phone_options()`, the one definition the phone uses: greedy, trace v4, think limit 200, 512 tokens, context 8,192, the think under the phone's grammar. It is not copied here.
- `--tools` and `--grammar` change it. The report's label and `config` say what ran. `--adapter` loads an adapter and runs it on for every generation. An adapter that will not load is an error, never the base alone. Its SHA-256 goes in `config`.
- `--stub` loads no weights and declines everything. It is a floor and a check of the rig, not a score.
- Sampling exists only for `rollout`: default temperature 0.6, seeded. Rollouts feed training records. They are never a score.

## What a number may claim

- Counts, never durations. Token counts come from the engine, never seconds.
- A turn passes only if its effect matches an accepted gold and it ended. A write that landed and then looped, hit the step cap or errored fails. Endings are counted apart (`ordinary_fail`, `loop_`, `step_cap`, `error`, `engine_error`), so a crash is not read as a wrong answer.
- A difference needs the paired comparison. `assist-eval compare A.json B.json` pairs by session id and prints won, lost and `z = (won - lost) / sqrt(won + lost)`. `|z| < 2` is noise, and the output says so.
- `compare` refuses reports that scored different sessions, a different tools block or a different grammar, and a report that does not say its tools or grammar. The base and the adapter may differ.
- Arguments the runtime never showed are `unscorable` and left out of the rate, not counted as misses.
- Slices (`by_app`, `by_constraints` with 0, 1, 2, 3 and 4+, `by_tag`) are for finding where a model fails. A claim over a slice needs the same pairing.
- The score typed into `model-pin` is typed, not computed ([model.md](./model.md)). Take it from a run of this tool.
- The baseline is the stock base, no adapter, on `val`, decoded as the phone decodes. An adapter is scored the same way and compared against it.

## The Kaggle kit

- It only scores. It pins the base by URL and SHA-256 from the record, and the `val` file by tag and by the BLAKE3 the version's manifest records. A mismatch stops it. The data is private, read with a Kaggle secret `HF_TOKEN` attached by hand.
- `make_bundle.sh` refuses uncommitted changes, because the kernel builds `HEAD`.
- Starting it is a cloud run. Ask first ([safety.md](./safety.md)).

## Rollouts

- `assist-eval rollout` samples `k` decodes of whole sessions free, so the model's own calls are the history. Reports give pass@k and rates per grid cell, tag, constraint count, app and argument class. `rollout-compare` puts two side by side.
- `records::cut` cuts training records from the train split only. It refuses any session whose split is `val`, `test` or `noise` before writing anything. `datagen rollout-records` renders them ([data.md](./data.md)).

## Run

`cargo test -p centraid-assist-eval` uses a scripted model and a stub, with no weights. A scoring run needs the engine feature:

```sh
cargo build --release -p centraid-assist-eval --features engine --bin assist-eval
target/release/assist-eval replay --set val.jsonl --worlds worlds
```
