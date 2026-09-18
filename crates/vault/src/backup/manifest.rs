//! The generation manifest: a chain of small write-once objects (#1029 §2, B12).
//!
//! ## What a manifest is now
//!
//! §2: "Each generation has a manifest, sealed and hash-chained as today, which
//! is worth keeping. It carries the vault id in the envelope (fixes B12); the
//! base's chunk list; segment `txid` ranges; the **row census** at every entry,
//! from the running counters above, so restore verifies after applying segments
//! and not only at a base boundary."
//!
//! It is a `centraid-object/1` object of [`Kind::Manifest`] — the same format as
//! everything else (§4), so there is one reader, one padding rule and one
//! nonce discipline. Its **name is the BLAKE3 of its own ciphertext**, and that
//! name is what the next manifest's `prevManifest` points at, so the chain is
//! hash-linked by construction: a gateway cannot forge a link without producing
//! ciphertext that hashes to a name it does not control.
//!
//! ## B12, and why binding beats a field
//!
//! B12 is two defects. "Generation discovery JSON-parses **every** blob" is
//! fixed by [`ManifestHead`]: the head is written down, and a chain is walked
//! backwards from it by name. Nothing opens a blob to ask what it is.
//!
//! "The envelope has no vault id, so 'newest' can belong to another vault" is
//! fixed harder than the defect asks. A manifest names its vault in the clear
//! **and** §4 binds the vault identity key into the AAD of every chunk, so a
//! manifest from another vault does not merely look wrong — it does not open.
//! An attacker who edits the field gets a tag failure, not a wrong restore.
//!
//! ## What is gone
//!
//! The v0-derived manifest seal, with its JSON envelope and base64
//! `sealedPayload`. Its nonce was derived from the vault id and the generation
//! number, and B8's forking counters meant one address named two payloads —
//! B9's nonce reuse, by the second of its two roads.

use serde_json::{Value, json};

use centraid_media::object::{Kind, Role};

use crate::backup::base::{BaseHead, BaseRange};
use crate::backup::objects::{ObjectKeys, ObjectsError};
use crate::backup::segment::{GenerationId, SegmentError};

/// The manifest format's name, written into every manifest.
pub const MANIFEST_FORMAT: &str = "centraid-generation/1";

#[derive(Debug, thiserror::Error)]
pub enum ManifestError {
    #[error("manifest: {0}")]
    Format(String),
    #[error(transparent)]
    Objects(#[from] ObjectsError),
    #[error(transparent)]
    Segment(#[from] SegmentError),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error("manifest io at {path}: {source}")]
    Io {
        path: std::path::PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("the manifest chain breaks at {0}, which nothing provides")]
    ChainGap(String),
}

type Result<T> = std::result::Result<T, ManifestError>;

fn invalid(reason: &str) -> ManifestError {
    ManifestError::Format(reason.to_owned())
}

/// One segment, as a manifest lists it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SegmentRef {
    /// The object's name: the BLAKE3 of its ciphertext.
    pub object: String,
    pub first_txid: u64,
    pub last_txid: u64,
    pub bytes: u64,
    /// The row census as of `last_txid`. **At every entry, not only at a base
    /// boundary** (§2) — this is what a restore verifies against after applying
    /// the segment, and it is F4's phone-side shrink warning.
    pub census: Vec<(String, i64)>,
}

/// One generation, as its manifest describes it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GenerationManifest {
    /// The vault identity key, hex. §0 makes it the `vault_id` (B12).
    pub vault_id: String,
    pub generation: GenerationId,
    pub created_at: String,
    /// The previous manifest's **object name**, which is a hash of its
    /// ciphertext — so the chain is hash-linked.
    pub prev_manifest: Option<String>,
    /// The base's ranges, in order: `(object, offset, length)` per range, which
    /// is §4's "the vault is the index" written into the manifest too, so a
    /// fresh phone with no vault can still restore.
    pub base: Vec<BaseRange>,
    pub base_txid: u64,
    pub base_plaintext_hash: String,
    pub base_file_bytes: u64,
    pub base_census: Vec<(String, i64)>,
    pub segments: Vec<SegmentRef>,
}

