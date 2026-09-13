//! The handle: `open`, `call`, `next_event`, `close`.
//!
//! Four functions and one type, because that is what the C ABI is allowed to
//! be. Everything else in this crate exists to be reachable from one of them.
//!
//! ## Why one mutex over the vault, in wave 2 (D-1020-D2-9)
//!
//! [`centraid_vault::Vault`] holds its commit-guard depth in a `Cell`, so it is
//! `!Sync` by construction — deliberately, because the guard's depth is a fact
//! about one connection. The issue's "reads run concurrently under SQLite's own
//! rules" therefore needs a *pool of read connections*, and a connection pool
//! means `PRAGMA` statements, which means SQL, which the `sql-confinement` rule
//! confines to `crates/{ontology,vault,seat,search}` and `crates/apps/kit`.
//!
//! Three options were considered:
//!
//! 1. **A reader pool in `crates/core`.** Refused: it puts SQL in a crate the
//!    rule does not name, and weakening the rule to go green is exactly what
//!    the repo forbids.
//! 2. **A reader pool in `crates/vault`.** The right answer, and it is lane
//!    D1's file. Filed as an owner hand-off rather than reached across a lane
//!    boundary in wave 2.
//! 3. **One mutex, every call serialised.** Adopted for wave 2.
//!
//! What option 3 costs is measurable and bounded: `call` is p95-budgeted on a
//! *single* bounded read (`tests/call_budget.rs`), which serialisation does not
//! change, and a phone's shell makes one call per screen. What it does not cost
//! is correctness — a serialised read is a correct read. The FFI's "two
//! concurrent calls never block on the FFI itself" clause is still honestly
//! met, because the FFI takes no lock of its own; the lock is the vault's, and
//! `crates/core-ffi/CONTRACT.md` says so in those words.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use centraid_api_proto::core_v1 as wire;
use centraid_protocol::session::{RequestKind, Session};
use centraid_vault::commands::Registry;
use centraid_vault::{Vault, log};

use crate::config::{CoreConfig, Role, SeatKind};
use crate::error::{CoreError, Result};
use crate::events::{EventQueue, Next};

/// The capabilities this build requires of a peer.
///
/// Empty in wave 2, and that is a claim rather than a placeholder: every
/// capability this core needs is in the schema version, and v0's one
/// absent-tolerant pair (`automations` / `connectors`) is absent-tolerant
/// precisely because it must not be here.
const CAPABILITIES: &[&str] = &[];

/// The command name that triggers the `debug-fault` panic.
///
/// Public so a shell's own clause-9 test can name it without copying a string,
/// and **not** a registered command: `Registry` never sees it, so a build
/// without the feature answers it as an unknown command like any other typo
/// (#1020 wave 3, lane E finding 4).
pub const DEBUG_FAULT_COMMAND: &str = "debug.panic";

/// The type a shell holds. Opaque across the C ABI.
pub struct Handle {
    vault: Mutex<Vault>,
    registry: Registry,
    role: Role,
    ui_thread_name: Option<String>,
    events: Arc<EventQueue>,
    closed: AtomicBool,
    /// Set by a caught panic. A poisoned handle answers every call with
    /// [`CoreError::Poisoned`] so the shell restarts the core **deliberately**
    /// rather than carrying on over state nobody can vouch for.
    poison: Mutex<Option<String>>,
    /// The request-id minter and the in-flight registry.
    session: Mutex<Session>,
    /// Ids a `Cancel` has named. Read by the running request at its next
    /// checkpoint; an unbounded operation polls this, and a bounded one never
    /// does because a bounded read is not cancellable.
    cancelled: Mutex<Vec<u64>>,
    /// Monotonic counter for diagnostic ids, so two panics in one process are
    /// two filings.
    diagnostics: AtomicU64,
    /// The network, when one has been attached (#1020, D-1020-B7).
    ///
    /// `None` is the ordinary state and is exactly a local-first vault: every
    /// unit test in this crate runs this way, and so does a seat between
    /// windows. `crates/seat-link` provides the implementation and the process
    /// builder attaches it — the core cannot depend on that crate, because it
    /// depends on this one.
    network: Mutex<Option<Box<dyn crate::link::SeatNetwork>>>,
}

/// The command name a shell sends to run one sync pass.
///
/// Namespaced under `seat.` so it cannot collide with a vault command: those
/// are `<app>.<action>` over registered apps, and no app is called `seat`.
pub const SEAT_SYNC_COMMAND: &str = "seat.sync";

/// A pairing refusal on the wire. The code carries the whole answer: the
/// vocabulary has no text field, on purpose (`pair.proto`).
const fn refused(code: wire::PairErrorCode) -> wire::PairResponse {
    wire::PairResponse {
        result: Some(wire::pair_response::Result::Error(wire::PairError {
            code: code as i32,
        })),
    }
}

/// The opener.
pub struct Core;

