//! MAKE AN EVENT, OR CHANGE ONE (`calendar.editor`, #1046, #1135).
//!
//! ## Save is explicit
//!
//! Not autosave (#1015 D3's exception, ruled for this screen): a start time
//! typed half-way and saved is a wrong date on a calendar other people read,
//! which is worse than a lost draft. So Save is a button, armed only when the
//! draft is whole (a title, a calendar, an end after its start), and leaving
//! with changes asks. `Left` therefore writes nothing.
//!
//! ## Which command
//!
//! - CREATE: `propose`.
//! - EDIT of a one-off, or of a series with "the whole series": `edit-event`
//!   with the CHANGED fields only, a clear spelt `null`.
//! - EDIT of one occurrence, or it and the ones after: `edit-occurrence`,
//!   `override`, keyed on the occurrence's `original_start`. Only the day's own
//!   times and words ride it: a new repeat rule, a guest, a reminder, a link or
//!   a calendar belong to the whole series, so changing one of them is offered
//!   for the series alone, and moving the whole series' time is offered only
//!   from its first occurrence.
//! - Skip: `edit-occurrence`, `skip`, scope `occurrence`.
//!
//! ## Custom repeat and the event's own fields (#1173 wave 2)
//!
//! Repeat offers the presets and Custom. Custom opens a sheet over a WORKING
//! rule (`kit::schedule::custom`): frequency, every N, weekdays, the monthly
//! mode (days of the month, or "the second Tuesday") and the end, over a live
//! sentence. Done writes a whole rule to the draft (`repeat_rule`); a rule the
//! vault's editor seam cannot show opens read-only, with a choice to replace
//! it. A new rule belongs to the whole series, so on a series occurrence only
//! that scope is offered.
//!
//! An event also edits its place (chosen from the vault's places), a second
//! reminder (drawn once the first is set), availability, time zone and travel
//! time, all columns the vault already holds ([`fields`]). The zone is the
//! wall clock's: an event in another zone opens in ITS clock, and a zone picked
//! keeps the clock and moves the instant.
//!
//! ## Reminders are added in Reminders
//!
//! This editor makes events only: there is no Event or Task switch, and a
//! reminder is made by `reminders.editor`. A write answers at once, so a
//! committed Save sets `dismissed` and the screen ignores everything after it:
//! the core remembers no key, and a second Save would file the event again.

mod fields;
mod repeat_sheet;
pub mod write;

use centraid_api_proto::core_v1 as wire;
use wire::agenda_editor_event::Kind as K;
use wire::agenda_editor_state::{Asking, Mode, Sheet};
use wire::app_query_response::Answer;
use wire::screen_event::Kind as E;

use super::event::{
    calendar_hue, is_series_occurrence, person_hue, reminder_label, scope_word, scopes,
};
use crate::catalog::{act, load};
use crate::kit::act as kit_act;
use crate::kit::civil::{self, HourCycle};
use crate::kit::read::{self as kit_read, Note, Page, Reading};
use crate::kit::schedule::draft::{
    self, Draft, REMINDER_NONE, REPEAT_BIWEEKLY, REPEAT_CUSTOM, REPEAT_DAILY, REPEAT_MONTHLY,
    REPEAT_NONE, REPEAT_WEEKLY, REPEAT_YEARLY, RULES,
};
use crate::kit::schedule::rule_words::{self, long_day};
use crate::kit::stale;
use crate::kit::undo::Undo;
use crate::screen::{Ctx, Screen};
use crate::strings::{
    Locale, agenda as words, agenda_editor as editor_words, agenda_notify as notify_words,
    agenda_repeat as repeat_words, fill,
};

/// The editor reads calendars and the clock, never events: a window the vault
/// has no event in (the epoch's first second) answers both and nothing else.
const CALENDARS_ONLY: (&str, &str) = ("1970-01-01T00:00:00Z", "1970-01-01T00:00:01Z");

/// The registry factory.
#[must_use]
pub fn build(route: &wire::Route) -> Option<Box<dyn Screen>> {
    let Some(wire::route::Args::AgendaEditor(args)) = &route.args else {
        return None;
    };
    let mut args = args.clone();
    if args.instance_key.is_empty() {
        args.instance_key.clone_from(&args.event_id);
    }
    let create = args.event_id.is_empty();
    Some(Box::new(Editor {
        mode: if create { Mode::Create } else { Mode::Edit },
        route: args,
        phase: Phase::Loading,
        read_failed: false,
        loaded: None,
        baseline: None,
        draft: None,
        sheet: Sheet::None,
        custom: None,
        place_query: String::new(),
        typed_place: String::new(),
        zone_query: String::new(),
        asking: Asking::None,
        scope: None,
        save_tried: false,
        rev: None,
        undo: Undo::default(),
        dismissed: false,
    }))
}

enum Phase {
    Loading,
    Failed,
    Denied(wire::AppQueryDenial),
    Ready,
}

/// What the three reads answered.
struct Loaded {
    upcoming: wire::AgendaUpcoming,
    parties: wire::AgendaParties,
    /// An edit's event, read by id.
    detail: Option<wire::AgendaEventDetail>,
    /// The vault's places an event can be at; empty when the read did not land,
    /// and then an event has no place to choose.
    places: Vec<fields::Place>,
}

