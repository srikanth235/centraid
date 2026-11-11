//! REMINDERS' TRASH: the kit's one trash screen, Reminders' to-dos as its
//! parameter (law 2).
//!
//! `delete-task` puts a task and its subtasks in the trash for 30 days,
//! `restore-task` brings back what that gesture trashed, and `purge-task`
//! destroys a trashed task and the subtasks trashed with it now (#1015 D1).
//! `empty-trash` (`entity.empty_trash`, kind task) does that to every trashed
//! task (#1185): every trash can be emptied.

use centraid_api_proto::core_v1 as wire;
use wire::app_query_response::Answer;

use crate::catalog::{act, load};
use crate::kit::read::{self, Reading};
use crate::kit::trash::{self, TrashItem, TrashSpec};
use crate::screen::{Ctx, Screen};
use crate::strings::{Locale, agenda_reminders::reminders_title, shared, task as words};

/// Reminders' trash, as the kit's screen takes it.
pub static SPEC: TrashSpec = TrashSpec {
    app: act::reminders::APP,
    icon_key: "Todo",
    noun: shared::trash_noun_task,
    purge_lead: Some(words::trash_purge_lead),
    back_label: reminders_title,
    denied,
    load: trashed,
    trash: |id| {
        act::reminders::DeleteTask {
            task_id: id.to_owned(),
        }
        .into()
    },
    restore: |id| {
        act::reminders::RestoreTask {
            task_id: id.to_owned(),
        }
        .into()
    },
    purge: |id| {
        act::reminders::PurgeTask {
            task_id: id.to_owned(),
        }
        .into()
    },
    empty: || {
        act::reminders::EmptyTrash {
            kind: Some(act::reminders::EmptyTrashKind::Task),
            ..Default::default()
        }
        .into()
    },
};

#[must_use]
pub fn build(_route: &wire::Route) -> Option<Box<dyn Screen>> {
    trash::build(&SPEC)
}

/// The gate drawn when the vault will not let Reminders read its tasks.
fn denied(locale: Locale, denial: &wire::AppQueryDenial) -> wire::Denied {
    wire::Denied {
        title: words::denied_title(locale),
        body: words::denied_body(locale),
        receipt: denial.code.clone().unwrap_or_default(),
    }
}

/// `reminders.trash`: the trashed tasks, most recently trashed first.
fn trashed(ctx: &Ctx) -> Reading<Vec<TrashItem>> {
    let reading = read::read(
        ctx,
        load::reminders::Trash::default(),
        |answer| match answer {
            Answer::AgendaTaskTrash(trash) => Some(trash),
            _ => None,
        },
    );
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
                    noun: None,
                })
                .collect(),
        ),
        Reading::Denied(denial) => Reading::Denied(denial),
        Reading::Failed => Reading::Failed,
    }
}
