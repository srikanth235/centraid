//! The shelf: the vaults a phone holds, opened keyed from its secrets, found,
//! restored, rested, renamed, frozen and forgotten (#1135, lane H2). Ports the
//! Kotlin `ShelfSpec`, `KeyedOpenSpec`, `VaultMovedSpec`, `VaultMovedProducerSpec`
//! (the shelf's half), the shelf cases of `WordsShelfSpec` and `HomeNoVaultSpec`,
//! over real vault files and the door a shell opens.

mod vault_support;

use centraid_api_proto::core_v1 as wire;
use centraid_core::vaults::Vaults;
use centraid_screens::strings::{self, Locale};
use centraid_screens::vault::{Found, FoundRefusal, Restored, files};
use vault_support::*;

/// Whether the core in front can open Locker: only a keyed core holds `K`.
fn unlocks(phone: &Phone) -> bool {
    phone
        .driver
        .handle
        .locker_session(&wire::LockerSessionRequest {
            step: Some(wire::locker_session_request::Step::Unlock(
                wire::LockerUnlock::default(),
            )),
        })
        .is_ok()
}

fn made(found: &Found) -> &str {
    match found {
        Found::Made(name) => name,
        other => panic!("the found came to {other:?}"),
    }
}

// ---- the first-launch gate and the roster ------------------------------------

#[test]
fn the_first_launch_gate_waits_for_the_read_then_an_empty_directory_holds_nothing() {
    let mut phone = Phone::new();
    // NOT READ YET IS NOT EMPTY: the roster starts empty too, and a gate that
    // took that for "no vault" would flash on every launch of a phone that holds
    // one.
    let before = phone.holdings();
    assert!(!before.loaded);
    assert!(before.vaults.is_empty());
    phone.launch();
    let after = phone.holdings();
    assert!(after.loaded);
    assert!(after.vaults.is_empty());
    assert_eq!(after.foreground, "");
    assert!(!phone.shelf.holds_a_vault());
}

#[test]
fn a_vault_the_phone_holds_is_whole_and_named_by_its_own_file() {
    let dir = scratch();
    let id = lay_down(&dir, "a", "Tahoe Demo");
    let mut phone = Phone::on(&dir, None);
    phone.launch();
    let held = phone.held(&id);
    assert_eq!(held.name, "Tahoe Demo", "the name comes out of the vault");
    assert!(held.foreground);
    assert!(!held.resting);
    assert!(
        held.frozen.is_none(),
        "an ordinary vault draws no frozen line"
    );
    assert!(!held.own_words);
    assert_eq!(phone.holdings().foreground, id);
}

#[test]
fn the_roster_draws_the_foreground_first_and_does_not_move_with_a_state_change() {
    let dir = scratch();
    let a = lay_down(&dir, "a", "A");
    let b = lay_down(&dir, "b", "B");
    let c = lay_down(&dir, "c", "C");
    let mut phone = Phone::on(&dir, None);
    phone.launch();
    assert_eq!(phone.ids(), [a.clone(), b.clone(), c.clone()]);
    assert!(phone.shelf.bring_to_front(&c));
    assert_eq!(phone.ids(), [c.clone(), a.clone(), b.clone()]);
    phone.shelf.freeze(&a, "2026-03-14T09:31:00Z", 1);
    phone.shelf.rest();
    assert_eq!(phone.ids(), [c, a, b], "freezing and resting move no row");
}

#[test]
fn a_loose_sqlite_file_in_the_directory_is_not_a_holding() {
    let dir = scratch();
    std::fs::write(dir.join("loose.sqlite3"), b"").expect("a loose file");
    let mut phone = Phone::on(&dir, None);
    phone.launch();
    assert!(phone.holdings().vaults.is_empty());
}

#[test]
fn a_file_that_will_not_say_which_vault_it_is_is_not_a_holding() {
    let dir = scratch();
    let id = lay_down(&dir, "good", "Good");
    let blank = dir.join("blank");
    std::fs::create_dir_all(&blank).expect("a directory");
    std::fs::write(blank.join(files::VAULT_FILE), b"not a database").expect("a file");
    let mut phone = Phone::on(&dir, None);
    phone.launch();
    assert_eq!(phone.ids(), [id]);
}

