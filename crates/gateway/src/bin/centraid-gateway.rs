#![forbid(unsafe_code)]
//! `centraid-gateway` — the gateway a member runs (#1080, #1212).
//!
//! ```text
//! centraid-gateway serve    --data-dir ~/centraid-gateway [--bind 0.0.0.0:8443] [--name NAME] [--announce HOST:PORT]... [--no-mdns]
//! centraid-gateway pair     --data-dir ~/centraid-gateway [--port 8443] [--name NAME] [--announce HOST:PORT]...
//! centraid-gateway pairings --data-dir ~/centraid-gateway [revoke <token id>]
//! centraid-gateway vault    <id8> freeze|unfreeze|undo|purge-now --yes|delete-vault --yes --data-dir ~/centraid-gateway
//! centraid-gateway scrub    --data-dir ~/centraid-gateway
//! centraid-gateway health   --data-dir ~/centraid-gateway [--addr 127.0.0.1:8443] [--pin <hex>]
//! centraid-gateway install  --data-dir ~/centraid-gateway [--bind 0.0.0.0:8443] [--name NAME] [--announce HOST:PORT]... [--dry-run]
//! ```
//!
//! **It runs with no vault.** `serve` on an empty directory mints the
//! gateway's identity, listens, and prints the first pairing QR; nothing is
//! stored until a phone pairs. `pair`, `pairings` and `scrub` open the same
//! directory beside a running `serve`. Gateway-to-gateway mirroring is a
//! later wave.

use std::net::{Ipv4Addr, Ipv6Addr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::Context as _;
use centraid_gateway::client::Client;
use centraid_gateway::rules::ids::Pin;
use centraid_gateway::server::bonjour::{self, Announcement};
use centraid_gateway::server::operator::{self, Verb};
use centraid_gateway::server::serve::TlsListener;
use centraid_gateway::server::service::{DEFAULT_LABEL, Platform, UnitSpec};
use centraid_gateway::server::sweeps::{Schedule, scrub_once};
use centraid_gateway::server::tls::Identity;
use centraid_gateway::server::{
    DEFAULT_PORT, OpenError, Shared, addrs, last_bound, last_served, record_served, report, serve,
    service, sweeps, system_clock,
};
use clap::{Parser, Subcommand};

#[derive(Parser, Debug)]
#[command(
    name = "centraid-gateway",
    version,
    about = "A Centraid gateway: a blind store a phone backs its vaults up to, directly"
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand, Debug)]
enum Command {
    /// Listen, serve the protocol, and run the sweeps.
    Serve {
        #[arg(long, env = "CENTRAID_GATEWAY_DATA_DIR")]
        data_dir: PathBuf,
        /// Where to listen.
        #[arg(long, env = "CENTRAID_GATEWAY_BIND", default_value = "0.0.0.0:8443")]
        bind: String,
        /// Human-readable name for this gateway; defaults to this host's clean name.
        #[arg(long, env = "CENTRAID_GATEWAY_NAME")]
        name: Option<String>,
        /// Additional `host:port` or `ip:port` addresses to advertise (repeatable or comma-separated).
        #[arg(long, env = "CENTRAID_GATEWAY_ANNOUNCE", value_delimiter = ',')]
        announce: Vec<String>,
        /// Do not advertise `_centraid-gateway._tcp` on the LAN.
        #[arg(long)]
        no_mdns: bool,
    },
    /// Print a pairing QR: good for one phone, once, for a day.
    Pair {
        #[arg(long, env = "CENTRAID_GATEWAY_DATA_DIR")]
        data_dir: PathBuf,
        /// The port phones dial, when `serve` has not run here to say.
        #[arg(long)]
        port: Option<u16>,
        /// Override the gateway name carried in the pairing QR.
        #[arg(long, env = "CENTRAID_GATEWAY_NAME")]
        name: Option<String>,
        /// Additional `host:port` or `ip:port` addresses to advertise (overrides persisted ones when set).
        #[arg(long, env = "CENTRAID_GATEWAY_ANNOUNCE", value_delimiter = ',')]
        announce: Vec<String>,
    },
    /// List the paired vaults, their safety numbers and their tokens; or
    /// revoke one token by the id the list prints.
    Pairings {
        #[arg(long, env = "CENTRAID_GATEWAY_DATA_DIR")]
        data_dir: PathBuf,
        #[command(subcommand)]
        action: Option<PairingsAction>,
    },
    /// The member's last word over one vault: freeze, unfreeze, undo, purge
    /// held deletes now, or delete a frozen vault. Local and unsigned, through
    /// the same rules a phone's request goes through.
    Vault {
        /// The first 8 hex characters of the vault's id, as `pairings` lists it.
        id: String,
        #[command(subcommand)]
        verb: VaultVerb,
        /// Global so it may follow the verb, as the other commands' do.
        #[arg(long, env = "CENTRAID_GATEWAY_DATA_DIR", global = true)]
        data_dir: Option<PathBuf>,
    },
    /// Re-hash every stored object now. No key is involved.
    Scrub {
        #[arg(long, env = "CENTRAID_GATEWAY_DATA_DIR")]
        data_dir: PathBuf,
    },
    /// Ask a running gateway whether it is up, trusting its own certificate.
    Health {
        /// Trust the certificate in this data directory, and dial where its
        /// `serve` last listened.
        #[arg(long, env = "CENTRAID_GATEWAY_DATA_DIR")]
        data_dir: Option<PathBuf>,
        /// Dial here instead.
        #[arg(long)]
        addr: Option<String>,
        /// Trust the certificate with this pin instead.
        #[arg(long)]
        pin: Option<Pin>,
    },
    /// Write a systemd user unit or a launchd agent, and never enable it.
    Install {
        #[arg(long, env = "CENTRAID_GATEWAY_DATA_DIR")]
        data_dir: PathBuf,
        #[arg(long, default_value = "0.0.0.0:8443")]
        bind: String,
        /// Configure `--name` in the installed service unit.
        #[arg(long, env = "CENTRAID_GATEWAY_NAME")]
        name: Option<String>,
        /// Configure `--announce` in the installed service unit (repeatable or comma-separated).
        #[arg(long, env = "CENTRAID_GATEWAY_ANNOUNCE", value_delimiter = ',')]
        announce: Vec<String>,
        /// Print the unit and its path, and touch nothing.
        #[arg(long)]
        dry_run: bool,
        #[arg(long, default_value = DEFAULT_LABEL)]
        label: String,
    },
}

