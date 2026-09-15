//! THE TEST DOOR over the REPLICATED tables — questions a test asks about a
//! copy of a vault, in the crate that owns the schema (#1025 S5).
//!
//! ## Why it exists
//!
//! `sql-confinement` (`cargo xtask rules`) refuses SQL outside
//! `crates/{ontology,vault,seat,search}` and `crates/apps/kit`, and the refusal
//! is the point: a query written somewhere else is a crate reaching past its
//! layer, and a test is not an exemption — a test that hand-writes
//! `SELECT … FROM core_party` is a second, unversioned opinion about a schema
//! this crate owns, and it goes stale the first time a column moves.
//!
//! S1–S4 built the seat's end-to-end tests with the statements inline and the
//! rule went red. These are those questions, moved here and **named for the
//! question rather than for the SQL**, so the call site reads as the assertion
//! it is: `assert_eq!(vault_rows(connection), 1)` says what
//! `query_row("SELECT COUNT(*) FROM core_vault", …)` only implied.
//!
//! ## Why a plain `pub mod` and not a cargo feature
//!
//! `crates/apps/kit/src/testdoor.rs` is the precedent and it is an ungated
//! `pub mod`. A feature would not do what it looks like it does here: cargo
//! unifies features across a package's normal and dev dependencies in one
//! build, so a `testdoor` feature switched on by `crates/centraid`'s
//! dev-dependency would be switched on for its ordinary dependency too — the
//! module would be in the shipped binary anyway and the gate would be
//! decoration. What keeps this out of the product is that nothing in the
//! product calls it, which is a fact `cargo xtask` can check and a feature flag
//! cannot.
//!
//! ## What it is not
//!
//! It applies no access decision, resolves no entity and compiles no row
//! filter: it is the OWNER'S view of a file, which is what a test comparing two
//! copies of a vault wants. A door that decides what a caller may see is
//! `crate::page`'s.

use rusqlite::Connection;

/// How many `core_vault` rows a file holds.
///
/// The question behind it is "did the founding commit really land here" — a
/// replica that reported applying rows into a schema it had never laid down
/// passes every count a caller takes of its own report.
///
/// A file with no such table answers **0** rather than failing: "this is not a
/// vault" and "this vault is not founded" are the same answer to this question,
/// and a test asserting `== 1` refuses both.
#[must_use]
pub fn vault_rows(connection: &Connection) -> i64 {
    connection
        .query_row("SELECT COUNT(*) FROM core_vault", [], |row| row.get(0))
        .unwrap_or(0)
}

/// Every party in the file, `(party_id, display_name)`, ordered by id.
///
/// ORDERED so that two copies of one vault are comparable row for row, which is
/// the assertion a bootstrap test wants: counting them would pass on a replica
/// holding the right number of the wrong rows.
#[must_use]
pub fn parties(connection: &Connection) -> Vec<(String, String)> {
    let Ok(mut statement) =
        connection.prepare("SELECT party_id, display_name FROM core_party ORDER BY party_id")
    else {
        return Vec::new();
    };
    statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .and_then(std::iter::Iterator::collect)
        .unwrap_or_default()
}

/// How many parties carry this display name.
///
/// A NAME AND NOT AN ID, because the test that asks is about a write the
/// MEMBER made — an offline `core.add_party` whose id the seat minted and the
/// caller never saw. Counting by name is how it checks the row arrived exactly
/// once, which is what a replayed intent would break.
#[must_use]
pub fn parties_named(connection: &Connection, display_name: &str) -> i64 {
    connection
        .query_row(
            "SELECT COUNT(*) FROM core_party WHERE display_name = ?1",
            [display_name],
            |row| row.get(0),
        )
        .unwrap_or(0)
}

/// Every note's title, ordered by note id.
///
/// ORDERED for the same reason [`parties`] is: the comparison a seat test makes
/// is row for row, and two copies holding the right NUMBER of the wrong rows is
/// exactly the failure it exists to catch.
#[must_use]
pub fn note_titles(connection: &Connection) -> Vec<String> {
    let Ok(mut statement) = connection.prepare("SELECT title FROM knowledge_note ORDER BY note_id")
    else {
        return Vec::new();
    };
    statement
        .query_map([], |row| row.get::<_, String>(0))
        .and_then(std::iter::Iterator::collect)
        .unwrap_or_default()
}