#[test]
fn two_files_that_name_one_vault_are_one_holding_and_the_first_wins() {
    let dir = scratch();
    let id = lay_down(&dir, "a", "Original");
    // A copy taken by hand, or a restore written beside the original.
    std::fs::create_dir_all(dir.join("b")).expect("a directory");
    std::fs::copy(
        dir.join("a").join(files::VAULT_FILE),
        dir.join("b").join(files::VAULT_FILE),
    )
    .expect("a copy");
    let mut phone = Phone::on(&dir, None);
    phone.launch();
    assert_eq!(phone.ids(), [id]);
}

#[test]
fn the_vault_the_member_last_had_in_front_is_in_front_after_a_launch() {
    let dir = scratch();
    let _a = lay_down(&dir, "a", "A");
    let b = lay_down(&dir, "b", "B");
    {
        let mut phone = Phone::on(&dir, None);
        phone.launch();
        assert!(phone.shelf.bring_to_front(&b));
    }
    let mut again = Phone::on(&dir, None);
    again.launch();
    assert_eq!(again.holdings().foreground, b);
}

// ---- every open is keyed when it can be --------------------------------------

#[test]
fn a_vault_with_the_seed_and_a_recorded_index_opens_keyed() {
    let dir = scratch();
    let id = lay_down(&dir, "a", "A");
    let mut phone = Phone::on(&dir, None);
    phone.keep_seed();
    phone.record_index(&id, 2);
    phone.launch();
    assert!(phone.held(&id).keyed);
    assert!(unlocks(&phone), "a keyed core holds Locker's key");
}

#[test]
fn no_seed_on_this_phone_opens_the_vault_unkeyed_and_it_still_reads() {
    let dir = scratch();
    let id = lay_down(&dir, "a", "A");
    let mut phone = Phone::on(&dir, None);
    phone.record_index(&id, 0);
    phone.launch();
    let held = phone.held(&id);
    assert!(!held.keyed);
    assert!(!held.resting);
    assert!(
        !unlocks(&phone),
        "an unkeyed core answers Locker's no-words wall"
    );
    let core = phone.shelf.core_of(&id).expect("the core is open");
    assert!(core.with_vault(|vault| Ok(vault.self_id()?)).is_ok());
}

#[test]
fn a_seed_but_no_index_is_unkeyed_never_a_guess_at_index_zero() {
    let dir = scratch();
    let id = lay_down(&dir, "a", "A");
    let mut phone = Phone::on(&dir, None);
    phone.keep_seed();
    phone.launch();
    // TWO VAULTS AT ONE INDEX ARE ONE IDENTITY AND ONE `K`.
    assert!(!phone.held(&id).keyed);
    assert!(!unlocks(&phone));
}

#[test]
fn a_switch_to_a_rested_vault_wakes_it_keyed_at_its_own_index() {
    let dir = scratch();
    let a = lay_down(&dir, "a", "A");
    let b = lay_down(&dir, "b", "B");
    let mut phone = Phone::on(&dir, None);
    phone.keep_seed();
    phone.record_index(&a, 0);
    phone.record_index(&b, 1);
    phone.launch();
    assert_eq!(phone.holdings().foreground, a);
    phone.shelf.rest();
    assert!(phone.held(&b).resting);
    assert!(phone.shelf.bring_to_front(&b));
    let woken = phone.held(&b);
    assert!(!woken.resting);
    assert!(woken.keyed);
    assert!(unlocks(&phone));
}

#[test]
fn the_demo_seed_is_stored_where_a_real_one_lives_and_keys_the_demo_vault_at_zero() {
    let dir = scratch();
    let id = lay_down(&dir, "demo-vault", "Demo");
    let mut phone = Phone::on(&dir, Some(SEED));
    phone.launch();
    assert_eq!(phone.secrets.seed().as_deref(), Some(SEED));
    // The index was recorded by the writes the launch owed, and they landed in
    // the shell's store: a relaunch finds them there.
    assert_eq!(phone.secrets.vault_index(&id), Some(0));
    assert_eq!(
        phone
            .shell
            .device
            .get(&format!("vault-index.{id}"))
            .map(String::as_str),
        Some("0")
    );
    assert!(phone.held(&id).keyed);
}

