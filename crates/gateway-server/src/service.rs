//! THE SERVICE INSTALL, CARRIED OVER FROM THE DELETED v0 UNITS (#1029 §3).
//!
//! v0's `centraid-gateway service` wrote a launchd agent or a systemd unit and
//! then asked the platform to load it; W2 deleted the crate it lived in along
//! with the seat plane, and this is where it lands. The shape is kept —
//! **render, then act, and `--dry-run` prints without touching the host** —
//! because it is the shape an operator can check before it runs as root.
//!
//! # WHAT DID NOT COME ACROSS, AND WHY THAT IS THE POINT
//!
//! v0's installer spent most of its length on **key custody**: adopting a
//! keystore credential, writing a systemd credential file, putting a wrapping
//! key in the macOS keychain, and being careful never to mint a fresh one
//! because a service that could not decrypt the keys it inherited poisoned
//! custody. **None of that exists here, because the gateway is blind.** There
//! is no key to wrap, no credential to adopt and no keychain entry to keep in
//! step with a data directory — the server holds public keys, hashes of
//! ciphertext and padded sizes, and an operator who copies its data directory
//! to another box has copied everything it has.
//!
//! What is left is a unit file, and the two properties that make it safe:
//!
//! - **It runs as its own unprivileged user** and is confined by the
//!   platform's own sandbox directives, because a home server's gateway is
//!   reachable from the internet and is exactly the process an attacker
//!   reaches first;
//! - **It is a USER unit by default** (`systemd --user`, a launchd
//!   `LaunchAgent`), so installing does not need root at all. An operator who
//!   wants it up before login asks for a system unit explicitly.

use std::fmt::Write as _;
use std::path::{Path, PathBuf};

/// Which init system a unit is for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Platform {
    Systemd,
    Launchd,
}