#[derive(Subcommand, Debug)]
enum VaultVerb {
    /// Refuse every write to the vault and stop purging it, until `unfreeze`.
    /// Reads, nonces and read grants still answer.
    Freeze,
    /// Lift the freeze; every held delete gains the time it was frozen.
    Unfreeze,
    /// Lift every held delete of the vault, no signature. Works while frozen.
    Undo,
    /// Make every held delete of the vault final now. Needs an unfrozen vault.
    PurgeNow {
        /// Yes, make them final.
        #[arg(long)]
        yes: bool,
    },
    /// Remove a frozen vault and every object of it for good.
    DeleteVault {
        /// Yes, remove it.
        #[arg(long)]
        yes: bool,
    },
}

#[derive(Subcommand, Debug)]
enum PairingsAction {
    /// Revoke one token, for a phone that is lost and cannot revoke itself:
    /// every route answers it `UNAUTHORIZED` from now on.
    Revoke {
        /// The token's id, as `pairings` lists it (at least 8 hex characters).
        id: String,
    },
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    match Cli::parse().command {
        Command::Serve {
            data_dir,
            bind,
            name,
            announce,
            no_mdns,
        } => run(&data_dir, &bind, name.as_deref(), &announce, no_mdns).await,
        Command::Pair {
            data_dir,
            port,
            name,
            announce,
        } => pair(&data_dir, port, name.as_deref(), &announce),
        Command::Pairings {
            data_dir,
            action: None,
        } => pairings(&data_dir),
        Command::Pairings {
            data_dir,
            action: Some(PairingsAction::Revoke { id }),
        } => revoke(&data_dir, &id),
        Command::Vault { id, verb, data_dir } => vault(
            &data_dir.context("give --data-dir, or set CENTRAID_GATEWAY_DATA_DIR")?,
            &id,
            &verb,
        ),
        Command::Scrub { data_dir } => scrub(&data_dir),
        Command::Health {
            data_dir,
            addr,
            pin,
        } => health(data_dir.as_deref(), addr, pin).await,
        Command::Install {
            data_dir,
            bind,
            name,
            announce,
            dry_run,
            label,
        } => install(&data_dir, &bind, name.as_deref(), &announce, dry_run, label),
    }
}

