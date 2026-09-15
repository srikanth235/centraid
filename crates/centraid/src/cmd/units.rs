//! The service-unit generators, ported from v0 (#1020, D-1020-G1).
//!
//! **Pure.** No fs, no `Command`, no `std::env` — the same rule the v0 module
//! this replaces states in its first two lines
//! (`packages/server/src/cli/service-unit.ts:1`). Everything impure lives in
//! [`super::gateway_install`], so the bytes of a unit can be tested without a
//! home directory, a platform or a running systemd.
//!
//! ## Why a port and not a rewrite
//!
//! v0's generators are what is installed on every machine that runs a Centraid
//! gateway today, and the unit semantics are load-bearing in ways that are
//! invisible in a diff: `Restart=on-failure` with `RestartSec=5`,
//! `After=network.target`, `WantedBy=default.target`, and — the one that is
//! easiest to get wrong — launchd's `KeepAlive { SuccessfulExit = false }`,
//! which restarts on a crash and **not** after a clean SIGTERM. A rewrite that
//! looked right would have silently changed one of them.
//!
//! So the port is proved by bytes rather than by reading: the fixtures under
//! `contracts/deploy/units/` were produced by running **v0's own generator**
//! over the v1 exec line (`contracts/deploy/units/README.md` has the command),
//! and the tests below assert this module reproduces them exactly. The one
//! fixture with no v0 ancestor is the system unit, and it says so.
//!
//! ## The two systemd shapes, and why both exist
//!
//! v0 generates a **user** unit (`~/.config/systemd/user/…`), which is right
//! for a desktop and wrong for a VPS: a user unit does not survive without a
//! logged-in session unless lingering is enabled, so a VPS install that assumed
//! a system unit was installing a different artifact from the one that exists
//! (census §G seam G10). Both are generated here, the system one is the
//! documented VPS default, and neither pretends to be the other.

/// The systemd `RestartSec`, in seconds. v0's `DEFAULT_SYSTEMD_RESTART_SEC`.
pub const DEFAULT_RESTART_SEC: u32 = 5;
/// v0's `DEFAULT_LAUNCHD_LABEL`.
pub const DEFAULT_LAUNCHD_LABEL: &str = "dev.centraid.gateway";
/// v0's `DEFAULT_SYSTEMD_UNIT_NAME`.
pub const DEFAULT_SYSTEMD_UNIT_NAME: &str = "centraid-gateway";
/// The systemd credential id the keystore secret is loaded under. The gateway
/// reads it out of `$CREDENTIALS_DIRECTORY/<id>`, which is the only reason the
/// id is part of the interface rather than an implementation detail.
pub const KEYSTORE_CREDENTIAL_ID: &str = "centraid-keystore";

/// An encrypted credential handed to the unit by systemd.
///
/// The secret is never a unit-file literal and never an `Environment=` line: a
/// unit file is world-readable and an environment variable is in
/// `/proc/<pid>/environ`. `systemd-creds encrypt` is what puts it behind the
/// host's TPM or its system key, and `LoadCredentialEncrypted=` is what hands
/// it over at start (v0: `service-admin.ts:110`).
pub struct Credential {
    pub id: String,
    pub path: String,
}

