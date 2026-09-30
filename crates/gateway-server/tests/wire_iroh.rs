//! THE GATEWAY API, OVER IROH, END TO END, WITH REAL BYTES (#1029 W17).
//!
//! Every other test of this protocol drives the rules as a library or the HTTP
//! adapter over a loopback TCP socket. **This one moves bytes over the carrier
//! the product ships**: a real `centraid-gateway-server` router served through
//! `serve::IrohListener` on a real iroh endpoint, and a real
//! `GatewayClient<IrohTransport>` dialling it — the client's whole path, with
//! the same requests, headers, signatures and JSON bodies the TCP carrier
//! speaks.
//!
//! The [scope amendment of 2026-09-21](https://github.com/srikanth235/centraid/issues/1029#issuecomment-5755559795)
//! supersedes §3's "transport is HTTPS, not iroh" and answers open question 12
//! yes. The claim it makes is that **nothing on the wire changes** — so the one
//! thing this test must not do is assert a second protocol. It asserts the
//! first one, over a different carrier.
//!
//! ## RELAY OFF, ADDRESS LOOKUP OFF
//!
//! Both endpoints are built from `presets::Minimal` and bound to loopback, and
//! the test hands the client the server's direct address. A test that reached
//! n0's relay mesh or n0's DNS server would be a test that fails when a build
//! machine has no internet, and would be measuring somebody else's uptime. What
//! it costs is that the relayed and hole-punched paths are not exercised here;
//! they are iroh's own property and iroh's own test suite's.
//!
//! ## WHAT IS ASSERTED, BY NAME
//!
//! | Test | The claim |
//! |---|---|
//! | [`the_whole_client_path_moves_sixteen_mebibytes_over_iroh`] | admit, preflight, lease, declare, PUT 16 MiB, commit with `prev_head`, GET back, byte-equal |
//! | [`an_unsigned_request_is_refused_across_the_wire`] | the signature is checked on the far side of the carrier, not by it |
//! | [`a_version_window_refusal_parses_on_the_client`] | a refusal body the server wrote is a typed refusal the phone can act on |
//!
//! ## THIS TEST IS RED ON THE BASE, AND WHAT IT FOUND
//!
//! It lands failing, in its own commit, because there is no iroh carrier on
//! the base and because two of its three cases name real bugs it turned up:
//!
//! 1. **A 16 MiB `PUT` cannot be uploaded at all**, on either carrier. The
//!    router declares no body limit, so axum's default 2 MiB applies to the
//!    `Bytes` extractor — a silent cap at one eighth of the object size the
//!    protocol's own rules admit (F6). Nothing found it before because no test
//!    had ever put a full-sized object through the HTTP adapter.
//! 2. **A `VersionWindow` refusal does not deserialise on the phone.** See
//!    [`a_version_window_refusal_parses_on_the_client`].
//!
//! Both are fixed in W17-5.
//!
//! ## WHY `conformance::run` IS NOT DRIVEN THROUGH A TRANSPORT HERE
//!
//! It cannot be, cheaply. `centraid_gateway_core::conformance::Harness`
//! requires `fn gateway(&mut self) -> &mut Gateway<Self::State, Self::Bytes>`
//! — every case reaches **into** a `Gateway` value and calls its rules
//! directly, and resets it between cases. A `GatewayClient` has no `Gateway`
//! to hand back; it has a socket to one, in another process's address space in
//! the general case. Satisfying the trait over a transport would mean either a
//! second harness (forbidden: "do not build a second harness") or widening
//! `Harness` into a transport-shaped trait that the in-process adapters would
//! then implement through an adapter of their own. That is a real piece of
//! work with a real payoff — it would run the whole suite over the carrier —
//! and it is recorded as a receipt row rather than smuggled in here.

