//! THE PASS, AND THE OPERATING SYSTEM'S HALF OF IT (#1080, "The phone core").
//!
//! ```text
//! reach      every paired gateway that answers, as itself           (the ledger's order)
//! snapshot   when one is due and the link may carry the records    (the vault, briefly)
//! records    move the snapshot's parts, then move each head         (manifest after ranges)
//! prepare    seal what a gateway lacks: derivatives, then originals, newest first
//! move       PUT each part, bundles for the small ones; repeat until nothing is left
//! snapshot   again, when this pass confirmed files whose rows no snapshot covers
//! ```
//!
//! **EVERY PAIRED GATEWAY IS A FULL REPLICA** (#1188, B1). A pass feeds each gateway that
//! answers, on its own: one snapshot is planned against all of them, a part is sealed once and
//! sent to each that lacks it, and a gateway that is away or full does not hold up the others.
//! A part leaves the spool when no paired gateway still owes it (`mover::release`); the wait
//! for one that does not answer is bounded (`mover::SPOOL_WAIT_MS`) and ends early when the
//! spool needs the room. The status says which gateway is behind (`Destination.behind_files`).
//!
//! **Acknowledgement is the `PUT`'s success** (#1080 ruling 7): a part counts
//! in `confirmed_parts` only once a gateway answered that it holds it, and only
//! then does its spool file go. A gateway's own `exists` answer is the other
//! truth the ledger follows: a name a gateway already holds is confirmed from
//! it before anything is sealed, so a restored phone, or one that lost its
//! ledger, re-sends nothing.
//!
//! # THE RECORDS GO FIRST, AND THE HEAD NEVER WAITS BEHIND A LIBRARY
//!
//! The ledger orders a manifest after every other queued part, so a pass that
//! moved the whole queue at once would hold the vault's head until the last
//! film of a backlog had crossed. The records move on their own first, the
//! head is set, and only then do the media move — which is what makes the
//! recovery point for records about half a minute behind an edit while photographs stream.
//!
//! # THE MEMBER'S RULE, AS A TABLE (#1080 ruling 6; the root's ruling A10)
//!
//! | What | May be sealed | May cross a metered link |
//! |---|---|---|
//! | the vault's snapshot | always | under `WIFI_AND_CELLULAR_PHOTOS`, or under any rule when the member asked (R-1080-C38) |
//! | a thumbnail, a preview, a poster | always | always |
//! | a photograph's original | not under `MANUAL` unless the member asked | under `WIFI_AND_CELLULAR_PHOTOS` |
//! | a video's original | on a charger, or when the member asked; never when videos are left out | never |
//!
//! "The member asked" is `DrainRequest.asked`: the "Back up now" tap and
//! nothing else (the root's ruling A24). `wants_snapshot`, which the shell
//! also sends when the app leaves the screen, decides only when the snapshot
//! is taken. The rule and the link a pass was told are remembered in the
//! ledger, because `handoff` — which hands parts to an operating system that
//! moves them while this core is suspended — is not told them again, and
//! `allows_cellular` is how the rule survives the hand-off.
//!
//! # BYTES ONLY THE SHELL CAN READ
//!
//! An original the operating system's library holds was never copied into the
//! app (#1080 ruling 6). A pass cannot read it, so it names it in `need_bytes`
//! and the shell streams it through the stage door, which seals it in the same
//! stream (A8); the next round moves it.
//!
//! **What a pass asks for, it plans** (R-1080-C39). The item's hash is known
//! from its first read, so every part's name is too: the pass asks for each
//! item that fits the spool's room whole, then for as many parts of the first
//! larger one as the rest leave, and hands the stage door that plan. The room
//! is promised until the shell streams, so a later round cannot spend it. A
//! round that moved parts freed room, so the pass plans once more before it
//! answers: an original larger than the spool backs up a window at a time,
//! one read of it per window, instead of never.

mod media;
mod os;
mod plan;
mod policy;
mod records;

use std::collections::{BTreeMap, BTreeSet};
use std::time::{Duration, Instant};

use centraid_api_proto::core_v1 as wire;
use centraid_vault::backup::files::{ContentFile, content_files};
use centraid_vault::backup::mover::{self, Stop};
use centraid_vault::backup::naming::{BackupKeys, Name, names_of};
use centraid_vault::backup::spool::Spool;
use centraid_vault::backup::state::{DeviceState, Reach};
use centraid_vault::backup::store::{Store, StoreError};
use centraid_vault::clock::SystemClock;

