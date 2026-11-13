//! `datagen publish`: a built data version to a Hugging Face dataset repo, one revision per version.
//!
//! The command checks first and uploads last. [`prepare`] reads the version's manifest, re-hashes every file the manifest
//! lists, and refuses a version that is not fit to leave the machine (a file that does not match its hash, a build from a
//! dirty tree, a version not marked publishable, a file that holds a sealed placeholder). It lays the files out as the
//! trainer fetches them and writes the dataset card. A dry run prints that layout and stops; it is the default.
//!
//! Rust does the checking, the layout, the card and the dry run, because those are what can be tested offline. The one
//! network step, the commit to the repo, is done by `huggingface_hub` (the Hub's commit and large-file protocol is not
//! reimplemented here): [`upload`] hands it the staged tree. The token is read from `HF_TOKEN` in the environment, passed
//! on to that one child through its environment and nowhere else, and never printed, written or put on a command line.
//!
//! The layout (`train` and `val` apart from `test`, so a fetch of the two named files cannot pull the test split):
//!
//! ```text
//! manifest.json            README.md (the dataset card)
//! data/train.jsonl.zst     data/val.jsonl.zst     data/noise.jsonl.zst     data/train-1000.jsonl.zst ...
//! worlds/<train and val worlds>.json               build/<reports>
//! test/test.jsonl.zst      test/worlds/<test worlds>.json
//! ```
//!
//! A version never overwrites an earlier one: it is committed to a branch of its own and then tagged with its name, the
//! tag is the revision, and a tag or branch that already exists is refused before anything is sent.

use std::fmt::Write as _;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use anyhow::{Context, Result, bail};
use serde_json::Value;

/// The environment variable the token is read from.
pub const TOKEN_ENV: &str = "HF_TOKEN";

/// The repo the owner named for this project's data; the example in `--help` and the runbook.
pub const EXAMPLE_REPO: &str = "srikanth235/centraid-native-data";

/// What a staged file is made of.
#[derive(Debug, Clone)]
pub enum Source {
    File(PathBuf),
    Text(String),
}

/// One file of the upload: where it goes, what it is and its size and hash.
#[derive(Debug, Clone)]
pub struct Staged {
    pub remote: String,
    pub source: Source,
    pub bytes: u64,
    pub blake3: String,
}

/// A version ready to go: the manifest's name for it and every file, the dataset card included.
#[derive(Debug, Clone)]
pub struct Publication {
    pub version: String,
    pub files: Vec<Staged>,
}

/// Where a file of the version goes in the repo.
fn remote_path(rel: &str) -> String {
    if rel == "data/test.jsonl.zst" {
        return "test/test.jsonl.zst".to_owned();
    }
    if let Some(name) = rel.strip_prefix("worlds/") {
        return if name.starts_with("test-") {
            format!("test/worlds/{name}")
        } else {
            format!("worlds/{name}")
        };
    }
    rel.to_owned()
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
pub fn card(manifest: &Value, repo: &str) -> String {
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
        "Revision `{version}` of `{repo}`. `manifest.json` lists every data file with its size and blake3.\n\n- `data/train.jsonl.zst`, `data/val.jsonl.zst`: the splits to train and validate on; `data/noise.jsonl.zst` is val with heavy typos.\n- nested train subsets for a learning curve: `data/train-<n>.jsonl.zst` (each is a subset of the next one and of train)\n- `test/`: the test split and its worlds, apart from everything else. **Never train on it.** (In `manifest.json` its file is listed as `data/test.jsonl.zst`; here it is `test/test.jsonl.zst`.)\n- `worlds/`: the worlds the sessions name; `build/`: the reports of the build.\n"
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

/// Check a built version and lay it out for the repo.
///
/// # Errors
///
/// Every reason the version must not be published, listed together: no manifest, a file that does not match its hash,
/// a build from a dirty tree, a version not marked publishable, a file that holds a sealed placeholder.
pub fn prepare(dir: &Path, repo: &str) -> Result<Publication> {
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
                files.push(Staged {
                    remote: remote_path(rel),
                    source: Source::File(path),
                    bytes,
                    blake3: hash,
                });
            }
        }
    }
    files.push(Staged {
        remote: "manifest.json".to_owned(),
        bytes: manifest_text.len() as u64,
        blake3: blake3::hash(manifest_text.as_bytes()).to_hex().to_string(),
        source: Source::File(manifest_path),
    });
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
            let (bytes, hash) = hash_file(&path)?;
            files.push(Staged {
                remote: remote_path(&rel),
                source: Source::File(path),
                bytes,
                blake3: hash,
            });
        }
    }
    for f in &files {
        if let Source::File(p) = &f.source
            && holds_placeholder(p).unwrap_or(false)
        {
            problems.push(format!("{}: holds a sealed placeholder", f.remote));
        }
    }
    let card_text = card(&manifest, repo);
    files.push(Staged {
        remote: "README.md".to_owned(),
        bytes: card_text.len() as u64,
        blake3: blake3::hash(card_text.as_bytes()).to_hex().to_string(),
        source: Source::Text(card_text),
    });
    files.sort_by(|a, b| a.remote.cmp(&b.remote));
    if !problems.is_empty() {
        bail!(
            "{version} is not fit to publish:\n  - {}",
            problems.join("\n  - ")
        );
    }
    Ok(Publication { version, files })
}

