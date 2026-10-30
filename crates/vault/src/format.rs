//! A vault file names its format ([#1146](https://github.com/srikanth235/centraid/issues/1146), D3).
//!
//! Two facts say which model a file holds, and both are checked when the file is opened and when a
//! restored copy is laid down, before anything depends on it:
//!
//! - **`application_id`**, [`APPLICATION_ID`]: which model made the file. The model before
//!   [#1135](https://github.com/srikanth235/centraid/issues/1135) wrote [`EARLIER_APPLICATION_ID`];
//!   there is no compatibility with it (R-FP-10), so such a file is refused with a sentence, never
//!   migrated and never read by guesswork.
//! - **A schema digest**, [`SCHEMA_DIGEST`]: BLAKE3 over the file's `sqlite_schema`, so a file whose
//!   tables are not the ones this build was written against is refused, whoever changed them.
//!
//! **Any change to `contracts/migrations/001_baseline.sql` changes the digest**, and the test
//! `the_schema_digest_is_the_founded_files` fails with the new value until [`SCHEMA_DIGEST`] is
//! updated in the same change. That is the point: a schema change cannot land without the
//! constant that names it.

use rusqlite::Connection;

/// `CEN2` as a big-endian four-byte tag: the `application_id` a vault of the #1135 model carries,
/// so `file` and a human can tell one from any other SQLite database, and from `CEN1`, the model
/// before it.
pub const APPLICATION_ID: i64 = 0x4345_4e32;

/// `CEN1`: what the model before #1135 wrote. Refused, never opened (R-FP-10).
pub const EARLIER_APPLICATION_ID: i64 = 0x4345_4e31;

/// The digest of the schema this build founds: see [`schema_digest`]. Updated with every change
/// to the baseline, and held to the founded file by a test.
pub const SCHEMA_DIGEST: &str = "b585334211ed6091a455b8762c890d66a2549fa88a85f32832f3c8db0775c164";

/// BLAKE3, in hex, over the file's `sqlite_schema` rows: type, name, table name and statement,
/// ordered by name.
///
/// What is left out is what the schema does not decide: SQLite's own tables and indexes (the
/// statistics `PRAGMA optimize` writes among them) and the full-text index's shadow tables,
/// which the FTS5 module words differently from one SQLite to the next. A statement is read
/// without its comments and with its whitespace collapsed, so a re-flowed or re-commented
/// baseline is not a different schema.
///
/// # Errors
/// SQLite's refusal to read the schema.
pub fn schema_digest(connection: &Connection) -> rusqlite::Result<String> {
    let mut statement = connection.prepare(
        "SELECT type, name, tbl_name, coalesce(sql, '') FROM sqlite_schema ORDER BY name, type",
    )?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut hasher = blake3::Hasher::new();
    for (kind, name, table, sql) in rows {
        if name.starts_with("sqlite_") || crate::log::guard::is_fts_shadow(&name) {
            continue;
        }
        for part in [kind.as_str(), &name, &table, &normalised(&sql)] {
            hasher.update(part.as_bytes());
            hasher.update(&[0]);
        }
        hasher.update(b"\n");
    }
    Ok(hasher.finalize().to_hex().to_string())
}

/// The statement without its comments, whitespace collapsed to single spaces. A quoted string is
/// copied as it stands.
fn normalised(sql: &str) -> String {
    let mut out = String::with_capacity(sql.len());
    let mut chars = sql.chars().peekable();
    let mut quote: Option<char> = None;
    let mut space = false;
    while let Some(c) = chars.next() {
        if let Some(open) = quote {
            out.push(c);
            if c == open {
                quote = None;
            }
            continue;
        }
        match c {
            '\'' | '"' | '`' => {
                if space && !out.is_empty() {
                    out.push(' ');
                }
                space = false;
                quote = Some(c);
                out.push(c);
            }
            '-' if chars.peek() == Some(&'-') => {
                for skipped in chars.by_ref() {
                    if skipped == '\n' {
                        break;
                    }
                }
                space = true;
            }
            c if c.is_whitespace() => space = true,
            c => {
                if space && !out.is_empty() {
                    out.push(' ');
                }
                space = false;
                out.push(c);
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_statement_is_read_without_comments_and_with_one_space_between_words() {
        assert_eq!(
            normalised("CREATE TABLE t (\n  a  TEXT, -- a comment 'with a quote\n  b TEXT\n)"),
            "CREATE TABLE t ( a TEXT, b TEXT )"
        );
        // A quoted string keeps its spaces and its dashes.
        assert_eq!(
            normalised("CHECK (x <> 'a  --  b')"),
            "CHECK (x <> 'a  --  b')"
        );
    }

    #[test]
    fn the_two_application_ids_are_distinct_tags() {
        assert_eq!(APPLICATION_ID.to_be_bytes()[4..], *b"CEN2");
        assert_eq!(EARLIER_APPLICATION_ID.to_be_bytes()[4..], *b"CEN1");
        assert_ne!(APPLICATION_ID, crate::backup::ledger::LEDGER_APPLICATION_ID);
    }

    /// THE CONSTANT IS THE FOUNDED FILE'S DIGEST. A change to the baseline moves it; when this
    /// fails, the value to put in [`SCHEMA_DIGEST`] is the `found` line.
    #[test]
    fn the_schema_digest_is_the_founded_files() {
        let dir = tempfile::tempdir().expect("a directory");
        let vault = crate::file::Vault::create(dir.path().join("vault.db")).expect("founds");
        let found = vault
            .read(|connection| Ok(schema_digest(connection)?))
            .expect("reads the schema");
        assert_eq!(
            found, SCHEMA_DIGEST,
            "the schema changed: put this in SCHEMA_DIGEST\nfound: {found}"
        );
    }
}