struct Editor {
    /// The event's revision when the draft was read: what an edit names as the one it replaces
    /// (#1185). `None` for a new event and when it could not be read.
    rev: Option<i64>,
    route: wire::AgendaEditorRoute,
    mode: Mode,
    phase: Phase,
    /// A re-read failed over the draft on screen: a note over the words.
    read_failed: bool,
    loaded: Option<Loaded>,
    /// The values as loaded: what "changed" is measured against.
    baseline: Option<Draft>,
    draft: Option<Draft>,
    sheet: Sheet,
    /// The Custom repeat sheet's working rule, while it is open.
    custom: Option<crate::kit::schedule::custom::Custom>,
    /// What the place and zone searches hold.
    place_query: String,
    /// A place the member TYPED and the vault does not hold yet: it is founded when the event
    /// saves (a place already called that is reused). Empty with a place picked or none.
    typed_place: String,
    zone_query: String,
    asking: Asking,
    /// The save scope picked.
    scope: Option<wire::AgendaScope>,
    /// Save was pressed, which is when a blocked draft says why even before
    /// anything was typed.
    save_tried: bool,
    /// The vault's refusal of the last Save, over the draft that stays.
    /// The status line: a refusal, over the draft as it still is (a save ends the sitting).
    undo: Undo,
    dismissed: bool,
}

impl Editor {
    // -- reads ------------------------------------------------------------

    /// Read calendars, people and (for an edit) the event. A re-read keeps the
    /// draft: a change elsewhere never overwrites what the member is typing.
    fn reload(&mut self, ctx: &Ctx) {
        let upcoming = kit_read::read(
            ctx,
            load::calendar::Upcoming {
                from: Some(CALENDARS_ONLY.0.to_owned()),
                to: Some(CALENDARS_ONLY.1.to_owned()),
            },
            |answer| match answer {
                Answer::AgendaUpcoming(upcoming) => Some(upcoming),
                _ => None,
            },
        );
        let parties = kit_read::read(
            ctx,
            load::calendar::Parties::default(),
            |answer| match answer {
                Answer::AgendaParties(parties) => Some(parties),
                _ => None,
            },
        );
        // The revision first, once per draft: a change between the two reads refuses the save.
        if self.mode == Mode::Edit && self.draft.is_none() {
            self.rev = stale::read_rev(ctx, &self.route.event_id);
        }
        // AN EDIT READS ITS EVENT BY ID: a search hit on a repeating event is the
        // series row, which no window lists. Absent there is gone.
        let detail = (self.mode == Mode::Edit).then(|| self.read_event(ctx));
        let denial = [
            denial_of(&upcoming),
            denial_of(&parties),
            detail.as_ref().and_then(denial_of),
        ]
        .into_iter()
        .flatten()
        .next();
        if let Some(denial) = denial {
            self.phase = Phase::Denied(denial);
            return;
        }
        let answered = match (upcoming, parties, detail) {
            (Reading::Data(upcoming), Reading::Data(parties), None) => {
                Some((upcoming, parties, None))
            }
            (Reading::Data(upcoming), Reading::Data(parties), Some(Reading::Data(detail))) => {
                Some((upcoming, parties, Some(detail)))
            }
            _ => None,
        };
        let Some((upcoming, parties, detail)) = answered else {
            // A re-read that failed keeps the draft under a note; only a first read has nothing
            // else to show.
            if self.draft.is_none() {
                self.phase = Phase::Failed;
            } else {
                self.read_failed = true;
            }
            return;
        };
        let places = fields::read_places(ctx);
        self.loaded = Some(Loaded {
            upcoming,
            parties,
            detail,
            places,
        });
        self.phase = Phase::Ready;
        self.read_failed = false;
        if self.draft.is_none() {
            self.baseline = match self.mode {
                Mode::Edit => self.event().map(draft::draft_of),
                _ => self.loaded.as_ref().map(|loaded| {
                    let named = draft::new_draft(&self.route.day, &loaded.upcoming);
                    // A SLOT PRESSED ON THE GRID names the start; the end follows by an hour.
                    Draft {
                        zone: ctx.zone().to_owned(),
                        ..draft::starting_at(&named, &self.route.start_time)
                    }
                }),
            };
            self.draft.clone_from(&self.baseline);
        }
    }

    /// The event being edited, read by id. A zoned event whose own zone is not
    /// the phone's is read again in ITS zone, so the wall clock the member
    /// edits is the one the event was made in, and a zone picked later keeps it.
    fn read_event(&self, ctx: &Ctx) -> Reading<wire::AgendaEventDetail> {
        let request = |zone: Option<&str>| {
            let mut request: wire::LoadRequest = load::calendar::Event {
                event_id: self.route.event_id.clone(),
                instance_key: Some(self.route.instance_key.clone()).filter(|key| !key.is_empty()),
                original_start_local: self
                    .route
                    .original_start_local
                    .clone()
                    .filter(|key| !key.is_empty()),
            }
            .into();
            if let Some(zone) = zone {
                zone.clone_into(&mut request.zone);
            }
            request
        };
        let pick = |answer| match answer {
            Answer::AgendaEvent(detail) => Some(*detail),
            _ => None,
        };
        let first = kit_read::read(ctx, request(None), pick);
        let own_zone = first.data().and_then(|detail| {
            let event = detail.event.as_ref()?;
            (event.recurrence_semantics.as_deref() == Some("zoned"))
                .then(|| event.start_tz.clone())
                .flatten()
                .filter(|zone| !zone.is_empty() && zone != ctx.zone())
        });
        match own_zone {
            Some(zone) => kit_read::read(ctx, request(Some(&zone)), pick),
            None => first,
        }
    }

