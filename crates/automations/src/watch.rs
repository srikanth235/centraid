//! The watch list, made **structural** (#1020, D-1020-AU1, census seam C3).
//!
//! ## What v0 has, and why it is the thing that breaks
//!
//! v0's loop guard is a NAME LIST: `TRIGGER_CURSOR_DENIED_TABLES` in
//! `manifest.ts:405`–`:437`, eleven strings plus an `outbox` schema check, and
//! the comment above it is right about what it prevents — *"cursor machinery,
//! outbox, ingress, and conversation-ledger entities are excluded to prevent
//! trigger loops"*. A data trigger on the automation cursor table would fire on
//! the rows its own fire writes, forever.
//!
//! The census names the failure mode without needing an incident to point at:
//! *"it is a name list, not a structural rule. A port that adds a table forgets
//! to exclude it."* Wave 4 alone adds fourteen ledger-band tables; the eleventh
//! name on that list was `conversation_digest`, and nobody would have thought
//! to add `attachments` if `items` had been the only one that hurt.
//!
//! ## The rule this module replaces it with
//!
//! A [`Watchable`] cannot be constructed from a string. It is constructed by
//! LOOKING THE ENTITY UP in `contracts/schema/v0-registries.json` and refusing
//! unless all three hold:
//!
//! 1. the registry carries an entity with that logical name — so a physical or
//!    invented table name (`trigger_ingress`, `conversations`) has nothing to
//!    find and is refused by absence, not by a list;
//! 2. its `lifecycle` is not `machinery` — which is exactly membership of a
//!    machinery BAND (`access, agent, audit, blob, enrich, ledger,
//!    notifications, outbox, share, sync`), and
//!    [`tests::machinery_is_exactly_the_band_schemas`] holds those two facts
//!    together over the whole registry rather than trusting the sentence;
//! 3. its physical table is not in `localTables` — the deliberately
//!    unregistered set, which is a second, independent reason a feed is not a
//!    feed.
//!
//! **The ledger band therefore cannot be forgotten**: it has no registered
//! entities at all (`ledger` appears in `machineryBands` and in 14 rows of
//! `localTables`, and in zero rows of `entities`), so `automation_state`,
//! `automation_trigger_cursor`, `trigger_ingress`, `conversations`, `turns`,
//! `items` and every table a future wave adds beside them fail test 1 the day
//! they are created. A new ledger table becomes watchable only by being
//! registered as a non-machinery entity under an ontology pack, which is a
//! loud, reviewable, separate mistake.
//!
//! And `enrich.*` is refused by test 2, which matters for a different loop:
//! the recognition handlers write `enrich_derivation`, so a data trigger on it
//! would be an enricher triggering itself one stamp at a time.

use std::collections::BTreeSet;
use std::fmt;
use std::sync::OnceLock;

use centraid_ontology::registries::v0_registries;

/// A logical entity a trigger cursor may watch. **Constructible only through
/// [`Watchable::resolve`].**
///
/// The newtype is the guard: `fire` and the manifest parser take a
/// `Watchable`, so there is no call path that watches a string. A field of
/// `String` with a validator beside it is the shape v0 has, and the shape a
/// new call site skips.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Watchable(String);

impl Watchable {
    /// The logical name, `core.transaction`.
    #[must_use]
    pub fn logical(&self) -> &str {
        &self.0
    }

    /// The physical table the cursor reads, `core_transaction`.
    #[must_use]
    pub fn table(&self) -> &'static str {
        // Present by construction: `resolve` found this entity in the registry.
        registry()
            .iter()
            .find(|entry| entry.logical == self.0)
            .map(|entry| entry.table)
            .unwrap_or_default()
    }

    /// Resolve a logical entity name against the registry, or say why not.
    pub fn resolve(logical: &str) -> Result<Self, WatchRefusal> {
        let found = registry().iter().find(|entry| entry.logical == logical);
        let Some(entry) = found else {
            return Err(WatchRefusal::Unregistered {
                entity: logical.to_owned(),
            });
        };
        if entry.machinery {
            return Err(WatchRefusal::Machinery {
                entity: logical.to_owned(),
                band: entry.band.to_owned(),
            });
        }
        if entry.local {
            return Err(WatchRefusal::Local {
                entity: logical.to_owned(),
                table: entry.table.to_owned(),
            });
        }
        Ok(Self(logical.to_owned()))
    }
}

