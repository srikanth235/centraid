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
use centraid_vault::Vault;
use centraid_vault::commands::Registry;

use crate::config::CoreConfig;
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

/// THE ONLY CALLER THERE IS, AS A RECEIPT NAMES IT (#1029 §1).
///
/// The phone is the only host that opens a vault (#1029 §6), so every command
/// this core runs is the owner's own, made on the device the vault lives on.
/// The name is what a receipt and an audit row carry, and it is deliberately a
/// fact rather than an identifier: there is no enrolment to quote, no device
/// registry to look it up in, and a generated id would be a second thing to
/// keep true across a restore for no reader.
pub const OWNER_DEVICE: &str = "this-device";

/// The type a shell holds. Opaque across the C ABI.
pub struct Handle {
    /// THE VAULT, WHEN THERE IS ONE.
    ///
    /// `None` is a core opened at a path with no file and `create: false` —
    /// a shell asking to open a vault a restore has not written yet. It is a
    /// state the shell draws ("no vault here"), not a failure.
    vault: Mutex<Option<Vault>>,
    registry: Registry,
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
    /// THE ONE CONTENT STORE THIS DEVICE HOLDS FOR THIS VAULT (#1025 S3,
    /// D-1025-S3-1).
    ///
    /// Held rather than derived: the door has to be attached again to the
    /// vault that comes back after a restore replaces the file, and a store
    /// re-derived there would be a second index over one set of files — which
    /// is the failure this field exists to prevent.
    ///
    /// `None` is a core that holds text and refuses every photograph, which is
    /// an honest state and not a failure: a vault with no store refuses binary
    /// bytes rather than writing a row that names bytes nothing kept.
    bytes: Mutex<Option<centraid_blobs::ContentBytes>>,
    /// THE RUNTIME THE FLOWS THAT DIAL A GATEWAY RUN ON (#1029 W15), built
    /// the first time one is asked for. See [`Handle::runtime_handle`].
    runtime: Mutex<Option<Arc<tokio::runtime::Runtime>>>,
    /// A PASS IS RUNNING (#1080). A second `drain` while one runs is refused,
    /// not queued (`phone.proto`): a background window's call must not sit
    /// behind a foreground pass it cannot see and expire holding nothing.
    draining: AtomicBool,
    /// THE FIRST RECONCILE OF THIS CORE'S LIFE HAS RUN (#1080 ruling 7: "on
    /// every launch"). It asks the gateway about every name the ledger
    /// confirms; every later one only about the queue. The first pass that
    /// reaches a gateway runs it when no `reconcile` call has
    /// ([`Handle::owes_full_reconcile`]), so the ledger is squared on every
    /// shell, not only on the one whose upload loop calls the door.
    reconciled: AtomicBool,
    /// THE STORE THIS CORE OPENED ITSELF.
    ///
    /// `Some` only after [`Handle::open_own_bytes`]; a store handed in through
    /// [`Handle::attach_bytes`] belongs to whoever opened it. It is a directory
    /// with no lock and no index, so nothing has to be closed when the core
    /// goes — the next core on the same vault opens the same files.
    owned_bytes: Mutex<Option<centraid_blobs::ContentBytes>>,
    /// Open staging sessions: bytes a shell is streaming in so this core can
    /// name them (#1025 S4). See [`crate::stage`].
    staging: crate::stage::Staging,
    /// THE LIBRARY ITEMS THE LAST PASS ASKED FOR, by the library's own
    /// identifier (R-1080-C39): the parts it planned to seal from each one's
    /// stream. A `begin` for one takes its plan; the next pass replaces them
    /// all.
    library_plan: Mutex<std::collections::BTreeMap<String, crate::stage::Planned>>,
    /// THE FILE THIS CORE WAS OPENED ON, KEPT (#1029 W15).
    ///
    /// The backup plane's files sit **beside the vault file**
    /// (`crate::phone::Plane`), and a pass that had to be told where its own
    /// vault lives would be a second place the path is decided; the shells'
    /// OS-backup exclusion is about exactly that directory, so there is one
    /// expression per path and this is what it reads.
    path: std::path::PathBuf,
    /// THE VAULT'S KEYS, WHEN THE SHELL SUPPLIED A SEED.
    ///
    /// `None` is a core that reads and writes its vault and cannot back up,
    /// which is an honest state (see [`crate::phone`]'s header for why this
    /// library writes no key down).
    keys: Option<crate::phone::Keyring>,
    /// THE BACKUP PLANE'S FILES BESIDE THE VAULT (#1080), with the spool
    /// opened once for the life of the core (see [`crate::phone::Plane`]).
    plane: crate::phone::Plane,
    /// THE LOCKER SESSION (#1047, D-5): a copy of `K` (derived into `keys`
    /// from the seed, Q-1047-11) while the member has unlocked Locker on this
    /// phone, zeroed on relock, and nothing otherwise. See
    /// [`crate::locker::phone`].
    locker: crate::locker::phone::Cell,
    /// THE ON-DEVICE CHAT'S SESSIONS AND ITS VIEW OF THE MODEL SLOT. In memory
    /// only; see [`crate::assist`]. `pub(crate)` because that module is where
    /// `Request::Assist` is answered.
    pub(crate) assist: crate::assist::Hub,
}

/// THE CLOCK AND ID SOURCE A CORE WAS OPENED WITH, kept for the life of the
/// handle (#1025 S2).
///
/// `Arc` rather than `Box`, and both rather than either: a file founded on one
/// clock and written by another would carry rows from two timelines, so the
/// pair travels together or not at all. Kept because a RE-BOOTSTRAP reopens the
/// vault on a file that has just replaced the replica, and the core used to
/// give its clock away at `open` — which silently cost a fixed-clock seat its
/// determinism across the swap.
pub type Stamp = (
    std::sync::Arc<dyn centraid_vault::Clock>,
    std::sync::Arc<dyn centraid_vault::Ids>,
);

/// The opener.
pub struct Core;

impl Core {
    /// Open the file, run migrations, return.
    ///
    /// **Never blocks.** There is no endpoint to start: the phone has no
    /// inbound surface at all (#1029 §6), so a first screen has nothing to
    /// wait on.
    pub fn open(config: CoreConfig) -> Result<Handle> {
        let CoreConfig {
            path,
            ui_thread_name,
            create,
            clock,
            ids,
            expected_digest,
            seed,
            spool_ceiling,
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
        // THE STAMP SURVIVES THE HANDLE (#1025 S2). An injected clock and id
        // source are kept here, not given away, because a restore REOPENS this
        // path on a file that has just replaced it — and a fixed-clock core
        // that silently took the build's default across that swap has lost the
        // determinism it was injected for.
        //
        // A clock with state must be ONE clock and not two, which is why this
        // is an `Arc` rather than a second construction; `crates/vault` already
        // implements `Clock for Arc<T>`, so the vault takes a boxed clone and
        // both sides read the same object.
        let stamp = match (clock, ids) {
            (Some(clock), Some(ids)) => Some((clock, ids)),
            // BOTH OR NEITHER. A file founded on an injected clock and written
            // by the default one would carry rows from two timelines, so a
            // half-injected stamp is treated as none at all — which is what the
            // old `(Some, Some)` match arm already did, stated rather than
            // implied.
            _ => None,
        };
        let founded = path.exists();
        // NO FILE AND NO PERMISSION TO MAKE ONE IS A STATE (#1029 §1). The
        // shell asked to open a vault that is not there — the ordinary shape
        // of a restore that has not landed — and it draws that rather than
        // being handed a failure. Founding an empty one instead would be a
        // silently empty product over the member's own data.
        let vault = if !founded && !create {
            None
        } else {
            Some(Self::open_vault(
                &path,
                founded,
                create,
                stamp.as_ref(),
                None,
            )?)
        };
        // THE VAULT KEYS, IF THE SHELL HAD THEM (#1029 W15). Derived here and
        // never written down: see `crate::phone`'s header.
        let keys = match seed {
            None => None,
            Some((seed, index)) => Some(crate::phone::Keyring::derive(&seed, index)?),
        };
        Ok(Handle {
            plane: crate::phone::Plane::of(&path).with_ceiling(spool_ceiling),
            path,
            keys,
            vault: Mutex::new(vault),
            registry: Registry::with_system_commands()?,
            ui_thread_name,
            events: Arc::new(EventQueue::new()),
            staging: crate::stage::Staging::default(),
            library_plan: Mutex::new(std::collections::BTreeMap::new()),
            closed: AtomicBool::new(false),
            poison: Mutex::new(None),
            session: Mutex::new(Session::new()),
            cancelled: Mutex::new(Vec::new()),
            diagnostics: AtomicU64::new(0),
            bytes: Mutex::new(None),
            runtime: Mutex::new(None),
            draining: AtomicBool::new(false),
            reconciled: AtomicBool::new(false),
            owned_bytes: Mutex::new(None),
            locker: Mutex::new(None),
            assist: crate::assist::Hub::new(),
        })
    }

    /// Open (or create) the file and put the content store beside it.
    ///
    /// Split out of [`Self::open`] because a restore re-opens the same file
    /// after replacing it, and the two must agree about what "open" means down
    /// to the content store.
    pub(crate) fn open_vault(
        path: &std::path::Path,
        founded: bool,
        create: bool,
        stamp: Option<&Stamp>,
        bytes: Option<&centraid_blobs::ContentBytes>,
    ) -> Result<Vault> {
        let path = path.to_path_buf();
        let vault = match stamp {
            // An injected clock stamps BOTH the create and every later write: a
            // file founded on one clock and written on another would carry rows
            // from two timelines. The clone is of the `Arc`, so the reopened
            // file after a re-bootstrap reads the SAME clock a test is holding.
            Some((clock, ids)) => {
                let clock: Box<dyn centraid_vault::Clock> = Box::new(std::sync::Arc::clone(clock));
                let ids: Box<dyn centraid_vault::Ids> = Box::new(std::sync::Arc::clone(ids));
                if founded {
                    Vault::open_with(&path, clock, ids)?
                } else if create {
                    Vault::create_with(&path, clock, ids)?
                } else {
                    return Err(centraid_vault::VaultError::Missing { path }.into());
                }
            }
            None => {
                if founded {
                    Vault::open(&path)?
                } else if create {
                    Vault::create(&path)?
                } else {
                    return Err(centraid_vault::VaultError::Missing { path }.into());
                }
            }
        };
        // THE CONTENT STORE, HANDED IN (#1025 S3, D-1025-S3-1).
        //
        // A device holds ONE content store per vault. Opening a second one
        // here, beside the one the core attached, is how a device once held
        // two, and a photograph written into one could not be displayed from
        // the other.
        //
        // The store belongs to whoever opened it — this core, through
        // [`Handle::open_own_bytes`], or a host that handed one in — so this
        // function takes the store rather than making one, and
        // [`Handle::attach_bytes`] re-attaches it to the vault a restore
        // reopens.
        //
        // `None` is NOT a core that will not open: the vault's rows are still
        // readable and every text write still lands. The binary writes refuse
        // with the sentence `pre_inline_bytes_are_storable` gives them, which
        // names the cause.
        let _ = path;
        Ok(match bytes {
            Some(store) => vault.with_blobs(Box::new(store.clone())),
            None => vault,
        })
    }
}

impl Handle {
    /// The event queue, so a producer (sync, the applier) can push to it.
    #[must_use]
    pub fn events(&self) -> Arc<EventQueue> {
        Arc::clone(&self.events)
    }

