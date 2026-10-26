//! One document, its version history, its editor and its trash: ports of the
//! `DocsSpec` document, editor and trash cases, through `Driver`.

mod docs_support;

use std::time::Duration;

use centraid_api_proto::core_v1 as wire;
use centraid_screens::catalog::act;
use centraid_screens::docs::{self, routes};
use centraid_screens::testing::Driver;
use docs_support::*;
use wire::docs_document_event as dd;
use wire::docs_document_event::Kind as DD;
use wire::docs_document_state::Asking;
use wire::docs_editor_event as ee;
use wire::docs_editor_event::Kind as EE;
use wire::docs_sheet::Kind as Sheet;
use wire::trash_event as te;
use wire::trash_event::Kind as T;

fn open(d: &mut Driver, id: &str, title: &str, parent: &str) -> u64 {
    d.push(docs::TAB, routes::document(id, title, parent))
}

fn pick_doc(d: &mut Driver, i: u64, key: &str) {
    document_send(
        d,
        i,
        DD::Action(dd::ActionPicked {
            key: key.to_owned(),
        }),
    );
}

fn keys(v: &wire::ViewState) -> Vec<String> {
    document_data(v)
        .actions
        .iter()
        .map(|action| action.key.clone())
        .collect()
}

#[test]
fn a_documents_back_names_the_page_it_was_pushed_from_else_docs() {
    let mut d = driver();
    let id = text(&d, "Notes", "words");
    let a = open(&mut d, &id, "Notes", "Taxes");
    assert_eq!(
        document_state(d.view(a)).chrome.as_ref().unwrap().back,
        "Taxes"
    );
    let b = open(&mut d, &id, "Notes", "");
    assert_eq!(
        document_state(d.view(b)).chrome.as_ref().unwrap().back,
        "Docs"
    );
    assert_eq!(document_state(d.view(b)).title_hint, "Notes");
}

#[test]
fn the_reader_draws_the_text_with_the_facts_the_path_and_the_activity() {
    let mut d = driver();
    let taxes = folder(&d, "Taxes", None);
    let id = text(&d, "Return", "# Numbers\n\nline");
    arrange(
        &d,
        act::docs::Move {
            document_id: id.clone(),
            folder_id: Some(taxes.clone()),
        },
    );
    let i = open(&mut d, &id, "Return", "Docs");
    let data = document_data(d.view(i));
    let row = data.row.as_ref().unwrap();
    assert_eq!(row.title, "Return");
    let Some(wire::docs_document_data::Surface::Reading(reader)) = &data.surface else {
        panic!("a text document is a reader: {:?}", data.surface);
    };
    assert_eq!(reader.body, "# Numbers\n\nline");
    assert!(reader.has_text && reader.editable);
    assert_eq!(reader.edit_label, "Edit");
    assert_eq!(reader.format, wire::docs_reader::Format::Plain as i32);
    // The path is the core's one folder walk: a crumb opens the folder.
    assert_eq!(data.path.len(), 1);
    assert_eq!(data.path[0].name, "Taxes");
    assert_eq!(data.path[0].route.as_ref().unwrap().screen, docs::DRIVE);
    let facts: Vec<(&str, &str)> = data
        .facts
        .iter()
        .map(|fact| (fact.label.as_str(), fact.detail.as_str()))
        .collect();
    assert!(facts.contains(&("Kind", "Document")), "{facts:?}");
    assert!(facts.contains(&("Folder", "Taxes")), "{facts:?}");
    assert!(facts.iter().any(|(label, _)| *label == "Added"));
    assert_eq!(
        keys(d.view(i)),
        ["edit", "star", "rename", "move", "labels", "trash"]
    );
    // Edit is a route the shell pushes.
    let edit = &data.actions[0];
    assert_eq!(edit.route.as_ref().unwrap().screen, docs::EDITOR);
    assert!(!data.activity.is_empty());
    let said: Vec<&str> = data.activity.iter().map(|row| row.label.as_str()).collect();
    assert!(said.contains(&"Moved"), "{said:?}");
    assert_eq!(data.activity_empty, "");
}

