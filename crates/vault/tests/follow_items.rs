//! A field made of items follows its source item by item (#1214, K9): an item the member did not
//! change takes the source's word, including its removal; one they added or removed stands. The
//! map's list here is a person's labels (`common::follow`), the engine's rule is the same for every
//! list a lane's map names.

mod common;

use centraid_vault::commands::follow::{Maps, differences_in};
use common::follow::{CONTACTS, Follow, TestMaps, contacts_origin};
use serde_json::json;

fn labels(f: &Follow, id: &str) -> Vec<String> {
    let text: Option<String> = f.maybe("SELECT nickname FROM person WHERE id = ?1", &[id]);
    let mut out: Vec<String> = text
        .unwrap_or_default()
        .split('|')
        .filter(|label| !label.is_empty())
        .map(str::to_owned)
        .collect();
    out.sort();
    out
}

fn read(f: &Follow, labels: &[&str]) {
    f.pass(
        CONTACTS,
        contacts_origin("icloud", "phone-1"),
        &[("c1", json!({ "title": "Ada", "labels": labels }))],
        true,
    );
}

#[test]
fn an_untouched_item_takes_the_sources_change_and_the_members_items_stand() {
    let f = Follow::new("items_merge");
    read(&f, &["friend", "work"]);
    let id = f.by_title("person", "Ada");
    assert_eq!(labels(&f, &id), ["friend", "work"]);

    // The member adds one and removes one.
    f.raw(&format!(
        "UPDATE person SET nickname = 'friend|mine' WHERE id = '{id}'"
    ));
    // The phone drops `friend`, keeps `work` (which the member removed) and adds `team`.
    read(&f, &["work", "team"]);
    // `friend` was untouched, so its removal follows; `mine` is the member's; `work` stays removed
    // (the member took it off); `team` is new and lands.
    assert_eq!(labels(&f, &id), ["mine", "team"]);
}

#[test]
fn the_differences_name_each_item_and_a_take_puts_one_item_back() {
    let f = Follow::new("items_take");
    read(&f, &["friend", "work"]);
    let id = f.by_title("person", "Ada");
    f.raw(&format!(
        "UPDATE person SET nickname = 'work|mine' WHERE id = '{id}'"
    ));
    let says = f
        .vault()
        .read(|c| differences_in(TestMaps::MAPS, c, &id))
        .expect("a read");
    assert_eq!(says.len(), 1, "{says:?}");
    assert_eq!(says[0].field, "labels");
    let keys: Vec<(&str, bool, bool)> = says[0]
        .items
        .iter()
        .map(|item| {
            (
                item.key.as_str(),
                item.stated.is_some(),
                item.held.is_some(),
            )
        })
        .collect();
    // `friend` the phone states and the member removed; `mine` the member added.
    assert_eq!(keys, [("friend", true, false), ("mine", false, true)]);

    // One item taken: the removed one comes back; the member's own stays.
    f.ok(
        "follow.take_stated",
        json!({ "entity": id, "field": "labels", "item_key": "friend" }),
    );
    assert_eq!(labels(&f, &id), ["friend", "mine", "work"]);
    // The whole field taken: the row says what the phone said.
    f.ok(
        "follow.take_stated",
        json!({ "entity": id, "field": "labels" }),
    );
    assert_eq!(labels(&f, &id), ["friend", "work"]);
    assert!(
        f.vault()
            .read(|c| differences_in(TestMaps::MAPS, c, &id))
            .expect("a read")
            .is_empty()
    );
    let sentence = f.refused(
        "follow.take_stated",
        json!({ "entity": id, "field": "labels", "item_key": "nonesuch" }),
    );
    assert!(sentence.contains("no `nonesuch`"), "{sentence}");
}
