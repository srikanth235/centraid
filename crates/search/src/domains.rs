//! THE SEVEN DOMAINS, and the one that is missing on purpose.
//!
//! v0's `LINK_TARGET_KINDS`
//! (`packages/blueprints/apps/notes/link-targets-table.ts:23`-`:71`) is the
//! powerbox's whole vocabulary: what `[[` may point at. It is ported here rather
//! than into `crates/apps/notes` because the door is where the *columns* are,
//! and the columns are what the sealed check has to run over — a table of column
//! names in an app crate is a table nothing checks.
//!
//! **Locker is not a kind.** The file it comes from says why, and the reason is
//! the shape of the list and not a filter inside it: "LOCKER IS NOT A KIND: the
//! absence is structural, so a secret cannot become a link target by adding a
//! probe" (`link-targets-table.ts:1`-`:3`).

use centraid_ontology::registries::sealed_physical_columns;

use crate::SearchError;

/// One searchable domain: what it is, how to read a row of it, and what an app
/// would open it in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Domain {
    /// The app a member would open this in, by id (#883, ruling O-label: the
    /// product catalogue owns the NAME).
    pub app_id: &'static str,
    /// The logical entity, e.g. `knowledge.note`.
    pub entity: &'static str,
    /// The physical base table.
    pub table: &'static str,
    /// The FTS5 shadow table.
    pub fts: &'static str,
    /// The base table's primary key, mirrored `UNINDEXED` into the shadow.
    pub id_column: &'static str,
    /// Label columns, first non-empty wins. **A row with none is not a
    /// target** — an unlabelled link is one a member cannot recognise.
    pub labels: &'static [&'static str],
    /// Subtitle columns, first non-empty wins; falling back to the app.
    pub subtitles: &'static [&'static str],
    /// The soft-delete column, when the domain has one. A trashed row leaves the
    /// index the moment it is trashed (#916, R11), and this is the door's own
    /// belt to that trigger's braces.
    pub deleted_column: Option<&'static str>,
}

impl Domain {
    /// Every base column this domain reads. The sealed check runs over exactly
    /// this list, so a domain that grows a projection grows its check with it.
    #[must_use]
    pub fn projected_columns(&self) -> Vec<&'static str> {
        let mut columns = vec![self.id_column];
        columns.extend_from_slice(self.labels);
        columns.extend_from_slice(self.subtitles);
        if let Some(deleted) = self.deleted_column {
            columns.push(deleted);
        }
        columns
    }
}

/// The powerbox's seven, in v0's own order — which is the order the sheet groups
/// them in (`powerbox.ts:8`-`:11`: the group order is DERIVED from this table,
/// never a second list that can disagree).
///
/// The subtitle choices are v0's and each is a judgement: an event's is its
/// start, a task's its due date, an expense's the day it was spent, a photo's
/// its media type. A note's is its body preview, which is why `knowledge.note`
/// reads a column the base table does not have — see [`PREVIEW_FROM_TEXT`].
pub const DOMAINS: &[Domain] = &[
    Domain {
        app_id: "notes",
        entity: "knowledge.note",
        table: "knowledge_note",
        fts: "fts_knowledge_note",
        id_column: "note_id",
        labels: &["title"],
        subtitles: &[],
        deleted_column: Some("deleted_at"),
    },
    Domain {
        app_id: "people",
        entity: "core.party",
        table: "core_party",
        fts: "fts_core_party",
        id_column: "party_id",
        labels: &["display_name"],
        subtitles: &[],
        deleted_column: None,
    },
    Domain {
        app_id: "agenda",
        entity: "core.event",
        table: "core_event",
        fts: "fts_core_event",
        id_column: "event_id",
        labels: &["summary"],
        subtitles: &["dtstart"],
        deleted_column: Some("deleted_at"),
    },
    Domain {
        app_id: "tasks",
        entity: "schedule.task",
        table: "schedule_task",
        fts: "fts_schedule_task",
        id_column: "task_id",
        labels: &["title"],
        subtitles: &["due_at"],
        deleted_column: Some("deleted_at"),
    },
    Domain {
        app_id: "tally",
        entity: "tally.expense",
        table: "tally_expense",
        fts: "fts_tally_expense",
        id_column: "expense_id",
        labels: &["description"],
        subtitles: &["spent_on"],
        deleted_column: Some("deleted_at"),
    },
    Domain {
        app_id: "photos",
        entity: "core.content_item",
        table: "core_content_item",
        fts: "fts_core_content_item",
        id_column: "content_id",
        // The byte row lost its `title` column (#996, R20(b)): what an owner
        // calls those bytes lives on the wrapper, and the index carries the
        // expression. The door reads the INDEX's column here, not the base
        // table's — see `sqlite::project`.
        labels: &[],
        subtitles: &[],
        deleted_column: Some("deleted_at"),
    },
    Domain {
        app_id: "docs",
        entity: "core.document",
        table: "core_document",
        fts: "fts_core_document",
        id_column: "document_id",
        labels: &["title"],
        subtitles: &[],
        deleted_column: Some("deleted_at"),
    },
];

