//! `person.merge` (A8): two people who are one. A person is put with the one who stays, in every
//! place the vault holds them, and then purged. Each test below is one sentence of the rule, and
//! the last two are the two bugs the rewrite fixed: a merge that stopped Contacts syncing, and a
//! merge that broke links.

mod common;

use centraid_vault::commands::touch;
use centraid_vault::model::Kind;
use common::world::{AT, World};
use serde_json::{Value as Json, json};

fn id_of(output: &Json, key: &str) -> String {
    output[key].as_str().expect("an id").to_owned()
}

fn add(w: &World, title: &str) -> String {
    id_of(&w.ok("person.add", json!({ "title": title })), "id")
}

fn merge(w: &World, from: &str, into: &str) -> Json {
    w.ok("person.merge", json!({ "from": from, "into": into }))
}

fn gone(w: &World, id: &str) -> bool {
    w.one::<i64>("SELECT COUNT(*) FROM entity WHERE id = ?1", &[id]) == 0
}

/// One pass of the phone's contacts: `records` are `(external id, fields)`.
fn pass(w: &World, origin: &str, device: &str, records: &[(&str, Json)]) -> Json {
    w.ok(
        "follow.contacts",
        json!({
            "origin": { "ref": origin, "label": origin, "device_id": device },
            "records": records.iter().map(|(id, fields)| json!({
                "external_id": id, "device_id": device, "fields": fields,
            })).collect::<Vec<_>>(),
            "complete": true,
        }),
    )
}

fn sources_of(w: &World, person: &str) -> i64 {
    w.one::<i64>(
        "SELECT COUNT(*) FROM source WHERE entity_id = ?1",
        &[person],
    )
}

// ---------------------------------------------------------------------------------------------
// The one that goes is gone, and what is refused
// ---------------------------------------------------------------------------------------------

#[test]
fn the_person_who_goes_is_purged_with_their_history_and_the_survivor_is_stamped() {
    let w = World::new("merge_purge");
    let (ada, bea) = (add(&w, "Ada"), add(&w, "Bea"));
    w.ok("person.edit", json!({ "id": bea, "nickname": "B" }));
    assert!(
        w.one::<i64>(
            "SELECT COUNT(*) FROM revision WHERE entity_id = ?1",
            &[&bea]
        ) > 0
    );
    let stamp = w.stamp(&ada);
    let out = merge(&w, &bea, &ada);
    assert_eq!(out["into"], json!(ada));
    assert!(gone(&w, &bea));
    assert_eq!(
        w.one::<i64>("SELECT COUNT(*) FROM person WHERE id = ?1", &[&bea]),
        0
    );
    assert_eq!(
        w.one::<i64>(
            "SELECT COUNT(*) FROM revision WHERE entity_id = ?1",
            &[&bea]
        ),
        0,
        "the history of a person who no longer exists goes with them"
    );
    assert_ne!(w.stamp(&ada), stamp, "the survivor was changed");
    // The survivor's own words stand and blanks are filled from the one who went.
    assert_eq!(
        w.one::<String>("SELECT nickname FROM person WHERE id = ?1", &[&ada]),
        "B"
    );
}

#[test]
fn a_merge_is_refused_for_the_owner_a_stranger_a_trashed_person_and_two_who_are_one() {
    let w = World::new("merge_refusals");
    let (ada, bea) = (add(&w, "Ada"), add(&w, "Bea"));
    let owner = common::self_person(w.vault()).expect("owner");
    assert!(
        w.refused("person.merge", json!({ "from": ada, "into": ada }))
            .contains("themselves")
    );
    assert!(
        w.refused("person.merge", json!({ "from": owner, "into": ada }))
            .contains("this is you")
    );
    let note = w.note("n");
    assert!(
        w.refused("person.merge", json!({ "from": note, "into": ada }))
            .contains("only people")
    );
    assert!(
        w.refused("person.merge", json!({ "from": ada, "into": "nobody" }))
            .contains("nothing with")
    );
    w.ok("entity.trash", json!({ "id": bea }));
    assert!(
        w.refused("person.merge", json!({ "from": bea, "into": ada }))
            .contains("trash")
    );
    w.ok("entity.restore", json!({ "id": bea }));
    // Someone is merged INTO the owner: their words fill the owner's blanks; the owner stays.
    w.ok("person.edit", json!({ "id": bea, "nickname": "B" }));
    merge(&w, &bea, &owner);
    assert!(gone(&w, &bea));
    assert_eq!(
        w.one::<String>("SELECT nickname FROM person WHERE id = ?1", &[&owner]),
        "B"
    );
    assert!(!gone(&w, &owner));
}

