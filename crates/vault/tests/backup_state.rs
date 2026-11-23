//! The device state and the staging area (spec §6.1, §6.4, #1209, L4): the schema, every
//! constraint the code states written with raw SQL, and the crash a rename leaves behind.
//! Counts and rows, never durations.

use centraid_media::sealed::{Name, PlaintextHash};
use centraid_vault::backup::PlaneError;
use centraid_vault::backup::staging::{self, Staging};
use centraid_vault::backup::state::{
    Device, DeviceState, Gateway, LocalBytes, LocalSource, STATE_APPLICATION_ID,
};
use rusqlite::Connection;

const GATEWAY: &str = "0123456789abcdef0123456789abcdef";

fn name(seed: u8) -> Name {
    Name::from_hex(&format!("{seed:02x}").repeat(32)).expect("a name")
}

fn paired(id: &str, epoch: u64) -> Gateway {
    Gateway::paired(
        id.to_owned(),
        vec!["192.168.1.5:7443".to_owned()],
        vec![1, 2, 3],
        "the desk".to_owned(),
        epoch,
        100,
    )
}

fn open() -> (tempfile::TempDir, DeviceState) {
    let dir = tempfile::tempdir().expect("a temp dir");
    let state = DeviceState::open(dir.path().join("v.state.db")).expect("opens");
    (dir, state)
}

fn refused(connection: &Connection, sql: &str, params: impl rusqlite::Params) -> bool {
    connection.execute(sql, params).is_err_and(|error| {
        error.to_string().contains("CHECK") || error.to_string().contains("constraint")
    })
}

#[test]
fn the_schema_has_no_outbox_and_one_rung() {
    let (_dir, state) = open();
    let connection = state.connection();
    let mut tables: Vec<String> = connection
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name")
        .expect("prepares")
        .query_map([], |row| row.get(0))
        .expect("lists")
        .collect::<rusqlite::Result<_>>()
        .expect("rows");
    tables.sort();
    assert_eq!(
        tables,
        [
            "device",
            "gateway",
            "local_bytes",
            "node",
            "staged",
            "undone"
        ],
        "pairings, what each confirmed, the node cache, staging, the device row, undone names, local bytes"
    );
    assert!(!tables.iter().any(|table| table.contains("outbox")));
    let (application_id, version): (i64, i64) = (
        connection
            .query_row("PRAGMA application_id", [], |row| row.get(0))
            .expect("id"),
        connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .expect("version"),
    );
    assert_eq!((application_id, version), (STATE_APPLICATION_ID, 1));
}

#[test]
fn every_constraint_the_code_states_is_in_the_database_too() {
    let (_dir, state) = open();
    let c = state.connection();
    state.add_gateway(&paired(GATEWAY, 1)).expect("pairs");
    let hex = "ab".repeat(32);

    // gateway
    assert!(
        refused(
            c,
            "INSERT INTO gateway (gateway_id, addrs, cert_der, label, epoch, paired_ms) VALUES ('g', '[]', x'', 'l', 0, 1)",
            []
        ),
        "epoch >= 1"
    );
    assert!(
        refused(
            c,
            "INSERT INTO gateway (gateway_id, addrs, cert_der, label, epoch, paired_ms) VALUES ('', '[]', x'', 'l', 1, 1)",
            []
        ),
        "an id"
    );
    assert!(
        refused(c, "UPDATE gateway SET reach = 'asleep'", []),
        "a closed set of reaches"
    );
    assert!(
        refused(c, "UPDATE gateway SET reach = 'moved'", []),
        "moved needs its epoch"
    );
    assert!(
        refused(c, "UPDATE gateway SET moved_epoch = 2", []),
        "an epoch needs moved"
    );
    assert!(
        refused(c, "UPDATE gateway SET conf = ?1", [&hex]),
        "a confirmation needs its time"
    );
    assert!(
        refused(
            c,
            "UPDATE gateway SET troot = ?1, troot_ms = 1",
            ["NOT-HEX"]
        ),
        "a name is 64 hex"
    );
    assert!(
        refused(c, "UPDATE gateway SET oroot = ?1", [&hex]),
        "a confirmation needs its time"
    );
    assert!(refused(c, "UPDATE gateway SET sample_counter = -1", []));
    assert!(refused(c, "UPDATE gateway SET generation = -1", []));
    assert!(refused(c, "UPDATE gateway SET directory_dirty = 2", []));
    assert!(refused(c, "UPDATE gateway SET scrub_cursor = 'x'", []));
    // node
    assert!(refused(
        c,
        "INSERT INTO node (name, plaintext) VALUES ('short', x'01')",
        []
    ));
    assert!(
        refused(
            c,
            "INSERT INTO node (name, plaintext) VALUES (?1, x'')",
            [&hex]
        ),
        "a node has bytes"
    );
    // staged
    assert!(refused(
        c,
        "INSERT INTO staged (name, path, size) VALUES (?1, 'p', -1)",
        [&hex]
    ));
    assert!(refused(
        c,
        "INSERT INTO staged (name, path, size) VALUES (?1, '', 1)",
        [&hex]
    ));
    // device
    assert!(
        refused(c, "INSERT INTO device (id) VALUES (2)", []),
        "one row"
    );
    assert!(
        refused(c, "UPDATE device SET newest = ?1", [&hex]),
        "a root needs its time"
    );
    assert!(
        refused(c, "UPDATE device SET carry = x'010203'", []),
        "pages are four bytes"
    );
    assert!(refused(c, "UPDATE device SET since_full = -1", []));
    // undone
    assert!(
        c.execute(
            "INSERT INTO undone (gateway_id, name, until_ms) VALUES ('nobody', ?1, 1)",
            [&hex]
        )
        .is_err(),
        "an undone name belongs to a paired gateway"
    );
    // local_bytes
    assert!(
        refused(
            c,
            "INSERT INTO local_bytes (hash, source) VALUES (?1, 'os')",
            [&hex]
        ),
        "a library row needs its reference"
    );
    assert!(
        refused(
            c,
            "INSERT INTO local_bytes (hash, source, ref) VALUES (?1, 'store', 'x')",
            [&hex]
        ),
        "a store row has none"
    );
    assert!(
        refused(
            c,
            "INSERT INTO local_bytes (hash, source, edited) VALUES (?1, 'store', 1)",
            [&hex]
        ),
        "only a library item is edited"
    );
}

