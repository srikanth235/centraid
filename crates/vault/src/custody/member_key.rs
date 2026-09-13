//! THE MEMBER KEY — where `K` is born, who holds it, and how it reaches a
//! second seat (#1020, D-1020-L1, D-1020-L2).
//!
//! [`super::locker_key`] is the *format*: `lk1:` cells, the AAD, the rotation
//! order, and the `locker_key` table that carries ids and never material. This
//! module is the *custody*, and it is the half wave 4 changes.
//!
//! ## v0's posture, and the one sentence that ends it
//!
//! v0 minted `K` at vault founding into the **gateway's** `keys/` directory
//! and handed it to any enrolled device through `GET
//! /_vault/seat/locker-key`. The route's own comment is honest about why there
//! was no narrower principal: *an enrolment covers the vault, and `K` opens
//! the vault's Locker.* R-1020's trust premise says the gateway never holds it
//! (#1020 `:33`), and so:
//!
//! - **Founding mints `K` on a seat.** [`found_member_key`] takes the *seat's*
//!   keystore. There is no constructor here that takes the gateway's, and
//!   [`MemberKeyCustody`] is the only way to reach a key file — see
//!   *The door is deleted structurally* below.
//! - **A vault with zero seats holds no `K` and no secrets.** The `locker_key`
//!   table is empty, and every Locker write that carries a secret is refused
//!   with the typed `MemberKeyAbsent` the command plane raises
//!   (`crates/vault/src/commands/locker.rs`) — *never* a silent plaintext.
//! - **A second seat gets `K` from a first seat, or from the recovery kit.**
//!   Both are below; both are fixtured.
//!
//! ## The door is deleted structurally, in three places
//!
//! 1. `crates/vault::access` has no `Verb::Reveal` and its
//!    `SealedSubject::new` refuses `locker`, so there is no gateway value that
//!    means "reveal a Locker cell" (D-1020-L2).
//! 2. This module's [`MemberKeyCustody`] is the only type that opens a member
//!    key file, and it is **constructed from a seat's data directory**. The
//!    gateway-side helper that used to map a vault directory to `<root>/keys`
//!    for a Locker key is gone; the seal key and the identity seed still use
//!    it, because those are the host's own and always were.
//! 3. `crates/core::api::reveal` answers by ROLE: on the gateway role it
//!    returns the typed refusal, and on a seat role it unwraps locally.
//!
//! ## The envelope, and why it is not a public-key box (D-1020-L11)
//!
//! `K` reaches a new seat as `mk1:<base64(nonce ‖ ct ‖ tag)>` — AES-256-GCM
//! under a key derived by HKDF-SHA-256 from a **one-time transfer secret**,
//! with `AAD = <vaultId>‖<keyId>‖<recipientDeviceId>`. The gateway relays the
//! envelope and cannot open it: it never sees the transfer secret, which moves
//! out of band (a code the member reads on the sending seat and enters on the
//! receiving one, or rides the pairing ceremony the owner is already present
//! for).
//!
//! Three options were weighed:
//!
//! - **(a) wrap `K` under the new seat's device public key.** The obvious
//!   answer, and rejected here for two concrete reasons rather than taste:
//!   `access_device_secret.public_key` is an **ed25519** signing key (it is
//!   iroh's node identity), so a KEM over it needs an ed25519→X25519
//!   conversion this tree has no primitive for; and adding one would add a new
//!   normative AEAD/KEM format, which D-1020-R1 makes a *re-keying event*
//!   proven against `contracts/golden/format-golden.json` rather than routine
//!   housekeeping. It is the better long-run shape and it is an owner
//!   hand-off, not a silent omission.
//! - **(b) relay `K` over the existing authenticated transport.** Rejected:
//!   iroh terminates at the gateway, so "the gateway relays ciphertext it
//!   cannot open" would be false.
//! - **(c) a one-time transfer secret with HKDF + AES-GCM.** Adopted. Both
//!   primitives are already normative in this tree (the recovery kit's
//!   scrypt+AES-GCM wrap, `crates/media`'s HKDF), the gateway is genuinely
//!   blind, and the member's gesture is the one they already perform when
//!   pairing a device.
//!
//! The AAD's third component is what makes an envelope **non-replayable to
//! another seat**: an envelope minted for device A does not open on device B
//! even with A's transfer secret, so a relayed copy is useless to the host
//! that relayed it.