#[test]
fn the_demo_seed_never_overrides_an_index_already_recorded() {
    let dir = scratch();
    let id = lay_down(&dir, "a", "A");
    let mut phone = Phone::on(&dir, Some(SEED));
    phone.record_index(&id, 5);
    phone.launch();
    assert_eq!(
        phone
            .shell
            .device
            .get(&format!("vault-index.{id}"))
            .map(String::as_str),
        Some("5")
    );
    assert!(phone.held(&id).keyed);
}

#[test]
fn a_launch_value_that_is_not_a_seed_is_no_seed() {
    let dir = scratch();
    let id = lay_down(&dir, "a", "A");
    let mut phone = Phone::on(&dir, Some("abc"));
    phone.launch();
    assert_eq!(phone.secrets.seed(), None);
    assert!(!phone.held(&id).keyed);
}

// ---- found --------------------------------------------------------------------

#[test]
fn making_a_vault_takes_the_index_past_every_one_this_phone_recorded() {
    let mut phone = Phone::new();
    phone.keep_seed();
    // A vault forgotten earlier: forgetting drops its index but never the mark.
    phone.record_index("v-gone", 3);
    phone.shell.device.remove("vault-index.v-gone");
    phone.launch();
    let found = phone.shelf.found(None, "Family");
    assert_eq!(made(&found.value), "Family");
    phone.apply(&found.writes);
    let held = phone.holdings().vaults;
    assert_eq!(held.len(), 1);
    assert!(held[0].keyed);
    assert!(held[0].foreground, "the vault just made is in front");
    assert_eq!(phone.secrets.vault_index(&held[0].vault_id), Some(4));
    assert_eq!(phone.secrets.next_vault_index(), 5);
    assert!(unlocks(&phone));
}

#[test]
fn making_a_vault_with_no_seed_is_unkeyed_and_spends_no_index() {
    let mut phone = Phone::new();
    phone.launch();
    let found = phone.shelf.found(None, "Mine");
    assert_eq!(made(&found.value), "Mine");
    assert!(
        found.writes.is_empty(),
        "no seed, no index: {:?}",
        found.writes
    );
    assert!(!phone.holdings().vaults[0].keyed);
    assert_eq!(phone.secrets.next_vault_index(), 0);
}

#[test]
fn two_vaults_made_before_the_first_is_recorded_never_share_an_index() {
    let mut phone = Phone::new();
    phone.keep_seed();
    phone.launch();
    let first = phone.shelf.found(None, "One");
    let second = phone.shelf.found(None, "Two");
    assert!(matches!(second.value, Found::Made(_)));
    // Neither batch has reached the shell yet; the shelf remembers what it spent.
    let mut all = first.writes;
    all.extend(second.writes);
    phone.apply(&all);
    let mut indices: Vec<u32> = phone
        .holdings()
        .vaults
        .iter()
        .map(|v| phone.secrets.vault_index(&v.vault_id).expect("recorded"))
        .collect();
    indices.sort_unstable();
    assert_eq!(indices, [0, 1]);
}

#[test]
fn a_vault_is_founded_in_a_directory_of_its_own_and_forgetting_deletes_it_whole() {
    let mut phone = Phone::new();
    phone.launch();
    let found = phone.shelf.found(None, "Mine");
    assert_eq!(made(&found.value), "Mine");
    let id = phone.holdings().foreground;
    let homes = phone.homes();
    assert_eq!(homes.len(), 1);
    let home = &homes[0];
    assert!(home.join(files::VAULT_FILE).exists());
    assert!(
        home.file_name()
            .and_then(|n| n.to_str())
            .is_some_and(|n| n.starts_with(files::PREFIX)),
        "{home:?}"
    );
    // The backup home the core keeps beside the file is this vault's alone.
    std::fs::create_dir_all(home.join("backup")).expect("backup");
    assert!(phone.shelf.forget(&id).value);
    assert!(!home.exists(), "the directory goes whole");
    assert!(phone.dir.exists(), "the shelf's own directory stays");
    assert!(phone.holdings().vaults.is_empty());
}

