//! The conductor, driven the way the service drives it: scripted answers, a
//! fake clock. Ports `ShelfDrainSpec`, `DrainPassSpec` (the pass part) and the
//! scheduling specs of the KMP shell.

use std::collections::BTreeMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use centraid_api_proto::core_v1 as wire;

use super::conditions::{Link, Reason};
use super::conductor::*;
use super::rule::{Rules, TransferRule};

fn need(byte: u8) -> wire::NeedBytes {
    wire::NeedBytes {
        content_hash: vec![byte; 32],
        os_ref: format!("L/{byte}"),
        media_type: "image/heic".to_owned(),
        size: 7,
    }
}

fn empty() -> Drained {
    Drained::Response(wire::DrainResponse {
        stopped: wire::DrainStop::Empty as i32,
        acked_at_ms: Some(1),
        ..Default::default()
    })
}

fn with_needs(needs: Vec<wire::NeedBytes>, confirmed: u32) -> Drained {
    Drained::Response(wire::DrainResponse {
        stopped: wire::DrainStop::Empty as i32,
        acked_at_ms: Some(1),
        need_bytes: needs,
        confirmed_parts: confirmed,
        ..Default::default()
    })
}

fn held(id: &str, drainable: bool) -> Held {
    Held {
        vault_id: id.to_owned(),
        drainable,
    }
}

/// How many of the items asked for a stream lands.
type Landed = Box<dyn FnMut(&[wire::NeedBytes]) -> u32>;

/// A conductor plus the shell it is driven against.
struct Sim {
    conductor: Conductor,
    clock: Arc<AtomicU64>,
    /// Every `drain` asked, in order.
    seen: Vec<(String, wire::DrainRequest)>,
    /// The camera-roll walks asked.
    order: Vec<String>,
    streamed: Vec<(String, Vec<wire::NeedBytes>)>,
    scheduled: usize,
    long_runs: Vec<bool>,
    done: Vec<(String, bool)>,
    timers: Vec<(String, Duration)>,
    changed: usize,
    /// What the core answers to a drain.
    answer: Box<dyn FnMut(&wire::DrainRequest) -> Drained>,
    /// How many items a stream lands.
    land: Landed,
    /// Drains held until the test releases them.
    hold: bool,
    held_drains: Vec<String>,
}

impl Sim {
    fn new(vaults: Vec<Held>) -> Self {
        let clock = Arc::new(AtomicU64::new(0));
        let ticks = clock.clone();
        let conductor = Conductor::with_clock(DEBOUNCE, move || ticks.load(Ordering::SeqCst));
        conductor.set_held(vaults);
        conductor.set_rules(Rules::default());
        Self {
            conductor,
            clock,
            seen: Vec::new(),
            order: Vec::new(),
            streamed: Vec::new(),
            scheduled: 0,
            long_runs: Vec::new(),
            done: Vec::new(),
            timers: Vec::new(),
            changed: 0,
            answer: Box::new(|_| empty()),
            land: Box::new(|needs| u32::try_from(needs.len()).unwrap()),
            hold: false,
            held_drains: Vec::new(),
        }
    }

    fn set_clock(&self, ms: u64) {
        self.clock.store(ms, Ordering::SeqCst);
    }

    /// Perform actions the way the service does, answering from the script,
    /// until nothing is left to answer.
    fn run(&mut self, actions: Vec<Action>) {
        let mut work: std::collections::VecDeque<Action> = actions.into();
        while let Some(action) = work.pop_front() {
            let more = match action {
                Action::Walk => {
                    self.order.push("walk".to_owned());
                    self.conductor.walked()
                }
                Action::Drain { vault, request } => {
                    self.seen.push((vault.clone(), request));
                    self.order
                        .push(if request.asked { "pass asked" } else { "pass" }.to_owned());
                    if self.hold {
                        self.held_drains.push(vault);
                        Vec::new()
                    } else {
                        let answer = (self.answer)(&request);
                        self.conductor.drained(&vault, &answer)
                    }
                }
                Action::Stream { vault, needs } => {
                    let landed = (self.land)(&needs);
                    self.streamed.push((vault, needs));
                    self.conductor.streamed(landed)
                }
                Action::Schedule | Action::Nudge => {
                    self.scheduled += 1;
                    Vec::new()
                }
                Action::LongRun(start) => {
                    self.long_runs.push(start);
                    Vec::new()
                }
                Action::WindowDone { window, drained } => {
                    self.done.push((window, drained));
                    Vec::new()
                }
                Action::Timer { name, after } => {
                    self.timers.push((name, after));
                    Vec::new()
                }
                Action::Changed => {
                    self.changed += 1;
                    Vec::new()
                }
                Action::CancelTimer { .. } => Vec::new(),
                other => panic!("unscripted {other:?}"),
            };
            work.extend(more);
        }
    }

    /// Release the oldest held drain with `answer`.
    fn release(&mut self, answer: &Drained) {
        let vault = self.held_drains.remove(0);
        let more = self.conductor.drained(&vault, answer);
        self.run(more);
    }

    fn requests(&self) -> Vec<&wire::DrainRequest> {
        self.seen.iter().map(|(_, request)| request).collect()
    }

