//! `centraid gateway install [--dry-run]` (#1020, D-1020-G1).
//!
//! The impure half of the service installer: resolve the paths, print what is
//! about to happen, write the unit, and print the command that ENABLES it.
//! Every byte of every unit comes from [`super::units`], which is pure.
//!
//! ## Two rules this verb must never lose
//!
//! 1. **`--dry-run` writes nothing.** v0 proved this with a test
//!    (`service-admin.test.ts:93`) and so does `tests/gateway_install.rs`
//!    here. A dry run is what an operator uses to see a unit before trusting
//!    it, so a dry run with a side effect is worse than no dry run at all.
//! 2. **Installing is not enabling.** This verb writes a unit file and prints
//!    `systemctl --user enable --now centraid-gateway`; it never runs it. The
//!    installer script has the same rule for the same reason
//!    (`scripts/install-gateway.mjs:5`–`:8`): a background service that starts
//!    because a package was unpacked is a service nobody chose to run.
//!
//! ## Why this moved out of TypeScript
//!
//! v0's generators live in `packages/server`, which v1's gateway does not
//! load, so the desktop seat and the VPS installer would have had to shell out
//! to a node process to learn the shape of a unit for a Rust binary. The
//! generators are now where the binary is (census §Cross-lane: the desktop
//! consumes `centraid gateway install` as a CLI call).

use std::path::{Path, PathBuf};

use crate::exit;

use super::units::{
    self, Credential, DEFAULT_LAUNCHD_LABEL, DEFAULT_RESTART_SEC, DEFAULT_SYSTEMD_UNIT_NAME,
    KEYSTORE_CREDENTIAL_ID, UnitSpec,
};

/// Which kind of unit to emit. Never inferred from anything but the flags and
/// the host OS: a `--system` install on a mac is a usage error, not a launchd
/// plist with a surprising name.
#[derive(Copy, Clone, Eq, PartialEq)]
pub enum Flavour {
    /// The per-user unit for the host this is running on: a systemd user unit
    /// on Linux, a LaunchAgent on macOS.
    User,
    /// The templated systemd system unit — the VPS default (seam G10).
    System,
}

pub struct InstallArgs {
    pub data_dir: Option<PathBuf>,
    pub dry_run: bool,
    pub flavour: Flavour,
    /// The systemd template instance for `--system`, i.e. the `%i` in
    /// `centraid-gateway@<instance>`.
    pub instance: String,
}

/// The rendered install, with nowhere for the bytes and the destination to
/// disagree: one struct, printed by the dry run and written by the real one.
#[derive(Debug)]
struct Plan {
    unit_path: PathBuf,
    unit: String,
    enable: Vec<String>,
    credential_path: String,
    credential_command: String,
}

pub fn run(args: InstallArgs) -> u8 {
    let plan = match plan(&args) {
        Ok(plan) => plan,
        Err(message) => {
            eprintln!("centraid: {message}");
            return exit::REFUSED;
        }
    };

    // Facts to stderr, the unit to stdout — the rule cmd/mod.rs states for
    // every verb in this module. `centraid gateway install --dry-run >
    // centraid-gateway.service` has to produce a unit file and nothing else.
    eprintln!("centraid: unit        {}", plan.unit_path.display());
    eprintln!("centraid: credential  {}", plan.credential_path);
    print!("{}", plan.unit);

    if args.dry_run {
        eprintln!("centraid: --dry-run — NOTHING was written.");
        eprintln!("centraid: to install it, run the same command without --dry-run.");
        print_next_steps(&plan);
        return exit::OK;
    }

    if let Some(parent) = plan.unit_path.parent()
        && let Err(error) = std::fs::create_dir_all(parent)
    {
        eprintln!("centraid: could not create {}: {error}", parent.display());
        return exit::REFUSED;
    }
    if let Err(error) = std::fs::write(&plan.unit_path, &plan.unit) {
        eprintln!(
            "centraid: could not write {}: {error}",
            plan.unit_path.display()
        );
        return exit::REFUSED;
    }
    eprintln!("centraid: wrote {}", plan.unit_path.display());
    print_next_steps(&plan);
    exit::OK
}

