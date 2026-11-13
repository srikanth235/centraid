//! The mover: send queued parts to a destination and record what it
//! acknowledged (#1080 ruling 7).
//!
//! **Acknowledgement is the `PUT`'s success.** A part is confirmed in the
//! ledger only when the destination answered that it holds it, and only then
//! does its spool file go. A `NAME_TAKEN` answer is an acknowledgement too
//! (R-1080-B4): a name is a function of the plaintext, so the destination
//! already holds a sealing of exactly these bytes — the one a crash kept this
//! device from recording.
//!
//! **EVERY PAIRED DESTINATION IS A FULL REPLICA** (#1188, B1). A part leaves
//! the spool when no paired destination still owes it ([`release`]): one
//! destination's acknowledgement frees nothing while another, paired and
//! not superseded, has not yet been sent the part. The wait for a destination
//! that is away or full is bounded by [`SPOOL_WAIT_MS`]; past it the part
//! is released and that destination is re-fed from the vault by its own `exists`
//! on a later pass (names are functions of the plaintext, so sealing again
//! is cheap and exact). [`release_to_reachable`] ends the wait early when the
//! spool needs the room.
//!
//! ## RANGES AND DERIVATIVES TRAVEL IN BUNDLES
//!
//! A snapshot is hundreds of 64 KiB ranges and a photograph brings a
//! thumbnail and a preview of a few dozen KiB each, so a request per part
//! would spend the pass on round trips. A run of them in queue order goes as
//! one [`Store::put_many`] of up to [`BUNDLE_BYTES`], answered part by part
//! exactly as each `put` would be (the root's rulings A14 and A15). An
//! original's part — up to 64 MiB — goes alone, and so does a manifest, which
//! the queue orders after every range, so it can never ride in a bundle ahead
//! of one.
//!
//! **A BUNDLE'S ANSWERS ARE CONFIRMED TOGETHER**: the parts it acknowledged go into the ledger in
//! one transaction and leave the queue in one more ([`release_many`]), not several commits per
//! part. A spool file that exists and cannot be read is dropped like a missing one and sealed
//! again; the same part answered `DIGEST_MISMATCH` [`MISMATCH_LIMIT`] times in a row by one
//! destination stops the pass to it, as the refusal `DIGEST_MISMATCH`.
//!
//! [`reconcile`] makes the ledger a cache of the destination's truth: every
//! queued and every confirmed name is asked about, and the ledger follows the
//! answer in both directions.

use std::collections::{BTreeMap, BTreeSet};
use std::time::Instant;

use super::Result;
use super::ledger::{Ledger, PartKind, Queued};
use super::naming::Name;
use super::spool::Spool;
use super::store::{self, BUNDLE_BYTES, FRAME_HEADER_BYTES, Outgoing, Refusal, Store, StoreError};
use crate::clock::Clock;

/// Why a pass stopped moving.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Stop {
    /// Nothing is left to move.
    Empty,
    /// The pass's time is up; the rest waits for the next.
    Deadline,
    /// The destination could not be reached; nothing is assumed stored.
    Unreachable(String),
    /// The machine that answered is not the paired destination; nothing is
    /// sent to it.
    Untrusted(String),
    /// A newer writer claimed the vault: this device stops writing.
    Moved { epoch: u64 },
    /// The destination answered and refused, for a reason that stops the
    /// pass: its disk is full, a quota, a cap, or a token it no longer knows
    /// (`UNAUTHORIZED`). Nothing was acknowledged; every part stays queued.
    Refused(Refusal),
}

/// What a pass moved.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Moved {
    /// Confirmed at the destination and gone from the spool.
    pub confirmed: Vec<Name>,
    /// Dropped from the queue to be sealed again: their spool file was gone
    /// or was not the bytes queued.
    pub dropped: Vec<Name>,
    /// Why a part was dropped for a cause worth naming: a spool file that exists and cannot
    /// be read (it is dropped like a missing one and sealed again), and a part this
    /// destination refused as damaged. Also a subset of `dropped`.
    pub errors: Vec<(Name, String)>,
    pub stopped: Stop,
}

/// How many times in a row one destination may answer `DIGEST_MISMATCH` for the same part
/// before the pass to it stops: the part was dropped and sealed again each time, so a third
/// is not a torn spool file but a destination (or a link) that damages what it is sent.
pub const MISMATCH_LIMIT: u32 = 3;

fn now(clock: &dyn Clock) -> u64 {
    u64::try_from(clock.now_ms()).unwrap_or(0)
}

/// How long a sealed part is kept in the spool for a paired destination that has not
/// acknowledged it (away, full, refusing): a day. Past it the part is released and that
/// destination is fed again from the vault when it next answers.
pub const SPOOL_WAIT_MS: u64 = 24 * 60 * 60 * 1000;

/// A part a destination just acknowledged: free it from the spool if no paired destination
/// still owes it, else keep it for them (and, with `unhand`, take it back from the operating
/// system, which was carrying it to the one that has it). Answers whether the part left the spool.
///
/// # Errors
/// The ledger's or the spool's refusal.
pub fn release(
    ledger: &Ledger,
    spool: &Spool,
    part: &Queued,
    now_ms: u64,
    unhand: bool,
) -> Result<bool> {
    let owed = ledger.owing(&part.name)?;
    let waiting = !owed.is_empty() && now_ms.saturating_sub(part.created_ms) < SPOOL_WAIT_MS;
    if waiting {
        if unhand {
            ledger.unhand(&part.name)?;
        }
        return Ok(false);
    }
    ledger.dequeue(&part.name)?;
    spool.remove(&part.name)?;
    Ok(true)
}