    fn deadlines(&self) -> Vec<u64> {
        self.requests().iter().map(|r| r.deadline_ms).collect()
    }
}

fn link(online: bool, metered: Option<bool>, charging: Option<bool>) -> wire::LinkChanged {
    wire::LinkChanged {
        online,
        metered: metered.unwrap_or(false),
        charging: charging.unwrap_or(false),
        metered_known: metered.is_some(),
        charging_known: charging.is_some(),
    }
}

#[test]
fn one_vault_is_driven_the_first_that_can_be_drained() {
    // ONE VAULT PER PHONE IN V0 (#1209, R1): the conductor drives the first held vault that can
    // be drained, with the whole budget.
    let mut sim = Sim::new(vec![held("a", true), held("b", true)]);
    let actions = sim.conductor.trigger(Reason::Scheduled, 60_000);
    sim.run(actions);
    let vaults: Vec<_> = sim.seen.iter().map(|(vault, _)| vault.as_str()).collect();
    assert_eq!(vaults, ["a"]);
    assert_eq!(sim.deadlines(), [60_000], "the budget is not divided");
    assert_eq!(sim.conductor.facts().last.len(), 1);
}

#[test]
fn the_foregrounds_no_deadline_is_passed_through() {
    // `0` means "run until nothing the rule admits is left".
    let mut sim = Sim::new(vec![held("a", true), held("b", true)]);
    let actions = sim.conductor.trigger(Reason::BecameActive, 0);
    sim.run(actions);
    assert_eq!(sim.deadlines(), [0]);
}

#[test]
fn a_resting_holding_is_skipped_for_the_one_that_can_use_the_budget() {
    let mut sim = Sim::new(vec![held("a", true), held("resting", false)]);
    let actions = sim.conductor.trigger(Reason::Scheduled, 60_000);
    sim.run(actions);
    assert_eq!(sim.deadlines(), [60_000]);
    assert_eq!(sim.seen[0].0, "a");
}

#[test]
fn a_frozen_holding_is_skipped_because_the_gateway_would_refuse_it_anyway() {
    let mut sim = Sim::new(vec![held("gone", false), held("a", true)]);
    let actions = sim.conductor.trigger(Reason::Scheduled, 60_000);
    sim.run(actions);
    assert_eq!(sim.seen.len(), 1);
    assert_eq!(sim.seen[0].0, "a");
}

#[test]
fn a_device_holding_nothing_drainable_runs_nothing_and_a_window_that_had_nothing_to_do_drained() {
    let mut sim = Sim::new(vec![held("resting", false)]);
    let actions = sim.conductor.window_granted("centraid-sync-pass", 60_000);
    sim.run(actions);
    assert!(sim.seen.is_empty());
    // A WINDOW THAT HAD NOTHING TO DO DRAINED: there was nothing to send.
    assert_eq!(sim.done, [("centraid-sync-pass".to_owned(), true)]);
    assert!(all_drained(&[]));
    let mut none = Sim::new(Vec::new());
    let actions = none.conductor.trigger(Reason::Scheduled, 60_000);
    none.run(actions);
    assert!(none.seen.is_empty());
}

#[test]
fn a_granted_window_is_told_whether_every_gateway_was_fed() {
    let mut sim = Sim::new(vec![held("a", true)]);
    sim.answer = Box::new(|_| {
        Drained::Response(wire::DrainResponse {
            stopped: wire::DrainStop::Deadline as i32,
            pending_bytes: 9,
            ..Default::default()
        })
    });
    let actions = sim.conductor.window_granted("centraid-night-shift", 60_000);
    sim.run(actions);
    assert_eq!(sim.done, [("centraid-night-shift".to_owned(), false)]);
}

#[test]
fn a_commit_inside_the_debounce_arms_one_timer_for_its_end_instead_of_a_pass() {
    let mut sim = Sim::new(vec![held("a", true)]);
    // THE FIRST COMMIT AFTER LAUNCH RUNS.
    let first = sim.conductor.commit_landed();
    sim.run(first);
    assert_eq!(sim.seen.len(), 1);
    sim.set_clock(4_999);
    let inside = sim.conductor.commit_landed();
    assert_eq!(
        inside,
        [Action::Timer {
            name: "commit".to_owned(),
            after: Duration::from_millis(1)
        }]
    );
    // A BURST IS ONE TIMER, not one per commit.
    assert!(sim.conductor.commit_landed().is_empty());
    assert_eq!(sim.seen.len(), 1);
    // THE TIMER'S END RUNS THE PASS the last commit of the burst is owed.
    sim.set_clock(5_000);
    let later = sim.conductor.timer("commit");
    sim.run(later);
    assert_eq!(sim.seen.len(), 2);
    // AND A COMMIT AFTER THE WINDOW RUNS AT ONCE.
    sim.set_clock(10_001);
    let after = sim.conductor.commit_landed();
    sim.run(after);
    assert_eq!(sim.seen.len(), 3);
}

#[test]
fn becoming_active_is_not_debounced_because_opening_the_app_is_worth_a_pass() {
    let mut sim = Sim::new(vec![held("a", true)]);
    for _ in 0..2 {
        let actions = sim.conductor.trigger(Reason::BecameActive, 0);
        sim.run(actions);
    }
    assert_eq!(sim.seen.len(), 2);
}

