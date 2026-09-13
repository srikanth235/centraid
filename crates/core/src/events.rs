//! The bounded event queue: coalesce, stall, never drop.
//!
//! ## Why bounded, and why nothing is dropped
//!
//! An unbounded queue is a memory leak with a nice name: a shell that stops
//! draining (backgrounded, wedged, mid-migration) makes the core grow until the
//! OS kills it, and on a phone that is the *product* being killed. So the queue
//! is bounded.
//!
//! But a bounded queue that drops is worse than either. A dropped change event
//! is a screen that stays wrong until something else happens to touch the same
//! row, which may be never. So when the queue fills, **sync stalls**: the
//! producer waits, and a [`HealthEvent`] with `stalled: true` tells the shell
//! why it is not catching up. Slow is a state a member can be told about;
//! wrong is not.
//!
//! ## Coalescing is lossless
//!
//! Two changes to the same `(table, pk)` are one redraw, so while a change
//! event waits its `pk_set` absorbs later keys for the same table and its
//! `commit_seq` rises to the highest it covers. Nothing is lost, because a
//! change event never carried the *values* — it carries the keys a screen
//! re-reads. That is what makes coalescing safe here and not safe for, say, a
//! health event, which is a sample rather than a set.

use std::collections::VecDeque;
use std::sync::{Condvar, Mutex};
use std::time::Duration;

use centraid_api_proto::core_v1::{ChangeEvent, Event, HealthEvent, RecordKey, event};

/// How many events the queue holds before sync stalls.
pub const EVENT_QUEUE_CAP: usize = 1024;

/// What [`EventQueue::next`] returned.
#[derive(Debug, Clone, PartialEq)]
pub enum Next {
    /// An event.
    Event(Event),
    /// The timeout elapsed with nothing waiting. Not an error: a shell polls
    /// with a timeout so it can also check its own business.
    Timeout,
    /// The handle was closed. **Terminal**: a thread blocked in `next` is
    /// released with this, which is the whole reason `close` can be called from
    /// another thread at all.
    Closed,
}

struct State {
    queue: VecDeque<Event>,
    closed: bool,
    /// Set while the queue is at its cap, so the producer knows to stall and
    /// the health event is emitted exactly once per stall rather than per push.
    stalled: bool,
    /// A stall the shell has not been told about yet.
    ///
    /// Set when the stall happened with no free slot AND no waiting health
    /// event to replace, which is the ordinary case: the queue is full of
    /// change events, and a change event must never be dropped to make room.
    /// So the report WAITS for the first slot a drain frees. Without this flag
    /// the shell learns a stall ended without ever learning it began, which is
    /// the one health report it actually needs.
    stall_unreported: bool,
    /// The seat's distance behind the gateway, for the health event.
    behind: u64,
}

/// The queue itself. Shared between the producer (sync, the applier) and the
/// consumer (the shell's event thread).
pub struct EventQueue {
    state: Mutex<State>,
    /// One condition variable for both directions. Two would be tidier and
    /// would also be two things that can be signalled wrongly; the queue's
    /// state tells a woken thread which case it is in.
    signal: Condvar,
}

impl Default for EventQueue {
    fn default() -> Self {
        Self::new()
    }
}

impl EventQueue {
    #[must_use]
    pub fn new() -> Self {
        Self {
            state: Mutex::new(State {
                queue: VecDeque::new(),
                closed: false,
                stalled: false,
                stall_unreported: false,
                behind: 0,
            }),
            signal: Condvar::new(),
        }
    }

    /// Record how far behind the gateway this seat is, for health events.
    pub fn set_behind(&self, behind: u64) {
        let mut state = self.lock();
        state.behind = behind;
    }

    /// Offer an event. Returns `false` when the queue is full — which is the
    /// **stall**, not a drop: the caller must stop producing and try again.
    ///
    /// A change event coalesces into a waiting one for the same table rather
    /// than taking a slot.
    pub fn push(&self, event: Event) -> bool {
        let mut state = self.lock();
        if state.closed {
            return false;
        }
        if let Some(event::Kind::Change(change)) = &event.kind
            && coalesce_into(&mut state.queue, change)
        {
            // Coalesced: no slot taken, and the consumer already has a wake
            // pending for the event it merged into.
            self.signal.notify_all();
            return true;
        }
        if state.queue.len() >= EVENT_QUEUE_CAP {
            if !state.stalled {
                state.stalled = true;
                let health = health_event(&state, true);
                // A HEALTH EVENT IS A SAMPLE and the newest is the true one, so
                // a waiting one may be replaced. A CHANGE EVENT IS A SET nobody
                // else will resend, so it may not. When the queue holds only
                // change events the report waits for the first freed slot.
                if let Some(index) = state
                    .queue
                    .iter()
                    .position(|waiting| matches!(waiting.kind, Some(event::Kind::Health(_))))
                {
                    state.queue[index] = health;
                } else {
                    state.stall_unreported = true;
                }
                self.signal.notify_all();
            }
            return false;
        }
        state.queue.push_back(event);
        self.signal.notify_all();
        true
    }

