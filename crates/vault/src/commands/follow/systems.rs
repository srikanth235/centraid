//! The per-system follow maps (`SYSTEMS`) and their defaults/shape callbacks.

use rusqlite::{Connection, OptionalExtension};
use serde_json::{Map, Value as Json};

use crate::commands::{CommandCtx, contact_point, container, event, workout};
use crate::error::{Result, VaultError};
use crate::model::{DEFAULT_CALENDAR_ID, Kind};

use super::merge::same;
use super::{Child, Gone, Match, OriginOf, OriginRow, SystemMap};

/// The name a system gives a record: `stated.title`, kept in a column of its own so a read of it
/// parses no JSON.
pub(super) fn stated_title(stated: &Json) -> Option<&str> {
    stated.get("title").and_then(Json::as_str)
}

fn as_stated(_: &CommandCtx<'_, '_>, _: &mut Map<String, Json>) -> std::result::Result<(), String> {
    Ok(())
}

fn event_shape(
    _: &CommandCtx<'_, '_>,
    fields: &mut Map<String, Json>,
) -> std::result::Result<(), String> {
    event::shape(fields)
}

fn nothing_to_settle(_: &CommandCtx<'_, '_>, _: &str) -> Result<()> {
    Ok(())
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

fn no_defaults(
    _: &Connection,
    _: &OriginRow,
) -> Result<Vec<(&'static str, rusqlite::types::Value)>> {
    Ok(Vec::new())
}

fn calendar_defaults(
    _: &Connection,
    origin: &OriginRow,
) -> Result<Vec<(&'static str, rusqlite::types::Value)>> {
    Ok(vec![(
        "calendar_id",
        origin
            .fills
            .clone()
            .unwrap_or_else(|| DEFAULT_CALENDAR_ID.to_owned())
            .into(),
    )])
}

fn project_defaults(
    _: &Connection,
    origin: &OriginRow,
) -> Result<Vec<(&'static str, rusqlite::types::Value)>> {
    Ok(origin
        .fills
        .clone()
        .map(|project| ("project_id", project.into()))
        .into_iter()
        .collect())
}

fn folder_defaults(
    _: &Connection,
    origin: &OriginRow,
) -> Result<Vec<(&'static str, rusqlite::types::Value)>> {
    Ok(origin
        .fills
        .clone()
        .map(|folder| ("folder_id", folder.into()))
        .into_iter()
        .collect())
}

fn statement_defaults(
    connection: &Connection,
    origin: &OriginRow,
) -> Result<Vec<(&'static str, rusqlite::types::Value)>> {
    let Some(account) = origin.fills.clone() else {
        return Err(VaultError::InvalidInput {
            name: "origin".to_owned(),
            detail: "a statement is imported into an account".to_owned(),
        });
    };
    // A line is in the account's currency: one account, one currency.
    let currency: String = connection.query_row(
        "SELECT currency FROM account WHERE id = ?1",
        [&account],
        |row| row.get(0),
    )?;
    Ok(vec![
        ("account_id", account.into()),
        ("currency", currency.into()),
    ])
}

/// A child that is only ever stated, never a row of the vault's: what the
/// source last said of it, read back from `source.stated`. The member cannot
/// edit it, so the row always agrees with what was stated, and a changed
/// statement is recorded by the engine and written nowhere else.
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

/// A file's size and modification time as the phone last stated them.
///
/// The phone's cheap pre-check rides in the statement: a rescan of an unchanged
/// folder reads no bytes, because the phone asks the vault what each file last
/// stated (`source.stated`) and stages a file only when its size or time moved.
const STAT: Child = Child {
    name: "stat",
    read: |connection, id| stated_read(connection, id, "stat"),
    canon: stated_canon,
    merge: stated_merge,
    items: None,
    take: stated_take,
    stamp: None,
};

/// What a statement said of a line beyond what the model keeps: its memo, its
/// check number, the bank's own type and the file format it came in.
const LINE: Child = Child {
    name: "line",
    read: |connection, id| stated_read(connection, id, "line"),
    canon: stated_canon,
    merge: stated_merge,
    items: None,
    take: stated_take,
    stamp: None,
};

/// The six systems the vault follows.
pub const SYSTEMS: &[SystemMap] = &[
    SystemMap {
        system: "contacts",
        command: "follow.contacts",
        kind: Kind::Person,
        fills: None,
        origin: OriginOf::Phone,
        claims: None,
        fields: &["sort_name", "nickname", "role", "birthday"],
        fixed: &[],
        children: &[Child {
            name: "points",
            read: contact_point::read,
            canon: contact_point::canon,
            merge: contact_point::merge,
            items: Some(contact_point::items),
            take: contact_point::take,
            stamp: None,
        }],
        match_on: &[Match::Title],
        gone: Gone::Trash,
        window: None,
        defaults: no_defaults,
        founds: None,
        shape: as_stated,
        settle: nothing_to_settle,
        named: nothing_to_settle,
    },
    SystemMap {
        system: "calendar",
        command: "follow.calendar",
        kind: Kind::Event,
        fills: Some(Kind::Calendar),
        origin: OriginOf::Phone,
        claims: None,
        fields: &[
            "description",
            "url",
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
            // The guests the phone states: a guest whose email is a person's is that person's
            // `attendee` edge; the rest stay in the statement and are read from it.
            // The alerts, minutes before, judged whole ([`event::shape`] states them as an array).
            Child {
                name: "reminders",
                read: event::reminders_read,
                canon: event::reminders_canon,
                merge: event::reminders_merge,
                items: None,
                take: event::reminders_take,
                stamp: None,
            },
            Child {
                name: "attendees",
                read: event::attendees_read,
                canon: event::attendees_canon,
                merge: event::attendees_merge,
                items: Some(event::attendees_items),
                take: event::attendees_take,
                stamp: Some(event::attendees_stamp),
            },
        ],
        match_on: &[Match::Title, Match::Column("starts")],
        gone: Gone::Trash,
        window: None,
        defaults: calendar_defaults,
        founds: Some(container::follow_calendar),
        shape: event_shape,
        settle: event::settle,
        named: nothing_to_settle,
    },
    SystemMap {
        system: "files",
        command: "follow.files",
        kind: Kind::Document,
        fills: Some(Kind::Folder),
        origin: OriginOf::Phone,
        claims: Some("blob"),
        fields: &["blob", "media_type"],
        fixed: &[],
        children: &[STAT],
        match_on: &[Match::Title],
        gone: Gone::Trash,
        window: None,
        defaults: folder_defaults,
        founds: None,
        shape: as_stated,
        settle: nothing_to_settle,
        named: nothing_to_settle,
    },
    // A reminder of the phone's Reminders app (iOS): a task in the list it sat in. The
    // member's own edit of a field stands; a reminder the phone completes completes the task
    // (the status and its date are two fields written as one, so the table's own CHECK holds),
    // and one deleted on the phone goes to the trash if the member never touched the task.
    SystemMap {
        system: "phone_reminders",
        command: "follow.reminders",
        kind: Kind::Task,
        fills: Some(Kind::Project),
        origin: OriginOf::Phone,
        claims: None,
        fields: &[
            "description",
            "due",
            "zone",
            "priority",
            "rule",
            "remind_before_min",
            "url",
            "status",
            "done_at",
        ],
        fixed: &[],
        children: &[],
        match_on: &[Match::Title],
        gone: Gone::Trash,
        window: None,
        defaults: project_defaults,
        founds: None,
        shape: as_stated,
        settle: nothing_to_settle,
        named: nothing_to_settle,
    },
    // A workout: an activity of a workout kind, its span, and what the store
    // measured. A record states the store's word for the kind and the vault
    // places it ([`workout::shape`]); the member edits none of it, and one gone
    // from the phone stays (R-1129-14).
    SystemMap {
        system: "health",
        command: "follow.health",
        kind: Kind::Activity,
        fills: None,
        origin: OriginOf::Phone,
        claims: None,
        fields: &["type_id", "type_kind", "starts", "ends"],
        fixed: &[],
        children: &[workout::MEASURES],
        match_on: &[Match::Column("type_id"), Match::Minute("starts")],
        gone: Gone::Forget,
        window: Some("starts"),
        defaults: no_defaults,
        founds: None,
        shape: workout::shape,
        settle: workout::settle,
        named: nothing_to_settle,
    },
    // A line of a statement: its title, posted date, and amount are the bank's
    // until the member edits them (via `txn.edit` or `entity.retitle`), and the
    // category is the member's to change. `fixed` protects member-corrected
    // titles, dates, and amounts on re-import.
    SystemMap {
        system: "statement",
        command: "follow.statement",
        kind: Kind::Txn,
        fills: Some(Kind::Account),
        origin: OriginOf::Account,
        claims: None,
        fields: &["posted_on", "amount_minor", "category_id"],
        fixed: &["title", "posted_on", "amount_minor"],
        children: &[LINE],
        match_on: &[],
        gone: Gone::Keep,
        window: None,
        defaults: statement_defaults,
        founds: None,
        shape: as_stated,
        settle: nothing_to_settle,
        named: crate::commands::rule::name_new_line,
    },
];
