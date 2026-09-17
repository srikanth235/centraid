#![forbid(unsafe_code)]
//! `centraid` — the one binary (#1020, D-1020-C11).
//!
//! **The CLI is a client, not a privileged path.** `centraid devices revoke`
//! and every other admin verb send the same `Command` messages an owner seat
//! sends and produce the same receipts (#1020 Decision). There is no
//! privileged code path here to audit separately, which is why `admin.proto`
//! defines command *inputs* rather than a second envelope.
//!
//! **A subcommand that is not built yet FAILS.** Every verb whose
//! implementation lands in a later lane returns
//! [`ExitCode::NOT_YET_AVAILABLE`] (3) with the lane that owns it named in the
//! message — never a silent stub, and never a zero exit on work that did not
//! happen. Wave 2's lane D2 and lane R fill them in.
//!
//! See `README.md` for the subcommands, the exit codes, and the no-listener
//! claim.

use std::path::PathBuf;
use std::process::ExitCode;

use clap::{Parser, Subcommand};

mod cmd;
mod run;

/// The exit codes, stated once. A script that wraps this binary branches on
/// these numbers, so they are as much of an interface as the subcommands.
pub mod exit {
    /// It worked.
    pub const OK: u8 = 0;
    /// The command ran and refused: a bad ticket, a device that is not
    /// enrolled, a vault that will not open.
    pub const REFUSED: u8 = 1;
    /// The arguments were wrong. clap's own code, kept rather than remapped so
    /// that `centraid --help`'s behaviour is the behaviour every clap binary
    /// has.
    pub const USAGE: u8 = 2;
    /// The verb exists and its implementation lands in a later lane. NEVER a
    /// silent stub (#1020, D-1020-C11).
    pub const NOT_YET_AVAILABLE: u8 = 3;
}

#[derive(Parser)]
#[command(
    name = "centraid",
    about = "Centraid: the operator-facing verbs over a vault directory (#1029)",
    version,
    long_about = None
)]
struct Cli {
    /// Log filter, e.g. `centraid=debug`. Diagnostics go to stderr and
    /// nothing else does, so a caller can parse stdout.
    #[arg(long, env = "CENTRAID_LOG", global = true)]
    log: Option<String>,

    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Write an OS service unit for a gateway and print the command that
    /// enables it.
    ///
    /// **The gateway no longer RUNS from here** (#1029 §6). `centraid gateway`
    /// served the iroh endpoint, the allowlist and the pairing lane to paired
    /// seats; there are none. What survives is the service install, and it
    /// moves to `crates/gateway-server` when that exists (#1029 W4b).
    Gateway {
        #[command(subcommand)]
        command: GatewayCommand,
    },
    /// Backup.
    Backup {
        #[command(subcommand)]
        command: BackupCommand,
    },
    /// Check a vault and report. Read-only and lock-free, so it is safe against
    /// a serving gateway — which is why the container health check runs it.
    Doctor {
        #[arg(long)]
        data_dir: Option<PathBuf>,
        /// Print the JSON report even when the vault is clean.
        #[arg(long)]
        json: bool,
    },
    /// Restore from a recovery kit. The kit carries the keys; the blob store
    /// carries the bytes.
    Recover {
        #[arg(long)]
        kit: Option<PathBuf>,
        /// The kit's password, read from a file. NEVER a flag: a flag is in the
        /// shell history and in every `ps` listing on the host.
        #[arg(long)]
        password_file: Option<PathBuf>,
        #[arg(long)]
        data_dir: Option<PathBuf>,
        /// Point-in-time: replay WAL segments up to this instant and no
        /// further. `YYYY-MM-DDTHH:MM:SS[.mmm]Z`; anything else is exit 2.
        #[arg(long)]
        at: Option<String>,
        /// Materialise every content blob now instead of on demand.
        #[arg(long)]
        full: bool,
        /// Which vault, when the kit carries more than one.
        #[arg(long)]
        vault: Option<String>,
        /// Yes, restore — after reading what it says it is about to do.
        #[arg(long)]
        yes: bool,
    },
    /// Export a portable copy: the vault as a snapshot generation, plus a
    /// password-wrapped recovery kit.
    Export {
        #[arg(long)]
        data_dir: Option<PathBuf>,
        #[arg(long)]
        out: Option<PathBuf>,
        /// The passphrase to wrap the bundle's recovery kit with, from a file.
        #[arg(long)]
        password_file: Option<PathBuf>,
    },
    /// The harness surface: what is registered, what is reachable, and where
    /// the two ACP adapters are (#1020, D-1020-AS7). Replaces v0's
    /// `centraid-acp` binary, and deliberately has **no `sql` subcommand**
    /// (#286) — data questions ride the turn's own gated tools.
    Assist {
        #[command(subcommand)]
        command: AssistCommand,
    },
    /// The automations surface: what this release ships, what a trigger may
    /// watch, when a schedule next fires, and the webhook door (#1020,
    /// D-1020-AU5). A **client**: the gateway holds the scheduler, so nothing
    /// here fires anything.
    Automations {
        #[command(subcommand)]
        command: AutomationsCommand,
    },
    /// Serve the vault's tool surface to a harness over stdin and stdout
    /// (#1020, D-1020-AS2). Launched by the harness as its MCP child, never by
    /// a person; stdout IS the protocol. There is no listening socket.
    Mcp,
}

