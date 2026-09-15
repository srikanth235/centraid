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
//! 5. **A write made offline reaches the gateway and settles against the
//!    commit it landed in** (#1025 S2). This is the half that did not exist: the
//!    intent sink was a `ShutSink` that reported itself down, so every write a
//!    phone made stayed in the outbox forever.

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

    let replica_path = seat_dir.path().join("replica.db");
    let link = SeatLink::start(&replica_path, "1.0.0-test")
        .expect("the seat's runtime and endpoint start");
    let identity_before = link.endpoint_id();

    // ---- 1. PAIR, AND TAKE A COPY -----------------------------------------
    // A seat has no file until it takes one (#1025 S1). There is no script
    // placing a gateway artifact here and no "from the floor" walk: the
    // gateway's snapshot blob is the only creation path.
    assert!(!link.is_bootstrapped(), "a seat starts with no replica");
    let paired = link
        .pair(&encoded, "Test Seat", "ios")
        .expect("the gateway admitted this device");
    assert!(!paired.vault_id.is_empty(), "the gateway named its vault");
    link.bootstrap_offered(true).expect("the first copy lands");
    let replica = rusqlite::Connection::open(&replica_path).expect("the replica file opens");

    // ---- 2. THE FIRST WINDOW ----------------------------------------------
    let first = link.sync(&replica, a_short_refresh(), &NoChanges);
    assert!(
        first.reached_the_gateway(),
        "the first pass never reached the gateway: {:?}",
        !first.reached_the_gateway()
    );
    assert!(
        first.rows.skipped().is_none(),
        "the row plane was stale on a live link: {:?}",
        first.rows.skipped()
    );
    let caught_up = cursor(&replica);
    assert!(caught_up > 0, "the cursor did not move off the floor");

    // THE ROWS ARE REALLY HERE, not merely counted. A replica that reported
    // applying rows into a schema it had not laid down would pass every
    // assertion above.
    assert_eq!(
        centraid_vault::testdoor::vault_rows(&replica),
        1,
        "the founding commit's vault row is not here"
    );

    // ---- 3. OFFLINE --------------------------------------------------------
    // What a backgrounded phone does. Nothing is told; the socket is simply
    // gone.
    link.idle();

    let offline = link.sync(&replica, a_short_refresh(), &NoChanges);
    assert!(
        !offline.reached_the_gateway(),
        "a seat with no socket reported reaching the gateway"
    );

    // A STATE, NOT AN ERROR. The rows already here still read, which is the
    // whole promise of a local-first replica.
    assert_eq!(
        centraid_vault::testdoor::vault_rows(&replica),
        1,
        "an offline replica stopped reading the rows it already holds"
    );

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

    let still_offline = link.sync(&replica, a_short_refresh(), &NoChanges);
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

    let back = link.sync(&replica, a_short_refresh(), &NoChanges);
    assert!(
        back.reached_the_gateway(),
        "the seat did not reach the gateway after resuming: {:?}",
        !back.reached_the_gateway()
    );
    assert!(
        back.rows.skipped().is_none(),
        "the row plane was stale after resuming: {:?}",
        back.rows.skipped()
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
        back.rows_applied(),
        0,
        "the gateway re-served {} rows the seat already had",
        back.rows_applied()
    );
    assert!(
        back.reached_the_end(),
        "a caught-up seat was not told it was caught up"
    );
}

