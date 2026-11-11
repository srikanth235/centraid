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
fn an_action_that_writes_nothing_is_classified_and_a_plain_no_is_not() {
    let root = fixture_dir("undo-writes-nothing");
    write(&root, "crates/core/src/act/inverse.rs", TABLE);
    write(
        &root,
        "crates/apps/notes/manifest.json",
        r#"{"actions":[
          {"name":"flag-note","inverse":"unflag-note","confirmation":"none","command":"x.y"},
          {"name":"unflag-note","inverse":"flag-note","confirmation":"none","command":"x.y"},
          {"name":"delete-note","inverse":"restore-note","confirmation":"none","command":"x.y"},
          {"name":"export-notes","inverse":null,"confirmation":"none","writes_nothing":true,"command":"x.y"},
          {"name":"rename-note","inverse":null,"confirmation":"none","writes_nothing":false,"command":"x.y"}
        ]}"#,
    );
    let gaps = undo_missing(&root, "notes").join("\n");
    assert!(gaps.contains("1 of 5 actions unclassified"), "{gaps}");
    assert!(gaps.contains("rename-note: (A)"));
    assert!(!gaps.contains("export-notes"));
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

// Rule C: every write goes through `kit::undo`.

const UNDO_APPS: [(&str, Option<&str>, bool); 3] = [
    ("flag-note", Some("unflag-note"), false),
    ("unflag-note", Some("flag-note"), false),
    ("delete-note", Some("restore-note"), false),
];

fn undo_rows(status: Status) -> Vec<Row> {
    APPS.iter()
        .map(|app| Row {
            app,
            promise: Promise::Undo,
            status,
        })
        .collect()
}

#[test]
fn a_screen_that_writes_straight_to_the_door_is_named_with_its_file() {
    let root = undo_tree("undo-direct", &UNDO_APPS);
    write(
        &root,
        "crates/screens/src/notes/home.rs",
        "fn pin() {\n    let settled = kit_act::act(ctx, request, &key);\n}\n",
    );
    let gaps = undo_missing(&root, "notes").join("\n");
    assert!(
        gaps.contains("0 list mismatches (B), 1 direct writes (C)"),
        "{gaps}"
    );
    assert!(
        gaps.contains("crates/screens/src/notes/home.rs: (C) line 2"),
        "{gaps}"
    );
}

#[test]
fn a_write_through_the_door_a_test_module_and_a_reasoned_exemption_are_clean() {
    let root = undo_tree("undo-door", &UNDO_APPS);
    write(
        &root,
        "crates/screens/src/notes/home.rs",
        "fn pin() {\n    let settled = self.undo.act(ctx, request, &key, said);\n}\n\
         fn receipt() {\n    // undo-exempt: a receipt offers the Undo\n    kit_act::act(ctx, request, &key);\n}\n\
         #[cfg(test)]\nmod tests {\n    fn t() { kit_act::act(ctx, request, &key); }\n}\n",
    );
    assert_eq!(undo_missing(&root, "notes").join("\n"), "");
}

#[test]
fn an_exemption_with_no_reason_or_far_from_the_call_exempts_nothing() {
    let root = undo_tree("undo-bad-exempt", &UNDO_APPS);
    write(
        &root,
        "crates/screens/src/notes/home.rs",
        "fn a() {\n    // undo-exempt:\n    kit_act::act(ctx, request, &key);\n}\n\
         // undo-exempt: too far above\n\n\n\nfn b() {\n    ctx.act(&request);\n}\n",
    );
    let gaps = undo_missing(&root, "notes").join("\n");
    assert!(gaps.contains("2 direct writes (C)"), "{gaps}");
}

#[test]
fn reminders_answer_for_the_agenda_and_the_schedule_kit() {
    let root = undo_tree("undo-folders", &UNDO_APPS);
    write(
        &root,
        "crates/apps/reminders/manifest.json",
        &undo_manifest(&[]),
    );
    write(
        &root,
        "crates/screens/src/kit/schedule/ops.rs",
        "fn go() { kit_act::act(ctx, request, &key); }\n",
    );
    write(
        &root,
        "crates/screens/src/agenda/notify/answer.rs",
        "fn go() { kit_act::act(ctx, request, &key); }\n",
    );
    let folders = undo_folders("reminders");
    assert_eq!(folders, ["reminders", "agenda", "kit/schedule"]);
    let gaps = direct_writes(&root, "reminders").join("\n");
    assert!(
        gaps.contains("crates/screens/src/kit/schedule/ops.rs: (C)"),
        "{gaps}"
    );
    assert!(
        gaps.contains("crates/screens/src/agenda/notify/answer.rs: (C)"),
        "{gaps}"
    );
    // Notes is not answerable for either.
    assert!(direct_writes(&root, "notes").is_empty());
}

#[test]
fn a_kept_undo_claim_with_a_direct_write_fails() {
    let root = undo_tree("undo-false-kept", &UNDO_APPS);
    write(
        &root,
        "crates/screens/src/notes/home.rs",
        "fn pin() { kit_act::act(ctx, request, &key); }\n",
    );
    let mut table = undo_rows(Status::Owed("#1185"));
    let notes = APPS.iter().position(|app| *app == "notes").expect("notes");
    table[notes].status = Status::Kept("crates/core/src/act/inverse.rs");
    let found = check(&root, &table).findings.join("\n");
    assert!(found.contains("notes / Undo: claimed Kept, but"), "{found}");
    assert!(found.contains("(C)"), "{found}");
}

#[test]
fn an_owed_undo_entry_whose_writes_all_go_through_the_door_fails() {
    let root = undo_tree("undo-paid", &UNDO_APPS);
    write(
        &root,
        "crates/screens/src/notes/home.rs",
        "fn pin() { self.undo.act(ctx, request, &key, said); }\n",
    );
    let mut table = undo_rows(Status::Owed("#1185"));
    let notes = APPS.iter().position(|app| *app == "notes").expect("notes");
    table[notes].status = Status::Owed("#1185: rule C");
    let found = check(&root, &table).findings.join("\n");
    assert!(found.contains("notes / Undo: listed Owed"), "{found}");
    assert!(found.contains("make it Kept"), "{found}");
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
    history_missing_in(root, "notes", &[]).join("\n")
}