#[test]
fn the_first_vault_gets_the_starter_rows_and_the_second_does_not() {
    let mut phone = Phone::new();
    phone.launch();
    phone.shelf.found(None, "First");
    let rows = |phone: &Phone| {
        let core = phone.shelf.foreground_core().expect("a core in front");
        core.with_vault(|vault| {
            Ok(vault.read(|connection| {
                Ok(
                    connection.query_row("SELECT COUNT(*) FROM entity", [], |row| {
                        row.get::<_, i64>(0)
                    })?,
                )
            })?)
        })
        .expect("a count")
    };
    let first = rows(&phone);
    phone.shelf.found(None, "Second");
    let second = rows(&phone);
    assert!(
        first > second,
        "starters add rows to the first vault only: {first} vs {second}"
    );
}

#[test]
fn a_found_the_core_refuses_deletes_its_directory_and_gives_its_index_back() {
    let dir = scratch();
    // The core is sabotaged as it is prepared, so the found has nothing to
    // write into: a refusal the shelf did not cause.
    let mut phone = Phone::prepared(
        &dir,
        std::sync::Arc::new(|core: &centraid_core::Handle| {
            let _ = core.close_file();
        }),
    );
    phone.keep_seed();
    phone.launch();
    let refused = phone.shelf.found(None, "Nope");
    assert_eq!(refused.value, Found::Refused(FoundRefusal::NotFounded));
    assert!(refused.writes.is_empty());
    assert!(phone.homes().is_empty(), "no stray directory");
    assert!(phone.holdings().vaults.is_empty());
    assert_eq!(phone.shelf.indexed_holdings(), 0);
}

#[test]
fn a_found_before_the_shelf_has_opened_is_told_to_try_again() {
    let phone = Phone::new();
    assert_eq!(phone.shelf.found(None, "Early").value, Found::NoSession);
}

// ---- the crash window (#1047 E4) ---------------------------------------------

#[test]
fn the_index_is_spent_in_the_directory_before_the_core_makes_the_file() {
    let mut phone = Phone::new();
    phone.keep_seed();
    phone.record_index("v-old", 1);
    phone.launch();
    let found = phone.shelf.found(None, "Mine");
    assert!(matches!(found.value, Found::Made(_)));
    // The shell has not performed the writes yet: the marker is what a killed
    // process leaves behind.
    let home = &phone.homes()[0];
    let marker = files::Marker::read(home).expect("a marker is on disk");
    assert_eq!(marker.index, 2);
    assert_eq!(marker.own, None);
    // Once the secret store holds the index the marker is cleared.
    phone.apply(&found.writes);
    assert!(phone.shelf.settle().is_empty());
    assert!(files::Marker::read(home).is_none());
}

#[test]
fn a_found_the_process_did_not_live_to_record_is_finished_by_the_next_launch_keyed() {
    let dir = scratch();
    // THE KILL: the core founded the vault at index 2, and the process died
    // before the shell recorded the index under the id.
    let id = lay_down(&dir, "x", "X");
    files::Marker {
        index: 2,
        own: None,
    }
    .write(&dir.join("x"))
    .expect("a marker");
    let mut phone = Phone::on(&dir, None);
    phone.keep_seed();
    phone.record_index("v-old", 1);
    phone.launch();
    assert_eq!(
        phone.secrets.vault_index(&id),
        Some(2),
        "the launch recorded it"
    );
    assert!(phone.held(&id).keyed);
    // AND THE NEXT FOUND DOES NOT TAKE INDEX 2 AGAIN.
    assert_eq!(phone.secrets.next_vault_index(), 3);
    // Seen in the store, the marker goes.
    assert!(phone.shelf.settle().is_empty());
    assert!(files::Marker::read(&dir.join("x")).is_none());
}

#[test]
fn killed_before_the_core_made_the_file_the_empty_directory_is_deleted_and_nothing_was_spent() {
    let dir = scratch();
    let dead = dir.join("centraid-vault-dead");
    std::fs::create_dir_all(&dead).expect("a directory");
    files::Marker {
        index: 0,
        own: None,
    }
    .write(&dead)
    .expect("a marker");
    let mut phone = Phone::on(&dir, None);
    phone.keep_seed();
    phone.launch();
    assert!(!dead.exists());
    assert_eq!(
        phone.secrets.next_vault_index(),
        0,
        "the index was never recorded"
    );
    assert!(
        phone
            .shelf
            .found(None, "Mine")
            .writes
            .iter()
            .any(|op| { op.key.starts_with("vault-index.") && op.value == b"0" })
    );
}

