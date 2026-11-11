//! Docs' export of its originals (`docs.export`, #1185): the More sheet's Export row, "All
//! documents" and each top-level folder, the owner check first, and then a STREAMED file: the core
//! stages one zip on disk and the OS save sheet is offered its path (`SaveFilePath`), never its
//! bytes. Every test goes through `Driver`.

mod docs_support;

use centraid_api_proto::core_v1 as wire;
use centraid_screens::docs;
use centraid_screens::kit::export;
use centraid_screens::strings::Locale;
use centraid_screens::testing::Driver;
use centraid_vault::portable::zip::stored_entries;
use docs_support::*;

fn transfer(v: &wire::ViewState) -> &wire::TransferView {
    match &v.kind {
        Some(wire::view_state::Kind::Transfer(view)) => view,
        other => panic!("not a transfer: {other:?}"),
    }
}

fn open(d: &mut Driver) -> u64 {
    let entry = export::entry(Locale::En, docs::EXPORT);
    d.push(docs::TAB, entry.route)
}

fn tap(d: &mut Driver, i: u64, key: &str) {
    d.effects.clear();
    d.send(
        i,
        wire::screen_event::Kind::Transfer(wire::TransferEvent {
            key: key.to_owned(),
        }),
    );
}

fn first_kind(d: &Driver) -> Option<wire::effect::Kind> {
    d.effects
        .first()
        .and_then(|e| e.effect.as_ref())
        .and_then(|e| e.kind.clone())
}

fn pass_owner_check(d: &mut Driver) {
    while matches!(first_kind(d), Some(wire::effect::Kind::OwnerCheck(_))) {
        d.answer_effect(wire::effect_result::Outcome::OwnerChecked(
            wire::OwnerChecked {
                available: true,
                outcome: wire::owner_checked::Outcome::Succeeded as i32,
                ..wire::OwnerChecked::default()
            },
        ));
    }
}

fn staged(d: &Driver) -> wire::SaveFilePath {
    let Some(wire::effect::Kind::SaveFilePath(save)) = d
        .effects
        .last()
        .and_then(|e| e.effect.as_ref())
        .and_then(|e| e.kind.clone())
    else {
        panic!("the save sheet was offered a staged file: {:?}", d.effects);
    };
    save
}

fn entries(save: &wire::SaveFilePath) -> Vec<(String, String)> {
    let bytes = std::fs::read(&save.path).expect("the staged file is on disk");
    let mut listed: Vec<(String, String)> = stored_entries(&bytes)
        .expect("a zip")
        .into_iter()
        .map(|(name, body)| (name, String::from_utf8(body).expect("text")))
        .collect();
    listed.sort();
    listed
}

#[test]
fn the_more_sheet_offers_export_and_it_lists_all_documents_and_each_top_level_folder() {
    let mut d = driver();
    let home = root(&d);
    let taxes = folder(&d, "Taxes", None);
    folder(&d, "2026", Some(&taxes));
    folder(&d, "Travel", None);
    band(&mut d, home, "more");
    let sheet = drive_state(d.view(home)).sheet.as_ref().expect("a sheet");
    let Some(wire::docs_sheet::Body::Actions(list)) = &sheet.body else {
        panic!("no actions");
    };
    let row = list
        .actions
        .iter()
        .find(|a| a.key == "export")
        .expect("an Export row in More");
    assert_eq!(row.label, "Export");
    assert_eq!(row.meta, "Your originals as one archive");
    assert_eq!(row.route.as_ref().expect("a route").screen, docs::EXPORT);

    let i = open(&mut d);
    let page = transfer(d.view(i));
    assert_eq!(page.title, "Export documents");
    let labels: Vec<&str> = page.rows.iter().map(|r| r.label.as_str()).collect();
    assert_eq!(labels[0], "All documents");
    assert!(labels.contains(&"Taxes") && labels.contains(&"Travel"));
    assert!(
        !labels.contains(&"2026"),
        "a folder below the top rides with its parent"
    );
}

