//! THE PASS SERVICE, end to end through the door a shell uses (#1135, lane H2):
//! the app's lifecycle, the link, commits, granted windows and the member's asks
//! go in; the effects a shell performs come out. The core's `drain` runs against
//! the real core where a gateway is not needed, and against hand-built answers
//! for every stop reason.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use centraid_api_proto::core_v1 as wire;
use centraid_screens::Runtime;
use centraid_screens::catalog::act;
use centraid_screens::custody::secrets::VaultSecrets;
use centraid_screens::field::Keyed;
use centraid_screens::passes::conductor::{BACKGROUND_WINDOW, Pass, Stopped};
use centraid_screens::passes::{self, windows};
use centraid_screens::screen::{Ctx, Screen};
use centraid_screens::testing::{Driver, FakeShell};
use prost::Message;
use wire::screen_event::Kind as E;

const PROBE: &str = "test.backup";
const QUIET: &str = "test.quiet";

/// Stands in for the Backup screen: it asks "Back up now" through the shared
/// conductor on `Appeared`, and draws whether one is running.
struct Probe {
    conductor: passes::Conductor,
    ask: bool,
}

impl Screen for Probe {
    fn update(&mut self, event: wire::ScreenEvent, ctx: &Ctx) -> Vec<wire::Effect> {
        if matches!(event.kind, Some(E::Appeared(_))) && self.ask {
            self.conductor.ask(ctx, wire::pass_asked::Ask::BackUpNow);
        }
        Vec::new()
    }

    fn view(&self, _ctx: &Ctx) -> wire::ViewState {
        let backing_up = self.conductor.facts().backing_up;
        wire::ViewState {
            kind: Some(wire::view_state::Kind::Counter(wire::CounterView {
                title: if backing_up { "backing up" } else { "idle" }.to_owned(),
                content: None,
            })),
            ..Default::default()
        }
    }
}

/// The camera-roll service's stand-in: it records what the pass service posted
/// and, when a test says the work ended, reports as the real one does.
#[derive(Clone, Default)]
struct RollLog {
    seen: Arc<Mutex<VecDeque<wire::ImportsCameraRollEvent>>>,
    reports: Arc<Mutex<VecDeque<wire::roll_reported::Kind>>>,
}

struct FakeRoll(RollLog);

impl Screen for FakeRoll {
    fn update(&mut self, event: wire::ScreenEvent, ctx: &Ctx) -> Vec<wire::Effect> {
        match event.kind {
            Some(E::ImportsCameraRoll(asked)) => self.0.seen.lock().unwrap().push_back(asked),
            Some(E::DataChanged(_)) => {
                while let Some(kind) = self.0.reports.lock().unwrap().pop_front() {
                    ctx.post(
                        passes::service::NAME,
                        wire::ScreenEvent {
                            kind: Some(E::RollReported(wire::RollReported { kind: Some(kind) })),
                        },
                    );
                }
            }
            _ => {}
        }
        Vec::new()
    }

    fn view(&self, _ctx: &Ctx) -> wire::ViewState {
        wire::ViewState::default()
    }
}

/// The pass service is the first instance the runtime opens, the roll next.
const SERVICE: u64 = 1;
const ROLL: u64 = 2;

struct Rig {
    driver: Driver,
    shell: FakeShell,
    secrets: VaultSecrets,
    /// The doors the service asked of the core and nobody has answered, oldest first.
    calls: std::collections::VecDeque<(String, wire::Request)>,
    roll: RollLog,
}

impl Rig {
    fn new() -> Self {
        Self::with_shell(FakeShell::default())
    }

    /// What a shell's next change push does to a screen that reads the
    /// conductor's facts: it draws them again.
    fn redraw(&mut self, instance: u64) {
        self.driver.send(
            instance,
            E::DataChanged(wire::DataChanged { tables: vec![] }),
        );
    }

    fn with_shell(shell: FakeShell) -> Self {
        let secrets = VaultSecrets::new();
        let probe_secrets = secrets.clone();
        let quiet_secrets = secrets.clone();
        let roll = RollLog::default();
        let fake_roll = roll.clone();
        let registry = passes::registry(&secrets)
            .with(centraid_screens::imports::CAMERA_ROLL, move |_| {
                Some(Box::new(FakeRoll(fake_roll.clone())))
            })
            .with(PROBE, move |_| {
                Some(Box::new(Probe {
                    conductor: probe_secrets.conductor().clone(),
                    ask: true,
                }))
            })
            .with(QUIET, move |_| {
                Some(Box::new(Probe {
                    conductor: quiet_secrets.conductor().clone(),
                    ask: false,
                }))
            });
        let root = wire::Route {
            screen: QUIET.to_owned(),
            args: None,
        };
        let runtime = Runtime::new(registry, vec![("t".to_owned(), root)]).with_services({
            let mut services = passes::services();
            services.push(wire::Route {
                screen: centraid_screens::imports::CAMERA_ROLL.to_owned(),
                args: None,
            });
            services
        });
        Self {
            driver: Driver::with_runtime(runtime),
            shell,
            secrets,
            calls: std::collections::VecDeque::new(),
            roll,
        }
    }

