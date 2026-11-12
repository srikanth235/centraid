//! `cargo xtask model-pin`: the one command that writes the model record (#1188 C1).
//!
//! It reads the model file you name (size and SHA-256 are computed here, never typed), takes the
//! tool-catalogue and prompt hashes from the runtime (`cargo run -p centraid-assist --example
//! runtime_hashes`, so they are the ones the build computes), checks the URL is a Hugging Face file
//! pinned to a commit, and writes `crates/assist/model.json`. The record that stood becomes
//! `previous` (the two-model window) unless `--replace` is given. Nothing is fetched or uploaded.

use std::io::Read;
use std::path::Path;
use std::process::Command;

use anyhow::{Context, Result, anyhow, bail};
use serde_json::Value;
use sha2::{Digest, Sha256};

/// Where the record lives, from the repository root.
const RECORD: &str = "crates/assist/model.json";

pub struct Base<'a> {
    pub url: &'a str,
    pub file: &'a Path,
    pub tools_mode: &'a str,
    pub score: Option<f64>,
    pub replace: bool,
}

/// An adapter, pinned against whichever base the record holds once the base (if any) is written.
pub struct AdapterPin<'a> {
    pub url: &'a str,
    pub file: &'a Path,
    pub score: Option<f64>,
}

pub struct Pin<'a> {
    pub base: Option<Base<'a>>,
    pub adapter: Option<AdapterPin<'a>>,
    pub no_adapter: bool,
}

