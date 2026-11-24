# centraid-datagen

The chat model's single evolvable training-data pipeline, in Rust ([#1188](https://github.com/srikanth235/centraid/issues/1188), replacing the legacy M0–M7 multi-stage generator). It drives `centraid-assist` and `centraid-nativetools` directly as libraries so every generated target is proved against the live runtime. Python stays only for the GPU trainer (`experiments/adapter-train/`).

## Four-Part Evolvable Architecture

The pipeline separates **schema meaning** from **natural-language phrasing** so adding, renaming, reformatting, or shifting fields never regenerates unaffected examples:

| Part | Modules | Responsibility |
| --- | --- | --- |
| 1. Schema Declarations & Evolution Diff | `declarations`, `catalog` | Derives all 8 tools, 28 live kinds, 38 live verbs, compute ops, fixed lists, and `ALL_MANIFEST_ACTIONS` directly from `centraid_assist::native::{meta, prompt}`. Every declaration and argument carries `{type, value_maker, live, wording_hint, meaning_key}`. `classify_diff` diffs previous vs current declarations into `Rename`, `Added`, `ChangedMeaning`, and `Removed`. |
| 2. Deterministic Fixture Worlds | `fixture_world`, `world`, `pools`, `text`, `rng`, `ambiguity` | Builds the smallest deterministic vault world per intent (target rows + look-alike distractors, never a whole-vault copy). Mixes 6 currencies (`INR`, `USD`, `EUR`, `GBP`, `AED`, `SGD`, ~40% `INR` base). Train/val/test owner and people pools remain strictly disjoint. Locker rows are presence-only in worlds; member-typed synthetic secrets and `reveal` offers are handled safely without leaking sealed placeholders. |
| 3. Meaning-Keyed Caches & Deficit Planner | `intents`, `deficit`, `phrasing_cache`, `brief`, `style`, `typos` | Cross-product intent blueprint guarantees 100% live tool/arg/kind/`(kind, field)`/`ALL_MANIFEST_ACTIONS` coverage. Strictly isolated caches `<cache>/train/` and `<cache>/heldout/` store phrasings keyed by BLAKE3 of `WordingSignature` (semantic meaning, currency, naming style — never tool/arg names). Computes deficit work orders (train floors `>= 30`, ~10% deliberate refresh) and exports/imports batched writer & selective reader jobs (`8–10` variants/prompt sharing `WRITER_PREFIX`) for Hydrogen swarm subagents. |
| 4. Oracle, Selective Reader, Sharding & Publish | `oracle`, `plan`, `mistakes`, `facts`, `labels`, `verify`, `trace`, `render`, `bpe`, `mix`, `version`, `contract`, `drift`, `publish`, `source`, `rollout` | Replays every kept example on the live runtime to derive exact gold targets; checks reference disambiguation when world neighbourhoods change; triggers selective LLM reader verification only on new/unsettled phrasings; enforces currency phrasing rules (`INR`: `₹`, `Rs`, `Rs.`, `INR`, `rupee`, `lakh`, `crore`; others: `$`, `€`, `£`, `AED`, `S$`). Writes deterministic zstd shards (`data/<split>/shard-XXXX.jsonl.zst`), `manifest.json` (`declarations_hash`, `catalog_hash`, `runtime_hash`, `tokenizer_blake3`, `shards`, `example_ids`), and publishes split repos (`train`/`val`/`noise` -> `srikanth235/centraid-assist-data`; `test` + packed caches -> `srikanth235/centraid-heldout`). |

## Phrasing Cache & Swarm Batch Workflow (Phase D)

