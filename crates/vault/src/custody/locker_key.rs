//! The Locker key `K`'s cell format, and the vault's two doors onto it
//! (#1020, D-1020-R2; #1047, D-6).
//!
//! ## Where `K` is, and where it is not
//!
//! `K` is the 24 words' own leaf, `seed / vault'(i) / locker'`
//! (`centraid_identity::derive`, D-6 in `docs/decisions.md`). The core derives it at open into its
//! in-memory keyring and hands it to a Locker session after the phone's unlock;
//! it is **never a file** and this crate never holds it. Every function here
//! takes the key **by value**, so there is no ambient `K` for a read path to
//! reach for. The vault stores only the live generation's **id**, in
//! `locker_key`, and a restore from the 24 words re-derives the same `K` for
//! the same id.
//!
//! The multi-seat file custody that stood beside this module under #1020 — key
//! files in a `keys/` directory, `mk1:` transfer envelopes, the recovery kit's
//! adopt, and rotation across seats — is deleted (#1047 slice D1): there is one
//! seat, it derives `K`, and nothing held a key file any more.
//!
//! Only secret **values** are encrypted. Title, url and username stay
//! plaintext, so a locked Locker can list and search — which is the whole
//! reason Locker is usable on a phone in airplane mode.
//!
//! Wire form `lk1:<base64(nonce ‖ ct ‖ tag)>`, AES-256-GCM, a fresh random
//! 96-bit nonce per value, **AAD = `<rowId>‖<keyId>`**. The `keyId` half is as
//! load-bearing as the row half: a ciphertext is unopenable under a generation
//! it was not sealed with, so a mismatch is a *distinguishable* refusal rather
//! than a corrupt secret.
//!
//! ## `locker_key` carries one id, never material
//!
//! `locker_key(key_id PK, created_at)` holds **at most one row**, the vault's
//! generation, and a unique index on a constant makes a second one
//! unrepresentable (rung seven, `contracts/migrations/007_locker_key_one_generation.sql`):
//!
//! ```sql
//! CREATE UNIQUE INDEX locker_key_one_generation ON locker_key((1))
//! ```
//!
//! `K` is the seed's single leaf, so there is no `K′` to rotate to and nothing
//! ever retires a generation; the `retired_at` column and the predicate index
//! that let one live row stand beside retired ones went with rotation
//! (R-1047-D1, R-1047-D2). The live generation is the row.

use aes_gcm::aead::{Aead, Payload};
use aes_gcm::{Aes256Gcm, KeyInit};
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;

/// `K` is 32 bytes. Anything else is not a Locker key.
pub const LOCKER_KEY_BYTES: usize = 32;

/// Wire prefix of a value encrypted under `K`.
pub const LOCKER_CIPHERTEXT_PREFIX: &str = "lk1:";

const NONCE_BYTES: usize = 12;
const TAG_BYTES: usize = 16;

/// Which columns of which physical table hold ciphertext under `K`.
///
/// Stated ONCE, here, and read by the command plane's guards, the core's
/// sealing and the tests. The list is tight on purpose: only where the value **is** the
/// secret. Everything else on these tables is the browsable half a locked Locker
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
    /// A write names a key generation that is not the vault's live one.
    StaleKeyId,
    /// This vault has no key plane; it was never founded.
    NotFounded,
}

impl LockerKeyErrorCode {
    #[must_use]
    pub const fn as_wire(self) -> &'static str {
        match self {
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

/// The live key id, or `None` on a vault whose key plane was never founded.
pub fn live_locker_key_id(connection: &rusqlite::Connection) -> Result<Option<String>> {
    let mut statement = connection.prepare("SELECT key_id FROM locker_key LIMIT 1")?;
    let mut rows = statement.query([])?;
    Ok(match rows.next()? {
        Some(row) => Some(row.get(0)?),
        None => None,
    })
}

/// AAD binding a ciphertext to its row AND its key generation.
#[must_use]
pub fn locker_aad(row_id: &str, key_id: &str) -> String {
    format!("{row_id}‖{key_id}")
}

/// The structural predicate, not a prefix test: a plaintext that merely begins
/// `lk1:` is not ciphertext. A bare `starts_with` would hand a caller a way to
/// store a plaintext secret as "already sealed" by choosing its first four
/// characters (#298).
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

/// Refuse a write that names a key generation other than the vault's live one.
///
/// Storing that ciphertext would put a row under a generation id the vault does
/// not name, so its AAD would never match on reveal. "Re-enter this secret" is
/// the only repair: the command plane cannot decrypt the intent in order to
/// re-encrypt it, which is the point of the layer.
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
                "this secret was encrypted under Locker key {key_id}, which is not this vault's \
                 generation ({live}) — re-enter this secret"
            ),
        )),
    }
}

