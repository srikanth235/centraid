//! DAY ONE ON THE ROOM PLANE (2026-11-17 ruling "Day one is Welcome, then the one Home, filling in"):
//! the Welcome room, what each Home widget says while its app is empty or its permission refused,
//! and the first-open card every app's root shows. Rust decides the words; the shells draw blocks.

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
/// theirs, nor are the starter notes.
pub fn holds(b: &mut Build<'_>, kind: &str) -> bool {
    let Ok(ans) = b.run(&entity_reads::BY_KIND_RECENT, &Args::new().text("kind", kind)) else {
        return false;
    };
    match kind {
        "person" => ans.rows.len() > 1,
        "note" => ans
            .rows
            .iter()
            .any(|row| !STARTER_NOTES.contains(&row.title.as_str())),
        _ => !ans.rows.is_empty(),
    }
}

/// Day one ends at the first thing the member adds or imports.
pub fn day_one(b: &mut Build<'_>) -> bool {
    !ADDED_KINDS.iter().any(|kind| holds(b, kind))
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

/// One app's first-open card. `import` is the app's one import when this phone holds the data
/// (its selector and label), `refused` says the permission was refused.
pub struct FirstOpen<'a> {
    pub app: &'a str,
    pub icon: &'a str,
    pub sentence: String,
    pub import: Option<(Handler, String)>,
    pub refused: Option<(String, String)>,
    pub write: bool,
}

#[must_use]
pub fn first_open(b: &mut Build<'_>, card: FirstOpen<'_>) -> wire::RoomBlock {
    if let Some((title, body)) = card.refused {
        let action = blocks::action(
            &mut b.sel,
            &format!("first/{}/settings", card.app),
            &words::refused_open_settings(EN),
            "",
            Handler::Tag(format!("open_settings:{}", card.app)),
        );
        return blocks::empty(glyph(card.icon, ""), &title, &body, Some(action));
    }
    let tail = match (&card.import, card.write) {
        (Some(_), true) => words::first_open_or_write(EN),
        (Some(_), false) => words::first_open_or_add(EN),
        (None, true) => words::first_open_write(EN),
        (None, false) => String::new(),
    };
    let body = if tail.is_empty() {
        card.sentence.clone()
    } else {
        format!("{} {tail}", card.sentence)
    };
    let action = card.import.map(|(handler, label)| {
        blocks::action(&mut b.sel, &format!("first/{}/import", card.app), &label, "", handler)
    });
    blocks::empty(glyph(card.icon, ""), "", &body, action)
}