    /// Attach THE content store this device holds for this vault (#1025 S3).
    ///
    /// One per vault: the grid reads it and the commands write it
    /// (D-1025-S3-1). Attaching it puts the vault's byte door over it, so
    /// `media.add_asset` spills into it and `content_location` answers with a
    /// file a platform can open.
    ///
    /// A core that is never handed one holds text and refuses photographs,
    /// honestly and by name.
    /// **OPEN THE CONTENT STORE THIS CORE OWNS** (#1029 W6, hand-off 2;
    /// [#1080](https://github.com/srikanth235/centraid/issues/1080)).
    ///
    /// `<vault>.bytes` beside the vault file: a directory of files named by
    /// their BLAKE3, opened synchronously, with nothing to own but the path.
    /// The door also reads the backup ledger beside the vault,
    /// `<vault>.backup.db`, for the originals the operating system's library
    /// holds and the phone never copied (#1080 ruling 6); a ledger that will
    /// not open leaves a door that knows its own files, which is every byte
    /// this core has written.
    ///
    /// Non-fatal by design. A store that will not open leaves the core exactly
    /// as it was — text, and photographs refused by name — because a vault that
    /// would not open its byte store is still a vault whose notes save.
    ///
    /// # Errors
    /// [`CoreError`] wrapping what the store refused. The core is unchanged.
    pub fn open_own_bytes(&self, root: impl AsRef<std::path::Path>) -> Result<()> {
        let root = root.as_ref().to_path_buf();
        let (store, adopted) =
            centraid_blobs::ByteStore::open_adopting(&root).map_err(|error| {
                CoreError::Invariant {
                    context: format!(
                        "the byte store at {} would not open: {error}",
                        root.display()
                    ),
                }
            })?;
        if adopted != centraid_blobs::Adopted::default() {
            tracing::info!(
                blobs = adopted.blobs,
                discarded = adopted.discarded,
                "the byte store adopted the layout it had before #1080"
            );
        }
        let ledger_path = centraid_vault::backup::ledger::Ledger::path_for(&self.path);
        let door = match centraid_vault::backup::ledger::Ledger::open(&ledger_path) {
            Ok(ledger) => {
                centraid_blobs::ContentBytes::new(store).with_ledger(Arc::new(Mutex::new(ledger)))
            }
            Err(error) => {
                tracing::warn!(
                    "the backup ledger at {} did not open; the byte door knows only its \
                     own files: {error}",
                    ledger_path.display()
                );
                centraid_blobs::ContentBytes::new(store)
            }
        };
        if let Ok(mut owned) = self.owned_bytes.lock() {
            *owned = Some(door.clone());
        }
        self.attach_bytes(door);
        Ok(())
    }

    /// A tokio handle for the flows that dial a gateway (#1029 W15, #1080).
    ///
    /// Built the first time it is asked for and kept, so every flow shares one
    /// thread pool and the gateway client's kept connection. It is
    /// multi-threaded because a current-thread runtime under `block_on` is a
    /// deadlock the moment anything it drives waits on another task — a
    /// streamed request body and its connection are two.
    ///
    /// # Errors
    /// [`CoreError::Invariant`] when a runtime will not start.
    pub fn runtime_handle(&self) -> Result<tokio::runtime::Handle> {
        let mut held = self
            .runtime
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(runtime) = held.as_ref() {
            return Ok(runtime.handle().clone());
        }
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .thread_name("centraid-phone")
            .enable_all()
            .build()
            .map_err(|error| CoreError::Invariant {
                context: format!("the phone's runtime would not start: {error}"),
            })?;
        let handle = runtime.handle().clone();
        *held = Some(Arc::new(runtime));
        Ok(handle)
    }

    /// The file this core was opened on.
    #[must_use]
    pub fn path(&self) -> &std::path::Path {
        &self.path
    }

    /// The backup plane's files beside the vault.
    #[must_use]
    pub const fn plane(&self) -> &crate::phone::Plane {
        &self.plane
    }

    /// Whether this core opened and owns its own byte store.
    #[must_use]
    pub fn owns_its_bytes(&self) -> bool {
        self.owned_bytes
            .lock()
            .ok()
            .is_some_and(|held| held.is_some())
    }

    pub fn attach_bytes(&self, bytes: centraid_blobs::ContentBytes) {
        if let Ok(mut held) = self.bytes.lock() {
            *held = Some(bytes.clone());
        }
        // AND ONTO THE VAULT THAT IS ALREADY OPEN. `with_blobs` consumes the
        // vault, so it is taken out of the mutex and put back — which is safe
        // exactly because the mutex is held across both halves.
        if let Ok(mut vault) = self.vault.lock()
            && let Some(open) = vault.take()
        {
            *vault = Some(open.with_blobs(Box::new(bytes)));
        }
    }

    /// The content store, when one is attached. The byte plane's own half of a
    /// pass reads it — and so does an eviction sweep, which is why it is
    /// reachable rather than only wired.
    #[must_use]
    pub fn bytes(&self) -> Option<centraid_blobs::ContentBytes> {
        self.bytes.lock().ok().and_then(|held| held.clone())
    }