#[test]
fn the_rule_and_the_link_cross_with_every_pass_and_an_unknown_reading_is_the_expensive_one() {
    // A guess wrong towards cheap spends a data plan; a guess wrong towards
    // expensive delays a photograph.
    let mut sim = Sim::new(vec![held("a", true)]);
    sim.conductor.set_rules(Rules {
        rule: TransferRule::WifiAndCellularPhotos,
        include_videos: false,
    });
    let actions = sim.conductor.trigger(Reason::Scheduled, 20_000);
    sim.run(actions);
    let sent = sim.requests()[0];
    assert_eq!(sent.rule, wire::TransferRule::WifiAndCellularPhotos as i32);
    assert!(sent.exclude_videos);
    assert!(sent.metered);
    assert!(!sent.charging);
    // AND A KNOWN LINK IS CARRIED AS IT IS.
    let known = sim
        .conductor
        .link_changed(&link(false, Some(false), Some(true)));
    sim.run(known);
    let actions = sim.conductor.trigger(Reason::Scheduled, 20_000);
    sim.run(actions);
    let sent = sim.requests()[1];
    assert!(!sent.metered);
    assert!(sent.charging);
    assert_eq!(sim.conductor.facts().link.metered, Some(false));
}

#[test]
fn only_the_members_own_asks_and_the_app_leaving_force_a_snapshot() {
    let mut sim = Sim::new(vec![held("a", true)]);
    for (reason, deadline) in [
        (Reason::SessionOpened, 0),
        (Reason::BecameActive, 0),
        (Reason::AfterImport, 0),
        (Reason::Scheduled, 30_000),
        (Reason::BackUpNow, 0),
        (Reason::EnteredBackground, 25_000),
        (Reason::Restored, 0),
        (Reason::Paired, 0),
    ] {
        let actions = sim.conductor.trigger(reason, deadline);
        sim.run(actions);
    }
    let snapshots: Vec<_> = sim.requests().iter().map(|r| r.wants_snapshot).collect();
    assert_eq!(
        snapshots,
        [false, false, false, false, true, true, true, true]
    );
    let forcing: Vec<_> = Reason::ALL
        .into_iter()
        .filter(|r| r.wants_snapshot())
        .collect();
    assert_eq!(
        forcing,
        [
            Reason::BackUpNow,
            Reason::EnteredBackground,
            Reason::Restored,
            Reason::Paired
        ]
    );
}

#[test]
fn only_the_button_is_the_member_asking_leaving_the_screen_times_a_snapshot_and_asks_nothing() {
    // #1080 A24.
    let mut sim = Sim::new(vec![held("a", true)]);
    for reason in [
        Reason::EnteredBackground,
        Reason::BackUpNow,
        Reason::Restored,
        Reason::Scheduled,
    ] {
        let actions = sim.conductor.trigger(reason, 0);
        sim.run(actions);
    }
    let pairs: Vec<_> = sim
        .requests()
        .iter()
        .map(|r| (r.wants_snapshot, r.asked))
        .collect();
    // LEAVING SENDS THE SNAPSHOT WITHOUT THE ASK: under MANUAL it must not seal
    // an original, nor a video off the charger.
    assert_eq!(
        pairs,
        [(true, false), (true, true), (true, false), (false, false)]
    );
    let asking: Vec<_> = Reason::ALL.into_iter().filter(|r| r.asked()).collect();
    assert_eq!(asking, [Reason::BackUpNow]);
}

#[test]
fn opening_becoming_active_and_back_up_now_walk_the_camera_roll_before_their_pass() {
    // ON THE SIMULATOR, a photograph added while Centraid was closed was still
    // not in the vault after a launch and a "Back up now": nothing walked the
    // roll but "Import now", a grant, or a library change while the app was open.
    let mut sim = Sim::new(vec![held("a", true)]);
    for reason in [
        Reason::SessionOpened,
        Reason::BecameActive,
        Reason::BackUpNow,
    ] {
        let actions = sim.conductor.trigger(reason, 0);
        sim.run(actions);
    }
    assert_eq!(
        sim.order,
        ["walk", "pass", "walk", "pass", "walk", "pass asked"]
    );
    // NOTHING ELSE WALKS: an import's own pass would walk itself in a loop, and
    // a window or the grace has no time for a camera roll.
    sim.order.clear();
    let mut all = sim.conductor.commit_landed();
    all.extend(sim.conductor.trigger(Reason::AfterImport, 0));
    all.extend(
        sim.conductor
            .link_changed(&link(true, Some(false), Some(false))),
    );
    all.extend(sim.conductor.trigger(Reason::Scheduled, 60_000));
    all.extend(sim.conductor.entered_background());
    all.extend(sim.conductor.trigger(Reason::Restored, 0));
    sim.run(all);
    assert!(!sim.order.iter().any(|step| step == "walk"));
}

