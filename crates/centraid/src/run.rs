//! What each subcommand does.
//!
//! Only `gateway`, `pair --mint` and `seat pair` run for real in this lane; the
//! rest name the lane that owns them and exit 3. The split is deliberate: a
//! subcommand that pretends to work is worse than one that says it does not.

use std::path::{Path, PathBuf};

use centraid_net::endpoint::{Endpoint, EndpointConfig, RelayMode};
use centraid_net::{MemoryAllowlist, pairing, ticket};
use centraid_protocol::alpn;

use crate::exit;

/// One line on stderr, so stdout stays parseable. `RUST_LOG`-style filters
/// through `--log` / `CENTRAID_LOG`.
pub fn install_tracing(filter: Option<&str>) {
    let env =
        tracing_subscriber::EnvFilter::try_new(filter.unwrap_or("centraid=info,centraid_net=info"))
            .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info"));
    let _ = tracing_subscriber::fmt()
        .with_env_filter(env)
        .with_writer(std::io::stderr)
        .try_init();
}

/// The verb exists and its implementation lands in a later lane.
pub fn not_yet_available(verb: &str, owner: &str) -> u8 {
    eprintln!("centraid: `{verb}` is not available in this build — {owner} (#1020).");
    eprintln!(
        "centraid: exiting {} rather than pretending to work.",
        exit::NOT_YET_AVAILABLE
    );
    exit::NOT_YET_AVAILABLE
}

pub struct GatewayArgs {
    pub data_dir: Option<PathBuf>,
    pub print_qr: bool,
    pub vault_name: String,
    pub relay: Option<String>,
    pub no_relay: bool,
}

fn relay_mode(relay: Option<String>, no_relay: bool) -> RelayMode {
    match (relay, no_relay) {
        (_, true) => RelayMode::Disabled,
        (Some(url), false) => RelayMode::Custom(url),
        (None, false) => RelayMode::Default,
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|since| since.as_millis() as u64)
        .unwrap_or_default()
}

/// The line every wrapper waits for. A fixed prefix on stdout, because a test
/// and a systemd unit both need to know the endpoint is up, and "grep the log
/// for something that looks right" is not a contract.
pub const READY_LINE: &str = "centraid gateway ready";

