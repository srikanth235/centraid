//! `words.enter`: type the 24 words back (#1047 E1, R-1047-E3/E5). Ports
//! `WordsEntrySpec` (and the held-seed halves of `EnrollmentSpec`) headless: the
//! grid is judged by the core as it is typed, and a restore's answer arrives as
//! the worker thread's `OffThreadDone`, which these tests deliver by hand.

mod words_support;

use centraid_api_proto::core_v1 as wire;
use centraid_screens::custody::{routes, secrets};
use prost::Message;
use wire::word_entry::Mark;
use wire::words_enter_event::Kind as K;
use wire::words_enter_state::Phase;
use words_support::*;

const CODE: &str = r#"{"v":2,"gw":"gw-1"}"#;

fn open(route: wire::Route) -> Phone {
    let mut phone = phone(route, "ios");
    // The first screen of the runtime hears Appeared on start.
    phone.serve();
    phone
}

fn typed(phone: &mut Phone, position: u32, text: &str) {
    phone.send_enter(K::Typed(wire::WordTyped {
        position,
        text: text.to_owned(),
    }));
}

fn code(phone: &mut Phone, text: &str) {
    phone.send_enter(K::Endpoint(wire::EndpointTyped {
        text: text.to_owned(),
    }));
}

fn primary(phone: &mut Phone) {
    phone.send_enter(K::Primary(wire::WordsPrimary {}));
}

fn valid_words() -> String {
    words_a().join(" ")
}

/// All 24 cells typed at once (a space moves to the next cell), the pairing
/// code pasted first for a restore.
fn filled(route: wire::Route, pasted: Option<&str>) -> Phone {
    let mut phone = open(route);
    if let Some(text) = pasted {
        code(&mut phone, text);
    }
    typed(&mut phone, 1, &valid_words());
    phone
}

fn restore_answer(vaults: &[(&str, u32, i64, &str)], unclaimed: &[u32]) -> wire::OffThreadDone {
    let response = wire::Response {
        kind: Some(wire::response::Kind::Restore(wire::RestoreResponse {
            vaults: vaults
                .iter()
                .map(|(path, index, rows, safety)| wire::RestoredVault {
                    vault_id: format!("id-{index}"),
                    index: *index,
                    path: (*path).to_owned(),
                    rows: *rows,
                    safety_number: (*safety).to_owned(),
                })
                .collect(),
            gap_scanned: 0,
            unclaimed: unclaimed
                .iter()
                .map(|index| wire::UnclaimedVault {
                    index: *index,
                    vault_id: "ab".repeat(32),
                    reason: "logs only".to_owned(),
                })
                .collect(),
        })),
    };
    wire::OffThreadDone {
        tag: "restore".to_owned(),
        bytes: wire::VaultCalled {
            response: response.encode_to_vec(),
            error: None,
        }
        .encode_to_vec(),
    }
}

fn restore_refused(code: wire::ErrorCode) -> wire::OffThreadDone {
    wire::OffThreadDone {
        tag: "restore".to_owned(),
        bytes: wire::VaultCalled {
            response: Vec::new(),
            error: Some(wire::Error {
                code: code as i32,
                detail: "logs only".to_owned(),
                ..wire::Error::default()
            }),
        }
        .encode_to_vec(),
    }
}

fn deliver(phone: &mut Phone, done: wire::OffThreadDone) {
    phone
        .driver
        .send(phone.id, wire::screen_event::Kind::OffThreadDone(done));
    phone.serve();
}

#[test]
fn the_grid_opens_empty_and_secure_with_the_pairing_codes_field_only_for_a_restore() {
    let phone = open(routes::restore());
    let state = phone.enter();
    assert_eq!(state.phase, Phase::Entering as i32);
    assert!(state.secure);
    assert_eq!(state.cells.len(), 24);
    assert!(state.cells.iter().all(|c| c.mark == Mark::Empty as i32));
    assert_eq!(state.cells[4].prompt, "Word 5");
    assert_eq!(state.title, "Restore with your recovery key");
    assert!(state.endpoint_label.starts_with("Paste the pairing code"));
    assert!(!state.primary_enabled);

    let rekey = open(routes::rekey_for_locker());
    let state = rekey.enter();
    assert_eq!(state.title, "Enter your recovery key");
    assert_eq!(state.endpoint_label, "");
    assert_eq!(state.primary_label, "Use this key");
}

