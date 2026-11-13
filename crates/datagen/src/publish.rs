//! `datagen publish`: a built data version to two Hugging Face dataset repos, one tag per version in each.
//!
//! The command checks first and uploads last. [`prepare`] reads the version's manifest, re-hashes every file the manifest
//! lists, and refuses a version that is not fit to leave the machine (a file that does not match its hash, a build from a
//! dirty tree, a version not marked publishable, a file that holds a sealed placeholder, a manifest without a contract
//! or contract files that do not hash to it). It splits the files between the two repos and writes the cards. A dry run
//! prints both sets and stops; it is the default.
//!
//! Rust does the checking, the layout, the cards, the plan and the dry run, because those are what can be tested
//! offline. The network steps, a read-only listing and the commit, are done by `huggingface_hub` (the Hub's commit and
//! large-file protocol is not reimplemented here): [`list_remote`] and [`upload`] hand it the staged trees. The token is
//! read from `HF_TOKEN` in the environment, passed on to those children through their environment and nowhere else, and
//! never printed, written or put on a command line.
//!
//! The data repo (`--repo`, what the trainer fetches) and the held-out repo (`--heldout-repo`, evaluation only):
//!
//! ```text
//! data repo                                         held-out repo
//! README.md  manifest.json                          README.md  manifest.json (the same bytes)
//! contract/{tools.json,system.txt,hashes.json}      test/test.jsonl.zst
//! data/{train,val,noise}.jsonl.zst                  worlds/test/<test worlds>.json
//! data/subsets/train-<n>.jsonl.zst                  cache/llm-cache.jsonl.zst   (names test sessions)
//! worlds/train/*.json  worlds/val/*.json
//! reports/<the build's text and JSON reports>
//! ```
//!
//! Nothing of test or the cache is in the data repo's set. A version is one commit on `main` and one tag with its name in
//! each repo, `main` always the latest version's tree; a version never overwrites an earlier one, a tag that already
//! exists in either repo is refused before anything is sent, and the held-out repo is committed first so a data tag
//! never exists without its held-out one. A version's tree is exactly its set: the commit also deletes every other path
//! of `main`'s tree ([`plan`]), except the repo's plumbing, [`KEPT`].

use std::fmt::Write as _;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use anyhow::{Context, Result, bail};
use serde_json::Value;

use crate::contract::{self, Contract};
use crate::version;

/// The environment variable the token is read from.
pub const TOKEN_ENV: &str = "HF_TOKEN";

/// The data repo the owner named: what the trainer fetches; the example in `--help` and the runbook.
pub const DATA_REPO: &str = "srikanth235/centraid-assist-data";

/// The held-out repo the owner named: the test split, its worlds and the LLM cache. Evaluation only.
pub const HELDOUT_REPO: &str = "srikanth235/centraid-assist-heldout";

/// The data repo, as the examples name it.
pub const EXAMPLE_REPO: &str = DATA_REPO;

/// Which of the two repos a file goes to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Repo {
    Data,
    Heldout,
}

/// What a staged file is made of.
#[derive(Debug, Clone)]
pub enum Source {
    File(PathBuf),
    Text(String),
}

/// One file of the upload: which repo and where it goes, what it is and its size and hash.
#[derive(Debug, Clone)]
pub struct Staged {
    pub repo: Repo,
    pub remote: String,
    pub source: Source,
    pub bytes: u64,
    pub blake3: String,
}

/// A version ready to go: the manifest's name for it, every file of both repos, the cards included, and the held-out
/// repo's name.
#[derive(Debug, Clone)]
pub struct Publication {
    pub version: String,
    pub heldout_repo: String,
    pub files: Vec<Staged>,
}

impl Publication {
    /// The paths of the publish set of `repo`, sorted.
    #[must_use]
    pub fn set(&self, repo: Repo) -> Vec<String> {
        let mut paths: Vec<String> = self
            .files
            .iter()
            .filter(|f| f.repo == repo)
            .map(|f| f.remote.clone())
            .collect();
        paths.sort();
        paths
    }
}

