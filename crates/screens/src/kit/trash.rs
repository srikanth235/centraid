//! THE KIT'S ONE TRASH SCREEN (#1015 D1: Empty trash everywhere an app can
//! destroy), the app a [`TrashSpec`] (law 2): Agenda's `agenda.trash` and every
//! other app's `<app>.trash` are this machine over their own spec.
//!
//! A list of deleted rows the spec's `load` reads, restore as a write with no
//! confirm, and purge / empty behind a destructive confirm with full sentences
//! (DESIGN.md). A spec with no `purge` has NO destroy path (Docs today): the
//! screen offers restore only — no "Delete forever" and no "Empty trash" — and
//! says nothing it cannot do. A refused write keeps the list and says the
//! core's sentence; the vault's own change event reloads the list after a
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
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TrashItem {
    pub id: String,
    pub title: String,
    pub deleted_day: String,
    pub purge_day: String,
}

/// A sentence in a locale.
pub type Words = fn(Locale) -> String;

/// THE TRASH SCREEN'S WORDS, per app. Every default is the kit's shared copy;
/// an app overrides only the sentence that would be false for it (Docs'
/// "Empty trash" removes nothing, so its confirm cannot say "for good").
#[derive(Clone, Copy)]
pub struct TrashCopy {
    pub purge_title: Option<Words>,
    pub purge_body: Option<Words>,
    pub purge_action: Option<Words>,
    pub empty_title: Option<Words>,
    pub empty_body: Option<Words>,
    pub empty_action: Option<Words>,
    pub empty_headline: Option<Words>,
    pub empty_state_body: Option<Words>,
    pub untitled: Option<Words>,
    /// A `{day}` template for the erase day, or `None` to say nothing about it.
    pub purges_on: Option<Words>,
}

impl TrashCopy {
    /// The kit's own words throughout.
    pub const KIT: Self = Self {
        purge_title: None,
        purge_body: None,
        purge_action: None,
        empty_title: None,
        empty_body: None,
        empty_action: None,
        empty_headline: None,
        empty_state_body: None,
        untitled: None,
        purges_on: None,
    };

    fn pick(over: Option<Words>, kit: Words, locale: Locale) -> String {
        over.map_or_else(|| kit(locale), |words| words(locale))
    }

    #[must_use]
    pub fn purge_title(&self, locale: Locale) -> String {
        Self::pick(self.purge_title, shared::trash_purge_title, locale)
    }

    #[must_use]
    pub fn purge_body(&self, locale: Locale) -> String {
        Self::pick(self.purge_body, shared::trash_purge_body, locale)
    }

    #[must_use]
    pub fn purge_action(&self, locale: Locale) -> String {
        Self::pick(self.purge_action, shared::trash_purge, locale)
    }

    #[must_use]
    pub fn empty_title(&self, locale: Locale) -> String {
        Self::pick(self.empty_title, shared::trash_empty_title, locale)
    }

    #[must_use]
    pub fn empty_body(&self, locale: Locale) -> String {
        Self::pick(self.empty_body, shared::trash_empty_body, locale)
    }

    #[must_use]
    pub fn empty_action(&self, locale: Locale) -> String {
        Self::pick(self.empty_action, shared::trash_empty_action, locale)
    }

    #[must_use]
    pub fn empty_headline(&self, locale: Locale) -> String {
        Self::pick(self.empty_headline, shared::trash_empty_headline, locale)
    }

    #[must_use]
    pub fn empty_state_body(&self, locale: Locale) -> String {
        Self::pick(
            self.empty_state_body,
            shared::trash_empty_state_body,
            locale,
        )
    }

    #[must_use]
    pub fn untitled(&self, locale: Locale) -> String {
        Self::pick(self.untitled, shared::trash_untitled, locale)
    }

    /// `Deleted Wed 11 March`, from the civil day the core read the deletion on
    /// in the member's zone. Empty when the core stated no day.
    #[must_use]
    pub fn deleted_meta(&self, locale: Locale, local_day: &str) -> String {
        match local_day.get(..10) {
            Some(day) => format!(
                "{} {}",
                shared::trash_deleted(locale),
                civil::day_month(locale, day)
            ),
            None => String::new(),
        }
    }

    /// The app's erase clause for `local_day` (`Erased Mon 12 October`), when
    /// the app says one and the core stated the day.
    #[must_use]
    pub fn purge_meta(&self, locale: Locale, local_day: &str) -> Option<String> {
        let template = self.purges_on?(locale);
        let day = local_day.get(..10)?;
        Some(template.replace("{day}", &civil::day_month(locale, day)))
    }
}

