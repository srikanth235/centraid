//! AGENDA'S TRASH: the kit's one trash screen, Agenda's to-dos as its
//! parameter (law 2).
//!
//! `delete-task` puts a task and its subtasks in the trash for 30 days,
//! `restore-task` brings back what that gesture trashed, and `purge-task`
//! destroys a trashed task and the subtasks trashed with it now (#1015 D1:
//! "Delete forever" wherever an app can destroy). There is no Agenda action
//! that empties the whole trash, so no "Empty trash": the purge sweep erases the
//! rest at 30 days, and the screen says nothing it cannot do.

use centraid_api_proto::core_v1 as wire;
use wire::app_query_response::Answer;

use crate::catalog::{act, load};
use crate::kit::read::{self, Reading};
use crate::kit::trash::{self, TrashCopy, TrashItem, TrashSpec};
use crate::screen::{Ctx, Screen};
use crate::strings::{Locale, task as words};

/// The days the sweep keeps a trashed task.
const WINDOW_DAYS: u32 = 30;

/// Agenda's trash, as the kit's screen takes it.
pub static SPEC: TrashSpec = TrashSpec {
    app: act::agenda::APP,
    purge_window_days: WINDOW_DAYS,
    icon_key: "CheckSquare",
    copy: TrashCopy {
        purge_body: Some(words::trash_purge_body),
        ..TrashCopy::KIT
    },
    back_label: words::app_title,
    denied,
    load: trashed,
    restore: |id| {
        act::agenda::RestoreTask {
            task_id: id.to_owned(),
        }
        .into()
    },
    purge: Some(|id| {
        act::agenda::PurgeTask {
            task_id: id.to_owned(),
        }
        .into()
    }),
    empty: None,
};

#[must_use]
pub fn build(_route: &wire::Route) -> Option<Box<dyn Screen>> {
    trash::build(&SPEC)
}

/// The gate drawn when the vault will not let Agenda read its tasks.
fn denied(locale: Locale, denial: &wire::AppQueryDenial) -> wire::Denied {
    wire::Denied {
        title: words::denied_title(locale),
        body: words::denied_body(locale),
        receipt: denial.code.clone().unwrap_or_default(),
    }
}

/// `agenda.trash`: the trashed tasks, most recently trashed first.
fn trashed(ctx: &Ctx) -> Reading<Vec<TrashItem>> {
    let reading = read::read(ctx, load::agenda::Trash::default(), |answer| match answer {
        Answer::TasksTrash(trash) => Some(trash),
        _ => None,
    });
    match reading {
        Reading::Data(trash) => Reading::Data(
            trash
                .tasks
                .into_iter()
                .map(|row| TrashItem {
                    id: row.task_id,
                    title: row.title,
                    deleted_day: row.deleted_local_day,
                    purge_day: row.purge_local_day,
                })
                .collect(),
        ),
        Reading::Denied(denial) => Reading::Denied(denial),
        Reading::Failed => Reading::Failed,
    }
}
