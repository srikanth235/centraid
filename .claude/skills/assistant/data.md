# Training data: `crates/datagen`

Held-out gold, English-only synthetic data and spend rules are in [safety.md](./safety.md). Read [`crates/datagen/README.md`](../../../crates/datagen/README.md) for the stages. Where it disagrees with the code on defaults (world counts, mix targets, mix shares), the code wins: [`settings.rs`](../../../crates/datagen/src/settings.rs), [`mix.rs`](../../../crates/datagen/src/mix.rs), [`main.rs`](../../../crates/datagen/src/main.rs).

## Keep in mind

For any change that reaches the fine-tune data, including one made elsewhere (vault, apps, tools).

- A change to a tool's arguments or result, or to the kinds, fields or verbs Chat can use, changes what the data should contain. Kinds, fields and verbs move the catalog hash and argument changes move the tool hash, so `data-pin` sees them. A change to what a tool _returns_ moves no hash and the gate stays green; only `datagen drift` on the pinned version shows it.
- After such a change, run `datagen drift` on the pinned version before merge and report its summary lines (the contract, shape, behaviour and coverage counts, and the level) to the owner.
- When `data-pin` fails, the rule is working. Never edit the pin's own hashes. Run drift, mark the pin `stale` with the level drift reports, `since` and `at` (the bullet on the pin under [Render and the version](#render-and-the-version)), and tell the owner.
- The mix balances cells of (tool, kind, verb or op) and the outcome, action, reference and session shares. Fields are not a balanced dimension: the sampler picks a few fields per kind by hand (`create` in `sample.rs`), so nothing makes create and edit set every field the tools can set. This is a known limit of the generator.
- Drift's kind coverage counts only calls that carry a `kind` argument naming the kind, so a kind reached another way is not counted.
- Chat is meant to create Locker secrets, so create and edit intents for Locker, money and measurement fields are gaps to fill in the data, not exclusions. Today a Locker create sets a name and a type and no secret field, and `reveal` is not drawn.
- That fits "Locker is presence only" and [safety.md](./safety.md): a stored sealed value never reaches the model or the data; a secret the member types into Chat is the one secret the model may see. A typed secret in a training request is a synthetic value, never a stored one. The writer is told never to write a secret and `messages::no_sealed` refuses a prompt holding a placeholder, so those intents are not generated yet.
- An offline rebuild of a version needs its packed LLM cache (in the held-out repo only) and the base model's `tokenizer.json`. Without both it is not possible, and a cold build makes paid LLM calls: check [safety.md](./safety.md).
- Drift needs only a fetched version's manifest, train and val, `worlds/` and `contract/`. A version built before the contract block needs `datagen restamp` first. `restamp` proves the tool catalogue against the records but takes the rest of the prompt hash from the checkout.
- Versions go only to `srikanth235/centraid-assist-data` and `srikanth235/centraid-assist-heldout`. `srikanth235/centraid-native-data` is retired and never published to. A tag is never overwritten, and readers pin a tag.
- Build and publish a new version only on the owner's go-ahead.

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
- A version is `manifest.json`, `data/{train,val,test,noise}.jsonl.zst`, `worlds/`, `build/` and `contract/` (the tool catalogue and static prompt the data was rendered for; the manifest's `contract` block holds their hashes and `heldout` points at the held-out repo). `datagen build` also keeps `stages/`, which is not published. The trainer reads `render.input_ids` and `render.weights` only.
- The manifest records the catalog hash, the runtime commit (`-dirty` when the tree is), the seeds, the tokenizer hash, the cache hash, per-split counts and each file's BLAKE3. A rebuild from the same inputs is byte-identical.
- `datagen publish` checks a version (file hashes, a clean build, marked publishable, no sealed placeholder, a contract block whose files hash to it) and, with `--upload`, `--repo`, `--heldout-repo` and `HF_TOKEN`, commits it to two private dataset repositories, each as one commit on `main` and one tag named by the version, never over an earlier tag (refused in either repo before anything is sent). The data repo (`srikanth235/centraid-assist-data`) holds train, val, noise, their worlds, `contract/` and `reports/`; the held-out repo (`srikanth235/centraid-assist-heldout`) holds the test split, its worlds and the packed LLM cache, and nothing of them is in the data repo. A version's tree is exactly its files in each repo: the commit removes every other path except `.gitattributes`, and the dry run lists the removals. It is a dry run without `--upload`. `datagen restamp --in DIR` gives a version built before the contract block the block, after proving the tools block is in every train and val record (it never reads test). Readers pin a tag, never a branch. Uploads need the go-ahead in safety.md.
- `crates/assist/data.json` pins the data version the assistant is trained on (both repos, the version, the tools mode and the hashes of the tool catalogue and static prompt, the catalog and tokenizer hashes). The `data-pin` rule of `cargo xtask rules` computes the runtime's hashes for that mode offline and fails when they differ, in words: data `<version>` was built for a different tool contract; publish a new version and update the pin, or mark it `stale: {since, level, at}` after `datagen drift`, where `at` holds the runtime's `tools_hash`, `prompt_hash` and `catalog_hash` the mark was made at. A stale pin passes and prints a notice only for that contract: if the runtime's hashes differ from the pin and from `at`, the rule fails and prints the current hashes to put in `at`. Never edit the pin's own hashes to get past it. The catalog hash is asked of `datagen catalog` (offline) and compared like the other two.
- `datagen drift --in DIR` (a built version or one fetched from the data repo; it needs the contract block) replays the reference calls of train and val, never test, through the current tools and reports in counts: the contract hashes same or different, calls that no longer validate by tool and argument (shape), calls that run but give another result (behaviour), tools, arguments and kinds with under the floor of examples (coverage), and the level. `wording`: re-render from the cache. `shape` or `behaviour`: regenerate those sessions. `coverage`: new intents. That level is what `stale.level` takes.
- `rollout-records` cuts training records from the train split only and refuses another before loading the tokenizer ([eval.md](./eval.md)).

## Run

`cargo run --release -p centraid-datagen -- build --version vN --out DIR --tokenizer tokenizer.json [--offline]`. Others: `catalog`, `worlds`, `intents`, `messages`, `render`, `publish`, `test-tokenizer`, `show`, `unpack-cache`, `rollout-records`, `ambiguity`. Test with `cargo test -p centraid-datagen`. The tests replay every reference call through the eval runner and check a rebuild is byte-identical.