#[derive(Subcommand)]
enum AutomationsCommand {
    /// The recipe catalogue: six templates, their provenance tiers, what each
    /// reads and which command its result is persisted through.
    Recipes {
        #[arg(long)]
        json: bool,
    },
    /// Every entity a condition or data trigger may watch. The positive form
    /// of the loop guard: the runtime's own tables are absent rather than
    /// listed as forbidden.
    Watchable {
        #[arg(long)]
        json: bool,
    },
    /// The next runs of one cron expression. `--zone` is REQUIRED: a schedule
    /// has no meaning without one, and this machine's clock is not an answer.
    Next {
        expr: String,
        #[arg(long)]
        zone: Option<String>,
        #[arg(long, default_value_t = 5)]
        count: usize,
        #[arg(long)]
        json: bool,
    },
    /// Hand one inbound webhook delivery to the gateway, payload on stdin.
    /// The secret comes from a file or the environment, never from a flag.
    Deliver {
        webhook_id: String,
        #[arg(long)]
        delivery_id: Option<String>,
        #[arg(long)]
        secret_file: Option<PathBuf>,
        #[arg(long)]
        json: bool,
    },
}

#[derive(Subcommand)]
enum AssistCommand {
    /// Every registered harness, whether it is in the supported five, and what
    /// would be spawned for it.
    Harnesses {
        #[arg(long)]
        json: bool,
    },
    /// One kind's `--version` probe. An older-than-minimum version WARNS and
    /// stays reachable; a version that cannot be read claims nothing.
    Preflight {
        kind: String,
        #[arg(long)]
        json: bool,
    },
    /// Where the two npm ACP adapters are.
    Adapters {
        /// Print the install command instead of the current state. It is
        /// printed rather than run: installing an adapter downloads and then
        /// executes third-party code.
        #[arg(long)]
        install: bool,
        #[arg(long)]
        json: bool,
    },
}

#[derive(Subcommand)]
enum GatewayCommand {
    /// Write an OS service unit for this gateway and print the command that
    /// enables it. It never enables it: a background service that starts
    /// because a file was unpacked is a service nobody chose to run
    /// (`scripts/install-gateway.mjs:5`–`:8`, D-1020-G1).
    Install {
        #[arg(long)]
        data_dir: Option<PathBuf>,
        /// Print the unit and the commands, write nothing.
        #[arg(long)]
        dry_run: bool,
        /// A templated systemd SYSTEM unit instead of a per-user one — the VPS
        /// shape, because a user unit does not survive without a login session
        /// unless lingering is enabled (census §G seam G10).
        #[arg(long)]
        system: bool,
        /// The `%i` in `centraid-gateway@%i`, for `--system`.
        #[arg(long, default_value = "default")]
        instance: String,
    },
}