    /// DERIVE THE TIERS THIS VAULT IS MISSING, once (#1025 S3, D-1025-S7-53).
    ///
    /// The process calls this at start, after the byte door is attached. It is
    /// bounded (`limit` items) and resumable — an item that gained its rows is
    /// no longer a candidate — so a large old vault converges over several
    /// starts rather than holding the first one open.
    ///
    /// Non-fatal by construction for the caller too: it returns the number of
    /// items that gained tiers, and a vault with no byte store returns zero.
    ///
    /// **THE GUARD IS AN OPEN VAULT, AND NOTHING ELSE** (#1029 §1). It used to
    /// ask the role as well, and the role predicate was wrong twice over: the
    /// clause `!self.is_gateway() || self.holds_a_replica()` fired on every
    /// gateway, so the backfill this command exists for never ran once. There
    /// is one role now, so the only question left is whether there is a file.
    pub fn derive_missing_tiers(&self, limit: usize) -> Result<u64> {
        // NO FILE, NOTHING TO SWEEP. `with_vault` below would answer
        // `Unpaired`, and an error is the wrong shape for "there is nothing
        // here": this returns an honest zero.
        if !self.holds_a_replica() {
            return Ok(0);
        }
        // The owner of this device's own vault — the same principal every
        // other command on this core runs as (`Handle::owner`). There is no
        // remote caller to attribute housekeeping to, and inventing one would
        // be claiming an authority nothing granted.
        let principal = self.owner();
        let command = centraid_vault::Command::new(
            "media.derive_missing",
            serde_json::json!({ "limit": limit }),
        );
        let outcome = self.with_vault(|vault| {
            vault
                .execute(&self.registry, &principal, &command)
                .map_err(Into::into)
        })?;
        Ok(outcome
            .output
            .get("derived")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or_default())
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

    /// CLOSE THE FILE ITSELF, so what is on disk is the whole vault.
    ///
    /// [`Self::close`] releases the waiters and leaves the connection to the
    /// process's teardown, which is right for a shell: the file is reopened on
    /// the next launch and SQLite's `-wal` is part of the vault, not a
    /// leftover. It is WRONG for a process whose artifact is the file — a
    /// fixture writer, a seeder — because a `-wal` that is never checkpointed
    /// holds every row the run wrote, and a copy of the `.db` alone is an
    /// EMPTY vault that opens without an error and draws nothing.
    ///
    /// That is not hypothetical: `seed-demo-vault` left a 4 KB file beside a
    /// 19 MB `-wal`, `mobile/scripts/demo-vault.sh` copied the `.db` and
    /// dropped the sidecars by design, and the phone opened a vault with no
    /// rows in it. Nothing failed anywhere along that path.
    ///
    /// So this is the door that ENDS a vault: the connection is taken out and
    /// [`Vault::finish`]ed — the log is checkpointed into the file and the
    /// connection closed — and a refusal is returned rather than swallowed, a
    /// file that would not close being a fixture that lies. `Vault::finish`
    /// carries the rest of the argument, including why a plain close cannot do
    /// this and why a vault a spool is tracking must not come through here.
    ///
    /// Idempotent, and everything after it is [`CoreError::Unpaired`]:
    /// [`Self::with_vault`] answers that for a core holding no file, which is
    /// the state this leaves behind.
    pub fn close_file(&self) -> Result<()> {
        let taken = self
            .vault
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take();
        match taken {
            Some(vault) => Ok(vault.finish()?),
            None => Ok(()),
        }
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
    ///
    /// Refuses [`CoreError::Unpaired`] when this seat holds no copy. That is a
    /// STATE the shell draws — "scan a pairing code" — and not a fault: the
    /// alternative was `Core::open` failing outright, which is what left a
    /// phone's replica to be placed by a shell script.
    pub fn with_vault<T>(&self, body: impl FnOnce(&Vault) -> Result<T>) -> Result<T> {
        self.check_open()?;
        let held = self
            .vault
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let Some(vault) = held.as_ref() else {
            return Err(CoreError::Unpaired);
        };
        body(vault)
    }

    /// Run a body with the vault when there is one, and with `None` when this
    /// core holds no file: what a read that also answers without a vault —
    /// the backup status — goes through.
    pub fn with_vault_if_any<T>(
        &self,
        body: impl FnOnce(Option<&Vault>) -> Result<T>,
    ) -> Result<T> {
        self.check_open()?;
        let held = self
            .vault
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        body(held.as_ref())
    }

    /// Whether this core holds a copy of the vault.
    ///
    /// The fact a shell draws its first screen from, alongside
    /// [`crate::phone::backup_status`]'s `destinations`: no file, versus a
    /// file with no gateway, versus both.
    #[must_use]
    pub fn holds_a_replica(&self) -> bool {
        self.vault
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .is_some()
    }

    /// The command catalogue this core serves.
    #[must_use]
    pub const fn registry(&self) -> &Registry {
        &self.registry
    }

    /// WHO THIS CORE'S COMMANDS RUN AS (#1029 §1).
    ///
    /// Taken from the handle and never from the request. See
    /// [`crate::api::invoke`] for why there is nothing else it could be, and
    /// [`OWNER_DEVICE`] for what a receipt ends up naming.
    #[must_use]
    pub fn owner(&self) -> centraid_vault::Principal {
        centraid_vault::Principal::owner(OWNER_DEVICE)
    }

    /// WHETHER THE VAULT THIS CORE HOLDS IS A SAMPLE VAULT, finished or not
    /// (`centraid_vault::bootstrap::SampleMark`). False for a core holding no
    /// vault, and for a vault whose mark will not read — a refusal below is a
    /// guard, and a vault that cannot answer is not one this guard owns.
    #[must_use]
    pub fn holds_a_sample(&self) -> bool {
        self.vault
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .as_ref()
            .and_then(|vault| vault.sample_mark().ok().flatten())
            .is_some()
    }

    // ------------------------------------------------------------ internals --

    /// Refuse `what` when this core holds a sample vault. See
    /// [`CoreError::SampleVault`].
    fn refuse_a_sample(&self, what: &'static str) -> Result<()> {
        if self.holds_a_sample() {
            return Err(CoreError::SampleVault { what });
        }
        Ok(())
    }

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
            K::Page(page_request) => Ok(response(wire::response::Kind::Page(
                self.with_vault(|vault| crate::api::page(vault, page_request))?,
            ))),
            K::ContentUrls(refs) => Ok(response(wire::response::Kind::ContentUrls(
                self.with_vault(|vault| crate::api::content_urls(vault, refs))?,
            ))),
            K::Stage(frame) => Ok(response(wire::response::Kind::Stage(self.stage(frame)?))),
            // THE VAULT IS FOUNDED INSIDE THE FILE THIS HANDLE IS OPEN ON
            // (#1029 W5, hand-off 1). `with_vault` is what answers
            // `CoreError::Unpaired` when there is no file at all, which is the
            // correct refusal: founding needs a file, and a path that opened is
            // what `create` produced.
            //
            // A SAMPLE FOUND SEALS ITS LOCKER UNDER THIS CORE'S OWN KEYS: the
            // ones derived at open from the member's seed and this vault's
            // index, lent for the length of the found. A core opened with no
            // seed lends none, and the sample has no Locker.
            K::Found(request) => Ok(response(wire::response::Kind::Found(self.with_vault(
                |vault| {
                    let changes = crate::events::ChangeFeed::new(self.events());
                    let sealing = self.keys.as_ref().map(|keys| crate::sample::Sealing {
                        keys,
                        cell: &self.locker,
                        changes: &changes,
                    });
                    crate::api::found(
                        vault,
                        &self.registry,
                        &self.owner(),
                        request,
                        sealing.as_ref(),
                    )
                },
            )?))),
            K::Command(command) => {
                let changes = crate::events::ChangeFeed::new(self.events());
                Ok(response(wire::response::Kind::Command(self.with_vault(
                    |vault| {
                        // A LOCKER SECRET IS SEALED HERE, before the vault
                        // sees it (#1047, D-5): the command plane refuses
                        // plaintext, and the core is the one holder of `K`.
                        let sealed =
                            crate::locker::phone::seal_command(vault, &self.locker, command)?;
                        let command = match sealed {
                            Some(input) => &wire::Command {
                                input,
                                ..command.clone()
                            },
                            None => command,
                        };
                        crate::api::invoke(vault, &self.registry, &self.owner(), command, &changes)
                    },
                )?)))
            }
            // THE LOCKER SESSION (#1047, D-5). See `crate::locker::phone`.
            K::Locker(request) => {
                let changes = crate::events::ChangeFeed::new(self.events());
                Ok(response(wire::response::Kind::Locker(self.with_vault(
                    |vault| {
                        crate::locker::phone::answer(
                            vault,
                            &self.registry,
                            &self.owner(),
                            self.keys.as_ref(),
                            &self.locker,
                            request,
                            &changes,
                        )
                    },
                )?)))
            }
            // THE PASS (#1080). Not through `with_vault` for its whole length:
            // the vault is held for the snapshot's copy and the reads a pass
            // makes, never across the network, so a screen's reads go on while
            // a backup runs.
            //
            // A SAMPLE VAULT NEVER DRAINS: no row of the scenario may reach the
            // member's gateway (R-SAMPLE). Asked before the pass starts, so a
            // refusal costs nothing.
            K::Drain(request) => {
                self.refuse_a_sample("back up")?;
                Ok(response(wire::response::Kind::Drain(self.drain(request)?)))
            }
            // PAIRING NEEDS NO VAULT TO BE OPEN: it needs the vault's keys,
            // and keeps the gateway in the ledger beside the file.
            // A SAMPLE VAULT NEVER PAIRS, for the drain's reason: a paired
            // vault is one the next pass would back up.
            K::PairPhone(request) => {
                self.refuse_a_sample("pair")?;
                let runtime = self.runtime_handle()?;
                Ok(response(wire::response::Kind::PairPhone(
                    crate::phone::pair::pair(&self.plane, self.keys.as_ref(), request, &runtime)?,
                )))
            }
            // NOR DOES A RESTORE, and for the same reason with more force: the
            // vault it is about does not exist on this device yet. That is the
            // whole of what it is for (F2).
            K::Restore(request) => {
                let runtime = self.runtime_handle()?;
                Ok(response(wire::response::Kind::Restore(
                    crate::phone::restore::run(&self.path, request, &runtime)?,
                )))
            }
            // A STATUS READ ANSWERS WITH OR WITHOUT A VAULT: the ledger is
            // beside the file, and the content counts need the file.
            K::BackupStatus(_) => Ok(response(wire::response::Kind::BackupStatus(
                self.with_vault_if_any(|vault| {
                    crate::phone::backup_status(&self.plane, vault, self.keys.as_ref())
                })?,
            ))),
            // THE 24 WORDS NEED NO VAULT EITHER (#1047 E1): a first launch
            // mints them before there is a vault to found, and a restore
            // judges them before there is one to lay down. Pure functions of
            // the words and the OS's entropy — see `phone::phrase`.
            // THE ON-DEVICE CHAT (see `assist.proto`). A turn runs on this
            // thread and holds the vault only inside a read.
            K::Assist(request) => Ok(response(wire::response::Kind::Assist(
                crate::assist::answer(self, request)?,
            ))),
            K::Phrase(request) => Ok(response(wire::response::Kind::Phrase(
                crate::phone::phrase::answer(request)?,
            ))),
            // THE KEEP LIST AND THE CENSUS (#1029, the photos port). Through
            // `with_vault` for every arm, because the vault lock is what
            // serialises two toggles of one list — see `originals::answer`.
            K::Originals(request) => Ok(response(wire::response::Kind::Originals(
                self.with_vault(|vault| crate::originals::answer(vault, &self.path, request))?,
            ))),
            // AN APP'S OWN QUERY, RUN WHERE IT IS WRITTEN (#1046). Through
            // `with_vault` like a page read, because it IS page reads — the
            // app crate's, through `app_query::VaultDoor`.
            K::AppQuery(request) => Ok(response(wire::response::Kind::AppQuery(Box::new(
                self.with_vault(|vault| crate::app_query::answer(vault, request))?,
            )))),
            // THE BACKUP PLANE'S DOORS BESIDE THE PASS (#1080). See
            // `phone.proto` and `crate::phone`.
            // A sample's objects are handed to no upload, for the drain's reason.
            K::Handoff(request) => {
                self.refuse_a_sample("back up")?;
                let runtime = self.runtime_handle()?;
                Ok(response(wire::response::Kind::Handoff(
                    crate::phone::drain::handoff(&self.plane, self.keyring()?, request, &runtime)?,
                )))
            }
            K::Settle(request) => Ok(response(wire::response::Kind::Settle(
                crate::phone::drain::settle(&self.plane, self.keyring()?, request)?,
            ))),
            K::FetchOriginal(request) => {
                let runtime = self.runtime_handle()?;
                Ok(response(wire::response::Kind::FetchOriginal(
                    crate::phone::fetch::fetch_original(self, self.keyring()?, request, &runtime)?,
                )))
            }
            K::Pins(_) => Ok(response(wire::response::Kind::Pins(crate::phone::pins(
                &self.plane,
            )?))),
            K::Reconcile(_) => {
                let runtime = self.runtime_handle()?;
                let full = self.owes_full_reconcile();
                let answer =
                    crate::phone::drain::reconcile(&self.plane, self.keyring()?, &runtime, full)?;
                if full && answer.reachable {
                    self.reconciled_fully();
                }
                Ok(response(wire::response::Kind::Reconcile(answer)))
            }
            K::ForgetDestination(request) => {
                let runtime = self.runtime_handle()?;
                let vault = self.keys.as_ref().map(crate::phone::Keyring::vault_id);
                Ok(response(wire::response::Kind::ForgetDestination(
                    crate::phone::forget_destination(&self.plane, vault, &runtime, request)?,
                )))
            }
            K::Releasable(request) => {
                let keyring = self.keyring()?;
                Ok(response(wire::response::Kind::Releasable(
                    self.with_vault(|vault| {
                        crate::phone::releasable(&self.plane, &self.path, vault, keyring, request)
                    })?,
                )))
            }
            K::Released(request) => {
                let (answer, assets) =
                    self.with_vault(|vault| crate::phone::released(&self.plane, vault, request))?;
                crate::events::ChangeFeed::new(self.events()).blobs_arrived(&assets);
                Ok(response(wire::response::Kind::Released(answer)))
            }
        }
        .map_err(|error| {
            tracing::debug!(request_id, %error, "the core refused a request");
            error
        })
    }

