//! THE DOOR OVER AN OPEN VAULT — the only `MATCH` statements in the workspace.
//!
//! One statement shape, built per domain from [`crate::domains::DOMAINS`]:
//!
//! ```sql
//! SELECT b."<pk>", <title>, <subtitle>, snippet(<fts>, -1, '⟦', '⟧', '…', 12), <fts>.rank
//!   FROM <fts> JOIN "<base>" b ON b."<pk>" = <fts>."<pk>"
//!  WHERE <fts> MATCH ?1 [AND b."deleted_at" IS NULL] [AND (<fts>.rank, b."<pk>") > (?, ?)]
//!  ORDER BY <fts>.rank, b."<pk>" LIMIT ?
//! ```
//!
//! Three things in it are load-bearing and none is decoration:
//!
//! * **The keyset is a row value.** `(rank, pk) > (?, ?)` is what SQLite turns
//!   into one ordered walk of the match set; the equivalent disjunction is what
//!   an optimiser has to be talked into (`packages/core/src/page/statement.ts:93`-`:98`).
//!   The pk is in the key for the reason every other page has it there: two
//!   documents can score identically, and keyed on the score alone a page
//!   boundary silently repeats or drops one.
//! * **The rank is NEGATIVE and ascending is best-first.** FTS5's `rank` is bm25
//!   negated, so `ORDER BY rank` puts the best match first — the order v0 keeps
//!   and calls "vault order is rank order"
//!   (`packages/blueprints/apps/notes/queries/search.ts:231`). A port that sorted
//!   descending would answer the worst matches.
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
//! the search **closed**, and a receipt for the decision either way
//! (`packages/vault/src/gateway/search.ts:74`-`:130`). This door takes the
//! [`Principal`] it is handed and does none of that: it is the OWNER's view,
//! which is the identity the parity fixtures are generated under and therefore
//! the identity that makes them comparable. Wiring the consent pipeline is
//! `crates/vault`'s paged-door work and is named as a hand-off in
//! `crates/search/README.md` rather than stubbed here, because a stub that
//! *looks* like a consent check is worse than an absence that is written down.

use centraid_apps_kit::page::{Page, PageCursor, page_of, probe_limit};
use centraid_ontology::jsvalue::js_number_to_string;
use centraid_ontology::registries::sealed_physical_columns;
use rusqlite::Connection;

use crate::domains::{
    Domain, INDEX_LABELLED, PREVIEW_CHARS, PREVIEW_FROM_TEXT, assert_no_sealed_column, domain_of,
};
use crate::matching::match_expression;
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
    /// Two checks, both at open and neither at query time — a door that checks
    /// per call is a door someone can be talked into skipping a check on:
    ///
    /// 1. no domain PROJECTS a sealed column
    ///    ([`assert_no_sealed_column`]);
    /// 2. no domain's live FTS table CARRIES one. v0 throws at DDL-build time
    ///    for this (`schema/fts.ts:404`-`:419`, #293); re-checking the live index
    ///    is what keeps the DDL and this door from disagreeing about a file that
    ///    was written by another build.
    ///
    /// # Errors
    ///
    /// [`SearchError::SealedColumnReachable`] for either, and
    /// [`SearchError::IndexUnusable`] when a domain's shadow table is not in
    /// this file.
    pub fn open(connection: &'connection Connection) -> Result<Self, SearchError> {
        assert_no_sealed_column()?;
        let sealed = sealed_physical_columns();
        for domain in DOMAINS {
            let columns = index_columns(connection, domain)?;
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
        }
        Ok(Self { connection })
    }

    /// The connection, for a caller that seeds a fixture through it.
    #[must_use]
    pub const fn connection(&self) -> &'connection Connection {
        self.connection
    }
}

