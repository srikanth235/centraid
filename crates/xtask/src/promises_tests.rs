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

// ---------------------------------------------------------------------------
// Undo
// ---------------------------------------------------------------------------

const TABLE: &str = r#"const NOTES: &[Row] = &[
    ("flag-note", "unflag-note", Input::Same),
    ("unflag-note", "flag-note", Input::Same),
    ("delete-note", "restore-note", Input::Id),
];
const PEOPLE: &[Row] = &[
    ("star-person", "unstar-person", Input::Same),
];
"#;

fn undo_manifest(actions: &[(&str, Option<&str>, bool)]) -> String {
    let rows: Vec<String> = actions
        .iter()
        .map(|(name, inverse, confirmed)| {
            let inverse = inverse.map_or("null".to_owned(), |i| format!("\"{i}\""));
            let confirmation = if *confirmed { "required" } else { "none" };
            format!(
                r#"{{"name":"{name}","inverse":{inverse},"confirmation":"{confirmation}","command":"x.y"}}"#
            )
        })
        .collect();
    format!(r#"{{"actions":[{}]}}"#, rows.join(","))
}

fn undo_tree(name: &str, actions: &[(&str, Option<&str>, bool)]) -> PathBuf {
    let root = fixture_dir(name);
    write(&root, "crates/core/src/act/inverse.rs", TABLE);
    write(
        &root,
        "crates/apps/notes/manifest.json",
        &undo_manifest(actions),
    );
    root
}

#[test]
fn undo_with_every_action_classified_and_one_list_is_clean() {
    let root = undo_tree(
        "undo-clean",
        &[
            ("flag-note", Some("unflag-note"), false),
            ("unflag-note", Some("flag-note"), false),
            ("delete-note", Some("restore-note"), false),
            ("purge-note", None, true),
        ],
    );
    // `restore-note` is not an action of this fixture: the table names it as a row's inverse only.
    assert_eq!(undo_missing(&root, "notes").join("\n"), "");
}

#[test]
fn an_action_that_is_neither_undoable_nor_confirmed_is_named() {
    let root = undo_tree(
        "undo-unclassified",
        &[
            ("flag-note", Some("unflag-note"), false),
            ("unflag-note", Some("flag-note"), false),
            ("delete-note", Some("restore-note"), false),
            ("rename-note", None, false),
        ],
    );
    let gaps = undo_missing(&root, "notes").join("\n");
    assert!(gaps.contains("1 of 4 actions unclassified (A), 0 list mismatches (B)"));
    assert!(gaps.contains("rename-note: (A) has no inverse"));
}

#[test]
fn a_confirmed_action_with_an_inverse_is_fine() {
    let root = undo_tree(
        "undo-both",
        &[
            ("flag-note", Some("unflag-note"), true),
            ("unflag-note", Some("flag-note"), false),
            ("delete-note", Some("restore-note"), false),
        ],
    );
    assert_eq!(undo_missing(&root, "notes").join("\n"), "");
}

#[test]
fn a_manifest_and_a_table_that_disagree_are_named_both_ways() {
    let root = undo_tree(
        "undo-disagree",
        &[
            // declared in the manifest, no table row
            ("edit-note", Some("edit-note"), false),
            // a row whose manifest says something else
            ("flag-note", Some("delete-note"), false),
            // a row whose manifest declares none
            ("unflag-note", None, true),
            ("delete-note", Some("restore-note"), false),
        ],
    );
    let gaps = undo_missing(&root, "notes").join("\n");
    assert!(gaps.contains(
        "edit-note: (B) the manifest declares inverse `edit-note`, the table has no row"
    ));
    assert!(gaps.contains("flag-note: (B) the table reverses it with `unflag-note`, the manifest declares `delete-note`"));
    assert!(gaps.contains(
        "unflag-note: (B) the table reverses it with `flag-note`, the manifest declares no inverse"
    ));
    assert!(gaps.contains("edit-note: (A)"));
}

#[test]
fn a_table_row_with_no_action_is_named() {
    let root = undo_tree("undo-orphan", &[("flag-note", Some("unflag-note"), false)]);
    let gaps = undo_missing(&root, "notes").join("\n");
    assert!(gaps.contains("delete-note: (B) a row of the table, but no such action"));
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

const EARLIER_SPEC: &str = r#"use crate::kit::earlier::{self, EarlierSpec};
pub static SPEC: EarlierSpec = EarlierSpec {
    app: "notes",
    noun: shared::trash_noun_note,
    denied,
    line,
};
"#;

const SHELL: &str = r#"{
 "queries":[{"name":"earlier-versions"},{"name":"earlier-count"}],
 "actions":[
  {"name":"restore-version","command":"history.restore_version"},
  {"name":"undo-change","command":"history.undo"}]}"#;

/// A `notes` app that keeps History in full: the spec, the registration, the shell's door and the
/// note page's entry.
fn history_tree(name: &str) -> PathBuf {
    let root = fixture_dir(name);
    write(&root, "crates/screens/src/notes/earlier.rs", EARLIER_SPEC);
    write(
        &root,
        "crates/screens/src/notes/mod.rs",
        "pub const EARLIER: &str = \"notes.earlier\";\nregistry().with(EARLIER, earlier::build)",
    );
    write(
        &root,
        "crates/screens/src/notes/editor.rs",
        "fn view() { let foot = earlier::foot(ctx, EARLIER, &id, &title); }",
    );
    write(&root, "crates/core/src/shell/manifest.json", SHELL);
    root
}

fn history_lacking(root: &Path) -> String {
    history_missing(root, "notes").join("\n")
}

#[test]
fn an_app_that_embeds_the_entry_and_registers_the_screen_keeps_history() {
    let root = history_tree("history-clean");
    assert_eq!(history_lacking(&root), "");
}

#[test]
fn no_spec_is_named_by_file() {
    let root = history_tree("history-no-spec");
    fs::remove_file(root.join("crates/screens/src/notes/earlier.rs")).expect("remove");
    assert!(history_lacking(&root).contains("crates/screens/src/notes/earlier.rs is missing"));
}

#[test]
fn a_spec_with_no_line_is_named() {
    let root = history_tree("history-no-line");
    write(
        &root,
        "crates/screens/src/notes/earlier.rs",
        &EARLIER_SPEC.replace("    line,\n", ""),
    );
    assert!(history_lacking(&root).contains("the spec has no `line`"));
}

#[test]
fn a_spec_that_is_not_the_kits_is_named() {
    let root = history_tree("history-not-kit");
    write(
        &root,
        "crates/screens/src/notes/earlier.rs",
        "pub static SPEC: Mine = Mine { app: \"notes\", noun, denied, line };",
    );
    assert!(
        history_lacking(&root).contains("does not define an EarlierSpec built on kit::earlier")
    );
}

#[test]
fn a_screen_not_registered_under_the_apps_name_is_named() {
    let root = history_tree("history-unregistered");
    write(
        &root,
        "crates/screens/src/notes/mod.rs",
        "registry().with(TRASH, trash::build)",
    );
    assert!(history_lacking(&root).contains("does not register the screen (`earlier::build`"));
    write(
        &root,
        "crates/screens/src/notes/mod.rs",
        "pub const EARLIER: &str = \"notes.history\";\nregistry().with(EARLIER, earlier::build)",
    );
    assert!(history_lacking(&root).contains("does not register the screen"));
}

#[test]
fn a_detail_page_with_no_entry_is_named_by_file_and_kind() {
    let root = history_tree("history-no-entry");
    write(
        &root,
        "crates/screens/src/notes/editor.rs",
        "fn view() { let history = my_own_history(); }",
    );
    assert!(
        history_lacking(&root)
            .contains("crates/screens/src/notes/editor.rs: the note page does not embed")
    );
}

#[test]
fn an_entry_only_a_test_module_embeds_does_not_count() {
    let root = history_tree("history-test-only");
    write(
        &root,
        "crates/screens/src/notes/editor.rs",
        "fn view() {}\n#[cfg(test)]\nmod t { fn x() { earlier::foot(c, EARLIER, i, t); } }",
    );
    assert!(history_lacking(&root).contains("the note page does not embed"));
}

#[test]
fn a_shell_manifest_without_the_shared_door_is_named() {
    let root = history_tree("history-no-door");
    write(
        &root,
        "crates/core/src/shell/manifest.json",
        r#"{"queries":[{"name":"earlier-count"}],"actions":[{"name":"undo-change","command":"entity.trash"}]}"#,
    );
    let gaps = history_lacking(&root);
    assert!(gaps.contains("declares no `earlier-versions` query"));
    assert!(
        gaps.contains("declares no `restore-version` action that runs `history.restore_version`")
    );
    assert!(gaps.contains("declares no `undo-change` action that runs `history.undo`"));
}

#[test]
fn an_owed_history_row_prints_each_gap_with_its_file() {
    let root = history_tree("history-owed");
    fs::remove_file(root.join("crates/screens/src/notes/earlier.rs")).expect("remove");
    write(&root, "crates/screens/src/notes/mod.rs", "registry()");
    let table: Vec<Row> = APPS
        .iter()
        .map(|app| Row {
            app,
            promise: Promise::History,
            status: Status::Owed("#1185"),
        })
        .collect();
    let report = check(&root, &table);
    let notes = report
        .details
        .iter()
        .filter(|line| line.starts_with("owed notes / History:"))
        .cloned()
        .collect::<Vec<_>>()
        .join("\n");
    assert!(notes.contains("crates/screens/src/notes/earlier.rs is missing"));
    assert!(notes.contains("does not register the screen"));
}

#[test]
fn the_committed_history_register_names_every_apps_kinds_and_people_keeps_it() {
    for app in APPS {
        assert!(
            HISTORY_KINDS.iter().any(|(name, _)| *name == app),
            "{app} names no primary kind"
        );
    }
    assert!(REGISTER.iter().any(|row| row.app == "people"
        && row.promise == Promise::History
        && matches!(row.status, Status::Kept(_))));
    for (app, kinds) in HISTORY_KINDS {
        for (_, screen) in *kinds {
            let path = Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../screens/src")
                .join(app)
                .join(screen);
            assert!(
                path.exists(),
                "{app}'s detail screen `{screen}` is not there"
            );
        }
    }
}
