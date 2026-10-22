//! The paged door's vault-side hook (D-1020-D1-10).
//!
//! **The grammar is not here.** Lane D3 ports v0's statement-as-data grammar
//! into `crates/apps/kit`: a `FROM` of tables and equijoins, a `SELECT`/`WHERE`
//! of column refs, placeholders, literals and a fixed operator set, with
//! subqueries, second statements, comments and unlisted functions REFUSED
//! rather than repaired. That belongs with the kit because the kit is what
//! every app writes its reads in, and a grammar with two implementations is two
//! keyset dialects.
//!
//! What the vault owes the kit, and the whole interface between them:
//!
//! - [`Vault::page_raw`] runs an already-checked statement and returns rows,
//!   with a hard row cap SQLite itself enforces.
//! - [`and_row_filters`] is the AND-ing hook: the authority plane's row filters
//!   are conjoined into the statement's `WHERE`, **never ORed**, and a table
//!   whose decision is `deny` refuses the whole page rather than being dropped
//!   from the join. Dropping it would silently answer a different question.
//! - **A sealed column is never projectable.** A page is a read and plaintext
//!   takes `reveal`, so the mask is applied here and not left to the caller.
//!
//! Agreed with lane D3 in the receipt: the kit builds the statement text and
//! the binds, calls `and_row_filters` with the decision it got from
//! `evaluate_access`, and hands the result to `page_raw`. The vault never sees
//! a `PageQuery`; the kit never sees a `Connection`.

use crate::access::{Decision, RowFilter};
use crate::error::{Result, VaultError};
use crate::file::Vault;
use crate::value::{RowImage, Value};

/// The ceiling a page is clamped to — v0's `MAX_PAGE_ROWS`.
///
/// A CEILING that clamps, not a policy that refuses: a caller asking for 10,000
/// rows gets 500, because the alternative is an error at a boundary nobody
/// tested. The `+1` probe that separates "window filled" from "rows ended" is
/// the kit's, not the vault's.
pub const MAX_PAGE_ROWS: i64 = 500;

/// An already-checked statement and its binds.
#[derive(Debug, Clone)]
pub struct RawPage {
    pub sql: String,
    pub binds: Vec<Value>,
    pub limit: i64,
}

impl Vault {
    /// Run a checked statement, returning at most `limit` rows.
    ///
    /// `limit` is clamped to [`MAX_PAGE_ROWS`] and the statement runs on the
    /// READ connection, so `query_only` refuses anything that is not a read —
    /// which means a grammar bug that let a write through is caught by SQLite
    /// rather than by a reviewer.
    pub fn page_raw(&self, page: &RawPage) -> Result<Vec<RowImage>> {
        self.page_clamped(page, MAX_PAGE_ROWS)
    }

    /// [`Self::page_raw`] with the ceiling stated. `keyset_page` reads one row
    /// past the page it serves (the probe that says "more rows follow"), so its
    /// ceiling is `MAX_PAGE_ROWS + 1`; clamping the probe to `MAX_PAGE_ROWS`
    /// made a page asked at exactly the ceiling look like the last one.
    fn page_clamped(&self, page: &RawPage, ceiling: i64) -> Result<Vec<RowImage>> {
        if page.limit < 1 {
            return Err(VaultError::Invariant {
                context: "a page limit is required; a default is how an unbounded read gets written by accident".to_owned(),
            });
        }
        let limit = page.limit.min(ceiling);
        self.read(|connection| {
            let mut statement = connection.prepare(&page.sql)?;
            let names: Vec<String> = statement
                .column_names()
                .into_iter()
                .map(str::to_owned)
                .collect();
            let binds: Vec<&dyn rusqlite::ToSql> = page
                .binds
                .iter()
                .map(|value| value as &dyn rusqlite::ToSql)
                .collect();
            let mut rows = statement.query(binds.as_slice())?;
            let mut out = Vec::new();
            while let Some(row) = rows.next()? {
                if i64::try_from(out.len()).unwrap_or(i64::MAX) >= limit {
                    break;
                }
                let mut image = RowImage::new();
                for (index, name) in names.iter().enumerate() {
                    image.insert(name.clone(), Value::from_ref(row.get_ref(index)?)?);
                }
                out.push(image);
            }
            Ok(out)
        })
    }
}

/// Conjoin a decision's row filters onto a statement's `WHERE`.
///
/// Returns the new predicate text and the binds to append, in the order the
/// text names them. A `deny` REFUSES: an empty answer would read as "no data"
/// and the truth is "you may not ask".
pub fn and_row_filters(
    table_alias: &str,
    existing_where: Option<&str>,
    decision: &Decision,
) -> Result<(Option<String>, Vec<Value>)> {
    if let Decision::Deny { failing, .. } = decision {
        return Err(VaultError::Invariant {
            context: failing.clone(),
        });
    }
    let mut clauses: Vec<String> = existing_where
        .map(|text| vec![format!("({text})")])
        .unwrap_or_default();
    let mut binds: Vec<Value> = Vec::new();
    for filter in decision.row_filter() {
        clauses.push(render_filter(table_alias, filter, &mut binds));
    }
    if clauses.is_empty() {
        return Ok((None, binds));
    }
    Ok((Some(clauses.join(" AND ")), binds))
}

/// One filter as SQL: `=` for a single value, `IN` for a set.
fn render_filter(table_alias: &str, filter: &RowFilter, binds: &mut Vec<Value>) -> String {
    let column = format!(
        "{}.{}",
        crate::log::quoted(table_alias),
        crate::log::quoted(&filter.column)
    );
    if filter.values.len() == 1 {
        binds.push(Value::Text(filter.values[0].clone()));
        return format!("{column} = ?");
    }
    for value in &filter.values {
        binds.push(Value::Text(value.clone()));
    }
    format!(
        "{column} IN ({})",
        vec!["?"; filter.values.len()].join(", ")
    )
}

/// Drop the columns a mask does not admit.
///
/// Applied to the ROWS rather than to the `SELECT` list, because a keyset page
/// needs its sort column and its primary key in the projection whether or not
/// the mask admits them — the cursor is read off the row by those two columns.
#[must_use]
pub fn apply_field_mask(rows: Vec<RowImage>, decision: &Decision) -> Vec<RowImage> {
    let Decision::Allow {
        field_mask: Some(mask),
        ..
    } = decision
    else {
        return rows;
    };
    rows.into_iter()
        .map(|row| {
            row.into_iter()
                .filter(|(column, _)| mask.contains(column))
                .collect()
        })
        .collect()
}

