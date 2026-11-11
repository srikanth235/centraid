//! The kit's one export screen (#1185), proved over fake specs so no app's vault command is in
//! the way: the owner check comes before the file, a pass saves, a cancel does nothing, a phone
//! with no passcode warns or refuses as the spec says, and leaving withdraws the prompt.

use centraid_api_proto::core_v1 as wire;
use centraid_screens::kit::export::{self, Choice, ExportFile, ExportSpec, Made, StagedFile};
use centraid_screens::kit::owner::NoPasscode;
use centraid_screens::kit::read::Reading;
use centraid_screens::strings::Locale;
use centraid_screens::testing::Driver;
use centraid_screens::{Ctx, Registry, Runtime};

fn words(_: Locale) -> String {
    "Words".to_owned()
}

fn denied(_: Locale, _: &wire::AppQueryDenial) -> wire::Denied {
    wire::Denied {
        title: "Not here".to_owned(),
        body: "The vault said no.".to_owned(),
        receipt: String::new(),
    }
}

fn two(_: &Ctx) -> Reading<Vec<Choice>> {
    Reading::Data(vec![
        Choice {
            key: "all".to_owned(),
            label: "Everything".to_owned(),
            value: String::new(),
        },
        Choice {
            key: "one".to_owned(),
            label: "One".to_owned(),
            value: "3".to_owned(),
        },
    ])
}

fn refused(_: &Ctx) -> Reading<Vec<Choice>> {
    Reading::Denied(wire::AppQueryDenial::default())
}

fn file(_: &Ctx, key: &str) -> Result<Made, String> {
    Ok(Made::Bytes(ExportFile {
        name: format!("{key}.txt"),
        media_type: "text/plain".to_owned(),
        content: b"hello".to_vec(),
    }))
}

fn staged(_: &Ctx, key: &str) -> Result<Made, String> {
    Ok(Made::Staged(StagedFile {
        path: format!("/staging/{key}.zip"),
        name: format!("{key}.zip"),
        media_type: "application/zip".to_owned(),
        saved: if key == "all" { 7 } else { 0 },
        // "All" has originals it could not include, and names the first five.
        missing: if key == "all" { 5 } else { 0 },
        left_out: if key == "all" {
            ["A.pdf", "B.pdf", "C.pdf", "D.pdf", "E.pdf"]
                .map(str::to_owned)
                .to_vec()
        } else {
            Vec::new()
        },
    }))
}

fn breaks(_: &Ctx, _: &str) -> Result<Made, String> {
    Err(String::new())
}

macro_rules! spec {
    ($name:ident, $choices:ident, $export:ident, $policy:expr) => {
        static $name: ExportSpec = ExportSpec {
            app: "fake",
            title: words,
            lede: words,
            back_label: words,
            denied,
            choices: $choices,
            export: $export,
            no_passcode: $policy,
        };
    };
}

spec!(WARNS, two, file, NoPasscode::Warn);
spec!(REFUSES, two, file, NoPasscode::Refuse);
spec!(DENIED, refused, file, NoPasscode::Warn);
spec!(BREAKS, two, breaks, NoPasscode::Warn);
spec!(STREAMS, two, staged, NoPasscode::Warn);

fn open(spec: &'static ExportSpec) -> (Driver, u64) {
    let route = export::entry(Locale::En, "fake.export").route;
    let runtime = Runtime::new(
        Registry::default().with("fake.export", move |route| export::build(spec, route)),
        vec![("fake".to_owned(), route.clone())],
    );
    let mut driver = Driver::with_runtime(runtime);
    driver.start();
    let instance = driver.push("fake", route);
    (driver, instance)
}

