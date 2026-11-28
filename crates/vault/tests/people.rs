//! People's own verbs, against a vault the product founds (#1214): a person and its columns, the
//! avatar, contact points, dates, touches, lists and relationships, what the trash does, search and
//! earlier versions, and "In your vault". The merge is `tests/people_merge.rs`; the follower is
//! `tests/shared_verbs_people_follow.rs`.

mod common;

use centraid_vault::commands::person_date;
use centraid_vault::commands::{contact_point, touch};
use centraid_vault::history;
use common::world::World;
use serde_json::{Value as Json, json};

fn id_of(output: &Json, key: &str) -> String {
    output[key].as_str().expect("an id").to_owned()
}

fn add(w: &World, title: &str) -> String {
    id_of(&w.ok("person.add", json!({ "title": title })), "id")
}

fn found_by(w: &World, term: &str, id: &str) -> bool {
    w.one::<i64>(
        "SELECT COUNT(*) FROM search s JOIN entity e ON e.n = s.rowid
          WHERE search MATCH ?1 AND e.id = ?2",
        &[&format!("\"{term}\""), id],
    ) == 1
}

fn with_blobs(seed: &str) -> World {
    World {
        scratch: common::Scratch::founded_with_blobs(seed).expect("a vault"),
        registry: centraid_vault::commands::Registry::with_system_commands().expect("a registry"),
    }
}

// ---------------------------------------------------------------------------------------------
// 1. A person
// ---------------------------------------------------------------------------------------------

#[test]
fn a_person_is_added_edited_and_found_by_what_is_known_of_them() {
    let w = World::new("people_basics");
    let id = id_of(
        &w.ok(
            "person.add",
            json!({
                "title": "Ada Lovelace", "given": "Ada", "family": "Lovelace", "phonetic": "AY-da",
                "org": "Analytical Engines", "role": "Mathematician", "cadence_days": 30
            }),
        ),
        "id",
    );
    // The raw rows: the entity and its kind row say what was asked, the form is the column's own.
    assert_eq!(
        w.one::<String>(
            "SELECT p.form || '|' || p.given || '|' || p.family || '|' || p.phonetic || '|' || p.org || '|' || p.role || '|' || p.cadence_days
               FROM person p WHERE p.id = ?1",
            &[&id]
        ),
        "person|Ada|Lovelace|AY-da|Analytical Engines|Mathematician|30"
    );
    assert_eq!(
        w.one::<String>(
            "SELECT kind || '|' || title FROM entity WHERE id = ?1",
            &[&id]
        ),
        "person|Ada Lovelace"
    );
    for word in ["mathematician", "engines", "lovelace", "ada", "ay"] {
        assert!(found_by(&w, word, &id), "{word}");
    }

    w.ok(
        "person.edit",
        json!({ "id": id, "nickname": "Countess", "met": "at a salon", "cadence_days": 0,
                "role": null, "org": "Babbage & Co", "given": null }),
    );
    assert!(
        found_by(&w, "countess", &id) && found_by(&w, "salon", &id) && found_by(&w, "babbage", &id)
    );
    assert!(
        !found_by(&w, "mathematician", &id),
        "a cleared role leaves the index"
    );
    assert!(
        !found_by(&w, "analytical", &id),
        "a replaced org leaves the index"
    );
    assert_eq!(
        w.one::<i64>(
            "SELECT (cadence_days IS NULL) + (role IS NULL) + (given IS NULL) FROM person WHERE id = ?1",
            &[&id]
        ),
        3,
        "0 is no cadence; null clears a field"
    );
    w.ok(
        "person.edit",
        json!({ "id": id, "title": "Ada King", "form": "org" }),
    );
    assert_eq!(
        w.one::<String>("SELECT e.title || '|' || p.form FROM entity e JOIN person p ON p.id = e.id WHERE e.id = ?1", &[&id]),
        "Ada King|org"
    );

    // The sentences, each also the database's (tests/schema_rules.rs).
    assert!(
        w.refused("person.add", json!({ "title": "  " }))
            .contains("needs a name")
    );
    assert!(
        w.refused("person.edit", json!({ "id": id, "title": " " }))
            .contains("needs a name")
    );
    assert!(
        w.refused("person.add", json!({ "id": id, "title": "Again" }))
            .contains("already holds")
    );
    assert!(
        w.refused("person.add", json!({ "title": "Rex", "form": "robot" }))
            .contains("not a kind of person")
    );
    assert!(
        w.refused("person.edit", json!({ "id": id, "form": "robot" }))
            .contains("not a kind of person")
    );
    let note = w.note("Not a person");
    assert!(
        w.refused("person.edit", json!({ "id": note, "title": "x" }))
            .contains("not a person")
    );
}