use std::path::{Path, PathBuf};

use aes_gcm::aead::{Aead, Payload};
use aes_gcm::{Aes256Gcm, KeyInit};
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;

use super::keystore::{KeyStore, KeyStoreError};
use super::locker_key::{LOCKER_KEY_BYTES, LockerKeyError, LockerKeyErrorCode};

/// Wire prefix of a member-key envelope.
pub const MEMBER_KEY_ENVELOPE_PREFIX: &str = "mk1:";

/// The HKDF info string. Domain separation: the same transfer secret must not
/// derive a key that opens anything else.
pub const ENVELOPE_INFO: &[u8] = b"centraid-member-key-envelope-v1";

/// A transfer secret is 32 bytes of full entropy, which is why the KDF is HKDF
/// and not scrypt: there is no password here to make expensive.
pub const TRANSFER_SECRET_BYTES: usize = 32;

const NONCE_BYTES: usize = 12;
const TAG_BYTES: usize = 16;

/// Where a SEAT keeps its member key files.
///
/// **There is no gateway constructor.** A caller holding a gateway data
/// directory cannot build one of these, which is the second of D-1020-L2's
/// three structural moves: the gateway's `keys/` still holds the seal key and
/// the identity seed — those are the host's own and always were — and it holds
/// no member key because there is no code path that would put one there.
pub struct MemberKeyCustody {
    store: KeyStore,
    vault_id: String,
}

impl MemberKeyCustody {
    /// The custody of a member key, on a seat.
    ///
    /// `seat_data_dir` is the seat's own directory — the one the shell owns,
    /// not the gateway's. The `keys/` subdirectory is created with the
    /// keystore's own permissions on first write.
    #[must_use]
    pub fn on_seat(seat_data_dir: &Path, vault_id: impl Into<String>) -> Self {
        Self {
            store: KeyStore::new(member_key_dir_on_seat(seat_data_dir)),
            vault_id: vault_id.into(),
        }
    }

    /// The same, given a keystore a caller already holds — for a seat whose
    /// key directory is not under its data directory (a test, a drill).
    #[must_use]
    pub fn with_store(store: KeyStore, vault_id: impl Into<String>) -> Self {
        Self {
            store,
            vault_id: vault_id.into(),
        }
    }

    fn name(&self, key_id: &str) -> String {
        super::locker_key::locker_key_file_name(&self.vault_id, key_id)
    }

    /// Mint `K` for a key id. Idempotent: an existing file is returned.
    ///
    /// **The FILE comes first and the row second**, which is the same order
    /// rotation uses and for the same reason: a row naming a key file that
    /// does not exist is unrecoverable, and a key file no row names is a
    /// sweepable orphan.
    pub fn mint(&self, key_id: &str) -> Result<Vec<u8>, LockerKeyError> {
        if let Some(key) = self.store.load(&self.name(key_id))? {
            return Ok(key);
        }
        Ok(self.store.create(&self.name(key_id))?)
    }

    /// Load `K`, or say what the only repair is.
    pub fn load(&self, key_id: &str) -> Result<Vec<u8>, LockerKeyError> {
        match self.store.load(&self.name(key_id))? {
            Some(key) => Ok(key),
            None => Err(LockerKeyError::Plane {
                code: LockerKeyErrorCode::Missing,
                message: format!(
                    "this seat holds no member key for generation {key_id}. Another seat that \
                     already holds it can send one (a member-key envelope), or the recovery \
                     kit carries it under the member's passphrase — the gateway never had it \
                     and cannot help (#1020, open question 8)."
                ),
            }),
        }
    }