/// ONE APP'S TRASH, as the parameter the one trash screen takes.
pub struct TrashSpec {
    /// `agenda`: the app, and the prefix of the screen name `agenda.trash`.
    pub app: &'static str,
    /// The days the sweep keeps a deleted row.
    pub purge_window_days: u32,
    /// The kit's glyph for a row.
    pub icon_key: &'static str,
    pub copy: TrashCopy,
    /// The back control's words: the app the trash was pushed from ("Agenda").
    pub back_label: Words,
    /// The gate drawn when the vault will not let the app read.
    pub denied: fn(Locale, &wire::AppQueryDenial) -> wire::Denied,
    /// The app's own read of its deleted rows, newest deletion first.
    pub load: fn(&Ctx) -> Reading<Vec<TrashItem>>,
    /// Bring a row back.
    pub restore: fn(&str) -> wire::ActRequest,
    /// Destroy a row now; `None` is an app with no destroy path.
    pub purge: Option<fn(&str) -> wire::ActRequest>,
    /// Destroy every row now; `None` is an app that cannot empty its trash.
    pub empty: Option<fn() -> wire::ActRequest>,
}

/// The registry factory for `spec`'s screen.
#[must_use]
pub fn build(spec: &'static TrashSpec) -> Option<Box<dyn Screen>> {
    Some(Box::new(Trash {
        spec,
        phase: Phase::Loading,
        status: None,
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
    /// A refusal's sentence, until the next attempt.
    status: Option<wire::StatusLine>,
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

    /// One write under a key of its own; a refusal is the status line, and
    /// either way the list is read again.
    fn write(&mut self, ctx: &Ctx, request: wire::ActRequest, subject: &str) {
        let key = kit_act::key(&[&request.action, subject], kit_act::fresh());
        let settled = kit_act::act(ctx, request, &key);
        self.status = (!settled.committed).then(|| wire::StatusLine {
            sentence: settled.refusal,
            action_label: String::new(),
            refused: true,
        });
        self.reload(ctx);
    }

    fn confirmed(&mut self, ctx: &Ctx) {
        match std::mem::replace(&mut self.asking, Asking::Nothing) {
            Asking::Purge(id) => {
                if let Some(purge) = self.spec.purge.filter(|_| self.shown(&id)) {
                    self.write(ctx, purge(&id), &id);
                }
            }
            Asking::Empty => {
                if let Some(empty) = self.spec.empty {
                    self.write(ctx, empty(), self.spec.app);
                }
            }
            Asking::Nothing => {}
        }
    }

    fn event(&mut self, event: wire::TrashEvent, ctx: &Ctx) {
        match event.kind {
            Some(T::Refreshed(_)) => self.reload(ctx),
            // RESTORE ASKS NOTHING: it undoes, and undoing is not a decision.
            Some(T::Restore(tapped)) if self.shown(&tapped.id) => {
                self.write(ctx, (self.spec.restore)(&tapped.id), &tapped.id);
            }
            // DESTROYING IS ASKED FIRST, in full sentences, and only where the
            // app can destroy at all.
            Some(T::Purge(tapped)) if self.spec.purge.is_some() && self.shown(&tapped.id) => {
                self.asking = Asking::Purge(tapped.id);
            }
            Some(T::Empty(_)) if self.spec.empty.is_some() && self.has_rows() => {
                self.asking = Asking::Empty;
            }
            Some(T::Confirmed(_)) => self.confirmed(ctx),
            Some(T::Dismissed(_)) => self.asking = Asking::Nothing,
            _ => {}
        }
    }

    fn has_rows(&self) -> bool {
        matches!(&self.phase, Phase::Ready(items) if !items.is_empty())
    }

    fn confirm(&self, locale: Locale) -> Option<wire::Confirm> {
        let copy = &self.spec.copy;
        match self.asking {
            Asking::Nothing => None,
            Asking::Purge(_) => Some(wire::Confirm {
                title: copy.purge_title(locale),
                body: copy.purge_body(locale),
                confirm_label: copy.purge_action(locale),
                destructive: true,
            }),
            Asking::Empty => Some(wire::Confirm {
                title: copy.empty_title(locale),
                body: copy.empty_body(locale),
                confirm_label: copy.empty_action(locale),
                destructive: true,
            }),
        }
    }

    fn row(&self, locale: Locale, item: &TrashItem) -> wire::TrashRow {
        let copy = &self.spec.copy;
        let meta = [
            Some(copy.deleted_meta(locale, &item.deleted_day)).filter(|meta| !meta.is_empty()),
            copy.purge_meta(locale, &item.purge_day),
        ]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join(" · ");
        wire::TrashRow {
            id: item.id.clone(),
            title: if item.title.trim().is_empty() {
                copy.untitled(locale)
            } else {
                item.title.clone()
            },
            meta,
            icon_key: self.spec.icon_key.to_owned(),
            restore_label: shared::trash_restore(locale),
            purge_label: if self.spec.purge.is_some() {
                copy.purge_action(locale)
            } else {
                String::new()
            },
        }
    }
}

impl Screen for Trash {
    fn update(&mut self, event: wire::ScreenEvent, ctx: &Ctx) -> Vec<wire::Effect> {
        match event.kind {
            Some(E::Appeared(_) | E::DataChanged(_) | E::EnvironmentChanged(_)) => self.reload(ctx),
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
                    headline: self.spec.copy.empty_headline(locale),
                    body: self.spec.copy.empty_state_body(locale),
                    ..wire::EmptyState::default()
                }),
                empty_label: if self.spec.empty.is_some() && !items.is_empty() {
                    self.spec.copy.empty_action(locale)
                } else {
                    String::new()
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
