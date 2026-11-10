//! Demonstrated reds for `promises`: a fixture app that keeps Trash is clean,
//! each gap is named with its file, and the ratchet fails both ways.

use std::fs;
use std::path::{Path, PathBuf};

use super::*;
use crate::testing::fixture_dir;

fn write(root: &Path, relative: &str, contents: &str) {
    let path = root.join(relative);
    fs::create_dir_all(path.parent().expect("a parent")).expect("create fixture dirs");
    fs::write(path, contents).expect("write fixture");
}

const SPEC: &str = r"use crate::kit::trash::{self, TrashSpec};
pub static SPEC: TrashSpec = TrashSpec {
    app: act::notes::APP,
    restore: |id| act::notes::RestoreNote { note_id: id.to_owned() }.into(),
    purge: |id| act::notes::PurgeNote { note_id: id.to_owned() }.into(),
    empty: || act::notes::EmptyTrash {}.into(),
};
";

const MANIFEST: &str = r#"{"actions":[
 {"name":"delete-note","command":"entity.trash"},
 {"name":"restore-note","command":"entity.restore"},
 {"name":"purge-note","command":"entity.purge"},
 {"name":"empty-trash","command":"entity.empty_trash"}]}"#;

/// A `notes` app that keeps Trash in full.
fn kept_tree(name: &str) -> PathBuf {
    let root = fixture_dir(name);
    write(&root, "crates/screens/src/notes/trash.rs", SPEC);
    write(
        &root,
        "crates/screens/src/notes/mod.rs",
        "registry().with(TRASH, trash::build)",
    );
    write(
        &root,
        "crates/screens/src/notes/home.rs",
        "fn more() { let r = routes::trash(); act::notes::DeleteNote {}; }",
    );
    write(&root, "crates/apps/notes/manifest.json", MANIFEST);
    root
}

fn lacking(root: &Path) -> String {
    trash_missing(root, "notes").join("\n")
}

#[test]
fn an_app_with_the_whole_promise_is_clean() {
    let root = kept_tree("promises-clean");
    assert_eq!(lacking(&root), "");
}

#[test]
fn a_spec_with_no_purge_and_no_empty_is_named() {
    let root = kept_tree("promises-no-destroy");
    write(
        &root,
        "crates/screens/src/notes/trash.rs",
        &SPEC
            .replace(
                "purge: |id| act::notes::PurgeNote { note_id: id.to_owned() }.into(),",
                "purge: None,",
            )
            .replace(
                "empty: || act::notes::EmptyTrash {}.into(),",
                "empty: None,",
            ),
    );
    let gaps = lacking(&root);
    assert!(gaps.contains("crates/screens/src/notes/trash.rs: the spec has no `purge`"));
    assert!(gaps.contains("the spec has no `empty`"));
    assert!(gaps.contains("reaches no `entity.purge` action"));
}

#[test]
fn no_trash_screen_is_named_by_file() {
    let root = kept_tree("promises-no-screen");
    fs::remove_file(root.join("crates/screens/src/notes/trash.rs")).expect("remove");
    assert!(lacking(&root).contains("crates/screens/src/notes/trash.rs is missing"));
}

#[test]
fn a_screen_never_routed_to_is_named() {
    let root = kept_tree("promises-no-route");
    write(
        &root,
        "crates/screens/src/notes/home.rs",
        "fn more() { act::notes::DeleteNote {}; }",
    );
    assert!(lacking(&root).contains("no screen routes to the trash"));
}

#[test]
fn a_test_module_does_not_route_or_move() {
    let root = kept_tree("promises-test-only");
    write(
        &root,
        "crates/screens/src/notes/home.rs",
        "#[cfg(test)]\nmod t { fn x() { routes::trash(); act::notes::DeleteNote {}; } }",
    );
    let gaps = lacking(&root);
    assert!(gaps.contains("no screen routes to the trash"));
    assert!(gaps.contains("no screen calls a move-to-trash action"));
}

#[test]
fn a_move_verb_no_screen_calls_is_named() {
    let root = kept_tree("promises-unused-verb");
    write(
        &root,
        "crates/screens/src/notes/home.rs",
        "fn more() { routes::trash(); }",
    );
    assert!(lacking(&root).contains("act::notes::DeleteNote"));
}

