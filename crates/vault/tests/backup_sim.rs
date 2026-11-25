//! The simulation (spec §8, #1209, L7): a seeded, deterministic run of the real engine against
//! the real gateway rules (`MemoryStore`) behind a fault-injecting store, with the invariants of
//! §8 checked as it goes, and every planted bug proved to be caught.
//!
//! **The world.** One phone with a vault (notes, photos), two gateways, and sometimes a second
//! vault on the first gateway. Each step is chosen from the seed: edit the vault, take a snapshot
//! (days apart), run the engine for a few ticks (a kill at any point), read back, collect, or a
//! fault: a bundle cut at or inside a frame, a duplicated or reordered request, `BUSY`,
//! unreachable, disk full, bit rot, a gateway rolled back, the phone killed with its state lost,
//! a lying OS report, a checkpoint made outside the core.
//!
//! **The invariants**, checked after steps:
//!
//! - *Truthful status.* When the engine newly confirms `conf`, `troot` or `oroot`, everything it
//!   vouched for is held and intact there (A1). A claim a fault made false is withdrawn within a
//!   bounded number of rounds (A2). A root a full read made, or one no outside checkpoint
//!   clouded, restores to exactly the vault as it was when it was taken (A3).
//! - *The commit rule.* No head is set while a record of its root is missing.
//! - *Never delete needed data.* No delete removes a name reachable from the head or a claimed root.
//! - *Convergence.* With the faults off every gateway reaches the newest root in a bounded number
//!   of rounds.
//! - *Bounded work.* A one-page edit stores 3 objects and makes 0 `exists` calls; a new photo of k
//!   chunks stores at most k + 5.
//! - *Vault scope.* Two vaults on one gateway share no name and no connection, and one's actions
//!   change nothing of the other's.
//!
//! Counts only, never durations. `CENTRAID_SIM_SEEDS=2000` runs more seeds than the default.

mod backup_support;

use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet};
use std::panic::AssertUnwindSafe;
use std::rc::Rc;

use backup_support::{Rig, T0};
use centraid_media::sealed::{BackupKeys, Class, Digest, Name, Ref};
use centraid_vault::Vault;
use centraid_vault::backup::drill::dump;
use centraid_vault::backup::engine::{self, Bugs, Env, GatewayPass, Policy, Scheduler};
use centraid_vault::backup::restore::Restore;
use centraid_vault::backup::retention;
use centraid_vault::backup::snapshot::{FULL_EVERY, Options};
use centraid_vault::backup::store::{
    Checkpoint, Deleted, FrameAnswer, Head, HeldEntry, MemoryStore, NameCheck, ObjectEntry,
    Outgoing, Refusal, SnapshotEntry, Store, StoreError,
};
use centraid_vault::backup::tree;

const DAY: u64 = 24 * 60 * 60 * 1000;

// ─── the seed ───────────────────────────────────────────────────────────────

struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    }

    fn below(&mut self, n: u64) -> u64 {
        self.next() % n.max(1)
    }

    fn chance(&mut self, one_in: u64) -> bool {
        self.below(one_in) == 0
    }
}

// ─── the planted bugs ───────────────────────────────────────────────────────

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Bug {
    None,
    AckTaken,
    TrustOs,
    SkipHeadCheck,
    NoFullRead,
    GatewayCommitsTruncatedFrame,
    HeadBeforeRecords,
    UnboundDelete,
    OneKeyForTwoVaults,
    NamespaceNotScopedPerVault,
}

impl Bug {
    const ALL: [Self; 9] = [
        Self::AckTaken,
        Self::TrustOs,
        Self::SkipHeadCheck,
        Self::NoFullRead,
        Self::GatewayCommitsTruncatedFrame,
        Self::HeadBeforeRecords,
        Self::UnboundDelete,
        Self::OneKeyForTwoVaults,
        Self::NamespaceNotScopedPerVault,
    ];

    fn engine(self) -> Bugs {
        Bugs {
            ack_taken: self == Self::AckTaken,
            trust_os: self == Self::TrustOs,
            skip_head_check: self == Self::SkipHeadCheck,
            no_full_read: self == Self::NoFullRead,
            head_before_records: self == Self::HeadBeforeRecords,
            unbound_delete: self == Self::UnboundDelete,
        }
    }
}

// ─── the faulty gateway ─────────────────────────────────────────────────────

#[derive(Clone, Copy, Debug)]
enum Cut {
    AtFrame(usize),
    InsideFrame(usize),
}

#[derive(Default)]
struct Faults {
    cut: Option<Cut>,
    duplicate: bool,
    reorder: bool,
    busy: u32,
    unreachable: u32,
    disk_full: u32,
    /// The gateway's data directory comes back from a backup the first time it is listed.
    rollback_on_list: Option<Checkpoint>,
    /// THE PLANTED GATEWAY BUGS.
    commits_truncated_frame: bool,
    ignores_head_binding: bool,
    violations: Vec<String>,
}

/// What the phone knows about every tree it ever took, for the invariants.
#[derive(Default)]
struct World {
    nodes: BTreeMap<Name, Vec<u8>>,
    records: BTreeMap<Name, Vec<Name>>,
    everything: BTreeMap<Name, BTreeSet<Name>>,
    /// The digest every name has, from every tree ever taken: names are content, so one each.
    digests: BTreeMap<Name, Digest>,
    /// Debugging: every name a delete held, with the head it was bound to.
    deleted: BTreeMap<Name, String>,
}

type Shared<T> = Rc<RefCell<T>>;

struct Faulty {
    inner: MemoryStore,
    /// The planted "namespace not scoped" bug routes this store's calls to another vault's.
    misrouted: Option<MemoryStore>,
    faults: Shared<Faults>,
    world: Shared<World>,
    claimed: Shared<BTreeMap<String, Vec<Name>>>,
    watch: bool,
}

impl Faulty {
    fn target(&self) -> &MemoryStore {
        self.misrouted.as_ref().unwrap_or(&self.inner)
    }

    fn gate(&self) -> Result<(), StoreError> {
        let mut faults = self.faults.borrow_mut();
        if faults.unreachable > 0 {
            faults.unreachable -= 1;
            return Err(StoreError::Unreachable("the gateway is down".to_owned()));
        }
        if faults.busy > 0 {
            faults.busy -= 1;
            return Err(StoreError::Refused(Refusal::Busy));
        }
        Ok(())
    }