pub use media::queue_sealed;
pub use os::{handoff, reconcile, settle};
pub use policy::{
    Conditions, Kind, allows_cellular, gateway_reach, last_reach, refused_limit_bytes,
};

use media::{Feed, LibraryAsk, media_round};
use policy::{Refused, heard_of, refused_by, snapshot_due, stop_for, stop_of};
use records::{Round, newest_stands, rows_uncovered, verify_sample};

use super::link::{self, Reached};
use super::{Keyring, Plane, now_ms, plane_error, store_error};
use crate::error::{CoreError, Result};
use crate::handle::HandleState as Handle;
use crate::stage::{Planned, bytes_of_parts};

/// How long a snapshot is trusted to be on its way, and how far back a head is believed to
/// stand: an hour. It is no longer the interval between snapshots (see [`SNAPSHOT_SETTLE_MS`]);
/// a vault that changed is copied once it has settled, and one that did not change is not
/// copied again however long ago the head was set.
pub const SNAPSHOT_EVERY_MS: u64 = 60 * 60 * 1000;

/// How long after the last snapshot a changed vault is copied again while this phone is paired
/// and online: about 30 seconds (#1202, S2-9, the owner's ruling). A burst of edits coalesces
/// (the conductor waits five seconds between commits), and one snapshot follows it; an edit after
/// the window is the next snapshot's. Leaving the screen and the member's ask still take one at
/// once.
pub const SNAPSHOT_SETTLE_MS: u64 = 30 * 1000;

/// The most items one answer asks the shell to stream (`NeedBytes`).
pub const MAX_NEED_BYTES: usize = 64;

/// How long a part handed to the operating system may go unsettled before it
/// goes back in the queue: a day and an hour. The iPhone's background session
/// gives an upload a day (`BackgroundUploader.resourceTimeoutSeconds`) and
/// reports it failed after; a part handed off longer ago than that, with no
/// settle and not held by the gateway, is one whose report was lost — an app
/// killed before its delegate ran.
pub const HANDOFF_GRACE_MS: u64 = 25 * 60 * 60 * 1000;

/// How much of a file is read for one piece of a part.
pub(super) const READ_CHUNK: usize = 1024 * 1024;

/// What the snapshot's manifest says took it.
pub(super) const APP: &str = concat!("centraid-core/", env!("CARGO_PKG_VERSION"));

// ─── the pass ───────────────────────────────────────────────────────────────

/// What one pass did, as the answer carries it.
pub(super) struct Pass {
    pub(super) confirmed: u32,
    pub(super) stopped: wire::DrainStop,
    pub(super) acked_at_ms: Option<i64>,
    pub(super) need: Vec<wire::NeedBytes>,
    /// The part names of each file, worked out once a pass: a name is a keyed hash, and a
    /// library of ninety thousand files would otherwise have them hashed again every round.
    pub(super) names: BTreeMap<[u8; 32], Vec<Name>>,
    /// How many names this pass asked a gateway about: each name once a pass, per gateway.
    pub(super) asks: usize,
    pub(super) waiting_bytes: BTreeSet<Name>,
    /// The spool volume's free bytes, read when the pass began: the floor an
    /// oversize part keeps (the sweep's F6).
    pub(super) free: u64,
    /// Parts a gateway acknowledged in this pass's media rounds (originals and
    /// derivatives, never the records), and the names the gateway already held
    /// that were confirmed from its answer: the files whose rows a snapshot
    /// may still owe the pass one for.
    pub(super) media_confirmed: usize,
    /// The spool's bytes promised to the library items asked for: the shell
    /// streams them after the pass answers, so no later round of this pass
    /// may spend them first.
    pub(super) promised: u64,
    /// What each asked-for item's stream is to seal, by its identifier in
    /// the library (R-1080-C39).
    pub(super) planned: BTreeMap<String, Planned>,
    /// What the gateway did part-way through, for the status to say until a
    /// pass reaches it again: `REACH_SILENT` when it stopped answering,
    /// `REACH_UNTRUSTED` when another machine answered in its place,
    /// `REACH_REFUSED` when it answered and refused a write for its own
    /// reason (the sweep's F1). `None` when it answered to the end.
    pub(super) heard: Option<Reach>,
    /// Gateways that were fed to the end of the pass's media rounds.
    pub(super) fed: usize,
    /// A token a gateway refused, kept to be the pass's error when no other gateway was fed.
    pub(super) refused_token: Option<CoreError>,
    /// Gateways whose head went backwards (a restored disk): their blob walk starts again and a
    /// snapshot is retaken at once.
    pub(super) rolled: BTreeSet<String>,
    /// How many parts this pass read back, and the gateways it found damage at.
    pub(super) sampled: usize,
    pub(super) repairing: BTreeSet<String>,
    /// A snapshot spooled for a gateway that never became its head and that a newer one has
    /// superseded, by gateway: its manifest and the ranges only it named are garbage once the
    /// newer head is set.
    pub(super) abandoned: BTreeMap<String, Name>,
}

