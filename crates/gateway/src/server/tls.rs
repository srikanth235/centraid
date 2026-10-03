//! THE GATEWAY'S IDENTITY: ITS CERTIFICATE AND ITS ID (#1080).
//!
//! At its first `serve` a gateway mints three files together in its data
//! directory, each mode 0600, and reads them back on every later start:
//!
//! | File | What |
//! | --- | --- |
//! | `tls.key` | the private key, PKCS#8 PEM |
//! | `tls.crt` | the self-signed certificate, PEM |
//! | `gateway.id` | 16 random bytes as hex: the id every claim is signed to |
//!
//! The phone pins `blake3(certificate DER)` from the pairing QR, so a gateway
//! that minted afresh would be one every paired phone refuses. A partial set
//! is refused rather than completed, for the same reason: completing it is
//! minting a second identity over half of the first.
//!
//! # WHY ECDSA P-256 AND NOT ED25519
//!
//! Apple's TLS stack — what drives the iPhone's background `URLSession`, the
//! only mover iOS runs while the app is suspended — does not accept an Ed25519
//! server certificate, so every first contact from an iPhone would fail at the
//! handshake whatever the pin said. The key is ECDSA P-256,
//! `rcgen::KeyPair::generate`'s algorithm, which every phone's stack accepts;
//! `tests/tls.rs` parses a minted certificate and fails on any other curve.
//!
//! # THE PIN IS THE TRUST, NOT THE DATES OR THE NAME
//!
//! No authority signs this certificate and no client checks its name: the
//! phone compares bytes. The SAN carries the gateway id and `localhost` so a
//! stack that insists on a name finds one; the validity runs from the start of
//! the year before minting to at least ten years after it, because an expiry
//! would make every paired phone re-pair for no reason a member could act on.
//! The Subject Key Identifier is BLAKE3 of the public key, so every identifier
//! this crate derives from the certificate is BLAKE3 (ONE HASH).
//!
//! # TLS 1.3 AND 1.2, `http/1.1` ONLY
//!
//! Both versions, through `ring`: an older phone's stack may offer only 1.2.
//! ALPN offers `http/1.1` alone, so a stack that would try HTTP/2 does not.

use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use rcgen::PublicKeyData as _;
use tokio_rustls::rustls::ServerConfig;
use tokio_rustls::rustls::pki_types::pem::PemObject as _;
use tokio_rustls::rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
use tokio_rustls::rustls::version::{TLS12, TLS13};

use crate::rules::ids::{GatewayId, Pin};

/// The private key file.
pub const KEY_FILE: &str = "tls.key";
/// The certificate file.
pub const CERT_FILE: &str = "tls.crt";
/// The gateway id file.
pub const ID_FILE: &str = "gateway.id";

/// One gateway's identity. Its `Debug` prints no byte of the key.
#[derive(Clone)]
pub struct Identity {
    gateway_id: GatewayId,
    cert_der: Vec<u8>,
    key_der: Vec<u8>,
}

impl core::fmt::Debug for Identity {
    fn fmt(&self, formatter: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        formatter
            .debug_struct("Identity")
            .field("gateway_id", &self.gateway_id)
            .field("pin", &self.pin())
            .finish_non_exhaustive()
    }
}

/// Why an identity could not be loaded or minted.
#[derive(Debug, thiserror::Error)]
pub enum IdentityError {
    #[error(
        "{dir} holds part of a gateway identity ({present}) and not the rest. Refusing to mint \
         a second identity over it: every paired phone pins the certificate this directory \
         minted. Restore the missing files, or remove all three to start over and re-pair"
    )]
    Partial { dir: String, present: String },
    #[error("{0}: {1}")]
    Io(String, std::io::Error),
    #[error("{0} does not parse")]
    Malformed(String),
    #[error("minting the certificate: {0}")]
    Mint(String),
}

impl Identity {
    /// The identity in `data_dir`, minted if the directory has none.
    ///
    /// # Errors
    ///
    /// [`IdentityError`] for a partial or malformed set, or a filesystem error.
    pub fn load_or_mint(
        data_dir: &Path,
        gateway_id: impl FnOnce() -> GatewayId,
    ) -> Result<Self, IdentityError> {
        let files = [KEY_FILE, CERT_FILE, ID_FILE].map(|file| data_dir.join(file));
        let present: Vec<&PathBuf> = files.iter().filter(|path| path.exists()).collect();
        if present.len() == files.len() {
            return Self::load(data_dir);
        }
        if !present.is_empty() {
            return Err(IdentityError::Partial {
                dir: data_dir.display().to_string(),
                present: present
                    .iter()
                    .filter_map(|path| path.file_name())
                    .map(|name| name.to_string_lossy().into_owned())
                    .collect::<Vec<_>>()
                    .join(", "),
            });
        }
        let identity = Self::mint(gateway_id(), unix_seconds())?;
        identity.write(data_dir)?;
        Ok(identity)
    }