    /// The keys a door that seals, signs or names needs, or the refusal a
    /// shell draws as "unlock to back up".
    fn keyring(&self) -> Result<&crate::phone::Keyring> {
        self.keys.as_ref().ok_or_else(|| CoreError::Unavailable {
            reason: "this core holds no vault keys, so it cannot back up; open it with a seed"
                .to_owned(),
        })
    }

    /// Whether this core has yet to ask a gateway about every name its ledger
    /// confirms (#1080 ruling 7, "on every launch").
    pub(crate) fn owes_full_reconcile(&self) -> bool {
        !self.reconciled.load(Ordering::SeqCst)
    }

    /// This core asked a gateway about every name its ledger confirms.
    pub(crate) fn reconciled_fully(&self) {
        self.reconciled.store(true, Ordering::SeqCst);
    }

    /// One pass, one at a time.
    fn drain(&self, request: &wire::DrainRequest) -> Result<wire::DrainResponse> {
        let keyring = self.keyring()?;
        if !self.holds_a_replica() {
            return Err(CoreError::Unpaired);
        }
        if self
            .draining
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return Err(CoreError::InvalidRequest {
                detail: "a drain is already running".to_owned(),
            });
        }
        let runtime = self.runtime_handle();
        let asked = request.asked.then(|| self.plane.ask());
        let answer =
            runtime.and_then(|runtime| crate::phone::drain::run(self, keyring, request, &runtime));
        drop(asked);
        self.draining.store(false, Ordering::SeqCst);
        answer
    }

    /// One staging frame from a shell: the write half's door (#1025 S4;
    /// #1080). See [`crate::stage`]. `end` records what the bytes are before it
    /// answers, so the handle it hands back names bytes this device holds — a
    /// handle for bytes nowhere is a row that will commit and never render.
    fn stage(&self, frame: &wire::StageRequest) -> Result<wire::StageResponse> {
        use wire::stage_request::Kind as S;
        let kind = match frame.kind.as_ref() {
            Some(S::Begin(begin)) => wire::stage_response::Kind::Begun(
                self.staging.begin(begin, self.stage_doors(begin)?)?,
            ),
            Some(S::Chunk(chunk)) => wire::stage_response::Kind::Chunked(self.staging.chunk(
                &chunk.staging_id,
                chunk.seq,
                &chunk.payload,
            )?),
            Some(S::End(end)) => wire::stage_response::Kind::Handle(
                self.record_staged(self.staging.end(&end.staging_id)?)?,
            ),
            None => {
                return Err(CoreError::InvalidRequest {
                    detail: "a staging request carries one of begin, chunk or end".to_owned(),
                });
            }
        };
        Ok(wire::StageResponse { kind: Some(kind) })
    }

    /// What a staging session may write to: the content store, and — for an
    /// item from the library, when a gateway is paired and the keys are here —
    /// the spool, under its budget, with what the last pass planned for the
    /// item if it asked for it.
    fn stage_doors(&self, begin: &wire::StageBegin) -> Result<crate::stage::Doors> {
        let store = self.bytes().map(|door| door.store().clone());
        let plane = &self.plane;
        let paired = !plane
            .ledger()?
            .destinations()
            .map_err(crate::phone::plane_error)?
            .is_empty();
        let seal = match (&self.keys, paired) {
            (Some(keys), true) => Some(crate::stage::SealInto {
                keys: keys.backup.clone(),
                spool: plane.spool()?,
                budget: plane.budget(),
                planned: if begin.os_ref.is_empty() {
                    None
                } else {
                    self.take_planned(&begin.os_ref)
                },
            }),
            _ => None,
        };
        Ok(crate::stage::Doors { store, seal })
    }

    /// The plan the last pass made for the library item `os_ref`, taken: one
    /// stream uses it (R-1080-C39).
    fn take_planned(&self, os_ref: &str) -> Option<crate::stage::Planned> {
        self.library_plan
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(os_ref)
    }

    /// What a pass planned for the library items it asked for, in place of
    /// the last pass's plan (R-1080-C39).
    pub(crate) fn plan_library(
        &self,
        plan: std::collections::BTreeMap<String, crate::stage::Planned>,
    ) {
        *self
            .library_plan
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = plan;
    }