/// Which repo, and where in it, a file of the built version goes.
fn remote_path(rel: &str) -> (Repo, String) {
    if rel == "data/test.jsonl.zst" {
        return (Repo::Heldout, "test/test.jsonl.zst".to_owned());
    }
    if rel == "build/llm-cache.jsonl.zst" {
        return (Repo::Heldout, "cache/llm-cache.jsonl.zst".to_owned());
    }
    if let Some(name) = rel.strip_prefix("worlds/") {
        return if name.starts_with("test-") {
            (Repo::Heldout, format!("worlds/test/{name}"))
        } else if name.starts_with("val-") {
            (Repo::Data, format!("worlds/val/{name}"))
        } else {
            (Repo::Data, format!("worlds/train/{name}"))
        };
    }
    if let Some(name) = rel.strip_prefix("data/train-") {
        return (Repo::Data, format!("data/subsets/train-{name}"));
    }
    if let Some(name) = rel.strip_prefix("build/") {
        return (Repo::Data, format!("reports/{name}"));
    }
    (Repo::Data, rel.to_owned())
}

fn hash_file(path: &Path) -> Result<(u64, String)> {
    let mut file =
        std::fs::File::open(path).with_context(|| format!("reading {}", path.display()))?;
    let mut hasher = blake3::Hasher::new();
    let mut buf = vec![0_u8; 1 << 20];
    let mut bytes = 0_u64;
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        bytes += n as u64;
    }
    Ok((bytes, hasher.finalize().to_hex().to_string()))
}

/// Does the file hold a sealed placeholder (`placeholder:<key>:<field>`, what a world seeds in memory) or a datagen
/// placeholder? A `.zst` file is read decompressed.
fn holds_placeholder(path: &Path) -> Result<bool> {
    const NEEDLES: [&[u8]; 2] = ["placeholder:".as_bytes(), "⟨m3:".as_bytes()];
    let file = std::fs::File::open(path)?;
    let mut reader: Box<dyn Read> = if path.extension().is_some_and(|e| e == "zst") {
        Box::new(zstd::stream::Decoder::new(file)?)
    } else {
        Box::new(file)
    };
    let mut carry: Vec<u8> = Vec::new();
    let mut buf = vec![0_u8; 1 << 20];
    loop {
        let n = reader.read(&mut buf)?;
        if n == 0 {
            return Ok(false);
        }
        carry.extend_from_slice(&buf[..n]);
        for needle in NEEDLES {
            if carry.windows(needle.len()).any(|w| w == needle) {
                return Ok(true);
            }
        }
        // a needle can straddle two reads
        let keep = carry.len().min(16);
        carry.drain(..carry.len() - keep);
    }
}

fn pct(v: f64) -> String {
    format!("{:.1}%", 100.0 * v)
}

