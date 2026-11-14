//! A restore's metadata is durable before it can change foreground.
mod vault_support;

use centraid_screens::vault::{Restored, files};
use vault_support::*;

fn restored(phone: &Phone, stem: &str, index: u32) -> (String, Restored) {
    let id = lay_down(&phone.dir, stem, stem);
    (
        id,
        Restored {
            path: phone
                .dir
                .join(stem)
                .join(files::VAULT_FILE)
                .to_string_lossy()
                .into_owned(),
            index,
            own: None,
        },
    )
}

#[test]
fn preparation_and_unacknowledged_commit_never_mount_or_change_foreground() {
    let mut phone = Phone::new();
    phone.keep_seed();
    phone.launch();
    let (id, record) = restored(&phone, "restored", 3);
    let writes = phone
        .shelf
        .prepare_restored(&record)
        .expect("valid recovery metadata");
    assert!(phone.holdings().vaults.is_empty());
    assert!(phone.holdings().foreground.is_empty());
    let pending = phone.shelf.adopt_restored(std::slice::from_ref(&record));
    assert_eq!(pending.value, 0);
    assert!(!pending.writes.is_empty());
    assert!(phone.holdings().vaults.is_empty());
    phone.apply(&writes);
    let committed = phone.shelf.adopt_restored(&[record]);
    assert_eq!(committed.value, 1);
    assert!(
        committed.writes.is_empty(),
        "foreground switch owes no secret effects"
    );
    assert!(phone.held(&id).keyed);
    assert_eq!(phone.holdings().foreground, id);
}

#[test]
fn a_crash_before_secret_ack_recovers_the_index_from_the_existing_marker() {
    let dir = scratch();
    let (id, stores) = {
        let mut phone = Phone::on(&dir, None);
        phone.keep_seed();
        phone.launch();
        let (id, record) = restored(&phone, "restored", 7);
        let _not_yet_acknowledged = phone
            .shelf
            .prepare_restored(&record)
            .expect("marker prepares");
        assert_eq!(phone.secrets.vault_index(&id), None);
        assert!(phone.holdings().vaults.is_empty());
        (id, phone.shell.clone())
    };
    let mut reopened = Phone::on(&dir, None);
    reopened.shell = stores;
    reopened.launch_blind();
    assert_eq!(reopened.secrets.vault_index(&id), Some(7));
    assert!(reopened.held(&id).keyed);
    assert!(files::Marker::read(&dir.join("restored")).is_some());
    assert!(reopened.shelf.settle().is_empty());
    assert!(!dir.join("restored").join(files::MARKER_FILE).exists());
}

#[test]
fn confirmed_metadata_rekeys_an_existing_unkeyed_holding_without_adding_it_twice() {
    let dir = scratch();
    let id = lay_down(&dir, "held", "Held");
    let mut phone = Phone::on(&dir, None);
    phone.keep_seed();
    phone.launch();
    assert!(!phone.held(&id).keyed);
    let record = Restored {
        path: dir
            .join("held")
            .join(files::VAULT_FILE)
            .to_string_lossy()
            .into_owned(),
        index: 2,
        own: None,
    };
    let writes = phone
        .shelf
        .prepare_restored(&record)
        .expect("known file prepares");
    assert!(!phone.held(&id).keyed);
    phone.apply(&writes);
    let committed = phone.shelf.adopt_restored(&[record]);
    assert_eq!(committed.value, 0);
    assert!(committed.writes.is_empty());
    assert_eq!(phone.ids().as_slice(), std::slice::from_ref(&id));
    assert!(phone.held(&id).keyed);
}