    /// Adopt a key this seat received in an envelope, or from the kit.
    pub fn adopt(&self, key_id: &str, key: &[u8]) -> Result<(), LockerKeyError> {
        if key.len() != LOCKER_KEY_BYTES {
            return Err(LockerKeyError::KeyLength(key.len()));
        }
        self.store.store(&self.name(key_id), key)?;
        Ok(())
    }

    /// Drop one generation's file — the "delete `K` after your own copy of
    /// `K′` is confirmed" step of a rotation (D-1020-L4, step 3).
    pub fn forget(&self, key_id: &str) -> Result<bool, LockerKeyError> {
        Ok(self.store.destroy(&self.name(key_id))?)
    }

    /// Every generation this seat holds, by key id.
    pub fn generations(&self) -> Result<Vec<String>, LockerKeyError> {
        let prefix = format!("{}.locker.", self.vault_id);
        let mut out: Vec<String> = self
            .store
            .names()?
            .into_iter()
            .filter_map(|name| {
                name.strip_prefix(&prefix)
                    .and_then(|rest| rest.strip_suffix(".key"))
                    .filter(|key_id| !key_id.is_empty())
                    .map(str::to_owned)
            })
            .collect();
        out.sort_unstable();
        Ok(out)
    }

    /// Every generation this seat holds, with its material — what the recovery
    /// kit carries.
    ///
    /// "Every live key file" is not always one: `K′` exists on disk before the
    /// DB names it, so a kit written mid-rotation must carry **both** or the
    /// restore it promises is a placebo.
    pub fn files_in_custody(&self) -> Result<Vec<(String, Vec<u8>)>, LockerKeyError> {
        let mut out = Vec::new();
        for key_id in self.generations()? {
            if let Some(key) = self.store.load(&self.name(&key_id))? {
                out.push((key_id, key));
            }
        }
        Ok(out)
    }

    /// The same set, checked against the DB's word on which generation is live.
    pub fn live_files(
        &self,
        connection: &rusqlite::Connection,
    ) -> Result<Vec<(String, Vec<u8>)>, LockerKeyError> {
        let files = self.files_in_custody()?;
        if let Some(live) = super::locker_key::live_locker_key_id(connection)?
            && !files.iter().any(|(key_id, _)| *key_id == live)
        {
            return Err(LockerKeyError::Plane {
                code: LockerKeyErrorCode::Missing,
                message: format!(
                    "recovery kit: vault \"{}\" names Locker key {live} and this host holds \
                     no key file for it",
                    self.vault_id
                ),
            });
        }
        Ok(files)
    }

    /// Destroy EVERY member key file for this vault — the erase half of
    /// custody. The sweep cannot do this job: it asks the database which
    /// generation is live, and an erase has already removed it.
    pub fn destroy_all(&self) -> Result<Vec<String>, LockerKeyError> {
        let mut removed = Vec::new();
        for key_id in self.generations()? {
            let name = self.name(&key_id);
            if self.store.destroy(&name)? {
                removed.push(name);
            }
        }
        Ok(removed)
    }

    /// The keystore, for the two functions in [`super::locker_key`] that mint
    /// and sweep files. Not `pub` beyond this module's siblings, so a caller
    /// outside `custody/` cannot reach past the typed methods above.
    pub(super) const fn store(&self) -> &KeyStore {
        &self.store
    }

    /// The file name a generation takes — the sweep compares names.
    pub(super) fn file_name(&self, key_id: &str) -> String {
        self.name(key_id)
    }

    /// The vault this custody is for.
    #[must_use]
    pub fn vault_id(&self) -> &str {
        &self.vault_id
    }