    /// Open the runtime and answer the device-store read, as a shell does.
    fn launch(&mut self) {
        self.driver.start();
        self.driver.serve(&mut self.shell);
    }

    fn position(&self, pick: impl Fn(&wire::Effect) -> bool) -> Option<usize> {
        self.driver
            .effects
            .iter()
            .position(|request| request.effect.as_ref().is_some_and(&pick))
    }

    fn has(&self, pick: impl Fn(&wire::Effect) -> bool) -> bool {
        self.position(pick).is_some()
    }

    /// Answer the oldest effect `pick` names.
    fn answer(
        &mut self,
        pick: impl Fn(&wire::Effect) -> bool,
        outcome: wire::effect_result::Outcome,
    ) {
        let at = self.position(pick).expect("the effect was asked");
        let request = self.driver.effects.remove(at);
        self.driver.send(
            request.instance,
            E::EffectResult(wire::EffectResult {
                effect_id: request.effect_id,
                outcome: Some(outcome),
            }),
        );
    }

    /// Whether the pass service asked the camera-roll service to walk.
    fn walk_asked(&self) -> bool {
        self.roll.seen.lock().unwrap().iter().any(|asked| {
            matches!(
                asked.kind,
                Some(wire::imports_camera_roll_event::Kind::Walk(_))
            )
        })
    }

    /// The camera-roll service reports `kind` to the pass service.
    fn report(&mut self, kind: wire::roll_reported::Kind) {
        self.roll.reports.lock().unwrap().push_back(kind);
        self.redraw(ROLL);
    }

    /// The walk the pass service asked for ended.
    fn walk(&mut self) {
        let mut seen = self.roll.seen.lock().unwrap();
        let at = seen
            .iter()
            .position(|asked| {
                matches!(
                    asked.kind,
                    Some(wire::imports_camera_roll_event::Kind::Walk(_))
                )
            })
            .expect("the roll was asked to walk");
        seen.remove(at);
        drop(seen);
        self.report(wire::roll_reported::Kind::Walked(
            wire::roll_reported::WalkEnded {},
        ));
    }

    /// The bytes the pass service asked the roll to offer again, with the vault.
    fn bytes_needed(&self) -> Option<(String, Vec<wire::NeededBytes>)> {
        self.roll
            .seen
            .lock()
            .unwrap()
            .iter()
            .find_map(|asked| match &asked.kind {
                Some(wire::imports_camera_roll_event::Kind::BytesNeeded(needed)) => {
                    Some((asked.vault_id.clone(), needed.needs.clone()))
                }
                _ => None,
            })
    }

    /// The roll offered those bytes and `landed` of them are staged.
    fn fed(&mut self, landed: u32) {
        self.report(wire::roll_reported::Kind::Fed(
            wire::roll_reported::BytesFed { landed },
        ));
    }

    /// Pick up the doors asked since last looked.
    fn pull(&mut self) {
        self.calls.extend(self.secrets.conductor().take_issued());
    }

    /// Whether a door is waiting for an answer.
    fn has_call(&mut self) -> bool {
        self.pull();
        !self.calls.is_empty()
    }

    /// The oldest door asked and not answered.
    fn front(&mut self) -> wire::request::Kind {
        self.pull();
        self.calls
            .front()
            .and_then(|(_, request)| request.kind.clone())
            .expect("a door was asked")
    }

    /// The `drain` the service asked for, without answering it.
    fn drain(&mut self) -> (wire::DrainRequest, String) {
        self.pull();
        let (tag, request) = self
            .calls
            .iter()
            .find(|(tag, _)| tag.starts_with("drain:"))
            .expect("a drain was asked");
        let Some(wire::request::Kind::Drain(drain)) = request.kind.clone() else {
            panic!("the call was {request:?}");
        };
        (drain, tag.trim_start_matches("drain:").to_owned())
    }

    /// Answer the oldest door asked, as the off-thread job would.
    fn answer_call(&mut self, response: Result<wire::Response, wire::Error>) {
        self.pull();
        let (tag, _) = self.calls.pop_front().expect("a door was asked");
        let called = match response {
            Ok(response) => wire::VaultCalled {
                response: response.encode_to_vec(),
                error: None,
            },
            Err(error) => wire::VaultCalled {
                response: Vec::new(),
                error: Some(error),
            },
        };
        self.driver.send(
            SERVICE,
            E::OffThreadDone(wire::OffThreadDone {
                tag,
                bytes: called.encode_to_vec(),
            }),
        );
    }

    fn answer_drain(&mut self, response: wire::DrainResponse) {
        self.answer_call(Ok(wire::Response {
            kind: Some(wire::response::Kind::Drain(response)),
        }));
    }

    /// Answer the windows the service asked for as an OS that took them all.
    fn take_windows(&mut self) {
        while self.has(is_schedule) {
            self.answer(
                is_schedule,
                wire::effect_result::Outcome::WindowsScheduled(wire::WindowsScheduled {
                    taken: vec![windows::PERIODIC.to_owned(), windows::NIGHT.to_owned()],
                    ..Default::default()
                }),
            );
        }
    }

    fn noted(&mut self) {
        while self.has(is_noted) {
            self.answer(
                is_noted,
                wire::effect_result::Outcome::PassNoted(wire::PassNoted {}),
            );
        }
    }