impl Pass {
    fn new() -> Self {
        Self {
            confirmed: 0,
            stopped: wire::DrainStop::Empty,
            acked_at_ms: None,
            need: Vec::new(),
            names: BTreeMap::new(),
            asks: 0,
            waiting_bytes: BTreeSet::new(),
            free: 0,
            media_confirmed: 0,
            promised: 0,
            planned: BTreeMap::new(),
            heard: None,
            fed: 0,
            refused_token: None,
            rolled: BTreeSet::new(),
            sampled: 0,
            repairing: BTreeSet::new(),
            abandoned: BTreeMap::new(),
        }
    }

    /// The mover stopped this pass, or did not: answers whether it did, and
    /// keeps why — what the pass answers, and what the gateway did.
    pub(super) fn stopped_by(&mut self, stop: &Stop) -> Result<bool> {
        let Some(answer) = stop_of(stop)? else {
            return Ok(false);
        };
        self.stopped = answer;
        self.heard = match stop {
            Stop::Unreachable(_) => Some(Reach::Unreachable),
            Stop::Untrusted(_) => Some(Reach::Untrusted),
            Stop::Refused(refusal) => Some(heard_of(refusal)),
            _ => None,
        };
        Ok(true)
    }

    /// Whether this pass already asked for the item, under its hash or its
    /// identifier.
    fn has_asked(&self, ask: &LibraryAsk<'_>) -> bool {
        self.planned.contains_key(&ask.os_ref)
            || self
                .need
                .iter()
                .any(|need| need.content_hash == ask.file.h.as_bytes())
    }

    /// Ask the shell to stream the item, planning `parts` from it and
    /// promising their room.
    fn ask_for(&mut self, ask: &LibraryAsk<'_>, parts: Vec<u32>) {
        self.promised = self
            .promised
            .saturating_add(bytes_of_parts(ask.file.len, &parts));
        self.need.push(wire::NeedBytes {
            content_hash: ask.file.h.as_bytes().to_vec(),
            os_ref: ask.os_ref.clone(),
            media_type: ask.file.media_type.clone(),
            size: ask.file.len,
        });
        self.planned.insert(
            ask.os_ref.clone(),
            Planned {
                h: ask.file.h,
                len: ask.file.len,
                parts,
            },
        );
    }

    /// The part names of `file`, in order.
    pub(super) fn names_of(&mut self, keys: &BackupKeys, file: &ContentFile) -> &[Name] {
        self.names
            .entry(*file.h.as_bytes())
            .or_insert_with(|| names_of(keys, &file.h, file.len))
    }

    pub(super) fn count(&mut self, confirmed: usize) {
        self.confirmed = self
            .confirmed
            .saturating_add(u32::try_from(confirmed).unwrap_or(u32::MAX));
    }
}

fn deadline_of(deadline_ms: u64, started: Instant) -> Instant {
    let budget = if deadline_ms == 0 {
        // NO DEADLINE: the member is watching. A year stands for "none" so
        // the checks between parts stay one comparison.
        Duration::from_secs(365 * 24 * 60 * 60)
    } else {
        Duration::from_millis(deadline_ms)
    };
    started.checked_add(budget).unwrap_or(started)
}

/// `gateway_id` answered `UNAUTHORIZED` to this phone's token: mark it for
/// pairing again, and let the status wait on that rather than on time (the
/// sweep's F2). A pairing starts the gateway's record over, which spends it.
pub(super) fn mark_token_refused(state: &DeviceState, gateway_id: &str) -> Result<()> {
    set_reach(state, gateway_id, Reach::PairAgain)
}

