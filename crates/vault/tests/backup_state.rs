//! The device state of a phone's backup (#1191, E11, B14): the four tables,
//! the ladder, and the reset rules. Counts and rows, never durations.

use centraid_vault::backup::naming::{Digest, Name, PlaintextHash};
use centraid_vault::backup::state::{
    DeviceState, Gateway, LocalBytes, LocalSource, Outbox, OutboxKind, Reach, Waiting,
};
use rusqlite::Connection;

const GATEWAY: &str = "0123456789abcdef0123456789abcdef";
const OTHER: &str = "fedcba9876543210fedcba9876543210";

fn name(seed: u8) -> Name {
    Name::from_hex(&format!("{seed:02x}").repeat(32)).expect("a name")
}

fn digest(seed: u8) -> Digest {
    Digest::from_hex(&format!("{seed:02x}").repeat(32)).expect("a digest")
}

fn paired(id: &str, now: u64) -> Gateway {
    Gateway::paired(
        id.to_owned(),
        vec!["192.168.1.5:7443".to_owned()],
        vec![1, 2, 3],
        "the desk".to_owned(),
        1,
        now,
    )
}

fn open() -> (tempfile::TempDir, DeviceState) {
    let dir = tempfile::tempdir().expect("a temp dir");
    let state = DeviceState::open(dir.path().join("v.state.db")).expect("opens");
    (dir, state)
}

fn part(gateway: &str, seed: u8, kind: OutboxKind, created: u64) -> Outbox {
    Outbox::sealed(
        gateway,
        name(seed),
        kind,
        format!("/spool/{seed}").into(),
        100,
        digest(seed),
        created,
    )
}

#[test]
fn a_gateway_row_round_trips_and_a_pairing_again_starts_clean() {
    let (_dir, state) = open();
    state.put_gateway(&paired(GATEWAY, 10)).expect("paired");
    state
        .record_head(GATEWAY, &name(7), 3, 41, 1_000)
        .expect("a head set");
    state.set_cursor(GATEWAY, 99).expect("cursor");
    state.set_moved(GATEWAY, 4, 50).expect("moved");
    let row = state.gateway(GATEWAY).expect("reads").expect("a row");
    assert_eq!(row.head, Some(name(7)));
    assert_eq!((row.generation, row.writes, row.cursor), (3, 41, 99));
    assert_eq!((row.reach, row.moved_epoch), (Reach::Moved, Some(4)));

    // Paired again (a claim): the row keeps its identity and nothing it knew.
    let mut again = paired(GATEWAY, 60);
    again.epoch = 5;
    state.put_gateway(&again).expect("paired again");
    let row = state.gateway(GATEWAY).expect("reads").expect("a row");
    assert_eq!(row, again);
    assert_eq!(row.moved_epoch, None);
    assert_eq!(state.gateways().expect("lists").len(), 1);
}

#[test]
fn moved_is_one_gateways_mark_and_never_the_others() {
    let (_dir, state) = open();
    state.put_gateway(&paired(GATEWAY, 10)).expect("one");
    state.put_gateway(&paired(OTHER, 11)).expect("two");
    state.set_moved(GATEWAY, 2, 20).expect("moved");
    let reaches: Vec<_> = state
        .gateways()
        .expect("lists")
        .into_iter()
        .map(|row| (row.gateway_id, row.reach))
        .collect();
    assert_eq!(
        reaches,
        vec![
            (GATEWAY.to_owned(), Reach::Moved),
            (OTHER.to_owned(), Reach::Ok)
        ]
    );
    assert!(
        state.set_reach(GATEWAY, Reach::Moved, 21).is_err(),
        "a moved mark needs its claim's epoch"
    );
    state.set_reach(GATEWAY, Reach::Frozen, 22).expect("frozen");
    let row = state.gateway(GATEWAY).expect("reads").expect("a row");
    assert_eq!((row.reach, row.moved_epoch), (Reach::Frozen, None));
}

#[test]
fn the_outbox_is_per_gateway_ordered_and_leaves_when_done() {
    let (_dir, state) = open();
    state.put_gateway(&paired(GATEWAY, 10)).expect("one");
    state.put_gateway(&paired(OTHER, 11)).expect("two");
    state
        .put_outbox_many(&[
            part(GATEWAY, 3, OutboxKind::Manifest, 1),
            part(GATEWAY, 2, OutboxKind::Range, 5),
            part(GATEWAY, 1, OutboxKind::Leaf, 9),
            part(OTHER, 2, OutboxKind::Range, 5),
        ])
        .expect("owed");
    let order: Vec<_> = state
        .outbox(GATEWAY)
        .expect("reads")
        .into_iter()
        .map(|row| row.kind)
        .collect();
    assert_eq!(
        order,
        vec![OutboxKind::Range, OutboxKind::Leaf, OutboxKind::Manifest],
        "the root manifest moves last, whatever its age"
    );
    assert_eq!(state.owed_bytes(GATEWAY).expect("bytes"), 300);
    assert!(state.done(GATEWAY, &name(2)).expect("done"));
    assert!(!state.done(GATEWAY, &name(2)).expect("done twice"));
    assert_eq!(state.outbox(OTHER).expect("reads").len(), 1);
    assert_eq!(
        state.owed_names().expect("names").len(),
        3,
        "the union over gateways: 1, 2 and 3"
    );
}

