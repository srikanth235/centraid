//! THE DOOR OVER AN OPEN VAULT: the only `MATCH` statements in the workspace.
//!
//! One statement shape, over the vault's one index, in two tiers:
//!
//! ```sql
//! WITH hits(n, tier, rank) AS (
//!   -- tier 0: the words are in the TITLE. Uncapped: a title match is what a
//!   -- member typed a name for, and there are few of them.
//!   SELECT search.rowid, 0, search.rank FROM search JOIN entity e ON e.n = search.rowid
//!    WHERE search MATCH '{title} : (expr)' AND search.rank MATCH 'bm25(2.0, 1.0)' AND <filters>
//!   UNION ALL
//!   -- tier 1: everything else that matches, the NEWEST 500 by rowid. The filters
//!   -- are inside the cap, so a one-kind search is not starved by other kinds.
//!   SELECT * FROM (
//!     SELECT search.rowid, 1, search.rank FROM search JOIN entity e ON e.n = search.rowid
//!      WHERE search MATCH '(expr) NOT ({title} : (expr))' AND search.rank MATCH ... AND <filters>
//!      ORDER BY search.rowid DESC LIMIT 500)
//! )
//! SELECT e.id, e.kind, e.title, hits.tier, hits.rank
//!   FROM hits JOIN entity e ON e.n = hits.n
//!  [WHERE (hits.tier, hits.rank, e.id) > (?, ?, ?)]
//!  ORDER BY hits.tier, hits.rank, e.id LIMIT ?
//! ```
//!
//! `<filters>` is `e.deleted_at IS NULL AND e.title <> '' AND e.kind IN (...)`
//! and `e.id NOT IN (...)` when the caller excludes ids.
//!
//! Five things in it are load-bearing and none is decoration:
//!
//! * **The tiers are what makes a prefix search affordable.** A two-letter prefix
//!   in a vault of years matches tens of thousands of entities; ranking all of
//!   them is what made a keystroke cost seconds. The tail is capped at the
//!   newest [`TAIL_ROWS`] matches and streams from the index in rowid order (see
//!   "The plan" below), so a keystroke reads those and stops. A title match is
//!   always answered, whatever its age, and ahead of every other match.
//! * **The tiers cannot overlap.** Tier 1 asks FTS5 for the words anywhere
//!   `NOT` in the title, so an entity is in one tier only and the cap counts
//!   only rows that could appear.
//! * **The join is the kind and the trash filter.** The index is keyed by
//!   `entity.n` and holds no kind and no state; the writer deletes a trashed
//!   entity's row at commit, and `e.deleted_at IS NULL` is the door's belt to
//!   that brace, visible to a reader.
//! * **The keyset is a row value.** `(tier, rank, id) > (?, ?, ?)` continues the
//!   ordered walk. The id is in the key because two entities can score
//!   identically, and keyed on the score alone a page boundary silently repeats
//!   or drops one. The cursor's sort key spells the tier and the rank
//!   (`1:-2.5`).
//! * **The rank is NEGATIVE and ascending is best-first, and it is weighted by
//!   the query, not by the index.** FTS5's `rank` is bm25 negated, so `ORDER BY
//!   rank` puts the best match first. `search.rank MATCH 'bm25(2.0, 1.0)'` is
//!   FTS5's rank override: a word in a title weighs twice a word in a body. The
//!   weights are not a row in the index's `_config`, because a vault built by
//!   replaying `contracts/schema/vault-ddl.sql` has no such row and would rank
//!   differently from a founded one.
//!
//! ## The plan
//!
//! `EXPLAIN QUERY PLAN` of the tail leg reads the index as a virtual-table scan
//! that FTS5 itself orders by rowid descending (`ORDER BY search.rowid DESC` is
//! handed to the module, which walks its doclists backwards), joined to `entity`
//! by its `n` index, with no `USE TEMP B-TREE FOR ORDER BY` inside the leg:
//! `LIMIT 500` ends the walk at the 500th surviving row, which is the whole point
//! of the cap. A test (`the_tail_leg_streams_the_index_and_does_not_sort_its_matches`)
//! keeps that true: a plan that sorted every match would make the cap a cosmetic.
//!
//! ## What this door does not stand behind
//!
//! It is the OWNER's view. The consent walls a granted caller would meet (the
//! read decision of every entity whose text the index folds in, a field mask that
//! hides an indexed column, a receipt) are `crates/vault`'s paged-door work and
//! are written down in `crates/search/README.md` rather than stubbed here.