/// Run the gateway until Ctrl-C.
///
/// **No TCP listener.** iroh is QUIC over UDP and nothing here binds a
/// `TcpListener`; `tests/no_listener.rs` spawns this very binary, waits for
/// [`READY_LINE`], and asserts through `/proc/net/tcp*` that the process owns
/// no LISTEN socket.
pub async fn gateway(args: GatewayArgs) -> u8 {
    // THE STALE-ARTIFACT REFUSAL on the binary path (#1020 Artifacts,
    // D-1020-G2). A shell that spawns this gateway — the Electron seat, a
    // systemd unit written by a release it recorded the digest of — sets
    // `CENTRAID_EXPECTED_CORE_DIGEST` to the digest ITS build was made against.
    // A mismatch is refused here, before the endpoint binds and before one
    // query is answered from a schema the caller stopped speaking. Unset means
    // nobody claimed an expectation, which is a developer running the binary by
    // hand; it is not treated as a match.
    if let Ok(expected) = std::env::var("CENTRAID_EXPECTED_CORE_DIGEST") {
        let identity = crate::identity::ArtifactIdentity::current();
        match crate::identity::require_digest(&identity, &expected) {
            Ok(None) => {}
            Ok(Some(warning)) => eprintln!("centraid: {warning}"),
            Err(refusal) => {
                eprintln!("centraid: {refusal}");
                return exit::REFUSED;
            }
        }
    }

    let config = EndpointConfig {
        relay: relay_mode(args.relay, args.no_relay),
        ..EndpointConfig::default()
    };
    let endpoint = match Endpoint::spawn(config).await {
        Ok(endpoint) => endpoint,
        Err(error) => {
            eprintln!("centraid: the endpoint would not bind: {error}");
            return exit::REFUSED;
        }
    };

    // D-1020-C8: the durable ALLOWLIST lands in crates/vault (lane D2). The
    // VAULT is durable as of wave 3 lane G, and the difference is stated line
    // by line below rather than left as one vague warning — "nothing is
    // durable" and "the vault is durable and the pairings are not" are
    // different operational facts, and an operator about to restart a gateway
    // needs the second one.
    let allowlist = std::sync::Arc::new(MemoryAllowlist::new());
    let mut capture = None;
    match &args.data_dir {
        Some(dir) => {
            match open_or_found_vault(dir, &args.vault_name) {
                Ok(founded) => {
                    eprintln!(
                        "centraid: vault {} at {}",
                        founded.vault_id,
                        founded.file.display()
                    );
                    capture = Some(founded);
                }
                Err(why) => {
                    eprintln!("centraid: {why}");
                    return exit::REFUSED;
                }
            }
            eprintln!(
                "centraid: the device allowlist is still IN MEMORY (D-1020-C8, wave 2 lane D2): \
                 every pairing in this run is lost on exit and a paired seat must pair again \
                 after a restart. The vault itself is not."
            );
        }
        None => eprintln!(
            "centraid: no --data-dir, so there is no vault and the allowlist is in memory. \
             Nothing this run does survives it."
        ),
    }

    println!("{READY_LINE} endpoint={}", hex(&endpoint.id()));

    if args.print_qr {
        match pairing::mint(&endpoint, allowlist.as_ref(), &args.vault_name, now_ms()).await {
            Ok(minted) => print_ticket(&minted.encoded),
            Err(error) => {
                eprintln!("centraid: could not mint a pair ticket: {error}");
                return exit::REFUSED;
            }
        }
    }

    // THE WAL CAPTURE TICK (#1020, D-1020-G9). `rpoSeconds` is the tick, which
    // is the whole point of the number: "how much can I lose" and "how often do
    // I ship" are one thing the owner sets once. Lane R built the seal and the
    // replay ordering and named the missing tick as a gap; this is the loop.
    //
    // It runs in the GATEWAY because the gateway holds the one writable
    // connection: a tick anywhere else would be reading a WAL whose end it
    // cannot bound. A failed tick logs and the loop continues — one bad tick
    // must not take the gateway down, and the next tick's segment simply starts
    // at the same offset.
    // `_held` is the gateway's one writable connection. It must outlive the
    // capture loop: dropping it checkpoints the WAL away.
    let (_held, ticking) = match capture {
        None => (None, None),
        Some(founded) => {
            let policy = centraid_vault::backup::BackupPolicy::default();
            let interval = std::time::Duration::from_millis(policy.capture_tick_ms());
            let mut capture = founded.capture;
            let data_dir = founded.data_dir;
            let task = tokio::spawn(async move {
                let mut ticks = 0_u64;
                let mut sealed = 0_u64;
                loop {
                    tokio::time::sleep(interval).await;
                    let generation = crate::cmd::capture::pending_tail(&data_dir)
                        .map(|tail| tail.len() as u64)
                        .unwrap_or(0)
                        + 1;
                    let tick_ms = now_ms();
                    ticks += 1;
                    let outcome = capture.tick(generation, tick_ms);
                    let last = match &outcome {
                        Ok(Some(segment)) => {
                            sealed += 1;
                            tracing::info!(
                                group = segment.group,
                                start = segment.start_offset,
                                end = segment.end_offset,
                                "a WAL segment was sealed"
                            );
                            Some(segment)
                        }
                        Ok(None) => {
                            tracing::debug!("capture tick: the WAL has not grown");
                            None
                        }
                        Err(error) => {
                            tracing::warn!(%error, "a capture tick failed");
                            None
                        }
                    };
                    // THE LIVENESS MARKER, written on EVERY tick including the
                    // ones that sealed nothing. "You can lose at most
                    // rpoSeconds" is a claim about a loop, and a loop that is
                    // running and a loop that is dead look identical from
                    // outside when there is nothing to capture.
                    if let Err(error) =
                        crate::cmd::capture::record_tick(&data_dir, tick_ms, ticks, sealed, last)
                    {
                        tracing::warn!(%error, "the capture tick could not record that it ran");
                    }
                }
            });
            (Some(founded.vault), Some(task))
        }
    };

    // The accept loop. A refused connection is logged and the loop continues:
    // one impostor must not take the gateway down.
    let serving = {
        let endpoint = endpoint.clone();
        let allowlist = allowlist.clone();
        let vault_name = args.vault_name.clone();
        tokio::spawn(async move {
            loop {
                match endpoint.accept(allowlist.as_ref()).await {
                    Ok(None) => break,
                    Ok(Some(accepted)) if accepted.alpn == alpn::PAIR => {
                        let outcome = pairing::serve_redemption(
                            &accepted.connection,
                            allowlist.as_ref(),
                            "vault",
                            &vault_name,
                            &hex(&endpoint.id()),
                            now_ms(),
                        )
                        .await;
                        // THE CLOSE HANDSHAKE (#1020, D-1020-G10). The
                        // redemption is answered and flushed; dropping the
                        // connection now would send CONNECTION_CLOSE and
                        // discard the response before the seat read it — which
                        // is a member told pairing failed on a device the
                        // gateway just enrolled. Waiting for the PEER's close
                        // is the synchronisation; the timeout is only there so
                        // a seat that never closes cannot hold the lane, and it
                        // is generous because it is a backstop and not a
                        // guess at the network.
                        let _ = tokio::time::timeout(
                            std::time::Duration::from_secs(10),
                            accepted.connection.closed(),
                        )
                        .await;
                        match outcome {
                            Ok(redeemed) => match redeemed.device {
                                Some(device) => tracing::info!(
                                    device = %device.device_id,
                                    label = %device.label,
                                    "a device paired"
                                ),
                                None => tracing::warn!("a redemption was refused"),
                            },
                            Err(error) => tracing::warn!(%error, "the pair lane failed"),
                        }
                    }
                    Ok(Some(accepted)) => {
                        // The seat lane. Serving it needs crates/seat's replica
                        // plane (lane D2); the connection is admitted — the
                        // device IS enrolled — and then closed, which is the
                        // honest answer while there is no log to serve.
                        tracing::warn!(
                            device = ?accepted.device.map(|device| device.device_id),
                            "a seat connected; the replica plane lands in wave 2 lane D2"
                        );
                    }
                    Err(error) => tracing::warn!(%error, "a connection was refused"),
                }
            }
        })
    };

    let _ = tokio::signal::ctrl_c().await;
    tracing::info!("shutting down");
    serving.abort();
    if let Some(ticking) = ticking {
        ticking.abort();
    }
    endpoint.close().await;
    exit::OK
}

