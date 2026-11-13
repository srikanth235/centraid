//! THE NOTIFICATION SERVICE: reads the reminders the core holds, works out the
//! set the phone should hold ([`super::desired`]), and speaks only when it
//! changed. It also answers the buttons ([`super::answer`]) and holds the one
//! receipt of the last button for ten minutes. Its identity, guarded history
//! inverse and absolute deadline use the existing device secret store. A cold
//! receiver waits for the store and foreground vault before reconciling; an
//! accepted Undo is acknowledged there before its stable invocation runs.
//!
//! **Failure is not emptiness**: a read that failed keeps what the OS holds.
//! The one exception is a vault switch, which always speaks: the old vault's
//! notifications must not outlive it, so the new vault's set goes out, or an
//! empty one when its reads failed.

use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::time::Duration;

use centraid_api_proto::core_v1 as wire;
use centraid_vault::time::{FireZone, parse_civil_ms};
use wire::app_query_response::Answer;
use wire::screen_event::Kind as E;

use super::answer::{self, Facts, Handled, Receipt};
use super::desired::{self, Inputs};
use super::receipt::{self, Metadata};
use super::retention::Sources;
use crate::catalog::load;
use crate::kit::civil;
use crate::kit::read::{self, Reading};
use crate::screen::{Ctx, Screen};
use crate::strings::agenda_reminders as reminders;

/// The route name of the service.
pub const NAME: &str = "reminders.notify";

/// How many reminders one read looks at (the query's own ceiling).
const TASK_LIMIT: u32 = 500;
/// How long before a set that could not be read is tried again.
const RETRY: Duration = Duration::from_secs(10 * 60);

const REFRESH: &str = "refresh";
const RECEIPT_TIMER: &str = "receipt";