/// Validate and normalize `--announce` entries against `default_port`.
fn parse_announced(raw: &[String], default_port: u16) -> anyhow::Result<Vec<String>> {
    let mut normalized = Vec::new();
    for entry in raw {
        let trimmed = entry.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Some(addr) = addrs::normalize_announce(trimmed, default_port) else {
            anyhow::bail!("invalid --announce address {trimmed:?}; expected host:port or ip:port");
        };
        if !normalized.contains(&addr) {
            normalized.push(addr);
        }
    }
    Ok(normalized)
}

/// Open the gateway in `data_dir`. A data folder an earlier gateway made, or
/// a newer one, is not an error to debug: its sentence is printed and the
/// process exits with code 2, the file as it was (#1191, E13).
fn open(data_dir: &Path) -> anyhow::Result<Shared> {
    match Shared::open(data_dir, system_clock()) {
        Err(OpenError::Refused(sentence)) => {
            eprintln!("{sentence}");
            std::process::exit(EXIT_REFUSED);
        }
        other => other.with_context(|| format!("opening the gateway in {}", data_dir.display())),
    }
}

/// The exit code of a data folder this gateway will not open.
const EXIT_REFUSED: i32 = 2;

/// `serve`.
async fn run(
    data_dir: &Path,
    bind: &str,
    name: Option<&str>,
    announce: &[String],
    no_mdns: bool,
) -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();
    let opened = open(data_dir)?;
    let pin = opened.identity().pin();
    let gateway_id = opened.identity().gateway_id();
    let resolved_name = addrs::clean_gateway_name(name);
    opened.set_label(resolved_name.clone());
    // THE TERMINAL HEARS EACH PAIRING AS IT LANDS, with the safety number a
    // member may compare against the phone's.
    let shared = Arc::new(opened.with_announcer(Arc::new(move |event| {
        for line in report::event_lines(event, &pin) {
            println!("{line}");
        }
    })));
    let cleared = shared.store().clear_staged()?;
    if cleared > 0 {
        tracing::info!(cleared, "removed uploads a stop left staged");
    }
    let listener = serve::bind(bind).await?;
    let bound = listener.local_addr()?;
    let normalized_announce = parse_announced(announce, bound.port())?;
    let config = shared.identity().server_config()?;
    let listener = TlsListener::new(listener, config)?;
    record_served(data_dir, bound, Some(&resolved_name), &normalized_announce)?;

    println!("gateway   {gateway_id}");
    println!("name      {resolved_name}");
    println!("pin       {pin}");
    println!("listening {bound}");
    let pairings = shared.rules(|gateway| gateway.pairings())?;
    for pairing in &pairings {
        println!(
            "vault     {}  writer epoch {}",
            report::short(&pairing.vault.vault),
            pairing.vault.writer_epoch
        );
        println!("{}", report::safety_line(&pairing.vault.vault, &pin));
    }
    let now = shared.now();
    let waiting =
        shared.rules(|gateway| Ok(gateway.secrets()?.iter().any(|secret| secret.is_live(now))))?;
    if pairings.is_empty() && !waiting {
        // An empty gateway's first need is the thing to scan.
        let payload = shared.payload(addrs::advertised_with(bound, &normalized_announce))?;
        for line in report::payload_lines(&payload) {
            println!("{line}");
        }
    } else if pairings.is_empty() {
        println!("A pairing QR is waiting to be scanned. `centraid-gateway pair` prints another.");
    }

    let advertisement = if no_mdns {
        None
    } else {
        advertise(gateway_id, bound, &resolved_name).await
    };
    tokio::spawn(sweeps::run(Arc::clone(&shared), Schedule::default()));
    serve::run(listener, shared, shutdown()).await?;
    drop(advertisement);
    Ok(())
}

