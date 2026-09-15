//! The harness registry, as data (#1020, D-1020-AS1).
//!
//! ## The law, restated because it is the whole design
//!
//! `packages/server/src/acp/registry.ts:1`–`:7`: **nothing else branches on the
//! kind.** Seventeen kinds are registered; they differ only in how the ACP
//! process is launched — natively, or through a pinned adapter, *never an
//! `npx -y` fetch at turn time*. Every one of those differences is a field in
//! `contracts/assist/harnesses.json`, generated from v0 by
//! `contracts/tools/export-harnesses.ts`, embedded here with `include_str!`.
//!
//! So this module answers exactly one question — *what process, with what
//! arguments and what environment* — and [`LaunchPlan`] is that answer. The turn
//! plane, preflight and model enumeration all take a `LaunchPlan` and have no
//! opinion about the kind that produced it.
//!
//! ## Two lists, and why both survive the port
//!
//! `HARNESSES` has 17 entries; `SUPPORTED_HARNESS_KINDS` has **five**
//! (`codex, claude-code, opencode, grok, pi`). Twelve registered kinds are
//! launchable and are not in the supported list. A port that kept one list
//! would either drop twelve working kinds or claim support for twelve it has
//! not verified, so both are carried and [`Harness::supported`] is the
//! distinction.
//!
//! ## `refuse_args`: two prose SAFETY notes turned into a rule
//!
//! `registry.ts:232`–`:235` and `:270` are comments. A comment cannot stop a
//! member from typing `--mdns` into the extra-args box in Settings, and
//! `--mdns` defaults opencode's listen host to `0.0.0.0` — an unauthenticated
//! code-execution harness published to the whole LAN. So the fixture carries
//! the refused arguments per kind and [`Registry::plan`] refuses a launch that
//! names one, with the sentence that says why.

use std::collections::BTreeMap;
use std::path::PathBuf;

use serde::Deserialize;

/// The generated fixture, compiled in. A shipped binary carries the registry it
/// was built with and never looks for a repository path.
const HARNESSES_JSON: &str = include_str!("../../../contracts/assist/harnesses.json");

/// A minimum version, as the three numbers v0 compares.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct Version {
    pub major: u64,
    pub minor: u64,
    pub patch: u64,
}

impl Version {
    /// The first `N.N.N` anywhere in a line of `--version` output.
    ///
    /// No leading word boundary, because `v1.2.3` has a word character before
    /// the digit (`preflight.ts:197`).
    #[must_use]
    pub fn find_in(text: &str) -> Option<Self> {
        let bytes: Vec<char> = text.chars().collect();
        let mut at = 0usize;
        while at < bytes.len() {
            if !bytes[at].is_ascii_digit() {
                at += 1;
                continue;
            }
            let start = at;
            let mut parts: Vec<u64> = Vec::new();
            let mut cursor = start;
            let mut ok = true;
            for index in 0..3 {
                let digits_from = cursor;
                while cursor < bytes.len() && bytes[cursor].is_ascii_digit() {
                    cursor += 1;
                }
                if cursor == digits_from {
                    ok = false;
                    break;
                }
                let number: String = bytes[digits_from..cursor].iter().collect();
                parts.push(number.parse().unwrap_or(0));
                if index < 2 {
                    if cursor < bytes.len() && bytes[cursor] == '.' {
                        cursor += 1;
                    } else {
                        ok = false;
                        break;
                    }
                }
            }
            if ok && parts.len() == 3 {
                return Some(Self {
                    major: parts[0],
                    minor: parts[1],
                    patch: parts[2],
                });
            }
            at = start + 1;
            while at < bytes.len() && bytes[at].is_ascii_digit() {
                at += 1;
            }
        }
        None
    }
}

impl std::fmt::Display for Version {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(out, "{}.{}.{}", self.major, self.minor, self.patch)
    }
}

impl<'de> Deserialize<'de> for Version {
    fn deserialize<D: serde::Deserializer<'de>>(source: D) -> Result<Self, D::Error> {
        let text = String::deserialize(source)?;
        Self::find_in(&text)
            .ok_or_else(|| serde::de::Error::custom(format!("not a version: {text}")))
    }
}

/// The npm package that speaks ACP on a kind's behalf.
///
/// Two of seventeen kinds need one (`codex`, `claude-code`): they have no ACP
/// mode of their own, so the process actually spawned is **node running the
/// adapter's `bin`**, and the user's real CLI is passed to it through
/// `bin_path_env_var`. `defaultBin` still names the user-facing CLI even for
/// these, which is what makes `HarnessPrefs.binPath` mean *the harness CLI*
/// rather than *the process spawned* (`docs/harnesses.md:69`–`:71`).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Adapter {
    pub package_name: String,
    pub bin_path_env_var: String,
    /// `claude-code` is launched in `bypassPermissions`: a gateway turn has no
    /// approval UI and the default mode deadlocks (`registry.ts:203`).
    pub session_mode_id: Option<String>,
    pub bypass_needs_sandbox_when_root: bool,
}

