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

## Evidence: the PR gate's fixes for #1078's code (2026-10-08)

- **`FoundContent`'s zero value** is `FOUND_CONTENT_UNSPECIFIED` (`e218c9e2c`), as `buf lint` requires. The number and meaning are unchanged: a found that names no content gets what founding always writes. The enum is not on `main`, so no wire contract breaks (`buf breaking` against `main`: exit 0).
- **llama.cpp builds only where the phone's core is built** (R-CHAT-10; `abb4e8e61`, `d16610b1a`).
  - **Feature split.** `centraid-assist-llama`'s `llama-cpp-2` is optional behind `engine`. `centraid-core-ffi`'s `llama` enables it and is no longer a default feature.
  - **Phone builds.** Every phone build passes `--features llama`: prebuilt-core Android and its artifact key, the three iOS slices, `mobile/scripts/android-core.sh`, the mobile README and the stale-core trap.
  - **PR gate.** The gate's workspace build no longer contains llama.cpp: `cargo tree --workspace -e features -i llama-cpp-sys-2` matches no package. A new always-on `engine` job lints and tests with the engine on.
  - **Why.** On CI the PR gate took 1,625.7 s of its 1,500 s budget, against 880.6 s on `main`. One cold debug build of llama-cpp-sys-2 takes about 5.5 min here.
  - **Tests that follow the split.** `crates/core-ffi/tests/assist.rs` gates its engine cases on `cfg(feature = "llama")` and gains `a_core_as_opened_without_the_engine_reads_a_model_file_as_no_engine_and_will_not_load`. The `assist-eval-llama` binary and the two real-model suites (`real_model.rs`, `real_vision.rs`) carry `required-features = ["engine"]`.
  - **One assertion widened.** `AssistRoundTripSpec` (`mobile/core`) asserted `ASSIST_MODEL_STATE_PRESENT` for a model file on disk. It now accepts `PRESENT` or `NO_ENGINE`. The JVM tests load a host core built without the engine, so `NO_ENGINE` is the true answer there, and the engine-wired answer is asserted in Rust by the `engine` job: `a_core_as_opened_reads_a_model_file_as_present_and_refuses_a_file_that_is_not_one` in `crates/core-ffi/tests/assist.rs`, built with `--features llama`.
  - **Docs.** The required-checks lists in `TESTING.md`, `crates/xtask/README.md`, `docs/dev-environment.md`, `docs/release.md`, `docs/release/v1-handoffs.md` and `docs/toolchain.md` name the `engine` job; `docs/decisions.md` gains R-CHAT-10. The comment in `mobile/shared/build.gradle.kts` that names the phone's link input now says `--features llama` (fixed after the first audit).
- **Open.** Nothing asserts that a phone build carries the engine; a build that forgets `--features llama` answers `NO_ENGINE`. The owner must add `engine` to the required checks.

## Verification

```
cargo xtask gate --profile local          # PASS on 30c414b24: fmt, clippy -D warnings, cargo test --workspace, restore-drill, rules, ledgers. The target was purged of all 26 workspace crates at 05:13 (`cargo clean -p` each); the merges' builds since relinked 23, so the gate's header reads "3 of 26 workspace member(s) have no linked artifact"
PATH=$S/tools:$PATH cargo xtask gate --profile mobile-jvm   # PASS — 250.9 s of 420 s; no fixture drift
```
```
buf lint                                                   # exit 0
buf breaking --against '.git#ref=f54876780,subdir=crates/api-proto/proto'   # exit 0
cargo tree --workspace -e features -i llama-cpp-sys-2      # no match: the workspace build carries no llama.cpp
cargo clippy -p centraid-assist-llama -p centraid-core-ffi --all-targets --features centraid-core-ffi/llama -- -D warnings   # exit 0 (engine lane)
cargo test -p centraid-assist-llama -p centraid-core-ffi --features centraid-core-ffi/llama   # pass; 9 ignored need a GGUF, 2 of them also its projector (engine lane, engine-test-on.log)
```

## Audit

**REFUTED**

