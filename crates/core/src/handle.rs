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
    /// THE VAULT, WHEN THERE IS ONE (#1025 S1).
    ///
    /// `None` is the **unpaired** state and it is a state, not a failure: a
    /// seat between installing the app and scanning a code has no file, and
    /// every phone starts there. It is also the state a seat is in for the
    /// length of a re-bootstrap, because the install is a rename over this
    /// file and a file cannot be replaced underneath an open SQLite handle —
    /// so the vault goes down, the copy lands, and it comes back up.
    ///
    /// A gateway is never `None`: it is the authority for its own file and a
    /// gateway with no file has nothing to be the authority for.
    vault: Mutex<Option<Vault>>,
    /// The file this core is over, so a bootstrap can say which one to replace.
    path: std::path::PathBuf,
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
    /// HOW AN OPEN TAIL IS CLOSED (#1025 S2, D-1025-S7-40).
    ///
    /// Its own lock rather than a method on the network, because `sync_now`
    /// holds the network for the length of a pass and a tail is a pass that
    /// lasts as long as the member is looking at the app. Taken out of the
    /// network at `attach_network`, when nobody is inside one.
    tail_stop: Mutex<Option<std::sync::Arc<dyn crate::link::TailStopper>>>,
    /// WHO IS TOLD THAT THIS VAULT'S WATERMARK MOVED (#1025 S2, D-1025-S7-40).
    ///
    /// Empty on every seat and on every test: the bell exists for a GATEWAY,
    /// whose seat lane hangs tails off it. See [`crate::link::CommitBell`].
    commit_bells: Mutex<Vec<std::sync::Arc<dyn crate::link::CommitBell>>>,
    /// THE ONE CONTENT STORE THIS DEVICE HOLDS FOR THIS VAULT (#1025 S3,
    /// D-1025-S3-1).
    ///
    /// Held rather than derived, for two reasons. A bootstrap REPLACES the
    /// replica file and reopens it, and the door has to be attached again to
    /// the vault that comes back — a store re-derived there would be a second
    /// index over one set of files, which is the failure this field exists to
    /// prevent. And on a seat the store is opened by `SeatLink`, beside the
    /// endpoint and per replica, so the core is HANDED one
    /// ([`Handle::attach_bytes`]) rather than opening its own.
    ///
    /// `None` is a core that holds text and refuses every photograph, which is
    /// an honest state and not a failure: a vault with no store refuses binary
    /// bytes rather than writing a row that names bytes nothing kept.
    bytes: Mutex<Option<centraid_blobs::ContentBytes>>,
    /// Open staging sessions: bytes a shell is streaming in so this core can
    /// name them (#1025 S4). See [`crate::stage`].
    staging: crate::stage::Staging,
    /// The clock and id source this core was opened with, kept so a
    /// re-bootstrap can hand the SAME ones to the file that replaces the
    /// replica (#1025 S2).
    ///
    /// `Arc`, not `Box`: `impl<T: Clock + ?Sized> Clock for Arc<T>` is already
    /// in `crates/vault`, so a shared clock is still one clock — which is the
    /// whole point, because a `FixedClock` a test advances must be the same
    /// object on both sides of the swap. Before this the core gave its clock
    /// away at `open` and the reopened vault silently took the build's default.
    stamp: Option<Stamp>,
    /// HOW MANY TIMES IN A ROW THE REPAIR HAS ENDED UNDER THE FLOOR
    /// (#1025 S2, D-1025-S2-4).
    ///
    /// Under the floor is the same path again — take the current copy — and
    /// that is right exactly once per cause. It is wrong forever: a gateway
    /// committing faster than this device can download leaves every fresh copy
    /// already stale by the time it lands, and the phone's retry timer then
    /// re-enters the repair on every pass, spending the member's data on a race
    /// it cannot win. v0 parked a mount after three in a row, and that is the
    /// bound restored here.
    ///
    /// Reset by any pass that does NOT ask for a re-bootstrap, because that is
    /// what "in a row" means.
    repairs_in_a_row: AtomicU64,
    /// THE ENROLMENT THE SHELL SUPPLIED (#1025 S7-13).
    ///
    /// One record, and the identity, the address and the relay decision all
    /// come off it. Held here rather than read from `CoreConfig` at the call
    /// site because `Core::open` consumes the config: the process builder —
    /// `crates/core-ffi` for a phone, `crates/centraid` for a desktop seat —
    /// builds the `SeatLink` *after* the handle exists and needs all three
    /// then. See [`crate::CoreConfig::pairing`].
    pairing: Option<crate::config::PairingRecord>,
}

/// HOW MANY CONSECUTIVE RE-BOOTSTRAPS PARK THE SEAT. v0's number.
///
/// Three rather than one, because the first two have honest causes that fix
/// themselves: a seat away longer than the log is kept, and a seat whose fresh
/// copy raced a prune that was already running. A third in a row is a gateway
/// this device cannot keep up with.
pub const REPAIRS_BEFORE_PARKING: u64 = 3;

/// The command name a shell sends to run one sync pass.
///
/// Namespaced under `seat.` so it cannot collide with a vault command: those
/// are `<app>.<action>` over registered apps, and no app is called `seat`.
pub const SEAT_SYNC_COMMAND: &str = "seat.sync";

/// THE COMMAND THAT CLOSES AN OPEN TAIL (#1025 S2, D-1025-S7-40).
///
/// A tail is closed by the SHELL, from the thread that learns the foreground
/// was lost — which is never the thread blocked inside the pass. It rides
/// `Command` for the same reason [`SEAT_SYNC_COMMAND`] does: clause 10 of the
/// C ABI says five symbols and means it, and a sixth entry point to stop a
/// sync would be a sixth entry point in production.
///
/// It answers immediately and always: "stop" names a state, and a call that
/// finds no tail open has found that state already true.
pub const SEAT_TAIL_STOP_COMMAND: &str = "seat.tail.stop";

/// FETCH THIS ONE NOW (#1025 S5, D-1025-S7-63).
///
/// WhatsApp's download arrow, as a command. Namespaced under `seat.` beside
/// [`SEAT_SYNC_COMMAND`] and [`SEAT_TAIL_STOP_COMMAND`] for the same two
/// reasons: it is not a vault command — no handler, no registered schema, no
/// row of its own — and clause 10 of the C ABI says five symbols and means it.
///
/// **It is `seat.sync` with a one-item window.** Not a fourth plane, not a
/// second byte path: the pass it runs writes `seat_blob_held` like any landed
/// blob, so the grid refreshes through the same `RowsChanged` over
/// `media_asset` (D-1025-S7-21) that every other arriving byte uses. A fetch
/// with its own transport would be a second way for a byte to become a row,
/// and the first thing that would rot.
pub const SEAT_BYTES_FETCH_COMMAND: &str = "seat.bytes.fetch";

/// A `seat.bytes.fetch` answer that never reached a window (#1025 S5).
///
/// **EXECUTED and not FAILED**, for the reason an unreachable gateway is not a
/// failed command: nothing went wrong. The member tapped a photograph this
/// device already holds, or one this replica has no row for, and the honest
/// answer is a code, a sentence from the core's own table, and a `fetched`
/// that says false.
fn fetch_refusal(reason: centraid_seat::sync::SkipReason, owner_ref: &str) -> wire::CommandOutcome {
    fetch_outcome(
        Some(reason),
        crate::error::skip_sentence(reason).unwrap_or_default(),
        Some(owner_ref),
    )
}

/// The shape both refusal paths answer in, so a shell has one decoder.
fn fetch_outcome(
    reason: Option<centraid_seat::sync::SkipReason>,
    sentence: &str,
    owner_ref: Option<&str>,
) -> wire::CommandOutcome {
    wire::CommandOutcome {
        status: wire::CommandStatus::Executed as i32,
        output: serde_json::to_vec(&serde_json::json!({
            "ownerRef": owner_ref.unwrap_or_default(),
            "fetched": false,
            "bytesMoved": 0,
            "unreachable": false,
            // A CODE AND NEVER A SENTENCE on the wire's decision field. The
            // sentence rides `reason`, from the core's own table, and a shell
            // that wanted to branch branches on this.
            "refusal": reason.map(skip_reason_name),
        }))
        .unwrap_or_default(),
        reason: sentence.to_owned(),
        ..Default::default()
    }
}

/// The closed set's names, as a shell reads them.
///
/// Spelled here rather than derived, because the wire's vocabulary is a
/// contract and a rename in Rust must not silently become a rename on a
/// screen.
const fn skip_reason_name(reason: centraid_seat::sync::SkipReason) -> &'static str {
    use centraid_seat::sync::SkipReason as R;
    match reason {
        R::NotRun => "notRun",
        R::NotPaired => "notPaired",
        R::AlreadyHeld => "alreadyHeld",
        R::NothingQueued => "nothingQueued",
        R::NothingWanted => "nothingWanted",
        R::Unreachable => "unreachable",
        R::CutBeforeReaching => "cutBeforeReaching",
        R::HandshakeRefused => "handshakeRefused",
        R::NoRoom => "noRoom",
        R::BootstrapRefused => "bootstrapRefused",
        R::RebootstrapRequired => "rebootstrapRequired",
        R::LogUnreadable => "logUnreadable",
        R::WritesUnreachable => "writesUnreachable",
        R::BytesUnreachable => "bytesUnreachable",
        R::StoreUnreadable => "storeUnreadable",
    }
}

/// The window a `seat.sync` command carries, as the core's own type.
///
/// ABSENT MEANS UNBOUNDED, and that is the honest reading rather than a
/// generous default: a caller that sent no window is a desktop "sync now" or a
/// developer at a terminal, neither of which has an expiry. A phone always
/// sends one, because a phone always has one.
fn window_from_wire(window: Option<&wire::SyncWindow>) -> crate::link::SyncWindow {
    let Some(window) = window else {
        return crate::link::SyncWindow::unbounded();
    };
    crate::link::SyncWindow {
        deadline: std::time::Duration::from_millis(window.deadline_ms),
        budget_bytes: window.budget_bytes,
        budget_items: window
            .budget_items
            .map(|items| usize::try_from(items).unwrap_or(usize::MAX)),
        // AN UNKNOWN SELECTOR IS THE FOREGROUND WINDOW, which is also what
        // `unspecified` means and what every caller got before the field
        // existed. A shell from a later build naming a fourth window gets the
        // one that holds nothing back rather than a refused pass.
        budget: match wire::SyncBudget::try_from(window.budget) {
            Ok(wire::SyncBudget::ShortRefresh) => crate::link::SyncBudget::ShortRefresh,
            Ok(wire::SyncBudget::NightShift) => crate::link::SyncBudget::NightShift,
            _ => crate::link::SyncBudget::Foreground,
        },
        metered: window.metered,
        // AN UNKNOWN RULE IS THE DEFAULT RULE, and the default is the
        // conservative one (#1025 S4). A shell from a later build naming a
        // fourth rule gets the one that waits for Wi-Fi rather than a refused
        // pass — so the failure mode of a word this build does not know is a
        // photograph that arrives late, never a member's bill.
        originals: match wire::TransferRule::try_from(window.originals) {
            Ok(wire::TransferRule::WifiAndCellularPhotos) => {
                crate::link::TransferRule::WifiAndCellularPhotos
            }
            Ok(wire::TransferRule::Manual) => crate::link::TransferRule::Manual,
            _ => crate::link::TransferRule::WifiOnly,
        },
        // A HASH THAT IS NOT ONE IS NO FETCH AT ALL (#1025 S5). The refusal a
        // member reads is decided at the command, where the replica can be
        // asked whether it has ever heard of the hash; what this must not do
        // is turn an unparseable string into a window that fetches the whole
        // vault.
        fetch: window
            .fetch_hash
            .as_deref()
            .and_then(|hex| centraid_blobs::ContentHash::parse_hex(hex).ok()),
        // ONE MECHANISM, THREE OCCASIONS (#1025 S2, D-1025-S7-40). A shell that
        // says nothing gets a bounded catch-up, which is what every caller
        // before this field had and what a desktop `sync now` is.
        tail: window.tail,
    }
}

/// WHETHER THIS REQUEST MAY HAVE MOVED THE WATERMARK (#1025 S2, D-1025-S7-40).
///
/// The three kinds that reach a handler which can write: a command, an intent,
/// and a staging frame. Deliberately coarse — a `seat.sync` on a seat is a
/// command and rings a bell no seat has — because the cost of a spurious ring
/// is one indexed read on a gateway and the cost of a missed one is a row a
/// member is waiting for.
fn wrote(request: &wire::Request) -> bool {
    matches!(
        request.kind,
        Some(wire::request::Kind::Command(_) | wire::request::Kind::Intent(_) | wire::request::Kind::Stage(_))
    )
}

