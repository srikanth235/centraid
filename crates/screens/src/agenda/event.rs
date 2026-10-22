//! ONE EVENT ON THE PHONE (`agenda.event`, #1046, #1135): what it is, who is
//! coming, the member's reply, Edit, and Cancel.
//!
//! ## The occurrence is read by its key
//!
//! The read is `agenda.event` for the route's `event_id` and occurrence, so an
//! occurrence far from any window is found, and the answer names its calendar,
//! so nothing else is read. An answer with no event is [`wire::AgendaGone`]:
//! cancelled, moved or deleted since it was picked.
//!
//! ## Writes
//!
//! A write answers at once (the phone is the vault), so there is no "pending"
//! chip, no optimistic reply and no parked card: the screen submits, reads the
//! verdict and loads again. A refusal is the core's own sentence in
//! `status`, over the event as it still is.
//!
//! - **RSVP** is the vault owner's own attendee row (`is_you`, never the first
//!   guest). A reply is to the SERIES, and a series says so.
//! - **Cancel.** A one-off asks a [`wire::Confirm`] first; a series asks the
//!   scope sheet, which IS its confirm, with no scope pre-chosen: this
//!   occurrence and this and the ones after are `edit-occurrence` skips, the
//!   whole series is `cancel-event`. A committed cancellation ends the screen
//!   (`dismissed`).
//! - **Edit** is the editor on this occurrence: the `edit` action carries that
//!   route and the shell pushes it.

use centraid_api_proto::core_v1 as wire;
use wire::agenda_event_event::Kind as K;
use wire::agenda_event_state::Sheet;
use wire::app_query_response::Answer;
use wire::screen_event::Kind as E;

use super::routes;
use super::todo::rows::hue_role;
use crate::catalog::{act, load};
use crate::kit::act::{self as kit_act, Settled};
use crate::kit::civil;
use crate::kit::read::{self as kit_read, Reading};
use crate::screen::{Ctx, Screen};
use crate::strings::{Locale, agenda as words, agenda_event as event_words, fill};

pub const ACTION_EDIT: &str = "edit";
pub const ACTION_CANCEL: &str = "cancel";

pub const ACCEPTED: &str = "accepted";
pub const TENTATIVE: &str = "tentative";
pub const DECLINED: &str = "declined";
const ANSWERS: [&str; 3] = [ACCEPTED, TENTATIVE, DECLINED];
const NEEDS_ACTION: &str = "needs-action";
const MIDNIGHT: &str = "00:00";
/// The hue of an event on no calendar.
const NO_CALENDAR_HUE: &str = "cSlate";
const DAY: usize = 10;

/// The registry factory.
#[must_use]
pub fn build(route: &wire::Route) -> Option<Box<dyn Screen>> {
    let Some(wire::route::Args::AgendaEvent(args)) = &route.args else {
        return None;
    };
    let mut args = args.clone();
    if args.instance_key.is_empty() {
        args.instance_key.clone_from(&args.event_id);
    }
    Some(Box::new(EventPage {
        route: args,
        content: Content::Loading,
        sheet: Sheet::None,
        confirm: false,
        scope: None,
        status: None,
        dismissed: false,
    }))
}

enum Content {
    Loading,
    Failed,
    Denied(wire::AppQueryDenial),
    Data(Box<wire::AgendaEventDetail>),
}

struct EventPage {
    route: wire::AgendaEventRoute,
    content: Content,
    /// The scope sheet, while a series' cancel is asked.
    sheet: Sheet,
    /// The one-off's confirm, while it is asked.
    confirm: bool,
    /// The scope the sheet has picked.
    scope: Option<wire::AgendaScope>,
    status: Option<wire::StatusLine>,
    dismissed: bool,
}

