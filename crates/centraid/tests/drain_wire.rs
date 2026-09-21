//! **THE DRAIN, OVER THE CARRIER THE PRODUCT SHIPS** (#1029 §2, W15-2).
//!
//! A real vault on a real file, a real `centraid-gateway-server` served through
//! `serve::IrohListener` on a loopback iroh endpoint, and
//! `centraid_core::phone::drain_now` — the core's own door, the one
//! `centraid_call`'s `Drain` arm reaches — driving a real
//! `GatewayClient<IrohTransport>` from the spool.
//!
//! Nothing here is a fake that agrees with itself. The gateway is the shipped
//! router over the shipped carrier; the client is the shipped client; the
//! sealing is `backup::capture` and the manifests are `GenerationManifest`.
//!
//! # RELAY OFF, ADDRESS LOOKUP OFF
//!
//! Both endpoints are loopback with no relay and no DNS, and the phone is
//! handed the server's direct address through the laptop record's
//! `direct_addrs` — which is exactly what that field is for (D-1020-C15). A
//! test that reached n0's relay mesh would be measuring somebody else's uptime.
//!
//! # WHAT IS ASSERTED, BY NAME
//!
//! | Test | The claim |
//! |---|---|
//! | [`a_drain_moves_the_spool_to_the_laptop_and_acks_what_the_laptop_acked`] | one pass with no deadline empties the spool, and `acked_txid` is the gateway's, not the phone's |
//! | [`a_deadline_stops_a_pass_on_an_entry_boundary_and_the_next_pass_continues`] | the acceptance criterion: a budget that admits one entry acks exactly that prefix, and the next pass carries on from it without re-sending what was acked |
//! | [`an_unpaired_phone_reports_unreachable_and_loses_nothing`] | the spool is intact and the next pass starts where this one did |
//!
//! # THIS TEST LANDS RED
//!
//! On the commit before its implementation, `phone::drain` seals into the spool
//! and answers `DRAIN_STOP_UNREACHABLE` because nothing uploads. All three
//! cases fail on their assertions — they compile, they run, and they say what
//! is missing.

use std::path::Path;

use centraid_api_proto::core_v1 as wire;
use centraid_core::phone::{self, Keyring, Laptop};
use centraid_gateway_core::Gateway;
use centraid_gateway_core::ids::{Key32, VaultId};
use centraid_gateway_core::plan::Plan;
use centraid_gateway_core::retention::Policy;
use centraid_gateway_server::bytes::configured::{Backend, ConfiguredBytes};
use centraid_gateway_server::bytes::fs::FilesystemBytes;
use centraid_gateway_server::config::{Config, IrohConfig};
use centraid_gateway_server::http::Server;
use centraid_gateway_server::serve;
use centraid_gateway_server::state::{SqliteState, register};
use centraid_identity::RecoveryPhrase;
use centraid_vault::Vault;

const PHRASE: &str = "abandon abandon abandon abandon abandon abandon abandon abandon abandon \
                      abandon abandon abandon abandon abandon abandon abandon abandon abandon \
                      abandon abandon abandon abandon abandon art";

/// The vault's derivation index. Never chosen by a shell, and never reused (F2).
const INDEX: u32 = 0;

/// Commits before the drain. Enough that the spool holds several segments and
/// "a prefix" is a real claim with something left over.
const WRITES: usize = 12;

/// A live gateway on a loopback iroh endpoint.
struct Live {
    address: iroh::EndpointAddr,
    _objects: tempfile::TempDir,
    _served: tokio::task::JoinHandle<()>,
}

