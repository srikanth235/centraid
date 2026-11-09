//! People's import and export (`people.import`, `people.export`; #1173, item 20): a file is
//! previewed with its merge proposals before anything is written, the member's tap writes, and an
//! export hands the OS save sheet a vCard file.

mod people_support;

use centraid_api_proto::core_v1 as wire;
use centraid_screens::catalog::act;
use centraid_screens::people::routes;
use centraid_screens::testing::Driver;
use people_support::*;

fn state(v: &wire::ViewState) -> &wire::TransferView {
    match &v.kind {
        Some(wire::view_state::Kind::Transfer(view)) => view,
        other => panic!("not a transfer: {other:?}"),
    }
}

fn tap(d: &mut Driver, i: u64, key: &str) {
    d.send(
        i,
        wire::screen_event::Kind::Transfer(wire::TransferEvent {
            key: key.to_owned(),
        }),
    );
}

const FILE: &str = "BEGIN:VCARD\nVERSION:3.0\nFN:Ada Lovelace\nTEL:555 0100\nEND:VCARD\nBEGIN:VCARD\nVERSION:3.0\nFN:Brand New\nEND:VCARD\n";

fn picked(text: &str) -> wire::effect_result::Outcome {
    wire::effect_result::Outcome::BytesPicked(wire::BytesPicked {
        files: vec![wire::PickedBytes {
            name: "people.vcf".to_owned(),
            media_type: String::new(),
            content: text.as_bytes().to_vec(),
        }],
        ..wire::BytesPicked::default()
    })
}

#[test]
fn a_file_is_previewed_with_its_merges_then_imported_on_the_tap_and_again_adds_nothing() {
    let mut d = driver();
    arrange(
        &d,
        act::people::AddPerson {
            title: "Ada Lovelace".to_owned(),
            ..Default::default()
        },
    );
    let before = roster_of(&d).people.len();
    let i = d.push("people", routes::transfer(false, "People"));
    assert_eq!(state(d.view(i)).title, "Import people");
    d.effects.clear();
    tap(&mut d, i, "files");
    d.answer_effect(picked(FILE));
    let view = state(d.view(i)).clone();
    assert_eq!(view.headline, "Ready to import", "{:?}", view.status);
    assert_eq!(
        view.rows
            .iter()
            .map(|r| (r.key.as_str(), r.value.as_str()))
            .collect::<Vec<_>>(),
        [
            ("added", "1"),
            ("merged", "1"),
            ("proposal:Ada Lovelace", "")
        ]
    );
    assert_eq!(
        roster_of(&d).people.len(),
        before,
        "the preview wrote no one"
    );
    let keys: Vec<&str> = view.actions.iter().map(|a| a.key.as_str()).collect();
    assert_eq!(keys, ["import", "add-only", "again"]);

    tap(&mut d, i, "import");
    assert_eq!(state(d.view(i)).headline, "Imported 2 people");
    assert_eq!(
        roster_of(&d).people.len(),
        before + 1,
        "no duplicate of Ada"
    );

    d.effects.clear();
    tap(&mut d, i, "files");
    d.answer_effect(picked(FILE));
    assert_eq!(state(d.view(i)).headline, "Nobody new in that choice");
}

#[test]
fn an_export_saves_a_vcf_through_the_os_save_sheet() {
    let mut d = driver();
    let i = d.push("people", routes::transfer(true, "People"));
    assert_eq!(state(d.view(i)).rows[0].label, "Everyone");
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
    assert_eq!(save.name, "People.vcf");
    assert!(String::from_utf8_lossy(&save.content).contains("BEGIN:VCARD"));
    d.answer_effect(wire::effect_result::Outcome::Done(wire::EffectDone {}));
    assert!(
        state(d.view(i))
            .status
            .as_ref()
            .is_some_and(|s| s.sentence.starts_with("Exported "))
    );
}
