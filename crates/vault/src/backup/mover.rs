//! The mover: send a gateway's outbox to it and let go of what it
//! acknowledged (#1080 ruling 7, #1191 E11).
//!
//! **Acknowledgement is the `PUT`'s success.** An outbox row leaves
//! ([`DeviceState::done`]) only when the gateway answered that it holds the
//! name, and only when no other gateway still owes it does its spool file go.
//! Nothing is recorded as acknowledged: what a gateway holds is whatever it
//! answers to `exists`. A `NAME_TAKEN` answer naming the phone's own digest is
//! an acknowledgement too; one naming other bytes never is (decision 30).
//!
//! **EVERY PAIRED GATEWAY IS A FULL REPLICA** (#1188, B1). A sealed part is
//! written once and each gateway has its own row for it. The wait for a
//! gateway that is away or full is bounded by [`SPOOL_WAIT_MS`]: past it the
//! rows go, and that gateway is fed again from the vault when it next
//! answers (`exists` finds what is missing; names are functions of the
//! plaintext, so sealing again is cheap and exact).
//!
//! ## RANGES AND DERIVATIVES TRAVEL IN BUNDLES
//!
//! A snapshot is hundreds of 64 KiB ranges and a photograph brings a
//! thumbnail and a preview of a few dozen KiB each, so a request per part
//! would spend the pass on round trips. A run of them in outbox order goes as
//! one [`Store::put_many`] of up to [`BUNDLE_BYTES`], answered part by part
//! exactly as each `put` would be. An original's part goes alone, and so does
//! a manifest, which the outbox orders after everything else.
//!
//! A part whose spool file is gone or unreadable is unsealed and sealed
//! again; the same part answered `DIGEST_MISMATCH` [`MISMATCH_LIMIT`] times in
//! a row by one gateway stops the pass to it.
//!
//! [`reconcile`] asks the gateway about every owed name and lets go of the
//! ones it already holds.

use std::collections::{BTreeMap, BTreeSet};
use std::time::Instant;

use super::Result;
use super::naming::{Digest, Name};
use super::spool::Spool;
use super::state::{DeviceState, Outbox, OutboxKind};
use super::store::{
    self, BUNDLE_BYTES, FRAME_HEADER_BYTES, NameState, Outgoing, Refusal, Store, StoreError,
};
use crate::clock::Clock;

/// Why a pass stopped moving.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Stop {
    /// Nothing is left to move.
    Empty,
    /// The pass's time is up; the rest waits for the next.
    Deadline,
    /// The gateway could not be reached; nothing is assumed stored.
    Unreachable(String),
    /// The machine that answered is not the paired gateway; nothing is sent to it.
    Untrusted(String),
    /// A newer writer claimed the vault: this device stops writing.
    Moved { epoch: u64 },
    /// The gateway answered and refused, for a reason that stops the pass: its disk is full, a
    /// quota, a cap, or a token it no longer knows (`UNAUTHORIZED`). Nothing was acknowledged;
    /// every row stays owed.
    Refused(Refusal),
}

/// What a pass moved.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Moved {
    /// Held by the gateway and gone from its outbox.
    pub confirmed: Vec<Name>,
    /// Unsealed to be sealed again: their spool file was gone or was not the bytes owed.
    pub dropped: Vec<Name>,
    /// Why a part was dropped for a cause worth naming: a spool file that exists and cannot
    /// be read, and a part this gateway refused as damaged. Also a subset of `dropped`.
    pub errors: Vec<(Name, String)>,
    pub stopped: Stop,
}

/// How many times in a row one gateway may answer `DIGEST_MISMATCH` for the same part before
/// the pass to it stops: the part was sealed again each time, so a third is not a torn spool
/// file but a gateway (or a link) that damages what it is sent.
pub const MISMATCH_LIMIT: u32 = 3;

fn now(clock: &dyn Clock) -> u64 {
    u64::try_from(clock.now_ms()).unwrap_or(0)
}

/// How long a sealed row waits for a gateway that has not taken it (away, full, refusing): a
/// day. Past it the row and its spool file go and the gateway is fed again from the vault when
/// it next answers.
pub const SPOOL_WAIT_MS: u64 = 24 * 60 * 60 * 1000;

/// The error text an unsealed damaged part keeps.
const MISMATCH: &str = "DIGEST_MISMATCH";

/// Remove the spool files of `names` that no gateway is owed any more.
fn free_spool(state: &DeviceState, spool: &Spool, names: &[Name]) -> Result<usize> {
    let owed = state.owed_among(names)?;
    let mut freed = 0;
    for name in names {
        if !owed.contains(name) {
            spool.remove(name)?;
            freed += 1;
        }
    }
    Ok(freed)
}

/// Let go of rows a gateway no longer owes, and of the spool files nobody owes. With `unhand`
/// the parts other gateways still owe are taken back from the operating system. Answers how
/// many parts left the spool.
///
/// # Errors
/// The state's or the spool's refusal.
pub fn release_many(
    state: &DeviceState,
    spool: &Spool,
    gateway_id: &str,
    names: &[Name],
    unhand: bool,
) -> Result<usize> {
    state.done_many(gateway_id, names)?;
    let freed = free_spool(state, spool, names)?;
    if unhand {
        let owed = state.owed_among(names)?;
        for gateway in state.gateways()? {
            let theirs: Vec<Name> = names
                .iter()
                .filter(|name| owed.contains(name))
                .copied()
                .collect();
            state.unhand_many(&gateway.gateway_id, &theirs)?;
        }
    }
    Ok(freed)
}

/// With no gateway paired nothing in the outbox or the spool is owed to anyone: sweep both, so
/// a member who forgot their last gateway has nothing of the backup left on the phone. Does
/// nothing while any gateway is paired. Answers how many bytes of spool it swept.
///
/// # Errors
/// The state's or the spool's refusal.
pub fn sweep_unowed(state: &DeviceState, spool: &Spool) -> Result<u64> {
    if !state.gateways()?.is_empty() {
        return Ok(0);
    }
    // A file no outbox row names (a crash left it, or the last gateway went) is unowed.
    spool.sweep_unqueued(&BTreeSet::new())
}