#[test]
fn a_person_a_phone_follows_is_not_merged_into_the_owner_who_is_nobodys_record() {
    let w = World::new("merge_owner_followed");
    pass(
        &w,
        "icloud",
        "phone-1",
        &[("c1", json!({ "title": "Dee" }))],
    );
    let dee = w.one::<String>("SELECT id FROM entity WHERE title = 'Dee'", &[]);
    let owner = common::self_person(w.vault()).expect("owner");
    assert!(
        w.refused("person.merge", json!({ "from": dee, "into": owner }))
            .contains("stop following")
    );
    assert!(!gone(&w, &dee));
    assert_eq!(sources_of(&w, &dee), 1);
}

// ---------------------------------------------------------------------------------------------
// Every followed source is kept (A8, A9): the first bug
// ---------------------------------------------------------------------------------------------

#[test]
fn a_merged_person_keeps_both_sources_and_both_keep_syncing() {
    let w = World::new("merge_sources");
    // Two phones (or two accounts) each state their own record of the same human.
    pass(
        &w,
        "icloud",
        "phone-1",
        &[("c1", json!({ "title": "Ada", "given": "Ada" }))],
    );
    pass(
        &w,
        "google",
        "phone-1",
        &[("g1", json!({ "title": "Ada L.", "family": "Lovelace" }))],
    );
    let (ada, ada_l) = (
        w.one::<String>("SELECT id FROM entity WHERE title = 'Ada'", &[]),
        w.one::<String>("SELECT id FROM entity WHERE title = 'Ada L.'", &[]),
    );
    let before = w.one::<i64>("SELECT COUNT(*) FROM source", &[]);
    merge(&w, &ada_l, &ada);
    assert!(gone(&w, &ada_l));
    // No source was lost or made a tombstone: the survivor holds both, one per store.
    assert_eq!(w.one::<i64>("SELECT COUNT(*) FROM source", &[]), before);
    assert_eq!(sources_of(&w, &ada), 2);
    assert_eq!(
        w.one::<i64>(
            "SELECT COUNT(DISTINCT origin_id) FROM source WHERE entity_id = ?1",
            &[&ada]
        ),
        2
    );
    assert_eq!(
        w.one::<i64>("SELECT COUNT(*) FROM source WHERE entity_id IS NULL", &[]),
        0,
        "none became a tombstone"
    );
    // The survivor took the family name the other one said.
    assert_eq!(
        w.one::<String>("SELECT family FROM person WHERE id = ?1", &[&ada]),
        "Lovelace"
    );

    // Each store goes on syncing against ITS OWN statement: what iCloud says of `given` lands
    // (the survivor still holds what iCloud last said), and what Google says of `family` lands.
    let summary = pass(
        &w,
        "icloud",
        "phone-1",
        &[("c1", json!({ "title": "Ada", "given": "Augusta" }))],
    );
    assert_eq!(summary["added"], json!(0), "{summary}");
    assert_eq!(
        w.one::<String>("SELECT given FROM person WHERE id = ?1", &[&ada]),
        "Augusta"
    );
    let summary = pass(
        &w,
        "google",
        "phone-1",
        &[("g1", json!({ "title": "Ada L.", "family": "King" }))],
    );
    assert_eq!(summary["added"], json!(0), "{summary}");
    assert_eq!(
        w.one::<String>("SELECT family FROM person WHERE id = ?1", &[&ada]),
        "King"
    );
    // And the vault did not make "Ada L." again.
    assert_eq!(
        w.one::<i64>(
            "SELECT COUNT(*) FROM entity WHERE kind = 'person' AND title = 'Ada L.'",
            &[]
        ),
        0
    );
    assert_eq!(
        w.one::<i64>(
            "SELECT COUNT(*) FROM entity WHERE kind = 'person' AND deleted_at IS NULL",
            &[]
        ),
        2
    );
    // Each pass's revision says who made it: the store, with its origin.
    assert_eq!(
        w.one::<i64>(
            "SELECT COUNT(DISTINCT origin_id) FROM revision WHERE entity_id = ?1 AND actor = 'store'",
            &[&ada]
        ),
        2
    );
}

