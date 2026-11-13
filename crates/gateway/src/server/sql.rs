//! Every statement `state.db` runs, and not one of them is a Rust literal
//! (#1080).
//!
//! The statements are files beside this one, reached by [`include_str!`]: a
//! missing file fails the build, `grep -r object_upsert` finds a statement and
//! its one caller, and `cargo xtask rules`' `sql-confinement` — which scans
//! Rust string literals — has nothing here to find. The schema is applied on
//! every open and every statement in it is idempotent.

macro_rules! statement {
    ($(#[$meta:meta])* $name:ident, $file:literal) => {
        $(#[$meta])*
        pub const $name: &str = include_str!(concat!("sql/", $file));
    };
}

/// THE SCHEMA LADDER: one file per rung, applied in order, each in its own
/// transaction, and `PRAGMA user_version` is the number of rungs applied. A
/// rung is never edited once a release has shipped it (#1191, E13).
pub const LADDER: &[&str] = &[include_str!("sql/ladder/001_founding.sql")];
statement!(
    /// The write lock first, so an operation's reads and writes are one step.
    BEGIN,
    "begin.sql"
);
statement!(COMMIT, "commit.sql");
statement!(ROLLBACK, "rollback.sql");
statement!(VAULT_SELECT, "vault_select.sql");
statement!(VAULTS_SELECT, "vaults_select.sql");
statement!(VAULT_UPSERT, "vault_upsert.sql");
statement!(VAULT_DELETE, "vault_delete.sql");
statement!(TOKEN_SELECT, "token_select.sql");
statement!(TOKENS_OF_SELECT, "tokens_of_select.sql");
statement!(TOKEN_INSERT, "token_insert.sql");
statement!(TOKEN_DELETE, "token_delete.sql");
statement!(TOKENS_OF_DELETE, "tokens_of_delete.sql");
statement!(REVOKED_SELECT, "revoked_select.sql");
statement!(REVOKED_UPSERT, "revoked_upsert.sql");
statement!(REVOKED_TRIM, "revoked_trim.sql");
statement!(REVOKED_PRUNE, "revoked_prune.sql");
statement!(CLAIM_SELECT, "claim_select.sql");
statement!(CLAIM_UPSERT, "claim_upsert.sql");
statement!(NONCE_INSERT, "nonce_insert.sql");
statement!(NONCE_TAKE, "nonce_take.sql");
statement!(NONCE_COUNT, "nonce_count.sql");
statement!(NONCE_PRUNE, "nonce_prune.sql");
statement!(SECRET_SELECT, "secret_select.sql");
statement!(SECRETS_SELECT, "secrets_select.sql");
statement!(SECRET_UPSERT, "secret_upsert.sql");
statement!(SECRETS_LIVE_COUNT, "secrets_live_count.sql");
statement!(SECRET_OLDEST_LIVE, "secret_oldest_live.sql");
statement!(SECRET_DELETE, "secret_delete.sql");
statement!(SECRETS_PRUNE, "secrets_prune.sql");
statement!(HEAD_SELECT, "head_select.sql");
statement!(HEAD_UPSERT, "head_upsert.sql");
statement!(HEAD_DELETE, "head_delete.sql");
statement!(SNAPSHOT_SELECT, "snapshot_select.sql");
statement!(SNAPSHOTS_SELECT, "snapshots_select.sql");
statement!(SNAPSHOT_UPSERT, "snapshot_upsert.sql");
statement!(SNAPSHOT_DELETE, "snapshot_delete.sql");
statement!(SNAPSHOTS_DELETE_VAULT, "snapshots_delete_vault.sql");
statement!(CLAIM_DELETE, "claim_delete.sql");
statement!(REVOKED_DELETE_VAULT, "revoked_delete_vault.sql");
statement!(OBJECT_SELECT, "object_select.sql");
statement!(OBJECT_UPSERT, "object_upsert.sql");
statement!(OBJECT_DELETE, "object_delete.sql");
statement!(OBJECTS_LIVE_SELECT, "objects_live_select.sql");
statement!(OBJECTS_HELD_SELECT, "objects_held_select.sql");
statement!(OBJECTS_VAULT_SELECT, "objects_vault_select.sql");
statement!(OBJECTS_ALL_SELECT, "objects_all_select.sql");
statement!(PURGEABLE_SELECT, "purgeable_select.sql");
statement!(HOLD_OBJECT_SET, "hold_object_set.sql");
statement!(HOLD_SNAPSHOT_SET, "hold_snapshot_set.sql");
statement!(HOLDS_CLEAR_OBJECTS, "holds_clear_objects.sql");
statement!(HOLDS_CLEAR_SNAPSHOTS, "holds_clear_snapshots.sql");
statement!(HOLDS_SHIFT_OBJECTS, "holds_shift_objects.sql");
statement!(HOLDS_SHIFT_SNAPSHOTS, "holds_shift_snapshots.sql");
statement!(HOLDS_DUE_OBJECTS, "holds_due_objects.sql");
statement!(HOLDS_DUE_SNAPSHOTS, "holds_due_snapshots.sql");
statement!(HOLDS_REBASE_OBJECTS, "holds_rebase_objects.sql");
statement!(HOLDS_REBASE_SNAPSHOTS, "holds_rebase_snapshots.sql");
statement!(NONCE_ROWS_SELECT, "nonce_rows_select.sql");
statement!(TOKEN_EPOCHS_SELECT, "token_epochs_select.sql");
statement!(REVOKED_COUNT, "revoked_count.sql");
statement!(TABLES_COUNT, "tables_count.sql");

/// **EVERY LISTING THE GATEWAY RUNS**, by name (the one-row `secret_oldest_live` walks the
/// partial index of unspent secrets, at most 64 live and a few days' expired, and is no page): each pages by the key of its
/// last row and walks an index to its first. `tests/plans.rs`
/// (`every_listing_seeks`) asks SQLite for each plan and fails on a scan, a
/// sort or an offset (#1191, E14).
pub const LISTINGS: &[(&str, &str)] = &[
    ("vaults_select", VAULTS_SELECT),
    ("tokens_of_select", TOKENS_OF_SELECT),
    ("secrets_select", SECRETS_SELECT),
    ("snapshots_select", SNAPSHOTS_SELECT),
    ("objects_live_select", OBJECTS_LIVE_SELECT),
    ("objects_held_select", OBJECTS_HELD_SELECT),
    ("objects_vault_select", OBJECTS_VAULT_SELECT),
    ("objects_all_select", OBJECTS_ALL_SELECT),
    ("purgeable_select", PURGEABLE_SELECT),
];
