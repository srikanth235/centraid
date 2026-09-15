//! BYTES BOTH WAYS, ONE STORE (#1025 S3).
//!
//! Every byte test before this one moved a photograph DOWN: the gateway held it
//! and a seat fetched it. A phone is where photographs come from, and the shape
//! that carries one up is not the mirror image of the shape that carries one
//! down — the phone is behind the worse NAT and is the side that knows when it
//! is awake, so it cannot be dialled. The GATEWAY pulls, on the connection the
//! seat opened, and it pulls **before** it commits the row that names the bytes.
//!
//! What these tests hold the build to:
//!
//! 1. A photograph minted on a seat reaches the gateway, and the content row
//!    lands only once the gateway holds the bytes.
//! 2. A SECOND seat, which has never met the first, bootstraps, tails the row
//!    and fetches the bytes — and `content_location` on it answers a path that
//!    reads byte-identical to what the first seat minted. That is the whole of
//!    "one hash, one store, per device": the same 32 bytes named it on three
//!    machines and each of them found it in the one store it has.
//! 3. A seat that goes away mid-pull leaves the intent RETRYABLE — not
//!    executed, not failed — and a reconnect completes it.

use std::io::{BufRead as _, BufReader};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::time::Duration;

use centraid_core::link::SyncWindow;
use centraid_seat::intent::{IntentRecord, IntentState};
use centraid_seat::outbox::Outbox;
use centraid_seat::sync::NoChanges;
use centraid_seat_link::SeatLink;
use centraid_vault::backup::store::BlobStore as _;
use centraid_api_proto::core_v1 as wire;
use centraid_vault::intents::NeededBytes;

const READY_LINE: &str = "centraid gateway ready";

fn a_window() -> SyncWindow {
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

/// Spawn the shipped binary and read back `tickets` pair codes.
///
/// The stdout reader drains for the whole run: a reader that stopped at the
/// last ticket would close the pipe under the gateway's next `println!`, and a
/// failed stdout write panics its main thread (`tests/seat_lane.rs` records the
/// whole trap).
fn start_gateway(data_dir: &std::path::Path, tickets: u8) -> Option<(Gateway, Vec<String>)> {
    let mut child = Command::new(env!("CARGO_BIN_EXE_centraid"))
        .arg("gateway")
        .arg("--data-dir")
        .arg(data_dir)
        .arg("--print-qr")
        .arg(tickets.to_string())
        .arg("--no-relay")
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("the gateway binary runs");
    let stdout = child.stdout.take().expect("piped");
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut ready = false;
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if line.starts_with(READY_LINE) {
                ready = true;
            }
            if let Some(encoded) = line.strip_prefix("ticket ")
                && ready
            {
                let _ = tx.send(encoded.trim().to_owned());
            }
        }
    });
    // THE CHILD IS OWNED BEFORE ANYTHING CAN RETURN. `Gateway`'s `Drop` kills
    // and reaps it; a `return None` on the timeout path with the child still
    // loose would leave a gateway running for the rest of the suite, holding a
    // UDP socket and a vault.
    let gateway = Gateway(child);
    let mut found = Vec::new();
    while found.len() < usize::from(tickets) {
        match rx.recv_timeout(Duration::from_secs(30)) {
            Ok(encoded) => found.push(encoded),
            Err(_) => return None,
        }
    }
    Some((gateway, found))
}

/// A real PNG, so the media type on the row is not a claim and the grid's
/// `embeddable` answer means something. Large enough to span several bao chunk
/// groups, so the pull is a real transfer rather than one frame.
fn a_photograph() -> Vec<u8> {
    // A one-pixel PNG header followed by filler. The bytes' identity is what
    // matters here, not that a decoder would accept them: the assertion is
    // byte-equality across three devices.
    let mut bytes =
        b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06".to_vec();
    let mut state: u64 = 0x0005_DEEC_E66D_u64;
    while bytes.len() < 300 * 1024 {
        state = state
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1);
        bytes.extend_from_slice(&state.to_le_bytes());
    }
    bytes
}