#[test]
fn a_followed_person_merged_into_a_typed_one_keeps_syncing_and_a_typed_one_into_a_followed_one_too()
{
    let w = World::new("merge_sources_typed");
    let typed = add(&w, "Typed");
    pass(
        &w,
        "icloud",
        "phone-1",
        &[("c1", json!({ "title": "Phone", "nickname": "P" }))],
    );
    let phone = w.one::<String>("SELECT id FROM entity WHERE title = 'Phone'", &[]);
    merge(&w, &phone, &typed);
    assert_eq!(sources_of(&w, &typed), 1);
    assert_eq!(
        w.one::<String>("SELECT nickname FROM person WHERE id = ?1", &[&typed]),
        "P"
    );
    pass(
        &w,
        "icloud",
        "phone-1",
        &[("c1", json!({ "title": "Phone", "nickname": "Q" }))],
    );
    assert_eq!(
        w.one::<String>("SELECT nickname FROM person WHERE id = ?1", &[&typed]),
        "Q"
    );
    // The typed one into the followed one: nothing to move.
    let other = add(&w, "Other");
    merge(&w, &other, &typed);
    assert_eq!(sources_of(&w, &typed), 1);
}

// ---------------------------------------------------------------------------------------------
// Links, edges and mentions with no duplicate in either direction: the second bug
// ---------------------------------------------------------------------------------------------

