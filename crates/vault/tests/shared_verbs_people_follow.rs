//! The phone's contacts, followed (#1214, A9, A10, L6): People's map in the follow engine. A pass
//! makes and updates people, a member's edit is kept field by field with "Phone says X", a record
//! gone from a complete read is the engine's, and the owner is nobody's record. (The merge that
//! keeps every source is `tests/people_merge.rs`; the engine's own rules are the `follow_*` files.)

mod common;

use centraid_vault::commands::follow::differences;
use common::world::World;
use serde_json::{Value as Json, json};

fn pass(w: &World, complete: bool, records: &[(&str, Json)]) -> Json {
    w.ok(
        "follow.contacts",
        json!({
            "origin": { "ref": "icloud", "label": "iCloud", "device_id": "phone-1" },
            "records": records.iter().map(|(id, fields)| json!({
                "external_id": id, "device_id": "phone-1", "fields": fields,
            })).collect::<Vec<_>>(),
            "complete": complete,
        }),
    )
}

fn followed(w: &World, external_id: &str) -> Option<String> {
    w.vault()
        .read(|c| {
            Ok(c.query_row(
                "SELECT entity_id FROM source WHERE external_id = ?1",
                [external_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .ok()
            .flatten())
        })
        .expect("reads")
}

fn field(w: &World, id: &str, column: &str) -> Option<String> {
    w.one::<Option<String>>(&format!("SELECT {column} FROM person WHERE id = ?1"), &[id])
}

fn raw(w: &World, sql: &str) {
    w.commit(|tx| {
        tx.connection().execute_batch(sql)?;
        Ok(())
    });
}

fn trashed(w: &World, id: &str) -> bool {
    w.one::<bool>(
        "SELECT deleted_at IS NOT NULL FROM entity WHERE id = ?1",
        &[id],
    )
}

#[test]
fn a_pass_makes_people_and_updates_only_what_the_member_left_alone() {
    let w = World::new("contacts_pass");
    let out = pass(
        &w,
        true,
        &[(
            "c1",
            json!({ "title": "Ada Lovelace", "given": "Ada", "family": "Lovelace", "org": "Engines",
                         "role": "Engineer", "nickname": "Ada" }),
        )],
    );
    assert_eq!(
        (out["added"].as_u64(), out["matched"].as_u64()),
        (Some(1), Some(0))
    );
    let id = followed(&w, "c1").expect("linked");
    assert_eq!(
        w.one::<String>(
            "SELECT p.given || '|' || p.family || '|' || p.org || '|' || p.role FROM person p WHERE id = ?1",
            &[&id]
        ),
        "Ada|Lovelace|Engines|Engineer"
    );
    assert_eq!(
        w.one::<i64>("SELECT COUNT(*) FROM origin WHERE system = 'contacts'", &[]),
        1
    );
    // The revision a pass writes is the store's, naming the origin.
    assert_eq!(
        w.one::<i64>("SELECT COUNT(*) FROM revision WHERE entity_id = ?1 AND actor = 'store' AND origin_id IS NOT NULL", &[&id])
            + w.one::<i64>("SELECT COUNT(*) FROM source WHERE entity_id = ?1", &[&id]),
        1 + w.one::<i64>("SELECT COUNT(*) FROM revision WHERE entity_id = ?1 AND actor = 'store' AND origin_id IS NOT NULL", &[&id])
    );

    // The member changes the nickname; the phone changes the role and the nickname.
    raw(
        &w,
        &format!("UPDATE person SET nickname = 'Countess' WHERE id = '{id}'"),
    );
    let out = pass(
        &w,
        true,
        &[(
            "c1",
            json!({ "title": "Ada Lovelace", "given": "Ada", "family": "Lovelace", "org": "Engines",
                         "role": "Mathematician", "nickname": "Ada L." }),
        )],
    );
    assert_eq!(out["updated"], 1);
    assert_eq!(
        field(&w, &id, "role").as_deref(),
        Some("Mathematician"),
        "untouched: follows"
    );
    assert_eq!(
        field(&w, &id, "nickname").as_deref(),
        Some("Countess"),
        "the member's value stands"
    );
    // "Phone says X": the field still names what the phone said.
    let says = w.vault().read(|c| differences(c, &id)).expect("a read");
    assert_eq!(says.len(), 1, "{says:?}");
    assert_eq!(
        (
            says[0].field.as_str(),
            says[0].stated.clone(),
            says[0].held.clone()
        ),
        ("nickname", json!("Ada L."), json!("Countess"))
    );
    // Take what the phone said, field by field.
    w.ok(
        "follow.take_stated",
        json!({ "entity": id, "field": "nickname" }),
    );
    assert_eq!(field(&w, &id, "nickname").as_deref(), Some("Ada L."));
    assert!(w.vault().read(|c| differences(c, &id)).unwrap().is_empty());
    // An identical statement is no change at all.
    let stamped = w.stamp(&id);
    let out = pass(
        &w,
        true,
        &[(
            "c1",
            json!({ "title": "Ada Lovelace", "given": "Ada", "family": "Lovelace", "org": "Engines",
                         "role": "Mathematician", "nickname": "Ada L." }),
        )],
    );
    assert_eq!(out["unchanged"], 1);
    assert_eq!(w.stamp(&id), stamped);
}

#[test]
fn a_followed_person_is_edited_field_by_field_points_and_dates_item_by_item() {
    let w = World::new("contacts_items");
    let said = |phone: &str, email: Option<&str>, birthday: &str| {
        let mut points = vec![json!({ "kind": "phone", "value": phone })];
        if let Some(email) = email {
            points.push(json!({ "kind": "email", "value": email }));
        }
        json!({ "title": "Ada", "points": points,
                "dates": [{ "kind": "birthday", "date": birthday },
                          { "kind": "anniversary", "date": "2010-06-01", "label": "wedding" }] })
    };
    pass(
        &w,
        true,
        &[(
            "c1",
            said("+1 555 010 0100", Some("ada@example.com"), "1815-12-10"),
        )],
    );
    let id = followed(&w, "c1").expect("linked");
    assert_eq!(
        w.one::<i64>(
            "SELECT COUNT(*) FROM contact_point WHERE person_id = ?1",
            &[&id]
        ),
        2
    );
    assert_eq!(
        w.one::<i64>(
            "SELECT COUNT(*) FROM person_date WHERE person_id = ?1",
            &[&id]
        ),
        2
    );
    // The member removes the email, adds a number and changes the wedding's day.
    let email = w.one::<String>(
        "SELECT id FROM contact_point WHERE person_id = ?1 AND kind = 'email'",
        &[&id],
    );
    w.ok("person.remove_contact_point", json!({ "point_id": email }));
    w.ok(
        "person.save_contact_point",
        json!({ "id": id, "kind": "phone", "value": "+44 20 7946 0000" }),
    );
    let wedding = w.one::<String>(
        "SELECT id FROM person_date WHERE person_id = ?1 AND kind = 'anniversary'",
        &[&id],
    );
    w.ok(
        "person.edit_date",
        json!({ "date_id": wedding, "date": "2010-06-02" }),
    );
    // The phone changes the birthday's year and the number; it still states the email.
    pass(
        &w,
        true,
        &[(
            "c1",
            said("+1 555 010 0199", Some("ada@example.com"), "1815-12-11"),
        )],
    );
    let held_points = w.strings(
        "SELECT value FROM contact_point WHERE person_id = ?1 ORDER BY value",
        &[&id],
    );
    assert_eq!(
        held_points,
        ["+1 555 010 0199", "+44 20 7946 0000"],
        "the number the member did not touch follows the phone; theirs stays; the email they removed stays removed"
    );
    assert_eq!(
        w.strings(
            "SELECT kind || ':' || date FROM person_date WHERE person_id = ?1 ORDER BY kind",
            &[&id]
        ),
        ["anniversary:2010-06-02", "birthday:1815-12-11"],
        "the birthday follows; the wedding the member moved stands"
    );
    // The phone's word on what differs is readable, item by item.
    let says = w.vault().read(|c| differences(c, &id)).expect("a read");
    let fields: Vec<&str> = says.iter().map(|d| d.field.as_str()).collect();
    assert_eq!(fields, ["points", "dates"], "{says:?}");
    // Taking one date item puts the phone's day back; the rest of the member's work stays.
    let key = says[1]
        .items
        .iter()
        .find(|i| i.key.contains("anniversary"))
        .expect("the wedding")
        .key
        .clone();
    w.ok(
        "follow.take_stated",
        json!({ "entity": id, "field": "dates", "item_key": key }),
    );
    assert_eq!(
        w.strings(
            "SELECT kind || ':' || date FROM person_date WHERE person_id = ?1 ORDER BY kind",
            &[&id]
        ),
        ["anniversary:2010-06-01", "birthday:1815-12-11"]
    );
    assert_eq!(w.one::<i64>("SELECT COUNT(*) FROM contact_point WHERE person_id = ?1 AND value = '+44 20 7946 0000'", &[&id]), 1);
}

#[test]
fn a_record_with_no_name_is_counted_and_left_out_and_the_owner_is_nobodys_record() {
    let w = World::new("contacts_guards");
    let owner = common::self_person(w.vault()).expect("owner");
    let before = w.one::<i64>("SELECT COUNT(*) FROM person", &[]);
    let out = pass(
        &w,
        true,
        &[
            ("nameless", json!({ "title": "  ", "org": "Nowhere" })),
            // A record named like the owner is a new person, not the owner.
            (
                "me",
                json!({ "title": "Test Owner", "nickname": "Imposter" }),
            ),
        ],
    );
    assert_eq!(out["refused"], 1, "{out}");
    assert_eq!(w.one::<i64>("SELECT COUNT(*) FROM person", &[]), before + 1);
    assert_eq!(followed(&w, "nameless"), None);
    assert_ne!(followed(&w, "me").as_deref(), Some(owner.as_str()));
    assert_eq!(
        field(&w, &owner, "nickname"),
        None,
        "the owner's row was not written"
    );
    assert_eq!(
        w.one::<i64>(
            "SELECT COUNT(*) FROM source WHERE entity_id = ?1",
            &[&owner]
        ),
        0
    );
    // The database says the same.
    let refused = w.vault().commit(|tx| {
        tx.connection().execute(
            "UPDATE source SET entity_id = ?1, entity_kind = 'person' WHERE external_id = 'me'",
            [&owner],
        )?;
        Ok(())
    });
    assert!(refused.expect_err("refused").to_string().contains("owner"));
    // A phone that no longer states a person never takes the owner to the trash.
    pass(&w, true, &[]);
    assert!(!trashed(&w, &owner));
}

#[test]
fn a_record_is_matched_to_a_person_the_member_already_has_before_one_is_added() {
    let w = World::new("contacts_match");
    let mine = id_of_add(&w, "Grace Hopper");
    w.ok("person.edit", json!({ "id": mine, "role": "Admiral" }));
    let out = pass(
        &w,
        true,
        &[(
            "c9",
            json!({ "title": "grace hopper", "role": "Rear Admiral", "nickname": "Amazing Grace" }),
        )],
    );
    assert_eq!(
        (out["added"].as_u64(), out["matched"].as_u64()),
        (Some(0), Some(1))
    );
    assert_eq!(followed(&w, "c9").as_deref(), Some(mine.as_str()));
    assert_eq!(
        field(&w, &mine, "role").as_deref(),
        Some("Admiral"),
        "the member's own value stands over a match"
    );
    assert_eq!(
        field(&w, &mine, "nickname").as_deref(),
        Some("Amazing Grace"),
        "a blank takes the phone's word"
    );
    assert_eq!(
        w.one::<i64>("SELECT COUNT(*) FROM person", &[]),
        2,
        "the owner and hers"
    );
    // A person another source already follows is not a candidate.
    let out = w.ok(
        "follow.contacts",
        json!({ "origin": { "ref": "google", "label": "Google", "device_id": "phone-1" },
                "records": [{ "external_id": "g1", "device_id": "phone-1", "fields": { "title": "Grace Hopper" } }] }),
    );
    assert_eq!(out["added"], 1);
}

fn id_of_add(w: &World, title: &str) -> String {
    w.ok("person.add", json!({ "title": title }))["id"]
        .as_str()
        .expect("an id")
        .to_owned()
}

#[test]
fn a_record_gone_from_a_complete_read_trashes_an_untouched_person_and_forgets_an_edited_one() {
    let w = World::new("contacts_gone");
    pass(
        &w,
        true,
        &[
            ("keep", json!({ "title": "Kept", "role": "A" })),
            ("quiet", json!({ "title": "Quiet", "role": "B" })),
            ("edited", json!({ "title": "Edited", "role": "C" })),
        ],
    );
    let (quiet, edited) = (
        followed(&w, "quiet").expect("linked"),
        followed(&w, "edited").expect("linked"),
    );
    w.ok("person.edit", json!({ "id": edited, "role": "mine" }));
    let out = pass(
        &w,
        false,
        &[("keep", json!({ "title": "Kept", "role": "A" }))],
    );
    assert_eq!(
        (out["trashed"].as_u64(), out["forgotten"].as_u64()),
        (Some(0), Some(0)),
        "an incomplete read removes nothing"
    );
    let out = pass(
        &w,
        true,
        &[("keep", json!({ "title": "Kept", "role": "A" }))],
    );
    assert_eq!(
        (out["trashed"].as_u64(), out["forgotten"].as_u64()),
        (Some(1), Some(1))
    );
    assert!(trashed(&w, &quiet) && !trashed(&w, &edited));
    assert_eq!(
        followed(&w, "edited"),
        None,
        "an edited person forgets its source and keeps the row"
    );
    assert_eq!(field(&w, &edited, "role").as_deref(), Some("mine"));
    // The record that comes back brings the untouched one back from the trash.
    let out = pass(
        &w,
        true,
        &[
            ("keep", json!({ "title": "Kept", "role": "A" })),
            ("quiet", json!({ "title": "Quiet", "role": "B" })),
        ],
    );
    assert_eq!(out["restored"], 1, "{out}");
    assert!(!trashed(&w, &quiet));
}

#[test]
fn a_purged_persons_source_is_a_tombstone_and_a_person_the_member_trashed_stays_trashed() {
    let w = World::new("contacts_tombstone");
    pass(
        &w,
        true,
        &[
            ("c1", json!({ "title": "Ada", "role": "A" })),
            ("c2", json!({ "title": "Bea", "role": "A" })),
        ],
    );
    let (ada, bea) = (
        followed(&w, "c1").expect("linked"),
        followed(&w, "c2").expect("linked"),
    );
    w.ok("entity.trash", json!({ "id": ada }));
    w.ok("entity.purge", json!({ "id": ada }));
    assert_eq!(
        w.one::<i64>(
            "SELECT COUNT(*) FROM source WHERE external_id = 'c1' AND entity_id IS NULL",
            &[]
        ),
        1
    );
    let out = pass(
        &w,
        true,
        &[
            ("c1", json!({ "title": "Ada", "role": "A" })),
            ("c2", json!({ "title": "Bea", "role": "A" })),
        ],
    );
    assert_eq!(
        (out["added"].as_u64(), out["matched"].as_u64()),
        (Some(0), Some(0)),
        "never added again"
    );
    // The member's own trash stands against a later change; a restore compares as untouched.
    w.ok("entity.trash", json!({ "id": bea }));
    pass(&w, true, &[("c2", json!({ "title": "Bea", "role": "B" }))]);
    assert!(trashed(&w, &bea));
    assert_eq!(
        field(&w, &bea, "role").as_deref(),
        Some("A"),
        "nothing is written under a trashed person"
    );
    w.ok("entity.restore", json!({ "id": bea }));
    pass(&w, true, &[("c2", json!({ "title": "Bea", "role": "B" }))]);
    assert_eq!(field(&w, &bea, "role").as_deref(), Some("B"));
}
