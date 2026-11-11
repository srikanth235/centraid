//! A workout page whose links could not be read says so and draws no section (#1185): the Driver
//! supplies a real vault; only the `links` read is replaced.

use std::time::Duration;

use super::*;
use crate::field::Keyed;
use crate::health::routes;
use crate::testing::Driver;
use wire::app_query_response::Answer;

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

fn state(screen: &dyn Screen, ctx: &Ctx) -> wire::HealthWorkoutState {
    let Some(wire::view_state::Kind::HealthWorkout(state)) = screen.view(ctx).kind else {
        panic!("workout state")
    };
    state
}

fn links_of(state: &wire::HealthWorkoutState) -> Option<wire::LinkSection> {
    let Some(wire::health_workout_state::Content::Data(data)) = &state.content else {
        panic!("workout data")
    };
    data.links.clone()
}

#[test]
fn links_that_could_not_be_read_are_said_not_drawn_as_none() {
    let driver = Driver::with_runtime(crate::health::runtime());
    let request: wire::ActRequest = act::health::FollowWorkouts {
        origin: serde_json::json!({
            "ref": "store:apple-health", "label": "Apple Health", "device_id": "phone-a"
        })
        .to_string(),
        records: serde_json::json!([{
            "external_id": "local:run",
            "device_id": "phone-a",
            "fields": {
                "kind": "run",
                "starts": "2026-11-08T06:40:00.000Z",
                "ends": "2026-11-08T07:11:00.000Z",
                "workout": {"moving_s": 1864, "distance_m": 5200}
            }
        }])
        .to_string(),
        ..Default::default()
    }
    .into();
    let made = driver.act(request.keyed("test:run"));
    assert_eq!(
        made.status,
        wire::ActStatus::Executed as i32,
        "{}",
        made.reason
    );
    let id = match driver
        .handle
        .load(
            &load::health::Workouts {
                limit: 5,
                ..Default::default()
            }
            .into(),
        )
        .expect("workouts")
        .answer
        .and_then(|response| response.answer)
    {
        Some(Answer::HealthWorkouts(found)) => found.workouts[0].activity_id.clone(),
        other => panic!("workouts answered {other:?}"),
    };

    let core = Flaky {
        core: &driver.handle,
        fail_links: true.into(),
    };
    let env: &'static crate::screen::Environment =
        Box::leak(Box::new(crate::screen::Environment::default()));
    let ctx = Ctx::new(&core, env);
    let mut screen = build(&routes::workout(&id, "Health")).expect("workout page");
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
        "Couldn’t read what this workout is linked to."
    );

    // Read again, the section comes back and the line goes.
    core.fail_links.set(false);
    screen.update(
        wire::ScreenEvent {
            kind: Some(E::HealthWorkout(wire::HealthWorkoutEvent {
                kind: Some(W::Refreshed(wire::health_workout_event::Refreshed {})),
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