/// The dataset card: what the data is, how it was made, what it holds and what it does not, from the manifest alone.
#[must_use]
pub fn card(manifest: &Value, repo: &str, heldout: &str) -> String {
    let text = |p: &Value| p.as_str().unwrap_or("unknown").to_owned();
    let version = text(&manifest["version"]);
    let mut out = String::new();
    let _ = writeln!(
        out,
        "---\nlanguage:\n- en\nlicense: other\npretty_name: Centraid native data {version}\ntags:\n- synthetic\n- tool-use\nconfigs:\n- config_name: default\n  data_files:\n  - split: train\n    path: data/train.jsonl.zst\n  - split: validation\n    path: data/val.jsonl.zst\n---\n"
    );
    let _ = writeln!(out, "# Centraid native data {version}\n");
    let _ = writeln!(
        out,
        "Training data for a LoRA adapter on the stock Qwen3.5-0.8B base, for the vault turns of Centraid's chat assistant (read, count, measure, create, edit, do, ask, decline, repair). Every session is a conversation between a member and the assistant over a synthetic vault. **All of it is synthetic and English**: no real person, vault or secret is in it.\n"
    );
    let _ = writeln!(out, "## How it was made\n");
    let _ = writeln!(
        out,
        "1. **Worlds**: seeded synthetic vaults (names, rows, dates, rupee and other currency amounts), a new member's empty vault and a very large one among them. Worlds are split by seed and by name pool, so no world and no person name is in two splits. Locker values are presence only: a sealed value is never generated, so none is in this data.\n2. **Intents**: typed requests drawn over the grid of tool, kind and verb. The correct answer of every turn is what the runtime does when the reference calls are run against the world; no model writes an answer.\n3. **Messages**: a language model writes what a member would type for each intent, in a style (terse, dictated, typos, long and polite, correction); a different model reads each message back and its slots (act, kind, period, numbers, filters, names, exclusions) must match the intent, or the turn is dropped.\n4. **Repairs**: a repair turn shows a call the runtime really refuses, its real refusal, and the call that fixes it; the refused call is masked from the loss.\n5. **Mix**: sessions are chosen to the shares below, with a floor of sessions for every live cell of the grid.\n"
    );
    let _ = writeln!(out, "## What the data was built from\n");
    let _ = writeln!(
        out,
        "- catalog hash: `{}`\n- runtime commit: `{}`\n- tokenizer: `{}` (blake3 `{}`)\n- sealed values: absent. Every file was scanned for a sealed placeholder before it was published.",
        text(&manifest["catalog_hash"]),
        text(&manifest["runtime_commit"]),
        text(&manifest["tokenizer"]["file"]),
        text(&manifest["tokenizer"]["blake3"]),
    );
    let msgs = &manifest["messages"];
    if msgs.is_object() {
        let _ = writeln!(
            out,
            "- writers by split: `{}`; readers by split: `{}`",
            msgs["writers"], msgs["readers"]
        );
        if let Some(styles) = msgs["styles"].as_object() {
            let mut line = String::new();
            for (name, s) in styles {
                let _ = write!(
                    line,
                    "{name} {} of {} keep their style; ",
                    s["complying"], s["written"]
                );
            }
            let _ = writeln!(out, "- styles: {line}");
        }
    }
    let _ = writeln!(out, "\n## Layout\n");
    let _ = writeln!(
        out,
        "Revision `{version}` of `{repo}`; the same tag in `{heldout}`. `manifest.json` lists every data file with its size and blake3.\n\n- `data/train.jsonl.zst`, `data/val.jsonl.zst`: the splits to train and validate on; `data/noise.jsonl.zst` is val with heavy typos.\n- nested train subsets for a learning curve: `data/subsets/train-<n>.jsonl.zst` (each is a subset of the next one and of train)\n- `worlds/train/`, `worlds/val/`: the worlds the sessions name; `reports/`: the reports of the build.\n- `contract/`: the tool contract the data was rendered for (below).\n- **The test split is not here.** It, its worlds and the packed LLM cache are in the held-out repo `{heldout}` at the same tag (`test/test.jsonl.zst`, `worlds/test/`, `cache/llm-cache.jsonl.zst`), for evaluation only. **Never train on it.** (In `manifest.json` its file is listed as `data/test.jsonl.zst`.)\n"
    );
    let _ = writeln!(out, "## Contract\n");
    let c = &manifest["contract"];
    let _ = writeln!(
        out,
        "The records were rendered with the runtime's tools block in mode `{}`. `contract/tools.json` is the tool catalogue and `contract/system.txt` the static prompt, exactly as the runtime hashes them; `contract/hashes.json` holds the hashes. When the runtime's tools no longer hash to these, this version is for a contract the app no longer serves.\n\n- tools_hash: `{}`\n- prompt_hash: `{}`\n- catalog_hash: `{}`\n- tokenizer blake3: `{}`\n",
        text(&c["tools_mode"]),
        text(&c["tools_hash"]),
        text(&c["prompt_hash"]),
        text(&c["catalog_hash"]),
        text(&c["tokenizer_blake3"]),
    );
    let _ = writeln!(out, "## Realised shares against their targets\n");
    for split in manifest["splits"].as_array().into_iter().flatten() {
        let name = text(&split["split"]);
        let _ = writeln!(
            out,
            "### {name}: {} sessions, {} turns (target {} sessions)\n",
            split["sessions"], split["turns"], split["target"]
        );
        for share in split["shares"].as_array().into_iter().flatten() {
            let _ = write!(out, "- {}: ", text(&share["share"]));
            let lines: Vec<String> = share["lines"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|l| {
                    let total: f64 = share["lines"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .map(|x| x["realised"].as_f64().unwrap_or(0.0))
                        .sum();
                    let of = |k: &str| l[k].as_f64().unwrap_or(0.0) / total.max(1.0);
                    format!(
                        "{} {} (asked {})",
                        text(&l["name"]),
                        pct(of("realised")),
                        pct(of("requested"))
                    )
                })
                .collect();
            let _ = writeln!(out, "{}", lines.join(", "));
        }
        for m in split["missed"].as_array().into_iter().flatten() {
            let _ = writeln!(out, "- not hit: {}", text(m));
        }
        let _ = writeln!(out);
    }
    let _ = writeln!(out, "## Limits\n");
    let _ = writeln!(
        out,
        "- Amounts are written in thousands and plain numbers; the runtime does not resolve `lakh` or `crore`, so the data does not teach them.\n- A request for something the runtime has no behaviour for is not in the data; the build report lists those kinds.\n- The correct answer is the runtime's at the commit above, not a statement about any real person."
    );
    out
}

/// The card of the held-out repo: what it is for and what must never be done with it.
#[must_use]
pub fn heldout_card(version: &str, repo: &str, data_repo: &str) -> String {
    format!(
        "---\nlanguage:\n- en\nlicense: other\npretty_name: Centraid held-out data {version}\ntags:\n- synthetic\n---\n\n# Centraid held-out data {version}\n\n**For evaluation only. Never train on it.** The test split of data version `{version}` of `{data_repo}`, kept in a repo of its own so a fetch of the training data cannot pull it.\n\n- `test/test.jsonl.zst`, `worlds/test/`: the test split and the worlds it names.\n- `cache/llm-cache.jsonl.zst`: the packed writer and reader cache of the build. It holds the text of test sessions, which is why it is here; it is what lets a rebuild run offline.\n- `manifest.json`: the same file as in the data repo, so a revision of `{repo}` names its data.\n"
    )
}

/// Stage one file of the built version under its place in the repo it goes to.
fn stage_file(files: &mut Vec<Staged>, rel: &str, path: PathBuf) -> Result<()> {
    let (bytes, blake3) = hash_file(&path)?;
    let (repo, remote) = remote_path(rel);
    files.push(Staged {
        repo,
        remote,
        source: Source::File(path),
        bytes,
        blake3,
    });
    Ok(())
}

/// Stage a text under `remote` of `repo`.
fn stage_text(files: &mut Vec<Staged>, repo: Repo, remote: &str, text: String) {
    files.push(Staged {
        repo,
        remote: remote.to_owned(),
        bytes: text.len() as u64,
        blake3: blake3::hash(text.as_bytes()).to_hex().to_string(),
        source: Source::Text(text),
    });
}

/// Check a built version and lay it out for the two repos. `repo` names the data repo; `heldout` the held-out one, which
/// is the manifest's own pointer when not given and must be that pointer when given.
///
/// # Errors
///
/// Every reason the version must not be published, listed together: no manifest, a file that does not match its hash,
/// a build from a dirty tree, a version not marked publishable, a file that holds a sealed placeholder, no contract
/// block in the manifest or contract files that do not hash to it, a held-out repo other than the manifest's pointer,
/// no packed LLM cache.
#[allow(clippy::too_many_lines)]
pub fn prepare(dir: &Path, repo: &str, heldout: Option<&str>) -> Result<Publication> {
    let manifest_path = dir.join("manifest.json");
    let manifest_text = std::fs::read_to_string(&manifest_path)
        .with_context(|| format!("no manifest.json in {}", dir.display()))?;
    let manifest: Value =
        serde_json::from_str(&manifest_text).context("manifest.json is not JSON")?;
    let version = manifest["version"]
        .as_str()
        .filter(|v| !v.is_empty())
        .context("the manifest names no version")?
        .to_owned();
    let mut problems: Vec<String> = Vec::new();
    let mut files: Vec<Staged> = Vec::new();

    let commit = manifest["runtime_commit"].as_str().unwrap_or("unknown");
    if commit.ends_with("-dirty") || commit == "unknown" {
        problems.push(format!(
            "built from a dirty tree or an unknown commit (`{commit}`): rebuild from a clean checkout"
        ));
    }
    if manifest["publishable"]["value"] != true {
        let why = manifest["publishable"]["blockers"].to_string();
        problems.push(format!("the version is not marked publishable: {why}"));
    }

    // the contract: the block, its files, and the pointer to the held-out repo
    match Contract::of_manifest(&manifest) {
        None => problems.push(
            "the manifest has no contract block: run `datagen restamp --in <version dir>` (a version built before the block existed) or rebuild".to_owned(),
        ),
        Some(contract) => {
            problems.extend(contract::file_problems(dir, &contract));
            if manifest["catalog_hash"].as_str() != Some(contract.catalog_hash.as_str()) {
                problems.push("the contract's catalog_hash is not the manifest's".to_owned());
            }
            if manifest["tokenizer"]["blake3"].as_str() != Some(contract.tokenizer_blake3.as_str())
            {
                problems.push("the contract's tokenizer hash is not the manifest's".to_owned());
            }
            for rel in [contract::TOOLS, contract::SYSTEM, contract::HASHES] {
                // a file that cannot be read is already reported by `file_problems`
                let _ = stage_file(&mut files, rel, dir.join(rel));
            }
        }
    }
    let pointer = manifest["heldout"]["repo"]
        .as_str()
        .filter(|r| !r.is_empty());
    let heldout_repo = match (pointer, heldout) {
        (Some(p), Some(h)) if p != h => {
            problems.push(format!(
                "the manifest points to the held-out repo `{p}`, not `{h}`: rebuild or restamp it"
            ));
            h.to_owned()
        }
        (Some(p), _) => p.to_owned(),
        (None, h) => {
            problems
                .push("the manifest has no `heldout` pointer: run `datagen restamp`".to_owned());
            h.unwrap_or(HELDOUT_REPO).to_owned()
        }
    };

    let listed = manifest["files"].as_object().cloned().unwrap_or_default();
    if listed.is_empty() {
        problems.push("the manifest lists no files".to_owned());
    }
    for (rel, entry) in &listed {
        let path = dir.join(rel);
        match hash_file(&path) {
            Err(_) => problems.push(format!("{rel}: listed in the manifest but not on disk")),
            Ok((bytes, hash)) => {
                if entry["blake3"].as_str() != Some(hash.as_str()) {
                    problems.push(format!(
                        "{rel}: its hash {hash} is not the manifest's {}",
                        entry["blake3"]
                    ));
                }
                let (to, remote) = remote_path(rel);
                files.push(Staged {
                    repo: to,
                    remote,
                    source: Source::File(path),
                    bytes,
                    blake3: hash,
                });
            }
        }
    }
    // the manifest goes to both repos, byte for byte
    for to in [Repo::Data, Repo::Heldout] {
        files.push(Staged {
            repo: to,
            remote: "manifest.json".to_owned(),
            bytes: manifest_text.len() as u64,
            blake3: blake3::hash(manifest_text.as_bytes()).to_hex().to_string(),
            source: Source::File(manifest_path.clone()),
        });
    }
    // the worlds and the build's reports: not in the manifest's list, hashed here
    for (sub, ext_ok) in [("worlds", &["json"][..]), ("build", &["txt", "json"][..])] {
        let Ok(read) = std::fs::read_dir(dir.join(sub)) else {
            continue;
        };
        let mut paths: Vec<PathBuf> = read.filter_map(|e| e.ok().map(|e| e.path())).collect();
        paths.sort();
        for path in paths {
            let ok = path
                .extension()
                .and_then(|e| e.to_str())
                .is_some_and(|e| ext_ok.contains(&e));
            if !ok || !path.is_file() {
                continue;
            }
            let rel = format!(
                "{sub}/{}",
                path.file_name().unwrap_or_default().to_string_lossy()
            );
            stage_file(&mut files, &rel, path)?;
        }
    }
    // the packed LLM cache: it names test sessions, so it goes to the held-out repo, and it must go, so a rebuild is offline
    let cache = dir.join(version::BUILD).join(version::PACKED_CACHE);
    if cache.is_file() {
        stage_file(
            &mut files,
            &format!("{}/{}", version::BUILD, version::PACKED_CACHE),
            cache,
        )?;
    } else {
        problems.push(format!(
            "{}/{}: the packed LLM cache is missing, and a rebuild would need the network without it",
            version::BUILD,
            version::PACKED_CACHE
        ));
    }
    for f in &files {
        if let Source::File(p) = &f.source
            && holds_placeholder(p).unwrap_or(false)
        {
            problems.push(format!("{}: holds a sealed placeholder", f.remote));
        }
    }
    let card_text = card(&manifest, repo, &heldout_repo);
    stage_text(&mut files, Repo::Data, "README.md", card_text);
    stage_text(
        &mut files,
        Repo::Heldout,
        "README.md",
        heldout_card(&version, &heldout_repo, repo),
    );
    files.sort_by(|a, b| (a.repo, &a.remote).cmp(&(b.repo, &b.remote)));
    // nothing of test or the cache may be in the data repo's set
    for f in files.iter().filter(|f| f.repo == Repo::Data) {
        if f.remote.contains("test")
            && (f.remote.starts_with("data/") || f.remote.starts_with("worlds/"))
            || f.remote.starts_with("test/")
            || f.remote.starts_with("cache/")
        {
            problems.push(format!(
                "{}: test material in the data repo's set",
                f.remote
            ));
        }
    }
    if !problems.is_empty() {
        bail!(
            "{version} is not fit to publish:\n  - {}",
            problems.join("\n  - ")
        );
    }
    Ok(Publication {
        version,
        heldout_repo,
        files,
    })
}

/// Repo plumbing that is not part of any version and is never deleted: the LFS rules the Hub needs to store the data.
pub const KEPT: [&str; 1] = [".gitattributes"];

/// What the one commit of a publish does to one repo's tree.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Plan {
    /// Every path of the publish set: added when the repo lacks it, replaced when it has it.
    pub puts: Vec<String>,
    /// Every path of the remote tree that is not in the publish set and not plumbing, sorted: removed in the commit.
    pub deletes: Vec<String>,
}