impl EventPage {
    /// Read the occurrence. A failed re-read keeps the event on screen: only a
    /// first read that failed has nothing else to show.
    fn reload(&mut self, ctx: &Ctx) {
        let request = load::agenda::Event {
            event_id: self.route.event_id.clone(),
            instance_key: Some(self.route.instance_key.clone()).filter(|key| !key.is_empty()),
            original_start_local: self
                .route
                .original_start_local
                .clone()
                .filter(|key| !key.is_empty()),
        };
        let reading = kit_read::read(ctx, request, |answer| match answer {
            Answer::AgendaEvent(detail) => Some(detail),
            _ => None,
        });
        match reading {
            Reading::Data(detail) => self.content = Content::Data(detail),
            Reading::Denied(denial) => self.content = Content::Denied(denial),
            Reading::Failed => {
                if !matches!(self.content, Content::Data(_)) {
                    self.content = Content::Failed;
                }
            }
        }
    }

    /// The answered event, when it is the series this screen is on.
    fn event(&self) -> Option<&wire::AgendaEvent> {
        match &self.content {
            Content::Data(detail) => detail
                .event
                .as_ref()
                .filter(|event| event.event_id == self.route.event_id),
            _ => None,
        }
    }

    fn refused(&mut self, settled: &Settled) {
        self.status = Some(wire::StatusLine {
            sentence: settled.refusal.clone(),
            action_label: String::new(),
            refused: true,
        });
    }

    fn rsvp(&mut self, ctx: &Ctx, partstat: &str) {
        let Some(event) = self.event() else { return };
        let Some(you) = event.attendees.iter().find(|guest| guest.is_you) else {
            return;
        };
        if !ANSWERS.contains(&partstat) || you.partstat == partstat {
            return;
        }
        let (event_id, person_id) = (event.event_id.clone(), you.party_id.clone());
        let state = match partstat {
            ACCEPTED => act::agenda::RsvpState::Accepted,
            TENTATIVE => act::agenda::RsvpState::Tentative,
            _ => act::agenda::RsvpState::Declined,
        };
        let key = kit_act::key(&["rsvp", &event_id, &person_id, partstat], kit_act::fresh());
        let request = act::agenda::Rsvp {
            event_id,
            person_id,
            state,
        };
        self.status = None;
        let settled = kit_act::act(ctx, request, &key);
        if !settled.committed {
            self.refused(&settled);
        }
        self.reload(ctx);
    }

    fn ask_cancel(&mut self) {
        let Some(event) = self.event() else { return };
        if is_series_occurrence(event) {
            self.sheet = Sheet::CancelScope;
            self.scope = None;
            self.confirm = false;
        } else {
            self.confirm = true;
        }
    }

    fn confirmed(&mut self, ctx: &Ctx) {
        let Some(event) = self.event() else { return };
        let event_id = event.event_id.clone();
        let occurrence = event.original_start_local.clone();
        if self.confirm {
            self.confirm = false;
            self.cancel_event(ctx, &event_id);
            return;
        }
        if self.sheet != Sheet::CancelScope {
            return;
        }
        let Some(scope) = self.scope else { return };
        let Some(occurrence) = occurrence else { return };
        self.sheet = Sheet::None;
        self.scope = None;
        match scope {
            wire::AgendaScope::Series => self.cancel_event(ctx, &event_id),
            wire::AgendaScope::Occurrence | wire::AgendaScope::Future => {
                let (word, scope) = if scope == wire::AgendaScope::Future {
                    ("future", act::agenda::EditOccurrenceScope::Future)
                } else {
                    ("occurrence", act::agenda::EditOccurrenceScope::Occurrence)
                };
                let request = act::agenda::EditOccurrence {
                    action: act::agenda::EditOccurrenceAction::Skip,
                    event_id: event_id.clone(),
                    original_start: occurrence.clone(),
                    scope,
                    ..Default::default()
                };
                let key = kit_act::key(
                    &["edit-occurrence", &event_id, &occurrence, word, "skip"],
                    kit_act::fresh(),
                );
                self.committed_cancel(ctx, request, &key);
            }
            wire::AgendaScope::Unspecified => {}
        }
    }