    fn violation(&self, text: String) {
        self.faults.borrow_mut().violations.push(text);
    }
}

fn traced(name: &Name) -> bool {
    std::env::var("CENTRAID_SIM_TRACE").is_ok_and(|prefix| name.to_hex().starts_with(&prefix))
}

impl Store for Faulty {
    fn gateway_id(&self) -> &str {
        self.inner.gateway_id()
    }

    fn exists(&self, names: &[Name]) -> Result<Vec<Name>, StoreError> {
        self.gate()?;
        let out = self.target().exists(names);
        if let Ok(missing) = &out {
            for name in names.iter().filter(|name| traced(name)) {
                eprintln!(
                    "TRACE {} exists({name}) -> missing={}",
                    self.inner.gateway_id(),
                    missing.contains(name)
                );
            }
        }
        out
    }

    fn bundle(&self, parts: &[Outgoing]) -> Result<Vec<(Name, FrameAnswer)>, StoreError> {
        self.gate()?;
        let (cut, duplicate, reorder, full, truncating) = {
            let mut faults = self.faults.borrow_mut();
            let full = faults.disk_full > 0;
            if full {
                faults.disk_full -= 1;
            }
            (
                faults.cut.take(),
                std::mem::take(&mut faults.duplicate),
                std::mem::take(&mut faults.reorder),
                full,
                faults.commits_truncated_frame,
            )
        };
        if full {
            return Ok(parts
                .iter()
                .map(|part| (part.name, FrameAnswer::Full))
                .collect());
        }
        match cut {
            Some(Cut::AtFrame(at)) => {
                let at = at.min(parts.len());
                if at > 0 {
                    self.target().bundle(&parts[..at])?;
                }
                return Err(StoreError::Unreachable("the connection dropped".to_owned()));
            }
            Some(Cut::InsideFrame(at)) if at < parts.len() => {
                if at > 0 {
                    self.target().bundle(&parts[..at])?;
                }
                if truncating {
                    // THE PLANTED BUG: the gateway commits the half of the frame it received,
                    // under the digest of what it received.
                    let half = parts[at].bytes[..parts[at].bytes.len() / 2].to_vec();
                    self.target()
                        .bundle(&[Outgoing::of(parts[at].name, half)])?;
                }
                return Err(StoreError::Unreachable(
                    "the connection dropped mid-frame".to_owned(),
                ));
            }
            _ => {}
        }
        let mut frames: Vec<Outgoing> = parts.to_vec();
        if reorder {
            frames.reverse();
        }
        let first = self.target().bundle(&frames)?;
        for (name, answer) in first.iter().filter(|(name, _)| traced(name)) {
            eprintln!(
                "TRACE {} bundle({name}) -> {answer:?}",
                self.inner.gateway_id()
            );
        }
        if duplicate {
            return self.target().bundle(&frames);
        }
        Ok(first)
    }

    fn get(&self, name: &Name, sink: &mut dyn std::io::Write) -> Result<u64, StoreError> {
        self.gate()?;
        self.target().get(name, sink)
    }

    fn check_name(&self, name: &Name) -> Result<NameCheck, StoreError> {
        self.gate()?;
        self.target().check_name(name)
    }

    fn head(&self) -> Result<Option<Head>, StoreError> {
        self.gate()?;
        self.target().head()
    }

    fn generation(&self) -> u64 {
        self.target().generation()
    }

    fn set_head(
        &self,
        name: &Name,
        prev: Option<&Name>,
        at: u64,
        writes: u64,
    ) -> Result<Head, StoreError> {
        self.gate()?;
        // THE COMMIT RULE, judged from outside: every record of the root is held.
        let records = self.world.borrow().records.get(name).cloned();
        if let (Some(records), true) = (records, self.watch) {
            let missing = self.target().exists(&records)?;
            if !missing.is_empty() {
                self.violation(format!(
                    "commit rule: the head was set to {name} with {} of its records missing",
                    missing.len()
                ));
            }
        }
        self.target().set_head(name, prev, at, writes)
    }

    fn snapshots(&self) -> Result<Vec<SnapshotEntry>, StoreError> {
        self.gate()?;
        self.target().snapshots()
    }

    fn list(&self, after: Option<&Name>, limit: usize) -> Result<Vec<ObjectEntry>, StoreError> {
        self.gate()?;
        if let Some(checkpoint) = self.faults.borrow_mut().rollback_on_list.take() {
            if std::env::var_os("CENTRAID_SIM_TRACE").is_some() {
                eprintln!("TRACE {} ROLLED BACK at list", self.inner.gateway_id());
            }
            self.target().roll_back(&checkpoint);
        }
        self.target().list(after, limit)
    }

    fn delete(&self, names: &[Name], head_root: Option<&Name>) -> Result<Deleted, StoreError> {
        self.gate()?;
        let bound = if self.faults.borrow().ignores_head_binding {
            // THE PLANTED BUG: a gateway that does not enforce the head a delete names.
            self.target().head()?.map(|head| head.name)
        } else {
            head_root.copied()
        };
        let answer = self.target().delete(names, bound.as_ref())?;
        for name in names.iter().filter(|name| traced(name)) {
            eprintln!(
                "TRACE {} delete({name}) deleted={} freed={}",
                self.inner.gateway_id(),
                answer.deleted.contains(name),
                answer.freed.contains(name)
            );
        }
        if self.watch {
            let mut world = self.world.borrow_mut();
            for name in &answer.deleted {
                world.deleted.insert(
                    *name,
                    format!("bound to {bound:?} on {}", self.inner.gateway_id()),
                );
            }
        }
        if self.watch {
            let world = self.world.borrow();
            let mut roots: Vec<Name> = self
                .claimed
                .borrow()
                .get(self.inner.gateway_id())
                .cloned()
                .unwrap_or_default();
            roots.extend(self.target().head()?.map(|head| head.name));
            for root in roots {
                let Some(reach) = world.everything.get(&root) else {
                    continue;
                };
                for name in &answer.deleted {
                    if reach.contains(name) {
                        self.violation(format!(
                            "a delete removed {name}, which the root {root} reaches"
                        ));
                    }
                }
            }
        }
        Ok(answer)
    }

    fn held(&self, after: Option<&Name>, limit: usize) -> Result<Vec<HeldEntry>, StoreError> {
        self.target().held(after, limit)
    }

