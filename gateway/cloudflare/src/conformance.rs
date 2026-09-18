//! THE SHARED SUITE, DRIVEN INSIDE A REAL DURABLE OBJECT (#1029 §3).
//!
//! *Neither deployment is the reference implementation: the protocol and its
//! conformance suite are.* The suite is `conformance::run`, a **library
//! function**, precisely so that this can be one of its callers: `cargo test`
//! cannot reach inside a Worker, so a suite that lived in a `#[test]` could only
//! ever have checked one of the two things it exists to compare.
//!
//! # IT RUNS AGAINST THE REAL STORAGE, NOT A MODEL OF IT
//!
//! [`WorkerHarness`] is constructed **inside the vault Durable Object**, over
//! that object's own SQLite and the Worker's own R2 bucket. Every case goes
//! through `DurableState`'s column mapping, R2's `head` and the attestation it
//! carries, and `ErrorBody::of`'s serializer. A harness that held a
//! `MemoryState` beside the real one would pass and prove nothing about this
//! deployment — and the standalone adapter's own harness makes the same choice
//! for the same reason.
//!
//! # HOW IT IS REACHED
//!
//! `POST /__conformance` on a Worker started with `CONFORMANCE=1`. The flag is
//! read from the environment and its absence is a 404, so a deployed Worker
//! does not carry a route that resets a vault's storage. Under Miniflare the
//! flag is set in `wrangler.toml`'s dev environment and nowhere else.
//!
//! The response is the report `conformance::run` returned, rendered one line
//! per case, plus a final `GREEN` or `RED` line — which is what the harness
//! script asserts on, because a Worker has no test harness to catch a panic and
//! a suite that aborted on its first failure would tell an adapter author one
//! thing per run.
//!
//! # THE CANARY'S TWO WINDOWS, ON THIS DEPLOYMENT
//!
//! `stored_bytes` lists **R2** under the vault's prefix and reads every object
//! back; `state_text` dumps **every table in the Durable Object's SQLite**,
//! every row, every column, blobs in hex. Those are the two places a plaintext
//! could be on this deployment, and the canary reads both with a planted one.

use centraid_gateway_core::checksum::ChecksumMode;
use centraid_gateway_core::conformance::Harness;
use centraid_gateway_core::engine::Gateway;
use centraid_gateway_core::error::Refusal;
use centraid_gateway_core::ids::{ObjectName, VaultId};
use centraid_gateway_core::retention::Policy;
use centraid_gateway_core::store::{StateStore as _, StoreFault, VaultState};
use worker::Bucket;

use crate::r2::{R2Bytes, S3Face, object_key, put_as_a_phone_would};
use crate::vault::DurableState;
use crate::wire::ErrorBody;

/// A SUITE THAT CANNOT FAIL IS NOT A SUITE.
///
/// Every assertion about a green run is satisfied by a harness that quietly did
/// nothing, so the suite has to be shown going RED against one. This harness
/// lies about exactly one thing — it drops uploads on the floor — and every
/// commit must then fail on "no attested checksum", which is the rule R2's own
/// behaviour forced.
///
/// `gateway-core` proves this against its in-memory adapter and
/// `gateway-server` against its own; it has to be true of **this** harness too,
/// or the Worker's green run proves nothing about the Worker.
pub struct ForgetfulHarness(pub WorkerHarness);

impl Harness for ForgetfulHarness {
    type State = DurableState;
    type Bytes = R2Bytes;

    async fn reset(&mut self, mode: ChecksumMode, policy: Policy) -> Result<(), StoreFault> {
        self.0.reset(mode, policy).await
    }

    fn gateway(&mut self) -> &mut Gateway<Self::State, Self::Bytes> {
        self.0.gateway()
    }

    async fn register(&mut self, state: VaultState) -> Result<(), StoreFault> {
        self.0.register(state).await
    }

    async fn upload(
        &mut self,
        _vault: VaultId,
        _name: ObjectName,
        _bytes: Vec<u8>,
        _attested: bool,
    ) -> Result<(), StoreFault> {
        // The bytes go nowhere.
        Ok(())
    }

    async fn corrupt(&mut self, vault: VaultId, name: ObjectName) -> Result<(), StoreFault> {
        self.0.corrupt(vault, name).await
    }

    async fn stored_bytes(&self) -> Result<Vec<Vec<u8>>, StoreFault> {
        self.0.stored_bytes().await
    }

    async fn state_text(&self) -> Result<String, StoreFault> {
        self.0.state_text().await
    }

    async fn error_body(&self, refusal: &Refusal) -> Result<String, StoreFault> {
        self.0.error_body(refusal).await
    }
}

/// The suite's view of this deployment.
pub struct WorkerHarness {
    gateway: Gateway<DurableState, R2Bytes>,
    /// A second handle on the same bucket. The `Gateway` owns its `R2Bytes` and
    /// the harness still has to upload and corrupt, which are things a *phone*
    /// and *bit rot* do rather than things a rule does.
    bucket: Bucket,
    /// Kept so that a reset can rebuild the byte store in the mode the case
    /// asked for.
    s3: Option<S3Face>,
}

impl WorkerHarness {
    /// Build one over this object's storage and the Worker's bucket.
    ///
    /// # Errors
    ///
    /// A store fault if the schema cannot be applied.
    pub fn new(
        sql: worker::SqlStorage,
        bucket: Bucket,
        s3: Option<S3Face>,
        policy: Policy,
    ) -> Result<Self, StoreFault> {
        let state = DurableState::open(sql)?;
        Ok(Self {
            gateway: Gateway::new(state, R2Bytes::new(bucket.clone(), s3.clone()), policy),
            bucket,
            s3,
        })
    }