#[test]
fn an_unsealed_row_waits_and_a_check_refuses_a_row_that_lies() {
    let (_dir, state) = open();
    state.put_gateway(&paired(GATEWAY, 10)).expect("one");
    let mut waiting = Outbox {
        gateway_id: GATEWAY.to_owned(),
        name: name(4),
        kind: OutboxKind::Blob,
        hash: Some(PlaintextHash::of(b"an original")),
        part_path: None,
        waiting: Some(Waiting::Bytes),
        size: None,
        digest: None,
        media_type: Some("image/heic".to_owned()),
        created_ms: 1,
        handed_ms: None,
        attempts: 0,
        last_error: None,
        derivative: false,
    };
    state.put_outbox(&waiting).expect("owed, not yet sealed");
    assert_eq!(state.outbox_waiting(GATEWAY).expect("waits").len(), 1);
    state
        .seal_outbox(GATEWAY, &name(4), "/spool/4".as_ref(), 64, &digest(4))
        .expect("sealed");
    assert!(state.outbox_waiting(GATEWAY).expect("waits").is_empty());
    assert_eq!(
        state
            .outbox_row(GATEWAY, &name(4))
            .expect("reads")
            .expect("a row")
            .part_path,
        Some("/spool/4".into())
    );

    // A blob with no hash, a range with one, a path with no digest: refused.
    waiting.name = name(5);
    waiting.hash = None;
    assert!(state.put_outbox(&waiting).is_err(), "a blob names its hash");
    let mut range = part(GATEWAY, 6, OutboxKind::Range, 1);
    range.hash = Some(PlaintextHash::of(b"x"));
    assert!(state.put_outbox(&range).is_err(), "only a blob has a hash");
    let mut no_digest = part(GATEWAY, 8, OutboxKind::Range, 1);
    no_digest.digest = None;
    assert!(state.put_outbox(&no_digest).is_err(), "a path has a digest");
}

#[test]
fn forgetting_a_gateway_drops_its_outbox_and_nothing_else() {
    let (_dir, state) = open();
    state.put_gateway(&paired(GATEWAY, 10)).expect("one");
    state.put_gateway(&paired(OTHER, 11)).expect("two");
    state
        .put_outbox(&part(GATEWAY, 1, OutboxKind::Range, 1))
        .expect("owed");
    state
        .put_outbox(&part(OTHER, 2, OutboxKind::Range, 1))
        .expect("owed");
    let local = LocalBytes {
        hash: PlaintextHash::of(b"kept"),
        source: LocalSource::Store,
        os_ref: None,
        edited: false,
    };
    state.put_local(&local).expect("local");
    state.remove_gateway(GATEWAY).expect("forgotten");
    assert!(state.outbox(GATEWAY).expect("reads").is_empty());
    assert_eq!(state.outbox(OTHER).expect("reads").len(), 1);
    assert_eq!(state.locals().expect("locals"), vec![local]);
    assert_eq!(
        state.owed_paths().expect("paths").len(),
        1,
        "only the other gateway's spool file is still owed"
    );
}

#[test]
fn restore_in_place_resets_each_gateway_and_empties_the_outbox_and_keeps_local_bytes() {
    let (_dir, state) = open();
    state.put_gateway(&paired(GATEWAY, 10)).expect("one");
    state
        .record_head(GATEWAY, &name(1), 9, 90, 2_000)
        .expect("head");
    state.set_cursor(GATEWAY, 500).expect("cursor");
    state.next_sample_counter(GATEWAY).expect("a draw");
    state.set_reach(GATEWAY, Reach::Busy, 20).expect("busy");
    state.clear_directory_dirty(GATEWAY).expect("clean");
    state
        .put_outbox(&part(GATEWAY, 1, OutboxKind::Range, 1))
        .expect("owed");
    state
        .put_local(&LocalBytes {
            hash: PlaintextHash::of(b"here"),
            source: LocalSource::Os,
            os_ref: Some("asset-1".to_owned()),
            edited: true,
        })
        .expect("local");
    state
        .reset_for_restore(&[(GATEWAY.to_owned(), 7, Some(name(2)))])
        .expect("reset");
    let row = state.gateway(GATEWAY).expect("reads").expect("a row");
    assert_eq!(
        (row.epoch, row.head, row.generation, row.writes, row.cursor),
        (7, Some(name(2)), 0, 0, 0)
    );
    assert_eq!(
        (row.reach, row.sample_counter, row.directory_dirty),
        (Reach::Ok, 0, true)
    );
    assert!(state.outbox(GATEWAY).expect("reads").is_empty());
    assert_eq!(
        state.locals().expect("locals").len(),
        1,
        "about this device"
    );
}

