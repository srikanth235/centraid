//! MAKE AN EVENT OR A TASK, OR CHANGE AN EVENT (`agenda.editor`, #1046, #1128,
//! #1135).
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
//! - CREATE an event: `propose`. CREATE a task: `add-task` through
//!   [`Ops::add`], the to-do surfaces' one add.
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
//! ## The new task sheet (#1173, decided)
//!
//! Title and due first, then Notes (the task's description), List (the Inbox,
//! then the projects A to Z) and a "More details" row that opens priority,
//! repeat and tags. Save is one `add-task` carrying the notes, the priority, the
//! repeat rule and the project, then one `add-task-tag` per tag. A task has no
//! place: the vault's task has no such field, so the sheet does not draw one.
//!
//! ## Custom repeat and the event's own fields (#1173 wave 2)
//!
//! Repeat offers the presets and Custom. Custom opens a sheet over a WORKING
//! rule ([`custom`], [`repeat`]): frequency, every N, weekdays, the monthly
//! mode (days of the month, or "the second Tuesday") and the end, over a live
//! sentence. Done writes a whole rule to the draft (`repeat_rule`); a rule the
//! vault's editor seam cannot show opens read-only, with a choice to replace
//! it. A task takes the same sheet. A new rule belongs to the whole series, so
//! on a series occurrence only that scope is offered.
//!
//! An event also edits its place (chosen from the vault's places), a second
//! reminder (drawn once the first is set), availability, time zone and travel
//! time, all columns the vault already holds ([`fields`]). The zone is the
//! wall clock's: an event in another zone opens in ITS clock, and a zone picked
//! keeps the clock and moves the instant. A task has an address instead.
//!
//! ## The add sheet is Event | Task (#1128)
//!
//! A CREATE carries a switch at its top; an edit has none. ONE DRAFT SERVES
//! BOTH: the title and the day carry over a switch, and a task reads its due
//! from the start fields (the start day, and the start time unless "All day" is
//! on; a task opens All day, a bare date). Everything else is an event's alone,
//! and the events for it are ignored while a task is added.
//!
//! The kind the sheet opens on is the one the route names, else the kind the
//! member last ADDED on this device: a per-device habit kept in the keychain
//! (an event is stored as absence), read on opening and written when an add
//! COMMITS. A sheet left unsaved, or a refused write, changes nothing.
//!
//! A write answers at once, so a committed Save sets `dismissed` and the screen
//! ignores everything after it: the core remembers no key, and a second Save
//! would file the event again.

pub(super) mod custom;
pub(super) mod draft;
mod fields;
pub mod repeat;
pub mod write;

use centraid_api_proto::core_v1 as wire;
use wire::agenda_editor_event::Kind as K;
use wire::agenda_editor_state::{Asking, Mode, Sheet};
use wire::app_query_response::Answer;
use wire::screen_event::Kind as E;

use self::draft::{
    Draft, LIST_INBOX, PRIORITY_MAX, REMINDER_NONE, REPEAT_BIWEEKLY, REPEAT_CUSTOM, REPEAT_DAILY,
    REPEAT_MONTHLY, REPEAT_NONE, REPEAT_WEEKLY, REPEAT_YEARLY, RULES,
};
use super::event::{
    calendar_hue, is_series_occurrence, long_day, person_hue, reminder_label, scope_word, scopes,
};
use super::rule_words;
use super::todo::ops::{NewTask, Ops};
use super::todo::rows;
use crate::catalog::{act, load};
use crate::kit::act::{self as kit_act, Settled};
use crate::kit::civil::{self, HourCycle};
use crate::kit::read::{self as kit_read, Reading};
use crate::screen::{Ctx, Screen};
use crate::strings::{
    Locale, agenda as words, agenda_editor as editor_words, agenda_repeat as repeat_words,
    agenda_tasks as task_words, fill, task as task_strings,
};

/// The keychain key of the kind the member last added on this device.
pub const ADD_KIND_KEY: &str = "agenda_add_kind";
const TASK_WORD: &[u8] = b"task";

/// The editor reads calendars and the clock, never events: a window the vault
/// has no event in (the epoch's first second) answers both and nothing else.
const CALENDARS_ONLY: (&str, &str) = ("1970-01-01T00:00:00Z", "1970-01-01T00:00:01Z");

