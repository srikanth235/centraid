//! What the old `lane_follow_*` files said of the phone's contacts, on the v0 engine (#1214): a
//! contact's points follow item by item, the owner is nobody's record, a read that lost most of
//! what is followed is doubted, a returned record restores its row, and another phone re-finds a
//! purged person's tombstone; what the phone says that differs and taking it, for a contact's
//! title, fields and points. (The rest of those files is other lanes'.)

mod common;

use common::world::World;
use serde_json::{Value, json};

fn pass(w: &World, device: &str, complete: bool, records: Vec<Value>) -> Value {
    w.ok(
        "follow.contacts",
        json!({ "origin": { "ref": "phone", "label": "Phone", "device_id": device },
                "complete": complete,
                "records": records.into_iter().map(|mut r| { r["device_id"] = json!(device); r }).collect::<Vec<_>>() }),
    )
}

fn people(w: &World, device: &str, complete: bool, names: &[(&str, &str)]) -> Value {
    pass(
        w,
        device,
        complete,
        names
            .iter()
            .map(|(id, name)| json!({ "external_id": id, "fields": { "title": name } }))
            .collect(),
    )
}

fn point(kind: &str, value: &str, label: Option<&str>) -> Value {
    json!({ "kind": kind, "value": value, "label": label })
}

fn grace(w: &World, points: Vec<Value>) {
    pass(
        w,
        "phone-1",
        true,
        vec![json!({ "external_id": "g", "fields": { "title": "Grace", "points": points } })],
    );
}

fn id_of(w: &World, title: &str) -> String {
    w.one::<String>(
        "SELECT id FROM entity WHERE kind = 'person' AND title = ?1",
        &[title],
    )
}

fn points(w: &World, person: &str) -> Vec<String> {
    w.strings(
        "SELECT kind || ':' || value || '=' || COALESCE(label, '') FROM contact_point
          WHERE person_id = ?1 ORDER BY kind, normalized",
        &[person],
    )
}

fn point_id(w: &World, person: &str, kind: &str) -> String {
    w.one::<String>(
        "SELECT id FROM contact_point WHERE person_id = ?1 AND kind = ?2",
        &[person, kind],
    )
}

fn trashed(w: &World, id: &str) -> bool {
    w.one::<bool>(
        "SELECT deleted_at IS NOT NULL FROM entity WHERE id = ?1",
        &[id],
    )
}

#[test]
fn an_untouched_point_takes_the_sources_new_label_and_its_removal() {
    let w = World::new("lfp_label");
    grace(
        &w,
        vec![
            point("phone", "+1 555 010 0100", Some("mobile")),
            point("email", "grace@navy.example", Some("work")),
        ],
    );
    let id = id_of(&w, "Grace");
    grace(&w, vec![point("phone", "+1 555 010 0100", Some("home"))]);
    assert_eq!(points(&w, &id), ["phone:+1 555 010 0100=home"]);
    grace(&w, vec![point("phone", "+1 555 010 0100", None)]);
    assert_eq!(points(&w, &id), ["phone:+1 555 010 0100="]);
}