use centraid_apps_kit::page::{Page, PageCursor, page_of, probe_limit};
use centraid_apps_kit::spelling::{
    fragment_is_read, is_known, near_words_close, rank_order, try_correct_words, words,
};
use centraid_ontology::jsvalue::js_number_to_string;
use centraid_vault::index::SEARCHABLE;
use centraid_vault::model::Kind;
use centraid_vault::words::WordList;
use centraid_vault::words::Words;
use rusqlite::types::Value;
use rusqlite::{Connection, OptionalExtension};

use crate::matching::{match_expression, title_expression};
use crate::snippet::snippet_of;
use crate::{
    Answer, EachRequest, MAX_MATCH_ROWS, Principal, Search, SearchError, SearchRequest,
    THIN_ANSWER, Target,
};

/// The rank function the query carries: a word in a title weighs twice a word
/// in a body. One weight per index column, `title` then `body`.
const RANK_FUNCTION: &str = "bm25(2.0, 1.0)";

/// How many matches outside the title one search ranks: the newest by rowid,
/// the filters (kind, trash, unlabelled, excluded ids) applied before the count.
///
/// A prefix of two letters matches a large share of a vault of years; the
/// member is looking for something recent far more often than for the best
/// bm25 score among forty thousand rows, and ranking all of them is what cost
/// seconds a keystroke. A match in a TITLE is not capped (tier 0).
pub const TAIL_ROWS: usize = 500;

/// The door, over a connection to a vault and the word list that vault keeps.
pub struct SqliteDoor<'connection> {
    connection: &'connection Connection,
    /// The vault's cache of its words, which [`Search::correct`] reads.
    words: &'connection Words,
}

impl<'connection> SqliteDoor<'connection> {
    /// Open the door, checking the file carries the index and its vocabulary.
    ///
    /// `words` is the caller's `vault.words()`: the door holds no cache of its
    /// own, because a cache per door is a full read of the list per search.
    ///
    /// # Errors
    /// [`SearchError::IndexUnusable`] for a file with no `search` table or no
    /// `search_vocab`: not a vault this build founded.
    pub fn open(
        connection: &'connection Connection,
        words: &'connection Words,
    ) -> Result<Self, SearchError> {
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
        Ok(Self { connection, words })
    }
}

/// The kinds `principal` may search: every searchable kind, but for a caller
/// that cannot reach Locker ([`Principal::may_search_locker`]) not Locker's.
fn searchable_by(principal: &Principal) -> Vec<Kind> {
    SEARCHABLE
        .iter()
        .copied()
        .filter(|kind| *kind != Kind::LockerItem || principal.may_search_locker())
        .collect()
}

/// The kinds a request names, each held to the list `principal` may search. No
/// kind named is every kind it may search.
fn kinds_of(principal: &Principal, request_kinds: &[String]) -> Result<Vec<Kind>, SearchError> {
    let allowed = searchable_by(principal);
    let mut kinds = Vec::new();
    for word in request_kinds {
        let kind = Kind::parse(word)
            .filter(|kind| allowed.contains(kind))
            .ok_or_else(|| SearchError::NotSearchable {
                kind: word.clone(),
                count: allowed.len(),
            })?;
        if !kinds.contains(&kind) {
            kinds.push(kind);
        }
    }
    if kinds.is_empty() {
        kinds = allowed;
    }
    Ok(kinds)
}

/// The positional parameters of one statement, in the order they were asked for.
#[derive(Default)]
struct Binds(Vec<Value>);

impl Binds {
    /// Add a value; the placeholder that names it (`?N`).
    fn push(&mut self, value: Value) -> String {
        self.0.push(value);
        format!("?{}", self.0.len())
    }