`<cache>/train/` (serving `train` + `val`/`noise`) and `<cache>/heldout/` (serving `test` only) are physically separated and never mixed (`--prev-declarations` diffs against each scope's `declarations.json`):

```text
<cache>/
  train/
    declarations.json
    <meaning_key>.json   # phrasing variants + reader check + world id provenance
  heldout/
    declarations.json
    <meaning_key>.json
```

Commands used by Phase D swarm writers/readers (no external paid LLM APIs):

1. Inspect work order & deficit counts:
   ```sh
   cargo run -p centraid-datagen --bin datagen -- plan --dry-run --version v0.4 --cache <cache>
   ```
2. Export pending writer prompts (`8–10` variants per prompt sharing `WRITER_PREFIX`) and selective reader items:
   ```sh
   cargo run -p centraid-datagen --bin datagen -- export-batches --version v0.4 --cache <cache> --out <batches_dir>
   ```
3. Import verified swarm writer/reader JSONL outputs into the isolated caches:
   ```sh
   cargo run -p centraid-datagen --bin datagen -- import-batches --cache <cache> --writer-in <writer.jsonl> --reader-in <reader.jsonl>
   ```
4. Build deterministic sharded version (strictly offline against cache unless `--rehearsal`):
   ```sh
   cargo run -p centraid-datagen --bin datagen -- build --version v0.4 --cache <cache> --out <out_dir> --tokenizer <tokenizer.json>
   ```

## CLI Summary

- `datagen declarations` — print derived declarations (`28` kinds, `38` verbs, `8` tools, `228+` manifest actions) and optionally diff against `--prev <path>` (`Rename` / `Added` / `ChangedMeaning` / `Removed`).
- `datagen catalog [--out <dir>]` — print `catalog` & `declarations` BLAKE3 hashes on stderr (consumed by `cargo xtask data-pin`).
- `datagen plan --dry-run --version <v> --cache <dir>` — report unique meaning keys, passing pool, invalidated keys, refresh keys, targets to rebuild, and train/heldout writer & selective reader counts.
- `datagen export-batches` / `datagen import-batches` — Phase D batch I/O for swarm writer/reader subagents.
- `datagen build` — run full coverage guards, phrasing cache load (`--rehearsal` optional for offline self-tests), runtime oracle replay, currency & Locker checks, floor checks, deterministic zstd sharding, and manifest generation.
- `datagen drift --version <dir> [--fail]` — check built `manifest.json` (`catalog_hash`, `declarations_hash`, tools block) against live runtime.
- `datagen publish --version <dir> [--tag <tag>] [--dry-run]` — enforce `verify_publish_gates` (validates real tokenizer, zero drift problems in train, replay proof, no sealed placeholders) and stage/publish split repos.
- `datagen rollout-records` — render rollout trajectories using the exact build renderer.
- `datagen pack-cache` / `datagen unpack-cache` — deterministic zstd archival of phrasing cache trees.

## Invariants & Guards

- **Single generator**: Legacy modules (`generate`, `settings`, `persona`, `grid`, `sample`, `run`, `llm`, `messages`, `rehearsal`) were deleted; only the 4-part evolvable pipeline exists.
- **No silent misses**: `tests/declarations.rs` and `datagen build` fail if any live declaration/argument produces `0` intents or any entry of `ALL_MANIFEST_ACTIONS` lacks a declared tool path.
- **Train floors & held-out protection**: `datagen build` refuses to publish if any train floor (`>= 30` examples per live cell, `(kind, field)` pair, and live argument) is missed; held-out reservations never pull `train` below a floor.
- **Locker safety**: World fixtures never store or leak sealed Locker values; only synthetic member-typed secrets in Chat and safe `reveal` offers are generated (`safety.md`).
- **Cheap evolution**: Verified in `tests/evolution.rs` with strict count assertions (no wall-clock assertions): `Rename` -> `0` writer prompts; `Added` -> deficit only; `ChangedMeaning` -> `0` new writer prompts & old examples invalidated.

## Adding a Field or an App

1. **Declare it in runtime metadata first**: `declarations.rs` and `catalog.rs` read everything from `centraid_assist::native::{meta, prompt}` (`KINDS`, `VERBS`, `ALL_MANIFEST_ACTIONS`, `prompt::tools()`). Never duplicate kind/field/verb tables by hand inside `crates/datagen/`.
2. **Fixture world support (`fixture_world.rs`)**:
   - **New field on an existing kind**: if its type is standard (`text`, `number`, `money`, `enum`, `bool`, `date`), `declarations.rs` assigns its `ValueMaker`, `wording_hint`, and `meaning_key`, and `intents.rs` automatically emits read/edit/create intents covering it (`tests/declarations.rs` fails if any live arg produces `0` intents). Add a domain-specific sample row field to `fixture_world::build` if the runtime read/edit needs a populated initial value.
   - **New app / kind / verb**: add its minimal deterministic fixture builder arm in `fixture_world::build` (target row + look-alike distractor, seeded into a real SQLite vault cleanly in `tests/worlds.rs`), and if the app introduces a new `do` verb not already in `VERB_CLASSES`, classify it in `declarations.rs::VERB_CLASSES` (an unclassified runtime verb fails `Declarations::build()`).
3. **Run incremental planning (`export-batches` / `import-batches`)**:
   - Run `datagen plan --dry-run --version vN --cache <cache>` against the previous `declarations.json` inside `<cache>/{train,heldout}/`.
   - `classify_diff` guarantees `Rename` / reordered args rebuild targets with `0` writer tokens, `Added` emits writer prompts only for the new deficit up to the train floor (`>= 30`), `ChangedMeaning` invalidates affected entries without new writer prompts, and `Removed` converts entries to decline examples (`0` writer tokens).
   - Export batches (`datagen export-batches`), let Hydrogen swarm writers/readers populate `<cache>/train/` and `<cache>/heldout/`, import (`datagen import-batches`), rebuild (`datagen build`), and run `cargo xtask data-pin --update` once verified.