#[test]
fn the_pairing_code_is_scanned_as_well_as_pasted_wherever_its_field_is_drawn() {
    let mut with_camera = open(routes::restore());
    with_camera.send_enter(K::Capability(wire::ScanCapability { camera: true }));
    let state = with_camera.enter();
    assert_eq!(state.scan_label, "Scan QR code");
    assert!(state.scan_camera);
    assert_eq!(state.photo_label, "Choose a photo");

    // NO CAMERA: the same control opens the photo picker.
    let no_camera = open(routes::restore());
    assert_eq!(no_camera.enter().scan_label, "Scan QR code");
    assert!(!no_camera.enter().scan_camera);
    assert_eq!(no_camera.enter().photo_label, "");

    // A re-key names no gateway, so there is nothing to scan.
    let mut rekey = open(routes::rekey_for_locker());
    rekey.send_enter(K::Capability(wire::ScanCapability { camera: true }));
    assert_eq!(rekey.enter().scan_label, "");

    // A scan fills the field as a paste would, and waits for the primary.
    with_camera.send_enter(K::Unread(wire::PhotoUnread {}));
    assert!(with_camera
        .enter()
        .notice
        .starts_with("No readable QR code in that photo."));
    with_camera.send_enter(K::Scanned(wire::PairingScanned {
        payload: CODE.to_owned(),
    }));
    assert_eq!(with_camera.enter().endpoint, CODE);
    assert_eq!(with_camera.enter().notice, "");
    assert_eq!(with_camera.enter().phase, Phase::Entering as i32);
}

#[test]
fn typing_asks_the_core_and_a_space_runs_on_into_the_next_cells() {
    let mut phone = open(routes::restore());
    typed(&mut phone, 3, "abandon ability ");
    let state = phone.enter();
    assert_eq!(state.cells[2].typed, "abandon");
    assert_eq!(state.cells[3].typed, "ability");
    assert_eq!(state.cells[4].typed, "");
    assert_eq!(state.cells[2].mark, Mark::Known as i32);
    // A suggestion picked fills its cell.
    phone.send_enter(K::Picked(wire::SuggestionPicked {
        position: 1,
        word: "zoo".to_owned(),
    }));
    assert_eq!(phone.enter().cells[0].typed, "zoo");
}

#[test]
fn the_verdict_speaks_in_order_the_count_an_unknown_word_by_place_then_the_checksum() {
    let mut phone = open(routes::restore());
    typed(&mut phone, 1, "abandon ability");
    assert_eq!(
        phone.enter().notice,
        "Your recovery key is 24 words. There are 2 here."
    );
    let mut one = open(routes::restore());
    typed(&mut one, 1, "abandon");
    assert_eq!(
        one.enter().notice,
        "Your recovery key is 24 words. There is 1 here."
    );

    let mut unknown = open(routes::restore());
    let mut words = vec!["abandon"; 24];
    words[4] = "abandn";
    typed(&mut unknown, 1, &words.join(" "));
    let state = unknown.enter();
    assert_eq!(state.notice, "Word 5 isn't a recovery key word. Check the spelling.");
    assert_eq!(state.cells[4].mark, Mark::Unknown as i32);
    assert!(state.cells[4].suggestions.contains(&"abandon".to_owned()));
    assert_eq!(state.cells[0].mark, Mark::Known as i32);
    assert!(!state.primary_enabled);

    let mut bad = open(routes::restore());
    typed(&mut bad, 1, &vec!["abandon"; 24].join(" "));
    assert_eq!(
        bad.enter().notice,
        "Those words don't match. Check the order and spelling."
    );

    let mut many = open(routes::restore());
    typed(&mut many, 1, &vec!["abandon"; 25].join(" "));
    // The 25th word has nowhere to land; the grid holds 24.
    assert_eq!(many.enter().cells.len(), 24);
}