#[test]
fn a_document_over_bytes_this_device_does_not_hold_says_why() {
    let mut d = driver();
    let id = pdf(&d, "Lease.pdf", 'e');
    let i = open(&mut d, &id, "Lease.pdf", "Docs");
    let data = document_data(d.view(i));
    let Some(wire::docs_document_data::Surface::Stage(stage)) = &data.surface else {
        panic!("a PDF is a stage: {:?}", data.surface);
    };
    assert_eq!(stage.media, wire::docs_stage::Media::Pdf as i32);
    assert!(!stage.held);
    assert!(!stage.absent_reason.is_empty());
    assert_eq!(stage.accessibility_label, "Lease.pdf, PDF");
    // The player's words are Rust's, for an audio or a video file the stage plays.
    assert_eq!(
        (stage.play_label.as_str(), stage.pause_label.as_str()),
        ("Play", "Pause")
    );
    // No Edit on a stage.
    assert!(!keys(d.view(i)).contains(&"edit".to_owned()));
}

#[test]
fn a_document_that_is_gone_is_a_state_not_a_failure() {
    let mut d = driver();
    let i = open(&mut d, "nope", "", "");
    let data = document_data(d.view(i));
    assert!(data.row.is_none());
    assert!(matches!(
        data.surface,
        Some(wire::docs_document_data::Surface::Gone(_))
    ));
}

#[test]
fn the_heads_writes_star_rename_move_and_labels() {
    let mut d = driver();
    let taxes = folder(&d, "Taxes", None);
    let id = text(&d, "Return", "x");
    let i = open(&mut d, &id, "Return", "Docs");
    pick_doc(&mut d, i, "star");
    assert!(document_data(d.view(i)).row.as_ref().unwrap().starred);
    assert_eq!(keys(d.view(i))[1], "unstar");
    // The verbs sheet lists every verb the head offers; a pick closes it.
    document_send(&mut d, i, DD::MoreOpened(dd::MoreOpened {}));
    let sheet = document_state(d.view(i)).sheet.as_ref().unwrap();
    assert_eq!(sheet.title, "Return");
    assert_eq!(sheet.kind, Sheet::More as i32);
    pick_doc(&mut d, i, "move");
    let sheet = document_state(d.view(i)).sheet.as_ref().unwrap();
    assert_eq!(sheet.kind, Sheet::Move as i32);
    document_send(
        &mut d,
        i,
        DD::Choice(dd::ChoicePicked { key: taxes.clone() }),
    );
    let data = document_data(d.view(i));
    assert_eq!(data.row.as_ref().unwrap().folder_id, taxes);
    assert_eq!(data.path[0].name, "Taxes");
    pick_doc(&mut d, i, "labels");
    document_send(
        &mut d,
        i,
        DD::LabelAdded(dd::LabelAdded {
            label: "2026".to_owned(),
        }),
    );
    assert_eq!(
        document_data(d.view(i)).row.as_ref().unwrap().labels[0].label,
        "2026"
    );
    // Rename is inline and autosaves; close saves.
    pick_doc(&mut d, i, "rename");
    document_send(
        &mut d,
        i,
        DD::RenameEdited(dd::RenameEdited {
            title: "Return 2026".to_owned(),
        }),
    );
    assert_eq!(
        document_data(d.view(i)).row.as_ref().unwrap().title,
        "Return 2026"
    );
    document_send(&mut d, i, DD::RenameClosed(dd::RenameClosed {}));
    assert!(document_state(d.view(i)).rename.is_none());
    assert_eq!(document(&d, &id).document.unwrap().title, "Return 2026");
}

#[test]
fn trashing_asks_first_and_a_trashed_document_offers_restore_and_delete_forever() {
    let mut d = driver();
    let id = text(&d, "Return", "x");
    let i = open(&mut d, &id, "Return", "Docs");
    pick_doc(&mut d, i, "trash");
    let state = document_state(d.view(i));
    assert_eq!(state.asking, Asking::Trash as i32);
    assert_eq!(state.confirm.as_ref().unwrap().title, "Move to trash?");
    document_send(&mut d, i, DD::Dismissed(dd::Dismissed {}));
    assert!(document_state(d.view(i)).confirm.is_none());
    pick_doc(&mut d, i, "trash");
    document_send(&mut d, i, DD::Confirmed(dd::Confirmed {}));
    let data = document_data(d.view(i));
    assert!(data.row.as_ref().unwrap().trashed);
    assert_eq!(keys(d.view(i)), ["restore", "purge"]);
    assert!(data.actions[1].destructive);
    // It never says it will be deleted: the window's end is a restore's end.
    assert!(
        data.trashed_note.starts_with("In trash · restorable until"),
        "{}",
        data.trashed_note
    );
    // A trashed document is not editable.
    let Some(wire::docs_document_data::Surface::Reading(reader)) = &data.surface else {
        panic!();
    };
    assert!(!reader.editable);
    // A verb it does not offer is nothing.
    pick_doc(&mut d, i, "star");
    assert!(!document_data(d.view(i)).row.as_ref().unwrap().starred);
    pick_doc(&mut d, i, "restore");
    assert!(!document_data(d.view(i)).row.as_ref().unwrap().trashed);
    assert_eq!(document_data(d.view(i)).trashed_note, "");
}