#[test]
fn a_link_that_went_down_runs_nothing_and_a_flapping_one_runs_once_per_debounce() {
    let mut sim = Sim::new(vec![held("a", true)]);
    let down = sim
        .conductor
        .link_changed(&link(false, Some(false), Some(false)));
    sim.run(down);
    assert!(sim.seen.is_empty());
    let up = sim
        .conductor
        .link_changed(&link(true, Some(false), Some(false)));
    sim.run(up);
    assert_eq!(sim.seen.len(), 1);
    let again = sim
        .conductor
        .link_changed(&link(true, Some(false), Some(false)));
    assert!(
        again
            .iter()
            .any(|a| matches!(a, Action::Timer { name, .. } if name == "link"))
    );
    sim.run(again);
    assert_eq!(sim.seen.len(), 1);
    sim.set_clock(DEBOUNCE.as_millis() as u64 + 1);
    let later = sim
        .conductor
        .link_changed(&link(true, Some(false), Some(false)));
    sim.run(later);
    assert_eq!(sim.seen.len(), 2);
}

#[test]
fn a_commit_a_moment_ago_does_not_swallow_the_move_to_wifi() {
    let mut sim = Sim::new(vec![held("a", true)]);
    let commit = sim.conductor.commit_landed();
    sim.run(commit);
    let up = sim
        .conductor
        .link_changed(&link(true, Some(false), Some(false)));
    sim.run(up);
    assert_eq!(sim.seen.len(), 2);
}

#[test]
fn bytes_the_core_asked_for_are_streamed_in_and_the_pass_runs_again_without_a_second_snapshot() {
    let mut sim = Sim::new(vec![held("a", true)]);
    let mut round = 0;
    sim.answer = Box::new(move |_| {
        round += 1;
        if round == 1 {
            with_needs(vec![need(1)], 0)
        } else {
            empty()
        }
    });
    let actions = sim.conductor.trigger(Reason::BackUpNow, 0);
    sim.run(actions);
    assert_eq!(sim.streamed, [("a".to_owned(), vec![need(1)])]);
    let snapshots: Vec<_> = sim.requests().iter().map(|r| r.wants_snapshot).collect();
    assert_eq!(snapshots, [true, false]);
    // THE MEMBER'S ASK COVERS THE WHOLE PASS, every round of it (A24).
    let asked: Vec<_> = sim.requests().iter().map(|r| r.asked).collect();
    assert_eq!(asked, [true, true]);
}

#[test]
fn the_same_ask_twice_is_no_progress_and_a_library_that_will_not_produce_bytes_cannot_spin() {
    let mut sim = Sim::new(vec![held("a", true)]);
    sim.answer = Box::new(|_| with_needs(vec![need(2)], 0));
    let actions = sim.conductor.trigger(Reason::BecameActive, 0);
    sim.run(actions);
    assert_eq!(sim.seen.len(), 2);
    // AND A FEED THAT LANDED NOTHING ENDS THE PASS AT ONCE.
    let mut again = Sim::new(vec![held("a", true)]);
    again.answer = Box::new(|_| with_needs(vec![need(2)], 0));
    again.land = Box::new(|_| 0);
    let actions = again.conductor.trigger(Reason::BecameActive, 0);
    again.run(actions);
    assert_eq!(again.seen.len(), 1);
}

#[test]
fn an_original_larger_than_the_spool_is_fed_again_while_its_windows_move_and_stops_when_one_does_not()
 {
    let mut sim = Sim::new(vec![held("a", true)]);
    let mut round = 0;
    sim.answer = Box::new(move |_| {
        round += 1;
        // THE SAME ASK EACH ROUND; rounds two and three moved the window the
        // round before them sealed, round four did not.
        with_needs(vec![need(3)], u32::from((2..=3).contains(&round)))
    });
    let actions = sim.conductor.trigger(Reason::BackUpNow, 0);
    sim.run(actions);
    assert_eq!(sim.seen.len(), 4);
    // A WINDOW THAT KEEPS MOVING STILL ENDS AT THE ROUND LIMIT.
    let mut bounded = Sim::new(vec![held("a", true)]);
    bounded.answer = Box::new(|_| with_needs(vec![need(3)], 1));
    let actions = bounded.conductor.trigger(Reason::BackUpNow, 0);
    bounded.run(actions);
    assert_eq!(bounded.seen.len(), MAX_ROUNDS as usize);
}

#[test]
fn a_round_stops_when_too_little_of_the_budget_is_left() {
    let mut sim = Sim::new(vec![held("a", true)]);
    sim.answer = Box::new(|_| with_needs(vec![need(4)], 0));
    // THE FIRST ROUND TOOK ALMOST ALL OF THE VAULT'S SHARE.
    let actions = sim.conductor.trigger(Reason::Scheduled, 10_000);
    sim.set_clock(9_000);
    sim.run(actions);
    assert_eq!(sim.seen.len(), 1);
    assert!(sim.streamed.is_empty());
}

#[test]
fn a_second_back_up_now_joins_the_first_and_both_answer_when_it_ends() {
    let mut sim = Sim::new(vec![held("a", true)]);
    sim.hold = true;
    let first = sim.conductor.trigger(Reason::BackUpNow, 0);
    sim.run(first);
    assert!(sim.conductor.facts().backing_up);
    let second = sim.conductor.trigger(Reason::BackUpNow, 0);
    assert!(second.is_empty(), "a press while it runs joins it");
    sim.release(&empty());
    assert_eq!(sim.seen.len(), 1);
    assert!(!sim.conductor.facts().backing_up);
    // THE LONG RUN IS HELD FOR THE WHOLE OF IT AND ALWAYS RELEASED.
    assert_eq!(sim.long_runs, [true, false]);
}

