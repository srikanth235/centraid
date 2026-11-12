# Changing the tool contract or the prompt

The contract is what the model reads and writes: eight tools (`find`, `compute`, `create`, `edit`, `do`, `answer`, `ask`, `decline`), the kind card, the system turn, the think format and the markers around them. It lives in [`crates/assist/src/native/`](../../../crates/assist/src/native/) (`prompt.rs`, `meta.rs`, `think.rs`, `grammar.rs`, `identity.rs`, `legacy.rs`) and [`escape.rs`](../../../crates/assist/src/escape.rs). The prose is [`SPEC.md`](../../../crates/assist/docs/SPEC.md) and [`CONTRACT_V3.md`](../../../crates/assist/docs/CONTRACT_V3.md). Update them in the same change. The two doors every app is reached through, and what is generated from the manifests, are in [action-plane](../change/action-plane.md).

## What is generated, never hand-edited

- Kinds, verbs, fields, links and actions come from the app manifests (`crates/apps/<app>/manifest.json`). [`crates/assist/build.rs`](../../../crates/assist/build.rs) turns them into `Kind`, `Verb`, `ACTIONS`, `KINDS` and `VERBS` at build time. `meta.rs` holds no kind or verb row, and a test fails if one appears.
- A verb is live when a direct action of a writable kind backs it, or an `unbacked` row in [`contracts/assist/verbs.json`](../../../contracts/assist/verbs.json) does. The build fails when an action now backs an `unbacked` row, so that list only shrinks.
- [`contracts/assist/export/`](../../../contracts/assist/export/README.md) is written by `nativetools export`. Regenerate it, do not edit it:

```sh
cargo run -p centraid-nativetools --bin nativetools -- export contracts/assist/export
```

## What moves with a change

1. **The export.** `crates/nativetools/tests/export_fixture.rs` renders the export to a scratch directory and diffs every file. It prints the regenerate command and the first differing line.
2. **The census.** [`catalog-census.csv`](../../../contracts/assist/catalog-census.csv) has one row per action. `crates/nativetools/tests/catalog.rs` checks the first five columns against the manifests. The last two are measurements, written by hand.
3. **The pin.** `tools_hash` and `prompt_hash` in the model record are BLAKE3 hashes over the pinned mode's tools block, its kind card in `USD`, the identity markers and the escape rule. Change any of that text and `model-record` fails until the record is rewritten with `cargo xtask model-pin`. An adapter made against the old hashes is never used, and the stock model answers. So a contract change that reaches the hashed text means a new adapter. See [model.md](./model.md) and [training.md](./training.md).
4. **Tools modes.** The phone and the eval run the mode named in the record. The `s2` signatures are a frozen constant. The `sig` tools derive from `tools()`. `Flags::default()` is `sig`, and `crates/datagen` renders with it. `model-pin` takes the mode the model learned as `--tools-mode`. Nothing enforces that the data and the record agree, so check the mode before a data version is built.
5. **The grammar.** `native/grammar.rs` builds the think grammar from the catalog and the prompt, per mode. `crates/assist/tests/constrained_output.rs` holds it. `native/legacy.rs` renames the tool names the shipped model wrote, so keep it while that model is pinned.
6. **The think and the renderer.** `compile_think` must give back every reference call. `crates/nativetools/tests/golden_v3.json` holds the call shapes, and `crates/assist/tests/transcript_golden.rs` pins the renderer byte for byte. A format change fails them on purpose.
7. **The data.** [`crates/datagen/src/catalog.rs`](../../../crates/datagen/src/catalog.rs) reads the runtime. A runtime verb it does not classify fails `Catalog::build`. Its hash goes in every data version's manifest, so a data version made before the change is stale. See [data.md](./data.md).
8. **The eval.** A set whose gold predates the runtime fails the replay precondition and scores nothing. See [eval.md](./eval.md).
9. **What the member reads.** Cards map in [`native_turn/cards.rs`](../../../crates/assist/src/native_turn/cards.rs). Sentences are keys in [`copy/chat.json`](../../../copy/chat.json). `crates/nativetools/tests/park_card.rs` holds each mapped write's line to the row it changes.
10. **The vault side.** A new kind, column or command starts in the vault, not here. Follow [vault-model](../change/vault-model.md) first.

## Prompt text and vault text

- Vault text enters the prompt escaped, with special tokens broken by a zero-width space. One site unescapes, on the model's own words, before the call is parsed. `crates/assist/tests/unescape_guard.rs` fails when a second site appears. The gate step `prompt-injection` runs `tests/injection.rs`.
- The system turn is built in `native/prompt.rs` from the date, the member's name, the kind card, the directory and the escape rule.

## Run

- `cargo test -p centraid-assist -p centraid-nativetools -p centraid-datagen -p centraid-assist-eval`.
- The gate profile `pr` runs `model-record` and `prompt-injection` beside the workspace tests.
