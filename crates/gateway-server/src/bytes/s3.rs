//! An S3-compatible bucket as the object store (#1029 §3).
//!
//! MinIO, Backblaze B2, Wasabi, Garage, Ceph, or R2 through its S3 endpoint.
//! The API is somebody else's and this module speaks it; every rule about what
//! the answers *mean* is `centraid-gateway-core`'s.
//!
//! # WHY READ-AND-HASH EXISTS, IN ONE SENTENCE PER STORE
//!
//! **B2 and MinIO do not attest the same checksum headers.** B2's S3 layer
//! returns [`sigv4::CHECKSUM_HEADER`] only for objects uploaded with it; a
//! MinIO configured without checksum support returns none at all; R2 records
//! it only when the client sent it. A gateway that trusted the attestation
//! blindly would accept an object it had verified nothing about, and a gateway
//! that refused every store without one would refuse half the stores a
//! self-hoster owns. So the mode is **configuration**, the store answers
//! honestly in the mode it was given, and the conformance suite runs both.
//!
//! # BYTES ARE PROXIED BY DEFAULT
//!
//! See [`crate::bytes`]. A self-hoster's bucket is usually not reachable from
//! a phone on cellular, so the upload target is a path on this server unless
//! `presign` was turned on. Presigning is real when it is on: the URL is signed
//! with the same [`sigv4`] chain and expires within SigV4's seven-day cap.

use centraid_gateway_core::checksum::{AttestedChecksum, ChecksumEvidence, ChecksumMode};
use centraid_gateway_core::ids::{ObjectName, VaultId};
use centraid_gateway_core::store::{ByteStore, StoreFault, UploadTarget};
use centraid_gateway_core::time::ServerTime;

use crate::bytes::fs::TARGET_LIFETIME;
use crate::bytes::object_key;
use crate::bytes::sigv4::{self, CanonicalRequest, Credentials};

/// How to reach one bucket.
#[derive(Debug, Clone)]
pub struct S3Config {
    /// `https://s3.eu-central-003.backblazeb2.com`, `http://minio.lan:9000`.
    pub endpoint: String,
    pub bucket: String,
    pub credentials: Credentials,
    /// `true` for a store that puts the bucket in the host name rather than the
    /// path. MinIO and Garage default to path style; AWS to virtual-hosted.
    pub virtual_host_style: bool,
    pub checksum_mode: ChecksumMode,
    /// **Off by default.** See the module docs: a self-hoster's bucket is
    /// usually unreachable from the phone, and a presigned URL for a host that
    /// does not resolve is a transfer that hangs.
    pub presign: bool,
    /// The origin a proxied upload target is built on.
    pub origin: String,
}

/// A bucket.
#[derive(Debug)]
pub struct S3Bytes {
    config: S3Config,
    client: reqwest::Client,
}

impl S3Bytes {
    /// Point the store at a bucket.
    ///
    /// # Errors
    ///
    /// A store fault if the HTTP client cannot be built.
    pub fn new(config: S3Config) -> Result<Self, StoreFault> {
        let client = reqwest::Client::builder()
            .build()
            .map_err(|error| StoreFault::new(error.to_string()))?;
        Ok(Self { config, client })
    }

    /// The origin and path this key lives at, and the `Host` header for it.
    fn locate(&self, key: &str) -> (String, String, String) {
        let endpoint = self.config.endpoint.trim_end_matches('/');
        let without_scheme = endpoint
            .split_once("://")
            .map_or(endpoint, |(_, rest)| rest);
        if self.config.virtual_host_style {
            let scheme = endpoint.split_once("://").map_or("https", |(head, _)| head);
            let host = format!("{}.{without_scheme}", self.config.bucket);
            let path = sigv4::encode_path(&format!("/{key}"));
            (format!("{scheme}://{host}"), path, host)
        } else {
            let path = sigv4::encode_path(&format!("/{}/{key}", self.config.bucket));
            (endpoint.to_owned(), path, without_scheme.to_owned())
        }
    }

    fn timestamp(now: ServerTime) -> String {
        let seconds = now.millis().div_euclid(1_000);
        let moment = time::OffsetDateTime::from_unix_timestamp(seconds)
            .unwrap_or(time::OffsetDateTime::UNIX_EPOCH);
        let format =
            time::macros::format_description!("[year][month][day]T[hour][minute][second]Z");
        moment
            .format(&format)
            .unwrap_or_else(|_| "19700101T000000Z".to_owned())
    }