/// The two commands that are NOT run from here, printed so they can be read
/// before they are run.
fn print_next_steps(plan: &Plan) {
    eprintln!("centraid:");
    eprintln!("centraid: the keystore secret is NOT in the unit (a unit file is world-readable).");
    eprintln!("centraid: seal it first:");
    eprintln!("centraid:   {}", plan.credential_command);
    eprintln!("centraid: then enable the service yourself — this command never does:");
    eprintln!("centraid:   {}", plan.enable.join(" "));
}

fn plan(args: &InstallArgs) -> Result<Plan, String> {
    let binary = current_binary();
    match args.flavour {
        Flavour::System => {
            if cfg!(target_os = "macos") {
                return Err(
                    "--system is systemd, and this is macOS. A per-user LaunchAgent is the only \
                     system-managed shape here: drop --system. (deploy/README.md)"
                        .to_owned(),
                );
            }
            if args.instance.is_empty()
                || !args
                    .instance
                    .chars()
                    .all(|character| character.is_ascii_alphanumeric() || character == '-')
            {
                return Err(format!(
                    "--instance {:?} is not a systemd instance name: [A-Za-z0-9-]+, because it \
                     becomes the %i in centraid-gateway@%i and a directory under /var/lib/centraid",
                    args.instance
                ));
            }
            let unit = units::systemd_system_unit_template(
                DEFAULT_SYSTEMD_UNIT_NAME,
                &binary,
                "/var/lib/centraid",
                "/etc/centraid/credentials",
                DEFAULT_RESTART_SEC,
            );
            let credential_path =
                units::systemd_system_credential_path(DEFAULT_SYSTEMD_UNIT_NAME, &args.instance);
            Ok(Plan {
                unit_path: PathBuf::from(units::systemd_system_unit_path(
                    DEFAULT_SYSTEMD_UNIT_NAME,
                )),
                unit,
                enable: vec![
                    "sudo".to_owned(),
                    "systemctl".to_owned(),
                    "enable".to_owned(),
                    "--now".to_owned(),
                    format!("{DEFAULT_SYSTEMD_UNIT_NAME}@{}", args.instance),
                ],
                credential_command: format!(
                    "sudo systemd-creds encrypt --name={KEYSTORE_CREDENTIAL_ID} - {credential_path}"
                ),
                credential_path,
            })
        }
        Flavour::User => {
            let home = home_dir().ok_or_else(|| {
                "no HOME in the environment, so there is no per-user unit path to write to. On a \
                 host with no login session use --system (deploy/README.md)"
                    .to_owned()
            })?;
            let data_dir = args
                .data_dir
                .clone()
                .unwrap_or_else(|| default_user_data_dir(&home));
            let data_dir = data_dir.to_string_lossy().to_string();
            if cfg!(target_os = "macos") {
                let logs = format!("{home}/Library/Logs/Centraid");
                let spec = UnitSpec {
                    exec: vec![
                        binary,
                        "gateway".to_owned(),
                        "--data-dir".to_owned(),
                        data_dir.clone(),
                    ],
                    working_directory: data_dir,
                    stdout_log: format!("{logs}/gateway.out.log"),
                    stderr_log: format!("{logs}/gateway.err.log"),
                    env: Vec::new(),
                    credential: None,
                };
                let path = units::launch_agent_plist_path(&home, DEFAULT_LAUNCHD_LABEL);
                return Ok(Plan {
                    unit: units::launchd_plist(DEFAULT_LAUNCHD_LABEL, &spec),
                    unit_path: PathBuf::from(&path),
                    enable: vec![
                        "launchctl".to_owned(),
                        "bootstrap".to_owned(),
                        "gui/$(id -u)".to_owned(),
                        path,
                    ],
                    // macOS has no systemd-creds. The Keychain is the store,
                    // and naming it here rather than printing a systemd
                    // command that does not exist is the whole point.
                    credential_command: format!(
                        "security add-generic-password -a \"$USER\" -s {KEYSTORE_CREDENTIAL_ID} -w"
                    ),
                    credential_path: format!("login keychain item {KEYSTORE_CREDENTIAL_ID}"),
                });
            }
            let state = format!("{home}/.local/state/centraid");
            let credential_path =
                units::systemd_user_credential_path(&home, DEFAULT_SYSTEMD_UNIT_NAME);
            let spec = UnitSpec {
                exec: vec![
                    binary,
                    "gateway".to_owned(),
                    "--data-dir".to_owned(),
                    data_dir.clone(),
                ],
                working_directory: data_dir,
                stdout_log: format!("{state}/gateway.out.log"),
                stderr_log: format!("{state}/gateway.err.log"),
                env: Vec::new(),
                credential: Some(Credential {
                    id: KEYSTORE_CREDENTIAL_ID.to_owned(),
                    path: credential_path.clone(),
                }),
            };
            Ok(Plan {
                unit: units::systemd_user_unit(&spec, DEFAULT_RESTART_SEC),
                unit_path: PathBuf::from(units::systemd_user_unit_path(
                    &home,
                    DEFAULT_SYSTEMD_UNIT_NAME,
                )),
                enable: vec![
                    "systemctl".to_owned(),
                    "--user".to_owned(),
                    "enable".to_owned(),
                    "--now".to_owned(),
                    DEFAULT_SYSTEMD_UNIT_NAME.to_owned(),
                ],
                credential_command: format!(
                    "systemd-creds encrypt --user --name={KEYSTORE_CREDENTIAL_ID} - {credential_path}"
                ),
                credential_path,
            })
        }
    }
}

