//! Welcome and first-open content for Home and each app root.

use centraid_api_proto::core_v1 as wire;
use centraid_domain::apps::entity as entity_reads;
use centraid_domain::read::Args;

use super::blocks::{self, glyph};
use super::door::Door;
use super::frame::room;
use super::screen::Build;
use super::selector::Handler;
use super::shell::BACKUP;
use crate::strings::{Locale, home as words};

const EN: Locale = Locale::En;
pub const WELCOME_SEEN: &str = "welcome.seen";
pub const WELCOME: &str = "welcome";
pub const START: &str = "welcome:start";

/// The kinds a member adds or imports, in the order Home's widgets list them.
const ADDED_KINDS: &[&str] = &[
    "person",
    "event",
    "task",
    "photo",
    "txn",
    "document",
    "workout",
    "note",
    "locker_item",
];

const STARTER_NOTES: [&str; 2] = ["This note is yours", "Link with [["];

/// Whether `kind` holds something the member added or imported: the founding person is not
/// theirs, nor are the starter notes. `None` when the vault cannot be read.
fn read_holds(b: &mut Build<'_>, kind: &str) -> Option<bool> {
    let ans = b
        .run(
            &entity_reads::BY_KIND_RECENT,
            &Args::new().text("kind", kind),
        )
        .ok()?;
    Some(match kind {
        "person" => ans.rows.len() > 1,
        "note" => ans
            .rows
            .iter()
            .any(|row| !STARTER_NOTES.contains(&row.title.as_str())),
        _ => !ans.rows.is_empty(),
    })
}

/// How many of `kind` the member holds, never counting what is not theirs.
pub fn count(b: &mut Build<'_>, kind: &str) -> usize {
    let Ok(ans) = b.run(
        &entity_reads::BY_KIND_RECENT,
        &Args::new().text("kind", kind),
    ) else {
        return 0;
    };
    match kind {
        "person" => ans.rows.len().saturating_sub(1),
        "note" => ans
            .rows
            .iter()
            .filter(|row| !STARTER_NOTES.contains(&row.title.as_str()))
            .count(),
        _ => ans.rows.len(),
    }
}

pub fn holds(b: &mut Build<'_>, kind: &str) -> bool {
    read_holds(b, kind).unwrap_or(false)
}

/// Day one ends at the first thing the member adds or imports. A vault that cannot be read is
/// not called empty.
pub fn day_one(b: &mut Build<'_>) -> bool {
    ADDED_KINDS
        .iter()
        .all(|kind| read_holds(b, kind) == Some(false))
}

#[must_use]
pub fn welcomed(door: &dyn Door) -> bool {
    door.device_get(WELCOME_SEEN).is_some()
}

pub fn mark_welcomed(door: &dyn Door) {
    let _ = door.device_put(WELCOME_SEEN, "1");
}

/// The Welcome room: what Centraid is, then Get started or Restore backup.
pub fn welcome(b: &mut Build<'_>) -> wire::Room {
    let facts = [
        (
            words::first_launch_house_title(EN),
            words::first_launch_house_body(EN),
            "Home",
        ),
        (
            words::first_launch_assistant_title(EN),
            words::first_launch_assistant_body(EN),
            "NewChat",
        ),
        (
            words::first_launch_backup_title(EN),
            words::first_launch_backup_body(EN),
            "Backup",
        ),
    ];
    let mut content = vec![blocks::prose(&words::first_launch_body(EN))];
    for (i, (title, body, icon)) in facts.iter().enumerate() {
        content.push(
            blocks::still_row(&mut b.sel, &format!("welcome/point/{i}"), title)
                .meta(body)
                .mark(blocks::glyph_mark(icon, ""))
                .into_block(),
        );
    }
    let start = blocks::action(
        &mut b.sel,
        "welcome/start",
        &words::first_launch_make(EN),
        "",
        Handler::Tag(START.to_owned()),
    );
    let restore = blocks::action(
        &mut b.sel,
        "welcome/restore",
        &words::first_launch_restore(EN),
        "",
        Handler::Open(BACKUP.to_owned()),
    );
    content.push(blocks::empty(glyph("Home", ""), "", "", Some(start)));
    content.push(blocks::empty(glyph("Backup", ""), "", "", Some(restore)));
    room(wire::RoomKind::Stage, WELCOME)
        .title(&words::first_launch_title(EN))
        .ready(content)
        .build()
}

/// What follows a first-open sentence: the "Or" only where an import precedes it.
#[derive(Clone, Copy)]
pub enum Tail {
    None,
    OrWrite,
    OrAdd,
    Write,
}

/// One app's first-open card. `action` is the app's one add or import, when it has one, and
/// `refused` the title and body said instead when the member refused the OS permission.
pub struct FirstOpen<'a> {
    pub app: &'a str,
    pub icon: &'a str,
    pub hue: &'a str,
    pub sentence: String,
    pub action: Option<(Handler, String)>,
    pub tail: Tail,
    pub refused: Option<(String, String)>,
}

#[must_use]
pub fn first_open(b: &mut Build<'_>, card: FirstOpen<'_>) -> wire::RoomBlock {
    if let Some((title, body)) = card.refused {
        let action = blocks::action(
            &mut b.sel,
            &format!("first/{}/settings", card.app),
            &words::refused_open_settings(EN),
            "",
            settings(card.app),
        );
        return blocks::empty(glyph(card.icon, card.hue), &title, &body, Some(action));
    }
    let tail = match card.tail {
        Tail::None => String::new(),
        Tail::OrWrite => words::first_open_or_write(EN),
        Tail::OrAdd => words::first_open_or_add(EN),
        Tail::Write => words::first_open_write(EN),
    };
    let body = if tail.is_empty() {
        card.sentence.clone()
    } else {
        format!("{} {tail}", card.sentence)
    };
    let action = card.action.map(|(handler, label)| {
        blocks::action(
            &mut b.sel,
            &format!("first/{}/action", card.app),
            &label,
            "",
            handler,
        )
    });
    blocks::empty(glyph(card.icon, card.hue), "", &body, action)
}

/// The core's system for one of the stores a day-one widget or card names.
fn system(store: &str) -> &str {
    match store {
        "photos" => "camera_roll",
        "people" => "contacts",
        other => other,
    }
}

/// The one import: the tap the follow rows send, so the core asks the OS itself.
#[must_use]
pub fn import(store: &str) -> Handler {
    Handler::Tag(format!("follow:enrol:{}", system(store)))
}

/// Open the OS settings page for a store whose permission was refused.
#[must_use]
pub fn settings(store: &str) -> Handler {
    Handler::Tag(format!("follow:settings:{}", system(store)))
}

/// Whether the member refused (or the OS restricts) the permission this store needs.
#[must_use]
pub fn refused(door: &dyn Door, store: &str) -> bool {
    super::follow::status(door, system(store)).is_some_and(|status| {
        matches!(
            wire::FollowGrant::try_from(status.blocked),
            Ok(wire::FollowGrant::Refused | wire::FollowGrant::Restricted)
        )
    })
}
