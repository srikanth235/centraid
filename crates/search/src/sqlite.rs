//! THE DOOR OVER AN OPEN VAULT: the only `MATCH` statements in the workspace.
//!
//! One statement shape, over the vault's one index:
//!
//! ```sql
//! SELECT e.id, e.kind, e.title, search.rank
//!   FROM search JOIN entity e ON e.n = search.rowid
//!  WHERE search MATCH ?1 AND search.rank MATCH 'bm25(2.0, 1.0)'
//!    AND e.deleted_at IS NULL AND e.kind IN (...) AND e.title <> ''
//!    [AND (search.rank, e.id) > (?, ?)]
//!  ORDER BY search.rank, e.id LIMIT ?
//! ```
//!
//! Four things in it are load-bearing and none is decoration:
//!
//! * **The join is the kind and the trash filter.** The index is keyed by
//!   `entity.n` and holds no kind and no state; the writer deletes a trashed
//!   entity's row at commit, and `e.deleted_at IS NULL` is the door's belt to
//!   that brace, visible to a reader.
//! * **The keyset is a row value.** `(rank, id) > (?, ?)` is what SQLite turns
//!   into one ordered walk of the match set. The id is in the key because two
//!   entities can score identically, and keyed on the score alone a page
//!   boundary silently repeats or drops one.
//! * **The rank is NEGATIVE and ascending is best-first.** FTS5's `rank` is bm25
//!   negated, so `ORDER BY rank` puts the best match first ("vault order is rank
//!   order"). A port that sorted descending would answer the worst matches.
//! * **The rank is weighted by the query, not by the index.** `search.rank MATCH
//!   'bm25(2.0, 1.0)'` is FTS5's rank override: a word in a title weighs twice a
//!   word in a body. The weights are not a row in the index's `_config`, because
//!   a vault built by replaying `contracts/schema/vault-ddl.sql` has no such row
//!   and would rank differently from a founded one.
//!
//! ## What this door does not stand behind
//!
//! It is the OWNER's view. The consent walls a granted caller would meet (the
//! read decision of every entity whose text the index folds in, a field mask that
//! hides an indexed column, a receipt) are `crates/vault`'s paged-door work and
//! are written down in `crates/search/README.md` rather than stubbed here.

use std::cell::RefCell;

use centraid_apps_kit::page::{Page, PageCursor, page_of, probe_limit};
use centraid_apps_kit::spelling::{correct_words, words};
use centraid_ontology::jsvalue::js_number_to_string;
use centraid_vault::index::SEARCHABLE;
use centraid_vault::model::Kind;
use rusqlite::Connection;

use crate::matching::match_expression;
use crate::snippet::snippet_of;
use crate::{Answer, MAX_MATCH_ROWS, Principal, Search, SearchError, SearchRequest, Target};

/// The rank function the query carries: a word in a title weighs twice a word
/// in a body. One weight per index column, `title` then `body`.
const RANK_FUNCTION: &str = "bm25(2.0, 1.0)";

/// The door, over a connection to a vault.
pub struct SqliteDoor<'connection> {
    connection: &'connection Connection,
}

impl<'connection> SqliteDoor<'connection> {
    /// Open the door, checking the file carries the index and its vocabulary.
    ///
    /// # Errors
    /// [`SearchError::IndexUnusable`] for a file with no `search` table or no
    /// `search_vocab`: not a vault this build founded.
    pub fn open(connection: &'connection Connection) -> Result<Self, SearchError> {
        for table in ["search", "search_vocab"] {
            let held: i64 = connection
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE name = ?1",
                    [table],
                    |row| row.get(0),
                )
                .map_err(|error| SearchError::Sqlite(error.to_string()))?;
            if held == 0 {
                return Err(SearchError::IndexUnusable {
                    detail: format!("`{table}` is not in this file"),
                });
            }
        }
        Ok(Self { connection })
    }
}

/// The kinds a request names, each held to the searchable list.
fn kinds_of(request_kinds: &[String]) -> Result<Vec<Kind>, SearchError> {
    let mut kinds = Vec::new();
    for word in request_kinds {
        let kind = Kind::parse(word)
            .filter(|kind| SEARCHABLE.contains(kind))
            .ok_or_else(|| SearchError::NotSearchable {
                kind: word.clone(),
                count: SEARCHABLE.len(),
            })?;
        if !kinds.contains(&kind) {
            kinds.push(kind);
        }
    }
    if kinds.is_empty() {
        kinds.extend(SEARCHABLE);
    }
    Ok(kinds)
}