#[test]
fn a_person_is_trashed_and_restored_and_the_owner_never_is() {
    let w = World::new("people_trash");
    let id = add(&w, "Bea");
    w.ok("entity.trash", json!({ "id": id }));
    assert!(w.one::<bool>(
        "SELECT deleted_at IS NOT NULL FROM entity WHERE id = ?1",
        &[&id]
    ));
    assert!(
        w.refused("person.edit", json!({ "id": id, "nickname": "B" }))
            .contains("trash"),
        "a trashed person is not edited"
    );
    w.ok("entity.restore", json!({ "id": id }));
    w.ok("person.edit", json!({ "id": id, "nickname": "B" }));
    // The owner is a person nothing trashes, purges or merges away.
    let owner = common::self_person(w.vault()).expect("the owner");
    assert!(
        w.refused("entity.trash", json!({ "id": owner }))
            .contains("you")
    );
    assert!(
        w.refused("entity.purge", json!({ "id": owner }))
            .contains("you")
    );
    assert!(
        w.refused("person.merge", json!({ "from": owner, "into": id }))
            .contains("you")
    );
}

#[test]
fn an_avatar_is_set_replaced_and_taken_off_and_the_picture_it_replaced_is_in_the_earlier_version() {
    let w = with_blobs("people_avatar");
    let id = add(&w, "Cy");
    let put = |bytes: &[u8]| {
        w.vault()
            .blobs()
            .expect("a store")
            .put(bytes)
            .expect("stored")
    };
    let (one, two) = (put(b"first"), put(b"second"));
    w.ok("person.set_avatar", json!({ "id": id, "blob": one }));
    assert_eq!(
        w.one::<String>("SELECT avatar FROM person WHERE id = ?1", &[&id]),
        one
    );
    w.ok("person.set_avatar", json!({ "id": id, "blob": two }));
    // The version the replacement kept names the first picture in the slot the history owns.
    assert_eq!(
        w.one::<i64>(
            "SELECT COUNT(*) FROM revision_blob WHERE entity_id = ?1 AND slot = 'avatar' AND blob = ?2",
            &[&id, &one]
        ),
        1
    );
    w.ok("person.set_avatar", json!({ "id": id, "blob": null }));
    assert_eq!(
        w.one::<i64>("SELECT avatar IS NULL FROM person WHERE id = ?1", &[&id]),
        1
    );
    // Restoring that version puts the picture back.
    let seq = w.one::<i64>(
        "SELECT seq FROM revision_blob WHERE entity_id = ?1 AND slot = 'avatar' AND blob = ?2",
        &[&id, &one],
    );
    w.ok("history.restore_version", json!({ "id": id, "seq": seq }));
    assert_eq!(
        w.one::<String>("SELECT avatar FROM person WHERE id = ?1", &[&id]),
        one
    );
    assert!(
        w.refused(
            "person.set_avatar",
            json!({ "id": id, "blob": "0".repeat(64) })
        )
        .contains("not in this vault's store")
    );
    // A vault with no store keeps no picture.
    let bare = World::new("people_avatar_bare");
    let nobody = add(&bare, "Di");
    assert!(
        bare.refused("person.set_avatar", json!({ "id": nobody, "blob": one }))
            .contains("nowhere")
    );
}

#[test]
fn earlier_versions_of_a_person_name_what_changed_and_are_searchable() {
    let w = World::new("people_versions");
    let id = add(&w, "Eve");
    w.ok("person.edit", json!({ "id": id, "org": "Quokka Labs" }));
    w.ok(
        "person.edit",
        json!({ "id": id, "org": "Numbat Labs", "role": "Chief" }),
    );
    let earlier = w
        .vault()
        .read(|c| history::earlier_versions(c, &id, None, 10))
        .expect("versions");
    assert_eq!(earlier.versions.len(), 2);
    let newest = &earlier.versions[0];
    assert!(
        newest
            .changes
            .iter()
            .any(|change| change.field == "person.org"
                && change.before == json!("Quokka Labs")
                && change.after == json!("Numbat Labs")),
        "{:?}",
        newest.changes
    );
    // What was said is found in the version that said it, and not in the present.
    assert!(found_by(&w, "numbat", &id) && !found_by(&w, "quokka", &id));
    assert_eq!(
        w.one::<i64>(
            "SELECT count(DISTINCT e.id) FROM search_past t JOIN entity e ON e.n = (t.rowid >> 24)
              WHERE search_past MATCH '\"quokka\"' AND e.id = ?1",
            &[&id]
        ),
        1
    );
    // A restore puts the earlier words back.
    let seq = newest.seq;
    w.ok("history.restore_version", json!({ "id": id, "seq": seq }));
    assert_eq!(
        w.one::<String>("SELECT org FROM person WHERE id = ?1", &[&id]),
        "Quokka Labs"
    );
}