#[test]
fn delete_forever_on_a_trashed_document_asks_first_purges_it_and_the_page_leaves() {
    let mut d = driver();
    let id = text(&d, "Return", "x");
    arrange(
        &d,
        act::docs::Trash {
            document_id: id.clone(),
        },
    );
    let i = open(&mut d, &id, "Return", "Docs");
    pick_doc(&mut d, i, "purge");
    let state = document_state(d.view(i));
    assert_eq!(state.asking, Asking::Purge as i32);
    let confirm = state.confirm.as_ref().unwrap();
    assert_eq!(confirm.title, "Delete this forever?");
    assert_eq!(
        confirm.body,
        "It leaves this vault for good. This cannot be undone."
    );
    assert_eq!(confirm.confirm_label, "Delete forever");
    assert!(confirm.destructive);
    assert!(!document_state(d.view(i)).dismissed);
    document_send(&mut d, i, DD::Confirmed(dd::Confirmed {}));
    assert!(document_state(d.view(i)).dismissed);
    assert!(document(&d, &id).document.is_none());
}

#[test]
fn version_history_is_a_page_and_an_earlier_version_is_made_current_by_a_restore() {
    let mut d = driver();
    let id = text(&d, "Letter", "first");
    arrange(
        &d,
        act::docs::Edit {
            document_id: id.clone(),
            body_text: Some("second".to_owned()),
            title: None,
        },
    );
    let i = open(&mut d, &id, "Letter", "Docs");
    let link = document_data(d.view(i))
        .versions
        .as_ref()
        .expect("a versions row");
    assert_eq!(link.label, "Versions");
    assert_eq!(link.count_label, "2 versions");
    let route = link.route.clone().unwrap();
    assert_eq!(route.screen, docs::VERSIONS);
    let page = d.push(docs::TAB, route);
    let state = versions_state(d.view(page));
    assert_eq!(state.chrome.as_ref().unwrap().back, "Letter");
    let Some(wire::docs_versions_state::Content::Data(data)) = &state.content else {
        panic!("{:?}", state.content);
    };
    assert_eq!(data.versions.len(), 2);
    assert_eq!(data.versions[0].label, "Version 2");
    assert!(data.versions[0].current);
    assert!(
        data.versions[0].meta.starts_with("Current"),
        "{}",
        data.versions[0].meta
    );
    assert_eq!(data.versions[0].restore_label, "");
    assert_eq!(data.versions[1].label, "Version 1");
    assert_eq!(data.versions[1].restore_label, "Restore");
    d.send(
        page,
        wire::screen_event::Kind::DocsVersions(wire::DocsVersionsEvent {
            kind: Some(wire::docs_versions_event::Kind::Restored(
                wire::docs_versions_event::Restored {
                    key: "1".to_owned(),
                },
            )),
        }),
    );
    // Version 1's words are the document again, and the history walks on.
    assert_eq!(document(&d, &id).body.as_deref(), Some("first"));
    let state = versions_state(d.view(page));
    let Some(wire::docs_versions_state::Content::Data(data)) = &state.content else {
        panic!();
    };
    assert_eq!(data.versions.len(), 3);
    assert!(state.status.is_none());
    // The current version is nothing to restore.
    d.send(
        page,
        wire::screen_event::Kind::DocsVersions(wire::DocsVersionsEvent {
            kind: Some(wire::docs_versions_event::Kind::Restored(
                wire::docs_versions_event::Restored {
                    key: "3".to_owned(),
                },
            )),
        }),
    );
    assert_eq!(document(&d, &id).versions.len(), 3);
}

#[test]
fn a_trashed_documents_versions_offer_no_restore() {
    let mut d = driver();
    let id = text(&d, "Letter", "first");
    arrange(
        &d,
        act::docs::Edit {
            document_id: id.clone(),
            body_text: Some("second".to_owned()),
            title: None,
        },
    );
    arrange(
        &d,
        act::docs::Trash {
            document_id: id.clone(),
        },
    );
    let page = d.push(docs::TAB, routes::versions(&id, "Letter"));
    let state = versions_state(d.view(page));
    let Some(wire::docs_versions_state::Content::Data(data)) = &state.content else {
        panic!();
    };
    assert!(data.versions.iter().all(|v| v.restore_label.is_empty()));
}