/// The domains whose LABEL comes off the index rather than the base table.
///
/// `core.content_item` is the only one, and it is the #996 R20(b) consequence:
/// a photo's authored title is `media_asset.title` reached through an FTS
/// expression, so the base row has nothing to project. Reading the shadow's own
/// `title` column is the honest answer and keeps the label inside the set of
/// columns the sealed check already covers — the index cannot hold a sealed
/// column at all.
pub const INDEX_LABELLED: &[&str] = &["core.content_item"];

/// The domains whose SUBTITLE is the indexed body text rather than a column.
///
/// A note's subtitle in v0 is `preview`, a field the base row does not carry;
/// the powerbox's row builder falls back to the app's name when a subtitle is
/// absent (`link-targets-table.ts:90`). The port reads the decoded body out of
/// `core_content_text` — the same text the index was built from, capped so a
/// long body cannot ride a picker row.
pub const PREVIEW_FROM_TEXT: &[&str] = &["knowledge.note"];

/// How much of a body may ride a picker row. v0's own preview ceiling
/// (`queries/library.ts:96`).
pub const PREVIEW_CHARS: usize = 200;

/// The domain a logical entity names, or `None`.
#[must_use]
pub fn domain_of(entity: &str) -> Option<&'static Domain> {
    DOMAINS.iter().find(|domain| domain.entity == entity)
}

/// EVERY COLUMN EVERY DOMAIN PROJECTS IS UNSEALED. Checked at door
/// construction, not at review.
///
/// The registry is `contracts/schema/v0-registries.json`'s `sealedColumns`,
/// read through [`centraid_ontology::registries::sealed_physical_columns`] —
/// the same list `crates/vault`'s scrub and the snapshot's exclusions read, so
/// there is one answer to "what is sealed" and this door is bound by it.
///
/// # Errors
///
/// [`SearchError::SealedColumnReachable`], naming the domain and the column, if
/// a domain ever projects one.
pub fn assert_no_sealed_column() -> Result<(), SearchError> {
    let sealed = sealed_physical_columns();
    for domain in DOMAINS {
        for column in domain.projected_columns() {
            if sealed
                .iter()
                .any(|(table, name)| table == domain.table && name == column)
            {
                return Err(SearchError::SealedColumnReachable {
                    entity: domain.entity.to_owned(),
                    table: domain.table.to_owned(),
                    column: column.to_owned(),
                });
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_powerbox_reaches_seven_domains_and_locker_is_not_one() {
        assert_eq!(DOMAINS.len(), 7);
        assert!(domain_of("locker.item").is_none());
        assert!(domain_of("locker.item_field").is_none());
        assert!(domain_of("sync.connection_credential").is_none());
    }

    #[test]
    fn every_domain_is_distinct_and_names_its_own_shadow_table() {
        let mut entities: Vec<&str> = DOMAINS.iter().map(|domain| domain.entity).collect();
        entities.sort_unstable();
        entities.dedup();
        assert_eq!(entities.len(), DOMAINS.len());
        for domain in DOMAINS {
            assert_eq!(domain.fts, format!("fts_{}", domain.table));
        }
    }

    #[test]
    fn no_domain_projects_a_sealed_column() {
        assert_eq!(assert_no_sealed_column(), Ok(()));
    }

    /// A DEMONSTRATED RED for the check above: the registry really does carry
    /// the columns this is defending against, so a green run is not vacuous.
    #[test]
    fn the_sealed_registry_is_not_empty_and_names_lockers_columns() {
        let sealed = sealed_physical_columns();
        assert!(
            sealed
                .iter()
                .any(|(table, column)| table == "locker_item" && column == "password"),
            "the sealed registry no longer names locker_item.password — the check above would pass over an empty set"
        );
        assert!(
            sealed
                .iter()
                .any(|(table, column)| table == "locker_item_field" && column == "value_sealed")
        );
    }
}