// ---------------------------------------------------------------------------------------------
// 2. Contact points
// ---------------------------------------------------------------------------------------------

fn points(w: &World, person: &str) -> Vec<String> {
    w.strings(
        "SELECT kind || ':' || value || (CASE WHEN preferred = 1 THEN '*' ELSE '' END)
           FROM contact_point WHERE person_id = ?1 ORDER BY position, id",
        &[person],
    )
}

#[test]
fn contact_points_are_one_per_spelling_and_one_preferred_per_kind_and_found_by_the_key() {
    let w = World::new("people_points");
    let ada = add(&w, "Ada");
    let bob = add(&w, "Bob");
    let first = id_of(
        &w.ok(
            "person.save_contact_point",
            json!({ "id": ada, "kind": "phone", "value": "+1 (555) 010-0100", "label": "cell", "preferred": true }),
        ),
        "point_id",
    );
    let second = id_of(
        &w.ok(
            "person.save_contact_point",
            json!({ "id": ada, "kind": "phone", "value": "+44 20 7946 0000" }),
        ),
        "point_id",
    );
    w.ok(
        "person.save_contact_point",
        json!({ "id": ada, "kind": "email", "value": "Ada@Example.com" }),
    );
    // The same number spelled another way is the same point; so is an address in another case.
    assert!(
        w.refused(
            "person.save_contact_point",
            json!({ "id": ada, "kind": "phone", "value": "+1 555 010 0100" })
        )
        .contains("already saved")
    );
    assert!(
        w.refused(
            "person.save_contact_point",
            json!({ "id": ada, "kind": "email", "value": "ada@example.COM" })
        )
        .contains("already saved")
    );
    assert_eq!(points(&w, &ada).len(), 3);

    // One preferred per kind: preferring the second takes the preference from the first.
    w.ok("person.prefer_contact_point", json!({ "point_id": second }));
    assert_eq!(
        points(&w, &ada)[..2],
        ["phone:+1 (555) 010-0100", "phone:+44 20 7946 0000*"]
    );
    w.ok(
        "person.prefer_contact_point",
        json!({ "point_id": second, "preferred": false }),
    );
    assert!(points(&w, &ada).iter().all(|point| !point.ends_with('*')));
    // An edit that does not say keeps the preference it had.
    w.ok("person.prefer_contact_point", json!({ "point_id": first }));
    w.ok(
        "person.save_contact_point",
        json!({ "id": ada, "point_id": first, "kind": "phone", "value": "+1 555 010 0199", "label": "work" }),
    );
    assert_eq!(points(&w, &ada)[0], "phone:+1 555 010 0199*");
    assert_eq!(
        w.one::<String>("SELECT label FROM contact_point WHERE id = ?1", &[&first]),
        "work"
    );

    // The database holds the same rule.
    assert!(
        w.vault()
            .commit(|tx| {
                tx.connection().execute(
                    "UPDATE contact_point SET preferred = 1 WHERE id = ?1",
                    [&second],
                )?;
                Ok(())
            })
            .is_err(),
        "two preferred points of a kind are refused by the index"
    );

    // Reorder: each point once.
    let email = w.one::<String>(
        "SELECT id FROM contact_point WHERE person_id = ?1 AND kind = 'email'",
        &[&ada],
    );
    w.ok(
        "person.reorder_contact_points",
        json!({ "id": ada, "order": [&email, &second, &first] }),
    );
    assert_eq!(
        points(&w, &ada),
        [
            "email:Ada@Example.com",
            "phone:+44 20 7946 0000",
            "phone:+1 555 010 0199*"
        ]
    );
    assert!(
        w.refused(
            "person.reorder_contact_points",
            json!({ "id": ada, "order": [&email, &second] })
        )
        .contains("each")
    );

    // Found by the key two spellings share, whoever holds it; the trashed are not.
    w.ok(
        "person.save_contact_point",
        json!({ "id": bob, "kind": "email", "value": " ADA@example.com " }),
    );
    let found = |kind: &str, value: &str| {
        w.vault()
            .read(|c| contact_point::people_with(c, kind, value))
            .expect("a read")
    };
    assert_eq!(
        found("email", "ada@EXAMPLE.com"),
        [ada.clone(), bob.clone()]
    );
    assert_eq!(found("phone", "+1-555-010-0199"), [ada.as_str()]);
    assert_eq!(
        w.vault()
            .read(|c| contact_point::person_of_email(c, "ADA@example.com"))
            .unwrap(),
        Some(ada.clone())
    );
    w.ok("entity.trash", json!({ "id": bob }));
    assert_eq!(found("email", "ada@example.com"), [ada.as_str()]);

    // The sentences.
    assert!(
        w.refused(
            "person.save_contact_point",
            json!({ "id": ada, "kind": "email", "value": "nope" })
        )
        .contains("valid email")
    );
    assert!(
        w.refused(
            "person.save_contact_point",
            json!({ "id": ada, "kind": "fax", "value": "12345678" })
        )
        .contains("not a way to reach")
    );
    assert!(
        w.refused(
            "person.save_contact_point",
            json!({ "id": ada, "point_id": "nope", "kind": "phone", "value": "+1 555 010 0100" })
        )
        .contains("no contact point")
    );
    w.ok("person.remove_contact_point", json!({ "point_id": second }));
    assert_eq!(points(&w, &ada).len(), 2);
    assert!(
        w.refused("person.remove_contact_point", json!({ "point_id": second }))
            .contains("no contact point")
    );
}

