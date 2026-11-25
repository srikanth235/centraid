//! A pass, the field-by-field three-way merge against what a source stated, "Phone says X", several
//! sources for one record, and who a pass is (#1214, K9).

mod common;

use centraid_vault::commands::follow::{Difference, Maps, differences_in, move_sources};
use common::follow::{CONTACTS, Follow, TestMaps, contacts_origin};
use serde_json::json;

fn differences(f: &Follow, id: &str) -> Vec<Difference> {
    f.vault()
        .read(|c| differences_in(TestMaps::MAPS, c, id))
        .expect("a read")
}

fn ada(given: &str, org: &str) -> serde_json::Value {
    json!({ "title": "Ada Lovelace", "given": given, "family": "Lovelace", "org": org })
}

fn column(f: &Follow, id: &str, column: &str) -> Option<String> {
    f.maybe::<String>(&format!("SELECT {column} FROM person WHERE id = ?1"), &[id])
}

#[test]
fn a_record_becomes_a_row_and_a_changed_one_merges_field_by_field_against_its_source() {
    let f = Follow::new("stated_merge");
    let icloud = contacts_origin("icloud", "phone-1");
    let out = f.pass(
        CONTACTS,
        icloud.clone(),
        &[("c1", ada("Ada", "Analytical"))],
        true,
    );
    assert_eq!(out["added"].as_i64(), Some(1), "{out}");
    let id = f.by_title("person", "Ada Lovelace");
    // The record is a row of a kind `source_shape` allows for the system, linked to its source.
    assert_eq!(
        f.one::<String>(
            "SELECT system || ':' || entity_kind FROM source WHERE entity_id = ?1",
            &[&id]
        ),
        "contacts:person"
    );
    assert_eq!(column(&f, &id, "org").as_deref(), Some("Analytical"));

    // The member edits one field; nothing refuses the edit.
    f.raw(&format!(
        "UPDATE person SET org = 'Babbage & Co' WHERE id = '{id}'"
    ));
    // The phone changes two: the field the member left alone follows, the one they set stands.
    let out = f.pass(
        CONTACTS,
        icloud.clone(),
        &[("c1", ada("Augusta", "Engines"))],
        true,
    );
    assert_eq!(out["updated"].as_i64(), Some(1), "{out}");
    assert_eq!(column(&f, &id, "given").as_deref(), Some("Augusta"));
    assert_eq!(column(&f, &id, "org").as_deref(), Some("Babbage & Co"));

    // "Phone says X": what the source last stated, readable while it differs, and only then.
    let says = differences(&f, &id);
    assert_eq!(says.len(), 1, "{says:?}");
    assert_eq!(
        (
            says[0].field.as_str(),
            says[0].stated.clone(),
            says[0].held.clone()
        ),
        ("org", json!("Engines"), json!("Babbage & Co"))
    );

    // Taking the phone's value is an ordinary edit, and the field follows again by itself.
    f.ok(
        "follow.take_stated",
        json!({ "entity": id, "field": "org" }),
    );
    assert_eq!(column(&f, &id, "org").as_deref(), Some("Engines"));
    assert!(differences(&f, &id).is_empty());
    f.pass(
        CONTACTS,
        icloud,
        &[("c1", ada("Augusta", "Difference Engines"))],
        true,
    );
    assert_eq!(
        column(&f, &id, "org").as_deref(),
        Some("Difference Engines")
    );
    assert_eq!(
        f.count("SELECT COUNT(*) FROM entity WHERE kind = 'person'", &[]),
        2,
        "the owner and Ada"
    );
}

#[test]
fn a_member_who_sets_the_title_keeps_it_and_a_pass_that_says_what_it_said_writes_nothing() {
    let f = Follow::new("stated_title");
    let origin = contacts_origin("icloud", "phone-1");
    f.pass(CONTACTS, origin.clone(), &[("c1", ada("Ada", "A"))], true);
    let id = f.by_title("person", "Ada Lovelace");
    f.ok(
        "entity.retitle",
        json!({ "id": id, "title": "Ada, Countess" }),
    );
    let seen: String = f.one("SELECT seen_at FROM source WHERE entity_id = ?1", &[&id]);
    let out = f.pass(CONTACTS, origin.clone(), &[("c1", ada("Ada", "A"))], true);
    assert_eq!(out["unchanged"].as_i64(), Some(1), "{out}");
    assert_eq!(
        f.one::<String>("SELECT seen_at FROM source WHERE entity_id = ?1", &[&id]),
        seen,
        "a record that says what it said writes no source row"
    );
    let says = differences(&f, &id);
    assert_eq!(says.len(), 1);
    assert_eq!(says[0].field, "title");
    assert_eq!(says[0].stated, json!("Ada Lovelace"));
    // A new title from the phone does not overwrite the member's.
    f.pass(
        CONTACTS,
        origin,
        &[(
            "c1",
            json!({ "title": "Ada Byron", "given": "Ada", "family": "Lovelace", "org": "A" }),
        )],
        true,
    );
    assert_eq!(
        f.one::<String>("SELECT title FROM entity WHERE id = ?1", &[&id]),
        "Ada, Countess"
    );
}