async fn live(vault: VaultId, identity: Key32) -> Live {
    let objects = tempfile::tempdir().expect("a temporary object directory");
    let mut state = SqliteState::in_memory().expect("a state file");
    register(&mut state, vault, identity, Plan::active(u64::MAX), false)
        .await
        .expect("a registered vault");

    let bytes = ConfiguredBytes::new(Backend::Filesystem(
        FilesystemBytes::open(objects.path(), "").expect("an object directory"),
    ));
    let server = Server {
        gateway: Gateway::new(state, bytes, Policy::default()),
        config: Config::defaults(objects.path(), ""),
    };
    // THE PRODUCTION PATH binds the listener: an endpoint that offers an ALPN
    // outside `serve.rs` is a `no-listening-socket` finding and should be.
    let endpoint = serve::bind_iroh(
        objects.path(),
        &IrohConfig {
            local_only: true,
            bind_addr: Some("127.0.0.1:0".to_owned()),
            ..IrohConfig::default()
        },
    )
    .await
    .expect("a bound endpoint");
    let address = iroh::EndpointAddr::from_parts(
        endpoint.id(),
        endpoint
            .bound_sockets()
            .into_iter()
            .map(iroh::TransportAddr::Ip),
    );
    let served = tokio::spawn(async move {
        let _ = serve::serve_iroh(endpoint, serve::shared(server)).await;
    });
    Live {
        address,
        _objects: objects,
        _served: served,
    }
}

/// This phone's keys, from the 24 words and a minted device secret.
fn keyring() -> (Keyring, [u8; 32]) {
    let seed = RecoveryPhrase::parse(PHRASE)
        .expect("the vector parses")
        .seed();
    let secret = [0xD1_u8; 32];
    (
        Keyring::derive(&seed, INDEX, Some(secret)).expect("a fresh index"),
        secret,
    )
}

/// Write the record a pairing would have written, pointing at `live`.
fn pair_with(vault_file: &Path, live: &Live, keyring: &Keyring, secret: &[u8; 32]) {
    let device = phone::link::Device::certify(secret, &keyring.vault.identity, 1);
    Laptop {
        gateway_endpoint: hex::encode(live.address.id.as_bytes()),
        relay_url: Some(String::new()),
        direct_addrs: live
            .address
            .ip_addrs()
            .map(|addr: &std::net::SocketAddr| addr.to_string())
            .collect(),
        device_certificate: Some(device.certificate_hex()),
        epoch: Some(1),
        last_acked_at_ms: None,
    }
    .write(vault_file)
    .expect("the laptop record is written");
}

/// A founded vault with `WRITES` commits in it.
fn founded(dir: &Path) -> (Vault, std::path::PathBuf) {
    std::fs::create_dir_all(dir).expect("the directory is made");
    let file = dir.join("vault.db");
    let vault = Vault::create(&file).expect("a vault file");
    vault
        .found("The Drain Household", "Ada")
        .expect("it founds");
    for index in 0..WRITES {
        centraid_vault::backup::drill::write_one(&vault, index).expect("a commit");
    }
    (vault, file)
}

