//! Starting and stopping a followed store (#1214, K9). What a system fills, whether it can retire,
//! whether it names a device and which kinds it yields are rows of `origin_system` and
//! `source_shape`; the engine reads them, and the same rules are refused by the database itself
//! (`tests/schema_rules.rs` writes each with raw SQL).

mod common;

use common::follow::{
    CONTACTS, FILES, FILES_AS_PEOPLE, Follow, STATEMENT, TELEPATHY, contacts_origin, hash,
};
use serde_json::json;

fn file(title: &str, letter: char) -> serde_json::Value {
    json!({ "title": title, "blob": hash(letter), "media_type": "text/plain" })
}

fn folder_origin() -> serde_json::Value {
    json!({ "ref": "/Documents", "label": "Documents", "device_id": "phone-1" })
}

#[test]
fn following_a_store_makes_an_origin_with_the_home_its_system_fills() {
    let f = Follow::new("retire_start");
    // A folder fills a folder: the origin is made with one, titled by its label, and what the
    // store states sits in it.
    let out = f.pass(
        FILES,
        folder_origin(),
        &[("f1", file("notes.txt", 'a'))],
        true,
    );
    assert_eq!(out["added"].as_i64(), Some(1), "{out}");
    let origin = out["origin"].as_str().expect("an origin").to_owned();
    let home: String = f.one("SELECT fills FROM origin WHERE id = ?1", &[&origin]);
    assert_eq!(
        f.one::<String>("SELECT fills_kind FROM origin WHERE id = ?1", &[&origin]),
        "folder"
    );
    assert_eq!(
        f.one::<String>(
            "SELECT kind || ':' || title FROM entity WHERE id = ?1",
            &[&home]
        ),
        "folder:Documents"
    );
    let document = f.by_title("document", "notes.txt");
    assert_eq!(
        f.one::<String>("SELECT parent_id FROM entity WHERE id = ?1", &[&document]),
        home,
        "a document sits in the folder its origin fills"
    );
    // The system the origin is of is a seeded one, and its device is the phone's.
    assert_eq!(
        f.one::<String>(
            "SELECT system || ':' || device_id FROM origin WHERE id = ?1",
            &[&origin]
        ),
        "files:phone-1"
    );

    // A system that fills nothing makes no home.
    let out = f.pass(
        CONTACTS,
        contacts_origin("icloud", "phone-1"),
        &[("c1", json!({ "title": "Ada" }))],
        true,
    );
    let origin = out["origin"].as_str().expect("an origin");
    assert_eq!(
        f.maybe::<String>("SELECT fills FROM origin WHERE id = ?1", &[origin]),
        None
    );
}

#[test]
fn a_home_the_origin_names_is_the_kind_its_system_fills_and_is_kept() {
    let f = Follow::new("retire_home");
    let notebook = f.container(centraid_vault::model::Kind::Notebook, "Not a folder");
    let sentence = f.refused(
        FILES,
        f.pass_input(
            json!({ "ref": "/x", "label": "x", "device_id": "phone-1", "fills": notebook }),
            &[],
            true,
        ),
    );
    assert!(
        sentence.contains("folder") && sentence.contains("notebook"),
        "{sentence}"
    );
    let sentence = f.refused(
        CONTACTS,
        f.pass_input(
            json!({ "ref": "/x", "label": "x", "device_id": "phone-1", "fills": notebook }),
            &[],
            true,
        ),
    );
    assert!(sentence.contains("fills nothing"), "{sentence}");
    assert_eq!(
        f.count("SELECT COUNT(*) FROM origin", &[]),
        0,
        "nothing was written"
    );

    // A folder the member made is the home when the origin names it, and a later pass naming
    // another one is refused with a sentence: one origin, one home.
    let mine = f.container(centraid_vault::model::Kind::Folder, "Mine");
    let other = f.container(centraid_vault::model::Kind::Folder, "Other");
    let named =
        |home: &str| json!({ "ref": "/y", "label": "y", "device_id": "phone-1", "fills": home });
    f.pass(FILES, named(&mine), &[("f1", file("a.txt", 'a'))], true);
    let document = f.by_title("document", "a.txt");
    assert_eq!(
        f.one::<String>("SELECT parent_id FROM entity WHERE id = ?1", &[&document]),
        mine
    );
    let error = f
        .try_run(FILES, f.pass_input(named(&other), &[], true))
        .expect_err("another home is refused");
    assert!(
        error.to_string().contains("already fills another home"),
        "{error}"
    );
}

