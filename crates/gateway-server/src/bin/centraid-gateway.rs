#![forbid(unsafe_code)]
//! `centraid-gateway` — one binary a household runs (#1029 §3).
//!
//! Six verbs, and the first of them is the whole product:
//!
//! ```text
//! centraid-gateway serve   --data-dir ~/vault --origin https://vault.example.org
//! centraid-gateway invite  --data-dir ~/vault --quota-gib 64
//! centraid-gateway invites --data-dir ~/vault
//! centraid-gateway scrub   --data-dir ~/vault
//! centraid-gateway health  --url http://127.0.0.1:8443
//! centraid-gateway install --data-dir ~/vault [--dry-run]
//! ```
//!
//! **It runs with no vault and no keys.** `serve` on an empty directory creates
//! a state file, listens, and serves nothing to nobody until an invite is
//! redeemed — which is the exit condition for this lane and is what
//! `tests/first_run.rs` asserts.

use std::path::{Path, PathBuf};

use anyhow::Context as _;
use centraid_gateway_core::Gateway;
use centraid_gateway_core::store::StoreFault;
use centraid_gateway_server::bytes::configured::{Backend, ConfiguredBytes};
use centraid_gateway_server::bytes::fs::FilesystemBytes;
use centraid_gateway_server::config::{Config, ListenerConfig, StoreConfig, TlsConfig};
use centraid_gateway_server::http::Server;
use centraid_gateway_server::service::{DEFAULT_LABEL, Platform, UnitSpec};
use centraid_gateway_server::{clock, serve, service, state, sweeps, tenancy};
use centraid_identity::ticket;
use clap::{Parser, Subcommand};
use jiff::Timestamp;
use jiff::tz::TimeZone;

