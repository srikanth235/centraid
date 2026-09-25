//! AGAINST N0'S OWN SERVER, NOT AGAINST A MOCK OF OURS (#1029 §0).
//!
//! Every other test in this crate proves that this code agrees with itself. A
//! record that round trips through our own encoder and our own decoder proves
//! nothing about whether an `iroh-dns-server` will store it, or whether what it
//! gives back is what we put in. So this file starts a real
//! [`iroh_dns_server::Server`] in-process on a free port, publishes through the
//! pkarr relay client, resolves back through it, and tears the server down with
//! the test.
//!
//! ## WHAT THE SERVER IS, AND WHY IT IS NOT A LISTENER OF OURS
//!
//! `iroh-dns-server` is a **dev-dependency**. The product opens no listening
//! socket (#1029 §6); this test process does, for the length of one test,
//! standing in for n0's infrastructure. `crates/identity` itself compiles with
//! `pkarr`'s `dht` feature off, so no socket is bound by anything under test —
//! the only thing the code being exercised does is make outbound HTTP requests
//! to the address this server printed.
//!
//! The server is configured with:
//! - HTTP on `127.0.0.1:0`, so the operating system picks a free port and
//!   parallel runs cannot collide;
//! - HTTPS off — there is no certificate worth minting for a loopback test, and
//!   pkarr's relay client speaks plain HTTP to an `http://` relay;
//! - the metrics server off, because it otherwise binds a *fixed* port and two
//!   test binaries would fight over it;
//! - the mainline DHT fallback off, which is the same refusal the manifest
//!   makes: a test that quietly reached the public DHT would be a test that
//!   needs the internet and sometimes passes for the wrong reason;
//! - its store in a `tempfile` directory, dropped with the test.

use std::net::{IpAddr, Ipv4Addr};

use centraid_identity::certificate::{DeviceCertificate, DeviceKey, DeviceTrust, Epoch};
use centraid_identity::derive::VaultMint;
use centraid_identity::discovery::{Discovery, DiscoveryError, ResolutionSource, SourceUsed};
use centraid_identity::phrase::RecoveryPhrase;
use centraid_identity::record::{GatewayUrl, IdentityRecord};
use iroh_dns_server::Server;
use iroh_dns_server::config::{Config, MetricsConfig};

const PHRASE: &str = "abandon abandon abandon abandon abandon abandon abandon abandon abandon \
     abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon \
     abandon abandon abandon art";

const GATEWAY: &str = "https://gateway.example/";

/// The laptop's iroh `EndpointId`. A test input, not a secret.
const LAPTOP_ENDPOINT: [u8; 32] = [0x5E; 32];

/// The server, and the relay URL to point a [`Discovery`] at.
struct LocalDnsServer {
    server: Server,
    relay: String,
    // Dropped last: the store lives here, and the server holds it open.
    _store: tempfile::TempDir,
}

impl LocalDnsServer {
    async fn start() -> Self {
        let store = tempfile::tempdir().expect("a temporary directory");
        let mut config = Config::default();
        config.data_dir = Some(store.path().to_path_buf());
        config.https = None;
        config.mainline = None;
        config.metrics = Some(MetricsConfig::disabled());
        let http = config.http.as_mut().expect("the default enables HTTP");
        http.port = 0;
        http.bind_addr = Some(IpAddr::V4(Ipv4Addr::LOCALHOST));
        config.dns.port = 0;
        config.dns.bind_addr = Some(IpAddr::V4(Ipv4Addr::LOCALHOST));

        let server = Server::bind(config)
            .await
            .expect("an iroh-dns-server on a free port");
        let address = server.http_addr().expect("HTTP is enabled");
        Self {
            relay: format!("http://{address}/pkarr"),
            server,
            _store: store,
        }
    }

    fn discovery(&self) -> Discovery {
        Discovery::with_server(&self.relay).expect("the local server is a usable URL")
    }

    async fn stop(self) {
        self.server.shutdown().await.expect("clean shutdown");
    }
}

