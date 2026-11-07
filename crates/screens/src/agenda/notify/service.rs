//! THE NOTIFICATION SERVICE: reads the reminders the core holds, works out the
//! set the phone should hold ([`super::desired`]), and speaks only when it
//! changed. It also answers the buttons ([`super::answer`]) and holds the one
//! receipt of the last button for ten minutes.
//!
//! **Failure is not emptiness**: a read that failed keeps what the OS holds.
//! The one exception is a vault switch, which always speaks: the old vault's
//! notifications must not outlive it, so the new vault's set goes out, or an
//! empty one when its reads failed.

use std::time::Duration;

use centraid_api_proto::core_v1 as wire;
use centraid_vault::time::{FireZone, parse_civil_ms};
use wire::app_query_response::Answer;
use wire::screen_event::Kind as E;

use super::answer::{self, Facts, Handled, Receipt};
use super::desired::{self, Inputs};
use crate::catalog::load;
use crate::kit::civil;
use crate::kit::read::{self, Reading};
use crate::screen::{Ctx, Screen};
use crate::strings::agenda_reminders as reminders;

/// The route name of the service.
pub const NAME: &str = "agenda.notify";

/// How many tasks one read looks at.
const TASK_LIMIT: u32 = 500;
/// How long a receipt is held.
const RECEIPT_FOR: Duration = Duration::from_secs(10 * 60);
/// How long before a set that could not be read is tried again.
const RETRY: Duration = Duration::from_secs(10 * 60);

const REFRESH: &str = "refresh";
const RECEIPT_TIMER: &str = "receipt";

/// The route that opens the service.
#[must_use]
pub fn route() -> wire::Route {
    wire::Route {
        screen: NAME.to_owned(),
        args: None,
    }
}

/// The routes of Agenda's services, for `Runtime::with_services`.
#[must_use]
pub fn services() -> Vec<wire::Route> {
    vec![route()]
}

/// The registry factory.
#[must_use]
pub fn build(_route: &wire::Route) -> Option<Box<dyn Screen>> {
    Some(Box::new(Service::default()))
}

/// WHEN TO SPEAK. `vault` is the vault the last set was for; `last` is the set
/// last spoken for it.
#[derive(Clone, Debug, Default)]
pub struct Sync {
    pub vault: Option<String>,
    pub last: Option<Vec<wire::PendingNotification>>,
}

impl Sync {
    /// Whether `vault` is not the one the last set was for.
    #[must_use]
    pub fn is_new_vault(&self, vault: &str) -> bool {
        self.vault.as_deref() != Some(vault)
    }

    /// Forget the last set, so the next one is spoken even when equal (a
    /// receipt was added or dropped).
    pub fn invalidate(&mut self) {
        self.last = None;
    }

    /// The set to speak, if any. `reading` is `None` when a read failed.
    pub fn next(
        &mut self,
        vault: &str,
        reading: Option<Vec<wire::PendingNotification>>,
    ) -> Option<Vec<wire::PendingNotification>> {
        if self.is_new_vault(vault) {
            // A VAULT SWITCH CLEARS THE OLD VAULT'S NOTIFICATIONS, even when the new one cannot be read.
            self.vault = Some(vault.to_owned());
            let set = reading.unwrap_or_default();
            self.last = Some(set.clone());
            return Some(set);
        }
        let set = reading?;
        if self.last.as_ref() == Some(&set) {
            return None;
        }
        self.last = Some(set.clone());
        Some(set)
    }
}

/// What the two reads came to.
struct Loaded {
    today: String,
    now_local: String,
    tasks: Vec<wire::AgendaTask>,
    projects: Vec<wire::AgendaTaskProject>,
    events: Vec<wire::AgendaEvent>,
    calendars: Vec<wire::AgendaCalendar>,
}

#[derive(Default)]
struct Service {
    sync: Sync,
    receipt: Option<Receipt>,
    permission: Option<i32>,
    facts: Facts,
}

fn midnight(day: &str) -> Option<String> {
    civil::epoch_day_of(day).map(|_| format!("{day}T00:00:00Z"))
}

