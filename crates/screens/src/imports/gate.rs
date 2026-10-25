//! WHEN A FOLLOWING PASS RUNS (#1127). Pure: no clock, no timer and no thread, only
//! the instants a caller hands it (the Rust form of the KMP `FollowGate`; the runtime owns
//! the timers). A phone store announces itself in bursts (iOS posts one change per saved
//! contact, and the app coming to the front lands beside it), so:
//!
//! - **Triggers within [`SETTLE`] are one pass.** The first trigger arms a timer; the ones
//!   that arrive before it fires join it. The wait is measured from the FIRST trigger, so a
//!   store that never stops announcing still gets a pass every [`SETTLE`].
//! - **One pass runs per key at a time.** Keys are independent.
//! - **A trigger during a pass queues exactly one more**, however many arrive: the pass
//!   already running read the phone before them, and one more reads it after all of them.

use std::collections::BTreeMap;
use std::time::Duration;

/// Two seconds: long enough to fold one burst of store notifications, short enough to feel live.
pub const SETTLE: Duration = Duration::from_secs(2);

/// What a caller of [`FollowGate`] does next.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Step {
    /// Nothing: the request joined a pass already waiting or queued, or a timer fired for nothing.
    Nothing,
    /// Wait this long, then ask [`FollowGate::fire`].
    Arm(Duration),
    /// Run a pass now, and call [`FollowGate::finish`] when it ends.
    Start,
}

#[derive(Clone, Copy, Debug)]
enum State {
    Waiting { fire_at: Duration },
    Running { queued: bool },
}

/// The gate, over keys (a followed source). Times are offsets from any fixed origin.
#[derive(Debug)]
pub struct FollowGate<K: Ord + Clone> {
    settle: Duration,
    states: BTreeMap<K, State>,
}

impl<K: Ord + Clone> Default for FollowGate<K> {
    fn default() -> Self {
        Self::new(SETTLE)
    }
}

impl<K: Ord + Clone> FollowGate<K> {
    #[must_use]
    pub fn new(settle: Duration) -> Self {
        Self {
            settle,
            states: BTreeMap::new(),
        }
    }

    /// A trigger arrived at `now`.
    pub fn request(&mut self, key: &K, now: Duration) -> Step {
        match self.states.get(key).copied() {
            None => {
                self.states.insert(
                    key.clone(),
                    State::Waiting {
                        fire_at: now + self.settle,
                    },
                );
                Step::Arm(self.settle)
            }
            Some(State::Waiting { .. }) => Step::Nothing,
            Some(State::Running { .. }) => {
                self.states
                    .insert(key.clone(), State::Running { queued: true });
                Step::Nothing
            }
        }
    }

    /// The timer an [`Step::Arm`] asked for fired at `now`: [`Step::Start`] when the wait is over.
    pub fn fire(&mut self, key: &K, now: Duration) -> Step {
        let Some(State::Waiting { fire_at }) = self.states.get(key).copied() else {
            return Step::Nothing;
        };
        if now < fire_at {
            return Step::Nothing;
        }
        self.states
            .insert(key.clone(), State::Running { queued: false });
        Step::Start
    }

    /// The pass ended, however it ended. [`Step::Start`] when triggers arrived during it: the
    /// queued pass runs at once, since they have already waited.
    pub fn finish(&mut self, key: &K) -> Step {
        let Some(State::Running { queued }) = self.states.get(key).copied() else {
            return Step::Nothing;
        };
        if !queued {
            self.states.remove(key);
            return Step::Nothing;
        }
        self.states
            .insert(key.clone(), State::Running { queued: false });
        Step::Start
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ms(n: u64) -> Duration {
        Duration::from_millis(n)
    }

    const CONTACTS: &str = "contacts";
    const CALENDAR: &str = "calendar";

    fn gate() -> FollowGate<&'static str> {
        FollowGate::default()
    }

    #[test]
    fn the_first_trigger_arms_a_two_second_timer_and_the_timer_starts_the_pass() {
        let mut gate = gate();
        assert_eq!(gate.request(&CONTACTS, ms(0)), Step::Arm(ms(2_000)));
        assert_eq!(gate.fire(&CONTACTS, ms(2_000)), Step::Start);
    }