fn census_json(census: &[(String, i64)]) -> Value {
    Value::Object(
        census
            .iter()
            .map(|(table, rows)| (table.clone(), json!(rows)))
            .collect(),
    )
}

fn census_from(value: Option<&Value>) -> Vec<(String, i64)> {
    let mut census: Vec<(String, i64)> = value
        .and_then(Value::as_object)
        .map(|map| {
            map.iter()
                .filter_map(|(table, rows)| Some((table.clone(), rows.as_i64()?)))
                .collect()
        })
        .unwrap_or_default();
    census.sort();
    census
}

impl GenerationManifest {
    /// Build a manifest for a generation.
    #[must_use]
    pub fn of(
        head: &BaseHead,
        created_at: String,
        prev_manifest: Option<String>,
        base_census: Vec<(String, i64)>,
        segments: Vec<SegmentRef>,
    ) -> Self {
        Self {
            vault_id: head.vault_id.clone(),
            generation: head.generation,
            created_at,
            prev_manifest,
            base: head.ranges.clone(),
            base_txid: head.txid,
            base_plaintext_hash: head.plaintext_hash.clone(),
            base_file_bytes: head.file_bytes,
            base_census,
            segments,
        }
    }

    /// The last txid this generation covers.
    #[must_use]
    pub fn last_txid(&self) -> u64 {
        self.segments
            .last()
            .map_or(self.base_txid, |segment| segment.last_txid)
    }

    /// The census as of `last_txid`: the segments' if there are any, the base's
    /// otherwise.
    #[must_use]
    pub fn census_at_head(&self) -> &[(String, i64)] {
        self.segments
            .last()
            .map_or(&self.base_census, |segment| &segment.census)
    }

    fn to_json(&self) -> Value {
        json!({
            "format": MANIFEST_FORMAT,
            "vaultId": self.vault_id,
            "generation": self.generation.hex(),
            "createdAt": self.created_at,
            "prevManifest": self.prev_manifest,
            "base": {
                "txid": self.base_txid,
                "plaintextHash": self.base_plaintext_hash,
                "fileBytes": self.base_file_bytes,
                "census": census_json(&self.base_census),
                "ranges": self.base.iter().map(|range| json!({
                    "index": range.index,
                    "object": range.object_name,
                    "offset": range.offset,
                    "length": range.length,
                    "plaintextHash": range.plaintext_hash,
                    "objectBytes": range.object_bytes,
                })).collect::<Vec<_>>(),
            },
            "segments": self.segments.iter().map(|segment| json!({
                "object": segment.object,
                "firstTxid": segment.first_txid,
                "lastTxid": segment.last_txid,
                "bytes": segment.bytes,
                "census": census_json(&segment.census),
            })).collect::<Vec<_>>(),
        })
    }

