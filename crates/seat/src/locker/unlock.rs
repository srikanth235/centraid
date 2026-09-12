//! THE WRAP AT REST, AND THE REVEAL WINDOW.
//!
//! `wrapVaultKey` / `unwrapVaultKey` from `locker-unlock.ts`, ported: PBKDF2-
//! SHA-256 at [`WRAP_ITERATIONS`] over the member's passphrase, AES-256-GCM
//! around `K`, and a random salt and nonce per wrap. The blob is a value with
//! no key in it, which is the only thing this seat writes down.
//!
//! **A wrong passphrase is an AEAD authentication failure, and that is the
//! whole verifier.** Nothing at rest can be checked against a guess without
//! doing the derivation, so there is no cheap oracle to attack — which is why
//! the wrapped blob carries no verifier field and never will.

use aes_gcm::aead::{Aead, Payload};
use aes_gcm::{Aes256Gcm, KeyInit};
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;

use super::session::{PASSPHRASE_MINIMUM, Session, WrappedKey};

/// PBKDF2 rounds. High enough to cost a guesser real time, low enough that an
/// unlock on a phone-class CPU stays under a second — the same trade the
/// recovery kit's scrypt makes, in the primitive every platform gives us.
pub const WRAP_ITERATIONS: u32 = 600_000;

/// One reveal's window, used or not (`reveal.ts:21`).
///
/// *A reveal is a gesture, not a mode*, and the reason for thirty seconds was
/// never the permit's lifetime — it was the shoulder standing behind the
/// member.
pub const REVEAL_WINDOW_MS: i64 = 30_000;

/// The AAD of the at-rest wrap: the vault and the generation.
///
/// Binding the generation in is what makes a wrapped blob from before a
/// rotation fail to open under the new one's id rather than yielding a key
/// that opens nothing.
#[must_use]
pub fn wrap_aad(vault_id: &str, key_id: &str) -> String {
    format!("{vault_id}‖{key_id}")
}

const SALT_BYTES: usize = 16;
const NONCE_BYTES: usize = 12;
const TAG_BYTES: usize = 16;
const MEMBER_KEY_BYTES: usize = 32;

/// Distinguishable, because "wrong passphrase" and "corrupt" are not the same
/// screen (v0's `LockerUnlockError`).
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum UnlockError {
    #[error("that passphrase does not open this Locker")]
    WrongPassphrase,
    #[error("this Locker session has ended — unlock again to reveal a secret")]
    Locked,
    #[error(
        "this device has no member key yet — another seat can send one, or the recovery kit carries it"
    )]
    NotEnrolled,
    #[error("a Locker passphrase is at least {PASSPHRASE_MINIMUM} characters")]
    TooShort,
    #[error("the wrapped key at rest is not readable: {0}")]
    Corrupt(&'static str),
    #[error("a member key is {0} bytes, expected {MEMBER_KEY_BYTES}")]
    KeyLength(usize),
}

fn wrapping_key(passphrase: &str, salt: &[u8], iterations: u32) -> Aes256Gcm {
    let mut derived = [0_u8; 32];
    // `pbkdf2_hmac` cannot fail for a non-zero iteration count and a 32-byte
    // output, which is why there is no error arm here.
    pbkdf2::pbkdf2_hmac::<sha2::Sha256>(passphrase.as_bytes(), salt, iterations, &mut derived);
    Aes256Gcm::new_from_slice(&derived).expect("a 32-byte AES-256 key")
}

/// Wrap `K` under a passphrase. The result is the only thing written down.
pub fn wrap_member_key(
    passphrase: &str,
    vault_id: &str,
    key_id: &str,
    key: &[u8],
) -> Result<WrappedKey, UnlockError> {
    if passphrase.chars().count() < PASSPHRASE_MINIMUM {
        return Err(UnlockError::TooShort);
    }
    if key.len() != MEMBER_KEY_BYTES {
        return Err(UnlockError::KeyLength(key.len()));
    }
    let salt = random_bytes::<SALT_BYTES>();
    let nonce = random_bytes::<NONCE_BYTES>();
    let aad = wrap_aad(vault_id, key_id);
    let sealed = wrapping_key(passphrase, &salt, WRAP_ITERATIONS)
        .encrypt(
            (&nonce).into(),
            Payload {
                msg: key,
                aad: aad.as_bytes(),
            },
        )
        .map_err(|_| UnlockError::Corrupt("the wrap did not complete"))?;
    Ok(WrappedKey {
        version: 1,
        vault_id: vault_id.to_owned(),
        key_id: key_id.to_owned(),
        kdf: "pbkdf2-sha256".to_owned(),
        iterations: WRAP_ITERATIONS,
        salt: STANDARD.encode(salt),
        nonce: STANDARD.encode(nonce),
        ciphertext: STANDARD.encode(sealed),
    })
}

