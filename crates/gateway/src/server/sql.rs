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

statement!(
    /// The whole schema.
    SCHEMA,
    "schema.sql"
);
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
statement!(TOKEN_SELECT, "token_select.sql");
statement!(TOKENS_SELECT, "tokens_select.sql");
statement!(TOKEN_INSERT, "token_insert.sql");
statement!(
    /// A revoked token is forgotten, so it is unknown everywhere after.
    TOKEN_DELETE,
    "token_delete.sql"
);
statement!(SECRET_SELECT, "secret_select.sql");
statement!(SECRETS_SELECT, "secrets_select.sql");
statement!(SECRET_UPSERT, "secret_upsert.sql");
statement!(HEAD_SELECT, "head_select.sql");
statement!(HEAD_UPSERT, "head_upsert.sql");
statement!(SNAPSHOTS_SELECT, "snapshots_select.sql");
statement!(
    /// A snapshot already registered keeps its first record.
    SNAPSHOT_INSERT,
    "snapshot_insert.sql"
);
statement!(SNAPSHOT_DELETE, "snapshot_delete.sql");
statement!(OBJECT_SELECT, "object_select.sql");
statement!(OBJECT_UPSERT, "object_upsert.sql");
statement!(OBJECT_DELETE, "object_delete.sql");
statement!(
    /// One page of a vault's objects that are not tombstoned, by name.
    OBJECTS_LIVE_SELECT,
    "objects_live_select.sql"
);
statement!(
    /// One page of every object, by vault then name: the scrub's.
    OBJECTS_ALL_SELECT,
    "objects_all_select.sql"
);
statement!(PURGEABLE_SELECT, "purgeable_select.sql");
