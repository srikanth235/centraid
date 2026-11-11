//! THE KIT'S ONE TRASH SCREEN (#1015 D1: Empty trash everywhere an app can
//! destroy), the app a [`TrashSpec`] (law 2): Reminders' `reminders.trash` and every
//! other app's `<app>.trash` are this machine over their own spec.
//!
//! A list of deleted rows the spec's `load` reads, restore as a write with no
//! confirm ("{title} restored" with Undo), and purge / empty behind a
//! destructive confirm with full sentences (product-intuition/references/
//! design-behaviour.md § Controls). Every spec can restore, delete forever and
//! empty: the wording is the kit's, the app passes its noun. A refused write
//! keeps the list and says the core's sentence; the vault's own change event reloads the list after a
//! write commits, and the screen never deletes a row on a guess.
//!
//! The list is the one window the app's query answers (a manifest query is
//! bounded); the kit pages nothing.

use centraid_api_proto::core_v1 as wire;
use wire::screen_event::Kind as E;
use wire::trash_event::Kind as T;

use super::act as kit_act;
use super::civil;
use super::read::{self, Reading};
use crate::screen::{Ctx, Screen};
use crate::strings::{Locale, shared};

/// One trashed row as the app's query answered it: the days are the civil days
/// the core read in the member's zone, empty when it stated none (never a
/// slice of a UTC instant).
#[derive(Clone, Debug)]
pub struct TrashItem {
    pub id: String,
    pub title: String,
    pub deleted_day: String,
    pub purge_day: String,
    /// What this row is called when it is not what the app's spec says (a calendar on a shelf of
    /// events); `None` is the spec's own noun.
    pub noun: Option<Words>,
}

/// A sentence in a locale.
pub type Words = fn(Locale) -> String;

/// `Delete this note forever?`: the kit's title with the app's noun.
#[must_use]
pub fn purge_title(locale: Locale, noun: Words) -> String {
    shared::trash_purge_title(locale).replace("{noun}", &noun(locale))
}

/// `It leaves this vault for good. This cannot be undone.`: an app may replace
/// the first sentence with what goes with the record, and the last sentence is
/// always the kit's.
#[must_use]
pub fn purge_body(locale: Locale, lead: Option<Words>) -> String {
    format!(
        "{} {}",
        lead.map_or_else(|| shared::trash_purge_lead(locale), |lead| lead(locale)),
        shared::trash_cannot_undo(locale)
    )
}

/// `Standup moved to trash`: the status line every app says after it moves a
/// record to trash (with Undo). A record with no title is "Untitled".
#[must_use]
pub fn moved_to_trash(locale: Locale, title: &str) -> String {
    shared::trash_moved(locale).replace("{title}", &titled(locale, title))
}

/// `Standup restored`.
#[must_use]
pub fn restored(locale: Locale, title: &str) -> String {
    shared::trash_restored(locale).replace("{title}", &titled(locale, title))
}

fn titled(locale: Locale, title: &str) -> String {
    let title = title.trim();
    if title.is_empty() {
        shared::trash_untitled(locale)
    } else {
        title.to_owned()
    }
}

/// `Deleted Wed 11 March`, from the civil day the core read the deletion on in
/// the member's zone. Empty when the core stated no day.
#[must_use]
pub fn deleted_meta(locale: Locale, local_day: &str) -> String {
    day_meta(locale, shared::trash_deleted(locale), local_day)
}

/// `Erased Mon 12 October`; empty when the core stated no day.
#[must_use]
pub fn erased_meta(locale: Locale, local_day: &str) -> String {
    day_meta(locale, shared::trash_erased(locale), local_day)
}

fn day_meta(locale: Locale, verb: String, local_day: &str) -> String {
    match local_day.get(..10) {
        Some(day) => format!("{verb} {}", civil::day_month(locale, day)),
        None => String::new(),
    }
}

/// ONE APP'S TRASH, as the parameter the one trash screen takes. Every field is
/// required: every app can move a record to trash, restore it, delete it forever
/// and empty the trash, and says so in the same words (#1185).
pub struct TrashSpec {
    /// `reminders`: the app, and the prefix of the screen name `reminders.trash`.
    pub app: &'static str,
    /// The kit's glyph for a row.
    pub icon_key: &'static str,
    /// What the app's records are called in "Delete this {noun} forever?".
    pub noun: Words,
    /// The first sentence of the purge confirm, where the app has something to
    /// say about what goes with the record; `None` is the kit's own.
    pub purge_lead: Option<Words>,
    /// The back control's words: the app the trash was pushed from ("Agenda").
    pub back_label: Words,
    /// The gate drawn when the vault will not let the app read.
    pub denied: fn(Locale, &wire::AppQueryDenial) -> wire::Denied,
    /// The app's own read of its deleted rows, newest deletion first.
    pub load: fn(&Ctx) -> Reading<Vec<TrashItem>>,
    /// Put a row back in the trash (the Undo of a restore).
    pub trash: fn(&str) -> wire::ActRequest,
    /// Bring a row back.
    pub restore: fn(&str) -> wire::ActRequest,
    /// Destroy a row now.
    pub purge: fn(&str) -> wire::ActRequest,
    /// Destroy every row now.
    pub empty: fn() -> wire::ActRequest,
}