/// A seat that has never been paired does not dial, does not block, and does
/// not pretend. The state a phone is in between installing the app and scanning
/// a code, which is every phone's first state.
#[test]
fn an_unpaired_seat_reports_no_gateway_rather_than_hanging() {
    let seat_dir = tempfile::tempdir().expect("a temp dir");
    let link = SeatLink::start(seat_dir.path().join("replica.db"), "1.0.0-test")
        .expect("the seat starts with no gateway");
    let replica =
        rusqlite::Connection::open(seat_dir.path().join("replica.db")).expect("a file opens");

    let started = std::time::Instant::now();
    let report = link.sync(&replica, a_short_refresh(), &NoChanges);
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
        SeatLink::start(seat_dir.path().join("replica.db"), "1.0.0-test").expect("the seat starts");

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

/// THE WRITE HALF, END TO END (#1025 S2).
///
/// A seat with no network queues an intent, comes back, submits it, and the
/// gateway answers with the commit position the effect landed in. What the test
/// is really about is the LAST step: the overlay does not clear when the answer
/// arrives — it clears when the cursor reaches that commit, **inside the
/// transaction that carries the rows** (`centraid_seat::settlement`).
///
/// So the two facts are asserted TOGETHER, on the same connection, after one
/// pass: the intent is in the settled journal and the row it wrote is in the
/// replica. Before the pass, neither is. There is no state in which one holds
/// and the other does not — which is the entire reason the outbox shares a
/// database with the mirrored rows, and the entire reason a screen does not
/// flicker back to the pre-edit value for one frame.
#[test]
fn a_write_made_offline_settles_against_the_commit_that_carries_it() {
    use centraid_api_proto::core_v1 as wire;
    use centraid_seat::outbox::Outbox;

    let gateway_dir = tempfile::tempdir().expect("a temp dir");
    let seat_dir = tempfile::tempdir().expect("a temp dir");

    let Some((_gateway, encoded)) = start_gateway(gateway_dir.path()) else {
        panic!("the gateway printed no ticket within 30s");
    };

    let replica_path = seat_dir.path().join("replica.db");
    let link = SeatLink::start(&replica_path, "1.0.0-test").expect("the seat starts");
    link.pair(&encoded, "Test Seat", "ios")
        .expect("the gateway admitted this device");
    link.bootstrap_offered(true).expect("the first copy lands");
    let replica = rusqlite::Connection::open(&replica_path).expect("the replica opens");
    link.sync(&replica, a_short_refresh(), &NoChanges);

    // ---- 1. OFFLINE, AND THE MEMBER WRITES --------------------------------
    // What a phone in a lift does. The socket is gone; the write is not.
    link.idle();

    let display_name = "Written In A Lift";
    let input = serde_json::json!({ "display_name": display_name });
    let intent_id = "i-written-offline";

    // THROUGH THE DOOR A SHELL KNOCKS ON (#1025 S5), not a hand-built
    // `IntentRecord`. This test used to construct the outbox row itself and
    // hash the payload itself, which is exactly why nobody noticed that
    // `Request::Intent` refused on a seat: everything downstream of the row was
    // proved and the only producer was the test.
    //
    // `payload_hash` IS DELIBERATELY EMPTY. A shell has no BLAKE3 — not
    // `CryptoKit`, not `MessageDigest`, not `crypto.subtle` (D-1025-S4-6) — so
    // the core computes it, and a declared one is refused.
    let queued = {
        let handle =
            centraid_core::Core::open(centraid_core::CoreConfig::replicated_seat(&replica_path))
                .expect("the seat's core opens over the replica it already holds");
        let answer = handle
            .call(&wire::Request {
                kind: Some(wire::request::Kind::Intent(wire::Intent {
                    intent_id: intent_id.to_owned(),
                    app_id: "core".to_owned(),
                    action: "add_party".to_owned(),
                    input: centraid_vault::intents::canonical_json(&input)
                        .expect("canonical JSON")
                        .into_bytes(),
                    payload_hash: String::new(),
                    ..Default::default()
                })),
            })
            .expect("a seat queues a write rather than refusing it");
        handle.close();
        match answer.kind {
            Some(wire::response::Kind::Outcome(outcome)) => outcome,
            other => panic!("a queued write answered with {other:?}"),
        }
    };
    // QUEUED, AND DISTINCTLY NOT EXECUTED. The gateway has not seen this write
    // and a shell that rendered "saved" from an `EXECUTED` here would be
    // claiming something no peer has agreed to.
    assert_eq!(queued.status, wire::IntentStatus::Queued as i32);
    assert_eq!(queued.intent_id, intent_id);
    assert_eq!(
        queued.commit_seq, None,
        "a queued write named a commit it cannot have landed in"
    );

    // AND THE ROW IS REALLY THERE. This is the assertion the defect failed:
    // `seat_outbox` held zero rows while the screen said "Saving".
    {
        let outbox = Outbox::open(&replica).expect("the outbox opens");
        let held = outbox.all().expect("reads");
        assert_eq!(held.len(), 1, "the door queued nothing");
        assert_eq!(held[0].intent_id, intent_id);
        assert_eq!(held[0].state, centraid_seat::IntentState::Queued);
        // THE HASH THE GATEWAY WILL REHASH, computed by the core over the bytes
        // the caller sent. A wrong one here is refused on every drain forever.
        let expected = centraid_vault::intents::IntentPayload {
            app_id: "core".to_owned(),
            action: "add_party".to_owned(),
            input: input.clone(),
            base_versions: Vec::new(),
            depends_on: Vec::new(),
            needs: Vec::new(),
        }
        .hash()
        .expect("the payload hashes");
        assert_eq!(held[0].payload_hash, expected);
    }

    // THE PASS WITH NO NETWORK LEAVES IT QUEUED. Not failed, not settled: a
    // seat whose sink is unreachable is BLOCKED, and blocked is a state that
    // resolves itself when the network comes back.
    let offline = link.sync(&replica, a_short_refresh(), &NoChanges);
    assert!(!offline.reached_the_gateway());
    let outbox = Outbox::open(&replica).expect("the outbox opens");
    assert!(
        outbox.get(intent_id).expect("reads").is_some(),
        "an offline pass lost the member's write"
    );
    assert!(
        !outbox.was_settled(intent_id).expect("reads"),
        "an offline pass settled a write the gateway never saw"
    );

    // NEITHER FACT HOLDS YET, which is what makes the assertion after the pass
    // mean something.
    assert_eq!(party_count(&replica, display_name), 0);

    // ---- 2. BACK ON -------------------------------------------------------
    link.resume().expect("the endpoint binds again");
    let back = link.sync(&replica, a_short_refresh(), &NoChanges);
    assert!(
        back.reached_the_gateway(),
        "the seat did not reach the gateway: {:?}",
        !back.reached_the_gateway()
    );
    assert!(
        back.rows.skipped().is_none(),
        "the row plane was stale: {:?}",
        back.rows.skipped()
    );

    // THE SINK IS LIVE. Under `ShutSink` this was zero on every pass forever.
    assert_eq!(
        back.intents_submitted(),
        1,
        "the intent was never submitted; is the sink shut again?"
    );
    assert!(
        back.intents.skipped().is_none(),
        "the sink reported itself unavailable: {:?}",
        back.intents.skipped()
    );

    // ---- 3. THE ANSWER CARRIED A COMMIT POSITION --------------------------
    // The number the overlay settles against. An `executed` answer with neither
    // a commit seq nor an answered-version set is refused loudly by
    // `centraid_seat::settlement`, so an intent that settled at all proves the
    // gateway answered with one of the two — and `overlays_cleared` proves it
    // was the commit path, because that is the only path that reports here.
    assert!(
        back.overlays_cleared().contains(&intent_id.to_owned()),
        "the overlay did not clear against a commit: cleared {:?}, settled {}",
        back.overlays_cleared(),
        back.intents_settled()
    );

    // ---- 4. THE TWO FACTS, TOGETHER ---------------------------------------
    // The settled journal holds the intent AND the replicated row is here. One
    // pass, one transaction: `settle_at_commit_seq` runs inside the applier's
    // in-transaction hook for the commit that carries the row.
    let outbox = Outbox::open(&replica).expect("the outbox opens");
    assert!(
        outbox.was_settled(intent_id).expect("reads"),
        "the write reached the gateway and never left the queue"
    );
    assert!(
        outbox.get(intent_id).expect("reads").is_none(),
        "a settled intent is out of the queue, not merely marked"
    );
    assert_eq!(
        party_count(&replica, display_name),
        1,
        "the intent settled and the row it wrote is not in the replica — the two \
         are supposed to be one transaction"
    );
    assert!(
        outbox.overlaid().expect("reads").is_empty(),
        "a settled write is still painting an overlay"
    );
}

/// How many parties of this name the replica holds.
///
/// Through `centraid_vault`'s test door: the replicated tables are that crate's
/// schema, and a statement about them written here would be a second,
/// unversioned opinion about it (`sql-confinement`).
fn party_count(replica: &rusqlite::Connection, display_name: &str) -> i64 {
    centraid_vault::testdoor::parties_named(replica, display_name)
}

/// A WINDOW THE DEADLINE CUT IS A NORMAL END, AND THE NEXT ONE CONTINUES
/// (#1025 S2).
///
/// `PLANE_TIMEOUT` was sixty seconds per plane, which outlives an iOS refresh
/// window and cuts a night shift that had hours. The deadline is the caller's
/// now, and what this proves end to end is the half a unit test cannot: that
/// the number really reaches the transport, that a cut is reported as a CUT
/// rather than as the gateway being broken, and that nothing is rewound by it.
///
/// The deadline is one already past rather than a short one. A sleep would make
/// the test's meaning depend on how busy the machine running it is, and the
/// boundary this is about is not a duration.
#[test]
fn a_window_the_deadline_cuts_keeps_its_cursor_and_the_next_window_catches_up() {
    let gateway_dir = tempfile::tempdir().expect("a temp dir");
    let seat_dir = tempfile::tempdir().expect("a temp dir");

    let Some((_gateway, encoded)) = start_gateway(gateway_dir.path()) else {
        panic!("the gateway printed no ticket within 30s");
    };

    let replica_path = seat_dir.path().join("replica.db");
    let link = SeatLink::start(&replica_path, "1.0.0-test").expect("the seat starts");
    link.pair(&encoded, "Test Seat", "ios")
        .expect("the gateway admitted this device");
    link.bootstrap_offered(true).expect("the first copy lands");
    let replica = rusqlite::Connection::open(&replica_path).expect("the replica opens");

    let caught_up = cursor(&replica);

    // A WINDOW THAT IS ALREADY OVER.
    let started = std::time::Instant::now();
    let cut = link.sync(
        &replica,
        SyncWindow {
            deadline: Duration::ZERO,
            budget_bytes: Some(0),
            budget_items: Some(0),
            budget: centraid_core::link::SyncBudget::ShortRefresh,
            metered: false,
            ..SyncWindow::unbounded()
        },
        &NoChanges,
    );
    assert!(
        cut.cut_by_the_deadline(),
        "a window with no time in it was not reported as cut: {cut:?}"
    );
    // IT RETURNED, and quickly. The constant it replaces would have spent sixty
    // seconds per plane finding this out.
    assert!(
        started.elapsed() < Duration::from_secs(5),
        "a zero-length window took {:?}",
        started.elapsed()
    );
    // AND NOTHING WAS REWOUND. What the pass kept is exactly what it had.
    assert_eq!(
        cursor(&replica),
        caught_up,
        "a cut window moved the cursor it never earned"
    );

    // THE NEXT WINDOW CONTINUES FROM IT. Not from the floor, and not from zero:
    // it asks from the cursor the cut left and is told it is caught up.
    let after = link.sync(&replica, a_short_refresh(), &NoChanges);
    assert!(
        after.reached_the_gateway(),
        "the pass after a cut one never reached the gateway: {:?}",
        !after.reached_the_gateway()
    );
    assert!(!after.cut_by_the_deadline());
    assert_eq!(
        cursor(&replica),
        caught_up,
        "the pass after a cut one started over"
    );
    assert!(
        after.reached_the_end(),
        "the pass after a cut one was not told it was caught up"
    );
}

/// CAUGHT UP, STALE AND BLOCKED ARE THREE DIFFERENT ANSWERS (#1025 S5).
///
/// `SyncOutcome` carried none of them. A pass that reached the gateway and
/// moved nothing looked exactly like one that got its pages and had none to
/// get — so a member with a queued write and a climbing `attempts` count was
/// shown "Synced: 0 changes, 0 files", and the reason the core had already
/// decided died in `PassReport` with nothing to carry it.
///
/// This is the distinction the shell could not draw, asserted through
/// `Handle::sync_now` — the door a shell actually calls — rather than through
/// `SeatLink`, so the field has to survive the whole way out.
#[test]
fn a_blocked_pass_says_why_and_a_caught_up_one_says_nothing() {
    let gateway_dir = tempfile::tempdir().expect("a temp dir");
    let seat_dir = tempfile::tempdir().expect("a temp dir");
    let Some((_gateway, encoded)) = start_gateway(gateway_dir.path()) else {
        panic!("the gateway printed no ticket within 30s");
    };

    let replica_path = seat_dir.path().join("replica.db");
    let handle =
        centraid_core::Core::open(centraid_core::CoreConfig::replicated_seat(&replica_path))
            .expect("an unpaired seat opens");
    handle.attach_network(Box::new(
        SeatLink::start(&replica_path, "1.0.0-test").expect("the seat's endpoint binds"),
    ));
    handle
        .call(&centraid_api_proto::core_v1::Request {
            kind: Some(centraid_api_proto::core_v1::request::Kind::Pair(
                centraid_api_proto::core_v1::PairRequest {
                    code: encoded.into_bytes(),
                    device_name: "Blocked Seat".to_owned(),
                    platform: "ios".to_owned(),
                    ..Default::default()
                },
            )),
        })
        .expect("the pairing is answered");

    // ---- CAUGHT UP: NEITHER FIELD SAYS ANYTHING ---------------------------
    // The good case, and it is asserted first so that the blocked case below
    // cannot pass by these fields simply always being set.
    let caught_up = handle
        .sync_now(a_short_refresh())
        .expect("a pass on a paired seat");
    assert!(
        caught_up.reached_the_gateway(),
        "the pass never reached the gateway"
    );
    // THE TYPED STAGE REASONS, NOT TWO NULLABLE STRINGS (#1025 S7). A stage
    // that ran says what it moved; one that did not says which of a closed set
    // stopped it. "Nothing to say" is now expressible only as an ORDINARY
    // reason, which is why this asserts on `is_ordinary` rather than on `None`:
    // a pass with nothing queued skips the write plane, and that is health.
    assert!(
        caught_up
            .report
            .rows
            .skipped()
            .is_none_or(centraid_seat::sync::SkipReason::is_ordinary),
        "a pass that got its pages reported a fault: {:?}",
        caught_up.report.rows
    );
    assert!(
        caught_up
            .report
            .intents
            .skipped()
            .is_none_or(centraid_seat::sync::SkipReason::is_ordinary),
        "a pass with nothing to submit reported a fault: {:?}",
        caught_up.report.intents
    );

    // ---- A QUEUED WRITE, AND THEN NO NETWORK ------------------------------
    handle
        .call(&centraid_api_proto::core_v1::Request {
            kind: Some(centraid_api_proto::core_v1::request::Kind::Intent(
                centraid_api_proto::core_v1::Intent {
                    intent_id: "i-blocked".to_owned(),
                    app_id: "core".to_owned(),
                    action: "add_party".to_owned(),
                    input: centraid_vault::intents::canonical_json(&serde_json::json!({
                        "display_name": "Queued While Blocked"
                    }))
                    .expect("canonical JSON")
                    .into_bytes(),
                    ..Default::default()
                },
            )),
        })
        .expect("a seat queues a write");

    // The gateway goes away. Killing it is the bluntest version of "the sink
    // is down" and the one this assertion is about; `Endpoint::idle` is the
    // other and `a_seat_survives_losing_the_network…` covers it.
    drop(_gateway);

    let blocked = handle
        .sync_now(a_short_refresh())
        .expect("a pass with no gateway is not an error");
    // UNREACHABLE OR BLOCKED — the two are different depths of the same
    // outage and which one a killed gateway produces depends on whether the
    // dial or the stream fails first. What must NOT happen is silence.
    assert!(
        !blocked.reached_the_gateway()
            || blocked
                .report
                .intents
                .skipped()
                .is_some_and(|reason| !reason.is_ordinary())
            || blocked
                .report
                .rows
                .skipped()
                .is_some_and(|reason| !reason.is_ordinary()),
        "a pass that could not reach its gateway reported nothing at all: {blocked:?}"
    );
    // AND THE WRITE IS STILL THERE, queued, which is what makes "blocked" a
    // state that resolves itself rather than a write that was lost.
    let replica = rusqlite::Connection::open(&replica_path).expect("the replica opens");
    let queued = centraid_seat::outbox::Outbox::open(&replica)
        .expect("the outbox opens")
        .get("i-blocked")
        .expect("reads");
    assert!(queued.is_some(), "a blocked pass lost the member's write");

    // NO DETAIL REACHES A MEMBER. Whatever sentence was produced, it is the
    // code table's and never a gateway's own words about its internals.
    for sentence in [
        blocked
            .report
            .rows
            .skipped()
            .and_then(centraid_core::error::skip_sentence),
        blocked
            .report
            .intents
            .skipped()
            .and_then(centraid_core::error::skip_sentence),
        Some(blocked.sentence.as_str()).filter(|line| !line.is_empty()),
    ]
    .into_iter()
    .flatten()
    {
        assert!(
            !sentence.contains("Error"),
            "a refusal sentence carried a detail: {sentence}"
        );
    }
}

/// A SHELL'S BYTES ARE NOT CANONICAL, AND THEY DO NOT HAVE TO BE (#1025 S5).
///
/// The payload hash is lowercase-hex BLAKE3 over the vault's canonical JSON,
/// and a shell has neither — no BLAKE3 (D-1025-S4-6) and no canonical-JSON
/// writer. Asking one to agree byte-for-byte with the vault's canonicaliser
/// would be a second implementation of it in Kotlin and a third in Swift,
/// drifting the first time a key ordering rule changed, and the symptom of
/// drift is every offline write from one shell being refused — a failure that
/// looks like a network fault.
///
/// So the door parses what it is given and hashes the CANONICAL FORM of the
/// value, which is what the gateway rehashes. This sends input a shell really
/// produces — keys out of order, whitespace, a nested object — through the
/// whole path against the shipped gateway, and asserts the write commits.
#[test]
fn a_write_whose_input_is_not_canonical_json_still_commits() {
    use centraid_api_proto::core_v1 as wire;

    let gateway_dir = tempfile::tempdir().expect("a temp dir");
    let seat_dir = tempfile::tempdir().expect("a temp dir");
    let Some((_gateway, encoded)) = start_gateway(gateway_dir.path()) else {
        panic!("the gateway printed no ticket within 30s");
    };

    let replica_path = seat_dir.path().join("replica.db");
    let link = SeatLink::start(&replica_path, "1.0.0-test").expect("the seat starts");
    link.pair(&encoded, "Sloppy Seat", "ios")
        .expect("the gateway admitted this device");
    link.bootstrap_offered(true).expect("the first copy lands");
    let replica = rusqlite::Connection::open(&replica_path).expect("the replica opens");
    link.sync(&replica, a_short_refresh(), &NoChanges);

    // WHAT A SHELL ACTUALLY SENDS: built by concatenation, keys in the order
    // the author wrote them, spaces and newlines where they fell. Deliberately
    // NOT `serde_json::json!` serialised, which would sort and compact.
    let display_name = "Written With Sloppy Bytes";
    let sloppy = format!(
        "{{\n  \"kind\": \"person\",\n  \"display_name\": {}\n}}",
        serde_json::Value::String(display_name.to_owned())
    );
    assert!(
        sloppy.contains('\n')
            && sloppy.find("kind").unwrap() < sloppy.find("display_name").unwrap(),
        "the fixture stopped being non-canonical, so it proves nothing"
    );

    let intent_id = "i-sloppy-bytes";
    {
        let handle =
            centraid_core::Core::open(centraid_core::CoreConfig::replicated_seat(&replica_path))
                .expect("the seat's core opens");
        let answer = handle
            .call(&wire::Request {
                kind: Some(wire::request::Kind::Intent(wire::Intent {
                    intent_id: intent_id.to_owned(),
                    app_id: "core".to_owned(),
                    action: "add_party".to_owned(),
                    input: sloppy.into_bytes(),
                    payload_hash: String::new(),
                    ..Default::default()
                })),
            })
            .expect("a seat queues a write whatever shape its JSON came in");
        handle.close();
        assert!(matches!(
            answer.kind,
            Some(wire::response::Kind::Outcome(_))
        ));
    }

    // AND THE GATEWAY TAKES IT. This is the assertion: the hash the door stored
    // is the hash the gateway recomputes from the canonical bytes the wire
    // carried, so a shell never has to canonicalise.
    let pass = link.sync(&replica, a_short_refresh(), &NoChanges);
    assert!(
        pass.reached_the_gateway(),
        "{:?}",
        !pass.reached_the_gateway()
    );
    assert!(
        pass.intents.skipped().is_none(),
        "the gateway refused a write whose input was merely untidy: {:?}",
        pass.intents.skipped()
    );
    assert_eq!(pass.intents_submitted(), 1, "the write was never submitted");
    assert_eq!(
        party_count(&replica, display_name),
        1,
        "the write did not commit; a non-canonical input was treated as a different payload"
    );
}

/// A WRITE THE GATEWAY CAN NEVER ACCEPT IS ANSWERED, NOT RETRIED FOREVER
/// (#1025 S5).
///
/// The device found this: a shell queued `knowledge.save_note`, which is not a
/// registered command — the registry has `create_note` and `edit_note` — so the
/// gateway answered `INVALID_REQUEST` on every pass. Every typed `Error` from
/// the gateway was read as a transient `Unavailable`, so the intent stayed
/// QUEUED with `attempts` climbing 1 → 2 → 3 while the member was shown
/// "Synced: 0 changes, 0 files" and never told their save had not happened.
///
/// A refusal about the REQUEST cannot be fixed by sending the same bytes again,
/// so it is now terminal: the intent leaves the queue carrying the code's
/// sentence.
#[test]
fn a_write_naming_a_command_the_gateway_does_not_have_is_answered_terminally() {
    use centraid_api_proto::core_v1 as wire;
    use centraid_seat::outbox::Outbox;

    let gateway_dir = tempfile::tempdir().expect("a temp dir");
    let seat_dir = tempfile::tempdir().expect("a temp dir");
    let Some((_gateway, encoded)) = start_gateway(gateway_dir.path()) else {
        panic!("the gateway printed no ticket within 30s");
    };

    let replica_path = seat_dir.path().join("replica.db");
    let link = SeatLink::start(&replica_path, "1.0.0-test").expect("the seat starts");
    link.pair(&encoded, "Hopeful Seat", "ios")
        .expect("the gateway admitted this device");
    link.bootstrap_offered(true).expect("the first copy lands");
    let replica = rusqlite::Connection::open(&replica_path).expect("the replica opens");
    link.sync(&replica, a_short_refresh(), &NoChanges);

    let intent_id = "i-no-such-command";
    {
        let handle =
            centraid_core::Core::open(centraid_core::CoreConfig::replicated_seat(&replica_path))
                .expect("the seat's core opens");
        handle
            .call(&wire::Request {
                kind: Some(wire::request::Kind::Intent(wire::Intent {
                    intent_id: intent_id.to_owned(),
                    app_id: "knowledge".to_owned(),
                    // THE DEVICE'S OWN SPELLING. `knowledge.save_note` does not
                    // exist; the registry has `create_note` and `edit_note`.
                    action: "knowledge.save_note".to_owned(),
                    input: centraid_vault::intents::canonical_json(&serde_json::json!({
                        "note_id": "n-1",
                        "body": ""
                    }))
                    .expect("canonical JSON")
                    .into_bytes(),
                    ..Default::default()
                })),
            })
            .expect("a seat queues whatever a shell asks for; the gateway decides");
        handle.close();
    }

    let pass = link.sync(&replica, a_short_refresh(), &NoChanges);
    assert!(
        pass.reached_the_gateway(),
        "{:?}",
        !pass.reached_the_gateway()
    );

    let outbox = Outbox::open(&replica).expect("the outbox opens");
    let settled = outbox.get(intent_id).expect("reads");
    match settled {
        None => {
            // Out of the queue entirely, which is one honest terminal shape.
        }
        Some(record) => {
            // OUT OF `queued`, WITH A SENTENCE. The defect left it exactly here
            // with `attempts` rising and nothing else different.
            assert_ne!(
                record.state,
                centraid_seat::IntentState::Queued,
                "a write the gateway can never accept is still queued for another retry"
            );
            assert!(
                record.reason.is_some(),
                "the write failed terminally and the member was told nothing"
            );
        }
    }

    // AND A SECOND PASS DOES NOT RESUBMIT IT. This is the half the member
    // feels: the defect spent a stream on the same doomed write every window.
    let again = link.sync(&replica, a_short_refresh(), &NoChanges);
    assert_eq!(
        again.intents_submitted(),
        0,
        "the doomed write was submitted again on the next pass"
    );
}
