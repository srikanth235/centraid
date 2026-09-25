//! The Locker key `K` — layer three, and the one wave 4 moves (#1020,
//! D-1020-R2, D-1020-R4).
//!
//! One random 256-bit key per vault, minted **at founding** into the gateway's
//! `keys/` directory: the same custody the seal key and the identity seed use,
//! deliberately outside the directory that export, backup and copy gestures
//! move around. A copied vault carries ciphertext only, and the recovery kit is
//! the one artefact that carries keys.
//!
//! Only secret **values** are encrypted. Title, url and username stay plaintext
//! so a locked seat can list and search offline — which is the whole reason
//! Locker is usable on a phone in airplane mode.
//!
//! Wire form `lk1:<base64(nonce ‖ ct ‖ tag)>`, AES-256-GCM, a fresh random
//! 96-bit nonce per value, **AAD = `<rowId>‖<keyId>`**. The `keyId` half is as
//! load-bearing as the row half: it makes a ciphertext unopenable under a key
//! generation it was not sealed with, so a rotation the seat has not caught up
//! with is a *distinguishable* refusal rather than a corrupt secret.
//!
//! ## `locker_key` carries ids, never material
//!
//! `locker_key(key_id PK, created_at, retired_at)` and a unique index on the
//! **predicate**:
//!
//! ```sql
//! CREATE UNIQUE INDEX locker_key_live_idx ON locker_key(retired_at IS NULL)
//!   WHERE retired_at IS NULL
//! ```
//!
//! Indexing `retired_at` itself would permit any number of live rows, because
//! SQLite treats NULLs as distinct. Indexing the predicate makes "two live
//! keys" unrepresentable.
//!
//! ## Rotation is an order, not a transaction
//!
//! `keys/` and `vault.db` share no transaction, so the **order** is the
//! guarantee:
//!
//! 1. write `K′` to `keys/` as a NEW file (the old one is untouched);
//! 2. ONE DB transaction: retire the old row, insert the new row, re-encrypt
//!    every secret, bump every `key_id`;
//! 3. delete the old key file.
//!
//! A crash between 1 and 2 leaves the DB still naming the old key: nothing was
//! re-encrypted and the orphan `K′` file is swept at the next open. A crash
//! between 2 and 3 leaves the DB naming `K′` and the retired file is swept the
//! same way. At no point is any ciphertext under a key the DB does not name,
//! and at no point are two rows live. Both windows are tested —
//! `a_crash_between_the_new_key_file_and_the_transaction_sweeps_clean` and
//! `a_crash_between_the_transaction_and_the_old_file_delete_sweeps_clean`.
//!
//! The retire **precedes** the insert inside step 2 because `locker_key_live_idx`
//! is checked per statement, not per transaction.
//!
//! ## What wave 4 changes, and what this proves today
//!
//! The gateway **holds** `K` today; that is v0's posture and R-1020 moves it to
//! a member key the gateway never holds. What is landed now is the shape that
//! makes the move a change of custody rather than a rewrite: every function
//! here takes the key **by value**, so there is no ambient `K` for a read path
//! to reach for. The acceptance test
//! `gateway_file_and_keystore_do_not_reveal_a_cell_without_k` opens the vault
//! file *and* the whole `keys/` directory with `K` withheld and asserts every
//! `lk1:` cell fails to open — which proves the cells depend on `K` and on
//! nothing else that is on disk. It does not, and does not claim to, prove the
//! gateway cannot get `K`; that is wave 4's box.

use std::collections::BTreeMap;

use aes_gcm::aead::{Aead, Payload};
use aes_gcm::{Aes256Gcm, KeyInit};
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;

use super::keystore::KeyStoreError;
use super::member_key::MemberKeyCustody;

/// `K` is 32 bytes. Anything else is not a Locker key.
pub const LOCKER_KEY_BYTES: usize = 32;

/// Wire prefix of a value encrypted under `K`.
pub const LOCKER_CIPHERTEXT_PREFIX: &str = "lk1:";

const NONCE_BYTES: usize = 12;
const TAG_BYTES: usize = 16;