    fn text(&mut self, text: impl Into<String>) -> String {
        self.push(Value::Text(text.into()))
    }
}

/// The two-tier match set of a query, as a CTE named `hits(n, tier, rank)`
/// ([module docs](self)); its parameters are added to `binds`.
fn hits_cte(
    query: &str,
    kinds: &[Kind],
    excluded_ids: &[String],
    binds: &mut Binds,
) -> Result<String, SearchError> {
    let (tier_0, tier_1) = (title_expression(query)?, tail_expression(query)?);
    let (title, tail, rank) = (
        binds.text(tier_0),
        binds.text(tier_1),
        binds.text(RANK_FUNCTION),
    );
    let cap = binds.push(Value::Integer(i64::try_from(TAIL_ROWS).unwrap_or(i64::MAX)));
    let kind_marks: Vec<String> = kinds.iter().map(|kind| binds.text(kind.as_str())).collect();
    let mut filters = format!(
        // A row with no label is not a target, and an excluded id is the caller's
        // own contract. **Both are predicates, not a post-filter**: the kit's
        // page is the window plus one probe row, and dropping rows after that
        // row was counted makes `next` claim a continuation the caller cannot
        // use, or withhold one it is owed.
        "e.deleted_at IS NULL AND e.title <> '' AND e.kind IN ({})",
        kind_marks.join(", ")
    );
    if !excluded_ids.is_empty() {
        let marks: Vec<String> = excluded_ids
            .iter()
            .map(|id| binds.text(id.clone()))
            .collect();
        filters.push_str(&format!(" AND e.id NOT IN ({})", marks.join(", ")));
    }
    // **THE PLAN OF THE TAIL LEG** (`EXPLAIN QUERY PLAN`, held by
    // `the_tail_leg_streams_the_index_and_does_not_sort_its_matches`): the index
    // is walked by FTS5 itself in rowid descending order, `entity` is probed by
    // its `n`, the filters are applied to each row as it arrives, and `LIMIT`
    // ends the walk at the cap; there is no temp b-tree for the order. The
    // filters sit INSIDE the cap, so a search over one kind among many does
    // not spend its 500 on the others.
    Ok(format!(
        "hits(n, tier, rank) AS (
           SELECT search.rowid, 0, search.rank
             FROM search JOIN entity e ON e.n = search.rowid
            WHERE search MATCH {title} AND search.rank MATCH {rank} AND {filters}
           UNION ALL
           SELECT * FROM (
             SELECT search.rowid, 1, search.rank
               FROM search JOIN entity e ON e.n = search.rowid
              WHERE search MATCH {tail} AND search.rank MATCH {rank} AND {filters}
              ORDER BY search.rowid DESC
              LIMIT {cap}))"
    ))
}

/// The tier-1 expression: the words anywhere, and not all in the title (those
/// are tier 0's).
fn tail_expression(query: &str) -> Result<String, SearchError> {
    let all = match_expression(query)?;
    Ok(format!("({all}) NOT ({})", title_expression(query)?))
}

/// What a hit's cursor says: its tier and rank.
fn cursor_key(tier: i64, rank: f64) -> String {
    format!("{tier}:{}", js_number_to_string(rank))
}

fn parse_cursor_key(key: &str) -> Result<(i64, f64), SearchError> {
    key.split_once(':')
        .and_then(|(tier, rank)| Some((tier.parse::<i64>().ok()?, rank.parse::<f64>().ok()?)))
        .ok_or_else(|| {
            SearchError::Sqlite(format!(
                "a search cursor's sort key is a tier and a rank (`1:-2.5`), and `{key}` is not"
            ))
        })
}

type Hit = (String, String, String, i64, f64);