impl Service {
    /// The board's reminders and the events of the window, or `None` when
    /// either did not land.
    fn read(ctx: &Ctx) -> Option<Loaded> {
        let Reading::Data(board) = read::read(
            ctx,
            load::agenda::Board {
                limit: TASK_LIMIT,
                view: Some(load::agenda::BoardView::Reminders),
                project_id: None,
            },
            |answer| match answer {
                Answer::AgendaTaskBoard(board) => Some(board),
                _ => None,
            },
        ) else {
            return None;
        };
        let to =
            civil::plus_days(&board.today, desired::WINDOW_DAYS + 1).and_then(|d| midnight(&d))?;
        let Reading::Data(upcoming) = read::read(
            ctx,
            load::agenda::Upcoming {
                from: None,
                to: Some(to),
            },
            |answer| match answer {
                Answer::AgendaUpcoming(upcoming) => Some(upcoming),
                _ => None,
            },
        ) else {
            return None;
        };
        Some(Loaded {
            today: board.today,
            now_local: board.now_local,
            tasks: desired::flatten(&board.groups),
            projects: board.projects,
            events: upcoming.events,
            calendars: upcoming.calendars,
        })
    }

    /// Read, work out the set, and speak it when it changed.
    fn recompute(&mut self, ctx: &Ctx, out: &mut Vec<wire::Effect>) {
        let vault = ctx
            .vaults()
            .and_then(|vaults| vaults.foreground_id())
            .unwrap_or_default();
        if self.sync.is_new_vault(&vault) {
            self.receipt = None;
        }
        let loaded = Self::read(ctx);
        let mut wait = RETRY;
        let reading = loaded.as_ref().map(|loaded| {
            let set = desired::desired(&Inputs {
                vault_id: &vault,
                zone: ctx.zone(),
                locale: ctx.locale(),
                now_local: &loaded.now_local,
                tasks: &loaded.tasks,
                projects: &loaded.projects,
                events: &loaded.events,
                calendars: &loaded.calendars,
            });
            if let Some(now) = FireZone::named(ctx.zone())
                .ok()
                .and_then(|zone| parse_civil_ms(&loaded.now_local, &zone))
            {
                wait = desired::refresh_after(&set, now);
            }
            set
        });
        if let Some(loaded) = &loaded {
            self.facts = Facts::of(
                &loaded.today,
                &loaded.now_local,
                &loaded.tasks,
                &loaded.events,
            );
        }
        if let Some(mut all) = self.sync.next(&vault, reading) {
            let ask_permission = !all.is_empty();
            all.extend(self.receipt.iter().map(|held| held.notification.clone()));
            out.push(wire::Effect {
                kind: Some(wire::effect::Kind::ScheduleNotifications(
                    wire::ScheduleNotifications {
                        all,
                        categories: desired::categories(ctx.locale()),
                        ask_permission,
                        channel_name: reminders::band_reminders(ctx.locale()),
                    },
                )),
            });
        }
        ctx.start_timer(REFRESH, wait);
    }

    fn answered(
        &mut self,
        answered: &wire::NotificationAnswered,
        ctx: &Ctx,
        out: &mut Vec<wire::Effect>,
    ) {
        let vault = ctx
            .vaults()
            .and_then(|vaults| vaults.foreground_id())
            .unwrap_or_default();
        // THE FACTS A BUTTON NEEDS ARE READ NOW: the app may have been launched for it.
        if let Some(loaded) = Self::read(ctx) {
            self.facts = Facts::of(
                &loaded.today,
                &loaded.now_local,
                &loaded.tasks,
                &loaded.events,
            );
        }
        match answer::handle(ctx, &vault, &self.facts, self.receipt.as_ref(), answered) {
            Handled::Ignored => return,
            Handled::Open(route) => {
                out.push(wire::Effect {
                    kind: Some(wire::effect::Kind::OpenRoute(wire::OpenRoute {
                        route: Some(*route),
                    })),
                });
                return;
            }
            Handled::Committed(held) => {
                ctx.start_timer(RECEIPT_TIMER, RECEIPT_FOR);
                self.receipt = Some(*held);
            }
            Handled::Undone => {
                ctx.cancel_timer(RECEIPT_TIMER);
                self.receipt = None;
            }
            Handled::Refused => {}
        }
        // THE RECEIPT (or its absence) RIDES IN THE NEXT SET, even when the set did not change.
        self.sync.invalidate();
        self.recompute(ctx, out);
    }
}

