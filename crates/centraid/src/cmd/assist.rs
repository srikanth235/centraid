//! `centraid assist` — the harness surface v0 shipped as `centraid-acp`
//! (#1020, D-1020-AS7).
//!
//! ## Why the bare name matters
//!
//! The builder harness's shell calls this **by bare name** (`centraid-acp` in
//! v0, `centraid assist` now): the turn injects a directory onto the child's
//! `PATH` so the harness's own shell finds it. That is the reason
//! `crate::cmd::assist` exists as a verb of the one binary rather than as a
//! second executable — one artifact, one identity, one signature.
//!
//! ## There are no `sql` subcommands (#286)
//!
//! v0's CLI states it in its header and the reason survives the port: *data
//! questions ride the in-process tools, and there is no per-app database for a
//! shell to poke.* A `centraid assist sql` would be a second, unaudited path to
//! the whole model — one that no posture gates and no turn token scopes —
//! reachable from any shell command a harness decides to run. The tools are
//! `centraid mcp`'s, they are gated by the turn's principal, and this verb is
//! deliberately not a way around them.
//!
//! ## What it does serve
//!
//! Facts about the harnesses, and the adapter install gesture:
//!
//! - `centraid assist harnesses` — the registry, as the member's settings screen
//!   sees it: every kind, whether it is in the supported five, what would be
//!   spawned, and whether preflight found it.
//! - `centraid assist preflight <kind>` — one kind's `--version` probe, with the
//!   warn-never-block rule visible in the output.
//! - `centraid assist adapters` / `adapters install` — where the two npm
//!   adapters are, or the command that would put them there.
//!
//! Facts to stderr, JSON to stdout — `cmd/mod.rs`'s rule for every verb.

use std::collections::BTreeMap;
use std::path::PathBuf;

use centraid_assist::preflight::{self, ProbeFailure, VersionProbe};
use centraid_assist::registry::{AdapterHost, Prefs, Registry};
use centraid_assist::{adapters, low_priority, spawn_env};

use crate::exit;

/// What `centraid assist` was asked for.
pub enum Args {
    Harnesses { json: bool },
    Preflight { kind: String, json: bool },
    Adapters { install: bool, json: bool },
}

/// The `--version` probe that actually spawns a process.
///
/// Wrapped for low priority like every harness child, and given the scrubbed
/// environment, so the probe sees the same `PATH` the turn will. A probe that
/// found a `node_modules/.bin` shim the turn would not is a probe that reports
/// a version nothing will run.
struct Spawning {
    base_env: BTreeMap<String, String>,
}

impl VersionProbe for Spawning {
    fn version(
        &self,
        program: &std::path::Path,
        harness_env: &BTreeMap<String, String>,
    ) -> Result<String, ProbeFailure> {
        let env =
            spawn_env::harness_spawn_env(&self.base_env, &spawn_env::SpawnEnvOptions::default());
        let wrapped = low_priority::low_priority_command(
            program,
            &["--version".to_owned()],
            &low_priority::Host::current(&self.base_env),
        );
        let mut command = std::process::Command::new(&wrapped.program);
        command
            .args(&wrapped.args)
            .env_clear()
            .envs(&env)
            .envs(harness_env)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        let output = command.output().map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                ProbeFailure::NotFound
            } else {
                ProbeFailure::Failed {
                    detail: error.to_string(),
                }
            }
        })?;
        if !output.status.success() {
            return Err(ProbeFailure::Exited {
                code: output.status.code(),
            });
        }
        let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
        if stdout.trim().is_empty() {
            // `nice` may print a sandbox setpriority denial on stderr; prefer
            // stdout and fall back rather than reporting an empty version.
            return Ok(String::from_utf8_lossy(&output.stderr).into_owned());
        }
        Ok(stdout)
    }
}

