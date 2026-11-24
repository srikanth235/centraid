//! The phone engine: one pass per gateway, a scheduler over every gateway's
//! debt (spec §6.2, §6.3, [#1209](https://github.com/srikanth235/centraid/issues/1209)).
//!
//! A pass is a state machine over a [`Store`]; its only I/O is that trait, the
//! device state, the staging area and the vault's content, and it holds no
//! clock (the instant is an argument) and no thread. One [`GatewayPass::step`]
//! does one bounded piece of work, usually one bundle, so a scheduler can
//! interleave gateways and classes and a caller can stop between any two steps.
//!
//! ```text
//! 1  Head        read it. Equal to `conf` (or both absent): incremental. Else recovery:
//!                drop `conf`, `troot`, `oroot` and every claim, and learn what is held by `exists`.
//! 2  Records     owed = the new tree's records minus those reachable from `conf` (incremental)
//!                or minus what `exists` reports (recovery); sent in bundles.
//! 3  Commit rule every records ref of the new root is acknowledged this pass, reachable from
//!                `conf` with the head unchanged, or reported held. A violation is a bug.
//! 4  Set head    compare-and-set, then persist `conf`.
//! 5  Thumbnails, then originals (newest first), each ending in `troot`, then `oroot`.
//! ```
//!
//! **Nothing an OS transport reports marks anything stored (R7):** only a
//! `stored`, `there` or `held` answer of a frame this engine sent, or an
//! `exists` that does not list the name, does.
//!
//! Every step is safe to repeat after a crash at any point: a resent frame is
//! answered `there`, and `conf`, `troot` and `oroot` are written only after
//! what they claim is true.

use std::cell::{Cell, RefCell};
use std::collections::{BTreeMap, BTreeSet, HashMap, VecDeque};

use centraid_media::sealed::{self, BackupKeys, Class, Digest, Name, PlaintextHash, Ref};

use super::content;
use super::staging::Staging;
use super::state::DeviceState;
use super::state::{Gateway, Reach};
use super::store::{
    Deleted, FrameAnswer, Head, NAMES_PER_CALL, NameState, Outgoing, Refusal, Store, StoreError,
};
use super::tree::{self, Entry};
use super::{PlaneError, Result, invariant};
use crate::file::Vault;

/// The most a bundle carries before it is sent: well under the protocol's cap, so a window of
/// many gateways stays in memory.
pub const BUNDLE_TARGET_BYTES: u64 = 16 * 1024 * 1024;

/// The most frames one bundle carries.
pub const BUNDLE_MAX_FRAMES: usize = 256;

/// Read-back: random chunks per pass, and on a metered link (E10).
pub const SAMPLE_CHUNKS: usize = 64;
pub const SAMPLE_CHUNKS_METERED: usize = 8;

/// Read-back: names walked in order per pass, so every stored name is read in a bounded number
/// of passes whatever the dice say.
pub const SCRUB_NAMES: usize = 32;

/// OS background bundles: how many files, and how large each may be (§6.5).
pub const OS_BUNDLES: usize = 4;
pub const OS_BUNDLE_BYTES: u64 = 32 * 1024 * 1024;

/// What an Undo keeps from collection: a week (§6.2 step 7).
pub const UNDO_KEEP_MS: u64 = 7 * 24 * 60 * 60 * 1000;

/// The scheduler's head re-read interval, in windows: `max(4, ceil(2 × gateways / W))`, where
/// `W` is the number of calls a window allows (§6.2 step 6).
#[must_use]
pub const fn head_recheck_every(gateways: usize, window_calls: usize) -> usize {
    let wanted = (2 * gateways).div_ceil(if window_calls == 0 { 1 } else { window_calls });
    if wanted < 4 { 4 } else { wanted }
}

// ─── planted bugs ───────────────────────────────────────────────────────────

/// Bugs planted on purpose, each behind a switch, for the simulation to catch (spec §8). Without
/// the `plant-bugs` feature this is empty and every question answers no.
#[cfg(feature = "plant-bugs")]
#[derive(Debug, Clone, Copy, Default)]
pub struct Bugs {
    /// Acknowledge a `taken` frame whatever digest it names.
    pub ack_taken: bool,
    /// Believe the OS when it says a name was uploaded.
    pub trust_os: bool,
    /// Skip comparing the head with `conf`.
    pub skip_head_check: bool,
    /// Never take the periodic full read.
    pub no_full_read: bool,
    /// Set the head before the records are confirmed.
    pub head_before_records: bool,
    /// A delete bound to whatever head stands when it is sent, not the one its keep set was read at.
    pub unbound_delete: bool,
}

/// Bugs planted on purpose: none in this build.
#[cfg(not(feature = "plant-bugs"))]
#[derive(Debug, Clone, Copy, Default)]
pub struct Bugs;

impl Bugs {
    /// No planted bugs.
    #[must_use]
    pub const fn none() -> Self {
        #[cfg(feature = "plant-bugs")]
        {
            Self {
                ack_taken: false,
                trust_os: false,
                skip_head_check: false,
                no_full_read: false,
                head_before_records: false,
                unbound_delete: false,
            }
        }
        #[cfg(not(feature = "plant-bugs"))]
        {
            Self
        }
    }
    #[cfg(feature = "plant-bugs")]
    const fn ack_taken(&self) -> bool {
        self.ack_taken
    }
    #[cfg(not(feature = "plant-bugs"))]
    const fn ack_taken(&self) -> bool {
        false
    }
    #[cfg(feature = "plant-bugs")]
    pub(crate) const fn trust_os(&self) -> bool {
        self.trust_os
    }
    #[cfg(not(feature = "plant-bugs"))]
    pub(crate) const fn trust_os(&self) -> bool {
        false
    }
    #[cfg(feature = "plant-bugs")]
    const fn skip_head_check(&self) -> bool {
        self.skip_head_check
    }
    #[cfg(not(feature = "plant-bugs"))]
    const fn skip_head_check(&self) -> bool {
        false
    }
    #[cfg(feature = "plant-bugs")]
    pub(crate) const fn no_full_read(&self) -> bool {
        self.no_full_read
    }
    #[cfg(not(feature = "plant-bugs"))]
    pub(crate) const fn no_full_read(&self) -> bool {
        false
    }
    #[cfg(feature = "plant-bugs")]
    const fn head_before_records(&self) -> bool {
        self.head_before_records
    }
    #[cfg(not(feature = "plant-bugs"))]
    const fn head_before_records(&self) -> bool {
        false
    }
    #[cfg(feature = "plant-bugs")]
    pub(crate) const fn unbound_delete(&self) -> bool {
        self.unbound_delete
    }
    #[cfg(not(feature = "plant-bugs"))]
    pub(crate) const fn unbound_delete(&self) -> bool {
        false
    }
}

// ─── the member's rule ──────────────────────────────────────────────────────

/// The link the pass runs on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Link {
    Unmetered,
    Metered,
}

/// The member's rule, and whether they just asked.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Policy {
    pub link: Link,
    /// The member lets photos use cellular data. Off by default (Wi-Fi only).
    pub photos_on_cellular: bool,
    /// The member pressed "Back up now": records go on a metered link, never a heavy original.
    pub asked: bool,
}

impl Policy {
    /// Wi-Fi only, nothing asked.
    pub const WIFI: Self = Self {
        link: Link::Unmetered,
        photos_on_cellular: false,
        asked: false,
    };

