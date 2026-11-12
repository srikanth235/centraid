//! THE BACKUP ALERTS SERVICE (#1188, NB2): a view-less screen that keeps the stale-backup notices
//! offered to the one notification service ([`crate::kit::permission::AlertBoard::offer`]).
//!
//! It lives apart from the Backup screen on purpose. A backup goes stale when the app is not being
//! opened, so a notice offered only while Backup is on screen would fail exactly when it matters:
//! this service is started with the app and re-reads the ledger whenever the app wakes, the ledger
//! moves or a day goes by, and the notices are scheduled *ahead* ([`super::stale`]).
//!
//! **Failure is not emptiness**: a reading that failed leaves the last offer in place. An empty
//! offer is made only from a reading that succeeded and found nothing to warn of (nothing paired,
//! or every device current).

use std::time::Duration;

use centraid_api_proto::core_v1 as wire;
use wire::screen_event::Kind as E;

use super::reading;
use super::stale;
use crate::kit::permission::{Channel, ExtraNotice, Offer};
use crate::kit::read::Reading;
use crate::screen::{Ctx, Screen};

/// The route name of the service.
pub const NAME: &str = "backup.alerts";

/// The producer's name on the alert board.
pub const PRODUCER: &str = "backup";

/// How often the ledger is read with nothing else to wake the service.
const REFRESH: Duration = Duration::from_secs(6 * 60 * 60);
const REFRESH_TIMER: &str = "refresh";

/// The route that opens the service.
#[must_use]
pub fn route() -> wire::Route {
    wire::Route {
        sheet: false,
        screen: NAME.to_owned(),
        args: None,
    }
}

/// The services of Backup, for `Runtime::with_services`.
#[must_use]
pub fn services() -> Vec<wire::Route> {
    vec![route()]
}

/// The registry factory.
#[must_use]
pub fn build(_route: &wire::Route) -> Option<Box<dyn Screen>> {
    Some(Box::new(Service))
}

/// The offer a reading makes: the stale notices and the ids still wanted.
#[must_use]
pub fn offer_of(locale: crate::strings::Locale, zone: &str, standing: &reading::Standing) -> Offer {
    let (notices, wanted) = stale::producer(locale, zone, &standing.reading, standing.now_ms);
    Offer {
        notices: notices
            .into_iter()
            .map(|notice| ExtraNotice {
                id: notice.id,
                channel: Channel::Backup,
                fire_at_ms: notice.fire_at_ms,
                title: notice.title,
                body: notice.body,
                opens: notice.opens,
            })
            .collect(),
        wanted,
    }
}

struct Service;

impl Service {
    fn refresh(ctx: &Ctx) {
        if let Reading::Data(standing) = reading::load(ctx) {
            let offer = offer_of(ctx.locale(), ctx.zone(), &standing);
            ctx.alerts().offer(ctx, PRODUCER, offer);
        }
        ctx.start_timer(REFRESH_TIMER, REFRESH);
    }
}

impl Screen for Service {
    fn update(&mut self, event: wire::ScreenEvent, ctx: &Ctx) -> Vec<wire::Effect> {
        if matches!(
            event.kind,
            Some(
                E::Appeared(_)
                    | E::EnvironmentChanged(_)
                    | E::Lifecycle(_)
                    | E::TimerFired(_)
                    | E::DataChanged(_)
                    | E::ScreenOpened(_)
            )
        ) {
            Self::refresh(ctx);
        }
        Vec::new()
    }

    fn view(&self, _ctx: &Ctx) -> wire::ViewState {
        wire::ViewState::default()
    }
}
