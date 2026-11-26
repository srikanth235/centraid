//! Money: accounts, the lines in them, and the categories lines fall under.

use rusqlite::Row;

use crate::kind::{Export, Footer, KindDecl, Share, Trash, exported, plain};
use crate::read::{ParamTy, Read, ReadDecl, Shape, param, read};

use super::{Held, Trashed, trash};

fn lines(row: &Row<'_>) -> rusqlite::Result<Held> {
    Ok(Held {
        kind: "txn".to_owned(),
        count: row.get("count")?,
    })
}

/// How many live lines an account holds: the number a delete confirm names. `txn_by_account_day`.
pub const ACCOUNT_LINES: Read<Held> = read(
    ReadDecl {
        name: "money.account_lines",
        shape: Shape::Aggregate,
        sql: "SELECT count(*) AS count FROM txn t JOIN entity e ON e.id = t.id \
              WHERE t.account_id = :account AND e.deleted_at IS NULL",
        params: &[param("account", ParamTy::Id)],
        reads: &["txn"],
        across: &["entity"],
        bound: 1,
        cursor: &[],
    },
    lines,
);

/// Accounts and transactions in the trash.
pub const TRASH: Read<Trashed> = trash!("money.trash", "'account', 'txn'");

pub const READS: &[ReadDecl] = &[ACCOUNT_LINES.decl, TRASH.decl];

pub const KINDS: &[KindDecl] = &[
    KindDecl::new(
        "account",
        "money",
        "account",
        "accounts",
        Trash::Listed("money.trash"),
    )
    .holds(&["txn"], &["money.account_lines"])
    .footers(&[Footer::Linked, Footer::MentionedIn])
    .exports(Export::Within("txn"))
    .shares(Share::Never("an account's balances stay on the phone")),
    KindDecl::new(
        "txn",
        "money",
        "transaction",
        "transactions",
        Trash::Listed("money.trash"),
    )
    .takes_captures()
    .holds(&["photo", "document"], &["entity.held_counts"])
    .footers(&[
        Footer::Attachments,
        Footer::Linked,
        Footer::MentionedIn,
        Footer::Origin,
        Footer::Says,
    ])
    .exports(Export::File {
        header: "centraid.money.v1",
        format: exported,
    })
    .shares(Share::Payload(plain)),
    KindDecl::new(
        "category",
        "money",
        "category",
        "categories",
        Trash::Purged("a category is purged outright; its lines are filed under its group"),
    )
    .sits_in(&["category"]),
];
