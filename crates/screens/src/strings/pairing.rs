//! The pairing screen's sentences (`pair.laptop`), moved here from
//! `copy/words.json` (#1135). A sentence with a hole (`{who}`) is filled with
//! `strings::fill`. The words every screen shares (Done, Cancel, Try again) are
//! `strings::shared`'s.

catalog! {
    plain title = ("Pair with your backup device", "Pair with your backup device");
    plain ask = (
        "Run “centraid-gateway pair” on your backup device, then scan the QR code or paste the pairing code.",
        "Run “centraid-gateway pair” on your backup device, then scan the QR code or paste the pairing code."
    );
    plain empty = ("Scan the QR code, or paste the pairing code.", "Scan the QR code, or paste the pairing code.");
    plain paste_label = ("Pairing code", "Pairing code");
    plain scan = ("Scan QR code", "Scan QR code");
    plain photo = ("Choose a photo", "Choose a photo");
    plain photo_unread = (
        "No readable QR code in that photo. Choose a sharper one, or paste the pairing code.",
        "No readable QR code in that photo. Choose a sharper one, or paste the pairing code."
    );
    plain primary = ("Pair", "Pair");
    plain pairing = ("Pairing with your backup device…", "Pairing with your backup device…");
    plain paired_title = ("Check it's your backup device", "Check it's your backup device");
    plain failed_title = ("Not paired", "Not paired");
    plain needs_words_title = ("Enter your recovery key first", "Enter your recovery key first");
    plain needs_words = (
        "This vault is open without your recovery key. Enter it, then pair.",
        "This vault is open without your recovery key. Enter it, then pair."
    );
    plain no_vault = (
        "Make a vault on this phone first, then pair it with your backup device.",
        "Make a vault on this phone first, then pair it with your backup device."
    );
    plain words_action = ("Enter your recovery key", "Enter your recovery key");
    plain unreachable = (
        "No answer from your backup device. Check it's awake and on the same network.",
        "No answer from your backup device. Check it's awake and on the same network."
    );
    plain not_a_code = (
        "That code didn't work. Run “centraid-gateway pair” again for a new one.",
        "That code didn't work. Run “centraid-gateway pair” again for a new one."
    );
    plain not_taken = (
        "That code didn't work. Run “centraid-gateway pair” again for a new one.",
        "That code didn't work. Run “centraid-gateway pair” again for a new one."
    );
    plain moved = (
        "This vault moved to your other phone. Restore it with your recovery key to pair here.",
        "This vault moved to your other phone. Restore it with your recovery key to pair here."
    );
    plain nothing_to_compare = (
        "Couldn't verify your backup device, so it didn't pair. Try again.",
        "Couldn't verify your backup device, so it didn't pair. Try again."
    );
    plain paired_line = (
        "Paired with {where}. Check the number below matches the safety number “centraid-gateway pair” printed on {who}. If it doesn't, pair again on a network you trust.",
        "Paired with {where}. Check the number below matches the safety number “centraid-gateway pair” printed on {who}. If it doesn't, pair again on a network you trust."
    );
    plain paired_at = ("{who} at {address}", "{who} at {address}");
    plain paired_who = ("your backup device", "your backup device");
}
