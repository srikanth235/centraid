//! `words.make`: make a vault, and its words (#1047 E1, R-1047-E1/E2), headless.
//! Ports `VaultWordsSpec`: every phase, what is drawn, what is secure, when the
//! words are dropped, and the order of the effects.

mod words_support;

use centraid_api_proto::core_v1 as wire;
use centraid_screens::custody::keeper::{Found, FoundRefusal};
use centraid_screens::custody::secrets;
use wire::words_make_event::Kind as K;
use wire::words_make_state::Phase;
use words_support::*;

fn no_keychain(phone: &mut Phone) {
    // Neither store synchronises (Block Store without Google Play services).
    phone.shell.synced_works = false;
    phone.shell.synchronizing = false;
}

/// An iPhone with iCloud Keychain off opens the screen: the words are shown.
fn shown() -> Phone {
    let mut phone = make_phone("ios");
    no_keychain(&mut phone);
    phone.driver.start();
    phone.serve();
    phone
}

#[test]
fn a_phone_with_no_seed_mints_at_once_no_framing_screen_and_the_words_show_on_a_secure_screen() {
    let phone = shown();
    let state = phone.make();
    assert_eq!(state.phase, Phase::Show as i32);
    assert!(state.secure);
    assert_eq!(state.words.len(), 24);
    assert_eq!(state.words[0].position, 1);
    assert_eq!(
        state.words[0].accessibility_label,
        format!("Word 1, {}", state.words[0].word)
    );
    assert_eq!(
        state.custody,
        "iCloud Keychain is off, so your recovery key is only on this iPhone. Save a copy."
    );
    assert_eq!(state.save_label, "Save a copy");
    assert_eq!(state.primary_label, "I've saved it");
    assert_eq!(state.secondary_label, "Cancel");
    assert!(!state.finished);
}

#[test]
fn save_a_copy_hands_the_words_as_one_line_to_the_share_sheet() {
    let mut phone = shown();
    let line: Vec<String> = phone.make().words.iter().map(|w| w.word.clone()).collect();
    phone.send_make(K::SaveCopy(wire::WordsSaveCopy {}));
    let shared = phone.pending();
    let [wire::effect::Kind::Share(share)] = shared.as_slice() else {
        panic!("save a copy shares: {shared:?}")
    };
    assert_eq!(share.text, line.join(" "));
    assert_eq!(share.subject, "Centraid recovery key");
}

#[test]
fn cancelling_or_swiping_away_the_shown_words_closes_and_drops_them_keeping_nothing() {
    for event in [
        K::Secondary(wire::WordsSecondary {}),
        K::Dismissed(wire::WordsDismissed {}),
    ] {
        let mut phone = shown();
        phone.send_make(event);
        let state = phone.make();
        assert!(state.finished);
        assert!(state.words.is_empty() && !state.secure);
        assert!(state.made_line.is_empty());
        assert!(phone.shell.device.is_empty() && phone.shell.synced.is_empty());
        assert!(phone.keeper.log().is_empty());
    }
}

#[test]
fn i_have_saved_them_keeps_the_seed_settled_before_the_vault_is_founded() {
    let mut phone = shown();
    let minted: Vec<String> = phone.make().words.iter().map(|w| w.word.clone()).collect();
    phone.primary_make();
    let state = phone.make();
    // NO "READY" SCREEN: the sheet closes, the sentence rides along for Home.
    assert!(state.finished);
    assert_eq!(
        state.made_line,
        "My vault is on this phone, and your recovery key brings it back."
    );
    assert!(state.words.is_empty());
    // STORED AND SETTLED BEFORE THE FOUND: the shelf saw a seed.
    assert_eq!(
        phone.keeper.log(),
        vec!["found own=None name=My vault seed=true".to_owned()]
    );
    assert!(phone.shell.device.contains_key(secrets::SEED_SETTLED));
    // SHOWN AND KEPT counts as saved; the words are kept on this phone for Settings.
    assert!(phone.shell.device.contains_key(secrets::WORDS_SAVED));
    assert_eq!(
        phone.shell.device.get(secrets::LOCAL_WORDS),
        Some(&minted.join(" "))
    );
    // No keychain took it: it is on this phone only.
    assert!(phone.shell.synced.is_empty());
    assert!(phone.shell.device.contains_key(secrets::LOCAL_SEED));
}

#[test]
fn a_keychain_that_will_hold_the_key_keeps_it_without_showing_the_words() {
    let mut phone = make_phone("ios");
    let mut shown_words = false;
    phone.serve();
    shown_words |= phone.make().phase == Phase::Show as i32;
    let state = phone.make();
    assert!(state.finished, "{state:?}");
    assert!(!shown_words);
    assert!(state.words.is_empty() && !state.secure);
    // The key is in the synchronised store, and not claimed saved: the Backup
    // tab still offers it.
    assert!(phone.shell.synced.contains_key(secrets::SEED_KEY));
    assert!(!phone.shell.device.contains_key(secrets::WORDS_SAVED));
    // The words are still kept on this phone, so the Backup tab can show them.
    assert!(phone.shell.device.contains_key(secrets::LOCAL_WORDS));
    assert!(!phone.shell.device.contains_key(secrets::LOCAL_SEED));
    assert_eq!(phone.keeper.log().len(), 1);
}

