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
//! [`reconcile`] makes the ledger a cache of the destination's truth: every
//! queued and every confirmed name is asked about, and the ledger follows the
//! answer in both directions.

use std::collections::BTreeSet;
use std::time::Instant;

use super::Result;
use super::ledger::Ledger;
use super::naming::Name;
use super::spool::Spool;
use super::store::{self, Refusal, Store, StoreError};
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

/// Send queued parts to `store` in queue order until the queue is empty, the
/// deadline passes or the destination stops answering. The deadline is checked
/// between parts, never inside one.
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
    let gateway = store.gateway_id().to_owned();
    let mut moved = Moved {
        confirmed: Vec::new(),
        dropped: Vec::new(),
        stopped: Stop::Empty,
    };
    for part in ledger.queued()? {
        if Instant::now() >= deadline {
            moved.stopped = Stop::Deadline;
            return Ok(moved);
        }
        let mut body = match spool.read(&part.name) {
            Ok(file) => file,
            Err(_) if !spool.contains(&part.name) => {
                ledger.dequeue(&part.name)?;
                moved.dropped.push(part.name);
                continue;
            }
            Err(error) => return Err(error),
        };
        match store.put(&part.name, &part.digest, part.size, &mut body) {
            Ok(_) | Err(StoreError::Refused(Refusal::NameTaken)) => {
                drop(body);
                ledger.confirm(&part.name, &gateway, now(clock), part.size)?;
                ledger.dequeue(&part.name)?;
                spool.remove(&part.name)?;
                moved.confirmed.push(part.name);
            }
            Err(StoreError::Refused(Refusal::DigestMismatch)) => {
                drop(body);
                ledger.dequeue(&part.name)?;
                spool.remove(&part.name)?;
                moved.dropped.push(part.name);
            }
            Err(StoreError::Refused(Refusal::TooLarge)) => {
                // Not this pass's to fix: no part of this format is past the
                // cap, so the attempt is recorded for the status line and the
                // queue moves on.
                ledger.record_attempt(&part.name, Refusal::TooLarge.code())?;
            }
            Err(StoreError::Moved { epoch }) => {
                moved.stopped = Stop::Moved { epoch };
                return Ok(moved);
            }
            Err(StoreError::Refused(refusal)) => {
                ledger.record_attempt(&part.name, refusal.code())?;
                moved.stopped = Stop::Refused(refusal);
                return Ok(moved);
            }
            Err(error) => {
                let detail = error.to_string();
                ledger.record_attempt(&part.name, &detail)?;
                moved.stopped = Stop::Unreachable(detail);
                return Ok(moved);
            }
        }
    }
    Ok(moved)
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
    let gateway = store.gateway_id().to_owned();
    let queued = ledger.queued()?;
    let confirmed = ledger.confirmed_names(&gateway)?;
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
