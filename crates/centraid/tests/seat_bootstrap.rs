//! A REPLICA'S WHOLE LIFE, against the shipped gateway (#1025 S1).
//!
//! Unpaired → pairing → bootstrapping → tailing → behind-the-floor →
//! bootstrapping again. Every step over QUIC against `centraid gateway`, with
//! no file placed by anything but the product: until this slice the only way a
//! phone had a replica was `mobile/scripts/demo-vault.sh` copying a
//! GATEWAY-role artifact into the container, which is not a replica and never
//! was one.
//!
//! ## What this proves that no unit test can
//!
//! 1. **A seat with no file is a state, not a failure.** `Core::open` answers a
//!    handle; `with_vault` refuses `Unpaired`; nothing has founded an empty
//!    vault behind the member's back.
//! 2. **Bootstrap is a blob.** The gateway builds a `VACUUM INTO` snapshot of
//!    the replicated tables, puts it in its byte store, and answers `{hash,
//!    seq}` on the seat lane's ONE stream. The seat fetches it over the byte
//!    lane and installs it. No schema walk from seq 0 — the log has a floor and
//!    that walk was a lie.
//! 3. **Under the floor is the same path again.** The gateway commits, prunes
//!    its log past the seat's cursor, and refuses the cursor. The seat takes
//!    the current artifact.
//! 4. **THE QUEUE SURVIVES THE SWAP, IN ORDER.** The outbox row queued before
//!    the re-bootstrap is still there afterwards with its `created_order`
//!    unchanged. Renumbering the queue would reorder the member's work; losing
//!    it would lose a write the member was told was saved.
//! 5. **And the copy really is the gateway's.** The replicated rows on the seat
//!    are the rows on the gateway, compared row by row rather than counted.

use std::io::{BufRead as _, BufReader};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::time::Duration;

use centraid_core::link::SyncWindow;
use centraid_seat::sync::NoChanges;
use centraid_seat_link::SeatLink;

const READY_LINE: &str = "centraid gateway ready";

/// The window a background refresh gets: a real deadline and a metered budget,
/// which is what a phone actually hands the core (#1025 S2).
///
/// Generous enough that nothing in these tests is a race, and finite so that a
/// pass which cannot reach the gateway returns rather than hanging the suite.
fn a_short_refresh() -> SyncWindow {
    let short = centraid_blobs::Budget::short_refresh();
    SyncWindow {
        deadline: Duration::from_secs(60),
        budget_bytes: Some(short.bytes),
        budget_items: Some(short.items),
        budget: centraid_core::link::SyncBudget::ShortRefresh,
        // NOT METERED: these tests move originals on purpose. The metered
        // window is proved where it belongs, in `crates/blobs`'s planner.
        metered: false,
        // AND THE DEFAULT TRANSFER RULE, with no member tap and no tail: the
        // rule's own table and the one-item fetch are proved in
        // `crates/blobs`, not over a live gateway (#1025 S4, S5).
        ..SyncWindow::unbounded()
    }
}

struct Gateway(Child);

impl Drop for Gateway {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

/// Spawn the shipped binary and read back its ticket.
///
/// The stdout reader drains for the whole run: a reader that stopped at the
/// ticket would close the pipe under the gateway's next `println!`, and a
/// failed stdout write panics its main thread (`tests/seat_lane.rs` records the
/// whole trap).
fn start_gateway(data_dir: &std::path::Path) -> Option<(Gateway, String)> {
    let mut child = Command::new(env!("CARGO_BIN_EXE_centraid"))
        .arg("gateway")
        .arg("--data-dir")
        .arg(data_dir)
        .arg("--print-qr")
        .arg("--no-relay")
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("the gateway binary runs");
    let stdout = child.stdout.take().expect("piped");
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut ready = false;
        let mut sent = false;
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if line.starts_with(READY_LINE) {
                ready = true;
            }
            if let Some(encoded) = line.strip_prefix("ticket ")
                && ready
                && !sent
            {
                sent = true;
                let _ = tx.send(encoded.trim().to_owned());
            }
        }
    });
    match rx.recv_timeout(Duration::from_secs(30)) {
        Ok(encoded) => Some((Gateway(child), encoded)),
        Err(_) => None,
    }
}

/// The gateway's vault file, found the way the gateway itself found it.
fn gateway_vault(data_dir: &std::path::Path) -> std::path::PathBuf {
    let vaults = data_dir.join("vault");
    let mut found = None;
    for entry in std::fs::read_dir(&vaults)
        .expect("the vault directory is there")
        .flatten()
    {
        let candidate = entry.path().join("vault.db");
        if candidate.is_file() {
            found = Some(candidate);
        }
    }
    found.expect("the gateway founded a vault")
}