#[derive(Parser, Debug)]
#[command(
    name = "centraid-gateway",
    version,
    about = "A Centraid gateway anyone can run"
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand, Debug)]
enum Command {
    /// Listen, and serve the protocol.
    Serve {
        #[arg(long, env = "CENTRAID_GATEWAY_DATA_DIR")]
        data_dir: PathBuf,
        /// The origin a phone reaches this server on. Proxied upload targets
        /// are built from it, so it is the one thing a self-hoster behind a
        /// tunnel must get right.
        ///
        /// Readable from the environment because the container image has no
        /// other way to be told: a `CMD` cannot know the household's hostname.
        ///
        /// **Optional under the iroh carrier**, which is the default: there is
        /// no origin, because there is no URL — a phone dials an endpoint id
        /// (scope amendment 2026-09-21).
        #[arg(long, env = "CENTRAID_GATEWAY_ORIGIN", default_value = "")]
        origin: String,
        #[arg(long)]
        bind: Option<String>,
        /// A JSON config file. Everything above is ignored when it is given.
        #[arg(long)]
        config: Option<PathBuf>,
    },
    /// Mint an invite for one household member.
    Invite {
        #[arg(long)]
        data_dir: PathBuf,
        #[arg(long, default_value_t = 64)]
        quota_gib: u64,
    },
    /// List the invites and what became of them.
    Invites {
        #[arg(long)]
        data_dir: PathBuf,
    },
    /// Re-hash every stored object and report bit rot. No key is involved.
    Scrub {
        #[arg(long)]
        data_dir: PathBuf,
        #[arg(long)]
        origin: Option<String>,
        /// Repair what the mirror still holds intact.
        #[arg(long)]
        repair: bool,
    },
    /// Ask a running gateway whether it is up, and print what it answered.
    ///
    /// The container image's health check, and the command an operator runs by
    /// hand — one definition of "up", so there is no second one to drift from
    /// it. It answers on an empty server, before anybody has redeemed an
    /// invite, because a phone negotiates a version before it has an account.
    Health {
        #[arg(long, default_value = "http://127.0.0.1:8443")]
        url: String,
    },
    /// Write a systemd unit or a launchd agent.
    Install {
        #[arg(long)]
        data_dir: PathBuf,
        #[arg(long)]
        origin: String,
        /// Print the unit and its path, and touch nothing.
        #[arg(long)]
        dry_run: bool,
        #[arg(long, default_value = DEFAULT_LABEL)]
        label: String,
    },
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    match Cli::parse().command {
        Command::Serve {
            data_dir,
            origin,
            bind,
            config,
        } => {
            let mut config = match config {
                Some(path) => Config::read(&path)?,
                None => Config::defaults(&data_dir, &origin),
            };
            if let Some(bind) = bind {
                config.bind = bind;
            }
            run(config).await
        }
        Command::Invite {
            data_dir,
            quota_gib,
        } => {
            let store = open_state(&data_dir)?;
            let invite = tenancy::mint(
                &store,
                quota_gib.saturating_mul(centraid_gateway_server::config::GIB),
                clock::now(),
            )
            .map_err(store_error)?;
            // THE ONLY TIME THIS VALUE EXISTS OUTSIDE THE MEMBER'S HANDS. The
            // server keeps its BLAKE3 and cannot print it again.
            println!("{}", invite.code);
            println!(
                "quota {} GiB, good until {}",
                quota_gib,
                invite.expires_at.millis()
            );
            // And the same thing as something to scan. The endpoint id comes
            // from the key file rather than from a bound endpoint: minting an
            // invite must work while `serve` is running, and two processes
            // cannot bind one UDP socket. THE DIALLING HINTS ARE THE SERVING
            // ENDPOINT'S, as `serve` last published them (#1047 T1): a ticket
            // with none is dialable only through n0's address lookup, which a
            // local-only laptop does not use.
            let secret = serve::node_secret(&data_dir)?;
            let hints = serve::DialHints::read(&data_dir).unwrap_or_default();
            let ticket = ticket::mint(
                *secret.public().as_bytes(),
                &invite.code,
                u64::try_from(invite.expires_at.millis()).unwrap_or(0),
                hints.relay_url.clone(),
                hints.direct_addrs.clone(),
            );
            let encoded = ticket::encode(&ticket);
            println!("pair      {encoded}");
            if let Ok(rendered) = ticket::qr(&encoded) {
                println!("{rendered}");
            }
            if hints.direct_addrs.is_empty() {
                println!("{NO_HINTS}");
            }
            // WHAT TO COMPARE (W15-D5): not this laptop's id — the phone's key
            // is not known until the invite is redeemed, so the safety number
            // is `serve`'s to print, the moment the phone admits itself.
            println!("{COMPARE_HINT}");
            Ok(())
        }
        Command::Invites { data_dir } => {
            let store = open_state(&data_dir)?;
            // THE LAPTOP'S KEY, IF IT HAS ONE: listing invites never mints an
            // identity, so a directory `serve` never ran in prints no number.
            let endpoint = if serve::node_key_path(&data_dir).exists() {
                Some(*serve::node_secret(&data_dir)?.public().as_bytes())
            } else {
                None
            };
            for record in tenancy::list(&store).map_err(store_error)? {
                println!(
                    "{}  {} GiB  {}",
                    hex::encode(&record.code_hash[..8]),
                    record.quota_bytes / centraid_gateway_server::config::GIB,
                    record.redeemed_at.map_or_else(
                        || "unredeemed".to_owned(),
                        |at| format!("redeemed {}", local_time(at.millis(), &TimeZone::system()))
                    )
                );
                if let (Some(endpoint), Some(account)) = (&endpoint, &record.redeemed_by)
                    && let Some(number) = tenancy::safety_number(endpoint, account)
                {
                    println!("  safety  {number}");
                }
            }
            Ok(())
        }
        Command::Scrub {
            data_dir,
            origin,
            repair,
        } => {
            let config = Config::defaults(&data_dir, origin.as_deref().unwrap_or(""));
            let server = build(config)?;
            let vaults = server.gateway.state.vaults().map_err(store_error)?;
            for vault in vaults {
                let report = server
                    .gateway
                    .scrub(&vault)
                    .await
                    .map_err(|fault| anyhow::anyhow!("{fault}"))?;
                println!(
                    "{}: {} read, {} corrupt, {} missing",
                    vault.hex(),
                    report.read,
                    report.corrupt.len(),
                    report.missing.len()
                );
                if repair {
                    for name in report.corrupt.iter().chain(&report.missing) {
                        let repaired = server
                            .gateway
                            .bytes
                            .repair(&vault, name)
                            .await
                            .map_err(store_error)?;
                        println!(
                            "  {} {}",
                            name.hex(),
                            if repaired { "repaired" } else { "unrepaired" }
                        );
                    }
                }
            }
            Ok(())
        }
        Command::Health { url } => {
            let body = reqwest::get(format!("{}/v1/health", url.trim_end_matches('/')))
                .await
                .context("reaching the gateway")?
                .error_for_status()
                .context("the gateway answered an error")?
                .text()
                .await
                .context("reading the health body")?;
            println!("{body}");
            Ok(())
        }
        Command::Install {
            data_dir,
            origin,
            dry_run,
            label,
        } => {
            let platform = Platform::host().context(
                "neither systemd nor launchd is available here; run the container image instead",
            )?;
            let spec = UnitSpec {
                label,
                program: std::env::current_exe().context("resolving this binary")?,
                arguments: vec![
                    "serve".to_owned(),
                    "--data-dir".to_owned(),
                    data_dir.display().to_string(),
                    "--origin".to_owned(),
                    origin,
                ],
                data_dir: data_dir.clone(),
                log_dir: data_dir.join("logs"),
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
            Ok(())
        }
    }
}

/// The pairing payload, as text and as a QR.
///
/// **A headless laptop has a terminal and nothing else**, so this IS the
/// pairing surface: the QR is half-block Unicode so a phone camera can read it
/// at a normal font size, and the same payload is printed as text for a member
/// who is pasting it over a chat rather than pointing a camera at a screen.
fn print_ticket(
    endpoint: &iroh::Endpoint,
    invite_code: &str,
    expires_at_ms: i64,
) -> anyhow::Result<()> {
    let hints = serve::DialHints::of(&endpoint.addr());
    let ticket = ticket::mint(
        *endpoint.id().as_bytes(),
        invite_code,
        u64::try_from(expires_at_ms).unwrap_or(0),
        hints.relay_url,
        hints.direct_addrs,
    );
    let encoded = ticket::encode(&ticket);
    println!("pair      {encoded}");
    match ticket::qr(&encoded) {
        Ok(rendered) => println!("{rendered}"),
        // A QR that will not render is not a reason to refuse to pair: the
        // text above is the same payload and can be pasted.
        Err(error) => println!("(no QR: {error}; paste the `pair` line instead)"),
    }
    Ok(())
}

/// What `invite` says when its ticket carries no address (#1047 T1).
const NO_HINTS: &str = "This code carries no address for this laptop: `serve` has not published \
     one here yet. A phone finds it by its id through n0's address lookup; on a local-only \
     laptop, start `serve` and run `invite` again.";

/// What `invite` says after the ticket: where the comparison happens.
const COMPARE_HINT: &str =
    "Once the phone pairs, `serve` prints a safety number. Check it matches the phone's.";

/// ONE PAIRED VAULT'S SAFETY NUMBER, AS THE TERMINAL PRINTS IT (W15-D5).
///
/// The digits the phone's paired screen shows when both hold each other's
/// real key, with the vault's first eight hex characters so a laptop holding
/// two vaults says which is which. The vault prefix is a label, never the
/// thing compared.
fn print_safety(endpoint: &[u8; 32], account: &centraid_gateway_core::ids::AccountId) {
    if let Some(number) = tenancy::safety_number(endpoint, account) {
        let vault = account.hex();
        println!("safety    {number}  (vault {}…)", &vault[..8]);
    }
}

fn store_error(fault: StoreFault) -> anyhow::Error {
    anyhow::anyhow!("{fault}")
}

fn open_state(data_dir: &Path) -> anyhow::Result<state::SqliteState> {
    std::fs::create_dir_all(data_dir).context("creating the data directory")?;
    let config = Config::defaults(data_dir, "");
    state::SqliteState::open(&config.state_path()).map_err(store_error)
}

/// Build one backend from its config.
fn backend(store: &StoreConfig, data_dir: &Path, origin: &str) -> anyhow::Result<Backend> {
    match store {
        StoreConfig::Filesystem { path } => {
            let root = if path.is_absolute() {
                path.clone()
            } else {
                data_dir.join(path)
            };
            Ok(Backend::Filesystem(
                FilesystemBytes::open(&root, origin).map_err(store_error)?,
            ))
        }
    }
}

/// Everything a `serve` needs, assembled.
fn build(config: Config) -> anyhow::Result<Server> {
    std::fs::create_dir_all(&config.data_dir).context("creating the data directory")?;
    let state = state::SqliteState::open(&config.state_path()).map_err(store_error)?;
    let primary = backend(&config.store, &config.data_dir, &config.origin)?;
    let bytes = match &config.mirror {
        Some(mirror) => {
            ConfiguredBytes::mirrored(primary, backend(mirror, &config.data_dir, &config.origin)?)
        }
        None => ConfiguredBytes::new(primary),
    };
    let retention = config.retention();
    Ok(Server {
        gateway: Gateway::new(state, bytes, retention),
        config,
    })
}

async fn run(config: Config) -> anyhow::Result<()> {
    let server = build(config.clone())?;
    match &config.listener {
        // THE DEFAULT (scope amendment 2026-09-21). A laptop has no domain and
        // no certificate, so the carrier is iroh and what a member needs on
        // screen is an endpoint id and something to scan.
        ListenerConfig::Iroh(iroh) => {
            let endpoint = serve::bind_iroh(&config.data_dir, iroh).await?;
            // WHERE `invite` FINDS THIS ENDPOINT'S ADDRESSES (#1047 T1).
            serve::publish_dial_hints(&endpoint, &config.data_dir)?;
            let store = state::SqliteState::open(&config.state_path()).map_err(store_error)?;
            let paired = print_pairing(&endpoint, &store, &config)?;
            tracing::info!(endpoint = %endpoint.id(), "the gateway is up");
            let shared = serve::shared(server);
            sweep(&shared, config.sweeps);
            announce(&shared, *endpoint.id().as_bytes(), paired);
            serve::serve_iroh(endpoint, shared).await
        }
        // The self-hoster who has a domain. `acme.rs` is not deleted.
        ListenerConfig::Tcp => {
            let bound = serve::bind(&config.bind).await?;
            tracing::info!(address = %bound.address, origin = %config.origin, "the gateway is up");
            let shared = serve::shared(server);
            sweep(&shared, config.sweeps);
            match config.tls {
                TlsConfig::Terminated => serve::serve_plain(bound, shared).await,
                TlsConfig::Acme { .. } => serve::serve_acme(bound, shared, &config).await,
            }
        }
    }
}

/// **THE SWEEPS, SPAWNED BESIDE THE LISTENER** (#1029 W15-4).
///
/// `purge` and `scrub` are `gateway-core`'s rules and had no caller but the
/// `scrub` CLI verb, so a tombstone past its grace period stayed on the disk
/// forever. They run on a timer now; `centraid_gateway_server::sweeps` has the
/// two cadences and why they differ.
///
/// It is spawned rather than awaited because it never returns: serving is what
/// this process is for, and the sweeps ride beside it. A sweep that faults logs
/// and the loop carries on — a laptop whose disk is failing must still answer a
/// phone that is trying to back up to it.
fn sweep(shared: &centraid_gateway_server::http::Shared, schedule: sweeps::Schedule) {
    let shared = shared.clone();
    tokio::spawn(async move { sweeps::run(shared, schedule).await });
}

/// WHAT A MEMBER SEES WHEN THE LAPTOP STARTS.
///
/// The endpoint id (the laptop's identity, for the recovery runbook's "is it
/// the same laptop" — never the thing a member compares), the safety number
/// of every vault already paired here, then one pairing payload per invite
/// that is still good, as text and as a QR. **A gateway with nothing on it
/// mints the first invite itself**: an empty state directory means nobody has
/// a vault here, and the one thing its owner needs next is the thing to scan.
/// It is not minted again — a second start with a live invite prints that
/// invite, and a gateway that has admitted a vault prints none.
///
/// Answers the accounts already paired, so [`announce`] prints only the new.
fn print_pairing(
    endpoint: &iroh::Endpoint,
    store: &state::SqliteState,
    config: &Config,
) -> anyhow::Result<Vec<centraid_gateway_core::ids::AccountId>> {
    println!("endpoint  {}", endpoint.id());
    let now = clock::now();
    let records = tenancy::list(store).map_err(store_error)?;
    let paired: Vec<_> = records
        .iter()
        .filter_map(|record| record.redeemed_by)
        .collect();
    for account in &paired {
        print_safety(endpoint.id().as_bytes(), account);
    }
    let mut live: Vec<_> = records
        .into_iter()
        .filter(|record| record.redeemed_at.is_none() && record.expires_at > now)
        .collect();
    if live.is_empty() && paired.is_empty() {
        let invite = tenancy::mint(store, config.default_quota.bytes, now).map_err(store_error)?;
        println!("invite    {}", invite.code);
        print_ticket(endpoint, &invite.code, invite.expires_at.millis())?;
        println!("{COMPARE_HINT}");
        return Ok(paired);
    }
    live.sort_by_key(|record| record.expires_at.millis());
    for record in live {
        println!(
            "invite    {}…  (the code itself was printed once, when it was minted)",
            hex::encode(&record.code_hash[..8])
        );
    }
    Ok(paired)
}

/// **A MOMENT AS THE OPERATOR READS IT**: the laptop's own time zone, to the
/// minute — `invites` printed raw epoch milliseconds (the #1047 walk). A value
/// no clock can hold is printed as it is rather than refused.
fn local_time(millis: i64, zone: &TimeZone) -> String {
    Timestamp::from_millisecond(millis).map_or_else(
        |_| format!("at {millis} ms"),
        |at| {
            at.to_zoned(zone.clone())
                .strftime("%Y-%m-%d %H:%M %Z")
                .to_string()
        },
    )
}

/// **THE SAFETY NUMBER, THE MOMENT A PHONE PAIRS** (W15-D5, #1047).
///
/// The laptop learns the phone's key only when an invite is redeemed, so the
/// number cannot be printed with the QR; it is printed here, as soon as the
/// admit lands, for the member to compare with the phone's paired screen. A
/// short poll of the invite table rather than a hook in the admit route: the
/// terminal is this binary's, and the library's handlers print nothing.
fn announce(
    shared: &centraid_gateway_server::http::Shared,
    endpoint: [u8; 32],
    already: Vec<centraid_gateway_core::ids::AccountId>,
) {
    let shared = shared.clone();
    tokio::spawn(async move {
        let mut seen: std::collections::HashSet<_> = already.into_iter().collect();
        let mut tick = tokio::time::interval(std::time::Duration::from_secs(1));
        loop {
            tick.tick().await;
            let records = {
                let server = shared.lock().await;
                tenancy::list(&server.gateway.state)
            };
            let Ok(records) = records else { continue };
            for account in records.iter().filter_map(|record| record.redeemed_by) {
                if seen.insert(account) {
                    println!("paired    a phone redeemed an invite");
                    print_safety(&endpoint, &account);
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_redeemed_invite_says_its_time_in_words_not_milliseconds() {
        let zone = TimeZone::get("Asia/Kolkata").expect("the bundled tzdb names it");
        assert_eq!(local_time(1_790_674_539_189, &zone), "2026-09-29 15:05 IST");
        assert_eq!(
            local_time(1_790_674_539_189, &TimeZone::UTC),
            "2026-09-29 09:35 UTC"
        );
        assert_eq!(
            local_time(i64::MAX, &TimeZone::UTC),
            format!("at {} ms", i64::MAX)
        );
    }
}