/// The commit a publish makes to one repo, from its publish set and the paths its base tree holds. A pure function:
/// the result holds the whole publish set to put and every other remote path to delete, except [`KEPT`].
#[must_use]
pub fn plan(publish_set: &[String], remote: &[String]) -> Plan {
    let wanted: std::collections::BTreeSet<&str> = publish_set.iter().map(String::as_str).collect();
    let mut deletes: Vec<String> = remote
        .iter()
        .filter(|r| !wanted.contains(r.as_str()) && !KEPT.contains(&r.as_str()))
        .cloned()
        .collect();
    deletes.sort();
    deletes.dedup();
    Plan {
        puts: wanted.into_iter().map(str::to_owned).collect(),
        deletes,
    }
}

/// What a repo holds now: the paths of `main`'s tree and the names of its tags.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Remote {
    pub files: Vec<String>,
    pub tags: Vec<String>,
}

/// Every reason the upload must not start, from what the two repos hold: the version's tag exists in one of them.
#[must_use]
pub fn tag_problems(version: &str, data: &Remote, heldout: &Remote) -> Vec<String> {
    [("data", data), ("held-out", heldout)]
        .into_iter()
        .filter(|(_, r)| r.tags.iter().any(|t| t == version))
        .map(|(which, _)| {
            format!("the tag `{version}` already exists in the {which} repo: a version is never overwritten")
        })
        .collect()
}

