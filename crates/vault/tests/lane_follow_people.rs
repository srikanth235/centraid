//! What the old `lane_follow_*` files said of the phone's contacts, on the v0 engine (#1214): a
//! contact's points follow item by item, the owner is nobody's record, a read that lost most of
//! what is followed is doubted, a returned record restores its row, and another phone re-finds a
//! purged person's tombstone. (The rest of those files is other lanes'.)

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
