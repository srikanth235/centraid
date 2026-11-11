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
//! HISTORY'S ENTRY HAS TWO PLACEMENTS: the foot of a detail page, and, for a full-screen editor
//! with no rows, a row of its menu, declared by name in [`MENU_ENTRY`] and held to more, not less.
//!
//! UNITS: every measured amount an app shows is a `kit::quantity::Quantity`, worded through the
//! member's one units preference (metric or imperial, never one switch per kind of measure). The
//! checker scans an app's live code for a measure worded by hand ([`HAND_MEASURES`]).
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
    /// Every item that enters the vault by a path other than typing records where it came from:
    /// the path passes `arrived_system` and `arrived_label` (a system and a file or device name) to the command that adds
    /// it, and the vault keeps one origin per name and one source per item.
    Arrive,
    /// Every app can export its data as a file, on the kit's one export screen, behind the owner
    /// check (#1185, take out).
    Export,
    /// A primary record can be handed, one at a time, to the OS share sheet, the same way in every
    /// app (#1185, take out). Locker's contents leave only through its export (D11).
    Share,
    /// Every measured amount an app shows is a `kit::quantity::Quantity`, worded through the
    /// member's one units preference (metric or imperial), never by a formatter of the app's own.
    Units,
    /// Anything that leaves the phone in the clear, and a restore, asks the owner check first
    /// (#1185, "Confirm it's me"): one gate in the kit, `kit::owner`. Not on open; an import is
    /// not checked.
    OwnerCheck,
    /// Every item a member opens may hold photos and files: the manifest declares `attach`,
    /// `detach` and an `attachments` read, and the item's detail screen embeds the kit's one
    /// section. A Locker item holds none (owner decision D11), a named exception.
    Attach,
    /// The detail screen of each primary kind says where its item came from, in one quiet line
    /// under the Earlier versions entry (`kit::origin`): the same read and the same sentence for a
    /// followed store and a one-shot arrival, and no line for an item the member typed.
    Origin,
    /// Any item may be linked to any other but a Locker item (#1185): the manifest declares the
    /// `link` and `unlink` verbs, each the other's inverse and classified for Undo, and the
    /// detail screen of each primary kind embeds the kit's one "Linked to" section, which reads
    /// what the item is linked to through `kit::links::read_linked`. A Locker item may start a
    /// link, so Locker is held to the same promise.
    Link,
}

impl Promise {
    /// Every promise, in the order the table is read.
    pub const ALL: [Promise; 11] = [
        Promise::Trash,
        Promise::Undo,
        Promise::History,
        Promise::Arrive,
        Promise::Export,
        Promise::Share,
        Promise::Units,
        Promise::OwnerCheck,
        Promise::Attach,
        Promise::Origin,
        Promise::Link,
    ];

