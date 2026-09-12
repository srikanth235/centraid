//! Where the two npm adapters come from, and why not from `npx` (#1020,
//! D-1020-AS1).
//!
//! ## Two of seventeen kinds need a Node process
//!
//! `codex` and `claude-code` have no ACP mode of their own
//! (`docs/harnesses.md:67`). Each speaks the protocol through a **pinned npm
//! package**, and the process the gateway spawns is node running that package's
//! `bin` — never its `main`, which is a library entry
//! (`adapter-bin.ts:1`–`:2`). The member's own `claude` or `codex` binary is
//! passed to the adapter through an environment variable.
//!
//! This is the one place the Rust gateway has a runtime dependency it cannot
//! satisfy itself. The fifteen native kinds need only a process spawn.
//!
//! ## Never `npx -y` at turn time
//!
//! `registry.ts:5`–`:6` states it as law, and it is worth restating why: `npx
//! -y` *fetches and executes a package from the network at the moment a turn
//! starts*. That is an unreviewed download in the hot path of a door that has
//! the member's vault open, and it fails on an aeroplane. (The
//! `agent-client-protocol` crate's own `AcpAgent::claude_agent()` convenience
//! constructor does exactly this — it is not used.)
//!
//! So an adapter is **discovered**, never fetched:
//!
//! 1. `CENTRAID_ACP_ADAPTER_DIR`, when set: the directory an operator or a
//!    packaged build put the adapters in. Checked first, so a packaged install
//!    is self-contained and deterministic.
//! 2. The per-user directory `centraid assist adapters install` writes to,
//!    which runs `npm i -g --prefix <dir>` **once, on purpose, with output the
//!    member sees**, and then prints what it did.
//!
//! When neither has it, preflight reports the kind unavailable *with the
//! install verb in the hint* ([`crate::registry::RegistryError::AdapterMissing`]).
//! Warn, never block: the other fifteen kinds still work.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use crate::registry::AdapterHost;

/// The environment variable a packaged build or an operator sets.
pub const ADAPTER_DIR_ENV: &str = "CENTRAID_ACP_ADAPTER_DIR";

/// The two packages, in the order the fixture lists their kinds.
pub const ADAPTER_PACKAGES: [&str; 2] = [
    "@agentclientprotocol/codex-acp",
    "@agentclientprotocol/claude-agent-acp",
];

/// Candidate directories an adapter may live under, most specific first.
#[must_use]
pub fn search_path(env: &BTreeMap<String, String>, data_dir: &Path) -> Vec<PathBuf> {
    let mut found = Vec::new();
    if let Some(configured) = env.get(ADAPTER_DIR_ENV) {
        found.push(PathBuf::from(configured));
    }
    // What the install verb writes to: `<data-dir>/acp-adapters`, beside the
    // vault rather than inside it — it is a cache of third-party code, not
    // member data, and a backup must not carry it.
    found.push(data_dir.join("acp-adapters"));
    found
}

/// Resolve every adapter that is actually present.
///
/// A package is present when `<dir>/node_modules/<package>/package.json` exists
/// AND names a `bin`. The `bin` field is read rather than guessed: the two
/// packages do not agree on a file name, and a guessed path that happens to
/// exist as a library entry would launch a process that never speaks a frame.
#[must_use]
pub fn discover(env: &BTreeMap<String, String>, data_dir: &Path, node: PathBuf) -> AdapterHost {
    let mut scripts = BTreeMap::new();
    for directory in search_path(env, data_dir) {
        for package in ADAPTER_PACKAGES {
            if scripts.contains_key(package) {
                continue;
            }
            let root = directory.join("node_modules").join(package);
            if let Some(script) = bin_of(&root) {
                scripts.insert(package.to_owned(), script);
            }
        }
    }
    AdapterHost { node, scripts }
}

/// The adapter's stdio entry, from its own `package.json`.
fn bin_of(root: &Path) -> Option<PathBuf> {
    let manifest = std::fs::read_to_string(root.join("package.json")).ok()?;
    let parsed: serde_json::Value = serde_json::from_str(&manifest).ok()?;
    let bin = parsed.get("bin")?;
    let relative = match bin {
        // `"bin": "./dist/index.js"`
        serde_json::Value::String(path) => path.clone(),
        // `"bin": { "<name>": "./dist/index.js" }` — one entry in both
        // packages; the first in key order when there is more than one, so the
        // choice is deterministic rather than whatever the map iterated to.
        serde_json::Value::Object(map) => {
            let mut names: Vec<&String> = map.keys().collect();
            names.sort();
            map.get(names.first()?.as_str())?.as_str()?.to_owned()
        }
        _ => return None,
    };
    let script = root.join(relative.trim_start_matches("./"));
    script.is_file().then_some(script)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(path: &Path, body: &str) {
        std::fs::create_dir_all(path.parent().expect("has a parent")).expect("mkdir");
        std::fs::write(path, body).expect("write");
    }

    #[test]
    fn the_environment_directory_is_searched_before_the_installed_one() {
        let temp = tempfile::tempdir().expect("tempdir");
        let packaged = temp.path().join("packaged");
        let installed = temp.path().join("data/acp-adapters");
        let package = "@agentclientprotocol/codex-acp";
        for root in [&packaged, &installed] {
            write(
                &root.join("node_modules").join(package).join("package.json"),
                r#"{"bin":{"codex-acp":"./dist/index.js"}}"#,
            );
            write(
                &root
                    .join("node_modules")
                    .join(package)
                    .join("dist/index.js"),
                "// stub",
            );
        }
        let env = BTreeMap::from([(
            ADAPTER_DIR_ENV.to_owned(),
            packaged.display().to_string(),
        )]);
        let host = discover(&env, &temp.path().join("data"), PathBuf::from("node"));
        assert_eq!(
            host.scripts.get(package),
            Some(&packaged.join("node_modules").join(package).join("dist/index.js")),
            "a packaged install must win over a per-user one"
        );
    }

    #[test]
    fn a_package_whose_bin_file_is_absent_is_not_discovered() {
        let temp = tempfile::tempdir().expect("tempdir");
        let package = "@agentclientprotocol/claude-agent-acp";
        write(
            &temp
                .path()
                .join("acp-adapters/node_modules")
                .join(package)
                .join("package.json"),
            r#"{"bin":{"claude-agent-acp":"./dist/index.js"}}"#,
        );
        let host = discover(&BTreeMap::new(), temp.path(), PathBuf::from("node"));
        assert!(
            host.scripts.is_empty(),
            "a manifest naming a bin that is not there is not an installed adapter"
        );
    }

    #[test]
    fn a_manifest_with_only_a_main_entry_is_refused() {
        let temp = tempfile::tempdir().expect("tempdir");
        let package = "@agentclientprotocol/codex-acp";
        let root = temp.path().join("acp-adapters/node_modules").join(package);
        write(&root.join("package.json"), r#"{"main":"./dist/lib.js"}"#);
        write(&root.join("dist/lib.js"), "// a library entry");
        let host = discover(&BTreeMap::new(), temp.path(), PathBuf::from("node"));
        assert!(
            host.scripts.is_empty(),
            "`main` is a library entry and launching it would never speak a frame"
        );
    }

    #[test]
    fn nothing_installed_is_an_empty_host_not_an_error() {
        let temp = tempfile::tempdir().expect("tempdir");
        let host = discover(&BTreeMap::new(), temp.path(), PathBuf::from("node"));
        assert!(host.scripts.is_empty());
        assert_eq!(host.node, PathBuf::from("node"));
    }
}