#[test]
fn the_contact_point_lookup_plan_names_its_index() {
    let w = World::new("people_points_plan");
    let detail = w
        .vault()
        .read(|c| {
            let mut statement = c.prepare(
                "EXPLAIN QUERY PLAN SELECT c.person_id FROM contact_point c JOIN entity e ON e.id = c.person_id
                  WHERE c.kind = 'email' AND c.normalized = 'a@b.c' AND e.deleted_at IS NULL",
            )?;
            let rows = statement
                .query_map([], |row| row.get::<_, String>(3))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows.join("\n"))
        })
        .expect("a plan");
    assert!(detail.contains("contact_point_by_value"), "{detail}");
    assert!(!detail.contains("SCAN contact_point"), "{detail}");
}

// ---------------------------------------------------------------------------------------------
// 3. Dates
// ---------------------------------------------------------------------------------------------

fn dates(w: &World, person: &str) -> Vec<String> {
    w.strings(
        "SELECT kind || ':' || date || ':' || ifnull(label, '') FROM person_date
          WHERE person_id = ?1 ORDER BY position, id",
        &[person],
    )
}

#[test]
fn a_person_has_one_birthday_and_any_number_of_other_dates_with_or_without_a_year() {
    let w = World::new("people_dates");
    let ada = add(&w, "Ada");
    let birthday = id_of(
        &w.ok(
            "person.add_date",
            json!({ "id": ada, "kind": "birthday", "date": "03-14" }),
        ),
        "date_id",
    );
    // A yearless date is kept in vCard's own form, whichever way it was written.
    assert_eq!(dates(&w, &ada), ["birthday:--03-14:"]);
    w.ok(
        "person.add_date",
        json!({ "id": ada, "kind": "anniversary", "date": "2010-06-01", "label": "wedding" }),
    );
    w.ok("person.add_date", json!({ "id": ada, "date": "--12-25" }));
    assert_eq!(
        dates(&w, &ada),
        [
            "birthday:--03-14:",
            "anniversary:2010-06-01:wedding",
            "other:--12-25:"
        ],
        "a date with no kind is `other`"
    );
    // Two birthdays are refused in a sentence and by the database.
    assert!(
        w.refused(
            "person.add_date",
            json!({ "id": ada, "kind": "birthday", "date": "1990-03-14" })
        )
        .contains("one date of this kind")
    );
    assert!(
        w.vault()
            .commit(|tx| {
                tx.connection().execute(
                    "INSERT INTO person_date (id, person_id, kind, single, date) VALUES ('x', ?1, 'birthday', 1, '1990-01-01')",
                    [&ada],
                )?;
                Ok(())
            })
            .is_err()
    );
    // Edit: the year arrives, the label goes; a date cannot become a second birthday.
    w.ok(
        "person.edit_date",
        json!({ "date_id": birthday, "date": "1815-03-14" }),
    );
    assert_eq!(dates(&w, &ada)[0], "birthday:1815-03-14:");
    let other = w.one::<String>(
        "SELECT id FROM person_date WHERE person_id = ?1 AND kind = 'other'",
        &[&ada],
    );
    assert!(
        w.refused(
            "person.edit_date",
            json!({ "date_id": other, "kind": "birthday" })
        )
        .contains("one date of this kind")
    );
    w.ok(
        "person.edit_date",
        json!({ "date_id": other, "label": "Christmas", "kind": "anniversary" }),
    );
    assert_eq!(dates(&w, &ada)[2], "anniversary:--12-25:Christmas");
    // The sentences.
    for bad in ["soon", "02-30", "2023-02-29", "13-01", "--02-30"] {
        assert!(
            w.refused(
                "person.add_date",
                json!({ "id": ada, "kind": "other", "date": bad })
            )
            .contains("not a day"),
            "{bad}"
        );
    }
    assert!(
        w.refused(
            "person.add_date",
            json!({ "id": ada, "kind": "feast", "date": "01-01" })
        )
        .contains("not a kind of date")
    );
    // A leap day is a day, with no year or in a leap year.
    w.ok("person.add_date", json!({ "id": ada, "date": "02-29" }));
    w.ok(
        "person.add_date",
        json!({ "id": ada, "date": "2024-02-29" }),
    );
    // Remove.
    w.ok("person.remove_date", json!({ "date_id": other }));
    assert!(
        w.refused("person.remove_date", json!({ "date_id": other }))
            .contains("no date")
    );
    assert_eq!(dates(&w, &ada).len(), 4);
}

