//! A LoRA ADAPTER FILE, READ BEFORE llama.cpp IS ASKED TO LOAD IT (#1188).
//!
//! llama.cpp says why it refused an adapter ("expect general.type to be 'adapter'") on its own
//! log and returns a null pointer, so the binding's error is "null result" and a shell has
//! nothing to show. [`check`] reads the GGUF header itself (the key/value block, never the
//! tensors) and says it in a typed error: the file is missing, is not GGUF, is a model and not an
//! adapter, is not a LoRA, or was trained for another architecture than the loaded model. The
//! shape of every tensor is still llama.cpp's to check at load.
//!
//! Built always: no llama.cpp, no weights.
//!
//! [`fixture`] writes a tiny valid adapter file for tests (the engine's real-model suite builds
//! its zero-delta and live adapters with it), so a test needs no Python and no trained adapter.

use std::fs::File;
use std::io::{BufReader, Read};
use std::path::Path;

/// What an adapter file's header says.
#[derive(Debug, Clone, PartialEq)]
pub struct AdapterHeader {
    /// `general.architecture`: must equal the base model's.
    pub architecture: String,
    /// `adapter.lora.alpha`, when the file has one (the converter always writes it).
    pub alpha: Option<f32>,
    /// How many tensors the file holds: two per adapted module (`.lora_a`, `.lora_b`).
    pub tensors: u64,
}

/// Why a file is not an adapter this engine can attach.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AdapterError {
    /// No file at the path, or it could not be opened.
    Unreadable(String),
    /// Not a GGUF file, or cut off inside the header.
    NotGguf,
    /// A GGUF file whose `general.type` is not `adapter` (a model, usually).
    NotAnAdapter { general_type: String },
    /// An adapter, but not a LoRA (`adapter.type`).
    NotLora { adapter_type: String },
    /// A LoRA for another architecture than the loaded model's.
    WrongArchitecture { adapter: String, model: String },
}

impl std::fmt::Display for AdapterError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unreadable(why) => write!(f, "the adapter file cannot be read: {why}"),
            Self::NotGguf => write!(f, "the adapter file is not a GGUF file, or is cut off"),
            Self::NotAnAdapter { general_type } => write!(
                f,
                "the file is not an adapter (its general.type is '{general_type}', not 'adapter')"
            ),
            Self::NotLora { adapter_type } => write!(
                f,
                "the adapter is not a LoRA (its adapter.type is '{adapter_type}')"
            ),
            Self::WrongArchitecture { adapter, model } => write!(
                f,
                "the adapter was made for '{adapter}' and the model is '{model}'"
            ),
        }
    }
}

impl std::error::Error for AdapterError {}

/// The most key/value pairs a header may claim: an adapter has a handful.
const MAX_KEYS: u64 = 4096;
/// The longest key or string value read into memory.
const MAX_TEXT: u64 = 1 << 16;
/// The most elements of an array of strings a header may skip: a model's vocabulary is a quarter of a million.
const MAX_ARRAY: u64 = 1 << 24;

/// Read the header of the adapter at `path` and require it to be a LoRA for `architecture`.
///
/// # Errors
/// [`AdapterError`], naming the first thing wrong.
pub fn check(path: &Path, architecture: &str) -> Result<AdapterHeader, AdapterError> {
    let header = inspect(path)?;
    if header.architecture != architecture {
        return Err(AdapterError::WrongArchitecture {
            adapter: header.architecture,
            model: architecture.to_owned(),
        });
    }
    Ok(header)
}