/// An argument this kind must never be launched with, and the sentence saying
/// why. See the module header.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RefusedArg {
    pub arg: String,
    pub because: String,
}

/// One registered kind.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Harness {
    pub kind: String,
    pub label: String,
    /// The user-facing CLI. `None` for the custom `acp` escape hatch, which is
    /// why preflight must never spawn `undefined --version`
    /// (`preflight.ts:140`).
    pub default_bin: Option<String>,
    pub acp_args: Vec<String>,
    pub min_version: Version,
    pub install_hint: String,
    pub env: BTreeMap<String, String>,
    pub adapter: Option<Adapter>,
    /// The model-name resolver v0 attaches to this kind, by NAME. One kind has
    /// one (`claude-code`); resolving it is the caller's, so the fixture stays
    /// data.
    pub resolve_model: Option<String>,
    /// Off by default: the probe SPAWNS the harness at boot (`registry.ts:56`).
    pub probe_models: bool,
    pub refuse_args: Vec<RefusedArg>,
    /// Filled in by [`Registry::load`] from `supportedKinds`; not a field of
    /// the per-kind fixture entry.
    #[serde(skip)]
    pub supported: bool,
}

/// Launch overrides a member has set in Settings → Agents.
#[derive(Debug, Clone, Default)]
pub struct Prefs {
    /// An explicit path to the harness CLI. Skips PATH lookup entirely, and
    /// (for an adapter kind) is forwarded through the adapter's env var rather
    /// than becoming the spawned process.
    pub bin_path: Option<String>,
    pub extra_args: Vec<String>,
    /// Prepended to `PATH` after the scrub, so a harness finds `centraid` by
    /// bare name — which is how the builder harness's shell calls
    /// `centraid assist` (D-1020-AS7).
    pub extra_path: Option<String>,
}

/// What to spawn. The one answer this module exists to give.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LaunchPlan {
    pub kind: String,
    pub program: PathBuf,
    pub args: Vec<String>,
    /// Applied AFTER the PATH scrub, so a kind can override an inherited
    /// variable but never the sanitised `PATH` (`docs/harnesses.md:65`).
    pub env: BTreeMap<String, String>,
    /// Present when this kind is launched through an npm adapter: the turn plane
    /// needs it to set the session mode, and preflight to report the hint.
    pub adapter: Option<Adapter>,
}

/// Why a launch could not be planned. Every variant is a sentence a member can
/// act on, never a code.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum RegistryError {
    #[error("no harness is registered for the kind `{kind}`")]
    UnknownKind { kind: String },
    #[error(
        "`{arg}` cannot be used with {kind}: {because}. Remove it from the extra arguments in \
         Settings → Agents."
    )]
    RefusedArg {
        kind: String,
        arg: String,
        because: String,
    },
    #[error("{kind} has no binary configured — set its path in Settings → Agents. {install_hint}")]
    NoBinary { kind: String, install_hint: String },
    #[error(
        "{kind} speaks ACP through the {package} adapter, which is not installed. Run `centraid \
         assist adapters install` (or set CENTRAID_ACP_ADAPTER_DIR to a directory holding it)."
    )]
    AdapterMissing { kind: String, package: String },
}

/// Where the two npm adapters are found, and what hosts them.
#[derive(Debug, Clone)]
pub struct AdapterHost {
    /// The executable that runs an adapter's `bin`. An adapter's stdio entry is
    /// its package's `bin`, **never its `main`** (a library entry), so this is
    /// node and the argument is a script path (`adapter-bin.ts:1`–`:2`).
    pub node: PathBuf,
    /// Resolved adapter scripts by package name. Empty means "none installed",
    /// which preflight reports as unavailable-with-a-hint rather than guessing.
    pub scripts: BTreeMap<String, PathBuf>,
}

impl Default for AdapterHost {
    fn default() -> Self {
        Self {
            node: PathBuf::from("node"),
            scripts: BTreeMap::new(),
        }
    }
}