// ---------------------------------------------------------------------------
// THE PHONE'S TWO DOORS ONTO THE KEY PLANE (#1047, wave L1; D-5, D-6).
//
// The phone is the vault (#1029), so the core that derives `K` and the file
// are on one device. These are the two things the core's Locker session needs
// from the file and cannot say itself (`crates/core` holds no SQL): the live
// generation's id, and one sealed cell's ciphertext for a reveal. Neither
// returns plaintext and neither touches key material; the unwrap is the core's.
// ---------------------------------------------------------------------------

/// One sealed item cell, as it is at rest: the ciphertext and the key
/// generation it names. Both `None` when the cell is empty.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SealedItemCell {
    pub ciphertext: Option<String>,
    pub key_id: Option<String>,
}

impl crate::file::Vault {
    /// THE LIVE LOCKER GENERATION'S ID, naming one if the vault has none —
    /// ids only, never material (#1047, Q-1047-11).
    ///
    /// The phone's `K` is derived from the 24 words, not held here, so this
    /// door writes no key file and reads none: it answers the `key_id` every
    /// sealed cell names in its AAD, and on a vault whose key plane was never
    /// founded it commits the one `locker_key` row. A restored vault carries
    /// that row in the backup, so the restored phone seals and opens under the
    /// same generation with the `K` it re-derived.
    ///
    /// Not inside a read or a commit: it may write the one `locker_key` row,
    /// and a write under `query_only` or inside another command's transaction
    /// is the escape the two guards exist to prevent.
    ///
    /// # Errors
    /// [`LockerKeyError`] — `NotFounded` inside a commit, or a failed read or
    /// write of `locker_key`.
    pub fn locker_generation(&self) -> std::result::Result<String, LockerKeyError> {
        if self.depth.get() > 0 {
            return Err(LockerKeyError::Plane {
                code: LockerKeyErrorCode::NotFounded,
                message: "the Locker generation is named outside a commit, never inside one"
                    .to_owned(),
            });
        }
        if let Some(live) = live_locker_key_id(self.connection())? {
            return Ok(live);
        }
        // THROUGH THE COMMIT GUARD AND NOWHERE ELSE (#1047 R3). This insert
        // used to go straight to the connection, so the `update_hook` never
        // saw it: the running census said `locker_key: 0`, the generation
        // manifest carried 0, and every restore of a phone that had ever
        // opened Locker was refused by `census_matches` with the row right
        // there in the file. The guard is what counts rows; a write that
        // skips it is a row the backup's own check will call missing.
        let key_id = self.ids().next();
        let created_at = self.clock().now_text();
        self.commit(|tx| {
            tx.set_producer("locker.generation");
            // Re-read under the write lock: one row, whoever got here first.
            if let Some(live) = live_locker_key_id(tx.connection()).map_err(|error| {
                crate::error::VaultError::Invariant {
                    context: format!("reading the Locker generation: {error}"),
                }
            })? {
                return Ok(live);
            }
            tx.connection().execute(
                "INSERT INTO locker_key (key_id, created_at) VALUES (?1, ?2)",
                (&key_id, &created_at),
            )?;
            Ok(key_id.clone())
        })
        .map(|committed| committed.value)
        .map_err(|error| match error {
            crate::error::VaultError::Sqlite(inner) => LockerKeyError::Sqlite(inner),
            other => LockerKeyError::plane(LockerKeyErrorCode::NotFounded, other.to_string()),
        })
    }