#[test]
fn invalid_file_or_marker_write_failure_never_changes_the_roster() {
    let mut phone = Phone::new();
    phone.keep_seed();
    phone.launch();
    let missing = Restored {
        path: phone
            .dir
            .join("missing")
            .join(files::VAULT_FILE)
            .to_string_lossy()
            .into_owned(),
        index: 0,
        own: None,
    };
    assert!(phone.shelf.prepare_restored(&missing).is_none());
    let (id, record) = restored(&phone, "restored", 0);
    std::fs::create_dir(phone.dir.join("restored").join(files::MARKER_FILE))
        .expect("refuse marker replacement");
    assert!(phone.shelf.prepare_restored(&record).is_none());
    assert_eq!(phone.secrets.vault_index(&id), None);
    assert!(phone.holdings().vaults.is_empty());
}

#[test]
fn sequential_preparation_does_not_lower_the_high_water_for_a_later_smaller_index() {
    let mut phone = Phone::new();
    phone.keep_seed();
    phone.launch();
    let (_, first) = restored(&phone, "high", 7);
    let (_, next) = restored(&phone, "low", 2);
    for record in [&first, &next] {
        let writes = phone
            .shelf
            .prepare_restored(record)
            .expect("metadata prepares");
        phone.apply(&writes);
        assert_eq!(phone.secrets.next_vault_index(), 8);
        assert!(phone.holdings().vaults.is_empty());
    }
    let committed = phone.shelf.adopt_restored(&[first, next]);
    assert_eq!(committed.value, 2);
    assert!(committed.writes.is_empty());
    assert_eq!(phone.secrets.next_vault_index(), 8);
    assert!(phone.holdings().vaults.iter().all(|held| held.keyed));
}

#[test]
fn a_seed_lost_after_preparation_cannot_mount_an_unkeyed_success() {
    use centraid_api_proto::core_v1 as wire;
    use centraid_screens::custody::secrets::SEED_KEY;
    let mut phone = Phone::new();
    phone.keep_seed();
    phone.launch();
    let (_, record) = restored(&phone, "restored", 0);
    let writes = phone
        .shelf
        .prepare_restored(&record)
        .expect("seed is available");
    phone.apply(&writes);
    phone.apply(&[wire::SecretOp {
        op: wire::secret_op::Op::Delete as i32,
        store: wire::SecretStore::Synced as i32,
        key: SEED_KEY.to_owned(),
        ..Default::default()
    }]);
    let committed = phone.shelf.adopt_restored(&[record]);
    assert_eq!(committed.value, 0);
    assert!(phone.holdings().vaults.is_empty());
    assert!(phone.holdings().foreground.is_empty());
}

#[test]
fn own_word_metadata_survives_a_blind_cold_reopen_without_spending_a_member_index() {
    let dir = scratch();
    let entry = "aabbccddeeff0011";
    let (id, stores) = {
        let mut phone = Phone::on(&dir, None);
        phone
            .shell
            .synced
            .insert(format!("vault-seed.{entry}"), own_seed());
        phone
            .shell
            .synced
            .insert("vault-seeds".to_owned(), format!("{entry}\tOld label"));
        phone.launch();
        let (id, mut record) = restored(&phone, "Recovered own vault", 4);
        record.own = Some(entry.to_owned());
        let writes = phone
            .shelf
            .prepare_restored(&record)
            .expect("own seed prepares");
        assert!(phone.holdings().vaults.is_empty());
        phone.apply(&writes);
        let committed = phone.shelf.adopt_restored(&[record]);
        assert_eq!(committed.value, 1);
        assert!(committed.writes.is_empty());
        assert!(phone.held(&id).keyed);
        assert!(phone.held(&id).own_words);
        assert_eq!(phone.secrets.next_vault_index(), 0);
        assert_eq!(phone.secrets.own_seed_of(&id).as_deref(), Some(entry));
        (id, phone.shell.clone())
    };
    let mut reopened = Phone::on(&dir, None);
    reopened.shell = stores;
    reopened.launch_blind();
    assert!(reopened.held(&id).keyed);
    assert!(reopened.held(&id).own_words);
    assert_eq!(reopened.secrets.vault_index(&id), Some(4));
    assert_eq!(reopened.secrets.next_vault_index(), 0);
}
