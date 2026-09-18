//! EVERY STATEMENT THIS WORKER RUNS, AND NOT ONE OF THEM IS A RUST LITERAL.
//!
//! **These are the same files the standalone adapter reads.** Not a copy of
//! them, not a dialect of them: `contracts/gateway/queries/*.sql`, reached by
//! [`include_str!`] from both adapters, over `contracts/gateway/schema.sql`,
//! which both apply. A Durable Object's storage *is* SQLite, so there is no
//! translation step and nothing to keep in step — which is the whole reason
//! §3 says "one SQL schema" rather than "one schema per adapter".
//!
//! That is worth stating plainly because the alternative looks harmless: a
//! `const` here with the same `SELECT` in it would compile, pass, and drift the
//! first time somebody added a column on one side.
//!
//! # PLACEHOLDERS
//!
//! The shared statements use SQLite's numbered `?1`, `?2` form. A Durable
//! Object binds an array positionally onto exactly that — its storage is
//! SQLite, and `?1` is SQLite's own spelling for the first bound value — so the
//! statements are run unchanged.
//!
//! `tests/no_rules_here.rs` is the check that they stay SHARED: it fails on a
//! `SELECT`, `INSERT`, `UPDATE` or `DELETE` in a Rust string literal anywhere in
//! this crate but `mailbox.rs`, which says why it is the exception.

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
    /// The vault joined to the account that carries its plan.
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
    /// Declare, commit and tombstone are one write.
    OBJECT_UPSERT,
    "object_upsert.sql"
);
statement!(
    /// Every object in one vault.
    OBJECTS_SELECT,
    "objects_select.sql"
);
statement!(
    /// The bases the retention floor is defined over.
    BASES_SELECT,
    "bases_select.sql"
);
statement!(
    /// One base record.
    BASE_UPSERT,
    "base_upsert.sql"
);
statement!(
    /// Every base's membership for one vault, in one read.
    BASE_OBJECTS_SELECT,
    "base_objects_select.sql"
);
statement!(
    /// A base's membership is replaced wholesale, never merged.
    BASE_OBJECT_CLEAR,
    "base_object_clear.sql"
);
statement!(
    /// One base member.
    BASE_OBJECT_INSERT,
    "base_object_insert.sql"
);
statement!(
    /// The head, read where it is written.
    HEAD_SELECT,
    "head_select.sql"
);
statement!(
    /// **The head moves only here** (F7).
    HEAD_UPDATE,
    "head_update.sql"
);
statement!(
    /// The delete rate limit's only memory.
    CLIENT_BASE_DELETE_SELECT,
    "client_base_delete_select.sql"
);
statement!(
    /// The same, written.
    CLIENT_BASE_DELETE_UPSERT,
    "client_base_delete_upsert.sql"
);
statement!(
    /// The per-object audit ledger.
    CLIENT_DELETE_INSERT,
    "client_delete_insert.sql"
);
statement!(
    /// Every table in this object's storage, for the canary's dump.
    TABLES_SELECT,
    "tables_select.sql"
);
statement!(
    /// The canary's widest window over one table. See [`table_dump`].
    TABLE_DUMP,
    "table_dump.sql"
);
statement!(
    /// The conformance harness's reset over one table. See [`table_clear`].
    TABLE_CLEAR,
    "table_clear.sql"
);

/// The dump statement for one table.
///
/// `{table}` is substituted with a name that came out of SQLite's own
/// catalogue through [`TABLES_SELECT`] and **never out of a request**, which is
/// what makes a templated read safe here and would not make it safe anywhere
/// else. The same substitution, over the same file, is what the standalone
/// adapter does.
#[must_use]
pub fn table_dump(table: &str) -> String {
    TABLE_DUMP.replace("{table}", table)
}

/// The reset statement for one table, on the same substitution and with the
/// same guarantee about where the name came from.
#[must_use]
pub fn table_clear(table: &str) -> String {
    TABLE_CLEAR.replace("{table}", table)
}

// ------------------------------------------------- this deployment's own --
//
// Admission, and nothing else. Their table definitions are
// `contracts/gateway/hosted.sql`, the counterpart of the standalone adapter's
// `standalone.sql`, and no rule reads either.

statement!(
    /// An opaque purchase token, minted before a purchase.
    PURCHASE_TOKEN_INSERT,
    "purchase_token_insert.sql"
);
statement!(
    /// Which account a store's `appAccountToken` stands for.
    PURCHASE_TOKEN_SELECT,
    "purchase_token_select.sql"
);
statement!(
    /// Mark a token spent, conditionally, so a replay is visible.
    PURCHASE_TOKEN_REDEEM,
    "purchase_token_redeem.sql"
);
statement!(
    /// One verified receipt, by its BLAKE3. Never the receipt.
    PURCHASE_RECEIPT_INSERT,
    "purchase_receipt_insert.sql"
);
statement!(
    /// Every receipt an account has presented.
    PURCHASE_RECEIPTS_SELECT,
    "purchase_receipts_select.sql"
);
statement!(
    /// A vault joins an account's listing.
    ACCOUNT_VAULT_INSERT,
    "account_vault_insert.sql"
);
statement!(
    /// What a restored phone reads to find its vaults.
    ACCOUNT_VAULTS_SELECT,
    "account_vaults_select.sql"
);