#[test]
fn a_file_that_names_no_vault_under_a_marker_is_deleted_whole() {
    let dir = scratch();
    let home = dir.join("centraid-vault-half");
    std::fs::create_dir_all(&home).expect("a directory");
    // The core made the file and the process died before the vault was founded.
    drop(Core::open(CoreConfig::new(home.join(files::VAULT_FILE))).expect("a file"));
    files::Marker {
        index: 0,
        own: None,
    }
    .write(&home)
    .expect("a marker");
    let mut phone = Phone::on(&dir, None);
    phone.launch();
    assert!(!home.exists());
    assert!(phone.holdings().vaults.is_empty());
}

use centraid_core::{Core, CoreConfig};

// ---- a vault on its own words (R-1047-E18) -----------------------------------

#[test]
fn a_vault_on_its_own_words_is_founded_on_its_entrys_seed_at_zero_and_the_members_mark_stays() {
    let mut phone = Phone::new();
    phone.keep_seed();
    phone.record_index("v-a", 3);
    phone.launch();
    let kept = phone
        .secrets
        .keep_own_seed("ab12ab12ab12ab12", &own_seed(), "Family", true);
    phone.apply(&kept.first());
    let found = phone.shelf.found(Some("ab12ab12ab12ab12"), "Family");
    assert_eq!(made(&found.value), "Family");
    phone.apply(&found.writes);
    let id = phone.holdings().foreground;
    assert!(phone.held(&id).keyed);
    assert!(phone.held(&id).own_words);
    assert_eq!(
        phone.secrets.vault_key(&id),
        Some(centraid_screens::custody::secrets::VaultKey {
            index: 0,
            own: Some("ab12ab12ab12ab12".to_owned())
        })
    );
    // THE MEMBER'S NEXT VAULT is still one past 3, not past the entry's 0.
    assert_eq!(phone.secrets.next_vault_index(), 4);
    // FORGETTING IT takes its keychain entry with it.
    let forgotten = phone.shelf.forget(&id);
    phone.apply(&forgotten.writes);
    assert!(phone.secrets.own_seeds().is_empty());
    assert_eq!(phone.secrets.own_seed("ab12ab12ab12ab12"), None);
}

#[test]
fn a_vault_on_its_own_words_without_its_entrys_seed_is_refused_rather_than_founded_unkeyed() {
    let mut phone = Phone::new();
    phone.keep_seed();
    phone.launch();
    let refused = phone.shelf.found(Some("ab12ab12ab12ab12"), "Family");
    assert_eq!(refused.value, Found::Refused(FoundRefusal::NoCore));
    assert!(phone.homes().is_empty());
}

#[test]
fn a_vault_on_its_own_words_reopens_with_its_own_seed_at_launch_and_a_dead_found_gives_the_entry_back()
 {
    let dir = scratch();
    let id = lay_down(&dir, "f", "Family");
    let mut phone = Phone::on(&dir, None);
    phone.keep_seed();
    // The entry and the binding the founder recorded.
    let own = "ab12ab12ab12ab12";
    phone
        .shell
        .synced
        .insert(format!("vault-seed.{own}"), own_seed());
    phone
        .shell
        .synced
        .insert("vault-seeds".to_owned(), format!("{own}\tFamily"));
    phone
        .shell
        .device
        .insert(format!("vault-own.{id}"), own.to_owned());
    phone
        .shell
        .device
        .insert(format!("vault-index.{id}"), "0".to_owned());
    // A found on another entry that died before its file.
    let orphan = "cd34cd34cd34cd34";
    phone
        .shell
        .synced
        .insert(format!("vault-seed.{orphan}"), "ef".repeat(64));
    phone.shell.synced.insert(
        "vault-seeds".to_owned(),
        format!("{own}\tFamily\n{orphan}\tWork"),
    );
    let dead = dir.join("centraid-vault-gone");
    std::fs::create_dir_all(&dead).expect("a directory");
    files::Marker {
        index: 0,
        own: Some(orphan.to_owned()),
    }
    .write(&dead)
    .expect("a marker");
    phone.launch();
    assert!(phone.held(&id).keyed);
    assert!(phone.held(&id).own_words);
    assert!(!dead.exists());
    assert_eq!(
        phone.secrets.own_seed(orphan),
        None,
        "the orphan's entry is given back"
    );
    assert!(phone.secrets.own_seed(own).is_some());
}