    fn cancel_event(&mut self, ctx: &Ctx, event_id: &str) {
        let request = act::agenda::CancelEvent {
            event_id: event_id.to_owned(),
        };
        let key = kit_act::key(&["cancel-event", event_id], kit_act::fresh());
        self.committed_cancel(ctx, request, &key);
    }

    /// A cancellation: the event is off the calendar and the screen is done, or
    /// the vault's sentence stands over the event as it still is.
    fn committed_cancel(&mut self, ctx: &Ctx, request: impl Into<wire::ActRequest>, key: &str) {
        self.status = None;
        let settled = kit_act::act(ctx, request, key);
        if settled.committed {
            self.dismissed = true;
        } else {
            self.refused(&settled);
            self.reload(ctx);
        }
    }

    fn chrome(locale: Locale) -> wire::AgendaEventChrome {
        wire::AgendaEventChrome {
            title: words::event_title(locale),
            back: words::app_title(locale),
            loading: words::loading(locale),
            retry: words::retry(locale),
            scope_title: words::cancel_scope_title(locale),
            scope_body: words::cancel_scope_body(locale),
            scope_commit: words::cancel_event(locale),
            scope_keep: words::keep_it(locale),
            confirm_keep: words::keep_it(locale),
        }
    }
}

impl Screen for EventPage {
    fn update(&mut self, event: wire::ScreenEvent, ctx: &Ctx) -> Vec<wire::Effect> {
        if self.dismissed {
            return Vec::new();
        }
        match event.kind {
            Some(E::Appeared(_) | E::DataChanged(_) | E::EnvironmentChanged(_)) => self.reload(ctx),
            Some(E::AgendaEvent(event)) => match event.kind {
                Some(K::Refreshed(_)) => self.reload(ctx),
                Some(K::Rsvp(picked)) => self.rsvp(ctx, &picked.partstat),
                Some(K::Action(picked)) if picked.key == ACTION_CANCEL => self.ask_cancel(),
                // `edit` is the shell's push of the action's route.
                Some(K::Action(_)) | None => {}
                Some(K::Scope(picked)) => {
                    let scope = wire::AgendaScope::try_from(picked.scope)
                        .unwrap_or(wire::AgendaScope::Unspecified);
                    if self.sheet == Sheet::CancelScope && scope != wire::AgendaScope::Unspecified {
                        self.scope = Some(scope);
                    }
                }
                Some(K::SheetClosed(_)) => {
                    self.sheet = Sheet::None;
                    self.scope = None;
                }
                Some(K::Confirmed(_)) => self.confirmed(ctx),
                Some(K::ConfirmDismissed(_)) => self.confirm = false,
            },
            _ => {}
        }
        Vec::new()
    }

    fn view(&self, ctx: &Ctx) -> wire::ViewState {
        let locale = ctx.locale();
        let content = match &self.content {
            Content::Loading => {
                wire::agenda_event_state::Content::Loading(wire::Loading { first_load: true })
            }
            Content::Failed => {
                wire::agenda_event_state::Content::Failure(kit_read::failure(locale))
            }
            Content::Denied(denial) => {
                wire::agenda_event_state::Content::Denied(denied(locale, denial))
            }
            Content::Data(detail) => match self.event() {
                None => wire::agenda_event_state::Content::Gone(gone(locale)),
                Some(event) => wire::agenda_event_state::Content::Data(Box::new(
                    self.data(locale, event, detail),
                )),
            },
        };
        let series_sheet = self.sheet == Sheet::CancelScope;
        let state = wire::AgendaEventState {
            content: Some(content),
            sheet: self.sheet as i32,
            confirm: self.confirm.then(|| wire::Confirm {
                title: words::confirm_cancel_title(locale),
                body: words::confirm_cancel_body(locale),
                confirm_label: words::cancel_event(locale),
                destructive: true,
            }),
            cancel_scopes: if series_sheet {
                scopes(locale, self.scope)
            } else {
                Vec::new()
            },
            chrome: Some(Self::chrome(locale)),
            dismissed: self.dismissed,
            cancel_armed: series_sheet && self.scope.is_some(),
            status: self.status.clone(),
        };
        wire::ViewState {
            kind: Some(wire::view_state::Kind::AgendaEvent(state)),
            ..wire::ViewState::default()
        }
    }
}