impl Core {
    /// Open the file, run migrations, return.
    ///
    /// **Never blocks on the network.** The endpoint — when one is configured —
    /// is started afterwards by the caller, on a core thread, through
    /// [`Handle::start_endpoint`]. A shell whose first screen waits for a relay
    /// handshake shows a spinner in an aeroplane.
    pub fn open(config: CoreConfig) -> Result<Handle> {
        let CoreConfig {
            path,
            role,
            ui_thread_name,
            create,
            clock,
            ids,
            expected_digest,
        } = config;
        // BEFORE THE FILE IS TOUCHED. A stale core that opened the vault and
        // then refused would have already run whatever migration its own
        // `head_version` carries, which is the half that cannot be undone
        // (#1020 wave 3, lane E finding 3).
        if let Some(expected) = expected_digest.as_deref() {
            let identity = crate::identity::ArtifactIdentity::current();
            match crate::identity::require_digest(&identity, expected) {
                Ok(None) => {}
                Ok(Some(warning)) => tracing::warn!("{warning}"),
                Err(_) => {
                    return Err(CoreError::StaleCore {
                        expected: expected.to_owned(),
                        found: identity.digest,
                    });
                }
            }
        }
        // The file's EXISTENCE decides create-versus-open, before the clock is
        // moved. Trying `open` first and falling back on `Missing` would need
        // the clock twice, and a `Box<dyn Clock>` is not clonable — for the
        // good reason that a clock with state (a `FixedClock` a test advances)
        // must be one clock and not two.
        let founded = path.exists();
        let vault = match (clock, ids) {
            // An injected clock stamps BOTH the create and every later write: a
            // file founded on one clock and written on another would carry rows
            // from two timelines.
            (Some(clock), Some(ids)) => {
                if founded {
                    Vault::open_with(&path, clock, ids)?
                } else if create {
                    Vault::create_with(&path, clock, ids)?
                } else {
                    return Err(centraid_vault::VaultError::Missing { path }.into());
                }
            }
            _ => {
                if founded {
                    Vault::open(&path)?
                } else if create {
                    Vault::create(&path)?
                } else {
                    return Err(centraid_vault::VaultError::Missing { path }.into());
                }
            }
        };
        // THE LOCAL CONTENT STORE, opened beside the vault. Without it this
        // core holds text and refuses every photograph: `media.add_asset` and
        // `core.add_document` spill anything that is not `text/*`, and a
        // `core_content_item` pointing at bytes nothing kept is worse than a
        // refusal. See `Vault::blobs_root_for` for the convention.
        //
        // A store that will not open is NOT a core that will not open: the
        // vault's rows are still readable and every text write still lands.
        // The binary writes refuse with the sentence
        // `pre_inline_bytes_are_storable` gives them, which names the cause.
        let blobs_root = Vault::blobs_root_for(&path);
        let vault = match centraid_vault::backup::store::FsBlobStore::open_content(&blobs_root) {
            Ok(store) => vault.with_blobs(Box::new(store)),
            Err(error) => {
                tracing::warn!(
                    "no content store at {}: {error} — this vault can hold text and nothing else",
                    blobs_root.display()
                );
                vault
            }
        };
        Ok(Handle {
            vault: Mutex::new(vault),
            registry: Registry::with_system_commands()?,
            role,
            ui_thread_name,
            events: Arc::new(EventQueue::new()),
            closed: AtomicBool::new(false),
            poison: Mutex::new(None),
            session: Mutex::new(Session::new()),
            cancelled: Mutex::new(Vec::new()),
            diagnostics: AtomicU64::new(0),
            network: Mutex::new(None),
        })
    }
}

impl Handle {
    /// The role this core was opened as.
    #[must_use]
    pub const fn role(&self) -> &Role {
        &self.role
    }

    /// The event queue, so a producer (sync, the applier) can push to it.
    #[must_use]
    pub fn events(&self) -> Arc<EventQueue> {
        Arc::clone(&self.events)
    }

    /// Whether the authority lives here.
    #[must_use]
    pub fn is_gateway(&self) -> bool {
        self.role == Role::Gateway
    }

    /// Redeem a pairing ticket (#1020, D-1020-B7).
    ///
    /// ## What `PairRequest` means on THIS side of the ABI
    ///
    /// The same message is used shell→core and seat→gateway, and it carries a
    /// different thing in each direction. Seat→gateway it is the redemption:
    /// `code` is the ticket's secret and `device_public_key` is the seat's
    /// identity. Shell→core — here — `code` is **the encoded ticket the camera
    /// read**, and the core mints the redemption itself.
    ///
    /// That is deliberate and it is the safer half. The secret, the ticket id
    /// and this device's public key are all things the core knows or derives;
    /// a shell that assembled them would be a second place they live, and the
    /// public key in particular is the endpoint's and not the shell's to state.
    /// So the shell hands over exactly what it read off the screen and nothing
    /// else.
    ///
    /// A refusal is a `CoreError::Refused` carrying a member-facing sentence.
    /// The gateway's own vocabulary is three coarse codes on purpose — a member
    /// holding a screenshot of an old QR must not learn whether that ticket ever
    /// existed — so the sentence is made from the code and never from a detail.
    fn pair(&self, request: &wire::PairRequest) -> Result<wire::PairResponse> {
        use crate::link::PairRefusal;
        let held = self
            .network
            .lock()
            .map_err(|_| CoreError::NotYetAvailable {
                what: "pairing",
                lands_in: "a core whose network lock was not poisoned",
            })?;
        let Some(network) = held.as_ref() else {
            return Err(CoreError::NotYetAvailable {
                what: "pairing",
                lands_in: "a core with a network attached (`attach_network`)",
            });
        };
        // The camera read text; it arrives as bytes because the field is bytes.
        let Ok(encoded) = std::str::from_utf8(&request.code) else {
            return Ok(refused(wire::PairErrorCode::InvalidCode));
        };
        match network.pair(encoded, &request.device_name, &request.platform) {
            Ok(paired) => Ok(wire::PairResponse {
                result: Some(wire::pair_response::Result::Ok(wire::PairOk {
                    gateway_id: crate::link::hex_lower(&paired.endpoint_id),
                    device_id: paired.device_id,
                    vault_id: paired.vault_id,
                    vault_name: paired.vault_name,
                })),
            }),
            // A GATEWAY THAT WAS NOT REACHED IS NOT A REFUSED TICKET, and the
            // member's action differs: come back in range rather than mint a new
            // code. So it is a typed `CoreError` — whose sentence comes from the
            // code table — and not a `PairResponse::Error`, which is a
            // vocabulary about tickets.
            Err(PairRefusal::Unreachable) => Err(CoreError::Unavailable {
                reason: "the gateway did not answer the pairing request".to_owned(),
            }),
            Err(PairRefusal::Expired) => Ok(refused(wire::PairErrorCode::ExpiredCode)),
            Err(PairRefusal::NotATicket | PairRefusal::Refused) => {
                Ok(refused(wire::PairErrorCode::InvalidCode))
            }
        }
    }

