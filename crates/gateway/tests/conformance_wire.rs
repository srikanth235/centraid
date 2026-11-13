//! The conformance suite over the real gateway, through the real client
//! (#1080).
//!
//! Each case resets to a fresh data directory and a fresh gateway from
//! `server::harness::spawn` on `127.0.0.1:0`; every protocol call is the
//! phone's client speaking TLS to it, trusting the certificate by its bytes.
//! The canary's window is the data directory itself: every file, its path
//! and its bytes, `state.db` and its WAL included.

use std::path::{Path, PathBuf};

use centraid_gateway::client::{Client, ClientError, Destination, Put};
use centraid_gateway::rules::bundle::Frame;
use centraid_gateway::rules::code::Refusal;
use centraid_gateway::rules::conformance::{self, CASES, Failure, PutAnswer, ScrubCounts, Target};
use centraid_gateway::rules::engine::Operated;
use centraid_gateway::rules::ids::{Digest, GatewayId, Name, Secret, Token, VaultId};
use centraid_gateway::rules::range::ByteRange;
use centraid_gateway::rules::wire::{
    BundleAnswer, DeleteAnswer, DeleteRequest, HeadView, HeldEntry, Info, NonceAnswer, ObjectEntry,
    PairRequest, Paired, SetHead, SnapshotView, UndoRequest, Undone,
};
use centraid_gateway::server::harness::{Spawned, spawn};

struct WireTarget {
    root: tempfile::TempDir,
    generation: u32,
    spawned: Option<Spawned>,
}

impl WireTarget {
    fn spawned(&self) -> &Spawned {
        self.spawned.as_ref().expect("reset before use")
    }

    /// A phone holding `token`, trusting the gateway by its certificate.
    fn phone(&self, token: &Token) -> Client {
        let spawned = self.spawned();
        Client::new(&Destination {
            addrs: vec![spawned.addr.to_string()],
            cert_der: spawned.cert_der.clone(),
            token: *token,
        })
    }

    /// A phone with no token yet: what pairs.
    fn stranger(&self) -> Client {
        self.spawned().first_contact()
    }
}

fn failure(error: ClientError) -> Failure {
    match error {
        ClientError::Refused(refusal) => Failure::Refused(refusal),
        other => Failure::Broken(other.to_string()),
    }
}

/// Every file under `dir`: its path relative to `dir`, then its bytes.
fn every_byte(dir: &Path) -> Vec<u8> {
    fn walk(root: &Path, dir: &Path, into: &mut Vec<u8>) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        let mut paths: Vec<PathBuf> = entries.flatten().map(|entry| entry.path()).collect();
        paths.sort();
        for path in paths {
            if path.is_dir() {
                walk(root, &path, into);
            } else if let Ok(bytes) = std::fs::read(&path) {
                into.extend_from_slice(
                    path.strip_prefix(root)
                        .unwrap_or(&path)
                        .to_string_lossy()
                        .as_bytes(),
                );
                into.extend_from_slice(&bytes);
            }
        }
    }
    let mut out = Vec::new();
    walk(dir, dir, &mut out);
    out
}

impl Target for WireTarget {
    async fn reset(&mut self) -> Result<(), String> {
        if let Some(old) = self.spawned.take() {
            old.shutdown().await;
        }
        self.generation += 1;
        let dir = self.root.path().join(self.generation.to_string());
        self.spawned = Some(spawn(&dir).await.map_err(|error| error.to_string())?);
        Ok(())
    }

    fn gateway_id(&self) -> GatewayId {
        self.spawned().gateway_id
    }

    async fn mint_secret(&mut self) -> Result<Secret, String> {
        Ok(self.spawned().mint_pairing_secret())
    }

    async fn advance(&mut self, ms: i64) {
        self.spawned().advance_clock(ms);
    }

    async fn purge(&mut self) -> Result<u64, String> {
        self.spawned()
            .purge_now()
            .await
            .map_err(|fault| fault.to_string())
    }

    async fn scrub(&mut self) -> Result<ScrubCounts, String> {
        self.spawned()
            .scrub_now()
            .await
            .map_err(|fault| fault.to_string())
    }

    async fn corrupt(&mut self, vault: &VaultId, name: &Name) -> Result<(), String> {
        self.spawned()
            .corrupt(vault, name)
            .map_err(|error| error.to_string())
    }