    /// Whether `class` may cross this link now. A video original never crosses a metered one.
    #[must_use]
    pub const fn allows(&self, class: Class, video: bool) -> bool {
        match (self.link, class) {
            (Link::Unmetered, _) => true,
            (Link::Metered, Class::Records) => self.asked || self.photos_on_cellular,
            (Link::Metered, Class::Thumbnails) => self.photos_on_cellular,
            (Link::Metered, Class::Originals) => self.photos_on_cellular && !video,
        }
    }
}

// ─── the environment ────────────────────────────────────────────────────────

/// What a pass reads and writes besides its store.
pub struct Env<'a> {
    pub vault: &'a Vault,
    pub keys: &'a BackupKeys,
    pub state: &'a DeviceState,
    pub staging: &'a Staging,
    pub policy: Policy,
    pub now_ms: u64,
    pub bugs: Bugs,
    peers: Vec<&'a dyn Store>,
    /// Objects built this window, so a chunk is read and sealed once for every gateway that owes it.
    cache: RefCell<HashMap<Name, Vec<u8>>>,
    /// How many chunks were read from the vault's content and sealed (the cache's misses).
    source_reads: Cell<u64>,
}

impl<'a> Env<'a> {
    /// An environment for one scheduler run.
    #[must_use]
    pub fn new(
        vault: &'a Vault,
        keys: &'a BackupKeys,
        state: &'a DeviceState,
        staging: &'a Staging,
        policy: Policy,
        now_ms: u64,
    ) -> Self {
        Self {
            vault,
            keys,
            state,
            staging,
            policy,
            now_ms,
            bugs: Bugs::none(),
            peers: Vec::new(),
            cache: RefCell::new(HashMap::new()),
            source_reads: Cell::new(0),
        }
    }

    /// Peer gateways to fetch sealed chunks from when neither staging nor the local content store
    /// holds a chunk (e.g., syncing a cloud-only original to a newly paired second gateway).
    #[must_use]
    pub fn with_peers(mut self, peers: Vec<&'a dyn Store>) -> Self {
        self.peers = peers;
        self
    }

    /// Chunks read from the vault's content and sealed so far.
    #[must_use]
    pub fn source_reads(&self) -> u64 {
        self.source_reads.get()
    }

    /// Start a new window: forget the objects built in the last.
    pub fn new_window(&self) {
        self.cache.borrow_mut().clear();
    }

    /// The newest snapshot's root, from the node cache.
    ///
    /// # Errors
    /// The state's refusal.
    pub fn newest(&self) -> Result<Option<Ref>> {
        let Some((name, _)) = self.state.device()?.newest else {
            return Ok(None);
        };
        self.node_ref(&name)
    }

    fn node_ref(&self, name: &Name) -> Result<Option<Ref>> {
        let Some(plaintext) = self.state.get_node(name)? else {
            return Ok(None);
        };
        let sealed = sealed::seal(self.keys, Class::Records, &plaintext)?;
        Ok((sealed.name == *name).then(|| sealed.reference()))
    }

    fn remember(&self, name: Name, object: Vec<u8>) -> Vec<u8> {
        self.cache.borrow_mut().insert(name, object.clone());
        object
    }

    /// Rebuild the object `reference` names: staged bytes, a node resealed from its plaintext, or
    /// a content chunk read and sealed again. `None` when its source is gone or has changed.
    ///
    /// # Errors
    /// The state's, staging's or vault's refusal.
    pub fn rebuild(
        &self,
        reference: &Ref,
        lookup: &BTreeMap<Name, (PlaintextHash, u64)>,
    ) -> Result<Option<Vec<u8>>> {
        if let Some(object) = self.cache.borrow().get(&reference.name) {
            return Ok(Some(object.clone()));
        }
        if let Some(object) = self.staging.get(&reference.name)?
            && Digest::of(&object) == reference.digest
        {
            return Ok(Some(self.remember(reference.name, object)));
        }
        match reference.class {
            Class::Records => {
                if let Some(plaintext) = self.state.get_node(&reference.name)? {
                    let sealed = sealed::seal(self.keys, Class::Records, &plaintext)?;
                    if sealed.reference() == *reference {
                        return Ok(Some(self.remember(reference.name, sealed.object)));
                    }
                }
            }
            class => {
                if let Some((h, index)) = lookup.get(&reference.name) {
                    self.source_reads.set(self.source_reads.get() + 1);
                    if let Some(sealed) =
                        content::seal_chunk(self.vault, self.keys, h, *index, class)?
                        && sealed.reference() == *reference
                    {
                        return Ok(Some(self.remember(reference.name, sealed.object)));
                    }
                }
            }
        }
        for peer in &self.peers {
            let mut buf = Vec::new();
            if peer.get(&reference.name, &mut buf).is_ok()
                && sealed::open(self.keys, reference, &buf).is_ok()
            {
                return Ok(Some(self.remember(reference.name, buf)));
            }
        }
        Ok(None)
    }
}

// ─── what a pass reports ────────────────────────────────────────────────────

/// Why a pass stopped before it was done.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Stop {
    Unreachable,
    Untrusted,
    TooOld,
    /// The gateway refused this phone's token (`UNAUTHORIZED`): pair again.
    PairAgain,
    Moved {
        epoch: u64,
    },
    Frozen,
    Busy,
    /// The gateway's disk is full.
    Full,
    /// A range the gateway is owed is no longer staged: take a snapshot that stages it again.
    Restage,
    /// The gateway refused a frame in a way that waiting does not mend.
    Refused(String),
}

impl Stop {
    const fn reach(&self) -> Option<(Reach, Option<u64>)> {
        match self {
            Self::Unreachable => Some((Reach::Unreachable, None)),
            Self::Untrusted => Some((Reach::Untrusted, None)),
            Self::TooOld => Some((Reach::TooOld, None)),
            Self::PairAgain => Some((Reach::PairAgain, None)),
            Self::Moved { epoch } => Some((Reach::Moved, Some(*epoch))),
            Self::Frozen => Some((Reach::Frozen, None)),
            Self::Busy => Some((Reach::Busy, None)),
            // `Full` and `Refused` are write refusals from a reached gateway, not an unreachable
            // gateway; `Restage` is a local staging miss.
            Self::Full | Self::Restage | Self::Refused(_) => None,
        }
    }
}

/// What one step did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Step {
    /// Work was done; call again.
    Worked,
    /// The pass is over: everything the rule allows is confirmed.
    Done,
    /// The pass stopped.
    Stopped(Stop),
    /// The newest snapshot or the head moved: the pass started over.
    Restarted,
}

/// Counts of what a pass did: what tests assert on.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct PassStats {
    pub stored: u64,
    pub there: u64,
    pub held: u64,
    pub bundles: u64,
    pub exists_calls: u64,
    pub heads_set: u64,
    pub freed: u64,
    pub restarts: u64,
    /// Chunks the member's rule or missing bytes kept out of this pass.
    pub waiting: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Mode {
    Incremental,
    Recovery,
}

struct MediaItem {
    reference: Ref,
    video: bool,
}

struct MediaPhase {
    class: Class,
    /// Every chunk of this class in the target tree, newest first.
    items: Vec<MediaItem>,
    cursor: usize,
    lookup: BTreeMap<Name, (PlaintextHash, u64)>,
    held: BTreeSet<Name>,
    ready: VecDeque<Ref>,
    skipped: u64,
}