    /// The event being edited: the by-id answer, when it is the series this
    /// screen is on.
    fn event(&self) -> Option<&wire::AgendaEvent> {
        let detail = self.loaded.as_ref()?.detail.as_ref()?;
        detail
            .event
            .as_ref()
            .filter(|event| event.event_id == self.route.event_id)
    }

    // -- the draft --------------------------------------------------------

    /// Apply a change to the draft. A change is the member acting again, so the
    /// last refusal goes.
    fn edit(&mut self, change: impl FnOnce(&Draft) -> Option<Draft>) {
        let Some(current) = &self.draft else { return };
        if let Some(next) = change(current) {
            self.draft = Some(next);
            self.undo.clear();
        }
    }

    fn close_sheet(&mut self) {
        self.sheet = Sheet::None;
        self.scope = None;
        self.custom = None;
        self.place_query.clear();
        self.zone_query.clear();
    }

    fn dirty(&self) -> bool {
        match (&self.draft, &self.baseline) {
            (Some(draft), Some(base)) => {
                draft::dirty(draft, base) || !self.typed_place.trim().is_empty()
            }
            _ => false,
        }
    }

    /// Why Save is not armed, or empty.
    fn blocked(&self, locale: Locale) -> String {
        let Some(draft) = &self.draft else {
            return String::new();
        };
        if draft.title.trim().is_empty() {
            words::block_title(locale)
        } else if draft.calendar_id.is_empty() && self.mode == Mode::Create {
            words::block_calendar(locale)
        } else if !draft::range_is_whole(draft) {
            words::block_range(locale)
        } else {
            String::new()
        }
    }

    fn can_save(&self, locale: Locale) -> bool {
        self.draft.is_some()
            && !self.dismissed
            && self.blocked(locale).is_empty()
            && (self.mode == Mode::Create || self.dirty())
    }

    fn is_series_edit(&self) -> bool {
        self.mode == Mode::Edit && self.event().is_some_and(is_series_occurrence)
    }

    // -- saving -----------------------------------------------------------

    fn save(&mut self, ctx: &Ctx) -> Vec<wire::Effect> {
        if self.dismissed {
            return Vec::new();
        }
        if !self.can_save(ctx.locale()) {
            self.save_tried = self.draft.is_some();
            return Vec::new();
        }
        let (Some(mut draft), Some(base)) = (self.draft.clone(), self.baseline.clone()) else {
            return Vec::new();
        };
        // A TYPED PLACE becomes a place of the vault first; the event then points at it.
        if !self.typed_place.trim().is_empty() {
            match self.found_typed_place(ctx) {
                Some(id) => draft.place_id = id,
                None => return Vec::new(),
            }
        }
        if self.mode == Mode::Create {
            return self.save_event(ctx, &draft);
        }
        let Some(event) = self.event() else {
            return Vec::new();
        };
        let event_id = event.event_id.clone();
        let owner_ids: Vec<String> = event
            .attendees
            .iter()
            .filter(|a| a.is_you)
            .map(|a| a.party_id.clone())
            .collect();
        let occurrence = event.original_start_local.clone().unwrap_or_default();
        if !self.is_series_edit() {
            let request = act::calendar::EditEvent {
                expected_rev: self.rev,
                ..write::edit_event(&event_id, &draft, &base, &owner_ids)
            };
            let key = kit_act::key(&["edit-event", &event_id], kit_act::fresh());
            return self.committed(ctx, request, &key, editor_words::event_saved);
        }
        if self.sheet != Sheet::Scope {
            // WHICH OCCURRENCES: asked, never assumed.
            self.sheet = Sheet::Scope;
            self.scope = None;
            return Vec::new();
        }
        let Some(scope) = self.scope else {
            return Vec::new();
        };
        self.close_sheet();
        match scope {
            wire::AgendaScope::Series => {
                let request = act::calendar::EditEvent {
                    expected_rev: self.rev,
                    ..write::edit_event(&event_id, &draft, &base, &owner_ids)
                };
                let key = kit_act::key(&["edit-event", &event_id], kit_act::fresh());
                self.committed(ctx, request, &key, editor_words::event_saved)
            }
            wire::AgendaScope::Occurrence | wire::AgendaScope::Future => {
                let word = scope_word(scope);
                let wire_scope = if scope == wire::AgendaScope::Future {
                    act::calendar::EditOccurrenceScope::Future
                } else {
                    act::calendar::EditOccurrenceScope::Occurrence
                };
                let request =
                    write::override_occurrence(&event_id, &occurrence, wire_scope, &draft, &base);
                let key = kit_act::key(
                    &["edit-occurrence", &event_id, &occurrence, word, "override"],
                    kit_act::fresh(),
                );
                self.committed(ctx, request, &key, editor_words::event_saved)
            }
            wire::AgendaScope::Unspecified => Vec::new(),
        }
    }

    fn save_event(&mut self, ctx: &Ctx, draft: &Draft) -> Vec<wire::Effect> {
        let request = write::propose(draft);
        let key = kit_act::key(&["propose", "new"], kit_act::fresh());
        self.committed(ctx, request, &key, editor_words::event_saved)
    }

    /// Submit a write that ends the sitting when it commits.
    fn committed(
        &mut self,
        ctx: &Ctx,
        request: impl Into<wire::ActRequest>,
        key: &str,
        said: impl FnOnce(Locale) -> String,
    ) -> Vec<wire::Effect> {
        // THE PAGE CLOSES, so the line (and its Undo) goes to the page beneath (#1185).
        let settled = self.undo.act_handing_down(ctx, request, key, said);
        if settled.committed {
            self.dismissed = true;
        } else if let Some(stale) = settled.stale() {
            self.stale(ctx, stale);
        }
        Vec::new()
    }

