//! The certificate a gateway mints, and the pin a phone holds it to (#1080).
//!
//! Four claims, each with its red half: the key is ECDSA P-256 and never
//! Ed25519 (Apple's stack refuses Ed25519 server certificates); both TLS 1.2
//! and 1.3 complete; a client pinned to another certificate is refused; and a
//! server presenting the pinned certificate without its private key is
//! refused, because the handshake signature is checked and not only the
//! bytes. The last runs over an in-memory stream: no test opens a listener.

use std::sync::Arc;

use centraid_gateway::client::tls::{
    Trust, client_config, client_config_for, is_untrusted, provider,
};
use centraid_gateway::client::{Client, ClientError};
use centraid_gateway::rules::ids::{GatewayId, Pin};
use centraid_gateway::server::harness::spawn;
use centraid_gateway::server::tls::Identity;
use tokio_rustls::rustls::pki_types::{
    CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer, ServerName,
};
use tokio_rustls::rustls::server::{ClientHello, ResolvesServerCert};
use tokio_rustls::rustls::sign::CertifiedKey;
use tokio_rustls::rustls::version::{TLS12, TLS13};
use tokio_rustls::rustls::{ProtocolVersion, ServerConfig};
use tokio_rustls::{TlsAcceptor, TlsConnector};
use x509_parser::extensions::GeneralName;
use x509_parser::oid_registry::{OID_EC_P256, OID_KEY_TYPE_EC_PUBLIC_KEY};

const YEAR_S: i64 = 31_556_952;

/// THE KEY IS P-256. Parsed with a real X.509 parser: the subject public key
/// is an EC key on prime256v1, the SAN names the gateway id and `localhost`,
/// the certificate serves TLS servers, and it is good for ten years.
#[test]
fn a_minted_certificate_is_p256_and_names_the_gateway() {
    let gateway = GatewayId::from_bytes([0x5c; 16]);
    let now_s = 1_790_000_000;
    let identity = Identity::mint(gateway, now_s).expect("minted");
    let (_, certificate) =
        x509_parser::parse_x509_certificate(identity.cert_der()).expect("a certificate");

    let key = certificate.public_key();
    assert_eq!(
        key.algorithm.algorithm, OID_KEY_TYPE_EC_PUBLIC_KEY,
        "an EC key"
    );
    let curve = key
        .algorithm
        .parameters
        .as_ref()
        .and_then(|parameters| parameters.as_oid().ok())
        .expect("the curve is named");
    assert_eq!(curve, OID_EC_P256, "the curve is P-256 and nothing else");

    let names: Vec<String> = certificate
        .subject_alternative_name()
        .expect("well-formed")
        .expect("present")
        .value
        .general_names
        .iter()
        .filter_map(|name| match name {
            GeneralName::DNSName(dns) => Some((*dns).to_owned()),
            _ => None,
        })
        .collect();
    assert_eq!(names, vec![gateway.hex(), "localhost".to_owned()]);

    let usage = certificate
        .extended_key_usage()
        .expect("well-formed")
        .expect("present");
    assert!(usage.value.server_auth, "a server certificate");

    let validity = certificate.validity();
    assert!(
        validity.not_before.timestamp() <= now_s,
        "valid from before it was minted"
    );
    assert!(
        validity.not_after.timestamp() >= now_s + 10 * YEAR_S,
        "good for ten years: the pin is the trust, not the dates"
    );
    assert_eq!(identity.pin(), Pin::of(identity.cert_der()));
}

fn pinned(
    trust: Trust,
    version: &'static tokio_rustls::rustls::SupportedProtocolVersion,
) -> Arc<tokio_rustls::rustls::ClientConfig> {
    client_config_for(trust, &[version])
}

/// BOTH VERSIONS COMPLETE against a real gateway: a phone whose stack offers
/// only TLS 1.2 is served, and so is one offering only 1.3.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_gateway_completes_tls_1_2_and_tls_1_3() {
    let dir = tempfile::tempdir().expect("a temp dir");
    let gateway = spawn(dir.path()).await.expect("spawned");
    for (version, expected) in [
        (&TLS12, ProtocolVersion::TLSv1_2),
        (&TLS13, ProtocolVersion::TLSv1_3),
    ] {
        let socket = tokio::net::TcpStream::connect(gateway.addr)
            .await
            .expect("connects");
        let connector = TlsConnector::from(pinned(
            Trust::Certificate(gateway.cert_der.clone()),
            version,
        ));
        let stream = connector
            .connect(ServerName::try_from("localhost").expect("a name"), socket)
            .await
            .unwrap_or_else(|error| panic!("{expected:?} did not complete: {error}"));
        assert_eq!(stream.get_ref().1.protocol_version(), Some(expected));
        assert_eq!(
            stream.get_ref().1.alpn_protocol(),
            Some(&b"http/1.1"[..]),
            "HTTP/1.1 and nothing else"
        );
    }
    gateway.shutdown().await;
}

