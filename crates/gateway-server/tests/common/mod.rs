//! THE HARNESS THE CONFORMANCE SUITE RUNS AGAINST (#1029 §3).
//!
//! It held a `FakeS3` — a real HTTP server speaking the subset of the S3 API
//! this adapter uses, over a real socket with a real SigV4 signature — so that
//! "S3 × attest" was a claim about a code path something actually drove. The
//! scope amendment of 2026-09-21 strikes the S3 byte store: v0's destination is
//! the member's own laptop and its store is the filesystem. The double goes
//! with the code it doubled.
//!
//! What remains is the real adapter over a real temporary directory, which is
//! the store an operator will have.

use centraid_gateway_core::Gateway;
use centraid_gateway_core::conformance::Harness;
use centraid_gateway_core::ids::{ObjectName, VaultId};
use centraid_gateway_core::retention::Policy;
use centraid_gateway_core::store::{StoreFault, VaultState};
use centraid_gateway_server::bytes::ProxyWrite as _;
use centraid_gateway_server::bytes::configured::{Backend, ConfiguredBytes};
use centraid_gateway_server::bytes::fs::FilesystemBytes;
use centraid_gateway_server::state::SqliteState;

/// Which store a run is against.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Store {
    Filesystem,
}

impl Store {
    pub const fn label(self) -> &'static str {
        match self {
            Self::Filesystem => "filesystem",
        }
    }
}

/// The real adapter, driven by `gateway-core`'s own suite.
pub struct ServerHarness {
    pub gateway: Gateway<SqliteState, ConfiguredBytes>,
    /// Kept alive for the life of the harness: dropping it removes the object
    /// directory out from under the store.
    pub objects_dir: tempfile::TempDir,
    #[expect(
        dead_code,
        reason = "one store is left; the field keeps the harness's shape for a second"
    )]
    pub store: Store,
}

impl ServerHarness {
    /// A harness over one store, ready for `conformance::run`.
    pub async fn new(store: Store) -> Self {
        let objects_dir = tempfile::tempdir().expect("a temporary object directory");
        let mut harness = Self {
            // Replaced by the first `reset`, which every case begins with.
            gateway: Gateway::new(
                SqliteState::in_memory().expect("a state file"),
                ConfiguredBytes::new(Backend::Filesystem(
                    FilesystemBytes::open(objects_dir.path(), "https://vault.example.org")
                        .expect("an object directory"),
                )),
                Policy::default(),
            ),
            objects_dir,
            store,
        };
        harness
            .reset(Policy::default())
            .await
            .expect("the first reset");
        harness
    }

    fn backend(&self) -> Backend {
        Backend::Filesystem(
            FilesystemBytes::open(self.objects_dir.path(), "https://vault.example.org")
                .expect("an object directory"),
        )
    }
}

impl Harness for ServerHarness {
    type State = SqliteState;
    type Bytes = ConfiguredBytes;

    async fn reset(&mut self, policy: Policy) -> Result<(), StoreFault> {
        // A FRESH STORE FOR EVERY CASE, both halves of it. The state file is a
        // new in-memory database; the object store is emptied. A case that
        // passed on the previous one's leftovers would be a case that proves
        // nothing.
        for entry in std::fs::read_dir(self.objects_dir.path())
            .into_iter()
            .flatten()
            .flatten()
        {
            let _ = std::fs::remove_dir_all(entry.path());
            let _ = std::fs::remove_file(entry.path());
        }
        self.gateway = Gateway::new(
            SqliteState::in_memory()?,
            ConfiguredBytes::new(self.backend()),
            policy,
        );
        Ok(())
    }

    fn gateway(&mut self) -> &mut Gateway<Self::State, Self::Bytes> {
        &mut self.gateway
    }

    async fn register(&mut self, state: VaultState) -> Result<(), StoreFault> {
        // The adapter's own admission path ends here: a `vault` row and the
        // `account` row that carries its quota.
        centraid_gateway_core::store::StateStore::put_vault(&mut self.gateway.state, &state).await
    }

    async fn upload(
        &mut self,
        vault: VaultId,
        name: ObjectName,
        bytes: Vec<u8>,
    ) -> Result<(), StoreFault> {
        self.gateway.bytes.write(&vault, &name, bytes).await
    }

    /// THE REAL SERIALIZER, not a restatement of it.
    ///
    /// `ErrorBody::of` is the one place this crate builds a refusal's body, so
    /// the conformance case drives the code a phone actually receives — a
    /// harness that rendered the companions itself would pass while the handler
    /// dropped them, which is the failure this window was opened for.
    async fn error_body(
        &self,
        refusal: &centraid_gateway_core::error::Refusal,
    ) -> Result<String, StoreFault> {
        serde_json::to_string(&centraid_gateway_server::http::ErrorBody::of(refusal, 0))
            .map_err(|error| StoreFault::new(error.to_string()))
    }

    async fn corrupt(&mut self, vault: VaultId, name: ObjectName) -> Result<(), StoreFault> {
        self.gateway.bytes.primary().corrupt(&vault, &name).await
    }

    async fn stored_bytes(&self) -> Result<Vec<Vec<u8>>, StoreFault> {
        // THROUGH THE STORE'S OWN READ PATH. Reading the directory behind the
        // store's back would let the canary pass against a client that cannot
        // fetch what it wrote — the window has to be opened the way an
        // operator's would be.
        self.gateway.bytes.primary().every_stored_object().await
    }

    async fn state_text(&self) -> Result<String, StoreFault> {
        // Every row of every table, rendered. For the canary this is the widest
        // window this adapter can open on itself: if a plaintext ever reached a
        // column, it is in here.
        self.gateway.state.dump()
    }
}