    /// The vault refused the save: the event changed, or went to the trash, since the draft was
    /// read (#1185). The words typed are kept as an earlier version of the event, the event is read
    /// again, and the line says what happened and where the words went.
    fn stale(&mut self, ctx: &Ctx, stale: stale::Stale) {
        let mut fields = Vec::new();
        if let (Some(draft), Some(base)) = (&self.draft, &self.baseline) {
            if draft.title.trim() != base.title.trim() {
                fields.push(("entity.title".to_owned(), draft.title.trim().into()));
            }
            if draft.notes.trim() != base.notes.trim() {
                let notes = Some(draft.notes.trim()).filter(|notes| !notes.is_empty());
                fields.push(("event.description".to_owned(), notes.into()));
            }
        }
        let locale = ctx.locale();
        let said = stale::on_button(
            ctx,
            &crate::strings::chat_confirm::noun_event(locale),
            &self.route.event_id,
            stale,
            fields,
        );
        self.draft = None;
        self.baseline = None;
        self.typed_place.clear();
        self.close_sheet();
        self.reload(ctx);
        self.undo.refuse(said);
    }

    fn skip(&mut self, ctx: &Ctx) {
        if self.dismissed {
            return;
        }
        let Some(event) = self.event() else { return };
        let Some(occurrence) = event.original_start_local.clone() else {
            return;
        };
        let event_id = event.event_id.clone();
        let request = write::skip_occurrence(
            &event_id,
            &occurrence,
            act::calendar::EditOccurrenceScope::Occurrence,
        );
        let key = kit_act::key(
            &[
                "edit-occurrence",
                &event_id,
                &occurrence,
                "occurrence",
                "skip",
            ],
            kit_act::fresh(),
        );
        self.committed(ctx, request, &key, editor_words::occurrence_skipped);
    }

    // -- events -----------------------------------------------------------

    fn on_editor_event(&mut self, event: K, ctx: &Ctx) -> Vec<wire::Effect> {
        match event {
            K::Refreshed(_) => self.reload(ctx),
            K::Title(change) => self.edit(|d| {
                Some(Draft {
                    title: change.text,
                    ..d.clone()
                })
            }),
            K::Notes(change) => self.edit(|d| {
                Some(Draft {
                    notes: change.text,
                    ..d.clone()
                })
            }),
            K::Link(change) => self.edit(|d| {
                Some(Draft {
                    link: change.text,
                    ..d.clone()
                })
            }),
            K::AllDay(change) => {
                self.edit(|d| Some(draft::all_day(d, change.on)));
                if !change.on {
                    self.settle_zone(ctx);
                }
            }
            K::Start(change) => self.edit(|d| draft::move_start(d, &change.day, &change.time)),
            K::End(change) => self.edit(|d| draft::set_end(d, &change.day, &change.time)),
            K::Calendar(picked) => {
                let known = self.loaded.as_ref().is_some_and(|l| {
                    l.upcoming
                        .calendars
                        .iter()
                        .any(|c| c.calendar_id == picked.calendar_id)
                });
                if known {
                    self.close_sheet();
                    self.edit(|d| {
                        Some(Draft {
                            calendar_id: picked.calendar_id,
                            ..d.clone()
                        })
                    });
                }
            }
            K::Guest(toggled) => {
                if self
                    .guest_choices()
                    .iter()
                    .any(|(id, _)| *id == toggled.party_id)
                {
                    self.edit(|d| {
                        let mut guests = d.guest_ids.clone();
                        if let Some(at) = guests.iter().position(|id| *id == toggled.party_id) {
                            guests.remove(at);
                        } else {
                            guests.push(toggled.party_id);
                        }
                        Some(Draft {
                            guest_ids: guests,
                            ..d.clone()
                        })
                    });
                }
            }
            K::Repeat(picked) => {
                if picked.key == REPEAT_CUSTOM {
                    // Custom opens its own sheet over the working rule.
                    self.open_custom();
                } else if self.repeat_keys().contains(&picked.key) {
                    self.close_sheet();
                    self.edit(|d| {
                        Some(Draft {
                            repeat_key: picked.key,
                            repeat_rule: String::new(),
                            ..d.clone()
                        })
                    });
                }
            }
            K::Reminder(picked) => {
                if self.reminder_keys().contains(&picked.key) {
                    self.close_sheet();
                    self.edit(|d| {
                        // A second alert needs the first, and is never the same lead.
                        let second =
                            if picked.key == REMINDER_NONE || d.second_reminder_key == picked.key {
                                REMINDER_NONE.to_owned()
                            } else {
                                d.second_reminder_key.clone()
                            };
                        Some(Draft {
                            reminder_key: picked.key,
                            second_reminder_key: second,
                            ..d.clone()
                        })
                    });
                }
            }
            K::SheetOpened(opened) => {
                let sheet = Sheet::try_from(opened.sheet).unwrap_or(Sheet::Unspecified);
                if !matches!(sheet, Sheet::Unspecified | Sheet::Scope) && self.draft.is_some() {
                    self.open_sheet(sheet);
                }
            }
            K::SheetClosed(_) => self.close_sheet(),
            K::Save(_) => return self.save(ctx),
            K::Scope(picked) => {
                let scope = wire::AgendaScope::try_from(picked.scope)
                    .unwrap_or(wire::AgendaScope::Unspecified);
                let enabled = self
                    .save_scopes(ctx.locale())
                    .iter()
                    .any(|c| c.scope == scope as i32 && c.enabled);
                if self.sheet == Sheet::Scope && enabled {
                    self.scope = Some(scope);
                }
            }
            K::Skip(_) => {
                if self.is_series_edit() {
                    self.asking = Asking::Skip;
                }
            }
            K::Leave(_) => {
                if self.dirty() {
                    self.asking = Asking::Discard;
                } else {
                    self.dismissed = true;
                }
            }
            K::Confirmed(_) => match std::mem::replace(&mut self.asking, Asking::None) {
                Asking::Discard => self.dismissed = true,
                Asking::Skip => self.skip(ctx),
                _ => {}
            },
            K::ConfirmDismissed(_) => self.asking = Asking::None,
            // WAVE 2 (#1173): the event's place, second alert, availability, zone and travel.
            K::PlaceSearch(search) => self.place_query = search.text,
            K::Place(picked) => self.pick_place(&picked.key),
            K::PlaceCleared(_) => self.clear_place(),
            K::SecondReminder(picked) => self.pick_second_reminder(&picked.key),
            K::Availability(picked) => self.pick_availability(&picked.key),
            K::ZoneSearch(search) => self.zone_query = search.text,
            K::Zone(picked) => self.pick_zone(&picked.key, ctx.zone()),
            K::Travel(picked) => self.pick_travel(&picked.key),
            K::CustomFreq(picked) => self.custom_freq(&picked.key),
            K::CustomInterval(changed) => self.custom_interval(changed.interval),
            K::CustomWeekday(toggled) => self.custom_weekday(&toggled.key),
            K::CustomMonthMode(picked) => self.custom_month_mode(&picked.key),
            K::CustomMonthDay(toggled) => self.custom_month_day(&toggled.key),
            K::CustomOrdinal(picked) => self.custom_ordinal(&picked.key),
            K::CustomNthWeekday(picked) => self.custom_nth_weekday(&picked.key),
            K::CustomEnd(picked) => self.custom_end(&picked.key),
            K::CustomUntil(changed) => self.custom_until(&changed.day),
            K::CustomCount(changed) => self.custom_count(changed.count),
            K::CustomApplied(_) => self.apply_custom(),
            K::CustomReplace(_) => self.replace_custom(),
            // Reminders' fields and its kind switch: an event has none of them.
            K::KindPicked(_)
            | K::List(_)
            | K::Priority(_)
            | K::TagAdded(_)
            | K::TagRemoved(_)
            | K::MoreDetails(_)
            | K::Url(_) => {}
        }
        Vec::new()
    }

