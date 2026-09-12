//! `(gateway_id, vault_id)` — the pair a seat file belongs to.
//!
//! One device can hold seats for more than one gateway, and one gateway can
//! serve more than one vault. Neither half alone names a file: two gateways
//! restored from the same backup share a `vault_id`, and one gateway serves
//! several vaults. So the storage key is a digest of the *pair*, and the
//! separator is a space because neither half may contain one — a concatenation
//! without a separator would let `("ab", "c")` and `("a", "bc")` collide.

use sha2::{Digest as _, Sha256};

/// Which gateway, which vault.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct SeatIdentity {
    pub gateway_id: String,
    pub vault_id: String,
}

impl SeatIdentity {
    pub fn new(gateway_id: impl Into<String>, vault_id: impl Into<String>) -> Self {
        Self {
            gateway_id: gateway_id.into(),
            vault_id: vault_id.into(),
        }
    }

    /// The digest this pair's files are named after.
    #[must_use]
    pub fn storage_key(&self) -> String {
        replica_storage_key(&self.gateway_id, &self.vault_id)
    }

    /// The seat file's name inside the device's private directory.
    #[must_use]
    pub fn database_name(&self) -> String {
        format!("centraid-replica-{}.sqlite3", self.storage_key())
    }

    /// The outbox's name. v0 kept intents in a second database on the web seat;
    /// v1 keeps them in the SAME file as the rows, which is what makes the
    /// atomic overlay clear expressible at all (`applier`'s in-transaction
    /// hook). The name is retained for a migration to recognise.
    #[must_use]
    pub fn intents_database_name(&self) -> String {
        format!("centraid-replica-intents-{}", self.storage_key())
    }
}

/// `sha256(gateway_id ‖ " " ‖ vault_id)`, lowercase hex.
#[must_use]
pub fn replica_storage_key(gateway_id: &str, vault_id: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(gateway_id.as_bytes());
    hasher.update(b" ");
    hasher.update(vault_id.as_bytes());
    hex::encode(hasher.finalize())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_key_is_a_function_of_both_halves() {
        let one = replica_storage_key("gw-a", "vault-1");
        assert_ne!(one, replica_storage_key("gw-a", "vault-2"));
        assert_ne!(one, replica_storage_key("gw-b", "vault-1"));
        assert_eq!(one, replica_storage_key("gw-a", "vault-1"));
        assert_eq!(one.len(), 64);
    }

    /// The separator is the point. Without it these two would be one file.
    #[test]
    fn a_shifted_boundary_is_a_different_key() {
        assert_ne!(
            replica_storage_key("ab", "c"),
            replica_storage_key("a", "bc")
        );
    }

    #[test]
    fn the_file_names_are_derived_and_not_stored() {
        let identity = SeatIdentity::new("gw-a", "vault-1");
        assert!(identity.database_name().starts_with("centraid-replica-"));
        assert!(identity.database_name().ends_with(".sqlite3"));
        assert!(
            identity
                .intents_database_name()
                .contains(&identity.storage_key())
        );
    }
}