/// Read the header of the adapter at `path` and require it to be a LoRA, for any architecture.
///
/// # Errors
/// [`AdapterError`], naming the first thing wrong.
pub fn inspect(path: &Path) -> Result<AdapterHeader, AdapterError> {
    let file = File::open(path).map_err(|e| AdapterError::Unreadable(e.to_string()))?;
    let mut r = BufReader::new(file);
    let mut magic = [0u8; 4];
    r.read_exact(&mut magic)
        .map_err(|_| AdapterError::NotGguf)?;
    if &magic != b"GGUF" {
        return Err(AdapterError::NotGguf);
    }
    let version = u32_of(&mut r)?;
    if !(2..=3).contains(&version) {
        return Err(AdapterError::NotGguf);
    }
    let tensors = u64_of(&mut r)?;
    let keys = u64_of(&mut r)?;
    if keys > MAX_KEYS {
        return Err(AdapterError::NotGguf);
    }
    let (mut general_type, mut adapter_type, mut architecture, mut alpha) =
        (None, None, None, None);
    for _ in 0..keys {
        let key = string_of(&mut r)?;
        let kind = u32_of(&mut r)?;
        match (key.as_str(), kind) {
            ("general.type", STRING) => general_type = Some(string_of(&mut r)?),
            ("adapter.type", STRING) => adapter_type = Some(string_of(&mut r)?),
            ("general.architecture", STRING) => architecture = Some(string_of(&mut r)?),
            ("adapter.lora.alpha", F32) => alpha = Some(f32::from_le_bytes(array_of(&mut r)?)),
            _ => skip(&mut r, kind)?,
        }
        // A model file says so in its first keys and carries a quarter of a million tokens after
        // them: stop at the answer rather than read the vocabulary.
        if let Some(found) = general_type.as_ref().filter(|found| *found != "adapter") {
            return Err(AdapterError::NotAnAdapter {
                general_type: found.clone(),
            });
        }
    }
    let general_type = general_type.unwrap_or_default();
    if general_type != "adapter" {
        return Err(AdapterError::NotAnAdapter { general_type });
    }
    let adapter_type = adapter_type.unwrap_or_default();
    if adapter_type != "lora" {
        return Err(AdapterError::NotLora { adapter_type });
    }
    Ok(AdapterHeader {
        architecture: architecture.unwrap_or_default(),
        alpha,
        tensors,
    })
}

// GGUF value types (gguf.h `gguf_type`).
const F32: u32 = 6;
const STRING: u32 = 8;
const ARRAY: u32 = 9;

fn array_of<const N: usize>(r: &mut impl Read) -> Result<[u8; N], AdapterError> {
    let mut bytes = [0u8; N];
    r.read_exact(&mut bytes)
        .map_err(|_| AdapterError::NotGguf)?;
    Ok(bytes)
}

fn u32_of(r: &mut impl Read) -> Result<u32, AdapterError> {
    Ok(u32::from_le_bytes(array_of(r)?))
}

fn u64_of(r: &mut impl Read) -> Result<u64, AdapterError> {
    Ok(u64::from_le_bytes(array_of(r)?))
}

fn string_of(r: &mut impl Read) -> Result<String, AdapterError> {
    let len = u64_of(r)?;
    if len > MAX_TEXT {
        return Err(AdapterError::NotGguf);
    }
    let mut bytes = vec![0u8; usize::try_from(len).map_err(|_| AdapterError::NotGguf)?];
    r.read_exact(&mut bytes)
        .map_err(|_| AdapterError::NotGguf)?;
    String::from_utf8(bytes).map_err(|_| AdapterError::NotGguf)
}

/// The bytes one value of a fixed-width type takes, or `None` for a string or an array.
const fn width(kind: u32) -> Option<i64> {
    match kind {
        0 | 1 | 7 => Some(1),
        2 | 3 => Some(2),
        4 | 5 | F32 => Some(4),
        10..=12 => Some(8),
        _ => None,
    }
}

/// Step over one value of `kind` without keeping it.
fn skip(r: &mut BufReader<File>, kind: u32) -> Result<(), AdapterError> {
    let seek =
        |r: &mut BufReader<File>, by: i64| r.seek_relative(by).map_err(|_| AdapterError::NotGguf);
    if let Some(bytes) = width(kind) {
        return seek(r, bytes);
    }
    match kind {
        STRING => {
            let len = u64_of(r)?;
            seek(r, i64::try_from(len).map_err(|_| AdapterError::NotGguf)?)
        }
        ARRAY => {
            let element = u32_of(r)?;
            let count = u64_of(r)?;
            if let Some(bytes) = width(element) {
                let total = i64::try_from(count)
                    .ok()
                    .and_then(|n| n.checked_mul(bytes))
                    .ok_or(AdapterError::NotGguf)?;
                return seek(r, total);
            }
            if count > MAX_ARRAY {
                return Err(AdapterError::NotGguf);
            }
            for _ in 0..count {
                skip(r, element)?;
            }
            Ok(())
        }
        _ => Err(AdapterError::NotGguf),
    }
}