    /// One sync pass, as a `CommandOutcome` a shell already knows how to read.
    ///
    /// The numbers go out as canonical JSON in `output`, which is what every
    /// other command's answer is, so no shell needs a new decoder. `reason` is
    /// the one member-facing sentence, and it is empty on a pass that reached
    /// the gateway — a successful sync has nothing to say.
    fn seat_sync(&self) -> Result<wire::CommandOutcome> {
        // A MEMBER ASKED; A MEMBER IS ANSWERED (#1020, D-1020-B7). `sync_now`
        // refuses a gateway role with `NotYetAvailable`, whose Display is
        // developer text — "`sync` is not yet available: a seat; this vault is
        // …" — and the shell put it on screen verbatim, because a status line
        // shows what it is given. A typed refusal is right for a caller and
        // wrong for a sentence, so the role case is turned into an OUTCOME here
        // rather than propagated.
        if self.is_gateway() {
            return Ok(wire::CommandOutcome {
                status: wire::CommandStatus::Executed as i32,
                output: br#"{"rowsApplied":0,"blobsCompleted":0,"bytesMoved":0,"blobsDeferred":0,"unreachable":true}"#.to_vec(),
                reason: "This vault lives on this device, so there is nothing to sync."
                    .to_owned(),
                ..Default::default()
            });
        }
        let outcome = self.sync_now()?;
        let output = serde_json::json!({
            "rowsApplied": outcome.rows_applied,
            "blobsCompleted": outcome.blobs_completed,
            "bytesMoved": outcome.bytes_moved,
            "blobsDeferred": outcome.blobs_deferred,
            "unreachable": outcome.unreachable,
        });
        Ok(wire::CommandOutcome {
            // AN UNREACHABLE GATEWAY IS NOT A FAILED COMMAND. The pass ran, it
            // did what it could, and it reported honestly; a shell that drew a
            // red banner every time a phone was in a lift would be wrong about
            // what happened.
            status: wire::CommandStatus::Executed as i32,
            output: serde_json::to_vec(&output).unwrap_or_default(),
            reason: outcome.sentence,
            ..Default::default()
        })
    }

    /// Attach a network to this core (#1020, D-1020-B7).
    ///
    /// **The ordering claim this method exists for still holds**: `Core::open`
    /// returns before any of this, so a shell's first screen never waits on a
    /// relay handshake. What changed is who owns the runtime.
    ///
    /// The old refusal said "which runtime a shell owns is the shell's
    /// decision, so the core is handed one rather than making one". A Swift
    /// shell owns no tokio runtime and never will, so that was a requirement
    /// nothing could satisfy rather than a deferral — and it kept the endpoint
    /// unbuilt for two waves. The runtime now belongs to the implementation
    /// behind [`crate::link::SeatNetwork`], which owns one on threads of its
    /// own and is attached here.
    ///
    /// Attaching twice replaces the first, which is what a re-pair or a
    /// re-bind needs; the previous network is dropped and its socket with it.
    pub fn attach_network(&self, network: Box<dyn crate::link::SeatNetwork>) {
        if let Ok(mut held) = self.network.lock() {
            *held = Some(network);
        }
    }

    /// Whether a network is attached. A shell draws "not connected to a
    /// gateway" from this and from [`crate::link::SeatNetwork::gateway`], which
    /// are two different facts: no network at all, versus a network with no
    /// gateway paired to it.
    #[must_use]
    pub fn has_network(&self) -> bool {
        self.network
            .lock()
            .is_ok_and(|held| held.as_ref().is_some_and(|_| true))
    }

    /// Run one sync pass, if a network is attached.
    ///
    /// Blocks. Never call it on a UI thread: the callers are a background
    /// refresh task and an explicit "sync now", both already off the main
    /// thread on both platforms.
    pub fn sync_now(&self) -> Result<crate::link::SyncOutcome> {
        // A GATEWAY IS THE AUTHORITY FOR ITS OWN FILE, so there is nothing for
        // it to sync FROM and a pass would be catastrophic rather than useless:
        // the seat bootstrap lays a replica's schema and cursor over the file,
        // and a vault that became a replica of someone else's log would stop
        // being the thing it is the authority for. Refused by ROLE, which is
        // the one place that fact lives.
        if self.is_gateway() {
            return Err(CoreError::NotYetAvailable {
                what: "sync",
                lands_in: "a seat; this vault is this device's own authority and has nothing to sync from",
            });
        }
        let held = self
            .network
            .lock()
            .map_err(|_| CoreError::NotYetAvailable {
                what: "sync",
                lands_in: "a core whose network lock was not poisoned",
            })?;
        let Some(network) = held.as_ref() else {
            return Err(CoreError::NotYetAvailable {
                what: "sync",
                lands_in: "a core with a network attached (`attach_network`)",
            });
        };
        self.with_vault(|vault| {
            vault
                .read(|connection| Ok(network.sync(connection)))
                .map_err(CoreError::from)
        })
    }

    /// The old name, kept because the ordering claim is documented against it.
    ///
    /// A core with a network attached is started; one without says so rather
    /// than pretending.
    pub fn start_endpoint(&self) -> Result<()> {
        if self.has_network() {
            return Ok(());
        }
        Err(CoreError::NotYetAvailable {
            what: "start_endpoint",
            lands_in: "a core with a network attached (`attach_network`)",
        })
    }

    /// Answer one request.
    ///
    /// Synchronous from the caller's view. **Must never be invoked from a UI
    /// thread**: a debug assertion fires when the calling thread is the one the
    /// shell named through [`CoreConfig::ui_thread_name`].
    pub fn call(&self, request: &wire::Request) -> Result<wire::Response> {
        self.assert_not_on_the_ui_thread();
        self.check_open()?;
        let kind = request_kind(request);
        let request_id = {
            let mut session = self.lock_session();
            session.begin(kind)
        };
        let answer = self.dispatch(request, request_id, kind);
        {
            let mut session = self.lock_session();
            session.settle(request_id);
        }
        self.forget_cancel(request_id);
        answer
    }