/// The one content item in a file, with the asset that names it:
/// `(content_id, content_uri, asset_id)`.
///
/// `None` when there is none, or more than the query's first — a fixture that
/// seeded two photographs and asserted on "the" one would be asserting on
/// whichever SQLite happened to return.
#[must_use]
pub fn the_one_photograph(connection: &Connection) -> Option<(String, String, String)> {
    connection
        .query_row(
            "SELECT c.content_id, c.content_uri, a.asset_id
               FROM core_content_item c JOIN media_asset a USING (content_id)",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A FILE THAT IS NOT A VAULT ANSWERS ZERO rather than panicking. The
    /// counts are used inside assertions, and a door that failed on an
    /// unfounded file would turn "the row is not there" into a panic with a
    /// SQLite message in it.
    #[test]
    fn an_unfounded_file_answers_zero_and_empty() {
        let connection = Connection::open_in_memory().expect("opens");
        assert_eq!(vault_rows(&connection), 0);
        assert_eq!(parties_named(&connection, "Anyone"), 0);
        assert!(parties(&connection).is_empty());
        assert_eq!(the_one_photograph(&connection), None);
        assert!(note_titles(&connection).is_empty());
    }

    #[test]
    fn a_founded_vault_has_one_vault_row_and_its_owner_party() {
        let dir = crate::testdoor::tests::scratch("founded");
        let path = dir.join("vault.db");
        let vault = crate::Vault::create(&path).expect("created");
        let founded = vault.found("Test", "Owner").expect("founded");
        let (rows, parties_held) = vault
            .read(|connection| Ok((vault_rows(connection), parties(connection))))
            .expect("reads");
        vault.close().expect("closes");
        assert_eq!(rows, 1);
        assert!(
            parties_held
                .iter()
                .any(|(id, _)| *id == founded.owner_party_id),
            "the founding owner is not among the parties"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    pub(super) fn scratch(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("centraid-vault-testdoor-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("a scratch dir");
        dir
    }
}

/// Which derivative tiers a content item has, ordered — `["preview", "thumb"]`
/// for an image the gateway has derived (#1025 S7, the verifier's finding on
/// the backfill sweep).
///
/// Named for the question because that is what the assertion is: "did the
/// sweep put the tiers back" reads off this, and a `COUNT(*)` would pass on a
/// vault holding two rows of the wrong variant.
#[must_use]
pub fn derivative_variants(connection: &Connection) -> Vec<String> {
    let Ok(mut statement) = connection
        .prepare("SELECT variant FROM core_content_derivative ORDER BY variant, derivative_id")
    else {
        return Vec::new();
    };
    statement
        .query_map([], |row| row.get::<_, String>(0))
        .map(|rows| rows.filter_map(std::result::Result::ok).collect())
        .unwrap_or_default()
}

/// FORGET EVERY DERIVATIVE, which is what a vault founded before the gateway
/// made tiers looks like (#1025 S7).
///
/// The one way to build that state in a test: the tiers are written inside the
/// mint's own transaction, so there is no door that creates an original
/// WITHOUT them. A test therefore makes one the ordinary way and then takes the
/// tiers away — which is also, exactly, the vault the backfill sweep exists for.
///
/// Returns how many rows went.
pub fn forget_derivatives(connection: &Connection) -> usize {
    connection
        .execute("DELETE FROM core_content_derivative", [])
        .unwrap_or(0)
}

/// DROP THE GATEWAY'S PRIVATE STAGING BAND, which is what makes a file look
/// like a replica for the one question `media.add_asset` asks (#1025 S7).
///
/// `blob_staging` is a declared private table (`contracts/schema/
/// v0-registries.json`): the gateway's record of an upload door it ran, and by
/// design absent from every copy. A test that wants a SEAT's schema without
/// standing up a gateway, a pairing and a bootstrap takes the band away from a
/// founded file — and the difference that remains is exactly the one under
/// test.
///
/// Returns whether there was a band to drop, so a fixture cannot silently
/// assert against a file that never had one.
pub fn drop_the_private_staging_band(connection: &Connection) -> bool {
    connection.execute("DROP TABLE blob_staging", []).is_ok()
}