    fn signed(
        &self,
        method: &str,
        key: &str,
        payload_digest: &str,
        now: ServerTime,
    ) -> (String, Vec<(String, String)>) {
        let (origin, path, host) = self.locate(key);
        let timestamp = Self::timestamp(now);
        let mut headers = vec![
            ("host".to_owned(), host),
            (
                sigv4::CONTENT_DIGEST_HEADER.to_owned(),
                payload_digest.to_owned(),
            ),
            ("x-amz-date".to_owned(), timestamp.clone()),
        ];
        headers.sort_by(|left, right| left.0.cmp(&right.0));
        let authorization = sigv4::authorization(
            &CanonicalRequest {
                method,
                uri: &path,
                query: "",
                headers: &headers,
                payload_digest,
                timestamp: &timestamp,
            },
            &self.config.credentials,
        );
        headers.push(("authorization".to_owned(), authorization));
        (format!("{origin}{path}"), headers)
    }

    async fn send(
        &self,
        method: reqwest::Method,
        key: &str,
        body: Option<Vec<u8>>,
        attested: bool,
    ) -> Result<reqwest::Response, StoreFault> {
        self.send_asking(method, key, body, attested, false).await
    }

    async fn send_asking(
        &self,
        method: reqwest::Method,
        key: &str,
        body: Option<Vec<u8>>,
        attested: bool,
        ask_for_checksum: bool,
    ) -> Result<reqwest::Response, StoreFault> {
        let payload = body.as_deref().unwrap_or(&[]);
        let digest = sigv4::payload_digest(payload);
        let (url, headers) = self.signed(method.as_str(), key, &digest, crate::clock::now());
        let mut request = self.client.request(method, &url);
        for (name, value) in &headers {
            request = request.header(name.as_str(), value.as_str());
        }
        // THE CHECKSUM HEADER IS SENT ONLY WHEN THE CLIENT ATTESTED, because
        // that is exactly what R2 does and what the rule was written against:
        // an upload without it leaves a store that attests nothing, and the
        // commit must then be refused rather than shrugged at.
        if attested && let Some(bytes) = body.as_deref() {
            request = request.header(
                sigv4::CHECKSUM_HEADER,
                base64_standard(AttestedChecksum::of(bytes).as_bytes()),
            );
        }
        if ask_for_checksum {
            request = request.header(sigv4::CHECKSUM_MODE_HEADER, "ENABLED");
        }
        if let Some(bytes) = body {
            request = request.body(bytes);
        }
        request
            .send()
            .await
            .map_err(|error| StoreFault::new(error.to_string()))
    }

    /// The `PUT` a phone makes to a proxied target, as the server performs it.
    ///
    /// # Errors
    ///
    /// A store fault if the store refuses the write.
    pub async fn put(
        &self,
        vault: &VaultId,
        name: &ObjectName,
        bytes: Vec<u8>,
        attested: bool,
    ) -> Result<(), StoreFault> {
        let key = object_key(vault, name);
        let response = self
            .send(reqwest::Method::PUT, &key, Some(bytes), attested)
            .await?;
        if !response.status().is_success() {
            return Err(StoreFault::new(format!(
                "the object store refused a write: {}",
                response.status()
            )));
        }
        Ok(())
    }

    /// Every object the bucket holds under this server's prefix. The canary's
    /// first window.
    ///
    /// # Errors
    ///
    /// A store fault if the listing or a read fails.
    pub async fn stored(&self, keys: &[String]) -> Result<Vec<Vec<u8>>, StoreFault> {
        let mut out = Vec::new();
        for key in keys {
            let response = self.send(reqwest::Method::GET, key, None, false).await?;
            if response.status().is_success() {
                out.push(
                    response
                        .bytes()
                        .await
                        .map_err(|error| StoreFault::new(error.to_string()))?
                        .to_vec(),
                );
            }
        }
        out.sort();
        Ok(out)
    }