#[test]
fn a_point_the_member_relabelled_survives_the_source_and_keeps_its_parts_and_follows_again_when_set_back()
 {
    let w = World::new("lfp_relabel");
    grace(
        &w,
        vec![
            point("phone", "+1 555 010 0100", Some("mobile")),
            point("email", "grace@navy.example", Some("work")),
        ],
    );
    let id = id_of(&w, "Grace");
    w.ok(
        "person.save_contact_point",
        json!({ "id": id, "point_id": point_id(&w, &id, "phone"), "kind": "phone",
                 "value": "+1 555 010 0100", "label": "private", "preferred": true }),
    );
    grace(&w, vec![]);
    assert_eq!(
        points(&w, &id),
        ["phone:+1 555 010 0100=private"],
        "the untouched email goes, the member's phone stays"
    );
    assert_eq!(
        w.one::<i64>(
            "SELECT preferred FROM contact_point WHERE person_id = ?1",
            &[&id]
        ),
        1
    );
    // The phone states both again with other labels: the member's relabel stands, the email follows.
    grace(
        &w,
        vec![
            point("phone", "+1 555 010 0100", Some("cell")),
            point("email", "grace@navy.example", Some("office")),
        ],
    );
    assert_eq!(
        points(&w, &id),
        [
            "email:grace@navy.example=office",
            "phone:+1 555 010 0100=private"
        ]
    );
    // Set back to what the phone said last: it follows again.
    w.ok(
        "person.save_contact_point",
        json!({ "id": id, "point_id": point_id(&w, &id, "phone"), "kind": "phone", "value": "+1 555 010 0100", "label": "cell" }),
    );
    grace(
        &w,
        vec![
            point("phone", "+1 555 010 0100", Some("desk")),
            point("email", "grace@navy.example", Some("office")),
        ],
    );
    assert_eq!(
        points(&w, &id),
        [
            "email:grace@navy.example=office",
            "phone:+1 555 010 0100=desk"
        ]
    );
}

#[test]
fn points_the_member_added_or_removed_stay_as_they_left_them() {
    let w = World::new("lfp_added");
    grace(
        &w,
        vec![
            point("phone", "+1 555 010 0100", None),
            point("email", "grace@navy.example", None),
        ],
    );
    let id = id_of(&w, "Grace");
    w.ok(
        "person.save_contact_point",
        json!({ "id": id, "kind": "address", "value": "1 Navy Yard" }),
    );
    w.ok(
        "person.remove_contact_point",
        json!({ "point_id": point_id(&w, &id, "email") }),
    );
    grace(&w, vec![point("email", "grace@navy.example", Some("work"))]);
    assert_eq!(points(&w, &id), ["address:1 Navy Yard="]);
}

#[test]
fn a_contact_named_like_the_owner_is_added_beside_the_owner_and_an_owner_with_a_source_is_not_trashed()
 {
    let w = World::new("lfp_owner");
    let owner = common::self_person(w.vault()).expect("owner");
    let tally = people(&w, "phone-1", true, &[("c1", "Test Owner")]);
    assert_eq!(
        (tally["matched"].as_i64(), tally["added"].as_i64()),
        (Some(0), Some(1)),
        "{tally}"
    );
    assert_eq!(
        w.one::<i64>(
            "SELECT COUNT(*) FROM source WHERE entity_id = ?1",
            &[&owner]
        ),
        0
    );
    // A file with the owner followed is refused by the database itself.
    assert!(
        w.vault()
            .commit(|tx| {
                tx.connection().execute(
                    "UPDATE source SET entity_id = ?1 WHERE external_id = 'c1'",
                    [&owner],
                )?;
                Ok(())
            })
            .is_err()
    );
}

#[test]
fn a_read_that_lost_most_of_what_is_followed_trashes_nothing_and_four_of_six_is_ordinary() {
    let w = World::new("lfp_doubt");
    let names: Vec<(String, String)> = (0..6).map(|i| (format!("c{i}"), format!("P{i}"))).collect();
    let all: Vec<(&str, &str)> = names
        .iter()
        .map(|(a, b)| (a.as_str(), b.as_str()))
        .collect();
    people(&w, "phone-1", false, &all);
    let tally = people(&w, "phone-1", true, &all[..1]);
    assert_eq!(
        (tally["trashed"].as_i64(), tally["doubted"].as_i64()),
        (Some(0), Some(5)),
        "{tally}"
    );
    let tally = people(&w, "phone-1", true, &all[..2]);
    assert_eq!(tally["trashed"].as_i64(), Some(4), "{tally}");
}