enum Stage {
    Start,
    Records(VecDeque<Ref>),
    Commit,
    Media(Box<MediaPhase>),
    Finished,
    Stopped(Stop),
}

/// One gateway's pass.
pub struct GatewayPass<'e, 's> {
    env: &'e Env<'e>,
    store: &'s dyn Store,
    id: String,
    target: Ref,
    head: Option<Head>,
    mode: Mode,
    stage: Stage,
    /// Names this gateway acknowledged (or `exists` reported) during this pass.
    acked: BTreeSet<Name>,
    /// The records the target names, and which of them the gateway already had.
    records: BTreeMap<Name, Ref>,
    conf_refs: Option<BTreeSet<Name>>,
    after_media: Class,
    pub stats: PassStats,
}

fn video_of(entry: &Entry) -> bool {
    entry
        .media_type
        .trim()
        .to_ascii_lowercase()
        .starts_with("video/")
}

impl<'e, 's> GatewayPass<'e, 's> {
    /// A pass toward the newest snapshot.
    ///
    /// # Errors
    /// The state's refusal; there is no snapshot yet; or the gateway is not paired.
    pub fn new(env: &'e Env<'e>, store: &'s dyn Store) -> Result<Self> {
        let id = store.gateway_id().to_owned();
        if env.state.gateway(&id)?.is_none() {
            return Err(invariant(format!("gateway {id} is not paired")));
        }
        let target = env
            .newest()?
            .ok_or_else(|| invariant("there is no snapshot to back up yet"))?;
        Ok(Self {
            env,
            store,
            id,
            target,
            head: None,
            mode: Mode::Incremental,
            stage: Stage::Start,
            acked: BTreeSet::new(),
            records: BTreeMap::new(),
            conf_refs: None,
            after_media: Class::Records,
            stats: PassStats::default(),
        })
    }

    /// The gateway this pass serves.
    #[must_use]
    pub fn gateway_id(&self) -> &str {
        &self.id
    }

    /// The root this pass is moving toward.
    #[must_use]
    pub const fn target(&self) -> &Ref {
        &self.target
    }

    /// The class of the work this pass owes next, or `None` when it has none.
    #[must_use]
    pub const fn next_class(&self) -> Option<Class> {
        match &self.stage {
            Stage::Start | Stage::Records(_) | Stage::Commit => Some(Class::Records),
            Stage::Media(phase) => Some(phase.class),
            Stage::Finished | Stage::Stopped(_) => None,
        }
    }

    /// Why the pass stopped, when it did.
    #[must_use]
    pub const fn stop_reason(&self) -> Option<&Stop> {
        match &self.stage {
            Stage::Stopped(stop) => Some(stop),
            _ => None,
        }
    }

    /// Whether the pass has ended, one way or the other.
    #[must_use]
    pub const fn is_over(&self) -> bool {
        matches!(self.stage, Stage::Finished | Stage::Stopped(_))
    }

    /// Records are confirmed and the pass is in a media phase (or past it).
    #[must_use]
    pub const fn past_records(&self) -> bool {
        matches!(self.stage, Stage::Media(_) | Stage::Finished)
    }

    fn gateway(&self) -> Result<Gateway> {
        self.env
            .state
            .gateway(&self.id)?
            .ok_or_else(|| invariant(format!("gateway {} is not paired", self.id)))
    }

    fn stop(&mut self, stop: Stop) -> Result<Step> {
        if let Some((reach, moved)) = stop.reach() {
            self.env
                .state
                .set_reach(&self.id, reach, moved, self.env.now_ms)?;
        }
        self.stage = Stage::Stopped(stop.clone());
        Ok(Step::Stopped(stop))
    }

    /// A store error that ends the pass becomes a stop; one that does not is returned.
    fn stopped(&mut self, error: StoreError) -> Result<Step> {
        match error {
            StoreError::Unreachable(_) | StoreError::Io(_) => self.stop(Stop::Unreachable),
            StoreError::Untrusted(_) => self.stop(Stop::Untrusted),
            StoreError::GatewayOld { .. } => self.stop(Stop::TooOld),
            StoreError::Moved { epoch } => self.stop(Stop::Moved { epoch }),
            StoreError::Refused(Refusal::Unauthorized) => self.stop(Stop::PairAgain),
            StoreError::Refused(Refusal::Frozen) => self.stop(Stop::Frozen),
            StoreError::Refused(Refusal::Busy) => self.stop(Stop::Busy),
            StoreError::Refused(Refusal::DiskFull) => self.stop(Stop::Full),
            StoreError::Refused(other) => self.stop(Stop::Refused(other.code().to_owned())),
            other => Err(other.into()),
        }
    }

    fn restart(&mut self) -> Result<Step> {
        self.stats.restarts += 1;
        self.target = self
            .env
            .newest()?
            .ok_or_else(|| invariant("the newest snapshot is gone"))?;
        self.acked.clear();
        self.records.clear();
        self.conf_refs = None;
        self.stage = Stage::Start;
        Ok(Step::Restarted)
    }

    /// The OS says some of this gateway's names were uploaded by a background task. **That only
    /// wakes a pass (R7)**: nothing is recorded as stored, and the pass re-reads the head and
    /// diffs. (With the planted bug on, the report is believed.)
    pub fn os_reported(&mut self, names: &[Name]) {
        if !self.env.bugs.trust_os() {
            return;
        }
        self.acked.extend(names.iter().copied());
        if let Stage::Media(phase) = &mut self.stage {
            phase.held.extend(names.iter().copied());
        }
    }

    /// Re-read the head while in a media phase: if it is no longer `conf`, start over (§6.2 step 6).
    ///
    /// # Errors
    /// The state's refusal.
    pub fn recheck_head(&mut self) -> Result<Step> {
        if !self.past_records() || self.env.bugs.skip_head_check() {
            return Ok(Step::Worked);
        }
        match self.store.head() {
            Ok(head) => {
                let conf = self.gateway()?.conf.map(|(name, _)| name);
                if head.map(|head| head.name) == conf {
                    Ok(Step::Worked)
                } else {
                    self.restart()
                }
            }
            Err(error) => self.stopped(error),
        }
    }

    /// Do one bounded piece of work.
    ///
    /// # Errors
    /// A refusal the pass cannot absorb: the state, staging or vault failing, or a broken rule.
    pub fn step(&mut self) -> Result<Step> {
        if self.is_over() {
            return Ok(match &self.stage {
                Stage::Stopped(stop) => Step::Stopped(stop.clone()),
                _ => Step::Done,
            });
        }
        if let Some(newest) = self.env.newest()?
            && newest.name != self.target.name
        {
            return self.restart();
        }
        match std::mem::replace(&mut self.stage, Stage::Finished) {
            Stage::Start => self.start(),
            Stage::Records(queue) => self.records_step(queue),
            Stage::Commit => self.commit(),
            Stage::Media(phase) => self.media_step(*phase),
            Stage::Finished => Ok(Step::Done),
            Stage::Stopped(stop) => {
                self.stage = Stage::Stopped(stop.clone());
                Ok(Step::Stopped(stop))
            }
        }
    }

    // ── 1: the head ──

