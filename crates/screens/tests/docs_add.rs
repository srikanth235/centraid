//! Adding a document from the drive's Add sheet: ports of the `DocsIngestSpec`
//! cases. The shell picks and stages the bytes (the `PickFile` effect); the
//! screen files them with one `act` and asks the shell to open the new page
//! (`OpenRoute`). Nothing here streams a byte: the shell's half is answered by
//! value, as a shell answers it.

mod docs_support;

use centraid_api_proto::core_v1 as wire;
use centraid_screens::docs;
use centraid_screens::testing::Driver;
use docs_support::*;
use wire::docs_drive_event as de;
use wire::docs_drive_event::Kind as D;
use wire::docs_ingest_view::Phase;
use wire::docs_sheet::Kind as Sheet;
use wire::effect::Kind as Fx;
use wire::effect_result::Outcome as O;

fn ingest(d: &Driver, i: u64) -> &wire::DocsIngestView {
    drive_state(d.view(i))
        .ingest
        .as_ref()
        .expect("an ingest line")
}

fn add(d: &mut Driver, i: u64, key: &str) {
    open_sheet(d, i, Sheet::Add);
    pick(d, i, key);
}

fn picked(blob: &str, size: u64, name: &str, media_type: &str) -> O {
    O::FilePicked(wire::FilePicked {
        blob: blob.to_owned(),
        byte_size: size,
        name: name.to_owned(),
        media_type: media_type.to_owned(),
    })
}

/// The route the last `OpenRoute` effect asked the shell to open.
fn opened(d: &Driver) -> Option<wire::Route> {
    d.effects
        .iter()
        .rev()
        .find_map(|request| match request.effect.as_ref()?.kind.as_ref()? {
            Fx::OpenRoute(open) => open.route.clone(),
            _ => None,
        })
}

#[test]
fn upload_picks_then_files_the_staged_bytes_and_opens_the_document() {
    let mut d = driver();
    let i = root(&d);
    add(&mut d, i, "upload");
    // The picker is the shell's: one PickFile, and the line says nothing yet.
    assert!(matches!(
        waiting(&d).first().and_then(|e| e.kind.as_ref()),
        Some(Fx::PickFile(pick)) if pick.kind == wire::pick_file::Kind::Upload as i32
    ));
    assert_eq!(ingest(&d, i).phase, Phase::Picking as i32);
    assert_eq!(ingest(&d, i).status_label, "");
    // Progress while it streams: a bar in thousandths.
    result(
        &mut d,
        i,
        O::FileProgress(wire::FileProgress {
            staged_bytes: 500,
            total_bytes: 2000,
            name: "Lease.pdf".to_owned(),
        }),
    );
    assert_eq!(ingest(&d, i).progress_permille, 250);
    // The file is picked and streaming: the line says what is being added.
    assert_eq!(ingest(&d, i).status_label, "Adding Lease.pdf");
    // The shell staged the file: the screen files it.
    result(&mut d, i, picked(&"b".repeat(64), 2048, "Lease.pdf", ""));
    let line = ingest(&d, i);
    assert_eq!(line.phase, Phase::Filed as i32);
    assert_eq!(line.status_label, "Lease.pdf added");
    assert_eq!(line.dismiss_label, "Dismiss");
    assert_eq!(line.retry_label, "");
    assert_eq!(line.progress_permille, 1000);
    // The document is in the drive, a PDF by its name.
    let row = row(d.view(i), "Lease.pdf");
    assert_eq!(row.kind_label, "PDF");
    // The shell is asked to open its page, back word "Docs".
    let route = opened(&d).expect("the document opens");
    assert_eq!(route.screen, docs::DOCUMENT);
    let Some(wire::route::Args::DocsDocument(args)) = route.args else {
        panic!("a document route");
    };
    assert_eq!(args.document_id, row.document_id);
    assert_eq!(args.parent, "Docs");
    // The line never clears itself: the member puts it away.
    drive_send(&mut d, i, D::IngestDismissed(de::IngestDismissed {}));
    assert_eq!(ingest(&d, i).phase, Phase::Idle as i32);
}

#[test]
fn text_files_an_untitled_document_that_opens_its_editor() {
    let mut d = driver();
    let i = root(&d);
    add(&mut d, i, "text");
    let line = ingest(&d, i);
    assert_eq!(line.phase, Phase::Filed as i32);
    assert_eq!(line.status_label, "Untitled document added");
    let route = opened(&d).expect("the editor opens");
    assert_eq!(route.screen, docs::EDITOR);
    let Some(wire::route::Args::DocsEditor(args)) = route.args else {
        panic!("an editor route");
    };
    let made = document(&d, &args.document_id);
    assert_eq!(made.document.unwrap().title, "Untitled document");
    assert_eq!(made.body.as_deref(), Some(""));
}

#[test]
fn an_add_into_a_folder_lands_in_it_and_names_the_folder_as_the_back_word() {
    let mut d = driver();
    let taxes = folder(&d, "Taxes", None);
    let root_i = root(&d);
    let page = d.push(docs::TAB, docs::routes::folder(&taxes, "Taxes", "Docs"));
    d.effects.clear();
    let _ = root_i;
    add(&mut d, page, "text");
    let route = opened(&d).expect("the editor opens");
    let Some(wire::route::Args::DocsEditor(args)) = route.args else {
        panic!("an editor route");
    };
    assert_eq!(
        document(&d, &args.document_id).document.unwrap().folder_id,
        taxes
    );
    // An upload names the page it came from.
    d.effects.clear();
    add(&mut d, page, "upload");
    result(
        &mut d,
        page,
        picked(&"c".repeat(64), 10, "Scan.pdf", "application/pdf"),
    );
    let route = opened(&d).expect("the page opens");
    let Some(wire::route::Args::DocsDocument(args)) = route.args else {
        panic!("a document route");
    };
    assert_eq!(args.parent, "Taxes");
}