/// The dry run: every file of both repos with its size and hash, and what a real upload would do. Nothing is sent.
/// `remote` is the two repos' current state, data then held-out, when they were read (a read-only listing), and then the
/// paths each commit would remove are listed.
#[must_use]
pub fn dry_run(
    p: &Publication,
    repo: Option<&str>,
    private: bool,
    remote: Option<(&Remote, &Remote)>,
) -> String {
    let mut out = String::new();
    let _ = writeln!(
        out,
        "dry run: nothing is uploaded. version `{}`, one commit and one tag in each of two repos, {}",
        p.version,
        if private { "private" } else { "PUBLIC" }
    );
    for (to, name, seen) in [
        (Repo::Data, repo.unwrap_or(DATA_REPO), remote.map(|r| r.0)),
        (Repo::Heldout, p.heldout_repo.as_str(), remote.map(|r| r.1)),
    ] {
        let mine: Vec<&Staged> = p.files.iter().filter(|f| f.repo == to).collect();
        let total: u64 = mine.iter().map(|f| f.bytes).sum();
        let _ = writeln!(
            out,
            "\n{} repo `{name}`:",
            if to == Repo::Data { "data" } else { "held-out" }
        );
        for f in &mine {
            let _ = writeln!(out, "  {:>12}  {}  {}", f.bytes, f.blake3, f.remote);
        }
        let _ = writeln!(out, "  {total:>12}  total in {} files", mine.len());
        match seen {
            Some(tree) => {
                let planned = plan(&p.set(to), &tree.files);
                let _ = writeln!(
                    out,
                    "  the tree is exactly these files; {} path(s) of the repo's tree would be removed in the commit (kept: {}):",
                    planned.deletes.len(),
                    KEPT.join(", ")
                );
                for d in &planned.deletes {
                    let _ = writeln!(out, "    remove  {d}");
                }
                if tree.tags.contains(&p.version) {
                    let _ = writeln!(
                        out,
                        "  WOULD BE REFUSED: the tag `{}` already exists here: a version is never overwritten",
                        p.version
                    );
                }
            }
            None => {
                let _ = writeln!(
                    out,
                    "  paths of the repo's tree outside this list would be removed in the commit; they are listed when the dry run is given --repo and {TOKEN_ENV} (a read-only listing)"
                );
            }
        }
    }
    let _ = writeln!(
        out,
        "\nto upload: datagen publish --in <version dir> --repo {} --heldout-repo {} --upload   (HF_TOKEN in the environment)",
        repo.unwrap_or(DATA_REPO),
        p.heldout_repo
    );
    out
}

