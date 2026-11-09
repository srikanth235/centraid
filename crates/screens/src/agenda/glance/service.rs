//! THE GLANCE SERVICE: the view-less screen that keeps the widgets' snapshot
//! current and answers what the platform asks of Agenda from outside the app.
//!
//! It is a service (`Runtime::with_services`) because a widget must be right
//! whether or not any Agenda page is open, so it hears every commit.
//!
//! **When it reads**: on start, on every commit (the backup ledger's own
//! pseudo-table aside), when the locale or zone changes, on a lifecycle change,
//! when the roster of held vaults moves, when a tab's roots open again (a vault
//! switch closes and reopens them, and the service is told of each opening),
//! and when its rollover timer fires. Reads are synchronous and bounded: the
//! day, two days of events, the open tasks' window and their true counts.
//!
//! **When it emits**: only when the bytes differ from the last it emitted, and
//! at most once per update. A refused effect forgets those bytes, so the next
//! change tries again. A read that fails, is refused, or has no vault in front
//! emits the `unavailable` document, once.
//!
//! **The rollover** is the runtime's timer (`Ctx::start_timer`), set from the
//! core's own answer: the span between its `now_local` and the document's
//! `refresh_after`, never a device clock.
//!
//! **What the platform asks**: `ShellFact.agenda_intent` `add` opens Agenda's
//! home on Reminders with the quick-add bar open, holding the title when there
//! is one. `open` is a widget tap: its key is one the last document offered
//! (the service keeps them with the routes they name), and it opens that event,
//! that task, Agenda's Day, Reminders, or Reminders with the quick-add bar open.
//! **A key it did not offer, or offered in an older document, opens Agenda's
//! home on its default place**: never an error and never a route the document
//! did not name, so nothing outside the app can push Agenda anywhere else.
//! Nothing is written by any of them until the member taps Add.

use std::collections::VecDeque;
use std::time::Duration;

use centraid_api_proto::core_v1 as wire;
use wire::app_query_response::Answer;
use wire::screen_event::Kind as E;

use super::snapshot::{self, Inputs};
use crate::agenda::routes;
use crate::catalog::load::calendar as query_cal;
use crate::catalog::load::reminders as query_rem;
use crate::kit::civil;
use crate::kit::read::{Reading, read};
use crate::screen::{Ctx, Screen};

/// The route name of the service.
pub const NAME: &str = "calendar.glance";

/// The timer that rebuilds the document when it goes stale.
const ROLLOVER: &str = "glance.rollover";
/// How many rows each due-ordered read asks for: the reminders draw six, and up
/// next draws what is timed today and tomorrow of twelve.
const DUE_ROWS: u32 = 6;
const AHEAD_ROWS: u32 = 12;
/// The rollover's floor and ceiling.
const MIN_ROLLOVER: Duration = Duration::from_secs(60);
const MAX_ROLLOVER: Duration = Duration::from_secs(24 * 60 * 60);

/// The pseudo-table the core announces when the backup ledger moved: it holds
/// nothing Agenda draws.
const LEDGER_TABLE: &str = "backup";

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

/// What an outstanding effect will be answered as; a shell answers in order.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Asked {
    Glance,
    Route,
}

#[derive(Default)]
struct Service {
    /// The bytes last emitted and not refused.
    last: Option<Vec<u8>>,
    outstanding: VecDeque<Asked>,
    /// The vault in front when the document was last built.
    front: Option<String>,
    /// The keys the last document offered, and what each opens.
    opens: snapshot::Opens,
}