impl Screen for Service {
    fn update(&mut self, event: wire::ScreenEvent, ctx: &Ctx) -> Vec<wire::Effect> {
        let mut out = Vec::new();
        match event.kind {
            Some(
                E::Appeared(_)
                | E::DataChanged(_)
                | E::EnvironmentChanged(_)
                | E::ScreenOpened(_)
                | E::Lifecycle(wire::AppLifecycle { foreground: true }),
            ) => self.recompute(ctx, &mut out),
            Some(E::ShellFact(fact)) => match fact.fact {
                Some(wire::shell_fact::Fact::NotificationAnswered(answered)) => {
                    self.answered(&answered, ctx, &mut out);
                }
                Some(wire::shell_fact::Fact::Window(_) | wire::shell_fact::Fact::Held(_)) => {
                    self.recompute(ctx, &mut out);
                }
                _ => {}
            },
            Some(E::TimerFired(fired)) => match fired.timer.as_str() {
                REFRESH => self.recompute(ctx, &mut out),
                RECEIPT_TIMER => {
                    if self.receipt.take().is_some() {
                        self.sync.invalidate();
                        self.recompute(ctx, &mut out);
                    }
                }
                _ => {}
            },
            Some(E::EffectResult(result)) => {
                if let Some(wire::effect_result::Outcome::NotificationsScheduled(scheduled)) =
                    result.outcome
                {
                    // DENIED IS QUIET: nothing else happens.
                    self.permission = Some(scheduled.permission);
                }
            }
            _ => {}
        }
        out
    }

    fn view(&self, _ctx: &Ctx) -> wire::ViewState {
        wire::ViewState::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn set(ids: &[&str]) -> Vec<wire::PendingNotification> {
        ids.iter()
            .map(|id| wire::PendingNotification {
                notification_id: (*id).to_owned(),
                ..Default::default()
            })
            .collect()
    }

    #[test]
    fn the_first_set_is_spoken_even_when_empty() {
        let mut sync = Sync::default();
        assert_eq!(sync.next("a", Some(Vec::new())), Some(Vec::new()));
        assert_eq!(sync.next("a", Some(Vec::new())), None);
    }

    #[test]
    fn a_set_equal_to_the_last_is_not_spoken_again() {
        let mut sync = Sync::default();
        assert_eq!(sync.next("a", Some(set(&["x"]))), Some(set(&["x"])));
        assert_eq!(sync.next("a", Some(set(&["x"]))), None);
        assert_eq!(
            sync.next("a", Some(set(&["x", "y"]))),
            Some(set(&["x", "y"]))
        );
    }

    #[test]
    fn a_failed_read_in_the_same_vault_keeps_what_the_phone_holds() {
        let mut sync = Sync::default();
        sync.next("a", Some(set(&["x"])));
        assert_eq!(sync.next("a", None), None);
        // And the set after it is compared with the last one spoken, not with nothing.
        assert_eq!(sync.next("a", Some(set(&["x"]))), None);
    }

    #[test]
    fn a_vault_switch_clears_the_old_vaults_set_even_when_the_new_read_fails() {
        let mut sync = Sync::default();
        assert_eq!(sync.next("a", Some(set(&["x"]))), Some(set(&["x"])));
        assert_eq!(sync.next("b", None), Some(Vec::new()));
        // The new vault's own failure afterwards is quiet.
        assert_eq!(sync.next("b", None), None);
        assert_eq!(sync.next("a", Some(set(&["x"]))), Some(set(&["x"])));
    }

    #[test]
    fn a_vault_switch_speaks_the_new_vaults_set() {
        let mut sync = Sync::default();
        sync.next("a", Some(set(&["x"])));
        assert_eq!(sync.next("b", Some(set(&["x"]))), Some(set(&["x"])));
    }

    #[test]
    fn an_invalidated_set_is_spoken_again() {
        let mut sync = Sync::default();
        sync.next("a", Some(set(&["x"])));
        sync.invalidate();
        assert_eq!(sync.next("a", Some(set(&["x"]))), Some(set(&["x"])));
    }
}