/// The catalogue: seventeen kinds and the five-name supported list.
#[derive(Debug, Clone)]
pub struct Registry {
    harnesses: Vec<Harness>,
    supported: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Fixture {
    supported_kinds: Vec<String>,
    harnesses: Vec<Harness>,
}

impl Registry {
    /// The compiled-in registry.
    ///
    /// # Panics
    ///
    /// Never in a shipped build: the fixture is generated, formatted and
    /// committed, and `crates/assist/tests/registry.rs` parses it. A panic here
    /// means the embedded bytes are not the fixture, which is a build problem
    /// rather than a runtime one.
    #[must_use]
    pub fn load() -> Self {
        let fixture: Fixture = serde_json::from_str(HARNESSES_JSON)
            .expect("contracts/assist/harnesses.json is generated and must parse");
        let supported = fixture.supported_kinds;
        let harnesses = fixture
            .harnesses
            .into_iter()
            .map(|mut harness| {
                harness.supported = supported.contains(&harness.kind);
                harness
            })
            .collect();
        Self {
            harnesses,
            supported,
        }
    }

    #[must_use]
    pub fn all(&self) -> &[Harness] {
        &self.harnesses
    }

    /// The five kinds v0 declares supported, in v0's order.
    #[must_use]
    pub fn supported_kinds(&self) -> &[String] {
        &self.supported
    }

    #[must_use]
    pub fn get(&self, kind: &str) -> Option<&Harness> {
        self.harnesses.iter().find(|harness| harness.kind == kind)
    }