#[test]
fn every_link_edge_and_mention_goes_to_the_survivor_with_no_duplicate_either_way() {
    let w = World::new("merge_links");
    let (ada, bea, cy) = (add(&w, "Ada"), add(&w, "Bea"), add(&w, "Cy"));
    let notebook = w.container("notebook", "Book");
    let item = w.bare(Kind::LockerItem, "Passport", None);
    let note_of = |title: &str, body: &str| {
        id_of(
            &w.ok(
                "note.create",
                json!({ "title": title, "body": body, "notebook_id": notebook }),
            ),
            "id",
        )
    };
    let mention = note_of("Mentions Bea", "met [[Bea]] today");
    // Links: both have one to Cy and one to the passport; and they are linked to each other.
    for (x, y) in [(&ada, &cy), (&bea, &cy), (&bea, &item), (&ada, &bea)] {
        w.ok("link.add", json!({ "a": x, "b": y }));
    }
    // Edges: a note about both; a note about Bea only; a relation each way with the same label;
    // a list that holds Bea; and a relation that joins Ada and Bea (it would become a self edge).
    let both = note_of("About both", "");
    let only_bea = note_of("About Bea", "");
    for (note, person) in [(&both, &ada), (&both, &bea), (&only_bea, &bea)] {
        w.ok(
            "edge.add",
            json!({ "from": note, "rel": "about", "to": person }),
        );
    }
    w.ok(
        "edge.add",
        json!({ "from": bea, "rel": "related", "to": cy, "label": "friend" }),
    );
    w.ok(
        "edge.add",
        json!({ "from": cy, "rel": "related", "to": bea, "label": "friend" }),
    );
    w.ok(
        "edge.add",
        json!({ "from": ada, "rel": "related", "to": cy, "label": "friend" }),
    );
    w.ok(
        "edge.add",
        json!({ "from": ada, "rel": "related", "to": bea, "label": "twin" }),
    );
    let list = w.container("list", "Close");
    w.ok(
        "edge.add",
        json!({ "from": list, "rel": "contains", "to": bea }),
    );
    assert_eq!(
        w.one::<String>("SELECT to_id FROM mention WHERE note_id = ?1", &[&mention]),
        bea
    );

    let out = merge(&w, &bea, &ada);
    assert!(gone(&w, &bea));
    // Links: Ada—Cy once (not twice), Ada—passport moved, Ada—Bea dropped (not a link to herself).
    let pairs = w.strings("SELECT a || '|' || b FROM link ORDER BY a, b", &[]);
    let pair = |x: &String, y: &String| {
        let (a, b) = if x < y { (x, y) } else { (y, x) };
        format!("{a}|{b}")
    };
    let mut expected = vec![pair(&ada, &cy), pair(&ada, &item)];
    expected.sort();
    assert_eq!(pairs, expected);
    assert_eq!(
        out["links"],
        json!(1),
        "one link is new to the survivor: the passport"
    );
    // Edges: the note about both is about Ada once; the note about Bea is about Ada; each
    // direction of the relation is one row; the self relation is dropped.
    let count = |sql: &str, params: &[&str]| w.one::<i64>(sql, params);
    assert_eq!(
        count(
            "SELECT COUNT(*) FROM edge WHERE from_id = ?1 AND rel = 'about' AND to_id = ?2",
            &[&both, &ada]
        ),
        1
    );
    assert_eq!(
        count(
            "SELECT COUNT(*) FROM edge WHERE from_id = ?1 AND rel = 'about' AND to_id = ?2",
            &[&only_bea, &ada]
        ),
        1
    );
    assert_eq!(
        count(
            "SELECT COUNT(*) FROM edge WHERE rel = 'about' AND to_id = ?1",
            &[&ada]
        ),
        2
    );
    assert_eq!(
        count(
            "SELECT COUNT(*) FROM edge WHERE from_id = ?1 AND rel = 'related' AND to_id = ?2",
            &[&ada, &cy]
        ),
        1
    );
    assert_eq!(
        count(
            "SELECT COUNT(*) FROM edge WHERE from_id = ?1 AND rel = 'related' AND to_id = ?2",
            &[&cy, &ada]
        ),
        1
    );
    assert_eq!(
        count("SELECT COUNT(*) FROM edge WHERE from_id = to_id", &[]),
        0
    );
    assert_eq!(
        count(
            "SELECT COUNT(*) FROM edge WHERE rel = 'related' AND (from_id = ?1 AND to_id = ?1)",
            &[&ada]
        ),
        0
    );
    assert_eq!(
        count(
            "SELECT COUNT(*) FROM edge WHERE from_id = ?1 AND rel = 'contains' AND to_id = ?2",
            &[&list, &ada]
        ),
        1
    );
    assert_eq!(
        count(
            "SELECT COUNT(*) FROM edge WHERE from_id = ?1 OR to_id = ?1 OR label_id = ?1",
            &[&bea]
        ),
        0,
        "nothing names the one who went"
    );
    // Mentions of her words now resolve to the survivor.
    assert_eq!(
        w.one::<String>("SELECT to_id FROM mention WHERE note_id = ?1", &[&mention]),
        ada
    );
    // In your vault: the survivor's links, a Locker item among them.
    let linked = w
        .vault()
        .read(|c| centraid_vault::commands::person::in_your_vault(c, &ada))
        .expect("links");
    assert!(linked.iter().any(|row| row.kind == Kind::LockerItem));
}

// ---------------------------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------------------------

fn dates(w: &World, person: &str) -> Vec<String> {
    w.strings(
        "SELECT kind || ':' || date || ':' || ifnull(label, '') FROM person_date WHERE person_id = ?1 ORDER BY kind, date, label",
        &[person],
    )
}