    fn undo(&self, names: Option<&[Name]>) -> Result<u64, StoreError> {
        self.gate()?;
        self.target().undo(names)
    }
}

// ─── the world ──────────────────────────────────────────────────────────────

type Dump = BTreeMap<String, Vec<String>>;

struct Second {
    rig: Rig,
    inner: MemoryStore,
    store: Faulty,
}

struct Sim {
    bug: Bug,
    rng: Rng,
    rig: Rig,
    faults: Shared<Faults>,
    world: Shared<World>,
    claimed: Shared<BTreeMap<String, Vec<Name>>>,
    inner: Vec<MemoryStore>,
    stores: Vec<Faulty>,
    checkpoints: Vec<Option<Checkpoint>>,
    clock: u64,
    dumps: BTreeMap<Name, Dump>,
    exact: BTreeMap<Name, bool>,
    newest: Option<Name>,
    tainted: bool,
    since_taint: u64,
    /// Names the harness corrupted or lost on a gateway and the engine has not yet mended.
    damaged: Vec<BTreeSet<Name>>,
    stale: Vec<u32>,
    lie_about_the_os: bool,
    second: Option<Second>,
    violations: Vec<String>,
    log: Vec<String>,
    last_round: String,
    last_snapshot: String,
    last_ranges_new: u64,
    last_was_catch_up: bool,
}

fn claims_of(rig: &Rig, id: &str) -> [Option<Name>; 3] {
    let gateway = rig.state.gateway(id).expect("reads").expect("paired");
    [
        gateway.conf.map(|(name, _)| name),
        gateway.troot.map(|(name, _)| name),
        gateway.oroot.map(|(name, _)| name),
    ]
}

impl Sim {
    fn new(seed: u64, bug: Bug) -> Self {
        let rig = Rig::new(&format!("sim-{seed}"));
        let faults: Shared<Faults> = Rc::default();
        faults.borrow_mut().commits_truncated_frame = bug == Bug::GatewayCommitsTruncatedFrame;
        faults.borrow_mut().ignores_head_binding = bug == Bug::UnboundDelete;
        let world: Shared<World> = Rc::default();
        let claimed: Shared<BTreeMap<String, Vec<Name>>> = Rc::default();
        let inner: Vec<MemoryStore> = ["alpha", "beta"]
            .into_iter()
            .map(|id| {
                let store = MemoryStore::new(&format!("{id}-{seed}"));
                store.set_clock_ms(T0 * 20);
                rig.pair(&store);
                store
            })
            .collect();
        let stores = inner
            .iter()
            .map(|store| Faulty {
                inner: store.clone(),
                misrouted: None,
                faults: Rc::clone(&faults),
                world: Rc::clone(&world),
                claimed: Rc::clone(&claimed),
                watch: true,
            })
            .collect();
        let count = inner.len();
        let mut sim = Self {
            bug,
            rng: Rng(seed ^ 0x5eed_5eed_5eed_5eed),
            rig,
            faults,
            world,
            claimed,
            inner,
            stores,
            checkpoints: vec![None; count],
            clock: T0,
            dumps: BTreeMap::new(),
            exact: BTreeMap::new(),
            newest: None,
            tainted: false,
            since_taint: 0,
            damaged: vec![BTreeSet::new(); count],
            stale: vec![0; count],
            lie_about_the_os: false,
            second: None,
            violations: Vec::new(),
            log: Vec::new(),
            last_round: String::new(),
            last_snapshot: String::new(),
            last_ranges_new: 0,
            last_was_catch_up: false,
        };
        sim.rig.grow(25, "sim");
        sim.add_photo(1);
        sim.snapshot();
        sim
    }

    fn fail(&mut self, text: String) {
        if self.violations.len() < 6 {
            self.violations.push(text);
        }
    }

    fn collect_gateway_violations(&mut self) {
        let found = std::mem::take(&mut self.faults.borrow_mut().violations);
        for text in found {
            self.fail(text);
        }
    }

    // ── what a member does ──

    fn add_photo(&mut self, chunks: usize) {
        self.add_photo_of(chunks, true);
    }

    fn add_photo_of(&mut self, chunks: usize, with_thumbnail: bool) {
        let seed = self.rng.next();
        let mut bytes = vec![0_u8; 40_000 + usize::try_from(self.rng.below(20_000)).unwrap_or(0)];
        blake3::Hasher::new()
            .update(&seed.to_be_bytes())
            .finalize_xof()
            .fill(&mut bytes);
        if chunks > 1 {
            bytes = vec![0_u8; 4 * 1024 * 1024 * (chunks - 1) + 100_000];
            blake3::Hasher::new()
                .update(&seed.to_be_bytes())
                .finalize_xof()
                .fill(&mut bytes);
        }
        let original = self.rig.add_original(&bytes);
        let day = 1 + self.rng.below(27);
        if !with_thumbnail {
            return;
        }
        self.rig.add_thumbnail(
            &original,
            format!("thumbnail {seed}").as_bytes(),
            &format!("2026-03-{day:02}T09:00:00.000Z"),
        );
    }

    fn edit(&mut self) {
        match self.rng.below(4) {
            0 => {
                let n = self.rng.next();
                backup_support::common::insert_note(self.rig.vault(), &format!("note {n}"))
                    .expect("commits");
            }
            1 => {
                self.rig
                    .raw()
                    .execute("UPDATE vault SET writes = writes + 1", [])
                    .expect("one page");
            }
            2 => self.add_photo(1),
            _ => self.rig.grow(3, "grow"),
        }
    }

    // ── the phone ──

    fn snapshot(&mut self) {
        self.snapshot_as(false);
    }