impl SqliteDoor<'_> {
    /// The text the entity was indexed from, excerpted around the words asked
    /// for; empty when the hit was on the title alone.
    fn snippet(&self, id: &str, kind: &str, tokens: &[String]) -> Result<String, SearchError> {
        Ok(Kind::parse(kind)
            .map(|kind| centraid_vault::index::text_of(self.connection, id, kind))
            .transpose()
            .map_err(|error| SearchError::Sqlite(error.to_string()))?
            .flatten()
            .and_then(|text| snippet_of(&text, tokens))
            .unwrap_or_default())
    }

    fn hits(&self, sql: &str, binds: Binds) -> Result<Vec<Hit>, SearchError> {
        let mut statement =
            self.connection
                .prepare_cached(sql)
                .map_err(|error| SearchError::IndexUnusable {
                    detail: error.to_string(),
                })?;
        statement
            .query_map(rusqlite::params_from_iter(binds.0), |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            })
            .map_err(|error| SearchError::Sqlite(error.to_string()))?
            .collect::<Result<_, _>>()
            .map_err(|error| SearchError::Sqlite(error.to_string()))
    }

    fn target(
        &self,
        hit: &Hit,
        tokens: &[String],
        with_snippet: bool,
    ) -> Result<Target, SearchError> {
        let (id, kind, title, _, _) = hit;
        Ok(Target {
            subtitle: kind.replace('_', " "),
            entity: kind.clone(),
            id: id.clone(),
            title: title.clone(),
            snippet: if with_snippet {
                self.snippet(id, kind, tokens)?
            } else {
                String::new()
            },
        })
    }
}

fn unusable(error: &rusqlite::Error) -> SearchError {
    SearchError::IndexUnusable {
        detail: format!("`search_vocab` is not usable: {error}"),
    }
}

impl SqliteDoor<'_> {
    /// The query with its mistyped words replaced by the words the vault holds.
    /// The list is one list for every reader.
    ///
    /// `filling` is the pass over a thin, non-empty exact answer ([`Search::correct_thin`]):
    /// there a word the vault holds as a whole word in fewer than [`THIN_ANSWER`]
    /// documents is corrected too, when a candidate holds more documents than it.
    /// A word held only as the start of longer words (still being typed) is never
    /// corrected on that pass.
    fn corrected(&self, query: &str, filling: bool) -> Result<Option<String>, SearchError> {
        // Read on the first word that needs it: a query of words that cannot be
        // corrected never asks for the list.
        let mut list: Option<std::cell::Ref<'_, WordList>> = None;
        try_correct_words(query, |folded| {
            if list.is_none() {
                list = Some(self.words.current(self.connection).map_err(|error| {
                    SearchError::IndexUnusable {
                        detail: format!("the word list is not usable: {error}"),
                    }
                })?);
            }
            let held = || {
                list.as_deref()
                    .into_iter()
                    .flat_map(WordList::iter)
            };
            if is_known(folded, held()) {
                if !filling {
                    return Ok(None);
                }
                // A whole word of the vault with few documents: the exact rows
                // are what the typed word found, and a neighbour with more may
                // be the word that was meant. Zero documents is not a whole word.
                let own = self.docs_of(folded)?;
                if own == 0 || own >= THIN_ANSWER as u64 {
                    return Ok(None);
                }
                return self.best_of(near(folded, held(), list.as_deref()), own);
            }
            self.best_of(near(folded, held(), list.as_deref()), 0)
        })
    }

    /// The documents that hold the whole word `term`; 0 when it is none.
    fn docs_of(&self, term: &str) -> Result<u64, SearchError> {
        let docs: Option<i64> = self
            .connection
            .prepare_cached("SELECT doc FROM search_vocab WHERE term = ?1")
            .map_err(|error| unusable(&error))?
            .query_row([term], |row| row.get(0))
            .optional()
            .map_err(|error| SearchError::Sqlite(error.to_string()))?;
        Ok(u64::try_from(docs.unwrap_or(0)).unwrap_or(0))
    }

    /// The candidate the most documents hold, then the shorter, then the one
    /// that sorts first ([`rank_order`]). A word the index lists but no document
    /// holds any more is not a correction: searching it finds nothing. Only a
    /// candidate with more than `beat` documents counts.
    fn best_of(&self, candidates: Vec<&str>, beat: u64) -> Result<Option<String>, SearchError> {
        if candidates.is_empty() {
            return Ok(None);
        }
        let mut statement = self
            .connection
            .prepare_cached("SELECT doc FROM search_vocab WHERE term = ?1")
            .map_err(|error| unusable(&error))?;
        let mut best: Option<(&str, u64)> = None;
        for candidate in candidates {
            let docs: Option<i64> = statement
                .query_row([candidate], |row| row.get(0))
                .optional()
                .map_err(|error| SearchError::Sqlite(error.to_string()))?;
            let docs = u64::try_from(docs.unwrap_or(0)).unwrap_or(0);
            if docs > beat
                && best.is_none_or(|held| {
                    rank_order((candidate, docs), held) == std::cmp::Ordering::Less
                })
            {
                best = Some((candidate, docs));
            }
        }
        Ok(best.map(|(word, _)| word.to_owned()))
    }
}