/// The read-only transport: `huggingface_hub` lists the files of the repo's `main` and its tags, printed as a JSON
/// object `{"files": [...], "tags": [...]}` (both empty for a repo that does not exist yet). The argument is the repo.
const LIST_TRANSPORT: &str = r#"
import json, sys
from huggingface_hub import HfApi
from huggingface_hub.utils import RepositoryNotFoundError, RevisionNotFoundError
api = HfApi()
try:
    files = sorted(api.list_repo_files(sys.argv[1], repo_type="dataset", revision="main"))
    tags = sorted(t.name for t in api.list_repo_refs(sys.argv[1], repo_type="dataset").tags)
except (RepositoryNotFoundError, RevisionNotFoundError):
    files, tags = [], []
print(json.dumps({"files": files, "tags": tags}))
"#;

/// The write transport: `huggingface_hub`, run by `python3` with this script on its standard input. It reads the token
/// from `HF_TOKEN` itself; the arguments are the repo, the version, the staged directory, `private` or `public` and a
/// JSON file listing the paths to delete. One commit on `main` puts every staged file and deletes those paths, so the
/// tree, and the tag's, is the publish set. `create_commit` on `main` is atomic, so there is no branch to stage on: if
/// the tag step then fails, `main` holds the tree without a tag, which no reader pins, and a rerun plans from it.
const TRANSPORT: &str = r#"
import json, os, sys
from huggingface_hub import CommitOperationAdd, CommitOperationDelete, HfApi
repo, version, folder, visibility, deletes_file = sys.argv[1:6]
deletes = json.load(open(deletes_file))
api = HfApi()
api.create_repo(repo, repo_type="dataset", private=(visibility == "private"), exist_ok=True)
if version in {t.name for t in api.list_repo_refs(repo, repo_type="dataset").tags}:
    sys.exit("tag %s already exists in %s: a version is never overwritten" % (version, repo))
