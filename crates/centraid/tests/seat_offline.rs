//! A SEAT'S REAL LIFE: pair, sync, lose the network, wait, sync again (#1020,
//! D-1020-B6).
//!
//! Every other test in this tree runs a happy path against a live peer. A phone
//! does not have a happy path — it has windows, and between them it is in a
//! lift, on a train, or suspended by an OS that did not ask. So this one spawns
//! the shipped gateway and then takes the network away on purpose.
//!
//! ## "Offline" is the SEAT releasing its socket, not the gateway dying
//!
//! The deliberate choice, and it is the realistic one. `Endpoint::idle` is what
//! a backgrounded phone does: the socket goes, the identity stays, and nothing
//! is told (D-1020-C14). Killing the gateway would test something else and,
//! today, something misleading — the device allowlist is still in memory
//! (D-1020-C8), so a restarted gateway has forgotten every pairing and a seat
//! reconnecting to it would be refused for a reason that has nothing to do with
//! being offline.
//!
//! ## What must be true across the gap
//!
//! 1. A pass with no network **fails as a state, not as an error**: the seat is
//!    stale, and the rows it already has still read.
//! 2. Nothing is lost or rewound. The cursor after the offline pass is exactly
//!    the cursor before it.
//! 3. A pass after the network returns **does not start over**. It asks from
//!    the cursor it kept, and a caught-up seat is told it is caught up.
//! 4. The seat's identity survives the gap, so the gateway still recognises it.
//!    An endpoint that minted a fresh key on resume would be a device the
//!    allowlist has never seen.

use std::io::{BufRead as _, BufReader};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::time::Duration;

use centraid_blobs::Budget;
use centraid_seat_link::SeatLink;

const READY_LINE: &str = "centraid gateway ready";

struct Gateway(Child);

