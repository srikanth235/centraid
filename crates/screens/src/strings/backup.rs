//! The sentences of the backup's line and its screen (#1135, lane H2): "Backed up
//! 2 minutes ago", what waits and why, the gateways' last word, the controls'
//! labels and what the last act did. A thing is "backed up" only once a gateway
//! acknowledged it and the phone recorded that (#1080): no sentence here says
//! more than that.

catalog! {
    plain backup_add_destination = ("Add backup device", "Add backup device");
    plain backup_ago_day = ("1 day ago", "1 day ago");
    plain backup_ago_days = ("{n} days ago", "{n} days ago");
    plain backup_ago_hour = ("1 hour ago", "1 hour ago");
    plain backup_ago_hours = ("{n} hours ago", "{n} hours ago");
    plain backup_ago_minute = ("1 minute ago", "1 minute ago");
    plain backup_ago_minutes = ("{n} minutes ago", "{n} minutes ago");
    plain backup_ago_now = ("just now", "just now");
    plain backup_battery = ("Battery saving can pause backups while Centraid is closed.", "Battery saving can pause backups while Centraid is closed.");
    plain backup_battery_action = ("Allow background backup", "Allow background backup");
    plain backup_dest_pair_again = ("Pair it again", "Pair it again");
    plain backup_devices_heading = ("Backup devices", "Backup devices");
    plain backup_forget = ("Forget", "Forget");
    plain backup_forget_failed = ("Couldn't forget {name}. Try again.", "Couldn't forget {name}. Try again.");
    plain backup_forgotten_not_revoked = ("Forgot {name}, but it wasn't told. Run “centraid-gateway pairings revoke” there.", "Forgot {name}, but it wasn't told. Run “centraid-gateway pairings revoke” there.");
    plain backup_forgotten_revoked = ("Forgot {name}. It now refuses this phone.", "Forgot {name}. It now refuses this phone.");
    plain backup_include_videos = ("Include videos", "Include videos");
    plain backup_key_heading = ("Recovery key", "Recovery key");
    plain backup_key_phone_only = ("Your recovery key is only on this phone. Lose it and your vaults can't be restored. Save a copy.", "Your recovery key is only on this phone. Lose it and your vaults can't be restored. Save a copy.");
    plain backup_key_phone_only_saved = ("On this phone and in your saved copy. Keep that copy safe.", "On this phone and in your saved copy. Keep that copy safe.");
    plain backup_key_show = ("Show recovery key", "Show recovery key");
    plain backup_key_sync_failed = ("Couldn't update {place}. Try again.", "Couldn't update {place}. Try again.");
    plain backup_key_sync_off = ("Keep my key off {place}", "Keep my key off {place}");
    plain backup_key_sync_on = ("Save my key in {place}", "Save my key in {place}");
    plain backup_line_all = ("All {total} photos and files", "All {total} photos and files");
    plain backup_line_count = ("{confirmed} of {total} photos and files", "{confirmed} of {total} photos and files");
    plain backup_line_done = ("Backed up {when}.", "Backed up {when}.");
    plain backup_line_frozen = ("Moved to another phone. Read-only here.", "Moved to another phone. Read-only here.");
    plain backup_line_never = ("Not backed up yet.", "Not backed up yet.");
    plain backup_line_pair_again = ("Your backup device doesn't know this phone. Pair it again.", "Your backup device doesn't know this phone. Pair it again.");
    plain backup_line_records = ("Records backed up {when}.", "Records backed up {when}.");
    plain backup_line_unpaired = ("Not backed up. Pair a backup device.", "Not backed up. Pair a backup device.");
    plain backup_now = ("Back up now", "Back up now");
    plain backup_now_running = ("Backing up…", "Backing up…");
    plain backup_progress = ("Backing up — {counts}", "Backing up — {counts}");
    plain backup_refused = ("Your backup device refused the backup. It may be full. Nothing was lost.", "Your backup device refused the backup. It may be full. Nothing was lost.");
    plain backup_rule_heading = ("Wi-Fi and cellular", "Wi-Fi and cellular");
    plain backup_seen = ("Reached {when}", "Reached {when}");
    plain backup_seen_never = ("Not reached yet", "Not reached yet");
    plain backup_status_catching_up = ("Backing up, last {when}", "Backing up, last {when}");
    plain backup_status_done = ("Backed up {when}", "Backed up {when}");
    plain backup_status_frozen = ("Moved to your other phone", "Moved to your other phone");
    plain backup_status_never = ("Not backed up yet", "Not backed up yet");
    plain backup_status_pair_again = ("Pair your backup device again", "Pair your backup device again");
    plain backup_status_unpaired = ("Not backed up", "Not backed up");
    plain backup_title = ("Backup", "Backup");
    plain backup_unnamed = ("Your backup device", "Your backup device");
    plain backup_wait_ask = ("{count} waiting. Tap Back up now.", "{count} waiting. Tap Back up now.");
    plain backup_wait_bytes = ("{count} being prepared", "{count} being prepared");
    plain backup_wait_charger = ("{count} waiting for a charger", "{count} waiting for a charger");
    plain backup_wait_gateway = ("{count} waiting for your backup device", "{count} waiting for your backup device");
    plain backup_wait_icloud = ("{count} waiting in iCloud", "{count} waiting in iCloud");
    plain backup_wait_pair_again = ("{count} waiting. Pair your backup device again.", "{count} waiting. Pair your backup device again.");
    plain backup_wait_refused = ("{count} waiting. Your backup device is full or refusing.", "{count} waiting. Your backup device is full or refusing.");
    plain backup_wait_untrusted = ("{count} waiting. Wrong device answered.", "{count} waiting. Wrong device answered.");
    plain backup_wait_wifi = ("{count} waiting for Wi-Fi", "{count} waiting for Wi-Fi");
    plain backup_wait_window = ("{count} waiting for background time", "{count} waiting for background time");
}