/// Everything a unit needs. `exec` is the whole command line, already split:
/// v0 carried `nodeBin` + `cliEntry` + `args` because it launched an
/// interpreter, and v1 launches one executable.
pub struct UnitSpec {
    pub exec: Vec<String>,
    pub working_directory: String,
    pub stdout_log: String,
    pub stderr_log: String,
    pub env: Vec<(String, String)>,
    pub credential: Option<Credential>,
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/// `~/Library/LaunchAgents/<label>.plist` — a LaunchAgent, per user.
pub fn launch_agent_plist_path(home: &str, label: &str) -> String {
    format!("{home}/Library/LaunchAgents/{label}.plist")
}

/// `~/.config/systemd/user/<unit>.service` — a USER unit, per user.
pub fn systemd_user_unit_path(home: &str, unit: &str) -> String {
    format!("{home}/.config/systemd/user/{unit}.service")
}

/// `~/.config/centraid/credentials/<unit>.keystore.cred`.
pub fn systemd_user_credential_path(home: &str, unit: &str) -> String {
    format!("{home}/.config/centraid/credentials/{unit}.keystore.cred")
}

/// `/etc/systemd/system/<unit>@.service` — the templated SYSTEM unit.
pub fn systemd_system_unit_path(unit: &str) -> String {
    format!("/etc/systemd/system/{unit}@.service")
}

/// `/etc/centraid/credentials/<unit>@<instance>.keystore.cred`.
pub fn systemd_system_credential_path(unit: &str, instance: &str) -> String {
    format!("/etc/centraid/credentials/{unit}@{instance}.keystore.cred")
}

// ---------------------------------------------------------------------------
// systemd
// ---------------------------------------------------------------------------

/// v0's `systemdQuote`: leave a token bare when it is made only of characters
/// systemd's unquoted word syntax accepts, otherwise double-quote it and escape
/// backslashes and quotes. Ported character for character — widening the bare
/// set would change the bytes of every unit already installed.
fn systemd_quote(token: &str) -> String {
    let bare = !token.is_empty()
        && token.chars().all(|character| {
            character.is_ascii_alphanumeric()
                || matches!(character, '.' | '_' | '-' | '/' | '=' | ':')
        });
    if bare {
        return token.to_owned();
    }
    format!("\"{}\"", token.replace('\\', "\\\\").replace('"', "\\\""))
}

/// The per-user systemd unit — v0's `buildSystemdUnit`, byte for byte.
pub fn systemd_user_unit(spec: &UnitSpec, restart_sec: u32) -> String {
    let exec: Vec<String> = spec.exec.iter().map(|token| systemd_quote(token)).collect();
    let mut lines = vec![
        "[Unit]".to_owned(),
        "Description=Centraid gateway daemon".to_owned(),
        "After=network.target".to_owned(),
        String::new(),
        "[Service]".to_owned(),
        "Type=simple".to_owned(),
    ];
    for (key, value) in &spec.env {
        lines.push(format!(
            "Environment={}",
            systemd_quote(&format!("{key}={value}"))
        ));
    }
    if let Some(credential) = &spec.credential {
        lines.push(format!(
            "LoadCredentialEncrypted={}:{}",
            credential.id,
            systemd_quote(&credential.path)
        ));
    }
    lines.extend([
        format!("ExecStart={}", exec.join(" ")),
        format!("WorkingDirectory={}", spec.working_directory),
        "Restart=on-failure".to_owned(),
        format!("RestartSec={restart_sec}"),
        format!("StandardOutput=append:{}", spec.stdout_log),
        format!("StandardError=append:{}", spec.stderr_log),
        String::new(),
        "[Install]".to_owned(),
        "WantedBy=default.target".to_owned(),
        String::new(),
    ]);
    lines.join("\n")
}

/// The templated SYSTEM unit — **new in v1, with no v0 ancestor** (seam G10).
///
/// Four things differ from the user unit and each is the reason this shape
/// exists at all:
///
/// * `DynamicUser=yes` + `StateDirectory=` — a VPS has no owner account to run
///   as. systemd allocates the uid and owns `/var/lib/centraid/<instance>`,
///   so there is no `centraid` user to create, to forget to lock, or to leave
///   behind on uninstall.
/// * `WantedBy=multi-user.target`, not `default.target` — it must start at boot
///   with nobody logged in, which is precisely what the user unit cannot do.
/// * `StandardOutput=journal`, not `append:<path>` — under `DynamicUser` the
///   service cannot write to a path it does not own, so a log file would be a
///   start failure. The journal is also what an operator on a VPS reads.
/// * `%i` — one host, many vaults, one unit file. `systemctl enable
///   centraid-gateway@home` and `@work` are two instances of the same file
///   rather than two copies that drift.
///
/// The hardening lines are the subset that does not fight the product:
/// `ProtectSystem=strict` with `StateDirectory` writable, `ProtectHome=yes`
/// because the data directory is under `/var/lib`, and `NoNewPrivileges`.
/// There is no `PrivateNetwork` — iroh needs the network — and no
/// `RestrictAddressFamilies`, because the endpoint is UDP and a wrong list here
/// fails as an unexplained bind error.
pub fn systemd_system_unit_template(
    unit: &str,
    binary: &str,
    state_root: &str,
    credential_dir: &str,
    restart_sec: u32,
) -> String {
    let data_dir = format!("{state_root}/%i");
    let lines = vec![
        "[Unit]".to_owned(),
        "Description=Centraid gateway daemon (%i)".to_owned(),
        "After=network.target".to_owned(),
        String::new(),
        "[Service]".to_owned(),
        "Type=simple".to_owned(),
        "DynamicUser=yes".to_owned(),
        format!(
            "StateDirectory={}/%i",
            state_root.trim_start_matches("/var/lib/")
        ),
        format!(
            "LoadCredentialEncrypted={KEYSTORE_CREDENTIAL_ID}:{credential_dir}/{unit}@%i.keystore.cred"
        ),
        format!("ExecStart={binary} gateway --data-dir {data_dir}"),
        format!("WorkingDirectory={data_dir}"),
        "Restart=on-failure".to_owned(),
        format!("RestartSec={restart_sec}"),
        "NoNewPrivileges=yes".to_owned(),
        "PrivateTmp=yes".to_owned(),
        "ProtectSystem=strict".to_owned(),
        "ProtectHome=yes".to_owned(),
        "StandardOutput=journal".to_owned(),
        "StandardError=journal".to_owned(),
        String::new(),
        "[Install]".to_owned(),
        "WantedBy=multi-user.target".to_owned(),
        String::new(),
    ];
    lines.join("\n")
}

// ---------------------------------------------------------------------------
// launchd
// ---------------------------------------------------------------------------

/// v0's `xmlEscape`, in the same order (`&` first, or the entities it writes
/// would be escaped again).
fn xml_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

/// The LaunchAgent plist — v0's `buildLaunchdPlist`, byte for byte, tabs
/// included.
///
/// `KeepAlive { SuccessfulExit = false }` is the line that matters: launchd
/// restarts the job when it crashes and leaves it stopped after a clean exit,
/// so `centraid` exiting 0 on a SIGTERM is a stop and not a restart loop.
pub fn launchd_plist(label: &str, spec: &UnitSpec) -> String {
    let mut lines = vec![
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>".to_owned(),
        "<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">".to_owned(),
        "<plist version=\"1.0\">".to_owned(),
        "<dict>".to_owned(),
        "\t<key>Label</key>".to_owned(),
        format!("\t<string>{}</string>", xml_escape(label)),
        "\t<key>ProgramArguments</key>".to_owned(),
        "\t<array>".to_owned(),
    ];
    for argument in &spec.exec {
        lines.push(format!("\t\t<string>{}</string>", xml_escape(argument)));
    }
    lines.push("\t</array>".to_owned());
    if !spec.env.is_empty() {
        lines.push("\t<key>EnvironmentVariables</key>".to_owned());
        lines.push("\t<dict>".to_owned());
        for (key, value) in &spec.env {
            lines.push(format!("\t\t<key>{}</key>", xml_escape(key)));
            lines.push(format!("\t\t<string>{}</string>", xml_escape(value)));
        }
        lines.push("\t</dict>".to_owned());
    }
    lines.extend([
        "\t<key>WorkingDirectory</key>".to_owned(),
        format!("\t<string>{}</string>", xml_escape(&spec.working_directory)),
        "\t<key>RunAtLoad</key>".to_owned(),
        "\t<true/>".to_owned(),
        "\t<key>KeepAlive</key>".to_owned(),
        "\t<dict>".to_owned(),
        "\t\t<key>SuccessfulExit</key>".to_owned(),
        "\t\t<false/>".to_owned(),
        "\t</dict>".to_owned(),
        "\t<key>StandardOutPath</key>".to_owned(),
        format!("\t<string>{}</string>", xml_escape(&spec.stdout_log)),
        "\t<key>StandardErrorPath</key>".to_owned(),
        format!("\t<string>{}</string>", xml_escape(&spec.stderr_log)),
        "</dict>".to_owned(),
        "</plist>".to_owned(),
        String::new(),
    ]);
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The fixture directory, relative to the repository root.
    fn fixture(name: &str) -> String {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .and_then(std::path::Path::parent)
            .expect("repo root")
            .to_path_buf();
        std::fs::read_to_string(root.join("contracts/deploy/units").join(name))
            .unwrap_or_else(|error| panic!("read contracts/deploy/units/{name}: {error}"))
    }

    fn user_spec() -> UnitSpec {
        UnitSpec {
            exec: [
                "/usr/local/bin/centraid",
                "gateway",
                "--data-dir",
                "/home/owner/.local/share/centraid",
            ]
            .iter()
            .map(|token| (*token).to_owned())
            .collect(),
            working_directory: "/home/owner/.local/share/centraid".to_owned(),
            stdout_log: "/home/owner/.local/state/centraid/gateway.out.log".to_owned(),
            stderr_log: "/home/owner/.local/state/centraid/gateway.err.log".to_owned(),
            env: Vec::new(),
            credential: Some(Credential {
                id: KEYSTORE_CREDENTIAL_ID.to_owned(),
                path: "/home/owner/.config/centraid/credentials/centraid-gateway.keystore.cred"
                    .to_owned(),
            }),
        }
    }

    /// THE PORT'S PROOF. The fixture was written by v0's own
    /// `buildSystemdUnit`; if this Rust generator differs by one byte, the unit
    /// installed on an owner's machine after the port is not the unit that was
    /// installed before it.
    #[test]
    fn the_user_unit_is_byte_identical_to_the_v0_generator() {
        assert_eq!(
            systemd_user_unit(&user_spec(), DEFAULT_RESTART_SEC),
            fixture("centraid-gateway.user.service.expected")
        );
    }

    #[test]
    fn the_launch_agent_is_byte_identical_to_the_v0_generator() {
        let spec = UnitSpec {
            exec: [
                "/usr/local/bin/centraid",
                "gateway",
                "--data-dir",
                "/Users/owner/Library/Application Support/Centraid",
            ]
            .iter()
            .map(|token| (*token).to_owned())
            .collect(),
            working_directory: "/Users/owner/Library/Application Support/Centraid".to_owned(),
            stdout_log: "/Users/owner/Library/Logs/Centraid/gateway.out.log".to_owned(),
            stderr_log: "/Users/owner/Library/Logs/Centraid/gateway.err.log".to_owned(),
            env: Vec::new(),
            credential: None,
        };
        assert_eq!(
            launchd_plist(DEFAULT_LAUNCHD_LABEL, &spec),
            fixture("dev.centraid.gateway.plist.expected")
        );
    }

    /// No v0 ancestor, so the fixture is this generator's own output — which
    /// makes it a REGRESSION fixture and not a port proof, and the difference
    /// is worth stating: nothing outside this repository has ever run these
    /// bytes, so the first real VPS install is what confirms them (owner
    /// hand-off, docs/release.md).
    #[test]
    fn the_system_template_matches_its_recorded_bytes() {
        assert_eq!(
            systemd_system_unit_template(
                DEFAULT_SYSTEMD_UNIT_NAME,
                "/usr/local/bin/centraid",
                "/var/lib/centraid",
                "/etc/centraid/credentials",
                DEFAULT_RESTART_SEC,
            ),
            fixture("centraid-gateway@.system.service.expected")
        );
    }

    /// The checked-in reference copies under `deploy/` must be the same bytes
    /// the generator emits. Two copies of a unit is how the documented one and
    /// the installed one drift; this is the test that makes that a red.
    #[test]
    fn the_deploy_tree_copies_are_the_generator_output() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .and_then(std::path::Path::parent)
            .expect("repo root")
            .to_path_buf();
        for (deployed, expected) in [
            (
                "deploy/systemd/centraid-gateway.service",
                "centraid-gateway.user.service.expected",
            ),
            (
                "deploy/systemd/system/centraid-gateway@.service",
                "centraid-gateway@.system.service.expected",
            ),
            (
                "deploy/launchd/dev.centraid.gateway.plist",
                "dev.centraid.gateway.plist.expected",
            ),
        ] {
            let on_disk = std::fs::read_to_string(root.join(deployed))
                .unwrap_or_else(|error| panic!("read {deployed}: {error}"));
            assert_eq!(on_disk, fixture(expected), "{deployed} has drifted");
        }
    }