/// Write `count` parties on the gateway, through the real command plane.
///
/// A SECOND CONNECTION TO A LIVE FILE, which is what WAL is for: the gateway
/// holds no exclusive lock and this is the only way a test can move a running
/// gateway's log without a write path from the seat (which is S2's).
fn commit_parties(vault_path: &std::path::Path, label: &str, count: usize) {
    let vault = centraid_vault::Vault::open(vault_path).expect("the gateway's vault opens");
    let registry =
        centraid_vault::commands::Registry::with_system_commands().expect("the catalogue builds");
    let principal = centraid_vault::Principal::owner("bootstrap-test");
    for index in 0..count {
        vault
            .execute(
                &registry,
                &principal,
                &centraid_vault::commands::Command::new(
                    "core.add_party",
                    serde_json::json!({
                        "display_name": format!("{label} {index}"),
                        "kind": "person"
                    }),
                ),
            )
            .expect("the party is added");
    }
    vault.close().expect("the second connection closes");
}

/// Collect the replicated rows this test compares across the two files.
///
/// Through `centraid_vault`'s test door, ordered by id, because the comparison
/// is row for row: two copies holding the right NUMBER of the wrong rows is
/// exactly the failure this assertion exists to catch.
fn parties(connection: &rusqlite::Connection) -> Vec<(String, String)> {
    centraid_vault::testdoor::parties(connection)
}

fn cursor(connection: &rusqlite::Connection) -> i64 {
    centraid_seat::state::seat_state(connection)
        .expect("a bootstrapped replica has a position")
        .applied_seq
}

/// A queued write, the shape the outbox stores one in.
fn queued(id: &str) -> centraid_seat::IntentRecord {
    centraid_seat::IntentRecord {
        intent_id: id.to_owned(),
        created_order: 0,
        app_id: "core".to_owned(),
        action: "add_party".to_owned(),
        input: serde_json::json!({ "display_name": "Queued Offline", "kind": "person" }),
        payload_hash: "b".repeat(64),
        state: centraid_seat::IntentState::Queued,
        attempts: 0,
        depends_on: Vec::new(),
        base_versions: Vec::new(),
        optimistic: None,
        commit_seq: None,
        waiting_on: Vec::new(),
        needs_blobs: Vec::new(),
        enqueued_at: "2026-01-01T00:00:00.000Z".to_owned(),
        updated_at: "2026-01-01T00:00:00.000Z".to_owned(),
        reason: None,
        conflicts: Vec::new(),
        online_only: false,
    }
}

