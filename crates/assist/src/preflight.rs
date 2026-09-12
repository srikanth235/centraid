//! `<bin> --version`, cached 24 hours, and the rule that it **warns and never
//! blocks** (#1020, D-1020-AS1).
//!
//! `preflight.ts:1`–`:2` is the whole policy: *older than min is `ok: true`
//! with `versionAtLeast: false` — warn, do not hard-block.* The minimum version
//! is the oldest release somebody verified, not a compatibility boundary, and a
//! hard block on it would mean that the day a harness ships a version string
//! this table has not seen, every turn stops. So an old version is a sentence
//! in the settings screen and the turn still runs.
//!
//! The unknowable case is distinguished from both: when the output carries no
//! `N.N.N` at all, [`Status::version_at_least`] is `None` rather than `false`.
//! Three states, because collapsing "too old" into "cannot tell" is how a
//! harness with an unusual `--version` banner gets a warning it does not
//! deserve.
//!
//! ## Why the cache is 24 hours, and why it is not a status poll
//!
//! Spawning a process per settings render is a visible stall. 24 h is v0's
//! `CLI_AVAILABILITY_TTL_MS` (`preflight.ts:17`) and is scoped by
//! `(kind, binary)` — a member who changes the configured path gets a fresh
//! probe without waiting. The *capability* probe is a different and much more
//! expensive thing (it runs a real `initialize` against a spawned harness) and
//! is never done on a poll (`capabilities-cache.ts:1`–`:7`).

use std::collections::BTreeMap;
use std::time::Duration;

use crate::registry::{AdapterHost, Harness, Prefs, Registry, RegistryError, Version};

/// How long a `--version` answer is trusted.
pub const AVAILABILITY_TTL: Duration = Duration::from_secs(24 * 60 * 60);

/// How long a `--version` probe is waited for before it is killed.
pub const VERSION_TIMEOUT: Duration = Duration::from_secs(5);

/// What preflight found. `ok` is about *reachability*, never about age.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Status {
    pub kind: String,
    /// Whether a turn may be attempted at all.
    pub ok: bool,
    /// The trimmed first 200 characters of the harness's own banner.
    pub version: Option<String>,
    pub min_version: Version,
    /// `Some(false)` is a warning; `None` means the banner carried no version
    /// and nothing is claimed either way.
    pub version_at_least: Option<bool>,
    /// The member-facing sentence, when there is one to say.
    pub reason: Option<String>,
    pub hint: Option<String>,
}

/// How a probe is actually run. Injected, so the policy above is tested without
/// installing seventeen CLIs on a runner.
pub trait VersionProbe {
    /// The harness's `--version` output, or the reason it could not be read.
    fn version(&self, plan: &crate::registry::LaunchPlan) -> Result<String, ProbeFailure>;
}

/// Why a `--version` probe did not produce output.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProbeFailure {
    /// The binary is not on `PATH`. The one failure with its own sentence,
    /// because it is the one a member can fix from the install hint.
    NotFound,
    TimedOut,
    Exited { code: Option<i32> },
    Failed { detail: String },
}

/// The 24 h cache, keyed as v0 keys it: `(kind, binary)`.
#[derive(Debug, Default)]
pub struct Cache {
    entries: BTreeMap<String, (u64, Status)>,
}

impl Cache {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Drop every entry. What the settings surface's `?refresh=1` does.
    pub fn invalidate(&mut self) {
        self.entries.clear();
    }

    fn key(kind: &str, program: &str) -> String {
        format!("{kind}::{program}")
    }
}

/// Run preflight for one kind, through the cache.
///
/// `now_ms` is injected like every clock in this workspace
/// (`crates/vault::Clock`): a TTL tested against the host clock is a test that
/// passes for 24 hours and then does something else.
pub fn run(
    registry: &Registry,
    kind: &str,
    prefs: &Prefs,
    adapters: &AdapterHost,
    probe: &dyn VersionProbe,
    cache: &mut Cache,
    now_ms: u64,
) -> Status {
    let Some(harness) = registry.get(kind) else {
        return Status {
            kind: kind.to_owned(),
            ok: false,
            version: None,
            min_version: Version {
                major: 0,
                minor: 0,
                patch: 0,
            },
            version_at_least: None,
            reason: Some(format!("no harness is registered for the kind `{kind}`")),
            hint: None,
        };
    };

    let plan = match registry.plan(kind, prefs, adapters) {
        Ok(plan) => plan,
        // A LAUNCH THAT CANNOT BE PLANNED IS NOT A FAILED PROBE. `undefined
        // --version` is never spawned (`preflight.ts:140`); the registry's own
        // sentence is the answer, and for a missing adapter it carries the
        // install verb.
        Err(error) => return not_launchable(harness, &error),
    };

    let key = Cache::key(kind, &plan.program.display().to_string());
    if let Some((checked_at, status)) = cache.entries.get(&key)
        && now_ms.saturating_sub(*checked_at) < AVAILABILITY_TTL.as_millis() as u64
    {
        return status.clone();
    }

    let status = match probe.version(&plan) {
        Ok(raw) => classify(harness, &plan, &raw),
        Err(ProbeFailure::NotFound) => Status {
            kind: harness.kind.clone(),
            ok: false,
            version: None,
            min_version: harness.min_version,
            version_at_least: None,
            reason: Some(format!("{} not found on PATH", plan.program.display())),
            hint: Some(harness.install_hint.clone()),
        },
        Err(failure) => Status {
            kind: harness.kind.clone(),
            ok: false,
            version: None,
            min_version: harness.min_version,
            version_at_least: None,
            reason: Some(match failure {
                ProbeFailure::TimedOut => "--version timed out".to_owned(),
                ProbeFailure::Exited { code } => format!(
                    "--version exited {}",
                    code.map_or_else(|| "null".to_owned(), |value| value.to_string())
                ),
                ProbeFailure::Failed { detail } => detail,
                ProbeFailure::NotFound => unreachable!("handled above"),
            }),
            hint: Some(harness.install_hint.clone()),
        },
    };
    cache.entries.insert(key, (now_ms, status.clone()));
    status
}