/// [`release`] for a batch of parts a destination just acknowledged: the ones no paired
/// destination still owes leave the queue in ONE transaction and the spool afterwards, and
/// the ones still owed are taken back from the operating system (with `unhand`) in one.
/// Answers how many parts left the spool.
///
/// # Errors
/// The ledger's or the spool's refusal.
pub fn release_many(
    ledger: &Ledger,
    spool: &Spool,
    parts: &[&Queued],
    now_ms: u64,
    unhand: bool,
) -> Result<usize> {
    let mut leaving: Vec<Name> = Vec::new();
    let mut keeping: Vec<Name> = Vec::new();
    for part in parts {
        let waiting = !ledger.owing(&part.name)?.is_empty()
            && now_ms.saturating_sub(part.created_ms) < SPOOL_WAIT_MS;
        if waiting {
            keeping.push(part.name);
        } else {
            leaving.push(part.name);
        }
    }
    if unhand {
        ledger.unhand_many(&keeping)?;
    }
    ledger.dequeue_many(&leaving)?;
    for name in &leaving {
        spool.remove(name)?;
    }
    Ok(leaving.len())
}

/// With no gateway paired nothing in the queue or the spool is owed to anyone: sweep both, so
/// a member who forgot their last gateway has nothing of the backup left on the phone but the
/// ledger's own rows. Does nothing while any gateway is paired. Answers how many parts it
/// swept.
///
/// # Errors
/// The ledger's or the spool's refusal.
pub fn sweep_unowed(ledger: &Ledger, spool: &Spool) -> Result<usize> {
    if !ledger.destinations()?.is_empty() {
        return Ok(0);
    }
    let swept = ledger.sweep_unowed()?;
    for name in &swept {
        spool.remove(name)?;
    }
    // A file no queue row names (a crash left it) is as unowed as one that had a row.
    spool.sweep_unqueued(&BTreeSet::new())?;
    Ok(swept.len())
}

/// Release every queued part that some destination holds and that has waited [`SPOOL_WAIT_MS`]
/// for the ones that do not: the bounded end of the wait. Answers how many were released.
///
/// # Errors
/// The ledger's or the spool's refusal.
pub fn release_expired(ledger: &Ledger, spool: &Spool, now_ms: u64) -> Result<usize> {
    let Some(waited_by) = now_ms.checked_sub(SPOOL_WAIT_MS) else {
        return Ok(0);
    };
    let expired: Vec<Name> = ledger
        .queued_held_anywhere(Some(waited_by))?
        .iter()
        .map(|part| part.name)
        .collect();
    ledger.dequeue_many(&expired)?;
    for name in &expired {
        spool.remove(name)?;
    }
    Ok(expired.len())
}

/// End the wait for the destinations that did not answer: every queued part some destination
/// holds and every destination in `reachable` holds leaves the spool, whoever else owes it.
/// What a pass runs when the spool is at its budget and the room is needed. Answers how many
/// parts were released.
///
/// # Errors
/// The ledger's or the spool's refusal.
pub fn release_to_reachable(ledger: &Ledger, spool: &Spool, reachable: &[String]) -> Result<usize> {
    let mut leaving: Vec<Name> = Vec::new();
    for part in ledger.queued_held_anywhere(None)? {
        if ledger
            .owing(&part.name)?
            .iter()
            .all(|owed| !reachable.contains(owed))
        {
            leaving.push(part.name);
        }
    }
    ledger.dequeue_many(&leaving)?;
    for name in &leaving {
        spool.remove(name)?;
    }
    Ok(leaving.len())
}

/// Whether `part` rides in a bundle: a range or a derivative small enough
/// for one. Everything else goes as its own `put`.
fn bundled(part: &Queued) -> bool {
    matches!(part.kind, PartKind::Range | PartKind::Derivative)
        && part.size.saturating_add(FRAME_HEADER_BYTES) <= BUNDLE_BYTES
}

/// One pass's bookkeeping: what the destination's answers did to the ledger
/// and the spool.
struct Pass<'a> {
    ledger: &'a Ledger,
    spool: &'a Spool,
    gateway: String,
    clock: &'a dyn Clock,
    moved: Moved,
}

