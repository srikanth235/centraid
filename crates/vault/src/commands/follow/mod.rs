//! Following: a store the phone owns (its contacts, a calendar, a folder of
//! files, the health store) or a statement a member imports, kept in step with
//! the vault without ever overwriting what the member did.
//!
//! **The merge is the vault's, in this one module**
//! ([#1135](https://github.com/srikanth235/centraid/issues/1135)). The
//! follower on the phone reads a store and sends records (an external id, an
//! origin, the fields the system owns) through one command per system,
//! `follow.<system>`. For each field the system owns:
//!
//! - if the vault's value equals what the source last **stated**, the member
//!   never changed it and the new value is written;
//! - if it differs, the member's value stands;
//!
//! and then `source.stated` becomes the new statement. A field made of items (a
//! contact's points, an event's guests, a series' days) follows the same rule **per
//! item**: an item the member has not changed takes the source's word, including its
//! removal; one they changed, added or removed stands
//! ([#1183](https://github.com/srikanth235/centraid/issues/1183)). A field is "edited" only
//! while the vault's value differs from the statement, so it follows again by itself once
//! they are equal. [`differences`] reads, per call, where a field differs from what the
//! source said, and `follow.take_stated` copies the stated value back. A record that is new is
//! **matched** first, by the system's match key (a name; a title and a start; a
//! file name; a workout kind and its start) against rows nothing follows yet,
//! and only then added. What a record gone from a *complete* read does is the
//! system's ([`Gone`]): contacts, events and files trash the row if the member
//! never edited it and otherwise forget the source and keep the row (R-FP-3);
//! the health store's workouts always keep the row and forget the source
//! (R-1129-14); a statement line is never removed. There is no fingerprint and
//! no detach.
//!
//! **Four guards, one each for the whole engine** ([#1146](https://github.com/srikanth235/centraid/issues/1146)):
//!
//! - *The owner is nobody's record.* A match never lands on the vault's owner,
//!   the owner never gains a source, and nothing takes the owner to the trash
//!   ([`entity::is_self`] is the one question all of them ask).
//! - *A read that lost most of what the vault follows is doubted.* A complete
//!   read that no longer holds at least [`DOUBTED_AT_LEAST`] of an origin's
//!   followed rows, and more than half of them, looks like a sync glitch (a
//!   calendar not yet downloaded, an unmounted card), not a mass delete: nothing
//!   is trashed or forgotten for it and the answer says how many rows it doubts
//!   (`doubted`). Contacts, events and files are all judged here and nowhere else.
//! - *What the follower trashed for a record's absence comes back with the
//!   record.* The source remembers when it trashed the row (`gone_at`); the same
//!   record in a later read restores the row if the member has not touched it.
//!   What the member trashed stays trashed.
//! - *Tombstones are found and forgotten.* A record another phone states is
//!   matched against the first phone's tombstones as well as its rows (a purged
//!   row is never revived under a new name), and a tombstone whose record is gone
//!   from a complete read goes with it.
//!
//! **A system's map is data** ([`SystemMap`]): which kind it fills, which
//! scalar columns it owns, what a new row needs that no record states, whether
//! a record's absence may take its row away. The engine knows no system by
//! name. The maps below carry the scalar columns of each system's kind row; the
//! rows that hang off them (a contact's points, an event's attendees, a
//! workout's measures) are added by the lane that owns the kind.

mod commands;
mod merge;
mod systems;

use std::collections::BTreeMap;

use rusqlite::Connection;
use serde_json::{Map, Value as Json};

use crate::commands::CommandCtx;
use crate::error::Result;
use crate::model::Kind;

pub(crate) use commands::system_of;
pub use commands::{Difference, ItemDifference, definitions, differences};
pub use merge::apply;
pub use systems::SYSTEMS;

/// The origin a batch of records came from, as a map's defaults see it.
pub struct OriginRow {
    pub id: String,
    /// The calendar, folder or account this origin feeds.
    pub fills: Option<String>,
    /// The phone that last read it.
    pub device: Option<String>,
}

/// What a new row needs that no record states, given its origin.
pub type Defaults =
    fn(&Connection, &OriginRow) -> Result<Vec<(&'static str, rusqlite::types::Value)>>;

/// What an origin is told about the thing it fills, each pass.
pub struct Home<'a> {
    pub origin: &'a str,
    /// What the origin fills now; none for a new origin.
    pub fills: Option<&'a str>,
    /// The origin's label before this pass, when it had one.
    pub was: Option<&'a str>,
    pub label: &'a str,
    /// The colour the phone paints the store with, as the wheel names it.
    pub color: Option<&'a str>,
}

