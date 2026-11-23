//! What ends a Locker clipboard lease, seen through the volatile owner the runtime keeps.
//!
//! The owner is only visible from inside the crate (`Ctx::clipboard`), and `Lock` or a vault
//! switch send an owned clear whether or not the board still holds one, so the effects a screen
//! emits cannot tell a released owner from a kept one. These tests read the board itself.

use std::time::Duration;

use centraid_api_proto::core_v1 as wire;
use centraid_core::screens::ScreenCtx;
use wire::screen_event::Kind as E;

use super::secret::{ClipboardBoard, Secrets};
use crate::screen::{Ctx, Environment, Screen};
use crate::testing::Driver;
use crate::{Registry, Runtime};

const CLIP_TIMER: &str = "secret-clip";
const HOUR: Duration = Duration::from_secs(3_600);

struct NoCore;

impl ScreenCtx for NoCore {
    fn load(&self, _: &wire::LoadRequest) -> centraid_core::Result<wire::LoadResponse> {
        unreachable!("a clipboard lease reads no core")
    }
    fn act(&self, _: &wire::ActRequest) -> centraid_core::Result<wire::ActResponse> {
        unreachable!("a clipboard lease writes no core")
    }
    fn push(&self, _: wire::ScreenUpdate) {
        unreachable!("a clipboard lease pushes no view")
    }
    fn wake_after(&self, _: Duration) {}
}

fn owned(board: &ClipboardBoard) -> bool {
    board.deadline().is_some()
}

#[test]
fn a_timer_before_the_deadline_leaves_the_copy_owned_and_one_at_it_releases_it() {
    let (host, env, board) = (NoCore, Environment::default(), ClipboardBoard::default());
    let ctx = Ctx::new(&host, &env).with_clipboard(board.clone());
    let mut early = Secrets::default();
    early.copy(&ctx, "early", HOUR);
    assert!(owned(&board));
    early.fired(CLIP_TIMER, &ctx);
    assert!(
        owned(&board),
        "an early wake is not the original native expiry"
    );

    let mut due = Secrets::default();
    due.copy(&ctx, "due", Duration::ZERO);
    assert!(owned(&board));
    due.fired(CLIP_TIMER, &ctx);
    assert!(!owned(&board), "the owner is released at its deadline");
}

#[test]
fn a_screen_whose_ticket_was_replaced_cannot_release_the_newer_copy() {
    let (host, env, board) = (NoCore, Environment::default(), ClipboardBoard::default());
    let ctx = Ctx::new(&host, &env).with_clipboard(board.clone());
    let mut older = Secrets::default();
    let mut newer = Secrets::default();
    older.copy(&ctx, "older", Duration::ZERO);
    newer.copy(&ctx, "newer", Duration::ZERO);
    let (newest, _) = board.deadline().expect("the newer copy owns the board");

    older.fired(CLIP_TIMER, &ctx);
    assert_eq!(board.deadline().map(|(ticket, _)| ticket), Some(newest));
}

#[test]
fn leaving_a_screen_forgets_its_ticket_but_not_the_runtime_owned_copy() {
    let (host, env, board) = (NoCore, Environment::default(), ClipboardBoard::default());
    let ctx = Ctx::new(&host, &env).with_clipboard(board.clone());
    let mut gone = Secrets::default();
    gone.copy(&ctx, "left behind", Duration::ZERO);
    gone.conceal();
    assert!(owned(&board), "Back leaves the copy to its original expiry");

    // The screen's own timer finds no ticket, so even a due deadline is not its to release.
    assert!(gone.fired(CLIP_TIMER, &ctx).is_empty());
    assert!(owned(&board), "a dropped ticket releases nothing");
}

/// A screen that copies on a tap and draws whether the runtime's board still owns a copy.
struct Probe {
    secrets: Secrets,
    after: Duration,
}

impl Screen for Probe {
    fn update(&mut self, event: wire::ScreenEvent, ctx: &Ctx) -> Vec<wire::Effect> {
        match event.kind {
            Some(E::Counter(_)) => self.secrets.copy(ctx, "4111 1111 1111 1111", self.after),
            // The screen's own timer is deliberately not forwarded: only the runtime's
            // `locker-clipboard:<ticket>` timer may release the owner here.
            _ => Vec::new(),
        }
    }

    fn view(&self, ctx: &Ctx) -> wire::ViewState {
        wire::ViewState {
            kind: Some(wire::view_state::Kind::Counter(wire::CounterView {
                title: owned(ctx.clipboard()).to_string(),
                content: None,
                ..Default::default()
            })),
            ..wire::ViewState::default()
        }
    }
}

fn copied(after: Duration) -> (Driver, u64, wire::ScreenUpdate) {
    const PROBE: &str = "probe.lease";
    let route = wire::Route {
        sheet: false,
        screen: PROBE.to_owned(),
        args: Some(wire::route::Args::Counter(wire::CounterRoute {})),
    };
    let mut driver = Driver::with_runtime(Runtime::new(
        Registry::default().with(PROBE, move |_| {
            Some(Box::new(Probe {
                secrets: Secrets::default(),
                after,
            }) as Box<dyn Screen>)
        }),
        vec![("probe".to_owned(), route)],
    ));
    driver.start();
    let id = driver.navigation.as_ref().expect("navigation").tabs[0].entries[0].instance;
    let update = driver.send(
        id,
        E::Counter(wire::CounterEvent {
            kind: Some(wire::counter_event::Kind::CopyTapped(
                wire::CounterCopyTapped {},
            )),
        }),
    );
    (driver, id, update)
}

fn lease_held(driver: &Driver, id: u64) -> bool {
    let Some(wire::view_state::Kind::Counter(view)) = &driver.views[&id].kind else {
        panic!("the probe draws a counter");
    };
    view.title == "true"
}

#[test]
fn a_copy_the_shell_could_not_make_is_released() {
    let (mut driver, id, update) = copied(HOUR);
    assert!(lease_held(&driver, id), "a copy is owned until it settles");
    driver.send(
        id,
        E::EffectResult(wire::EffectResult {
            effect_id: update.effects[0].effect_id,
            outcome: Some(wire::effect_result::Outcome::Failed(wire::EffectFailed {
                reason: "no clipboard".to_owned(),
                denied: false,
                ..Default::default()
            })),
        }),
    );
    assert!(
        !lease_held(&driver, id),
        "nothing was copied, so nothing is owned"
    );
}

#[test]
fn a_copy_the_shell_made_stays_owned() {
    let (mut driver, id, update) = copied(HOUR);
    driver.send(
        id,
        E::EffectResult(wire::EffectResult {
            effect_id: update.effects[0].effect_id,
            outcome: Some(wire::effect_result::Outcome::Done(wire::EffectDone {})),
        }),
    );
    assert!(lease_held(&driver, id));
}

#[test]
fn the_runtimes_own_timer_releases_the_copy_at_its_deadline_and_not_before() {
    // Not due for an hour: the runtime's `locker-clipboard:<ticket>` timer never fires here.
    let (mut late, id, _) = copied(HOUR);
    late.pump(Duration::from_millis(100));
    assert!(lease_held(&late, id), "the copy is kept until its deadline");

    // Due at once: the timer fires on the runtime's own wake, with no screen event.
    let (mut due, id, _) = copied(Duration::ZERO);
    for _ in 0..50 {
        if !lease_held(&due, id) {
            break;
        }
        due.pump(Duration::from_millis(100));
    }
    assert!(
        !lease_held(&due, id),
        "the runtime released the owner at its deadline"
    );
}