const MENU: &[MenuEntry] = &[MenuEntry {
    app: "notes",
    kind: "note",
    entry: "state.earlier = ",
    menu: "menu_label",
}];

fn menu_lacking(root: &Path) -> String {
    history_missing_in(root, "notes", MENU).join("\n")
}

const MENU_PAGE: &str = "fn view() { let foot = earlier::foot(ctx, EARLIER, &id, &title);\n  chrome.menu_label = x;\n  state.earlier = foot.entry; }";

#[test]
fn a_menu_entry_declared_by_name_and_wired_to_the_view_keeps_history() {
    let root = history_tree("history-menu-clean");
    write(&root, "crates/screens/src/notes/editor.rs", MENU_PAGE);
    assert_eq!(menu_lacking(&root), "");
}

#[test]
fn a_menu_entry_that_never_reaches_the_view_or_the_menu_is_named() {
    let root = history_tree("history-menu-unwired");
    // The foot alone satisfies an app that is not declared, but not one declared a menu entry.
    assert_eq!(history_lacking(&root), "");
    let gaps = menu_lacking(&root);
    assert!(
        gaps.contains("declares its entry as a menu row but does not hand it to the view"),
        "{gaps}"
    );
    write(
        &root,
        "crates/screens/src/notes/editor.rs",
        &MENU_PAGE.replace("chrome.menu_label = x;", ""),
    );
    assert!(menu_lacking(&root).contains("beside the menu (`menu_label`)"));
}

#[test]
fn a_menu_entry_still_needs_the_shared_count() {
    let root = history_tree("history-menu-no-foot");
    write(
        &root,
        "crates/screens/src/notes/editor.rs",
        "fn view() { chrome.menu_label = x; state.earlier = mine; }",
    );
    assert!(menu_lacking(&root).contains("the note page does not embed the shared entry"));
}

#[test]
fn the_menu_placement_is_declared_only_for_notes() {
    assert_eq!(
        MENU_ENTRY.iter().map(|menu| menu.app).collect::<Vec<_>>(),
        ["notes"]
    );
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

// ---------------------------------------------------------------------------
// Arrive
// ---------------------------------------------------------------------------

const ARRIVE_MANIFEST: &str = r#"{"actions":[
 {"name":"import-vcf","command":"person.import_vcf",
  "input":{"type":"object","properties":{"cards":{"type":"string"},
   "arrived_system":{"type":["string","null"]}}}},
 {"name":"add-task","command":"task.add",
  "input":{"type":"object","properties":{"title":{"type":"string"}}}}]}"#;

const IMPORT_SITE: &[ArrivalSite] = &[ArrivalSite {
    app: "people",
    file: "crates/screens/src/people/transfer.rs",
    call: "act::people::ImportVcf",
    path: "the vCard import",
}];

/// A `people` app whose vCard import passes `arrived`.
fn arrive_tree(name: &str) -> PathBuf {
    let root = fixture_dir(name);
    write(
        &root,
        "crates/screens/src/people/transfer.rs",
        "fn go() { act::people::ImportVcf { cards, arrived_system: Some(from), ..Default::default() }; }",
    );
    write(&root, "crates/apps/people/manifest.json", ARRIVE_MANIFEST);
    root
}

fn arrive_lacking(root: &Path) -> String {
    arrive_missing_in(root, "people", IMPORT_SITE).join("\n")
}

#[test]
fn an_arrival_that_passes_the_arrival_is_clean() {
    let root = arrive_tree("arrive-clean");
    assert_eq!(arrive_lacking(&root), "");
}

#[test]
fn an_import_that_does_not_pass_the_arrival_is_named_by_file() {
    let root = arrive_tree("arrive-red");
    write(
        &root,
        "crates/screens/src/people/transfer.rs",
        "fn go() { act::people::ImportVcf { cards, ..Default::default() }; }",
    );
    let gaps = arrive_lacking(&root);
    assert!(
        gaps.contains("crates/screens/src/people/transfer.rs: the vCard import calls `act::people::ImportVcf` without passing `arrived`"),
        "{gaps}"
    );
}

// ---------------------------------------------------------------------------
// Export and Share (take out)
// ---------------------------------------------------------------------------

const EXPORT_SPEC: &str = r"use crate::kit::export::{self, ExportSpec};
pub static SPEC: ExportSpec = ExportSpec {
    app: act::notes::APP,
    title,
    lede,
    back_label,
    denied,
    choices: |ctx| choices(ctx),
    export: |ctx, key| act(ctx, act::notes::ExportNotes {}),
    no_passcode: NoPasscode::Warn,
};
";

const EXPORT_MANIFEST: &str = r#"{"actions":[
 {"name":"export-notes","command":"note.export","writes_nothing":true}]}"#;

/// A `notes` app that keeps Export in full.
fn export_tree(name: &str) -> PathBuf {
    let root = fixture_dir(name);
    write(&root, "crates/screens/src/notes/export.rs", EXPORT_SPEC);
    write(
        &root,
        "crates/screens/src/notes/mod.rs",
        "registry().with(\"notes.export\", export::build)",
    );
    write(
        &root,
        "crates/screens/src/notes/home.rs",
        "fn more() { let row = export::entry(locale, EXPORT, &back); }",
    );
    write(&root, "crates/apps/notes/manifest.json", EXPORT_MANIFEST);
    root
}

fn export_lacking(root: &Path) -> String {
    export_missing_in(root, "notes", &[]).join("\n")
}

#[test]
fn an_app_with_the_whole_export_is_clean() {
    assert_eq!(export_lacking(&export_tree("export-clean")), "");
}

#[test]
fn an_export_with_no_screen_registration_or_entry_is_named() {
    let root = fixture_dir("export-none");
    write(&root, "crates/apps/notes/manifest.json", EXPORT_MANIFEST);
    let gaps = export_lacking(&root);
    assert!(gaps.contains("crates/screens/src/notes/export.rs is missing"));
    assert!(gaps.contains("does not register the screen"));
    assert!(gaps.contains("no screen reaches the export"));
}

#[test]
fn a_spec_that_leaves_out_the_passcode_rule_or_the_gate_is_named() {
    let root = export_tree("export-fields");
    write(
        &root,
        "crates/screens/src/notes/export.rs",
        "use crate::kit::export::ExportSpec;\nstatic SPEC: ExportSpec = ExportSpec {\n    app: x,\n    title,\n    lede,\n    back_label,\n    choices,\n    export: |c| act::notes::ExportNotes {},\n};",
    );
    let gaps = export_lacking(&root);
    assert!(gaps.contains("the spec has no `no_passcode`"));
    assert!(gaps.contains("the spec has no `denied`"));
}