#[test]
fn a_record_that_returns_restores_the_person_its_absence_trashed_and_the_members_trash_stands() {
    let w = World::new("lfp_return");
    people(&w, "phone-1", false, &[("a", "Ann"), ("b", "Ben")]);
    let (ann, ben) = (id_of(&w, "Ann"), id_of(&w, "Ben"));
    let gone = people(&w, "phone-1", true, &[("b", "Ben")]);
    assert_eq!(gone["trashed"].as_i64(), Some(1), "{gone}");
    assert!(trashed(&w, &ann));
    let back = people(&w, "phone-1", true, &[("a", "Ann"), ("b", "Ben")]);
    assert!(!trashed(&w, &ann), "{back}");
    assert_eq!(back["added"].as_i64(), Some(0));
    w.ok("entity.trash", json!({ "id": ben }));
    people(&w, "phone-1", true, &[("a", "Ann"), ("b", "Ben")]);
    assert!(trashed(&w, &ben));
}

#[test]
fn another_phone_re_finds_a_purged_persons_tombstone_and_a_gone_tombstone_is_forgotten() {
    let w = World::new("lfp_tombstone");
    people(
        &w,
        "device-a",
        false,
        &[("local:a1", "Ada"), ("local:a2", "Bo")],
    );
    let ada = id_of(&w, "Ada");
    w.ok("entity.trash", json!({ "id": ada }));
    w.ok("entity.purge", json!({ "id": ada }));
    assert_eq!(
        w.one::<i64>("SELECT COUNT(*) FROM source WHERE entity_id IS NULL", &[]),
        1
    );
    let tally = people(
        &w,
        "device-b",
        true,
        &[("local:b1", "ada"), ("local:b2", "Bo")],
    );
    assert_eq!(
        w.one::<i64>(
            "SELECT COUNT(*) FROM entity WHERE kind = 'person' AND lower(title) = 'ada'",
            &[]
        ),
        0,
        "{tally}"
    );
    assert_eq!(
        tally["matched"].as_i64(),
        Some(1),
        "Bo is re-found: {tally}"
    );
    assert_eq!(
        w.one::<i64>(
            "SELECT COUNT(*) FROM source WHERE entity_id IS NULL AND device_id = 'device-b'",
            &[]
        ),
        1
    );
    // Gone from a complete read: the tombstone goes with it.
    people(&w, "device-b", true, &[("local:b2", "Bo")]);
    assert_eq!(
        w.one::<i64>("SELECT COUNT(*) FROM source WHERE entity_id IS NULL", &[]),
        0
    );
}

// ---------------------------------------------------------------------------------------------
// What the phone says that differs, and taking it (`follow::differences`, `follow.take_stated`)
// ---------------------------------------------------------------------------------------------

fn diff(w: &World, id: &str) -> Vec<centraid_vault::commands::follow::Difference> {
    w.vault()
        .read(|c| centraid_vault::commands::follow::differences(c, id))
        .expect("the read")
}

/// The names of the fields that differ.
fn fields(w: &World, id: &str) -> Vec<String> {
    diff(w, id).into_iter().map(|d| d.field).collect()
}

fn take(w: &World, id: &str, field: &str, item: Option<&str>) -> Value {
    let mut input = json!({ "entity": id, "field": field });
    if let Some(item) = item {
        input["item_key"] = json!(item);
    }
    w.ok("follow.take_stated", input)
}

/// Grace Hopper, read from the phone with `fields` besides her name.
fn hopper(w: &World, fields: Value) -> String {
    let mut fields = fields;
    fields["title"] = json!("Grace Hopper");
    pass(
        w,
        "phone-1",
        true,
        vec![json!({ "external_id": "c1", "fields": fields })],
    );
    id_of(w, "Grace Hopper")
}

fn two_points() -> Value {
    json!({ "points": [point("phone", "+1 555 010 0100", Some("mobile")), point("email", "grace@navy.example", None)] })
}