    #[test]
    fn triggers_within_two_seconds_are_one_pass() {
        let mut gate = gate();
        assert_eq!(gate.request(&CONTACTS, ms(0)), Step::Arm(ms(2_000)));
        assert_eq!(gate.request(&CONTACTS, ms(500)), Step::Nothing);
        assert_eq!(gate.request(&CONTACTS, ms(1_999)), Step::Nothing);
        assert_eq!(gate.fire(&CONTACTS, ms(2_000)), Step::Start);
        assert_eq!(gate.finish(&CONTACTS), Step::Nothing);
    }

    #[test]
    fn the_wait_runs_from_the_first_trigger() {
        let mut gate = gate();
        gate.request(&CONTACTS, ms(0));
        for at in (1..2_000).step_by(100) {
            gate.request(&CONTACTS, ms(at));
        }
        assert_eq!(gate.fire(&CONTACTS, ms(2_000)), Step::Start);
    }

    #[test]
    fn a_timer_that_fires_early_starts_nothing_and_the_gate_still_waits() {
        let mut gate = gate();
        gate.request(&CONTACTS, ms(0));
        assert_eq!(gate.fire(&CONTACTS, ms(1_999)), Step::Nothing);
        assert_eq!(gate.fire(&CONTACTS, ms(2_000)), Step::Start);
    }

    #[test]
    fn a_timer_with_nothing_armed_starts_nothing() {
        assert_eq!(gate().fire(&CONTACTS, ms(5_000)), Step::Nothing);
    }

    #[test]
    fn only_one_pass_runs_per_key_at_a_time() {
        let mut gate = gate();
        gate.request(&CONTACTS, ms(0));
        assert_eq!(gate.fire(&CONTACTS, ms(2_000)), Step::Start);
        assert_eq!(gate.fire(&CONTACTS, ms(2_001)), Step::Nothing);
    }

    #[test]
    fn triggers_during_a_pass_queue_exactly_one_more() {
        let mut gate = gate();
        gate.request(&CONTACTS, ms(0));
        assert_eq!(gate.fire(&CONTACTS, ms(2_000)), Step::Start);
        for n in 0..5 {
            assert_eq!(gate.request(&CONTACTS, ms(2_100 + n)), Step::Nothing);
        }
        assert_eq!(gate.finish(&CONTACTS), Step::Start);
        assert_eq!(gate.finish(&CONTACTS), Step::Nothing);
    }

    #[test]
    fn a_trigger_after_a_pass_ended_arms_a_new_timer() {
        let mut gate = gate();
        gate.request(&CONTACTS, ms(0));
        gate.fire(&CONTACTS, ms(2_000));
        assert_eq!(gate.finish(&CONTACTS), Step::Nothing);
        assert_eq!(gate.request(&CONTACTS, ms(9_000)), Step::Arm(ms(2_000)));
        assert_eq!(gate.fire(&CONTACTS, ms(11_000)), Step::Start);
    }

    #[test]
    fn a_trigger_while_the_queued_pass_runs_queues_one_more_not_two() {
        let mut gate = gate();
        gate.request(&CONTACTS, ms(0));
        gate.fire(&CONTACTS, ms(2_000));
        gate.request(&CONTACTS, ms(2_100));
        assert_eq!(gate.finish(&CONTACTS), Step::Start);
        gate.request(&CONTACTS, ms(2_200));
        gate.request(&CONTACTS, ms(2_300));
        assert_eq!(gate.finish(&CONTACTS), Step::Start);
        assert_eq!(gate.finish(&CONTACTS), Step::Nothing);
    }

    #[test]
    fn keys_do_not_hold_each_other_up() {
        let mut gate = gate();
        gate.request(&CONTACTS, ms(0));
        assert_eq!(gate.fire(&CONTACTS, ms(2_000)), Step::Start);
        assert_eq!(gate.request(&CALENDAR, ms(2_100)), Step::Arm(ms(2_000)));
        assert_eq!(gate.fire(&CALENDAR, ms(4_100)), Step::Start);
    }

    #[test]
    fn a_finish_with_no_pass_running_starts_nothing() {
        assert_eq!(gate().finish(&CONTACTS), Step::Nothing);
    }
}
