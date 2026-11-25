//! People as vCards and spreadsheets (#1173, item 20; #1214): a file previewed with its merge
//! proposals and written only on confirmation, a second import that adds nothing, and an export
//! that reads back, with the organisation, role, given and family names and every date (a year or
//! none) surviving the round trip.

mod common;

use common::world::World as Base;
use serde_json::json;

struct World(Base);

impl World {
    fn new() -> Self {
        Self(Base::new("vcards"))
    }

    fn ok(&self, name: &str, input: serde_json::Value) -> serde_json::Value {
        self.0.ok(name, input)
    }

    fn count(&self, sql: &str) -> i64 {
        self.0.one::<i64>(sql, &[])
    }

    fn text(&self, name: &str, input: serde_json::Value) -> String {
        let out = self.ok(name, input);
        String::from_utf8(
            base64::Engine::decode(
                &base64::engine::general_purpose::STANDARD,
                out["content"].as_str().unwrap(),
            )
            .unwrap(),
        )
        .unwrap()
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
        w.count(&format!(
            "SELECT COUNT(*) FROM person WHERE id = '{maya}' AND role = 'Designer'"
        )),
        1
    );
    assert_eq!(
        w.count(&format!("SELECT COUNT(*) FROM person_date WHERE person_id = '{maya}' AND kind = 'birthday' AND date = '1990-05-17'")),
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
    assert_eq!(one["name"], "Ada-Lovelace.vcf");
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

/// TWO CARDS OF ONE NAME IN ONE FILE ARE ONE PERSON, and the second one's number is kept (#1202):
/// it used to be dropped with the card as "repeated".
#[test]
fn a_repeated_name_within_a_file_adds_its_points_to_the_first_card() {
    let w = World::new();
    let file = "BEGIN:VCARD\nVERSION:3.0\nFN:John Smith\nTEL:+1 555 010 0111\nEND:VCARD\nBEGIN:VCARD\nVERSION:3.0\nFN:JOHN SMITH\nTITLE:Plumber\nTEL:+1 555 010 0222\nTEL:+1 555 010 0111\nEND:VCARD\n";
    let preview = w.ok(
        "person.import_vcf",
        json!({ "cards": file, "dry_run": true }),
    );
    let written = w.ok("person.import_vcf", json!({ "cards": file }));
    for said in [&preview, &written] {
        assert_eq!(
            (
                said["cards"].as_i64(),
                said["added"].as_i64(),
                said["repeated"].as_i64()
            ),
            (Some(2), Some(1), Some(1)),
            "{said}"
        );
    }
    assert_eq!(
        w.count("SELECT COUNT(*) FROM entity WHERE kind = 'person' AND title = 'John Smith'"),
        1
    );
    assert_eq!(
        w.count("SELECT COUNT(*) FROM contact_point cp JOIN entity e ON e.id = cp.person_id WHERE e.title = 'John Smith'"),
        2,
        "both numbers, the shared one once"
    );
    assert_eq!(w.count("SELECT COUNT(*) FROM person p JOIN entity e ON e.id = p.id WHERE e.title = 'John Smith' AND p.role = 'Plumber'"), 1);
}

const FULL: &str = "BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Maya Rao\r\nN:Rao;Maya;;;\r\nORG:Acme\r\nTITLE:Designer\r\nBDAY:1990-05-17\r\nANNIVERSARY:--06-01\r\nX-ABDATE;LABEL=Graduation:2005-07-07\r\nTEL:+1 555 010 0100\r\nEND:VCARD\r\n";

fn dates(w: &World, title: &str) -> Vec<String> {
    w.0.strings(
        "SELECT d.kind || ':' || d.date || ':' || ifnull(d.label, '') FROM person_date d JOIN entity e ON e.id = d.person_id
          WHERE e.title = ?1 ORDER BY d.kind, d.date",
        &[title],
    )
}

#[test]
fn a_vcard_round_trips_org_title_given_family_and_every_date_and_arrives_as_an_import() {
    let w = World::new();
    w.ok(
        "person.import_vcf",
        json!({ "cards": FULL, "arrived_via": "vcard", "arrived_label": "contacts.vcf" }),
    );
    assert_eq!(
        w.0.one::<String>(
            "SELECT p.given || '|' || p.family || '|' || p.org || '|' || p.role || '|' || e.arrived_via || '|' || e.arrived_label
               FROM person p JOIN entity e ON e.id = p.id WHERE e.title = 'Maya Rao'",
            &[]
        ),
        "Maya|Rao|Acme|Designer|vcard|contacts.vcf"
    );
    assert_eq!(
        dates(&w, "Maya Rao"),
        [
            "anniversary:--06-01:",
            "birthday:1990-05-17:",
            "other:2005-07-07:Graduation"
        ]
    );
    assert_eq!(
        w.count("SELECT COUNT(*) FROM origin"),
        0,
        "an arrival is no origin"
    );
    assert_eq!(w.count("SELECT COUNT(*) FROM source"), 0);
    let text = w.text("person.export_vcf", json!({}));
    for line in [
        "N:Rao;Maya;;;",
        "ORG:Acme",
        "TITLE:Designer",
        "BDAY:1990-05-17",
        "ANNIVERSARY:--06-01",
        "X-ABDATE;LABEL=Graduation:2005-07-07",
    ] {
        assert!(text.contains(line), "{line} in {text}");
    }
    let other = World::new();
    other.ok("person.import_vcf", json!({ "cards": text }));
    assert_eq!(dates(&other, "Maya Rao"), dates(&w, "Maya Rao"));
    assert_eq!(
        other.0.one::<String>("SELECT given || family || org || role FROM person p JOIN entity e ON e.id = p.id WHERE e.title = 'Maya Rao'", &[]),
        "MayaRaoAcmeDesigner"
    );
    // A yearless birthday a card writes as --MMDD is the same day.
    other.ok(
        "person.import_vcf",
        json!({ "cards": "BEGIN:VCARD\nVERSION:4.0\nFN:Yearless\nBDAY:--0229\nEND:VCARD\n" }),
    );
    assert_eq!(dates(&other, "Yearless"), ["birthday:--02-29:"]);
}

#[test]
fn a_spreadsheet_round_trips_the_same_people_and_a_matching_row_only_adds() {
    let w = World::new();
    w.ok("person.import_vcf", json!({ "cards": FULL }));
    let csv = w.text("person.export_csv", json!({}));
    assert!(csv.starts_with("Name,Given name,Family name,"), "{csv}");
    let other = World::new();
    let said = other.ok(
        "person.import_csv",
        json!({ "csv": csv, "arrived_via": "csv", "arrived_label": "people.csv" }),
    );
    assert_eq!(said["added"], 1);
    assert_eq!(dates(&other, "Maya Rao"), dates(&w, "Maya Rao"));
    assert_eq!(
        other.0.one::<String>(
            "SELECT p.given || p.family || p.org || p.role || e.arrived_via FROM person p JOIN entity e ON e.id = p.id WHERE e.title = 'Maya Rao'",
            &[]
        ),
        "MayaRaoAcmeDesignercsv"
    );
    assert_eq!(other.count("SELECT COUNT(*) FROM contact_point"), 1);
    // The same file again adds nothing; a row that names someone fills only what they lack.
    let again = other.ok("person.import_csv", json!({ "csv": csv }));
    assert_eq!(
        (
            again["added"].as_i64(),
            again["merged"].as_i64(),
            again["unchanged"].as_i64()
        ),
        (Some(0), Some(0), Some(1))
    );
    other.ok("person.add", json!({ "title": "Sam" }));
    let sparse = "Name,Organization,Birthday\nSam,Initech,03-14\n";
    let said = other.ok("person.import_csv", json!({ "csv": sparse }));
    assert_eq!(said["merged"], 1);
    assert_eq!(dates(&other, "Sam"), ["birthday:--03-14:"]);
}