/// The absolute path of the running binary, because that is what the unit has
/// to exec. A unit that said `centraid` and relied on `PATH` would work when
/// installed and fail at boot, where systemd's `PATH` is not the shell's.
fn current_binary() -> String {
    std::env::current_exe()
        .ok()
        .and_then(|path| path.canonicalize().ok())
        .map_or_else(
            || "/usr/local/bin/centraid".to_owned(),
            |path| path.to_string_lossy().to_string(),
        )
}

fn home_dir() -> Option<String> {
    std::env::var("HOME").ok().filter(|home| !home.is_empty())
}

/// `$XDG_DATA_HOME/centraid` on Linux, `~/Library/Application Support/Centraid`
/// on macOS — the per-platform convention, stated once.
fn default_user_data_dir(home: &str) -> PathBuf {
    if cfg!(target_os = "macos") {
        return Path::new(home)
            .join("Library")
            .join("Application Support")
            .join("Centraid");
    }
    match std::env::var("XDG_DATA_HOME") {
        Ok(base) if !base.is_empty() => Path::new(&base).join("centraid"),
        _ => Path::new(home)
            .join(".local")
            .join("share")
            .join("centraid"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_system_install_refuses_an_instance_name_that_is_not_one() {
        for bad in ["", "home vault", "../etc", "home/work"] {
            let error = plan(&InstallArgs {
                data_dir: None,
                dry_run: true,
                flavour: Flavour::System,
                instance: bad.to_owned(),
            })
            .expect_err("must refuse");
            assert!(error.contains("--instance"), "{bad:?}: {error}");
        }
    }

    #[test]
    fn the_user_plan_puts_the_data_dir_in_the_exec_line_and_the_working_directory() {
        // `HOME` is set in every environment this runs in; if it is not, the
        // planner's own error is the thing under test elsewhere.
        let Some(home) = home_dir() else {
            return;
        };
        let plan = plan(&InstallArgs {
            data_dir: Some(PathBuf::from("/srv/centraid")),
            dry_run: true,
            flavour: Flavour::User,
            instance: String::new(),
        })
        .expect("a user plan");
        assert!(plan.unit.contains("/srv/centraid"), "{}", plan.unit);
        assert!(plan.unit_path.starts_with(&home));
        // Installing is not enabling: the enable command is printed, never run.
        assert!(!plan.enable.is_empty());
    }
}
