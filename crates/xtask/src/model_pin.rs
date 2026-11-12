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

pub struct Pin<'a> {
    pub url: &'a str,
    pub file: &'a Path,
    pub tools_mode: &'a str,
    pub score: Option<f64>,
    pub replace: bool,
}

pub fn run(root: &Path, pin: &Pin<'_>) -> Result<()> {
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
        "score": pin.score,
    });
    let path = root.join(RECORD);
    let standing: Option<Value> = std::fs::read_to_string(&path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .and_then(|record: Value| record.get("current").cloned());
    let previous = if pin.replace {
        Value::Null
    } else {
        standing
            .filter(|current| current["sha256"] != entry["sha256"])
            .unwrap_or(Value::Null)
    };
    let record = serde_json::json!({"current": entry, "previous": previous});
    std::fs::write(&path, serde_json::to_string_pretty(&record)? + "\n")
        .with_context(|| format!("write {}", path.display()))?;
    // the same entry must now pass the checks the gate makes
    println!(
        "model-pin: wrote {RECORD}: {file_name}, {bytes} bytes, sha256 {sha256}, mode {}",
        pin.tools_mode
    );
    Ok(())
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
