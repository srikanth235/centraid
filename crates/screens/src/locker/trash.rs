//! LOCKER'S TRASH, the kit's one trash screen (#1015 D1) with Locker as its
//! parameter: 30 days with the star and the tags kept, restore, and Delete
//! forever, through the vault's own `entity.restore` and `entity.purge`
//! (confirmed): a Locker item is an entity of kind `locker_item` (#1135). Locker
//! does not ask for "Empty trash" (R-1047-K5), as no other app's trash does but
//! Docs'.
//!
//! **A trash row is a title, and a title is inside Locker**, so the read is
//! behind the Locker's own lock: while the session is closed there is no read,
//! and the gate says the Locker is locked.

use centraid_api_proto::core_v1 as wire;
use wire::app_query_response::Answer;

use crate::catalog::{act, load};
use crate::kit::read::{self, Reading};
use crate::kit::trash::{self, TrashCopy, TrashItem, TrashSpec};
use crate::screen::{Ctx, Screen};
use crate::strings::{Locale, locker as words};

/// Locker's trash, as the kit's screen takes it.
pub static SPEC: TrashSpec = TrashSpec {
    app: act::locker::APP,
    icon_key: "Key",
    copy: TrashCopy {
        purge_title: Some(words::purge_title),
        purge_body: Some(words::purge_body),
        purge_action: Some(words::purge_action),
        empty_state_body: Some(words::trash_empty_body),
        purges_on: Some(words::trash_purges_on),
        ..TrashCopy::KIT
    },
    back_label: words::app_name,
    denied,
    load: trashed,
    restore: |id| {
        act::locker::RestoreItem {
            locker_item_id: id.to_owned(),
        }
        .into()
    },
    purge: Some(|id| {
        act::locker::PurgeItem {
            locker_item_id: id.to_owned(),
        }
        .into()
    }),
    empty: None,
};

#[must_use]
pub fn build(_route: &wire::Route) -> Option<Box<dyn Screen>> {
    trash::build(&SPEC)
}

/// The gate drawn when the Locker is closed or the vault will not let it read.
fn denied(locale: Locale, denial: &wire::AppQueryDenial) -> wire::Denied {
    if denial.code.as_deref() == Some(LOCKED) {
        return wire::Denied {
            title: words::locked_sentence(locale),
            body: words::lock_body_lead(locale),
            receipt: String::new(),
        };
    }
    super::shared::denied(locale, denial)
}

const LOCKED: &str = "locker-locked";

/// `locker.trash`: the trashed items, most recently trashed first.
fn trashed(ctx: &Ctx) -> Reading<Vec<TrashItem>> {
    let open = ctx
        .locker(&wire::LockerSessionRequest {
            step: Some(wire::locker_session_request::Step::State(
                wire::LockerStateAsk::default(),
            )),
        })
        .is_ok_and(|answer| answer.state == wire::LockerSessionState::Unlocked as i32);
    if !open {
        return Reading::Denied(wire::AppQueryDenial {
            code: Some(LOCKED.to_owned()),
            message: Some(words::locked_sentence(ctx.locale())),
            revoked_at: None,
        });
    }
    match read::read(ctx, load::locker::Trash::default(), |answer| match answer {
        Answer::LockerItems(items) => Some(items),
        _ => None,
    }) {
        Reading::Data(items) => Reading::Data(
            items
                .items
                .into_iter()
                .map(|row| TrashItem {
                    id: row.item_id,
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