#[test]
fn a_reminder_on_two_dates_with_the_same_lead_is_two_reminders_and_a_date_goes_with_them() {
    let w = World::new("people_date_reminders");
    let ada = add(&w, "Ada");
    let d1 = id_of(
        &w.ok(
            "person.add_date",
            json!({ "id": ada, "kind": "birthday", "date": "03-14", "reminders": [1440, 60] }),
        ),
        "date_id",
    );
    let d2 = id_of(
        &w.ok(
            "person.add_date",
            json!({ "id": ada, "kind": "anniversary", "date": "06-01", "reminders": [1440] }),
        ),
        "date_id",
    );
    assert_eq!(
        w.one::<i64>(
            "SELECT COUNT(*) FROM reminder WHERE entity_id = ?1",
            &[&ada]
        ),
        3
    );
    assert_eq!(
        w.one::<i64>(
            "SELECT COUNT(DISTINCT id) FROM reminder WHERE offset_min = 1440 AND date_id IN (?1, ?2)",
            &[&d1, &d2]
        ),
        2
    );
    // A reminder can be added on a date later, by the shared verb; the same lead twice is refused.
    let late = w.ok(
        "reminder.add",
        json!({ "entity_id": ada, "date_id": d2, "offset_min": 10 }),
    );
    assert!(late["id"].is_string());
    assert!(
        w.refused(
            "reminder.add",
            json!({ "entity_id": ada, "date_id": d2, "offset_min": 10 })
        )
        .contains("already")
    );
    // A person has no moment of their own: a reminder names one of their dates.
    assert!(
        w.refused(
            "reminder.add",
            json!({ "entity_id": ada, "offset_min": 10 })
        )
        .contains("names one of")
    );
    // Removing a date takes its reminders.
    w.ok("person.remove_date", json!({ "date_id": d1 }));
    assert_eq!(
        w.one::<i64>(
            "SELECT COUNT(*) FROM reminder WHERE entity_id = ?1",
            &[&ada]
        ),
        2
    );
}

#[test]
fn calendar_reads_whose_dates_fall_on_a_day_or_in_a_month_whatever_the_year() {
    let w = World::new("people_dates_read");
    let ada = add(&w, "Ada");
    let bob = add(&w, "Bob");
    let cy = add(&w, "Cy");
    w.ok(
        "person.add_date",
        json!({ "id": ada, "kind": "birthday", "date": "1815-03-14" }),
    );
    w.ok(
        "person.add_date",
        json!({ "id": bob, "kind": "birthday", "date": "03-14" }),
    );
    w.ok(
        "person.add_date",
        json!({ "id": bob, "kind": "anniversary", "date": "2001-03-20", "label": "wedding" }),
    );
    w.ok(
        "person.add_date",
        json!({ "id": cy, "kind": "birthday", "date": "04-01" }),
    );
    let on = |day: &str| {
        w.vault()
            .read(|c| person_date::on_day(c, day))
            .expect("a read")
            .into_iter()
            .map(|d| (d.person, d.kind, d.year))
            .collect::<Vec<_>>()
    };
    assert_eq!(
        on("03-14"),
        [
            ("Ada".to_owned(), "birthday".to_owned(), Some(1815)),
            ("Bob".to_owned(), "birthday".to_owned(), None)
        ]
    );
    assert!(on("03-15").is_empty());
    let march = w
        .vault()
        .read(|c| person_date::in_month(c, "03"))
        .expect("a month");
    assert_eq!(march.len(), 3);
    assert_eq!(march[2].label.as_deref(), Some("wedding"));
    assert_eq!(march[2].date, "2001-03-20");
    // A trashed person's dates are not on the calendar.
    w.ok("entity.trash", json!({ "id": bob }));
    assert_eq!(on("03-14").len(), 1);
    assert_eq!(
        w.vault()
            .read(|c| person_date::in_month(c, "03"))
            .unwrap()
            .len(),
        1
    );
    // The plan is the index built for it.
    let detail = w
        .vault()
        .read(|c| {
            let mut statement = c.prepare(
                "EXPLAIN QUERY PLAN SELECT d.id FROM person_date d CROSS JOIN entity e ON e.id = d.person_id
                  WHERE substr(d.date, -5) BETWEEN '03-01' AND '03-31' AND e.deleted_at IS NULL",
            )?;
            let rows = statement
                .query_map([], |row| row.get::<_, String>(3))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows.join("\n"))
        })
        .expect("a plan");
    assert!(detail.contains("person_date_by_day"), "{detail}");
    assert!(
        !detail.contains("SCAN d") && !detail.contains("SCAN person_date"),
        "{detail}"
    );
}

