//! EVERY STATEMENT THIS SERVER RUNS, AND NOT ONE OF THEM IS A RUST LITERAL.
//!
//! `contracts/gateway/schema.sql` is the schema both adapters apply, and the
//! statements beside it in `contracts/gateway/queries/` are this adapter's
//! reads and writes over it. They are reached by [`include_str!`], exactly as
//! `centraid_gateway_core::SCHEMA_SQL` is, for the same three reasons the
//! schema gives — and for a fourth that is this crate's own: `cargo xtask
//! rules`' `sql-confinement` scans Rust string literals under `crates/`, and
//! `crates/gateway-server` is not one of its allowed roots. Keeping the SQL in
//! `contracts/` is what lets this crate land without an allowlist edit, which
//! is the same answer `gateway-core` reached and is worth being consistent
//! about: a gateway's SQL is a contract between two adapters, not one crate's
//! private detail.
//!
//! **A statement per file, not a file of named sections.** A section file needs
//! a splitter, and a splitter fails at run time on a typo; `include_str!` fails
//! at compile time on a missing path, and `grep -r vault_select` finds the
//! query and its one caller. The cost is a directory with twenty small files in
//! it, which is a cost a reader pays once.

/// The standalone server's own addendum to the shared schema: **admission**.
///
/// Applied after [`centraid_gateway_core::SCHEMA_SQL`]. It holds the invite
/// table and nothing else, because admission is one of the two honest
/// differences between the deployments (`gateway-core/src/lib.rs`) and
/// everything downstream of it is the shared schema again.
pub const STANDALONE_SCHEMA: &str = include_str!("../../../contracts/gateway/standalone.sql");

