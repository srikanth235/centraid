//! Following: a store the phone owns (its contacts, a calendar, a folder of files, the health
//! store, the camera roll) or a statement a member imports, kept in step with the vault without
//! ever overwriting what the member did.
//!
//! **What a system is comes from the file, not from this crate.** Which systems exist, the kind
//! of home a follow of each fills, whether stopping it retires the origin, whether it names a
//! device and which kinds of record it yields are rows of `origin_system` and `source_shape`
//! (A1, A10, A11). No list or match in Rust names a system, or a system and kind pair, to decide
//! them: the engine reads the rows, and the database refuses what they forbid. What a map adds is
//! only what a lookup cannot say: which fields of the kind a system states and how a record of it
//! reads.
//!
//! **The merge is the vault's, in this one module**
//! ([#1135](https://github.com/srikanth235/centraid/issues/1135)). The follower on the phone reads
//! a store and sends records (an external id, an origin, the fields the system owns) through one
//! command per map, `follow.<…>`. For each field the system owns:
//!
//! - if the vault's value equals what the source last **stated**, the member never changed it and
//!   the new value is written;
//! - if it differs, the member's value stands (nothing refuses the edit; the detail screen says
//!   "Phone says X" from [`differences`]);
//!
//! and then `source.stated` becomes the new statement. **A record may be stated by several
//! sources** (A9: `source` is 1:N on the entity, a merged person keeps every one it had), and each
//! pass compares against the `stated` of the source it came through, never another's. A field made
//! of items (a contact's points, an event's guests, a series' days) follows the same rule **per
//! item**. A field is "edited" only while the vault's value differs from the statement, so it
//! follows again by itself once they are equal. A record that is new is **matched** first, by the
//! map's match key (a name; a title and a start; a file name) against rows nothing follows yet,
//! and only then added. What a record gone from a *complete* read does is the map's ([`Gone`]).
//!
//! **Every pass commits as the store** ([`crate::history::Actor::Store`], B4): the revisions it
//! writes say `store` and name the origin, whatever command carried it. Nothing infers that from a
//! command's name.
//!
//! **Four guards, one each for the whole engine** ([#1146](https://github.com/srikanth235/centraid/issues/1146)):
//!
//! - *The owner is nobody's record.* A match never lands on the vault's owner, the owner never
//!   gains a source (the database refuses it too) and nothing takes the owner to the trash.
//! - *A read that lost most of what the vault follows is doubted.* A complete read that no longer
//!   holds at least [`DOUBTED_AT_LEAST`] of an origin's followed rows, and more than half of
//!   them, looks like a sync glitch, not a mass delete: nothing is trashed or forgotten for it and
//!   the answer says how many rows it doubts (`doubted`).
//! - *What the follower trashed for a record's absence comes back with the record.* The source
//!   remembers when it trashed the row (`gone_at`); the same record in a later read restores the
//!   row if the member has not touched it. What the member trashed stays trashed.
//! - *A purged row's source is a tombstone and never takes a row again* (the database refuses it
//!   in `source_tombstone_is_final`; the pass reads the tombstone and adds nothing). A record
//!   another phone states is matched against the first phone's tombstones as well as its rows, and
//!   a tombstone whose record is gone from a complete read goes with it.
//!
//! **A system's map is data** ([`SystemMap`]) and **registering it is one step**: a row in
//! [`SYSTEMS`] (`systems.rs`). The pass command, its schema and its preconditions are built from
//! the rows ([`definitions`]); a lane's tests build the same for a map of their own with
//! [`definitions_for`].

mod commands;
mod merge;
mod sources;
mod systems;
mod totals;

use std::collections::BTreeMap;

use rusqlite::Connection;
use serde_json::{Map, Value as Json};

use crate::commands::CommandCtx;
use crate::error::Result;
use crate::model::Kind;

pub(crate) use commands::system_row;
pub use commands::{
    Difference, ItemDifference, definitions, definitions_for, differences, differences_in,
    pass_schema,
};
pub use merge::apply;
pub use sources::move_sources;
pub use systems::{SYSTEMS, Systems, canonical_instants};
pub use totals::write_day_totals;

/// The origin a batch of records came from, as a map's defaults see it.
pub struct OriginRow {
    pub id: String,
    /// The calendar, folder or account this origin feeds.
    pub fills: Option<String>,
    /// The phone that last read it.
    pub device: Option<String>,
}

/// What a new row needs that no record states, given its origin (a column of the kind's own table
/// the origin decides, such as the account a statement line is in; the home is `entity.parent_id`
/// and the engine sets it).
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
    /// The colour the phone paints the store with, when it is a key of the palette.
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

/// The fewest followed rows a complete read must lose before it is doubted.
pub const DOUBTED_AT_LEAST: usize = 5;

/// The maps a set of follow commands is built from: the product's are [`SYSTEMS`] (see
/// [`Systems`]); a lane's tests name their own. A command's handler is a plain function, so the
/// maps it reads are a type, not a value.
pub trait Maps {
    const MAPS: &'static [SystemMap];
}

/// One system's map, as data.
pub struct SystemMap {
    /// The `origin_system.code` this map is for. Whether the file knows it, and whether it
    /// yields `kind`, are the lookups' answers, asked when a pass arrives.
    pub system: &'static str,
    /// The command a pass of this map runs (`follow.<…>`): one per map, so a system that yields
    /// two kinds has two.
    pub command: &'static str,
    /// The kind of entity a record of this map is: the kind whose columns `fields` names.
    pub kind: Kind,
    /// The field naming bytes the command claims in its own commit (a record
    /// then says their `size`), so no step between staging and naming leaves them
    /// unreferenced.
    pub claims: Option<&'static str>,
    /// The columns of the kind's own table the system owns. `title` is always
    /// owned, and is the entity's.
    pub fields: &'static [&'static str],
    /// The fields (`title` among them) that are written when a row is added and
    /// never after, whatever a later read says.
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
    /// the vault per phone calendar, with the phone's colour). None: the engine founds a plain
    /// container of the kind the system fills (`origin_system.fills_kind`) when that kind is a
    /// container, and otherwise the member names the home.
    pub founds: Option<Founds>,
    /// Read what a record states into the form the vault holds it (a wall clock
    /// and its zone become the instant, a store's word for a workout becomes a
    /// kind), so the statement and the row compare equal; an instant is held in the clock's one
    /// form, [`canonical_instants`] says each named field so. A record it refuses is counted and
    /// left out.
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
