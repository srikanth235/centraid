//! The unit files `install` writes: a systemd user unit or a launchd agent
//! (#1080).
//!
//! Carried over from `crates/gateway-server`'s installer by copy, the shape
//! unchanged: **render, then act**, and `--dry-run` prints without touching
//! the host, which is what makes it checkable before it runs. It is a USER
//! unit by default, so installing needs no root, and it never enables what it
//! writes: a service that starts because a file was unpacked is a service
//! nobody chose to run.
//!
//! There is no key custody here because the gateway is blind: its data
//! directory holds a TLS key that identifies the gateway, and nothing that
//! opens a vault. The unit confines the process to that directory.

use std::fmt::Write as _;
use std::path::{Path, PathBuf};

/// Which init system a unit is for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Platform {
    Systemd,
    Launchd,
}

impl Platform {
    /// The platform this binary is running on, or `None` where neither
    /// applies — there, a gateway is a container.
    #[must_use]
    pub const fn host() -> Option<Self> {
        if cfg!(target_os = "linux") {
            Some(Self::Systemd)
        } else if cfg!(target_os = "macos") {
            Some(Self::Launchd)
        } else {
            None
        }
    }
}

/// Everything a unit is rendered from.
#[derive(Debug, Clone)]
pub struct UnitSpec {
    /// `dev.centraid.gateway2`.
    pub label: String,
    /// The absolute path to this binary.
    pub program: PathBuf,
    /// The arguments after it, e.g. `["serve", "--data-dir", "/srv/vault"]`.
    pub arguments: Vec<String>,
    /// The data directory: the one path the unit may write.
    pub data_dir: PathBuf,
    /// Where launchd sends the log; systemd journals.
    pub log_dir: PathBuf,
}

/// The default unit label, the reverse-DNS name launchd wants.
pub const DEFAULT_LABEL: &str = "dev.centraid.gateway2";

/// Render a systemd unit.
///
/// Every hardening line removes something the gateway provably does not
/// need; `ProtectSystem=strict` with one `ReadWritePaths` makes the data
/// directory the only writable path. `AF_NETLINK` is allowed beside the
/// internet families because listing the interface addresses the pairing QR
/// and the Bonjour advertisement carry is a netlink query on Linux.
///
/// **THE HOME DIRECTORY IS AN EMPTY TMPFS WITH TWO HOLES, NOT `true`.** A
/// user unit's data directory is usually under `~`, and so is a
/// `cargo install`ed binary. `ProtectHome=true` makes `/home` inaccessible,
/// and systemd drops every mount beneath an inaccessible path — a
/// `ReadWritePaths=` under it included (`drop_inaccessible` in
/// `src/core/namespace.c`) — so that unit could never start with its data
/// directory at home: the copy in `crates/gateway-server` has this defect.
/// `ProtectHome=tmpfs` hides the rest of the home just as well, and
/// `BindPaths=` and `BindReadOnlyPaths=` put back exactly the data directory
/// and the binary. `install` creates the data directory first, because
/// every one of those lines refuses a path that does not exist.
///
/// `StartLimitIntervalSec=` and `StartLimitBurst=` are `[Unit]` keys: under
/// `[Service]` systemd ignores the first with a warning.
#[must_use]
pub fn systemd_unit(spec: &UnitSpec) -> String {
    let mut out = String::new();
    let _ = writeln!(out, "[Unit]");
    let _ = writeln!(out, "Description=Centraid gateway ({})", spec.label);
    let _ = writeln!(out, "After=network-online.target");
    let _ = writeln!(out, "Wants=network-online.target");
    let _ = writeln!(out, "StartLimitIntervalSec=600");
    let _ = writeln!(out, "StartLimitBurst=10");
    let _ = writeln!(out);
    let _ = writeln!(out, "[Service]");
    let _ = writeln!(out, "Type=simple");
    let _ = writeln!(
        out,
        "ExecStart={} {}",
        quote(&spec.program.display().to_string()),
        spec.arguments
            .iter()
            .map(|argument| quote(argument))
            .collect::<Vec<_>>()
            .join(" ")
    );
    let _ = writeln!(out, "Restart=on-failure");
    let _ = writeln!(out, "RestartSec=5");
    let _ = writeln!(
        out,
        "WorkingDirectory={}",
        spec.data_dir.display().to_string().replace('%', "%%")
    );
    let _ = writeln!(out, "UMask=0077");
    let _ = writeln!(out);
    let _ = writeln!(out, "# The gateway is blind and reachable. Everything it");
    let _ = writeln!(out, "# provably does not need is taken away here.");
    let _ = writeln!(out, "NoNewPrivileges=true");
    let _ = writeln!(out, "PrivateTmp=true");
    let _ = writeln!(out, "PrivateDevices=true");
    let _ = writeln!(out, "ProtectSystem=strict");
    let _ = writeln!(out, "ProtectHome=tmpfs");
    let _ = writeln!(out, "BindPaths={}", path_word(&spec.data_dir));
    let _ = writeln!(out, "BindReadOnlyPaths={}", path_word(&spec.program));
    let _ = writeln!(out, "ProtectKernelTunables=true");
    let _ = writeln!(out, "ProtectKernelModules=true");
    let _ = writeln!(out, "ProtectControlGroups=true");
    let _ = writeln!(out, "RestrictSUIDSGID=true");
    let _ = writeln!(out, "RestrictNamespaces=true");
    let _ = writeln!(
        out,
        "RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX AF_NETLINK"
    );
    let _ = writeln!(out, "LockPersonality=true");
    let _ = writeln!(out, "MemoryDenyWriteExecute=true");
    let _ = writeln!(out, "SystemCallArchitectures=native");
    let _ = writeln!(out, "SystemCallFilter=@system-service");
    let _ = writeln!(out, "ReadWritePaths={}", path_word(&spec.data_dir));
    let _ = writeln!(out);
    let _ = writeln!(out, "[Install]");
    let _ = writeln!(out, "WantedBy=default.target");
    out
}

