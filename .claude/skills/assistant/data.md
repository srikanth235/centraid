# Training data: `crates/datagen`

Held-out gold, English-only synthetic data and spend rules are in [safety.md](./safety.md). Read [`crates/datagen/README.md`](../../../crates/datagen/README.md) for the stages. Where it disagrees with the code on defaults (world counts, mix targets, mix shares), the code wins: [`declarations.rs`](../../../crates/datagen/src/declarations.rs), [`intents.rs`](../../../crates/datagen/src/intents.rs), [`deficit.rs`](../../../crates/datagen/src/deficit.rs), [`mix.rs`](../../../crates/datagen/src/mix.rs), [`main.rs`](../../../crates/datagen/src/main.rs).

## Keep in mind

For any change that reaches the fine-tune data, including one made elsewhere (vault, apps, tools).

- A change to a tool's arguments or result, or to the kinds, fields or verbs Chat can use, changes what the data should contain. Kinds, fields and verbs move the catalog hash and argument changes move the tool hash, so `data-pin` sees them. A change to what a tool _returns_ moves no hash and the gate stays green; only `datagen drift` on the pinned version shows it.
- After such a change, run `datagen drift` on the pinned version before merge and report its summary lines (the contract, shape, behaviour and coverage counts, and the level) to the owner.
- When `data-pin` fails, the rule is working. Never edit the pin's own hashes. Run drift, mark the pin `stale` with the level drift reports, `since` and `at` (the bullet on the pin under [Render and the version](#render-and-the-version)), and tell the owner.
- The mix and deficit planner balance cells of (tool, kind, verb or op) and `(kind, field)` / live argument coverage alongside outcome, action, reference and session shares, derived from `declarations.rs` and `intents.rs`.
- Drift's kind coverage counts only calls that carry a `kind` argument naming the kind, so a kind reached another way is not counted.
- Chat creates Locker secrets using synthetic values typed by the member and supports `reveal` per [safety.md](./safety.md).
- "Locker is presence only" in worlds: a stored sealed value never reaches the model or the data; a secret the member types into Chat is the one secret the model may see. `oracle::check_no_sealed` refuses any message or observation holding a sealed placeholder.
- An offline rebuild of a version needs its packed LLM cache (in the held-out repo only) and the base model's `tokenizer.json`. Without both it is not possible, and a cold build makes paid LLM calls: check [safety.md](./safety.md).
- Drift needs only a fetched version's manifest, train and val, `worlds/` and `contract/`. A version built before the contract block needs `datagen restamp` first. `restamp` proves the tool catalogue against the records but takes the rest of the prompt hash from the checkout.
- Versions go only to `srikanth235/centraid-assist-data` and `srikanth235/centraid-assist-heldout`. `srikanth235/centraid-native-data` is retired and never published to. A tag is never overwritten, and readers pin a tag.
- Build and publish a new version only on the owner's go-ahead.

## What it is

Rust, driving the `centraid-assist` runtime as a library. Python stays only for the trainer ([training.md](./training.md)). Each stage is a pure function of its input, its seed and the LLM cache.

1. `declarations` + `catalog`: the single schema derived from `centraid_assist::native::meta` (`ALL_MANIFEST_ACTIONS`, live kinds, fields, verbs, `ActionSurface`) and `prompt::tools()`. Every tool, kind, field and argument carries `{type, value_maker, live, wording_hint, meaning_key}`; `catalog_hash` and `declarations_hash` go in every manifest. A change in the contract reaches here: [contract.md](./contract.md).
2. `fixture_world` / `world`: each intent gets the smallest deterministic fixture world it needs (referenced rows + look-alike distractors), mixing `INR`, `USD`, `EUR`, `GBP`, `AED`, `SGD` (~40% `INR`) and presence-only Locker secrets.
3. `intents` / `deficit` / `plan`: typed intents crossed with outcome, naming, session length (1, 2, 3+), undo and impossible, planned by deficit (`floors >= 30` minus passing cache pool) and solved through the runtime. Gold is the runtime's effect.
4. `phrasing_cache` / `messages` / `oracle`: meaning-keyed phrasing caches (`<cache>/train/` and `<cache>/heldout/`, strictly isolated) written and read back via swarm batches (`export-batches` / `import-batches`), checked by hygiene, currency rules, the current-runtime oracle and ambiguity resolver.
5. `render`, `mix`, `version`: render as the phone renders, choose the sessions, write sharded zstd files (`data/<split>/shard-XXXX.jsonl.zst`) and the manifest (`schema_version: 2`).

## Worlds

