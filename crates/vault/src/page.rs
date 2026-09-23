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
        if page.limit < 1 {
            return Err(VaultError::Invariant {
                context: "a page limit is required; a default is how an unbounded read gets written by accident".to_owned(),
            });
        }
        let limit = page.limit.min(MAX_PAGE_ROWS);
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
    /// APPEND A `body_text` COLUMN from `core_content_text` (#1025, R-NOTES-1).
    /// See [`NOTE_BODY_COLUMN`].
    pub note_body: bool,
    /// APPEND A `document_size` COLUMN — the row's bytes, ALREADY IN WORDS.
    /// See [`DOCUMENT_SIZE_COLUMN`].
    pub document_size: bool,
}

/// The computed column [`KeysetPage::held_thumbnail`] appends, and the whole of
/// the join behind it.
///
/// **A correlated subquery and not a `LEFT JOIN`**, which is the same answer
/// and is the only one that cannot change the page: a join through
/// `core_content_derivative` multiplies a row by its derivatives, and a grid
/// whose page silently held two of one photograph would break its own keyset
/// cursor. One value per row, ordering and row count untouched.
///
/// **The tier, and the fallback that makes v0 work.** `thumb` first, then
/// `poster` — a video's frame is a `poster` and a photograph's is a `thumb` —
/// and when no derivative row exists at all the ORIGINAL's hash is used. Every
/// vault seeded from originals is that case; without the fallback the whole
/// feature draws nothing on the only libraries that exist today.
///
/// **THE DRAWABILITY RULE SURVIVED ITS TABLE.** `drawable = 1` was decided
/// where the path was produced (`centraid_seat::held`) and read here as a
/// column. With that plane deleted the rule is applied in
/// [`Vault::resolve_held_bytes`], against the same list `content.read` serves
/// inline by — still one predicate in one place, and still not something a
/// caller's statement can express.
///
/// **THE PATH COMES FROM THE CONTENT STORE, NOT FROM A TABLE** (#1029 §1).
///
/// **THE `from` TABLE MUST CARRY `content_id`, AND ONE THAT DOES NOT IS REFUSED
/// AT PREPARE** — the correlated subquery's outer reference is resolved before
/// any row is read, so there is no "reports no thumbnail for every row" to
/// fall back to. `query.proto` promised that fallback and has been corrected;
/// `a_thumbnail_column_asked_of_a_table_that_has_no_content_is_refused` is the
/// check. See [`DOCUMENT_SIZE_COLUMN`] for why this end is the right one.
///
/// This used to join `seat_blob_held`, a seat-owned table carrying a path and a
/// `drawable` flag per blob. The seat plane went with the gateway and **the
/// table went with it — nothing in the migration ladder creates it any more**,
/// so this statement referenced a relation no vault has and every read that
/// asked for a thumbnail failed at prepare. Home graded Photos as an app with
/// nothing in it and offered "Bring in photos" over a library of nineteen; the
/// grid drew placeholders. Nothing logged, because a refused tile read and an
/// empty one look the same to a grid that has only rows to go on.
///
/// So the statement now projects the candidate HASH and its media type, and
/// [`Vault::resolve_held_bytes`] asks the byte store for the path — the same
/// two steps [`Vault::content_location`] takes for one item. It stays opt-in
/// per query because it costs a store lookup per row, which a list of notes
/// has no use for.
pub const HELD_THUMBNAIL_COLUMN: &str = "thumbnail_path";

/// The hash the thumbnail lookup will try, projected by the statement and
/// REMOVED from the row before it is served.
///
/// A working column: the caller's contract is [`HELD_THUMBNAIL_COLUMN`] and a
/// sha in a row image is a second, unpromised way for a shell to reach one.
const DRAWABLE_HASH_COLUMN: &str = "drawable_hash";

/// The media type of whatever [`DRAWABLE_HASH_COLUMN`] names — the derivative's
/// own, or the item's representation when the fallback took the original.
/// Removed from the row with it; see [`Vault::resolve_held_bytes`] for why it
/// is read at all.
const DRAWABLE_TYPE_COLUMN: &str = "drawable_type";

/// THE ORIGINAL'S OWN HASH, appended beside [`HELD_THUMBNAIL_COLUMN`]
/// (#1025 S5, D-1025-S7-62).
///
/// `core_content_item.content_hash` for the row's content — NOT the derivative
/// the thumbnail resolved to. It is what a download arrow names when a member
/// taps it, and a cell that offered to fetch the thumbnail it is already
/// drawing would be an affordance that does nothing.
///
/// NULL when this replica has no live content row for the asset, which is a
/// real state and not an error: a cell with no original to ask for draws no
/// arrow.
pub const HELD_ORIGINAL_HASH_COLUMN: &str = "original_hash";