#[test]
fn an_export_action_that_does_not_declare_writes_nothing_is_named() {
    let root = export_tree("export-writes");
    write(
        &root,
        "crates/apps/notes/manifest.json",
        r#"{"actions":[{"name":"export-notes","command":"note.export"}]}"#,
    );
    assert!(export_lacking(&root).contains("does not declare `\"writes_nothing\": true`"));
}

#[test]
fn an_export_that_calls_a_stranger_is_named() {
    let root = export_tree("export-stranger");
    write(
        &root,
        "crates/apps/notes/manifest.json",
        r#"{"actions":[{"name":"other","command":"x","writes_nothing":true}]}"#,
    );
    assert!(export_lacking(&root).contains("which is not a manifest action"));
}

#[test]
fn a_test_module_does_not_reach_the_export() {
    let root = export_tree("export-test-entry");
    write(
        &root,
        "crates/screens/src/notes/home.rs",
        "#[cfg(test)]\nmod t { fn x() { export::entry(); } }",
    );
    assert!(export_lacking(&root).contains("no screen reaches the export"));
}

#[test]
fn an_export_that_keeps_its_own_machine_is_declared_by_name_and_only_locker_is() {
    let apps: Vec<&str> = OWN_EXPORT.iter().map(|own| own.app).collect();
    assert_eq!(apps, ["locker"]);
    let root = fixture_dir("export-own");
    let own = [OwnExport {
        app: "notes",
        file: "transfer.rs",
        reason: "x",
    }];
    let found = export_missing_in(&root, "notes", &own).join("\n");
    assert!(found.contains("transfer.rs is missing"));
    write(
        &root,
        "crates/screens/src/notes/transfer.rs",
        "fn build_export() {}",
    );
    write(
        &root,
        "crates/screens/src/notes/mod.rs",
        "with(\"notes.export\", transfer::build_export)",
    );
    write(
        &root,
        "crates/screens/src/notes/home.rs",
        "fn r() { more_export(); }",
    );
    assert_eq!(export_missing_in(&root, "notes", &own).join("\n"), "");
}

fn share_tree(name: &str, page: &str) -> PathBuf {
    let root = fixture_dir(name);
    write(&root, "crates/screens/src/notes/editor.rs", page);
    root
}

fn share_lacking(root: &Path) -> String {
    share_missing_in(root, "notes", &[], &[]).join("\n")
}

#[test]
fn a_detail_page_on_the_kits_share_helper_keeps_share() {
    let root = share_tree("share-clean", "use crate::kit::share::Share;\nfn x() {}");
    assert_eq!(share_lacking(&root), "");
}

#[test]
fn a_detail_page_with_no_share_is_named() {
    let root = share_tree("share-none", "fn x() {}");
    assert!(share_lacking(&root).contains("the note page does not hand the item to the OS"));
}

#[test]
fn a_share_in_a_test_module_does_not_count() {
    let root = share_tree(
        "share-test",
        "fn x() {}\n#[cfg(test)]\nmod t { use crate::kit::share::Share; }",
    );
    assert!(share_lacking(&root).contains("does not hand the item"));
}

#[test]
fn a_declared_own_share_must_raise_its_effect() {
    let root = share_tree("share-own", "fn x() { Kind::ShareFile }");
    let own = [OwnShare {
        app: "notes",
        screen: "editor.rs",
        effect: "ShareFile",
    }];
    assert_eq!(share_missing_in(&root, "notes", &own, &[]).join("\n"), "");
    let other = [OwnShare {
        app: "notes",
        screen: "editor.rs",
        effect: "ExportOriginals",
    }];
    assert!(
        share_missing_in(&root, "notes", &other, &[])
            .join("\n")
            .contains("does not raise `ExportOriginals`")
    );
}

#[test]
fn an_arrival_only_a_comment_or_a_test_spells_does_not_count() {
    let root = arrive_tree("arrive-comment");
    write(
        &root,
        "crates/screens/src/people/transfer.rs",
        "// arrived: from the file\nfn go() { act::people::ImportVcf {}; }\n#[cfg(test)]\nmod tests { fn t() { let arrived = 1; } }",
    );
    assert!(arrive_lacking(&root).contains("without passing `arrived`"));
}

#[test]
fn a_listed_path_that_is_gone_or_no_longer_calls_is_named() {
    let root = arrive_tree("arrive-stale");
    write(&root, "crates/screens/src/people/transfer.rs", "fn go() {}");
    assert!(arrive_lacking(&root).contains("no longer calls `act::people::ImportVcf`"));
    fs::remove_file(root.join("crates/screens/src/people/transfer.rs")).expect("remove");
    assert!(arrive_lacking(&root).contains("the file is missing"));
}

#[test]
fn an_unlisted_import_file_that_builds_an_arrival_action_is_named() {
    let root = arrive_tree("arrive-unlisted");
    write(
        &root,
        "crates/screens/src/imports/cards.rs",
        "fn go() { act::people::ImportVcf { cards, ..Default::default() }; }",
    );
    // A typed add (a file that is not arrival-shaped) is never asked for an arrival.
    write(
        &root,
        "crates/screens/src/people/ops.rs",
        "fn typed() { act::people::ImportVcf {}; }",
    );
    let gaps = arrive_missing_in(&root, "people", &[]).join("\n");
    assert!(
        gaps.contains("crates/screens/src/imports/cards.rs: builds `act::people::ImportVcf`")
            && gaps.contains("crates/screens/src/people/transfer.rs: builds"),
        "{gaps}"
    );
    assert!(!gaps.contains("ops.rs"), "{gaps}");
}

#[test]
fn an_owed_arrive_row_prints_each_gap_with_its_file() {
    let root = arrive_tree("arrive-owed");
    write(
        &root,
        "crates/screens/src/imports/cards.rs",
        "fn go() { act::people::ImportVcf {}; }",
    );
    let table: Vec<Row> = APPS
        .iter()
        .map(|app| Row {
            app,
            promise: Promise::Arrive,
            status: Status::Owed("#1185"),
        })
        .collect();
    let report = check(&root, &table);
    assert!(
        report
            .details
            .iter()
            .any(|line| line.starts_with("owed people / Arrive:")
                && line.contains("imports/cards.rs")),
        "{:?}",
        report.details
    );
}