/// Queue `media.add_asset` THROUGH THE DOOR A SHELL USES (#1025 S7, Slice 6's
/// blocker).
///
/// The helper below writes the `IntentRecord` into the `Outbox` directly, in
/// Rust, which is past the only door a phone has: `Request::Intent` →
/// `Handle::queue_write`. That is why this suite was green while the product
/// was dead — no test in the tree sent `Request::Intent` for `media.add_asset`
/// from a seat, and the one that would have found that `queue_write`'s
/// prediction refused it before the outbox was ever reached.
///
/// This is that missing door, and it returns the refusal rather than
/// unwrapping so the assertion can name it.
fn queue_a_photograph_through_the_door(
    seat: &centraid_core::Handle,
    intent_id: &str,
    hash: &str,
    byte_size: i64,
) -> Result<wire::Outcome, centraid_core::CoreError> {
    let input = serde_json::json!({
        "staged_sha": hash,
        "kind": "photo",
        "title": "Taken on the phone",
    });
    let request = wire::Request {
        kind: Some(wire::request::Kind::Intent(wire::Intent {
            intent_id: intent_id.to_owned(),
            app_id: "media".to_owned(),
            action: "add_asset".to_owned(),
            input: serde_json::to_vec(&input).expect("the input encodes"),
            // A SHELL DECLARES NO HASH; the seat computes its own
            // (D-1025-S4-6).
            payload_hash: String::new(),
            needs: vec![wire::NeededBytes {
                hash: hash.to_owned(),
                byte_size: u64::try_from(byte_size).expect("a size"),
                media_type: "image/png".to_owned(),
            }],
            ..Default::default()
        })),
    };
    let answered = seat.call(&request)?;
    match answered.kind {
        Some(wire::response::Kind::Outcome(outcome)) => Ok(outcome),
        other => panic!("an intent outcome comes back, not {other:?}"),
    }
}

/// Queue `media.add_asset` naming bytes this seat already holds.
///
/// This is what a shell does when a member takes a photograph: the bytes go
/// into the seat's own store first, and the intent NAMES them — `staged_sha`
/// for the command, `needs_blobs` for the gateway's pull. Both are inside the
/// payload hash, so what the gateway fetches is what the member signed for.
fn queue_a_photograph(replica: &rusqlite::Connection, intent_id: &str, hash: &str, byte_size: i64) {
    let input = serde_json::json!({
        "staged_sha": hash,
        "kind": "photo",
        "title": "Taken on the phone",
    });
    let needs = vec![NeededBytes {
        hash: hash.to_owned(),
        byte_size,
        media_type: "image/png".to_owned(),
    }];
    let payload = centraid_vault::intents::IntentPayload {
        app_id: "media".to_owned(),
        action: "add_asset".to_owned(),
        input: input.clone(),
        base_versions: Vec::new(),
        depends_on: Vec::new(),
        needs: needs.clone(),
    };
    let record = IntentRecord {
        intent_id: intent_id.to_owned(),
        created_order: 0,
        app_id: "media".to_owned(),
        action: "add_asset".to_owned(),
        input,
        payload_hash: payload.hash().expect("the payload hashes"),
        state: IntentState::Queued,
        attempts: 0,
        depends_on: Vec::new(),
        base_versions: Vec::new(),
        optimistic: None,
        commit_seq: None,
        waiting_on: Vec::new(),
        needs_blobs: needs,
        enqueued_at: "t".to_owned(),
        updated_at: "t".to_owned(),
        reason: None,
        conflicts: Vec::new(),
        online_only: false,
    };
    Outbox::open(replica)
        .expect("the outbox opens")
        .enqueue(&record, "t")
        .expect("the write is queued");
}

/// The one content item in a replica, with the owner reading it.
///
/// Through `centraid_vault`'s test door: `core_content_item` and `media_asset`
/// are that crate's schema, and the join between them is a fact about the
/// ontology rather than about this test (`sql-confinement`).
fn the_photograph(replica: &rusqlite::Connection) -> Option<(String, String, String)> {
    centraid_vault::testdoor::the_one_photograph(replica)
}