#[test]
fn a_seat_bootstraps_from_a_blob_tails_falls_under_the_floor_and_keeps_its_queue() {
    let gateway_dir = tempfile::tempdir().expect("a temp dir");
    let seat_dir = tempfile::tempdir().expect("a temp dir");

    let Some((_gateway, encoded)) = start_gateway(gateway_dir.path()) else {
        panic!("the gateway printed no ticket within 30s");
    };
    let vault_path = gateway_vault(gateway_dir.path());

    // ---- 1. UNPAIRED -------------------------------------------------------
    let replica_path = seat_dir.path().join("replica.db");
    let link = SeatLink::start(&replica_path, "1.0.0-test").expect("the seat's endpoint binds");
    assert!(
        !replica_path.exists(),
        "a seat was given a file it never asked for"
    );
    assert!(!link.is_bootstrapped());

    // ---- 2. PAIR AND BOOTSTRAP --------------------------------------------
    let paired = link
        .pair(&encoded, "Bootstrap Seat", "ios")
        .expect("the gateway admitted this device");
    // THE OFFER CAME WITH THE PAIRING (#1025 S7, item 5). There is no
    // `snapshot_head` request any more: a device that is told it is enrolled is
    // told in the same breath which blob to take.
    let offer = paired
        .snapshot
        .clone()
        .expect("the pairing named a bootstrap blob");
    assert!(offer.bytes > 0, "the offer named no size to check room for");
    let landing = link
        .bootstrap(&offer, true)
        .expect("the snapshot blob lands");
    assert_eq!(landing.seq, offer.seq);
    assert!(replica_path.exists(), "the bootstrap left no file");
    // AND THE PAIRING IS IN THE FILE, written by the transaction that adopted
    // it. Before this it was written afterwards by the core, which meant a
    // pairing whose first copy did not land was one that did not survive a
    // relaunch.
    {
        let fresh = rusqlite::Connection::open(&replica_path).expect("the replica opens");
        let record = centraid_seat::paired_gateway(&fresh)
            .expect("the pairing table reads")
            .expect("the adoption wrote the pairing record");
        assert_eq!(record.vault_id, paired.vault_id);
    }

    let replica = rusqlite::Connection::open(&replica_path).expect("the replica opens");
    let after_bootstrap = cursor(&replica);
    assert!(
        after_bootstrap > 0,
        "the artifact's cursor is at zero, which is the seq-0 walk this slice deleted"
    );

    // ---- 3. TAIL A COMMIT --------------------------------------------------
    commit_parties(&vault_path, "Tailed", 3);
    let tailed = link.sync(&replica, a_short_refresh(), &NoChanges);
    assert!(
        tailed.reached_the_gateway(),
        "the tailing pass never reached the gateway: {:?}",
        !tailed.reached_the_gateway()
    );
    assert!(
        tailed.rows_applied() > 0,
        "three commits landed on the gateway and the seat applied none: {:?}",
        tailed.rows.skipped()
    );
    let tailing_cursor = cursor(&replica);
    assert!(
        tailing_cursor > after_bootstrap,
        "the cursor did not advance"
    );

    // ---- 4. QUEUE A WRITE --------------------------------------------------
    // The one thing the gateway has never heard of, and the thing a
    // re-bootstrap must not touch.
    let order = centraid_seat::Outbox::open(&replica)
        .expect("the queue is there")
        .enqueue(
            &queued("intent-across-the-swap"),
            "2026-01-01T00:00:00.000Z",
        )
        .expect("the write queues");
    // NOTHING MAY HOLD THE FILE OPEN ACROSS THE SWAP: the install is a rename,
    // and a connection that survived it would read an inode nothing else can
    // see. The core closes its vault around a bootstrap for this reason.
    drop(replica);

    // ---- 5. FALL UNDER THE FLOOR ------------------------------------------
    commit_parties(&vault_path, "Missed", 4);
    let floor = {
        let vault = centraid_vault::Vault::open(&vault_path).expect("the vault opens");
        // TEN YEARS ON. The prune keeps rows by age and holds the floor at any
        // LIVE seat cursor inside the hold window; a far-future clock expires
        // both, which is how a test reproduces a phone that was away longer
        // than the log is kept without waiting for it.
        let far_future = centraid_vault::clock::Clock::now_ms(&centraid_vault::clock::SystemClock)
            + 10 * 365 * 86_400_000;
        let outcome = centraid_vault::log::door::prune(&vault, far_future).expect("the log prunes");
        vault.close().expect("the vault closes");
        outcome.floor
    };
    assert!(
        floor > tailing_cursor,
        "the prune left the floor at {floor}, which the seat's cursor {tailing_cursor} can still be served from"
    );

    let refused = {
        let replica = rusqlite::Connection::open(&replica_path).expect("the replica opens");
        let report = link.sync(&replica, a_short_refresh(), &NoChanges);
        assert!(report.reached_the_gateway());
        report
    };
    assert!(
        refused.rebootstrap.is_some(),
        "a cursor below the floor was not refused: {:?}",
        refused.rows.skipped()
    );

    // ---- 6. AND THE SAME PATH AGAIN ---------------------------------------
    // THE BLOB IS NAMED BY THE REFUSAL (#1025 S7, item 5), which is the other
    // message that tells a device to take a copy.
    let told = refused
        .rebootstrap
        .as_ref()
        .expect("a refusal")
        .snapshot
        .clone()
        .expect("the refusal named a fresh blob");
    link.bootstrap(&told, true).expect("the second copy lands");

    let replica = rusqlite::Connection::open(&replica_path).expect("the new replica opens");
    // Through `centraid_seat`'s test door: the outbox is that crate's table.
    // The ORDER is part of the answer — renumbering the queue across a swap
    // reorders the member's work, which is what this asserts.
    assert_eq!(
        centraid_seat::testdoor::queued_intents(&replica),
        vec![("intent-across-the-swap".to_owned(), order)],
        "the queued write did not cross the swap with its order intact"
    );

    // ---- 7. AND THE COPY IS THE GATEWAY'S ---------------------------------
    let after = link.sync(&replica, a_short_refresh(), &NoChanges);
    assert!(after.reached_the_gateway());
    assert!(
        after.rebootstrap.is_none(),
        "the fresh copy was refused too: {:?}",
        after.rebootstrap
    );

    let gateway_rows = {
        let vault = centraid_vault::Vault::open(&vault_path).expect("the vault opens");
        let rows = vault
            .read(|connection| Ok(parties(connection)))
            .expect("the gateway reads");
        vault.close().expect("the vault closes");
        rows
    };
    assert_eq!(
        parties(&replica),
        gateway_rows,
        "the replica's replicated rows are not the gateway's"
    );
    assert!(
        gateway_rows.len() >= 7,
        "the fixture wrote seven parties and the gateway holds {}",
        gateway_rows.len()
    );
}