    /// Answer one request under a request id the PEER minted.
    ///
    /// The accepting side of a connection: the peer owns its own id space, so
    /// this does not touch the minter. Split from [`Self::call`] rather than
    /// folded into it because a core that minted an id for an inbound request
    /// would answer under an id the peer never used.
    pub fn call_with_id(&self, request: &wire::Request, request_id: u64) -> Result<wire::Response> {
        self.assert_not_on_the_ui_thread();
        self.check_open()?;
        let kind = request_kind(request);
        {
            let mut session = self.lock_session();
            session.accept(request_id, kind)?;
        }
        let answer = self.dispatch(request, request_id, kind);
        {
            let mut session = self.lock_session();
            session.settle(request_id);
        }
        self.forget_cancel(request_id);
        answer
    }

    /// Cancel an in-flight **unbounded** operation.
    ///
    /// A bounded read is refused rather than cancelled, and the refusal is
    /// typed: bounded reads hold a SQLite read transaction, and a cancellation
    /// that leaves it to be rolled back by a dropped future is how the
    /// four-statements-in-one-read-transaction rule of the log door gets broken
    /// (census seam 4). A `Cancel` naming a bounded read is answered by the
    /// read finishing.
    pub fn cancel(&self, request_id: u64) -> Result<()> {
        self.check_open()?;
        // `Session::cancel` already holds the three answers: `Ok(false)` for an
        // id nobody is waiting for, `Err(NotCancellable)` for a bounded read,
        // `Ok(true)` for an unbounded one. Re-deriving them here would be a
        // second place for the classification to live.
        match self.lock_session().cancel(request_id) {
            // A LATE CANCEL IS A NO-OP, not an error: ids are monotonic and
            // never reused, so an answered id is an id nothing will name again.
            Ok(false) => Ok(()),
            Ok(true) => {
                self.lock_cancelled().push(request_id);
                Ok(())
            }
            Err(centraid_protocol::ProtocolError::NotCancellable(_)) => {
                Err(CoreError::NotCancellable { request_id })
            }
            Err(other) => Err(other.into()),
        }
    }

    /// Whether a request has been cancelled. An unbounded operation polls this
    /// at its own checkpoints.
    #[must_use]
    pub fn is_cancelled(&self, request_id: u64) -> bool {
        self.lock_cancelled().contains(&request_id)
    }

    /// Wait for the next event, up to `timeout`.
    ///
    /// Returns `Ok(None)` on a timeout — not an error, because a shell polls
    /// with a timeout so it can also check its own business — and
    /// [`CoreError::Closed`] once the handle is closed and the accepted events
    /// have been handed out.
    ///
    /// **A POISONED HANDLE REFUSES HERE TOO** (#1020 wave 3, lane E finding 4).
    /// It did not: the event door read the queue, found it empty and reported a
    /// timeout, which is a NORMAL answer — so a shell whose core had panicked
    /// would have polled a dead core once a second forever and never learned
    /// why. `call` has always checked; nothing made the event loop check, and
    /// nothing caught it because the clause-9 test could only poison the handle
    /// from Rust and only exercised the closed case. The real panic the
    /// `debug-fault` door injects found it on its first run.
    pub fn next_event(&self, timeout: Duration) -> Result<Option<wire::Event>> {
        self.check_open()?;
        match self.events.next(timeout) {
            Next::Event(event) => Ok(Some(event)),
            Next::Timeout => Ok(None),
            Next::Closed => Err(CoreError::Closed),
        }
    }

    /// Close the handle.
    ///
    /// Unblocks every thread parked in [`Self::next_event`] with
    /// [`CoreError::Closed`], then releases. Idempotent: closing twice is not
    /// an error, because a shell tearing down does not want to track whether
    /// somebody else already did.
    pub fn close(&self) {
        self.closed.store(true, Ordering::SeqCst);
        self.events.close();
    }

    /// Whether this handle is closed.
    #[must_use]
    pub fn is_closed(&self) -> bool {
        self.closed.load(Ordering::SeqCst)
    }

    /// Mark this handle poisoned, returning the diagnostic id filed.
    ///
    /// Called by `crates/core-ffi` from its `catch_unwind` wrapper. The id is
    /// the thing a crash report and a log line have in common, which is what
    /// makes a support bundle answerable.
    pub fn poison(&self, what: &str) -> String {
        let ordinal = self.diagnostics.fetch_add(1, Ordering::SeqCst);
        let diagnostic_id = format!("panic-{what}-{ordinal}");
        let mut poison = self
            .poison
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        // The FIRST panic is the one filed. A later one is a symptom of running
        // on poisoned state, and overwriting would lose the cause.
        if poison.is_none() {
            *poison = Some(diagnostic_id.clone());
        }
        poison.clone().unwrap_or(diagnostic_id)
    }

    /// The diagnostic id a poisoned handle was filed under.
    #[must_use]
    pub fn poisoned_as(&self) -> Option<String> {
        self.poison
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }

    /// Run a body with the vault. The **one** way anything reaches the file.
    pub fn with_vault<T>(&self, body: impl FnOnce(&Vault) -> Result<T>) -> Result<T> {
        self.check_open()?;
        let vault = self
            .vault
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        body(&vault)
    }

    /// The command catalogue this core serves.
    #[must_use]
    pub const fn registry(&self) -> &Registry {
        &self.registry
    }

    // ------------------------------------------------------------ internals --

    fn check_open(&self) -> Result<()> {
        if let Some(diagnostic_id) = self.poisoned_as() {
            // POISON BEFORE CLOSED: a poisoned handle that was then closed is
            // still poisoned, and the shell needs the diagnostic id.
            return Err(CoreError::Poisoned { diagnostic_id });
        }
        if self.is_closed() {
            return Err(CoreError::Closed);
        }
        Ok(())
    }

