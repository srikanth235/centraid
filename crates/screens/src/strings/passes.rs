//! THE PASS'S OWN SENTENCES: the transfer rule a member chooses by, and what
//! the phone says about the background windows it asked the OS for. The Backup
//! screen's status lines are made from the conductor's facts by that screen's
//! own module.
//!
//! A rule is spelled once, here: a sentence written in each shell is a rule one
//! shell gets wrong. They are plain sentences and never a label plus a
//! footnote: a member choosing how their phone spends money is owed a sentence
//! they can act on.

catalog! {
    plain transfer_title = ("Downloads", "Downloads");
    plain transfer_subtitle = (
        "Set per phone, not per vault; thumbnails download on any network.",
        "Set per phone, not per vault; thumbnails download on any network."
    );
    // THE DEFAULT. Its failure mode is a late photograph, not a bill.
    plain rule_wifi_only = (
        "Full-size photos and videos back up and download on Wi-Fi only.",
        "Full-size photos and videos back up and download on Wi-Fi only."
    );
    // A photograph's original on cellular; a video's still waits for Wi-Fi.
    plain rule_wifi_and_cellular_photos = (
        "Full-size photos back up and download on Wi-Fi or cellular; videos wait for Wi-Fi.",
        "Full-size photos back up and download on Wi-Fi or cellular; videos wait for Wi-Fi."
    );
    // Nothing ARRIVES on its own; the member taps what they want. Backing up
    // has no tap, so what this phone sends under it waits for Wi-Fi.
    plain rule_manual = (
        "Full-size photos download when you tap one; backups wait for Wi-Fi.",
        "Full-size photos download when you tap one; backups wait for Wi-Fi."
    );
    // The header's line when a rule is holding originals back.
    counted originals_waiting = ("1 original waiting for Wi-Fi", "{n} originals waiting for Wi-Fi");

    // WHAT THE OS SAID ABOUT THE WINDOWS (which of the two it took).
    plain background_both = (
        "Centraid catches up in the background.",
        "Centraid catches up in the background."
    );
    plain background_long_only = (
        "Centraid backs up in the background. It only catches up on changes when you open it.",
        "Centraid backs up in the background. It only catches up on changes when you open it."
    );
    plain background_short_only = (
        "Centraid catches up on changes in the background. It only prepares new backups when you open it.",
        "Centraid catches up on changes in the background. It only prepares new backups when you open it."
    );
    plain background_none_ios = (
        "Background App Refresh is off, so Centraid only catches up when you open it.",
        "Background App Refresh is off, so Centraid only catches up when you open it."
    );
    plain background_none_android = (
        "Centraid cannot catch up in the background on this device.",
        "Centraid cannot catch up in the background on this device."
    );
}