#[test]
fn the_sample_counter_counts_each_draw_once() {
    let (_dir, state) = open();
    state.put_gateway(&paired(GATEWAY, 10)).expect("one");
    let draws: Vec<_> = (0..3)
        .map(|_| state.next_sample_counter(GATEWAY).expect("a draw"))
        .collect();
    assert_eq!(draws, vec![0, 1, 2]);
    assert!(state.next_sample_counter(OTHER).is_err(), "not paired");
}

#[test]
fn the_state_has_four_tables_an_id_and_a_rung_and_no_token_and_no_key_value_table() {
    let (dir, state) = open();
    drop(state);
    let connection = Connection::open(dir.path().join("v.state.db")).expect("opens");
    let mut tables: Vec<String> = connection
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .expect("prepares")
        .query_map([], |row| row.get(0))
        .expect("queries")
        .collect::<Result<_, _>>()
        .expect("rows");
    tables.sort();
    assert_eq!(tables, vec!["gateway", "local_bytes", "outbox", "undone"]);
    let id: i64 = connection
        .query_row("PRAGMA application_id", [], |row| row.get(0))
        .expect("id");
    let rung: i64 = connection
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .expect("rung");
    assert_eq!((id, rung), (0x4342_5331, 1));
    let columns: Vec<String> = connection
        .prepare("SELECT name FROM pragma_table_info('gateway')")
        .expect("prepares")
        .query_map([], |row| row.get(0))
        .expect("queries")
        .collect::<Result<_, _>>()
        .expect("rows");
    assert!(
        !columns.iter().any(|column| column.contains("token")),
        "the token is the shell's (E12): {columns:?}"
    );
}

#[test]
fn a_file_of_another_program_or_a_newer_rung_is_refused_untouched() {
    let dir = tempfile::tempdir().expect("a temp dir");
    let foreign = dir.path().join("foreign.state.db");
    {
        let connection = Connection::open(&foreign).expect("creates");
        connection
            .execute_batch("CREATE TABLE other (x); PRAGMA application_id = 1234;")
            .expect("another program's file");
    }
    assert!(DeviceState::open(&foreign).is_err());

    let newer = dir.path().join("newer.state.db");
    DeviceState::open(&newer).expect("founds");
    {
        let connection = Connection::open(&newer).expect("opens");
        connection
            .pragma_update(None, "user_version", 2)
            .expect("a rung this build does not have");
    }
    let before = std::fs::read(&newer).expect("reads");
    assert!(
        DeviceState::open(&newer).is_err(),
        "a newer rung is refused"
    );
    assert_eq!(std::fs::read(&newer).expect("reads"), before, "untouched");
}

#[test]
fn an_old_ledger_beside_the_vault_is_deleted_without_being_read() {
    let dir = tempfile::tempdir().expect("a temp dir");
    let vault = dir.path().join("v.vault");
    let ledger = DeviceState::old_ledger_path(&vault);
    // Not even a database: a build that read it would fail.
    std::fs::write(&ledger, b"not a database at all").expect("writes");
    std::fs::write(dir.path().join("v.backup.db-wal"), b"x").expect("writes");
    let state = DeviceState::open_beside(&vault).expect("opens");
    assert!(!ledger.exists(), "the old ledger is gone");
    assert!(!dir.path().join("v.backup.db-wal").exists());
    assert_eq!(state.path(), DeviceState::path_for(&vault));
}

#[test]
fn a_batch_of_done_names_costs_one_commit() {
    let (_dir, state) = open();
    state.put_gateway(&paired(GATEWAY, 10)).expect("one");
    let rows: Vec<_> = (1..=20)
        .map(|seed| part(GATEWAY, seed, OutboxKind::Range, 1))
        .collect();
    let before = state.commit_count();
    state.put_outbox_many(&rows).expect("owed");
    assert_eq!(state.commit_count() - before, 1, "twenty rows, one sync");
    let names: Vec<_> = rows.iter().map(|row| row.name).collect();
    let before = state.commit_count();
    state.done_many(GATEWAY, &names).expect("done");
    assert_eq!(state.commit_count() - before, 1);
}

/// **AN UNDO IS NOT UNDONE BY THE NEXT PASS** (E6): the names a member's Undo lifted are kept
/// by retention until their time is up, per gateway, and go with the gateway.
#[test]
fn undone_names_are_kept_until_their_time_and_go_with_the_gateway() {
    let (_dir, state) = open();
    state.put_gateway(&paired(GATEWAY, 1)).expect("pairs");
    state
        .put_undone(GATEWAY, &[name(1), name(2)], 1_000)
        .expect("records");
    assert_eq!(
        state.undone(GATEWAY, 999).expect("reads").len(),
        2,
        "kept before their time"
    );
    assert!(
        state.undone(GATEWAY, 1_000).expect("reads").is_empty(),
        "forgotten at their time"
    );
    state
        .put_undone(GATEWAY, &[name(3)], 5_000)
        .expect("records");
    state.remove_gateway(GATEWAY).expect("forgets");
    state.put_gateway(&paired(GATEWAY, 1)).expect("pairs again");
    assert!(
        state.undone(GATEWAY, 0).expect("reads").is_empty(),
        "a forgotten gateway's undone names go with it"
    );
}