#[test]
fn a_pass_that_is_owed_a_snapshot_waits_for_the_running_one_instead_of_taking_busy() {
    let mut sim = Sim::new(vec![held("a", true)]);
    sim.hold = true;
    let foreground = sim.conductor.trigger(Reason::BecameActive, 0);
    sim.run(foreground);
    let leaving = sim.conductor.entered_background();
    sim.run(leaving);
    // ONE DRAIN IS RUNNING; THE OTHER WAITS.
    assert_eq!(sim.seen.len(), 1);
    sim.release(&empty());
    assert_eq!(sim.seen.len(), 2);
    assert!(sim.seen[1].1.wants_snapshot);
    assert!(!sim.seen[0].1.wants_snapshot);
    sim.release(&empty());
    assert_eq!(sim.done, [(BACKGROUND_WINDOW.to_owned(), true)]);
}

#[test]
fn a_pass_that_is_not_owed_a_snapshot_is_refused_while_one_runs() {
    let mut sim = Sim::new(vec![held("a", true)]);
    sim.hold = true;
    let first = sim.conductor.trigger(Reason::Scheduled, 60_000);
    sim.run(first);
    let second = sim.conductor.trigger(Reason::AfterImport, 0);
    sim.run(second);
    // THE DOOR IS CALLED ONCE, and the second run reports Busy.
    assert_eq!(sim.seen.len(), 1);
    assert!(sim.conductor.facts().busy.contains("a"));
    sim.release(&empty());
    assert!(!sim.conductor.facts().busy.contains("a"));
}

#[test]
fn a_snapshot_owed_pass_gives_up_when_its_budget_ran_out_waiting() {
    let mut sim = Sim::new(vec![held("a", true)]);
    sim.hold = true;
    let first = sim.conductor.trigger(Reason::BecameActive, 0);
    sim.run(first);
    let leaving = sim.conductor.entered_background();
    sim.run(leaving);
    assert!(
        sim.timers
            .iter()
            .any(|(name, after)| name.starts_with("idle:")
                && *after == Duration::from_millis(BACKGROUND_GRACE_MS))
    );
    let name = sim.timers.last().unwrap().0.clone();
    let more = sim.conductor.timer(&name);
    sim.run(more);
    assert_eq!(sim.done, [(BACKGROUND_WINDOW.to_owned(), false)]);
    assert_eq!(sim.seen.len(), 1);
}

#[test]
fn the_next_window_is_asked_for_on_every_path_including_one_that_stopped_short() {
    // A `BGTaskRequest` IS ONE-SHOT. A pass that only resubmitted when it
    // emptied the spool would run once in the life of an install, which reads
    // to a member as "it worked the first day".
    let mut sim = Sim::new(vec![held("a", true)]);
    sim.answer = Box::new(|_| {
        Drained::Response(wire::DrainResponse {
            stopped: wire::DrainStop::Unreachable as i32,
            pending_bytes: 900,
            ..Default::default()
        })
    });
    let actions = sim.conductor.trigger(Reason::Scheduled, 20_000);
    sim.run(actions);
    assert_eq!(sim.scheduled, 1);
    let mut none = Sim::new(vec![held("a", true)]);
    none.answer = Box::new(|_| Drained::Unavailable);
    let actions = none.conductor.trigger(Reason::Scheduled, 20_000);
    none.run(actions);
    assert_eq!(none.scheduled, 1);
}

#[test]
fn leaving_the_app_arms_the_windows_again() {
    let mut sim = Sim::new(vec![held("a", true)]);
    let actions = sim.conductor.entered_background();
    assert!(actions.contains(&Action::Schedule));
    sim.run(actions);
}

#[test]
fn a_pass_answers_what_the_core_answered_and_nothing_it_worked_out_itself() {
    let mut sim = Sim::new(vec![held("a", true)]);
    sim.answer = Box::new(|_| {
        Drained::Response(wire::DrainResponse {
            stopped: wire::DrainStop::Empty as i32,
            acked_at_ms: Some(1_700_000_000_000),
            confirmed_parts: 41,
            ..Default::default()
        })
    });
    let actions = sim.conductor.trigger(Reason::Scheduled, 25_000);
    sim.run(actions);
    let Some(Pass::Ran(answer)) = sim.conductor.facts().last.get("a").cloned() else {
        panic!("the vault's pass ran");
    };
    assert_eq!(answer.acked_at_ms, Some(1_700_000_000_000));
    assert_eq!(answer.confirmed_parts, 41);
    assert_eq!(answer.stopped, Stopped::Empty);
    assert!(answer.drained());
}

#[test]
fn no_core_to_ask_is_not_a_failure_and_is_not_a_sentence() {
    let mut sim = Sim::new(vec![held("a", true)]);
    sim.answer = Box::new(|_| Drained::Unavailable);
    let actions = sim.conductor.trigger(Reason::Scheduled, 25_000);
    sim.run(actions);
    assert_eq!(
        sim.conductor.facts().last.get("a"),
        Some(&Pass::Unavailable)
    );
}