    /// Record a closed session: owned bytes are staged for the command that
    /// names them, a derivative beside its parent, and a library item in the
    /// ledger — where it lives, and its sealed parts in the queue.
    fn record_staged(&self, staged: crate::stage::Staged) -> Result<wire::StageHandle> {
        use crate::stage::Staged;
        match staged {
            Staged::Owned {
                stored,
                media_type,
                derivative,
            } => {
                let hash = stored.hash.to_hex();
                let byte_size = i64::try_from(stored.bytes).unwrap_or(i64::MAX);
                self.with_vault(|vault| {
                    match derivative {
                        Some((variant_of, variant)) => {
                            vault.stage_derivative(&centraid_vault::content::StagedDerivative {
                                hash: hash.clone(),
                                byte_size,
                                media_type,
                                variant,
                                variant_of,
                            })?;
                        }
                        None => {
                            vault.stage_bytes(&[centraid_vault::content::NeededBytes {
                                hash: hash.clone(),
                                byte_size,
                                media_type,
                            }])?;
                        }
                    }
                    Ok(())
                })?;
                Ok(wire::StageHandle {
                    content_hash: hash,
                    byte_size: stored.bytes,
                    already_held: stored.already_held,
                })
            }
            Staged::Library {
                h,
                len,
                media_type,
                os_ref,
                edited,
                sealed,
            } => {
                let plane = &self.plane;
                let ledger = plane.ledger()?;
                let in_store = self.bytes().is_some_and(|door| {
                    door.store()
                        .is_complete(centraid_blobs::ContentHash::from_bytes(*h.as_bytes()))
                        .unwrap_or(false)
                });
                let already_held = in_store
                    || ledger
                        .local(&h)
                        .map_err(crate::phone::plane_error)?
                        .is_some();
                ledger
                    .put_local(&centraid_vault::backup::ledger::LocalBytes {
                        hash: h,
                        source: centraid_vault::backup::ledger::LocalSource::Os,
                        os_ref: Some(os_ref),
                        verified_ms: Some(crate::phone::now_ms()),
                        edited,
                    })
                    .map_err(crate::phone::plane_error)?;
                if let Some(sealed) = sealed {
                    crate::phone::drain::queue_sealed(
                        &plane.spool()?,
                        &ledger,
                        &sealed,
                        &media_type,
                    )?;
                }
                let hash = h.to_hex();
                self.with_vault(|vault| {
                    vault.stage_bytes(&[centraid_vault::content::NeededBytes {
                        hash: hash.clone(),
                        byte_size: i64::try_from(len).unwrap_or(i64::MAX),
                        media_type,
                    }])?;
                    Ok(())
                })?;
                Ok(wire::StageHandle {
                    content_hash: hash,
                    byte_size: len,
                    already_held,
                })
            }
        }
    }

