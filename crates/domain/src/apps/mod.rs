//! Each app declares its kinds and reads. Actions belong to kinds, and each read is confined to
//! its declared tables by the authorizer.

use rusqlite::Row;

use crate::kind::KindDecl;
use crate::read::ReadDecl;

pub mod calendar;
pub mod chat;
pub mod docs;
pub mod entity;
pub mod health;
pub mod locker;
pub mod money;
pub mod notes;
pub mod people;
pub mod photos;
pub mod reminders;
pub mod shared;

/// A row of a list: what a screen draws before it opens one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Item {
    pub id: String,
    pub title: String,
    /// The instant the list is ordered by.
    pub at: String,
}

impl Item {
    pub(crate) fn of(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            title: row.get("title")?,
            at: row.get("at")?,
        })
    }
}

/// An id and a title: a row of a person's timeline.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Titled {
    pub id: String,
    pub title: String,
}

impl Titled {
    pub(crate) fn of(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            title: row.get("title")?,
        })
    }
}

/// A row of a Trash list: only rows trashed on their own, never a capture that went with its item.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Trashed {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub deleted_at: String,
    pub purge_at: String,
    /// The row number, the order's unique last term.
    pub n: i64,
}

impl Trashed {
    pub(crate) fn of(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            kind: row.get("kind")?,
            title: row.get("title")?,
            deleted_at: row.get("deleted_at")?,
            purge_at: row.get("purge_at")?,
            n: row.get("n")?,
        })
    }
}

/// How many of one kind a holder holds.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Held {
    pub kind: String,
    pub count: i64,
}

impl Held {
    pub(crate) fn of(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            kind: row.get("kind")?,
            count: row.get("count")?,
        })
    }
}

/// A Trash list over the kinds named, as `'a', 'b'`: `entity_trashed` in the order the trash is
/// emptied, newest first, ending in the row number.
macro_rules! trash {
    ($name:literal, $kinds:literal) => {
        $crate::read::read(
            $crate::read::ReadDecl {
                name: $name,
                shape: $crate::read::Shape::PagedList,
                sql: concat!(
                    "SELECT id, kind, title, deleted_at, purge_at, n \
                     FROM entity INDEXED BY entity_trashed \
                     WHERE deleted_at IS NOT NULL AND trashed_by IS NULL AND kind IN (",
                    $kinds,
                    ") AND (deleted_at, n) < (:a, :b) \
                     ORDER BY deleted_at DESC, n DESC LIMIT :n"
                ),
                params: &[],
                reads: &["entity"],
                across: &[],
                bound: $crate::read::DEFAULT_PAGE,
                cursor: &[
                    $crate::read::desc("deleted_at", "a"),
                    $crate::read::desc("n", "b"),
                ],
            },
            $crate::apps::Trashed::of,
        )
    };
}
pub(crate) use trash;

/// Every read the apps declare.
pub const READS: &[ReadDecl] = crate::concat_slices!(
    ReadDecl, entity::STARRED_DECL;
    calendar::READS,
    chat::READS,
    docs::READS,
    entity::READS,
    health::READS,
    locker::READS,
    money::READS,
    notes::READS,
    people::READS,
    photos::READS,
    reminders::READS,
    shared::READS,
);

/// Every kind the apps declare.
pub const KINDS: &[KindDecl] = crate::concat_slices!(
    KindDecl, calendar::KINDS[0];
    calendar::KINDS,
    docs::KINDS,
    health::KINDS,
    locker::KINDS,
    money::KINDS,
    notes::KINDS,
    people::KINDS,
    photos::KINDS,
    reminders::KINDS,
    shared::KINDS,
);
