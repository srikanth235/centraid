//! THE HEALTH GLANCE SERVICE: the view-less screen that keeps the Health widget's snapshot current
//! and opens Health when the widget is tapped.
//!
//! It is a service (`Runtime::with_services`) because a widget must be right whether or not any
//! Health page is open, so it hears every commit. When it reads, when it emits and how a refused
//! write is retried are the glance ledger's (`kit::glance`), the same as Agenda's.
//!
//! **What it reads**: `health.today`, one bounded read. A read that fails, is refused, or has no
//! vault in front emits the `unavailable` document, once.
//!
//! **No rollover timer**: the document names the instant it goes stale (`refresh_after`, the next
//! day's start) and the widget shows "Not updated today" from then on, which is the truth until
//! the app next reads the store; a commit (a Health pass landing new days) rebuilds it at once.
//!
//! **What the platform asks**: `ShellFact.health_intent` is a widget tap. Whatever its key, it
//! opens Health's home on Summary: never an error and never a route the document did not name.

use centraid_api_proto::core_v1 as wire;
use wire::app_query_response::Answer;
use wire::screen_event::Kind as E;

use super::snapshot::{self, Inputs};
use crate::catalog::load;
use crate::health::routes;
use crate::kit::glance::{self, Ledger};
use crate::kit::read::{Reading, read};
use crate::screen::{Ctx, Screen};

/// The route name of the service.
pub const NAME: &str = "health.glance";

/// The route that opens the service.
#[must_use]
pub fn route() -> wire::Route {
    wire::Route {
        sheet: false,
        screen: NAME.to_owned(),
        args: None,
    }
}

/// The registry factory.
#[must_use]
pub fn build(_route: &wire::Route) -> Option<Box<dyn Screen>> {
    Some(Box::new(Service::default()))
}

#[derive(Default)]
struct Service {
    ledger: Ledger,
}

impl Screen for Service {
    fn update(&mut self, event: wire::ScreenEvent, ctx: &Ctx) -> Vec<wire::Effect> {
        if self.ledger.wants_read(&event, ctx) {
            return self.refresh(ctx);
        }
        match event.kind {
            Some(E::ShellFact(fact)) => match fact.fact {
                Some(wire::shell_fact::Fact::HealthIntent(_)) => self.open(),
                _ => Vec::new(),
            },
            Some(E::EffectResult(result)) => {
                self.ledger.answered(&result);
                Vec::new()
            }
            _ => Vec::new(),
        }
    }

    fn view(&self, _ctx: &Ctx) -> wire::ViewState {
        wire::ViewState::default()
    }
}

impl Service {
    fn refresh(&mut self, ctx: &Ctx) -> Vec<wire::Effect> {
        self.ledger.reading(ctx);
        let document = document(ctx);
        // The document names its own staleness; no timer runs.
        glance::arm(ctx, None);
        if !self.ledger.changed(&document) {
            return Vec::new();
        }
        vec![wire::Effect {
            kind: Some(wire::effect::Kind::HealthGlance(wire::HealthGlance {
                document,
                version: snapshot::VERSION,
                file: snapshot::FILE.to_owned(),
            })),
        }]
    }

    fn open(&mut self) -> Vec<wire::Effect> {
        self.ledger.asked_route();
        vec![wire::Effect {
            kind: Some(wire::effect::Kind::OpenRoute(wire::OpenRoute {
                route: Some(routes::home(wire::HealthDestination::Today)),
            })),
        }]
    }
}

/// The document for what the vault in front holds now.
fn document(ctx: &Ctx) -> Vec<u8> {
    let Reading::Data(today) = read(ctx, load::health::Today::default(), |answer| match answer {
        Answer::HealthToday(today) => Some(today),
        _ => None,
    }) else {
        return snapshot::unavailable(ctx.locale(), ctx.zone());
    };
    snapshot::build(&Inputs {
        locale: ctx.locale(),
        zone: ctx.zone(),
        units: ctx.units(),
        today: &today,
    })
}