ops = []
for root, _, names in os.walk(folder):
    for name in names:
        path = os.path.join(root, name)
        ops.append(CommitOperationAdd(path_in_repo=os.path.relpath(path, folder).replace(os.sep, "/"), path_or_fileobj=path))
ops += [CommitOperationDelete(path_in_repo=d) for d in deletes]
info = api.create_commit(repo_id=repo, repo_type="dataset", operations=ops, revision="main",
                         commit_message="data version " + version)
api.create_tag(repo, tag=version, revision=info.oid, repo_type="dataset")
print("published %s@%s" % (repo, version))
"#;

/// The command a real upload runs: the program, its arguments, and the script it reads. The token is in none of them.
#[must_use]
pub fn transport_command(
    python: &str,
    repo: &str,
    version: &str,
    folder: &Path,
    private: bool,
    deletes_file: &Path,
) -> (Vec<String>, &'static str) {
    (
        vec![
            python.to_owned(),
            "-".to_owned(),
            repo.to_owned(),
            version.to_owned(),
            folder.display().to_string(),
            if private { "private" } else { "public" }.to_owned(),
            deletes_file.display().to_string(),
        ],
        TRANSPORT,
    )
}

/// Run `python` with `script` on its standard input and `args`, the token in its environment only.
fn run_python(python: &str, args: &[String], script: &str, token: &str) -> Result<String> {
    let mut child = Command::new(python)
        .arg("-")
        .args(args)
        // the token reaches the one child through its environment, never through an argument or the script
        .env(TOKEN_ENV, token)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .with_context(|| format!("starting {python}"))?;
    {
        use std::io::Write as _;
        child
            .stdin
            .take()
            .context("no stdin")?
            .write_all(script.as_bytes())?;
    }
    let out = child.wait_with_output()?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).replace(token, "<token>");
        bail!("the transport failed ({}): {}", out.status, err.trim());
    }
    Ok(String::from_utf8_lossy(&out.stdout)
        .replace(token, "<token>")
        .trim()
        .to_owned())
}