/// ONE PROJECTED COLUMN: a name, quoted — a sealed cell's PRESENCE — or one
/// key out of a JSON cell.
///
/// The kit's grammar admits exactly one expression in a projection, `<cell> IS
/// NOT NULL AS <name>` (D-1020-CL5): whether a sealed cell holds anything, so a
/// read can say "this login has a password" without carrying ciphertext. The
/// page door quoted every entry as an identifier, which turned that expression
/// into a string literal named after itself (#1047, found by Locker's item
/// read). Both names are checked as plain identifiers before they are quoted,
/// so nothing but a presence test is spelled here.
///
/// **And `json_extract(<cell>, '<$.path>') AS <name>`**, the second shape the
/// kit's grammar already admits (`json_extract` is in its word list). A shell
/// has no JSON parser in `commonMain`, so a key inside a JSON cell is read by
/// the vault — a vault's time zone out of `core_vault.settings_json`, a
/// place's gazetteer name out of `core_place.address_json`. It was quoted whole
/// like the presence test was, so it answered a string literal and every such
/// column read NULL. The cell and the name are checked as identifiers and the
/// path as `$` and dotted identifier characters before anything is spelled.
fn projected(column: &str) -> String {
    if let Some(extracted) = json_key(column) {
        return extracted;
    }
    let words: Vec<&str> = column.split_whitespace().collect();
    let identifier = |word: &str| {
        !word.is_empty()
            && word
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
    };
    match words.as_slice() {
        [cell, is, not, null, r#as, name]
            if is.eq_ignore_ascii_case("IS")
                && not.eq_ignore_ascii_case("NOT")
                && null.eq_ignore_ascii_case("NULL")
                && r#as.eq_ignore_ascii_case("AS")
                && identifier(cell)
                && identifier(name) =>
        {
            format!(
                "({} IS NOT NULL) AS {}",
                crate::log::quoted(cell),
                crate::log::quoted(name)
            )
        }
        _ => crate::log::quoted(column),
    }
}

/// `json_extract(<cell>, '<$.path>') AS <name>`, spelled with the cell and the
/// name quoted, or `None` for any other entry. See [`projected`].
fn json_key(column: &str) -> Option<String> {
    let identifier = |word: &str| {
        !word.is_empty()
            && word
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
    };
    let trimmed = column.trim();
    let open = "json_extract(";
    if trimmed.len() <= open.len() || !trimmed[..open.len()].eq_ignore_ascii_case(open) {
        return None;
    }
    let rest = &trimmed[open.len()..];
    let close = rest.find(')')?;
    let (arguments, tail) = (&rest[..close], &rest[close + 1..]);
    let (cell, path) = arguments.split_once(',')?;
    let (cell, path) = (cell.trim(), path.trim());
    let path = path.strip_prefix('\'')?.strip_suffix('\'')?;
    let path_ok = path.starts_with('$')
        && path[1..]
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'.');
    let words: Vec<&str> = tail.split_whitespace().collect();
    match words.as_slice() {
        [r#as, name]
            if r#as.eq_ignore_ascii_case("AS")
                && identifier(cell)
                && identifier(name)
                && path_ok =>
        {
            Some(format!(
                "json_extract({}, '{path}') AS {}",
                crate::log::quoted(cell),
                crate::log::quoted(name)
            ))
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::access::Decision;

    fn allow(filters: Vec<RowFilter>) -> Decision {
        Decision::Allow {
            authority_id: None,
            row_filter: filters,
            field_mask: None,
        }
    }

    #[test]
    fn filters_are_anded_onto_the_existing_predicate_and_never_ored() {
        let decision = allow(vec![RowFilter {
            column: "group_id".to_owned(),
            values: vec!["g1".to_owned()],
        }]);
        let (predicate, binds) =
            and_row_filters("e", Some("spent_on >= ?"), &decision).expect("ANDed");
        let predicate = predicate.expect("there is a predicate");
        assert_eq!(predicate, "(spent_on >= ?) AND \"e\".\"group_id\" = ?");
        assert!(!predicate.contains(" OR "));
        assert_eq!(binds, vec![Value::Text("g1".to_owned())]);
    }

    #[test]
    fn a_bounded_union_is_one_in_filter() {
        let decision = allow(vec![RowFilter {
            column: "group_id".to_owned(),
            values: vec!["g1".to_owned(), "g2".to_owned()],
        }]);
        let (predicate, binds) = and_row_filters("e", None, &decision).expect("ANDed");
        assert_eq!(
            predicate.expect("there is a predicate"),
            "\"e\".\"group_id\" IN (?, ?)"
        );
        assert_eq!(binds.len(), 2);
    }

    #[test]
    fn a_deny_refuses_the_page_rather_than_answering_nothing() {
        let decision = Decision::Deny {
            failing: "nothing grants read on locker.item".to_owned(),
            authority_id: None,
        };
        let error = and_row_filters("i", None, &decision).expect_err("must refuse");
        assert!(error.to_string().contains("locker.item"), "{error}");
    }

    #[test]
    fn a_field_mask_drops_what_it_does_not_admit() {
        let mut row = RowImage::new();
        row.insert("a".to_owned(), Value::Integer(1));
        row.insert("secret".to_owned(), Value::Text("x".to_owned()));
        let decision = Decision::Allow {
            authority_id: None,
            row_filter: Vec::new(),
            field_mask: Some(["a"].into_iter().map(str::to_owned).collect()),
        };
        let masked = apply_field_mask(vec![row], &decision);
        assert_eq!(masked[0].keys().collect::<Vec<_>>(), vec!["a"]);
    }
}

// ---------------------------------------------------------------------------
// The keyset page — the shape `crates/core` serves (#1020, lane D2)
// ---------------------------------------------------------------------------

/// A keyset-paged read, as a caller describes it.
///
/// [`RawPage`] takes SQL the caller wrote, which is what the `sql-confinement`
/// rule catches the moment a caller outside this crate wants a page — and
/// rightly: `crates/core` building a `SELECT … ORDER BY … LIMIT` string is
/// `crates/core` knowing the query language. So the *shape* crosses the
/// boundary and the SQL is rendered here.
///
/// **Both order columns must be in `select`.** There is no `key_of` callback:
/// the cursor IS the two columns' values, read off the row, so a projection
/// missing one is a page whose `next` cannot exist.
#[derive(Debug, Clone)]
pub struct KeysetPage {
    /// The shape's name, for logs and budgets.
    pub name: String,
    pub select: Vec<String>,
    pub from: String,
    /// The handler's own predicate, already checked by its author.
    pub predicate: Option<String>,
    pub binds: Vec<Value>,
    pub sort_column: String,
    pub pk_column: String,
    pub descending: bool,
    /// Required, and validated `> 0` rather than defaulted: a zero is a request
    /// for an unbounded read, and defaulting it would serve one.
    pub limit: i64,
    /// `(sort_key, pk)` — the cursor a caller hands back.
    pub after: Option<(String, String)>,
    /// APPEND A `thumbnail_path` COLUMN, resolved from the bytes this device
    /// holds (#1025, D-1025-S7-20). See [`HELD_THUMBNAIL_COLUMN`].
    pub held_thumbnail: bool,
    /// APPEND A `document_size` COLUMN: the row's bytes, ALREADY IN WORDS.
    /// See [`DOCUMENT_SIZE_COLUMN`].
    pub document_size: bool,
}

/// The computed column [`KeysetPage::held_thumbnail`] appends: the path of a
/// picture a cell can draw, from the bytes THIS DEVICE holds, or NULL.
///
/// **A correlated subquery and not a `LEFT JOIN`**, which is the same answer
/// and is the only one that cannot change the page: a join through `derivative`
/// multiplies a row by its derivatives, and a grid whose page silently held two
/// of one photograph would break its own keyset cursor. One value per row,
/// ordering and row count untouched.
///
/// **The tier.** A `thumb` first, then a `poster` (a video's frame), and when no
/// derivative has bytes the row's own `blob` is the candidate. The statement
/// projects the candidate HASH and its media type, and
/// [`Vault::resolve_held_bytes`] asks the byte store for the path: whether this
/// device holds a blob is a question for the store, not for a table. It stays
/// opt-in per query because it costs a store lookup per row.
///
/// **THE `from` TABLE MUST CARRY A `blob` COLUMN** (a `photo` or a `document`),
/// and one that does not is REFUSED AT PREPARE: SQLite resolves a correlated
/// subquery's outer reference before a single row is read, so there is no row
/// loop in which to answer NULL. A flag set on the wrong table is a caller's
/// bug, and a read that went quiet would be a screen nobody could debug.
pub const HELD_THUMBNAIL_COLUMN: &str = "thumbnail_path";

/// The hash the thumbnail lookup will try, projected by the statement and
/// REMOVED from the row before it is served: a sha in a row image is a second,
/// unpromised way for a shell to reach one.
const DRAWABLE_HASH_COLUMN: &str = "drawable_hash";

/// The media type of whatever [`DRAWABLE_HASH_COLUMN`] names: the derivative's
/// own, or the row's when the fallback took the original. Removed with it.
const DRAWABLE_TYPE_COLUMN: &str = "drawable_type";

/// THE ORIGINAL'S OWN HASH, appended beside [`HELD_THUMBNAIL_COLUMN`]: the
/// row's `blob`, NOT the derivative the thumbnail resolved to. It is what a
/// download arrow names when a member taps it.
pub const HELD_ORIGINAL_HASH_COLUMN: &str = "original_hash";

/// WHETHER THE ORIGINAL ITSELF IS ON THIS DEVICE, 1 or 0: in the content store,
/// or in the operating system's library the phone never copies from (#1080
/// ruling 6). The one fact that separates "held" from "thumbnail only"; it
/// cannot be inferred from [`HELD_THUMBNAIL_COLUMN`], whose fallback is the
/// original. `drawable` is deliberately NOT part of it: a held video is held.
pub const HELD_ORIGINAL_HELD_COLUMN: &str = "original_held";

/// The computed column [`KeysetPage::document_size`] appends: **a phrase, not a
/// number** (Home's Docs tile). The core decides how a size reads
/// ([`format_byte_size`]), and a view never formats one from a byte count.
///
/// The bytes are `blob.size` of the row's own `blob`: an edited document
/// reports the edit's size, the only answer that matches what opening it would
/// show. NULL is a real answer and is not a zero.
///
/// **THE `from` TABLE MUST CARRY A `blob` COLUMN**, and one that does not is
/// REFUSED AT PREPARE, for the reason [`HELD_THUMBNAIL_COLUMN`] states.
pub const DOCUMENT_SIZE_COLUMN: &str = "document_size";

/// The byte count the statement projects, TURNED INTO WORDS AND REMOVED: an
/// integer left beside [`DOCUMENT_SIZE_COLUMN`] would be a second, unpromised
/// way for a shell to reach a byte count.
const DOCUMENT_BYTES_COLUMN: &str = "document_bytes";

/// A BYTE COUNT IN THE UNITS A MEMBER READS, decided HERE because the contract
/// says the core decides it (#1029, Home's Docs tile).
///
/// Public because it is the one formatter: `DocumentRow::byte_size` crosses
/// into `crates/apps/docs` as a raw `i64` and its own surfaces owe a member the
/// same phrase this tile owes them. Two implementations of "how big is that"
/// is how a drive row and a launcher row end up disagreeing about the same
/// file.
///
/// **Decimal, not binary.** A phone's own storage screen counts in decimal, and
/// a member comparing the two should not be handed two numbers for one amount.
/// The design corpus spells the same family — `880 KB`, `1.2 MB`, `84.2 GB`.
///
/// **One decimal above a megabyte, none below.** The column is right-aligned
/// tabular numerals, so a fixed shape is what makes a stack of rows readable;
/// `1.2 MB` carries information a member can act on and `1.2 KB` does not.
/// Below a kilobyte the count itself is the phrase, because rounding a
/// three-hundred-byte note to `0 KB` reports a file that is not there.
///
/// **"The vault's locale" is not a setting yet, and this does not pretend
/// otherwise.** v0 has no locale row; when it grows one, this function is where
/// it lands, which is the whole reason the contract put the formatting behind
/// the core instead of in two shells.
pub fn format_byte_size(count: i64) -> String {
    const KB: i64 = 1_000;
    const MB: i64 = 1_000_000;
    const GB: i64 = 1_000_000_000;
    // A NEGATIVE COUNT CANNOT COME OUT OF THE COLUMN — `core_content_item`
    // carries `CHECK (byte_size >= 0)` — so this clamps rather than branching
    // on a state the schema refuses.
    let count = count.max(0);
    match count {
        0..KB => {
            if count == 1 {
                "1 byte".to_owned()
            } else {
                format!("{count} bytes")
            }
        }
        // TRUNCATED at the kilobyte rung, where the tenth would say nothing a
        // member could act on, and where truncating also keeps 999 999 bytes
        // from rounding itself out of its own unit.
        KB..MB => format!("{} KB", count / KB),
        MB..GB => {
            let (whole, tenth) = tenths(count, MB);
            // ROUNDING CAN CROSS THE RUNG. 999 999 999 bytes is 1000.0 MB by
            // arithmetic and 1.0 GB to a reader, and a column that printed the
            // first would be the one row in a stack nobody could scan past.
            if whole == 1_000 {
                let (whole, tenth) = tenths(count, GB);
                format!("{whole}.{tenth} GB")
            } else {
                format!("{whole}.{tenth} MB")
            }
        }
        // NO RUNG ABOVE THIS ONE, deliberately: a terabyte on a phone is not a
        // state v0 has, and a unit nothing can produce is a unit nothing tests.
        _ => {
            let (whole, tenth) = tenths(count, GB);
            format!("{whole}.{tenth} GB")
        }
    }
}

/// `count / unit` as `(whole, tenth)`, ROUNDED rather than truncated, in
/// integer arithmetic.
///
/// Rounded because 1 999 999 bytes is `2.0 MB` to everyone who is not a
/// computer, and integer because a float formatted with `{:.1}` would take its
/// decimal separator from nobody's locale in particular. `count % unit` is
/// below `unit`, and `unit` is at most a billion, so the `* 10` cannot overflow.
fn tenths(count: i64, unit: i64) -> (i64, i64) {
    let mut whole = count / unit;
    let mut tenth = ((count % unit) * 10 + unit / 2) / unit;
    if tenth == 10 {
        whole += 1;
        tenth = 0;
    }
    (whole, tenth)
}

/// THE READS THAT MAY SEE A LOCKER ITEM'S ROW.
///
/// A Locker item is an entity, so a page over `entity` or `edge` would serve
/// it with every other kind's rows: its title, its tags, the notes that link
/// it. Locker's items are the member's most private rows, so a page serves
/// them only to a read that is named as one that may (#1135, the Locker lane,
/// L4):
///
/// - `locker.*`: Locker's own reads, behind its gate on the shell;
/// - `home.locker`: Home's count of Locker's items, which selects ids and
///   nothing a member wrote;
/// - `notes.cards.entity`, `notes.library.links` and `notes.library.backlinks`:
///   a note's link to an item and the card that renders its title (L8);
/// - `assist.native.*`: the assistant's reads. It has the owner's access to a
///   Locker item's plain rows (the owner's ruling of 2026-10-22), and no
///   access to a sealed value, which [`withholds_sealed_value`] holds for it.
///
/// Every other read (a generic list, the Trash of another app) is given the
/// page **without** them: the rows are not there, and no count of them is
/// either.
#[must_use]
pub fn reaches_locker(name: &str) -> bool {
    name.starts_with("locker.")
        || name.starts_with(ASSISTANT_READ)
        || matches!(
            name,
            "home.locker"
                | "notes.cards.entity"
                | "notes.library.links"
                | "notes.library.backlinks"
        )
}

/// The prefix of the assistant's reads of the vault's tables.
const ASSISTANT_READ: &str = "assist.native.";

/// Every sealed column of Locker's tables: the five cells of `locker_item`,
/// `locker_item_field.value_sealed` and `locker_item_passkey.private_key`.
const SEALED_COLUMNS: [&str; 7] = [
    "password",
    "otp_seed",
    "card_number",
    "cvv",
    "content",
    "value_sealed",
    "private_key",
];

/// THE SEALED-COLUMN GUARD, which holds for every read that is not Locker's own.
///
/// [`reaches_locker`] lets the assistant's reads page a Locker table, and a
/// sealed value is the one thing it has no access to. A read that is not
/// named `locker.*` therefore may not project a sealed column, order by one or
/// name one in its predicate (a predicate is an oracle: `password = 'x'`). Only
/// the kit's presence test, `<cell> IS NOT NULL AS <name>`, names one, and it
/// is a bit and not a value.
fn withholds_sealed_value(page: &KeysetPage) -> bool {
    let names_sealed = |text: &str| {
        text.split(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
            .any(|word| SEALED_COLUMNS.contains(&word.to_ascii_lowercase().as_str()))
    };
    let is_presence = |column: &str| {
        let words: Vec<&str> = column.split_whitespace().collect();
        matches!(words.as_slice(), [_, is, not, null, r#as, _]
            if is.eq_ignore_ascii_case("IS")
                && not.eq_ignore_ascii_case("NOT")
                && null.eq_ignore_ascii_case("NULL")
                && r#as.eq_ignore_ascii_case("AS"))
    };
    page.select
        .iter()
        .any(|column| names_sealed(column) && !is_presence(column))
        || names_sealed(&page.sort_column)
        || names_sealed(&page.pk_column)
        || page.predicate.as_deref().is_some_and(names_sealed)
}

/// Locker's own tables: the kind row and its sidecars. `receipt` and
/// `locker_key` hold no secret and are paged by name like any other table.
fn is_locker_table(table: &str) -> bool {
    table == "locker_item" || table.starts_with("locker_item_")
}

/// The clause that takes Locker's items out of a page over `entity`, and the
/// edges that touch one out of a page over `edge`.
fn locker_exclusion(from: &str) -> Option<String> {
    match from {
        "entity" => Some("(\"kind\" <> 'locker_item')".to_owned()),
        "edge" => Some(
            "(NOT EXISTS (SELECT 1 FROM entity AS locker_end WHERE locker_end.kind = 'locker_item' \
             AND locker_end.id IN (\"edge\".\"from_id\", \"edge\".\"to_id\", \"edge\".\"label_id\")))"
                .to_owned(),
        ),
        _ => None,
    }
}

/// One page of rows, plus the cursor to ask from next.
#[derive(Debug, Clone)]
pub struct KeysetAnswer {
    pub rows: Vec<RowImage>,
    /// **Absent when the rows ended.** Never a `truncated` flag and never a
    /// cursor that points past the end.
    pub next: Option<(String, String)>,
}

impl Vault {
    /// Serve one keyset page whose predicate may read only `readable`.
    ///
    /// **THE PREDICATE IS TEXT, SO A TABLE LIST ON `from` ALONE IS NOT A
    /// DOOR.** `media_asset WHERE (SELECT secret FROM locker_item_field) …`
    /// names an allowed `from` and reads a refused table. This prepares the
    /// projection and predicate, without the computed columns the vault adds
    /// itself, under an SQLite authorizer that refuses a read of any table
    /// outside `readable` and any action a `SELECT` has no use for. SQLite
    /// resolves every table a statement touches at prepare, through views,
    /// CTEs and subqueries alike, so nothing is parsed here and nothing slips
    /// by in a spelling a parser missed.
    ///
    /// The statement is prepared on its own and never cached: a cached
    /// statement is not re-authorized.
    pub fn keyset_page_reading_only(
        &self,
        page: &KeysetPage,
        readable: &[&str],
    ) -> Result<KeysetAnswer> {
        if let Some(predicate) = &page.predicate {
            self.predicate_reads_only(page, predicate, readable)?;
        }
        self.keyset_page(page)
    }

    fn predicate_reads_only(
        &self,
        page: &KeysetPage,
        predicate: &str,
        readable: &[&str],
    ) -> Result<()> {
        use rusqlite::hooks::{AuthAction, AuthContext, Authorization};
        use std::sync::{Arc, Mutex};

        let sql = format!(
            "SELECT {projection} FROM {from} WHERE ({predicate})",
            projection = page
                .select
                .iter()
                .map(|column| projected(column))
                .collect::<Vec<_>>()
                .join(", "),
            from = crate::log::quoted(&page.from),
        );
        let allowed: Vec<String> = readable.iter().map(|&table| table.to_owned()).collect();
        let refused: Arc<Mutex<Option<String>>> = Arc::default();
        let witness = Arc::clone(&refused);
        let outcome = self.read(|connection| {
            connection.authorizer(Some(move |context: AuthContext<'_>| {
                let refusal = match context.action {
                    AuthAction::Select | AuthAction::Function { .. } | AuthAction::Recursive => {
                        None
                    }
                    AuthAction::Read { table_name, .. } => {
                        (!allowed.iter().any(|table| table == table_name))
                            .then(|| format!("reads `{table_name}`"))
                    }
                    other => Some(format!("asks for {other:?}")),
                };
                match refusal {
                    None => Authorization::Allow,
                    Some(why) => {
                        if let Ok(mut slot) = witness.lock() {
                            slot.get_or_insert(why);
                        }
                        Authorization::Deny
                    }
                }
            }))?;
            let prepared = connection.prepare(&sql).map(drop);
            connection.authorizer(None::<fn(AuthContext<'_>) -> Authorization>)?;
            Ok(prepared)
        })?;
        let why = refused.lock().ok().and_then(|mut slot| slot.take());
        match (why, outcome) {
            (Some(why), _) => Err(VaultError::InvalidInput {
                name: page.name.clone(),
                detail: format!("the page's predicate {why}, which this door does not serve"),
            }),
            (None, Err(error)) => Err(error.into()),
            (None, Ok(())) => Ok(()),
        }
    }

    /// Serve one keyset page.
    ///
    /// Renders the statement, runs it with the `+1` probe that separates "the
    /// window filled" from "the rows ended", and reads the next cursor off the
    /// last row it serves.
    pub fn keyset_page(&self, page: &KeysetPage) -> Result<KeysetAnswer> {
        if page.limit < 1 {
            return Err(VaultError::InvalidInput {
                name: page.name.clone(),
                detail: "a page limit is required and must be > 0; a default is how an \
                         unbounded read gets written by accident"
                    .to_owned(),
            });
        }
        if page.select.is_empty() {
            return Err(VaultError::InvalidInput {
                name: page.name.clone(),
                detail: "a page query selects nothing".to_owned(),
            });
        }
        for column in [&page.sort_column, &page.pk_column] {
            if !page.select.iter().any(|selected| selected == column) {
                return Err(VaultError::InvalidInput {
                    name: page.name.clone(),
                    detail: format!(
                        "`{column}` is an order column and is not in the projection; the \
                         cursor is read off the row by those two columns"
                    ),
                });
            }
        }

        let limit = page.limit.min(MAX_PAGE_ROWS);
        let direction = if page.descending { "DESC" } else { "ASC" };
        let mut binds = page.binds.clone();
        let mut clauses: Vec<String> = page
            .predicate
            .as_ref()
            .map(|text| vec![format!("({text})")])
            .unwrap_or_default();
        if is_locker_table(&page.from)
            && !page.name.starts_with("locker.")
            && withholds_sealed_value(page)
        {
            return Err(VaultError::InvalidInput {
                name: page.name.clone(),
                detail: format!(
                    "`{}` holds a sealed value, and this read is not one of Locker's; \
                     a sealed column is named only by its presence test",
                    page.from
                ),
            });
        }
        if !reaches_locker(&page.name) {
            if is_locker_table(&page.from) {
                return Err(VaultError::InvalidInput {
                    name: page.name.clone(),
                    detail: format!(
                        "`{}` is a Locker table, and this read is not one of Locker's",
                        page.from
                    ),
                });
            }
            clauses.extend(locker_exclusion(&page.from));
        }
        if let Some((sort_key, pk)) = &page.after {
            // A TUPLE COMPARISON on the two order columns. A `>` on the sort
            // column alone would skip every row that ties with the cursor's
            // sort value, and ties are the normal case for a date.
            let comparison = if page.descending { "<" } else { ">" };
            clauses.push(format!(
                "({}, {}) {comparison} (?, ?)",
                crate::log::quoted(&page.sort_column),
                crate::log::quoted(&page.pk_column)
            ));
            binds.push(Value::Text(sort_key.clone()));
            binds.push(Value::Text(pk.clone()));
        }
        let predicate = if clauses.is_empty() {
            String::new()
        } else {
            format!(" WHERE {}", clauses.join(" AND "))
        };
        let projection = page
            .select
            .iter()
            .map(|column| projected(column))
            .collect::<Vec<_>>()
            .join(", ");
        let thumbnail = if page.held_thumbnail {
            // THE HASHES AND THE TYPE, IN SQL; THE PATH IN RUST. See
            // [`HELD_THUMBNAIL_COLUMN`] for why the store is asked afterwards.
            format!(
                ", COALESCE(
                       (SELECT d.out FROM derivative d
                         WHERE d.blob = {from}.blob AND d.variant IN ('thumb', 'poster')
                         ORDER BY CASE d.variant WHEN 'thumb' THEN 0 ELSE 1 END
                         LIMIT 1),
                       {from}.blob
                   ) AS {drawable_hash}
                 , COALESCE(
                       (SELECT d.media_type FROM derivative d
                         WHERE d.blob = {from}.blob AND d.variant IN ('thumb', 'poster')
                         ORDER BY CASE d.variant WHEN 'thumb' THEN 0 ELSE 1 END
                         LIMIT 1),
                       {from}.media_type
                   ) AS {drawable_type}
                 , {from}.blob AS {hash_column}",
                from = crate::log::quoted(&page.from),
                drawable_hash = crate::log::quoted(DRAWABLE_HASH_COLUMN),
                drawable_type = crate::log::quoted(DRAWABLE_TYPE_COLUMN),
                hash_column = crate::log::quoted(HELD_ORIGINAL_HASH_COLUMN),
            )
        } else {
            String::new()
        };
        let document_size = if page.document_size {
            format!(
                ", (SELECT b.size FROM blob b WHERE b.hash = {from}.blob) AS {column}",
                from = crate::log::quoted(&page.from),
                column = crate::log::quoted(DOCUMENT_BYTES_COLUMN),
            )
        } else {
            String::new()
        };
        let sql = format!(
            "SELECT {projection}{thumbnail}{document_size} FROM {from}{predicate} \
             ORDER BY {sort} {direction}, {pk} {direction} LIMIT {probe}",
            from = crate::log::quoted(&page.from),
            sort = crate::log::quoted(&page.sort_column),
            pk = crate::log::quoted(&page.pk_column),
            probe = limit + 1,
        );

        let mut rows = self.page_clamped(
            &RawPage {
                sql,
                binds,
                limit: limit + 1,
            },
            MAX_PAGE_ROWS + 1,
        )?;
        let filled = i64::try_from(rows.len()).unwrap_or(i64::MAX) > limit;
        rows.truncate(usize::try_from(limit).unwrap_or(0));
        if page.held_thumbnail {
            self.resolve_held_bytes(&mut rows);
        }
        if page.document_size {
            say_document_sizes(&mut rows);
        }
        let next = if filled {
            rows.last().map(|row| {
                (
                    cursor_text(row, &page.sort_column),
                    cursor_text(row, &page.pk_column),
                )
            })
        } else {
            None
        };
        Ok(KeysetAnswer { rows, next })
    }

    /// TURN THE HASHES THE STATEMENT PROJECTED INTO A PATH AND A FLAG.
    ///
    /// The half of [`HELD_THUMBNAIL_COLUMN`] that SQL cannot do: whether this
    /// device holds a blob is a question for the content store, not for a
    /// table, so the statement names the candidate hash and this asks the store
    /// — exactly the resolution [`Vault::content_location`] performs for a
    /// single item, done once per row of a page.
    ///
    /// The working columns are removed and the three contract columns are put
    /// in their place, so a caller sees the shape [`HELD_THUMBNAIL_COLUMN`]
    /// promises and never the hash the lookup used.
    ///
    /// **A store that is absent or unhappy answers "no path", never an error.**
    /// A vault with no byte door is the ordinary text-only case, and a cell
    /// with no thumbnail is a state the grid already draws; failing the whole
    /// page over it would take a member's photo list away to report that one
    /// file could not be opened.
    fn resolve_held_bytes(&self, rows: &mut [RowImage]) {
        let blobs = self.blobs();
        for row in rows.iter_mut() {
            let candidate = text_of(row, DRAWABLE_HASH_COLUMN);
            let media_type = text_of(row, DRAWABLE_TYPE_COLUMN).unwrap_or_default();
            let original = text_of(row, HELD_ORIGINAL_HASH_COLUMN);
            row.remove(DRAWABLE_HASH_COLUMN);
            row.remove(DRAWABLE_TYPE_COLUMN);

            // WHAT `drawable = 1` USED TO SAY, ASKED OF THE TYPE ITSELF. The
            // seat plane decided drawability once, where the path was produced,
            // and wrote it into the row this page used to join. That plane is
            // gone (#1029 §1), so the rule is applied here — one predicate, one
            // place, and a caller still cannot express the unsafe question.
            let path = candidate
                .filter(|_| drawable(&media_type))
                .and_then(|hash| blobs.and_then(|store| store.path_of(&hash).ok().flatten()))
                .map(|path| path.to_string_lossy().into_owned());
            row.insert(
                HELD_THUMBNAIL_COLUMN.to_owned(),
                path.map_or(Value::Null, Value::Text),
            );

            // ON THIS DEVICE, in the store or in the operating system's
            // library (#1080 ruling 6): an original the library holds is held,
            // though it has no path to hand a cell.
            let held = original.as_deref().is_some_and(|hash| {
                blobs.is_some_and(|store| {
                    matches!(
                        store.locate(hash),
                        Ok(crate::bytes::Located::Store(_) | crate::bytes::Located::OsLibrary(_))
                    )
                })
            });
            row.insert(
                HELD_ORIGINAL_HELD_COLUMN.to_owned(),
                Value::Integer(i64::from(held)),
            );
        }
    }
}

/// TURN THE BYTE COUNT THE STATEMENT PROJECTED INTO THE PHRASE THE TILE DRAWS.
///
/// The half of [`DOCUMENT_SIZE_COLUMN`] that SQL should not do. It COULD be
/// spelled as a `CASE` over three divisions, and that is exactly the version
/// that cannot grow a locale: the rule about what a member reads belongs in a
/// function somebody can test with numbers, not in a string this file renders.
///
/// The working column goes and the contract column takes its place, so a caller
/// never sees the integer — see [`DOCUMENT_BYTES_COLUMN`] for why serving both
/// would make "never formatted in a view from a byte count" a request rather
/// than a shape.
///
/// **NULL STAYS NULL.** No content row is not a zero-byte file, and a tile that
/// drew "0 bytes" over a document whose bytes this device has not got would be
/// stating something no row in the vault says.
fn say_document_sizes(rows: &mut [RowImage]) {
    for row in rows.iter_mut() {
        let bytes = match row.get(DOCUMENT_BYTES_COLUMN) {
            Some(Value::Integer(count)) => Some(*count),
            _ => None,
        };
        row.remove(DOCUMENT_BYTES_COLUMN);
        row.insert(
            DOCUMENT_SIZE_COLUMN.to_owned(),
            bytes.map_or(Value::Null, |count| Value::Text(format_byte_size(count))),
        );
    }
}

/// WHETHER A CELL MAY BE DRAWN FROM THESE BYTES DIRECTLY.
///
/// Two rules, and both are needed. `may_serve_inline` is the SECURITY half —
/// the list `content.read` refuses to embed, so a path handed to a surface can
/// never be markup — and it is not sufficient here: it admits `video/mp4`,
/// which an image view decodes to nothing.
///
/// The second half is what makes the cell honest. A `thumb` or `poster`
/// derivative is always a still, but the fallback this column makes when a
/// vault has no derivative row reaches the ORIGINAL, and an original is
/// whatever it is. The demo library has one video with no poster: with only
/// the security rule, its cell got the `.mp4`'s own path, drew nothing, and
/// looked exactly like a photograph whose bytes had not arrived. With this
/// rule it gets no path — which is the truth, and `original_held` still says
/// the file is on the device.
fn drawable(media_type: &str) -> bool {
    crate::blob::may_serve_inline(media_type)
        && media_type
            .trim_start()
            .to_ascii_lowercase()
            .starts_with("image/")
}

/// One cell as owned text, or `None` when it is NULL or not a string.
fn text_of(row: &RowImage, column: &str) -> Option<String> {
    match row.get(column) {
        Some(Value::Text(text)) => Some(text.clone()),
        _ => None,
    }
}

/// One cell as cursor text.
///
/// A cursor is text whatever the column's storage class, because it is an opaque
/// token a caller hands back. The comparison is then text against text, which
/// is why the sort column must be one whose lexical order is its real order —
/// an ISO timestamp, an id. That is a constraint on the query's author and not
/// something this function can check.
fn cursor_text(row: &RowImage, column: &str) -> String {
    match row.get(column) {
        Some(Value::Text(text)) => text.clone(),
        Some(Value::Integer(int)) => int.to_string(),
        Some(other) => other.to_wire_json(),
        None => String::new(),
    }
}

#[cfg(test)]
mod keyset_tests {
    use super::*;
    use crate::bytes::BlobStore as _;

    fn founded(dir: &std::path::Path) -> Vault {
        std::fs::create_dir_all(dir).expect("the directory is made");
        let vault = Vault::create(dir.join("v.db")).expect("a vault");
        vault.found("T", "O").expect("founded");
        vault
    }

    fn page(from: &str, select: &[&str], sort: &str, pk: &str) -> KeysetPage {
        KeysetPage {
            name: "test".to_owned(),
            select: select.iter().map(|column| (*column).to_owned()).collect(),
            from: from.to_owned(),
            predicate: None,
            binds: Vec::new(),
            sort_column: sort.to_owned(),
            pk_column: pk.to_owned(),
            descending: false,
            limit: 10,
            after: None,
            held_thumbnail: false,
            document_size: false,
        }
    }

    /// One photograph whose original is `hash`, and a derivative of it when
    /// `thumb` names one. Written through the commit guard, as a command would.
    fn photograph(
        vault: &Vault,
        id: &str,
        at: &str,
        hash: &str,
        size: i64,
        media_type: &str,
        thumb: Option<(&str, &str)>,
    ) {
        vault
            .commit(|tx| {
                let c = tx.connection();
                crate::blob::stage(c, hash, size)?;
                tx.insert_entity(id, crate::model::Kind::Photo, "", at)?;
                c.execute(
                    "INSERT INTO photo (id, blob, media_type, form, taken_at)
                     VALUES (?1, ?2, ?3, 'photo', ?4)",
                    rusqlite::params![id, hash, media_type, at],
                )?;
                if let Some((out, thumb_type)) = thumb {
                    crate::blob::write_derivative(
                        c,
                        at,
                        hash,
                        "thumb",
                        Some((out, size, thumb_type)),
                        None,
                    )?;
                }
                Ok(())
            })
            .expect("the photograph lands");
    }

    /// A PREDICATE IS HELD TO THE SAME LIST AS `from`. An allowed table with a
    /// subquery on a refused one is refused, through a CTE and the schema table
    /// too, and a subquery on another listed table still answers.
    #[test]
    fn a_predicate_that_reads_a_table_outside_the_list_is_refused() {
        let dir = centraid_ontology::scratch::scratch_dir();
        let vault = founded(&dir);
        let readable = ["entity", "edge"];
        let with = |predicate: &str| KeysetPage {
            predicate: Some(predicate.to_owned()),
            ..page("entity", &["id"], "id", "id")
        };
        for predicate in [
            "EXISTS (SELECT 1 FROM locker_item_field)",
            "id IN (SELECT CAST(seq AS TEXT) FROM receipt)",
            "EXISTS (WITH r AS (SELECT * FROM revision) SELECT 1 FROM r)",
            "EXISTS (SELECT 1 FROM sqlite_master)",
        ] {
            let refused = vault
                .keyset_page_reading_only(&with(predicate), &readable)
                .expect_err(predicate);
            assert!(
                matches!(refused, VaultError::InvalidInput { .. }),
                "`{predicate}`: {refused}"
            );
        }
        vault
            .keyset_page_reading_only(&with("id NOT IN (SELECT to_id FROM edge)"), &readable)
            .expect("a subquery on a listed table answers");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A THUMBNAIL READ REACHES THE BYTE STORE, AND THE STATEMENT PREPARES, on
    /// an empty table first: a statement naming a relation no vault has does
    /// not need a row to fail.
    #[test]
    fn a_held_thumbnail_page_prepares_and_resolves_a_path_from_the_store() {
        let dir = centraid_ontology::scratch::scratch_dir();
        let store = crate::bytes::FsBlobStore::open(dir.join("blobs")).expect("a blob store");
        let original = store.put(b"not really a JPEG").expect("stored");
        let thumb = store.put(b"its thumbnail").expect("stored");
        let vault = founded(&dir);
        let asked = KeysetPage {
            held_thumbnail: true,
            descending: true,
            ..page("photo", &["id", "taken_at"], "taken_at", "id")
        };
        let empty = vault
            .keyset_page(&asked)
            .expect("it prepares on a founded vault");
        assert!(empty.rows.is_empty());

        photograph(
            &vault,
            "p1",
            "2026-01-01T00:00:00.000Z",
            &original,
            17,
            "image/jpeg",
            Some((&thumb, "image/jpeg")),
        );

        // NO STORE, NO PATH, AND NO FAILURE.
        let doorless = vault
            .keyset_page(&asked)
            .expect("it serves without a store");
        assert_eq!(
            doorless.rows[0].get(HELD_THUMBNAIL_COLUMN),
            Some(&Value::Null)
        );

        let vault = vault.with_blobs(Box::new(store));
        let answer = vault.keyset_page(&asked).expect("it serves with a store");
        let row = &answer.rows[0];
        let Some(Value::Text(path)) = row.get(HELD_THUMBNAIL_COLUMN) else {
            panic!("the thumbnail did not resolve: {row:?}");
        };
        assert!(std::path::Path::new(path).exists(), "{path}");
        assert!(
            path.contains(&thumb),
            "the thumbnail tier, not the original: {path}"
        );
        assert_eq!(
            row.get(HELD_ORIGINAL_HASH_COLUMN),
            Some(&Value::Text(original))
        );
        assert_eq!(row.get(HELD_ORIGINAL_HELD_COLUMN), Some(&Value::Integer(1)));
        // THE WORKING COLUMNS DO NOT ESCAPE.
        assert!(row.get(DRAWABLE_HASH_COLUMN).is_none());
        assert!(row.get(DRAWABLE_TYPE_COLUMN).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// WHAT A SURFACE MAY NOT EMBED, THE TYPE REFUSES: the bytes are held and
    /// the row is served; what a grid does NOT get is a path it would hand to a
    /// web view, or an image view that cannot decode a video.
    #[test]
    fn a_reading_no_surface_may_embed_gets_no_path_though_the_bytes_are_held() {
        for (media_type, bytes) in [
            ("text/html", b"<html>not a photograph</html>".as_slice()),
            ("video/mp4", b"not really an MP4 either".as_slice()),
        ] {
            let dir = centraid_ontology::scratch::scratch_dir();
            let store = crate::bytes::FsBlobStore::open(dir.join("blobs")).expect("a store");
            let hash = store.put(bytes).expect("stored");
            let vault = founded(&dir);
            photograph(
                &vault,
                "p1",
                "2026-01-01T00:00:00.000Z",
                &hash,
                29,
                media_type,
                None,
            );
            let vault = vault.with_blobs(Box::new(store));
            let answer = vault
                .keyset_page(&KeysetPage {
                    held_thumbnail: true,
                    ..page("photo", &["id", "taken_at"], "taken_at", "id")
                })
                .expect("it serves");
            assert_eq!(
                answer.rows[0].get(HELD_THUMBNAIL_COLUMN),
                Some(&Value::Null),
                "{media_type} must not come back as a path"
            );
            // "Held" and "drawable" are two facts, which is why they are two columns.
            assert_eq!(
                answer.rows[0].get(HELD_ORIGINAL_HELD_COLUMN),
                Some(&Value::Integer(1))
            );
            let _ = std::fs::remove_dir_all(&dir);
        }
    }

    /// A DOOR THAT HOLDS ONLY LIBRARY ITEMS: every hash it was given is in the
    /// operating system's library under an identifier, and none has a file.
    struct LibraryOnly(std::collections::BTreeMap<String, String>);

    impl crate::bytes::BlobStore for LibraryOnly {
        fn put(&self, _: &[u8]) -> crate::bytes::Result<String> {
            Err(crate::bytes::BlobError::InvalidId(
                "a library takes nothing".to_owned(),
            ))
        }
        fn get(&self, id: &str) -> crate::bytes::Result<Vec<u8>> {
            Err(crate::bytes::BlobError::NotFound { id: id.to_owned() })
        }
        fn has(&self, _: &str) -> crate::bytes::Result<bool> {
            Ok(false)
        }
        fn ids(&self) -> crate::bytes::Result<std::collections::BTreeSet<String>> {
            Ok(std::collections::BTreeSet::new())
        }
        fn size(&self, id: &str) -> crate::bytes::Result<u64> {
            Err(crate::bytes::BlobError::NotFound { id: id.to_owned() })
        }
        fn path_of(&self, _: &str) -> crate::bytes::Result<Option<std::path::PathBuf>> {
            Ok(None)
        }
        fn locate(&self, id: &str) -> crate::bytes::Result<crate::bytes::Located> {
            Ok(self
                .0
                .get(id)
                .map_or(crate::bytes::Located::Nowhere, |os_ref| {
                    crate::bytes::Located::OsLibrary(os_ref.clone())
                }))
        }
    }

    /// AN ORIGINAL THE LIBRARY HOLDS IS HELD, AND HAS NO PATH (#1080 ruling 6):
    /// `original_held` is 1 and the thumbnail column, which falls back to the
    /// original, stays NULL. One the library does not hold is not held at all.
    #[test]
    fn an_original_the_library_holds_is_held_and_has_no_path() {
        let dir = centraid_ontology::scratch::scratch_dir();
        let in_library = crate::blob::content_digest(b"a camera original");
        let elsewhere = crate::blob::content_digest(b"an original on another phone");
        let vault = founded(&dir);
        photograph(
            &vault,
            "c1",
            "2026-01-01T00:00:00.000Z",
            &in_library,
            17,
            "image/jpeg",
            None,
        );
        photograph(
            &vault,
            "c2",
            "2026-01-02T00:00:00.000Z",
            &elsewhere,
            17,
            "image/jpeg",
            None,
        );
        let vault = vault.with_blobs(Box::new(LibraryOnly(
            [(in_library, "library-item-1".to_owned())]
                .into_iter()
                .collect(),
        )));
        let answer = vault
            .keyset_page(&KeysetPage {
                held_thumbnail: true,
                ..page("photo", &["id", "taken_at"], "taken_at", "id")
            })
            .expect("it serves");
        let held: Vec<(Option<&Value>, Option<&Value>)> = answer
            .rows
            .iter()
            .map(|row| {
                (
                    row.get(HELD_THUMBNAIL_COLUMN),
                    row.get(HELD_ORIGINAL_HELD_COLUMN),
                )
            })
            .collect();
        assert_eq!(
            held,
            vec![
                (Some(&Value::Null), Some(&Value::Integer(1))),
                (Some(&Value::Null), Some(&Value::Integer(0))),
            ]
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_zero_limit_and_a_missing_order_column_are_both_refused() {
        let dir = centraid_ontology::scratch::scratch_dir();
        let vault = founded(&dir);
        let base = page("entity", &["id", "created_at"], "created_at", "id");
        assert!(vault.keyset_page(&base).is_ok());

        let zero = KeysetPage {
            limit: 0,
            ..base.clone()
        };
        assert!(vault.keyset_page(&zero).is_err());

        let unprojected = KeysetPage {
            select: vec!["id".to_owned()],
            ..base.clone()
        };
        let error = vault
            .keyset_page(&unprojected)
            .expect_err("an order column outside the projection is refused");
        assert!(error.to_string().contains("created_at"));

        let nothing = KeysetPage {
            select: Vec::new(),
            ..base
        };
        assert!(vault.keyset_page(&nothing).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// `limit` rows and a cursor when more follow; fewer and none when the rows
    /// end, including exactly at the ceiling.
    #[test]
    fn the_cursor_is_absent_when_the_rows_end_and_present_when_they_do_not() {
        let dir = centraid_ontology::scratch::scratch_dir();
        let vault = founded(&dir);
        let now = vault.clock().now_text();
        vault
            .commit(|tx| {
                for index in 0..4 {
                    tx.insert_entity(
                        &format!("t{index}"),
                        crate::model::Kind::Tag,
                        &format!("tag {index}"),
                        &now,
                    )?;
                    tx.connection().execute(
                        "INSERT INTO concept (id, kind, key) VALUES (?1, 'tag', ?2)",
                        rusqlite::params![format!("t{index}"), format!("k{index}")],
                    )?;
                }
                Ok(())
            })
            .expect("tags land");
        let asked = |limit, after| KeysetPage {
            limit,
            after,
            predicate: Some("kind = 'tag' AND id LIKE 't%'".to_owned()),
            ..page("entity", &["id", "created_at"], "created_at", "id")
        };
        let first = vault.keyset_page(&asked(3, None)).expect("page one");
        assert_eq!(first.rows.len(), 3);
        let next = first.next.expect("more follow");
        let second = vault.keyset_page(&asked(3, Some(next))).expect("page two");
        assert_eq!(second.rows.len(), 1);
        assert!(second.next.is_none(), "the rows ended");
        let exact = vault
            .keyset_page(&asked(4, None))
            .expect("exactly the rows");
        assert_eq!(exact.rows.len(), 4);
        assert!(
            exact.next.is_none(),
            "a full page that ends the rows has no cursor"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_page_asked_at_the_ceiling_still_says_more_rows_follow() {
        let dir = centraid_ontology::scratch::scratch_dir();
        let vault = founded(&dir);
        let now = vault.clock().now_text();
        let rows = usize::try_from(MAX_PAGE_ROWS).unwrap_or(500) + 3;
        vault
            .commit(|tx| {
                for index in 0..rows {
                    tx.insert_entity(&format!("n{index:05}"), crate::model::Kind::Tag, "t", &now)?;
                    tx.connection().execute(
                        "INSERT INTO concept (id, kind, key) VALUES (?1, 'tag', ?1)",
                        [format!("n{index:05}")],
                    )?;
                }
                Ok(())
            })
            .expect("tags land");
        let answer = vault
            .keyset_page(&KeysetPage {
                limit: MAX_PAGE_ROWS + 100,
                predicate: Some("id LIKE 'n%'".to_owned()),
                ..page("entity", &["id", "created_at"], "created_at", "id")
            })
            .expect("it serves");
        assert_eq!(i64::try_from(answer.rows.len()).unwrap_or(0), MAX_PAGE_ROWS);
        assert!(
            answer.next.is_some(),
            "the ceiling is not the end of the rows"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_byte_count_is_said_the_way_the_corpus_says_it() {
        for (count, said) in [
            (0_i64, "0 bytes"),
            (1, "1 byte"),
            (2, "2 bytes"),
            (999, "999 bytes"),
            // THE KILOBYTE RUNG, exactly: a three-hundred-byte note is
            // "312 bytes" and not "0 KB".
            (1_000, "1 KB"),
            (880_000, "880 KB"),
            (999_999, "999 KB"),
            (1_000_000, "1.0 MB"),
            (1_200_000, "1.2 MB"),
            // ROUNDED, NOT TRUNCATED.
            (1_999_999, "2.0 MB"),
            (4_100_000, "4.1 MB"),
            (999_999_999, "1.0 GB"),
            (1_000_000_000, "1.0 GB"),
            (84_200_000_000, "84.2 GB"),
        ] {
            assert_eq!(format_byte_size(count), said, "{count} was said wrong");
        }
        // A NEGATIVE COUNT CANNOT REACH HERE (`blob.size` is CHECKed >= 0) and
        // it is clamped rather than panicking.
        assert_eq!(format_byte_size(-1), "0 bytes");
    }

    /// A DOCUMENTS PAGE CARRIES THE SIZE THE DOCUMENT ACTUALLY IS, AS WORDS, and
    /// never the byte count: the contract is a phrase.
    #[test]
    fn a_document_page_says_its_size_and_never_hands_out_the_byte_count() {
        let dir = centraid_ontology::scratch::scratch_dir();
        let vault = founded(&dir);
        let now = vault.clock().now_text();
        let hash = crate::blob::content_digest(b"some bytes");
        vault
            .commit(|tx| {
                crate::blob::stage(tx.connection(), &hash, 880_000)?;
                tx.insert_entity("d1", crate::model::Kind::Document, "Report", &now)?;
                tx.connection().execute(
                    "INSERT INTO document (id, blob, media_type) VALUES ('d1', ?1, 'application/pdf')",
                    [&hash],
                )?;
                Ok(())
            })
            .expect("the document lands");
        let answer = vault
            .keyset_page(&KeysetPage {
                document_size: true,
                ..page("document", &["id"], "id", "id")
            })
            .expect("it serves");
        let row = &answer.rows[0];
        assert_eq!(
            row.get(DOCUMENT_SIZE_COLUMN),
            Some(&Value::Text("880 KB".to_owned()))
        );
        assert!(
            row.get(DOCUMENT_BYTES_COLUMN).is_none(),
            "the integer does not escape"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A SIZE OR A THUMBNAIL ASKED OF A TABLE THAT HAS NO `blob` IS REFUSED AT
    /// PREPARE, never answered NULL for every row.
    #[test]
    fn a_computed_column_asked_of_a_table_that_has_no_blob_is_refused() {
        let dir = centraid_ontology::scratch::scratch_dir();
        let vault = founded(&dir);
        for asked in [
            KeysetPage {
                document_size: true,
                ..page("entity", &["id"], "id", "id")
            },
            KeysetPage {
                held_thumbnail: true,
                ..page("entity", &["id"], "id", "id")
            },
        ] {
            vault
                .keyset_page(&asked)
                .expect_err("a table with no `blob` cannot be asked for one");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_presence_test_is_projected_as_one_and_anything_else_as_a_name() {
        assert_eq!(
            projected("otp_seed IS NOT NULL AS has_totp"),
            "(\"otp_seed\" IS NOT NULL) AS \"has_totp\""
        );
        assert_eq!(projected("title"), crate::log::quoted("title"));
        // Not an identifier on either side: quoted whole, so it reads as a
        // name that does not exist rather than as SQL.
        assert_eq!(
            projected("x; IS NOT NULL AS y"),
            crate::log::quoted("x; IS NOT NULL AS y")
        );
    }

    /// ONE KEY OUT OF A JSON CELL is spelled as SQL, and nothing near it is: a
    /// path with a quote, a second statement or a non-identifier name is quoted
    /// whole and reads as a name that does not exist.
    #[test]
    fn a_json_key_is_projected_as_one_and_a_near_miss_as_a_name() {
        assert_eq!(
            projected("json_extract(exif, '$.make') AS make"),
            "json_extract(\"exif\", '$.make') AS \"make\""
        );
        for near_miss in [
            "json_extract(exif, '$.a'') AS b",
            "json_extract(exif, '$.a') AS b; DROP",
            "json_extract(exif, 'a') AS b",
            "json_extract(exif json, '$.a') AS b",
            "json_extract(exif, '$.a')",
        ] {
            assert_eq!(
                projected(near_miss),
                crate::log::quoted(near_miss),
                "{near_miss}"
            );
        }
    }

    /// AND THE VAULT READS IT: a key in a photograph's `exif` bag comes back as
    /// its text.
    #[test]
    fn a_json_key_reads_back_through_the_page_door() {
        let dir = centraid_ontology::scratch::scratch_dir();
        let vault = founded(&dir);
        photograph(
            &vault,
            "p1",
            "2026-01-01T00:00:00.000Z",
            &crate::blob::content_digest(b"x"),
            1,
            "image/jpeg",
            None,
        );
        vault
            .commit(|tx| {
                tx.connection()
                    .execute("UPDATE photo SET exif = '{\"make\":\"Acme\"}'", [])?;
                Ok(())
            })
            .expect("the exif is written");
        let answer = vault
            .keyset_page(&page(
                "photo",
                &["id", "json_extract(exif, '$.make') AS make"],
                "id",
                "id",
            ))
            .expect("the page reads");
        assert_eq!(
            answer.rows[0].get("make"),
            Some(&Value::Text("Acme".to_owned()))
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
