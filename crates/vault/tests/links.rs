//! THE GENERAL LINK (#1185, #1214 A4): any linkable item links to any other (a Locker item
//! included, it is an ordinary app's item), a link made on one page shows on the other, either page
//! takes it off, a duplicate in either direction is impossible, and what is not an item is refused
//! with a sentence. The table's own rules are held by `schema_rules.rs`; this proves the commands
//! and the reads a page uses.

mod common;

use centraid_vault::links;
use centraid_vault::model::Kind;
use common::world::{AT, World};
use serde_json::json;

fn link_rows(w: &World) -> i64 {
    w.one("SELECT COUNT(*) FROM link", &[])
}

#[test]
fn every_linkable_kind_links_to_every_other_in_either_order_and_the_rest_are_refused() {
    let w = World::new("links_matrix");
    let linkable = w.kinds_linkable(true);
    assert!(linkable.len() >= 12, "{linkable:?}");
    assert!(linkable.contains(&Kind::LockerItem), "Locker is ordinary");
    let ones: Vec<(Kind, String)> = linkable.iter().map(|k| (*k, w.made(*k, "Alpha"))).collect();
    let twos: Vec<(Kind, String)> = linkable.iter().map(|k| (*k, w.made(*k, "Beta"))).collect();
    // Every kind to every kind, one end made from the first set and the other from the second;
    // half of them are asked in the other order, which is the same link.
    for (n, (from_kind, from)) in ones.iter().enumerate() {
        for (m, (to_kind, to)) in twos.iter().enumerate() {
            let (x, y) = if (n + m) % 2 == 0 {
                (from, to)
            } else {
                (to, from)
            };
            let out = w.ok("link.add", json!({"a": x, "b": y}));
            assert_eq!(out["added"], true, "{from_kind:?} {to_kind:?}");
        }
    }
    let pairs = (linkable.len() * linkable.len()) as i64;
    assert_eq!(link_rows(&w), pairs);
    // Asking again, from either end, adds nothing.
    for (_, from) in &ones {
        for (_, to) in &twos {
            assert_eq!(
                w.ok("link.add", json!({"a": to, "b": from}))["added"],
                false
            );
        }
    }
    assert_eq!(
        link_rows(&w),
        pairs,
        "a duplicate in either direction is the same row"
    );
    // The lower id is always `a`.
    assert_eq!(
        w.one::<i64>("SELECT COUNT(*) FROM link WHERE a >= b", &[]),
        0
    );

    // What is not an item (a reading, a chat, a container, a label) is no end, as the kind's own
    // row says; the member reads why.
    let before = link_rows(&w);
    let person = &ones[0].1;
    let refused_kinds = w.kinds_linkable(false);
    assert!(refused_kinds.contains(&Kind::Reading) && refused_kinds.contains(&Kind::Tag));
    for kind in refused_kinds {
        let other = w.made(kind, "Nope");
        for (a, b) in [(&other, person), (person, &other)] {
            let sentence = w.refused("link.add", json!({"a": a, "b": b}));
            assert!(
                sentence.contains("cannot be linked") && sentence.contains(&kind.noun()),
                "{kind:?}: {sentence}"
            );
        }
    }
    assert_eq!(link_rows(&w), before, "a refused link writes nothing");
}

#[test]
fn a_thing_is_not_linked_to_itself_and_a_missing_or_trashed_end_is_refused() {
    let w = World::new("links_ends");
    let a = w.person("Ada");
    assert!(
        w.refused("link.add", json!({"a": &a, "b": &a}))
            .contains("itself")
    );
    assert!(
        w.refused(
            "link.add",
            json!({"a": &a, "b": "01900000-0000-7000-8000-00000000dead"})
        )
        .contains("nothing with the id")
    );
    let b = w.person("Bo");
    w.ok("entity.trash", json!({"id": &b}));
    assert!(
        w.refused("link.add", json!({"a": &a, "b": &b}))
            .contains("in the trash")
    );
    assert_eq!(link_rows(&w), 0);
}