/// Which columns of which physical table hold ciphertext under `K`.
///
/// Stated ONCE, here, and read by encryption, rotation, the sweep and the
/// tests. The list is tight on purpose: only where the value **is** the
/// secret. Everything else on these tables is the browsable half a locked seat
/// still needs.
pub const LOCKER_ENCRYPTED_COLUMNS: &[(&str, &str, &[&str])] = &[
    (
        "locker_item",
        "item_id",
        &["password", "otp_seed", "card_number", "cvv", "content"],
    ),
    ("locker_item_field", "field_id", &["value_sealed"]),
    ("locker_item_passkey", "item_id", &["private_key"]),
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LockerKeyErrorCode {
    /// A key file the DB names is not on disk — unambiguous custody loss.
    Missing,
    /// A write arrived under a key generation the vault has rotated past.
    StaleKeyId,
    /// This vault has no key plane; it was never founded.
    NotFounded,
}

impl LockerKeyErrorCode {
    #[must_use]
    pub const fn as_wire(self) -> &'static str {
        match self {
            Self::Missing => "missing",
            Self::StaleKeyId => "stale_key_id",
            Self::NotFounded => "not_founded",
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum LockerKeyError {
    #[error("{code}: {message}", code = code.as_wire())]
    Plane {
        code: LockerKeyErrorCode,
        message: String,
    },
    #[error("value is not locker ciphertext")]
    NotCiphertext,
    #[error("locker ciphertext truncated")]
    Truncated,
    /// Tampering, a wrong row, or a wrong key generation.
    #[error("locker ciphertext failed to authenticate for {aad}")]
    Authentication { aad: String },
    #[error("locker plaintext is not UTF-8")]
    NotUtf8,
    #[error("locker key is {0} bytes, expected {LOCKER_KEY_BYTES}")]
    KeyLength(usize),
    #[error(transparent)]
    Custody(#[from] KeyStoreError),
    #[error(transparent)]
    Sqlite(#[from] rusqlite::Error),
}

impl LockerKeyError {
    fn plane(code: LockerKeyErrorCode, message: impl Into<String>) -> Self {
        Self::Plane {
            code,
            message: message.into(),
        }
    }

    #[must_use]
    pub const fn code(&self) -> Option<LockerKeyErrorCode> {
        match self {
            Self::Plane { code, .. } => Some(*code),
            _ => None,
        }
    }
}

type Result<T> = std::result::Result<T, LockerKeyError>;

/// `<vaultId>.locker.<keyId>.key` — the deterministic file name inside `keys/`.
#[must_use]
pub fn locker_key_file_name(vault_id: &str, key_id: &str) -> String {
    format!("{vault_id}.locker.{key_id}.key")
}

// THE GATEWAY-SIDE KEY DIRECTORY IS GONE (#1020, D-1020-L2).
//
// `locker_key_dir_for(vault_dir)` used to map a vault directory to the host's
// own `keys/`, so that `K` shared custody with the seal key. That sharing was
// the right answer while the gateway held `K` and is the door itself now: a
// function that hands out the path is a function a future read path can call.
//
// The only custody type is [`super::member_key::MemberKeyCustody`], and it is
// constructed from a **seat's** data directory. The seal key and the identity
// seed still live in the host's `keys/` and still reach it through
// `crate::custody::keystore`, because those are the host's own and always were
// (census §D4: the sealed-column class is host-readable by design).
//
// `crates/vault/tests/member_key_gate.rs` asserts the absence by name.

/// One `locker_key` row. Ids only — never key material.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LockerKeyRow {
    pub key_id: String,
    pub created_at: String,
    pub retired_at: Option<String>,
}

/// Every `locker_key` row, newest first.
pub fn locker_key_rows(connection: &rusqlite::Connection) -> Result<Vec<LockerKeyRow>> {
    let mut statement = connection.prepare(
        "SELECT key_id, created_at, retired_at FROM locker_key \
         ORDER BY created_at DESC, key_id DESC",
    )?;
    let rows = statement
        .query_map([], |row| {
            Ok(LockerKeyRow {
                key_id: row.get(0)?,
                created_at: row.get(1)?,
                retired_at: row.get(2)?,
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// The live key id, or `None` on a vault whose key plane was never founded.
pub fn live_locker_key_id(connection: &rusqlite::Connection) -> Result<Option<String>> {
    let mut statement =
        connection.prepare("SELECT key_id FROM locker_key WHERE retired_at IS NULL LIMIT 1")?;
    let mut rows = statement.query([])?;
    Ok(match rows.next()? {
        Some(row) => Some(row.get(0)?),
        None => None,
    })
}

/// Mint `K` at vault founding: one key file, one live row. Idempotent.
///
/// **Founding, not first-need.** The seal key was minted lazily and #298 spent
/// a whole ruling on what that cost: a vault that had never sealed could mint
/// freely, so "is this the right key" had no answer until the first secret
/// existed. The key plane has no such window — the row and the file are written
/// together at founding, the live id is non-null for the life of the vault, and
/// a missing file is unambiguously custody loss.
///
/// The FILE comes first, then the row, for the same reason rotation does it in
/// that order: a row naming a key file that does not exist is unrecoverable, a
/// key file no row names is a sweepable orphan.
pub fn found_locker_key(
    connection: &rusqlite::Connection,
    custody: &MemberKeyCustody,
    key_id: &str,
    now: &str,
) -> Result<(String, Vec<u8>)> {
    if let Some(live) = live_locker_key_id(connection)? {
        let key = custody.load(&live)?;
        return Ok((live, key));
    }
    let key = custody.store().create(&custody.file_name(key_id))?;
    connection.execute(
        "INSERT INTO locker_key (key_id, created_at, retired_at) VALUES (?1, ?2, NULL)",
        (key_id, now),
    )?;
    Ok((key_id.to_owned(), key))
}

/// AAD binding a ciphertext to its row AND its key generation.
#[must_use]
pub fn locker_aad(row_id: &str, key_id: &str) -> String {
    format!("{row_id}‖{key_id}")
}

/// The structural predicate, for the same reason [`super::seal::is_sealed_value`]
/// is structural: a plaintext that merely begins `lk1:` is not ciphertext.
#[must_use]
pub fn is_locker_ciphertext(value: &str) -> bool {
    let Some(body) = value.strip_prefix(LOCKER_CIPHERTEXT_PREFIX) else {
        return false;
    };
    if body.is_empty() || !body.len().is_multiple_of(4) {
        return false;
    }
    let padding = body.len() - body.trim_end_matches('=').len();
    if padding > 2 {
        return false;
    }
    let core = &body[..body.len() - padding];
    if core.is_empty()
        || !core
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'/')
    {
        return false;
    }
    STANDARD
        .decode(body)
        .is_ok_and(|bytes| bytes.len() >= NONCE_BYTES + TAG_BYTES)
}

fn cipher_for(key: &[u8]) -> Result<Aes256Gcm> {
    if key.len() != LOCKER_KEY_BYTES {
        return Err(LockerKeyError::KeyLength(key.len()));
    }
    Aes256Gcm::new_from_slice(key).map_err(|_| LockerKeyError::KeyLength(key.len()))
}

/// Encrypt one secret under `K`. Fresh nonce every call, never derived.
pub fn encrypt_under_locker_key(
    key: &[u8],
    key_id: &str,
    row_id: &str,
    plaintext: &str,
) -> Result<String> {
    let cipher = cipher_for(key)?;
    let aad = locker_aad(row_id, key_id);
    let nonce = super::random_bytes::<NONCE_BYTES>();
    let body = cipher
        .encrypt(
            (&nonce).into(),
            Payload {
                msg: plaintext.as_bytes(),
                aad: aad.as_bytes(),
            },
        )
        .map_err(|_| LockerKeyError::Authentication { aad: aad.clone() })?;
    let mut raw = Vec::with_capacity(NONCE_BYTES + body.len());
    raw.extend_from_slice(&nonce);
    raw.extend_from_slice(&body);
    Ok(format!(
        "{LOCKER_CIPHERTEXT_PREFIX}{}",
        STANDARD.encode(raw)
    ))
}

/// Decrypt under `K`. Fails on tampering, a wrong row, or a wrong key id.
pub fn decrypt_under_locker_key(
    key: &[u8],
    key_id: &str,
    row_id: &str,
    value: &str,
) -> Result<String> {
    let cipher = cipher_for(key)?;
    let body = value
        .strip_prefix(LOCKER_CIPHERTEXT_PREFIX)
        .ok_or(LockerKeyError::NotCiphertext)?;
    let raw = STANDARD
        .decode(body)
        .map_err(|_| LockerKeyError::NotCiphertext)?;
    if raw.len() < NONCE_BYTES + TAG_BYTES {
        return Err(LockerKeyError::Truncated);
    }
    let aad = locker_aad(row_id, key_id);
    let nonce: [u8; NONCE_BYTES] = raw[..NONCE_BYTES].try_into().expect("checked length");
    let plain = cipher
        .decrypt(
            (&nonce).into(),
            Payload {
                msg: &raw[NONCE_BYTES..],
                aad: aad.as_bytes(),
            },
        )
        .map_err(|_| LockerKeyError::Authentication { aad })?;
    String::from_utf8(plain).map_err(|_| LockerKeyError::NotUtf8)
}

/// Refuse a write whose author was looking at a key the vault has rotated past.
///
/// The seat encrypted with the key it held; if the vault moved on, storing that
/// ciphertext would put a row under a key nothing can open. "Re-enter this
/// secret" is the only repair — the gateway cannot decrypt the intent in order
/// to re-encrypt it, which is the point of the layer.
pub fn assert_live_locker_key_id(connection: &rusqlite::Connection, key_id: &str) -> Result<()> {
    match live_locker_key_id(connection)? {
        None => Err(LockerKeyError::plane(
            LockerKeyErrorCode::NotFounded,
            "this vault has no Locker key plane — no secret can be stored until one is founded",
        )),
        Some(live) if live == key_id => Ok(()),
        Some(live) => Err(LockerKeyError::plane(
            LockerKeyErrorCode::StaleKeyId,
            format!(
                "this secret was encrypted under Locker key {key_id}, which is no longer live \
                 ({live}) — re-enter this secret"
            ),
        )),
    }
}

/// Where a rotation is interrupted, for the two crash tests.
///
/// These are the only two windows rotation has. They are a test seam and not a
/// production knob: the recovery for both is [`sweep_retired_locker_keys`] on
/// open, which is also the production path.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RotationCrash {
    /// After `K′` is on disk, before the DB transaction opens.
    BeforeTransaction,
    /// After the DB transaction commits, before the old key file is deleted.
    BeforeOldFileDelete,
}

/// What a completed rotation did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LockerRotation {
    pub previous_key_id: String,
    pub key_id: String,
    pub key: Vec<u8>,
    /// Rows re-encrypted, by physical table.
    pub rewritten: BTreeMap<String, usize>,
}

/// Rotate `K` → `K′` in the order the module docs state.
///
/// **Revoke is rotate.** A device that held `K` keeps a key that opens nothing
/// written after this call; rotation protects what comes after, not what a
/// revoked device already read. R13 is honest about the trade and so is this.
pub fn rotate_locker_key(
    connection: &rusqlite::Connection,
    custody: &MemberKeyCustody,
    new_key_id: &str,
    now: &str,
    crash: Option<RotationCrash>,
) -> Result<LockerRotation> {
    let Some(previous_key_id) = live_locker_key_id(connection)? else {
        return Err(LockerKeyError::plane(
            LockerKeyErrorCode::NotFounded,
            "this vault has no Locker key plane to rotate",
        ));
    };
    let previous_key = custody.load(&previous_key_id)?;

    // STEP 1 — the new key file, before anything in the DB names it.
    let key = custody.store().create(&custody.file_name(new_key_id))?;
    if crash == Some(RotationCrash::BeforeTransaction) {
        return Err(LockerKeyError::plane(
            LockerKeyErrorCode::Missing,
            "injected crash after the new key file and before the transaction",
        ));
    }

    // STEP 2 — one transaction. Either every ciphertext is under `K′` and every
    // `key_id` says so, or none of it happened.
    let mut rewritten = BTreeMap::new();
    let outcome = (|| -> Result<()> {
        connection.execute_batch("BEGIN IMMEDIATE")?;
        // Retire BEFORE inserting: `locker_key_live_idx` is checked per
        // statement, not per transaction, so "two live rows" is
        // unrepresentable even for the instant between these two writes.
        connection.execute(
            "UPDATE locker_key SET retired_at = ?1 WHERE key_id = ?2",
            (now, &previous_key_id),
        )?;
        connection.execute(
            "INSERT INTO locker_key (key_id, created_at, retired_at) VALUES (?1, ?2, NULL)",
            (new_key_id, now),
        )?;
        for (table, pk, columns) in LOCKER_ENCRYPTED_COLUMNS {
            let select = format!(
                "SELECT {pk} AS pk, {} FROM {table} WHERE key_id = ?1",
                columns.join(", ")
            );
            let update = format!(
                "UPDATE {table} SET {}, key_id = ?{} WHERE {pk} = ?{}",
                columns
                    .iter()
                    .enumerate()
                    .map(|(index, column)| format!("{column} = ?{}", index + 1))
                    .collect::<Vec<_>>()
                    .join(", "),
                columns.len() + 1,
                columns.len() + 2
            );
            let mut statement = connection.prepare(&select)?;
            let pending = statement
                .query_map([&previous_key_id], |row| {
                    let row_id: String = row.get(0)?;
                    let values = (0..columns.len())
                        .map(|index| row.get::<_, Option<String>>(index + 1))
                        .collect::<std::result::Result<Vec<_>, _>>()?;
                    Ok((row_id, values))
                })?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            let mut count = 0_usize;
            for (row_id, values) in pending {
                let mut next: Vec<Option<String>> = Vec::with_capacity(values.len());
                for value in values {
                    next.push(match value {
                        Some(value) if is_locker_ciphertext(&value) => {
                            let plain = decrypt_under_locker_key(
                                &previous_key,
                                &previous_key_id,
                                &row_id,
                                &value,
                            )?;
                            Some(encrypt_under_locker_key(&key, new_key_id, &row_id, &plain)?)
                        }
                        other => other,
                    });
                }
                let mut params: Vec<&dyn rusqlite::ToSql> = Vec::with_capacity(next.len() + 2);
                for value in &next {
                    params.push(value);
                }
                params.push(&new_key_id);
                params.push(&row_id);
                connection.execute(&update, params.as_slice())?;
                count += 1;
            }
            // Rows written before the plane existed carry a NULL key id; they
            // hold no ciphertext, so they simply join the live key.
            connection.execute(
                &format!("UPDATE {table} SET key_id = ?1 WHERE key_id IS NULL"),
                [new_key_id],
            )?;
            rewritten.insert((*table).to_owned(), count);
        }
        connection.execute_batch("COMMIT")?;
        Ok(())
    })();
    if let Err(error) = outcome {
        let _ = connection.execute_batch("ROLLBACK");
        // The new file is now an orphan no row names. Sweep it here rather than
        // leaving it for the next open: a failed rotation should cost nothing.
        let _ = custody.store().destroy(&custody.file_name(new_key_id));
        return Err(error);
    }

    if crash == Some(RotationCrash::BeforeOldFileDelete) {
        return Err(LockerKeyError::plane(
            LockerKeyErrorCode::Missing,
            "injected crash after the transaction and before the old key file delete",
        ));
    }

    // STEP 3 — the old file, last. Everything above already reads `K′`.
    custody
        .store()
        .destroy(&custody.file_name(&previous_key_id))?;
    Ok(LockerRotation {
        previous_key_id,
        key_id: new_key_id.to_owned(),
        key,
        rewritten,
    })
}

/// Reconcile `keys/` with the DB after a crash. Returns the files it removed.
///
/// The whole recovery story of the two-store order: whatever the DB names is
/// live, and every other Locker key file for this vault is a leftover of an
/// interrupted rotation. Called on open, so a crash in either window costs one
/// directory listing rather than an operator gesture.
pub fn sweep_retired_locker_keys(
    connection: &rusqlite::Connection,
    custody: &MemberKeyCustody,
) -> Result<Vec<String>> {
    let Some(live) = live_locker_key_id(connection)? else {
        return Ok(Vec::new());
    };
    let keep = custody.file_name(&live);
    let mut removed = Vec::new();
    for (key_id, _) in custody.files_in_custody()? {
        let name = custody.file_name(&key_id);
        if name == keep {
            continue;
        }
        if custody.store().destroy(&name)? {
            removed.push(name);
        }
    }
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::custody::KeyStore;
    use crate::file::Vault;

    struct Fixture {
        _dir: tempfile::TempDir,
        connection: rusqlite::Connection,
        custody: MemberKeyCustody,
        vault_file: std::path::PathBuf,
        keys_dir: std::path::PathBuf,
    }

    /// A real v1 vault file (D1's baseline, which carries the whole Locker
    /// plane and `locker_key_live_idx`), reopened on a plain writable
    /// connection: rotation is gateway maintenance, not a replicated command.
    fn founded() -> Fixture {
        let dir = tempfile::tempdir().expect("scratch dir");
        let vault_file = dir.path().join("vault").join("v1").join("vault.db");
        std::fs::create_dir_all(vault_file.parent().unwrap()).unwrap();
        Vault::create(&vault_file).unwrap().close().unwrap();
        let connection = rusqlite::Connection::open(&vault_file).unwrap();
        connection
            .execute_batch("PRAGMA foreign_keys = ON")
            .unwrap();
        // THE KEY FILES LIVE ON A SEAT, and this fixture's "seat" is a
        // directory beside the vault. Before wave 4 the path came from
        // `locker_key_dir_for(vault_dir)` — the host's own `keys/` — and that
        // function is the door this wave deleted (#1020, D-1020-L2).
        let keys_dir = crate::custody::member_key_dir_on_seat(&dir.path().join("seat"));
        let custody = MemberKeyCustody::with_store(KeyStore::new(&keys_dir), "v1");
        Fixture {
            _dir: dir,
            connection,
            custody,
            vault_file,
            keys_dir,
        }
    }

    fn insert_item(connection: &rusqlite::Connection, item_id: &str, password: &str, key_id: &str) {
        connection
            .execute(
                "INSERT INTO locker_item (item_id, type, title, password, key_id, created_at) \
                 VALUES (?1, 'login', 'a login', ?2, ?3, '2026-01-01T00:00:00.000Z')",
                (item_id, password, key_id),
            )
            .unwrap();
    }

    fn password_of(connection: &rusqlite::Connection, item_id: &str) -> (String, String) {
        connection
            .query_row(
                "SELECT password, key_id FROM locker_item WHERE item_id = ?1",
                [item_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap()
    }

    #[test]
    fn founding_writes_one_key_file_and_one_live_row_and_is_idempotent() {
        let fixture = founded();
        let (key_id, key) = found_locker_key(
            &fixture.connection,
            &fixture.custody,
            "k-1",
            "2026-01-01T00:00:00Z",
        )
        .unwrap();
        assert_eq!(key_id, "k-1");
        assert_eq!(key.len(), LOCKER_KEY_BYTES);
        assert_eq!(
            live_locker_key_id(&fixture.connection).unwrap().as_deref(),
            Some("k-1")
        );
        assert_eq!(
            fixture.custody.files_in_custody().unwrap().len(),
            1,
            "one key file, named for the vault and the key id"
        );
        let (again, same) = found_locker_key(
            &fixture.connection,
            &fixture.custody,
            "k-2",
            "2026-01-02T00:00:00Z",
        )
        .unwrap();
        assert_eq!(again, "k-1");
        assert_eq!(
            same, key,
            "a vault already founded gets its existing key back"
        );
    }

    #[test]
    fn two_live_rows_are_unrepresentable_because_the_index_is_on_the_predicate() {
        let fixture = founded();
        found_locker_key(
            &fixture.connection,
            &fixture.custody,
            "k-1",
            "2026-01-01T00:00:00Z",
        )
        .unwrap();
        let error = fixture
            .connection
            .execute(
                "INSERT INTO locker_key (key_id, created_at, retired_at) \
                 VALUES ('k-2', '2026-01-02T00:00:00Z', NULL)",
                [],
            )
            .unwrap_err();
        assert!(
            error.to_string().to_lowercase().contains("unique"),
            "locker_key_live_idx must refuse a second live row: {error}"
        );
    }

    #[test]
    fn a_ciphertext_opens_only_under_its_own_row_and_its_own_key_id() {
        let key = [21_u8; 32];
        let sealed = encrypt_under_locker_key(&key, "k-1", "item-1", "s3cret").unwrap();
        assert!(is_locker_ciphertext(&sealed));
        assert_eq!(
            decrypt_under_locker_key(&key, "k-1", "item-1", &sealed).unwrap(),
            "s3cret"
        );
        // Wrong row, wrong key generation, wrong key — three distinct mistakes,
        // one answer.
        assert!(decrypt_under_locker_key(&key, "k-1", "item-2", &sealed).is_err());
        assert!(decrypt_under_locker_key(&key, "k-2", "item-1", &sealed).is_err());
        assert!(decrypt_under_locker_key(&[22_u8; 32], "k-1", "item-1", &sealed).is_err());
    }

    #[test]
    fn a_plaintext_that_merely_starts_with_the_prefix_is_not_ciphertext() {
        assert!(!is_locker_ciphertext("lk1:hunter2"));
        assert!(!is_locker_ciphertext("lk1:"));
        assert!(!is_locker_ciphertext("lk1:AAAA"));
        assert!(!is_locker_ciphertext(&format!("lk1:{}", "-".repeat(40))));
        assert!(!is_locker_ciphertext("no prefix at all"));
    }

    #[test]
    fn rotation_re_encrypts_every_secret_and_retires_the_old_key() {
        let fixture = founded();
        let (key_id, key) = found_locker_key(
            &fixture.connection,
            &fixture.custody,
            "k-1",
            "2026-01-01T00:00:00Z",
        )
        .unwrap();
        let sealed = encrypt_under_locker_key(&key, &key_id, "item-1", "s3cret").unwrap();
        insert_item(&fixture.connection, "item-1", &sealed, &key_id);

        let rotation = rotate_locker_key(
            &fixture.connection,
            &fixture.custody,
            "k-2",
            "2026-01-02T00:00:00Z",
            None,
        )
        .unwrap();
        assert_eq!(rotation.previous_key_id, "k-1");
        assert_eq!(rotation.rewritten["locker_item"], 1);

        let (stored, stamped) = password_of(&fixture.connection, "item-1");
        assert_eq!(stamped, "k-2");
        assert_ne!(
            stored, sealed,
            "the ciphertext was re-encrypted, not just re-stamped"
        );
        assert_eq!(
            decrypt_under_locker_key(&rotation.key, "k-2", "item-1", &stored).unwrap(),
            "s3cret"
        );
        // The old key opens nothing any more, and its file is gone.
        assert!(decrypt_under_locker_key(&key, "k-1", "item-1", &stored).is_err());
        assert_eq!(fixture.custody.files_in_custody().unwrap().len(), 1);
        let rows = locker_key_rows(&fixture.connection).unwrap();
        assert_eq!(rows.len(), 2);
        assert!(
            rows.iter()
                .any(|r| r.key_id == "k-1" && r.retired_at.is_some())
        );
    }

    /// Crash window one of two: `K′` is on disk, the DB still names `K`.
    /// Nothing was re-encrypted, so the orphan is the only thing to clean up.
    #[test]
    fn a_crash_between_the_new_key_file_and_the_transaction_sweeps_clean() {
        let fixture = founded();
        let (key_id, key) = found_locker_key(
            &fixture.connection,
            &fixture.custody,
            "k-1",
            "2026-01-01T00:00:00Z",
        )
        .unwrap();
        let sealed = encrypt_under_locker_key(&key, &key_id, "item-1", "s3cret").unwrap();
        insert_item(&fixture.connection, "item-1", &sealed, &key_id);

        let error = rotate_locker_key(
            &fixture.connection,
            &fixture.custody,
            "k-2",
            "2026-01-02T00:00:00Z",
            Some(RotationCrash::BeforeTransaction),
        )
        .unwrap_err();
        assert_eq!(error.code(), Some(LockerKeyErrorCode::Missing));

        // The DB is untouched: still `k-1` live, still the original ciphertext.
        assert_eq!(
            live_locker_key_id(&fixture.connection).unwrap().as_deref(),
            Some("k-1")
        );
        assert_eq!(
            password_of(&fixture.connection, "item-1"),
            (sealed.clone(), "k-1".into())
        );
        assert_eq!(
            fixture.custody.files_in_custody().unwrap().len(),
            2,
            "both key files are on disk after the crash"
        );

        let removed = sweep_retired_locker_keys(&fixture.connection, &fixture.custody).unwrap();
        assert_eq!(removed, vec![locker_key_file_name("v1", "k-2")]);
        assert_eq!(fixture.custody.files_in_custody().unwrap().len(), 1);
        // And the secret still opens under the key the DB names.
        assert_eq!(
            decrypt_under_locker_key(
                &fixture.custody.load("k-1").unwrap(),
                "k-1",
                "item-1",
                &sealed
            )
            .unwrap(),
            "s3cret"
        );
    }

    /// Crash window two of two: the transaction committed, so every ciphertext
    /// is under `K′` and the DB says so; the retired file is the leftover.
    #[test]
    fn a_crash_between_the_transaction_and_the_old_file_delete_sweeps_clean() {
        let fixture = founded();
        let (key_id, key) = found_locker_key(
            &fixture.connection,
            &fixture.custody,
            "k-1",
            "2026-01-01T00:00:00Z",
        )
        .unwrap();
        let sealed = encrypt_under_locker_key(&key, &key_id, "item-1", "s3cret").unwrap();
        insert_item(&fixture.connection, "item-1", &sealed, &key_id);

        assert!(
            rotate_locker_key(
                &fixture.connection,
                &fixture.custody,
                "k-2",
                "2026-01-02T00:00:00Z",
                Some(RotationCrash::BeforeOldFileDelete),
            )
            .is_err()
        );

        assert_eq!(
            live_locker_key_id(&fixture.connection).unwrap().as_deref(),
            Some("k-2"),
            "the transaction committed: the DB names K′"
        );
        let (stored, stamped) = password_of(&fixture.connection, "item-1");
        assert_eq!(stamped, "k-2");
        assert_eq!(fixture.custody.files_in_custody().unwrap().len(), 2);

        let removed = sweep_retired_locker_keys(&fixture.connection, &fixture.custody).unwrap();
        assert_eq!(removed, vec![locker_key_file_name("v1", "k-1")]);
        // The invariant both windows exist to protect: at no point is any
        // ciphertext under a key the DB does not name.
        let live = fixture.custody.load("k-2").unwrap();
        assert_eq!(
            decrypt_under_locker_key(&live, "k-2", "item-1", &stored).unwrap(),
            "s3cret"
        );
    }

    #[test]
    fn a_failed_transaction_rolls_back_and_sweeps_its_own_orphan() {
        let fixture = founded();
        found_locker_key(
            &fixture.connection,
            &fixture.custody,
            "k-1",
            "2026-01-01T00:00:00Z",
        )
        .unwrap();
        // A row whose ciphertext does not open under the key the DB names: the
        // re-encryption inside the transaction fails, and the whole rotation
        // must leave nothing behind.
        insert_item(
            &fixture.connection,
            "item-1",
            &encrypt_under_locker_key(&[99_u8; 32], "k-1", "item-1", "s3cret").unwrap(),
            "k-1",
        );
        assert!(
            rotate_locker_key(
                &fixture.connection,
                &fixture.custody,
                "k-2",
                "2026-01-02T00:00:00Z",
                None
            )
            .is_err()
        );
        assert_eq!(
            live_locker_key_id(&fixture.connection).unwrap().as_deref(),
            Some("k-1")
        );
        assert_eq!(
            fixture.custody.files_in_custody().unwrap().len(),
            1,
            "a failed rotation costs nothing, not even an orphan file"
        );
    }

    #[test]
    fn a_write_under_a_rotated_past_key_is_refused_as_stale_not_stored() {
        let fixture = founded();
        found_locker_key(
            &fixture.connection,
            &fixture.custody,
            "k-1",
            "2026-01-01T00:00:00Z",
        )
        .unwrap();
        assert!(assert_live_locker_key_id(&fixture.connection, "k-1").is_ok());
        rotate_locker_key(
            &fixture.connection,
            &fixture.custody,
            "k-2",
            "2026-01-02T00:00:00Z",
            None,
        )
        .unwrap();
        let error = assert_live_locker_key_id(&fixture.connection, "k-1").unwrap_err();
        assert_eq!(error.code(), Some(LockerKeyErrorCode::StaleKeyId));
        assert!(error.to_string().contains("re-enter this secret"));
    }

    #[test]
    fn a_missing_key_file_is_custody_loss_and_says_what_carries_the_key() {
        let fixture = founded();
        found_locker_key(
            &fixture.connection,
            &fixture.custody,
            "k-1",
            "2026-01-01T00:00:00Z",
        )
        .unwrap();
        fixture
            .custody
            .store()
            .destroy(&locker_key_file_name("v1", "k-1"))
            .unwrap();
        let error = fixture.custody.load("k-1").unwrap_err();
        assert_eq!(error.code(), Some(LockerKeyErrorCode::Missing));
        assert!(error.to_string().contains("recovery kit"));
        // …and `live_files` refuses to hand a kit a set that misses the live key.
        assert_eq!(
            fixture
                .custody
                .live_files(&fixture.connection)
                .unwrap_err()
                .code(),
            Some(LockerKeyErrorCode::Missing)
        );
    }

    /// **The acceptance test, in its wave 2 form** (#1020, D-1020-R4).
    ///
    /// Read the gateway's vault file and the whole `keys/` directory with `K`
    /// **withheld**, and every `lk1:` cell must fail to open. The gateway still
    /// *holds* `K` until wave 4 moves it to a member key; what this proves is
    /// that a sealed cell depends on `K` and on nothing else that is on disk —
    /// so moving `K` out of the gateway's custody is a change of custody, not a
    /// change of format.
    #[test]
    fn gateway_file_and_keystore_do_not_reveal_a_cell_without_k() {
        let fixture = founded();
        let (key_id, key) = found_locker_key(
            &fixture.connection,
            &fixture.custody,
            "k-1",
            "2026-01-01T00:00:00Z",
        )
        .unwrap();
        let secrets = ["s3cret", "otp-seed-bytes", "4111111111111111"];
        for (index, plaintext) in secrets.iter().enumerate() {
            let item = format!("item-{index}");
            let sealed = encrypt_under_locker_key(&key, &key_id, &item, plaintext).unwrap();
            insert_item(&fixture.connection, &item, &sealed, &key_id);
        }
        drop(fixture.connection);

        // WITHHOLD `K`: delete every key file, keeping the vault file and the
        // keys directory exactly as the gateway left them otherwise.
        let withheld = fixture.custody.destroy_all().unwrap();
        assert_eq!(withheld.len(), 1, "one live key file was withheld");

        // Now read the vault file the way an attacker with the host would.
        let stolen = rusqlite::Connection::open(&fixture.vault_file).unwrap();
        let mut statement = stolen
            .prepare("SELECT item_id, password, key_id FROM locker_item ORDER BY item_id")
            .unwrap();
        let cells = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .unwrap()
            .collect::<std::result::Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(cells.len(), secrets.len());

        // Every candidate key the host still offers: every byte string left in
        // `keys/`, plus the vault's own id and the key id, which is all the
        // file itself says about its custody.
        let mut candidates: Vec<Vec<u8>> = vec![
            [0_u8; 32].to_vec(),
            key_id.as_bytes().to_vec(),
            b"v1".to_vec(),
        ];
        for name in KeyStore::new(&fixture.keys_dir).names().unwrap() {
            candidates.push(std::fs::read(fixture.keys_dir.join(&name)).unwrap());
        }

        for (item_id, cell, stamped) in &cells {
            assert!(
                is_locker_ciphertext(cell),
                "{item_id} must be stored as ciphertext, not plaintext"
            );
            for plaintext in secrets {
                assert!(
                    !cell.contains(plaintext),
                    "{item_id}'s cell must not carry its plaintext"
                );
            }
            for candidate in &candidates {
                assert!(
                    decrypt_under_locker_key(candidate, stamped, item_id, cell).is_err(),
                    "{item_id} opened under a key that is not K — the cell depends on \
                     something other than K"
                );
            }
        }
        // And the vault file's raw bytes never carried the plaintext either.
        let raw = std::fs::read(&fixture.vault_file).unwrap();
        for plaintext in secrets {
            assert!(
                !raw.windows(plaintext.len())
                    .any(|w| w == plaintext.as_bytes()),
                "the vault file's bytes must not contain {plaintext}"
            );
        }
    }
}
