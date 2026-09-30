//! Request-id multiplexing over one stream (#1020, D-1020-C2).
//!
//! **Request ids are per connection, monotonic, and never reused.** That is
//! what makes `Cancel{request_id}` unambiguous: an answered id is an id nothing
//! will name again, so a late `Cancel` is a no-op rather than a cancellation of
//! somebody else's work. Id `0` is reserved for the handshake, which is not a
//! request.
//!
//! **Bounded reads are never cancellable** and are bounded instead (#1020
//! Execution model). The reason is not thrift: a bounded read holds a SQLite
//! read transaction, and a cancellation that leaves the transaction to be
//! rolled back by a dropped future is how the four-statements-in-one-read-
//! transaction rule of v0's log door gets broken (census seam 4). So the
//! registry below knows a request's KIND and refuses to cancel a bounded one,
//! rather than leaving it to each call site to remember.

use std::collections::BTreeMap;

use crate::error::{ProtocolError, Result};

/// Whether an in-flight request can be cancelled.
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum RequestKind {
    /// A paged read, a command, a handshake: it finishes on its own, bounded by
    /// its own limit. Not cancellable.
    Bounded,
    /// Sync, media, search indexing: no bound but the peer's patience.
    /// Cancellable.
    Unbounded,
}

/// The id minter and the in-flight registry for one connection.
#[derive(Debug, Default)]
pub struct Session {
    next: u64,
    in_flight: BTreeMap<u64, RequestKind>,
    /// Ids that have been minted, so a reuse is caught rather than assumed
    /// impossible. Only the highest matters, which is why it is one number.
    highest_minted: u64,
}

impl Session {
    pub fn new() -> Self {
        Self {
            next: 1,
            in_flight: BTreeMap::new(),
            highest_minted: 0,
        }
    }

    /// Mint the next id and register the request. Monotonic; never zero.
    pub fn begin(&mut self, kind: RequestKind) -> u64 {
        let id = self.next;
        self.next = self
            .next
            .checked_add(1)
            .expect("a connection that issued 2^64 requests has other problems");
        self.highest_minted = id;
        self.in_flight.insert(id, kind);
        id
    }

    /// Register an id the PEER minted, on the accepting side. The peer owns its
    /// own id space, so the two directions never collide and this does not
    /// touch the minter.
    pub fn accept(&mut self, id: u64, kind: RequestKind) -> Result<()> {
        if id == 0 {
            return Err(ProtocolError::BadRequestId(id));
        }
        if self.in_flight.contains_key(&id) {
            return Err(ProtocolError::BadRequestId(id));
        }
        self.in_flight.insert(id, kind);
        Ok(())
    }

    /// The request answered. Returns whether it was in flight — an answer to an
    /// id nobody is waiting for is a peer bug worth reporting, not a panic.
    pub fn settle(&mut self, id: u64) -> bool {
        self.in_flight.remove(&id).is_some()
    }

    /// Cancel an in-flight unbounded request.
    ///
    /// Three answers, and each is a different fact:
    /// * `Ok(true)` — it was in flight, unbounded, and is now cancelled.
    /// * `Ok(false)` — it is not in flight. A `Cancel` that raced the answer,
    ///   which is a NO-OP: the id is never reused, so it cannot be somebody
    ///   else's request.
    /// * `Err(NotCancellable)` — it is in flight and bounded.
    pub fn cancel(&mut self, id: u64) -> Result<bool> {
        match self.in_flight.get(&id) {
            None => Ok(false),
            Some(RequestKind::Bounded) => Err(ProtocolError::NotCancellable(id)),
            Some(RequestKind::Unbounded) => {
                self.in_flight.remove(&id);
                Ok(true)
            }
        }
    }

    pub fn is_in_flight(&self, id: u64) -> bool {
        self.in_flight.contains_key(&id)
    }

    pub fn in_flight_count(&self) -> usize {
        self.in_flight.len()
    }

    /// The highest id this side has minted. The peer echoes an id back, and an
    /// id above this one is an id this side never issued.
    pub fn highest_minted(&self) -> u64 {
        self.highest_minted
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_are_monotonic_never_zero_and_never_reused() {
        let mut session = Session::new();
        let mut seen = Vec::new();
        for _ in 0..100 {
            let id = session.begin(RequestKind::Bounded);
            assert_ne!(id, 0, "zero is the handshake");
            if let Some(previous) = seen.last() {
                assert!(id > *previous, "{id} after {previous}");
            }
            seen.push(id);
            session.settle(id);
        }
        // Settled ids are gone from the registry and are still never re-minted.
        let next = session.begin(RequestKind::Bounded);
        assert!(!seen.contains(&next));
        assert!(next > *seen.last().expect("some ids"));
    }

    #[test]
    fn an_unbounded_request_cancels_and_a_bounded_one_refuses() {
        let mut session = Session::new();
        let bounded = session.begin(RequestKind::Bounded);
        let unbounded = session.begin(RequestKind::Unbounded);

        assert!(session.cancel(unbounded).expect("cancellable"));
        assert!(!session.is_in_flight(unbounded));

        let error = session
            .cancel(bounded)
            .expect_err("bounded reads are bounded");
        assert!(
            matches!(error, ProtocolError::NotCancellable(id) if id == bounded),
            "{error:?}"
        );
        assert!(
            session.is_in_flight(bounded),
            "a refused cancel must not settle the request"
        );
    }

    /// The race that makes ids-are-never-reused load-bearing: the answer lands,
    /// then the `Cancel` arrives. Because the id will never name another
    /// request, the late cancel is a no-op instead of cancelling whatever
    /// happened to get the id next.
    #[test]
    fn a_cancel_that_raced_the_answer_is_a_no_op() {
        let mut session = Session::new();
        let id = session.begin(RequestKind::Unbounded);
        assert!(session.settle(id));
        assert!(!session.cancel(id).expect("a late cancel is not an error"));

        let next = session.begin(RequestKind::Unbounded);
        assert_ne!(next, id, "the id was reused and the late cancel would bite");
    }

    #[test]
    fn an_answer_to_an_unknown_id_is_reported_not_fatal() {
        let mut session = Session::new();
        assert!(!session.settle(404));
    }

    #[test]
    fn a_peer_minted_id_is_accepted_once_and_never_zero() {
        let mut session = Session::new();
        session.accept(9, RequestKind::Unbounded).expect("accepted");
        assert!(session.is_in_flight(9));
        assert!(session.accept(9, RequestKind::Unbounded).is_err());
        assert!(session.accept(0, RequestKind::Bounded).is_err());
    }

    #[test]
    fn the_registry_counts_only_what_is_in_flight() {
        let mut session = Session::new();
        let ids: Vec<u64> = (0..5)
            .map(|_| session.begin(RequestKind::Bounded))
            .collect();
        assert_eq!(session.in_flight_count(), 5);
        for id in ids {
            session.settle(id);
        }
        assert_eq!(session.in_flight_count(), 0);
    }
}