// ---------------------------------------------------------------------------
// The editor
// ---------------------------------------------------------------------------

fn editor(d: &mut Driver, id: &str) -> u64 {
    d.push(docs::TAB, routes::editor(id, "T"))
}

#[test]
fn the_editor_autosaves_one_edit_per_settled_edit_and_the_version_follows() {
    let mut d = driver();
    let id = text(&d, "Letter", "first");
    let i = editor(&mut d, &id);
    let state = editor_state(d.view(i));
    let Some(wire::docs_editor_state::Content::Draft(draft)) = &state.content else {
        panic!("{:?}", state.content);
    };
    assert_eq!(draft.title, "Letter");
    assert_eq!(draft.body, "first");
    assert_eq!(state.version_label, "Version 1");
    assert_eq!(state.status_label, "");
    editor_send(
        &mut d,
        i,
        EE::Body(ee::BodyEdited {
            body: "first and more".to_owned(),
        }),
    );
    assert_eq!(editor_state(d.view(i)).status_label, "Edited");
    assert_eq!(
        document(&d, &id).body.as_deref(),
        Some("first"),
        "typing is not a write"
    );
    d.pump(Duration::from_millis(1300));
    assert_eq!(document(&d, &id).body.as_deref(), Some("first and more"));
    assert_eq!(editor_state(d.view(i)).version_label, "Version 2");
    // A title change is sent with the body, only when it changed.
    editor_send(
        &mut d,
        i,
        EE::Title(ee::TitleEdited {
            title: "Letter 2".to_owned(),
        }),
    );
    d.pump(Duration::from_millis(1300));
    let made = document(&d, &id);
    assert_eq!(made.document.unwrap().title, "Letter 2");
    assert_eq!(made.body.as_deref(), Some("first and more"));
}

#[test]
fn closing_the_editor_saves_what_is_unsaved_and_a_refused_save_keeps_the_words() {
    let mut d = driver();
    let id = text(&d, "Letter", "first");
    let i = editor(&mut d, &id);
    editor_send(
        &mut d,
        i,
        EE::Title(ee::TitleEdited {
            title: " ".to_owned(),
        }),
    );
    d.pump(Duration::from_millis(1300));
    let state = editor_state(d.view(i));
    assert_eq!(state.status_label, "A document needs a name.");
    assert!(state.autosave.as_ref().unwrap().refused);
    assert_eq!(document(&d, &id).document.unwrap().title, "Letter");
    editor_send(
        &mut d,
        i,
        EE::Title(ee::TitleEdited {
            title: "Kept".to_owned(),
        }),
    );
    editor_send(
        &mut d,
        i,
        EE::Body(ee::BodyEdited {
            body: "closing words".to_owned(),
        }),
    );
    // Close = done: popped, so the runtime tells the screen it left.
    d.pop(docs::TAB, i);
    let made = document(&d, &id);
    assert_eq!(made.document.unwrap().title, "Kept");
    assert_eq!(made.body.as_deref(), Some("closing words"));
}

#[test]
fn a_vault_change_never_replaces_words_being_typed() {
    let mut d = driver();
    let id = text(&d, "Letter", "first");
    let i = editor(&mut d, &id);
    editor_send(
        &mut d,
        i,
        EE::Body(ee::BodyEdited {
            body: "mine".to_owned(),
        }),
    );
    arrange(
        &d,
        act::docs::Edit {
            document_id: id.clone(),
            body_text: Some("elsewhere".to_owned()),
            title: None,
        },
    );
    d.pump(Duration::from_millis(300));
    let state = editor_state(d.view(i));
    let Some(wire::docs_editor_state::Content::Draft(draft)) = &state.content else {
        panic!();
    };
    assert_eq!(draft.body, "mine");
    assert_eq!(state.remote_note, "Changed elsewhere; saving reloads it.");
}

