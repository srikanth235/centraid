//! THE NAMED: what a member goes looking for by a name or by what they said, and
//! is no link target (#1097, R-1097-19..23).
//!
//! A notebook, an album, a Tasks project and a Docs folder are
//! things a member names and goes looking for by that name; a chat thread is a
//! conversation a member goes looking for by the word they remember asking. None
//! is in [`crate::domains::DOMAINS`]: the Notes `[[` powerbox loops the domains, a
//! named thing is no link target, and a domain that grew a member would grow the
//! sheet with it. So the door has a second list, held to the same checks
//! at [`crate::SqliteDoor::open`]: no sealed column projected, folded or indexed,
//! every index column a base column or a listed [`Fold`], one weight per column;
//! and each index has a persistent `<index>_vocab`, so a typo in a name is
//! corrected like a typo in a note's.
//!
//! **Why `NAMED` and not `CONTAINERS`.** The list was the containers' until the
//! chat history joined it (R-1097-23), and a thread is not a container: nothing is
//! filed in it. What the five kinds share is the registry's whole job, to be found
//! by the words a member gave them (a name, a title, what they said) without being
//! a domain, and "named" says that and nothing about what a row holds. A thread
//! is the one entry with a [`Fold`] (the member's own messages) and the one whose
//! app, `chat`, is not in the apps' catalogue: it opens in a Chat tab that only
//! the iOS shell has.
//!
//! **Four indexes serve five kinds**, because `core_collection` holds notebooks and
//! albums and its immutable `kind` says which app a row opens in
//! ([`Opens::ByKind`]). The door reads the kind off the base row it already joins,
//! so the index carries no column the table lacks.
//!
//! **A hit is live.** A project is found while `archived_at` is NULL; a Docs
//! folder is a concept of the folders scheme that is not the `root`. The rung's triggers keep
//! the indexes to exactly those rows, and each of these is checked again at the
//! door ([`Named::deleted_column`], [`Named::guards`]), as the domains'
//! soft-delete predicate is.
//!
//! **A thread is its title and what the member said** (R-1097-22): the text of
//! the member's own messages (`chat_message.role = 'user'`) and nothing else. The
//! assistant's words and a card's title are copies of other apps' rows that
//! outlive the rows (R-CHAT-3), and the routing record is not text, so no
//! column of `chat_message` but `text`, selected by `role`, is a source of the
//! fold below, and the sealed check reads exactly those sources.
//!
//! **Out, and why.** Calendars: one is seeded, no command makes another and the
//! Agenda has no calendar destination. People circles: the People app has no
//! circles screen, and the circle index left with Tally (#1099, R-1099-35).
//!
//! Locker is never named; neither is anything with a sealed column.

use centraid_ontology::registries::sealed_physical_columns;

use crate::SearchError;

/// WHAT A CONTAINER ROW OPENS IN.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Opens {
    /// One app, whatever the row.
    App(&'static str),
    /// The app depends on a column of the base row.
    ByKind {
        /// The base column that decides.
        column: &'static str,
        /// `(value, app id)`. A row whose value is not listed is not a result.
        apps: &'static [(&'static str, &'static str)],
    },
}

impl Opens {
    /// The app a row opens in, given its kind value (ignored when there is one
    /// app). `None` for a kind nobody listed.
    #[must_use]
    pub fn app_of(&self, kind: &str) -> Option<&'static str> {
        match self {
            Self::App(app) => Some(app),
            Self::ByKind { apps, .. } => apps
                .iter()
                .find(|(value, _)| *value == kind)
                .map(|(_, app)| *app),
        }
    }
}

/// A condition on the base row that makes it a live named row, beyond an archive
/// column. It is SQL over the base table aliased `b`, and it names every column it
/// reads so the sealed check can read them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Guard {
    /// A boolean expression over `b` (the base table).
    pub sql: &'static str,
    /// Every `(table, column)` the expression reads.
    pub reads: &'static [(&'static str, &'static str)],
}

/// One column of a named thing's index that its base table does not have, and
/// the table columns its text is read from: [`crate::domains::Folded`] for this
/// registry. The sealed check reads every source, and the door refuses to open
/// over an index column that is neither the base table's nor listed here.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Fold {
    /// The column of the index.
    pub column: &'static str,
    /// `(table, column)` pairs whose text the column holds.
    pub sources: &'static [(&'static str, &'static str)],
}

