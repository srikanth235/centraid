//! The `native-shell-parity` register (#1152): every field of the screens protos that
//! the two shells do not both read, with why. See [`crate::native_parity`].
//!
//! A row is `("Message.field", status)`. A [`platform`] row says the other platform has no such
//! thing; the reason is the row's. A [`gap`] row says a lane owes the missing read, or (lane F)
//! that nothing reads the field and a decision to consume or delete it is owed. A [`rust_only`]
//! row says Rust writes the field and Rust reads it back, or hands it from one screen or service
//! to another, so no shell is owed anything; a [`runtime`] row says the runtime itself originates
//! or consumes it. Both hold only while no shell spells the field (`_named` when a shell spells
//! the NAME for an unrelated symbol, said in the reason). THE REGISTER ONLY SHRINKS: a closed gap
//! is deleted from here in the commit that closes it (the rule fails on a stale row), and a new
//! row is never the way to make the rule pass.

use crate::native_parity::{
    Entry, Missing, Shell, gap, platform, runtime, runtime_named, rust_only, rust_only_named,
};

/// One reason, several rows.
const CLEAN_GATE: &str = "Compose re-seeds a field's remembered text from the machine only while the draft is clean (`edit_seq == saved_seq`); SwiftUI's `MachineTextField` follows the machine's echo (`TypedText`) instead. A Rust `clean` would end the Kotlin sum, which views-decide-nothing would prefer";

/// One reason, several rows.
const DOZE: &str =
    "Doze and the battery-optimisation exemption are Android settings; iOS has no setting to open";

/// One reason, several rows.
const DOCS_TRANSPORT: &str = "Docs plays audio and video in AVKit's `VideoPlayer` on iOS, whose transport speaks for itself; Compose draws its own `LightboxTransport`";

/// One reason, several rows.
const EDITED_IN_PLACE: &str = "MediaStore reports an item edited in place under its old id; PhotoKit reports an edit as a change to the asset (`hasAdjustments`), so iOS asks the core nothing about a prior";

/// One reason, several rows.
const CERT_PIN: &str = "iOS pins the gateway certificate for its OS-owned uploads when `backup.destinations` is announced; Android's `custody.filing` files the key in Rust";

/// One reason, several rows.
const LINK_READS: &str = "the general link's reads (`shell.links`, `shell.link-candidates`): the core answers them and the kit's link section words the rows, so a shell draws the finished `LinkRow`";
/// One reason, several rows.
const REMINDERS: &str = "iOS reads the phone's Reminders (EventKit); Android has no such store";

/// One reason, several rows.
const OS_UPLOADS: &str = "the OS-owned background uploads are iOS's `URLSession`; Android's mover runs inside its WorkManager pass";

/// One reason, several rows.
const AGENDA_DRAFT: &str = "the editor holds its draft as this wire message and reads it back (agenda/editor.rs); the shells draw the choices' `selected` flags instead";

/// One reason, several rows.
const CHAT_ATTACH: &str = "the chat's own attach event: chat/attach.rs builds it from a photo pick and reads it back; no shell sends it";

/// One reason, several rows.
const FREE_UP: &str = "`FreeUpFacts` is the free-up job's own record: prost-encoded across the off-thread job and read back by Rust (photos/free_up.rs, photos/keep_originals.rs), never on the wire between a shell and Rust";

/// One reason, several rows.
const VAULT_TELLS_HOME: &str = "the vault service tells Home by name (`Ctx::post`, vault/service.rs to shell/home.rs); no shell sends it";

/// One reason, several rows.
const PASS_TELLS_ROLL: &str = "the pass service tells the camera roll by name (passes/service.rs to imports/camera_roll.rs); no shell sends it";

/// One reason, several rows.
const ORIGIN_OF_NAMED: &str = "`shell.origin-of` is read by Rust only (core/app_query/follow.rs builds it, kit/origin.rs reads it); `system` and `label` are common names the shells spell for unrelated symbols";

/// One reason, several rows.
const FILES_FOLLOWED: &str = "`shell.files-followed` is read by Rust only: core/app_query/imports.rs builds the answer, imports/files.rs and docs/drive/mod.rs read it";