#[test]
fn a_take_with_nothing_to_take_is_refused_with_a_sentence_and_writes_nothing() {
    let f = Follow::new("stated_take");
    let origin = contacts_origin("icloud", "phone-1");
    f.pass(
        CONTACTS,
        origin,
        &[("c1", json!({ "title": "Ada", "given": "Ada" }))],
        true,
    );
    let id = f.by_title("person", "Ada");
    // The phone never said what the family name is.
    let sentence = f.refused(
        "follow.take_stated",
        json!({ "entity": id, "field": "family" }),
    );
    assert!(sentence.contains("never said"), "{sentence}");
    // A row nothing follows has nothing to take.
    let mine = f.by_title("person", "Test Owner");
    let sentence = f.refused(
        "follow.take_stated",
        json!({ "entity": mine, "field": "given" }),
    );
    assert!(sentence.contains("not following anything"), "{sentence}");
    // A field that is taken whole is not taken item by item.
    let sentence = f.refused(
        "follow.take_stated",
        json!({ "entity": id, "field": "given", "item_key": "x" }),
    );
    assert!(sentence.contains("as a whole"), "{sentence}");
}

// ---------------------------------------------------------------------------------------------
// Several sources for one record (A9)
// ---------------------------------------------------------------------------------------------

/// Ada as two accounts of the address book state her, then merged into one row: the row holds
/// every source it had.
fn merged(f: &Follow) -> (String, String) {
    f.pass(
        CONTACTS,
        contacts_origin("icloud", "phone-1"),
        &[("c1", ada("Ada", "Old"))],
        true,
    );
    f.pass(
        CONTACTS,
        contacts_origin("google", "phone-1"),
        &[(
            "g1",
            json!({ "title": "A. Lovelace", "given": "Ada", "org": "Old" }),
        )],
        true,
    );
    let (keeps, goes) = (
        f.by_title("person", "Ada Lovelace"),
        f.by_title("person", "A. Lovelace"),
    );
    let moved = f
        .vault()
        .commit(|tx| move_sources(tx.connection(), &goes, &keeps))
        .expect("a move")
        .value;
    assert_eq!(moved, 1);
    (keeps, goes)
}

#[test]
fn one_row_with_two_sources_merges_each_pass_against_that_sources_own_statement() {
    let f = Follow::new("stated_two");
    let (keeps, goes) = merged(&f);
    assert_eq!(
        f.count(
            "SELECT COUNT(*) FROM source WHERE entity_id = ?1",
            &[&keeps]
        ),
        2,
        "the row keeps every source it had"
    );
    assert_eq!(
        f.count("SELECT COUNT(*) FROM source WHERE entity_id = ?1", &[&goes]),
        0
    );

    // The first store changes the org: the row still holds what THAT source last stated ("Old"),
    // so the change lands.
    f.pass(
        CONTACTS,
        contacts_origin("icloud", "phone-1"),
        &[("c1", ada("Ada", "New"))],
        true,
    );
    assert_eq!(column(&f, &keeps, "org").as_deref(), Some("New"));
    // The second store changes it again: the row holds "New", which is NOT what the second source
    // last stated ("Old"), so for that source the value is the member's, and it stands.
    f.pass(
        CONTACTS,
        contacts_origin("google", "phone-1"),
        &[(
            "g1",
            json!({ "title": "A. Lovelace", "given": "Ada", "org": "Newer" }),
        )],
        true,
    );
    assert_eq!(column(&f, &keeps, "org").as_deref(), Some("New"));
    // Each source is told apart: only the second one has anything the vault does not hold.
    let says = differences(&f, &keeps);
    let origins: std::collections::BTreeSet<_> = says.iter().map(|d| d.origin.clone()).collect();
    assert_eq!(origins.len(), 1, "{says:?}");
    let google: String = f.one("SELECT id FROM origin WHERE ref = 'google'", &[]);
    assert!(
        says.iter()
            .any(|d| d.origin == google && d.field == "org" && d.stated == json!("Newer")),
        "{says:?}"
    );
    // Taking the field names whose word to take when more than one says it.
    let sentence = f.refused(
        "follow.take_stated",
        json!({ "entity": keeps, "field": "given" }),
    );
    assert!(
        sentence.contains("more than one") || sentence.contains("never said"),
        "{sentence}"
    );
    f.ok(
        "follow.take_stated",
        json!({ "entity": keeps, "field": "org", "origin": google }),
    );
    assert_eq!(column(&f, &keeps, "org").as_deref(), Some("Newer"));
}