impl Screen for Service {
    fn update(&mut self, event: wire::ScreenEvent, ctx: &Ctx) -> Vec<wire::Effect> {
        match event.kind {
            Some(
                E::Appeared(_) | E::EnvironmentChanged(_) | E::Lifecycle(_) | E::TimerFired(_),
            ) => self.refresh(ctx),
            Some(E::DataChanged(changed)) => {
                if changed.tables.iter().all(|table| table == LEDGER_TABLE) {
                    Vec::new()
                } else {
                    self.refresh(ctx)
                }
            }
            // A VAULT SWITCH reopens every tab's root, and the services are
            // told of each opening: the front vault is the thing to look at.
            Some(E::ScreenOpened(_)) => {
                if self.front == front_of(ctx) {
                    Vec::new()
                } else {
                    self.refresh(ctx)
                }
            }
            Some(E::ShellFact(fact)) => match fact.fact {
                Some(wire::shell_fact::Fact::AgendaIntent(intent)) => self.intent(intent),
                Some(wire::shell_fact::Fact::Held(_)) => self.refresh(ctx),
                _ => Vec::new(),
            },
            Some(E::EffectResult(result)) => {
                if self.outstanding.pop_front() == Some(Asked::Glance)
                    && matches!(
                        result.outcome,
                        Some(wire::effect_result::Outcome::Failed(_))
                    )
                {
                    // A REFUSED WRITE IS NOT THE LAST DOCUMENT: the next change
                    // sends it again.
                    self.last = None;
                }
                Vec::new()
            }
            _ => Vec::new(),
        }
    }

    fn view(&self, _ctx: &Ctx) -> wire::ViewState {
        wire::ViewState::default()
    }
}

fn front_of(ctx: &Ctx) -> Option<String> {
    ctx.vaults().and_then(|vaults| vaults.foreground_id())
}

impl Service {
    fn refresh(&mut self, ctx: &Ctx) -> Vec<wire::Effect> {
        self.front = front_of(ctx);
        let (document, opens) = document(ctx);
        self.opens = opens;
        self.arm(ctx, &document);
        if self.last.as_deref() == Some(document.as_slice()) {
            return Vec::new();
        }
        self.last = Some(document.clone());
        self.outstanding.push_back(Asked::Glance);
        vec![wire::Effect {
            kind: Some(wire::effect::Kind::AgendaGlance(wire::AgendaGlance {
                document,
                version: snapshot::VERSION,
            })),
        }]
    }

    /// Set the rollover for the span the core's clock puts before the document
    /// goes stale; a document that goes stale never (the unavailable one) has
    /// none.
    fn arm(&self, ctx: &Ctx, document: &[u8]) {
        let span = snapshot::refresh_after_of(document).and_then(|after| {
            let now = snapshot::now_local_of(document)?;
            snapshot::seconds_between(&now, &after)
        });
        match span {
            Some(seconds) => ctx.start_timer(
                ROLLOVER,
                Duration::from_secs(seconds).clamp(MIN_ROLLOVER, MAX_ROLLOVER),
            ),
            None => ctx.cancel_timer(ROLLOVER),
        }
    }

    fn intent(&mut self, intent: wire::AgendaIntent) -> Vec<wire::Effect> {
        let route = match intent.kind {
            Some(wire::agenda_intent::Kind::Add(add)) => routes::home_adding(add.title.trim()),
            Some(wire::agenda_intent::Kind::Open(open)) => self.route_for(&open.key),
            None => return Vec::new(),
        };
        self.outstanding.push_back(Asked::Route);
        vec![wire::Effect {
            kind: Some(wire::effect::Kind::OpenRoute(wire::OpenRoute {
                route: Some(route),
            })),
        }]
    }

    /// The page a tap's key opens: what the last document offered under it, else
    /// Agenda's home on its default place.
    fn route_for(&self, key: &str) -> wire::Route {
        use snapshot::Open;
        match self.opens.get(key) {
            Some(Open::Event {
                event_id,
                instance_key,
                original_start_local,
                day,
            }) => routes::event(event_id, instance_key, original_start_local.as_deref(), day),
            Some(Open::Task { task_id }) => routes::task(task_id),
            Some(Open::UpNext) => routes::home(wire::AgendaDestination::Day, ""),
            Some(Open::Reminders) => routes::home(wire::AgendaDestination::Todo, ""),
            Some(Open::Add) => routes::home_adding(""),
            None => routes::home(wire::AgendaDestination::Unspecified, ""),
        }
    }
}

