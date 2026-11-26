//! `concept.merge` and `place.merge` (#1214, V4, V5): two words or two places that are one. What
//! named the one that goes names the one that stays, what was homed in it is homed in the other,
//! and the one that goes is purged.

mod common;

use centraid_vault::model::Kind;
use common::world::World;
use serde_json::json;

fn world(seed: &str) -> World {
    World {
        scratch: common::Scratch::founded_with_blobs(seed).expect("a vault"),
        registry: centraid_vault::commands::Registry::with_system_commands().expect("a registry"),
    }
}

fn tag(w: &World, on: &str, label: &str) -> String {
    w.ok("tag.add", json!({ "id": on, "label": label }))["tag"]
        .as_str()
        .expect("a tag")
        .to_owned()
}

fn exists(w: &World, id: &str) -> bool {
    w.one::<i64>("SELECT COUNT(*) FROM entity WHERE id = ?1", &[id]) == 1
}

#[test]
fn a_tag_merged_into_another_puts_its_items_under_the_other_and_its_children_inside_it() {
    let w = World::new("merge_tags");
    let (one, two, both) = (w.note("One"), w.note("Two"), w.note("Both"));
    let (loser, winner) = (tag(&w, &one, "Trip"), tag(&w, &two, "Travel"));
    w.ok("tag.add", json!({ "id": &both, "label": "Trip" }));
    w.ok("tag.add", json!({ "id": &both, "label": "Travel" }));
    let child = tag(&w, &one, "Paris");
    w.ok("entity.move", json!({ "id": &child, "parent": &loser }));
    w.ok("concept.merge", json!({ "from": &loser, "into": &winner }));
    assert!(!exists(&w, &loser));
    assert_eq!(
        w.strings(
            "SELECT from_id FROM edge WHERE to_id = ?1 AND rel = 'tagged' ORDER BY from_id",
            &[&winner]
        )
        .len(),
        3,
        "each item is tagged once with the survivor"
    );
    assert_eq!(
        w.one::<Option<String>>("SELECT parent_id FROM entity WHERE id = ?1", &[&child]),
        Some(winner.clone())
    );
}

#[test]
fn a_merge_inside_itself_or_across_kinds_is_refused() {
    let w = World::new("merge_refused");
    let note = w.note("N");
    let tag_id = tag(&w, &note, "A");
    let category = w.ok(
        "container.create",
        json!({ "kind": "list", "title": "Not a word" }),
    )["id"]
        .as_str()
        .expect("an id")
        .to_owned();
    assert!(
        w.refused("concept.merge", json!({ "from": &tag_id, "into": &tag_id }))
            .contains("itself")
    );
    assert!(
        w.refused(
            "concept.merge",
            json!({ "from": &tag_id, "into": &category })
        )
        .contains("only a tag")
    );
}

#[test]
fn a_kind_of_workout_and_a_kind_of_touch_merged_move_what_was_of_their_kind() {
    let w = World::new("merge_kinds");
    let (run, jog) = (
        w.made(Kind::WorkoutKind, "Run"),
        w.made(Kind::WorkoutKind, "Jog"),
    );
    let workout = w.bare(Kind::Workout, "", None);
    w.commit(|tx| {
        tx.connection().execute(
            "INSERT INTO workout (id, type_id, starts) VALUES (?1, ?2, '2026-03-01T09:00:00.000Z')",
            [&workout, &jog],
        )?;
        Ok(())
    });
    w.ok("concept.merge", json!({ "from": &jog, "into": &run }));
    assert_eq!(
        w.one::<String>("SELECT type_id FROM workout WHERE id = ?1", &[&workout]),
        run
    );
    assert!(!exists(&w, &jog));
}

#[test]
fn a_place_merged_into_another_takes_every_column_that_named_it() {
    let w = world("merge_places");
    let loser = w.ok("place.add", json!({ "title": "Cafe", "address": "1 Rue" }))["id"]
        .as_str()
        .expect("an id")
        .to_owned();
    let winner = w.ok(
        "place.add",
        json!({ "title": "The Cafe", "lat": 48.8, "lon": 2.3 }),
    )["id"]
        .as_str()
        .expect("an id")
        .to_owned();
    let event = w.ok(
        "event.propose",
        json!({ "title": "Coffee", "starts": "2026-03-05T10:00", "timing": "floating", "place_id": &loser }),
    )["id"]
        .as_str()
        .expect("an id")
        .to_owned();
    let hash = centraid_vault::blob::content_digest(b"cafe");
    w.ok("blob.stage", json!({ "hash": hash, "size": 4 }));
    let photo = w.ok(
        "photo.add",
        json!({ "blob": hash, "media_type": "image/jpeg", "place_id": &loser }),
    )["id"]
        .as_str()
        .expect("an id")
        .to_owned();
    w.ok("place.merge", json!({ "from": &loser, "into": &winner }));
    assert!(!exists(&w, &loser));
    assert_eq!(
        w.one::<String>("SELECT place_id FROM event WHERE id = ?1", &[&event]),
        winner
    );
    assert_eq!(
        w.one::<String>("SELECT place_id FROM photo WHERE id = ?1", &[&photo]),
        winner
    );
    assert_eq!(
        w.one::<String>("SELECT address FROM place WHERE id = ?1", &[&winner]),
        "1 Rue",
        "a blank is filled from the place that goes"
    );
    assert!(
        w.refused("place.merge", json!({ "from": &winner, "into": &event }))
            .contains("only places")
    );
}

#[test]
fn a_category_merged_into_another_files_its_parts_budget_and_rules_under_the_other() {
    let w = World::new("merge_category");
    let account = w.ok(
        "account.add",
        json!({ "title": "Everyday", "type": "checking", "currency": "USD" }),
    )["id"]
        .as_str()
        .expect("an id")
        .to_owned();
    let line = w.ok(
        "txn.add",
        json!({ "account_id": &account, "posted_on": "2026-03-02", "amount_minor": -800, "title": "Shop" }),
    )["id"]
        .as_str()
        .expect("an id")
        .to_owned();
    w.ok(
        "txn.split",
        json!({ "id": &line, "parts": [
            { "category_id": "category:food.groceries", "amount_minor": -500 },
            { "category_id": "category:food.dining", "amount_minor": -300 } ] }),
    );
    w.ok(
        "budget.set",
        json!({ "month": "2026-03", "category_id": "category:food.groceries", "amount_minor": 4_000 }),
    );
    w.ok(
        "concept.merge",
        json!({ "from": "category:food.groceries", "into": "category:food.dining" }),
    );
    assert!(!exists(&w, "category:food.groceries"));
    assert_eq!(
        w.strings(
            "SELECT category_id || '|' || amount_minor FROM txn_split WHERE txn_id = ?1",
            &[&line]
        ),
        ["category:food.dining|-800"],
        "two parts under one category become one and the line still sums"
    );
    assert_eq!(
        w.one::<i64>(
            "SELECT amount_minor FROM budget WHERE category_id = 'category:food.dining'",
            &[]
        ),
        4_000
    );
}