#[test]
fn what_a_gateway_confirmed_survives_a_reopen_and_a_new_epoch_is_a_new_ask() {
    let dir = tempfile::tempdir().expect("a temp dir");
    let path = dir.path().join("v.state.db");
    {
        let state = DeviceState::open(&path).expect("opens");
        state.add_gateway(&paired(GATEWAY, 1)).expect("pairs");
        state.confirm_records(GATEWAY, &name(1), 10).expect("conf");
        state
            .confirm_thumbnails(GATEWAY, &name(1), 11)
            .expect("troot");
        state
            .confirm_originals(GATEWAY, &name(1), 12)
            .expect("oroot");
        state.set_generation(GATEWAY, 7).expect("generation");
    }
    let state = DeviceState::open(&path).expect("reopens");
    let gateway = state.gateway(GATEWAY).expect("reads").expect("there");
    assert_eq!(gateway.conf, Some((name(1), 10)));
    assert_eq!(gateway.troot, Some((name(1), 11)));
    assert_eq!(gateway.oroot, Some((name(1), 12)));
    assert_eq!(gateway.generation, 7);

    // The same writer pairs again (an address moved): what it confirmed is kept.
    let mut again = paired(GATEWAY, 1);
    again.addrs = vec!["10.0.0.9:7443".to_owned()];
    state.add_gateway(&again).expect("repairs");
    let kept = state.gateway(GATEWAY).expect("reads").expect("there");
    assert_eq!(kept.addrs, vec!["10.0.0.9:7443".to_owned()]);
    assert_eq!(kept.conf, Some((name(1), 10)));

    // A takeover is the next epoch: nothing confirmed under the last one is believed.
    state.add_gateway(&paired(GATEWAY, 2)).expect("a new epoch");
    let moved = state.gateway(GATEWAY).expect("reads").expect("there");
    assert_eq!(
        (moved.conf, moved.troot, moved.oroot, moved.generation),
        (None, None, None, 0)
    );

    state.confirm_records(GATEWAY, &name(2), 20).expect("conf");
    state.withdraw(GATEWAY).expect("withdraws");
    let withdrawn = state.gateway(GATEWAY).expect("reads").expect("there");
    assert!(withdrawn.conf.is_none() && withdrawn.troot.is_none() && withdrawn.oroot.is_none());
}

#[test]
fn a_file_that_is_not_ours_or_is_newer_is_refused() {
    let dir = tempfile::tempdir().expect("a temp dir");
    let other = dir.path().join("other.db");
    Connection::open(&other)
        .expect("opens")
        .execute_batch("PRAGMA application_id = 1234; CREATE TABLE t (a)")
        .expect("founds");
    assert!(matches!(
        DeviceState::open(&other),
        Err(PlaneError::Invariant { .. })
    ));

    let newer = dir.path().join("newer.db");
    drop(DeviceState::open(&newer).expect("founds"));
    Connection::open(&newer)
        .expect("opens")
        .pragma_update(None, "user_version", 2)
        .expect("a later rung");
    assert!(DeviceState::open(&newer).is_err());
}

#[test]
fn the_node_cache_keeps_and_forgets_by_name() {
    let (_dir, state) = open();
    for seed in 1..=5 {
        state.put_node(&name(seed), &[seed]).expect("puts");
    }
    state.put_node(&name(1), &[1]).expect("idempotent");
    assert_eq!(state.node_count().expect("count"), 5);
    let keep = [name(2), name(4)].into_iter().collect();
    assert_eq!(state.forget_nodes_except(&keep).expect("forgets"), 3);
    assert_eq!(state.node_count().expect("count"), 2);
    assert_eq!(state.get_node(&name(2)).expect("reads"), Some(vec![2]));
    assert_eq!(state.get_node(&name(1)).expect("reads"), None);
}