/// The route that opens the service.
#[must_use]
pub fn route() -> wire::Route {
    wire::Route {
        sheet: false,
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
    store_loaded: bool,
    stored: Option<Metadata>,
    store_work: Option<StoreWork>,
    clear_required: bool,
    queued: VecDeque<wire::NotificationAnswered>,
    delivered: BTreeMap<String, String>,
    cancelled: BTreeSet<String>,
    answer_inflight: Option<wire::NotificationAnswered>,
    completed_answers: Vec<wire::NotificationAnswered>,
}

enum StoreWork {
    Read,
    Save(Box<Receipt>),
    Clear,
}

fn midnight(day: &str) -> Option<String> {
    civil::epoch_day_of(day).map(|_| format!("{day}T00:00:00Z"))
}

impl Service {
    /// The reminders and the events of the window, or `None` when
    /// either did not land.
    fn read(ctx: &Ctx) -> Option<Loaded> {
        let Reading::Data(board) = read::read(
            ctx,
            load::reminders::Reminders { limit: TASK_LIMIT },
            |answer| match answer {
                Answer::AgendaTaskReminders(board) => Some(board),
                _ => None,
            },
        ) else {
            return None;
        };
        let to =
            civil::plus_days(&board.today, desired::WINDOW_DAYS + 1).and_then(|d| midnight(&d))?;
        let Reading::Data(upcoming) = read::read(
            ctx,
            load::calendar::Upcoming {
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
    fn speak(
        &mut self,
        vault: &str,
        loaded: Option<&Loaded>,
        ctx: &Ctx,
        out: &mut Vec<wire::Effect>,
        sources: &mut Sources,
    ) {
        let mut wait = RETRY;
        let reading = loaded.map(|loaded| {
            let set = desired::desired(&Inputs {
                vault_id: vault,
                zone: ctx.zone(),
                locale: ctx.locale(),
                hour_cycle: ctx.hour_cycle(),
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
        let clear_departed_vault = self.sync.vault.is_some() && self.sync.is_new_vault(vault);
        let next = self.sync.next(vault, reading);
        let cancellations = if clear_departed_vault {
            self.delivered.clear();
            self.cancelled.clear();
            BTreeSet::new()
        } else {
            ctx.now_ms().map_or_else(BTreeSet::new, |now| {
                sources.cancellations(ctx, vault, &self.delivered, self.receipt.as_ref(), now)
            })
        };
        let fresh_cancellations: Vec<String> =
            cancellations.difference(&self.cancelled).cloned().collect();
        let next = next.or_else(|| {
            (!fresh_cancellations.is_empty() || !self.completed_answers.is_empty())
                .then(|| self.sync.last.clone())
                .flatten()
        });
        if let Some(mut all) = next {
            let ask_permission = !all.is_empty();
            all.extend(self.receipt.iter().map(|held| held.notification.clone()));
            self.cancelled.extend(fresh_cancellations.iter().cloned());
            out.push(wire::Effect {
                kind: Some(wire::effect::Kind::ScheduleNotifications(
                    wire::ScheduleNotifications {
                        all,
                        categories: desired::categories(ctx.locale()),
                        ask_permission,
                        channel_name: reminders::band_reminders(ctx.locale()),
                        retain_delivered: !clear_departed_vault,
                        cancel_delivered_ids: fresh_cancellations,
                        completed_answers: std::mem::take(&mut self.completed_answers),
                    },
                )),
            });
        }
        ctx.start_timer(REFRESH, wait);
    }

    fn store(&mut self, work: StoreWork, out: &mut Vec<wire::Effect>) {
        let (work, op, value) = match work {
            StoreWork::Read => (StoreWork::Read, wire::secret_op::Op::Get, Vec::new()),
            StoreWork::Save(receipt) => match receipt.meta.encode() {
                Some(bytes) => (StoreWork::Save(receipt), wire::secret_op::Op::Set, bytes),
                None => {
                    self.receipt = None;
                    (StoreWork::Clear, wire::secret_op::Op::Delete, Vec::new())
                }
            },
            StoreWork::Clear => (StoreWork::Clear, wire::secret_op::Op::Delete, Vec::new()),
        };
        if matches!(work, StoreWork::Clear) {
            self.clear_required = true;
        }
        self.store_work = Some(work);
        out.push(receipt::effect(op, value));
    }

    fn complete_answer(&mut self) {
        if let Some(answered) = self.answer_inflight.take() {
            self.completed_answers.push(answered);
        }
    }

    fn stored_answer(
        &mut self,
        answer: wire::SecretBatched,
        ctx: &Ctx,
        out: &mut Vec<wire::Effect>,
    ) {
        let Some(work) = self.store_work.take() else {
            return;
        };
        let result = (answer.answers.len() == 1)
            .then(|| &answer.answers[0])
            .filter(|a| a.ok);
        match work {
            StoreWork::Read => {
                let Some(result) = result else {
                    ctx.start_timer(REFRESH, RETRY);
                    return;
                };
                self.store_loaded = true;
                self.stored = result
                    .found
                    .then(|| Metadata::decode(&result.value))
                    .flatten();
                if result.found && self.stored.is_none() {
                    self.store(StoreWork::Clear, out);
                    return;
                }
            }
            StoreWork::Save(receipt) => {
                if result.is_none() {
                    // A commit without an acknowledged durable receipt must never offer Undo.
                    // Delete a possibly partial write before any scheduling can advertise it.
                    self.receipt = None;
                    self.store(StoreWork::Clear, out);
                    return;
                }
                let undo_intent = receipt.meta.undo_requested_at.is_some();
                self.stored = Some(receipt.meta.clone());
                self.receipt = Some(*receipt);
                self.sync.invalidate();
                if !undo_intent {
                    self.complete_answer();
                }
            }
            StoreWork::Clear => {
                if result.is_none() {
                    ctx.start_timer(REFRESH, RETRY);
                    return;
                }
                self.clear_required = false;
                self.stored = None;
                self.receipt = None;
                self.sync.invalidate();
                ctx.cancel_timer(RECEIPT_TIMER);
                self.complete_answer();
            }
        }
        self.advance(ctx, out);
    }

    fn advance(&mut self, ctx: &Ctx, out: &mut Vec<wire::Effect>) {
        let foreground = match ctx.vaults() {
            Some(vaults) => vaults.foreground_id(),
            None => Some(String::new()),
        };
        // A KNOWN VAULT SWITCH OR REMOVAL CLEARS THE OLD SET even while storage is blocked.
        // Bootstrap has no previous vault: its first set still waits for the queued cold action.
        // Hosts without a shelf retain their existing empty-string namespace.
        let namespace = foreground.as_deref().unwrap_or_default();
        if self.sync.vault.as_ref().is_some_and(|old| old != namespace) {
            self.clear_required |= self.stored.is_some()
                || self.receipt.is_some()
                || matches!(self.store_work, Some(StoreWork::Save(_)));
            self.receipt = None;
            self.sync.invalidate();
            self.speak(namespace, None, ctx, out, &mut Sources::default());
        }
        if self.store_work.is_some() {
            return;
        }
        if !self.store_loaded {
            self.store(StoreWork::Read, out);
            return;
        }
        if self.clear_required {
            self.store(StoreWork::Clear, out);
            return;
        }
        // A cold receiver can arrive before the shelf has mounted its foreground vault.
        let Some(vault) = foreground else {
            return;
        };
        let Some(now) = ctx.now_ms() else {
            return;
        };
        if self
            .stored
            .as_ref()
            .is_some_and(|meta| !meta.live(&vault, now))
        {
            self.store(StoreWork::Clear, out);
            return;
        }
        let Some(loaded) = Self::read(ctx) else {
            ctx.start_timer(REFRESH, RETRY);
            return;
        };
        self.facts = Facts::of(
            &loaded.today,
            &loaded.now_local,
            &loaded.tasks,
            &loaded.events,
        );
        let mut sources = Sources::of(&loaded.tasks, &loaded.events);
        if self.receipt.is_none()
            && let Some(meta) = self.stored.clone()
        {
            match Receipt::restored(ctx, meta) {
                Ok(Some(receipt)) => self.receipt = Some(receipt),
                Ok(None) => {
                    self.store(StoreWork::Clear, out);
                    return;
                }
                Err(receipt::ReadFailed) => {
                    ctx.start_timer(REFRESH, RETRY);
                    return;
                }
            }
        }
        if self
            .receipt
            .as_ref()
            .is_some_and(|receipt| !receipt.meta.live(&vault, now))
        {
            self.receipt = None;
            self.sync.invalidate();
        }
        if let Some(receipt) = &self.receipt {
            if receipt.meta.undo_requested_at.is_some() {
                // This acknowledged gesture may have committed before the last process closed.
                // Its persisted invoke key makes retry a replay rather than a second inverse.
                if receipt.undo(ctx).is_err() {
                    // A failed history read is not permission to discard an accepted gesture.
                    ctx.start_timer(REFRESH, RETRY);
                    return;
                }
                self.store(StoreWork::Clear, out);
                return;
            }
            let remaining = u64::try_from(receipt.meta.expires - now).unwrap_or(0);
            ctx.start_timer(RECEIPT_TIMER, Duration::from_millis(remaining));
        }
        if let Some(answered) = self.queued.front() {
            if sources
                .augment_facts(ctx, &vault, &mut self.facts, answered)
                .is_err()
            {
                ctx.start_timer(REFRESH, RETRY);
                return;
            }
            if answer::replaces(&vault, &self.facts, answered) && self.stored.is_some() {
                self.store(StoreWork::Clear, out);
                return;
            }
            let answered = self
                .queued
                .pop_front()
                .expect("the queued answer is present");
            self.answer_inflight = Some(answered.clone());
            match answer::handle(ctx, &vault, &self.facts, self.receipt.as_ref(), &answered) {
                Handled::Committed(receipt) => {
                    self.receipt = None;
                    self.store(StoreWork::Save(receipt), out);
                    return;
                }
                Handled::Undo(receipt) => {
                    self.store(StoreWork::Save(receipt), out);
                    return;
                }
                Handled::Open(route) => {
                    out.push(wire::Effect {
                        kind: Some(wire::effect::Kind::OpenRoute(wire::OpenRoute {
                            route: Some(*route),
                        })),
                    });
                    self.complete_answer();
                }
                Handled::Ignored | Handled::Refused => self.complete_answer(),
            }
            self.sync.invalidate();
            if !self.queued.is_empty() {
                self.advance(ctx, out);
                return;
            }
        }
        self.speak(&vault, Some(&loaded), ctx, out, &mut sources);
    }

    fn enqueue(
        &mut self,
        answered: wire::NotificationAnswered,
        ctx: &Ctx,
        out: &mut Vec<wire::Effect>,
    ) {
        // One OS card is removed by its first button. Bound queued cold cards by the set's cap.
        if self.queued.len() < desired::CAP + desired::RECEIPTS
            && !self
                .queued
                .iter()
                .any(|queued| queued.notification_id == answered.notification_id)
        {
            self.queued.push_back(answered);
        }
        self.advance(ctx, out);
    }
}

impl Screen for Service {
    fn update(&mut self, event: wire::ScreenEvent, ctx: &Ctx) -> Vec<wire::Effect> {
        let mut out = Vec::new();
        match event.kind {
            Some(
                E::Appeared(_) | E::DataChanged(_) | E::EnvironmentChanged(_) | E::ScreenOpened(_),
            ) => {
                self.cancelled.clear();
                self.advance(ctx, &mut out);
            }
            Some(E::Lifecycle(wire::AppLifecycle { foreground: true })) => {
                // Settings can change a grant without changing a task. Reconcile the platform
                // again on return, including a first prompt that could not run in the background.
                self.sync.invalidate();
                self.cancelled.clear();
                self.advance(ctx, &mut out);
            }
            Some(E::ShellFact(fact)) => match fact.fact {
                Some(wire::shell_fact::Fact::NotificationAnswered(answered)) => {
                    self.enqueue(answered, ctx, &mut out);
                }
                Some(wire::shell_fact::Fact::Window(_) | wire::shell_fact::Fact::Held(_)) => {
                    self.advance(ctx, &mut out);
                }
                _ => {}
            },
            Some(E::TimerFired(fired)) => match fired.timer.as_str() {
                REFRESH => {
                    self.cancelled.clear();
                    self.advance(ctx, &mut out);
                }
                RECEIPT_TIMER => {
                    self.advance(ctx, &mut out);
                }
                _ => {}
            },
            Some(E::EffectResult(result)) => match result.outcome {
                Some(wire::effect_result::Outcome::NotificationsScheduled(scheduled)) => {
                    // DENIED IS QUIET: nothing else happens.
                    self.permission = Some(scheduled.permission);
                    let delivered: BTreeMap<String, String> = scheduled
                        .delivered
                        .into_iter()
                        .map(|held| (held.notification_id, held.source_fingerprint))
                        .collect();
                    if delivered != self.delivered {
                        self.delivered = delivered;
                        self.cancelled.retain(|id| self.delivered.contains_key(id));
                        // One changed actual inventory can require one explicit cancellation.
                        // Identical replies never drive another reconcile loop.
                        self.advance(ctx, &mut out);
                    }
                }
                Some(wire::effect_result::Outcome::Secrets(answer)) => {
                    self.stored_answer(answer, ctx, &mut out);
                }
                Some(wire::effect_result::Outcome::Failed(_)) if self.store_work.is_some() => {
                    self.stored_answer(wire::SecretBatched::default(), ctx, &mut out);
                }
                _ => {}
            },
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
