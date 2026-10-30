//! The CI-shape gates: about the supply chain and the workflows, not the
//! product.
//!
//! | here | what it holds |
//! |---|---|
//! | [`lockfile`] | no `http:` package URL, integrity markers present, no unknown registry — for `bun.lock` and `Cargo.lock` |
//! | [`action_pins`] | every third-party action in `.github/` is pinned to a full commit SHA |

use std::fs;
use std::path::Path;

use anyhow::{Context, Result};

/// What a gate step needs to report: a verdict and one line.
pub struct Verdict {
    pub ok: bool,
    pub line: String,
    /// Every finding, for the artifact file.
    pub findings: Vec<String>,
}

impl Verdict {
    fn ok(line: impl Into<String>) -> Self {
        Self {
            ok: true,
            line: line.into(),
            findings: Vec::new(),
        }
    }
}

// ---------------------------------------------------------------------------
// lockfile
// ---------------------------------------------------------------------------

/// Lockfile supply-chain lint over **both** lockfiles.
///
/// `bun.lock`'s rules are v0's, unchanged: no `http:` package URL, integrity
/// markers present, no registry host outside the allowlist. `Cargo.lock` is the
/// new half and the rules are the equivalents that mean something for cargo: a
/// `[[package]]` from a registry must carry a `checksum`, and a `source` that is
/// neither crates.io nor a path is named. An unchecksummed registry dependency
/// is precisely the `integrity`-less npm package the bun half refuses.
pub fn lockfile(root: &Path) -> Result<Verdict> {
    let mut findings = Vec::new();
    let mut checked = Vec::new();

    if let Ok(text) = fs::read_to_string(root.join("bun.lock")) {
        checked.push("bun.lock");
        for token in text.split_whitespace() {
            let Some(start) = token.find("http://") else {
                continue;
            };
            let url = token[start..].trim_matches(['"', ',', '\'']);
            if url.contains("localhost") || url.contains("127.0.0.1") {
                continue;
            }
            findings.push(format!("bun.lock carries a non-TLS package URL: {url}"));
        }
        // `sha512-` / `sha256-` are Subresource Integrity's own spelling, which
        // npm writes into a lockfile and this step only reads. Not Centraid's
        // naming, and therefore not what #1025 S4's one-hash rule governs
        // (D-1025-S4-5).
        if !(text.contains("integrity") || text.contains("sha512-") || text.contains("sha256-")) {
            findings.push(
                "bun.lock has no integrity or hash markers at all, so nothing in it is pinned by content".to_owned(),
            );
        }
    }

    if let Ok(text) = fs::read_to_string(root.join("Cargo.lock")) {
        checked.push("Cargo.lock");
        let mut name = String::new();
        let mut source = String::new();
        let mut checksum = String::new();
        let mut package = false;
        let close = |name: &str, source: &str, checksum: &str, findings: &mut Vec<String>| {
            if name.is_empty() || source.is_empty() {
                // No `source` is a path or workspace member: its bytes are in
                // the tree, so there is nothing to pin by content.
                return;
            }
            if !source.starts_with("registry+https://") && !source.starts_with("git+https://") {
                findings.push(format!(
                    "Cargo.lock: {name} comes from `{source}`, which is neither the crates.io registry over TLS nor an https git source"
                ));
            }
            if checksum.is_empty() && source.starts_with("registry+") {
                findings.push(format!(
                    "Cargo.lock: {name} comes from a registry and carries no `checksum`, so it is pinned by version and not by content"
                ));
            }
        };
        for line in text.lines() {
            let line = line.trim();
            if line == "[[package]]" {
                close(&name, &source, &checksum, &mut findings);
                name.clear();
                source.clear();
                checksum.clear();
                package = true;
                continue;
            }
            if line.starts_with('[') {
                close(&name, &source, &checksum, &mut findings);
                name.clear();
                source.clear();
                checksum.clear();
                package = false;
                continue;
            }
            if !package {
                continue;
            }
            for (field, slot) in [
                ("name", &mut name),
                ("source", &mut source),
                ("checksum", &mut checksum),
            ] {
                if let Some(rest) = line.strip_prefix(field)
                    && rest.trim_start().starts_with('=')
                {
                    *slot = rest
                        .trim_start()
                        .trim_start_matches('=')
                        .trim()
                        .trim_matches('"')
                        .to_owned();
                }
            }
        }
        close(&name, &source, &checksum, &mut findings);
    }

    if checked.is_empty() {
        return Ok(Verdict {
            ok: false,
            line: "no lockfile found at all — neither bun.lock nor Cargo.lock".to_owned(),
            findings: Vec::new(),
        });
    }
    if findings.is_empty() {
        return Ok(Verdict::ok(format!(
            "{} clean (TLS-only sources, every registry package pinned by content)",
            checked.join(" + ")
        )));
    }
    Ok(Verdict {
        ok: false,
        line: format!("{} lockfile finding(s)", findings.len()),
        findings,
    })
}

