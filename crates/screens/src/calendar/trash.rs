//! CALENDAR'S TRASH: the kit's one trash screen with Calendar's spec (#1185), the reference adoption
//! of the uniform trash rule.
//!
//! `trash-event` moves an event here for 30 days (from the event page), `restore-event` brings it
//! back, `purge-event` (`entity.purge`) deletes one forever and `empty-trash` (`entity.empty_trash`,
//! kind event) every trashed event, each behind the kit's destructive confirm. A repeating event is
//! ONE event: it is in the trash whole, every occurrence with it, and one restore brings the whole
//! series back. A calendar is a row of the same shelf, called a calendar, and one restore of it brings
//! back the events that went with it. The list is the core's `calendar.trash`, not a page of `entity` rows.

use centraid_api_proto::core_v1 as wire;
use wire::app_query_response::Answer;

use crate::catalog::{act, load};
use crate::kit::read::{self, Reading};
use crate::kit::trash::{self, TrashItem, TrashSpec};
use crate::screen::{Ctx, Screen};
use crate::strings::{Locale, agenda as words, shared};

/// Calendar's trash, as the kit's screen takes it.
pub static SPEC: TrashSpec = TrashSpec {
    // A CALENDAR IS A ROW OF THE SAME SHELF: its restore and its move back are the calendar's own
    // actions, and one restore brings back the events that went with it.
    of_row: Some(|item| {
        item.noun?;
        Some((
            act::calendar::RestoreCalendar {
                calendar_id: item.id.clone(),
            }
            .into(),
            act::calendar::DeleteCalendar {
                calendar_id: item.id.clone(),
            }
            .into(),
        ))
    }),
    app: act::calendar::APP,
    icon_key: "Calendar",
    noun: shared::trash_noun_event,
    purge_lead: None,
    back_label: words::app_title,
    denied,
    load: trashed,
    trash: |id| {
        act::calendar::TrashEvent {
            event_id: id.to_owned(),
        }
        .into()
    },
    restore: |id| {
        act::calendar::RestoreEvent {
            event_id: id.to_owned(),
        }
        .into()
    },
    purge: |id| {
        act::calendar::PurgeEvent {
            event_id: id.to_owned(),
        }
        .into()
    },
    empty: || {
        act::calendar::EmptyTrash {
            kind: Some(act::calendar::EmptyTrashKind::Event),
            // The calendars in the trash go too (with the events that went with them).
            with_kind: Some(act::calendar::EmptyTrashWithKind::Calendar),
            ..Default::default()
        }
        .into()
    },
};

#[must_use]
pub fn build(_route: &wire::Route) -> Option<Box<dyn Screen>> {
    trash::build(&SPEC)
}

/// The gate drawn when the vault will not let Calendar read.
fn denied(locale: Locale, denial: &wire::AppQueryDenial) -> wire::Denied {
    wire::Denied {
        title: words::denied_title(locale),
        body: words::denied_body(locale),
        receipt: denial.code.clone().unwrap_or_default(),
    }
}

/// `calendar.trash`: the trashed events, most recently trashed first.
fn trashed(ctx: &Ctx) -> Reading<Vec<TrashItem>> {
    match read::read(
        ctx,
        load::calendar::Trash::default(),
        |answer| match answer {
            Answer::CalendarTrash(trash) => Some(trash),
            _ => None,
        },
    ) {
        Reading::Data(trash) => Reading::Data(
            trash
                .events
                .into_iter()
                .map(|row| TrashItem {
                    id: row.event_id,
                    title: row.title,
                    deleted_day: row.deleted_local_day,
                    purge_day: row.purge_local_day,
                    // A calendar on the shelf of events says what it is.
                    noun: row.calendar.then_some(shared::trash_noun_calendar as _),
                })
                .collect(),
        ),
        Reading::Denied(denial) => Reading::Denied(denial),
        Reading::Failed => Reading::Failed,
    }
}