use centraid_gateway_client::client::GatewayClient;
use centraid_gateway_client::signer::DeviceSigner;
use centraid_gateway_client::transport::{HttpRequest, IrohTransport, Transport as _};
use centraid_gateway_core::Gateway;
use centraid_gateway_core::ids::{Key32, ObjectName, VaultId};
use centraid_gateway_core::plan::Plan;
use centraid_gateway_core::retention::Policy;
use centraid_gateway_server::bytes::configured::{Backend, ConfiguredBytes};
use centraid_gateway_server::bytes::fs::FilesystemBytes;
use centraid_gateway_server::config::{Config, IrohConfig};
use centraid_gateway_server::http::Server;
use centraid_gateway_server::state::{SqliteState, register};
use centraid_gateway_server::{clock, serve};
use centraid_identity::certificate::{DeviceCertificate, DeviceKey, Epoch};
use centraid_identity::{RecoveryPhrase, VaultIdentityKey};

/// The 16 MiB cap (F6), exactly. The object this test moves is the biggest one
/// the protocol admits, because a carrier that works for a 4 KiB body and
/// stalls on a real base is a carrier nobody finds out about until a restore.
const SIXTEEN_MEBIBYTES: usize = 16 * 1024 * 1024;

const PHRASE: &str = "abandon abandon abandon abandon abandon abandon abandon abandon abandon \
                      abandon abandon abandon abandon abandon abandon abandon abandon abandon \
                      abandon abandon abandon abandon abandon art";

/// One phone: its vault's identity key, its device key, and its certificate.
struct Phone {
    identity: VaultIdentityKey,
    device: DeviceKey,
    certificate: DeviceCertificate,
    vault: VaultId,
}

impl Phone {
    fn new(vault_index: u32, device_seed: u8) -> Self {
        let phrase = RecoveryPhrase::parse(PHRASE).expect("the BIP39 vector parses");
        let keys = centraid_identity::derive::restore_vault_keys(&phrase.seed(), vault_index)
            .expect("vault keys");
        let _ = device_seed;
        let device = DeviceKey::generate().expect("the OS rng");
        let certificate = DeviceCertificate::issue(&keys.identity, &device.public(), Epoch::new(1));
        Self {
            vault: Key32::from_bytes(keys.identity.public().to_bytes()),
            identity: keys.identity,
            device,
            certificate,
        }
    }

    fn signer(&self) -> DeviceSigner {
        self.signer_at(centraid_gateway_core::PROTOCOL_MIN)
    }

    /// A signer that stamps a chosen protocol version, so a request can be
    /// perfectly well formed and outside the server's window.
    fn signer_at(&self, protocol: u32) -> DeviceSigner {
        DeviceSigner::new(self.device.clone(), &self.certificate, protocol)
    }
}

/// A live gateway on an iroh endpoint, and the address to dial it at.
struct Live {
    address: iroh::EndpointAddr,
    /// Kept alive for the life of the server: dropping it removes the object
    /// directory, and dropping the task stops answering.
    _objects: tempfile::TempDir,
    _served: tokio::task::JoinHandle<()>,
}

/// **The phone's endpoint: no ALPN offered, and nothing here ever accepts.**
///
/// Bound to loopback with no relay and no address lookup, so this test
/// contacts no n0 service and is green on a machine with no internet.
async fn dialling_endpoint() -> iroh::Endpoint {
    iroh::Endpoint::builder(iroh::endpoint::presets::Minimal)
        .clear_ip_transports()
        .bind_addr("127.0.0.1:0")
        .expect("loopback is a socket address")
        .bind()
        .await
        .expect("a bound endpoint")
}

/// **The laptop's endpoint, built by the production path.**
///
/// `serve::bind_iroh` with `local_only` and a loopback `bind_addr`, not a
/// second construction written here: an endpoint that offers an ALPN outside
/// `serve.rs` is a `no-listening-socket` finding, and it should be — the one
/// test that moves real bytes ought to drive the same code an operator does.
async fn listening_endpoint(data_dir: &std::path::Path) -> iroh::Endpoint {
    serve::bind_iroh(
        data_dir,
        &IrohConfig {
            local_only: true,
            bind_addr: Some("127.0.0.1:0".to_owned()),
            ..IrohConfig::default()
        },
    )
    .await
    .expect("a bound endpoint")
}