fn not_launchable(harness: &Harness, error: &RegistryError) -> Status {
    Status {
        kind: harness.kind.clone(),
        ok: false,
        version: None,
        min_version: harness.min_version,
        version_at_least: None,
        reason: Some(error.to_string()),
        hint: Some(harness.install_hint.clone()),
    }
}

fn classify(harness: &Harness, plan: &crate::registry::LaunchPlan, raw: &str) -> Status {
    let trimmed: String = raw.trim().chars().take(200).collect();
    let found = Version::find_in(&trimmed);
    let at_least = found.map(|version| version >= harness.min_version);
    let mut status = Status {
        kind: harness.kind.clone(),
        // OK EVEN WHEN OLD. The policy in one line.
        ok: true,
        version: Some(trimmed.clone()),
        min_version: harness.min_version,
        version_at_least: at_least,
        reason: None,
        hint: None,
    };
    if at_least == Some(false) {
        status.reason = Some(format!(
            "installed {trimmed} is older than minimum {} verified to work — proceed with caution",
            harness.min_version
        ));
        status.hint = Some(format!(
            "Run {} update (or your package manager's upgrade command) to bring it up to date.",
            plan.program.display()
        ));
    }
    status
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    struct Fixed {
        answer: Result<String, ProbeFailure>,
        calls: Cell<usize>,
    }

    impl Fixed {
        fn ok(text: &str) -> Self {
            Self {
                answer: Ok(text.to_owned()),
                calls: Cell::new(0),
            }
        }
        fn err(failure: ProbeFailure) -> Self {
            Self {
                answer: Err(failure),
                calls: Cell::new(0),
            }
        }
    }

    impl VersionProbe for Fixed {
        fn version(&self, _plan: &crate::registry::LaunchPlan) -> Result<String, ProbeFailure> {
            self.calls.set(self.calls.get() + 1);
            self.answer.clone()
        }
    }

    fn native(kind: &str, probe: &dyn VersionProbe, cache: &mut Cache, now_ms: u64) -> Status {
        run(
            &Registry::load(),
            kind,
            &Prefs::default(),
            &AdapterHost::default(),
            probe,
            cache,
            now_ms,
        )
    }

    #[test]
    fn an_old_version_warns_and_stays_ok() {
        let probe = Fixed::ok("gemini 0.1.0");
        let status = native("gemini", &probe, &mut Cache::new(), 0);
        assert!(status.ok, "older than minimum must never hard-block");
        assert_eq!(status.version_at_least, Some(false));
        assert!(status.reason.unwrap().contains("proceed with caution"));
    }

    #[test]
    fn a_banner_with_no_version_claims_nothing() {
        let probe = Fixed::ok("gemini (development build)");
        let status = native("gemini", &probe, &mut Cache::new(), 0);
        assert!(status.ok);
        assert_eq!(
            status.version_at_least, None,
            "`cannot tell` is a third state, not `too old`"
        );
        assert!(status.reason.is_none());
    }

    #[test]
    fn a_current_version_is_clean() {
        let probe = Fixed::ok("gemini 0.51.2");
        let status = native("gemini", &probe, &mut Cache::new(), 0);
        assert_eq!(status.version_at_least, Some(true));
        assert!(status.reason.is_none() && status.hint.is_none());
    }

    #[test]
    fn a_missing_binary_answers_with_the_install_hint() {
        let probe = Fixed::err(ProbeFailure::NotFound);
        let status = native("gemini", &probe, &mut Cache::new(), 0);
        assert!(!status.ok);
        assert!(status.reason.unwrap().contains("not found on PATH"));
        assert!(status.hint.unwrap().contains("npm i -g @google/gemini-cli"));
    }

    #[test]
    fn the_cache_holds_for_a_day_and_then_reprobes() {
        let probe = Fixed::ok("gemini 0.51.2");
        let mut cache = Cache::new();
        let _ = native("gemini", &probe, &mut cache, 1_000);
        let _ = native("gemini", &probe, &mut cache, 1_000 + 60_000);
        assert_eq!(probe.calls.get(), 1, "a settings render must not spawn");
        let day = AVAILABILITY_TTL.as_millis() as u64;
        let _ = native("gemini", &probe, &mut cache, 1_000 + day);
        assert_eq!(probe.calls.get(), 2);
        cache.invalidate();
        let _ = native("gemini", &probe, &mut cache, 1_000 + day);
        assert_eq!(probe.calls.get(), 3, "?refresh=1 forces a re-probe");
    }

    #[test]
    fn the_custom_kind_is_never_spawned_without_a_binary() {
        let probe = Fixed::ok("should not run");
        let status = native("acp", &probe, &mut Cache::new(), 0);
        assert!(!status.ok);
        assert_eq!(probe.calls.get(), 0, "`undefined --version` must not spawn");
        assert!(status.reason.unwrap().contains("no binary configured"));
    }

    #[test]
    fn a_missing_adapter_reports_the_install_verb_without_spawning() {
        let probe = Fixed::ok("should not run");
        let status = native("codex", &probe, &mut Cache::new(), 0);
        assert!(!status.ok);
        assert_eq!(probe.calls.get(), 0);
        assert!(
            status
                .reason
                .unwrap()
                .contains("centraid assist adapters install")
        );
    }
}
