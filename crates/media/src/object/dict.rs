//! The trained zstd dictionary, and the id the header names it by (#1029 §4).
//!
//! A one-row edit's page segment is mostly page structure: SQLite headers, cell
//! pointer arrays, the same column names over and over. Plain zstd sees each
//! segment fresh and has no window to find that in; a dictionary trained on this
//! schema's pages carries it in, which is the difference between compressing a
//! 4 KiB page and compressing nothing at all.
//!
//! **The dictionary is part of the format, so it is named, not assumed.** The
//! header carries [`Dictionary::id`] — the **BLAKE3** of the dictionary bytes,
//! because a dictionary id is a name this repository defines and ONE HASH binds
//! it — and opening refuses a dictionary whose id is not the one the object was
//! sealed against. A dictionary is therefore versioned by its content: train a
//! new one and old objects keep opening against the old one, which the vault
//! stores alongside the generation that used it.

use super::ObjectError;

/// A zstd dictionary and the id objects name it by.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Dictionary {
    bytes: Vec<u8>,
    id: [u8; 32],
}

impl Dictionary {
    /// Adopt dictionary bytes that already exist — out of the vault, out of a
    /// golden vector, or off a restored generation.
    ///
    /// # Errors
    /// [`ObjectError::EmptyDictionary`] for an empty one: an empty dictionary
    /// would hash to a fixed id and compress nothing, which is a silent way to
    /// ship "no dictionary" while the header claims one.
    pub fn from_bytes(bytes: Vec<u8>) -> Result<Self, ObjectError> {
        if bytes.is_empty() {
            return Err(ObjectError::EmptyDictionary);
        }
        let id = *blake3::hash(&bytes).as_bytes();
        Ok(Self { bytes, id })
    }

    /// Train one on real samples — pages from this vault's own schema.
    ///
    /// # Errors
    /// [`ObjectError::DictionaryTraining`] when zstd cannot train on what it
    /// was given, which in practice means too few or too small samples.
    pub fn train(samples: &[&[u8]], max_bytes: usize) -> Result<Self, ObjectError> {
        let corpus: Vec<u8> = samples.concat();
        let sizes: Vec<usize> = samples.iter().map(|sample| sample.len()).collect();
        let bytes = zstd::dict::from_continuous(&corpus, &sizes, max_bytes)
            .map_err(|error| ObjectError::DictionaryTraining(error.to_string()))?;
        Self::from_bytes(bytes)
    }

    /// The dictionary bytes, to store beside the generation that used them.
    #[must_use]
    pub fn bytes(&self) -> &[u8] {
        &self.bytes
    }

    /// **BLAKE3** of the dictionary bytes. This is what the header carries.
    #[must_use]
    pub const fn id(&self) -> &[u8; 32] {
        &self.id
    }

    /// Compress `plain` against this dictionary.
    ///
    /// # Errors
    /// [`ObjectError::Compression`].
    pub fn compress(&self, plain: &[u8]) -> Result<Vec<u8>, ObjectError> {
        let mut compressor =
            zstd::bulk::Compressor::with_dictionary(COMPRESSION_LEVEL, &self.bytes)
                .map_err(|error| ObjectError::Compression(error.to_string()))?;
        compressor
            .compress(plain)
            .map_err(|error| ObjectError::Compression(error.to_string()))
    }

    /// Decompress against this dictionary, refusing to allocate past
    /// `plain_bound`.
    ///
    /// The bound is not decoration: the compressed bytes come out of an AEAD
    /// that has already authenticated them, but the padded plaintext length is
    /// the only thing standing between a corrupted length prefix and an
    /// unbounded allocation, so it is passed in and enforced.
    ///
    /// # Errors
    /// [`ObjectError::Compression`], including when the output would exceed
    /// `plain_bound`.
    pub fn decompress(
        &self,
        compressed: &[u8],
        plain_bound: usize,
    ) -> Result<Vec<u8>, ObjectError> {
        let mut decompressor = zstd::bulk::Decompressor::with_dictionary(&self.bytes)
            .map_err(|error| ObjectError::Compression(error.to_string()))?;
        decompressor
            .decompress(compressed, plain_bound)
            .map_err(|error| ObjectError::Compression(error.to_string()))
    }
}

/// zstd level 3. The phone is doing this on battery under the write mutex, and
/// levels above 3 cost more time than they save bytes on page-shaped input.
const COMPRESSION_LEVEL: i32 = 3;

#[cfg(test)]
mod tests {
    use super::*;

    fn samples() -> Vec<Vec<u8>> {
        // Page-shaped: the same furniture, different rows.
        (0..64_u32)
            .map(|row| {
                format!(
                    "SQLite format 3\u{0}\u{d}core_content_item\u{0}content_id={row}\
                     \u{0}content_hash=0000000000000000\u{0}byte_size={row}\u{0}"
                )
                .into_bytes()
            })
            .collect()
    }

    fn trained() -> Dictionary {
        let owned = samples();
        let refs: Vec<&[u8]> = owned.iter().map(Vec::as_slice).collect();
        Dictionary::train(&refs, 8 * 1024).expect("trains on page-shaped samples")
    }

    #[test]
    fn a_dictionary_round_trips_a_page_shaped_payload() {
        let dictionary = trained();
        let plain = samples().concat();
        let compressed = dictionary.compress(&plain).expect("compresses");
        assert_eq!(
            dictionary
                .decompress(&compressed, plain.len())
                .expect("decompresses"),
            plain
        );
    }

    /// The id is the dictionary's content, so two trainings that produced the
    /// same bytes are the same dictionary and two that did not are not.
    #[test]
    fn the_id_is_blake3_of_the_dictionary_bytes() {
        let dictionary = trained();
        assert_eq!(dictionary.id(), blake3::hash(dictionary.bytes()).as_bytes());
        let other = Dictionary::from_bytes(b"a different dictionary".to_vec()).expect("adopts");
        assert_ne!(dictionary.id(), other.id());
    }

    #[test]
    fn an_empty_dictionary_is_refused_rather_than_hashed() {
        assert_eq!(
            Dictionary::from_bytes(Vec::new()),
            Err(ObjectError::EmptyDictionary)
        );
    }

    /// The bound is enforced, so an authenticated-but-wrong length cannot make
    /// the decoder allocate whatever it likes.
    #[test]
    fn decompression_refuses_to_exceed_the_bound_it_was_given() {
        let dictionary = trained();
        let plain = samples().concat();
        let compressed = dictionary.compress(&plain).expect("compresses");
        assert!(dictionary.decompress(&compressed, plain.len() - 1).is_err());
    }
}