/// Tiny valid GGUF files, for tests.
pub mod fixture {
    use std::io::Write;
    use std::path::Path;

    /// An adapter file to write.
    #[derive(Debug, Clone)]
    pub struct Fixture<'a> {
        pub architecture: &'a str,
        /// `general.type`: `adapter` for a real one.
        pub general_type: &'a str,
        /// `adapter.type`: `lora` for a real one.
        pub adapter_type: &'a str,
        pub alpha: f32,
        /// `(name, ggml dims [ne0, ne1], f32 data of ne0*ne1 values)`. A LoRA pair for the base
        /// tensor `blk.0.ffn_down.weight` (ne `[3584, 1024]`) of rank `r` is
        /// `blk.0.ffn_down.weight.lora_a` `[3584, r]` and `.lora_b` `[r, 1024]`.
        pub tensors: Vec<(String, [u64; 2], Vec<f32>)>,
    }

    fn text(out: &mut Vec<u8>, s: &str) {
        out.extend_from_slice(&(s.len() as u64).to_le_bytes());
        out.extend_from_slice(s.as_bytes());
    }

    fn string_kv(out: &mut Vec<u8>, key: &str, value: &str) {
        text(out, key);
        out.extend_from_slice(&8u32.to_le_bytes());
        text(out, value);
    }

    /// Write `fixture` to `path` as GGUF v3, tensors F32, 32-byte aligned.
    ///
    /// # Errors
    /// The write failing.
    pub fn write(path: &Path, fixture: &Fixture<'_>) -> std::io::Result<()> {
        const ALIGN: usize = 32;
        let mut out = b"GGUF".to_vec();
        out.extend_from_slice(&3u32.to_le_bytes());
        out.extend_from_slice(&(fixture.tensors.len() as u64).to_le_bytes());
        out.extend_from_slice(&4u64.to_le_bytes());
        string_kv(&mut out, "general.architecture", fixture.architecture);
        string_kv(&mut out, "general.type", fixture.general_type);
        string_kv(&mut out, "adapter.type", fixture.adapter_type);
        text(&mut out, "adapter.lora.alpha");
        out.extend_from_slice(&6u32.to_le_bytes());
        out.extend_from_slice(&fixture.alpha.to_le_bytes());
        let mut offset = 0u64;
        for (name, dims, data) in &fixture.tensors {
            debug_assert_eq!(data.len() as u64, dims[0] * dims[1]);
            text(&mut out, name);
            out.extend_from_slice(&2u32.to_le_bytes());
            for d in dims {
                out.extend_from_slice(&d.to_le_bytes());
            }
            out.extend_from_slice(&0u32.to_le_bytes());
            out.extend_from_slice(&offset.to_le_bytes());
            offset += (data.len() * 4).div_ceil(ALIGN) as u64 * ALIGN as u64;
        }
        out.resize(out.len().div_ceil(ALIGN) * ALIGN, 0);
        for (_, _, data) in &fixture.tensors {
            for v in data {
                out.extend_from_slice(&v.to_le_bytes());
            }
            out.resize(out.len().div_ceil(ALIGN) * ALIGN, 0);
        }
        std::fs::File::create(path)?.write_all(&out)
    }
}

#[cfg(test)]
mod tests {
    use super::fixture::{Fixture, write};
    use super::*;