/// End the wait: every sealed row owed since before [`SPOOL_WAIT_MS`] ago goes, with its
/// spool file once no gateway owes it, and the gateway it was owed to starts its blob walk
/// again (cursor 0) so what it lacks is found by `exists`. Answers how many rows went.
///
/// # Errors
/// The state's or the spool's refusal.
pub fn release_expired(state: &DeviceState, spool: &Spool, now_ms: u64) -> Result<usize> {
    let Some(waited_by) = now_ms.checked_sub(SPOOL_WAIT_MS) else {
        return Ok(0);
    };
    let expired = state.outbox_older_than(waited_by)?;
    let mut by_gateway: BTreeMap<String, Vec<Name>> = BTreeMap::new();
    for row in &expired {
        by_gateway
            .entry(row.gateway_id.clone())
            .or_default()
            .push(row.name);
    }
    for (gateway, names) in &by_gateway {
        state.done_many(gateway, names)?;
        if expired
            .iter()
            .any(|row| &row.gateway_id == gateway && row.kind == OutboxKind::Blob)
        {
            state.set_cursor(gateway, 0)?;
        }
    }
    let names: Vec<Name> = expired.iter().map(|row| row.name).collect();
    free_spool(state, spool, &names)?;
    Ok(expired.len())
}

/// Why a part waits after `NAME_TAKEN` by other bytes: the state, recorded
/// as its attempt.
fn taken_reason(refusal: &Refusal) -> String {
    match refusal {
        Refusal::NameTaken { state, .. } => format!("NAME_TAKEN {state:?}"),
        other => other.code().to_owned(),
    }
}

/// A sealed row: what the mover can send.
fn sealed(row: &Outbox) -> Option<(u64, Digest)> {
    row.part_path.as_ref()?;
    Some((row.size?, row.digest?))
}

/// Whether `part` rides in a bundle: a range or a derivative small enough
/// for one. Everything else goes as its own `put`.
fn bundled(part: &Outbox, size: u64) -> bool {
    (matches!(part.kind, OutboxKind::Range | OutboxKind::Leaf)
        || (part.kind == OutboxKind::Blob && part.derivative))
        && size.saturating_add(FRAME_HEADER_BYTES) <= BUNDLE_BYTES
}

/// One pass's bookkeeping: what the gateway's answers did to the outbox
/// and the spool.
struct Pass<'a> {
    state: &'a DeviceState,
    spool: &'a Spool,
    gateway: String,
    clock: &'a dyn Clock,
    moved: Moved,
    /// Parts whose damaged copy this pass already freed: freed once a pass,
    /// never in a loop.
    healed: BTreeSet<Name>,
}

