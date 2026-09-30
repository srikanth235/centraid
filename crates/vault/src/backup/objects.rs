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
//! wrapped into that object's own header**, and every object is reachable from
//! the root through exactly one wrap.
//!
//! ### What rotating that root key costs, now that it is affordable
//!
//! W3 lane B recorded that it was not: the per-chunk AAD was the WHOLE header,
//! the wrapped key included, so re-wrapping a header invalidated every body tag
//! and rotating the root meant re-sealing every object the vault had ever
//! written. W6 excluded the wrap from the chunk AAD, which costs nothing in
//! strength — a substituted wrap yields a different content key, so the body
//! already fails to open — and [`ObjectKeys::rotate_root`] is the result.
//!
//! What a rotation now touches:
//!
//! - a `base`, `segment`, `manifest` or pack item table is **re-wrapped**, its
//!   body copied verbatim. No plaintext is found, decompressed or re-sealed, and
//!   no read-back has to be verified a second time;
//! - a `blob` or `thumbnail` is **not touched at all**. Its file key lives in
//!   the vault's blob-custody row, so rotating the root re-wraps that row and
//!   leaves every photograph where it is — which is the overwhelming majority of
//!   a phone's bytes and the reason the rotation is affordable.
//!
//! The one thing a rotation does not save is the upload: an object's name is the
//! BLAKE3 of its whole bytes, header included, so a re-wrapped object is a new
//! object to the store. That is a cost in the wrapped kinds only, and B11's own
//! defect — two masters, neither rotatable — is closed either way.
//!
//! ## The vault identity key is associated data, never a key
//!
//! It is `vault_id` (§0) and it binds every object to its vault (§4). It is
//! passed here as raw bytes because `crates/media` must not depend on
//! `crates/identity`, and because a restore holds the key before it holds a
//! vault to ask.
//!
//! ## The dictionary (#1029 W13, finding 3)
//!
//! `base` and `segment` plaintext is zstd'd against a trained dictionary (§4).
//! The corpus is the vault's own baseline DDL, which is the best available
//! stand-in for "this schema's pages" and, being compiled in, needs no fixture
//! to ship. The dictionary's id is in every header, so replacing the corpus is
//! a versioned change and not a silent one.
//!
//! **A trained dictionary is not a constant, and this used to treat it as
//! one.** [`shipped_dictionary`] trains from a compiled-in corpus, and zstd's
//! trainer is not contractually stable across versions: a zstd bump or a DDL
//! edit moves the bytes, which moves the BLAKE3 id, which makes every object
//! sealed against the old id refuse to open — with no copy of the old bytes
//! kept anywhere. Three things close that:
//!
//! 1. **The dictionary an [`ObjectKeys`] seals with is a field**, not a
//!    process-wide static. A restore adopts the one it read out of the backup
//!    ([`ObjectKeys::with_dictionary`]) and opens every object of that
//!    generation against it, whatever this build's trainer would produce.
//! 2. **The bytes are persisted inside the generation manifest**
//!    (`crate::backup::manifest`), so the only object a restore must open
//!    before it holds a dictionary is the one that carries it.
//! 3. **Training failure is a refusal.** It used to `or_else` into a *different*
//!    dictionary cut out of the DDL text — a silent substitution that seals
//!    objects nothing else in the fleet can open. There is no fallback now.
//!
//! A golden vector (`crates/media/tests/object_vectors.rs`) pins the shipped
//! dictionary's id, so trainer drift is a failing test rather than a format
//! break discovered on somebody's restore.

use centraid_media::object::{
    self, Custody, Dictionary, Kind, ObjectError, Role, SealOptions, Sealed, VaultId,
};