// ---- restore and re-key (#1047 E1) -------------------------------------------

#[test]
fn a_restored_vaults_own_directory_is_a_holding_keyed_at_the_restores_index() {
    let dir = scratch();
    let id = lay_down(&dir, "0a1b2c3d4e5f6071", "Restored");
    let shelf_dir = dir.join("shelf");
    std::fs::create_dir_all(&shelf_dir).expect("a shelf directory");
    let mut phone = Phone::on(&shelf_dir, None);
    phone.keep_seed();
    phone.launch();
    assert!(phone.holdings().vaults.is_empty());
    // The restore lays the vault down in the shelf's directory, in a directory
    // of its own, after the launch.
    let laid = phone.dir.join("0a1b2c3d4e5f6071");
    std::fs::rename(dir.join("0a1b2c3d4e5f6071"), &laid).expect("moved in");
    let path = laid.join(files::VAULT_FILE).to_string_lossy().into_owned();
    let adopted = phone.shelf.adopt_restored(&[Restored {
        path,
        index: 3,
        own: None,
    }]);
    assert_eq!(adopted.value, 1);
    phone.apply(&adopted.writes);
    assert_eq!(phone.secrets.vault_index(&id), Some(3));
    assert!(phone.held(&id).keyed);
    assert_eq!(
        phone.holdings().foreground,
        id,
        "the first vault held is in front"
    );
    // NO DEVICE KEY IS KEPT (#1080 A21).
    assert!(
        phone
            .shell
            .device
            .keys()
            .all(|key| !key.starts_with("device-secret."))
    );
    // AND A RELAUNCH FINDS IT THERE.
    let mut again = Phone::on(&phone.dir, None);
    again.shell = phone.shell.clone();
    again.launch();
    assert_eq!(again.ids(), [id]);
    assert!(again.holdings().vaults[0].keyed);
}

#[test]
fn a_restored_vault_this_phone_already_holds_is_not_added_twice() {
    let dir = scratch();
    let id = lay_down(&dir, "a", "A");
    let mut phone = Phone::on(&dir, None);
    phone.keep_seed();
    phone.record_index(&id, 0);
    phone.launch();
    let path = dir
        .join("a")
        .join(files::VAULT_FILE)
        .to_string_lossy()
        .into_owned();
    let adopted = phone.shelf.adopt_restored(&[Restored {
        path,
        index: 0,
        own: None,
    }]);
    assert_eq!(adopted.value, 0);
    assert!(adopted.writes.is_empty());
}

#[test]
fn handing_the_words_back_reopens_what_has_an_index_and_guesses_none_for_the_rest() {
    let dir = scratch();
    let a = lay_down(&dir, "a", "A");
    let b = lay_down(&dir, "b", "B");
    let mut phone = Phone::on(&dir, None);
    phone.record_index(&a, 0);
    phone.launch();
    assert!(phone.holdings().vaults.iter().all(|v| !v.keyed));
    assert_eq!(phone.shelf.indexed_holdings(), 1);
    // The words are handed back: the seed is stored again.
    phone.apply(&secrets_for_seed());
    assert_eq!(phone.shelf.rekey(), 1);
    assert!(phone.held(&a).keyed);
    assert!(!phone.held(&b).keyed);
    assert!(unlocks(&phone) == (phone.holdings().foreground == a));
}

fn secrets_for_seed() -> Vec<wire::SecretOp> {
    centraid_screens::custody::secrets::VaultSecrets::remember_seed(SEED, true).first()
}

// ---- the front holds no vault -------------------------------------------------