impl fmt::Display for Watchable {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        out.write_str(&self.0)
    }
}

/// Why an entity may not be watched. Each variant is a SENTENCE a manifest
/// author reads, and each names the structural reason rather than a list.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum WatchRefusal {
    /// Nothing in the ontology answers to this name. Every ledger-band table
    /// lands here, which is the point.
    #[error(
        "\"{entity}\" is not a logical entity in this vault's ontology, so no trigger cursor can \
         watch it — the runtime's own tables (the conversation ledger, the trigger cursors, the \
         ingress) are deliberately unregistered, and a trigger over them would fire on the rows \
         its own run writes"
    )]
    Unregistered { entity: String },
    /// Registered, but plumbing. The band is named because the author's next
    /// question is which one.
    #[error(
        "\"{entity}\" belongs to the \"{band}\" machinery band, which is the gateway's own \
         plumbing rather than life data — watching it would make this automation react to its own \
         bookkeeping"
    )]
    Machinery { entity: String, band: String },
    /// Registered and not machinery, but never leaves the gateway.
    #[error(
        "\"{entity}\" is stored in \"{table}\", which is deliberately unregistered and never \
         leaves this gateway, so it carries no change feed to watch"
    )]
    Local { entity: String, table: String },
}

/// One registry row, reduced to the three questions [`Watchable::resolve`] asks.
struct WatchEntry {
    logical: &'static str,
    table: &'static str,
    band: &'static str,
    machinery: bool,
    local: bool,
}

fn registry() -> &'static [WatchEntry] {
    static ENTRIES: OnceLock<Vec<WatchEntry>> = OnceLock::new();
    ENTRIES.get_or_init(|| {
        let registries = v0_registries();
        let local: BTreeSet<&str> = registries
            .local_tables
            .iter()
            .map(|entry| entry.table.as_str())
            .collect();
        registries
            .entities
            .iter()
            .map(|entity| WatchEntry {
                logical: entity.logical.as_str(),
                table: entity.table.as_str(),
                band: entity.logical.split('.').next().unwrap_or_default(),
                machinery: entity.lifecycle == "machinery",
                local: local.contains(entity.table.as_str()),
            })
            .collect()
    })
}

/// Every entity a trigger may watch, sorted. The positive form of the rule,
/// for the manifest linter's own message and for the CLI.
#[must_use]
pub fn watchable_entities() -> Vec<&'static str> {
    let mut names: Vec<&'static str> = registry()
        .iter()
        .filter(|entry| !entry.machinery && !entry.local)
        .map(|entry| entry.logical)
        .collect();
    names.sort_unstable();
    names
}

#[cfg(test)]
mod tests {
    use super::*;

    /// THE REFUSAL THE STRUCTURE EXISTS FOR. Five of these names are v0's
    /// hand-written list; the sixth and seventh are wave 4's additions, which
    /// nobody added to any list.
    #[test]
    fn a_ledger_table_refuses() {
        for name in [
            "automation_state",
            "automation_trigger_cursor",
            "trigger_ingress",
            "conversations",
            "turns",
            "items",
            "attachments",
            "conversation_archive",
            "conversation_digest",
            "harness_health",
            "conversation_provider_consent",
            "ledger.conversations",
            "ledger.turns",
            "scheduler_ledger",
        ] {
            let refusal = Watchable::resolve(name)
                .expect_err("a ledger-band table is not watchable at any spelling");
            assert_eq!(
                refusal,
                WatchRefusal::Unregistered {
                    entity: name.to_owned()
                },
                "{name} must be refused by ABSENCE from the ontology, not by a name list"
            );
        }
    }

