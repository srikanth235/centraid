//! The per-system follow maps (`SYSTEMS`) and their defaults/shape callbacks.
//!
//! **Registering a system's map is one step: a row in [`SYSTEMS`].** The command (`follow.<…>`),
//! its schema and its preconditions are built from the rows; the engine in `merge.rs` reads what a
//! system fills, whether it retires, whether it names a device and which kinds it yields from
//! `origin_system` and `source_shape`, so a map says only which fields its kind has and how a
//! record reads.
//!
//! The table holds the maps of the lanes that have re-plugged theirs (a map names the kind's
//! columns, its children and its defaults, all of which moved with the v0 schema); the removed
//! maps are in this file's history at `40b18d2c` and the engine is proved with maps of the tests'
//! own (`tests/follow_*.rs`).

use rusqlite::{Connection, OptionalExtension};
use serde_json::{Map, Value as Json};

use crate::commands::{CommandCtx, event, reading, workout};
use crate::error::Result;
use crate::model::Kind;

use super::merge::same;
use super::{Child, Gone, Maps, Match, OriginRow, SystemMap};
use crate::error::VaultError;

fn no_defaults(
    _: &rusqlite::Connection,
    _: &OriginRow,
) -> Result<Vec<(&'static str, rusqlite::types::Value)>> {
    Ok(Vec::new())
}

/// The name a system gives a record: `stated.title`, kept in a column of its own so a read of it
/// parses no JSON.
pub(super) fn stated_title(stated: &Json) -> Option<&str> {
    stated.get("title").and_then(Json::as_str)
}

/// Put the instants a record states, the fields named, in the clock's one form whatever the phone
/// spelled, so what the row holds and what the source stated stay equal: the helper a map's
/// `shape` calls for each field it holds as an instant.
pub fn canonical_instants(fields: &mut Map<String, Json>, names: &[&str]) {
    for name in names {
        if let Some(Json::String(text)) = fields.get_mut(*name) {
            *text = crate::time::temporal::canonical(text);
        }
    }
}

impl SystemMap {
    /// Whether a record of this system may state `name`.
    pub(super) fn states(&self, name: &str) -> bool {
        name == "title" || self.fields.contains(&name) || self.child(name).is_some()
    }

    pub(super) fn child(&self, name: &str) -> Option<&Child> {
        self.children.iter().find(|child| child.name == name)
    }

    /// Whether two values of the field say the same thing.
    pub(crate) fn agree(&self, name: &str, left: Option<&Json>, right: Option<&Json>) -> bool {
        match self.child(name) {
            Some(child) => same(
                left.map(child.canon).as_ref(),
                right.map(child.canon).as_ref(),
            ),
            None => same(left, right),
        }
    }
}

fn as_stated(_: &CommandCtx<'_, '_>, _: &mut Map<String, Json>) -> std::result::Result<(), String> {
    Ok(())
}

fn nothing_to_settle(_: &CommandCtx<'_, '_>, _: &str) -> Result<()> {
    Ok(())
}

/// A statement line is in the account its origin fills (the line's account stays `txn.account_id`,
/// it is not a home). The line is entered from a statement, the column's default.
fn statement_defaults(
    _: &Connection,
    origin: &OriginRow,
) -> Result<Vec<(&'static str, rusqlite::types::Value)>> {
    let Some(account) = origin.fills.clone() else {
        return Err(VaultError::InvalidInput {
            name: "origin".to_owned(),
            detail: "a statement is imported into an account".to_owned(),
        });
    };
    Ok(vec![("account_id", account.into())])
}

/// A child that is only ever stated, never a row of the vault's: what the source last said of it,
/// read back from `source.stated`. The member cannot edit it, so the row always agrees with what
/// was stated, and a changed statement is recorded by the engine and written nowhere else.
fn stated_read(connection: &Connection, id: &str, name: &str) -> Result<Json> {
    let stated: Option<String> = connection
        .query_row(
            "SELECT stated FROM source WHERE entity_id = ?1 AND origin_id IN
               (SELECT id FROM origin WHERE retired_at IS NULL)",
            [id],
            |row| row.get(0),
        )
        .optional()?;
    Ok(stated
        .and_then(|text| serde_json::from_str::<Json>(&text).ok())
        .and_then(|stated| stated.get(name).cloned())
        .unwrap_or(Json::Null))
}

fn stated_take(_: &CommandCtx<'_, '_>, _: &str, _: Option<&str>, _: &Json) -> Result<bool> {
    Ok(false)
}