#[test]
fn the_front_core_holds_no_vault_and_makes_no_file_and_asks_the_words_with_a_vault_in_front() {
    let dir = scratch();
    lay_down(&dir, "a", "A");
    let mut phone = Phone::on(&dir, None);
    phone.launch();
    assert!(!dir.join("custody-probe.sqlite3").exists());
    assert!(!dir.join("custody-probe.bytes").exists());
    // The words need no vault: the front answers them itself.
    let minted = phone
        .driver
        .handle
        .call(&wire::Request {
            kind: Some(wire::request::Kind::Phrase(wire::PhraseRequest {
                op: Some(wire::phrase_request::Op::Mint(wire::PhraseMint {})),
            })),
        })
        .expect("the words are asked of the front");
    assert!(matches!(minted.kind, Some(wire::response::Kind::Phrase(_))));
}

// ---- rest, wake, rename, freeze ------------------------------------------------

#[test]
fn rest_closes_every_core_but_the_foregrounds_and_a_touch_reopens_one() {
    let dir = scratch();
    let a = lay_down(&dir, "a", "A");
    let b = lay_down(&dir, "b", "B");
    let mut phone = Phone::on(&dir, None);
    phone.launch();
    assert_eq!(phone.holdings().foreground, a);
    phone.shelf.rest();
    assert!(
        !phone.held(&a).resting,
        "the screen the member is looking at stays"
    );
    assert!(phone.held(&b).resting);
    // A RESTING HOLDING IS NOT DEGRADED: it is whole, not frozen.
    assert!(phone.held(&b).frozen.is_none());
    assert!(
        !phone
            .shelf
            .held()
            .iter()
            .find(|v| v.vault_id == b)
            .expect("held")
            .drainable
    );
    let core = phone.shelf.core_of(&b).expect("wakes");
    assert!(core.with_vault(|vault| Ok(vault.self_id()?)).is_ok());
    assert!(!phone.held(&b).resting);
    assert_eq!(phone.holdings().foreground, a, "a touch is not a switch");
}

#[test]
fn rename_writes_the_vaults_own_name_and_the_holding_takes_it() {
    let dir = scratch();
    let a = lay_down(&dir, "a", "A");
    let b = lay_down(&dir, "b", "B");
    let mut phone = Phone::on(&dir, None);
    phone.launch();
    phone.shelf.rest();
    // A resting holding is woken to be written.
    assert!(phone.shelf.rename(&b, "  Work  "));
    assert_eq!(phone.held(&b).name, "Work");
    assert_eq!(phone.held(&a).name, "A");
    // The name lives in the file: a relaunch reads it back.
    drop(phone);
    let mut again = Phone::on(&dir, None);
    again.launch();
    assert_eq!(again.held(&b).name, "Work");
}

#[test]
fn rename_refuses_a_blank_name_an_unknown_vault_and_a_vault_that_moved() {
    let dir = scratch();
    let a = lay_down(&dir, "a", "A");
    let mut phone = Phone::on(&dir, None);
    phone.launch();
    assert!(!phone.shelf.rename(&a, "   "));
    assert!(!phone.shelf.rename("nobody", "X"));
    phone.shelf.freeze(&a, "2026-03-14T09:31:00Z", 2);
    assert!(
        !phone.shelf.rename(&a, "X"),
        "a vault that moved is read-only"
    );
    assert_eq!(phone.held(&a).name, "A");
}

#[test]
fn a_moved_vault_refuses_nothing_here_keeps_its_core_and_says_what_it_holds() {
    let dir = scratch();
    let a = lay_down(&dir, "a", "A");
    let mut phone = Phone::on(&dir, None);
    phone.launch();
    assert!(
        phone.held(&a).frozen.is_none(),
        "the inverse first: a freeze is a state, not a wall"
    );
    phone.shelf.freeze(&a, "2026-03-14T09:31:00Z", 12);
    let held = phone.held(&a);
    let frozen = held.frozen.expect("frozen");
    assert_eq!(frozen.since, "2026-03-14");
    assert_eq!(frozen.unacked, 12);
    // AND THE CORE IS STILL OPEN: freezing is not forgetting.
    assert!(!held.resting);
    assert!(phone.shelf.core_of(&a).is_some());
    assert!(
        !phone.shelf.held()[0].drainable,
        "a pass would only be refused"
    );
    // The line a member reads is Rust's.
    assert_eq!(
        strings::vault::frozen_line(Locale::En, frozen.unacked, &frozen.since),
        "12 changes since 2026-03-14"
    );
    assert_eq!(
        strings::vault::frozen_line(Locale::En, 1, &frozen.since),
        "1 change since 2026-03-14"
    );
    assert_eq!(
        strings::vault::frozen_line(Locale::En, 0, &frozen.since),
        "0 changes since 2026-03-14"
    );
}

