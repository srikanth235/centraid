//! What every test in this crate needs: a harness over the real adapter, and a
//! real S3-compatible store to point half the runs at (#1029 §3).
//!
//! # WHY THERE IS A STORE IN HERE AND NOT A MOCK OF ONE
//!
//! The conformance suite has to run against the **S3 code path** — the SigV4
//! signature, the attestation header, the HEAD that carries one and the GET
//! that does not — or "S3 × attest" is a claim about a code path nothing
//! executed. A mock `ByteStore` would exercise none of that: it would test the
//! enum arm and skip the protocol.
//!
//! Every header name and the algorithm token come from
//! [`centraid_gateway_server::bytes::sigv4`] rather than being spelled here,
//! which is the same boundary the crate keeps for itself (#1025 S4): the
//! store's own checksum is named in ONE module, and a test that respelled it
//! would be a second place for it to drift — and a second place for the
//! allowlist in `crates/vault/tests/one_hash.rs` to have to name.
//!
//! So [`FakeS3`] is a real HTTP server speaking the subset of the S3 API this
//! adapter uses, over a real socket, reached by the real `reqwest` client with a
//! real signature. **It is not MinIO and it does not claim to be**: it verifies
//! the SHAPE of the `Authorization` header rather than recomputing the
//! signature, and it implements four verbs. What it proves is that this
//! adapter's S3 path signs, sends, parses and interprets correctly; what it
//! cannot prove is interoperability with any particular vendor, and the receipt
//! says so rather than leaving it to be discovered.

use std::collections::BTreeMap;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{any, get};
use centraid_gateway_core::Gateway;
use centraid_gateway_core::checksum::ChecksumMode;
use centraid_gateway_core::conformance::Harness;
use centraid_gateway_core::ids::{ObjectName, VaultId};
use centraid_gateway_core::retention::Policy;
use centraid_gateway_core::store::{StoreFault, VaultState};
use centraid_gateway_server::bytes::configured::{Backend, ConfiguredBytes};
use centraid_gateway_server::bytes::fs::FilesystemBytes;
use centraid_gateway_server::bytes::s3::{S3Bytes, S3Config};
use centraid_gateway_server::bytes::sigv4::{self, Credentials};
use centraid_gateway_server::bytes::{ProxyWrite as _, object_key};
use centraid_gateway_server::state::SqliteState;

/// Which store a run is against.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Store {
    Filesystem,
    S3,
}

impl Store {
    pub const fn label(self) -> &'static str {
        match self {
            Self::Filesystem => "filesystem",
            Self::S3 => "s3",
        }
    }
}

pub const fn mode_label(mode: ChecksumMode) -> &'static str {
    match mode {
        ChecksumMode::Attest => "attest",
        ChecksumMode::ReadAndHash => "read-and-hash",
    }
}

// ------------------------------------------------------------- the store ----

type Objects = Arc<Mutex<BTreeMap<String, StoredBlob>>>;

#[derive(Debug, Clone)]
struct StoredBlob {
    bytes: Vec<u8>,
    /// The base64 checksum the client attested, if it sent one.
    ///
    /// **`None` is the case R2 really produces** and the whole reason
    /// `ChecksumEvidence::None` is a rejection: a store records the attestation
    /// only when the client sent the header.
    attested: Option<String>,
}

/// An S3-compatible store, in process, over a real socket.
pub struct FakeS3 {
    pub address: SocketAddr,
    objects: Objects,
}

impl FakeS3 {
    /// Start one on a free port.
    pub async fn start() -> Self {
        let objects: Objects = Arc::new(Mutex::new(BTreeMap::new()));
        let router = Router::new()
            .route("/{bucket}/{*key}", any(object))
            .route("/health", get(|| async { "ok" }))
            .with_state(Arc::clone(&objects));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("a free port for the object store");
        let address = listener.local_addr().expect("the bound address");
        tokio::spawn(async move {
            let _ = axum::serve(listener, router).await;
        });
        Self { address, objects }
    }

    pub fn endpoint(&self) -> String {
        format!("http://{}", self.address)
    }

    /// Throw every object away, so one conformance case cannot pass on another's
    /// leftovers.
    pub fn clear(&self) {
        self.objects.lock().expect("the store lock").clear();
    }
}