    fn snapshot_as(&mut self, restage_all: bool) {
        if self.rng.chance(2) {
            self.clock += self.rng.below(7) * DAY;
        }
        self.clock += 1_000;
        let mut options = Options::at(self.clock);
        options.bugs = self.bug.engine();
        options.restage_all = restage_all;
        let taken = centraid_vault::backup::snapshot::take(
            self.rig.vault(),
            &self.rig.keys,
            &self.rig.state,
            &self.rig.staging,
            &self.rig.directory,
            options,
        )
        .expect("a snapshot is taken");
        let root = taken.root.name;
        let was_tainted = self.tainted;
        {
            let mut world = self.world.borrow_mut();
            for name in tree::nodes_of(&self.rig.state, &taken.root).expect("nodes") {
                let plaintext = self
                    .rig
                    .state
                    .get_node(&name)
                    .expect("reads")
                    .expect("held");
                world.nodes.insert(name, plaintext);
            }
            let source = world.nodes.clone();
            let records: Vec<Name> = tree::records_of(&source, &taken.root)
                .expect("records")
                .into_keys()
                .collect();
            let everything = tree::everything_of(&source, &taken.root).expect("everything");
            for class in [None, Some(Class::Thumbnails), Some(Class::Originals)] {
                let refs = match class {
                    None => tree::records_of(&source, &taken.root),
                    Some(class) => tree::media_of(&source, &taken.root, class),
                }
                .expect("refs");
                for (name, reference) in refs {
                    world.digests.insert(name, reference.digest);
                }
            }
            world.records.insert(root, records);
            world.everything.insert(root, everything);
        }
        self.dumps
            .insert(root, dump(self.rig.vault()).expect("dumps"));
        self.exact.insert(root, !self.tainted || taken.full);
        if self.tainted {
            self.since_taint += 1;
            if taken.full {
                self.tainted = false;
                self.since_taint = 0;
            } else if self.since_taint > FULL_EVERY + 1 {
                self.fail(format!(
                    "a checkpoint made outside the core was not caught by a full read in {} snapshots",
                    self.since_taint
                ));
            }
        }
        self.newest = Some(root);
        if std::env::var_os("CENTRAID_SIM_DEBUG").is_some() && !taken.full {
            // Debug: is a normal snapshot's tree exactly the file? (An outside checkpoint excuses it.)
            let mut pin = centraid_vault::pagesource::PinnedPages::begin(self.rig.vault().path())
                .expect("pin");
            let source = self.world.borrow().nodes.clone();
            let root = tree::root_of(&source, &taken.root).expect("root");
            let ranges = tree::ranges_of(&source, &root).expect("ranges");
            let mut wrong = Vec::new();
            for (index, reference) in ranges.iter().enumerate() {
                let bytes = pin.range(index as u64).expect("range").to_vec();
                if centraid_media::sealed::name_of(&self.rig.keys, Class::Records, &bytes)
                    != reference.name
                {
                    wrong.push(index);
                }
            }
            pin.end().expect("ends");
            if !wrong.is_empty() {
                eprintln!(
                    "DEBUG: normal snapshot misses ranges {wrong:?} (tainted={}) log={:?}",
                    self.tainted, self.log
                );
            }
        }
        self.last_ranges_new = taken.ranges_new as u64;
        self.last_was_catch_up = was_tainted && taken.full;
        self.last_snapshot = format!(
            "full={} ranges_read={} ranges_new={} entries_new={}",
            taken.full, taken.ranges_read, taken.ranges_new, taken.entries_new
        );
        self.log.push(format!("snapshot full={}", taken.full));
    }

    fn refresh_claims(&mut self) {
        let mut claimed = BTreeMap::new();
        for store in &self.inner {
            claimed.insert(
                store.gateway_id().to_owned(),
                claims_of(&self.rig, store.gateway_id())
                    .into_iter()
                    .flatten()
                    .collect(),
            );
        }
        *self.claimed.borrow_mut() = claimed;
    }

    /// Run the engine for up to `limit` ticks over every gateway.
    fn engine_round(&mut self, limit: usize) {
        if self.newest.is_none() || self.rig.state.device().expect("device").newest.is_none() {
            self.snapshot();
        }
        self.refresh_claims();
        let before: Vec<[Option<Name>; 3]> = self
            .inner
            .iter()
            .map(|store| claims_of(&self.rig, store.gateway_id()))
            .collect();
        let lies = self.lie_about_the_os || self.bug == Bug::TrustOs;
        let outcome = std::panic::catch_unwind(AssertUnwindSafe(|| {
            let mut env = Env::new(
                self.rig.vault(),
                &self.rig.keys,
                &self.rig.state,
                &self.rig.staging,
                Policy::WIFI,
                self.clock,
            );
            env.bugs = self.bug.engine();
            let mut passes = Vec::new();
            for store in &self.stores {
                if let Ok(pass) = GatewayPass::new(&env, store as &dyn Store) {
                    passes.push(pass);
                }
            }
            let mut scheduler = Scheduler::new(passes, 4);
            let mut verdicts: Vec<String> = Vec::new();
            for _ in 0..limit {
                if lies {
                    // The OS says everything was uploaded. It only wakes a pass.
                    for (index, pass) in scheduler.passes.iter_mut().enumerate() {
                        let root = *pass.target();
                        let mut owed = Vec::new();
                        for class in [Class::Thumbnails, Class::Originals] {
                            if let Ok(media) = tree::media_of(&self.rig.state, &root, class) {
                                owed.extend(media.into_keys());
                            }
                        }
                        let missing = self.inner[index].exists(&owed).unwrap_or_default();
                        pass.os_reported(&missing);
                    }
                }
                match scheduler.tick() {
                    Ok(true) => {}
                    Ok(false) => break,
                    Err(error) => {
                        verdicts.push(format!("the engine refused: {error}"));
                        break;
                    }
                }
            }
            // What the engine confirmed, before anything is read back.
            let mid: Vec<[Option<Name>; 3]> = self
                .inner
                .iter()
                .map(|store| claims_of(&self.rig, store.gateway_id()))
                .collect();
            let all_over =
                !scheduler.passes.is_empty() && scheduler.passes.iter().all(GatewayPass::is_over);
            if all_over {
                // §6.2 step 7: a pass that finished reads back what the gateway claims to hold.
                for (index, store) in self.stores.iter().enumerate() {
                    if scheduler.passes[index].stop_reason().is_none() {
                        let _ = engine::read_back(&env, store);
                    }
                }
            }
            let stops: Vec<String> = scheduler
                .passes
                .iter()
                .map(|pass| format!("{:?}", pass.stop_reason()))
                .collect();
            let exists: u64 = scheduler
                .passes
                .iter()
                .map(|pass| pass.stats.exists_calls)
                .sum();
            let stored: u64 = scheduler.passes.iter().map(|pass| pass.stats.stored).sum();
            verdicts.push(format!(
                "@round stops={stops:?} exists={exists} stored={stored}"
            ));
            (verdicts, mid, all_over)
        }));
        let mut mid_claims: Vec<[Option<Name>; 3]> = before.clone();
        let mut complete = false;
        match outcome {
            Ok((mut verdicts, mid, all_over)) => {
                mid_claims = mid;
                complete = all_over;
                if let Some(report) = verdicts.pop() {
                    self.last_round = report;
                }
                for verdict in verdicts {
                    self.fail(verdict);
                }
            }
            Err(_) => self.fail("the engine panicked: the commit rule was broken".to_owned()),
        }
        self.collect_gateway_violations();
        if self.last_round.contains("Restage") {
            // A range a gateway is owed is no longer staged: the driver takes a snapshot that
            // stages every range again.
            self.snapshot_as(true);
        }
        for (index, _) in self.inner.clone().iter().enumerate() {
            let after = mid_claims[index];
            for (slot, (old, new)) in before[index].iter().zip(&after).enumerate() {
                if let (Some(new), true) = (new, old.as_ref() != new.as_ref()) {
                    let class = match slot {
                        0 => None,
                        1 => Some(Class::Thumbnails),
                        _ => Some(Class::Originals),
                    };
                    // A1: what the engine vouched for is held, now.
                    if let Some(problem) = self.claim_problem(index, *new, class, true) {
                        self.fail(format!("gateway {index} was just confirmed but {problem}"));
                    }
                }
            }
            let standing = engine::standing(&self.rig.state, self.inner[index].gateway_id())
                .expect("standing");
            if let Ok(Some(newest_ref)) = self.rig.env(self.clock).newest()
                && let Ok(root) = tree::root_of(&self.rig.state, &newest_ref)
                && let Ok(stats) = tree::stats_of(&self.rig.state, &root.blobs)
            {
                if standing.originals && stats.unheld_orig_files > 0 {
                    self.fail(format!(
                        "gateway {index} claimed standing.originals while unheld_orig_files={}",
                        stats.unheld_orig_files
                    ));
                }
                if standing.thumbnails && stats.unheld_thumb_files > 0 {
                    self.fail(format!(
                        "gateway {index} claimed standing.thumbnails while unheld_thumb_files={}",
                        stats.unheld_thumb_files
                    ));
                }
            }
        }
        self.claims_tick(complete);
        self.log.push(format!("engine {limit}"));
    }