/// A vault root key, a vault identity key and the dictionary this seals with:
/// everything sealing needs.
///
/// `None` means "whatever [`shipped_dictionary`] trains", resolved on use so
/// that [`ObjectKeys::new`] stays infallible; `Some` is a dictionary read back
/// out of a backup, which is what a restore uses.
#[derive(Clone)]
pub struct ObjectKeys {
    identity_key: [u8; object::VAULT_ID_BYTES],
    root_key: [u8; object::KEY_BYTES],
    dictionary: Option<std::sync::Arc<Dictionary>>,
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
            dictionary: None,
        }
    }

    /// Adopt the dictionary a generation was sealed against.
    ///
    /// This is what a restore calls the moment it has opened the manifest: from
    /// here on every base range and every segment of that generation opens
    /// against the bytes the backup carried, not against whatever this build's
    /// trainer would produce today (#1029 W13, finding 3).
    #[must_use]
    pub fn with_dictionary(
        identity_key: [u8; object::VAULT_ID_BYTES],
        root_key: [u8; object::KEY_BYTES],
        dictionary: Dictionary,
    ) -> Self {
        Self {
            identity_key,
            root_key,
            dictionary: Some(std::sync::Arc::new(dictionary)),
        }
    }

    /// The same keys, sealing and opening against `dictionary`.
    #[must_use]
    pub fn adopting(&self, dictionary: Dictionary) -> Self {
        Self {
            dictionary: Some(std::sync::Arc::new(dictionary)),
            ..self.clone()
        }
    }

    /// The dictionary these keys seal with.
    ///
    /// # Errors
    /// [`ObjectError::DictionaryTraining`] when no dictionary was adopted and
    /// the shipped one cannot be trained. **Never a substitute** — see the
    /// module header.
    pub fn dictionary(&self) -> Result<&Dictionary> {
        match &self.dictionary {
            Some(dictionary) => Ok(dictionary),
            None => Ok(shipped_dictionary()?),
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
        let dictionary = if kind.compresses() {
            Some(self.dictionary()?)
        } else {
            None
        };
        Ok(object::seal(
            self.vault(),
            Custody::Wrapped(&self.root_key),
            &SealOptions {
                kind,
                role,
                dictionary,
            },
            plaintext,
        )?)
    }

    /// Open one object of `kind`.
    ///
    /// # Errors
    /// [`ObjectError::Open`] for the key, the associated data or a tag.
    pub fn open(&self, kind: Kind, sealed: &[u8]) -> Result<Vec<u8>> {
        let dictionary = if kind.compresses() {
            Some(self.dictionary()?)
        } else {
            None
        };
        Ok(object::open(
            self.vault(),
            Custody::Wrapped(&self.root_key),
            sealed,
            dictionary,
        )?)
    }

    /// **Rotate the vault root key over one wrapped object** (W3 → W6).
    ///
    /// Answers the object's new bytes, whose body is the old body verbatim. See
    /// the module header for what a rotation touches and what it does not.
    ///
    /// # Errors
    /// [`ObjectError::Open`] when this is not the root the object was wrapped
    /// under, or when the object carries no wrap — a `blob` or `thumbnail`,
    /// whose file key is the vault's to re-wrap and not this format's.
    pub fn rotate_root(&self, to: &[u8; object::KEY_BYTES], sealed: &[u8]) -> Result<Vec<u8>> {
        Ok(object::rewrap(self.vault(), &self.root_key, to, sealed)?)
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
        let dictionary = if kind.compresses() {
            Some(self.dictionary()?)
        } else {
            None
        };
        object::verify_read_back(
            self.vault(),
            Custody::Wrapped(&self.root_key),
            sealed,
            &from_disk,
            dictionary,
        )
        .map_err(|_| ObjectsError::Corrupt {
            path: path.to_path_buf(),
        })
    }
}

/// **The dictionary this build ships**, trained once per process from the
/// baseline DDL.
///
/// A page of this schema is mostly its own structure — table names, column
/// names, the `core_` prefix — which is exactly what a dictionary buys on a
/// one-row edit's segment.
///
/// ## A REFUSAL, NEVER A SUBSTITUTE (#1029 W13, finding 3)
///
/// Training used to `or_else` into `Dictionary::from_bytes(BASELINE_SQL[..4096])`
/// and then `expect`. Both halves were wrong. The fallback is a *different*
/// dictionary with a different id, so a device whose trainer failed would seal
/// objects that no other device — and no later run of the same device — could
/// open, silently; and the `expect` turned a recoverable refusal into a panic
/// on the write path. A dictionary that cannot be trained is an error the
/// caller is told about.
///
/// The result is cached whichever way it went, so a refusal is stable rather
/// than intermittent: a build that cannot train cannot train.
///
/// # Errors
/// [`ObjectError::DictionaryTraining`] when zstd will not train on the
/// compiled-in corpus.
pub fn shipped_dictionary() -> std::result::Result<&'static Dictionary, ObjectError> {
    static TRAINED: std::sync::OnceLock<std::result::Result<Dictionary, ObjectError>> =
        std::sync::OnceLock::new();
    TRAINED
        .get_or_init(|| {
            let samples: Vec<&[u8]> = crate::migrations::BASELINE_SQL
                .split(";\n")
                .filter(|statement| statement.len() > 32)
                .map(str::as_bytes)
                .collect();
            Dictionary::train(&samples, 16 * 1024)
        })
        .as_ref()
        .map_err(Clone::clone)
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
        let shipped = shipped_dictionary().expect("this build can train one");
        assert_eq!(
            shipped.id(),
            shipped_dictionary().expect("cached").id(),
            "the shipped dictionary is trained once and cached"
        );
        let keys = keys();
        assert_eq!(
            keys.dictionary().expect("resolves").id(),
            shipped.id(),
            "keys that adopted nothing seal against the shipped dictionary"
        );
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

    /// The rotation W3 priced as a full re-upload: the new root opens the
    /// object, the old one does not, and the body was never re-encrypted.
    #[test]
    fn rotating_the_root_re_wraps_without_re_sealing_the_body() {
        let mine = keys();
        let plain = b"a page of core_entity rows".repeat(50);
        let sealed = mine
            .seal(Kind::Segment, Role::Whole, &plain)
            .expect("seals");

        let next = [9_u8; 32];
        let rotated = mine.rotate_root(&next, &sealed.bytes).expect("rotates");
        let rotated_keys = ObjectKeys::new([7_u8; 32], next);
        assert_eq!(
            rotated_keys.open(Kind::Segment, &rotated).expect("opens"),
            plain
        );
        assert!(mine.open(Kind::Segment, &rotated).is_err());

        // The body is the SAME ciphertext: copied, not re-sealed. Both objects
        // are the same length because a wrap is a fixed size, so the two bodies
        // start at the same offset.
        assert_eq!(rotated.len(), sealed.bytes.len());
        let body_at = centraid_media::object::header::Header::decode(&sealed.bytes)
            .expect("decodes")
            .1;
        assert_eq!(&rotated[body_at..], &sealed.bytes[body_at..]);
        assert_ne!(&rotated[..body_at], &sealed.bytes[..body_at]);
    }

    #[test]
    fn the_root_key_is_never_printed() {
        assert!(!format!("{:?}", keys()).contains("0808"));
    }
}