#[test]
fn a_restore_waits_for_its_gateways_pairing_code_valid_words_alone_leave_the_control_closed() {
    let mut phone = filled(routes::restore(), None);
    assert!(phone.enter().endpoint_label.starts_with("Paste the pairing code"));
    assert!(!phone.enter().primary_enabled);
    // A STRAY TAP ASKS NOTHING.
    primary(&mut phone);
    assert_eq!(phone.enter().phase, Phase::Entering as i32);
    code(&mut phone, "   ");
    assert!(!phone.enter().primary_enabled, "blank is no code");
    code(&mut phone, CODE);
    assert!(phone.enter().primary_enabled);
}

#[test]
fn a_valid_phrase_opens_the_one_control_and_a_restore_answer_drops_every_word() {
    let mut phone = filled(routes::restore(), Some(CODE));
    assert!(phone.enter().primary_enabled);
    primary(&mut phone);
    let state = phone.enter();
    assert_eq!(state.phase, Phase::Working as i32);
    assert_eq!(state.progress, "Looking for your backup device…");

    deliver(
        &mut phone,
        restore_answer(&[("/v/a/vault.db", 0, 1_204, "12345 67890")], &[]),
    );
    let state = phone.enter();
    assert_eq!(state.phase, Phase::Done as i32);
    assert!(!state.secure && state.cells.is_empty());
    assert_eq!(state.restored[0].line, "Vault 1: 1,204 rows.");
    assert_eq!(state.restored[0].safety_number, "12345 67890");
    assert!(state.restored[0].safety_label.starts_with("Check this number"));
    assert_eq!(state.title, "Your vaults are back");
    assert_eq!(state.primary_label, "Done");
    // The seed was stored and the words kept for Settings.
    assert!(phone.shell.device.contains_key(secrets::LOCAL_WORDS));
    assert_eq!(phone.keeper.log(), vec!["adopt [0] seed=true".to_owned()]);
    primary(&mut phone);
    assert!(phone.enter().finished);

    // ONE ROW IS A ROW; a vault with no census says no count.
    let mut one = filled(routes::restore(), Some(CODE));
    primary(&mut one);
    deliver(&mut one, restore_answer(&[("/v/a/vault.db", 0, 1, "")], &[]));
    assert_eq!(one.enter().restored[0].line, "Vault 1: 1 row.");
    assert_eq!(one.enter().restored[0].safety_label, "");
}