    /// Take the next event, waiting up to `timeout`.
    pub fn next(&self, timeout: Duration) -> Next {
        let mut state = self.lock();
        let deadline = std::time::Instant::now() + timeout;
        loop {
            if let Some(event) = state.queue.pop_front() {
                // A slot just opened. Two reports may be owed, in this order:
                // the stall the shell was never told about, then the resume.
                if state.stall_unreported {
                    state.stall_unreported = false;
                    let health = health_event(&state, true);
                    state.queue.push_back(health);
                }
                if state.stalled && state.queue.len() < EVENT_QUEUE_CAP {
                    // The producer may resume, and the shell is told the stall
                    // is over — `stalled: false` is as much a fact as `true`.
                    state.stalled = false;
                    let health = health_event(&state, false);
                    state.queue.push_back(health);
                }
                self.signal.notify_all();
                return Next::Event(event);
            }
            // Closed is checked AFTER the queue: a close does not discard
            // events already accepted, it only stops new ones.
            if state.closed {
                return Next::Closed;
            }
            let now = std::time::Instant::now();
            if now >= deadline {
                return Next::Timeout;
            }
            let (guard, _) = self
                .signal
                .wait_timeout(state, deadline - now)
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            state = guard;
        }
    }

    /// Close the queue: every waiter is released with [`Next::Closed`] once the
    /// events already accepted have been handed out.
    pub fn close(&self) {
        let mut state = self.lock();
        state.closed = true;
        self.signal.notify_all();
    }

    /// Whether the queue is closed.
    pub fn is_closed(&self) -> bool {
        self.lock().closed
    }

    /// How many events are waiting.
    pub fn depth(&self) -> usize {
        self.lock().queue.len()
    }

