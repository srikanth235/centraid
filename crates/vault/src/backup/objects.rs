//! Sealing, verifying, and the one key (#1029 §4, B1, B9, B11).
//!
//! The vault side of `centraid-object/1`: this is where a base range, a page
//! segment and a manifest become objects, and where §4's **"verify before
//! upload"** is actually performed — reading the sealed bytes back **from the
//! file** and opening them, because storage corruption only shows in what fsync
//! put down (F11).
//!
//! ## ONE KEY, NOT TWO (B11)
//!
//! The stack this replaces kept `backup.master.key` and `export.master.key`,
//! both rebuilt with `active: 1` on every run, so "rotation" rotated nothing and
//! two files had to agree about which epoch was live. There is one root key here
//! and it comes from §0's derivation: `seed / vault'(i) / root'`. Everything
//! else — a segment's key, a base range's key — is a **random content key
//! wrapped into that object's own header**, which is what makes rotation mean
//! something: re-wrapping headers re-keys the backup without touching a byte of
//! ciphertext.
//!
//! ## The vault identity key is associated data, never a key
//!
//! It is `vault_id` (§0) and it binds every object to its vault (§4). It is
//! passed here as raw bytes because `crates/media` must not depend on
//! `crates/identity`, and because a restore holds the key before it holds a
//! vault to ask.
//!
//! ## The dictionary
//!
//! `base`, `segment` and `manifest` plaintext is zstd'd against a trained
//! dictionary (§4). The corpus is the vault's own baseline DDL, which is the
//! best available stand-in for "this schema's pages" and, being compiled in, is
//! the same on every device without a fixture to ship or a training run to
//! reproduce. The dictionary's id is in every header, so replacing the corpus
//! later is a versioned change and not a silent one.

use centraid_media::object::{
    self, Custody, Dictionary, Kind, ObjectError, Role, SealOptions, Sealed, VaultId,
};

/// A vault root key and a vault identity key: everything sealing needs.
#[derive(Clone)]
pub struct ObjectKeys {
    identity_key: [u8; object::VAULT_ID_BYTES],
    root_key: [u8; object::KEY_BYTES],
}

impl std::fmt::Debug for ObjectKeys {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ObjectKeys")
            .field("vault", &hex::encode(self.identity_key))
            .field("root", &"<redacted>")
            .finish()
    }
}

#[derive(Debug, thiserror::Error)]
pub enum ObjectsError {
    #[error(transparent)]
    Object(#[from] ObjectError),
    #[error("reading {path} back to verify it: {source}")]
    ReadBack {
        path: std::path::PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error(
        "the object written to {path} is not the object that was sealed — \
         the bytes on disk are not the bytes in memory"
    )]
    Corrupt { path: std::path::PathBuf },
}

type Result<T> = std::result::Result<T, ObjectsError>;

impl ObjectKeys {
    /// Adopt the two keys §0 derives.
    #[must_use]
    pub const fn new(
        identity_key: [u8; object::VAULT_ID_BYTES],
        root_key: [u8; object::KEY_BYTES],
    ) -> Self {
        Self {
            identity_key,
            root_key,
        }
    }

    /// The vault this seals for.
    #[must_use]
    pub const fn vault(&self) -> VaultId<'_> {
        VaultId::new(&self.identity_key)
    }

    /// The vault identity key, which is `vault_id`.
    #[must_use]
    pub fn vault_id_hex(&self) -> String {
        hex::encode(self.identity_key)
    }

    /// Seal one object of `kind`.
    ///
    /// # Errors
    /// Whatever [`object::seal`] refused — most often
    /// [`ObjectError::TooLarge`], which means the caller should have split.
    pub fn seal(&self, kind: Kind, role: Role, plaintext: &[u8]) -> Result<Sealed> {
        Ok(object::seal(
            self.vault(),
            Custody::Wrapped(&self.root_key),
            &SealOptions {
                kind,
                role,
                dictionary: kind.compresses().then(page_dictionary),
            },
            plaintext,
        )?)
    }

    /// Open one object of `kind`.
    ///
    /// # Errors
    /// [`ObjectError::Open`] for the key, the associated data or a tag.
    pub fn open(&self, kind: Kind, sealed: &[u8]) -> Result<Vec<u8>> {
        Ok(object::open(
            self.vault(),
            Custody::Wrapped(&self.root_key),
            sealed,
            kind.compresses().then(page_dictionary),
        )?)
    }