/// The dry run: every file with its size and hash, and what a real upload would do. Nothing is sent.
#[must_use]
pub fn dry_run(p: &Publication, repo: Option<&str>, private: bool) -> String {
    let mut out = String::new();
    let _ = writeln!(
        out,
        "dry run: nothing is uploaded. revision `{}`{}, {}",
        p.version,
        repo.map_or_else(String::new, |r| format!(" of dataset repo `{r}`")),
        if private { "private" } else { "PUBLIC" }
    );
    let total: u64 = p.files.iter().map(|f| f.bytes).sum();
    for f in &p.files {
        let _ = writeln!(out, "  {:>12}  {}  {}", f.bytes, f.blake3, f.remote);
    }
    let _ = writeln!(out, "  {total:>12}  total in {} files", p.files.len());
    let _ = writeln!(
        out,
        "to upload: datagen publish --in <version dir> --repo {} --upload   (HF_TOKEN in the environment)",
        repo.unwrap_or(EXAMPLE_REPO)
    );
    out
}

/// The transport: `huggingface_hub`, run by `python3` with this script on its standard input. It reads the token from
/// `HF_TOKEN` itself; the arguments are the repo, the version, the staged directory and `private` or `public`.
const TRANSPORT: &str = r#"
import sys
from huggingface_hub import HfApi
repo, version, folder, visibility = sys.argv[1:5]
api = HfApi()
api.create_repo(repo, repo_type="dataset", private=(visibility == "private"), exist_ok=True)
refs = api.list_repo_refs(repo, repo_type="dataset")
taken = {t.name for t in refs.tags} | {b.name for b in refs.branches}
branch = "incoming-" + version
if version in taken or branch in taken:
    sys.exit("revision %s already exists in %s: a version is never overwritten" % (version, repo))
api.create_branch(repo, branch=branch, repo_type="dataset")
info = api.upload_folder(repo_id=repo, repo_type="dataset", folder_path=folder, revision=branch,
                         commit_message="data version " + version)
api.create_tag(repo, tag=version, revision=info.oid, repo_type="dataset")
api.delete_branch(repo, branch=branch, repo_type="dataset")
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
) -> (Vec<String>, &'static str) {
    (
        vec![
            python.to_owned(),
            "-".to_owned(),
            repo.to_owned(),
            version.to_owned(),
            folder.display().to_string(),
            if private { "private" } else { "public" }.to_owned(),
        ],
        TRANSPORT,
    )
}

/// Write the staged tree under `staging` in the repo's layout.
///
/// # Errors
///
/// If a file cannot be copied.
pub fn stage(p: &Publication, staging: &Path) -> Result<()> {
    for f in &p.files {
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

/// A real upload of `p` to `repo` with `token` (from [`token_from_env`]).
///
/// # Errors
///
/// A repo that is not owner/name, or the transport failed. The token is never in the message.
pub fn upload(
    p: &Publication,
    repo: &str,
    private: bool,
    python: &str,
    token: &str,
) -> Result<String> {
    if repo.trim().is_empty() || !repo.contains('/') {
        bail!("--repo takes an owner/name, for example {EXAMPLE_REPO}");
    }
    let staging = tempfile::tempdir()?;
    stage(p, staging.path())?;
    let (args, script) = transport_command(python, repo, &p.version, staging.path(), private);
    let mut child = Command::new(&args[0])
        .args(&args[1..])
        // the token reaches the one child through its environment, never through an argument or the script
        .env(TOKEN_ENV, token)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .with_context(|| format!("starting {}", args[0]))?;
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
        bail!("the upload failed ({}): {}", out.status, err.trim());
    }
    Ok(String::from_utf8_lossy(&out.stdout)
        .replace(token, "<token>")
        .trim()
        .to_owned())
}