#[test]
fn a_link_shows_on_both_pages_and_either_page_takes_it_off() {
    let w = World::new("links_both");
    let note = w.note("Trip");
    let place = w.made(Kind::Place, "Lisbon");
    w.ok("link.add", json!({"a": &note, "b": &place}));
    let linked = |id: &str| w.vault().read(|c| links::linked(c, id)).expect("reads");
    let from_note = linked(&note);
    assert_eq!(from_note.len(), 1);
    assert_eq!(
        (from_note[0].id.as_str(), from_note[0].kind),
        (place.as_str(), Kind::Place)
    );
    assert!(!from_note[0].in_text);
    let from_place = linked(&place);
    assert_eq!(from_place.len(), 1, "the other page shows the note");
    assert_eq!(
        (from_place[0].id.as_str(), from_place[0].kind),
        (note.as_str(), Kind::Note)
    );
    // The two reads are one row, read from `a` and from `b`.
    assert_eq!(link_rows(&w), 1);

    // The page that did not make it takes it off.
    let (a, b) = links::ordered(&note, &place);
    let maker_is_a = a == note;
    assert_eq!(
        w.ok("link.remove", json!({"a": b, "b": a}))["removed"],
        true,
        "taken off from the end the other page was (note made it: {maker_is_a})"
    );
    assert_eq!(link_rows(&w), 0);
    assert!(linked(&note).is_empty() && linked(&place).is_empty());
    // Taking off what is not there is a no-op, so an Undo may run twice.
    assert_eq!(
        w.ok("link.remove", json!({"a": &note, "b": &place}))["removed"],
        false
    );
}

#[test]
fn a_locker_item_is_an_ordinary_end_listed_on_the_other_page_and_offered_by_the_picker() {
    let w = World::new("links_locker");
    let person = w.person("Ada");
    let item = w.made(Kind::LockerItem, "Bank login");
    w.ok("link.add", json!({"a": &item, "b": &person}));
    let read = |id: &str| w.vault().read(|c| links::linked(c, id)).expect("reads");
    assert_eq!(
        read(&person).len(),
        1,
        "the person's page names the Locker item"
    );
    assert_eq!(read(&person)[0].kind, Kind::LockerItem);
    assert_eq!(read(&item)[0].id, person);
    let offered = w
        .vault()
        .read(|c| links::candidates(c, "locker_item", "bank", 10))
        .expect("reads");
    assert_eq!(offered.len(), 1, "a Locker item is offered like any item");
    assert_eq!(offered[0].id, item);
}

#[test]
fn a_trashed_item_is_not_listed() {
    let w = World::new("links_trash");
    let task = w.made(Kind::Task, "Pack");
    let photo = w.made(Kind::Photo, "Beach");
    w.ok("link.add", json!({"a": &task, "b": &photo}));
    let read = |id: &str| w.vault().read(|c| links::linked(c, id)).expect("reads");
    assert_eq!(read(&task).len(), 1);
    w.ok("entity.trash", json!({"id": &photo}));
    assert!(read(&task).is_empty());
    w.ok("entity.restore", json!({"id": &photo}));
    assert_eq!(read(&task).len(), 1, "the link was never taken off");
}

#[test]
fn the_picker_lists_one_kind_by_typed_term_bounded_and_offers_nothing_that_is_no_end() {
    let w = World::new("links_picker");
    let alpha = w.made(Kind::Task, "Alpha");
    let ids: Vec<String> = (0..links::MAX_CANDIDATES + 10).map(|_| w.mint()).collect();
    w.commit(|tx| {
        for (n, id) in ids.iter().enumerate() {
            tx.insert_entity_in(id, Kind::Task, &format!("Chore {n:03}"), None, AT)?;
        }
        Ok(())
    });
    let pick = |kind: &str, term: &str, limit: usize| {
        w.vault()
            .read(|c| links::candidates(c, kind, term, limit))
            .expect("reads")
    };
    assert_eq!(pick("task", "", 1_000).len(), links::MAX_CANDIDATES);
    let typed = pick("task", "CHORE 05", 1_000);
    assert!(!typed.is_empty() && typed.iter().all(|c| c.title.contains("Chore 05")));
    assert_eq!(pick("task", "alpha", 1_000)[0].id, alpha);
    assert!(pick("task", "nothing like it", 10).is_empty());
    assert!(pick("tag", "", 10).is_empty(), "a label is no end");
    assert!(pick("reading", "", 10).is_empty(), "a reading is no end");
    assert!(pick("no_such_kind", "", 10).is_empty());
    // An item with no title to pick it by is not offered.
    w.bare(Kind::Photo, "", None);
    assert!(pick("photo", "", 10).is_empty());
    // The owner leads the people, whatever the order of names.
    w.person("Aaron");
    let people = pick("person", "", 10);
    assert!(people[0].is_owner, "{people:?}");
    assert_eq!(people.len(), 2);
}