    fn fact(&mut self, fact: wire::shell_fact::Fact) {
        self.driver
            .call(wire::screen_request::Kind::ShellFact(wire::ShellFact {
                fact: Some(fact),
            }));
    }

    /// Run the launch's first pass to its end with `response`.
    fn first_pass(&mut self, response: wire::DrainResponse) {
        self.launch();
        self.take_windows();
        self.walk();
        self.answer_drain(response);
        self.take_windows();
    }

    fn last(&self, vault: &str) -> Option<Pass> {
        self.secrets.conductor().facts().last.get(vault).cloned()
    }
}

fn is_schedule(effect: &wire::Effect) -> bool {
    matches!(&effect.kind, Some(wire::effect::Kind::ScheduleWindows(_)))
}

fn is_noted(effect: &wire::Effect) -> bool {
    matches!(
        &effect.kind,
        Some(
            wire::effect::Kind::PassWindowDone(_)
                | wire::effect::Kind::LongRun(_)
                | wire::effect::Kind::Uploads(wire::UploadsOp {
                    op: Some(wire::uploads_op::Op::Enqueue(_) | wire::uploads_op::Op::CancelAll(_))
                })
        )
    )
}

fn window_done(effect: &wire::Effect) -> Option<(String, bool)> {
    match &effect.kind {
        Some(wire::effect::Kind::PassWindowDone(done)) => Some((done.window.clone(), done.drained)),
        _ => None,
    }
}

fn empty() -> wire::DrainResponse {
    wire::DrainResponse {
        stopped: wire::DrainStop::Empty as i32,
        acked_at_ms: Some(1_700_000_000_000),
        ..Default::default()
    }
}

fn long_runs(rig: &Rig) -> Vec<bool> {
    rig.driver
        .effects
        .iter()
        .filter_map(
            |request| match request.effect.as_ref().and_then(|e| e.kind.as_ref()) {
                Some(wire::effect::Kind::LongRun(run)) => Some(run.start),
                _ => None,
            },
        )
        .collect()
}

#[test]
fn nothing_runs_until_the_device_store_has_been_read() {
    let mut rig = Rig::new();
    rig.driver.start();
    // THE SERVICE ASKED FOR THE STORE AND NOTHING ELSE: a pass reads the
    // member's rule at its start.
    assert_eq!(rig.driver.effects.len(), 1);
    assert!(rig.has(|e| matches!(&e.kind, Some(wire::effect::Kind::Secrets(_)))));
    // A LIFECYCLE THAT ARRIVES MEANWHILE WAITS, and runs once the store is read.
    rig.driver
        .call(wire::screen_request::Kind::Lifecycle(wire::AppLifecycle {
            foreground: true,
        }));
    assert!(!rig.has_call() && !rig.walk_asked());
    rig.driver.serve(&mut rig.shell);
    assert!(rig.has(is_schedule) && rig.walk_asked());
}

#[test]
fn the_launch_asks_for_the_windows_walks_the_roll_and_then_passes() {
    let mut rig = Rig::new();
    rig.launch();
    // THE STANDING WINDOWS, under the default rule: Wi-Fi only.
    let scheduled = rig
        .driver
        .effects
        .iter()
        .find_map(
            |request| match request.effect.as_ref().and_then(|e| e.kind.as_ref()) {
                Some(wire::effect::Kind::ScheduleWindows(schedule)) => Some(schedule.clone()),
                _ => None,
            },
        )
        .expect("windows were asked for");
    let names: Vec<_> = scheduled.windows.iter().map(|w| w.name.as_str()).collect();
    assert_eq!(names, [windows::PERIODIC, windows::NIGHT]);
    assert_eq!(
        scheduled.windows[0].link,
        wire::WindowLink::Unmetered as i32
    );
    assert!(scheduled.windows[1].requires_charging);
    // THE ROLL IS WALKED FIRST; THE PASS WAITS FOR IT.
    assert!(rig.walk_asked());
    assert!(!rig.has_call());
    rig.walk();
    let (drain, vault) = rig.drain();
    assert_eq!(vault, "");
    // The launch's pass carries no deadline and asks for no snapshot.
    assert_eq!(drain.deadline_ms, 0);
    assert!(!drain.wants_snapshot && !drain.asked);
    // AN UNKNOWN LINK IS THE EXPENSIVE ONE.
    assert!(drain.metered && !drain.charging);
    assert_eq!(drain.rule, wire::TransferRule::WifiOnly as i32);
    assert!(!drain.exclude_videos);
}

#[test]
fn the_os_verdict_on_the_windows_is_a_fact_the_backup_screen_words() {
    let mut rig = Rig::new();
    rig.launch();
    assert_eq!(rig.secrets.conductor().facts().registration, None);
    rig.answer(
        is_schedule,
        wire::effect_result::Outcome::WindowsScheduled(wire::WindowsScheduled {
            taken: vec![windows::NIGHT.to_owned()],
            refused: vec![windows::PERIODIC.to_owned()],
            refusal: "refresh is off".to_owned(),
        }),
    );
    let registration = rig.secrets.conductor().facts().registration.expect("said");
    assert!(!registration.short && registration.long && registration.registered());
}

