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

/// The app an `act` names to trigger the `debug-fault` panic.
///
/// Public so a shell's own clause-9 test can name it without copying a string,
/// and **not** an app the catalogue carries: a build without the feature
/// answers an act on it as an unknown app like any other typo (#1020 wave 3,
/// lane E finding 4).
pub const DEBUG_FAULT_APP: &str = "debug";

/// The action, on [`DEBUG_FAULT_APP`], that triggers the `debug-fault` panic.
pub const DEBUG_FAULT_ACTION: &str = "panic";

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
///
/// A cheap clone of one [`HandleState`]: a job that must outlive a call (the
/// screen runtime's `off_thread`) takes its own `Handle` and the core stays
/// one, whoever holds it.
#[derive(Clone)]
pub struct Handle {
    state: Arc<HandleState>,
}

impl std::ops::Deref for Handle {
    type Target = HandleState;

    fn deref(&self) -> &HandleState {
        &self.state
    }
}

impl Handle {
    fn new(make: impl FnOnce(std::sync::Weak<HandleState>) -> HandleState) -> Handle {
        Handle {
            state: Arc::new_cyclic(|me| make(me.clone())),
        }
    }

    /// The handle a [`HandleState`] belongs to; `None` once the last `Handle`
    /// is gone.
    #[must_use]
    pub fn of(state: &HandleState) -> Option<Handle> {
        state.me.upgrade().map(|state| Handle { state })
    }
}

/// Everything a [`Handle`] is. Public only so `Handle` can deref to it.
#[doc(hidden)]
pub struct HandleState {
    /// This state's own `Arc`, so `&self` can mint a [`Handle`].
    me: std::sync::Weak<HandleState>,
    /// THE VAULT, WHEN THERE IS ONE.
    ///
    /// `None` is a core opened at a path with no file and `create: false` —
    /// a shell asking to open a vault a restore has not written yet. It is a
    /// state the shell draws ("no vault here"), not a failure.
    ///
    /// An `Arc` because a chat's native session outlives any one call and
    /// reaches the vault through [`crate::assist::door::CoreDoor`], which holds
    /// a clone of this very lock: one lock, one open file, whoever asks.
    vault: Arc<Mutex<Option<Vault>>>,
    registry: Arc<Registry>,
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
    locker: Arc<crate::locker::phone::Cell>,
    /// THE ON-DEVICE CHAT'S SESSIONS AND ITS VIEW OF THE MODEL SLOT. In memory
    /// only; see [`crate::assist`]. `pub(crate)` because that module is where
    /// `Request::Assist` is answered.
    pub(crate) assist: crate::assist::Hub,
    /// THE SCREEN RUNTIME, once a shell-facing library has attached one
    /// (#1135, lane C2): see [`crate::screens`].
    screens: std::sync::OnceLock<Arc<dyn crate::screens::ScreenHost>>,
    /// THE DIRECTORY OF VAULTS THIS CORE IS THE DOOR TO, when it is one
    /// (#1135, lane H2): see [`crate::vaults`]. Read once by whoever builds the
    /// shelf ([`Self::shelf_config`]).
    shelf_config: Option<crate::config::ShelfConfig>,
    /// THE SHELF, once the screen runtime built one: the vaults a shell's calls
    /// are routed to.
    vaults: std::sync::OnceLock<Arc<dyn crate::vaults::Vaults>>,
    /// WHEN THIS CORE OPENED. The launch sweep of files no row claims spares any
    /// file written since, because a staging in flight owns it until a command
    /// names it ([`HandleState::tidy_files`]).
    launched: std::time::SystemTime,
    /// The launch sweep of files has been started, so a store attached again
    /// (a restore re-attaches) does not start it twice.
    files_tidied: AtomicBool,
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
            shelf: shelf_config,
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
        let registry = Arc::new(Registry::with_system_commands()?);
        let launched = std::time::SystemTime::now();
        let handle = Handle::new(|me| HandleState {
            me,
            plane: crate::phone::Plane::of(&path).with_ceiling(spool_ceiling),
            path,
            keys,
            vault: Arc::new(Mutex::new(vault)),
            registry,
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
            locker: Arc::new(Mutex::new(None)),
            assist: crate::assist::Hub::new(),
            screens: std::sync::OnceLock::new(),
            shelf_config,
            vaults: std::sync::OnceLock::new(),
            launched,
            files_tidied: AtomicBool::new(false),
        });
        handle.start_trash_tidy();
        Ok(handle)
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

/// How many trashed roots one batch of the launch pass purges. A batch holds the
/// vault, so it is small: the first screen's reads wait behind at most one.
const TRASH_BATCH: usize = 25;

/// How many files one batch of the launch sweep looks at (deleting or not).
const FILE_BATCH: usize = 100;

/// How long the launch tidy lets the vault go between two batches.
const TIDY_PAUSE: Duration = Duration::from_millis(5);

impl HandleState {
    /// **PURGE WHAT HAS WAITED OUT ITS WINDOW, OFF THE REQUEST PATH** (#1146,
    /// decision T). Started by [`Core::open`] on a thread of its own; the open
    /// has returned by the time it runs, so no first screen waits for it, and
    /// each batch takes the vault for a moment and lets it go. Until a row's
    /// batch has run it is a trashed row like any other and `entity.restore`
    /// still brings it back.
    ///
    /// Returns how many entities the pass purged.
    ///
    /// # Errors
    /// A closed or poisoned core, or the pass's own failure; what earlier
    /// batches purged stays purged.
    pub fn tidy_trash(&self) -> Result<usize> {
        let mut purged = 0;
        loop {
            let batch = self
                .with_vault(|vault| Ok(vault.empty_overdue_trash(&self.registry, TRASH_BATCH)?))?;
            purged += batch.purged;
            if !batch.more {
                return Ok(purged);
            }
            std::thread::sleep(TIDY_PAUSE);
        }
    }