impl Platform {
    /// The platform this binary is running on, or `None` where neither applies
    /// (Windows, where a self-hosted gateway is a container rather than a
    /// service, which is `docker/README.md`'s answer).
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

/// Everything a unit file is rendered from.
#[derive(Debug, Clone)]
pub struct UnitSpec {
    /// `dev.centraid.gateway`.
    pub label: String,
    /// The absolute path to this binary.
    pub program: PathBuf,
    /// The arguments after it, e.g. `["serve", "--config", "/etc/…"]`.
    pub arguments: Vec<String>,
    /// The data directory, which is the one path the unit is allowed to write.
    pub data_dir: PathBuf,
    /// Where the service's own log goes on launchd. systemd journals.
    pub log_dir: PathBuf,
}

/// The default unit label, and the reverse-DNS name launchd wants.
pub const DEFAULT_LABEL: &str = "dev.centraid.gateway";

/// Render a systemd unit.
///
/// The hardening directives are not decoration: this process listens on a
/// public port, and every one of them removes something it provably does not
/// need. `ProtectSystem=strict` with a single `ReadWritePaths` is the important
/// one — it makes the data directory the only writable path in the filesystem,
/// so a remote-code-execution bug in the HTTP surface cannot reach a user's
/// documents.
#[must_use]
pub fn systemd_unit(spec: &UnitSpec) -> String {
    let mut out = String::new();
    let _ = writeln!(out, "[Unit]");
    let _ = writeln!(out, "Description=Centraid gateway ({})", spec.label);
    let _ = writeln!(out, "Documentation=https://centraid.dev/docs/self-hosting");
    let _ = writeln!(out, "After=network-online.target");
    let _ = writeln!(out, "Wants=network-online.target");
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
    // A gateway that has been restarting all night is a gateway an operator
    // should be told about, not one that hides it by trying forever.
    let _ = writeln!(out, "StartLimitIntervalSec=600");
    let _ = writeln!(out, "StartLimitBurst=10");
    let _ = writeln!(out, "WorkingDirectory={}", spec.data_dir.display());
    let _ = writeln!(out);
    let _ = writeln!(out, "# The gateway is blind and reachable. Everything it");
    let _ = writeln!(out, "# provably does not need is taken away here.");
    let _ = writeln!(out, "NoNewPrivileges=true");
    let _ = writeln!(out, "PrivateTmp=true");
    let _ = writeln!(out, "PrivateDevices=true");
    let _ = writeln!(out, "ProtectSystem=strict");
    let _ = writeln!(out, "ProtectHome=true");
    let _ = writeln!(out, "ProtectKernelTunables=true");
    let _ = writeln!(out, "ProtectKernelModules=true");
    let _ = writeln!(out, "ProtectControlGroups=true");
    let _ = writeln!(out, "RestrictSUIDSGID=true");
    let _ = writeln!(out, "RestrictNamespaces=true");
    let _ = writeln!(out, "RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX");
    let _ = writeln!(out, "LockPersonality=true");
    let _ = writeln!(out, "MemoryDenyWriteExecute=true");
    let _ = writeln!(out, "SystemCallArchitectures=native");
    let _ = writeln!(out, "SystemCallFilter=@system-service");
    let _ = writeln!(out, "ReadWritePaths={}", spec.data_dir.display());
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

/// The unit file and where it goes, without touching the host.
///
/// # Errors
///
/// If neither init system applies.
pub fn render(platform: Platform, spec: &UnitSpec, home: &Path) -> (PathBuf, String) {
    match platform {
        Platform::Systemd => (systemd_unit_path(home, &spec.label), systemd_unit(spec)),
        Platform::Launchd => (launchd_plist_path(home, &spec.label), launchd_plist(spec)),
    }
}

/// Write the unit. **The caller decides whether this runs**; `--dry-run` prints
/// [`render`]'s output instead of calling this.
///
/// # Errors
///
/// If the directory cannot be created or the file cannot be written.
pub fn install(platform: Platform, spec: &UnitSpec, home: &Path) -> std::io::Result<PathBuf> {
    let (path, text) = render(platform, spec, home);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&path, text)?;
    Ok(path)
}

/// Shell-quote one systemd `ExecStart` word.
fn quote(word: &str) -> String {
    if word
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '-' | '_' | '.' | '=' | ':'))
    {
        return word.to_owned();
    }
    format!("\"{}\"", word.replace('\\', "\\\\").replace('"', "\\\""))
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
            program: PathBuf::from("/usr/local/bin/centraid-gateway"),
            arguments: vec![
                "serve".to_owned(),
                "--config".to_owned(),
                "/srv/vault/gateway.json".to_owned(),
            ],
            data_dir: PathBuf::from("/srv/vault"),
            log_dir: PathBuf::from("/srv/vault/logs"),
        }
    }

    /// THE DATA DIRECTORY IS THE ONLY WRITABLE PATH. This is the directive that
    /// keeps a bug in a public HTTP surface away from the rest of the disk, and
    /// a unit that lost it would look identical from the outside.
    #[test]
    fn the_systemd_unit_confines_the_process_to_its_data_directory() {
        let unit = systemd_unit(&spec());
        assert!(unit.contains("ProtectSystem=strict"), "{unit}");
        assert!(unit.contains("ReadWritePaths=/srv/vault"), "{unit}");
        assert!(unit.contains("ProtectHome=true"), "{unit}");
        assert!(unit.contains("NoNewPrivileges=true"), "{unit}");
        assert!(
            unit.contains("RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX"),
            "{unit}"
        );
    }

    /// NO KEY MATERIAL IN A UNIT FILE. v0's installer carried a wrapping key
    /// through a systemd credential and a keychain entry; a blind gateway has
    /// none, and a unit that started carrying one would mean something had gone
    /// very wrong upstream of here.
    #[test]
    fn no_unit_carries_a_credential_a_key_or_a_secret() {
        for text in [systemd_unit(&spec()), launchd_plist(&spec())] {
            let lowered = text.to_ascii_lowercase();
            for needle in [
                "loadcredential",
                "secret",
                "password",
                "keystore",
                "master_key",
                "keychain",
            ] {
                assert!(
                    !lowered.contains(needle),
                    "a unit file names `{needle}`:\n{text}"
                );
            }
        }
    }

    /// A launchd agent is well-formed plist and names the same program.
    #[test]
    fn the_launchd_agent_runs_at_load_and_names_the_binary() {
        let plist = launchd_plist(&spec());
        assert!(plist.starts_with("<?xml version=\"1.0\""));
        assert!(plist.contains("<string>dev.centraid.gateway</string>"));
        assert!(plist.contains("<string>/usr/local/bin/centraid-gateway</string>"));
        assert!(plist.contains("<string>serve</string>"));
        assert!(plist.contains("<key>RunAtLoad</key>"));
        assert_eq!(plist.matches("<plist").count(), 1, "one plist element only");
    }

    /// A USER unit by default: installing needs no root.
    #[test]
    fn both_units_install_under_the_operators_own_home() {
        let home = Path::new("/home/ada");
        assert_eq!(
            systemd_unit_path(home, DEFAULT_LABEL),
            PathBuf::from("/home/ada/.config/systemd/user/dev.centraid.gateway.service")
        );
        assert_eq!(
            launchd_plist_path(home, DEFAULT_LABEL),
            PathBuf::from("/home/ada/Library/LaunchAgents/dev.centraid.gateway.plist")
        );
    }

    /// `--dry-run` renders without touching the host, which is the property
    /// that makes it checkable before it runs.
    #[test]
    fn rendering_writes_nothing() {
        let directory = tempfile::tempdir().expect("a temporary home");
        let (path, text) = render(Platform::Systemd, &spec(), directory.path());
        assert!(!text.is_empty());
        assert!(!path.exists(), "render must not create the unit file");
    }

    #[test]
    fn installing_writes_the_unit_where_render_said_it_would() {
        let directory = tempfile::tempdir().expect("a temporary home");
        let (expected, text) = render(Platform::Systemd, &spec(), directory.path());
        let written = install(Platform::Systemd, &spec(), directory.path()).expect("install");
        assert_eq!(written, expected);
        assert_eq!(std::fs::read_to_string(&written).expect("read"), text);
    }

    /// A path with a space in it must not become two `ExecStart` words.
    #[test]
    fn a_program_path_with_a_space_is_quoted() {
        let mut awkward = spec();
        awkward.program = PathBuf::from("/opt/my gateway/centraid-gateway");
        let unit = systemd_unit(&awkward);
        assert!(
            unit.contains("ExecStart=\"/opt/my gateway/centraid-gateway\" serve"),
            "{unit}"
        );
    }
}
