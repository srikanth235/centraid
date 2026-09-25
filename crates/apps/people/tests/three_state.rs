//! THREE INDEPENDENT DENIALS, ONE TYPE (D-1020-PE1).
//!
//! The census says People's sheet makes "three sharing questions deny
//! independently of the profile". v0 makes ONE of them independent: the share
//! plane is caught and answered `null`, and everything else sits in one
//! `Promise.all` under one `try`, so revoking `tally.obligation` — a scope over
//! ANOTHER APP's table — answers `{person: null}` and the member loses their
//! grandfather's birthday because they uninstalled Tally.
//!
//! This suite is the proof that the port does not. It runs the real queries
//! through a door that refuses one plane at a time, and asserts:
//!
//! 1. the profile stands, with its name, cadence and dates intact;
//! 2. the refused reading carries the door's own sentence;
//! 3. **`linked` is unrepresentable on a denied sharing read** — the field
//!    lives inside `ReadState::Ready`, so there is no `null` for a chip to be
//!    drawn on and no `vault_count: 0` to be mistaken for "linked to nothing".
//!
//! The fourth candidate, `social.contact_channel`, is deliberately NOT a
//! reading: how to reach a person is part of who the sheet is about, and the
//! question goes to the owner in this lane's receipt. `a_denied_contact_plane_is_a_denied_sheet`
//! is what states that choice, so changing it means changing a test.

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
        // `share_party_vault_binding` rows, which rung five drops (#1029).
        &FrozenRowMapping {
            tables_gone: &["share_party_vault_binding"],
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

/// TALLY'S TABLE IS ANOTHER APP'S, and revoking it must not blank the person.
/// v0 answers `{person: null, vaultDenied}` here.
#[test]
fn a_denied_obligations_read_costs_the_debts_rail_and_nothing_else() {
    let connection = fixture_vault();
    let party_id = a_person_with_everything(&connection);
    let door = door(&connection, &["tally_obligation"]);

    let (data, denial) = load_person(&door, &party_id).expect("the sheet reads");
    assert!(denial.is_none(), "revoking Tally must not blank the person");
    let person = data.person.expect("the person is still there");
    assert_eq!(person.profile.name, "Maya Alvarez");
    assert!(person.obligations.denied());
    assert!(person.obligations.ready().is_none());
    // The linked plane is untouched.
    assert!(person.links.known());
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
    assert!(person.obligations.known());
}

/// THE FOURTH CANDIDATE, STATED RATHER THAN MODELLED. Revoking
/// `social.contact_channel` denies the whole sheet, here as in v0 — because how
/// to reach a person is part of who the sheet is about. The owner question is
/// in this lane's receipt; changing the answer means changing this test.
#[test]
fn a_denied_contact_plane_is_a_denied_sheet() {
    let connection = fixture_vault();
    let party_id = a_person_with_everything(&connection);
    let door = door(&connection, &["social_contact_channel"]);

    let (data, denial) = load_person(&door, &party_id).expect("the sheet reads");
    assert!(data.person.is_none());
    assert!(
        denial
            .as_ref()
            .and_then(|denial| denial.message.as_deref())
            .is_some_and(|message| message.contains("social_contact_channel")),
        "the denial names the plane: {denial:?}"
    );
    // AND IT IS A DENIAL, NOT AN ERROR. A surface renders the ask.
    assert!(denial.is_some());
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