    fn from_json(value: &Value) -> Result<Self> {
        if value.get("format").and_then(Value::as_str) != Some(MANIFEST_FORMAT) {
            return Err(invalid("the format line is not this build's"));
        }
        let text = |key: &str| -> Result<String> {
            value
                .get(key)
                .and_then(Value::as_str)
                .map(str::to_owned)
                .ok_or_else(|| invalid(&format!("manifest has no {key}")))
        };
        let base = value
            .get("base")
            .ok_or_else(|| invalid("manifest has no base"))?;
        let ranges = base
            .get("ranges")
            .and_then(Value::as_array)
            .ok_or_else(|| invalid("the base names no ranges"))?
            .iter()
            .map(|range| {
                Ok(BaseRange {
                    index: u32::try_from(
                        range
                            .get("index")
                            .and_then(Value::as_u64)
                            .ok_or_else(|| invalid("a range has no index"))?,
                    )
                    .map_err(|_| invalid("a range index is out of range"))?,
                    offset: range.get("offset").and_then(Value::as_u64).unwrap_or(0),
                    length: range.get("length").and_then(Value::as_u64).unwrap_or(0),
                    plaintext_hash: range
                        .get("plaintextHash")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_owned(),
                    object_name: range
                        .get("object")
                        .and_then(Value::as_str)
                        .ok_or_else(|| invalid("a range names no object"))?
                        .to_owned(),
                    object_bytes: range
                        .get("objectBytes")
                        .and_then(Value::as_u64)
                        .unwrap_or(0),
                    // A manifest records what a generation IS, not how it was
                    // built. "Reused" is a fact about the upload, not about the
                    // range, and a restore has no use for it.
                    reused: false,
                })
            })
            .collect::<Result<Vec<_>>>()?;
        let segments = value
            .get("segments")
            .and_then(Value::as_array)
            .unwrap_or(&Vec::new())
            .iter()
            .map(|segment| {
                Ok(SegmentRef {
                    object: segment
                        .get("object")
                        .and_then(Value::as_str)
                        .ok_or_else(|| invalid("a segment names no object"))?
                        .to_owned(),
                    first_txid: segment
                        .get("firstTxid")
                        .and_then(Value::as_u64)
                        .unwrap_or(0),
                    last_txid: segment.get("lastTxid").and_then(Value::as_u64).unwrap_or(0),
                    bytes: segment.get("bytes").and_then(Value::as_u64).unwrap_or(0),
                    census: census_from(segment.get("census")),
                })
            })
            .collect::<Result<Vec<_>>>()?;
        Ok(Self {
            vault_id: text("vaultId")?,
            generation: GenerationId::from_hex(&text("generation")?)?,
            created_at: text("createdAt")?,
            prev_manifest: value
                .get("prevManifest")
                .and_then(Value::as_str)
                .map(str::to_owned),
            base: ranges,
            base_txid: base.get("txid").and_then(Value::as_u64).unwrap_or(0),
            base_plaintext_hash: base
                .get("plaintextHash")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
            base_file_bytes: base.get("fileBytes").and_then(Value::as_u64).unwrap_or(0),
            base_census: census_from(base.get("census")),
            segments,
        })
    }

    /// Seal this manifest. The name is the BLAKE3 of the ciphertext, and it is
    /// what the next manifest chains to.
    ///
    /// # Errors
    /// Whatever sealing refused.
    pub fn seal(&self, keys: &ObjectKeys) -> Result<(Vec<u8>, String)> {
        let plain = crate::intents::canonical_json(&self.to_json())
            .map_err(|error| invalid(&error.to_string()))?;
        let sealed = keys.seal(Kind::Manifest, Role::Whole, plain.as_bytes())?;
        Ok((sealed.bytes, sealed.name.hex()))
    }

    /// Open a sealed manifest.
    ///
    /// **A manifest from another vault does not open**: §4 binds the vault
    /// identity key into every chunk's AAD, so this is a tag failure, not a
    /// field comparison (B12).
    ///
    /// # Errors
    /// [`ManifestError::Objects`] when the bytes are not this vault's manifest.
    pub fn open(keys: &ObjectKeys, sealed: &[u8]) -> Result<Self> {
        let plain = keys.open(Kind::Manifest, sealed)?;
        let value: Value = serde_json::from_slice(&plain)?;
        let manifest = Self::from_json(&value)?;
        if manifest.vault_id != keys.vault_id_hex() {
            // Belt as well as the AAD's braces: a manifest that opened under
            // this vault's binding and names another vault is a bug in a
            // writer, and restoring from it would be restoring someone else's
            // idea of this vault.
            return Err(invalid(
                "the manifest names a different vault than it opened as",
            ));
        }
        Ok(manifest)
    }
}

/// **The head, so discovery never opens a blob to ask what it is** (B12).
///
/// §2: "The manifest chain is a chain of small write-once objects; the gateway
/// holds only the **head**, updated by compare-and-set at `commit`." This is the
/// phone's copy of that head. The gateway half is W4's.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManifestHead {
    pub vault_id: String,
    /// The newest manifest's object name.
    pub manifest: String,
    pub generation: GenerationId,
    pub last_txid: u64,
}