fn stated_canon(value: &Json) -> Json {
    value.clone()
}

fn stated_merge(_: &CommandCtx<'_, '_>, _: &str, _: Option<&Json>, _: &Json) -> Result<bool> {
    Ok(false)
}

/// What a statement said of a line beyond what the model keeps: the bank's memo, its check number,
/// the bank's own type and the file format it came in.
const LINE: Child = Child {
    name: "line",
    read: |connection, id| stated_read(connection, id, "line"),
    canon: stated_canon,
    merge: stated_merge,
    items: None,
    take: stated_take,
    stamp: None,
};

/// A bank's statement (Money): read line by line into an account (its one origin fills it; a statement is
// not a phone's store and is never stopped): the vault adds a line once, a re-import writes
// nothing, a line's day, amount and what was charged are the bank's and never edited, and the
// payee a rule names is given to a line when it is added, never after. A pending line the bank
// later posts is the bank's word (`status`). The member's categories are `txn_split` and their
// memo is `txn.memo`: neither is stated, so neither is ever overwritten.
pub const STATEMENT: SystemMap = SystemMap {
    system: "statement",
    command: "follow.statement",
    kind: Kind::Txn,
    claims: None,
    fields: &[
        "posted_on",
        "amount_minor",
        "status",
        "original_amount_minor",
        "original_currency",
    ],
    fixed: &[
        "title",
        "posted_on",
        "amount_minor",
        "original_amount_minor",
        "original_currency",
    ],
    children: &[LINE],
    match_on: &[],
    gone: Gone::Keep,
    window: None,
    defaults: statement_defaults,
    founds: None,
    shape: as_stated,
    settle: nothing_to_settle,
    named: crate::commands::rule::name_new_line,
};

/// The maps the vault follows. A lane's map is one row; the pass command, its schema and its
/// preconditions are built from it.
pub const SYSTEMS: &[SystemMap] = &[
    // The phone's calendars: an event in the calendar of the vault that stands for the phone's
    // calendar (the engine founds it, named and coloured as the phone has it; the member's own
    // rename stands). The fields are the event's own columns, `location` as the words the phone
    // wrote (a followed record never founds a place, D5), and three fields that are rows of their
    // own: the series' one-day overrides, the alerts, and the guests (stated as `attendees`).
    // `starts` and `reminders` are the keys `alerts.rs` reads to let the phone alert for a record
    // it still states (one alert per real thing).
    SystemMap {
        system: "calendar",
        command: "follow.calendar",
        kind: Kind::Event,
        claims: None,
        fields: &[
            "description",
            "url",
            "location",
            "starts",
            "ends",
            "timing",
            "zone",
            "rule",
            "busy",
        ],
        fixed: &[],
        children: &[
            Child {
                name: "overrides",
                read: event::overrides_read,
                canon: event::overrides_canon,
                merge: event::overrides_merge,
                // Judged whole: a day is not an item the screens name one at a time.
                items: None,
                take: event::overrides_take,
                stamp: None,
            },
            // The alerts, minutes before, judged whole (`event::shape` states them as an array).
            Child {
                name: "reminders",
                read: event::reminders_read,
                canon: event::reminders_canon,
                merge: event::reminders_merge,
                items: None,
                take: event::reminders_take,
                stamp: None,
            },
            // The guests, one by one, by address: a guest who is in People is resolved to the
            // person by their address; one who is not is a guest all the same.
            Child {
                name: "attendees",
                read: event::guests_read,
                canon: event::guests_canon,
                merge: event::guests_merge,
                items: Some(event::guests_items),
                take: event::guests_take,
                stamp: None,
            },
        ],
        match_on: &[Match::Title, Match::Column("starts")],
        gone: Gone::Trash,
        window: None,
        defaults: no_defaults,
        founds: Some(event::follow_home),
        shape: event::shape,
        settle: event::settle,
        named: nothing_to_settle,
    },
    crate::commands::task::PHONE_REMINDERS,
    crate::commands::person::CONTACTS,
    STATEMENT,
    // The health store: a workout and a reading (the system yields both, so a map for each).
    workout::MAP,
    reading::MAP,
    // The phone's picked folders and its camera roll (Docs and Photos).
    crate::commands::document::FILES,
    crate::commands::photo::ROLL,
];

/// The product's maps, [`SYSTEMS`], as the type the follow commands are built from.
pub struct Systems;

impl Maps for Systems {
    const MAPS: &'static [SystemMap] = SYSTEMS;
}