    /// Whether sync is currently stalled.
    pub fn is_stalled(&self) -> bool {
        self.lock().stalled
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        // A poisoned queue is recoverable: the invariant is "the deque holds
        // events", and a panic in a consumer cannot break that. Refusing to
        // serve events because somebody else panicked would turn one bug into
        // a dead product.
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

/// One health sample off the queue's current state.
///
/// A function so the four places that report health cannot disagree about what
/// `queue_depth` or `behind` mean.
fn health_event(state: &State, stalled: bool) -> Event {
    Event {
        kind: Some(event::Kind::Health(HealthEvent {
            queue_depth: u32::try_from(state.queue.len()).unwrap_or(u32::MAX),
            capacity: u32::try_from(EVENT_QUEUE_CAP).unwrap_or(u32::MAX),
            stalled,
            behind: state.behind,
        })),
    }
}

/// Merge `change` into a waiting change event for the same table, if there is
/// one. Returns whether it was merged.
fn coalesce_into(queue: &mut VecDeque<Event>, change: &ChangeEvent) -> bool {
    for waiting in queue.iter_mut() {
        let Some(event::Kind::Change(existing)) = &mut waiting.kind else {
            continue;
        };
        if existing.table != change.table {
            continue;
        }
        for key in &change.pk_set {
            if !existing.pk_set.iter().any(|seen| same_key(seen, key)) {
                existing.pk_set.push(key.clone());
            }
        }
        // The HIGHEST commit this event now covers. An overlay clears against a
        // commit seq, so a coalesced event that reported the lower of the two
        // would leave paint on the screen.
        existing.commit_seq = existing.commit_seq.max(change.commit_seq);
        return true;
    }
    false
}

fn same_key(left: &RecordKey, right: &RecordKey) -> bool {
    left.values.len() == right.values.len()
        && left
            .values
            .iter()
            .zip(&right.values)
            .all(|(one, two)| one.kind == two.kind)
}

#[cfg(test)]
mod tests {
    use super::*;
    use centraid_api_proto::core_v1::{Value, value};

    fn key(text: &str) -> RecordKey {
        RecordKey {
            values: vec![Value {
                kind: Some(value::Kind::Text(text.to_owned())),
            }],
        }
    }

    fn change(table: &str, keys: &[&str], commit_seq: u64) -> Event {
        Event {
            kind: Some(event::Kind::Change(ChangeEvent {
                table: table.to_owned(),
                pk_set: keys.iter().map(|text| key(text)).collect(),
                commit_seq,
            })),
        }
    }

    fn health(stalled: bool) -> Event {
        Event {
            kind: Some(event::Kind::Health(HealthEvent {
                queue_depth: 0,
                capacity: EVENT_QUEUE_CAP as u32,
                stalled,
                behind: 0,
            })),
        }
    }

    #[test]
    fn an_event_offered_is_an_event_returned() {
        let queue = EventQueue::new();
        assert!(queue.push(change("note", &["n1"], 1)));
        assert_eq!(
            queue.next(Duration::from_millis(10)),
            Next::Event(change("note", &["n1"], 1))
        );
    }

    #[test]
    fn a_timeout_with_nothing_waiting_is_not_an_error() {
        let queue = EventQueue::new();
        assert_eq!(queue.next(Duration::from_millis(1)), Next::Timeout);
    }

    #[test]
    fn two_changes_to_one_table_coalesce_into_one_redraw() {
        let queue = EventQueue::new();
        queue.push(change("note", &["n1"], 1));
        queue.push(change("note", &["n2"], 4));
        assert_eq!(queue.depth(), 1, "one slot, two keys");
        let Next::Event(Event {
            kind: Some(event::Kind::Change(merged)),
        }) = queue.next(Duration::from_millis(10))
        else {
            panic!("a change event comes back");
        };
        assert_eq!(merged.pk_set.len(), 2);
        // THE HIGHEST commit: an overlay clears against a commit seq, and the
        // lower of the two would leave paint on the screen.
        assert_eq!(merged.commit_seq, 4);
    }

    #[test]
    fn the_same_key_twice_is_one_key() {
        let queue = EventQueue::new();
        queue.push(change("note", &["n1"], 1));
        queue.push(change("note", &["n1"], 2));
        let Next::Event(Event {
            kind: Some(event::Kind::Change(merged)),
        }) = queue.next(Duration::from_millis(10))
        else {
            panic!("a change event");
        };
        assert_eq!(merged.pk_set.len(), 1);
    }

    #[test]
    fn changes_to_different_tables_do_not_coalesce() {
        let queue = EventQueue::new();
        queue.push(change("note", &["n1"], 1));
        queue.push(change("party", &["p1"], 2));
        assert_eq!(queue.depth(), 2);
    }

    /// THE STALL. The queue refuses the push; it does not drop anything.
    #[test]
    fn a_full_queue_stalls_the_producer_and_drops_nothing() {
        let queue = EventQueue::new();
        // One event per table, so nothing coalesces.
        for index in 0..EVENT_QUEUE_CAP {
            assert!(
                queue.push(change(&format!("t{index}"), &["k"], index as u64)),
                "slot {index} was refused early"
            );
        }
        assert_eq!(queue.depth(), EVENT_QUEUE_CAP);
        assert!(
            !queue.push(change("one-too-many", &["k"], 9_999)),
            "the push is REFUSED, which is the stall"
        );
        assert!(queue.is_stalled());
        // And nothing was lost: every one of the accepted events is still
        // there, and the refused one was never accepted so nobody believes it
        // was delivered.
        assert_eq!(queue.depth(), EVENT_QUEUE_CAP);
    }

    #[test]
    fn a_stall_replaces_a_waiting_health_event_rather_than_a_change_event() {
        let queue = EventQueue::new();
        queue.push(health(false));
        for index in 0..(EVENT_QUEUE_CAP - 1) {
            queue.push(change(&format!("t{index}"), &["k"], index as u64));
        }
        assert!(!queue.push(change("one-too-many", &["k"], 1)));
        // The health event at the head is now the STALLED one, and every change
        // event behind it survived.
        let Next::Event(Event {
            kind: Some(event::Kind::Health(reported)),
        }) = queue.next(Duration::from_millis(10))
        else {
            panic!("the head is the health event");
        };
        assert!(reported.stalled);
        assert_eq!(reported.capacity, EVENT_QUEUE_CAP as u32);
    }

    /// ONE DRAIN IS NOT ENOUGH when the freed slot is taken by the deferred
    /// stall report — the queue is at its cap again and the stall is still on,
    /// which is the truth. It takes a second drain to clear.
    #[test]
    fn a_stall_clears_only_once_the_queue_is_genuinely_below_its_cap() {
        let queue = EventQueue::new();
        for index in 0..EVENT_QUEUE_CAP {
            queue.push(change(&format!("t{index}"), &["k"], index as u64));
        }
        assert!(!queue.push(change("over", &["k"], 1)));
        assert!(queue.is_stalled());

        let _ = queue.next(Duration::from_millis(10));
        assert!(
            queue.is_stalled(),
            "the freed slot went to the stall report, so the queue is full again"
        );
        let _ = queue.next(Duration::from_millis(10));
        assert!(!queue.is_stalled());
    }

    #[test]
    fn the_health_event_carries_the_seats_distance_behind() {
        let queue = EventQueue::new();
        queue.set_behind(4_000);
        queue.push(health(false));
        for index in 0..(EVENT_QUEUE_CAP - 1) {
            queue.push(change(&format!("t{index}"), &["k"], index as u64));
        }
        assert!(!queue.push(change("over", &["k"], 1)));
        let Next::Event(Event {
            kind: Some(event::Kind::Health(reported)),
        }) = queue.next(Duration::from_millis(10))
        else {
            panic!("the replaced health event is at the head");
        };
        assert!(reported.stalled);
        assert_eq!(reported.behind, 4_000);
    }

    /// A QUEUE FULL OF CHANGE EVENTS still reports its stall — later, on the
    /// first slot a drain frees. Dropping a change event to make room for the
    /// report would be the cure being the disease.
    #[test]
    fn a_stall_with_no_health_slot_is_reported_on_the_next_drain() {
        let queue = EventQueue::new();
        queue.set_behind(77);
        for index in 0..EVENT_QUEUE_CAP {
            queue.push(change(&format!("t{index}"), &["k"], index as u64));
        }
        assert!(!queue.push(change("over", &["k"], 1)));
        assert!(queue.is_stalled());

        // The first drain frees a slot; the deferred stall report takes it.
        let first = queue.next(Duration::from_millis(10));
        assert!(
            matches!(
                first,
                Next::Event(Event {
                    kind: Some(event::Kind::Change(_))
                })
            ),
            "the change event the queue already accepted comes out first"
        );
        let mut saw_stall = false;
        let mut saw_resume = false;
        while let Next::Event(event) = queue.next(Duration::from_millis(1)) {
            if let Some(event::Kind::Health(reported)) = event.kind {
                if reported.stalled {
                    assert_eq!(reported.behind, 77);
                    saw_stall = true;
                } else {
                    saw_resume = true;
                }
            }
        }
        assert!(saw_stall, "the shell was never told the stall BEGAN");
        assert!(saw_resume, "the shell was never told the stall ENDED");
    }

    /// CLOSE UNBLOCKS A WAITER. This is what makes `close` callable from
    /// another thread while the event thread is parked.
    #[test]
    fn close_releases_a_thread_blocked_in_next() {
        let queue = std::sync::Arc::new(EventQueue::new());
        let waiter = std::sync::Arc::clone(&queue);
        let handle = std::thread::spawn(move || waiter.next(Duration::from_secs(30)));
        // Give the waiter time to park. A sleep is the honest tool here: the
        // alternative is another condvar to synchronise the test with the thing
        // under test, which would be testing the test.
        std::thread::sleep(Duration::from_millis(50));
        queue.close();
        assert_eq!(handle.join().expect("the waiter returns"), Next::Closed);
    }

    #[test]
    fn a_close_hands_out_the_events_it_already_accepted_first() {
        let queue = EventQueue::new();
        queue.push(change("note", &["n1"], 1));
        queue.close();
        // The event first, THEN the close. A close is not a discard.
        assert!(matches!(
            queue.next(Duration::from_millis(10)),
            Next::Event(_)
        ));
        assert_eq!(queue.next(Duration::from_millis(10)), Next::Closed);
    }

    #[test]
    fn a_closed_queue_accepts_nothing_new() {
        let queue = EventQueue::new();
        queue.close();
        assert!(!queue.push(change("note", &["n1"], 1)));
        assert!(queue.is_closed());
    }
}