    /// Why a root is not wholly held and intact on gateway `index`, if it is not. `fresh` skips
    /// the names the harness damaged and the engine has had no chance to find.
    fn claim_problem(
        &self,
        index: usize,
        root: Name,
        class: Option<Class>,
        fresh: bool,
    ) -> Option<String> {
        let world = self.world.borrow();
        let plaintext = world.nodes.get(&root)?;
        let reference = centraid_media::sealed::seal(&self.rig.keys, Class::Records, plaintext)
            .expect("seals")
            .reference();
        let refs: BTreeMap<Name, Ref> = match class {
            None => tree::records_of(&world.nodes, &reference).ok()?,
            Some(class) => tree::media_of(&world.nodes, &reference, class).ok()?,
        };
        let skip = &self.damaged[index];
        let names: Vec<Name> = refs
            .keys()
            .copied()
            .filter(|name| !(fresh && skip.contains(name)))
            .collect();
        let missing = self.inner[index].exists(&names).ok()?;
        if !missing.is_empty() {
            return Some(format!(
                "{} of its {class:?} objects are not held: {:?} (damaged by the harness: {:?}; deleted/bytes-intact/held: {:?}; reached from {:?})",
                missing.len(),
                missing.iter().take(2).collect::<Vec<_>>(),
                skip,
                (
                    missing.first().and_then(|name| world.deleted.get(name)),
                    missing.first().map(|name| {
                        let have = self.inner[index]
                            .contents()
                            .into_iter()
                            .find(|(held, _)| held == name)
                            .map(|(_, bytes)| Digest::of(&bytes) == world.digests[name]);
                        let held = self.inner[index]
                            .held(None, 1000)
                            .map(|entries| entries.iter().any(|entry| entry.name == *name))
                            .unwrap_or(false);
                        (have, held)
                    })
                ),
                world
                    .everything
                    .iter()
                    .filter(|(_, set)| missing.first().is_some_and(|name| set.contains(name)))
                    .count()
            ));
        }
        let contents: BTreeMap<Name, Vec<u8>> = self.inner[index].contents().into_iter().collect();
        for name in names {
            let Some(bytes) = contents.get(&name) else {
                return Some(format!("{name} has no bytes"));
            };
            if Digest::of(bytes) != refs[&name].digest {
                return Some(format!("{name} is not the object the tree names"));
            }
        }
        None
    }

    /// A2: a claim a fault made false is withdrawn within a bounded number of rounds.
    fn claims_tick(&mut self, counts: bool) {
        for (index, store) in self.inner.clone().iter().enumerate() {
            let claims = claims_of(&self.rig, store.gateway_id());
            let false_claim = [
                (claims[0], None),
                (claims[1], Some(Class::Thumbnails)),
                (claims[2], Some(Class::Originals)),
            ]
            .into_iter()
            .any(|(root, class)| {
                root.is_some_and(|root| self.claim_problem(index, root, class, false).is_some())
            });
            // A name the engine has mended leaves the damaged set.
            let contents: BTreeMap<Name, Vec<u8>> = store.contents().into_iter().collect();
            let world = self.world.borrow();
            let mended: Vec<Name> = self.damaged[index]
                .iter()
                .copied()
                .filter(|name| {
                    contents.get(name).map(|bytes| Digest::of(bytes))
                        == world.digests.get(name).copied()
                })
                .collect();
            drop(world);
            for name in mended {
                self.damaged[index].remove(&name);
            }
            if false_claim && !counts {
                continue;
            }
            if false_claim {
                self.stale[index] += 1;
                if self.stale[index] > 12 {
                    self.fail(format!(
                        "gateway {index} kept a false claim through {} rounds",
                        self.stale[index]
                    ));
                }
            } else {
                self.stale[index] = 0;
            }
        }
    }

    /// A rollback can bring back bytes that had rotted: the harness knows what is wrong on a
    /// gateway by comparing every object it holds with the digest its tree names.
    fn rescan_damage(&mut self, index: usize) {
        let world = self.world.borrow();
        let wrong: BTreeSet<Name> = self.inner[index]
            .contents()
            .into_iter()
            .filter(|(name, bytes)| {
                world
                    .digests
                    .get(name)
                    .is_some_and(|expected| Digest::of(bytes) != *expected)
            })
            .map(|(name, _)| name)
            .collect();
        drop(world);
        self.damaged[index].extend(wrong);
    }