#[test]
fn a_vault_that_stayed_is_numbered_with_the_ones_that_came_back_and_offers_a_retry() {
    let mut phone = filled(routes::restore(), Some(CODE));
    primary(&mut phone);
    deliver(
        &mut phone,
        restore_answer(&[("/v/a/vault.db", 0, 3, ""), ("/v/c/vault.db", 2, 1, "")], &[1]),
    );
    let state = phone.enter();
    assert_eq!(state.title, "Some of your vaults are back");
    assert_eq!(
        state.body,
        "Keep your other phone for now. Try again to bring those vaults here."
    );
    // ONE SEQUENCE BY INDEX: index 1 is "Vault 2" on the stayed list, so the
    // vault at index 2 is "Vault 3".
    let lines: Vec<_> = state.restored.iter().map(|v| v.line.clone()).collect();
    assert_eq!(lines, vec!["Vault 1: 3 rows.", "Vault 3: 1 row."]);
    assert_eq!(
        state.stayed,
        vec!["Vault 2 stayed on your other phone. Your backup device wouldn't hand it over."]
    );
    assert_eq!(state.primary_label, "Done");
    assert_eq!(state.secondary_label, "");
    assert_eq!(state.retry_label, "Try again");
    // THE CORE'S REASON IS A SUPPORT LOG, never a member's sentence.
    assert!(!state.stayed[0].contains("logs only"));

    // The retry: no grid comes back, a second tap asks nothing.
    phone.send_enter(K::Retry(wire::WordsRetry {}));
    let state = phone.enter();
    assert_eq!(state.phase, Phase::Working as i32);
    assert!(state.cells.is_empty() && !state.secure);
    assert_eq!(state.retry_label, "");
    assert_eq!(state.stayed.len(), 1);
    phone.send_enter(K::Retry(wire::WordsRetry {}));

    // STILL REFUSED: back to DONE, both lists standing, the retry offered.
    deliver(&mut phone, restore_refused(wire::ErrorCode::Unauthorized));
    let state = phone.enter();
    assert_eq!(state.phase, Phase::Done as i32);
    assert_eq!(
        state.notice,
        "Your backup device still won't hand it over. It stays on your other phone."
    );
    assert_eq!(state.restored.len(), 2);
    assert_eq!(state.retry_label, "Try again");

    phone.send_enter(K::Retry(wire::WordsRetry {}));
    deliver(&mut phone, restore_refused(wire::ErrorCode::PeerUnreachable));
    assert!(phone.enter().notice.starts_with("Couldn't reach your backup device."));

    // IT CAME BACK: one list, numbered as before, and the whole title.
    phone.send_enter(K::Retry(wire::WordsRetry {}));
    deliver(&mut phone, restore_answer(&[("/v/b/vault.db", 1, 5, "")], &[]));
    let state = phone.enter();
    assert_eq!(state.title, "Your vaults are back");
    assert_eq!(state.notice, "");
    let lines: Vec<_> = state.restored.iter().map(|v| v.line.clone()).collect();
    assert_eq!(lines, vec!["Vault 1: 3 rows.", "Vault 2: 5 rows.", "Vault 3: 1 row."]);
    assert!(state.stayed.is_empty());
    assert_eq!(state.retry_label, "");
}

#[test]
fn an_unreachable_gateway_or_an_empty_one_keeps_the_words_on_screen_with_the_sentence() {
    let cases = [
        (
            restore_refused(wire::ErrorCode::PeerUnreachable),
            "Couldn't reach your backup device. Check “centraid-gateway serve” is running, or paste a new pairing code.",
        ),
        (
            restore_answer(&[], &[]),
            "Your backup device has no backup for that recovery key. Check it's the right one.",
        ),
        (
            restore_refused(wire::ErrorCode::Unauthorized),
            "Your backup device refused the restore. Try again, and check it's the one you paired.",
        ),
        // A BACKUP THIS PHONE WOULD NOT ACCEPT says so, never "could not reach".
        (
            restore_refused(wire::ErrorCode::Internal),
            "The restore failed a check, so nothing changed. Try again.",
        ),
    ];
    for (done, sentence) in cases {
        let mut phone = filled(routes::restore(), Some(CODE));
        primary(&mut phone);
        deliver(&mut phone, done);
        let state = phone.enter();
        assert_eq!(state.phase, Phase::Entering as i32);
        assert_eq!(state.notice, sentence);
        assert_eq!(state.cells[0].typed, "abandon", "the words stay");
        assert!(phone.shell.device.get(secrets::LOCAL_SEED).is_none());
        assert!(phone.shell.synced.is_empty());
    }
}