    /// **DELETE THE FILES NO ROW CLAIMS** (#1146): the bytes of a command that
    /// failed after the stage door kept them, or of a purge whose file would not
    /// delete. Only files written before this core opened are taken: a staging
    /// in flight owns its file until a command names it, and one that ended
    /// after the open wrote its file after it.
    ///
    /// Returns how many files were deleted.
    ///
    /// # Errors
    /// A closed or poisoned core, or the store's refusal.
    pub fn tidy_files(&self) -> Result<usize> {
        let mut removed = 0;
        let mut after = String::new();
        loop {
            let batch = self.with_vault(|vault| {
                Ok(vault.sweep_unclaimed_files(self.launched, &after, FILE_BATCH)?)
            })?;
            removed += batch.removed.len();
            let Some(next) = batch.next else {
                return Ok(removed);
            };
            after = next;
            std::thread::sleep(TIDY_PAUSE);
        }
    }

    /// Run `body` against this state on a thread of its own. It ends when its
    /// passes do, or at the next batch after the core is closed.
    fn tidy_in_background(&self, name: &str, body: fn(&HandleState) -> Result<usize>) {
        let weak = self.me.clone();
        let spawned = std::thread::Builder::new()
            .name(name.to_owned())
            .spawn(move || {
                let Some(state) = weak.upgrade() else { return };
                match body(&state) {
                    Ok(0) | Err(CoreError::Unpaired | CoreError::Closed) => {}
                    Ok(count) => tracing::info!(count, "the launch tidy finished"),
                    Err(error) => tracing::warn!("the launch tidy stopped: {error}"),
                }
            });
        if let Err(error) = spawned {
            tracing::warn!("the launch tidy could not start: {error}");
        }
    }

    fn start_trash_tidy(&self) {
        self.tidy_in_background("centraid-tidy-trash", HandleState::tidy_trash);
    }

    /// The event queue, so a producer (sync, the applier) can push to it.
    #[must_use]
    pub fn events(&self) -> Arc<EventQueue> {
        Arc::clone(&self.events)
    }

    /// Attach THE content store this device holds for this vault (#1025 S3).
    ///
    /// One per vault: the grid reads it and the commands write it
    /// (D-1025-S3-1). Attaching it puts the vault's byte door over it, so
    /// a command spills into it and `content_location` answers with a
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
        // THE FIRST STORE THIS CORE HOLDS IS SWEPT ONCE (#1146): the files no row
        // claims go, off this thread.
        if !self.files_tidied.swap(true, Ordering::SeqCst) {
            self.tidy_in_background("centraid-tidy-files", HandleState::tidy_files);
        }
    }

    /// The content store, when one is attached. The byte plane's own half of a
    /// pass reads it — and so does an eviction sweep, which is why it is
    /// reachable rather than only wired.
    #[must_use]
    pub fn bytes(&self) -> Option<centraid_blobs::ContentBytes> {
        self.bytes.lock().ok().and_then(|held| held.clone())
    }

