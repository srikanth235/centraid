//! THE MEMBER'S FIRST ITEM (`first_item_at`): the earliest row they made or imported. The starter
//! notes are not theirs and nor is the founding person, so a founded vault with only those has no
//! first item; the first note they write is it, at that note's time.

mod common;

use centraid_vault::first_item::first_item_at;
use common::{Scratch, add_person, insert_note, self_person};

const STARTERS: [&str; 2] = ["This note is yours", "Link with [["];

#[test]
fn starters_and_the_founding_person_alone_are_no_first_item() {
    let scratch = Scratch::founded("first-item-starters").expect("a founded vault");
    assert!(
        self_person(&scratch.vault).is_ok(),
        "the founding person exists"
    );
    assert_eq!(
        first_item_at(&scratch.vault, &STARTERS),
        None,
        "founded, nothing else"
    );
    for title in STARTERS {
        insert_note(&scratch.vault, title).expect("a starter");
    }
    assert_eq!(
        first_item_at(&scratch.vault, &STARTERS),
        None,
        "the starters are not the member's"
    );
}

#[test]
fn the_first_note_is_the_first_item_at_the_notes_time() {
    let scratch = Scratch::founded("first-item-note").expect("a founded vault");
    for title in STARTERS {
        insert_note(&scratch.vault, title).expect("a starter");
    }
    scratch.clock.advance_days(3);
    let written = scratch.vault.clock().now_text();
    insert_note(&scratch.vault, "Groceries").expect("the member's note");
    scratch.clock.advance_days(2);
    insert_note(&scratch.vault, "A later note").expect("a later note");
    assert_eq!(
        first_item_at(&scratch.vault, &STARTERS),
        Some(written),
        "the earliest of the member's own rows, not the starters' or a later note's"
    );
}

#[test]
fn a_second_person_counts_and_the_founding_one_does_not() {
    let scratch = Scratch::founded("first-item-person").expect("a founded vault");
    scratch.clock.advance_days(1);
    let at = scratch.vault.clock().now_text();
    let id = scratch.vault.ids().next();
    scratch
        .vault
        .commit(|tx| {
            tx.set_producer("test.add_person");
            add_person(tx, &id, "Dana Reyes", &at)
        })
        .expect("a second person");
    assert_eq!(first_item_at(&scratch.vault, &STARTERS), Some(at));
}

/// A kind only an import or a workout makes still counts: Home leaves day zero for it, so the first
/// item must exist for the pair prompt.
#[test]
fn a_workout_alone_is_a_first_item() {
    use centraid_vault::model::Kind;
    let scratch = Scratch::founded("first-item-activity").expect("a founded vault");
    scratch.clock.advance_days(1);
    let at = scratch.vault.clock().now_text();
    let id = scratch.vault.ids().next();
    scratch
        .vault
        .commit(|tx| {
            tx.set_producer("test.activity");
            tx.insert_entity(&id, Kind::Workout, "Morning run", &at)
        })
        .expect("a workout");
    assert_eq!(first_item_at(&scratch.vault, &STARTERS), Some(at));
}

/// The starter tasks older vaults were founded with are starters, as the notes are.
#[test]
fn the_retired_starter_tasks_are_no_first_item() {
    use centraid_vault::model::Kind;
    let scratch = Scratch::founded("first-item-old-tasks").expect("a founded vault");
    let titles = [
        "Tap the circle to finish me",
        "Open me to add a date, a tag or a subtask",
    ];
    let all: Vec<&str> = STARTERS.iter().chain(titles.iter()).copied().collect();
    let now = scratch.vault.clock().now_text();
    for title in titles {
        let id = scratch.vault.ids().next();
        scratch
            .vault
            .commit(|tx| {
                tx.set_producer("test.old_task");
                tx.insert_entity(&id, Kind::Task, title, &now)
            })
            .expect("an old starter task");
    }
    assert_eq!(first_item_at(&scratch.vault, &all), None);
}