    /// The whole ledger band, mechanically: every `localTables` row whose
    /// reason names the band. This is the test that catches the table wave 5
    /// adds.
    #[test]
    fn every_ledger_band_table_in_the_registry_refuses() {
        let ledger: Vec<&str> = v0_registries()
            .local_tables
            .iter()
            .filter(|entry| entry.reason.contains("ledger"))
            .map(|entry| entry.table.as_str())
            .collect();
        assert!(
            ledger.len() >= 10,
            "the ledger band's local-table rows are the subject of this test: {ledger:?}"
        );
        for table in ledger {
            assert!(
                Watchable::resolve(table).is_err(),
                "{table} is a ledger-band table and must not be watchable"
            );
        }
    }

    /// `outbox` is the one schema v0 special-cases; here it is refused for the
    /// same reason every other band is.
    #[test]
    fn the_outbox_and_the_enrichment_plane_refuse_as_machinery() {
        assert_eq!(
            Watchable::resolve("outbox.item"),
            Err(WatchRefusal::Machinery {
                entity: "outbox.item".to_owned(),
                band: "outbox".to_owned(),
            })
        );
        // The loop this one prevents: `enrich.derivation` is what a recognition
        // handler WRITES, so watching it is an enricher triggering itself.
        assert_eq!(
            Watchable::resolve("enrich.derivation"),
            Err(WatchRefusal::Machinery {
                entity: "enrich.derivation".to_owned(),
                band: "enrich".to_owned(),
            })
        );
        assert!(Watchable::resolve("agent.command").is_err());
        assert!(Watchable::resolve("access.agent").is_err());
    }

    /// Life data stays watchable — the guard is not a ban on triggers.
    #[test]
    fn an_ontology_pack_entity_resolves_and_names_its_table() {
        let watchable = Watchable::resolve("core.transaction").expect("life data is watchable");
        assert_eq!(watchable.logical(), "core.transaction");
        assert_eq!(watchable.table(), "core_transaction");
        for name in [
            "core.document",
            "media.asset",
            "tally.obligation",
            "people.profile",
        ] {
            assert!(
                Watchable::resolve(name).is_ok(),
                "{name} is life data and must stay watchable"
            );
        }
    }

    /// The claim in the module header, held rather than asserted in prose: the
    /// `machinery` lifecycle and the machinery BANDS are the same set, so
    /// rule 2 is a band rule and a band rule is what survives a new table.
    #[test]
    fn machinery_is_exactly_the_band_schemas() {
        let registries = v0_registries();
        let bands: BTreeSet<&str> = registries
            .machinery_bands
            .iter()
            .map(String::as_str)
            .collect();
        let packs: BTreeSet<&str> = registries
            .ontology_packs
            .iter()
            .map(String::as_str)
            .collect();
        assert!(bands.contains("ledger"));
        for entity in &registries.entities {
            let schema = entity.logical.split('.').next().expect("a schema");
            let machinery = entity.lifecycle == "machinery";
            assert_eq!(
                machinery,
                bands.contains(schema),
                "{} is lifecycle {} but schema {schema}",
                entity.logical,
                entity.lifecycle
            );
            assert_eq!(!machinery, packs.contains(schema));
        }
    }

    /// The registry has no `ledger` entity at all — which is why rule 1 and not
    /// rule 2 is what refuses a ledger table.
    #[test]
    fn the_ledger_band_registers_no_entity() {
        assert!(
            !v0_registries()
                .entities
                .iter()
                .any(|entity| entity.logical.starts_with("ledger.")),
            "the ledger band is names-only (D-1020-AS3); a registered ledger entity would make \
             it watchable and is the change this test exists to catch"
        );
    }

    #[test]
    fn the_positive_list_is_life_data_and_only_life_data() {
        let names = watchable_entities();
        assert!(names.len() > 50, "{}", names.len());
        assert!(names.contains(&"core.party"));
        assert!(!names.iter().any(|name| name.starts_with("enrich.")));
        assert!(!names.iter().any(|name| name.starts_with("outbox.")));
        let mut sorted = names.clone();
        sorted.sort_unstable();
        assert_eq!(names, sorted, "the list is the CLI's, so it is ordered");
    }
}
