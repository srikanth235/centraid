//! ONE INDEPENDENT DENIAL, ONE TYPE (D-1020-PE1).
//!
//! v0 made one of People's sharing questions independent: the share plane was
//! caught and answered `null`, and everything else sat in one `Promise.all` under
//! one `try`, so revoking a scope over ANOTHER APP's table answered
//! `{person: null}` and the member lost their grandfather's birthday because they
//! uninstalled the other app. (That app and the share plane are both gone, #1099
//! and #1029; the claim stands for the one reading that is left.)
//!
//! This suite is the proof that the port does not. It runs the real queries
//! through a door that refuses one plane at a time, and asserts:
//!
//! 1. the profile stands, with its name, cadence and dates intact;
//! 2. the refused reading carries the door's own sentence;
//! 3. **a denied reading is unrepresentable as empty** — the data lives
//!    inside `ReadState::Ready`, so there is no `null` for a rail to be drawn on
//!    and no `relationships: []` or `contact: []` to be mistaken for "linked to
//!    nothing" or "no way to reach them";
//! 4. the two readings are independent of each other: revoking one costs that
//!    rail and not the other.
//!
//! `social.contact_channel` is the second reading (P1, `docs/release/v1-handoffs.md`):
//! it used to deny the whole sheet, on the argument that how to reach a person
//! is part of who the sheet is about. A sheet that says the channels could not
//! be read is not a lie; one that drew "No channels" would be, and the type is
//! what stops it.

use std::fs;
use std::path::{Path, PathBuf};

use centraid_apps_kit::contract_vault::{FrozenRowMapping, open_contract_vault_without};
use centraid_apps_kit::error::{KitError, KitResult};
use centraid_apps_kit::page::{Page, PageRequest};
use centraid_apps_kit::reads::PageDoor;
use centraid_apps_kit::row::Row;
use centraid_apps_kit::statement::PageQuery;
use centraid_apps_kit::testdoor::TestDoor;
use centraid_apps_people::person::load_person;
use centraid_apps_people::roster::{PeopleInput, load_people};
use centraid_apps_people::{Denial, ReadState};

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("..")
        .to_path_buf()
}

fn fixture_vault() -> rusqlite::Connection {
    let ddl = fs::read_to_string(root().join("contracts/schema/vault-ddl.sql"))
        .expect("the committed DDL is readable");
    let rows = fs::read_to_string(root().join("contracts/apps/people/rows.json"))
        .expect("the committed rows are readable");
    open_contract_vault_without(
        &ddl,
        &rows,
        // THE MAPPING, stated: the frozen bundle still carries v0's
        // `share_party_vault_binding` rows, which rung five drops (#1029), and
        // `tally_obligation` rows, which rung fifteen drops (#1099).
        &FrozenRowMapping {
            tables_gone: &["share_party_vault_binding", "tally_obligation"],
            columns_gone: &[],
            columns_added: &[],
        },
    )
    .expect("the fixture vault is built")
}

/// A door that refuses every statement reading a named table, the way a revoked
/// scope refuses at the gateway.
///
/// **A refusal is a `KitError::Door`, which is what the app lowers onto a
/// denial** — not a panic and not an empty page. A door that answered zero rows
/// would be testing the thing this app exists to keep apart.
struct RevokedDoor<'connection> {
    inner: TestDoor<'connection>,
    revoked: &'static [&'static str],
}

impl PageDoor for RevokedDoor<'_> {
    fn page(&self, query: &PageQuery, request: &PageRequest) -> KitResult<Page<Row>> {
        if self
            .revoked
            .iter()
            .any(|table| query.from == *table || query.from.starts_with(&format!("{table} ")))
        {
            return Err(KitError::Door(format!(
                "the owner has not granted this app access to {}",
                query.from
            )));
        }
        self.inner.page(query, request)
    }
}

fn door<'connection>(
    connection: &'connection rusqlite::Connection,
    revoked: &'static [&'static str],
) -> RevokedDoor<'connection> {
    RevokedDoor {
        inner: TestDoor::new(connection),
        revoked,
    }
}

/// The party the fixture's corpus is richest on.
fn a_person_with_everything(connection: &rusqlite::Connection) -> String {
    let door = TestDoor::new(connection);
    let (data, denial) =
        load_people(&door, PeopleInput { limit: Some(100) }).expect("the roster reads");
    assert!(denial.is_none());
    data.people
        .iter()
        .find(|row| row.name.contains("Maya"))
        .map(|row| row.party_id.clone())
        .expect("the corpus carries Maya Alvarez")
}

/// THE LINKED PLANE: relationships, tasks, gift ideas and the interaction rail
/// all hang off `core_link`, and revoking it costs those rails — not the person.
#[test]
fn a_denied_linked_plane_costs_the_relationship_rail_and_nothing_else() {
    let connection = fixture_vault();
    let party_id = a_person_with_everything(&connection);
    let door = door(&connection, &["core_link"]);

    let (data, denial) = load_person(&door, &party_id).expect("the sheet reads");
    assert!(denial.is_none());
    let person = data.person.expect("the person is still there");
    assert_eq!(person.profile.name, "Maya Alvarez");
    assert!(person.links.denied());
    assert!(person.links.ready().is_none());
}