#[test]
fn the_committed_arrival_paths_exist_and_agree_with_their_rows() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    for site in ARRIVAL_SITES {
        assert!(APPS.contains(&site.app), "{} is not an app", site.app);
        assert!(
            root.join(site.file).is_file(),
            "{} is not a file ({})",
            site.file,
            site.path
        );
    }
    for app in ["calendar", "health", "money"] {
        assert!(
            ARRIVAL_SITES.iter().all(|site| site.app != app),
            "{app} records its arrivals in the vault and lists no path"
        );
    }
}

#[test]
fn an_app_with_no_share_by_decision_that_shares_is_named() {
    let root = share_tree("share-no", "use crate::kit::share::Share;");
    let none = [NoShare {
        app: "notes",
        reason: "D11",
    }];
    assert!(
        share_missing_in(&root, "notes", &[], &none)
            .join("\n")
            .contains("has no share by decision (D11)")
    );
    let quiet = share_tree("share-no-quiet", "fn x() {}");
    assert_eq!(share_missing_in(&quiet, "notes", &[], &none).join("\n"), "");
}

#[test]
fn only_locker_has_no_share_and_only_docs_and_photos_have_their_own() {
    let none: Vec<&str> = NO_SHARE.iter().map(|no| no.app).collect();
    assert_eq!(none, ["locker"]);
    let own: Vec<&str> = OWN_SHARE.iter().map(|own| own.app).collect();
    assert_eq!(own, ["docs", "photos"]);
}

// ---------------------------------------------------------------------------
// Units
// ---------------------------------------------------------------------------

fn units_tree(name: &str) -> PathBuf {
    let root = fixture_dir(name);
    write(
        &root,
        "crates/screens/src/notes/home.rs",
        "use crate::kit::quantity::Quantity;\nfn row(ctx: &Ctx) { Quantity::bytes(4).words(ctx.locale(), ctx.units()); }",
    );
    root
}

fn units_gaps(root: &Path, app: &str) -> String {
    units_missing(root, app).join("\n")
}

#[test]
fn an_app_that_words_every_measure_through_the_quantity_is_clean() {
    let root = units_tree("units-clean");
    assert_eq!(units_gaps(&root, "notes"), "");
}

#[test]
fn each_hand_worded_measure_is_named_with_its_file() {
    let root = units_tree("units-by-hand");
    for (needle, _) in HAND_MEASURES {
        write(
            &root,
            "crates/screens/src/notes/size.rs",
            &format!("fn size() {{ let _ = {needle}; }}"),
        );
        let gaps = units_gaps(&root, "notes");
        assert!(
            gaps.contains("crates/screens/src/notes/size.rs") && gaps.contains(needle),
            "`{needle}` was not named: {gaps}"
        );
        assert!(gaps.contains("use kit::quantity"));
    }
}

#[test]
fn a_measure_a_comment_or_a_test_module_spells_does_not_count() {
    let root = units_tree("units-dead");
    write(
        &root,
        "crates/screens/src/notes/size.rs",
        "// format_byte_size(4)\nfn ok() {}\n#[cfg(test)]\nmod tests { fn t() { Units::of(ctx); } }",
    );
    assert_eq!(units_gaps(&root, "notes"), "");
}

#[test]
fn an_app_inherits_the_hand_worded_measures_of_a_file_it_shares() {
    let root = units_tree("units-shared");
    write(
        &root,
        "crates/screens/src/kit/attachments.rs",
        "fn line() { format_byte_size(1); }",
    );
    assert_eq!(units_gaps(&root, "notes"), "");
    write(
        &root,
        "crates/screens/src/notes/detail.rs",
        "use crate::kit::attachments::Attachments;",
    );
    let gaps = units_gaps(&root, "notes");
    assert!(gaps.contains("crates/screens/src/kit/attachments.rs"));
    assert!(gaps.contains("and notes uses it"));
}

#[test]
fn the_units_ratchet_fails_both_ways() {
    let root = units_tree("units-ratchet");
    let table = |status| {
        vec![Row {
            app: "notes",
            promise: Promise::Units,
            status,
        }]
    };
    let findings = |report: &RuleReport| report.findings.join("\n");

    // Kept with a gap fails.
    write(
        &root,
        "crates/screens/src/notes/size.rs",
        "fn s() { format_byte_size(1); }",
    );
    let kept = check(
        &root,
        &table(Status::Kept("crates/screens/src/notes/home.rs")),
    );
    assert!(findings(&kept).contains("notes / Units: claimed Kept, but"));

    // Owed with the gap prints it; Owed with nothing missing fails.
    let owed = check(&root, &table(Status::Owed("#1185")));
    assert!(
        owed.details
            .iter()
            .any(|line| line.starts_with("owed notes / Units:") && line.contains("size.rs"))
    );
    fs::remove_file(root.join("crates/screens/src/notes/size.rs")).expect("remove");
    let paid = check(&root, &table(Status::Owed("#1185")));
    assert!(findings(&paid).contains("listed Owed"));
}

fn owner_tree(name: &str, screen: &str) -> PathBuf {
    let root = fixture_dir(name);
    write(&root, "crates/screens/src/notes/transfer.rs", screen);
    root
}

fn owner_lacking(root: &Path) -> String {
    owner_check_missing(root, "notes").join("\n")
}

#[test]
fn a_screen_that_saves_a_file_through_the_owner_gate_keeps_the_owner_check() {
    let root = owner_tree(
        "owner-gated",
        "use crate::kit::owner::OwnerGate; fn go() { wire::effect::Kind::SaveFile(file); }",
    );
    assert_eq!(owner_lacking(&root), "");
}

#[test]
fn naming_a_kit_machine_is_not_asking_the_owner() {
    // The machines hold their own gate and raise the effects themselves; a screen that spells the
    // effect by hand has to hold a gate of its own, not borrow one by naming the machine.
    for borrowed in [
        "use crate::kit::export::ExportSpec;",
        "use crate::kit::share::Share;",
        "use crate::kit::transfer::ExportSpec;",
        "use crate::kit::owner::Leaving;",
    ] {
        let root = owner_tree(
            "owner-borrowed",
            &format!("{borrowed} fn go() {{ wire::effect::Kind::SaveFile(file); }}"),
        );
        assert!(
            owner_lacking(&root).contains("raises `SaveFile` without asking the owner"),
            "{borrowed}"
        );
    }
}

