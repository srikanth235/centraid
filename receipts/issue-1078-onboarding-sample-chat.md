# Issue #1078 — onboarding deck, sample vault and on-device chat

Umbrella receipt. One receipt for the whole umbrella; later work appends its own section below and never edits a section above it.

## Checklist

- [x] **Onboarding** — the first-launch gate as a three-slip paper deck (iOS) with Skip, "Make a vault on this phone" and "Restore vault"; the framing step before the 24 words; the no-vault Home on the failure branch; no photo-library prompt before a grant
- [x] **Sample vault, core** — the Tahoe scenario as a library (`crates/core/src/sample.rs`), the `sample` mark in `core_vault.settings_json`, pair and drain refused, a half-seeded sample deleted on load, starter rows in the member's own vault
- [x] **Sample vault, iOS** — the notice, Remove/Add sample with confirm, the switcher mark, the pairing sentence
- [x] **Chat plane** — `crates/assist`: the read-only tool registry (Locker excluded by construction), GBNF routing, the prompt budget, the eval fixture and its JSONL export
- [x] **Engine** — `crates/assist-llama`: llama.cpp behind `Model`, the process-wide host in `centraid_open`, CPU on the iOS simulator, the iOS link contract
- [x] **iOS Chat tab** — Home | Chat | More, the model download step, cards that open the real row
- [x] **Fix-up** — one notice slot (R-SAMPLE-8), the sample listed last, the mosaic and Tally tiles, the core dispatcher, `ChatBridge.close`, download progress after a relaunch
- [x] **Free chat** — a question no tool fits gets a streamed, unconstrained reply instead of a refusal
- [x] **Attachments and composer** — a vault photo, a library photo through the vision projector, a text document; the composer card
- [x] **History and navigation** — chats as vault data (rung ten), the drawer, the ☰ · title · ⋮ header, Markdown answers
- [x] **Sample Locker** — the sample opens keyed at its own index; five fake items sealed under the member's own keys
- [ ] **Android** — the deck, the sample notice and the Chat tab on Compose
- [ ] **Fine-tuned model** — the owner's fine-tune replaces stock Qwen3.5-0.8B (19/65 exact routes on the eval fixture)
- [ ] **Device evidence** — Metal and first-load shader compile on a real phone; the Locker reveal on a device

## What changed

- **Onboarding.** `mobile/iosApp/Sources/FirstLaunchView.swift` (the deck), `CentraidApp.swift` (the gate draws bare paper until the shelf has read its directory), `PHASE_FRAMING` in `screen.proto`, and `PlatformServices.ios.kt` (the library observer registers only after a grant).
- **Sample vault.** See [decisions — the sample vault](../docs/decisions.md#the-sample-vault), R-SAMPLE-1…8: `crates/core/src/sample.rs` and `sample/locker.rs`, `Shelf.foundSample`, `HomeSession.addSample`/`removeSample`, and `crates/vault/src/page.rs` (json_extract select entries now come back instead of NULL, which also fixes Photos' `gazetteer`).
- **Chat.** See [decisions — the on-device chat](../docs/decisions.md#the-on-device-chat-keeps-its-history-in-the-vault), R-CHAT-*: `crates/assist`, `crates/assist-llama`, `crates/core/src/assist`, `assist.proto` and `chat.proto`, rung ten (`contracts/migrations/010_chat.sql`), `mobile/shared/.../chat`, and `mobile/iosApp/Sources/Chat`.
- **Docs.** `docs/decisions.md`, `docs/glossary.md`, `docs/vault-ontology.md`, `docs/recovery/pairing.md` and `mobile/README.md`.

## Validation

- **Rust.** Targeted suites green: `centraid-assist`, `centraid-assist-llama`, `centraid-core` (lib, `sample_vault`, `assist_plane`, `assist_eval`, `assist_history`), `centraid-vault` (`chat_schema`, `attachment_source`), `centraid-core-ffi` and `centraid --test seed_demo_vault`. `cargo xtask rules` is clean, and clippy `-D warnings` is clean on the touched crates.
- **Kotlin.** The full `:shared:jvmTest` passes: 1184 tests, 0 failures.
- **iOS.**
  - Simulator walkthroughs covered the deck, the words, the sample, chat (data, free and attachment questions), history across a relaunch, and the sample Locker up to the OS passcode.
  - Maestro: `first-launch`, `sample-vault` and `chat` were run during the lanes.
- **Not run.**
  - `cargo xtask gate`.
  - The Android build.
  - Real-device Metal.
  - The sample Locker reveal on the simulator, which stops at the OS passcode.

## Accounting

Token cost: not recorded.
