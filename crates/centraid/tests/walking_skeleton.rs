//! THE WALKING SKELETON: one loop, driven as a shell drives it (#1025 S7).
//!
//! Every other test in this repository holds one end of the loop. This one
//! holds the whole of it, through the only door a shell has: `centraid_call`
//! with protobuf BYTES, against the shipped `centraid gateway` binary over real
//! QUIC.
//!
//! ## Why it exists
//!
//! S1–S5 shipped nine defects that no test could see, five of them a complete
//! half with no join: an event queue with no producer, a `RowsChanged` nobody
//! sent, `Outbox::overlaid()` with no consumer, `needs_blobs` with neither, a
//! `WriteGate` with no caller. Every piece had tests and every set of tests
//! passed. The cause is structural: **no single test ever drove the loop
//! through the ABI**, so a seam with both ends built and no join in the middle
//! was green from both sides.
//!
//! This test is the join. It is the umbrella's gate: no slice is done without
//! it passing.
//!
//! ## The steps, and what each one is the only proof of
//!
//! 1. **Pair** — a seat with no file redeems a ticket and comes back with a
//!    vault id, through `Request::Pair` bytes rather than `SeatLink::pair`.
//! 2. **Bootstrap** — pairing left a replica on disk with the gateway's rows in
//!    it, at a cursor that is not zero.
//! 3. **A Home-style read answers the gateway's rows** — `Request::Page` over
//!    `knowledge_note`, compared against what the gateway actually holds.
//! 4. **The gateway is STOPPED** (`SIGSTOP`, not killed: a killed process is a
//!    refused connection, and a phone in a lift is a peer that does not answer)
//!    and `Request::Intent` still answers `QUEUED`.
//! 5. **The read shows the member's own write** — the pending page painted over
//!    the replica. Before S7 this was a badge and never a value.
//! 6. **`seat.sync` with the shell's deadline settles it** — the intent leaves
//!    the outbox, the read shows the gateway's canonical row, and the report
//!    says what moved.
//! 7. **A gateway-side commit reaches the seat on the next pass** and
//!    `centraid_next_event` yields the change naming the row.
//! 8. **Photo bytes cross** — `blobsCompleted > 0` and `content_urls` answers a
//!    path that opens.

use std::io::{BufRead as _, BufReader};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::time::Duration;

use centraid_api_proto::core_v1 as wire;
use centraid_core_ffi::{
    CENTRAID_OK, CENTRAID_TIMEOUT, centraid_call, centraid_close, centraid_free,
    centraid_next_event, centraid_open,
};
use prost::Message as _;

const READY_LINE: &str = "centraid gateway ready";

/// HOW LONG THE SEAT'S ENDPOINT IS GIVEN BEFORE ITS FIRST DIAL. See the call
/// site: it is the host's address discovery and not this product's.
const ENDPOINT_WARMUP: Duration = Duration::from_secs(3);

// ------------------------------------------------------------- the gateway --

/// The shipped binary, and the signals a test sends it.
///
/// `SIGSTOP`/`SIGCONT` rather than kill/restart: a killed gateway refuses the
/// connection immediately, which is the one offline shape a phone almost never
/// has. A stopped one accepts the packets and answers nothing, which is what a
/// lift, a tunnel and a sleeping laptop all look like — and it is the shape
/// that finds a missing deadline.
struct Gateway(Child);

impl Gateway {
    fn stop(&self) {
        signal(self.0.id(), libc_stop());
    }

    fn cont(&self) {
        signal(self.0.id(), libc_cont());
    }
}

impl Drop for Gateway {
    fn drop(&mut self) {
        // CONTINUE BEFORE KILL. A stopped process does not reap: `kill` on a
        // `SIGSTOP`ped child leaves a zombie until the test binary exits, and a
        // panic between `stop` and `cont` would otherwise hang the suite's
        // teardown.
        self.cont();
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

const fn libc_stop() -> &'static str {
    "STOP"
}

const fn libc_cont() -> &'static str {
    "CONT"
}