#[test]
fn a_person_reports_title_scalars_and_points_while_they_differ_and_nothing_once_equal() {
    let w = World::new("lfp_stated");
    let mut said = two_points();
    said["role"] = json!("Admiral");
    said["org"] = json!("Navy");
    let id = hopper(&w, said);
    assert!(diff(&w, &id).is_empty(), "untouched: nothing differs");

    w.ok(
        "entity.retitle",
        json!({ "id": id, "title": "Amazing Grace" }),
    );
    w.ok("person.edit", json!({ "id": id, "role": "Rear Admiral" }));
    w.ok(
        "person.save_contact_point",
        json!({ "id": id, "kind": "address", "value": "1 Navy Yard" }),
    );
    let phone = point_id(&w, &id, "phone");
    w.ok(
        "person.save_contact_point",
        json!({ "id": id, "point_id": phone, "kind": "phone", "value": "+1 555 010 0100", "label": "home" }),
    );
    let email = point_id(&w, &id, "email");
    w.ok("person.remove_contact_point", json!({ "point_id": email }));

    let differing = diff(&w, &id);
    let by = |name: &str| differing.iter().find(|d| d.field == name).expect(name);
    assert_eq!(fields(&w, &id), ["title", "role", "points"]);
    assert_eq!(by("title").stated, json!("Grace Hopper"));
    assert_eq!(by("title").held, json!("Amazing Grace"));
    assert_eq!(by("role").stated, json!("Admiral"));
    assert_eq!(by("role").held, json!("Rear Admiral"));
    let items: Vec<(&str, Option<&Value>, bool)> = by("points")
        .items
        .iter()
        .map(|i| (i.key.as_str(), i.stated.as_ref(), i.held.is_some()))
        .collect();
    assert_eq!(
        items,
        [
            ("address:1 navy yard", None, true),
            (
                "email:grace@navy.example",
                Some(&json!({ "kind": "email", "value": "grace@navy.example" })),
                false
            ),
            (
                "phone:+15550100100",
                Some(&json!({ "kind": "phone", "value": "+1 555 010 0100", "label": "mobile" })),
                true
            ),
        ],
        "an item the member added (no stated), one they removed (no held), one they relabelled"
    );
    // `org` was stated and not changed: not reported.
    assert!(!fields(&w, &id).contains(&"org".to_owned()));
    // Setting the title back by hand re-attaches it: nothing is stored, the line just goes.
    w.ok(
        "entity.retitle",
        json!({ "id": id, "title": "Grace Hopper" }),
    );
    assert_eq!(fields(&w, &id), ["role", "points"]);
}

#[test]
fn nothing_is_reported_without_a_live_link_a_stated_field_or_for_a_tombstone() {
    let w = World::new("lfp_unlinked");
    // A person nothing follows.
    let mine = w.ok("person.add", json!({ "title": "Katherine" }))["id"]
        .as_str()
        .expect("id")
        .to_owned();
    w.ok("entity.retitle", json!({ "id": mine, "title": "Kat" }));
    assert!(diff(&w, &mine).is_empty());
    assert!(diff(&w, "no-such-id").is_empty());

    // A field the source never stated (no role) is not compared, whatever the member sets.
    let id = hopper(&w, json!({ "org": "Navy" }));
    w.ok("person.edit", json!({ "id": id, "role": "Admiral" }));
    assert!(diff(&w, &id).is_empty(), "role was never stated");

    // A trashed row has no differences; a restored one has them again.
    w.ok("entity.retitle", json!({ "id": id, "title": "Grace" }));
    assert_eq!(fields(&w, &id), ["title"]);
    w.ok("entity.trash", json!({ "id": id }));
    assert!(diff(&w, &id).is_empty());
    w.ok("entity.restore", json!({ "id": id }));
    assert_eq!(fields(&w, &id), ["title"]);

    // A purged row is a tombstone: no entity, no differences.
    w.ok("entity.trash", json!({ "id": id }));
    w.ok("entity.purge", json!({ "id": id }));
    assert!(diff(&w, &id).is_empty());
}