    /// Warnings the keystore accumulated — an adopted unprotected envelope, a
    /// repaired permission. Loud rather than invisible (D-1020-R2).
    pub fn take_warnings(&self) -> Vec<String> {
        self.store.take_warnings()
    }
}

/// `<seatDataDir>/keys` — where a seat's own key files live.
///
/// Named for the role on purpose. The gateway-side equivalent exists for the
/// seal key and the identity seed and is deliberately **not** reachable from
/// here.
#[must_use]
pub fn member_key_dir_on_seat(seat_data_dir: &Path) -> PathBuf {
    seat_data_dir.join("keys")
}

/// FOUNDING, ON THE SEAT THAT FOUNDS THE VAULT (D-1020-L1).
///
/// The seat mints `K` into its own keystore and the vault commits
/// `locker_key {key_id, created_at, retired_at: NULL}` — **ids only, never
/// material**. A gateway that later serves this vault finds a row naming a key
/// it does not have, which is the correct and permanent state of affairs.
///
/// Option (b) was considered and rejected: a gateway-held `K` until the first
/// seat pairs, then handed over and erased. *A key that was once on the host
/// was on the host* — the erase is unverifiable from the member's side, the
/// backup that ran in between carries it, and the premise would be a promise
/// rather than a property.
pub fn found_member_key(
    connection: &rusqlite::Connection,
    custody: &MemberKeyCustody,
    key_id: &str,
    now: &str,
) -> Result<MemberKeyFounded, LockerKeyError> {
    if let Some(live) = super::locker_key::live_locker_key_id(connection)? {
        let key = custody.load(&live)?;
        return Ok(MemberKeyFounded {
            key_id: live,
            key,
            minted: false,
        });
    }
    let key = custody.mint(key_id)?;
    connection.execute(
        "INSERT INTO locker_key (key_id, created_at, retired_at) VALUES (?1, ?2, NULL)",
        (key_id, now),
    )?;
    Ok(MemberKeyFounded {
        key_id: key_id.to_owned(),
        key,
        minted: true,
    })
}

/// What founding produced. `minted` is false when the plane already existed —
/// founding is idempotent and says which it was.
pub struct MemberKeyFounded {
    pub key_id: String,
    pub key: Vec<u8>,
    pub minted: bool,
}

/// A SEALED MEMBER-KEY ENVELOPE. The gateway relays this and cannot open it.
///
/// `key_id` and `recipient_device_id` are in the clear because the **relay**
/// needs them to route and the recipient needs them to know which generation
/// arrived; both are bound into the AAD, so neither can be altered in transit
/// without the open failing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MemberKeyEnvelope {
    pub vault_id: String,
    pub key_id: String,
    pub recipient_device_id: String,
    /// `mk1:<base64(nonce ‖ ct ‖ tag)>`.
    pub sealed: String,
}

/// The AAD: the vault, the generation, and the seat this envelope is for.
///
/// The third component is what makes a relayed copy useless to another seat —
/// and therefore useless to the host that relayed it.
#[must_use]
pub fn envelope_aad(vault_id: &str, key_id: &str, recipient_device_id: &str) -> String {
    format!("{vault_id}‖{key_id}‖{recipient_device_id}")
}

fn envelope_cipher(transfer_secret: &[u8], vault_id: &str) -> Result<Aes256Gcm, LockerKeyError> {
    if transfer_secret.len() != TRANSFER_SECRET_BYTES {
        return Err(LockerKeyError::KeyLength(transfer_secret.len()));
    }
    // HKDF, not scrypt: a transfer secret is 32 bytes of CSPRNG output, and
    // making a full-entropy secret expensive to derive from buys nothing. The
    // recovery kit's scrypt is for the other case — a passphrase a person
    // chose.
    let hkdf = hkdf::Hkdf::<sha2::Sha256>::new(Some(vault_id.as_bytes()), transfer_secret);
    let mut key = [0_u8; 32];
    hkdf.expand(ENVELOPE_INFO, &mut key)
        .map_err(|_| LockerKeyError::KeyLength(transfer_secret.len()))?;
    Aes256Gcm::new_from_slice(&key).map_err(|_| LockerKeyError::KeyLength(key.len()))
}

