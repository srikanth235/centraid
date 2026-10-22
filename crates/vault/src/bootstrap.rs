//! Founding a vault: the `vault` row and the person it is for.
//!
//! The seeds (the flags, the money categories and their groups, the workout and
//! activity kinds, the relation label, the calendar, the `edge_shape` rows) are
//! rows of `contracts/migrations/001_baseline.sql`, written when the file is
//! made. What is left for founding is what differs per vault: its name, its
//! currency, and the self person, who is a `person` entity like any other
//! ([#1135](https://github.com/srikanth235/centraid/issues/1135)).

use crate::error::Result;
use crate::file::Vault;
use crate::model::Kind;

/// What founding made.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Founded {
    /// The self person: `vault.self_id`.
    pub self_id: String,
}

impl Vault {
    /// Found a vault in US dollars.
    pub fn found(&self, display_name: &str, owner_name: &str) -> Result<Founded> {
        self.found_in(display_name, owner_name, "USD")
    }

    /// Found a vault: write its `vault` row and its self person, in one commit.
    ///
    /// `vault.self_id` is a deferred foreign key, so the row may be written
    /// before the person it names, as it is here.
    pub fn found_in(
        &self,
        display_name: &str,
        owner_name: &str,
        base_currency: &str,
    ) -> Result<Founded> {
        let now = self.clock().now_text();
        let self_id = self.ids().next();
        self.commit(|tx| {
            tx.set_producer("vault.found");
            tx.connection().execute(
                "INSERT INTO vault (id, name, self_id, currency, zone, created_at)
                 VALUES (1, ?1, ?2, ?3, NULL, ?4)",
                rusqlite::params![display_name, self_id, base_currency, now],
            )?;
            tx.insert_entity(&self_id, Kind::Person, owner_name, &now)?;
            tx.connection()
                .execute("INSERT INTO person (id) VALUES (?1)", [&self_id])?;
            Ok(())
        })?;
        Ok(Founded { self_id })
    }

    /// The name the vault was founded under.
    pub fn display_name(&self) -> Result<Option<String>> {
        self.read(|connection| {
            Ok(connection
                .query_row("SELECT name FROM vault", [], |row| row.get(0))
                .ok())
        })
    }

    /// The vault's own time zone, when it has one.
    pub fn time_zone(&self) -> Result<Option<String>> {
        self.read(|connection| {
            Ok(connection
                .query_row("SELECT zone FROM vault", [], |row| row.get(0))
                .ok()
                .flatten())
        })
    }

    /// The vault's identity on the wire: its self person's id, `None` before the
    /// vault is founded. A vault has no id of its own; the person it is for is the
    /// one thing that distinguishes it.
    pub fn vault_id(&self) -> Result<Option<String>> {
        self.self_id()
    }

    /// The self person's id; `None` before the vault is founded.
    pub fn self_id(&self) -> Result<Option<String>> {
        self.read(|connection| {
            Ok(connection
                .query_row("SELECT self_id FROM vault", [], |row| row.get(0))
                .ok())
        })
    }
}
