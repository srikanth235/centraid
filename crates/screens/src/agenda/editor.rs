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

mod draft;
mod write;

use centraid_api_proto::core_v1 as wire;
use wire::agenda_editor_event::Kind as K;
use wire::agenda_editor_state::{Asking, Mode, Sheet};
use wire::app_query_response::Answer;
use wire::screen_event::Kind as E;

use self::draft::{
    Draft, REMINDER_NONE, REMINDERS, REPEAT_BIWEEKLY, REPEAT_CUSTOM, REPEAT_DAILY, REPEAT_MONTHLY,
    REPEAT_NONE, REPEAT_WEEKLY, REPEAT_YEARLY, RULES,
};
use super::event::{
    calendar_hue, is_series_occurrence, long_day, person_hue, reminder_label, scope_word, scopes,
};
use super::todo::ops::Ops;
use crate::catalog::{act, load};
use crate::kit::act::{self as kit_act, Settled};
use crate::kit::civil;
use crate::kit::read::{self as kit_read, Reading};
use crate::screen::{Ctx, Screen};
use crate::strings::{Locale, agenda as words, agenda_editor as editor_words, fill};

/// The keychain key of the kind the member last added on this device.
pub const ADD_KIND_KEY: &str = "agenda_add_kind";
const TASK_WORD: &[u8] = b"task";

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
        let detail = (self.mode == Mode::Edit).then(|| {
            kit_read::read(
                ctx,
                load::agenda::Event {
                    event_id: self.route.event_id.clone(),
                    instance_key: Some(self.route.instance_key.clone())
                        .filter(|key| !key.is_empty()),
                    original_start_local: self
                        .route
                        .original_start_local
                        .clone()
                        .filter(|key| !key.is_empty()),
                },
                |answer| match answer {
                    Answer::AgendaEvent(detail) => Some(*detail),
                    _ => None,
                },
            )
        });
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
        self.loaded = Some(Loaded {
            upcoming,
            parties,
            detail,
        });
        self.phase = Phase::Ready;
        if self.draft.is_none() {
            self.baseline = match self.mode {
                Mode::Edit => self.event().map(draft::draft_of),
                _ => self.loaded.as_ref().map(|loaded| {
                    let fresh = draft::new_draft(&self.route.day, &loaded.upcoming);
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
            (Some(draft), Some(base)) => draft::dirty(draft, base),
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
            // A TASK NEEDS A TITLE AND A DAY, and the pickers only give days.
            String::new()
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
        let (Some(draft), Some(base)) = (self.draft.clone(), self.baseline.clone()) else {
            return Vec::new();
        };
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
        let zone = ctx.zone().to_owned();
        if !self.is_series_edit() {
            let request = write::edit_event(&event_id, &draft, &base, &zone, &owner_ids);
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
                let request = write::edit_event(&event_id, &draft, &base, &zone, &owner_ids);
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
                let request = write::override_occurrence(
                    &event_id,
                    &occurrence,
                    wire_scope,
                    &draft,
                    &base,
                    &zone,
                );
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
        let request = write::propose(draft, ctx.zone());
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
        if self.ops.add(
            ctx,
            draft.title.trim(),
            &draft::due_of(draft),
            &lands,
            None,
            None,
        ) {
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
        // stray event for one changes nothing.
        if self.is_task()
            && matches!(
                event,
                K::Notes(_)
                    | K::End(_)
                    | K::Calendar(_)
                    | K::Guest(_)
                    | K::Repeat(_)
                    | K::Reminder(_)
                    | K::Link(_)
                    | K::SheetOpened(_)
                    | K::Skip(_)
            )
        {
            return Vec::new();
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
            K::AllDay(change) => self.edit(|d| Some(draft::all_day(d, change.on))),
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
                if self.repeat_keys().contains(&picked.key) {
                    self.close_sheet();
                    self.edit(|d| {
                        Some(Draft {
                            repeat_key: picked.key,
                            ..d.clone()
                        })
                    });
                }
            }
            K::Reminder(picked) => {
                if self.reminder_keys().contains(&picked.key) {
                    self.close_sheet();
                    self.edit(|d| {
                        Some(Draft {
                            reminder_key: picked.key,
                            ..d.clone()
                        })
                    });
                }
            }
            K::SheetOpened(opened) => {
                let sheet = Sheet::try_from(opened.sheet).unwrap_or(Sheet::Unspecified);
                if !matches!(sheet, Sheet::Unspecified | Sheet::Scope) && self.draft.is_some() {
                    self.sheet = sheet;
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
        if self
            .baseline
            .as_ref()
            .is_some_and(|base| base.repeat_key == REPEAT_CUSTOM)
        {
            keys.push(REPEAT_CUSTOM.to_owned());
        }
        keys
    }

    fn reminder_keys(&self) -> Vec<String> {
        let stored = self
            .baseline
            .as_ref()
            .and_then(|base| base.reminder_key.parse::<i64>().ok());
        let mut minutes: Vec<i64> = REMINDERS.iter().copied().chain(stored).collect();
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
        let rule_changed = draft.repeat_key != base.repeat_key;
        let whole_event_only = draft::series_only(draft, base);
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
                Some(draft) => {
                    wire::agenda_editor_state::Content::Data(Box::new(self.data(locale, draft)))
                }
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
            asking: self.asking as i32,
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

    fn data(&self, locale: Locale, draft: &Draft) -> wire::AgendaEditorData {
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
                let label = self.repeat_label(locale, &key, &draft.start_day);
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
                    &[("day", &long_day(locale, day)), ("time", time)],
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
                draft.start_time.clone()
            },
            end_day_label: long_day(locale, &draft.end_day),
            end_time_label: if draft.all_day {
                String::new()
            } else {
                draft.end_time.clone()
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
            repeat_label: repeats.iter().find(|choice| choice.selected).map_or_else(
                || words::repeat_never(locale),
                |choice| choice.label.clone(),
            ),
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
    fn repeat_label(&self, locale: Locale, key: &str, day: &str) -> String {
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
            REPEAT_CUSTOM => self
                .event()
                .and_then(|event| event.recurrence_summary.clone())
                .unwrap_or_else(|| words::field_repeat(locale)),
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
        field_starts: words::field_starts(locale),
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
    }
}