    // -- the pickers' lists -----------------------------------------------

    /// People an event can invite: everyone listed but the owner, and a guest
    /// nobody lists (a party the picker leaves out) stays choosable.
    fn guest_choices(&self) -> Vec<(String, String)> {
        let Some(loaded) = &self.loaded else {
            return Vec::new();
        };
        let mut choices: Vec<(String, String)> = loaded
            .parties
            .parties
            .iter()
            .filter(|party| !party.is_you)
            .map(|party| (party.party_id.clone(), party.name.clone()))
            .collect();
        let known: Vec<String> = choices.iter().map(|(id, _)| id.clone()).collect();
        if let Some(event) = self.event() {
            choices.extend(
                event
                    .attendees
                    .iter()
                    .filter(|a| !a.is_you && !known.contains(&a.party_id))
                    .map(|a| (a.party_id.clone(), a.name.clone())),
            );
        }
        choices
    }

    fn repeat_keys(&self) -> Vec<String> {
        let mut keys = vec![REPEAT_NONE.to_owned()];
        keys.extend(RULES.iter().map(|(key, _)| (*key).to_owned()));
        keys.push(REPEAT_CUSTOM.to_owned());
        keys
    }

    fn reminder_keys(&self) -> Vec<String> {
        let mut minutes: Vec<i64> = self.stored_leads();
        minutes.sort_unstable();
        minutes.dedup();
        std::iter::once(REMINDER_NONE.to_owned())
            .chain(minutes.iter().map(i64::to_string))
            .collect()
    }

    /// THE SAVE SCOPES, and which this change can reach. A new rule is the
    /// series' alone; moving the whole series' time is offered only from its
    /// first occurrence.
    fn save_scopes(&self, locale: Locale) -> Vec<wire::AgendaScopeChoice> {
        let (Some(draft), Some(base), Some(event)) = (&self.draft, &self.baseline, self.event())
        else {
            return Vec::new();
        };
        let rule_changed = !draft::same_repeat(draft, base);
        let whole_event_only =
            draft::series_only(draft, base) || !self.typed_place.trim().is_empty();
        let moves_series = draft::times_changed(draft, base) && event.is_recurrence_instance;
        scopes(locale, self.scope)
            .into_iter()
            .map(|choice| {
                let off = |note: String| wire::AgendaScopeChoice {
                    enabled: false,
                    selected: false,
                    note,
                    ..choice.clone()
                };
                if choice.scope == wire::AgendaScope::Series as i32 {
                    if moves_series {
                        off(words::scope_move_note(locale))
                    } else {
                        choice
                    }
                } else if rule_changed {
                    off(words::scope_rule_note(locale))
                } else if whole_event_only {
                    off(words::scope_series_note(locale))
                } else {
                    choice
                }
            })
            .collect()
    }
}