    fn start(&mut self) -> Result<Step> {
        let head = match self.store.head() {
            Ok(head) => head,
            Err(error) => return self.stopped(error),
        };
        let gateway = self.gateway()?;
        let conf = gateway.conf.map(|(name, _)| name);
        let standing = head.map(|head| head.name);
        self.head = head;
        self.env
            .state
            .set_reach(&self.id, Reach::Ok, None, self.env.now_ms)?;
        self.records = tree::records_of(self.env.state, &self.target)?;
        let same = conf == standing || self.env.bugs.skip_head_check();
        self.mode = if same {
            Mode::Incremental
        } else {
            // A head this phone did not last confirm: a rollback, another writer, a lost state.
            // Whether it went BACKWARDS is kept for the status ("rolled back"): the head names no
            // snapshot, or sits at a writer position no later than the one this phone last set,
            // so it cannot be a successor of `conf`. With no `conf` there is nothing to compare.
            if conf.is_some() {
                let regressed = head.is_none_or(|head| {
                    (head.epoch, head.generation) <= (gateway.epoch, gateway.generation)
                });
                self.env.state.set_regressed(&self.id, regressed)?;
            }
            self.env.state.withdraw(&self.id)?;
            Mode::Recovery
        };
        self.conf_refs = match (self.mode, conf) {
            (Mode::Incremental, Some(conf)) => {
                match self
                    .env
                    .node_ref(&conf)?
                    .map(|reference| tree::records_of(self.env.state, &reference))
                {
                    Some(Ok(refs)) => Some(refs.into_keys().collect()),
                    // The tree `conf` names is not in the cache: nothing can be assumed held.
                    _ => {
                        self.mode = Mode::Recovery;
                        None
                    }
                }
            }
            _ => None,
        };
        let owed: Vec<Ref> = match (&self.conf_refs, self.mode) {
            (Some(held), Mode::Incremental) => self
                .records
                .values()
                .filter(|reference| !held.contains(&reference.name))
                .copied()
                .collect(),
            (None, Mode::Incremental) => self.records.values().copied().collect(),
            (_, Mode::Recovery) => {
                let names: Vec<Name> = self.records.keys().copied().collect();
                let mut missing = BTreeSet::new();
                for batch in names.chunks(NAMES_PER_CALL) {
                    self.stats.exists_calls += 1;
                    match self.store.exists(batch) {
                        Ok(gone) => missing.extend(gone),
                        Err(error) => return self.stopped(error),
                    }
                }
                self.acked
                    .extend(names.iter().filter(|name| !missing.contains(name)));
                self.records
                    .values()
                    .filter(|reference| missing.contains(&reference.name))
                    .copied()
                    .collect()
            }
        };
        if self.env.bugs.head_before_records() {
            self.stage = Stage::Records(owed.into());
            return self.commit_anyway();
        }
        self.stage = Stage::Records(owed.into());
        Ok(Step::Worked)
    }

    // ── 2: records ──

    fn records_step(&mut self, mut queue: VecDeque<Ref>) -> Result<Step> {
        if queue.is_empty() {
            self.stage = Stage::Commit;
            return Ok(Step::Worked);
        }
        let mut frames: Vec<Outgoing> = Vec::new();
        let mut bytes = 0_u64;
        let none = BTreeMap::new();
        while let Some(reference) = queue.front().copied() {
            if frames.len() >= BUNDLE_MAX_FRAMES
                || (bytes >= BUNDLE_TARGET_BYTES && !frames.is_empty())
            {
                break;
            }
            let Some(object) = self.env.rebuild(&reference, &none)? else {
                // A range this gateway is owed is nowhere to be read again.
                self.stage = Stage::Records(queue);
                return self.stop(Stop::Restage);
            };
            bytes += object.len() as u64;
            frames.push(Outgoing {
                name: reference.name,
                digest: reference.digest,
                bytes: object,
            });
            queue.pop_front();
        }
        let sent: Vec<Ref> = frames
            .iter()
            .filter_map(|frame| self.records.get(&frame.name).copied())
            .collect();
        match self.send(&frames, &sent, false)? {
            Sent::Done(retry) => {
                for reference in retry.into_iter().rev() {
                    queue.push_front(reference);
                }
                self.stage = Stage::Records(queue);
                Ok(Step::Worked)
            }
            Sent::Stop(step) => Ok(step),
        }
    }

    /// Send one bundle and absorb every frame's answer. `Done` carries the refs to try again.
    ///
    /// When `retry_unanswered` is true (media phases, which have no commit-rule check), any sent
    /// ref omitted from `answers` is returned in `retry` so it is resent rather than silently
    /// dropped; a response that answers none of the sent refs stops the pass rather than looping.
    fn send(&mut self, frames: &[Outgoing], refs: &[Ref], retry_unanswered: bool) -> Result<Sent> {
        let answers = match self.store.bundle(frames) {
            Ok(answers) => answers,
            Err(error) => return Ok(Sent::Stop(self.stopped(error)?)),
        };
        self.stats.bundles += 1;
        let by_name: BTreeMap<Name, &Ref> = refs.iter().map(|r| (r.name, r)).collect();
        let mut answered: BTreeSet<Name> = BTreeSet::new();
        let mut retry = Vec::new();
        let mut damaged = Vec::new();
        for (name, answer) in answers {
            if by_name.contains_key(&name) {
                answered.insert(name);
            }
            match answer {
                FrameAnswer::Stored => {
                    self.stats.stored += 1;
                    self.acked.insert(name);
                }
                FrameAnswer::There => {
                    self.stats.there += 1;
                    self.acked.insert(name);
                }
                FrameAnswer::Held => {
                    self.stats.held += 1;
                    self.acked.insert(name);
                }
                FrameAnswer::Taken { digest, state } => {
                    let ours = by_name.get(&name).map(|r| r.digest);
                    if self.env.bugs.ack_taken() || ours == Some(digest) {
                        self.acked.insert(name);
                    } else if state == NameState::Damaged {
                        damaged.push(name);
                        if let Some(reference) = by_name.get(&name) {
                            retry.push(**reference);
                        }
                    } else {
                        // Live or held under another digest: with deterministic sealing this
                        // cannot be, unless the gateway is wrong. Wait with that reason.
                        return Ok(Sent::Stop(
                            self.stop(Stop::Refused("NAME_TAKEN".to_owned()))?,
                        ));
                    }
                }
                FrameAnswer::Full => return Ok(Sent::Stop(self.stop(Stop::Full)?)),
                FrameAnswer::TooLarge => {
                    return Ok(Sent::Stop(
                        self.stop(Stop::Refused("TOO_LARGE".to_owned()))?,
                    ));
                }
                FrameAnswer::Refused(refusal) => {
                    return Ok(Sent::Stop(
                        self.stop(Stop::Refused(refusal.code().to_owned()))?,
                    ));
                }
            }
        }
        if retry_unanswered && answered.len() < by_name.len() {
            if answered.is_empty() {
                return Ok(Sent::Stop(
                    self.stop(Stop::Refused("SHORT_BUNDLE".to_owned()))?,
                ));
            }
            for reference in refs {
                if !answered.contains(&reference.name) {
                    retry.push(*reference);
                }
            }
        }
        if !damaged.is_empty() {
            // One signed delete frees what the gateway found rotten; the next bundle resends it.
            let head_root = self.head.map(|head| head.name);
            match self.store.delete(&damaged, head_root.as_ref()) {
                Ok(deleted) => self.stats.freed += deleted.freed.len() as u64,
                Err(StoreError::HeadConflict { .. }) => {
                    return Ok(Sent::Stop(self.restart()?));
                }
                Err(error) => return Ok(Sent::Stop(self.stopped(error)?)),
            }
        }
        Ok(Sent::Done(retry))
    }