/// What the gateway holds open for a data directory.
struct FoundedVault {
    vault_id: String,
    file: PathBuf,
    data_dir: PathBuf,
    capture: crate::cmd::capture::WalCapture,
    /// THE ONE WRITABLE CONNECTION, held for the life of the process.
    ///
    /// Not a formality, and not only the #1020 rule that the gateway is the
    /// vault's single writer. In WAL mode SQLite CHECKPOINTS AND REMOVES the
    /// `-wal` file when the last connection closes, so a gateway that opened
    /// the vault, founded it and closed the connection would leave the capture
    /// tick with nothing to read — the first generation's WAL tail would be
    /// empty and the RPO would silently be "since the last snapshot" again,
    /// which is the exact gap wave 2 lane R named. Holding it open is what
    /// makes the tick have bytes.
    ///
    /// It is not moved into the capture task: `Vault` carries boxed `Clock` and
    /// `Ids` trait objects that are not `Send`, and the tick needs no
    /// connection at all — it reads the `-wal` file.
    vault: centraid_vault::file::Vault,
}

/// Open the vault under a data directory, FOUNDING it if there is none.
///
/// Founding is two acts in `crates/vault` and deliberately so — `Vault::create`
/// makes a file with a schema and no facts, `Vault::found` writes the vault row
/// and its owner — and this is the one place that does both, because a gateway
/// pointed at an empty directory has to end up with a vault somebody owns or it
/// has nothing to serve. `centraid recover` restores a file that already has an
/// owner and never comes through here.
///
/// The vault file's directory is its vault id, which is the layout
/// `cmd::sole_vault_file` reads. It cannot be known before the vault is founded
/// (the id is generated inside the commit), so the file is created at a
/// temporary name and moved once it has one — rather than inventing an id
/// outside the vault and having two sources for it.
fn open_or_found_vault(data_dir: &Path, display_name: &str) -> Result<FoundedVault, String> {
    use centraid_vault::custody::KeyStore;
    use centraid_vault::file::Vault;

    std::fs::create_dir_all(crate::cmd::vault_dir_in(data_dir))
        .map_err(|error| format!("creating the vault directory: {error}"))?;

    let file = match crate::cmd::sole_vault_file(data_dir) {
        Ok(file) => file,
        Err(why) if why.starts_with("no vault under") => {
            let staging = crate::cmd::vault_dir_in(data_dir).join(".founding");
            let _ = std::fs::remove_dir_all(&staging);
            std::fs::create_dir_all(&staging)
                .map_err(|error| format!("creating {}: {error}", staging.display()))?;
            let staged = staging.join("vault.db");
            let vault = Vault::create(&staged)
                .map_err(|error| format!("founding a vault at {}: {error}", staged.display()))?;
            let founded = vault
                .found(display_name, "Owner")
                .map_err(|error| format!("writing the vault and owner rows: {error}"))?;
            drop(vault);
            let home = crate::cmd::vault_dir_in(data_dir).join(&founded.vault_id);
            std::fs::rename(&staging, &home)
                .map_err(|error| format!("moving the new vault to {}: {error}", home.display()))?;
            eprintln!(
                "centraid: FOUNDED a new vault {} (owner party {})",
                founded.vault_id, founded.owner_party_id
            );
            home.join("vault.db")
        }
        Err(why) => return Err(why),
    };

    // Opened, and KEPT open — see the `vault` field's comment. Opening also
    // migrates the file forward if it is behind, which is the other thing that
    // has to happen before anything serves from it.
    let vault =
        Vault::open(&file).map_err(|error| format!("opening {}: {error}", file.display()))?;
    let vault_id = vault
        .vault_id()
        .map_err(|error| error.to_string())?
        .ok_or_else(|| {
            format!(
                "{} has a schema and no vault row — it was created and never founded. `centraid \
                 recover` is the verb for a vault that exists elsewhere; this directory has a \
                 half-made one.",
                file.display()
            )
        })?;

    // The same master keyring `centraid backup now` uses, in the same place:
    // one directory to back up out-of-band, not two.
    let keys = KeyStore::new(crate::cmd::keys_dir_in(data_dir));
    let master = keys
        .load_or_create("backup.master.key")
        .map_err(|error| format!("backup master key: {error}"))?;
    for warning in keys.take_warnings() {
        eprintln!("centraid: {warning}");
    }
    let capture = crate::cmd::capture::WalCapture::open(data_dir, &file, vault_id.clone(), master)?;
    Ok(FoundedVault {
        vault_id,
        file,
        data_dir: data_dir.to_path_buf(),
        capture,
        vault,
    })
}

