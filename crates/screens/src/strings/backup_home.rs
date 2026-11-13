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

    // THE RULE'S SHORT WORDS, for the "Back up over" row (the sentences above are what
    // it opens). The last has no board word: it is "when you tap", the rule where
    // nothing arrives on its own.
    plain rule_short_wifi_only = ("Wi-Fi only", "Wi-Fi only");
    plain rule_short_wifi_and_cellular_photos = ("Wi-Fi and cellular", "Wi-Fi and cellular");
    plain rule_short_manual = ("On tap", "On tap");

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

    // HOW BACKUP RUNS, on the Backup page under "What travels when": it is foreground work and
    // the windows the OS grants, never continuous, and a force-quit stops it until the next launch.
    plain pass_in_flight_title = ("Backing up", "Backing up");
    plain pass_posture = ("Centraid backs up while open. Your phone keeps uploading after you leave.", "Centraid backs up while open. Your phone keeps uploading after you leave.");
    plain pass_force_quit = ("If you swipe Centraid away, your phone cancels those uploads until you open it again. Low Power Mode pauses them.", "If you swipe Centraid away, your phone cancels those uploads until you open it again. Low Power Mode pauses them.");
    plain pass_force_quit_android = ("If you force-stop Centraid, backup waits until you open it again.", "If you force-stop Centraid, backup waits until you open it again.");
    plain pass_android_unmetered = ("Centraid backs up in the background on Wi-Fi, and on cellular when your setting allows it.", "Centraid backs up in the background on Wi-Fi, and on cellular when your setting allows it.");

    // WHICH BACKUP DEVICE IS BEHIND, FULL OR HOLDING AN OLDER BACKUP (#1188, NB1): the card names
    // it by the name the member gave it, and each row says how it stands.
    plain device_behind = ("{name} is behind", "{name} is behind");
    plain device_full = ("{name} is full", "{name} is full");
    plain device_older = ("{name} has an older backup", "{name} has an older backup");
    plain device_backed_up_to = ("Backed up to {others} {when}", "Backed up to {others} {when}");
    plain device_silent_since = ("{name} hasn't answered since {day}. Check it's awake and on the same network as this phone.", "{name} hasn't answered since {day}. Check it's awake and on the same network as this phone.");
    plain device_too_large = ("{name} refused a file", "{name} refused a file");
    plain device_refusing = ("{name} is refusing the backup", "{name} is refusing the backup");
    plain device_too_large_reason = ("{name} refused a file as over its {limit} limit. Update Centraid on this phone and on {name}, then back up again.", "{name} refused a file as over its {limit} limit. Update Centraid on this phone and on {name}, then back up again.");
    plain device_refusing_reason = ("{name} keeps refusing part of the backup. Check its disk and that Centraid on it is up to date, then back up again.", "{name} keeps refusing part of the backup. Check its disk and that Centraid on it is up to date, then back up again.");
    plain device_full_reason = ("{name} has no room left. Free some space on it, then back up again.", "{name} has no room left. Free some space on it, then back up again.");
    plain device_older_reason = ("It holds an older backup than this phone sent. Back up now to bring it up to date.", "It holds an older backup than this phone sent. Back up now to bring it up to date.");
    plain device_catching_up = ("{name} is catching up. Back up now to send what it is missing.", "{name} is catching up. Back up now to send what it is missing.");
    plain row_up_to_date = ("Up to date", "Up to date");
    plain row_behind_one = ("1 file behind", "1 file behind");
    plain row_behind_many = ("{n} files behind", "{n} files behind");
    plain device_waiting = ("{count} waiting for {name}", "{count} waiting for {name}");
    plain row_catching_up = ("Catching up", "Catching up");
    plain row_full = ("Full", "Full");
    plain row_too_large = ("Refused a file as too large", "Refused a file as too large");
    plain row_refusing = ("Refusing the backup", "Refusing the backup");
    plain row_older = ("Older backup than this phone sent", "Older backup than this phone sent");
    // WHAT A BACKUP DEVICE SAYS ABOUT ITSELF WHEN IT IS NOT A PLAIN "BEHIND" (#1191, B16): another
    // phone took over there, whoever runs it paused it, it runs an older version, one old backup
    // on it can't be read, a stored piece was found damaged, and files this phone deleted there
    // that it holds for a week (the date is the device's).
    plain row_moved = ("Another phone took over", "Another phone took over");
    plain row_paused = ("Paused by whoever runs it", "Paused by whoever runs it");
    plain row_too_old = ("Needs an update", "Needs an update");
    plain row_unreadable = ("One old backup can't be read", "One old backup can't be read");
    plain row_damage_resent = ("A stored piece was damaged. Sending it again.", "A stored piece was damaged. Sending it again.");
    counted row_held = ("{count} old file goes {date}", "{count} old files go {date}");
    counted row_held_paused = ("{count} old file kept while it is paused", "{count} old files kept while it is paused");
    plain row_undo_action = ("Undo", "Undo");
    plain device_moved = ("Another phone took over {name}", "Another phone took over {name}");
    plain device_paused = ("{name} is paused", "{name} is paused");
    plain device_too_old = ("{name} needs an update", "{name} needs an update");
    plain device_paused_reason = ("{name} is paused by whoever runs it. Centraid asks again at the next backup.", "{name} is paused by whoever runs it. Centraid asks again at the next backup.");
    plain device_too_old_reason = ("{name} runs an older version. Update it, then pair again.", "{name} runs an older version. Update it, then pair again.");
    plain device_moved_reason = ("Not you? Ask whoever runs your backup device to pause it.", "Not you? Ask whoever runs your backup device to pause it.");

    // THE ONE-TIME PROMPT after the first confirmed backup (#1188, NB5): "recovery key", never
    // "words"; no checkbox.
    plain key_prompt_title = ("Save your recovery key", "Save your recovery key");
    plain key_prompt_body = ("Your first backup is done. Without the recovery key it can't be opened on a new phone.", "Your first backup is done. Without the recovery key it can't be opened on a new phone.");
    plain key_prompt_save = ("Save recovery key", "Save recovery key");
    plain key_prompt_not_now = ("Not now", "Not now");
    plain notify_ask_title = ("{name} is paired", "{name} is paired");
    plain notify_ask_body = ("Allow notifications so Centraid can tell you when a backup falls behind.", "Allow notifications so Centraid can tell you when a backup falls behind.");
    plain notify_ask_allow = ("Allow notifications", "Allow notifications");
    plain notify_ask_not_now = ("Not now", "Not now");
    plain notify_open_settings = ("Open Settings", "Open Settings");
}
