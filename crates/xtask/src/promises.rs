//! `promises` — the register of who keeps which promise (#1185).
//!
//! Every promise the product makes must behave the same way in every one of the
//! nine apps. This rule holds a small table: for each app and each promise,
//! either [`Status::Kept`] (with the file that proves it) or [`Status::Owed`] (a
//! known gap, tracked by #1185). The rule does not trust the table. For every
//! row it runs the promise's checker over the source and the app's manifest,
//! which answers with what is MISSING:
//!
//! - a `Kept` row whose checker finds something missing fails (a regression, or
//!   a claim that was never true);
//! - an `Owed` row whose checker finds nothing missing fails (the debt is paid:
//!   flip the row to `Kept`, so the table can only shrink truthfully);
//! - an `Owed` row that is still owed passes, and `cargo xtask rules` prints,
//!   under the rule, exactly what is missing and in which file.
//!
//! `Owed` is honest debt listed in one place. It is not an exemption from any
//! other rule: every other gate runs over the same tree whatever this table says.
//!
//! ADDING A PROMISE is a variant of [`Promise`] (and its place in
//! [`Promise::ALL`]), one checker arm in [`missing`], and one row per app in
//! [`REGISTER`]. The completeness check fails until every app has a row for every
//! promise, so a column cannot be added to only some apps.
//!
//! Like [`crate::rules`] these are file walks and string scans, not parse trees,
//! and every checker has a fixture that must be caught (`promises_tests`).

use std::collections::BTreeSet;
use std::fs;
use std::path::Path;

use crate::rules::{RuleReport, relative, source_files};

/// The nine first-party apps (`crates/apps`).
pub const APPS: [&str; 9] = [
    "calendar",
    "docs",
    "health",
    "locker",
    "money",
    "notes",
    "people",
    "photos",
    "reminders",
];

/// One promise the product makes in every app.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Promise {
    /// Every item moves to trash, restores, and deletes forever; every trash
    /// empties.
    Trash,
}

impl Promise {
    /// Every promise, in the order the table is read.
    pub const ALL: [Promise; 1] = [Promise::Trash];

    fn name(self) -> &'static str {
        match self {
            Promise::Trash => "Trash",
        }
    }
}