/// Unwrap `K`.
pub fn unwrap_member_key(passphrase: &str, wrapped: &WrappedKey) -> Result<Vec<u8>, UnlockError> {
    if wrapped.version != 1 {
        return Err(UnlockError::Corrupt("an unknown wrap version"));
    }
    if wrapped.kdf != "pbkdf2-sha256" {
        return Err(UnlockError::Corrupt("an unknown key-derivation function"));
    }
    if wrapped.iterations == 0 {
        // A ZERO ITERATION COUNT IS A DOWNGRADE, not a fast unlock: the blob
        // says how it was derived, so a blob that says "no work" would let an
        // attacker who can rewrite it make the derivation free.
        return Err(UnlockError::Corrupt("a zero iteration count"));
    }
    let salt = STANDARD
        .decode(&wrapped.salt)
        .map_err(|_| UnlockError::Corrupt("the salt is not base64"))?;
    let nonce = STANDARD
        .decode(&wrapped.nonce)
        .map_err(|_| UnlockError::Corrupt("the nonce is not base64"))?;
    let sealed = STANDARD
        .decode(&wrapped.ciphertext)
        .map_err(|_| UnlockError::Corrupt("the ciphertext is not base64"))?;
    if nonce.len() != NONCE_BYTES || sealed.len() < TAG_BYTES + MEMBER_KEY_BYTES {
        return Err(UnlockError::Corrupt("the wrapped blob is truncated"));
    }
    let nonce: [u8; NONCE_BYTES] = nonce.try_into().expect("checked length");
    let aad = wrap_aad(&wrapped.vault_id, &wrapped.key_id);
    let key = wrapping_key(passphrase, &salt, wrapped.iterations)
        .decrypt(
            (&nonce).into(),
            Payload {
                msg: &sealed,
                aad: aad.as_bytes(),
            },
        )
        // The ONLY verifier. A wrong passphrase and a tampered blob are one
        // answer on purpose: telling them apart would be an oracle.
        .map_err(|_| UnlockError::WrongPassphrase)?;
    if key.len() != MEMBER_KEY_BYTES {
        return Err(UnlockError::KeyLength(key.len()));
    }
    Ok(key)
}

fn random_bytes<const N: usize>() -> [u8; N] {
    use rand::RngCore as _;
    let mut bytes = [0_u8; N];
    rand::rng().fill_bytes(&mut bytes);
    bytes
}

/// THE ADDRESS OF A SECRET — `{entity, entity_id, column}`, never a value.
///
/// v0's `SidecarTarget`, and its rule: *an address the item pane resolves out
/// of detail it already holds.* A **revision is not one of these**: the
/// password an item was rotated away from rides a `core_entity_revision`
/// snapshot, which no reveal opens and only a confirmed `locker.export`
/// unseals.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct RevealTarget {
    pub entity: String,
    pub entity_id: String,
    pub column: String,
}

impl RevealTarget {
    #[must_use]
    pub fn new(entity: &str, entity_id: &str, column: &str) -> Self {
        Self {
            entity: entity.to_owned(),
            entity_id: entity_id.to_owned(),
            column: column.to_owned(),
        }
    }
}

/// ONE ROW'S PLAINTEXT, WITH A LIFE.
///
/// Deliberately **not** `Clone` and **not** `Debug`: a cloned secret is a
/// second copy nothing clears, and a `Debug` secret is a secret in a log line.
/// [`Drop`] zeroes the bytes, which is not a promise about a garbage collector
/// — it is the one thing this process can actually do.
pub struct Reveal {
    pub target: RevealTarget,
    /// The plaintext as BYTES, so [`Drop`] can overwrite them. A `String`
    /// cannot be zeroed without `unsafe`, and this crate forbids it — which is
    /// the right constraint and the reason the field is not a `String`. UTF-8
    /// is validated once, at construction.
    value: Vec<u8>,
    /// The `access.receipt` row the gateway wrote. A reveal with no receipt is
    /// what the whole plane exists to prevent, so this field is not optional.
    pub receipt_id: String,
    expires_at_ms: i64,
}