#[test]
fn a_pass_of_a_system_the_file_does_not_know_or_of_a_kind_it_does_not_yield_is_refused() {
    let f = Follow::new("retire_shapes");
    let origin = contacts_origin("icloud", "phone-1");
    let sentence = f.refused(
        TELEPATHY,
        f.pass_input(origin.clone(), &[("t1", json!({ "title": "Ada" }))], true),
    );
    assert!(sentence.contains("telepathy"), "{sentence}");
    // `files` yields a document, and the file says so: a map of it that fills a person is refused.
    let sentence = f.refused(
        FILES_AS_PEOPLE,
        f.pass_input(folder_origin(), &[("p1", json!({ "title": "Ada" }))], true),
    );
    assert!(sentence.contains("does not bring in person"), "{sentence}");
    assert_eq!(
        f.count("SELECT COUNT(*) FROM origin", &[])
            + f.count(
                "SELECT COUNT(*) FROM entity WHERE kind = 'person' AND title = 'Ada'",
                &[]
            ),
        0,
        "a refused pass writes nothing anywhere"
    );
}

#[test]
fn stop_retires_the_origin_and_following_the_same_ref_finds_it_and_its_sources() {
    let f = Follow::new("retire_stop");
    let out = f.pass(
        FILES,
        folder_origin(),
        &[("f1", file("a.txt", 'a')), ("f2", file("b.txt", 'b'))],
        true,
    );
    let origin = out["origin"].as_str().expect("an origin").to_owned();
    let home: String = f.one("SELECT fills FROM origin WHERE id = ?1", &[&origin]);
    f.pass(
        FILES,
        json!({ "ref": "/Documents", "label": "Documents", "device_id": "phone-1", "cursor": "token-1" }),
        &[],
        false,
    );
    assert_eq!(
        f.one::<String>("SELECT cursor FROM origin WHERE id = ?1", &[&origin]),
        "token-1"
    );

    let stopped = f.ok(
        "follow.stop",
        json!({ "system": "files", "ref": "/Documents" }),
    );
    assert_eq!(stopped["stopped"].as_bool(), Some(true));
    // RETIRED, not deleted: the row, its home and its sources stay; its cursor goes; the rows
    // the member kept are untouched.
    assert!(f.one::<bool>(
        "SELECT retired_at IS NOT NULL FROM origin WHERE id = ?1",
        &[&origin]
    ));
    assert_eq!(
        f.maybe::<String>("SELECT cursor FROM origin WHERE id = ?1", &[&origin]),
        None
    );
    assert_eq!(
        f.one::<String>("SELECT fills FROM origin WHERE id = ?1", &[&origin]),
        home
    );
    assert_eq!(
        f.count(
            "SELECT COUNT(*) FROM source WHERE origin_id = ?1",
            &[&origin]
        ),
        2
    );
    assert_eq!(
        f.count(
            "SELECT COUNT(*) FROM entity WHERE kind = 'document' AND deleted_at IS NULL",
            &[]
        ),
        2
    );
    // Stopping what is stopped is nothing.
    let again = f.ok(
        "follow.stop",
        json!({ "system": "files", "ref": "/Documents" }),
    );
    assert_eq!(again["stopped"].as_bool(), Some(false));
    // A retired origin follows nobody: "Phone says" has nothing to say.
    let a = f.by_title("document", "a.txt");
    let differences = f
        .vault()
        .read(|c| {
            centraid_vault::commands::follow::differences_in(
                <common::follow::TestMaps as centraid_vault::commands::follow::Maps>::MAPS,
                c,
                &a,
            )
        })
        .expect("a read");
    assert!(differences.is_empty());

    // Followed again by the same ref: the SAME origin, its home and its sources are found, no
    // second folder is made and no document is added twice.
    let out = f.pass(
        FILES,
        folder_origin(),
        &[("f1", file("a.txt", 'a')), ("f2", file("b.txt", 'b'))],
        true,
    );
    assert_eq!(out["origin"].as_str(), Some(origin.as_str()));
    assert_eq!(out["added"].as_i64(), Some(0), "{out}");
    assert_eq!(out["unchanged"].as_i64(), Some(2), "{out}");
    assert!(!f.one::<bool>(
        "SELECT retired_at IS NOT NULL FROM origin WHERE id = ?1",
        &[&origin]
    ));
    assert_eq!(
        f.count("SELECT COUNT(*) FROM entity WHERE kind = 'folder'", &[]),
        1
    );
    assert_eq!(
        f.count("SELECT COUNT(*) FROM entity WHERE kind = 'document'", &[]),
        2
    );
    assert_eq!(f.count("SELECT COUNT(*) FROM origin", &[]), 1);
}

