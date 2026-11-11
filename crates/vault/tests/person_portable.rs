//! People as vCards (#1173, item 20): a file previewed with its merge proposals and written
//! only on confirmation, a second import that adds nothing, and an export that reads back.

mod common;

use centraid_vault::commands::Registry;
use centraid_vault::{Command, CommandStatus, Principal};
use serde_json::json;

struct World {
    scratch: common::Scratch,
    registry: Registry,
}

impl World {
    fn new() -> Self {
        Self {
            scratch: common::Scratch::founded("vcards").expect("a vault"),
            registry: Registry::with_system_commands().expect("a registry"),
        }
    }

    fn ok(&self, name: &str, input: serde_json::Value) -> serde_json::Value {
        let outcome = self
            .scratch
            .vault
            .execute(
                &self.registry,
                &Principal::owner("phone"),
                &Command::new(name, input),
            )
            .expect("runs");
        assert_eq!(
            outcome.status,
            CommandStatus::Executed,
            "{name}: {:?}",
            outcome.reason
        );
        outcome.output
    }

    fn count(&self, sql: &str) -> i64 {
        self.scratch
            .vault
            .read(|c| Ok(c.query_row(sql, [], |r| r.get(0))?))
            .expect("a row")
    }
}

const FILE: &str = "BEGIN:VCARD\nVERSION:3.0\nFN:Maya Rao\nTITLE:Designer\nBDAY:1990-05-17\nTEL:+1 555 010 0100\nEMAIL:maya@example.com\nEND:VCARD\nBEGIN:VCARD\nVERSION:3.0\nFN:Sam Lee\nTEL:555-0199\nEND:VCARD\nBEGIN:VCARD\nVERSION:3.0\nFN:Someone Else\nTEL:+1 (555) 010-0100\nEND:VCARD\n";

#[test]
fn matches_are_proposals_nothing_is_written_until_confirmed_and_a_second_import_adds_nothing() {
    let w = World::new();
    let maya = w.ok("person.add", json!({ "title": "maya rao" }))["id"]
        .as_str()
        .unwrap()
        .to_owned();
    // Sam is in the vault under a number only the card shares.
    let sam = w.ok("person.add", json!({ "title": "S. Lee (work)" }))["id"]
        .as_str()
        .unwrap()
        .to_owned();
    w.ok(
        "person.save_contact_point",
        json!({ "id": sam, "kind": "phone", "value": "555 0199" }),
    );
    let before = w.count("SELECT COUNT(*) FROM person");

    let preview = w.ok(
        "person.import_vcf",
        json!({ "cards": FILE, "dry_run": true }),
    );
    assert_eq!(
        (
            preview["cards"].as_i64(),
            preview["added"].as_i64(),
            preview["merged"].as_i64(),
            preview["unchanged"].as_i64()
        ),
        // Maya matches by name and has more to give; "Sam Lee" matches S. Lee by his number and
        // has nothing to add; "Someone Else" is new.
        (Some(3), Some(1), Some(1), Some(1)),
        "{preview}"
    );
    assert_eq!(preview["proposals"][0], "Maya Rao");
    // A card matched by a number names the person it would merge into.
    assert!(preview["proposals"].as_array().unwrap().len() == 1);
    assert_eq!(
        w.count("SELECT COUNT(*) FROM person"),
        before,
        "a preview writes no one"
    );
    assert_eq!(
        w.count("SELECT COUNT(*) FROM contact_point"),
        1,
        "only Sam's own number"
    );

    // Declining the merges adds only the new person.
    let declined = w.ok(
        "person.import_vcf",
        json!({ "cards": FILE, "merge": false }),
    );
    assert_eq!(
        (declined["added"].as_i64(), declined["declined"].as_i64()),
        (Some(1), Some(1))
    );
    assert_eq!(w.count("SELECT COUNT(*) FROM person"), before + 1);
    assert_eq!(
        w.count(&format!(
            "SELECT COUNT(*) FROM contact_point WHERE person_id = '{maya}'"
        )),
        0,
        "the match was not merged"
    );

    // Confirming merges: Maya gains her role, birthday and points; nothing is replaced.
    let done = w.ok("person.import_vcf", json!({ "cards": FILE }));
    assert_eq!(
        (done["added"].as_i64(), done["merged"].as_i64()),
        (Some(0), Some(1))
    );
    assert_eq!(
        w.count("SELECT COUNT(*) FROM person"),
        before + 1,
        "no duplicates"
    );
    assert_eq!(
        w.count(&format!("SELECT COUNT(*) FROM person WHERE id = '{maya}' AND role = 'Designer' AND birthday = '1990-05-17'")),
        1
    );
    assert_eq!(
        w.count(&format!(
            "SELECT COUNT(*) FROM contact_point WHERE person_id = '{maya}'"
        )),
        2
    );

    // And again: nothing new.
    let again = w.ok("person.import_vcf", json!({ "cards": FILE }));
    assert_eq!(
        (
            again["added"].as_i64(),
            again["merged"].as_i64(),
            again["unchanged"].as_i64()
        ),
        (Some(0), Some(0), Some(3)),
        "the third card is now the person the first import made"
    );
}

#[test]
fn an_export_is_a_vcf_that_reads_back_and_a_list_is_its_own_file() {
    let w = World::new();
    w.ok("person.import_vcf", json!({ "cards": FILE }));
    let all = w.ok("person.export_vcf", json!({}));
    assert_eq!(all["name"], "People.vcf");
    let text = String::from_utf8(
        base64::Engine::decode(
            &base64::engine::general_purpose::STANDARD,
            all["content"].as_str().unwrap(),
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(text.matches("BEGIN:VCARD").count(), 3);
    assert!(text.contains("FN:Maya Rao") && text.contains("BDAY:1990-05-17"));
    // Exporting then importing into a fresh vault is the same people.
    let other = World::new();
    let back = other.ok("person.import_vcf", json!({ "cards": text }));
    assert_eq!(back["added"], 3);
}

#[test]
fn one_person_is_their_own_card_named_for_them() {
    let w = World::new();
    w.ok("person.import_vcf", json!({ "cards": FILE }));
    let who = w.ok("person.add", json!({ "title": "Ada Lovelace" }));
    let id = who["id"].as_str().expect("an id").to_owned();
    let one = w.ok("person.export_vcf", json!({ "person_id": id }));
    assert_eq!(one["name"], "Ada Lovelace.vcf");
    assert_eq!(one["count"], 1);
    let text = String::from_utf8(
        base64::Engine::decode(
            &base64::engine::general_purpose::STANDARD,
            one["content"].as_str().unwrap(),
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(text.matches("BEGIN:VCARD").count(), 1);
    assert!(text.contains("FN:Ada Lovelace") && !text.contains("Maya Rao"));
    let none = w.ok("person.export_vcf", json!({ "person_id": "nobody" }));
    assert_eq!(none["count"], 0);
}