#[test]
fn the_members_rule_and_videos_setting_cross_with_the_pass() {
    let mut shell = FakeShell::default();
    shell.device.insert(
        "transfer-rule".to_owned(),
        "wifi-and-cellular-photos".to_owned(),
    );
    shell.device.insert(
        "transfer-rule.include-videos".to_owned(),
        "excluded".to_owned(),
    );
    let mut rig = Rig::with_shell(shell);
    rig.launch();
    rig.walk();
    let (drain, _) = rig.drain();
    assert_eq!(drain.rule, wire::TransferRule::WifiAndCellularPhotos as i32);
    assert!(drain.exclude_videos);
    // AND THE STANDING WINDOW FOLLOWS THE RULE: cellular may carry photographs.
    let scheduled = rig
        .driver
        .effects
        .iter()
        .find_map(
            |request| match request.effect.as_ref().and_then(|e| e.kind.as_ref()) {
                Some(wire::effect::Kind::ScheduleWindows(schedule)) => Some(schedule.clone()),
                _ => None,
            },
        )
        .expect("windows");
    assert_eq!(
        scheduled.windows[0].link,
        wire::WindowLink::Connected as i32
    );
}

#[test]
fn a_reported_link_replaces_the_expensive_guess() {
    let mut rig = Rig::new();
    rig.first_pass(empty());
    // OFFLINE REPORTS CARRY THE READING WITHOUT A PASS.
    rig.fact(wire::shell_fact::Fact::Link(wire::LinkChanged {
        online: false,
        metered: false,
        charging: true,
        metered_known: true,
        charging_known: true,
    }));
    assert!(!rig.has_call());
    rig.fact(wire::shell_fact::Fact::Asked(wire::PassAsked {
        ask: wire::pass_asked::Ask::BackUpNow as i32,
    }));
    rig.walk();
    let (drain, _) = rig.drain();
    assert!(!drain.metered && drain.charging);
    assert!(drain.wants_snapshot && drain.asked);
}

#[test]
fn a_link_that_came_up_is_a_pass() {
    let mut rig = Rig::new();
    rig.first_pass(empty());
    rig.fact(wire::shell_fact::Fact::Link(wire::LinkChanged {
        online: true,
        metered: false,
        charging: false,
        metered_known: true,
        charging_known: true,
    }));
    let (drain, _) = rig.drain();
    assert!(!drain.metered);
    assert!(!drain.wants_snapshot);
}

#[test]
fn every_stop_reason_is_what_the_core_said() {
    for (stop, expected) in [
        (wire::DrainStop::Empty, Stopped::Empty),
        (wire::DrainStop::Deadline, Stopped::Deadline),
        (wire::DrainStop::Unreachable, Stopped::Unreachable),
        (wire::DrainStop::Untrusted, Stopped::Untrusted),
        (wire::DrainStop::Refused, Stopped::Refused),
    ] {
        let mut rig = Rig::new();
        rig.first_pass(wire::DrainResponse {
            stopped: stop as i32,
            pending_bytes: 3_200_000,
            confirmed_parts: 5,
            ..Default::default()
        });
        let Some(Pass::Ran(answer)) = rig.last("") else {
            panic!("{stop:?} ran");
        };
        assert_eq!(answer.stopped, expected);
        assert_eq!(answer.pending_bytes, 3_200_000);
        assert_eq!(answer.confirmed_parts, 5);
        // THE NEXT WINDOW WAS ASKED FOR on every path (take_windows drained the
        // asks; the launch asked once and the pass once).
    }
}

#[test]
fn the_next_window_is_asked_for_after_every_pass() {
    let mut rig = Rig::new();
    rig.launch();
    rig.take_windows();
    rig.walk();
    assert!(!rig.has(is_schedule));
    rig.answer_drain(wire::DrainResponse {
        stopped: wire::DrainStop::Unreachable as i32,
        pending_bytes: 900,
        ..Default::default()
    });
    assert!(rig.has(is_schedule), "an unreachable gateway still asks");
}

#[test]
fn a_gateway_that_moved_the_vault_is_an_answer_dated_by_the_gateway() {
    let mut rig = Rig::new();
    rig.launch();
    rig.take_windows();
    rig.walk();
    rig.answer_call(Err(wire::Error {
        code: wire::ErrorCode::VaultMoved as i32,
        moved: Some(wire::VaultMoved {
            current_epoch: 2,
            moved_at_ms: 1_780_000_000_000,
        }),
        ..Default::default()
    }));
    let Some(Pass::Ran(answer)) = rig.last("") else {
        panic!("moved is an answer");
    };
    assert_eq!(answer.stopped, Stopped::Moved);
    assert_eq!(answer.moved_at_ms, Some(1_780_000_000_000));
    assert!(rig.secrets.conductor().facts().moved.contains(""));
}

#[test]
fn a_refusal_that_is_not_a_move_is_no_pass() {
    let mut rig = Rig::new();
    rig.launch();
    rig.take_windows();
    rig.walk();
    rig.answer_call(Err(wire::Error {
        code: wire::ErrorCode::InvalidRequest as i32,
        detail: "a drain is already running".to_owned(),
        ..Default::default()
    }));
    assert_eq!(rig.last(""), Some(Pass::Unavailable));
    assert!(rig.secrets.conductor().facts().moved.is_empty());
}

