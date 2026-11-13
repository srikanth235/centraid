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
        BundleAnswer, DeleteAnswer, DeleteRequest, HeadView, HeldEntry, Info, NonceAnswer,
        ObjectEntry, PairRequest, Paired, SetHead, SnapshotView, UndoRequest, Undone,
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
            after: Option<&Name>,
            limit: usize,
        ) -> Result<Vec<SnapshotView>, Failure> {
            self.0.snapshots(token, vault, after, limit).await
        }
        async fn held(
            &mut self,
            token: &Token,
            vault: &VaultId,
            after: Option<&Name>,
            limit: usize,
        ) -> Result<Vec<HeldEntry>, Failure> {
            self.0.held(token, vault, after, limit).await
        }
        async fn nonce(&mut self) -> Result<NonceAnswer, Failure> {
            self.0.nonce().await
        }
        async fn undo(
            &mut self,
            token: &Token,
            vault: &VaultId,
            request: &UndoRequest,
        ) -> Result<Undone, Failure> {
            self.0.undo(token, vault, request).await
        }
        async fn freeze(&mut self, vault: &VaultId) -> Result<(), String> {
            self.0.freeze(vault).await
        }
        async fn unfreeze(&mut self, vault: &VaultId) -> Result<i64, String> {
            self.0.unfreeze(vault).await
        }
        async fn operator_undo(&mut self, vault: &VaultId) -> Result<u64, String> {
            self.0.operator_undo(vault).await
        }
        async fn token_epochs(&mut self, vault: &VaultId) -> Result<Vec<u64>, String> {
            self.0.token_epochs(vault).await
        }
        async fn revoked_count(&mut self, vault: &VaultId) -> Result<u64, String> {
            self.0.revoked_count(vault).await
        }
        async fn secret_count(&mut self) -> Result<u64, String> {
            self.0.secret_count().await
        }
        async fn nonce_rows(&mut self) -> Result<Vec<Vec<u8>>, String> {
            self.0.nonce_rows().await
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
            request: &DeleteRequest,
        ) -> Result<DeleteAnswer, Failure> {
            self.0.delete(token, vault, request).await
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

/// One of tests.md's attacker tests, by its name: the case it names, over the
/// rules in memory.
fn named(test: &str) {
    let case = conformance::NAMED
        .iter()
        .find(|(name, _)| *name == test)
        .unwrap_or_else(|| panic!("{test} is not in NAMED"))
        .1;
    let found = drive(conformance::run_one(&mut MemoryTarget::new(), case))
        .unwrap_or_else(|| panic!("{case} is not a case"));
    assert!(found.passed, "{test} ({case}): {}", found.detail);
}

macro_rules! named_in_memory {
    ($($name:ident),+ $(,)?) => {$(
        #[test]
        fn $name() {
            named(stringify!($name));
        }
    )+};
}

named_in_memory!(
    a_token_without_the_vault_key_cannot_set_a_head,
    an_old_signed_head_replayed_is_out_of_order,
    a_generation_jump_beyond_the_bound_is_refused,
    a_claim_resets_the_generation_and_the_next_head_is_accepted,
    a_head_names_a_held_manifest_only,
    a_takeover_leaves_no_live_older_token,
    a_moved_claim_is_bound_to_its_gateway,
    a_revoked_token_hears_moved_until_the_tombstone_is_pruned,
    a_takeover_cancels_held_deletes,
    a_delete_needs_the_vault_signature,
    a_signed_delete_is_held_seven_days_and_stays_listed,
    a_replayed_delete_is_out_of_order,
    a_head_cannot_be_deleted_and_a_snapshot_row_keeps_its_object,
    an_undo_lifts_a_hold,
    a_photographer_cannot_squat_the_members_vault,
    a_pair_signature_is_bound_to_nonce_secret_and_gateway,
    a_replayed_read_grant_is_refused,
    a_replayed_claim_after_a_revoke_is_refused,
    an_expired_nonce_is_refused_and_pruned,
    nonce_storage_is_bounded,
    the_nonce_route_names_no_vault,
    a_head_from_the_future_is_refused,
    pairing_secrets_are_pruned_and_bounded,
    a_frozen_vault_refuses_writes_and_answers_reads,
    unfreeze_gives_back_the_time_it_was_frozen,
    operator_undo_restores_every_hold,
    a_gap_between_sweeps_is_not_counted_against_a_hold,
    the_nonce_route_writes_nothing_and_a_claim_still_works,
    a_forged_foreign_expired_or_replayed_nonce_is_refused,
    a_claim_keeps_the_superseded_writers_tombstone_among_a_hundred_readers,
    a_put_of_garbage_over_a_held_or_damaged_name_is_refused,
    a_signed_delete_frees_a_damaged_name_and_a_token_alone_cannot,
    the_extremes_of_every_number_are_refused_without_a_fault,
    a_claim_or_read_grant_for_another_gateway_or_vault_moves_nothing,
);

/// Every name in `NAMED` has a test above.
#[test]
fn every_named_test_is_here() {
    let source = include_str!("conformance.rs");
    for (name, _) in conformance::NAMED {
        assert!(
            source.contains(&format!("    {name},")),
            "{name} has no test in memory"
        );
    }
}