fn view(d: &Driver, i: u64) -> &wire::TransferView {
    match &d.view(i).kind {
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

fn kinds(d: &Driver) -> Vec<wire::effect::Kind> {
    d.effects
        .iter()
        .filter_map(|request| request.effect.as_ref()?.kind.clone())
        .collect()
}

fn saves(d: &Driver) -> Vec<wire::SaveFile> {
    kinds(d)
        .into_iter()
        .filter_map(|kind| match kind {
            wire::effect::Kind::SaveFile(save) => Some(save),
            _ => None,
        })
        .collect()
}

fn checked(outcome: wire::owner_checked::Outcome, available: bool) -> wire::effect_result::Outcome {
    wire::effect_result::Outcome::OwnerChecked(wire::OwnerChecked {
        available,
        outcome: outcome as i32,
        ..wire::OwnerChecked::default()
    })
}

/// Answer the owner check, however many effects it raises, until it is the save sheet's turn.
fn answer_owner_check(d: &mut Driver, outcome: wire::owner_checked::Outcome, available: bool) {
    while matches!(kinds(d).first(), Some(wire::effect::Kind::OwnerCheck(_))) {
        d.answer_effect(checked(outcome, available));
    }
}

#[test]
fn the_rows_are_the_apps_choices_in_the_kits_words() {
    let (d, i) = open(&WARNS);
    let page = view(&d, i);
    assert_eq!(page.title, "Words");
    assert_eq!(page.headline, "Choose what to export");
    assert_eq!(page.back_label, "Words");
    assert_eq!(
        page.rows
            .iter()
            .map(|row| row.key.as_str())
            .collect::<Vec<_>>(),
        ["all", "one"]
    );
    assert!(page.rows.iter().all(|row| row.tappable));
    assert!(!page.busy);
}

#[test]
fn the_file_is_made_and_saved_only_after_the_owner_check_passes() {
    let (mut d, i) = open(&WARNS);
    d.effects.clear();
    tap(&mut d, i, "one");
    assert!(matches!(
        kinds(&d).first(),
        Some(wire::effect::Kind::OwnerCheck(_))
    ));
    assert!(saves(&d).is_empty(), "nothing leaves before the check");
    assert!(view(&d, i).busy);

    answer_owner_check(&mut d, wire::owner_checked::Outcome::Succeeded, true);
    let [save] = saves(&d).try_into().expect("one file to the save sheet");
    assert_eq!(
        (save.name.as_str(), save.media_type.as_str()),
        ("one.txt", "text/plain")
    );
    assert_eq!(save.content, b"hello");

    d.answer_effect(wire::effect_result::Outcome::Done(wire::EffectDone {}));
    let status = view(&d, i).status.clone().expect("a saved line");
    assert_eq!(status.sentence, "Export saved");
    assert!(!status.refused);
    assert!(!view(&d, i).busy);
}

#[test]
fn a_cancelled_check_does_nothing() {
    let (mut d, i) = open(&WARNS);
    d.effects.clear();
    tap(&mut d, i, "all");
    answer_owner_check(&mut d, wire::owner_checked::Outcome::Cancelled, true);
    assert!(saves(&d).is_empty());
    assert!(view(&d, i).status.is_none());
    assert!(!view(&d, i).busy);
}

#[test]
fn a_phone_with_no_passcode_exports_with_a_warning_when_the_spec_warns() {
    let (mut d, i) = open(&WARNS);
    d.effects.clear();
    tap(&mut d, i, "all");
    answer_owner_check(&mut d, wire::owner_checked::Outcome::Unavailable, false);
    assert_eq!(saves(&d).len(), 1, "it goes ahead");
    d.answer_effect(wire::effect_result::Outcome::Done(wire::EffectDone {}));
    let status = view(&d, i).status.clone().expect("a line");
    assert!(!status.refused);
    assert!(
        status.sentence.starts_with("Export saved. ") && status.sentence.len() > 14,
        "the warning rides with the saved line: {}",
        status.sentence
    );
}

#[test]
fn a_phone_with_no_passcode_is_refused_when_the_spec_refuses() {
    let (mut d, i) = open(&REFUSES);
    d.effects.clear();
    tap(&mut d, i, "all");
    answer_owner_check(&mut d, wire::owner_checked::Outcome::Unavailable, false);
    assert!(saves(&d).is_empty());
    let status = view(&d, i).status.clone().expect("a sentence");
    assert!(status.refused && !status.sentence.is_empty());
}

#[test]
fn a_command_that_cannot_make_the_file_says_so_in_the_kits_words() {
    let (mut d, i) = open(&BREAKS);
    d.effects.clear();
    tap(&mut d, i, "all");
    answer_owner_check(&mut d, wire::owner_checked::Outcome::Succeeded, true);
    assert!(saves(&d).is_empty());
    let status = view(&d, i).status.clone().expect("a sentence");
    assert_eq!(status.sentence, "Could not export");
    assert!(status.refused);
}

#[test]
fn a_dismissed_save_sheet_says_nothing_and_a_failed_one_says_so() {
    let (mut d, i) = open(&WARNS);
    d.effects.clear();
    tap(&mut d, i, "all");
    answer_owner_check(&mut d, wire::owner_checked::Outcome::Succeeded, true);
    d.answer_effect(wire::effect_result::Outcome::Failed(wire::EffectFailed {
        cancelled: true,
        ..wire::EffectFailed::default()
    }));
    assert!(view(&d, i).status.is_none());

    d.effects.clear();
    tap(&mut d, i, "all");
    answer_owner_check(&mut d, wire::owner_checked::Outcome::Succeeded, true);
    d.answer_effect(wire::effect_result::Outcome::Failed(wire::EffectFailed {
        reason: "disk".to_owned(),
        ..wire::EffectFailed::default()
    }));
    let status = view(&d, i).status.clone().expect("a line");
    assert_eq!(status.sentence, "Could not export");
    assert!(status.refused);
}

#[test]
fn a_row_the_page_never_offered_asks_nothing() {
    let (mut d, i) = open(&WARNS);
    d.effects.clear();
    tap(&mut d, i, "ghost");
    assert!(d.effects.is_empty());
}

#[test]
fn leaving_while_the_check_is_up_withdraws_it() {
    let (mut d, i) = open(&WARNS);
    d.effects.clear();
    tap(&mut d, i, "all");
    d.effects.clear();
    d.pop("fake", i);
    assert!(
        kinds(&d)
            .iter()
            .any(|kind| matches!(kind, wire::effect::Kind::OwnerCheck(check) if check.cancel)),
        "the prompt is withdrawn"
    );
}

#[test]
fn a_denied_read_draws_the_gate_and_offers_nothing() {
    let (d, i) = open(&DENIED);
    let page = view(&d, i);
    assert_eq!(page.headline, "Not here");
    assert_eq!(page.lede, "The vault said no.");
    assert!(page.rows.is_empty());
}

fn path_saves(d: &Driver) -> Vec<wire::SaveFilePath> {
    kinds(d)
        .into_iter()
        .filter_map(|kind| match kind {
            wire::effect::Kind::SaveFilePath(save) => Some(save),
            _ => None,
        })
        .collect()
}

#[test]
fn a_staged_file_goes_to_the_save_sheet_by_its_path_after_the_owner_check() {
    let (mut d, i) = open(&STREAMS);
    d.effects.clear();
    tap(&mut d, i, "one");
    assert!(path_saves(&d).is_empty(), "nothing leaves before the check");
    answer_owner_check(&mut d, wire::owner_checked::Outcome::Succeeded, true);
    let [save] = path_saves(&d)
        .try_into()
        .expect("one staged file to the save sheet");
    assert_eq!(
        (
            save.path.as_str(),
            save.name.as_str(),
            save.media_type.as_str()
        ),
        ("/staging/one.zip", "one.zip", "application/zip")
    );
    assert!(saves(&d).is_empty(), "the bytes are not carried as well");
    d.answer_effect(wire::effect_result::Outcome::Done(wire::EffectDone {}));
    assert_eq!(
        view(&d, i).status.clone().expect("a line").sentence,
        "Export saved"
    );
    assert!(!view(&d, i).busy);
}

#[test]
fn a_saved_export_counts_what_it_saved_and_names_the_originals_it_left_out() {
    let (mut d, i) = open(&STREAMS);
    d.effects.clear();
    tap(&mut d, i, "all");
    answer_owner_check(&mut d, wire::owner_checked::Outcome::Succeeded, true);
    d.answer_effect(wire::effect_result::Outcome::Done(wire::EffectDone {}));
    assert_eq!(
        view(&d, i).status.clone().expect("a line").sentence,
        "Export saved: 7 files. 5 originals were left out: A.pdf, B.pdf, C.pdf and 2 more"
    );
    // The next export starts clean.
    d.effects.clear();
    tap(&mut d, i, "one");
    answer_owner_check(&mut d, wire::owner_checked::Outcome::Succeeded, true);
    d.answer_effect(wire::effect_result::Outcome::Done(wire::EffectDone {}));
    assert_eq!(
        view(&d, i).status.clone().expect("a line").sentence,
        "Export saved"
    );
}

#[test]
fn a_dismissed_staged_save_says_nothing_and_a_failed_one_says_so() {
    let (mut d, i) = open(&STREAMS);
    d.effects.clear();
    tap(&mut d, i, "all");
    answer_owner_check(&mut d, wire::owner_checked::Outcome::Succeeded, true);
    d.answer_effect(wire::effect_result::Outcome::Failed(wire::EffectFailed {
        reason: "dismissed".to_owned(),
        cancelled: true,
        ..wire::EffectFailed::default()
    }));
    assert!(view(&d, i).status.is_none());
    d.effects.clear();
    tap(&mut d, i, "all");
    answer_owner_check(&mut d, wire::owner_checked::Outcome::Succeeded, true);
    d.answer_effect(wire::effect_result::Outcome::Failed(wire::EffectFailed {
        reason: "the file could not be written".to_owned(),
        ..wire::EffectFailed::default()
    }));
    let status = view(&d, i).status.clone().expect("a line");
    assert!(status.refused);
}
