#![forbid(unsafe_code)]
//! `centraid-gateway2` — the gateway a member runs (#1080).
//!
//! ```text
//! centraid-gateway2 serve    --data-dir ~/centraid-gateway [--bind 0.0.0.0:8443] [--no-mdns]
//! centraid-gateway2 pair     --data-dir ~/centraid-gateway [--port 8443]
//! centraid-gateway2 pairings --data-dir ~/centraid-gateway
//! centraid-gateway2 scrub    --data-dir ~/centraid-gateway
//! centraid-gateway2 health   --data-dir ~/centraid-gateway [--addr 127.0.0.1:8443] [--pin <hex>]
//! centraid-gateway2 install  --data-dir ~/centraid-gateway [--bind 0.0.0.0:8443] [--dry-run]
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
use centraid_gateway2::client::Client;
use centraid_gateway2::rules::ids::Pin;
use centraid_gateway2::server::serve::{Advertisement, TlsListener};
use centraid_gateway2::server::service::{DEFAULT_LABEL, Platform, UnitSpec};
use centraid_gateway2::server::sweeps::{Schedule, scrub_once};
use centraid_gateway2::server::tls::Identity;
use centraid_gateway2::server::{
    DEFAULT_PORT, Shared, addrs, last_bound, record_bound, report, serve, service, sweeps,
    system_clock,
};
use clap::{Parser, Subcommand};

#[derive(Parser, Debug)]
#[command(
    name = "centraid-gateway2",
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
    },
    /// List the paired vaults, their safety numbers and their tokens.
    Pairings {
        #[arg(long, env = "CENTRAID_GATEWAY_DATA_DIR")]
        data_dir: PathBuf,
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
        /// Print the unit and its path, and touch nothing.
        #[arg(long)]
        dry_run: bool,
        #[arg(long, default_value = DEFAULT_LABEL)]
        label: String,
    },
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    match Cli::parse().command {
        Command::Serve {
            data_dir,
            bind,
            no_mdns,
        } => run(&data_dir, &bind, no_mdns).await,
        Command::Pair { data_dir, port } => pair(&data_dir, port),
        Command::Pairings { data_dir } => pairings(&data_dir),
        Command::Scrub { data_dir } => scrub(&data_dir),
        Command::Health {
            data_dir,
            addr,
            pin,
        } => health(data_dir.as_deref(), addr, pin).await,
        Command::Install {
            data_dir,
            bind,
            dry_run,
            label,
        } => install(&data_dir, &bind, dry_run, label),
    }
}

fn open(data_dir: &Path) -> anyhow::Result<Shared> {
    Shared::open(data_dir, system_clock())
        .with_context(|| format!("opening the gateway in {}", data_dir.display()))
}

/// `serve`.
async fn run(data_dir: &Path, bind: &str, no_mdns: bool) -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();
    let opened = open(data_dir)?;
    let pin = opened.identity().pin();
    let gateway_id = opened.identity().gateway_id();
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
    let config = shared.identity().server_config()?;
    let listener = TlsListener::new(listener, config)?;
    record_bound(data_dir, bound)?;

    println!("gateway   {gateway_id}");
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
        let payload = shared.payload(addrs::advertised(bound))?;
        for line in report::payload_lines(&payload) {
            println!("{line}");
        }
    } else if pairings.is_empty() {
        println!("A pairing QR is waiting to be scanned. `centraid-gateway2 pair` prints another.");
    }

    let advertisement = if no_mdns {
        None
    } else {
        advertise(gateway_id, bound)
    };
    tokio::spawn(sweeps::run(Arc::clone(&shared), Schedule::default()));
    serve::run(listener, shared, shutdown()).await?;
    drop(advertisement);
    Ok(())
}

/// Advertise on the LAN, or say why not. A gateway that cannot advertise
/// still serves: a phone's pairing record keeps the addresses it last knew.
fn advertise(
    gateway_id: centraid_gateway2::rules::ids::GatewayId,
    bound: SocketAddr,
) -> Option<Advertisement> {
    let Some(host) = addrs::host_name() else {
        tracing::warn!("this host's name is not one Bonjour can carry; not advertising");
        return None;
    };
    match Advertisement::start(gateway_id, &host, bound.port()) {
        Ok(advertisement) => {
            tracing::info!(host = %host, "advertising _centraid-gateway._tcp");
            Some(advertisement)
        }
        Err(error) => {
            tracing::warn!(%error, "not advertising on the LAN");
            None
        }
    }
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
fn pair(data_dir: &Path, port: Option<u16>) -> anyhow::Result<()> {
    let shared = open(data_dir)?;
    let mut bound = last_bound(data_dir)
        .unwrap_or_else(|| SocketAddr::from((Ipv4Addr::UNSPECIFIED, DEFAULT_PORT)));
    if let Some(port) = port {
        bound.set_port(port);
    }
    let payload = shared.payload(addrs::advertised(bound))?;
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
    println!("pin       {pin}");
    let pairings = shared.rules(|gateway| gateway.pairings())?;
    if pairings.is_empty() {
        println!("No phone has paired here yet. `centraid-gateway2 pair` prints a QR.");
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

/// `install`.
fn install(data_dir: &Path, bind: &str, dry_run: bool, label: String) -> anyhow::Result<()> {
    let platform = Platform::host().context(
        "neither systemd nor launchd is available here; run the container image instead",
    )?;
    let data_dir = std::path::absolute(data_dir).context("resolving the data directory")?;
    let spec = UnitSpec {
        label,
        program: std::env::current_exe().context("resolving this binary")?,
        arguments: vec![
            "serve".to_owned(),
            "--data-dir".to_owned(),
            data_dir.display().to_string(),
            "--bind".to_owned(),
            bind.to_owned(),
        ],
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