#[test]
fn re_keying_done_says_the_words_are_back_and_nothing_to_key_offers_the_restore_with_the_words_kept() {
    let mut phone = filled(routes::rekey_for_locker(), None);
    phone.keeper.set_indexed(1);
    assert!(phone.enter().primary_enabled);
    primary(&mut phone);
    let state = phone.enter();
    assert_eq!(state.title, "Recovery key restored");
    assert!(state.cells.is_empty());
    assert_eq!(state.body, "Locker and backups open again for the vaults made with this key.");
    assert_eq!(phone.keeper.log(), vec!["rekey seed=true".to_owned()]);

    let mut none = filled(routes::rekey_for_locker(), None);
    primary(&mut none);
    let state = none.enter();
    assert_eq!(state.phase, Phase::Entering as i32);
    assert!(state.notice.starts_with("No vault on this phone uses this key."));
    assert_eq!(state.primary_label, "Restore vaults");
    // THE OFFERED RESTORE DRAWS THE CODE'S FIELD AND WAITS FOR IT (#1080 A23).
    assert!(state.endpoint_label.starts_with("Paste the pairing code"));
    assert!(!state.primary_enabled);
    assert_eq!(state.cells[0].typed, "abandon");
    code(&mut none, CODE);
    assert!(none.enter().primary_enabled);
    primary(&mut none);
    assert_eq!(none.enter().phase, Phase::Working as i32);
    assert_eq!(none.enter().purpose, wire::WordsEnterPurpose::Restore as i32);
}

#[test]
fn a_re_key_explains_itself_in_its_doors_words_pairings_lockers_and_a_restores_own() {
    let pairing = open(routes::rekey_for_pairing());
    assert_eq!(pairing.enter().origin, wire::WordsEnterOrigin::Pairing as i32);
    assert_eq!(
        pairing.enter().body,
        "Type your recovery key's 24 words, then pair with your backup device."
    );
    assert_eq!(
        open(routes::rekey_for_locker()).enter().body,
        "Type your recovery key's 24 words to open Locker again."
    );
    // Locker's wall was the first door: an unnamed one reads as it.
    assert_eq!(
        open(routes::enter(
            wire::WordsEnterPurpose::Rekey,
            wire::WordsEnterOrigin::Unspecified
        ))
        .enter()
        .body,
        "Type your recovery key's 24 words to open Locker again."
    );
    // A restore has one door, whoever opened it.
    assert_eq!(
        open(routes::enter(
            wire::WordsEnterPurpose::Restore,
            wire::WordsEnterOrigin::Pairing
        ))
        .enter()
        .body,
        "Type your recovery key and paste a pairing code from your backup device."
    );
    // THE DOOR IS KEPT THROUGH DONE: pairing's done points back at the gateway.
    let mut done = filled(routes::rekey_for_pairing(), None);
    done.keeper.set_indexed(1);
    primary(&mut done);
    assert_eq!(
        done.enter().body,
        "The vaults made with this key can pair with your backup device now."
    );
    assert_eq!(done.enter().origin, wire::WordsEnterOrigin::Pairing as i32);
}

fn held_phone(route: wire::Route) -> Phone {
    let mut phone = phone(route, "ios");
    // iCloud Keychain (or Block Store in the setup wizard) put the key here.
    phone
        .shell
        .synced
        .insert(secrets::SEED_KEY.to_owned(), "ab".repeat(64));
    phone.serve();
    phone
}

#[test]
fn a_restore_opened_while_the_keychain_holds_a_seed_opens_without_the_grid() {
    let phone = held_phone(routes::restore());
    let state = phone.enter();
    assert_eq!(state.purpose, wire::WordsEnterPurpose::RestoreHeld as i32);
    assert!(state.cells.is_empty() && !state.secure);
    assert_eq!(state.title, "Restore your vaults");
    assert!(state.endpoint_label.starts_with("Paste the pairing code"));
    // NO CODE, NO RESTORE (#1080 A23).
    assert!(!state.primary_enabled);
    // With none held, it opens the grid.
    assert_eq!(
        open(routes::restore()).enter().purpose,
        wire::WordsEnterPurpose::Restore as i32
    );
}