/// Render a launchd agent.
#[must_use]
pub fn launchd_plist(spec: &UnitSpec) -> String {
    let mut arguments = String::new();
    let _ = writeln!(
        arguments,
        "    <string>{}</string>",
        escape(&spec.program.display().to_string())
    );
    for argument in &spec.arguments {
        let _ = writeln!(arguments, "    <string>{}</string>", escape(argument));
    }
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>{label}</string>
  <key>ProgramArguments</key>
  <array>
{arguments}  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>WorkingDirectory</key>
  <string>{data_dir}</string>
  <key>StandardOutPath</key>
  <string>{log_dir}/gateway.log</string>
  <key>StandardErrorPath</key>
  <string>{log_dir}/gateway.err.log</string>
  <key>ProcessType</key>
  <string>Background</string>
</dict>
</plist>
"#,
        label = escape(&spec.label),
        data_dir = escape(&spec.data_dir.display().to_string()),
        log_dir = escape(&spec.log_dir.display().to_string()),
    )
}

/// Where a user systemd unit goes.
#[must_use]
pub fn systemd_unit_path(home: &Path, label: &str) -> PathBuf {
    home.join(".config/systemd/user")
        .join(format!("{label}.service"))
}

/// Where a launchd agent goes.
#[must_use]
pub fn launchd_plist_path(home: &Path, label: &str) -> PathBuf {
    home.join("Library/LaunchAgents")
        .join(format!("{label}.plist"))
}

/// The unit and where it goes, without touching the host.
#[must_use]
pub fn render(platform: Platform, spec: &UnitSpec, home: &Path) -> (PathBuf, String) {
    match platform {
        Platform::Systemd => (systemd_unit_path(home, &spec.label), systemd_unit(spec)),
        Platform::Launchd => (launchd_plist_path(home, &spec.label), launchd_plist(spec)),
    }
}

/// Write the unit. The caller decides whether this runs; `--dry-run` prints
/// [`render`]'s output instead.
///
/// # Errors
///
/// If the directory cannot be created or the file written.
pub fn install(platform: Platform, spec: &UnitSpec, home: &Path) -> std::io::Result<PathBuf> {
    let (path, text) = render(platform, spec, home);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&path, text)?;
    Ok(path)
}

/// Quote one systemd `ExecStart` word. A `%` is doubled, or systemd would
/// read it as a specifier.
fn quote(word: &str) -> String {
    if word
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '-' | '_' | '.' | '=' | ':'))
    {
        return word.to_owned();
    }
    escaped(word)
}

/// Quote one path for `BindPaths=`, `BindReadOnlyPaths=` and
/// `ReadWritePaths=`, where a space separates paths and a colon separates a
/// bind's source from its destination: anything but a plain path is quoted.
fn path_word(path: &Path) -> String {
    let text = path.display().to_string();
    if text
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '-' | '_' | '.'))
    {
        return text;
    }
    escaped(&text)
}

/// `text` in double quotes, with what systemd would otherwise read inside
/// them escaped.
fn escaped(text: &str) -> String {
    format!(
        "\"{}\"",
        text.replace('\\', "\\\\")
            .replace('"', "\\\"")
            .replace('%', "%%")
    )
}