#[test]
fn taking_a_scalar_makes_it_follow_again_and_the_next_pass_propagates() {
    let w = World::new("lfp_take_scalar");
    let id = hopper(&w, json!({ "role": "Admiral" }));
    w.ok(
        "entity.retitle",
        json!({ "id": id, "title": "Amazing Grace" }),
    );
    w.ok("person.edit", json!({ "id": id, "role": "Rear Admiral" }));
    assert_eq!(fields(&w, &id), ["title", "role"]);

    let stamped = w.stamp(&id);
    assert_eq!(take(&w, &id, "title", None)["changed"], true);
    assert_eq!(
        w.one::<String>("SELECT title FROM entity WHERE id = ?1", &[&id]),
        "Grace Hopper"
    );
    assert_eq!(fields(&w, &id), ["role"], "the title is no longer reported");
    assert_ne!(
        w.stamp(&id),
        stamped,
        "an ordinary edit: the row is touched"
    );
    assert_eq!(
        take(&w, &id, "title", None)["changed"],
        false,
        "taking what agrees is a no-op"
    );

    // The source now renames her: the taken field is untouched, so it follows; the role, still the
    // member's, does not.
    pass(
        &w,
        "phone-1",
        true,
        vec![
            json!({ "external_id": "c1", "fields": { "title": "Rear Admiral Hopper", "role": "Commodore" } }),
        ],
    );
    assert_eq!(
        w.one::<String>("SELECT title FROM entity WHERE id = ?1", &[&id]),
        "Rear Admiral Hopper"
    );
    assert_eq!(
        w.one::<String>("SELECT role FROM person WHERE id = ?1", &[&id]),
        "Rear Admiral"
    );
    assert_eq!(fields(&w, &id), ["role"]);
    take(&w, &id, "role", None);
    assert_eq!(
        w.one::<String>("SELECT role FROM person WHERE id = ?1", &[&id]),
        "Commodore"
    );
    assert!(diff(&w, &id).is_empty());
}

#[test]
fn taking_points_restores_replaces_or_removes_each_item() {
    let w = World::new("lfp_take_points");
    let id = hopper(&w, two_points());
    let phone = point_id(&w, &id, "phone");
    let email = point_id(&w, &id, "email");
    w.ok(
        "person.save_contact_point",
        json!({ "id": id, "point_id": phone, "kind": "phone", "value": "+1 555 010 0100", "label": "home", "preferred": true }),
    );
    w.ok("person.remove_contact_point", json!({ "point_id": email }));
    w.ok(
        "person.save_contact_point",
        json!({ "id": id, "kind": "address", "value": "1 Navy Yard" }),
    );
    let keys = |w: &World| -> Vec<String> {
        diff(w, &id)
            .into_iter()
            .flat_map(|d| d.items.into_iter().map(|i| i.key))
            .collect()
    };
    assert_eq!(
        keys(&w),
        [
            "address:1 navy yard",
            "email:grace@navy.example",
            "phone:+15550100100"
        ]
    );

    // One item at a time: restore the removed one, remove the added one, replace the relabelled one.
    take(&w, &id, "points", Some("email:grace@navy.example"));
    assert_eq!(keys(&w), ["address:1 navy yard", "phone:+15550100100"]);
    take(&w, &id, "points", Some("address:1 navy yard"));
    assert_eq!(keys(&w), ["phone:+15550100100"]);
    take(&w, &id, "points", Some("phone:+15550100100"));
    assert!(diff(&w, &id).is_empty());
    assert_eq!(
        w.one::<i64>(
            "SELECT COUNT(*) FROM contact_point WHERE person_id = ?1",
            &[&id]
        ),
        2
    );
    assert_eq!(
        w.one::<String>(
            "SELECT label FROM contact_point WHERE person_id = ?1 AND kind = 'phone'",
            &[&id]
        ),
        "mobile"
    );
    assert_eq!(
        w.one::<i64>(
            "SELECT preferred FROM contact_point WHERE person_id = ?1 AND kind = 'phone'",
            &[&id]
        ),
        1,
        "what the member set beside the statement stays"
    );

    // The whole field at once, then the next source change reaches the points.
    let email = point_id(&w, &id, "email");
    w.ok("person.remove_contact_point", json!({ "point_id": email }));
    take(&w, &id, "points", None);
    assert!(diff(&w, &id).is_empty());
    grace_points(&w, vec![point("phone", "+1 555 010 0100", Some("work"))]);
    assert_eq!(
        points(&w, &id),
        ["phone:+1 555 010 0100=work"],
        "the taken points follow: the relabel lands and the dropped email goes"
    );
}