    /// A path with a space is the case v0's quoting exists for, and the case a
    /// rewrite gets wrong: systemd's unquoted word syntax would read
    /// `Application` and `Support` as two arguments.
    #[test]
    fn a_path_with_a_space_is_quoted_in_systemd_and_not_in_the_plist() {
        let mut spec = user_spec();
        spec.exec = [
            "/usr/local/bin/centraid",
            "gateway",
            "--data-dir",
            "/srv/my vaults",
        ]
        .iter()
        .map(|token| (*token).to_owned())
        .collect();
        let unit = systemd_user_unit(&spec, DEFAULT_RESTART_SEC);
        assert!(
            unit.contains(
                "ExecStart=/usr/local/bin/centraid gateway --data-dir \"/srv/my vaults\""
            ),
            "{unit}"
        );
        // The plist has no quoting to do: each argument is its own element.
        let plist = launchd_plist(DEFAULT_LAUNCHD_LABEL, &spec);
        assert!(plist.contains("<string>/srv/my vaults</string>"), "{plist}");
    }

    #[test]
    fn xml_and_environment_values_are_escaped() {
        let mut spec = user_spec();
        spec.env = vec![("CENTRAID_LOG".to_owned(), "centraid=debug".to_owned())];
        spec.working_directory = "/srv/a&b".to_owned();
        assert!(
            launchd_plist("dev.centraid.gateway", &spec).contains("<string>/srv/a&amp;b</string>")
        );
        assert!(
            systemd_user_unit(&spec, DEFAULT_RESTART_SEC)
                .contains("Environment=CENTRAID_LOG=centraid=debug")
        );
    }

    #[test]
    fn the_paths_are_the_v0_paths() {
        assert_eq!(
            launch_agent_plist_path("/Users/owner", DEFAULT_LAUNCHD_LABEL),
            "/Users/owner/Library/LaunchAgents/dev.centraid.gateway.plist"
        );
        assert_eq!(
            systemd_user_unit_path("/home/owner", DEFAULT_SYSTEMD_UNIT_NAME),
            "/home/owner/.config/systemd/user/centraid-gateway.service"
        );
        assert_eq!(
            systemd_user_credential_path("/home/owner", DEFAULT_SYSTEMD_UNIT_NAME),
            "/home/owner/.config/centraid/credentials/centraid-gateway.keystore.cred"
        );
        assert_eq!(
            systemd_system_unit_path(DEFAULT_SYSTEMD_UNIT_NAME),
            "/etc/systemd/system/centraid-gateway@.service"
        );
    }
}