#[test]
fn a_record_one_store_stops_stating_is_not_gone_while_another_still_does() {
    let f = Follow::new("stated_gone_shared");
    let (keeps, _) = merged(&f);
    // The first store's complete read no longer holds her: only its link goes.
    let out = f.pass(CONTACTS, contacts_origin("icloud", "phone-1"), &[], true);
    assert_eq!(out["forgotten"].as_i64(), Some(1), "{out}");
    assert_eq!(out["trashed"].as_i64(), Some(0), "{out}");
    assert!(!f.trashed(&keeps));
    assert_eq!(
        f.count(
            "SELECT COUNT(*) FROM source WHERE entity_id = ?1",
            &[&keeps]
        ),
        1
    );
    // When the last store stops stating her, the row stays: merged, it no longer says what that
    // store said (the title is the other one's), so it is the member's work and only the link
    // goes. A row that still said what its last source said would go to the trash.
    let out = f.pass(CONTACTS, contacts_origin("google", "phone-1"), &[], true);
    assert_eq!(out["forgotten"].as_i64(), Some(1), "{out}");
    assert_eq!(out["trashed"].as_i64(), Some(0), "{out}");
    assert!(!f.trashed(&keeps));
    assert_eq!(
        f.count(
            "SELECT COUNT(*) FROM source WHERE entity_id = ?1",
            &[&keeps]
        ),
        0
    );
}

#[test]
fn moving_sources_is_refused_across_kinds_and_into_the_owner() {
    let f = Follow::new("stated_move");
    f.pass(
        CONTACTS,
        contacts_origin("icloud", "phone-1"),
        &[("c1", ada("Ada", "A"))],
        true,
    );
    let ada_id = f.by_title("person", "Ada Lovelace");
    let owner = f.one::<String>("SELECT self_id FROM vault", &[]);
    let note = f.container(centraid_vault::model::Kind::Notebook, "N");
    let refusal = |from: &str, to: &str| {
        f.vault()
            .commit(|tx| move_sources(tx.connection(), from, to))
            .expect_err("refused")
            .to_string()
    };
    assert!(
        refusal(&ada_id, &note).contains("cannot take over"),
        "kinds differ"
    );
    assert!(
        refusal(&ada_id, &owner).contains("owner"),
        "the owner is nobody's record"
    );
    assert!(refusal(&ada_id, "no-such-id").contains("nothing with the id"));
    // The database says the same of the owner, whatever wrote the row.
    let error = f
        .raw_result(&format!(
            "UPDATE source SET entity_id = '{owner}' WHERE entity_id = '{ada_id}'"
        ))
        .expect_err("refused");
    assert!(error.contains("never names the vault's owner"), "{error}");
}

// ---------------------------------------------------------------------------------------------
// Who did it (B4)
// ---------------------------------------------------------------------------------------------

#[test]
fn every_revision_a_pass_writes_is_the_stores_and_nothing_is_read_off_a_command_name() {
    let f = Follow::new("stated_actor");
    let origin = contacts_origin("icloud", "phone-1");
    let out = f.pass(CONTACTS, origin.clone(), &[("c1", ada("Ada", "A"))], true);
    let origin_id = out["origin"].as_str().expect("an origin").to_owned();
    let id = f.by_title("person", "Ada Lovelace");
    // A change by the phone: the version it replaces is the store's act, naming the origin.
    f.pass(
        CONTACTS,
        origin.clone(),
        &[("c1", ada("Augusta", "B"))],
        true,
    );
    let rows = |f: &Follow| -> Vec<String> {
        f.vault()
            .read(|c| {
                Ok(c.prepare(
                    "SELECT actor || ':' || ifnull(origin_id, '-') FROM revision
                      WHERE entity_id = ?1 ORDER BY seq",
                )?
                .query_map([&id], |row| row.get(0))?
                .collect::<rusqlite::Result<_>>()?)
            })
            .expect("a read")
    };
    let after_pass = rows(&f);
    assert!(!after_pass.is_empty());
    assert!(
        after_pass
            .iter()
            .all(|row| *row == format!("store:{origin_id}")),
        "{after_pass:?}"
    );
    // The member's own edit, and the member taking the phone's word through a command whose name
    // starts with `follow.`: both are the member's, with no origin.
    f.raw(&format!(
        "UPDATE person SET family = 'Byron' WHERE id = '{id}'"
    ));
    f.pass(CONTACTS, origin, &[("c1", ada("Augusta", "C"))], true);
    f.ok(
        "follow.take_stated",
        json!({ "entity": id, "field": "family" }),
    );
    let all = rows(&f);
    assert!(all.len() > after_pass.len(), "{all:?}");
    assert_eq!(all[after_pass.len()], "member:-", "{all:?}");
    assert_eq!(all.last().map(String::as_str), Some("member:-"), "{all:?}");
    assert!(
        all.iter()
            .skip(after_pass.len())
            .any(|row| row.starts_with("store:")),
        "the later pass is the store's too: {all:?}"
    );
}