/// The live column names of a domain's shadow table.
fn index_columns(connection: &Connection, domain: &Domain) -> Result<Vec<String>, SearchError> {
    let mut statement = connection
        .prepare("SELECT name FROM pragma_table_info(?1) ORDER BY cid")
        .map_err(|error| SearchError::Sqlite(error.to_string()))?;
    let names: Vec<String> = statement
        .query_map([domain.fts], |row| row.get::<_, String>(0))
        .map_err(|error| SearchError::Sqlite(error.to_string()))?
        .collect::<Result<Vec<String>, rusqlite::Error>>()
        .map_err(|error| SearchError::Sqlite(error.to_string()))?;
    if names.is_empty() {
        return Err(SearchError::IndexUnusable {
            entity: domain.entity.to_owned(),
            detail: format!("`{}` is not a table in this vault", domain.fts),
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

impl Search for SqliteDoor<'_> {
    fn query(&self, principal: &Principal, request: &SearchRequest) -> Result<Answer, SearchError> {
        let domain = domain_of(&request.entity).ok_or_else(|| SearchError::NotADomain {
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
        let probe = probe_limit(&clamped)?;

        let title = title_expression(domain);
        let mut predicates: Vec<String> = vec![format!("{fts} MATCH ?1", fts = domain.fts)];
        if let Some(deleted) = domain.deleted_column {
            predicates.push(format!("b.\"{deleted}\" IS NULL"));
        }
        // A ROW WITH NO LABEL IS NOT A TARGET (`link-targets-table.ts:86`-`:88`),
        // and an excluded id is the caller's own contract — Notes' journal set
        // (#834 R-journal). **Both are predicates, not a post-filter**, and the
        // difference is the probe: the kit's page is the window plus one row,
        // and dropping rows after that row was counted makes `next` claim a
        // continuation the caller cannot use, or withhold one it is owed. A
        // fixture with one unlabelled note is what found that.
        predicates.push(format!("{title} <> ''"));
        let mut binds: Vec<rusqlite::types::Value> =
            vec![rusqlite::types::Value::Text(expression.clone())];
        if !request.excluded_ids.is_empty() {
            let placeholders = vec!["?"; request.excluded_ids.len()].join(", ");
            predicates.push(format!(
                "b.\"{pk}\" NOT IN ({placeholders})",
                pk = domain.id_column
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
                fts = domain.fts,
                pk = domain.id_column
            ));
            binds.push(rusqlite::types::Value::Real(rank));
            binds.push(rusqlite::types::Value::Text(after.pk.clone()));
        }
        binds.push(rusqlite::types::Value::Integer(
            i64::try_from(probe).unwrap_or(i64::MAX),
        ));

        let sql = format!(
            "SELECT b.\"{pk}\" AS id,
                    {title} AS title,
                    {subtitle} AS subtitle,
                    COALESCE(snippet({fts}, -1, '⟦', '⟧', '…', 12), '') AS snippet,
                    {fts}.rank AS rank
               FROM {fts} JOIN \"{base}\" b ON b.\"{pk}\" = {fts}.\"{pk}\"
              WHERE {predicate}
              ORDER BY {fts}.rank, b.\"{pk}\"
              LIMIT ?",
            pk = domain.id_column,
            base = domain.table,
            fts = domain.fts,
            subtitle = subtitle_expression(domain),
            predicate = predicates.join(" AND "),
        );

        let mut statement =
            self.connection
                .prepare(&sql)
                .map_err(|error| SearchError::IndexUnusable {
                    entity: domain.entity.to_owned(),
                    detail: error.to_string(),
                })?;
        let fetched: Vec<(Target, f64)> = statement
            .query_map(rusqlite::params_from_iter(binds), |row| {
                let id: String = row.get("id")?;
                let title: String = row.get("title")?;
                let subtitle: String = row.get("subtitle")?;
                let snippet: String = row.get("snippet")?;
                let rank: f64 = row.get("rank")?;
                Ok((
                    Target {
                        entity: domain.entity.to_owned(),
                        id,
                        title,
                        // v0's `first(row, subtitles) || app`: never empty, so a
                        // surface has nothing to guess.
                        subtitle: if subtitle.trim().is_empty() {
                            domain.app_id.to_owned()
                        } else {
                            subtitle
                        },
                        app_id: domain.app_id.to_owned(),
                        snippet,
                    },
                    rank,
                ))
            })
            .map_err(|error| SearchError::Sqlite(error.to_string()))?
            .collect::<Result<Vec<(Target, f64)>, rusqlite::Error>>()
            .map_err(|error| SearchError::Sqlite(error.to_string()))?;

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
}

#[cfg(test)]
mod tests {
    use super::*;

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