#[test]
fn a_manifest_without_the_shared_verbs_is_named() {
    let root = kept_tree("promises-manifest");
    write(
        &root,
        "crates/apps/notes/manifest.json",
        r#"{"actions":[{"name":"delete-note","command":"entity.trash"},{"name":"restore-note","command":"entity.restore"}]}"#,
    );
    let gaps = lacking(&root);
    assert!(gaps.contains("crates/apps/notes/manifest.json declares no `entity.purge` action"));
    assert!(gaps.contains("declares no `entity.empty_trash` action"));
    assert!(gaps.contains("reaches no `entity.purge` action"));
}

#[test]
fn a_registration_missing_from_mod_is_named() {
    let root = kept_tree("promises-unregistered");
    write(&root, "crates/screens/src/notes/mod.rs", "registry()");
    assert!(lacking(&root).contains("does not register the screen"));
}

fn rows(status: Status) -> Vec<Row> {
    APPS.iter()
        .map(|app| Row {
            app,
            promise: Promise::Trash,
            status,
        })
        .collect()
}

#[test]
fn a_kept_claim_that_is_false_fails() {
    let root = kept_tree("promises-false-kept");
    fs::remove_file(root.join("crates/screens/src/notes/trash.rs")).expect("remove");
    let mut table = rows(Status::Owed("#1185"));
    table[5].status = Status::Kept("crates/screens/src/notes/trash.rs");
    let report = check(&root, &table);
    let found = report.findings.join("\n");
    assert!(found.contains("notes / Trash: claimed Kept, but"));
    assert!(found.contains("its proof `crates/screens/src/notes/trash.rs` does not exist"));
}

#[test]
fn an_owed_entry_that_is_satisfied_fails() {
    let root = kept_tree("promises-paid-debt");
    let mut table = rows(Status::Owed("#1185"));
    table[5].status = Status::Owed("#1185: nothing");
    let report = check(&root, &table);
    let found = report.findings.join("\n");
    assert!(found.contains("notes / Trash: listed Owed"));
    assert!(found.contains("make it Kept"));
}

#[test]
fn an_owed_entry_prints_what_is_missing() {
    let root = kept_tree("promises-owed-details");
    let report = check(&root, &rows(Status::Owed("#1185")));
    let calendar = report
        .details
        .iter()
        .find(|line| {
            line.starts_with("owed calendar / Trash: crates/screens/src/calendar/trash.rs")
        })
        .expect("calendar's gap is printed");
    assert!(calendar.contains("is missing"));
}

#[test]
fn an_app_without_a_row_fails() {
    let root = kept_tree("promises-incomplete");
    let mut table = rows(Status::Owed("#1185"));
    table.pop();
    let found = check(&root, &table).findings.join("\n");
    assert!(found.contains("reminders / Trash has no row"));
}

#[test]
fn the_committed_register_is_complete() {
    for app in APPS {
        assert!(
            REGISTER.iter().any(|row| row.app == app),
            "{app} has no row"
        );
    }
}

#[test]
fn pascal_spells_the_catalog() {
    assert_eq!(pascal("delete-note"), "DeleteNote");
    assert_eq!(pascal("trash"), "Trash");
    assert_eq!(pascal("empty-trash"), "EmptyTrash");
}

// ---------------------------------------------------------------------------
// A grid trash (#1185): a second, declared shape that proves the same promise.
// ---------------------------------------------------------------------------

const GRID: &[GridTrash] = &[GridTrash {
    app: "notes",
    shelf: "shelf.rs",
    route: "ShelfKind::Trash",
}];

const GRID_MANIFEST: &str = r#"{"actions":[
 {"name":"delete-photo","command":"entity.trash"},
 {"name":"restore-photo","command":"entity.restore"},
 {"name":"purge-photo","command":"entity.purge"},
 {"name":"empty-trash","command":"entity.empty_trash"}]}"#;

const GRID_SHELF: &str = r"fn empty() {
    act::notes::EmptyTrash {};
    kit_words::trash_empty_title(); kit_words::trash_empty_body(); kit_words::trash_empty_action();
}
fn bar() {
    act::notes::PurgePhoto {}; act::notes::RestorePhoto {};
    kit_words::trash_restore(); kit_words::trash_purge();
}
";

/// A `notes` app whose trash is a shelf of its own, declared in [`GRID`], keeping the promise.
fn grid_tree(name: &str) -> PathBuf {
    let root = fixture_dir(name);
    write(&root, "crates/screens/src/notes/shelf.rs", GRID_SHELF);
    write(
        &root,
        "crates/screens/src/notes/mod.rs",
        "registry().with(SHELF, shelf::build)",
    );
    write(
        &root,
        "crates/screens/src/notes/home.rs",
        "fn tile() { shelf(ShelfKind::Trash); act::notes::DeletePhoto {}; }",
    );
    write(&root, "crates/apps/notes/manifest.json", GRID_MANIFEST);
    root
}