#[test]
fn freezing_a_vault_this_phone_does_not_hold_is_not_an_error_and_a_freeze_is_kept_across_a_rest() {
    let dir = scratch();
    let a = lay_down(&dir, "a", "A");
    let b = lay_down(&dir, "b", "B");
    let mut phone = Phone::on(&dir, None);
    phone.launch();
    phone.shelf.freeze("nobody", "2026-03-14T09:31:00Z", 3);
    assert_eq!(phone.ids().len(), 2);
    phone.shelf.freeze(&b, "2026-03-14T09:31:00Z", 3);
    phone.shelf.rest();
    assert_eq!(phone.held(&b).frozen.expect("kept").unacked, 3);
    assert!(phone.held(&b).resting);
    assert!(phone.held(&a).frozen.is_none());
}

// ---- forget --------------------------------------------------------------------

#[test]
fn forgetting_a_vault_drops_its_index_but_never_the_mark() {
    let dir = scratch();
    let a = lay_down(&dir, "a", "A");
    let mut phone = Phone::on(&dir, None);
    phone.keep_seed();
    phone.record_index(&a, 0);
    phone.launch();
    let forgotten = phone.shelf.forget(&a);
    assert!(forgotten.value);
    phone.apply(&forgotten.writes);
    assert_eq!(phone.secrets.vault_index(&a), None);
    assert_eq!(phone.secrets.next_vault_index(), 1);
    assert_eq!(phone.holdings().foreground, "");
    assert!(!dir.join("a").exists());
}

#[test]
fn forgetting_the_vault_in_front_brings_the_first_remaining_forward() {
    let dir = scratch();
    let a = lay_down(&dir, "a", "A");
    let b = lay_down(&dir, "b", "B");
    let mut phone = Phone::on(&dir, None);
    phone.launch();
    phone.shelf.rest();
    phone.shelf.forget(&a);
    assert_eq!(phone.holdings().foreground, b);
    assert!(!phone.held(&b).resting, "the vault now in front is awake");
    // And a relaunch remembers it.
    drop(phone);
    let mut again = Phone::on(&dir, None);
    again.launch();
    assert_eq!(again.holdings().foreground, b);
}

#[test]
fn forgetting_a_vault_nothing_holds_is_a_no_op() {
    let dir = scratch();
    let a = lay_down(&dir, "a", "A");
    let mut phone = Phone::on(&dir, None);
    phone.launch();
    let forgotten = phone.shelf.forget("nobody");
    assert!(!forgotten.value);
    assert!(forgotten.writes.is_empty());
    assert_eq!(phone.ids(), [a]);
}

#[test]
fn a_vault_file_outside_the_shelfs_own_directories_loses_its_holding_and_not_its_parents() {
    let dir = scratch();
    let elsewhere = scratch();
    let id = lay_down(&elsewhere, "keep", "Elsewhere");
    let mut phone = Phone::on(&dir, None);
    phone.launch();
    let adopted = phone.shelf.adopt_restored(&[Restored {
        path: elsewhere
            .join("keep")
            .join(files::VAULT_FILE)
            .to_string_lossy()
            .into_owned(),
        index: 0,
        own: None,
    }]);
    assert_eq!(adopted.value, 1);
    assert!(phone.shelf.forget(&id).value);
    assert!(
        elsewhere.join("keep").exists(),
        "only the shelf's own directories are deleted"
    );
    // A path at the shelf's root: the root itself is never deleted either.
    assert!(!files::delete_vault(&dir, &dir.join(files::VAULT_FILE)));
    assert!(dir.exists());
}