/// One reason, several rows.
const EARLIER_VERSIONS: &str = "`shell.earlier-versions` is read by Rust only: core/app_query/history.rs builds the answer and kit/earlier.rs reads it; the app's spec words each version and a shell is sent only the finished `EarlierRow`";

/// One reason, several rows.
const PHONE_DIFFERENCES: &str = "`shell.phone-differences` is read by Rust only: core/app_query/follow.rs builds the answer and kit/follow.rs reads it; the detail screens word it and send a shell only the finished `PhoneSays` line";

/// One reason, several rows.
const ROLL_TELLS_PHOTOS: &str = "the camera roll tells Photos' home by name (imports/camera_roll.rs to photos/home/chrome.rs); no shell sends it";

/// One reason, several rows.
const ROLL_REPORT: &str = "a service-to-service report: the camera roll tells the pass service (imports/camera_roll.rs to passes/service.rs); no shell sends it";

/// One reason, several rows.
const RUNTIME_EVENT: &str = "the runtime builds this event itself (screens/src/runtime.rs) and hands it to every screen that matches it; no shell sends it";

pub const REGISTER: &[Entry] = &[
    // Platform, Android only: iOS has no such thing.
    (
        "AgendaEditorData.dirty",
        platform(Shell::Android, CLEAN_GATE),
    ),
    (
        "Autosave.base_revision_id",
        platform(Shell::Android, CLEAN_GATE),
    ),
    ("Autosave.edit_seq", platform(Shell::Android, CLEAN_GATE)),
    ("Autosave.saved_seq", platform(Shell::Android, CLEAN_GATE)),
    (
        "BackupHomeData.battery_label",
        platform(Shell::Android, DOZE),
    ),
    (
        "BackupHomeData.battery_sentence",
        platform(Shell::Android, DOZE),
    ),
    (
        "DocsStage.pause_label",
        platform(Shell::Android, DOCS_TRANSPORT),
    ),
    (
        "DocsStage.play_label",
        platform(Shell::Android, DOCS_TRANSPORT),
    ),
    (
        "DocsStage.position_label",
        platform(Shell::Android, DOCS_TRANSPORT),
    ),
    (
        "DocsStage.position_value",
        platform(Shell::Android, DOCS_TRANSPORT),
    ),
    (
        "HealthRead.ask_background",
        platform(
            Shell::Android,
            "Health Connect has a separate background-read permission (D16); HealthKit needs no extra ask",
        ),
    ),
    (
        "HealthSnapshot.background_refused",
        platform(
            Shell::Android,
            "only Health Connect's background-read permission can be refused; HealthKit has none",
        ),
    ),
    (
        "HealthSnapshot.installable",
        platform(
            Shell::Android,
            "Health Connect is a separate app that may need installing; HealthKit ships with iOS",
        ),
    ),
    (
        "HomeEvent.entry_asked",
        platform(
            Shell::Android,
            "Health Connect's rationale page returns to the app asking for the Health entry; HealthKit has no such page",
        ),
    ),
    (
        "LibraryStage.changed_in_place",
        platform(Shell::Android, EDITED_IN_PLACE),
    ),
    (
        "LibraryStaged.prior_asset_id",
        platform(Shell::Android, EDITED_IN_PLACE),
    ),
    (
        "LibraryStaged.prior_content_hash",
        platform(Shell::Android, EDITED_IN_PLACE),
    ),
    (
        "LongRun.channel_name",
        platform(
            Shell::Android,
            "a notification channel is Android; iOS keeps the screen awake for a long run",
        ),
    ),
    (
        "ScheduleNotifications.channel_name",
        platform(
            Shell::Android,
            "a notification channel is Android; iOS's notification centre has no channel to name",
        ),
    ),
    (
        "RollAsset.changed_in_place",
        platform(Shell::Android, EDITED_IN_PLACE),
    ),
    // Platform, iOS only: Android has no such thing.
    // Agenda's "Import reminders" More row and its option sheet: only where the platform has a
    // Reminders store (`Ctx::reminders_source`), so Android's More draws no such row.
    (
        "AgendaHomeEvent.import_reminders_completed",
        platform(Shell::Ios, REMINDERS),
    ),
    (
        "AgendaHomeEvent.import_reminders_submitted",
        platform(Shell::Ios, REMINDERS),
    ),
    (
        "AgendaHomeState.import_reminders",
        platform(Shell::Ios, REMINDERS),
    ),
    (
        "AgendaImportRemindersSheet.completed_label",
        platform(Shell::Ios, REMINDERS),
    ),
    (
        "AgendaImportRemindersSheet.completed_on",
        platform(Shell::Ios, REMINDERS),
    ),
    ("Announce.topic", platform(Shell::Ios, CERT_PIN)),
    ("Announced.topic", platform(Shell::Ios, CERT_PIN)),
    (
        "EffectResult.reminders_snapshot",
        platform(Shell::Ios, REMINDERS),
    ),
    (
        "EffectResult.uploads_state",
        platform(Shell::Ios, OS_UPLOADS),
    ),
    (
        "LibraryStage.allow_network",
        platform(
            Shell::Ios,
            "an original that lives only in iCloud; Android's media store holds what is on the device",
        ),
    ),
    (
        "ImportsMadeEvent.reminders_requested",
        platform(Shell::Ios, REMINDERS),
    ),
    (
        "ImportsMadeEvent.Made.include_completed",
        platform(Shell::Ios, REMINDERS),
    ),
    (
        "ImportsMadeEvent.RemindersRequested.include_completed",
        platform(Shell::Ios, REMINDERS),
    ),
    (
        "ImportsMadeState.completed_label",
        platform(Shell::Ios, REMINDERS),
    ),
    (
        "ImportsMadeState.reminders_label",
        platform(Shell::Ios, REMINDERS),
    ),
    (
        "PhoneReminder.alarm_minutes_before",
        platform(Shell::Ios, REMINDERS),
    ),
    (
        "PhoneReminder.completed_at",
        platform(Shell::Ios, REMINDERS),
    ),
    ("PhoneReminder.due", platform(Shell::Ios, REMINDERS)),
    ("PhoneReminder.due_time", platform(Shell::Ios, REMINDERS)),
    ("PhoneReminder.list_color", platform(Shell::Ios, REMINDERS)),
    ("PhoneReminder.list_id", platform(Shell::Ios, REMINDERS)),
    (
        "RemindersRead.include_completed",
        platform(Shell::Ios, REMINDERS),
    ),
    ("ShellFact.settled", platform(Shell::Ios, OS_UPLOADS)),
    (
        "UploadSettled.http_status",
        platform(Shell::Ios, OS_UPLOADS),
    ),
    ("UploadsEnqueue.parts", platform(Shell::Ios, OS_UPLOADS)),
    ("UploadsOp.cancel_all", platform(Shell::Ios, OS_UPLOADS)),
    ("UploadsOp.enqueue", platform(Shell::Ios, OS_UPLOADS)),
    // Lane F, one shell reads it and nobody owns the other half yet.
    // LockerSearchField.answered_term: Compose copies it into a kit holder and nothing draws it
    ("LockerSearchField.answered_term", gap("F", Missing::Ios)),
    // HeldFrozen.since: `fetchPersistentChanges(since:)`; `strings::vault::frozen_line` is called only by tests, so the frozen vault's line is never shown. Owner decides: wire it into Home's frozen vault row, or delete both fields
    ("HeldFrozen.since", gap("F", Missing::Android)),
    ("HeldFrozen.unacked", gap("F", Missing::Both)),
    // HomeEvent.status_told: no production sender, so Home's `status` is always unset and its ribbon (a stranded write, a low disk) can never show. Owner decides: wire a producer, or delete `HomeStatus` and the ribbon
    ("HomeEvent.status_told", gap("F", Missing::Both)),
    // ViewState.imports_files: the follower's headless view; tests/imports_roots.rs pins the arm. Owner decides: headless screens return an empty view, or the arm stays for tests
    ("ViewState.imports_files", gap("F", Missing::Both)),
    // Lane F, Rust features no shell exposes yet. owner question (#1152): expose or delete.
    // Calendar visibility
    ("AgendaCalendarChoice.hidden", gap("F", Missing::Both)),
    ("AgendaHomeEvent.calendar_toggled", gap("F", Missing::Both)),
    (
        "AgendaHomeState.hidden_calendar_ids",
        gap("F", Missing::Both),
    ),
    // Range select
    (
        "PhotosSelectionEvent.SelectRange.from_photo_id",
        gap("F", Missing::Both),
    ),
    (
        "PhotosSelectionEvent.SelectRange.to_photo_id",
        gap("F", Missing::Both),
    ),
    // The folder follower's explicit trigger; `HealthRationale.requested` is a Kotlin flag. owner question (#1152): expose or delete
    ("ImportsFilesEvent.requested", gap("F", Missing::Ios)),
    // Lane F, read by no shell and no Rust outside the tests, which use it as the one observable of the grid, the camera-roll service and the vault shelf. owner question (#1152): keep each as that observable, or delete it with the assertions that read it.
    ("HeldVault.keyed", gap("F", Missing::Both)),
    ("HeldVault.own_words", gap("F", Missing::Both)),
    (
        "ImportsCameraRollState.fed_last_round",
        gap("F", Missing::Both),
    ),
    ("ImportsCameraRollState.fed_rounds", gap("F", Missing::Both)),
    (
        "ImportsCameraRollState.imported_total",
        gap("F", Missing::Both),
    ),
    ("PhotoTile.favorite", gap("F", Missing::Both)),
    // Rust only: Rust writes it and reads it back, or hands it from one screen or service to another.
    ("AgendaDraft.guest_ids", rust_only(AGENDA_DRAFT)),
    ("AgendaDraft.reminder_key", rust_only(AGENDA_DRAFT)),
    ("AgendaDraft.repeat_key", rust_only(AGENDA_DRAFT)),
    ("AgendaDraft.repeat_rule", rust_only(AGENDA_DRAFT)),
    ("AgendaDraft.second_reminder_key", rust_only(AGENDA_DRAFT)),
    ("AgendaDraft.travel_min", rust_only(AGENDA_DRAFT)),
    (
        "Autosave.remote_changed",
        rust_only(
            "the Docs editor reads it back to compose `remote_note` (docs/editor.rs), which the shells draw",
        ),
    ),
    (
        "ChatCard.qualifier",
        rust_only(
            "the chat keeps its cards as wire messages and rebuilds the tapped card's `RowRef` from this one (chat/turn.rs); no shell reads it",
        ),
    ),
    ("ChatEvent.Attached.library_photo", rust_only(CHAT_ATTACH)),
    ("ChatEvent.Attached.vault_photo", rust_only(CHAT_ATTACH)),
    (
        "ChatEvent.VaultPhoto.asset_id",
        rust_only_named(
            "Photos' picker posts a vault pick to the chat (photos/picker.rs) and the chat reads it (chat/attach.rs); neither shell sends one. `found.asset_id` in LibraryRoll.kt is another message",
            Missing::Ios,
        ),
    ),
    (
        "DocsFollowed.documents",
        rust_only(
            "`DocsFollowed` is the drive's own list of followed folders and never on the wire; `documents` becomes the detail of a followed-sheet row (docs/drive/sheets.rs)",
        ),
    ),
    (
        "DocsFollowed.origin_id",
        rust_only(
            "`DocsFollowed` is the drive's own list of followed folders and never on the wire; `origin_id` keys a stop row and matches a folder just followed (docs/drive/mod.rs)",
        ),
    ),
    ("FreeUpFacts.counted", rust_only(FREE_UP)),
    ("FreeUpFacts.freed_bytes", rust_only(FREE_UP)),
    ("FreeUpFacts.kept_count", rust_only(FREE_UP)),
    (
        "FreeUpFacts.offered",
        rust_only_named(
            "`FreeUpFacts` is the free-up job's own record, prost-encoded across the off-thread job and read back by Rust (photos/keep_originals.rs), never on the wire between a shell and Rust. iOS's own `offered:` parameter is another symbol",
            Missing::Android,
        ),
    ),
    ("FreeUpFacts.on_phone_bytes", rust_only(FREE_UP)),
    ("FreeUpFacts.on_phone_count", rust_only(FREE_UP)),
    ("FreeUpFacts.platform_error", rust_only(FREE_UP)),
    ("FreeUpFacts.releasable_bytes", rust_only(FREE_UP)),
    ("FreeUpFacts.releasable_count", rust_only(FREE_UP)),
    (
        "Held.drainable",
        rust_only(
            "the vault shelf's roster for the pass conductor, service to service (vault/shelf.rs to passes/service.rs to passes/conductor.rs)",
        ),
    ),
    (
        "HeldVault.frozen",
        rust_only(
            "the `shell.holdings` answer is read by Rust only (vault/service.rs reads `is_some()`); no shell mentions holdings",
        ),
    ),
    (
        "HomeEvent.OutcomeTold.rename_failed",
        rust_only(VAULT_TELLS_HOME),
    ),
    (
        "HomeEvent.VaultsTold.none",
        rust_only_named(
            "the vault service tells Home by name (`Ctx::post`, vault/service.rs to shell/home.rs); no shell sends it. Kotlin's `none { }` is another symbol",
            Missing::Ios,
        ),
    ),
    ("HomeEvent.backup_told", rust_only(VAULT_TELLS_HOME)),
    (
        "HomeEvent.appearance_chosen",
        rust_only(
            "Settings tells Home the appearance by name (`Ctx::post`, shell/settings.rs to shell/home.rs); no shell sends it",
        ),
    ),
    ("HomeEvent.outcome_told", rust_only(VAULT_TELLS_HOME)),
    ("HomeEvent.vaults_told", rust_only(VAULT_TELLS_HOME)),
    (
        "ImportsCameraRollEvent.BytesNeeded.needs",
        rust_only(PASS_TELLS_ROLL),
    ),
    (
        "ImportsCameraRollEvent.bytes_needed",
        rust_only(PASS_TELLS_ROLL),
    ),
    (
        "ImportsCameraRollEvent.requested",
        rust_only_named(
            "Photos' home and the made vault post it to the camera roll by name (photos/home/mod.rs, imports/made.rs) and camera_roll.rs reads it; no shell sends it. `HealthRationale.requested` is a Kotlin flag",
            Missing::Ios,
        ),
    ),
    ("ImportsCameraRollEvent.walk", rust_only(PASS_TELLS_ROLL)),
    (
        "ImportsFilesEvent.folder_stopped",
        rust_only(
            "the Docs drive tells the folder follower by name (docs/drive/mod.rs to imports/files.rs); no shell sends it",
        ),
    ),
    ("FollowDifference.held_json", rust_only(PHONE_DIFFERENCES)),
    ("FollowDifference.stated_json", rust_only(PHONE_DIFFERENCES)),
    (
        "FollowItemDifference.held_json",
        rust_only(PHONE_DIFFERENCES),
    ),
    (
        "FollowItemDifference.stated_json",
        rust_only(PHONE_DIFFERENCES),
    ),
    (
        "OriginOf.system",
        rust_only_named(ORIGIN_OF_NAMED, Missing::Android),
    ),
    ("EarlierVersions.versions", rust_only(EARLIER_VERSIONS)),
    ("LinkedItem.is_owner", rust_only(LINK_READS)),
    ("LinkCandidate.is_owner", rust_only(LINK_READS)),
    ("EarlierVersion.replaced_local", rust_only(EARLIER_VERSIONS)),
    ("EarlierVersion.since_local", rust_only(EARLIER_VERSIONS)),
    ("EarlierVersion.store_system", rust_only(EARLIER_VERSIONS)),
    (
        "EarlierVersion.since_store_system",
        rust_only(EARLIER_VERSIONS),
    ),
    ("EarlierVersion.field_changes", rust_only(EARLIER_VERSIONS)),
    ("EarlierChange.before_json", rust_only(EARLIER_VERSIONS)),
    ("EarlierChange.after_json", rust_only(EARLIER_VERSIONS)),
    ("ImportsHeldFile.stat", rust_only(FILES_FOLLOWED)),
    ("ImportsHeldFolder.documents", rust_only(FILES_FOLLOWED)),
    ("ImportsHeldFolder.origin_id", rust_only(FILES_FOLLOWED)),
    ("ImportsHeldFolder.origin_ref", rust_only(FILES_FOLLOWED)),
    (
        "PhotosBackupChanged.assets_remaining",
        rust_only(ROLL_TELLS_PHOTOS),
    ),
    (
        "PhotosBackupChanged.assets_transferred_this_session",
        rust_only(ROLL_TELLS_PHOTOS),
    ),
    (
        "PhotosBackupChanged.paused_reason",
        rust_only(ROLL_TELLS_PHOTOS),
    ),
    (
        "ScreenEvent.imports_files",
        rust_only(
            "the Docs drive posts it to the folder follower by name (docs/drive/mod.rs) and imports/files.rs reads it; no shell sends it",
        ),
    ),
    (
        "VaultCommand.switch_to",
        rust_only(
            "Home builds the `VaultCommand` effect and the vault service handles it (shell/home.rs to vault/service.rs); the effect never reaches a shell",
        ),
    ),
    // Runtime: the runtime itself originates or consumes it.
    (
        "RollReported.BytesFed.landed",
        runtime_named(
            "a service-to-service report: the camera roll tells the pass service (imports/camera_roll.rs to passes/service.rs). `landed =` is a photo grid argument",
            Missing::Ios,
        ),
    ),
    ("RollReported.fed", runtime(ROLL_REPORT)),
    ("RollReported.walked", runtime(ROLL_REPORT)),
    (
        "ScreenEvent.announced",
        runtime(
            "runtime.rs synthesises it when a shell fact is announced, and custody/filing.rs reads it; no shell sends it",
        ),
    ),
    (
        "ScreenEvent.appeared",
        runtime(
            "the runtime sends it to a screen when it opens (runtime.rs) and every screen matches it; no shell sends it",
        ),
    ),
    (
        "ScreenEvent.assist",
        runtime(
            "runtime.rs synthesises it from the assistant stream, and the chat reads it; no shell sends it",
        ),
    ),
    ("ScreenEvent.data_changed", runtime(RUNTIME_EVENT)),
    ("ScreenEvent.environment_changed", runtime(RUNTIME_EVENT)),
    ("ScreenEvent.off_thread_done", runtime(RUNTIME_EVENT)),
    ("ScreenEvent.left", runtime(RUNTIME_EVENT)),
    ("ScreenEvent.tab_hidden", runtime(RUNTIME_EVENT)),
    (
        "ScreenEvent.roll_reported",
        runtime(
            "the camera roll posts it and the pass service reads it (imports/camera_roll.rs, passes/service.rs); no shell sends it",
        ),
    ),
    (
        "ScreenEvent.screen_opened",
        runtime(
            "runtime.rs synthesises it for services only (vault/service.rs reads it); no shell sends it",
        ),
    ),
    (
        "ScreenEvent.signalled",
        runtime(
            "the pass conductor posts it and the pass and vault services read it (passes/conductor.rs, passes/service.rs, vault/service.rs); no shell sends it",
        ),
    ),
    ("ScreenEvent.timer_fired", runtime(RUNTIME_EVENT)),
    (
        "ScreenEvent.vault_commanded",
        runtime(
            "runtime.rs synthesises it for the vault service from Home's `VaultCommand` effect, which never reaches a shell",
        ),
    ),
    (
        "ScreenJobDone.job",
        runtime_named(
            "the core builds the off-thread job's answer itself (core/src/screens.rs); no shell is involved. `android.app.job` is another symbol",
            Missing::Ios,
        ),
    ),
    (
        "TimerFired.timer",
        runtime(
            "runtime.rs writes the timer's name and the screens compare it (agenda/calendar.rs, ...); no shell sends it",
        ),
    ),
];
