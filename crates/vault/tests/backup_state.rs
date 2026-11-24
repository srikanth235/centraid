//! The device state and the staging area (spec §6.1, §6.4, #1209, L4): the schema, every
//! constraint the code states written with raw SQL, and the crash a rename leaves behind.
//! Counts and rows, never durations.

use centraid_media::sealed::{Class, Digest, Name, PlaintextHash, Ref};
use centraid_vault::backup::PlaneError;
use centraid_vault::backup::staging::{self, Staging};
use centraid_vault::backup::state::{
    Device, DeviceState, Gateway, GatewayNotesRecord, LocalBytes, LocalSource, STATE_APPLICATION_ID,
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
            "blob_chunk",
            "device",
            "dirty_range",
            "gateway",
            "local_bytes",
            "node",
            "os_bundle",
            "staged",
            "undone"
        ],
        "pairings, what each confirmed, the node cache, staging, the device row, folded dirty ranges, undone names, local bytes, blob chunk refs and OS bundles"
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
    assert_eq!(STATE_APPLICATION_ID, 0x4342_5332);
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
    assert!(refused(c, "UPDATE gateway SET regressed = 2", []));
    assert!(
        refused(c, "UPDATE gateway SET collected_ms = -1", []),
        "collected_ms >= 0"
    );
    assert!(refused(c, "UPDATE gateway SET held_count = -1", []));
    assert!(refused(c, "UPDATE gateway SET held_purge_at_ms = -1", []));
    assert!(
        refused(c, "UPDATE gateway SET damaged_flag = 2", []),
        "damaged_flag is boolean"
    );
    assert!(refused(c, "UPDATE gateway SET sample_checked = -1", []));
    assert!(refused(c, "UPDATE gateway SET manifest_unreadable = 2", []));
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
    assert!(
        refused(c, "UPDATE device SET disk_mark = x'0102'", []),
        "disk_mark is 32 bytes"
    );
    assert!(
        refused(c, "UPDATE device SET exclude_videos = 2", []),
        "exclude_videos is boolean"
    );
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
    // os_bundle
    assert!(
        refused(
            c,
            "INSERT INTO os_bundle (name, path) VALUES ('short', '/tmp/x')",
            []
        ),
        "an os_bundle name is 64 hex"
    );
    assert!(
        refused(
            c,
            "INSERT INTO os_bundle (name, path) VALUES (?1, '')",
            [&hex]
        ),
        "an os_bundle path is non-empty"
    );
    // blob_chunk
    assert!(
        refused(
            c,
            "INSERT INTO blob_chunk (hash, class, idx, name, digest, len) VALUES (?1, 1, 0, ?1, ?1, 100)",
            [&hex]
        ),
        "blob_chunk class is only 2 (Thumbnails) or 3 (Originals)"
    );
    assert!(
        refused(
            c,
            "INSERT INTO blob_chunk (hash, class, idx, name, digest, len) VALUES (?1, 4, 0, ?1, ?1, 100)",
            [&hex]
        ),
        "blob_chunk class rejects out-of-range values"
    );
    assert!(
        refused(
            c,
            "INSERT INTO blob_chunk (hash, class, idx, name, digest, len) VALUES (?1, 2, -1, ?1, ?1, 100)",
            [&hex]
        ),
        "blob_chunk idx >= 0"
    );
    assert!(
        refused(
            c,
            "INSERT INTO blob_chunk (hash, class, idx, name, digest, len) VALUES (?1, 3, 0, ?1, ?1, 0)",
            [&hex]
        ),
        "blob_chunk len > 0"
    );
    // dirty_range
    assert!(
        refused(
            c,
            "INSERT INTO dirty_range (range_index, noted_ms) VALUES (-1, 0)",
            []
        ),
        "dirty_range range_index >= 0"
    );
    assert!(
        refused(
            c,
            "INSERT INTO dirty_range (range_index, noted_ms) VALUES (0, -1)",
            []
        ),
        "dirty_range noted_ms >= 0"
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
fn a_regressed_head_is_kept_until_a_new_head_is_confirmed_there() {
    let (_dir, state) = open();
    state.add_gateway(&paired(GATEWAY, 1)).expect("pairs");
    let flag = |state: &DeviceState| {
        let raw: i64 = state
            .connection()
            .query_row(
                "SELECT regressed FROM gateway WHERE gateway_id = ?1",
                [GATEWAY],
                |row| row.get(0),
            )
            .expect("the column");
        let read = state.gateway(GATEWAY).expect("reads").expect("there");
        assert_eq!(read.regressed, raw == 1, "the row and the column agree");
        read.regressed
    };
    assert!(!flag(&state), "a pairing has gone backwards from nothing");
    state.confirm_records(GATEWAY, &name(1), 10).expect("conf");
    state.set_regressed(GATEWAY, true).expect("flags");
    assert!(flag(&state));
    // A recovery drops what was confirmed; the claim that it went backwards stays.
    state.withdraw(GATEWAY).expect("withdraws");
    assert!(flag(&state), "withdrawing is not a new head");
    // The same writer pairing again keeps it; a new writer epoch is a new ask.
    state.add_gateway(&paired(GATEWAY, 1)).expect("repairs");
    assert!(flag(&state));
    state.confirm_records(GATEWAY, &name(2), 20).expect("conf");
    assert!(!flag(&state), "a new confirmed head clears it");
    state.set_regressed(GATEWAY, true).expect("flags");
    state.add_gateway(&paired(GATEWAY, 2)).expect("a new epoch");
    assert!(!flag(&state), "a new epoch forgets it");
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
    assert!(!state.exclude_videos().expect("default"));
    state.set_exclude_videos(true).expect("sets");
    assert!(state.exclude_videos().expect("true"));
    state.set_exclude_videos(false).expect("clears");
    assert!(!state.exclude_videos().expect("false"));

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

#[test]
fn os_bundles_persist_across_reopen_and_rotate_by_set_difference() {
    use std::path::PathBuf;
    let dir = tempfile::tempdir().expect("a temp dir");
    let db = dir.path().join("v.state.db");
    let p1 = PathBuf::from("/tmp/bundle-1");
    let p2 = PathBuf::from("/tmp/bundle-2");
    let p3 = PathBuf::from("/tmp/bundle-3");
    {
        let state = DeviceState::open(&db).expect("opens");
        state
            .put_os_bundle(&name(1), "/tmp/bundle-1")
            .expect("puts");
        let gone = state
            .rotate_os_bundles(&[(name(1), p1.clone()), (name(2), p2.clone())])
            .expect("rotates");
        assert!(gone.is_empty(), "p1 is still in current: {gone:?}");
    }
    let state = DeviceState::open(&db).expect("reopens");
    assert_eq!(
        state.os_bundles().expect("lists"),
        vec![(name(1), p1.clone()), (name(2), p2.clone())]
    );
    // Rotating with overlapping p2 and new p3 retires only p1.
    let gone = state
        .rotate_os_bundles(&[(name(2), p2.clone()), (name(3), p3.clone())])
        .expect("rotates");
    assert_eq!(gone, vec![p1]);
    // Rotating to empty retires p2 and p3.
    let mut gone = state.rotate_os_bundles(&[]).expect("clears");
    gone.sort();
    assert_eq!(gone, vec![p2, p3]);
    assert!(state.os_bundles().expect("empty").is_empty());
}

#[test]
fn gateway_notes_blob_chunks_and_dirty_ranges_round_trip() {
    let (_dir, state) = open();
    // Unpaired gateway returns default notes.
    assert_eq!(
        state.gateway_notes(GATEWAY).expect("default"),
        GatewayNotesRecord::default()
    );
    state.add_gateway(&paired(GATEWAY, 1)).expect("pairs");
    let notes = GatewayNotesRecord {
        collected_ms: 123_456,
        held_count: 7,
        held_purge_at_ms: Some(999_000),
        refusal_code: Some(42),
        damaged: true,
        sample_checked: 64,
        manifest_unreadable: true,
    };
    state
        .set_gateway_notes(GATEWAY, &notes)
        .expect("sets notes");
    assert_eq!(state.gateway_notes(GATEWAY).expect("reads notes"), notes);
    assert_eq!(
        state
            .gateway(GATEWAY)
            .expect("gateway")
            .expect("there")
            .notes,
        notes
    );
    // Re-adding the same gateway preserves persisted notes.
    state.add_gateway(&paired(GATEWAY, 1)).expect("re-adds");
    assert_eq!(state.gateway_notes(GATEWAY).expect("kept"), notes);

    // blob_chunk stores Thumbnails and Originals independently and refuses Records.
    let hash = PlaintextHash::of(b"sample media");
    let thumb_ref = Ref {
        name: name(10),
        digest: Digest::of(b"thumb"),
        len: 120,
        class: Class::Thumbnails,
    };
    let orig_ref = Ref {
        name: name(11),
        digest: Digest::of(b"orig"),
        len: 4096,
        class: Class::Originals,
    };
    assert!(
        state
            .put_blob_chunks(&hash, Class::Records, &[thumb_ref])
            .is_err(),
        "Class::Records must be refused"
    );
    state
        .put_blob_chunks(&hash, Class::Thumbnails, &[thumb_ref])
        .expect("puts thumb");
    state
        .put_os_chunks(&hash, &[orig_ref])
        .expect("puts os orig");
    assert_eq!(
        state.blob_chunks(&hash, Class::Thumbnails).expect("thumbs"),
        vec![thumb_ref]
    );
    assert_eq!(state.os_chunks(&hash).expect("os"), vec![orig_ref]);
    state.remove_blob_chunks(&hash).expect("removes");
    assert!(
        state
            .blob_chunks(&hash, Class::Thumbnails)
            .expect("empty")
            .is_empty()
    );
    assert!(
        state
            .blob_chunks(&hash, Class::Originals)
            .expect("empty")
            .is_empty()
    );

    // dirty_ranges persist, union across calls, and clear cleanly.
    assert!(state.dirty_ranges().expect("empty").is_empty());
    state.add_dirty_ranges([3_u64, 1], 1_000).expect("adds");
    state.add_dirty_ranges([5_u64, 3], 2_000).expect("adds");
    assert_eq!(
        state.dirty_ranges().expect("ranges"),
        [1_u64, 3, 5].into_iter().collect()
    );
    state.clear_dirty_ranges().expect("clears");
    assert!(state.dirty_ranges().expect("cleared").is_empty());
}