/// The registry factory for `spec`'s screen.
#[must_use]
pub fn build(spec: &'static TrashSpec) -> Option<Box<dyn Screen>> {
    Some(Box::new(Trash {
        spec,
        phase: Phase::Loading,
        status: None,
        undo: None,
        asking: Asking::Nothing,
    }))
}

enum Phase {
    Loading,
    Failed,
    Denied(wire::AppQueryDenial),
    Ready(Vec<TrashItem>),
}

enum Asking {
    Nothing,
    Purge(String),
    Empty,
}

struct Trash {
    spec: &'static TrashSpec,
    phase: Phase,
    /// A refusal's sentence, or "{title} restored" with Undo, until the next
    /// attempt.
    status: Option<wire::StatusLine>,
    /// The row a restore just brought back, which Undo puts back in the trash.
    undo: Option<(String, String)>,
    asking: Asking,
}

impl Trash {
    fn reload(&mut self, ctx: &Ctx) {
        self.phase = match (self.spec.load)(ctx) {
            Reading::Data(items) => Phase::Ready(items),
            Reading::Denied(denial) => Phase::Denied(denial),
            Reading::Failed => Phase::Failed,
        };
    }

    fn shown(&self, id: &str) -> bool {
        matches!(&self.phase, Phase::Ready(items) if items.iter().any(|item| item.id == id))
    }

    /// What a row is called on screen: its title, or the kit's "Untitled".
    fn name_of(&self, locale: Locale, id: &str) -> String {
        match &self.phase {
            Phase::Ready(items) => items
                .iter()
                .find(|item| item.id == id)
                .map(|item| item.title.trim())
                .filter(|title| !title.is_empty())
                .map_or_else(|| shared::trash_untitled(locale), str::to_owned),
            _ => shared::trash_untitled(locale),
        }
    }

    /// What a row is called in "Delete this {noun} forever?": its own word when it has one, else
    /// the app's.
    fn noun_of(&self, id: &str) -> Words {
        self.own_noun(id).unwrap_or(self.spec.noun)
    }

    /// The noun a row carries itself, when it is not what the app's spec says.
    fn own_noun(&self, id: &str) -> Option<Words> {
        match &self.phase {
            Phase::Ready(items) => items
                .iter()
                .find(|item| item.id == id)
                .and_then(|item| item.noun),
            _ => None,
        }
    }

    /// One write under a key of its own; a refusal is the status line, and
    /// either way the list is read again. Answers whether it committed.
    fn write(&mut self, ctx: &Ctx, request: wire::ActRequest, subject: &str) -> bool {
        let key = kit_act::key(&[&request.action, subject], kit_act::fresh());
        let settled = kit_act::act(ctx, request, &key);
        self.status = (!settled.committed).then(|| wire::StatusLine {
            sentence: settled.refusal,
            action_label: String::new(),
            refused: true,
        });
        self.undo = None;
        self.reload(ctx);
        settled.committed
    }

    fn confirmed(&mut self, ctx: &Ctx) {
        match std::mem::replace(&mut self.asking, Asking::Nothing) {
            Asking::Purge(id) => {
                if self.shown(&id) {
                    self.write(ctx, (self.spec.purge)(&id), &id);
                }
            }
            Asking::Empty => {
                self.write(ctx, (self.spec.empty)(), self.spec.app);
            }
            Asking::Nothing => {}
        }
    }

    /// A restore says what it did, with Undo.
    fn restore(&mut self, ctx: &Ctx, id: &str) {
        let locale = ctx.locale();
        let name = self.name_of(locale, id);
        if self.write(ctx, (self.spec.restore)(id), id) {
            self.status = Some(wire::StatusLine {
                sentence: restored(locale, &name),
                action_label: shared::trash_undo(locale),
                refused: false,
            });
            self.undo = Some((id.to_owned(), name));
        }
    }

    /// Undo of a restore: the row goes back in the trash.
    fn undone(&mut self, ctx: &Ctx) {
        let Some((id, name)) = self.undo.take() else {
            return;
        };
        let locale = ctx.locale();
        if self.write(ctx, (self.spec.trash)(&id), &id) {
            self.status = Some(wire::StatusLine {
                sentence: moved_to_trash(locale, &name),
                action_label: String::new(),
                refused: false,
            });
        }
    }

