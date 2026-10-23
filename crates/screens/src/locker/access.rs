//! THE WHOLE LOCKER'S ACCESS HISTORY (#1047, Q-1047-21; the handoff's
//! `locker/access`): every unlock, reveal, copy, one-time code and export,
//! newest first, from the More sheet's Access history.
//!
//! A page with nothing to do but be read: no verb, no sheet, no write. It asks
//! the one `locker.access` query the item page asks, with NO item, so the core
//! answers every receipt — an unlock and an export among them, which no item
//! page shows — with each item and custom field named by what it is called now.
//! Behind the same wall as the item page: nothing is asked while the Locker is
//! locked and a relock wipes what was drawn.
//!
//! **Metadata only.** A receipt names the act, the item and the minute, never a
//! value, so nothing here can show a secret; the rows are the item page's own
//! (`section`), here also naming the item each is about.

use centraid_api_proto::core_v1 as wire;
use wire::app_query_response::Answer;
use wire::locker_access_event::Kind as A;
use wire::screen_event::Kind as E;

use super::shared::{self, Phase};
use super::types;
use super::wall::{Change, Wall};
use crate::catalog::load;
use crate::kit::civil;
use crate::kit::read;
use crate::screen::{Ctx, Screen};
use crate::strings::{Locale, fill, locker as words};

/// The most receipts the whole-Locker page draws.
const WINDOW: u32 = 200;

/// What a reveal or a copy names: a custom field by its label, else the cell by
/// its own name.
pub(super) fn subject(locale: Locale, entry: &wire::LockerAccessEntry, field_label: &str) -> String {
    if entry.field_id.is_empty() {
        types::label(locale, entry.columns.first().map_or("", String::as_str))
    } else if field_label.is_empty() {
        words::access_field_gone(locale)
    } else {
        field_label.to_owned()
    }
}

/// One receipt as a row. `item` is the item's name on the whole-Locker page and
/// empty on an item's own.
pub(super) fn row(
    locale: Locale,
    entry: &wire::LockerAccessEntry,
    subject: &str,
    item: &str,
) -> wire::LockerFieldRow {
    use wire::LockerAccessKind as K;
    let kind = K::try_from(entry.kind).unwrap_or(K::Unspecified);
    let act = match kind {
        K::Unlock => words::access_unlocked(locale),
        K::Export => words::access_exported(locale),
        K::Code if entry.copied => words::access_code_copied(locale),
        K::Code => words::access_code_shown(locale),
        _ if entry.copied => fill(&words::access_copied(locale), &[("field", subject)]),
        _ => fill(&words::access_revealed(locale), &[("field", subject)]),
    };
    let label = if item.is_empty() {
        act
    } else {
        fill(
            &words::access_of_item(locale),
            &[("act", &act), ("item", item)],
        )
    };
    let day = if entry.local_day.len() >= 10 {
        civil::day_month(locale, &entry.local_day)
    } else {
        String::new()
    };
    let when = [day, entry.local_time.clone()]
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" · ");
    let refused = if entry.allowed {
        String::new()
    } else {
        words::access_refused(locale)
    };
    let spoken = [label.as_str(), when.as_str(), refused.as_str()]
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(", ");
    wire::LockerFieldRow {
        key: format!("access:{}", entry.receipt_id),
        label,
        value: when,
        note: refused,
        accessibility_label: spoken,
        ..wire::LockerFieldRow::default()
    }
}

/// The section: one row per receipt, newest first, and when there are none a
/// single row saying so — an audit surface never invents a row. The note says
/// the value is never logged and where a full window ends.
pub(super) fn section(
    locale: Locale,
    access: &wire::LockerAccess,
    title: String,
    none: String,
    row_of: impl Fn(&wire::LockerAccessEntry) -> wire::LockerFieldRow,
) -> wire::LockerSection {
    let mut rows: Vec<wire::LockerFieldRow> = access.entries.iter().map(row_of).collect();
    if rows.is_empty() {
        rows.push(wire::LockerFieldRow {
            key: "access:none".to_owned(),
            label: none.clone(),
            accessibility_label: none,
            ..wire::LockerFieldRow::default()
        });
    }
    let window = if access.truncated {
        format!(
            " {}",
            fill(
                &words::access_window(locale),
                &[("n", &access.window.to_string())]
            )
        )
    } else {
        String::new()
    };
    wire::LockerSection {
        title,
        rows,
        note: format!("{}{window}", words::access_note(locale)),
    }
}