    /// Answer one request.
    ///
    /// Synchronous from the caller's view. **Must never be invoked from a UI
    /// thread**: a debug assertion fires when the calling thread is the one the
    /// shell named through [`CoreConfig::ui_thread_name`].
    pub fn call(&self, request: &wire::Request) -> Result<wire::Response> {
        self.assert_not_on_the_ui_thread();
        self.check_open()?;
        if let Some(front) = self.foreground_for(request) {
            return front.call(request);
        }
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
        // THE LEDGER MOVED, WHETHER OR NOT THE DOOR SUCCEEDED: a pass that
        // stopped on an unreachable gateway still recorded what it did. A
        // screen reading `backup-status` hears it as a change to
        // [`crate::phone::backup_reads::TABLE`].
        if crate::phone::backup_reads::moves_the_ledger(request) {
            crate::events::ChangeFeed::new(self.events())
                .tables_changed(&[crate::phone::backup_reads::TABLE.to_owned()]);
        }
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
        if let Some(front) = self.foreground_for(request) {
            return front.call_with_id(request, request_id);
        }
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

    /// THE ONE READ (#1135): [`crate::load::load`] over this core's vault.
    ///
    /// # Errors
    /// Whatever `load` refuses with; [`CoreError::Unpaired`] with no file.
    pub fn load(&self, request: &wire::LoadRequest) -> Result<wire::LoadResponse> {
        if let Some(front) = self.foreground_for_load(request) {
            return front.load(request);
        }
        // Some of the shell's reads are the phone's own ledger (the backup's
        // status, the held vaults), not a vault table: they need the handle.
        if request.app == crate::shell::ID
            && let Some(answer) = crate::phone::shell_reads::load(self, request)
        {
            return answer;
        }
        self.with_vault(|vault| crate::load::load(vault, request))
    }

    /// THE ONE WRITE (#1135): [`crate::act::act`] over this core's vault, with
    /// the change feed, the owner and the duplicate-tap record it needs.
    ///
    /// # Errors
    /// Whatever `act` refuses with; [`CoreError::Unpaired`] with no file.
    pub fn act(&self, request: &wire::ActRequest) -> Result<wire::ActResponse> {
        if let Some(front) = self.foreground_if_shelved() {
            return front.act(request);
        }
        let changes = crate::events::ChangeFeed::new(self.events());
        let owner = self.owner();
        self.with_vault(|vault| {
            crate::act::act(
                &crate::act::Ctx {
                    vault,
                    locker: &self.locker,
                    registry: &self.registry,
                    owner: &owner,
                    changes: &changes,
                    plane: &self.plane,
                },
                request,
            )
        })
    }

    /// Attach the screen runtime. Once per core: a second attach is ignored,
    /// because two runtimes would each own a route stack.
    pub fn attach_screens(&self, host: Arc<dyn crate::screens::ScreenHost>) {
        let _ = self.screens.set(host);
    }

    /// The directory of vaults this core is the door to, when it was opened as
    /// one ([`crate::CoreConfig::fronting`]).
    #[must_use]
    pub fn shelf_config(&self) -> Option<&crate::config::ShelfConfig> {
        self.shelf_config.as_ref()
    }

    /// Attach the shelf. Once per core: a second attach is ignored.
    pub fn attach_vaults(&self, vaults: Arc<dyn crate::vaults::Vaults>) {
        let _ = self.vaults.set(vaults);
    }

    /// The shelf, when this core is the door to one.
    #[must_use]
    pub fn vaults(&self) -> Option<&Arc<dyn crate::vaults::Vaults>> {
        self.vaults.get()
    }

    /// THE VAULT IN FRONT, when this core is a shelf's door and the phone holds
    /// one. A core that is not a door answers its own requests, and so does a
    /// door with nothing in front: it holds no vault, so a read says
    /// [`CoreError::Unpaired`] as it always did.
    pub(crate) fn foreground_if_shelved(&self) -> Option<Handle> {
        self.vaults.get()?.foreground_core()
    }

    /// Where `request` goes: the vault in front, unless it is the front's own
    /// business — the screen runtime (it lives here and reads through the
    /// vault in front), the words and a restore (they need no vault), the
    /// handshake, and the shelf's own read.
    fn foreground_for(&self, request: &wire::Request) -> Option<Handle> {
        use wire::request::Kind as K;
        self.vaults.get()?;
        match &request.kind {
            None | Some(K::Hello(_) | K::Screen(_) | K::Phrase(_) | K::Restore(_)) => None,
            Some(K::Load(load)) => self.foreground_for_load(load),
            Some(_) => self.foreground_if_shelved(),
        }
    }

    fn foreground_for_load(&self, request: &wire::LoadRequest) -> Option<Handle> {
        if crate::phone::shell_reads::is_front_read(request) {
            return None;
        }
        self.foreground_if_shelved()
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
        if let Some(front) = self.foreground_if_shelved() {
            return front.cancel(request_id);
        }
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
        // THE SCREEN RUNTIME IS DRIVEN FROM HERE (#1135, lane C2). A change
        // event is a reason to re-render and a wake is a timer that elapsed;
        // both are handled with `&self` as the screens' door to the core, on
        // the shell's own event thread (never the UI thread), so a runtime
        // needs no reference to this handle that outlives a call.
        let deadline = std::time::Instant::now() + timeout;
        loop {
            let left = deadline.saturating_duration_since(std::time::Instant::now());
            match self.events.next(left) {
                Next::Event(event) => {
                    let host = self.screens.get();
                    match (&event.kind, host) {
                        // A wake is the runtime's own marker: it is handled
                        // here and never reaches the shell.
                        (Some(wire::event::Kind::Wake(_)), host) => {
                            if let Some(host) = host {
                                host.wake(self);
                            }
                        }
                        (Some(wire::event::Kind::JobDone(done)), host) => {
                            if let Some(host) = host {
                                host.job_done(self, done.job, done.bytes.clone());
                            }
                        }
                        // THE ASSISTANT'S STREAM goes to the screens that listen (the chat)
                        // and on to the shell too, like a change: the stream is part of the ABI,
                        // and a shell with a runtime simply ignores it.
                        (Some(wire::event::Kind::Assist(assist)), Some(host)) => {
                            host.assist(self, assist);
                            return Ok(Some(event));
                        }
                        (Some(wire::event::Kind::Change(change)), Some(host)) => {
                            host.changed(self, std::slice::from_ref(&change.table));
                            return Ok(Some(event));
                        }
                        _ => return Ok(Some(event)),
                    }
                }
                Next::Timeout => return Ok(None),
                Next::Closed => return Err(CoreError::Closed),
            }
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
        // THE VAULTS THE SHELF HOLDS GO WITH THE DOOR TO THEM.
        if let Some(vaults) = self.vaults.get() {
            vaults.close_all();
        }
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

    /// Zero the Locker session now, if one is unlocked: the rule for leaving the
    /// foreground, and for a vault the member switched away from.
    pub fn relock(&self) {
        crate::locker::phone::relock(&self.locker);
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

    /// THE LOCKER SESSION (#1047, D-5): one step of `Request.locker`. A shell
    /// asks it over the ABI; the screen runtime asks it through
    /// [`crate::screens::ScreenCtx::locker`], the same step on the same session.
    ///
    /// # Errors
    /// The session's own refusals; [`CoreError::Unpaired`] with no file.
    pub fn locker_session(
        &self,
        request: &wire::LockerSessionRequest,
    ) -> Result<wire::LockerSessionResponse> {
        if let Some(front) = self.foreground_if_shelved() {
            return front.locker_session(request);
        }
        let changes = crate::events::ChangeFeed::new(self.events());
        self.with_vault(|vault| {
            crate::locker::phone::answer(
                vault,
                &self.registry,
                &self.owner(),
                self.keys.as_ref(),
                &self.locker,
                request,
                &changes,
            )
        })
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

    /// The backup's standing as the ledger and the vault say it: the one
    /// reading behind the `backup_status` door and the shell's `backup-status`
    /// query. It dials nobody.
    ///
    /// # Errors
    /// The ledger's or the spool's refusal, or a vault that will not read.
    pub(crate) fn backup_standing(&self) -> Result<wire::BackupStatusResponse> {
        self.with_vault_if_any(|vault| {
            crate::phone::backup_status(&self.plane, vault, self.keys.as_ref())
        })
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
    pub fn registry(&self) -> &Registry {
        &self.registry
    }

    /// WHO THIS CORE'S COMMANDS RUN AS (#1029 §1).
    ///
    /// Taken from the handle and never from the request. See
    /// `crate::api::invoke` for why there is nothing else it could be, and
    /// [`OWNER_DEVICE`] for what a receipt ends up naming.
    #[must_use]
    pub fn owner(&self) -> centraid_vault::Principal {
        centraid_vault::Principal::owner(OWNER_DEVICE)
    }

    /// RUN ONE REGISTERED COMMAND BY NAME, IN RUST (#1135).
    ///
    /// Not a door a shell reaches: the FFI carries no command request, and a
    /// screen's write is [`Self::act`]. This is for the Rust beside the core
    /// that names a command no app's manifest declares — the vault shelf's
    /// `vault.rename`, a seeding tool, a test laying the rows it reads — and it
    /// takes the one write path `act` and the chat's confirmed card take
    /// (`crate::api::command`): a Locker secret is sealed under the open
    /// session, the change feed is told after the commit. `invoke_key` is
    /// required and remembered by nothing: the same key twice runs twice
    /// (`tests/replay.rs`).
    ///
    /// # Errors
    /// [`CoreError::InvalidRequest`] for an empty key or a refused seal; the
    /// vault's own failures; [`CoreError::Unpaired`] with no file.
    pub fn command(
        &self,
        name: &str,
        input: &serde_json::Value,
        invoke_key: &str,
    ) -> Result<centraid_vault::commands::CommandOutcome> {
        self.check_open()?;
        if let Some(front) = self.foreground_if_shelved() {
            return front.command(name, input, invoke_key);
        }
        let call = crate::api::Invocation {
            name: name.to_owned(),
            input: serde_json::to_vec(input).map_err(|error| CoreError::Invariant {
                context: format!("a command's input is not JSON: {error}"),
            })?,
            invoke_key: invoke_key.to_owned(),
        };
        let changes = crate::events::ChangeFeed::new(self.events());
        let owner = self.owner();
        self.with_vault(|vault| {
            crate::api::command(
                vault,
                &self.locker,
                &self.registry,
                &owner,
                &call,
                &changes,
                None,
            )
        })
    }

    /// THE DOOR A CHAT'S NATIVE SESSION READS AND WRITES THROUGH (#1088).
    ///
    /// It holds clones of this handle's own lock, registry and event queue, so
    /// it outlives the call that made it and still reaches the one open vault
    /// only through [`Self::with_vault`]'s mutex. See
    /// [`crate::assist::door::CoreDoor`].
    pub fn assist_door(&self) -> crate::assist::door::CoreDoor {
        crate::assist::door::CoreDoor::new(
            Arc::clone(&self.vault),
            Arc::clone(&self.registry),
            self.events(),
            self.owner(),
            Arc::clone(&self.locker),
            crate::phone::Plane::of(&self.path),
        )
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
        // It rides the EXISTING `Act` request rather than a new symbol:
        // clause 10 says five symbols and means it, and a shell that needed a
        // sixth to test the fifth would have a sixth in production.
        // `abi-five-symbols` still counts five, because nothing is exported.
        #[cfg(feature = "debug-fault")]
        if let K::Act(act) = kind
            && act.app == DEBUG_FAULT_APP
            && act.action == DEBUG_FAULT_ACTION
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
            K::Found(request) => Ok(response(wire::response::Kind::Found(self.with_vault(
                |vault| crate::api::found(vault, &self.registry, &self.owner(), request),
            )?))),
            // THE LOCKER SESSION (#1047, D-5). See `crate::locker::phone`.
            K::Locker(request) => Ok(response(wire::response::Kind::Locker(
                self.locker_session(request)?,
            ))),
            // THE PASS (#1080). Not through `with_vault` for its whole length:
            // the vault is held for the snapshot's copy and the reads a pass
            // makes, never across the network, so a screen's reads go on while
            // a backup runs.
            K::Drain(request) => Ok(response(wire::response::Kind::Drain(self.drain(request)?))),
            // PAIRING NEEDS NO VAULT TO BE OPEN: it needs the vault's keys,
            // and keeps the gateway in the ledger beside the file.
            K::PairPhone(request) => {
                let runtime = self.runtime_handle()?;
                // HOW FAR THIS COPY HAS RUN, read before the network is
                // touched and the vault let go (the sweep's F4): a takeover
                // compares it with the head it would claim.
                let own = self.with_vault_if_any(|vault| {
                    vault
                        .map(|vault| {
                            centraid_vault::backup::snapshot::history(vault)
                                .map_err(crate::phone::plane_error)
                        })
                        .transpose()
                })?;
                Ok(response(wire::response::Kind::PairPhone(
                    crate::phone::pair::pair(
                        &self.plane,
                        self.keys.as_ref(),
                        own.as_ref(),
                        request,
                        &runtime,
                    )?,
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
                self.backup_standing()?,
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
            // THE ONE READ (#1135): the app's manifest names the query, the core
            // reads its arguments by name and runs the app's own query.
            K::Load(request) => Ok(response(wire::response::Kind::Load(Box::new(
                self.load(request)?,
            )))),
            // THE SCREEN RUNTIME (#1135, lane C2): navigation and a screen's
            // events. A core with no runtime attached refuses by name.
            K::Screen(request) => {
                let host = self.screens.get().ok_or_else(|| CoreError::Unsupported {
                    type_url: "centraid.core.v1.ScreenRequest".to_owned(),
                })?;
                // LEAVING THE FOREGROUND RELOCKS THE LOCKER (D-5), whether or
                // not a Locker screen is open to hear it: the session is the
                // core's, so the rule is too.
                if let Some(wire::screen_request::Kind::Lifecycle(lifecycle)) = &request.kind
                    && !lifecycle.foreground
                {
                    crate::locker::phone::relock(&self.locker);
                    // EVERY HELD VAULT'S SESSION, not only the one in front.
                    if let Some(vaults) = self.vaults.get() {
                        for core in vaults.awake() {
                            core.relock();
                        }
                    }
                }
                Ok(response(wire::response::Kind::Screen(Box::new(
                    host.call(self, request)?,
                ))))
            }
            // THE ONE WRITE (#1135): the app's manifest names the action; the
            // core runs the duplicate-tap, frozen-vault and schema rules.
            K::Act(request) => Ok(response(wire::response::Kind::Act(Box::new(
                self.act(request)?,
            )))),
            // MONEY'S IMPORT PLAN AND HOME'S TILE (#1099). See `money.proto`;
            // `with_vault` like an app query, because they ARE page reads. The
            // statement's bytes are read once and dropped with the request.
            K::Money(request) => {
                use wire::money_request::Kind as M;
                let kind = match &request.kind {
                    Some(M::ImportPlan(asked)) => {
                        wire::money_response::Kind::ImportPlan(self.with_vault(|vault| {
                            crate::app_query::money::import_plan(vault, asked)
                        })?)
                    }
                    Some(M::HomeTile(asked)) => wire::money_response::Kind::HomeTile(
                        self.with_vault(|vault| crate::app_query::money::home_tile(vault, asked))?,
                    ),
                    None => {
                        return Err(CoreError::InvalidRequest {
                            detail: "a money request names no kind".to_owned(),
                        });
                    }
                };
                Ok(response(wire::response::Kind::Money(wire::MoneyResponse {
                    kind: Some(kind),
                })))
            }
            // THE BACKUP PLANE'S DOORS BESIDE THE PASS (#1080). See
            // `phone.proto` and `crate::phone`.
            K::Handoff(request) => {
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
            K::RefreshDestination(request) => {
                let runtime = self.runtime_handle()?;
                Ok(response(wire::response::Kind::RefreshDestination(
                    crate::phone::refresh_destination(&self.plane, &runtime, request)?,
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
            K::LibraryAssets(request) => Ok(response(wire::response::Kind::LibraryAssets(
                self.with_vault(|vault| crate::phone::library_assets(&self.plane, vault, request))?,
            ))),
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
                free: plane.free_bytes(),
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

    /// Record a closed session: owned bytes are held for the command that names
    /// and claims them, a derivative is claimed beside its parent, and a library
    /// item is in the ledger — where it lives, and its sealed parts in the queue.
    fn record_staged(&self, staged: crate::stage::Staged) -> Result<wire::StageHandle> {
        use crate::stage::Staged;
        match staged {
            Staged::Owned {
                stored,
                media_type,
                derivative,
            } => {
                let hash = stored.hash.to_hex();
                // A derivative is claimed beside its parent; an original is claimed
                // by the command that names it (`document.add`, `photo.add`), so
                // bytes staged and never named leave no row to collect.
                if let Some((variant_of, variant)) = derivative {
                    let byte_size = i64::try_from(stored.bytes).unwrap_or(i64::MAX);
                    self.with_vault(|vault| {
                        Ok(
                            vault.stage_derivative(&centraid_vault::blob::StagedDerivative {
                                hash: hash.clone(),
                                byte_size,
                                media_type,
                                variant,
                                variant_of,
                            })?,
                        )
                    })?;
                }
                Ok(wire::StageHandle {
                    content_hash: hash,
                    byte_size: stored.bytes,
                    already_held: stored.already_held,
                    derivatives_held: Vec::new(),
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
                let derivatives = self.with_vault(|vault| Ok(vault.derivatives_of(&hash)?))?;
                Ok(wire::StageHandle {
                    content_hash: hash,
                    byte_size: len,
                    already_held,
                    derivatives_held: self.tiers_held(derivatives),
                })
            }
        }
    }

    /// **THE DERIVATIVES THIS CORE HOLDS FOR AN ORIGINAL** (#1080, the
    /// simulator run): the tiers whose row the vault has AND whose bytes the
    /// store has. A restored phone's first walk finds the original absent —
    /// it is the gateway's, not the phone's — while the restore brought every
    /// thumbnail and preview back with its row, so the walk would render and
    /// stage again what the vault holds. A row without its bytes (a derivative
    /// the restore could not fetch) is not held: the shell renders it, and
    /// staging replaces the row.
    fn tiers_held(&self, derivatives: Vec<(String, String)>) -> Vec<String> {
        let Some(door) = self.bytes() else {
            return Vec::new();
        };
        derivatives
            .into_iter()
            .filter(|(_, hash)| {
                centraid_blobs::ContentHash::parse_hex(hash)
                    .ok()
                    .is_some_and(|hash| door.store().is_complete(hash).unwrap_or(false))
            })
            .map(|(variant, _)| variant)
            .collect()
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
            // `load` IS AN APP QUERY BY THE MANIFEST'S NAME, with the same
            // ceilings; `act` IS ONE COMMAND, one commit.
            | K::Load(_)
            | K::Act(_)
            // A SCREEN EVENT IS A HANDFUL OF `load`s and `act`s, each bounded.
            | K::Screen(_)
            // MONEY'S PLAN IS BOUNDED: one file of at most 8 MiB and 20,000
            // rows read once, and the same declared fan-outs an app query has.
            | K::Money(_)
            // A LOCKER STEP IS BOUNDED: one key load, one stamp, one cell.
            | K::Locker(_)
            // A PHRASE STEP IS 24 WORDS AND ONE PBKDF2 (#1047 E1).
            | K::Phrase(_)
            // EIGHT OF THE BACKUP PLANE'S DOORS ARE BOUNDED (#1080).
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
            // `refresh_destination` DIALS AT MOST EIGHT CANDIDATES, each for
            // at most three seconds, and writes one row (Q-1080-D3).
            | K::RefreshDestination(_)
            | K::Releasable(_)
            | K::Released(_)
            // `library_assets` IS ONE READ OF THE LEDGER and one of the vault,
            // for at most a hundred refs (#1127).
            | K::LibraryAssets(_)
            // A CHAT TURN IS BOUNDED BY ITS CEILINGS: `STEP_CAP` (6) steps of at most
            // 512 tokens, each read from memory, and a free reply of at most 256.
            // It stops through `AssistCancel`, not through this registry, so it
            // is not classed cancellable here.
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
            let dir = centraid_ontology::scratch::scratch_dir();
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

    fn trashed_note(handle: &Handle, id: &str, overdue: bool) {
        handle
            .with_vault(|vault| {
                Ok(centraid_vault::testdoor::add_trashed_note(
                    vault, id, overdue,
                )?)
            })
            .expect("a trashed note");
    }

    fn rows(handle: &Handle, id: &str) -> i64 {
        handle
            .with_vault(|vault| {
                Ok(vault.read(|c| Ok(centraid_vault::testdoor::entity_rows(c, id)))?)
            })
            .expect("a count")
    }

    /// DECISION T (#1146): the pass takes what is overdue, in bounded batches, and
    /// leaves a row still inside its window. (That an overdue row restores until
    /// the pass runs is `trash_and_bytes.rs`'s: the pass `open` starts races a
    /// test that would restore here.)
    #[test]
    fn the_launch_pass_purges_what_is_overdue_and_spares_the_rest() {
        let scratch = Scratch::founded();
        let handle = &scratch.handle;
        trashed_note(handle, "kept", false);
        trashed_note(handle, "doomed", true);
        handle.tidy_trash().expect("the pass runs");
        assert_eq!(rows(handle, "doomed"), 0, "the overdue note was purged");
        assert_eq!(rows(handle, "kept"), 1, "the one inside its window was not");
    }

    /// The pass is started by `open` itself, on a thread of its own: a vault
    /// reopened with an overdue row empties it with nobody asking.
    #[test]
    fn open_starts_the_pass_without_a_request() {
        let scratch = Scratch::founded();
        trashed_note(&scratch.handle, "doomed", true);
        let path = scratch.handle.path().to_path_buf();
        scratch.handle.close();
        drop(scratch.handle.clone());
        let reopened = Core::open(CoreConfig::new(&path)).expect("reopens");
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while rows(&reopened, "doomed") != 0 {
            assert!(
                std::time::Instant::now() < deadline,
                "the launch pass never ran"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    /// A file no row claims is swept at launch, and a file written since the
    /// core opened is left for the command that is about to name it.
    #[test]
    fn the_launch_sweep_takes_stray_files_and_spares_what_a_staging_owns() {
        use centraid_vault::bytes::BlobStore as _;

        let scratch = Scratch::founded();
        let store = scratch.dir.join("vault.bytes");
        // The old stray is on disk before the core attaches its store.
        let stray = {
            let bytes = centraid_blobs::ByteStore::open(&store).expect("opens");
            let stored = bytes
                .put_bytes(b"left by a crashed command")
                .expect("stored");
            std::fs::File::options()
                .write(true)
                .open(&stored.path)
                .and_then(|file| {
                    file.set_modified(std::time::SystemTime::now() - Duration::from_secs(86_400))
                })
                .expect("ages it");
            stored.hash.to_hex()
        };
        scratch
            .handle
            .open_own_bytes(&store)
            .expect("opens its bytes");
        let door = scratch.handle.bytes().expect("attached");
        // A staging that ended after the open: new, and spared.
        let staged = door.put(b"staged a moment ago").expect("stored");
        scratch.handle.tidy_files().expect("the sweep runs");
        assert!(!door.has(&stray).expect("asks"), "the stray was swept");
        assert!(
            door.has(&staged).expect("asks"),
            "the staged file was spared"
        );
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
        // The bytes a shell staged: in the store, named by their hash, and claimed
        // by the command that names them.
        let png = {
            use base64::Engine as _;
            base64::engine::general_purpose::STANDARD
                .decode(ONE_PIXEL_PNG)
                .expect("a PNG")
        };
        let blob =
            centraid_vault::bytes::BlobStore::put(&scratch.handle.bytes().expect("a door"), &png)
                .expect("the store takes it");
        let outcome = scratch
            .handle
            .command(
                "photo.add",
                &serde_json::json!({
                    "blob": blob,
                    "size": png.len(),
                    "media_type": "image/png",
                }),
                "content-urls-library",
            )
            .expect("the command answers");
        assert_eq!(
            outcome.status,
            centraid_vault::CommandStatus::Executed,
            "{:?}",
            outcome.reason
        );
        let output = outcome.output;
        let reference = wire::ContentRef {
            content_id: blob.clone(),
            owner_type: "photo".to_owned(),
            owner_id: output["id"].as_str().expect("a photograph id").to_owned(),
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
        let dir = centraid_ontology::scratch::scratch_dir();
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
        let dir = centraid_ontology::scratch::scratch_dir();
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
            wire::request::Kind::RefreshDestination(wire::RefreshDestinationRequest::default()),
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
                kind: Some(wire::request::Kind::Act(Box::default())),
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
        let dir = centraid_ontology::scratch::scratch_dir();
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
        // A derivative is claimed beside its parent, so the parent is named first,
        // as the command that files it would.
        scratch
            .handle
            .with_vault(|vault| {
                Ok(vault.stage_bytes(&[centraid_vault::blob::NeededBytes {
                    hash: original.content_hash.clone(),
                    byte_size: 9,
                }])?)
            })
            .expect("the original is claimed");
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
                    name: "people".to_owned(),
                    select: vec!["id".to_owned(), "created_at".to_owned()],
                    from: "entity".to_owned(),
                    r#where: Some("kind = ?".to_owned()),
                    bind: vec![wire::Value {
                        kind: Some(wire::value::Kind::Text("person".to_owned())),
                    }],
                    order: Some(wire::PageOrder {
                        sort_column: "created_at".to_owned(),
                        pk_column: "id".to_owned(),
                        descending: false,
                    }),
                    with_held_thumbnail: false,
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
        // The founded vault has its owner and nothing else, so the rows
        // ended and `next` is ABSENT — never a cursor past the end.
        assert!(!page.rows.is_empty());
        assert!(page.next.is_none());
    }

    /// A WRITE PUSHES A CHANGE EVENT (#1029 §1).
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
        let outcome = scratch
            .handle
            .command(
                "person.add",
                &serde_json::json!({ "title": "Ada Lovelace" }),
                "w2-change-event",
            )
            .expect("the command runs");
        assert_eq!(outcome.status, centraid_vault::CommandStatus::Executed);

        let mut tables = Vec::new();
        while let Ok(Some(event)) = scratch.handle.next_event(Duration::from_millis(20)) {
            if let Some(wire::event::Kind::Change(change)) = event.kind {
                tables.push(change.table);
            }
        }
        assert!(
            tables.iter().any(|table| table == "person"),
            "the write produced no change event for the table it wrote: {tables:?}"
        );
    }

    /// THE PRINCIPAL COMES OFF THE HANDLE (#1029 §1).
    ///
    /// A command once carried its caller's principal on the request, and one
    /// carrying none was refused, because a gateway serving seats had a second
    /// caller to authorise. There is no second caller and no field to state
    /// one in: a command runs as [`Handle::owner`], and running one states
    /// nothing about who is asking.
    #[test]
    fn a_command_runs_as_the_handles_owner_without_being_told() {
        let scratch = Scratch::founded();
        let outcome = scratch
            .handle
            .command(
                "person.add",
                &serde_json::json!({ "title": "Ada", "cadence_days": 0 }),
                "w1-principal-from-the-handle",
            )
            .expect("the command is answered");
        assert_eq!(
            outcome.status,
            centraid_vault::CommandStatus::Executed,
            "the command ran; reason was `{:?}`",
            outcome.reason
        );
    }

    /// THE KEY IS REQUIRED: it is the caller's correlation key, and a command
    /// with none is a request error rather than a run.
    #[test]
    fn a_command_with_no_invoke_key_is_refused_before_it_runs() {
        let scratch = Scratch::founded();
        let refused =
            scratch
                .handle
                .command("person.add", &serde_json::json!({ "title": "Ada" }), "");
        assert!(
            matches!(refused, Err(CoreError::InvalidRequest { .. })),
            "{refused:?}"
        );
    }
}