    // ── 3, 4: commit ──

    fn commit(&mut self) -> Result<Step> {
        // THE COMMIT RULE (§6.2 step 3), asserted. It is a bug, not a refusal.
        let held: &BTreeSet<Name> = &self.acked;
        let missing: Vec<&Name> = self
            .records
            .keys()
            .filter(|name| {
                !held.contains(name)
                    && !self
                        .conf_refs
                        .as_ref()
                        .is_some_and(|conf| conf.contains(name))
            })
            .collect();
        if !missing.is_empty() {
            let message = format!(
                "commit rule: {} records of the new root are neither confirmed this pass nor held at conf",
                missing.len()
            );
            debug_assert!(false, "{message}");
            tracing::error!("{message}");
            self.stage = Stage::Finished;
            return Err(invariant(message));
        }
        self.commit_anyway()
    }

    fn commit_anyway(&mut self) -> Result<Step> {
        let root = tree::root_of(self.env.state, &self.target)?;
        let standing = self.head.map(|head| head.name);
        if standing != Some(self.target.name) {
            match self.store.set_head(
                &self.target.name,
                standing.as_ref(),
                root.taken_at_ms,
                root.writes,
            ) {
                Ok(head) => {
                    self.head = Some(head);
                    self.stats.heads_set += 1;
                }
                Err(StoreError::HeadConflict { .. }) => return self.restart(),
                Err(error) => return self.stopped(error),
            }
        }
        self.env
            .state
            .confirm_records(&self.id, &self.target.name, self.env.now_ms)?;
        self.env
            .state
            .set_generation(&self.id, self.store.generation())?;
        self.after_media = Class::Thumbnails;
        self.enter_media(Class::Thumbnails)
    }

    // ── 5: media ──

    fn enter_media(&mut self, class: Class) -> Result<Step> {
        let gateway = self.gateway()?;
        let root = tree::root_of(self.env.state, &self.target)?;
        let blob_stats = tree::stats_of(self.env.state, &root.blobs)?;
        let entries = tree::entries_of(self.env.state, &root.blobs)?;
        let unheld = match class {
            Class::Thumbnails => blob_stats.unheld_thumb_files,
            Class::Originals => blob_stats.unheld_orig_files,
            Class::Records => 0,
        };
        let held_root = match class {
            Class::Thumbnails => gateway.troot,
            _ => gateway.oroot,
        };
        let held: BTreeSet<Name> = match held_root {
            Some((name, _)) => match self.env.node_ref(&name)? {
                Some(reference) => tree::media_of(self.env.state, &reference, class)
                    .map(|refs| refs.into_keys().collect())
                    .unwrap_or_default(),
                None => BTreeSet::new(),
            },
            None => BTreeSet::new(),
        };
        let mut ordered: Vec<&Entry> = entries.iter().collect();
        ordered.sort_by_key(|entry| (std::cmp::Reverse(entry.taken_at_ms), entry.h));
        let mut items = Vec::new();
        let mut lookup = BTreeMap::new();
        for entry in ordered {
            for (index, reference) in entry.refs(class).iter().enumerate() {
                lookup.insert(reference.name, (entry.h, index as u64));
                items.push(MediaItem {
                    reference: *reference,
                    video: video_of(entry),
                });
            }
        }
        self.stats.waiting += unheld;
        self.stage = Stage::Media(Box::new(MediaPhase {
            class,
            items,
            cursor: 0,
            lookup,
            held,
            ready: VecDeque::new(),
            skipped: unheld,
        }));
        Ok(Step::Worked)
    }

    fn media_step(&mut self, mut phase: MediaPhase) -> Result<Step> {
        // Take the next page of candidates: not held at troot/oroot, allowed by the rule.
        if phase.ready.is_empty() {
            let mut page: Vec<Ref> = Vec::new();
            while phase.cursor < phase.items.len() && page.len() < NAMES_PER_CALL {
                let item = &phase.items[phase.cursor];
                phase.cursor += 1;
                if phase.held.contains(&item.reference.name) {
                    continue;
                }
                if !self.env.policy.allows(phase.class, item.video) {
                    phase.skipped += 1;
                    self.stats.waiting += 1;
                    continue;
                }
                page.push(item.reference);
            }
            if page.is_empty() && phase.cursor >= phase.items.len() {
                return self.media_done(phase);
            }
            if !page.is_empty() {
                // Always ask first: a crash mid-phase must not resend gigabytes.
                let names: Vec<Name> = page.iter().map(|r| r.name).collect();
                self.stats.exists_calls += 1;
                let missing: BTreeSet<Name> = match self.store.exists(&names) {
                    Ok(missing) => missing.into_iter().collect(),
                    Err(error) => {
                        self.stage = Stage::Media(Box::new(phase));
                        return self.stopped(error);
                    }
                };
                for reference in page {
                    if missing.contains(&reference.name) {
                        phase.ready.push_back(reference);
                    } else {
                        self.acked.insert(reference.name);
                    }
                }
            }
            if phase.ready.is_empty() {
                self.stage = Stage::Media(Box::new(phase));
                return Ok(Step::Worked);
            }
        }
        let mut frames: Vec<Outgoing> = Vec::new();
        let mut sent: Vec<Ref> = Vec::new();
        let mut bytes = 0_u64;
        while let Some(reference) = phase.ready.front().copied() {
            if frames.len() >= BUNDLE_MAX_FRAMES
                || (bytes >= BUNDLE_TARGET_BYTES && !frames.is_empty())
            {
                break;
            }
            phase.ready.pop_front();
            let Some(object) = self.env.rebuild(&reference, &phase.lookup)? else {
                // The bytes are not there to read (or changed under their name): this chunk waits,
                // and the phase cannot say it is whole.
                phase.skipped += 1;
                self.stats.waiting += 1;
                continue;
            };
            bytes += object.len() as u64;
            frames.push(Outgoing {
                name: reference.name,
                digest: reference.digest,
                bytes: object,
            });
            sent.push(reference);
        }
        if frames.is_empty() {
            self.stage = Stage::Media(Box::new(phase));
            return Ok(Step::Worked);
        }
        match self.send(&frames, &sent, true) {
            Ok(Sent::Done(retry)) => {
                for reference in retry.into_iter().rev() {
                    phase.ready.push_front(reference);
                }
                self.stage = Stage::Media(Box::new(phase));
                Ok(Step::Worked)
            }
            Ok(Sent::Stop(step)) => Ok(step),
            Err(error) => Err(error),
        }
    }

    fn media_done(&mut self, phase: MediaPhase) -> Result<Step> {
        if phase.skipped == 0 {
            match phase.class {
                Class::Thumbnails => {
                    self.env.state.confirm_thumbnails(
                        &self.id,
                        &self.target.name,
                        self.env.now_ms,
                    )?;
                }
                _ => {
                    self.env.state.confirm_originals(
                        &self.id,
                        &self.target.name,
                        self.env.now_ms,
                    )?;
                }
            }
        }
        match phase.class {
            Class::Thumbnails => self.enter_media(Class::Originals),
            _ => {
                self.stage = Stage::Finished;
                Ok(Step::Done)
            }
        }
    }
}

enum Sent {
    /// The bundle was answered; these refs go round again.
    Done(Vec<Ref>),
    Stop(Step),
}

// ─── the scheduler ──────────────────────────────────────────────────────────