impl EventPage {
    fn data(
        &self,
        locale: Locale,
        event: &wire::AgendaEvent,
        detail: &wire::AgendaEventDetail,
    ) -> wire::AgendaEventData {
        let title = event
            .summary
            .as_deref()
            .filter(|summary| !summary.trim().is_empty())
            .map_or_else(|| words::untitled(locale), str::to_owned);
        let calendar = detail
            .calendar
            .as_ref()
            .filter(|calendar| Some(&calendar.calendar_id) == event.calendar_id.as_ref());
        let calendar_name = match &event.calendar_id {
            None => words::no_calendar(locale),
            Some(_) => calendar
                .and_then(|calendar| calendar.name.as_deref())
                .filter(|name| !name.trim().is_empty())
                .map_or_else(|| words::calendar_unnamed(locale), str::to_owned),
        };
        let date = date_label(locale, event);
        let (when, spoken) = when_of(locale, event);
        let reminder = event
            .reminders
            .first()
            .map(|reminder| reminder_label(locale, reminder.minutes_before));
        let place = event
            .location_name
            .as_deref()
            .map(str::trim)
            .filter(|place| !place.is_empty());
        let call_uri = event
            .conferencing_uri
            .as_deref()
            .map(str::trim)
            .unwrap_or_default()
            .to_owned();
        let series = event.recurrence_summary.is_some();
        let fact = |label: String, detail: &str| wire::AgendaFact {
            label,
            detail: detail.to_owned(),
        };
        let mut facts = Vec::new();
        if let Some(rule) = event
            .recurrence_summary
            .as_deref()
            .filter(|rule| !rule.trim().is_empty())
        {
            facts.push(fact(words::field_repeat(locale), rule));
        }
        if let Some(place) = place {
            facts.push(fact(words::field_place(locale), place));
        }
        if !call_uri.is_empty() {
            facts.push(fact(words::field_where(locale), &call_uri));
        }
        if let Some(reminder) = &reminder {
            facts.push(fact(words::field_reminder(locale), reminder));
        }
        facts.push(fact(words::field_calendar(locale), &calendar_name));

        let guests: Vec<wire::AgendaGuestRow> = event
            .attendees
            .iter()
            .map(|attendee| {
                let reply = reply_label(locale, &attendee.partstat);
                let name = if attendee.name.trim().is_empty() {
                    words::calendar_unnamed(locale)
                } else {
                    attendee.name.clone()
                };
                let shown = if attendee.is_you {
                    fill(&event_words::guest_name_you(locale), &[("name", &name)])
                } else {
                    name.clone()
                };
                wire::AgendaGuestRow {
                    party_id: attendee.party_id.clone(),
                    initial: name
                        .chars()
                        .find(|c| c.is_alphanumeric())
                        .map(|c| c.to_uppercase().collect::<String>())
                        .unwrap_or_default(),
                    reply_label: reply.clone(),
                    hue_key: person_hue(&attendee.party_id),
                    is_you: attendee.is_you,
                    accessibility_label: fill(
                        &event_words::guest_spoken(locale),
                        &[("name", &shown), ("reply", &reply)],
                    ),
                    name: shown,
                }
            })
            .collect();
        let awaiting = event
            .attendees
            .iter()
            .filter(|guest| guest.partstat.is_empty() || guest.partstat == NEEDS_ACTION)
            .count();
        let guest_heading = if event.attendees.is_empty() {
            String::new()
        } else {
            let head = event_words::guest_count(locale, event.attendees.len() as u64);
            if awaiting == 0 {
                head
            } else {
                fill(
                    &event_words::guest_awaiting_suffix(locale),
                    &[("heading", &head), ("awaiting", &awaiting.to_string())],
                )
            }
        };
        let rsvp = event
            .attendees
            .iter()
            .find(|guest| guest.is_you)
            .map(|you| wire::AgendaRsvp {
                question: words::rsvp_question(locale),
                choices: ANSWERS
                    .iter()
                    .map(|partstat| wire::AgendaRsvpChoice {
                        partstat: (*partstat).to_owned(),
                        label: reply_label(locale, partstat),
                        selected: you.partstat == *partstat,
                        enabled: true,
                    })
                    .collect(),
                note: if series {
                    words::rsvp_series_note(locale)
                } else {
                    String::new()
                },
            });
        let mut spoken_parts = vec![title.clone(), date.clone(), spoken];
        spoken_parts.extend(place.map(str::to_owned));
        if series {
            spoken_parts.push(words::meta_repeats(locale));
        }
        wire::AgendaEventData {
            title,
            date_label: date,
            when_label: when,
            calendar_name,
            calendar_hue_key: calendar_hue(event.calendar_id.as_deref(), calendar),
            facts,
            notes: event
                .description
                .as_deref()
                .map(str::trim)
                .unwrap_or_default()
                .to_owned(),
            guest_heading,
            guests,
            rsvp,
            actions: vec![
                wire::AgendaAction {
                    key: ACTION_EDIT.to_owned(),
                    label: words::action_edit(locale),
                    enabled: true,
                    destructive: false,
                    accessibility_label: words::a11y_edit(locale),
                    route: Some(routes::editor(
                        &event.event_id,
                        &self.route.instance_key,
                        self.route.original_start_local.as_deref(),
                        &self.route.day,
                        wire::AgendaEditorKind::Event,
                    )),
                },
                wire::AgendaAction {
                    key: ACTION_CANCEL.to_owned(),
                    label: if is_series_occurrence(event) {
                        words::cancel_series(locale)
                    } else {
                        words::cancel_event(locale)
                    },
                    enabled: true,
                    destructive: true,
                    accessibility_label: words::a11y_cancel(locale),
                    route: None,
                },
            ],
            is_past: ended(event, &detail.today, &detail.now_local),
            accessibility_label: spoken_parts.join(", "),
            call_label: if call_uri.is_empty() {
                String::new()
            } else {
                words::join_call(locale)
            },
            call_uri,
        }
    }
}