    /// Plan a launch, or say why it cannot be planned.
    ///
    /// The order matters. The refusal check runs on the FULL argument list —
    /// the kind's own `acpArgs` plus whatever a member added — because the whole
    /// point is that a refused argument cannot arrive through the extra-args
    /// box.
    pub fn plan(
        &self,
        kind: &str,
        prefs: &Prefs,
        adapters: &AdapterHost,
    ) -> Result<LaunchPlan, RegistryError> {
        let harness = self.get(kind).ok_or_else(|| RegistryError::UnknownKind {
            kind: kind.to_owned(),
        })?;

        let mut args: Vec<String> = harness.acp_args.clone();
        args.extend(prefs.extra_args.iter().cloned());
        for refused in &harness.refuse_args {
            if args.iter().any(|arg| argument_names(arg, &refused.arg)) {
                return Err(RegistryError::RefusedArg {
                    kind: harness.kind.clone(),
                    arg: refused.arg.clone(),
                    because: refused.because.clone(),
                });
            }
        }

        let mut env = harness.env.clone();

        if let Some(adapter) = &harness.adapter {
            // AN ADAPTER KIND. The process is node running the adapter's bin;
            // the member's `binPath` is the HARNESS CLI and rides through the
            // adapter's environment variable, never onto the command line.
            let script = adapters.scripts.get(&adapter.package_name).ok_or_else(|| {
                RegistryError::AdapterMissing {
                    kind: harness.kind.clone(),
                    package: adapter.package_name.clone(),
                }
            })?;
            if let Some(bin_path) = &prefs.bin_path {
                env.insert(adapter.bin_path_env_var.clone(), bin_path.clone());
            }
            let mut adapter_args = vec![script.display().to_string()];
            adapter_args.extend(args);
            return Ok(LaunchPlan {
                kind: harness.kind.clone(),
                program: adapters.node.clone(),
                args: adapter_args,
                env,
                adapter: Some(adapter.clone()),
            });
        }

        let program = prefs
            .bin_path
            .clone()
            .or_else(|| harness.default_bin.clone())
            .ok_or_else(|| RegistryError::NoBinary {
                kind: harness.kind.clone(),
                install_hint: harness.install_hint.clone(),
            })?;
        Ok(LaunchPlan {
            kind: harness.kind.clone(),
            program: PathBuf::from(program),
            args,
            env,
            adapter: None,
        })
    }
}

/// Whether one argument token names a refused flag.
///
/// `--mdns`, `--mdns=1` and `--mdns 1` must all be caught; `--mdns-off` must
/// not be, because a different flag that happens to share a prefix is a
/// different flag.
fn argument_names(argument: &str, flag: &str) -> bool {
    argument == flag
        || argument
            .strip_prefix(flag)
            .is_some_and(|rest| rest.starts_with('='))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seventeen_kinds_and_five_supported() {
        let registry = Registry::load();
        assert_eq!(registry.all().len(), 17);
        assert_eq!(
            registry.supported_kinds(),
            ["codex", "claude-code", "opencode", "grok", "pi"]
        );
        assert_eq!(
            registry.all().iter().filter(|h| h.supported).count(),
            5,
            "twelve registered kinds are deliberately NOT in the supported list"
        );
    }

    #[test]
    fn droid_launches_with_its_three_arguments() {
        let registry = Registry::load();
        let plan = registry
            .plan("droid", &Prefs::default(), &AdapterHost::default())
            .expect("droid is native");
        assert_eq!(plan.program, PathBuf::from("droid"));
        assert_eq!(plan.args, ["exec", "--output-format", "acp-daemon"]);
        assert_eq!(
            plan.env
                .get("DROID_DISABLE_AUTO_UPDATE")
                .map(String::as_str),
            Some("true")
        );
    }

    #[test]
    fn kimi_takes_the_subcommand_not_the_flag() {
        let registry = Registry::load();
        let plan = registry
            .plan("kimi", &Prefs::default(), &AdapterHost::default())
            .expect("kimi is native");
        assert_eq!(
            plan.args,
            ["acp"],
            "the flag is single-session with no session/load"
        );
    }

    #[test]
    fn opencode_refuses_mdns_from_extra_args() {
        let registry = Registry::load();
        let prefs = Prefs {
            extra_args: vec!["--mdns".to_owned()],
            ..Prefs::default()
        };
        let error = registry
            .plan("opencode", &prefs, &AdapterHost::default())
            .expect_err("--mdns publishes the harness to the LAN");
        assert!(matches!(error, RegistryError::RefusedArg { .. }));
        assert!(error.to_string().contains("0.0.0.0"));
    }

    #[test]
    fn copilot_refuses_port_even_with_a_value_attached() {
        let registry = Registry::load();
        let prefs = Prefs {
            extra_args: vec!["--port=4000".to_owned()],
            ..Prefs::default()
        };
        assert!(matches!(
            registry.plan("copilot", &prefs, &AdapterHost::default()),
            Err(RegistryError::RefusedArg { .. })
        ));
        // A different flag sharing the prefix is a different flag.
        let unrelated = Prefs {
            extra_args: vec!["--portable".to_owned()],
            ..Prefs::default()
        };
        assert!(
            registry
                .plan("copilot", &unrelated, &AdapterHost::default())
                .is_ok()
        );
    }

    #[test]
    fn an_adapter_kind_without_its_adapter_is_named_not_guessed() {
        let registry = Registry::load();
        let error = registry
            .plan("codex", &Prefs::default(), &AdapterHost::default())
            .expect_err("no adapter is installed in a default host");
        assert!(matches!(error, RegistryError::AdapterMissing { .. }));
        assert!(error.to_string().contains("codex-acp"));
    }

    #[test]
    fn an_adapter_kind_forwards_bin_path_through_the_env_var() {
        let registry = Registry::load();
        let mut host = AdapterHost::default();
        host.scripts.insert(
            "@agentclientprotocol/claude-agent-acp".to_owned(),
            PathBuf::from("/opt/adapters/claude-agent-acp/bin.js"),
        );
        let prefs = Prefs {
            bin_path: Some("/home/p/.local/bin/claude".to_owned()),
            ..Prefs::default()
        };
        let plan = registry
            .plan("claude-code", &prefs, &host)
            .expect("adapter present");
        assert_eq!(plan.program, PathBuf::from("node"));
        assert_eq!(plan.args, ["/opt/adapters/claude-agent-acp/bin.js"]);
        assert_eq!(
            plan.env.get("CLAUDE_CODE_EXECUTABLE").map(String::as_str),
            Some("/home/p/.local/bin/claude"),
            "binPath is the HARNESS CLI, not the process spawned"
        );
        assert_eq!(
            plan.adapter.and_then(|a| a.session_mode_id),
            Some("bypassPermissions".to_owned())
        );
    }

    #[test]
    fn the_custom_escape_hatch_has_no_binary_to_spawn() {
        let registry = Registry::load();
        let error = registry
            .plan("acp", &Prefs::default(), &AdapterHost::default())
            .expect_err("the custom kind has no defaultBin");
        assert!(matches!(error, RegistryError::NoBinary { .. }));
    }

    #[test]
    fn only_codex_and_claude_code_probe_models() {
        let registry = Registry::load();
        let probing: Vec<&str> = registry
            .all()
            .iter()
            .filter(|h| h.probe_models)
            .map(|h| h.kind.as_str())
            .collect();
        assert_eq!(probing, ["codex", "claude-code"]);
    }

    #[test]
    fn versions_are_found_after_a_leading_v() {
        assert_eq!(
            Version::find_in("codex-cli v0.128.4 (build 9)"),
            Some(Version {
                major: 0,
                minor: 128,
                patch: 4
            })
        );
        assert_eq!(Version::find_in("no numbers here"), None);
        assert_eq!(
            Version::find_in("2026.7.16"),
            Some(Version {
                major: 2026,
                minor: 7,
                patch: 16
            })
        );
    }
}