fn drain(
    vault: &Vault,
    file: &Path,
    keyring: &Keyring,
    deadline_ms: u64,
    runtime: &tokio::runtime::Handle,
) -> wire::DrainResponse {
    phone::drain_now(
        vault,
        file,
        Some(keyring),
        &wire::DrainRequest { deadline_ms },
        runtime,
    )
    .expect("a drain answers")
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_drain_moves_the_spool_to_the_laptop_and_acks_what_the_laptop_acked() {
    let dir = centraid_ontology::golden::scratch_dir();
    let (vault, file) = founded(&dir);
    let (keys, secret) = keyring();
    let gateway = live(
        Key32::from_bytes(keys.vault.identity.public().to_bytes()),
        Key32::from_bytes(keys.vault.identity.public().to_bytes()),
    )
    .await;
    pair_with(&file, &gateway, &keys, &secret);

    let runtime = tokio::runtime::Handle::current();
    let answer = tokio::task::block_in_place(|| drain(&vault, &file, &keys, 0, &runtime));

    assert_eq!(
        answer.stopped,
        wire::DrainStop::Empty as i32,
        "a pass with no deadline runs until the spool is empty"
    );
    assert!(
        answer.acked_txid > 0,
        "the gateway acked nothing, so there is nothing to claim"
    );
    assert_eq!(
        answer.pending_bytes, 0,
        "the spool still holds {} bytes after an Empty pass",
        answer.pending_bytes
    );
    // THE ONLY BACKUP CLAIM THERE IS: the server's own moment, in the server's
    // own answer.
    assert!(
        answer.acked_at_ms.is_some_and(|moment| moment > 0),
        "a pass that acked carries the GATEWAY's moment and not this phone's"
    );

    // AND A STATUS READ AGREES, without dialling anything.
    let status = phone::backup_status(&file).expect("a status reads");
    assert!(status.laptop_paired);
    assert_eq!(status.acked_txid, Some(answer.acked_txid));
    assert_eq!(status.acked_at_ms, answer.acked_at_ms);
    assert_eq!(status.pending_bytes, 0);

    drop(vault);
    let _ = std::fs::remove_dir_all(&dir);
}

/// **THE ACCEPTANCE CRITERION.** A budget that admits one entry acks exactly
/// that prefix, and the next pass continues from there.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_deadline_stops_a_pass_on_an_entry_boundary_and_the_next_pass_continues() {
    let dir = centraid_ontology::golden::scratch_dir();
    let (vault, file) = founded(&dir);
    let (keys, secret) = keyring();
    let gateway = live(
        Key32::from_bytes(keys.vault.identity.public().to_bytes()),
        Key32::from_bytes(keys.vault.identity.public().to_bytes()),
    )
    .await;
    pair_with(&file, &gateway, &keys, &secret);

    let runtime = tokio::runtime::Handle::current();

    // A BUDGET OF ONE MILLISECOND. Rule 2 of the deadline semantics: a pass
    // always commits at least one entry, however small the budget — a window
    // too small for a single entry that made no progress would make a phone on
    // 28-second windows never finish. So this pass commits exactly one.
    let first = tokio::task::block_in_place(|| drain(&vault, &file, &keys, 1, &runtime));
    assert_eq!(
        first.stopped,
        wire::DrainStop::Deadline as i32,
        "a one-millisecond budget does not empty a spool"
    );
    assert!(
        first.acked_txid > 0,
        "a pass that commits nothing at all makes a phone on small windows never finish"
    );
    assert!(
        first.pending_bytes > 0,
        "the deadline stopped a pass that had nothing left to do"
    );

    // AND THE NEXT PASS CARRIES ON FROM THERE. Not from the beginning: the
    // objects already committed come back as `already_committed` and are not
    // re-sent, which is what makes a resumed drain cheap.
    let second = tokio::task::block_in_place(|| drain(&vault, &file, &keys, 0, &runtime));
    assert_eq!(
        second.stopped,
        wire::DrainStop::Empty as i32,
        "the second pass should have finished the spool"
    );
    assert!(
        second.acked_txid > first.acked_txid,
        "the second pass acked {} and the first had already acked {}",
        second.acked_txid,
        first.acked_txid
    );
    assert_eq!(second.pending_bytes, 0);

    // A THIRD PASS OVER AN EMPTY SPOOL IS A NO-OP AND SAYS SO. Idempotent, and
    // safe to call from a background window that fired one second late.
    let third = tokio::task::block_in_place(|| drain(&vault, &file, &keys, 0, &runtime));
    assert_eq!(third.stopped, wire::DrainStop::Empty as i32);
    assert_eq!(third.pending_bytes, 0);

    drop(vault);
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_unpaired_phone_reports_unreachable_and_loses_nothing() {
    let dir = centraid_ontology::golden::scratch_dir();
    let (vault, file) = founded(&dir);
    let (keys, _) = keyring();
    let runtime = tokio::runtime::Handle::current();

    let answer = tokio::task::block_in_place(|| drain(&vault, &file, &keys, 0, &runtime));
    assert_eq!(
        answer.stopped,
        wire::DrainStop::Unreachable as i32,
        "a phone with no laptop has nowhere to send bytes"
    );
    assert_eq!(
        answer.acked_at_ms, None,
        "nothing acked, so nothing claimed"
    );
    assert!(
        answer.pending_bytes > 0,
        "the pass sealed nothing into the spool, so there is nothing to resume"
    );

    // AND THE SPOOL IS STILL THERE for the pass that finds a laptop.
    let again = tokio::task::block_in_place(|| drain(&vault, &file, &keys, 0, &runtime));
    assert_eq!(
        again.pending_bytes, answer.pending_bytes,
        "an unreachable pass lost part of the spool"
    );

    drop(vault);
    let _ = std::fs::remove_dir_all(&dir);
}