/// Advertise on the LAN, or say why not: through the system's `dns-sd` on a
/// Mac, so the Bonjour Sleep Proxy can wake it for the phone's browse
/// (Q-1080-1), from this process everywhere else.
async fn advertise(
    gateway_id: centraid_gateway::rules::ids::GatewayId,
    bound: SocketAddr,
    resolved_name: &str,
) -> Option<Announcement> {
    let Some(host) = addrs::host_name().or_else(|| addrs::bonjour_host_label(resolved_name)) else {
        tracing::warn!("this host's name is not one Bonjour can carry; not advertising");
        return None;
    };
    bonjour::announce_with_label(gateway_id, &host, bound.port(), Some(resolved_name)).await
}

/// Ctrl-C, or the SIGTERM a service manager or `docker stop` sends.
async fn shutdown() {
    #[cfg(unix)]
    {
        let terminate = async {
            if let Ok(mut signal) =
                tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            {
                signal.recv().await;
            } else {
                std::future::pending::<()>().await;
            }
        };
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            () = terminate => {}
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}

/// `pair`.
fn pair(
    data_dir: &Path,
    port: Option<u16>,
    name: Option<&str>,
    announce: &[String],
) -> anyhow::Result<()> {
    let shared = open(data_dir)?;
    let persisted = last_served(data_dir);
    let mut bound = persisted
        .as_ref()
        .and_then(|record| record.bind.parse().ok())
        .unwrap_or_else(|| SocketAddr::from((Ipv4Addr::UNSPECIFIED, DEFAULT_PORT)));
    if let Some(port) = port {
        bound.set_port(port);
    }
    let effective_name = match name {
        Some(explicit) => addrs::clean_gateway_name(Some(explicit)),
        None => {
            addrs::clean_gateway_name(persisted.as_ref().and_then(|record| record.name.as_deref()))
        }
    };
    shared.set_label(effective_name);
    let effective_announce = if !announce.is_empty() {
        parse_announced(announce, bound.port())?
    } else {
        persisted.map(|record| record.announce).unwrap_or_default()
    };
    let payload = shared.payload(addrs::advertised_with(bound, &effective_announce))?;
    for line in report::payload_lines(&payload) {
        println!("{line}");
    }
    Ok(())
}

/// `pairings`.
fn pairings(data_dir: &Path) -> anyhow::Result<()> {
    let shared = open(data_dir)?;
    let pin = shared.identity().pin();
    println!("gateway   {}", shared.identity().gateway_id());
    println!("name      {}", shared.label());
    println!("pin       {pin}");
    let pairings = shared.rules(|gateway| gateway.pairings())?;
    if pairings.is_empty() {
        println!("No phone has paired here yet. `centraid-gateway pair` prints a QR.");
    }
    for pairing in &pairings {
        for line in report::pairing_lines(pairing, &pin) {
            println!("{line}");
        }
    }
    let now = shared.now();
    let secrets = shared.rules(|gateway| gateway.secrets())?;
    let waiting = secrets.iter().filter(|secret| secret.is_live(now)).count();
    let spent = secrets
        .iter()
        .filter(|secret| secret.used_at_ms.is_some())
        .count();
    let expired = secrets.len() - waiting - spent;
    println!("secrets   {waiting} waiting, {spent} spent, {expired} expired");
    Ok(())
}

/// `pairings revoke <id>`.
fn revoke(data_dir: &Path, id: &str) -> anyhow::Result<()> {
    let id = id.trim().to_ascii_lowercase();
    anyhow::ensure!(
        id.len() >= 8 && id.chars().all(|c| c.is_ascii_hexdigit()),
        "a token id is at least 8 hex characters, as `pairings` lists it"
    );
    let shared = open(data_dir)?;
    let pairings = shared.rules(|gateway| gateway.pairings())?;
    let matches: Vec<_> = pairings
        .iter()
        .flat_map(|pairing| {
            pairing
                .tokens
                .iter()
                .map(move |token| (pairing.vault.vault, token))
        })
        .filter(|(_, token)| token.hash.hex().starts_with(&id))
        .collect();
    let [(vault, token)] = matches.as_slice() else {
        anyhow::bail!(
            "{} tokens start with {id}; `pairings` lists each token's id",
            matches.len()
        );
    };
    let hash = token.hash;
    let removed = shared.rules(|gateway| gateway.revoke_hash(&hash))?;
    anyhow::ensure!(removed, "token {id} was revoked while this ran");
    println!(
        "revoked   token {}  epoch {}  {:?}  of vault {}",
        report::token_id(&hash),
        token.epoch,
        token.label,
        report::short(vault)
    );
    println!("The phone holding it is refused on every route from now on.");
    Ok(())
}

/// `vault <id8> <verb>`.
fn vault(data_dir: &Path, id: &str, verb: &VaultVerb) -> anyhow::Result<()> {
    let shared = open(data_dir)?;
    let (verb, yes) = match verb {
        VaultVerb::Freeze => (Verb::Freeze, false),
        VaultVerb::Unfreeze => (Verb::Unfreeze, false),
        VaultVerb::Undo => (Verb::Undo, false),
        VaultVerb::PurgeNow { yes } => (Verb::PurgeNow, *yes),
        VaultVerb::DeleteVault { yes } => (Verb::DeleteVault, *yes),
    };
    let outcome =
        operator::resolve(&shared, id).and_then(|vault| operator::run(&shared, &vault, verb, yes));
    match outcome {
        Ok(lines) => {
            for line in lines {
                println!("{line}");
            }
            Ok(())
        }
        Err(refused) => {
            eprintln!("{refused}");
            std::process::exit(EXIT_REFUSED_VERB);
        }
    }
}

/// The exit code of an operator verb the vault's state or a missing `--yes`
/// forbids.
const EXIT_REFUSED_VERB: i32 = 3;

/// `scrub`.
fn scrub(data_dir: &Path) -> anyhow::Result<()> {
    let shared = open(data_dir)?;
    let counts = scrub_once(&shared)?;
    println!(
        "scrub     {} read, {} corrupt, {} missing",
        counts.read, counts.corrupt, counts.missing
    );
    if counts.corrupt + counts.missing > 0 {
        println!("Damaged objects now read as missing, so their phones send them again.");
    }
    Ok(())
}

/// `health`.
async fn health(
    data_dir: Option<&Path>,
    addr: Option<String>,
    pin: Option<Pin>,
) -> anyhow::Result<()> {
    let addr = addr
        .or_else(|| {
            data_dir
                .and_then(last_bound)
                .map(|bound| dialable(bound).to_string())
        })
        .unwrap_or_else(|| SocketAddr::from((Ipv4Addr::LOCALHOST, DEFAULT_PORT)).to_string());
    let client = match (pin, data_dir) {
        (Some(pin), _) => Client::first_contact(vec![addr], pin),
        (None, Some(data_dir)) => Client::trusting(
            vec![addr],
            Identity::read_certificate(data_dir).context("reading this gateway's certificate")?,
        ),
        (None, None) => anyhow::bail!(
            "give --data-dir to trust this gateway's own certificate, or --pin to trust another's"
        ),
    };
    let info = client.info().await.context("asking the gateway")?;
    println!("{}", serde_json::to_string(&info)?);
    Ok(())
}

/// Where to dial a gateway that bound `bound`: its own loopback when it
/// bound every interface.
fn dialable(bound: SocketAddr) -> SocketAddr {
    match bound {
        SocketAddr::V4(v4) if v4.ip().is_unspecified() => {
            SocketAddr::from((Ipv4Addr::LOCALHOST, v4.port()))
        }
        SocketAddr::V6(v6) if v6.ip().is_unspecified() => {
            SocketAddr::from((Ipv6Addr::LOCALHOST, v6.port()))
        }
        other => other,
    }
}

/// Create `dir`, readable only by its owner, if it is missing. One that
/// exists is the member's, and is left as it is.
fn private_dir(dir: &Path) -> anyhow::Result<()> {
    if dir.is_dir() {
        return Ok(());
    }
    std::fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
            .with_context(|| format!("restricting {}", dir.display()))?;
    }
    Ok(())
}