/// One kind of named thing, and the index its name is found in.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Named {
    /// The logical entity, e.g. `core.collection`.
    pub entity: &'static str,
    /// The app a row opens in.
    pub opens: Opens,
    /// The physical base table.
    pub table: &'static str,
    /// The FTS5 index, `fts_<table>`.
    pub fts: &'static str,
    /// The base table's primary key, mirrored `UNINDEXED` into the index.
    pub id_column: &'static str,
    /// Label columns, first non-empty wins. A kind with none is no result.
    pub labels: &'static [&'static str],
    /// The archive column, when the kind has one: a row with it set is not
    /// found.
    pub deleted_column: Option<&'static str>,
    /// Further conditions a row meets to be live.
    pub guards: &'static [Guard],
    /// The index columns the base table lacks, each with the columns its text is
    /// read from. Empty for every kind but a chat thread.
    pub folds: &'static [Fold],
    /// What each column of the index weighs, one per column in the index's
    /// order, the id first. A folded column weighs half a label, as the
    /// domains' do (#1097, R1a).
    pub weights: &'static [f64],
}

impl Named {
    /// The `bm25(…)` string the rank override takes, as `Domain::rank_function`.
    #[must_use]
    pub fn rank_function(&self) -> String {
        let weights: Vec<String> = self
            .weights
            .iter()
            .map(|weight| format!("{weight:.1}"))
            .collect();
        format!("bm25({})", weights.join(", "))
    }

    /// Every base column this kind reads, for the sealed check.
    #[must_use]
    pub fn projected_columns(&self) -> Vec<&'static str> {
        let mut columns = vec![self.id_column];
        columns.extend_from_slice(self.labels);
        if let Some(deleted) = self.deleted_column {
            columns.push(deleted);
        }
        if let Opens::ByKind { column, .. } = self.opens {
            columns.push(column);
        }
        columns
    }

    /// The app a row of this kind opens in, given its kind value (ignored
    /// when the kind opens in one app). `None` for a kind nobody listed.
    #[must_use]
    pub fn app_of(&self, kind: &str) -> Option<&'static str> {
        self.opens.app_of(kind)
    }

    /// Every app this kind opens in.
    #[must_use]
    pub fn apps(&self) -> Vec<&'static str> {
        match self.opens {
            Opens::App(app) => vec![app],
            Opens::ByKind { apps, .. } => apps.iter().map(|(_, app)| *app).collect(),
        }
    }
}

/// The folders scheme's URI: `FOLDER_SCHEME_URI` in `crates/vault/src/commands/core.rs`,
/// which a test holds equal. A Docs folder is a concept of it.
pub const FOLDERS_SCHEME_URI: &str = "https://centraid.dev/schemes/folders";

/// The folders scheme's top level, which is not a folder a member made or named.
pub const ROOT_FOLDER_NOTATION: &str = "root";

/// THE NAMED. Five indexes, six kinds of thing.
pub const NAMED: &[Named] = &[
    Named {
        entity: "core.collection",
        opens: Opens::ByKind {
            column: "kind",
            apps: &[("notebook", "notes"), ("album", "photos")],
        },
        table: "core_collection",
        fts: "fts_core_collection",
        id_column: "collection_id",
        labels: &["name"],
        // A notebook and an album are removed by DELETE.
        deleted_column: None,
        guards: &[],
        folds: &[],
        // collection_id, name
        weights: &[1.0, 1.0],
    },
    Named {
        entity: "schedule.project",
        opens: Opens::App("tasks"),
        table: "schedule_project",
        fts: "fts_schedule_project",
        id_column: "project_id",
        labels: &["name"],
        deleted_column: Some("archived_at"),
        guards: &[],
        folds: &[],
        // project_id, name
        weights: &[1.0, 1.0],
    },
    Named {
        entity: "core.concept",
        opens: Opens::App("docs"),
        table: "core_concept",
        fts: "fts_core_concept",
        id_column: "concept_id",
        labels: &["pref_label"],
        deleted_column: None,
        // A folder is a concept of the folders scheme and is not its root. Tags
        // and flags are concepts of other schemes.
        guards: &[Guard {
            sql: "b.\"notation\" <> 'root' AND EXISTS (SELECT 1 FROM core_concept_scheme s \
                   WHERE s.scheme_id = b.scheme_id \
                     AND s.uri = 'https://centraid.dev/schemes/folders')",
            reads: &[
                ("core_concept", "notation"),
                ("core_concept", "scheme_id"),
                ("core_concept_scheme", "scheme_id"),
                ("core_concept_scheme", "uri"),
            ],
        }],
        folds: &[],
        // concept_id, pref_label
        weights: &[1.0, 1.0],
    },
    Named {
        entity: "chat.thread",
        // The Chat tab, which only the iOS shell has: a shell without one draws
        // no row for it (R-1097-24).
        opens: Opens::App("chat"),
        table: "chat_thread",
        fts: "fts_chat_thread",
        id_column: "thread_id",
        labels: &["title"],
        // A thread is removed by DELETE, and its messages with it.
        deleted_column: None,
        guards: &[],
        // WHAT THE MEMBER SAID, and nothing else (R-1097-22): the text of the
        // member's own messages. `role` is the filter the triggers select by;
        // the assistant's text, a card, an attachment, `record_json`,
        // `refusal`, `notice`, `outcome` and `scope_app` are sources of nothing.
        folds: &[Fold {
            column: "said",
            sources: &[("chat_message", "text"), ("chat_message", "role")],
        }],
        // thread_id, title, then the fold: said
        weights: &[1.0, 1.0, 0.5],
    },
];