    fn hello(&self, peer: &wire::Hello) -> wire::Hello {
        // The handshake's JUDGEMENT is lane C's; the core's answer is what this
        // build is. Judging here too would be two places that can disagree.
        let _ = peer;
        let mut hello = centraid_protocol::local_hello(env!("CARGO_PKG_VERSION"), CAPABILITIES);
        // WHAT THIS BUILD IS, on the first message (#1020 wave 3, lane E
        // finding 3). Filled here rather than in `local_hello` because the
        // identity is the CORE's, and `crates/protocol` is linked into more
        // than one artifact.
        hello.identity = Some(crate::identity::ArtifactIdentity::current().to_wire());
        hello
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
            | K::Page(_)
            | K::Command(_)
            // A LOCATION LOOKUP IS BOUNDED: it is capped at
            // `api::MAX_CONTENT_URLS` rows of index reads and moves no bytes.
            | K::ContentUrls(_)
            // ONE STAGING FRAME IS BOUNDED, whatever the whole object costs:
            // a chunk is at most `stage::MAX_CHUNK_BYTES` and `end` hashes
            // what is already in memory. The UNBOUNDED thing is the shell's
            // loop, which the shell already owns and can stop between frames.
            | K::Stage(_)
            // FOUNDING IS ONE COMMIT and it is the shortest write this ABI
            // takes: two rows, the relation vocabulary, a calendar and two
            // policy rows. A cancel arriving mid-found could not stop it
            // anyway — the commit guard is what decides, and it is
            // all-or-nothing.
            | K::Found(_)
            // PAIRING IS BOUNDED: one payload, one pairing, a claim retried
            // at most three times. It talks to the network, which is not the
            // same question — `Bounded` is "finishes on its own bounded by its
            // own limit", and a pairing that cannot reach the gateway fails
            // rather than running on.
            | K::PairPhone(_)
            // A STATUS READ IS BOUNDED AND DIALS NOTHING: the ledger, a spool
            // measurement and one read of the vault's content rows.
            | K::BackupStatus(_)
            // THE ORIGINALS ASK IS BOUNDED: one small file, and for a census
            // one listing of the store and one read of the library's rows. It
            // moves no byte and dials nothing.
            | K::Originals(_)
            // AN APP QUERY IS BOUNDED BY ITS OWN STATED CEILINGS: every join
            // walks a declared fan-out and every expansion a declared instance
            // cap, and reaching one is `ReadBoundReached`, not a longer read.
            | K::AppQuery(_)
            // A LOCKER STEP IS BOUNDED: one key load, one receipt, one cell.
            | K::Locker(_)
            // A PHRASE STEP IS 24 WORDS AND ONE PBKDF2 (#1047 E1).
            | K::Phrase(_)
            // SEVEN OF THE BACKUP PLANE'S DOORS ARE BOUNDED (#1080).
            // `handoff` answers at most the batch it was asked for, `settle`
            // records what the shell already heard, `pins` is one read of the
            // device's ledger and `forget_destination` one read, one revoke
            // and one write, `reconcile` asks `exists` once per thousand names
            // the ledger holds — a count the ledger bounds, and the network is
            // not the same question, as with `pair_phone` — `releasable` reads
            // the ledger and the rows up to its limit, and `released` forgets
            // the hashes it was handed.
            | K::Handoff(_)
            | K::Settle(_)
            | K::Pins(_)
            | K::Reconcile(_)
            | K::ForgetDestination(_)
            | K::Releasable(_)
            | K::Released(_)
            // A CHAT TURN IS BOUNDED BY ITS TOKEN CEILINGS (96 to route, 64 to
            // phrase) and one read. It stops through `AssistCancel`, not
            // through this registry, so it is not classed cancellable here.
            | K::Assist(_),
        )
        | None => RequestKind::Bounded,
        // A DRAIN IS AS LONG AS THE SPOOL IS and a RESTORE as long as the
        // vault is. Both are cancellable, and a drain has a deadline of its
        // own besides — the two are different stops and a shell may use
        // either: `Cancel` is the member leaving the screen, the deadline is
        // the operating system taking the window back.
        //
        // AND A FETCHED ORIGINAL IS AS LONG AS THE ORIGINAL IS (#1080): a
        // film can be gigabytes, and a member who leaves the lightbox has
        // stopped wanting it.
        Some(K::Drain(_) | K::Restore(_) | K::FetchOriginal(_)) => RequestKind::Unbounded,
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
        fn founded() -> Self {
            let dir = centraid_ontology::golden::scratch_dir();
            std::fs::create_dir_all(&dir).expect("the directory is made");
            let handle = Core::open(CoreConfig::new(dir.join("vault.db"))).expect("it opens");
            handle
                .with_vault(|vault| Ok(vault.found("Test", "Owner")?))
                .expect("it founds");
            Self { dir, handle }
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    /// **HAND-OFF 2, ANSWERED.** A core that opens its own byte store holds
    /// photographs; one that does not holds text and says so. The store is
    /// `<vault>.bytes`, and its door reads the backup ledger beside the vault
    /// for what the operating system's library holds (#1080).
    #[test]
    fn a_core_that_opens_its_own_bytes_can_hold_a_photograph() {
        use centraid_vault::bytes::BlobStore as _;

        let scratch = Scratch::founded();
        assert!(
            !scratch.handle.owns_its_bytes(),
            "a core holds text until it is asked for a store"
        );
        assert!(scratch.handle.bytes().is_none());

        scratch
            .handle
            .open_own_bytes(scratch.dir.join("vault.bytes"))
            .expect("the byte store opens");
        assert!(scratch.handle.owns_its_bytes());

        let door = scratch.handle.bytes().expect("a door is attached");
        let photograph = b"a camera original's bytes".repeat(64);
        let id = door.put(&photograph).expect("the store takes it");
        assert!(door.has(&id).expect("it answers"), "the store lost it");
        assert_eq!(door.get(&id).expect("it reads back"), photograph);
        assert!(
            door.path_of(&id).expect("it answers").is_some(),
            "nothing is inlined, so a grid has a file to open"
        );
        assert!(door.ledger().is_some(), "the door reads the backup ledger");
        assert!(
            scratch.dir.join("vault.backup.db").is_file(),
            "the ledger is beside the vault, where the backup plane keeps it"
        );
    }

    /// A PHOTOGRAPH'S BYTES, LOCATED OVER THE WIRE (#1080 ruling 6): a path for
    /// the store's own file, the library's identifier for an original the
    /// operating system's library holds and the phone never copied, and
    /// neither for bytes that are on this device nowhere.
    #[test]
    fn content_urls_answer_the_store_the_library_or_nowhere() {
        const ONE_PIXEL_PNG: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
        let scratch = Scratch::founded();
        scratch
            .handle
            .open_own_bytes(scratch.dir.join("vault.bytes"))
            .expect("the byte store opens");
        let Some(wire::response::Kind::Command(outcome)) = scratch
            .handle
            .call(&wire::Request {
                kind: Some(wire::request::Kind::Command(wire::Command {
                    name: "media.add_asset".to_owned(),
                    input: serde_json::to_vec(&serde_json::json!({
                        "data_uri": format!("data:image/png;base64,{ONE_PIXEL_PNG}"),
                        "kind": "photo",
                    }))
                    .expect("json"),
                    invoke_key: "content-urls-library".to_owned(),
                    ..wire::Command::default()
                })),
            })
            .expect("the command answers")
            .kind
        else {
            panic!("a command answers with an outcome");
        };
        assert_eq!(
            outcome.status,
            wire::CommandStatus::Executed as i32,
            "{}",
            outcome.reason
        );
        let output: serde_json::Value =
            serde_json::from_slice(&outcome.output).expect("the output is JSON");
        let reference = wire::ContentRef {
            content_id: output["content_id"]
                .as_str()
                .expect("a content id")
                .to_owned(),
            owner_type: "media.asset".to_owned(),
            owner_id: output["asset_id"].as_str().expect("an asset id").to_owned(),
        };
        let locate = || {
            let Some(wire::response::Kind::ContentUrls(urls)) = scratch
                .handle
                .call(&wire::Request {
                    kind: Some(wire::request::Kind::ContentUrls(wire::ContentUrlRequest {
                        refs: vec![reference.clone()],
                    })),
                })
                .expect("the lookup answers")
                .kind
            else {
                panic!("a lookup answers with locations");
            };
            urls.urls.into_iter().next().expect("one answer per ref")
        };

        let stored = locate();
        assert_eq!(stored.source, wire::ContentSource::Store as i32);
        let path = std::path::PathBuf::from(stored.path.expect("a path for the store"));
        assert!(stored.os_ref.is_empty());

        let door = scratch.handle.bytes().expect("a door");
        let hash = path
            .file_name()
            .and_then(|name| name.to_str())
            .expect("a blob is named by its hash")
            .to_owned();
        std::fs::remove_file(&path).expect("the store's copy goes");
        let local = centraid_vault::backup::ledger::LocalBytes {
            hash: centraid_vault::backup::naming::PlaintextHash::from_hex(&hash).expect("a hash"),
            source: centraid_vault::backup::ledger::LocalSource::Os,
            os_ref: Some("library-item-1".to_owned()),
            verified_ms: Some(1),
            edited: false,
        };
        let ledger = door.ledger().expect("the door reads the ledger");
        ledger
            .lock()
            .expect("the ledger")
            .put_local(&local)
            .expect("records");
        let in_library = locate();
        assert_eq!(in_library.source, wire::ContentSource::OsLibrary as i32);
        assert_eq!(in_library.os_ref, "library-item-1");
        assert_eq!(
            in_library.path, None,
            "a path is answered for the store only"
        );
        assert!(
            in_library.absent_reason.is_empty(),
            "the bytes are on this device"
        );

        ledger
            .lock()
            .expect("the ledger")
            .forget_local(&local.hash)
            .expect("forgets");
        let nowhere = locate();
        assert_eq!(nowhere.source, wire::ContentSource::None as i32);
        assert!(nowhere.path.is_none() && nowhere.os_ref.is_empty());
        assert!(!nowhere.absent_reason.is_empty());
    }

    /// A core over a file `create` made and nothing has founded.
    ///
    /// The state a phone's shelf is in between [`Core::open`] with `create` and
    /// the found that follows it — which is a state nothing could leave over
    /// this ABI until #1029 W5 added the door.
    fn unfounded() -> Scratch {
        let dir = centraid_ontology::golden::scratch_dir();
        std::fs::create_dir_all(&dir).expect("the directory is made");
        let handle = Core::open(CoreConfig::new(dir.join("vault.db"))).expect("it opens");
        Scratch { dir, handle }
    }

    /// HAND-OFF 1, OVER THE ENVELOPE AND NOT JUST THE FUNCTION.
    ///
    /// `crates/core`'s `api::found` has its own tests; this is the one that
    /// proves a SHELL can reach it — the `Request` arm dispatches, the
    /// `Response` arm comes back, and the file names itself afterwards.
    #[test]
    fn a_found_request_over_the_envelope_makes_the_file_a_vault() {
        let scratch = unfounded();
        assert_eq!(
            scratch
                .handle
                .with_vault(|vault| Ok(vault.vault_id()?))
                .expect("the vault answers"),
            None,
            "a created file holds no vault"
        );

        let request = wire::Request {
            kind: Some(wire::request::Kind::Found(wire::FoundRequest {
                display_name: "Tahoe".to_owned(),
                owner_name: "Me".to_owned(),
                ..wire::FoundRequest::default()
            })),
        };
        let Some(wire::response::Kind::Found(answer)) =
            scratch.handle.call(&request).expect("it answers").kind
        else {
            panic!("a found response comes back");
        };
        assert!(!answer.vault_id.is_empty());

        assert_eq!(
            scratch
                .handle
                .with_vault(|vault| Ok(vault.vault_id()?))
                .expect("the vault answers"),
            Some(answer.vault_id),
            "the file now names the vault the found made"
        );

        // A SECOND FOUND OVER THE SAME ENVELOPE IS REFUSED, and a shell
        // branches on the code rather than on a sentence.
        let refusal = scratch
            .handle
            .call(&request)
            .expect_err("a second found is refused");
        assert_eq!(refusal.code(), wire::ErrorCode::VaultAlreadyHeld);
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

    /// OPEN TOUCHES NOTHING BUT THE FILE (#1029 §6).
    ///
    /// The proof used to be that `start_endpoint` was a separate call that
    /// answered `NotYetAvailable`. There is no endpoint to start any more — the
    /// phone has no inbound surface at all — so the proof is that a core opens,
    /// founds and answers from the file it was given and nothing else.
    #[test]
    fn open_returns_with_a_vault_and_no_second_surface() {
        let scratch = Scratch::founded();
        assert!(scratch.handle.holds_a_replica());
        assert!(
            scratch
                .handle
                .with_vault(|vault| Ok(vault.vault_id()?))
                .expect("the vault answers")
                .is_some()
        );
    }

    #[test]
    fn a_handshake_is_answered_with_what_this_build_is() {
        let scratch = Scratch::founded();
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
        let handle =
            Core::open(CoreConfig::new(dir.join("vault.db")).expecting_digest("aaaa1111bbbb2222"))
                .expect("a dev core loads for a dev shell, loudly");
        assert!(handle.holds_a_replica());
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
        let scratch = Scratch::founded();
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
    fn a_request_with_no_kind_is_unsupported_and_not_a_panic() {
        let scratch = Scratch::founded();
        assert!(matches!(
            scratch.handle.call(&wire::Request { kind: None }),
            Err(CoreError::Unsupported { .. })
        ));
    }

    #[test]
    fn a_bounded_read_refuses_to_be_cancelled_and_says_so() {
        let scratch = Scratch::founded();
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
        // THE PHONE'S TWO FLOWS ARE UNBOUNDED (#1029 W15). `backup_now` was
        // the only one and it is retired; `snapshot_head` was the other and
        // went in #1025 S7, item 5.
        assert_eq!(
            request_kind(&wire::Request {
                kind: Some(wire::request::Kind::Drain(wire::DrainRequest {
                    deadline_ms: 0,
                    ..wire::DrainRequest::default()
                })),
            }),
            RequestKind::Unbounded
        );
        assert_eq!(
            request_kind(&wire::Request {
                kind: Some(wire::request::Kind::Restore(wire::RestoreRequest::default())),
            }),
            RequestKind::Unbounded
        );
        // A FETCHED ORIGINAL IS AS LONG AS THE ORIGINAL (#1080), and the
        // backup plane's other doors are bounded.
        assert_eq!(
            request_kind(&wire::Request {
                kind: Some(wire::request::Kind::FetchOriginal(
                    wire::FetchOriginalRequest::default()
                )),
            }),
            RequestKind::Unbounded
        );
        for bounded in [
            wire::request::Kind::Handoff(wire::HandoffRequest::default()),
            wire::request::Kind::Settle(wire::SettleRequest::default()),
            wire::request::Kind::Pins(wire::PinsRequest {}),
            wire::request::Kind::Reconcile(wire::ReconcileRequest {}),
            wire::request::Kind::ForgetDestination(wire::ForgetDestinationRequest::default()),
            wire::request::Kind::Releasable(wire::ReleasableRequest::default()),
            wire::request::Kind::Released(wire::ReleasedRequest::default()),
        ] {
            assert_eq!(
                request_kind(&wire::Request {
                    kind: Some(bounded.clone()),
                }),
                RequestKind::Bounded,
                "{bounded:?} is one batch, one ledger read or write, or a ledger-bounded ask"
            );
        }
        // AND THE TWO BESIDE THEM ARE BOUNDED. A status read is a spool
        // measurement; a pairing is one ticket and one redemption. Talking to
        // the network is not the same question as being unbounded.
        assert_eq!(
            request_kind(&wire::Request {
                kind: Some(wire::request::Kind::BackupStatus(
                    wire::BackupStatusRequest {}
                )),
            }),
            RequestKind::Bounded
        );
        assert_eq!(
            request_kind(&wire::Request {
                kind: Some(wire::request::Kind::PairPhone(wire::PairRequest::default())),
            }),
            RequestKind::Bounded
        );
        assert_eq!(request_kind(&hello()), RequestKind::Bounded);
        assert_eq!(
            request_kind(&wire::Request {
                kind: Some(wire::request::Kind::Command(wire::Command::default())),
            }),
            RequestKind::Bounded
        );
        // AND A REQUEST WITH NO KIND IS BOUNDED, so an unknown message cannot
        // be used to register a cancellable slot that never finishes.
        assert_eq!(
            request_kind(&wire::Request { kind: None }),
            RequestKind::Bounded
        );
    }

    /// A founded core holding the vault's keys, its content store open.
    fn unlocked() -> Scratch {
        let dir = centraid_ontology::golden::scratch_dir();
        std::fs::create_dir_all(&dir).expect("the directory is made");
        let words = "abandon abandon abandon abandon abandon abandon abandon abandon \
                     abandon abandon abandon abandon abandon abandon abandon abandon \
                     abandon abandon abandon abandon abandon abandon abandon art";
        let seed = centraid_identity::RecoveryPhrase::parse(words)
            .expect("the BIP39 vector parses")
            .seed();
        let handle =
            Core::open(CoreConfig::new(dir.join("vault.db")).with_seed(seed, 0)).expect("it opens");
        handle
            .with_vault(|vault| Ok(vault.found("Test", "Owner")?))
            .expect("it founds");
        handle
            .open_own_bytes(dir.join("vault.bytes"))
            .expect("the byte store opens");
        Scratch { dir, handle }
    }

    fn ask(scratch: &Scratch, kind: wire::request::Kind) -> Result<wire::response::Kind> {
        scratch
            .handle
            .call(&wire::Request { kind: Some(kind) })
            .map(|answer| answer.kind.expect("an answer has a kind"))
    }

    /// THE BACKUP PLANE'S DOORS ANSWER OVER A PHONE THAT IS PAIRED WITH
    /// NOTHING (#1080): nothing to hand off, nothing settled, no pin, no
    /// gateway to reconcile with, a pass that reaches nobody — each an answer a
    /// shell draws, none an error. The refusals left are the request's own.
    #[test]
    fn the_backup_doors_answer_an_unpaired_phone() {
        let scratch = unlocked();
        let Ok(wire::response::Kind::Handoff(handoff)) = ask(
            &scratch,
            wire::request::Kind::Handoff(wire::HandoffRequest {
                max_bytes: 1 << 20,
                max_parts: 8,
            }),
        ) else {
            panic!("a handoff answers");
        };
        assert!(handoff.parts.is_empty());
        let Ok(wire::response::Kind::Settle(settled)) = ask(
            &scratch,
            wire::request::Kind::Settle(wire::SettleRequest {
                settled: vec![wire::Settled {
                    name: "ab".repeat(32),
                    http_status: 201,
                    ..wire::Settled::default()
                }],
            }),
        ) else {
            panic!("a settle answers");
        };
        assert_eq!(
            (settled.confirmed, settled.requeued),
            (0, 0),
            "an unknown name counts nothing"
        );
        let Ok(wire::response::Kind::Pins(pins)) =
            ask(&scratch, wire::request::Kind::Pins(wire::PinsRequest {}))
        else {
            panic!("pins answer");
        };
        assert!(pins.destinations.is_empty());
        let Ok(wire::response::Kind::Reconcile(reconciled)) = ask(
            &scratch,
            wire::request::Kind::Reconcile(wire::ReconcileRequest {}),
        ) else {
            panic!("a reconcile answers");
        };
        assert!(!reconciled.reachable, "nothing is paired to reach");
        let Ok(wire::response::Kind::ForgetDestination(forgot)) = ask(
            &scratch,
            wire::request::Kind::ForgetDestination(wire::ForgetDestinationRequest {
                gateway_id: "a-gateway".to_owned(),
            }),
        ) else {
            panic!("a forget answers");
        };
        assert!(!forgot.forgotten);
        let Ok(wire::response::Kind::Drain(drained)) = ask(
            &scratch,
            wire::request::Kind::Drain(wire::DrainRequest::default()),
        ) else {
            panic!("a drain answers");
        };
        assert_eq!(drained.stopped, wire::DrainStop::Unreachable as i32);
        let Ok(wire::response::Kind::Releasable(releasable)) = ask(
            &scratch,
            wire::request::Kind::Releasable(wire::ReleasableRequest { limit: 10 }),
        ) else {
            panic!("releasable answers");
        };
        assert!(releasable.items.is_empty() && releasable.total_bytes == 0);
        let Ok(wire::response::Kind::Released(released)) = ask(
            &scratch,
            wire::request::Kind::Released(wire::ReleasedRequest {
                content_hash: vec![vec![7; 32]],
            }),
        ) else {
            panic!("released answers");
        };
        assert_eq!(released.recorded, 0, "a hash never recorded is not counted");
        let Ok(wire::response::Kind::BackupStatus(status)) = ask(
            &scratch,
            wire::request::Kind::BackupStatus(wire::BackupStatusRequest {}),
        ) else {
            panic!("a status answers");
        };
        assert!(status.destinations.is_empty() && !status.frozen);
        assert_eq!(
            status.acked_at_ms, None,
            "never acknowledged is no moment at all"
        );

        for (kind, code) in [
            (
                wire::request::Kind::Handoff(wire::HandoffRequest::default()),
                wire::ErrorCode::InvalidRequest,
            ),
            (
                wire::request::Kind::Releasable(wire::ReleasableRequest { limit: 0 }),
                wire::ErrorCode::InvalidRequest,
            ),
            (
                wire::request::Kind::FetchOriginal(wire::FetchOriginalRequest {
                    content_hash: vec![7; 31],
                }),
                wire::ErrorCode::InvalidRequest,
            ),
            (
                wire::request::Kind::FetchOriginal(wire::FetchOriginalRequest {
                    content_hash: vec![7; 32],
                }),
                wire::ErrorCode::InvalidRequest,
            ),
            (
                wire::request::Kind::Restore(wire::RestoreRequest {
                    phrase: "abandon abandon abandon".to_owned(),
                    payload: "{}".to_owned(),
                    ..wire::RestoreRequest::default()
                }),
                wire::ErrorCode::InvalidRequest,
            ),
            (
                wire::request::Kind::PairPhone(wire::PairRequest {
                    payload: "not-a-pairing-code".to_owned(),
                }),
                wire::ErrorCode::InvalidRequest,
            ),
        ] {
            let refusal = ask(&scratch, kind.clone()).expect_err("refused");
            assert_eq!(refusal.code(), code, "{kind:?} answered {refusal}");
        }
    }

    /// A CORE WITH NO KEYS CANNOT BACK UP, AND SAYS SO: the doors that seal,
    /// sign or name answer "unlock to back up" (`PEER_UNREACHABLE`, a state a
    /// shell draws), and the ones that only read the ledger still answer.
    #[test]
    fn a_core_without_keys_says_unlock_to_back_up() {
        let scratch = Scratch::founded();
        for kind in [
            wire::request::Kind::Drain(wire::DrainRequest::default()),
            wire::request::Kind::Handoff(wire::HandoffRequest {
                max_bytes: 1,
                max_parts: 1,
            }),
            wire::request::Kind::Reconcile(wire::ReconcileRequest {}),
            wire::request::Kind::Settle(wire::SettleRequest::default()),
            wire::request::Kind::Releasable(wire::ReleasableRequest { limit: 1 }),
        ] {
            let refusal = ask(&scratch, kind.clone()).expect_err("refused");
            assert_eq!(
                refusal.code(),
                wire::ErrorCode::PeerUnreachable,
                "{kind:?} answered {refusal}"
            );
            assert!(refusal.to_string().contains("seed"), "{refusal}");
        }
        assert!(matches!(
            ask(&scratch, wire::request::Kind::Pins(wire::PinsRequest {})),
            Ok(wire::response::Kind::Pins(_))
        ));
        assert!(
            !scratch.dir.join("vault.scratch").exists(),
            "a refused pass took no snapshot"
        );
    }

    /// THE STAGE DOOR V2 OVER THE ENVELOPE: owned bytes and a derivative
    /// land in the store and are staged for the rows that name them; a begin
    /// that contradicts itself is refused, and a source this build has no
    /// name for too.
    #[test]
    fn the_stage_door_takes_owned_bytes_and_derivatives() {
        let scratch = unlocked();
        let stage = |request: wire::stage_request::Kind| {
            ask(
                &scratch,
                wire::request::Kind::Stage(wire::StageRequest {
                    kind: Some(request),
                }),
            )
        };
        let put = |begin: wire::StageBegin, bytes: &[u8]| -> wire::StageHandle {
            let Ok(wire::response::Kind::Stage(wire::StageResponse {
                kind: Some(wire::stage_response::Kind::Begun(begun)),
            })) = stage(wire::stage_request::Kind::Begin(begin))
            else {
                panic!("begun");
            };
            stage(wire::stage_request::Kind::Chunk(wire::StageChunk {
                staging_id: begun.staging_id.clone(),
                seq: 0,
                payload: bytes.to_vec(),
            }))
            .expect("chunked");
            let Ok(wire::response::Kind::Stage(wire::StageResponse {
                kind: Some(wire::stage_response::Kind::Handle(handle)),
            })) = stage(wire::stage_request::Kind::End(wire::StageEnd {
                staging_id: begun.staging_id,
            }))
            else {
                panic!("a handle");
            };
            handle
        };
        let original = put(
            wire::StageBegin {
                media_type: "image/heic".to_owned(),
                byte_size: 9,
                source: wire::StageSource::Owned as i32,
                ..wire::StageBegin::default()
            },
            b"a picture",
        );
        assert!(!original.already_held);
        let again = put(
            wire::StageBegin {
                media_type: "image/heic".to_owned(),
                ..wire::StageBegin::default()
            },
            b"a picture",
        );
        assert!(again.already_held, "the same bytes again are held already");
        let thumb = put(
            wire::StageBegin {
                media_type: "image/jpeg".to_owned(),
                byte_size: 7,
                for_hash: hex::decode(&original.content_hash).expect("hex"),
                tier: "thumb".to_owned(),
                ..wire::StageBegin::default()
            },
            b"a thumb",
        );
        let door = scratch.handle.bytes().expect("a door");
        for handle in [&original, &thumb] {
            assert!(
                door.store()
                    .is_complete(
                        centraid_blobs::ContentHash::parse_hex(&handle.content_hash).expect("hex")
                    )
                    .expect("answers"),
                "staged bytes are in the store"
            );
        }
        let refusal = stage(wire::stage_request::Kind::Begin(wire::StageBegin {
            media_type: "image/jpeg".to_owned(),
            source: 9,
            ..wire::StageBegin::default()
        }))
        .expect_err("an unknown source");
        assert_eq!(refusal.code(), wire::ErrorCode::InvalidRequest);
    }

    #[test]
    fn a_closed_handle_answers_every_call_with_a_typed_error() {
        let scratch = Scratch::founded();
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
        let scratch = Scratch::founded();
        let queue = scratch.handle.events();
        let waiter =
            std::thread::spawn(move || matches!(queue.next(Duration::from_secs(30)), Next::Closed));
        std::thread::sleep(Duration::from_millis(50));
        scratch.handle.close();
        assert!(waiter.join().expect("the waiter returns"));
    }

    #[test]
    fn a_timeout_with_no_event_is_not_an_error() {
        let scratch = Scratch::founded();
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
        let scratch = Scratch::founded();
        let filed = scratch.handle.poison("call");
        scratch.handle.close();
        let Err(CoreError::Poisoned { diagnostic_id }) = scratch.handle.call(&hello()) else {
            panic!("a poisoned handle refuses with its id");
        };
        assert_eq!(diagnostic_id, filed);
    }

    #[test]
    fn the_first_panic_is_the_one_filed() {
        let scratch = Scratch::founded();
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
        let scratch = Scratch::founded();
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
                    with_held_thumbnail: false,
                    with_note_body: false,
                    with_document_size: false,
                    with_minor_units: false,
                    local_day_columns: Vec::new(),
                    tz: String::new(),
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

    /// THE PRINCIPAL COMES OFF THE HANDLE (#1029 §1).
    ///
    /// A command carrying no principal at all used to be refused —
    /// `principal_from_wire` answered `InvalidRequest` — because a gateway
    /// serving seats had a second caller to authorise. There is no second
    /// caller, so the field is not read and its absence is not a refusal.
    /// A WRITE THROUGH THE CALL DOOR PUSHES A CHANGE EVENT (#1029 §1).
    ///
    /// The last hole in the loop: `EventQueue` was bounded, coalescing and
    /// fully tested, and the only thing that ever pushed a change event into
    /// it was the SEAT's applier. On a phone with no seat nothing pushed one,
    /// so a shell that waited for a row to arrive waited forever. The commit
    /// guard's `update_hook` says which tables moved and `api::invoke` offers
    /// them here.
    #[test]
    fn a_command_that_writes_pushes_a_change_event_naming_the_table() {
        let scratch = Scratch::founded();
        let answer = scratch
            .handle
            .call(&wire::Request {
                kind: Some(wire::request::Kind::Command(wire::Command {
                    name: "core.add_party".to_owned(),
                    input: br#"{"display_name":"Ada Lovelace"}"#.to_vec(),
                    invoke_key: "w2-change-event".to_owned(),
                    ..Default::default()
                })),
            })
            .expect("the command runs");
        let Some(wire::response::Kind::Command(outcome)) = answer.kind else {
            panic!("a command outcome");
        };
        assert_eq!(outcome.status, wire::CommandStatus::Executed as i32);

        let mut tables = Vec::new();
        while let Ok(Some(event)) = scratch.handle.next_event(Duration::from_millis(20)) {
            if let Some(wire::event::Kind::Change(change)) = event.kind {
                tables.push(change.table);
            }
        }
        assert!(
            tables.iter().any(|table| table == "core_party"),
            "the write produced no change event for the table it wrote: {tables:?}"
        );
    }

    #[test]
    fn a_command_with_no_principal_is_answered_rather_than_refused() {
        let scratch = Scratch::founded();
        let outcome = scratch
            .handle
            .call(&wire::Request {
                kind: Some(wire::request::Kind::Command(wire::Command {
                    name: "people.add_person".to_owned(),
                    input: br#"{"display_name":"Ada","cadence_days":0}"#.to_vec(),
                    invoke_key: "w1-principal-from-the-handle".to_owned(),
                    // ABSENT, and that is the assertion.
                    principal: None,
                    ..Default::default()
                })),
            })
            .expect("the command is answered");
        let Some(wire::response::Kind::Command(answer)) = outcome.kind else {
            panic!("a command outcome comes back");
        };
        assert_eq!(
            answer.status,
            wire::CommandStatus::Executed as i32,
            "the command ran; reason was `{}`",
            answer.reason
        );
    }

    /// AND A PRINCIPAL ON THE REQUEST CANNOT RAISE ONE.
    ///
    /// The field survives on the wire (deleting it is the contracts lane's),
    /// so the thing worth asserting is that filling it changes nothing: a
    /// caller's claim about its own authority is not a grant.
    #[test]
    fn a_principal_on_the_request_does_not_change_who_the_command_runs_as() {
        let scratch = Scratch::founded();
        let run = |principal: Option<wire::Principal>, key: &str| {
            let outcome = scratch
                .handle
                .call(&wire::Request {
                    kind: Some(wire::request::Kind::Command(wire::Command {
                        name: "people.add_person".to_owned(),
                        input: br#"{"display_name":"Grace","cadence_days":0}"#.to_vec(),
                        invoke_key: key.to_owned(),
                        principal,
                        ..Default::default()
                    })),
                })
                .expect("the command is answered");
            let Some(wire::response::Kind::Command(answer)) = outcome.kind else {
                panic!("a command outcome comes back");
            };
            answer.status
        };
        let plain = run(None, "w1-principal-plain");
        // An AGENT is the strongest thing the old wire vocabulary could claim,
        // and it rode an owner it named itself.
        let claimed = run(
            Some(wire::Principal {
                kind: wire::PrincipalKind::Agent as i32,
                caller_id: "_assistant".to_owned(),
                principal_id: "_assistant".to_owned(),
                surface: "money".to_owned(),
                on_behalf_of_owner: true,
            }),
            "w1-principal-claimed",
        );
        assert_eq!(
            plain, claimed,
            "the request's principal is not read, so it cannot change the answer"
        );
    }
}