    /// Mint a fresh identity in memory. `now_s` places the validity window.
    ///
    /// # Errors
    ///
    /// [`IdentityError::Mint`] if the key or certificate cannot be generated.
    pub fn mint(gateway_id: GatewayId, now_s: i64) -> Result<Self, IdentityError> {
        let mint = |error: rcgen::Error| IdentityError::Mint(error.to_string());
        let key = rcgen::KeyPair::generate().map_err(mint)?;
        let mut params =
            rcgen::CertificateParams::new(vec![gateway_id.hex(), "localhost".to_owned()])
                .map_err(mint)?;
        let mut name = rcgen::DistinguishedName::new();
        name.push(
            rcgen::DnType::CommonName,
            format!("centraid gateway {gateway_id}"),
        );
        params.distinguished_name = name;
        // The average Gregorian year is 31,556,952 s; the year before the one
        // this lands in is safely in the past whatever the day.
        let year = i32::try_from(1970 + now_s / 31_556_952).unwrap_or(2026);
        params.not_before = rcgen::date_time_ymd(year - 1, 1, 1);
        params.not_after = rcgen::date_time_ymd(year + 11, 1, 1);
        params.extended_key_usages = vec![rcgen::ExtendedKeyUsagePurpose::ServerAuth];
        params.key_usages = vec![rcgen::KeyUsagePurpose::DigitalSignature];
        params.key_identifier_method = rcgen::KeyIdMethod::PreSpecified(
            blake3::hash(key.der_bytes()).as_bytes()[..20].to_vec(),
        );
        let certificate = params.self_signed(&key).map_err(mint)?;
        Ok(Self {
            gateway_id,
            cert_der: certificate.der().to_vec(),
            key_der: key.serialize_der(),
        })
    }

    /// The certificate `data_dir` holds, DER, without minting one: what
    /// `health` trusts when it dials its own gateway.
    ///
    /// # Errors
    ///
    /// [`IdentityError`] when there is no readable certificate.
    pub fn read_certificate(data_dir: &Path) -> Result<Vec<u8>, IdentityError> {
        let path = data_dir.join(CERT_FILE);
        let bytes = std::fs::read(&path)
            .map_err(|error| IdentityError::Io(path.display().to_string(), error))?;
        CertificateDer::from_pem_slice(&bytes)
            .map(|der| der.to_vec())
            .map_err(|_| IdentityError::Malformed(CERT_FILE.to_owned()))
    }

    fn load(data_dir: &Path) -> Result<Self, IdentityError> {
        let read = |file: &str| {
            let path = data_dir.join(file);
            std::fs::read(&path)
                .map_err(|error| IdentityError::Io(path.display().to_string(), error))
        };
        let cert = CertificateDer::from_pem_slice(&read(CERT_FILE)?)
            .map_err(|_| IdentityError::Malformed(CERT_FILE.to_owned()))?;
        let key = PrivatePkcs8KeyDer::from_pem_slice(&read(KEY_FILE)?)
            .map_err(|_| IdentityError::Malformed(KEY_FILE.to_owned()))?;
        let id = String::from_utf8(read(ID_FILE)?)
            .ok()
            .and_then(|text| text.trim().parse::<GatewayId>().ok())
            .ok_or_else(|| IdentityError::Malformed(ID_FILE.to_owned()))?;
        Ok(Self {
            gateway_id: id,
            cert_der: cert.to_vec(),
            key_der: key.secret_pkcs8_der().to_vec(),
        })
    }

    fn write(&self, data_dir: &Path) -> Result<(), IdentityError> {
        std::fs::create_dir_all(data_dir)
            .map_err(|error| IdentityError::Io(data_dir.display().to_string(), error))?;
        let key_pem = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(self.key_der.clone()));
        let key_text = pem(
            "PRIVATE KEY",
            match &key_pem {
                PrivateKeyDer::Pkcs8(key) => key.secret_pkcs8_der(),
                _ => &[],
            },
        );
        // Key first, id last: a crash between leaves a partial set, which
        // `load_or_mint` refuses with a sentence saying what to do.
        write_private(data_dir, KEY_FILE, key_text.as_bytes())?;
        write_private(
            data_dir,
            CERT_FILE,
            pem("CERTIFICATE", &self.cert_der).as_bytes(),
        )?;
        write_private(
            data_dir,
            ID_FILE,
            format!("{}\n", self.gateway_id).as_bytes(),
        )
    }

    /// The gateway id.
    #[must_use]
    pub const fn gateway_id(&self) -> GatewayId {
        self.gateway_id
    }

    /// The end-entity certificate, DER.
    #[must_use]
    pub fn cert_der(&self) -> &[u8] {
        &self.cert_der
    }

    /// What the pairing QR carries: BLAKE3 of the certificate DER.
    #[must_use]
    pub fn pin(&self) -> Pin {
        Pin::of(&self.cert_der)
    }

    /// The TLS configuration this gateway serves with.
    ///
    /// # Errors
    ///
    /// A rustls error if the key and certificate do not form a usable pair.
    pub fn server_config(&self) -> Result<Arc<ServerConfig>, tokio_rustls::rustls::Error> {
        let mut config = ServerConfig::builder_with_provider(crate::client::tls::provider())
            .with_protocol_versions(&[&TLS13, &TLS12])?
            .with_no_client_auth()
            .with_single_cert(
                vec![CertificateDer::from(self.cert_der.clone())],
                PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(self.key_der.clone())),
            )?;
        config.alpn_protocols = vec![b"http/1.1".to_vec()];
        Ok(Arc::new(config))
    }
}