#[must_use]
pub fn build(_route: &wire::Route) -> Option<Box<dyn Screen>> {
    Some(Box::new(Access {
        wall: Wall::default(),
        phase: Phase::Loading,
    }))
}

struct Access {
    wall: Wall,
    phase: Phase<wire::LockerAccess>,
}

impl Access {
    /// EVERY OPEN READS AGAIN: a history is as old as the last look.
    fn reload(&mut self, ctx: &Ctx) {
        if !self.wall.is_open() {
            return;
        }
        self.phase = Phase::of(read::read(
            ctx,
            load::locker::Access {
                item_id: None,
                limit: WINDOW,
            },
            |answer| match answer {
                Answer::LockerAccess(access) => Some(access),
                _ => None,
            },
        ));
    }

    fn walled(&mut self, ctx: &Ctx, step: super::wall::Step) -> Vec<wire::Effect> {
        match step.change {
            Change::Opened => self.reload(ctx),
            Change::Closed => self.phase = Phase::Loading,
            Change::None => {}
        }
        step.effects
    }

    /// WHICH ITEM A ROW IS ABOUT: its title now, or "A removed item" when the
    /// vault no longer holds it (a purge takes the row and leaves the receipt).
    /// An unlock and an export name no item.
    fn item_name(locale: Locale, entry: &wire::LockerAccessEntry) -> String {
        if entry.item_id.is_empty() {
            String::new()
        } else if entry.item_title.is_empty() {
            words::access_item_gone(locale)
        } else {
            entry.item_title.clone()
        }
    }
}

impl Screen for Access {
    fn update(&mut self, event: wire::ScreenEvent, ctx: &Ctx) -> Vec<wire::Effect> {
        match event.kind {
            Some(E::Appeared(_)) => {
                let step = self.wall.appeared(ctx, false);
                self.walled(ctx, step)
            }
            Some(E::DataChanged(_) | E::EnvironmentChanged(_)) => {
                if self.wall.is_open() {
                    self.reload(ctx);
                    Vec::new()
                } else {
                    let step = self.wall.recheck(ctx);
                    self.walled(ctx, step)
                }
            }
            Some(E::LockerWall(wall)) => {
                let step = self.wall.event(ctx, wall);
                self.walled(ctx, step)
            }
            Some(E::Lifecycle(lifecycle)) => {
                let step = self.wall.lifecycle(ctx, lifecycle.foreground);
                self.walled(ctx, step)
            }
            Some(E::LockerAccess(access)) => {
                if let Some(A::Refreshed(_)) = access.kind {
                    self.reload(ctx);
                }
                Vec::new()
            }
            Some(E::EffectResult(result)) => {
                let step = self.wall.answered(ctx, &result);
                self.walled(ctx, step)
            }
            _ => Vec::new(),
        }
    }

    fn view(&self, ctx: &Ctx) -> wire::ViewState {
        let locale = ctx.locale();
        let content = if self.wall.is_open() {
            Some(match &self.phase {
                Phase::Loading => {
                    wire::locker_access_state::Content::Loading(wire::Loading { first_load: true })
                }
                Phase::Failed => wire::locker_access_state::Content::Failure(read::failure(locale)),
                Phase::Denied(denial) => {
                    wire::locker_access_state::Content::Denied(shared::denied(locale, denial))
                }
                Phase::Ready(access) => {
                    wire::locker_access_state::Content::Data(wire::LockerAccessData {
                        lede: words::access_all_lede(locale),
                        history: Some(section(
                            locale,
                            access,
                            String::new(),
                            words::access_all_none(locale),
                            |entry| {
                                row(
                                    locale,
                                    entry,
                                    &subject(locale, entry, &entry.field_label),
                                    &Self::item_name(locale, entry),
                                )
                            },
                        )),
                    })
                }
            })
        } else {
            None
        };
        wire::ViewState {
            kind: Some(wire::view_state::Kind::LockerAccess(wire::LockerAccessState {
                wall: self.wall.view(locale),
                secure: self.wall.is_open(),
                content,
                chrome: Some(wire::LockerAccessChrome {
                    title: words::access_head(locale),
                    back_label: words::app_name(locale),
                    retry: words::retry(locale),
                }),
            })),
            ..wire::ViewState::default()
        }
    }
}