    async fn clear_bucket(&self) -> Result<(), StoreFault> {
        let listed = self
            .bucket
            .list()
            .execute()
            .await
            .map_err(|error| StoreFault::new(error.to_string()))?;
        for object in listed.objects() {
            self.bucket
                .delete(object.key())
                .await
                .map_err(|error| StoreFault::new(error.to_string()))?;
        }
        Ok(())
    }
}

impl Harness for WorkerHarness {
    type State = DurableState;
    type Bytes = R2Bytes;

    async fn reset(&mut self, mode: ChecksumMode, policy: Policy) -> Result<(), StoreFault> {
        // A FRESH STORE FOR EVERY CASE, both halves of it. A case that passed
        // on the previous one's leftovers would be a case that proves nothing.
        self.gateway.state.reset()?;
        self.clear_bucket().await?;
        self.gateway.retention = policy;
        // THE MODE IS THE STORE'S AND THE SUITE SETS IT. A deployed Worker is
        // built in `Attest` — R2 attests and reading a 16 MiB object back on
        // every commit would not fit a Worker's CPU budget — but the suite runs
        // two cases in `ReadAndHash`, and running them against THIS store
        // rather than skipping them is the point: it is what proves the
        // stronger check behaves identically on both deployments.
        self.gateway.bytes = R2Bytes::in_mode(self.bucket.clone(), self.s3.clone(), mode);
        Ok(())
    }

    fn gateway(&mut self) -> &mut Gateway<Self::State, Self::Bytes> {
        &mut self.gateway
    }

    async fn register(&mut self, state: VaultState) -> Result<(), StoreFault> {
        // The adapter's own admission path ends here in both deployments: an
        // `account` row and a `vault` row in the shared schema. What differs is
        // what had to happen first — a purchase here, an invite there — and
        // nothing downstream of this line knows which.
        self.gateway.state.put_vault(&state).await
    }

    async fn upload(
        &mut self,
        vault: VaultId,
        name: ObjectName,
        bytes: Vec<u8>,
        attested: bool,
    ) -> Result<(), StoreFault> {
        // THE CASE R2 REALLY PRODUCES. `attested = false` is a client that sent
        // no checksum header, and R2 then records nothing — which is not a
        // contrived state, it is the default for anyone who did not opt in, and
        // it is why a commit must fail on "no checksum" rather than only on
        // "wrong checksum". The store's own checksum field is named in `r2.rs`
        // and nowhere else; see that module and the one-hash allowlist.
        put_as_a_phone_would(&self.bucket, &vault, &name, bytes, attested).await
    }

    async fn corrupt(&mut self, vault: VaultId, name: ObjectName) -> Result<(), StoreFault> {
        // Bit rot, as far as the scrub can tell: the bytes change and the
        // object's name does not. The attestation is re-sent for the NEW bytes
        // on purpose — a store whose attestation still matched would be a store
        // that noticed the rot itself, and the scrub exists for the case where
        // nothing did.
        let key = object_key(&vault, &name);
        let Some(object) = self
            .bucket
            .get(&key)
            .execute()
            .await
            .map_err(|error| StoreFault::new(error.to_string()))?
        else {
            return Err(StoreFault::new("nothing to corrupt at that key"));
        };
        let Some(body) = object.body() else {
            return Err(StoreFault::new("the stored object has no body"));
        };
        let mut bytes = body
            .bytes()
            .await
            .map_err(|error| StoreFault::new(error.to_string()))?;
        if let Some(first) = bytes.first_mut() {
            *first ^= 0b0000_0001;
        }
        // Re-attested for the NEW bytes on purpose: a store whose attestation
        // still matched would be a store that noticed the rot itself, and the
        // scrub exists for the case where nothing did.
        put_as_a_phone_would(&self.bucket, &vault, &name, bytes, true).await
    }

    async fn stored_bytes(&self) -> Result<Vec<Vec<u8>>, StoreFault> {
        let listed = self
            .bucket
            .list()
            .execute()
            .await
            .map_err(|error| StoreFault::new(error.to_string()))?;
        let mut out = Vec::new();
        for object in listed.objects() {
            let Some(held) = self
                .bucket
                .get(object.key())
                .execute()
                .await
                .map_err(|error| StoreFault::new(error.to_string()))?
            else {
                continue;
            };
            if let Some(body) = held.body() {
                out.push(
                    body.bytes()
                        .await
                        .map_err(|error| StoreFault::new(error.to_string()))?,
                );
            }
        }
        Ok(out)
    }

    async fn state_text(&self) -> Result<String, StoreFault> {
        // Every table in this Durable Object's SQLite, every row, every column.
        // For the canary this is the widest window this adapter can open on
        // itself: if a plaintext ever reached a column, it is in here.
        self.gateway.state.dump()
    }

    async fn error_body(&self, refusal: &Refusal) -> Result<String, StoreFault> {
        // THE REAL SERIALIZER, not a restatement of it. A harness that rendered
        // the companions itself would pass while the routes dropped them, which
        // is the failure this window was opened for.
        serde_json::to_string(&ErrorBody::of(refusal, 0))
            .map_err(|error| StoreFault::new(error.to_string()))
    }
}