    /// Flip one stored object's first bit, for the scrub's own test.
    ///
    /// # Errors
    ///
    /// A store fault.
    pub async fn corrupt(&self, vault: &VaultId, name: &ObjectName) -> Result<(), StoreFault> {
        let Some(mut bytes) = self.read(vault, name).await? else {
            return Err(StoreFault::new("nothing to corrupt at that name"));
        };
        if let Some(first) = bytes.first_mut() {
            *first ^= 0b0000_0001;
        }
        self.put(vault, name, bytes, true).await
    }
}

/// Standard base64, which is how an S3 store spells a checksum header value.
fn base64_standard(bytes: &[u8]) -> String {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// The store's own `Content-Length`, read from the header.
///
/// **Not `Response::content_length()`**: on a `HEAD` that reports the body the
/// client received, which is zero, and a zero here is a `SizeMismatch` on every
/// commit — a failure whose message names the checksum and not the header that
/// caused it.
fn content_length(response: &reqwest::Response) -> u64 {
    response
        .headers()
        .get(reqwest::header::CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse().ok())
        .unwrap_or_default()
}

fn decode_base64(text: &str) -> Option<Vec<u8>> {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD.decode(text).ok()
}

impl ByteStore for S3Bytes {
    fn checksum_mode(&self) -> ChecksumMode {
        self.config.checksum_mode
    }

    async fn presign_put(
        &self,
        vault: &VaultId,
        name: &ObjectName,
        _padded_size: u64,
        now: ServerTime,
    ) -> Result<UploadTarget, StoreFault> {
        let key = object_key(vault, name);
        if !self.config.presign {
            // THE DEFAULT. A path on this server; the bytes are proxied.
            return Ok(UploadTarget {
                name: *name,
                url: format!(
                    "{}/v1/objects/{key}",
                    self.config.origin.trim_end_matches('/')
                ),
                expires_at: now + TARGET_LIFETIME,
                already_committed: false,
            });
        }

        let (origin, path, host) = self.locate(&key);
        let timestamp = Self::timestamp(now);
        let date = sigv4::scope_date(&timestamp).to_owned();
        let credential = format!(
            "{}%2F{date}%2F{}%2Fs3%2Faws4_request",
            self.config.credentials.access_key_id, self.config.credentials.region
        );
        // SigV4 caps a presigned URL at seven days, which is also
        // `TARGET_LIFETIME` — the two are the same number on purpose, so the
        // two byte stores promise a phone the same window.
        let expires = TARGET_LIFETIME.secs().clamp(1, 604_800);
        let query = format!(
            "X-Amz-Algorithm={}&X-Amz-Credential={credential}\
             &X-Amz-Date={timestamp}&X-Amz-Expires={expires}&X-Amz-SignedHeaders=host",
            sigv4::ALGORITHM
        );
        let headers = vec![("host".to_owned(), host)];
        let signature = sigv4::presigned_signature(
            &CanonicalRequest {
                method: "PUT",
                uri: &path,
                query: &query,
                headers: &headers,
                payload_digest: "UNSIGNED-PAYLOAD",
                timestamp: &timestamp,
            },
            &self.config.credentials,
        );
        Ok(UploadTarget {
            name: *name,
            url: format!("{origin}{path}?{query}&X-Amz-Signature={signature}"),
            expires_at: now + TARGET_LIFETIME,
            already_committed: false,
        })
    }

    async fn evidence(
        &self,
        vault: &VaultId,
        name: &ObjectName,
    ) -> Result<ChecksumEvidence, StoreFault> {
        let key = object_key(vault, name);
        // AN UPLOAD THE CLIENT DID NOT ATTEST IS A REJECTION IN BOTH MODES, and
        // that is a rule rather than this file's preference: R2 records
        // the attestation only when the client sent it, so silence has to be
        // a refusal — `gateway-core`'s conformance suite asserts it under
        // `checksum/no-attestation-is-a-rejection` for `Attest` AND for
        // `ReadAndHash`, and its in-memory adapter answers `None` in both. An
        // adapter that quietly read and hashed an unattested object anyway
        // would accept bytes the hosted adapter refuses, which is the exact
        // divergence the shared suite exists to catch.
        //
        // In read-and-hash mode that means the one request has to carry the
        // attestation back too, which is what `x-amz-checksum-mode: ENABLED`
        // asks for; the alternative is a HEAD before every GET.
        let attesting = self.config.checksum_mode == ChecksumMode::ReadAndHash;
        let response = if attesting {
            self.send_asking(reqwest::Method::GET, &key, None, false, true)
                .await?
        } else {
            self.send(reqwest::Method::HEAD, &key, None, false).await?
        };
        if !response.status().is_success() {
            return Ok(ChecksumEvidence::None);
        }
        let Some(attested) = response
            .headers()
            .get(sigv4::CHECKSUM_HEADER)
            .and_then(|value| value.to_str().ok())
            .and_then(decode_base64)
            .and_then(|bytes| AttestedChecksum::from_slice(&bytes))
        else {
            // THE STORE ATTESTED NOTHING. A rejection, not a shrug.
            return Ok(ChecksumEvidence::None);
        };

        match self.config.checksum_mode {
            // The gateway never read the bytes — the mode the hosted adapter
            // runs in, and running it here is what keeps the two comparable.
            // `content_length()` is not read: on a HEAD it reports the body
            // reqwest received, which is zero. The header is the store's answer.
            ChecksumMode::Attest => Ok(ChecksumEvidence::Attested {
                checksum: attested,
                stored_size: content_length(&response),
            }),
            ChecksumMode::ReadAndHash => {
                let bytes = response
                    .bytes()
                    .await
                    .map_err(|error| StoreFault::new(error.to_string()))?;
                Ok(ChecksumEvidence::ReadAndHashed {
                    checksum: AttestedChecksum::of(&bytes),
                    name: ObjectName::of(&bytes),
                    stored_size: bytes.len() as u64,
                })
            }
        }
    }

    async fn read(
        &self,
        vault: &VaultId,
        name: &ObjectName,
    ) -> Result<Option<Vec<u8>>, StoreFault> {
        let key = object_key(vault, name);
        let response = self.send(reqwest::Method::GET, &key, None, false).await?;
        if response.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if !response.status().is_success() {
            return Err(StoreFault::new(format!(
                "the object store refused a read: {}",
                response.status()
            )));
        }
        Ok(Some(
            response
                .bytes()
                .await
                .map_err(|error| StoreFault::new(error.to_string()))?
                .to_vec(),
        ))
    }

    async fn purge(&mut self, vault: &VaultId, name: &ObjectName) -> Result<(), StoreFault> {
        let key = object_key(vault, name);
        let response = self
            .send(reqwest::Method::DELETE, &key, None, false)
            .await?;
        if response.status().is_success() || response.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(());
        }
        Err(StoreFault::new(format!(
            "the object store refused a purge: {}",
            response.status()
        )))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(virtual_host_style: bool) -> S3Config {
        S3Config {
            endpoint: "http://minio.lan:9000".to_owned(),
            bucket: "vault".to_owned(),
            credentials: Credentials {
                access_key_id: "AKIDEXAMPLE".to_owned(),
                secret_access_key: "secret".to_owned(),
                region: "us-east-1".to_owned(),
            },
            virtual_host_style,
            checksum_mode: ChecksumMode::Attest,
            presign: false,
            origin: "https://vault.example.org".to_owned(),
        }
    }

    /// Path style and virtual-hosted style put the bucket in different places,
    /// and signing the wrong one is a 403 with no useful message.
    #[test]
    fn a_key_locates_in_both_addressing_styles() {
        let path_style = S3Bytes::new(config(false)).expect("client");
        let (origin, path, host) = path_style.locate("aa/bb");
        assert_eq!(origin, "http://minio.lan:9000");
        assert_eq!(path, "/vault/aa/bb");
        assert_eq!(host, "minio.lan:9000");

        let virtual_style = S3Bytes::new(config(true)).expect("client");
        let (origin, path, host) = virtual_style.locate("aa/bb");
        assert_eq!(origin, "http://vault.minio.lan:9000");
        assert_eq!(path, "/aa/bb");
        assert_eq!(host, "vault.minio.lan:9000");
    }

    /// A timestamp is SigV4's own shape. A wrong one is refused by every store
    /// and the message says only "signature mismatch".
    #[test]
    fn a_timestamp_is_the_basic_iso_form_the_signature_requires() {
        let stamp = S3Bytes::timestamp(ServerTime::from_millis(1_440_938_160_000));
        assert_eq!(stamp, "20150830T123600Z");
        assert_eq!(sigv4::scope_date(&stamp), "20150830");
    }
}