/// XML-escape one plist string.
fn escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec() -> UnitSpec {
        UnitSpec {
            label: DEFAULT_LABEL.to_owned(),
            program: PathBuf::from("/usr/local/bin/centraid-gateway2"),
            arguments: vec![
                "serve".to_owned(),
                "--data-dir".to_owned(),
                "/srv/vault".to_owned(),
            ],
            data_dir: PathBuf::from("/srv/vault"),
            log_dir: PathBuf::from("/srv/vault/logs"),
        }
    }

    /// The data directory is the only writable path, and the address families
    /// are the internet's plus the netlink the interface listing needs.
    #[test]
    fn the_systemd_unit_confines_the_process_to_its_data_directory() {
        let unit = systemd_unit(&spec());
        assert!(unit.contains("ProtectSystem=strict"), "{unit}");
        assert!(unit.contains("ReadWritePaths=/srv/vault"), "{unit}");
        assert!(unit.contains("NoNewPrivileges=true"), "{unit}");
        assert!(
            unit.contains("RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX AF_NETLINK"),
            "{unit}"
        );
        assert!(
            unit.contains("ExecStart=/usr/local/bin/centraid-gateway2 serve --data-dir /srv/vault"),
            "{unit}"
        );
    }

    #[test]
    fn the_launchd_agent_names_the_binary_and_runs_at_load() {
        let plist = launchd_plist(&spec());
        assert!(plist.contains("<string>dev.centraid.gateway2</string>"));
        assert!(plist.contains("<string>/usr/local/bin/centraid-gateway2</string>"));
        assert!(plist.contains("<key>RunAtLoad</key>"));
    }

    #[test]
    fn rendering_writes_nothing_and_installing_writes_what_it_rendered() {
        let home = tempfile::tempdir().expect("a temporary home");
        let (path, text) = render(Platform::Systemd, &spec(), home.path());
        assert!(!path.exists(), "render must not create the unit");
        let written = install(Platform::Systemd, &spec(), home.path()).expect("installs");
        assert_eq!(written, path);
        assert_eq!(std::fs::read_to_string(&written).expect("reads"), text);
    }

    /// The unit a member gets from `install --data-dir ~/centraid-gateway`
    /// with a `cargo install`ed binary: the home is hidden, and exactly the
    /// data directory and the binary are put back into it.
    #[test]
    fn a_data_directory_at_home_is_bound_into_the_hidden_home() {
        let mut at_home = spec();
        at_home.program = PathBuf::from("/home/ada/.cargo/bin/centraid-gateway2");
        at_home.data_dir = PathBuf::from("/home/ada/centraid-gateway");
        let unit = systemd_unit(&at_home);
        for line in [
            "ProtectHome=tmpfs",
            "BindPaths=/home/ada/centraid-gateway",
            "BindReadOnlyPaths=/home/ada/.cargo/bin/centraid-gateway2",
            "ReadWritePaths=/home/ada/centraid-gateway",
            "WorkingDirectory=/home/ada/centraid-gateway",
            "UMask=0077",
        ] {
            assert!(unit.lines().any(|held| held == line), "{line} in\n{unit}");
        }
        assert!(
            !unit.contains("ProtectHome=true"),
            "an inaccessible home masks every path beneath it:\n{unit}"
        );
    }

    /// `StartLimitIntervalSec=` under `[Service]` is ignored with a warning.
    #[test]
    fn the_start_limits_are_unit_keys() {
        let unit = systemd_unit(&spec());
        let section_of = |key: &str| {
            let mut section = "";
            for line in unit.lines() {
                if line.starts_with('[') {
                    section = line;
                } else if line.starts_with(key) {
                    return section;
                }
            }
            "nowhere"
        };
        assert_eq!(section_of("StartLimitIntervalSec="), "[Unit]");
        assert_eq!(section_of("StartLimitBurst="), "[Unit]");
    }

    /// A path with a space, a colon or a percent sign stays one path.
    #[test]
    fn an_awkward_data_directory_is_one_path_to_systemd() {
        let mut awkward = spec();
        awkward.data_dir = PathBuf::from("/srv/my vault:100%");
        let unit = systemd_unit(&awkward);
        for line in [
            "BindPaths=\"/srv/my vault:100%%\"",
            "ReadWritePaths=\"/srv/my vault:100%%\"",
            "WorkingDirectory=/srv/my vault:100%%",
        ] {
            assert!(unit.lines().any(|held| held == line), "{line} in\n{unit}");
        }
    }

    #[test]
    fn a_program_path_with_a_space_is_quoted() {
        let mut awkward = spec();
        awkward.program = PathBuf::from("/opt/my gateway/centraid-gateway2");
        assert!(
            systemd_unit(&awkward)
                .contains("ExecStart=\"/opt/my gateway/centraid-gateway2\" serve")
        );
    }
}
