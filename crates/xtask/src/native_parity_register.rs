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
const ALERT_LIMITS: &str = "Android lets the member switch an app's notification channel off and revoke exact alarms; iOS has one grant and no channel, and its triggers are exact";

/// One reason, several rows.
const DOZE: &str =
    "Doze and the battery-optimisation exemption are Android settings; iOS has no setting to open";

/// One reason, several rows.
const EDITED_IN_PLACE: &str = "MediaStore reports an item edited in place under its old id; PhotoKit reports an edit as a change to the asset (`hasAdjustments`), so iOS asks the core nothing about a prior";

/// One reason, several rows.
const CERT_PIN: &str = "iOS pins the gateway certificate for its OS-owned uploads when `backup.destinations` is announced; Android's `custody.filing` files the key in Rust";

/// One reason, several rows.
const OS_UPLOADS: &str = "the OS-owned background uploads are iOS's `URLSession`; Android's mover runs inside its WorkManager pass";

/// One reason, several rows.
const VAULT_TELLS_HOME: &str = "the vault service tells Home by name (`Ctx::post`, vault/service.rs to shell/home.rs); no shell sends it";

/// One reason, several rows.
const ROLL_REPORT: &str = "a service-to-service report: the camera roll tells the pass service (imports/camera_roll.rs to passes/service.rs); no shell sends it";

/// One reason, several rows.
const RUNTIME_EVENT: &str = "the runtime builds this event itself (screens/src/runtime.rs) and hands it to every screen that matches it; no shell sends it";

pub const REGISTER: &[Entry] = &[
    // Platform, Android only: iOS has no such thing.
    (
        "BackupHomeData.battery_label",
        platform(Shell::Android, DOZE),
    ),
    (
        "BackupHomeData.battery_sentence",
        platform(Shell::Android, DOZE),
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
        "NotificationsScheduled.backup_channel_off",
        platform(Shell::Android, ALERT_LIMITS),
    ),
    (
        "NotificationsScheduled.backup_channel_shown",
        platform(Shell::Android, ALERT_LIMITS),
    ),
    (
        "ScheduleNotifications.backup_channel_name",
        platform(Shell::Android, ALERT_LIMITS),
    ),
    (
        "NotificationsScheduled.channel_off",
        platform(Shell::Android, ALERT_LIMITS),
    ),
    (
        "NotificationsScheduled.channel_shown",
        platform(Shell::Android, ALERT_LIMITS),
    ),
    (
        "NotificationsScheduled.exact_denied",
        platform(Shell::Android, ALERT_LIMITS),
    ),
    // Platform, iOS only: Android has no such thing.
    // Agenda's "Import reminders" More row and its option sheet: only where the platform has a
    // Reminders store (`Ctx::reminders_source`), so Android's More draws no such row.
    ("Announce.topic", platform(Shell::Ios, CERT_PIN)),
    (
        "EffectFailed.limited",
        platform(
            Shell::Ios,
            "iOS 17's write-only access to Calendar and Reminders is a grant that cannot read; Android's runtime permissions are all or nothing for those stores, so Android never reports a limited grant there (kit::permission words it)",
        ),
    ),
    ("Announced.topic", platform(Shell::Ios, CERT_PIN)),
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
    // HeldFrozen.since: `fetchPersistentChanges(since:)`; `strings::vault::frozen_line` is called only by tests, so the frozen vault's line is never shown. Owner decides: wire it into Home's frozen vault row, or delete both fields
    ("HeldFrozen.since", gap("F", Missing::Android)),
    ("HeldFrozen.unacked", gap("F", Missing::Both)),
    // HomeEvent.status_told: no production sender, so Home's `status` is always unset and its ribbon (a stranded write, a low disk) can never show. Owner decides: wire a producer, or delete `HomeStatus` and the ribbon
    // ViewState.imports_files: the follower's headless view; tests/imports_roots.rs pins the arm. Owner decides: headless screens return an empty view, or the arm stays for tests
    // Lane F, Rust features no shell exposes yet. owner question (#1152): expose or delete.
    // Calendar visibility
    // Range select
    // The folder follower's explicit trigger; `HealthRationale.requested` is a Kotlin flag. owner question (#1152): expose or delete
    // Lane F, read by no shell and no Rust outside the tests, which use it as the one observable of the grid, the camera-roll service and the vault shelf. owner question (#1152): keep each as that observable, or delete it with the assertions that read it.
    ("HeldVault.keyed", gap("F", Missing::Both)),
    ("HeldVault.own_words", gap("F", Missing::Both)),
    // Rust only: Rust writes it and reads it back, or hands it from one screen or service to another.
    (
        "ChatCard.qualifier",
        rust_only(
            "the chat keeps its cards as wire messages and rebuilds the tapped card's `RowRef` from this one (chat/turn.rs); no shell reads it",
        ),
    ),
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
        "Holdings.vaults",
        rust_only(
            "the `shell.holdings` answer is read by Rust only (vault/service.rs tells the pass conductor which vault is held); the vault picker that read it in the shells is gone (#1209, R1)",
        ),
    ),
    (
        "VaultsHeld.vaults",
        rust_only(
            "the vault service tells the pass conductor by name (vault/service.rs to passes/service.rs); no shell sends it",
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