/// Send a signal by name through `kill(1)`.
///
/// Through the tool rather than a `libc` dependency: this crate has none, and
/// adding one for two signals in one test would put an `unsafe` FFI call in a
/// package whose whole point is that it has no `unsafe` at all.
fn signal(pid: u32, name: &str) {
    let _ = Command::new("kill")
        .arg(format!("-{name}"))
        .arg(pid.to_string())
        .status();
}

/// Spawn the binary and read back its ticket.
///
/// The stdout reader drains for the whole run: a reader that stopped at the
/// ticket would close the pipe under the gateway's next `println!`, and a
/// failed stdout write panics its main thread (`tests/seat_lane.rs` records the
/// trap).
fn start_gateway(data_dir: &std::path::Path) -> Option<(Gateway, String)> {
    let mut child = Command::new(env!("CARGO_BIN_EXE_centraid"))
        .arg("gateway")
        .arg("--data-dir")
        .arg(data_dir)
        .arg("--print-qr")
        .arg("--no-relay")
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
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

/// Seed the gateway's vault THROUGH THE SHIPPED SEEDER, before the gateway
/// starts.
///
/// The order matters and finding out why cost two scenario runs in S5: the
/// seeder founds the vault it is pointed at, and a gateway does not notice
/// commits another process makes to its file. So: seed first, start second.
///
/// `--only notes,photos` keeps the fixture small — a page of notes to read and
/// a roll of photographs with real bytes to fetch — which is what keeps this
/// test inside its budget.
fn seed(data_dir: &std::path::Path) -> std::path::PathBuf {
    let vault_dir = data_dir.join("vault").join("v1");
    std::fs::create_dir_all(&vault_dir).expect("the layout is made");
    let status = Command::new(env!("CARGO_BIN_EXE_seed-demo-vault"))
        .arg(&vault_dir)
        .arg("--file")
        .arg("vault.db")
        .arg("--name")
        .arg("Skeleton")
        .arg("--only")
        .arg("notes,photos")
        .stdout(Stdio::null())
        .stderr(Stdio::inherit())
        .status()
        .expect("the seeder runs");
    assert!(status.success(), "the seeder refused: {status:?}");
    vault_dir.join("vault.db")
}

// ----------------------------------------------------------------- the ABI --

/// A seat core, opened and closed exactly as a shell does it.
struct Seat {
    handle: *mut centraid_core::Handle,
}

impl Seat {
    /// Open a replicated seat over a path that does not exist yet.
    ///
    /// The secret is the shell's, out of its secure store: a seat that minted a
    /// fresh key per open is a device its gateway has never enrolled, which is
    /// the defect S5 closed and which this test would otherwise hide by never
    /// reopening. It rides inside the ENROLMENT RECORD since #1025 S7-13 —
    /// there is one entry per vault and it carries everything.
    fn open(path: &std::path::Path, endpoint_secret_hex: &str) -> Self {
        let config = serde_json::json!({
            "path": path.display().to_string(),
            "role": "seat-replicated",
            "pairing": {
                "secret": endpoint_secret_hex,
                // NO RELAYS, BECAUSE THE GATEWAY THIS DIALS HAS NONE (#1025
                // S7). `centraid gateway --no-relay` is a LAN-only deployment
                // and this is its other half: a seat that kept a relay-mode
                // endpoint waited on a relay probe before its first dial, and
                // on a machine with no route to those relays the probe ran past
                // the ten-second connect bound — so the gateway in the same
                // process tree was reported unreachable, every time,
                // deterministically.
                //
                // The KEY'S PRESENCE is the statement (#1025 S7-13): an empty
                // relay url says "this deployment has none", where an absent
                // one would say "not told yet" and leave relays on.
                "relayUrl": "",
            },
        })
        .to_string();
        let mut handle: *mut centraid_core::Handle = std::ptr::null_mut();
        // SAFETY: `config` outlives the call and `handle` is a live local.
        let code = unsafe { centraid_open(config.as_ptr(), config.len(), &raw mut handle) };
        assert_eq!(code, CENTRAID_OK, "the seat core opens: {config}");
        assert!(!handle.is_null());
        Self { handle }
    }

    /// One request, as bytes, answered as bytes.
    fn call(&self, kind: wire::request::Kind) -> wire::Envelope {
        let request = wire::Envelope {
            request_id: 1,
            body: Some(wire::envelope::Body::Request(wire::Request {
                kind: Some(kind),
            })),
        }
        .encode_to_vec();
        let mut buf: *mut u8 = std::ptr::null_mut();
        let mut len: usize = 0;
        // SAFETY: the handle is live, the request outlives the call and both
        // out-pointers are live locals.
        let code = unsafe {
            centraid_call(
                self.handle,
                request.as_ptr(),
                request.len(),
                &raw mut buf,
                &raw mut len,
            )
        };
        assert!(!buf.is_null(), "the ABI answered nothing (code {code})");
        // SAFETY: `buf`/`len` are what the call reported.
        let bytes = unsafe { std::slice::from_raw_parts(buf, len) }.to_vec();
        // SAFETY: freed exactly once, with the length the call handed back.
        unsafe { centraid_free(buf, len) };
        wire::Envelope::decode(bytes.as_slice()).expect("the answer is an Envelope")
    }

    /// The answer's `Response`, or the error's text for a readable failure.
    fn response(&self, kind: wire::request::Kind) -> wire::Response {
        match self.call(kind).body {
            Some(wire::envelope::Body::Response(response)) => response,
            Some(wire::envelope::Body::Error(error)) => {
                panic!("the core refused: code={} {}", error.code, error.detail)
            }
            other => panic!("expected a Response, got {other:?}"),
        }
    }

    /// Wait for one event, up to `timeout`.
    fn next_event(&self, timeout: Duration) -> Option<wire::Event> {
        let mut buf: *mut u8 = std::ptr::null_mut();
        let mut len: usize = 0;
        // SAFETY: the handle is live; both out-pointers are live locals.
        let code = unsafe {
            centraid_next_event(
                self.handle,
                u32::try_from(timeout.as_millis()).unwrap_or(u32::MAX),
                &raw mut buf,
                &raw mut len,
            )
        };
        if code == CENTRAID_TIMEOUT {
            // NOTHING IS ALLOCATED ON A TIMEOUT, so there is nothing to free.
            return None;
        }
        assert_eq!(code, CENTRAID_OK, "next_event failed");
        // SAFETY: `buf`/`len` are what the call reported.
        let bytes = unsafe { std::slice::from_raw_parts(buf, len) }.to_vec();
        // SAFETY: freed exactly once.
        unsafe { centraid_free(buf, len) };
        match wire::Envelope::decode(bytes.as_slice())
            .expect("the event is an Envelope")
            .body
        {
            Some(wire::envelope::Body::Event(event)) => Some(event),
            other => panic!("expected an Event, got {other:?}"),
        }
    }
}

impl Drop for Seat {
    fn drop(&mut self) {
        if !self.handle.is_null() {
            // SAFETY: the handle came from `centraid_open` and is closed once.
            unsafe { centraid_close(self.handle) };
            self.handle = std::ptr::null_mut();
        }
    }
}

/// A page over one table, the shape a Home tile asks for.
fn page_request(table: &str, select: &[&str], pk: &str, sort: &str) -> wire::request::Kind {
    wire::request::Kind::Page(wire::PageRequest {
        query: Some(wire::PageQuery {
            name: "skeleton".to_owned(),
            select: select.iter().map(|column| (*column).to_owned()).collect(),
            from: table.to_owned(),
            r#where: None,
            bind: Vec::new(),
            order: Some(wire::PageOrder {
                sort_column: sort.to_owned(),
                pk_column: pk.to_owned(),
                descending: false,
            }),
            ..Default::default()
        }),
        limit: 200,
        after: None,
    })
}

/// The first column of every row of a page, as text.
fn column(page: &wire::Page, index: usize) -> Vec<String> {
    page.rows
        .iter()
        .map(
            |row| match row.values.get(index).and_then(|v| v.kind.as_ref()) {
                Some(wire::value::Kind::Text(text)) => text.clone(),
                other => format!("{other:?}"),
            },
        )
        .collect()
}

fn expect_page(response: wire::Response) -> wire::Page {
    match response.kind {
        Some(wire::response::Kind::Page(page)) => page,
        other => panic!("expected a Page, got {other:?}"),
    }
}

/// One `seat.sync` pass, with the deadline the shell was given.
///
/// A REAL WINDOW, because the point of the parameter is that the core has no
/// opinion about window length. Thirty seconds is generous enough that nothing
/// here is a race and finite enough that a pass which cannot reach the gateway
/// returns rather than hanging the suite.
fn sync(seat: &Seat, deadline: Duration) -> serde_json::Value {
    let outcome = match seat
        .response(wire::request::Kind::Command(wire::Command {
            name: centraid_core::handle::SEAT_SYNC_COMMAND.to_owned(),
            input: b"{}".to_vec(),
            invoke_key: "skeleton-sync".to_owned(),
            sync_window: Some(wire::SyncWindow {
                deadline_ms: u64::try_from(deadline.as_millis()).unwrap_or(u64::MAX),
                budget_bytes: None,
                budget_items: None,
                budget: wire::SyncBudget::Foreground as i32,
                // NOT METERED: this pass moves originals on purpose. The
                // metered plan is proved where it belongs, in `crates/blobs`.
                metered: false,
                // AND THE DEFAULT TRANSFER RULE (#1025 S4), which on an
                // unmetered window admits every original — the rule's own
                // table is proved in `crates/blobs`, not here.
                ..Default::default()
            }),
            ..Default::default()
        }))
        .kind
    {
        Some(wire::response::Kind::Command(outcome)) => outcome,
        other => panic!("expected a CommandOutcome, got {other:?}"),
    };
    serde_json::from_slice(&outcome.output).expect("the pass reports JSON")
}

/// The gateway's own answer to the same question, read off its file.
///
/// A SECOND CONNECTION TO A LIVE FILE, which is what WAL is for. The comparison
/// is row for row: two copies holding the right NUMBER of the wrong rows is the
/// failure this exists to catch.
fn gateway_note_titles(vault_path: &std::path::Path) -> Vec<String> {
    let connection = rusqlite::Connection::open(vault_path).expect("the gateway's vault opens");
    // Through `centraid_vault`'s test door: `knowledge_note` is that crate's
    // schema, and `sql-confinement` confines a statement about it there. The
    // door orders by note id, which is what makes this comparison row for row.
    centraid_vault::testdoor::note_titles(&connection)
}

/// Commit one row on the gateway, through the real command plane.
fn commit_a_note(vault_path: &std::path::Path, title: &str) {
    let vault = centraid_vault::Vault::open(vault_path).expect("the gateway's vault opens");
    let registry =
        centraid_vault::commands::Registry::with_system_commands().expect("the catalogue builds");
    let principal = centraid_vault::Principal::owner("skeleton-test");
    vault
        .execute(
            &registry,
            &principal,
            &centraid_vault::commands::Command::new(
                "knowledge.create_note",
                serde_json::json!({ "title": title, "body_text": "written on the gateway" }),
            ),
        )
        .expect("the note is created");
    vault.close().expect("the second connection closes");
}

/// One note the seat can edit, picked off the replica.
fn a_note_on_the_seat(seat: &Seat) -> (String, String) {
    let page = expect_page(seat.response(page_request(
        "knowledge_note",
        &["note_id", "title"],
        "note_id",
        "note_id",
    )));
    assert!(!page.rows.is_empty(), "the replica holds no notes");
    (column(&page, 0)[0].clone(), column(&page, 1)[0].clone())
}

// ------------------------------------------------------------------ the loop -

#[test]
fn the_whole_loop_through_the_abi_against_the_shipped_gateway() {
    // THE SEAT'S OWN LOG LINES, IN THE TEST'S OUTPUT.
    //
    // Every refusal in this product is a CODE with a sentence from a table, and
    // the detail behind it is a `tracing` line — which is exactly right in
    // production and left this test saying "the gateway is unreachable" with
    // nothing to look at. The subscriber is best-effort: a second test binary
    // in the same process would already have installed one.
    let _ = tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("warn")),
        )
        .with_test_writer()
        .try_init();
    let gateway_dir = tempfile::tempdir().expect("a temp dir");
    let seat_dir = tempfile::tempdir().expect("a temp dir");

    let vault_path = seed(gateway_dir.path());
    let Some((gateway, ticket)) = start_gateway(gateway_dir.path()) else {
        panic!("the gateway printed no ticket within 30s");
    };

    // ---- 1. UNPAIRED, AND THAT IS A STATE ---------------------------------
    let replica_path = seat_dir.path().join("centraid-seat.sqlite3");
    let endpoint_secret = "7c".repeat(32);
    let seat = Seat::open(&replica_path, &endpoint_secret);
    // A FRESHLY BOUND ENDPOINT'S FIRST DIAL RACES ITS OWN ADDRESS DISCOVERY.
    //
    // `centraid_open` returns as soon as the endpoint is spawned — which is the
    // contract, and the reason a shell's first screen never waits on a network
    // — and iroh then discovers this host's interfaces in the background. A
    // dial issued in the middle of that takes seconds longer than one issued
    // after it, and the connect bound is ten (D-1020-C9).
    //
    // On a phone the gap is filled by a member reading a screen and tapping a
    // button. Here nothing fills it, so the test waits, and it waits WITHOUT
    // asserting anything about the duration: this is a property of the host's
    // networking, not of this product, and a test that pinned it would be
    // pinning somebody else's number.
    std::thread::sleep(ENDPOINT_WARMUP);
    assert!(
        !replica_path.exists(),
        "a seat was given a file it never asked for"
    );

    // ---- 2. PAIR, WHICH TAKES THE FIRST COPY ------------------------------
    let paired = match seat
        .response(wire::request::Kind::Pair(wire::PairRequest {
            code: ticket.clone().into_bytes(),
            device_name: "Skeleton Seat".to_owned(),
            platform: "ios".to_owned(),
            ..Default::default()
        }))
        .kind
    {
        Some(wire::response::Kind::Pair(pair)) => match pair.result.expect("a result") {
            wire::pair_response::Result::Ok(ok) => ok,
            wire::pair_response::Result::Error(error) => {
                panic!("the gateway refused the ticket: {error:?}")
            }
        },
        other => panic!("expected a PairResponse, got {other:?}"),
    };
    assert!(!paired.vault_id.is_empty(), "a pairing named no vault");
    assert!(
        replica_path.exists(),
        "pairing left this seat with no copy; the bootstrap is the pairing's own"
    );

    // ---- 3. A HOME-STYLE READ ANSWERS THE GATEWAY'S ROWS ------------------
    let titles = expect_page(seat.response(page_request(
        "knowledge_note",
        &["note_id", "title"],
        "note_id",
        "note_id",
    )));
    assert_eq!(
        column(&titles, 1),
        gateway_note_titles(&vault_path),
        "the replica's notes are not the gateway's"
    );

    // ---- 4. THE GATEWAY STOPS, AND A WRITE IS STILL ACCEPTED --------------
    let (note_id, original_title) = a_note_on_the_seat(&seat);
    let edited = format!("{original_title} — edited offline");
    gateway.stop();

    let input = serde_json::json!({ "note_id": note_id, "title": edited });
    let queued = match seat
        .response(wire::request::Kind::Intent(wire::Intent {
            intent_id: "skeleton-edit-1".to_owned(),
            app_id: "knowledge".to_owned(),
            action: "edit_note".to_owned(),
            input: centraid_vault::intents::canonical_json(&input)
                .expect("the input is canonical")
                .into_bytes(),
            // EMPTY, AND THAT IS THE CONTRACT (D-1025-S4-6): the core computes
            // the payload hash, because no shell toolkit has BLAKE3.
            payload_hash: String::new(),
            ..Default::default()
        }))
        .kind
    {
        Some(wire::response::Kind::Outcome(outcome)) => outcome,
        other => panic!("expected an Outcome, got {other:?}"),
    };
    assert_eq!(
        queued.status,
        wire::IntentStatus::Queued as i32,
        "an offline write was not queued: {queued:?}"
    );
    assert!(
        queued.commit_seq.is_none(),
        "a queued write claimed a commit the gateway has never seen"
    );

    // ---- 5. AND THE READ SHOWS IT AT ONCE ---------------------------------
    // The member typed, the screen changed, and no network was involved. This
    // is the assertion `Overlays` existed for and nothing ever made: before S7
    // a queued write was a badge and never a value.
    let painted = expect_page(seat.response(page_request(
        "knowledge_note",
        &["note_id", "title"],
        "note_id",
        "note_id",
    )));
    assert!(
        column(&painted, 1).contains(&edited),
        "the member's own pending write is not on their own screen: {:?}",
        column(&painted, 1)
    );

    // ---- 6. THE GATEWAY COMES BACK AND THE PASS SETTLES IT ----------------
    gateway.cont();
    let report = sync(&seat, Duration::from_secs(30));
    assert_eq!(
        report["unreachable"],
        serde_json::json!(false),
        "the pass never reached the gateway: {report}"
    );
    // THE STAGES, NOT TWO NULLABLE STRINGS (#1025 S7). A stage says what it
    // moved, what it kept when the deadline ended it, or which of a CLOSED set
    // of reasons stopped it — so "nothing to say" is expressible only as an
    // ordinary reason, and there is no four-zeros-and-no-error answer left.
    assert_eq!(
        report["stages"]["intents"]["state"],
        serde_json::json!("moved"),
        "the gateway refused this seat's intent: {report}"
    );
    assert_eq!(
        report["stages"]["rows"]["state"],
        serde_json::json!("moved"),
        "the row plane did not get its pages: {report}"
    );

    // The canonical row, from the gateway — not the paint.
    let settled = expect_page(seat.response(page_request(
        "knowledge_note",
        &["note_id", "title"],
        "note_id",
        "note_id",
    )));
    assert!(
        column(&settled, 1).contains(&edited),
        "the gateway's committed row does not carry the edit: {:?}",
        column(&settled, 1)
    );
    assert_eq!(
        column(&settled, 1),
        gateway_note_titles(&vault_path),
        "after settlement the replica and the gateway disagree"
    );

    // ---- 6b. THE INVARIANT ------------------------------------------------
    // AN EMPTY OUTBOX MEANS AN EMPTY JOURNAL MEANS A REPLICA THAT IS THE
    // GATEWAY'S (#1025 S7, item 4).
    //
    // One sentence and it is the whole correctness claim of applying a
    // prediction in place: a seat's file differs from the gateway's only by
    // writes the gateway has not answered yet, and every one of those has a
    // journal entry saying how to take it back. A leftover entry is a row this
    // device would restore to a value the gateway has since overwritten, and
    // nothing else in this test would notice it.
    {
        let replica = rusqlite::Connection::open(&replica_path).expect("the replica opens");
        let queued: i64 = replica
            .query_row("SELECT COUNT(*) FROM seat_outbox", [], |row| row.get(0))
            .expect("the queue reads");
        assert_eq!(queued, 0, "the settled write is still in the queue");
        let pending: i64 = replica
            .query_row("SELECT COUNT(*) FROM seat_pending_rows", [], |row| {
                row.get(0)
            })
            .expect("the journal reads");
        assert_eq!(
            pending, 0,
            "the outbox is empty and this device is still holding a prediction"
        );
    }

    // ---- 7. A GATEWAY-SIDE COMMIT REACHES THE SEAT ------------------------
    // Drain whatever the settling pass already queued, so the assertion below
    // is about the NEW commit and not about a leftover.
    while seat.next_event(Duration::from_millis(50)).is_some() {}
    commit_a_note(&vault_path, "Written on the gateway");
    let tailed = sync(&seat, Duration::from_secs(30));
    assert!(
        tailed["rowsApplied"].as_u64().unwrap_or(0) > 0,
        "a commit landed on the gateway and the seat applied none: {tailed}"
    );
    let change = seat
        .next_event(Duration::from_secs(5))
        .expect("a row that arrived from sync did not reach `next_event`");
    match change.kind {
        Some(wire::event::Kind::Change(change)) => {
            assert!(
                !change.table.is_empty(),
                "a change event named no table: {change:?}"
            );
        }
        other => panic!("expected a ChangeEvent, got {other:?}"),
    }

    // ---- 8. AND THE PHOTOGRAPHS' BYTES ------------------------------------
    // THE TALLY IS ACROSS THE WINDOWS, not inside one. A byte plane that has
    // already fetched everything reports `blobsCompleted: 0` honestly — that is
    // a caught-up device, not a broken one — so asserting on the LAST window
    // would be asserting that the work had not been done yet. What the loop
    // owes is that the bytes crossed at all, and that no window ever reported
    // the two shapes of not-crossing.
    let windows = [&report, &tailed, &sync(&seat, Duration::from_secs(60))];
    let completed: u64 = windows
        .iter()
        .map(|window| window["blobsCompleted"].as_u64().unwrap_or(0))
        .sum();
    // AND THE ROWS THEY BELONG TO ARE NAMED (#1025 S7). A window that completed
    // files and could not say which cells they are for is the defect this
    // assertion exists for: nineteen photographs landed on a device, no ROW
    // changed, no change event fired, and every cell still read "not on this
    // device yet".
    let arrived: usize = windows
        .iter()
        .map(|window| {
            window["stages"]["bytes"]["arrived"]
                .as_array()
                .map_or(0, Vec::len)
        })
        .sum();
    assert!(
        arrived > 0,
        "files landed and no window named the rows they belong to: {windows:?}"
    );
    let moved: u64 = windows
        .iter()
        .map(|window| window["bytesMoved"].as_u64().unwrap_or(0))
        .sum();
    assert!(
        completed > 0 && moved > 0,
        "no photograph's bytes crossed in any window: {windows:?}"
    );
    for window in windows {
        // A BLOB THE GATEWAY WOULD NOT SERVE is a row it committed over bytes
        // it does not hold, and it used to end the byte plane for ever: the
        // plan is ordered deterministically, so the same blob came first in
        // every window after it.
        assert_eq!(
            window["stages"]["bytes"]["refused"].as_u64().unwrap_or(0),
            0,
            "the gateway refused a blob it had committed a row for: {window}"
        );
        assert_eq!(
            window["stages"]["bytes"]["withheld"].as_u64().unwrap_or(0),
            0,
            "an unmetered window withheld originals: {window}"
        );
        // NO TRANSPORT WORDS REACH A MEMBER. `Error.detail` is logs-only, and
        // this field is rendered on the Photos screen; it carried
        // "io: stream reset by peer: error 3" with a content hash in it.
        if let Some(sentence) = window["stages"]["bytes"]["sentence"].as_str() {
            assert!(
                !sentence.contains("error") && !sentence.contains(':'),
                "a transport detail reached a member: {sentence}"
            );
        }
    }

    // AND THE PATH OPENS. A library of rows pointing at nothing renders as
    // placeholders and fails nothing, which is exactly how S5's orphaned byte
    // store shipped.
    let content_ids = {
        let page = expect_page(seat.response(page_request(
            "core_content_item",
            &["content_id"],
            "content_id",
            "content_id",
        )));
        column(&page, 0)
    };
    assert!(
        !content_ids.is_empty(),
        "the replica holds no content items"
    );
    let urls = match seat
        .response(wire::request::Kind::ContentUrls(wire::ContentUrlRequest {
            refs: content_ids
                .iter()
                .take(32)
                .map(|content_id| wire::ContentRef {
                    content_id: content_id.clone(),
                    ..Default::default()
                })
                .collect(),
        }))
        .kind
    {
        Some(wire::response::Kind::ContentUrls(urls)) => urls,
        other => panic!("expected ContentUrls, got {other:?}"),
    };
    let readable = urls
        .urls
        .iter()
        .filter_map(|url| url.path.as_ref())
        .filter(|path| std::fs::metadata(path).is_ok_and(|meta| meta.len() > 0))
        .count();
    assert!(
        readable > 0,
        "every content item this seat fetched answers a path nothing can open: {:?}",
        urls.urls
    );
}