/// The phone says Grace Hopper's points again (her record `c1`).
fn grace_points(w: &World, points: Vec<Value>) {
    pass(
        w,
        "phone-1",
        true,
        vec![
            json!({ "external_id": "c1", "fields": { "title": "Grace Hopper", "points": points } }),
        ],
    );
}

#[test]
fn a_take_that_has_nothing_to_take_is_refused_with_a_sentence_and_writes_nothing() {
    let w = World::new("lfp_take_refused");
    let mine = w.ok("person.add", json!({ "title": "Katherine" }))["id"]
        .as_str()
        .expect("id")
        .to_owned();
    let sentence = w.refused(
        "follow.take_stated",
        json!({ "entity": mine, "field": "title" }),
    );
    assert!(sentence.contains("not following anything"), "{sentence}");
    assert!(
        w.refused(
            "follow.take_stated",
            json!({ "entity": "no-such", "field": "title" })
        )
        .contains("not following")
    );

    let id = hopper(
        &w,
        json!({ "role": "Admiral", "points": [point("phone", "+1 555 010 0100", None)] }),
    );
    // Never stated.
    assert!(
        w.refused(
            "follow.take_stated",
            json!({ "entity": id, "field": "org" })
        )
        .contains("never said")
    );
    assert!(
        w.refused(
            "follow.take_stated",
            json!({ "entity": id, "field": "no_such_field" })
        )
        .contains("never said")
    );
    // An item on a scalar, and an item that is nowhere.
    assert!(
        w.refused(
            "follow.take_stated",
            json!({ "entity": id, "field": "role", "item_key": "x" })
        )
        .contains("as a whole")
    );
    assert!(
        w.refused(
            "follow.take_stated",
            json!({ "entity": id, "field": "points", "item_key": "email:nobody@x.example" })
        )
        .contains("no `email:nobody@x.example`")
    );
    // A trashed row has no link to take from.
    w.ok("entity.retitle", json!({ "id": id, "title": "Grace" }));
    w.ok("entity.trash", json!({ "id": id }));
    assert!(
        w.refused(
            "follow.take_stated",
            json!({ "entity": id, "field": "title" })
        )
        .contains("not following")
    );
    assert_eq!(
        w.one::<String>("SELECT title FROM entity WHERE id = ?1", &[&id]),
        "Grace"
    );
}

#[test]
fn an_imported_date_is_silent_until_the_member_asks_and_the_follower_writes_no_reminder() {
    let w = World::new("follow_dates_silent");
    let records = |birthday: &str| {
        vec![json!({ "external_id": "g", "fields": { "title": "Grace",
            "dates": [{ "kind": "birthday", "date": birthday }] } })]
    };
    pass(&w, "phone-1", true, records("1990-05-17"));
    let grace = id_of(&w, "Grace");
    let held = |w: &World| {
        (
            w.one::<i64>(
                "SELECT COUNT(*) FROM person_date WHERE person_id = ?1",
                &[&grace],
            ),
            w.one::<i64>("SELECT COUNT(*) FROM reminder", &[]),
            w.one::<i64>("SELECT COUNT(*) FROM alert", &[]),
        )
    };
    assert_eq!(held(&w), (1, 0, 0), "a date arrives with no alert");
    pass(&w, "phone-1", true, records("1991-06-18"));
    assert_eq!(held(&w), (1, 0, 0), "a changed date is still silent");
    let date: String = w.one("SELECT id FROM person_date WHERE person_id = ?1", &[&grace]);
    w.ok(
        "reminder.add",
        json!({ "entity_id": &grace, "date_id": &date, "offset_min": 1440 }),
    );
    assert_eq!(
        w.one::<i64>("SELECT COUNT(*) FROM reminder", &[]),
        1,
        "the member asked"
    );
    pass(&w, "phone-1", true, records("1992-07-19"));
    assert_eq!(
        w.one::<i64>("SELECT COUNT(*) FROM reminder", &[]),
        1,
        "the follower neither adds to nor takes away the member's reminder"
    );
}