fn denial_of<T>(reading: &Reading<T>) -> Option<wire::AppQueryDenial> {
    match reading {
        Reading::Denied(denial) => Some(denial.clone()),
        _ => None,
    }
}

impl Screen for Editor {
    fn update(&mut self, event: wire::ScreenEvent, ctx: &Ctx) -> Vec<wire::Effect> {
        if self.dismissed {
            return Vec::new();
        }
        match event.kind {
            Some(E::Appeared(_)) => {
                self.reload(ctx);
                Vec::new()
            }
            Some(E::DataChanged(_) | E::EnvironmentChanged(_)) => {
                self.reload(ctx);
                Vec::new()
            }
            Some(E::AgendaEditor(event)) => event
                .kind
                .map_or_else(Vec::new, |kind| self.on_editor_event(kind, ctx)),
            _ => Vec::new(),
        }
    }

    fn view(&self, ctx: &Ctx) -> wire::ViewState {
        let locale = ctx.locale();
        // Ready with no draft is an event that is no longer there: a failed page with its own
        // words and no Retry, never a blank.
        let gone = matches!(self.phase, Phase::Ready) && self.draft.is_none();
        let page: Page<()> = match &self.phase {
            Phase::Loading => Page::loading(),
            Phase::Failed => Page::Failed,
            Phase::Denied(denial) => Page::Refused(denial.clone()),
            Phase::Ready if gone => Page::Failed,
            Phase::Ready => Page::Ready {
                data: (),
                note: self.read_failed.then(|| Note::refresh_failed(locale)),
            },
        };
        let mut wired = page.wire(
            locale,
            |denial| wire::Denied {
                title: words::denied_title(locale),
                body: words::denied_body(locale),
                receipt: denial.code.clone().unwrap_or_default(),
            },
            wire::EmptyState::default,
        );
        if matches!(wired.state, Some(wire::page_state::State::Failed(_))) {
            wired.state = Some(wire::page_state::State::Failed(if gone {
                kit_read::gone(words::gone_title(locale), words::gone_body(locale))
            } else {
                kit_read::incomplete(locale)
            }));
        }
        let content = match (&self.phase, &self.draft) {
            (Phase::Ready, Some(draft)) => Some(wire::agenda_editor_state::Content::Data(
                Box::new(self.data(locale, ctx.hour_cycle(), ctx.zone(), draft)),
            )),
            _ => None,
        };
        let state = wire::AgendaEditorState {
            mode: self.mode as i32,
            content,
            page: Some(wired),
            sheet: self.sheet as i32,
            confirm: self.confirm(locale),
            chrome: Some(chrome(locale)),
            dismissed: self.dismissed,
            kind: wire::AgendaEditorKind::Event as i32,
            status: self.undo.status(),
        };
        wire::ViewState {
            kind: Some(wire::view_state::Kind::AgendaEditor(state)),
            ..wire::ViewState::default()
        }
    }
}

impl Editor {
    /// The discard or skip question, while it is asked.
    fn confirm(&self, locale: Locale) -> Option<wire::Confirm> {
        match self.asking {
            Asking::Discard => Some(wire::Confirm {
                title: if self.mode == Mode::Create {
                    words::confirm_discard_new_title(locale)
                } else {
                    words::confirm_discard_title(locale)
                },
                body: words::confirm_discard_body(locale),
                confirm_label: words::quick_discard(locale),
                destructive: true,
            }),
            Asking::Skip => Some(wire::Confirm {
                title: words::confirm_skip_title(locale),
                body: words::confirm_skip_body(locale),
                confirm_label: words::confirm_skip(locale),
                destructive: true,
            }),
            _ => None,
        }
    }

