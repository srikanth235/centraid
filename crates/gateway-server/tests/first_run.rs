//! IT RUNS WITH NO VAULT AND NO KEYS (#1029 §3).
//!
//! This is the lane's exit condition and it is not a claim: a self-hoster who
//! types one command on an empty directory must get a server that is up,
//! correct and holding nothing — and must not be asked for a key, a
//! certificate, a passphrase or a seed, because **the gateway is blind and has
//! no use for one**.
//!
//! What "holding nothing" has to mean, and each is asserted below:
//!
//! - the state file exists and every table is empty;
//! - an unregistered vault is refused, and refused as a **stranger** — a
//!   gateway that answered "no such vault" would be an oracle for which
//!   identity keys it holds;
//! - the health endpoint answers, so the phone can negotiate a version before
//!   anybody has an account;
//! - the data directory contains no private key of any kind.

use centraid_gateway_core::Gateway;
use centraid_gateway_core::ids::Key32;
use centraid_gateway_core::retention::Policy;
use centraid_gateway_server::bytes::configured::{Backend, ConfiguredBytes};
use centraid_gateway_server::bytes::fs::FilesystemBytes;
use centraid_gateway_server::config::{Config, StoreConfig, TlsConfig};
use centraid_gateway_server::http::Server;
use centraid_gateway_server::serve;
use centraid_gateway_server::state::SqliteState;
use centraid_gateway_server::tenancy;

/// The whole of what a first run does, with nothing handed to it.
async fn first_run(data_dir: &std::path::Path) -> (Config, Server) {
    let config = Config::defaults(data_dir, "https://vault.example.org");
    std::fs::create_dir_all(&config.data_dir).expect("the data directory");
    let state = SqliteState::open(&config.state_path()).expect("a state file");
    let StoreConfig::Filesystem { path } = &config.store;
    let bytes = ConfiguredBytes::new(Backend::Filesystem(
        FilesystemBytes::open(&config.data_dir.join(path), &config.origin)
            .expect("an object directory"),
    ));
    let retention = config.retention();
    (
        config.clone(),
        Server {
            gateway: Gateway::new(state, bytes, retention),
            config,
        },
    )
}

#[tokio::test]
async fn a_bare_first_run_holds_no_vault_no_account_and_no_invite() {
    let data_dir = tempfile::tempdir().expect("a temporary data directory");
    let (config, server) = first_run(data_dir.path()).await;

    assert!(config.state_path().exists(), "the state file was created");
    assert!(
        server.gateway.state.vaults().expect("a read").is_empty(),
        "a first run holds no vault"
    );
    assert!(
        tenancy::list(&server.gateway.state)
            .expect("a read")
            .is_empty(),
        "a first run holds no invite"
    );
    // The dump is every row of every table. A first run's is empty.
    assert_eq!(
        server.gateway.state.dump().expect("a dump"),
        "",
        "a first run's state file holds no row at all"
    );

    // THERE IS NO CHECKSUM MODE TO CONFIGURE. The store-attested checksum existed for
    // a store the gateway could not read; v0's store is a directory on the
    // member's own laptop, so the gateway reads and hashes what it holds
    // (scope amendment 2026-09-21).
    assert!(
        !server.gateway.bytes.has_mirror(),
        "a mirror is a decision about somebody else's disk"
    );
    assert!(matches!(config.tls, TlsConfig::Terminated));
}

/// A STRANGER AND AN UNREGISTERED VAULT ARE THE SAME REFUSAL, from the first
/// second the server is up.
#[tokio::test]
async fn an_unknown_vault_is_refused_as_a_stranger() {
    use centraid_gateway_core::error::Refusal;

    let data_dir = tempfile::tempdir().expect("a temporary data directory");
    let (_, server) = first_run(data_dir.path()).await;
    let outcome = server.gateway.vault(&Key32::from_bytes([0x77; 32])).await;
    assert!(
        matches!(
            outcome,
            Err(centraid_gateway_core::engine::Fault::Refused(
                Refusal::UnknownVault
            ))
        ),
        "{outcome:?}"
    );
    assert_eq!(
        Refusal::UnknownVault.code(),
        centraid_api_proto::core_v1::ErrorCode::Unauthorized,
        "the code a stranger gets and the code an unregistered vault gets are \
         the same one, so neither answers whether the other exists"
    );
}

/// NOTHING IN THE DATA DIRECTORY IS A KEY. v0's gateway installer carried a
/// wrapping key through a systemd credential and a keychain entry; a blind
/// gateway has none, and the absence is checked rather than asserted.
#[tokio::test]
async fn a_first_run_writes_no_private_key_anywhere() {
    let data_dir = tempfile::tempdir().expect("a temporary data directory");
    let (_, server) = first_run(data_dir.path()).await;
    drop(server);

    let mut stack = vec![data_dir.path().to_path_buf()];
    let mut seen = 0_usize;
    while let Some(path) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&path) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
                continue;
            }
            seen += 1;
            let name = path.file_name().unwrap_or_default().to_string_lossy();
            for suffix in [".key", ".pem", ".p12", ".pfx", ".jwk"] {
                assert!(
                    !name.ends_with(suffix),
                    "a first run wrote {}, which looks like key material",
                    path.display()
                );
            }
            let bytes = std::fs::read(&path).unwrap_or_default();
            let text = String::from_utf8_lossy(&bytes);
            for marker in ["PRIVATE KEY", "BEGIN RSA", "BEGIN EC"] {
                assert!(
                    !text.contains(marker),
                    "{} contains `{marker}`",
                    path.display()
                );
            }
        }
    }
    assert!(
        seen > 0,
        "the data directory is empty, so nothing was checked"
    );
}

/// The health endpoint answers before anybody has an account, so a phone can
/// negotiate a version against a server it has no relationship with yet.
#[tokio::test]
async fn the_health_endpoint_answers_on_an_empty_server() {
    let data_dir = tempfile::tempdir().expect("a temporary data directory");
    let (_, server) = first_run(data_dir.path()).await;
    let bound = serve::bind("127.0.0.1:0").await.expect("a free port");
    let origin = format!("http://{}", bound.address);
    let shared = serve::shared(server);
    tokio::spawn(async move {
        let _ = serve::serve_plain(bound, shared).await;
    });

    let text = reqwest::get(format!("{origin}/v1/health"))
        .await
        .expect("a response")
        .text()
        .await
        .expect("a health body");
    let body: serde_json::Value = serde_json::from_str(&text).expect("health is JSON");
    assert_eq!(
        body["protocol_min"].as_u64(),
        Some(u64::from(centraid_gateway_core::PROTOCOL_MIN))
    );
    assert_eq!(
        body["protocol_max"].as_u64(),
        Some(u64::from(centraid_gateway_core::PROTOCOL_MAX))
    );
    assert!(
        body["server_time_ms"].as_i64().unwrap_or_default() > 1_577_836_800_000,
        "the server's own clock is what a skewed phone re-signs against"
    );
}

/// The retention policy a bare run uses is **`gateway-core`'s own**, not a set
/// of numbers this crate invented beside it. An adapter with its own floor is
/// an adapter that keeps a different backup.
#[tokio::test]
async fn the_retention_policy_is_the_rules_own() {
    let data_dir = tempfile::tempdir().expect("a temporary data directory");
    let (config, _) = first_run(data_dir.path()).await;
    assert_eq!(config.retention(), Policy::default());
}
