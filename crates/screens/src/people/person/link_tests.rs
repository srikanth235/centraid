//! A person page whose links could not be read says so and draws no section (#1185): the Driver
//! supplies a real vault; only the `links` read is replaced.

use std::time::Duration;

use super::*;
use crate::field::Keyed;
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

fn state(screen: &dyn Screen, ctx: &Ctx) -> wire::PeoplePersonState {
    let Some(wire::view_state::Kind::PeoplePerson(state)) = screen.view(ctx).kind else {
        panic!("person state")
    };
    *state
}

#[test]
fn links_that_could_not_be_read_are_said_not_drawn_as_none() {
    let driver = Driver::with_runtime(crate::people::runtime());
    let request: wire::ActRequest = act::people::AddPerson {
        title: "Ada Lovelace".to_owned(),
        ..Default::default()
    }
    .into();
    let created = driver.act(request.keyed("test:ada"));
    let output: serde_json::Value = serde_json::from_slice(&created.output).expect("output");
    let id = output["id"].as_str().expect("id").to_owned();

    let core = Flaky {
        core: &driver.handle,
        fail_links: true.into(),
    };
    let env: &'static crate::screen::Environment =
        Box::leak(Box::new(crate::screen::Environment::default()));
    let ctx = Ctx::new(&core, env);
    let mut screen = build(&routes::person(&id, "Ada Lovelace", false)).expect("person page");
    screen.update(
        wire::ScreenEvent {
            kind: Some(E::Appeared(wire::Appeared {})),
        },
        &ctx,
    );
    let view = state(&*screen, &ctx);
    let Some(wire::people_person_state::Content::Data(page)) = view.content else {
        panic!("person data")
    };
    assert!(page.links.is_none(), "no section for what was not read");
    assert_eq!(
        view.status.expect("status").sentence,
        "Couldn’t read what this person is linked to."
    );

    // Read again, the section comes back and the line goes.
    core.fail_links.set(false);
    screen.update(
        wire::ScreenEvent {
            kind: Some(E::PeoplePerson(wire::PeoplePersonEvent {
                kind: Some(P::Refreshed(wire::people_person_event::Refreshed {})),
            })),
        },
        &ctx,
    );
    let view = state(&*screen, &ctx);
    let Some(wire::people_person_state::Content::Data(page)) = view.content else {
        panic!("person data")
    };
    assert!(page.links.expect("the section is back").rows.is_empty());
    assert!(view.status.is_none());
}