#[test]
fn two_birthdays_keep_the_survivors_and_the_other_becomes_another_date_and_equal_ones_are_one() {
    let w = World::new("merge_dates");
    let (ada, bea) = (add(&w, "Ada"), add(&w, "Bea"));
    w.ok(
        "person.add_date",
        json!({ "id": ada, "kind": "birthday", "date": "1990-03-14" }),
    );
    w.ok(
        "person.add_date",
        json!({ "id": bea, "kind": "birthday", "date": "1991-04-01" }),
    );
    w.ok(
        "person.add_date",
        json!({ "id": ada, "kind": "anniversary", "date": "2010-06-01", "label": "wedding" }),
    );
    w.ok(
        "person.add_date",
        json!({ "id": bea, "kind": "anniversary", "date": "2010-06-01", "label": "Wedding" }),
    );
    w.ok(
        "person.add_date",
        json!({ "id": bea, "kind": "anniversary", "date": "--09-09" }),
    );
    let out = merge(&w, &bea, &ada);
    assert_eq!(
        dates(&w, &ada),
        [
            "anniversary:--09-09:",
            "anniversary:2010-06-01:wedding",
            "birthday:1990-03-14:",
            "other:1991-04-01:birthday",
        ]
    );
    // It says what it chose.
    assert_eq!(
        out["dates"],
        json!({ "kept": 2, "same": 1,
                "moved": [{ "kind": "birthday", "kept": "1990-03-14", "became_other": "1991-04-01" }] })
    );
    // The same birthday is one.
    let (cy, di) = (add(&w, "Cy"), add(&w, "Di"));
    for who in [&cy, &di] {
        w.ok(
            "person.add_date",
            json!({ "id": who, "kind": "birthday", "date": "--02-29" }),
        );
    }
    let out = merge(&w, &di, &cy);
    assert_eq!(dates(&w, &cy), ["birthday:--02-29:"]);
    assert_eq!(out["dates"]["moved"], json!([]));
    // A birthday only the one who went had is the survivor's now.
    let (ed, flo) = (add(&w, "Ed"), add(&w, "Flo"));
    w.ok(
        "person.add_date",
        json!({ "id": flo, "kind": "birthday", "date": "1980-01-01" }),
    );
    merge(&w, &flo, &ed);
    assert_eq!(dates(&w, &ed), ["birthday:1980-01-01:"]);
}

#[test]
fn a_reminder_on_a_date_goes_with_it_and_the_same_lead_on_equal_dates_is_one() {
    let w = World::new("merge_date_reminders");
    let (ada, bea) = (add(&w, "Ada"), add(&w, "Bea"));
    w.ok("person.add_date", json!({ "id": ada, "kind": "anniversary", "date": "06-01", "label": "wedding", "reminders": [1440] }));
    w.ok("person.add_date", json!({ "id": bea, "kind": "anniversary", "date": "06-01", "label": "wedding", "reminders": [1440, 60] }));
    w.ok(
        "person.add_date",
        json!({ "id": bea, "kind": "other", "date": "07-07", "reminders": [10] }),
    );
    merge(&w, &bea, &ada);
    let held = w.strings(
        "SELECT d.date || ':' || r.offset_min FROM reminder r JOIN person_date d ON d.id = r.date_id
          WHERE r.entity_id = ?1 ORDER BY d.date, r.offset_min",
        &[&ada],
    );
    assert_eq!(held, ["--06-01:60", "--06-01:1440", "--07-07:10"]);
    assert_eq!(
        w.one::<i64>(
            "SELECT COUNT(*) FROM reminder WHERE entity_id <> ?1",
            &[&ada]
        ),
        0
    );
}

// ---------------------------------------------------------------------------------------------
// Contact points
// ---------------------------------------------------------------------------------------------