/// THE PIN DECIDES. The right pin connects and hands back the certificate's
/// bytes to keep; a wrong one is `Untrusted`, not "unreachable".
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_client_trusts_its_pin_and_refuses_any_other() {
    let dir = tempfile::tempdir().expect("a temp dir");
    let gateway = spawn(dir.path()).await.expect("spawned");
    let right = Client::first_contact(vec![gateway.addr.to_string()], gateway.pin);
    let info = right.info().await.expect("the pinned gateway answers");
    assert_eq!(info.gateway_id, gateway.gateway_id);
    assert_eq!(
        right.cert_der(),
        Some(gateway.cert_der.clone()),
        "kept for later"
    );

    let wrong = Client::first_contact(vec![gateway.addr.to_string()], Pin::from_bytes([0x11; 32]));
    assert!(
        matches!(wrong.info().await, Err(ClientError::Untrusted)),
        "a certificate that is not the pinned one must be refused as untrusted"
    );

    // Every address tried, the untrusted one reported over the dead one.
    let dead = "127.0.0.1:9".to_owned();
    let both = Client::first_contact(vec![dead.clone(), gateway.addr.to_string()], gateway.pin);
    both.info().await.expect("the second address answers");
    let none = Client::first_contact(vec![dead], gateway.pin);
    assert!(matches!(
        none.info().await,
        Err(ClientError::Unreachable(_))
    ));
    gateway.shutdown().await;
}

/// Serves one certified key, whatever the client asks for.
#[derive(Debug)]
struct Fixed(Arc<CertifiedKey>);

impl ResolvesServerCert for Fixed {
    fn resolve(&self, _hello: ClientHello<'_>) -> Option<Arc<CertifiedKey>> {
        Some(Arc::clone(&self.0))
    }
}

/// THE BYTES ARE NOT ENOUGH. A machine that copied the gateway's certificate
/// — it is public — and serves it with its own key fails the handshake
/// signature, and the client reports it untrusted.
#[tokio::test]
async fn the_pinned_certificate_without_its_key_is_refused() {
    let real = Identity::mint(GatewayId::from_bytes([1; 16]), 1_790_000_000).expect("minted");
    let impostor_key = rcgen::KeyPair::generate().expect("a key");
    let signing = provider()
        .key_provider
        .load_private_key(PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(
            impostor_key.serialize_der(),
        )))
        .expect("loads");
    let certified = CertifiedKey::new(
        vec![CertificateDer::from(real.cert_der().to_vec())],
        signing,
    );
    let server = ServerConfig::builder_with_provider(provider())
        .with_protocol_versions(&[&TLS13, &TLS12])
        .expect("ring offers both")
        .with_no_client_auth()
        .with_cert_resolver(Arc::new(Fixed(Arc::new(certified))));

    for version in [&TLS13, &TLS12] {
        let (client_side, server_side) = tokio::io::duplex(64 * 1024);
        let acceptor = TlsAcceptor::from(Arc::new(server.clone()));
        let serving = tokio::spawn(async move { acceptor.accept(server_side).await });
        let connector = TlsConnector::from(pinned(
            Trust::Certificate(real.cert_der().to_vec()),
            version,
        ));
        let outcome = connector
            .connect(
                ServerName::try_from("localhost").expect("a name"),
                client_side,
            )
            .await;
        let error = outcome.expect_err("an impostor must not complete the handshake");
        assert!(is_untrusted(&error), "{version:?}: {error}");
        let _ = serving.await;
    }

    // And the real key, through the same path, completes: the refusal above
    // is the key, not the harness.
    let (client_side, server_side) = tokio::io::duplex(64 * 1024);
    let acceptor = TlsAcceptor::from(real.server_config().expect("serves"));
    let serving = tokio::spawn(async move { acceptor.accept(server_side).await });
    let connector = TlsConnector::from(client_config(Trust::Certificate(real.cert_der().to_vec())));
    connector
        .connect(
            ServerName::try_from("localhost").expect("a name"),
            client_side,
        )
        .await
        .expect("the real key completes");
    let _ = serving.await;
}