/// A fresh transfer secret. The member moves this out of band; the host never
/// sees it.
#[must_use]
pub fn fresh_transfer_secret() -> [u8; TRANSFER_SECRET_BYTES] {
    super::random_bytes::<TRANSFER_SECRET_BYTES>()
}

/// Seal `K` for one recipient seat.
pub fn seal_member_key(
    key: &[u8],
    transfer_secret: &[u8],
    vault_id: &str,
    key_id: &str,
    recipient_device_id: &str,
) -> Result<MemberKeyEnvelope, LockerKeyError> {
    if key.len() != LOCKER_KEY_BYTES {
        return Err(LockerKeyError::KeyLength(key.len()));
    }
    let cipher = envelope_cipher(transfer_secret, vault_id)?;
    let aad = envelope_aad(vault_id, key_id, recipient_device_id);
    let nonce = super::random_bytes::<NONCE_BYTES>();
    let body = cipher
        .encrypt(
            (&nonce).into(),
            Payload {
                msg: key,
                aad: aad.as_bytes(),
            },
        )
        .map_err(|_| LockerKeyError::Authentication { aad: aad.clone() })?;
    let mut raw = Vec::with_capacity(NONCE_BYTES + body.len());
    raw.extend_from_slice(&nonce);
    raw.extend_from_slice(&body);
    Ok(MemberKeyEnvelope {
        vault_id: vault_id.to_owned(),
        key_id: key_id.to_owned(),
        recipient_device_id: recipient_device_id.to_owned(),
        sealed: format!("{MEMBER_KEY_ENVELOPE_PREFIX}{}", STANDARD.encode(raw)),
    })
}

/// Open an envelope on the seat it was minted for.
///
/// Fails on a wrong transfer secret, a wrong recipient, a wrong generation, a
/// wrong vault, or tampering — all five as one `Authentication` error, because
/// distinguishing them for the caller would be an oracle.
pub fn open_member_key(
    envelope: &MemberKeyEnvelope,
    transfer_secret: &[u8],
    recipient_device_id: &str,
) -> Result<Vec<u8>, LockerKeyError> {
    let cipher = envelope_cipher(transfer_secret, &envelope.vault_id)?;
    let body = envelope
        .sealed
        .strip_prefix(MEMBER_KEY_ENVELOPE_PREFIX)
        .ok_or(LockerKeyError::NotCiphertext)?;
    let raw = STANDARD
        .decode(body)
        .map_err(|_| LockerKeyError::NotCiphertext)?;
    if raw.len() < NONCE_BYTES + TAG_BYTES {
        return Err(LockerKeyError::Truncated);
    }
    let aad = envelope_aad(&envelope.vault_id, &envelope.key_id, recipient_device_id);
    let nonce: [u8; NONCE_BYTES] = raw[..NONCE_BYTES].try_into().expect("checked length");
    let key = cipher
        .decrypt(
            (&nonce).into(),
            Payload {
                msg: &raw[NONCE_BYTES..],
                aad: aad.as_bytes(),
            },
        )
        .map_err(|_| LockerKeyError::Authentication { aad })?;
    if key.len() != LOCKER_KEY_BYTES {
        return Err(LockerKeyError::KeyLength(key.len()));
    }
    Ok(key)
}