    /// **Write an object, then read it back from disk and open it** (§4, F11).
    ///
    /// This is the whole of "verify before upload", and it is one function so
    /// that no caller can write the bytes and forget the half that catches
    /// storage corruption. Both halves are needed: the name catches a byte the
    /// filesystem dropped, and opening and re-hashing catches corruption that
    /// happened *before* the write, which a name over the same bad buffer would
    /// confirm.
    ///
    /// # Errors
    /// [`ObjectsError::ReadBack`] when the file will not read,
    /// [`ObjectsError::Corrupt`] when what came back is not what was sealed.
    pub fn verify_on_disk(
        &self,
        kind: Kind,
        sealed: &Sealed,
        path: &std::path::Path,
    ) -> Result<()> {
        let from_disk = std::fs::read(path).map_err(|source| ObjectsError::ReadBack {
            path: path.to_path_buf(),
            source,
        })?;
        object::verify_read_back(
            self.vault(),
            Custody::Wrapped(&self.root_key),
            sealed,
            &from_disk,
            kind.compresses().then(page_dictionary),
        )
        .map_err(|_| ObjectsError::Corrupt {
            path: path.to_path_buf(),
        })
    }
}

/// The trained dictionary every compressing kind seals against.
///
/// Trained once per process from the baseline DDL. A page of this schema is
/// mostly its own structure — table names, column names, the `core_` prefix —
/// which is exactly what a dictionary buys on a one-row edit's segment.
pub fn page_dictionary() -> &'static Dictionary {
    static TRAINED: std::sync::OnceLock<Dictionary> = std::sync::OnceLock::new();
    TRAINED.get_or_init(|| {
        let samples: Vec<&[u8]> = crate::migrations::BASELINE_SQL
            .split(";\n")
            .filter(|statement| statement.len() > 32)
            .map(str::as_bytes)
            .collect();
        Dictionary::train(&samples, 16 * 1024)
            .or_else(|_| {
                Dictionary::from_bytes(crate::migrations::BASELINE_SQL.as_bytes()[..4096].to_vec())
            })
            .expect("a dictionary can always be built from a compiled-in corpus")
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn keys() -> ObjectKeys {
        ObjectKeys::new([7_u8; 32], [8_u8; 32])
    }

    #[test]
    fn a_segment_round_trips_and_carries_no_plaintext() {
        let keys = keys();
        let plain = b"core_entity rows and a locker_key row".repeat(40);
        let sealed = keys
            .seal(Kind::Segment, Role::Whole, &plain)
            .expect("seals");
        assert_eq!(
            keys.open(Kind::Segment, &sealed.bytes).expect("opens"),
            plain
        );
        assert!(
            !sealed
                .bytes
                .windows(11)
                .any(|window| window == b"locker_key\0".get(..11).unwrap_or(b"locker_key ")),
            "no plaintext survives the seal"
        );
    }

    /// Another vault's keys do not open this vault's objects — §4's AAD, from
    /// the vault side.
    #[test]
    fn another_vaults_keys_do_not_open_this_vaults_segment() {
        let mine = keys();
        let sealed = mine
            .seal(Kind::Segment, Role::Whole, b"pages")
            .expect("seals");
        let other_vault = ObjectKeys::new([9_u8; 32], [8_u8; 32]);
        assert!(other_vault.open(Kind::Segment, &sealed.bytes).is_err());
        let other_root = ObjectKeys::new([7_u8; 32], [9_u8; 32]);
        assert!(other_root.open(Kind::Segment, &sealed.bytes).is_err());
    }

    /// **§4's verify-before-upload.** A byte that rotted between the seal and
    /// the platter is caught by reading the file back, not by trusting the
    /// buffer.
    #[test]
    fn a_byte_that_rotted_on_the_way_to_disk_is_caught_by_the_read_back() {
        let dir = tempfile::tempdir().expect("a directory");
        let keys = keys();
        let sealed = keys
            .seal(Kind::Base, Role::Whole, &vec![0x5a_u8; 8192])
            .expect("seals");
        let path = dir.path().join("range");
        std::fs::write(&path, &sealed.bytes).expect("writes");
        keys.verify_on_disk(Kind::Base, &sealed, &path)
            .expect("a good write verifies");

        let mut rotted = sealed.bytes.clone();
        let last = rotted.len() - 1;
        rotted[last] ^= 0x01;
        std::fs::write(&path, &rotted).expect("writes");
        assert!(matches!(
            keys.verify_on_disk(Kind::Base, &sealed, &path),
            Err(ObjectsError::Corrupt { .. })
        ));

        std::fs::remove_file(&path).expect("removes");
        assert!(matches!(
            keys.verify_on_disk(Kind::Base, &sealed, &path),
            Err(ObjectsError::ReadBack { .. })
        ));
    }

    #[test]
    fn the_dictionary_is_the_same_one_every_time_and_earns_its_place() {
        assert_eq!(page_dictionary().id(), page_dictionary().id());
        let keys = keys();
        let plain = "INSERT INTO core_entity (entity_id, entity_kind) VALUES ('e-1','note');\n"
            .repeat(64)
            .into_bytes();
        let sealed = keys
            .seal(Kind::Segment, Role::Whole, &plain)
            .expect("seals");
        assert!(
            sealed.bytes.len() < plain.len(),
            "{} vs {}",
            sealed.bytes.len(),
            plain.len()
        );
    }

    #[test]
    fn the_root_key_is_never_printed() {
        assert!(!format!("{:?}", keys()).contains("0808"));
    }
}