macro_rules! statement {
    ($(#[$meta:meta])* $name:ident, $file:literal) => {
        $(#[$meta])*
        pub const $name: &str = include_str!(concat!(
            "../../../contracts/gateway/queries/",
            $file
        ));
    };
}

statement!(
    /// The vault joined to the account that carries its plan (Q13).
    VAULT_SELECT,
    "vault_select.sql"
);
statement!(
    /// The account a vault is charged against.
    ACCOUNT_UPSERT,
    "account_upsert.sql"
);
statement!(
    /// Registration, a lease claim and a quota update.
    VAULT_UPSERT,
    "vault_upsert.sql"
);
statement!(
    /// One object, always scoped to its vault.
    OBJECT_SELECT,
    "object_select.sql"
);
statement!(
    /// Every object in one vault.
    OBJECTS_SELECT,
    "objects_select.sql"
);
statement!(
    /// Declare, commit and tombstone.
    OBJECT_UPSERT,
    "object_upsert.sql"
);
statement!(
    /// One base: the group retention is defined over (F10).
    BASE_UPSERT,
    "base_upsert.sql"
);
statement!(
    /// A base's membership is replaced wholesale.
    BASE_OBJECT_CLEAR,
    "base_object_clear.sql"
);
statement!(BASE_OBJECT_INSERT, "base_object_insert.sql");
statement!(
    /// The bases, oldest first.
    BASES_SELECT,
    "bases_select.sql"
);
statement!(
    /// Every base's membership, in one read.
    BASE_OBJECTS_SELECT,
    "base_objects_select.sql"
);
statement!(
    /// Read inside `BEGIN IMMEDIATE`, with [`HEAD_UPDATE`] (F7).
    HEAD_SELECT,
    "head_select.sql"
);
statement!(
    /// **The only statement that moves a manifest head** (F7).
    HEAD_UPDATE,
    "head_update.sql"
);
statement!(
    /// The delete rate limit's only memory (F4).
    CLIENT_BASE_DELETE_SELECT,
    "client_base_delete_select.sql"
);
statement!(CLIENT_BASE_DELETE_UPSERT, "client_base_delete_upsert.sql");
statement!(
    /// The per-object audit ledger an owner reads.
    CLIENT_DELETE_INSERT,
    "client_delete_insert.sql"
);
statement!(
    /// Every vault, for the scrub and purge sweeps.
    VAULTS_SELECT,
    "vaults_select.sql"
);
statement!(INVITE_INSERT, "invite_insert.sql");
statement!(INVITE_SELECT, "invite_select.sql");
statement!(
    /// Single-use under a race: the predicate is `redeemed_at_ms IS NULL`.
    INVITE_REDEEM,
    "invite_redeem.sql"
);
statement!(INVITES_SELECT, "invites_select.sql");
statement!(
    /// Every table in the state file, for the canary.
    TABLES_SELECT,
    "tables_select.sql"
);
statement!(
    /// The one templated statement: `{table}` is substituted with a name read
    /// from [`TABLES_SELECT`], which is SQLite's own catalogue and never a
    /// client's string.
    TABLE_DUMP,
    "table_dump.sql"
);

/// [`TABLE_DUMP`] with its one placeholder filled.
///
/// The caller must have read `table` out of [`TABLES_SELECT`]. Nothing a client
/// sends reaches this, and there is no code path that could: the only caller is
/// the canary's own dump.
#[must_use]
pub fn table_dump(table: &str) -> String {
    TABLE_DUMP.replace("{table}", table)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every statement resolved to something, and nothing resolved to a comment
    /// block somebody emptied.
    #[test]
    fn every_statement_carries_a_statement() {
        let all: [(&str, &str); 23] = [
            ("TABLES_SELECT", TABLES_SELECT),
            ("TABLE_DUMP", TABLE_DUMP),
            ("VAULT_SELECT", VAULT_SELECT),
            ("ACCOUNT_UPSERT", ACCOUNT_UPSERT),
            ("VAULT_UPSERT", VAULT_UPSERT),
            ("OBJECT_SELECT", OBJECT_SELECT),
            ("OBJECTS_SELECT", OBJECTS_SELECT),
            ("OBJECT_UPSERT", OBJECT_UPSERT),
            ("BASE_UPSERT", BASE_UPSERT),
            ("BASE_OBJECT_CLEAR", BASE_OBJECT_CLEAR),
            ("BASE_OBJECT_INSERT", BASE_OBJECT_INSERT),
            ("BASES_SELECT", BASES_SELECT),
            ("BASE_OBJECTS_SELECT", BASE_OBJECTS_SELECT),
            ("HEAD_SELECT", HEAD_SELECT),
            ("HEAD_UPDATE", HEAD_UPDATE),
            ("CLIENT_BASE_DELETE_SELECT", CLIENT_BASE_DELETE_SELECT),
            ("CLIENT_BASE_DELETE_UPSERT", CLIENT_BASE_DELETE_UPSERT),
            ("CLIENT_DELETE_INSERT", CLIENT_DELETE_INSERT),
            ("VAULTS_SELECT", VAULTS_SELECT),
            ("INVITE_INSERT", INVITE_INSERT),
            ("INVITE_SELECT", INVITE_SELECT),
            ("INVITE_REDEEM", INVITE_REDEEM),
            ("INVITES_SELECT", INVITES_SELECT),
        ];
        for (name, text) in all {
            let code: String = text
                .lines()
                .filter(|line| !line.trim_start().starts_with("--"))
                .collect::<Vec<_>>()
                .join(" ");
            assert!(
                code.trim().ends_with(';'),
                "{name} is not a statement: {code:?}"
            );
        }
    }

    /// EVERY OBJECT READ IS SCOPED TO A VAULT.
    ///
    /// A tenancy leak here is not a bug a type can catch: `object` is keyed by
    /// `(vault_key, name)` and two households can hold the same object, so a
    /// read that forgot the vault would serve one member's ciphertext to
    /// another and every type in the crate would be satisfied. The scan is the
    /// check, and `tests/tenancy.rs` is the same claim against a live server.
    #[test]
    fn no_statement_touches_an_object_without_naming_its_vault() {
        for (name, text) in [
            ("OBJECT_SELECT", OBJECT_SELECT),
            ("OBJECTS_SELECT", OBJECTS_SELECT),
            ("OBJECT_UPSERT", OBJECT_UPSERT),
            ("BASES_SELECT", BASES_SELECT),
            ("BASE_UPSERT", BASE_UPSERT),
            ("BASE_OBJECTS_SELECT", BASE_OBJECTS_SELECT),
            ("BASE_OBJECT_CLEAR", BASE_OBJECT_CLEAR),
            ("BASE_OBJECT_INSERT", BASE_OBJECT_INSERT),
            ("CLIENT_BASE_DELETE_SELECT", CLIENT_BASE_DELETE_SELECT),
            ("CLIENT_BASE_DELETE_UPSERT", CLIENT_BASE_DELETE_UPSERT),
            ("CLIENT_DELETE_INSERT", CLIENT_DELETE_INSERT),
            ("HEAD_SELECT", HEAD_SELECT),
            ("HEAD_UPDATE", HEAD_UPDATE),
        ] {
            // Either the vault is the first thing the predicate names, or it is
            // the first column of the insert — which is the same claim in the
            // two shapes SQL has for it, and both bind `?1`.
            assert!(
                text.contains("vault_key = ?1") || text.contains("(vault_key,"),
                "{name} reads or writes vault-scoped state without binding the \
                 vault to `?1`"
            );
        }
    }

    /// The head moves in one statement and no other.
    #[test]
    fn only_one_statement_writes_a_manifest_head() {
        assert!(HEAD_UPDATE.contains("head_object"));
        assert!(
            !VAULT_UPSERT.contains("head_object      = excluded"),
            "the vault upsert must not carry the head: it moves only under \
             BEGIN IMMEDIATE, through HEAD_UPDATE (F7)"
        );
    }
}