fn with_seed_settled(vaults_here: bool) -> Phone {
    // The member's seed, settled: made here before, or put back after a reinstall.
    let mut first = make_phone("ios");
    first.serve();
    let mut phone = make_phone("ios");
    phone.shell.synced = first.shell.synced.clone();
    phone.shell.device = first.shell.device.clone();
    phone.keeper.set_holds(vaults_here);
    phone.driver.start();
    phone
}

#[test]
fn a_settled_seed_with_vaults_asks_for_a_name_and_makes_the_next_vault_with_no_words() {
    let mut phone = with_seed_settled(true);
    let mut fresh = make_phone("ios");
    fresh.shell = phone.shell.clone();
    fresh.keeper.set_holds(true);
    fresh.serve();
    let state = fresh.make();
    assert_eq!(state.phase, Phase::Choose as i32);
    assert!(!state.own_on);
    assert_eq!(state.own_label, "Give this vault its own recovery key");
    assert_eq!(state.name_label, "Vault name");
    assert_eq!(state.primary_label, "Make vault");
    assert!(state.words.is_empty());
    fresh.primary_make();
    assert!(fresh.make().finished);
    assert_eq!(
        fresh.keeper.log(),
        vec!["found own=None name=My vault seed=true".to_owned()]
    );
    let _ = &mut phone;
}

#[test]
fn a_settled_seed_with_no_vault_is_a_reinstalls_first_make_and_asks_nothing() {
    let first = with_seed_settled(false);
    let mut fresh = make_phone("ios");
    fresh.shell = first.shell.clone();
    fresh.serve();
    let state = fresh.make();
    assert!(state.finished);
    assert_eq!(state.own_label, "");
    assert_eq!(fresh.keeper.log().len(), 1);
}

#[test]
fn a_seed_that_arrived_from_elsewhere_is_sent_to_restore_first_and_the_restore_opens_in_its_place()
{
    let mut phone = make_phone("ios");
    // The keychain carried a seed here, with no record of its indices.
    let seed = "ab".repeat(64);
    phone
        .shell
        .synced
        .insert(secrets::SEED_KEY.to_owned(), seed);
    phone.serve();
    let state = phone.make();
    assert_eq!(state.phase, Phase::RestoreFirst as i32);
    assert_eq!(state.restore_label, "Restore my vaults");
    assert_eq!(state.primary_label, "");
    assert_eq!(state.title, "Restore your vaults first");
    phone.send_make(K::Restore(wire::WordsRestoreTapped {}));
    assert!(phone.make().finished);
    let opened = phone.pending();
    let [wire::effect::Kind::OpenRoute(open)] = opened.as_slice() else {
        panic!("restore opens words.enter: {opened:?}")
    };
    let route = open.route.as_ref().expect("a route");
    assert_eq!(route.screen, "words.enter");
    assert!(matches!(
        &route.args,
        Some(wire::route::Args::WordsEnter(args)) if args.purpose == wire::WordsEnterPurpose::RestoreHeld as i32
    ));
}

#[test]
fn a_founding_that_is_refused_says_so_and_try_again_founds_on_the_same_words() {
    let mut phone = shown();
    phone
        .keeper
        .set_found(Some(Found::Refused(FoundRefusal::NotFounded)));
    phone.primary_make();
    let state = phone.make();
    assert_eq!(state.phase, Phase::Failed as i32);
    assert_eq!(state.notice, "Couldn't make the vault. Try again.");
    assert_eq!(state.primary_label, "Try again");
    assert_eq!(state.secondary_label, "Cancel");
    // The keep happened once; try again founds without keeping again.
    phone.keeper.set_found(None);
    let before = phone.shell.device.clone();
    phone.primary_make();
    assert!(phone.make().finished);
    assert_eq!(
        phone.shell.device.get(secrets::LOCAL_SEED),
        before.get(secrets::LOCAL_SEED)
    );
    assert_eq!(phone.keeper.log().len(), 2);
}

#[test]
fn a_session_still_opening_is_not_a_failure_to_blame_on_the_member() {
    let mut phone = shown();
    phone.keeper.set_found(Some(Found::NoSession));
    phone.primary_make();
    assert_eq!(
        phone.make().notice,
        "Centraid is still opening. Try again in a moment."
    );
}

