//! THE FIVE CONTAINERS, and why they are a registry of their own (#1097, R-1097-19..21).
//!
//! A notebook, an album, a Tasks project, a Tally group and a Docs folder are
//! things a member names and goes looking for by that name. They are not
//! [`crate::domains::DOMAINS`]: the Notes `[[` powerbox loops the domains, a
//! container is no link target, and a domain that grew an eighth member would grow
//! the sheet with it. So the door has a second list, held to the same checks at
//! [`crate::SqliteDoor::open`]: no sealed column projected or indexed, every
//! index column a base column, one weight per column; and each index has a
//! persistent `<index>_vocab`, so a typo in a container's name is corrected like
//! a typo in a note's.
//!
//! **Four indexes serve five containers**, because `core_collection` holds
//! notebooks and albums and its immutable `kind` says which app a row opens in
//! ([`Opens::ByKind`]). The door reads the kind off the base row it already joins,
//! so the index carries no column the table lacks.
//!
//! **A container hit is live.** A project is found while `archived_at` is NULL; a
//! Tally group is the `social_circle` a live `tally_group` stands on; a Docs
//! folder is a concept of the folders scheme that is not the `root`. The rung's
//! triggers keep the indexes to exactly those rows, and each of these is checked
//! again at the door ([`Container::deleted_column`], [`Container::guards`]), as the
//! domains' soft-delete predicate is.
//!
//! **Out, and why.** Calendars: one is seeded, no command makes another and the
//! Agenda has no calendar destination. People circles: the People app has no
//! circles screen. A circle with no live Tally group is not a result.
//!
//! Locker is never a container; neither is anything with a sealed column.

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

/// A condition on the base row that makes it a live container, beyond an archive
/// column. It is SQL over the base table aliased `b`, and it names every column it
/// reads so the sealed check can read them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Guard {
    /// A boolean expression over `b` (the base table).
    pub sql: &'static str,
    /// Every `(table, column)` the expression reads.
    pub reads: &'static [(&'static str, &'static str)],
}

/// One kind of container, and the index its name is found in.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Container {
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
    /// Label columns, first non-empty wins. A container with none is no result.
    pub labels: &'static [&'static str],
    /// The archive column, when the container has one: a row with it set is not
    /// found.
    pub deleted_column: Option<&'static str>,
    /// Further conditions a row meets to be live.
    pub guards: &'static [Guard],
    /// What each column of the index weighs, one per column in the index's
    /// order, the id first.
    pub weights: &'static [f64],
}

impl Container {
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

    /// Every base column this container reads, for the sealed check.
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

    /// The app a row of this container opens in, given its kind value (ignored
    /// when the container opens in one app). `None` for a kind nobody listed.
    #[must_use]
    pub fn app_of(&self, kind: &str) -> Option<&'static str> {
        self.opens.app_of(kind)
    }

    /// Every app this container opens in.
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

/// THE CONTAINERS. Four indexes, five kinds of thing.
pub const CONTAINERS: &[Container] = &[
    Container {
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
        // collection_id, name
        weights: &[1.0, 1.0],
    },
    Container {
        entity: "schedule.project",
        opens: Opens::App("tasks"),
        table: "schedule_project",
        fts: "fts_schedule_project",
        id_column: "project_id",
        labels: &["name"],
        deleted_column: Some("archived_at"),
        guards: &[],
        // project_id, name
        weights: &[1.0, 1.0],
    },
    Container {
        entity: "social.circle",
        opens: Opens::App("tally"),
        table: "social_circle",
        fts: "fts_social_circle",
        id_column: "circle_id",
        labels: &["name"],
        deleted_column: None,
        // A circle is a Tally group only while a live `tally_group` stands on it.
        guards: &[Guard {
            sql: "EXISTS (SELECT 1 FROM tally_group g \
                   WHERE g.circle_id = b.circle_id AND g.archived_at IS NULL)",
            reads: &[
                ("social_circle", "circle_id"),
                ("tally_group", "circle_id"),
                ("tally_group", "archived_at"),
            ],
        }],
        // circle_id, name
        weights: &[1.0, 1.0],
    },
    Container {
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
        // concept_id, pref_label
        weights: &[1.0, 1.0],
    },
];

/// The container a logical entity names, or `None`.
#[must_use]
pub fn container_of(entity: &str) -> Option<&'static Container> {
    CONTAINERS
        .iter()
        .find(|container| container.entity == entity)
}