/// The words a typed word may have meant, in [`centraid_apps_kit::spelling::near_words`]'s
/// tiers. The third tier, the typed fragment inside a
/// longer word, is asked of the packed list ([`WordList::containing`]), which finds it in
/// one search of its text and not one `contains` per word.
fn near<'a>(
    folded: &str,
    held: impl Iterator<Item = &'a str>,
    list: Option<&'a WordList>,
) -> Vec<&'a str> {
    let close = near_words_close(folded, held);
    if !close.is_empty() || !fragment_is_read(folded) {
        return close;
    }
    list.map(|list| list.containing(folded)).unwrap_or_default()
}

/// The statement behind [`Search::query_each`] and its parameters.
fn each_statement(request: &EachRequest, kinds: &[Kind]) -> Result<(String, Binds), SearchError> {
    let mut binds = Binds::default();
    let cte = hits_cte(&request.query, kinds, &request.excluded_ids, &mut binds)?;
    let per_kind = binds.push(Value::Integer(
        i64::try_from(request.per_kind).unwrap_or(i64::MAX),
    ));
    let sql = format!(
        "WITH {cte}
         SELECT id, kind, title, tier, rank FROM (
           SELECT e.id, e.kind, e.title, hits.tier AS tier, hits.rank AS rank,
                  row_number() OVER (
                    PARTITION BY e.kind ORDER BY hits.tier, hits.rank, e.id) AS place
             FROM hits JOIN entity e ON e.n = hits.n)
          WHERE place <= {per_kind}
          ORDER BY kind, place"
    );
    Ok((sql, binds))
}

