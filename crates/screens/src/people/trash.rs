//! PEOPLE'S TRASH: the kit's one trash screen with People's spec (#1015 D1).
//!
//! `entity.restore` brings a person back; `entity.purge` deletes a trashed
//! person forever, with everything written about them alone that went to the
//! trash with them (a task about them stays the member's). The vault refuses it
//! while the owner is the person, and that refusal is the core's sentence on the
//! status line. There is no People action that empties the whole trash, so no
//! "Empty trash": the purge sweep erases the rest on each row's day.
//!
//! The list is the core's `people.trash` (the name lives on the party), not a
//! page of `entity` rows.

use centraid_api_proto::core_v1 as wire;
use wire::app_query_response::Answer;

use super::denied;
use crate::catalog::{act, load};
use crate::kit::read::{self, Reading};
use crate::kit::trash::{self, TrashCopy, TrashItem, TrashSpec};
use crate::screen::{Ctx, Screen};
use crate::strings::people as words;

/// The days the sweep keeps a trashed person.
const WINDOW_DAYS: u32 = 30;

/// People's trash, as the kit's screen takes it.
pub static SPEC: TrashSpec = TrashSpec {
    app: act::people::APP,
    purge_window_days: WINDOW_DAYS,
    icon_key: "User",
    copy: TrashCopy {
        purge_body: Some(words::trash_purge_body),
        purges_on: Some(words::trash_erases),
        ..TrashCopy::KIT
    },
    back_label: words::app_title,
    denied,
    load: trashed,
    restore: |id| {
        act::people::RestorePerson {
            person_id: id.to_owned(),
        }
        .into()
    },
    purge: Some(|id| {
        act::people::PurgePerson {
            person_id: id.to_owned(),
        }
        .into()
    }),
    empty: None,
};

#[must_use]
pub fn build(_route: &wire::Route) -> Option<Box<dyn Screen>> {
    trash::build(&SPEC)
}

/// `people.trash`: the trashed people, newest deletion first. A row reads
/// `Designer · Deleted Wed 11 March · Erased Mon 12 October` in the kit's meta;
/// the role is the title's companion.
fn trashed(ctx: &Ctx) -> Reading<Vec<TrashItem>> {
    match read::read(ctx, load::people::Trash::default(), |answer| match answer {
        Answer::PeopleTrash(trash) => Some(trash),
        _ => None,
    }) {
        Reading::Data(trash) => Reading::Data(
            trash
                .people
                .into_iter()
                .map(|row| TrashItem {
                    id: row.party_id,
                    title: row.name,
                    deleted_day: row.deleted_local_day,
                    purge_day: row.purge_local_day,
                })
                .collect(),
        ),
        Reading::Denied(denial) => Reading::Denied(denial),
        Reading::Failed => Reading::Failed,
    }
}