    fn read_back_round(&mut self) {
        for index in 0..self.stores.len() {
            let env = Env::new(
                self.rig.vault(),
                &self.rig.keys,
                &self.rig.state,
                &self.rig.staging,
                Policy::WIFI,
                self.clock,
            );
            let _ = engine::read_back(&env, &self.stores[index]);
        }
        self.collect_gateway_violations();
        self.claims_tick(false);
        self.log.push("read_back".to_owned());
    }

    fn collect_round(&mut self) {
        self.refresh_claims();
        for index in 0..self.stores.len() {
            let armed = self.checkpoints[index].is_some()
                && (self.bug == Bug::UnboundDelete || self.rng.chance(3));
            if armed {
                self.faults.borrow_mut().rollback_on_list = self.checkpoints[index].clone();
            }
            let mut env = Env::new(
                self.rig.vault(),
                &self.rig.keys,
                &self.rig.state,
                &self.rig.staging,
                Policy::WIFI,
                self.clock,
            );
            env.bugs = self.bug.engine();
            let _ = retention::collect(&env, &self.stores[index]);
            self.faults.borrow_mut().rollback_on_list = None;
            let _ = engine::housekeeping(&env, &[]);
            drop(env);
            if armed {
                self.rescan_damage(index);
            }
        }
        self.collect_gateway_violations();
        self.log.push("collect".to_owned());
    }

    // ── the faults ──

