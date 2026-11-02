---
name: screen-change
description: >-
  Add or change a screen end to end in Centraid: the Rust screen in crates/screens, its protobuf contract (*_screens.proto, route.proto, screens.proto), the Compose and SwiftUI renderers, effects, generated design tokens and kit words, the native-shell-parity gate, and tests on each layer. Use whenever a task says "add a screen", "new page", "change what the app shows", touches a ViewState, ScreenEvent, Effect or Route, a string a person reads, a design token, or a view under mobile/androidApp or mobile/iosApp.
---

# Changing a screen, end to end

The product decision lives in Rust. The shells only draw. Most "UI" work is therefore a Rust change plus two thin views, and the failures come from skipping a layer or from putting a decision in a view.

## 1. What this change touches (in order)

1. **Contract**: `crates/api-proto/proto/centraid/core/v1/<app>_screens.proto` (view states and events), `route.proto` (route arguments), `screens.proto` (the `Route.args`, `ScreenEvent.kind`, `ViewState.kind` and `Effect.kind` oneofs), `kit_screens.proto` (shared vocabulary: `Failure`, `Loading`, `Denied`, `EmptyState`, `StatusLine`, `Confirm`, the trash). A new file is also listed by name in `crates/api-proto/build.rs`.
2. **Screen**: `crates/screens/src/<app>/<name>.rs`, one folder per app, no imports from another app; shared pieces go in `crates/screens/src/kit/`. It is not under `crates/apps/<app>` because the core depends on the app crates and this crate depends on the core (a cycle).
3. **Words**: `crates/screens/src/strings/<app>.rs`, or `<app>_<screen>.rs` for a screen's own, each a `catalog!` block. The kit's fixed words are `strings/shared.rs`.
4. **Registry**: the app's `registry()` returns `Registry::with("<app>.<name>", build)`, merged in `crates/screens/src/lib.rs`.
5. **Android**: `mobile/androidApp/src/main/kotlin/dev/centraid/android/screens/<app>/`, routed from `screens/RustRoot.kt`'s `Page`; effects in `kit/ScreenEffects.kt` (needs the activity) or `session/ShellEffects.kt` (needs only a context). The runtime handle is `dev.centraid.core.Screens` in `mobile/core` (flows `navigation`, `views`, `effects`).
6. **iOS**: `mobile/iosApp/Sources/<App>/`, routed from `RustScreenHost.swift` (the one place that maps `ViewState.kind` to a view); effects in `ScreenStore.swift`; the five-symbol binding is `Core.swift`.
7. **Generated**: design tokens, icon catalogue and kit words into `mobile/androidApp/.../design/{Tokens,Catalog,Words}.kt` and `mobile/iosApp/Design/{Theme,Catalog,Words}.swift`; and `crates/screens/src/catalog.rs` from the app manifests.

## 2. The steps

1. **Decide where the change lives.** A label, count, empty-state choice, enabled flag, ordering, destination or accessibility label is Rust's. If a view needs a value the `ViewState` does not carry, add the field in Rust; never compute it in Swift or Kotlin. A copy edit is a `strings/` edit and nothing else.
2. **Edit the proto first.** Put new messages in the app's file and new oneof arms in the app's reserved range (the `screens.proto` header lists them: 100s agenda, 200s docs, 300s health, 400s locker, 500s money, 600s notes, 700s people, 800s photos, 900s the kit, 1000+ the shell). Compatibility is enforced by `buf breaking` under `WIRE_JSON`: adding fields and arms is fine; never renumber, retype or rename; to remove one, `reserved` BOTH its number and its name. A view has three states (loading, a `Failure`, data); a failed read is never an empty list.
3. **Write the screen.** Implement `Screen`: `update(event, &Ctx) -> Vec<Effect>` and `view(&Ctx) -> ViewState`. Read only with `kit::read::read` (`Data | Denied | Failed`); write only with `kit::act::act`, which answers with the verdict synchronously. Handle `Appeared` (the one load), `DataChanged` (load again), `EffectResult`, `TimerFired`, `Left`. Name apps, actions and queries through the generated `catalog::act::...` / `catalog::load::...` values, never as strings; if an app's `manifest.json` changed run `cargo xtask screens-catalog` (`--check` fails a stale file).
4. **Navigation is data.** A row that opens a page carries a `Route` (`<app>::routes::*`); the shell sends it back as `NavPush`. A finished screen sets `dismissed`/`finished` and the shell pops. One screen reaches another with `Ctx::post(name, event)`.
5. **Strings.** One `catalog!` row per sentence (`plain`, or `counted` for plurals), used in `view` through `strings::<app>::*`. `bun run lint:product` (which runs `scripts/lint-copy.mjs`) bans words (please, simply, seal, ledger, gateway...), dot-joined thoughts and over-long strings by key suffix.
6. **Test in Rust first** (section 5), before any view exists. Behaviour is proven here, not on a device.
7. **Add the Compose view** under `screens/<app>/`, take the `ViewState` arm in `RustRoot.kt`, send `ScreenEvent`s with the `send` lambda. Use only kit controls and tokens.
8. **Add the SwiftUI view** under `Sources/<App>/`, take the arm in `RustScreenHost.swift`. A new `.swift` file or new `.proto` file needs `xcodegen generate` (the target globs a directory; the Xcode project is generated and not committed).
9. **A new effect** (platform work Rust asks for) is an arm in `Effect.kind` plus a performer on BOTH shells. The shell answers with `EffectResult` under the same `effect_id`, in the order asked; a cancel or refused grant answers `EffectFailed`; an effect that answers more than once (a file pick, a network browse) keeps its one id. Never reach the platform from a view outside an effect.
10. **Tokens and kit words.** Edit `packages/design/src` (tokens) or `strings/shared.rs` (kit words), then run `bun contracts/tools/export-native-theme.ts` (it also emits the catalogue and the words) and `bun run format`, and commit the regenerated files.
11. **Parity.** Run `cargo xtask rules` and fix each finding by reading the field in the other shell.