/// How many rows of the vocabulary one correction reads for one word.
///
/// The number is a measurement and not a guess: the biggest first-letter bucket
/// of English text is a ninth of a vocabulary, so the bound holds a whole bucket
/// of a vault of about 70,000 terms. A word whose near term sorts past the bound
/// is **not corrected**, which is the same answer as "no such word": a
/// correction is an offer, never a promise.
pub const MAX_VOCAB_SCAN: usize = 8_192;

/// The smallest string greater than every string that starts with `prefix`: the
/// exclusive end of a prefix range on `term`. `None` when there is none (a prefix
/// of nothing but the last code point).
///
/// SQLite compares text byte by byte and UTF-8 keeps code point order, so the
/// range `term >= prefix AND term < prefix_end(prefix)` is exactly the terms that
/// start with it, and a range on `term` is a constraint the vocabulary table
/// honours where a `LIKE` or a `substr` would walk every term.
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

fn unusable(error: &rusqlite::Error) -> SearchError {
    SearchError::IndexUnusable {
        detail: format!("`search_vocab` is not usable: {error}"),
    }
}

impl SqliteDoor<'_> {
    /// Whether any term of the vocabulary starts with `word`: a prefix probe
    /// that stops at the first.
    fn holds(&self, word: &str) -> Result<bool, SearchError> {
        let Some(end) = prefix_end(word) else {
            return Ok(false);
        };
        let mut statement = self
            .connection
            .prepare_cached("SELECT 1 FROM search_vocab WHERE term >= ?1 AND term < ?2 LIMIT 1")
            .map_err(|error| unusable(&error))?;
        statement
            .exists(rusqlite::params![word, end])
            .map_err(|error| SearchError::Sqlite(error.to_string()))
    }

    /// Up to `limit` terms that start with `prefix`, in term order, each with
    /// the number of documents it is in. A term more than one letter shorter
    /// than the word cannot have a prefix one edit from it, so it is not kept.
    fn terms_under(
        &self,
        prefix: &str,
        shortest: usize,
        limit: usize,
        into: &mut Vec<(String, u64)>,
    ) -> Result<usize, SearchError> {
        let Some(end) = prefix_end(prefix) else {
            return Ok(0);
        };
        let mut statement = self
            .connection
            .prepare_cached(
                "SELECT term, doc FROM search_vocab
                  WHERE term >= ?1 AND term < ?2 ORDER BY term LIMIT ?3",
            )
            .map_err(|error| unusable(&error))?;
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

    /// The terms a correction of `word` may land on: those that start with the
    /// word's first letter, and those that start with its first two letters
    /// swapped, **at most [`MAX_VOCAB_SCAN`] rows in all**.
    fn neighbours(&self, word: &str, into: &mut Vec<(String, u64)>) -> Result<(), SearchError> {
        let mut letters = word.chars();
        let (Some(first), Some(second)) = (letters.next(), letters.next()) else {
            return Ok(());
        };
        // `|w| - 1`: the shortest term a prefix of length `|w| - 1` can come from.
        let shortest = word.chars().count().saturating_sub(1);
        let mut allowance = MAX_VOCAB_SCAN;
        if second != first {
            let swapped: String = [second, first].iter().collect();
            allowance -= self.terms_under(&swapped, shortest, allowance, into)?;
        }
        if allowance > 0 {
            self.terms_under(&first.to_string(), shortest, allowance, into)?;
        }
        Ok(())
    }
}