#[test]
fn a_screen_that_lets_data_leave_without_the_gate_is_named_with_its_file() {
    // Every effect that hands bytes, a file or a path out, by its real name.
    for effect in LEAVING_EFFECTS {
        let root = owner_tree(
            "owner-red",
            &format!("fn go() {{ wire::effect::Kind::{effect}(file); }}"),
        );
        let gaps = owner_lacking(&root);
        assert!(
            gaps.contains("crates/screens/src/notes/transfer.rs")
                && gaps.contains(&format!("`{effect}`")),
            "{effect}: {gaps}"
        );
    }
    assert_eq!(
        LEAVING_EFFECTS,
        [
            "Share",
            "ShareFile",
            "ShareBytes",
            "SaveFile",
            "SaveFilePath",
            "ExportOriginals"
        ],
        "the hand-out effects are the six the core has; a seventh is added in one place"
    );
}

#[test]
fn an_effect_is_matched_whole_so_one_name_does_not_stand_for_another() {
    let root = owner_tree(
        "owner-whole",
        "fn go() { wire::effect::Kind::SaveFilePath(file); }",
    );
    let gaps = owner_lacking(&root);
    assert!(gaps.contains("`SaveFilePath`"), "{gaps}");
    assert!(!gaps.contains("`SaveFile`"), "{gaps}");
    // A neighbour that merely starts like a leaving effect hands nothing out.
    let quiet = owner_tree(
        "owner-neighbour",
        "fn go() { wire::effect::Kind::ShareSheetOpened(x); Kind::SaveFileLater(y); }",
    );
    assert_eq!(owner_lacking(&quiet), "");
}

#[test]
fn an_effect_spelled_through_an_alias_or_a_braced_import_is_still_caught() {
    for (name, text) in [
        (
            "owner-alias",
            "use wire::effect::Kind as K; fn go() { K::ShareBytes(b); }",
        ),
        (
            "owner-alias-long",
            "use wire::effect::Kind as EffectKind; fn go() { EffectKind::SaveFilePath(p); }",
        ),
        (
            "owner-braced",
            "use wire::effect::Kind::{OpenUrl, ShareBytes}; fn go() { ShareBytes(b); }",
        ),
    ] {
        let root = owner_tree(name, text);
        let gaps = owner_lacking(&root);
        assert!(
            gaps.contains("crates/screens/src/notes/transfer.rs")
                && gaps.contains("without asking"),
            "{name}: {gaps}"
        );
    }
    let glob = owner_tree(
        "owner-glob",
        "use wire::effect::Kind::*; fn go() { ShareBytes(b); }",
    );
    assert!(owner_lacking(&glob).contains("every effect kind at once"));
}

#[test]
fn a_leaving_effect_outside_an_apps_folder_is_held_to_the_gate_too() {
    let root = fixture_dir("owner-tree");
    write(
        &root,
        "crates/screens/src/kit/rogue.rs",
        "fn go() { wire::effect::Kind::ShareBytes(b); }",
    );
    write(
        &root,
        "crates/screens/src/shell/fine.rs",
        "use crate::kit::owner::OwnerGate; fn go() { wire::effect::Kind::SaveFilePath(p); }",
    );
    // An app's own folder is held by its row, not scanned twice.
    write(
        &root,
        "crates/screens/src/notes/own.rs",
        "fn go() { wire::effect::Kind::ShareBytes(b); }",
    );
    let gaps = owner_tree_missing_in(&root, &[]).join("\n");
    assert!(gaps.contains("crates/screens/src/kit/rogue.rs"), "{gaps}");
    assert!(
        !gaps.contains("shell/fine.rs") && !gaps.contains("notes/own.rs"),
        "{gaps}"
    );
    // The kit and the runtime may make the gate itself; only an app's screens may not by hand.
    write(
        &root,
        "crates/screens/src/kit/owner.rs",
        "fn ask() { wire::effect::Kind::OwnerCheck(c); }",
    );
    assert!(
        !owner_tree_missing_in(&root, &[])
            .join("\n")
            .contains("kit/owner.rs")
    );
}

#[test]
fn the_committed_screens_keep_the_gate_beside_every_effect_that_hands_data_out() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    assert_eq!(owner_tree_missing(&root), Vec::<String>::new());
    for app in APPS {
        assert_eq!(
            owner_check_missing(&root, app),
            Vec::<String>::new(),
            "{app}"
        );
    }
}

fn effect_proto(root: &Path, fields: &str) {
    write(
        root,
        EFFECT_PROTO,
        &format!(
            "message Other {{ oneof kind {{ Nope nope = 1; }} }}\n\nmessage Effect {{\n  oneof kind {{\n{fields}\n  }}\n  reserved 7;\n}}\n"
        ),
    );
}

#[test]
fn a_new_effect_that_is_on_neither_list_fails_the_gate_and_says_where_to_put_it() {
    let root = fixture_dir("effect-new");
    effect_proto(
        &root,
        "    Share share = 4;\n    // a comment\n    OpenUrl open_url = 5;\n    ShareBlob share_blob = 9;",
    );
    let gaps =
        effect_kinds_missing_in(&root, &["Share"], &[("open_url", "opens a link")]).join("\n");
    assert!(
        gaps.contains("`share_blob`")
            && gaps.contains("LEAVING_EFFECTS")
            && gaps.contains("`ShareBlob`"),
        "{gaps}"
    );
    // The effect of another message's oneof is not an effect.
    assert!(!gaps.contains("nope"), "{gaps}");
    // Listed, it is quiet.
    let listed = effect_kinds_missing_in(
        &root,
        &["Share", "ShareBlob"],
        &[("open_url", "opens a link")],
    );
    assert_eq!(listed, Vec::<String>::new());
}