#[test]
fn only_a_live_text_document_with_text_opens_in_the_editor() {
    let mut d = driver();
    let sentence = |d: &Driver, i: u64| match &editor_state(d.view(i)).content {
        Some(wire::docs_editor_state::Content::Failure(f)) => f.sentence.clone(),
        other => panic!("{other:?}"),
    };
    let binary = pdf(&d, "Lease.pdf", 'f');
    let i = editor(&mut d, &binary);
    assert_eq!(sentence(&d, i), "This document has no text to edit.");
    let trashed = text(&d, "Old", "x");
    arrange(
        &d,
        act::docs::Trash {
            document_id: trashed.clone(),
        },
    );
    let j = editor(&mut d, &trashed);
    assert_eq!(sentence(&d, j), "Restore this document to edit it.");
    let k = editor(&mut d, "nope");
    assert_eq!(sentence(&d, k), "This document is no longer here.");
}

// ---------------------------------------------------------------------------
// The trash
// ---------------------------------------------------------------------------

fn trash_send(d: &mut Driver, i: u64, kind: T) {
    d.send(
        i,
        wire::screen_event::Kind::Trash(wire::TrashEvent { kind: Some(kind) }),
    );
}

fn trash_ids(v: &wire::ViewState) -> Vec<String> {
    match &trash_view(v).content {
        Some(wire::trash_view::Content::Data(data)) => {
            data.rows.iter().map(|row| row.id.clone()).collect()
        }
        other => panic!("{other:?}"),
    }
}

#[test]
fn the_trash_destroys_on_photos_path_delete_forever_and_empty_trash_each_behind_a_confirm() {
    let mut d = driver();
    let a = text(&d, "A", "x");
    let b = text(&d, "B", "y");
    arrange(
        &d,
        act::docs::Trash {
            document_id: a.clone(),
        },
    );
    arrange(
        &d,
        act::docs::Trash {
            document_id: b.clone(),
        },
    );
    let i = d.push(docs::TAB, routes::trash());
    let view = trash_view(d.view(i));
    assert_eq!(view.app_id, "docs");
    assert_eq!(view.back_label, "Docs");
    assert_eq!(view.purge_window_days, 30);
    assert_eq!(trash_ids(d.view(i)).len(), 2);
    let Some(wire::trash_view::Content::Data(data)) = &view.content else {
        panic!();
    };
    let row = data.rows.iter().find(|row| row.id == a).unwrap();
    assert!(row.meta.starts_with("Deleted "), "{}", row.meta);
    assert!(
        !row.meta.contains("Erased"),
        "no row says when it will be erased"
    );
    assert_eq!(row.purge_label, "Delete forever");
    assert_eq!(data.empty_label, "Empty trash");
    // Delete forever: the kit's confirm, then the bytes go.
    trash_send(&mut d, i, T::Purge(te::PurgeTapped { id: a.clone() }));
    let confirm = trash_view(d.view(i)).confirm.as_ref().unwrap();
    assert_eq!(confirm.title, "Delete this forever?");
    assert!(confirm.destructive);
    trash_send(&mut d, i, T::Confirmed(te::Confirmed {}));
    assert_eq!(trash_ids(d.view(i)), std::slice::from_ref(&b));
    assert!(document(&d, &a).document.is_none());
    // Empty trash.
    trash_send(&mut d, i, T::Empty(te::EmptyTapped {}));
    let confirm = trash_view(d.view(i)).confirm.as_ref().unwrap();
    assert_eq!(confirm.title, "Empty trash?");
    trash_send(&mut d, i, T::Confirmed(te::Confirmed {}));
    assert!(trash_ids(d.view(i)).is_empty());
    assert!(document(&d, &b).document.is_none());
    let Some(wire::trash_view::Content::Data(data)) = &trash_view(d.view(i)).content else {
        panic!();
    };
    assert_eq!(
        data.empty.as_ref().unwrap().body,
        "Trashed documents can be restored for 30 days."
    );
}

#[test]
fn restore_asks_nothing_and_brings_the_document_back_where_it_was() {
    let mut d = driver();
    let taxes = folder(&d, "Taxes", None);
    let id = text(&d, "Return", "x");
    arrange(
        &d,
        act::docs::Move {
            document_id: id.clone(),
            folder_id: Some(taxes.clone()),
        },
    );
    arrange(
        &d,
        act::docs::Trash {
            document_id: id.clone(),
        },
    );
    let i = d.push(docs::TAB, routes::trash());
    trash_send(&mut d, i, T::Restore(te::RestoreTapped { id: id.clone() }));
    assert!(trash_view(d.view(i)).confirm.is_none());
    assert!(!trash_ids(d.view(i)).contains(&id));
    assert_eq!(document(&d, &id).document.unwrap().folder_id, taxes);
}