/// One scheduler over every gateway's debt, by class: records of every gateway before thumbnails
/// of any, before originals of any; round robin between gateways inside a class (§6.3).
pub struct Scheduler<'e, 's> {
    pub passes: Vec<GatewayPass<'e, 's>>,
    turn: usize,
    steps: usize,
    /// Calls a window allows: a chunk is read and sealed once per window.
    pub window_calls: usize,
}

impl<'e, 's> Scheduler<'e, 's> {
    /// A scheduler over `passes`.
    #[must_use]
    pub const fn new(passes: Vec<GatewayPass<'e, 's>>, window_calls: usize) -> Self {
        Self {
            passes,
            turn: 0,
            steps: 0,
            window_calls,
        }
    }

    /// Run one step of the pass the rule says goes next. `false` when nothing is left to run.
    ///
    /// # Errors
    /// What [`GatewayPass::step`] refuses.
    pub fn tick(&mut self) -> Result<bool> {
        let Some(first) = self.passes.first() else {
            return Ok(false);
        };
        let env = first.env;
        if self.window_calls > 0 && self.steps.is_multiple_of(self.window_calls) {
            env.new_window();
        }
        let recheck = head_recheck_every(self.passes.len(), self.window_calls.max(1));
        if self.steps > 0
            && self
                .steps
                .is_multiple_of(recheck * self.window_calls.max(1))
        {
            for pass in &mut self.passes {
                pass.recheck_head()?;
            }
        }
        // The lowest class owed by any pass whose rule allows it; the next pass in turn within it.
        let owed = |pass: &GatewayPass<'_, '_>| -> Option<Class> {
            pass.next_class()
                .filter(|class| env.policy.allows(*class, false))
        };
        let best = self.passes.iter().filter_map(owed).min();
        let Some(best) = best else {
            return Ok(false);
        };
        let count = self.passes.len();
        for offset in 0..count {
            let index = (self.turn + offset) % count;
            if owed(&self.passes[index]) == Some(best) {
                self.turn = index + 1;
                self.steps += 1;
                self.passes[index].step()?;
                return Ok(true);
            }
        }
        Ok(false)
    }

    /// Run until nothing is left to run, or `limit` steps.
    ///
    /// # Errors
    /// What [`Self::tick`] refuses.
    pub fn run(&mut self, limit: usize) -> Result<usize> {
        let mut ran = 0;
        while ran < limit && self.tick()? {
            ran += 1;
        }
        Ok(ran)
    }
}

// ─── status ─────────────────────────────────────────────────────────────────

/// What a gateway holds, as the Backup line says it (§6.6).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Standing {
    /// Records are backed up there: `conf` is the newest snapshot, and when it was confirmed.
    pub records: Option<u64>,
    /// Thumbnails whole: `troot` equals `conf`'s root.
    pub thumbnails: bool,
    /// Originals whole: `oroot` equals `conf`'s root.
    pub originals: bool,
}

/// The standing of one gateway against `newest`.
///
/// # Errors
/// The state's refusal.
pub fn standing(state: &DeviceState, gateway_id: &str) -> Result<Standing> {
    let gateway = state
        .gateway(gateway_id)?
        .ok_or_else(|| invariant("an unpaired gateway has no standing"))?;
    let conf = gateway.conf;
    Ok(Standing {
        records: conf.map(|(_, at)| at),
        thumbnails: conf.is_some_and(|(name, _)| gateway.troot.map(|(root, _)| root) == Some(name)),
        originals: conf.is_some_and(|(name, _)| gateway.oroot.map(|(root, _)| root) == Some(name)),
    })
}

/// R4: whether a gateway holds the original `h` whole: every chunk of it reachable from `oroot`
/// there.
///
/// # Errors
/// The state's refusal, or a missing node.
pub fn held_whole(env: &Env<'_>, gateway_id: &str, h: &PlaintextHash) -> Result<bool> {
    let Some(gateway) = env.state.gateway(gateway_id)? else {
        return Ok(false);
    };
    let Some((oroot, _)) = gateway.oroot else {
        return Ok(false);
    };
    let Some(reference) = env.node_ref(&oroot)? else {
        return Ok(false);
    };
    let root = tree::root_of(env.state, &reference)?;
    let entry = tree::lookup_entry(env.state, &root.blobs, h)?;
    Ok(entry.is_some_and(|e| e.kind == tree::EntryKind::Original && e.has_bytes()))
}

/// Which gateways hold the original `h` whole (R4 asks whether this is any).
///
/// # Errors
/// As [`held_whole`].
pub fn holders(env: &Env<'_>, h: &PlaintextHash) -> Result<Vec<String>> {
    let mut out = Vec::new();
    for gateway in env.state.gateways()? {
        if held_whole(env, &gateway.gateway_id, h)? {
            out.push(gateway.gateway_id);
        }
    }
    Ok(out)
}

/// What a gateway is owed, from the trees alone (no network): objects of each class.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Debt {
    pub records: u64,
    pub thumbnails: u64,
    pub originals: u64,
}

/// What `gateway_id` is owed against the newest snapshot, counting objects.
///
/// # Errors
/// The state's refusal.
pub fn debt(env: &Env<'_>, gateway_id: &str) -> Result<Debt> {
    let Some(newest) = env.newest()? else {
        return Ok(Debt::default());
    };
    let Some(gateway) = env.state.gateway(gateway_id)? else {
        return Ok(Debt::default());
    };
    let held_tree = |root: Option<(Name, u64)>| -> Result<Option<Ref>> {
        match root {
            Some((name, _)) => env.node_ref(&name),
            None => Ok(None),
        }
    };
    let mut out = Debt::default();
    if gateway.conf.map(|(name, _)| name) == Some(newest.name) {
        out.records = 0;
    } else {
        let new_records = tree::records_of(env.state, &newest)?;
        let old_records: BTreeSet<Name> = match held_tree(gateway.conf)? {
            Some(reference) => tree::records_of(env.state, &reference)
                .map(|refs| refs.into_keys().collect())
                .unwrap_or_default(),
            None => BTreeSet::new(),
        };
        out.records = new_records
            .keys()
            .filter(|name| !old_records.contains(name))
            .count() as u64;
    }
    let mut new_root: Option<tree::Root> = None;
    for (class, root_ptr) in [
        (Class::Thumbnails, gateway.troot),
        (Class::Originals, gateway.oroot),
    ] {
        let owed = if root_ptr.map(|(name, _)| name) == Some(newest.name) {
            0
        } else {
            let new_blobs = match &new_root {
                Some(root) => root.blobs,
                None => {
                    let root = tree::root_of(env.state, &newest)?;
                    let blobs = root.blobs;
                    new_root = Some(root);
                    blobs
                }
            };
            let old_ref = held_tree(root_ptr)?;
            let old_root = old_ref
                .as_ref()
                .and_then(|reference| tree::root_of(env.state, reference).ok());
            if old_root.as_ref().is_some_and(|old| {
                old.blobs.name == new_blobs.name
                    || tree::diff_entries(env.state, Some(&old.blobs), &new_blobs)
                        .is_ok_and(|diff| diff.is_empty())
            }) {
                0
            } else {
                let held: BTreeSet<Name> = match old_ref {
                    Some(reference) => tree::media_of(env.state, &reference, class)
                        .map(|refs| refs.into_keys().collect())
                        .unwrap_or_default(),
                    None => BTreeSet::new(),
                };
                tree::media_of(env.state, &newest, class)?
                    .keys()
                    .filter(|name| !held.contains(name))
                    .count() as u64
            }
        };
        match class {
            Class::Thumbnails => out.thumbnails = owed,
            _ => out.originals = owed,
        }
    }
    Ok(out)
}

