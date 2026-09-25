//! The conformance suite, run against the in-memory adapter.
//!
//! **This file is not the suite.** The suite is
//! `centraid_gateway_core::conformance::run`, a library function, and this is
//! one of the three callers it will have: W4b's standalone server and W4c's
//! Worker are the other two, and they call the same function with their own
//! [`Harness`]. A suite that lived in a `#[test]` could never be one of those,
//! because an adapter may live outside `cargo test`'s reach entirely.

use std::future::Future;
use std::pin::pin;
use std::task::{Context, Poll, Waker};

use centraid_gateway_core::conformance::{self, Harness};
use centraid_gateway_core::engine::Gateway;
use centraid_gateway_core::error::Refusal;
use centraid_gateway_core::ids::{ObjectName, VaultId};
use centraid_gateway_core::memory::{MemoryBytes, MemoryState};
use centraid_gateway_core::retention::Policy;
use centraid_gateway_core::store::{StoreFault, VaultState};

/// Drive a future that never pends.
///
/// The in-memory adapter's futures are all immediately ready — there is no
/// socket, no file and no timer behind them — so one poll is the whole
/// execution. This is *not* a general executor and is not offered as one: a
/// real adapter runs the same suite under tokio or under a Worker's own
/// scheduler, which is exactly why the suite is `async` in the first place.
fn drive<F: Future>(future: F) -> F::Output {
    let mut future = pin!(future);
    let mut context = Context::from_waker(Waker::noop());
    match future.as_mut().poll(&mut context) {
        Poll::Ready(value) => value,
        Poll::Pending => panic!(
            "the in-memory harness pended, which it cannot do — nothing behind \
             it waits on anything"
        ),
    }
}

struct MemoryHarness {
    gateway: Gateway<MemoryState, MemoryBytes>,
}

impl MemoryHarness {
    fn new() -> Self {
        Self {
            gateway: Gateway::new(MemoryState::new(), MemoryBytes::new(), Policy::default()),
        }
    }
}

impl Harness for MemoryHarness {
    type State = MemoryState;
    type Bytes = MemoryBytes;

    async fn reset(&mut self, policy: Policy) -> Result<(), StoreFault> {
        self.gateway = Gateway::new(MemoryState::new(), MemoryBytes::new(), policy);
        Ok(())
    }

    fn gateway(&mut self) -> &mut Gateway<Self::State, Self::Bytes> {
        &mut self.gateway
    }

    async fn register(&mut self, state: VaultState) -> Result<(), StoreFault> {
        self.gateway.state.register(state);
        Ok(())
    }

    async fn upload(
        &mut self,
        vault: VaultId,
        name: ObjectName,
        bytes: Vec<u8>,
    ) -> Result<(), StoreFault> {
        self.gateway.bytes.upload(vault, name, bytes);
        Ok(())
    }

    async fn corrupt(&mut self, vault: VaultId, name: ObjectName) -> Result<(), StoreFault> {
        self.gateway.bytes.corrupt(vault, name);
        Ok(())
    }

    async fn stored_bytes(&self) -> Result<Vec<Vec<u8>>, StoreFault> {
        Ok(self
            .gateway
            .bytes
            .every_stored_object()
            .map(|(_, bytes)| bytes.clone())
            .collect())
    }

    async fn state_text(&self) -> Result<String, StoreFault> {
        // The whole state store, rendered. For the canary this is the widest
        // window an adapter can open on itself: if a plaintext ever reached a
        // field, it is in here.
        Ok(format!("{:?}", self.gateway.state))
    }

    /// The companion rendering, straight off `Refusal::companions()`.
    ///
    /// **This harness is not a deployment and its serializer is not a
    /// protocol.** Rendering the fields the rules produced is the most this can
    /// honestly do; what the case is really for is the two adapters, whose
    /// serializers are hand-written and are where a companion actually gets
    /// lost. Here it proves the rules produce the companions at all, which is
    /// the half that has to be true before an adapter can render them.
    async fn error_body(&self, refusal: &Refusal) -> Result<String, StoreFault> {
        let mut body = format!("code={:?}", refusal.code());
        for (field, value) in refusal.companions().fields() {
            body.push_str(&format!(" {field}={value}"));
        }
        Ok(body)
    }
}

/// Every case, named, and a failure prints which.
#[test]
fn the_conformance_suite_is_green_against_the_in_memory_adapter() {
    let mut harness = MemoryHarness::new();
    let report = drive(conformance::run(&mut harness));

    assert!(
        report.is_green(),
        "the conformance suite failed:\n{}",
        report.render()
    );

    // The suite has to have actually run: a harness that silently did nothing
    // would report zero cases and be "green".
    assert!(
        report.cases.len() >= 15,
        "only {} cases ran:\n{}",
        report.cases.len(),
        report.render()
    );

    // And the cases the brief names by hand are present under those names, so
    // a rename cannot quietly drop one.
    for required in [
        "commit/two-devices-racing-leave-exactly-one-winner",
        "retention/fifty-empty-generations-cannot-push-a-real-base-out",
        "retention/one-client-base-tombstone-per-vault-per-day",
        "checksum/a-good-commit-is-acked",
        "checksum/a-commit-of-bytes-nobody-uploaded-is-refused",
        "checksum/bytes-that-do-not-hash-to-their-name-are-refused",
        "version-skew/server-too-old-writes-nothing",
        "version-skew/client-too-old",
        "canary/no-plaintext-or-plaintext-hash-is-anywhere-in-the-store",
        "errors/a-refusal-carries-its-companions-on-the-wire",
    ] {
        assert!(
            report.cases.iter().any(|case| case.name == required),
            "the suite no longer runs `{required}`:\n{}",
            report.render()
        );
    }
}

/// A suite that cannot fail is not a suite.
///
/// The harness here lies about one thing — it drops uploads on the floor — and
/// the run must go red rather than green. Without this, every assertion above
/// would be satisfied by a [`conformance::run`] that returned an empty report
/// and a `Harness` that did nothing.
#[test]
fn the_suite_goes_red_against_a_harness_that_does_not_store_what_it_was_given() {
    struct Forgetful(MemoryHarness);

    impl Harness for Forgetful {
        type State = MemoryState;
        type Bytes = MemoryBytes;

        async fn reset(&mut self, policy: Policy) -> Result<(), StoreFault> {
            self.0.reset(policy).await
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
        ) -> Result<(), StoreFault> {
            // The bytes go nowhere, so every commit fails: a gateway that
            // hashes what it stores has nothing at that name to hash.
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

    let mut harness = Forgetful(MemoryHarness::new());
    let report = drive(conformance::run(&mut harness));
    assert!(
        !report.is_green(),
        "a harness that stores nothing passed the suite"
    );
}
