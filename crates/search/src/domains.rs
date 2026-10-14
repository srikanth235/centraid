//! THE SEVEN DOMAINS, and the one that is missing on purpose.
//!
//! v0's `LINK_TARGET_KINDS` is the powerbox's whole vocabulary: what `[[` may
//! point at. It is ported here rather than into `crates/apps/notes` because
//! the door is where the *columns* are, and the columns are what the sealed
//! check has to run over — a table of column names in an app crate is a
//! table nothing checks.
//!
//! **Locker is not a kind.** The file it comes from says why, and the reason is
//! the shape of the list and not a filter inside it: "LOCKER IS NOT A KIND: the
//! absence is structural, so a secret cannot become a link target by adding a
//! probe" (`link-targets-table.ts:1`-`:3`).

use centraid_ontology::registries::sealed_physical_columns;

use crate::SearchError;

/// One searchable domain: what it is, how to read a row of it, and what an app
/// would open it in.
#[derive(Debug, Clone, Copy, PartialEq)]
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
    /// What each column of the index weighs in a match's rank, ONE PER COLUMN IN
    /// THE INDEX'S ORDER, the UNINDEXED id first (#1097, R1a, R1d).
    ///
    /// A column the index always had weighs 1.0 and a column folded in from
    /// another table by rung thirteen 0.5, so a word in a title or a name
    /// outranks the same word in a project, a nickname or a memo. The weights
    /// are not stored in the index (`INSERT INTO fts(fts, rank) VALUES('rank',
    /// …)` is data, and `contracts/schema/vault-ddl.sql` carries none): the door
    /// passes them with every query, so a vault built by replaying the DDL and a
    /// vault the product founded rank alike. [`crate::SqliteDoor::open`] refuses
    /// an index whose column count is not this list's length.
    pub weights: &'static [f64],
}

impl Domain {
    /// The `bm25(…)` string FTS5's rank override takes: `AND <fts>.rank MATCH ?`
    /// bound to this, for every query the door runs over the domain.
    #[must_use]
    pub fn rank_function(&self) -> String {
        let weights: Vec<String> = self
            .weights
            .iter()
            .map(|weight| format!("{weight:.1}"))
            .collect();
        format!("bm25({})", weights.join(", "))
    }

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
        // note_id, title, body
        weights: &[1.0, 1.0, 1.0],
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
        // party_id, display_name, sort_name, then the folds: nickname, role, met, channels, memo
        weights: &[1.0, 1.0, 1.0, 0.5, 0.5, 0.5, 0.5, 0.5],
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
        // event_id, summary, description, then the fold: location
        weights: &[1.0, 1.0, 1.0, 0.5],
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
        // task_id, title, description, then the fold: project
        weights: &[1.0, 1.0, 1.0, 0.5],
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
        // expense_id, description, then the folds: category, group_name, items, memo
        weights: &[1.0, 1.0, 0.5, 0.5, 0.5, 0.5],
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
        // content_id, title
        weights: &[1.0, 1.0],
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
        // document_id, title, body
        weights: &[1.0, 1.0, 1.0],
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

/// One column of a domain's index that the base table does not have, and the
/// table columns its text is read from.
///
/// An index folds attribute text into the entity's own row so that one probe per
/// domain answers (#1097, R1): a person's nickname and email, an event's place, a
/// task's project, an expense's group, line items and memo. Each fold is a
/// column the base table lacks, so a column check against the base table cannot
/// vouch for it. This list can: it names the source of every one, and
/// [`assert_no_sealed_column`] reads the sources against the sealed registry.
/// [`crate::SqliteDoor::open`] refuses an index with a column that is neither the
/// base table's nor listed here, so a fold cannot reach the index unseen.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Folded {
    /// The logical entity whose index carries the column.
    pub entity: &'static str,
    /// The column of the index (`fts_<table>`).
    pub column: &'static str,
    /// `(table, column)` pairs whose text the column holds.
    pub sources: &'static [(&'static str, &'static str)],
}