#[test]
fn every_stop_reason_is_read_as_the_core_said_it() {
    for (stop, expected) in [
        (wire::DrainStop::Empty, Stopped::Empty),
        (wire::DrainStop::Deadline, Stopped::Deadline),
        (wire::DrainStop::Unreachable, Stopped::Unreachable),
        (wire::DrainStop::Untrusted, Stopped::Untrusted),
        (wire::DrainStop::Refused, Stopped::Refused),
        // "UPDATE YOUR GATEWAY" IS A REFUSAL THE MEMBER ACTS ON, not a wait.
        (wire::DrainStop::TooOld, Stopped::Refused),
        // UNSPECIFIED IS READ AS UNREACHABLE, DELIBERATELY: the safe reading of
        // "I do not know why it stopped" leaves the claim behind.
        (wire::DrainStop::Unspecified, Stopped::Unreachable),
    ] {
        let mut sim = Sim::new(vec![held("a", true)]);
        sim.answer = Box::new(move |_| {
            Drained::Response(wire::DrainResponse {
                stopped: stop as i32,
                ..Default::default()
            })
        });
        let actions = sim.conductor.trigger(Reason::Scheduled, 25_000);
        sim.run(actions);
        let Some(Pass::Ran(answer)) = sim.conductor.facts().last.get("a").cloned() else {
            panic!("ran");
        };
        assert_eq!(answer.stopped, expected, "{stop:?}");
    }
}

#[test]
fn a_moved_vault_is_an_answer_dated_by_the_gateway_and_reported_for_the_shelf_to_freeze() {
    let moved = Drained::of(Err(wire::Error {
        code: wire::ErrorCode::VaultMoved as i32,
        moved: Some(wire::VaultMoved {
            current_epoch: 2,
            moved_at_ms: 1_780_000_000_000,
        }),
        ..Default::default()
    }));
    let mut sim = Sim::new(vec![held("a", true)]);
    sim.answer = Box::new(move |_| moved.clone());
    let actions = sim.conductor.trigger(Reason::Scheduled, 10_000);
    sim.run(actions);
    let facts = sim.conductor.facts();
    assert_eq!(facts.moved.iter().cloned().collect::<Vec<_>>(), ["a"]);
    let Some(Pass::Ran(answer)) = facts.last.get("a").cloned() else {
        panic!("ran");
    };
    assert_eq!(answer.stopped, Stopped::Moved);
    assert_eq!(answer.moved_at_ms, Some(1_780_000_000_000));
    assert!(!all_drained(&[Outcome {
        vault_id: "a".to_owned(),
        pass: Pass::Ran(answer),
        reason: Reason::Scheduled,
    }]));
    // A REFUSAL THAT IS NOT A MOVE IS "NO PASS RAN", including "a drain is
    // already running".
    let busy = Drained::of(Err(wire::Error {
        code: wire::ErrorCode::InvalidRequest as i32,
        ..Default::default()
    }));
    assert_eq!(busy, Drained::Unavailable);
}

#[test]
fn a_run_reports_its_outcome() {
    let mut sim = Sim::new(vec![held("a", true), held("b", true)]);
    let actions = sim.conductor.trigger(Reason::Scheduled, 60_000);
    sim.run(actions);
    let facts = sim.conductor.facts();
    let reasons: BTreeMap<_, _> = facts.last.keys().map(|k| (k.clone(), ())).collect();
    assert_eq!(reasons.len(), 1, "one vault in v0");
}

#[test]
fn registration_is_worded_for_what_the_os_took() {
    use crate::strings::Locale;
    let en = Locale::En;
    let both = Registration {
        short: true,
        long: true,
    };
    assert_eq!(
        both.sentence(en, "ios"),
        "Centraid catches up in the background."
    );
    assert!(both.registered());
    assert!(
        Registration {
            short: false,
            long: true
        }
        .sentence(en, "ios")
        .starts_with("Centraid backs up in the background.")
    );
    assert!(
        Registration {
            short: true,
            long: false
        }
        .sentence(en, "ios")
        .starts_with("Centraid catches up on changes in the background.")
    );
    let none = Registration {
        short: false,
        long: false,
    };
    assert!(!none.registered());
    assert_eq!(
        none.sentence(en, "ios"),
        "Background App Refresh is off, so Centraid only catches up when you open it."
    );
    assert_eq!(
        none.sentence(en, "android"),
        "Centraid cannot catch up in the background on this phone."
    );
}

// ---- the OS's uploads ------------------------------------------------------------

fn bundle(name: &str, vault: &str) -> wire::HandoffPart {
    wire::HandoffPart {
        name: name.to_owned(),
        path: format!("/staging/{name}"),
        url: format!("https://192.168.1.20:7443/v1/v/{vault}/bundle"),
        method: "POST".to_owned(),
        size: 1_024,
        gateway_id: "gw-1".to_owned(),
        vault_id: vault.to_owned(),
        headers: vec![
            wire::Header {
                name: "authorization".to_owned(),
                value: "Bearer t".to_owned(),
            },
            wire::Header {
                name: "content-length".to_owned(),
                value: "1024".to_owned(),
            },
        ],
        allows_cellular: true,
    }
}