#[test]
fn bytes_only_the_library_holds_are_streamed_in_and_the_pass_runs_again() {
    let mut rig = Rig::new();
    rig.launch();
    rig.take_windows();
    rig.walk();
    let need = wire::NeedBytes {
        content_hash: vec![7; 32],
        os_ref: "L/1".to_owned(),
        media_type: "image/heic".to_owned(),
        size: 9,
    };
    rig.answer_drain(wire::DrainResponse {
        need_bytes: vec![need.clone()],
        ..empty()
    });
    // THE ROLL IS ASKED FOR THEM BY NAME, with the hash the way the stage door answers it.
    let (vault, needs) = rig.bytes_needed().expect("the roll is asked");
    assert_eq!(vault, "");
    assert_eq!(needs.len(), 1);
    assert_eq!((needs[0].os_ref.as_str(), needs[0].size), ("L/1", 9));
    assert_eq!(needs[0].content_hash.len(), 64);
    rig.fed(1);
    // THE SECOND ROUND TAKES NO SECOND SNAPSHOT.
    let (drain, _) = rig.drain();
    assert!(!drain.wants_snapshot);
    rig.answer_drain(empty());
    let Some(Pass::Ran(answer)) = rig.last("") else {
        panic!("ran");
    };
    assert!(answer.need_bytes.is_empty());
}

#[test]
fn a_library_that_lands_nothing_ends_the_pass_at_once() {
    let mut rig = Rig::new();
    rig.launch();
    rig.take_windows();
    rig.walk();
    rig.answer_drain(wire::DrainResponse {
        need_bytes: vec![wire::NeedBytes {
            content_hash: vec![8; 32],
            ..Default::default()
        }],
        ..empty()
    });
    assert!(rig.bytes_needed().is_some());
    rig.fed(0);
    assert!(!rig.has_call());
    assert!(!rig.secrets.conductor().facts().running);
}

#[test]
fn leaving_the_app_forces_a_snapshot_inside_the_grace_and_releases_it_when_done() {
    let mut rig = Rig::new();
    rig.first_pass(empty());
    rig.driver
        .call(wire::screen_request::Kind::Lifecycle(wire::AppLifecycle {
            foreground: false,
        }));
    // THE NIGHT'S WINDOWS ARE ASKED FOR ON EVERY BACKGROUND ENTRY.
    assert!(rig.has(is_schedule));
    let (drain, _) = rig.drain();
    assert!(drain.wants_snapshot);
    assert!(!drain.asked, "leaving is not the member asking");
    assert_eq!(drain.deadline_ms, 20_000);
    rig.answer_drain(empty());
    let done: Vec<_> = rig
        .driver
        .effects
        .iter()
        .filter_map(|request| request.effect.as_ref().and_then(window_done))
        .collect();
    assert_eq!(done, [(BACKGROUND_WINDOW.to_owned(), true)]);
}

#[test]
fn coming_back_is_a_pass_after_the_walk() {
    let mut rig = Rig::new();
    rig.first_pass(empty());
    rig.driver
        .call(wire::screen_request::Kind::Lifecycle(wire::AppLifecycle {
            foreground: true,
        }));
    assert!(rig.walk_asked());
    rig.walk();
    let (drain, _) = rig.drain();
    assert!(!drain.wants_snapshot);
}

#[test]
fn a_granted_window_runs_inside_its_budget_and_is_told_whether_the_spool_emptied() {
    let mut rig = Rig::new();
    rig.first_pass(empty());
    rig.fact(wire::shell_fact::Fact::Window(wire::WindowGranted {
        window: windows::NIGHT.to_owned(),
        deadline_ms: 540_000,
    }));
    // A WINDOW DOES NOT WALK THE ROLL: it has no time for one.
    assert!(!rig.walk_asked());
    let (drain, _) = rig.drain();
    assert_eq!(drain.deadline_ms, 540_000);
    rig.answer_drain(wire::DrainResponse {
        stopped: wire::DrainStop::Deadline as i32,
        pending_bytes: 10,
        ..Default::default()
    });
    let done: Vec<_> = rig
        .driver
        .effects
        .iter()
        .filter_map(|request| request.effect.as_ref().and_then(window_done))
        .collect();
    assert_eq!(done, [(windows::NIGHT.to_owned(), false)]);
}

#[test]
fn the_deadline_is_divided_over_the_vaults_the_shell_says_it_holds() {
    let mut rig = Rig::new();
    rig.first_pass(empty());
    rig.fact(wire::shell_fact::Fact::Held(wire::VaultsHeld {
        vaults: vec![
            wire::Held {
                vault_id: "aa".to_owned(),
                drainable: true,
            },
            wire::Held {
                vault_id: "resting".to_owned(),
                drainable: false,
            },
            wire::Held {
                vault_id: "bb".to_owned(),
                drainable: true,
            },
        ],
    }));
    rig.fact(wire::shell_fact::Fact::Window(wire::WindowGranted {
        window: windows::PERIODIC.to_owned(),
        deadline_ms: 60_000,
    }));
    let (first, vault) = rig.drain();
    assert_eq!((vault.as_str(), first.deadline_ms), ("aa", 30_000));
    rig.answer_drain(empty());
    let (second, vault) = rig.drain();
    assert_eq!((vault.as_str(), second.deadline_ms), ("bb", 30_000));
    rig.answer_drain(empty());
    assert!(rig.last("resting").is_none());
}

