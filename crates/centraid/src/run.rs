//! What each subcommand does.
//!
//! Only `gateway`, `pair --mint` and `seat pair` run for real in this lane; the
//! rest name the lane that owns them and exit 3. The split is deliberate: a
//! subcommand that pretends to work is worse than one that says it does not.

use std::path::PathBuf;

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

    // D-1020-C8: the durable allowlist lands in crates/vault (lane D1). Until
    // then a data directory is accepted and NOT silently honoured — a gateway
    // that took `--data-dir` and kept nothing would lose every pairing on
    // restart without saying so.
    let allowlist = std::sync::Arc::new(MemoryAllowlist::new());
    if let Some(dir) = &args.data_dir {
        eprintln!(
            "centraid: --data-dir {} is accepted and NOT yet durable: the SQLite allowlist lands \
             in crates/vault (wave 2 lane D1, D-1020-C8). Every pairing in this run is lost on \
             exit.",
            dir.display()
        );
    } else {
        eprintln!(
            "centraid: no --data-dir, so the allowlist is in memory. Every pairing is lost on exit."
        );
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
    endpoint.close().await;
    exit::OK
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