fn ios(vaults: Vec<Held>) -> Conductor {
    let conductor = Conductor::default();
    conductor.set_held(vaults);
    conductor.set_uploads(true);
    conductor
}

/// A pass that answers `bundles` for the OS.
fn naming(bundles: Vec<wire::HandoffPart>) -> Drained {
    Drained::Response(wire::DrainResponse {
        stopped: wire::DrainStop::Empty as i32,
        os_bundles: bundles,
        ..Default::default()
    })
}

#[test]
fn a_pass_that_names_bundle_files_asks_the_os_how_many_it_holds_and_enqueues_them_only_if_none() {
    let files = vec![bundle("a", "v1"), bundle("b", "v1")];
    let mut sim = Sim::new(vec![held("v1", true)]);
    sim.conductor.set_uploads(true);
    let named = files.clone();
    sim.answer = Box::new(move |request| {
        assert!(request.os_uploads, "the pass says the OS carries files");
        naming(named.clone())
    });
    // The pass answers its files; the conductor asks the OS before it hands them over.
    let actions = sim.conductor.trigger(Reason::Scheduled, 20_000);
    let mut asked = Vec::new();
    for action in actions {
        match action {
            Action::Drain { vault, request } => {
                sim.seen.push((vault.clone(), request));
                asked.extend(sim.conductor.drained(&vault, &(sim.answer)(&request)));
            }
            other => asked.push(other),
        }
    }
    assert!(asked.contains(&Action::UploadsPending), "{asked:?}");
    assert!(
        !asked
            .iter()
            .any(|action| matches!(action, Action::UploadsEnqueue(_))),
        "nothing is enqueued before the OS says how many tasks it holds"
    );
    // THE OS HOLDS NONE: the files go over whole.
    assert_eq!(
        sim.conductor.pending(0),
        [Action::UploadsEnqueue(files.clone())]
    );
    // A SLOW UPLOAD IS NOT ASKED FOR TWICE: the OS still holds tasks, so nothing is enqueued.
    let again = sim.conductor.trigger(Reason::Scheduled, 20_000);
    let mut more = Vec::new();
    for action in again {
        if let Action::Drain { vault, request } = action {
            more.extend(sim.conductor.drained(&vault, &(sim.answer)(&request)));
        }
    }
    assert!(more.contains(&Action::UploadsPending));
    assert!(sim.conductor.pending(3).is_empty());
    // And a count with nothing parked is nothing to do.
    assert!(sim.conductor.pending(0).is_empty());
}

#[test]
fn bundle_files_are_asked_for_only_where_the_os_carries_them() {
    let mut android = Sim::new(vec![held("a", true)]);
    let actions = android.conductor.trigger(Reason::Scheduled, 20_000);
    android.run(actions);
    assert!(
        !android.requests()[0].os_uploads,
        "nobody carries files here"
    );
}

#[test]
fn what_the_os_reports_only_wakes_one_pass_and_records_nothing() {
    // A finished task, a failed one and the session's end are one wake: a pass re-reads each
    // head and diffs (R7). There is no door to record a settle in, so none is asked.
    let conductor = ios(vec![held("v1", true)]);
    let first = conductor.upload_settled(&wire::UploadSettled {
        name: "a".to_owned(),
        http_status: 201,
        gateway_id: "gw-1".to_owned(),
        vault_id: "v1".to_owned(),
        ..Default::default()
    });
    assert!(
        first
            .iter()
            .any(|action| matches!(action, Action::Drain { request, .. } if !request.wants_snapshot && !request.asked)),
        "a pass runs: {first:?}"
    );
    assert!(
        conductor.uploads_drained().is_empty(),
        "the burst is one pass"
    );
    assert!(
        conductor
            .upload_settled(&wire::UploadSettled::default())
            .is_empty()
    );
    // Where no OS carries files, a report is nobody's.
    let android = Conductor::default();
    android.set_held(vec![held("v1", true)]);
    assert!(android.uploads_drained().is_empty());
}

#[test]
fn changing_the_rule_asks_for_the_windows_again_and_lets_go_of_the_uploads_the_os_holds() {
    // A TASK KEEPS THE CELLULAR FLAG of the rule it was written under, so the tasks enqueued
    // under the old rule are cancelled; the next pass writes its files under the new one.
    let conductor = ios(Vec::new());
    let actions = conductor.rule_changed();
    assert!(actions.contains(&Action::Schedule));
    assert!(actions.contains(&Action::UploadsCancelAll));
    let android = Conductor::default();
    assert!(!android.rule_changed().contains(&Action::UploadsCancelAll));
}

#[test]
fn the_default_link_is_unknown_and_so_the_expensive_answer() {
    assert_eq!(Link::UNKNOWN.metered, None);
    assert_eq!(Link::UNKNOWN.charging, None);
}

// ---- what crosses the door, both ways (CoreBackupDoorsSpec's pass cases) ----------