impl Search for SqliteDoor<'_> {
    fn query(&self, principal: &Principal, request: &SearchRequest) -> Result<Answer, SearchError> {
        let kinds = kinds_of(principal, &request.kinds)?;
        // Compiled before the window is read, so a query with nothing to search
        // is refused whatever its window.
        match_expression(&request.query)?;

        // BOTH CLAMPS, and the answer reports the one that applied. The kit's
        // probe is the window plus one: the only thing separating "the window
        // filled" from "the rows ended here".
        let window = request.page.limit.min(MAX_MATCH_ROWS);
        let clamped = centraid_apps_kit::page::PageRequest {
            limit: window,
            after: request.page.after.clone(),
        };
        let probe_rows = probe_limit(&clamped)?;

        let mut binds = Binds::default();
        let cte = hits_cte(&request.query, &kinds, &request.excluded_ids, &mut binds)?;
        let mut keyset = String::new();
        if let Some(after) = clamped.after.as_ref() {
            let (tier, rank) = parse_cursor_key(&after.sort_key)?;
            let (tier, rank, id) = (
                binds.push(Value::Integer(tier)),
                binds.push(Value::Real(rank)),
                binds.text(after.pk.clone()),
            );
            keyset = format!("WHERE (hits.tier, hits.rank, e.id) > ({tier}, {rank}, {id})");
        }
        let limit = binds.push(Value::Integer(
            i64::try_from(probe_rows).unwrap_or(i64::MAX),
        ));
        let sql = format!(
            "WITH {cte}
             SELECT e.id, e.kind, e.title, hits.tier, hits.rank
               FROM hits JOIN entity e ON e.n = hits.n
               {keyset}
              ORDER BY hits.tier, hits.rank, e.id
              LIMIT {limit}"
        );
        let hits = self.hits(&sql, binds)?;

        // The snippet is excerpted from the text the entity was indexed from;
        // only the window's own rows are read, never the probe's.
        let tokens = words(&request.query);
        let mut fetched: Vec<(Target, i64, f64)> = Vec::with_capacity(hits.len());
        for (index, hit) in hits.iter().enumerate() {
            fetched.push((self.target(hit, &tokens, index < window)?, hit.3, hit.4));
        }

        let page = page_of(fetched, &clamped, |(target, tier, rank)| {
            Ok(PageCursor {
                sort_key: cursor_key(*tier, *rank),
                pk: target.id.clone(),
            })
        })?;
        Ok(Answer::Data {
            page: Page {
                rows: page.rows.into_iter().map(|(target, _, _)| target).collect(),
                next: page.next,
            },
            window,
        })
    }

    /// Several kinds in ONE statement: the same two-tier match set, then at most
    /// `per_kind` rows of each kind by `row_number() OVER (PARTITION BY e.kind
    /// ORDER BY tier, rank, id)`.
    ///
    /// The cap of [`TAIL_ROWS`] counts across the kinds asked, so a kind whose
    /// only matches are in a body and older than the newest 500 matches of the
    /// kinds beside it is not answered; a match in a title always is.
    fn query_each(
        &self,
        principal: &Principal,
        request: &EachRequest,
    ) -> Result<Vec<Target>, SearchError> {
        let kinds = kinds_of(principal, &request.kinds)?;
        match_expression(&request.query)?;
        let (sql, binds) = each_statement(request, &kinds)?;
        let hits = self.hits(&sql, binds)?;
        let tokens = words(&request.query);
        // The kinds come back in the order the request named them.
        let mut targets = Vec::with_capacity(hits.len());
        for kind in &kinds {
            for hit in hits.iter().filter(|hit| hit.1 == kind.as_str()) {
                targets.push(self.target(hit, &tokens, true)?);
            }
        }
        Ok(targets)
    }

    /// The correction: the words of `query` the index does not hold, replaced
    /// by the words it does. `None` when no word changed.
    ///
    /// The word list is the one index's, so the kinds named only have to be
    /// searchable. A sealed secret is never indexed, so the list holds no word of
    /// one.
    fn correct(
        &self,
        principal: &Principal,
        entities: &[&str],
        query: &str,
    ) -> Result<Option<String>, SearchError> {
        kinds_of(
            principal,
            &entities
                .iter()
                .map(|word| (*word).to_owned())
                .collect::<Vec<_>>(),
        )?;
        self.corrected(query, false)
    }

    fn correct_thin(
        &self,
        principal: &Principal,
        entities: &[&str],
        query: &str,
    ) -> Result<Option<String>, SearchError> {
        kinds_of(
            principal,
            &entities
                .iter()
                .map(|word| (*word).to_owned())
                .collect::<Vec<_>>(),
        )?;
        self.corrected(query, true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_kind_nobody_searches_is_refused_by_name_and_none_means_all() {
        for word in ["locker.item", "flag", "account", "calendar", "nonsense"] {
            assert!(
                matches!(
                    kinds_of(&Principal::Owner, &[word.to_owned()]),
                    Err(SearchError::NotSearchable { .. })
                ),
                "{word}"
            );
        }
        assert_eq!(
            kinds_of(&Principal::Owner, &[]).expect("all").len(),
            SEARCHABLE.len()
        );
        assert_eq!(
            kinds_of(&Principal::Owner, &["note".to_owned(), "note".to_owned()]).expect("one"),
            vec![Kind::Note]
        );
    }

    #[test]
    fn the_assistant_is_never_offered_nor_answered_a_locker_item() {
        let assistant = Principal::Assistant;
        for word in ["locker_item", "locker.item"] {
            assert!(
                matches!(
                    kinds_of(&assistant, &[word.to_owned()]),
                    Err(SearchError::NotSearchable { .. })
                ),
                "{word}"
            );
        }
        // Naming Locker beside another kind is refused whole, not trimmed.
        assert!(kinds_of(&assistant, &["note".to_owned(), "locker_item".to_owned()]).is_err());
        let all = kinds_of(&assistant, &[]).expect("all");
        assert_eq!(all.len(), SEARCHABLE.len() - 1);
        assert!(!all.contains(&Kind::LockerItem));
        // The owner and Locker's own search still name it.
        assert!(kinds_of(&Principal::Owner, &["locker_item".to_owned()]).is_ok());
    }

    /// THE CAP IS NOT COSMETIC: the tail leg is walked by FTS5 in rowid
    /// descending order (`INDEX 192` is `ORDER_ROWID | ORDER_DESC`, the order
    /// handed to the module) and nothing inside the leg sorts, so `LIMIT` ends
    /// the walk. The final `USE TEMP B-TREE` orders the at most
    /// `title matches + TAIL_ROWS` rows the legs produced, and is outside it.
    #[test]
    fn the_tail_leg_streams_the_index_and_does_not_sort_its_matches() {
        let dir = tempfile::tempdir().expect("a directory");
        let vault = centraid_vault::Vault::create(dir.path().join("vault.db")).expect("a vault");
        vault.found("Search", "Ada").expect("founded");
        let plan: Vec<(i64, i64, String)> = vault
            .read(|connection| {
                let mut binds = Binds::default();
                let cte = hits_cte("ca", &[Kind::Note], &[], &mut binds).expect("compiles");
                let sql = format!(
                    "EXPLAIN QUERY PLAN WITH {cte}
                     SELECT e.id, e.kind, e.title, hits.tier, hits.rank
                       FROM hits JOIN entity e ON e.n = hits.n
                      ORDER BY hits.tier, hits.rank, e.id LIMIT 5"
                );
                let mut statement = connection.prepare(&sql)?;
                Ok(statement
                    .query_map(rusqlite::params_from_iter(binds.0), |row| {
                        Ok((row.get(0)?, row.get(1)?, row.get(3)?))
                    })?
                    .collect::<rusqlite::Result<Vec<_>>>()?)
            })
            .expect("explains");
        let detail = |needle: &str| plan.iter().find(|(_, _, text)| text.contains(needle));
        assert!(
            detail("SCAN search VIRTUAL TABLE INDEX 192:").is_some(),
            "the tail leg is not ordered by the index: {plan:?}"
        );
        let (tail, _, _) = detail("CO-ROUTINE (subquery-").expect("the tail leg is a subquery");
        assert!(
            plan.iter()
                .all(|(_, parent, text)| !(parent == tail && text.contains("TEMP B-TREE"))),
            "the tail leg sorts its matches: {plan:?}"
        );
    }

    /// The per-kind statement reads the index twice, once per tier, and probes
    /// `entity` by its key; the window function orders the rows the tiers
    /// produced and nothing else.
    #[test]
    fn the_per_kind_statement_reads_the_index_once_per_tier() {
        let dir = tempfile::tempdir().expect("a directory");
        let vault = centraid_vault::Vault::create(dir.path().join("vault.db")).expect("a vault");
        vault.found("Search", "Ada").expect("founded");
        let request = EachRequest::new(
            [Kind::Note, Kind::Person].map(|kind| kind.as_str().to_owned()),
            "ca",
            8,
        );
        let (sql, binds) = each_statement(&request, &[Kind::Note, Kind::Person]).expect("compiles");
        let plan: Vec<String> = vault
            .read(|connection| {
                let mut statement = connection.prepare(&format!("EXPLAIN QUERY PLAN {sql}"))?;
                Ok(statement
                    .query_map(rusqlite::params_from_iter(binds.0), |row| row.get(3))?
                    .collect::<rusqlite::Result<Vec<String>>>()?)
            })
            .expect("explains");
        let scans = |needle: &str| plan.iter().filter(|text| text.contains(needle)).count();
        assert_eq!(scans("VIRTUAL TABLE INDEX 192:"), 1, "{plan:?}");
        assert_eq!(scans("VIRTUAL TABLE INDEX 0:"), 1, "{plan:?}");
        assert_eq!(scans("SCAN e"), 0, "{plan:?}");
    }
}
