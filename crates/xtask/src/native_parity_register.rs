//! The `native-shell-parity` register (#1152): every field of the screens protos that
//! the two shells do not both read, with why. See [`crate::native_parity`].
//!
//! A row is `("Message.field", status)`. A [`platform`] row says the other platform has no such
//! thing; the reason is the row's. A [`gap`] row says a lane owes the missing read, or (lane F)
//! that nothing reads the field and a decision to consume or delete it is owed. THE REGISTER ONLY
//! SHRINKS: a closed gap is deleted from here in the commit that closes it (the rule fails on a
//! stale row), and a new row is never the way to make the rule pass.

use crate::native_parity::{Entry, Missing, Shell, gap, platform};

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
const REMINDERS: &str = "iOS reads the phone's Reminders (EventKit); Android has no such store";

/// One reason, several rows.
const OS_UPLOADS: &str = "the OS-owned background uploads are iOS's `URLSession`; Android's mover runs inside its WorkManager pass";

pub const REGISTER: &[Entry] = &[
    // Lane C: reads SwiftUI does not make yet (iOS missing).
    ("AgendaHomeData.event_count_label", gap("C", Missing::Ios)),
    ("Effect.screenshot_shield", gap("C", Missing::Ios)),
    ("PhotosLibraryData.scrub_next_label", gap("C", Missing::Ios)),
    (
        "PhotosLibraryData.scrub_previous_label",
        gap("C", Missing::Ios),
    ),
    ("WordsShowState.check_now", gap("C", Missing::Ios)),
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
        "ExportOriginals.chooser_title",
        platform(
            Shell::Android,
            "Android titles its share chooser; the iOS share sheet has no title",
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
        "RollAsset.changed_in_place",
        platform(Shell::Android, EDITED_IN_PLACE),
    ),
    // Platform, iOS only: Android has no such thing.
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
    ("PhoneReminder.due", platform(Shell::Ios, REMINDERS)),
    ("ShellFact.settled", platform(Shell::Ios, OS_UPLOADS)),
    (
        "UploadSettled.http_status",
        platform(Shell::Ios, OS_UPLOADS),
    ),
    ("UploadsEnqueue.parts", platform(Shell::Ios, OS_UPLOADS)),
    ("UploadsOp.cancel_all", platform(Shell::Ios, OS_UPLOADS)),
    ("UploadsOp.enqueue", platform(Shell::Ios, OS_UPLOADS)),
    // Lane F, one shell reads it and nobody owns the other half yet.
    // HomeVault.originals_withheld: the vault header's count of originals the phone is holding back
    ("HomeVault.originals_withheld", gap("F", Missing::Android)),
    // LockerSearchField.answered_term: Compose copies it into a kit holder and nothing draws it
    ("LockerSearchField.answered_term", gap("F", Missing::Ios)),
    // NavEvent.pop_to_root: a second tap on the selected tab; Compose sends it, SwiftUI never does
    ("NavEvent.pop_to_root", gap("F", Missing::Ios)),
    // PeoplePersonChrome.add_channel: iOS's verb strip names them; Compose opens the same sheets from the section headers and never draws these labels
    ("PeoplePersonChrome.add_channel", gap("F", Missing::Android)),
    // PeoplePersonChrome.add_date: iOS's verb strip names them; Compose opens the same sheets from the section headers and never draws these labels
    ("PeoplePersonChrome.add_date", gap("F", Missing::Android)),
    // PeoplePersonChrome.add_note: iOS's verb strip names them; Compose opens the same sheets from the section headers and never draws these labels
    ("PeoplePersonChrome.add_note", gap("F", Missing::Android)),
    (
        "PhotosLightboxPhoto.original_media_type",
        gap("F", Missing::Android),
    ),
    ("PhotosPlaceRow.current_name", gap("F", Missing::Android)),
    // ShellFact.expired: iOS reports a BGTask's expiry; WorkManager's stop is its twin and Android reports none
    ("ShellFact.expired", gap("F", Missing::Android)),
    // ShellVault.originals_withheld: the vault header's count of originals the phone is holding back
    ("ShellVault.originals_withheld", gap("F", Missing::Android)),
    // Lane F, one-sided by NAME COLLISION: the census matches field names, and the hit is another symbol. Neither shell reads the field; consume it or delete it.
    // ChatAttachment.asset_id: `found.asset_id` in LibraryRoll.kt is another message
    ("ChatAttachment.asset_id", gap("F", Missing::Ios)),
    // ChatEvent.VaultPhoto.asset_id: `found.asset_id` in LibraryRoll.kt is another message
    ("ChatEvent.VaultPhoto.asset_id", gap("F", Missing::Ios)),
    // ChatMessage.stopped: Kotlin `ChatEvent(stopped = ...)` is the event arm, not this field
    ("ChatMessage.stopped", gap("F", Missing::Ios)),
    // DocsQuery.ascending: `NSSortDescriptor(ascending:)`
    ("DocsQuery.ascending", gap("F", Missing::Android)),
    // FreeUpFacts.offered: iOS's own `offered:` parameter
    ("FreeUpFacts.offered", gap("F", Missing::Android)),
    // HeldFrozen.since: `fetchPersistentChanges(since:)`
    ("HeldFrozen.since", gap("F", Missing::Android)),
    // HomeEvent.VaultsTold.none: Kotlin's `none { }`
    ("HomeEvent.VaultsTold.none", gap("F", Missing::Ios)),
    // HomeTileBody.Photos.Cell.asset_id: `found.asset_id` in LibraryRoll.kt is another message
    ("HomeTileBody.Photos.Cell.asset_id", gap("F", Missing::Ios)),
    // ImportsCameraRollEvent.requested: `HealthRationale.requested` is a Kotlin flag
    ("ImportsCameraRollEvent.requested", gap("F", Missing::Ios)),
    // ImportsFilesEvent.requested: `HealthRationale.requested` is a Kotlin flag
    ("ImportsFilesEvent.requested", gap("F", Missing::Ios)),
    // PeopleChannelRow.intent: `CGColorSpace` conversion's `intent:`
    ("PeopleChannelRow.intent", gap("F", Missing::Android)),
    // PeoplePersonEvent.SheetOpened.which: Compose passes it positionally (`SheetOpened(which)`), so the name never appears
    (
        "PeoplePersonEvent.SheetOpened.which",
        gap("F", Missing::Android),
    ),
    // PeopleRow.due: `PhoneReminder.due`, which is the iOS Reminders read
    ("PeopleRow.due", gap("F", Missing::Android)),
    // RollReported.BytesFed.landed: `landed =` is a photo grid argument; the message is runtime-originated
    ("RollReported.BytesFed.landed", gap("F", Missing::Ios)),
    // ScreenJobDone.job: `android.app.job`; the message is internal to the core
    ("ScreenJobDone.job", gap("F", Missing::Ios)),
    // TodoField.raw: `raw:` in iOS's Core.swift
    ("TodoField.raw", gap("F", Missing::Android)),
    // Lane F, neither shell reads it, and the proto says the runtime originates it (no shell sends or draws it).
    ("RollReported.fed", gap("F", Missing::Both)),
    ("RollReported.walked", gap("F", Missing::Both)),
    ("ScreenEvent.announced", gap("F", Missing::Both)),
    ("ScreenEvent.assist", gap("F", Missing::Both)),
    ("ScreenEvent.data_changed", gap("F", Missing::Both)),
    ("ScreenEvent.environment_changed", gap("F", Missing::Both)),
    ("ScreenEvent.off_thread_done", gap("F", Missing::Both)),
    ("ScreenEvent.roll_reported", gap("F", Missing::Both)),
    ("ScreenEvent.screen_opened", gap("F", Missing::Both)),
    ("ScreenEvent.signalled", gap("F", Missing::Both)),
    ("ScreenEvent.timer_fired", gap("F", Missing::Both)),
    ("ScreenEvent.vault_commanded", gap("F", Missing::Both)),
    ("TimerFired.timer", gap("F", Missing::Both)),
    // Lane F, neither shell reads it: consume it in both shells or delete it from the protos.
    ("AgendaCalendarChoice.hidden", gap("F", Missing::Both)),
    ("AgendaDaySection.ribbon_names", gap("F", Missing::Both)),
    ("AgendaDraft.guest_ids", gap("F", Missing::Both)),
    ("AgendaDraft.reminder_key", gap("F", Missing::Both)),
    ("AgendaDraft.repeat_key", gap("F", Missing::Both)),
    ("AgendaEditorChrome.field_starts", gap("F", Missing::Both)),
    ("AgendaEditorState.asking", gap("F", Missing::Both)),
    ("AgendaEventRow.event_id", gap("F", Missing::Both)),
    ("AgendaEventRow.instance_key", gap("F", Missing::Both)),
    (
        "AgendaEventRow.original_start_local",
        gap("F", Missing::Both),
    ),
    ("AgendaGuestRow.is_you", gap("F", Missing::Both)),
    ("AgendaHomeData.event_count", gap("F", Missing::Both)),
    ("AgendaHomeData.now_local", gap("F", Missing::Both)),
    ("AgendaHomeData.waiting_count", gap("F", Missing::Both)),
    ("AgendaHomeEvent.calendar_toggled", gap("F", Missing::Both)),
    ("AgendaHomeState.filing_task_id", gap("F", Missing::Both)),
    (
        "AgendaHomeState.hidden_calendar_ids",
        gap("F", Missing::Both),
    ),
    ("Autosave.invoke_key", gap("F", Missing::Both)),
    ("Autosave.remote_changed", gap("F", Missing::Both)),
    ("Autosave.saving_seq", gap("F", Missing::Both)),
    ("BackupDestinationRow.pair_again", gap("F", Missing::Both)),
    ("BackupHomeData.backing_up_now", gap("F", Missing::Both)),
    ("BackupLine.frozen", gap("F", Missing::Both)),
    ("BackupLine.pair_again", gap("F", Missing::Both)),
    ("BackupLine.records_as_of_ms", gap("F", Missing::Both)),
    ("BackupLine.total", gap("F", Missing::Both)),
    ("BackupLine.unpaired", gap("F", Missing::Both)),
    ("ChatCard.qualifier", gap("F", Missing::Both)),
    ("ChatDrawerSearch.corrected_label", gap("F", Missing::Both)),
    ("ChatEvent.Attached.library_photo", gap("F", Missing::Both)),
    ("ChatEvent.Attached.vault_photo", gap("F", Missing::Both)),
    ("ChatState.attach_pick_photo_title", gap("F", Missing::Both)),
    (
        "DocsDocumentChrome.versions_heading",
        gap("F", Missing::Both),
    ),
    ("DocsDocumentState.asking", gap("F", Missing::Both)),
    (
        "DocsDriveChrome.filters_clear_label",
        gap("F", Missing::Both),
    ),
    (
        "DocsDriveState.confirm_document_id",
        gap("F", Missing::Both),
    ),
    ("DocsDriveState.filters_active", gap("F", Missing::Both)),
    ("DocsFolderNode.document_count", gap("F", Missing::Both)),
    ("DocsFolderNode.parent_id", gap("F", Missing::Both)),
    ("DocsFollowed.documents", gap("F", Missing::Both)),
    ("DocsFollowed.origin_id", gap("F", Missing::Both)),
    ("DocsSearchField.corrected_label", gap("F", Missing::Both)),
    ("Effect.capture_photo", gap("F", Missing::Both)),
    ("Effect.pick_photos", gap("F", Missing::Both)),
    ("Effect.schedule_notification", gap("F", Missing::Both)),
    ("FreeUpFacts.counted", gap("F", Missing::Both)),
    ("FreeUpFacts.freed_bytes", gap("F", Missing::Both)),
    ("FreeUpFacts.kept_count", gap("F", Missing::Both)),
    ("FreeUpFacts.on_phone_bytes", gap("F", Missing::Both)),
    ("FreeUpFacts.on_phone_count", gap("F", Missing::Both)),
    ("FreeUpFacts.platform_error", gap("F", Missing::Both)),
    ("FreeUpFacts.releasable_bytes", gap("F", Missing::Both)),
    ("FreeUpFacts.releasable_count", gap("F", Missing::Both)),
    ("HealthHomeState.trend_range", gap("F", Missing::Both)),
    ("HealthTrendRow.direction", gap("F", Missing::Both)),
    ("Held.drainable", gap("F", Missing::Both)),
    ("HeldFrozen.unacked", gap("F", Missing::Both)),
    ("HeldVault.frozen", gap("F", Missing::Both)),
    ("HeldVault.keyed", gap("F", Missing::Both)),
    ("HeldVault.own_words", gap("F", Missing::Both)),
    ("HomeBar.backup_open_spoken", gap("F", Missing::Both)),
    ("HomeBar.switch_spoken", gap("F", Missing::Both)),
    ("HomeData.every_tile_unreadable", gap("F", Missing::Both)),
    (
        "HomeEvent.OutcomeTold.rename_failed",
        gap("F", Missing::Both),
    ),
    ("HomeEvent.backup_told", gap("F", Missing::Both)),
    ("HomeEvent.outcome_told", gap("F", Missing::Both)),
    ("HomeEvent.status_told", gap("F", Missing::Both)),
    ("HomeEvent.vaults_told", gap("F", Missing::Both)),
    ("HomeTileBody.Locker.locked", gap("F", Missing::Both)),
    (
        "ImportsCameraRollEvent.BytesNeeded.needs",
        gap("F", Missing::Both),
    ),
    (
        "ImportsCameraRollEvent.bytes_needed",
        gap("F", Missing::Both),
    ),
    ("ImportsCameraRollEvent.walk", gap("F", Missing::Both)),
    (
        "ImportsCameraRollState.fed_last_round",
        gap("F", Missing::Both),
    ),
    ("ImportsCameraRollState.fed_rounds", gap("F", Missing::Both)),
    (
        "ImportsCameraRollState.imported_total",
        gap("F", Missing::Both),
    ),
    ("ImportsFilesEvent.folder_stopped", gap("F", Missing::Both)),
    ("ImportsFilesState.followed", gap("F", Missing::Both)),
    ("ImportsFollowedFolder.documents", gap("F", Missing::Both)),
    ("ImportsFollowedFolder.origin_id", gap("F", Missing::Both)),
    ("ImportsHeldFile.stat", gap("F", Missing::Both)),
    ("ImportsHeldFolder.documents", gap("F", Missing::Both)),
    ("ImportsHeldFolder.origin_id", gap("F", Missing::Both)),
    ("ImportsHeldFolder.origin_ref", gap("F", Missing::Both)),
    ("LockerItemData.type_key", gap("F", Missing::Both)),
    ("LockerRow.type_key", gap("F", Missing::Both)),
    (
        "MoneyAccountEditor.has_external_ref",
        gap("F", Missing::Both),
    ),
    ("MoneyCashflowMonth.rate_label", gap("F", Missing::Both)),
    ("MoneyHomeState.category_filter", gap("F", Missing::Both)),
    ("MoneyImportData.add_account_label", gap("F", Missing::Both)),
    ("MoneyTransactionData.is_transfer", gap("F", Missing::Both)),
    ("NotesEditorState.is_new", gap("F", Missing::Both)),
    ("NotesHomeEvent.pinned_only", gap("F", Missing::Both)),
    ("PeopleProfileDraft.cadence_days", gap("F", Missing::Both)),
    ("PhotoTile.favorite", gap("F", Missing::Both)),
    ("PhotoTile.fetch_percent", gap("F", Missing::Both)),
    ("PhotoTile.live_movie_id", gap("F", Missing::Both)),
    ("PhotoTile.purge_in_days", gap("F", Missing::Both)),
    (
        "PhotosBackupChanged.assets_remaining",
        gap("F", Missing::Both),
    ),
    (
        "PhotosBackupChanged.assets_transferred_this_session",
        gap("F", Missing::Both),
    ),
    ("PhotosBackupChanged.paused_reason", gap("F", Missing::Both)),
    ("PhotosCollectionCard.member_owned", gap("F", Missing::Both)),
    ("PhotosCollections.delete_album_id", gap("F", Missing::Both)),
    ("PhotosFreeUpRow.freeing", gap("F", Missing::Both)),
    ("PhotosLibraryData.loading_more", gap("F", Missing::Both)),
    ("PhotosLightboxPhoto.edit_refusal", gap("F", Missing::Both)),
    ("PhotosLightboxPhoto.write_refusal", gap("F", Missing::Both)),
    ("PhotosLightboxWords.no_place", gap("F", Missing::Both)),
    ("PhotosLightboxWords.this_photo", gap("F", Missing::Both)),
    ("PhotosPicked.stage_ids", gap("F", Missing::Both)),
    ("PhotosSearchHits.truncated_label", gap("F", Missing::Both)),
    ("PhotosSelection.confirming", gap("F", Missing::Both)),
    (
        "PhotosSelectionEvent.SelectRange.from_photo_id",
        gap("F", Missing::Both),
    ),
    (
        "PhotosSelectionEvent.SelectRange.to_photo_id",
        gap("F", Missing::Both),
    ),
    ("PickBytes.accept", gap("F", Missing::Both)),
    ("PickPhotos.max_count", gap("F", Missing::Both)),
    ("ScheduleNotification.at_ms", gap("F", Missing::Both)),
    ("ScreenEvent.appeared", gap("F", Missing::Both)),
    ("ScreenEvent.imports_files", gap("F", Missing::Both)),
    ("TodoCatchUpState.asking_pile", gap("F", Missing::Both)),
    ("TodoDetailData.parent_task_id", gap("F", Missing::Both)),
    ("TodoDetailState.asking", gap("F", Missing::Both)),
    ("TodoProjectState.project_id", gap("F", Missing::Both)),
    (
        "TodoProjectState.target_section_id",
        gap("F", Missing::Both),
    ),
    ("TodoRowGroup.section_id", gap("F", Missing::Both)),
    ("TrashView.purge_window_days", gap("F", Missing::Both)),
    ("VaultCommand.switch_to", gap("F", Missing::Both)),
    ("ViewState.imports_files", gap("F", Missing::Both)),
    ("WordsEnterState.purpose", gap("F", Missing::Both)),
];