#[test]
fn contact_points_are_kept_once_by_normalized_value_and_the_survivors_preference_stands() {
    let w = World::new("merge_points");
    let (ada, bea) = (add(&w, "Ada"), add(&w, "Bea"));
    let save = |who: &str, kind: &str, value: &str, preferred: bool| {
        w.ok(
            "person.save_contact_point",
            json!({ "id": who, "kind": kind, "value": value, "preferred": preferred }),
        );
    };
    save(&ada, "phone", "+1 555 010 0100", true);
    save(&ada, "email", "ada@example.com", false);
    save(&bea, "phone", "+1 (555) 010-0100", false);
    save(&bea, "phone", "+44 20 7946 0000", true);
    save(&bea, "email", "ADA@example.com", true);
    save(&bea, "email", "bea@example.com", false);
    save(&bea, "url", "https://bea.example", false);
    let out = merge(&w, &bea, &ada);
    assert_eq!(out["points"], json!({ "moved": 3, "same": 2 }));
    let held = w.strings(
        "SELECT kind || ':' || value || (CASE WHEN preferred = 1 THEN '*' ELSE '' END) FROM contact_point
          WHERE person_id = ?1 ORDER BY position, id",
        &[&ada],
    );
    assert_eq!(
        held,
        [
            "phone:+1 555 010 0100*",
            "email:ada@example.com*",
            "phone:+44 20 7946 0000",
            "email:bea@example.com",
            "url:https://bea.example",
        ],
        "one number, one address; her preferred phone stands; his only preferred email, equal to hers, makes hers the one"
    );
    assert_eq!(
        w.one::<i64>(
            "SELECT COUNT(*) FROM contact_point WHERE person_id <> ?1",
            &[&ada]
        ),
        0
    );
}

// ---------------------------------------------------------------------------------------------
// Invitations, touches, readings and measurements
// ---------------------------------------------------------------------------------------------

#[test]
fn an_invitation_names_the_survivor_after_the_merge() {
    let w = World::new("merge_guests");
    let (ada, bea) = (add(&w, "Ada"), add(&w, "Bea"));
    let event = w.mint();
    w.commit(|tx| {
        tx.insert_entity_in(&event, Kind::Event, "Dinner", Some("calendar:default"), AT)?;
        tx.connection().execute(
            "INSERT INTO event (id, starts, timing) VALUES (?1, '2030-03-02T19:00', 'floating')",
            [&event],
        )?;
        for (address, person) in [("bea@example.com", &bea), ("ada@example.com", &ada)] {
            tx.connection().execute(
                "INSERT INTO event_guest (event_id, address, person_id) VALUES (?1, ?2, ?3)",
                [event.as_str(), address, person.as_str()],
            )?;
        }
        Ok(())
    });
    merge(&w, &bea, &ada);
    assert_eq!(
        w.strings(
            "SELECT address FROM event_guest WHERE person_id = ?1 ORDER BY address",
            &[&ada]
        ),
        ["ada@example.com", "bea@example.com"],
        "both invitations are the survivor's"
    );
    assert_eq!(
        w.one::<i64>(
            "SELECT COUNT(*) FROM event_guest WHERE person_id IS NULL",
            &[]
        ),
        0,
        "no guest was left with nobody"
    );
}

#[test]
fn every_touch_is_the_survivors_and_a_touch_with_both_is_with_them_once() {
    let w = World::new("merge_touches");
    let (ada, bea) = (add(&w, "Ada"), add(&w, "Bea"));
    let alone = id_of(
        &w.ok(
            "touch.log",
            json!({ "people": [bea], "kind": "Call", "starts": "2027-01-01T10:00:00Z" }),
        ),
        "id",
    );
    let both = id_of(
        &w.ok(
            "touch.log",
            json!({ "people": [ada, bea], "kind": "Met up", "starts": "2027-02-01T10:00:00Z" }),
        ),
        "id",
    );
    let hers = id_of(
        &w.ok(
            "touch.log",
            json!({ "people": [ada], "kind": "Message", "starts": "2027-03-01T10:00:00Z" }),
        ),
        "id",
    );
    merge(&w, &bea, &ada);
    for touch_id in [&alone, &both, &hers] {
        assert_eq!(
            w.strings(
                "SELECT to_id FROM edge WHERE from_id = ?1 AND rel = 'with'",
                &[touch_id]
            ),
            [ada.as_str()],
            "{touch_id}"
        );
    }
    let all = w
        .vault()
        .read(|c| touch::touches_of(c, &ada, 10))
        .expect("touches");
    assert_eq!(
        all.iter().map(|row| row.id.as_str()).collect::<Vec<_>>(),
        [hers, both, alone]
    );
    assert_eq!(
        w.vault()
            .read(|c| touch::last_contacted(c, &ada, "2030-01-01T00:00:00.000Z"))
            .unwrap()
            .as_deref(),
        Some("2027-03-01T10:00:00.000Z")
    );
}

