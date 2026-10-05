//! The conformance suite over the in-memory rules (#1080).
//!
//! **This file is not the suite.** The suite is
//! `centraid_gateway::rules::conformance::run`; this is its reference
//! target, and `tests/conformance_wire.rs` runs the same cases over the real
//! server through the real client. It needs no feature: the rules alone.

use std::future::Future;
use std::pin::pin;
use std::task::{Context, Poll, Waker};

use centraid_gateway::rules::conformance::{self, CASES};
use centraid_gateway::rules::memory::MemoryTarget;

/// Drive a future that never pends. The in-memory target waits on nothing,
/// so one poll is the whole execution; this is not an executor.
fn drive<F: Future>(future: F) -> F::Output {
    let mut future = pin!(future);
    match future
        .as_mut()
        .poll(&mut Context::from_waker(Waker::noop()))
    {
        Poll::Ready(value) => value,
        Poll::Pending => panic!("the in-memory target pended, and nothing behind it waits"),
    }
}

/// Every case, named, and a failure prints which.
#[test]
fn the_rules_pass_every_case() {
    let report = drive(conformance::run(&mut MemoryTarget::new()));
    print!("{}", report.render());
    let names: Vec<&str> = report.cases.iter().map(|case| case.name).collect();
    assert_eq!(names, CASES, "the report must name every case, in order");
    assert!(report.is_green(), "\n{}", report.render());
}

/// The suite can fail: a target that answers wrongly is caught, so a green
/// run means something.
#[test]
fn the_suite_catches_a_target_that_lies() {
    use centraid_gateway::rules::bundle::Frame;
    use centraid_gateway::rules::conformance::{Failure, PutAnswer, ScrubCounts, Target};
    use centraid_gateway::rules::ids::{Digest, GatewayId, Name, Secret, Token, VaultId};
    use centraid_gateway::rules::range::ByteRange;
    use centraid_gateway::rules::wire::{
        BundleAnswer, DeleteAnswer, HeadView, Info, ObjectEntry, PairRequest, Paired, SetHead,
        SnapshotView,
    };

    /// The reference target, except that it stores whatever it is given
    /// under whatever digest it is told: write-once and the digest check gone.
    struct Careless(MemoryTarget);

    impl Target for Careless {
        async fn reset(&mut self) -> Result<(), String> {
            self.0.reset().await
        }
        fn gateway_id(&self) -> GatewayId {
            self.0.gateway_id()
        }
        async fn mint_secret(&mut self) -> Result<Secret, String> {
            self.0.mint_secret().await
        }
        async fn advance(&mut self, ms: i64) {
            self.0.advance(ms).await;
        }
        async fn purge(&mut self) -> Result<u64, String> {
            self.0.purge().await
        }
        async fn scrub(&mut self) -> Result<ScrubCounts, String> {
            self.0.scrub().await
        }
        async fn corrupt(&mut self, vault: &VaultId, name: &Name) -> Result<(), String> {
            self.0.corrupt(vault, name).await
        }
        async fn at_rest(&mut self) -> Result<Vec<u8>, String> {
            self.0.at_rest().await
        }
        async fn info(&mut self) -> Result<Info, Failure> {
            self.0.info().await
        }
        async fn pair(&mut self, request: &PairRequest) -> Result<Paired, Failure> {
            self.0.pair(request).await
        }
        async fn head(&mut self, token: &Token, vault: &VaultId) -> Result<HeadView, Failure> {
            self.0.head(token, vault).await
        }
        async fn set_head(
            &mut self,
            token: &Token,
            vault: &VaultId,
            request: &SetHead,
        ) -> Result<HeadView, Failure> {
            self.0.set_head(token, vault, request).await
        }
        async fn snapshots(
            &mut self,
            token: &Token,
            vault: &VaultId,
        ) -> Result<Vec<SnapshotView>, Failure> {
            self.0.snapshots(token, vault).await
        }
        async fn exists(
            &mut self,
            token: &Token,
            vault: &VaultId,
            names: &[Name],
        ) -> Result<Vec<Name>, Failure> {
            self.0.exists(token, vault, names).await
        }
        async fn put(
            &mut self,
            token: &Token,
            vault: &VaultId,
            name: &Name,
            _digest: &Digest,
            bytes: &[u8],
        ) -> Result<PutAnswer, Failure> {
            let honest = Digest::of(bytes);
            Ok(match self.0.put(token, vault, name, &honest, bytes).await {
                Ok(answer) => answer,
                Err(_) => PutAnswer::Stored(ObjectEntry {
                    name: *name,
                    size: bytes.len() as u64,
                    digest: honest,
                    stored_at_ms: 0,
                }),
            })
        }
        async fn get(
            &mut self,
            token: &Token,
            vault: &VaultId,
            name: &Name,
            range: Option<ByteRange>,
        ) -> Result<Vec<u8>, Failure> {
            self.0.get(token, vault, name, range).await
        }
        async fn stat(
            &mut self,
            token: &Token,
            vault: &VaultId,
            name: &Name,
        ) -> Result<(u64, Digest), Failure> {
            self.0.stat(token, vault, name).await
        }
        async fn bundle(
            &mut self,
            token: &Token,
            vault: &VaultId,
            frames: &[Frame],
        ) -> Result<BundleAnswer, Failure> {
            self.0.bundle(token, vault, frames).await
        }
        async fn fetch(
            &mut self,
            token: &Token,
            vault: &VaultId,
            names: &[Name],
        ) -> Result<Vec<Frame>, Failure> {
            self.0.fetch(token, vault, names).await
        }
        async fn objects(
            &mut self,
            token: &Token,
            vault: &VaultId,
            after: Option<&Name>,
            limit: usize,
        ) -> Result<Vec<ObjectEntry>, Failure> {
            self.0.objects(token, vault, after, limit).await
        }
        async fn delete(
            &mut self,
            token: &Token,
            vault: &VaultId,
            names: &[Name],
        ) -> Result<DeleteAnswer, Failure> {
            self.0.delete(token, vault, names).await
        }
        async fn revoke(&mut self, token: &Token, vault: &VaultId) -> Result<(), Failure> {
            self.0.revoke(token, vault).await
        }
    }

    let report = drive(conformance::run(&mut Careless(MemoryTarget::new())));
    let failed: Vec<&str> = report
        .cases
        .iter()
        .filter(|case| !case.passed)
        .map(|case| case.name)
        .collect();
    for expected in [
        "objects/put-is-write-once-by-name-and-digest",
        "objects/a-digest-that-is-not-the-bytes-stores-nothing",
    ] {
        assert!(
            failed.contains(&expected),
            "{expected} passed against a target that ignores it:\n{}",
            report.render()
        );
    }
}
