//! THE DOOR OVER AN OPEN VAULT — the only `MATCH` statements in the workspace.
//!
//! One statement shape, built per domain from [`crate::domains::DOMAINS`]:
//!
//! ```sql
//! SELECT b."<pk>", <title>, <subtitle>, snippet(<fts>, -1, '⟦', '⟧', '…', 12), <fts>.rank
//!   FROM <fts> JOIN "<base>" b ON b."<pk>" = <fts>."<pk>"
//!  WHERE <fts> MATCH ?1 AND <fts>.rank MATCH ?2 [AND b."deleted_at" IS NULL] [AND (<fts>.rank, b."<pk>") > (?, ?)]
//!  ORDER BY <fts>.rank, b."<pk>" LIMIT ?
//! ```
//!
//! Four things in it are load-bearing and none is decoration:
//!
//! * **The keyset is a row value.** `(rank, pk) > (?, ?)` is what SQLite turns
//!   into one ordered walk of the match set; the equivalent disjunction is what
//!   an optimiser has to be talked into. The pk is in the key for the reason
//!   every other page has it there: two documents can score identically, and
//!   keyed on the score alone a page boundary silently repeats or drops one.
//! * **The rank is NEGATIVE and ascending is best-first.** FTS5's `rank` is bm25
//!   negated, so `ORDER BY rank` puts the best match first — the order v0 keeps
//!   and calls "vault order is rank order" (v0's own comment). A port that
//!   sorted descending would answer the worst matches.
//! * **The rank is weighted by the query, not by the index** (#1097, R1d).
//!   `<fts>.rank MATCH 'bm25(…)'` is FTS5's rank override, bound to
//!   [`Domain::rank_function`]: a column folded in from another table weighs half
//!   a label. The weights are not a row in the index's `_config`, because a
//!   vault built by replaying `contracts/schema/vault-ddl.sql` has no such row
//!   and would rank differently from a founded one. The keyset and the ORDER BY
//!   read the same `rank`, so they need no change.
//! * **The soft-delete predicate is here as well as in the trigger.** A trashed
//!   row leaves the index the moment it is trashed (#916, R11), so this is belt
//!   and braces — but the braces were added *after* trashed profiles and
//!   expenses stayed findable, and the door is where a caller can see the rule.
//!
//! ## What this door does not yet stand behind
//!
//! v0's `searchEntity` walks four consent walls before the statement: the base
//! entity's read decision, the read decision of every entity whose canonical
//! text the index folds in, a field mask that hides an indexed column failing
//! the search **closed**, and a receipt for the decision either way. This
//! door takes the [`Principal`] it is handed and does none of that: it is
//! the OWNER's view, which is the identity the parity fixtures are generated
//! under and therefore the identity that makes them comparable. Wiring the
//! consent pipeline is
//! `crates/vault`'s paged-door work and is named as a hand-off in
//! `crates/search/README.md` rather than stubbed here, because a stub that
//! *looks* like a consent check is worse than an absence that is written down.

use std::cell::RefCell;

use centraid_apps_kit::page::{Page, PageCursor, page_of, probe_limit};
use centraid_apps_kit::spelling::correct_words;
use centraid_ontology::jsvalue::js_number_to_string;
use centraid_ontology::registries::sealed_physical_columns;
use rusqlite::Connection;

use crate::domains::{
    Domain, INDEX_LABELLED, PREVIEW_CHARS, PREVIEW_FROM_TEXT, assert_no_sealed_column, domain_of,
    folded_columns,
};
use crate::matching::match_expression;
use crate::named::{Guard, NAMED, Named, Opens, assert_no_sealed_named_column, named_of};
use crate::{
    Answer, DOMAINS, MAX_MATCH_ROWS, Principal, Search, SearchError, SearchRequest, Target,
};

/// A door over one open vault.
pub struct SqliteDoor<'connection> {
    connection: &'connection Connection,
}