/// Found or keep the thing an origin fills (a followed calendar), and answer its id.
pub type Founds = fn(&CommandCtx<'_, '_>, &Home<'_>) -> Result<String>;

/// A field that is not a column but rows that hang off the one it fills (a
/// contact's points), kept by the module that owns them. A record states it as
/// one JSON value like any other field; the vault reads it back the same way,
/// and merges it with the member's changes by whatever rule suits its rows.
pub struct Child {
    pub name: &'static str,
    /// The value the vault holds now, in the form the source states it.
    pub read: fn(&Connection, &str) -> Result<Json>,
    /// A value in one form whatever its spelling, so two statements of the same
    /// rows compare equal.
    pub canon: fn(&Json) -> Json,
    /// Apply what the source says now, given what it said last (`None`: it has
    /// not spoken for this row before). Returns whether anything changed.
    pub merge: fn(&CommandCtx<'_, '_>, &str, Option<&Json>, &Json) -> Result<bool>,
    /// The items a canonical value is made of, each under the key that names it across
    /// statements (a point's kind and reach key, a guest's email, a measure's column), for a
    /// child whose items the member changes one at a time. `None` for a child that is judged
    /// whole ([`differences`] then reports the field as one).
    pub items: Option<Items>,
    /// Make the rows what the source last stated (`stated`, as stated): the one item named by the
    /// key, or all of them. The same writes the merge makes, forced. Returns whether anything
    /// changed.
    pub take: Take,
    /// Note, in the statement the source link keeps, what a merge of the child depended on and
    /// the statement alone cannot say (a guest's person at the time it was merged), so the next
    /// merge judges the member's changes against what was applied then and not against what is
    /// true now. Given the statement the child last had, the value now, and whether this pass
    /// merged the child (an unchanged child keeps what was noted). `None` for a child with
    /// nothing to note.
    pub stamp: Option<Stamp>,
}

/// See [`Child::stamp`].
pub type Stamp = fn(&Connection, Option<&Json>, &Json, bool) -> Result<Json>;

/// See [`Child::take`].
pub type Take = fn(&CommandCtx<'_, '_>, &str, Option<&str>, &Json) -> Result<bool>;

/// See [`Child::items`].
pub type Items = fn(&Json) -> BTreeMap<String, Json>;

/// What a record gone from a complete read does to its row.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Gone {
    /// Trash the row if the member never edited it; else forget the source and
    /// keep the row (R-FP-3).
    Trash,
    /// Forget the source and keep the row, edited or not: the vault is the
    /// copy that outlives the phone's store (R-1129-14).
    Forget,
    /// Nothing: a record's absence says nothing (a statement line is never
    /// removed, a month later's statement does not hold this month's).
    Keep,
}

/// One field of a record that identifies a row nothing follows yet.
#[derive(Debug, Clone, Copy)]
pub enum Match {
    /// The entity's title, without regard to case.
    Title,
    /// A column of the kind's own row, exactly.
    Column(&'static str),
    /// A column holding an instant, to the minute (`YYYY-MM-DDTHH:MM`): a phone
    /// that re-reads a workout may state the seconds differently.
    Minute(&'static str),
}

impl Match {
    /// The record field this key reads.
    const fn field(self) -> &'static str {
        match self {
            Self::Title => "title",
            Self::Column(name) | Self::Minute(name) => name,
        }
    }
}

/// What an origin of a system is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OriginOf {
    /// A store on a phone (an account of the address book, a calendar, a folder, the
    /// health store): named by the ref the phone gives it, and its records are a
    /// phone's, so they say which phone.
    Phone,
    /// An account's statements: **one origin per account**, whatever ref an import
    /// names, and no phone is named anywhere (a statement is not a phone store).
    Account,
}

/// The fewest followed rows a complete read must lose before it is doubted.
pub const DOUBTED_AT_LEAST: usize = 5;

/// One system, as data.
pub struct SystemMap {
    /// The `origin.system` CHECK's word, and the command's suffix.
    pub system: &'static str,
    pub command: &'static str,
    /// The kind of entity this system fills.
    pub kind: Kind,
    /// The kind an origin's `fills` must be, when it has one.
    pub fills: Option<Kind>,
    /// Whose origin it is.
    pub origin: OriginOf,
    /// The field naming bytes the command claims in its own commit (a record
    /// then says their `size`), so no step between staging and naming leaves them
    /// unreferenced.
    pub claims: Option<&'static str>,
    /// The columns of the kind's own table the system owns. `title` is always
    /// owned, and is the entity's.
    pub fields: &'static [&'static str],
    /// The fields (`title` among them) that are written when a row is added and
    /// never after: a statement line is never edited, whatever a later
    /// statement says.
    pub fixed: &'static [&'static str],
    /// The fields that are rows of their own, after the columns.
    pub children: &'static [Child],
    /// The fields that identify a row nothing follows yet. A record missing one
    /// is not matched.
    pub match_on: &'static [Match],
    /// What a record gone from a complete read does to its row.
    pub gone: Gone,
    /// The column of the kind's own row that dates a record. A read that began at
    /// `since` speaks only for the rows dated at or after it, so an older row is
    /// not judged absent: a store read over a window knows nothing of what came
    /// before it.
    pub window: Option<&'static str>,
    pub defaults: Defaults,
    /// How an origin that fills nothing gets the thing it fills, and keeps it (one calendar of
    /// the vault per phone calendar, with the phone's colour); none when the member names it.
    pub founds: Option<Founds>,
    /// Read what a record states into the form the vault holds it (a wall clock
    /// and its zone become the instant, a store's word for a workout becomes a
    /// kind), so the statement and the row compare equal. A record it refuses is
    /// counted and left out.
    pub shape: Shape,
    /// What a row derives from what the source stated (a rule's support), run
    /// after the fields are written.
    pub settle: Settle,
    /// What a row the source has just ADDED is called, run once after its fields are written
    /// (a statement line takes the payee a rule names; a re-import never renames).
    pub named: Settle,
}

/// See [`SystemMap::shape`].
pub type Shape = fn(&CommandCtx<'_, '_>, &mut Map<String, Json>) -> std::result::Result<(), String>;

/// See [`SystemMap::settle`].
pub type Settle = fn(&CommandCtx<'_, '_>, &str) -> Result<()>;