    fn inject(&mut self) {
        let index = usize::try_from(self.rng.below(self.inner.len() as u64)).unwrap_or(0);
        // A planted bug is looked for where it lives: its own fault is drawn half the time.
        let kind = match self.bug {
            Bug::AckTaken if self.rng.chance(2) => 12,
            Bug::GatewayCommitsTruncatedFrame if self.rng.chance(2) => 1,
            Bug::NoFullRead if self.rng.chance(2) => 11,
            Bug::SkipHeadCheck if self.rng.chance(2) => 8,
            _ => self.rng.below(13),
        };
        self.log.push(format!("fault {kind}"));
        match kind {
            0 => {
                self.faults.borrow_mut().cut = Some(Cut::AtFrame(
                    usize::try_from(self.rng.below(4)).unwrap_or(0),
                ))
            }
            1 => {
                let at = usize::try_from(self.rng.below(4)).unwrap_or(0);
                self.faults.borrow_mut().cut = Some(Cut::InsideFrame(at));
            }
            2 => self.faults.borrow_mut().duplicate = true,
            3 => self.faults.borrow_mut().reorder = true,
            4 => self.faults.borrow_mut().busy = 1 + u32::try_from(self.rng.below(3)).unwrap_or(0),
            5 => {
                self.faults.borrow_mut().unreachable =
                    1 + u32::try_from(self.rng.below(3)).unwrap_or(0)
            }
            6 => self.faults.borrow_mut().disk_full = 1,
            7 => {
                // Bit rot: a stored object changes under the gateway.
                let held = self.inner[index].contents();
                if !held.is_empty() {
                    let name =
                        held[usize::try_from(self.rng.below(held.len() as u64)).unwrap_or(0)].0;
                    if self.inner[index].flip_bit(&name) {
                        self.damaged[index].insert(name);
                    }
                }
            }
            8 => {
                if let Some(checkpoint) = self.checkpoints[index].clone() {
                    if std::env::var_os("CENTRAID_SIM_TRACE").is_some() {
                        eprintln!("TRACE gateway {index} ROLLED BACK by fault");
                    }
                    self.inner[index].roll_back(&checkpoint);
                    self.rescan_damage(index);
                }
            }
            9 => {
                let inner = self.inner.clone();
                let refs: Vec<&MemoryStore> = inner.iter().collect();
                self.rig.lose_state(&refs);
                self.newest = None;
            }
            10 => self.lie_about_the_os = !self.lie_about_the_os,
            12 => self.squat(index),
            _ => {
                // A checkpoint made outside the core.
                let pending = centraid_vault::backup::wal::frame_pages(self.rig.vault().path())
                    .expect("frames");
                let raw = self.rig.raw();
                raw.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| {
                    row.get::<_, i64>(0)
                })
                .expect("a checkpoint");
                if !pending.is_empty() {
                    self.tainted = true;
                    self.since_taint = 0;
                }
            }
        }
    }

    /// A gateway that is wrong: it holds other bytes, rotten, under a name the phone is about to
    /// need. Deterministic sealing says this cannot happen; the phone must still not believe the
    /// name is its own. The answer to its frame is `taken` (damaged, another digest): one signed
    /// delete frees it and the frame is sent again.
    fn squat(&mut self, index: usize) {
        self.edit();
        self.snapshot();
        let Some(newest) = self.newest else { return };
        let records = self.world.borrow().records[&newest].clone();
        let Ok(missing) = self.inner[index].exists(&records) else {
            return;
        };
        let Some(name) = missing.first().copied() else {
            return;
        };
        let squatter = Outgoing::of(name, format!("squatting on {name}").into_bytes());
        if self.inner[index].bundle(&[squatter]).is_ok() {
            self.inner[index].flip_bit(&name);
            let _ = self.inner[index].check_name(&name);
        }
    }

    // ── the second vault ──

    fn second_vault(&mut self) {
        if self.second.is_none() {
            let mut rig = Rig::new("sim-second");
            if self.bug == Bug::OneKeyForTwoVaults {
                // THE PLANTED BUG: one sealing key for two vaults.
                rig.keys = BackupKeys::from_root(&[0x42; 32]);
            } else {
                rig.keys = BackupKeys::from_root(&[0x99; 32]);
            }
            rig.grow(10, "second");
            let inner = self.inner[0].with_vault("second");
            inner.set_clock_ms(T0 * 20);
            rig.pair(&inner);
            let misrouted =
                (self.bug == Bug::NamespaceNotScopedPerVault).then(|| self.inner[0].clone());
            let store = Faulty {
                inner: inner.clone(),
                misrouted,
                faults: Rc::new(RefCell::new(Faults::default())),
                world: Rc::default(),
                claimed: Rc::default(),
                watch: false,
            };
            self.second = Some(Second { rig, inner, store });
        }
        let fingerprint = |store: &MemoryStore| -> (Option<Name>, Vec<(Name, Digest)>) {
            (
                store.head().ok().flatten().map(|head| head.name),
                store
                    .contents()
                    .into_iter()
                    .map(|(name, bytes)| (name, Digest::of(&bytes)))
                    .collect(),
            )
        };
        let before_a = fingerprint(&self.inner[0]);
        let second = self.second.as_mut().expect("a second vault");
        second
            .rig
            .raw()
            .execute("UPDATE vault SET writes = writes + 1", [])
            .expect("an edit");
        let taken = centraid_vault::backup::snapshot::take(
            second.rig.vault(),
            &second.rig.keys,
            &second.rig.state,
            &second.rig.staging,
            &second.rig.directory,
            Options::at(self.clock + 7),
        )
        .expect("a snapshot");
        let _ = taken;
        let env = Env::new(
            second.rig.vault(),
            &second.rig.keys,
            &second.rig.state,
            &second.rig.staging,
            Policy::WIFI,
            self.clock,
        );
        if let Ok(pass) = GatewayPass::new(&env, &second.store as &dyn Store) {
            let mut scheduler = Scheduler::new(vec![pass], 4);
            let _ = scheduler.run(1_000);
        }
        let after_a = fingerprint(&self.inner[0]);
        let mine: BTreeSet<Name> = after_a.1.iter().map(|(name, _)| *name).collect();
        let second = self.second.as_ref().expect("a second vault");
        let theirs: BTreeSet<Name> = second
            .inner
            .contents()
            .into_iter()
            .map(|(name, _)| name)
            .collect();
        if before_a != after_a {
            self.fail(
                "the second vault's backup changed the first vault's namespace on the same gateway"
                    .to_owned(),
            );
        }
        // The first vault's bundles to a gateway never carry the second's names either way.
        let shared: Vec<&Name> = mine.intersection(&theirs).collect();
        if !shared.is_empty() {
            self.fail(format!(
                "{} names are shared between two vaults on one gateway",
                shared.len()
            ));
        }
        // Two vaults' trees name nothing in common (R1: nothing deduplicates across vaults).
        let both_roots = (
            self.newest,
            self.second
                .as_ref()
                .and_then(|s| s.rig.state.device().ok()?.newest.map(|(n, _)| n)),
        );
        let mut overlap = 0;
        if let (Some(a), Some(b)) = both_roots {
            let world = self.world.borrow();
            if let (Some(a), Some(second)) = (world.everything.get(&a), self.second.as_ref()) {
                let b_names: BTreeSet<Name> = second
                    .rig
                    .state
                    .get_node(&b)
                    .ok()
                    .flatten()
                    .map(|plaintext| {
                        let reference = centraid_media::sealed::seal(
                            &second.rig.keys,
                            Class::Records,
                            &plaintext,
                        )
                        .expect("seals")
                        .reference();
                        tree::records_of(&second.rig.state, &reference)
                            .map(|m| m.into_keys().collect())
                            .unwrap_or_default()
                    })
                    .unwrap_or_default();
                overlap = a.intersection(&b_names).count();
            }
        }
        if overlap > 0 {
            self.fail(format!("{overlap} names are common to two vaults' trees"));
        }
        self.log.push("second vault".to_owned());
    }

    // ── a seed ──

    fn step(&mut self) {
        let draw = match self.bug {
            // Checkpoints and collections are where a delete's head binding matters.
            Bug::UnboundDelete if self.rng.chance(3) => 14 + 4 * self.rng.below(2),
            _ => self.rng.below(24),
        };
        match draw {
            0..=3 => self.edit(),
            4..=6 => self.snapshot(),
            7..=13 => {
                let limit = 1 + usize::try_from(self.rng.below(9)).unwrap_or(1);
                self.engine_round(limit);
            }
            14 => self.collect_round(),
            15 => self.read_back_round(),
            16 | 17 => self.inject(),
            18 => {
                let index = usize::try_from(self.rng.below(self.inner.len() as u64)).unwrap_or(0);
                self.checkpoints[index] = Some(self.inner[index].checkpoint());
            }
            19 => self.second_vault(),
            _ => self.engine_round(3),
        }
        if std::env::var_os("CENTRAID_SIM_TRACE").is_some() {
            eprintln!(
                "TRACE step: {}",
                self.log.last().cloned().unwrap_or_default()
            );
        }
        self.collect_gateway_violations();
    }

    fn faults_off(&mut self) {
        let mut faults = self.faults.borrow_mut();
        faults.cut = None;
        faults.duplicate = false;
        faults.reorder = false;
        faults.busy = 0;
        faults.unreachable = 0;
        faults.disk_full = 0;
        faults.rollback_on_list = None;
        drop(faults);
        self.lie_about_the_os = false;
    }

    fn converged(&self) -> bool {
        let Some(newest) = self.newest else {
            return false;
        };
        let world = self.world.borrow();
        let Some(everything) = world.everything.get(&newest) else {
            return false;
        };
        let names: Vec<Name> = everything.iter().copied().collect();
        let held = self.inner.iter().all(|store| {
            let [conf, troot, oroot] = claims_of(&self.rig, store.gateway_id());
            conf == Some(newest)
                && troot == Some(newest)
                && oroot == Some(newest)
                && names
                    .chunks(1000)
                    .all(|batch| store.exists(batch).is_ok_and(|missing| missing.is_empty()))
        });
        drop(world);
        // And intact: nothing rotten waits to be found.
        held && (0..self.inner.len()).all(|index| {
            [None, Some(Class::Thumbnails), Some(Class::Originals)]
                .into_iter()
                .all(|class| self.claim_problem(index, newest, class, false).is_none())
        })
    }

    /// CONVERGENCE: with the faults off, every gateway reaches the newest root in a bounded
    /// number of rounds. How many it took.
    fn converge(&mut self) -> u32 {
        let mut rounds = 0;
        while !self.converged() && rounds < 16 {
            self.read_back_round();
            self.engine_round(100_000);
            rounds += 1;
            if self.violations.len() > 3 {
                break;
            }
        }
        rounds
    }

    fn finish(&mut self) {
        self.faults_off();
        if self.rig.state.device().expect("device").newest.is_none() {
            self.snapshot();
        }
        let rounds = self.converge();
        if !self.converged() {
            let claims: Vec<[Option<Name>; 3]> = self
                .inner
                .iter()
                .map(|store| claims_of(&self.rig, store.gateway_id()))
                .collect();
            self.fail(format!(
                "convergence: after {rounds} rounds a gateway is not at the newest root {:?}; claims {claims:?}; last round {}",
                self.newest, self.last_round
            ));
            return;
        }
        // A3: a claimed root restores exactly the vault at its time, unless an outside checkpoint
        // clouded it and no full read has cleared it.
        let newest = self.newest.expect("a root");
        for store in self.inner.clone() {
            let [conf, ..] = claims_of(&self.rig, store.gateway_id());
            let Some(root) = conf else { continue };
            if !self.exact.get(&root).copied().unwrap_or(false) {
                continue;
            }
            let dir = tempfile::tempdir().expect("a directory");
            let restore = match Restore::open(&self.rig.keys, &[&store as &dyn Store], &root) {
                Ok(restore) => restore,
                Err(error) => {
                    self.fail(format!(
                        "the root {root} claimed at {} does not open: {error}",
                        store.gateway_id()
                    ));
                    continue;
                }
            };
            let out = dir.path().join("restored.db");
            if let Err(error) = restore.records(&out) {
                self.fail(format!(
                    "the root {root} claimed at {} does not restore: {error}",
                    store.gateway_id()
                ));
                continue;
            }
            let restored = Vault::open(&out).expect("opens");
            if dump(&restored).expect("dumps") != self.dumps[&root] {
                self.fail(format!(
                    "the root {root} claimed at {} restores a different vault",
                    store.gateway_id()
                ));
            }
            assert_eq!(root, newest, "converged");
        }
        self.bounded_work();
    }

    /// Bounded work, on a clean gateway: a one-page edit stores 3 objects with 0 `exists`; a new
    /// photo of k chunks stores at most k + 5.
    fn bounded_work(&mut self) {
        let store = self.inner[0].clone();
        if std::env::var_os("CENTRAID_SIM_DEBUG").is_some() {
            self.snapshot();
            eprintln!("DEBUG: a snapshot with no edit: {}", self.last_snapshot);
        }
        // Up to date first: the edits of the random phase are in a snapshot every gateway holds.
        self.snapshot();
        self.converge();
        // A one-page edit, on a gateway that is up to date.
        self.rig
            .raw()
            .execute("UPDATE vault SET writes = writes + 1", [])
            .expect("one page");
        self.snapshot();
        let snapshot = self.last_snapshot.clone();
        let ranges = self.last_ranges_new;
        let catch_up = self.last_was_catch_up;
        let before = store.counts().stored;
        self.engine_round(100_000);
        let stored = store.counts().stored - before;
        let round = self.last_round.clone();
        // One page is one range, one leaf and one root. (After an outside checkpoint the full read
        // also finds what the dirty set missed; those ranges are then the edit's company.)
        let expected = if catch_up { ranges + 2 } else { 3 };
        if self.bug == Bug::None
            && ((!catch_up && ranges != 1) || stored != expected || !round.contains("exists=0"))
        {
            self.fail(format!(
                "a one-page edit stored {stored} objects ({round}); the snapshot: {snapshot}"
            ));
        }
        let k = 2;
        self.add_photo_of(k, false);
        self.snapshot();
        let snapshot = self.last_snapshot.clone();
        let ranges = self.last_ranges_new;
        let before = store.counts().stored;
        self.engine_round(100_000);
        let stored = store.counts().stored - before;
        // k chunks, the ranges the vault edit moved (one, for the spec's k + 5), their leaf, the
        // root and the blobs path (at most two nodes).
        if self.bug == Bug::None && stored > (k as u64) + ranges + 4 {
            self.fail(format!(
                "a new photo of {k} chunks stored {stored} objects; the snapshot: {snapshot}"
            ));
        }
        self.log
            .push(format!("bounded work: photo stored {stored}"));
    }
}

