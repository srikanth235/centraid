//! Sentences of `backup.home` that `strings::backup` does not hold (#1135, lane
//! H2): the transfer rule's three choices, where the recovery key is kept on
//! each platform, why the phone will not wake Centraid, what a pass is told in
//! words, and the claims the line may make. The line's own sentences are
//! `strings::backup`.

catalog! {
    // THE TRANSFER RULE (`TransferRule.sentence`): plain sentences and never a
    // label plus a footnote, because a member choosing how their phone spends
    // money is owed a sentence they can act on.
    plain rule_wifi_only = ("Full-size photos and videos back up and download on Wi-Fi only.", "Full-size photos and videos back up and download on Wi-Fi only.");
    plain rule_wifi_and_cellular_photos = ("Full-size photos back up and download on Wi-Fi or cellular; videos wait for Wi-Fi.", "Full-size photos back up and download on Wi-Fi or cellular; videos wait for Wi-Fi.");
    plain rule_manual = ("Full-size photos download when you tap one; backups wait for Wi-Fi.", "Full-size photos download when you tap one; backups wait for Wi-Fi.");

    // WHERE THE RECOVERY KEY GOES, in the member's words, and what the platform
    // promises about getting it back. Android says the uncomfortable thing: Block
    // Store hands the key back during the new-phone setup and at no other time.
    plain key_place_ios = ("iCloud Keychain", "iCloud Keychain");
    plain key_place_android = ("Google", "Google");
    plain key_saved_ios = ("Saved in iCloud Keychain. Sign in to iCloud on a new iPhone to restore your vaults.", "Saved in iCloud Keychain. Sign in to iCloud on a new iPhone to restore your vaults.");
    plain key_saved_ios_off = ("iCloud Keychain is off, so your recovery key is only on this iPhone. Save a copy.", "iCloud Keychain is off, so your recovery key is only on this iPhone. Save a copy.");
    plain key_saved_android = ("Backed up with Google. It returns when you restore this phone's backup while setting up a new one. If you skip that step, you'll need your recovery key.", "Backed up with Google. It returns when you restore this phone's backup while setting up a new one. If you skip that step, you'll need your recovery key.");
    plain key_saved_unknown = ("Can't tell whether your recovery key is saved elsewhere. Save a copy.", "Can't tell whether your recovery key is saved elsewhere. Save a copy.");

    // WHY THE PHONE WILL NOT WAKE CENTRAID when the platform refused every window.
    plain background_off_ios = ("Background App Refresh is off, so Centraid only catches up when you open it.", "Background App Refresh is off, so Centraid only catches up when you open it.");
    plain background_off_android = ("Centraid cannot catch up in the background on this phone.", "Centraid cannot catch up in the background on this phone.");

    // WHAT A MEMBER IS TOLD ABOUT A PASS (`DrainCopy`): one sentence per reason it
    // stopped. A window that ran out with bytes left is the ordinary case for a
    // first backup of a camera roll, so a deadline is not an error and does not say
    // so. "Everything" would be a claim, so an empty spool says only what was ready.
    plain pass_in_flight_title = ("Backing up", "Backing up");
    plain pass_stopped_empty = ("Your backup device has everything that was ready.", "Your backup device has everything that was ready.");
    plain pass_stopped_deadline = ("Still backing up. {size} to go.", "Still backing up. {size} to go.");
    plain pass_stopped_unreachable = ("Backup device didn't answer. Will try again.", "Backup device didn't answer. Will try again.");
    plain pass_stopped_untrusted = ("That isn't your backup device. Nothing was sent.", "That isn't your backup device. Nothing was sent.");
    plain pass_stopped_moved = ("Moved to another phone. This phone is read-only.", "Moved to another phone. This phone is read-only.");
    plain pass_posture = ("Centraid backs up while open. Your phone keeps uploading after you leave.", "Centraid backs up while open. Your phone keeps uploading after you leave.");
    plain pass_force_quit = ("If you swipe Centraid away, your phone cancels those uploads until you open it again. Low Power Mode pauses them.", "If you swipe Centraid away, your phone cancels those uploads until you open it again. Low Power Mode pauses them.");
    plain pass_android_unmetered = ("Centraid backs up in the background on Wi-Fi, and on cellular when your setting allows it.", "Centraid backs up in the background on Wi-Fi, and on cellular when your setting allows it.");

    // WHAT MAY BE CLAIMED as backed up (`BackupClaim`): the sentence leads with
    // what is NOT backed up when anything is behind, because that is the part a
    // member would be wrong about.
    plain claim_never = ("Not backed up yet.", "Not backed up yet.");
    plain claim_up_to_date = ("Records backed up {when}.", "Records backed up {when}.");
    counted claim_behind = ("{n} change not backed up. Last backup {when}.", "{n} changes not backed up. Last backup {when}.");
    plain claim_moved_nothing = ("Moved to another phone. Nothing unsent here.", "Moved to another phone. Nothing unsent here.");
    counted claim_moved_unsent = ("Moved to another phone. {n} change since {since} is only here.", "Moved to another phone. {n} changes since {since} are only here.");
}
