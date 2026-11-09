//! Notes' import and export (`notes.import`, `notes.export`; #1173, item 14): a folder is
//! previewed before anything is written, the member's tap imports it, and an export hands the
//! OS save sheet an archive.

mod notes_support;

use centraid_api_proto::core_v1 as wire;
use centraid_screens::catalog::act;
use centraid_screens::notes::routes;
use notes_support::*;

fn state(v: &wire::ViewState) -> &wire::TransferView {
    match &v.kind {
        Some(wire::view_state::Kind::Transfer(view)) => view,
        other => panic!("not a transfer: {other:?}"),
    }
}

fn tap(d: &mut centraid_screens::testing::Driver, i: u64, key: &str) {
    d.send(
        i,
        wire::screen_event::Kind::Transfer(wire::TransferEvent {
            key: key.to_owned(),
        }),
    );
}

fn library_titles(d: &centraid_screens::testing::Driver) -> Vec<String> {
    d.with_ctx(|ctx| {
        match centraid_screens::kit::read::read(
            ctx,
            centraid_screens::catalog::load::notes::Library::default(),
            |answer| match answer {
                wire::app_query_response::Answer::NotesLibrary(l) => Some(l),
                _ => None,
            },
        ) {
            centraid_screens::kit::read::Reading::Data(l) => {
                let mut t: Vec<String> = l.notes.into_iter().filter_map(|n| n.title).collect();
                t.sort();
                t
            }
            _ => panic!("the library reads"),
        }
    })
}

#[test]
fn a_folder_is_previewed_then_imported_on_the_members_tap_and_a_second_import_adds_nothing() {
    let mut d = driver();
    let seeded = library_titles(&d);
    let i = d.push("notes", routes::transfer(false, "Notes"));
    assert_eq!(state(d.view(i)).title, "Import notes");
    assert_eq!(
        state(d.view(i))
            .actions
            .iter()
            .map(|a| a.key.as_str())
            .collect::<Vec<_>>(),
        ["files", "folder"]
    );
    d.effects.clear();
    tap(&mut d, i, "folder");
    let Some(wire::effect::Kind::PickBytes(pick)) = d
        .effects
        .last()
        .and_then(|e| e.effect.as_ref())
        .and_then(|e| e.kind.clone())
    else {
        panic!("a folder pick was asked for");
    };
    assert!(pick.folder);
    let files = |names: &[(&str, &str)]| wire::BytesPicked {
        files: names
            .iter()
            .map(|(name, text)| wire::PickedBytes {
                name: (*name).to_owned(),
                media_type: String::new(),
                content: text.as_bytes().to_vec(),
            })
            .collect(),
        ..wire::BytesPicked::default()
    };
    let vault = [
        ("Trip/Paris.md", "Stay at [[Hotel]] #travel"),
        ("Trip/Hotel.md", "Booked"),
        ("cover.png", "x"),
    ];
    d.answer_effect(wire::effect_result::Outcome::BytesPicked(files(&vault)));
    let view = state(d.view(i)).clone();
    assert_eq!(view.headline, "Ready to import");
    assert_eq!(
        view.rows
            .iter()
            .map(|r| (r.key.as_str(), r.value.as_str()))
            .collect::<Vec<_>>(),
        [
            ("notes", "2"),
            ("links", "1"),
            ("tags", "1"),
            ("notebooks", "1"),
            ("ignored", "1")
        ]
    );
    let primary = view
        .actions
        .iter()
        .find(|a| a.primary)
        .expect("a primary action");
    assert_eq!(primary.label, "Import 2 notes");
    // The preview wrote nothing.
    assert_eq!(library_titles(&d), seeded);
    tap(&mut d, i, "import");
    assert_eq!(state(d.view(i)).headline, "Imported 2 notes");
    let mut grown = seeded.clone();
    grown.extend(["Hotel".to_owned(), "Paris".to_owned()]);
    grown.sort();
    assert_eq!(library_titles(&d), grown);

    // Choosing the same folder again offers to import nothing.
    tap(&mut d, i, "folder");
    d.answer_effect(wire::effect_result::Outcome::BytesPicked(files(&vault)));
    assert_eq!(state(d.view(i)).headline, "No notes in that choice");
}

#[test]
fn an_export_saves_an_archive_through_the_os_save_sheet() {
    let mut d = driver();
    let before = library_titles(&d).len();
    arrange(
        &d,
        act::notes::CreateNote {
            title: "Plan".to_owned(),
            body: "Link to [[Other]]".to_owned(),
            ..Default::default()
        },
    );
    let i = d.push("notes", routes::transfer(true, "Notes"));
    assert_eq!(state(d.view(i)).title, "Export notes");
    assert_eq!(state(d.view(i)).rows[0].label, "All notes");
    d.effects.clear();
    tap(&mut d, i, "all");
    let Some(wire::effect::Kind::SaveFile(save)) = d
        .effects
        .last()
        .and_then(|e| e.effect.as_ref())
        .and_then(|e| e.kind.clone())
    else {
        panic!("the save sheet was asked for");
    };
    assert_eq!(save.name, "Notes.zip");
    assert_eq!(&save.content[..2], b"PK");
    assert!(save.content.windows(9).any(|w| w == b"[[Other]]"));
    d.answer_effect(wire::effect_result::Outcome::Done(wire::EffectDone {}));
    assert_eq!(
        state(d.view(i))
            .status
            .as_ref()
            .map(|s| s.sentence.as_str()),
        Some(format!("Exported {} notes", before + 1).as_str())
    );
}