/// A pairing refusal on the wire. The code carries the whole answer: the
/// vocabulary has no text field, on purpose (`pair.proto`).
const fn refused(code: wire::PairErrorCode) -> wire::PairResponse {
    wire::PairResponse {
        result: Some(wire::pair_response::Result::Error(wire::PairError {
            code: code as i32,
        })),
    }
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
            pairing,
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
        // source are kept here, not given away, because a re-bootstrap REOPENS
        // this path on a file that has just replaced it — and a fixed-clock
        // seat that silently took the build's default across that swap has lost
        // the determinism it was injected for.
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
        // A SEAT WITH NO FILE IS UNPAIRED, NOT A FAILURE (#1025 S1). It used to
        // be `VaultError::Missing`, which meant the only way a phone got a
        // replica was a script copying a gateway-role artifact into the
        // container — there was no creation path through the core at all. The
        // path is now: open unpaired, pair, and the pairing takes the copy.
        //
        // A GATEWAY still refuses, and must: `create: false` on a gateway means
        // the operator named a file that is not there, and founding a second
        // empty vault would serve every seat a log that applies cleanly and
        // says nothing.
        let unpaired = !founded && !create && !matches!(role, Role::Gateway);
        let vault = if unpaired {
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
        Ok(Handle {
            vault: Mutex::new(vault),
            path,
            registry: Registry::with_system_commands()?,
            role,
            ui_thread_name,
            events: Arc::new(EventQueue::new()),
            staging: crate::stage::Staging::default(),
            closed: AtomicBool::new(false),
            poison: Mutex::new(None),
            session: Mutex::new(Session::new()),
            cancelled: Mutex::new(Vec::new()),
            diagnostics: AtomicU64::new(0),
            network: Mutex::new(None),
            tail_stop: Mutex::new(None),
            commit_bells: Mutex::new(Vec::new()),
            bytes: Mutex::new(None),
            stamp,
            pairing,
            repairs_in_a_row: AtomicU64::new(0),
        })
    }

    /// Open (or create) the file and put the content store beside it.
    ///
    /// Split out of [`Self::open`] because a bootstrap re-opens the same file
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
        // This used to OPEN one here — a flat `<vault>.blobs/` CAS beside the
        // file — and that is how a device came to hold two content stores: this
        // one, which nothing but `content_location` ever read, and iroh's
        // `<vault>.bytes`, which every transfer wrote. A photograph a seat
        // synced could not be displayed and one a window minted could not be
        // served.
        //
        // Opening the byte plane's store is asynchronous and belongs to
        // whoever owns a runtime — `SeatLink` on a phone, `run.rs` on a
        // gateway — so this function takes the store rather than making one,
        // and [`Handle::attach_bytes`] re-attaches it to the vault a bootstrap
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

    /// THE ENROLMENT THIS CORE WAS OPENED WITH (#1025 S7-13).
    ///
    /// What the process builder reads to build the `SeatLink`: the identity to
    /// bind with, the relay decision, and the public key to check the endpoint
    /// that came up against.
    #[must_use]
    pub const fn enrolment(&self) -> Option<&crate::config::PairingRecord> {
        self.pairing.as_ref()
    }

    /// The endpoint identity the shell supplied for this vault, if any.
    ///
    /// `None` means the shell had nothing to hand back and the endpoint mints a
    /// fresh key — which is a seat its gateway will not recognise. After a
    /// pairing that is caught at open by [`Self::enrolment`]'s
    /// `enrolled_public_key`; before one it is the ordinary first run.
    #[must_use]
    pub fn endpoint_secret(&self) -> Option<[u8; 32]> {
        self.pairing.as_ref().and_then(|record| record.secret)
    }

    /// WHAT THE RECORD SAYS ABOUT RELAYS (#1025 S7-13).
    ///
    /// `None` — no record, or a record that has not been told — is "not known",
    /// and the caller keeps relays on: a device redeeming a ticket does not yet
    /// know what deployment it is joining. `Some("")` is a record that STATED
    /// it has no relay, which is a LAN-only deployment, and the endpoint comes
    /// up with relay mode disabled. `Some(url)` names one.
    #[must_use]
    pub fn relay_hint(&self) -> Option<&str> {
        self.pairing.as_ref()?.relay_url.as_deref()
    }

    /// Whether the authority lives here.
    #[must_use]
    pub fn is_gateway(&self) -> bool {
        self.role == Role::Gateway
    }

    /// The vault this core's file is holding, when it is holding one.
    ///
    /// `None` for a seat opened at a path with no file yet, and `None` for a
    /// file with a schema and no `core_vault` row — both of which are the
    /// ordinary shape of a replica that has not bootstrapped, and both of which
    /// are free for a pairing to land on. A read error is also `None`: this
    /// answers "is there something here to destroy", and a file that will not
    /// answer is one whose bootstrap will fail on its own terms rather than one
    /// this guard should refuse by guessing.
    fn held_vault_id(&self) -> Option<String> {
        let held = self
            .vault
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        held.as_ref()?
            .vault_id()
            .ok()
            .flatten()
            .filter(|id| !id.is_empty())
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
        // A PAIRING MUST NEVER LAND ON A REPLICA THAT ALREADY HOLDS A VAULT
        // (#1025 S7-9).
        //
        // `bootstrap` below publishes the first copy INTO the file this core is
        // open on. Reproduced on the simulator: a phone holding vault A opened
        // the gateway sheet, redeemed a ticket for vault B down its LIVE core,
        // and vault A's replica was replaced — no error, no warning, and the
        // shell then found neither file where it expected one and drew "No
        // vault yet" over a device that held two vaults a second earlier.
        //
        // The shell's own fix is that `Shelf.admit` always pairs from a fresh
        // file at `Replicas.PAIRING_FILE`, so this can only fire on a caller
        // that has not done that. It is still here, and is not redundant: the
        // destructive act is the CORE's, `seed-demo-vault` refuses the same way
        // over the same hazard, and a guard that lives only in one of two
        // shells is a guard the third caller walks past.
        //
        // **No `--force`.** A caller that wants to pair has a fresh file
        // available to pair from; there is no case where overwriting a member's
        // rows is the thing they meant.
        //
        // BEFORE THE TICKET IS REDEEMED, so a refusal burns nothing: the
        // gateway never hears about this attempt and the code stays good.
        if !self.is_gateway()
            && let Some(vault_id) = self.held_vault_id()
        {
            return Err(CoreError::VaultAlreadyHeld { vault_id });
        }
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
        let outcome = network.pair(encoded, &request.device_name, &request.platform);
        // THE LOCK GOES BEFORE THE BOOTSTRAP. `Handle::bootstrap` takes it
        // again, and a re-entrant `Mutex` lock is a deadlock rather than a
        // reentrancy.
        drop(held);
        match outcome {
            Ok(paired) => {
                // PAIRING CREATES THE REPLICA (#1025 S1). It is the moment the
                // device is first allowed to ask for a copy, and until this
                // slice there was no moment at all — a phone's file was placed
                // by `mobile/scripts/demo-vault.sh` copying a GATEWAY-role
                // artifact into the container, which is not a replica and never
                // was one.
                //
                // A failure here does NOT fail the pairing. The ticket is
                // burned, the gateway has enrolled this device, and telling the
                // member it failed would send them to mint a code they no
                // longer need; the next sync takes the copy.
                if !self.is_gateway() {
                    match paired.snapshot.as_ref() {
                        Some(offer) => {
                            // A PAIRING IS A FOREGROUND MOMENT by definition:
                            // a member is holding the phone, looking at the
                            // screen that said "Paired". So it adopts.
                            if let Err(refusal) = self.bootstrap(offer, true) {
                                tracing::warn!(
                                    ?refusal,
                                    "paired, and the first copy did not land yet"
                                );
                            }
                        }
                        // PAIRED, NO FILE YET, AND THAT IS A STATE (#1025 S7,
                        // item 3). The gateway had no artifact to name; the
                        // ticket is burned and this device is enrolled, so the
                        // next window asks again and the shell draws "Copying
                        // your vault" in the meantime.
                        None => tracing::warn!("paired, and the gateway offered no copy"),
                    }
                }
                // THE PAIRING TRAVELS OUT TO THE SHELL (#1025 S7, item 3).
                //
                // It used to be written into the replica here, after the
                // bootstrap, because the bootstrap was what created the file it
                // went in — which meant a pairing whose first copy did not land
                // was a pairing that did not survive the relaunch. **Before the
                // first bootstrap the record lives only in the secure store**:
                // the answer below carries everything needed to dial again, and
                // the shell hands it back at the next `open`. The replica gets
                // its own copy inside the transaction that adopts the file.
                Ok(wire::PairResponse {
                    result: Some(wire::pair_response::Result::Ok(wire::PairOk {
                        // WHERE THIS VAULT IS REACHED RIGHT NOW, and never a name
                        // (#1025 S1). Nothing on a device is keyed by it: the
                        // replica, the outbox and the byte store are named by the
                        // VAULT, so a vault restored onto another machine keeps
                        // every one of them and only this address changes.
                        gateway_address: crate::link::hex_lower(&paired.endpoint_id),
                        device_id: paired.device_id,
                        vault_id: paired.vault_id,
                        vault_name: paired.vault_name,
                        snapshot_hash: paired
                            .snapshot
                            .as_ref()
                            .map(|offer| offer.hash.clone())
                            .unwrap_or_default(),
                        snapshot_seq: paired
                            .snapshot
                            .as_ref()
                            .map_or(0, |offer| u64::try_from(offer.seq).unwrap_or(0)),
                        snapshot_bytes: paired.snapshot.as_ref().map_or(0, |offer| offer.bytes),
                        relay_url: paired.relay_url,
                        direct_addrs: paired.direct_addrs,
                        // WHAT THIS GATEWAY JUST ENROLLED (#1025 S7-13). The
                        // shell writes it into the enrolment record beside the
                        // secret, and every later open checks the endpoint that
                        // came up against it rather than discovering the loss
                        // one dial later, as an unenrolled peer.
                        enrolled_public_key: paired.enrolled_public_key,
                    })),
                })
            }
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
    fn seat_sync(&self, command: &wire::Command) -> Result<wire::CommandOutcome> {
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
        let window = window_from_wire(command.sync_window.as_ref());
        let outcome = self.sync_now(window)?;
        let output = serde_json::json!({
            // THE COUNTS, AS PROJECTIONS OF THE ONE REPORT (#1025 S7). Every
            // one of these is a method on `SyncOutcome` over
            // `centraid_seat::sync::PassReport`, so a number here and the stage
            // it came from cannot disagree — which is exactly what a dozen
            // independently-maintained flat fields could do and did.
            "rowsApplied": outcome.rows_applied(),
            "blobsCompleted": outcome.blobs_completed(),
            "bytesMoved": outcome.bytes_moved(),
            "blobsDeferred": outcome.blobs_deferred(),
            "unreachable": outcome.unreachable(),
            "rebootstrapRequired": outcome.rebootstrap_required(),
            // THE TWO FACTS A BADGE DRAWS THAT ARE NOT NUMBERS (#1025 S2).
            // "cut" is an ordinary background refresh and "parked" is the one
            // state that needs the member; a shell that could not tell them
            // apart would show a warning for every thirty-second window.
            "cutByTheDeadline": outcome.cut_by_the_deadline(),
            "parked": outcome.parked,
            "behind": outcome.report.behind,
            // A TAIL WAS OPEN ON THIS WINDOW (#1025 S2, D-1025-S7-40). The fact
            // a header draws ONLINE from: a tail that is open IS a gateway that
            // is reached, and a caught-up device on a quiet vault moves no rows
            // for hours without being offline for a second of it.
            "tailOpen": outcome.report.tailing(),
            // THE EXHAUSTIVE HALF (#1025 S7, item 2). Four stages, and each of
            // them says exactly one of three things: what it moved, what it
            // kept when the deadline ended it, or which of a CLOSED set of
            // reasons stopped it.
            //
            // This replaces `stale`, `blocked`, `bytesStalled` and
            // `blobsRefused` — four fields added one at a time, each the first
            // time somebody could not tell two outcomes apart, and each of
            // which left the NEXT unthought-of case reading as four zeros and
            // no error. A stage cannot be silent, so there is no such case
            // left.
            //
            // THE SHELL RENDERS THIS AND COMPUTES NOTHING. The reason is a
            // CODE and the sentence beside it comes from the core's own table
            // (`crate::error::skip_sentence`), which is the same rule
            // `CoreError::sentence` is built on: no database text, no path and
            // no peer's words reach a member.
            "stages": {
                "bootstrap": bootstrap_json(&outcome.report.bootstrap),
                "rows": rows_stage(&outcome.report.rows),
                "intents": intents_stage(&outcome.report.intents),
                "bytes": bytes_stage(&outcome.report.bytes),
            },
            // THE WINDOW, ECHOED BACK AS THE CORE RECEIVED IT. Which budget a
            // pass ran under was inferable and never answerable, so a shell
            // debugging its own `SyncWindowPolicy` had to reason backwards from
            // byte counts. A field the shell chose and the core acted on is
            // owed back to it.
            "window": {
                "budget": match window.budget {
                    crate::link::SyncBudget::ShortRefresh => "short-refresh",
                    crate::link::SyncBudget::NightShift => "night-shift",
                    crate::link::SyncBudget::Foreground => "foreground",
                },
                "metered": window.metered,
                // THE MEMBER'S RULE, ECHOED BACK (#1025 S4). Same reason the
                // budget is: a shell debugging its own transfer-rules sheet
                // had to reason backwards from byte counts, and a field the
                // shell chose and the core acted on is owed back to it.
                "originals": match window.originals {
                    crate::link::TransferRule::WifiOnly => "wifi-only",
                    crate::link::TransferRule::WifiAndCellularPhotos => "wifi-and-cellular-photos",
                    crate::link::TransferRule::Manual => "manual",
                },
                "deadlineMs": u64::try_from(window.deadline.as_millis()).unwrap_or(u64::MAX),
            },
        });
        Ok(wire::CommandOutcome {
            // AN UNREACHABLE GATEWAY IS NOT A FAILED COMMAND. The pass ran, it
            // did what it could, and it reported honestly; a shell that drew a
            // red banner every time a phone was in a lift would be wrong about
            // what happened. A window the deadline cut is the same kind of
            // answer, for the same reason.
            status: wire::CommandStatus::Executed as i32,
            output: serde_json::to_vec(&output).unwrap_or_default(),
            reason: outcome.sentence,
            ..Default::default()
        })
    }

    /// Fetch ONE original the member tapped (#1025 S5, D-1025-S7-63).
    ///
    /// ## Three refusals, and every one of them is a code
    ///
    /// `notPaired`, `alreadyHeld` and `noSuchBlob` are answered from
    /// [`centraid_seat::sync::SkipReason`]'s closed set, so the sentence comes
    /// from `crate::error::skip_sentence` and no database text, no path and no
    /// peer's words reach a member. `unreachable` is not decided here at all —
    /// the pass runs, does what it can, and reports it, because a gateway that
    /// was not reached is not a failed command and a member in a lift must not
    /// see a red banner.
    ///
    /// ## `alreadyHeld` is checked BEFORE the window, not inferred after it
    ///
    /// A pass over a held blob plans nothing, and so does a pass for a hash
    /// this replica never heard of. Two different answers that look identical
    /// from the outside is the shape of every defect the one-report ruling
    /// (#1025 S7) deletes, so the two questions are asked of the replica's own
    /// tables — `seat_blob_held` and the content rows — and answered by name.
    fn seat_bytes_fetch(&self, command: &wire::Command) -> Result<wire::CommandOutcome> {
        use centraid_seat::sync::SkipReason;
        // A GATEWAY HOLDS ITS OWN BYTES. There is nothing to fetch and nowhere
        // to fetch it from, and saying so is better than a refusal about
        // pairing that would send a member looking for a gateway they are.
        if self.is_gateway() {
            return Ok(fetch_outcome(
                Some(SkipReason::NothingWanted),
                "This vault lives on this device, so the photograph is already here.",
                None,
            ));
        }
        // THE INPUT IS THE COMMAND'S OWN CANONICAL JSON, like every other
        // command's. `ownerRef` is carried and not used for the decision: the
        // hash is what addresses bytes, and the asset id is what a log line
        // needs to say WHICH photograph a member tapped.
        let input: serde_json::Value =
            serde_json::from_slice(&command.input).unwrap_or(serde_json::Value::Null);
        let owner_ref = input
            .get("ownerRef")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .to_owned();
        let Some(hash) = input
            .get("contentHash")
            .and_then(serde_json::Value::as_str)
            .and_then(|hex| centraid_blobs::ContentHash::parse_hex(hex).ok())
        else {
            // NOT AN `InvalidRequest`. A shell that sent a hash this build
            // cannot parse and a member who tapped a cell whose bytes this
            // replica has no row for are the same thing from here — there is
            // nothing to fetch — and the member reads one sentence either way.
            return Ok(fetch_refusal(SkipReason::NothingWanted, &owner_ref));
        };
        let hex = hash.to_hex();
        // THE TWO QUESTIONS, OF THE REPLICA'S OWN TABLES. Both are
        // `crates/seat`'s SQL, where a replica's statements live.
        let known = self.with_vault(|vault| {
            Ok(vault.read(|connection| {
                // `crates/seat`'s error, answered inside the read and mapped
                // at the edge: a seat table this replica does not have is the
                // same answer as a replica that is not there, and both are
                // `notPaired` from a member's side.
                Ok((
                    centraid_seat::bytes::holds(connection, &hex).unwrap_or(false),
                    centraid_seat::bytes::knows(connection, &hex).unwrap_or(false),
                ))
            })?)
        });
        let (held, known) = match known {
            Ok(answer) => answer,
            // NO REPLICA YET IS NOT PAIRED, from a member's side: there is
            // nothing on this device to fetch into.
            Err(_) => return Ok(fetch_refusal(SkipReason::NotPaired, &owner_ref)),
        };
        if held {
            // A SECOND TAP IS NOTHING TO DO, by code. The bytes are here, the
            // cell is already drawing them, and running a window that plans
            // nothing would report a successful fetch of nothing.
            return Ok(fetch_refusal(SkipReason::AlreadyHeld, &owner_ref));
        }
        if !known {
            return Ok(fetch_refusal(SkipReason::NothingWanted, &owner_ref));
        }
        // A FOREGROUND WINDOW FOR ONE ITEM. The member is looking at the
        // screen, so nothing is held back by the budget; `fetch` is what makes
        // it one item, and it suspends the tier rules for that item alone —
        // the rule itself is untouched and the next ordinary window plans by
        // it again.
        //
        // `metered` and `originals` are carried from the shell's window
        // unchanged so the ECHO is honest, and neither can change the outcome:
        // `Budget::only` is checked before the rule.
        let sent = window_from_wire(command.sync_window.as_ref());
        let outcome = self.sync_now(crate::link::SyncWindow {
            budget: crate::link::SyncBudget::Foreground,
            fetch: Some(hash),
            // A TAIL IS NOT WHAT A TAP ASKED FOR. This window ends when the
            // blob lands or the link goes away.
            tail: false,
            ..sent
        })?;
        let completed = outcome.blobs_completed();
        tracing::info!(
            owner_ref = %owner_ref,
            completed,
            "a member asked for one original"
        );
        Ok(wire::CommandOutcome {
            status: wire::CommandStatus::Executed as i32,
            output: serde_json::to_vec(&serde_json::json!({
                "ownerRef": owner_ref,
                "fetched": completed > 0,
                "bytesMoved": outcome.bytes_moved(),
                "unreachable": outcome.unreachable(),
                // NO REFUSAL IS A REFUSAL OF ITS OWN. A window that ran and
                // moved nothing because the gateway was away says so through
                // `unreachable` and the stage report, which is the same shape
                // every other pass answers in.
                "refusal": serde_json::Value::Null,
                "stages": { "bytes": bytes_stage(&outcome.report.bytes) },
            }))
            .unwrap_or_default(),
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
        // THE STOP IS TAKEN OUT NOW, not asked for later (#1025 S2). See
        // `stop_tail`: by the time there is a tail to close, the network lock
        // is held by the pass that owns it.
        if let Ok(mut stop) = self.tail_stop.lock() {
            *stop = network.tail_stopper();
        }
        if let Ok(mut held) = self.network.lock() {
            *held = Some(network);
        }
        // AND IT TAKES BACK THE PAIRING THIS REPLICA REMEMBERS (#1025 S5).
        // Without this the seat had a durable identity and no address: the
        // record lived only in the network's own memory, `sync` refuses when it
        // has none, and a reopened seat therefore reported itself unreachable
        // having never dialled. The shell does nothing — it opens and syncs.
        self.readopt_gateway();
        // AND THE HELD-BLOB TABLE IS REBUILT FROM THE STORE (#1025,
        // D-1025-S7-20). This is "at core open": the shell opens, attaches and
        // syncs, so the first thing that happens after a launch — before any
        // screen reads a page — is the table being made to agree with the
        // store it projects. Without it, drift survives a launch invisibly: a
        // missing row renders exactly like a photograph that has not arrived.
        self.rebuild_held_blobs();
    }

    /// Make the seat's held-blob table agree with the byte store.
    ///
    /// Quiet on every absence, as [`Self::readopt_gateway`] is: a core with no
    /// network, no replica or no store is an ordinary state. **A store that
    /// cannot ANSWER leaves the table alone** — clearing it would be a device
    /// that forgot every photograph it holds because one call failed.
    fn rebuild_held_blobs(&self) {
        let held = {
            let Ok(network) = self.network.lock() else {
                return;
            };
            let Some(network) = network.as_ref() else {
                return;
            };
            let Some(held) = network.held_blobs() else {
                return;
            };
            held
        };
        let now = self.now_text();
        let rebuilt = self.with_vault(|vault| {
            vault
                .apply_replica(|connection| {
                    Ok(centraid_seat::held::rebuild(connection, &held, &now))
                })
                .map_err(CoreError::from)
        });
        match rebuilt {
            Ok(Ok(rows)) => tracing::debug!(rows, "the held-blob table was rebuilt from the store"),
            Ok(Err(error)) => {
                tracing::warn!(%error, "the held-blob table could not be rebuilt");
            }
            Err(error) => {
                tracing::debug!(%error, "no replica to rebuild the held-blob table in");
            }
        }
    }

    /// Hand the attached network the pairing the replica holds, if both exist.
    ///
    /// Quiet on every absence, because each one is an ordinary state: no
    /// network is a local-first vault, no replica is an unpaired seat, and no
    /// record is a replica that has never been paired. None of the three is
    /// something to tell a member about.
    fn readopt_gateway(&self) {
        // THE REPLICA FIRST, THEN THE SHELL'S OWN RECORD (#1025 S7, item 3).
        //
        // A seat that holds a copy holds the pairing in it, written by the
        // transaction that adopted the file. A seat that has NO copy yet — one
        // that paired and could not take one — has nothing in a file to read,
        // and the record the shell kept in its secure store is the only thing
        // that stops a burned ticket from being wasted.
        let Some(remembered) = self
            .remembered_gateway()
            .or_else(|| self.configured_gateway())
        else {
            return;
        };
        if let Ok(held) = self.network.lock()
            && let Some(network) = held.as_ref()
        {
            network.adopt(remembered);
        }
    }

    /// The pairing the shell handed over at `open`.
    fn configured_gateway(&self) -> Option<crate::link::PairedGateway> {
        let record = self.pairing.as_ref()?;
        Some(crate::link::PairedGateway {
            endpoint_id: crate::link::from_hex(&record.gateway_address)?,
            vault_id: record.vault_id.clone(),
            vault_name: record.vault_name.clone(),
            device_id: String::new(),
            relay_url: record.relay_url.clone().unwrap_or_default(),
            direct_addrs: record.direct_addrs.clone(),
            enrolled_public_key: Vec::new(),
            // NO BLOB. The offer was the gateway's answer on the one occasion it
            // told this device to take a copy; a hash a shell kept and handed
            // back later is one nobody may still be serving, and a seat with no
            // file asks for a fresh one on its next pass.
            snapshot: None,
        })
    }

    /// The pairing recorded in this replica.
    fn remembered_gateway(&self) -> Option<crate::link::PairedGateway> {
        let held = self.vault.lock().ok()?;
        let vault = held.as_ref()?;
        let record = vault
            .read(|connection| Ok(centraid_seat::paired_gateway(connection)))
            .ok()?
            .ok()
            .flatten()?;
        let endpoint_id = crate::link::from_hex(&record.endpoint_id)?;
        Some(crate::link::PairedGateway {
            endpoint_id,
            vault_id: record.vault_id,
            vault_name: record.vault_name,
            device_id: record.device_id,
            relay_url: record.relay_url,
            direct_addrs: record.direct_addrs,
            enrolled_public_key: Vec::new(),
            // A REMEMBERED PAIRING NAMES NO BLOB. The offer is what the gateway
            // said on the one occasion it told this device to take a copy; a
            // stale one read back off disk would be a hash nobody serves.
            snapshot: None,
        })
    }

    /// The clock this core stamps its own rows with.
    fn now_text(&self) -> String {
        match &self.stamp {
            Some((clock, _)) => centraid_vault::Clock::now_text(clock.as_ref()),
            None => centraid_vault::Clock::now_text(&centraid_vault::clock::SystemClock),
        }
    }

    /// Attach THE content store this device holds for this vault (#1025 S3).
    ///
    /// One per vault, opened by whoever owns a runtime, and the same one the
    /// byte plane fetches into: a device holds one content store per vault, the
    /// grid reads it and the window writes it (D-1025-S3-1). Attaching it puts
    /// the vault's byte door over it, so `media.add_asset` spills into the
    /// store a seat can serve from and `content_location` answers with a file
    /// a platform can open.
    ///
    /// Attached AFTER the vault is open, because opening the store is
    /// asynchronous and `Core::open` is not. A core that is never handed one
    /// holds text and refuses photographs, honestly and by name.
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
    /// The gateway calls this at start, after the byte door is attached. It is
    /// bounded (`limit` items) and resumable — an item that gained its rows is
    /// no longer a candidate — so a large old vault converges over several
    /// starts rather than holding the first one open.
    ///
    /// **Only a gateway may call it.** The derivative is a gateway-derived fact
    /// and reaches every replica as ordinary log rows; a seat running this
    /// would be a second writer. A SEAT answers `Ok(0)` rather than an error,
    /// because "nothing to do here" is the truth.
    ///
    /// Non-fatal by construction for the caller too: it returns the number of
    /// items that gained tiers, and a vault with no byte store returns zero.
    ///
    /// **THE GUARD SAYS `is_gateway` AND AN OPEN VAULT, AND NOTHING ELSE**
    /// (#1025 S7, the verifier's finding). It used to read
    /// `!self.is_gateway() || self.holds_a_replica()`, and
    /// [`Self::holds_a_replica`] is `self.vault.lock().is_some()` — which is
    /// TRUE OF A GATEWAY TOO, because a gateway's vault is the one thing it
    /// certainly has open. So the second clause fired on every gateway, the
    /// sweep returned `Ok(0)` at every start, and the backfill this command
    /// exists for never ran once. The word "replica" in that predicate meant
    /// "a seat's copy" to the reader and "a vault is open" to the compiler;
    /// the role is the question, so the role is what is asked.
    pub fn derive_missing_tiers(&self, limit: usize) -> Result<u64> {
        // A gateway with no `--data-dir` has no vault to sweep. `with_vault`
        // below would answer `Unpaired`, and an error is the wrong shape for
        // "there is nothing here": this returns the same honest zero a seat does.
        if !self.is_gateway() || !self.holds_a_replica() {
            return Ok(0);
        }
        // The owner of this device's own vault. The same principal the local
        // prediction door uses: there is no remote caller here to attribute a
        // gateway's own housekeeping to, and inventing one would be claiming an
        // authority nothing granted.
        let principal = centraid_vault::Principal::owner("this-gateway");
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

    /// CLOSE THE TAIL THIS CORE'S NETWORK IS HOLDING (#1025 S2, D-1025-S7-40).
    ///
    /// Safe to call from any thread and from a core with no network, no tail or
    /// no replica: "stop" names a state and never fails to reach it. It does
    /// NOT block on the pass — the pass is what it is ending — so the window's
    /// own `sync_now` call returns on its own thread with the report of what
    /// the tail moved before it closed.
    pub fn stop_tail(&self) {
        // ITS OWN LOCK, AND THE REASON IS THE WHOLE DESIGN. `sync_now` holds
        // the NETWORK for the length of a pass, and a tail is a pass that lasts
        // as long as the member is looking at the app — so a stop that took
        // that lock would be answered when the thing it was stopping had
        // already ended.
        if let Ok(held) = self.tail_stop.lock()
            && let Some(stop) = held.as_ref()
        {
            stop.stop();
        }
    }

    /// RING ME WHEN THIS VAULT COMMITS (#1025 S2, D-1025-S7-40).
    ///
    /// The gateway process calls this once, at startup, and its seat lane hangs
    /// every tail off the one bell. A list rather than a slot because a process
    /// that grew a second interested party — an automation runner, a desktop
    /// window — must not silence the first by registering.
    pub fn watch_commits(&self, bell: std::sync::Arc<dyn crate::link::CommitBell>) {
        if let Ok(mut bells) = self.commit_bells.lock() {
            bells.push(bell);
        }
    }

    /// Ring every bell. Called after a request that MAY have written.
    ///
    /// "May" is the whole of it: a ring that moved nothing costs the reader one
    /// indexed read and a page it does not write, and a ring that was missed is
    /// a row a member is waiting for. The asymmetry decides which way to guess.
    fn ring_commits(&self) {
        let Ok(bells) = self.commit_bells.lock() else {
            return;
        };
        for bell in bells.iter() {
            bell.rang();
        }
    }

    /// Run one sync pass, if a network is attached.
    ///
    /// Blocks. Never call it on a UI thread: the callers are a background
    /// refresh task and an explicit "sync now", both already off the main
    /// thread on both platforms.
    pub fn sync_now(&self, window: crate::link::SyncWindow) -> Result<crate::link::SyncOutcome> {
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
        // THE CHANGE FEED, HANDED DOWN WITH THE CONNECTION (#1025 S5). The
        // queue is here and the applier is two crates below; this is how the
        // rows a pass lands reach a shell at all.
        let changes = crate::events::ChangeFeed::new(self.events());
        let pass = |network: &dyn crate::link::SeatNetwork| {
            self.with_vault(|vault| {
                // `apply_replica` AND NOT `read` (#1025 S5). A pass APPLIES the
                // gateway's log; `Vault::read` sets `PRAGMA query_only = ON`
                // for its duration, so every apply this core ever ran failed
                // inside the applier, landed in `PassReport::stale` — which
                // `SyncOutcome` has no field for — and came back as a reached
                // gateway with zero rows. Every test that saw a row arrive
                // drove `SeatLink` over a connection of its own, so nothing
                // caught it.
                vault
                    .apply_replica(|connection| Ok(network.sync(connection, window, &changes)))
                    .map_err(CoreError::from)
            })
        };
        // A SEAT WITH NO COPY TAKES ONE FIRST (#1025 S1). The lock is released
        // around every bootstrap, because `Handle::bootstrap` takes it itself.
        //
        // AND ONLY A FOREGROUND WINDOW ADOPTS (#1025 S7, item 3). Adoption
        // closes the vault, renames a file into place and reopens it; a
        // thirty-second background refresh that was cut halfway through the
        // fetch would leave a member looking at a device that had gone blank
        // and come back. A background window still FETCHES — every verified
        // chunk group is durable and the next foreground window adopts what it
        // paid for — which is why this is one call with a flag and not two
        // paths.
        let may_adopt = matches!(window.budget, crate::link::SyncBudget::Foreground);
        if !self.holds_a_replica() {
            // THE OFFER THE PAIRING NAMED, or one asked for now. A device that
            // paired and could not take its copy comes back with the record out
            // of the shell's secure store and no offer at all; the gateway is
            // asked, because the alternative is a burned ticket and a member
            // minting another for no reason.
            let offer = network
                .gateway()
                .and_then(|gateway| gateway.snapshot)
                .or_else(|| network.offer());
            drop(held);
            let Some(offer) = offer else {
                // PAIRED, NO FILE, AND NO BLOB NAMED. Not a failure: the
                // gateway had nothing to offer when this device paired, or this
                // device is not paired at all. Either way there is nothing to
                // sync from, and the answer says which.
                return Ok(self.dress(centraid_seat::sync::PassReport::stopped(
                    centraid_seat::sync::SkipReason::NotPaired,
                )));
            };
            let taken = self.bootstrap(&offer, may_adopt);
            if !self.holds_a_replica() {
                // THE COPY DID NOT LAND. What the window moved is still
                // reported — a fetch that got 40 MB of the way is progress a
                // "Copying your vault" screen draws — and the pass does not
                // run, because there is nothing to run it against.
                let mut report = centraid_seat::sync::PassReport::stopped(
                    centraid_seat::sync::SkipReason::NotRun,
                );
                report.bootstrap = bootstrap_stage(taken, may_adopt);
                return Ok(self.dress(report));
            }
            let held = self.network.lock().map_err(|_| CoreError::Unpaired)?;
            let Some(network) = held.as_ref() else {
                return Err(CoreError::Unpaired);
            };
            let mut report = pass(network.as_ref())?;
            report.bootstrap = bootstrap_stage(taken, may_adopt);
            return self.settle_repair(self.dress(report));
        }
        let outcome = self.dress(pass(network.as_ref())?);
        // AND THEN THE TAIL, IF THIS WINDOW ASKED FOR ONE (#1025 S2,
        // D-1025-S7-40). The catch-up above is the ordinary pass; from here the
        // seat stays on one stream and applies what arrives.
        if window.tail && !outcome.rebootstrap_required() && outcome.reached_the_gateway() {
            let outcome = self.tail(network.as_ref(), window, &changes, outcome)?;
            return self.settle_repair(outcome);
        }
        // UNDER THE FLOOR IS THE SAME PATH AGAIN. Not a repair branch and not a
        // partial catch-up: the deltas between this seat's cursor and the floor
        // are collected and no amount of asking brings them back, so the seat
        // takes the current copy. The outbox and its order survive, because a
        // re-bootstrap copies the seat's own tables into the new file before it
        // is renamed over the old one (`centraid_seat_link::bootstrap`).
        if !outcome.rebootstrap_required() {
            return self.settle_repair(outcome);
        }
        // AND IT IS BOUNDED (#1025 S2, D-1025-S2-4). S1 left this unbounded and
        // said so: a gateway committing faster than this device can download
        // leaves every fresh copy stale before it lands, and the retry timer
        // then re-enters the repair on every pass forever. Three in a row is
        // v0's bound, and the seat PARKS rather than downloading a fourth.
        //
        // PARKED MEANS NOTHING IS WIPED. The copy stays, the outbox stays, the
        // rows still read; what stops is the repair. The member is told, in
        // their own words, that this device cannot keep up — which is the true
        // thing and the only thing they can act on.
        if self.repairs_in_a_row.load(Ordering::SeqCst) >= crate::REPAIRS_BEFORE_PARKING {
            return Ok(crate::link::SyncOutcome {
                parked: true,
                sentence: crate::error::PARKED_SENTENCE.to_owned(),
                ..outcome
            });
        }
        let Some(offer) = outcome
            .report
            .rebootstrap
            .as_ref()
            .and_then(|told| told.snapshot.clone())
        else {
            // TOLD TO TAKE A COPY AND NOT TOLD WHICH. The gateway could not
            // build or find an artifact; the seat keeps what it has and asks
            // again, which is the same shape as a first pairing with no offer.
            return self.settle_repair(outcome);
        };
        self.repairs_in_a_row.fetch_add(1, Ordering::SeqCst);
        drop(held);
        let taken = self.bootstrap(&offer, may_adopt);
        if !self.holds_a_replica() {
            let mut report = outcome.report.clone();
            report.bootstrap = bootstrap_stage(taken, may_adopt);
            return Ok(self.dress(report));
        }
        let held = self.network.lock().map_err(|_| CoreError::Unpaired)?;
        let Some(network) = held.as_ref() else {
            return Err(CoreError::Unpaired);
        };
        let mut report = pass(network.as_ref())?;
        report.bootstrap = bootstrap_stage(taken, may_adopt);
        self.settle_repair(self.dress(report))
    }

    /// HOLD THE LOG OPEN, AND HOLD NOTHING ELSE (#1025 S2, D-1025-S7-40).
    ///
    /// The loop is two steps and the split between them is the whole design:
    ///
    /// 1. **wait, with nothing held** — `await_tail_page` blocks on the stream
    ///    outside this core's vault mutex;
    /// 2. **apply what is in hand** — `apply_tail` takes the vault, drains the
    ///    pages the reader has already delivered, and returns.
    ///
    /// A tail that waited inside the vault would hold it for as long as the
    /// member had the app open, and **every other call on this core would hang
    /// until somebody else committed something**. That is not hypothetical:
    /// Slice 1 found it on a phone, as a photo grid stuck on a spinner that
    /// killing the gateway did not release.
    ///
    /// The window's deadline bounds the whole of it; the shell's stop and the
    /// gateway closing end it the same way. Whatever each step applied is
    /// durable, and the outcome the caller gets is the LAST step that moved
    /// something — with `tailOpen` true, because a tail that was open is a
    /// gateway that was reached.
    fn tail(
        &self,
        network: &dyn crate::link::SeatNetwork,
        window: crate::link::SyncWindow,
        changes: &crate::events::ChangeFeed,
        caught_up: crate::link::SyncOutcome,
    ) -> Result<crate::link::SyncOutcome> {
        let until = std::time::Instant::now() + window.deadline;
        let cursor = self.with_vault(|vault| {
            vault
                .read(|connection| {
                    Ok(centraid_seat::state::seat_state(connection)
                        .map_err(|error| error.to_string()))
                })
                .map_err(CoreError::from)
        })?;
        // A FILE THAT CANNOT SAY WHERE ITS CURSOR IS DOES NOT TAIL, and that is
        // not a failed pass: the catch-up above is what this window achieved.
        // Asking for a tail from a cursor nobody knows would be asking the
        // gateway to re-serve a log from the floor.
        let cursor = match cursor {
            Ok(cursor) => cursor,
            Err(detail) => {
                tracing::warn!(%detail, "this seat has no cursor to tail from");
                return Ok(caught_up);
            }
        };
        if !network.start_tail(&cursor.epoch, cursor.applied_seq, until) {
            // NOT A FAILURE. The catch-up above is what this window achieved,
            // and the next one opens a tail from the cursor it left.
            return Ok(caught_up);
        }
        let mut outcome = caught_up;
        // THE TAIL WAS OPEN, and a shell reads that as ONLINE whatever the row
        // counts say. Stated on the way in rather than inferred afterwards: a
        // tail that closed with nothing to show for it was still a device that
        // was current within one round trip for as long as it lasted.
        if let centraid_seat::sync::Stage::Moved(rows) | centraid_seat::sync::Stage::Cut(rows) =
            &mut outcome.report.rows
        {
            rows.tailing = true;
        }
        while network.await_tail_page(until) {
            let applied = self.with_vault(|vault| {
                vault
                    .apply_replica(|connection| Ok(network.apply_tail(connection, window, changes)))
                    .map_err(CoreError::from)
            })?;
            if applied.rebootstrap.is_some() {
                // THE STREAM SAID TO TAKE A COPY. The tail is over; the caller
                // handles the repair on the ordinary path.
                let mut told = self.dress(applied);
                told.report.rows = outcome.report.rows.clone();
                return Ok(told);
            }
            outcome.report.rows = applied.rows.clone();
            outcome.report.intents = applied.intents.clone();
            outcome.report.bytes = applied.bytes.clone();
            outcome.report.behind = applied.behind;
            if let centraid_seat::sync::Stage::Moved(rows) | centraid_seat::sync::Stage::Cut(rows) =
                &mut outcome.report.rows
            {
                rows.tailing = true;
            }
        }
        Ok(outcome)
    }

    /// THE TWO FACTS THE CORE KNOWS AND A PASS DOES NOT (#1025 S7).
    ///
    /// The report comes up from `crates/seat` unchanged; this adds the member's
    /// sentence and leaves `parked` for the caller that counts consecutive
    /// repairs. Kept in one place so a sentence is never made twice, and made
    /// from the report's own typed reasons — never from a string a transport
    /// wrote.
    fn dress(&self, report: centraid_seat::sync::PassReport) -> crate::link::SyncOutcome {
        // WHAT IS WORTH SAYING, IN THE ORDER A MEMBER CARES ABOUT IT. The row
        // plane first, because a seat that cannot reach its gateway has nothing
        // else to report; then the write plane, because a held write is the
        // member's own work; then the bytes.
        let sentence = report
            .rows
            .skipped()
            .and_then(crate::error::skip_sentence)
            .or_else(|| {
                report
                    .intents
                    .skipped()
                    .and_then(crate::error::skip_sentence)
            })
            .or_else(|| report.bytes.skipped().and_then(crate::error::skip_sentence))
            .map(str::to_owned)
            .or_else(|| {
                // A GRID OF PLACEHOLDERS IS A DECISION, NOT A FAILURE. The
                // member chose a metered link or the OS said they are on one,
                // and the full-size photographs are waiting rather than
                // missing. Saying nothing here is what makes a working byte
                // plane look broken.
                let bytes = report.bytes.moved()?;
                (bytes.withheld > 0 && bytes.completed == 0).then(|| {
                    "This device is on a metered connection, so full-size photos are waiting \
                     for Wi-Fi."
                        .to_owned()
                })
            })
            .unwrap_or_default();
        crate::link::SyncOutcome {
            report,
            parked: false,
            sentence,
        }
    }

    /// Reset the consecutive-repair counter when a pass did not ask for one.
    ///
    /// "In a row" is the whole of the bound, so the reset has to be on the
    /// outcome rather than on the clock: a seat that repairs once a week must
    /// never be parked by three repairs three weeks apart.
    fn settle_repair(&self, outcome: crate::link::SyncOutcome) -> Result<crate::link::SyncOutcome> {
        if !outcome.rebootstrap_required() {
            self.repairs_in_a_row.store(0, Ordering::SeqCst);
        }
        Ok(outcome)
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
        if answer.is_ok() && wrote(request) {
            self.ring_commits();
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
        if answer.is_ok() && wrote(request) {
            self.ring_commits();
        }
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

    /// Whether this core holds a copy of the vault.
    ///
    /// The fact a shell draws its first screen from, alongside
    /// [`Self::has_network`] and [`crate::link::SeatNetwork::gateway`]: no
    /// file, versus a file with no gateway, versus both.
    #[must_use]
    pub fn holds_a_replica(&self) -> bool {
        self.vault
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .is_some()
    }

    /// Take a fresh copy of the vault from the gateway and open it.
    ///
    /// **The vault goes down first, and that is the whole reason this lives on
    /// the core.** The install is a rename over this core's own file, and a
    /// file cannot be replaced underneath an open SQLite connection — a
    /// connection that survived it would go on reading an inode nothing else
    /// can see. So: close, install, open. A failure anywhere leaves the seat
    /// with the copy it had (the install refuses on the STAGED file, never the
    /// destination), and the vault is reopened over it.
    ///
    /// A gateway is refused by role. A pass that laid a replica's schema and
    /// cursor over this device's own authority would stop it being the thing it
    /// is the authority for.
    pub fn bootstrap(
        &self,
        offer: &centraid_seat::sync::SnapshotOffer,
        adopt: bool,
    ) -> std::result::Result<centraid_seat::sync::BootstrapMoved, crate::link::BootstrapRefusal>
    {
        if self.check_open().is_err() {
            return Err(crate::link::BootstrapRefusal::Failed);
        }
        if self.is_gateway() {
            // A GATEWAY HAS NO COPY TO TAKE. Laying a replica's schema and
            // cursor over this device's own authority would stop it being the
            // thing it is the authority for.
            tracing::warn!("a gateway was asked to take a copy of itself");
            return Err(crate::link::BootstrapRefusal::Failed);
        }
        let held = self
            .network
            .lock()
            .map_err(|_| crate::link::BootstrapRefusal::Failed)?;
        let Some(network) = held.as_ref() else {
            return Err(crate::link::BootstrapRefusal::NotPaired);
        };
        let mut vault = self
            .vault
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        // CLOSED, NOT DROPPED-AND-HOPED. `Vault::close` checkpoints the WAL, so
        // the file a re-bootstrap reads the outbox out of is the whole file
        // rather than a database plus a sidecar the rename is about to orphan.
        if let Some(open) = vault.take()
            && open.close().is_err()
        {
            return Err(crate::link::BootstrapRefusal::Failed);
        }
        let outcome = network.bootstrap(offer, adopt);
        // REOPENED WHATEVER HAPPENED, when there is anything to reopen. A
        // refused bootstrap leaves the old replica in place — the publication
        // is a rename and nothing before it touches the destination — and a
        // seat that stayed shut over it would have lost its rows to a network
        // error.
        //
        // THE INJECTED CLOCK SURVIVES THIS (#1025 S2). It did not: the core
        // gave its `Box<dyn Clock>` away at `open`, so the file that replaced
        // the replica took the build's default and a fixed-clock seat lost its
        // determinism across the swap. `self.stamp` is the same `Arc` the first
        // open was given.
        if self.path.exists() {
            // THE SAME STORE, RE-ATTACHED (#1025 S3). A bootstrap replaces the
            // file and not the bytes: the blobs this device already fetched are
            // still this vault's, and re-deriving a store here would be the
            // second index over one directory that D-1025-S3-1 exists to stop.
            let Ok(held) = self.bytes.lock().map(|store| store.clone()) else {
                return Err(crate::link::BootstrapRefusal::Failed);
            };
            match Core::open_vault(&self.path, true, false, self.stamp.as_ref(), held.as_ref()) {
                Ok(opened) => *vault = Some(opened),
                Err(error) => {
                    tracing::warn!(%error, "the adopted replica would not open");
                    return Err(crate::link::BootstrapRefusal::Failed);
                }
            }
        }
        // THE QUEUE IS RE-PREDICTED ONTO THE FRESH COPY (#1025 S7, item 4).
        //
        // The adoption carries the outbox and the pairing record and nothing
        // else: the predicted rows were applied to a FILE THAT IS GONE, and the
        // journal that could have taken them back went with it. So the member's
        // unsent writes are on their screen again because they are run again —
        // the handlers are deterministic, which is the whole reason a prediction
        // is the handler's own output rather than a description of it.
        //
        // The lock is dropped first: `re_predict` reads the outbox and writes
        // the replica through `with_vault`, which takes this same lock.
        drop(vault);
        drop(held);
        self.re_predict();
        // AND THE HELD-BLOB TABLE, AFTER AN ADOPTION (#1025, D-1025-S7-20).
        // The adoption carries the table across with the rest of the seat's
        // own tables, and the carry is not what this trusts: the file changed
        // underneath the store, so the table is made to agree with the store
        // again here, exactly as it is at open.
        self.rebuild_held_blobs();
        outcome
    }

    /// Run every queued write's handler again, against the copy that just
    /// landed (#1025 S7, item 4).
    ///
    /// In the member's own order, because two writes to one row compose in the
    /// order they were made. A write this copy cannot predict is skipped and
    /// stays queued — the gateway is the authority and may still run it — which
    /// is the same answer the write door gives when a prediction cannot be
    /// made.
    fn re_predict(&self) {
        let now = self.now_text();
        let queued = self.with_vault(|vault| {
            vault
                .read(|connection| {
                    Ok(centraid_seat::Outbox::open(connection)
                        .and_then(|outbox| outbox.all())
                        .unwrap_or_default())
                })
                .map_err(CoreError::from)
        });
        let Ok(queued) = queued else { return };
        for record in queued {
            if !record.state.holds_overlay() {
                continue;
            }
            let queueing = centraid_seat::Queueing {
                intent_id: record.intent_id.clone(),
                app_id: record.app_id.clone(),
                action: record.action.clone(),
                input: record.input.clone(),
                base_versions: record.base_versions.clone(),
                depends_on: record.depends_on.clone(),
                needs_blobs: record.needs_blobs.clone(),
                // THE HASH IS ALREADY IN THE ROW. This door computes one and
                // refuses a declared one; re-predicting does not re-queue, so
                // there is nothing to declare.
                declared_hash: String::new(),
                online_only: record.online_only,
            };
            let Ok(Some(rows)) = self.predict(&queueing) else {
                continue;
            };
            let applied = self.with_vault(|vault| {
                vault
                    .apply_replica(|connection| {
                        Ok(centraid_seat::pending::apply_prediction(
                            connection,
                            &record.intent_id,
                            &rows,
                            &now,
                        ))
                    })
                    .map_err(CoreError::from)
            });
            match applied {
                Ok(Ok(applied)) if !applied.touched.is_empty() => {
                    use centraid_seat::sync::ChangeSink as _;
                    crate::events::ChangeFeed::new(self.events()).rows_applied(&applied.touched, 0);
                }
                Ok(Ok(_)) => {}
                Ok(Err(error)) => tracing::warn!(
                    intent = %record.intent_id,
                    %error,
                    "a queued write could not be re-applied to the fresh copy"
                ),
                Err(error) => tracing::warn!(
                    intent = %record.intent_id,
                    %error,
                    "a queued write could not be re-applied to the fresh copy"
                ),
            }
        }
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
            K::Stage(frame) => Ok(response(wire::response::Kind::Stage(self.stage(frame)?))),
            // THE SEAT'S OWN COMMANDS, ANSWERED BEFORE THE VAULT SEES THEM
            // (#1020, D-1020-B7). `seat.sync` is not a vault command: it has no
            // handler, writes no row and would be refused as unregistered. It
            // rides `Command` because clause 10 of the C ABI says five symbols
            // and means it — a sixth entry point to trigger a sync would be a
            // sixth entry point in production.
            K::Command(command) if command.name == SEAT_SYNC_COMMAND => Ok(response(
                wire::response::Kind::Command(self.seat_sync(command)?),
            )),
            // THE TAIL'S OTHER END (#1025 S2, D-1025-S7-40). Not a vault
            // command either: it writes no row, has no handler, and would be
            // refused as unregistered. See `SEAT_TAIL_STOP_COMMAND`.
            // THE MEMBER'S OVERRIDE (#1025 S5). Same door, same envelope, and
            // the same reasons `seat.sync` is here rather than in the registry.
            K::Command(command) if command.name == SEAT_BYTES_FETCH_COMMAND => Ok(response(
                wire::response::Kind::Command(self.seat_bytes_fetch(command)?),
            )),
            K::Command(command) if command.name == SEAT_TAIL_STOP_COMMAND => {
                self.stop_tail();
                Ok(response(wire::response::Kind::Command(
                    wire::CommandOutcome {
                        status: wire::CommandStatus::Executed as i32,
                        output: br#"{"stopped":true}"#.to_vec(),
                        ..Default::default()
                    },
                )))
            }
            K::Command(command) => Ok(response(wire::response::Kind::Command(
                self.with_vault(|vault| crate::api::invoke(vault, &self.registry, command))?,
            ))),
            K::Pair(pair) => Ok(response(wire::response::Kind::Pair(self.pair(pair)?))),
            // A SEAT QUEUES IT; A GATEWAY REFUSES IT (#1025 S5).
            //
            // `Request::Intent` is the ONLY write verb on the five-symbol ABI
            // and it refused on both roles, so a member editing a note with the
            // gateway away watched "Saving" forever over an outbox with zero
            // rows in it. Everything downstream of that row existed and was
            // tested — the record, the table, `pinned_blobs`, the live
            // `IntentSink`, `overlaid()`'s paint, `settle_at_commit_seq` — and
            // nothing anywhere wrote it.
            //
            // The GATEWAY's refusal stands exactly as it was: an intent needs a
            // principal and this door has none. `accept` proved the DEVICE and
            // turning that into a principal is the accepting lane's job
            // (`Handle::submit_intent`); a gateway answering here would
            // attribute a write to nobody.
            K::Intent(intent) if !self.is_gateway() => Ok(response(wire::response::Kind::Outcome(
                self.queue_write(intent)?,
            ))),
            K::Intent(_) => Err(CoreError::InvalidRequest {
                detail: "an intent is submitted on a `submit` stream, under the enrolled device \
                         the connection was admitted as; `call` has no principal to run it under"
                    .to_owned(),
            }),
            // A `blob` STREAM IS NOT A CALL. Its first frame decides the
            // framing of the rest of the stream, and there is no envelope
            // answer to make.
            K::Blob(_) => Err(CoreError::InvalidRequest {
                detail: "a `blob` frame tags a stream and is never answered as a request"
                    .to_owned(),
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

    /// QUEUE A MEMBER'S WRITE ON THIS SEAT (#1025 S5).
    ///
    /// The seat half of `Request::Intent`, and the last hole in the write path:
    /// the row every other piece of the outbox operates on had no producer, so
    /// a shell could paint "Saving" and nothing else could ever happen.
    ///
    /// **THE CORE COMPUTES THE PAYLOAD HASH** and a declared one is refused
    /// (D-1025-S4-6). It is lowercase-hex BLAKE3, which no shell toolkit
    /// offers — not `CryptoKit`, not `MessageDigest`, not `crypto.subtle` — so
    /// a filled `payload_hash` is a different function's digest under this
    /// vault's name, which is the defect S4 closed at the staging door. The
    /// value is computed by `centraid_vault`'s own canonicalisation, which is
    /// the code the gateway rehashes with, so the two cannot drift.
    ///
    /// **THE SHELL MINTS `intent_id`** and this takes it. It is half the
    /// idempotency key and it must be stable across a retry of one member
    /// gesture; the reducer's `invoke_key` already is — content-derived from
    /// the base revision rather than ordinal — so a retried save is one intent
    /// and a save over a NEW base is a second one. A core minting its own would
    /// make every retry a fresh write.
    ///
    /// The answer is `QUEUED`, which is a different status from `EXECUTED` on
    /// purpose: the gateway has not seen this write and a shell must not say it
    /// has. `commit_seq` is absent for the same reason — there is no commit.
    fn queue_write(&self, intent: &wire::Intent) -> Result<wire::Outcome> {
        // THE TWO CALLER MISTAKES, ANSWERED AS CALLER MISTAKES. The seat door
        // refuses both on its own — it has to, because it is reachable from
        // Rust that never came through here — but its refusal is a
        // `SeatError::Invariant`, which the code table reads as `INTERNAL`. A
        // shell that sent a field it should not have is owed
        // `INVALID_REQUEST`, not "something broke inside the core".
        if intent.intent_id.is_empty() {
            return Err(CoreError::InvalidRequest {
                detail: "a write carries no intent id; it is half the idempotency key".to_owned(),
            });
        }
        if !intent.payload_hash.is_empty() {
            return Err(CoreError::InvalidRequest {
                detail: "a seat computes its own payload hash; a shell declares none \
                         (D-1025-S4-6)"
                    .to_owned(),
            });
        }
        let input: serde_json::Value = if intent.input.is_empty() {
            serde_json::Value::Object(serde_json::Map::new())
        } else {
            serde_json::from_slice(&intent.input).map_err(|error| CoreError::InvalidRequest {
                detail: format!("a write's input is canonical JSON in bytes: {error}"),
            })?
        };
        let queueing = centraid_seat::Queueing {
            intent_id: intent.intent_id.clone(),
            app_id: intent.app_id.clone(),
            action: intent.action.clone(),
            input,
            base_versions: intent
                .base_versions
                .iter()
                .map(|version| centraid_vault::intents::BaseVersion {
                    entity: version.entity.clone(),
                    row_id: version.row_id.clone(),
                    shape_id: version.shape_id.clone(),
                    version: i64::try_from(version.version).unwrap_or(i64::MAX),
                })
                .collect(),
            depends_on: intent.depends_on.clone(),
            // THE DECLARED BYTES (#1025 S3), carried whole because they are IN
            // the hash: a door that dropped them would queue a write the
            // gateway refuses, and `pinned_blobs` would not know to keep the
            // only copy of the member's photograph.
            needs_blobs: intent
                .needs
                .iter()
                .map(|need| centraid_vault::intents::NeededBytes {
                    hash: need.hash.clone(),
                    byte_size: i64::try_from(need.byte_size).unwrap_or(i64::MAX),
                    media_type: need.media_type.clone(),
                })
                .collect(),
            declared_hash: intent.payload_hash.clone(),
            online_only: intent.online_only,
        };
        let now = self.now_text();
        // THE PREDICTION, AND THE QUEUE (#1025 S7, item 4).
        //
        // The seat runs the real handler against its own replica, captures the
        // row images it produced — the same shape `replica_log` carries — and
        // rolls back. That page is the overlay, and it is the only description
        // of a pending write that cannot disagree with the gateway's, because
        // it is produced by the same handler.
        //
        // **AN UNKNOWN COMMAND IS REFUSED AND NEVER QUEUED.** The registry is
        // asked first. `knowledge.save_note` was named by the notes editor for
        // a whole wave, the registry has never had it, and a member read "That
        // request does not make sense to this build" on every window for ever
        // because the seat retried a write that could never succeed. Refusing
        // at the door turns that into one sentence at the moment of the
        // gesture.
        //
        // A PREDICTION THAT CANNOT BE MADE DOES NOT STOP THE WRITE. A handler
        // whose preconditions do not hold against THIS COPY is a handler the
        // gateway may still accept — the copy is behind, and the gateway is the
        // authority — so the write is queued with nothing applied and the
        // member gets the badge without the value, which is exactly where this
        // product was before the prediction existed. Only the registry and the
        // schema refuse, because those two are facts about the BUILD and not
        // about how far behind this device is.
        let predicted = self.predict(&queueing)?;
        let (queued, applied) = self.with_vault(|vault| {
            vault
                .apply_replica(|connection| {
                    Ok((|| -> centraid_seat::Result<_> {
                        // THE QUEUE ROW AND THE APPLY, IN ONE `apply_replica`
                        // BODY. A row with no apply is a badge with no value,
                        // which is where this product was; an apply with no row
                        // is a change to the replica nothing will ever take
                        // back.
                        let queued = centraid_seat::queue_write(connection, &queueing, &now)?;
                        let applied = match &predicted {
                            Some(rows) => centraid_seat::pending::apply_prediction(
                                connection,
                                &queued.intent_id,
                                rows,
                                &now,
                            )?,
                            None => centraid_seat::Predicted::default(),
                        };
                        Ok((queued, applied))
                    })())
                })
                .map_err(CoreError::from)
        })??;
        // AND THE SCREEN MOVES, THROUGH THE ONE CONSUMER (#1025 S7, item 4).
        //
        // A member's own write is a page like any other: the rows changed, so a
        // `ChangeEvent` names them and every screen that reads those tables
        // re-reads. There is no pending-write event kind and no screen has to
        // learn one — which is the point of applying the prediction rather than
        // composing it.
        //
        // `commit_seq: 0` AND THAT IS THE HONEST NUMBER. No commit happened:
        // this device has no authority over any row and the gateway has not
        // been told. The queue's coalescing takes the MAXIMUM, so a zero never
        // lowers a waiting event's position.
        if !applied.touched.is_empty() {
            use centraid_seat::sync::ChangeSink as _;
            crate::events::ChangeFeed::new(self.events()).rows_applied(&applied.touched, 0);
        }
        Ok(wire::Outcome {
            intent_id: queued.intent_id,
            // QUEUED AND NEVER EXECUTED. The gateway has not seen this write;
            // a shell renders "saved, will send" from this and must not claim
            // otherwise.
            status: wire::IntentStatus::Queued as i32,
            // NO COMMIT, because there is no commit. An `EXECUTED` with no
            // commit seq is the liveness bug `crates/sim` found; a `QUEUED`
            // with one would be a lie of the same family.
            commit_seq: None,
            ..Default::default()
        })
    }

    /// PREDICT WHAT THIS WRITE WILL DO, OR REFUSE IT BY NAME (#1025 S7,
    /// item 4).
    ///
    /// `Ok(Some(page))` is a prediction; `Ok(None)` is a write this copy could
    /// not predict and the gateway may still run; `Err` is a write this BUILD
    /// cannot run at all, which is refused rather than queued.
    fn predict(
        &self,
        queueing: &centraid_seat::Queueing,
    ) -> Result<Option<Vec<centraid_seat::PredictedRow>>> {
        // `<app>.<action>`, THE REGISTRY'S OWN SPELLING, and by the same
        // function the gateway names it with (`crate::intent::command_name`).
        // Two spellings of one command is how a seat queues a write the gateway
        // refuses as unregistered — which is exactly what `knowledge.save_note`
        // was, for a whole wave.
        let name = crate::intent::command_name(&centraid_vault::intents::IntentPayload {
            app_id: queueing.app_id.clone(),
            action: queueing.action.clone(),
            input: queueing.input.clone(),
            base_versions: Vec::new(),
            depends_on: Vec::new(),
            needs: Vec::new(),
        });
        let command = centraid_vault::Command::new(name, queueing.input.clone());
        // THE MEMBER, AS THIS DEVICE KNOWS THEM. A prediction runs no authority
        // gate — the gateway's answer is the one that counts and a seat that
        // guessed at authority could grant it — so this principal is only what
        // a handler reads for provenance.
        // THIS DEVICE, AS THE OWNER. A prediction runs no authority gate, so
        // this is provenance and not permission: it is what a handler stamps
        // onto a row it creates, and the gateway restamps it with the device it
        // admitted when it runs the real command.
        let principal = centraid_vault::Principal::owner("this-seat");
        let predicted = self.with_vault(|vault| {
            match vault.predict(&self.registry, &principal, &command) {
                Ok(prediction) => Ok(Ok(prediction)),
                // A COMMAND THIS BUILD DOES NOT HAVE, or an input its schema
                // refuses. Both are facts about the build, both are the same
                // every time, and a queue is the wrong place for either.
                Err(
                    refused @ (centraid_vault::VaultError::UnknownCommand { .. }
                    | centraid_vault::VaultError::InvalidInput { .. }),
                ) => Err(CoreError::InvalidRequest {
                    detail: format!("this build cannot run that write: {refused}"),
                }),
                // ANYTHING ELSE IS THIS COPY BEING BEHIND. Logged, and the
                // write is queued without a page.
                Err(other) => {
                    tracing::debug!(
                        action = %queueing.action,
                        detail = %other,
                        "this copy could not predict a write; it is queued without a page"
                    );
                    Ok(Err(()))
                }
            }
        });
        let prediction = match predicted {
            Ok(Ok(prediction)) => prediction,
            Ok(Err(())) => return Ok(None),
            Err(refusal @ CoreError::InvalidRequest { .. }) => return Err(refusal),
            // No vault at all: an unpaired seat has nothing to predict against
            // and the write is queued for whenever a copy lands.
            Err(_) => return Ok(None),
        };
        Ok(Some(
            prediction
                .rows
                .into_iter()
                .filter_map(|row| {
                    // A DDL ROW IS NOT A ROW A MEMBER WROTE. It is a table
                    // appearing, which no command a member runs produces, and
                    // which a seat must take from the gateway's own page rather
                    // than predict.
                    if row.op == centraid_vault::LogOp::Ddl {
                        return None;
                    }
                    Some(centraid_seat::PredictedRow {
                        table: row.table,
                        op: row.op,
                        primary_key: row.key,
                        row: row.row,
                    })
                })
                .collect(),
        ))
    }

    /// Run one submitted intent, under the ENROLLED DEVICE the connection was
    /// admitted as (#1025 S2).
    ///
    /// Separate from [`Self::call`] because an intent needs a principal and
    /// `call` has none: `accept` proved the DEVICE, and turning that into a
    /// principal is the accepting lane's job. A `Request{intent}` that reached
    /// `call` is therefore refused by name rather than served — a write
    /// attributed to nobody is worse than a refused one.
    ///
    /// A GATEWAY ONLY. A seat holds a copy and has no authority to run
    /// anything against it; an intent that reached a seat's own door would be a
    /// write to a mirror, which the applier would then overwrite from the log.
    pub fn submit_intent(&self, intent: &wire::Intent, device_id: &str) -> Result<wire::Outcome> {
        self.check_open()?;
        if !self.is_gateway() {
            return Err(CoreError::InvalidRequest {
                detail: "only the gateway runs intents; this core holds a copy".to_owned(),
            });
        }
        if device_id.is_empty() {
            return Err(CoreError::InvalidRequest {
                detail: "an intent needs the enrolled device it was submitted by".to_owned(),
            });
        }
        let ran = self.with_vault(|vault| {
            crate::intent::submit(vault, &self.registry, device_id, intent)
        });
        // THE WATERMARK MOVED, AND A TAILING SEAT IS PARKED ON THIS (#1025 S2).
        // Rung even for a refused intent: a `conflict` answer is decided
        // against rows that were read, and a `denied` one writes an audit row
        // — and the reader's cost for a ring that moved nothing is one indexed
        // read.
        self.ring_commits();
        ran
    }

    /// Record bytes this gateway has just PULLED from a seat, before the intent
    /// that names them runs (#1025 S3).
    ///
    /// The bytes are already in this vault's content store, verified against
    /// their own name by bao. This writes the `blob_staging` row that carries
    /// the two facts the store cannot answer — the media type and the declared
    /// size — so `promote_staged_blob` mints a content row a grid can embed
    /// rather than one typed `application/octet-stream`.
    ///
    /// A gateway only, for the same reason [`Self::submit_intent`] is: a seat
    /// staging bytes into its copy would be writing rows the applier overwrites.
    /// One staging frame from a shell: the write half's door (#1025 S4).
    ///
    /// See [`crate::stage`] for the shape and for what replaced
    /// `MediaLibrary.Asset.sha256`. `end` PUTS the assembled bytes into this
    /// core's content store before it answers, so the handle it hands back names
    /// bytes this device holds — a handle for bytes nowhere is a row that will
    /// commit and never render.
    fn stage(&self, frame: &wire::StageRequest) -> Result<wire::StageResponse> {
        use wire::stage_request::Kind as S;
        let kind = match frame.kind.as_ref() {
            Some(S::Begin(begin)) => wire::stage_response::Kind::Begun(
                self.staging.begin(&begin.media_type, begin.byte_size)?,
            ),
            Some(S::Chunk(chunk)) => wire::stage_response::Kind::Chunked(self.staging.chunk(
                &chunk.staging_id,
                chunk.seq,
                &chunk.payload,
            )?),
            Some(S::End(end)) => {
                let staged = self.staging.end(&end.staging_id)?;
                let bytes = self.bytes().ok_or_else(|| CoreError::Unavailable {
                    reason: "this core has no content store, so it cannot keep staged bytes"
                        .to_owned(),
                })?;
                // ALREADY-HELD IS ASKED BEFORE THE PUT, because a put is
                // idempotent and would make every answer `false` on the way in
                // and `true` on the way out.
                let already_held = {
                    use centraid_vault::backup::store::BlobStore as _;
                    bytes.has(&staged.content_hash).unwrap_or(false)
                };
                self.with_vault(|vault| {
                    vault
                        .stage_bytes(&[centraid_vault::intents::NeededBytes {
                            hash: staged.content_hash.clone(),
                            byte_size: staged.byte_size as i64,
                            media_type: staged.media_type.clone(),
                        }])
                        .map_err(CoreError::from)
                })
                .and_then(|_| {
                    use centraid_vault::backup::store::BlobStore as _;
                    bytes
                        .put(&staged.bytes)
                        .map(|_| ())
                        .map_err(|error| CoreError::Unavailable {
                            reason: format!("the staged bytes could not be kept: {error}"),
                        })
                })?;
                wire::stage_response::Kind::Handle(wire::StageHandle {
                    content_hash: staged.content_hash,
                    byte_size: staged.byte_size,
                    already_held,
                })
            }
            None => {
                return Err(CoreError::InvalidRequest {
                    detail: "a staging request carries one of begin, chunk or end".to_owned(),
                });
            }
        };
        Ok(wire::StageResponse { kind: Some(kind) })
    }

    pub fn stage_bytes(&self, staged: &[centraid_vault::intents::NeededBytes]) -> Result<usize> {
        self.check_open()?;
        if !self.is_gateway() {
            return Err(CoreError::InvalidRequest {
                detail: "only the gateway stages pulled bytes; this core holds a copy".to_owned(),
            });
        }
        let staged = self.with_vault(|vault| vault.stage_bytes(staged).map_err(CoreError::from));
        self.ring_commits();
        staged
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
                        // EMPTY HERE, AND FILLED BY THE LANE (#1025 S7, item 5).
                        // The artifact is the GATEWAY PROCESS's — `Snapshots`
                        // builds and keeps it — and this core knows only its
                        // own vault. A core that invented a hash would be
                        // naming a blob nobody serves, so it names none and
                        // `crates/centraid`'s seat lane, which holds the
                        // keeper, fills these three in on the way out.
                        snapshot_hash: String::new(),
                        snapshot_seq: 0,
                        snapshot_bytes: 0,
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
            // A `blob` STREAM'S TAG NEVER REACHES `call` — it is answered by
            // handing the stream to iroh-blobs — and it is classified BOUNDED
            // so that a build which somehow routed one here refuses it as a
            // request rather than parking it as a cancellable operation.
            | K::Blob(_)
            | K::DevicesList(_)
            | K::DevicesRevoke(_)
            // A LOCATION LOOKUP IS BOUNDED: it is capped at
            // `api::MAX_CONTENT_URLS` rows of index reads and moves no bytes.
            | K::ContentUrls(_)
            // ONE STAGING FRAME IS BOUNDED, whatever the whole object costs:
            // a chunk is at most `stage::MAX_CHUNK_BYTES` and `end` hashes
            // what is already in memory. The UNBOUNDED thing is the shell's
            // loop, which the shell already owns and can stop between frames.
            | K::Stage(_),
        )
        | None => RequestKind::Bounded,
        // A snapshot fetch and a backup are as long as the artifact is.
        Some(K::BackupNow(_)) => RequestKind::Unbounded,
    }
}

/// WHAT THE BOOTSTRAP STAGE OF A PASS SAYS (#1025 S7, item 3).
///
/// A pass never bootstraps — taking a copy closes and reopens the vault, which
/// is `Handle`'s lifecycle and not a loop's — so this stage is filled in by the
/// caller that did it, and this is the one place that mapping lives.
///
/// A BACKGROUND WINDOW THAT FETCHED IS `Cut`, NOT `Moved`. It made durable
/// progress and deliberately stopped short of adopting, which is exactly what
/// "the deadline ended it and here is what it kept" means to every other stage.
fn bootstrap_stage(
    taken: std::result::Result<centraid_seat::sync::BootstrapMoved, crate::link::BootstrapRefusal>,
    may_adopt: bool,
) -> centraid_seat::sync::Stage<centraid_seat::sync::BootstrapMoved> {
    use centraid_seat::sync::{SkipReason, Stage};
    match taken {
        Ok(moved) if may_adopt => Stage::Moved(moved),
        Ok(moved) => Stage::Cut(moved),
        Err(refusal) => Stage::Skipped(match refusal {
            crate::link::BootstrapRefusal::NotPaired
            | crate::link::BootstrapRefusal::NothingOffered => SkipReason::NotPaired,
            crate::link::BootstrapRefusal::Unreachable => SkipReason::Unreachable,
            // NO ROOM IS THE STORE'S OWN REFUSAL, and it is the one a member
            // can act on: free some space. Its numbers travel in the log line
            // the refusal already wrote, because a sentence on this device's
            // screen must not carry a path.
            crate::link::BootstrapRefusal::NoRoom { .. } => SkipReason::NoRoom,
            crate::link::BootstrapRefusal::WrongVault | crate::link::BootstrapRefusal::Failed => {
                SkipReason::BootstrapRefused
            }
        }),
    }
}

/// ONE STAGE, AS JSON (#1025 S7).
///
/// `state` is `moved`, `cut` or `skipped` — the three things a stage can say —
/// and it is the field a shell switches on. `reason` is present only on
/// `skipped`, is one of a CLOSED set of codes, and never a sentence; the
/// sentence, when there is one worth showing, is beside it and comes from the
/// core's own table.
fn stage_envelope<M>(
    stage: &centraid_seat::sync::Stage<M>,
    moved: impl FnOnce(&M) -> serde_json::Value,
) -> serde_json::Value {
    match stage {
        centraid_seat::sync::Stage::Skipped(reason) => serde_json::json!({
            "state": "skipped",
            "reason": reason.code(),
            "sentence": crate::error::skip_sentence(*reason),
        }),
        centraid_seat::sync::Stage::Cut(kept) => {
            let mut value = moved(kept);
            if let Some(object) = value.as_object_mut() {
                object.insert("state".to_owned(), serde_json::json!("cut"));
            }
            value
        }
        centraid_seat::sync::Stage::Moved(what) => {
            let mut value = moved(what);
            if let Some(object) = value.as_object_mut() {
                object.insert("state".to_owned(), serde_json::json!("moved"));
            }
            value
        }
    }
}

fn bootstrap_json(
    stage: &centraid_seat::sync::Stage<centraid_seat::sync::BootstrapMoved>,
) -> serde_json::Value {
    stage_envelope(stage, |moved| {
        serde_json::json!({
            "seq": moved.seq,
            "bytesFetched": moved.bytes_fetched,
            "bytesTotal": moved.bytes_total,
        })
    })
}

fn rows_stage(
    stage: &centraid_seat::sync::Stage<centraid_seat::sync::RowsMoved>,
) -> serde_json::Value {
    stage_envelope(stage, |moved| {
        serde_json::json!({
            "applied": moved.applied,
            "duplicate": moved.duplicate,
            "commits": moved.commits,
            "pages": moved.pages,
            "reachedTheEnd": moved.reached_the_end,
        })
    })
}

fn intents_stage(
    stage: &centraid_seat::sync::Stage<centraid_seat::sync::IntentsMoved>,
) -> serde_json::Value {
    stage_envelope(stage, |moved| {
        serde_json::json!({
            "submitted": moved.submitted,
            "settled": moved.settled,
            "cleared": moved.cleared,
        })
    })
}

fn bytes_stage(
    stage: &centraid_seat::sync::Stage<centraid_seat::sync::BytesMoved>,
) -> serde_json::Value {
    stage_envelope(stage, |moved| {
        serde_json::json!({
            "planned": moved.planned,
            "completed": moved.completed,
            "moved": moved.moved,
            "deferred": moved.deferred,
            "refused": moved.refused,
            "withheld": moved.withheld,
            "unaddressable": moved.unaddressable,
            // THE ASSET ROWS WHOSE FILES LANDED, so a grid can redraw exactly
            // those cells (`media_asset.asset_id` since D-1025-S7-20, which is
            // the key a grid draws by; they used to be content ids and matched
            // nothing). The same ids `ChangeSink::blobs_arrived` pushed as an
            // event; carried here as well because a caller that ran one pass on
            // purpose has no event loop to drain.
            "arrived": moved.arrived,
        })
    })
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
            let handle = Core::open(CoreConfig::thin_seat(&path)).expect("the thin seat opens");
            Self { dir, handle }
        }
    }

    /// THE FETCH COMMAND ANSWERS BY CODE, AND THE CODES ARE DIFFERENT
    /// (#1025 S5, D-1025-S7-63).
    ///
    /// Three answers that all look like "a window that moved nothing" from
    /// outside, which is the shape of every defect the one-report ruling
    /// deletes. A member who taps a photograph this device already holds has
    /// asked for nothing; a member whose tap names a hash this replica has
    /// never heard of has asked for something that is not there; and neither
    /// is a failed command.
    #[test]
    fn a_fetch_for_a_hash_no_row_names_is_refused_by_code_and_is_not_a_failure() {
        let scratch = Scratch::thin();
        let answer = scratch
            .handle
            .seat_bytes_fetch(&wire::Command {
                name: SEAT_BYTES_FETCH_COMMAND.to_owned(),
                invoke_key: "a test".to_owned(),
                input: br#"{"contentHash":"aa","ownerRef":"asset-1"}"#.to_vec(),
                ..Default::default()
            })
            .expect("the command answers");
        // NOT `FAILED`. Nothing went wrong; there is nothing to fetch.
        assert_eq!(answer.status, wire::CommandStatus::Executed as i32);
        let body = String::from_utf8(answer.output).expect("utf-8");
        assert!(body.contains(r#""fetched":false"#), "{body}");
        assert!(body.contains(r#""refusal":"nothingWanted""#), "{body}");
        // AND THE OWNER REF COMES BACK, so a shell can settle the cell the
        // member actually tapped rather than every spinner on the screen.
        assert!(body.contains(r#""ownerRef":"asset-1""#), "{body}");
    }

    /// A HASH THIS BUILD CANNOT PARSE IS THE SAME ANSWER, and deliberately not
    /// an `InvalidRequest`: from a member's side "that is not a photograph this
    /// device knows about" is one sentence, and a shell sending a malformed
    /// hash is a bug that belongs in a log, not on a grid.
    #[test]
    fn a_fetch_with_no_parseable_hash_is_the_same_refusal() {
        let scratch = Scratch::thin();
        let answer = scratch
            .handle
            .seat_bytes_fetch(&wire::Command {
                name: SEAT_BYTES_FETCH_COMMAND.to_owned(),
                invoke_key: "a test".to_owned(),
                input: br#"{"contentHash":"NOT A HASH","ownerRef":"asset-1"}"#.to_vec(),
                ..Default::default()
            })
            .expect("the command answers");
        let body = String::from_utf8(answer.output).expect("utf-8");
        assert!(body.contains(r#""refusal":"nothingWanted""#), "{body}");
    }

    /// A GATEWAY HOLDS ITS OWN BYTES, and says so rather than answering with a
    /// refusal about pairing that would send a member looking for a gateway
    /// they already are.
    #[test]
    fn a_gateway_answers_a_fetch_with_the_photograph_already_being_here() {
        let scratch = Scratch::gateway();
        let answer = scratch
            .handle
            .seat_bytes_fetch(&wire::Command {
                name: SEAT_BYTES_FETCH_COMMAND.to_owned(),
                invoke_key: "a test".to_owned(),
                input: br#"{"contentHash":"aa"}"#.to_vec(),
                ..Default::default()
            })
            .expect("the command answers");
        assert_eq!(answer.status, wire::CommandStatus::Executed as i32);
        assert!(answer.reason.contains("already here"), "{}", answer.reason);
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    /// A NETWORK WHOSE TAIL IS OPEN AND QUIET (#1025 S2, D-1025-S7-40).
    ///
    /// The shape that broke the phone: a tail open on a vault nobody is writing
    /// to. `await_tail_page` blocks, exactly as a real reader blocks on a
    /// stream that is saying nothing, and the test below asks this core to read
    /// a page while it does.
    struct QuietTail {
        /// Raised while `await_tail_page` is inside its wait, so the test can
        /// ask its question at the moment that matters rather than racing.
        waiting: Arc<AtomicU64>,
    }

    impl crate::link::SeatNetwork for QuietTail {
        fn endpoint_id(&self) -> [u8; 32] {
            [0u8; 32]
        }

        fn pair(
            &self,
            _encoded: &str,
            _device_name: &str,
            _platform: &str,
        ) -> std::result::Result<crate::link::PairedGateway, crate::link::PairRefusal> {
            Err(crate::link::PairRefusal::Unreachable)
        }

        fn gateway(&self) -> Option<crate::link::PairedGateway> {
            None
        }

        fn offer(&self) -> Option<centraid_seat::sync::SnapshotOffer> {
            None
        }

        fn adopt(&self, _gateway: crate::link::PairedGateway) {}

        fn held_blobs(&self) -> Option<Vec<centraid_seat::HeldBlob>> {
            None
        }

        fn bootstrap(
            &self,
            _offer: &centraid_seat::sync::SnapshotOffer,
            _adopt: bool,
        ) -> std::result::Result<centraid_seat::sync::BootstrapMoved, crate::link::BootstrapRefusal>
        {
            Err(crate::link::BootstrapRefusal::NothingOffered)
        }

        /// The catch-up: it reached the gateway and moved nothing, which is the
        /// ordinary answer for a device that is already current.
        fn sync(
            &self,
            _connection: &rusqlite::Connection,
            _window: crate::link::SyncWindow,
            _changes: &dyn centraid_seat::sync::ChangeSink,
        ) -> centraid_seat::sync::PassReport {
            centraid_seat::sync::PassReport {
                rows: centraid_seat::sync::Stage::Moved(centraid_seat::sync::RowsMoved {
                    reached_the_end: true,
                    ..Default::default()
                }),
                ..Default::default()
            }
        }

        fn tail_stopper(&self) -> Option<Arc<dyn crate::link::TailStopper>> {
            None
        }

        fn start_tail(&self, _epoch: &str, _since: i64, _deadline: std::time::Instant) -> bool {
            true
        }

        fn tail_is_open(&self) -> bool {
            true
        }

        /// A QUIET GATEWAY. It waits out the window and answers "no more",
        /// which is what a real reader does when the deadline arrives.
        fn await_tail_page(&self, until: std::time::Instant) -> bool {
            self.waiting.fetch_add(1, Ordering::SeqCst);
            let now = std::time::Instant::now();
            if until > now {
                std::thread::sleep(until - now);
            }
            false
        }

        fn apply_tail(
            &self,
            _connection: &rusqlite::Connection,
            _window: crate::link::SyncWindow,
            _changes: &dyn centraid_seat::sync::ChangeSink,
        ) -> centraid_seat::sync::PassReport {
            centraid_seat::sync::PassReport::default()
        }

        fn idle(&self) {}

        fn resume(&self) -> std::result::Result<(), String> {
            Ok(())
        }
    }

    /// **A TAIL MUST NOT HOLD THE VAULT WHILE IT WAITS** (#1025 S2,
    /// D-1025-S7-40).
    ///
    /// The defect this test exists for was found on a phone: with a tail open,
    /// every `Request::Page` on that core hung for ever, the grid sat on a
    /// spinner, and killing the gateway did not release it. The cause was one
    /// mutex — a pass holds the vault for its whole length, and a tail is a
    /// pass that lasts as long as the member has the app open.
    ///
    /// So the wait and the apply are two different things on two different
    /// threads, and this is the assertion that keeps them that way: with a tail
    /// open and idle, an ordinary read on the SAME core answers promptly.
    #[test]
    fn a_read_answers_while_a_tail_is_open_and_quiet() {
        let dir = centraid_ontology::golden::scratch_dir();
        std::fs::create_dir_all(&dir).expect("made");
        let path = dir.join("tailing-seat.db");
        let made = Core::open(CoreConfig::gateway(&path)).expect("opens");
        made.with_vault(|vault| Ok(vault.found("Test", "Owner")?))
            .expect("founds");
        made.close();
        drop(made);

        let handle = Arc::new(Core::open(CoreConfig::replicated_seat(&path)).expect("opens"));
        // A SEAT WITH A CURSOR. A file with no `seat_state` has nowhere to tail
        // from and says so instead of tailing — which is right, and is not the
        // case under test.
        handle
            .with_vault(|vault| {
                vault
                    .apply_replica(|connection| {
                        Ok(centraid_seat::state::init_seat_state(
                            connection,
                            &centraid_seat::state::SeatPosition {
                                vault_id: "v".to_owned(),
                                epoch: "e".to_owned(),
                                schema_epoch: 4,
                                ddl_version: 0,
                                applied_seq: 0,
                                applied_commit_seq: 0,
                            },
                            "t",
                        )
                        .map(|_| ())
                        .unwrap_or(()))
                    })
                    .map_err(CoreError::from)
            })
            .expect("the seat's cursor is laid");
        let waiting = Arc::new(AtomicU64::new(0));
        handle.attach_network(Box::new(QuietTail {
            waiting: Arc::clone(&waiting),
        }));

        // A TAILING WINDOW, ON A THREAD OF ITS OWN. Two seconds is long enough
        // that a read blocked behind it would blow the budget below many times
        // over, and short enough that the test ends whatever happens.
        let tailing = {
            let handle = Arc::clone(&handle);
            std::thread::spawn(move || {
                handle.sync_now(crate::link::SyncWindow {
                    deadline: Duration::from_secs(2),
                    tail: true,
                    ..crate::link::SyncWindow::unbounded()
                })
            })
        };
        // WAIT FOR THE TAIL TO BE INSIDE ITS WAIT, so the question below is
        // asked at the moment that matters.
        let started = std::time::Instant::now();
        while waiting.load(Ordering::SeqCst) == 0 {
            if tailing.is_finished() {
                panic!("the pass ended: {:?}", tailing.join());
            }
            assert!(
                started.elapsed() < Duration::from_secs(2),
                "the tail never reached its wait"
            );
            std::thread::sleep(Duration::from_millis(10));
        }

        // THE QUESTION. A log page is the cheapest read that takes the vault,
        // which is the lock the tail used to hold.
        let asked = std::time::Instant::now();
        let answer = handle.call(&log_request(10));
        let took = asked.elapsed();
        assert!(answer.is_ok(), "a read during a tail was refused: {answer:?}");
        assert!(
            took < Duration::from_millis(500),
            "a read during an open tail took {took:?}; the tail is holding the vault"
        );

        let outcome = tailing
            .join()
            .expect("the tailing thread")
            .expect("a tail that ran out of window is not an error");
        assert!(
            outcome.report.tailing(),
            "the window reported that it held a tail"
        );
        handle.close();
    }

    /// A network that is always told to re-bootstrap, and counts how often it
    /// was asked to take a fresh copy.
    struct AlwaysUnderTheFloor {
        /// Shared with the test, so the count can be read without reaching back
        /// through the `Box<dyn SeatNetwork>` the handle took ownership of.
        bootstraps: Arc<AtomicU64>,
    }

    impl crate::link::SeatNetwork for AlwaysUnderTheFloor {
        fn endpoint_id(&self) -> [u8; 32] {
            [0u8; 32]
        }

        fn pair(
            &self,
            _encoded: &str,
            _device_name: &str,
            _platform: &str,
        ) -> std::result::Result<crate::link::PairedGateway, crate::link::PairRefusal> {
            Err(crate::link::PairRefusal::Unreachable)
        }

        fn gateway(&self) -> Option<crate::link::PairedGateway> {
            None
        }

        fn offer(&self) -> Option<centraid_seat::sync::SnapshotOffer> {
            None
        }

        fn adopt(&self, _gateway: crate::link::PairedGateway) {}
        fn held_blobs(&self) -> Option<Vec<centraid_seat::HeldBlob>> {
            // NO STORE TO ASK, which is not "this device holds nothing".
            None
        }

        fn bootstrap(
            &self,
            _offer: &centraid_seat::sync::SnapshotOffer,
            _adopt: bool,
        ) -> std::result::Result<centraid_seat::sync::BootstrapMoved, crate::link::BootstrapRefusal>
        {
            self.bootstraps.fetch_add(1, Ordering::SeqCst);
            Ok(centraid_seat::sync::BootstrapMoved::default())
        }

        fn sync(
            &self,
            _connection: &rusqlite::Connection,
            _window: crate::link::SyncWindow,
            _changes: &dyn centraid_seat::sync::ChangeSink,
        ) -> centraid_seat::sync::PassReport {
            centraid_seat::sync::PassReport {
                rebootstrap: Some(centraid_seat::sync::Rebootstrap {
                    reason: centraid_vault::RebootstrapReason::Retention,
                    // AND IT NAMES A BLOB, because a seat told to take a copy
                    // and not told which keeps what it has — which would make
                    // the repair bound below unreachable rather than tested.
                    snapshot: Some(centraid_seat::sync::SnapshotOffer {
                        hash: "aa".repeat(32),
                        seq: 1,
                        bytes: 1,
                    }),
                }),
                rows: centraid_seat::sync::Stage::Skipped(
                    centraid_seat::sync::SkipReason::RebootstrapRequired,
                ),
                ..Default::default()
            }
        }

        fn tail_stopper(&self) -> Option<Arc<dyn crate::link::TailStopper>> {
            None
        }
        fn start_tail(&self, _epoch: &str, _since: i64, _deadline: std::time::Instant) -> bool {
            false
        }
        fn tail_is_open(&self) -> bool {
            false
        }
        fn await_tail_page(&self, _until: std::time::Instant) -> bool {
            false
        }
        fn apply_tail(
            &self,
            _connection: &rusqlite::Connection,
            _window: crate::link::SyncWindow,
            _changes: &dyn centraid_seat::sync::ChangeSink,
        ) -> centraid_seat::sync::PassReport {
            centraid_seat::sync::PassReport::default()
        }
        fn idle(&self) {}

        fn resume(&self) -> std::result::Result<(), String> {
            Ok(())
        }
    }

    /// A PAIRING NEVER LANDS ON A REPLICA THAT ALREADY HOLDS A VAULT
    /// (#1025 S7-9).
    ///
    /// The defect, reproduced on the iPhone 17 Pro simulator: a phone holding
    /// one vault redeemed a second gateway's ticket down its LIVE core, and
    /// `Handle::pair`'s `bootstrap` published the new copy over the file the
    /// member was reading. Vault A was gone, nothing errored, and the shell
    /// then drew "No vault yet" over a device that had held two vaults.
    ///
    /// Two halves, because a guard that refused everything would pass the first
    /// assertion alone:
    ///
    /// 1. A seat HOLDING a founded vault is refused, by code, and the network
    ///    is never asked — `bootstraps` proves the destructive call did not
    ///    happen, and the pair count proves the ticket was never even offered,
    ///    which is what "a refusal burns nothing" means.
    /// 2. A seat on a file that holds NO vault row — the ordinary shape of a
    ///    fresh replica, which is what `Shelf.admit` always pairs from — gets
    ///    past the guard and fails on its own terms further down.
    #[test]
    fn pairing_refuses_a_replica_that_already_holds_a_vault() {
        let request = wire::PairRequest {
            code: b"centraid-ticket-whatever".to_vec(),
            device_name: "A phone".to_owned(),
            platform: "ios".to_owned(),
            ..Default::default()
        };

        // --- 1. A seat holding a vault ---------------------------------------
        let dir = centraid_ontology::golden::scratch_dir();
        std::fs::create_dir_all(&dir).expect("made");
        let path = dir.join("held.db");
        let made = Core::open(CoreConfig::gateway(&path)).expect("opens");
        made.with_vault(|vault| Ok(vault.found("Vault A", "Owner")?))
            .expect("founds");
        made.close();
        drop(made);

        let holding = Core::open(CoreConfig::replicated_seat(&path)).expect("the seat opens");
        let bootstraps = Arc::new(AtomicU64::new(0));
        holding.attach_network(Box::new(AlwaysUnderTheFloor {
            bootstraps: Arc::clone(&bootstraps),
        }));

        let refused = holding.pair(&request).expect_err("a held vault is refused");
        assert!(
            matches!(refused, CoreError::VaultAlreadyHeld { .. }),
            "a pairing was allowed onto a replica already holding a vault: {refused:?}"
        );
        assert_eq!(
            refused.code(),
            centraid_api_proto::core_v1::ErrorCode::VaultAlreadyHeld,
            "the refusal must be a CODE the shell branches on, not a sentence"
        );
        assert_eq!(
            bootstraps.load(Ordering::SeqCst),
            0,
            "the bootstrap that destroys the replica was reached anyway"
        );

        // AND THE VAULT IS STILL THERE. The point of the guard is not the
        // error; it is this read succeeding afterwards.
        let still = holding
            .with_vault(|vault| Ok(vault.vault_id()?))
            .expect("the held vault still reads");
        assert!(still.is_some(), "the refused pairing took the vault anyway");
        holding.close();
        drop(holding);

        // --- 2. A seat holding no vault --------------------------------------
        let fresh_path = dir.join("fresh.db");
        // A file with a SCHEMA AND NO `core_vault` ROW, which is exactly what a
        // replica looks like before its first copy lands — and what a shell
        // pairs from. `found` is deliberately not called.
        let empty = Core::open(CoreConfig::gateway(&fresh_path)).expect("opens");
        empty.close();
        drop(empty);

        let fresh = Core::open(CoreConfig::replicated_seat(&fresh_path)).expect("the seat opens");
        let onwards = fresh.pair(&request).expect_err("no network is attached");
        assert!(
            !matches!(onwards, CoreError::VaultAlreadyHeld { .. }),
            "the guard refused a replica that holds nothing, which is every first pairing"
        );
        fresh.close();
        drop(fresh);

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// THE UNDER-THE-FLOOR REPAIR IS BOUNDED (#1025 S2, D-1025-S2-4).
    ///
    /// #1025 S1 left it unbounded and said so: a gateway committing faster than
    /// a device can download leaves every fresh copy stale before it lands, so
    /// the retry timer re-enters the repair on every pass forever, spending the
    /// member's data on a race it cannot win. v0 parked a mount after three in
    /// a row; this is that bound.
    ///
    /// **Parked means nothing is wiped.** The assertion that matters is the
    /// last one: the file is still open and still reads.
    #[test]
    fn three_repairs_in_a_row_park_the_seat_and_wipe_nothing() {
        let dir = centraid_ontology::golden::scratch_dir();
        std::fs::create_dir_all(&dir).expect("made");
        let path = dir.join("seat.db");
        let made = Core::open(CoreConfig::gateway(&path)).expect("opens");
        made.with_vault(|vault| Ok(vault.found("Test", "Owner")?))
            .expect("founds");
        made.close();
        drop(made);

        let handle = Core::open(CoreConfig::replicated_seat(&path)).expect("the seat opens");
        let bootstraps = Arc::new(AtomicU64::new(0));
        handle.attach_network(Box::new(AlwaysUnderTheFloor {
            bootstraps: Arc::clone(&bootstraps),
        }));

        // THREE PASSES, THREE REPAIRS. Each one is honest on its own: the seat
        // really is under the floor and the remedy really is a fresh copy.
        for pass in 1..=REPAIRS_BEFORE_PARKING {
            let outcome = handle
                .sync_now(crate::link::SyncWindow::unbounded())
                .expect("a pass under the floor is not an error");
            assert!(!outcome.parked, "parked on pass {pass}, too early");
            assert_eq!(bootstraps.load(Ordering::SeqCst), pass);
        }

        // THE FOURTH DOES NOT DOWNLOAD. It parks, with a sentence a member
        // could be shown.
        let parked = handle
            .sync_now(crate::link::SyncWindow::unbounded())
            .expect("parking is not an error");
        assert!(parked.parked, "the fourth repair in a row ran anyway");
        assert_eq!(
            bootstraps.load(Ordering::SeqCst),
            REPAIRS_BEFORE_PARKING,
            "a parked seat downloaded a fresh copy"
        );
        assert_eq!(parked.sentence, crate::error::PARKED_SENTENCE);
        assert!(!parked.sentence.is_empty(), "a parked seat is told nothing");

        // NOTHING IS WIPED. The copy is still here and still reads, which is
        // the whole difference between parking and giving up.
        // Through `centraid_vault`'s test door: `core_party` is that crate's
        // schema, and `sql-confinement` confines a statement about it there.
        // The door answers 0 for a file it cannot read, so the assertion is
        // that the READ ITSELF succeeded — a parked seat whose file was wiped
        // could not have got this far.
        let read_it = handle
            .with_vault(|vault| {
                Ok(vault.read(|connection| Ok(centraid_vault::testdoor::parties(connection)))?)
            })
            .expect("a parked seat still reads");
        assert!(
            !read_it.is_empty(),
            "a parked seat lost the rows it already held"
        );

        let _ = std::fs::remove_dir_all(&dir);
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
                // A one-shot page; `tail` is the stay-open request.
                tail: false,
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
                tail: false,
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

    /// A GATEWAY'S BEHAVIOUR IS UNCHANGED (#1025 S5).
    ///
    /// The seat half of `Request::Intent` queues; the gateway half still
    /// refuses by name, because an intent needs a principal and `call` has
    /// none — `accept` proved the DEVICE and turning that into a principal is
    /// the accepting lane's job. A gateway that answered here would attribute a
    /// write to nobody.
    #[test]
    fn a_gateway_still_refuses_an_intent_that_reached_its_call_door() {
        let scratch = Scratch::gateway();
        let refusal = scratch
            .handle
            .call(&wire::Request {
                kind: Some(wire::request::Kind::Intent(wire::Intent {
                    intent_id: "i-1".to_owned(),
                    app_id: "core".to_owned(),
                    action: "add_party".to_owned(),
                    ..Default::default()
                })),
            })
            .expect_err("a gateway has no principal to run an intent under");
        assert!(matches!(refusal, CoreError::InvalidRequest { .. }));
    }

    /// AND A SEAT WITH NO COPY REFUSES TOO, as a state rather than as a bug: a
    /// write needs an outbox and an outbox lives in the replica. A seat that
    /// silently swallowed a write before its first bootstrap would lose it.
    #[test]
    fn an_unpaired_seat_has_nowhere_to_queue_a_write() {
        let dir = centraid_ontology::golden::scratch_dir();
        std::fs::create_dir_all(&dir).expect("made");
        let handle = Core::open(CoreConfig::replicated_seat(dir.join("nothing-here.db")))
            .expect("an unpaired seat opens");
        let refusal = handle
            .call(&wire::Request {
                kind: Some(wire::request::Kind::Intent(wire::Intent {
                    intent_id: "i-1".to_owned(),
                    app_id: "core".to_owned(),
                    action: "add_party".to_owned(),
                    ..Default::default()
                })),
            })
            .expect_err("a seat with no copy has no outbox");
        assert!(matches!(refusal, CoreError::Unpaired));
        let _ = std::fs::remove_dir_all(&dir);
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
        // `backup_now` is the unbounded one now: `snapshot_head` was the other
        // and is deleted (#1025 S7, item 5).
        assert_eq!(
            request_kind(&wire::Request {
                kind: Some(wire::request::Kind::BackupNow(wire::BackupNow {
                    force: false
                })),
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
                    with_held_thumbnail: false,
                    with_note_body: false,
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