/// Whether an app keeps a promise.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Status {
    /// Kept; the string is the file that proves it (read by the checker, and it
    /// must exist).
    Kept(&'static str),
    /// A known gap; the string says why, and names the issue that tracks it.
    Owed(&'static str),
}

/// One cell of the table.
#[derive(Clone, Copy, Debug)]
pub struct Row {
    pub app: &'static str,
    pub promise: Promise,
    pub status: Status,
}

const fn kept(app: &'static str, promise: Promise, proof: &'static str) -> Row {
    Row {
        app,
        promise,
        status: Status::Kept(proof),
    }
}

const fn owed(app: &'static str, promise: Promise, why: &'static str) -> Row {
    Row {
        app,
        promise,
        status: Status::Owed(why),
    }
}

/// THE TABLE. One row per app per promise; it only shrinks truthfully.
pub const REGISTER: &[Row] = &[
    kept(
        "calendar",
        Promise::Trash,
        "crates/screens/src/calendar/trash.rs",
    ),
    kept("docs", Promise::Trash, "crates/screens/src/docs/trash.rs"),
    kept(
        "health",
        Promise::Trash,
        "crates/screens/src/health/trash.rs",
    ),
    kept(
        "locker",
        Promise::Trash,
        "crates/screens/src/locker/trash.rs",
    ),
    kept("money", Promise::Trash, "crates/screens/src/money/trash.rs"),
    kept("notes", Promise::Trash, "crates/screens/src/notes/trash.rs"),
    kept(
        "people",
        Promise::Trash,
        "crates/screens/src/people/trash.rs",
    ),
    owed(
        "photos",
        Promise::Trash,
        "#1185: Photos' Trash is its own shelf (photos/shelf.rs): it has Restore, Delete forever and Empty trash in the shared words, but empties by purging photo by photo (no `entity.empty_trash` action) and is not a kit TrashSpec",
    ),
    kept(
        "reminders",
        Promise::Trash,
        "crates/screens/src/reminders/trash.rs",
    ),
];

/// `promises`: the table is complete, and every row is true.
pub fn promises(root: &Path) -> RuleReport {
    check(root, REGISTER)
}

pub(crate) fn check(root: &Path, register: &[Row]) -> RuleReport {
    let mut findings = Vec::new();
    let mut details = Vec::new();

    // Completeness: one row per app per promise, no stranger.
    let mut seen = BTreeSet::new();
    for row in register {
        if !APPS.contains(&row.app) {
            findings.push(format!("register: `{}` is not an app", row.app));
        }
        if !seen.insert((row.app, row.promise)) {
            findings.push(format!(
                "register: {} / {} has two rows",
                row.app,
                row.promise.name()
            ));
        }
    }
    for app in APPS {
        for promise in Promise::ALL {
            if !seen.contains(&(app, promise)) {
                findings.push(format!(
                    "register: {app} / {} has no row; every app needs one (Kept or Owed)",
                    promise.name()
                ));
            }
        }
    }

    let mut kept_count = 0;
    let mut owed_count = 0;
    for row in register {
        let lacking = missing(root, row.app, row.promise);
        match row.status {
            Status::Kept(proof) => {
                kept_count += 1;
                if !root.join(proof).is_file() {
                    findings.push(format!(
                        "{} / {}: Kept, but its proof `{proof}` does not exist",
                        row.app,
                        row.promise.name()
                    ));
                }
                for gap in lacking {
                    findings.push(format!(
                        "{} / {}: claimed Kept, but {gap}",
                        row.app,
                        row.promise.name()
                    ));
                }
            }
            Status::Owed(why) => {
                owed_count += 1;
                if lacking.is_empty() {
                    findings.push(format!(
                        "{} / {}: listed Owed ({why}) but nothing is missing; make it Kept",
                        row.app,
                        row.promise.name()
                    ));
                }
                for gap in lacking {
                    details.push(format!("owed {} / {}: {gap}", row.app, row.promise.name()));
                }
            }
        }
    }

    let mut report = RuleReport::applied("promises", register.len(), findings)
        .with_note(format!(" ({kept_count} kept, {owed_count} owed)"));
    report.details = details;
    report
}

/// What a promise still lacks in an app: one sentence per gap, naming the file.
/// Empty means the promise is kept.
pub fn missing(root: &Path, app: &str, promise: Promise) -> Vec<String> {
    match promise {
        Promise::Trash => trash_missing(root, app),
    }
}

// ---------------------------------------------------------------------------
// Trash
// ---------------------------------------------------------------------------

/// The shared vault commands the manifest must declare as actions.
const TRASH_COMMANDS: [(&str, &str); 4] = [
    ("entity.trash", "move to trash"),
    ("entity.restore", "restore"),
    ("entity.purge", "delete forever"),
    ("entity.empty_trash", "empty trash"),
];

/// Trash is kept when, for `app`:
///
/// 1. `crates/screens/src/<app>/trash.rs` defines a `TrashSpec` built on
///    `kit::trash`, with `restore`, `purge` and `empty`;
/// 2. the app's `mod.rs` registers the screen (`trash::build`);
/// 3. a screen other than the trash routes to it (`routes::trash()`, the More
///    menu's entry);
/// 4. `crates/apps/<app>/manifest.json` declares actions for `entity.trash`,
///    `entity.restore`, `entity.purge` and `entity.empty_trash`;
/// 5. every `act::<app>::X` the trash spec names is a manifest action, and
///    together they reach restore, purge and empty;
/// 6. a screen other than the trash calls one of the manifest's
///    `entity.trash` actions (the "Move to trash" verb is reachable).
fn trash_missing(root: &Path, app: &str) -> Vec<String> {
    let mut gaps = Vec::new();
    let dir = root.join("crates/screens/src").join(app);
    let spec_path = dir.join("trash.rs");
    let spec_rel = format!("crates/screens/src/{app}/trash.rs");
    let manifest_rel = format!("crates/apps/{app}/manifest.json");

    let actions = manifest_actions(root, app);

    // 1. the spec
    let spec = live_source(&spec_path);
    let mut spec_actions: Vec<String> = Vec::new();
    match &spec {
        None => gaps.push(format!(
            "{spec_rel} is missing: no trash screen built on kit::trash::TrashSpec"
        )),
        Some(text) => {
            if !text.contains("kit::trash") || !text.contains("TrashSpec") {
                gaps.push(format!(
                    "{spec_rel} does not define a TrashSpec built on kit::trash"
                ));
            }
            if !spec_field(text, "restore:") {
                gaps.push(format!("{spec_rel}: the spec has no `restore`"));
            }
            if !spec_field(text, "purge:") {
                gaps.push(format!(
                    "{spec_rel}: the spec has no `purge` (no Delete forever)"
                ));
            }
            if !spec_field(text, "empty:") {
                gaps.push(format!(
                    "{spec_rel}: the spec has no `empty` (no Empty trash)"
                ));
            }
            spec_actions = act_idents(text, app);
        }
    }

    // 2. registered, 3. routed from another screen, 6. the move verb is called
    let mut registered = false;
    let mut routed = false;
    let mut moved_by: BTreeSet<String> = BTreeSet::new();
    let trash_pascals: BTreeSet<String> = actions
        .iter()
        .filter(|(_, command)| command == "entity.trash")
        .map(|(name, _)| pascal(name))
        .collect();
    for file in source_files(&dir, "rs") {
        let rel = relative(root, &file);
        let Some(text) = live_source(&file) else {
            continue;
        };
        if rel.ends_with("/mod.rs")
            && rel.matches('/').count() == 4
            && text.contains("trash::build")
        {
            registered = true;
        }
        if file != spec_path {
            if text.contains("routes::trash()") {
                routed = true;
            }
            for pascal in &trash_pascals {
                if text.contains(&format!("act::{app}::{pascal}")) {
                    moved_by.insert(pascal.clone());
                }
            }
        }
    }
    if !registered {
        gaps.push(format!(
            "crates/screens/src/{app}/mod.rs does not register the screen (`trash::build`)"
        ));
    }
    if !routed {
        gaps.push(format!(
            "crates/screens/src/{app}/: no screen routes to the trash (`routes::trash()` in the More menu)"
        ));
    }

    // 4. the manifest
    match &actions {
        a if a.is_empty() => gaps.push(format!("{manifest_rel} could not be read")),
        a => {
            for (command, word) in TRASH_COMMANDS {
                if !a.iter().any(|(_, c)| c == command) {
                    gaps.push(format!(
                        "{manifest_rel} declares no `{command}` action ({word})"
                    ));
                }
            }
        }
    }
    // 6 (continued)
    if !trash_pascals.is_empty() && moved_by.is_empty() {
        gaps.push(format!(
            "crates/screens/src/{app}/: no screen calls a move-to-trash action ({})",
            trash_pascals
                .iter()
                .map(|p| format!("act::{app}::{p}"))
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }

    // 5. the spec's actions reach restore, purge and empty
    if spec.is_some() && !actions.is_empty() {
        // A name that is no action (`APP`, an input's enum) reaches nothing; the
        // generated catalog already refuses a misspelt action at compile time.
        let reached: BTreeSet<&str> = actions
            .iter()
            .filter(|(name, _)| spec_actions.contains(&pascal(name)))
            .map(|(_, command)| command.as_str())
            .collect();
        for (command, word) in &TRASH_COMMANDS[1..] {
            if !reached.contains(command) {
                gaps.push(format!(
                    "{spec_rel}: the spec reaches no `{command}` action ({word})"
                ));
            }
        }
    }
    gaps
}

/// `(action name, command)` for every action in the app's manifest.
fn manifest_actions(root: &Path, app: &str) -> Vec<(String, String)> {
    let path = root.join(format!("crates/apps/{app}/manifest.json"));
    let Ok(text) = fs::read_to_string(path) else {
        return Vec::new();
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else {
        return Vec::new();
    };
    value
        .get("actions")
        .and_then(|actions| actions.as_array())
        .map(|actions| {
            actions
                .iter()
                .filter_map(|action| {
                    Some((
                        action.get("name")?.as_str()?.to_owned(),
                        action.get("command")?.as_str()?.to_owned(),
                    ))
                })
                .collect()
        })
        .unwrap_or_default()
}

/// The file's code before its test module, comment lines cut. `None` when the
/// file does not exist.
fn live_source(path: &Path) -> Option<String> {
    let text = fs::read_to_string(path).ok()?;
    let live = text.split("#[cfg(test)]").next().unwrap_or_default();
    Some(
        live.lines()
            .filter(|line| !line.trim_start().starts_with("//"))
            .collect::<Vec<_>>()
            .join("\n"),
    )
}

/// Whether the spec literal sets `field` to something other than `None`.
fn spec_field(text: &str, field: &str) -> bool {
    text.match_indices(field).any(|(at, _)| {
        let after = text[at + field.len()..].trim_start();
        !after.starts_with("None")
    })
}

/// Every `act::<app>::Name` the text spells.
fn act_idents(text: &str, app: &str) -> Vec<String> {
    let prefix = format!("act::{app}::");
    let mut out: Vec<String> = text
        .match_indices(&prefix)
        .map(|(at, _)| {
            text[at + prefix.len()..]
                .chars()
                .take_while(|c| c.is_ascii_alphanumeric())
                .collect::<String>()
        })
        .filter(|name| name.chars().next().is_some_and(char::is_uppercase))
        .collect();
    out.sort();
    out.dedup();
    out
}

/// `delete-note` as the catalog spells it: `DeleteNote`.
fn pascal(action: &str) -> String {
    action
        .split('-')
        .map(|word| {
            let mut chars = word.chars();
            chars
                .next()
                .map(|first| first.to_uppercase().collect::<String>() + chars.as_str())
                .unwrap_or_default()
        })
        .collect()
}

#[cfg(test)]
#[path = "promises_tests.rs"]
mod tests;