fn grid_lacking(root: &Path) -> String {
    trash_missing_in(root, "notes", GRID).join("\n")
}

#[test]
fn a_declared_grid_trash_that_keeps_every_verb_is_clean() {
    let root = grid_tree("promises-grid-clean");
    assert_eq!(grid_lacking(&root), "");
}

#[test]
fn a_grid_trash_with_no_empty_trash_action_is_named() {
    let root = grid_tree("promises-grid-no-empty");
    write(
        &root,
        "crates/apps/notes/manifest.json",
        r#"{"actions":[
 {"name":"delete-photo","command":"entity.trash"},
 {"name":"restore-photo","command":"entity.restore"},
 {"name":"purge-photo","command":"entity.purge"}]}"#,
    );
    let gaps = grid_lacking(&root);
    assert!(gaps.contains("declares no `entity.empty_trash` action"));
    assert!(gaps.contains("no screen calls an `entity.empty_trash` action"));
}

#[test]
fn a_grid_trash_that_empties_photo_by_photo_is_named() {
    // The shelf purges one at a time and never calls the shared empty verb.
    let root = grid_tree("promises-grid-by-photo");
    write(
        &root,
        "crates/screens/src/notes/shelf.rs",
        &GRID_SHELF.replace("act::notes::EmptyTrash {};", ""),
    );
    assert!(grid_lacking(&root).contains("no screen calls an `entity.empty_trash` action"));
}

#[test]
fn a_grid_trash_that_does_not_say_the_kits_words_is_named() {
    let root = grid_tree("promises-grid-words");
    write(
        &root,
        "crates/screens/src/notes/shelf.rs",
        &GRID_SHELF
            .replace("kit_words::trash_empty_title();", "")
            .replace("kit_words::trash_purge();", ""),
    );
    let gaps = grid_lacking(&root);
    assert!(gaps.contains("never says `trash_empty_title`"));
    assert!(gaps.contains("never says `trash_purge`"));
    assert!(!gaps.contains("never says `trash_restore`"));
}

#[test]
fn a_grid_trash_nothing_opens_or_registers_is_named() {
    let root = grid_tree("promises-grid-unreachable");
    write(
        &root,
        "crates/screens/src/notes/home.rs",
        "fn tile() { act::notes::DeletePhoto {}; }",
    );
    write(&root, "crates/screens/src/notes/mod.rs", "registry()");
    let gaps = grid_lacking(&root);
    assert!(gaps.contains("does not register the shelf (`shelf::build`)"));
    assert!(gaps.contains("opens the trash shelf (`ShelfKind::Trash`)"));
}

#[test]
fn a_grid_trash_with_no_move_to_trash_caller_is_named() {
    let root = grid_tree("promises-grid-no-move");
    write(
        &root,
        "crates/screens/src/notes/home.rs",
        "fn tile() { shelf(ShelfKind::Trash); }",
    );
    assert!(grid_lacking(&root).contains("no screen calls an `entity.trash` action"));
}

#[test]
fn a_test_module_does_not_make_a_grid_trash_say_a_word_or_call_a_verb() {
    let root = grid_tree("promises-grid-test-only");
    write(
        &root,
        "crates/screens/src/notes/shelf.rs",
        &format!("#[cfg(test)]\nmod t {{ {GRID_SHELF} }}"),
    );
    let gaps = grid_lacking(&root);
    assert!(gaps.contains("no screen calls an `entity.empty_trash` action"));
    assert!(gaps.contains("never says `trash_empty_action`"));
}

/// THE SECOND SHAPE IS NOT A LOOPHOLE: an app that is not declared in the grid list is held to the
/// kit's spec however good its own shelf looks.
#[test]
fn an_undeclared_app_with_a_shelf_of_its_own_still_owes_the_kit_spec() {
    let root = grid_tree("promises-grid-undeclared");
    let gaps = trash_missing_in(&root, "notes", &[]).join("\n");
    assert!(gaps.contains("crates/screens/src/notes/trash.rs is missing"));
    assert!(gaps.contains("does not register the screen (`trash::build`)"));
}

#[test]
fn only_photos_is_declared_a_grid_and_its_shelf_is_a_real_file() {
    let apps: Vec<&str> = GRID_TRASH.iter().map(|grid| grid.app).collect();
    assert_eq!(apps, ["photos"]);
}