/// `PUT`, `GET`, `HEAD` and `DELETE` on one key.
async fn object(
    State(objects): State<Objects>,
    method: axum::http::Method,
    Path((bucket, key)): Path<(String, String)>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    // THE SIGNATURE IS CHECKED FOR SHAPE, NOT RECOMPUTED. Recomputing it here
    // would be this test asserting that the adapter agrees with a second copy of
    // the adapter's own code; `sigv4`'s unit tests pin the chain against AWS's
    // published vectors, which is the check worth having. What this catches is
    // an adapter that forgot to sign at all.
    let signed = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| {
            value.starts_with(&format!("{} Credential=", sigv4::ALGORITHM))
                && value.contains("SignedHeaders=")
                && value.rsplit("Signature=").next().is_some_and(|signature| {
                    signature.len() == 64 && signature.chars().all(|c| c.is_ascii_hexdigit())
                })
        });
    if !signed {
        return (StatusCode::FORBIDDEN, "unsigned").into_response();
    }
    let path = format!("{bucket}/{key}");
    let mut objects = objects.lock().expect("the store lock");

    match method {
        axum::http::Method::PUT => {
            objects.insert(
                path,
                StoredBlob {
                    bytes: body.to_vec(),
                    attested: headers
                        .get(sigv4::CHECKSUM_HEADER)
                        .and_then(|value| value.to_str().ok())
                        .map(str::to_owned),
                },
            );
            StatusCode::OK.into_response()
        }
        axum::http::Method::GET => match objects.get(&path) {
            Some(blob) => {
                let mut response = (StatusCode::OK, blob.bytes.clone()).into_response();
                // S3 returns the attestation on a GET only when the request
                // asked for it, which is the behaviour read-and-hash mode
                // depends on to learn that a client attested nothing.
                if headers
                    .get(sigv4::CHECKSUM_MODE_HEADER)
                    .and_then(|value| value.to_str().ok())
                    .is_some_and(|value| value.eq_ignore_ascii_case("enabled"))
                    && let Some(attested) = &blob.attested
                {
                    response.headers_mut().insert(
                        sigv4::CHECKSUM_HEADER,
                        attested.parse().expect("a base64 checksum"),
                    );
                }
                response
            }
            None => StatusCode::NOT_FOUND.into_response(),
        },
        axum::http::Method::HEAD => match objects.get(&path) {
            Some(blob) => {
                let mut response = StatusCode::OK.into_response();
                let out = response.headers_mut();
                out.insert(
                    header::CONTENT_LENGTH,
                    blob.bytes.len().to_string().parse().expect("a length"),
                );
                if let Some(attested) = &blob.attested {
                    out.insert(
                        sigv4::CHECKSUM_HEADER,
                        attested.parse().expect("a base64 checksum"),
                    );
                }
                response
            }
            None => StatusCode::NOT_FOUND.into_response(),
        },
        axum::http::Method::DELETE => {
            objects.remove(&path);
            StatusCode::NO_CONTENT.into_response()
        }
        _ => StatusCode::METHOD_NOT_ALLOWED.into_response(),
    }
}

// ----------------------------------------------------------- the harness ----

/// The real adapter, driven by `gateway-core`'s own suite.
pub struct ServerHarness {
    pub gateway: Gateway<SqliteState, ConfiguredBytes>,
    /// Kept alive for the life of the harness: dropping it removes the object
    /// directory out from under the store.
    pub objects_dir: tempfile::TempDir,
    pub store: Store,
    pub s3: Option<Arc<FakeS3>>,
    /// Every key this harness has uploaded, so the canary can read an S3 bucket
    /// back — a bucket cannot be walked the way a directory can.
    pub uploaded: Vec<String>,
}

impl ServerHarness {
    /// A harness over one store, ready for `conformance::run`.
    pub async fn new(store: Store) -> Self {
        let s3 = match store {
            Store::Filesystem => None,
            Store::S3 => Some(Arc::new(FakeS3::start().await)),
        };
        let objects_dir = tempfile::tempdir().expect("a temporary object directory");
        let mut harness = Self {
            // Replaced by the first `reset`, which every case begins with.
            gateway: Gateway::new(
                SqliteState::in_memory().expect("a state file"),
                ConfiguredBytes::new(Backend::Filesystem(
                    FilesystemBytes::open(
                        objects_dir.path(),
                        ChecksumMode::ReadAndHash,
                        "https://vault.example.org",
                    )
                    .expect("an object directory"),
                )),
                Policy::default(),
            ),
            objects_dir,
            store,
            s3,
            uploaded: Vec::new(),
        };
        harness
            .reset(ChecksumMode::Attest, Policy::default())
            .await
            .expect("the first reset");
        harness
    }

