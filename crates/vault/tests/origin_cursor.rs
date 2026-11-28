//! Where a read of a phone's store got to (#1183, #1214 K9): a cursor lives on the store's `origin`
//! row beside the install that wrote it, moves only in the commit of the records it covers, and is
//! cleared when the follow stops. The database holds the same rules (`tests/schema_rules.rs`).

mod common;

use centraid_vault::commands::origin_cursor;
use common::follow::{CONTACTS, Follow, ROLL, hash};
use serde_json::json;

const REF: &str = "Camera roll";

fn roll_origin(device: &str, cursor: Option<&str>) -> serde_json::Value {
    let mut origin = json!({ "ref": REF, "label": REF, "device_id": device });
    if let Some(cursor) = cursor {
        origin["cursor"] = json!(cursor);
    }
    origin
}

fn pass(f: &Follow, device: &str, cursor: &str, photos: &[&str]) -> serde_json::Value {
    let records: Vec<(&str, serde_json::Value)> = photos
        .iter()
        .map(|id| (*id, json!({ "blob": hash('a') })))
        .collect();
    f.pass(ROLL, roll_origin(device, Some(cursor)), &records, false)
}

fn held(f: &Follow, device: &str) -> Option<String> {
    f.vault()
        .read(|c| origin_cursor::read(c, "camera_roll", REF, device))
        .expect("a read")
}

fn cursor(f: &Follow) -> Option<String> {
    f.maybe(
        "SELECT cursor FROM origin WHERE system = 'camera_roll'",
        &[],
    )
}

#[test]
fn a_pass_and_the_cursor_past_it_are_one_commit_and_the_origin_names_the_install() {
    let f = Follow::new("cursor_one_commit");
    pass(&f, "phone-1", "token-1", &["p1"]);
    assert_eq!(cursor(&f).as_deref(), Some("token-1"));
    assert_eq!(
        f.count("SELECT COUNT(*) FROM entity WHERE kind = 'photo'", &[]),
        1
    );
    assert_eq!(
        f.one::<String>(
            "SELECT device_id FROM origin WHERE system = 'camera_roll'",
            &[]
        ),
        "phone-1"
    );
    // The cursor is the word of the install that wrote it: it is told to that one only.
    assert_eq!(held(&f, "phone-1").as_deref(), Some("token-1"));
    assert_eq!(
        held(&f, "phone-2"),
        None,
        "another install does a complete read"
    );
    assert_eq!(held(&f, ""), None);

    // A pass the vault refuses leaves the cursor and the records where they were: the bytes it
    // names are not a hash, so the whole commit is undone.
    let refused = f.try_run(
        ROLL,
        f.pass_input(
            roll_origin("phone-1", Some("token-2")),
            &[("p2", json!({ "blob": "not-a-hash" }))],
            false,
        ),
    );
    assert!(refused.is_err(), "the pass is refused");
    assert_eq!(cursor(&f).as_deref(), Some("token-1"));
    assert_eq!(
        f.count("SELECT COUNT(*) FROM entity WHERE kind = 'photo'", &[]),
        1
    );
}

#[test]
fn another_install_takes_the_origin_over_and_a_pass_that_names_no_cursor_forgets_the_old_one() {
    let f = Follow::new("cursor_takeover");
    pass(&f, "phone-1", "token-1", &["p1"]);
    // The same install again with no cursor keeps its own.
    f.pass(ROLL, roll_origin("phone-1", None), &[], false);
    assert_eq!(cursor(&f).as_deref(), Some("token-1"));
    // Another install reads, with a position of its own: the origin is now its.
    pass(&f, "phone-2", "token-9", &[]);
    assert_eq!(cursor(&f).as_deref(), Some("token-9"));
    assert_eq!(held(&f, "phone-1"), None);
    assert_eq!(held(&f, "phone-2").as_deref(), Some("token-9"));
    // A third install that reads with no position takes the origin and trusts nobody's.
    f.pass(ROLL, roll_origin("phone-3", None), &[], false);
    assert_eq!(cursor(&f), None);
    assert_eq!(
        f.one::<String>(
            "SELECT device_id FROM origin WHERE system = 'camera_roll'",
            &[]
        ),
        "phone-3"
    );
}

#[test]
fn a_cursor_with_no_record_moves_alone_and_is_idempotent() {
    let f = Follow::new("cursor_alone");
    let advance = |device: &str, cursor: &str| {
        f.ok(
            "follow.advance_cursor",
            json!({ "system": "health", "ref": "Health", "device_id": device, "cursor": cursor }),
        )
    };
    advance("phone-1", "a1");
    advance("phone-1", "a1");
    assert_eq!(
        f.count("SELECT COUNT(*) FROM origin WHERE system = 'health'", &[]),
        1
    );
    let read = |device: &str| {
        f.vault()
            .read(|c| origin_cursor::read(c, "health", "Health", device))
            .expect("a read")
    };
    assert_eq!(read("phone-1").as_deref(), Some("a1"));
    advance("phone-1", "a2");
    assert_eq!(read("phone-1").as_deref(), Some("a2"));
    advance("phone-2", "b1");
    assert_eq!(read("phone-1"), None);
    assert_eq!(read("phone-2").as_deref(), Some("b1"));

    // A cursor is a phone store's: a system that names no device holds none, and the file says
    // which those are.
    let sentence = f.refused(
        "follow.advance_cursor",
        json!({ "system": "statement", "ref": "x", "device_id": "phone-1", "cursor": "c" }),
    );
    assert!(sentence.contains("phone store"), "{sentence}");
    let sentence = f.refused(
        "follow.advance_cursor",
        json!({ "system": "telepathy", "ref": "x", "device_id": "phone-1", "cursor": "c" }),
    );
    assert!(sentence.contains("not a store"), "{sentence}");
    // A pass that names a cursor and no install is refused: a cursor is one install's word.
    let sentence = f.refused(
        CONTACTS,
        f.pass_input(
            json!({ "ref": "icloud", "label": "icloud", "cursor": "c" }),
            &[],
            false,
        ),
    );
    assert!(
        sentence.contains("a cursor is a phone store's"),
        "{sentence}"
    );
}

#[test]
fn stop_clears_the_cursor_and_a_stray_batch_after_it_neither_writes_one_nor_revives_the_origin() {
    let f = Follow::new("cursor_stop");
    pass(&f, "phone-1", "token-1", &["p1"]);
    f.ok(
        "follow.stop",
        json!({ "system": "camera_roll", "ref": REF }),
    );
    assert_eq!(cursor(&f), None);
    assert!(f.one::<bool>(
        "SELECT retired_at IS NOT NULL FROM origin WHERE system = 'camera_roll'",
        &[]
    ));
    // A cursor that was still on its way: it must not write a position nobody read to.
    f.ok(
        "follow.advance_cursor",
        json!({ "system": "camera_roll", "ref": REF, "device_id": "phone-1", "cursor": "stray" }),
    );
    assert_eq!(cursor(&f), None);
    assert!(f.one::<bool>(
        "SELECT retired_at IS NOT NULL FROM origin WHERE system = 'camera_roll'",
        &[]
    ));
    assert_eq!(
        held(&f, "phone-1"),
        None,
        "a retired origin is told to nobody"
    );
    // Followed again, the store starts with a complete read: its old position is gone.
    f.pass(ROLL, roll_origin("phone-1", None), &[], false);
    assert_eq!(cursor(&f), None);
    assert_eq!(held(&f, "phone-1"), None);
    assert_eq!(
        f.count(
            "SELECT COUNT(*) FROM origin WHERE system = 'camera_roll'",
            &[]
        ),
        1
    );
}