#[test]
fn a_held_seed_restore_waits_for_the_code_then_restores_and_nothing_held_goes_back_to_entering() {
    let mut phone = held_phone(routes::restore_held());
    primary(&mut phone);
    assert_eq!(phone.enter().phase, Phase::Entering as i32, "a stray tap asks nothing");
    typed(&mut phone, 1, "abandon");
    assert!(phone.enter().cells.is_empty(), "a typed word has nowhere to land");
    code(&mut phone, " ab ");
    assert!(phone.enter().primary_enabled);
    primary(&mut phone);
    assert_eq!(phone.enter().phase, Phase::Working as i32);
    deliver(&mut phone, restore_answer(&[], &[]));
    let state = phone.enter();
    assert_eq!(state.phase, Phase::Entering as i32);
    assert_eq!(
        state.notice,
        "Your backup device has no backup for that recovery key. Check it's the right one."
    );
    primary(&mut phone);
    deliver(&mut phone, restore_answer(&[("/v/a/vault.db", 0, 3, "")], &[]));
    assert_eq!(phone.enter().phase, Phase::Done as i32);
    assert_eq!(phone.enter().restored.len(), 1);
    // The seed is settled once vaults came back; no words are kept.
    assert!(phone.shell.device.contains_key(secrets::SEED_SETTLED));
    assert!(!phone.shell.device.contains_key(secrets::LOCAL_WORDS));
}

#[test]
fn a_held_seed_restore_offers_the_grid_instead_keeping_the_pasted_code() {
    let mut phone = held_phone(routes::restore_held());
    code(&mut phone, CODE);
    assert_eq!(phone.enter().words_label, "Type recovery key");
    phone.send_enter(K::UseWords(wire::WordsUseWords {}));
    let state = phone.enter();
    assert_eq!(state.purpose, wire::WordsEnterPurpose::Restore as i32);
    assert_eq!(state.cells.len(), 24);
    assert!(state.secure);
    assert_eq!(state.endpoint, CODE);
    assert_eq!(state.words_label, "");
    assert!(!state.primary_enabled);
    // Only a held restore has a grid to go to.
    let mut rekey = open(routes::rekey_for_locker());
    rekey.send_enter(K::UseWords(wire::WordsUseWords {}));
    assert_eq!(rekey.enter().purpose, wire::WordsEnterPurpose::Rekey as i32);
}

#[test]
fn a_held_restore_lists_the_vaults_on_their_own_words_it_will_also_bring_back() {
    let mut phone = phone(routes::restore_held(), "ios");
    phone
        .shell
        .synced
        .insert(secrets::SEED_KEY.to_owned(), "ab".repeat(64));
    let id = "0123456789abcdef";
    phone.shell.synced.insert(
        format!("{}{id}", secrets::OWN_SEED_PREFIX),
        "cd".repeat(64),
    );
    phone
        .shell
        .synced
        .insert(secrets::OWN_SEED_INDEX.to_owned(), format!("{id}\t"));
    phone.serve();
    let state = phone.enter();
    assert_eq!(
        state.held_keys_label,
        "These vaults have their own recovery key and come back too:"
    );
    assert_eq!(state.held_keys, vec!["A vault with its own recovery key"]);
}

#[test]
fn vaults_from_two_seeds_are_numbered_once_each_the_members_first() {
    let mut phone = held_phone(routes::restore_held());
    code(&mut phone, CODE);
    primary(&mut phone);
    deliver(&mut phone, restore_answer(&[("/v/a/vault.db", 0, 1, "")], &[1]));
    let state = phone.enter();
    assert_eq!(state.restored[0].line, "Vault 1: 1 row.");
    assert_eq!(
        state.stayed,
        vec!["Vault 2 stayed on your other phone. Your backup device wouldn't hand it over."]
    );
}

#[test]
fn leaving_drops_every_word() {
    let mut phone = filled(routes::restore(), Some(CODE));
    phone.send_enter(K::Secondary(wire::WordsSecondary {}));
    let state = phone.enter();
    assert!(state.finished);
    assert!(state.cells.is_empty() && !state.secure);
}

#[test]
fn a_late_answer_to_a_screen_that_was_left_changes_nothing() {
    let mut phone = filled(routes::restore(), Some(CODE));
    primary(&mut phone);
    phone.send_enter(K::Dismissed(wire::WordsDismissed {}));
    deliver(&mut phone, restore_answer(&[("/v/a/vault.db", 0, 1, "")], &[]));
    assert!(phone.enter().finished);
    assert!(phone.enter().restored.is_empty());
}