impl Reveal {
    /// The plaintext, while the window is open. **Checks the clock**, like
    /// [`Session::key`] and for the same reason.
    pub fn value(&self, now_ms: i64) -> Result<&str, RevealRefusal> {
        if now_ms >= self.expires_at_ms {
            return Err(RevealRefusal::Expired);
        }
        std::str::from_utf8(&self.value).map_err(|_| RevealRefusal::DidNotOpen)
    }

    /// When the shell must drop it.
    #[must_use]
    pub const fn expires_at_ms(&self) -> i64 {
        self.expires_at_ms
    }
}

impl Drop for Reveal {
    fn drop(&mut self) {
        // A dropped allocation is not a promise that the allocator forgot what
        // was in it. Overwriting is the one thing this process can do about
        // that, and it needs no `unsafe` over a `Vec<u8>`.
        self.value.fill(0);
    }
}

/// WHY A REVEAL DID NOT HAPPEN. Each of these is a different screen.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum RevealRefusal {
    /// **The typed refusal, never a prompt.** The shell renders the Lock
    /// surface; a door that could raise the passphrase prompt is a door that
    /// can be used to phish it.
    #[error("this Locker is locked — unlock it in Centraid to reveal a secret")]
    Locked,
    /// The thirty seconds ran out. A member asks again.
    #[error("that reveal has expired — ask again")]
    Expired,
    /// The address names a column that is not sealed, so there is nothing to
    /// reveal and asking is a bug in the caller.
    #[error("`{column}` is not a sealed Locker cell")]
    NotSealed { column: String },
    /// The cell is empty. "No password" and "a password I cannot open" are
    /// different answers.
    #[error("that cell holds no secret")]
    Empty,
    /// The cell was sealed under a generation this seat does not hold.
    #[error(
        "that secret was sealed under a member key generation this device does not hold ({key_id}) — another seat can send it, or the recovery kit carries it"
    )]
    StaleGeneration { key_id: String },
    /// The ciphertext did not authenticate: a wrong row, a wrong generation,
    /// or tampering. One answer, on purpose.
    #[error("that secret did not open — the stored value may have been altered")]
    DidNotOpen,
    /// The gateway did not write the receipt, so there is no reveal.
    ///
    /// **The order is the point** (D-1020-L3): the receipt is written FIRST
    /// and the plaintext is produced only if it landed. A reveal that happened
    /// and was not recorded is exactly what the audit plane exists to make
    /// impossible.
    #[error("the reveal could not be receipted, so it did not happen: {reason}")]
    NotReceipted { reason: String },
}

/// The sealed cells, by entity — the seat's copy of the vault's registry.
///
/// Restated here rather than imported so this crate does not depend on the
/// command catalogue; `the_sealed_registry_matches_the_vaults` asserts the two
/// are one list.
pub const SEALED_CELLS: [(&str, &[&str]); 3] = [
    (
        "locker.item",
        &["password", "otp_seed", "card_number", "cvv", "content"],
    ),
    ("locker.item_field", &["value_sealed"]),
    ("locker.item_passkey", &["private_key"]),
];

/// Is this address a cell that holds a secret?
#[must_use]
pub fn is_sealed_cell(entity: &str, column: &str) -> bool {
    SEALED_CELLS
        .iter()
        .any(|(known, columns)| *known == entity && columns.contains(&column))
}

/// What a reveal needs from the vault: the ciphertext and its generation.
///
/// A **trait** rather than a connection, because this crate must be usable by
/// a thin seat that forwards the read as well as by a replicated one that
/// answers it locally — and because a test can hand it a row without a file.
pub trait SealedCells {
    /// `(ciphertext, key_id)` for one address, or `None` when the cell is
    /// empty. `key_id` is `None` on a row written before the key plane existed.
    fn cell(
        &self,
        target: &RevealTarget,
    ) -> Result<Option<(String, Option<String>)>, RevealRefusal>;
}

/// What writes the receipt. The gateway does; a seat cannot receipt itself.
pub trait Receipts {
    /// Write the `access.receipt` row and return its id, or say why not.
    ///
    /// `columns` are names, never values. `origin` rides a fill only.
    fn reveal(
        &self,
        target: &RevealTarget,
        kind: &str,
        origin: Option<&str>,
    ) -> Result<String, String>;
}