/// The gate a refused read draws.
fn denied(locale: Locale, denial: &wire::AppQueryDenial) -> wire::Denied {
    wire::Denied {
        title: words::denied_title(locale),
        body: words::denied_body(locale),
        receipt: denial.code.clone().unwrap_or_default(),
    }
}

fn gone(locale: Locale) -> wire::AgendaGone {
    wire::AgendaGone {
        title: words::gone_title(locale),
        body: words::gone_body(locale),
        action_label: words::gone_action(locale),
    }
}

/// An occurrence of a repeating event: the one a scope question makes sense for.
#[must_use]
pub fn is_series_occurrence(event: &wire::AgendaEvent) -> bool {
    event.recurrence_summary.is_some()
        && event
            .original_start_local
            .as_deref()
            .is_some_and(|key| !key.is_empty())
}

/// The three scope rows, none filled until picked.
#[must_use]
pub fn scopes(locale: Locale, picked: Option<wire::AgendaScope>) -> Vec<wire::AgendaScopeChoice> {
    [
        (
            wire::AgendaScope::Occurrence,
            words::scope_occurrence(locale),
        ),
        (wire::AgendaScope::Future, words::scope_future(locale)),
        (wire::AgendaScope::Series, words::scope_series(locale)),
    ]
    .into_iter()
    .map(|(scope, label)| wire::AgendaScopeChoice {
        scope: scope as i32,
        label,
        selected: picked == Some(scope),
        enabled: true,
        note: String::new(),
    })
    .collect()
}