fn run_seed(seed: u64, bug: Bug, steps: usize) -> (Vec<String>, Vec<String>) {
    let mut sim = Sim::new(seed, bug);
    sim.second_vault();
    for _ in 0..steps {
        sim.step();
        if !sim.violations.is_empty() {
            return (std::mem::take(&mut sim.violations), sim.log);
        }
    }
    sim.finish();
    sim.collect_gateway_violations();
    (std::mem::take(&mut sim.violations), sim.log)
}

/// How many seeds to run (`CENTRAID_SIM_SEEDS`) and where to start (`CENTRAID_SIM_FROM`), so a
/// long run can be split across processes.
fn seeds() -> u64 {
    std::env::var("CENTRAID_SIM_SEEDS")
        .ok()
        .and_then(|text| text.parse().ok())
        .unwrap_or(24)
}

fn first_seed() -> u64 {
    std::env::var("CENTRAID_SIM_FROM")
        .ok()
        .and_then(|text| text.parse().ok())
        .unwrap_or(0)
}

const STEPS: usize = 40;

#[test]
fn the_correct_engine_has_no_violation_at_any_seed() {
    let mut bad = Vec::new();
    for seed in first_seed()..first_seed() + seeds() {
        let (violations, log) = run_seed(seed, Bug::None, STEPS);
        if !violations.is_empty() {
            bad.push(format!(
                "seed {seed}: {violations:?}\n  {}",
                log.join(" | ")
            ));
        }
    }
    assert!(
        bad.is_empty(),
        "{} seeds violated an invariant:\n{}",
        bad.len(),
        bad.join("\n")
    );
    eprintln!(
        "backup_sim: seeds {}..{}, 0 violations",
        first_seed(),
        first_seed() + seeds()
    );
}

fn caught(bug: Bug) -> Option<(u64, Vec<String>)> {
    for seed in 0..60 {
        let (violations, _) = run_seed(seed, bug, STEPS);
        if !violations.is_empty() {
            return Some((seed, violations));
        }
    }
    None
}

#[test]
fn every_planted_bug_is_caught() {
    let mut missed = Vec::new();
    for bug in Bug::ALL {
        match caught(bug) {
            Some((seed, violations)) => {
                eprintln!("caught {bug:?} at seed {seed}: {}", violations[0])
            }
            None => missed.push(format!("{bug:?}")),
        }
    }
    assert!(
        missed.is_empty(),
        "the simulation did not catch: {missed:?}"
    );
}
