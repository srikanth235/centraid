//! `notes.about`: the one read for "what have I written about this?" — the live
//! notes whose `about` edge ends at a thing, whatever the thing is.

mod notes_support;

use centraid_api_proto::core_v1 as wire;
use centraid_screens::catalog::{act, load};
use notes_support::*;
use wire::app_query_response::Answer;

fn about(d: &centraid_screens::testing::Driver, id: &str) -> wire::NotesAbout {
    match answer(
        d,
        load::notes::About {
            about_id: id.to_owned(),
            limit: 0,
        },
    ) {
        Answer::NotesAbout(found) => found,
        other => panic!("about answered {other:?}"),
    }
}

#[test]
fn the_notes_about_a_thing_are_one_read_newest_first_live_only() {
    let d = driver();
    let mum = id_of(&arrange(
        &d,
        act::people::AddPerson {
            title: "Mum".into(),
            ..Default::default()
        },
    ));
    let dad = id_of(&arrange(
        &d,
        act::people::AddPerson {
            title: "Dad".into(),
            ..Default::default()
        },
    ));
    for (who, words) in [
        (&mum, "Likes the blue scarf"),
        (&mum, "Birthday dinner at six\n- [ ] book a table"),
        (&dad, "Fixing the fence"),
    ] {
        arrange(
            &d,
            act::people::AddNote {
                id: who.clone(),
                text: words.into(),
            },
        );
    }
    // A plain note is about nothing.
    note(&d, "Unrelated", "x");
    let found = about(&d, &mum);
    assert_eq!(found.notes.len(), 2);
    assert!(!found.truncated);
    // Newest first, each a preview and a tally and never a body.
    assert!(found.notes[0].preview.starts_with("Birthday dinner at six"));
    assert_eq!(
        (found.notes[0].check_total, found.notes[0].check_done),
        (1, 0)
    );
    assert!(found.notes[1].preview.starts_with("Likes the blue scarf"));
    assert!(found.notes[0].updated_local_day.len() == 10);
    assert_eq!(about(&d, &dad).notes.len(), 1);

    // A trashed note is no longer about the thing.
    arrange(
        &d,
        act::notes::DeleteNote {
            note_id: found.notes[0].note_id.clone(),
        },
    );
    let after = about(&d, &mum);
    assert_eq!(after.notes.len(), 1);
    assert!(after.notes[0].preview.starts_with("Likes the blue scarf"));
}

#[test]
fn nothing_about_a_thing_is_an_empty_answer_not_a_refusal() {
    let d = driver();
    assert!(about(&d, "no-such-thing").notes.is_empty());
    // A note that is not about anything is not about itself.
    let plain = note(&d, "Plain", "words");
    assert!(about(&d, &plain).notes.is_empty());
}