impl Drop for Gateway {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

/// Spawn the shipped binary and read back its ticket. The stdout reader drains
/// for the whole run — a reader that stopped at the ticket would close the pipe
/// under the gateway's next `println!`, and a failed stdout write panics its
/// main thread (`crates/centraid/tests/seat_lane.rs` records the whole trap).
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

fn cursor(connection: &rusqlite::Connection) -> i64 {
    centraid_seat::state::seat_state(connection)
        .expect("a bootstrapped replica has a position")
        .applied_seq
}

#[test]
fn a_seat_survives_losing_the_network_and_picks_up_where_it_left_off() {
    let gateway_dir = tempfile::tempdir().expect("a temp dir");
    let seat_dir = tempfile::tempdir().expect("a temp dir");

    let Some((_gateway, encoded)) = start_gateway(gateway_dir.path()) else {
        panic!("the gateway printed no ticket within 30s");
    };

    let link = SeatLink::start(seat_dir.path().join("blobs"), "1.0.0-test")
        .expect("the seat's runtime and endpoint start");
    let identity_before = link.endpoint_id();

    // The seat's replica: an empty file. `sync` lays the schema down from the
    // header of the first page the gateway serves.
    let replica = rusqlite::Connection::open(seat_dir.path().join("replica.db"))
        .expect("the replica file opens");

    // ---- 1. PAIR -----------------------------------------------------------
    let paired = link
        .pair(&encoded, "Test Seat", "ios")
        .expect("the gateway admitted this device");
    assert!(!paired.vault_id.is_empty(), "the gateway named its vault");

    // ---- 2. THE FIRST WINDOW ----------------------------------------------
    let first = link.sync(&replica, Budget::short_refresh());
    assert!(
        first.reached_the_gateway(),
        "the first pass never reached the gateway: {:?}",
        first.unreachable
    );
    assert!(
        first.rows.stale.is_none(),
        "the row plane was stale on a live link: {:?}",
        first.rows.stale
    );
    assert!(
        first.rows.rows_applied > 0,
        "a founded vault has a vault row and an owner party; none arrived"
    );
    let caught_up = cursor(&replica);
    assert!(caught_up > 0, "the cursor did not move off the floor");

    // THE ROWS ARE REALLY HERE, not merely counted. A replica that reported
    // applying rows into a schema it had not laid down would pass every
    // assertion above.
    let vaults: i64 = replica
        .query_row("SELECT COUNT(*) FROM core_vault", [], |row| row.get(0))
        .expect("the replicated schema is queryable");
    assert_eq!(vaults, 1, "the founding commit's vault row is not here");

    // ---- 3. OFFLINE --------------------------------------------------------
    // What a backgrounded phone does. Nothing is told; the socket is simply
    // gone.
    link.idle();

    let offline = link.sync(&replica, Budget::short_refresh());
    assert!(
        !offline.reached_the_gateway(),
        "a seat with no socket reported reaching the gateway"
    );

    // A STATE, NOT AN ERROR. The rows already here still read, which is the
    // whole promise of a local-first replica.
    let vaults_offline: i64 = replica
        .query_row("SELECT COUNT(*) FROM core_vault", [], |row| row.get(0))
        .expect("an offline replica still reads");
    assert_eq!(vaults_offline, 1);

    // NOTHING REWOUND. A failed pass that reset the cursor would re-apply the
    // whole log on the next one — on every pass, for as long as the seat is
    // offline more often than not.
    assert_eq!(
        cursor(&replica),
        caught_up,
        "the offline pass moved the cursor"
    );

    // ---- 4. WAIT -----------------------------------------------------------
    // Long enough that nothing about this test is a race, and long enough for
    // an idled endpoint to be genuinely down rather than mid-teardown.
    std::thread::sleep(Duration::from_secs(2));

    let still_offline = link.sync(&replica, Budget::short_refresh());
    assert!(!still_offline.reached_the_gateway());
    assert_eq!(cursor(&replica), caught_up, "waiting moved the cursor");

    // ---- 5. BACK ON --------------------------------------------------------
    link.resume().expect("the endpoint binds again");

    // THE IDENTITY SURVIVED. It is the public half of a secret key that was
    // never dropped, so the gateway's allowlist still knows this device. An
    // endpoint that minted a fresh key here would be refused, and the refusal
    // would look exactly like a network problem.
    assert_eq!(
        link.endpoint_id(),
        identity_before,
        "the seat came back as a different device"
    );

    let back = link.sync(&replica, Budget::short_refresh());
    assert!(
        back.reached_the_gateway(),
        "the seat did not reach the gateway after resuming: {:?}",
        back.unreachable
    );
    assert!(
        back.rows.stale.is_none(),
        "the row plane was stale after resuming: {:?}",
        back.rows.stale
    );

    // ---- 6. AND IT DID NOT START OVER -------------------------------------
    // The cursor is where it was, the gateway served nothing new, and it said
    // so. A seat that re-applied its own history would show the same cursor and
    // a non-zero `rows_applied`, which is why both are asserted.
    assert_eq!(
        cursor(&replica),
        caught_up,
        "the seat rewound and re-applied its own history"
    );
    assert_eq!(
        back.rows.rows_applied, 0,
        "the gateway re-served {} rows the seat already had",
        back.rows.rows_applied
    );
    assert!(
        back.rows.reached_the_end,
        "a caught-up seat was not told it was caught up"
    );
}

/// A seat that has never been paired does not dial, does not block, and does
/// not pretend. The state a phone is in between installing the app and scanning
/// a code, which is every phone's first state.
#[test]
fn an_unpaired_seat_reports_no_gateway_rather_than_hanging() {
    let seat_dir = tempfile::tempdir().expect("a temp dir");
    let link = SeatLink::start(seat_dir.path().join("blobs"), "1.0.0-test")
        .expect("the seat starts with no gateway");
    let replica =
        rusqlite::Connection::open(seat_dir.path().join("replica.db")).expect("a file opens");

    let started = std::time::Instant::now();
    let report = link.sync(&replica, Budget::short_refresh());
    assert!(!report.reached_the_gateway());
    assert!(
        started.elapsed() < Duration::from_secs(1),
        "an unpaired seat waited {:?} to find out it had no gateway",
        started.elapsed()
    );
    assert!(link.gateway().is_none());
}

/// A GATEWAY THAT IS SWITCHED OFF IS NOT A REJECTED PAIRING CODE (#1020,
/// D-1020-B7).
///
/// Found on an iPhone simulator, not in a test. The gateway was stopped, the
/// member tapped "Pair this device", and the app said *"That pairing code was
/// not accepted. Show a new one."* — so the remedy offered was to mint a code
/// that would fail exactly the same way, while the real problem was a process
/// that was not running.
///
/// The cause was shape, not wording: `SeatLink::pair` had flattened every
/// failure into one `Pair(String)` and the caller recovered the kind by
/// matching on the sentence's text. `ConnectError::PeerUnreachable` renders as
/// "the gateway did not answer" — which the matcher DID look for — but a dial
/// that fails before that, at the relay or the timeout, does not, so it fell
/// through to "refused".
///
/// The fix is that the refusal is now a variant. This test is what stops it
/// being flattened again: it pairs against an endpoint id that no gateway has,
/// and asserts the answer is about REACHING rather than about the code.
#[test]
fn an_unreachable_gateway_is_not_reported_as_a_bad_pairing_code() {
    use centraid_core::link::{PairRefusal, SeatNetwork};

    let seat_dir = tempfile::tempdir().expect("a temp dir");
    let link =
        SeatLink::start(seat_dir.path().join("blobs"), "1.0.0-test").expect("the seat starts");

    // A WELL-FORMED TICKET FOR A GATEWAY THAT DOES NOT EXIST. Well-formed
    // matters: a malformed one would be refused locally as `NotATicket` and
    // would prove nothing about what happens when a dial fails.
    let ticket = centraid_net::ticket::encode(&centraid_api_proto::core_v1::PairTicket {
        v: 1,
        gateway_endpoint: [7u8; 32].to_vec(),
        relay_url: String::new(),
        ticket_id: "ticket-nobody-has".to_owned(),
        secret: vec![9u8; 32],
        vault_name: "Nowhere".to_owned(),
        expires_at_ms: u64::MAX,
        // A loopback port nothing is listening on, so the dial fails rather
        // than waiting on a relay for the full budget.
        direct_addrs: vec!["127.0.0.1:1".to_owned()],
    });

    let refusal = SeatNetwork::pair(&link, &ticket, "Test Seat", "ios")
        .expect_err("there is no gateway at that endpoint");
    assert_eq!(
        refusal,
        PairRefusal::Unreachable,
        "a gateway that was never reached was reported as a ticket problem, \
         which sends the member to mint a code that will fail the same way"
    );
}