/// EVERY INDEX COLUMN THAT IS FOLDED FROM ANOTHER TABLE, with its sources.
///
/// The first three are older than #1097 (a note's and a document's decoded body,
/// a photo's asset title and recognised text); the rest are rung thirteen's. A
/// Locker memo is a `knowledge_annotation` too, and no entry here names it: the
/// party and expense memos are selected by their `target_type` in the triggers
/// (R1c).
///
/// `category` is a column of `tally_expense` itself and is listed because rung
/// thirteen folds it deliberately (not when it is `general`, R1b).
pub const FOLDED: &[Folded] = &[
    Folded {
        entity: "knowledge.note",
        column: "body",
        sources: &[("core_content_text", "body_text")],
    },
    Folded {
        entity: "core.party",
        column: "nickname",
        sources: &[("people_profile", "nickname")],
    },
    Folded {
        entity: "core.party",
        column: "role",
        sources: &[("people_profile", "role")],
    },
    Folded {
        entity: "core.party",
        column: "met",
        sources: &[("people_profile", "met")],
    },
    Folded {
        entity: "core.party",
        column: "channels",
        sources: &[
            ("social_contact_channel", "value"),
            ("social_contact_channel", "normalized_value"),
        ],
    },
    Folded {
        entity: "core.party",
        column: "memo",
        sources: &[("knowledge_annotation", "body_text")],
    },
    Folded {
        entity: "core.event",
        column: "location",
        sources: &[("core_place", "name")],
    },
    Folded {
        entity: "schedule.task",
        column: "project",
        sources: &[("schedule_project", "name")],
    },
    Folded {
        entity: "tally.expense",
        column: "category",
        sources: &[("tally_expense", "category")],
    },
    Folded {
        entity: "tally.expense",
        column: "group_name",
        sources: &[("social_circle", "name")],
    },
    Folded {
        entity: "tally.expense",
        column: "items",
        sources: &[("tally_expense_line_item", "description")],
    },
    Folded {
        entity: "tally.expense",
        column: "memo",
        sources: &[("knowledge_annotation", "body_text")],
    },
    Folded {
        entity: "core.content_item",
        column: "title",
        sources: &[
            ("media_asset", "title"),
            ("core_content_derivative", "text_content"),
        ],
    },
    Folded {
        entity: "core.document",
        column: "body",
        sources: &[
            ("core_content_derivative", "text_content"),
            ("core_content_text", "body_text"),
        ],
    },
];

/// The folded columns of one domain's index.
pub fn folded_columns(entity: &str) -> impl Iterator<Item = &'static Folded> + '_ {
    FOLDED.iter().filter(move |folded| folded.entity == entity)
}

/// The domain a logical entity names, or `None`.
#[must_use]
pub fn domain_of(entity: &str) -> Option<&'static Domain> {
    DOMAINS.iter().find(|domain| domain.entity == entity)
}

/// EVERY COLUMN EVERY DOMAIN PROJECTS IS UNSEALED, AND SO IS EVERY SOURCE OF
/// EVERY FOLD ([`FOLDED`]). Checked at door construction, not at review.
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
    // AND NO FOLDED COLUMN IS READ FROM ONE (#1097): the index text a domain
    // folds in comes from other tables, and each source is held to the same
    // registry.
    assert_folds_unsealed(FOLDED)
}

/// Every source of every fold in `folded` is unsealed.
fn assert_folds_unsealed(folded: &[Folded]) -> Result<(), SearchError> {
    let sealed = sealed_physical_columns();
    for fold in folded {
        for (table, column) in fold.sources {
            if sealed
                .iter()
                .any(|(sealed_table, name)| sealed_table == table && name == column)
            {
                return Err(SearchError::SealedColumnReachable {
                    entity: fold.entity.to_owned(),
                    table: (*table).to_owned(),
                    column: (*column).to_owned(),
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

    #[test]
    fn every_folded_column_belongs_to_a_domain_and_names_a_source() {
        for folded in FOLDED {
            assert!(
                domain_of(folded.entity).is_some(),
                "{} is not a domain",
                folded.entity
            );
            assert!(
                !folded.sources.is_empty(),
                "{}.{} names no source",
                folded.entity,
                folded.column
            );
        }
        let mut keys: Vec<(&str, &str)> = FOLDED
            .iter()
            .map(|folded| (folded.entity, folded.column))
            .collect();
        keys.sort_unstable();
        keys.dedup();
        assert_eq!(keys.len(), FOLDED.len(), "a folded column is listed twice");
    }

    /// A DEMONSTRATED RED for the folded sources: they are read against the
    /// registry, so a fold from a sealed column is a refusal. The domain check
    /// above cannot see one — the column is not on the base table.
    #[test]
    fn a_folded_source_that_is_sealed_is_refused() {
        let leaky = [Folded {
            entity: "core.party",
            column: "memo",
            sources: &[
                ("knowledge_annotation", "body_text"),
                ("locker_item", "password"),
            ],
        }];
        assert_eq!(
            assert_folds_unsealed(&leaky),
            Err(SearchError::SealedColumnReachable {
                entity: "core.party".to_owned(),
                table: "locker_item".to_owned(),
                column: "password".to_owned(),
            })
        );
        assert_eq!(assert_folds_unsealed(FOLDED), Ok(()));
    }

    /// A DEMONSTRATED RED for the checks above: the registry really does carry
    /// the columns they are defending against, so a green run is not vacuous.
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