    fn event(&mut self, event: wire::TrashEvent, ctx: &Ctx) {
        match event.kind {
            Some(T::Refreshed(_)) => self.reload(ctx),
            // RESTORE ASKS NOTHING: it undoes, and undoing is not a decision.
            Some(T::Restore(tapped)) if self.shown(&tapped.id) => self.restore(ctx, &tapped.id),
            Some(T::StatusActed(_)) => self.undone(ctx),
            // DESTROYING IS ASKED FIRST, in full sentences.
            Some(T::Purge(tapped)) if self.shown(&tapped.id) => {
                self.asking = Asking::Purge(tapped.id);
            }
            Some(T::Empty(_)) if self.has_rows() => self.asking = Asking::Empty,
            Some(T::Confirmed(_)) => self.confirmed(ctx),
            Some(T::Dismissed(_)) => self.asking = Asking::Nothing,
            _ => {}
        }
    }

    fn has_rows(&self) -> bool {
        matches!(&self.phase, Phase::Ready(items) if !items.is_empty())
    }

    fn confirm(&self, locale: Locale) -> Option<wire::Confirm> {
        match self.asking {
            Asking::Nothing => None,
            Asking::Purge(ref id) => Some(wire::Confirm {
                title: purge_title(locale, self.noun_of(id)),
                // The app's lead is about the app's own records: a row with a noun of its own (a
                // list among people) takes the kit's.
                body: purge_body(
                    locale,
                    self.spec.purge_lead.filter(|_| self.own_noun(id).is_none()),
                ),
                confirm_label: shared::trash_purge(locale),
                destructive: true,
            }),
            Asking::Empty => Some(wire::Confirm {
                title: shared::trash_empty_title(locale),
                body: shared::trash_empty_body(locale),
                confirm_label: shared::trash_empty_action(locale),
                destructive: true,
            }),
        }
    }

    fn row(&self, locale: Locale, item: &TrashItem) -> wire::TrashRow {
        let meta = [
            deleted_meta(locale, &item.deleted_day),
            erased_meta(locale, &item.purge_day),
        ]
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" · ");
        wire::TrashRow {
            id: item.id.clone(),
            title: if item.title.trim().is_empty() {
                shared::trash_untitled(locale)
            } else {
                item.title.clone()
            },
            meta,
            icon_key: self.spec.icon_key.to_owned(),
            restore_label: shared::trash_restore(locale),
            purge_label: shared::trash_purge(locale),
        }
    }
}

impl Screen for Trash {
    fn update(&mut self, event: wire::ScreenEvent, ctx: &Ctx) -> Vec<wire::Effect> {
        match event.kind {
            Some(E::Appeared(_) | E::DataChanged(_) | E::EnvironmentChanged(_)) => self.reload(ctx),
            Some(E::StatusActed(_)) => self.undone(ctx),
            Some(E::Trash(trash)) => self.event(trash, ctx),
            _ => {}
        }
        Vec::new()
    }

    fn view(&self, ctx: &Ctx) -> wire::ViewState {
        let locale = ctx.locale();
        let content = match &self.phase {
            Phase::Loading => {
                wire::trash_view::Content::Loading(wire::Loading { first_load: true })
            }
            Phase::Failed => wire::trash_view::Content::Failure(read::failure(locale)),
            Phase::Denied(denial) => {
                wire::trash_view::Content::Denied((self.spec.denied)(locale, denial))
            }
            Phase::Ready(items) => wire::trash_view::Content::Data(wire::TrashData {
                rows: items.iter().map(|item| self.row(locale, item)).collect(),
                empty: Some(wire::EmptyState {
                    headline: shared::trash_empty_headline(locale),
                    body: shared::trash_empty_state_body(locale),
                    icon_key: "Trash".to_owned(),
                    ..wire::EmptyState::default()
                }),
                empty_label: if items.is_empty() {
                    String::new()
                } else {
                    shared::trash_empty_action(locale)
                },
                count_label: if items.is_empty() {
                    String::new()
                } else {
                    shared::trash_count(locale, items.len() as u64)
                },
            }),
        };
        wire::ViewState {
            kind: Some(wire::view_state::Kind::Trash(wire::TrashView {
                app_id: self.spec.app.to_owned(),
                title: shared::trash_title(locale),
                back_label: (self.spec.back_label)(locale),
                content: Some(content),
                confirm: self.confirm(locale),
                status: self.status.clone(),
            })),
            ..wire::ViewState::default()
        }
    }
}
