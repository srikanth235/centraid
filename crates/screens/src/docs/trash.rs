//! DOCS' TRASH: the kit's one trash screen with Docs as the parameter.
//!
//! DOCS DESTROYS, ON PHOTOS' PATH (D-1 of 2026-09-25): "Delete forever" is
//! `purge` (`entity.purge`) and "Empty trash" is `empty-trash`
//! (`entity.empty_trash`), each behind the kit's destructive confirm — the row
//! goes now and its bytes are released when nothing else names them. So the
//! kit's own sentences ("leaves this vault for good") are true here. No sweep
//! runs on the phone, so no row says when it will be erased.

use centraid_api_proto::core_v1 as wire;
use wire::app_query_response::Answer;

use crate::catalog::{act, load};
use crate::kit::read::{self, Reading};
use crate::kit::trash::{self, TrashCopy, TrashItem, TrashSpec};
use crate::screen::{Ctx, Screen};
use crate::strings::{Locale, docs as words};

/// The days a trashed document can be restored.
const WINDOW_DAYS: u32 = 30;

/// Docs' trash, as the kit's screen takes it.
pub static SPEC: TrashSpec = TrashSpec {
    app: act::docs::APP,
    purge_window_days: WINDOW_DAYS,
    icon_key: "FileText",
    copy: TrashCopy {
        empty_state_body: Some(words::trash_empty_state_body),
        ..TrashCopy::KIT
    },
    back_label: words::app_title,
    denied,
    load: trashed,
    restore: |id| {
        act::docs::Restore {
            document_id: id.to_owned(),
        }
        .into()
    },
    purge: Some(|id| {
        act::docs::Purge {
            document_id: id.to_owned(),
        }
        .into()
    }),
    empty: Some(|| {
        act::docs::EmptyTrash {
            kind: Some(act::docs::EmptyTrashKind::Document),
            ..Default::default()
        }
        .into()
    }),
};

#[must_use]
pub fn build(_route: &wire::Route) -> Option<Box<dyn Screen>> {
    trash::build(&SPEC)
}

fn denied(locale: Locale, denial: &wire::AppQueryDenial) -> wire::Denied {
    super::denied(locale, denial)
}

/// `docs.drive` on the trash shelf: the trashed documents, most recently
/// trashed first.
fn trashed(ctx: &Ctx) -> Reading<Vec<TrashItem>> {
    let reading = read::read(
        ctx,
        load::docs::Drive {
            shelf: Some("trash".to_owned()),
            ..Default::default()
        },
        |answer| match answer {
            Answer::DocsDrive(drive) => Some(drive),
            _ => None,
        },
    );
    match reading {
        Reading::Data(drive) => Reading::Data(
            drive
                .documents
                .into_iter()
                .map(|row| TrashItem {
                    id: row.document_id,
                    title: row.title,
                    deleted_day: row.trashed_local,
                    purge_day: String::new(),
                })
                .collect(),
        ),
        Reading::Denied(denial) => Reading::Denied(denial),
        Reading::Failed => Reading::Failed,
    }
}