impl Search for SqliteDoor<'_> {
    fn query(&self, principal: &Principal, request: &SearchRequest) -> Result<Answer, SearchError> {
        let kinds = kinds_of(&request.kinds)?;
        let expression = match_expression(&request.query)?;

        // BOTH CLAMPS, and the answer reports the one that applied. The kit's
        // probe is the window plus one: the only thing separating "the window
        // filled" from "the rows ended here".
        let window = request.page.limit.min(MAX_MATCH_ROWS);
        let clamped = centraid_apps_kit::page::PageRequest {
            limit: window,
            after: request.page.after.clone(),
        };
        let probe_rows = probe_limit(&clamped)?;

        let mut predicates: Vec<String> = vec![
            "search MATCH ?1".to_owned(),
            "search.rank MATCH ?2".to_owned(),
            "e.deleted_at IS NULL".to_owned(),
            // A row with no label is not a target, and an excluded id is the
            // caller's own contract. **Both are predicates, not a post-filter**:
            // the kit's page is the window plus one probe row, and dropping rows
            // after that row was counted makes `next` claim a continuation the
            // caller cannot use, or withhold one it is owed.
            "e.title <> ''".to_owned(),
        ];
        let mut binds: Vec<rusqlite::types::Value> = vec![
            rusqlite::types::Value::Text(expression),
            rusqlite::types::Value::Text(RANK_FUNCTION.to_owned()),
        ];
        predicates.push(format!("e.kind IN ({})", vec!["?"; kinds.len()].join(", ")));
        binds.extend(
            kinds
                .iter()
                .map(|kind| rusqlite::types::Value::Text(kind.as_str().to_owned())),
        );
        if !request.excluded_ids.is_empty() {
            predicates.push(format!(
                "e.id NOT IN ({})",
                vec!["?"; request.excluded_ids.len()].join(", ")
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
            predicates.push("(search.rank, e.id) > (?, ?)".to_owned());
            binds.push(rusqlite::types::Value::Real(rank));
            binds.push(rusqlite::types::Value::Text(after.pk.clone()));
        }
        binds.push(rusqlite::types::Value::Integer(
            i64::try_from(probe_rows).unwrap_or(i64::MAX),
        ));

        let sql = format!(
            "SELECT e.id, e.kind, e.title, search.rank
               FROM search JOIN entity e ON e.n = search.rowid
              WHERE {}
              ORDER BY search.rank, e.id
              LIMIT ?",
            predicates.join(" AND ")
        );
        let mut statement =
            self.connection
                .prepare(&sql)
                .map_err(|error| SearchError::IndexUnusable {
                    detail: error.to_string(),
                })?;
        let hits: Vec<(String, String, String, f64)> = statement
            .query_map(rusqlite::params_from_iter(binds), |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
            })
            .map_err(|error| SearchError::Sqlite(error.to_string()))?
            .collect::<Result<_, _>>()
            .map_err(|error| SearchError::Sqlite(error.to_string()))?;

        // The snippet is excerpted from the text the entity was indexed from;
        // only the window's own rows are read, never the probe's.
        let tokens = words(&request.query);
        let mut fetched: Vec<(Target, f64)> = Vec::with_capacity(hits.len());
        for (index, (id, kind, title, rank)) in hits.into_iter().enumerate() {
            let snippet = if index < window {
                Kind::parse(&kind)
                    .map(|kind| centraid_vault::index::text_of(self.connection, &id, kind))
                    .transpose()
                    .map_err(|error| SearchError::Sqlite(error.to_string()))?
                    .flatten()
                    .and_then(|text| snippet_of(&text, &tokens))
                    .unwrap_or_default()
            } else {
                String::new()
            };
            fetched.push((
                Target {
                    subtitle: kind.replace('_', " "),
                    entity: kind,
                    id,
                    title,
                    snippet,
                },
                rank,
            ));
        }

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

    /// The correction: the words of `query` the vocabulary does not hold,
    /// replaced by the words it does. `None` when no word changed.
    ///
    /// The vocabulary is the one index's, so the kinds named only have to be
    /// searchable: Locker has none, and a secret has no term a correction could
    /// offer.
    fn correct(
        &self,
        principal: &Principal,
        entities: &[&str],
        query: &str,
    ) -> Result<Option<String>, SearchError> {
        kinds_of(
            &entities
                .iter()
                .map(|word| (*word).to_owned())
                .collect::<Vec<_>>(),
        )?;
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
                match self.holds(word) {
                    Ok(held) => held,
                    Err(error) => {
                        keep(error);
                        true
                    }
                }
            },
            |word| {
                let mut terms = Vec::new();
                if let Err(error) = self.neighbours(word, &mut terms) {
                    keep(error);
                    return Vec::new();
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

    #[test]
    fn a_prefix_ends_at_the_next_code_point() {
        assert_eq!(prefix_end("abc").as_deref(), Some("abd"));
        assert_eq!(prefix_end("a\u{10FFFF}").as_deref(), Some("b"));
        assert_eq!(prefix_end("\u{10FFFF}"), None);
    }

    #[test]
    fn a_kind_nobody_searches_is_refused_by_name_and_none_means_all() {
        for word in ["locker.item", "flag", "txn", "calendar", "nonsense"] {
            assert!(
                matches!(
                    kinds_of(&[word.to_owned()]),
                    Err(SearchError::NotSearchable { .. })
                ),
                "{word}"
            );
        }
        assert_eq!(kinds_of(&[]).expect("all").len(), SEARCHABLE.len());
        assert_eq!(
            kinds_of(&["note".to_owned(), "note".to_owned()]).expect("one"),
            vec![Kind::Note]
        );
    }
}