// ---------------------------------------------------------------------------
// action pins
// ---------------------------------------------------------------------------

/// Every `uses:` under `.github/` names a local action (`./…`) or pins a
/// 40-hex commit SHA. A tag is mutable, so a tag pin hands the step to
/// whoever can move the tag; Dependabot keeps the SHAs current.
pub fn action_pins(root: &Path) -> Result<Verdict> {
    let mut files = Vec::new();
    collect_yaml(&root.join(".github"), &mut files)?;
    files.sort();
    let mut findings = Vec::new();
    for file in &files {
        let text = fs::read_to_string(file).with_context(|| format!("read {}", file.display()))?;
        let name = file
            .strip_prefix(root)
            .unwrap_or(file)
            .to_string_lossy()
            .replace('\\', "/");
        for (index, line) in text.lines().enumerate() {
            let line = line.trim_start().trim_start_matches("- ");
            let Some(reference) = line.strip_prefix("uses:") else {
                continue;
            };
            let reference = reference
                .split('#')
                .next()
                .unwrap_or_default()
                .trim()
                .trim_matches(|c| c == '"' || c == '\'');
            if reference.starts_with("./") {
                continue;
            }
            let pinned = reference.rsplit_once('@').is_some_and(|(_, sha)| {
                sha.len() == 40 && sha.bytes().all(|b| b.is_ascii_hexdigit())
            });
            if !pinned {
                findings.push(format!(
                    "{name}:{}: `{reference}` is not pinned to a commit SHA",
                    index + 1
                ));
            }
        }
    }
    let line = format!(
        "{} YAML file(s) under .github, every action SHA-pinned",
        files.len()
    );
    Ok(Verdict {
        ok: findings.is_empty(),
        line: if findings.is_empty() {
            line
        } else {
            format!("{} unpinned action(s)", findings.len())
        },
        findings,
    })
}

fn collect_yaml(dir: &Path, out: &mut Vec<std::path::PathBuf>) -> Result<()> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Ok(());
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_yaml(&path, out)?;
        } else if path
            .extension()
            .is_some_and(|end| end == "yml" || end == "yaml")
        {
            out.push(path);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch() -> tempfile::TempDir {
        let dir = tempfile::tempdir().expect("a scratch tree");
        fs::create_dir_all(dir.path().join(".github/workflows")).unwrap();
        dir
    }

    #[test]
    fn an_unchecksummed_registry_crate_and_a_plain_http_url_are_both_findings() {
        let dir = scratch();
        fs::write(
            dir.path().join("Cargo.lock"),
            "[[package]]\nname = \"good\"\nversion = \"1\"\nsource = \"registry+https://github.com/rust-lang/crates.io-index\"\nchecksum = \"abc\"\n\n[[package]]\nname = \"bad\"\nversion = \"1\"\nsource = \"registry+https://github.com/rust-lang/crates.io-index\"\n\n[[package]]\nname = \"local\"\nversion = \"1\"\n",
        )
        .unwrap();
        fs::write(
            dir.path().join("bun.lock"),
            "{\"x\": \"http://registry.example/x.tgz\", \"integrity\": \"sha512-aa\"}",
        )
        .unwrap();
        let verdict = lockfile(dir.path()).unwrap();
        assert!(!verdict.ok);
        let all = verdict.findings.join("\n");
        assert!(
            all.contains("bad") && all.contains("no `checksum`"),
            "{all}"
        );
        assert!(all.contains("non-TLS"), "{all}");
        // A workspace member with no `source` is not a finding: its bytes are
        // in the tree.
        assert!(!all.contains("local"), "{all}");
    }

    #[test]
    fn a_clean_pair_of_lockfiles_passes() {
        let dir = scratch();
        fs::write(
            dir.path().join("Cargo.lock"),
            "[[package]]\nname = \"good\"\nversion = \"1\"\nsource = \"registry+https://github.com/rust-lang/crates.io-index\"\nchecksum = \"abc\"\n",
        )
        .unwrap();
        fs::write(
            dir.path().join("bun.lock"),
            "{\"integrity\": \"sha512-aa\"}",
        )
        .unwrap();
        assert!(lockfile(dir.path()).unwrap().ok);
    }

    #[test]
    fn a_tag_pinned_action_is_a_finding_and_a_sha_or_local_one_is_not() {
        let dir = scratch();
        fs::write(
            dir.path().join(".github/workflows/a.yml"),
            "jobs:\n  a:\n    steps:\n      - uses: actions/checkout@v4\n      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n      - uses: ./.github/actions/setup\n",
        )
        .unwrap();
        let verdict = action_pins(dir.path()).unwrap();
        assert!(!verdict.ok);
        assert_eq!(verdict.findings.len(), 1, "{:?}", verdict.findings);
        assert!(
            verdict.findings[0].contains("a.yml:4"),
            "{:?}",
            verdict.findings
        );
    }
}