// ---------------------------------------------------------------------------------------------
// 4. Touches
// ---------------------------------------------------------------------------------------------

fn place(w: &World, name: &str) -> String {
    let id = w.mint();
    w.commit(|tx| {
        tx.insert_entity_in(
            &id,
            centraid_vault::model::Kind::Place,
            name,
            None,
            common::world::AT,
        )?;
        tx.connection()
            .execute("INSERT INTO place (id) VALUES (?1)", [&id])?;
        Ok(())
    });
    id
}

#[test]
fn a_touch_is_logged_with_several_people_edited_and_trashed_and_spawns_no_note() {
    let w = World::new("people_touch");
    let (ada, bob) = (add(&w, "Ada"), add(&w, "Bob"));
    let notes_before = w.one::<i64>("SELECT COUNT(*) FROM entity WHERE kind = 'note'", &[]);
    let out = w.ok(
        "touch.log",
        json!({ "people": [ada, bob], "kind": "Met up", "starts": "2026-02-01T10:00:00Z",
                "ends": "2026-02-01T11:30:00Z", "notes": "coffee" }),
    );
    let id = id_of(&out, "id");
    // A touch is an entity of its own kind with a touch kind concept, linked `with` each person.
    assert_eq!(
        w.one::<String>(
            "SELECT e.kind || '|' || e.title || '|' || t.starts || '|' || t.ends || '|' || t.notes || '|' || k.key
               FROM touch t JOIN entity e ON e.id = t.id JOIN concept k ON k.id = t.type_id WHERE t.id = ?1",
            &[&id]
        ),
        "touch|Met up|2026-02-01T10:00:00.000Z|2026-02-01T11:30:00.000Z|coffee|met-up",
        "the seeded kind is found by its word"
    );
    assert_eq!(
        w.strings(
            "SELECT to_id FROM edge WHERE from_id = ?1 AND rel = 'with' ORDER BY to_id",
            &[&id]
        )
        .len(),
        2
    );
    assert_eq!(
        w.one::<i64>("SELECT COUNT(*) FROM entity WHERE kind = 'note'", &[]),
        notes_before,
        "no note is spawned"
    );
    // A word that is new is a touch kind of the member's own.
    let own = id_of(
        &w.ok("touch.log", json!({ "people": [ada], "kind": "Postcard" })),
        "id",
    );
    assert_eq!(
        w.one::<String>(
            "SELECT c.kind FROM touch t JOIN concept c ON c.id = t.type_id WHERE t.id = ?1",
            &[&own]
        ),
        "touch_kind"
    );
    // The history of one person is two touches, newest first; the other is in one.
    let seen = |person: &str| {
        w.vault()
            .read(|c| touch::touches_of(c, person, 10))
            .expect("touches")
            .into_iter()
            .map(|row| row.kind)
            .collect::<Vec<_>>()
    };
    assert_eq!(seen(&ada), ["Met up", "Postcard"]);
    assert_eq!(seen(&bob), ["Met up"]);

    // Edit: the kind, the people, the end, the place.
    let cafe = place(&w, "Café");
    w.ok(
        "touch.edit",
        json!({ "id": id, "kind": "Call", "people": [bob], "ends": null, "place_id": cafe, "notes": null }),
    );
    assert_eq!(
        w.one::<String>(
            "SELECT e.title || '|' || (t.ends IS NULL) || '|' || t.place_id || '|' || (t.notes IS NULL) FROM touch t JOIN entity e ON e.id = t.id WHERE t.id = ?1",
            &[&id]
        ),
        format!("Call|1|{cafe}|1")
    );
    assert_eq!(seen(&ada), ["Postcard"]);
    assert_eq!(seen(&bob), ["Call"]);
    // The sentences.
    assert!(
        w.refused("touch.log", json!({ "people": [ada], "kind": " " }))
            .contains("what kind")
    );
    assert!(
        w.refused("touch.log", json!({ "people": ["nobody"], "kind": "Call" }))
            .contains("nothing with the id")
    );
    assert!(
        w.refused("touch.log", json!({ "people": [ada], "kind": "Call", "starts": "2026-02-01T10:00:00Z", "ends": "2026-02-01T09:00:00Z" }))
            .contains("before it starts")
    );
    assert!(
        w.refused(
            "touch.log",
            json!({ "people": [ada], "kind": "Call", "starts": "tuesday" })
        )
        .contains("not a time")
    );
    assert!(
        w.refused(
            "touch.log",
            json!({ "people": [ada], "kind": "Call", "place_id": ada })
        )
        .contains("not a place")
    );
    assert!(
        w.refused("touch.edit", json!({ "id": ada, "kind": "Call" }))
            .contains("not a touch")
    );
    assert!(
        w.refused("touch.edit", json!({ "id": id, "people": [] }))
            .contains("with someone")
    );
    // Trash and restore are the shared verbs; a trashed touch is nobody's last contact.
    w.ok("entity.trash", json!({ "id": id }));
    assert!(seen(&bob).is_empty());
    w.ok("entity.restore", json!({ "id": id }));
    assert_eq!(seen(&bob), ["Call"]);
    // A touch kind in use is not purged out from under it.
    let kind = w.one::<String>("SELECT type_id FROM touch WHERE id = ?1", &[&id]);
    assert!(
        w.refused("entity.purge", json!({ "id": kind }))
            .contains("change them first")
    );
}