/// THE SEAT'S REVEAL DOOR.
///
/// Holds the session, the cells and the receipt writer — and nothing else,
/// because everything a reveal needs is one of those three.
pub struct Unlock<'a> {
    pub session: &'a Session,
    pub cells: &'a dyn SealedCells,
    pub receipts: &'a dyn Receipts,
}

impl Unlock<'_> {
    /// Reveal one cell, receipt first.
    ///
    /// The order, and why: **the receipt is written before the plaintext
    /// exists.** If the receipt fails the reveal fails, so there is no path on
    /// which a secret was produced and not recorded. The cost is that an
    /// offline seat cannot reveal — which is exactly what `online_only` on the
    /// reveal commands already says, and is why `access` is the one Locker
    /// query that is online-only by construction.
    pub fn reveal(
        &self,
        target: &RevealTarget,
        now_ms: i64,
        kind: &str,
        origin: Option<&str>,
    ) -> Result<Reveal, RevealRefusal> {
        if !is_sealed_cell(&target.entity, &target.column) {
            return Err(RevealRefusal::NotSealed {
                column: target.column.clone(),
            });
        }
        // LOCKED REFUSES AND DOES NOT PROMPT.
        let (key_id, key) = self
            .session
            .key(now_ms)
            .map_err(|_| RevealRefusal::Locked)?;
        let Some((ciphertext, cell_key_id)) = self.cells.cell(target)? else {
            return Err(RevealRefusal::Empty);
        };
        // A cell sealed under a generation this session does not hold cannot be
        // opened, and saying which generation it wants is what lets a member
        // fix it.
        if let Some(cell_key_id) = cell_key_id.as_deref()
            && cell_key_id != key_id.as_str()
        {
            return Err(RevealRefusal::StaleGeneration {
                key_id: cell_key_id.to_owned(),
            });
        }
        let receipt_id = self
            .receipts
            .reveal(target, kind, origin)
            .map_err(|reason| RevealRefusal::NotReceipted { reason })?;
        let value = centraid_vault::custody::locker_key::decrypt_under_locker_key(
            &key,
            &key_id,
            &target.entity_id,
            &ciphertext,
        )
        .map_err(|_| RevealRefusal::DidNotOpen)?;
        Ok(Reveal {
            target: target.clone(),
            value: value.into_bytes(),
            receipt_id,
            expires_at_ms: now_ms + REVEAL_WINDOW_MS,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    fn key() -> Vec<u8> {
        vec![9_u8; MEMBER_KEY_BYTES]
    }

    struct OneCell {
        target: RevealTarget,
        ciphertext: String,
        key_id: Option<String>,
    }

    impl SealedCells for OneCell {
        fn cell(
            &self,
            target: &RevealTarget,
        ) -> Result<Option<(String, Option<String>)>, RevealRefusal> {
            if *target == self.target {
                Ok(Some((self.ciphertext.clone(), self.key_id.clone())))
            } else {
                Ok(None)
            }
        }
    }

    struct Written {
        rows: RefCell<Vec<(RevealTarget, String, Option<String>)>>,
        fails: bool,
    }

    impl Receipts for Written {
        fn reveal(
            &self,
            target: &RevealTarget,
            kind: &str,
            origin: Option<&str>,
        ) -> Result<String, String> {
            if self.fails {
                return Err("the gateway is not reachable".to_owned());
            }
            self.rows.borrow_mut().push((
                target.clone(),
                kind.to_owned(),
                origin.map(str::to_owned),
            ));
            Ok(format!("receipt-{}", self.rows.borrow().len()))
        }
    }

    /// A refusal, without asking [`Reveal`] to be `Debug` — see
    /// `fill.rs`'s twin for why the type is not.
    fn refusal<T>(result: Result<T, RevealRefusal>) -> RevealRefusal {
        match result {
            Ok(_) => panic!("the reveal was expected to be refused and was not"),
            Err(refusal) => refusal,
        }
    }

    fn written() -> Written {
        Written {
            rows: RefCell::new(Vec::new()),
            fails: false,
        }
    }

    #[test]
    fn a_wrap_round_trips_and_a_wrong_passphrase_is_one_answer() {
        let wrapped = wrap_member_key("a passphrase long enough", "vault-1", "key-1", &key())
            .expect("wrapped");
        assert_eq!(wrapped.iterations, WRAP_ITERATIONS);
        assert_eq!(wrapped.kdf, "pbkdf2-sha256");
        // THE BLOB CARRIES NO KEY AND NO VERIFIER.
        let json = serde_json::to_string(&wrapped).expect("serialises");
        assert!(!json.contains("verifier"));
        assert_eq!(
            unwrap_member_key("a passphrase long enough", &wrapped).expect("unwrapped"),
            key()
        );
        assert_eq!(
            unwrap_member_key("a different passphrase", &wrapped),
            Err(UnlockError::WrongPassphrase)
        );
    }

    /// A short passphrase is refused where it is CHOSEN, not where it is used.
    #[test]
    fn a_passphrase_under_the_floor_is_refused_at_the_wrap() {
        assert_eq!(
            wrap_member_key("short", "vault-1", "key-1", &key()),
            Err(UnlockError::TooShort)
        );
        // Exactly at the floor is fine, and the floor counts CHARACTERS rather
        // than bytes — twelve accented letters is a twelve-character
        // passphrase.
        assert!(wrap_member_key("123456789012", "vault-1", "key-1", &key()).is_ok());
        assert!(wrap_member_key("ééééééééééé", "vault-1", "key-1", &key()).is_err());
        assert!(wrap_member_key("éééééééééééé", "vault-1", "key-1", &key()).is_ok());
    }

    /// THE GENERATION IS IN THE AAD: a blob relabelled to another generation
    /// does not open, so a stale wrap cannot yield a key that opens nothing.
    #[test]
    fn a_relabelled_wrap_does_not_open() {
        let wrapped = wrap_member_key("a passphrase long enough", "vault-1", "key-1", &key())
            .expect("wrapped");
        let relabelled = WrappedKey {
            key_id: "key-2".to_owned(),
            ..wrapped.clone()
        };
        assert_eq!(
            unwrap_member_key("a passphrase long enough", &relabelled),
            Err(UnlockError::WrongPassphrase)
        );
        let moved = WrappedKey {
            vault_id: "vault-2".to_owned(),
            ..wrapped
        };
        assert_eq!(
            unwrap_member_key("a passphrase long enough", &moved),
            Err(UnlockError::WrongPassphrase)
        );
    }

    /// A ZERO ITERATION COUNT IS A DOWNGRADE, not a fast unlock.
    #[test]
    fn a_rewritten_blob_cannot_make_the_derivation_free() {
        let wrapped = wrap_member_key("a passphrase long enough", "vault-1", "key-1", &key())
            .expect("wrapped");
        let free = WrappedKey {
            iterations: 0,
            ..wrapped.clone()
        };
        assert!(matches!(
            unwrap_member_key("a passphrase long enough", &free),
            Err(UnlockError::Corrupt(_))
        ));
        let unknown_kdf = WrappedKey {
            kdf: "md5".to_owned(),
            ..wrapped
        };
        assert!(matches!(
            unwrap_member_key("a passphrase long enough", &unknown_kdf),
            Err(UnlockError::Corrupt(_))
        ));
    }

    /// THE WHOLE REVEAL, and the receipt that comes first.
    #[test]
    fn a_reveal_is_receipted_before_the_plaintext_exists() {
        let target = RevealTarget::new("locker.item", "item-1", "password");
        let ciphertext = centraid_vault::custody::locker_key::encrypt_under_locker_key(
            &key(),
            "key-1",
            "item-1",
            "hunter2-and-more",
        )
        .expect("sealed");
        let cells = OneCell {
            target: target.clone(),
            ciphertext,
            key_id: Some("key-1".to_owned()),
        };
        let receipts = written();
        let session = Session::unlocked_for_test("vault-1", "key-1", key(), 0);
        let unlock = Unlock {
            session: &session,
            cells: &cells,
            receipts: &receipts,
        };

        let reveal = unlock
            .reveal(&target, 1_000, "reveal", None)
            .expect("revealed");
        assert_eq!(reveal.value(1_000).expect("in window"), "hunter2-and-more");
        assert_eq!(reveal.receipt_id, "receipt-1");
        assert_eq!(receipts.rows.borrow().len(), 1);
        assert_eq!(receipts.rows.borrow()[0].1, "reveal");

        // THE WINDOW IS THIRTY SECONDS AND IT IS CHECKED, not scheduled.
        assert_eq!(reveal.expires_at_ms(), 1_000 + REVEAL_WINDOW_MS);
        assert!(reveal.value(1_000 + REVEAL_WINDOW_MS - 1).is_ok());
        assert_eq!(
            reveal.value(1_000 + REVEAL_WINDOW_MS),
            Err(RevealRefusal::Expired)
        );
    }

    /// A LOCKED REVEAL REFUSES AND DOES NOT PROMPT, and no receipt is
    /// written — because nothing was revealed.
    #[test]
    fn a_locked_reveal_refuses_without_a_receipt() {
        let target = RevealTarget::new("locker.item", "item-1", "password");
        let cells = OneCell {
            target: target.clone(),
            ciphertext: "lk1:whatever".to_owned(),
            key_id: Some("key-1".to_owned()),
        };
        let receipts = written();
        let session = Session::locked("vault-1");
        let unlock = Unlock {
            session: &session,
            cells: &cells,
            receipts: &receipts,
        };
        assert_eq!(
            refusal(unlock.reveal(&target, 0, "reveal", None)),
            RevealRefusal::Locked
        );
        assert!(receipts.rows.borrow().is_empty());
    }

    /// AN UNRECEIPTED REVEAL DID NOT HAPPEN. The plaintext is never produced.
    #[test]
    fn a_reveal_the_gateway_could_not_receipt_produces_nothing() {
        let target = RevealTarget::new("locker.item", "item-1", "password");
        let ciphertext = centraid_vault::custody::locker_key::encrypt_under_locker_key(
            &key(),
            "key-1",
            "item-1",
            "hunter2-and-more",
        )
        .expect("sealed");
        let cells = OneCell {
            target: target.clone(),
            ciphertext,
            key_id: Some("key-1".to_owned()),
        };
        let receipts = Written {
            rows: RefCell::new(Vec::new()),
            fails: true,
        };
        let session = Session::unlocked_for_test("vault-1", "key-1", key(), 0);
        let unlock = Unlock {
            session: &session,
            cells: &cells,
            receipts: &receipts,
        };
        assert!(matches!(
            unlock.reveal(&target, 0, "reveal", None),
            Err(RevealRefusal::NotReceipted { .. })
        ));
    }

    /// A PLAIN COLUMN HAS NOTHING TO REVEAL, and asking is a caller bug.
    #[test]
    fn only_a_sealed_cell_can_be_revealed() {
        assert!(is_sealed_cell("locker.item", "password"));
        assert!(is_sealed_cell("locker.item_field", "value_sealed"));
        assert!(is_sealed_cell("locker.item_passkey", "private_key"));
        for column in ["title", "username", "url", "notes", "email", "network"] {
            assert!(!is_sealed_cell("locker.item", column), "{column}");
        }
        // A revision is not a reveal target at all: only a confirmed
        // `locker.export` unseals a snapshot.
        assert!(!is_sealed_cell("core.entity_revision", "snapshot_json"));
    }

    /// A CELL FROM BEFORE A ROTATION SAYS WHICH GENERATION IT WANTS.
    #[test]
    fn a_stale_generation_names_itself_rather_than_failing_to_open() {
        let target = RevealTarget::new("locker.item", "item-1", "password");
        let cells = OneCell {
            target: target.clone(),
            ciphertext: "lk1:whatever".to_owned(),
            key_id: Some("key-0".to_owned()),
        };
        let receipts = written();
        let session = Session::unlocked_for_test("vault-1", "key-1", key(), 0);
        let unlock = Unlock {
            session: &session,
            cells: &cells,
            receipts: &receipts,
        };
        assert_eq!(
            refusal(unlock.reveal(&target, 0, "reveal", None)),
            RevealRefusal::StaleGeneration {
                key_id: "key-0".to_owned()
            }
        );
        // …and nothing was receipted, because nothing was revealed.
        assert!(receipts.rows.borrow().is_empty());
    }

    /// The seat's registry and the vault's are one list.
    #[test]
    fn the_sealed_registry_matches_the_vaults() {
        let vaults = centraid_vault::custody::locker_key::LOCKER_ENCRYPTED_COLUMNS;
        assert_eq!(vaults.len(), SEALED_CELLS.len());
        for (physical, _, columns) in vaults {
            // `locker_item` ↔ `locker.item`: the vault names the table, the
            // seat names the entity, and the mapping is the one dot.
            let entity = format!("locker.{}", physical.trim_start_matches("locker_"));
            let (_, seat_columns) = SEALED_CELLS
                .iter()
                .find(|(known, _)| *known == entity)
                .unwrap_or_else(|| panic!("the seat has no registry entry for {entity}"));
            assert_eq!(seat_columns, columns, "{entity}");
        }
    }
}
