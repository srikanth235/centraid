# The action plane

Every app is reached through two doors. Everything else in a change hangs off them. An app is its `manifest.json`; the rest is generated from it or checked against it.

## The two doors

- **Read: `load(app, query, params)`.** [`load.rs`](../../../crates/core/src/load.rs). The manifest must declare the query, and the core decodes `params` against its schema. A screen calls `Screen::load` ([`screen.rs`](../../../crates/screens/src/screen.rs)); the wire is `LoadRequest` in [`action.proto`](../../../crates/api-proto/proto/centraid/core/v1/action.proto).
- **Write: `act(app, action, input)`.** [`act.rs`](../../../crates/core/src/act.rs). It checks the catalogue, replays a repeated `invoke_key`, refuses a moved vault, validates the input, mints `x-minted` ids, runs the command and returns the inverse. A screen calls `Screen::act`; chat's confirmed card ends in `Door::act_keyed` ([`assist/door.rs`](../../../crates/core/src/assist/door.rs)), which calls it.
- **Not a door:** the shells name no screen id and no vault command (`native-spells-no-screen-id`, `native-names-no-command`), and the wire has no `Command` request (`no-command-request`), all in [`native_rules.rs`](../../../crates/xtask/src/native_rules.rs). Rust screens may still run the shell's own commands (`Screen::command`, for `vault.export_all`).
- **Chat reads and trains differently.** Chat reads rows through the page door every app query reads through (`VaultDoor`), not through `load`. The training harness runs an action's command directly ([`vaultio.rs`](../../../crates/nativetools/src/vaultio.rs)), without the key or frozen-vault checks.

## Who owns what

- **Rust core:** the rules, loaders, actions, catalogue ([`catalog.rs`](../../../crates/core/src/catalog.rs)), money format (`kit/money.rs`), civil time (`kit/civil.rs`), sealing, the duplicate-tap key and Undo (`act/inverse.rs`).
- **Rust screens** (`crates/screens`): every decision, finished strings, counts, navigation, timers. See [screen.md](screen.md).
- **Native UI:** draws only: gestures, sheets, camera, share, clipboard.
- **Training:** its catalogue comes from the runtime's tables, and a run is graded by its effect on the vault (`crates/datagen/src/catalog.rs`, `crates/assist-eval/src/effect.rs`).

## Nothing typed twice

From the manifests ([`crates/apps/kit/src/manifest.rs`](../../../crates/apps/kit/src/manifest.rs)):

| Output | Made by |
| --- | --- |
| The assistant's kinds, verbs and action lookup | `crates/assist/build.rs`, at build |
| The Rust spelling of every action and query (`crates/screens/src/catalog.rs`) | `cargo xtask screens-catalog` |
| The export in `contracts/assist/export/` | `cargo run -p centraid-nativetools --bin nativetools -- export contracts/assist/export` |
| The training catalogue | read from the assistant's tables at run time |

The assistant side, the pin and the prompt are in [contract.md](../assistant/contract.md); do not restate them.

## Rules defined once

[`crates/apps/kit/src/rules.rs`](../../../crates/apps/kit/src/rules.rs) answers what is live (`deleted_at IS NULL`), archived (a `tagged` edge to `flag:archived`), how long trash waits, what a zone-less time means, and where a photograph stands. An app asks it and does not spell its own.

## Derived, not set by hand

- **Card or direct.** `ActionEntry::surface()` decides: a card when the action has no inverse (a `log` is the exception), acts on many items (`bulk`), needs a sealed value, or needs a value chat has no word for. Only direct actions become chat verb rows. The phone runs a model write only when the member confirms its card.
- **A verb is live** when a direct action of a writable kind backs it. `contracts/assist/verbs.json` lists the few `unbacked` rows.
- **`(verb, kind, qualifier)` is unique.** The build fails on two actions that are one.
- **A minted id is declared** on the input property as `"x-minted": true`, and the core mints it when the caller states none.

## What holds it

- A verb backed by an action may not stay `unbacked`, and `(verb, kind, qualifier)` is unique: both fail `crates/assist/build.rs`.
- The census, the live-verb rows and the `meta.rs` guard: [`catalog.rs`](../../../crates/nativetools/tests/catalog.rs). The export is fresh: `export_fixture.rs` there.
- Every manifest query has a reader and every action a command: `load.rs` and `crates/core/src/catalog.rs` tests; the screens catalogue is checked against the manifests by a test in `crates/xtask/src/screens_catalog.rs`.
- The pinned model matches the runtime: the `model-record` step ([`model_record.rs`](../../../crates/assist/tests/model_record.rs)).
- No Kotlin Multiplatform module: `no-kmp-shared`. Shells draw a given route and effect: `native-effect-reasons`, `native-shell-parity`.
- Not held by a check: every action reachable from a screen, from chat and from training (the census measures it by hand); SQL in Kotlin; a second spelling of a kit rule; a screen and chat giving one answer.

## Adding an action

1. The command: [vault-model.md](vault-model.md).
2. The manifest row (verb, kind, `inverse`, `sealed`, `bulk`, `command`, phrasings) and the app's `commands::ACTIONS` row.
3. Regenerate: `cargo xtask screens-catalog`, then the export command above, and add the row to `contracts/assist/catalog-census.csv`.
4. Use it from a screen: [screen.md](screen.md). A promise (trash, Undo, export): [keep-a-promise.md](keep-a-promise.md).
5. Until each of these is done the failing tests name it: the census, the export, the action counts, the screens catalogue. A change that reaches the prompt text also needs `cargo xtask model-pin`: [contract.md](../assistant/contract.md).