#[test]
fn an_effect_that_is_gone_or_listed_twice_is_named() {
    let root = fixture_dir("effect-stale");
    effect_proto(&root, "    Share share = 4;\n    OpenUrl open_url = 5;");
    let gaps = effect_kinds_missing_in(
        &root,
        &["Share", "ShareFile"],
        &[
            ("open_url", "opens a link"),
            ("share", "both"),
            ("haptic", "buzz"),
        ],
    )
    .join("\n");
    assert!(
        gaps.contains("`ShareFile`, which is not an effect"),
        "{gaps}"
    );
    assert!(
        gaps.contains("`haptic`") && gaps.contains("which is not an effect"),
        "{gaps}"
    );
    assert!(gaps.contains("`share` is on both lists"), "{gaps}");
}

#[test]
fn the_committed_effects_are_each_on_exactly_one_list() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    assert_eq!(effect_kinds_missing(&root), Vec::<String>::new());
    let missing = fixture_dir("effect-missing-proto");
    assert!(
        effect_kinds_missing(&missing)
            .join("\n")
            .contains("cannot be checked")
    );
    // Every staying effect says why, in words.
    assert!(STAYING_EFFECTS.iter().all(|(_, why)| why.len() > 8));
}

#[test]
fn a_comment_or_a_test_module_that_spells_a_leaving_effect_does_not_count() {
    let root = owner_tree(
        "owner-quiet",
        "// Kind::SaveFile goes to the save sheet\n#[cfg(test)]\nmod tests { fn t() { Kind::Share(x); } }",
    );
    assert_eq!(owner_lacking(&root), "");
}

#[test]
fn an_owner_check_raised_by_hand_is_named_unless_the_file_is_excepted() {
    let hand = "fn ask() { wire::effect::Kind::OwnerCheck(check); }";
    let root = owner_tree("owner-hand", hand);
    assert!(owner_lacking(&root).contains("by hand"));
    let excepted = [OwnerException {
        file: "notes/transfer.rs",
        reason: "its own wall",
    }];
    assert_eq!(
        owner_check_missing_in(&root, "notes", &excepted),
        Vec::<String>::new()
    );
    // An exception for a file that raises nothing is stale and says why.
    let quiet = owner_tree("owner-stale", "fn nothing() {}");
    let gaps = owner_check_missing_in(&quiet, "notes", &excepted).join("\n");
    assert!(
        gaps.contains("raises nothing") && gaps.contains("its own wall"),
        "{gaps}"
    );
}

#[test]
fn only_lockers_wall_is_excepted_and_the_restore_screens_hold_the_gate() {
    let excepted: Vec<&str> = OWNER_EXCEPTIONS.iter().map(|e| e.file).collect();
    assert_eq!(excepted, ["locker/wall.rs"]);
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    assert_eq!(owner_custody_missing(&root), Vec::<String>::new());
    // A fixture with a restore screen that stopped asking is named.
    let bare = fixture_dir("owner-custody");
    write(
        &bare,
        "crates/screens/src/custody/enter.rs",
        "fn restore() {}",
    );
    let gaps = owner_custody_missing(&bare).join("\n");
    assert!(
        gaps.contains("custody/enter.rs") && gaps.contains("custody/make.rs"),
        "{gaps}"
    );
}

#[test]
fn every_app_has_an_owner_check_row_and_the_committed_tree_keeps_it() {
    for app in APPS {
        assert!(
            REGISTER
                .iter()
                .any(|row| row.app == app && row.promise == Promise::OwnerCheck),
            "{app} has no OwnerCheck row"
        );
    }
}

// ---------------------------------------------------------------------------
// Attach
// ---------------------------------------------------------------------------

const ATTACH_MANIFEST: &str = r#"{"actions":[
 {"name":"attach","command":"edge.add","inverse":"detach"},
 {"name":"detach","command":"edge.remove","inverse":"attach"}],
 "queries":[{"name":"attachments"}]}"#;

const ATTACH_INVERSES: &str = r#"const NOTES: &[Row] = &[
    ("attach", "detach", Input::Same),
    ("detach", "attach", Input::Same),
];
"#;

/// A `notes` app that keeps Attach in full.
fn attach_tree(name: &str) -> PathBuf {
    let root = fixture_dir(name);
    write(&root, "crates/apps/notes/manifest.json", ATTACH_MANIFEST);
    write(&root, INVERSE_TABLE, ATTACH_INVERSES);
    write(
        &root,
        "crates/screens/src/notes/editor.rs",
        "use crate::kit::attachments::Attachments;",
    );
    root
}

fn attach_lacking(root: &Path) -> String {
    attach_missing(root, "notes").join("\n")
}

#[test]
fn an_app_with_the_trio_and_the_section_keeps_attach() {
    assert_eq!(attach_lacking(&attach_tree("attach-clean")), "");
}

#[test]
fn a_manifest_without_the_trio_is_named() {
    let root = attach_tree("attach-no-trio");
    write(
        &root,
        "crates/apps/notes/manifest.json",
        r#"{"actions":[{"name":"attach","command":"edge.add","inverse":"detach"}],"queries":[]}"#,
    );
    let gaps = attach_lacking(&root);
    assert!(gaps.contains("declares no `detach` action"), "{gaps}");
    assert!(gaps.contains("declares no `attachments` query"), "{gaps}");
}