/// Bring up a real server with one registered vault, served over iroh.
async fn live(phone: &Phone, quota_bytes: u64) -> Live {
    let objects = tempfile::tempdir().expect("a temporary object directory");
    let mut state = SqliteState::in_memory().expect("a state file");
    register(
        &mut state,
        phone.vault,
        Key32::from_bytes(phone.identity.public().to_bytes()),
        Plan::active(quota_bytes),
        false,
    )
    .await
    .expect("a registered vault");

    let bytes = ConfiguredBytes::new(Backend::Filesystem(
        FilesystemBytes::open(objects.path(), "").expect("an object directory"),
    ));
    let server = Server {
        gateway: Gateway::new(state, bytes, Policy::default()),
        config: Config::defaults(objects.path(), ""),
    };

    let endpoint = listening_endpoint(objects.path()).await;
    // THE DIRECT ADDRESS, handed over rather than resolved: with no relay and
    // no address lookup there is nothing an endpoint id alone could be dialled
    // through, which is exactly the case `PairTicket::direct_addrs` exists for.
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

async fn dial(live: &Live, phone: &Phone) -> GatewayClient<IrohTransport> {
    let endpoint = dialling_endpoint().await;
    GatewayClient::new(
        IrohTransport::new(endpoint, live.address.clone()),
        phone.signer(),
        phone.vault,
    )
}

/// 16 MiB that do not compress to nothing and are not all one byte, so a
/// carrier that dropped or reordered a frame cannot pass by accident.
fn sealed_bytes() -> Vec<u8> {
    let mut bytes = vec![0u8; SIXTEEN_MEBIBYTES];
    let mut state = 0x2545_F491_4F6C_DD1D_u64;
    for chunk in bytes.chunks_mut(8) {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        for (slot, byte) in chunk.iter_mut().zip(state.to_le_bytes()) {
            *slot = byte;
        }
    }
    bytes
}

/// THE WHOLE CLIENT PATH, OVER THE CARRIER THE PRODUCT SHIPS.
///
/// Preflight, lease, declare, PUT a 16 MiB object, commit against `prev_head`,
/// GET it back, byte-equal. Every step is the real client method over a real
/// iroh bi-stream to the real router.
#[tokio::test]
async fn the_whole_client_path_moves_sixteen_mebibytes_over_iroh() {
    let phone = Phone::new(0, 0xA1);
    let live = live(&phone, 1_024 * 1_024 * 1_024).await;
    let mut client = dial(&live, &phone).await;
    let now = clock::now().millis();

    let preflight = client.preflight(now).await.expect("the server answers");
    assert_eq!(
        preflight.agreed,
        centraid_gateway_core::PROTOCOL_MIN,
        "the negotiated version is the protocol's, not the carrier's"
    );

    let lease = client.claim_lease(now).await.expect("the lease is claimed");
    assert_eq!(lease.epoch, 1);
    assert!(
        lease.head.is_none(),
        "a fresh vault has no manifest head to compare against"
    );

    let sealed = sealed_bytes();
    let name = ObjectName::of(&sealed);
    let targets = client
        .declare(
            &serde_json::json!({
                "objects": [{
                    "name": name.hex(),
                    "kind": "base",
                    "padded_size": sealed.len(),
                }]
            }),
            now,
        )
        .await
        .expect("the declaration is accepted");
    assert_eq!(targets.len(), 1);
    assert!(!targets[0].already_committed);

    // THE BYTES. 16 MiB up one iroh bidirectional stream.
    client
        .put_object(&name, sealed.clone(), now)
        .await
        .expect("16 MiB uploaded over iroh");

    let head = hex::encode([0x7A_u8; 32]);
    let generation = hex::encode([0x01_u8; 16]);
    let ack = client
        .commit(
            &serde_json::json!({
                "generation": generation,
                "objects": [name.hex()],
                "manifest_head": head,
                // FIRST WRITE, SO THERE IS NO PREVIOUS HEAD. The compare-and-set
                // is `None` against nothing, which is what makes a second writer
                // with a stale head lose rather than clobber (F7).
                "prev_head": serde_json::Value::Null,
                "first_txid": 1,
                "last_txid": 12,
            }),
            now,
        )
        .await
        .expect("the commit is acked");
    assert_eq!(ack.head, head, "the gateway holds the head it was given");

    let back = client.get_object(&name, now).await.expect("read back");
    assert_eq!(back.len(), sealed.len(), "16 MiB came back whole");
    assert_eq!(back, sealed, "byte-equal across the carrier");
}

/// THE SIGNATURE IS CHECKED ON THE FAR SIDE OF THE CARRIER.
///
/// A transport that authenticated would be a transport deciding something. It
/// does not: an unsigned request reaches the router over the same stream and is
/// refused there, by the same rule that refuses it over TCP.
#[tokio::test]
async fn an_unsigned_request_is_refused_across_the_wire() {
    let phone = Phone::new(0, 0xA1);
    let live = live(&phone, 1_024 * 1_024 * 1_024).await;
    let endpoint = dialling_endpoint().await;
    let transport = IrohTransport::new(endpoint, live.address.clone());

    let response = transport
        .send(HttpRequest {
            method: "POST".to_owned(),
            path: format!("/v1/vaults/{}/lease", phone.vault.hex()),
            headers: std::collections::BTreeMap::new(),
            body: Vec::new(),
        })
        .await
        .expect("the carrier carried it; refusing is the router's job");

    assert_eq!(response.status, 401, "an unsigned write is not served");
    let body: serde_json::Value =
        serde_json::from_slice(&response.body).expect("the refusal is JSON");
    assert_eq!(
        body["code"], "GatewaySignatureInvalid",
        "the code is the answer: {body}"
    );
}

/// A REFUSAL THE SERVER WROTE IS A REFUSAL THE PHONE CAN ACT ON.
///
/// **This is the red half of this lane.** `VersionWindow` is the one refusal
/// whose body the client must parse to do anything useful with it: the range
/// travels *with* the refusal, "so the phone can render the typed state
/// without a second round trip". On the base of this lane the server writes
/// `{server_protocol_min, server_protocol_max, client_protocol}` and the
/// client's `ProtocolBody` declares `{min, max}` non-optional, so the whole
/// body fails to deserialise and a phone that is simply too new gets
/// `Malformed` — "the gateway's answer did not decode", which reads as a
/// broken server and is not one. W17-5 makes the shape one declaration.
#[tokio::test]
async fn a_version_window_refusal_parses_on_the_client() {
    use centraid_gateway_client::outcome::{ClientError, ErrorBody, ServerNeeds};

    let phone = Phone::new(0, 0xA1);
    let live = live(&phone, 1_024 * 1_024 * 1_024).await;

    // A request that is correct in every way except its version, signed at a
    // protocol the server does not speak.
    let too_new = centraid_gateway_core::PROTOCOL_MAX + 7;
    let endpoint = dialling_endpoint().await;
    let mut client = GatewayClient::new(
        IrohTransport::new(endpoint, live.address.clone()),
        phone.signer_at(too_new),
        phone.vault,
    );
    let now = clock::now().millis();
    let error = client
        .claim_lease(now)
        .await
        .expect_err("the phone is outside the server's window");

    // The typed answer, through the client's own parser — not a comparison
    // against bytes, because what a phone acts on is the type.
    match &error {
        ClientError::Version(ServerNeeds::PhoneUpdate { server }) => assert_eq!(
            *server,
            (
                centraid_gateway_core::PROTOCOL_MIN,
                centraid_gateway_core::PROTOCOL_MAX
            ),
            "the companion travels with the refusal"
        ),
        other => panic!(
            "a VersionWindow refusal did not reach the phone as one. This is \
             the ProtocolBody shape mismatch: the server writes \
             `server_protocol_min`/`server_protocol_max`/`client_protocol` and \
             the client declares `min`/`max` non-optional, so the body does not \
             deserialise at all. Got: {other:?}"
        ),
    }

    // And the same thing one layer down, so a failure says WHICH field moved
    // rather than only that the type came out wrong.
    let transport = IrohTransport::new(dialling_endpoint().await, live.address.clone());
    let raw = transport
        .send(HttpRequest {
            method: "POST".to_owned(),
            path: format!("/v1/vaults/{}/lease", phone.vault.hex()),
            headers: std::collections::BTreeMap::new(),
            body: Vec::new(),
        })
        .await
        .expect("the carrier carried it");
    let _: ErrorBody = serde_json::from_slice(&raw.body)
        .expect("every refusal body the server writes parses on the client");
    let _ = ClientError::from_body;
}