#[test]
fn readings_and_daily_figures_are_the_survivors_and_a_day_both_have_is_the_survivors() {
    let w = World::new("merge_health");
    let (ada, bea) = (add(&w, "Ada"), add(&w, "Bea"));
    let reading = w.mint();
    w.commit(|tx| {
        tx.insert_entity_in(&reading, Kind::Reading, "", None, AT)?;
        tx.connection().execute(
            "INSERT INTO reading (id, person_id, metric, at, value) VALUES (?1, ?2, 'weight_kg', ?3, 61.5)",
            [reading.as_str(), bea.as_str(), "2027-01-01T08:00:00.000Z"],
        )?;
        for (person, day, value) in [(&ada, "2027-01-01", 1000), (&bea, "2027-01-01", 2000), (&bea, "2027-01-02", 3000)] {
            tx.connection().execute(
                "INSERT INTO measurement (person_id, day, metric, value) VALUES (?1, ?2, 'steps', ?3)",
                rusqlite::params![person, day, value],
            )?;
        }
        Ok(())
    });
    merge(&w, &bea, &ada);
    assert_eq!(
        w.one::<String>("SELECT person_id FROM reading WHERE id = ?1", &[&reading]),
        ada
    );
    assert_eq!(
        w.strings("SELECT day || '=' || CAST(value AS INTEGER) FROM measurement WHERE person_id = ?1 ORDER BY day", &[&ada]),
        ["2027-01-01=1000", "2027-01-02=3000"]
    );
    assert_eq!(
        w.one::<i64>(
            "SELECT COUNT(*) FROM measurement WHERE person_id <> ?1",
            &[&ada]
        ),
        0
    );
}

#[test]
fn blanks_are_filled_from_the_one_who_goes_and_the_survivors_words_stand() {
    let w = World::new("merge_fields");
    let ada = id_of(
        &w.ok(
            "person.add",
            json!({ "title": "Ada", "role": "Mathematician", "org": "Engines" }),
        ),
        "id",
    );
    let bea = id_of(
        &w.ok("person.add", json!({ "title": "Bea", "role": "Poet", "given": "Beatrix", "family": "Potter", "phonetic": "BEE-a",
                                      "nickname": "B", "met": "at school", "cadence_days": 14 })),
        "id",
    );
    merge(&w, &bea, &ada);
    assert_eq!(
        w.one::<String>(
            "SELECT role || '|' || org || '|' || given || '|' || family || '|' || phonetic || '|' || nickname || '|' || met || '|' || cadence_days
               FROM person WHERE id = ?1",
            &[&ada]
        ),
        "Mathematician|Engines|Beatrix|Potter|BEE-a|B|at school|14"
    );
    assert_eq!(
        w.one::<String>("SELECT title FROM entity WHERE id = ?1", &[&ada]),
        "Ada"
    );
}

#[test]
fn an_avatar_the_survivor_lacks_is_the_one_who_went() {
    let w = World {
        scratch: common::Scratch::founded_with_blobs("merge_avatar").expect("a vault"),
        registry: centraid_vault::commands::Registry::with_system_commands().expect("a registry"),
    };
    let (ada, bea) = (add(&w, "Ada"), add(&w, "Bea"));
    let hash = w
        .vault()
        .blobs()
        .expect("a store")
        .put(b"face")
        .expect("stored");
    w.ok("person.set_avatar", json!({ "id": bea, "blob": hash }));
    merge(&w, &bea, &ada);
    assert_eq!(
        w.one::<String>("SELECT avatar FROM person WHERE id = ?1", &[&ada]),
        hash
    );
}
