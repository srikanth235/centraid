//! THE CONTRACT of a data version: the tool catalogue and the static prompt the data was rendered against.
//!
//! A version's records show the model the runtime's tools block. When the runtime's tools change, the data is for a
//! contract the app no longer serves, and the version has to say which one it was built for so that is checkable. The
//! manifest carries
//!
//! ```json
//! "contract": {"tools_mode": "sig", "tools_hash": "…", "prompt_hash": "…", "catalog_hash": "…", "tokenizer_blake3": "…"},
//! "heldout":  {"repo": "owner/name"}
//! ```
//!
//! and the version holds the texts the hashes are of:
//!
//! ```text
//! contract/tools.json    the tool catalogue exactly as the runtime hashes it: `tools_hash` is the BLAKE3 of this file
//! contract/system.txt    the static prompt exactly as the runtime hashes it (the identity, the static system turn with
//!                        its tools block and kind card, the escape rules): `prompt_hash` is the BLAKE3 of this file
//! contract/hashes.json   the contract block, as a file of its own
//! ```
//!
//! `datagen build` writes all of this. A version built before the block existed is given it by [`restamp`], which
//! changes no data file and does not read the test split: it proves the contract against the data first, see [`prove`].

use std::io::{BufRead, BufReader};
use std::path::Path;

use anyhow::{Context, Result, bail};
use centraid_assist::native::prompt::{ToolsMode, tools_block, tools_for};
use centraid_assist::record::runtime_texts;
use serde_json::{Value, json};

/// The folder of a data version that holds the contract's texts.
pub const DIR: &str = "contract";
/// The tool catalogue, as the runtime hashes it.
pub const TOOLS: &str = "contract/tools.json";
/// The static prompt, as the runtime hashes it.
pub const SYSTEM: &str = "contract/system.txt";
/// The contract block, as a file.
pub const HASHES: &str = "contract/hashes.json";
/// The splits a contract is proved on. The test split is never read.
pub const PROVED_ON: [&str; 2] = ["train", "val"];

/// What a version was built for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Contract {
    pub tools_mode: String,
    pub tools_hash: String,
    pub prompt_hash: String,
    pub catalog_hash: String,
    pub tokenizer_blake3: String,
}

impl Contract {
    /// The contract the runtime in this checkout serves for `mode`, with the build's catalog and tokenizer hashes.
    #[must_use]
    pub fn current(mode: ToolsMode, catalog_hash: &str, tokenizer_blake3: &str) -> Self {
        let (tools_hash, prompt_hash) = centraid_assist::record::runtime_hashes(mode);
        Self {
            tools_mode: mode.name().to_owned(),
            tools_hash,
            prompt_hash,
            catalog_hash: catalog_hash.to_owned(),
            tokenizer_blake3: tokenizer_blake3.to_owned(),
        }
    }

    /// The manifest's `contract` block; none when it is absent or lacks a field.
    #[must_use]
    pub fn of_manifest(manifest: &Value) -> Option<Self> {
        let block = manifest.get("contract")?;
        let text = |k: &str| block.get(k)?.as_str().filter(|v| !v.is_empty());
        Some(Self {
            tools_mode: text("tools_mode")?.to_owned(),
            tools_hash: text("tools_hash")?.to_owned(),
            prompt_hash: text("prompt_hash")?.to_owned(),
            catalog_hash: text("catalog_hash")?.to_owned(),
            tokenizer_blake3: text("tokenizer_blake3")?.to_owned(),
        })
    }

    /// The block as the manifest and `contract/hashes.json` hold it.
    #[must_use]
    pub fn to_json(&self) -> Value {
        json!({
            "tools_mode": self.tools_mode,
            "tools_hash": self.tools_hash,
            "prompt_hash": self.prompt_hash,
            "catalog_hash": self.catalog_hash,
            "tokenizer_blake3": self.tokenizer_blake3,
        })
    }
}

/// Write `contract/` under `dir` for `contract`, from the runtime's own texts for its tools mode.
///
/// # Errors
///
/// A tools mode the runtime does not know, or a file that cannot be written.
pub fn write_files(dir: &Path, contract: &Contract) -> Result<()> {
    let mode = ToolsMode::parse(&contract.tools_mode)
        .with_context(|| format!("unknown tools mode `{}`", contract.tools_mode))?;
    let (catalogue, prompt) = runtime_texts(mode);
    std::fs::create_dir_all(dir.join(DIR))?;
    std::fs::write(dir.join(TOOLS), catalogue)?;
    std::fs::write(dir.join(SYSTEM), prompt)?;
    std::fs::write(
        dir.join(HASHES),
        serde_json::to_string_pretty(&contract.to_json())?,
    )?;
    Ok(())
}