impl Pass<'_> {
    /// The gateway holds a sealing of each of `parts`: let go of them and free the spool of
    /// the ones no other gateway owes.
    fn acknowledged(&mut self, parts: &[&Outbox]) -> Result<()> {
        if parts.is_empty() {
            return Ok(());
        }
        let names: Vec<Name> = parts.iter().map(|part| part.name).collect();
        release_many(self.state, self.spool, &self.gateway, &names, true)?;
        self.state.touch_ack(&self.gateway, now(self.clock))?;
        self.moved.confirmed.extend(names);
        Ok(())
    }

    /// The spool file is gone, cannot be read, or is not the bytes owed: unseal the row, to be
    /// sealed again from the vault. `why` is recorded when the file was there and was no good.
    /// Answers how many times in a row this gateway has refused the part as damaged.
    fn torn(&mut self, part: &Outbox, why: Option<String>, error: &str) -> Result<u32> {
        let count = self.state.unseal(&self.gateway, &part.name, error)?;
        // The sealed file is no good for any gateway; each one's row finds it gone and is
        // unsealed in turn.
        self.spool.remove(&part.name)?;
        self.moved.dropped.push(part.name);
        if let Some(why) = why {
            self.moved.errors.push((part.name, why));
        }
        Ok(count)
    }

    /// Act on a batch of answers, one per part; a refusal that stops the pass is returned.
    /// The acknowledged parts are released together, and the first stop wins.
    fn answered(
        &mut self,
        store: &dyn Store,
        answers: Vec<(&Outbox, std::result::Result<(), Refusal>)>,
    ) -> Result<Option<Stop>> {
        let mut acknowledged: Vec<&Outbox> = Vec::new();
        let mut heal: Vec<&Outbox> = Vec::new();
        let mut stop = None;
        for (part, answer) in answers {
            match answer {
                Ok(()) => acknowledged.push(part),
                // ONLY THE PHONE'S OWN BYTES UNDER THE NAME are an acknowledgement
                // (decision 30).
                Err(Refusal::NameTaken { held, .. }) if Some(held) == part.digest => {
                    acknowledged.push(part);
                }
                // A DAMAGED COPY UNDER THE NAME: the vault key's signed delete
                // frees it at once, and the part goes again (decision 30).
                Err(Refusal::NameTaken {
                    state: NameState::Damaged,
                    ..
                }) if self.healed.insert(part.name) => heal.push(part),
                // OTHER BYTES, LIVE OR HELD: never counted as stored. The row waits, with the
                // reason, and goes again on a later pass (the hold ends, or the name is
                // freed); the pass to the others goes on.
                Err(refusal @ Refusal::NameTaken { .. }) => {
                    self.state
                        .record_attempt(&self.gateway, &part.name, &taken_reason(&refusal))?;
                }
                Err(Refusal::DigestMismatch) => {
                    // THE PART IS SEALED AGAIN, BUT NOT FOREVER: the same part, refused as
                    // damaged by the same gateway `MISMATCH_LIMIT` times in a row, is a
                    // gateway or a link that damages what it is sent.
                    let count = self.torn(part, Some(MISMATCH.to_owned()), MISMATCH)?;
                    if count >= MISMATCH_LIMIT && stop.is_none() {
                        stop = Some(Stop::Refused(Refusal::DigestMismatch));
                    }
                }
                // EVERY OTHER REFUSAL STOPS THE PASS, `TOO_LARGE` AND A FULL DISK ALIKE
                // (#1080, the sweep's F1): the gateway answered, and what it answered is a
                // fact the member hears, not a part to skip.
                Err(refusal) => {
                    self.state
                        .record_attempt(&self.gateway, &part.name, refusal.code())?;
                    stop.get_or_insert(Stop::Refused(refusal));
                }
            }
        }
        self.acknowledged(&acknowledged)?;
        if stop.is_none() && !heal.is_empty() {
            let names: Vec<Name> = heal.iter().map(|part| part.name).collect();
            match store.delete(&names) {
                Ok(deleted) => {
                    for part in heal {
                        if deleted.freed.contains(&part.name) {
                            if let Some(halt) = self.single(store, part)? {
                                stop.get_or_insert(halt);
                            }
                        } else {
                            self.state.record_attempt(
                                &self.gateway,
                                &part.name,
                                "NAME_TAKEN damaged, not freed",
                            )?;
                        }
                    }
                }
                Err(error) => return self.unanswered(&heal, error).map(Some),
            }
        }
        Ok(stop)
    }

    /// A request that was not answered at all: every part in it waits.
    fn unanswered(&mut self, parts: &[&Outbox], error: StoreError) -> Result<Stop> {
        Ok(match error {
            StoreError::Moved { epoch } => Stop::Moved { epoch },
            StoreError::Refused(refusal) => {
                for part in parts {
                    self.state
                        .record_attempt(&self.gateway, &part.name, refusal.code())?;
                }
                Stop::Refused(refusal)
            }
            error => {
                let detail = error.to_string();
                for part in parts {
                    self.state
                        .record_attempt(&self.gateway, &part.name, &detail)?;
                }
                if matches!(error, StoreError::Untrusted(_)) {
                    Stop::Untrusted(detail)
                } else {
                    Stop::Unreachable(detail)
                }
            }
        })
    }

    /// Send one part as its own `put`. A spool file that is not there, or is there and cannot
    /// be opened, unseals the row to be sealed again: a poison file never blocks the pass.
    fn single(&mut self, store: &dyn Store, part: &Outbox) -> Result<Option<Stop>> {
        let Some((size, digest)) = sealed(part) else {
            return Ok(None);
        };
        let mut body = match self.spool.read(&part.name) {
            Ok(file) => file,
            Err(_) if !self.spool.contains(&part.name) => {
                self.torn(part, None, "SPOOL_MISSING")?;
                return Ok(None);
            }
            Err(error) => {
                self.torn(
                    part,
                    Some(format!("the spool file cannot be read: {error}")),
                    "SPOOL_UNREADABLE",
                )?;
                return Ok(None);
            }
        };
        let put = store.put(&part.name, &digest, size, &mut body);
        drop(body);
        match put {
            Ok(_) => self.answered(store, vec![(part, Ok(()))]),
            Err(StoreError::Refused(refusal)) => self.answered(store, vec![(part, Err(refusal))]),
            Err(error) => self.unanswered(&[part], error).map(Some),
        }
    }

    /// Send a run of parts as one bundle. A part whose spool file is gone, or is there and is
    /// not a file that can be opened, is unsealed before the request; the rest are answered
    /// together.
    fn bundle(&mut self, store: &dyn Store, run: &[&Outbox]) -> Result<Option<Stop>> {
        let mut sent: Vec<&Outbox> = Vec::with_capacity(run.len());
        for part in run {
            if !self.spool.contains(&part.name) {
                self.torn(part, None, "SPOOL_MISSING")?;
            } else if let Err(error) = self.spool.read(&part.name) {
                self.torn(
                    part,
                    Some(format!("the spool file cannot be read: {error}")),
                    "SPOOL_UNREADABLE",
                )?;
            } else {
                sent.push(part);
            }
        }
        if sent.is_empty() {
            return Ok(None);
        }
        let outgoing: Vec<Outgoing> = sent
            .iter()
            .filter_map(|part| {
                let (len, digest) = sealed(part)?;
                Some(Outgoing {
                    name: part.name,
                    digest,
                    len,
                    path: self.spool.path(&part.name),
                })
            })
            .collect();
        let answers = match store.put_many(&outgoing) {
            Ok(answers) => answers,
            Err(error) => return self.unanswered(&sent, error).map(Some),
        };
        let by_name: BTreeMap<Name, &Outbox> = sent.iter().map(|part| (part.name, *part)).collect();
        // An answer for a name this bundle did not carry says nothing about the outbox; a part
        // left unanswered waits for the next pass.
        let answered: Vec<(&Outbox, std::result::Result<(), Refusal>)> = answers
            .into_iter()
            .filter_map(|(name, answer)| Some((*by_name.get(&name)?, answer.map(|_| ()))))
            .collect();
        self.answered(store, answered)
    }
}

/// Send the gateway's sealed rows to `store` in outbox order until none is left, the
/// deadline passes or the gateway stops answering: runs of ranges and derivatives as bundles
/// of up to [`BUNDLE_BYTES`], every other part alone. The deadline is checked between
/// requests, never inside one.
///
/// # Errors
/// The state's or the spool's refusal; a gateway's refusal is a [`Stop`].
pub fn move_queue(
    state: &DeviceState,
    spool: &Spool,
    store: &dyn Store,
    deadline: Instant,
    clock: &dyn Clock,
) -> Result<Moved> {
    move_queue_where(state, spool, store, deadline, clock, &|_| true)
}

/// [`move_queue`] over the rows `admit` lets cross in this pass. A row it holds back stays
/// owed, untouched, for a pass that admits it: an original the member's rule keeps off a
/// metered link, a video the pass was asked to leave out, a part the operating system is
/// moving already.
///
/// `Stop::Empty` then means nothing admitted is left.
///
/// # Errors
/// As [`move_queue`].
pub fn move_queue_where(
    state: &DeviceState,
    spool: &Spool,
    store: &dyn Store,
    deadline: Instant,
    clock: &dyn Clock,
    admit: &dyn Fn(&Outbox) -> bool,
) -> Result<Moved> {
    let queue: Vec<Outbox> = state
        .outbox(store.gateway_id())?
        .into_iter()
        .filter(|row| sealed(row).is_some() && admit(row))
        .collect();
    let mut pass = Pass {
        state,
        spool,
        gateway: store.gateway_id().to_owned(),
        clock,
        moved: Moved {
            confirmed: Vec::new(),
            dropped: Vec::new(),
            errors: Vec::new(),
            stopped: Stop::Empty,
        },
        healed: BTreeSet::new(),
    };
    let size_of = |part: &Outbox| part.size.unwrap_or(0);
    let mut next = 0;
    while let Some(part) = queue.get(next) {
        if Instant::now() >= deadline {
            pass.moved.stopped = Stop::Deadline;
            return Ok(pass.moved);
        }
        let stop = if bundled(part, size_of(part)) {
            let mut run: Vec<&Outbox> = Vec::new();
            let mut bytes = 0_u64;
            while let Some(part) = queue
                .get(next)
                .filter(|part| bundled(part, size_of(part)))
            {
                let cost = size_of(part).saturating_add(FRAME_HEADER_BYTES);
                if bytes.saturating_add(cost) > BUNDLE_BYTES {
                    break;
                }
                bytes = bytes.saturating_add(cost);
                run.push(part);
                next += 1;
            }
            pass.bundle(store, &run)?
        } else {
            next += 1;
            pass.single(store, part)?
        };
        if let Some(stop) = stop {
            pass.moved.stopped = stop;
            return Ok(pass.moved);
        }
    }
    Ok(pass.moved)
}

