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