impl ManifestHead {
    /// Read the head written beside a store, or `None` for a store with no
    /// generation yet.
    ///
    /// # Errors
    /// [`ManifestError::Io`] or [`ManifestError::Format`].
    pub fn read(path: &std::path::Path) -> Result<Option<Self>> {
        let text = match std::fs::read_to_string(path) {
            Ok(text) => text,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(source) => {
                return Err(ManifestError::Io {
                    path: path.to_path_buf(),
                    source,
                });
            }
        };
        let value: Value = serde_json::from_str(&text)?;
        let field = |key: &str| -> Result<String> {
            value
                .get(key)
                .and_then(Value::as_str)
                .map(str::to_owned)
                .ok_or_else(|| invalid(&format!("the head has no {key}")))
        };
        Ok(Some(Self {
            vault_id: field("vaultId")?,
            manifest: field("manifest")?,
            generation: GenerationId::from_hex(&field("generation")?)?,
            last_txid: value.get("lastTxid").and_then(Value::as_u64).unwrap_or(0),
        }))
    }

    /// Write the head durably.
    ///
    /// # Errors
    /// [`ManifestError::Io`].
    pub fn write(&self, path: &std::path::Path) -> Result<()> {
        let text = crate::intents::canonical_json(&json!({
            "vaultId": self.vault_id,
            "manifest": self.manifest,
            "generation": self.generation.hex(),
            "lastTxid": self.last_txid,
        }))
        .map_err(|error| invalid(&error.to_string()))?;
        crate::backup::spool::write_durably(path, text.as_bytes()).map_err(|error| {
            ManifestError::Io {
                path: path.to_path_buf(),
                source: std::io::Error::other(error.to_string()),
            }
        })
    }
}