    fn data(
        &self,
        locale: Locale,
        cycle: HourCycle,
        device_zone: &str,
        draft: &Draft,
    ) -> wire::AgendaEditorData {
        let Some(loaded) = &self.loaded else {
            return wire::AgendaEditorData::default();
        };
        let calendar = loaded
            .upcoming
            .calendars
            .iter()
            .find(|c| c.calendar_id == draft.calendar_id);
        let calendar_name = calendar
            .and_then(|c| c.name.as_deref())
            .filter(|name| !name.trim().is_empty())
            .map_or_else(
                || {
                    if draft.calendar_id.is_empty() {
                        words::no_calendar(locale)
                    } else {
                        words::calendar_unnamed(locale)
                    }
                },
                str::to_owned,
            );
        let guests = self.guest_choices();
        let chosen: Vec<&str> = guests
            .iter()
            .filter(|(id, _)| draft.guest_ids.contains(id))
            .map(|(_, name)| name.as_str())
            .collect();
        let repeats: Vec<wire::AgendaChoice> = self
            .repeat_keys()
            .into_iter()
            .map(|key| {
                let label = self.repeat_label(locale, &key, draft);
                wire::AgendaChoice {
                    selected: key == draft.repeat_key,
                    accessibility_label: label.clone(),
                    key,
                    label,
                    hue_key: String::new(),
                }
            })
            .collect();
        let reminders: Vec<wire::AgendaChoice> = self
            .reminder_keys()
            .into_iter()
            .map(|key| {
                let label = key.parse::<i64>().map_or_else(
                    |_| words::reminder_none(locale),
                    |minutes| reminder_label(locale, minutes),
                );
                wire::AgendaChoice {
                    selected: key == draft.reminder_key,
                    accessibility_label: label.clone(),
                    key,
                    label,
                    hue_key: String::new(),
                }
            })
            .collect();
        let timed = !draft.all_day;
        let repeat_label = repeats.iter().find(|choice| choice.selected).map_or_else(
            || words::repeat_never(locale),
            |choice| choice.label.clone(),
        );
        let saved_scopes = if self.sheet == Sheet::Scope {
            self.save_scopes(locale)
        } else {
            Vec::new()
        };
        let blocked = self.blocked(locale);
        let say_blocked = self.dirty() || self.save_tried;
        let series = self.is_series_edit();
        let day_time = |day: &str, time: &str| {
            if draft.all_day {
                long_day(locale, day)
            } else {
                fill(
                    &editor_words::day_and_time(locale),
                    &[
                        ("day", &long_day(locale, day)),
                        ("time", &civil::time_for(locale, time, cycle)),
                    ],
                )
            }
        };
        wire::AgendaEditorData {
            draft: Some(draft.clone()),
            heading: if self.mode == Mode::Create {
                words::new_event(locale)
            } else {
                words::editor_edit(locale)
            },
            start_label: day_time(&draft.start_day, &draft.start_time),
            end_label: day_time(&draft.end_day, &draft.end_time),
            start_day_label: civil::short_day(locale, &draft.start_day),
            start_time_label: if draft.all_day {
                String::new()
            } else {
                civil::time_for(locale, &draft.start_time, cycle)
            },
            end_day_label: civil::short_day(locale, &draft.end_day),
            end_time_label: if draft.all_day {
                String::new()
            } else {
                civil::time_for(locale, &draft.end_time, cycle)
            },
            calendar_label: calendar_name,
            calendar_hue_key: calendar_hue(
                Some(draft.calendar_id.as_str()).filter(|id| !id.is_empty()),
                calendar,
            ),
            calendars: loaded
                .upcoming
                .calendars
                .iter()
                .map(|c| {
                    let name = c
                        .name
                        .as_deref()
                        .filter(|name| !name.trim().is_empty())
                        .map_or_else(|| words::calendar_unnamed(locale), str::to_owned);
                    wire::AgendaChoice {
                        key: c.calendar_id.clone(),
                        selected: c.calendar_id == draft.calendar_id,
                        hue_key: calendar_hue(Some(&c.calendar_id), Some(c)),
                        accessibility_label: name.clone(),
                        label: name,
                    }
                })
                .collect(),
            guests_label: if chosen.is_empty() {
                words::guests_none(locale)
            } else {
                chosen.join(", ")
            },
            guests: guests
                .iter()
                .map(|(id, name)| wire::AgendaChoice {
                    key: id.clone(),
                    label: name.clone(),
                    selected: draft.guest_ids.contains(id),
                    hue_key: person_hue(id),
                    accessibility_label: name.clone(),
                })
                .collect(),
            repeat_label: repeat_label.clone(),
            repeats,
            repeat_note: if series {
                words::repeat_series_note(locale)
            } else {
                String::new()
            },
            reminder_label: reminders.iter().find(|choice| choice.selected).map_or_else(
                || words::reminder_none(locale),
                |choice| choice.label.clone(),
            ),
            reminders,
            // AN ALERT NEEDS A MOMENT: an all-day event never sounds one, and the row says so.
            reminder_note: if draft.all_day {
                notify_words::no_alert_without_time(locale)
            } else {
                String::new()
            },
            scope_armed: saved_scopes.iter().any(|c| c.selected && c.enabled),
            scopes: saved_scopes,
            dirty: self.dirty(),
            can_save: self.can_save(locale),
            blocked_reason: if say_blocked { blocked } else { String::new() },
            show_skip: series,
            skip_label: if series {
                words::scope_skip(locale)
            } else {
                String::new()
            },
            foot_note: if self.mode == Mode::Create {
                words::foot_new(locale)
            } else {
                String::new()
            },
            kinds: Vec::new(),
            show_event_fields: true,
            start_field_label: words::field_starts(locale),
            show_task_fields: false,
            list_label: String::new(),
            list_hue_key: String::new(),
            lists: Vec::new(),
            more_details_open: false,
            more_details_summary: String::new(),
            location_label: self.location_label(locale, draft),
            places: if self.sheet == Sheet::Location {
                self.place_choices(locale, draft)
            } else {
                Vec::new()
            },
            place_query: self.place_query.clone(),
            show_clear_location: !draft.place_id.is_empty() || !self.typed_place.trim().is_empty(),
            show_second_reminder: draft.reminder_key != REMINDER_NONE,
            second_reminder_label: self
                .second_reminder_choices(locale, draft)
                .iter()
                .find(|choice| choice.selected)
                .map_or_else(|| words::reminder_none(locale), |c| c.label.clone()),
            second_reminders: if draft.reminder_key != REMINDER_NONE {
                self.second_reminder_choices(locale, draft)
            } else {
                Vec::new()
            },
            availability_label: if draft.free {
                editor_words::free(locale)
            } else {
                editor_words::busy(locale)
            },
            availabilities: Self::availability_choices(locale, draft),
            show_zone: timed,
            zone_label: if timed {
                self.zone_label(locale, draft)
            } else {
                String::new()
            },
            zones: if timed && self.sheet == Sheet::Zone {
                self.zone_choices(locale, device_zone, draft)
            } else {
                Vec::new()
            },
            zone_query: self.zone_query.clone(),
            travel_label: Self::travel_label(locale, draft.travel_min),
            travels: self.travel_choices(locale, draft),
            custom_repeat: if self.sheet == Sheet::CustomRepeat {
                self.custom_sheet(locale, draft)
            } else {
                None
            },
            show_url: false,
            url_saved_as: String::new(),
            priority_label: String::new(),
            priorities: Vec::new(),
        }
    }