#[test]
fn the_device_row_and_staged_rows_and_undone_names_round_trip() {
    let (_dir, state) = open();
    assert_eq!(state.device().expect("row"), Device::default());
    let device = Device {
        newest: Some((name(9), 55)),
        since_full: 2,
        full_ms: Some(40),
        carry: vec![1, 7, 70_000],
    };
    state.set_device(&device).expect("writes");
    assert_eq!(state.device().expect("row"), device);

    state.stage(&name(3), "/tmp/a", 10).expect("stages");
    state.stage(&name(3), "/tmp/b", 11).expect("restages");
    assert_eq!(
        state.staged(&name(3)).expect("row").expect("there").size,
        11
    );
    assert_eq!(state.staged_all().expect("all").len(), 1);
    state.unstage(&name(3)).expect("unstages");
    assert!(state.staged(&name(3)).expect("row").is_none());

    state.add_gateway(&paired(GATEWAY, 1)).expect("pairs");
    state
        .undone_add(GATEWAY, &[name(4), name(5)], 1_000)
        .expect("undone");
    assert_eq!(state.undone_names(GATEWAY, 999).expect("names").len(), 2);
    assert!(
        state
            .undone_names(GATEWAY, 1_000)
            .expect("lapsed")
            .is_empty()
    );
}

#[test]
fn local_bytes_keep_the_blobs_doors_contract() {
    let (_dir, state) = open();
    let h = PlaintextHash::of(b"a photo in the library");
    state
        .put_local(&LocalBytes {
            hash: h,
            source: LocalSource::Os,
            os_ref: Some("ph://1".to_owned()),
            edited: true,
        })
        .expect("records");
    assert_eq!(
        state
            .local(&h)
            .expect("reads")
            .expect("there")
            .os_ref
            .as_deref(),
        Some("ph://1")
    );
    assert!(
        state
            .put_local(&LocalBytes {
                hash: h,
                source: LocalSource::Store,
                os_ref: Some("x".to_owned()),
                edited: false,
            })
            .is_err()
    );
    state.forget_local(&h).expect("forgets");
    assert!(state.local(&h).expect("reads").is_none());
}

#[test]
fn the_budget_is_the_smaller_of_512_mib_and_a_tenth_of_free_space() {
    assert_eq!(staging::budget_for(1_000), 100);
    assert_eq!(
        staging::budget_for(100 * 1024 * 1024 * 1024),
        staging::BUDGET_CEILING
    );
    assert_eq!(staging::BUDGET_CEILING, 512 * 1024 * 1024);
}

#[test]
fn staging_refuses_past_its_budget_and_a_name_is_whole_or_absent() {
    let dir = tempfile::tempdir().expect("a temp dir");
    let staging = Staging::open(dir.path().join("s"), 100).expect("opens");
    staging.put(&name(1), &[0; 60]).expect("fits");
    assert_eq!(staging.used().expect("used"), 60);
    assert!(matches!(
        staging.put(&name(2), &[0; 60]),
        Err(PlaneError::StagingFull)
    ));
    assert!(
        staging.get(&name(2)).expect("reads").is_none(),
        "nothing half-written is named"
    );
    // The same name is the same bytes: staged again, nothing changes.
    staging.put(&name(1), &[0; 60]).expect("again");
    assert_eq!(staging.used().expect("used"), 60);
    staging.release(&name(1)).expect("releases");
    staging.release(&name(1)).expect("absent is fine");
    staging.put(&name(2), &[0; 60]).expect("fits now");
    assert_eq!(staging.names().expect("names"), vec![name(2)]);
}

#[test]
fn a_crash_between_fsync_and_rename_leaves_only_a_partial_which_open_sweeps() {
    let dir = tempfile::tempdir().expect("a temp dir");
    let path = dir.path().join("s");
    {
        let staging = Staging::open(&path, 1_000).expect("opens");
        staging.put(&name(1), b"whole").expect("a whole file");
        // The crash: the partial is written and fsynced, the rename never happens.
        let partial = staging.write_partial(&name(2), b"half").expect("a partial");
        assert!(partial.exists());
        assert!(
            staging.get(&name(2)).expect("reads").is_none(),
            "the name is absent"
        );
        assert_eq!(staging.used().expect("used"), 5, "a partial does not count");
    }
    let reopened = Staging::open(&path, 1_000).expect("reopens");
    assert!(
        std::fs::read_dir(&path).expect("lists").all(|entry| !entry
            .expect("entry")
            .file_name()
            .to_string_lossy()
            .ends_with(".part")),
        "no partial survives an open"
    );
    assert_eq!(
        reopened.get(&name(1)).expect("reads").as_deref(),
        Some(&b"whole"[..])
    );
    assert!(reopened.get(&name(2)).expect("reads").is_none());
}