/// Everything wrong with the contract files of the version at `dir` against `contract`, one sentence each: a file
/// missing, a file that does not hash to the contract, a `hashes.json` that is not the contract.
#[must_use]
pub fn file_problems(dir: &Path, contract: &Contract) -> Vec<String> {
    let mut out = Vec::new();
    for (rel, want, name) in [
        (TOOLS, &contract.tools_hash, "tools_hash"),
        (SYSTEM, &contract.prompt_hash, "prompt_hash"),
    ] {
        match std::fs::read(dir.join(rel)) {
            Err(_) => out.push(format!(
                "{rel}: missing, the contract's files are not there"
            )),
            Ok(bytes) => {
                let got = blake3::hash(&bytes).to_hex().to_string();
                if &got != want {
                    out.push(format!(
                        "{rel}: hashes to {got}, not the manifest's {name} {want}"
                    ));
                }
            }
        }
    }
    match std::fs::read_to_string(dir.join(HASHES))
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
    {
        None => out.push(format!("{HASHES}: missing or not JSON")),
        Some(v) if v != contract.to_json() => {
            out.push(format!("{HASHES}: is not the manifest's contract block"));
        }
        Some(_) => {}
    }
    out
}

/// What [`prove`] counted for one split.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SplitProof {
    pub split: String,
    pub records: usize,
    pub with_block: usize,
}

/// Prove the tools block of `mode` is the one the data was rendered with: count, in every record of train and val
/// (the record's `render.text`), those that hold the runtime's tools block for `mode` byte for byte. The block lists
/// every tool exactly as the catalogue hashed in `tools_hash` writes it, so a record that holds it was rendered with
/// that catalogue. The test split is never opened.
///
/// # Errors
///
/// A split file that cannot be read, or, with the counts in the message, an empty split or a record without the block.
pub fn prove(dir: &Path, mode: ToolsMode) -> Result<Vec<SplitProof>> {
    let needle = tools_block(&tools_for(mode));
    let mut proofs = Vec::new();
    for split in PROVED_ON {
        let path = crate::version::split_path(dir, split);
        let file = std::fs::File::open(&path)
            .with_context(|| format!("reading {} to prove the contract", path.display()))?;
        let reader = BufReader::new(zstd::stream::read::Decoder::new(file)?);
        let (mut records, mut with_block) = (0, 0);
        for line in reader.lines() {
            let line = line?;
            if line.trim().is_empty() {
                continue;
            }
            let record: Value = serde_json::from_str(&line)
                .with_context(|| format!("a line of {} is not JSON", path.display()))?;
            records += 1;
            if record["render"]["text"]
                .as_str()
                .is_some_and(|text| text.contains(&needle))
            {
                with_block += 1;
            }
        }
        proofs.push(SplitProof {
            split: split.to_owned(),
            records,
            with_block,
        });
    }
    let bad: Vec<String> = proofs
        .iter()
        .filter(|p| p.records == 0 || p.with_block != p.records)
        .map(|p| {
            format!(
                "{}: {} of {} records hold the tools block of mode `{}`",
                p.split,
                p.with_block,
                p.records,
                mode.name()
            )
        })
        .collect();
    if !bad.is_empty() {
        bail!(
            "the data was not rendered with the tools block this runtime serves for `{}`, so the contract cannot be stamped: {}",
            mode.name(),
            bad.join("; ")
        );
    }
    Ok(proofs)
}

/// Give a version built without a contract its contract block and held-out pointer, and write `contract/`. No data
/// file changes; only `manifest.json` is rewritten and `contract/` added. The contract is proved against train and val
/// first ([`prove`]); the test split is not read.
///
/// # Errors
///
/// A manifest that cannot be read, a version already stamped with a different contract, or a proof that fails.
pub fn restamp(dir: &Path, heldout_repo: &str) -> Result<(Contract, Vec<SplitProof>)> {
    let path = dir.join("manifest.json");
    let mut manifest: Value = serde_json::from_str(
        &std::fs::read_to_string(&path)
            .with_context(|| format!("no manifest.json in {}", dir.display()))?,
    )
    .context("manifest.json is not JSON")?;
    let text = |p: &Value| p.as_str().filter(|v| !v.is_empty()).map(str::to_owned);
    let mode_name = text(&manifest["tools_block"]["mode"])
        .context("the manifest names no tools mode (`tools_block.mode`)")?;
    let mode = ToolsMode::parse(&mode_name)
        .with_context(|| format!("the manifest's tools mode `{mode_name}` is unknown"))?;
    let catalog = text(&manifest["catalog_hash"]).context("the manifest has no catalog_hash")?;
    let tokenizer =
        text(&manifest["tokenizer"]["blake3"]).context("the manifest has no tokenizer hash")?;
    let contract = Contract::current(mode, &catalog, &tokenizer);
    if let Some(have) = Contract::of_manifest(&manifest)
        && have != contract
    {
        bail!(
            "the manifest already carries a different contract (tools_hash {} against this runtime's {}): nothing was changed",
            have.tools_hash,
            contract.tools_hash
        );
    }
    let proofs = prove(dir, mode)?;
    write_files(dir, &contract)?;
    manifest["contract"] = contract.to_json();
    manifest["heldout"] = json!({ "repo": heldout_repo });
    std::fs::write(&path, serde_json::to_string_pretty(&manifest)?)?;
    Ok((contract, proofs))
}