#[test]
fn back_up_now_from_another_screen_walks_asks_and_releases_the_long_run() {
    let mut rig = Rig::new();
    rig.first_pass(empty());
    // THE BACKUP SCREEN OPENS AND ASKS; the service hears it as a post.
    let probe = rig.driver.push("t", passes_probe_route());
    rig.redraw(probe);
    assert_eq!(rig.driver.view(probe).kind_title(), "backing up");
    assert!(rig.secrets.conductor().facts().backing_up);
    assert_eq!(long_runs(&rig), [true]);
    // THE NOTIFICATION'S WORDS ARE RUST'S: the shell writes none.
    let run = rig
        .driver
        .effects
        .iter()
        .find_map(
            |request| match request.effect.as_ref().and_then(|e| e.kind.as_ref()) {
                Some(wire::effect::Kind::LongRun(run)) if run.start => Some(run.clone()),
                _ => None,
            },
        )
        .expect("the long run starts");
    assert_eq!(
        (run.title.as_str(), run.channel_name.as_str()),
        ("Backing up", "Backup")
    );
    // THE ROLL FIRST, THEN THE ASKED PASS WITH A SNAPSHOT.
    assert!(rig.walk_asked());
    rig.walk();
    let (drain, _) = rig.drain();
    assert!(drain.asked && drain.wants_snapshot);
    rig.answer_drain(empty());
    // THE SCREEN DRAWS THE FACTS when it is next drawn, and the run ended.
    rig.redraw(probe);
    assert_eq!(rig.driver.view(probe).kind_title(), "idle");
    assert!(!rig.secrets.conductor().facts().backing_up);
    rig.noted();
    assert_eq!(long_runs(&rig), Vec::<bool>::new());
}

trait Title {
    fn kind_title(&self) -> String;
}

impl Title for wire::ViewState {
    fn kind_title(&self) -> String {
        match &self.kind {
            Some(wire::view_state::Kind::Counter(counter)) => counter.title.clone(),
            other => panic!("{other:?}"),
        }
    }
}

fn passes_probe_route() -> wire::Route {
    wire::Route {
        screen: PROBE.to_owned(),
        args: None,
    }
}

#[test]
fn a_commit_is_a_pass_and_a_burst_of_them_is_one_more_at_the_end_of_the_debounce() {
    let mut rig = Rig::new();
    rig.secrets
        .conductor()
        .set_debounce(Duration::from_millis(250));
    rig.first_pass(empty());
    let write = |rig: &mut Rig, n: u32| {
        let response = rig.driver.act(
            act::agenda::AddTask {
                title: format!("task {n}"),
                ..Default::default()
            }
            .request()
            .keyed(format!("pass-commit:{n}")),
        );
        assert_eq!(response.status, wire::ActStatus::Executed as i32);
    };
    write(&mut rig, 1);
    rig.driver.pump(Duration::from_millis(100));
    // THE FIRST COMMIT RUNS A PASS AT ONCE.
    let (first, _) = rig.drain();
    assert!(!first.wants_snapshot);
    rig.answer_drain(empty());
    rig.take_windows();
    // A BURST INSIDE THE WINDOW IS HELD BACK...
    write(&mut rig, 2);
    write(&mut rig, 3);
    rig.driver.pump(Duration::from_millis(50));
    assert!(!rig.has_call());
    // ...AND ONE PASS RUNS WHEN THE WINDOW ENDS.
    rig.driver.pump(Duration::from_millis(500));
    assert!(rig.has_call());
    rig.answer_drain(empty());
    assert!(!rig.has_call());
}

#[test]
fn a_rule_the_member_changed_is_asked_for_again_and_the_next_pass_carries_it() {
    let mut rig = Rig::new();
    rig.first_pass(empty());
    // The Backup screen wrote the rule to the device store and told the service.
    let ops = vec![passes::Rules::write_rule(passes::TransferRule::Manual)];
    rig.secrets.absorb(
        &ops,
        &rig.shell
            .batch(&wire::SecretBatch { ops: ops.clone() })
            .answers,
    );
    rig.fact(wire::shell_fact::Fact::Asked(wire::PassAsked {
        ask: wire::pass_asked::Ask::RuleChanged as i32,
    }));
    let scheduled = rig
        .driver
        .effects
        .iter()
        .find_map(
            |request| match request.effect.as_ref().and_then(|e| e.kind.as_ref()) {
                Some(wire::effect::Kind::ScheduleWindows(schedule)) => Some(schedule.clone()),
                _ => None,
            },
        )
        .expect("windows are asked for again");
    assert_eq!(
        scheduled.windows[0].link,
        wire::WindowLink::Unmetered as i32
    );
    // NO UPLOADS ARE CANCELLED OFF iOS.
    assert!(!rig.has(|e| matches!(&e.kind, Some(wire::effect::Kind::Uploads(_)))));
    rig.fact(wire::shell_fact::Fact::Asked(wire::PassAsked {
        ask: wire::pass_asked::Ask::RestoreFinished as i32,
    }));
    let (drain, _) = rig.drain();
    assert_eq!(drain.rule, wire::TransferRule::Manual as i32);
    assert!(drain.wants_snapshot && !drain.asked);
}

