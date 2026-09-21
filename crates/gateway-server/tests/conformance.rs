//! `gateway-core`'s own conformance suite, against this adapter, **twice**
//! (#1029 §3).
//!
//! The suite is a library function and not a `#[test]` precisely so that more
//! than one adapter can drive it, and so that an adapter outside `cargo test`'s
//! reach can be held to the same cases. This file is one of its callers.
//!
//! # WHY TWO RUNS AND NOT ONE
//!
//! The two checksum modes are an axis of their own:
//!
//! | | attest | read-and-hash |
//! | --- | --- | --- |
//! | **filesystem** | the store attests what the adapter recorded at upload | the adapter reads and hashes; catches bytes that do not hash to their name |
//!
//! It was FOUR runs while an S3 byte store stood beside the directory, driven
//! against a real HTTP double over a real socket with a real SigV4 signature.
//! The scope amendment of 2026-09-21 strikes that store, and the two runs it
//! owned go with it rather than being faked against a mock `ByteStore` — which
//! would have exercised an enum arm and skipped the protocol.

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
        "errors/a-refusal-carries-its-companions-on-the-wire",
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

        async fn error_body(
            &self,
            refusal: &centraid_gateway_core::error::Refusal,
        ) -> Result<String, StoreFault> {
            self.0.error_body(refusal).await
        }
    }

    let mut harness = Forgetful(ServerHarness::new(Store::Filesystem).await);
    let report = conformance::run(&mut harness).await;
    assert!(
        !report.is_green(),
        "a harness that stores nothing passed the suite against this adapter"
    );
}