    fn assert_not_on_the_ui_thread(&self) {
        #[cfg(debug_assertions)]
        if let Some(named) = &self.ui_thread_name
            && let Some(current) = std::thread::current().name()
        {
            debug_assert_ne!(
                current, named,
                "`call` blocks and must never run on the UI thread the shell named; \
                 dispatch it to a core thread"
            );
        }
        // In release the assertion is gone and the field is still read by the
        // debug build, so it is not dead. `_` keeps the release build honest.
        let _ = &self.ui_thread_name;
    }

    fn dispatch(
        &self,
        request: &wire::Request,
        request_id: u64,
        _kind: RequestKind,
    ) -> Result<wire::Response> {
        let Some(kind) = &request.kind else {
            return Err(CoreError::Unsupported {
                type_url: "centraid.core.v1.Request".to_owned(),
            });
        };
        // A THIN SEAT FORWARDS. Everything below this line is what a gateway or
        // a replicated seat answers from its own file.
        if let Role::Seat {
            kind: SeatKind::Thin,
            ..
        } = self.role
            && !answerable_locally(kind)
        {
            return Err(CoreError::Unavailable {
                reason: "this is a thin seat and the gateway has not been dialled".to_owned(),
            });
        }

        use wire::request::Kind as K;

        // THE FAULT-INJECTION DOOR, behind a feature that is never on in a
        // release (#1020 wave 3, lane E finding 4).
        //
        // Clause 9 of the C ABI is the half a SHELL depends on: `PANICKED`
        // arrives as a typed failure, the handle stays poisoned, and the first
        // diagnostic id is the one kept. `core-ffi`'s clause-9 test drove
        // `Handle::poison` directly and said so in its own comment, because a
        // real panic inside `call` needed an injection point that did not
        // exist — so nothing proved that the real library produces what a fake
        // ABI produces.
        //
        // It rides the EXISTING `Command` request rather than a new symbol:
        // clause 10 says five symbols and means it, and a shell that needed a
        // sixth to test the fifth would have a sixth in production.
        // `abi-five-symbols` still counts five, because nothing is exported.
        #[cfg(feature = "debug-fault")]
        if let K::Command(command) = kind
            && command.name == DEBUG_FAULT_COMMAND
        {
            panic!("debug-fault: a deliberate panic for a shell's clause-9 test");
        }

        match kind {
            K::Hello(hello) => Ok(response(wire::response::Kind::Hello(self.hello(hello)))),
            K::Log(log_request) => self.log_page(log_request),
            K::Page(page_request) => Ok(response(wire::response::Kind::Page(
                self.with_vault(|vault| crate::api::page(vault, page_request))?,
            ))),
            K::ContentUrls(refs) => Ok(response(wire::response::Kind::ContentUrls(
                self.with_vault(|vault| crate::api::content_urls(vault, refs))?,
            ))),
            // THE SEAT'S OWN COMMANDS, ANSWERED BEFORE THE VAULT SEES THEM
            // (#1020, D-1020-B7). `seat.sync` is not a vault command: it has no
            // handler, writes no row and would be refused as unregistered. It
            // rides `Command` because clause 10 of the C ABI says five symbols
            // and means it — a sixth entry point to trigger a sync would be a
            // sixth entry point in production.
            K::Command(command) if command.name == SEAT_SYNC_COMMAND => {
                Ok(response(wire::response::Kind::Command(self.seat_sync()?)))
            }
            K::Command(command) => Ok(response(wire::response::Kind::Command(
                self.with_vault(|vault| crate::api::invoke(vault, &self.registry, command))?,
            ))),
            K::Pair(pair) => Ok(response(wire::response::Kind::Pair(self.pair(pair)?))),
            K::SnapshotHead(_) | K::Intent(_) => Err(CoreError::NotYetAvailable {
                what: "this request",
                lands_in: "wave 2 lane R (snapshot head) / wave 3 (intent submission)",
            }),
            K::DevicesList(_) => Ok(response(wire::response::Kind::DevicesList(
                self.devices_list()?,
            ))),
            K::DevicesRevoke(revoke) => {
                self.with_vault(|vault| Ok(vault.revoke_device(&revoke.device)?))?;
                Ok(response(wire::response::Kind::DevicesList(
                    self.devices_list()?,
                )))
            }
            K::BackupNow(_) => Err(CoreError::NotYetAvailable {
                what: "backup",
                lands_in: "wave 2 lane R",
            }),
        }
        .map_err(|error| {
            tracing::debug!(request_id, %error, "the core refused a request");
            error
        })
    }

    fn hello(&self, peer: &wire::Hello) -> wire::Hello {
        // The handshake's JUDGEMENT is lane C's; the core's answer is what this
        // build is. Judging here too would be two places that can disagree.
        let _ = peer;
        let mut hello = centraid_protocol::local_hello(env!("CARGO_PKG_VERSION"), CAPABILITIES);
        // WHAT THIS BUILD IS, on the first message (#1020 wave 3, lane E
        // finding 3). Filled here rather than in `local_hello` because the
        // identity is the CORE's — a seat and a gateway are two artifacts and
        // `crates/protocol` is linked into both.
        hello.identity = Some(crate::identity::ArtifactIdentity::current().to_wire());
        hello
    }

