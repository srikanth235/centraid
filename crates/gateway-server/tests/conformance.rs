//! `gateway-core`'s own conformance suite, against this adapter, **four times**
//! (#1029 §3).
//!
//! The suite is a library function and not a `#[test]` precisely so that more
//! than one adapter can drive it: `cargo test` cannot reach inside a Worker
//! under Miniflare, and a suite only the standalone adapter could run would be a
//! suite that checks one of the two things it exists to compare. This file is
//! one of its callers.
//!
//! # WHY FOUR RUNS AND NOT ONE
//!
//! Two stores and two checksum modes are **two independent axes**, and the
//! combinations are not redundant:
//!
//! | | attest | read-and-hash |
//! | --- | --- | --- |
//! | **filesystem** | the store attests what the adapter recorded at upload | the adapter reads and hashes; catches bytes that do not hash to their name |
//! | **S3** | a real `HEAD`, a real `x-amz-checksum-sha256`, parsed | a real `GET`, hashed here |
//!
//! The S3 half runs against a real HTTP store over a real socket with a real
//! SigV4 signature (`tests/common`), because the alternative — a mock
//! `ByteStore` — would exercise the enum arm and skip the protocol, and the
//! protocol is where the two modes actually differ.
//!
//! **What none of the four can prove** is interoperability with a particular
//! vendor: `FakeS3` is not MinIO, not B2 and not R2. That is named here rather
//! than left to be discovered, and it is the reason the modes are configuration
//! rather than something the adapter sniffs.

mod common;

use centraid_gateway_core::checksum::ChecksumMode;
use centraid_gateway_core::conformance::{self, Harness as _};
use common::{ServerHarness, Store, mode_label};

/// One combination, run and asserted.
async fn run(store: Store, mode: ChecksumMode) {
    let mut harness = ServerHarness::new(store).await;
    // The suite resets the harness into whichever mode each case needs, so the
    // mode here is the one the run STARTS in and the one every case that does
    // not name a mode of its own gets. Both are exercised either way; what this
    // parameter changes is which store is behind them.
    harness
        .reset(mode, centraid_gateway_core::retention::Policy::default())
        .await
        .expect("a reset");

    let report = conformance::run(&mut harness).await;
    assert!(
        report.is_green(),
        "the conformance suite failed against {} × {}:\n{}",
        store.label(),
        mode_label(mode),
        report.render()
    );
    assert!(
        report.cases.len() >= 15,
        "only {} cases ran against {} × {}:\n{}",
        report.cases.len(),
        store.label(),
        mode_label(mode),
        report.render()
    );

    // The cases the brief names by hand are present under those names, so a
    // rename upstream cannot quietly drop one from this adapter's evidence.
    for required in [
        "checksum/attest-mode-commits-verified-bytes",
        "checksum/read-and-hash-mode-commits-verified-bytes",
        "checksum/no-attestation-is-a-rejection",
        "checksum/read-and-hash-catches-bytes-that-do-not-hash-to-their-name",
        "upload/a-committed-name-is-never-presigned",
        "commit/two-devices-racing-leave-exactly-one-winner",
        "retention/fifty-empty-generations-cannot-push-a-real-base-out",
        "retention/one-client-base-tombstone-per-vault-per-day",
        "scrub/bit-rot-is-reported-without-any-key",
        "canary/no-plaintext-or-plaintext-hash-is-anywhere-in-the-store",
    ] {
        assert!(
            report.cases.iter().any(|case| case.name == required),
            "`{required}` did not run against {} × {}:\n{}",
            store.label(),
            mode_label(mode),
            report.render()
        );
    }
}

#[tokio::test]
async fn the_suite_is_green_against_a_directory_in_attest_mode() {
    run(Store::Filesystem, ChecksumMode::Attest).await;
}

#[tokio::test]
async fn the_suite_is_green_against_a_directory_in_read_and_hash_mode() {
    run(Store::Filesystem, ChecksumMode::ReadAndHash).await;
}

#[tokio::test]
async fn the_suite_is_green_against_an_s3_store_in_attest_mode() {
    run(Store::S3, ChecksumMode::Attest).await;
}

#[tokio::test]
async fn the_suite_is_green_against_an_s3_store_in_read_and_hash_mode() {
    run(Store::S3, ChecksumMode::ReadAndHash).await;
}

/// A SUITE THAT CANNOT FAIL IS NOT A SUITE.
///
/// `gateway-core` proves this against its in-memory adapter; it has to be true
/// of **this** harness too, or every assertion above is satisfied by a harness
/// that quietly did nothing. The harness here lies about one thing — it drops
/// uploads on the floor — and every commit must then fail on "no attested
/// checksum", which is the rule R2's behaviour forced.
#[tokio::test]
async fn the_suite_goes_red_against_a_harness_that_stores_nothing() {
    use centraid_gateway_core::Gateway;
    use centraid_gateway_core::conformance::Harness;
    use centraid_gateway_core::ids::{ObjectName, VaultId};
    use centraid_gateway_core::retention::Policy;
    use centraid_gateway_core::store::{StoreFault, VaultState};

    struct Forgetful(ServerHarness);

    impl Harness for Forgetful {
        type State = centraid_gateway_server::state::SqliteState;
        type Bytes = centraid_gateway_server::bytes::configured::ConfiguredBytes;

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
    }

    let mut harness = Forgetful(ServerHarness::new(Store::Filesystem).await);
    let report = conformance::run(&mut harness).await;
    assert!(
        !report.is_green(),
        "a harness that stores nothing passed the suite against this adapter"
    );
}