/// `install`.
fn install(
    data_dir: &Path,
    bind: &str,
    name: Option<&str>,
    announce: &[String],
    dry_run: bool,
    label: String,
) -> anyhow::Result<()> {
    let platform = Platform::host().context(
        "neither systemd nor launchd is available here; run the container image instead",
    )?;
    let default_port = bind
        .parse::<SocketAddr>()
        .map_or(DEFAULT_PORT, |addr| addr.port());
    let normalized_announce = parse_announced(announce, default_port)?;
    let data_dir = std::path::absolute(data_dir).context("resolving the data directory")?;
    let mut arguments = vec![
        "serve".to_owned(),
        "--data-dir".to_owned(),
        data_dir.display().to_string(),
        "--bind".to_owned(),
        bind.to_owned(),
    ];
    if let Some(name) = name {
        let cleaned = addrs::clean_gateway_name(Some(name));
        arguments.push("--name".to_owned());
        arguments.push(cleaned);
    }
    for addr in normalized_announce {
        arguments.push("--announce".to_owned());
        arguments.push(addr);
    }
    let spec = UnitSpec {
        label,
        program: std::env::current_exe().context("resolving this binary")?,
        arguments,
        log_dir: data_dir.join("logs"),
        data_dir,
    };
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .context("HOME is not set, and a user unit goes under it")?;
    if dry_run {
        let (path, text) = service::render(platform, &spec, &home);
        println!("# {}", path.display());
        print!("{text}");
        return Ok(());
    }
    private_dir(&spec.data_dir)?;
    if platform == Platform::Launchd {
        private_dir(&spec.log_dir)?;
    }
    let path = service::install(platform, &spec, &home)?;
    println!("{}", path.display());
    match platform {
        Platform::Systemd => println!(
            "Written, not enabled. To run it: systemctl --user enable --now {}",
            spec.label
        ),
        Platform::Launchd => println!(
            "Written, not loaded. To run it: launchctl load {}",
            path.display()
        ),
    }
    Ok(())
}