    /// A repeat preset named for the day the event starts on.
    fn repeat_label(&self, locale: Locale, key: &str, draft: &Draft) -> String {
        let day = draft.start_day.as_str();
        let long = long_day(locale, day);
        let (weekday, day_month) = long
            .split_once(' ')
            .unwrap_or((long.as_str(), long.as_str()));
        match key {
            REPEAT_DAILY => words::repeat_daily(locale),
            REPEAT_WEEKLY => fill(
                &editor_words::repeat_weekly_on(locale),
                &[("weekday", weekday)],
            ),
            REPEAT_BIWEEKLY => fill(
                &editor_words::repeat_biweekly_on(locale),
                &[("weekday", weekday)],
            ),
            REPEAT_MONTHLY => fill(
                &editor_words::repeat_monthly_on(locale),
                &[(
                    "ordinal",
                    &civil::ordinal(civil::day_of_month_of(day).unwrap_or(1)),
                )],
            ),
            REPEAT_YEARLY => fill(
                &editor_words::repeat_yearly_on(locale),
                &[("day_month", day_month)],
            ),
            // A rule as stored says what the vault says of it (the one
            // summariser); one the member just built says what the sheet says.
            REPEAT_CUSTOM if draft.repeat_key != REPEAT_CUSTOM => {
                editor_words::repeat_custom(locale)
            }
            REPEAT_CUSTOM => {
                let stored = self
                    .baseline
                    .as_ref()
                    .is_some_and(|base| draft::same_repeat(draft, base))
                    .then(|| {
                        self.event()
                            .and_then(|event| event.rrule.as_deref())
                            .and_then(|rule| rule_words::of_rule(locale, rule))
                    })
                    .flatten();
                stored
                    .or_else(|| {
                        draft::rule_for(draft)
                            .and_then(|rule| crate::kit::schedule::repeat::from_rrule(&rule, day))
                            .map(|spec| crate::kit::schedule::custom::summary(locale, &spec))
                    })
                    .unwrap_or_else(|| editor_words::repeat_custom(locale))
            }
            _ => words::repeat_never(locale),
        }
    }
}

fn chrome(locale: Locale) -> wire::AgendaEditorChrome {
    wire::AgendaEditorChrome {
        title_placeholder: words::placeholder_title(locale),
        notes_placeholder: words::placeholder_notes(locale),
        link_placeholder: words::placeholder_link(locale),
        field_title: words::field_summary(locale),
        field_all_day: words::field_all_day(locale),
        field_ends: words::field_ends(locale),
        field_calendar: words::field_calendar(locale),
        field_guests: words::field_guests(locale),
        field_repeat: words::field_repeat(locale),
        field_reminder: words::field_reminder(locale),
        field_link: words::field_where(locale),
        field_notes: words::field_notes(locale),
        save: words::save(locale),
        close: words::close(locale),
        done: words::done(locale),
        keep_editing: words::keep_editing(locale),
        loading: words::loading(locale),
        retry: words::retry(locale),
        scope_title: words::scope_title(locale),
        scope_question: words::scope_question(locale),
        pick_date: words::pick_date(locale),
        pick_time: words::pick_time(locale),
        field_location: editor_words::field_location(locale),
        field_second_alert: editor_words::field_second_alert(locale),
        field_availability: editor_words::field_availability(locale),
        field_zone: editor_words::field_zone(locale),
        field_travel: editor_words::field_travel(locale),
        field_url: editor_words::field_url(locale),
        url_placeholder: editor_words::placeholder_url(locale),
        place_search_placeholder: editor_words::placeholder_place_search(locale),
        zone_search_placeholder: editor_words::placeholder_zone_search(locale),
        clear_location: editor_words::location_none(locale),
        custom_repeat_title: repeat_words::title(locale),
        field_first_alert: editor_words::field_first_alert(locale),
        tiles: row_tiles(),
        ..wire::AgendaEditorChrome::default()
    }
}

/// THE BOARD'S COLOUR TILES for the event editor's rows (`EventEditorRows`): the times and the
/// calendar in Calendar's blue, the place, availability in the list blue, the zone and the
/// travel time in Calendar's blue too (a state colour only ever says a state) and the rest in the
/// neutral grey.
fn row_tiles() -> Vec<wire::AgendaRowTile> {
    const CALENDAR: &str = "appCalendar";
    const GREY: &str = "textMeta";
    [
        ("start", "Calendar", CALENDAR),
        ("end", "Clock", CALENDAR),
        ("repeat", "Repeat", GREY),
        ("calendar", "CalendarBlank", CALENDAR),
        ("guests", "Users", GREY),
        ("location", "MapPin", CALENDAR),
        ("reminder", "Bell", GREY),
        ("second_reminder", "Bell", GREY),
        ("availability", "Check", "listBlue"),
        ("zone", "Globe", CALENDAR),
        ("travel", "Clock", CALENDAR),
        ("link", "OpenExternal", GREY),
    ]
    .into_iter()
    .map(|(key, icon, color)| wire::AgendaRowTile {
        key: key.to_owned(),
        icon_key: icon.to_owned(),
        color_key: color.to_owned(),
    })
    .collect()
}
