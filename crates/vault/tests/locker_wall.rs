//! LOCKER IS AN ORDINARY APP (#1214, K1, K2, K4, K6, K10): a Locker item is a link end, a
//! `[[title]]` target, taggable, holds attachments and is listed on a person's page like any
//! item; no Locker branch is in the links or the edges; the "hidden from every door that is not
//! Locker's" rule is gone. What stays different is sealing, and take-out: an item has no share,
//! "Export everything" leaves Locker out, and its contents leave only through Locker's own export,
//! which refuses on a phone with no passcode. (The unlock wall in front of opening Locker is a
//! screen's: the vault exposes the failed-unlock count and the stamps, proved in
//! `locker_commands.rs`.)

mod common;

use centraid_vault::links;
use centraid_vault::model::Kind;
use common::locker::{add, item_id, plain, secret, world};
use serde_json::json;

#[test]
fn an_item_is_linked_mentioned_tagged_attached_and_listed_on_a_persons_page_like_any_item() {
    let w = world("locker_ordinary");
    let item = item_id(&w);
    add(
        &w,
        &item,
        "login",
        "Acme Bank",
        vec![
            plain("username", "me"),
            secret(&w, &item, "password", "s3cret"),
        ],
    );
    let ada = w.person("Ada");
    let note = w.ok(
        "note.create",
        json!({ "title": "Money", "body": "Where I bank: [[Acme Bank]]" }),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    // A `[[title]]` resolves to the item, and the page of the item lists the note that says it.
    assert_eq!(
        w.one::<String>("SELECT to_id FROM mention WHERE note_id = ?1", &[&note]),
        item
    );
    let linked = |id: &str| w.vault().read(|c| links::linked(c, id)).unwrap();
    assert!(linked(&item).iter().any(|l| l.id == note && l.in_text));
    // A hand link, from either end.
    w.ok("link.add", json!({ "a": item, "b": ada }));
    assert!(linked(&item).iter().any(|l| l.id == ada));
    assert!(
        linked(&ada).iter().any(|l| l.id == item),
        "listed on the person's page"
    );
    w.ok("link.remove", json!({ "a": ada, "b": item }));
    assert!(!linked(&item).iter().any(|l| l.id == ada));
    // `with` a person and `about` anything, like a note or a task.
    w.ok(
        "edge.add",
        json!({ "from": item, "rel": "with", "to": ada }),
    );
    w.ok(
        "edge.add",
        json!({ "from": item, "rel": "about", "to": note }),
    );
    assert_eq!(
        w.one::<i64>(
            "SELECT COUNT(*) FROM edge WHERE from_id = ?1 AND rel IN ('with', 'about')",
            &[&item]
        ),
        2
    );
    // Tagged, starred, archived and re-titled by the shared verbs.
    w.ok("tag.add", json!({ "id": item, "label": "banking" }));
    w.ok("flag.set", json!({ "id": item, "flag": "pinned" }));
    w.ok(
        "entity.retitle",
        json!({ "id": item, "title": "Acme Savings" }),
    );
    assert_eq!(
        w.one::<i64>(
            "SELECT COUNT(*) FROM edge WHERE from_id = ?1 AND rel = 'tagged'",
            &[&item]
        ),
        1
    );
    // An attached document or photo is an ordinary item, never sealed.
    let scan = w.made(Kind::Document, "Statement scan");
    let photo = w.made(Kind::Photo, "Card photo");
    w.ok(
        "edge.add",
        json!({ "from": item, "rel": "attached", "to": scan }),
    );
    w.ok(
        "edge.add",
        json!({ "from": item, "rel": "attached", "to": photo }),
    );
    assert_eq!(
        w.strings(
            "SELECT e.kind FROM edge a JOIN entity e ON e.id = a.to_id
              WHERE a.from_id = ?1 AND a.rel = 'attached' ORDER BY e.kind",
            &[&item]
        ),
        ["document", "photo"]
    );
    // A page over `entity` or `edge` serves the item like any other (no Locker exclusion)...
    let page = |name: &str, from: &str, select: &[&str], sort: &str, pk: &str| {
        w.vault()
            .keyset_page(&centraid_vault::page::KeysetPage {
                name: name.to_owned(),
                select: select.iter().map(|c| (*c).to_owned()).collect(),
                from: from.to_owned(),
                predicate: None,
                binds: Vec::new(),
                sort_column: sort.to_owned(),
                pk_column: pk.to_owned(),
                descending: false,
                limit: 200,
                after: None,
                held_thumbnail: false,
                document_size: false,
            })
            .expect("served")
    };
    let entities = format!(
        "{:?}",
        page(
            "generic.entities",
            "entity",
            &["id", "kind", "title"],
            "id",
            "id"
        )
        .rows
    );
    assert!(entities.contains("Acme Savings"));
    let edges = format!(
        "{:?}",
        page(
            "generic.edges",
            "edge",
            &["from_id", "to_id"],
            "from_id",
            "to_id"
        )
        .rows
    );
    assert!(edges.contains(&item));
    // ...and a plain field is a plain column anyone may read, while a sealed column is named by
    // its presence only.
    let fields = page(
        "generic.fields",
        "locker_item_field",
        &["id", "label", "value_sealed IS NOT NULL AS sealed"],
        "id",
        "id",
    );
    assert!(!format!("{:?}", fields.rows).contains("lk1:"));
}

#[test]
fn links_and_edges_have_no_locker_branch() {
    for file in ["src/links.rs", "src/commands/edge.rs"] {
        let text =
            std::fs::read_to_string(format!("{}/{file}", env!("CARGO_MANIFEST_DIR"))).unwrap();
        for word in [
            "locker_item",
            "LockerItem",
            "locker_exclusion",
            "reaches_locker",
        ] {
            assert!(
                !text.contains(word),
                "{file} still branches on Locker: `{word}`"
            );
        }
    }
    let page =
        std::fs::read_to_string(format!("{}/src/page.rs", env!("CARGO_MANIFEST_DIR"))).unwrap();
    assert!(!page.contains("locker_exclusion") && !page.contains("pub fn reaches_locker"));
}

#[test]
fn an_items_contents_leave_only_through_lockers_own_export_which_needs_a_passcode() {
    let w = world("locker_takeout");
    let item = item_id(&w);
    add(
        &w,
        &item,
        "login",
        "Bank",
        vec![
            plain("username", "me"),
            secret(&w, &item, "password", "s3cret"),
        ],
    );
    // Confirmed, and refused on a phone with no passcode, in a sentence.
    let sentence = w.refused(
        "locker.export",
        json!({ "confirm": true, "device_passcode": false }),
    );
    assert!(sentence.contains("passcode"), "{sentence}");
    let out = w.ok(
        "locker.export",
        json!({ "confirm": true, "device_passcode": true }),
    );
    assert_eq!(out["item_count"], 1);
    let first = &out["items"][0]["fields"];
    assert!(
        first.to_string().contains("lk1:"),
        "a secret leaves as ciphertext for the core to open"
    );
    assert!(!out.to_string().contains("s3cret"));
    // It stamps no item: a file is not a use.
    assert!(
        w.one::<Option<String>>(
            "SELECT last_used_at FROM locker_item WHERE id = ?1",
            &[&item]
        )
        .is_none()
    );
    // The commands' own schema requires the confirmation.
    let unconfirmed = w.vault().execute(
        &w.registry,
        &centraid_vault::Principal::owner("phone"),
        &centraid_vault::Command::new(
            "locker.export",
            json!({ "confirm": false, "device_passcode": true }),
        ),
    );
    assert!(
        unconfirmed.is_err()
            || unconfirmed.unwrap().status != centraid_vault::CommandStatus::Executed
    );
    // "Export everything" leaves Locker out: nothing in it reads a Locker table, and an item is
    // not handed to the share sheet (no command or read of the vault serves one for sharing).
    let everything = std::fs::read_to_string(format!(
        "{}/src/commands/vault_export.rs",
        env!("CARGO_MANIFEST_DIR")
    ))
    .unwrap();
    assert!(
        !everything.contains("FROM locker_") && !everything.contains("JOIN locker_"),
        "the whole-vault export reads a Locker table"
    );
}
