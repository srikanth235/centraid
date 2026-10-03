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
//! A part is released from the spool when the destination it was moved to
//! confirms it. Every other paired destination reaches it by mirroring
//! (#1080 ruling 8) or by its own `exists` answer on a later pass.
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
    /// A newer writer claimed the vault: this device stops writing.
    Moved { epoch: u64 },
    /// The destination refused for a reason that stops the pass.
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
    pub stopped: Stop,
}

fn now(clock: &dyn Clock) -> u64 {
    u64::try_from(clock.now_ms()).unwrap_or(0)
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
    /// The destination holds a sealing of `part`: confirm it and free the
    /// spool.
    fn acknowledged(&mut self, part: &Queued) -> Result<()> {
        self.ledger
            .confirm(&part.name, &self.gateway, now(self.clock), part.size)?;
        self.ledger.dequeue(&part.name)?;
        self.spool.remove(&part.name)?;
        self.moved.confirmed.push(part.name);
        Ok(())
    }

    /// The spool file is gone or is not the bytes queued: drop the part, to
    /// be sealed again.
    fn torn(&mut self, part: &Queued) -> Result<()> {
        self.ledger.dequeue(&part.name)?;
        self.spool.remove(&part.name)?;
        self.moved.dropped.push(part.name);
        Ok(())
    }

    /// Act on one part's answer; a refusal that stops the pass is returned.
    fn answered(
        &mut self,
        part: &Queued,
        answer: std::result::Result<(), Refusal>,
    ) -> Result<Option<Stop>> {
        match answer {
            Ok(()) | Err(Refusal::NameTaken) => self.acknowledged(part)?,
            Err(Refusal::DigestMismatch) => self.torn(part)?,
            Err(Refusal::TooLarge) => {
                // Not this pass's to fix: no part of this format is past the
                // cap, so the attempt is recorded for the status line and the
                // queue moves on.
                self.ledger
                    .record_attempt(&part.name, Refusal::TooLarge.code())?;
            }
            Err(refusal) => {
                self.ledger.record_attempt(&part.name, refusal.code())?;
                return Ok(Some(Stop::Refused(refusal)));
            }
        }
        Ok(None)
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
                Stop::Unreachable(detail)
            }
        })
    }

    /// Send one part as its own `put`.
    fn single(&mut self, store: &dyn Store, part: &Queued) -> Result<Option<Stop>> {
        let mut body = match self.spool.read(&part.name) {
            Ok(file) => file,
            Err(_) if !self.spool.contains(&part.name) => {
                self.ledger.dequeue(&part.name)?;
                self.moved.dropped.push(part.name);
                return Ok(None);
            }
            Err(error) => return Err(error),
        };
        let put = store.put(&part.name, &part.digest, part.size, &mut body);
        drop(body);
        match put {
            Ok(_) => self.answered(part, Ok(())),
            Err(StoreError::Refused(refusal)) => self.answered(part, Err(refusal)),
            Err(error) => self.unanswered(&[part], error).map(Some),
        }
    }

    /// Send a run of parts as one bundle. A part whose spool file is gone is
    /// dropped before the request; the rest are answered one by one.
    fn bundle(&mut self, store: &dyn Store, run: &[&Queued]) -> Result<Option<Stop>> {
        let mut sent: Vec<&Queued> = Vec::with_capacity(run.len());
        for part in run {
            if self.spool.contains(&part.name) {
                sent.push(part);
            } else {
                self.ledger.dequeue(&part.name)?;
                self.moved.dropped.push(part.name);
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
        let mut stop = None;
        for (name, answer) in answers {
            // An answer for a name this bundle did not carry says nothing
            // about the queue; a part left unanswered waits for the next pass.
            let Some(part) = by_name.get(&name) else {
                continue;
            };
            if let Some(refused) = self.answered(part, answer.map(|_| ()))? {
                stop.get_or_insert(refused);
            }
        }
        Ok(stop)
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
    let queue: Vec<Queued> = ledger
        .queued()?
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
    for part in &queued {
        if !missing.contains(&part.name) {
            ledger.confirm(&part.name, &gateway, now(clock), part.size)?;
            ledger.dequeue(&part.name)?;
            spool.remove(&part.name)?;
            out.confirmed.push(part.name);
        }
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
    use crate::backup2::ledger::{Destination, PartKind, Queued};
    use crate::backup2::naming::{Digest, PlaintextHash};
    use crate::backup2::store::MemoryStore;
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
}