/// Whether a value is structurally a member-key envelope body.
///
/// Structural, for the same reason `is_locker_ciphertext` is: a value that
/// merely begins `mk1:` is not an envelope, and a caller that treated one as
/// already-sealed would relay a plaintext key.
#[must_use]
pub fn is_member_key_envelope(value: &str) -> bool {
    let Some(body) = value.strip_prefix(MEMBER_KEY_ENVELOPE_PREFIX) else {
        return false;
    };
    if body.is_empty() || !body.len().is_multiple_of(4) {
        return false;
    }
    STANDARD
        .decode(body)
        .is_ok_and(|raw| raw.len() >= NONCE_BYTES + TAG_BYTES + LOCKER_KEY_BYTES)
}

/// The kit's half: adopt every generation a recovery kit carries.
///
/// The kit is **the single custody path** now (census §F3), which raises it
/// from *one of two* to *the one artefact between a member and total loss* —
/// so this returns what it adopted rather than a boolean, and a kit that
/// carried none is a refusal rather than a quiet success.
pub fn adopt_from_kit(
    custody: &MemberKeyCustody,
    entries: &[(String, Vec<u8>)],
) -> Result<Vec<String>, LockerKeyError> {
    if entries.is_empty() {
        return Err(LockerKeyError::Plane {
            code: LockerKeyErrorCode::Missing,
            message: "this recovery kit carries no member key, so it cannot restore this \
                      vault's Locker secrets. A kit written before the member key existed, or \
                      written from a host that never held one, is the case to check."
                .to_owned(),
        });
    }
    let mut adopted = Vec::with_capacity(entries.len());
    for (key_id, key) in entries {
        custody.adopt(key_id, key)?;
        adopted.push(key_id.clone());
    }
    adopted.sort_unstable();
    Ok(adopted)
}