/// THE CORE IS WHERE THE LIFECYCLE LIVES, and an unpaired seat is a handle.
///
/// `Core::open` on a seat path with no file used to be `VaultError::Missing`,
/// so a shell could not open a core at all until something else had put a file
/// there — which is why a script was putting one there. It now opens, refuses
/// reads with a state, and pairing creates the replica.
#[test]
fn an_unpaired_core_opens_refuses_reads_and_is_paired_into_a_replica() {
    use centraid_core::{Core, CoreConfig, CoreError};

    let gateway_dir = tempfile::tempdir().expect("a temp dir");
    let seat_dir = tempfile::tempdir().expect("a temp dir");
    let Some((_gateway, encoded)) = start_gateway(gateway_dir.path()) else {
        panic!("the gateway printed no ticket within 30s");
    };

    let replica_path = seat_dir.path().join("replica.db");
    let handle = Core::open(CoreConfig::replicated_seat(&replica_path))
        .expect("a seat with no file opens; it is unpaired, not broken");
    assert!(!handle.holds_a_replica());
    let refusal = handle
        .with_vault(|_| Ok(()))
        .expect_err("an unpaired seat has nothing to read");
    assert!(
        matches!(refusal, CoreError::Unpaired),
        "an unpaired seat refused with {refusal:?} instead of saying it has no copy"
    );
    // AND NOTHING WAS FOUNDED. A core that quietly created an empty vault here
    // would be a product that opens and shows an empty library over a full one.
    assert!(!replica_path.exists());

    let link = SeatLink::start(&replica_path, "1.0.0-test").expect("the seat's endpoint binds");
    handle.attach_network(Box::new(link));

    let request = centraid_api_proto::core_v1::Request {
        kind: Some(centraid_api_proto::core_v1::request::Kind::Pair(
            centraid_api_proto::core_v1::PairRequest {
                code: encoded.into_bytes(),
                device_name: "Core Seat".to_owned(),
                platform: "ios".to_owned(),
                ..Default::default()
            },
        )),
    };
    handle.call(&request).expect("the pairing is answered");

    // PAIRING CREATED THE REPLICA. Not a script, not a sync pass that happened
    // to lay a schema down: the pairing took a copy.
    assert!(
        handle.holds_a_replica(),
        "pairing left this seat with no copy"
    );
    handle
        .with_vault(|vault| {
            let vaults = vault
                .read(|connection| Ok(centraid_vault::testdoor::vault_rows(connection)))
                .expect("the replicated schema reads");
            assert_eq!(vaults, 1, "the copy carries no vault row");
            Ok(())
        })
        .expect("a bootstrapped seat reads");
}