#[test]
fn a_title_written_in_a_notes_text_reads_in_text_from_both_ends_and_a_picked_link_does_not() {
    let w = World::new("links_mention");
    let target = w.note("Packing list");
    let host = w.note("Host");
    let picked = w.note("Itinerary");
    w.ok("link.add", json!({"a": &host, "b": &picked}));
    // The note's own save writes its mentions; here the rows stand where it would put them.
    w.commit(|tx| {
        tx.connection().execute(
            "INSERT INTO mention (note_id, ordinal, wikilink, to_id) VALUES (?1, 0, 'Packing list', ?2)",
            [&host, &target],
        )?;
        Ok(())
    });
    let read = |id: &str| w.vault().read(|c| links::linked(c, id)).expect("reads");
    let in_text = |rows: &[links::Linked], other: &str| {
        rows.iter()
            .find(|row| row.id == other)
            .map(|row| row.in_text)
    };
    let on_host = read(&host);
    assert_eq!(
        in_text(&on_host, &target),
        Some(true),
        "the note's own page"
    );
    assert_eq!(in_text(&on_host, &picked), Some(false), "a picked link");
    assert_eq!(
        in_text(&read(&target), &host),
        Some(true),
        "the mentioned item's page"
    );
    // The same pair picked by hand as well is still one thing, written in the text.
    w.ok("link.add", json!({"a": &host, "b": &target}));
    assert_eq!(read(&host).iter().filter(|row| row.id == target).count(), 1);
    assert_eq!(in_text(&read(&host), &target), Some(true));
}

#[test]
fn a_purged_item_takes_its_links_with_it_and_its_mentions_wait_for_a_title_again() {
    let w = World::new("links_purge");
    let keep = w.person("Ada");
    let gone = w.made(Kind::Place, "Lisbon");
    let host = w.note("Trip");
    w.ok("link.add", json!({"a": &keep, "b": &gone}));
    w.commit(|tx| {
        tx.connection().execute(
            "INSERT INTO mention (note_id, ordinal, wikilink, to_id) VALUES (?1, 0, 'Lisbon', ?2)",
            [&host, &gone],
        )?;
        Ok(())
    });
    w.ok("entity.trash", json!({"id": &gone}));
    w.ok("entity.purge", json!({"id": &gone}));
    assert_eq!(link_rows(&w), 0, "the link went by ON DELETE CASCADE");
    assert_eq!(
        w.one::<Option<String>>("SELECT to_id FROM mention WHERE note_id = ?1", &[&host]),
        None,
        "the mention is unresolved again, as the note's text reads"
    );
    assert!(
        w.vault()
            .read(|c| links::linked(c, &keep))
            .expect("reads")
            .is_empty()
    );
}

#[test]
fn merging_one_item_into_another_moves_every_link_with_no_duplicate_either_way() {
    let w = World::new("links_repoint");
    let (from, into) = (w.person("Alex"), w.person("Alexander"));
    let (shared, only_from, only_into) = (
        w.note("Both"),
        w.made(Kind::Place, "Rome"),
        w.made(Kind::Task, "Call"),
    );
    w.ok("link.add", json!({"a": &from, "b": &shared}));
    w.ok("link.add", json!({"a": &shared, "b": &into}));
    w.ok("link.add", json!({"a": &only_from, "b": &from}));
    w.ok("link.add", json!({"a": &into, "b": &only_into}));
    w.ok("link.add", json!({"a": &from, "b": &into}));
    let moved = w
        .vault()
        .commit(|tx| links::repoint(tx.connection(), &from, &into))
        .expect("merged")
        .value;
    assert_eq!(
        moved.links, 1,
        "only the place is new to the survivor: the shared note was there, the pair itself is dropped"
    );
    assert_eq!(
        w.one::<i64>("SELECT COUNT(*) FROM link WHERE a = ?1 OR b = ?1", &[&from]),
        0
    );
    let read = |id: &str| -> Vec<String> {
        let mut ids: Vec<String> = w
            .vault()
            .read(|c| links::linked(c, id))
            .expect("reads")
            .into_iter()
            .map(|row| row.id)
            .collect();
        ids.sort();
        ids
    };
    let mut want = vec![shared, only_from, only_into];
    want.sort();
    assert_eq!(read(&into), want);
    assert_eq!(
        w.one::<i64>("SELECT COUNT(*) FROM link WHERE a >= b", &[]),
        0
    );
    // Two of different kinds, or the same one twice, are not a merge.
    assert!(
        w.vault()
            .commit(|tx| links::repoint(tx.connection(), &into, &into))
            .is_err()
    );
    let place = w.made(Kind::Place, "Elsewhere");
    assert!(
        w.vault()
            .commit(|tx| links::repoint(tx.connection(), &place, &into))
            .is_err()
    );
}
