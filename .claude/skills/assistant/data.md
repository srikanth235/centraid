# Training data: `crates/datagen`

Held-out gold, English-only synthetic data and spend rules are in [safety.md](./safety.md). Read [`crates/datagen/README.md`](../../../crates/datagen/README.md) for the stages. Where it disagrees with the code on defaults (world counts, mix targets, mix shares), the code wins: [`settings.rs`](../../../crates/datagen/src/settings.rs), [`mix.rs`](../../../crates/datagen/src/mix.rs), [`main.rs`](../../../crates/datagen/src/main.rs).

## What it is

Rust, driving the `centraid-assist` runtime as a library. Python stays only for the trainer ([training.md](./training.md)). Each stage is a pure function of its input, its seed and the LLM cache.

1. `catalog`: the only schema. Kinds, fields, links and verbs come from the runtime's `meta`, so a runtime change flips it. Three things are written here: the verb to argument-class table, the eight-tool surface and the compute ops. Its BLAKE3 goes in every manifest. A change in the contract reaches here: [contract.md](./contract.md).
2. `world`, `generate`: a world is a pure function of (split, index, seed) and its settings.
3. `sample`, `plan`: typed intents drawn target-first, then solved through the runtime. Gold is the runtime's effect.
4. `messages`, `verify`: an LLM writes what a person types, then it is checked and read back.
5. `render`, `mix`, `version`: render as the phone renders, choose the sessions, write the tree.

## Worlds

- A default run has 48 train, 8 val and 12 test worlds. Each seed is drawn from the master seed by split and index, so a world is in one split and a split can grow without moving the others.
- Settings come from presets (low, medium, high, medium in turn; world 6 of every eight is a very large vault at scale 16, world 7 an empty one), jittered by the world's seed: shared names, near-duplicate names, trashed rows, history days.
- The member's first name is drawn from a pool per split, so a held-out world is a held-out person. Names a request creates come from pools in `pools.rs`, also split.
- Locker is presence only. A world names which secrets an item holds, never a value. A placeholder is put in memory to seed a vault and is never written to a world file, a prompt or a record.

## Balance

- The mix balances by what the model decides, not by app. App is a tag in the report and never a target.
- Targets, per split: the live primary cells (tool, kind, verb or op) share the turns equally, with a floor of 30 turns per live cell in train. Outcome shares are done .65, nothing found .08, ask .10, decline .07, repair .10. Action is read .45, write .45, recall .10. Reference is name .40, filters .25, pronoun or earlier answer .20, nickname or misspelling .15. Impossible requests are .05. Sessions are one, two, and three-plus turns at 40, 30, 30, and 20% touch two kinds.
- Defaults are 5000, 500 and 1000 sessions. `build` draws half again as many as the targets so the mix can choose.
- A cell the runtime or the world cannot serve is not live and is never faked. The report says `hit`, `supply` or `short` per cell and lists what the input could not give.
- Duplicates go out, test read first, then val, then train. A minimal pair stays whole or goes. Eight combinations are reserved for test and are out of train and val. Train subsets of 1,000 within 2,500 are files of their own (`data/<name>.jsonl.zst`). Noise is the heavy-typo copy of val.
- The mix asserts that no world is in two splits.

## Messages

- The writer sees a brief in the vault's words, the strings it must say verbatim and how the turn points at rows. It never sees a tool call, a handle or a sealed value; `messages::no_sealed` refuses a prompt that holds one.
- Checks: hygiene, spans, a pronoun turn not repeating a name. Typos are seeded and never touch a span, a digit or a date word. Ground solves the session again against the real message. Read-back compares what a second pass understood with the intent.
- The writer and the reader are set per split (`--writer`, `--reader`, defaults in `ModelArgs`, `main.rs`). The test split's writer differs from train's, and no split's reader is its writer. A rehearsal stand-in makes no call and marks the version not publishable.
- Outputs are cached under `llm-cache/` by BLAKE3 of model name and prompt. A cold run makes LLM calls through the `Llm` trait; check safety.md before one. `--offline` makes a miss an error. A warm rebuild is byte-identical.

## Render and the version

- The think of each call is traced (v4) and must round-trip through `compile_think_with`. The observation is what the runtime answers. `Log::transcript` writes the text, so nothing here writes a byte of the prompt format.
- Weights per token: 0 on the system turn, user turns, tool results, and calls the runtime was expected to refuse. 1 on every other assistant token. `DECISION_WEIGHT` (2) on deciding tokens. `bpe.rs` reads the base's `tokenizer.json` and refuses another shape.
- A version is `manifest.json`, `data/{train,val,test,noise}.jsonl.zst`, `worlds/` and `build/`. `datagen build` also keeps `stages/`, which is not published. The trainer reads `render.input_ids` and `render.weights` only.
- The manifest records the catalog hash, the runtime commit (`-dirty` when the tree is), the seeds, the tokenizer hash, the cache hash, per-split counts and each file's BLAKE3. A rebuild from the same inputs is byte-identical.
- `datagen publish` checks a version (file hashes, a clean build, marked publishable, no sealed placeholder) and, with `--upload`, `--repo` and `HF_TOKEN`, commits it to a private dataset repository as a branch and tag of its own, never over an earlier one. It is a dry run without `--upload`. The test split is laid out apart from train and val. Readers pin a tag, never a branch. Uploads need the go-ahead in safety.md.
- `rollout-records` cuts training records from the train split only and refuses another before loading the tokenizer ([eval.md](./eval.md)).

## Run

`cargo run --release -p centraid-datagen -- build --version vN --out DIR --tokenizer tokenizer.json [--offline]`. Others: `catalog`, `worlds`, `intents`, `messages`, `render`, `publish`, `test-tokenizer`, `show`, `unpack-cache`, `rollout-records`, `ambiguity`. Test with `cargo test -p centraid-datagen`. The tests replay every reference call through the eval runner and check a rebuild is byte-identical.