/// The member key plane's own errors, for a caller that wants them apart from
/// the format layer's.
#[derive(Debug, thiserror::Error)]
pub enum MemberKeyError {
    /// This vault has no member key, so it holds no secrets — and a write that
    /// carries one is refused rather than stored in the clear (D-1020-L1).
    #[error(
        "this vault has no member key: a vault with no seat holds no key and therefore no Locker secrets. Found one on a seat before storing a secret (#1020, D-1020-L1)."
    )]
    Absent,
    #[error(transparent)]
    Custody(#[from] KeyStoreError),
    #[error(transparent)]
    Plane(#[from] LockerKeyError),
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch() -> PathBuf {
        let dir = centraid_ontology::golden::scratch_dir();
        std::fs::create_dir_all(&dir).expect("the directory is made");
        dir
    }

    fn seat(name: &str) -> (PathBuf, MemberKeyCustody) {
        let dir = scratch().join(name);
        std::fs::create_dir_all(&dir).expect("the seat's directory");
        (dir.clone(), MemberKeyCustody::on_seat(&dir, "vault-1"))
    }

    /// FOUNDING PUTS `K` ON THE SEAT AND AN ID IN THE VAULT.
    #[test]
    fn founding_mints_on_the_seat_and_commits_an_id_only() {
        let (dir, custody) = seat("founding");
        let connection = rusqlite::Connection::open_in_memory().expect("a connection");
        connection
            .execute_batch(
                "CREATE TABLE locker_key (key_id TEXT PRIMARY KEY, created_at TEXT NOT NULL,
                   retired_at TEXT);
                 CREATE UNIQUE INDEX locker_key_live_idx ON locker_key(retired_at IS NULL)
                   WHERE retired_at IS NULL;",
            )
            .expect("the key plane's table");

        let founded = found_member_key(&connection, &custody, "key-1", "2026-01-01T00:00:00.000Z")
            .expect("founded");
        assert!(founded.minted);
        assert_eq!(founded.key.len(), LOCKER_KEY_BYTES);

        // The ROW carries an id and nothing else.
        let (key_id, retired_at): (String, Option<String>) = connection
            .query_row("SELECT key_id, retired_at FROM locker_key", [], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })
            .expect("one row");
        assert_eq!(key_id, "key-1");
        assert_eq!(retired_at, None);
        // …and the table has three columns, none of which is key material.
        let columns: Vec<String> = connection
            .prepare("SELECT name FROM pragma_table_info('locker_key')")
            .expect("the pragma")
            .query_map([], |row| row.get(0))
            .expect("the columns")
            .collect::<rusqlite::Result<Vec<String>>>()
            .expect("the columns read");
        assert_eq!(columns, ["key_id", "created_at", "retired_at"]);

        // The KEY is on the seat's disk and nowhere else.
        assert_eq!(custody.generations().expect("generations"), ["key-1"]);
        let files: Vec<String> = std::fs::read_dir(dir.join("keys"))
            .expect("the seat's keys directory")
            .map(|entry| {
                entry
                    .expect("an entry")
                    .file_name()
                    .to_string_lossy()
                    .into_owned()
            })
            .collect();
        assert_eq!(files, ["vault-1.locker.key-1.key"]);

        // Idempotent, and it says which it was.
        let again = found_member_key(&connection, &custody, "key-2", "2026-01-02T00:00:00.000Z")
            .expect("founded");
        assert!(!again.minted);
        assert_eq!(again.key_id, "key-1");
        assert_eq!(again.key, founded.key);
    }

    /// THE ENVELOPE OPENS ON THE SEAT IT WAS MINTED FOR, AND ON NO OTHER.
    #[test]
    fn an_envelope_is_bound_to_its_recipient_its_generation_and_its_vault() {
        let key = [7_u8; LOCKER_KEY_BYTES];
        let secret = fresh_transfer_secret();
        let envelope =
            seal_member_key(&key, &secret, "vault-1", "key-1", "device-b").expect("sealed");
        assert!(is_member_key_envelope(&envelope.sealed));

        assert_eq!(
            open_member_key(&envelope, &secret, "device-b").expect("opened"),
            key.to_vec()
        );

        // A DIFFERENT SEAT CANNOT OPEN IT even with the transfer secret, which
        // is what makes a relayed copy useless to the host that relayed it.
        assert!(open_member_key(&envelope, &secret, "device-c").is_err());
        // A different transfer secret cannot.
        assert!(open_member_key(&envelope, &[0_u8; TRANSFER_SECRET_BYTES], "device-b").is_err());
        // A relabelled generation cannot.
        let relabelled = MemberKeyEnvelope {
            key_id: "key-2".to_owned(),
            ..envelope.clone()
        };
        assert!(open_member_key(&relabelled, &secret, "device-b").is_err());
        // A relabelled vault cannot.
        let moved = MemberKeyEnvelope {
            vault_id: "vault-2".to_owned(),
            ..envelope.clone()
        };
        assert!(open_member_key(&moved, &secret, "device-b").is_err());
        // A flipped byte cannot.
        let mut tampered = envelope.clone();
        let body = tampered.sealed.split_off(MEMBER_KEY_ENVELOPE_PREFIX.len());
        let mut raw = STANDARD.decode(&body).expect("base64");
        raw[NONCE_BYTES] ^= 0xff;
        tampered.sealed.push_str(&STANDARD.encode(raw));
        assert!(open_member_key(&tampered, &secret, "device-b").is_err());
    }

    /// A PLAINTEXT KEY IS NOT AN ENVELOPE, structurally.
    #[test]
    fn a_value_that_merely_starts_with_the_prefix_is_not_an_envelope() {
        assert!(!is_member_key_envelope("mk1:"));
        assert!(!is_member_key_envelope("mk1:aGVsbG8="));
        assert!(!is_member_key_envelope("lk1:aGVsbG8="));
        assert!(!is_member_key_envelope(""));
        // Long enough to be base64 and too short to be an envelope: a nonce, a
        // tag and a 32-byte key is the floor.
        let short = STANDARD.encode([0_u8; NONCE_BYTES + TAG_BYTES]);
        assert!(!is_member_key_envelope(&format!("mk1:{short}")));
    }

    /// THE SECOND SEAT'S WHOLE JOURNEY, end to end.
    #[test]
    fn a_second_seat_adopts_the_key_and_can_then_open_a_cell() {
        let (_, first) = seat("first");
        let (_, second) = seat("second");
        let key = first.mint("key-1").expect("minted");

        // The first seat seals for the second; the gateway relays the
        // envelope and holds neither the key nor the transfer secret.
        let secret = fresh_transfer_secret();
        let envelope =
            seal_member_key(&key, &secret, "vault-1", "key-1", "device-b").expect("sealed");
        let received = open_member_key(&envelope, &secret, "device-b").expect("opened");
        second.adopt("key-1", &received).expect("adopted");
        assert_eq!(second.load("key-1").expect("loaded"), key);

        // And the two seats now open the same cell.
        let cell =
            super::super::locker_key::encrypt_under_locker_key(&key, "key-1", "item-1", "hunter2")
                .expect("sealed");
        assert_eq!(
            super::super::locker_key::decrypt_under_locker_key(
                &second.load("key-1").expect("loaded"),
                "key-1",
                "item-1",
                &cell
            )
            .expect("opened"),
            "hunter2"
        );
    }

    /// A SEAT THAT HOLDS NO GENERATION SAYS WHAT THE REPAIRS ARE.
    #[test]
    fn a_missing_generation_names_both_repairs_and_not_the_gateway() {
        let (_, custody) = seat("missing");
        let error = custody.load("key-1").expect_err("nothing to load");
        let message = error.to_string();
        assert!(message.contains("member-key envelope"), "{message}");
        assert!(message.contains("recovery kit"), "{message}");
        assert!(
            message.contains("the gateway never had it"),
            "the message offers the gateway as a repair: {message}"
        );
    }

    /// ROTATION'S STEP 3: a seat forgets the old generation once its own copy
    /// of the new one is confirmed.
    #[test]
    fn a_seat_forgets_a_retired_generation_and_keeps_the_live_one() {
        let (_, custody) = seat("forget");
        custody.mint("key-1").expect("minted");
        custody.mint("key-2").expect("minted");
        assert_eq!(
            custody.generations().expect("generations"),
            ["key-1", "key-2"]
        );
        assert!(custody.forget("key-1").expect("forgotten"));
        assert_eq!(custody.generations().expect("generations"), ["key-2"]);
        // Forgetting one that is already gone is not an error, and says so.
        assert!(!custody.forget("key-1").expect("nothing to forget"));
    }

    /// A KIT WITH NO MEMBER KEY IS A REFUSAL, not a quiet success.
    #[test]
    fn a_kit_that_carries_no_member_key_refuses_rather_than_restoring_nothing() {
        let (_, custody) = seat("kit");
        let error = adopt_from_kit(&custody, &[]).expect_err("an empty kit is refused");
        assert!(error.to_string().contains("carries no member key"));

        let adopted = adopt_from_kit(
            &custody,
            &[
                ("key-2".to_owned(), vec![2_u8; LOCKER_KEY_BYTES]),
                ("key-1".to_owned(), vec![1_u8; LOCKER_KEY_BYTES]),
            ],
        )
        .expect("adopted");
        assert_eq!(adopted, ["key-1", "key-2"]);
        assert_eq!(
            custody.generations().expect("generations"),
            ["key-1", "key-2"]
        );
    }

    /// A key of the wrong length is refused at the boundary, both ways.
    #[test]
    fn a_key_that_is_not_thirty_two_bytes_is_not_a_member_key() {
        let (_, custody) = seat("length");
        assert!(custody.adopt("key-1", &[1_u8; 16]).is_err());
        let secret = fresh_transfer_secret();
        assert!(seal_member_key(&[1_u8; 16], &secret, "v", "k", "d").is_err());
        assert!(seal_member_key(&[1_u8; 32], &[0_u8; 8], "v", "k", "d").is_err());
    }
}
