//! MONEY'S TRASH: the kit's one trash screen with Money as the parameter (#1185).
//!
//! `trash-transaction` (`entity.trash`) moves a line here for 30 days from its page: it leaves every
//! balance, total, recurring charge and search result, and nothing of what the bank wrote changes.
//! `restore-transaction` brings it back exactly, `purge-transaction` (`entity.purge`) deletes one
//! forever and `empty-trash` (`entity.empty_trash`, kind txn) every trashed line, each behind the
//! kit's destructive confirm. A statement imported again never brings a trashed line back (the
//! follow engine leaves what the member trashed). The list is the core's `money.trash`.

use centraid_api_proto::core_v1 as wire;
use wire::app_query_response::Answer;

use super::fold;
use crate::catalog::{act, load};
use crate::kit::read::{self, Reading};
use crate::kit::trash::{self, TrashItem, TrashSpec};
use crate::screen::{Ctx, Screen};
use crate::strings::{money as words, shared};

/// Money's trash, as the kit's screen takes it.
pub static SPEC: TrashSpec = TrashSpec {
    of_row: None,
    app: act::money::APP,
    icon_key: "Coin",
    noun: shared::trash_noun_transaction,
    purge_lead: None,
    back_label: words::app_title,
    denied: |locale, _| fold::denied(locale),
    load: trashed,
    trash: |id| {
        act::money::TrashTransaction {
            transaction_id: id.to_owned(),
        }
        .into()
    },
    restore: |id| {
        act::money::RestoreTransaction {
            transaction_id: id.to_owned(),
        }
        .into()
    },
    purge: |id| {
        act::money::PurgeTransaction {
            transaction_id: id.to_owned(),
        }
        .into()
    },
    empty: || {
        act::money::EmptyTrash {
            kind: Some(act::money::EmptyTrashKind::Txn),
            ..Default::default()
        }
        .into()
    },
};

#[must_use]
pub fn build(_route: &wire::Route) -> Option<Box<dyn Screen>> {
    trash::build(&SPEC)
}

/// `money.trash`: the trashed transactions, most recently trashed first.
fn trashed(ctx: &Ctx) -> Reading<Vec<TrashItem>> {
    match read::read(ctx, load::money::Trash::default(), |answer| match answer {
        Answer::MoneyTrash(trash) => Some(trash),
        _ => None,
    }) {
        Reading::Data(trash) => Reading::Data(
            trash
                .transactions
                .into_iter()
                .map(|row| TrashItem {
                    id: row.txn_id,
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