Audited 2026-10-08 by a reviewer who did not write the receipt, for the section "Evidence: the PR gate's fixes for #1078's code (2026-10-08)" and its `## Verification` only, against `e218c9e2c`, `abb4e8e61`, `d16610b1a` and the merge `acad4110f`, the logs in the root agent's scratchpad (`final-gate-local.log`, `final-gate-mjvm.log`, `final-verify.log`, `engine-summary.log`, `engine-clippy-on.log`, `engine-test-on.log`, `ci/gate79.txt`, `ci/gate-main.txt`, `ci/llama-measure.log`), my own re-runs and `.governance/law/rules/receipt-per-issue.mjs`. The sections above were not re-audited. The fixes that bring it to PASS are named in the bullets: two wrong or overstated Verification lines and the unnamed changes.

- **The appended section against the diff.** REFUTED on omissions; every claim it makes holds.
  - Held. `FoundContent`'s zero is `FOUND_CONTENT_UNSPECIFIED = 0` in `vault.proto`, with `STARTERS = 1` and `SAMPLE = 2` unchanged, and `origin/main` has no `FoundContent`. `llama-cpp-2` is `optional = true` behind `engine` in `centraid-assist-llama`; `centraid-core-ffi`'s `llama = ["dep:centraid-assist-llama", "centraid-assist-llama/engine"]` with `default = []`. `--features llama` is on the Android artifact key and `cargo ndk` build, on the iOS key and all three `cargo build --target` slices in `lane-prebuilt-core.yml`, in `android-core.sh`, `mobile/README.md` and `docs/traps/stale-core-slice.md`. `gate.yml` gains a third job, `engine`, that runs `cargo clippy` and `cargo test` over the two crates with `--features centraid-core-ffi/llama`; its comment says the owner must make it a required check. `cargo xtask artifact-key … --features llama` is accepted (I ran it).
  - Not named. `mobile/core/.../AssistRoundTripSpec.kt` changes an existing assertion from `present.state shouldBe ASSIST_MODEL_STATE_PRESENT` to `shouldBeIn listOf(PRESENT, NO_ENGINE)`; it is justified in the commit (the JVM core is built without the engine, and the engine-wired answer is asserted in Rust), but a weakened assertion belongs in the receipt. Also unnamed: the new `a_core_as_opened_without_the_engine_reads_a_model_file_as_no_engine_and_will_not_load` test and the `cfg(feature = "llama")` gating in `crates/core-ffi/tests/assist.rs`; `required-features = ["engine"]` on the `assist-eval-llama` binary and the two real-model suites; the required-checks edits in `TESTING.md`, `crates/xtask/README.md`, `docs/dev-environment.md`, `docs/release.md`, `docs/release/v1-handoffs.md` and `docs/toolchain.md`; the R-CHAT-10 row in `docs/decisions.md`.
  - One phone-build instruction was missed: the comment at `mobile/shared/build.gradle.kts:45` still reads "`cargo build -p centraid-core-ffi --target <triple>` produces it", without `--features llama`. It is a comment, not a build, but "every phone build" should not leave it.
  - The "Why" numbers hold. `ci/gate79.txt:1442` "TOTAL 1625.7" and `:1444` "the `pr` profile took 1625.7s against a 1500s budget"; `ci/gate-main.txt:1446` "TOTAL 880.6"; `ci/llama-measure.log` "Finished `dev` profile … in 5m 34s".