impl<'connection> SqliteDoor<'connection> {
    /// Open the door over a connection, checking the model it is about to read.
    ///
    /// Four checks over the domains, and the same four again over the named kinds
    /// ([`crate::named::NAMED`], whose only fold is a chat thread's), all at
    /// open and none at query time — a door that checks
    /// per call is a door someone can be talked into skipping a check on:
    ///
    /// 1. no domain PROJECTS a sealed column, and no fold is read from one
    ///    ([`assert_no_sealed_column`]);
    /// 2. no domain's live FTS table CARRIES one. v0 throws at DDL-build time
    ///    for this (`schema/fts.ts:404`-`:419`, #293); re-checking the live index
    ///    is what keeps the DDL and this door from disagreeing about a file that
    ///    was written by another build;
    /// 3. every live index column is the base table's own or a listed fold
    ///    ([`crate::domains::FOLDED`]). A fold is text from another table, so the
    ///    sealed check can only vouch for it through its listed sources; an
    ///    index column nobody listed has sources nobody checked, and the door
    ///    refuses to open over it (#1097);
    /// 4. every domain weighs exactly the columns its index has
    ///    ([`crate::domains::Domain::weights`]), because `bm25` takes its weights
    ///    by position.
    ///
    /// # Errors
    ///
    /// [`SearchError::SealedColumnReachable`] for the first two, and
    /// [`SearchError::IndexUnusable`] when a domain's shadow table is not in
    /// this file, its index carries a column that is neither the base
    /// table's nor listed, or its column count is not its weights' length.
    pub fn open(connection: &'connection Connection) -> Result<Self, SearchError> {
        assert_no_sealed_column()?;
        assert_no_sealed_named_column()?;
        let sealed = sealed_physical_columns();
        for named in NAMED {
            check_named(connection, named, &sealed)?;
        }
        for domain in DOMAINS {
            let columns = index_columns(connection, domain.entity, domain.fts)?;
            for column in &columns {
                if sealed
                    .iter()
                    .any(|(table, name)| table == domain.table && name == column)
                {
                    return Err(SearchError::SealedColumnReachable {
                        entity: domain.entity.to_owned(),
                        table: domain.table.to_owned(),
                        column: column.clone(),
                    });
                }
            }
            let base = base_columns(connection, domain.table)?;
            if let Some(unlisted) = columns.iter().find(|column| {
                !base.contains(column)
                    && !folded_columns(domain.entity).any(|folded| folded.column == column.as_str())
            }) {
                return Err(SearchError::IndexUnusable {
                    entity: domain.entity.to_owned(),
                    detail: format!(
                        "`{fts}` carries `{unlisted}`, which is neither a column of `{table}` \
                         nor a listed fold; list its sources in `domains::FOLDED` so the sealed \
                         check can read them (#1097)",
                        fts = domain.fts,
                        table = domain.table,
                    ),
                });
            }
            // ONE WEIGHT PER INDEX COLUMN: `bm25` takes them positionally, so a
            // list of another length weighs the wrong column or none (#1097, R1d).
            if domain.weights.len() != columns.len() {
                return Err(SearchError::IndexUnusable {
                    entity: domain.entity.to_owned(),
                    detail: format!(
                        "`{fts}` has {live} columns and `domains::DOMAINS` weighs {listed}; \
                         one weight per index column, in the index's order (#1097)",
                        fts = domain.fts,
                        live = columns.len(),
                        listed = domain.weights.len(),
                    ),
                });
            }
        }
        Ok(Self { connection })
    }

    /// The connection, for a caller that seeds a fixture through it.
    #[must_use]
    pub const fn connection(&self) -> &'connection Connection {
        self.connection
    }
}

/// The open-time checks for one named kind: its index is in the file, carries no
/// sealed column, carries only the base table's own columns and its listed folds
/// (a fold is text from another table, so the sealed check reads its sources
/// through [`crate::named::Fold`], and a column nobody listed is refused), and is
/// weighed column for column.
fn check_named(
    connection: &Connection,
    named: &Named,
    sealed: &[(String, String)],
) -> Result<(), SearchError> {
    let columns = index_columns(connection, named.entity, named.fts)?;
    for column in &columns {
        if sealed
            .iter()
            .any(|(table, name)| table == named.table && name == column)
        {
            return Err(SearchError::SealedColumnReachable {
                entity: named.entity.to_owned(),
                table: named.table.to_owned(),
                column: column.clone(),
            });
        }
    }
    let base = base_columns(connection, named.table)?;
    if let Some(unlisted) = columns.iter().find(|column| {
        !base.contains(column)
            && !named
                .folds
                .iter()
                .any(|fold| fold.column == column.as_str())
    }) {
        return Err(SearchError::IndexUnusable {
            entity: named.entity.to_owned(),
            detail: format!(
                "`{fts}` carries `{unlisted}`, which is neither a column of `{table}` nor a \
                 listed fold; list its sources in `named::NAMED` so the sealed check can read \
                 them (#1097)",
                fts = named.fts,
                table = named.table,
            ),
        });
    }
    if named.weights.len() != columns.len() {
        return Err(SearchError::IndexUnusable {
            entity: named.entity.to_owned(),
            detail: format!(
                "`{fts}` has {live} columns and `named::NAMED` weighs {listed}; \
                 one weight per index column, in the index's order (#1097)",
                fts = named.fts,
                live = columns.len(),
                listed = named.weights.len(),
            ),
        });
    }
    Ok(())
}

/// The columns a base table has.
fn base_columns(connection: &Connection, table: &str) -> Result<Vec<String>, SearchError> {
    let mut statement = connection
        .prepare("SELECT name FROM pragma_table_info(?1)")
        .map_err(|error| SearchError::Sqlite(error.to_string()))?;
    let names = statement
        .query_map([table], |row| row.get::<_, String>(0))
        .map_err(|error| SearchError::Sqlite(error.to_string()))?
        .collect::<Result<Vec<String>, rusqlite::Error>>()
        .map_err(|error| SearchError::Sqlite(error.to_string()))?;
    Ok(names)
}

