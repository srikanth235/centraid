# Screens

Every decision a person sees is made in Rust: screen state, finished strings, counts, navigation, timers. SwiftUI and Compose draw `ViewState`, send `ScreenEvent`s and perform `Effect`s ([#1135](https://github.com/srikanth235/centraid/issues/1135)). Code: [`crates/screens`](../crates/screens); wire: [`screens.proto`](../crates/api-proto/proto/centraid/core/v1/screens.proto).

## The contract

- **A screen** implements `Screen`: `update(event, &Ctx) -> Vec<Effect>` and `view(&Ctx) -> ViewState`. It reads and writes only through `Ctx::load` / `Ctx::act` — the core's one read and one write, the same door chat and the training harness use.
- **Re-render.** Each `load` records the tables it read; when one changes the screen gets `DataChanged` and loads again. A view is pushed only if it differs from the last, so a screen's own `act` echoes no second draw.
- **Navigation** is a route stack per tab, owned by the runtime. Routes are protos. A shell draws the stack it is given and reports a tap (`NavPush`) or a back-swipe (`NavPopped`) as events; the root of a tab cannot be popped.
- **Effects** are platform work: clipboard, haptic, share, open URL, pick photos, camera, Health read, keychain, screenshot shield, notification. The shell performs one and answers with `EffectResult` carrying the same `effect_id`.
- **Timers** (undo windows, clipboard clear, reveal auto-hide) live in the runtime: `ctx.start_timer(name, after)` and the screen later gets `TimerFired`. They die with their screen.
- **Catalogue ids.** A screen never spells an app, action, query or input name: it builds `catalog::act::<app>::<Action> { .. }` or `catalog::load::<app>::<Query> { .. }` (generated from the manifests by `cargo xtask screens-catalog`; `--check` and a unit test fail on a stale file) and converts it into the request. Mint a fresh `.keyed(..)` per gesture: the core runs one `invoke_key` once.
- **Strings** come from one catalog, [`strings.rs`](../crates/screens/src/strings.rs): typed functions, plural-aware, locale-ready; the locale and zone arrive in `Environment`. Native views write no copy.
- **Wire.** Requests ride `centraid_call` (`Request.screen`); pushes ride `centraid_next_event` (`Event.screen`). The ABI stays five symbols. The runtime is driven from `Handle::call`, change events and wakes inside `next_event`, so it holds no handle reference between calls.
- **A failed read is not an empty list.** A view has three states — loading, a `Failure`, data.

## Writing a screen

1. Add the route, event and view messages in `<app>_screens.proto`, one arm each in `Route.args`, `ScreenEvent.kind` and `ViewState.kind` in your reserved range (listed in `screens.proto`); add the file to `build.rs`.
2. `crates/apps/<app>/src/screens/<name>.rs`: a struct holding the loaded data and local UI state; `update` handles `Appeared`, `DataChanged`, your events, `EffectResult`, `TimerFired`; `view` makes every string through `strings::*`.
3. Register it: `Registry::with("<app>.<name>", build)`.

## Testing

`centraid_screens::testing::Driver` goes through the door a shell uses: `start()`, `send(instance, event)`, `nav(..)`, `answer_effect(..)`, `pump(wait)` (the shell's event thread, for timers and change pushes), then assert on `driver.views`, `driver.effects`, `driver.navigation`. `crates/screens/tests/proof.rs` is the model. This replaces `jvmTest` as the place screen behaviour is tested.

## Drawing

- **iOS**: `Sources/Core.swift` (the C ABI, one `Core` actor), `Sources/ScreenStore.swift` (navigation, views, effects), `Sources/ProofScreenView.swift` (a stack and one screen). Switch on `ViewState.kind`; no screen names in Swift.
- **Android**: `dev.centraid.core.Screens` (`mobile/core`) holds `navigation`, `views`, `effects`; Compose collects them. See `ProofScreen.kt`.

## Porting a KMP screen

1. Read the KMP state machine and its `commonMain` strings; list its events, states and effects.
2. Replace each KMP `suspend` read with `ctx.load` and each write with `ctx.act` (generated ids come from the manifests); a read the manifest lacks is a catalogue gap — add the query, not a side door.
3. Move every string into `strings.rs` (counted ones as `counted`); move timers to `ctx.start_timer`.
4. Port the `jvmTest` cases to `Driver` tests, then delete the KMP screen and its test.
5. Draw the new `ViewState` in SwiftUI and Compose; delete the old native view.