/// Walk a chain backwards from `head`, newest first.
///
/// **A gap is reported, never guessed past.** A restore that silently skipped a
/// generation would hand the member a vault missing whatever that generation
/// held.
///
/// # Errors
/// [`ManifestError::ChainGap`] when a `prevManifest` names nothing `fetch` can
/// provide; otherwise whatever opening refused.
pub fn chain_from(
    keys: &ObjectKeys,
    head: &str,
    fetch: &dyn Fn(&str) -> Option<Vec<u8>>,
) -> Result<Vec<GenerationManifest>> {
    let mut chain = Vec::new();
    let mut seen = std::collections::BTreeSet::new();
    let mut cursor = Some(head.to_owned());
    while let Some(name) = cursor {
        if !seen.insert(name.clone()) {
            // A cycle is corruption, not a chain.
            return Err(ManifestError::ChainGap(name));
        }
        let bytes = fetch(&name).ok_or_else(|| ManifestError::ChainGap(name.clone()))?;
        // The name is the hash of the ciphertext, so this is the link check.
        if centraid_media::object::ObjectName::of(&bytes).hex() != name {
            return Err(ManifestError::ChainGap(name));
        }
        let manifest = GenerationManifest::open(keys, &bytes)?;
        cursor = manifest.prev_manifest.clone();
        chain.push(manifest);
    }
    Ok(chain)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn keys() -> ObjectKeys {
        ObjectKeys::new([0x41; 32], [0x42; 32])
    }

    fn range(index: u32) -> BaseRange {
        BaseRange {
            index,
            offset: u64::from(index) * 4,
            length: 4,
            plaintext_hash: hex::encode([index as u8; 32]),
            object_name: hex::encode([0x80 | index as u8; 32]),
            object_bytes: 128,
            reused: false,
        }
    }

    fn manifest(prev: Option<&str>) -> GenerationManifest {
        GenerationManifest {
            vault_id: keys().vault_id_hex(),
            generation: GenerationId::from_bytes([3; 16]),
            created_at: "2026-09-17T00:00:00.000Z".to_owned(),
            prev_manifest: prev.map(str::to_owned),
            base: vec![range(0), range(1)],
            base_txid: 4,
            base_plaintext_hash: hex::encode([0xaa; 32]),
            base_file_bytes: 8,
            base_census: vec![("core_entity".to_owned(), 7)],
            segments: vec![SegmentRef {
                object: hex::encode([0xcd; 32]),
                first_txid: 5,
                last_txid: 9,
                bytes: 512,
                census: vec![("core_entity".to_owned(), 11)],
            }],
        }
    }

    #[test]
    fn a_manifest_round_trips_through_its_seal() {
        let keys = keys();
        let (sealed, name) = manifest(None).seal(&keys).expect("seals");
        assert_eq!(
            centraid_media::object::ObjectName::of(&sealed).hex(),
            name,
            "the name is the hash of the ciphertext"
        );
        let opened = GenerationManifest::open(&keys, &sealed).expect("opens");
        assert_eq!(opened, manifest(None));
        assert_eq!(opened.last_txid(), 9);
        assert_eq!(opened.census_at_head(), [("core_entity".to_owned(), 11)]);
    }

    /// **B12.** Another vault's manifest does not open — and that is a tag
    /// failure, not a field comparison.
    #[test]
    fn a_manifest_from_another_vault_does_not_open() {
        let (sealed, _) = manifest(None).seal(&keys()).expect("seals");
        let other = ObjectKeys::new([0x51; 32], [0x42; 32]);
        assert!(
            GenerationManifest::open(&other, &sealed).is_err(),
            "the AAD binds the vault identity key"
        );
    }

    /// **B12's other half.** Discovery walks names from a head; it opens
    /// nothing it was not pointed at.
    #[test]
    fn a_chain_is_walked_by_name_and_a_gap_is_named_rather_than_skipped() {
        let keys = keys();
        let (first, first_name) = manifest(None).seal(&keys).expect("seals");
        let (second, second_name) = manifest(Some(&first_name)).seal(&keys).expect("seals");
        let store: std::collections::BTreeMap<String, Vec<u8>> = [
            (first_name.clone(), first),
            (second_name.clone(), second.clone()),
        ]
        .into_iter()
        .collect();

        let chain =
            chain_from(&keys, &second_name, &|name| store.get(name).cloned()).expect("walks");
        assert_eq!(chain.len(), 2);
        assert_eq!(chain[0].prev_manifest.as_deref(), Some(first_name.as_str()));

        let holey: std::collections::BTreeMap<String, Vec<u8>> =
            [(second_name.clone(), second)].into_iter().collect();
        let error = chain_from(&keys, &second_name, &|name| holey.get(name).cloned())
            .expect_err("a gap must be named");
        assert!(matches!(error, ManifestError::ChainGap(gap) if gap == first_name));
    }

    #[test]
    fn a_manifest_whose_name_does_not_match_its_bytes_is_a_gap() {
        let keys = keys();
        let (sealed, name) = manifest(None).seal(&keys).expect("seals");
        let mut tampered = sealed;
        let last = tampered.len() - 1;
        tampered[last] ^= 1;
        let error = chain_from(&keys, &name, &|_| Some(tampered.clone()))
            .expect_err("the link check must catch it");
        assert!(matches!(error, ManifestError::ChainGap(_)), "{error}");
    }

    #[test]
    fn the_head_round_trips_and_a_missing_head_is_not_an_error() {
        let dir = tempfile::tempdir().expect("a directory");
        let path = dir.path().join("head.json");
        assert_eq!(ManifestHead::read(&path).expect("reads"), None);
        let head = ManifestHead {
            vault_id: keys().vault_id_hex(),
            manifest: hex::encode([0xef; 32]),
            generation: GenerationId::from_bytes([6; 16]),
            last_txid: 41,
        };
        head.write(&path).expect("writes");
        assert_eq!(ManifestHead::read(&path).expect("reads"), Some(head));
    }
}