/// The live column names of an index (a domain's or a named kind's).
fn index_columns(
    connection: &Connection,
    entity: &str,
    fts: &str,
) -> Result<Vec<String>, SearchError> {
    let mut statement = connection
        .prepare("SELECT name FROM pragma_table_info(?1) ORDER BY cid")
        .map_err(|error| SearchError::Sqlite(error.to_string()))?;
    let names: Vec<String> = statement
        .query_map([fts], |row| row.get::<_, String>(0))
        .map_err(|error| SearchError::Sqlite(error.to_string()))?
        .collect::<Result<Vec<String>, rusqlite::Error>>()
        .map_err(|error| SearchError::Sqlite(error.to_string()))?;
    if names.is_empty() {
        return Err(SearchError::IndexUnusable {
            entity: entity.to_owned(),
            detail: format!("`{fts}` is not a table in this vault"),
        });
    }
    Ok(names)
}

/// The title expression for a domain: the first non-empty label column, or the
/// index's own column for the one domain whose label is not on the base row.
fn title_expression(domain: &Domain) -> String {
    if INDEX_LABELLED.contains(&domain.entity) {
        // #996 R20(b): the byte row has no `title`; the index carries the
        // owning asset's. The shadow is inside the MATCH, so its column reads.
        return format!("COALESCE({fts}.\"title\", '')", fts = domain.fts);
    }
    coalesce_columns(domain.labels)
}

/// The subtitle expression: a column, the decoded body for a note, or empty.
fn subtitle_expression(domain: &Domain) -> String {
    if PREVIEW_FROM_TEXT.contains(&domain.entity) {
        // The SAME text the index was built from (`core_content_text`, written
        // at write time since #996 R4/R8), capped so a long body cannot ride a
        // picker row. A note with no decoded text falls back to the app name in
        // `Target`, exactly as v0's `first(row, subtitles) || app` does.
        return format!(
            "COALESCE((SELECT substr(t.\"body_text\", 1, {PREVIEW_CHARS})
                         FROM core_content_text t
                        WHERE t.\"content_id\" = b.\"body_content_id\"), '')"
        );
    }
    coalesce_columns(domain.subtitles)
}

fn coalesce_columns(columns: &[&str]) -> String {
    if columns.is_empty() {
        return "''".to_owned();
    }
    let terms: Vec<String> = columns
        .iter()
        .map(|column| format!("NULLIF(b.\"{column}\", '')"))
        .collect();
    format!("COALESCE({}, '')", terms.join(", "))
}

/// The most vocabulary rows a correction reads for ONE word from ONE domain
/// (#1097, R4a).
///
/// A correction looks at the terms that start like the word typed, and the
/// vocabulary of a long-kept vault has no upper bound — so the read has one. The
/// terms come in term order and the read stops here: the swap of the first two
/// letters first (a prefix of two letters, a few hundred terms at the most), then
/// the word's first letter with what is left of the allowance. A word whose near
/// term sorts past the bound is **not corrected**, which is the same answer as
/// "no such word": a correction is an offer, never a promise.
///
/// The number is a measurement and not a guess. `tests/door.rs`
/// (`correction_latency_on_fifty_thousand_terms`, `#[ignore]`d, the command is in
/// its doc) puts p50 and max over a vault of about 50,000 distinct terms in the
/// receipt; the biggest first-letter bucket of English text is a ninth of a
/// vocabulary, so the bound holds a whole bucket of a vault of about 70,000 terms
/// in one domain and a prefix of the alphabet's busiest letters in a bigger one.
pub const MAX_VOCAB_SCAN: usize = 8_192;

/// An index a correction reads the vocabulary of: a domain's or a named kind's.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Indexed {
    entity: &'static str,
    fts: &'static str,
}

/// The index a logical entity names, among the domains and then the named kinds.
fn index_of(entity: &str) -> Option<Indexed> {
    domain_of(entity)
        .map(|domain| Indexed {
            entity: domain.entity,
            fts: domain.fts,
        })
        .or_else(|| {
            named_of(entity).map(|named| Indexed {
                entity: named.entity,
                fts: named.fts,
            })
        })
}

/// The vocabulary table of an index (`fts_<index>_vocab`, rung thirteen).
fn vocabulary_of(index: &Indexed) -> String {
    format!("{}_vocab", index.fts)
}

/// The smallest string greater than every string that starts with `prefix`: the
/// exclusive end of a prefix range on `term`. `None` when there is none (a prefix
/// of nothing but the last code point).
///
/// SQLite compares text byte by byte and UTF-8 keeps code point order, so the
/// range `term >= prefix AND term < prefix_end(prefix)` is exactly the terms that
/// start with it — and a range on `term` is a constraint the vocabulary table
/// honours, where a `LIKE` or a `substr` would walk every term.
fn prefix_end(prefix: &str) -> Option<String> {
    let mut chars: Vec<char> = prefix.chars().collect();
    while let Some(last) = chars.pop() {
        // The surrogate gap is not a char: step over it.
        let next = match u32::from(last) + 1 {
            0xD800 => 0xE000,
            next => next,
        };
        if let Some(next) = char::from_u32(next) {
            chars.push(next);
            return Some(chars.into_iter().collect());
        }
    }
    None
}