/// The named kind a logical entity names, or `None`.
#[must_use]
pub fn named_of(entity: &str) -> Option<&'static Named> {
    NAMED.iter().find(|named| named.entity == entity)
}

/// EVERY COLUMN EVERY NAMED KIND PROJECTS, TESTS OR FOLDS IN IS UNSEALED. Checked at door
/// construction, as `domains::assert_no_sealed_column` is for the domains.
///
/// # Errors
///
/// [`SearchError::SealedColumnReachable`], naming the entity and the column.
pub fn assert_no_sealed_named_column() -> Result<(), SearchError> {
    assert_named_unsealed(NAMED)
}

fn assert_named_unsealed(all: &[Named]) -> Result<(), SearchError> {
    let sealed = sealed_physical_columns();
    let is_sealed = |table: &str, column: &str| {
        sealed
            .iter()
            .any(|(sealed_table, name)| sealed_table == table && name == column)
    };
    for named in all {
        let mut reads: Vec<(&str, &str)> = named
            .projected_columns()
            .into_iter()
            .map(|column| (named.table, column))
            .collect();
        for guard in named.guards {
            reads.extend_from_slice(guard.reads);
        }
        for fold in named.folds {
            reads.extend_from_slice(fold.sources);
        }
        if let Some((table, column)) = reads.into_iter().find(|(t, c)| is_sealed(t, c)) {
            return Err(SearchError::SealedColumnReachable {
                entity: named.entity.to_owned(),
                table: table.to_owned(),
                column: column.to_owned(),
            });
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domains::DOMAINS;

    #[test]
    fn four_indexes_serve_five_kinds_and_the_domains_stay_six() {
        assert_eq!(NAMED.len(), 4);
        assert_eq!(DOMAINS.len(), 6);
        let mut apps: Vec<&str> = NAMED.iter().flat_map(Named::apps).collect();
        apps.sort_unstable();
        assert_eq!(apps, ["chat", "docs", "notes", "photos", "tasks"]);
    }

    #[test]
    fn the_registries_are_disjoint() {
        for named in NAMED {
            assert!(
                DOMAINS.iter().all(|domain| domain.entity != named.entity
                    && domain.fts != named.fts
                    && domain.table != named.table),
                "{} is a domain as well",
                named.entity
            );
        }
        let mut entities: Vec<&str> = NAMED.iter().map(|named| named.entity).collect();
        entities.sort_unstable();
        entities.dedup();
        assert_eq!(entities.len(), NAMED.len());
    }

    /// Every entry names its own index, and weighs the id, the label and each
    /// fold: a fold weighs half a label, as the domains' do.
    #[test]
    fn every_entry_names_its_own_index_and_weighs_an_id_a_name_and_each_fold() {
        for named in NAMED {
            assert_eq!(named.fts, format!("fts_{}", named.table));
            assert_eq!(
                named.weights.len(),
                2 + named.folds.len(),
                "{}",
                named.entity
            );
            assert!(
                named.weights[..2]
                    .iter()
                    .all(|weight| (weight - 1.0).abs() < f64::EPSILON)
            );
            assert!(
                named.weights[2..]
                    .iter()
                    .all(|weight| (weight - 0.5).abs() < f64::EPSILON)
            );
        }
    }

    #[test]
    fn locker_is_not_named() {
        for entity in [
            "locker.item",
            "locker.item_field",
            "sync.connection_credential",
        ] {
            assert!(named_of(entity).is_none());
        }
        assert!(NAMED.iter().all(|named| !named.apps().contains(&"locker")));
    }

    #[test]
    fn no_named_kind_projects_tests_or_folds_in_a_sealed_column() {
        assert_eq!(assert_no_sealed_named_column(), Ok(()));
    }

    #[test]
    fn the_folder_guard_names_the_scheme_and_the_root() {
        let folders = named_of("core.concept").expect("folders are named");
        let sql = folders.guards[0].sql;
        assert!(sql.contains(FOLDERS_SCHEME_URI));
        assert!(sql.contains(&format!("'{ROOT_FOLDER_NOTATION}'")));
    }

    #[test]
    fn a_collection_opens_by_its_kind_and_an_unlisted_kind_opens_nowhere() {
        let collection = named_of("core.collection").expect("collections are named");
        assert_eq!(collection.app_of("notebook"), Some("notes"));
        assert_eq!(collection.app_of("album"), Some("photos"));
        assert_eq!(collection.app_of("shelf"), None);
        let project = named_of("schedule.project").expect("projects are named");
        assert_eq!(project.app_of(""), Some("tasks"));
    }

    /// R-1097-22: the chat thread is the one entry with a fold, its one column is
    /// `said`, and its sources are the text and the role of a message and nothing
    /// else. The assistant's words, a card, an attachment, `record_json`,
    /// `refusal`, `notice`, `outcome` and `scope_app` are sources of nothing.
    #[test]
    fn a_thread_folds_the_text_the_member_said_and_nothing_of_the_assistant() {
        let chat = named_of("chat.thread").expect("a thread is named");
        assert_eq!(chat.app_of(""), Some("chat"));
        assert_eq!(chat.labels, ["title"]);
        assert_eq!(chat.folds.len(), 1);
        assert_eq!(chat.folds[0].column, "said");
        assert_eq!(
            chat.folds[0].sources,
            [("chat_message", "text"), ("chat_message", "role")]
        );
        for kept_out in [
            "record_json",
            "refusal",
            "notice",
            "outcome",
            "scope_app",
            "chat_message_card",
            "chat_message_attachment",
        ] {
            assert!(
                chat.folds[0]
                    .sources
                    .iter()
                    .all(|(table, column)| *table != kept_out && *column != kept_out),
                "{kept_out} is a source of what a thread is found by"
            );
            assert!(!chat.projected_columns().contains(&kept_out));
        }
        assert_eq!(
            NAMED.iter().filter(|named| !named.folds.is_empty()).count(),
            1,
            "a fold is a thread's alone"
        );
    }

    const READS_A_SECRET: [Named; 1] = [Named {
        guards: &[Guard {
            sql: "1",
            reads: &[("locker_item", "password")],
        }],
        ..NAMED[0]
    }];

    /// A DEMONSTRATED RED for the guard reads: a guard that read a sealed column
    /// is a refusal, and so is a label that is one.
    #[test]
    fn a_named_kind_that_reads_a_sealed_column_is_refused() {
        assert_eq!(
            assert_named_unsealed(&READS_A_SECRET),
            Err(SearchError::SealedColumnReachable {
                entity: "core.collection".to_owned(),
                table: "locker_item".to_owned(),
                column: "password".to_owned(),
            })
        );
        let labelled: [Named; 1] = [Named {
            table: "locker_item",
            labels: &["password"],
            ..NAMED[0]
        }];
        assert!(assert_named_unsealed(&labelled).is_err());
    }

    /// A DEMONSTRATED RED for the fold sources: a fold that read a sealed column
    /// is a refusal, which the guards' and labels' checks above cannot see.
    #[test]
    fn a_fold_that_reads_a_sealed_column_is_refused() {
        let leaky: [Named; 1] = [Named {
            folds: &[Fold {
                column: "said",
                sources: &[("chat_message", "text"), ("locker_item", "password")],
            }],
            ..NAMED[3]
        }];
        assert_eq!(
            assert_named_unsealed(&leaky),
            Err(SearchError::SealedColumnReachable {
                entity: "chat.thread".to_owned(),
                table: "locker_item".to_owned(),
                column: "password".to_owned(),
            })
        );
        assert_eq!(assert_named_unsealed(NAMED), Ok(()));
    }
}