fn pick_context(answer: Answer) -> Option<wire::AgendaDayContext> {
    match answer {
        Answer::AgendaDayContext(context) => Some(context),
        _ => None,
    }
}

/// The document for what the vault in front holds now.
fn document(ctx: &Ctx) -> (Vec<u8>, snapshot::Opens) {
    let unavailable = || snapshot::unavailable_with_opens(ctx.locale(), ctx.zone());
    let Reading::Data(context) = read(ctx, query_cal::DayContext::default(), pick_context) else {
        return unavailable();
    };
    // THE WINDOW IS PADDED A DAY EITHER SIDE, as `home/held.rs` explains: the
    // events take instants and the zone's offset is not a screen's to compute;
    // the snapshot keeps the days it draws.
    let (Some(before), Some(after)) = (
        civil::plus_days(&context.today, -1).map(|day| format!("{day}T00:00:00Z")),
        civil::plus_days(&context.today, 3).map(|day| format!("{day}T00:00:00Z")),
    ) else {
        return unavailable();
    };
    if context.now_local.is_empty() {
        return unavailable();
    }
    let Reading::Data(upcoming) = read(
        ctx,
        query_cal::Upcoming {
            from: Some(before),
            to: Some(after),
        },
        |answer| match answer {
            Answer::AgendaUpcoming(upcoming) => Some(upcoming),
            _ => None,
        },
    ) else {
        return unavailable();
    };
    // THE ROWS ARE THE EARLIEST DUE, read in due order over every open task (a
    // board's window is the newest, which a vault with more open work than the
    // window holds would not make the earliest): overdue then today for the
    // reminders, and the timed tasks of today and tomorrow for up next.
    let due_rows = |window: query_rem::DueRowsWindow, limit: u32| {
        read(
            ctx,
            query_rem::DueRows {
                limit,
                window: Some(window),
            },
            |answer| match answer {
                Answer::AgendaTaskDueRows(rows) => Some(rows),
                _ => None,
            },
        )
    };
    let Reading::Data(now_rows) = due_rows(query_rem::DueRowsWindow::Now, DUE_ROWS) else {
        return unavailable();
    };
    let Reading::Data(ahead_rows) = due_rows(query_rem::DueRowsWindow::TimedAhead, AHEAD_ROWS)
    else {
        return unavailable();
    };
    // A read for another day than the one the rest was read on (the clock crossed
    // midnight between the reads) is not a set of rows for this document.
    if now_rows.today_day != context.today || ahead_rows.today_day != context.today {
        return unavailable();
    }
    let mut tasks = now_rows.tasks;
    for task in ahead_rows.tasks {
        if !tasks.iter().any(|held| held.task_id == task.task_id) {
            tasks.push(task);
        }
    }
    // THE TRUE COUNTS are their own read: the board above is a window of the
    // newest open tasks, so counting it would undercount a vault with more
    // open work than the window holds. A count for another day than the one
    // the rest was read on (the clock crossed midnight between the reads) is
    // not a figure for this document.
    let Reading::Data(counts) = read(
        ctx,
        query_rem::SmartCounts::default(),
        |answer| match answer {
            Answer::AgendaTaskSmartCounts(counts) => Some(counts),
            _ => None,
        },
    ) else {
        return unavailable();
    };
    if counts.today_day != context.today {
        return unavailable();
    }
    snapshot::ready_with_opens(&Inputs {
        locale: ctx.locale(),
        zone: ctx.zone(),
        today: &context.today,
        now_local: &context.now_local,
        upcoming: &upcoming,
        tasks: &tasks,
        cycle: ctx.hour_cycle(),
        counts: &counts,
    })
}