/// `edit-occurrence`'s word for a scope.
#[must_use]
pub fn scope_word(scope: wire::AgendaScope) -> &'static str {
    match scope {
        wire::AgendaScope::Occurrence => "occurrence",
        wire::AgendaScope::Future => "future",
        _ => "series",
    }
}

/// `Wednesday 11 March`, or the input when it is not a day.
#[must_use]
pub fn long_day(locale: Locale, day: &str) -> String {
    let weekday = match civil::iso_weekday_of(day) {
        Some(1) => words::weekday_full_mon(locale),
        Some(2) => words::weekday_full_tue(locale),
        Some(3) => words::weekday_full_wed(locale),
        Some(4) => words::weekday_full_thu(locale),
        Some(5) => words::weekday_full_fri(locale),
        Some(6) => words::weekday_full_sat(locale),
        Some(7) => words::weekday_full_sun(locale),
        _ => return day.to_owned(),
    };
    let Some(dom) = civil::day_of_month_of(day) else {
        return day.to_owned();
    };
    fill(
        &event_words::day_long(locale),
        &[
            ("weekday", &weekday),
            ("day", &dom.to_string()),
            ("month", &civil::month_of(locale, day)),
        ],
    )
}

/// "Wednesday 11 March", or a range when the occurrence spans days.
fn date_label(locale: Locale, event: &wire::AgendaEvent) -> String {
    let Some(start) = event.local_start.get(..DAY) else {
        return String::new();
    };
    let end = last_day(event);
    if end.as_str() > start {
        fill(
            &event_words::date_range(locale),
            &[
                ("from", &long_day(locale, start)),
                ("to", &long_day(locale, &end)),
            ],
        )
    } else {
        long_day(locale, start)
    }
}

/// The last civil day an occurrence is on: a timed end at midnight is the day before.
fn last_day(event: &wire::AgendaEvent) -> String {
    let start = event.local_start.get(..DAY).unwrap_or_default();
    let Some(end) = event.local_end.get(..DAY) else {
        return start.to_owned();
    };
    if event.all_day {
        return end.to_owned();
    }
    if civil::clock(&event.local_end) == MIDNIGHT {
        civil::plus_days(end, -1).unwrap_or_else(|| end.to_owned())
    } else {
        end.to_owned()
    }
}

/// "08:15 – 09:45" and "08:15 to 09:45"; "All day".
fn when_of(locale: Locale, event: &wire::AgendaEvent) -> (String, String) {
    if event.all_day {
        return (words::all_day(locale), words::all_day(locale));
    }
    let from = civil::clock(&event.local_start);
    let to = civil::clock(&event.local_end);
    if to.is_empty() || event.local_end == event.local_start {
        (from.clone(), from)
    } else {
        (
            civil::span(locale, &event.local_start, &event.local_end, false),
            fill(
                &event_words::spoken_range(locale),
                &[("from", &from), ("to", &to)],
            ),
        )
    }
}

fn ended(event: &wire::AgendaEvent, today: &str, now: &str) -> bool {
    if event.all_day {
        let last = if event.local_end.is_empty() {
            &event.local_start
        } else {
            &event.local_end
        };
        last.get(..DAY).unwrap_or_default() < today
    } else if event.local_end.is_empty() {
        event.local_start.as_str() < now
    } else {
        event.local_end.as_str() <= now
    }
}

/// "30 minutes before": the leads the editor offers are named, the rest counted.
#[must_use]
pub fn reminder_label(locale: Locale, minutes: i64) -> String {
    match minutes {
        0 => words::reminder_at_start(locale),
        60 => words::reminder_hour(locale),
        1440 => words::reminder_day(locale),
        _ => {
            event_words::reminder_minutes_before(locale, u64::try_from(minutes).unwrap_or_default())
        }
    }
}

/// A reply, in words. A partstat this screen does not know is unanswered.
#[must_use]
pub fn reply_label(locale: Locale, partstat: &str) -> String {
    match partstat {
        ACCEPTED => words::rsvp_yes(locale),
        TENTATIVE => words::rsvp_maybe(locale),
        DECLINED => words::rsvp_no(locale),
        _ => words::rsvp_awaiting(locale),
    }
}

