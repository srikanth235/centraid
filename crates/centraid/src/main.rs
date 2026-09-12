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
mod identity;
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
    about = "Centraid: one program, two roles, one gateway anywhere (#1020)",
    version,
    long_about = None
)]
struct Cli {
    /// Log filter, e.g. `centraid_net=debug`. Diagnostics go to stderr and
    /// nothing else does, so a caller can parse stdout.
    #[arg(long, env = "CENTRAID_LOG", global = true)]
    log: Option<String>,

    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Run the vault's authority: the iroh endpoint, the device allowlist and
    /// the pairing lane. Headless — a gateway has no admin UI.
    Gateway {
        /// Where the vault and the allowlist live. Without it the gateway runs
        /// entirely in memory and says so: every pairing is lost on exit.
        #[arg(long)]
        data_dir: Option<PathBuf>,
        /// Mint a pair ticket at startup and print its QR.
        #[arg(long)]
        print_qr: bool,
        /// The name a pairing member sees on the confirm screen.
        #[arg(long, default_value = "Centraid")]
        vault_name: String,
        /// A self-hosted relay url. Omit for n0's public relays; pass
        /// `--no-relay` for direct paths only.
        #[arg(long)]
        relay: Option<String>,
        /// Direct paths only. A LAN or loopback deployment; a symmetric NAT
        /// then means no connection at all.
        #[arg(long, conflicts_with = "relay")]
        no_relay: bool,
        /// With no subcommand, `gateway` RUNS the gateway. `gateway install`
        /// writes an OS service unit for it and never enables it.
        #[command(subcommand)]
        command: Option<GatewayCommand>,
    },
    /// Run a seat: a full replica, the applier, the outbox and every app's
    /// queries and commands.
    Seat {
        #[arg(long)]
        data_dir: Option<PathBuf>,
        /// The local socket this seat serves. Unix domain socket, mode 0600,
        /// with a peer-uid check on every connection (R-1020-26). The desktop
        /// passes `<userData>/seat.sock`.
        #[arg(long)]
        socket: Option<PathBuf>,
        /// The file holding the instance nonce a shell proves. NEVER a flag:
        /// a flag is in the shell history and in every `ps` listing.
        #[arg(long)]
        nonce_file: Option<PathBuf>,
        /// No local copy: forward every call to the gateway and run it under
        /// the caller's principal.
        #[arg(long)]
        thin: bool,
        /// Print the statement catalogue this seat serves and exit.
        #[arg(long)]
        print_catalogue: bool,
        #[command(subcommand)]
        command: Option<SeatCommand>,
    },
    /// Mint a pair ticket and print it.
    Pair {
        #[arg(long)]
        mint: bool,
        #[arg(long)]
        data_dir: Option<PathBuf>,
        #[arg(long, default_value = "Centraid")]
        vault_name: String,
        #[arg(long)]
        no_relay: bool,
    },
    /// Devices: list and revoke. Sends the same commands an owner seat sends.
    Devices {
        #[command(subcommand)]
        command: DevicesCommand,
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
    /// The browser extension's native-messaging host. Launched by the browser,
    /// never by a person.
    NativeHost {
        #[command(subcommand)]
        command: Option<NativeHostCommand>,
    },
    /// The harness surface: what is registered, what is reachable, and where
    /// the two ACP adapters are (#1020, D-1020-AS7). Replaces v0's
    /// `centraid-acp` binary, and deliberately has **no `sql` subcommand**
    /// (#286) — data questions ride the turn's own gated tools.
    Assist {
        #[command(subcommand)]
        command: AssistCommand,
    },
    /// Serve the vault's tool surface to a harness over stdin and stdout
    /// (#1020, D-1020-AS2). Launched by the harness as its MCP child, never by
    /// a person; stdout IS the protocol. There is no listening socket.
    Mcp,
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
enum NativeHostCommand {
    /// Write the host manifest a browser reads, with its extension-id
    /// allowlist. It never copies it into a browser's directory: a capability
    /// that appeared because something was unpacked is a capability nobody
    /// chose to grant (D-1020-G1's precedent).
    Install {
        /// Which browser's manifest shape.
        #[arg(long, value_parser = ["chrome", "firefox"])]
        browser: String,
        /// An extension id this host will talk to. Repeatable, and at least
        /// one is required.
        #[arg(long = "extension-id", required = true)]
        extension_id: Vec<String>,
        /// Where to write it. Without it the manifest is printed and nothing
        /// is written.
        #[arg(long)]
        out: Option<PathBuf>,
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
enum SeatCommand {
    /// Redeem a pair ticket.
    Pair {
        /// The `base64url` ticket, scanned or pasted.
        ticket: String,
    },
}

#[derive(Subcommand)]
enum DevicesCommand {
    List,
    Revoke {
        /// A device id, or the device's endpoint id in hex.
        device: String,
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
        println!("{}", identity::ArtifactIdentity::current().to_json());
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
            Command::Gateway {
                data_dir,
                print_qr,
                vault_name,
                relay,
                no_relay,
                command,
            } => match command {
                Some(GatewayCommand::Install {
                    data_dir,
                    dry_run,
                    system,
                    instance,
                }) => cmd::gateway_install::run(cmd::gateway_install::InstallArgs {
                    data_dir,
                    dry_run,
                    flavour: if system {
                        cmd::gateway_install::Flavour::System
                    } else {
                        cmd::gateway_install::Flavour::User
                    },
                    instance,
                }),
                None => {
                    run::gateway(run::GatewayArgs {
                        data_dir,
                        print_qr,
                        vault_name,
                        relay,
                        no_relay,
                    })
                    .await
                }
            },
            Command::Pair {
                mint,
                data_dir,
                vault_name,
                no_relay,
            } => run::pair_mint(mint, data_dir, vault_name, no_relay).await,
            Command::Seat {
                data_dir,
                socket,
                nonce_file,
                thin,
                print_catalogue,
                command,
            } => match command {
                Some(SeatCommand::Pair { ticket }) => run::seat_pair(&ticket).await,
                None => {
                    cmd::seat::run(cmd::seat::SeatArgs {
                        data_dir,
                        socket,
                        nonce_file,
                        thin,
                        print_catalogue,
                    })
                    .await
                }
            },
            Command::Devices { command } => match command {
                DevicesCommand::List => run::not_yet_available(
                    "devices list",
                    "the command plane needs crates/vault's authority and receipts, wave 2 lane D1",
                ),
                DevicesCommand::Revoke { .. } => run::not_yet_available(
                    "devices revoke",
                    "the command plane needs crates/vault's authority and receipts, wave 2 lane D1",
                ),
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
            Command::NativeHost { command } => match command {
                Some(NativeHostCommand::Install {
                    browser,
                    extension_id,
                    out,
                }) => cmd::native_host::install(cmd::native_host::InstallArgs {
                    browser: if browser == "firefox" {
                        cmd::native_host::Browser::Firefox
                    } else {
                        cmd::native_host::Browser::Chrome
                    },
                    allowed: extension_id,
                    out,
                }),
                // The host itself. stdout IS the protocol, so nothing else may
                // print on it — which is why `install_tracing` writes to
                // stderr for every verb in this binary.
                None => cmd::native_host::run(),
            },
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
            // stdout IS the protocol here too, for the same reason as
            // `native-host`: a stray line desynchronises the harness's parser.
            Command::Mcp => cmd::mcp::run(),
        }
    });
    ExitCode::from(code)
}