#[test]
fn a_pair_that_is_not_each_others_inverse_is_named() {
    let root = attach_tree("attach-no-inverse");
    write(
        &root,
        "crates/apps/notes/manifest.json",
        &ATTACH_MANIFEST.replace(r#""inverse":"attach""#, r#""inverse":"link""#),
    );
    assert!(attach_lacking(&root).contains("`detach` does not declare `attach` as its inverse"));
}

#[test]
fn a_pair_missing_from_the_inverse_table_is_named() {
    let root = attach_tree("attach-no-table");
    write(
        &root,
        INVERSE_TABLE,
        "const NOTES: &[Row] = &[\n    (\"attach\", \"detach\", Input::Same),\n];\n",
    );
    assert!(attach_lacking(&root).contains("has no `detach` row reversed by `attach`"));
}

#[test]
fn a_detail_page_that_does_not_embed_the_section_is_named_by_file_and_kind() {
    let root = attach_tree("attach-no-section");
    write(
        &root,
        "crates/screens/src/notes/editor.rs",
        "// kit::attachments::Attachments is in a comment only\nfn view() {}",
    );
    assert!(attach_lacking(&root).contains(
        "crates/screens/src/notes/editor.rs: the note page does not embed the shared attachments section"
    ));
}

#[test]
fn the_exempt_app_fails_when_its_manifest_grows_the_trio() {
    let root = fixture_dir("attach-exempt");
    write(
        &root,
        "crates/apps/locker/manifest.json",
        r#"{"actions":[{"name":"star-item","command":"flag.add"}],"queries":[]}"#,
    );
    assert!(attach_missing(&root, "locker").is_empty());
    write(&root, "crates/apps/locker/manifest.json", ATTACH_MANIFEST);
    let gaps = attach_missing(&root, "locker").join("\n");
    assert!(
        gaps.contains("declares `attach`, which the ruling forbids (D11"),
        "{gaps}"
    );
    assert!(
        gaps.contains("an `attachments` read, which the ruling forbids"),
        "{gaps}"
    );
}

#[test]
fn an_exempt_row_is_held_to_the_listed_ruling() {
    let root = attach_tree("attach-exempt-row");
    let mut table: Vec<Row> = APPS
        .iter()
        .map(|app| Row {
            app,
            promise: Promise::Attach,
            status: Status::Owed("#1185"),
        })
        .collect();
    table[5].status = Status::Exempt("a ruling nobody listed");
    let found = check(&root, &table).findings.join("\n");
    assert!(
        found.contains("is not a ruling listed in ATTACH_EXEMPT"),
        "{found}"
    );
}

#[test]
fn the_committed_register_exempts_only_locker_and_owes_what_is_not_adopted_yet() {
    let status = |app: &str| {
        REGISTER
            .iter()
            .find(|row| row.app == app && row.promise == Promise::Attach)
            .map(|row| row.status)
            .expect("a row")
    };
    assert!(matches!(status("locker"), Status::Exempt(_)));
    assert!(matches!(status("calendar"), Status::Kept(_)));
    assert!(matches!(status("reminders"), Status::Kept(_)));
    for app in ["people"] {
        assert!(matches!(status(app), Status::Kept(_)), "{app}");
    }
    for app in ["notes", "photos", "docs", "health", "money"] {
        assert!(matches!(status(app), Status::Owed(_)), "{app}");
    }
    assert_eq!(ATTACH_EXEMPT.len(), 1);
}

// ---------------------------------------------------------------------------
// Origin
// ---------------------------------------------------------------------------

const FOOT_THAT_READS: &str = "fn foot() { let origin = origin::read(ctx, id); }";

#[test]
fn a_detail_page_that_hands_the_foots_origin_to_its_view_keeps_origin() {
    let root = fixture_dir("origin-clean");
    write(&root, "crates/screens/src/kit/earlier.rs", FOOT_THAT_READS);
    write(
        &root,
        "crates/screens/src/people/person/mod.rs",
        "fn view() { State { origin: self.earlier.origin.clone() } }",
    );
    assert_eq!(origin_missing(&root, "people").join("\n"), "");
}

#[test]
fn a_detail_page_with_no_origin_is_named_by_file_and_kind() {
    let root = fixture_dir("origin-red");
    write(&root, "crates/screens/src/kit/earlier.rs", FOOT_THAT_READS);
    write(
        &root,
        "crates/screens/src/people/person/mod.rs",
        "fn view() { State {} }",
    );
    let gaps = origin_missing(&root, "people").join("\n");
    assert!(
        gaps.contains("crates/screens/src/people/person: the person page does not hand the foot's origin line to its view"),
        "{gaps}"
    );
    // A line only a test module hands over is not on the page.
    write(
        &root,
        "crates/screens/src/people/person/mod.rs",
        "fn view() {}\n#[cfg(test)]\nmod t { fn x() { let _ = earlier.origin; } }",
    );
    assert!(
        origin_missing(&root, "people")
            .join("\n")
            .contains("does not hand the foot's origin line")
    );
}

#[test]
fn a_foot_that_never_reads_the_origin_is_named_for_every_app() {
    let root = fixture_dir("origin-foot");
    write(&root, "crates/screens/src/kit/earlier.rs", "fn foot() {}");
    write(
        &root,
        "crates/screens/src/people/person/mod.rs",
        "fn view() { earlier.origin }",
    );
    assert!(
        origin_missing(&root, "people")
            .join("\n")
            .contains("kit/earlier.rs does not read where the record came from")
    );
}

#[test]
fn an_owed_origin_row_prints_each_gap_with_its_file() {
    let root = fixture_dir("origin-owed");
    let table: Vec<Row> = APPS
        .iter()
        .map(|app| Row {
            app,
            promise: Promise::Origin,
            status: Status::Owed("#1185"),
        })
        .collect();
    let report = check(&root, &table);
    assert!(
        report
            .details
            .iter()
            .any(|line| line.starts_with("owed notes / Origin:") && line.contains("editor.rs")),
        "{:?}",
        report.details
    );
}

// ---------------------------------------------------------------------------
// Link
// ---------------------------------------------------------------------------

const LINK_MANIFEST: &str = r#"{"actions":[
 {"name":"link","verb":"link:rel","command":"edge.add","inverse":"unlink","input":{"properties":{"rel":{"enum":["links"]}}}},
 {"name":"unlink","verb":"unlink","command":"edge.remove","inverse":"link","input":{"properties":{"rel":{"enum":["links"]}}}}]}"#;

const LINK_INVERSES: &str = r#"const NOTES: &[Row] = &[
    ("link", "unlink", Input::Same),
    ("unlink", "link", Input::Same),
];
"#;

/// A `notes` app that keeps Link in full.
fn link_tree(name: &str) -> PathBuf {
    let root = fixture_dir(name);
    write(&root, "crates/apps/notes/manifest.json", LINK_MANIFEST);
    write(&root, INVERSE_TABLE, LINK_INVERSES);
    write(
        &root,
        "crates/screens/src/notes/editor.rs",
        "fn reload() { let linked = links::read_linked(ctx, &id); }",
    );
    root
}

fn link_lacking(root: &Path) -> String {
    link_missing(root, "notes").join("\n")
}

#[test]
fn an_app_with_the_verbs_and_the_section_keeps_link() {
    assert_eq!(link_lacking(&link_tree("link-clean")), "");
}