#[test]
fn a_photograph_minted_on_a_seat_reaches_the_gateway_and_then_a_second_seat() {
    let gateway_dir = tempfile::tempdir().expect("a temp dir");
    let first_dir = tempfile::tempdir().expect("a temp dir");
    let second_dir = tempfile::tempdir().expect("a temp dir");
    let photograph = a_photograph();

    let Some((_gateway, tickets)) = start_gateway(gateway_dir.path(), 2) else {
        panic!("the gateway printed no tickets within 30s");
    };

    // ---- 1. A SEAT MINTS A PHOTOGRAPH INTO ITS OWN STORE ------------------
    let first_path = first_dir.path().join("replica.db");
    let first = SeatLink::start(&first_path, "1.0.0-test").expect("the seat starts");
    first
        .pair(&tickets[0], "First Seat", "ios")
        .expect("the gateway admitted this device");
    first.bootstrap_offered(true).expect("the first copy lands");
    let first_replica = rusqlite::Connection::open(&first_path).expect("the replica opens");
    first.sync(&first_replica, a_window(), &NoChanges);

    // THROUGH THE VAULT'S OWN BYTE DOOR, which is the seat's one content store
    // (D-1025-S3-1) and the store the gateway will pull from. There is no
    // second place these bytes could have gone.
    let hash = first
        .content_door()
        .put(&photograph)
        .expect("the seat's store takes the photograph");
    assert_eq!(
        hash,
        centraid_blobs::ContentHash::of(&photograph).to_hex(),
        "the seat's store does not name bytes the way the plane asks for them"
    );

    let byte_size = i64::try_from(photograph.len()).expect("a size");
    // THROUGH `Request::Intent`, THE ONE DOOR A PHONE HAS (#1025 S7).
    //
    // A seat core over the same replica file, with the same byte store the
    // bytes just went into — which is what the shell holds. `queue_write` runs
    // the real handler against this copy to build its optimistic overlay, and
    // `media.add_asset`'s precondition asks whether the bytes are staged, minted
    // or HELD; only the third can be true on a seat, because `blob_staging` is
    // a gateway-private table no replica carries.
    let seat_core = centraid_core::Core::open(centraid_core::CoreConfig::replicated_seat(
        &first_path,
    ))
    .expect("the seat core opens over the replica");
    seat_core.attach_bytes(first.content_door());
    let queued = queue_a_photograph_through_the_door(&seat_core, "i-photo", &hash, byte_size)
        .expect("the seat queued the write");
    assert_eq!(
        queued.status,
        wire::IntentStatus::Queued as i32,
        "the write did not reach the outbox: {queued:?}"
    );
    seat_core.close();
    drop(seat_core);

    // NOTHING HAS COMMITTED YET, which is what makes the assertion after the
    // pass mean something.
    assert!(the_photograph(&first_replica).is_none());

    // ---- 2. ONE PASS: THE GATEWAY PULLS, THEN COMMITS ---------------------
    let pass = first.sync(&first_replica, a_window(), &NoChanges);
    assert!(
        pass.reached_the_gateway(),
        "the seat did not reach the gateway: {:?}",
        !pass.reached_the_gateway()
    );
    assert_eq!(
        pass.intents_submitted(),
        1,
        "the write was never submitted: blocked {:?}",
        pass.intents.skipped()
    );
    let outbox = Outbox::open(&first_replica).expect("the outbox opens");
    assert!(
        outbox.was_settled("i-photo").expect("reads"),
        "the photograph's intent did not settle; the pull or the commit failed"
    );

    // THE ROW IS HERE AND IT NAMES THE BYTES BY THE ONE URI FORM. A gateway
    // that had committed ahead of the bytes would produce exactly this row and
    // no file behind it, which is why step 3 is the test and not this line.
    let (_, uri, _) = the_photograph(&first_replica).expect("the asset replicated back");
    assert_eq!(uri, format!("blob:blake3-{hash}"), "{uri}");

    // ---- 3. A SECOND SEAT, WHICH HAS NEVER MET THE FIRST ------------------
    let second_path = second_dir.path().join("replica.db");
    let second = SeatLink::start(&second_path, "1.0.0-test").expect("the second seat starts");
    second
        .pair(&tickets[1], "Second Seat", "android")
        .expect("the gateway admitted the second device");
    second.bootstrap_offered(true).expect("the copy lands");
    let second_replica = rusqlite::Connection::open(&second_path).expect("the replica opens");
    let caught_up = second.sync(&second_replica, a_window(), &NoChanges);
    assert!(
        caught_up.reached_the_gateway(),
        "the second seat did not reach the gateway: {:?}",
        !caught_up.reached_the_gateway()
    );
    assert!(
        caught_up.bytes.skipped().is_none(),
        "the second seat's byte plane stalled: {:?}",
        caught_up.bytes.skipped()
    );

    let (content_id, uri, asset_id) =
        the_photograph(&second_replica).expect("the row reached the second seat");
    assert_eq!(uri, format!("blob:blake3-{hash}"));

    // ---- 4. AND ITS BYTES READ BYTE-IDENTICAL -----------------------------
    // Through `content_location`, which is the door a grid uses — not through
    // the store. The two were different stores before this slice, which is
    // precisely how a synced photograph came to be undisplayable.
    let door = second.content_door();
    let vault = centraid_vault::Vault::open(&second_path)
        .expect("the replica opens as a vault")
        .with_blobs(Box::new(door));
    let located = vault
        .content_location(&content_id, "media.asset", &asset_id)
        .expect("the location reads");
    let path = located.path.unwrap_or_else(|| {
        panic!(
            "the bytes did not reach the second seat: {}",
            located.absent_reason
        )
    });
    assert_eq!(
        std::fs::read(&path).expect("the file reads"),
        photograph,
        "the second seat's copy is not the bytes the first seat minted"
    );
    // THE MEDIA TYPE SURVIVED THE TRIP, which is what makes the cell drawable.
    // It is carried in the declaration because the gateway has no sniffer; a
    // photograph promoted as `application/octet-stream` is one a grid refuses
    // to embed.
    assert_eq!(located.media_type, "image/png");
    assert!(located.embeddable);
}