// ─── OS background (§6.5) ───────────────────────────────────────────────────

/// One bundle file the shell hands to the OS background session.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OsBundle {
    pub path: std::path::PathBuf,
    pub names: Vec<Name>,
    pub bytes: u64,
    /// Whether this bundle carries any video original frame (never allowed over cellular).
    pub has_video: bool,
}

/// The OS says a background task finished, failed or was lost. **It only wakes a pass** (R7): the
/// pass re-reads the head and diffs, and nothing here records anything as stored.
pub const fn os_event_wakes_a_pass() -> bool {
    true
}

/// Write up to [`OS_BUNDLES`] bundle files of at most [`OS_BUNDLE_BYTES`] for the chunks of `class`
/// the gateway lacks (an `exists` first), into staging, for the shell to hand to the OS. The files
/// are in the gateway's own bundle framing, so the shell uploads them as the `POST bundle` body.
///
/// # Errors
/// The store's, staging's or state's refusal.
pub fn write_os_bundles(env: &Env<'_>, store: &dyn Store, class: Class) -> Result<Vec<OsBundle>> {
    let (bundles, staging_full) = write_os_bundles_capped(env, store, class, OS_BUNDLES)?;
    if staging_full && bundles.is_empty() {
        return Err(PlaneError::StagingFull);
    }
    Ok(bundles)
}

/// Like [`write_os_bundles`], but writes at most `max_bundles` files and treats
/// [`PlaneError::StagingFull`] as "no more bundles this pass", returning the bundles already
/// written alongside a flag indicating staging ran out of room. Each written bundle is recorded
/// in `os_bundle` immediately (not `staged`) so housekeeping leaves it alone while the OS reads
/// it and a crash cannot leak it against the staging budget.
///
/// Video original frames are packed separately from non-video frames so a bundle carrying video
/// never rides with `allows_cellular = true` and never prevents photos from using cellular.
///
/// # Errors
/// The store's, staging's (other than [`PlaneError::StagingFull`]) or state's refusal.
pub fn write_os_bundles_capped(
    env: &Env<'_>,
    store: &dyn Store,
    class: Class,
    max_bundles: usize,
) -> Result<(Vec<OsBundle>, bool)> {
    use centraid_gateway::rules::bundle::{self, Frame};
    if max_bundles == 0 {
        return Ok((Vec::new(), false));
    }
    let Some(target) = env.newest()? else {
        return Ok((Vec::new(), false));
    };
    let root = tree::root_of(env.state, &target)?;
    let entries = tree::entries_of(env.state, &root.blobs)?;
    let mut ordered: Vec<&Entry> = entries.iter().collect();
    ordered.sort_by_key(|entry| (std::cmp::Reverse(entry.taken_at_ms), entry.h));
    let mut lookup = BTreeMap::new();
    let mut non_video: Vec<Ref> = Vec::new();
    let mut video_chunks: Vec<Ref> = Vec::new();
    for entry in ordered {
        let is_video = class == Class::Originals && video_of(entry);
        if class == Class::Originals && !env.policy.allows(class, is_video) {
            continue;
        }
        let bucket = if is_video {
            &mut video_chunks
        } else {
            &mut non_video
        };
        for (index, reference) in entry.refs(class).iter().enumerate() {
            lookup.insert(reference.name, (entry.h, index as u64));
            bucket.push(*reference);
        }
    }
    let names: Vec<Name> = non_video
        .iter()
        .chain(&video_chunks)
        .map(|chunk| chunk.name)
        .collect();
    let mut missing: BTreeSet<Name> = BTreeSet::new();
    for batch in names.chunks(NAMES_PER_CALL) {
        missing.extend(store.exists(batch)?);
    }
    let mut out: Vec<OsBundle> = Vec::new();
    let mut frames: Vec<Frame> = Vec::new();
    let mut listed: Vec<Name> = Vec::new();
    let mut bytes = 0_u64;
    let mut staging_full = false;
    let flush = |frames: &mut Vec<Frame>,
                 listed: &mut Vec<Name>,
                 bytes: &mut u64,
                 has_video: bool,
                 out: &mut Vec<OsBundle>|
     -> Result<bool> {
        if frames.is_empty() {
            return Ok(true);
        }
        let body = bundle::encode(frames);
        let mut hasher = blake3::Hasher::new();
        for name in listed.iter() {
            hasher.update(name.as_bytes());
        }
        let file_name = Name::from_bytes(*hasher.finalize().as_bytes());
        let path = match env.staging.put(&file_name, &body) {
            Ok(path) => path,
            Err(PlaneError::StagingFull) => {
                frames.clear();
                listed.clear();
                *bytes = 0;
                return Ok(false);
            }
            Err(error) => return Err(error),
        };
        env.state
            .put_os_bundle(&file_name, &path.to_string_lossy())?;
        out.push(OsBundle {
            path,
            names: std::mem::take(listed),
            bytes: body.len() as u64,
            has_video,
        });
        frames.clear();
        *bytes = 0;
        Ok(true)
    };
    for (chunks, has_video) in [(non_video, false), (video_chunks, true)] {
        if staging_full || out.len() >= max_bundles {
            break;
        }
        for chunk in chunks {
            if !missing.contains(&chunk.name) {
                continue;
            }
            let Some(object) = env.rebuild(&chunk, &lookup)? else {
                continue;
            };
            if bytes + object.len() as u64 > OS_BUNDLE_BYTES
                && !frames.is_empty()
                && !flush(&mut frames, &mut listed, &mut bytes, has_video, &mut out)?
            {
                staging_full = true;
                break;
            }
            if out.len() >= max_bundles {
                break;
            }
            bytes += object.len() as u64;
            listed.push(chunk.name);
            frames.push(Frame::of(
                centraid_gateway::rules::ids::Name::from_bytes(*chunk.name.as_bytes()),
                object,
            ));
        }
        if !staging_full
            && out.len() < max_bundles
            && !flush(&mut frames, &mut listed, &mut bytes, has_video, &mut out)?
        {
            staging_full = true;
        }
    }
    Ok((out, staging_full))
}

// ─── read-back (E10) ────────────────────────────────────────────────────────

/// What a read-back found.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ReadBack {
    /// Chunks read and opened.
    pub read: u64,
    /// Names that were gone, would not open, or were not what the tree lists.
    pub damaged: Vec<Name>,
    /// The population drawn from.
    pub population: u64,
}

/// Draw `k` indices below `n` with the keyed draw of E10 (no clock): the counter and the keys pin it.
#[must_use]
pub fn draw(keys: &BackupKeys, counter: u64, n: u64, k: usize) -> Vec<u64> {
    if n == 0 {
        return Vec::new();
    }
    let sample_key = blake3::derive_key("centraid backup v2 sample", keys.k_backup());
    let mut out: Vec<u64> = Vec::new();
    let mut at = 0_u64;
    while out.len() < k.min(usize::try_from(n).unwrap_or(usize::MAX)) {
        let mut preimage = counter.to_be_bytes().to_vec();
        preimage.extend_from_slice(&at.to_be_bytes());
        let hash = blake3::keyed_hash(&sample_key, &preimage);
        let mut first = [0_u8; 8];
        first.copy_from_slice(&hash.as_bytes()[..8]);
        let index = u64::from_be_bytes(first) % n;
        at += 1;
        if !out.contains(&index) {
            out.push(index);
        }
    }
    out
}