/// EVERY COLUMN EVERY CONTAINER PROJECTS OR TESTS IS UNSEALED. Checked at door
/// construction, as `domains::assert_no_sealed_column` is for the domains.
///
/// # Errors
///
/// [`SearchError::SealedColumnReachable`], naming the container and the column.
pub fn assert_no_sealed_container_column() -> Result<(), SearchError> {
    assert_containers_unsealed(CONTAINERS)
}

fn assert_containers_unsealed(containers: &[Container]) -> Result<(), SearchError> {
    let sealed = sealed_physical_columns();
    let is_sealed = |table: &str, column: &str| {
        sealed
            .iter()
            .any(|(sealed_table, name)| sealed_table == table && name == column)
    };
    for container in containers {
        let mut reads: Vec<(&str, &str)> = container
            .projected_columns()
            .into_iter()
            .map(|column| (container.table, column))
            .collect();
        for guard in container.guards {
            reads.extend_from_slice(guard.reads);
        }
        if let Some((table, column)) = reads.into_iter().find(|(t, c)| is_sealed(t, c)) {
            return Err(SearchError::SealedColumnReachable {
                entity: container.entity.to_owned(),
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
    fn four_indexes_serve_five_containers_and_the_domains_stay_seven() {
        assert_eq!(CONTAINERS.len(), 4);
        assert_eq!(DOMAINS.len(), 7);
        let mut apps: Vec<&str> = CONTAINERS.iter().flat_map(Container::apps).collect();
        apps.sort_unstable();
        assert_eq!(apps, ["docs", "notes", "photos", "tally", "tasks"]);
    }

    #[test]
    fn the_registries_are_disjoint() {
        for container in CONTAINERS {
            assert!(
                DOMAINS
                    .iter()
                    .all(|domain| domain.entity != container.entity
                        && domain.fts != container.fts
                        && domain.table != container.table),
                "{} is a domain as well",
                container.entity
            );
        }
        let mut entities: Vec<&str> = CONTAINERS
            .iter()
            .map(|container| container.entity)
            .collect();
        entities.sort_unstable();
        entities.dedup();
        assert_eq!(entities.len(), CONTAINERS.len());
    }

    #[test]
    fn every_container_names_its_own_index_and_weighs_an_id_and_a_name() {
        for container in CONTAINERS {
            assert_eq!(container.fts, format!("fts_{}", container.table));
            assert_eq!(container.weights.len(), 2);
        }
    }

    #[test]
    fn locker_is_not_a_container() {
        for entity in [
            "locker.item",
            "locker.item_field",
            "sync.connection_credential",
        ] {
            assert!(container_of(entity).is_none());
        }
        assert!(
            CONTAINERS
                .iter()
                .all(|container| !container.apps().contains(&"locker"))
        );
    }

    #[test]
    fn no_container_projects_or_tests_a_sealed_column() {
        assert_eq!(assert_no_sealed_container_column(), Ok(()));
    }

    #[test]
    fn the_folder_guard_names_the_scheme_and_the_root() {
        let folders = container_of("core.concept").expect("folders are containers");
        let sql = folders.guards[0].sql;
        assert!(sql.contains(FOLDERS_SCHEME_URI));
        assert!(sql.contains(&format!("'{ROOT_FOLDER_NOTATION}'")));
    }

    #[test]
    fn a_collection_opens_by_its_kind_and_an_unlisted_kind_opens_nowhere() {
        let collection = container_of("core.collection").expect("collections are containers");
        assert_eq!(collection.app_of("notebook"), Some("notes"));
        assert_eq!(collection.app_of("album"), Some("photos"));
        assert_eq!(collection.app_of("shelf"), None);
        let project = container_of("schedule.project").expect("projects are containers");
        assert_eq!(project.app_of(""), Some("tasks"));
    }

    const READS_A_SECRET: [Container; 1] = [Container {
        guards: &[Guard {
            sql: "1",
            reads: &[("locker_item", "password")],
        }],
        ..CONTAINERS[0]
    }];

    /// A DEMONSTRATED RED for the guard reads: a guard that read a sealed column
    /// is a refusal, and so is a label that is one.
    #[test]
    fn a_container_that_reads_a_sealed_column_is_refused() {
        assert_eq!(
            assert_containers_unsealed(&READS_A_SECRET),
            Err(SearchError::SealedColumnReachable {
                entity: "core.collection".to_owned(),
                table: "locker_item".to_owned(),
                column: "password".to_owned(),
            })
        );
        let labelled: [Container; 1] = [Container {
            table: "locker_item",
            labels: &["password"],
            ..CONTAINERS[0]
        }];
        assert!(assert_containers_unsealed(&labelled).is_err());
    }
}
