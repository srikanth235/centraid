# centraid-datagen

The chat model's training-data pipeline, in Rust ([#1166](https://github.com/srikanth235/centraid/issues/1166)). It drives the `centraid-assist` runtime as a library. Python stays only for the GPU trainer.

## State

Milestone M1 is built: stage 0 and stage 1, plus the ambiguity measure.

| Module | Stage | What it is |
|---|---|---|
| `catalog` | 0 | `Catalog`: the only schema. 18 kinds, 18 `do` verbs with argument class, 48 fields, tools, compute ops, stock lists, sealed fields, and a BLAKE3 `hash()`. |
| `world`, `generate` | 1 | `World::generate(spec)`: a pure function of a `WorldSpec` (split, index, seed) and `Settings`. `plan(master)` makes the 60 specs: 48 train, 6 val, 6 test. |
| `ambiguity` | 1 | `measure(&World)`: shared-name groups, near-duplicate pairs, trashed rows and how many shadow a live name, per kind. |
| `persona`, `settings`, `pools`, `text`, `rng` | 1 | Who a world is about, its knobs, vocabulary, name arithmetic and the seeded stream. |

Everything else in the pipeline (intents, planner, messages, render, mix) is not built. New stages add modules beside these and read `Catalog`; none reads a schema from anywhere else.

### Where the catalog comes from

Nothing is copied by hand that the runtime states. Kinds, fields, fixed-list values, links and verbs come from `centraid_assist::native::meta` (generated from the app manifests); the owning app comes from the manifest that declares the kind; the stock `category` and `workout_kind` lists are read out of `contracts/migrations/001_baseline.sql`. Three things are written in `catalog.rs` because the runtime does not state them: the verb to argument-class table of the issue (a runtime verb it does not classify fails `Catalog::build`), the eight-tool surface and the compute ops. Tools and ops the runtime does not run yet carry `live: false` until the tool regroup lands; the hash changes when it does.

### Worlds

A world is the seed document of `centraid_nativetools::seed`, so it seeds into a real vault through the vault's typed commands (`World::seed_into`) and the runtime reads it back. Settings: `shared_names` (people sharing a first name, other kinds repeating a title), `near_duplicates` (a row's name one typo, word or initial from another's), `trashed`, `history_days`. Each world draws its settings from the presets low, medium and high, jittered by its seed. The runtime reads three months of transactions and ninety days of health, so those two kinds hold at most that much whatever `history_days` says. Rows refer to living people only, because trashing a person trashes what is about them.

The owner's first name comes from a pool per split, so a val or test persona is a name no train world uses.

**Locker is presence only.** The world document names which secrets an item holds (`"sealed": ["password"]`) and never a value. `World::seed_document()` swaps in a placeholder so the vault holds something to reveal; the placeholder is never written to a world file or a prompt. A test reads a seeded world through the runtime and checks none surfaces.

## Commands

```sh
cargo run -p centraid-datagen -- catalog [--out catalog.json]
cargo run -p centraid-datagen -- worlds --seed 1 --out out/ [--counts 48,6,6] [--vaults]
cargo run -p centraid-datagen -- ambiguity --seed 1 [--counts 48,6,6] [--json]
```

`worlds` writes `<out>/<split>/<id>.json` (and `.vault` with `--vaults`) and `manifest.json` (catalog hash, master seed, persona, settings, section sizes and ambiguity per world). The package is `centraid-datagen`; the binary is `datagen`. `build --version vN` will be one more subcommand that runs the stages in order.

## Tests

`cargo test -p centraid-datagen`. `-- --ignored` also seeds all 60 worlds (about two minutes).
