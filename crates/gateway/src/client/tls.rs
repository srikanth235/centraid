//! THE PIN, AS A CERTIFICATE VERIFIER (#1080).
//!
//! The phone trusts exactly one end-entity certificate and nothing else: no
//! authority, no chain, no name, no dates. On first contact it is the
//! certificate whose BLAKE3 is the pin the QR carried; from then on it is the
//! certificate's exact bytes, which the caller stored. Anything else fails
//! the handshake with `InvalidCertificate`, which the client reports as
//! [`crate::client::ClientError::Untrusted`] — a different gateway, or a
//! machine in between, never a gateway that is merely down.
//!
//! # THE HANDSHAKE SIGNATURE IS STILL CHECKED
//!
//! Matching the certificate's bytes proves nothing on its own: a certificate
//! is public, and anyone can present it. The TLS 1.2 and 1.3 handshake
//! signatures are verified against that certificate's key with the
//! provider's own algorithms, so only the holder of the gateway's private key
//! completes a handshake. `tests/tls.rs` serves the pinned certificate with
//! another key and is refused.

use std::sync::Arc;

use tokio_rustls::rustls::client::danger::{
    HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier,
};
use tokio_rustls::rustls::crypto::{
    CryptoProvider, WebPkiSupportedAlgorithms, verify_tls12_signature, verify_tls13_signature,
};
use tokio_rustls::rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use tokio_rustls::rustls::version::{TLS12, TLS13};
use tokio_rustls::rustls::{
    CertificateError, ClientConfig, DigitallySignedStruct, Error, SignatureScheme,
    SupportedProtocolVersion,
};

use crate::rules::ids::Pin;

/// The crypto provider both ends use: `ring`, which the workspace's rustls
/// already links. Named explicitly so a second provider elsewhere in a build
/// cannot leave the choice to a process-wide default.
#[must_use]
pub fn provider() -> Arc<CryptoProvider> {
    Arc::new(tokio_rustls::rustls::crypto::ring::default_provider())
}

/// Which one certificate a client trusts.
#[derive(Clone, PartialEq, Eq)]
pub enum Trust {
    /// First contact: the certificate whose BLAKE3 this is.
    Pin(Pin),
    /// Every contact after: exactly these DER bytes.
    Certificate(Vec<u8>),
}

impl core::fmt::Debug for Trust {
    fn fmt(&self, formatter: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            Self::Pin(pin) => write!(formatter, "Trust::Pin({pin})"),
            Self::Certificate(der) => write!(formatter, "Trust::Certificate({})", Pin::of(der)),
        }
    }
}

impl Trust {
    /// Is this the certificate?
    #[must_use]
    pub fn admits(&self, certificate_der: &[u8]) -> bool {
        match self {
            Self::Pin(pin) => Pin::of(certificate_der) == *pin,
            Self::Certificate(der) => der.as_slice() == certificate_der,
        }
    }
}

/// The verifier. See the module header.
#[derive(Debug)]
pub struct PinnedVerifier {
    trust: Trust,
    algorithms: WebPkiSupportedAlgorithms,
}

impl ServerCertVerifier for PinnedVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, Error> {
        // EXACTLY ONE CERTIFICATE: a chain is something to be talked into.
        if !intermediates.is_empty() || !self.trust.admits(end_entity.as_ref()) {
            return Err(Error::InvalidCertificate(
                CertificateError::ApplicationVerificationFailure,
            ));
        }
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, Error> {
        verify_tls12_signature(message, cert, dss, &self.algorithms)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, Error> {
        verify_tls13_signature(message, cert, dss, &self.algorithms)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.algorithms.supported_schemes()
    }
}

/// The TLS configuration for a client that trusts `trust` and nothing else:
/// TLS 1.3 and 1.2, ALPN `http/1.1`.
#[must_use]
pub fn client_config(trust: Trust) -> Arc<ClientConfig> {
    client_config_for(trust, &[&TLS13, &TLS12])
}

/// [`client_config`] restricted to `versions`: what a test uses to prove each
/// version completes on its own.
///
/// # Panics
///
/// If `versions` is empty: the `ring` provider offers TLS 1.2 and 1.3.
#[must_use]
pub fn client_config_for(
    trust: Trust,
    versions: &[&'static SupportedProtocolVersion],
) -> Arc<ClientConfig> {
    let provider = provider();
    let verifier = PinnedVerifier {
        trust,
        algorithms: provider.signature_verification_algorithms,
    };
    let mut config = ClientConfig::builder_with_provider(provider)
        .with_protocol_versions(versions)
        .expect("the ring provider offers TLS 1.2 and 1.3")
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(verifier))
        .with_no_client_auth();
    config.alpn_protocols = vec![b"http/1.1".to_vec()];
    Arc::new(config)
}

/// Did a handshake fail because the certificate was not the trusted one, or
/// its holder could not sign for it?
#[must_use]
pub fn is_untrusted(error: &std::io::Error) -> bool {
    error
        .get_ref()
        .and_then(|inner| inner.downcast_ref::<Error>())
        .is_some_and(|error| matches!(error, Error::InvalidCertificate(_)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_pin_admits_its_certificate_and_nothing_else() {
        let der = b"a certificate".to_vec();
        assert!(Trust::Pin(Pin::of(&der)).admits(&der));
        assert!(!Trust::Pin(Pin::of(&der)).admits(b"another certificate"));
        assert!(Trust::Certificate(der.clone()).admits(&der));
        assert!(!Trust::Certificate(der).admits(b"a certificatf"));
    }

    #[test]
    fn an_invalid_certificate_reads_as_untrusted_and_nothing_else_does() {
        let untrusted = std::io::Error::other(Error::InvalidCertificate(
            CertificateError::ApplicationVerificationFailure,
        ));
        assert!(is_untrusted(&untrusted));
        assert!(!is_untrusted(&std::io::Error::from(
            std::io::ErrorKind::ConnectionRefused
        )));
    }
}