- **`- [x]` boxes.** PASS. The section adds none and edits none; the three open boxes (Android, fine-tuned model, device evidence) are untouched by these commits.
- **`## Verification` against a log or a re-run.** REFUTED on two lines.
  - Line 1. `final-gate-local.log`: "ok    fmt", "ok    clippy", "ok    test             1401.2s", "ok    restore-drill", "ok    rules", "ok    ledgers" and "gate local: PASS". The qualifier "from a purged target" is contradicted by the log's own header: "tree cold — 3 of 26 workspace member(s) have no linked artifact in /home/user/centraid/target/debug/deps (first: centraid)". A purged target reads 26 of 26. Twenty-three members, and `libllama_cpp_sys_2-6ae3e81ed062019d.rlib` (02:59), were still in `target/`. Say what was purged, or drop the words. "PASS on `30c414b24`" holds: nothing in `mobile`, `contracts`, `design` or the Rust crates differs from HEAD.
  - Line 2. `final-gate-mjvm.log`: "ok    mobile-jvm        250.9s" and "BUDGET ok — 250.9s of 420s", "gate mobile-jvm: PASS". PASS.
  - Fence 2, `buf lint`. `final-verify.log`: "buf lint 0"; my re-run exits 0. PASS.
  - `buf breaking --against '.git#ref=f54876780,subdir=crates/api-proto/proto'`. Not in `final-verify.log`; my re-run exits 0, and `f54876780` is `origin/main`. PASS.
  - `cargo tree --workspace -e features -i llama-cpp-sys-2`. My re-run: "error: package ID specification `llama-cpp-sys-2` did not match any packages", exit 101. That is the claimed "no match". PASS.
  - Clippy, engine on. `engine-summary.log`: "clippy-on rc=0 wall=1040s"; `engine-clippy-on.log` ends "Finished `dev` profile". PASS.
  - Tests, engine on. `engine-summary.log`: "test-on rc=0 wall=174s". REFUTED on the count: the receipt says "2 ignored need a GGUF"; `engine-test-on.log` has 9 ignored: `real_model.rs` "0 passed; 0 failed; 6 ignored", `real_vision.rs` "1 ignored" (needs `CENTRAID_ASSIST_MMPROJ` as well), `core-ffi/tests/assist.rs` "9 passed; 0 failed; 2 ignored". Say "9 ignored need a GGUF, 2 of them also its projector".
- **Governance form.** PASS. `## What changed` (line 22) and `## Verification` are present, the receipt is not a stub, `## Verification` holds fences and outcome words ("PASS", "pass"), and this section carries a verdict. The rule demands shape only of a receipt a change adds; this one pre-exists.

### Re-audit (2026-10-08)

**REFUTED**

One item is open, one word, and the wording was this audit's own. The section's text above the first audit was re-read as it now stands; the first audit is unchanged.

- **"From a purged target" (local gate line).** Fixed. The line now says the target was purged of all 26 workspace crates at 05:13 and 23 were relinked by the merges' builds, which fits the log header "3 of 26 workspace member(s) have no linked artifact". The target agrees: the oldest `*centraid*` entries in `target/debug/deps` and `build/` are 05:14:10 and 05:14:18; the 23 relinked rlibs are 05:16:35 to 05:19:18; the only older fingerprints belong to crates no longer in the workspace (`centraid-candidates`, `-evalsuite`, `-evalworld`). No log records the `cargo clean -p` calls themselves.
- **"2 ignored".** Count fixed, detail wrong. The line now says "9 ignored need a GGUF, 2 of them also its projector". `engine-test-on.log` has 9 ignored, but two need the projector: line 73 `the_projector_pairs_with_the_weights_and_a_photo_is_described ... ignored, needs CENTRAID_ASSIST_MODEL and CENTRAID_ASSIST_MMPROJ` and line 106 `the_real_model_reads_sample_photos_and_a_sample_document_attachments ... ignored, needs CENTRAID_ASSIST_MODEL and CENTRAID_ASSIST_MMPROJ`. The first audit's suggested wording ("1 of them") was wrong. Fix: "2 of them also its projector".
- **The unnamed changes.** Fixed. The section now names the widened `AssistRoundTripSpec` assertion (PRESENT to PRESENT or NO_ENGINE, as in the diff), the `a_core_as_opened_without_the_engine_reads_a_model_file_as_no_engine_and_will_not_load` test (passes in `engine-test-off.log`), the `cfg(feature = "llama")` gating, `required-features = ["engine"]` on the binary and both real-model suites, and the doc edits. The engine-on twin it cites, `a_core_as_opened_reads_a_model_file_as_present_and_refuses_a_file_that_is_not_one`, is `cfg(feature = "llama")` and passes in `engine-test-on.log`.
- **The stale comment.** Fixed. `git diff mobile/shared/build.gradle.kts` changes line 45 to "`cargo build -p centraid-core-ffi --features llama --target <triple>` produces it."
- **Governance form.** PASS, as before.

#### Second re-audit (2026-10-08)

**PASS.** The line now reads "9 ignored need a GGUF, 2 of them also its projector (engine lane, engine-test-on.log)", and `engine-test-on.log` lines 73 and 106 are the two that say "needs CENTRAID_ASSIST_MODEL and CENTRAID_ASSIST_MMPROJ"; no item is open.
