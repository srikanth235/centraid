//! `vault_id` — the one thing a seat file belongs to (#1025 S1, D-1025-S1-1).
//!
//! ## THE VAULT IS THE UNIT ON A DEVICE, AND NOTHING IS NAMED BY A GATEWAY
//!
//! Each vault a device holds has its own pairing, address, replica file,
//! cursor, outbox, byte store and endpoint key. "Gateway" is not a noun the
//! device has: a gateway's endpoint id is *where to reach this vault right
//! now*, a property of the pairing record that changes when the owner moves the
//! vault to another machine, and two tickets carrying the same endpoint id are
//! a coincidence this device never acts on.
//!
//! Until #1025 the key was `content_hash(gateway_id ‖ " " ‖ vault_id)`, and that was
//! a workaround for a loopback port re-picked on every launch rather than a
//! model: it made a vault RESTORED onto a second machine a different file, so
//! every replica on every phone was orphaned along with the outbox inside it —
//! the member's queued writes, in a file nothing would ever open again. That is
//! the [seat-identity trap](../../../docs/traps/seat-identity.md)'s first
//! footgun with the hash making it invisible instead of the literal `"manual"`.
//!
//! So the key IS the vault id. It is already the identifier the log pages
//! carry, the one `core_vault` states inside a bootstrap artifact, and the one
//! a restore preserves.

/// Which vault. The whole of a seat file's identity.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct SeatIdentity {
    pub vault_id: String,
}

impl SeatIdentity {
    pub fn new(vault_id: impl Into<String>) -> Self {
        Self {
            vault_id: vault_id.into(),
        }
    }

    /// The name this vault's files are keyed on.
    ///
    /// Not a digest. A vault id is already an opaque, collision-free
    /// identifier the gateway minted; hashing it would buy nothing and cost the
    /// one property that matters here — that the name on disk can be compared
    /// by eye against the `core_vault` row inside the file.
    #[must_use]
    pub fn storage_key(&self) -> &str {
        &self.vault_id
    }

    /// The seat file's name inside the device's private directory.
    #[must_use]
    pub fn database_name(&self) -> String {
        format!("centraid-replica-{}.sqlite3", self.vault_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_key_is_the_vault_id_and_nothing_else() {
        let one = SeatIdentity::new("vault-1");
        assert_eq!(one.storage_key(), "vault-1");
        assert_ne!(
            one.storage_key(),
            SeatIdentity::new("vault-2").storage_key()
        );
    }

    /// THE ONE THAT WOULD HURT, restated for this model. A vault restored onto
    /// a second gateway keeps its id, so the phone keeps its file — and the
    /// outbox inside it. Under the old `(gateway_id, vault_id)` digest this
    /// was a different name and the queued writes were stranded.
    #[test]
    fn a_vault_reached_at_a_new_address_is_the_same_seat_file() {
        assert_eq!(
            SeatIdentity::new("vault-1").database_name(),
            SeatIdentity::new("vault-1").database_name()
        );
    }

    #[test]
    fn the_file_name_is_derived_and_not_stored() {
        let identity = SeatIdentity::new("vault-1");
        assert!(identity.database_name().starts_with("centraid-replica-"));
        assert!(identity.database_name().ends_with(".sqlite3"));
        assert!(identity.database_name().contains("vault-1"));
    }
}