    fn name(self) -> &'static str {
        match self {
            Promise::Units => "Units",
            Promise::Trash => "Trash",
            Promise::Undo => "Undo",
            Promise::History => "History",
            Promise::Arrive => "Arrive",
            Promise::Export => "Export",
            Promise::Share => "Share",
            Promise::OwnerCheck => "OwnerCheck",
            Promise::Attach => "Attach",
            Promise::Origin => "Origin",
            Promise::Link => "Link",
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
    /// A NAMED EXCEPTION, not a gap: the promise does not apply to this app, and the string is
    /// the ruling. It is held to [`ATTACH_EXEMPT`] (the one list of exceptions) and the checker
    /// fails when the app grows what the ruling says it cannot have.
    Exempt(&'static str),
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
    // Units (#1185): `kit::quantity` is the one measure formatter; the checker's gaps are the
    // adopters' work list.
    kept("locker", Promise::Units, UNITS_PROOF),
    kept("money", Promise::Units, UNITS_PROOF),
    kept("notes", Promise::Units, UNITS_PROOF),
    kept("people", Promise::Units, UNITS_PROOF),
    kept("calendar", Promise::Units, UNITS_PROOF),
    kept("docs", Promise::Units, UNITS_PROOF),
    kept("health", Promise::Units, UNITS_PROOF),
    kept("photos", Promise::Units, UNITS_PROOF),
    kept("reminders", Promise::Units, UNITS_PROOF),
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
    // Rule C (every write goes through `kit::undo`) is the adopters' work list: Notes and
    // Reminders are the reference adoptions; the rest are owed until they adopt the door.
    kept("calendar", Promise::Undo, "crates/core/src/act/inverse.rs"),
    kept("docs", Promise::Undo, "crates/core/src/act/inverse.rs"),
    owed("health", Promise::Undo, UNDO_DOOR_OWED),
    owed("locker", Promise::Undo, UNDO_DOOR_OWED),
    owed("money", Promise::Undo, UNDO_DOOR_OWED),
    kept("notes", Promise::Undo, "crates/core/src/act/inverse.rs"),
    owed("people", Promise::Undo, UNDO_DOOR_OWED),
    owed("photos", Promise::Undo, UNDO_DOOR_OWED),
    kept("reminders", Promise::Undo, "crates/core/src/act/inverse.rs"),
    // History (#1185, Phase 1): People is the reference adoption; the checker's gaps are the
    // others' work list.
    kept(
        "calendar",
        Promise::History,
        "crates/screens/src/calendar/earlier.rs",
    ),
    kept(
        "docs",
        Promise::History,
        "crates/screens/src/docs/earlier.rs",
    ),
    kept(
        "health",
        Promise::History,
        "crates/screens/src/health/earlier.rs",
    ),
    kept(
        "locker",
        Promise::History,
        "crates/screens/src/locker/earlier.rs",
    ),
    kept(
        "money",
        Promise::History,
        "crates/screens/src/money/earlier.rs",
    ),
    // The note's entry is a row of its menu ([`MENU_ENTRY`]): the editor has no rows to end in.
    kept(
        "notes",
        Promise::History,
        "crates/screens/src/notes/earlier.rs",
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
    // Arrive (#1185, Phase 2): the vault side is one helper (`commands/arrival.rs`); an app keeps
    // the promise when every path of its own that brings items in passes `arrived`. Calendar,
    // Health and Money bring items in only through a follow pass or a statement, and the vault
    // records those origins itself.
    kept(
        "calendar",
        Promise::Arrive,
        "crates/vault/src/commands/follow.rs",
    ),
    kept(
        "docs",
        Promise::Arrive,
        "crates/screens/src/docs/drive/ingest.rs",
    ),
    kept(
        "health",
        Promise::Arrive,
        "crates/vault/src/commands/follow.rs",
    ),
    kept(
        "locker",
        Promise::Arrive,
        "crates/core/src/locker/transfer.rs",
    ),
    kept(
        "money",
        Promise::Arrive,
        "crates/vault/src/commands/money.rs",
    ),
    kept(
        "notes",
        Promise::Arrive,
        "crates/screens/src/notes/transfer.rs",
    ),
    kept(
        "people",
        Promise::Arrive,
        "crates/screens/src/people/transfer.rs",
    ),
    kept(
        "photos",
        Promise::Arrive,
        "crates/screens/src/imports/camera_roll.rs",
    ),
    kept(
        "reminders",
        Promise::Arrive,
        "crates/screens/src/imports/reminders.rs",
    ),
    // Export and Share (#1185, take out): the kit's `ExportSpec` screen and share helper; the
    // checkers' gaps are the adopters' work list.
    kept(
        "calendar",
        Promise::Export,
        "crates/screens/src/calendar/export.rs",
    ),
    owed("docs", Promise::Export, EXPORT_OWED),
    kept(
        "health",
        Promise::Export,
        "crates/screens/src/health/export.rs",
    ),
    // Locker's export keeps its own machine ([`OWN_EXPORT`]).
    kept(
        "locker",
        Promise::Export,
        "crates/screens/src/locker/transfer.rs",
    ),
    kept(
        "money",
        Promise::Export,
        "crates/screens/src/money/export.rs",
    ),
    kept(
        "notes",
        Promise::Export,
        "crates/screens/src/notes/export.rs",
    ),
    kept(
        "people",
        Promise::Export,
        "crates/screens/src/people/export.rs",
    ),
    owed("photos", Promise::Export, EXPORT_OWED),
    kept(
        "reminders",
        Promise::Export,
        "crates/screens/src/reminders/export.rs",
    ),
    kept(
        "calendar",
        Promise::Share,
        "crates/screens/src/calendar/event.rs",
    ),
    kept(
        "docs",
        Promise::Share,
        "crates/screens/src/docs/document.rs",
    ),
    kept(
        "health",
        Promise::Share,
        "crates/screens/src/health/workout.rs",
    ),
    kept(
        "locker",
        Promise::Share,
        "crates/screens/src/locker/item.rs",
    ),
    kept(
        "money",
        Promise::Share,
        "crates/screens/src/money/transaction.rs",
    ),
    kept(
        "notes",
        Promise::Share,
        "crates/screens/src/notes/editor.rs",
    ),
    kept(
        "people",
        Promise::Share,
        "crates/screens/src/people/person/mod.rs",
    ),
    kept(
        "photos",
        Promise::Share,
        "crates/screens/src/photos/lightbox.rs",
    ),
    kept(
        "reminders",
        Promise::Share,
        "crates/screens/src/reminders/detail.rs",
    ),
    // OwnerCheck (#1185, "Confirm it's me"): one gate in the kit; a row is Owed while a screen
    // hands member data to the OS without it.
    kept(
        "calendar",
        Promise::OwnerCheck,
        "crates/screens/src/calendar/mod.rs",
    ),
    kept(
        "docs",
        Promise::OwnerCheck,
        "crates/screens/src/docs/document.rs",
    ),
    kept(
        "health",
        Promise::OwnerCheck,
        "crates/screens/src/health/mod.rs",
    ),
    kept(
        "locker",
        Promise::OwnerCheck,
        "crates/screens/src/locker/transfer.rs",
    ),
    kept(
        "money",
        Promise::OwnerCheck,
        "crates/screens/src/money/mod.rs",
    ),
    kept(
        "notes",
        Promise::OwnerCheck,
        "crates/screens/src/notes/mod.rs",
    ),
    kept(
        "people",
        Promise::OwnerCheck,
        "crates/screens/src/people/mod.rs",
    ),
    kept(
        "photos",
        Promise::OwnerCheck,
        "crates/screens/src/photos/lightbox.rs",
    ),
    kept(
        "reminders",
        Promise::OwnerCheck,
        "crates/screens/src/reminders/mod.rs",
    ),
    // Attach (#1185): the manifest's trio and the shared section on each primary detail page.
    kept(
        "calendar",
        Promise::Attach,
        "crates/screens/src/calendar/event.rs",
    ),
    owed("docs", Promise::Attach, ATTACH_OWED),
    owed("health", Promise::Attach, ATTACH_OWED),
    exempt("locker", Promise::Attach, ATTACH_EXEMPT[0].1),
    owed("money", Promise::Attach, ATTACH_OWED),
    owed("notes", Promise::Attach, ATTACH_OWED),
    owed("people", Promise::Attach, ATTACH_OWED),
    owed("photos", Promise::Attach, ATTACH_OWED),
    kept(
        "reminders",
        Promise::Attach,
        "crates/screens/src/reminders/detail.rs",
    ),
    // Origin (#1185, Phase 2B): the detail screen's "From ..." line; the checker's gaps are the
    // adopters' work list.
    kept(
        "calendar",
        Promise::Origin,
        "crates/screens/src/calendar/earlier.rs",
    ),
    kept(
        "docs",
        Promise::Origin,
        "crates/screens/src/docs/earlier.rs",
    ),
    kept(
        "health",
        Promise::Origin,
        "crates/screens/src/health/earlier.rs",
    ),
    kept(
        "locker",
        Promise::Origin,
        "crates/screens/src/locker/earlier.rs",
    ),
    kept(
        "money",
        Promise::Origin,
        "crates/screens/src/money/earlier.rs",
    ),
    kept(
        "notes",
        Promise::Origin,
        "crates/screens/src/notes/earlier.rs",
    ),
    kept(
        "people",
        Promise::Origin,
        "crates/screens/src/people/earlier.rs",
    ),
    kept(
        "photos",
        Promise::Origin,
        "crates/screens/src/photos/earlier.rs",
    ),
    kept(
        "reminders",
        Promise::Origin,
        "crates/screens/src/reminders/earlier.rs",
    ),
    // Link (#1185): the manifest's verbs and the shared "Linked to" section on each detail page.
    owed("calendar", Promise::Link, LINK_OWED),
    owed("docs", Promise::Link, LINK_OWED),
    owed("health", Promise::Link, LINK_OWED),
    owed("locker", Promise::Link, LINK_OWED),
    owed("money", Promise::Link, LINK_OWED),
    owed("notes", Promise::Link, LINK_OWED),
    owed("people", Promise::Link, LINK_OWED),
    owed("photos", Promise::Link, LINK_OWED),
    owed("reminders", Promise::Link, LINK_OWED),
];

const EXPORT_OWED: &str = "no export screen on the kit's ExportSpec (#1185)";

const LINK_OWED: &str = "the detail screen does not embed the kit's general \"Linked to\" section (`kit::links::read_linked`) yet (#1185)";

const UNITS_PROOF: &str = "crates/screens/src/kit/quantity.rs";

const ATTACH_OWED: &str =
    "the detail screen does not embed the kit's attachments section yet (#1185)";

const fn exempt(app: &'static str, promise: Promise, ruling: &'static str) -> Row {
    Row {
        app,
        promise,
        status: Status::Exempt(ruling),
    }
}

/// The apps whose items hold no attachments, with the ruling that says so (the Attach promise's
/// only exceptions). A Locker item is sealed: a photo or file beside it would sit outside the seal.
pub const ATTACH_EXEMPT: &[(&str, &str)] =
    &[("locker", "D11: a Locker item cannot hold attachments")];

const UNDO_DOOR_OWED: &str = "screens still write straight to `kit::act::act`; rule C wants every write through `kit::undo` so each undoable action offers Undo (#1185)";

/// `promises`: the table is complete, and every row is true.
pub fn promises(root: &Path) -> RuleReport {
    let mut report = check(root, REGISTER);
    // The restore and recovery-words screens are not an app, so no row holds them.
    report.findings.extend(owner_custody_missing(root));
    report
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
            Status::Exempt(ruling) => {
                let named = ATTACH_EXEMPT
                    .iter()
                    .any(|(app, said)| *app == row.app && *said == ruling);
                if row.promise != Promise::Attach || !named {
                    findings.push(format!(
                        "{} / {}: Exempt, but `{ruling}` is not a ruling listed in ATTACH_EXEMPT",
                        row.app,
                        row.promise.name()
                    ));
                }
                for gap in lacking {
                    findings.push(format!(
                        "{} / {}: claimed Exempt ({ruling}), but {gap}",
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
        Promise::Units => units_missing(root, app),
        Promise::Trash => trash_missing(root, app),
        Promise::Undo => undo_missing(root, app),
        Promise::History => history_missing(root, app),
        Promise::Arrive => arrive_missing(root, app),
        Promise::Export => export_missing(root, app),
        Promise::Share => share_missing(root, app),
        Promise::OwnerCheck => owner_check_missing(root, app),
        Promise::Attach => attach_missing(root, app),
        Promise::Origin => origin_missing(root, app),
        Promise::Link => link_missing(root, app),
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
    /// `"writes_nothing": true`: there is nothing to take back. The core's tests prove the claim
    /// by running the action (`crates/core/tests/undo_plane.rs`), so the register trusts it.
    writes_nothing: bool,
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
                        writes_nothing: action
                            .get("writes_nothing")
                            .and_then(serde_json::Value::as_bool)
                            == Some(true),
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

/// The folders under `crates/screens/src` whose files are `app`'s screens (rule C reads them).
/// Reminders and Calendar share the agenda's notification service and the schedule kit, so each
/// answers for them; the kit's own doors (`kit/undo.rs`, `kit/act.rs`) are not an app's.
fn undo_folders(app: &str) -> Vec<&'static str> {
    match app {
        "calendar" => vec!["calendar", "agenda", "kit/schedule"],
        "reminders" => vec!["reminders", "agenda", "kit/schedule"],
        "docs" => vec!["docs"],
        "health" => vec!["health"],
        "locker" => vec!["locker"],
        "money" => vec!["money"],
        "notes" => vec!["notes"],
        "people" => vec!["people"],
        "photos" => vec!["photos"],
        _ => Vec::new(),
    }
}

/// What a direct write looks like: `kit_act::act(`, `kit::act::act(`, `act::act(` and the
/// context's own `ctx.act(`.
const DIRECT_WRITES: [&str; 2] = ["act::act(", "ctx.act("];

/// The marker that exempts one call: `// undo-exempt: <why its Undo is offered elsewhere>`, on the
/// call's line or one of the three above it. A marker with no reason exempts nothing.
const UNDO_EXEMPT: &str = "undo-exempt:";

/// Rule C: the calls an app's screen files make straight to the write door, each as
/// `<file>: (C) line N ...`. Test modules and `tests.rs` files are not screens.
fn direct_writes(root: &Path, app: &str) -> Vec<String> {
    let mut gaps = Vec::new();
    for folder in undo_folders(app) {
        let dir = root.join(format!("crates/screens/src/{folder}"));
        for file in source_files(&dir, "rs") {
            if file.file_name().is_some_and(|name| name == "tests.rs")
                || file.components().any(|part| part.as_os_str() == "tests")
            {
                continue;
            }
            let Ok(text) = fs::read_to_string(&file) else {
                continue;
            };
            let live = text.split("#[cfg(test)]").next().unwrap_or_default();
            let lines: Vec<&str> = live.lines().collect();
            for (at, line) in lines.iter().enumerate() {
                if line.trim_start().starts_with("//")
                    || !DIRECT_WRITES.iter().any(|call| line.contains(call))
                {
                    continue;
                }
                let exempt = lines[at.saturating_sub(3)..=at].iter().any(|near| {
                    near.split_once(UNDO_EXEMPT)
                        .is_some_and(|(_, why)| !why.trim().is_empty())
                });
                if !exempt {
                    gaps.push(format!(
                        "{}: (C) line {} writes straight to the door; go through `kit::undo` (`Undo::act`), or mark the call `// {UNDO_EXEMPT} <why its Undo is offered elsewhere>`",
                        relative(root, &file),
                        at + 1
                    ));
                }
            }
        }
    }
    gaps
}

/// Undo is kept when, for `app`, all three hold (each gap is `<action>: (A|B) what is missing`, or
/// `<file>: (C) ...`):
///
/// A. every manifest action is classified: it has a row in the core's inverse table
///    ([`INVERSE_TABLE`]), or it is `confirmed` in the manifest (irreversible, asked first), or it
///    declares `"writes_nothing": true` (nothing to take back; the core's tests prove it by running
///    the action). An action that is several is fine; one that is none is a gap.
/// B. the manifest and the table are one list: every inverse the manifest declares is the row the
///    table holds for that action, and every row of the table is the inverse its manifest names.
///
/// C. no file of the app's screen folders ([`undo_folders`]) calls the write door directly
///    (`kit::act::act`, `ctx.act`): every write goes through `kit::undo`'s door (`Undo::act`),
///    which says what happened with "Undo" exactly when the core answered with an inverse, and
///    whose `acted` runs it. This is true by construction, not a guess about where a status line
///    is set: a screen that cannot write except through the door cannot forget the Undo. A call
///    whose Undo is offered elsewhere (a notification's receipt, the kit trash's restore) says so
///    on a `// undo-exempt: <why>` comment, which this reads.
///
/// Not checked, and why: that a screen DRAWS the door's line (`status: self.undo.status()`) and
/// takes the kit's `StatusActed`. The shells' parity rule and the `undo_line` tests hold those;
/// a text scan of the view would be a guess.
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
        if row.is_none() && !action.confirmed && !action.writes_nothing {
            unclassified.push(format!(
                "{name}: (A) has no inverse in {INVERSE_TABLE}, is not `confirmed` and does not declare `writes_nothing` in the manifest"
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
    let direct = direct_writes(root, app);
    if unclassified.is_empty() && mismatched.is_empty() && direct.is_empty() {
        return Vec::new();
    }
    let mut gaps = vec![format!(
        "summary: {} of {} actions unclassified (A), {} list mismatches (B), {} direct writes (C)",
        unclassified.len(),
        actions.len(),
        mismatched.len(),
        direct.len()
    )];
    gaps.extend(unclassified);
    gaps.extend(mismatched);
    gaps.extend(direct);
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

/// A DETAIL PAGE WHOSE ENTRY IS A MENU ROW, not a foot (#1185).
///
/// A page of rows ends in "Earlier versions   2 ›". A full-screen editor has no rows and no foot,
/// so Notes keeps the entry as the row of the note's menu, the menu's existing shape (a label, a
/// route, a count). It is declared HERE, by name, so the register cannot grow a second placement by
/// accident, and it is held to MORE than a foot: the page still reads the shared count
/// (`earlier::foot(` over the app's `EARLIER` route), and in the same screen the entry is handed to
/// the view state ([`MenuEntry::entry`]) beside the menu's own label ([`MenuEntry::menu`]). Every
/// other app is held to the foot, whatever it has in its folder.
pub struct MenuEntry {
    pub app: &'static str,
    /// The primary kind whose page this is (a key of [`HISTORY_KINDS`]).
    pub kind: &'static str,
    /// What the page spells to hand the entry to its view state.
    pub entry: &'static str,
    /// What the page spells for the menu the entry sits in.
    pub menu: &'static str,
}

/// The menu entries. Only Notes: an editor with no detail rows.
pub const MENU_ENTRY: &[MenuEntry] = &[MenuEntry {
    app: "notes",
    kind: "note",
    entry: "state.earlier = ",
    menu: "menu_label",
}];

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
    history_missing_in(root, app, MENU_ENTRY)
}

/// [`history_missing`] over a stated list of menu entries (a fixture states its own).
fn history_missing_in(root: &Path, app: &str, menus: &[MenuEntry]) -> Vec<String> {
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
        if let Some(menu) = menus
            .iter()
            .find(|menu| menu.app == app && menu.kind == *kind)
            && (!text.contains(menu.entry) || !text.contains(menu.menu))
        {
            gaps.push(format!(
                "crates/screens/src/{app}/{screen}: the {kind} page declares its entry as a menu row but does not hand it to the view (`{}`) beside the menu (`{}`)",
                menu.entry.trim(),
                menu.menu
            ));
        }
    }
    gaps
}

// ---------------------------------------------------------------------------
// Origin
// ---------------------------------------------------------------------------

/// Origin is kept when `kit/earlier.rs` reads the shared origin with the count (`origin::read(`
/// from `kit::origin`, so one read and one sentence for every page) and, for `app`, the detail
/// screen of each primary kind ([`HISTORY_KINDS`], the same files that carry the Earlier versions
/// entry) hands the foot's line to its view (`earlier.origin`), so no page words its own "where
/// from".
fn origin_missing(root: &Path, app: &str) -> Vec<String> {
    let mut gaps = Vec::new();
    let reads = live_source(&root.join("crates/screens/src/kit/earlier.rs"))
        .is_some_and(|text| text.contains("origin::read("));
    if !reads {
        gaps.push(
            "crates/screens/src/kit/earlier.rs does not read where the record came from (`origin::read(` from kit::origin)"
                .to_owned(),
        );
    }
    let dir = root.join("crates/screens/src").join(app);
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
        if !text.contains("earlier.origin") {
            gaps.push(format!(
                "crates/screens/src/{app}/{screen}: the {kind} page does not hand the foot's origin line to its view (`earlier.origin`)"
            ));
        }
    }
    gaps
}

// ---------------------------------------------------------------------------
// Arrive
// ---------------------------------------------------------------------------

/// One path that brings items into the vault by something other than typing.
pub struct ArrivalSite {
    pub app: &'static str,
    /// The file that makes the call, from the repository root.
    pub file: &'static str,
    /// What the file spells where it adds the item: the catalog's action struct
    /// (`act::photos::Upload`) or, in the core, the command's name.
    pub call: &'static str,
    /// The way in, for the sentence.
    pub path: &'static str,
}

/// THE ARRIVAL PATHS, by name. Each must still make its call and pass `arrived` to it. A path
/// that is not listed is found by [`arrival_named`] when it lives in an arrival-shaped file; one
/// that hides elsewhere is a row to add here.
pub const ARRIVAL_SITES: &[ArrivalSite] = &[
    ArrivalSite {
        app: "docs",
        file: "crates/screens/src/docs/drive/ingest.rs",
        call: "act::docs::Upload",
        path: "a scan or an upload into Docs",
    },
    ArrivalSite {
        app: "docs",
        file: "crates/screens/src/kit/attachments.rs",
        call: "act::docs::Upload",
        path: "a file picked to attach",
    },
    ArrivalSite {
        app: "locker",
        file: "crates/core/src/locker/transfer.rs",
        call: "\"locker.add_item\"",
        path: "the Locker CSV import",
    },
    ArrivalSite {
        app: "notes",
        file: "crates/screens/src/notes/transfer.rs",
        call: "act::notes::ImportNotes",
        path: "the Markdown import",
    },
    ArrivalSite {
        app: "people",
        file: "crates/screens/src/people/transfer.rs",
        call: "act::people::ImportVcf",
        path: "the vCard import",
    },
    ArrivalSite {
        app: "photos",
        file: "crates/screens/src/imports/camera_roll.rs",
        call: "act::photos::Upload",
        path: "the camera roll",
    },
    ArrivalSite {
        app: "photos",
        file: "crates/screens/src/kit/attachments.rs",
        call: "act::photos::Upload",
        path: "a photo picked to attach",
    },
];

/// The catalog structs of the app's actions whose input takes `arrived` (the manifest says which
/// commands can record an arrival: `<app>/manifest.json` declares the property on each).
fn arrival_structs(root: &Path, app: &str) -> Vec<String> {
    let path = root.join(format!("crates/apps/{app}/manifest.json"));
    let Some(value) = fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
    else {
        return Vec::new();
    };
    value
        .get("actions")
        .and_then(|actions| actions.as_array())
        .map(|actions| {
            actions
                .iter()
                .filter(|action| {
                    action
                        .pointer("/input/properties/arrived_system")
                        .is_some_and(|property| property.is_object())
                })
                .filter_map(|action| action.get("name")?.as_str().map(pascal))
                .collect()
        })
        .unwrap_or_default()
}

/// Whether a screens file is shaped like an arrival: it lives in `imports/`, or it is a
/// `transfer`, `ingest` or `import` screen.
fn arrival_named(relative_path: &str) -> bool {
    let stem = relative_path
        .rsplit('/')
        .next()
        .and_then(|name| name.strip_suffix(".rs"))
        .unwrap_or_default();
    relative_path.contains("/imports/") || matches!(stem, "transfer" | "ingest" | "import")
}

/// Arrive is kept when, for `app`:
///
/// 1. every declared arrival path ([`ARRIVAL_SITES`]) still makes its call and spells `arrived`
///    (the typed fields of the manifest's action, or the command's input in the core);
/// 2. no arrival-shaped screens file ([`arrival_named`]) that builds one of the app's actions that
///    takes `arrived` is missing from that list, so a new import cannot arrive unrecorded.
///
/// An app with no action that takes `arrived` (Calendar, Health and Money: a follow pass or a
/// statement writes its own origin in the vault) and no listed path has nothing to pass.
fn arrive_missing(root: &Path, app: &str) -> Vec<String> {
    arrive_missing_in(root, app, ARRIVAL_SITES)
}

fn arrive_missing_in(root: &Path, app: &str, sites: &[ArrivalSite]) -> Vec<String> {
    let mut gaps = Vec::new();
    for site in sites.iter().filter(|site| site.app == app) {
        match live_source(&root.join(site.file)) {
            None => gaps.push(format!(
                "{}: {} is listed as an arrival path of {app} but the file is missing",
                site.file, site.path
            )),
            Some(text) if !text.contains(site.call) => gaps.push(format!(
                "{}: {} is listed as an arrival path of {app} but no longer calls `{}`",
                site.file, site.path, site.call
            )),
            Some(text) if !text.contains("arrived") => gaps.push(format!(
                "{}: {} calls `{}` without passing `arrived`",
                site.file, site.path, site.call
            )),
            Some(_) => {}
        }
    }
    let takes = arrival_structs(root, app);
    let screens = root.join("crates/screens/src");
    for file in source_files(&screens, "rs") {
        let rel = relative(root, &file);
        let shown = rel.trim_start_matches("crates/screens/src");
        if !arrival_named(shown)
            || rel.ends_with("catalog.rs")
            || sites.iter().any(|site| site.app == app && site.file == rel)
        {
            continue;
        }
        let Some(text) = live_source(&file) else {
            continue;
        };
        for ident in act_idents(&text, app) {
            if takes.contains(&ident) {
                gaps.push(format!(
                    "{rel}: builds `act::{app}::{ident}` in an arrival-shaped file that ARRIVAL_SITES does not list; list it and pass `arrived`"
                ));
            }
        }
    }
    gaps
}

// ---------------------------------------------------------------------------
// Export and Share (take out)
// ---------------------------------------------------------------------------

/// What the export spec literal must set: the app, the page's words, the gate, the rows, the
/// call and what happens on a phone with no passcode.
const EXPORT_SPEC_FIELDS: [&str; 8] = [
    "app",
    "title",
    "lede",
    "back_label",
    "denied",
    "choices",
    "export",
    "no_passcode",
];

/// AN EXPORT THAT KEEPS ITS OWN MACHINE, declared by name (D11, D15). Locker's export is a mass
/// reveal behind its own owner check that REFUSES on a phone with no passcode, so it is not a kit
/// `ExportSpec` screen yet. It is held to less than the kit and named here so the register cannot
/// grow a second shape by accident: the screen file exists, is registered as `<app>.export`, and a
/// screen other than it routes to it.
pub struct OwnExport {
    pub app: &'static str,
    /// The screen's file under `crates/screens/src/<app>/`.
    pub file: &'static str,
    pub reason: &'static str,
}

/// The exports that keep their own machine. Only Locker.
pub const OWN_EXPORT: &[OwnExport] = &[OwnExport {
    app: "locker",
    file: "transfer.rs",
    reason: "a mass reveal of secrets behind its own owner check, refused on a phone with no passcode (D15)",
}];

/// Export is kept when, for `app`:
///
/// 1. `crates/screens/src/<app>/export.rs` defines an `ExportSpec` built on `kit::export`, with
///    every field of [`EXPORT_SPEC_FIELDS`];
/// 2. the app's `mod.rs` registers it (`export::build` under `"<app>.export"`);
/// 3. a screen other than the export reaches it through the kit's one entry (`export::entry(`);
/// 4. every `act::<app>::X` the spec calls is a manifest action that declares
///    `"writes_nothing": true` (an export writes nothing, so there is nothing to take back).
///
/// An app named in [`OWN_EXPORT`] is held to its own file, its registration and its entry.
fn export_missing(root: &Path, app: &str) -> Vec<String> {
    export_missing_in(root, app, OWN_EXPORT)
}

fn export_missing_in(root: &Path, app: &str, own: &[OwnExport]) -> Vec<String> {
    let mut gaps = Vec::new();
    let dir = root.join("crates/screens/src").join(app);
    let own = own.iter().find(|own| own.app == app);
    let file = own.map_or("export.rs", |own| own.file);
    let spec_path = dir.join(file);
    let spec_rel = format!("crates/screens/src/{app}/{file}");

    // 1. the spec
    let mut called = Vec::new();
    match live_source(&spec_path) {
        None => gaps.push(format!(
            "{spec_rel} is missing: no export screen built on kit::export::ExportSpec{}",
            own.map_or_else(String::new, |own| format!(
                " (declared its own: {})",
                own.reason
            ))
        )),
        Some(_) if own.is_some() => {}
        Some(text) => {
            if !text.contains("kit::export") || !text.contains("ExportSpec") {
                gaps.push(format!(
                    "{spec_rel} does not define an ExportSpec built on kit::export"
                ));
            }
            for field in EXPORT_SPEC_FIELDS {
                if !spec_sets(&text, field) {
                    gaps.push(format!("{spec_rel}: the spec has no `{field}`"));
                }
            }
            called = act_idents(&text, app)
                .into_iter()
                .filter(|ident| ident != "APP")
                .collect();
        }
    }

    // 2. registered under the app's own name
    let registered = live_source(&dir.join("mod.rs")).is_some_and(|text| {
        text.contains(if own.is_some() {
            "transfer::build_export"
        } else {
            "export::build"
        }) && text.contains(&format!("\"{app}.export\""))
    });
    if !registered {
        gaps.push(format!(
            "crates/screens/src/{app}/mod.rs does not register the screen (under \"{app}.export\")"
        ));
    }

    // 3. one entry from another screen
    let entered = source_files(&dir, "rs")
        .into_iter()
        .filter(|path| *path != spec_path)
        .filter_map(|path| live_source(&path))
        .any(|text| {
            if own.is_some() {
                text.contains("more_export")
            } else {
                text.contains("export::entry(")
            }
        });
    if !entered {
        gaps.push(format!(
            "crates/screens/src/{app}/: no screen reaches the export through the kit's one entry (`export::entry(`)"
        ));
    }

    // 4. what the spec calls writes nothing
    if own.is_none() && spec_path.is_file() {
        let actions = undo_actions(root, app);
        if actions.is_empty() {
            gaps.push(format!("crates/apps/{app}/manifest.json could not be read"));
        }
        if called.is_empty() {
            gaps.push(format!("{spec_rel}: the spec calls no manifest action"));
        }
        for ident in called {
            match actions.iter().find(|action| pascal(&action.name) == ident) {
                None => gaps.push(format!(
                    "{spec_rel}: calls `act::{app}::{ident}`, which is not a manifest action"
                )),
                Some(action) if !action.writes_nothing => gaps.push(format!(
                    "crates/apps/{app}/manifest.json: `{}` is called by the export but does not declare `\"writes_nothing\": true`",
                    action.name
                )),
                Some(_) => {}
            }
        }
    }
    gaps
}

/// A SHARE THAT IS NOT THE KIT'S HELPER, declared by name: the two apps whose records already
/// have a file or a photograph the platform's share sheet takes straight from the store (Docs'
/// `ShareFile`, Photos' `ExportOriginals`), on the detail screen named.
pub struct OwnShare {
    pub app: &'static str,
    /// The detail screen's file under `crates/screens/src/<app>/`.
    pub screen: &'static str,
    /// The effect the screen raises.
    pub effect: &'static str,
}

/// The shares that use an effect of their own.
pub const OWN_SHARE: &[OwnShare] = &[
    OwnShare {
        app: "docs",
        screen: "document.rs",
        effect: "ShareFile",
    },
    OwnShare {
        app: "photos",
        screen: "lightbox.rs",
        effect: "ExportOriginals",
    },
];

/// NO SHARE, BY DECISION (D11): a Locker item cannot be handed to another app; its contents leave
/// only through its own export. Declared by name with the reason; the checker holds the app's
/// screens to NOT sharing.
pub struct NoShare {
    pub app: &'static str,
    pub reason: &'static str,
}

pub const NO_SHARE: &[NoShare] = &[NoShare {
    app: "locker",
    reason: "D11: a Locker item cannot be handed to another app; its contents leave only through its export",
}];

/// What a screen spells to hand something to the OS.
const SHARE_EFFECTS: [&str; 4] = ["ShareFile", "ShareBytes", "ExportOriginals", "kit::share"];

/// Share is kept when, for `app`:
///
/// - an app in [`NO_SHARE`] has no screen that shares anything ([`SHARE_EFFECTS`]);
/// - an app in [`OWN_SHARE`] raises its named effect on its detail screen;
/// - every other app's detail screen of each primary kind ([`HISTORY_KINDS`]) uses the kit's share
///   helper (`kit::share`), which asks the owner check before the item leaves.
fn share_missing(root: &Path, app: &str) -> Vec<String> {
    share_missing_in(root, app, OWN_SHARE, NO_SHARE)
}

fn screen_text(dir: &Path, screen: &str) -> String {
    let path = dir.join(screen);
    let files = if path.is_dir() {
        source_files(&path, "rs")
    } else {
        vec![path]
    };
    files
        .iter()
        .filter_map(|file| live_source(file))
        .collect::<Vec<_>>()
        .join("\n")
}

fn share_missing_in(root: &Path, app: &str, own: &[OwnShare], none: &[NoShare]) -> Vec<String> {
    let dir = root.join("crates/screens/src").join(app);
    let mut gaps = Vec::new();
    if let Some(no) = none.iter().find(|no| no.app == app) {
        for file in source_files(&dir, "rs") {
            let Some(text) = live_source(&file) else {
                continue;
            };
            for effect in SHARE_EFFECTS {
                if text.contains(effect) {
                    gaps.push(format!(
                        "{}: shares with `{effect}`, but {app} has no share by decision ({})",
                        relative(root, &file),
                        no.reason
                    ));
                }
            }
        }
        return gaps;
    }
    if let Some(own) = own.iter().find(|own| own.app == app) {
        if !screen_text(&dir, own.screen).contains(own.effect) {
            gaps.push(format!(
                "crates/screens/src/{app}/{}: the detail screen does not raise `{}`",
                own.screen, own.effect
            ));
        }
        return gaps;
    }
    let kinds = HISTORY_KINDS
        .iter()
        .find(|(name, _)| *name == app)
        .map_or(&[][..], |(_, kinds)| *kinds);
    for (kind, screen) in kinds {
        if !screen_text(&dir, screen).contains("kit::share") {
            gaps.push(format!(
                "crates/screens/src/{app}/{screen}: the {kind} page does not hand the item to the OS through the kit's share helper (`kit::share`)"
            ));
        }
    }
    gaps
}

// ---------------------------------------------------------------------------
// Units
// ---------------------------------------------------------------------------

/// What an app spells when it words a measure by hand, and what that is (#1185): a byte size
/// through the vault's phrase or an app's own, a size the core already worded, health's own
/// formatters, or the region read for units. Each is replaced by a `kit::quantity::Quantity` shown
/// through `ctx.units()`.
const HAND_MEASURES: [(&str, &str); 11] = [
    ("format_byte_size", "words a byte size itself"),
    ("bytes_phrase(", "words a byte size itself"),
    ("drain_bytes(", "words a byte size itself"),
    (".size.clone()", "shows a size the core worded"),
    ("Units::of(", "picks its own units from the region"),
    (
        "figures::distance(",
        "words a distance with health's own formatter",
    ),
    (
        "figures::climb(",
        "words a climb with health's own formatter",
    ),
    ("figures::pace(", "words a pace with health's own formatter"),
    (
        "figures::figure(",
        "words a figure with health's own formatter",
    ),
    (
        "figures::phrase(",
        "words a figure with health's own formatter",
    ),
    (
        "figures::duration(",
        "words a duration with health's own formatter",
    ),
];

/// A file several apps share, and what an app spells to use it: its hand-worded measures are
/// theirs too.
const SHARED_MEASURERS: [(&str, &str); 1] = [(
    "kit::attachments::",
    "crates/screens/src/kit/attachments.rs",
)];

/// The units promise is kept when, for `app`, no file under `crates/screens/src/<app>/` (and no
/// file it shares, [`SHARED_MEASURERS`]) spells a hand-worded measure ([`HAND_MEASURES`]). A scan
/// of live code only: a comment or a test module does not count.
///
/// Not checked, and why: that every number an app shows IS a quantity. A figure worded from a
/// bare `f64` in a way none of the needles names would pass; the adopters' tests hold that.
fn units_missing(root: &Path, app: &str) -> Vec<String> {
    let mut gaps = Vec::new();
    let dir = root.join("crates/screens/src").join(app);
    let mut shared: BTreeSet<&str> = BTreeSet::new();
    for file in source_files(&dir, "rs") {
        let Some(text) = live_source(&file) else {
            continue;
        };
        let rel = relative(root, &file);
        for (needle, what) in HAND_MEASURES {
            if text.contains(needle) {
                gaps.push(format!("{rel} {what} (`{needle}`); use kit::quantity"));
            }
        }
        for (needle, path) in SHARED_MEASURERS {
            if text.contains(needle) {
                shared.insert(path);
            }
        }
    }
    for path in shared {
        let Some(text) = live_source(&root.join(path)) else {
            continue;
        };
        for (needle, what) in HAND_MEASURES {
            if text.contains(needle) {
                gaps.push(format!(
                    "{path} {what} (`{needle}`), and {app} uses it; use kit::quantity"
                ));
            }
        }
    }
    gaps
}

// ---------------------------------------------------------------------------
// OwnerCheck (Confirm it's me)
// ---------------------------------------------------------------------------

/// What a screen spells to make something leave the phone in the clear.
const LEAVING_EFFECTS: [&str; 4] = [
    "Kind::SaveFile",
    "Kind::ShareFile",
    "Kind::ExportOriginals",
    "Kind::Share(",
];

/// What counts as asking the owner: the gate itself, or the kit machines that hold one.
const OWNER_GATES: [&str; 5] = [
    "kit::owner",
    "OwnerGate",
    "kit::export",
    "kit::share",
    "kit::transfer::ExportSpec",
];

/// A FILE THAT LEAVES THE GATE OUT, by name, with the reason.
pub struct OwnerException {
    /// The file under `crates/screens/src/`.
    pub file: &'static str,
    pub reason: &'static str,
}

/// The files exempt from the gate. Locker's wall is its own owner check (it also counts failed
/// unlocks and holds the session), so it stays its own machine; the recovery words' "Save a
/// copy" sits behind the check that showed them.
pub const OWNER_EXCEPTIONS: &[OwnerException] = &[OwnerException {
    file: "locker/wall.rs",
    reason: "Locker's own wall: its owner check opens the Locker and counts failed unlocks",
}];

/// The screens that start a restore or hand the recovery words out; not an app, so they are
/// held to the gate by this fixed list rather than by a row.
pub const OWNER_CUSTODY: [&str; 3] = [
    "crates/screens/src/custody/enter.rs",
    "crates/screens/src/custody/make.rs",
    "crates/screens/src/custody/show.rs",
];

/// OwnerCheck is kept when no live (non-test, non-comment) code under
/// `crates/screens/src/<app>/` makes something leave the phone ([`LEAVING_EFFECTS`]) in a file
/// that does not ask the owner ([`OWNER_GATES`]) and is not in [`OWNER_EXCEPTIONS`].
fn owner_check_missing(root: &Path, app: &str) -> Vec<String> {
    owner_check_missing_in(root, app, OWNER_EXCEPTIONS)
}

fn owner_check_missing_in(root: &Path, app: &str, exceptions: &[OwnerException]) -> Vec<String> {
    let dir = root.join("crates/screens/src").join(app);
    let mut gaps = Vec::new();
    for file in source_files(&dir, "rs") {
        let rel = relative(root, &file);
        let Some(text) = live_source(&file) else {
            continue;
        };
        let raised = LEAVING_EFFECTS
            .iter()
            .find(|effect| text.contains(**effect))
            .copied();
        let hand_made = text.contains("Kind::OwnerCheck") && !text.contains("kit::owner");
        if let Some(exception) = exceptions
            .iter()
            .find(|exception| rel.ends_with(&format!("src/{}", exception.file)))
        {
            // An exception that no longer raises anything is stale: say so, so the table
            // cannot keep a name the code no longer needs.
            if !hand_made && raised.is_none() {
                gaps.push(format!(
                    "{rel}: excepted from the owner gate ({}) but raises nothing; remove the exception",
                    exception.reason
                ));
            }
            continue;
        }
        if hand_made {
            gaps.push(format!(
                "{rel}: raises `Kind::OwnerCheck` by hand instead of the kit's gate (`kit::owner::OwnerGate`)"
            ));
        }
        let Some(effect) = raised else {
            continue;
        };
        if !OWNER_GATES.iter().any(|gate| text.contains(gate)) {
            gaps.push(format!(
                "{rel}: raises `{effect}` without asking the owner (`kit::owner::OwnerGate`)"
            ));
        }
    }
    gaps
}

/// The restore and recovery-words screens that stopped asking the owner.
pub fn owner_custody_missing(root: &Path) -> Vec<String> {
    OWNER_CUSTODY
        .iter()
        .filter(|rel| !live_source(&root.join(rel)).is_some_and(|text| text.contains("kit::owner")))
        .map(|rel| {
            format!("{rel}: a restore or the recovery words without the owner gate (`kit::owner`)")
        })
        .collect()
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

// ---------------------------------------------------------------------------
// Attach
// ---------------------------------------------------------------------------

/// The shared kit piece a detail screen embeds, by the path its `use` spells.
const ATTACH_PIECE: &str = "kit::attachments::";

/// Attach is kept when, for `app`:
///
/// 1. the manifest has `attach` (`edge.add`) and `detach` (`edge.remove`) actions, each the
///    other's declared inverse, and an `attachments` query;
/// 2. the core's inverse table carries the pair (`attach` and `detach`), so Undo stays Kept;
/// 3. the detail screen of each primary kind ([`HISTORY_KINDS`]) embeds the kit's one section
///    ([`ATTACH_PIECE`]).
///
/// An app in [`ATTACH_EXEMPT`] is held the other way: it fails when its manifest declares any of
/// the three, because the ruling says its items cannot hold attachments.
fn attach_missing(root: &Path, app: &str) -> Vec<String> {
    let manifest = format!("crates/apps/{app}/manifest.json");
    let actions = undo_actions(root, app);
    if actions.is_empty() {
        return vec![format!("{manifest} could not be read")];
    }
    let has_query = fs::read_to_string(root.join(&manifest))
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .and_then(|value| {
            value
                .get("queries")
                .and_then(serde_json::Value::as_array)
                .map(|queries| {
                    queries
                        .iter()
                        .any(|q| q.get("name").and_then(|n| n.as_str()) == Some("attachments"))
                })
        })
        .unwrap_or(false);
    let commands = manifest_actions(root, app);
    let action = |name: &str| actions.iter().find(|a| a.name == name);
    let command = |name: &str| {
        commands
            .iter()
            .find(|(action, _)| action == name)
            .map(|(_, command)| command.as_str())
    };
    if let Some((_, ruling)) = ATTACH_EXEMPT.iter().find(|(exempt, _)| *exempt == app) {
        let mut gaps = Vec::new();
        for name in ["attach", "detach"] {
            if action(name).is_some() {
                gaps.push(format!(
                    "{manifest} declares `{name}`, which the ruling forbids ({ruling})"
                ));
            }
        }
        if has_query {
            gaps.push(format!(
                "{manifest} declares an `attachments` read, which the ruling forbids ({ruling})"
            ));
        }
        return gaps;
    }

    let mut gaps = Vec::new();
    for (name, shared, other) in [
        ("attach", "edge.add", "detach"),
        ("detach", "edge.remove", "attach"),
    ] {
        match action(name) {
            None => gaps.push(format!("{manifest} declares no `{name}` action")),
            Some(found) => {
                if command(name) != Some(shared) {
                    gaps.push(format!("{manifest}: `{name}` does not run `{shared}`"));
                }
                if found.inverse.as_deref() != Some(other) {
                    gaps.push(format!(
                        "{manifest}: `{name}` does not declare `{other}` as its inverse"
                    ));
                }
            }
        }
    }
    if !has_query {
        gaps.push(format!("{manifest} declares no `attachments` query"));
    }
    let table = core_inverses(root, app).unwrap_or_default();
    for (name, inverse) in [("attach", "detach"), ("detach", "attach")] {
        if table.get(name).map(String::as_str) != Some(inverse) {
            gaps.push(format!(
                "{INVERSE_TABLE}: `{}` has no `{name}` row reversed by `{inverse}`",
                app.to_uppercase()
            ));
        }
    }
    let dir = root.join("crates/screens/src").join(app);
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
        if !text.contains(ATTACH_PIECE) {
            gaps.push(format!(
                "crates/screens/src/{app}/{screen}: the {kind} page does not embed the shared attachments section (`{ATTACH_PIECE}Attachments`)"
            ));
        }
    }
    gaps
}

// ---------------------------------------------------------------------------
// Link
// ---------------------------------------------------------------------------

/// The one entry point of the kit's general link section a detail screen calls to read what its
/// item is linked to (`kit::links::read_linked`). A screen that spells it embeds the section.
const LINK_PIECE: &str = "links::read_linked(";

/// The `(name, verb)` of every action of the app's manifest whose input takes `rel: "links"`
/// (a `rel` field whose enum holds `links`): the actions that can write a general link.
fn link_capable(root: &Path, app: &str) -> Vec<(String, String)> {
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
                .filter(|action| {
                    action
                        .pointer("/input/properties/rel/enum")
                        .and_then(serde_json::Value::as_array)
                        .is_some_and(|values| values.iter().any(|v| v == "links"))
                })
                .filter_map(|action| {
                    Some((
                        action.get("name")?.as_str()?.to_owned(),
                        action.get("verb")?.as_str()?.to_owned(),
                    ))
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Link is kept when, for `app`:
///
/// 1. the manifest has a `link` verb action and an `unlink` verb action that take `rel: "links"`
///    (the typed ones of Docs, Locker, Money and Photos, or the plain `link` and `unlink`), each
///    declaring the other as its inverse;
/// 2. both are classified for Undo, by the Undo rule's own notion: a row in the core's inverse
///    table that agrees with the manifest's declared inverse, or `confirmation` required, or
///    `writes_nothing`;
/// 3. the detail screen of each primary kind ([`HISTORY_KINDS`]) embeds the kit's general section,
///    which it shows by calling [`LINK_PIECE`].
///
/// A Locker item may start a link (it is only never a target), so Locker is held like any app.
fn link_missing(root: &Path, app: &str) -> Vec<String> {
    let manifest = format!("crates/apps/{app}/manifest.json");
    let actions = undo_actions(root, app);
    if actions.is_empty() {
        return vec![format!("{manifest} could not be read")];
    }
    let capable = link_capable(root, app);
    let is = |verb: &str, word: &str| verb == word || verb.starts_with(&format!("{word}:"));
    let table = core_inverses(root, app).unwrap_or_default();
    let classified = |action: &UndoAction| match table.get(&action.name) {
        Some(row) => action.inverse.as_deref() == Some(row.as_str()),
        None => action.confirmed || action.writes_nothing,
    };
    let pair = capable
        .iter()
        .filter(|(_, verb)| is(verb, "link"))
        .find_map(|(link, _)| {
            let link = actions.iter().find(|a| &a.name == link)?;
            let unlink = actions.iter().find(|a| {
                Some(a.name.as_str()) == link.inverse.as_deref()
                    && a.inverse.as_deref() == Some(link.name.as_str())
                    && capable
                        .iter()
                        .any(|(name, verb)| name == &a.name && is(verb, "unlink"))
            })?;
            Some((link, unlink))
        });
    let mut gaps = Vec::new();
    match pair {
        None => gaps.push(format!(
            "{manifest} declares no `link` and `unlink` pair of actions that take `rel: links`, each the other's inverse"
        )),
        Some((link, unlink)) => {
            for action in [link, unlink] {
                if !classified(action) {
                    gaps.push(format!(
                        "{INVERSE_TABLE}: `{}` is not classified for Undo (no agreeing inverse row, not confirmed, not `writes_nothing`)",
                        action.name
                    ));
                }
            }
        }
    }
    let dir = root.join("crates/screens/src").join(app);
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
        if !text.contains(LINK_PIECE) {
            gaps.push(format!(
                "crates/screens/src/{app}/{screen}: the {kind} page does not embed the kit's general \"Linked to\" section (`kit::{LINK_PIECE}`)"
            ));
        }
    }
    gaps
}

#[cfg(test)]
#[path = "promises_tests.rs"]
mod tests;