## 3. What must stay true

- **Views decide nothing.** No `.secondary`, SF Symbols or Material icons; every value is a token or a stated geometry; icons come from the emitted catalogue (24x24 path data; Compose `PathParser`, iOS `Sources/Icon.swift`).
- **A shell never names a screen id or a destination.** `native-spells-no-screen-id` scans both shells against the registry. A route is whatever the row carries.
- **Both shells read every field.** `native-shell-parity` (`crates/xtask/src/native_parity.rs`) takes each field of every `*_screens.proto` and `screens.proto` message and asks whether Compose spells it (`.name`, `name =`, `name_`) and SwiftUI spells it (`.camelCase`, `camelCase:`, `_p`). A field only one shell reads, or neither, fails unless it has a row in `native_parity_register.rs` (`Platform`, `Gap`, `RustOnly` or `Runtime`). The register only shrinks: closing a gap deletes its row, and a new row is not how you pass the rule. The match is by field NAME, not message, so two messages sharing a name share a verdict.
- **A decode that fails renders the loading state**, never an empty one: an empty state claims an empty vault before one was read.
- **Every write uses a fresh invoke key** (`kit::act::fresh()`); the vault journals a key for good and a repeat answers "replayed" without running, a silent no-op.
- **Secrets stay where they are drawn**: never in a route, never in a view not asked to draw them. A view with `secure` set needs capture shielding and no clipboard or keyboard learning on both shells.
- **Icon-only controls carry a label** and decorative glyphs say so (`native-accessibility`).
- **Timers live in the runtime** (`ctx.start_timer`); a shell holds none.

## 4. Pitfalls

- **A stale core.** iOS links `libcentraid_core_ffi.a` by path and Android loads a copied `.so` from `jniLibs`; nothing rebuilds either when Rust changes. The app compiles, installs and shows the OLD behaviour with no error. After any Rust change run `mobile/scripts/ios-core.sh` (all slices, or one triple) and `mobile/scripts/android-core.sh`, and compare the file's mtime with your last edit before debugging Swift or Kotlin. Both scripts build `--features llama`; without it every model file reads `NO_ENGINE`.
- **Hand-edited generated files** are overwritten by the next emit, and the gate fails on a diff over `design` and `mobile`. Fix the source (emitter, `packages/design`, `strings/shared.rs`), not the output. A guard belongs on the source too.
- **Tokens.** Never write a hex colour or a parallel colour table in a view; a value that is not a token belongs in `packages/design`, then re-emit.
- **A view that works on one platform.** Add the field to the other shell the same day; the parity rule counts spellings, not rendering.
- **`UIImage(contentsOfFile:)`** returns nil for the content store's extensionless files; use `UIImage(data:)`.
- **Swift written without a compiler** is unproven until a Mac compiles it; say so.

## 5. How to check it

What a Linux cloud session can run:

```sh
cargo test -p centraid-screens          # Driver tests: the screen's behaviour through the shell's own door
cargo xtask rules                       # native-shell-parity, no-screen-id, accessibility, per-app layout
cargo xtask screens-catalog --check     # only if a manifest changed
bun run lint:product                    # copy, native controls, journey ledger
bun contracts/tools/export-native-theme.ts && bun run format && git diff --exit-code -- design mobile
buf lint                                # and buf breaking against the PR base, when buf is installed
cargo xtask gate --profile pr           # the PR gate
cargo xtask gate --profile mobile-jvm   # :core:jvmTest plus the generated-artifact drift check (needs JDK 21)
```

Write the Rust test with `centraid_screens::testing::Driver`: `start()`, `send(instance, event)`, `nav(..)`, `answer_effect(..)`, `pump(wait)`, then assert on `driver.views`, `driver.effects`, `driver.navigation`. `crates/screens/tests/proof.rs` is the model. Cover loading, data, a failed read, empty, a refusal sentence, `Left`, and each effect answer.

A Linux session cannot compile Compose without the Android SDK, cannot compile SwiftUI (UIKit; no Xcode), and cannot run an emulator, a simulator or Maestro, so it cannot show that a view renders. Android builds with `ANDROID_HOME` set and `./gradlew -Pcentraid.android=true :androidApp:assembleDebug` from `mobile/`; iOS needs a Mac (`xcodegen generate`, then the `xcodebuild ... test` command in `mobile/README.md`). To see a screen on a device or emulator, use the `mobile-verify` skill. Say plainly which of these you did not run.

## 6. Final checklist

- [ ] Every decision, string and flag is Rust's; the views only draw the `ViewState`.
- [ ] Proto changes are additive or reserve both number and name; arms are in the app's range; a new file is in `build.rs`.
- [ ] A `Driver` test covers loading, failure, data and each effect.
- [ ] Compose and SwiftUI both exist and read the same fields; `cargo xtask rules` is green and no register row was added to dodge it.
- [ ] A new effect has a performer on both shells and answers under its `effect_id`.
- [ ] Generated artifacts were re-emitted and formatted, never edited; the tree is clean after the emit.
- [ ] New Swift files or protos: `xcodegen generate` was needed and noted.
- [ ] The Rust core was rebuilt per platform before any device check; what was not run (Compose, SwiftUI, a device) is stated.