/// What the last pass found at one gateway (#1188, B1): every paired gateway has its own
/// answer, so the status can name the one that is behind.
pub(super) fn set_reach(state: &DeviceState, gateway_id: &str, reach: Reach) -> Result<()> {
    state
        .set_reach(gateway_id, reach, now_ms())
        .map_err(plane_error)
}

/// **Run one pass.** See the module header.
///
/// # Errors
/// [`CoreError::VaultMoved`] when every paired gateway proved that another phone holds this
/// vault's writer epoch (#1191, E4); [`CoreError::InvalidRequest`] for a request that names no
/// transfer rule; the device state's, the spool's or the vault's refusal.
pub fn run(
    handle: &Handle,
    keyring: &Keyring,
    request: &wire::DrainRequest,
    runtime: &tokio::runtime::Handle,
) -> Result<wire::DrainResponse> {
    run_cancellable(handle, keyring, request, runtime, None)
}

pub(crate) fn run_cancellable(
    handle: &Handle,
    keyring: &Keyring,
    request: &wire::DrainRequest,
    runtime: &tokio::runtime::Handle,
    cancellation: Option<crate::handle::Cancellation>,
) -> Result<wire::DrainResponse> {
    if let Some(stop) = &cancellation {
        stop.check()?;
    }
    // THE MEMBER'S RULE IS SENT WITH EVERY REQUEST; none is assumed (#1191). Refused before anything
    // is read or written.
    let conditions = Conditions::of(request)?;
    // THE LAST PASS'S PLAN IS SPENT: a pass that answers early asks for
    // nothing, and a stream with no plan seals the way a first read does.
    handle.plan_library(BTreeMap::new());
    let started = Instant::now();
    let deadline = deadline_of(request.deadline_ms, started);
    let plane = handle.plane();
    let state = plane.state()?;
    plane.remember(conditions);
    if conditions.snapshot {
        plane.set_snapshot_owed(true);
    }
    let spool = plane.spool()?;
    // SUPERSEDED AT EVERY GATEWAY, there is nowhere left to write (E4). A
    // gateway that proved a takeover is left out of the pass by itself, and
    // the others are fed.
    if let Some(epoch) = crate::phone::superseded_everywhere(&state)? {
        return Err(CoreError::VaultMoved {
            current_epoch: epoch,
            moved_at_ms: 0,
        });
    }
    let mut pass = Pass::new();
    let gateways = state.gateways().map_err(plane_error)?;
    // EVERY PAIRED GATEWAY IS FED (#1188, B1): the pass asks all of them, and each that
    // answers as itself is a replica this pass brings up to date.
    let fleet = if gateways.is_empty() {
        link::Fleet {
            reached: Vec::new(),
            silent: Vec::new(),
            untrusted: Vec::new(),
            pair_again: Vec::new(),
        }
    } else {
        link::reach_all(
            &gateways,
            &state,
            &plane.tokens(),
            keyring.vault.identity.signing(),
            runtime,
        )?
    };
    if let Some(stop) = &cancellation {
        stop.check()?;
    }
    for reached in &fleet.reached {
        // A GATEWAY THAT ANSWERED IS REACHED, whatever it said last time; a refusal a pass finds
        // later in this pass is recorded when it comes.
        if !matches!(reached.gateway.reach, Reach::PairAgain | Reach::Moved) {
            set_reach(&state, &reached.gateway.gateway_id, Reach::Ok)?;
        }
    }
    for id in &fleet.silent {
        set_reach(&state, id, Reach::Unreachable)?;
    }
    for id in &fleet.untrusted {
        set_reach(&state, id, Reach::Untrusted)?;
    }
    if fleet.reached.is_empty() {
        // NOTHING PAIRED, NOTHING ANSWERED, OR NOT THE PINNED GATEWAY: nothing is
        // sealed for nobody, and the spool is left exactly as it was.
        pass.stopped = if fleet.untrusted.is_empty() {
            wire::DrainStop::Unreachable
        } else {
            wire::DrainStop::Untrusted
        };
        return answer(&spool, pass);
    }
    let everyone =
        fleet.silent.is_empty() && fleet.untrusted.is_empty() && fleet.pair_again.is_empty();
    let mut reached = fleet.reached;
    for gateway in &mut reached {
        gateway.store.set_cancellation(cancellation.clone());
    }
    reached[0].store.checkpoint()?;
    let outcome = pass_over(
        handle,
        keyring,
        plane,
        &state,
        &spool,
        &reached,
        &conditions,
        deadline,
        everyone,
        &mut pass,
    );
    reached[0].store.checkpoint()?;
    handle.plan_library(std::mem::take(&mut pass.planned));
    outcome?;
    // A TOKEN NO REACHED GATEWAY ACCEPTED is the pass's error, as it was when one gateway was
    // all there was; with another fed, the pass answers and the refused one is marked.
    if let Some(error) = pass.refused_token.take()
        && pass.fed == 0
    {
        return Err(error);
    }
    answer(&spool, pass)
}