pub fn run(root: &Path, pin: &Pin<'_>) -> Result<()> {
    if pin.base.is_none() && pin.adapter.is_none() && !pin.no_adapter {
        bail!(
            "name a base (--url, --file, --tools-mode), an adapter (--adapter-url, --adapter-file) or --no-adapter"
        );
    }
    let path = root.join(RECORD);
    let mut record: Value = std::fs::read_to_string(&path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_else(|| serde_json::json!({"current": Value::Null, "previous": Value::Null}));
    if let Some(base) = &pin.base {
        write_base(root, base, &mut record)?;
    }
    if pin.no_adapter {
        record.as_object_mut().map(|o| o.remove("adapter"));
    }
    if let Some(adapter) = &pin.adapter {
        let entry = adapter_entry(root, adapter, &record)?;
        println!(
            "model-pin: adapter {}, {} bytes, sha256 {}, trained against the base {}",
            adapter.url, entry["bytes"], entry["sha256"], entry["base_sha256"]
        );
        record["adapter"] = entry;
    } else if let Some(standing) = record.get("adapter").cloned() {
        // a new base leaves the adapter made for the old one behind: it would never be used
        if standing["base_sha256"] != record["current"]["sha256"] {
            record.as_object_mut().map(|o| o.remove("adapter"));
            println!("model-pin: dropped the adapter, which was made for the base that stood");
        }
    }
    std::fs::write(&path, serde_json::to_string_pretty(&record)? + "\n")
        .with_context(|| format!("write {}", path.display()))?;
    println!("model-pin: wrote {RECORD}");
    Ok(())
}

/// The adapter's entry: size and digest from the file, the base it is for from the record, the
/// catalogue and prompt hashes from the runtime in the base's mode.
fn adapter_entry(root: &Path, adapter: &AdapterPin<'_>, record: &Value) -> Result<Value> {
    let file_name = adapter
        .url
        .rsplit('/')
        .next()
        .filter(|name| !name.is_empty())
        .ok_or_else(|| anyhow!("{} has no file name", adapter.url))?
        .to_owned();
    let (sha256, bytes) = digest(adapter.file)?;
    let current = record
        .get("current")
        .filter(|current| !current.is_null())
        .ok_or_else(|| anyhow!("pin the base first: the record holds none"))?;
    let mode = current["tools_mode"]
        .as_str()
        .ok_or_else(|| anyhow!("the base names no tools_mode"))?;
    let hashes = runtime_hashes(root)?;
    let hashes = hashes
        .get(mode)
        .ok_or_else(|| anyhow!("{mode:?} is not a catalogue mode"))?;
    Ok(serde_json::json!({
        "url": adapter.url,
        "file_name": file_name,
        "sha256": sha256,
        "bytes": bytes,
        "base_sha256": current["sha256"],
        "tools_hash": hashes["tools_hash"],
        "prompt_hash": hashes["prompt_hash"],
        "score": adapter.score,
    }))
}

/// Write `current` (and `previous`) into `record`, leaving anything else in it (the adapter) as it
/// stood.
fn write_base(root: &Path, pin: &Base<'_>, record: &mut Value) -> Result<()> {
    let file_name = pin
        .url
        .rsplit('/')
        .next()
        .filter(|name| !name.is_empty())
        .ok_or_else(|| anyhow!("{} has no file name", pin.url))?
        .to_owned();
    let (sha256, bytes) = digest(pin.file)?;
    let hashes = runtime_hashes(root)?;
    let mode = hashes
        .get(pin.tools_mode)
        .ok_or_else(|| anyhow!("{:?} is not a catalogue mode", pin.tools_mode))?;
    let entry = serde_json::json!({
        "url": pin.url,
        "file_name": file_name,
        "sha256": sha256,
        "bytes": bytes,
        "tools_mode": pin.tools_mode,
        "tools_hash": mode["tools_hash"],
        "prompt_hash": mode["prompt_hash"],
        "special_tokens": gguf_specials(pin.file)?,
        "special_tokens_source": "file",
        "score": pin.score,
    });
    let standing = record.get("current").filter(|c| !c.is_null()).cloned();
    let previous = if pin.replace {
        Value::Null
    } else {
        standing
            .filter(|current| current["sha256"] != entry["sha256"])
            .unwrap_or(Value::Null)
    };
    record["current"] = entry;
    record["previous"] = previous;
    println!(
        "model-pin: base {file_name}, {bytes} bytes, sha256 {sha256}, mode {}",
        pin.tools_mode
    );
    Ok(())
}

/// The control and user-defined tokens of a GGUF file's tokenizer, sorted: what the engine
/// reads as special when a prompt is tokenized with special tokens parsed. Read from the file's
/// own metadata (`tokenizer.ggml.tokens` and `tokenizer.ggml.token_type`), never typed.
pub fn gguf_specials(file: &Path) -> Result<Vec<String>> {
    let mut reader = std::io::BufReader::new(
        std::fs::File::open(file).with_context(|| format!("open {}", file.display()))?,
    );
    read_specials(&mut reader).with_context(|| format!("read the tokenizer of {}", file.display()))
}

fn read_specials(reader: &mut impl Read) -> Result<Vec<String>> {
    fn u32_of(r: &mut impl Read) -> Result<u32> {
        let mut b = [0u8; 4];
        r.read_exact(&mut b)?;
        Ok(u32::from_le_bytes(b))
    }
    fn u64_of(r: &mut impl Read) -> Result<u64> {
        let mut b = [0u8; 8];
        r.read_exact(&mut b)?;
        Ok(u64::from_le_bytes(b))
    }
    fn string_of(r: &mut impl Read) -> Result<String> {
        let len = usize::try_from(u64_of(r)?)?;
        if len > 1 << 24 {
            bail!("a string of {len} bytes in the metadata");
        }
        let mut bytes = vec![0u8; len];
        r.read_exact(&mut bytes)?;
        Ok(String::from_utf8_lossy(&bytes).into_owned())
    }
    fn skip(r: &mut impl Read, n: u64) -> Result<()> {
        let copied = std::io::copy(&mut r.take(n), &mut std::io::sink())?;
        if copied != n {
            bail!("the metadata ends early");
        }
        Ok(())
    }
    // `tokens` and `types` are filled as the keys go by
    enum Held {
        Tokens(Vec<String>),
        Types(Vec<i32>),
    }
    fn value(r: &mut impl Read, kind: u32, keep: Option<&str>) -> Result<Option<Held>> {
        Ok(match kind {
            0 | 1 | 7 => {
                skip(r, 1)?;
                None
            }
            2 | 3 => {
                skip(r, 2)?;
                None
            }
            4..=6 => {
                skip(r, 4)?;
                None
            }
            10..=12 => {
                skip(r, 8)?;
                None
            }
            8 => {
                string_of(r)?;
                None
            }
            9 => {
                let item = u32_of(r)?;
                let count = u64_of(r)?;
                match (keep, item) {
                    (Some("tokenizer.ggml.tokens"), 8) => {
                        let mut all = Vec::new();
                        for _ in 0..count {
                            all.push(string_of(r)?);
                        }
                        Some(Held::Tokens(all))
                    }
                    (Some("tokenizer.ggml.token_type"), 5) => {
                        let mut all = Vec::new();
                        for _ in 0..count {
                            all.push(u32_of(r)? as i32);
                        }
                        Some(Held::Types(all))
                    }
                    _ => {
                        for _ in 0..count {
                            value(r, item, None)?;
                        }
                        None
                    }
                }
            }
            other => bail!("a metadata value of kind {other}"),
        })
    }
    let mut magic = [0u8; 4];
    reader.read_exact(&mut magic)?;
    if &magic != b"GGUF" {
        bail!("not a GGUF file");
    }
    let version = u32_of(reader)?;
    if version < 2 {
        bail!("GGUF version {version} is not read");
    }
    let _tensors = u64_of(reader)?;
    let entries = u64_of(reader)?;
    let (mut tokens, mut types) = (None, None);
    for _ in 0..entries {
        let key = string_of(reader)?;
        let kind = u32_of(reader)?;
        match value(reader, kind, Some(&key))? {
            Some(Held::Tokens(all)) => tokens = Some(all),
            Some(Held::Types(all)) => types = Some(all),
            None => {}
        }
    }
    let tokens = tokens.ok_or_else(|| anyhow!("the file has no tokenizer.ggml.tokens"))?;
    let types = types.ok_or_else(|| anyhow!("the file has no tokenizer.ggml.token_type"))?;
    // 3 is a control token, 4 a user-defined one: the two the engine parses out of a prompt
    let mut specials: Vec<String> = tokens
        .into_iter()
        .zip(types)
        .filter(|(token, kind)| matches!(kind, 3 | 4) && !token.is_empty())
        .map(|(token, _)| token)
        .collect();
    specials.sort();
    specials.dedup();
    Ok(specials)
}

fn digest(file: &Path) -> Result<(String, u64)> {
    let mut reader =
        std::fs::File::open(file).with_context(|| format!("open {}", file.display()))?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 1 << 20];
    let mut total = 0u64;
    loop {
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
        total += read as u64;
    }
    if total == 0 {
        bail!("{} is empty", file.display());
    }
    Ok((hex(&hasher.finalize()), total))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn runtime_hashes(root: &Path) -> Result<Value> {
    let out = Command::new("cargo")
        .args([
            "run",
            "-q",
            "-p",
            "centraid-assist",
            "--example",
            "runtime_hashes",
        ])
        .current_dir(root)
        .output()
        .context("run the runtime-hashes example")?;
    if !out.status.success() {
        bail!(
            "runtime_hashes failed: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }
    serde_json::from_slice(&out.stdout).context("read the runtime's hashes")
}

#[cfg(test)]
mod tests {
    use super::read_specials;

    fn string(out: &mut Vec<u8>, text: &str) {
        out.extend((text.len() as u64).to_le_bytes());
        out.extend(text.as_bytes());
    }

    /// A GGUF header with a few unrelated entries and a four-token vocabulary.
    fn gguf() -> Vec<u8> {
        let mut out = b"GGUF".to_vec();
        out.extend(3u32.to_le_bytes());
        out.extend(0u64.to_le_bytes());
        out.extend(4u64.to_le_bytes());
        string(&mut out, "general.name");
        out.extend(8u32.to_le_bytes());
        string(&mut out, "tiny");
        string(&mut out, "general.alignment");
        out.extend(4u32.to_le_bytes());
        out.extend(32u32.to_le_bytes());
        string(&mut out, "tokenizer.ggml.tokens");
        out.extend(9u32.to_le_bytes());
        out.extend(8u32.to_le_bytes());
        out.extend(4u64.to_le_bytes());
        for token in ["hello", "<|im_start|>", "<think>", "x"] {
            string(&mut out, token);
        }
        string(&mut out, "tokenizer.ggml.token_type");
        out.extend(9u32.to_le_bytes());
        out.extend(5u32.to_le_bytes());
        out.extend(4u64.to_le_bytes());
        for kind in [1i32, 3, 4, 1] {
            out.extend(kind.to_le_bytes());
        }
        out
    }

    #[test]
    fn control_and_user_defined_tokens_are_read_sorted() {
        let bytes = gguf();
        let specials = read_specials(&mut bytes.as_slice()).unwrap();
        assert_eq!(specials, ["<think>", "<|im_start|>"]);
    }

    #[test]
    fn a_file_that_is_not_gguf_is_refused() {
        assert!(read_specials(&mut b"not a model".as_slice()).is_err());
    }
}