    async fn freeze(&mut self, vault: &VaultId) -> Result<(), String> {
        let shared = self.spawned().shared();
        let now = shared.now();
        match shared
            .rules(|gateway| gateway.freeze(vault, now))
            .map_err(|fault| fault.to_string())?
        {
            Operated::Done(()) => Ok(()),
            other => Err(format!("freeze: {other:?}")),
        }
    }

    async fn unfreeze(&mut self, vault: &VaultId) -> Result<i64, String> {
        let shared = self.spawned().shared();
        let now = shared.now();
        match shared
            .rules(|gateway| gateway.unfreeze(vault, now))
            .map_err(|fault| fault.to_string())?
        {
            Operated::Done(lasted) => Ok(lasted),
            other => Err(format!("unfreeze: {other:?}")),
        }
    }

    async fn operator_undo(&mut self, vault: &VaultId) -> Result<u64, String> {
        match self
            .spawned()
            .shared()
            .rules(|gateway| gateway.operator_undo(vault))
            .map_err(|fault| fault.to_string())?
        {
            Operated::Done(count) => Ok(count),
            other => Err(format!("undo: {other:?}")),
        }
    }

    async fn token_epochs(&mut self, vault: &VaultId) -> Result<Vec<u64>, String> {
        self.spawned()
            .shared()
            .rules(|gateway| Ok(gateway.state.token_epochs(vault)?))
            .map_err(|fault| fault.to_string())
    }

    async fn revoked_count(&mut self, vault: &VaultId) -> Result<u64, String> {
        self.spawned()
            .shared()
            .rules(|gateway| Ok(gateway.state.revoked_count(vault)?))
            .map_err(|fault| fault.to_string())
    }

    async fn secret_count(&mut self) -> Result<u64, String> {
        self.spawned()
            .shared()
            .rules(|gateway| Ok(gateway.secrets()?.len() as u64))
            .map_err(|fault| fault.to_string())
    }

    async fn nonce_rows(&mut self) -> Result<Vec<Vec<u8>>, String> {
        self.spawned()
            .shared()
            .rules(|gateway| Ok(gateway.state.nonce_rows()?))
            .map_err(|fault| fault.to_string())
    }

    async fn at_rest(&mut self) -> Result<Vec<u8>, String> {
        Ok(every_byte(self.spawned().data_dir()))
    }

    async fn info(&mut self) -> Result<Info, Failure> {
        self.stranger().info().await.map_err(failure)
    }

    async fn pair(&mut self, request: &PairRequest) -> Result<Paired, Failure> {
        self.stranger().pair(request).await.map_err(failure)
    }

    async fn head(&mut self, token: &Token, vault: &VaultId) -> Result<HeadView, Failure> {
        self.phone(token).head(vault).await.map_err(failure)
    }

    async fn set_head(
        &mut self,
        token: &Token,
        vault: &VaultId,
        request: &SetHead,
    ) -> Result<HeadView, Failure> {
        self.phone(token)
            .set_head(vault, request)
            .await
            .map_err(failure)
    }

    async fn snapshots(
        &mut self,
        token: &Token,
        vault: &VaultId,
        after: Option<&Name>,
        limit: usize,
    ) -> Result<Vec<SnapshotView>, Failure> {
        self.phone(token)
            .snapshots(vault, after, limit)
            .await
            .map_err(failure)
    }

    async fn held(
        &mut self,
        token: &Token,
        vault: &VaultId,
        after: Option<&Name>,
        limit: usize,
    ) -> Result<Vec<HeldEntry>, Failure> {
        self.phone(token)
            .held(vault, after, limit)
            .await
            .map_err(failure)
    }

    async fn nonce(&mut self) -> Result<NonceAnswer, Failure> {
        self.stranger().nonce().await.map_err(failure)
    }

    async fn exists(
        &mut self,
        token: &Token,
        vault: &VaultId,
        names: &[Name],
    ) -> Result<Vec<Name>, Failure> {
        self.phone(token)
            .exists(vault, names)
            .await
            .map_err(failure)
    }

    async fn put(
        &mut self,
        token: &Token,
        vault: &VaultId,
        name: &Name,
        digest: &Digest,
        bytes: &[u8],
    ) -> Result<PutAnswer, Failure> {
        // The client counts NAME_TAKEN as an acknowledgement; the suite
        // judges the protocol, where it is a 409 refusal carrying the held
        // digest, so it is turned back into one here.
        match self
            .phone(token)
            .put(vault, name, digest, bytes.to_vec())
            .await
            .map_err(failure)?
        {
            Put::Stored(entry) => Ok(PutAnswer::Stored(entry)),
            Put::AlreadyStored(entry) => Ok(PutAnswer::AlreadyStored(entry)),
            Put::NameTaken { held } => Err(Failure::Refused(Refusal::NameTaken { digest: held })),
        }
    }

