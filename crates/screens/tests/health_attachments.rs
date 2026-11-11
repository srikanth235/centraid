//! A workout's page and its attachments section (#1185): the photos and files on one workout, Add
//! file, and Remove with its confirm, through the door a shell uses. The shell picks and stages the
//! bytes (`PickFile`); the screen files them as a document and attaches it. Nothing here streams a
//! byte: the shell's half is answered by value, as a shell answers it.

mod health_support;

use centraid_api_proto::core_v1 as wire;
use centraid_screens::catalog::load;
use centraid_screens::docs;
use centraid_screens::health::{self, routes};
use centraid_screens::testing::Driver;
use health_support::*;
use wire::agenda_attachment_event::Kind as A;
use wire::app_query_response::Answer;
use wire::effect_result::Outcome as O;
use wire::health_workout_event as we;
use wire::screen_event::Kind as E;

/// Monday 9 November 2026, 09:00 UTC: the vault's clock for every test here.
const NOW: i64 = 1_794_214_800_000;

fn seeded() -> (Driver, String) {
    let mut driver = Driver::with_runtime_at(health::runtime(), NOW);
    driver.call(wire::screen_request::Kind::Environment(wire::Environment {
        locale: "en-GB".to_owned(),
        zone: "Europe/Berlin".to_owned(),
        platform: "ios".to_owned(),
        ..Default::default()
    }));
    driver.start();
    connect_store(&driver);
    workout(
        &driver,
        "run",
        "run",
        "2026-11-08T06:40:00.000Z",
        "2026-11-08T07:11:00.000Z",
    );
    let id = match answer(
        &driver,
        load::health::Workouts {
            limit: 50,
            ..Default::default()
        },
    ) {
        Answer::HealthWorkouts(found) => found.workouts[0].activity_id.clone(),
        other => panic!("workouts answered {other:?}"),
    };
    (driver, id)
}

fn on_page(d: &mut Driver, page: u64, kind: A) {
    d.send(
        page,
        E::HealthWorkout(wire::HealthWorkoutEvent {
            kind: Some(we::Kind::Attachment(wire::AgendaAttachmentEvent {
                kind: Some(kind),
            })),
        }),
    );
}

fn section(d: &Driver, page: u64) -> wire::AgendaAttachmentsSection {
    let Some(wire::health_workout_state::Content::Data(data)) =
        &workout_state(d.view(page)).content
    else {
        panic!("workout data")
    };
    data.attachments.clone().expect("an attachments section")
}

fn held(d: &Driver, workout: &str) -> usize {
    match answer(
        d,
        load::health::Attachments {
            item_id: workout.to_owned(),
            after: None,
            limit: 10,
        },
    ) {
        Answer::AgendaAttachments(page) => page.attachments.len(),
        other => panic!("attachments answered {other:?}"),
    }
}

fn picked(blob: char, size: u64, name: &str) -> O {
    O::FilePicked(wire::FilePicked {
        blob: blob.to_string().repeat(64),
        byte_size: size,
        name: name.to_owned(),
        media_type: String::new(),
    })
}

#[test]
fn a_workout_with_nothing_attached_says_so_and_offers_both_adds() {
    let (mut d, id) = seeded();
    let page = push(&mut d, routes::workout(&id, "Health"));
    let section = section(&d, page);
    assert_eq!(section.heading, "Attachments");
    assert!(section.items.is_empty());
    assert_eq!(section.empty_label, "Nothing attached yet.");
    assert_eq!(section.add_photo_label, "Add photo");
    assert_eq!(section.add_file_label, "Add file");
}

#[test]
fn add_file_files_it_in_docs_and_attaches_it_to_the_workout_and_remove_detaches_only_the_edge() {
    let (mut d, id) = seeded();
    let page = push(&mut d, routes::workout(&id, "Health"));
    on_page(&mut d, page, A::AddFile(Default::default()));
    assert!(section(&d, page).busy, "the pick is under way");
    answer_for(&mut d, page, picked('b', 2_400_000, "Route map.pdf"));
    let tile = {
        let section = section(&d, page);
        assert_eq!(section.items.len(), 1, "{:?}", section.status);
        section.items[0].clone()
    };
    assert_eq!(tile.kind, "document");
    assert_eq!(tile.title, "Route map.pdf");
    assert_eq!(
        tile.route.as_ref().map(|route| route.screen.as_str()),
        Some(docs::DOCUMENT),
        "a tap opens the document in Docs"
    );
    assert_eq!(held(&d, &id), 1, "the vault holds the attachment");

    on_page(
        &mut d,
        page,
        A::RemoveAsked(wire::agenda_attachment_event::RemoveAsked {
            attachment_id: tile.attachment_id,
        }),
    );
    let confirm = section(&d, page).remove_confirm.expect("a confirm");
    assert_eq!(confirm.body, "It comes off here. The file stays in Docs.");
    on_page(&mut d, page, A::RemoveConfirmed(Default::default()));
    assert!(section(&d, page).items.is_empty());
    assert_eq!(held(&d, &id), 0);
}