/// THE CONTACT PLANE (P1): revoking `social.contact_channel` costs the contact
/// rail — which says so, in the door's own sentence — and not the person.
#[test]
fn a_denied_contact_plane_costs_the_contact_rail_and_nothing_else() {
    let connection = fixture_vault();
    let party_id = a_person_with_everything(&connection);
    let door = door(&connection, &["social_contact_channel"]);

    let (data, denial) = load_person(&door, &party_id).expect("the sheet reads");
    // A DENIED RAIL IS NOT A DENIED SHEET.
    assert!(denial.is_none(), "{denial:?}");
    let person = data.person.expect("the person is still there");
    assert_eq!(person.profile.name, "Maya Alvarez");
    assert_eq!(person.profile.cadence_days, 30);
    assert!(
        !person.profile.dates.is_empty(),
        "the person's dates stand: they are not behind the contact plane"
    );
    // THE RAIL SAYS IT COULD NOT BE READ, in the door's own sentence, and has no
    // list to be drawn as empty.
    assert!(person.contact.denied());
    assert!(person.contact.ready().is_none());
    assert!(
        person
            .contact
            .denial()
            .and_then(|denial| denial.message.as_deref())
            .is_some_and(|message| message.contains("social_contact_channel")),
        "the denial names the plane: {:?}",
        person.contact.denial()
    );
    // THE OTHER READING IS UNTOUCHED: the linked plane sits behind other scopes.
    assert!(person.links.known());
}

/// THE TWO READINGS ARE INDEPENDENT: each plane revoked alone leaves the other
/// known, and both revoked together still leave the person.
#[test]
fn the_contact_and_linked_readings_deny_independently_of_each_other() {
    let connection = fixture_vault();
    let party_id = a_person_with_everything(&connection);

    let linked_only = door(&connection, &["core_link"]);
    let (data, denial) = load_person(&linked_only, &party_id).expect("the sheet reads");
    assert!(denial.is_none());
    let person = data.person.expect("the person is still there");
    assert!(person.links.denied());
    assert!(
        person.contact.known(),
        "revoking the linked plane costs the relationship rail, not the channels"
    );
    assert!(
        person
            .contact
            .ready()
            .is_some_and(|contact| !contact.is_empty()),
        "Maya has channels in the corpus, and they are drawn"
    );

    let both = door(&connection, &["core_link", "social_contact_channel"]);
    let (data, denial) = load_person(&both, &party_id).expect("the sheet reads");
    assert!(denial.is_none());
    let person = data.person.expect("the person is still there");
    assert_eq!(person.profile.name, "Maya Alvarez");
    assert!(person.links.denied());
    assert!(person.contact.denied());
}

/// A refusal of the COLLISION SEARCH alone is the contact reading's too: the
/// search is part of the rail, so a half-drawn rail with its duplicate notes
/// missing would be the quiet failure this type exists to prevent.
#[test]
fn a_refusal_after_the_channels_were_read_still_denies_the_whole_rail() {
    struct SecondReadRefused<'connection> {
        inner: TestDoor<'connection>,
        seen: std::cell::Cell<u32>,
    }
    impl PageDoor for SecondReadRefused<'_> {
        fn page(&self, query: &PageQuery, request: &PageRequest) -> KitResult<Page<Row>> {
            if query.from.starts_with("social_contact_channel") {
                let nth = self.seen.get();
                self.seen.set(nth + 1);
                // THE FIRST CHANNEL READ (this person's own) answers; the
                // collision search over the same table is refused.
                if nth >= 1 {
                    return Err(KitError::Door(
                        "the owner has not granted this app access to the collision search"
                            .to_owned(),
                    ));
                }
            }
            self.inner.page(query, request)
        }
    }
    let connection = fixture_vault();
    let party_id = a_person_with_everything(&connection);
    let door = SecondReadRefused {
        inner: TestDoor::new(&connection),
        seen: std::cell::Cell::new(0),
    };
    let (data, denial) = load_person(&door, &party_id).expect("the sheet reads");
    assert!(denial.is_none());
    let person = data.person.expect("the person is still there");
    assert!(person.contact.denied(), "{:?}", person.contact);
    assert!(
        door.seen.get() >= 2,
        "the test never reached the collision search"
    );
}

/// A DENIAL IS NEVER AN EMPTY ANSWER. The type makes the two different values,
/// and this is the assertion that says so without a door at all.
#[test]
fn an_empty_reading_and_a_denied_one_are_different_values() {
    let empty: ReadState<Vec<u8>> = ReadState::Ready(Vec::new());
    let denied: ReadState<Vec<u8>> = ReadState::Denied(Denial::default());
    assert_ne!(empty, denied);
    assert!(empty.known());
    assert!(!denied.known());
    assert_eq!(empty.ready().map(Vec::len), Some(0));
    assert_eq!(denied.ready(), None);
}
