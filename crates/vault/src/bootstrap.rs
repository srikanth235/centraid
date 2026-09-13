//! Founding a vault's own identity: the vault row and its owner.
//!
//! A freshly created file has a schema and no facts. This writes the two rows
//! nothing else can be written without — `core_vault` and the owner's
//! `core_party` — inside the commit guard, so they are the file's first log
//! commit and a seat bootstrapped from a snapshot of it sees them.
//!
//! It is here and not in `Vault::create` on purpose: creating a file and
//! deciding whose it is are two acts, and `centraid recover` (lane R) restores
//! a file that already has an owner.

use crate::error::Result;
use crate::file::Vault;

/// THE LINK RELATIONS, SEEDED AT FOUND TIME (#272; #1020, D-1020-N7).
///
/// **Relations are VOCABULARY, not caller text**: `core.link_entities` refuses a
/// notation that is not already a concept in the relations scheme, which means
/// the scheme has to exist before the first link — v0 seeds it here
/// (`packages/vault/src/bootstrap.ts:33`-`:64`) and a create-on-demand path
/// would turn "never caller-invented" into "invented on first use".
///
/// **`revises` IS DELIBERATELY ABSENT** (#996 R20(a)). Version lineage was a
/// content→content link asserted by the document and note edit commands — a
/// SECOND history mechanism beside `core_entity_revision`, which [#916] ruled
/// the only one. A version is an occurrence now, the concept that named the edge
/// has no writer, and seeding it would be dormant DDL (ONT-06).
///
/// **The other five seed schemes are still absent** — `activity-kinds`,
/// `spend-categories`, `flags`, `vision` and `doctype`. Docs' folders and flags
/// schemes are created on first use by `crates/vault/src/commands/core.rs`
/// instead, which is a divergence from v0 this lane files as a finding rather
/// than fixes in another slot's schema.
const SEED_RELATIONS: &[(&str, &str)] = &[
    ("same-as", "Same as"),
    ("about", "About"),
    ("works-for", "Works for"),
    ("duplicate-of", "Duplicate of"),
    // Cross-referencing relations (#272), which is what a `[[wikilink]]`
    // compiles to.
    ("references", "References"),
    ("attachment-of", "Attachment of"),
    // THE TWO ANSWERS TO A CROSS-SOURCE MATCH (#996 R20(c) / OQ-12). `same-as`
    // is the acceptance; `distinct-from` is the refusal, and it has to be a
    // relation rather than a dismissed notification because a refusal that is
    // not written down is a proposal the member is shown again tomorrow.
    ("distinct-from", "Distinct from"),
];

/// Seed the relations scheme and its notations. Idempotent over an existing
/// scheme, so re-founding a restored file adds nothing.
fn seed_relation_vocabulary(
    connection: &rusqlite::Connection,
    ids: &dyn crate::clock::Ids,
    now: &str,
) -> Result<()> {
    let uri = crate::commands::core_links::RELATIONS_SCHEME_URI;
    let scheme_id = match connection.query_row(
        "SELECT scheme_id FROM core_concept_scheme WHERE uri = ?1",
        [uri],
        |row| row.get::<_, String>(0),
    ) {
        Ok(scheme_id) => scheme_id,
        Err(_) => {
            let scheme_id = ids.next();
            connection.execute(
                "INSERT INTO core_concept_scheme
                   (scheme_id, uri, title, publisher, version, created_at)
                 VALUES (?1, ?2, 'Link relation types', NULL, '1', ?3)",
                rusqlite::params![scheme_id, uri, now],
            )?;
            scheme_id
        }
    };
    for (notation, label) in SEED_RELATIONS {
        connection.execute(
            "INSERT INTO core_concept
               (concept_id, scheme_id, notation, pref_label, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?5)
             ON CONFLICT (scheme_id, notation) DO NOTHING",
            rusqlite::params![ids.next(), scheme_id, notation, label, now],
        )?;
    }
    Ok(())
}

/// What founding produced.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Founded {
    pub vault_id: String,
    pub owner_party_id: String,
}

impl Vault {
    /// Write the vault row and its owner party.
    pub fn found(&self, display_name: &str, owner_name: &str) -> Result<Founded> {
        let now = self.clock().now_text();
        let vault_id = self.ids().next();
        let owner_party_id = self.ids().next();
        self.commit(|tx| {
            tx.set_producer("vault.found");
            // The owner first: `core_vault.self_party_id` points at it, and a
            // vault row with a dangling owner is a file that cannot answer
            // "whose is this".
            tx.connection().execute(
                "INSERT INTO core_party
                   (party_id, kind, display_name, created_at, updated_at)
                 VALUES (?1, 'person', ?2, ?3, ?3)",
                rusqlite::params![owner_party_id, owner_name, now],
            )?;
            tx.connection().execute(
                "INSERT INTO core_vault
                   (vault_id, self_party_id, display_name, status, base_currency,
                    settings_json, created_at, updated_at)
                 VALUES (?1, ?2, ?3, 'active', 'USD', '{}', ?4, ?4)",
                rusqlite::params![vault_id, owner_party_id, display_name, now],
            )?;
            seed_relation_vocabulary(tx.connection(), self.ids(), &now)?;
            Ok(())
        })?;
        Ok(Founded {
            vault_id,
            owner_party_id,
        })
    }

    /// The vault's own id, if it has been founded.
    pub fn vault_id(&self) -> Result<Option<String>> {
        self.read(|connection| {
            Ok(connection
                .query_row(
                    "SELECT vault_id FROM core_vault ORDER BY vault_id LIMIT 1",
                    [],
                    |row| row.get(0),
                )
                .ok())
        })
    }
}