/// What [`reconcile`] changed.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Reconciled {
    /// Owed names the gateway already held: let go of.
    pub confirmed: Vec<Name>,
}

/// Make the outbox agree with `store`'s own `exists` answer, for every name it owes the
/// gateway: a name the gateway holds is no longer owed. Nothing is asked about names not owed
/// (there is no list of what was acknowledged to ask about).
///
/// # Errors
/// The state's, the spool's or the store's refusal.
pub fn reconcile(
    state: &DeviceState,
    spool: &Spool,
    store: &dyn Store,
    clock: &dyn Clock,
) -> Result<Reconciled> {
    let gateway = store.gateway_id().to_owned();
    let rows: Vec<Outbox> = state
        .outbox(&gateway)?
        .into_iter()
        .filter(|row| row.waiting.is_none())
        .collect();
    let asked: Vec<Name> = rows.iter().map(|row| row.name).collect();
    let missing = store::missing(store, &asked)?;
    let held: Vec<Name> = asked
        .into_iter()
        .filter(|name| !missing.contains(name))
        .collect();
    if !held.is_empty() {
        release_many(state, spool, &gateway, &held, false)?;
        state.touch_ack(&gateway, now(clock))?;
    }
    Ok(Reconciled { confirmed: held })
}

/// [`reconcile`] under its old name: the outbox is the only queue now, so there is one.
///
/// # Errors
/// As [`reconcile`].
pub fn reconcile_queue(
    state: &DeviceState,
    spool: &Spool,
    store: &dyn Store,
    clock: &dyn Clock,
) -> Result<Reconciled> {
    reconcile(state, spool, store, clock)
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;
    use crate::backup::naming::{BackupKeys, Digest, PlaintextHash};
    use crate::backup::state::{Gateway, OutboxKind};
    use crate::backup::store::MemoryStore;
    use crate::clock::FixedClock;

    /// What a test calls a part, as the old queue did.
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    enum Kind {
        Range,
        Manifest,
        Original,
        Derivative,
    }

    fn kind_of(row: &Outbox) -> Kind {
        match row.kind {
            OutboxKind::Range | OutboxKind::Leaf => Kind::Range,
            OutboxKind::Manifest | OutboxKind::Directory => Kind::Manifest,
            OutboxKind::Blob if row.derivative => Kind::Derivative,
            OutboxKind::Blob => Kind::Original,
        }
    }

    struct Rig {
        _dir: tempfile::TempDir,
        state: DeviceState,
        spool: Spool,
        store: MemoryStore,
        clock: FixedClock,
    }

    fn gateway(id: &str, label: &str) -> Gateway {
        Gateway::paired(id.to_owned(), Vec::new(), Vec::new(), label.to_owned(), 1, 0)
    }

    fn rig() -> Rig {
        let dir = tempfile::tempdir().expect("a directory");
        let state = DeviceState::open(dir.path().join("v.state.db")).expect("a device state");
        let spool = Spool::open(dir.path().join("v.spool")).expect("a spool");
        let store = MemoryStore::new("gw");
        state.put_gateway(&gateway("gw", "laptop")).expect("pairs");
        Rig {
            _dir: dir,
            state,
            spool,
            store,
            clock: FixedClock::frozen(),
        }
    }

    /// The rows `gw` is owed.
    fn owed(rig: &Rig) -> Vec<Outbox> {
        rig.state.outbox("gw").expect("reads")
    }

    /// Spool a sealed part and owe it to every gateway paired now.
    fn queue(rig: &Rig, label: &str, kind: Kind) -> Name {
        let name = Name::from_bytes(*PlaintextHash::of(label.as_bytes()).as_bytes());
        let bytes = format!("sealed {label}").into_bytes();
        let path = rig.spool.write(&name, &bytes).expect("spools");
        for gateway in rig.state.gateways().expect("reads") {
            let mut row = Outbox::sealed(
                &gateway.gateway_id,
                name,
                match kind {
                    Kind::Range => OutboxKind::Range,
                    Kind::Manifest => OutboxKind::Manifest,
                    Kind::Original | Kind::Derivative => OutboxKind::Blob,
                },
                path.clone(),
                bytes.len() as u64,
                Digest::of(&bytes),
                now(&rig.clock),
            );
            if matches!(kind, Kind::Original | Kind::Derivative) {
                row.hash = Some(PlaintextHash::of(label.as_bytes()));
                row.media_type = Some("image/jpeg".to_owned());
                row.derivative = kind == Kind::Derivative;
            }
            rig.state.put_outbox(&row).expect("owes");
        }
        name
    }

    fn far() -> Instant {
        Instant::now() + Duration::from_secs(60)
    }

    fn pair_second(rig: &Rig) {
        rig.state.put_gateway(&gateway("gw2", "nas")).expect("pairs a second");
    }

    /// The gateways with a row for `name`.
    fn owing(rig: &Rig, name: &Name) -> Vec<String> {
        rig.state
            .gateways()
            .expect("reads")
            .into_iter()
            .filter(|gateway| {
                rig.state
                    .outbox_row(&gateway.gateway_id, name)
                    .expect("reads")
                    .is_some()
            })
            .map(|gateway| gateway.gateway_id)
            .collect()
    }

    #[test]
    fn a_pass_lets_go_of_what_was_acknowledged_and_empties_the_spool() {
        let rig = rig();
        let range = queue(&rig, "range", Kind::Range);
        let manifest = queue(&rig, "manifest", Kind::Manifest);
        let moved =
            move_queue(&rig.state, &rig.spool, &rig.store, far(), &rig.clock).expect("moves");
        assert_eq!(moved.stopped, Stop::Empty);
        assert_eq!(moved.confirmed, vec![range, manifest], "the manifest last");
        assert!(owed(&rig).is_empty());
        assert!(rig.spool.names().expect("lists").is_empty());
        assert!(
            rig.store
                .exists(&[range, manifest])
                .expect("asks")
                .is_empty()
        );
    }

    /// **A14.** A run of ranges and derivatives goes as one bundle; an
    /// original and the manifest go alone, in outbox order, the manifest
    /// after every range.
    #[test]
    fn ranges_and_derivatives_travel_in_bundles_and_the_rest_alone() {
        let rig = rig();
        let ranges: Vec<Name> = (0..40)
            .map(|index| queue(&rig, &format!("range {index}"), Kind::Range))
            .collect();
        let thumbnail = queue(&rig, "thumbnail", Kind::Derivative);
        let manifest = queue(&rig, "manifest", Kind::Manifest);
        let moved =
            move_queue(&rig.state, &rig.spool, &rig.store, far(), &rig.clock).expect("moves");
        assert_eq!(moved.stopped, Stop::Empty);
        assert_eq!(
            rig.store.bundles(),
            1,
            "forty ranges and a thumbnail, one request"
        );
        assert_eq!(moved.confirmed.last(), Some(&manifest));
        assert_eq!(moved.confirmed.len(), ranges.len() + 2);
        assert!(moved.confirmed.contains(&thumbnail));
        assert!(owed(&rig).is_empty());
        assert!(rig.spool.names().expect("lists").is_empty());

        // An original too large for a bundle goes as its own put: here, a small one is a
        // bundle's member, and the bundle count shows it.
        let original = queue(&rig, "original", Kind::Original);
        let moved =
            move_queue(&rig.state, &rig.spool, &rig.store, far(), &rig.clock).expect("moves");
        assert_eq!(moved.confirmed, vec![original]);
    }

    /// **B1.** One gateway's acknowledgement frees nothing while another still owes the part; it
    /// is sent to the other, and only then does the spool let go.
    #[test]
    fn a_part_stays_spooled_until_every_paired_gateway_holds_it() {
        let rig = rig();
        pair_second(&rig);
        let range = queue(&rig, "range", Kind::Range);
        let moved =
            move_queue(&rig.state, &rig.spool, &rig.store, far(), &rig.clock).expect("moves");
        assert_eq!(moved.confirmed, vec![range]);
        assert!(rig.spool.contains(&range), "the second still owes it");
        assert_eq!(owing(&rig, &range), vec!["gw2".to_owned()]);
        // The first is not sent it again.
        let again =
            move_queue(&rig.state, &rig.spool, &rig.store, far(), &rig.clock).expect("moves");
        assert!(again.confirmed.is_empty());

        let second = MemoryStore::new("gw2");
        let moved = move_queue(&rig.state, &rig.spool, &second, far(), &rig.clock).expect("moves");
        assert_eq!(moved.confirmed, vec![range]);
        assert!(!rig.spool.contains(&range), "nobody owes it now");
        assert!(owed(&rig).is_empty());
    }

    /// The wait for a gateway that is away is bounded: a day, then its rows and the file go and
    /// its blob walk starts again.
    #[test]
    fn the_wait_for_a_gateway_that_is_away_is_bounded() {
        let rig = rig();
        pair_second(&rig);
        rig.state.set_cursor("gw2", 40).expect("moves the cursor");
        let range = queue(&rig, "range", Kind::Range);
        let photo = queue(&rig, "photo", Kind::Original);
        move_queue(&rig.state, &rig.spool, &rig.store, far(), &rig.clock).expect("moves");
        assert!(rig.spool.contains(&range));
        let created = now(&rig.clock);
        assert_eq!(
            release_expired(&rig.state, &rig.spool, created + SPOOL_WAIT_MS - 1).expect("sweeps"),
            0
        );
        assert!(rig.spool.contains(&range));
        assert_eq!(
            release_expired(&rig.state, &rig.spool, created + SPOOL_WAIT_MS + 1).expect("sweeps"),
            2
        );
        assert!(!rig.spool.contains(&range) && !rig.spool.contains(&photo));
        assert!(rig.state.outbox("gw2").expect("reads").is_empty());
        assert_eq!(
            rig.state.gateway("gw2").expect("reads").expect("paired").cursor,
            0,
            "a blob was let go, so the walk starts again"
        );
    }

    /// A destination whose certificate is not the pinned one: every call is
    /// [`StoreError::Untrusted`], and nothing reaches it.
    struct Impostor;

    fn untrusted<T>() -> std::result::Result<T, StoreError> {
        Err(StoreError::Untrusted("another certificate".to_owned()))
    }

    impl Store for Impostor {
        fn gateway_id(&self) -> &'static str {
            "gw"
        }
        fn exists(&self, _: &[Name]) -> std::result::Result<Vec<Name>, StoreError> {
            untrusted()
        }
        fn put(
            &self,
            _: &Name,
            _: &Digest,
            _: u64,
            _: &mut dyn std::io::Read,
        ) -> std::result::Result<store::Put, StoreError> {
            untrusted()
        }
        fn get(
            &self,
            _: &Name,
            _: &mut dyn std::io::Write,
        ) -> std::result::Result<u64, StoreError> {
            untrusted()
        }
        fn head(&self) -> std::result::Result<Option<store::Head>, StoreError> {
            untrusted()
        }
        fn set_head(
            &self,
            _: &Name,
            _: Option<&Name>,
            _: u64,
            _: u64,
        ) -> std::result::Result<store::Head, StoreError> {
            untrusted()
        }
        fn snapshots(&self) -> std::result::Result<Vec<store::SnapshotEntry>, StoreError> {
            untrusted()
        }
        fn list(
            &self,
            _: Option<&Name>,
            _: usize,
        ) -> std::result::Result<Vec<store::ObjectEntry>, StoreError> {
            untrusted()
        }
        fn delete(&self, _: &[Name]) -> std::result::Result<store::Deleted, StoreError> {
            untrusted()
        }
        fn held(
            &self,
            _: Option<&Name>,
            _: usize,
        ) -> std::result::Result<Vec<store::HeldEntry>, StoreError> {
            untrusted()
        }
        fn undo(&self, _: Option<&[Name]>) -> std::result::Result<u64, StoreError> {
            untrusted()
        }
    }

    /// **NOT THE PINNED GATEWAY IS NOT AN ABSENT ONE** (#1080, the audit's finding 5): the pass
    /// stops `Untrusted`, and every part stays owed and spooled for the gateway that is.
    #[test]
    fn a_machine_that_is_not_the_gateway_stops_the_pass_untrusted() {
        let rig = rig();
        let range = queue(&rig, "range", Kind::Range);
        let original = queue(&rig, "original", Kind::Original);
        for only in [Kind::Range, Kind::Original] {
            let moved = move_queue_where(
                &rig.state,
                &rig.spool,
                &Impostor,
                far(),
                &rig.clock,
                &|part| kind_of(part) == only,
            )
            .expect("a pass");
            assert!(
                matches!(moved.stopped, Stop::Untrusted(_)),
                "{only:?}: {:?}",
                moved.stopped
            );
            assert!(moved.confirmed.is_empty());
        }
        assert_eq!(owed(&rig).len(), 2);
        assert!(rig.spool.contains(&range) && rig.spool.contains(&original));
    }

    /// A part the pass does not admit stays owed and untouched.
    #[test]
    fn a_part_the_pass_holds_back_stays_owed() {
        let rig = rig();
        let range = queue(&rig, "range", Kind::Range);
        let original = queue(&rig, "original", Kind::Original);
        let moved = move_queue_where(
            &rig.state,
            &rig.spool,
            &rig.store,
            far(),
            &rig.clock,
            &|part| kind_of(part) != Kind::Original,
        )
        .expect("moves");
        assert_eq!(moved.stopped, Stop::Empty);
        assert_eq!(moved.confirmed, vec![range]);
        assert!(rig.spool.contains(&original));
        assert_eq!(owed(&rig).len(), 1);
    }

    /// A bundle refused whole leaves every part in it owed, each with the attempt recorded;
    /// nothing is assumed stored.
    #[test]
    fn a_bundle_refused_whole_keeps_every_part_owed() {
        let rig = rig();
        let first = queue(&rig, "first", Kind::Range);
        let second = queue(&rig, "second", Kind::Range);
        let _taken_over = rig.store.claim();
        let moved =
            move_queue(&rig.state, &rig.spool, &rig.store, far(), &rig.clock).expect("moves");
        assert_eq!(moved.stopped, Stop::Moved { epoch: 2 });
        assert!(moved.confirmed.is_empty());
        assert!(rig.spool.contains(&first) && rig.spool.contains(&second));
        assert_eq!(owed(&rig).len(), 2);
    }

    #[test]
    fn the_deadline_is_checked_between_parts_and_nothing_is_assumed() {
        let rig = rig();
        let first = queue(&rig, "first", Kind::Range);
        let moved = move_queue(
            &rig.state,
            &rig.spool,
            &rig.store,
            Instant::now(),
            &rig.clock,
        )
        .expect("moves");
        assert_eq!(moved.stopped, Stop::Deadline);
        assert!(moved.confirmed.is_empty());
        assert_eq!(owed(&rig).len(), 1);
        assert!(rig.spool.contains(&first));
    }

    /// **Decision 30.** A name the gateway holds under other bytes is not this part stored: it
    /// is never counted as acknowledged, and the part stays owed and spooled.
    #[test]
    fn name_taken_by_other_bytes_is_not_an_acknowledgement() {
        let rig = rig();
        let name = queue(&rig, "photo", Kind::Original);
        let other = b"an earlier sealing of the same plaintext";
        rig.store
            .put(
                &name,
                &Digest::of(other),
                other.len() as u64,
                &mut &other[..],
            )
            .expect("the earlier pass stored it");
        let moved =
            move_queue(&rig.state, &rig.spool, &rig.store, far(), &rig.clock).expect("moves");
        assert!(moved.confirmed.is_empty());
        assert!(rig.state.outbox_row("gw", &name).expect("asks").is_some());
        assert!(rig.spool.contains(&name));
    }

    #[test]
    fn a_corrupt_or_vanished_spool_file_is_unsealed_to_be_sealed_again() {
        let rig = rig();
        let corrupt = queue(&rig, "corrupt", Kind::Range);
        let vanished = queue(&rig, "vanished", Kind::Range);
        std::fs::write(rig.spool.path(&corrupt), b"not what was queued").expect("corrupts");
        rig.spool.remove(&vanished).expect("removes");
        let moved =
            move_queue(&rig.state, &rig.spool, &rig.store, far(), &rig.clock).expect("moves");
        assert_eq!(moved.stopped, Stop::Empty);
        let mut dropped = moved.dropped.clone();
        dropped.sort();
        let mut expected = vec![vanished];
        expected.sort();
        // THE CORRUPT FILE READS (its bytes are what they are) and the gateway refuses its
        // digest; the vanished one never goes. Either way nothing is acknowledged.
        assert!(moved.confirmed.is_empty() || moved.confirmed == vec![corrupt]);
        assert!(dropped.contains(&vanished));
        assert!(
            owed(&rig)
                .iter()
                .all(|row| row.name != vanished || row.part_path.is_none()),
            "the vanished part waits to be sealed again"
        );
    }

    #[test]
    fn a_superseded_writer_stops_and_keeps_its_outbox() {
        let rig = rig();
        let name = queue(&rig, "late", Kind::Range);
        let _taken_over = rig.store.claim();
        let moved =
            move_queue(&rig.state, &rig.spool, &rig.store, far(), &rig.clock).expect("moves");
        assert_eq!(moved.stopped, Stop::Moved { epoch: 2 });
        assert!(rig.spool.contains(&name), "nothing is thrown away");
        assert_eq!(owed(&rig).len(), 1);
    }

    /// A destination whose disk is full until a test frees it: every write
    /// is refused with `refusal` (`DISK_FULL` unless a test says another),
    /// everything else is the memory store's.
    struct Full<'a> {
        inner: &'a MemoryStore,
        full: std::cell::Cell<bool>,
        refusal: Refusal,
    }

    impl Store for Full<'_> {
        fn gateway_id(&self) -> &str {
            self.inner.gateway_id()
        }
        fn exists(&self, names: &[Name]) -> std::result::Result<Vec<Name>, StoreError> {
            self.inner.exists(names)
        }
        fn put(
            &self,
            name: &Name,
            digest: &Digest,
            len: u64,
            body: &mut dyn std::io::Read,
        ) -> std::result::Result<store::Put, StoreError> {
            if self.full.get() {
                return Err(StoreError::Refused(self.refusal.clone()));
            }
            self.inner.put(name, digest, len, body)
        }
        fn get(
            &self,
            name: &Name,
            sink: &mut dyn std::io::Write,
        ) -> std::result::Result<u64, StoreError> {
            self.inner.get(name, sink)
        }
        fn head(&self) -> std::result::Result<Option<store::Head>, StoreError> {
            self.inner.head()
        }
        fn set_head(
            &self,
            name: &Name,
            prev: Option<&Name>,
            taken_at_ms: u64,
            writes: u64,
        ) -> std::result::Result<store::Head, StoreError> {
            self.inner.set_head(name, prev, taken_at_ms, writes)
        }
        fn snapshots(&self) -> std::result::Result<Vec<store::SnapshotEntry>, StoreError> {
            self.inner.snapshots()
        }
        fn list(
            &self,
            after: Option<&Name>,
            limit: usize,
        ) -> std::result::Result<Vec<store::ObjectEntry>, StoreError> {
            self.inner.list(after, limit)
        }
        fn delete(&self, names: &[Name]) -> std::result::Result<store::Deleted, StoreError> {
            self.inner.delete(names)
        }
        fn held(
            &self,
            after: Option<&Name>,
            limit: usize,
        ) -> std::result::Result<Vec<store::HeldEntry>, StoreError> {
            self.inner.held(after, limit)
        }
        fn undo(&self, names: Option<&[Name]>) -> std::result::Result<u64, StoreError> {
            self.inner.undo(names)
        }
    }

    /// **A FULL DISK ON THE GATEWAY BACKS NOTHING UP, AND THE PASS AFTER THE ROOM COMES BACK
    /// FINISHES** (#1080, the sweep's B4). Every part stays owed and spooled with the refusal
    /// recorded as its attempt, nothing is let go, and once the disk has room the next pass moves
    /// them all.
    #[test]
    fn a_full_disk_acknowledges_nothing_and_the_pass_after_it_finishes() {
        let rig = rig();
        let ranges: Vec<Name> = (0..3)
            .map(|index| queue(&rig, &format!("range {index}"), Kind::Range))
            .collect();
        let original = queue(&rig, "original", Kind::Original);
        let full = Full {
            inner: &rig.store,
            full: std::cell::Cell::new(true),
            refusal: Refusal::DiskFull,
        };
        let refused =
            move_queue(&rig.state, &rig.spool, &full, far(), &rig.clock).expect("a pass");
        assert_eq!(refused.stopped, Stop::Refused(Refusal::DiskFull));
        assert!(refused.confirmed.is_empty());
        let queued = owed(&rig);
        assert_eq!(queued.len(), 4, "every part waits");
        assert!(
            queued
                .iter()
                .filter(|part| part.attempts > 0)
                .all(|part| part.last_error.as_deref() == Some("DISK_FULL")),
            "the refusal is the attempt's outcome"
        );
        assert!(
            ranges
                .iter()
                .chain([&original])
                .all(|name| rig.spool.contains(name))
        );

        full.full.set(false);
        let moved = move_queue(&rig.state, &rig.spool, &full, far(), &rig.clock).expect("a pass");
        assert_eq!(moved.stopped, Stop::Empty);
        assert_eq!(moved.confirmed.len(), 4);
        assert!(owed(&rig).is_empty());
        assert!(rig.spool.names().expect("lists").is_empty());
    }

    /// **A REFUSAL THAT IS NOT A FULL DISK STOPS THE PASS TOO** (#1080, the sweep's F1): a quota
    /// or a cap the gateway names is its answer, not a part to skip, so the pass stops on it with
    /// every part still owed and spooled.
    #[test]
    fn a_quota_or_a_cap_stops_the_pass_with_every_part_kept() {
        for refusal in [
            Refusal::TooLarge,
            Refusal::Other("QUOTA".to_owned()),
            Refusal::Unauthorized,
        ] {
            let rig = rig();
            let names: Vec<Name> = (0..3)
                .map(|index| queue(&rig, &format!("part {index}"), Kind::Original))
                .collect();
            let refusing = Full {
                inner: &rig.store,
                full: std::cell::Cell::new(true),
                refusal: refusal.clone(),
            };
            let moved =
                move_queue(&rig.state, &rig.spool, &refusing, far(), &rig.clock).expect("a pass");
            assert_eq!(moved.stopped, Stop::Refused(refusal.clone()), "{refusal:?}");
            assert!(moved.confirmed.is_empty(), "{refusal:?}");
            let queued = owed(&rig);
            assert_eq!(queued.len(), 3, "{refusal:?}");
            assert!(names.iter().all(|name| rig.spool.contains(name)));
            let attempted: Vec<&Outbox> = queued.iter().filter(|row| row.attempts > 0).collect();
            assert_eq!(attempted.len(), 1, "the pass stopped at the first answer");
            assert_eq!(
                attempted[0].last_error.as_deref(),
                Some(refusal.code()),
                "the refusal is the attempt's outcome"
            );
        }
    }

    /// Reconcile lets go of what the gateway already holds, and asks about nothing else.
    #[test]
    fn reconcile_lets_go_of_what_the_gateway_holds() {
        let rig = rig();
        let held = queue(&rig, "held", Kind::Range);
        let owed_still = queue(&rig, "owed", Kind::Range);
        let bytes = std::fs::read(rig.spool.path(&held)).expect("reads");
        rig.store
            .put(
                &held,
                &Digest::of(&bytes),
                bytes.len() as u64,
                &mut &bytes[..],
            )
            .expect("stores");
        let reconciled =
            reconcile(&rig.state, &rig.spool, &rig.store, &rig.clock).expect("reconciles");
        assert_eq!(reconciled.confirmed, vec![held]);
        assert_eq!(owed(&rig).len(), 1);
        assert!(!rig.spool.contains(&held));
        assert!(rig.spool.contains(&owed_still));
    }

    /// **A BUNDLE'S ANSWER IS ONE TRANSACTION TO LET GO,** not several per part: counted in
    /// commits, never timed.
    #[test]
    fn a_bundle_is_released_in_a_fixed_number_of_commits() {
        let rig = rig();
        for index in 0..40 {
            queue(&rig, &format!("range {index}"), Kind::Range);
        }
        let before = rig.state.commit_count();
        let moved =
            move_queue(&rig.state, &rig.spool, &rig.store, far(), &rig.clock).expect("moves");
        assert_eq!(moved.confirmed.len(), 40);
        assert!(
            rig.state.commit_count() - before <= 3,
            "forty parts: one commit to let go and one to note the acknowledgement, not forty"
        );
        assert!(rig.spool.names().expect("lists").is_empty());
    }

    /// **A POISON SPOOL FILE DOES NOT BLOCK THE PASS.** One that exists and cannot be opened is
    /// unsealed like a missing one, to be sealed again, and the error is on the answer; the parts
    /// after it still move. (Skipped by construction where the file can be opened anyway: a
    /// process that ignores file modes, such as root.)
    #[cfg(unix)]
    #[test]
    fn an_unreadable_spool_file_is_unsealed_and_the_pass_goes_on() {
        use std::os::unix::fs::PermissionsExt;

        let rig = rig();
        let poison = queue(&rig, "poison", Kind::Original);
        let good = queue(&rig, "good", Kind::Range);
        std::fs::set_permissions(
            rig.spool.path(&poison),
            std::fs::Permissions::from_mode(0o000),
        )
        .expect("locks it");
        if std::fs::File::open(rig.spool.path(&poison)).is_ok() {
            return;
        }
        let moved =
            move_queue(&rig.state, &rig.spool, &rig.store, far(), &rig.clock).expect("moves");
        assert_eq!(moved.stopped, Stop::Empty);
        assert_eq!(moved.dropped, vec![poison]);
        assert_eq!(moved.errors.len(), 1);
        assert_eq!(moved.errors[0].0, poison);
        assert!(moved.errors[0].1.contains("cannot be read"));
        assert_eq!(moved.confirmed, vec![good]);
        let row = rig
            .state
            .outbox_row("gw", &poison)
            .expect("asks")
            .expect("still owed");
        assert!(row.part_path.is_none(), "waiting to be sealed again");
        assert!(!rig.spool.contains(&poison));
    }

    /// **THE SAME PART REFUSED AS DAMAGED THREE TIMES IN A ROW STOPS THAT GATEWAY'S PASS,**
    /// named by the refusal's own code; an acknowledgement ends the count.
    #[test]
    fn three_digest_mismatches_in_a_row_stop_the_pass_and_an_acknowledgement_clears_them() {
        let rig = rig();
        let flaky = Full {
            inner: &rig.store,
            full: std::cell::Cell::new(true),
            refusal: Refusal::DigestMismatch,
        };
        let mut name = None;
        for round in 1..=MISMATCH_LIMIT {
            // Sealed again from the vault, as a pass does after unsealing it.
            name = Some(queue(&rig, "torn", Kind::Original));
            let moved =
                move_queue(&rig.state, &rig.spool, &flaky, far(), &rig.clock).expect("moves");
            let name = name.expect("queued");
            assert_eq!(moved.dropped, vec![name], "round {round}");
            let row = rig.state.outbox_row("gw", &name).expect("asks").expect("owed");
            assert_eq!(row.attempts, round, "round {round}");
            if round < MISMATCH_LIMIT {
                assert_eq!(moved.stopped, Stop::Empty, "round {round}");
            } else {
                assert_eq!(
                    moved.stopped,
                    Stop::Refused(Refusal::DigestMismatch),
                    "the third stops the pass"
                );
            }
        }
        let name = name.expect("queued");
        flaky.full.set(false);
        queue(&rig, "torn", Kind::Original);
        let moved = move_queue(&rig.state, &rig.spool, &flaky, far(), &rig.clock).expect("moves");
        assert_eq!(moved.confirmed, vec![name]);
        assert!(rig.state.outbox_row("gw", &name).expect("asks").is_none());
    }

    /// A zero-byte blob seals to a part like any other, is acknowledged and read back.
    #[test]
    fn a_zero_byte_blob_is_sealed_sent_and_acknowledged() {
        let rig = rig();
        let keys = BackupKeys::from_root(&[9; 32]);
        let hash = PlaintextHash::of(b"");
        let names = super::super::naming::names_of(&keys, &hash, 0);
        assert_eq!(names.len(), 1, "an empty file is still one part");
        let sealed = centraid_media::sealed::seal_part(&keys, 0, b"", true).expect("seals");
        let path = rig.spool.write(&names[0], &sealed).expect("spools");
        let mut row = Outbox::sealed(
            "gw",
            names[0],
            OutboxKind::Blob,
            path,
            sealed.len() as u64,
            Digest::of(&sealed),
            1,
        );
        row.hash = Some(hash);
        row.media_type = Some("image/jpeg".to_owned());
        rig.state.put_outbox(&row).expect("owes");
        let moved =
            move_queue(&rig.state, &rig.spool, &rig.store, far(), &rig.clock).expect("moves");
        assert_eq!(moved.confirmed, vec![names[0]]);
        let mut held = Vec::new();
        rig.store.get(&names[0], &mut held).expect("reads back");
        let opened = centraid_media::sealed::open_part(&keys, &held).expect("opens");
        assert!(opened.plaintext.is_empty());
    }

    /// With the last gateway forgotten nothing on the phone is owed to anyone: the outbox goes
    /// with its rows and the spool is swept; with one still paired it is not.
    #[test]
    fn forgetting_the_last_gateway_sweeps_the_outbox_and_the_spool() {
        let rig = rig();
        pair_second(&rig);
        let part = queue(&rig, "waiting", Kind::Range);
        rig.state.remove_gateway("gw").expect("forgets one");
        assert_eq!(sweep_unowed(&rig.state, &rig.spool).expect("sweeps"), 0);
        assert!(rig.spool.contains(&part), "the other still owes it");
        rig.state.remove_gateway("gw2").expect("forgets the last");
        std::fs::write(rig.spool.dir().join("f".repeat(64)), b"a stray").expect("a stray file");
        assert!(sweep_unowed(&rig.state, &rig.spool).expect("sweeps") > 0);
        assert!(owed(&rig).is_empty());
        assert!(
            rig.spool.names().expect("lists").is_empty(),
            "stray files go too"
        );
    }
}