#[test]
fn last_contacted_is_computed_at_read_and_a_cadence_says_who_is_due() {
    let w = World::new("people_cadence");
    let (ada, bob, cy) = (add(&w, "Ada"), add(&w, "Bob"), add(&w, "Cy"));
    w.ok("person.edit", json!({ "id": ada, "cadence_days": 7 }));
    w.ok("person.edit", json!({ "id": bob, "cadence_days": 30 }));
    let last = |person: &str, now: &str| {
        w.vault()
            .read(|c| touch::last_contacted(c, person, now))
            .expect("a read")
    };
    assert_eq!(last(&ada, "2030-01-01T00:00:00.000Z"), None);
    let early = id_of(
        &w.ok(
            "touch.log",
            json!({ "people": [ada], "kind": "Call", "starts": "2029-12-20T10:00:00Z" }),
        ),
        "id",
    );
    w.ok(
        "touch.log",
        json!({ "people": [ada, bob], "kind": "Message", "starts": "2029-12-28T10:00:00Z" }),
    );
    // A touch in the future is not contact yet.
    w.ok(
        "touch.log",
        json!({ "people": [ada], "kind": "Met up", "starts": "2031-01-01T10:00:00Z" }),
    );
    assert_eq!(
        last(&ada, "2030-01-01T00:00:00.000Z").as_deref(),
        Some("2029-12-28T10:00:00.000Z")
    );
    assert_eq!(
        last(&cy, "2030-01-01T00:00:00.000Z"),
        None,
        "nothing is stored on the person"
    );
    assert_eq!(
        w.one::<i64>(
            "SELECT COUNT(*) FROM pragma_table_info('person') WHERE name LIKE '%contact%'",
            &[]
        ),
        0
    );
    // Trashing the latest moves it back.
    w.ok("entity.trash", json!({ "id": early }));
    let due = |now: &str| {
        w.vault()
            .read(|c| touch::due(c, now))
            .expect("due")
            .into_iter()
            .map(|d| (d.person, d.due_at))
            .collect::<Vec<_>>()
    };
    // Ada: last 12-28 + 7 days = 01-04. Bob: last 12-28 + 30 days = 01-27. Cy has no cadence.
    assert!(due("2030-01-03T00:00:00.000Z").is_empty());
    assert_eq!(
        due("2030-01-05T00:00:00.000Z"),
        [("Ada".to_owned(), "2030-01-04T10:00:00.000Z".to_owned())]
    );
    assert_eq!(due("2030-02-01T00:00:00.000Z").len(), 2);
    assert_eq!(
        due("2030-02-01T00:00:00.000Z")[0].0,
        "Ada",
        "the most overdue first"
    );
    // Someone never contacted is due a cadence after they were added.
    w.ok("person.edit", json!({ "id": cy, "cadence_days": 1 }));
    assert!(
        due("2030-02-01T00:00:00.000Z")
            .iter()
            .any(|(person, _)| person == "Cy")
    );
    // The owner is never asked about; a trashed person neither.
    let owner = common::self_person(w.vault()).expect("owner");
    w.ok("person.edit", json!({ "id": owner, "cadence_days": 1 }));
    w.ok("entity.trash", json!({ "id": cy }));
    assert!(
        due("2030-02-01T00:00:00.000Z")
            .iter()
            .all(|(person, _)| person != "Cy" && person != "Test Owner")
    );
    // The reads use the indexes made for them.
    let detail = w
        .vault()
        .read(|c| {
            let mut statement = c.prepare(
                "EXPLAIN QUERY PLAN SELECT max(t.starts) FROM edge w JOIN touch t ON t.id = w.from_id
                   JOIN entity te ON te.id = t.id AND te.deleted_at IS NULL
                  WHERE w.to_id = 'p' AND w.rel = 'with' AND t.starts <= 'x'",
            )?;
            let rows = statement
                .query_map([], |row| row.get::<_, String>(3))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows.join("\n"))
        })
        .expect("a plan");
    assert!(detail.contains("edge_to"), "{detail}");
    assert!(
        !detail.contains("SCAN edge") && !detail.contains("TEMP B-TREE"),
        "{detail}"
    );
    let detail = w
        .vault()
        .read(|c| {
            let mut statement = c.prepare(
                "EXPLAIN QUERY PLAN SELECT p.id FROM person p WHERE p.cadence_days IS NOT NULL",
            )?;
            let rows = statement
                .query_map([], |row| row.get::<_, String>(3))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows.join("\n"))
        })
        .expect("a plan");
    assert!(detail.contains("person_by_cadence"), "{detail}");
}