    fn dir() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "centraid-adapter-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        std::fs::create_dir_all(&dir).expect("a temp directory");
        dir
    }

    fn lora() -> Fixture<'static> {
        Fixture {
            architecture: "qwen35",
            general_type: "adapter",
            adapter_type: "lora",
            alpha: 16.0,
            tensors: vec![
                (
                    "blk.0.ffn_down.weight.lora_a".to_owned(),
                    [4, 2],
                    vec![0.0; 8],
                ),
                (
                    "blk.0.ffn_down.weight.lora_b".to_owned(),
                    [2, 3],
                    vec![0.0; 6],
                ),
            ],
        }
    }

    #[test]
    fn a_lora_for_the_model_is_read() {
        let path = dir().join("ok.gguf");
        write(&path, &lora()).expect("writes");
        let header = check(&path, "qwen35").expect("an adapter");
        assert_eq!(header.architecture, "qwen35");
        assert_eq!(header.alpha, Some(16.0));
        assert_eq!(header.tensors, 2);
    }

    #[test]
    fn a_model_file_is_named_as_not_an_adapter() {
        let path = dir().join("model.gguf");
        write(
            &path,
            &Fixture {
                general_type: "model",
                ..lora()
            },
        )
        .expect("writes");
        let error = check(&path, "qwen35").expect_err("a model");
        assert_eq!(
            error,
            AdapterError::NotAnAdapter {
                general_type: "model".to_owned()
            }
        );
        assert!(error.to_string().contains("not an adapter"), "{error}");
    }

    #[test]
    fn a_file_with_no_general_type_is_not_an_adapter() {
        // A header of zero keys: GGUF, but nothing says what it is.
        let path = dir().join("bare.gguf");
        let mut bytes = b"GGUF".to_vec();
        bytes.extend_from_slice(&3u32.to_le_bytes());
        bytes.extend_from_slice(&0u64.to_le_bytes());
        bytes.extend_from_slice(&0u64.to_le_bytes());
        std::fs::write(&path, bytes).expect("writes");
        assert!(matches!(
            check(&path, "qwen35"),
            Err(AdapterError::NotAnAdapter { .. })
        ));
    }

    #[test]
    fn another_adapter_kind_or_architecture_is_refused() {
        let d = dir();
        let kind = d.join("kind.gguf");
        write(
            &kind,
            &Fixture {
                adapter_type: "control_vector",
                ..lora()
            },
        )
        .expect("writes");
        assert!(matches!(
            check(&kind, "qwen35"),
            Err(AdapterError::NotLora { .. })
        ));
        let arch = d.join("arch.gguf");
        write(
            &arch,
            &Fixture {
                architecture: "llama",
                ..lora()
            },
        )
        .expect("writes");
        assert_eq!(
            check(&arch, "qwen35"),
            Err(AdapterError::WrongArchitecture {
                adapter: "llama".to_owned(),
                model: "qwen35".to_owned()
            })
        );
    }

    #[test]
    fn a_missing_a_foreign_and_a_cut_off_file_are_each_named() {
        let d = dir();
        assert!(matches!(
            check(&d.join("nowhere.gguf"), "qwen35"),
            Err(AdapterError::Unreadable(_))
        ));
        let text = d.join("text.gguf");
        std::fs::write(&text, b"not a model at all").expect("writes");
        assert_eq!(check(&text, "qwen35"), Err(AdapterError::NotGguf));
        let good = d.join("whole.gguf");
        write(&good, &lora()).expect("writes");
        let cut = d.join("cut.gguf");
        let bytes = std::fs::read(&good).expect("reads");
        std::fs::write(&cut, &bytes[..40]).expect("writes");
        assert_eq!(check(&cut, "qwen35"), Err(AdapterError::NotGguf));
    }

    /// What a real GGUF model looks like to the reader (found by pointing it at the 0.8B file): its
    /// type is among the first keys and a vocabulary of a quarter of a million strings follows.
    #[test]
    fn a_models_vocabulary_is_not_read_to_say_it_is_a_model() {
        let put = |out: &mut Vec<u8>, s: &str| {
            out.extend_from_slice(&(s.len() as u64).to_le_bytes());
            out.extend_from_slice(s.as_bytes());
        };
        let mut out = b"GGUF".to_vec();
        out.extend_from_slice(&3u32.to_le_bytes());
        out.extend_from_slice(&0u64.to_le_bytes());
        out.extend_from_slice(&3u64.to_le_bytes());
        put(&mut out, "general.architecture");
        out.extend_from_slice(&8u32.to_le_bytes());
        put(&mut out, "qwen35");
        put(&mut out, "general.type");
        out.extend_from_slice(&8u32.to_le_bytes());
        put(&mut out, "model");
        put(&mut out, "tokenizer.ggml.tokens");
        out.extend_from_slice(&9u32.to_le_bytes());
        out.extend_from_slice(&8u32.to_le_bytes());
        out.extend_from_slice(&248_320u64.to_le_bytes());
        for i in 0..248_320 {
            put(&mut out, &format!("tok{i}"));
        }
        let path = dir().join("model-like.gguf");
        std::fs::write(&path, out).expect("writes");
        assert_eq!(
            check(&path, "qwen35"),
            Err(AdapterError::NotAnAdapter {
                general_type: "model".to_owned()
            })
        );
    }

    #[test]
    fn a_big_array_before_the_keys_that_matter_is_stepped_over() {
        let put = |out: &mut Vec<u8>, s: &str| {
            out.extend_from_slice(&(s.len() as u64).to_le_bytes());
            out.extend_from_slice(s.as_bytes());
        };
        let mut out = b"GGUF".to_vec();
        out.extend_from_slice(&3u32.to_le_bytes());
        out.extend_from_slice(&0u64.to_le_bytes());
        out.extend_from_slice(&4u64.to_le_bytes());
        put(&mut out, "x.tokens");
        out.extend_from_slice(&9u32.to_le_bytes());
        out.extend_from_slice(&8u32.to_le_bytes());
        out.extend_from_slice(&100_000u64.to_le_bytes());
        for i in 0..100_000 {
            put(&mut out, &format!("t{i}"));
        }
        for (key, value) in [
            ("general.architecture", "qwen35"),
            ("general.type", "adapter"),
            ("adapter.type", "lora"),
        ] {
            put(&mut out, key);
            out.extend_from_slice(&8u32.to_le_bytes());
            put(&mut out, value);
        }
        let path = dir().join("big-array.gguf");
        std::fs::write(&path, out).expect("writes");
        assert!(check(&path, "qwen35").is_ok());
    }

    #[test]
    fn keys_the_reader_does_not_know_are_stepped_over() {
        // An array of strings and one of integers before the keys that matter.
        let path = dir().join("extra.gguf");
        let mut out = b"GGUF".to_vec();
        out.extend_from_slice(&3u32.to_le_bytes());
        out.extend_from_slice(&0u64.to_le_bytes());
        out.extend_from_slice(&5u64.to_le_bytes());
        let put = |out: &mut Vec<u8>, s: &str| {
            out.extend_from_slice(&(s.len() as u64).to_le_bytes());
            out.extend_from_slice(s.as_bytes());
        };
        put(&mut out, "x.strings");
        out.extend_from_slice(&9u32.to_le_bytes());
        out.extend_from_slice(&8u32.to_le_bytes());
        out.extend_from_slice(&2u64.to_le_bytes());
        put(&mut out, "ab");
        put(&mut out, "cde");
        put(&mut out, "x.ints");
        out.extend_from_slice(&9u32.to_le_bytes());
        out.extend_from_slice(&4u32.to_le_bytes());
        out.extend_from_slice(&3u64.to_le_bytes());
        out.extend_from_slice(&[0u8; 12]);
        for (key, value) in [
            ("general.architecture", "qwen35"),
            ("general.type", "adapter"),
            ("adapter.type", "lora"),
        ] {
            put(&mut out, key);
            out.extend_from_slice(&8u32.to_le_bytes());
            put(&mut out, value);
        }
        std::fs::write(&path, out).expect("writes");
        let header = check(&path, "qwen35").expect("read past the arrays");
        assert_eq!(header.alpha, None);
    }
}