- Worlds are minimal deterministic fixture worlds per intent (referenced rows plus look-alike distractors), seeded by `(split, index, seed)` so no world is in two splits.
- Money worlds mix `INR`, `USD`, `EUR`, `GBP`, `AED`, `SGD` with ~40% `INR` base currency.
- The member's first name and created names are drawn from split pools so a held-out world is a held-out person.
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
- Phrasings are stored in meaning-keyed caches (`<cache>/train/` and `<cache>/heldout/`, strictly isolated and never mixed), keyed by BLAKE3 of the semantic intent signature (not tool or argument spelling). Swarm writer/reader batches are exported with `export-batches` (8-10 variants per prompt) and validated on `import-batches` (`--offline` fails on a miss). A rehearsal stand-in makes no model call and marks the version not publishable. A warm rebuild is byte-identical.

## Render and the version

- The think of each call is traced (v4) and must round-trip through `compile_think_with`. The observation is what the runtime answers. `Log::transcript` writes the text, so nothing here writes a byte of the prompt format.
- Weights per token: 0 on the system turn, user turns, tool results, and calls the runtime was expected to refuse. 1 on every other assistant token. `DECISION_WEIGHT` (2) on deciding tokens. `bpe.rs` reads the base's `tokenizer.json` and refuses another shape.
- A version (`schema_version: 2`) is `manifest.json`, sharded `data/<split>/shard-XXXX.jsonl.zst` (plus `shards` and `example_ids` in `manifest.json`), `worlds/<split>/`, `build/` and `contract/` (the tool catalogue and static prompt the data was rendered for; the manifest's `contract` block holds their hashes and `heldout` points at the held-out repo). `datagen build` also keeps `stages/`, which is not published. Each turn carries optional `app`, `apps`, `outcome`, `field`, `fields`, `currency`, and `slice` metadata for `assist-eval` slicing; the trainer reads `render.input_ids` and `render.weights` only.
- The manifest records `catalog_hash`, `declarations_hash`, the runtime commit (`-dirty` when the tree is), the seeds, the tokenizer hash, the phrasing cache hashes, per-split counts and each file's BLAKE3. A rebuild from the same inputs is byte-identical.
- `datagen publish` checks a version (file hashes, a clean build, marked publishable, no sealed placeholder, a contract block whose files hash to it) and, with `--upload`, `--repo`, `--heldout-repo` and `HF_TOKEN`, commits it to two private dataset repositories, each as one commit on `main` and one tag named by the version, never over an earlier tag (refused in either repo before anything is sent). The data repo (`srikanth235/centraid-assist-data`) holds train, val, noise shards, their worlds, `contract/` and `reports/`; the held-out repo (`srikanth235/centraid-assist-heldout`) holds the test shards, test worlds and the phrasing caches, and nothing of test is in the data repo. A version's tree is exactly its files in each repo: the commit removes every other path except `.gitattributes`, and the dry run lists the removals. It is a dry run without `--upload`. `datagen restamp --in DIR` gives a version built before the contract block the block, after proving the tools block is in every train and val record (it never reads test). Readers pin a tag, never a branch. Uploads need the go-ahead in safety.md.
- `crates/assist/data.json` pins the data version the assistant is trained on (both repos, the version, the tools mode and the hashes of the tool catalogue and static prompt, the catalog/declarations and tokenizer hashes). The `data-pin` rule of `cargo xtask rules` computes the runtime's hashes for that mode offline and fails when they differ, in words: data `<version>` was built for a different tool contract; publish a new version and update the pin, or mark it `stale: {since, level, at}` after `datagen drift`, where `at` holds the runtime's `tools_hash`, `prompt_hash` and `catalog_hash` (and `declarations_hash` when pinned) the mark was made at. A stale pin passes and prints a notice only for that contract: if the runtime's hashes differ from the pin and from `at`, the rule fails and prints the current hashes to put in `at`. Never edit the pin's own hashes to get past it. The catalog and declarations hashes are asked of `datagen catalog` (offline) and compared like the other two.
- `datagen drift --in DIR` (a built version or one fetched from the data repo; it needs the contract block) replays the reference calls of train and val, never test, through the current tools and reports in counts: the contract hashes same or different, calls that no longer validate by tool and argument (shape), calls that run but give another result (behaviour), tools, arguments and kinds with under the floor of examples (coverage), and the level. `wording`: re-render from the cache. `shape` or `behaviour`: regenerate those sessions. `coverage`: new intents. That level is what `stale.level` takes.
- `rollout-records` cuts training records from the train split only and refuses another before loading the tokenizer ([eval.md](./eval.md)).

## Run

`cargo run --release -p centraid-datagen -- build --version vN --cache DIR --out DIR --tokenizer tokenizer.json [--offline]`. Others: `catalog`, `plan`, `export-batches`, `import-batches`, `worlds`, `intents`, `messages`, `render`, `drift`, `publish`, `test-tokenizer`, `show`, `unpack-cache`, `rollout-records`, `ambiguity`. Test with `cargo test -p centraid-datagen`. The tests replay every reference call through the eval runner and check a rebuild is byte-identical.