/// The Inbox's dot: a neutral list colour, since the Inbox is no one's project.
const INBOX_HUE: &str = "graphite";

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
    // ONLY A CREATE CAN BE A TASK; anything unnamed is an event.
    let named =
        wire::AgendaEditorKind::try_from(args.kind).unwrap_or(wire::AgendaEditorKind::Unspecified);
    let kind = if create && named == wire::AgendaEditorKind::Task {
        wire::AgendaEditorKind::Task
    } else {
        wire::AgendaEditorKind::Event
    };
    Some(Box::new(Editor {
        mode: if create { Mode::Create } else { Mode::Edit },
        kind,
        kind_decided: !create || named != wire::AgendaEditorKind::Unspecified,
        kind_pending: false,
        route: args,
        phase: Phase::Loading,
        loaded: None,
        baseline: None,
        draft: None,
        sheet: Sheet::None,
        more_open: false,
        custom: None,
        place_query: String::new(),
        typed_place: String::new(),
        zone_query: String::new(),
        asking: Asking::None,
        scope: None,
        save_tried: false,
        status: None,
        dismissed: false,
        ops: Ops::default(),
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
    /// The projects a task can be filed in; empty when the read did not land,
    /// and then the Inbox is the one list.
    projects: Vec<wire::AgendaTaskProject>,
    /// The vault's places an event can be at; empty when the read did not land,
    /// and then an event has no place to choose.
    places: Vec<fields::Place>,
}

struct Editor {
    route: wire::AgendaEditorRoute,
    mode: Mode,
    kind: wire::AgendaEditorKind,
    /// The route or the member chose the kind: the device's memory no longer applies.
    kind_decided: bool,
    /// The device's memory has been asked for and has not answered.
    kind_pending: bool,
    phase: Phase,
    loaded: Option<Loaded>,
    /// The values as loaded: what "changed" is measured against.
    baseline: Option<Draft>,
    draft: Option<Draft>,
    sheet: Sheet,
    /// The More details row is open (a new task).
    more_open: bool,
    /// The Custom repeat sheet's working rule, while it is open.
    custom: Option<custom::Custom>,
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
    status: Option<wire::StatusLine>,
    dismissed: bool,
    /// The to-do write law, for a task add.
    ops: Ops,
}

impl Editor {
    fn is_task(&self) -> bool {
        self.kind == wire::AgendaEditorKind::Task
    }

    // -- reads ------------------------------------------------------------

    /// Read calendars, people and (for an edit) the event. A re-read keeps the
    /// draft: a change elsewhere never overwrites what the member is typing.
    fn reload(&mut self, ctx: &Ctx) {
        let upcoming = kit_read::read(
            ctx,
            load::agenda::Upcoming {
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
            load::agenda::Parties::default(),
            |answer| match answer {
                Answer::AgendaParties(parties) => Some(parties),
                _ => None,
            },
        );
        // AN EDIT READS ITS EVENT BY ID: a search hit on a repeating event is the
        // series row, which no window lists. Absent there is gone.
        let detail = (self.mode == Mode::Edit).then(|| self.read_event(ctx));
        // THE LISTS A TASK CAN LAND IN: a refused or missing read leaves the Inbox.
        let projects = if self.is_task() || self.mode == Mode::Create {
            match kit_read::read(
                ctx,
                load::agenda::Projects::default(),
                |answer| match answer {
                    Answer::AgendaTaskProjects(projects) => Some(projects),
                    _ => None,
                },
            ) {
                Reading::Data(projects) => projects.projects,
                _ => Vec::new(),
            }
        } else {
            Vec::new()
        };
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
            // A re-read that failed keeps the draft; only a first read has nothing else to show.
            if self.draft.is_none() {
                self.phase = Phase::Failed;
            }
            return;
        };
        let places = fields::read_places(ctx);
        self.loaded = Some(Loaded {
            upcoming,
            parties,
            detail,
            projects,
            places,
        });
        self.phase = Phase::Ready;
        if self.draft.is_none() {
            self.baseline = match self.mode {
                Mode::Edit => self.event().map(draft::draft_of),
                _ => self.loaded.as_ref().map(|loaded| {
                    let named = draft::new_draft(&self.route.day, &loaded.upcoming);
                    // A SLOT PRESSED ON THE GRID names the start; the end follows by an hour.
                    let fresh = Draft {
                        zone: ctx.zone().to_owned(),
                        ..draft::starting_at(&named, &self.route.start_time)
                    };
                    if self.is_task() {
                        draft::shaped(&fresh, self.kind)
                    } else {
                        fresh
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
            let mut request: wire::LoadRequest = load::agenda::Event {
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
            self.status = None;
        }
    }

    fn close_sheet(&mut self) {
        self.sheet = Sheet::None;
        self.scope = None;
        self.custom = None;
        self.place_query.clear();
        self.zone_query.clear();
    }

    fn set_kind(&mut self, kind: wire::AgendaEditorKind) {
        self.kind = kind;
        self.baseline = self.baseline.as_ref().map(|d| draft::shaped(d, kind));
        self.draft = self.draft.as_ref().map(|d| draft::shaped(d, kind));
    }

    /// THE SWITCH. Only a CREATE has one, and not after it committed. The title
    /// and the day stay; the draft AND its baseline are reshaped together, so a
    /// switch alone is never a change the member is asked to discard.
    fn pick_kind(&mut self, kind: wire::AgendaEditorKind) {
        let known = matches!(
            kind,
            wire::AgendaEditorKind::Event | wire::AgendaEditorKind::Task
        );
        if self.mode != Mode::Create || !known || kind == self.kind {
            return;
        }
        self.close_sheet();
        self.kind_decided = true;
        // A REFUSAL BELONGS TO THE SAVE IT ANSWERED, not to the other kind.
        self.status = None;
        self.set_kind(kind);
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
        } else if self.is_task() {
            // A TASK NEEDS A TITLE AND A DAY, and the pickers only give days; an
            // address, when typed, must be one.
            if Self::url_refused(draft) {
                editor_words::block_url(locale)
            } else {
                String::new()
            }
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
        if !self.is_task() && !self.typed_place.trim().is_empty() {
            match self.found_typed_place(ctx) {
                Some(id) => draft.place_id = id,
                None => return Vec::new(),
            }
        }
        if self.mode == Mode::Create {
            return if self.is_task() {
                self.save_task(ctx, &draft)
            } else {
                self.save_event(ctx, &draft)
            };
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
            let request = write::edit_event(&event_id, &draft, &base, &owner_ids);
            let key = kit_act::key(&["edit-event", &event_id], kit_act::fresh());
            return self.committed(ctx, request, &key);
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
                let request = write::edit_event(&event_id, &draft, &base, &owner_ids);
                let key = kit_act::key(&["edit-event", &event_id], kit_act::fresh());
                self.committed(ctx, request, &key)
            }
            wire::AgendaScope::Occurrence | wire::AgendaScope::Future => {
                let word = scope_word(scope);
                let wire_scope = if scope == wire::AgendaScope::Future {
                    act::agenda::EditOccurrenceScope::Future
                } else {
                    act::agenda::EditOccurrenceScope::Occurrence
                };
                let request =
                    write::override_occurrence(&event_id, &occurrence, wire_scope, &draft, &base);
                let key = kit_act::key(
                    &["edit-occurrence", &event_id, &occurrence, word, "override"],
                    kit_act::fresh(),
                );
                self.committed(ctx, request, &key)
            }
            wire::AgendaScope::Unspecified => Vec::new(),
        }
    }

    fn save_event(&mut self, ctx: &Ctx, draft: &Draft) -> Vec<wire::Effect> {
        let request = write::propose(draft);
        let key = kit_act::key(&["propose", "new"], kit_act::fresh());
        self.committed(ctx, request, &key)
    }

    /// A task saves as `add-task`: the trimmed title and the due, a bare day or
    /// a floating local time.
    fn save_task(&mut self, ctx: &Ctx, draft: &Draft) -> Vec<wire::Effect> {
        let locale = ctx.locale();
        let today = self
            .loaded
            .as_ref()
            .map(|loaded| loaded.upcoming.today.clone())
            .unwrap_or_default();
        let lands = civil::relative_day(locale, &draft.start_day, &today);
        self.status = None;
        let due = draft::due_of(draft);
        let notes = draft.notes.trim();
        let rule = draft::rule_for(draft);
        let url = draft::normalize_url(&draft.url).filter(|url| !url.is_empty());
        let project = self
            .project_of(&draft.list_key)
            .map(|project| project.project_id.clone());
        let task = NewTask {
            title: draft.title.trim(),
            notes,
            due: &due,
            priority: i64::from(draft.priority.clamp(0, PRIORITY_MAX)),
            rule: rule.as_deref(),
            url: url.as_deref(),
            project_id: project.as_deref(),
            tags: &draft.tags,
            ..NewTask::default()
        };
        if self.ops.add_full(ctx, &task, &lands).is_some() {
            self.dismissed = true;
            return self.remember_kind();
        }
        self.status = self.ops.status.clone();
        Vec::new()
    }

    /// Submit a write that ends the sitting when it commits.
    fn committed(
        &mut self,
        ctx: &Ctx,
        request: impl Into<wire::ActRequest>,
        key: &str,
    ) -> Vec<wire::Effect> {
        self.status = None;
        let settled = kit_act::act(ctx, request, key);
        self.settle(&settled)
    }

    fn settle(&mut self, settled: &Settled) -> Vec<wire::Effect> {
        if settled.committed {
            self.dismissed = true;
            return if self.mode == Mode::Create {
                self.remember_kind()
            } else {
                Vec::new()
            };
        }
        self.status = Some(wire::StatusLine {
            sentence: settled.refusal.clone(),
            action_label: String::new(),
            refused: true,
        });
        Vec::new()
    }

    /// THE DEVICE REMEMBERS THE KIND OF THE LAST ADD: a task is stored, an event
    /// is the absence of the key.
    fn remember_kind(&self) -> Vec<wire::Effect> {
        let (op, value) = if self.is_task() {
            (wire::keychain_op::Op::Set, TASK_WORD.to_vec())
        } else {
            (wire::keychain_op::Op::Delete, Vec::new())
        };
        vec![keychain(op, value)]
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
            act::agenda::EditOccurrenceScope::Occurrence,
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
        self.committed(ctx, request, &key);
    }

    // -- events -----------------------------------------------------------

    fn on_editor_event(&mut self, event: K, ctx: &Ctx) -> Vec<wire::Effect> {
        // A TASK HAS NO EVENT FIELDS (#1128): their pickers are not drawn, and a
        // stray event for one changes nothing. Its own are Notes, Repeat and the
        // List and Repeat sheets (#1173); an event has none of the task's.
        let task_event = matches!(
            event,
            K::List(_)
                | K::Priority(_)
                | K::TagAdded(_)
                | K::TagRemoved(_)
                | K::MoreDetails(_)
                | K::Url(_)
        );
        if task_event && !self.is_task() {
            return Vec::new();
        }
        if self.is_task() {
            let sheet_of_a_task = |opened: &wire::agenda_editor_event::SheetOpened| {
                matches!(
                    Sheet::try_from(opened.sheet),
                    Ok(Sheet::List | Sheet::Repeat | Sheet::CustomRepeat)
                )
            };
            let stray = match &event {
                K::End(_)
                | K::Calendar(_)
                | K::Guest(_)
                | K::Reminder(_)
                | K::Link(_)
                | K::Skip(_)
                | K::PlaceSearch(_)
                | K::Place(_)
                | K::PlaceCleared(_)
                | K::SecondReminder(_)
                | K::Availability(_)
                | K::ZoneSearch(_)
                | K::Zone(_)
                | K::Travel(_) => true,
                K::SheetOpened(opened) => !sheet_of_a_task(opened),
                _ => false,
            };
            if stray {
                return Vec::new();
            }
        }
        match event {
            K::Refreshed(_) => self.reload(ctx),
            K::KindPicked(picked) => {
                let kind = wire::AgendaEditorKind::try_from(picked.kind)
                    .unwrap_or(wire::AgendaEditorKind::Unspecified);
                self.pick_kind(kind);
            }
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
            // THE NEW TASK SHEET (#1173).
            K::List(picked) => {
                if self.list_keys().contains(&picked.key) {
                    self.close_sheet();
                    self.edit(|d| {
                        Some(Draft {
                            list_key: picked.key,
                            ..d.clone()
                        })
                    });
                }
            }
            K::Priority(picked) => {
                let level = picked
                    .key
                    .parse::<i32>()
                    .ok()
                    .filter(|level| (0..=PRIORITY_MAX).contains(level));
                if let Some(priority) = level {
                    self.edit(|d| {
                        Some(Draft {
                            priority,
                            ..d.clone()
                        })
                    });
                }
            }
            K::TagAdded(added) => self.edit(|d| draft::tag_added(d, &added.text)),
            K::TagRemoved(removed) => self.edit(|d| draft::tag_removed(d, &removed.text)),
            K::MoreDetails(_) => self.more_open = !self.more_open,
            // WAVE 2 (#1173): the event's place, second alert, availability,
            // zone and travel, and a task's address.
            K::PlaceSearch(search) => self.place_query = search.text,
            K::Place(picked) => self.pick_place(&picked.key),
            K::PlaceCleared(_) => self.clear_place(),
            K::SecondReminder(picked) => self.pick_second_reminder(&picked.key),
            K::Availability(picked) => self.pick_availability(&picked.key),
            K::ZoneSearch(search) => self.zone_query = search.text,
            K::Zone(picked) => self.pick_zone(&picked.key, ctx.zone()),
            K::Travel(picked) => self.pick_travel(&picked.key),
            K::Url(change) => self.edit(|d| {
                Some(Draft {
                    url: change.text,
                    ..d.clone()
                })
            }),
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

    /// The project a task's list key names, when the read still lists it.
    fn project_of(&self, key: &str) -> Option<&wire::AgendaTaskProject> {
        self.loaded
            .as_ref()?
            .projects
            .iter()
            .find(|project| project.project_id == key)
    }

    /// The projects A to Z (case aside), the Inbox's own order being first.
    fn sorted_projects(&self) -> Vec<&wire::AgendaTaskProject> {
        let mut projects: Vec<&wire::AgendaTaskProject> = self
            .loaded
            .iter()
            .flat_map(|loaded| loaded.projects.iter())
            .collect();
        projects.sort_by_cached_key(|project| (project.name.to_lowercase(), project.sort_order));
        projects
    }

    fn list_keys(&self) -> Vec<String> {
        std::iter::once(LIST_INBOX.to_owned())
            .chain(
                self.sorted_projects()
                    .into_iter()
                    .map(|project| project.project_id.clone()),
            )
            .collect()
    }

    /// The Inbox, then each project: the list a new task lands in.
    fn lists(&self, locale: Locale, draft: &Draft) -> Vec<wire::AgendaChoice> {
        // A list that is gone files in the Inbox, and the sheet says so.
        let chosen = if self.project_of(&draft.list_key).is_some() {
            draft.list_key.as_str()
        } else {
            LIST_INBOX
        };
        let inbox = task_strings::inbox(locale);
        std::iter::once(wire::AgendaChoice {
            key: LIST_INBOX.to_owned(),
            selected: chosen == LIST_INBOX,
            hue_key: INBOX_HUE.to_owned(),
            accessibility_label: inbox.clone(),
            label: inbox,
        })
        .chain(
            self.sorted_projects()
                .into_iter()
                .map(|project| wire::AgendaChoice {
                    key: project.project_id.clone(),
                    selected: chosen == project.project_id,
                    hue_key: rows::list_color_of(&project.project_id, Some(project)),
                    accessibility_label: project.name.clone(),
                    label: project.name.clone(),
                }),
        )
        .collect()
    }

    /// None, !, !!, !!!: the symbol is the label and Low, Medium, High priority the spoken name.
    fn priorities(locale: Locale, draft: &Draft) -> Vec<wire::AgendaChoice> {
        let level = draft.priority.clamp(0, PRIORITY_MAX);
        [
            (
                task_strings::priority_none(locale),
                task_strings::priority_none(locale),
            ),
            (
                task_words::priority_1(locale),
                task_words::priority_1_spoken(locale),
            ),
            (
                task_words::priority_2(locale),
                task_words::priority_2_spoken(locale),
            ),
            (
                task_words::priority_3(locale),
                task_words::priority_3_spoken(locale),
            ),
        ]
        .into_iter()
        .enumerate()
        .map(|(at, (label, spoken))| wire::AgendaChoice {
            key: at.to_string(),
            label,
            selected: i32::try_from(at).is_ok_and(|at| at == level),
            hue_key: String::new(),
            accessibility_label: spoken,
        })
        .collect()
    }

    /// The closed More details row: what is set, else what is inside.
    fn more_details_summary(&self, locale: Locale, draft: &Draft, repeat_label: &str) -> String {
        let mut parts: Vec<String> = Vec::new();
        let priority = Self::priorities(locale, draft)
            .into_iter()
            .find(|choice| choice.selected && choice.key != "0");
        parts.extend(priority.map(|choice| choice.label));
        if draft.repeat_key != REPEAT_NONE {
            parts.push(repeat_label.to_owned());
        }
        parts.extend(draft.tags.iter().map(|tag| format!("#{tag}")));
        if parts.is_empty() {
            task_words::more_details_empty(locale)
        } else {
            parts.join(" · ")
        }
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

fn keychain(op: wire::keychain_op::Op, value: Vec<u8>) -> wire::Effect {
    wire::Effect {
        kind: Some(wire::effect::Kind::Keychain(wire::KeychainOp {
            op: op as i32,
            key: ADD_KIND_KEY.to_owned(),
            value,
        })),
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
                // A CREATE THAT NAMES NO KIND opens on the device's memory.
                if self.mode == Mode::Create && !self.kind_decided && !self.kind_pending {
                    self.kind_pending = true;
                    return vec![keychain(wire::keychain_op::Op::Get, Vec::new())];
                }
                Vec::new()
            }
            Some(E::DataChanged(_) | E::EnvironmentChanged(_)) => {
                self.reload(ctx);
                Vec::new()
            }
            Some(E::EffectResult(result)) if self.kind_pending => {
                self.kind_pending = false;
                if let Some(wire::effect_result::Outcome::Keychain(value)) = result.outcome
                    && value.found
                    && value.value == TASK_WORD
                    && !self.kind_decided
                {
                    self.set_kind(wire::AgendaEditorKind::Task);
                }
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
        let content = match &self.phase {
            Phase::Loading => {
                wire::agenda_editor_state::Content::Loading(wire::Loading { first_load: true })
            }
            Phase::Failed => {
                wire::agenda_editor_state::Content::Failure(kit_read::incomplete(locale))
            }
            Phase::Denied(denial) => wire::agenda_editor_state::Content::Denied(wire::Denied {
                title: words::denied_title(locale),
                body: words::denied_body(locale),
                receipt: denial.code.clone().unwrap_or_default(),
            }),
            Phase::Ready => match &self.draft {
                Some(draft) => wire::agenda_editor_state::Content::Data(Box::new(self.data(
                    locale,
                    ctx.hour_cycle(),
                    ctx.zone(),
                    draft,
                ))),
                None => wire::agenda_editor_state::Content::Gone(wire::AgendaGone {
                    title: words::gone_title(locale),
                    body: words::gone_body(locale),
                    action_label: words::gone_action(locale),
                }),
            },
        };
        let state = wire::AgendaEditorState {
            mode: self.mode as i32,
            content: Some(content),
            sheet: self.sheet as i32,
            confirm: self.confirm(locale),
            chrome: Some(chrome(locale)),
            dismissed: self.dismissed,
            kind: self.kind as i32,
            status: self.status.clone(),
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
                title: if self.is_task() {
                    words::confirm_discard_new_task_title(locale)
                } else if self.mode == Mode::Create {
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
        let task = self.is_task();
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
        let show_event = !task;
        let timed = show_event && !draft.all_day;
        let repeat_label = repeats.iter().find(|choice| choice.selected).map_or_else(
            || words::repeat_never(locale),
            |choice| choice.label.clone(),
        );
        let (lists, priorities) = if task {
            (self.lists(locale, draft), Self::priorities(locale, draft))
        } else {
            (Vec::new(), Vec::new())
        };
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
            heading: if task {
                words::new_task(locale)
            } else if self.mode == Mode::Create {
                words::new_event(locale)
            } else {
                words::editor_edit(locale)
            },
            start_label: day_time(&draft.start_day, &draft.start_time),
            end_label: day_time(&draft.end_day, &draft.end_time),
            start_day_label: long_day(locale, &draft.start_day),
            start_time_label: if draft.all_day {
                String::new()
            } else {
                civil::time_for(locale, &draft.start_time, cycle)
            },
            end_day_label: long_day(locale, &draft.end_day),
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
            foot_note: if self.mode == Mode::Create && !task {
                words::foot_new(locale)
            } else {
                String::new()
            },
            kinds: if self.mode == Mode::Create {
                self.kinds(locale)
            } else {
                Vec::new()
            },
            show_event_fields: !task,
            start_field_label: if task {
                words::field_due(locale)
            } else {
                words::field_starts(locale)
            },
            show_task_fields: task,
            list_label: lists
                .iter()
                .find(|choice| choice.selected)
                .map(|choice| choice.label.clone())
                .unwrap_or_default(),
            list_hue_key: lists
                .iter()
                .find(|choice| choice.selected)
                .map(|choice| choice.hue_key.clone())
                .unwrap_or_default(),
            lists,
            more_details_open: task && self.more_open,
            more_details_summary: if task {
                self.more_details_summary(locale, draft, &repeat_label)
            } else {
                String::new()
            },
            location_label: if show_event {
                self.location_label(locale, draft)
            } else {
                String::new()
            },
            places: if show_event && self.sheet == Sheet::Location {
                self.place_choices(locale, draft)
            } else {
                Vec::new()
            },
            place_query: self.place_query.clone(),
            show_clear_location: show_event
                && (!draft.place_id.is_empty() || !self.typed_place.trim().is_empty()),
            show_second_reminder: show_event && draft.reminder_key != REMINDER_NONE,
            second_reminder_label: if show_event {
                self.second_reminder_choices(locale, draft)
                    .iter()
                    .find(|choice| choice.selected)
                    .map_or_else(|| words::reminder_none(locale), |c| c.label.clone())
            } else {
                String::new()
            },
            second_reminders: if show_event && draft.reminder_key != REMINDER_NONE {
                self.second_reminder_choices(locale, draft)
            } else {
                Vec::new()
            },
            availability_label: if !show_event {
                String::new()
            } else if draft.free {
                editor_words::free(locale)
            } else {
                editor_words::busy(locale)
            },
            availabilities: if show_event {
                Self::availability_choices(locale, draft)
            } else {
                Vec::new()
            },
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
            travel_label: if show_event {
                Self::travel_label(locale, draft.travel_min)
            } else {
                String::new()
            },
            travels: if show_event {
                self.travel_choices(locale, draft)
            } else {
                Vec::new()
            },
            custom_repeat: if self.sheet == Sheet::CustomRepeat {
                self.custom_sheet(locale, draft)
            } else {
                None
            },
            show_url: task,
            url_saved_as: if task {
                Self::url_saved_as(draft)
            } else {
                String::new()
            },
            priority_label: if task {
                priorities
                    .iter()
                    .find(|choice| choice.selected)
                    .map(|choice| choice.label.clone())
                    .unwrap_or_default()
            } else {
                String::new()
            },
            priorities,
        }
    }

    /// The Event | Task switch, the kind in hand marked.
    fn kinds(&self, locale: Locale) -> Vec<wire::AgendaKindChoice> {
        [
            (wire::AgendaEditorKind::Event, words::kind_event(locale)),
            (wire::AgendaEditorKind::Task, words::kind_task(locale)),
        ]
        .into_iter()
        .map(|(kind, label)| wire::AgendaKindChoice {
            kind: kind as i32,
            selected: kind == self.kind,
            accessibility_label: label.clone(),
            label,
        })
        .collect()
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
                            .and_then(|rule| repeat::from_rrule(&rule, day))
                            .map(|spec| custom::summary(locale, &spec))
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
        kind_label: words::kind_switch(locale),
        field_list: task_words::field_list(locale),
        field_more_details: task_words::field_more_details(locale),
        field_priority: task_strings::field_priority(locale),
        field_tags: task_strings::field_tags(locale),
        tag_placeholder: task_strings::tags_add(locale),
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
    }
}

/// THE BOARD'S COLOUR TILES for the event editor's rows (`EventEditorRows`): the times and the
/// calendar in Agenda's blue, the place in red, availability in the list blue, the zone and the
/// travel time in Agenda's blue too (a state colour only ever says a state) and the rest in the
/// neutral grey.
fn row_tiles() -> Vec<wire::AgendaRowTile> {
    const AGENDA: &str = "appAgenda";
    const GREY: &str = "textMeta";
    [
        ("start", "Calendar", AGENDA),
        ("end", "Clock", AGENDA),
        ("repeat", "Repeat", GREY),
        ("calendar", "CalendarBlank", AGENDA),
        ("guests", "Users", GREY),
        ("location", "MapPin", "stateRed"),
        ("reminder", "Bell", GREY),
        ("second_reminder", "Bell", GREY),
        ("availability", "Check", "listBlue"),
        ("zone", "Globe", AGENDA),
        ("travel", "Clock", AGENDA),
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