fn check_repo_name(repo: &str) -> Result<()> {
    if repo.trim().is_empty() || !repo.contains('/') {
        bail!("a repo takes an owner/name, for example {DATA_REPO}");
    }
    Ok(())
}

/// What the repo holds now: `main`'s tree and its tags, a read-only listing, no commit.
///
/// # Errors
///
/// A repo that is not owner/name, or the listing failed. The token is never in the message.
pub fn list_remote(repo: &str, python: &str, token: &str) -> Result<Remote> {
    check_repo_name(repo)?;
    let text = run_python(python, &[repo.to_owned()], LIST_TRANSPORT, token)?;
    let v: Value = serde_json::from_str(&text)
        .context("the listing of the repo is not a JSON object of files and tags")?;
    let names = |k: &str| -> Result<Vec<String>> {
        v[k].as_array()
            .context("the listing of the repo lacks a list")?
            .iter()
            .map(|n| {
                n.as_str()
                    .map(str::to_owned)
                    .context("a name in the listing is not text")
            })
            .collect()
    };
    Ok(Remote {
        files: names("files")?,
        tags: names("tags")?,
    })
}

/// Write the staged tree of `repo` under `staging` in the repo's layout.
///
/// # Errors
///
/// If a file cannot be copied.
pub fn stage(p: &Publication, repo: Repo, staging: &Path) -> Result<()> {
    for f in p.files.iter().filter(|f| f.repo == repo) {
        let to = staging.join(&f.remote);
        if let Some(parent) = to.parent() {
            std::fs::create_dir_all(parent)?;
        }
        match &f.source {
            Source::File(from) => {
                std::fs::copy(from, &to)?;
            }
            Source::Text(t) => std::fs::write(&to, t)?,
        }
    }
    Ok(())
}

/// The token from the environment.
///
/// # Errors
///
/// When `HF_TOKEN` is not set. The message never holds a token.
pub fn token_from_env() -> Result<String> {
    match std::env::var(TOKEN_ENV) {
        Ok(t) if !t.trim().is_empty() => Ok(t),
        _ => bail!("{TOKEN_ENV} is not set in the environment: nothing was uploaded"),
    }
}

/// A real upload of `p`: one commit and one tag with the version's name in the held-out repo and then in `repo` (the data
/// repo), with `token` (from [`token_from_env`]). Both repos are read first and nothing is sent if the tag exists in either.
///
/// # Errors
///
/// A repo that is not owner/name, a tag that already exists, or the transport failed. The token is never in the message.
pub fn upload(
    p: &Publication,
    repo: &str,
    private: bool,
    python: &str,
    token: &str,
) -> Result<String> {
    check_repo_name(repo)?;
    check_repo_name(&p.heldout_repo)?;
    let data_remote = list_remote(repo, python, token)?;
    let heldout_remote = list_remote(&p.heldout_repo, python, token)?;
    let problems = tag_problems(&p.version, &data_remote, &heldout_remote);
    if !problems.is_empty() {
        bail!("nothing was sent: {}", problems.join("; "));
    }
    let mut said = Vec::new();
    for (to, name, remote) in [
        (Repo::Heldout, p.heldout_repo.as_str(), &heldout_remote),
        (Repo::Data, repo, &data_remote),
    ] {
        let planned = plan(&p.set(to), &remote.files);
        let staging = tempfile::tempdir()?;
        stage(p, to, staging.path())?;
        // outside the staged tree, so it is not uploaded
        let aside = tempfile::tempdir()?;
        let deletes_file = aside.path().join("deletes.json");
        std::fs::write(&deletes_file, serde_json::to_vec(&planned.deletes)?)?;
        let (args, script) = transport_command(
            python,
            name,
            &p.version,
            staging.path(),
            private,
            &deletes_file,
        );
        said.push(run_python(python, &args[2..], script, token)?);
    }
    Ok(said.join("\n"))
}