/// Where the adapters are looked for when no data directory was named.
fn default_data_dir() -> PathBuf {
    std::env::var_os("CENTRAID_DATA_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

pub fn run(args: Args) -> u8 {
    let registry = Registry::load();
    let env: BTreeMap<String, String> = std::env::vars().collect();
    let host = adapters::discover(&env, &default_data_dir(), PathBuf::from("node"));
    match args {
        Args::Harnesses { json } => harnesses(&registry, &host, json),
        Args::Preflight { kind, json } => preflight_one(&registry, &host, &env, &kind, json),
        Args::Adapters { install, json } => {
            if install {
                install_adapters(&host, json)
            } else {
                report_adapters(&host, json)
            }
        }
    }
}

fn harnesses(registry: &Registry, host: &AdapterHost, json: bool) -> u8 {
    let rows: Vec<serde_json::Value> = registry
        .all()
        .iter()
        .map(|harness| {
            let planned = registry.plan(&harness.kind, &Prefs::default(), host);
            serde_json::json!({
                "kind": harness.kind,
                "label": harness.label,
                "supported": harness.supported,
                "minVersion": harness.min_version.to_string(),
                "defaultBin": harness.default_bin,
                "needsAdapter": harness.adapter.is_some(),
                "launchable": planned.is_ok(),
                "program": planned.as_ref().ok().map(|plan| plan.program.display().to_string()),
                "args": planned.as_ref().ok().map(|plan| plan.args.clone()),
                "reason": planned.as_ref().err().map(ToString::to_string),
                "installHint": harness.install_hint,
                "refuseArgs": harness
                    .refuse_args
                    .iter()
                    .map(|refused| refused.arg.clone())
                    .collect::<Vec<String>>(),
            })
        })
        .collect();
    if json {
        print_json(&serde_json::json!({
            "supportedKinds": registry.supported_kinds(),
            "harnesses": rows,
        }));
        return exit::OK;
    }
    eprintln!(
        "{} harnesses registered, {} in the supported list",
        rows.len(),
        registry.supported_kinds().len()
    );
    for row in &rows {
        eprintln!(
            "  {:<12} {:<10} {}",
            row["kind"].as_str().unwrap_or(""),
            if row["supported"] == true {
                "supported"
            } else {
                "registered"
            },
            if row["launchable"] == true {
                row["program"].as_str().unwrap_or("").to_owned()
            } else {
                row["reason"].as_str().unwrap_or("").to_owned()
            }
        );
    }
    exit::OK
}

fn preflight_one(
    registry: &Registry,
    host: &AdapterHost,
    env: &BTreeMap<String, String>,
    kind: &str,
    json: bool,
) -> u8 {
    if registry.get(kind).is_none() {
        eprintln!("centraid assist: no harness is registered for the kind `{kind}`");
        return exit::REFUSED;
    }
    let probe = Spawning {
        base_env: env.clone(),
    };
    let mut cache = preflight::Cache::new();
    let now_ms = u64::try_from(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|since| since.as_millis())
            .unwrap_or_default(),
    )
    .unwrap_or_default();
    let status = preflight::run(
        registry,
        kind,
        &Prefs::default(),
        host,
        &probe,
        &mut cache,
        now_ms,
    );
    let report = serde_json::json!({
        "kind": status.kind,
        "ok": status.ok,
        "version": status.version,
        "minVersion": status.min_version.to_string(),
        // Three states, not two: `null` means the banner carried no version and
        // nothing is claimed either way.
        "versionAtLeast": status.version_at_least,
        "reason": status.reason,
        "hint": status.hint,
    });
    if json {
        print_json(&report);
    } else {
        eprintln!(
            "{}: {}",
            status.kind,
            if status.ok {
                "reachable"
            } else {
                "unavailable"
            }
        );
        if let Some(version) = &status.version {
            eprintln!("  version: {version} (minimum {})", status.min_version);
        }
        if let Some(reason) = &status.reason {
            eprintln!("  {reason}");
        }
        if let Some(hint) = &status.hint {
            eprintln!("  {hint}");
        }
    }
    // AN OLD VERSION IS NOT A FAILING EXIT CODE. Warn, never block: the policy
    // has to be visible here too, or a script wrapping this verb reintroduces
    // the block the policy removed.
    if status.ok { exit::OK } else { exit::REFUSED }
}

fn report_adapters(host: &AdapterHost, json: bool) -> u8 {
    let rows: Vec<serde_json::Value> = adapters::ADAPTER_PACKAGES
        .into_iter()
        .map(|package| {
            serde_json::json!({
                "package": package,
                "script": host.scripts.get(package).map(|path| path.display().to_string()),
            })
        })
        .collect();
    if json {
        print_json(&serde_json::json!({
            "node": host.node.display().to_string(),
            "adapters": rows,
        }));
        return exit::OK;
    }
    for row in &rows {
        match row["script"].as_str() {
            Some(path) => eprintln!("  {} → {path}", row["package"].as_str().unwrap_or("")),
            None => eprintln!(
                "  {} → not installed (run `centraid assist adapters install`)",
                row["package"].as_str().unwrap_or("")
            ),
        }
    }
    exit::OK
}

/// Print the command that installs the adapters, and do not run it.
///
/// **An owner hand-off rather than an automatic fetch.** Installing these means
/// downloading and then executing third-party code with the member's vault
/// open, and a verb that did it silently would be an `npx -y` with extra steps
/// — the thing `registry.ts:5`–`:6` rules out. So the verb prints exactly what
/// it would run, with the directory it would run it in, and the member runs it.
/// Wiring the spawn is a small change; deciding that a tool may fetch and
/// execute code on the member's behalf is not, and that decision is the
/// owner's.
fn install_adapters(host: &AdapterHost, json: bool) -> u8 {
    let target = default_data_dir().join("acp-adapters");
    let command = format!(
        "npm install --prefix {} {}",
        target.display(),
        adapters::ADAPTER_PACKAGES.join(" ")
    );
    if json {
        print_json(&serde_json::json!({
            "action": "hand-off",
            "command": command,
            "prefix": target.display().to_string(),
            "alreadyInstalled": host.scripts.keys().collect::<Vec<&String>>(),
            "note": "Run this yourself: installing an adapter downloads and then executes \
                     third-party code, and a verb that did it silently would be the `npx -y` \
                     fetch the registry rules out.",
        }));
        return exit::OK;
    }
    eprintln!("The two ACP adapters are installed by running:");
    eprintln!();
    eprintln!("  {command}");
    eprintln!();
    eprintln!(
        "It is printed rather than run: it downloads and then executes third-party code, and \
         that is the member's decision, not a tool's."
    );
    if !host.scripts.is_empty() {
        eprintln!(
            "Already installed: {:?}",
            host.scripts.keys().collect::<Vec<&String>>()
        );
    }
    exit::OK
}

fn print_json(value: &serde_json::Value) {
    println!(
        "{}",
        serde_json::to_string_pretty(value).unwrap_or_else(|_| "{}".to_owned())
    );
}
