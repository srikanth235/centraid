//! NOTES' TRASH: the kit's one trash screen with Notes' spec (#1015 D1).
//!
//! `delete-note` moves a note here for 30 days, `restore-note` brings it back,
//! `purge-note` (`entity.purge`) deletes one forever and `empty-trash`
//! (`entity.empty_trash`, kind note) every trashed note, each behind the kit's
//! destructive confirm (#1185: every trash can be emptied).
//!
//! The list is the core's `notes.trash`, not a page of `entity` rows: a memo (a
//! People-journal entry) must never reach this trash, and only that arm knows
//! the memo set.

use centraid_api_proto::core_v1 as wire;
use wire::app_query_response::Answer;

use super::{denied, fold};
use crate::catalog::{act, load};
use crate::kit::read::{self, Reading};
use crate::kit::trash::{self, TrashItem, TrashSpec};
use crate::screen::{Ctx, Screen};
use crate::strings::{notes as words, shared};

/// Notes' trash, as the kit's screen takes it.
pub static SPEC: TrashSpec = TrashSpec {
    app: act::notes::APP,
    icon_key: "FileText",
    noun: shared::trash_noun_note,
    purge_lead: None,
    back_label: words::title,
    denied,
    load: trashed,
    trash: |id| {
        act::notes::DeleteNote {
            note_id: id.to_owned(),
        }
        .into()
    },
    restore: |id| {
        act::notes::RestoreNote {
            note_id: id.to_owned(),
        }
        .into()
    },
    purge: |id| {
        act::notes::PurgeNote {
            note_id: id.to_owned(),
        }
        .into()
    },
    empty: || {
        act::notes::EmptyTrash {
            kind: Some(act::notes::EmptyTrashKind::Note),
            ..Default::default()
        }
        .into()
    },
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
                    noun: None,
                })
                .collect(),
        ),
        Reading::Denied(denial) => Reading::Denied(denial),
        Reading::Failed => Reading::Failed,
    }
}