fn unix_seconds() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| {
            i64::try_from(elapsed.as_secs()).unwrap_or(i64::MAX)
        })
}

/// PEM, 64 base64 characters a line.
fn pem(label: &str, der: &[u8]) -> String {
    use std::fmt::Write as _;
    let encoded = base64_standard(der);
    let mut out = format!("-----BEGIN {label}-----\n");
    for line in encoded.as_bytes().chunks(64) {
        let _ = writeln!(out, "{}", String::from_utf8_lossy(line));
    }
    let _ = writeln!(out, "-----END {label}-----");
    out
}

/// RFC 4648 base64 with padding. Twenty lines rather than a dependency for
/// two files written once in a gateway's life.
fn base64_standard(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let triple = (u32::from(chunk[0]) << 16)
            | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8)
            | u32::from(*chunk.get(2).unwrap_or(&0));
        for (index, shift) in [18_u32, 12, 6, 0].into_iter().enumerate() {
            if index <= chunk.len() {
                out.push(char::from(ALPHABET[((triple >> shift) & 0x3f) as usize]));
            } else {
                out.push('=');
            }
        }
    }
    out
}

/// Write a file readable only by its owner, whole or not at all.
fn write_private(dir: &Path, file: &str, bytes: &[u8]) -> Result<(), IdentityError> {
    let path = dir.join(file);
    let staged = dir.join(format!("{file}.tmp"));
    let io = |error| IdentityError::Io(path.display().to_string(), error);
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.mode(0o600);
    }
    let mut handle = options.open(&staged).map_err(io)?;
    handle.write_all(bytes).map_err(io)?;
    handle.sync_all().map_err(io)?;
    std::fs::rename(&staged, &path).map_err(io)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_matches_rfc_4648() {
        for (input, expected) in [
            (&b""[..], ""),
            (b"f", "Zg=="),
            (b"fo", "Zm8="),
            (b"foo", "Zm9v"),
            (b"foob", "Zm9vYg=="),
            (b"fooba", "Zm9vYmE="),
            (b"foobar", "Zm9vYmFy"),
        ] {
            assert_eq!(base64_standard(input), expected);
        }
    }

    /// The identity is minted once and read back unchanged: the pin a phone
    /// scanned is this gateway's tomorrow too.
    #[test]
    fn an_identity_is_minted_once_and_read_back() {
        let dir = tempfile::tempdir().expect("a temp dir");
        let first =
            Identity::load_or_mint(dir.path(), || GatewayId::from_bytes([7; 16])).expect("minted");
        let second = Identity::load_or_mint(dir.path(), || GatewayId::from_bytes([8; 16]))
            .expect("read back");
        assert_eq!(first.gateway_id(), second.gateway_id());
        assert_eq!(first.pin(), second.pin());
        assert_eq!(first.cert_der(), second.cert_der());
        second.server_config().expect("the pair serves");
    }

    /// A partial identity is refused, never completed.
    #[test]
    fn a_partial_identity_is_refused() {
        let dir = tempfile::tempdir().expect("a temp dir");
        Identity::load_or_mint(dir.path(), || GatewayId::from_bytes([7; 16])).expect("minted");
        std::fs::remove_file(dir.path().join(ID_FILE)).expect("removed");
        let error = Identity::load_or_mint(dir.path(), || GatewayId::from_bytes([8; 16]))
            .expect_err("refused");
        assert!(matches!(error, IdentityError::Partial { .. }), "{error}");
        assert!(
            !dir.path().join(ID_FILE).exists(),
            "nothing was minted over it"
        );
    }

    #[cfg(unix)]
    #[test]
    fn the_identity_files_are_readable_only_by_their_owner() {
        use std::os::unix::fs::PermissionsExt as _;
        let dir = tempfile::tempdir().expect("a temp dir");
        Identity::load_or_mint(dir.path(), || GatewayId::from_bytes([7; 16])).expect("minted");
        for file in [KEY_FILE, CERT_FILE, ID_FILE] {
            let mode = std::fs::metadata(dir.path().join(file))
                .expect("present")
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600, "{file}: {mode:o}");
        }
    }
}