/// A ROW THAT ARRIVES WAKES THE SHELL (#1025 S5).
///
/// `centraid_core::EventQueue` was built in #1020, bounded, coalescing, tested
/// to its cap, and drained by `Handle::next_event` — and **nothing in the
/// repository ever pushed a change event**. A shell that waited for a row to
/// land waited forever, which is why every screen was a poll or a lie.
///
/// The whole path is real: the shipped gateway over QUIC, a commit made through
/// the real command plane, `Handle::sync_now` running the real pass, the real
/// applier, and the event coming out of the same `next_event` a phone calls.
#[test]
fn a_row_applied_by_a_pass_comes_out_of_next_event_naming_its_key() {
    use centraid_api_proto::core_v1 as wire;
    use centraid_core::{Core, CoreConfig};

    let gateway_dir = tempfile::tempdir().expect("a temp dir");
    let seat_dir = tempfile::tempdir().expect("a temp dir");
    let Some((_gateway, encoded)) = start_gateway(gateway_dir.path()) else {
        panic!("the gateway printed no ticket within 30s");
    };
    let vault_path = gateway_vault(gateway_dir.path());

    let replica_path = seat_dir.path().join("replica.db");
    let handle = Core::open(CoreConfig::replicated_seat(&replica_path)).expect("an unpaired seat");
    handle.attach_network(Box::new(
        SeatLink::start(&replica_path, "1.0.0-test").expect("the seat's endpoint binds"),
    ));
    handle
        .call(&centraid_api_proto::core_v1::Request {
            kind: Some(centraid_api_proto::core_v1::request::Kind::Pair(
                centraid_api_proto::core_v1::PairRequest {
                    code: encoded.into_bytes(),
                    device_name: "Event Seat".to_owned(),
                    platform: "ios".to_owned(),
                    ..Default::default()
                },
            )),
        })
        .expect("the pairing is answered");
    assert!(handle.holds_a_replica(), "pairing took no copy");

    // DRAIN WHAT THE BOOTSTRAP'S OWN CATCH-UP PRODUCED. The interesting
    // assertion is about a row committed AFTER this seat was current, so
    // everything before it is cleared out first rather than matched loosely.
    let mut caught_up = handle
        .sync_now(a_short_refresh())
        .expect("a pass on a paired seat");
    assert!(
        caught_up.reached_the_gateway(),
        "the first pass never reached"
    );
    while handle
        .next_event(Duration::from_millis(50))
        .expect("the queue answers")
        .is_some()
    {}

    // ---- THE ROW ----------------------------------------------------------
    commit_parties(&vault_path, "Woken", 1);
    caught_up = handle.sync_now(a_short_refresh()).expect("a second pass");
    assert!(
        caught_up.rows_applied() > 0,
        "the party committed on the gateway never reached the seat: {caught_up:?}"
    );

    // The party's own id, read off the replica, so the event's key is compared
    // against the row that actually landed rather than against a guess.
    let landed: String = handle
        .with_vault(|vault| {
            vault
                .read(|connection| Ok(parties(connection)))
                .map_err(centraid_core::CoreError::from)
        })
        .expect("the replica reads")
        .into_iter()
        .find_map(|(id, name)| (name == "Woken 0").then_some(id))
        .expect("the replica holds the row that arrived");

    let mut found = None;
    // A HANDFUL OF DRAINS, not one: the pass may have applied more than one
    // table — the log carries the gateway's own bookkeeping rows too — and the
    // queue holds one event per table.
    for _ in 0..16 {
        let Some(event) = handle
            .next_event(Duration::from_millis(500))
            .expect("the queue answers")
        else {
            break;
        };
        if let Some(wire::event::Kind::Change(change)) = event.kind
            && change.table == "core_party"
        {
            found = Some(change);
            break;
        }
    }
    let change = found.expect("no change event named `core_party` after the row arrived");
    assert!(
        change.commit_seq > 0,
        "a change event carried no commit seq, so no overlay could ever clear against it"
    );
    // THE KEY, NOT A COUNT. A wake that named the table and not the row would
    // make every arrival a full re-read of the table.
    let named: Vec<String> = change
        .pk_set
        .iter()
        .filter_map(
            |key| match key.values.first().and_then(|one| one.kind.as_ref()) {
                Some(wire::value::Kind::Text(text)) => Some(text.clone()),
                _ => None,
            },
        )
        .collect();
    assert!(
        named.contains(&landed),
        "the change event named {named:?} and the row that arrived is {landed}"
    );
}

