//! The environment a harness process is spawned with (#1020, D-1020-AS1).
//!
//! ## The PATH scrub, and the bug it prevents
//!
//! `spawn-env.ts:1`–`:5`: `npm run` and `bun run` prepend **every ancestor's**
//! `node_modules/.bin` to `PATH`. A repository that happens to have a `claude`
//! or `codex` shim in one of those directories silently shadows the member's
//! real CLI, and the failure is invisible: the harness launches, speaks
//! something that is not ACP, and the turn fails with a parse error nobody can
//! trace to a `PATH` entry. So those entries are stripped unconditionally.
//!
//! On a real launch this is a no-op — only run-script injection creates them —
//! which is exactly why it is safe to do unconditionally.
//!
//! An explicit `bin_path` skips the scrub, because it skips the PATH lookup
//! altogether: scrubbing a variable nothing is going to read would only make
//! the child's environment differ from its parent's for no reason.
//!
//! ## Order, and why the kind's `env` is applied last
//!
//! `docs/harnesses.md:65`: a kind's `env` is applied **after** this, so it can
//! override an inherited variable but never the sanitised `PATH`. That ordering
//! lives in the caller ([`crate::acp`]); this module hands back the base.

use std::collections::BTreeMap;

/// The platform's `PATH` separator. `;` on Windows, `:` everywhere else.
#[must_use]
pub const fn path_separator() -> char {
    if cfg!(windows) { ';' } else { ':' }
}

/// Whether one `PATH` entry is a `node_modules/.bin` directory.
///
/// Both separators are accepted regardless of host, because a `PATH` can be
/// inherited from a shell that wrote the other one — a WSL process started from
/// a Windows launcher is the ordinary case.
#[must_use]
pub fn is_node_modules_bin(entry: &str) -> bool {
    let trimmed = entry.trim_end_matches(['/', '\\']);
    let lowered = trimmed.replace('\\', "/");
    lowered.ends_with("/node_modules/.bin") || lowered == "node_modules/.bin"
}

/// Strip every `node_modules/.bin` entry, preserving every other entry and its
/// order.
#[must_use]
pub fn sanitize_path(value: &str) -> String {
    let separator = path_separator();
    value
        .split(separator)
        .filter(|entry| !is_node_modules_bin(entry))
        .collect::<Vec<&str>>()
        .join(&separator.to_string())
}

/// How to build the base environment for a harness process.
#[derive(Debug, Clone, Default)]
pub struct SpawnEnvOptions {
    /// An explicit harness binary: leaves `PATH` unsanitized, because no PATH
    /// lookup happens.
    pub bin_path: Option<String>,
    /// Prepended after sanitization, so the harness finds `centraid` by bare
    /// name (D-1020-AS7).
    pub extra_path: Option<String>,
}

/// A fresh environment map. Never a mutation of the caller's: mutating a shared
/// base would race concurrent turns (`spawn-env.ts:30`).
#[must_use]
pub fn harness_spawn_env(
    base: &BTreeMap<String, String>,
    options: &SpawnEnvOptions,
) -> BTreeMap<String, String> {
    let separator = path_separator();
    let current = base.get("PATH").map_or("", String::as_str);
    let sanitized = if options.bin_path.is_some() {
        current.to_owned()
    } else {
        sanitize_path(current)
    };
    let final_path = match &options.extra_path {
        Some(extra) if !sanitized.is_empty() => format!("{extra}{separator}{sanitized}"),
        Some(extra) => extra.clone(),
        None => sanitized,
    };
    let mut out = base.clone();
    out.insert("PATH".to_owned(), final_path);
    out
}

/// This process's environment, as the map the rest of the module takes.
#[must_use]
pub fn inherited() -> BTreeMap<String, String> {
    std::env::vars().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base(path: &str) -> BTreeMap<String, String> {
        BTreeMap::from([("PATH".to_owned(), path.to_owned())])
    }

    #[test]
    fn every_node_modules_bin_is_stripped_and_order_is_kept() {
        let value =
            "/repo/node_modules/.bin:/usr/local/bin:/repo/apps/web/node_modules/.bin:/usr/bin";
        assert_eq!(sanitize_path(value), "/usr/local/bin:/usr/bin");
    }

    #[test]
    fn a_trailing_separator_does_not_defeat_the_match() {
        assert!(is_node_modules_bin("/repo/node_modules/.bin/"));
        assert!(is_node_modules_bin("C:\\repo\\node_modules\\.bin"));
        assert!(!is_node_modules_bin("/repo/node_modules/.binaries"));
        assert!(!is_node_modules_bin("/usr/bin"));
    }

    #[test]
    fn an_explicit_bin_path_leaves_path_alone() {
        let env = harness_spawn_env(
            &base("/repo/node_modules/.bin:/usr/bin"),
            &SpawnEnvOptions {
                bin_path: Some("/opt/codex".to_owned()),
                extra_path: None,
            },
        );
        assert_eq!(
            env["PATH"], "/repo/node_modules/.bin:/usr/bin",
            "no PATH lookup happens, so there is nothing to scrub"
        );
    }

    #[test]
    fn extra_path_is_prepended_after_the_scrub() {
        let env = harness_spawn_env(
            &base("/repo/node_modules/.bin:/usr/bin"),
            &SpawnEnvOptions {
                bin_path: None,
                extra_path: Some("/opt/centraid/bin".to_owned()),
            },
        );
        assert_eq!(env["PATH"], "/opt/centraid/bin:/usr/bin");
    }

    #[test]
    fn a_scrub_that_empties_path_still_carries_the_extra_entry() {
        let env = harness_spawn_env(
            &base("/repo/node_modules/.bin"),
            &SpawnEnvOptions {
                bin_path: None,
                extra_path: Some("/opt/centraid/bin".to_owned()),
            },
        );
        assert_eq!(env["PATH"], "/opt/centraid/bin");
    }

    #[test]
    fn the_base_map_is_never_mutated() {
        let original = base("/repo/node_modules/.bin:/usr/bin");
        let _ = harness_spawn_env(&original, &SpawnEnvOptions::default());
        assert_eq!(original["PATH"], "/repo/node_modules/.bin:/usr/bin");
    }
}