fn ios(rig: &mut Rig) {
    rig.driver
        .call(wire::screen_request::Kind::Environment(wire::Environment {
            locale: "en".to_owned(),
            zone: "UTC".to_owned(),
            platform: "ios".to_owned(),
            ..Default::default()
        }));
}

fn uploads_op(effect: &wire::Effect) -> Option<wire::uploads_op::Op> {
    match &effect.kind {
        Some(wire::effect::Kind::Uploads(op)) => op.op.clone(),
        _ => None,
    }
}

fn part(name: &str) -> wire::HandoffPart {
    wire::HandoffPart {
        name: name.to_owned(),
        url: format!("https://gw/v2/v/aa/o/{name}"),
        method: "PUT".to_owned(),
        vault_id: "aa".to_owned(),
        ..Default::default()
    }
}

fn request_of(rig: &mut Rig) -> wire::request::Kind {
    rig.front()
}

#[test]
fn on_ios_the_os_session_draining_hands_the_next_batch_off_in_the_contracts_order() {
    let mut rig = Rig::new();
    ios(&mut rig);
    rig.first_pass(empty());
    // The pass itself ended with a probe (every iOS pass does); answer it away.
    assert!(matches!(
        request_of(&mut rig),
        wire::request::Kind::Reconcile(_)
    ));
    rig.answer_call(Ok(wire::Response {
        kind: Some(wire::response::Kind::Reconcile(wire::ReconcileResponse {
            reachable: false,
            ..Default::default()
        })),
    }));
    // AN UNREACHABLE GATEWAY ENQUEUES NOTHING AND ASKS FOR THE NEXT WINDOW.
    assert!(rig.has(is_schedule));
    rig.take_windows();
    rig.fact(wire::shell_fact::Fact::Drained(wire::UploadsDrained {}));
    // RECONCILE, THEN THE OS'S COUNT, THEN HANDOFF, THEN ENQUEUE.
    assert!(matches!(
        request_of(&mut rig),
        wire::request::Kind::Reconcile(_)
    ));
    rig.answer_call(Ok(wire::Response {
        kind: Some(wire::response::Kind::Reconcile(wire::ReconcileResponse {
            reachable: true,
            ..Default::default()
        })),
    }));
    assert!(rig.has(|e| matches!(uploads_op(e), Some(wire::uploads_op::Op::Pending(_)))));
    rig.answer(
        |e| matches!(uploads_op(e), Some(wire::uploads_op::Op::Pending(_))),
        wire::effect_result::Outcome::UploadsState(wire::UploadsState { pending: 30 }),
    );
    let wire::request::Kind::Handoff(handoff) = request_of(&mut rig) else {
        panic!("a handoff");
    };
    // THE OS HOLDS 30 OF 32: ROOM FOR 2.
    assert_eq!(handoff.max_parts, 2);
    assert_eq!(handoff.max_bytes, 512 * 1024 * 1024);
    rig.answer_call(Ok(wire::Response {
        kind: Some(wire::response::Kind::Handoff(wire::HandoffResponse {
            parts: vec![part("a"), part("b")],
        })),
    }));
    let at = rig
        .position(|e| matches!(uploads_op(e), Some(wire::uploads_op::Op::Enqueue(_))))
        .expect("the parts go to the OS whole");
    let Some(wire::uploads_op::Op::Enqueue(enqueue)) =
        rig.driver.effects[at].effect.as_ref().and_then(uploads_op)
    else {
        unreachable!()
    };
    assert_eq!(enqueue.parts, vec![part("a"), part("b")]);
}

#[test]
fn on_ios_a_finished_task_settles_in_its_own_vault() {
    let mut rig = Rig::new();
    ios(&mut rig);
    rig.first_pass(empty());
    rig.fact(wire::shell_fact::Fact::Held(wire::VaultsHeld {
        vaults: vec![wire::Held {
            vault_id: "aa".to_owned(),
            drainable: true,
        }],
    }));
    // The pass's own probe is still waiting its turn; let it finish.
    rig.answer_call(Err(wire::Error::default()));
    rig.fact(wire::shell_fact::Fact::Settled(wire::UploadSettled {
        name: "a".to_owned(),
        http_status: 201,
        error: String::new(),
        gateway_id: "gw-1".to_owned(),
        vault_id: "aa".to_owned(),
    }));
    // A VAULT THIS PHONE NO LONGER HOLDS SETTLES NOWHERE.
    rig.fact(wire::shell_fact::Fact::Settled(wire::UploadSettled {
        name: "z".to_owned(),
        vault_id: "gone".to_owned(),
        ..Default::default()
    }));
    let wire::request::Kind::Settle(settle) = request_of(&mut rig) else {
        panic!("a settle");
    };
    assert_eq!(settle.settled.len(), 1);
    assert_eq!(settle.settled[0].name, "a");
    assert_eq!(settle.settled[0].vault_id, "aa");
}

