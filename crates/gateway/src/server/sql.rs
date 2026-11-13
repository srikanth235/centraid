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
statement!(NONCE_SPEND, "nonce_spend.sql");
statement!(NONCE_COUNT, "nonce_count.sql");
statement!(NONCE_PRUNE, "nonce_prune.sql");
statement!(SECRET_SELECT, "secret_select.sql");
statement!(SECRETS_SELECT, "secrets_select.sql");
statement!(SECRET_UPSERT, "secret_upsert.sql");
statement!(SECRETS_LIVE_COUNT, "secrets_live_count.sql");
statement!(SECRET_OLDEST_LIVE, "secret_oldest_live.sql");
statement!(SECRET_DELETE, "secret_delete.sql");
statement!(SECRETS_PRUNE_USED, "secrets_prune_used.sql");
statement!(SECRETS_PRUNE_EXPIRED, "secrets_prune_expired.sql");
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
statement!(HOLDS_SHIFT_ALL_OBJECTS, "holds_shift_all_objects.sql");
statement!(HOLDS_SHIFT_ALL_SNAPSHOTS, "holds_shift_all_snapshots.sql");
statement!(NONCE_ROWS_SELECT, "nonce_rows_select.sql");
statement!(TOKEN_EPOCHS_SELECT, "token_epochs_select.sql");
statement!(REVOKED_COUNT, "revoked_count.sql");
statement!(TABLES_COUNT, "tables_count.sql");

/// **EVERY STATEMENT THAT PAGES, FILTERS OR SWEEPS**, by name, with the index
/// it must walk when that matters. Each listing pages by the key of its last
/// row and walks an index to its first; each update or delete that filters on
/// a state (held, spent, expired, revoked) has a partial index for it.
/// `tests/plans.rs` (`every_listing_seeks`) asks SQLite for each plan and
/// fails on a scan, a sort or an offset, and on a statement that does not use
/// the index named for it (#1191, E14, R4).
pub const LISTINGS: &[(&str, &str, Option<&str>)] = &[
    ("vaults_select", VAULTS_SELECT, None),
    ("tokens_of_select", TOKENS_OF_SELECT, None),
    ("tokens_of_delete", TOKENS_OF_DELETE, None),
    ("secrets_select", SECRETS_SELECT, None),
    (
        "secret_oldest_live",
        SECRET_OLDEST_LIVE,
        Some("pairing_secret_unspent"),
    ),
    (
        "secrets_live_count",
        SECRETS_LIVE_COUNT,
        Some("pairing_secret_unspent"),
    ),
    (
        "secrets_prune_used",
        SECRETS_PRUNE_USED,
        Some("pairing_secret_spent"),
    ),
    (
        "secrets_prune_expired",
        SECRETS_PRUNE_EXPIRED,
        Some("pairing_secret_unspent"),
    ),
    ("snapshots_select", SNAPSHOTS_SELECT, None),
    ("objects_live_select", OBJECTS_LIVE_SELECT, None),
    (
        "objects_held_select",
        OBJECTS_HELD_SELECT,
        Some("object_held"),
    ),
    ("objects_vault_select", OBJECTS_VAULT_SELECT, None),
    ("objects_all_select", OBJECTS_ALL_SELECT, None),
    (
        "purgeable_select",
        PURGEABLE_SELECT,
        Some("object_by_purge"),
    ),
    (
        "holds_clear_objects",
        HOLDS_CLEAR_OBJECTS,
        Some("object_held"),
    ),
    (
        "holds_clear_snapshots",
        HOLDS_CLEAR_SNAPSHOTS,
        Some("snapshot_held"),
    ),
    (
        "holds_shift_objects",
        HOLDS_SHIFT_OBJECTS,
        Some("object_held"),
    ),
    (
        "holds_shift_snapshots",
        HOLDS_SHIFT_SNAPSHOTS,
        Some("snapshot_held"),
    ),
    ("holds_due_objects", HOLDS_DUE_OBJECTS, Some("object_held")),
    (
        "holds_due_snapshots",
        HOLDS_DUE_SNAPSHOTS,
        Some("snapshot_held"),
    ),
    (
        "holds_shift_all_objects",
        HOLDS_SHIFT_ALL_OBJECTS,
        Some("object_by_purge"),
    ),
    (
        "holds_shift_all_snapshots",
        HOLDS_SHIFT_ALL_SNAPSHOTS,
        Some("snapshot_held"),
    ),
    (
        "revoked_prune",
        REVOKED_PRUNE,
        Some("revoked_token_by_time"),
    ),
    ("revoked_trim", REVOKED_TRIM, Some("revoked_token_by_keep")),
    ("nonce_count", NONCE_COUNT, Some("nonce_spent_by_time")),
    ("nonce_prune", NONCE_PRUNE, Some("nonce_spent_by_time")),
];
