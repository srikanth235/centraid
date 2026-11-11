//! A transaction page whose links could not be read says so and draws no section (#1185): the
//! Driver supplies a real vault; only the `links` read is replaced.

use std::time::Duration;

use super::*;
use crate::money::routes;
use crate::testing::Driver;

struct Flaky<'a> {
    core: &'a centraid_core::Handle,
    fail_links: std::cell::Cell<bool>,
}

impl centraid_core::screens::ScreenCtx for Flaky<'_> {
    fn load(&self, request: &wire::LoadRequest) -> centraid_core::Result<wire::LoadResponse> {
        if self.fail_links.get() && request.app == "shell" && request.query == "links" {
            Err(centraid_core::CoreError::Unavailable {
                reason: "test read failure".into(),
            })
        } else {
            self.core.load(request)
        }
    }

    fn act(&self, request: &wire::ActRequest) -> centraid_core::Result<wire::ActResponse> {
        self.core.act(request)
    }

    fn push(&self, _update: wire::ScreenUpdate) {}
    fn wake_after(&self, _after: Duration) {}
}

fn state(screen: &dyn Screen, ctx: &Ctx) -> wire::MoneyTransactionState {
    let Some(wire::view_state::Kind::MoneyTransaction(state)) = screen.view(ctx).kind else {
        panic!("transaction state")
    };
    state
}

fn links_of(state: &wire::MoneyTransactionState) -> Option<wire::LinkSection> {
    let Some(wire::money_transaction_state::Content::Data(data)) = &state.content else {
        panic!("transaction data")
    };
    data.links.clone()
}

#[test]
fn links_that_could_not_be_read_are_said_not_drawn_as_none() {
    let mut driver = Driver::with_runtime(crate::money::runtime());
    driver.start();
    let home = driver.push(
        crate::money::TAB,
        routes::home(wire::MoneyDestination::Activity),
    );
    let Some(wire::view_state::Kind::MoneyHome(home)) = &driver.view(home).kind else {
        panic!("home")
    };
    let Some(wire::money_home_state::Content::Data(data)) = &home.content else {
        panic!("home data")
    };
    let id = data
        .activity
        .as_ref()
        .and_then(|activity| activity.sections.iter().flat_map(|s| &s.rows).next())
        .map(|row| row.txn_id.clone())
        .expect("a line in the seeded month");

    let core = Flaky {
        core: &driver.handle,
        fail_links: true.into(),
    };
    let env: &'static crate::screen::Environment =
        Box::leak(Box::new(crate::screen::Environment::default()));
    let ctx = Ctx::new(&core, env);
    let mut screen = build(&routes::transaction(&id, "Money")).expect("transaction page");
    screen.update(
        wire::ScreenEvent {
            kind: Some(E::Appeared(wire::Appeared {})),
        },
        &ctx,
    );
    let view = state(&*screen, &ctx);
    assert!(
        links_of(&view).is_none(),
        "no section for what was not read"
    );
    assert_eq!(
        view.status.expect("status").sentence,
        "Couldn’t read what this transaction is linked to."
    );

    // Read again, the section comes back and the line goes.
    core.fail_links.set(false);
    screen.update(
        wire::ScreenEvent {
            kind: Some(E::MoneyTransaction(wire::MoneyTransactionEvent {
                kind: Some(T::Refreshed(wire::money_transaction_event::Refreshed {})),
            })),
        },
        &ctx,
    );
    let view = state(&*screen, &ctx);
    assert!(
        links_of(&view)
            .expect("the section is back")
            .rows
            .is_empty()
    );
    assert!(view.status.is_none());
}