    /// One sealed `locker_item` cell of a LIVE item, for a reveal. `None`
    /// when no live item has `item_id` or `column` is
    /// not one of the five sealed item cells.
    ///
    /// # Errors
    /// A failed read.
    pub fn locker_sealed_item_cell(
        &self,
        item_id: &str,
        column: &str,
    ) -> crate::error::Result<Option<SealedItemCell>> {
        if !crate::commands::locker::SEALED_ITEM_CELLS.contains(&column) {
            return Ok(None);
        }
        self.read(|connection| {
            // The column is one of five compile-time names, checked above, so
            // it is spliced; the id is bound.
            let sql = format!(
                "SELECT {column}, key_id FROM locker_item WHERE item_id = ?1 AND deleted_at IS NULL"
            );
            let mut statement = connection.prepare(&sql)?;
            let mut rows = statement.query([item_id])?;
            Ok(match rows.next()? {
                Some(row) => {
                    let ciphertext: Option<String> = row.get(0)?;
                    let ciphertext = ciphertext.filter(|value| !value.is_empty());
                    Some(SealedItemCell {
                        key_id: if ciphertext.is_some() {
                            row.get(1)?
                        } else {
                            None
                        },
                        ciphertext,
                    })
                }
                None => None,
            })
        })
    }

    /// One custom field's sealed value, for a reveal (#1047 T2). `None` when
    /// no field `field_id` of a LIVE item `item_id` exists, or the field is not
    /// of the `sealed` kind — the same `None` for each, so a reveal adds no
    /// existence oracle beside the item's own (#873's sidecar rule: a trashed
    /// item's sidecars stop revealing with it).
    ///
    /// The ciphertext's additional data binds it to the FIELD's id, not the
    /// item's: a new sealed field carries the id it was sealed against
    /// (D-1020-L9), and `locker.set_field` refuses one that does not.
    ///
    /// # Errors
    /// A failed read.
    pub fn locker_sealed_field_cell(
        &self,
        item_id: &str,
        field_id: &str,
    ) -> crate::error::Result<Option<SealedItemCell>> {
        self.read(|connection| {
            let mut statement = connection.prepare(
                "SELECT f.value_sealed, f.key_id
                   FROM locker_item_field f
                   JOIN locker_item i ON i.item_id = f.item_id
                  WHERE f.field_id = ?1 AND f.item_id = ?2
                    AND f.kind = 'sealed' AND i.deleted_at IS NULL",
            )?;
            let mut rows = statement.query([field_id, item_id])?;
            Ok(match rows.next()? {
                Some(row) => {
                    let ciphertext: Option<String> = row.get(0)?;
                    let ciphertext = ciphertext.filter(|value| !value.is_empty());
                    Some(SealedItemCell {
                        key_id: if ciphertext.is_some() {
                            row.get(1)?
                        } else {
                            None
                        },
                        ciphertext,
                    })
                }
                None => None,
            })
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::file::Vault;

    struct Fixture {
        _dir: tempfile::TempDir,
        connection: rusqlite::Connection,
        vault_file: std::path::PathBuf,
    }

    /// A real vault file (the ladder head, which carries the whole Locker plane
    /// and `locker_key_one_generation`), reopened on a plain writable
    /// connection with its generation named.
    fn founded() -> Fixture {
        let dir = tempfile::tempdir().expect("scratch dir");
        let vault_file = dir.path().join("vault").join("v1").join("vault.db");
        std::fs::create_dir_all(vault_file.parent().unwrap()).unwrap();
        Vault::create(&vault_file).unwrap().close().unwrap();
        let connection = rusqlite::Connection::open(&vault_file).unwrap();
        connection
            .execute_batch("PRAGMA foreign_keys = ON")
            .unwrap();
        connection
            .execute(
                "INSERT INTO locker_key (key_id, created_at) \
                 VALUES ('k-1', '2026-01-01T00:00:00Z')",
                [],
            )
            .unwrap();
        Fixture {
            _dir: dir,
            connection,
            vault_file,
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

    #[test]
    fn a_second_generation_is_unrepresentable() {
        let fixture = founded();
        let error = fixture
            .connection
            .execute(
                "INSERT INTO locker_key (key_id, created_at) \
                 VALUES ('k-2', '2026-01-02T00:00:00Z')",
                [],
            )
            .unwrap_err();
        assert!(
            error.to_string().contains("locker_key_one_generation"),
            "locker_key_one_generation must refuse a second row: {error}"
        );
    }

    /// RUNG SEVEN OVER A FILE WRITTEN BEFORE IT (R-1047-D2): the live
    /// generation survives, a retired one does not, and the guard reads the
    /// survivor.
    #[test]
    fn rung_seven_keeps_the_live_generation_and_drops_the_retired_ones() {
        let dir = tempfile::tempdir().expect("scratch dir");
        let vault_file = dir.path().join("vault").join("v1").join("vault.db");
        std::fs::create_dir_all(vault_file.parent().unwrap()).unwrap();
        Vault::create(&vault_file).unwrap().close().unwrap();
        {
            let raw = rusqlite::Connection::open(&vault_file).unwrap();
            raw.execute_batch(
                "BEGIN;
                 DROP TABLE locker_key;
                 CREATE TABLE locker_key (
                   key_id     TEXT PRIMARY KEY,
                   created_at TEXT NOT NULL,
                   retired_at TEXT
                 ) STRICT;
                 CREATE UNIQUE INDEX locker_key_live_idx
                   ON locker_key(retired_at IS NULL) WHERE retired_at IS NULL;
                 CREATE TABLE notifications_notice (notice_id TEXT PRIMARY KEY) STRICT;
                 DROP TABLE chat_message_attachment;
                 DROP TABLE chat_message_card;
                 DROP TABLE chat_message;
                 DROP TABLE chat_thread;
                 ALTER TABLE locker_item ADD COLUMN url_match_policy TEXT NOT NULL
                   DEFAULT 'registrable-domain';
                 ALTER TABLE locker_item_address ADD COLUMN match_policy TEXT NOT NULL
                   DEFAULT 'registrable-domain';
                 INSERT INTO locker_key VALUES
                   ('k-old', '2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z'),
                   ('k-live', '2026-02-01T00:00:00Z', NULL);
                 PRAGMA user_version = 6;
                 COMMIT;",
            )
            .unwrap();
        }
        let migrated = Vault::open(&vault_file).expect("the file climbs rung seven");
        assert_eq!(migrated.schema_version(), crate::head_version());
        let (rows, live, objects) = migrated
            .read(|connection| {
                let rows: Vec<String> = connection
                    .prepare("SELECT key_id FROM locker_key ORDER BY key_id")?
                    .query_map([], |row| row.get(0))?
                    .collect::<rusqlite::Result<_>>()?;
                let objects: Vec<String> = connection
                    .prepare(
                        "SELECT name FROM sqlite_master
                          WHERE tbl_name = 'locker_key' AND sql IS NOT NULL ORDER BY name",
                    )?
                    .query_map([], |row| row.get(0))?
                    .collect::<rusqlite::Result<_>>()?;
                Ok((rows, live_locker_key_id(connection).ok().flatten(), objects))
            })
            .unwrap();
        assert_eq!(rows, ["k-live"]);
        assert_eq!(live.as_deref(), Some("k-live"));
        assert_eq!(objects, ["locker_key", "locker_key_one_generation"]);
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
    fn a_write_under_a_generation_that_is_not_live_is_refused_as_stale_not_stored() {
        let fixture = founded();
        assert!(assert_live_locker_key_id(&fixture.connection, "k-1").is_ok());
        let error = assert_live_locker_key_id(&fixture.connection, "k-0").unwrap_err();
        assert_eq!(error.code(), Some(LockerKeyErrorCode::StaleKeyId));
        assert!(error.to_string().contains("re-enter this secret"));
    }

    /// A SEALED CELL DEPENDS ON `K` AND ON NOTHING ELSE IN THE FILE
    /// (#1020, D-1020-R4; #1047, D-6).
    ///
    /// Read the vault file with `K` withheld, and every `lk1:` cell must fail
    /// to open under everything the file itself says about its key plane — the
    /// generation id, a zero key. `K` lives only in the core's memory, so this
    /// is the whole of what a copy of the file (a backup restored anywhere, a
    /// stolen disk) offers towards a secret.
    #[test]
    fn the_vault_file_does_not_reveal_a_cell_without_k() {
        let fixture = founded();
        let key = [0x5a_u8; LOCKER_KEY_BYTES];
        let secrets = ["s3cret", "otp-seed-bytes", "4111111111111111"];
        for (index, plaintext) in secrets.iter().enumerate() {
            let item = format!("item-{index}");
            let sealed = encrypt_under_locker_key(&key, "k-1", &item, plaintext).unwrap();
            insert_item(&fixture.connection, &item, &sealed, "k-1");
        }
        drop(fixture.connection);

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

        let candidates: Vec<Vec<u8>> = vec![[0_u8; 32].to_vec(), b"k-1".to_vec()];
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
                    "{item_id} opened under a key that is not K"
                );
            }
            // …and it DOES open under `K`, so the refusals above are not vacuous.
            assert!(decrypt_under_locker_key(&key, stamped, item_id, cell).is_ok());
        }
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