#[test]
fn the_pass_carries_the_rule_the_link_the_snapshot_the_videos_negation_and_the_ask() {
    use super::conditions::Conditions;
    let conditions = Conditions {
        rules: Rules {
            rule: TransferRule::WifiAndCellularPhotos,
            include_videos: false,
        },
        link: Link {
            online: true,
            metered: Some(true),
            charging: Some(false),
        },
        uploads: true,
    };
    let sent = conditions.request(25_000, Reason::BackUpNow);
    assert_eq!(sent.deadline_ms, 25_000);
    assert_eq!(sent.rule, wire::TransferRule::WifiAndCellularPhotos as i32);
    assert!(sent.metered && !sent.charging && sent.wants_snapshot);
    assert!(sent.os_uploads, "the OS carries bundle files");
    // THE MEMBER'S TAP CROSSES AS ITS OWN BIT (#1080 A24).
    assert!(sent.asked);
    // THE WIRE CARRIES THE NEGATION: included is the zero value.
    assert!(sent.exclude_videos);
    let whole = Conditions {
        rules: Rules::default(),
        link: Link::UNKNOWN,
        uploads: false,
    }
    .request(0, Reason::EnteredBackground);
    assert!(whole.wants_snapshot, "leaving the screen times a snapshot");
    // A SNAPSHOT NOBODY ASKED FOR carries no ask.
    assert!(!whole.asked && !whole.exclude_videos);
    assert_eq!(whole.rule, wire::TransferRule::WifiOnly as i32);
}

#[test]
fn the_answer_keeps_the_gateways_clock_and_drops_a_hash_of_the_wrong_length() {
    let mut sim = Sim::new(vec![held("a", true)]);
    sim.answer = Box::new(|_| {
        Drained::Response(wire::DrainResponse {
            pending_bytes: 900,
            stopped: wire::DrainStop::Deadline as i32,
            acked_at_ms: Some(1_790_000_000_000),
            confirmed_parts: 12,
            waiting_bytes_parts: 3,
            need_bytes: vec![
                need(1),
                // A HASH OF THE WRONG LENGTH IS DROPPED, never streamed against.
                wire::NeedBytes {
                    content_hash: vec![0; 3],
                    os_ref: "L/2".to_owned(),
                    ..Default::default()
                },
            ],
            ..Default::default()
        })
    });
    let actions = sim.conductor.trigger(Reason::Scheduled, 20_000);
    sim.run(actions);
    let Some(Pass::Ran(answer)) = sim.conductor.facts().last.get("a").cloned() else {
        panic!("ran");
    };
    assert_eq!(answer.stopped, Stopped::Deadline);
    assert_eq!(answer.pending_bytes, 900);
    assert_eq!(answer.acked_at_ms, Some(1_790_000_000_000));
    assert_eq!(answer.confirmed_parts, 12);
    assert_eq!(answer.waiting_bytes_parts, 3);
    assert_eq!(answer.need_bytes, vec![need(1)]);
    assert!(!answer.drained());
}

#[test]
fn every_reason_a_pass_is_named_for_has_a_trigger() {
    // A TRIGGER WITH NO CALLER IS A PASS THAT NEVER RUNS: `afterRestore` was
    // written, documented and tabled, and nothing called it, so a restored phone
    // counted its whole library as not backed up. Each reason has an entry point
    // that starts a pass carrying exactly what the reason says.
    type Start = Box<dyn Fn(&Conductor) -> Vec<Action>>;
    let entries: Vec<(Reason, Start)> = vec![
        (
            Reason::SessionOpened,
            Box::new(|c| c.trigger(Reason::SessionOpened, 0)),
        ),
        (
            Reason::BecameActive,
            Box::new(|c| c.trigger(Reason::BecameActive, 0)),
        ),
        (Reason::AfterCommit, Box::new(|c| c.commit_landed())),
        (
            Reason::AfterImport,
            Box::new(|c| c.trigger(Reason::AfterImport, 0)),
        ),
        (
            Reason::Connectivity,
            Box::new(|c| c.link_changed(&link(true, Some(false), Some(false)))),
        ),
        (
            Reason::Scheduled,
            Box::new(|c| c.window_granted("centraid-sync-pass", 1_000)),
        ),
        (
            Reason::BackUpNow,
            Box::new(|c| c.trigger(Reason::BackUpNow, 0)),
        ),
        (
            Reason::EnteredBackground,
            Box::new(|c| c.entered_background()),
        ),
        (
            Reason::Restored,
            Box::new(|c| c.trigger(Reason::Restored, 0)),
        ),
        (Reason::Paired, Box::new(|c| c.trigger(Reason::Paired, 0))),
        (
            Reason::UploadsReported,
            Box::new(|c| {
                c.set_uploads(true);
                c.uploads_reported()
            }),
        ),
    ];
    assert_eq!(entries.len(), Reason::ALL.len());
    for (reason, start) in entries {
        let mut sim = Sim::new(vec![held("a", true)]);
        let actions = start(&sim.conductor);
        sim.run(actions);
        assert_eq!(sim.seen.len(), 1, "{reason:?} starts one pass");
        let sent = sim.requests()[0];
        assert_eq!(sent.wants_snapshot, reason.wants_snapshot(), "{reason:?}");
        assert_eq!(sent.asked, reason.asked(), "{reason:?}");
        assert_eq!(
            sim.order.contains(&"walk".to_owned()),
            reason.walks_first(),
            "{reason:?}"
        );
    }
}