/// `centraid pair --mint`: mint one ticket, print it, exit.
///
/// Without `--mint` there is nothing to do and the usage code says so rather
/// than a zero exit on no work.
pub async fn pair_mint(
    mint: bool,
    data_dir: Option<PathBuf>,
    vault_name: String,
    no_relay: bool,
) -> u8 {
    if !mint {
        eprintln!(
            "centraid: `pair` needs `--mint` (or use `centraid seat pair <ticket>` to redeem one)."
        );
        return exit::USAGE;
    }
    let _ = data_dir;
    let config = EndpointConfig {
        relay: relay_mode(None, no_relay),
        ..EndpointConfig::default()
    };
    let endpoint = match Endpoint::spawn(config).await {
        Ok(endpoint) => endpoint,
        Err(error) => {
            eprintln!("centraid: the endpoint would not bind: {error}");
            return exit::REFUSED;
        }
    };
    let allowlist = MemoryAllowlist::new();
    let minted = match pairing::mint(&endpoint, &allowlist, &vault_name, now_ms()).await {
        Ok(minted) => minted,
        Err(error) => {
            eprintln!("centraid: could not mint a pair ticket: {error}");
            return exit::REFUSED;
        }
    };
    print_ticket(&minted.encoded);
    eprintln!(
        "centraid: this ticket was minted by a process that is about to exit, so nothing can \
         redeem it. Run `centraid gateway --print-qr` for a ticket a device can use \
         (D-1020-C8: the durable allowlist lands in wave 2 lane D1)."
    );
    endpoint.close().await;
    exit::OK
}