/// WHETHER THE ORIGINAL ITSELF IS ON THIS DEVICE, 1 or 0.
///
/// The one fact that separates "held" from "thumbnail only", and it cannot be
/// inferred from [`HELD_THUMBNAIL_COLUMN`]: the thumbnail column falls back to
/// the ORIGINAL's hash on a vault with no derivative rows, so a path there
/// means the original on some libraries and a `thumb` on others. A cell that
/// guessed would tell a member their full-size photograph is on the device
/// whenever a thumbnail was.
///
/// **`drawable` is deliberately NOT part of this predicate.** A held video is
/// held; what `drawable` governs is whether a PATH may be handed out, and this
/// column hands out no path.
pub const HELD_ORIGINAL_HELD_COLUMN: &str = "original_held";

/// The computed column [`KeysetPage::note_body`] appends (#1025, R-NOTES-1).
///
/// **A correlated subquery and not a `LEFT JOIN`**, for the same reason as
/// [`HELD_THUMBNAIL_COLUMN`]: a join through `core_content_text` is one-to-one
/// today, and a subquery keeps the page's row count honest if that ever
/// changes. One value per row, ordering untouched.
///
/// **Text is a row, not a blob.** `core_content_text.body_text` is what the
/// replica holds for a note; `seat_blob_held` is the wrong door. NULL means
/// this device has no text row for the note's `body_content_id`.
///
/// **THE `from` TABLE MUST CARRY `body_content_id`, AND ONE THAT DOES NOT IS
/// REFUSED AT PREPARE.** This comment used to promise the gentler thing — "one
/// that does not simply answers NULL for every row" — and `query.proto`
/// promised it to every caller of the door. It was never true and could not
/// have been: the subquery is CORRELATED, so `{from}.body_content_id` is an
/// outer reference SQLite resolves while it PREPARES the statement, before a
/// single row is read. There is no row loop in which to answer NULL. Checked by
/// `a_note_body_column_asked_of_a_table_that_has_no_body_is_refused`, which is
/// the test [`DOCUMENT_SIZE_COLUMN`] asked for and did not run.
///
/// That is the right end to fail at, for the reason that column states: a flag
/// set on the wrong table is a caller's bug, and a read that goes quiet is a
/// screen nobody can debug.
pub const NOTE_BODY_COLUMN: &str = "body_text";

/// The computed column [`KeysetPage::document_size`] appends — **a phrase, not
/// a number** (#1029, Home's Docs tile).
///
/// **The contract is a formatted string and it always was.**
/// `TileBody.Docs.Row.size` says "already formatted by the core, which knows
/// the vault's locale; never formatted in a view from a byte count", and both
/// shells honour it: they draw this column's text in the `annot` role and draw
/// NOTHING when it is empty. What the core never had was anything to format —
/// the door offered no size column at all, so the only honest thing
/// the shell could put in the field was the empty string it has been putting
/// there, and the tile drew a bare list against a handoff that rules a trailing
/// meta column. A projection that answers a question no caller can ask is the
/// same defect as a statement naming a table no vault has ([`HELD_THUMBNAIL_COLUMN`]),
/// read from the other end: nothing fails, and the screen is wrong.
///
/// **A correlated subquery and not a `LEFT JOIN`**, for the reason
/// [`NOTE_BODY_COLUMN`] states: one value per row, row count and ordering
/// untouched whatever the content plane grows into.
///
/// **THE BYTES ARE THE CURRENT REVISION'S, NOT THE DOCUMENT'S.** A document has
/// no size of its own — `core_document.current_content_id` names the
/// `core_content_item` that IS the document right now, and that row's
/// `byte_size` is what `core.add_document` wrote from the bytes it stored. So
/// an edited document reports the edit's size and not the original's, which is
/// the only answer that matches what opening it would show.
///
/// `deleted_at IS NULL` on the content row, because a tombstoned item is not
/// bytes a member has.
///
/// **NULL IS A REAL ANSWER AND IS NOT A ZERO.** A document whose content item
/// has been tombstoned answers NULL, the shell sees an empty string, and the
/// meta column is simply not drawn. "0 bytes" would be a claim about a file
/// nobody has.
///
/// **THE `from` TABLE MUST CARRY `current_content_id`, AND ONE THAT DOES NOT IS
/// REFUSED AT PREPARE.** Said plainly, and checked by
/// `a_size_column_asked_of_a_table_that_has_no_content_is_refused`: SQLite
/// resolves the outer reference when it prepares a correlated subquery, so the
/// page FAILS rather than answering NULL for every row. That is the right end
/// to fail at — a flag set on the wrong table is a caller bug, and the failure
/// this whole column exists to undo was a read that went quiet.
///
/// [`NOTE_BODY_COLUMN`] and [`HELD_THUMBNAIL_COLUMN`] are the same construction,
/// and their doc comments used to claim the gentler thing ("simply answers NULL
/// for every row"). This comment said the claim was worth a test of its own
/// rather than a reader's trust, and that test has now been written for both:
/// `a_note_body_column_asked_of_a_table_that_has_no_body_is_refused` and
/// `a_thumbnail_column_asked_of_a_table_that_has_no_content_is_refused`. **Both
/// are refused at prepare, exactly as this one is.** The mechanism was one
/// mechanism all along; what differed was only which of the three comments had
/// been checked. All three, and `query.proto`'s copies of them, now say so.
pub const DOCUMENT_SIZE_COLUMN: &str = "document_size";