/// PUBLISH → RESOLVE → THE SAME RECORD (#1029 §0). Every resolve in
/// `discovery` is `NetworkOnly`, so this answer came off the server and not out
/// of the publishing client's own cache.
#[tokio::test]
async fn a_record_published_to_a_local_iroh_dns_server_resolves_back() {
    let dns = LocalDnsServer::start().await;
    let discovery = dns.discovery();

    let seed = RecoveryPhrase::parse(PHRASE).expect("parses").seed();
    let keys = VaultMint::fresh().mint(&seed, 0).expect("vault 0");
    let device = DeviceKey::generate().expect("OS entropy");
    let published = IdentityRecord::new(
        LAPTOP_ENDPOINT,
        DeviceCertificate::issue(&keys.identity, &device.public(), Epoch::new(2)),
    )
    .with_gateway(GatewayUrl::parse(GATEWAY).expect("a gateway URL"));

    discovery
        .publish_identity(&published, &keys.identity)
        .await
        .expect("the server accepts the record");

    let resolved = discovery
        .resolve_identity(&keys.identity.public())
        .await
        .expect("the server gives it back");

    assert_eq!(resolved, published);
    // WHAT A RESTORING PHONE READS OFF THIS: the laptop's endpoint id, which
    // it dials under `centraid-gateway/1` (#1029 §5, W17).
    assert_eq!(resolved.endpoint(), &LAPTOP_ENDPOINT);
    assert_eq!(resolved.gateway().map(|url| url.as_str()), Some(GATEWAY));

    // What a contact does with it: the certificate that came off the wire is
    // the one that decides which phone holds the vault.
    let mut trust = DeviceTrust::new(keys.identity.public());
    trust.accept(resolved.certificate()).expect("genuine");
    assert_eq!(trust.trusted_device(), Some(&device.public()));

    dns.stop().await;
}

/// THE TYPED-URL FALLBACK YIELDS THE SAME TYPED RESULT (#1029 §0). Same
/// function, same `Located`; only `source()` differs, and it differs because
/// the person is the reason this URL is being used.
#[tokio::test]
async fn the_typed_url_fallback_answers_where_resolution_could_not() {
    let dns = LocalDnsServer::start().await;
    let discovery = dns.discovery();

    let seed = RecoveryPhrase::parse(PHRASE).expect("parses").seed();
    let identity = VaultMint::fresh()
        .mint(&seed, 0)
        .expect("vault 0")
        .identity
        .public();

    // Nothing has been published for this vault.
    let unreachable = discovery
        .locate_vault(&identity, &ResolutionSource::Published)
        .await
        .expect_err("no record was published");
    assert!(
        matches!(unreachable, DiscoveryError::Unreachable { .. }),
        "a server with no such record must say unreachable, never unknown: {unreachable:?}"
    );

    let typed = GatewayUrl::parse(GATEWAY).expect("a gateway URL");
    let located = discovery
        .locate_vault(&identity, &ResolutionSource::Typed(typed.clone()))
        .await
        .expect("the typed source proceeds");

    assert_eq!(located.key(), &identity);
    assert_eq!(located.gateway(), Some(&typed));
    assert_eq!(
        located.endpoint(),
        None,
        "somebody typing a URL is naming a host, not an endpoint id"
    );
    assert_eq!(located.source(), SourceUsed::Typed);

    dns.stop().await;
}

/// A RESTORE REPUBLISHES AT `epoch + 1`, AND THAT IS WHAT THE SERVER THEN
/// SERVES (#1029 §0, F3). The old phone's certificate is still genuine; the
/// resolved record is the new one, and `DeviceTrust` refuses the old.
#[tokio::test]
async fn republishing_after_a_restore_serves_the_higher_epoch() {
    let dns = LocalDnsServer::start().await;
    let discovery = dns.discovery();

    let seed = RecoveryPhrase::parse(PHRASE).expect("parses").seed();
    let keys = VaultMint::fresh().mint(&seed, 0).expect("vault 0");
    let old_phone = DeviceKey::generate().expect("OS entropy");
    let old = DeviceCertificate::issue(&keys.identity, &old_phone.public(), Epoch::new(7));
    discovery
        .publish_identity(&IdentityRecord::new(LAPTOP_ENDPOINT, old), &keys.identity)
        .await
        .expect("the old phone published");

    let new_phone = DeviceKey::generate().expect("OS entropy");
    let reissued =
        DeviceCertificate::issue(&keys.identity, &new_phone.public(), old.epoch().next());
    discovery
        .publish_identity(
            &IdentityRecord::new(LAPTOP_ENDPOINT, reissued),
            &keys.identity,
        )
        .await
        .expect("the restored phone republished");

    let resolved = discovery
        .resolve_identity(&keys.identity.public())
        .await
        .expect("resolves");
    assert_eq!(resolved.certificate().epoch(), Epoch::new(8));
    assert_eq!(resolved.certificate().device(), &new_phone.public());

    let mut contact = DeviceTrust::new(keys.identity.public());
    contact.accept(resolved.certificate()).expect("the restore");
    assert!(
        contact.accept(&old).is_err(),
        "a contact that has seen the new certificate must refuse the old phone"
    );

    dns.stop().await;
}
