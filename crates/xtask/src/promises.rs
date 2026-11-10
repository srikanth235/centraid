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
//! TRASH HAS TWO SHAPES, and only two: the kit's `TrashSpec` screen (every app but one), and a
//! GRID trash an app declares by name in [`GRID_TRASH`] (Photos: thumbnails picked many at a time).
//! The grid shape proves the same four verbs and the kit's words; it is not a way out of them.
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

use std::collections::{BTreeMap, BTreeSet};
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
    /// Every action can be taken back from the status line, or is confirmed first because it
    /// cannot be; the manifests and the core's inverse table say one thing.
    Undo,
    /// Every record keeps its earlier values (the vault's one history, at the commit door), and
    /// the detail screen of each primary kind lists them on the kit's one screen, with Restore.
    History,
}

impl Promise {
    /// Every promise, in the order the table is read.
    pub const ALL: [Promise; 3] = [Promise::Trash, Promise::Undo, Promise::History];

    fn name(self) -> &'static str {
        match self {
            Promise::Trash => "Trash",
            Promise::Undo => "Undo",
            Promise::History => "History",
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
    // A grid trash (`GRID_TRASH`): thumbnails picked many at a time, held to the same four verbs.
    kept(
        "photos",
        Promise::Trash,
        "crates/screens/src/photos/shelf.rs",
    ),
    kept(
        "reminders",
        Promise::Trash,
        "crates/screens/src/reminders/trash.rs",
    ),
    // Undo (#1185, Phase 1): the checker's gaps are the adopters' work list.
    owed("calendar", Promise::Undo, UNDO_OWED),
    owed("docs", Promise::Undo, UNDO_OWED),
    owed("health", Promise::Undo, UNDO_OWED),
    owed("locker", Promise::Undo, UNDO_OWED),
    owed("money", Promise::Undo, UNDO_OWED),
    owed("notes", Promise::Undo, UNDO_OWED),
    owed("people", Promise::Undo, UNDO_OWED),
    owed("photos", Promise::Undo, UNDO_OWED),
    owed("reminders", Promise::Undo, UNDO_OWED),
    // History (#1185, Phase 1): People is the reference adoption; the checker's gaps are the
    // others' work list.
    kept(
        "calendar",
        Promise::History,
        "crates/screens/src/calendar/earlier.rs",
    ),
    owed(
        "docs",
        Promise::History,
        "its own versions screen (versions.rs) has not moved onto the kit's, and the document page has no entry (#1185)",
    ),
    kept(
        "health",
        Promise::History,
        "crates/screens/src/health/earlier.rs",
    ),
    owed(
        "locker",
        Promise::History,
        "the item page has no Earlier versions entry (#1185)",
    ),
    kept(
        "money",
        Promise::History,
        "crates/screens/src/money/earlier.rs",
    ),
    owed(
        "notes",
        Promise::History,
        "its own history screen (history.rs) has not moved onto the kit's, and the note's menu has no entry (#1185)",
    ),
    kept(
        "people",
        Promise::History,
        "crates/screens/src/people/earlier.rs",
    ),
    kept(
        "photos",
        Promise::History,
        "crates/screens/src/photos/earlier.rs",
    ),
    kept(
        "reminders",
        Promise::History,
        "crates/screens/src/reminders/earlier.rs",
    ),
];

const UNDO_OWED: &str = "actions neither in the core's inverse table nor confirmed, or the manifest and the table disagree (#1185)";

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
        Promise::Undo => undo_missing(root, app),
        Promise::History => history_missing(root, app),
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

/// A TRASH THAT IS A GRID, not the kit's list of rows (#1185).
///
/// An app whose records are looked at rather than read (a photograph is recognised by its
/// thumbnail, and picked many at a time) may keep Trash as a shelf of its own instead of the kit's
/// [`TrashSpec`] screen. It is declared HERE, by name, so the register cannot grow a second shape
/// by accident, and it must still prove the same promise: every verb (move to trash, restore,
/// delete forever, empty) is an action of the manifest that a screen of the app calls, the shelf is
/// registered and reached from another screen, and the words a confirm says are the kit's
/// ([`GRID_WORDS`]). Every other app is held to the kit's shape, whatever it has in its folder.
pub struct GridTrash {
    pub app: &'static str,
    /// The shelf's file under `crates/screens/src/<app>/`.
    pub shelf: &'static str,
    /// What another screen spells to open the trash shelf (its route).
    pub route: &'static str,
}

/// The grid trashes. Only Photos: a trash of thumbnails with multi-select.
pub const GRID_TRASH: &[GridTrash] = &[GridTrash {
    app: "photos",
    shelf: "shelf.rs",
    route: "PhotosShelfKind::Trash",
}];

/// The kit's words a grid trash must say, as the shared catalog names them
/// (`crates/screens/src/strings/shared.rs`): Restore, Delete forever, and the Empty trash confirm.
const GRID_WORDS: [&str; 5] = [
    "trash_restore",
    "trash_purge",
    "trash_empty_title",
    "trash_empty_body",
    "trash_empty_action",
];

fn trash_missing(root: &Path, app: &str) -> Vec<String> {
    trash_missing_in(root, app, GRID_TRASH)
}

/// [`trash_missing`] over a stated list of grid trashes (a fixture states its own).
fn trash_missing_in(root: &Path, app: &str, grids: &[GridTrash]) -> Vec<String> {
    match grids.iter().find(|grid| grid.app == app) {
        Some(grid) => grid_trash_missing(root, app, grid),
        None => kit_trash_missing(root, app),
    }
}

/// A grid trash is kept when, for `app`:
///
/// 1. `crates/apps/<app>/manifest.json` declares actions for `entity.trash`, `entity.restore`,
///    `entity.purge` and `entity.empty_trash`;
/// 2. the shelf file exists, the app's `mod.rs` registers it (`<shelf>::build`) and a screen other
///    than the shelf opens it ([`GridTrash::route`]);
/// 3. screens of the app call actions that reach all four commands (the shelf's own selection
///    bar and the page's Move to trash included), so no verb is a promise nothing sends;
/// 4. the app's screens say each of [`GRID_WORDS`].
fn grid_trash_missing(root: &Path, app: &str, grid: &GridTrash) -> Vec<String> {
    let mut gaps = Vec::new();
    let dir = root.join("crates/screens/src").join(app);
    let shelf_path = dir.join(grid.shelf);
    let shelf_rel = format!("crates/screens/src/{app}/{}", grid.shelf);
    let manifest_rel = format!("crates/apps/{app}/manifest.json");
    let actions = manifest_actions(root, app);

    // 1. the manifest
    if actions.is_empty() {
        gaps.push(format!("{manifest_rel} could not be read"));
    } else {
        for (command, word) in TRASH_COMMANDS {
            if !actions.iter().any(|(_, c)| c == command) {
                gaps.push(format!(
                    "{manifest_rel} declares no `{command}` action ({word})"
                ));
            }
        }
    }

    // 2. the shelf, registered and routed to; 3. the verbs called; 4. the words
    if live_source(&shelf_path).is_none() {
        gaps.push(format!("{shelf_rel} is missing: no grid trash shelf"));
    }
    let stem = grid.shelf.trim_end_matches(".rs");
    let mut registered = false;
    let mut routed = false;
    let mut called: BTreeSet<String> = BTreeSet::new();
    let mut said = String::new();
    for file in source_files(&dir, "rs") {
        let rel = relative(root, &file);
        let Some(text) = live_source(&file) else {
            continue;
        };
        if rel.ends_with("/mod.rs")
            && rel.matches('/').count() == 4
            && text.contains(&format!("{stem}::build"))
        {
            registered = true;
        }
        if file != shelf_path && text.contains(grid.route) {
            routed = true;
        }
        called.extend(act_idents(&text, app));
        said.push_str(&text);
    }
    if !registered {
        gaps.push(format!(
            "crates/screens/src/{app}/mod.rs does not register the shelf (`{stem}::build`)"
        ));
    }
    if !routed {
        gaps.push(format!(
            "crates/screens/src/{app}/: no screen other than {shelf_rel} opens the trash shelf (`{}`)",
            grid.route
        ));
    }
    if !actions.is_empty() {
        let reached: BTreeSet<&str> = actions
            .iter()
            .filter(|(name, _)| called.contains(&pascal(name)))
            .map(|(_, command)| command.as_str())
            .collect();
        for (command, word) in TRASH_COMMANDS {
            if !reached.contains(command) {
                gaps.push(format!(
                    "crates/screens/src/{app}/: no screen calls an `{command}` action ({word})"
                ));
            }
        }
    }
    for word in GRID_WORDS {
        if !said.contains(word) {
            gaps.push(format!(
                "crates/screens/src/{app}/ never says `{word}`, the kit's word (strings/shared.rs)"
            ));
        }
    }
    gaps
}

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
fn kit_trash_missing(root: &Path, app: &str) -> Vec<String> {
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

// ---------------------------------------------------------------------------
// Undo
// ---------------------------------------------------------------------------

/// The core's inverse table (`act/inverse.rs`), the one list a status-line Undo reads.
const INVERSE_TABLE: &str = "crates/core/src/act/inverse.rs";

/// One manifest action, as far as Undo is concerned.
struct UndoAction {
    name: String,
    /// The inverse the manifest declares (`"inverse"`; chat's undo reads it).
    inverse: Option<String>,
    /// `"confirmation": "required"`: the member is asked first.
    confirmed: bool,
}

/// Every action of the app's manifest. Every one is a write: the manifest has no read-only action
/// (reads are `queries`), and `inverse` is a mandatory field of every action, so no action is
/// exempt by name or by verb.
fn undo_actions(root: &Path, app: &str) -> Vec<UndoAction> {
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
                    Some(UndoAction {
                        name: action.get("name")?.as_str()?.to_owned(),
                        inverse: action
                            .get("inverse")
                            .and_then(|inverse| inverse.as_str())
                            .map(str::to_owned),
                        confirmed: action.get("confirmation").and_then(|c| c.as_str())
                            == Some("required"),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// `action -> inverse` for `app`, read from the `const <APP>: &[Row]` block of the core's table.
/// `None` when the file or the block is missing (an app with no row has no inverse at all).
fn core_inverses(root: &Path, app: &str) -> Option<BTreeMap<String, String>> {
    let text = live_source(&root.join(INVERSE_TABLE))?;
    let head = format!("const {}: &[Row]", app.to_uppercase());
    let block = text.split(&head).nth(1)?.split("];").next()?;
    let quoted = |part: &str| {
        let part = part.trim().strip_prefix('"')?;
        Some(part[..part.find('"')?].to_owned())
    };
    Some(
        block
            .lines()
            .filter_map(|line| {
                let row = line.trim().strip_prefix('(')?;
                let mut parts = row.split(',');
                Some((quoted(parts.next()?)?, quoted(parts.next()?)?))
            })
            .collect(),
    )
}

/// Undo is kept when, for `app`, both hold (each gap is `<action>: (A|B) what is missing`):
///
/// A. every manifest action is classified: it has a row in the core's inverse table
///    ([`INVERSE_TABLE`]), or it is `confirmed` in the manifest (irreversible, asked first). An
///    action that is both is fine; one that is neither is a gap.
/// B. the manifest and the table are one list: every inverse the manifest declares is the row the
///    table holds for that action, and every row of the table is the inverse its manifest names.
///
/// Not checked, and why: which screens offer the status-line Undo after an inverse-able action.
/// A screen sets the line far from the call (a kit helper, a `StatusActed` event, a closure in a
/// `TrashSpec`, `settled.inverse` shared between Reminders and Calendar), so a static scan would
/// guess; nothing is printed rather than a guess.
fn undo_missing(root: &Path, app: &str) -> Vec<String> {
    let actions = undo_actions(root, app);
    if actions.is_empty() {
        return vec![format!("crates/apps/{app}/manifest.json could not be read")];
    }
    let Some(table) = core_inverses(root, app) else {
        return vec![format!(
            "{INVERSE_TABLE} has no `{}` table",
            app.to_uppercase()
        )];
    };
    let mut unclassified = Vec::new();
    let mut mismatched = Vec::new();
    for action in &actions {
        let name = &action.name;
        let row = table.get(name);
        if row.is_none() && !action.confirmed {
            unclassified.push(format!(
                "{name}: (A) has no inverse in {INVERSE_TABLE} and is not `confirmed` in the manifest"
            ));
        }
        match (row, &action.inverse) {
            (Some(row), Some(declared)) if row != declared => mismatched.push(format!(
                "{name}: (B) the table reverses it with `{row}`, the manifest declares `{declared}`"
            )),
            (Some(row), None) => mismatched.push(format!(
                "{name}: (B) the table reverses it with `{row}`, the manifest declares no inverse"
            )),
            (None, Some(declared)) => mismatched.push(format!(
                "{name}: (B) the manifest declares inverse `{declared}`, the table has no row"
            )),
            _ => {}
        }
    }
    for name in table.keys() {
        if !actions.iter().any(|action| &action.name == name) {
            mismatched.push(format!(
                "{name}: (B) a row of the table, but no such action in the manifest"
            ));
        }
    }
    if unclassified.is_empty() && mismatched.is_empty() {
        return Vec::new();
    }
    let mut gaps = vec![format!(
        "summary: {} of {} actions unclassified (A), {} list mismatches (B)",
        unclassified.len(),
        actions.len(),
        mismatched.len()
    )];
    gaps.extend(unclassified);
    gaps.extend(mismatched);
    gaps
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

/// The primary kinds of each app and the screen that shows one: a file, or a folder, under
/// `crates/screens/src/<app>/`. The detail screen of a kind is where its "Earlier versions" entry
/// sits at the foot (design/mockups/Versions*.dc.html), so each is named here and must embed it. A
/// kind that is not listed has no promise; adding an app's kind is a row here.
pub const HISTORY_KINDS: &[(&str, &[(&str, &str)])] = &[
    ("calendar", &[("event", "event.rs")]),
    ("docs", &[("document", "document.rs")]),
    ("health", &[("workout", "workout.rs")]),
    ("locker", &[("item", "item.rs")]),
    ("money", &[("transaction", "transaction.rs")]),
    ("notes", &[("note", "editor.rs")]),
    ("people", &[("person", "person")]),
    ("photos", &[("photo", "lightbox.rs")]),
    ("reminders", &[("task", "detail.rs")]),
];

/// The shell's catalogue, where the shared read and the two commands live.
const SHELL_MANIFEST: &str = "crates/core/src/shell/manifest.json";

/// What the spec literal must set: the app, the noun, the gate and the one-line formatter.
const HISTORY_SPEC_FIELDS: [&str; 4] = ["app", "noun", "denied", "line"];

/// Whether the spec literal sets `field`, long form (`line: format,`) or shorthand (`line,`).
fn spec_sets(text: &str, field: &str) -> bool {
    text.lines().any(|line| {
        let line = line.trim();
        line.starts_with(&format!("{field}:")) || line == format!("{field},")
    })
}

/// History is kept when, for `app`:
///
/// 1. the shell's manifest declares the shared reads (`earlier-versions`, `earlier-count`) and the
///    two commands (`restore-version` is `history.restore_version`, `undo-change` is
///    `history.undo`);
/// 2. `crates/screens/src/<app>/earlier.rs` defines an `EarlierSpec` built on `kit::earlier`, with
///    its app, noun, gate and line;
/// 3. the app's `mod.rs` registers it (`earlier::build`) under a `<app>.earlier` name;
/// 4. the detail screen of each primary kind ([`HISTORY_KINDS`]) embeds the shared entry
///    (`earlier::foot(` over the app's `EARLIER` route), so a count and a way in are on the page.
fn history_missing(root: &Path, app: &str) -> Vec<String> {
    let mut gaps = Vec::new();
    let dir = root.join("crates/screens/src").join(app);
    let spec_rel = format!("crates/screens/src/{app}/earlier.rs");

    // 1. the shared door
    match fs::read_to_string(root.join(SHELL_MANIFEST))
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
    {
        None => gaps.push(format!("{SHELL_MANIFEST} could not be read")),
        Some(manifest) => {
            let named = |list: &str, name: &str, command: Option<&str>| {
                manifest
                    .get(list)
                    .and_then(|entries| entries.as_array())
                    .is_some_and(|entries| {
                        entries.iter().any(|entry| {
                            entry.get("name").and_then(|n| n.as_str()) == Some(name)
                                && command.is_none_or(|command| {
                                    entry.get("command").and_then(|c| c.as_str()) == Some(command)
                                })
                        })
                    })
            };
            for query in ["earlier-versions", "earlier-count"] {
                if !named("queries", query, None) {
                    gaps.push(format!("{SHELL_MANIFEST} declares no `{query}` query"));
                }
            }
            for (action, command) in [
                ("restore-version", "history.restore_version"),
                ("undo-change", "history.undo"),
            ] {
                if !named("actions", action, Some(command)) {
                    gaps.push(format!(
                        "{SHELL_MANIFEST} declares no `{action}` action that runs `{command}`"
                    ));
                }
            }
        }
    }

    // 2. the spec
    match live_source(&dir.join("earlier.rs")) {
        None => gaps.push(format!(
            "{spec_rel} is missing: no earlier-versions screen built on kit::earlier::EarlierSpec"
        )),
        Some(text) => {
            if !text.contains("kit::earlier") || !text.contains("EarlierSpec") {
                gaps.push(format!(
                    "{spec_rel} does not define an EarlierSpec built on kit::earlier"
                ));
            }
            for field in HISTORY_SPEC_FIELDS {
                if !spec_sets(&text, field) {
                    gaps.push(format!("{spec_rel}: the spec has no `{field}`"));
                }
            }
        }
    }

    // 3. registered under the app's own name
    let registered = live_source(&dir.join("mod.rs")).is_some_and(|text| {
        text.contains("earlier::build") && text.contains(&format!("\"{app}.earlier\""))
    });
    if !registered {
        gaps.push(format!(
            "crates/screens/src/{app}/mod.rs does not register the screen (`earlier::build` under \"{app}.earlier\")"
        ));
    }

    // 4. the entry on each primary kind's detail screen
    let kinds = HISTORY_KINDS
        .iter()
        .find(|(name, _)| *name == app)
        .map_or(&[][..], |(_, kinds)| *kinds);
    for (kind, screen) in kinds {
        let path = dir.join(screen);
        let files = if path.is_dir() {
            source_files(&path, "rs")
        } else {
            vec![path]
        };
        let text: String = files
            .iter()
            .filter_map(|file| live_source(file))
            .collect::<Vec<_>>()
            .join("\n");
        if !text.contains("earlier::foot(") || !text.contains("EARLIER") {
            gaps.push(format!(
                "crates/screens/src/{app}/{screen}: the {kind} page does not embed the shared entry (`earlier::foot(` over the app's `EARLIER` route)"
            ));
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