/// `centraid seat pair <ticket>`: redeem a ticket against its gateway.
pub async fn seat_pair(encoded: &str) -> u8 {
    let Some(scanned) = ticket::decode(encoded) else {
        eprintln!(
            "centraid: that is not a v{} pair ticket. Scan the QR again, or copy the whole line \
             the gateway printed.",
            ticket::TICKET_VERSION
        );
        return exit::REFUSED;
    };
    if ticket::is_expired(&scanned, now_ms()) {
        eprintln!("centraid: that ticket has expired. Ask the gateway for a new one.");
        return exit::REFUSED;
    }

    let endpoint = match Endpoint::spawn(EndpointConfig::default()).await {
        Ok(endpoint) => endpoint,
        Err(error) => {
            eprintln!("centraid: the endpoint would not bind: {error}");
            return exit::REFUSED;
        }
    };
    let platform = std::env::consts::OS;
    let name = hostname().unwrap_or_else(|| format!("a {platform} seat"));
    let outcome = pairing::redeem(&endpoint, &scanned, &name, platform).await;
    endpoint.close().await;

    use centraid_api_proto::core_v1::pair_response;
    match outcome {
        Ok(response) => match response.result {
            Some(pair_response::Result::Ok(ok)) => {
                println!("paired vault={} device={}", ok.vault_name, ok.device_id);
                eprintln!(
                    "centraid: the enrolment is recorded on the gateway. The replica itself lands \
                     in wave 2 lane D2, so this seat holds no rows yet."
                );
                exit::OK
            }
            Some(pair_response::Result::Error(error)) => {
                eprintln!(
                    "centraid: the gateway refused the ticket: {:?}",
                    error.code()
                );
                exit::REFUSED
            }
            None => {
                eprintln!("centraid: the gateway answered with no result.");
                exit::REFUSED
            }
        },
        Err(error) => {
            eprintln!("centraid: {error}");
            exit::REFUSED
        }
    }
}

/// The ticket, then its QR. The string comes FIRST and on stdout, because a
/// member on a phone scans and a member on an ssh session copies — and a QR
/// that scrolled the string out of the buffer serves only the first.
fn print_ticket(encoded: &str) {
    println!("ticket {encoded}");
    match ticket::qr(encoded) {
        Ok(rendered) => println!("{rendered}"),
        Err(error) => eprintln!("centraid: the ticket would not render as a QR: {error}"),
    }
}

fn hex(bytes: &[u8]) -> String {
    centraid_net::allowlist::hex_lower(bytes)
}

fn hostname() -> Option<String> {
    std::fs::read_to_string("/etc/hostname")
        .ok()
        .map(|name| name.trim().to_owned())
        .filter(|name| !name.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_relay_flags_resolve_in_one_place() {
        assert_eq!(relay_mode(None, false), RelayMode::Default);
        assert_eq!(relay_mode(None, true), RelayMode::Disabled);
        assert_eq!(
            relay_mode(Some("https://relay.example".to_owned()), false),
            RelayMode::Custom("https://relay.example".to_owned())
        );
        // `--no-relay` wins over `--relay`, and clap refuses the combination
        // anyway; the belt and the braces disagreeing is the failure worth
        // ruling out.
        assert_eq!(
            relay_mode(Some("https://relay.example".to_owned()), true),
            RelayMode::Disabled
        );
    }

    /// An unimplemented verb exits 3, never 0. The whole point of
    /// D-1020-C11 in one assertion.
    #[test]
    fn an_unavailable_verb_exits_three() {
        assert_eq!(not_yet_available("recover", "wave 2 lane R"), 3);
        assert_ne!(not_yet_available("recover", "wave 2 lane R"), exit::OK);
    }

    #[tokio::test]
    async fn pair_without_mint_is_a_usage_error_rather_than_silent_success() {
        assert_eq!(
            pair_mint(false, None, "Home".to_owned(), true).await,
            exit::USAGE
        );
    }

    /// A malformed or expired ticket is refused before any endpoint is bound,
    /// so a mistyped paste costs no socket.
    #[tokio::test]
    async fn a_bad_ticket_is_refused_without_touching_the_network() {
        assert_eq!(seat_pair("not a ticket").await, exit::REFUSED);
        assert_eq!(seat_pair("").await, exit::REFUSED);
    }

    #[test]
    fn the_exit_codes_are_distinct_and_zero_means_it_worked() {
        let codes = [
            exit::OK,
            exit::REFUSED,
            exit::USAGE,
            exit::NOT_YET_AVAILABLE,
        ];
        assert_eq!(codes, [0, 1, 2, 3]);
        for (index, code) in codes.iter().enumerate() {
            for (other_index, other) in codes.iter().enumerate() {
                if index != other_index {
                    assert_ne!(code, other);
                }
            }
        }
    }
}