    fn backend(&self, mode: ChecksumMode) -> Backend {
        match (&self.s3, self.store) {
            (Some(s3), Store::S3) => Backend::S3(Box::new(
                S3Bytes::new(S3Config {
                    endpoint: s3.endpoint(),
                    bucket: "vault".to_owned(),
                    credentials: Credentials {
                        access_key_id: "AKIDEXAMPLE".to_owned(),
                        secret_access_key: "a secret this test invented".to_owned(),
                        region: "us-east-1".to_owned(),
                    },
                    // MinIO and Garage default to path style, which is what a
                    // self-hoster meets first.
                    virtual_host_style: false,
                    checksum_mode: mode,
                    // THE DEFAULT, and the one under test: bytes are proxied.
                    presign: false,
                    origin: "https://vault.example.org".to_owned(),
                })
                .expect("an S3 store"),
            )),
            _ => Backend::Filesystem(
                FilesystemBytes::open(self.objects_dir.path(), mode, "https://vault.example.org")
                    .expect("an object directory"),
            ),
        }
    }
}

impl Harness for ServerHarness {
    type State = SqliteState;
    type Bytes = ConfiguredBytes;

    async fn reset(&mut self, mode: ChecksumMode, policy: Policy) -> Result<(), StoreFault> {
        // A FRESH STORE FOR EVERY CASE, both halves of it. The state file is a
        // new in-memory database; the object store is emptied. A case that
        // passed on the previous one's leftovers would be a case that proves
        // nothing.
        if let Some(s3) = &self.s3 {
            s3.clear();
        }
        for entry in std::fs::read_dir(self.objects_dir.path())
            .into_iter()
            .flatten()
            .flatten()
        {
            let _ = std::fs::remove_dir_all(entry.path());
            let _ = std::fs::remove_file(entry.path());
        }
        self.uploaded.clear();
        self.gateway = Gateway::new(
            SqliteState::in_memory()?,
            ConfiguredBytes::new(self.backend(mode)),
            policy,
        );
        Ok(())
    }

    fn gateway(&mut self) -> &mut Gateway<Self::State, Self::Bytes> {
        &mut self.gateway
    }

    async fn register(&mut self, state: VaultState) -> Result<(), StoreFault> {
        // The adapter's own admission path ends here in both deployments: a
        // `vault` row and the `account` row that carries its plan.
        centraid_gateway_core::store::StateStore::put_vault(&mut self.gateway.state, &state).await
    }

    async fn upload(
        &mut self,
        vault: VaultId,
        name: ObjectName,
        bytes: Vec<u8>,
        attested: bool,
    ) -> Result<(), StoreFault> {
        self.uploaded.push(object_key(&vault, &name));
        self.gateway
            .bytes
            .write(&vault, &name, bytes, attested)
            .await
    }

    async fn corrupt(&mut self, vault: VaultId, name: ObjectName) -> Result<(), StoreFault> {
        self.gateway.bytes.primary().corrupt(&vault, &name).await
    }

    async fn stored_bytes(&self) -> Result<Vec<Vec<u8>>, StoreFault> {
        // THROUGH THE STORE'S OWN READ PATH, in both cases. Reading the fake
        // store's map directly would let the canary pass against an S3 client
        // that cannot fetch what it wrote — the window has to be opened the way
        // an operator's would be. A bucket cannot be walked the way a directory
        // can, so the keys this harness uploaded are what it asks for.
        self.gateway.bytes.primary().stored(&self.uploaded).await
    }

    async fn state_text(&self) -> Result<String, StoreFault> {
        // Every row of every table, rendered. For the canary this is the widest
        // window this adapter can open on itself: if a plaintext ever reached a
        // column, it is in here.
        self.gateway.state.dump()
    }
}