#[test]
fn scan_with_no_name_is_a_scanned_document_and_a_closed_picker_says_nothing() {
    let mut d = driver();
    let i = root(&d);
    add(&mut d, i, "scan");
    assert!(matches!(
        waiting(&d).first().and_then(|e| e.kind.as_ref()),
        Some(Fx::PickFile(pick)) if pick.kind == wire::pick_file::Kind::Scan as i32
    ));
    result(&mut d, i, O::Done(wire::EffectDone {}));
    assert_eq!(ingest(&d, i).phase, Phase::Idle as i32);
    assert_eq!(ingest(&d, i).status_label, "");
    add(&mut d, i, "scan");
    result(
        &mut d,
        i,
        picked(&"d".repeat(64), 100, "", "application/pdf"),
    );
    assert_eq!(ingest(&d, i).status_label, "Scanned document added");
    assert!(titles(d.view(i)).contains(&"Scanned document".to_owned()));
}

#[test]
fn a_refusal_is_a_failure_with_try_again_a_held_file_refiles_none_repicks() {
    let mut d = driver();
    let i = root(&d);
    // A hash that is not one: the vault's schema refuses, with its sentence.
    add(&mut d, i, "upload");
    result(&mut d, i, picked("short", 10, "Bad.pdf", ""));
    let line = ingest(&d, i);
    assert_eq!(line.phase, Phase::Failed as i32);
    assert!(!line.status_label.is_empty());
    assert_eq!(line.retry_label, "Try again");
    assert_eq!(line.dismiss_label, "Dismiss");
    assert!(opened(&d).is_none());
    // Try again with the file held files it again (still refused: the same
    // bytes); it does not ask the picker.
    d.effects.clear();
    drive_send(&mut d, i, D::IngestRetried(de::IngestRetried {}));
    assert!(waiting(&d).is_empty(), "the file is held: no picker");
    assert_eq!(ingest(&d, i).phase, Phase::Failed as i32);
    // A pick that failed outright re-picks.
    drive_send(&mut d, i, D::IngestDismissed(de::IngestDismissed {}));
    add(&mut d, i, "upload");
    result(
        &mut d,
        i,
        O::Failed(wire::EffectFailed {
            reason: "boom".to_owned(),
            denied: false,
        }),
    );
    assert_eq!(
        ingest(&d, i).status_label,
        "Centraid could not read that file."
    );
    drive_send(&mut d, i, D::IngestRetried(de::IngestRetried {}));
    assert!(matches!(
        waiting(&d).first().and_then(|e| e.kind.as_ref()),
        Some(Fx::PickFile(_))
    ));
    assert_eq!(ingest(&d, i).phase, Phase::Picking as i32);
}

#[test]
fn a_scanner_refused_the_camera_says_where_to_turn_it_on_not_that_a_file_failed() {
    let mut d = driver();
    let i = root(&d);
    add(&mut d, i, "scan");
    result(
        &mut d,
        i,
        O::Failed(wire::EffectFailed {
            reason: "camera".to_owned(),
            denied: true,
        }),
    );
    assert_eq!(
        ingest(&d, i).status_label,
        "Camera access is off. Turn it on in Settings."
    );
    drive_send(&mut d, i, D::IngestDismissed(de::IngestDismissed {}));
    add(&mut d, i, "upload");
    result(
        &mut d,
        i,
        O::Failed(wire::EffectFailed {
            reason: docs::drive::UNAVAILABLE.to_owned(),
            denied: false,
        }),
    );
    assert_eq!(
        ingest(&d, i).status_label,
        "This phone cannot open a file picker here."
    );
}

#[test]
fn one_ingest_at_a_time_a_second_request_is_nothing() {
    let mut d = driver();
    let i = root(&d);
    add(&mut d, i, "upload");
    d.effects.clear();
    add(&mut d, i, "scan");
    assert!(waiting(&d).is_empty());
    assert_eq!(ingest(&d, i).phase, Phase::Picking as i32);
    // Following a folder is the shell's too: its picker, then the folder is listed.
    drive_send(&mut d, i, D::IngestDismissed(de::IngestDismissed {}));
}

#[test]
fn following_a_folder_asks_the_shell_and_lists_the_answer() {
    let mut d = driver();
    let i = root(&d);
    add(&mut d, i, "follow_folder");
    assert!(matches!(
        waiting(&d).first().and_then(|e| e.kind.as_ref()),
        Some(Fx::FollowFolder(_))
    ));
    result(
        &mut d,
        i,
        O::FolderFollowed(wire::FolderFollowed {
            origin: "folder:abc".to_owned(),
            name: "Scans".to_owned(),
        }),
    );
    band(&mut d, i, "more");
    assert!(sheet_keys(drive_state(d.view(i))).contains(&"followed".to_owned()));
    // A refused pick is a sentence over the rows.
    add(&mut d, i, "follow_folder");
    result(
        &mut d,
        i,
        O::Failed(wire::EffectFailed {
            reason: "no access".to_owned(),
            denied: false,
        }),
    );
    assert_eq!(
        drive_state(d.view(i)).status.as_ref().unwrap().sentence,
        "That folder couldn't be followed. Try again."
    );
}