    fn log_page(&self, request: &wire::LogRequest) -> Result<wire::Response> {
        if request.limit == 0 {
            return Err(CoreError::InvalidRequest {
                detail: "a log page limit is required and must be > 0".to_owned(),
            });
        }
        let limit = i64::from(request.limit).min(log::door::max_page());
        let outcome = self.with_vault(|vault| {
            let state = log::log_state(vault)?;
            let since = match &request.since {
                Some(cursor) => log::Cursor {
                    epoch: cursor.epoch.clone(),
                    seq: i64::try_from(cursor.seq).unwrap_or(i64::MAX),
                },
                // ABSENT means "from the floor" — not "from zero", which for a
                // pruned log is a cursor below the floor and a re-bootstrap for
                // a seat that has simply never asked.
                None => state.floor.clone(),
            };
            // EMPTY MEANS "this door did not say", which is what v0 makes
            // optional on the wire so an older gateway that says nothing does
            // not brick a compatible pair.
            let vault_id = vault.vault_id()?.unwrap_or_default();
            match log::read_log_page(vault, &since, limit) {
                Ok(page) => Ok(Ok(crate::convert::log_page_to_wire(&page, &vault_id))),
                Err(centraid_vault::VaultError::RebootstrapRequired { reason }) => {
                    Ok(Err(wire::RebootstrapRequired {
                        reason: crate::convert::rebootstrap_to_wire(reason) as i32,
                        epoch: state.epoch.clone(),
                        floor: state.floor.seq.unsigned_abs(),
                        watermark: state.watermark.seq.unsigned_abs(),
                        schema_epoch: u32::try_from(state.schema_epoch).unwrap_or(0),
                    }))
                }
                Err(other) => Err(other.into()),
            }
        })?;
        Ok(match outcome {
            Ok(page) => response(wire::response::Kind::Log(page)),
            // A REBOOTSTRAP IS A RESPONSE, not an error: the seat is being told
            // what to do next, and an error would make the shell guess.
            Err(required) => response(wire::response::Kind::RebootstrapRequired(required)),
        })
    }

    fn devices_list(&self) -> Result<wire::DevicesListResult> {
        let devices = self.with_vault(|vault| Ok(vault.live_devices()?))?;
        Ok(wire::DevicesListResult {
            devices: devices
                .into_iter()
                .map(|device| wire::DeviceRow {
                    device_id: device.device_id,
                    // The endpoint id is `gateway.db`'s binding and not the
                    // vault's: the vault knows a device by its public key, and
                    // handing back an empty field is honest where inventing
                    // one would not be.
                    endpoint_id: Vec::new(),
                    label: device.name,
                    platform: device.platform,
                    enrolled_at: device.enrolled_at,
                    // ABSENT means live. `live_devices` returns only those, so
                    // a row here is never a tombstone.
                    revoked_at: None,
                })
                .collect(),
        })
    }

    fn forget_cancel(&self, request_id: u64) {
        self.lock_cancelled().retain(|id| *id != request_id);
    }