#[derive(Subcommand)]
enum BackupCommand {
    /// Take a generation now: the snapshot, the sealed WAL tail, the manifest.
    Now {
        #[arg(long)]
        data_dir: Option<PathBuf>,
        /// Take one even when the policy says it is not due.
        #[arg(long)]
        force: bool,
    },
}

/// `centraid --version --json` prints the ARTIFACT IDENTITY (#1020 Artifacts,
/// D-1020-G2): the version, the git sha, the artifact digest, the vault schema
/// version, and whether this is a development build.
///
/// Intercepted before clap rather than modelled as a subcommand, because clap
/// owns `--version` and the shape `--version --json` is what `deploy/vps/
/// install.sh` and the release smoke read. A `centraid version --json`
/// subcommand would have been tidier inside this file and a second spelling for
/// everyone outside it.
fn version_json_requested() -> bool {
    let mut version = false;
    let mut json = false;
    for argument in std::env::args().skip(1) {
        match argument.as_str() {
            "--version" | "-V" => version = true,
            "--json" => json = true,
            _ => {}
        }
    }
    version && json
}

fn main() -> ExitCode {
    if version_json_requested() {
        println!(
            "{}",
            centraid_core::identity::ArtifactIdentity::current().to_json()
        );
        return ExitCode::from(exit::OK);
    }
    let cli = Cli::parse();
    run::install_tracing(cli.log.as_deref());

    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("centraid: could not start the async runtime: {error}");
            return ExitCode::from(exit::REFUSED);
        }
    };

    let code = runtime.block_on(async move {
        match cli.command {
            Command::Gateway { command } => match command {
                GatewayCommand::Install {
                    data_dir,
                    dry_run,
                    system,
                    instance,
                } => cmd::gateway_install::run(cmd::gateway_install::InstallArgs {
                    data_dir,
                    dry_run,
                    flavour: if system {
                        cmd::gateway_install::Flavour::System
                    } else {
                        cmd::gateway_install::Flavour::User
                    },
                    instance,
                }),
            },
            Command::Backup { command } => match command {
                BackupCommand::Now { data_dir, force } => {
                    cmd::backup::now(cmd::backup::BackupNowArgs { data_dir, force })
                }
            },
            Command::Doctor { data_dir, json } => {
                cmd::doctor::run(cmd::doctor::DoctorArgs { data_dir, json })
            }
            Command::Recover {
                kit,
                password_file,
                data_dir,
                at,
                full,
                vault,
                yes,
            } => cmd::recover::run(cmd::recover::RecoverArgs {
                kit,
                password_file,
                data_dir,
                at,
                full,
                vault,
                yes,
            }),
            Command::Export {
                data_dir,
                out,
                password_file,
            } => cmd::export::run(cmd::export::ExportArgs {
                data_dir,
                out,
                password_file,
            }),
            Command::Assist { command } => match command {
                AssistCommand::Harnesses { json } => {
                    cmd::assist::run(cmd::assist::Args::Harnesses { json })
                }
                AssistCommand::Preflight { kind, json } => {
                    cmd::assist::run(cmd::assist::Args::Preflight { kind, json })
                }
                AssistCommand::Adapters { install, json } => {
                    cmd::assist::run(cmd::assist::Args::Adapters { install, json })
                }
            },
            Command::Automations { command } => match command {
                AutomationsCommand::Recipes { json } => {
                    cmd::automations::run(cmd::automations::Args::Recipes { json })
                }
                AutomationsCommand::Watchable { json } => {
                    cmd::automations::run(cmd::automations::Args::Watchable { json })
                }
                AutomationsCommand::Next {
                    expr,
                    zone,
                    count,
                    json,
                } => cmd::automations::run(cmd::automations::Args::Next {
                    expr,
                    zone,
                    count,
                    json,
                }),
                AutomationsCommand::Deliver {
                    webhook_id,
                    delivery_id,
                    secret_file,
                    json,
                } => cmd::automations::run(cmd::automations::Args::Deliver {
                    webhook_id,
                    delivery_id,
                    secret_file,
                    json,
                }),
            },
            // stdout IS the protocol here too, for the same reason as
            // `native-host`: a stray line desynchronises the harness's parser.
            Command::Mcp => cmd::mcp::run(),
        }
    });
    ExitCode::from(code)
}