impl SqliteDoor<'_> {
    /// Whether any term of the index starts with `word` — a prefix probe that
    /// stops at the first.
    fn holds(&self, index: &Indexed, word: &str) -> Result<bool, SearchError> {
        let Some(end) = prefix_end(word) else {
            return Ok(false);
        };
        let vocabulary = vocabulary_of(index);
        let mut statement = self
            .connection
            .prepare_cached(&format!(
                "SELECT 1 FROM {vocabulary} WHERE term >= ?1 AND term < ?2 LIMIT 1"
            ))
            .map_err(|error| unusable_vocabulary(index, &vocabulary, &error))?;
        statement
            .exists(rusqlite::params![word, end])
            .map_err(|error| SearchError::Sqlite(error.to_string()))
    }

    /// Up to `limit` terms of the index that start with `prefix`, in term order,
    /// each with the number of documents it is in. A term more than one letter
    /// shorter than the word cannot have a prefix one edit from it, so it is not
    /// kept.
    fn terms_under(
        &self,
        index: &Indexed,
        prefix: &str,
        shortest: usize,
        limit: usize,
        into: &mut Vec<(String, u64)>,
    ) -> Result<usize, SearchError> {
        let Some(end) = prefix_end(prefix) else {
            return Ok(0);
        };
        let vocabulary = vocabulary_of(index);
        let mut statement = self
            .connection
            .prepare_cached(&format!(
                "SELECT term, doc FROM {vocabulary}
                  WHERE term >= ?1 AND term < ?2
                  ORDER BY term LIMIT ?3"
            ))
            .map_err(|error| unusable_vocabulary(index, &vocabulary, &error))?;
        let rows = statement
            .query_map(
                rusqlite::params![prefix, end, i64::try_from(limit).unwrap_or(i64::MAX)],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
            )
            .map_err(|error| SearchError::Sqlite(error.to_string()))?;
        let mut read = 0;
        for row in rows {
            let (term, docs) = row.map_err(|error| SearchError::Sqlite(error.to_string()))?;
            read += 1;
            if term.chars().count() >= shortest {
                into.push((term, u64::try_from(docs).unwrap_or(0)));
            }
        }
        Ok(read)
    }

    /// The terms a correction of `word` may land on, from one index: the terms
    /// that start with the word's first letter, and those that start with its
    /// first two letters swapped — **at most [`MAX_VOCAB_SCAN`] rows in all**.
    fn neighbours(
        &self,
        index: &Indexed,
        word: &str,
        into: &mut Vec<(String, u64)>,
    ) -> Result<(), SearchError> {
        let mut letters = word.chars();
        let (Some(first), Some(second)) = (letters.next(), letters.next()) else {
            return Ok(());
        };
        // `|w| - 1`: the shortest term a prefix of length `|w| - 1` can come from.
        let shortest = word.chars().count().saturating_sub(1);
        let mut allowance = MAX_VOCAB_SCAN;
        if second != first {
            let swapped: String = [second, first].iter().collect();
            allowance -= self.terms_under(index, &swapped, shortest, allowance, into)?;
        }
        if allowance > 0 {
            self.terms_under(index, &first.to_string(), shortest, allowance, into)?;
        }
        Ok(())
    }
}

/// A vocabulary table the file does not have, or cannot read: a vault older than
/// rung thirteen, said as the unusable index it is.
fn unusable_vocabulary(index: &Indexed, vocabulary: &str, error: &rusqlite::Error) -> SearchError {
    SearchError::IndexUnusable {
        entity: index.entity.to_owned(),
        detail: format!(
            "`{vocabulary}` is not usable: {error} (rung thirteen creates the vocabulary of each domain and each named kind)"
        ),
    }
}

/// What one MATCH statement is built from: a domain's or a named kind's index,
/// with the expressions that read its row. ONE statement shape serves both
/// registries, so the two cannot drift apart.
struct Probe {
    entity: &'static str,
    fts: &'static str,
    table: &'static str,
    id_column: &'static str,
    title: String,
    subtitle: String,
    rank_function: String,
    deleted_column: Option<&'static str>,
    guards: &'static [Guard],
    opens: Opens,
}