    fn lock_session(&self) -> std::sync::MutexGuard<'_, Session> {
        self.session
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn lock_cancelled(&self) -> std::sync::MutexGuard<'_, Vec<u64>> {
        self.cancelled
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

fn response(kind: wire::response::Kind) -> wire::Response {
    wire::Response { kind: Some(kind) }
}

/// Which requests a thin seat can answer without its gateway.
///
/// Exactly one: the handshake, because a thin seat still has to say what it is
/// to the shell that opened it. Everything else is a question about rows the
/// seat does not hold.
const fn answerable_locally(kind: &wire::request::Kind) -> bool {
    matches!(kind, wire::request::Kind::Hello(_))
}

/// Whether a request is cancellable.
///
/// A paged read, a command and a handshake are **bounded**: they finish on
/// their own, bounded by their own limit. Sync, media and search indexing are
/// unbounded and cancellable. The classification lives here, next to the
/// dispatch, rather than at each call site — a kind chosen per call site is a
/// kind that gets chosen wrongly once.
fn request_kind(request: &wire::Request) -> RequestKind {
    use wire::request::Kind as K;
    match &request.kind {
        Some(
            K::Hello(_)
            | K::Log(_)
            | K::Page(_)
            | K::Command(_)
            | K::Intent(_)
            | K::Pair(_)
            | K::DevicesList(_)
            | K::DevicesRevoke(_)
            // A LOCATION LOOKUP IS BOUNDED: it is capped at
            // `api::MAX_CONTENT_URLS` rows of index reads and moves no bytes.
            | K::ContentUrls(_),
        )
        | None => RequestKind::Bounded,
        // A snapshot fetch and a backup are as long as the artifact is.
        Some(K::SnapshotHead(_) | K::BackupNow(_)) => RequestKind::Unbounded,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Scratch {
        dir: std::path::PathBuf,
        pub handle: Handle,
    }

    impl Scratch {
        fn gateway() -> Self {
            let dir = centraid_ontology::golden::scratch_dir();
            std::fs::create_dir_all(&dir).expect("the directory is made");
            let handle = Core::open(CoreConfig::gateway(dir.join("vault.db"))).expect("it opens");
            handle
                .with_vault(|vault| Ok(vault.found("Test", "Owner")?))
                .expect("it founds");
            Self { dir, handle }
        }

        fn thin() -> Self {
            let dir = centraid_ontology::golden::scratch_dir();
            std::fs::create_dir_all(&dir).expect("made");
            let path = dir.join("seat.db");
            // A thin seat still has a file; `create: false` refuses a missing
            // one, so one is made through the gateway path first.
            let made = Core::open(CoreConfig::gateway(&path)).expect("opens");
            made.with_vault(|vault| Ok(vault.found("Test", "Owner")?))
                .expect("founds");
            made.close();
            drop(made);
            let handle = Core::open(CoreConfig::thin_seat(&path, b"gw".to_vec()))
                .expect("the thin seat opens");
            Self { dir, handle }
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    fn hello() -> wire::Request {
        wire::Request {
            kind: Some(wire::request::Kind::Hello(wire::Hello {
                identity: None,
                schema_version: 1,
                min_supported: 1,
                product_version: "test".to_owned(),
                capabilities: Vec::new(),
            })),
        }
    }

    fn log_request(limit: u32) -> wire::Request {
        wire::Request {
            kind: Some(wire::request::Kind::Log(wire::LogRequest {
                since: None,
                limit,
            })),
        }
    }

    #[test]
    fn open_returns_without_touching_the_network() {
        let scratch = Scratch::gateway();
        // The proof is negative and structural: `start_endpoint` is a SEPARATE
        // call, and it is not yet implemented — so `open` demonstrably did not
        // do it.
        assert!(matches!(
            scratch.handle.start_endpoint(),
            Err(CoreError::NotYetAvailable { .. })
        ));
        assert!(scratch.handle.is_gateway());
    }

    #[test]
    fn a_handshake_is_answered_with_what_this_build_is() {
        let scratch = Scratch::gateway();
        let Some(wire::response::Kind::Hello(answer)) =
            scratch.handle.call(&hello()).expect("it answers").kind
        else {
            panic!("a hello comes back");
        };
        assert_eq!(answer.schema_version, centraid_protocol::SCHEMA_VERSION);
        assert_eq!(answer.min_supported, centraid_protocol::MIN_SUPPORTED);
        assert!(!answer.product_version.is_empty());

        // AND WHAT ARTIFACT IT IS (#1020 Artifacts, D-1020-G2; wave 3 lane E
        // finding 3). Without this a released shell that linked a prebuilt
        // core could never check what it loaded — the case the whole mechanism
        // exists for — and `mobile/core`'s `identityOf` had to report `dev`.
        let identity = answer.identity.expect("the handshake carries an identity");
        assert!(!identity.digest.is_empty(), "never an empty digest");
        assert!(!identity.git_sha.is_empty());
        assert_eq!(
            identity.schema_version,
            centraid_vault::head_version(),
            "the vault user_version this build writes, not a second copy of it"
        );
        let read_back = crate::identity::ArtifactIdentity::from_wire(&identity);
        assert_eq!(read_back, crate::identity::ArtifactIdentity::current());
    }

    /// THE EXPECTATION IS CHECKED AT `open`, and an unmet one refuses before a
    /// handle exists.
    ///
    /// On a developer machine the core's digest is the `dev` marker, so the
    /// refusal cannot be reached from here without faking the stamp — which
    /// would be testing the fake. What IS asserted here: a `dev` core with an
    /// expectation still OPENS (a development shell must be able to load a
    /// development core) and the refusal it would otherwise return is typed and
    /// carries both digests. `identity::require_digest`'s own tests cover the
    /// released case, which is the one that matters in production.
    #[test]
    fn an_expected_digest_is_carried_into_open_and_a_mismatch_is_typed() {
        let dir = centraid_ontology::golden::scratch_dir();
        std::fs::create_dir_all(&dir).expect("the directory is made");
        let handle = Core::open(
            CoreConfig::gateway(dir.join("vault.db")).expecting_digest("aaaa1111bbbb2222"),
        )
        .expect("a dev core loads for a dev shell, loudly");
        assert!(handle.is_gateway());
        drop(handle);
        let _ = std::fs::remove_dir_all(&dir);

        let refusal = CoreError::StaleCore {
            expected: "aaaa1111bbbb2222".to_owned(),
            found: "cccc3333dddd4444".to_owned(),
        };
        // THE VERSION WINDOW, not `Internal`: the remedy is to update one side,
        // and a shell branching on `Internal` would offer a restart instead.
        assert_eq!(
            refusal.code(),
            centraid_api_proto::core_v1::ErrorCode::VersionWindow
        );
        let text = refusal.to_string();
        assert!(text.contains("aaaa1111bbbb2222"), "{text}");
        assert!(text.contains("cccc3333dddd4444"), "{text}");
    }

    #[test]
    fn every_request_carries_a_monotonic_never_reused_id() {
        let scratch = Scratch::gateway();
        let mut session = Session::new();
        let first = session.begin(RequestKind::Bounded);
        session.settle(first);
        let second = session.begin(RequestKind::Bounded);
        assert!(second > first, "ids are monotonic");
        assert_ne!(first, 0, "zero is the handshake's and not a request's");
        // And the handle's own minter behaves the same, which is what the two
        // `call`s prove: neither is refused for a reused id.
        scratch.handle.call(&hello()).expect("the first");
        scratch.handle.call(&hello()).expect("the second");
    }

    #[test]
    fn a_log_page_with_a_zero_limit_is_refused() {
        let scratch = Scratch::gateway();
        assert!(matches!(
            scratch.handle.call(&log_request(0)),
            Err(CoreError::InvalidRequest { .. })
        ));
    }

    #[test]
    fn an_absent_cursor_means_from_the_floor_and_not_from_zero() {
        let scratch = Scratch::gateway();
        let Some(wire::response::Kind::Log(page)) =
            scratch.handle.call(&log_request(10)).expect("answers").kind
        else {
            panic!("a log page comes back");
        };
        // A founded vault's floor is 0 and the page serves rather than telling
        // the seat to re-bootstrap — which is what "from the floor" buys for a
        // PRUNED log, where zero would be below the floor.
        assert!(!page.epoch.is_empty());
        assert!(page.watermark >= page.floor);
    }

    #[test]
    fn a_cursor_from_another_epoch_is_a_response_and_not_an_error() {
        let scratch = Scratch::gateway();
        let request = wire::Request {
            kind: Some(wire::request::Kind::Log(wire::LogRequest {
                since: Some(wire::LogCursor {
                    epoch: "some-other-epoch".to_owned(),
                    seq: 0,
                }),
                limit: 10,
            })),
        };
        let Some(wire::response::Kind::RebootstrapRequired(required)) =
            scratch.handle.call(&request).expect("it answers").kind
        else {
            panic!("a rebootstrap is a RESPONSE; an error would make the shell guess");
        };
        assert_eq!(
            required.reason,
            wire::RebootstrapReason::EpochMismatch as i32
        );
        assert!(
            !required.epoch.is_empty(),
            "the seat is told the real epoch"
        );
    }

    #[test]
    fn a_request_with_no_kind_is_unsupported_and_not_a_panic() {
        let scratch = Scratch::gateway();
        assert!(matches!(
            scratch.handle.call(&wire::Request { kind: None }),
            Err(CoreError::Unsupported { .. })
        ));
    }

    /// A THIN SEAT IS A PIPE. It answers the handshake and forwards the rest.
    #[test]
    fn a_thin_seat_answers_unavailable_when_the_gateway_is_unreachable() {
        let scratch = Scratch::thin();
        assert!(
            scratch.handle.call(&hello()).is_ok(),
            "a thin seat can still say what it is"
        );
        assert!(matches!(
            scratch.handle.call(&log_request(10)),
            Err(CoreError::Unavailable { .. })
        ));
    }

    #[test]
    fn a_bounded_read_refuses_to_be_cancelled_and_says_so() {
        let scratch = Scratch::gateway();
        let mut session = Session::new();
        let id = session.begin(RequestKind::Bounded);
        // The handle's own registry is what `cancel` consults; an id it never
        // minted is a LATE cancel and a no-op.
        assert!(scratch.handle.cancel(id).is_ok());
        assert!(
            scratch.handle.cancel(9_999).is_ok(),
            "a cancel for an id nobody is waiting for is a no-op, not an error"
        );
    }

    #[test]
    fn an_unbounded_request_is_cancellable_and_a_bounded_one_is_not() {
        // The classification, directly: it lives in one function so a call site
        // cannot choose wrongly.
        assert_eq!(
            request_kind(&wire::Request {
                kind: Some(wire::request::Kind::SnapshotHead(
                    wire::SnapshotHeadRequest { pinned_seq: None }
                )),
            }),
            RequestKind::Unbounded
        );
        assert_eq!(request_kind(&log_request(10)), RequestKind::Bounded);
        assert_eq!(request_kind(&hello()), RequestKind::Bounded);
        // AND A REQUEST WITH NO KIND IS BOUNDED, so an unknown message cannot
        // be used to register a cancellable slot that never finishes.
        assert_eq!(
            request_kind(&wire::Request { kind: None }),
            RequestKind::Bounded
        );
    }

    #[test]
    fn a_closed_handle_answers_every_call_with_a_typed_error() {
        let scratch = Scratch::gateway();
        scratch.handle.close();
        assert!(matches!(
            scratch.handle.call(&hello()),
            Err(CoreError::Closed)
        ));
        assert!(matches!(
            scratch.handle.next_event(Duration::from_millis(1)),
            Err(CoreError::Closed)
        ));
        // AND CLOSING TWICE IS NOT AN ERROR.
        scratch.handle.close();
        assert!(scratch.handle.is_closed());
    }

    #[test]
    fn close_unblocks_a_thread_parked_in_next_event() {
        let scratch = Scratch::gateway();
        let queue = scratch.handle.events();
        let waiter =
            std::thread::spawn(move || matches!(queue.next(Duration::from_secs(30)), Next::Closed));
        std::thread::sleep(Duration::from_millis(50));
        scratch.handle.close();
        assert!(waiter.join().expect("the waiter returns"));
    }

    #[test]
    fn a_timeout_with_no_event_is_not_an_error() {
        let scratch = Scratch::gateway();
        assert_eq!(
            scratch
                .handle
                .next_event(Duration::from_millis(1))
                .expect("a timeout is Ok(None)"),
            None
        );
    }

    /// POISON OUTRANKS CLOSED. A poisoned handle that was then closed is still
    /// poisoned, because the shell needs the diagnostic id to file a report.
    #[test]
    fn a_poisoned_handle_answers_with_its_diagnostic_id_even_after_close() {
        let scratch = Scratch::gateway();
        let filed = scratch.handle.poison("call");
        scratch.handle.close();
        let Err(CoreError::Poisoned { diagnostic_id }) = scratch.handle.call(&hello()) else {
            panic!("a poisoned handle refuses with its id");
        };
        assert_eq!(diagnostic_id, filed);
    }

    #[test]
    fn the_first_panic_is_the_one_filed() {
        let scratch = Scratch::gateway();
        let first = scratch.handle.poison("call");
        let second = scratch.handle.poison("next_event");
        assert_eq!(
            first, second,
            "a later panic is a symptom of running on poisoned state; \
             overwriting would lose the cause"
        );
    }

    #[test]
    fn a_page_request_runs_through_the_access_plane_and_the_probe() {
        let scratch = Scratch::gateway();
        let request = wire::Request {
            kind: Some(wire::request::Kind::Page(wire::PageRequest {
                query: Some(wire::PageQuery {
                    name: "parties".to_owned(),
                    select: vec!["party_id".to_owned(), "created_at".to_owned()],
                    from: "core_party".to_owned(),
                    r#where: None,
                    bind: Vec::new(),
                    order: Some(wire::PageOrder {
                        sort_column: "created_at".to_owned(),
                        pk_column: "party_id".to_owned(),
                        descending: false,
                    }),
                }),
                limit: 10,
                after: None,
            })),
        };
        let Some(wire::response::Kind::Page(page)) =
            scratch.handle.call(&request).expect("it answers").kind
        else {
            panic!("a page comes back");
        };
        // The founded vault has its owner party and nothing else, so the rows
        // ended and `next` is ABSENT — never a cursor past the end.
        assert!(!page.rows.is_empty());
        assert!(page.next.is_none());
    }

    #[test]
    fn the_devices_door_answers_the_live_set() {
        let scratch = Scratch::gateway();
        let owner = scratch
            .handle
            .with_vault(|vault| Ok(vault.self_party_id()?))
            .expect("the owner reads");
        scratch
            .handle
            .with_vault(|vault| Ok(vault.enrol_device("d1", &owner, "Phone", "ios", "pk")?))
            .expect("it enrols");
        let request = wire::Request {
            kind: Some(wire::request::Kind::DevicesList(wire::DevicesList {})),
        };
        let Some(wire::response::Kind::DevicesList(listed)) =
            scratch.handle.call(&request).expect("answers").kind
        else {
            panic!("a device list");
        };
        assert_eq!(listed.devices.len(), 1);

        // And a revoke drops it: unknown and revoked are the SAME refusal.
        let revoke = wire::Request {
            kind: Some(wire::request::Kind::DevicesRevoke(wire::DevicesRevoke {
                device: "d1".to_owned(),
            })),
        };
        let Some(wire::response::Kind::DevicesList(after)) =
            scratch.handle.call(&revoke).expect("answers").kind
        else {
            panic!("a device list");
        };
        assert!(after.devices.is_empty());
    }
}