/// What a gateway's failure inside a pass comes to: the gateway leaves the pass and the
/// others are still fed, or the failure is the pass's own.
///
/// # Errors
/// A superseded writer, and every failure that is not one gateway's.
pub(super) fn absorb(
    state: &DeviceState,
    pass: &mut Pass,
    gateway: &Reached,
    error: CoreError,
) -> Result<()> {
    let id = &gateway.gateway.gateway_id;
    match error {
        CoreError::Unavailable { reason } => {
            tracing::debug!(%reason, "the gateway stopped answering mid-pass");
            set_reach(state, id, Reach::Unreachable)?;
            pass.stopped = wire::DrainStop::Unreachable;
            Ok(())
        }
        // THE GATEWAY WAS FORGOTTEN UNDER THE PASS (`forget_destination` from the Backup
        // screen while Back up now runs): its token is revoked and its row gone. That is a
        // gateway the pass no longer feeds, not an error.
        _ if state.gateway(id).map_err(plane_error)?.is_none() => {
            tracing::info!("a gateway this pass reached was forgotten under it");
            pass.stopped = wire::DrainStop::Unreachable;
            Ok(())
        }
        CoreError::VaultMoved { current_epoch, .. } => {
            // THAT GATEWAY ONLY (#1191, E4): another phone proved, with a claim
            // the vault key signed above the epoch this phone holds there, that
            // it writes there now. The mark is on that gateway's row; the pass to
            // every other gateway goes on, and the status says another phone has
            // taken over. Only when every paired gateway is moved does a pass
            // refuse ([`crate::phone::superseded_everywhere`]).
            state
                .set_moved(id, current_epoch, now_ms())
                .map_err(plane_error)?;
            if crate::phone::superseded_everywhere(state)?.is_some() {
                return Err(CoreError::VaultMoved {
                    current_epoch,
                    moved_at_ms: gateway.gateway_ms,
                });
            }
            pass.stopped = wire::DrainStop::Refused;
            Ok(())
        }
        CoreError::GatewayRefused { reason } => match refused_by(&reason) {
            // THE GATEWAY ANSWERED, AND ITS ANSWER IS ITS OWN — a full disk, a part over its
            // limit, a code this build does not know — on a call that was not a part's `PUT`:
            // the same stop the mover gives a refused part (#1080, the sweep's F1), so the status
            // says that machine has to be looked at, not that time will pass. It stops this
            // gateway's pass and no other's.
            Refused::Limit(heard) => {
                tracing::warn!(code = %reason, "the gateway refused; it leaves the pass");
                set_reach(state, id, heard)?;
                pass.stopped = stop_for(heard);
                Ok(())
            }
            // A TOKEN THE GATEWAY DOES NOT KNOW (#1080, the sweep's F2): marked, so the
            // status says to pair again.
            Refused::Token => {
                tracing::warn!("the gateway does not know this phone's token; pair again");
                mark_token_refused(state, id)?;
                pass.refused_token
                    .get_or_insert(CoreError::GatewayRefused { reason });
                Ok(())
            }
        },
        other => Err(other),
    }
}

/// Run `step` over each gateway still in the pass. A step that stops a gateway softly
/// (`Flow::Stop`: it went away, or answered with its own limit) takes it out of the
/// remaining phases and records what it heard; a failure is [`absorb`]ed.
pub(super) fn each<'a>(
    live: &mut Vec<&'a Reached>,
    state: &DeviceState,
    pass: &mut Pass,
    mut step: impl FnMut(&'a Reached, &mut Pass) -> Result<Flow>,
) -> Result<()> {
    let mut staying: Vec<&'a Reached> = Vec::with_capacity(live.len());
    for gateway in live.drain(..) {
        pass.heard = None;
        match step(gateway, pass) {
            Ok(Flow::Continue) => staying.push(gateway),
            Ok(Flow::Stop) => {
                if let Some(heard) = pass.heard.take() {
                    set_reach(state, &gateway.gateway.gateway_id, heard)?;
                }
            }
            Err(error) => absorb(state, pass, gateway, error)?,
        }
    }
    *live = staying;
    Ok(())
}

