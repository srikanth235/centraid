# Fix handoff (written while builds were held by the coordinator)

All edits are made; NOTHING has been compiled or run yet. Remaining: run, in order, with CARGO_TARGET_DIR=/Users/srikanth/gitspace/centraid/target:

1. `cargo fmt` check, `cargo test -p centraid-screens`, `-p centraid-vault`, `-p centraid-reminders`, `-p centraid-core` (new proto fields: AgendaTask.remind_on_time_local=43, NotesEditorEvent.trash_tapped=24, NotesEditorChrome.trash_label=18, NotesEditorState.finished=24).
2. `cargo xtask gate --profile local`, `--profile mobile-jvm`, `cargo xtask design --check`, `bun run check`.
3. `mobile/scripts/ios-core.sh aarch64-apple-ios-sim` and `android-core.sh arm64-v8a`, then `./gradlew -Pcentraid.android=true :androidApp:testDebugUnitTest` from mobile/, then an iOS simulator build.

Items: 1 token custody in crates/screens (secrets.rs, shelf.rs pump, pairing, restore via enrollment.rs Adoption, forget in backup/home.rs), card text in backup/line.rs. 2 trash confirms removed in Rust (reminders/detail.rs, people/person, docs/document.rs, docs/drive). 3 Notes menu Move to trash (Rust+both shells); Earlier versions already wired, entry appears only once an earlier version exists. 4 Android ScreenEffects save (process-wide Ask, logged errors) and zip made-by Unix host. 5 AbiContractSpec. 6 vault/alerts.rs + apps/reminders local.rs + notify/desired.rs + reminders/detail.rs. 7 custody/make.rs + words_make.rs tests. 8 earlier.rs zone, calendar grid cycle, Android 12/24 observer, Notify.afterAsk, notes link footer, "This is in the trash." gone cards.