/// The probe a logical entity names: a domain first, then a named kind.
fn probe_of(entity: &str) -> Option<Probe> {
    if let Some(domain) = domain_of(entity) {
        return Some(Probe {
            entity: domain.entity,
            fts: domain.fts,
            table: domain.table,
            id_column: domain.id_column,
            title: title_expression(domain),
            subtitle: subtitle_expression(domain),
            rank_function: domain.rank_function(),
            deleted_column: domain.deleted_column,
            guards: &[],
            opens: Opens::App(domain.app_id),
        });
    }
    named_of(entity).map(|named| Probe {
        entity: named.entity,
        fts: named.fts,
        table: named.table,
        id_column: named.id_column,
        title: coalesce_columns(named.labels),
        subtitle: "''".to_owned(),
        rank_function: named.rank_function(),
        deleted_column: named.deleted_column,
        guards: named.guards,
        opens: named.opens,
    })
}

impl Search for SqliteDoor<'_> {
    fn query(&self, principal: &Principal, request: &SearchRequest) -> Result<Answer, SearchError> {
        let probe = probe_of(&request.entity).ok_or_else(|| SearchError::NotADomain {
            entity: request.entity.clone(),
            count: DOMAINS.len(),
        })?;
        let expression = match_expression(&request.query)?;

        // BOTH CLAMPS, and the answer reports the one that applied
        // (D-1020-D3-12). The kit's probe is the window plus one — the only
        // thing separating "the window filled" from "the rows ended here".
        let window = request.page.limit.min(MAX_MATCH_ROWS);
        let clamped = centraid_apps_kit::page::PageRequest {
            limit: window,
            after: request.page.after.clone(),
        };
        let probe_rows = probe_limit(&clamped)?;

        // NARROWED TO ONE APP: the kinds of the base row that open there. An
        // entity that opens in no such app answers an empty page, not a refusal.
        let kinds: Option<Vec<&'static str>> = match (&request.app, probe.opens) {
            (None, _) => None,
            (Some(app), Opens::App(only)) => (only != app.as_str()).then(Vec::new),
            (Some(app), Opens::ByKind { apps, .. }) => Some(
                apps.iter()
                    .filter(|(_, opens_in)| *opens_in == app.as_str())
                    .map(|(value, _)| *value)
                    .collect(),
            ),
        };
        if kinds.as_ref().is_some_and(Vec::is_empty) {
            return Ok(Answer::Data {
                page: Page {
                    rows: Vec::new(),
                    next: None,
                },
                window,
            });
        }

        // THE WEIGHTS RIDE WITH THE QUERY (#1097, R1d). FTS5's rank override is a
        // second MATCH on the hidden `rank` column, so `ORDER BY {fts}.rank` and
        // the keyset below read the weighted score, and a vault built by
        // replaying the DDL ranks as a founded one does: the weights are not
        // data in the index.
        let mut predicates: Vec<String> = vec![
            format!("{fts} MATCH ?1", fts = probe.fts),
            format!("{fts}.rank MATCH ?", fts = probe.fts),
        ];
        if let Some(deleted) = probe.deleted_column {
            predicates.push(format!("b.\"{deleted}\" IS NULL"));
        }
        // A CONTAINER IS LIVE BY MORE THAN A FLAG: a folder is a concept of the
        // folders scheme that is not the root. The triggers keep the index to such rows; this is the
        // door's belt to them.
        for guard in probe.guards {
            predicates.push(format!("({})", guard.sql));
        }
        // A KIND OF ROW NOBODY LISTED OPENS NOWHERE, and a narrowed query keeps
        // the kinds that open in its app.
        if let Opens::ByKind { column, apps } = probe.opens {
            let listed: Vec<&str> = kinds
                .clone()
                .unwrap_or_else(|| apps.iter().map(|(value, _)| *value).collect());
            let placeholders = vec!["?"; listed.len()].join(", ");
            predicates.push(format!("b.\"{column}\" IN ({placeholders})"));
        }
        // A ROW WITH NO LABEL IS NOT A TARGET (`link-targets-table.ts:86`-`:88`),
        // and an excluded id is the caller's own contract — Notes' journal set
        // (#834 R-journal). **Both are predicates, not a post-filter**, and the
        // difference is the probe: the kit's page is the window plus one row,
        // and dropping rows after that row was counted makes `next` claim a
        // continuation the caller cannot use, or withhold one it is owed. A
        // fixture with one unlabelled note is what found that.
        predicates.push(format!("{title} <> ''", title = probe.title));
        let mut binds: Vec<rusqlite::types::Value> = vec![
            rusqlite::types::Value::Text(expression.clone()),
            rusqlite::types::Value::Text(probe.rank_function.clone()),
        ];
        if let Opens::ByKind { apps, .. } = probe.opens {
            let listed: Vec<&str> = kinds
                .clone()
                .unwrap_or_else(|| apps.iter().map(|(value, _)| *value).collect());
            binds.extend(
                listed
                    .into_iter()
                    .map(|value| rusqlite::types::Value::Text(value.to_owned())),
            );
        }
        if !request.excluded_ids.is_empty() {
            let placeholders = vec!["?"; request.excluded_ids.len()].join(", ");
            predicates.push(format!(
                "b.\"{pk}\" NOT IN ({placeholders})",
                pk = probe.id_column
            ));
            binds.extend(
                request
                    .excluded_ids
                    .iter()
                    .map(|id| rusqlite::types::Value::Text(id.clone())),
            );
        }
        if let Some(after) = clamped.after.as_ref() {
            let rank: f64 = after.sort_key.parse().map_err(|_| {
                SearchError::Sqlite(format!(
                    "a search cursor's sort key is a rank, and `{}` is not a number",
                    after.sort_key
                ))
            })?;
            predicates.push(format!(
                "({fts}.rank, b.\"{pk}\") > (?, ?)",
                fts = probe.fts,
                pk = probe.id_column
            ));
            binds.push(rusqlite::types::Value::Real(rank));
            binds.push(rusqlite::types::Value::Text(after.pk.clone()));
        }
        binds.push(rusqlite::types::Value::Integer(
            i64::try_from(probe_rows).unwrap_or(i64::MAX),
        ));

        let kind_select = match probe.opens {
            Opens::ByKind { column, .. } => format!("b.\"{column}\""),
            Opens::App(_) => "''".to_owned(),
        };
        let sql = format!(
            "SELECT b.\"{pk}\" AS id,
                    {title} AS title,
                    {subtitle} AS subtitle,
                    COALESCE(snippet({fts}, -1, '⟦', '⟧', '…', 12), '') AS snippet,
                    {fts}.rank AS rank,
                    {kind_select} AS kind
               FROM {fts} JOIN \"{base}\" b ON b.\"{pk}\" = {fts}.\"{pk}\"
              WHERE {predicate}
              ORDER BY {fts}.rank, b.\"{pk}\"
              LIMIT ?",
            pk = probe.id_column,
            title = probe.title,
            base = probe.table,
            fts = probe.fts,
            subtitle = probe.subtitle,
            predicate = predicates.join(" AND "),
        );

        let mut statement =
            self.connection
                .prepare(&sql)
                .map_err(|error| SearchError::IndexUnusable {
                    entity: probe.entity.to_owned(),
                    detail: error.to_string(),
                })?;
        let fetched: Vec<(Target, f64)> = statement
            .query_map(rusqlite::params_from_iter(binds), |row| {
                let id: String = row.get("id")?;
                let title: String = row.get("title")?;
                let subtitle: String = row.get("subtitle")?;
                let snippet: String = row.get("snippet")?;
                let rank: f64 = row.get("rank")?;
                let kind: String = row.get("kind")?;
                Ok((id, title, subtitle, snippet, rank, kind))
            })
            .map_err(|error| SearchError::Sqlite(error.to_string()))?
            .collect::<Result<Vec<_>, rusqlite::Error>>()
            .map_err(|error| SearchError::Sqlite(error.to_string()))?
            .into_iter()
            .filter_map(|(id, title, subtitle, snippet, rank, kind)| {
                // The app comes from the entity, or from the row's kind where
                // one index serves two apps. A kind nobody listed is no target.
                let app_id = probe.opens.app_of(&kind)?;
                Some((
                    Target {
                        entity: probe.entity.to_owned(),
                        id,
                        title,
                        // v0's `first(row, subtitles) || app`: never empty, so a
                        // surface has nothing to guess.
                        subtitle: if subtitle.trim().is_empty() {
                            app_id.to_owned()
                        } else {
                            subtitle
                        },
                        app_id: app_id.to_owned(),
                        snippet,
                    },
                    rank,
                ))
            })
            .collect();

        let page = page_of(fetched, &clamped, |(target, rank)| {
            Ok(PageCursor {
                sort_key: js_number_to_string(*rank),
                pk: target.id.clone(),
            })
        })?;
        let _ = principal;
        Ok(Answer::Data {
            page: Page {
                rows: page.rows.into_iter().map(|(target, _)| target).collect(),
                next: page.next,
            },
            window,
        })
    }

    /// The correction (#1097, R4, R4a): the words of `query` the vocabularies of
    /// `entities` do not hold, replaced by the words they do. `None` when no word
    /// changed.
    ///
    /// Every entity must be one of the seven domains or one of the named kinds,
    /// exactly as in `query`: the vocabulary of either is its index's, and Locker
    /// has neither, so a secret has no term a correction could offer.
    fn correct(
        &self,
        principal: &Principal,
        entities: &[&str],
        query: &str,
    ) -> Result<Option<String>, SearchError> {
        let mut domains: Vec<Indexed> = Vec::new();
        for entity in entities {
            let index = index_of(entity).ok_or_else(|| SearchError::NotADomain {
                entity: (*entity).to_owned(),
                count: DOMAINS.len(),
            })?;
            if !domains.contains(&index) {
                domains.push(index);
            }
        }
        let _ = principal;

        // `correct_words` takes closures that cannot fail; the first failure is
        // kept, the word it concerned is left as typed, and it is returned after.
        let failure: RefCell<Option<SearchError>> = RefCell::new(None);
        let keep = |error: SearchError| {
            failure.borrow_mut().get_or_insert(error);
        };
        let corrected = correct_words(
            query,
            |word| {
                if failure.borrow().is_some() {
                    return true;
                }
                for domain in &domains {
                    match self.holds(domain, word) {
                        Ok(true) => return true,
                        Ok(false) => {}
                        Err(error) => {
                            keep(error);
                            return true;
                        }
                    }
                }
                false
            },
            |word| {
                let mut terms = Vec::new();
                for domain in &domains {
                    if let Err(error) = self.neighbours(domain, word, &mut terms) {
                        keep(error);
                        return Vec::new();
                    }
                }
                terms
            },
        );
        match failure.into_inner() {
            Some(error) => Err(error),
            None => Ok(corrected),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domains::FOLDED;

    /// The live shape of each domain's index, the id first, in the order the
    /// weights list names them.
    const SHAPES: [(&str, &[&str]); 6] = [
        ("knowledge.note", &["note_id", "title", "body"]),
        (
            "core.party",
            &[
                "party_id",
                "display_name",
                "sort_name",
                "nickname",
                "role",
                "met",
                "channels",
                "memo",
            ],
        ),
        (
            "core.event",
            &["event_id", "summary", "description", "location"],
        ),
        (
            "schedule.task",
            &["task_id", "title", "description", "project"],
        ),
        ("core.content_item", &["content_id", "title"]),
        ("core.document", &["document_id", "title", "body"]),
    ];

    /// A connection holding the six bases and the six indexes in the shape
    /// `open` accepts, with `extra` more columns on one index and `without` one
    /// column left off another.
    fn model(extra: Option<(&str, &str)>, without: Option<(&str, &str)>) -> Connection {
        let connection = Connection::open_in_memory().expect("an in-memory file opens");
        for domain in DOMAINS {
            let shape = SHAPES
                .iter()
                .find(|(entity, _)| *entity == domain.entity)
                .map(|(_, columns)| *columns)
                .expect("every domain has a shape");
            // The base table has the id, the labels, the subtitles and every
            // index column that is not a listed fold.
            let mut base: Vec<&str> = vec![domain.id_column];
            base.extend_from_slice(domain.labels);
            base.extend_from_slice(domain.subtitles);
            base.extend(
                shape
                    .iter()
                    .filter(|column| {
                        !folded_columns(domain.entity).any(|folded| folded.column == **column)
                    })
                    .copied(),
            );
            base.sort_unstable();
            base.dedup();
            connection
                .execute_batch(&format!(
                    "CREATE TABLE {}({});",
                    domain.table,
                    base.join(", ")
                ))
                .expect("a base table is created");
            let mut index: Vec<String> = shape
                .iter()
                .filter(|column| {
                    !without.is_some_and(|(entity, left_off)| {
                        entity == domain.entity && left_off == **column
                    })
                })
                .enumerate()
                .map(|(position, column)| {
                    if position == 0 {
                        format!("{column} UNINDEXED")
                    } else {
                        (*column).to_owned()
                    }
                })
                .collect();
            if let Some((entity, column)) = extra
                && entity == domain.entity
            {
                index.push(column.to_owned());
            }
            connection
                .execute_batch(&format!(
                    "CREATE VIRTUAL TABLE {} USING fts5({});",
                    domain.fts,
                    index.join(", ")
                ))
                .expect("an index is created");
        }
        // The named kinds: a base table with the id, the label and the columns
        // the door tests (a fold's column is not among them), and an index of the
        // id, the label and each fold.
        for named in NAMED {
            let mut base: Vec<&str> = named.projected_columns();
            base.sort_unstable();
            base.dedup();
            connection
                .execute_batch(&format!(
                    "CREATE TABLE {}({});",
                    named.table,
                    base.join(", ")
                ))
                .expect("a named table is created");
            let mut index = vec![
                format!("{} UNINDEXED", named.id_column),
                named.labels[0].to_owned(),
            ];
            index.extend(named.folds.iter().map(|fold| fold.column.to_owned()));
            if let Some((entity, column)) = extra
                && entity == named.entity
            {
                index.push(column.to_owned());
            }
            connection
                .execute_batch(&format!(
                    "CREATE VIRTUAL TABLE {} USING fts5({});",
                    named.fts,
                    index.join(", ")
                ))
                .expect("a named index is created");
        }
        connection
    }

    #[test]
    fn a_prefix_ends_at_the_next_code_point() {
        assert_eq!(prefix_end("budg").as_deref(), Some("budh"));
        assert_eq!(prefix_end("a").as_deref(), Some("b"));
        assert_eq!(prefix_end("łodz").as_deref(), Some("łod{"));
        // The last code point has no successor: the one before it is stepped.
        assert_eq!(prefix_end("ab\u{10FFFF}").as_deref(), Some("ac"));
        // The surrogate gap is not a char, so the step skips it.
        assert_eq!(prefix_end("\u{D7FF}").as_deref(), Some("\u{E000}"));
        assert_eq!(prefix_end("\u{10FFFF}"), None);
        assert_eq!(prefix_end(""), None);
    }

    #[test]
    fn a_model_whose_every_fold_is_listed_opens() {
        let connection = model(None, None);
        assert!(SqliteDoor::open(&connection).is_ok());
        // Not vacuous: the model really does carry folded columns.
        assert!(!FOLDED.is_empty());
    }

    /// A DEMONSTRATED RED for the open-time fold check: an index column that is
    /// neither the base table's nor listed in `FOLDED` has sources nobody
    /// checked against the sealed registry, so the door does not open.
    #[test]
    fn an_index_column_nobody_listed_fails_to_open() {
        let connection = model(Some(("core.party", "stray_notes")), None);
        match SqliteDoor::open(&connection) {
            Err(SearchError::IndexUnusable { entity, detail }) => {
                assert_eq!(entity, "core.party");
                assert!(detail.contains("stray_notes"), "{detail}");
                assert!(detail.contains("domains::FOLDED"), "{detail}");
            }
            other => panic!(
                "the door opened over an unlisted fold: {:?}",
                other.map(|_| ())
            ),
        }
    }

    /// A DEMONSTRATED RED for the weights: `bm25` takes them by position, so an
    /// index with a column more or fewer than the list weighs is a refusal.
    #[test]
    fn an_index_whose_columns_the_weights_do_not_cover_fails_to_open() {
        let connection = model(None, Some(("core.party", "memo")));
        match SqliteDoor::open(&connection) {
            Err(SearchError::IndexUnusable { entity, detail }) => {
                assert_eq!(entity, "core.party");
                assert!(detail.contains("has 7 columns"), "{detail}");
                assert!(detail.contains("weighs 8"), "{detail}");
            }
            other => panic!(
                "the door opened over an index the weights do not cover: {:?}",
                other.map(|_| ())
            ),
        }
    }

    /// A DEMONSTRATED RED for the named kinds' open-time checks: an index column
    /// that is neither the base table's nor a listed fold is a refusal.
    #[test]
    fn a_named_index_with_a_column_nobody_listed_fails_to_open() {
        let connection = model(Some(("core.collection", "stray_notes")), None);
        match SqliteDoor::open(&connection) {
            Err(SearchError::IndexUnusable { entity, detail }) => {
                assert_eq!(entity, "core.collection");
                assert!(detail.contains("stray_notes"), "{detail}");
                assert!(detail.contains("named::NAMED"), "{detail}");
            }
            other => panic!(
                "the door opened over a named index with a stray column: {:?}",
                other.map(|_| ())
            ),
        }
    }

    #[test]
    fn a_model_without_a_named_index_fails_to_open_naming_it() {
        let connection = model(None, None);
        connection
            .execute_batch("DROP TABLE fts_schedule_project;")
            .expect("the index is dropped");
        match SqliteDoor::open(&connection) {
            Err(SearchError::IndexUnusable { entity, detail }) => {
                assert_eq!(entity, "schedule.project");
                assert!(detail.contains("fts_schedule_project"), "{detail}");
            }
            other => panic!(
                "the door opened without a named index: {:?}",
                other.map(|_| ())
            ),
        }
    }

    #[test]
    fn the_rank_function_is_one_weight_per_column_in_order() {
        let party = domain_of("core.party").expect("people is a domain");
        assert_eq!(
            party.rank_function(),
            "bm25(1.0, 1.0, 1.0, 0.5, 0.5, 0.5, 0.5, 0.5)"
        );
        let content = domain_of("core.content_item").expect("photos is a domain");
        assert_eq!(content.rank_function(), "bm25(1.0, 1.0)");
    }

    #[test]
    fn a_listed_fold_is_listed_for_its_own_domain_only() {
        // `memo` is a fold of the party's index; a note's
        // index carrying one is a column nobody listed FOR NOTES.
        let connection = model(Some(("knowledge.note", "memo")), None);
        assert!(matches!(
            SqliteDoor::open(&connection),
            Err(SearchError::IndexUnusable { .. })
        ));
    }

    #[test]
    fn a_domain_with_no_subtitle_columns_projects_the_empty_string() {
        let party = domain_of("core.party").expect("people is a domain");
        assert_eq!(subtitle_expression(party), "''");
        assert_eq!(
            title_expression(party),
            "COALESCE(NULLIF(b.\"display_name\", ''), '')"
        );
    }

    #[test]
    fn the_photo_domain_reads_its_label_off_the_index() {
        let photos = domain_of("core.content_item").expect("photos is a domain");
        assert!(title_expression(photos).contains("fts_core_content_item.\"title\""));
    }

    #[test]
    fn a_notes_subtitle_is_the_decoded_body_capped_at_the_preview_ceiling() {
        let notes = domain_of("knowledge.note").expect("notes is a domain");
        let expression = subtitle_expression(notes);
        assert!(expression.contains("core_content_text"));
        assert!(expression.contains(&PREVIEW_CHARS.to_string()));
    }
}