#[cfg(test)]
mod cli_tests {
    use super::{Cli, Command, PairingsAction};
    use clap::{CommandFactory, Parser};

    #[test]
    fn the_cli_definition_is_consistent() {
        Cli::command().debug_assert();
    }

    #[test]
    fn revoke_accepts_the_documented_data_directory_before_the_action() {
        let cli = Cli::try_parse_from([
            "centraid-gateway",
            "pairings",
            "--data-dir",
            "test-gateway",
            "revoke",
            "abcdef12",
        ])
        .expect("the documented revoke invocation parses");
        let Command::Pairings {
            data_dir,
            action: Some(PairingsAction::Revoke { id }),
        } = cli.command
        else {
            panic!("the revoke action is selected");
        };
        assert_eq!(data_dir, std::path::PathBuf::from("test-gateway"));
        assert_eq!(id, "abcdef12");
    }

    #[test]
    fn serve_and_pair_accept_name_and_repeatable_or_comma_separated_announce() {
        let cli = Cli::try_parse_from([
            "centraid-gateway",
            "serve",
            "--data-dir",
            "gw",
            "--name",
            "Home NAS",
            "--announce",
            "100.101.102.103:8443",
            "--announce",
            "nas.tailnet.ts.net:8443,203.0.113.1:8443",
        ])
        .expect("serve parses");
        let Command::Serve { name, announce, .. } = cli.command else {
            panic!("serve selected");
        };
        assert_eq!(name.as_deref(), Some("Home NAS"));
        assert_eq!(
            announce,
            vec![
                "100.101.102.103:8443",
                "nas.tailnet.ts.net:8443",
                "203.0.113.1:8443"
            ]
        );

        let pair_cli = Cli::try_parse_from([
            "centraid-gateway",
            "pair",
            "--data-dir",
            "gw",
            "--name",
            "Studio Mac",
            "--announce",
            "studio.ts.net:9443",
        ])
        .expect("pair parses");
        let Command::Pair { name, announce, .. } = pair_cli.command else {
            panic!("pair selected");
        };
        assert_eq!(name.as_deref(), Some("Studio Mac"));
        assert_eq!(announce, vec!["studio.ts.net:9443"]);
    }
}