#[test]
fn an_app_with_no_link_verbs_is_named() {
    let root = link_tree("link-no-verbs");
    write(
        &root,
        "crates/apps/notes/manifest.json",
        r#"{"actions":[{"name":"star","verb":"star","command":"flag.add","inverse":"star"}]}"#,
    );
    let gaps = link_lacking(&root);
    assert!(
        gaps.contains("declares no `link` and `unlink` pair"),
        "{gaps}"
    );
}

#[test]
fn a_link_verb_that_is_not_the_others_inverse_is_named() {
    let root = link_tree("link-bad-inverse");
    write(
        &root,
        "crates/apps/notes/manifest.json",
        &LINK_MANIFEST.replace(r#""inverse":"link""#, r#""inverse":"star""#),
    );
    assert!(link_lacking(&root).contains("declares no `link` and `unlink` pair"));
}

#[test]
fn a_pair_that_takes_no_links_rel_is_not_the_general_link() {
    let root = link_tree("link-typed-only");
    write(
        &root,
        "crates/apps/notes/manifest.json",
        &LINK_MANIFEST.replace(r#""enum":["links"]"#, r#""enum":["about"]"#),
    );
    assert!(link_lacking(&root).contains("declares no `link` and `unlink` pair"));
}

#[test]
fn a_link_verb_the_undo_table_does_not_classify_is_named() {
    let root = link_tree("link-unclassified");
    write(
        &root,
        INVERSE_TABLE,
        "const NOTES: &[Row] = &[\n    (\"link\", \"unlink\", Input::Same),\n];\n",
    );
    assert!(link_lacking(&root).contains("`unlink` is not classified for Undo"));
}

#[test]
fn a_detail_page_that_does_not_read_its_links_is_named() {
    let root = link_tree("link-no-section");
    write(
        &root,
        "crates/screens/src/notes/editor.rs",
        "// links::read_linked( is in a comment only\nfn view() {}",
    );
    assert!(link_lacking(&root).contains(
        "crates/screens/src/notes/editor.rs: the note page does not embed the kit's general"
    ));
}

#[test]
fn an_owed_link_row_prints_each_gap_with_its_file() {
    let root = link_tree("link-owed");
    write(&root, "crates/screens/src/notes/editor.rs", "fn view() {}");
    let table: Vec<Row> = APPS
        .iter()
        .map(|app| Row {
            app,
            promise: Promise::Link,
            status: Status::Owed("#1185"),
        })
        .collect();
    let report = check(&root, &table);
    assert!(
        report
            .details
            .iter()
            .any(|line| line.starts_with("owed notes / Link:") && line.contains("editor.rs")),
        "{:?}",
        report.details
    );
}

// ---------------------------------------------------------------------------
// Stale save
// ---------------------------------------------------------------------------

/// A `notes` app whose editor sends the revision and answers the refusal through the kit.
fn stale_tree(name: &str) -> PathBuf {
    let root = fixture_dir(name);
    write(
        &root,
        "crates/screens/src/notes/editor.rs",
        "use crate::kit::autosave::Autosave;\nfn request() { EditNote { expected_rev: Some(rev) } }",
    );
    root
}

fn stale_lacking(root: &Path) -> String {
    stale_save_missing(root, "notes").join("\n")
}

#[test]
fn an_editor_that_sends_the_revision_and_answers_the_refusal_keeps_stale_save() {
    assert_eq!(stale_lacking(&stale_tree("stale-clean")), "");
}

#[test]
fn an_editor_that_sends_no_revision_is_named() {
    let root = stale_tree("stale-no-rev");
    write(
        &root,
        "crates/screens/src/notes/editor.rs",
        "use crate::kit::autosave::Autosave;\nfn request() { EditNote {} }",
    );
    assert!(stale_lacking(&root).contains(
        "crates/screens/src/notes/editor.rs: the editor does not send the revision it read"
    ));
}

#[test]
fn an_editor_that_does_not_answer_the_refusal_through_the_kit_is_named() {
    let root = stale_tree("stale-no-kit");
    write(
        &root,
        "crates/screens/src/notes/editor.rs",
        "fn request() { EditNote { expected_rev: Some(rev) } }",
    );
    assert!(stale_lacking(&root).contains("does not answer a stale refusal through the kit"));
}

#[test]
fn a_comment_does_not_count_as_sending_the_revision() {
    let root = stale_tree("stale-comment");
    write(
        &root,
        "crates/screens/src/notes/editor.rs",
        "use crate::kit::autosave::Autosave;\n// expected_rev is sent here\nfn request() {}",
    );
    assert!(stale_lacking(&root).contains("does not send the revision it read"));
}

#[test]
fn a_save_that_leaves_the_revision_empty_does_not_send_it() {
    let root = stale_tree("stale-none");
    write(
        &root,
        "crates/screens/src/notes/editor.rs",
        "use crate::kit::autosave::Autosave;\nfn request() { EditNote { expected_rev: None } }",
    );
    assert!(stale_lacking(&root).contains("does not send the revision it read"));
}

#[test]
fn an_editor_file_that_is_gone_is_named() {
    let root = fixture_dir("stale-gone");
    assert!(stale_lacking(&root).contains("crates/screens/src/notes/editor.rs is missing"));
}

#[test]
fn an_exempt_app_that_grows_an_editor_is_named_and_one_without_is_clean() {
    let root = fixture_dir("stale-exempt");
    write(
        &root,
        "crates/screens/src/health/workout.rs",
        "fn view() {}",
    );
    assert!(stale_save_missing(&root, "health").is_empty());
    write(
        &root,
        "crates/screens/src/health/log.rs",
        "use crate::kit::autosave::Autosave;",
    );
    let gaps = stale_save_missing(&root, "health").join("\n");
    assert!(
        gaps.contains("crates/screens/src/health/log.rs has grown an editor"),
        "{gaps}"
    );
}

#[test]
fn an_owed_stale_save_row_prints_each_gap_with_its_file() {
    let root = stale_tree("stale-owed");
    write(&root, "crates/screens/src/notes/editor.rs", "fn view() {}");
    let table: Vec<Row> = APPS
        .iter()
        .map(|app| Row {
            app,
            promise: Promise::StaleSave,
            status: Status::Owed("#1185"),
        })
        .collect();
    let report = check(&root, &table);
    assert!(
        report
            .details
            .iter()
            .any(|line| line.starts_with("owed notes / Stale save:") && line.contains("editor.rs")),
        "{:?}",
        report.details
    );
}