/// Whether a gateway stays in the pass's remaining phases.
pub(super) enum Flow {
    Continue,
    Stop,
}

#[allow(clippy::too_many_arguments)]
fn pass_over(
    handle: &Handle,
    keyring: &Keyring,
    plane: &Plane,
    state: &DeviceState,
    spool: &Spool,
    fleet: &[Reached],
    conditions: &Conditions,
    deadline: Instant,
    everyone: bool,
    pass: &mut Pass,
) -> Result<()> {
    let mut live: Vec<&Reached> = fleet.iter().collect();
    let reachable: Vec<String> = fleet
        .iter()
        .map(|reached| reached.gateway.gateway_id.clone())
        .collect();
    let round = Round {
        handle,
        keyring,
        plane,
        state,
        spool,
        deadline,
    };
    // A GATEWAY FOUND TO HAVE LOST SOMETHING by an earlier pass (a head that went backwards, a
    // read-back that found damage) is retaken at once, until a current head is set there.
    for reached in fleet {
        if plane.rolled(&reached.gateway.gateway_id) {
            pass.rolled.insert(reached.gateway.gateway_id.clone());
        }
    }
    // A ROW KEPT FOR A GATEWAY THAT NEVER CAME BACK IS KEPT A DAY, not for ever.
    mover::release_expired(state, spool, now_ms()).map_err(plane_error)?;

    let owes_reconcile = handle.owes_full_reconcile();
    let budget = plane.budget();
    pass.free = plane.free_bytes();
    let mut planner = plan::PassPlan::new(*conditions, fleet.len(), everyone, owes_reconcile);

    loop {
        match planner.next_step() {
            plan::Step::ContactAndReconcile => {
                // THE WRITER EPOCH, AT CONTACT (#1080, the sweep's R6), and — once a core's life —
                // every owed name squared with each gateway (#1080 ruling 7: reconciled "on every launch").
                let mut squared_all = true;
                each(&mut live, state, pass, |reached, pass| {
                    let store = &reached.store;
                    let id = &reached.gateway.gateway_id;
                    match store.head_and_epoch() {
                        Ok((epoch, _)) if epoch > reached.gateway.epoch => {
                            return Err(CoreError::VaultMoved {
                                current_epoch: epoch,
                                moved_at_ms: 0,
                            });
                        }
                        Ok((_, head)) => {
                            if reached.gateway.reach == Reach::PairAgain {
                                set_reach(state, id, Reach::Ok)?;
                            }
                            if plan::head_rolled_back(
                                reached.gateway.head.is_some(),
                                reached.gateway.generation,
                                head.as_ref().map(|h| h.generation),
                            ) {
                                tracing::warn!(gateway = %id, "the gateway's head went backwards");
                                state.set_cursor(id, 0).map_err(plane_error)?;
                                pass.rolled.insert(id.clone());
                                plane.set_rolled(id, true);
                            }
                        }
                        Err(StoreError::Unreachable(reason)) => {
                            pass.stopped_by(&Stop::Unreachable(reason))?;
                            squared_all = false;
                            return Ok(Flow::Stop);
                        }
                        Err(StoreError::Untrusted(reason)) => {
                            pass.stopped_by(&Stop::Untrusted(reason))?;
                            squared_all = false;
                            return Ok(Flow::Stop);
                        }
                        Err(error) => return Err(store_error(error)),
                    }
                    if owes_reconcile || pass.rolled.contains(id) {
                        let squared = mover::reconcile(state, spool, store, &SystemClock)
                            .map_err(plane_error)?;
                        pass.media_confirmed =
                            pass.media_confirmed.saturating_add(squared.confirmed.len());
                    }
                    Ok(Flow::Continue)
                })?;
                if planner.on_contact(live.len(), squared_all) {
                    handle.reconciled_fully();
                }
            }
            plan::Step::VerifySamples => {
                // 0. THE PHONE VERIFIES, BEFORE IT WRITES (#1188, B4; #1191, E10).
                each(&mut live, state, pass, |reached, pass| {
                    verify_sample(
                        plane,
                        state,
                        &reached.store,
                        &keyring.backup,
                        conditions.metered,
                        pass,
                    )?;
                    Ok(Flow::Continue)
                })?;
                planner.on_verify(live.len());
            }
            plan::Step::Records => {
                // 1. THE RECORDS, when the link may carry them: one snapshot, planned against every
                // gateway that is due or behind.
                let owed = plane.snapshot_owed();
                let newest = newest_stands(handle, state, &live, &pass.rolled)?;
                let any_due = if newest.is_some() {
                    false
                } else {
                    let mut due = false;
                    for reached in &live {
                        due |= snapshot_due(
                            state,
                            reached.store.gateway_id(),
                            owed,
                            pass.rolled.contains(reached.store.gateway_id()),
                        )?;
                    }
                    due
                };
                let decision = plan::decide_records(newest, owed, any_due);
                if let Some(acked) = decision.acked_at_ms {
                    pass.acked_at_ms = Some(acked);
                }
                if decision.clear_owed {
                    plane.set_snapshot_owed(false);
                }
                let stopped_early =
                    round.records(decision.take_snapshot, &mut live, budget, pass)?;
                planner.on_records(live.len(), stopped_early);
            }
            plan::Step::Media => {
                // 2. THE MEDIA, INTERLEAVED: one bounded round per gateway in turn (#1188, item 16).
                let bytes = handle.bytes();
                let mut all_finished = true;
                let mut feeds: Vec<Feed<'_>> =
                    live.iter().map(|reached| Feed::new(reached)).collect();
                let mut left: BTreeSet<String> = BTreeSet::new();
                while feeds.iter().any(|feed| !feed.finished) {
                    for feed in feeds.iter_mut().filter(|feed| !feed.finished) {
                        pass.heard = None;
                        let id = feed.reached.gateway.gateway_id.clone();
                        let step = media_round(
                            feed,
                            handle,
                            state,
                            spool,
                            &keyring.backup,
                            bytes.as_ref().map(centraid_blobs::ContentBytes::store),
                            conditions,
                            budget,
                            deadline,
                            &reachable,
                            pass,
                        );
                        match step {
                            Ok(Flow::Continue) => {}
                            Ok(Flow::Stop) => {
                                feed.finished = true;
                                all_finished = false;
                                left.insert(id.clone());
                                if let Some(heard) = pass.heard.take() {
                                    set_reach(state, &id, heard)?;
                                }
                            }
                            Err(error) => {
                                feed.finished = true;
                                all_finished = false;
                                left.insert(id);
                                absorb(state, pass, feed.reached, error)?;
                            }
                        }
                    }
                }
                live.retain(|reached| !left.contains(&reached.gateway.gateway_id));
                planner.on_media(live.len(), all_finished, pass.media_confirmed);
            }
            plan::Step::CheckUncoveredRows => {
                // 3. THE RECORDS AGAIN, WHEN THIS PASS CONFIRMED FILES THEIR ROWS ARE NOT IN A
                // SNAPSHOT FOR (R-1080-C15).
                let now_files =
                    handle.with_vault(|vault| content_files(vault).map_err(plane_error))?;
                let mut uncovered = false;
                for reached in fleet {
                    uncovered |= rows_uncovered(
                        handle,
                        state,
                        &reached.gateway.gateway_id,
                        conditions,
                        &now_files,
                    )?;
                }
                planner.on_uncovered_check(uncovered);
            }
            plan::Step::FollowupRecords => {
                round.records(true, &mut live, budget, pass)?;
                planner.on_followup_done();
            }
            plan::Step::MarkSnapshotOwed => {
                plane.set_snapshot_owed(true);
                planner.on_followup_done();
            }
            plan::Step::Done => break,
        }
    }
    Ok(())
}

fn answer(spool: &Spool, pass: Pass) -> Result<wire::DrainResponse> {
    Ok(wire::DrainResponse {
        pending_bytes: spool.bytes().map_err(plane_error)?,
        stopped: pass.stopped as i32,
        acked_at_ms: pass.acked_at_ms,
        confirmed_parts: pass.confirmed,
        waiting_bytes_parts: u32::try_from(pass.waiting_bytes.len()).unwrap_or(u32::MAX),
        need_bytes: pass.need,
    })
}