// ---------------------------------------------------------------------------------------------
// Lists, relationships, words, "In your vault"
// ---------------------------------------------------------------------------------------------

#[test]
fn a_person_is_in_one_list_at_a_time() {
    let w = World::new("people_lists");
    let (family, work) = (w.container("list", "Family"), w.container("list", "Work"));
    let ada = id_of(
        &w.ok("person.add", json!({ "title": "Ada", "list_id": family })),
        "id",
    );
    let members = |list: &str| {
        w.strings(
            "SELECT to_id FROM edge WHERE from_id = ?1 AND rel = 'contains'",
            &[list],
        )
    };
    assert_eq!(members(&family), [ada.as_str()]);
    let moved = w.ok("person.move", json!({ "id": ada, "list_id": work }));
    assert_eq!(moved["replaced"]["list_id"], json!(family));
    assert_eq!((members(&family).len(), members(&work).len()), (0, 1));
    w.ok("person.move", json!({ "id": ada, "list_id": null }));
    assert!(members(&work).is_empty());
    let note = w.note("n");
    assert!(
        w.refused("person.move", json!({ "id": ada, "list_id": note }))
            .contains("not a list")
    );
}

#[test]
fn a_relationship_is_a_labelled_edge_to_a_person_the_vault_may_already_know() {
    let w = World::new("people_relations");
    let ada = add(&w, "Ada");
    let mum = add(&w, "Mum");
    let out = w.ok(
        "person.add_relationship",
        json!({ "id": ada, "name": "mum", "kind": "mother" }),
    );
    assert_eq!(
        out["related_id"],
        json!(mum),
        "an existing person of that name is the relative"
    );
    let rex = w.ok(
        "person.add_relationship",
        json!({ "id": ada, "name": "Rex", "kind": "dog", "pet": "Labrador" }),
    );
    assert_eq!(
        w.one::<String>(
            "SELECT form || '|' || role FROM person WHERE id = ?1",
            &[rex["related_id"].as_str().unwrap()]
        ),
        "pet|Labrador"
    );
    assert_eq!(
        w.one::<String>(
            "SELECT l.title FROM edge e JOIN entity l ON l.id = e.label_id WHERE e.from_id = ?1 AND e.to_id = ?2",
            &[&ada, &mum]
        ),
        "mother"
    );
    assert!(
        w.refused(
            "person.add_relationship",
            json!({ "id": ada, "name": "Ada", "kind": "self" })
        )
        .contains("themselves")
    );
    // A note about a person is found with them.
    let note = id_of(
        &w.ok(
            "person.add_note",
            json!({ "id": ada, "text": "Loves quokkas\nand tea" }),
        ),
        "note_id",
    );
    assert_eq!(
        w.one::<String>("SELECT title FROM entity WHERE id = ?1", &[&note]),
        "Loves quokkas"
    );
    assert!(
        found_by(&w, "quokkas", &ada),
        "a person is found by what is written about them"
    );
    assert!(
        w.refused("person.add_note", json!({ "id": ada, "text": "  " }))
            .contains("nothing written")
    );
}

#[test]
fn in_your_vault_lists_what_a_person_is_linked_to_a_locker_item_like_any_other() {
    let w = World::new("people_in_vault");
    let ada = add(&w, "Ada");
    let item = w.bare(
        centraid_vault::model::Kind::LockerItem,
        "Ada's passport",
        None,
    );
    let note = w.note("Ada notes");
    for other in [&item, &note] {
        w.ok("link.add", json!({ "a": ada, "b": other }));
    }
    let linked = w
        .vault()
        .read(|c| centraid_vault::commands::person::in_your_vault(c, &ada))
        .expect("a read");
    let kinds: Vec<_> = linked
        .iter()
        .map(|row| (row.title.as_str(), row.kind.as_str()))
        .collect();
    assert_eq!(
        kinds,
        [("Ada notes", "note"), ("Ada's passport", "locker_item")]
    );
    // From the other end it is the same pair.
    let back = w
        .vault()
        .read(|c| centraid_vault::commands::person::in_your_vault(c, &item))
        .expect("a read");
    assert_eq!(back.len(), 1);
    assert_eq!(back[0].id, ada);
}
