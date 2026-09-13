//! CPU and I/O priority for a harness child (#456/#528; #1020, D-1020-AS1).
//!
//! A harness turn is a long-running subprocess that will happily saturate four
//! cores and the disk queue while the member is trying to scroll a list. So it
//! is launched at low priority — and *launched* is the operative word: the
//! niceness is applied by wrapping the command in `nice` (and `ionice` on
//! Linux) rather than by calling `setpriority` after the fact, because the
//! window between spawn and adjustment is exactly when a cold start does its
//! worst.
//!
//! `low-priority.ts:10`–`:12`: **worker_threads is deferred — do not hack a tid
//! lookup.** The Rust port inherits the same non-goal for its own threads: this
//! module lowers *child processes*, and nothing here reaches into a thread id.
//!
//! Windows gets nothing, deliberately: there is no `nice`, and the
//! `SetPriorityClass` route needs a handle to a process that is already
//! running, which is the race this design avoids.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

const DEFAULT_NICENESS: i32 = 10;

/// A command, after the priority wrapper has been applied.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Command {
    pub program: PathBuf,
    pub args: Vec<String>,
}

/// What the wrapper is allowed to assume about the host.
#[derive(Debug, Clone)]
pub struct Host {
    /// `"linux"`, `"macos"`, `"windows"` — the three cases that differ.
    pub platform: &'static str,
    pub niceness: i32,
    /// Whether a path exists. Injected so the decision is testable without
    /// depending on what happens to be installed on the runner.
    pub exists: fn(&Path) -> bool,
    /// `CENTRAID_CHILD_PRIORITY=normal` opts a host out entirely — the escape
    /// hatch for a machine where `nice` is denied by a sandbox.
    pub opt_out: bool,
}

impl Host {
    /// The real host.
    #[must_use]
    pub fn current(env: &BTreeMap<String, String>) -> Self {
        Self {
            platform: if cfg!(target_os = "windows") {
                "windows"
            } else if cfg!(target_os = "linux") {
                "linux"
            } else {
                "other"
            },
            niceness: DEFAULT_NICENESS,
            exists: |path| path.exists(),
            opt_out: env.get("CENTRAID_CHILD_PRIORITY").map(String::as_str) == Some("normal"),
        }
    }
}

/// Wrap a command so the child runs at low CPU and (on Linux) low I/O
/// priority.
#[must_use]
pub fn low_priority_command(program: &Path, args: &[String], host: &Host) -> Command {
    if host.platform == "windows" || host.opt_out {
        return Command {
            program: program.to_path_buf(),
            args: args.to_vec(),
        };
    }
    let nice = if (host.exists)(Path::new("/usr/bin/nice")) {
        PathBuf::from("/usr/bin/nice")
    } else {
        PathBuf::from("nice")
    };
    // `--` matters: without it a harness argument that starts with `-` is read
    // by `nice` as one of its own options.
    let mut nice_args = vec![
        "-n".to_owned(),
        host.niceness.to_string(),
        "--".to_owned(),
        program.display().to_string(),
    ];
    nice_args.extend(args.iter().cloned());

    if host.platform != "linux" {
        return Command {
            program: nice,
            args: nice_args,
        };
    }
    let ionice = ["/usr/bin/ionice", "/bin/ionice"]
        .into_iter()
        .map(PathBuf::from)
        .find(|candidate| (host.exists)(candidate));
    match ionice {
        // Best-effort class, lowest priority within it: the harness yields the
        // disk to whatever the member is doing, and still makes progress.
        Some(ionice) => {
            let mut args_with_nice = vec![
                "-c".to_owned(),
                "2".to_owned(),
                "-n".to_owned(),
                "7".to_owned(),
                nice.display().to_string(),
            ];
            args_with_nice.extend(nice_args);
            Command {
                program: ionice,
                args: args_with_nice,
            }
        }
        None => Command {
            program: nice,
            args: nice_args,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn host(platform: &'static str, exists: fn(&Path) -> bool) -> Host {
        Host {
            platform,
            niceness: 10,
            exists,
            opt_out: false,
        }
    }

    fn all(_path: &Path) -> bool {
        true
    }
    fn none(_path: &Path) -> bool {
        false
    }

    #[test]
    fn linux_wraps_in_ionice_then_nice() {
        let command = low_priority_command(
            Path::new("codex"),
            &["--acp".to_owned()],
            &host("linux", all),
        );
        assert_eq!(command.program, PathBuf::from("/usr/bin/ionice"));
        assert_eq!(
            command.args,
            [
                "-c",
                "2",
                "-n",
                "7",
                "/usr/bin/nice",
                "-n",
                "10",
                "--",
                "codex",
                "--acp"
            ]
        );
    }

    #[test]
    fn macos_wraps_in_nice_only() {
        let command = low_priority_command(Path::new("codex"), &[], &host("other", all));
        assert_eq!(command.program, PathBuf::from("/usr/bin/nice"));
        assert_eq!(command.args, ["-n", "10", "--", "codex"]);
    }

    #[test]
    fn windows_is_left_alone() {
        let command = low_priority_command(
            Path::new("codex.exe"),
            &["--acp".to_owned()],
            &host("windows", all),
        );
        assert_eq!(command.program, PathBuf::from("codex.exe"));
        assert_eq!(command.args, ["--acp"]);
    }

    #[test]
    fn a_host_with_neither_helper_falls_back_to_bare_nice() {
        let command = low_priority_command(Path::new("codex"), &[], &host("linux", none));
        assert_eq!(command.program, PathBuf::from("nice"));
    }

    #[test]
    fn the_opt_out_returns_the_command_untouched() {
        let mut opted = host("linux", all);
        opted.opt_out = true;
        let command = low_priority_command(Path::new("codex"), &[], &opted);
        assert_eq!(command.program, PathBuf::from("codex"));
        assert!(command.args.is_empty());
    }
}