impl Pass<'_> {
    /// The destination holds a sealing of each of `parts`: confirm them in one transaction and
    /// free the spool of the ones no other paired destination owes.
    fn acknowledged(&mut self, parts: &[&Queued]) -> Result<()> {
        if parts.is_empty() {
            return Ok(());
        }
        let at = now(self.clock);
        let sized: Vec<(Name, u64)> = parts.iter().map(|part| (part.name, part.size)).collect();
        self.ledger.acknowledge_many(&sized, &self.gateway, at)?;
        release_many(self.ledger, self.spool, parts, at, true)?;
        self.moved
            .confirmed
            .extend(parts.iter().map(|part| part.name));
        Ok(())
    }

    /// The spool file is gone, cannot be read, or is not the bytes queued: drop the part, to be
    /// sealed again from the vault. `why` is recorded when the file was there and was no good.
    fn torn(&mut self, part: &Queued, why: Option<String>) -> Result<()> {
        self.ledger.dequeue(&part.name)?;
        self.spool.remove(&part.name)?;
        self.moved.dropped.push(part.name);
        if let Some(why) = why {
            self.moved.errors.push((part.name, why));
        }
        Ok(())
    }

    /// Act on a batch of answers, one per part; a refusal that stops the pass is returned.
    /// The acknowledged parts are confirmed together, and the first stop wins.
    fn answered(
        &mut self,
        answers: Vec<(&Queued, std::result::Result<(), Refusal>)>,
    ) -> Result<Option<Stop>> {
        let mut acknowledged: Vec<&Queued> = Vec::new();
        let mut stop = None;
        for (part, answer) in answers {
            match answer {
                Ok(()) | Err(Refusal::NameTaken) => acknowledged.push(part),
                Err(Refusal::DigestMismatch) => {
                    // THE PART IS SEALED AGAIN, BUT NOT FOREVER: the same part, refused as
                    // damaged by the same destination `MISMATCH_LIMIT` times in a row, is a
                    // destination or a link that damages what it is sent. The pass to it stops,
                    // named by the refusal's own code, and the count stays until the part is
                    // acknowledged there.
                    let count = self.ledger.count_mismatch(&part.name, &self.gateway)?;
                    self.torn(part, Some(Refusal::DigestMismatch.code().to_owned()))?;
                    if count >= MISMATCH_LIMIT && stop.is_none() {
                        stop = Some(Stop::Refused(Refusal::DigestMismatch));
                    }
                }
                // EVERY OTHER REFUSAL STOPS THE PASS, `TOO_LARGE` AND A FULL DISK
                // ALIKE (#1080, the sweep's F1): the destination answered, and
                // what it answered is a fact the member hears, not a part to skip
                // — no part of this format is past the cap, so a destination that
                // says so is not one this phone can finish a pass at. The attempt
                // is recorded and every part stays queued, spooled, unconfirmed.
                Err(refusal) => {
                    self.ledger.record_attempt(&part.name, refusal.code())?;
                    stop.get_or_insert(Stop::Refused(refusal));
                }
            }
        }
        self.acknowledged(&acknowledged)?;
        Ok(stop)
    }

    /// A request that was not answered at all: every part in it waits.
    fn unanswered(&mut self, parts: &[&Queued], error: StoreError) -> Result<Stop> {
        Ok(match error {
            StoreError::Moved { epoch } => Stop::Moved { epoch },
            StoreError::Refused(refusal) => {
                for part in parts {
                    self.ledger.record_attempt(&part.name, refusal.code())?;
                }
                Stop::Refused(refusal)
            }
            error => {
                let detail = error.to_string();
                for part in parts {
                    self.ledger.record_attempt(&part.name, &detail)?;
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
    /// be opened, drops the part to be sealed again: a poison file never blocks the pass.
    fn single(&mut self, store: &dyn Store, part: &Queued) -> Result<Option<Stop>> {
        let mut body = match self.spool.read(&part.name) {
            Ok(file) => file,
            Err(_) if !self.spool.contains(&part.name) => {
                self.torn(part, None)?;
                return Ok(None);
            }
            Err(error) => {
                self.torn(
                    part,
                    Some(format!("the spool file cannot be read: {error}")),
                )?;
                return Ok(None);
            }
        };
        let put = store.put(&part.name, &part.digest, part.size, &mut body);
        drop(body);
        match put {
            Ok(_) => self.answered(vec![(part, Ok(()))]),
            Err(StoreError::Refused(refusal)) => self.answered(vec![(part, Err(refusal))]),
            Err(error) => self.unanswered(&[part], error).map(Some),
        }
    }

    /// Send a run of parts as one bundle. A part whose spool file is gone, or is there and is
    /// not a file that can be opened, is dropped before the request; the rest are answered
    /// together.
    fn bundle(&mut self, store: &dyn Store, run: &[&Queued]) -> Result<Option<Stop>> {
        let mut sent: Vec<&Queued> = Vec::with_capacity(run.len());
        for part in run {
            if !self.spool.contains(&part.name) {
                self.torn(part, None)?;
            } else if let Err(error) = self.spool.read(&part.name) {
                self.torn(
                    part,
                    Some(format!("the spool file cannot be read: {error}")),
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
            .map(|part| Outgoing {
                name: part.name,
                digest: part.digest,
                len: part.size,
                path: self.spool.path(&part.name),
            })
            .collect();
        let answers = match store.put_many(&outgoing) {
            Ok(answers) => answers,
            Err(error) => return self.unanswered(&sent, error).map(Some),
        };
        let by_name: BTreeMap<Name, &Queued> = sent.iter().map(|part| (part.name, *part)).collect();
        // An answer for a name this bundle did not carry says nothing about the queue; a part
        // left unanswered waits for the next pass.
        let answered: Vec<(&Queued, std::result::Result<(), Refusal>)> = answers
            .into_iter()
            .filter_map(|(name, answer)| Some((*by_name.get(&name)?, answer.map(|_| ()))))
            .collect();
        self.answered(answered)
    }
}

/// Send queued parts to `store` in queue order until the queue is empty, the
/// deadline passes or the destination stops answering: runs of ranges and
/// derivatives as bundles of up to [`BUNDLE_BYTES`], every other part alone.
/// The deadline is checked between requests, never inside one.
///
/// # Errors
/// The ledger's or the spool's refusal; a destination's refusal is a [`Stop`].
pub fn move_queue(
    ledger: &Ledger,
    spool: &Spool,
    store: &dyn Store,
    deadline: Instant,
    clock: &dyn Clock,
) -> Result<Moved> {
    move_queue_where(ledger, spool, store, deadline, clock, &|_| true)
}

/// [`move_queue`] over the queued parts `admit` lets cross in this pass. A
/// part it holds back stays queued, untouched, for a pass that admits it: an
/// original the member's rule keeps off a metered link, a video the pass was
/// asked to leave out, a part the operating system is moving already.
///
/// `Stop::Empty` then means nothing admitted is left.
///
/// # Errors
/// As [`move_queue`].
pub fn move_queue_where(
    ledger: &Ledger,
    spool: &Spool,
    store: &dyn Store,
    deadline: Instant,
    clock: &dyn Clock,
    admit: &dyn Fn(&Queued) -> bool,
) -> Result<Moved> {
    // A PART THIS DESTINATION HOLDS IS NOT SENT TO IT AGAIN: it stays queued only for the
    // destinations that still owe it.
    let queue: Vec<Queued> = ledger
        .queued_unconfirmed(store.gateway_id())?
        .into_iter()
        .filter(|part| admit(part))
        .collect();
    let mut pass = Pass {
        ledger,
        spool,
        gateway: store.gateway_id().to_owned(),
        clock,
        moved: Moved {
            confirmed: Vec::new(),
            dropped: Vec::new(),
            errors: Vec::new(),
            stopped: Stop::Empty,
        },
    };
    let mut next = 0;
    while let Some(part) = queue.get(next) {
        if Instant::now() >= deadline {
            pass.moved.stopped = Stop::Deadline;
            return Ok(pass.moved);
        }
        let stop = if bundled(part) {
            let mut run: Vec<&Queued> = Vec::new();
            let mut bytes = 0_u64;
            while let Some(part) = queue.get(next).filter(|part| bundled(part)) {
                let cost = part.size.saturating_add(FRAME_HEADER_BYTES);
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
    /// Queued names the destination already held: confirmed and dequeued.
    pub confirmed: Vec<Name>,
    /// Confirmed names the destination no longer holds: unconfirmed, to be
    /// prepared again.
    pub unconfirmed: Vec<Name>,
}

/// Make the ledger agree with `store`'s own `exists` answer, for every queued
/// name and every name confirmed there.
///
/// # Errors
/// The ledger's, the spool's or the store's refusal.
pub fn reconcile(
    ledger: &Ledger,
    spool: &Spool,
    store: &dyn Store,
    clock: &dyn Clock,
) -> Result<Reconciled> {
    reconcile_names(ledger, spool, store, clock, true)
}

/// [`reconcile`] over the queue alone: every queued name the destination
/// already holds is confirmed and leaves the spool, and no confirmed name is
/// asked about again. What a phone runs before each batch it hands the
/// operating system, where asking about every name ever confirmed — tens of
/// thousands on a library — would be the batch's cost many times over; the
/// whole reconcile runs once a launch.
///
/// # Errors
/// As [`reconcile`].
pub fn reconcile_queue(
    ledger: &Ledger,
    spool: &Spool,
    store: &dyn Store,
    clock: &dyn Clock,
) -> Result<Reconciled> {
    reconcile_names(ledger, spool, store, clock, false)
}

fn reconcile_names(
    ledger: &Ledger,
    spool: &Spool,
    store: &dyn Store,
    clock: &dyn Clock,
    with_confirmed: bool,
) -> Result<Reconciled> {
    let gateway = store.gateway_id().to_owned();
    let queued = ledger.queued()?;
    let confirmed = if with_confirmed {
        ledger.confirmed_names(&gateway)?
    } else {
        BTreeSet::new()
    };
    let mut asked: BTreeSet<Name> = confirmed.clone();
    asked.extend(queued.iter().map(|part| part.name));
    let asked: Vec<Name> = asked.into_iter().collect();
    let missing = store::missing(store, &asked)?;

    let mut out = Reconciled::default();
    let held: Vec<&Queued> = queued
        .iter()
        .filter(|part| !missing.contains(&part.name))
        .collect();
    if !held.is_empty() {
        let at = now(clock);
        let sized: Vec<(Name, u64)> = held.iter().map(|part| (part.name, part.size)).collect();
        ledger.acknowledge_many(&sized, &gateway, at)?;
        release_many(ledger, spool, &held, at, false)?;
        out.confirmed.extend(held.iter().map(|part| part.name));
    }
    for name in confirmed.intersection(&missing) {
        ledger.unconfirm(name, &gateway)?;
        out.unconfirmed.push(*name);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;
    use crate::backup::ledger::{Destination, PartKind, Queued};
    use crate::backup::naming::{BackupKeys, Digest, PlaintextHash};
    use crate::backup::store::MemoryStore;
    use crate::clock::FixedClock;

    struct Rig {
        _dir: tempfile::TempDir,
        ledger: Ledger,
        spool: Spool,
        store: MemoryStore,
        clock: FixedClock,
    }

    fn rig() -> Rig {
        let dir = tempfile::tempdir().expect("a directory");
        let ledger = Ledger::open(dir.path().join("v.backup.db")).expect("a ledger");
        let spool = Spool::open(dir.path().join("v.spool")).expect("a spool");
        let store = MemoryStore::new("gw");
        ledger
            .put_destination(&Destination {
                gateway_id: "gw".to_owned(),
                addrs: Vec::new(),
                cert_der: Vec::new(),
                token: "t".to_owned(),
                epoch: 1,
                label: "laptop".to_owned(),
                paired_at_ms: 0,
                last_seen_ms: None,
                last_ack_ms: None,
            })
            .expect("pairs");
        Rig {
            _dir: dir,
            ledger,
            spool,
            store,
            clock: FixedClock::frozen(),
        }
    }

    fn queue(rig: &Rig, label: &str, kind: PartKind) -> Name {
        let name = Name::from_bytes(*PlaintextHash::of(label.as_bytes()).as_bytes());
        let bytes = format!("sealed {label}").into_bytes();
        let path = rig.spool.write(&name, &bytes).expect("spools");
        rig.ledger
            .enqueue(&Queued {
                name,
                part_path: path,
                size: bytes.len() as u64,
                digest: Digest::of(&bytes),
                kind,
                media_type: matches!(kind, PartKind::Original | PartKind::Derivative)
                    .then(|| "image/jpeg".to_owned()),
                created_ms: 1,
                handed_off_ms: None,
                attempts: 0,
                last_error: None,
            })
            .expect("queues");
        name
    }

    fn far() -> Instant {
        Instant::now() + Duration::from_secs(60)
    }

    #[test]
    fn a_pass_confirms_what_was_acknowledged_and_empties_the_spool() {
        let rig = rig();
        let range = queue(&rig, "range", PartKind::Range);
        let manifest = queue(&rig, "manifest", PartKind::Manifest);
        let moved =
            move_queue(&rig.ledger, &rig.spool, &rig.store, far(), &rig.clock).expect("moves");
        assert_eq!(moved.stopped, Stop::Empty);
        assert_eq!(moved.confirmed, vec![range, manifest], "the manifest last");
        assert!(rig.ledger.queued().expect("reads").is_empty());
        assert!(rig.spool.names().expect("lists").is_empty());
        assert_eq!(rig.ledger.confirmed_names("gw").expect("reads").len(), 2);
        assert!(
            rig.store
                .exists(&[range, manifest])
                .expect("asks")
                .is_empty()
        );
    }

    /// **A14.** A run of ranges and derivatives goes as one bundle; an
    /// original and the manifest go alone, in queue order, the manifest
    /// after every range.
    #[test]
    fn ranges_and_derivatives_travel_in_bundles_and_the_rest_alone() {
        let rig = rig();
        let ranges: Vec<Name> = (0..40)
            .map(|index| queue(&rig, &format!("range {index}"), PartKind::Range))
            .collect();
        let thumbnail = queue(&rig, "thumbnail", PartKind::Derivative);
        let manifest = queue(&rig, "manifest", PartKind::Manifest);
        let moved =
            move_queue(&rig.ledger, &rig.spool, &rig.store, far(), &rig.clock).expect("moves");
        assert_eq!(moved.stopped, Stop::Empty);
        assert_eq!(
            rig.store.bundles(),
            1,
            "forty ranges and a thumbnail, one request"
        );
        assert_eq!(moved.confirmed.last(), Some(&manifest));
        assert_eq!(moved.confirmed.len(), ranges.len() + 2);
        assert!(moved.confirmed.contains(&thumbnail));
        assert!(rig.ledger.queued().expect("reads").is_empty());
        assert!(rig.spool.names().expect("lists").is_empty());

        let original = queue(&rig, "original", PartKind::Original);
        let moved =
            move_queue(&rig.ledger, &rig.spool, &rig.store, far(), &rig.clock).expect("moves");
        assert_eq!(moved.confirmed, vec![original]);
        assert_eq!(rig.store.bundles(), 1, "an original goes as its own put");
    }

    /// The part as if sealed just now, on the rig's clock.
    fn fresh(rig: &Rig, name: &Name) {
        let mut part = rig
            .ledger
            .queued_part(name)
            .expect("reads")
            .expect("queued");
        part.created_ms = now(&rig.clock);
        rig.ledger.enqueue(&part).expect("requeues");
    }

    fn pair_second(rig: &Rig) {
        rig.ledger
            .put_destination(&Destination {
                gateway_id: "gw2".to_owned(),
                addrs: Vec::new(),
                cert_der: Vec::new(),
                token: "t".to_owned(),
                epoch: 1,
                label: "nas".to_owned(),
                paired_at_ms: 1,
                last_seen_ms: None,
                last_ack_ms: None,
            })
            .expect("pairs a second");
    }

    /// **B1.** One destination's acknowledgement frees nothing while another still owes the
    /// part; it is sent to the other, and only then does the spool let go.
    #[test]
    fn a_part_stays_spooled_until_every_paired_destination_holds_it() {
        let rig = rig();
        pair_second(&rig);
        let range = queue(&rig, "range", PartKind::Range);
        fresh(&rig, &range);
        let moved =
            move_queue(&rig.ledger, &rig.spool, &rig.store, far(), &rig.clock).expect("moves");
        assert_eq!(moved.confirmed, vec![range]);
        assert!(rig.spool.contains(&range), "the second still owes it");
        assert_eq!(
            rig.ledger.owing(&range).expect("reads"),
            vec!["gw2".to_owned()]
        );
        // The first is not sent it again.
        let again =
            move_queue(&rig.ledger, &rig.spool, &rig.store, far(), &rig.clock).expect("moves");
        assert!(again.confirmed.is_empty());

        let second = MemoryStore::new("gw2");
        let moved = move_queue(&rig.ledger, &rig.spool, &second, far(), &rig.clock).expect("moves");
        assert_eq!(moved.confirmed, vec![range]);
        assert!(!rig.spool.contains(&range), "nobody owes it now");
        assert!(rig.ledger.queued().expect("reads").is_empty());
    }

    /// The wait for a destination that is away is bounded, and the spool's need ends it early.
    #[test]
    fn the_wait_for_a_destination_that_is_away_is_bounded() {
        let rig = rig();
        pair_second(&rig);
        let range = queue(&rig, "range", PartKind::Range);
        fresh(&rig, &range);
        move_queue(&rig.ledger, &rig.spool, &rig.store, far(), &rig.clock).expect("moves");
        assert!(rig.spool.contains(&range));
        let created = now(&rig.clock);
        assert_eq!(
            release_expired(&rig.ledger, &rig.spool, created + SPOOL_WAIT_MS - 1).expect("sweeps"),
            0
        );
        assert!(rig.spool.contains(&range));
        assert_eq!(
            release_expired(&rig.ledger, &rig.spool, created + SPOOL_WAIT_MS + 1).expect("sweeps"),
            1
        );
        assert!(!rig.spool.contains(&range));
        assert!(rig.ledger.queued().expect("reads").is_empty());

        // The spool's need ends the wait at once for a destination that did not answer.
        let again = queue(&rig, "again", PartKind::Range);
        fresh(&rig, &again);
        move_queue(&rig.ledger, &rig.spool, &rig.store, far(), &rig.clock).expect("moves");
        assert!(rig.spool.contains(&again));
        let released = release_to_reachable(
            &rig.ledger,
            &rig.spool,
            &["gw".to_owned(), "gw2".to_owned()],
        )
        .expect("releases");
        assert_eq!(released, 0, "a destination that answered is still sent it");
        let released =
            release_to_reachable(&rig.ledger, &rig.spool, &["gw".to_owned()]).expect("releases");
        assert_eq!(released, 1);
        assert!(!rig.spool.contains(&again));
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
    }

    /// **NOT THE PINNED DESTINATION IS NOT AN ABSENT ONE** (#1080, the
    /// audit's finding 5): the pass stops `Untrusted`, and every part stays
    /// queued and spooled for the destination that is.
    #[test]
    fn a_machine_that_is_not_the_destination_stops_the_pass_untrusted() {
        let rig = rig();
        let range = queue(&rig, "range", PartKind::Range);
        let original = queue(&rig, "original", PartKind::Original);
        for only in [PartKind::Range, PartKind::Original] {
            let moved = move_queue_where(
                &rig.ledger,
                &rig.spool,
                &Impostor,
                far(),
                &rig.clock,
                &|part| part.kind == only,
            )
            .expect("a pass");
            assert!(
                matches!(moved.stopped, Stop::Untrusted(_)),
                "{only:?}: {:?}",
                moved.stopped
            );
            assert!(moved.confirmed.is_empty());
        }
        assert_eq!(rig.ledger.queued().expect("reads").len(), 2);
        assert!(rig.spool.contains(&range) && rig.spool.contains(&original));
    }

    /// A part the pass does not admit stays queued and untouched.
    #[test]
    fn a_part_the_pass_holds_back_stays_queued() {
        let rig = rig();
        let range = queue(&rig, "range", PartKind::Range);
        let original = queue(&rig, "original", PartKind::Original);
        let moved = move_queue_where(
            &rig.ledger,
            &rig.spool,
            &rig.store,
            far(),
            &rig.clock,
            &|part| part.kind != PartKind::Original,
        )
        .expect("moves");
        assert_eq!(moved.stopped, Stop::Empty);
        assert_eq!(moved.confirmed, vec![range]);
        assert!(rig.spool.contains(&original));
        assert_eq!(rig.ledger.queued().expect("reads").len(), 1);
    }

    /// A bundle refused whole leaves every part in it queued, each with the
    /// attempt recorded; nothing is assumed stored.
    #[test]
    fn a_bundle_refused_whole_keeps_every_part_queued() {
        let rig = rig();
        let first = queue(&rig, "first", PartKind::Range);
        let second = queue(&rig, "second", PartKind::Range);
        let _taken_over = rig.store.claim();
        let moved =
            move_queue(&rig.ledger, &rig.spool, &rig.store, far(), &rig.clock).expect("moves");
        assert_eq!(moved.stopped, Stop::Moved { epoch: 2 });
        assert!(moved.confirmed.is_empty());
        assert!(rig.spool.contains(&first) && rig.spool.contains(&second));
        assert_eq!(rig.ledger.queued().expect("reads").len(), 2);
    }

    #[test]
    fn the_deadline_is_checked_between_parts_and_nothing_is_assumed() {
        let rig = rig();
        let first = queue(&rig, "first", PartKind::Range);
        let moved = move_queue(
            &rig.ledger,
            &rig.spool,
            &rig.store,
            Instant::now(),
            &rig.clock,
        )
        .expect("moves");
        assert_eq!(moved.stopped, Stop::Deadline);
        assert!(moved.confirmed.is_empty());
        assert_eq!(rig.ledger.queued().expect("reads").len(), 1);
        assert!(rig.spool.contains(&first));
    }

    /// **R-1080-B4.** The destination already holds a sealing of these bytes
    /// under this name — the PUT of a pass that crashed before recording it.
    #[test]
    fn name_taken_is_an_acknowledgement() {
        let rig = rig();
        let name = queue(&rig, "photo", PartKind::Original);
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
            move_queue(&rig.ledger, &rig.spool, &rig.store, far(), &rig.clock).expect("moves");
        assert_eq!(moved.confirmed, vec![name]);
        assert!(rig.ledger.is_confirmed(&name, "gw").expect("asks"));
        assert!(!rig.spool.contains(&name));
    }

    #[test]
    fn a_corrupt_or_vanished_spool_file_is_dropped_to_be_sealed_again() {
        let rig = rig();
        let corrupt = queue(&rig, "corrupt", PartKind::Range);
        let vanished = queue(&rig, "vanished", PartKind::Range);
        std::fs::write(rig.spool.path(&corrupt), b"not what was queued").expect("corrupts");
        rig.spool.remove(&vanished).expect("removes");
        let moved =
            move_queue(&rig.ledger, &rig.spool, &rig.store, far(), &rig.clock).expect("moves");
        assert_eq!(moved.stopped, Stop::Empty);
        let mut dropped = moved.dropped.clone();
        dropped.sort();
        let mut expected = vec![corrupt, vanished];
        expected.sort();
        assert_eq!(dropped, expected);
        assert!(moved.confirmed.is_empty());
        assert!(rig.ledger.queued().expect("reads").is_empty());
    }

    #[test]
    fn a_superseded_writer_stops_and_keeps_its_queue() {
        let rig = rig();
        let name = queue(&rig, "late", PartKind::Range);
        let _taken_over = rig.store.claim();
        let moved =
            move_queue(&rig.ledger, &rig.spool, &rig.store, far(), &rig.clock).expect("moves");
        assert_eq!(moved.stopped, Stop::Moved { epoch: 2 });
        assert!(rig.spool.contains(&name), "nothing is thrown away");
        assert_eq!(rig.ledger.queued().expect("reads").len(), 1);
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
        ) -> std::result::Result<store::Head, StoreError> {
            self.inner.set_head(name, prev, taken_at_ms)
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
    }

    /// **A FULL DISK ON THE GATEWAY BACKS NOTHING UP, AND THE PASS AFTER
    /// THE ROOM COMES BACK FINISHES** (#1080, the sweep's B4). Every part
    /// stays queued and spooled with the refusal recorded as its attempt,
    /// nothing is confirmed, and once the disk has room the next pass moves
    /// them all.
    #[test]
    fn a_full_disk_confirms_nothing_and_the_pass_after_it_finishes() {
        let rig = rig();
        let ranges: Vec<Name> = (0..3)
            .map(|index| queue(&rig, &format!("range {index}"), PartKind::Range))
            .collect();
        let original = queue(&rig, "original", PartKind::Original);
        let full = Full {
            inner: &rig.store,
            full: std::cell::Cell::new(true),
            refusal: Refusal::DiskFull,
        };
        let refused =
            move_queue(&rig.ledger, &rig.spool, &full, far(), &rig.clock).expect("a pass");
        assert_eq!(refused.stopped, Stop::Refused(Refusal::DiskFull));
        assert!(refused.confirmed.is_empty());
        assert!(rig.ledger.confirmed_names("gw").expect("reads").is_empty());
        let queued = rig.ledger.queued().expect("reads");
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
        let moved = move_queue(&rig.ledger, &rig.spool, &full, far(), &rig.clock).expect("a pass");
        assert_eq!(moved.stopped, Stop::Empty);
        assert_eq!(moved.confirmed.len(), 4);
        assert!(rig.ledger.queued().expect("reads").is_empty());
        assert!(rig.spool.names().expect("lists").is_empty());
    }

    /// **A REFUSAL THAT IS NOT A FULL DISK STOPS THE PASS TOO** (#1080, the
    /// sweep's F1): a quota or a cap the destination names is its answer, not
    /// a part to skip, so the pass stops on it with every part still queued,
    /// spooled and unconfirmed. A `TOO_LARGE` used to be recorded while the
    /// queue moved on, which left the status waiting `WINDOW` for time.
    #[test]
    fn a_quota_or_a_cap_stops_the_pass_with_every_part_kept() {
        for refusal in [
            Refusal::TooLarge,
            Refusal::Other("QUOTA".to_owned()),
            Refusal::Unauthorized,
        ] {
            let rig = rig();
            let names: Vec<Name> = (0..3)
                .map(|index| queue(&rig, &format!("part {index}"), PartKind::Original))
                .collect();
            let refusing = Full {
                inner: &rig.store,
                full: std::cell::Cell::new(true),
                refusal: refusal.clone(),
            };
            let moved =
                move_queue(&rig.ledger, &rig.spool, &refusing, far(), &rig.clock).expect("a pass");
            assert_eq!(moved.stopped, Stop::Refused(refusal.clone()), "{refusal:?}");
            assert!(moved.confirmed.is_empty(), "{refusal:?}");
            let queued = rig.ledger.queued().expect("reads");
            assert_eq!(queued.len(), 3, "{refusal:?}");
            assert!(names.iter().all(|name| rig.spool.contains(name)));
            assert_eq!(
                queued[0].last_error.as_deref(),
                Some(refusal.code()),
                "the refusal is the attempt's outcome"
            );
            assert_eq!(
                queued[1].attempts, 0,
                "the pass stopped at the first answer, so the rest were not tried"
            );
        }
    }

    #[test]
    fn reconcile_follows_the_destination_both_ways() {
        let rig = rig();
        let held = queue(&rig, "held", PartKind::Range);
        let bytes = std::fs::read(rig.spool.path(&held)).expect("reads");
        rig.store
            .put(
                &held,
                &Digest::of(&bytes),
                bytes.len() as u64,
                &mut &bytes[..],
            )
            .expect("stores");
        let lost = Name::from_bytes([7; 32]);
        rig.ledger.confirm(&lost, "gw", 1, 10).expect("confirms");
        let reconciled =
            reconcile(&rig.ledger, &rig.spool, &rig.store, &rig.clock).expect("reconciles");
        assert_eq!(reconciled.confirmed, vec![held]);
        assert_eq!(reconciled.unconfirmed, vec![lost]);
        assert!(rig.ledger.queued().expect("reads").is_empty());
        assert!(!rig.spool.contains(&held));
        assert!(!rig.ledger.is_confirmed(&lost, "gw").expect("asks"));
    }

    /// **A BUNDLE'S ANSWER IS ONE LEDGER TRANSACTION TO CONFIRM AND ONE TO RELEASE,** not several
    /// per part: counted in commits, never timed.
    #[test]
    fn a_bundle_is_confirmed_and_released_in_a_fixed_number_of_commits() {
        let rig = rig();
        for index in 0..40 {
            queue(&rig, &format!("range {index}"), PartKind::Range);
        }
        let before = rig.ledger.commit_count();
        let moved =
            move_queue(&rig.ledger, &rig.spool, &rig.store, far(), &rig.clock).expect("moves");
        assert_eq!(moved.confirmed.len(), 40);
        assert_eq!(
            rig.ledger.commit_count() - before,
            2,
            "forty parts: one commit to confirm, one to dequeue"
        );
        assert!(rig.spool.names().expect("lists").is_empty());
    }

    /// **THE FILTER IS THE DATABASE'S:** a pass reads the queued parts the gateway does not
    /// hold, and a part another pass confirmed is not loaded again.
    #[test]
    fn the_queue_a_pass_reads_leaves_out_what_the_gateway_holds() {
        let rig = rig();
        pair_second(&rig);
        let held = queue(&rig, "held", PartKind::Range);
        let owed = queue(&rig, "owed", PartKind::Range);
        rig.ledger.confirm(&held, "gw", 1, 4).expect("confirms");
        let for_gw: Vec<Name> = rig
            .ledger
            .queued_unconfirmed("gw")
            .expect("reads")
            .iter()
            .map(|part| part.name)
            .collect();
        assert_eq!(for_gw, vec![owed]);
        assert_eq!(
            rig.ledger.queued_unconfirmed("gw2").expect("reads").len(),
            2
        );
    }

    /// **A POISON SPOOL FILE DOES NOT BLOCK THE PASS.** One that exists and cannot be opened is
    /// dropped like a missing one, to be sealed again, and the error is on the answer; the parts
    /// after it still move. (Skipped by construction where the file can be opened anyway: a
    /// process that ignores file modes, such as root.)
    #[cfg(unix)]
    #[test]
    fn an_unreadable_spool_file_is_dropped_and_the_pass_goes_on() {
        use std::os::unix::fs::PermissionsExt;

        let rig = rig();
        let poison = queue(&rig, "poison", PartKind::Original);
        let good = queue(&rig, "good", PartKind::Range);
        std::fs::set_permissions(
            rig.spool.path(&poison),
            std::fs::Permissions::from_mode(0o000),
        )
        .expect("locks it");
        if std::fs::File::open(rig.spool.path(&poison)).is_ok() {
            return;
        }
        let moved =
            move_queue(&rig.ledger, &rig.spool, &rig.store, far(), &rig.clock).expect("moves");
        assert_eq!(moved.stopped, Stop::Empty);
        assert_eq!(moved.dropped, vec![poison]);
        assert_eq!(moved.errors.len(), 1);
        assert_eq!(moved.errors[0].0, poison);
        assert!(moved.errors[0].1.contains("cannot be read"));
        assert_eq!(moved.confirmed, vec![good]);
        assert!(!rig.ledger.is_queued(&poison).expect("asks"));
        assert!(!rig.spool.contains(&poison));
    }

    /// **THE SAME PART REFUSED AS DAMAGED THREE TIMES IN A ROW STOPS THAT GATEWAY'S PASS,**
    /// named by the refusal's own code; an acknowledgement clears the count.
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
            // Sealed again from the vault, as a pass does after dropping it.
            name = Some(queue(&rig, "torn", PartKind::Original));
            let moved =
                move_queue(&rig.ledger, &rig.spool, &flaky, far(), &rig.clock).expect("moves");
            let name = name.expect("queued");
            assert_eq!(moved.dropped, vec![name], "round {round}");
            assert_eq!(rig.ledger.mismatches(&name, "gw").expect("reads"), round);
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
        queue(&rig, "torn", PartKind::Original);
        let moved = move_queue(&rig.ledger, &rig.spool, &flaky, far(), &rig.clock).expect("moves");
        assert_eq!(moved.confirmed, vec![name]);
        assert_eq!(rig.ledger.mismatches(&name, "gw").expect("reads"), 0);
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
        rig.ledger
            .enqueue(&Queued {
                name: names[0],
                part_path: path,
                size: sealed.len() as u64,
                digest: Digest::of(&sealed),
                kind: PartKind::Original,
                media_type: Some("image/jpeg".to_owned()),
                created_ms: 1,
                handed_off_ms: None,
                attempts: 0,
                last_error: None,
            })
            .expect("queues");
        let moved =
            move_queue(&rig.ledger, &rig.spool, &rig.store, far(), &rig.clock).expect("moves");
        assert_eq!(moved.confirmed, vec![names[0]]);
        let mut held = Vec::new();
        rig.store.get(&names[0], &mut held).expect("reads back");
        let opened = centraid_media::sealed::open_part(&keys, &held).expect("opens");
        assert!(opened.plaintext.is_empty());
    }

    /// With the last gateway forgotten nothing on the phone is owed to anyone: the queue and
    /// the spool are swept; with one still paired they are not.
    #[test]
    fn forgetting_the_last_gateway_sweeps_the_queue_and_the_spool() {
        let rig = rig();
        pair_second(&rig);
        let part = queue(&rig, "waiting", PartKind::Range);
        rig.ledger.remove_destination("gw").expect("forgets one");
        assert_eq!(sweep_unowed(&rig.ledger, &rig.spool).expect("sweeps"), 0);
        assert!(rig.spool.contains(&part), "the other still owes it");
        rig.ledger
            .remove_destination("gw2")
            .expect("forgets the last");
        std::fs::write(rig.spool.dir().join("f".repeat(64)), b"a stray").expect("a stray file");
        assert_eq!(sweep_unowed(&rig.ledger, &rig.spool).expect("sweeps"), 1);
        assert!(rig.ledger.queued().expect("reads").is_empty());
        assert!(
            rig.spool.names().expect("lists").is_empty(),
            "stray files go too"
        );
    }
}