#[test]
fn a_store_that_took_nothing_refuses_the_keep_and_try_again_keeps_the_same_words() {
    let mut phone = shown();
    let minted: Vec<String> = phone.make().words.iter().map(|w| w.word.clone()).collect();
    phone.driver.send(
        phone.id,
        wire::screen_event::Kind::WordsMake(wire::WordsMakeEvent {
            kind: Some(K::Primary(wire::WordsPrimary {})),
        }),
    );
    // Every write the shell is asked for fails.
    while !phone.driver.effects.is_empty() {
        let request = phone.driver.effects.remove(0);
        let count = match request.effect.and_then(|e| e.kind) {
            Some(wire::effect::Kind::Secrets(batch)) => batch.ops.len(),
            other => panic!("unexpected {other:?}"),
        };
        phone.driver.send(
            request.instance,
            wire::screen_event::Kind::EffectResult(wire::EffectResult {
                effect_id: request.effect_id,
                outcome: Some(wire::effect_result::Outcome::Secrets(wire::SecretBatched {
                    answers: vec![wire::SecretAnswer::default(); count],
                })),
            }),
        );
    }
    let state = phone.make();
    assert_eq!(state.phase, Phase::Failed as i32);
    assert_eq!(
        state.notice,
        "Couldn't keep your recovery key on this phone. Try again."
    );
    assert!(phone.keeper.log().is_empty(), "nothing is founded unkept");
    // THE WORDS ARE STILL HELD, so "Try again" keeps the same ones and founds.
    phone.primary_make();
    assert!(phone.make().finished);
    assert_eq!(
        phone.shell.device.get(secrets::LOCAL_WORDS),
        Some(&minted.join(" "))
    );
}

// --- a vault on its own words (R-1047-E18) ------------------------------------

fn choosing() -> Phone {
    let first = with_seed_settled(true);
    let mut phone = make_phone("ios");
    phone.shell = first.shell.clone();
    phone.keeper.set_holds(true);
    phone.serve();
    phone
}

#[test]
fn a_vault_on_its_own_words_is_named_minted_shown_as_its_own_kept_under_its_entry_and_made_on_it() {
    let mut phone = choosing();
    phone.send_make(K::Own(wire::WordsOwnToggled { on: true }));
    let state = phone.make();
    assert!(state.own_on);
    assert_eq!(
        state.body,
        "It gets its own recovery key, with a copy in your main vault's Locker. Your other key can't open it."
    );
    // NO NAME, NO VAULT: the name is how a restore lists it.
    assert!(!state.primary_enabled);
    phone.primary_make();
    assert_eq!(phone.make().phase, Phase::Choose as i32);
    phone.send_make(K::Name(wire::WordsNameTyped {
        text: "Family".to_owned(),
    }));
    assert!(phone.make().primary_enabled);
    phone.primary_make();
    // A VAULT ON ITS OWN KEY IS ALWAYS SHOWN, keychain or not.
    let state = phone.make();
    assert_eq!(state.phase, Phase::Show as i32);
    assert_eq!(state.title, "Recovery key for Family");
    assert_eq!(state.custody, "");
    let minted: Vec<String> = state.words.iter().map(|w| w.word.clone()).collect();
    phone.primary_make();
    let state = phone.make();
    assert!(state.finished);
    assert_eq!(
        state.made_line,
        "Family is on this phone, and its own recovery key brings it back."
    );
    let log = phone.keeper.log();
    assert!(log[0].starts_with("found own=Some(\""), "{log:?}");
    assert!(log[0].contains("name=Family"));
    // The member's seed is untouched; the own words sit under their entry.
    let own_words = phone
        .shell
        .device
        .iter()
        .find(|(key, _)| key.starts_with(secrets::LOCAL_OWN_WORDS_PREFIX))
        .map(|(_, value)| value.clone());
    assert_eq!(own_words, Some(minted.join(" ")));
    // Recorded to be filed in the main vault's Locker on its next unlock.
    assert!(
        phone
            .shell
            .device
            .get(secrets::PENDING_FILINGS)
            .is_some_and(|line| line.ends_with("\tFamily"))
    );
}

#[test]
fn an_entry_kept_for_a_vault_that_was_never_made_is_dropped_when_the_member_walks_away() {
    let mut plain = choosing();
    // A plain vault keeps no entry, so leaving drops nothing.
    plain.send_make(K::Secondary(wire::WordsSecondary {}));
    assert!(plain.make().finished && plain.pending().is_empty());

    let mut phone = choosing();
    phone.send_make(K::Own(wire::WordsOwnToggled { on: true }));
    phone.send_make(K::Name(wire::WordsNameTyped {
        text: "Work".to_owned(),
    }));
    phone.primary_make();
    phone
        .keeper
        .set_found(Some(Found::Refused(FoundRefusal::NotFounded)));
    phone.primary_make();
    assert_eq!(phone.make().phase, Phase::Failed as i32);
    assert!(
        phone
            .shell
            .device
            .keys()
            .any(|key| key.starts_with(secrets::LOCAL_OWN_WORDS_PREFIX))
    );
    // TRY AGAIN founds on the same entry; Cancel drops it.
    phone.keeper.set_found(None);
    phone.send_make(K::Secondary(wire::WordsSecondary {}));
    assert!(phone.make().finished);
    phone.serve();
    assert!(
        !phone
            .shell
            .device
            .keys()
            .any(|key| key.starts_with(secrets::LOCAL_OWN_WORDS_PREFIX))
    );
    assert!(!phone.shell.device.contains_key(secrets::PENDING_FILINGS));
}