/// A SEAT THAT GOES AWAY MID-PULL LEAVES THE WRITE RETRYABLE (#1025 S3).
///
/// Not executed and not failed. The gateway opened a `blob` stream on the
/// seat's connection and the seat was not there to answer it, so the answer is
/// `ERROR_CODE_BYTES_NOT_YET_HELD` — which `decode_outcome` reads as "this
/// attempt did not land" and leaves the intent in the outbox. A `FAILED` here
/// would tell a member their photograph was rejected because their train went
/// into a tunnel.
///
/// The seat is taken away by declaring bytes it does NOT hold, which is the
/// same thing to the gateway: it opens the stream, the seat's byte store
/// answers that it has nothing, and the transfer does not complete. Then the
/// bytes are put in and the next pass completes it — one intent id, one row.
#[test]
fn a_pull_that_cannot_complete_leaves_the_intent_queued_and_a_retry_finishes_it() {
    let gateway_dir = tempfile::tempdir().expect("a temp dir");
    let seat_dir = tempfile::tempdir().expect("a temp dir");
    let photograph = a_photograph();
    let hash = centraid_blobs::ContentHash::of(&photograph).to_hex();

    let Some((_gateway, tickets)) = start_gateway(gateway_dir.path(), 1) else {
        panic!("the gateway printed no ticket within 30s");
    };

    let replica_path = seat_dir.path().join("replica.db");
    let seat = SeatLink::start(&replica_path, "1.0.0-test").expect("the seat starts");
    seat.pair(&tickets[0], "Test Seat", "ios")
        .expect("the gateway admitted this device");
    seat.bootstrap_offered(true).expect("the first copy lands");
    let replica = rusqlite::Connection::open(&replica_path).expect("the replica opens");
    seat.sync(&replica, a_window(), &NoChanges);

    // THE INTENT NAMES BYTES THE SEAT CANNOT SERVE. The declaration is honest
    // about what the row will say; what is missing is the file behind it.
    let byte_size = i64::try_from(photograph.len()).expect("a size");
    queue_a_photograph(&replica, "i-interrupted", &hash, byte_size);

    let cut = seat.sync(&replica, a_window(), &NoChanges);
    assert!(
        cut.reached_the_gateway(),
        "{:?}",
        !cut.reached_the_gateway()
    );
    // RETRYABLE: the sink reported itself blocked for this attempt, and the
    // write is still in the queue in a state a later pass will submit.
    let outbox = Outbox::open(&replica).expect("the outbox opens");
    let held = outbox
        .get("i-interrupted")
        .expect("reads")
        .expect("the write is still queued");
    // RETRYABLE means a later pass can still change this answer: not `denied`,
    // not `expired`, and not a state the outbox has stopped tracking.
    assert!(
        !held.state.never_retried() && !held.state.is_settled(),
        "a pull that could not finish settled the write as {:?}",
        held.state
    );
    assert!(
        !held.state.retained_attention(),
        "a member was shown a failed write because a pull did not finish: {:?}",
        held.state
    );
    assert!(
        !outbox.was_settled("i-interrupted").expect("reads"),
        "the write settled without the gateway ever holding its bytes"
    );
    // AND NOTHING COMMITTED. The whole law in one line: no content row names
    // bytes the gateway does not hold.
    assert!(
        the_photograph(&replica).is_none(),
        "a content row committed ahead of its bytes"
    );

    // ---- THE BYTES ARRIVE, AND THE SAME INTENT COMPLETES ------------------
    let landed = seat
        .content_door()
        .put(&photograph)
        .expect("the seat's store takes the photograph");
    assert_eq!(landed, hash);

    let finished = seat.sync(&replica, a_window(), &NoChanges);
    assert!(
        finished.reached_the_gateway(),
        "{:?}",
        !finished.reached_the_gateway()
    );
    assert!(
        outbox.was_settled("i-interrupted").expect("reads"),
        "the retry did not settle: submitted {}, blocked {:?}",
        finished.intents_submitted(),
        finished.intents.skipped()
    );
    let (_, uri, _) = the_photograph(&replica).expect("the retry committed the row");
    assert_eq!(uri, format!("blob:blake3-{hash}"));
}