#[test]
fn a_tap_asks_the_owner_check_then_offers_the_staged_file_to_the_save_sheet() {
    let mut d = driver();
    let taxes = folder(&d, "Taxes", None);
    let year = folder(&d, "2026", Some(&taxes));
    text(&d, "Top.txt", "at the top");
    let in_taxes = text(&d, "Lease.txt", "the lease");
    let in_year = text(&d, "Receipt.txt", "a receipt");
    for (id, folder) in [(&in_taxes, &taxes), (&in_year, &year)] {
        arrange(
            &d,
            centraid_screens::catalog::act::docs::Move {
                document_id: id.clone(),
                folder_id: Some(folder.clone()),
            },
        );
    }
    let i = open(&mut d);
    tap(&mut d, i, &taxes);
    assert!(matches!(
        first_kind(&d),
        Some(wire::effect::Kind::OwnerCheck(_))
    ));
    assert!(
        !d.effects.iter().any(|e| matches!(
            e.effect.as_ref().and_then(|e| e.kind.as_ref()),
            Some(wire::effect::Kind::SaveFilePath(_) | wire::effect::Kind::SaveFile(_))
        )),
        "nothing is made before the check"
    );
    pass_owner_check(&mut d);
    let save = staged(&d);
    assert_eq!(save.name, "Taxes.zip");
    assert_eq!(save.media_type, "application/zip");
    assert_eq!(
        entries(&save),
        [
            ("2026/Receipt.txt".to_owned(), "a receipt".to_owned()),
            ("Lease.txt".to_owned(), "the lease".to_owned()),
        ]
    );
    d.answer_effect(wire::effect_result::Outcome::Done(wire::EffectDone {}));
    assert_eq!(
        transfer(d.view(i))
            .status
            .as_ref()
            .map(|s| s.sentence.as_str()),
        Some("Export saved")
    );
}

#[test]
fn all_documents_is_one_archive_with_the_trash_left_out() {
    let mut d = driver();
    text(&d, "Kept.txt", "kept");
    let gone = text(&d, "Gone.txt", "gone");
    arrange(
        &d,
        centraid_screens::catalog::act::docs::Trash { document_id: gone },
    );
    let i = open(&mut d);
    tap(&mut d, i, "all");
    pass_owner_check(&mut d);
    let save = staged(&d);
    assert_eq!(save.name, "Documents.zip");
    let listed = entries(&save);
    assert!(listed.contains(&("Kept.txt".to_owned(), "kept".to_owned())));
    assert!(!listed.iter().any(|(name, _)| name == "Gone.txt"));
}

#[test]
fn a_folder_with_nothing_in_it_says_so_and_offers_nothing_to_save() {
    let mut d = driver();
    let empty = folder(&d, "Empty", None);
    let i = open(&mut d);
    tap(&mut d, i, &empty);
    pass_owner_check(&mut d);
    assert!(!d.effects.iter().any(|e| matches!(
        e.effect.as_ref().and_then(|e| e.kind.as_ref()),
        Some(wire::effect::Kind::SaveFilePath(_))
    )));
    let status = transfer(d.view(i)).status.clone().expect("a line");
    assert!(status.refused);
    assert_eq!(
        status.sentence,
        "There are no documents on this phone to export."
    );
}

#[test]
fn a_cancelled_check_makes_no_file() {
    let mut d = driver();
    text(&d, "Kept.txt", "kept");
    let i = open(&mut d);
    tap(&mut d, i, "all");
    d.answer_effect(wire::effect_result::Outcome::OwnerChecked(
        wire::OwnerChecked {
            available: true,
            outcome: wire::owner_checked::Outcome::Cancelled as i32,
            ..wire::OwnerChecked::default()
        },
    ));
    assert!(!d.effects.iter().any(|e| matches!(
        e.effect.as_ref().and_then(|e| e.kind.as_ref()),
        Some(wire::effect::Kind::SaveFilePath(_))
    )));
    assert!(transfer(d.view(i)).status.is_none());
}

#[test]
fn a_save_says_how_many_originals_were_not_on_this_phone() {
    let mut d = driver();
    text(&d, "Here.txt", "here");
    pdf(&d, "Far.pdf", 'a');
    pdf(&d, "Farther.pdf", 'b');
    let i = open(&mut d);
    tap(&mut d, i, "all");
    pass_owner_check(&mut d);
    let _ = staged(&d);
    d.answer_effect(wire::effect_result::Outcome::Done(wire::EffectDone {}));
    assert_eq!(
        transfer(d.view(i))
            .status
            .as_ref()
            .map(|s| s.sentence.as_str()),
        Some("Export saved. 2 originals were not on this phone and are left out")
    );
}