    async fn get(
        &mut self,
        token: &Token,
        vault: &VaultId,
        name: &Name,
        range: Option<ByteRange>,
    ) -> Result<Vec<u8>, Failure> {
        self.phone(token)
            .get(vault, name, range)
            .await
            .map_err(failure)
    }

    async fn stat(
        &mut self,
        token: &Token,
        vault: &VaultId,
        name: &Name,
    ) -> Result<(u64, Digest), Failure> {
        let stat = self.phone(token).stat(vault, name).await.map_err(failure)?;
        Ok((stat.size, stat.digest))
    }

    async fn bundle(
        &mut self,
        token: &Token,
        vault: &VaultId,
        frames: &[Frame],
    ) -> Result<BundleAnswer, Failure> {
        self.phone(token)
            .bundle(vault, frames)
            .await
            .map_err(failure)
    }

    async fn fetch(
        &mut self,
        token: &Token,
        vault: &VaultId,
        names: &[Name],
    ) -> Result<Vec<Frame>, Failure> {
        self.phone(token).fetch(vault, names).await.map_err(failure)
    }

    async fn objects(
        &mut self,
        token: &Token,
        vault: &VaultId,
        after: Option<&Name>,
        limit: usize,
    ) -> Result<Vec<ObjectEntry>, Failure> {
        self.phone(token)
            .objects(vault, after, limit)
            .await
            .map_err(failure)
    }

    async fn delete(
        &mut self,
        token: &Token,
        vault: &VaultId,
        request: &DeleteRequest,
    ) -> Result<DeleteAnswer, Failure> {
        self.phone(token)
            .delete(vault, request)
            .await
            .map_err(failure)
    }

    async fn undo(
        &mut self,
        token: &Token,
        vault: &VaultId,
        request: &UndoRequest,
    ) -> Result<Undone, Failure> {
        self.phone(token)
            .undo(vault, request)
            .await
            .map_err(failure)
    }

    async fn revoke(&mut self, token: &Token, vault: &VaultId) -> Result<(), Failure> {
        let revoked = self.phone(token).revoke(vault).await.map_err(failure)?;
        if revoked.revoked {
            Ok(())
        } else {
            Err(Failure::Broken(
                "the gateway answered revoked: false".to_owned(),
            ))
        }
    }
}

/// Every case, over the wire, named; a failure prints which.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_real_gateway_passes_every_case_through_the_real_client() {
    let mut target = WireTarget {
        root: tempfile::tempdir().expect("a temp dir"),
        generation: 0,
        spawned: None,
    };
    let report = conformance::run(&mut target).await;
    print!("{}", report.render());
    let names: Vec<&str> = report.cases.iter().map(|case| case.name).collect();
    assert_eq!(names, CASES, "the report must name every case, in order");
    assert!(report.is_green(), "\n{}", report.render());
}

/// One of tests.md's attacker tests, by its name: the case it names, over a
/// fresh real gateway through the real client.
async fn named(test: &str) {
    let case = conformance::NAMED
        .iter()
        .find(|(name, _)| *name == test)
        .unwrap_or_else(|| panic!("{test} is not in NAMED"))
        .1;
    let mut target = WireTarget {
        root: tempfile::tempdir().expect("a temp dir"),
        generation: 0,
        spawned: None,
    };
    let found = conformance::run_one(&mut target, case)
        .await
        .unwrap_or_else(|| panic!("{case} is not a case"));
    assert!(found.passed, "{test} ({case}): {}", found.detail);
}

macro_rules! named_over_the_wire {
    ($($name:ident),+ $(,)?) => {$(
        #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
        async fn $name() {
            named(stringify!($name)).await;
        }
    )+};
}

named_over_the_wire!(
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
    the_extremes_of_every_number_are_refused_without_a_fault,
    a_claim_or_read_grant_for_another_gateway_or_vault_moves_nothing,
);

/// Every name in `NAMED` has a test above.
#[test]
fn every_named_test_is_here() {
    let source = include_str!("conformance_wire.rs");
    for (name, _) in conformance::NAMED {
        assert!(
            source.contains(&format!("    {name},")),
            "{name} has no test over the wire"
        );
    }
}