#[test]
fn changing_the_rule_on_ios_lets_go_of_every_upload_the_os_holds() {
    let mut rig = Rig::new();
    ios(&mut rig);
    rig.first_pass(empty());
    rig.answer_call(Err(wire::Error::default()));
    rig.fact(wire::shell_fact::Fact::Asked(wire::PassAsked {
        ask: wire::pass_asked::Ask::RuleChanged as i32,
    }));
    assert!(rig.has(|e| matches!(uploads_op(e), Some(wire::uploads_op::Op::CancelAll(_)))));
}

#[test]
fn the_real_core_answers_the_launch_pass_without_a_gateway() {
    // NO GATEWAY IS PAIRED: the core answers its own `drain` off the runtime's
    // lock, whatever it says, and the conductor reads it from the pushed event
    // without a hand-built answer.
    let mut rig = Rig::new();
    rig.launch();
    rig.take_windows();
    rig.walk();
    assert!(rig.secrets.conductor().facts().running);
    rig.driver.pump(Duration::from_secs(10));
    assert!(rig.last("").is_some(), "the pass ended in an outcome");
    assert!(!rig.secrets.conductor().facts().running);
    // AND THE NEXT WINDOW WAS ASKED FOR on that path too.
    assert!(rig.has(is_schedule));
}

#[test]
fn a_repeated_lifecycle_is_not_a_transition() {
    let mut rig = Rig::new();
    rig.first_pass(empty());
    let lifecycle = |rig: &mut Rig, foreground| {
        rig.driver
            .call(wire::screen_request::Kind::Lifecycle(wire::AppLifecycle {
                foreground,
            }));
    };
    lifecycle(&mut rig, true);
    assert!(rig.walk_asked(), "the first foreground is a pass");
    rig.walk();
    rig.answer_drain(empty());
    rig.take_windows();
    // A SHELL THAT RE-REPORTS THE FOREGROUND buys no walk and no pass.
    lifecycle(&mut rig, true);
    assert!(!rig.walk_asked() && !rig.has_call());
}

#[test]
fn a_probe_the_core_cannot_answer_yet_is_no_answer_and_hands_nothing_off() {
    let mut rig = Rig::new();
    ios(&mut rig);
    rig.first_pass(empty());
    // NOT_YET_AVAILABLE IS NO ANSWER, never a fact: nothing is enqueued and no
    // window is asked for on its account.
    assert!(matches!(
        request_of(&mut rig),
        wire::request::Kind::Reconcile(_)
    ));
    rig.answer_call(Err(wire::Error {
        code: wire::ErrorCode::NotYetAvailable as i32,
        ..Default::default()
    }));
    assert!(!rig.has(is_schedule));
    assert!(!rig.has(|e| uploads_op(e).is_some()));
}

#[test]
fn a_finished_import_is_a_pass_and_asks_for_a_window_soon() {
    let mut rig = Rig::new();
    rig.first_pass(empty());
    rig.fact(wire::shell_fact::Fact::Asked(wire::PassAsked {
        ask: wire::pass_asked::Ask::ImportFinished as i32,
    }));
    let nudge = rig
        .driver
        .effects
        .iter()
        .find_map(
            |request| match request.effect.as_ref().and_then(|e| e.kind.as_ref()) {
                Some(wire::effect::Kind::ScheduleWindows(schedule)) => Some(schedule.clone()),
                _ => None,
            },
        )
        .expect("a window is asked for");
    assert_eq!(nudge.windows.len(), 1);
    assert_eq!(nudge.windows[0].name, windows::NUDGE);
    assert_eq!(nudge.windows[0].period_minutes, 0);
    // AND THE PASS RUNS NOW, without walking the roll again (an import's own pass would loop).
    assert!(!rig.walk_asked());
    let (drain, _) = rig.drain();
    assert!(!drain.wants_snapshot && !drain.asked);
}

/// The shelf's seam: two vaults, one resting. The open one runs on its own core.
struct Shelf {
    handle: centraid_core::Handle,
}

impl passes::Holdings for Shelf {
    fn held(&self) -> Vec<passes::Held> {
        vec![
            passes::Held {
                vault_id: "aa".to_owned(),
                drainable: true,
            },
            passes::Held {
                vault_id: "resting".to_owned(),
                drainable: false,
            },
        ]
    }

    fn core(&self, vault_id: &str) -> Option<centraid_core::Handle> {
        (vault_id == "aa").then(|| self.handle.clone())
    }
}

#[test]
fn a_vault_the_shelf_holds_a_core_for_is_passed_on_that_core_and_a_resting_one_is_skipped() {
    let mut rig = Rig::new();
    let shelf = Shelf {
        handle: rig.driver.handle.clone(),
    };
    rig.secrets
        .conductor()
        .use_holdings(std::sync::Arc::new(shelf));
    rig.launch();
    rig.take_windows();
    rig.walk();
    let (_, vault) = rig.drain();
    assert_eq!(vault, "aa");
    rig.driver.pump(Duration::from_secs(10));
    assert!(rig.last("aa").is_some(), "the held vault's pass ended");
    assert!(
        rig.last("resting").is_none(),
        "a resting vault is not woken"
    );
    assert!(rig.secrets.conductor().facts().in_flight.is_empty());
}