/// A person's own hue on a guest row, as a colour role.
#[must_use]
pub fn person_hue(party_id: &str) -> String {
    hue_role(centraid_design::identity_hue_key(party_id))
}

/// A calendar's hue as a colour role: the stored hue when it is a wheel hue,
/// else the id's own; an event on no calendar has the neutral one.
#[must_use]
pub fn calendar_hue(calendar_id: Option<&str>, calendar: Option<&wire::AgendaCalendar>) -> String {
    let Some(id) = calendar_id else {
        return NO_CALENDAR_HUE.to_owned();
    };
    let key =
        centraid_design::party_hue_key(id, calendar.and_then(|calendar| calendar.color.as_deref()))
            .unwrap_or_else(|| centraid_design::identity_hue_key(id));
    hue_role(key)
}

#[cfg(test)]
mod tests {
    //! The gate: a vault that will not let Agenda read is a state to draw, not an
    //! error. No example vault revokes a grant, so the door is a stub that refuses.

    use std::time::Duration;

    use centraid_core::Result;
    use centraid_core::screens::{ScreenCtx, ScreenHost};

    use super::*;
    use crate::{Registry, Runtime};

    struct Refusing;

    impl ScreenCtx for Refusing {
        fn load(&self, _request: &wire::LoadRequest) -> Result<wire::LoadResponse> {
            Ok(wire::LoadResponse {
                answer: Some(wire::AppQueryResponse {
                    answer: Some(Answer::Denied(wire::AppQueryDenial {
                        code: Some("consent.revoked".to_owned()),
                        ..wire::AppQueryDenial::default()
                    })),
                }),
                ..wire::LoadResponse::default()
            })
        }

        fn act(&self, _request: &wire::ActRequest) -> Result<wire::ActResponse> {
            Ok(wire::ActResponse::default())
        }

        fn push(&self, _update: wire::ScreenUpdate) {}

        fn wake_after(&self, _after: Duration) {}
    }

    fn opened(route: wire::Route) -> wire::ViewState {
        let runtime = Runtime::new(
            Registry::default()
                .with(super::super::EVENT, build)
                .with(super::super::EDITOR, super::super::editor::build),
            vec![("t".to_owned(), route)],
        );
        let response = runtime
            .call(
                &Refusing,
                &wire::ScreenRequest {
                    kind: Some(wire::screen_request::Kind::Snapshot(
                        wire::SnapshotRequest {},
                    )),
                },
            )
            .expect("the runtime answers");
        response.update.expect("an update").views.remove(0)
    }

    #[test]
    fn a_vault_that_will_not_let_agenda_read_is_the_gate_on_the_event_page() {
        let view = opened(routes::event("e1", "e1", None, "2099-06-15"));
        let Some(wire::view_state::Kind::AgendaEvent(state)) = view.kind else {
            panic!("not an event page")
        };
        let Some(wire::agenda_event_state::Content::Denied(denied)) = state.content else {
            panic!("{:?}", state.content)
        };
        assert_eq!(denied.title, "Agenda cannot read this vault");
        assert_eq!(denied.receipt, "consent.revoked");
    }

    #[test]
    fn a_vault_that_will_not_let_agenda_read_is_the_gate_on_the_editor() {
        let view = opened(routes::editor(
            "",
            "",
            None,
            "2099-06-15",
            wire::AgendaEditorKind::Event,
        ));
        let Some(wire::view_state::Kind::AgendaEditor(state)) = view.kind else {
            panic!("not an editor")
        };
        let Some(wire::agenda_editor_state::Content::Denied(denied)) = state.content else {
            panic!("{:?}", state.content)
        };
        assert_eq!(denied.body, "Ask the owner of this vault for access.");
        assert_eq!(denied.receipt, "consent.revoked");
    }
}