/// The byte count the statement projects, TURNED INTO WORDS AND REMOVED.
///
/// A working column, exactly like [`DRAWABLE_HASH_COLUMN`]: the caller's
/// contract is [`DOCUMENT_SIZE_COLUMN`], and an integer left beside it would be
/// a second, unpromised way for a shell to reach a byte count — which is the
/// one thing the field's own comment forbids. Serving both would make the rule
/// advice instead of a shape.
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

/// One page of rows, plus the cursor to ask from next.
#[derive(Debug, Clone)]
pub struct KeysetAnswer {
    pub rows: Vec<RowImage>,
    /// **Absent when the rows ended.** Never a `truncated` flag and never a
    /// cursor that points past the end.
    pub next: Option<(String, String)>,
}

impl Vault {
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
            .map(|column| crate::log::quoted(column))
            .collect::<Vec<_>>()
            .join(", ");
        let thumbnail = if page.held_thumbnail {
            // THE HASHES AND THE TYPE, IN SQL; THE PATH IN RUST. See
            // [`HELD_THUMBNAIL_COLUMN`] for why the store is asked afterwards
            // rather than joined here.
            format!(
                ", COALESCE(
                       (SELECT d.content_hash
                          FROM core_content_derivative d
                         WHERE d.content_id = {from}.content_id
                           AND d.variant IN ('thumb', 'poster')
                           AND d.content_hash IS NOT NULL
                         ORDER BY CASE d.variant WHEN 'thumb' THEN 0 ELSE 1 END
                         LIMIT 1),
                       (SELECT i.content_hash
                          FROM core_content_item i
                         WHERE i.content_id = {from}.content_id
                           AND i.deleted_at IS NULL)
                   ) AS {drawable_hash}
                 , COALESCE(
                       (SELECT d.media_type
                          FROM core_content_derivative d
                         WHERE d.content_id = {from}.content_id
                           AND d.variant IN ('thumb', 'poster')
                           AND d.content_hash IS NOT NULL
                         ORDER BY CASE d.variant WHEN 'thumb' THEN 0 ELSE 1 END
                         LIMIT 1),
                       (SELECT r.media_type
                          FROM core_content_representation r
                         WHERE r.content_id = {from}.content_id
                         LIMIT 1)
                   ) AS {drawable_type}
                 , (SELECT i.content_hash
                      FROM core_content_item i
                     WHERE i.content_id = {from}.content_id
                       AND i.deleted_at IS NULL) AS {hash_column}",
                from = crate::log::quoted(&page.from),
                drawable_hash = crate::log::quoted(DRAWABLE_HASH_COLUMN),
                drawable_type = crate::log::quoted(DRAWABLE_TYPE_COLUMN),
                hash_column = crate::log::quoted(HELD_ORIGINAL_HASH_COLUMN),
            )
        } else {
            String::new()
        };
        let note_body = if page.note_body {
            format!(
                ", (SELECT t.body_text FROM core_content_text t
                      WHERE t.content_id = {from}.body_content_id
                   ) AS {column}",
                from = crate::log::quoted(&page.from),
                column = crate::log::quoted(NOTE_BODY_COLUMN),
            )
        } else {
            String::new()
        };
        let document_size = if page.document_size {
            // THE BYTES OF WHAT THE DOCUMENT IS NOW. `current_content_id` is
            // the one hop from a wrapper to its content item. A `from` table
            // that has no such column is REFUSED here, at prepare — see
            // [`DOCUMENT_SIZE_COLUMN`] for why that is the right end to fail
            // at and why the neighbouring comments' gentler claim is wrong.
            format!(
                ", (SELECT i.byte_size FROM core_content_item i
                      WHERE i.content_id = {from}.current_content_id
                        AND i.deleted_at IS NULL
                   ) AS {column}",
                from = crate::log::quoted(&page.from),
                column = crate::log::quoted(DOCUMENT_BYTES_COLUMN),
            )
        } else {
            String::new()
        };
        let sql = format!(
            "SELECT {projection}{thumbnail}{note_body}{document_size} FROM {from}{predicate} \
             ORDER BY {sort} {direction}, {pk} {direction} LIMIT {probe}",
            from = crate::log::quoted(&page.from),
            sort = crate::log::quoted(&page.sort_column),
            pk = crate::log::quoted(&page.pk_column),
            probe = limit + 1,
        );

        let mut rows = self.page_raw(&RawPage {
            sql,
            binds,
            limit: limit + 1,
        })?;
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

            let held = original
                .as_deref()
                .and_then(|hash| blobs.and_then(|store| store.path_of(hash).ok().flatten()))
                .is_some();
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
    crate::content::may_serve_inline(media_type)
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
    use crate::backup::store::BlobStore as _;

    /// A THUMBNAIL READ REACHES THE BYTE STORE, AND THE STATEMENT PREPARES.
    ///
    /// The regression is the prepare: this projection joined `seat_blob_held`,
    /// which the seat plane took with it (#1029 §1), so **every** read that
    /// asked for a thumbnail failed against **every** vault — Home graded
    /// Photos empty over a library of nineteen and offered "Bring in photos".
    /// A page over an empty table would have caught it, so the first assertion
    /// here is exactly that; the rest proves the path a cell actually draws.
    #[test]
    fn a_held_thumbnail_page_prepares_and_resolves_a_path_from_the_store() {
        let dir = centraid_ontology::golden::scratch_dir();
        std::fs::create_dir_all(&dir).expect("the directory is made");
        let store_dir = dir.join("blobs");
        let store = crate::backup::store::FsBlobStore::open(&store_dir).expect("a blob store");
        let bytes = b"not really a JPEG, and the store does not care";
        let hash = store.put(bytes).expect("the bytes are stored");

        let vault = Vault::create(dir.join("v.db")).expect("a vault");
        vault.found("T", "O").expect("founded");

        let page = KeysetPage {
            name: "content".to_owned(),
            select: vec!["content_id".to_owned(), "created_at".to_owned()],
            from: "core_content_item".to_owned(),
            predicate: None,
            binds: Vec::new(),
            sort_column: "created_at".to_owned(),
            pk_column: "content_id".to_owned(),
            descending: true,
            limit: 10,
            after: None,
            held_thumbnail: true,
            note_body: false,
            document_size: false,
        };
        // THE PREPARE, ON AN EMPTY TABLE. This is the whole of the defect: a
        // statement naming a relation no vault has does not need a row to fail.
        let empty = vault
            .keyset_page(&page)
            .expect("a held-thumbnail page prepares on a founded vault");
        assert!(empty.rows.is_empty(), "a founded vault holds no content");

        // ONE ITEM, WHOSE BYTES THE STORE HOLDS. Written through the replica
        // door because this is a row a command plane would author and the test
        // is about the READ.
        vault
            .apply_replica(|connection| {
                // The supertype row first: `content_id` is an entity id.
                connection.execute(
                    "INSERT INTO core_entity (entity_id, entity_type, created_at)
                     VALUES ('c1', 'core.content_item', '2026-01-01T00:00:00.000Z')",
                    [],
                )?;
                connection.execute(
                    "INSERT INTO core_content_item
                       (content_id, content_uri, content_hash, byte_size, created_at)
                     VALUES ('c1', ?1, ?2, ?3, '2026-01-01T00:00:00.000Z')",
                    rusqlite::params![
                        format!("blob:{hash}"),
                        hash,
                        i64::try_from(bytes.len()).unwrap_or_default()
                    ],
                )?;
                // ITS THUMBNAIL TIER, which is what a photo library holds and
                // what the statement prefers. The `core_entity` row for the
                // derivative is the table's own trigger's business.
                connection.execute(
                    "INSERT INTO core_content_derivative
                       (derivative_id, content_id, variant, content_hash,
                        media_type, byte_size, created_at, updated_at)
                     VALUES ('d1', 'c1', 'thumb', ?1, 'image/jpeg', ?2,
                             '2026-01-01T00:00:00.000Z',
                             '2026-01-01T00:00:00.000Z')",
                    rusqlite::params![hash, i64::try_from(bytes.len()).unwrap_or_default()],
                )?;
                Ok(())
            })
            .expect("the fixture rows land");

        // NO STORE, NO PATH, AND NO FAILURE. A vault with no byte door is the
        // ordinary text-only case and the page still serves its rows.
        let doorless = vault.keyset_page(&page).expect("it serves without a store");
        assert_eq!(doorless.rows.len(), 1);
        assert_eq!(
            doorless.rows[0].get(HELD_THUMBNAIL_COLUMN),
            Some(&Value::Null),
            "a vault with no store has no path to give"
        );

        let vault = vault.with_blobs(Box::new(store));
        let answer = vault.keyset_page(&page).expect("it serves with a store");
        let row = &answer.rows[0];
        let Some(Value::Text(path)) = row.get(HELD_THUMBNAIL_COLUMN) else {
            panic!("the thumbnail did not resolve: {row:?}");
        };
        assert!(
            std::path::Path::new(path).exists(),
            "the path handed to a grid does not exist: {path}"
        );
        assert_eq!(
            row.get(HELD_ORIGINAL_HASH_COLUMN),
            Some(&Value::Text(hash.clone())),
            "the original's own hash rides beside the thumbnail"
        );
        assert_eq!(
            row.get(HELD_ORIGINAL_HELD_COLUMN),
            Some(&Value::Integer(1)),
            "this device holds the original"
        );
        // THE WORKING COLUMNS DO NOT ESCAPE. A sha in a row image is a second,
        // unpromised way for a shell to reach one.
        assert!(row.get(DRAWABLE_HASH_COLUMN).is_none());
        assert!(row.get(DRAWABLE_TYPE_COLUMN).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// WHAT `drawable = 1` USED TO REFUSE, THE TYPE REFUSES NOW.
    ///
    /// The bytes are held and the row is served; what a grid does NOT get is a
    /// path it would hand to a web view. The rule outlived the table it was
    /// stored in.
    #[test]
    fn a_reading_no_surface_may_embed_gets_no_path_though_the_bytes_are_held() {
        for (media_type, bytes) in [
            // MARKUP: the security half. A path here is one a surface could be
            // asked to render as a document.
            ("text/html", b"<html>not a photograph</html>".as_slice()),
            // A VIDEO WITH NO POSTER: the honesty half. The bytes are held and
            // are safe to serve; an image view still cannot draw them, and the
            // demo library has exactly this asset.
            ("video/mp4", b"not really an MP4 either".as_slice()),
        ] {
            no_path_for(media_type, bytes);
        }
    }

    /// One vault holding one item of `media_type`, asserted to yield no
    /// thumbnail path and to report the original as held.
    fn no_path_for(media_type: &str, bytes: &[u8]) {
        let dir = centraid_ontology::golden::scratch_dir();
        std::fs::create_dir_all(&dir).expect("the directory is made");
        let store = crate::backup::store::FsBlobStore::open(dir.join("blobs")).expect("a store");
        let hash = store.put(bytes).expect("stored");

        let vault = Vault::create(dir.join("v.db")).expect("a vault");
        vault.found("T", "O").expect("founded");
        vault
            .apply_replica(|connection| {
                // The supertype row first: `content_id` is an entity id.
                connection.execute(
                    "INSERT INTO core_entity (entity_id, entity_type, created_at)
                     VALUES ('c1', 'core.content_item', '2026-01-01T00:00:00.000Z')",
                    [],
                )?;
                connection.execute(
                    "INSERT INTO core_content_item
                       (content_id, content_uri, content_hash, byte_size, created_at)
                     VALUES ('c1', ?1, ?2, 29, '2026-01-01T00:00:00.000Z')",
                    rusqlite::params![format!("blob:{hash}"), hash],
                )?;
                connection.execute(
                    "INSERT INTO core_content_derivative
                       (derivative_id, content_id, variant, content_hash,
                        media_type, byte_size, created_at, updated_at)
                     VALUES ('d1', 'c1', 'thumb', ?1, ?2, 29,
                             '2026-01-01T00:00:00.000Z',
                             '2026-01-01T00:00:00.000Z')",
                    rusqlite::params![hash, media_type],
                )?;
                Ok(())
            })
            .expect("the fixture rows land");

        let vault = vault.with_blobs(Box::new(store));
        let answer = vault
            .keyset_page(&KeysetPage {
                name: "content".to_owned(),
                select: vec!["content_id".to_owned(), "created_at".to_owned()],
                from: "core_content_item".to_owned(),
                predicate: None,
                binds: Vec::new(),
                sort_column: "created_at".to_owned(),
                pk_column: "content_id".to_owned(),
                descending: true,
                limit: 10,
                after: None,
                held_thumbnail: true,
                note_body: false,
                document_size: false,
            })
            .expect("it serves");
        assert_eq!(
            answer.rows[0].get(HELD_THUMBNAIL_COLUMN),
            Some(&Value::Null),
            "{media_type} must not come back as a path"
        );
        // AND THE HOLDING IS STILL REPORTED. "Held" and "drawable" are two
        // different facts, which is why they are two columns.
        assert_eq!(
            answer.rows[0].get(HELD_ORIGINAL_HELD_COLUMN),
            Some(&Value::Integer(1))
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_zero_limit_and_a_missing_order_column_are_both_refused() {
        let dir = centraid_ontology::golden::scratch_dir();
        std::fs::create_dir_all(&dir).expect("the directory is made");
        let vault = Vault::create(dir.join("v.db")).expect("a vault");
        vault.found("T", "O").expect("founded");

        let base = KeysetPage {
            name: "parties".to_owned(),
            select: vec!["party_id".to_owned(), "created_at".to_owned()],
            from: "core_party".to_owned(),
            predicate: None,
            binds: Vec::new(),
            sort_column: "created_at".to_owned(),
            pk_column: "party_id".to_owned(),
            descending: false,
            limit: 10,
            after: None,
            held_thumbnail: false,
            note_body: false,
            document_size: false,
        };
        assert!(vault.keyset_page(&base).is_ok());

        let mut zero = base.clone();
        zero.limit = 0;
        assert!(vault.keyset_page(&zero).is_err());

        let mut unprojected = base.clone();
        unprojected.select = vec!["party_id".to_owned()];
        let error = vault
            .keyset_page(&unprojected)
            .expect_err("an order column outside the projection is refused");
        assert!(error.to_string().contains("created_at"));

        let mut nothing = base;
        nothing.select = Vec::new();
        assert!(vault.keyset_page(&nothing).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_cursor_is_absent_when_the_rows_end_and_present_when_they_do_not() {
        let dir = centraid_ontology::golden::scratch_dir();
        std::fs::create_dir_all(&dir).expect("made");
        let vault = Vault::create(dir.join("v.db")).expect("a vault");
        vault.found("T", "O").expect("founded");
        let registry = crate::commands::Registry::with_system_commands().expect("registry");
        let principal = crate::access::Principal::owner("d1");
        for index in 0..5 {
            vault
                .execute(
                    &registry,
                    &principal,
                    &crate::commands::Command::new(
                        "core.add_party",
                        serde_json::json!({ "display_name": format!("P{index}"), "kind": "person" }),
                    ),
                )
                .expect("the command executes");
        }

        let base = KeysetPage {
            name: "parties".to_owned(),
            select: vec!["party_id".to_owned(), "created_at".to_owned()],
            from: "core_party".to_owned(),
            predicate: None,
            binds: Vec::new(),
            sort_column: "created_at".to_owned(),
            pk_column: "party_id".to_owned(),
            descending: false,
            limit: 2,
            after: None,
            held_thumbnail: false,
            note_body: false,
            document_size: false,
        };
        let first = vault.keyset_page(&base).expect("a page serves");
        assert_eq!(first.rows.len(), 2);
        let cursor = first.next.clone().expect("there are more rows");

        // AND THE CURSOR WALKS: the second page starts after the first ends,
        // with no row served twice and none skipped.
        let mut second_query = base.clone();
        second_query.after = Some(cursor);
        let second = vault.keyset_page(&second_query).expect("a page serves");
        assert_eq!(second.rows.len(), 2);
        let first_ids: Vec<String> = first
            .rows
            .iter()
            .map(|row| cursor_text(row, "party_id"))
            .collect();
        let second_ids: Vec<String> = second
            .rows
            .iter()
            .map(|row| cursor_text(row, "party_id"))
            .collect();
        assert!(
            first_ids.iter().all(|id| !second_ids.contains(id)),
            "a row was served twice: {first_ids:?} / {second_ids:?}"
        );

        // The last page ends, and its cursor is ABSENT rather than pointing
        // past the end.
        let mut last = base;
        last.limit = 500;
        let whole = vault.keyset_page(&last).expect("a page serves");
        assert_eq!(whole.rows.len(), 6, "five parties plus the vault's owner");
        assert!(whole.next.is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn note_body_reads_core_content_text_and_null_when_absent() {
        // R-NOTES-1: text is a row. The appended column is the replica's
        // `core_content_text.body_text`, NULL when that row is missing.
        let dir = centraid_ontology::golden::scratch_dir();
        std::fs::create_dir_all(&dir).expect("made");
        let vault = Vault::create(dir.join("v.db")).expect("a vault");
        vault.found("T", "O").expect("founded");
        vault
            .apply_replica(|connection| {
                connection.execute_batch(
                    "INSERT OR IGNORE INTO core_entity_kind(kind) VALUES
                       ('knowledge.note'), ('core.content_item'), ('core.content_text');
                     INSERT INTO core_entity(entity_id, entity_type, created_at) VALUES
                       ('c-yes','core.content_item','2026-01-01T00:00:00Z'),
                       ('c-no','core.content_item','2026-01-01T00:00:00Z'),
                       ('n-yes','knowledge.note','2026-01-01T00:00:00Z'),
                       ('n-no','knowledge.note','2026-01-01T00:00:00Z');
                     INSERT INTO core_content_item
                       (content_id, content_uri, content_hash, byte_size, created_at) VALUES
                       ('c-yes','data:text/plain,milk',
                        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                        '4','2026-01-01T00:00:00Z'),
                       ('c-no','data:text/plain,gone',
                        'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
                        '4','2026-01-01T00:00:00Z');
                     INSERT INTO core_content_text
                       (content_id, body_text, decoder, byte_size, created_at, updated_at)
                       VALUES ('c-yes','milk and eggs','utf8',13,
                               '2026-01-01T00:00:00Z','2026-01-01T00:00:00Z');
                     INSERT INTO knowledge_note
                       (note_id, author_party_id, title, body_content_id, format, pinned,
                        created_at, updated_at) VALUES
                       ('n-yes', (SELECT party_id FROM core_party LIMIT 1), 'Yes', 'c-yes',
                        'plain', 0, '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z'),
                       ('n-no', (SELECT party_id FROM core_party LIMIT 1), 'No', 'c-no',
                        'plain', 0, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');",
                )?;
                Ok(())
            })
            .expect("fixture");

        let answer = vault
            .keyset_page(&KeysetPage {
                name: "notes.editor.note".to_owned(),
                select: vec![
                    "note_id".to_owned(),
                    "title".to_owned(),
                    "updated_at".to_owned(),
                ],
                from: "knowledge_note".to_owned(),
                predicate: Some("deleted_at IS NULL".to_owned()),
                binds: Vec::new(),
                sort_column: "updated_at".to_owned(),
                pk_column: "note_id".to_owned(),
                descending: true,
                limit: 10,
                after: None,
                held_thumbnail: false,
                note_body: true,
                document_size: false,
            })
            .expect("the page serves");
        assert_eq!(answer.rows.len(), 2);
        let by_id: std::collections::BTreeMap<_, _> = answer
            .rows
            .iter()
            .map(|row| {
                let id = match row.get("note_id") {
                    Some(Value::Text(text)) => text.clone(),
                    other => panic!("note_id is text, got {other:?}"),
                };
                let body = row.get(NOTE_BODY_COLUMN).cloned();
                (id, body)
            })
            .collect();
        assert_eq!(
            by_id.get("n-yes"),
            Some(&Some(Value::Text("milk and eggs".to_owned())))
        );
        assert_eq!(by_id.get("n-no"), Some(&Some(Value::Null)));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// THE PHRASE, AT EVERY RUNG AND ON BOTH SIDES OF EACH ONE.
    ///
    /// A table rather than a property because the rungs ARE the contract: the
    /// design corpus spells `880 KB`, `1.2 MB` and `84.2 GB`, and a formatter
    /// that agreed with the corpus on two of the three would put a launcher and
    /// a drive row in disagreement about one file. The rounding cases are the
    /// ones a truncating implementation passes everything else on.
    #[test]
    fn a_byte_count_is_said_the_way_the_corpus_says_it() {
        for (count, said) in [
            (0_i64, "0 bytes"),
            (1, "1 byte"),
            (2, "2 bytes"),
            (999, "999 bytes"),
            // THE KILOBYTE RUNG, exactly. A three-hundred-byte note is
            // "312 bytes" and not "0 KB", which is the whole reason the first
            // rung is the count itself.
            (1_000, "1 KB"),
            (880_000, "880 KB"),
            (999_999, "999 KB"),
            (1_000_000, "1.0 MB"),
            (1_200_000, "1.2 MB"),
            // ROUNDED, NOT TRUNCATED: 1 999 999 bytes is 2.0 MB to everybody
            // who is not a computer.
            (1_999_999, "2.0 MB"),
            (4_100_000, "4.1 MB"),
            (999_999_999, "1.0 GB"),
            (1_000_000_000, "1.0 GB"),
            (84_200_000_000, "84.2 GB"),
        ] {
            assert_eq!(format_byte_size(count), said, "{count} was said wrong");
        }
        // A NEGATIVE COUNT CANNOT REACH HERE — `core_content_item` carries
        // `CHECK (byte_size >= 0)` — and it is clamped rather than panicking,
        // because a tile is not the place to discover a schema violation.
        assert_eq!(format_byte_size(-1), "0 bytes");
    }

    /// A DOCS PAGE CARRIES THE SIZE THE DOCUMENT ACTUALLY IS, AS WORDS.
    ///
    /// The defect this closes is Home's Docs tile drawing a bare list: the
    /// `size` field the proto promises and both shells render had nothing
    /// behind it, because the door could not project a size at all. The
    /// document here is written through the REAL command, so the byte count is
    /// the one `core.add_document` derived from the bytes it stored — never a
    /// literal this test chose.
    #[test]
    fn a_document_page_says_its_size_and_never_hands_out_the_byte_count() {
        let dir = centraid_ontology::golden::scratch_dir();
        std::fs::create_dir_all(&dir).expect("made");
        let vault = Vault::create(dir.join("v.db")).expect("a vault");
        vault.found("T", "O").expect("founded");
        let registry = crate::commands::Registry::with_system_commands().expect("registry");
        let principal = crate::access::Principal::owner("d1");

        // 1 200 BYTES OF MARKDOWN, so the answer lands on the megabyte side of
        // nothing and the kilobyte rung is exercised by a real file rather than
        // by arithmetic. The `data:` door is the one v0 seeds through.
        let body = "#".repeat(1_200);
        vault
            .execute(
                &registry,
                &principal,
                &crate::commands::Command::new(
                    "core.add_document",
                    serde_json::json!({
                        "title": "A document with a size",
                        "data_uri": format!("data:text/markdown;charset=utf-8,{body}"),
                    }),
                ),
            )
            .expect("the document is added");

        let page = KeysetPage {
            name: "home.docs".to_owned(),
            select: vec![
                "document_id".to_owned(),
                "title".to_owned(),
                "updated_at".to_owned(),
            ],
            from: "core_document".to_owned(),
            predicate: None,
            binds: Vec::new(),
            sort_column: "updated_at".to_owned(),
            pk_column: "document_id".to_owned(),
            descending: true,
            limit: 10,
            after: None,
            held_thumbnail: false,
            note_body: false,
            document_size: true,
        };
        let answer = vault.keyset_page(&page).expect("the docs page serves");
        assert_eq!(answer.rows.len(), 1, "one document was added");
        let row = &answer.rows[0];
        assert_eq!(
            row.get(DOCUMENT_SIZE_COLUMN),
            Some(&Value::Text("1 KB".to_owned())),
            "the tile's meta column is not the document's size"
        );
        // AND THE INTEGER IS GONE. The field's own contract is that a view
        // never formats from a byte count; leaving the count in the row image
        // would make that a request rather than a shape.
        assert_eq!(
            row.get(DOCUMENT_BYTES_COLUMN),
            None,
            "the working byte count was served to the caller"
        );

        // THE SAME PAGE WITHOUT THE FLAG CARRIES NEITHER COLUMN — the cost is
        // opt-in, and a read that did not ask is not quietly widened.
        let mut unasked = page.clone();
        unasked.document_size = false;
        let plain = vault.keyset_page(&unasked).expect("the page serves");
        assert_eq!(plain.rows[0].get(DOCUMENT_SIZE_COLUMN), None);

        // A TOMBSTONED CONTENT ITEM IS NULL AND NOT "0 bytes". A document whose
        // bytes are gone has no size, and saying zero would state something no
        // row in the vault says.
        vault
            .apply_replica(|connection| {
                connection.execute(
                    "UPDATE core_content_item SET deleted_at = '2026-01-01T00:00:00.000Z'",
                    [],
                )?;
                Ok(())
            })
            .expect("the content item is tombstoned");
        let gone = vault.keyset_page(&page).expect("the page still serves");
        assert_eq!(
            gone.rows[0].get(DOCUMENT_SIZE_COLUMN),
            Some(&Value::Null),
            "a document with no live content item claimed a size anyway"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// THE FLAG ON A TABLE WITH NO `current_content_id` IS REFUSED, LOUDLY.
    ///
    /// The opposite of the failure that put this column here: a read that goes
    /// quiet is a screen nobody can debug, and a caller who set the flag on the
    /// wrong table has a bug rather than a row with no size.
    #[test]
    fn a_size_column_asked_of_a_table_that_has_no_content_is_refused() {
        let dir = centraid_ontology::golden::scratch_dir();
        std::fs::create_dir_all(&dir).expect("made");
        let vault = Vault::create(dir.join("v.db")).expect("a vault");
        vault.found("T", "O").expect("founded");
        let error = vault
            .keyset_page(&KeysetPage {
                name: "parties".to_owned(),
                select: vec!["party_id".to_owned(), "created_at".to_owned()],
                from: "core_party".to_owned(),
                predicate: None,
                binds: Vec::new(),
                sort_column: "created_at".to_owned(),
                pk_column: "party_id".to_owned(),
                descending: false,
                limit: 10,
                after: None,
                held_thumbnail: false,
                note_body: false,
                document_size: true,
            })
            .expect_err("a size over a table with no content was served anyway");
        assert!(
            error.to_string().contains("current_content_id"),
            "the refusal did not name the column it wanted: {error}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// THE SAME REFUSAL FOR `note_body`, BECAUSE IT IS THE SAME MECHANISM.
    ///
    /// [`NOTE_BODY_COLUMN`]'s doc comment promised the gentler thing — "the
    /// `from` table must carry `body_content_id`. One that does not simply
    /// answers NULL for every row" — and `query.proto` promised it to every
    /// caller of the door. It was never true and could not have been: the
    /// subquery is CORRELATED, so `{from}.body_content_id` is an outer
    /// reference that SQLite resolves at PREPARE, before a single row is read.
    /// There is no row loop in which to answer NULL.
    #[test]
    fn a_note_body_column_asked_of_a_table_that_has_no_body_is_refused() {
        let dir = centraid_ontology::golden::scratch_dir();
        std::fs::create_dir_all(&dir).expect("made");
        let vault = Vault::create(dir.join("v.db")).expect("a vault");
        vault.found("T", "O").expect("founded");
        let error = vault
            .keyset_page(&KeysetPage {
                name: "parties".to_owned(),
                select: vec!["party_id".to_owned(), "created_at".to_owned()],
                from: "core_party".to_owned(),
                predicate: None,
                binds: Vec::new(),
                sort_column: "created_at".to_owned(),
                pk_column: "party_id".to_owned(),
                descending: false,
                limit: 10,
                after: None,
                held_thumbnail: false,
                note_body: true,
                document_size: false,
            })
            .expect_err("a note body over a table with no body was served anyway");
        assert!(
            error.to_string().contains("body_content_id"),
            "the refusal did not name the column it wanted: {error}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// AND FOR `held_thumbnail`, WHICH IS THE THIRD OF THE SAME SHAPE.
    ///
    /// `core_party` has no `content_id`, so the outer reference in the
    /// candidate-hash subquery cannot resolve and the page never runs. The
    /// third flag is tested for the same reason as the second: the three
    /// columns are one construction, and a doc comment that guessed at the
    /// behaviour of one of them guessed at all three.
    #[test]
    fn a_thumbnail_column_asked_of_a_table_that_has_no_content_is_refused() {
        let dir = centraid_ontology::golden::scratch_dir();
        std::fs::create_dir_all(&dir).expect("made");
        let vault = Vault::create(dir.join("v.db")).expect("a vault");
        vault.found("T", "O").expect("founded");
        let error = vault
            .keyset_page(&KeysetPage {
                name: "parties".to_owned(),
                select: vec!["party_id".to_owned(), "created_at".to_owned()],
                from: "core_party".to_owned(),
                predicate: None,
                binds: Vec::new(),
                sort_column: "created_at".to_owned(),
                pk_column: "party_id".to_owned(),
                descending: false,
                limit: 10,
                after: None,
                held_thumbnail: true,
                note_body: false,
                document_size: false,
            })
            .expect_err("a thumbnail over a table with no content was served anyway");
        assert!(
            error.to_string().contains("content_id"),
            "the refusal did not name the column it wanted: {error}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