#[test]
fn a_row_the_member_trashed_or_renamed_while_stopped_stays_as_they_left_it() {
    let f = Follow::new("retire_kept");
    f.pass(
        CONTACTS,
        contacts_origin("icloud", "phone-1"),
        &[
            ("c1", json!({ "title": "Ada", "given": "Ada" })),
            ("c2", json!({ "title": "Grace", "given": "Grace" })),
        ],
        true,
    );
    f.ok(
        "follow.stop",
        json!({ "system": "contacts", "ref": "icloud" }),
    );
    let (ada, grace) = (f.by_title("person", "Ada"), f.by_title("person", "Grace"));
    f.ok("entity.trash", json!({ "id": ada }));
    f.ok(
        "entity.retitle",
        json!({ "id": grace, "title": "Grace Hopper" }),
    );
    let out = f.pass(
        CONTACTS,
        contacts_origin("icloud", "phone-1"),
        &[
            ("c1", json!({ "title": "Ada", "given": "Ada" })),
            ("c2", json!({ "title": "Grace", "given": "Grace" })),
        ],
        true,
    );
    assert_eq!(out["added"].as_i64(), Some(0), "{out}");
    assert!(f.trashed(&ada), "a pass is not a restore");
    assert_eq!(
        f.one::<String>("SELECT title FROM entity WHERE id = ?1", &[&grace]),
        "Grace Hopper",
        "the member's rename stands"
    );
}

#[test]
fn a_system_that_cannot_retire_is_refused_with_a_sentence_and_nothing_stops() {
    let f = Follow::new("retire_cannot");
    let sentence = f.refused(
        "follow.stop",
        json!({ "system": "statement", "ref": "any" }),
    );
    assert!(
        sentence.contains("statement") && sentence.contains("no end"),
        "{sentence}"
    );
    let sentence = f.refused(
        "follow.stop",
        json!({ "system": "telepathy", "ref": "any" }),
    );
    assert!(
        sentence.contains("not a store this vault follows"),
        "{sentence}"
    );
}

#[test]
fn a_statement_is_an_accounts_one_origin_names_no_device_and_is_never_stopped() {
    let f = Follow::new("retire_statement");
    let line =
        |title: &str| json!({ "title": title, "posted_on": "2026-03-02", "amount_minor": -450 });
    // The account is the home, and an account has fields of its own: the member names it.
    let origin = |reference: &str, account: Option<&str>| json!({ "ref": reference, "label": "Everyday", "device_id": "phone-1", "fills": account });
    let sentence = f.refused(
        STATEMENT,
        f.pass_input(json!({ "ref": "bank", "label": "Everyday" }), &[], false),
    );
    assert!(sentence.contains("say which"), "{sentence}");
    let account = f.account();
    f.pass(
        STATEMENT,
        origin("9999-bank-number", Some(&account)),
        &[("ofx:1", line("COFFEE"))],
        false,
    );
    // No phone is named anywhere: a statement is not a phone store.
    assert_eq!(
        f.count(
            "SELECT COUNT(*) FROM origin WHERE device_id IS NOT NULL",
            &[]
        ),
        0
    );
    assert_eq!(
        f.count(
            "SELECT COUNT(*) FROM source WHERE device_id IS NOT NULL",
            &[]
        ),
        0
    );
    // One origin per account, whatever ref an import names, and the same line twice is one line.
    let again = f.pass(
        STATEMENT,
        origin("another-ref", Some(&account)),
        &[("ofx:1", line("COFFEE"))],
        false,
    );
    assert_eq!(again["added"].as_i64(), Some(0), "{again}");
    assert_eq!(
        f.count(
            "SELECT COUNT(*) FROM origin WHERE system = 'statement'",
            &[]
        ),
        1
    );
    assert_eq!(
        f.count("SELECT COUNT(*) FROM entity WHERE kind = 'txn'", &[]),
        1
    );
    // A later pass that does not name the account finds it by the origin's own ref.
    f.pass(
        STATEMENT,
        origin("9999-bank-number", None),
        &[("ofx:2", line("TEA"))],
        false,
    );
    assert_eq!(
        f.count("SELECT COUNT(*) FROM entity WHERE kind = 'txn'", &[]),
        2
    );
    // And it is never stopped.
    let sentence = f.refused(
        "follow.stop",
        json!({ "system": "statement", "ref": "9999-bank-number" }),
    );
    assert!(sentence.contains("no end"), "{sentence}");
    assert_eq!(f.count("SELECT COUNT(*) FROM source", &[]), 2);
}
