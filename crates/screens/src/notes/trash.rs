//! NOTES' TRASH: the kit's one trash screen with Notes' spec (#1015 D1).
//!
//! RESTORE ONLY. Notes offers neither "Delete forever" nor "Empty trash" (the
//! shared `entity.purge` and `entity.empty_trash` exist, and this screen does
//! not ask for them), and the purge sweep erases at 30 days.
//!
//! The list is the core's `notes.trash`, not a page of `entity` rows: a memo (a
//! People-journal entry) must never reach this trash, and only that arm knows
//! the memo set.

use centraid_api_proto::core_v1 as wire;
use wire::app_query_response::Answer;

use super::{denied, fold};
use crate::catalog::{act, load};
use crate::kit::read::{self, Reading};
use crate::kit::trash::{self, TrashCopy, TrashItem, TrashSpec};
use crate::screen::{Ctx, Screen};
use crate::strings::notes as words;

/// Notes' trash, as the kit's screen takes it.
pub static SPEC: TrashSpec = TrashSpec {
    app: act::notes::APP,
    icon_key: "FileText",
    copy: TrashCopy::KIT,
    back_label: words::title,
    denied,
    load: trashed,
    restore: |id| {
        act::notes::RestoreNote {
            note_id: id.to_owned(),
        }
        .into()
    },
    purge: None,
    empty: None,
};

#[must_use]
pub fn build(_route: &wire::Route) -> Option<Box<dyn Screen>> {
    trash::build(&SPEC)
}

/// `notes.trash`: the trashed notes, newest deletion first.
fn trashed(ctx: &Ctx) -> Reading<Vec<TrashItem>> {
    let locale = ctx.locale();
    match read::read(ctx, load::notes::Trash::default(), |answer| match answer {
        Answer::NotesTrash(trash) => Some(trash),
        _ => None,
    }) {
        Reading::Data(trash) => Reading::Data(
            trash
                .notes
                .into_iter()
                .map(|row| TrashItem {
                    title: fold::title_of(locale, row.title.as_deref(), &row.preview),
                    id: row.note_id,
                    deleted_day: row.deleted_local_day,
                    purge_day: row.purge_local_day,
                })
                .collect(),
        ),
        Reading::Denied(denial) => Reading::Denied(denial),
        Reading::Failed => Reading::Failed,
    }
}