/// Read back what `gateway_id` is claimed to hold: a keyed random sample (E10) plus a walk of
/// [`SCRUB_NAMES`] names in order, over the chunks of the tree at `conf` that the gateway's
/// confirmed roots say it holds. A chunk that is gone or will not open is checked at the gateway
/// (so it is marked damaged and a signed delete frees it) and **every claim for that gateway is
/// withdrawn**: the next pass is a recovery pass.
///
/// # Errors
/// The state's refusal. A store error that is not an answer about an object is returned.
pub fn read_back(env: &Env<'_>, store: &dyn Store) -> Result<ReadBack> {
    let id = store.gateway_id().to_owned();
    let Some(gateway) = env.state.gateway(&id)? else {
        return Ok(ReadBack::default());
    };
    let Some((conf, _)) = gateway.conf else {
        return Ok(ReadBack::default());
    };
    let Some(reference) = env.node_ref(&conf)? else {
        return Ok(ReadBack::default());
    };
    let mut population: BTreeMap<Name, Ref> = tree::records_of(env.state, &reference)?;
    if gateway.troot.map(|(name, _)| name) == Some(conf) {
        population.extend(tree::media_of(env.state, &reference, Class::Thumbnails)?);
    }
    if gateway.oroot.map(|(name, _)| name) == Some(conf) {
        population.extend(tree::media_of(env.state, &reference, Class::Originals)?);
    }
    let all: Vec<Ref> = population.values().copied().collect();
    let k = match env.policy.link {
        Link::Unmetered => SAMPLE_CHUNKS,
        Link::Metered => SAMPLE_CHUNKS_METERED,
    };
    let mut chosen: BTreeSet<usize> = draw(env.keys, gateway.sample_counter, all.len() as u64, k)
        .into_iter()
        .map(|index| usize::try_from(index).unwrap_or(0))
        .collect();
    // The scrub walk: the next names after the cursor, wrapping.
    let start = gateway
        .scrub_cursor
        .map_or(0, |cursor| all.partition_point(|r| r.name <= cursor));
    let mut last = gateway.scrub_cursor;
    for offset in 0..SCRUB_NAMES.min(all.len()) {
        let index = (start + offset) % all.len();
        chosen.insert(index);
        last = Some(all[index].name);
    }
    let mut report = ReadBack {
        population: all.len() as u64,
        ..ReadBack::default()
    };
    for index in chosen {
        let chunk = &all[index];
        let mut object = Vec::new();
        let opened = match store.get(&chunk.name, &mut object) {
            Ok(_) => sealed::open(env.keys, chunk, &object).is_ok(),
            // A copy the destination serves off its own digest (the real client checks it on the
            // way in) is damaged exactly as one that will not open is.
            Err(StoreError::Missing(_) | StoreError::Damaged(_)) => false,
            Err(error) => return Err(error.into()),
        };
        report.read += 1;
        if !opened {
            report.damaged.push(chunk.name);
        }
    }
    env.state
        .set_sample_counter(&id, gateway.sample_counter + 1)?;
    if let Some(last) = last {
        env.state.set_scrub_cursor(&id, Some(&last))?;
    }
    if !report.damaged.is_empty() {
        for name in &report.damaged {
            // Mark it damaged at the gateway so a signed delete frees it at once. An unreachable
            // or refusing gateway changes nothing here: the claim is withdrawn either way.
            let _ = store.check_name(name);
        }
        env.state.withdraw(&id)?;
    }
    Ok(report)
}

// ─── staging and node housekeeping ──────────────────────────────────────────

/// Release staged bytes no gateway is still owed, and forget cached nodes no kept root needs.
///
/// A staged file is kept while the newest tree names it and some paired gateway has not confirmed
/// it; with no gateway paired everything staged for the newest tree is kept.
///
/// # Errors
/// The state's, staging's refusal.
pub fn housekeeping(env: &Env<'_>, extra_roots: &[Ref]) -> Result<(usize, usize)> {
    let mut released = 0;
    let newest = env.newest()?;
    let gateways = env.state.gateways()?;
    let mut needed: BTreeSet<Name> = BTreeSet::new();
    if let Some(newest) = &newest {
        let all_caught_up = !gateways.is_empty()
            && gateways.iter().all(|gateway| {
                gateway.conf.map(|(name, _)| name) == Some(newest.name)
                    && gateway.troot.map(|(name, _)| name) == Some(newest.name)
                    && gateway.oroot.map(|(name, _)| name) == Some(newest.name)
            });
        if !all_caught_up {
            let records = tree::records_of(env.state, newest)?;
            let thumbs = tree::media_of(env.state, newest, Class::Thumbnails)?;
            let originals = tree::media_of(env.state, newest, Class::Originals)?;
            let held_of =
                |root: Option<(Name, u64)>, class: Option<Class>| -> Result<BTreeSet<Name>> {
                    let Some((name, _)) = root else {
                        return Ok(BTreeSet::new());
                    };
                    let Some(reference) = env.node_ref(&name)? else {
                        return Ok(BTreeSet::new());
                    };
                    Ok(match class {
                        None => tree::records_of(env.state, &reference)
                            .map(|refs| refs.into_keys().collect())
                            .unwrap_or_default(),
                        Some(class) => tree::media_of(env.state, &reference, class)
                            .map(|refs| refs.into_keys().collect())
                            .unwrap_or_default(),
                    })
                };
            if gateways.is_empty() {
                needed.extend(records.keys().chain(thumbs.keys()).chain(originals.keys()));
            }
            for gateway in &gateways {
                let have = held_of(gateway.conf, None)?;
                needed.extend(records.keys().filter(|name| !have.contains(name)));
                let have = held_of(gateway.troot, Some(Class::Thumbnails))?;
                needed.extend(thumbs.keys().filter(|name| !have.contains(name)));
                let have = held_of(gateway.oroot, Some(Class::Originals))?;
                needed.extend(originals.keys().filter(|name| !have.contains(name)));
            }
        }
    }
    for staged in env.state.staged_all()? {
        if !needed.contains(&staged.name) {
            env.staging.release(&staged.name)?;
            env.state.unstage(&staged.name)?;
            released += 1;
        }
    }
    // Nodes: every root a gateway's pointers name, the newest, and the kept ones.
    let mut roots: Vec<Ref> = extra_roots.to_vec();
    roots.extend(newest);
    for gateway in &gateways {
        for pointer in [gateway.conf, gateway.troot, gateway.oroot]
            .into_iter()
            .flatten()
        {
            if let Some(reference) = env.node_ref(&pointer.0)? {
                roots.push(reference);
            }
        }
    }
    let mut keep: BTreeSet<Name> = BTreeSet::new();
    for root in &roots {
        let _ = tree::collect_nodes_into(env.state, root, &mut keep);
    }
    let forgotten = env.state.forget_nodes_except(&keep)?;
    Ok((released, forgotten))
}

// ─── errors from outside the module ─────────────────────────────────────────

impl PlaneError {
    /// Whether this refusal is the destination being unreachable rather than a fault here.
    #[must_use]
    pub const fn is_unreachable(&self) -> bool {
        matches!(
            self,
            Self::Store(StoreError::Unreachable(_) | StoreError::Io(_))
        )
    }
}

/// Re-exported for callers that delete by hand.
pub type DeleteAnswer = Deleted;