/// THE SAME DEVICE AFTER A RELAUNCH (#1025 S5).
///
/// S1 and S2 both recorded the defect in the same words: the endpoint keypair
/// was minted per open and never persisted, so a relaunched seat presented an
/// endpoint id its gateway had never enrolled and was refused at admission.
/// Pairing again was the only remedy, and every relaunch needed it.
///
/// **AND THE PAIRING IS DURABLE TOO** (#1025 S5, second half). A durable key is
/// a durable identity for a seat that does not know who to present it to: the
/// pairing record lived in `SeatLink`'s own memory, `SeatLink::sync` refuses
/// outright without one, and `adopt()`'s only caller in the whole repository
/// was **this test, calling it by hand** — which is exactly what hid it. The
/// simulator found it: a relaunched seat answered "unreachable" and the
/// gateway's log showed no connection attempt at all. The hand-written `adopt`
/// is gone from this test, and a reopen now works because the record is in the
/// replica.
///
/// Three opens over ONE replica against ONE live gateway:
///
/// 1. open with a supplied key, pair **through `Handle`**, sync;
/// 2. close, open again with the same key and **nothing else** — no `adopt`, no
///    second ticket, no gateway address handed in by the test: the same
///    endpoint id, still enrolled, and a commit made in between arrives;
/// 3. open with NO key: a different endpoint id — the first defect,
///    reproduced, so neither fix can quietly stop mattering.
#[test]
fn a_seat_reopened_with_the_same_endpoint_key_is_still_the_device_its_gateway_enrolled() {
    use centraid_core::{Core, CoreConfig};

    let gateway_dir = tempfile::tempdir().expect("a temp dir");
    let seat_dir = tempfile::tempdir().expect("a temp dir");
    let Some((_gateway, encoded)) = start_gateway(gateway_dir.path()) else {
        panic!("the gateway printed no ticket within 30s");
    };
    let vault_path = gateway_vault(gateway_dir.path());
    let replica_path = seat_dir.path().join("replica.db");

    // THE SHELL'S SECURE STORE, as a constant. What a Keychain or a Keystore
    // hands back; this crate neither mints it nor writes it anywhere.
    let secret = [7u8; 32];

    // ---- 1. OPEN, PAIR, SYNC ----------------------------------------------
    let first_identity = {
        let handle =
            Core::open(CoreConfig::replicated_seat(&replica_path).with_endpoint_secret(secret))
                .expect("an unpaired seat opens");
        // THE CORE CARRIES THE KEY TO WHOEVER BUILDS THE LINK, which on a phone
        // is `centraid_core_ffi::centraid_open` and here is this line.
        let link =
            SeatLink::start_with_key(&replica_path, "1.0.0-test", handle.endpoint_secret(), Some(""))
                .expect("the seat's endpoint binds");
        let identity = link.endpoint_id();
        handle.attach_network(Box::new(link));
        // PAIRED THROUGH THE CORE, not by reaching into the link. That is the
        // path a shell takes and it is the path that writes the pairing into
        // the replica; a test that drove `SeatLink::pair` directly would prove
        // nothing about what a reopen finds.
        handle
            .call(&centraid_api_proto::core_v1::Request {
                kind: Some(centraid_api_proto::core_v1::request::Kind::Pair(
                    centraid_api_proto::core_v1::PairRequest {
                        code: encoded.clone().into_bytes(),
                        device_name: "Relaunched Seat".to_owned(),
                        platform: "ios".to_owned(),
                        ..Default::default()
                    },
                )),
            })
            .expect("the pairing is answered");
        assert!(handle.holds_a_replica(), "pairing took no copy");
        let outcome = handle.sync_now(a_short_refresh()).expect("a pass");
        assert!(
            outcome.reached_the_gateway(),
            "the first pass never reached"
        );
        handle.close();
        identity
    };

    // A COMMIT WHILE THE SEAT IS NOT RUNNING, which is the case a relaunch is
    // for: the phone was closed and the vault moved on without it.
    commit_parties(&vault_path, "While away", 2);

    // ---- 2. THE SAME KEY IS THE SAME DEVICE -------------------------------
    {
        let handle =
            Core::open(CoreConfig::replicated_seat(&replica_path).with_endpoint_secret(secret))
                .expect("the seat reopens");
        let link =
            SeatLink::start_with_key(&replica_path, "1.0.0-test", handle.endpoint_secret(), Some(""))
                .expect("the seat's endpoint binds");
        assert_eq!(
            link.endpoint_id(),
            first_identity,
            "the same supplied key produced a different device identity"
        );
        // NO `adopt`, NO TICKET, NO ADDRESS. `attach_network` reads the
        // pairing out of the replica and hands it back to the link, which is
        // the whole of what the shell has to do: open and sync.
        handle.attach_network(Box::new(link));
        let outcome = handle
            .sync_now(a_short_refresh())
            .expect("a pass on a relaunched seat");
        assert!(
            outcome.reached_the_gateway(),
            "a reopened seat did not reach its gateway: it dialled nothing, \
             because it remembered nothing"
        );
        assert!(
            outcome.rows_applied() > 0,
            "the commits made while this seat was away never arrived: it was not served"
        );
        handle.close();
    }

    // ---- 3. AND NO KEY IS A DIFFERENT DEVICE ------------------------------
    // The defect, reproduced. Without it this test would still pass on a build
    // that ignored the key and enrolled every stranger.
    let stranger = SeatLink::start(seat_dir.path().join("stranger.db"), "1.0.0-test")
        .expect("the seat's endpoint binds");
    assert_ne!(
        stranger.endpoint_id(),
        first_identity,
        "a seat that supplied no key minted the same identity twice"
    );
}
