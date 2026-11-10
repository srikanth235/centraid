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
    purge: Some(|id| act::notes::PurgeNote { note_id: id.to_owned() }.into()),
    empty: Some(|| act::notes::EmptyTrash {}.into()),
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
                "purge: Some(|id| act::notes::PurgeNote { note_id: id.to_owned() }.into()),",
                "purge: None,",
            )
            .replace(
                "empty: Some(|| act::notes::EmptyTrash {}.into()),",
                "empty: None,",
            ),
    );
    let gaps = lacking(&root);
    assert!(gaps.contains("crates/screens/src/notes/trash.rs: the spec has `purge: None`"));
    assert!(gaps.contains("the spec has `empty: None`"));
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
